<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * System Settings Controller
 *
 * Handles system-wide settings including:
 * - LLM provider configurations
 * - Default provider settings
 * - Migration from config file to database
 */
class SystemSettingsController
{
    private PDO $db;
    private array $config;

    // Allowed API formats for validation
    private const ALLOWED_API_FORMATS = ['openai', 'anthropic', 'gemini', 'custom'];

    // Top-level provider keys that have dedicated config sections
    private const TOP_LEVEL_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'gamma4', 'glm'];

    // Default per-million-token pricing (USD) for known provider/model pairs.
    // Used as fallback when no explicit value is stored. Sourced April 2026.
    // [input_per_1m, output_per_1m]
    private const PRICE_DEFAULTS = [
        'claude'   => [3.00, 15.00],  // claude-sonnet-4-5
        'openai'   => [2.50, 10.00],  // gpt-4o
        'gemini'   => [0.30, 2.50],   // gemini-2.5-flash (Flash tier)
        'grok'     => [0.20, 0.50],   // grok-4-1-fast-reasoning
        'deepseek' => [0.28, 0.42],   // deepseek-chat / deepseek-reasoner (V3.2)
        'kimi'     => [0.55, 2.20],   // kimi-k2
        'gamma4'   => [0.00, 0.00],   // Gemma-4-E4B-it — free
        'glm'      => [1.40, 4.40],   // glm-5.2 (z.ai / Zhipu): $1.40 in / $4.40 out per 1M
    ];

    private bool $priceColumnsEnsured = false;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Idempotently add the per-token price columns to system_llm_settings.
     * Runs once per request (cached on the instance).
     */
    private function ensurePriceColumnsExist(): void
    {
        if ($this->priceColumnsEnsured) {
            return;
        }
        $alters = [
            "ALTER TABLE `system_llm_settings` ADD COLUMN `price_input_per_1m` DECIMAL(10,4) DEFAULT NULL AFTER `temperature`",
            "ALTER TABLE `system_llm_settings` ADD COLUMN `price_output_per_1m` DECIMAL(10,4) DEFAULT NULL AFTER `price_input_per_1m`",
        ];
        foreach ($alters as $alter) {
            try { $this->db->exec($alter); } catch (\PDOException $e) { /* already exists */ }
        }
        $this->priceColumnsEnsured = true;
    }

    /**
     * Verify that the current user has admin role
     * Only admins can access system LLM settings
     */
    private function requireAdmin(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        $sql = "SELECT role FROM users WHERE id = :user_id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':user_id' => $userId]);
        $user = $stmt->fetch(\PDO::FETCH_ASSOC);

        if (!$user || $user['role'] !== 'admin') {
            return [
                'success' => false,
                'error' => 'Admin access required',
                'status_code' => 403
            ];
        }

        return null;
    }

    /**
     * Get all LLM providers
     * Returns from database if available, falls back to config file
     */
    public function getLLMProviders(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        try {
            $this->ensurePriceColumnsExist();
            // Check if we have any providers in the database
            $sql = "SELECT * FROM system_llm_settings ORDER BY sort_order ASC, display_name ASC";
            $stmt = $this->db->query($sql);
            $providers = $stmt->fetchAll(PDO::FETCH_ASSOC);

            if (empty($providers)) {
                // Fall back to config file
                return $this->getProvidersFromConfig();
            }

            // Parse JSON fields and keep API key for admin editing
            foreach ($providers as &$provider) {
                $provider['api_key_masked'] = $this->maskApiKey($provider['api_key'] ?? '');
                // Keep actual api_key for admin editing (admin-only endpoint)
                $provider['supported_models'] = json_decode($provider['supported_models'] ?? '[]', true);
                $provider['streaming'] = (bool)$provider['streaming'];
                $provider['supports_tools'] = (bool)$provider['supports_tools'];
                $provider['enabled'] = (bool)$provider['enabled'];
                $provider['max_tokens'] = (int)$provider['max_tokens'];
                $provider['temperature'] = (float)$provider['temperature'];
                $provider['sort_order'] = (int)$provider['sort_order'];
                $defaults = self::PRICE_DEFAULTS[$provider['provider_key']] ?? [null, null];
                $provider['price_input_per_1m'] = isset($provider['price_input_per_1m']) && $provider['price_input_per_1m'] !== null
                    ? (float)$provider['price_input_per_1m'] : $defaults[0];
                $provider['price_output_per_1m'] = isset($provider['price_output_per_1m']) && $provider['price_output_per_1m'] !== null
                    ? (float)$provider['price_output_per_1m'] : $defaults[1];
            }

            return [
                'success' => true,
                'providers' => $providers,
                'source' => 'database',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to fetch LLM providers: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get providers from config file (fallback)
     */
    private function getProvidersFromConfig(): array
    {
        $providers = [];
        $sortOrder = 0;

        // Provider-specific defaults
        $providerDefaults = [
            'claude' => [
                'display_name' => 'Claude',
                'base_url' => 'https://api.anthropic.com',
                'model' => 'claude-sonnet-4-5',
                'max_tokens' => 64000,
                'api_format' => 'anthropic',
                'chat_endpoint' => '/v1/messages',
            ],
            'openai' => [
                'display_name' => 'OpenAI',
                'base_url' => 'https://api.openai.com',
                'model' => 'gpt-4o',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/v1/chat/completions',
            ],
            'gemini' => [
                'display_name' => 'Gemini',
                'base_url' => 'https://generativelanguage.googleapis.com',
                'model' => 'gemini-2.0-flash',
                'max_tokens' => 8192,
                'api_format' => 'gemini',
                'chat_endpoint' => '/v1beta/models',
            ],
            'grok' => [
                'display_name' => 'Grok',
                'base_url' => 'https://api.x.ai',
                'model' => 'grok-2-latest',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/v1/chat/completions',
            ],
            'deepseek' => [
                'display_name' => 'DeepSeek',
                'base_url' => 'https://api.deepseek.com',
                'model' => 'deepseek-chat',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/v1/chat/completions',
            ],
            'kimi' => [
                'display_name' => 'Kimi',
                'base_url' => 'https://api.moonshot.cn',
                'model' => 'moonshot-v1-auto',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/v1/chat/completions',
            ],
            'gamma4' => [
                'display_name' => 'Gamma4',
                'base_url' => 'https://g4eb.yellowbrickroad.info',
                'model' => 'Gemma-4-E4B-it',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/v1/chat/completions',
            ],
            'glm' => [
                'display_name' => 'GLM 5.2',
                'base_url' => 'https://api.z.ai/api/paas/v4',
                'model' => 'glm-5.2',
                'max_tokens' => 4096,
                'api_format' => 'openai',
                'chat_endpoint' => '/chat/completions',
            ],
        ];

        // Add top-level providers
        foreach (self::TOP_LEVEL_PROVIDERS as $key) {
            if (isset($this->config[$key])) {
                $config = $this->config[$key];
                $defaults = $providerDefaults[$key] ?? [];

                $prices = self::PRICE_DEFAULTS[$key] ?? [null, null];
                $providers[] = [
                    'id' => null,
                    'provider_key' => $key,
                    'display_name' => $config['display_name'] ?? $defaults['display_name'] ?? ucfirst($key),
                    'api_key' => $config['api_key'] ?? '',
                    'api_key_masked' => $this->maskApiKey($config['api_key'] ?? ''),
                    'model' => $config['model'] ?? $defaults['model'] ?? '',
                    'base_url' => $config['base_url'] ?? $defaults['base_url'] ?? '',
                    'max_tokens' => (int)($config['max_tokens'] ?? $defaults['max_tokens'] ?? 4096),
                    'temperature' => (float)($config['temperature'] ?? 0.7),
                    'price_input_per_1m' => isset($config['price_input_per_1m']) ? (float)$config['price_input_per_1m'] : $prices[0],
                    'price_output_per_1m' => isset($config['price_output_per_1m']) ? (float)$config['price_output_per_1m'] : $prices[1],
                    'chat_endpoint' => $config['chat_endpoint'] ?? $defaults['chat_endpoint'] ?? '/v1/chat/completions',
                    'streaming' => (bool)($config['streaming'] ?? true),
                    'supports_tools' => (bool)($config['supports_tools'] ?? true),
                    'supported_models' => $config['supported_models'] ?? [],
                    'api_format' => $config['api_format'] ?? $defaults['api_format'] ?? 'openai',
                    'system_prompt' => $config['system_prompt'] ?? null,
                    'enabled' => true,
                    'sort_order' => $sortOrder++
                ];
            }
        }

        // Add custom providers from 'providers' array
        if (isset($this->config['providers']) && is_array($this->config['providers'])) {
            foreach ($this->config['providers'] as $key => $provider) {
                // Skip if already added as top-level provider
                if (in_array($key, self::TOP_LEVEL_PROVIDERS) && isset($this->config[$key])) {
                    continue;
                }

                $prices = self::PRICE_DEFAULTS[$key] ?? [null, null];
                $providers[] = [
                    'id' => null,
                    'provider_key' => $key,
                    'display_name' => $provider['display_name'] ?? ucfirst($key),
                    'api_key' => $provider['api_key'] ?? '',
                    'api_key_masked' => $this->maskApiKey($provider['api_key'] ?? ''),
                    'model' => $provider['model'] ?? '',
                    'base_url' => $provider['base_url'] ?? '',
                    'max_tokens' => (int)($provider['max_tokens'] ?? 4096),
                    'temperature' => (float)($provider['temperature'] ?? 0.7),
                    'price_input_per_1m' => isset($provider['price_input_per_1m']) ? (float)$provider['price_input_per_1m'] : $prices[0],
                    'price_output_per_1m' => isset($provider['price_output_per_1m']) ? (float)$provider['price_output_per_1m'] : $prices[1],
                    'chat_endpoint' => $provider['chat_endpoint'] ?? '/v1/chat/completions',
                    'streaming' => (bool)($provider['streaming'] ?? true),
                    'supports_tools' => (bool)($provider['supports_tools'] ?? true),
                    'supported_models' => $provider['supported_models'] ?? [],
                    'api_format' => $provider['api_format'] ?? 'openai',
                    'system_prompt' => $provider['system_prompt'] ?? null,
                    'enabled' => true,
                    'sort_order' => $sortOrder++
                ];
            }
        }

        return [
            'success' => true,
            'providers' => $providers,
            'source' => 'config',
            'status_code' => 200
        ];
    }

    /**
     * Get a single LLM provider by key
     */
    public function getLLMProvider(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        $providerKey = $request['params']['key'] ?? null;

        if (!$providerKey) {
            return [
                'success' => false,
                'error' => 'Provider key is required',
                'status_code' => 400
            ];
        }

        try {
            $this->ensurePriceColumnsExist();
            $sql = "SELECT * FROM system_llm_settings WHERE provider_key = :key";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key' => $providerKey]);
            $provider = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$provider) {
                return [
                    'success' => false,
                    'error' => 'Provider not found',
                    'status_code' => 404
                ];
            }

            $provider['api_key_masked'] = $this->maskApiKey($provider['api_key'] ?? '');
            // Keep actual api_key for admin editing (admin-only endpoint)
            $provider['supported_models'] = json_decode($provider['supported_models'] ?? '[]', true);
            $provider['streaming'] = (bool)$provider['streaming'];
            $provider['supports_tools'] = (bool)$provider['supports_tools'];
            $provider['enabled'] = (bool)$provider['enabled'];
            $defaults = self::PRICE_DEFAULTS[$provider['provider_key']] ?? [null, null];
            $provider['price_input_per_1m'] = isset($provider['price_input_per_1m']) && $provider['price_input_per_1m'] !== null
                ? (float)$provider['price_input_per_1m'] : $defaults[0];
            $provider['price_output_per_1m'] = isset($provider['price_output_per_1m']) && $provider['price_output_per_1m'] !== null
                ? (float)$provider['price_output_per_1m'] : $defaults[1];

            return [
                'success' => true,
                'provider' => $provider,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to fetch provider: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Save (create or update) an LLM provider
     */
    public function saveLLMProvider(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        $body = $request['body'] ?? [];

        $providerKey = $body['provider_key'] ?? null;
        if (!$providerKey) {
            return [
                'success' => false,
                'error' => 'Provider key is required',
                'status_code' => 400
            ];
        }

        $displayName = $body['display_name'] ?? ucfirst($providerKey);
        $model = $body['model'] ?? null;
        if (!$model) {
            return [
                'success' => false,
                'error' => 'Model is required',
                'status_code' => 400
            ];
        }

        // Validate api_format
        $apiFormat = $body['api_format'] ?? 'openai';
        if (!in_array($apiFormat, self::ALLOWED_API_FORMATS)) {
            return [
                'success' => false,
                'error' => 'Invalid api_format. Allowed values: ' . implode(', ', self::ALLOWED_API_FORMATS),
                'status_code' => 400
            ];
        }

        try {
            $this->ensurePriceColumnsExist();
            // Check if provider exists
            $sql = "SELECT id, api_key FROM system_llm_settings WHERE provider_key = :key";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key' => $providerKey]);
            $existing = $stmt->fetch(PDO::FETCH_ASSOC);

            // Handle API key - only update if a new one is provided
            $apiKey = $body['api_key'] ?? null;
            if ($existing && (!$apiKey || $apiKey === '' || strpos($apiKey, '***') !== false)) {
                // Keep existing API key
                $apiKey = $existing['api_key'];
            }

            $supportedModels = $body['supported_models'] ?? [];
            if (is_array($supportedModels)) {
                $supportedModels = json_encode($supportedModels);
            }

            $priceInput = array_key_exists('price_input_per_1m', $body) && $body['price_input_per_1m'] !== '' && $body['price_input_per_1m'] !== null
                ? (float)$body['price_input_per_1m'] : null;
            $priceOutput = array_key_exists('price_output_per_1m', $body) && $body['price_output_per_1m'] !== '' && $body['price_output_per_1m'] !== null
                ? (float)$body['price_output_per_1m'] : null;

            if ($existing) {
                // Update existing provider
                $sql = "UPDATE system_llm_settings SET
                            display_name = :display_name,
                            api_key = :api_key,
                            model = :model,
                            base_url = :base_url,
                            max_tokens = :max_tokens,
                            temperature = :temperature,
                            price_input_per_1m = :price_input_per_1m,
                            price_output_per_1m = :price_output_per_1m,
                            chat_endpoint = :chat_endpoint,
                            streaming = :streaming,
                            supports_tools = :supports_tools,
                            supported_models = :supported_models,
                            api_format = :api_format,
                            system_prompt = :system_prompt,
                            enabled = :enabled,
                            sort_order = :sort_order,
                            updated_at = NOW()
                        WHERE provider_key = :provider_key";
            } else {
                // Create new provider
                $sql = "INSERT INTO system_llm_settings
                        (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
                         price_input_per_1m, price_output_per_1m,
                         chat_endpoint, streaming, supports_tools, supported_models, api_format,
                         system_prompt, enabled, sort_order, created_at, updated_at)
                        VALUES
                        (:provider_key, :display_name, :api_key, :model, :base_url, :max_tokens, :temperature,
                         :price_input_per_1m, :price_output_per_1m,
                         :chat_endpoint, :streaming, :supports_tools, :supported_models, :api_format,
                         :system_prompt, :enabled, :sort_order, NOW(), NOW())";
            }

            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':provider_key' => $providerKey,
                ':display_name' => $displayName,
                ':api_key' => $apiKey,
                ':model' => $model,
                ':base_url' => $body['base_url'] ?? null,
                ':max_tokens' => (int)($body['max_tokens'] ?? 4096),
                ':temperature' => (float)($body['temperature'] ?? 0.7),
                ':price_input_per_1m' => $priceInput,
                ':price_output_per_1m' => $priceOutput,
                ':chat_endpoint' => $body['chat_endpoint'] ?? null,
                ':streaming' => (int)($body['streaming'] ?? 1),
                ':supports_tools' => (int)($body['supports_tools'] ?? 1),
                ':supported_models' => $supportedModels,
                ':api_format' => $body['api_format'] ?? 'openai',
                ':system_prompt' => $body['system_prompt'] ?? null,
                ':enabled' => (int)($body['enabled'] ?? 1),
                ':sort_order' => (int)($body['sort_order'] ?? 0)
            ]);

            return [
                'success' => true,
                'message' => $existing ? 'Provider updated' : 'Provider created',
                'provider_key' => $providerKey,
                'status_code' => $existing ? 200 : 201
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to save provider: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Delete an LLM provider
     */
    public function deleteLLMProvider(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        $providerKey = $request['params']['key'] ?? null;

        if (!$providerKey) {
            return [
                'success' => false,
                'error' => 'Provider key is required',
                'status_code' => 400
            ];
        }

        try {
            $sql = "SELECT id FROM system_llm_settings WHERE provider_key = :key";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key' => $providerKey]);
            if (!$stmt->fetch()) {
                return [
                    'success' => false,
                    'error' => 'Provider not found',
                    'status_code' => 404
                ];
            }

            $sql = "DELETE FROM system_llm_settings WHERE provider_key = :key";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key' => $providerKey]);

            return [
                'success' => true,
                'message' => 'Provider deleted',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to delete provider: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Seed database with providers from config file
     * This is a one-time migration utility
     */
    public function seedFromConfig(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        try {
            // Use transaction to ensure atomicity
            $this->db->beginTransaction();

            $seeded = [];
            $sortOrder = 0;

            // Seed all top-level providers
            foreach (self::TOP_LEVEL_PROVIDERS as $key) {
                if (isset($this->config[$key])) {
                    $apiFormat = $key === 'claude' ? 'anthropic' : ($key === 'gemini' ? 'gemini' : 'openai');
                    $this->seedProvider($key, $this->config[$key], $apiFormat, $sortOrder++);
                    $seeded[] = $key;
                }
            }

            // Seed custom providers from 'providers' array
            if (isset($this->config['providers']) && is_array($this->config['providers'])) {
                foreach ($this->config['providers'] as $key => $provider) {
                    // Skip if already seeded as top-level provider
                    if (in_array($key, $seeded)) {
                        continue;
                    }
                    $apiFormat = $provider['api_format'] ?? 'openai';
                    $this->seedProvider($key, $provider, $apiFormat, $sortOrder++);
                    $seeded[] = $key;
                }
            }

            // Set default provider
            $this->db->commit();

            return [
                'success' => true,
                'message' => 'Providers seeded from config',
                'seeded' => $seeded,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            $this->db->rollBack();
            return [
                'success' => false,
                'error' => 'Failed to seed providers: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Seed a single provider (helper method)
     */
    private function seedProvider(string $key, array $config, string $apiFormat, int $sortOrder): void
    {
        $this->ensurePriceColumnsExist();

        $supportedModels = $config['supported_models'] ?? [];
        if (is_array($supportedModels)) {
            $supportedModels = json_encode($supportedModels);
        }

        $priceDefaults = self::PRICE_DEFAULTS[$key] ?? [null, null];
        $priceInput = isset($config['price_input_per_1m']) ? (float)$config['price_input_per_1m'] : $priceDefaults[0];
        $priceOutput = isset($config['price_output_per_1m']) ? (float)$config['price_output_per_1m'] : $priceDefaults[1];

        $sql = "INSERT INTO system_llm_settings
                (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
                 price_input_per_1m, price_output_per_1m,
                 chat_endpoint, streaming, supports_tools, supported_models, api_format,
                 system_prompt, enabled, sort_order, created_at, updated_at)
                VALUES
                (:provider_key, :display_name, :api_key, :model, :base_url, :max_tokens, :temperature,
                 :price_input_per_1m, :price_output_per_1m,
                 :chat_endpoint, :streaming, :supports_tools, :supported_models, :api_format,
                 :system_prompt, :enabled, :sort_order, NOW(), NOW())
                ON DUPLICATE KEY UPDATE
                    display_name = VALUES(display_name),
                    api_key = VALUES(api_key),
                    model = VALUES(model),
                    base_url = VALUES(base_url),
                    max_tokens = VALUES(max_tokens),
                    temperature = VALUES(temperature),
                    price_input_per_1m = VALUES(price_input_per_1m),
                    price_output_per_1m = VALUES(price_output_per_1m),
                    chat_endpoint = VALUES(chat_endpoint),
                    streaming = VALUES(streaming),
                    supports_tools = VALUES(supports_tools),
                    supported_models = VALUES(supported_models),
                    api_format = VALUES(api_format),
                    system_prompt = VALUES(system_prompt),
                    sort_order = VALUES(sort_order),
                    updated_at = NOW()";

        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':provider_key' => $key,
            ':display_name' => $config['display_name'] ?? ucfirst($key),
            ':api_key' => $config['api_key'] ?? null,
            ':model' => $config['model'] ?? '',
            ':base_url' => $config['base_url'] ?? null,
            ':max_tokens' => (int)($config['max_tokens'] ?? 4096),
            ':temperature' => (float)($config['temperature'] ?? 0.7),
            ':price_input_per_1m' => $priceInput,
            ':price_output_per_1m' => $priceOutput,
            ':chat_endpoint' => $config['chat_endpoint'] ?? null,
            ':streaming' => (int)($config['streaming'] ?? 1),
            ':supports_tools' => (int)($config['supports_tools'] ?? 1),
            ':supported_models' => $supportedModels,
            ':api_format' => $apiFormat,
            ':system_prompt' => $config['system_prompt'] ?? null,
            ':enabled' => 1,
            ':sort_order' => $sortOrder
        ]);
    }

    /**
     * Mask API key for display (show first 4 and last 4 chars)
     */
    private function maskApiKey(?string $apiKey): string
    {
        if (!$apiKey || strlen($apiKey) < 12) {
            return '***';
        }
        return substr($apiKey, 0, 4) . '***' . substr($apiKey, -4);
    }

    /**
     * Toggle provider enabled status
     */
    public function toggleProvider(array $request): array
    {
        if ($error = $this->requireAdmin($request)) {
            return $error;
        }

        $body = $request['body'] ?? [];
        $providerKey = $body['provider_key'] ?? null;
        $enabled = isset($body['enabled']) ? (bool)$body['enabled'] : null;

        if (!$providerKey) {
            return [
                'success' => false,
                'error' => 'Provider key is required',
                'status_code' => 400
            ];
        }

        try {
            if ($enabled === null) {
                // Toggle current value
                $sql = "UPDATE system_llm_settings SET enabled = NOT enabled, updated_at = NOW() WHERE provider_key = :key";
            } else {
                $sql = "UPDATE system_llm_settings SET enabled = :enabled, updated_at = NOW() WHERE provider_key = :key";
            }

            $stmt = $this->db->prepare($sql);
            $params = [':key' => $providerKey];
            if ($enabled !== null) {
                $params[':enabled'] = (int)$enabled;
            }
            $stmt->execute($params);

            if ($stmt->rowCount() === 0) {
                return [
                    'success' => false,
                    'error' => 'Provider not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'message' => 'Provider toggled',
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => 'Failed to toggle provider: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }
}
