<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Providers;

use Quantis\AIPortfolioAssistant\Contracts\HttpRequestBuilderInterface;

/**
 * Factory for building provider HTTP requests and parsing responses.
 *
 * This provides a single entry point for GraphWorkflowRunner and other
 * parallel execution contexts to build requests and parse responses
 * using the same logic as the provider classes.
 */
class ProviderRequestFactory
{
    /**
     * Map of provider names to their implementing classes.
     * Includes aliases (anthropic -> claude, google -> gemini).
     */
    private static array $providerClasses = [
        'claude' => ClaudeProvider::class,
        'anthropic' => ClaudeProvider::class,
        'gemini' => GeminiProvider::class,
        'google' => GeminiProvider::class,
        'openai' => OpenAIProvider::class,
        'deepseek' => DeepSeekProvider::class,
        'grok' => GrokProvider::class,
        'kimi' => KimiProvider::class,
    ];

    /**
     * Build an HTTP request for the given provider.
     *
     * @param string $provider The provider name (claude, gemini, openai, etc.)
     * @param string $model The model to use
     * @param array $messages The messages array (OpenAI-compatible format)
     * @param array $tools The tools array (Claude format)
     * @param array $config Provider configuration
     * @param int $maxTokens Maximum tokens
     * @param float $temperature Temperature
     * @return array|null Returns [url, headers, payload, provider] or null if provider not found
     */
    public static function buildRequest(
        string $provider,
        string $model,
        array $messages,
        array $tools,
        array $config,
        int $maxTokens,
        float $temperature
    ): ?array {
        $providerLower = strtolower($provider);
        $class = self::$providerClasses[$providerLower] ?? null;

        if ($class === null) {
            // Unknown provider - try OpenAI-compatible as fallback
            error_log("[ProviderRequestFactory] Unknown provider '{$provider}', using OpenAI-compatible format");
            $class = OpenAIProvider::class;
        }

        // Check if class implements the interface
        if (!in_array(HttpRequestBuilderInterface::class, class_implements($class) ?: [])) {
            error_log("[ProviderRequestFactory] Provider class {$class} does not implement HttpRequestBuilderInterface");
            return null;
        }

        return $class::buildHttpRequest($model, $messages, $tools, $config, $maxTokens, $temperature);
    }

    /**
     * Parse an HTTP response for the given provider.
     *
     * @param string $provider The provider name
     * @param array $decoded The decoded JSON response
     * @return array Returns [text, tool_calls, usage]
     */
    public static function parseResponse(string $provider, array $decoded): array
    {
        $providerLower = strtolower($provider);
        $class = self::$providerClasses[$providerLower] ?? null;

        if ($class === null) {
            // Unknown provider - try OpenAI-compatible as fallback
            $class = OpenAIProvider::class;
        }

        // Check if class implements the interface
        if (!in_array(HttpRequestBuilderInterface::class, class_implements($class) ?: [])) {
            error_log("[ProviderRequestFactory] Provider class {$class} does not implement HttpRequestBuilderInterface");
            return ['text' => '', 'tool_calls' => [], 'usage' => null];
        }

        return $class::parseHttpResponse($decoded);
    }

    /**
     * Get the API family for a provider.
     *
     * @param string $provider The provider name
     * @return string One of: 'claude', 'gemini', 'openai'
     */
    public static function getApiFamily(string $provider): string
    {
        $providerLower = strtolower($provider);
        $class = self::$providerClasses[$providerLower] ?? null;

        if ($class === null) {
            return 'openai'; // Default to OpenAI-compatible
        }

        if (!in_array(HttpRequestBuilderInterface::class, class_implements($class) ?: [])) {
            return 'openai';
        }

        return $class::getApiFamily();
    }

    /**
     * Check if a provider is supported.
     *
     * @param string $provider The provider name
     * @return bool True if supported
     */
    public static function isSupported(string $provider): bool
    {
        return isset(self::$providerClasses[strtolower($provider)]);
    }

    /**
     * Get list of supported providers.
     *
     * @return array List of provider names
     */
    public static function getSupportedProviders(): array
    {
        return array_keys(self::$providerClasses);
    }

    /**
     * Register a custom provider class.
     *
     * @param string $name The provider name
     * @param string $class The fully-qualified class name
     */
    public static function registerProvider(string $name, string $class): void
    {
        self::$providerClasses[strtolower($name)] = $class;
    }
}
