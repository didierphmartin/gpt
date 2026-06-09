<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Contracts;

/**
 * Interface for providers that can build HTTP requests for parallel execution.
 *
 * This enables GraphWorkflowRunner to use provider classes instead of duplicating
 * provider-specific request building and response parsing logic.
 */
interface HttpRequestBuilderInterface
{
    /**
     * Build an HTTP request for the provider's API.
     *
     * @param string $model The model to use
     * @param array $messages The messages array (OpenAI-compatible format)
     * @param array $tools The tools array (Claude format: name, description, input_schema)
     * @param array $config Provider configuration (api_key, base_url, etc.)
     * @param int $maxTokens Maximum tokens for the response
     * @param float $temperature Temperature for generation
     * @return array Returns: [url, headers, payload, provider]
     */
    public static function buildHttpRequest(
        string $model,
        array $messages,
        array $tools,
        array $config,
        int $maxTokens,
        float $temperature
    ): array;

    /**
     * Parse the HTTP response from the provider's API.
     *
     * @param array $decoded The decoded JSON response
     * @return array Returns: [text, tool_calls (OpenAI format), usage (normalized)]
     */
    public static function parseHttpResponse(array $decoded): array;

    /**
     * Get the API family for this provider.
     *
     * @return string One of: 'claude', 'gemini', 'openai'
     */
    public static function getApiFamily(): string;
}
