<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Contracts;

/**
 * Interface for tracking LLM usage and costs
 */
interface UsageTrackerInterface
{
    /**
     * Track an API request
     *
     * @param array $data Request data including:
     *   - user_id: User making the request
     *   - provider: AI provider name
     *   - model: Model used
     *   - input_tokens: Number of input tokens
     *   - output_tokens: Number of output tokens
     *   - function_calls_count: Number of function calls
     *   - response_time_ms: Response time in milliseconds
     *   - status: 'success' or 'error'
     *   - error_message: Error message if status is 'error'
     */
    public function trackRequest(array $data): void;

    /**
     * Track a function call
     */
    public function trackFunctionCall(
        string $functionName,
        string $provider,
        int $executionTimeMs,
        bool $success,
        ?string $userId = null
    ): void;

    /**
     * Get usage statistics for a user
     */
    public function getUserStats(string $userId, ?string $period = 'day'): array;

    /**
     * Get overall usage statistics
     */
    public function getStats(?string $period = 'day'): array;

    /**
     * Calculate estimated cost for tokens
     */
    public function calculateCost(string $provider, string $model, int $inputTokens, int $outputTokens): float;
}
