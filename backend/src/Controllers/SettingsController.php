<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;
use Quantis\AIPortfolioAssistant\Services\PackageResolver;

/**
 * Settings Controller
 *
 * Handles user settings including:
 * - Usage statistics
 * - Custom API keys
 * - Provider settings (avatar/voice)
 */
class SettingsController
{
    /**
     * Canonical name of the user's local data folder. Hardcoded everywhere
     * else in the project (skills root at ~/Documents/synergyAI/skills/,
     * Pyodide mounts, workflow output paths). Storing this as a constant
     * here lets us enforce it in storage settings so a stale install-wizard
     * value can't drift the folder name out of sync with the rest of the
     * codebase.
     */
    private const OFFICIAL_USER_FOLDER = 'synergyAI';

    private PDO $db;
    private array $config;
    private string $encryptionKey;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->encryptionKey = $config['auth']['jwt_secret'] ?? 'default-encryption-key-change-this';
    }

    /**
     * Get phone linking status for user
     */
    public function getPhoneStatus(array $request): array
    {
        $userId = $request['user_id'];

        $sql = "SELECT phone FROM users WHERE id = :user_id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        return [
            'success' => true,
            'phone' => $user['phone'] ?? null,
            'has_phone' => !empty($user['phone']),
            'status_code' => 200
        ];
    }

    /**
     * Get usage statistics
     */
    public function getUsage(array $request): array
    {
        $userId = $request['user_id'];
        $currentMonth = date('Y-m');

        // Get balance data for all providers
        $sql = "SELECT
                    provider,
                    month_requests,
                    month_tokens,
                    month_cost_usd,
                    total_requests,
                    total_tokens,
                    total_cost_usd,
                    monthly_budget_usd,
                    monthly_request_limit,
                    current_month
                FROM llm_usage_balance
                WHERE user_id = :user_id";

        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $balances = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Get stats per provider for this month (response time + input/output tokens)
        $sql = "SELECT
                    provider,
                    AVG(response_time_ms) as avg_response_time,
                    SUM(prompt_tokens) as month_input_tokens,
                    SUM(completion_tokens) as month_output_tokens,
                    COUNT(*) as request_count
                FROM llm_usage_transactions
                WHERE user_id = :user_id
                  AND created_at >= :month_start
                GROUP BY provider";

        $monthStart = $currentMonth . '-01';
        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':user_id' => $userId,
            ':month_start' => $monthStart
        ]);
        $transactionStats = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Build stats map (response time + token breakdown)
        $statsMap = [];
        foreach ($transactionStats as $stat) {
            $statsMap[$stat['provider']] = [
                'avg_response_time' => $stat['avg_response_time'],
                'month_input_tokens' => (int)$stat['month_input_tokens'],
                'month_output_tokens' => (int)$stat['month_output_tokens']
            ];
        }

        // Organize by provider
        $byProvider = [];
        $totalCost = 0;
        $totalTokens = 0;
        $totalRequests = 0;

        foreach ($balances as $balance) {
            $provider = $balance['provider'];
            $stats = $statsMap[$provider] ?? [];
            $byProvider[$provider] = [
                'month_requests' => (int)$balance['month_requests'],
                'month_tokens' => (int)$balance['month_tokens'],
                'month_input_tokens' => $stats['month_input_tokens'] ?? 0,
                'month_output_tokens' => $stats['month_output_tokens'] ?? 0,
                'month_cost_usd' => (float)$balance['month_cost_usd'],
                'total_requests' => (int)$balance['total_requests'],
                'total_tokens' => (int)$balance['total_tokens'],
                'total_cost_usd' => (float)$balance['total_cost_usd'],
                'budget_limit' => (float)$balance['monthly_budget_usd'],
                'request_limit' => (int)$balance['monthly_request_limit'],
                'avg_response_time' => $stats['avg_response_time'] ?? null
            ];

            $totalCost += (float)$balance['month_cost_usd'];
            $totalTokens += (int)$balance['month_tokens'];
            $totalRequests += (int)$balance['month_requests'];
        }

        // Get lifetime input/output token totals from transactions table
        $lifetimeSql = "SELECT
                    COALESCE(SUM(prompt_tokens), 0) as lifetime_input_tokens,
                    COALESCE(SUM(completion_tokens), 0) as lifetime_output_tokens,
                    COALESCE(SUM(total_tokens), 0) as lifetime_total_tokens,
                    COALESCE(SUM(cost_usd), 0) as lifetime_cost_usd,
                    COUNT(*) as lifetime_requests
                FROM llm_usage_transactions
                WHERE user_id = :user_id";
        $stmt = $this->db->prepare($lifetimeSql);
        $stmt->execute([':user_id' => $userId]);
        $lifetime = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

        // Get user's plan and role to compute quota usage
        $planSql = "SELECT plan, role FROM users WHERE id = :user_id";
        $planStmt = $this->db->prepare($planSql);
        $planStmt->execute([':user_id' => $userId]);
        $userRow = $planStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        return [
            'success' => true,
            'usage' => [
                'current_month' => $currentMonth,
                'by_provider' => $byProvider,
                'totals' => [
                    'cost_usd' => $totalCost,
                    'tokens' => $totalTokens,
                    'requests' => $totalRequests
                ],
                'lifetime' => [
                    'input_tokens' => (int)($lifetime['lifetime_input_tokens'] ?? 0),
                    'output_tokens' => (int)($lifetime['lifetime_output_tokens'] ?? 0),
                    'total_tokens' => (int)($lifetime['lifetime_total_tokens'] ?? 0),
                    'cost_usd' => (float)($lifetime['lifetime_cost_usd'] ?? 0),
                    'requests' => (int)($lifetime['lifetime_requests'] ?? 0)
                ],
                'plan' => $userRow['plan'] ?? 'free',
                'role' => $userRow['role'] ?? 'prospect',
                'free_trial_quota' => 50000
            ],
            'status_code' => 200
        ];
    }

    /**
     * Get user's custom API keys (masked)
     */
    public function getKeys(array $request): array
    {
        $userId = $request['user_id'];

        $this->ensureApiKeysTableExists();
        $this->ensureUserModelsTableExists();

        $sql = "SELECT provider, api_key, system_prompt, created_at, updated_at
                FROM user_api_keys
                WHERE user_id = :user_id";

        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $keys = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $result = [];
        $systemPrompts = [];
        foreach ($keys as $key) {
            $decrypted = $this->decryptApiKey($key['api_key']);
            $masked = $decrypted ? '****' . substr($decrypted, -4) : null;

            $result[$key['provider']] = [
                'has_custom_key' => !empty($decrypted),
                'masked_key' => $masked,
                'updated_at' => $key['updated_at']
            ];

            // Per-provider system_prompt override (raw text, returned as-is).
            // Frontend prefills its textarea from this; null/missing = "no
            // override → using admin global or file default".
            if (!empty($key['system_prompt'])) {
                $systemPrompts[$key['provider']] = $key['system_prompt'];
            }
        }

        // Load user model selections
        $modelSql = "SELECT provider, model FROM user_model_selections WHERE user_id = :user_id";
        $modelStmt = $this->db->prepare($modelSql);
        $modelStmt->execute([':user_id' => $userId]);
        $modelRows = $modelStmt->fetchAll(PDO::FETCH_ASSOC);

        $models = [];
        foreach ($modelRows as $row) {
            $models[$row['provider']] = $row['model'];
        }

        // Resolve the user's package so the UI can render the model lock:
        // when the user is on the package's API key (has_custom_key === false),
        // the package's default_model is authoritative and the user's saved
        // selection is ignored on the chat path. Frontend disables the
        // dropdown for those providers and shows package_models[provider].
        $packageModels = [];
        $locked = [];
        try {
            $resolver = new PackageResolver($this->db);
            $userIdInt = is_numeric($userId) ? (int)$userId : null;
            $package = $resolver->resolveForUser($userIdInt);
            $providersCfg = $package['capabilities']['providers'] ?? [];
            if (is_array($providersCfg)) {
                foreach ($providersCfg as $providerKey => $providerCfg) {
                    if (!is_array($providerCfg) || empty($providerCfg['enabled'])) continue;
                    $defaultModel = isset($providerCfg['default_model']) && is_string($providerCfg['default_model'])
                        ? trim($providerCfg['default_model']) : '';
                    if ($defaultModel !== '') {
                        $packageModels[$providerKey] = $defaultModel;
                    }
                    $hasOwnKey = !empty($result[$providerKey]['has_custom_key']);
                    $locked[$providerKey] = !$hasOwnKey;
                }
            }
        } catch (Exception $e) {
            error_log('[SettingsController] Package lookup failed in getKeys: ' . $e->getMessage());
        }

        return [
            'success' => true,
            'keys' => $result,
            'models' => $models,
            'package_models' => $packageModels,
            'locked' => $locked,
            'system_prompts' => $systemPrompts,
            'status_code' => 200
        ];
    }

    /**
     * Save user's custom API keys
     */
    public function saveKeys(array $request): array
    {
        $userId = $request['user_id'];
        $keys = $request['body']['keys'] ?? [];
        $models = $request['body']['models'] ?? [];
        // Per-provider system_prompt overrides. Empty string clears the
        // override (falls back to admin global / file default). Missing entry
        // leaves the existing value untouched.
        $systemPrompts = $request['body']['system_prompts'] ?? [];

        $validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];

        if (empty($keys) && empty($models) && empty($systemPrompts)) {
            return [
                'success' => false,
                'error' => 'No keys, models, or system_prompts provided',
                'status_code' => 400
            ];
        }

        $this->ensureApiKeysTableExists();
        $this->ensureUserModelsTableExists();

        $savedCount = 0;

        // Save API keys
        foreach ($keys as $provider => $apiKey) {
            if (!in_array($provider, $validProviders)) {
                continue;
            }

            if (empty(trim($apiKey))) {
                continue;
            }

            // Encrypt the API key
            $encryptedKey = $this->encryptApiKey(trim($apiKey));

            // Upsert the key. VALUES(api_key) references the would-be-inserted
            // row so we can bind :api_key only once — PDO with emulated prepares
            // off rejects the same placeholder appearing twice.
            $sql = "INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)
                    VALUES (:user_id, :provider, :api_key, NOW(), NOW())
                    ON DUPLICATE KEY UPDATE
                        api_key = VALUES(api_key),
                        updated_at = NOW()";

            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':provider' => $provider,
                ':api_key' => $encryptedKey
            ]);

            $savedCount++;
        }

        // Save model selections
        $modelCount = 0;
        foreach ($models as $provider => $model) {
            if (!in_array($provider, $validProviders)) {
                continue;
            }

            if (empty(trim($model))) {
                continue;
            }

            $sql = "INSERT INTO user_model_selections (user_id, provider, model, updated_at)
                    VALUES (:user_id, :provider, :model, NOW())
                    ON DUPLICATE KEY UPDATE
                        model = VALUES(model),
                        updated_at = NOW()";

            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':provider' => $provider,
                ':model' => trim($model)
            ]);

            $modelCount++;
        }

        // Save per-provider system_prompt overrides. Empty string clears the
        // override (column set to NULL → falls back to admin / file default).
        // Stored on user_api_keys so a single row holds all per-(user,provider)
        // overrides; the row is created even when no api_key is set.
        $promptCount = 0;
        foreach ($systemPrompts as $provider => $prompt) {
            if (!in_array($provider, $validProviders)) {
                continue;
            }
            if (!is_string($prompt)) {
                continue;
            }

            $value = trim($prompt);
            $stored = $value === '' ? null : $value;

            // Upsert. Insert path needs an api_key column (NOT NULL); use
            // empty string as a placeholder when the user only supplies a
            // prompt — applyUserApiKeys decrypts it and skips if blank.
            $sql = "INSERT INTO user_api_keys (user_id, provider, api_key, system_prompt, created_at, updated_at)
                    VALUES (:user_id, :provider, '', :system_prompt, NOW(), NOW())
                    ON DUPLICATE KEY UPDATE
                        system_prompt = VALUES(system_prompt),
                        updated_at = NOW()";

            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':provider' => $provider,
                ':system_prompt' => $stored
            ]);

            $promptCount++;
        }

        return [
            'success' => true,
            'message' => "Saved $savedCount API key(s), $modelCount model(s), $promptCount system prompt(s)",
            'saved_count' => $savedCount,
            'model_count' => $modelCount,
            'prompt_count' => $promptCount,
            'status_code' => 200
        ];
    }

    /**
     * Clear all user's custom API keys
     */
    public function clearKeys(array $request): array
    {
        $userId = $request['user_id'];

        $this->ensureApiKeysTableExists();
        $this->ensureUserModelsTableExists();

        $sql = "DELETE FROM user_api_keys WHERE user_id = :user_id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $deletedCount = $stmt->rowCount();

        $modelSql = "DELETE FROM user_model_selections WHERE user_id = :user_id";
        $modelStmt = $this->db->prepare($modelSql);
        $modelStmt->execute([':user_id' => $userId]);
        $modelDeletedCount = $modelStmt->rowCount();

        return [
            'success' => true,
            'message' => "Cleared $deletedCount API key(s) and $modelDeletedCount model selection(s)",
            'deleted_count' => $deletedCount,
            'status_code' => 200
        ];
    }

    /**
     * Get provider settings (avatar/voice)
     */
    public function getProviderSettings(array $request): array
    {
        $userId = $request['user_id'];

        $this->ensureProviderSettingsTableExists();
        $this->ensureCategorySettingsTableExists();

        // Get category-level enabled settings
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
            $hasKey = !empty($row['api_key']);
            $settings = $row['settings'] ? json_decode($row['settings'], true) : null;
            $enabled = isset($row['enabled']) ? (bool)$row['enabled'] : true;

            $result[$category]['providers'][$provider] = [
                'has_key' => $hasKey,
                'settings' => $settings,
                'enabled' => $enabled
            ];

            if ($row['is_active'] == 1 || $row['is_active'] === true) {
                $result[$category]['active'] = $provider;
            }
        }

        return [
            'success' => true,
            'avatar' => $result['avatar'],
            'voice' => $result['voice'],
            'status_code' => 200
        ];
    }

    /**
     * Save a provider configuration
     */
    public function saveProvider(array $request): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';
        $apiKey = $input['api_key'] ?? null;
        $settings = $input['settings'] ?? null;

        // Validate category
        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category. Must be "avatar" or "voice"',
                'status_code' => 400
            ];
        }

        // Validate provider names
        $validAvatarProviders = ['did', 'anam', 'heygen', 'tavus'];
        $validVoiceProviders = ['gemini', 'grok', 'hume', 'elevenlabs'];

        if ($category === 'avatar' && !in_array($provider, $validAvatarProviders)) {
            return [
                'success' => false,
                'error' => 'Invalid avatar provider',
                'status_code' => 400
            ];
        }
        if ($category === 'voice' && !in_array($provider, $validVoiceProviders)) {
            return [
                'success' => false,
                'error' => 'Invalid voice provider',
                'status_code' => 400
            ];
        }

        $this->ensureProviderSettingsTableExists();

        // Encrypt API key if provided
        $encryptedKey = null;
        if ($apiKey && trim($apiKey) !== '') {
            $encryptedKey = $this->encryptApiKey(trim($apiKey));
        }

        // Parse settings if string
        if (is_string($settings)) {
            $settings = json_decode($settings, true);
        }
        $settingsJson = $settings ? json_encode($settings) : null;

        // Check if record exists
        $checkSql = "SELECT id, api_key FROM user_provider_settings
                     WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $checkStmt = $this->db->prepare($checkSql);
        $checkStmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':provider' => $provider
        ]);
        $existing = $checkStmt->fetch(PDO::FETCH_ASSOC);

        if ($existing) {
            // Update existing record
            if ($encryptedKey !== null) {
                $sql = "UPDATE user_provider_settings
                        SET api_key = :api_key, settings = :settings, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
                $params = [
                    ':user_id' => $userId,
                    ':category' => $category,
                    ':provider' => $provider,
                    ':api_key' => $encryptedKey,
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
            // Insert new record
            $sql = "INSERT INTO user_provider_settings
                    (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)
                    VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':category' => $category,
                ':provider' => $provider,
                ':api_key' => $encryptedKey,
                ':settings' => $settingsJson
            ]);
        }

        return [
            'success' => true,
            'message' => "Provider '$provider' saved for $category",
            'status_code' => 200
        ];
    }

    /**
     * Set active provider for a category
     */
    public function setActiveProvider(array $request): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category. Must be "avatar" or "voice"',
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

        // Verify the provider exists for this user
        $checkSql = "SELECT id FROM user_provider_settings
                     WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $checkStmt = $this->db->prepare($checkSql);
        $checkStmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':provider' => $provider
        ]);

        if (!$checkStmt->fetch()) {
            return [
                'success' => false,
                'error' => "Provider '$provider' not configured for $category",
                'status_code' => 400
            ];
        }

        // Deactivate all providers in this category for this user
        $deactivateSql = "UPDATE user_provider_settings
                          SET is_active = 0
                          WHERE user_id = :user_id AND category = :category";
        $deactivateStmt = $this->db->prepare($deactivateSql);
        $deactivateStmt->execute([
            ':user_id' => $userId,
            ':category' => $category
        ]);

        // Activate the selected provider
        $activateSql = "UPDATE user_provider_settings
                        SET is_active = 1, updated_at = NOW()
                        WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $activateStmt = $this->db->prepare($activateSql);
        $activateStmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':provider' => $provider
        ]);

        return [
            'success' => true,
            'message' => "Active $category provider set to '$provider'",
            'status_code' => 200
        ];
    }

    /**
     * Delete a provider configuration
     */
    public function deleteProvider(array $request): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        $category = $input['category'] ?? '';
        $provider = $input['provider'] ?? '';

        if (!in_array($category, ['avatar', 'voice'])) {
            return [
                'success' => false,
                'error' => 'Invalid category. Must be "avatar" or "voice"',
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

        $sql = "DELETE FROM user_provider_settings
                WHERE user_id = :user_id AND category = :category AND provider = :provider";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':user_id' => $userId,
            ':category' => $category,
            ':provider' => $provider
        ]);

        $deletedCount = $stmt->rowCount();

        return [
            'success' => true,
            'message' => $deletedCount > 0
                ? "Provider '$provider' deleted from $category"
                : "Provider '$provider' was not configured for $category",
            'deleted' => $deletedCount > 0,
            'status_code' => 200
        ];
    }

    /**
     * Ensure user_api_keys table exists. Also carries the per-user
     * system_prompt override for each LLM provider — empty/null means "fall
     * through to the admin global (system_llm_settings) or file default".
     */
    private function ensureApiKeysTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `user_api_keys` (
            `user_id` int NOT NULL,
            `provider` varchar(50) NOT NULL,
            `api_key` text NOT NULL COMMENT 'Encrypted API key',
            `system_prompt` text NULL COMMENT 'User override for this provider system prompt; null = use default',
            `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`user_id`, `provider`),
            KEY `idx_user_id` (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='User custom API keys + system_prompt overrides for LLM providers'";

        $this->db->exec($sql);

        // Idempotent ALTER for existing installs that predate the column.
        try {
            $this->db->exec("ALTER TABLE `user_api_keys` ADD COLUMN `system_prompt` TEXT NULL AFTER `api_key`");
        } catch (\PDOException $e) {
            // Column already exists — ignore.
        }
    }

    /**
     * Ensure user_model_selections table exists
     */
    private function ensureUserModelsTableExists(): void
    {
        $sql = "CREATE TABLE IF NOT EXISTS `user_model_selections` (
            `user_id` int NOT NULL,
            `provider` varchar(50) NOT NULL,
            `model` varchar(100) NOT NULL,
            `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`user_id`, `provider`),
            KEY `idx_user_id` (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='User selected models per LLM provider'";

        $this->db->exec($sql);
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='User-specific avatar and voice provider settings'";

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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='User-level category enable/disable settings'";

        $this->db->exec($sql);
    }

    /**
     * Encrypt API key for storage
     */
    private function encryptApiKey(string $apiKey): string
    {
        $key = hash('sha256', $this->encryptionKey, true);
        $iv = openssl_random_pseudo_bytes(16);
        $encrypted = openssl_encrypt($apiKey, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
        return base64_encode($iv . $encrypted);
    }

    /**
     * Decrypt API key from storage
     */
    private function decryptApiKey(string $encryptedKey): ?string
    {
        try {
            $data = base64_decode($encryptedKey);
            if ($data === false || strlen($data) < 17) {
                return null;
            }

            $key = hash('sha256', $this->encryptionKey, true);
            $iv = substr($data, 0, 16);
            $encrypted = substr($data, 16);

            $decrypted = openssl_decrypt($encrypted, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
            return $decrypted !== false ? $decrypted : null;
        } catch (Exception $e) {
            return null;
        }
    }

    /**
     * Ensure storage columns exist in users table
     */
    private function ensureStorageColumnsExist(): void
    {
        try {
            // Check if columns exist by trying a simple query
            $this->db->query("SELECT storage_provider, storage_folder FROM users LIMIT 1");
        } catch (\PDOException $e) {
            // Columns don't exist, add them
            try {
                $this->db->exec("ALTER TABLE users ADD COLUMN storage_provider VARCHAR(50) DEFAULT 'local'");
            } catch (\PDOException $e2) { /* already exists */ }

            try {
                $this->db->exec("ALTER TABLE users ADD COLUMN storage_folder VARCHAR(255) DEFAULT ''");
            } catch (\PDOException $e2) { /* already exists */ }

            try {
                $this->db->exec("ALTER TABLE users ADD COLUMN universalfs_api_key TEXT DEFAULT NULL");
            } catch (\PDOException $e2) { /* already exists */ }
        }
    }

    /**
     * Get user's storage settings
     */
    public function getStorageSettings(array $request): array
    {
        $userId = $request['user_id'] ?? 0;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            // Ensure columns exist
            $this->ensureStorageColumnsExist();

            $stmt = $this->db->prepare(
                "SELECT storage_provider, storage_folder FROM users WHERE id = ?"
            );
            $stmt->execute([$userId]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);

            // Auto-correct stale rows: the canonical user folder is
            // 'synergyAI' (hardcoded everywhere — skills root, Pyodide mounts,
            // workflow output paths). If a row from an earlier install
            // wizard has a different value, repair it AND make sure the
            // matching folder actually exists on the storage provider —
            // otherwise the listFiles endpoint would point at a path that
            // doesn't exist yet on S3 / gdrive / local and return empty.
            $folder = $user['storage_folder'] ?? '';
            if ($folder !== self::OFFICIAL_USER_FOLDER) {
                error_log(
                    '[SettingsController] auto-correcting storage_folder for user '
                    . $userId . ': ' . var_export($folder, true) . ' -> '
                    . self::OFFICIAL_USER_FOLDER
                );
                $upd = $this->db->prepare(
                    'UPDATE users SET storage_folder = ? WHERE id = ?'
                );
                $upd->execute([self::OFFICIAL_USER_FOLDER, $userId]);
                $folder = self::OFFICIAL_USER_FOLDER;

                // Create the canonical folder on the storage provider so
                // the very next listFiles call finds something rather than
                // an empty / 404 path. Idempotent — ensureStorageFolderExists
                // is a no-op if the folder already exists.
                try {
                    $this->ensureStorageFolderExists(
                        $userId,
                        $user['storage_provider'] ?? 'local',
                        self::OFFICIAL_USER_FOLDER
                    );
                } catch (Exception $createErr) {
                    error_log(
                        '[SettingsController] auto-correct: folder-create failed (non-fatal): '
                        . $createErr->getMessage()
                    );
                }
            }

            return [
                'success' => true,
                'data' => [
                    'provider' => $user['storage_provider'] ?? 'local',
                    'folder' => $folder,
                    'available_providers' => ['local', 's3', 'gdrive', 'onedrive']
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
     * Save user's storage settings
     */
    public function saveStorageSettings(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        $provider = $body['provider'] ?? 'local';
        $folder = trim($body['folder'] ?? '');

        // Validate provider
        $validProviders = ['local', 's3', 'gdrive', 'onedrive'];
        if (!in_array($provider, $validProviders)) {
            return [
                'success' => false,
                'error' => 'Invalid storage provider',
                'status_code' => 400
            ];
        }

        // Force the canonical user folder name. The rest of the codebase
        // (skills root, Pyodide mounts, workflow paths) hardcodes
        // 'synergyAI' — accepting any other value here would put the file
        // storage UI permanently out of sync. Silent normalization rather
        // than rejection: an old client that POSTs the wrong name still
        // succeeds, it just gets the canonical name written.
        if ($folder !== self::OFFICIAL_USER_FOLDER) {
            error_log(
                '[SettingsController] normalizing requested storage_folder '
                . var_export($folder, true) . ' -> '
                . self::OFFICIAL_USER_FOLDER
            );
            $folder = self::OFFICIAL_USER_FOLDER;
        }

        try {
            // Ensure columns exist
            $this->ensureStorageColumnsExist();

            // Save to database
            $stmt = $this->db->prepare(
                "UPDATE users SET storage_provider = ?, storage_folder = ? WHERE id = ?"
            );
            $stmt->execute([$provider, $folder, $userId]);

            // Create folder structure in universalFS if folder is specified
            $folderCreated = false;
            if (!empty($folder)) {
                $folderCreated = $this->ensureStorageFolderExists($userId, $provider, $folder);
            }

            return [
                'success' => true,
                'message' => 'Storage settings saved',
                'data' => [
                    'provider' => $provider,
                    'folder' => $folder,
                    'folder_created' => $folderCreated
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

    private const UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
    private const ROOT_FOLDER = 'synergyaichatroot';

    /**
     * Ensure storage folder exists in universalFS
     * Creates: synergyaichatroot/{user_folder}
     */
    private function ensureStorageFolderExists(int $userId, string $provider, string $userFolder): bool
    {
        $bootstrapPath = self::UNIVERSALFS_PATH . '/bootstrap.php';

        if (!file_exists($bootstrapPath)) {
            error_log("[SettingsController] universalFS not found at: " . $bootstrapPath);
            return $this->ensureLocalStorageFolderExists($userId, $userFolder);
        }

        try {
            require_once $bootstrapPath;

            // Get API key from config or user
            $apiKey = $this->config['universalfs']['api_key'] ?? null;

            if (!$apiKey) {
                // Try to get from users table
                $stmt = $this->db->prepare("SELECT universalfs_api_key FROM users WHERE id = ?");
                $stmt->execute([$userId]);
                $result = $stmt->fetch(PDO::FETCH_ASSOC);
                $apiKey = $result['universalfs_api_key'] ?? null;
            }

            if (!$apiKey || !function_exists('getUniversalFSClientWithApiKey')) {
                error_log("[SettingsController] No universalFS API key configured");
                return $this->ensureLocalStorageFolderExists($userId, $userFolder);
            }

            $client = getUniversalFSClientWithApiKey($apiKey);
            $client->connect($provider);

            // Build the full path: synergyaichatroot/{user_folder}
            $rootPath = $provider . '://' . self::ROOT_FOLDER;
            $userPath = $provider . '://' . self::ROOT_FOLDER . '/' . $userFolder;

            // First, try to create root folder if it doesn't exist
            try {
                $client->mkdir($rootPath);
                error_log("[SettingsController] Created root folder: " . $rootPath);
            } catch (Exception $e) {
                // Folder might already exist, that's OK
                error_log("[SettingsController] Root folder check: " . $e->getMessage());
            }

            // Then create user folder
            try {
                $client->mkdir($userPath);
                error_log("[SettingsController] Created user folder: " . $userPath);
            } catch (Exception $e) {
                // Folder might already exist, that's OK
                error_log("[SettingsController] User folder check: " . $e->getMessage());
            }

            return true;

        } catch (Exception $e) {
            error_log("[SettingsController] Failed to create folder in universalFS: " . $e->getMessage());
            return $this->ensureLocalStorageFolderExists($userId, $userFolder);
        }
    }

    /**
     * Fallback: Create local storage folder
     */
    private function ensureLocalStorageFolderExists(int $userId, string $userFolder): bool
    {
        $basePath = $this->config['storage_path'] ?? __DIR__ . '/../../../../storage';
        $fullPath = $basePath . '/' . self::ROOT_FOLDER . '/' . $userFolder;

        if (!is_dir($fullPath)) {
            if (mkdir($fullPath, 0755, true)) {
                error_log("[SettingsController] Created local folder: " . $fullPath);
                return true;
            }
            error_log("[SettingsController] Failed to create local folder: " . $fullPath);
            return false;
        }

        return true;
    }
}
