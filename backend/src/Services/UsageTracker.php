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
    private ?PricingResolver $pricingResolver = null;

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

            $costError = null;
            try {
                $costUsd = $this->calculateCost($provider, $model, $inputTokens, $outputTokens);
            } catch (\Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException $e) {
                $costUsd = null;
                $costError = $e->getMessage();
                error_log('❌ [UsageTracker] PRICING_ERROR: ' . $costError);
            }

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                ':user_id' => $data['user_id'] ?? null,
                ':session_id' => $data['session_id'] ?? null,
                ':provider' => $provider,
                ':model' => $model,
                ':prompt_tokens' => $inputTokens,
                ':completion_tokens' => $outputTokens,
                ':total_tokens' => $inputTokens + $outputTokens,
                ':cost_usd' => $costUsd,
                ':response_time_ms' => $data['response_time_ms'] ?? 0,
                ':function_calls_count' => $data['function_calls_count'] ?? 0,
                ':status' => $data['status'] ?? 'success',
                ':error_message' => $costError !== null
                    ? trim((($data['error_message'] ?? '') . ' | PRICING_ERROR: ' . $costError))
                    : ($data['error_message'] ?? null),
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
        if ($this->pricingResolver === null) {
            $this->pricingResolver = new PricingResolver($this->pdo);
        }
        [$inPer1M, $outPer1M] = $this->pricingResolver->resolve($provider);
        $inputCost = ($inputTokens / 1_000_000) * $inPer1M;
        $outputCost = ($outputTokens / 1_000_000) * $outPer1M;
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
