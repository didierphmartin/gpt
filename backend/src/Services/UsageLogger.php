<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use PDOException;

/**
 * UsageLogger - Logs LLM API usage to database
 *
 * Manages two tables:
 * 1. llm_usage_transactions - Detailed log of every API call
 * 2. llm_usage_balance - Running totals and quotas per user/provider
 */
class UsageLogger
{
    private ?PDO $pdo;
    private bool $enabled;
    private ?array $connectionConfig = null;
    private ?\Quantis\AIPortfolioAssistant\Services\PricingResolver $pricingResolver = null;

    /**
     * Voice pricing per second (input/output) in USD
     * Rates as of March 2026
     */
    private const VOICE_PRICING = [
        'gemini' => [
            'input' => 0.00025,   // $0.00025/sec = $0.90/hour
            'output' => 0.0005,  // $0.0005/sec = $1.80/hour
        ],
        'grok' => [
            'input' => 0.0004,   // $0.0004/sec = $1.44/hour
            'output' => 0.0008,  // $0.0008/sec = $2.88/hour
        ],
    ];

    public function __construct(?PDO $pdo = null, bool $enabled = true, ?array $connectionConfig = null)
    {
        $this->pdo = $pdo;
        $this->enabled = $enabled && $pdo !== null;
        $this->connectionConfig = $connectionConfig;
    }

    /**
     * Ensure database connection is alive, reconnect if needed
     */
    private function ensureConnection(): void
    {
        if (!$this->pdo) {
            return;
        }

        try {
            // Test connection with a simple query
            $this->pdo->query('SELECT 1');
        } catch (PDOException $e) {
            // Connection lost, try to reconnect if we have config
            if ($this->connectionConfig) {
                error_log("🔄 [UsageLogger] Reconnecting to database...");
                $dsn = "mysql:host={$this->connectionConfig['host']};dbname={$this->connectionConfig['database']};charset={$this->connectionConfig['charset']}";
                $this->pdo = new PDO($dsn, $this->connectionConfig['username'], $this->connectionConfig['password'], [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false
                ]);
                error_log("✅ [UsageLogger] Reconnected successfully");
            } else {
                throw $e;
            }
        }
    }

    /**
     * Log a transaction to the database
     *
     * @param array $data Transaction data containing:
     *   - user_id (int, required)
     *   - provider (string, required)
     *   - model (string, required)
     *   - prompt_tokens (int)
     *   - completion_tokens (int)
     *   - session_id (string, optional)
     *   - conversation_id (int, optional)
     *   - response_time_ms (int, optional)
     *   - status (string: success|error|timeout|rate_limited)
     *   - error_message (string, optional)
     *   - function_calls_count (int, optional)
     *   - functions_called (array, optional)
     *   - request_metadata (array, optional)
     *   - is_voice_request (bool, optional) - Whether this is a voice/audio request
     *   - audio_input_seconds (float, optional) - Duration of input audio in seconds
     *   - audio_output_seconds (float, optional) - Duration of output audio in seconds
     *
     * @return int|null Transaction ID if successful, null otherwise
     */
    public function logTransaction(array $data): ?int
    {
        if (!$this->enabled) {
            return null;
        }

        try {
            // Check if connection is still alive, reconnect if needed
            $this->ensureConnection();
            // Extract and validate required fields
            $userId = $data['user_id'] ?? null;
            $provider = $data['provider'] ?? 'claude';
            $model = $data['model'] ?? 'claude-sonnet-4-5';
            $promptTokens = $data['prompt_tokens'] ?? 0;
            $completionTokens = $data['completion_tokens'] ?? 0;
            $totalTokens = $promptTokens + $completionTokens;

            if (!$userId) {
                error_log('⚠️ [UsageLogger] Missing user_id, skipping transaction log');
                return null;
            }

            // Voice request fields
            $isVoiceRequest = (bool) ($data['is_voice_request'] ?? false);
            $audioInputSeconds = $data['audio_input_seconds'] ?? null;
            $audioOutputSeconds = $data['audio_output_seconds'] ?? null;
            $audioDurationSeconds = null;

            if ($isVoiceRequest && ($audioInputSeconds !== null || $audioOutputSeconds !== null)) {
                $audioDurationSeconds = ($audioInputSeconds ?? 0) + ($audioOutputSeconds ?? 0);
            }

            // Calculate cost (voice or token-based)
            $costError = null;
            if ($isVoiceRequest) {
                $costUsd = $this->calculateVoiceCost($provider, $audioInputSeconds ?? 0, $audioOutputSeconds ?? 0);
            } else {
                try {
                    $costUsd = $this->calculateCost($provider, $model, $promptTokens, $completionTokens);
                } catch (\Quantis\AIPortfolioAssistant\Exceptions\PricingUnavailableException $e) {
                    $costUsd = null; // do NOT record a misleading $0
                    $costError = $e->getMessage();
                    error_log('❌ [UsageLogger] PRICING_ERROR: ' . $costError);
                }
            }

            // Prepare JSON fields
            $functionsCalled = isset($data['functions_called']) && is_array($data['functions_called'])
                ? json_encode($data['functions_called'])
                : null;

            $mcpToolsCalled = isset($data['mcp_tools_called']) && is_array($data['mcp_tools_called'])
                ? json_encode($data['mcp_tools_called'])
                : null;

            $mcpCallsCount = $data['mcp_calls_count'] ?? 0;

            // Debug logging for tool calls
            if ($functionsCalled || $mcpToolsCalled) {
                error_log("🔧 [UsageLogger] Tool calls - functions_called: " . ($functionsCalled ?: 'null') . ", mcp_tools_called: " . ($mcpToolsCalled ?: 'null') . ", function_calls_count: " . ($data['function_calls_count'] ?? 0));
            }

            $requestMetadata = isset($data['request_metadata']) && is_array($data['request_metadata'])
                ? json_encode($data['request_metadata'])
                : null;

            // Insert transaction
            $sql = "INSERT INTO llm_usage_transactions (
                user_id, session_id, conversation_id, provider, model,
                prompt_tokens, completion_tokens, total_tokens, cost_usd,
                response_time_ms, status, error_message,
                function_calls_count, functions_called, mcp_calls_count, mcp_tools_called,
                request_metadata,
                is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds
            ) VALUES (
                :user_id, :session_id, :conversation_id, :provider, :model,
                :prompt_tokens, :completion_tokens, :total_tokens, :cost_usd,
                :response_time_ms, :status, :error_message,
                :function_calls_count, :functions_called, :mcp_calls_count, :mcp_tools_called,
                :request_metadata,
                :is_voice_request, :audio_duration_seconds, :audio_input_seconds, :audio_output_seconds
            )";

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':session_id' => $data['session_id'] ?? null,
                ':conversation_id' => $data['conversation_id'] ?? null,
                ':provider' => $provider,
                ':model' => $model,
                ':prompt_tokens' => $promptTokens,
                ':completion_tokens' => $completionTokens,
                ':total_tokens' => $totalTokens,
                ':cost_usd' => $costUsd,
                ':response_time_ms' => $data['response_time_ms'] ?? null,
                ':status' => $data['status'] ?? 'success',
                ':error_message' => $costError !== null
                    ? trim((($data['error_message'] ?? '') . ' | PRICING_ERROR: ' . $costError))
                    : ($data['error_message'] ?? null),
                ':function_calls_count' => $data['function_calls_count'] ?? 0,
                ':functions_called' => $functionsCalled,
                ':mcp_calls_count' => $mcpCallsCount,
                ':mcp_tools_called' => $mcpToolsCalled,
                ':request_metadata' => $requestMetadata,
                ':is_voice_request' => $isVoiceRequest ? 1 : 0,
                ':audio_duration_seconds' => $audioDurationSeconds,
                ':audio_input_seconds' => $audioInputSeconds,
                ':audio_output_seconds' => $audioOutputSeconds,
            ]);

            $transactionId = (int) $this->pdo->lastInsertId();

            // Update balance ledger
            $this->updateBalance($userId, $provider, [
                'tokens' => $totalTokens,
                'cost' => $costUsd ?? 0,
                'success' => ($data['status'] ?? 'success') === 'success',
                'is_voice' => $isVoiceRequest,
                'audio_seconds' => $audioDurationSeconds ?? 0,
                'voice_cost' => $isVoiceRequest ? $costUsd : 0,
                'function_calls' => $data['function_calls_count'] ?? 0,
                'mcp_calls' => $mcpCallsCount,
            ]);

            $logMsg = "✅ [UsageLogger] Transaction logged: ID=$transactionId, User=$userId, Provider=$provider";
            if ($isVoiceRequest) {
                $logMsg .= ", Voice=true, AudioSec=" . number_format($audioDurationSeconds ?? 0, 2);
            } else {
                $logMsg .= ", Tokens=$totalTokens";
            }
            $logMsg .= ", Cost=$" . number_format($costUsd, 6);
            error_log($logMsg);

            return $transactionId;

        } catch (PDOException $e) {
            error_log("❌ [UsageLogger] Failed to log transaction: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Update balance ledger for a user/provider
     *
     * @param int $userId User ID
     * @param string $provider Provider name
     * @param array $data Update data (tokens, cost, success, is_voice, audio_seconds, voice_cost, function_calls, mcp_calls)
     */
    public function updateBalance(int|string|null $userId, string $provider, array $data): void
    {
        if (!$this->enabled || !$userId) {
            return;
        }

        try {
            $currentMonth = date('Y-m');
            $tokens = $data['tokens'] ?? 0;
            $cost = $data['cost'] ?? 0.0;
            $isSuccess = $data['success'] ?? true;
            $isVoice = $data['is_voice'] ?? false;
            $audioSeconds = $data['audio_seconds'] ?? 0;
            $voiceCost = $data['voice_cost'] ?? 0;
            $functionCalls = $data['function_calls'] ?? 0;
            $mcpCalls = $data['mcp_calls'] ?? 0;

            // Check if month needs reset
            $this->checkMonthReset($userId, $provider, $currentMonth);

            // Update balance (INSERT ... ON DUPLICATE KEY UPDATE)
            $sql = "INSERT INTO llm_usage_balance (
                user_id, provider,
                total_requests, successful_requests, failed_requests,
                total_function_calls, total_mcp_calls,
                total_voice_requests, total_audio_seconds, total_voice_cost_usd,
                total_tokens, total_cost_usd,
                month_requests, month_tokens, month_cost_usd,
                month_function_calls, month_mcp_calls,
                month_voice_requests, month_audio_seconds, month_voice_cost_usd,
                current_month
            ) VALUES (
                :user_id, :provider,
                1, :success, :failure,
                :func_calls, :mcp_calls,
                :voice_req, :audio_sec, :voice_cost,
                :tokens, :cost,
                1, :month_tokens, :month_cost,
                :month_func_calls, :month_mcp_calls,
                :month_voice_req, :month_audio_sec, :month_voice_cost,
                :current_month
            ) ON DUPLICATE KEY UPDATE
                total_requests = total_requests + 1,
                successful_requests = successful_requests + VALUES(successful_requests),
                failed_requests = failed_requests + VALUES(failed_requests),
                total_function_calls = total_function_calls + VALUES(total_function_calls),
                total_mcp_calls = total_mcp_calls + VALUES(total_mcp_calls),
                total_voice_requests = total_voice_requests + VALUES(total_voice_requests),
                total_audio_seconds = total_audio_seconds + VALUES(total_audio_seconds),
                total_voice_cost_usd = total_voice_cost_usd + VALUES(total_voice_cost_usd),
                total_tokens = total_tokens + VALUES(total_tokens),
                total_cost_usd = total_cost_usd + VALUES(total_cost_usd),
                month_requests = month_requests + 1,
                month_tokens = month_tokens + VALUES(month_tokens),
                month_cost_usd = month_cost_usd + VALUES(month_cost_usd),
                month_function_calls = month_function_calls + VALUES(month_function_calls),
                month_mcp_calls = month_mcp_calls + VALUES(month_mcp_calls),
                month_voice_requests = month_voice_requests + VALUES(month_voice_requests),
                month_audio_seconds = month_audio_seconds + VALUES(month_audio_seconds),
                month_voice_cost_usd = month_voice_cost_usd + VALUES(month_voice_cost_usd),
                current_month = VALUES(current_month)";

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                ':user_id' => $userId,
                ':provider' => $provider,
                ':success' => $isSuccess ? 1 : 0,
                ':failure' => $isSuccess ? 0 : 1,
                ':func_calls' => $functionCalls,
                ':mcp_calls' => $mcpCalls,
                ':voice_req' => $isVoice ? 1 : 0,
                ':audio_sec' => $audioSeconds,
                ':voice_cost' => $voiceCost,
                ':tokens' => $tokens,
                ':cost' => $cost,
                ':month_tokens' => $tokens,
                ':month_cost' => $cost,
                ':month_func_calls' => $functionCalls,
                ':month_mcp_calls' => $mcpCalls,
                ':month_voice_req' => $isVoice ? 1 : 0,
                ':month_audio_sec' => $audioSeconds,
                ':month_voice_cost' => $voiceCost,
                ':current_month' => $currentMonth,
            ]);

        } catch (PDOException $e) {
            error_log("❌ [UsageLogger] Failed to update balance: " . $e->getMessage());
        }
    }

    /**
     * Check if monthly counters need to be reset
     *
     * @param int $userId User ID
     * @param string $provider Provider name
     * @param string $currentMonth Current month (YYYY-MM)
     */
    private function checkMonthReset(int|string $userId, string $provider, string $currentMonth): void
    {
        try {
            // Check if record exists with different month
            $sql = "SELECT current_month FROM llm_usage_balance
                    WHERE user_id = :user_id AND provider = :provider";

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([':user_id' => $userId, ':provider' => $provider]);
            $result = $stmt->fetch(PDO::FETCH_ASSOC);

            // If month changed, reset monthly counters
            if ($result && $result['current_month'] !== $currentMonth) {
                $sql = "UPDATE llm_usage_balance SET
                    month_requests = 0,
                    month_tokens = 0,
                    month_cost_usd = 0.000000,
                    month_voice_requests = 0,
                    month_audio_seconds = 0.00,
                    month_voice_cost_usd = 0.000000,
                    current_month = :current_month
                    WHERE user_id = :user_id AND provider = :provider";

                $stmt = $this->pdo->prepare($sql);
                $stmt->execute([
                    ':current_month' => $currentMonth,
                    ':user_id' => $userId,
                    ':provider' => $provider,
                ]);

                error_log("🔄 [UsageLogger] Monthly counters reset for user=$userId, provider=$provider");
            }

        } catch (PDOException $e) {
            error_log("⚠️ [UsageLogger] Failed to check month reset: " . $e->getMessage());
        }
    }

    /**
     * Calculate cost in USD for token usage
     *
     * @param string $provider Provider name
     * @param string $model Model name
     * @param int $promptTokens Input tokens
     * @param int $completionTokens Output tokens
     * @return float Cost in USD
     */
    public function calculateCost(string $provider, string $model, int $promptTokens, int $completionTokens): float
    {
        if ($this->pricingResolver === null) {
            $this->pricingResolver = new \Quantis\AIPortfolioAssistant\Services\PricingResolver($this->pdo);
        }
        [$inPer1M, $outPer1M] = $this->pricingResolver->resolve($provider);
        $cost = ($promptTokens / 1_000_000) * $inPer1M + ($completionTokens / 1_000_000) * $outPer1M;
        return round($cost, 6);
    }

    /**
     * Calculate cost in USD for voice/audio usage
     *
     * @param string $provider Provider name (gemini or grok)
     * @param float $inputSeconds Input audio duration in seconds
     * @param float $outputSeconds Output audio duration in seconds
     * @return float Cost in USD
     */
    public function calculateVoiceCost(string $provider, float $inputSeconds, float $outputSeconds): float
    {
        // Get voice pricing for provider, fallback to Gemini rates
        $pricing = self::VOICE_PRICING[$provider]
            ?? self::VOICE_PRICING['gemini']
            ?? ['input' => 0.00025, 'output' => 0.0005];

        $inputCost = $inputSeconds * $pricing['input'];
        $outputCost = $outputSeconds * $pricing['output'];

        return round($inputCost + $outputCost, 6);
    }

    /**
     * Get usage balance for a user
     *
     * @param int $userId User ID
     * @param string|null $provider Optional provider filter
     * @return array Balance data
     */
    public function getBalance(int|string $userId, ?string $provider = null): array
    {
        if (!$this->enabled) {
            return [];
        }

        try {
            if ($provider) {
                $sql = "SELECT * FROM llm_usage_balance
                        WHERE user_id = :user_id AND provider = :provider";
                $stmt = $this->pdo->prepare($sql);
                $stmt->execute([':user_id' => $userId, ':provider' => $provider]);
                return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
            } else {
                $sql = "SELECT * FROM llm_usage_balance WHERE user_id = :user_id";
                $stmt = $this->pdo->prepare($sql);
                $stmt->execute([':user_id' => $userId]);
                return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            }
        } catch (PDOException $e) {
            error_log("❌ [UsageLogger] Failed to get balance: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get transaction history for a user
     *
     * @param int $userId User ID
     * @param array $filters Optional filters (provider, date_from, date_to, status)
     * @param int $limit Limit results
     * @param int $offset Offset for pagination
     * @return array Transaction records
     */
    public function getTransactions(int|string $userId, array $filters = [], int $limit = 100, int $offset = 0): array
    {
        if (!$this->enabled) {
            return [];
        }

        try {
            $sql = "SELECT * FROM llm_usage_transactions WHERE user_id = :user_id";
            $params = [':user_id' => $userId];

            // Apply filters
            if (isset($filters['provider'])) {
                $sql .= " AND provider = :provider";
                $params[':provider'] = $filters['provider'];
            }

            if (isset($filters['date_from'])) {
                $sql .= " AND created_at >= :date_from";
                $params[':date_from'] = $filters['date_from'];
            }

            if (isset($filters['date_to'])) {
                $sql .= " AND created_at < :date_to";
                $params[':date_to'] = $filters['date_to'];
            }

            if (isset($filters['status'])) {
                $sql .= " AND status = :status";
                $params[':status'] = $filters['status'];
            }

            $sql .= " ORDER BY created_at DESC LIMIT :limit OFFSET :offset";

            $stmt = $this->pdo->prepare($sql);

            // Bind limit and offset as integers
            foreach ($params as $key => $value) {
                $stmt->bindValue($key, $value);
            }
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);

            $stmt->execute();
            return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        } catch (PDOException $e) {
            error_log("❌ [UsageLogger] Failed to get transactions: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get aggregated statistics for a user
     *
     * @param int $userId User ID
     * @param string $period Period (day, week, month, year, all)
     * @param string|null $provider Optional provider filter
     * @return array Statistics
     */
    public function getStats(int|string $userId, string $period = 'month', ?string $provider = null): array
    {
        if (!$this->enabled) {
            return [];
        }

        try {
            $dateCondition = $this->getDateCondition($period);

            $sql = "SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed_requests,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost_usd) as total_cost,
                AVG(response_time_ms) as avg_response_time,
                MIN(response_time_ms) as min_response_time,
                MAX(response_time_ms) as max_response_time,
                SUM(function_calls_count) as total_function_calls,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as total_voice_requests,
                SUM(COALESCE(audio_duration_seconds, 0)) as total_audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as total_voice_cost
                FROM llm_usage_transactions
                WHERE user_id = :user_id {$dateCondition}";

            $params = [':user_id' => $userId];

            if ($provider) {
                $sql .= " AND provider = :provider";
                $params[':provider'] = $provider;
            }

            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);

            return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

        } catch (PDOException $e) {
            error_log("❌ [UsageLogger] Failed to get stats: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get date condition for SQL queries
     *
     * @param string $period Period (day, week, month, year, all)
     * @return string SQL WHERE condition
     */
    private function getDateCondition(string $period): string
    {
        return match ($period) {
            'day' => "AND DATE(created_at) = CURDATE()",
            'week' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
            'month' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
            'year' => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)",
            'all' => "",
            default => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
        };
    }
}
