<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Voice Controller
 *
 * Handles voice usage tracking for Grok and Gemini Live API sessions.
 * Frontend clients report voice session usage to this endpoint.
 * Also provides secure ephemeral token generation for client-side voice connections.
 */
class VoiceController
{
    private PDO $db;
    private array $config;
    private UsageLogger $usageLogger;
    private ?Client $httpClient = null;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->usageLogger = new UsageLogger($db, true, $config['contexts_database'] ?? $config['database'] ?? null);
    }

    /**
     * Get HTTP client (lazy initialization)
     */
    private function getHttpClient(): Client
    {
        if ($this->httpClient === null) {
            $this->httpClient = new Client([
                'timeout' => 30,
                'http_errors' => false,
            ]);
        }
        return $this->httpClient;
    }

    /**
     * Log voice usage from frontend clients
     *
     * Expected POST body:
     * {
     *   "provider": "gemini" | "grok",
     *   "model": "gemini-2.5-flash-native-audio-preview" | "grok-2-voice",
     *   "session_id": "optional-session-id",
     *   "audio_input_seconds": 12.5,
     *   "audio_output_seconds": 8.3,
     *   "status": "success" | "error",
     *   "error_message": "optional error message"
     * }
     */
    public function logUsage(array $request): array
    {
        try {
            $body = $request['body'] ?? [];
            $userId = $request['user_id'] ?? null;

            if (!$userId) {
                return [
                    'success' => false,
                    'error' => 'Authentication required',
                    'status_code' => 401
                ];
            }

            // Validate required fields
            $provider = $body['provider'] ?? null;
            if (!$provider || !in_array($provider, ['gemini', 'grok'])) {
                return [
                    'success' => false,
                    'error' => 'Invalid or missing provider. Must be "gemini" or "grok".',
                    'status_code' => 400
                ];
            }

            $audioInputSeconds = (float) ($body['audio_input_seconds'] ?? 0);
            $audioOutputSeconds = (float) ($body['audio_output_seconds'] ?? 0);

            if ($audioInputSeconds <= 0 && $audioOutputSeconds <= 0) {
                return [
                    'success' => false,
                    'error' => 'At least one of audio_input_seconds or audio_output_seconds must be > 0',
                    'status_code' => 400
                ];
            }

            // Determine model name
            $model = $body['model'] ?? $this->getDefaultVoiceModel($provider);

            // Log the transaction
            $transactionId = $this->usageLogger->logTransaction([
                'user_id' => $userId,
                'provider' => $provider,
                'model' => $model,
                'session_id' => $body['session_id'] ?? null,
                'prompt_tokens' => 0,
                'completion_tokens' => 0,
                'status' => $body['status'] ?? 'success',
                'error_message' => $body['error_message'] ?? null,
                'is_voice_request' => true,
                'audio_input_seconds' => $audioInputSeconds,
                'audio_output_seconds' => $audioOutputSeconds,
                'request_metadata' => [
                    'voice_session' => true,
                    'input_sample_rate' => $body['input_sample_rate'] ?? 16000,
                    'output_sample_rate' => $body['output_sample_rate'] ?? 24000,
                ],
            ]);

            // Calculate cost for response
            $cost = $this->usageLogger->calculateVoiceCost($provider, $audioInputSeconds, $audioOutputSeconds);

            return [
                'success' => true,
                'transaction_id' => $transactionId,
                'provider' => $provider,
                'model' => $model,
                'audio_duration_seconds' => $audioInputSeconds + $audioOutputSeconds,
                'audio_input_seconds' => $audioInputSeconds,
                'audio_output_seconds' => $audioOutputSeconds,
                'cost_usd' => $cost,
                'status_code' => 200
            ];

        } catch (\Exception $e) {
            error_log("❌ [VoiceController] Error logging voice usage: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to log voice usage: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get voice usage statistics for the current user
     */
    public function getStats(array $request): array
    {
        try {
            $userId = $request['user_id'] ?? null;

            if (!$userId) {
                return [
                    'success' => false,
                    'error' => 'Authentication required',
                    'status_code' => 401
                ];
            }

            $period = $request['query']['period'] ?? 'month';
            $provider = $request['query']['provider'] ?? null;

            // Get voice-specific stats
            $dateCondition = $this->getDateCondition($period);

            $sql = "SELECT
                COUNT(*) as total_voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,
                COALESCE(SUM(audio_input_seconds), 0) as total_input_seconds,
                COALESCE(SUM(audio_output_seconds), 0) as total_output_seconds,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(audio_duration_seconds), 0) as avg_session_seconds
            FROM llm_usage_transactions
            WHERE user_id = :user_id
                AND is_voice_request = 1
                {$dateCondition}";

            $params = [':user_id' => $userId];

            if ($provider) {
                $sql .= " AND provider = :provider";
                $params[':provider'] = $provider;
            }

            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            $stats = $stmt->fetch(PDO::FETCH_ASSOC);

            // Get breakdown by provider
            $breakdownSql = "SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                COALESCE(SUM(cost_usd), 0) as cost
            FROM llm_usage_transactions
            WHERE user_id = :user_id
                AND is_voice_request = 1
                {$dateCondition}
            GROUP BY provider";

            $stmt = $this->db->prepare($breakdownSql);
            $stmt->execute([':user_id' => $userId]);
            $byProvider = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return [
                'success' => true,
                'period' => $period,
                'stats' => [
                    'total_voice_requests' => (int) ($stats['total_voice_requests'] ?? 0),
                    'total_audio_seconds' => round((float) ($stats['total_audio_seconds'] ?? 0), 2),
                    'total_input_seconds' => round((float) ($stats['total_input_seconds'] ?? 0), 2),
                    'total_output_seconds' => round((float) ($stats['total_output_seconds'] ?? 0), 2),
                    'total_cost' => round((float) ($stats['total_cost'] ?? 0), 6),
                    'avg_session_seconds' => round((float) ($stats['avg_session_seconds'] ?? 0), 2),
                ],
                'by_provider' => array_map(function($p) {
                    return [
                        'provider' => $p['provider'],
                        'requests' => (int) $p['requests'],
                        'audio_seconds' => round((float) $p['audio_seconds'], 2),
                        'cost' => round((float) $p['cost'], 6),
                    ];
                }, $byProvider),
                'status_code' => 200
            ];

        } catch (\Exception $e) {
            error_log("❌ [VoiceController] Error getting voice stats: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to get voice stats: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Get default voice model name for a provider
     */
    private function getDefaultVoiceModel(string $provider): string
    {
        return match ($provider) {
            'gemini' => 'gemini-2.5-flash-native-audio-preview',
            'grok' => 'grok-2-voice',
            default => $provider . '-voice',
        };
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
            'all' => "",
            default => "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
        };
    }

    /**
     * Generate ephemeral token for Grok Voice (xAI Realtime API)
     *
     * This endpoint allows frontend clients to obtain a short-lived token
     * for connecting to the xAI realtime WebSocket API without exposing
     * the permanent API key in client-side code.
     *
     * POST /api/v1/voice/token
     * Body: { "provider": "grok" }
     *
     * Returns:
     * {
     *   "success": true,
     *   "provider": "grok",
     *   "client_secret": "ephemeral-token-here",
     *   "expires_at": "2024-01-15T12:00:00Z"
     * }
     */
    public function getEphemeralToken(array $request): array
    {
        try {
            $body = $request['body'] ?? [];
            $userId = $request['user_id'] ?? null;

            // Authentication is optional for voice token generation
            // but we log the user ID if available for tracking

            $provider = $body['provider'] ?? 'grok';

            // Currently only Grok supports ephemeral tokens
            if ($provider !== 'grok') {
                return [
                    'success' => false,
                    'error' => 'Ephemeral tokens are currently only supported for Grok provider',
                    'status_code' => 400
                ];
            }

            return $this->generateGrokEphemeralToken($userId !== null ? (string) $userId : null);

        } catch (\Exception $e) {
            error_log("❌ [VoiceController] Error generating ephemeral token: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to generate ephemeral token: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Generate Grok ephemeral token by calling xAI API
     */
    private function generateGrokEphemeralToken(?string $userId): array
    {
        $grokVoiceConfig = $this->config['grok_voice'] ?? [];
        $apiKey = $grokVoiceConfig['api_key'] ?? '';

        if (empty($apiKey)) {
            error_log("❌ [VoiceController] Grok voice API key not configured");
            return [
                'success' => false,
                'error' => 'Grok voice API key not configured on server',
                'status_code' => 500
            ];
        }

        $baseUrl = $grokVoiceConfig['base_url'] ?? 'https://api.x.ai';
        $endpoint = $grokVoiceConfig['client_secrets_endpoint'] ?? '/v1/realtime/client_secrets';

        try {
            $client = $this->getHttpClient();

            $response = $client->post($baseUrl . $endpoint, [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'Authorization' => 'Bearer ' . $apiKey,
                ],
                'json' => new \stdClass(), // Empty JSON object as per xAI docs
            ]);

            $statusCode = $response->getStatusCode();
            $responseBody = json_decode($response->getBody()->getContents(), true);

            if ($statusCode !== 200) {
                $errorMessage = $responseBody['error']['message'] ?? $responseBody['error'] ?? 'Unknown error';
                error_log("❌ [VoiceController] xAI API error: {$statusCode} - {$errorMessage}");
                return [
                    'success' => false,
                    'error' => "Failed to obtain ephemeral token: {$errorMessage}",
                    'status_code' => $statusCode
                ];
            }

            // Extract the client secret from response
            // xAI API returns: { "value": "xai-realtime-client-secret-...", "expires_at": ... }
            // or nested: { "client_secret": { "secret": "...", "expires_at": "..." } }
            $clientSecret = $responseBody['client_secret'] ?? $responseBody;
            $secret = $clientSecret['value'] ?? $clientSecret['secret'] ?? $clientSecret['client_secret'] ?? null;
            $expiresAt = $clientSecret['expires_at'] ?? null;

            if (empty($secret)) {
                error_log("❌ [VoiceController] No secret in xAI response: " . json_encode($responseBody));
                return [
                    'success' => false,
                    'error' => 'Invalid response from xAI API - no secret returned',
                    'status_code' => 500
                ];
            }

            // Log token generation for tracking (optional)
            if ($userId) {
                error_log("✅ [VoiceController] Generated Grok ephemeral token for user {$userId}");
            } else {
                error_log("✅ [VoiceController] Generated Grok ephemeral token (anonymous)");
            }

            return [
                'success' => true,
                'provider' => 'grok',
                'client_secret' => $secret,
                'expires_at' => $expiresAt,
                'voice' => $grokVoiceConfig['default_voice'] ?? 'Aria',
                'status_code' => 200
            ];

        } catch (GuzzleException $e) {
            error_log("❌ [VoiceController] HTTP error calling xAI API: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Network error while obtaining ephemeral token',
                'status_code' => 503
            ];
        }
    }

    /**
     * Get voice provider configuration (public info only, no API keys)
     *
     * GET /api/v1/voice/config
     * Query: ?provider=grok|gemini
     */
    public function getConfig(array $request): array
    {
        $provider = $request['query']['provider'] ?? 'grok';

        $configs = [
            'grok' => [
                'provider' => 'grok',
                'name' => 'Grok Voice',
                'voices' => ['Eve', 'Ara', 'Rex', 'Sal', 'Leo'],
                'voice_descriptions' => [
                    'Eve' => 'Female, energetic and upbeat (default)',
                    'Ara' => 'Female, warm and friendly',
                    'Rex' => 'Male, confident and clear',
                    'Sal' => 'Neutral, smooth and balanced',
                    'Leo' => 'Male, authoritative and strong',
                ],
                'default_voice' => $this->config['grok_voice']['default_voice'] ?? 'Eve',
                'supports_ephemeral_token' => true,
                'websocket_url' => 'wss://api.x.ai/v1/realtime',
            ],
            'gemini' => [
                'provider' => 'gemini',
                'name' => 'Gemini Voice',
                'voices' => ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'],
                'default_voice' => $this->config['gemini_voice']['default_voice'] ?? 'Zephyr',
                'model' => $this->config['gemini_voice']['model'] ?? 'gemini-2.5-flash-native-audio-preview',
                'supports_ephemeral_token' => false, // Gemini uses different auth
            ],
        ];

        if (!isset($configs[$provider])) {
            return [
                'success' => false,
                'error' => 'Unknown voice provider',
                'status_code' => 400
            ];
        }

        // Gemini has no ephemeral-token endpoint, so a browser client needs the
        // raw key to open a Live session. Only expose it to JWT users or to app
        // keys that explicitly carry the 'voice:config' scope (interim brokering
        // until per-user provider keys / login are in place).
        if ($provider === 'gemini') {
            $authType = $request['auth_type'] ?? null;
            $scopes   = (array) ($request['app_key_scopes'] ?? []);
            $mayReadKey = ($authType !== 'app_key') || in_array('voice:config', $scopes, true);
            if ($mayReadKey) {
                $configs['gemini']['api_key'] = $this->config['gemini_voice']['api_key'] ?? null;
            }
        }

        return [
            'success' => true,
            'config' => $configs[$provider],
            'status_code' => 200
        ];
    }
}
