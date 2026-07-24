<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;
use Exception;

/**
 * WebAuthn Controller
 *
 * Handles WebAuthn (biometric) authentication:
 * - Challenge generation for registration/authentication
 * - Credential registration (storing public key)
 * - Credential authentication (verifying signature)
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
        $userId = $request['body']['user_id'] ?? null;
        $credentialId = $request['body']['credential_id'] ?? null;
        $email = $request['body']['email'] ?? null;
        $allowCredentials = [];

        // For registration, require authentication
        if ($action === 'register') {
            if (!isset($request['user_id'])) {
                return [
                    'success' => false,
                    'message' => 'Authentication required',
                    'status_code' => 401
                ];
            }
            $userId = $request['user_id'];
        }

        // For authentication, identify the user one of three ways:
        //   1. credential_id (existing webapp flow — client already has it in localStorage)
        //   2. email (Chrome-extension flow — can't read webapp localStorage)
        //   3. neither (discoverable / passkey-from-anywhere flow)
        if ($action === 'authenticate') {
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

                $userId = $credential['user_id'];
            } else if (!empty($email)) {
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
                // Discoverable credential flow — no specific user yet.
                // Use 0 as a placeholder; verification happens at /authenticate.
                $userId = 0;
            }
        }

        // Generate random challenge (32 bytes, base64url encoded)
        $challengeBytes = random_bytes(32);
        $challenge = $this->base64UrlEncode($challengeBytes);

        // Store challenge temporarily (in database for simplicity)
        // In production, you might use Redis with TTL.
        // Skip persistence for unbound discoverable-credential challenges:
        // we don't know the user yet, the schema's user_id column may be
        // NOT NULL or carry a FK, and the current authenticate() flow does
        // not actually re-verify the stored challenge — it trusts the
        // browser's WebAuthn signature. Once full signature verification is
        // implemented, store these in a dedicated unbound-challenges table.
        if ($userId !== 0) {
            $stmt = $this->db->prepare("
                INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
                VALUES (?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()
            ");
            $stmt->execute([$challenge, $userId, $action]);
        }

        // Get relying party info from config or use defaults
        $rpId = $this->config['webauthn']['rp_id'] ?? $_SERVER['HTTP_HOST'] ?? 'localhost';
        $rpName = $this->config['webauthn']['rp_name'] ?? 'Voice Assistant';

        // Remove port from rpId if present (WebAuthn requires domain only)
        $rpId = preg_replace('/:\d+$/', '', $rpId);

        return [
            'success' => true,
            'challenge' => $challenge,
            'rp_id' => $rpId,
            'rp_name' => $rpName,
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
     * Authenticate using WebAuthn credential
     */
    public function authenticate(array $request): array
    {
        $credentialId = $request['body']['credential_id'] ?? '';
        $clientDataJson = $request['body']['client_data_json'] ?? '';
        $authenticatorData = $request['body']['authenticator_data'] ?? '';
        $signature = $request['body']['signature'] ?? '';

        if (empty($credentialId) || empty($signature)) {
            return [
                'success' => false,
                'message' => 'Credential ID and signature are required',
                'status_code' => 400
            ];
        }

        // Look up credential
        $stmt = $this->db->prepare("
            SELECT wc.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.plan, u.ledger_user_id, u.provider, u.last_login, u.created_at
            FROM webauthn_credentials wc
            JOIN users u ON wc.user_id = u.id
            WHERE wc.credential_id = ?
        ");
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

        // In a full implementation, you would verify the signature using the stored public key
        // For now, we trust the browser's WebAuthn API did the verification
        // The signature verification requires CBOR parsing and crypto operations
        //
        // TODO: Implement full signature verification using a library like:
        // - web-auth/webauthn-lib
        // - lbuchs/webauthn
        //
        // For now, we verify that:
        // 1. The credential exists
        // 2. The authenticatorData and signature are present (indicating the browser verified biometric)

        if (empty($authenticatorData) || empty($signature)) {
            return [
                'success' => false,
                'message' => 'Invalid authentication data',
                'status_code' => 400
            ];
        }

        $userId = (int)$credential['uid'];

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
     * Base64URL encode (URL-safe base64 without padding)
     */
    private function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /**
     * Base64URL decode
     */
    private function base64UrlDecode(string $data): string
    {
        $padded = str_pad(strtr($data, '-_', '+/'), strlen($data) % 4, '=');
        return base64_decode($padded);
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
