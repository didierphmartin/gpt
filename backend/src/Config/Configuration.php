<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Config;

use Quantis\AIPortfolioAssistant\Exceptions\ConfigurationException;

/**
 * Configuration manager for AI Portfolio Assistant
 */
class Configuration
{
    private array $config;

    /**
     * Default configuration values
     */
    private const DEFAULTS = [
        'claude' => [
            'api_key' => '',
            'model' => 'claude-sonnet-4-5-20250929',
            'max_tokens' => 4000,
            'temperature' => 0.7,
            'base_url' => 'https://api.anthropic.com',
            'api_version' => '2023-06-01',
        ],
        'openai' => [
            'api_key' => '',
            'model' => 'gpt-4-turbo-preview',
            'max_tokens' => 4000,
            'temperature' => 0.7,
        ],
        'search' => [
            'serpapi' => ['api_key' => ''],
            'scrapingdog' => ['api_key' => ''],
            'brave' => ['api_key' => ''],
        ],
        'financial' => [
            'fmp' => ['api_key' => ''], // Financial Modeling Prep
        ],
        'sse' => [
            'enabled' => true,
            'hub_url' => null,
        ],
        'tracking' => [
            'enabled' => true,
            'track_costs' => true,
        ],
        'storage' => [
            'default_provider' => 'local', // Options: 'local', 's3', 'gdrive', 'onedrive'
        ],
        'debug' => false,
        'default_provider' => 'claude',
        'max_recursion_depth' => 10,
    ];

    /**
     * @param array $config Configuration array
     */
    public function __construct(array $config = [])
    {
        $this->config = $this->mergeWithDefaults($config);
    }

    /**
     * Create configuration from environment variables
     */
    public static function fromEnvironment(): self
    {
        return new self([
            'claude' => [
                'api_key' => getenv('CLAUDE_API_KEY') ?: '',
                'model' => getenv('CLAUDE_MODEL') ?: 'claude-sonnet-4-5-20250929',
            ],
            'openai' => [
                'api_key' => getenv('OPENAI_API_KEY') ?: '',
            ],
            'search' => [
                'serpapi' => ['api_key' => getenv('SERPAPI_API_KEY') ?: ''],
                'scrapingdog' => ['api_key' => getenv('SCRAPINGDOG_API_KEY') ?: ''],
                'brave' => ['api_key' => getenv('BRAVE_API_KEY') ?: ''],
            ],
            'financial' => [
                'fmp' => ['api_key' => getenv('FMP_API_KEY') ?: ''],
            ],
            'storage' => [
                'default_provider' => getenv('STORAGE_PROVIDER') ?: 'local',
            ],
            'debug' => (bool) getenv('AI_DEBUG'),
        ]);
    }

    /**
     * Create configuration from a PHP config file
     */
    public static function fromFile(string $path): self
    {
        if (!file_exists($path)) {
            throw new ConfigurationException("Configuration file not found: {$path}");
        }

        $config = require $path;

        if (!is_array($config)) {
            throw new ConfigurationException("Configuration file must return an array");
        }

        return new self($config);
    }

    /**
     * Get a configuration value using dot notation
     *
     * @param string $key Configuration key (e.g., 'claude.api_key')
     * @param mixed $default Default value if key not found
     * @return mixed
     */
    public function get(string $key, mixed $default = null): mixed
    {
        $keys = explode('.', $key);
        $value = $this->config;

        foreach ($keys as $segment) {
            if (!is_array($value) || !array_key_exists($segment, $value)) {
                return $default;
            }
            $value = $value[$segment];
        }

        return $value;
    }

    /**
     * Set a configuration value using dot notation
     */
    public function set(string $key, mixed $value): self
    {
        $keys = explode('.', $key);
        $config = &$this->config;

        foreach ($keys as $i => $segment) {
            if ($i === count($keys) - 1) {
                $config[$segment] = $value;
            } else {
                if (!isset($config[$segment]) || !is_array($config[$segment])) {
                    $config[$segment] = [];
                }
                $config = &$config[$segment];
            }
        }

        return $this;
    }

    /**
     * Check if a configuration key exists
     */
    public function has(string $key): bool
    {
        return $this->get($key) !== null;
    }

    /**
     * Get Claude-specific configuration. Returns an empty array when the key
     * isn't present so callers can treat "no DB row + no file fallback" as
     * "provider not configured" instead of getting an undefined-index error.
     */
    public function getClaude(): array
    {
        return $this->config['claude'] ?? [];
    }

    /**
     * Get OpenAI-specific configuration. Same fallback semantics as getClaude.
     */
    public function getOpenAI(): array
    {
        return $this->config['openai'] ?? [];
    }

    /**
     * Get search API configuration
     */
    public function getSearch(): array
    {
        return $this->config['search'];
    }

    /**
     * Get financial API configuration
     */
    public function getFinancial(): array
    {
        return $this->config['financial'];
    }

    /**
     * Check if a provider is configured with an API key
     */
    public function isProviderConfigured(string $provider): bool
    {
        $key = $this->get("{$provider}.api_key");
        return !empty($key);
    }

    /**
     * Get the default provider
     */
    public function getDefaultProvider(): string
    {
        return $this->config['default_provider'];
    }

    /**
     * Check if debug mode is enabled
     */
    public function isDebugEnabled(): bool
    {
        return (bool) $this->config['debug'];
    }

    /**
     * Get all configuration as array
     */
    public function toArray(): array
    {
        return $this->config;
    }

    /**
     * Validate required configuration for a provider
     */
    public function validateProvider(string $provider): void
    {
        if (!$this->isProviderConfigured($provider)) {
            throw new ConfigurationException(
                "Provider '{$provider}' is not configured. Please set the API key."
            );
        }
    }

    /**
     * Merge user config with defaults
     */
    private function mergeWithDefaults(array $config): array
    {
        return $this->arrayMergeRecursive(self::DEFAULTS, $config);
    }

    /**
     * Recursively merge arrays (user values override defaults)
     */
    private function arrayMergeRecursive(array $default, array $override): array
    {
        $merged = $default;

        foreach ($override as $key => $value) {
            if (is_array($value) && isset($merged[$key]) && is_array($merged[$key])) {
                $merged[$key] = $this->arrayMergeRecursive($merged[$key], $value);
            } else {
                $merged[$key] = $value;
            }
        }

        return $merged;
    }
}
