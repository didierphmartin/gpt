<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Contracts\UsageTrackerInterface;

/**
 * Tracks LLM usage and costs
 */
class UsageTracker implements UsageTrackerInterface
{
    private ?PDO $pdo;
    private bool $enabled;

    /**
     * Pricing per million tokens (input/output)
     * Note: This is a backup - primary pricing is in UsageLogger
     */
    private const PRICING = [
        'claude' => [
            'claude-sonnet-4-5-20250929' => ['input' => 3.0, 'output' => 15.0],
            'claude-sonnet-4-5' => ['input' => 3.0, 'output' => 15.0],
            'claude-3-5-sonnet-20241022' => ['input' => 3.0, 'output' => 15.0],
            'claude-3-opus-20240229' => ['input' => 15.0, 'output' => 75.0],
            'claude-3-haiku-20240307' => ['input' => 0.25, 'output' => 1.25],
        ],
        'openai' => [
            'gpt-4-turbo-preview' => ['input' => 10.0, 'output' => 30.0],
            'gpt-4' => ['input' => 30.0, 'output' => 60.0],
            'gpt-4o' => ['input' => 2.5, 'output' => 10.0],
            'gpt-4o-mini' => ['input' => 0.15, 'output' => 0.6],
            'gpt-3.5-turbo' => ['input' => 0.5, 'output' => 1.5],
        ],
        'grok' => [
            'grok-2-1212' => ['input' => 2.0, 'output' => 10.0],
            'grok-4-1-fast-reasoning' => ['input' => 3.0, 'output' => 15.0],
        ],
        'deepseek' => [
            'deepseek-chat' => ['input' => 0.14, 'output' => 0.28],
            'deepseek-reasoner' => ['input' => 0.55, 'output' => 2.19],
        ],
        'gemini' => [
            'gemini-2.5-flash' => ['input' => 0.075, 'output' => 0.3],
            'gemini-2.5-pro' => ['input' => 1.25, 'output' => 10.0],
        ],
        'kimi' => [
            'kimi-k2.5' => ['input' => 0.6, 'output' => 2.4],
            'kimi-k2-turbo-preview' => ['input' => 0.6, 'output' => 2.4],
        ],
    ];

    public function __construct(?PDO $pdo = null, bool $enabled = true)
    {
        $this->pdo = $pdo;
        $this->enabled = $enabled && $pdo !== null;
    }

    /**
     * Track an API request
     */
    public function trackRequest(array $data): void
    {
        if (!$this->enabled) {
            return;
        }

        try {
            // Check if connection is still alive
            $this->pdo->query('SELECT 1');
        } catch (\PDOException $e) {
            // Connection lost - skip tracking to avoid crashing the request
            error_log("[UsageTracker] DB connection lost, skipping usage tracking");
            return;
        }

        try {
            $sql = "INSERT INTO llm_usage_transactions (
                user_id, session_id, provider, model, prompt_tokens, completion_tokens,
                total_tokens, cost_usd, response_time_ms, function_calls_count,
                status, error_message, request_metadata, created_at
            ) VALUES (
                :user_id, :session_id, :provider, :model, :prompt_tokens, :completion_tokens,
                :total_tokens, :cost_usd, :response_time_ms, :function_calls_count,
                :status, :error_message, :request_metadata, NOW()
            )";

            $inputTokens = $data['input_tokens'] ?? 0;
            $outputTokens = $data['output_tokens'] ?? 0;
            $provider = $data['provider'] ?? 'claude';
            $model = $data['model'] ?? 'claude-sonnet-4-5-20250929';

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                ':user_id' => $data['user_id'] ?? null,
                ':session_id' => $data['session_id'] ?? null,
                ':provider' => $provider,
                ':model' => $model,
                ':prompt_tokens' => $inputTokens,
                ':completion_tokens' => $outputTokens,
                ':total_tokens' => $inputTokens + $outputTokens,
                ':cost_usd' => $this->calculateCost($provider, $model, $inputTokens, $outputTokens),
                ':response_time_ms' => $data['response_time_ms'] ?? 0,
                ':function_calls_count' => $data['function_calls_count'] ?? 0,
                ':status' => $data['status'] ?? 'success',
                ':error_message' => $data['error_message'] ?? null,
                ':request_metadata' => json_encode(['request_type' => $data['request_type'] ?? 'chat']),
            ]);
        } catch (\PDOException $e) {
            // Log but don't crash - usage tracking is not critical
            error_log("[UsageTracker] Failed to track usage: " . $e->getMessage());
        }
    }

    /**
     * Track a function call
     */
    public function trackFunctionCall(
        string $functionName,
        string $provider,
        int $executionTimeMs,
        bool $success,
        ?string $userId = null
    ): void {
        if (!$this->enabled) {
            return;
        }

        $date = date('Y-m-d');

        // Try to update existing record
        $sql = "UPDATE llm_function_usage_stats SET
            call_count = call_count + 1,
            success_count = success_count + :success,
            error_count = error_count + :error,
            avg_execution_time_ms = (avg_execution_time_ms * call_count + :exec_time) / (call_count + 1),
            min_execution_time_ms = LEAST(min_execution_time_ms, :exec_time_min),
            max_execution_time_ms = GREATEST(max_execution_time_ms, :exec_time_max),
            last_called_at = NOW()
            WHERE user_id = :user_id AND function_name = :function_name AND date = :date";

        $stmt = $this->pdo->prepare($sql);
        $result = $stmt->execute([
            ':success' => $success ? 1 : 0,
            ':error' => $success ? 0 : 1,
            ':exec_time' => $executionTimeMs,
            ':exec_time_min' => $executionTimeMs,
            ':exec_time_max' => $executionTimeMs,
            ':user_id' => $userId,
            ':function_name' => $functionName,
            ':date' => $date,
        ]);

        // If no row was updated, insert a new one
        if ($stmt->rowCount() === 0) {
            $sql = "INSERT INTO llm_function_usage_stats (
                user_id, function_name, provider, date, call_count, success_count,
                error_count, avg_execution_time_ms, min_execution_time_ms,
                max_execution_time_ms, last_called_at
            ) VALUES (
                :user_id, :function_name, :provider, :date, 1, :success,
                :error, :exec_time, :exec_time, :exec_time, NOW()
            )";

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':function_name' => $functionName,
                ':provider' => $provider,
                ':date' => $date,
                ':success' => $success ? 1 : 0,
                ':error' => $success ? 0 : 1,
                ':exec_time' => $executionTimeMs,
            ]);
        }
    }

    /**
     * Get usage statistics for a user
     */
    public function getUserStats(string $userId, ?string $period = 'day'): array
    {
        if (!$this->enabled) {
            return [];
        }

        $dateCondition = $this->getDateCondition($period);

        $sql = "SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_input_tokens,
            SUM(completion_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost,
            AVG(response_time_ms) as avg_response_time,
            SUM(function_calls_count) as total_function_calls
            FROM llm_usage_transactions
            WHERE user_id = :user_id {$dateCondition}";

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([':user_id' => $userId]);

        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    /**
     * Get overall usage statistics
     */
    public function getStats(?string $period = 'day'): array
    {
        if (!$this->enabled) {
            return [];
        }

        $dateCondition = $this->getDateCondition($period);

        $sql = "SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_input_tokens,
            SUM(completion_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost,
            AVG(response_time_ms) as avg_response_time,
            SUM(function_calls_count) as total_function_calls,
            COUNT(DISTINCT user_id) as unique_users
            FROM llm_usage_transactions
            WHERE 1=1 {$dateCondition}";

        $stmt = $this->pdo->query($sql);

        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    /**
     * Calculate estimated cost for tokens
     */
    public function calculateCost(string $provider, string $model, int $inputTokens, int $outputTokens): float
    {
        $pricing = self::PRICING[$provider][$model] ?? ['input' => 3.0, 'output' => 15.0];

        $inputCost = ($inputTokens / 1_000_000) * $pricing['input'];
        $outputCost = ($outputTokens / 1_000_000) * $pricing['output'];

        return round($inputCost + $outputCost, 6);
    }

    /**
     * Get date condition for SQL queries
     */
    private function getDateCondition(string $period): string
    {
        return match ($period) {
            'day' => "AND DATE(created_at) = CURDATE()",
            'week' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
            'month' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
            'year' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)",
            default => "",
        };
    }
}
