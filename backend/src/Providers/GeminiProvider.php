<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Providers;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Contracts\AIProviderInterface;
use Quantis\AIPortfolioAssistant\Contracts\FunctionExecutorInterface;
use Quantis\AIPortfolioAssistant\Contracts\HttpRequestBuilderInterface;
use Quantis\AIPortfolioAssistant\Contracts\StreamingClientInterface;
use Quantis\AIPortfolioAssistant\Contracts\UsageTrackerInterface;
use Quantis\AIPortfolioAssistant\Exceptions\ProviderException;
use Quantis\AIPortfolioAssistant\Providers\Traits\ProviderRequestBuilderTrait;
use Quantis\AIPortfolioAssistant\Services\DebugLogger;

/**
 * Google Gemini Provider
 *
 * Gemini uses a different API format than OpenAI:
 * - API key passed as query parameter
 * - Different request/response structure
 */
class GeminiProvider implements AIProviderInterface, HttpRequestBuilderInterface
{
    use ProviderRequestBuilderTrait;
    use \Quantis\AIPortfolioAssistant\Providers\Traits\ClientSideToolsTrait;

    private Configuration $config;
    private Client $httpClient;
    private ?FunctionExecutorInterface $functionExecutor = null;
    private ?UsageTrackerInterface $usageTracker = null;
    private ?StreamingClientInterface $sseClient = null;
    private ?DebugLogger $logger = null;

    private string $model;
    private int $maxTokens;
    private float $temperature;
    private string $baseUrl;
    private string $apiKey;
    private int $maxRecursionDepth;

    /**
     * Output schema for constrained decoding via Gemini's responseSchema.
     */
    private ?array $pendingOutputSchema = null;

    // Keep this list in sync with backend/resources/model_catalog.json's
    // `gemini` array. Catalog is the user-facing source of truth (admin
    // dropdown + Settings panel pricing); this constant is the runtime
    // allow-list that the provider uses to validate model selections.
    // Diverging the two leads to "model X is in the dropdown but the
    // backend rejects it" — confusing for admins who just configured it.
    private const SUPPORTED_MODELS = [
        // Gemini 3 (preview)
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3-flash-lite-preview',
        // Gemini 2.5
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        // Gemini 2.0
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        // Gemini 1.5 (legacy — kept for backwards-compatibility with users
        // who set up before Gemini 2.x existed)
        'gemini-1.5-flash',
        'gemini-1.5-pro',
    ];

    public function __construct(Configuration $config)
    {
        $this->config = $config;

        // Get Gemini config from providers section
        $geminiConfig = $config->get('providers.gemini', []);

        $this->model = $geminiConfig['model'] ?? 'gemini-2.5-flash';
        $this->maxTokens = $geminiConfig['max_tokens'] ?? 4096;
        $this->temperature = $geminiConfig['temperature'] ?? 0.7;
        $this->baseUrl = rtrim($geminiConfig['base_url'] ?? 'https://generativelanguage.googleapis.com/v1beta', '/');
        $this->apiKey = $geminiConfig['api_key'] ?? '';
        $this->maxRecursionDepth = $config->get('max_recursion_depth', 10);

        $this->httpClient = new Client([
            'timeout' => 600, // 10 minutes for large responses
        ]);

        if ($config->isDebugEnabled()) {
            $this->logger = new DebugLogger(true);
        }
    }

    public function setFunctionExecutor(FunctionExecutorInterface $executor): self
    {
        $this->functionExecutor = $executor;
        return $this;
    }

    public function setUsageTracker(UsageTrackerInterface $tracker): self
    {
        $this->usageTracker = $tracker;
        return $this;
    }

    public function setSSEClient(StreamingClientInterface $client): self
    {
        $this->sseClient = $client;
        return $this;
    }

    public function setLogger(DebugLogger $logger): self
    {
        $this->logger = $logger;
        return $this;
    }

    public function getName(): string
    {
        return 'gemini';
    }

    public function isAvailable(): bool
    {
        return !empty($this->apiKey);
    }

    public function getModel(): string
    {
        return $this->model;
    }

    public function setModel(string $model): self
    {
        $this->model = $model;
        return $this;
    }

    public function getSupportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    public function chat(
        string $message,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $startTime = microtime(true);

        $this->sendProgress("Preparing Gemini request...");

        $systemPrompt = $this->buildSystemPrompt($options);
        // Honor caller-supplied tools (e.g. workflow client-side run_skill_script)
        // regardless of functionExecutor — client tools run in the browser. The
        // gate only governs this provider's OWN server tools (getTools()).
        $tools = $options['tools'] ?? ($this->functionExecutor ? $this->getTools() : []);
        $userId = $options['user_id'] ?? null;

        // Register client-side tool names so isClientSideTool() works during this request
        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        // Append client tools in source shape — convertToGeminiTools() will map input_schema → parameters
        if (!empty($options['client_tools']) && is_array($options['client_tools'])) {
            foreach ($options['client_tools'] as $ct) {
                $tools[] = [
                    'name'         => $ct['name'],
                    'description'  => $ct['description'] ?? '',
                    'input_schema' => $ct['input_schema'] ?? ['type' => 'object', 'properties' => new \stdClass()],
                ];
            }
        }

        // Stash output_schema for makeRequest()
        $this->pendingOutputSchema = !empty($options['output_schema']) && is_array($options['output_schema'])
            ? $options['output_schema']
            : null;

        // Build Gemini-format messages
        $contents = $this->buildContents(
            $conversationHistory,
            $message,
            $options['image_attachments'] ?? [],
            $options['pdf_attachments'] ?? []
        );

        // Make initial request
        $response = $this->makeRequest($contents, $systemPrompt, $tools);

        // Debug: Log full response for troubleshooting
        error_log("[Gemini] FULL RESPONSE: " . json_encode($response));

        // Track tokens and tool calls
        $inputTokens = $response['usageMetadata']['promptTokenCount'] ?? 0;
        $outputTokens = $response['usageMetadata']['candidatesTokenCount'] ?? 0;
        $this->emitContextWarningIfHigh($inputTokens);
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        // Handle function calls recursively
        $hasCalls = $this->hasFunctionCalls($response);
        error_log("[Gemini] Has function calls: " . ($hasCalls ? 'YES' : 'NO'));

        if ($hasCalls) {
            $this->sendProgress("Processing function calls...");

            $response = $this->handleFunctionCallsRecursive(
                $response,
                $contents,
                $systemPrompt,
                $tools,
                $userId,
                $inputTokens,
                $outputTokens,
                $functionCallCount,
                $functionsCalled,
                $mcpToolsCalled
            );

            error_log("[Gemini] After function calls, response: " . json_encode($response['candidates'][0]['content'] ?? 'none'));
        }

        // B3 short-circuit: surface client-side tool call to frontend.
        if (!empty($response['_pending_client_tool_call'])) {
            $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);
            $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);
            return [
                'text' => $response['_pending_assistant_text'] ?? '',
                'usage' => [
                    'input_tokens' => $inputTokens,
                    'output_tokens' => $outputTokens,
                    'total_tokens' => $inputTokens + $outputTokens,
                    'function_calls' => $functionCallCount,
                ],
                'model' => $this->model,
                'provider' => 'gemini',
                'functions_called' => $functionsCalled,
                'mcp_tools_called' => $mcpToolsCalled,
                'mcp_calls_count' => count($mcpToolsCalled),
                'pending_client_tool_call' => true,
                'pending_tool_calls' => $response['_pending_tool_calls'] ?? [],
            ];
        }

        // Emit truncation warning if model hit max output tokens
        $this->emitUsageWarningIfTruncated(
            $response['candidates'][0]['finishReason'] ?? '',
            $outputTokens
        );

        // Extract final text response
        $textResponse = $this->extractTextResponse($response);
        error_log("[Gemini] Extracted text length: " . strlen($textResponse));

        // Detect empty response issue (Gemini sometimes returns empty with tools)
        if (empty($textResponse) && !$hasCalls) {
            $finishReason = $response['candidates'][0]['finishReason'] ?? 'UNKNOWN';
            error_log("[Gemini] WARNING: Empty response with finishReason={$finishReason}, retrying without tools...");

            // Retry without tools as fallback
            $retryResponse = $this->makeRequest($contents, $systemPrompt, []);
            $textResponse = $this->extractTextResponse($retryResponse);

            if (empty($textResponse)) {
                $textResponse = "I apologize, but I couldn't generate a response. Please try rephrasing your question.";
                error_log("[Gemini] Retry also failed, returning fallback message");
            } else {
                error_log("[Gemini] Retry without tools succeeded, text length: " . strlen($textResponse));
            }
        }

        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        // Track usage
        $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);

        $this->sendProgress("Response ready.");

        // Clear pending schema state
        $this->pendingOutputSchema = null;

        return [
            'text' => $textResponse,
            'usage' => [
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'total_tokens' => $inputTokens + $outputTokens,
                'function_calls' => $functionCallCount,
            ],
            'model' => $this->model,
            'provider' => 'gemini',
            'functions_called' => $functionsCalled,
            'mcp_tools_called' => $mcpToolsCalled,
            'mcp_calls_count' => count($mcpToolsCalled),
        ];
    }

    public function streamChat(
        string $message,
        callable $onChunk,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $result = $this->chat($message, $conversationHistory, $options);
        $onChunk($result['text']);
        return $result;
    }

    private function makeRequest(array $contents, string $systemPrompt, array $tools = []): array
    {
        $this->sendProgress("Connecting to Gemini API...");

        if (empty($this->apiKey)) {
            throw ProviderException::authenticationFailed('gemini');
        }

        // Gemini API URL format with API key as query parameter
        $url = "{$this->baseUrl}/models/{$this->model}:generateContent?key={$this->apiKey}";

        $payload = [
            'contents' => $contents,
            'generationConfig' => [
                'maxOutputTokens' => $this->maxTokens,
                'temperature' => $this->temperature,
            ],
        ];

        // Constrained decoding via Gemini's controlled generation.
        // Note: Gemini does not allow tools + responseSchema in the same call.
        if ($this->pendingOutputSchema !== null && empty($tools)) {
            $schema = $this->pendingOutputSchema;
            $payload['generationConfig']['responseMimeType'] = 'application/json';
            $payload['generationConfig']['responseSchema'] = $this->sanitizeSchemaForGemini(
                $schema['schema'] ?? new \stdClass()
            );
        } elseif ($this->pendingOutputSchema !== null) {
            // Falling back to a strong system-prompt nudge when tools are present
            $schemaJson = json_encode($this->pendingOutputSchema['schema'] ?? new \stdClass());
            $systemPrompt .= "\n\n## Required output format\n"
                . "Your final response MUST be a single JSON object that conforms to this JSON Schema (no prose, no markdown):\n"
                . $schemaJson;
        }

        // Add system instruction
        if (!empty($systemPrompt)) {
            $payload['systemInstruction'] = [
                'parts' => [['text' => $systemPrompt]]
            ];
        }

        // Add tools if available
        if (!empty($tools)) {
            $geminiTools = $this->convertToGeminiTools($tools);
            $payload['tools'] = $geminiTools;

            // Add toolConfig - AUTO allows model to choose between text and function calls
            $payload['toolConfig'] = [
                'functionCallingConfig' => [
                    'mode' => 'AUTO'
                ]
            ];

            error_log("[Gemini] Sending " . count($tools) . " tools with AUTO mode");
        }

        // DEBUG: Log the exact contents being sent
        error_log("[Gemini] REQUEST PAYLOAD contents: " . json_encode($payload['contents']));

        $this->logger?->logApiRequest('gemini', $url, $payload);

        try {
            $response = $this->httpClient->post($url, [
                'headers' => [
                    'Content-Type' => 'application/json',
                ],
                'json' => $payload,
            ]);

            $body = json_decode($response->getBody()->getContents(), true);
            $this->logger?->logApiResponse('gemini', 200, 0);

            return $body;
        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();
            $message = $e->getMessage();

            // Log the full error for debugging
            error_log("[Gemini] API error (code {$statusCode}): {$message}");

            // Try to extract the response body for more details
            if (method_exists($e, 'getResponse') && $e->getResponse()) {
                $errorBody = $e->getResponse()->getBody()->getContents();
                error_log("[Gemini] Error response body: {$errorBody}");
            }

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('gemini');
            }

            if ($statusCode === 401 || $statusCode === 403) {
                throw ProviderException::authenticationFailed('gemini');
            }

            throw ProviderException::apiError('gemini', $message, $statusCode);
        }
    }

    /**
     * Recursively strip JSON Schema fields that Gemini's responseSchema does
     * not accept (e.g. additionalProperties, $schema, definitions, $ref).
     */
    private function sanitizeSchemaForGemini($schema)
    {
        if (!is_array($schema)) {
            return $schema;
        }

        $disallowed = [
            'additionalProperties', '$schema', '$id', '$ref', '$defs',
            'definitions', 'oneOf', 'anyOf', 'allOf', 'not',
            'patternProperties', 'unevaluatedProperties',
        ];

        $clean = [];
        foreach ($schema as $key => $value) {
            if (in_array($key, $disallowed, true)) {
                continue;
            }
            if ($key === 'type' && is_string($value)) {
                // Gemini expects uppercase types
                $clean[$key] = strtoupper($value);
            } elseif ($key === 'properties' && is_array($value)) {
                $clean[$key] = [];
                foreach ($value as $propName => $propSchema) {
                    $clean[$key][$propName] = $this->sanitizeSchemaForGemini($propSchema);
                }
            } elseif ($key === 'items' && is_array($value)) {
                $clean[$key] = $this->sanitizeSchemaForGemini($value);
            } else {
                $clean[$key] = $value;
            }
        }

        return $clean;
    }

    private function handleFunctionCallsRecursive(
        array $response,
        array &$contents,
        string $systemPrompt,
        array $tools,
        string|int|null $userId,
        int &$inputTokens,
        int &$outputTokens,
        int &$functionCallCount,
        array &$functionsCalled,
        array &$mcpToolsCalled,
        int $depth = 0
    ): array {
        if ($depth >= $this->maxRecursionDepth) {
            $this->logger?->warning("Max recursion depth reached", ['depth' => $depth]);
            return $response;
        }

        // Handle stdClass in response
        $candidates = $response['candidates'] ?? [];
        if (is_object($candidates)) {
            $candidates = json_decode(json_encode($candidates), true);
        }
        $candidate = $candidates[0] ?? [];
        if (is_object($candidate)) {
            $candidate = json_decode(json_encode($candidate), true);
        }
        $content = $candidate['content'] ?? [];
        if (is_object($content)) {
            $content = json_decode(json_encode($content), true);
        }
        $parts = $content['parts'] ?? [];
        if (is_object($parts)) {
            $parts = json_decode(json_encode($parts), true);
        }

        $functionCalls = [];
        $functionResults = [];
        // Track each functionCall's per-part thoughtSignature alongside it
        // (Gemini 2.5+ requires this to be re-emitted on the next turn or
        // the API rejects the request with "Function call is missing a
        // thought_signature").
        $functionCallSignatures = [];

        foreach ($parts as $part) {
            if (is_object($part)) {
                $part = json_decode(json_encode($part), true);
            }
            if (isset($part['functionCall'])) {
                $fc = $part['functionCall'];
                if (is_object($fc)) {
                    $fc = json_decode(json_encode($fc), true);
                }
                $functionCalls[] = $fc;
                $functionCallSignatures[] = $part['thoughtSignature'] ?? null;
            }
        }

        if (empty($functionCalls)) {
            return $response;
        }

        // B3: surface solo client-side tool turns to the frontend. The
        // detection mirrors Claude/OpenAI but the input shape is Gemini's
        // (no id field — synthesize one so the frontend can correlate
        // tool_use → tool_result on the round-trip).
        $clientCalls = [];
        $clientCallSignatures = [];
        $serverCalls = [];
        foreach ($functionCalls as $i => $fc) {
            if ($this->isClientSideTool($fc['name'] ?? '')) {
                $clientCalls[] = $fc;
                $clientCallSignatures[] = $functionCallSignatures[$i] ?? null;
            } else {
                $serverCalls[] = $fc;
            }
        }
        if (!empty($clientCalls) && empty($serverCalls)) {
            // Pre-tool text from any text parts in this assistant turn.
            $assistantText = '';
            foreach ($parts as $p) {
                if (is_object($p)) $p = json_decode(json_encode($p), true);
                if (isset($p['text'])) $assistantText .= $p['text'];
            }
            $normalized = [];
            foreach ($clientCalls as $i => $fc) {
                $args = $fc['args'] ?? [];
                if (is_object($args)) $args = json_decode(json_encode($args), true) ?? [];
                $entry = [
                    // Synthesize an id — Gemini doesn't supply one, but
                    // the frontend round-trip protocol needs a stable
                    // identifier to bind tool_use ↔ tool_result.
                    'id'    => 'gemini_' . substr(bin2hex(random_bytes(8)), 0, 16),
                    'name'  => $fc['name'] ?? '',
                    'input' => $args,
                ];
                // Preserve thoughtSignature so the frontend can put it
                // back on the assistant tool_calls turn it synthesizes
                // for the second-shot conversation_history. Gemini 2.5+
                // checks for this on every functionCall part.
                if (!empty($clientCallSignatures[$i])) {
                    $entry['thought_signature'] = $clientCallSignatures[$i];
                }
                $normalized[] = $entry;
            }
            error_log("🔧 [GeminiProvider] Client-side tool call detected; surfacing to frontend: " . json_encode(array_column($normalized, 'name')));
            $marker = $this->emitClientToolCallEvent($normalized, $assistantText);
            foreach ($clientCalls as $fc) {
                $functionCallCount++;
                $functionsCalled[] = $fc['name'] ?? '';
            }
            return array_merge($response, $marker);
        }
        if (!empty($clientCalls)) {
            error_log("⚠️ [GeminiProvider] Mixed client/server function calls in one turn — failing client-side calls.");
        }

        // Convert model's functionCall response to request format
        // Response uses camelCase (functionCall, args), but request might need different format
        $modelParts = [];
        foreach ($parts as $part) {
            if (is_object($part)) {
                $part = json_decode(json_encode($part), true);
            }
            if (isset($part['functionCall'])) {
                $fc = $part['functionCall'];
                // Keep the full functionCall including thoughtSignature at part level
                $modelPart = [
                    'functionCall' => [
                        'name' => $fc['name'] ?? '',
                        'args' => !empty($fc['args']) ? (object)$fc['args'] : new \stdClass()
                    ]
                ];
                // Include thoughtSignature if present (required for Gemini 2.5+)
                if (isset($part['thoughtSignature'])) {
                    $modelPart['thoughtSignature'] = $part['thoughtSignature'];
                }
                $modelParts[] = $modelPart;
            }
        }

        $contents[] = [
            'role' => 'model',
            'parts' => $modelParts
        ];

        error_log("[Gemini] Model parts being sent: " . json_encode($modelParts));

        // Execute each function call
        foreach ($functionCalls as $call) {
            if (is_object($call)) {
                $call = json_decode(json_encode($call), true);
            }
            $functionCallCount++;
            $functionName = $call['name'] ?? '';
            $arguments = $call['args'] ?? [];
            if (is_object($arguments)) {
                $arguments = json_decode(json_encode($arguments), true);
            }

            // Mixed-turn fallback for client-side tools: emit a synthetic
            // error functionResponse and continue. The all-client branch
            // above already short-circuits the common case.
            if ($this->isClientSideTool($functionName)) {
                $functionResults[] = [
                    'functionResponse' => [
                        'name' => $functionName,
                        'response' => [
                            'error' => 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                        ],
                    ],
                ];
                $functionsCalled[] = $functionName;
                continue;
            }

            // Track tool name and check if it's an MCP tool
            $functionsCalled[] = $functionName;
            if ($this->functionExecutor && $this->functionExecutor->isMCPTool($functionName)) {
                $mcpToolsCalled[] = $functionName;
            }

            $this->sendProgress("Executing function: {$functionName}");
            $this->logger?->debug("Executing tool", ['name' => $functionName, 'input' => $arguments]);

            // Execute the function
            $result = $this->executeFunction($functionName, $arguments, $userId);

            // Clean result for Gemini - remove internal metadata like _mcp_ui
            $cleanResult = $result;
            unset($cleanResult['_mcp_ui']);
            unset($cleanResult['_meta']);

            $functionResults[] = [
                'functionResponse' => [
                    'name' => $functionName,
                    'response' => $cleanResult
                ]
            ];
        }

        // Add function results to contents with role 'tool' (not 'user')
        $contents[] = [
            'role' => 'tool',
            'parts' => $functionResults
        ];

        error_log("[Gemini] Function results being sent with role 'tool': " . json_encode($functionResults));
        error_log("[Gemini] Full contents count: " . count($contents));

        // Make continuation request
        $this->sendProgress("Processing Gemini response...");
        $continuationResponse = $this->makeRequest($contents, $systemPrompt, $tools);

        // Accumulate tokens
        $inputTokens += $continuationResponse['usageMetadata']['promptTokenCount'] ?? 0;
        $outputTokens += $continuationResponse['usageMetadata']['candidatesTokenCount'] ?? 0;

        // Check if there are more function calls
        if ($this->hasFunctionCalls($continuationResponse)) {
            return $this->handleFunctionCallsRecursive(
                $continuationResponse,
                $contents,
                $systemPrompt,
                $tools,
                $userId,
                $inputTokens,
                $outputTokens,
                $functionCallCount,
                $functionsCalled,
                $mcpToolsCalled,
                $depth + 1
            );
        }

        return $continuationResponse;
    }

    private function executeFunction(string $functionName, array $parameters, string|int|null $userId): array
    {
        if (!$this->functionExecutor) {
            return ['error' => 'No function executor configured'];
        }

        try {
            $startTime = microtime(true);
            $result = $this->functionExecutor->execute($functionName, $parameters, $userId);
            $executionTime = (int) ((microtime(true) - $startTime) * 1000);

            $this->logger?->logFunctionCall($functionName, $parameters, $executionTime, true);

            // If MCP tool has UI, send SSE event to frontend
            if (isset($result['_mcp_ui']) && $this->sseClient) {
                $this->sseClient->sendCustomEvent('mcp_ui', [
                    'tool_name' => $functionName,
                    'ui_info' => $result['_mcp_ui']
                ]);
                error_log("📺 [MCP] Sent UI event to frontend for tool: {$functionName}");
            }

            return $result;
        } catch (\Throwable $e) {
            $this->logger?->logFunctionCall($functionName, $parameters, 0, false);
            return ['error' => $e->getMessage()];
        }
    }

    private function hasFunctionCalls(array $response): bool
    {
        $candidates = $response['candidates'] ?? [];
        if (is_object($candidates)) {
            $candidates = json_decode(json_encode($candidates), true);
        }
        $candidate = $candidates[0] ?? [];
        if (is_object($candidate)) {
            $candidate = json_decode(json_encode($candidate), true);
        }
        $content = $candidate['content'] ?? [];
        if (is_object($content)) {
            $content = json_decode(json_encode($content), true);
        }
        $parts = $content['parts'] ?? [];
        if (is_object($parts)) {
            $parts = json_decode(json_encode($parts), true);
        }

        foreach ($parts as $part) {
            if (is_object($part)) {
                $part = (array) $part;
            }
            if (isset($part['functionCall'])) {
                return true;
            }
        }

        return false;
    }

    private function extractTextResponse(array $response): string
    {
        $candidates = $response['candidates'] ?? [];
        if (is_object($candidates)) {
            $candidates = json_decode(json_encode($candidates), true);
        }
        $candidate = $candidates[0] ?? [];
        if (is_object($candidate)) {
            $candidate = json_decode(json_encode($candidate), true);
        }
        $content = $candidate['content'] ?? [];
        if (is_object($content)) {
            $content = json_decode(json_encode($content), true);
        }
        $parts = $content['parts'] ?? [];
        if (is_object($parts)) {
            $parts = json_decode(json_encode($parts), true);
        }

        $textParts = [];
        foreach ($parts as $part) {
            if (is_object($part)) {
                $part = (array) $part;
            }
            if (isset($part['text'])) {
                $textParts[] = $part['text'];
            }
        }

        return implode("\n", $textParts);
    }

    private function buildContents(array $conversationHistory, string $newMessage, array $imageAttachments = [], array $pdfAttachments = []): array
    {
        $contents = [];

        // Add conversation history
        foreach ($conversationHistory as $msg) {
            // Handle stdClass objects
            if (is_object($msg)) {
                $msg = (array) $msg;
            }
            $msgRole = $msg['role'] ?? 'user';

            // B3: tool_result turns from a prior client-side dispatch.
            // Translate to Gemini's functionResponse part so the model can
            // bind its prior functionCall to our follow-up. Gemini's
            // production handleFunctionCallsRecursive uses role 'user' for
            // functionResponse parts; matching that here so the model
            // recognizes our reply (otherwise it loops, calling the
            // tool over and over because it never "sees" the result).
            if ($msgRole === 'tool' && !empty($msg['tool_call_id'])) {
                $contents[] = [
                    'role' => 'user',
                    'parts' => [[
                        'functionResponse' => [
                            'name' => $msg['name'] ?? 'function',
                            'response' => ['result' => is_string($msg['content'] ?? null)
                                ? $msg['content']
                                : json_encode($msg['content'] ?? null)],
                        ],
                    ]],
                ];
                continue;
            }

            // B3: assistant turns carrying tool_calls (the LLM's own
            // tool_use from the prior round). Re-emit as functionCall
            // parts alongside any text so Gemini sees its own call ids.
            if ($msgRole === 'assistant' && !empty($msg['tool_calls'])) {
                $parts = [];
                $textContent = $this->extractTextFromContent($msg['content'] ?? '');
                if (!empty(trim($textContent))) {
                    $parts[] = ['text' => $textContent];
                }
                foreach ($msg['tool_calls'] as $tc) {
                    $args = $tc['function']['arguments'] ?? $tc['input'] ?? [];
                    if (is_string($args)) {
                        $decoded = json_decode($args, true);
                        $args = is_array($decoded) ? $decoded : [];
                    }
                    $part = [
                        'functionCall' => [
                            'name' => $tc['function']['name'] ?? $tc['name'] ?? '',
                            'args' => empty($args) ? new \stdClass() : (object) $args,
                        ],
                    ];
                    // Re-emit thoughtSignature at part level — Gemini 2.5+
                    // rejects the request without it (matches the format
                    // the working in-flight handleFunctionCallsRecursive
                    // path uses for continuation turns).
                    if (!empty($tc['thought_signature'])) {
                        $part['thoughtSignature'] = $tc['thought_signature'];
                    }
                    $parts[] = $part;
                }
                if (!empty($parts)) {
                    $contents[] = ['role' => 'model', 'parts' => $parts];
                }
                continue;
            }

            $role = $msgRole === 'assistant' ? 'model' : 'user';
            $content = $msg['content'] ?? '';
            if (is_object($content)) {
                $content = (array) $content;
            }
            // Plain text turns: extract text, skip empties.
            $textContent = $this->extractTextFromContent($content);
            if (!empty($textContent)) {
                $contents[] = [
                    'role' => $role,
                    'parts' => [['text' => $textContent]]
                ];
            }
        }

        // B3 continuation case: the second shot of a client-tool round
        // arrives with the tool_result already at the tail and an empty
        // newMessage. Don't append an empty user turn — Gemini would
        // reject it.
        $lastContent = !empty($contents) ? $contents[count($contents) - 1] : null;
        $lastIsFunctionResponse = $lastContent
            && ($lastContent['role'] ?? '') === 'user'
            && !empty($lastContent['parts'])
            && isset($lastContent['parts'][0]['functionResponse']);
        $isToolResultContinuation = empty(trim($newMessage))
            && empty($imageAttachments)
            && empty($pdfAttachments)
            && $lastIsFunctionResponse;
        if ($isToolResultContinuation) {
            return $contents;
        }

        // Build the current user turn. PDFs and images both ride in
        // `inline_data` parts, distinguished by mime_type (Gemini handles both
        // natively from the same shape).
        $parts = [['text' => $newMessage]];
        foreach ($pdfAttachments as $pdf) {
            $parts[] = [
                'inline_data' => [
                    'mime_type' => $pdf['mime_type'],
                    'data' => $pdf['data'],
                ],
            ];
        }
        foreach ($imageAttachments as $img) {
            $parts[] = [
                'inline_data' => [
                    'mime_type' => $img['mime_type'],
                    'data' => $img['data'],
                ],
            ];
        }
        $contents[] = [
            'role' => 'user',
            'parts' => $parts,
        ];

        return $contents;
    }

    /**
     * Extract text from content (handles string, array, and stdClass formats)
     */
    private function extractTextFromContent($content): string
    {
        if (is_string($content)) {
            return $content;
        }

        // Convert stdClass to array
        if (is_object($content)) {
            $content = json_decode(json_encode($content), true);
        }

        if (is_array($content)) {
            $textParts = [];
            foreach ($content as $block) {
                if (is_object($block)) {
                    $block = json_decode(json_encode($block), true);
                }
                if (is_array($block) && isset($block['text'])) {
                    $textParts[] = $block['text'];
                } elseif (is_string($block)) {
                    $textParts[] = $block;
                }
            }
            return implode("\n", $textParts);
        }

        return '';
    }

    private function convertToGeminiTools(array $claudeTools): array
    {
        $functions = [];

        foreach ($claudeTools as $tool) {
            // Handle stdClass objects (from MCP tools)
            if (is_object($tool)) {
                $tool = json_decode(json_encode($tool), true);
            }

            $inputSchema = $tool['input_schema'] ?? ['type' => 'object', 'properties' => (object)[]];

            // Handle stdClass input_schema
            if (is_object($inputSchema)) {
                $inputSchema = json_decode(json_encode($inputSchema), true);
            }

            // Fix and validate schema for Gemini
            $inputSchema = $this->fixSchemaForGemini($inputSchema);

            $functions[] = [
                'name' => $tool['name'],
                'description' => $tool['description'] ?? '',
                'parameters' => $inputSchema,
            ];
        }

        error_log("[Gemini] Sending " . count($functions) . " tools: " . implode(', ', array_column($functions, 'name')));

        // Log first tool schema for debugging
        if (!empty($functions)) {
            error_log("[Gemini] First tool schema sample: " . json_encode($functions[0]));
        }

        return [['functionDeclarations' => $functions]];
    }

    /**
     * Fix schema to be valid for Gemini API
     * - Removes unsupported fields ($schema, additionalProperties, etc.)
     * - Ensures all properties have a type
     * - Converts empty schemas to string type
     * - Handles stdClass conversion
     *
     * Note: This method is static to allow use from both instance and static contexts.
     * The trait ProviderRequestBuilderTrait also has this method, but class methods
     * take precedence over trait methods in PHP.
     */
    protected static function fixSchemaForGemini($schema): array
    {
        // Convert stdClass to array
        if (is_object($schema)) {
            $schema = (array) $schema;
        }

        // Empty or non-array schema defaults to string
        if (!is_array($schema) || empty($schema)) {
            return ['type' => 'string'];
        }

        // Remove fields not supported by Gemini
        $unsupportedFields = [
            '$schema', '$id', '$ref', '$defs', 'additionalProperties',
            'definitions', 'examples', 'default', 'const', 'title', 'format',
            'nullable', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs',
            'xml', 'discriminator', 'minLength', 'maxLength', 'pattern',
            'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
            'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
        ];
        foreach ($unsupportedFields as $field) {
            unset($schema[$field]);
        }

        // Ensure type exists
        if (!isset($schema['type'])) {
            $schema['type'] = 'string';
        }

        // Convert enum to description (Gemini can be picky about enum)
        if (isset($schema['enum']) && is_array($schema['enum'])) {
            $enumValues = implode(', ', array_map('strval', $schema['enum']));
            $desc = $schema['description'] ?? '';
            $schema['description'] = trim($desc . " Allowed values: " . $enumValues);
            unset($schema['enum']);
        }

        // Fix properties recursively
        if (isset($schema['properties'])) {
            $props = $schema['properties'];
            if (is_object($props)) {
                $props = (array) $props;
            }

            if (is_array($props) && !empty($props)) {
                $fixedProps = [];
                foreach ($props as $propName => $propSchema) {
                    // Recursively fix each property schema
                    $fixedProps[$propName] = self::fixSchemaForGemini($propSchema);
                }
                $schema['properties'] = $fixedProps;
            } else {
                // Empty properties
                $schema['properties'] = (object)[];
            }
        } elseif ($schema['type'] === 'object') {
            $schema['properties'] = (object)[];
        }

        // Fix items for array type
        if (isset($schema['items'])) {
            $schema['items'] = self::fixSchemaForGemini($schema['items']);
        } elseif ($schema['type'] === 'array') {
            $schema['items'] = ['type' => 'string'];
        }

        // Remove empty required arrays
        if (isset($schema['required']) && empty($schema['required'])) {
            unset($schema['required']);
        }

        return $schema;
    }

    private function getTools(): array
    {
        if (!$this->functionExecutor) {
            return [];
        }

        return $this->functionExecutor->getToolDefinitions();
    }

    protected function getContextWindow(): int
    {
        // Gemini 2.5/3 Flash and Pro: 1M input context window
        return 1000000;
    }

    private function getDefaultSystemPrompt(): string
    {
        // First, check if there's a custom system_prompt in config
        $customPrompt = $this->config->get('providers.gemini.system_prompt');
        if (!empty($customPrompt)) {
            return $customPrompt;
        }

        // Fall back to prompt file
        $promptFile = dirname(__DIR__, 2) . '/resources/prompts/portfolio_assistant.txt';

        if (file_exists($promptFile)) {
            return file_get_contents($promptFile);
        }

        // Default fallback prompt
        return <<<PROMPT
You are a portfolio management assistant with direct access to user data and web search. Always use available functions - never claim lack of access.

FUNCTION PRIORITY:
1. Crypto news/analysis → get_crypto_news
2. Portfolio (owned assets) → get_portfolio_assets_with_discovery
3. Watchlist (tracked assets) → get_user_watchlist or get_watchlist_with_market_data
4. Current info/research → serpapi_search

KEY RULES:
- Portfolio = assets user OWNS; Watchlist = assets user TRACKS
- Use get_crypto_news for all crypto market questions
- Use serpapi_search for software, tools, companies, products, current events
- Always call functions first, then analyze results
- Never say "I don't have access" - you do via functions
PROMPT;
    }

    private function sendProgress(string $message): void
    {
        $this->sseClient?->sendProgress("Gemini: {$message}");
        // Force flush to ensure progress is sent before blocking API calls
        if (ob_get_level()) {
            ob_flush();
        }
        flush();
    }

    private function trackUsage(
        string|int|null $userId,
        int $inputTokens,
        int $outputTokens,
        int $functionCallCount,
        int $responseTimeMs
    ): void {
        $this->usageTracker?->trackRequest([
            'user_id' => $userId,
            'provider' => 'gemini',
            'model' => $this->model,
            'request_type' => 'chat',
            'input_tokens' => $inputTokens,
            'output_tokens' => $outputTokens,
            'function_calls_count' => $functionCallCount,
            'response_time_ms' => $responseTimeMs,
            'status' => 'success',
        ]);
    }

    /**
     * Build an HTTP request for Gemini API (static method for parallel execution).
     *
     * @param string $model The model to use
     * @param array $messages Messages in OpenAI-compatible format
     * @param array $tools Tools in Claude format
     * @param array $config Provider configuration
     * @param int $maxTokens Maximum tokens
     * @param float $temperature Temperature
     * @return array [url, headers, payload, provider]
     */
    public static function buildHttpRequest(
        string $model,
        array $messages,
        array $tools,
        array $config,
        int $maxTokens,
        float $temperature
    ): array {
        $apiKey = $config['api_key'] ?? '';

        // Convert messages to Gemini format
        $systemInstruction = null;
        $contents = [];

        foreach ($messages as $msg) {
            if ($msg['role'] === 'system') {
                $systemInstruction = ['parts' => [['text' => $msg['content']]]];
            } elseif ($msg['role'] === 'user') {
                $contents[] = ['role' => 'user', 'parts' => [['text' => $msg['content']]]];
            } elseif ($msg['role'] === 'assistant') {
                if (!empty($msg['tool_calls'])) {
                    // Gemini uses functionCall in model response
                    $parts = [];
                    if (!empty($msg['content'])) {
                        $parts[] = ['text' => $msg['content']];
                    }
                    foreach ($msg['tool_calls'] as $tc) {
                        $args = is_string($tc['function']['arguments'] ?? '')
                            ? json_decode($tc['function']['arguments'], true) ?? []
                            : ($tc['function']['arguments'] ?? []);
                        $part = [
                            'functionCall' => [
                                'name' => $tc['function']['name'] ?? $tc['name'],
                                'args' => (object)$args,
                            ]
                        ];
                        // Include thoughtSignature if present (required for Gemini 2.5+)
                        if (isset($tc['thought_signature'])) {
                            $part['thoughtSignature'] = $tc['thought_signature'];
                        }
                        $parts[] = $part;
                    }
                    $contents[] = ['role' => 'model', 'parts' => $parts];
                } else {
                    $contents[] = ['role' => 'model', 'parts' => [['text' => $msg['content'] ?? '']]];
                }
            } elseif ($msg['role'] === 'tool') {
                // Gemini uses functionResponse with role 'tool'
                $contents[] = [
                    'role' => 'tool',
                    'parts' => [
                        [
                            'functionResponse' => [
                                'name' => $msg['name'] ?? 'function',
                                'response' => ['result' => $msg['content']],
                            ]
                        ]
                    ]
                ];
            }
        }

        $payload = [
            'contents' => $contents,
            'generationConfig' => [
                'temperature' => $temperature,
                'maxOutputTokens' => $maxTokens,
            ],
        ];

        if ($systemInstruction) {
            $payload['systemInstruction'] = $systemInstruction;
        }

        // Add tools in Gemini format
        if (!empty($tools)) {
            $payload['tools'] = self::convertToolsToGeminiFormat($tools);
        }

        // Base URL should include /v1beta
        $baseUrl = !empty($config['base_url']) ? rtrim($config['base_url'], '/') : 'https://generativelanguage.googleapis.com/v1beta';

        // If base_url doesn't include v1beta, add it
        if (strpos($baseUrl, '/v1beta') === false && strpos($baseUrl, '/v1') === false) {
            $baseUrl .= '/v1beta';
        }

        return [
            'url' => "{$baseUrl}/models/{$model}:generateContent?key={$apiKey}",
            'headers' => [
                'Content-Type: application/json',
            ],
            'payload' => $payload,
            'provider' => 'gemini',
        ];
    }

    /**
     * Parse Gemini API response (static method for parallel execution).
     *
     * @param array $decoded The decoded JSON response
     * @return array [text, tool_calls (OpenAI format), usage (normalized)]
     */
    public static function parseHttpResponse(array $decoded): array
    {
        $candidate = $decoded['candidates'][0] ?? [];
        $parts = $candidate['content']['parts'] ?? [];
        $text = '';
        $toolCalls = [];

        foreach ($parts as $part) {
            if (isset($part['text'])) {
                $text .= $part['text'];
            } elseif (isset($part['functionCall'])) {
                // Convert to OpenAI-compatible format, preserve thoughtSignature for Gemini 2.5+
                $toolCall = [
                    'id' => 'call_' . uniqid(),
                    'type' => 'function',
                    'function' => [
                        'name' => $part['functionCall']['name'],
                        'arguments' => json_encode($part['functionCall']['args'] ?? []),
                    ],
                ];
                // Capture thoughtSignature if present (required for Gemini 2.5+)
                if (isset($part['thoughtSignature'])) {
                    $toolCall['thought_signature'] = $part['thoughtSignature'];
                }
                $toolCalls[] = $toolCall;
            }
        }

        $usage = self::normalizeUsage($decoded['usageMetadata'] ?? null, 'gemini');

        return [
            'text' => $text,
            'tool_calls' => $toolCalls,
            'usage' => $usage,
        ];
    }

    /**
     * Get the API family for this provider.
     *
     * @return string 'gemini'
     */
    public static function getApiFamily(): string
    {
        return 'gemini';
    }
}
