<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Firebase\JWT\JWT;
use PDO;
use Exception;
use Quantis\AIPortfolioAssistant\Services\Edition;

/**
 * WebAuthn Controller
 *
 * Handles WebAuthn (biometric) authentication:
 * - Challenge generation for registration/authentication
 * - Credential registration (storing public key)
 * - Credential authentication (verifying the assertion signature)
 * - Credential removal
 */
class WebAuthnController
{
    private PDO $db;
    private array $config;
    private string $jwtSecret;
    private int $jwtExpiry;
    private int $refreshExpiry;

    // Challenge expiry in seconds
    private const CHALLENGE_EXPIRY = 120;

    // authenticatorData flags: user present, user verified
    private const FLAG_UP = 0x01;
    private const FLAG_UV = 0x04;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->jwtSecret = (string) ($config['auth']['jwt_secret'] ?? '');
        if ($this->jwtSecret === '') {
            // Fail closed: never sign/verify with a weak default secret.
            throw new \RuntimeException('JWT secret is not configured (set JWT_SECRET).');
        }
        $this->jwtExpiry = $config['auth']['jwt_expiry'] ?? 28800; // 8 hours
        $this->refreshExpiry = $config['auth']['refresh_expiry'] ?? 604800; // 7 days
    }

    /**
     * Generate a challenge for WebAuthn registration or authentication
     */
    public function challenge(array $request): array
    {
        $action = $request['body']['action'] ?? '';
        $credentialId = $request['body']['credential_id'] ?? null;
        $email = $request['body']['email'] ?? null;
        $allowCredentials = [];

        if ($action === 'register') {
            // Registration requires a signed-in user
            if (!isset($request['user_id'])) {
                return [
                    'success' => false,
                    'message' => 'Authentication required',
                    'status_code' => 401
                ];
            }
            $userId = $request['user_id'];
        } elseif ($action === 'authenticate') {
            // Identify the user one of two ways:
            //   1. credential_id (webapp flow — client already has it in localStorage)
            //   2. email (Chrome-extension flow — can't read webapp localStorage)
            // Credential ids are not secrets: authenticate() verifies the signature.
            if (!empty($credentialId)) {
                $stmt = $this->db->prepare("SELECT user_id FROM webauthn_credentials WHERE credential_id = ?");
                $stmt->execute([$credentialId]);
                $credential = $stmt->fetch();

                if (!$credential) {
                    return [
                        'success' => false,
                        'message' => 'Credential not found',
                        'code' => 'CREDENTIAL_NOT_FOUND',
                        'status_code' => 404
                    ];
                }

                $userId = (int)$credential['user_id'];
            } elseif (!empty($email)) {
                $stmt = $this->db->prepare("SELECT id FROM users WHERE email = ?");
                $stmt->execute([$email]);
                $user = $stmt->fetch();
                if (!$user) {
                    return [
                        'success' => false,
                        'message' => 'No account found for this email',
                        'code' => 'USER_NOT_FOUND',
                        'status_code' => 404
                    ];
                }
                $userId = (int)$user['id'];

                $stmt = $this->db->prepare("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?");
                $stmt->execute([$userId]);
                $rows = $stmt->fetchAll();
                if (empty($rows)) {
                    return [
                        'success' => false,
                        'message' => 'No passkey registered for this account. Sign in with email/password and enable biometric login first.',
                        'code' => 'NO_CREDENTIALS',
                        'status_code' => 404
                    ];
                }
                $allowCredentials = array_map(fn($row) => [
                    'id' => $row['credential_id'],
                    'type' => 'public-key',
                    'transports' => ['internal']
                ], $rows);
            } else {
                // Discoverable (no id, no email) sign-in would need a challenge
                // bound to no user, which webauthn_challenges cannot hold.
                return [
                    'success' => false,
                    'message' => 'Enter your email to sign in with a passkey.',
                    'code' => 'EMAIL_REQUIRED',
                    'status_code' => 400
                ];
            }
        } else {
            return [
                'success' => false,
                'message' => 'Unknown action',
                'status_code' => 400
            ];
        }

        // Generate random challenge (32 bytes, base64url encoded)
        $challengeBytes = random_bytes(32);
        $challenge = $this->base64UrlEncode($challengeBytes);

        // Store challenge temporarily; authenticate() consumes it once.
        $stmt = $this->db->prepare("
            INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
            VALUES (?, ?, ?, NOW())
        ");
        $stmt->execute([$challenge, $userId, $action]);

        return [
            'success' => true,
            'challenge' => $challenge,
            'rp_id' => $this->rpId(),
            'rp_name' => $this->config['webauthn']['rp_name'] ?? 'Voice Assistant',
            'allow_credentials' => $allowCredentials,
            'status_code' => 200
        ];
    }

    /**
     * Register a new WebAuthn credential
     */
    public function register(array $request): array
    {
        // Require authentication
        $userId = $request['user_id'] ?? null;
        if (!$userId) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }

        $credentialId = $request['body']['credential_id'] ?? '';
        $publicKey = $request['body']['public_key'] ?? '';
        $clientDataJson = $request['body']['client_data_json'] ?? '';
        $attestationObject = $request['body']['attestation_object'] ?? '';

        if (empty($credentialId) || empty($publicKey)) {
            return [
                'success' => false,
                'message' => 'Credential ID and public key are required',
                'status_code' => 400
            ];
        }

        // Verify challenge was issued for this user (optional but recommended)
        // For simplicity, we'll skip full attestation verification
        // In production, you should verify the attestation object

        // Check if credential already exists
        $stmt = $this->db->prepare("SELECT id FROM webauthn_credentials WHERE credential_id = ?");
        $stmt->execute([$credentialId]);
        if ($stmt->fetch()) {
            return [
                'success' => false,
                'message' => 'Credential already registered',
                'status_code' => 409
            ];
        }

        // Store credential
        $stmt = $this->db->prepare("
            INSERT INTO webauthn_credentials (user_id, credential_id, public_key, created_at)
            VALUES (?, ?, ?, NOW())
        ");
        $stmt->execute([$userId, $credentialId, $publicKey]);

        error_log("[WebAuthnController] Credential registered: user_id=$userId, credential_id=" . substr($credentialId, 0, 20) . "...");

        // Clean up old challenges
        $this->cleanupChallenges();

        return [
            'success' => true,
            'message' => 'Credential registered successfully',
            'status_code' => 200
        ];
    }

    /**
     * Authenticate using WebAuthn credential: verify the assertion (single-use
     * challenge, origin, rpId hash, user verification, signature against the
     * stored public key) before issuing a token.
     */
    public function authenticate(array $request): array
    {
        if ($refused = Edition::refuseLocalSignIn($this->config)) {
            return $refused;
        }

        $credentialId = $request['body']['credential_id'] ?? '';
        $clientDataJson = $request['body']['client_data_json'] ?? '';
        $authenticatorData = $request['body']['authenticator_data'] ?? '';
        $signature = $request['body']['signature'] ?? '';

        if (!is_string($credentialId) || !is_string($clientDataJson) || !is_string($authenticatorData) || !is_string($signature)
            || $credentialId === '' || $clientDataJson === '' || $authenticatorData === '' || $signature === '') {
            return [
                'success' => false,
                'message' => 'Credential ID, client data, authenticator data and signature are required',
                'status_code' => 400
            ];
        }

        // Look up credential
        $stmt = $this->db->prepare("
            SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.kind, u.role, u.plan, u.ledger_user_id, u.provider, u.last_login, u.created_at
            FROM webauthn_credentials wc
            JOIN users u ON wc.user_id = u.id
            WHERE wc.credential_id = ?
        ");
        $stmt->execute([$credentialId]);
        $credential = $stmt->fetch(PDO::FETCH_ASSOC);

        // The robot is a service row: answer as for an unknown credential.
        if ($credential && ($credential['kind'] ?? 'person') === 'service') {
            $credential = false;
        }

        if (!$credential) {
            return [
                'success' => false,
                'message' => 'Credential not found',
                'code' => 'CREDENTIAL_NOT_FOUND',
                'status_code' => 404
            ];
        }

        $userId = (int)$credential['uid'];

        $failure = $this->verifyAssertion(
            $userId,
            (string)($credential['public_key'] ?? ''),
            $this->base64UrlDecode($clientDataJson),
            $this->base64UrlDecode($authenticatorData),
            $this->base64UrlDecode($signature)
        );
        if ($failure !== null) {
            error_log("[WebAuthnController] Passkey sign-in refused: user_id=$userId, reason=$failure");
            return [
                'success' => false,
                'message' => 'Passkey sign-in failed',
                'status_code' => 401
            ];
        }

        // Generate JWT tokens
        $tokens = $this->generateTokens($userId);

        // Update last login
        $stmt = $this->db->prepare("UPDATE users SET last_login = NOW() WHERE id = ?");
        $stmt->execute([$userId]);

        error_log("[WebAuthnController] Biometric auth successful: user_id=$userId");

        // Clean up old challenges
        $this->cleanupChallenges();

        return [
            'success' => true,
            'message' => 'Authentication successful',
            'token' => $tokens['access_token'],
            'user' => [
                'id' => (string)$userId,
                'email' => $credential['email'],
                'first_name' => $credential['first_name'],
                'last_name' => $credential['last_name'],
                'role' => $credential['role'] ?? 'prospect',
                'plan' => $credential['plan'] ?? 'free',
                'provider' => $credential['provider'] ?? 'webauthn',
                'last_login' => date('Y-m-d H:i:s'),
                'created_at' => $credential['created_at'] ?? null,
            ],
            'status_code' => 200
        ];
    }

    /**
     * Verify a WebAuthn assertion. Returns null when it holds, else the reason
     * (for the log only; the client gets one generic answer).
     */
    private function verifyAssertion(int $userId, string $publicKey, string|false $clientData, string|false $authData, string|false $signature): ?string
    {
        if ($clientData === false || $authData === false || $signature === false) {
            return 'undecodable base64url';
        }

        $client = json_decode($clientData, true);
        if (!is_array($client) || !is_string($client['challenge'] ?? null)) {
            return 'bad clientDataJSON';
        }

        // The challenge is single use: consume it before any other check.
        if (!$this->consumeChallenge($client['challenge'], $userId)) {
            return 'unknown, expired or reused challenge';
        }

        if (($client['type'] ?? null) !== 'webauthn.get') {
            return 'clientDataJSON type is not webauthn.get';
        }

        $rpId = $this->rpId();
        if (!$this->originAllowed((string)($client['origin'] ?? ''), $rpId)) {
            return 'origin not allowed';
        }

        // authenticatorData = rpIdHash (32) | flags (1) | signCount (4) | ...
        if (strlen($authData) < 37) {
            return 'authenticatorData too short';
        }
        if (!hash_equals(hash('sha256', $rpId, true), substr($authData, 0, 32))) {
            return 'rpIdHash mismatch';
        }
        $flags = ord($authData[32]);
        if (($flags & self::FLAG_UP) === 0 || ($flags & self::FLAG_UV) === 0) {
            return 'user presence or verification flag missing';
        }

        $der = $this->base64UrlDecode($publicKey);
        $key = $der === false ? false : openssl_pkey_get_public(
            "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n"
        );
        if ($key === false) {
            return 'stored public key unreadable';
        }

        $signed = $authData . hash('sha256', $clientData, true);
        if (openssl_verify($signed, $signature, $key, OPENSSL_ALGO_SHA256) !== 1) {
            return 'bad signature';
        }

        return null;
    }

    /**
     * Delete the challenge and tell whether it was a live sign-in challenge
     * issued for this user. Deleted whatever the answer, so it is single use.
     */
    private function consumeChallenge(string $challenge, int $userId): bool
    {
        $stmt = $this->db->prepare("
            SELECT user_id, action, UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at) AS age
            FROM webauthn_challenges WHERE challenge = ?
        ");
        $stmt->execute([$challenge]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return false;
        }

        $stmt = $this->db->prepare("DELETE FROM webauthn_challenges WHERE challenge = ?");
        $stmt->execute([$challenge]);
        if ($stmt->rowCount() !== 1) {
            return false; // a concurrent request consumed it first
        }

        return (int)$row['user_id'] === $userId
            && $row['action'] === 'authenticate'
            && (int)$row['age'] >= 0
            && (int)$row['age'] <= self::CHALLENGE_EXPIRY;
    }

    /**
     * Relying party id: config webauthn.rp_id, else the request host without port.
     */
    private function rpId(): string
    {
        $rpId = $this->config['webauthn']['rp_id'] ?? $_SERVER['HTTP_HOST'] ?? 'localhost';

        // Remove port from rpId if present (WebAuthn requires domain only)
        return (string)preg_replace('/:\d+$/', '', (string)$rpId);
    }

    /**
     * The assertion origin must be one of config webauthn.origins when set;
     * otherwise its host must be the rp id, over https (http only on localhost,
     * as browsers allow). Any port.
     */
    private function originAllowed(string $origin, string $rpId): bool
    {
        $origins = $this->config['webauthn']['origins'] ?? null;
        if (is_string($origins) && trim($origins) !== '') {
            $origins = array_map('trim', explode(',', $origins));
        }
        if (is_array($origins) && $origins !== []) {
            return in_array(rtrim($origin, '/'), array_map(fn($o) => rtrim((string)$o, '/'), $origins), true);
        }

        // An origin is exactly scheme://host[:port]
        $parts = parse_url($origin);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])
            || $origin !== $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '')) {
            return false;
        }
        if (strtolower($parts['host']) !== strtolower($rpId)) {
            return false;
        }
        return $parts['scheme'] === 'https'
            || ($parts['scheme'] === 'http' && in_array($rpId, ['localhost', '127.0.0.1'], true));
    }

    /**
     * Generate JWT access and refresh tokens
     */
    private function generateTokens(int $userId): array
    {
        $now = time();

        // Access token
        $accessPayload = [
            'iss' => 'gpt-chat',
            'iat' => $now,
            'exp' => $now + $this->jwtExpiry,
            'sub' => $userId,
            'type' => 'access'
        ];

        // Refresh token
        $refreshPayload = [
            'iss' => 'gpt-chat',
            'iat' => $now,
            'exp' => $now + $this->refreshExpiry,
            'sub' => $userId,
            'type' => 'refresh'
        ];

        return [
            'access_token' => JWT::encode($accessPayload, $this->jwtSecret, 'HS256'),
            'refresh_token' => JWT::encode($refreshPayload, $this->jwtSecret, 'HS256')
        ];
    }

    /**
     * Delete a WebAuthn credential
     */
    public function delete(array $request): array
    {
        // Require authentication
        $userId = $request['user_id'] ?? null;
        if (!$userId) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }

        $credentialId = $request['body']['credential_id'] ?? '';

        if (empty($credentialId)) {
            return [
                'success' => false,
                'message' => 'Credential ID is required',
                'status_code' => 400
            ];
        }

        // Delete credential (only if it belongs to the authenticated user)
        $stmt = $this->db->prepare("DELETE FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?");
        $stmt->execute([$credentialId, $userId]);

        $deleted = $stmt->rowCount() > 0;

        error_log("[WebAuthnController] Credential deleted: user_id=$userId, credential_id=" . substr($credentialId, 0, 20) . "..., success=" . ($deleted ? 'true' : 'false'));

        return [
            'success' => true,
            'message' => $deleted ? 'Credential deleted' : 'Credential not found or not owned by user',
            'status_code' => 200
        ];
    }

    /**
     * Base64URL encode (URL-safe base64 without padding)
     */
    private function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /**
     * Base64URL decode (false when not valid base64url)
     */
    private function base64UrlDecode(string $data): string|false
    {
        $b64 = strtr($data, '-_', '+/');
        $padded = str_pad($b64, strlen($b64) + (4 - strlen($b64) % 4) % 4, '=');
        return base64_decode($padded, true);
    }

    /**
     * Clean up expired challenges
     */
    private function cleanupChallenges(): void
    {
        try {
            $stmt = $this->db->prepare("DELETE FROM webauthn_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)");
            $stmt->execute([self::CHALLENGE_EXPIRY]);
        } catch (Exception $e) {
            // Ignore cleanup errors
            error_log("[WebAuthnController] Challenge cleanup failed: " . $e->getMessage());
        }
    }
}
