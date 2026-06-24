<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use PDO;
use Exception;

/**
 * Admin Controller
 *
 * Provides admin access to manage users and their settings.
 */
class AdminController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * List all users
     */
    public function listUsers(array $request): array
    {
        $sql = "SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix, app_key_created_at, created_at, updated_at FROM users ORDER BY id";
        $stmt = $this->db->query($sql);
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

        return [
            'success' => true,
            'users' => $users,
            'status_code' => 200
        ];
    }

    /**
     * Get a single user by ID
     */
    public function getUser(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        $sql = "SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix, app_key_created_at, created_at, updated_at FROM users WHERE id = :id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$user) {
            return [
                'success' => false,
                'error' => 'User not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'user' => $user,
            'status_code' => 200
        ];
    }

    /**
     * Get account information for a user (plan, role, token usage)
     */
    public function getUserAccount(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        try {
            $sql = "SELECT id, email, phone, first_name, last_name, role, plan,
                           provider, email_verified, firebase_uid, last_login, created_at
                    FROM users WHERE id = :id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':id' => $userId]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$user) {
                return [
                    'success' => false,
                    'error' => 'User not found',
                    'status_code' => 404
                ];
            }

            $tokensIn = 0;
            $tokensOut = 0;

            $tableCheck = $this->db->query("SHOW TABLES LIKE 'llm_usage_transactions'");
            if ($tableCheck->rowCount() > 0) {
                $tokenSql = "SELECT
                    COALESCE(SUM(prompt_tokens), 0) AS tokens_in,
                    COALESCE(SUM(completion_tokens), 0) AS tokens_out
                FROM llm_usage_transactions
                WHERE user_id = :user_id";
                $tokenStmt = $this->db->prepare($tokenSql);
                $tokenStmt->execute([':user_id' => $userId]);
                $tokenRow = $tokenStmt->fetch(PDO::FETCH_ASSOC);
                $tokensIn = (int)($tokenRow['tokens_in'] ?? 0);
                $tokensOut = (int)($tokenRow['tokens_out'] ?? 0);
            }

            $plan = $user['plan'] ?? 'free';
            $role = $user['role'] ?? 'user';
            $totalTokens = $tokensIn + $tokensOut;
            $freeQuota = 50000;
            $isFreeProspect = ($plan === 'free' && $role === 'prospect');

            return [
                'success' => true,
                'account' => [
                    'id' => (int)$user['id'],
                    'email' => $user['email'],
                    'phone' => $user['phone'],
                    'first_name' => $user['first_name'],
                    'last_name' => $user['last_name'],
                    'plan' => $plan,
                    'role' => $role,
                    'provider' => $user['provider'] ?? 'email',
                    'email_verified' => (bool)($user['email_verified'] ?? false),
                    'has_firebase_uid' => !empty($user['firebase_uid']),
                    'last_login' => $user['last_login'],
                    'created_at' => $user['created_at'],
                    'tokens_in' => $tokensIn,
                    'tokens_out' => $tokensOut,
                    'total_tokens' => $totalTokens,
                    'free_quota' => $freeQuota,
                    'is_free_prospect' => $isFreeProspect,
                    'free_quota_percent' => $isFreeProspect
                        ? min(100, round(($totalTokens / $freeQuota) * 100, 2))
                        : null,
                ],
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Create a new user
     */
    public function createUser(array $request): array
    {
        $input = $request['body'];

        $firstName = trim($input['first_name'] ?? '');
        $lastName = trim($input['last_name'] ?? '');
        $email = trim($input['email'] ?? '');
        $password = $input['password'] ?? '';
        $role = $input['role'] ?? 'user';

        if (empty($email) || empty($password)) {
            return [
                'success' => false,
                'error' => 'Email and password are required',
                'status_code' => 400
            ];
        }

        // Validate role
        if (!in_array($role, ['guest', 'prospect', 'user', 'admin'])) {
            $role = 'user';
        }

        // Hash password
        $hashedPassword = password_hash($password, PASSWORD_DEFAULT);

        $sql = "INSERT INTO users (email, password, first_name, last_name, role, provider, created_at, updated_at)
                VALUES (:email, :password, :first_name, :last_name, :role, 'email', NOW(), NOW())";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':email' => $email,
            ':password' => $hashedPassword,
            ':first_name' => $firstName,
            ':last_name' => $lastName,
            ':role' => $role
        ]);

        $newUserId = $this->db->lastInsertId();

        return [
            'success' => true,
            'message' => 'User created',
            'user_id' => (int)$newUserId,
            'status_code' => 200
        ];
    }

    /**
     * Update a user
     */
    public function updateUser(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $firstName = trim($input['first_name'] ?? '');
        $lastName = trim($input['last_name'] ?? '');
        $email = trim($input['email'] ?? '');
        $password = $input['password'] ?? '';
        $role = $input['role'] ?? null;

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (empty($email)) {
            return [
                'success' => false,
                'error' => 'Email is required',
                'status_code' => 400
            ];
        }

        // Validate role if provided
        if ($role !== null && !in_array($role, ['guest', 'prospect', 'user', 'admin'])) {
            return [
                'success' => false,
                'error' => 'Invalid role',
                'status_code' => 400
            ];
        }

        // Build update query
        $fields = ['email = :email', 'first_name = :first_name', 'last_name = :last_name', 'updated_at = NOW()'];
        $params = [
            ':id' => $userId,
            ':email' => $email,
            ':first_name' => $firstName,
            ':last_name' => $lastName
        ];

        if ($role !== null) {
            $fields[] = 'role = :role';
            $params[':role'] = $role;
        }

        if (!empty($password)) {
            $fields[] = 'password = :password';
            $params[':password'] = password_hash($password, PASSWORD_DEFAULT);
        }

        $sql = "UPDATE users SET " . implode(', ', $fields) . " WHERE id = :id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return [
            'success' => true,
            'message' => 'User updated',
            'status_code' => 200
        ];
    }

    /**
     * Delete a user
     */
    public function deleteUser(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        $sql = "DELETE FROM users WHERE id = :id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':id' => $userId]);

        if ($stmt->rowCount() === 0) {
            return [
                'success' => false,
                'error' => 'User not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'message' => 'User deleted',
            'status_code' => 200
        ];
    }

    /**
     * Get provider settings for a user
     */
    public function getProviderSettings(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        $this->ensureProviderSettingsTableExists();
        $this->ensureCategorySettingsTableExists();

        // Get category-level settings
        $categorySql = "SELECT category, enabled FROM user_category_settings WHERE user_id = :user_id";
        $categoryStmt = $this->db->prepare($categorySql);
        $categoryStmt->execute([':user_id' => $userId]);
        $categoryRows = $categoryStmt->fetchAll(PDO::FETCH_ASSOC);

        $categoryEnabled = ['avatar' => true, 'voice' => true];
        foreach ($categoryRows as $row) {
            $categoryEnabled[$row['category']] = (bool)$row['enabled'];
        }

        // Get provider-level settings
        $sql = "SELECT category, provider, api_key, settings, is_active, enabled
                FROM user_provider_settings
                WHERE user_id = :user_id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $result = [
            'avatar' => ['active' => null, 'enabled' => $categoryEnabled['avatar'], 'providers' => []],
            'voice' => ['active' => null, 'enabled' => $categoryEnabled['voice'], 'providers' => []]
        ];

        foreach ($rows as $row) {
            $category = $row['category'];
            $provider = $row['provider'];
            $settings = $row['settings'] ? json_decode($row['settings'], true) : null;
            $enabled = isset($row['enabled']) ? (bool)$row['enabled'] : true;

            $result[$category]['providers'][$provider] = [
                'has_key' => !empty($row['api_key']),
                'api_key' => $row['api_key'], // Return actual key for admin
                'settings' => $settings,
                'enabled' => $enabled
            ];

            if ($row['is_active'] == 1) {
                $result[$category]['active'] = $provider;
            }
        }

        return [
            'success' => true,
            'user_id' => $userId,
            'avatar' => $result['avatar'],
            'voice' => $result['voice'],
            'status_code' => 200
        ];
    }

    /**
     * Save provider for a user (admin action)
     */
    public function saveProvider(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';
        $apiKey = $input['api_key'] ?? null;
        $settings = $input['settings'] ?? null;

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category',
                'status_code' => 400
            ];
        }

        if (empty($provider)) {
            return [
                'success' => false,
                'error' => 'Provider is required',
                'status_code' => 400
            ];
        }

        $this->ensureProviderSettingsTableExists();

        // Parse settings if string
        if (is_string($settings)) {
            $settings = json_decode($settings, true);
        }
        $settingsJson = $settings ? json_encode($settings) : null;

        // Check if exists
        $checkSql = "SELECT id, api_key FROM user_provider_settings
                     WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $checkStmt = $this->db->prepare($checkSql);
        $checkStmt->execute([':user_id' => $userId, ':category' => $category, ':provider' => $provider]);
        $existing = $checkStmt->fetch();

        if ($existing) {
            // Update - only update api_key if provided
            if ($apiKey !== null) {
                $sql = "UPDATE user_provider_settings
                        SET api_key = :api_key, settings = :settings, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
                $params = [
                    ':user_id' => $userId,
                    ':category' => $category,
                    ':provider' => $provider,
                    ':api_key' => $apiKey,
                    ':settings' => $settingsJson
                ];
            } else {
                $sql = "UPDATE user_provider_settings
                        SET settings = :settings, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
                $params = [
                    ':user_id' => $userId,
                    ':category' => $category,
                    ':provider' => $provider,
                    ':settings' => $settingsJson
                ];
            }
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
        } else {
            // Insert
            $sql = "INSERT INTO user_provider_settings
                    (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)
                    VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':category' => $category,
                ':provider' => $provider,
                ':api_key' => $apiKey,
                ':settings' => $settingsJson
            ]);
        }

        // Handle set_active flag
        if (!empty($input['set_active'])) {
            // Unset other providers in this category
            $unsetSql = "UPDATE user_provider_settings SET is_active = 0 WHERE user_id = :user_id AND category = :category";
            $unsetStmt = $this->db->prepare($unsetSql);
            $unsetStmt->execute([':user_id' => $userId, ':category' => $category]);

            // Set this provider as active
            $activeSql = "UPDATE user_provider_settings SET is_active = 1 WHERE user_id = :user_id AND category = :category AND provider = :provider";
            $activeStmt = $this->db->prepare($activeSql);
            $activeStmt->execute([':user_id' => $userId, ':category' => $category, ':provider' => $provider]);
        }

        return [
            'success' => true,
            'message' => "Provider '$provider' saved",
            'status_code' => 200
        ];
    }

    /**
     * Toggle category enabled state (enable/disable all providers in category)
     */
    public function toggleCategoryEnabled(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $category = $input['category'] ?? '';
        $enabled = (bool)($input['enabled'] ?? true);

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category',
                'status_code' => 400
            ];
        }

        $this->ensureCategorySettingsTableExists();
        $this->ensureProviderSettingsTableExists();

        // Upsert category enabled state
        $enabledValue = $enabled ? 1 : 0;
        $sql = "INSERT INTO user_category_settings (user_id, category, enabled, updated_at)
                VALUES (:user_id, :category, :enabled, NOW())
                ON DUPLICATE KEY UPDATE enabled = :enabled2, updated_at = NOW()";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':enabled' => $enabledValue,
            ':enabled2' => $enabledValue
        ]);

        // Also update all individual providers in this category to match
        // When disabling, also clear is_active flag (can't be active if disabled)
        if ($enabled) {
            $updateProvidersSql = "UPDATE user_provider_settings
                                   SET enabled = :enabled, updated_at = NOW()
                                   WHERE user_id = :user_id AND category = :category";
        } else {
            $updateProvidersSql = "UPDATE user_provider_settings
                                   SET enabled = :enabled, is_active = 0, updated_at = NOW()
                                   WHERE user_id = :user_id AND category = :category";
        }
        $updateStmt = $this->db->prepare($updateProvidersSql);
        $updateStmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':enabled' => $enabledValue
        ]);

        $updatedCount = $updateStmt->rowCount();

        return [
            'success' => true,
            'message' => "Category '$category' " . ($enabled ? 'enabled' : 'disabled') . " ($updatedCount providers updated)",
            'status_code' => 200
        ];
    }

    /**
     * Toggle individual provider enabled state
     */
    public function toggleProviderEnabled(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';
        $enabled = (bool)($input['enabled'] ?? true);

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category',
                'status_code' => 400
            ];
        }

        if (empty($provider)) {
            return [
                'success' => false,
                'error' => 'Provider is required',
                'status_code' => 400
            ];
        }

        $this->ensureProviderSettingsTableExists();

        // Check if provider exists
        $checkSql = "SELECT id FROM user_provider_settings
                     WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $checkStmt = $this->db->prepare($checkSql);
        $checkStmt->execute([':user_id' => $userId, ':category' => $category, ':provider' => $provider]);
        $existing = $checkStmt->fetch();

        if ($existing) {
            // Update existing - when disabling, also clear is_active
            if ($enabled) {
                $sql = "UPDATE user_provider_settings SET enabled = 1, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
            } else {
                $sql = "UPDATE user_provider_settings SET enabled = 0, is_active = 0, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
            }
            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':category' => $category,
                ':provider' => $provider
            ]);
        } else {
            // Insert new record with just enabled state
            $sql = "INSERT INTO user_provider_settings
                    (user_id, category, provider, enabled, is_active, created_at, updated_at)
                    VALUES (:user_id, :category, :provider, :enabled, 0, NOW(), NOW())";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':category' => $category,
                ':provider' => $provider,
                ':enabled' => $enabled ? 1 : 0
            ]);
        }

        return [
            'success' => true,
            'message' => "Provider '$provider' " . ($enabled ? 'enabled' : 'disabled'),
            'status_code' => 200
        ];
    }

    /**
     * Delete a provider for a user
     */
    public function deleteProvider(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category',
                'status_code' => 400
            ];
        }

        if (empty($provider)) {
            return [
                'success' => false,
                'error' => 'Provider is required',
                'status_code' => 400
            ];
        }

        $sql = "DELETE FROM user_provider_settings WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId, ':category' => $category, ':provider' => $provider]);

        return [
            'success' => true,
            'message' => "Provider '$provider' deleted",
            'deleted' => $stmt->rowCount() > 0,
            'status_code' => 200
        ];
    }

    /**
     * Get API keys for a user
     */
    public function getApiKeys(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        $this->ensureApiKeysTableExists();

        $sql = "SELECT provider, api_key, model, base_url, max_tokens, temperature,
                       chat_endpoint, streaming, supports_tools, system_prompt, enabled, updated_at
                FROM user_api_keys WHERE user_id = :user_id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $emptyState = [
            'api_key' => null, 'masked_key' => null,
            'model' => null, 'base_url' => null,
            'max_tokens' => null, 'temperature' => null,
            'chat_endpoint' => null, 'streaming' => null,
            'supports_tools' => null, 'system_prompt' => null,
            'enabled' => true, 'updated_at' => null,
        ];

        $keys = [];
        foreach ($rows as $row) {
            $apiKey = $row['api_key'] ?? '';
            $keys[$row['provider']] = [
                'api_key' => $apiKey, // Return actual key for admin
                'masked_key' => $apiKey !== '' ? '****' . substr($apiKey, -4) : null,
                'model' => $row['model'],
                'base_url' => $row['base_url'],
                'max_tokens' => $row['max_tokens'] !== null ? (int)$row['max_tokens'] : null,
                'temperature' => $row['temperature'] !== null ? (float)$row['temperature'] : null,
                'chat_endpoint' => $row['chat_endpoint'],
                'streaming' => $row['streaming'] !== null ? (bool)$row['streaming'] : null,
                'supports_tools' => $row['supports_tools'] !== null ? (bool)$row['supports_tools'] : null,
                'system_prompt' => $row['system_prompt'],
                'enabled' => (bool)($row['enabled'] ?? 1),
                'updated_at' => $row['updated_at'],
            ];
        }

        // Include all valid providers with empty state if not set
        $validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];
        foreach ($validProviders as $provider) {
            if (!isset($keys[$provider])) {
                $keys[$provider] = $emptyState;
            }
        }

        // Overlay the keys this user inherits from their package (role). A user
        // without a personal key still has the keys their package grants at chat
        // time (see ChatController::applyPackageDefaults). Surface those here —
        // tagged `source: 'package'` with the package name — so the admin can see
        // (and, by editing, override per-user) what the user effectively has.
        try {
            $resolver = new PackageResolver($this->db);
            $packageName = $resolver->resolveRole($userId);
            $package = $resolver->resolveForUser($userId);
            $pkgProviders = $package['capabilities']['providers'] ?? [];
            if (!is_array($pkgProviders)) {
                $pkgProviders = [];
            }
            foreach ($validProviders as $provider) {
                $userKey = $keys[$provider]['api_key'] ?? null;
                if ($userKey !== null && $userKey !== '') {
                    // Personal key set on the user — that wins over the package.
                    $keys[$provider]['source'] = 'user';
                    $keys[$provider]['available'] = true;
                    $keys[$provider]['package_name'] = null;
                    continue;
                }
                $pkg = is_array($pkgProviders[$provider] ?? null) ? $pkgProviders[$provider] : [];
                $pkgEnabled = !empty($pkg['enabled']);
                $pkgKey = $pkgEnabled && isset($pkg['default_api_key'])
                    ? trim((string) $pkg['default_api_key']) : '';
                $pkgModel = $pkgEnabled && isset($pkg['default_model'])
                    ? trim((string) $pkg['default_model']) : '';
                if ($pkgKey !== '') {
                    $keys[$provider]['api_key'] = $pkgKey; // actual key for admin (display + reveal + edit)
                    $keys[$provider]['masked_key'] = '****' . substr($pkgKey, -4);
                    if (($keys[$provider]['model'] ?? null) === null && $pkgModel !== '') {
                        $keys[$provider]['model'] = $pkgModel;
                    }
                    $keys[$provider]['source'] = 'package';
                    $keys[$provider]['available'] = true;
                    $keys[$provider]['package_name'] = $packageName;
                } else {
                    $keys[$provider]['source'] = 'none';
                    $keys[$provider]['available'] = false;
                    $keys[$provider]['package_name'] = null;
                }
            }
        } catch (\Throwable $e) {
            error_log('[AdminController] package key overlay failed: ' . $e->getMessage());
        }

        return [
            'success' => true,
            'user_id' => $userId,
            'keys' => $keys,
            'status_code' => 200
        ];
    }

    /**
     * Save API keys for a user
     */
    public function saveApiKeys(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $keys = $input['keys'] ?? [];

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (empty($keys)) {
            return [
                'success' => false,
                'error' => 'No keys provided',
                'status_code' => 400
            ];
        }

        $this->ensureApiKeysTableExists();

        $validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];
        $savedCount = 0;

        // Columns that can be updated individually (without requiring an api_key).
        // Map: input field => [db column, caster]
        $settingFields = [
            'model'          => ['model',          fn($v) => $v === '' ? null : (string)$v],
            'base_url'       => ['base_url',       fn($v) => $v === '' ? null : (string)$v],
            'max_tokens'     => ['max_tokens',     fn($v) => $v === '' || $v === null ? null : (int)$v],
            'temperature'    => ['temperature',    fn($v) => $v === '' || $v === null ? null : (float)$v],
            'chat_endpoint'  => ['chat_endpoint',  fn($v) => $v === '' ? null : (string)$v],
            'streaming'      => ['streaming',      fn($v) => $v === null ? null : ($v ? 1 : 0)],
            'supports_tools' => ['supports_tools', fn($v) => $v === null ? null : ($v ? 1 : 0)],
            'system_prompt'  => ['system_prompt',  fn($v) => $v === '' ? null : (string)$v],
            'enabled'        => ['enabled',        fn($v) => $v ? 1 : 0],
        ];

        foreach ($keys as $provider => $entry) {
            if (!in_array($provider, $validProviders)) {
                continue;
            }

            // Back-compat: allow plain string (api_key only)
            if (is_string($entry)) {
                $entry = ['api_key' => $entry];
            }
            if (!is_array($entry)) {
                continue;
            }

            $hasApiKey = array_key_exists('api_key', $entry) && trim((string)$entry['api_key']) !== '';
            $apiKey = $hasApiKey ? trim((string)$entry['api_key']) : null;

            // Build dynamic column list
            $cols = ['user_id', 'provider'];
            $placeholders = [':user_id', ':provider'];
            $updates = [];
            $params = [':user_id' => $userId, ':provider' => $provider];

            if ($hasApiKey) {
                $cols[] = 'api_key';
                $placeholders[] = ':api_key';
                $updates[] = 'api_key = VALUES(api_key)';
                $params[':api_key'] = $apiKey;
            }

            foreach ($settingFields as $inputKey => [$col, $cast]) {
                if (!array_key_exists($inputKey, $entry)) {
                    continue;
                }
                $cols[] = $col;
                $placeholders[] = ':' . $col;
                $updates[] = "$col = VALUES($col)";
                $params[':' . $col] = $cast($entry[$inputKey]);
            }

            // If only provider/user_id (no api_key, no settings), skip
            if (count($cols) <= 2) {
                continue;
            }

            // If inserting a brand-new row without an api_key, we can't (api_key is NOT NULL).
            // Check existence and skip insert in that case.
            if (!$hasApiKey) {
                $check = $this->db->prepare("SELECT 1 FROM user_api_keys WHERE user_id = :uid AND provider = :p");
                $check->execute([':uid' => $userId, ':p' => $provider]);
                if (!$check->fetchColumn()) {
                    continue; // can't create row without an api_key
                }
            }

            $cols[] = 'created_at';
            $cols[] = 'updated_at';
            $placeholders[] = 'NOW()';
            $placeholders[] = 'NOW()';
            $updates[] = 'updated_at = NOW()';

            $sql = "INSERT INTO user_api_keys (" . implode(', ', $cols) . ")
                    VALUES (" . implode(', ', $placeholders) . ")
                    ON DUPLICATE KEY UPDATE " . implode(', ', $updates);
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            $savedCount++;
        }

        return [
            'success' => true,
            'message' => "Saved $savedCount API key(s)",
            'status_code' => 200
        ];
    }

    /**
     * Delete an API key for a user
     */
    public function deleteApiKey(array $request): array
    {
        $input = $request['body'];

        $userId = (int)($input['user_id'] ?? 0);
        $provider = $input['provider'] ?? '';

        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400
            ];
        }

        if (empty($provider)) {
            return [
                'success' => false,
                'error' => 'Provider is required',
                'status_code' => 400
            ];
        }

        $sql = "DELETE FROM user_api_keys WHERE user_id = :user_id AND provider = :provider";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId, ':provider' => $provider]);

        return [
            'success' => true,
            'message' => "API key for '$provider' deleted",
            'deleted' => $stmt->rowCount() > 0,
            'status_code' => 200
        ];
    }

    /**
     * Ensure user_provider_settings table exists
     */
    private function ensureProviderSettingsTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `user_provider_settings` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `user_id` INT UNSIGNED NOT NULL,
            `category` ENUM('avatar', 'voice') NOT NULL,
            `provider` VARCHAR(50) NOT NULL,
            `api_key` TEXT DEFAULT NULL,
            `settings` JSON DEFAULT NULL,
            `is_active` TINYINT(1) NOT NULL DEFAULT 0,
            `enabled` TINYINT(1) NOT NULL DEFAULT 1,
            `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `unique_user_category_provider` (`user_id`, `category`, `provider`),
            KEY `idx_user_category` (`user_id`, `category`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        $this->db->exec($sql);

        // Add enabled column if it doesn't exist (for existing tables)
        try {
            $this->db->exec("ALTER TABLE `user_provider_settings` ADD COLUMN `enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `is_active`");
        } catch (\PDOException $e) {
            // Column already exists, ignore
        }
    }

    /**
     * Ensure user_category_settings table exists
     */
    private function ensureCategorySettingsTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `user_category_settings` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `user_id` INT UNSIGNED NOT NULL,
            `category` ENUM('avatar', 'voice') NOT NULL,
            `enabled` TINYINT(1) NOT NULL DEFAULT 1,
            `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `unique_user_category` (`user_id`, `category`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        $this->db->exec($sql);
    }

    /**
     * Ensure user_api_keys table exists
     */
    private function ensureApiKeysTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `user_api_keys` (
            `user_id` int NOT NULL,
            `provider` varchar(50) NOT NULL,
            `api_key` text NOT NULL,
            `model` varchar(255) DEFAULT NULL,
            `base_url` varchar(500) DEFAULT NULL,
            `max_tokens` int DEFAULT NULL,
            `temperature` decimal(3,2) DEFAULT NULL,
            `chat_endpoint` varchar(500) DEFAULT NULL,
            `streaming` tinyint(1) DEFAULT NULL,
            `supports_tools` tinyint(1) DEFAULT NULL,
            `system_prompt` text DEFAULT NULL,
            `enabled` tinyint(1) NOT NULL DEFAULT 1,
            `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`user_id`, `provider`),
            KEY `idx_user_id` (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        $this->db->exec($sql);

        // Idempotent migrations for existing installations
        $alters = [
            "ALTER TABLE `user_api_keys` ADD COLUMN `model` varchar(255) DEFAULT NULL AFTER `api_key`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `base_url` varchar(500) DEFAULT NULL AFTER `model`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `max_tokens` int DEFAULT NULL AFTER `base_url`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `temperature` decimal(3,2) DEFAULT NULL AFTER `max_tokens`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `chat_endpoint` varchar(500) DEFAULT NULL AFTER `temperature`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `streaming` tinyint(1) DEFAULT NULL AFTER `chat_endpoint`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `supports_tools` tinyint(1) DEFAULT NULL AFTER `streaming`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `system_prompt` text DEFAULT NULL AFTER `supports_tools`",
            "ALTER TABLE `user_api_keys` ADD COLUMN `enabled` tinyint(1) NOT NULL DEFAULT 1 AFTER `system_prompt`",
        ];
        foreach ($alters as $alter) {
            try { $this->db->exec($alter); } catch (\PDOException $e) { /* column exists */ }
        }
    }

    // ============================================
    // USAGE STATISTICS METHODS
    // ============================================

    /**
     * Get system-wide usage statistics
     */
    public function getUsageStats(array $request): array
    {
        try {
            $period = $request['query']['period'] ?? 'month';
            $dateFrom = $request['query']['date_from'] ?? null;
            $dateTo = $request['query']['date_to'] ?? null;

            // Calculate date range based on period
            $dateRange = $this->getDateRange($period, $dateFrom, $dateTo);

            // Get overall stats
            $overallSql = "SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_requests,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                COUNT(DISTINCT user_id) as unique_users,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as total_voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as total_voice_cost,
                COALESCE(SUM(function_calls_count), 0) as total_function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN :date_from AND :date_to";

            $stmt = $this->db->prepare($overallSql);
            $stmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $overall = $stmt->fetch(PDO::FETCH_ASSOC);

            // Get stats by provider
            $byProviderSql = "SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN :date_from AND :date_to
            GROUP BY provider
            ORDER BY cost DESC";

            $stmt = $this->db->prepare($byProviderSql);
            $stmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $byProvider = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get daily trend (last 30 days)
            $trendSql = "SELECT
                DATE(created_at) as date,
                COUNT(*) as requests,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(SUM(total_tokens), 0) as tokens
            FROM llm_usage_transactions
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date ASC";

            $stmt = $this->db->query($trendSql);
            $dailyTrend = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return [
                'success' => true,
                'period' => $period,
                'date_range' => $dateRange,
                'overall' => [
                    'total_requests' => (int)$overall['total_requests'],
                    'successful_requests' => (int)$overall['successful_requests'],
                    'failed_requests' => (int)$overall['failed_requests'],
                    'total_tokens' => (int)$overall['total_tokens'],
                    'prompt_tokens' => (int)$overall['total_prompt_tokens'],
                    'completion_tokens' => (int)$overall['total_completion_tokens'],
                    'total_cost' => round((float)$overall['total_cost'], 4),
                    'avg_response_time_ms' => round((float)$overall['avg_response_time']),
                    'unique_users' => (int)$overall['unique_users'],
                    'voice_requests' => (int)($overall['total_voice_requests'] ?? 0),
                    'audio_seconds' => round((float)($overall['total_audio_seconds'] ?? 0), 2),
                    'voice_cost' => round((float)($overall['total_voice_cost'] ?? 0), 4),
                    'total_function_calls' => (int)($overall['total_function_calls'] ?? 0),
                    'total_mcp_calls' => (int)($overall['total_mcp_calls'] ?? 0),
                ],
                'by_provider' => array_map(function($p) {
                    return [
                        'provider' => $p['provider'],
                        'requests' => (int)$p['requests'],
                        'tokens' => (int)$p['tokens'],
                        'cost' => round((float)$p['cost'], 4),
                        'avg_response_time_ms' => round((float)$p['avg_response_time']),
                        'voice_requests' => (int)($p['voice_requests'] ?? 0),
                        'audio_seconds' => round((float)($p['audio_seconds'] ?? 0), 2),
                        'voice_cost' => round((float)($p['voice_cost'] ?? 0), 4),
                        'function_calls' => (int)($p['function_calls'] ?? 0),
                        'mcp_calls' => (int)($p['mcp_calls'] ?? 0),
                    ];
                }, $byProvider),
                'daily_trend' => array_map(function($d) {
                    return [
                        'date' => $d['date'],
                        'requests' => (int)$d['requests'],
                        'cost' => round((float)$d['cost'], 4),
                        'tokens' => (int)$d['tokens'],
                    ];
                }, $dailyTrend),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get usage breakdown by user
     */
    public function getUsageByUser(array $request): array
    {
        try {
            $period = $request['query']['period'] ?? 'month';
            $limit = min((int)($request['query']['limit'] ?? 50), 100);
            $offset = (int)($request['query']['offset'] ?? 0);

            $dateRange = $this->getDateRange($period);

            $sql = "SELECT
                t.user_id,
                u.email,
                u.first_name,
                u.last_name,
                COUNT(*) as total_requests,
                COALESCE(SUM(t.total_tokens), 0) as total_tokens,
                COALESCE(SUM(t.cost_usd), 0) as total_cost,
                COALESCE(AVG(t.response_time_ms), 0) as avg_response_time,
                MAX(t.created_at) as last_activity,
                SUM(CASE WHEN t.is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(t.audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN t.is_voice_request = 1 THEN t.cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(t.function_calls_count), 0) as function_calls,
                COALESCE(SUM(t.mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.created_at BETWEEN :date_from AND :date_to
            GROUP BY t.user_id, u.email, u.first_name, u.last_name
            ORDER BY total_cost DESC
            LIMIT :limit OFFSET :offset";

            $stmt = $this->db->prepare($sql);
            $stmt->bindValue(':date_from', $dateRange['from']);
            $stmt->bindValue(':date_to', $dateRange['to']);
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();
            $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get total count
            $countSql = "SELECT COUNT(DISTINCT user_id) as total FROM llm_usage_transactions
                         WHERE created_at BETWEEN :date_from AND :date_to";
            $countStmt = $this->db->prepare($countSql);
            $countStmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $total = (int)$countStmt->fetch(PDO::FETCH_ASSOC)['total'];

            return [
                'success' => true,
                'period' => $period,
                'date_range' => $dateRange,
                'users' => array_map(function($u) {
                    return [
                        'user_id' => (int)$u['user_id'],
                        'email' => $u['email'] ?? 'Unknown',
                        'name' => trim(($u['first_name'] ?? '') . ' ' . ($u['last_name'] ?? '')) ?: 'Unknown',
                        'requests' => (int)$u['total_requests'],
                        'tokens' => (int)$u['total_tokens'],
                        'cost' => round((float)$u['total_cost'], 4),
                        'avg_response_time_ms' => round((float)$u['avg_response_time']),
                        'last_activity' => $u['last_activity'],
                        'voice_requests' => (int)($u['voice_requests'] ?? 0),
                        'audio_seconds' => round((float)($u['audio_seconds'] ?? 0), 2),
                        'voice_cost' => round((float)($u['voice_cost'] ?? 0), 4),
                        'function_calls' => (int)($u['function_calls'] ?? 0),
                        'mcp_calls' => (int)($u['mcp_calls'] ?? 0),
                    ];
                }, $users),
                'pagination' => [
                    'total' => $total,
                    'limit' => $limit,
                    'offset' => $offset,
                ],
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get detailed usage for a specific user
     */
    public function getUserUsageDetail(array $request, int $userId): array
    {
        try {
            $period = $request['query']['period'] ?? 'month';
            $dateRange = $this->getDateRange($period);

            // Get user info
            $userSql = "SELECT id, email, first_name, last_name FROM users WHERE id = :id";
            $userStmt = $this->db->prepare($userSql);
            $userStmt->execute([':id' => $userId]);
            $user = $userStmt->fetch(PDO::FETCH_ASSOC);

            if (!$user) {
                return [
                    'success' => false,
                    'error' => 'User not found',
                    'status_code' => 404
                ];
            }

            // Get overall stats for user
            $statsSql = "SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE user_id = :user_id AND created_at BETWEEN :date_from AND :date_to";

            $stmt = $this->db->prepare($statsSql);
            $stmt->execute([':user_id' => $userId, ':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $stats = $stmt->fetch(PDO::FETCH_ASSOC);

            // Get breakdown by provider
            $byProviderSql = "SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE user_id = :user_id AND created_at BETWEEN :date_from AND :date_to
            GROUP BY provider
            ORDER BY cost DESC";

            $stmt = $this->db->prepare($byProviderSql);
            $stmt->execute([':user_id' => $userId, ':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $byProvider = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get recent transactions
            $recentSql = "SELECT
                id, provider, model, prompt_tokens, completion_tokens, total_tokens,
                cost_usd, response_time_ms, status, function_calls_count, created_at,
                is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds,
                mcp_calls_count, functions_called, mcp_tools_called
            FROM llm_usage_transactions
            WHERE user_id = :user_id
            ORDER BY created_at DESC
            LIMIT 50";

            $stmt = $this->db->prepare($recentSql);
            $stmt->execute([':user_id' => $userId]);
            $recentTransactions = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return [
                'success' => true,
                'user' => [
                    'id' => (int)$user['id'],
                    'email' => $user['email'],
                    'name' => trim($user['first_name'] . ' ' . $user['last_name']),
                ],
                'period' => $period,
                'date_range' => $dateRange,
                'stats' => [
                    'total_requests' => (int)$stats['total_requests'],
                    'successful_requests' => (int)$stats['successful_requests'],
                    'total_tokens' => (int)$stats['total_tokens'],
                    'total_cost' => round((float)$stats['total_cost'], 4),
                    'avg_response_time_ms' => round((float)$stats['avg_response_time']),
                    'voice_requests' => (int)($stats['voice_requests'] ?? 0),
                    'audio_seconds' => round((float)($stats['audio_seconds'] ?? 0), 2),
                    'voice_cost' => round((float)($stats['voice_cost'] ?? 0), 4),
                    'function_calls' => (int)($stats['function_calls'] ?? 0),
                    'mcp_calls' => (int)($stats['mcp_calls'] ?? 0),
                ],
                'by_provider' => array_map(function($p) {
                    return [
                        'provider' => $p['provider'],
                        'requests' => (int)$p['requests'],
                        'tokens' => (int)$p['tokens'],
                        'cost' => round((float)$p['cost'], 4),
                        'voice_requests' => (int)($p['voice_requests'] ?? 0),
                        'audio_seconds' => round((float)($p['audio_seconds'] ?? 0), 2),
                        'function_calls' => (int)($p['function_calls'] ?? 0),
                        'mcp_calls' => (int)($p['mcp_calls'] ?? 0),
                    ];
                }, $byProvider),
                'recent_transactions' => array_map(function($t) {
                    return [
                        'id' => (int)$t['id'],
                        'provider' => $t['provider'],
                        'model' => $t['model'],
                        'prompt_tokens' => (int)$t['prompt_tokens'],
                        'completion_tokens' => (int)$t['completion_tokens'],
                        'total_tokens' => (int)$t['total_tokens'],
                        'cost' => round((float)$t['cost_usd'], 6),
                        'response_time_ms' => (int)$t['response_time_ms'],
                        'status' => $t['status'],
                        'function_calls' => (int)$t['function_calls_count'],
                        'mcp_calls' => (int)($t['mcp_calls_count'] ?? 0),
                        'functions_called' => $t['functions_called'] ? json_decode($t['functions_called'], true) : [],
                        'mcp_tools_called' => $t['mcp_tools_called'] ? json_decode($t['mcp_tools_called'], true) : [],
                        'created_at' => $t['created_at'],
                        'is_voice' => (bool)($t['is_voice_request'] ?? 0),
                        'audio_seconds' => round((float)($t['audio_duration_seconds'] ?? 0), 2),
                    ];
                }, $recentTransactions),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get all transactions with filters (admin view)
     */
    public function getUsageTransactions(array $request): array
    {
        try {
            $provider = $request['query']['provider'] ?? null;
            $userId = $request['query']['user_id'] ?? null;
            $status = $request['query']['status'] ?? null;
            $dateFrom = $request['query']['date_from'] ?? null;
            $dateTo = $request['query']['date_to'] ?? null;
            $limit = min((int)($request['query']['limit'] ?? 100), 500);
            $offset = (int)($request['query']['offset'] ?? 0);

            $conditions = [];
            $params = [];

            if ($provider) {
                $conditions[] = "t.provider = :provider";
                $params[':provider'] = $provider;
            }

            if ($userId) {
                $conditions[] = "t.user_id = :user_id";
                $params[':user_id'] = (int)$userId;
            }

            if ($status) {
                $conditions[] = "t.status = :status";
                $params[':status'] = $status;
            }

            if ($dateFrom) {
                $conditions[] = "t.created_at >= :date_from";
                $params[':date_from'] = $dateFrom;
            }

            if ($dateTo) {
                $conditions[] = "t.created_at <= :date_to";
                $params[':date_to'] = $dateTo;
            }

            $whereClause = $conditions ? "WHERE " . implode(" AND ", $conditions) : "";

            $sql = "SELECT
                t.id, t.user_id, t.provider, t.model, t.prompt_tokens, t.completion_tokens,
                t.total_tokens, t.cost_usd, t.response_time_ms, t.status, t.error_message,
                t.function_calls_count, t.mcp_calls_count, t.functions_called, t.mcp_tools_called,
                t.created_at,
                t.is_voice_request, t.audio_duration_seconds, t.audio_input_seconds, t.audio_output_seconds,
                u.email, u.first_name, u.last_name
            FROM llm_usage_transactions t
            LEFT JOIN users u ON t.user_id = u.id
            {$whereClause}
            ORDER BY t.created_at DESC
            LIMIT :limit OFFSET :offset";

            $stmt = $this->db->prepare($sql);
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();
            $transactions = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get total count
            $countSql = "SELECT COUNT(*) as total FROM llm_usage_transactions t {$whereClause}";
            $countStmt = $this->db->prepare($countSql);
            foreach ($params as $key => $value) {
                $countStmt->bindValue($key, $value);
            }
            $countStmt->execute();
            $total = (int)$countStmt->fetch(PDO::FETCH_ASSOC)['total'];

            return [
                'success' => true,
                'transactions' => array_map(function($t) {
                    return [
                        'id' => (int)$t['id'],
                        'user_id' => (int)$t['user_id'],
                        'user_email' => $t['email'] ?? 'Unknown',
                        'user_name' => trim(($t['first_name'] ?? '') . ' ' . ($t['last_name'] ?? '')) ?: 'Unknown',
                        'provider' => $t['provider'],
                        'model' => $t['model'],
                        'prompt_tokens' => (int)$t['prompt_tokens'],
                        'completion_tokens' => (int)$t['completion_tokens'],
                        'total_tokens' => (int)$t['total_tokens'],
                        'cost' => round((float)$t['cost_usd'], 6),
                        'response_time_ms' => (int)$t['response_time_ms'],
                        'status' => $t['status'],
                        'error_message' => $t['error_message'],
                        'function_calls' => (int)$t['function_calls_count'],
                        'mcp_calls' => (int)($t['mcp_calls_count'] ?? 0),
                        'functions_called' => $t['functions_called'] ? json_decode($t['functions_called'], true) : [],
                        'mcp_tools_called' => $t['mcp_tools_called'] ? json_decode($t['mcp_tools_called'], true) : [],
                        'created_at' => $t['created_at'],
                        'is_voice' => (bool)($t['is_voice_request'] ?? 0),
                        'audio_seconds' => round((float)($t['audio_duration_seconds'] ?? 0), 2),
                        'audio_input_seconds' => round((float)($t['audio_input_seconds'] ?? 0), 2),
                        'audio_output_seconds' => round((float)($t['audio_output_seconds'] ?? 0), 2),
                    ];
                }, $transactions),
                'pagination' => [
                    'total' => $total,
                    'limit' => $limit,
                    'offset' => $offset,
                ],
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get tool/MCP usage statistics with per-tool and per-MCP server breakdown
     */
    public function getToolStats(array $request): array
    {
        try {
            $period = $request['query']['period'] ?? 'month';
            $dateRange = $this->getDateRange($period);

            // First, load ALL registered MCP tools from the database
            // This is the source of truth for what is an MCP tool
            $mcpToolsFromDb = $this->loadRegisteredMCPTools();

            // Get overall tool stats
            $overallSql = "SELECT
                COUNT(*) as total_requests,
                COALESCE(SUM(function_calls_count), 0) as total_function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls,
                SUM(CASE WHEN function_calls_count > 0 THEN 1 ELSE 0 END) as requests_with_tools
            FROM llm_usage_transactions
            WHERE created_at BETWEEN :date_from AND :date_to";

            $stmt = $this->db->prepare($overallSql);
            $stmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $overall = $stmt->fetch(PDO::FETCH_ASSOC);

            // Get tool usage by provider
            $byProviderSql = "SELECT
                provider,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN :date_from AND :date_to
                AND function_calls_count > 0
            GROUP BY provider
            ORDER BY function_calls DESC";

            $stmt = $this->db->prepare($byProviderSql);
            $stmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $byProvider = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get individual tool names with user info and timestamps
            $toolsSql = "SELECT user_id, functions_called, mcp_tools_called, created_at
            FROM llm_usage_transactions
            WHERE created_at BETWEEN :date_from AND :date_to
                AND functions_called IS NOT NULL";

            $stmt = $this->db->prepare($toolsSql);
            $stmt->execute([':date_from' => $dateRange['from'], ':date_to' => $dateRange['to']]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Aggregate detailed tool stats in PHP
            $toolStats = [];  // name => [count, users => [], last_used, is_mcp]
            $mcpToolStats = [];  // Separate tracking for MCP tools with server info

            foreach ($rows as $row) {
                $functions = json_decode($row['functions_called'], true) ?? [];
                $mcpTools = json_decode($row['mcp_tools_called'], true) ?? [];
                $userId = $row['user_id'];
                $createdAt = $row['created_at'];

                // Count regular function calls
                foreach ($functions as $fn) {
                    if (!isset($toolStats[$fn])) {
                        $toolStats[$fn] = [
                            'count' => 0,
                            'users' => [],
                            'last_used' => null,
                            'is_mcp' => false
                        ];
                    }
                    $toolStats[$fn]['count']++;
                    $toolStats[$fn]['users'][$userId] = true;
                    if ($toolStats[$fn]['last_used'] === null || $createdAt > $toolStats[$fn]['last_used']) {
                        $toolStats[$fn]['last_used'] = $createdAt;
                    }
                }

                // Count MCP tool calls separately with full detail
                foreach ($mcpTools as $mcpTool) {
                    $toolName = $mcpTool;
                    // Also add to main toolStats for overall ranking
                    if (!isset($toolStats[$toolName])) {
                        $toolStats[$toolName] = [
                            'count' => 0,
                            'users' => [],
                            'last_used' => null,
                            'is_mcp' => true
                        ];
                    }
                    $toolStats[$toolName]['count']++;
                    $toolStats[$toolName]['is_mcp'] = true;
                    $toolStats[$toolName]['users'][$userId] = true;
                    if ($toolStats[$toolName]['last_used'] === null || $createdAt > $toolStats[$toolName]['last_used']) {
                        $toolStats[$toolName]['last_used'] = $createdAt;
                    }

                    // Track in separate MCP stats for detailed server breakdown
                    if (!isset($mcpToolStats[$toolName])) {
                        $mcpToolStats[$toolName] = [
                            'count' => 0,
                            'users' => [],
                            'last_used' => null
                        ];
                    }
                    $mcpToolStats[$toolName]['count']++;
                    $mcpToolStats[$toolName]['users'][$userId] = true;
                    if ($mcpToolStats[$toolName]['last_used'] === null || $createdAt > $mcpToolStats[$toolName]['last_used']) {
                        $mcpToolStats[$toolName]['last_used'] = $createdAt;
                    }
                }
            }

            // Sort by count descending and format detailed tools
            uasort($toolStats, fn($a, $b) => $b['count'] - $a['count']);

            $detailedTools = [];
            $totalMcpCalls = 0;
            $count = 0;
            foreach ($toolStats as $name => $stats) {
                // Check if this tool is MCP by looking up in registered MCP tools
                $mcpInfo = $this->isMCPToolFromRegistry($name, $mcpToolsFromDb);
                $isMcp = $mcpInfo !== null;

                if ($isMcp) {
                    $totalMcpCalls += $stats['count'];
                }

                $detailedTools[] = [
                    'name' => $name,
                    'count' => $stats['count'],
                    'unique_users' => count($stats['users']),
                    'last_used' => $stats['last_used'],
                    'is_mcp' => $isMcp,
                    'mcp_server' => $mcpInfo['server_name'] ?? null
                ];
                $count++;
                if ($count >= 50) break; // Top 50 tools
            }

            // Aggregate MCP server stats with detailed tool breakdown
            $mcpServerStats = [];
            foreach ($detailedTools as $tool) {
                if ($tool['is_mcp'] && $tool['mcp_server']) {
                    $serverName = $tool['mcp_server'];
                    if (!isset($mcpServerStats[$serverName])) {
                        $mcpServerStats[$serverName] = [
                            'name' => $serverName,
                            'total_calls' => 0,
                            'tool_count' => 0,
                            'unique_users' => [],
                            'tools' => []
                        ];
                    }
                    $mcpServerStats[$serverName]['total_calls'] += $tool['count'];
                    $mcpServerStats[$serverName]['tool_count']++;
                    // Merge unique users
                    if (isset($toolStats[$tool['name']]['users'])) {
                        foreach ($toolStats[$tool['name']]['users'] as $uid => $v) {
                            $mcpServerStats[$serverName]['unique_users'][$uid] = true;
                        }
                    }
                    $mcpServerStats[$serverName]['tools'][] = [
                        'name' => $tool['name'],
                        'count' => $tool['count'],
                        'unique_users' => $tool['unique_users'],
                        'last_used' => $tool['last_used']
                    ];
                }
            }

            // Sort tools within each server by count
            foreach ($mcpServerStats as &$server) {
                usort($server['tools'], fn($a, $b) => $b['count'] - $a['count']);
                $server['unique_users'] = count($server['unique_users']);
            }
            unset($server);

            // Sort MCP servers by total calls
            uasort($mcpServerStats, fn($a, $b) => $b['total_calls'] - $a['total_calls']);
            $mcpServers = array_values($mcpServerStats);

            // Calculate tool usage rate
            $totalRequests = (int)$overall['total_requests'];
            $requestsWithTools = (int)$overall['requests_with_tools'];
            $toolUsageRate = $totalRequests > 0
                ? round(($requestsWithTools / $totalRequests) * 100, 1)
                : 0;

            // Separate regular tools and MCP tools for the response
            $regularToolsUsed = array_filter($detailedTools, fn($t) => !$t['is_mcp']);
            $mcpToolsUsed = array_filter($detailedTools, fn($t) => $t['is_mcp']);

            // Load ALL available tools (not just used ones)
            $allAvailableRegularTools = $this->loadAllAvailableRegularTools($toolStats);
            $allAvailableMcpTools = $this->loadAllAvailableMCPTools($toolStats);

            return [
                'success' => true,
                'period' => $period,
                'date_range' => $dateRange,
                'total_function_calls' => (int)$overall['total_function_calls'],
                'total_mcp_calls' => $totalMcpCalls, // Recalculated from registry
                'total_requests' => $totalRequests,
                'requests_with_tools' => $requestsWithTools,
                'tool_usage_rate' => $toolUsageRate,
                'unique_tools_count' => count($toolStats),
                'unique_mcp_tools_count' => count($mcpToolsUsed),
                'top_tools' => $detailedTools,
                'regular_tools' => array_values($regularToolsUsed),
                'mcp_tools' => array_values($mcpToolsUsed),
                'mcp_servers' => $mcpServers,
                // ALL available tools (including unused)
                'all_regular_tools' => $allAvailableRegularTools,
                'all_mcp_tools' => $allAvailableMcpTools,
                'by_provider' => array_map(function($p) {
                    return [
                        'provider' => $p['provider'],
                        'function_calls' => (int)$p['function_calls'],
                        'mcp_calls' => (int)$p['mcp_calls'],
                    ];
                }, $byProvider),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Load all registered MCP tools from the database
     * Returns array: tool_name => ['server_name' => ..., 'server_id' => ...]
     */
    private function loadRegisteredMCPTools(): array
    {
        $mcpTools = [];
        try {
            $stmt = $this->db->query("
                SELECT t.tool_name, s.name as server_name, s.id as server_id
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
            ");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($rows as $row) {
                // Store both with and without mcp_ prefix for lookup
                $toolName = $row['tool_name'];
                $mcpTools[$toolName] = [
                    'server_name' => $row['server_name'],
                    'server_id' => $row['server_id']
                ];
                // Also store with mcp_ prefix (as tools may be logged with prefix)
                $mcpTools['mcp_' . $toolName] = [
                    'server_name' => $row['server_name'],
                    'server_id' => $row['server_id']
                ];
            }
        } catch (\PDOException $e) {
            error_log("Failed to load MCP tools: " . $e->getMessage());
        }
        return $mcpTools;
    }

    /**
     * Check if a tool is MCP based on the registry
     * Returns server info array or null if not MCP
     */
    private function isMCPToolFromRegistry(string $toolName, array $mcpToolsRegistry): ?array
    {
        // Direct lookup
        if (isset($mcpToolsRegistry[$toolName])) {
            return $mcpToolsRegistry[$toolName];
        }

        // Try with mcp_ prefix
        if (isset($mcpToolsRegistry['mcp_' . $toolName])) {
            return $mcpToolsRegistry['mcp_' . $toolName];
        }

        // Try without mcp_ prefix if it has one
        if (str_starts_with($toolName, 'mcp_')) {
            $withoutPrefix = substr($toolName, 4);
            if (isset($mcpToolsRegistry[$withoutPrefix])) {
                return $mcpToolsRegistry[$withoutPrefix];
            }
        }

        return null;
    }

    /**
     * Load all available regular tools from claude_tools.json
     * Includes usage stats where available
     */
    private function loadAllAvailableRegularTools(array $usageStats): array
    {
        $tools = [];
        $toolsJsonPath = dirname(__DIR__) . '/../resources/claude_tools.json';

        if (!file_exists($toolsJsonPath)) {
            // Try alternate path
            $toolsJsonPath = dirname(__DIR__, 2) . '/resources/claude_tools.json';
        }

        if (file_exists($toolsJsonPath)) {
            $content = file_get_contents($toolsJsonPath);
            $toolDefinitions = json_decode($content, true) ?? [];

            foreach ($toolDefinitions as $tool) {
                $name = $tool['name'] ?? '';
                if (!$name) continue;

                $usage = $usageStats[$name] ?? null;
                $tools[] = [
                    'name' => $name,
                    'description' => $tool['description'] ?? '',
                    'count' => $usage ? $usage['count'] : 0,
                    'unique_users' => $usage ? count($usage['users']) : 0,
                    'last_used' => $usage ? $usage['last_used'] : null,
                    'is_mcp' => false,
                    'has_been_used' => $usage !== null
                ];
            }
        }

        // Sort: used tools first, then alphabetically
        usort($tools, function($a, $b) {
            if ($a['has_been_used'] !== $b['has_been_used']) {
                return $b['has_been_used'] <=> $a['has_been_used'];
            }
            if ($a['count'] !== $b['count']) {
                return $b['count'] <=> $a['count'];
            }
            return strcmp($a['name'], $b['name']);
        });

        return $tools;
    }

    /**
     * Load all available MCP tools from database
     * Includes usage stats where available
     */
    private function loadAllAvailableMCPTools(array $usageStats): array
    {
        $tools = [];

        try {
            $stmt = $this->db->query("
                SELECT t.tool_name, t.tool_description, s.name as server_name, s.url as server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                ORDER BY s.name, t.tool_name
            ");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($rows as $row) {
                $originalName = $row['tool_name'];
                $prefixedName = 'mcp_' . $originalName;

                // Check usage stats for both prefixed and non-prefixed names
                $usage = $usageStats[$prefixedName] ?? $usageStats[$originalName] ?? null;

                $tools[] = [
                    'name' => $prefixedName,
                    'original_name' => $originalName,
                    'description' => $row['tool_description'] ?? '',
                    'mcp_server' => $row['server_name'],
                    'server_url' => $row['server_url'],
                    'count' => $usage ? $usage['count'] : 0,
                    'unique_users' => $usage ? count($usage['users']) : 0,
                    'last_used' => $usage ? $usage['last_used'] : null,
                    'is_mcp' => true,
                    'has_been_used' => $usage !== null
                ];
            }
        } catch (\PDOException $e) {
            error_log("Failed to load MCP tools: " . $e->getMessage());
        }

        // Sort: used tools first, then by server name, then alphabetically
        usort($tools, function($a, $b) {
            if ($a['has_been_used'] !== $b['has_been_used']) {
                return $b['has_been_used'] <=> $a['has_been_used'];
            }
            if ($a['count'] !== $b['count']) {
                return $b['count'] <=> $a['count'];
            }
            $serverCmp = strcmp($a['mcp_server'], $b['mcp_server']);
            if ($serverCmp !== 0) return $serverCmp;
            return strcmp($a['name'], $b['name']);
        });

        return $tools;
    }

    /**
     * Helper: Get date range based on period
     */
    private function getDateRange(string $period, ?string $dateFrom = null, ?string $dateTo = null): array
    {
        if ($dateFrom && $dateTo) {
            return ['from' => $dateFrom, 'to' => $dateTo];
        }

        $to = date('Y-m-d 23:59:59');
        switch ($period) {
            case 'day':
                $from = date('Y-m-d 00:00:00');
                break;
            case 'week':
                $from = date('Y-m-d 00:00:00', strtotime('-7 days'));
                break;
            case 'month':
                $from = date('Y-m-d 00:00:00', strtotime('-30 days'));
                break;
            case 'year':
                $from = date('Y-m-d 00:00:00', strtotime('-365 days'));
                break;
            case 'all':
                $from = '2000-01-01 00:00:00';
                break;
            default:
                $from = date('Y-m-d 00:00:00', strtotime('-30 days'));
        }

        return ['from' => $from, 'to' => $to];
    }

    // ============================================
    // ADMIN MCP SERVER MANAGEMENT
    // ============================================

    /**
     * List all MCP servers (global servers available to all users)
     */
    public function listMCPServers(array $request): array
    {
        try {
            $this->ensureMCPSchema();

            $query = $request['query'] ?? [];
            $scope = $query['scope'] ?? 'all'; // all | global | user
            $filterUserId = isset($query['user_id']) && $query['user_id'] !== '' ? (string)$query['user_id'] : null;

            $where = '';
            $params = [];
            if ($scope === 'global') {
                $where = 'WHERE s.user_id IS NULL';
            } elseif ($scope === 'user' && $filterUserId !== null) {
                $where = 'WHERE s.user_id = ?';
                $params[] = $filterUserId;
            } elseif ($filterUserId !== null) {
                $where = 'WHERE s.user_id = ?';
                $params[] = $filterUserId;
            }

            $sql = "
                SELECT s.*, COUNT(t.id) as tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON s.id = t.server_id
                $where
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            ";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            $servers = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Build a map of user_id -> email for friendly display
            $userIds = array_values(array_unique(array_filter(array_map(fn($s) => $s['user_id'], $servers))));
            $userEmails = [];
            if (!empty($userIds)) {
                $placeholders = implode(',', array_fill(0, count($userIds), '?'));
                $ustmt = $this->db->prepare("SELECT id, email FROM users WHERE id IN ($placeholders)");
                $ustmt->execute($userIds);
                foreach ($ustmt->fetchAll(PDO::FETCH_ASSOC) as $u) {
                    $userEmails[(string)$u['id']] = $u['email'];
                }
            }

            return [
                'success' => true,
                'servers' => array_map(function($s) use ($userEmails) {
                    $headers = null;
                    if (!empty($s['headers'])) {
                        $decoded = json_decode($s['headers'], true);
                        if (is_array($decoded)) $headers = $decoded;
                    }
                    return [
                        'id' => (int)$s['id'],
                        'is_global' => $s['user_id'] === null,
                        'user_id' => $s['user_id'],
                        'user_email' => $s['user_id'] !== null ? ($userEmails[(string)$s['user_id']] ?? null) : null,
                        'name' => $s['name'],
                        'url' => $s['url'],
                        'description' => $s['description'],
                        'headers' => $headers,
                        'enabled' => (bool)$s['enabled'],
                        'tool_count' => (int)$s['tool_count'],
                        'created_at' => $s['created_at'],
                        'updated_at' => $s['updated_at'],
                    ];
                }, $servers),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Ensure MCP schema supports per-user scoping + custom headers (idempotent).
     */
    private function ensureMCPSchema(): void
    {
        try {
            // Drop the legacy unique index on `name` alone (if it still exists)
            $stmt = $this->db->query("
                SELECT COUNT(*) as c
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'mcp_servers'
                  AND index_name = 'unique_server_name'
            ");
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row && (int)$row['c'] > 0) {
                $this->db->exec("ALTER TABLE mcp_servers DROP INDEX unique_server_name");
            }

            // Add composite unique (user_id, name) if not present
            $stmt = $this->db->query("
                SELECT COUNT(*) as c
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'mcp_servers'
                  AND index_name = 'unique_scope_name'
            ");
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row || (int)$row['c'] === 0) {
                $this->db->exec("ALTER TABLE mcp_servers ADD UNIQUE KEY unique_scope_name (user_id, name)");
            }

            // Add `headers` JSON column if missing
            $stmt = $this->db->query("
                SELECT COUNT(*) as c
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'mcp_servers'
                  AND column_name = 'headers'
            ");
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row || (int)$row['c'] === 0) {
                $this->db->exec("ALTER TABLE mcp_servers ADD COLUMN headers JSON NULL AFTER description");
            }
        } catch (Exception $e) {
            error_log('[Admin] ensureMCPSchema warning: ' . $e->getMessage());
        }
    }

    /**
     * Normalize + validate headers input (object or JSON string) into a
     * "Header: value" string array. Returns [list, jsonToStore] or throws.
     * Empty/null -> [[], null].
     */
    private function normalizeMCPHeaders(mixed $raw): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return [[], null];
        }
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                throw new Exception('Headers must be a JSON object, e.g. {"Authorization":"Bearer ..."}');
            }
            $raw = $decoded;
        }
        if (!is_array($raw)) {
            throw new Exception('Headers must be a JSON object');
        }
        $list = [];
        foreach ($raw as $name => $value) {
            if (!is_string($name) || $name === '' || preg_match('/[\r\n:]/', $name)) {
                throw new Exception("Invalid header name: " . (string)$name);
            }
            if (!is_scalar($value)) {
                throw new Exception("Header '$name' value must be a string");
            }
            $strValue = (string)$value;
            if (preg_match('/[\r\n]/', $strValue)) {
                throw new Exception("Header '$name' contains invalid characters");
            }
            $list[] = $name . ': ' . $strValue;
        }
        return [$list, json_encode($raw)];
    }

    /**
     * Create a new MCP server (global - available to all users)
     */
    public function createMCPServer(array $request): array
    {
        try {
            $this->ensureMCPSchema();

            $input = $request['body'];

            $name = trim($input['name'] ?? '');
            $url = trim($input['url'] ?? '');
            $description = trim($input['description'] ?? '');
            // Optional scoping: if user_id is provided & non-empty, create a per-user server
            $rawUserId = $input['user_id'] ?? null;
            $userId = ($rawUserId === null || $rawUserId === '' || $rawUserId === 0 || $rawUserId === '0')
                ? null
                : (string)$rawUserId;

            if (!$name || !$url) {
                return [
                    'success' => false,
                    'error' => 'Name and URL are required',
                    'status_code' => 400
                ];
            }

            if (!filter_var($url, FILTER_VALIDATE_URL)) {
                return [
                    'success' => false,
                    'error' => 'Invalid URL format',
                    'status_code' => 400
                ];
            }

            // Check for duplicate within the same scope (global OR specific user)
            if ($userId === null) {
                $checkStmt = $this->db->prepare("SELECT id FROM mcp_servers WHERE user_id IS NULL AND name = ?");
                $checkStmt->execute([$name]);
            } else {
                $checkStmt = $this->db->prepare("SELECT id FROM mcp_servers WHERE user_id = ? AND name = ?");
                $checkStmt->execute([$userId, $name]);
            }
            if ($checkStmt->fetch()) {
                return [
                    'success' => false,
                    'error' => $userId === null
                        ? 'A global server with this name already exists'
                        : 'This user already has a server with this name',
                    'status_code' => 409
                ];
            }

            // Normalize headers
            try {
                [$headerList, $headersJson] = $this->normalizeMCPHeaders($input['headers'] ?? null);
            } catch (Exception $e) {
                return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
            }

            $stmt = $this->db->prepare("
                INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled)
                VALUES (?, ?, ?, ?, ?, 1)
            ");
            $stmt->execute([$userId, $name, $url, $description, $headersJson]);

            $serverId = $this->db->lastInsertId();

            // Try to fetch tools from the server
            $toolsResult = $this->fetchMCPServerTools((int)$serverId, $url, $headerList);

            return [
                'success' => true,
                'server_id' => (int)$serverId,
                'tools_fetched' => $toolsResult['count'] ?? 0,
                'tools_error' => $toolsResult['error'] ?? null,
                'message' => 'MCP server created successfully',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Update an MCP server
     */
    public function updateMCPServer(array $request): array
    {
        try {
            $input = $request['body'];

            $serverId = (int)($input['server_id'] ?? 0);
            $name = trim($input['name'] ?? '');
            $url = trim($input['url'] ?? '');
            $description = trim($input['description'] ?? '');

            if (!$serverId) {
                return [
                    'success' => false,
                    'error' => 'Server ID is required',
                    'status_code' => 400
                ];
            }

            if (!$name || !$url) {
                return [
                    'success' => false,
                    'error' => 'Name and URL are required',
                    'status_code' => 400
                ];
            }

            $this->ensureMCPSchema();

            // Normalize headers
            try {
                [$headerList, $headersJson] = $this->normalizeMCPHeaders($input['headers'] ?? null);
            } catch (Exception $e) {
                return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
            }

            // Check if URL or headers changed
            $checkStmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ?");
            $checkStmt->execute([$serverId]);
            $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);

            if (!$existing) {
                return [
                    'success' => false,
                    'error' => 'Server not found',
                    'status_code' => 404
                ];
            }

            $urlChanged = $existing['url'] !== $url;
            $headersChanged = ($existing['headers'] ?? null) !== $headersJson;

            $stmt = $this->db->prepare("
                UPDATE mcp_servers SET name = ?, url = ?, description = ?, headers = ?, updated_at = NOW()
                WHERE id = ?
            ");
            $stmt->execute([$name, $url, $description, $headersJson, $serverId]);

            // If URL or headers changed, clear and re-fetch tools
            $toolsFetched = 0;
            $toolsError = null;
            if ($urlChanged || $headersChanged) {
                $this->db->prepare("DELETE FROM mcp_server_tools WHERE server_id = ?")->execute([$serverId]);
                $toolsResult = $this->fetchMCPServerTools($serverId, $url, $headerList);
                $toolsFetched = $toolsResult['count'] ?? 0;
                $toolsError = $toolsResult['error'] ?? null;
            }

            return [
                'success' => true,
                'tools_fetched' => $toolsFetched,
                'tools_error' => $toolsError,
                'message' => 'MCP server updated successfully',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Toggle MCP server enabled/disabled
     */
    public function toggleMCPServer(array $request): array
    {
        try {
            $input = $request['body'];

            $serverId = (int)($input['server_id'] ?? 0);
            $enabled = (bool)($input['enabled'] ?? true);

            if (!$serverId) {
                return [
                    'success' => false,
                    'error' => 'Server ID is required',
                    'status_code' => 400
                ];
            }

            $stmt = $this->db->prepare("
                UPDATE mcp_servers SET enabled = ?, updated_at = NOW() WHERE id = ?
            ");
            $stmt->execute([$enabled ? 1 : 0, $serverId]);

            if ($stmt->rowCount() === 0) {
                return [
                    'success' => false,
                    'error' => 'Server not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'message' => $enabled ? 'Server enabled' : 'Server disabled',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Delete an MCP server
     */
    public function deleteMCPServer(array $request, int $serverId): array
    {
        try {
            if (!$serverId) {
                return [
                    'success' => false,
                    'error' => 'Server ID is required',
                    'status_code' => 400
                ];
            }

            // Get server info before deleting
            $stmt = $this->db->prepare("SELECT name FROM mcp_servers WHERE id = ?");
            $stmt->execute([$serverId]);
            $server = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$server) {
                return [
                    'success' => false,
                    'error' => 'Server not found',
                    'status_code' => 404
                ];
            }

            // Delete server (tools will be deleted via cascade)
            $stmt = $this->db->prepare("DELETE FROM mcp_servers WHERE id = ?");
            $stmt->execute([$serverId]);

            return [
                'success' => true,
                'message' => "Server '{$server['name']}' deleted successfully",
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Refresh tools for an MCP server
     */
    public function refreshMCPServerTools(array $request): array
    {
        try {
            $input = $request['body'];
            $serverId = (int)($input['server_id'] ?? 0);

            if (!$serverId) {
                return [
                    'success' => false,
                    'error' => 'Server ID is required',
                    'status_code' => 400
                ];
            }

            // Get server URL + headers
            $stmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ?");
            $stmt->execute([$serverId]);
            $server = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$server) {
                return [
                    'success' => false,
                    'error' => 'Server not found',
                    'status_code' => 404
                ];
            }

            [$headerList] = $this->normalizeMCPHeaders($server['headers'] ?? null);

            // Clear existing tools
            $this->db->prepare("DELETE FROM mcp_server_tools WHERE server_id = ?")->execute([$serverId]);

            // Fetch new tools
            $result = $this->fetchMCPServerTools($serverId, $server['url'], $headerList);

            return [
                'success' => true,
                'tools_fetched' => $result['count'] ?? 0,
                'tools_error' => $result['error'] ?? null,
                'tools' => $result['tools'] ?? [],
                'message' => 'Tools refreshed successfully',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    // ============================================
    // PER-USER MCP OVERRIDES (Cascade: package → admin override → user pref)
    // ============================================

    /**
     * Return the merged "effective MCP servers" view for one user, used by the
     * gpt_admin per-user MCP panel. For each server the admin can see:
     *   - package_default — what the user's role package would allow (null = no
     *     allowlist restriction)
     *   - override        — admin's per-user override (true/false/null)
     *   - effective       — the resolved enabled state (override wins; falls
     *     back to package_default; user-private servers always pass)
     *
     * GET /api/v1/admin/users/{id}/mcp-servers
     */
    public function getUserMCPServers(array $request, int $userId): array
    {
        try {
            // 1. Resolve the user's package allowlist.
            $resolver = new PackageResolver($this->db);
            $packageAllowlist = $resolver->allowedMcpServers($userId); // null = allow all

            // 2. Pull every server visible to this user: globals + their private ones.
            $sql = "
                SELECT s.id, s.name, s.url, s.description, s.user_id, s.enabled,
                       COUNT(t.id) AS tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON t.server_id = s.id
                WHERE s.user_id IS NULL OR s.user_id = :uid
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            ";
            $stmt = $this->db->prepare($sql);
            $stmt->bindValue(':uid', (string)$userId);
            $stmt->execute();
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // 3. Pull the user's overrides.
            $stmt = $this->db->prepare("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?");
            $stmt->execute([$userId]);
            $overrides = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $overrides[(int)$row['server_id']] = (bool)$row['allowed'];
            }

            // 4. Merge into the effective view.
            $servers = array_map(function (array $row) use ($packageAllowlist, $overrides) {
                $serverId  = (int)$row['id'];
                $isGlobal  = $row['user_id'] === null;
                $isPrivate = !$isGlobal;

                // Package default: user-private servers always pass; globals pass
                // when the package allowlist is null OR contains the server name.
                $packageDefault = $isPrivate
                    || $packageAllowlist === null
                    || in_array($row['name'], $packageAllowlist, true);

                $override  = array_key_exists($serverId, $overrides) ? $overrides[$serverId] : null;
                $effective = $override !== null ? $override : $packageDefault;

                return [
                    'id'              => $serverId,
                    'name'            => $row['name'],
                    'url'             => $row['url'],
                    'description'     => $row['description'],
                    'is_global'       => $isGlobal,
                    'is_user_private' => $isPrivate,
                    'enabled'         => (bool)$row['enabled'],
                    'tool_count'      => (int)$row['tool_count'],
                    'package_default' => $packageDefault,
                    'override'        => $override,
                    'effective'       => (bool)$effective,
                ];
            }, $rows);

            return [
                'success'           => true,
                'user_id'           => $userId,
                'package_allowlist' => $packageAllowlist, // null = unrestricted
                'servers'           => $servers,
                'status_code'       => 200,
            ];
        } catch (Exception $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    /**
     * Set or update the per-user override for one MCP server.
     *   PUT /api/v1/admin/users/{id}/mcp-servers/{serverId}/override
     *   body: { "allowed": true|false }
     *
     * Use the DELETE counterpart (clearUserMCPOverride) to revert to package default.
     */
    public function setUserMCPOverride(array $request, int $userId, int $serverId): array
    {
        try {
            $body = $request['body'] ?? [];
            if (!array_key_exists('allowed', $body)) {
                return ['success' => false, 'error' => 'Field "allowed" is required (boolean).', 'status_code' => 400];
            }
            $allowed = (bool)$body['allowed'];

            // Sanity-check both FKs exist before writing.
            $stmt = $this->db->prepare("SELECT 1 FROM users WHERE id = ?");
            $stmt->execute([$userId]);
            if (!$stmt->fetch()) {
                return ['success' => false, 'error' => 'User not found', 'status_code' => 404];
            }
            $stmt = $this->db->prepare("SELECT 1 FROM mcp_servers WHERE id = ?");
            $stmt->execute([$serverId]);
            if (!$stmt->fetch()) {
                return ['success' => false, 'error' => 'MCP server not found', 'status_code' => 404];
            }

            // Upsert. The unique key (user_id, server_id) makes this safe.
            $stmt = $this->db->prepare("
                INSERT INTO user_mcp_overrides (user_id, server_id, allowed)
                VALUES (:uid, :sid, :allowed)
                ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), updated_at = CURRENT_TIMESTAMP
            ");
            $stmt->execute([':uid' => $userId, ':sid' => $serverId, ':allowed' => $allowed ? 1 : 0]);

            return [
                'success'    => true,
                'user_id'    => $userId,
                'server_id'  => $serverId,
                'allowed'    => $allowed,
                'status_code' => 200,
            ];
        } catch (Exception $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    /**
     * Remove the per-user override for one MCP server, reverting to the
     * package default for that user/server pair.
     *   DELETE /api/v1/admin/users/{id}/mcp-servers/{serverId}/override
     */
    public function clearUserMCPOverride(array $request, int $userId, int $serverId): array
    {
        try {
            $stmt = $this->db->prepare("DELETE FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?");
            $stmt->execute([$userId, $serverId]);
            return [
                'success'    => true,
                'user_id'    => $userId,
                'server_id'  => $serverId,
                'cleared'    => $stmt->rowCount() > 0,
                'status_code' => 200,
            ];
        } catch (Exception $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    // ============================================
    // COSTS MANAGEMENT (Provider Pricing + Usage Costs)
    // ============================================

    /**
     * Get stored costs data including provider pricing and usage costs
     */
    public function getCosts(array $request): array
    {
        try {
            $this->ensureCostsTableExists();

            // Get stored pricing data
            $stmt = $this->db->query("SELECT * FROM provider_costs ORDER BY category, provider");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Organize by category
            $costs = [
                'llm' => [],
                'voice' => [],
                'avatar' => [],
                'lastRefreshed' => null
            ];

            foreach ($rows as $row) {
                $tiers = json_decode($row['tiers'], true) ?? [];
                $costs[$row['category']][] = [
                    'provider' => $row['provider'],
                    'displayName' => $row['display_name'],
                    'category' => $row['category'],
                    'tiers' => $tiers,
                    'pricingUrl' => $row['pricing_url'],
                    'lastUpdated' => $row['updated_at'],
                    'notes' => $row['notes']
                ];
                // Track latest update
                if (!$costs['lastRefreshed'] || $row['updated_at'] > $costs['lastRefreshed']) {
                    $costs['lastRefreshed'] = $row['updated_at'];
                }
            }

            // If no stored data, return defaults
            if (empty($costs['llm']) && empty($costs['voice']) && empty($costs['avatar'])) {
                $costs = $this->getDefaultCosts();
            }

            // Get usage costs breakdown
            $usageCosts = $this->getUsageCostsBreakdown();

            return [
                'success' => true,
                'costs' => $costs,
                'usageCosts' => $usageCosts,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Refresh all provider costs using LLM to parse pricing pages
     */
    public function refreshAllCosts(array $request): array
    {
        try {
            $this->ensureCostsTableExists();

            $allCosts = $this->getDefaultCosts();
            $updated = 0;
            $errors = [];

            // Process each category
            foreach (['llm', 'voice', 'avatar'] as $category) {
                foreach ($allCosts[$category] as $provider) {
                    try {
                        $updatedProvider = $this->fetchProviderPricing($provider);
                        if ($updatedProvider) {
                            $this->saveProviderCosts($category, $updatedProvider);
                            $updated++;
                        }
                    } catch (Exception $e) {
                        $errors[] = "{$provider['provider']}: {$e->getMessage()}";
                    }
                }
            }

            // Reload stored costs
            $stmt = $this->db->query("SELECT * FROM provider_costs ORDER BY category, provider");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $costs = [
                'llm' => [],
                'voice' => [],
                'avatar' => [],
                'lastRefreshed' => date('Y-m-d H:i:s')
            ];

            foreach ($rows as $row) {
                $tiers = json_decode($row['tiers'], true) ?? [];
                $costs[$row['category']][] = [
                    'provider' => $row['provider'],
                    'displayName' => $row['display_name'],
                    'category' => $row['category'],
                    'tiers' => $tiers,
                    'pricingUrl' => $row['pricing_url'],
                    'lastUpdated' => $row['updated_at'],
                    'notes' => $row['notes']
                ];
            }

            // Get usage costs
            $usageCosts = $this->getUsageCostsBreakdown();

            return [
                'success' => true,
                'costs' => $costs,
                'usageCosts' => $usageCosts,
                'updated_count' => $updated,
                'errors' => $errors,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Refresh costs for a single provider
     */
    public function refreshProviderCosts(array $request): array
    {
        try {
            $input = $request['body'];
            $category = $input['category'] ?? '';
            $providerName = $input['provider'] ?? '';

            if (!in_array($category, ['llm', 'voice', 'avatar'])) {
                return [
                    'success' => false,
                    'error' => 'Invalid category',
                    'status_code' => 400
                ];
            }

            if (empty($providerName)) {
                return [
                    'success' => false,
                    'error' => 'Provider is required',
                    'status_code' => 400
                ];
            }

            $this->ensureCostsTableExists();

            // Find the provider in defaults
            $allCosts = $this->getDefaultCosts();
            $providerData = null;

            foreach ($allCosts[$category] as $p) {
                if ($p['provider'] === $providerName) {
                    $providerData = $p;
                    break;
                }
            }

            if (!$providerData) {
                return [
                    'success' => false,
                    'error' => 'Provider not found',
                    'status_code' => 404
                ];
            }

            // Fetch and update pricing
            $updatedProvider = $this->fetchProviderPricing($providerData);
            if ($updatedProvider) {
                $this->saveProviderCosts($category, $updatedProvider);
            }

            // Reload provider data
            $stmt = $this->db->prepare("SELECT * FROM provider_costs WHERE category = ? AND provider = ?");
            $stmt->execute([$category, $providerName]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            if ($row) {
                $provider = [
                    'provider' => $row['provider'],
                    'displayName' => $row['display_name'],
                    'category' => $row['category'],
                    'tiers' => json_decode($row['tiers'], true) ?? [],
                    'pricingUrl' => $row['pricing_url'],
                    'lastUpdated' => $row['updated_at'],
                    'notes' => $row['notes']
                ];
            } else {
                $provider = $providerData;
                $provider['lastUpdated'] = date('Y-m-d H:i:s');
            }

            return [
                'success' => true,
                'provider' => $provider,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Public endpoint: get per-user usage costs breakdown (last 30 days).
     * Same shape as the global breakdown, filtered by user_id.
     */
    public function getUserCosts(array $request, int $userId): array
    {
        if ($userId <= 0) {
            return [
                'success' => false,
                'error' => 'Invalid user ID',
                'status_code' => 400,
            ];
        }

        try {
            $usageCosts = $this->getUsageCostsBreakdown($userId);
            return [
                'success' => true,
                'user_id' => $userId,
                'usageCosts' => $usageCosts,
                'status_code' => 200,
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to fetch user costs: ' . $e->getMessage(),
                'status_code' => 500,
            ];
        }
    }

    /**
     * Get usage costs breakdown by category (LLM, Voice, Avatar).
     * When $userId is provided, all aggregates are scoped to that user.
     */
    private function getUsageCostsBreakdown(?int $userId = null): array
    {
        $userClause = $userId !== null ? " AND t.user_id = :uid" : "";
        $userClauseNoAlias = $userId !== null ? " AND user_id = :uid" : "";
        $bindUid = function ($stmt) use ($userId) {
            if ($userId !== null) {
                $stmt->bindValue(':uid', $userId, PDO::PARAM_INT);
            }
        };

        // Get LLM costs from usage transactions.
        // Cost is computed from tokens × CURRENT per-provider price: first
        // from system_llm_settings, then from hardcoded defaults below if
        // the DB row is missing prices. Update system_llm_settings (or this
        // fallback map) to refresh pricing — the breakdown re-computes on
        // every query.
        $llmSql = "SELECT
            t.provider,
            COUNT(*) AS total_requests,
            COALESCE(SUM(t.prompt_tokens), 0) AS tokens_in,
            COALESCE(SUM(t.completion_tokens), 0) AS tokens_out,
            COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
            COALESCE(SUM(t.cost_usd), 0) AS stored_cost_total,
            s.price_input_per_1m AS price_in,
            s.price_output_per_1m AS price_out,
            MAX(t.created_at) AS last_used
        FROM llm_usage_transactions t
        LEFT JOIN system_llm_settings s ON s.provider_key = t.provider
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)" . $userClause . "
        GROUP BY t.provider, s.price_input_per_1m, s.price_output_per_1m
        ORDER BY stored_cost_total DESC";

        $stmt = $this->db->prepare($llmSql);
        $bindUid($stmt);
        $stmt->execute();
        $llmCostsRaw = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Fallback pricing when a provider has no row (or null prices) in
        // system_llm_settings. Keep in sync with SystemSettingsController::PRICE_DEFAULTS.
        $priceFallbacks = [
            'claude'   => [3.00, 15.00],
            'openai'   => [2.50, 10.00],
            'gemini'   => [0.30, 2.50],
            'grok'     => [0.20, 0.50],
            'deepseek' => [0.28, 0.42],
            'kimi'     => [0.55, 2.20],
        ];
        $llmCosts = [];
        foreach ($llmCostsRaw as $row) {
            $fb = $priceFallbacks[$row['provider']] ?? [null, null];
            $priceIn = $row['price_in'] !== null ? (float)$row['price_in'] : $fb[0];
            $priceOut = $row['price_out'] !== null ? (float)$row['price_out'] : $fb[1];
            $row['resolved_price_in'] = $priceIn;
            $row['resolved_price_out'] = $priceOut;
            $row['cost_in'] = $priceIn !== null ? ((int)$row['tokens_in']) * $priceIn / 1_000_000 : null;
            $row['cost_out'] = $priceOut !== null ? ((int)$row['tokens_out']) * $priceOut / 1_000_000 : null;
            $llmCosts[] = $row;
        }
        // Sort by computed total (in + out), falling back to stored cost when prices unknown.
        usort($llmCosts, function ($a, $b) {
            $ta = ($a['cost_in'] ?? 0) + ($a['cost_out'] ?? 0);
            $tb = ($b['cost_in'] ?? 0) + ($b['cost_out'] ?? 0);
            if ($ta === 0.0 && $tb === 0.0) {
                return ((float)$b['stored_cost_total']) <=> ((float)$a['stored_cost_total']);
            }
            return $tb <=> $ta;
        });

        // Get Voice costs (from is_voice_request transactions)
        $voiceSql = "SELECT
            provider,
            COUNT(*) as total_requests,
            COALESCE(SUM(audio_duration_seconds), 0) as total_seconds,
            COALESCE(SUM(cost_usd), 0) as total_cost,
            MAX(created_at) as last_used
        FROM llm_usage_transactions
        WHERE is_voice_request = 1
            AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)" . $userClauseNoAlias . "
        GROUP BY provider
        ORDER BY total_cost DESC";

        $stmt = $this->db->prepare($voiceSql);
        $bindUid($stmt);
        $stmt->execute();
        $voiceCosts = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Get totals for each period (day, week, month)
        $totalsWhere = $userId !== null ? " WHERE user_id = :uid" : "";
        $totalsSql = "SELECT
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as cost_today,
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as cost_week,
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as cost_month,
            SUM(cost_usd) as cost_total,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as voice_cost_today,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as voice_cost_week,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as voice_cost_month,
            SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost_total
        FROM llm_usage_transactions" . $totalsWhere;

        $stmt = $this->db->prepare($totalsSql);
        $bindUid($stmt);
        $stmt->execute();
        $totals = $stmt->fetch(PDO::FETCH_ASSOC);

        return [
            'llm' => [
                'byProvider' => array_map(function($p) {
                    $costIn = $p['cost_in'];
                    $costOut = $p['cost_out'];
                    // Total: prefer computed in+out; if either is unknown (no
                    // price available), fall back to the historical stored cost
                    // so we never show 0.
                    if ($costIn !== null && $costOut !== null) {
                        $total = $costIn + $costOut;
                    } else {
                        $total = (float)$p['stored_cost_total'];
                    }
                    return [
                        'provider' => $p['provider'],
                        'requests' => (int)$p['total_requests'],
                        'tokensIn' => (int)$p['tokens_in'],
                        'tokensOut' => (int)$p['tokens_out'],
                        'tokens' => (int)$p['total_tokens'],
                        'priceIn' => $p['resolved_price_in'],
                        'priceOut' => $p['resolved_price_out'],
                        'costIn' => $costIn !== null ? round($costIn, 4) : null,
                        'costOut' => $costOut !== null ? round($costOut, 4) : null,
                        'cost' => round($total, 4),
                        'storedCost' => round((float)$p['stored_cost_total'], 4),
                        'lastUsed' => $p['last_used']
                    ];
                }, $llmCosts),
                'totals' => [
                    'today' => round((float)($totals['cost_today'] ?? 0), 4),
                    'week' => round((float)($totals['cost_week'] ?? 0), 4),
                    'month' => round((float)($totals['cost_month'] ?? 0), 4),
                    'total' => round((float)($totals['cost_total'] ?? 0), 4)
                ]
            ],
            'voice' => [
                'byProvider' => array_map(function($p) {
                    return [
                        'provider' => $p['provider'],
                        'requests' => (int)$p['total_requests'],
                        'seconds' => round((float)$p['total_seconds'], 2),
                        'cost' => round((float)$p['total_cost'], 4),
                        'lastUsed' => $p['last_used']
                    ];
                }, $voiceCosts),
                'totals' => [
                    'today' => round((float)($totals['voice_cost_today'] ?? 0), 4),
                    'week' => round((float)($totals['voice_cost_week'] ?? 0), 4),
                    'month' => round((float)($totals['voice_cost_month'] ?? 0), 4),
                    'total' => round((float)($totals['voice_cost_total'] ?? 0), 4)
                ]
            ],
            'avatar' => [
                'byProvider' => [], // Avatar costs would come from a separate tracking table if implemented
                'totals' => [
                    'today' => 0,
                    'week' => 0,
                    'month' => 0,
                    'total' => 0
                ],
                'note' => 'Avatar usage costs are tracked separately if avatar provider integrations are active'
            ]
        ];
    }

    /**
     * Fetch pricing from a provider's website using Claude
     */
    private function fetchProviderPricing(array $provider): ?array
    {
        // For now, return the default data with updated timestamp
        // In production, this would use an LLM to parse the pricing page
        $provider['lastUpdated'] = date('Y-m-d H:i:s');

        // Try to fetch current pricing using Claude API
        try {
            $apiKey = $this->getAdminApiKey('claude');
            if ($apiKey) {
                $updatedTiers = $this->fetchPricingWithClaude($provider['pricingUrl'], $provider['displayName'], $apiKey);
                if ($updatedTiers && !empty($updatedTiers)) {
                    $provider['tiers'] = $updatedTiers;
                }
            }
        } catch (Exception $e) {
            error_log("Failed to fetch pricing for {$provider['provider']}: " . $e->getMessage());
            // Keep default tiers on failure
        }

        return $provider;
    }

    /**
     * Use Claude to fetch and parse pricing from a URL
     */
    private function fetchPricingWithClaude(string $url, string $providerName, string $apiKey): ?array
    {
        // Fetch the webpage content first
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        ]);
        $html = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200 || !$html) {
            error_log("Failed to fetch pricing page for {$providerName}: HTTP {$httpCode}");
            return null;
        }

        // Extract text content (strip tags but keep structure hints)
        $text = strip_tags(str_replace(['<br>', '</div>', '</p>', '</li>'], "\n", $html));
        $text = preg_replace('/\s+/', ' ', $text);
        $text = substr($text, 0, 15000); // Limit context size

        // Call Claude to extract pricing
        $prompt = "Extract the current API pricing information for {$providerName} from this webpage content.

Return ONLY a JSON array of pricing tiers in this exact format:
[
  {\"name\": \"Model or Plan Name\", \"price\": \"\$X.XX\", \"unit\": \"per unit (e.g., / 1M tokens, / month)\", \"details\": \"optional additional info\"}
]

Focus on API/developer pricing, not consumer subscription plans unless that's all available.
Include input/output token prices separately if available.

Webpage content:
{$text}

Return ONLY the JSON array, no explanation or markdown.";

        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'x-api-key: ' . $apiKey,
                'anthropic-version: 2023-06-01'
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'model' => 'claude-3-5-haiku-20241022',
                'max_tokens' => 2048,
                'messages' => [
                    ['role' => 'user', 'content' => $prompt]
                ]
            ]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 60
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200) {
            error_log("Claude API call failed for {$providerName}: HTTP {$httpCode}");
            return null;
        }

        $data = json_decode($response, true);
        $content = $data['content'][0]['text'] ?? '';

        // Parse the JSON response
        $content = trim($content);
        // Remove markdown code blocks if present
        $content = preg_replace('/^```json?\s*/', '', $content);
        $content = preg_replace('/\s*```$/', '', $content);

        $tiers = json_decode($content, true);

        if (!is_array($tiers) || empty($tiers)) {
            error_log("Failed to parse Claude response for {$providerName}: " . substr($content, 0, 200));
            return null;
        }

        return $tiers;
    }

    /**
     * Get admin's API key for a provider
     */
    private function getAdminApiKey(string $provider): ?string
    {
        try {
            // First try from environment/config
            $configKey = strtoupper($provider) . '_API_KEY';
            if (isset($this->config[$configKey])) {
                return $this->config[$configKey];
            }

            // Then try from admin user's keys (user_id = 1 typically)
            $stmt = $this->db->prepare("SELECT api_key FROM user_api_keys WHERE provider = ? AND user_id = 1");
            $stmt->execute([$provider]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            return $row['api_key'] ?? null;
        } catch (Exception $e) {
            return null;
        }
    }

    /**
     * Save provider costs to database
     */
    private function saveProviderCosts(string $category, array $provider): void
    {
        $stmt = $this->db->prepare("
            INSERT INTO provider_costs (category, provider, display_name, tiers, pricing_url, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                tiers = VALUES(tiers),
                pricing_url = VALUES(pricing_url),
                notes = VALUES(notes),
                updated_at = NOW()
        ");

        $stmt->execute([
            $category,
            $provider['provider'],
            $provider['displayName'],
            json_encode($provider['tiers']),
            $provider['pricingUrl'],
            $provider['notes'] ?? null
        ]);
    }

    /**
     * Ensure provider_costs table exists
     */
    private function ensureCostsTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `provider_costs` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `category` ENUM('llm', 'voice', 'avatar') NOT NULL,
            `provider` VARCHAR(50) NOT NULL,
            `display_name` VARCHAR(100) NOT NULL,
            `tiers` JSON NOT NULL,
            `pricing_url` VARCHAR(255) DEFAULT NULL,
            `notes` TEXT DEFAULT NULL,
            `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `unique_category_provider` (`category`, `provider`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        $this->db->exec($sql);
    }

    // ============================================
    // EXCHANGE RATES
    // ============================================

    /**
     * Get current exchange rates (USD to EUR, CAD)
     */
    public function getExchangeRates(array $request): array
    {
        try {
            $this->ensureExchangeRatesTableExists();

            $stmt = $this->db->query("SELECT * FROM exchange_rates ORDER BY currency");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $rates = [
                'USD' => 1.0,
                'EUR' => 0.92,
                'CAD' => 1.36
            ];
            $lastUpdated = null;

            foreach ($rows as $row) {
                $rates[$row['currency']] = (float)$row['rate'];
                if (!$lastUpdated || $row['updated_at'] > $lastUpdated) {
                    $lastUpdated = $row['updated_at'];
                }
            }

            return [
                'success' => true,
                'rates' => $rates,
                'baseCurrency' => 'USD',
                'lastUpdated' => $lastUpdated,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Refresh exchange rates from external API
     */
    public function refreshExchangeRates(array $request): array
    {
        try {
            $this->ensureExchangeRatesTableExists();

            // Fetch rates from exchangerate-api.com (free tier)
            $rates = $this->fetchExchangeRatesFromApi();

            if (!$rates) {
                return [
                    'success' => false,
                    'error' => 'Failed to fetch exchange rates',
                    'status_code' => 500
                ];
            }

            // Save rates to database
            foreach (['EUR', 'CAD'] as $currency) {
                if (isset($rates[$currency])) {
                    $stmt = $this->db->prepare("
                        INSERT INTO exchange_rates (currency, rate, updated_at)
                        VALUES (?, ?, NOW())
                        ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()
                    ");
                    $stmt->execute([$currency, $rates[$currency]]);
                }
            }

            return [
                'success' => true,
                'rates' => array_merge(['USD' => 1.0], $rates),
                'baseCurrency' => 'USD',
                'lastUpdated' => date('Y-m-d H:i:s'),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Fetch exchange rates from external API
     */
    private function fetchExchangeRatesFromApi(): ?array
    {
        // Try multiple free exchange rate APIs
        $apis = [
            // exchangerate-api.com free tier
            'https://api.exchangerate-api.com/v4/latest/USD',
            // Alternative: frankfurter.app (European Central Bank data)
            'https://api.frankfurter.app/latest?from=USD&to=EUR,CAD'
        ];

        foreach ($apis as $apiUrl) {
            try {
                $ch = curl_init($apiUrl);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 10,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_USERAGENT => 'GPT-Admin/1.0'
                ]);
                $response = curl_exec($ch);
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);

                if ($httpCode === 200 && $response) {
                    $data = json_decode($response, true);

                    // Handle exchangerate-api.com format
                    if (isset($data['rates'])) {
                        return [
                            'EUR' => $data['rates']['EUR'] ?? 0.92,
                            'CAD' => $data['rates']['CAD'] ?? 1.36
                        ];
                    }

                    // Handle frankfurter.app format
                    if (isset($data['rates'])) {
                        return $data['rates'];
                    }
                }
            } catch (Exception $e) {
                error_log("Failed to fetch exchange rates from {$apiUrl}: " . $e->getMessage());
                continue;
            }
        }

        // Return default rates if all APIs fail
        return [
            'EUR' => 0.92,
            'CAD' => 1.36
        ];
    }

    /**
     * Ensure exchange_rates table exists
     */
    private function ensureExchangeRatesTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `exchange_rates` (
            `currency` VARCHAR(3) NOT NULL,
            `rate` DECIMAL(10, 6) NOT NULL,
            `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`currency`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
        $this->db->exec($sql);
    }

    /**
     * Get default costs structure
     */
    private function getDefaultCosts(): array
    {
        return [
            'llm' => [
                [
                    'provider' => 'claude',
                    'displayName' => 'Claude (Anthropic)',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'Claude 3.5 Sonnet', 'price' => '$3.00', 'unit' => '/ 1M input tokens', 'details' => '$15.00 / 1M output tokens'],
                        ['name' => 'Claude 3.5 Haiku', 'price' => '$0.80', 'unit' => '/ 1M input tokens', 'details' => '$4.00 / 1M output tokens'],
                        ['name' => 'Claude 3 Opus', 'price' => '$15.00', 'unit' => '/ 1M input tokens', 'details' => '$75.00 / 1M output tokens'],
                    ],
                    'pricingUrl' => 'https://www.anthropic.com/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'openai',
                    'displayName' => 'OpenAI',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'GPT-4o', 'price' => '$2.50', 'unit' => '/ 1M input tokens', 'details' => '$10.00 / 1M output tokens'],
                        ['name' => 'GPT-4o mini', 'price' => '$0.15', 'unit' => '/ 1M input tokens', 'details' => '$0.60 / 1M output tokens'],
                        ['name' => 'GPT-4 Turbo', 'price' => '$10.00', 'unit' => '/ 1M input tokens', 'details' => '$30.00 / 1M output tokens'],
                    ],
                    'pricingUrl' => 'https://openai.com/api/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'gemini',
                    'displayName' => 'Gemini (Google)',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'Gemini 1.5 Pro', 'price' => '$1.25', 'unit' => '/ 1M input tokens', 'details' => '$5.00 / 1M output tokens'],
                        ['name' => 'Gemini 1.5 Flash', 'price' => '$0.075', 'unit' => '/ 1M input tokens', 'details' => '$0.30 / 1M output tokens'],
                        ['name' => 'Gemini 2.0 Flash', 'price' => '$0.10', 'unit' => '/ 1M input tokens', 'details' => '$0.40 / 1M output tokens'],
                    ],
                    'pricingUrl' => 'https://ai.google.dev/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'grok',
                    'displayName' => 'Grok (xAI)',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'Grok-2', 'price' => '$2.00', 'unit' => '/ 1M input tokens', 'details' => '$10.00 / 1M output tokens'],
                        ['name' => 'Grok-2 mini', 'price' => '$0.20', 'unit' => '/ 1M input tokens', 'details' => '$1.00 / 1M output tokens'],
                    ],
                    'pricingUrl' => 'https://x.ai/api',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'deepseek',
                    'displayName' => 'DeepSeek',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'DeepSeek-V3', 'price' => '$0.27', 'unit' => '/ 1M input tokens', 'details' => '$1.10 / 1M output tokens'],
                        ['name' => 'DeepSeek-R1', 'price' => '$0.55', 'unit' => '/ 1M input tokens', 'details' => '$2.19 / 1M output tokens'],
                    ],
                    'pricingUrl' => 'https://platform.deepseek.com/api-docs/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'kimi',
                    'displayName' => 'Kimi (Moonshot)',
                    'category' => 'llm',
                    'tiers' => [
                        ['name' => 'Moonshot-v1-8k', 'price' => '$0.012', 'unit' => '/ 1K tokens'],
                        ['name' => 'Moonshot-v1-32k', 'price' => '$0.024', 'unit' => '/ 1K tokens'],
                        ['name' => 'Moonshot-v1-128k', 'price' => '$0.06', 'unit' => '/ 1K tokens'],
                    ],
                    'pricingUrl' => 'https://platform.moonshot.cn/docs/pricing',
                    'lastUpdated' => null
                ],
            ],
            'voice' => [
                [
                    'provider' => 'elevenlabs',
                    'displayName' => 'ElevenLabs',
                    'category' => 'voice',
                    'tiers' => [
                        ['name' => 'Free', 'price' => '$0', 'unit' => '/ month', 'details' => '10,000 characters/month'],
                        ['name' => 'Starter', 'price' => '$5', 'unit' => '/ month', 'details' => '30,000 characters/month'],
                        ['name' => 'Creator', 'price' => '$22', 'unit' => '/ month', 'details' => '100,000 characters/month'],
                        ['name' => 'Pro', 'price' => '$99', 'unit' => '/ month', 'details' => '500,000 characters/month'],
                    ],
                    'pricingUrl' => 'https://elevenlabs.io/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'hume',
                    'displayName' => 'Hume AI',
                    'category' => 'voice',
                    'tiers' => [
                        ['name' => 'EVI (Empathic Voice)', 'price' => '$0.07', 'unit' => '/ minute', 'details' => 'Real-time voice with emotion'],
                        ['name' => 'Expression Measurement', 'price' => '$0.0036', 'unit' => '/ API call'],
                    ],
                    'pricingUrl' => 'https://www.hume.ai/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'gemini',
                    'displayName' => 'Gemini Live (Google)',
                    'category' => 'voice',
                    'tiers' => [
                        ['name' => 'Gemini 2.0 Flash Live', 'price' => '$0.35', 'unit' => '/ 1M audio tokens input', 'details' => '$8.75 / 1M audio tokens output'],
                    ],
                    'pricingUrl' => 'https://ai.google.dev/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'grok',
                    'displayName' => 'Grok Voice (xAI)',
                    'category' => 'voice',
                    'tiers' => [
                        ['name' => 'Grok Voice Agent API', 'price' => '$0.05', 'unit' => '/ minute', 'details' => 'Real-time voice conversation'],
                        ['name' => 'Tool Invocations', 'price' => 'Additional', 'unit' => 'per call', 'details' => 'Web search, X search, function calls charged separately'],
                    ],
                    'pricingUrl' => 'https://docs.x.ai/developers/models',
                    'lastUpdated' => null
                ],
            ],
            'avatar' => [
                [
                    'provider' => 'did',
                    'displayName' => 'D-ID',
                    'category' => 'avatar',
                    'tiers' => [
                        ['name' => 'Free Trial', 'price' => '$0', 'unit' => '', 'details' => '5 minutes of video'],
                        ['name' => 'Lite', 'price' => '$5.90', 'unit' => '/ month', 'details' => '10 minutes/month'],
                        ['name' => 'Pro', 'price' => '$49', 'unit' => '/ month', 'details' => '15 minutes/month'],
                        ['name' => 'Advanced', 'price' => '$299', 'unit' => '/ month', 'details' => '65 minutes/month'],
                    ],
                    'pricingUrl' => 'https://www.d-id.com/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'heygen',
                    'displayName' => 'HeyGen',
                    'category' => 'avatar',
                    'tiers' => [
                        ['name' => 'Free', 'price' => '$0', 'unit' => '', 'details' => '1 credit (limited features)'],
                        ['name' => 'Creator', 'price' => '$24', 'unit' => '/ month', 'details' => '15 credits/month'],
                        ['name' => 'Business', 'price' => '$72', 'unit' => '/ month', 'details' => '30 credits/month'],
                        ['name' => 'Enterprise', 'price' => 'Custom', 'unit' => '', 'details' => 'Contact sales'],
                    ],
                    'pricingUrl' => 'https://www.heygen.com/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'tavus',
                    'displayName' => 'Tavus',
                    'category' => 'avatar',
                    'tiers' => [
                        ['name' => 'Starter', 'price' => '$39', 'unit' => '/ month', 'details' => '30 minutes/month'],
                        ['name' => 'Pro', 'price' => '$149', 'unit' => '/ month', 'details' => '120 minutes/month'],
                        ['name' => 'Enterprise', 'price' => 'Custom', 'unit' => '', 'details' => 'Contact sales'],
                    ],
                    'pricingUrl' => 'https://www.tavus.io/pricing',
                    'lastUpdated' => null
                ],
                [
                    'provider' => 'anam',
                    'displayName' => 'Anam AI',
                    'category' => 'avatar',
                    'tiers' => [
                        ['name' => 'API Access', 'price' => 'Contact', 'unit' => 'for pricing', 'details' => 'Real-time avatar streaming'],
                    ],
                    'pricingUrl' => 'https://www.anam.ai',
                    'lastUpdated' => null
                ],
            ],
            'lastRefreshed' => null
        ];
    }

    /**
     * Fetch tools from an MCP server and store them.
     *
     * Performs the full MCP handshake: initialize -> notifications/initialized -> tools/list,
     * preserves the Mcp-Session-Id across requests, and parses both JSON and SSE responses.
     */
    private function fetchMCPServerTools(int $serverId, string $serverUrl, array $extraHeaders = []): array
    {
        try {
            $mcpUrl = rtrim($serverUrl, '/');
            error_log("[Admin] fetchMCPServerTools: serverId={$serverId}, url={$mcpUrl}");

            $sessionId = null;

            // Step 1: initialize
            $initResult = $this->mcpHttpCall($mcpUrl, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'initialize',
                'params' => [
                    'protocolVersion' => '2024-11-05',
                    'clientInfo' => ['name' => 'GPT-Admin-MCP-Client', 'version' => '1.0.0'],
                    'capabilities' => new \stdClass(),
                ],
            ], $extraHeaders, $sessionId);
            if (!$initResult['ok']) {
                error_log("[Admin] fetchMCPServerTools initialize FAILED: " . $initResult['error']);
                return ['count' => 0, 'error' => 'initialize failed: ' . $initResult['error']];
            }
            if (isset($initResult['data']['error'])) {
                $msg = $initResult['data']['error']['message'] ?? 'server error';
                return ['count' => 0, 'error' => 'initialize error: ' . $msg];
            }

            // Step 2: notifications/initialized (no response body expected)
            $this->mcpHttpCall($mcpUrl, [
                'jsonrpc' => '2.0',
                'method' => 'notifications/initialized',
                'params' => new \stdClass(),
            ], $extraHeaders, $sessionId, false);

            // Step 3: tools/list
            $listResult = $this->mcpHttpCall($mcpUrl, [
                'jsonrpc' => '2.0',
                'id' => 2,
                'method' => 'tools/list',
                'params' => new \stdClass(),
            ], $extraHeaders, $sessionId);
            if (!$listResult['ok']) {
                error_log("[Admin] fetchMCPServerTools tools/list FAILED: " . $listResult['error']);
                return ['count' => 0, 'error' => 'tools/list failed: ' . $listResult['error']];
            }
            if (isset($listResult['data']['error'])) {
                $msg = $listResult['data']['error']['message'] ?? 'server error';
                return ['count' => 0, 'error' => 'tools/list error: ' . $msg];
            }

            // Re-decode as object to preserve {} in inputSchema
            $data = json_decode(json_encode($listResult['data']));
            $tools = $data->result->tools ?? [];

            error_log("[Admin] fetchMCPServerTools found " . count($tools) . " tools");

            if (empty($tools)) {
                return ['count' => 0, 'tools' => []];
            }

            // Insert tools into database
            $insertStmt = $this->db->prepare("
                INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE tool_description = VALUES(tool_description), input_schema = VALUES(input_schema), has_ui = VALUES(has_ui), ui_resource_uri = VALUES(ui_resource_uri)
            ");

            $toolNames = [];
            foreach ($tools as $tool) {
                $name = $tool->name ?? '';
                if (!$name) continue;

                $description = $tool->description ?? '';
                // Encode inputSchema preserving {} as objects (not [] arrays)
                $inputSchema = isset($tool->inputSchema) ? json_encode($tool->inputSchema) : '{"type":"object","properties":{}}';

                // Check for UI info in both _meta.ui (MCP Apps) and annotations (legacy)
                $hasUi = !empty($tool->_meta->ui) || !empty($tool->annotations->hasUI) ? 1 : 0;
                $uiResourceUri = $tool->_meta->ui->resourceUri ?? $tool->annotations->uiResourceUri ?? null;

                // Log which database we're using
                $dbInfo = $this->db->query("SELECT DATABASE() as db")->fetch(\PDO::FETCH_ASSOC);
                error_log("[Admin] Using database: " . ($dbInfo['db'] ?? 'unknown'));
                error_log("[Admin] Inserting tool: name={$name}, serverId={$serverId}, hasUi={$hasUi}");
                try {
                    $insertStmt->execute([
                        $serverId,
                        $name,
                        $description,
                        $inputSchema,
                        $hasUi,
                        $uiResourceUri
                    ]);
                    $rowCount = $insertStmt->rowCount();
                    error_log("[Admin] Tool inserted successfully: {$name}, rowCount={$rowCount}");

                    // Verify the insert
                    $verifyStmt = $this->db->prepare("SELECT id FROM mcp_server_tools WHERE server_id = ? AND tool_name = ?");
                    $verifyStmt->execute([$serverId, $name]);
                    $verified = $verifyStmt->fetch();
                    error_log("[Admin] Verify insert - found: " . ($verified ? "YES id=" . $verified['id'] : "NO"));
                } catch (\PDOException $e) {
                    error_log("[Admin] INSERT FAILED for {$name}: " . $e->getMessage());
                }

                $toolNames[] = $name;
            }

            return ['count' => count($toolNames), 'tools' => $toolNames];
        } catch (Exception $e) {
            error_log("Failed to fetch MCP tools: " . $e->getMessage());
            return ['count' => 0, 'error' => $e->getMessage()];
        }
    }

    /**
     * Low-level MCP HTTP call with SSE support + session id propagation.
     * $sessionId is updated by-reference from any Mcp-Session-Id response header.
     * Returns ['ok' => bool, 'error' => string|null, 'data' => array|null].
     */
    private function mcpHttpCall(string $url, array $request, array $extraHeaders, ?string &$sessionId, bool $expectResponse = true): array
    {
        $headers = array_merge([
            'Content-Type: application/json',
            'Accept: application/json, text/event-stream, */*',
        ], $extraHeaders);
        if ($sessionId) {
            $headers[] = 'Mcp-Session-Id: ' . $sessionId;
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($request),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);

        $raw = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($curlErr) {
            return ['ok' => false, 'error' => $curlErr, 'data' => null];
        }

        $rawHeaders = (string)substr((string)$raw, 0, (int)$headerSize);
        $body = (string)substr((string)$raw, (int)$headerSize);

        // Capture Mcp-Session-Id (case-insensitive)
        if (preg_match('/^mcp-session-id:\s*(.+?)\s*$/mi', $rawHeaders, $m)) {
            $sessionId = trim($m[1]);
        }

        if ($httpCode >= 400) {
            $snippet = substr($body, 0, 200);
            return ['ok' => false, 'error' => "HTTP $httpCode: $snippet", 'data' => null];
        }

        if (!$expectResponse) {
            return ['ok' => true, 'error' => null, 'data' => null];
        }

        // Try plain JSON first
        $decoded = json_decode($body, true);
        if (is_array($decoded)) {
            return ['ok' => true, 'error' => null, 'data' => $decoded];
        }

        // Parse SSE: find last "data:" JSON payload
        $sseData = null;
        foreach (explode("\n", $body) as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'data:')) {
                $d = trim(substr($line, 5));
                if ($d !== '') {
                    $parsed = json_decode($d, true);
                    if (is_array($parsed)) {
                        $sseData = $parsed;
                    }
                }
            }
        }
        if ($sseData !== null) {
            return ['ok' => true, 'error' => null, 'data' => $sseData];
        }

        return ['ok' => false, 'error' => 'Unparseable response: ' . substr($body, 0, 200), 'data' => null];
    }
}
