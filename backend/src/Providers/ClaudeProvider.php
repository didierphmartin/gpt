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
 * Claude AI Provider with native function calling support
 */
class ClaudeProvider implements AIProviderInterface, HttpRequestBuilderInterface
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
    private string $apiVersion;
    private int $maxRecursionDepth;
    private bool $streamingEnabled;

    /**
     * Output schema for constrained decoding via the forced-tool pattern.
     * When set, a synthetic tool with this schema is appended; the tool's
     * `input` carries the structured output and is extracted as JSON text.
     */
    private ?array $pendingOutputSchema = null;
    private ?string $pendingSchemaToolName = null;

    /**
     * Supported Claude models
     */
    private const SUPPORTED_MODELS = [
        'claude-sonnet-4-5-20250929',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
    ];

    public function __construct(Configuration $config)
    {
        $this->config = $config;

        $claudeConfig = $config->getClaude();
        $this->model = $claudeConfig['model'] ?? 'claude-sonnet-4-5-20250929';
        $this->maxTokens = $claudeConfig['max_tokens'] ?? 4000;
        $this->temperature = $claudeConfig['temperature'] ?? 0.7;
        $this->baseUrl = rtrim($claudeConfig['base_url'] ?? 'https://api.anthropic.com', '/');
        $this->apiVersion = $claudeConfig['api_version'] ?? '2023-06-01';
        $this->streamingEnabled = $claudeConfig['streaming'] ?? true;
        $this->maxRecursionDepth = $config->get('max_recursion_depth', 10);

        $this->httpClient = new Client([
            'base_uri' => $this->baseUrl,
            'timeout' => 600, // 10 minutes for large responses
        ]);

        if ($config->isDebugEnabled()) {
            $this->logger = new DebugLogger(true);
        }
    }

    /**
     * Set the function executor for tool calling
     */
    public function setFunctionExecutor(FunctionExecutorInterface $executor): self
    {
        $this->functionExecutor = $executor;
        return $this;
    }

    /**
     * Set the usage tracker
     */
    public function setUsageTracker(UsageTrackerInterface $tracker): self
    {
        $this->usageTracker = $tracker;
        return $this;
    }

    /**
     * Set the SSE client for streaming
     */
    public function setSSEClient(StreamingClientInterface $client): self
    {
        $this->sseClient = $client;
        return $this;
    }

    /**
     * Set the logger
     */
    public function setLogger(DebugLogger $logger): self
    {
        $this->logger = $logger;
        return $this;
    }

    /**
     * Get provider name
     */
    public function getName(): string
    {
        return 'claude';
    }

    /**
     * Check if provider is available
     */
    public function isAvailable(): bool
    {
        return $this->config->isProviderConfigured('claude');
    }

    /**
     * Get current model
     */
    public function getModel(): string
    {
        return $this->model;
    }

    /**
     * Set the model
     */
    public function setModel(string $model): self
    {
        $this->model = $model;
        return $this;
    }

    /**
     * Get supported models
     */
    public function getSupportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    /**
     * Send a chat message and get a response
     */
    public function chat(
        string $message,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $startTime = microtime(true);

        $this->sendProgress("Preparing Claude request...");

        $systemPrompt = $this->buildSystemPrompt($options);
        $tools = $options['tools'] ?? $this->getTools();
        $userId = $options['user_id'] ?? null;
        $toolChoice = $options['tool_choice'] ?? 'auto';

        // Constrained decoding: inject schema as a forced tool
        [$tools, $toolChoice, $systemPrompt] = $this->applyOutputSchemaToTools(
            $options['output_schema'] ?? null,
            $tools,
            $toolChoice,
            $systemPrompt
        );

        // Per-request webMCP tool short-circuit. Names supplied by the
        // frontend (e.g. webmcp_get_machine_specifications) must be recognized
        // by the dispatch loop so it emits client_tool_call instead of executing.
        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        // Append per-request client_tools (e.g. webMCP tools from the active tab).
        // Claude's shape is {name, description, input_schema} — matches our
        // sanitized input shape directly.
        $clientTools = $options['client_tools'] ?? [];
        if (is_array($clientTools)) {
            foreach ($clientTools as $ct) {
                $tools[] = [
                    'name' => $ct['name'],
                    'description' => $ct['description'] ?? '',
                    'input_schema' => $ct['input_schema'] ?? [
                        'type' => 'object',
                        'properties' => new \stdClass(),
                        'required' => []
                    ],
                ];
            }
        }

        // Build messages array
        $messages = $this->buildMessages(
            $conversationHistory,
            $message,
            $options['image_attachments'] ?? [],
            $options['pdf_attachments'] ?? []
        );

        // Make initial request
        $response = $this->makeRequest($messages, $systemPrompt, $tools, $toolChoice);

        // Track tokens and tool calls
        $inputTokens = $response['usage']['input_tokens'] ?? 0;
        $outputTokens = $response['usage']['output_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        // Handle tool use recursively
        if ($this->hasToolUse($response)) {
            $this->sendProgress("Processing tool calls...");

            $response = $this->handleToolUseRecursive(
                $response,
                $messages,
                $systemPrompt,
                $tools,
                $userId,
                $inputTokens,
                $outputTokens,
                $functionCallCount,
                $functionsCalled,
                $mcpToolsCalled
            );
        }

        // B3 short-circuit: the recursion bailed out because the LLM
        // called a client-side tool (e.g. run_skill_script). Surface the
        // marker so callers (workflow runner) can round-trip through the
        // browser. The 'client_tool_call' SSE event was already emitted
        // from inside handleToolUseRecursive when sseClient is set;
        // workflow runner emits its own from runAgentWithClientToolBridge
        // using this marker, so the frontend gets it either way.
        // Mirrors the same handling in streamChat().
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
                'provider' => 'claude',
                'functions_called' => $functionsCalled,
                'mcp_tools_called' => $mcpToolsCalled,
                'mcp_calls_count' => count($mcpToolsCalled),
                'pending_client_tool_call' => true,
                'pending_tool_calls' => $response['_pending_tool_calls'] ?? [],
                // Truncation signal for the workflow runner (see handleToolUseRecursive).
                'stop_reason' => $response['stop_reason'] ?? null,
            ];
        }

        // Extract final text response
        $textResponse = $this->extractTextResponse($response);

        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        // Track usage
        $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);

        $this->sendProgress("Response ready.");

        // Debug log final tool arrays
        error_log("📊 [ClaudeProvider::chat] Final tool stats - functions_called: " . json_encode($functionsCalled) . ", mcp_tools_called: " . json_encode($mcpToolsCalled));

        // Clear pending schema state
        $this->pendingOutputSchema = null;
        $this->pendingSchemaToolName = null;

        return [
            'text' => $textResponse,
            'usage' => [
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'total_tokens' => $inputTokens + $outputTokens,
                'function_calls' => $functionCallCount,
            ],
            'model' => $this->model,
            'provider' => 'claude',
            'functions_called' => $functionsCalled,
            'mcp_tools_called' => $mcpToolsCalled,
            'mcp_calls_count' => count($mcpToolsCalled),
        ];
    }

    /**
     * Inject a synthetic schema tool to force structured output.
     *
     * If no other tools exist, the schema tool is forced via tool_choice.
     * Otherwise, tool_choice stays 'auto' and an instruction is appended
     * to the system prompt telling the model to call the schema tool last.
     *
     * Returns [tools, toolChoice, systemPrompt] (modified copies).
     */
    private function applyOutputSchemaToTools(
        $outputSchema,
        array $tools,
        string|array $toolChoice,
        string $systemPrompt
    ): array {
        if (empty($outputSchema) || !is_array($outputSchema)) {
            return [$tools, $toolChoice, $systemPrompt];
        }

        $name = $outputSchema['name'] ?? 'output';
        $description = $outputSchema['description'] ?? 'Return the final answer in this structured format.';
        $schema = $outputSchema['schema'] ?? ['type' => 'object', 'properties' => new \stdClass()];

        $this->pendingOutputSchema = $outputSchema;
        $this->pendingSchemaToolName = $name;

        $schemaTool = [
            'name' => $name,
            'description' => $description,
            'input_schema' => $schema,
        ];

        $hasOtherTools = !empty($tools);
        $tools[] = $schemaTool;

        if (!$hasOtherTools) {
            // Force the schema tool — model has nothing else to call
            $toolChoice = "tool:{$name}";
        } else {
            // Mixed mode: instruct model to use the schema tool as its final action
            $systemPrompt .= "\n\n## Output format\n"
                . "When you have your final answer, you MUST call the `{$name}` tool "
                . "with your output formatted according to its schema. "
                . "Do not respond with plain text — your final action must be calling this tool.";
        }

        return [$tools, $toolChoice, $systemPrompt];
    }

    /**
     * Send a chat message with streaming response
     */
    public function streamChat(
        string $message,
        callable $onChunk,
        array $conversationHistory = [],
        array $options = []
    ): array {
        // Check if streaming is enabled and SSE client is available
        if (!$this->streamingEnabled || !$this->sseClient) {
            // Fallback to non-streaming
            $result = $this->chat($message, $conversationHistory, $options);
            $onChunk($result['text']);
            return $result;
        }

        $startTime = microtime(true);

        $this->sendProgress("Preparing Claude streaming request...");

        $systemPrompt = $this->buildSystemPrompt($options);
        $tools = $options['tools'] ?? $this->getTools();
        $userId = $options['user_id'] ?? null;
        $toolChoice = $options['tool_choice'] ?? 'auto';

        // Per-request webMCP tool short-circuit. Names supplied by the
        // frontend (e.g. webmcp_get_machine_specifications) must be recognized
        // by the dispatch loop so it emits client_tool_call instead of executing.
        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        // Append per-request client_tools (e.g. webMCP tools from the active tab).
        // Claude's shape is {name, description, input_schema} — matches our
        // sanitized input shape directly.
        $clientTools = $options['client_tools'] ?? [];
        if (is_array($clientTools)) {
            foreach ($clientTools as $ct) {
                $tools[] = [
                    'name' => $ct['name'],
                    'description' => $ct['description'] ?? '',
                    'input_schema' => $ct['input_schema'] ?? [
                        'type' => 'object',
                        'properties' => new \stdClass(),
                        'required' => []
                    ],
                ];
            }
        }

        // Build messages array
        $messages = $this->buildMessages(
            $conversationHistory,
            $message,
            $options['image_attachments'] ?? [],
            $options['pdf_attachments'] ?? []
        );

        // Make streaming request
        $response = $this->makeStreamingRequest($messages, $systemPrompt, $tools, $toolChoice);

        // Track tokens and tool calls
        $inputTokens = $response['usage']['input_tokens'] ?? 0;
        $outputTokens = $response['usage']['output_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        // Handle tool use recursively (non-streaming for tool calls)
        if ($this->hasToolUse($response)) {
            error_log("🔧 Tool use detected, starting recursive handling");
            $this->sendProgress("Processing tool calls...");

            try {
                $response = $this->handleToolUseRecursive(
                    $response,
                    $messages,
                    $systemPrompt,
                    $tools,
                    $userId,
                    $inputTokens,
                    $outputTokens,
                    $functionCallCount,
                    $functionsCalled,
                    $mcpToolsCalled
                );
                error_log("✅ Tool use handling completed successfully");
            } catch (\Throwable $e) {
                error_log("❌ ERROR in handleToolUseRecursive: " . $e->getMessage());
                error_log("Stack trace: " . $e->getTraceAsString());
                throw $e;
            }
        }

        // B3 short-circuit: if the recursion bailed out because the LLM
        // called a client-side tool, return the assistant's pre-tool text
        // (often empty) and a flag the controller can forward to the
        // frontend. The 'client_tool_call' SSE event has already been
        // emitted from inside handleToolUseRecursive.
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
                'provider' => 'claude',
                'functions_called' => $functionsCalled,
                'mcp_tools_called' => $mcpToolsCalled,
                'mcp_calls_count' => count($mcpToolsCalled),
                'pending_client_tool_call' => true,
                'pending_tool_calls' => $response['_pending_tool_calls'] ?? [],
                // Truncation signal for the workflow runner (see handleToolUseRecursive).
                'stop_reason' => $response['stop_reason'] ?? null,
            ];
        }

        // Extract final text response
        $textResponse = $this->extractTextResponse($response);

        // Stream the final response text (this is the complete accumulated text after all tool calls)
        // During streaming, we stream each continuation response, but we need to ensure
        // the final complete text is available
        error_log("📊 Final response length: " . strlen($textResponse));

        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        // Track usage
        $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);

        $this->sendProgress("Response ready.");

        // Debug log final tool arrays
        error_log("📊 [ClaudeProvider::streamChat] Final tool stats - functions_called: " . json_encode($functionsCalled) . ", mcp_tools_called: " . json_encode($mcpToolsCalled));

        return [
            'text' => $textResponse,
            'usage' => [
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'total_tokens' => $inputTokens + $outputTokens,
                'function_calls' => $functionCallCount,
            ],
            'model' => $this->model,
            'provider' => 'claude',
            'functions_called' => $functionsCalled,
            'mcp_tools_called' => $mcpToolsCalled,
            'mcp_calls_count' => count($mcpToolsCalled),
        ];
    }

    /**
     * Wrap a system prompt string in the Anthropic content-blocks format
     * with an ephemeral cache_control marker.
     *
     * Anthropic prompt caching requires the system field to be an array of
     * content blocks, with cache_control set on the block where the cache
     * boundary should land. The API silently skips caching for prompts
     * below the per-model minimum (1024 tokens for Sonnet/Opus, 2048 for
     * Haiku), so this format is safe to emit unconditionally.
     *
     * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
     */
    private static function buildCachedSystemBlocks(string $systemPrompt): array
    {
        return [
            [
                'type' => 'text',
                'text' => $systemPrompt,
                'cache_control' => ['type' => 'ephemeral'],
            ],
        ];
    }

    /**
     * Make a request to Claude API
     */
    private function makeRequest(array $messages, string $systemPrompt, array $tools = [], string|array $toolChoice = 'auto'): array
    {
        $this->sendProgress("Connecting to Claude API...");

        $apiKey = $this->config->get('claude.api_key');
        if (empty($apiKey)) {
            throw ProviderException::authenticationFailed('claude');
        }

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'temperature' => $this->temperature,
            'system' => self::buildCachedSystemBlocks($systemPrompt),
            'messages' => $messages,
        ];

        if (!empty($tools)) {
            $payload['tools'] = $tools;
            // Claude uses 'any' to force tool usage, 'auto' for optional.
            // We accept several incoming shapes (string convention,
            // OpenAI object form, or already-Claude form) and normalize.
            if (is_array($toolChoice)) {
                // OpenAI object form: { type: 'function', function: { name } }
                if (($toolChoice['type'] ?? '') === 'function' && !empty($toolChoice['function']['name'])) {
                    $payload['tool_choice'] = [
                        'type' => 'tool',
                        'name' => $toolChoice['function']['name'],
                    ];
                } else {
                    // Already in Claude's shape — pass through.
                    $payload['tool_choice'] = $toolChoice;
                }
            } elseif ($toolChoice === 'required') {
                $payload['tool_choice'] = ['type' => 'any'];
            } elseif (is_string($toolChoice) && str_starts_with($toolChoice, 'tool:')) {
                // Force a specific tool (used for structured output schema tool)
                $payload['tool_choice'] = [
                    'type' => 'tool',
                    'name' => substr($toolChoice, 5),
                ];
            } elseif ($toolChoice !== 'auto') {
                $payload['tool_choice'] = ['type' => $toolChoice];
            }
        }

        $this->logger?->logApiRequest('claude', '/v1/messages', $payload);

        try {
            // Convert empty arrays to objects for proper JSON encoding
            $payload = $this->convertEmptyArraysToObjects($payload);

            // Validate JSON encoding before sending to catch encoding issues early
            $jsonPayload = json_encode($payload);
            if ($jsonPayload === false) {
                $jsonError = json_last_error_msg();
                error_log("❌ [ClaudeProvider] JSON encoding failed: {$jsonError}");
                error_log("❌ [ClaudeProvider] Payload structure: " . print_r(array_keys($payload), true));
                // Try to identify problematic content in messages
                if (isset($payload['messages'])) {
                    foreach ($payload['messages'] as $idx => $msg) {
                        $msgJson = json_encode($msg);
                        if ($msgJson === false) {
                            error_log("❌ [ClaudeProvider] Problem in message[$idx]: " . json_last_error_msg());
                            error_log("❌ [ClaudeProvider] Message role: " . ($msg['role'] ?? 'unknown'));
                        }
                    }
                }
                throw new \Exception("Failed to encode request payload: {$jsonError}");
            }

            error_log("📤 [ClaudeProvider] Sending request with body length: " . strlen($jsonPayload));

            // Use body instead of json to ensure we control the exact payload
            $response = $this->httpClient->post('/v1/messages', [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'x-api-key' => $apiKey,
                    'anthropic-version' => $this->apiVersion,
                ],
                'body' => $jsonPayload,
            ]);

            // DIAGNOSTIC: capture the LLM response *exactly as received*
            // before any of our processing touches it. Reads the wire
            // bytes, then logs both the raw body and the parsed shape so
            // we can see what Claude actually emits vs what our pipeline
            // does with it. Useful for diagnosing JSON-wrap / over-escape
            // bugs in tool_use input where the model puts unexpected
            // shapes into input_files.
            $rawBody = $response->getBody()->getContents();
            $body = json_decode($rawBody, true);
            error_log("📥 [ClaudeProvider RAW RESPONSE] " . strlen($rawBody) . " bytes received from Anthropic API");
            error_log("📥 [ClaudeProvider RAW BODY] " . $rawBody);
            if (is_array($body) && isset($body['content']) && is_array($body['content'])) {
                foreach ($body['content'] as $i => $block) {
                    $type = $block['type'] ?? '?';
                    if ($type === 'tool_use') {
                        $name = $block['name'] ?? '?';
                        $inputJson = isset($block['input']) ? json_encode($block['input']) : '(no input)';
                        $inputLen = strlen((string) $inputJson);
                        error_log("📥 [ClaudeProvider RAW TOOL_USE #{$i}] name={$name}, input bytes={$inputLen}");
                        // Per-key sample so we can see input_files values verbatim
                        if (is_array($block['input'] ?? null)) {
                            foreach ($block['input'] as $k => $v) {
                                if (is_string($v)) {
                                    $head = mb_substr($v, 0, 200);
                                    $tail = mb_strlen($v) > 200 ? mb_substr($v, -100) : '';
                                    error_log("📥 [ClaudeProvider RAW TOOL_USE #{$i}.{$k}] string(" . mb_strlen($v) . ") head=" . json_encode($head) . ($tail !== '' ? " tail=" . json_encode($tail) : ''));
                                } elseif (is_array($v)) {
                                    error_log("📥 [ClaudeProvider RAW TOOL_USE #{$i}.{$k}] array, json=" . json_encode($v));
                                } else {
                                    error_log("📥 [ClaudeProvider RAW TOOL_USE #{$i}.{$k}] " . gettype($v) . "=" . json_encode($v));
                                }
                            }
                            // DECISIVE VERDICT: one grep-able line stating the
                            // SHAPE + validity of input_files — the exact failure
                            // mode. Claude often emits input_files as a JSON
                            // STRING instead of an object; if that string is also
                            // truncated it won't json_decode, so the script's -i
                            // input never gets staged ("input file not found").
                            // grep:  INPUT_FILES VERDICT
                            $ifv = $block['input']['input_files'] ?? null;
                            if ($ifv !== null) {
                                if (is_string($ifv)) {
                                    $valid = json_decode($ifv) !== null && json_last_error() === JSON_ERROR_NONE;
                                    error_log("📥 [ClaudeProvider INPUT_FILES VERDICT #{$i}] shape=STRING len=" . strlen($ifv)
                                        . " json_valid=" . ($valid ? 'true (parseable → frontend will stage it)' : 'FALSE → TRUNCATED/MALFORMED, will NOT stage'));
                                } elseif (is_array($ifv)) {
                                    error_log("📥 [ClaudeProvider INPUT_FILES VERDICT #{$i}] shape=OBJECT keys=" . json_encode(array_keys($ifv)) . " (correct shape)");
                                } else {
                                    error_log("📥 [ClaudeProvider INPUT_FILES VERDICT #{$i}] shape=" . gettype($ifv) . " (unexpected)");
                                }
                            }
                        }
                    } elseif ($type === 'text') {
                        $text = $block['text'] ?? '';
                        error_log("📥 [ClaudeProvider RAW TEXT #{$i}] " . mb_strlen($text) . " chars: " . json_encode(mb_substr($text, 0, 300)));
                    } else {
                        error_log("📥 [ClaudeProvider RAW BLOCK #{$i}] type={$type}, json=" . json_encode($block));
                    }
                }
            }

            $this->logger?->logApiResponse('claude', 200, 0);

            return $body;
        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('claude');
            }

            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed('claude');
            }

            throw ProviderException::apiError('claude', $e->getMessage(), $statusCode);
        }
    }

    /**
     * Make a streaming request to Claude API
     */
    private function makeStreamingRequest(array $messages, string $systemPrompt, array $tools = [], string|array $toolChoice = 'auto'): array
    {
        error_log("🚀 [ClaudeProvider:streaming] makeStreamingRequest called with " . count($messages) . " messages");

        $this->sendProgress("Connecting to Claude API (streaming)...");

        $apiKey = $this->config->get('claude.api_key');
        if (empty($apiKey)) {
            throw ProviderException::authenticationFailed('claude');
        }

        // Log message roles for debugging
        foreach ($messages as $idx => $msg) {
            $contentType = is_array($msg['content'] ?? null) ? 'array(' . count($msg['content']) . ')' : 'string';
            error_log("🚀 [ClaudeProvider:streaming] Message[$idx]: role=" . ($msg['role'] ?? 'unknown') . ", content=$contentType");
        }

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'temperature' => $this->temperature,
            'system' => self::buildCachedSystemBlocks($systemPrompt),
            'messages' => $messages,
            'stream' => true, // Enable streaming
        ];

        if (!empty($tools)) {
            $payload['tools'] = $tools;
            // Same normalization as the non-streaming path: accept the
            // OpenAI object form ({type:'function', function:{name}}) and
            // translate to Claude's {type:'tool', name}.
            if (is_array($toolChoice)) {
                if (($toolChoice['type'] ?? '') === 'function' && !empty($toolChoice['function']['name'])) {
                    $payload['tool_choice'] = [
                        'type' => 'tool',
                        'name' => $toolChoice['function']['name'],
                    ];
                } else {
                    $payload['tool_choice'] = $toolChoice;
                }
            } elseif ($toolChoice === 'required') {
                $payload['tool_choice'] = ['type' => 'any'];
            } elseif (is_string($toolChoice) && $toolChoice !== 'auto') {
                $payload['tool_choice'] = ['type' => $toolChoice];
            }
        }

        $this->logger?->logApiRequest('claude', '/v1/messages (streaming)', $payload);

        try {
            // Convert empty arrays to objects for proper JSON encoding
            $payload = $this->convertEmptyArraysToObjects($payload);

            // Validate JSON encoding before sending to catch encoding issues early
            $jsonPayload = json_encode($payload);
            if ($jsonPayload === false) {
                $jsonError = json_last_error_msg();
                error_log("❌ [ClaudeProvider:streaming] JSON encoding failed: {$jsonError}");
                error_log("❌ [ClaudeProvider:streaming] Payload structure: " . print_r(array_keys($payload), true));
                // Try to identify problematic content in messages
                if (isset($payload['messages'])) {
                    foreach ($payload['messages'] as $idx => $msg) {
                        $msgJson = json_encode($msg);
                        if ($msgJson === false) {
                            error_log("❌ [ClaudeProvider:streaming] Problem in message[$idx]: " . json_last_error_msg());
                            error_log("❌ [ClaudeProvider:streaming] Message role: " . ($msg['role'] ?? 'unknown'));
                            // Check content blocks
                            if (isset($msg['content']) && is_array($msg['content'])) {
                                foreach ($msg['content'] as $cIdx => $content) {
                                    $contentJson = json_encode($content);
                                    if ($contentJson === false) {
                                        error_log("❌ [ClaudeProvider:streaming] Problem in message[$idx].content[$cIdx]: " . json_last_error_msg());
                                    }
                                }
                            }
                        }
                    }
                }
                throw new \Exception("Failed to encode request payload: {$jsonError}");
            }

            error_log("📤 [ClaudeProvider:streaming] Sending request with body length: " . strlen($jsonPayload));

            // Make streaming request - use body instead of json to ensure exact payload
            $response = $this->httpClient->post('/v1/messages', [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'x-api-key' => $apiKey,
                    'anthropic-version' => $this->apiVersion,
                ],
                'body' => $jsonPayload,
                'stream' => true, // Enable Guzzle streaming
            ]);

            $body = $response->getBody();
            $buffer = '';
            $fullText = '';
            $contentBlocks = [];
            $usage = ['input_tokens' => 0, 'output_tokens' => 0];
            $hasToolUse = false;
            $currentBlockIndex = -1;
            $inputJsonBuffer = '';

            // Read stream line by line
            while (!$body->eof()) {
                $chunk = $body->read(1024);
                $buffer .= $chunk;

                // Process complete SSE events (delimited by \n\n)
                while (($pos = strpos($buffer, "\n\n")) !== false) {
                    $eventBlock = substr($buffer, 0, $pos);
                    $buffer = substr($buffer, $pos + 2);

                    if (empty(trim($eventBlock))) {
                        continue;
                    }

                    // Parse SSE event
                    $parsedEvent = $this->parseClaudeStreamEvent($eventBlock);

                    if ($parsedEvent) {
                        // DEBUG: Log what events we're receiving
                        if ($parsedEvent['event'] !== 'ping' && $parsedEvent['event'] !== 'message_start') {
                            error_log("🎯 Received SSE event: " . $parsedEvent['event']);
                        }

                        // Handle different event types
                        if ($parsedEvent['event'] === 'content_block_delta' && isset($parsedEvent['data']['delta'])) {
                            $delta = $parsedEvent['data']['delta'];

                            if ($delta['type'] === 'text_delta' && isset($delta['text'])) {
                                $textDelta = $delta['text'];
                                $fullText .= $textDelta;

                                error_log("📝 Text delta received (len=" . strlen($textDelta) . "): " . substr($textDelta, 0, 50));

                                // Send chunk to client
                                $this->sseClient?->sendChunk($textDelta);
                            } elseif ($delta['type'] === 'input_json_delta' && isset($delta['partial_json'])) {
                                // Accumulate tool input JSON
                                $inputJsonBuffer .= $delta['partial_json'];
                            }
                        } elseif ($parsedEvent['event'] === 'content_block_start' && isset($parsedEvent['data']['content_block'])) {
                            $contentBlock = $parsedEvent['data']['content_block'];
                            $contentBlocks[] = $contentBlock;
                            $currentBlockIndex = count($contentBlocks) - 1;
                            $inputJsonBuffer = '';

                            // Check if this is a tool use
                            if ($contentBlock['type'] === 'tool_use') {
                                $hasToolUse = true;
                            }
                        } elseif ($parsedEvent['event'] === 'content_block_stop') {
                            // Parse accumulated input JSON and add to current block
                            if ($currentBlockIndex >= 0 && !empty($inputJsonBuffer)) {
                                $inputData = json_decode($inputJsonBuffer, true);
                                if ($inputData !== null) {
                                    $contentBlocks[$currentBlockIndex]['input'] = $inputData;
                                }
                                $inputJsonBuffer = '';
                            }
                            $currentBlockIndex = -1;
                        } elseif ($parsedEvent['event'] === 'message_delta') {
                            if (isset($parsedEvent['data']['usage'])) {
                                $deltaUsage = $parsedEvent['data']['usage'];
                                $usage['output_tokens'] += $deltaUsage['output_tokens'] ?? 0;
                            }
                            if (isset($parsedEvent['data']['delta']['stop_reason'])) {
                                $stopReason = $parsedEvent['data']['delta']['stop_reason'];
                                $stopSequence = $parsedEvent['data']['delta']['stop_sequence'] ?? null;
                                error_log("🛑 [ClaudeProvider:streaming] stop_reason={$stopReason}" . ($stopSequence !== null ? ", stop_sequence=" . json_encode($stopSequence) : "") . ", output_tokens=" . ($usage['output_tokens'] ?? 0) . ", text_len=" . strlen($fullText));
                                $this->emitUsageWarningIfTruncated($stopReason, $usage['output_tokens'] ?? 0);
                            }
                        } elseif ($parsedEvent['event'] === 'message_start' && isset($parsedEvent['data']['message']['usage'])) {
                            // Initial usage (input tokens)
                            $messageUsage = $parsedEvent['data']['message']['usage'];
                            $usage['input_tokens'] = $messageUsage['input_tokens'] ?? 0;
                            $this->emitContextWarningIfHigh($usage['input_tokens']);
                        } elseif ($parsedEvent['event'] === 'error') {
                            // Handle error event
                            $errorData = $parsedEvent['data'] ?? [];
                            $errorMessage = $errorData['message'] ?? 'Unknown error from Claude API';
                            error_log("❌ Claude API streaming error: " . json_encode($errorData));
                            throw new \Exception("Claude API error: " . $errorMessage);
                        }
                    }
                }
            }

            // Process any remaining data in the buffer (last event might not have \n\n)
            if (!empty(trim($buffer))) {
                $parsedEvent = $this->parseClaudeStreamEvent($buffer);

                if ($parsedEvent) {
                    if ($parsedEvent['event'] === 'content_block_delta' && isset($parsedEvent['data']['delta'])) {
                        $delta = $parsedEvent['data']['delta'];

                        if ($delta['type'] === 'text_delta' && isset($delta['text'])) {
                            $textDelta = $delta['text'];
                            $fullText .= $textDelta;
                            $this->sseClient?->sendChunk($textDelta);
                        }
                    } elseif ($parsedEvent['event'] === 'message_delta') {
                        if (isset($parsedEvent['data']['usage'])) {
                            $deltaUsage = $parsedEvent['data']['usage'];
                            $usage['output_tokens'] += $deltaUsage['output_tokens'] ?? 0;
                        }
                        if (isset($parsedEvent['data']['delta']['stop_reason'])) {
                            $stopReason = $parsedEvent['data']['delta']['stop_reason'];
                            $stopSequence = $parsedEvent['data']['delta']['stop_sequence'] ?? null;
                            error_log("🛑 [ClaudeProvider:streaming:tail] stop_reason={$stopReason}" . ($stopSequence !== null ? ", stop_sequence=" . json_encode($stopSequence) : "") . ", output_tokens=" . ($usage['output_tokens'] ?? 0) . ", text_len=" . strlen($fullText));
                            $this->emitUsageWarningIfTruncated($stopReason, $usage['output_tokens'] ?? 0);
                        }
                    } elseif ($parsedEvent['event'] === 'message_start' && isset($parsedEvent['data']['message']['usage'])) {
                        $messageUsage = $parsedEvent['data']['message']['usage'];
                        $usage['input_tokens'] = $messageUsage['input_tokens'] ?? 0;
                        $this->emitContextWarningIfHigh($usage['input_tokens']);
                    }
                }
            }

            $this->logger?->logApiResponse('claude', 200, 0);

            // Build response structure similar to non-streaming
            $response = [
                'content' => $hasToolUse ? $contentBlocks : [['type' => 'text', 'text' => $fullText]],
                'usage' => $usage,
            ];

            return $response;

        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            // Try to get more details from the response body
            $errorDetails = $e->getMessage();
            if (method_exists($e, 'getResponse') && $e->getResponse()) {
                $responseBody = $e->getResponse()->getBody()->getContents();
                error_log("❌ [ClaudeProvider] API Error Response: " . $responseBody);
                $errorDetails .= " | Response: " . $responseBody;
            }

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('claude');
            }

            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed('claude');
            }

            throw ProviderException::apiError('claude', $errorDetails, $statusCode);
        }
    }

    /**
     * Handle tool use recursively
     */
    private function handleToolUseRecursive(
        array $response,
        array &$messages,
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

        $toolResults = [];
        $assistantContent = $response['content'] ?? [];

        // B3: detect client-side tools (executed in the browser via
        // window.pyodideRunner). If the assistant turn invoked any of
        // them, surface the tool_use to the frontend and bail out — the
        // frontend will run the script and re-POST /chat with the
        // tool_result prepended. We deliberately restrict this to the
        // case where ALL tool_uses in the turn are client-side; mixing
        // server-side and client-side tools in one turn would require
        // partial server execution + partial surface, which we punt on.
        $clientToolBlocks = [];
        $serverToolBlocks = [];
        foreach ($assistantContent as $block) {
            if (($block['type'] ?? '') !== 'tool_use') continue;
            if ($this->isClientSideTool($block['name'] ?? '')) {
                $clientToolBlocks[] = $block;
            } else {
                $serverToolBlocks[] = $block;
            }
        }

        if (!empty($clientToolBlocks) && empty($serverToolBlocks)) {
            $assistantText = '';
            foreach ($assistantContent as $b) {
                if (($b['type'] ?? '') === 'text') {
                    $assistantText .= $b['text'] ?? '';
                }
            }
            $toolCalls = array_map(static function ($b) {
                $input = $b['input'] ?? [];
                if ($input instanceof \stdClass) {
                    $input = (array) $input;
                }
                return [
                    'id' => $b['id'],
                    'name' => $b['name'],
                    'input' => $input,
                ];
            }, $clientToolBlocks);

            error_log("🔧 [ClaudeProvider] Client-side tool call detected; surfacing to frontend: " . json_encode(array_column($toolCalls, 'name')));

            $marker = $this->emitClientToolCallEvent($toolCalls, $assistantText);

            // Track for usage logging so the LLM call still appears as
            // having invoked these tools.
            foreach ($clientToolBlocks as $b) {
                $functionCallCount++;
                $functionsCalled[] = $b['name'];
            }

            return array_merge([
                'content' => $assistantContent,
                'usage' => $response['usage'] ?? [],
                // Surface the API stop_reason so the workflow runner can detect
                // a TRUNCATED tool payload: stop_reason='max_tokens' means the
                // model hit its output cap mid-tool_use, so a large argument
                // (e.g. input_files HTML) is cut off and won't parse.
                'stop_reason' => $response['stop_reason'] ?? null,
            ], $marker);
        }

        if (!empty($clientToolBlocks) && !empty($serverToolBlocks)) {
            // Mixed-tool turn — fail closed for the client-side ones so
            // the existing recursion can still resolve the server-side
            // tools and produce a coherent answer. Revisit if real flows
            // need this; currently medium-format and friends won't hit it.
            error_log("⚠️ [ClaudeProvider] Mixed client/server tool_use in one turn — failing client-side calls.");
            foreach ($clientToolBlocks as $b) {
                $toolResults[] = [
                    'type' => 'tool_result',
                    'tool_use_id' => $b['id'],
                    'content' => json_encode([
                        'error' => 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    ]),
                    'is_error' => true,
                ];
                $functionCallCount++;
                $functionsCalled[] = $b['name'];
            }
        }

        foreach ($assistantContent as $block) {
            // Skip client-side tool_uses we already handled (mixed-turn
            // fallback above).
            if (($block['type'] ?? '') === 'tool_use'
                && $this->isClientSideTool($block['name'] ?? '')) {
                continue;
            }
            if ($block['type'] === 'tool_use') {
                $functionCallCount++;
                $toolName = $block['name'];
                $toolInput = $block['input'] ?? [];
                $toolUseId = $block['id'];

                // Track tool name and check if it's an MCP tool
                $functionsCalled[] = $toolName;
                $isMcp = $this->functionExecutor && $this->functionExecutor->isMCPTool($toolName);
                if ($isMcp) {
                    $mcpToolsCalled[] = $toolName;
                }
                error_log("📊 [ClaudeProvider] Added to functionsCalled: {$toolName} (MCP: " . ($isMcp ? 'yes' : 'no') . "), total functions: " . count($functionsCalled));

                $this->sendProgress("Executing function: {$toolName}");
                $this->logger?->debug("Executing tool", ['name' => $toolName, 'input' => $toolInput]);

                // Execute the function
                $result = $this->executeFunction($toolName, $toolInput, $userId);

                // Strip large binary data (like base64 images) from the result before sending to Claude
                // Claude doesn't need the actual image/video data - just the status
                $resultForClaude = $this->stripLargeDataFromResult($result);

                // Safely encode the result, handling potential encoding issues
                if (is_string($resultForClaude)) {
                    $resultContent = $resultForClaude;
                } else {
                    $resultContent = json_encode($resultForClaude);
                    if ($resultContent === false) {
                        error_log("⚠️ [ClaudeProvider] JSON encoding failed for tool '{$toolName}': " . json_last_error_msg());
                        // Try encoding with UTF-8 sanitization
                        $resultContent = json_encode($resultForClaude, JSON_INVALID_UTF8_SUBSTITUTE);
                        if ($resultContent === false) {
                            error_log("❌ [ClaudeProvider] JSON encoding still failed after UTF-8 fix, using fallback");
                            $resultContent = json_encode(['error' => 'Tool result could not be encoded', 'tool' => $toolName]);
                        }
                    }
                }

                // Ensure the content is valid UTF-8
                if (!mb_check_encoding($resultContent, 'UTF-8')) {
                    error_log("⚠️ [ClaudeProvider] Tool '{$toolName}' result contains invalid UTF-8, sanitizing");
                    $resultContent = mb_convert_encoding($resultContent, 'UTF-8', 'UTF-8');
                }

                error_log("🔧 Tool '{$toolName}' result: " . substr($resultContent, 0, 200));

                $toolResults[] = [
                    'type' => 'tool_result',
                    'tool_use_id' => $toolUseId,
                    'content' => $resultContent,
                ];
            }
        }

        if (empty($toolResults)) {
            return $response;
        }

        // Fix tool_use blocks: convert empty input arrays to objects
        // Also filter out empty text blocks
        $sanitizedContent = [];
        foreach ($assistantContent as $block) {
            if (isset($block['type']) && $block['type'] === 'tool_use') {
                $sanitizedBlock = $block;
                // Convert empty array to stdClass for proper JSON {} encoding
                if (isset($sanitizedBlock['input']) && is_array($sanitizedBlock['input']) && empty($sanitizedBlock['input'])) {
                    $sanitizedBlock['input'] = new \stdClass();
                }
                $sanitizedContent[] = $sanitizedBlock;
            } elseif (isset($block['type']) && $block['type'] === 'text') {
                // Only include text blocks if they have non-empty content
                if (!empty(trim($block['text'] ?? ''))) {
                    $sanitizedContent[] = $block;
                }
            } else {
                // Include other block types as-is
                $sanitizedContent[] = $block;
            }
        }

        // Add assistant message with tool use
        $messages[] = [
            'role' => 'assistant',
            'content' => $sanitizedContent,
        ];

        // Add user message with tool results
        $messages[] = [
            'role' => 'user',
            'content' => $toolResults,
        ];

        // DEBUG: Log continuation messages
        error_log("🔄 Sending continuation request with messages: " . json_encode([
            'message_count' => count($messages),
            'last_message_role' => end($messages)['role'],
            'sanitized_content_count' => count($sanitizedContent)
        ]));

        // Make continuation request (use streaming if enabled)
        $this->sendProgress("Processing Claude response...");
        if ($this->streamingEnabled && $this->sseClient) {
            $continuationResponse = $this->makeStreamingRequest($messages, $systemPrompt, $tools);
        } else {
            $continuationResponse = $this->makeRequest($messages, $systemPrompt, $tools);
        }

        // Accumulate tokens
        $inputTokens += $continuationResponse['usage']['input_tokens'] ?? 0;
        $outputTokens += $continuationResponse['usage']['output_tokens'] ?? 0;

        // Check if there are more tool uses
        if ($this->hasToolUse($continuationResponse)) {
            return $this->handleToolUseRecursive(
                $continuationResponse,
                $messages,
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

    /**
     * Execute a function
     */
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

    /**
     * Check if response has tool use
     */
    private function hasToolUse(array $response): bool
    {
        $content = $response['content'] ?? [];
        foreach ($content as $block) {
            if (($block['type'] ?? '') === 'tool_use') {
                // The schema tool is terminal — its input IS the final structured
                // output, so do not enter the tool-execution loop for it.
                if ($this->pendingSchemaToolName !== null
                    && ($block['name'] ?? '') === $this->pendingSchemaToolName) {
                    continue;
                }
                return true;
            }
        }
        return false;
    }

    /**
     * Extract text response from Claude response.
     *
     * If a schema tool was injected for constrained decoding and Claude
     * called it, return its `input` (the structured output) JSON-encoded.
     */
    private function extractTextResponse(array $response): string
    {
        $content = $response['content'] ?? [];

        // Constrained decoding: prefer the schema tool's structured input
        if ($this->pendingSchemaToolName !== null) {
            foreach ($content as $block) {
                if (($block['type'] ?? '') === 'tool_use'
                    && ($block['name'] ?? '') === $this->pendingSchemaToolName) {
                    $structured = $block['input'] ?? new \stdClass();
                    return json_encode(
                        $structured,
                        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                    ) ?: '';
                }
            }
        }

        $textParts = [];
        foreach ($content as $block) {
            if (($block['type'] ?? '') === 'text') {
                $textParts[] = $block['text'];
            }
        }

        return implode("\n", $textParts);
    }

    /**
     * Build messages array for Claude API
     */
    private function buildMessages(array $conversationHistory, string $newMessage, array $imageAttachments = [], array $pdfAttachments = []): array
    {
        $messages = [];

        foreach ($conversationHistory as $msg) {
            $role = $msg['role'] ?? '';

            // Tool-result turns (role=tool) come from a prior client-side
            // tool dispatch (see B3 two-shot loop). Preserve them as Claude
            // tool_result blocks so the model sees its own previous tool
            // call and our follow-up. Without this they'd be silently
            // stripped and the next turn would land in a malformed state.
            if ($role === 'tool' && !empty($msg['tool_call_id'])) {
                $messages[] = [
                    'role' => 'user',
                    'content' => [[
                        'type' => 'tool_result',
                        'tool_use_id' => $msg['tool_call_id'],
                        'content' => is_string($msg['content'] ?? null)
                            ? $msg['content']
                            : json_encode($msg['content'] ?? null),
                    ]],
                ];
                continue;
            }

            // Assistant turns may carry tool_calls (the LLM's own tool_use
            // emitted in the previous round). Re-emit them as tool_use
            // blocks alongside any text so Claude can match its own call
            // ids to the tool_result that follows.
            if ($role === 'assistant' && !empty($msg['tool_calls'])) {
                $content = [];
                $textContent = $this->extractTextFromContent($msg['content'] ?? '');
                if (!empty(trim($textContent))) {
                    $content[] = ['type' => 'text', 'text' => $textContent];
                }
                foreach ($msg['tool_calls'] as $tc) {
                    $args = $tc['function']['arguments'] ?? $tc['input'] ?? [];
                    if (is_string($args)) {
                        $decoded = json_decode($args, true);
                        $args = is_array($decoded) ? $decoded : [];
                    }
                    if (empty($args)) {
                        $args = new \stdClass();
                    }
                    $content[] = [
                        'type' => 'tool_use',
                        'id'   => $tc['id'],
                        'name' => $tc['function']['name'] ?? $tc['name'] ?? '',
                        'input' => $args,
                    ];
                }
                if (!empty($content)) {
                    $messages[] = ['role' => 'assistant', 'content' => $content];
                }
                continue;
            }

            // Plain text turns (the common case): extract & emit. Empty/
            // whitespace-only entries are skipped — Anthropic rejects them.
            $textContent = $this->extractTextFromContent($msg['content'] ?? '');
            if (!empty(trim($textContent))) {
                $messages[] = [
                    'role' => $role,
                    'content' => [
                        ['type' => 'text', 'text' => $textContent]
                    ],
                ];
            }
        }

        // Continuation case: the second shot of a B3 client-side tool round
        // arrives with the tool_result already at the tail of
        // conversation_history and an empty $newMessage. We must NOT append
        // an empty user turn — Anthropic rejects that, and Claude is meant
        // to keep talking after the tool_result on its own.
        $isToolResultContinuation = empty(trim($newMessage))
            && empty($imageAttachments)
            && empty($pdfAttachments)
            && !empty($messages)
            && ($messages[count($messages) - 1]['role'] ?? '') === 'user'
            && self::lastBlockIsToolResult($messages[count($messages) - 1]);

        if ($isToolResultContinuation) {
            error_log("🔧 [ClaudeProvider] Continuation after client tool result — not appending empty user turn.");
            $logSafe = json_decode(json_encode($messages), true);
            error_log("🔍 Messages being sent to Claude API: " . json_encode($logSafe, JSON_PRETTY_PRINT));
            return $messages;
        }

        // Build the current user message's content blocks. PDFs and images
        // go FIRST so Claude sees them before the text prompt — matches the
        // order Anthropic documents in their vision/document examples.
        $userContent = [];
        foreach ($pdfAttachments as $pdf) {
            $userContent[] = [
                'type' => 'document',
                'source' => [
                    'type' => 'base64',
                    'media_type' => $pdf['mime_type'],
                    'data' => $pdf['data'],
                ],
            ];
        }
        foreach ($imageAttachments as $img) {
            $userContent[] = [
                'type' => 'image',
                'source' => [
                    'type' => 'base64',
                    'media_type' => $img['mime_type'],
                    'data' => $img['data'],
                ],
            ];
        }
        $userContent[] = ['type' => 'text', 'text' => $newMessage];

        $messages[] = [
            'role' => 'user',
            'content' => $userContent,
        ];

        // DEBUG: Log the messages being sent (elide image/document data — huge)
        $logSafe = json_decode(json_encode($messages), true);
        foreach ($logSafe as &$m) {
            if (!is_array($m['content'] ?? null)) continue;
            foreach ($m['content'] as &$block) {
                $type = $block['type'] ?? '';
                if (($type === 'image' || $type === 'document') && isset($block['source']['data'])) {
                    $block['source']['data'] = '[base64 elided]';
                }
            }
        }
        error_log("🔍 Messages being sent to Claude API: " . json_encode($logSafe, JSON_PRETTY_PRINT));

        return $messages;
    }

    /**
     * True when the message's final content block is a tool_result. Used
     * by buildMessages to detect B3 continuation turns where the user
     * "message" is just a placeholder and the real continuation marker is
     * the tool_result block.
     */
    private static function lastBlockIsToolResult(array $message): bool
    {
        $blocks = $message['content'] ?? [];
        if (!is_array($blocks) || empty($blocks)) return false;
        $last = $blocks[count($blocks) - 1] ?? null;
        return is_array($last) && ($last['type'] ?? '') === 'tool_result';
    }

    /**
     * Extract text from content (handles both string and array formats)
     */
    private function extractTextFromContent($content): string
    {
        if (is_string($content)) {
            return $content;
        }

        if (is_array($content)) {
            $textParts = [];
            foreach ($content as $block) {
                if (is_array($block) && ($block['type'] ?? '') === 'text') {
                    $textParts[] = $block['text'] ?? '';
                } elseif (is_string($block)) {
                    $textParts[] = $block;
                }
            }
            return implode("\n", $textParts);
        }

        return '';
    }

    /**
     * Get tools for Claude API
     */
    private function getTools(): array
    {
        if (!$this->functionExecutor) {
            return [];
        }

        return $this->functionExecutor->getToolDefinitions();
    }

    /**
     * Get default system prompt
     */
    /**
     * Claude context window (Sonnet 4.5, 3.5 Sonnet, Opus, Haiku all = 200K).
     */
    protected function getContextWindow(): int
    {
        return 200000;
    }

    private function getDefaultSystemPrompt(): string
    {
        // First, check if there's a custom system_prompt in config
        $customPrompt = $this->config->get('claude.system_prompt');
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

    /**
     * Send progress to SSE client
     */
    private function sendProgress(string $message): void
    {
        $this->sseClient?->sendProgress("Claude: {$message}");
    }

    /**
     * Track usage statistics
     */
    private function trackUsage(
        string|int|null $userId,
        int $inputTokens,
        int $outputTokens,
        int $functionCallCount,
        int $responseTimeMs
    ): void {
        $this->usageTracker?->trackRequest([
            'user_id' => $userId,
            'provider' => 'claude',
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
     * Recursively convert empty arrays to stdClass objects for proper JSON encoding
     */
    private function convertEmptyArraysToObjects($data)
    {
        if (!is_array($data)) {
            return $data;
        }

        // Check if this is an associative array or indexed array
        $isAssociative = array_keys($data) !== range(0, count($data) - 1);

        // If it's an empty indexed array, convert to object
        if (empty($data) && !$isAssociative) {
            return new \stdClass();
        }

        // Recursively process all values
        foreach ($data as $key => $value) {
            $data[$key] = $this->convertEmptyArraysToObjects($value);
        }

        return $data;
    }

    /**
     * Strip large binary data (base64 images, videos, etc.) from tool results
     * to prevent payload size issues when sending back to Claude.
     * Claude doesn't need the actual binary data - just the status/metadata.
     *
     * @param mixed $result The tool result
     * @return mixed The result with large data stripped
     */
    private function stripLargeDataFromResult($result)
    {
        if (is_string($result)) {
            // If it's a very long string (likely base64), truncate it
            if (strlen($result) > 50000) {
                return '[Large data truncated - ' . strlen($result) . ' bytes]';
            }
            return $result;
        }

        if (!is_array($result)) {
            return $result;
        }

        // Keys that typically contain large binary data
        $largeDataKeys = ['imageBase64', 'videoBase64', 'base64', 'data', 'content_base64', 'image_data', 'binary'];

        $stripped = [];
        foreach ($result as $key => $value) {
            // Check if this key is known to contain large data
            if (in_array($key, $largeDataKeys, true) && is_string($value) && strlen($value) > 1000) {
                $stripped[$key] = '[Base64 data stripped - ' . strlen($value) . ' bytes]';
            }
            // Also strip from nested _mcp_ui.tool_result which contains raw MCP response
            elseif ($key === '_mcp_ui' && is_array($value)) {
                // Keep UI info but strip the raw tool_result data
                $stripped[$key] = $value;
                if (isset($stripped[$key]['tool_result'])) {
                    $stripped[$key]['tool_result'] = $this->stripLargeDataFromResult($value['tool_result']);
                }
            }
            // Also check structuredContent which often contains base64
            elseif ($key === 'structuredContent' && is_array($value)) {
                $stripped[$key] = $this->stripLargeDataFromResult($value);
            }
            elseif (is_array($value)) {
                $stripped[$key] = $this->stripLargeDataFromResult($value);
            } else {
                $stripped[$key] = $value;
            }
        }

        return $stripped;
    }

    /**
     * Parse a Claude SSE event block
     *
     * @param string $eventBlock The raw SSE event block
     * @return array|null Parsed event with 'event' and 'data' keys, or null if invalid
     */
    private function parseClaudeStreamEvent(string $eventBlock): ?array
    {
        $lines = explode("\n", $eventBlock);
        $event = null;
        $data = null;

        foreach ($lines as $line) {
            if (strpos($line, 'event:') === 0) {
                $event = trim(substr($line, 6));
            } elseif (strpos($line, 'data:') === 0) {
                // Don't trim data - SSE format has a space after colon, remove only that
                $dataLine = substr($line, 5);
                $data = (strlen($dataLine) > 0 && $dataLine[0] === ' ') ? substr($dataLine, 1) : $dataLine;
            }
        }

        if ($event && $data) {
            // Parse JSON data
            $parsedData = json_decode($data, true);
            if ($parsedData !== null) {
                return [
                    'event' => $event,
                    'data' => $parsedData,
                ];
            }
        }

        return null;
    }

    /**
     * Build an HTTP request for Claude API (static method for parallel execution).
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
        // Extract system prompt and convert messages to Claude format
        $systemPrompt = '';
        $claudeMessages = [];

        foreach ($messages as $msg) {
            if ($msg['role'] === 'system') {
                $systemPrompt = $msg['content'];
            } elseif ($msg['role'] === 'assistant') {
                // Handle assistant messages with tool_calls (Claude format: tool_use blocks)
                if (!empty($msg['tool_calls'])) {
                    $content = [];
                    if (!empty($msg['content'])) {
                        $content[] = ['type' => 'text', 'text' => $msg['content']];
                    }
                    foreach ($msg['tool_calls'] as $tc) {
                        $inputData = is_string($tc['function']['arguments'] ?? '')
                            ? json_decode($tc['function']['arguments'], true) ?? []
                            : ($tc['function']['arguments'] ?? $tc['input'] ?? []);
                        // Convert empty array to stdClass for JSON {} encoding
                        if (empty($inputData)) {
                            $inputData = new \stdClass();
                        }
                        $content[] = [
                            'type' => 'tool_use',
                            'id' => $tc['id'],
                            'name' => $tc['function']['name'] ?? $tc['name'],
                            'input' => $inputData,
                        ];
                    }
                    $claudeMessages[] = ['role' => 'assistant', 'content' => $content];
                } else {
                    // Use content blocks format
                    $textContent = $msg['content'] ?? '';
                    if (!empty(trim($textContent))) {
                        $claudeMessages[] = [
                            'role' => 'assistant',
                            'content' => [
                                ['type' => 'text', 'text' => $textContent]
                            ]
                        ];
                    }
                }
            } elseif ($msg['role'] === 'tool') {
                // Claude uses tool_result blocks in a user message
                $claudeMessages[] = [
                    'role' => 'user',
                    'content' => [
                        [
                            'type' => 'tool_result',
                            'tool_use_id' => $msg['tool_call_id'],
                            'content' => $msg['content'],
                        ]
                    ]
                ];
            } elseif ($msg['role'] === 'user') {
                // Use content blocks format
                $claudeMessages[] = [
                    'role' => 'user',
                    'content' => [
                        ['type' => 'text', 'text' => $msg['content']]
                    ]
                ];
            }
        }

        $payload = [
            'model' => $model,
            'max_tokens' => $maxTokens,
            'messages' => $claudeMessages,
        ];

        // Only add system if not empty (Claude rejects empty system)
        if (!empty($systemPrompt)) {
            $payload['system'] = self::buildCachedSystemBlocks($systemPrompt);
        }

        // Add tools in Claude format
        if (!empty($tools)) {
            $payload['tools'] = array_map(function($tool) {
                $inputSchema = $tool['input_schema'] ?? $tool['parameters'] ?? ['type' => 'object', 'properties' => new \stdClass(), 'required' => []];

                // Ensure properties is an object, not empty array
                if (isset($inputSchema['properties']) && is_array($inputSchema['properties']) && empty($inputSchema['properties'])) {
                    $inputSchema['properties'] = new \stdClass();
                }

                // Ensure required is always an array (Claude rejects {} for required field)
                if (!isset($inputSchema['required'])) {
                    $inputSchema['required'] = [];
                }

                return [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'input_schema' => $inputSchema,
                ];
            }, $tools);
        }

        // Convert empty arrays to objects, but preserve 'required' arrays
        $payload = self::convertEmptyArraysToObjectsForClaude($payload);

        $baseUrl = $config['base_url'] ?? 'https://api.anthropic.com';
        $apiVersion = $config['api_version'] ?? '2023-06-01';

        return [
            'url' => rtrim($baseUrl, '/') . '/v1/messages',
            'headers' => [
                'Content-Type: application/json',
                'x-api-key: ' . $config['api_key'],
                'anthropic-version: ' . $apiVersion,
            ],
            'payload' => $payload,
            'provider' => 'claude',
        ];
    }

    /**
     * Parse Claude API response (static method for parallel execution).
     *
     * @param array $decoded The decoded JSON response
     * @return array [text, tool_calls (OpenAI format), usage (normalized)]
     */
    public static function parseHttpResponse(array $decoded): array
    {
        $content = $decoded['content'] ?? [];
        $text = '';
        $toolCalls = [];

        foreach ($content as $block) {
            if ($block['type'] === 'text') {
                $text .= $block['text'];
            } elseif ($block['type'] === 'tool_use') {
                // Convert to OpenAI-compatible format for consistent handling
                $toolCalls[] = [
                    'id' => $block['id'],
                    'type' => 'function',
                    'function' => [
                        'name' => $block['name'],
                        'arguments' => json_encode($block['input'] ?? []),
                    ],
                ];
            }
        }

        $usage = self::normalizeUsage($decoded['usage'] ?? null, 'claude');

        return [
            'text' => $text,
            'tool_calls' => $toolCalls,
            'usage' => $usage,
        ];
    }

    /**
     * Get the API family for this provider.
     *
     * @return string 'claude'
     */
    public static function getApiFamily(): string
    {
        return 'claude';
    }
}
