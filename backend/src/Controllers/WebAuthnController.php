<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;
use Quantis\AIPortfolioAssistant\Services\Edition;

/**
 * WebAuthn Controller
 *
 * Handles WebAuthn (biometric) authentication:
 * - Challenge generation for registration/authentication
 * - Credential registration (storing public key)
 * - Credential authentication: off until assertions are verified
 * - Credential removal
 */
class WebAuthnController
{
    private PDO $db;
    private array $config;

    // Challenge expiry in seconds
    private const CHALLENGE_EXPIRY = 120;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Generate a challenge for WebAuthn registration or authentication
     */
    public function challenge(array $request): array
    {
        $action = $request['body']['action'] ?? '';

        // Passkey sign-in is off until assertions are verified (see authenticate()).
        if ($action !== 'register') {
            return $this->passkeySignInOff();
        }

        // Registration requires a signed-in user
        if (!isset($request['user_id'])) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }
        $userId = $request['user_id'];

        // Generate random challenge (32 bytes, base64url encoded)
        $challengeBytes = random_bytes(32);
        $challenge = $this->base64UrlEncode($challengeBytes);

        // Store challenge temporarily (in database for simplicity)
        // In production, you might use Redis with TTL.
        $stmt = $this->db->prepare("
            INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()
        ");
        $stmt->execute([$challenge, $userId, $action]);

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
            'allow_credentials' => [],
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
        if ($refused = Edition::refuseLocalSignIn($this->config)) {
            return $refused;
        }

        return $this->passkeySignInOff();
    }

    /**
     * Sign-in with a passkey stays off until authenticate() verifies the
     * assertion: the stored single-use challenge, origin, rpId hash, the
     * signature against the stored public key, and the sign counter. Without
     * that, a credential id alone (handed out by challenge() for any email)
     * signed anyone in. Registering and deleting passkeys still work.
     */
    private function passkeySignInOff(): array
    {
        return [
            'success' => false,
            'message' => 'Passkey sign-in is turned off for now. Sign in with your email and password.',
            'code' => 'PASSKEY_SIGNIN_OFF',
            'status_code' => 503
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
