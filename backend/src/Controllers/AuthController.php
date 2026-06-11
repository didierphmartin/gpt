<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PDO;
use Exception;

/**
 * Authentication Controller
 *
 * Handles user authentication including:
 * - Email/password login
 * - User registration
 * - Firebase social authentication
 * - JWT token verification
 * - Logout
 */
class AuthController
{
    private PDO $db;
    private array $config;
    private string $jwtSecret;
    private int $jwtExpiry;
    private int $refreshExpiry;

    // Free trial token quota (lifetime total across all providers)
    private const FREE_TRIAL_TOKEN_QUOTA = 50000;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->jwtSecret = $config['auth']['jwt_secret'] ?? 'your-secret-key-change-this-in-production';
        $this->jwtExpiry = $config['auth']['jwt_expiry'] ?? 28800; // 8 hours
        $this->refreshExpiry = $config['auth']['refresh_expiry'] ?? 604800; // 7 days
        $this->ensureUserSubscriptionColumns();
    }

    /**
     * Ensure users table has ledger_user_id and plan columns
     */
    private function ensureUserSubscriptionColumns(): void
    {
        try {
            $stmt = $this->db->query("SHOW COLUMNS FROM users LIKE 'ledger_user_id'");
            if ($stmt->rowCount() === 0) {
                $this->db->exec("ALTER TABLE users ADD COLUMN ledger_user_id VARCHAR(36) DEFAULT NULL AFTER role");
                $this->db->exec("ALTER TABLE users ADD COLUMN plan VARCHAR(20) DEFAULT 'free' AFTER ledger_user_id");
                $this->db->exec("ALTER TABLE users ADD INDEX idx_ledger_user_id (ledger_user_id)");
            }
            // Per-user app key: HMAC hash (never plaintext) + a short prefix
            // for last-4 display in settings, + the creation timestamp.
            $stmt = $this->db->query("SHOW COLUMNS FROM users LIKE 'app_key_hash'");
            if ($stmt->rowCount() === 0) {
                $this->db->exec("ALTER TABLE users ADD COLUMN app_key_hash CHAR(64) DEFAULT NULL");
                $this->db->exec("ALTER TABLE users ADD COLUMN app_key_prefix CHAR(12) DEFAULT NULL");
                $this->db->exec("ALTER TABLE users ADD COLUMN app_key_created_at TIMESTAMP NULL DEFAULT NULL");
                $this->db->exec("ALTER TABLE users ADD INDEX idx_app_key_hash (app_key_hash)");
            }
        } catch (Exception $e) {
            error_log("[AuthController] Error ensuring subscription columns: " . $e->getMessage());
        }
    }

    /**
     * Canonical plan id from any funnel ('synergy_standard', 'portfolio_premium',
     * 'standard', …) → one of free/standard/premium. Unknown → 'free'.
     * The landing pages send app-prefixed ids; without this they were silently
     * downgraded to 'free' by the old whitelist check.
     */
    private function normalizePlan(?string $plan): string
    {
        $p = strtolower(trim((string)$plan));
        if (($pos = strpos($p, '_')) !== false) {
            $p = substr($p, $pos + 1); // drop an app prefix like "synergy_"
        }
        return in_array($p, ['standard', 'premium'], true) ? $p : 'free';
    }

    /**
     * Capability role for a plan: paying customers are 'user', free-trial users
     * are 'prospect'. Roles (not plans) drive PackageResolver, so a paid user
     * left as 'prospect' only gets free-tier access.
     */
    private function roleForPlan(string $plan): string
    {
        return $plan === 'free' ? 'prospect' : 'user';
    }

    /** Plan ordering so re-auth can upgrade but never downgrade. */
    private function planRank(?string $plan): int
    {
        return ['free' => 0, 'standard' => 1, 'premium' => 2][$this->normalizePlan($plan)] ?? 0;
    }

    /**
     * HMAC pepper for user app keys. Derived from jwt_secret if no explicit
     * `auth.user_app_key_secret` is set — keeps the feature working without
     * extra config while remaining cryptographically distinct from the JWT
     * signing key. Set the explicit value in production.
     */
    private function appKeyPepper(): string
    {
        $explicit = (string) ($this->config['auth']['user_app_key_secret'] ?? '');
        return $explicit !== '' ? $explicit : hash_hmac('sha256', 'user_app_key.v1', $this->jwtSecret);
    }

    private function hashAppKey(string $key): string
    {
        return hash_hmac('sha256', $key, $this->appKeyPepper());
    }

    /** @return array{key:string,prefix:string,hash:string} */
    private function generateAppKeyMaterial(): array
    {
        $rand   = bin2hex(random_bytes(16));     // 32 hex chars = 128 bits of entropy
        $key    = 'uak_' . $rand;
        $prefix = substr($key, 0, 12);            // 'uak_' + 8 hex chars, safe to display
        return ['key' => $key, 'prefix' => $prefix, 'hash' => $this->hashAppKey($key)];
    }

    /**
     * Handle legacy action-based auth routing
     * Maps action field to appropriate method for backward compatibility
     */
    public function handleAction(array $request): array
    {
        $action = $request['body']['action'] ?? '';

        return match ($action) {
            'login' => $this->login($request),
            'register' => $this->register($request),
            'firebase' => $this->firebaseAuth($request),
            'verify' => $this->verify($request),
            'logout' => $this->logout($request),
            'link_phone' => $this->linkPhone($request),
            'unlink_phone' => $this->unlinkPhone($request),
            'upgrade_plan' => $this->upgradePlan($request),
            'generate_app_key' => $this->generateAppKey($request),
            'revoke_app_key' => $this->revokeAppKey($request),
            'admin_generate_app_key' => $this->adminGenerateAppKeyForUser($request),
            'admin_revoke_app_key' => $this->adminRevokeAppKeyForUser($request),
            default => [
                'success' => false,
                'message' => 'Invalid action',
                'status_code' => 400
            ]
        };
    }

    /**
     * Handle email/password login
     */
    public function login(array $request): array
    {
        $email = $request['body']['email'] ?? '';
        $password = $request['body']['password'] ?? '';

        if (empty($email) || empty($password)) {
            return [
                'success' => false,
                'message' => 'Email and password are required',
                'status_code' => 400
            ];
        }

        // Find user by email
        $stmt = $this->db->prepare("SELECT * FROM users WHERE email = ?");
        $stmt->execute([strtolower(trim($email))]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password'])) {
            return [
                'success' => false,
                'message' => 'Invalid email or password',
                'status_code' => 401
            ];
        }

        // Generate tokens
        $tokens = $this->generateTokens((int)$user['id']);

        // Update last login
        $stmt = $this->db->prepare("UPDATE users SET last_login = NOW() WHERE id = ?");
        $stmt->execute([$user['id']]);

        return [
            'success' => true,
            'message' => 'Login successful',
            'data' => [
                'user' => [
                    'id' => (int)$user['id'],
                    'email' => $user['email'],
                    'first_name' => $user['first_name'],
                    'last_name' => $user['last_name'],
                    'role' => $user['role'] ?? 'prospect',
                    'plan' => $user['plan'] ?? 'free',
                    'provider' => $user['provider'] ?? 'email',
                    'last_login' => date('Y-m-d H:i:s'),
                    'created_at' => $user['created_at'] ?? null,
                    'app_key_prefix' => $user['app_key_prefix'] ?? null,
                    'app_key_created_at' => $user['app_key_created_at'] ?? null
                ],
                'access_token' => $tokens['access_token'],
                'refresh_token' => $tokens['refresh_token'],
                'expires_in' => $this->jwtExpiry
            ],
            'status_code' => 200
        ];
    }

    /**
     * Handle user registration
     */
    public function register(array $request): array
    {
        $email = strtolower(trim($request['body']['email'] ?? ''));
        $password = $request['body']['password'] ?? '';
        $firstName = trim($request['body']['first_name'] ?? '');
        $lastName = trim($request['body']['last_name'] ?? '');
        $ledgerUserId = trim($request['body']['ledger_user_id'] ?? '');
        $plan = trim($request['body']['plan'] ?? 'free');

        // Validation
        if (empty($email) || empty($password)) {
            return [
                'success' => false,
                'message' => 'Email and password are required',
                'status_code' => 400
            ];
        }

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return [
                'success' => false,
                'message' => 'Invalid email format',
                'status_code' => 400
            ];
        }

        // Require ledger_user_id (proof of going through official registration funnel)
        if (empty($ledgerUserId)) {
            return [
                'success' => false,
                'message' => 'Registration requires a valid subscription. Please register through synergyaichat.com',
                'code' => 'LEDGER_ACCOUNT_REQUIRED',
                'status_code' => 400
            ];
        }

        // Normalize the plan (funnels send ids like 'synergy_standard') and
        // derive the capability role from it (free => prospect, paid => user).
        $plan = $this->normalizePlan($plan);
        $role = $this->roleForPlan($plan);

        // Check if email exists
        $stmt = $this->db->prepare("SELECT id FROM users WHERE email = ?");
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            return [
                'success' => false,
                'message' => 'Email already registered',
                'status_code' => 409
            ];
        }

        // Hash password
        $hashedPassword = password_hash($password, PASSWORD_BCRYPT);

        // Insert user with ledger_user_id and plan
        $stmt = $this->db->prepare("
            INSERT INTO users (email, password, first_name, last_name, role, ledger_user_id, plan, provider, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'email', NOW(), NOW())
        ");
        $stmt->execute([$email, $hashedPassword, $firstName, $lastName, $role, $ledgerUserId, $plan]);
        $userId = (int)$this->db->lastInsertId();

        // Generate tokens
        $tokens = $this->generateTokens($userId);

        return [
            'success' => true,
            'message' => 'Registration successful',
            'data' => [
                'user' => [
                    'id' => $userId,
                    'email' => $email,
                    'first_name' => $firstName,
                    'last_name' => $lastName,
                    'role' => $role,
                    'plan' => $plan,
                    'provider' => 'email',
                    'last_login' => date('Y-m-d H:i:s'),
                    'created_at' => date('Y-m-d H:i:s'),
                    'app_key_prefix' => null,
                    'app_key_created_at' => null
                ],
                'access_token' => $tokens['access_token'],
                'refresh_token' => $tokens['refresh_token'],
                'expires_in' => $this->jwtExpiry
            ],
            'status_code' => 200
        ];
    }

    /**
     * Handle Firebase social authentication
     * Supports Google, Facebook, and Phone authentication
     */
    public function firebaseAuth(array $request): array
    {
        $provider = $request['body']['provider'] ?? '';
        $idToken = $request['body']['idToken'] ?? '';
        $userData = $request['body']['userData'] ?? [];

        // For phone auth, email may be empty but phone_number should be present
        $hasEmail = !empty($userData['email']);
        $hasPhone = !empty($userData['phone_number']);

        if (empty($idToken) || (!$hasEmail && !$hasPhone)) {
            return [
                'success' => false,
                'message' => 'Invalid authentication data',
                'status_code' => 400
            ];
        }

        // For phone auth, use phone number as email placeholder if no email
        $email = $hasEmail
            ? strtolower(trim($userData['email']))
            : strtolower(trim($userData['phone_number'])) . '@phone.auth';
        $phoneNumber = $userData['phone_number'] ?? null;
        $firstName = $userData['first_name'] ?? '';
        $lastName = $userData['last_name'] ?? '';
        $firebaseUid = $userData['firebase_uid'] ?? '';

        // Check if user exists by email, phone, or firebase_uid
        $stmt = $this->db->prepare("SELECT * FROM users WHERE email = ? OR firebase_uid = ? OR phone = ?");
        $stmt->execute([$email, $firebaseUid, $phoneNumber]);
        $user = $stmt->fetch();

        // Ledger user ID and plan from registration flow
        $ledgerUserId = trim($userData['ledger_user_id'] ?? $request['body']['ledger_user_id'] ?? '');
        $plan = $this->normalizePlan($userData['plan'] ?? $request['body']['plan'] ?? 'free');
        $role = $this->roleForPlan($plan);

        if ($user) {
            // Update last login and firebase_uid if needed
            $stmt = $this->db->prepare("
                UPDATE users
                SET last_login = NOW(),
                    firebase_uid = COALESCE(firebase_uid, ?),
                    provider = ?,
                    phone = COALESCE(phone, ?)
                WHERE id = ?
            ");
            $stmt->execute([$firebaseUid, $provider, $phoneNumber, $user['id']]);
            $userId = (int)$user['id'];

            // Apply a paid plan presented on re-auth, but only as an UPGRADE:
            // a normal login presents 'free' (must not downgrade), and admins
            // are never touched.
            if ($plan !== 'free'
                && ($user['role'] ?? '') !== 'admin'
                && $this->planRank($plan) > $this->planRank($user['plan'] ?? 'free')) {
                $stmt = $this->db->prepare("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?");
                $stmt->execute([$plan, $role, $userId]);
                $user['plan'] = $plan;
                $user['role'] = $role;
            }
        } else {
            // New user via social auth - require ledger_user_id
            if (empty($ledgerUserId)) {
                return [
                    'success' => false,
                    'message' => 'Registration requires a valid subscription. Please register through synergyaichat.com',
                    'code' => 'LEDGER_ACCOUNT_REQUIRED',
                    'status_code' => 400
                ];
            }

            // Create new user with ledger info
            $stmt = $this->db->prepare("
                INSERT INTO users (email, first_name, last_name, firebase_uid, provider, phone, role, ledger_user_id, plan, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            ");
            $stmt->execute([$email, $firstName, $lastName, $firebaseUid, $provider, $phoneNumber, $role, $ledgerUserId, $plan]);
            $userId = (int)$this->db->lastInsertId();

            // Fetch the newly created user
            $stmt = $this->db->prepare("SELECT * FROM users WHERE id = ?");
            $stmt->execute([$userId]);
            $user = $stmt->fetch();
        }

        // Generate tokens
        $tokens = $this->generateTokens($userId);

        return [
            'success' => true,
            'message' => 'Authentication successful',
            'data' => [
                'user' => [
                    'id' => $userId,
                    'email' => $user['email'],
                    'first_name' => $user['first_name'],
                    'last_name' => $user['last_name'],
                    'role' => $user['role'] ?? 'prospect',
                    'plan' => $user['plan'] ?? 'free',
                    'provider' => $user['provider'] ?? 'firebase',
                    'last_login' => date('Y-m-d H:i:s'),
                    'created_at' => $user['created_at'] ?? null,
                    'app_key_prefix' => $user['app_key_prefix'] ?? null,
                    'app_key_created_at' => $user['app_key_created_at'] ?? null
                ],
                'access_token' => $tokens['access_token'],
                'refresh_token' => $tokens['refresh_token'],
                'expires_in' => $this->jwtExpiry
            ],
            'status_code' => 200
        ];
    }

    /**
     * Verify JWT token
     */
    public function verify(array $request): array
    {
        $authHeader = $request['headers']['Authorization'] ?? $request['headers']['authorization'] ?? '';

        if (!preg_match('/Bearer\s+(.*)$/i', $authHeader, $matches)) {
            return [
                'success' => false,
                'message' => 'Authorization token required',
                'status_code' => 401
            ];
        }

        $token = $matches[1];

        try {
            $decoded = JWT::decode($token, new Key($this->jwtSecret, 'HS256'));

            return [
                'success' => true,
                'message' => 'Token is valid',
                'data' => [
                    'user_id' => $decoded->sub
                ],
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'message' => 'Invalid or expired token',
                'status_code' => 401
            ];
        }
    }

    /**
     * Handle logout
     */
    public function logout(array $request): array
    {
        // For stateless JWT, logout is handled client-side by removing the token
        return [
            'success' => true,
            'message' => 'Logout successful',
            'status_code' => 200
        ];
    }

    /**
     * Link phone number to existing user account
     * Called from desktop after Firebase phone linking
     */
    public function linkPhone(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        $phoneNumber = $request['body']['phone_number'] ?? '';

        if (!$userId) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (empty($phoneNumber)) {
            return [
                'success' => false,
                'message' => 'Phone number is required',
                'status_code' => 400
            ];
        }

        // Check if phone number is already linked to another user
        $stmt = $this->db->prepare("SELECT id FROM users WHERE phone = ? AND id != ?");
        $stmt->execute([$phoneNumber, $userId]);
        if ($stmt->fetch()) {
            return [
                'success' => false,
                'message' => 'Phone number is already linked to another account',
                'status_code' => 409
            ];
        }

        // Save phone number to user's account
        $stmt = $this->db->prepare("UPDATE users SET phone = ?, updated_at = NOW() WHERE id = ?");
        $stmt->execute([$phoneNumber, $userId]);

        error_log("[AuthController] Phone linked: user_id=$userId, phone=$phoneNumber");

        return [
            'success' => true,
            'message' => 'Phone number linked successfully',
            'status_code' => 200
        ];
    }

    /**
     * Unlink phone number from user account
     */
    public function unlinkPhone(array $request): array
    {
        $userId = $request['user_id'] ?? null;

        if (!$userId) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }

        // Remove phone number from user's account
        $stmt = $this->db->prepare("UPDATE users SET phone = NULL, updated_at = NOW() WHERE id = ?");
        $stmt->execute([$userId]);

        error_log("[AuthController] Phone unlinked: user_id=$userId");

        return [
            'success' => true,
            'message' => 'Phone number unlinked successfully',
            'status_code' => 200
        ];
    }

    /**
     * Upgrade user's plan after payment
     */
    public function upgradePlan(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        $plan = trim($request['body']['plan'] ?? '');

        if (!$userId) {
            return [
                'success' => false,
                'message' => 'Authentication required',
                'status_code' => 401
            ];
        }

        $plan = $this->normalizePlan($plan);
        if (!in_array($plan, ['standard', 'premium'], true)) {
            return [
                'success' => false,
                'message' => 'Invalid plan. Must be standard or premium.',
                'status_code' => 400
            ];
        }

        // Keep role in step with the plan so the paid capability package applies.
        $role = $this->roleForPlan($plan);
        $stmt = $this->db->prepare("UPDATE users SET plan = ?, role = ?, updated_at = NOW() WHERE id = ?");
        $stmt->execute([$plan, $role, $userId]);

        error_log("[AuthController] Plan upgraded: user_id=$userId, plan=$plan, role=$role");

        return [
            'success' => true,
            'message' => "Plan upgraded to $plan",
            'plan' => $plan,
            'role' => $role,
            'status_code' => 200
        ];
    }


    /**
     * Debug endpoint to check auth status (TEMPORARY)
     */
    public function debugAuth(array $request): array
    {
        return [
            'success' => true,
            'user_id' => $request['user_id'] ?? null,
            'authenticated' => $request['authenticated'] ?? false,
            'has_auth_header' => !empty($request['headers']['Authorization'] ?? $request['headers']['authorization'] ?? ''),
            'php_version' => PHP_VERSION,
            'status_code' => 200
        ];
    }

    /**
     * Generate a fresh per-user app key for the authenticated caller.
     * JWT-only by design: a request authed by an app key must NOT mint a
     * new app key (closes a self-rotation path that would let a leaked
     * key persist past a revoke). Returns the full key exactly once; only
     * its HMAC hash is persisted.
     */
    public function generateAppKey(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId || ($request['auth_type'] ?? null) !== 'jwt') {
            return ['success' => false, 'message' => 'Authentication required', 'status_code' => 401];
        }
        $material = $this->generateAppKeyMaterial();
        $stmt = $this->db->prepare(
            "UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?"
        );
        $stmt->execute([$material['hash'], $material['prefix'], $userId]);
        return [
            'success' => true,
            'message' => 'App key generated. Save it now — it will not be shown again.',
            'data' => [
                'app_key'            => $material['key'],
                'app_key_prefix'     => $material['prefix'],
                'app_key_created_at' => date('Y-m-d H:i:s'),
            ],
            'status_code' => 200,
        ];
    }

    /**
     * Revoke the authenticated user's app key. Idempotent.
     */
    public function revokeAppKey(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId || ($request['auth_type'] ?? null) !== 'jwt') {
            return ['success' => false, 'message' => 'Authentication required', 'status_code' => 401];
        }
        $stmt = $this->db->prepare(
            "UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?"
        );
        $stmt->execute([$userId]);
        return ['success' => true, 'message' => 'App key revoked.', 'status_code' => 200];
    }

    /**
     * Admin-only: generate a key for an arbitrary user. Caller must be
     * authenticated as a user with role='admin'. Returns the full key once.
     */
    public function adminGenerateAppKeyForUser(array $request): array
    {
        $callerId = $request['user_id'] ?? null;
        if (!$callerId || ($request['auth_type'] ?? null) !== 'jwt') {
            return ['success' => false, 'message' => 'Authentication required', 'status_code' => 401];
        }
        $stmt = $this->db->prepare("SELECT role FROM users WHERE id = ?");
        $stmt->execute([$callerId]);
        $caller = $stmt->fetch();
        if (!$caller || ($caller['role'] ?? '') !== 'admin') {
            return ['success' => false, 'message' => 'Admin privileges required', 'status_code' => 403];
        }
        $targetUserId = (int)($request['body']['user_id'] ?? 0);
        if ($targetUserId <= 0) {
            return ['success' => false, 'message' => 'user_id is required', 'status_code' => 400];
        }
        $stmt = $this->db->prepare("SELECT id FROM users WHERE id = ?");
        $stmt->execute([$targetUserId]);
        if (!$stmt->fetch()) {
            return ['success' => false, 'message' => 'User not found', 'status_code' => 404];
        }
        $material = $this->generateAppKeyMaterial();
        $stmt = $this->db->prepare(
            "UPDATE users SET app_key_hash = ?, app_key_prefix = ?, app_key_created_at = NOW(), updated_at = NOW() WHERE id = ?"
        );
        $stmt->execute([$material['hash'], $material['prefix'], $targetUserId]);
        error_log("[AuthController] Admin user_id=$callerId generated app key for user_id=$targetUserId");
        return [
            'success' => true,
            'message' => 'App key generated for user. Save it now — it will not be shown again.',
            'data' => [
                'user_id'            => $targetUserId,
                'app_key'            => $material['key'],
                'app_key_prefix'     => $material['prefix'],
                'app_key_created_at' => date('Y-m-d H:i:s'),
            ],
            'status_code' => 200,
        ];
    }

    /**
     * Admin-only: revoke an arbitrary user's app key. Caller must be
     * authenticated as a user with role='admin'. Idempotent.
     */
    public function adminRevokeAppKeyForUser(array $request): array
    {
        $callerId = $request['user_id'] ?? null;
        if (!$callerId || ($request['auth_type'] ?? null) !== 'jwt') {
            return ['success' => false, 'message' => 'Authentication required', 'status_code' => 401];
        }
        $stmt = $this->db->prepare("SELECT role FROM users WHERE id = ?");
        $stmt->execute([$callerId]);
        $caller = $stmt->fetch();
        if (!$caller || ($caller['role'] ?? '') !== 'admin') {
            return ['success' => false, 'message' => 'Admin privileges required', 'status_code' => 403];
        }
        $targetUserId = (int)($request['body']['user_id'] ?? 0);
        if ($targetUserId <= 0) {
            return ['success' => false, 'message' => 'user_id is required', 'status_code' => 400];
        }
        $stmt = $this->db->prepare(
            "UPDATE users SET app_key_hash = NULL, app_key_prefix = NULL, app_key_created_at = NULL, updated_at = NOW() WHERE id = ?"
        );
        $stmt->execute([$targetUserId]);
        error_log("[AuthController] Admin user_id=$callerId revoked app key for user_id=$targetUserId");
        return ['success' => true, 'message' => 'App key revoked.', 'data' => ['user_id' => $targetUserId], 'status_code' => 200];
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
}
