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
 * OpenAI Provider with function calling support
 */
class OpenAIProvider implements AIProviderInterface, HttpRequestBuilderInterface
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
    private int $maxRecursionDepth;

    /**
     * Output schema for constrained decoding (structured outputs).
     * Set per-call by chat(), read by makeRequest() (including recursive tool-loop calls).
     */
    private ?array $pendingOutputSchema = null;

    /**
     * Streaming opt-out for the current chat() invocation. Default true
     * preserves prior behaviour. compareOnly() and similar contexts set
     * `options['stream'] = false` so the LLM call returns a single JSON
     * response with usage included — streaming would suppress the usage
     * chunk and force per-provider opt-in flags (e.g. stream_options.include_usage).
     */
    private bool $pendingStreaming = true;

    private const SUPPORTED_MODELS = [
        'gpt-4-turbo-preview',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-3.5-turbo',
    ];

    public function __construct(Configuration $config)
    {
        $this->config = $config;

        $openaiConfig = $config->get('openai', []);
        $this->model = $openaiConfig['model'] ?? 'gpt-4-turbo-preview';
        $this->maxTokens = $openaiConfig['max_tokens'] ?? 4096;
        $this->temperature = $openaiConfig['temperature'] ?? 0.7;
        $this->baseUrl = rtrim($openaiConfig['base_url'] ?? 'https://api.openai.com', '/');
        $this->maxRecursionDepth = $config->get('max_recursion_depth', 10);

        $this->httpClient = new Client([
            'base_uri' => $this->baseUrl,
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
        return 'openai';
    }

    public function isAvailable(): bool
    {
        return $this->config->isProviderConfigured('openai');
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

        $this->sendProgress("Preparing OpenAI request...");

        $systemPrompt = $this->buildSystemPrompt($options);
        $tools = $options['tools'] ?? $this->getTools();
        $userId = $options['user_id'] ?? null;
        $toolChoice = $options['tool_choice'] ?? 'auto';

        // webMCP: register client-side tool names so the dispatch loop short-circuits
        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        // Stash output_schema for makeRequest() (including recursive tool-loop calls)
        $this->pendingOutputSchema = !empty($options['output_schema']) && is_array($options['output_schema'])
            ? $options['output_schema']
            : null;
        // Stash streaming flag; default true preserves the prior
        // behaviour for primary-chat callers. Setting this to false
        // (compareOnly does) makes the LLM call return a single JSON
        // response with usage included.
        $this->pendingStreaming = $options['stream'] ?? true;

        // Build messages array
        $messages = $this->buildMessages(
            $conversationHistory,
            $message,
            $systemPrompt,
            $options['image_attachments'] ?? [],
            $options['pdf_attachments'] ?? []
        );

        // webMCP: append browser-tab client tools; convertToOpenAITools() inside
        // makeRequest() will convert these alongside the existing tools using the
        // same input_schema→parameters rename it applies to all tools.
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

        // Make initial request
        $response = $this->makeRequest($messages, $tools, $toolChoice);

        // Track tokens and tool calls
        $inputTokens = $response['usage']['prompt_tokens'] ?? 0;
        $outputTokens = $response['usage']['completion_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        // Handle tool calls recursively
        if ($this->hasToolCalls($response)) {
            $this->sendProgress("Processing tool calls...");

            $response = $this->handleToolCallsRecursive(
                $response,
                $messages,
                $tools,
                $userId,
                $inputTokens,
                $outputTokens,
                $functionCallCount,
                $functionsCalled,
                $mcpToolsCalled
            );
        }

        // B3 short-circuit: if the recursion bailed because the LLM called
        // a client-side tool, return the assistant's pre-tool text and a
        // marker the controller forwards to the frontend. The
        // 'client_tool_call' SSE event was already emitted from inside
        // handleToolCallsRecursive.
        if (!empty($response['_pending_client_tool_call'])) {
            $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);
            $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);
            $this->pendingOutputSchema = null;
            return [
                'text' => $response['_pending_assistant_text'] ?? '',
                'usage' => [
                    'input_tokens' => $inputTokens,
                    'output_tokens' => $outputTokens,
                    'total_tokens' => $inputTokens + $outputTokens,
                    'function_calls' => $functionCallCount,
                ],
                'model' => $this->model,
                'provider' => 'openai',
                'functions_called' => $functionsCalled,
                'mcp_tools_called' => $mcpToolsCalled,
                'mcp_calls_count' => count($mcpToolsCalled),
                'pending_client_tool_call' => true,
                'pending_tool_calls' => $response['_pending_tool_calls'] ?? [],
            ];
        }

        // Extract final text response
        $textResponse = $this->extractTextResponse($response);

        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        // Track usage
        $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);

        $this->sendProgress("Response ready.");

        // Clear pending schema so it doesn't bleed into the next call
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
            'provider' => 'openai',
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

    private function makeRequest(array $messages, array $tools = [], string|array $toolChoice = 'auto'): array
    {
        $this->sendProgress("Connecting to OpenAI API...");

        // Streaming is controlled by the caller via $this->pendingStreaming
        // (set by chat() from $options['stream']). Non-streaming returns a
        // single JSON response with reliable usage data; streaming requires
        // stream_options.include_usage to surface usage, which we can't
        // guarantee across every call site.
        $streaming = $this->pendingStreaming;

        $apiKey = $this->config->get('openai.api_key');
        if (empty($apiKey)) {
            throw ProviderException::authenticationFailed('openai');
        }

        $payload = [
            'model' => $this->model,
            'messages' => $messages,
        ];

        // o1 and o3 models don't support temperature parameter
        $isReasoningModel = str_starts_with($this->model, 'o1') || str_starts_with($this->model, 'o3');
        if (!$isReasoningModel) {
            $payload['temperature'] = $this->temperature;
        }

        // GPT-5 and reasoning models use max_completion_tokens instead of max_tokens
        if (str_starts_with($this->model, 'gpt-5') || $isReasoningModel) {
            $payload['max_completion_tokens'] = $this->maxTokens;
        } else {
            $payload['max_tokens'] = $this->maxTokens;
        }

        // o1 and o3 models don't support tools/function calling
        if (!empty($tools) && !$isReasoningModel) {
            $payload['tools'] = $this->convertToOpenAITools($tools);
            $payload['tool_choice'] = $toolChoice;
        }

        // Constrained decoding via Structured Outputs.
        // Requires gpt-4o-2024-08-06+, gpt-4o-mini-2024-07-18+, gpt-4.1+, etc.
        if ($this->pendingOutputSchema !== null) {
            $schema = $this->pendingOutputSchema;
            $payload['response_format'] = [
                'type' => 'json_schema',
                'json_schema' => [
                    'name' => $schema['name'] ?? 'output',
                    'description' => $schema['description'] ?? '',
                    'strict' => (bool) ($schema['strict'] ?? true),
                    'schema' => $schema['schema'] ?? new \stdClass(),
                ],
            ];
        }

        // Enable streaming if SSE client is available
        if ($streaming) {
            $payload['stream'] = true;
        }

        // Debug: Log the full payload to help diagnose 400 errors
        error_log("[OpenAIProvider] Model: {$this->model}, MaxTokens: {$this->maxTokens}, Tools count: " . count($tools));
        error_log("[OpenAIProvider] Full payload: " . json_encode($payload, JSON_PRETTY_PRINT));

        $this->logger?->logApiRequest('openai', '/v1/chat/completions', $payload);

        try {
            $response = $this->httpClient->post('/v1/chat/completions', [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'Authorization' => 'Bearer ' . $apiKey,
                ],
                'json' => $payload,
                'stream' => $streaming,  // Enable Guzzle streaming mode
            ]);

            if ($streaming) {
                return $this->handleStreamingResponse($response);
            } else {
                $body = json_decode($response->getBody()->getContents(), true);
                $this->logger?->logApiResponse('openai', 200, 0);
                return $body;
            }
        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('openai');
            }

            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed('openai');
            }

            throw ProviderException::apiError('openai', $e->getMessage(), $statusCode);
        }
    }

    /**
     * Handle streaming response from OpenAI API
     */
    private function handleStreamingResponse($response): array
    {
        $body = $response->getBody();
        $buffer = '';
        $fullText = '';
        $usageData = null;
        $toolCalls = [];
        $finishReason = 'stop';

        // "Thinking..." rather than "Streaming response..." — for B3
        // skill turns and large inputs, several seconds can elapse
        // before any tokens actually arrive, making the old wording
        // misleading. (`sendProgress` prefixes the provider name.)
        $this->sendProgress("Thinking...");

        $hasToolCalls = false; // Track if we encounter tool calls

        while (!$body->eof()) {
            $chunk = $body->read(1024);
            $buffer .= $chunk;

            // Process complete lines (SSE format: one line per event)
            while (($pos = strpos($buffer, "\n")) !== false) {
                $line = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 1);

                // Skip empty lines
                if (empty(trim($line))) {
                    continue;
                }

                // Parse "data: " prefix
                if (strpos($line, 'data: ') === 0) {
                    $data = substr($line, 6);

                    // Check for stream end marker
                    if ($data === '[DONE]') {
                        break 2;
                    }

                    $json = json_decode($data, true);
                    if (!$json) {
                        continue;
                    }

                    $delta = $json['choices'][0]['delta'] ?? [];
                    $finishReasonFromChunk = $json['choices'][0]['finish_reason'] ?? null;

                    if ($finishReasonFromChunk) {
                        $finishReason = $finishReasonFromChunk;
                        $this->emitUsageWarningIfTruncated($finishReason, $usageData['completion_tokens'] ?? 0);
                    }

                    // Extract content from delta
                    $content = $delta['content'] ?? '';
                    if ($content !== '') {
                        $fullText .= $content;

                        // Only send chunks if NO tool calls detected yet (Phase 1 simple response or Phase 2 after tools)
                        if (!$hasToolCalls) {
                            $this->sseClient?->sendChunk($content);
                        }
                    }

                    // Extract tool calls from delta
                    if (isset($delta['tool_calls'])) {
                        $hasToolCalls = true; // Mark that we have tool calls (Phase 1 with functions)
                        foreach ($delta['tool_calls'] as $toolCallDelta) {
                            $index = $toolCallDelta['index'];

                            // Initialize tool call if not exists
                            if (!isset($toolCalls[$index])) {
                                $toolCalls[$index] = [
                                    'id' => '',
                                    'type' => 'function',
                                    'function' => [
                                        'name' => '',
                                        'arguments' => ''
                                    ]
                                ];
                            }

                            // Accumulate tool call data
                            if (isset($toolCallDelta['id'])) {
                                $toolCalls[$index]['id'] = $toolCallDelta['id'];
                            }
                            if (isset($toolCallDelta['function']['name'])) {
                                $toolCalls[$index]['function']['name'] = $toolCallDelta['function']['name'];
                            }
                            if (isset($toolCallDelta['function']['arguments'])) {
                                $toolCalls[$index]['function']['arguments'] .= $toolCallDelta['function']['arguments'];
                            }
                        }
                    }

                    // Capture usage data if present (usually in final chunk)
                    if (isset($json['usage'])) {
                        $usageData = $json['usage'];
                        $this->emitContextWarningIfHigh($usageData['prompt_tokens'] ?? 0);
                    }
                }
            }
        }

        $this->logger?->logApiResponse('openai', 200, 0);

        // Build message structure
        $message = [
            'role' => 'assistant',
            'content' => $fullText
        ];

        // Add tool calls if present
        if (!empty($toolCalls)) {
            $message['tool_calls'] = array_values($toolCalls);
        }

        // Return in same format as non-streaming response
        return [
            'choices' => [
                [
                    'message' => $message,
                    'finish_reason' => $finishReason
                ]
            ],
            'usage' => $usageData ?? [
                'prompt_tokens' => 0,
                'completion_tokens' => 0,
                'total_tokens' => 0
            ]
        ];
    }

    private function handleToolCallsRecursive(
        array $response,
        array &$messages,
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

        $assistantMessage = $response['choices'][0]['message'] ?? [];
        $toolCalls = $assistantMessage['tool_calls'] ?? [];

        if (empty($toolCalls)) {
            return $response;
        }

        // B3: detect client-side tools (executed in the browser via
        // window.pyodideRunner). If the assistant turn invoked any of
        // them, surface to the frontend and bail out of server-side
        // recursion. We restrict to the case where ALL tool calls are
        // client-side; mixed turns fail closed for the client-side ones
        // so the existing recursion still resolves the rest.
        $clientCalls = [];
        $serverCalls = [];
        foreach ($toolCalls as $tc) {
            $name = $tc['function']['name'] ?? '';
            if ($this->isClientSideTool($name)) {
                $clientCalls[] = $tc;
            } else {
                $serverCalls[] = $tc;
            }
        }

        if (!empty($clientCalls) && empty($serverCalls)) {
            $assistantText = $assistantMessage['content'] ?? '';
            if (!\is_string($assistantText)) $assistantText = '';
            $normalized = array_map(static function ($tc) {
                $args = $tc['function']['arguments'] ?? '{}';
                $input = is_string($args) ? (json_decode($args, true) ?? []) : ($args ?? []);
                return [
                    'id'    => $tc['id'],
                    'name'  => $tc['function']['name'] ?? '',
                    'input' => $input,
                ];
            }, $clientCalls);
            error_log("🔧 [OpenAIProvider] Client-side tool call detected; surfacing to frontend: " . json_encode(array_column($normalized, 'name')));

            $marker = $this->emitClientToolCallEvent($normalized, $assistantText);

            foreach ($clientCalls as $tc) {
                $functionCallCount++;
                $functionsCalled[] = $tc['function']['name'] ?? '';
            }

            return array_merge($response, $marker);
        }

        if (!empty($clientCalls) && !empty($serverCalls)) {
            error_log("⚠️ [OpenAIProvider] Mixed client/server tool calls in one turn — failing client-side calls.");
        }

        // Add assistant message with tool calls
        $messages[] = $assistantMessage;

        // Process each tool call (client-side ones in mixed turns get a
        // synthetic error tool_result so the recursion can complete).
        foreach ($toolCalls as $toolCall) {
            $functionCallCount++;
            $functionName = $toolCall['function']['name'];
            $arguments = json_decode($toolCall['function']['arguments'], true) ?? [];

            // Track tool name and check if it's an MCP tool
            $functionsCalled[] = $functionName;
            if ($this->functionExecutor && $this->functionExecutor->isMCPTool($functionName)) {
                $mcpToolsCalled[] = $functionName;
            }

            if ($this->isClientSideTool($functionName)) {
                // Mixed-turn fallback: tell the model the client tool call
                // can't run alongside server tools and let it continue.
                $messages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCall['id'],
                    'content' => json_encode([
                        'error' => 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    ]),
                ];
                continue;
            }

            $this->sendProgress("Executing function: {$functionName}");
            $this->logger?->debug("Executing tool", ['name' => $functionName, 'input' => $arguments]);

            // Execute the function
            $result = $this->executeFunction($functionName, $arguments, $userId);

            // Add tool result message
            $messages[] = [
                'role' => 'tool',
                'tool_call_id' => $toolCall['id'],
                'content' => \is_string($result) ? $result : json_encode($result),
            ];
        }

        // Make continuation request
        $this->sendProgress("Processing OpenAI response...");
        $continuationResponse = $this->makeRequest($messages, $tools);

        // Accumulate tokens
        $inputTokens += $continuationResponse['usage']['prompt_tokens'] ?? 0;
        $outputTokens += $continuationResponse['usage']['completion_tokens'] ?? 0;

        // Check if there are more tool calls
        if ($this->hasToolCalls($continuationResponse)) {
            return $this->handleToolCallsRecursive(
                $continuationResponse,
                $messages,
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

    private function hasToolCalls(array $response): bool
    {
        $message = $response['choices'][0]['message'] ?? [];
        return !empty($message['tool_calls']);
    }

    private function extractTextResponse(array $response): string
    {
        return $response['choices'][0]['message']['content'] ?? '';
    }

    private function buildMessages(array $conversationHistory, string $newMessage, string $systemPrompt, array $imageAttachments = [], array $pdfAttachments = []): array
    {
        $messages = [];

        // Add system message
        $messages[] = [
            'role' => 'system',
            'content' => $systemPrompt,
        ];

        // Add conversation history
        foreach ($conversationHistory as $msg) {
            $role = $msg['role'] ?? 'user';

            // B3: tool-result turns from a prior client-side dispatch.
            // OpenAI's native shape — pass through verbatim.
            if ($role === 'tool' && !empty($msg['tool_call_id'])) {
                $entry = [
                    'role' => 'tool',
                    'tool_call_id' => $msg['tool_call_id'],
                    'content' => is_string($msg['content'] ?? null)
                        ? $msg['content']
                        : json_encode($msg['content'] ?? null),
                ];
                if (!empty($msg['name']) && is_string($msg['name'])) {
                    $entry['name'] = $msg['name'];
                }
                $messages[] = $entry;
                continue;
            }

            // B3: assistant turns carrying tool_calls (the LLM's own
            // tool_use from the prior round). Normalize from frontend shape
            // {id, name, input} to OpenAI wire shape
            // {id, type:'function', function:{name, arguments:string}}.
            if ($role === 'assistant' && !empty($msg['tool_calls'])) {
                $textContent = $this->extractTextFromContent($msg['content'] ?? '');
                $normalizedToolCalls = array_map(function ($tc) {
                    // Already in OpenAI wire shape — pass through.
                    if (isset($tc['function'])) return $tc;
                    // Frontend/webMCP shape: {id, name, input}.
                    if (isset($tc['name'])) {
                        return [
                            'id'       => $tc['id'] ?? '',
                            'type'     => 'function',
                            'function' => [
                                'name'      => $tc['name'],
                                'arguments' => json_encode($tc['input'] ?? new \stdClass()),
                            ],
                        ];
                    }
                    return $tc; // unknown shape — pass through
                }, $msg['tool_calls']);
                $entry = [
                    'role'       => 'assistant',
                    'content'    => $textContent !== '' ? $textContent : null,
                    'tool_calls' => $normalizedToolCalls,
                ];
                $messages[] = $entry;
                continue;
            }

            // Plain text turns (the common case).
            $textContent = $this->extractTextFromContent($msg['content'] ?? '');
            if (!empty($textContent)) {
                $messages[] = [
                    'role' => $role,
                    'content' => $textContent,
                ];
            }
        }

        // B3 continuation: the second shot of a client-tool round arrives
        // with the tool_result already at the tail and an empty
        // newMessage. Don't append an empty user turn — OpenAI 400s.
        $isToolResultContinuation = empty(trim($newMessage))
            && empty($imageAttachments)
            && empty($pdfAttachments)
            && !empty($messages)
            && ($messages[count($messages) - 1]['role'] ?? '') === 'tool';
        if ($isToolResultContinuation) {
            return $messages;
        }

        // Add new user message. If images or PDFs are attached, switch to the
        // structured content-array shape — OpenAI Vision spec for images
        // (`image_url`), File-input spec for PDFs (`file` block with a
        // data: URL embedding the base64).
        if (!empty($imageAttachments) || !empty($pdfAttachments)) {
            $parts = [['type' => 'text', 'text' => $newMessage]];
            foreach ($pdfAttachments as $i => $pdf) {
                $parts[] = [
                    'type' => 'file',
                    'file' => [
                        'filename' => $pdf['name'] ?? ('document-' . ($i + 1) . '.pdf'),
                        'file_data' => 'data:' . $pdf['mime_type'] . ';base64,' . $pdf['data'],
                    ],
                ];
            }
            foreach ($imageAttachments as $img) {
                $parts[] = [
                    'type' => 'image_url',
                    'image_url' => [
                        'url' => 'data:' . $img['mime_type'] . ';base64,' . $img['data'],
                    ],
                ];
            }
            $messages[] = ['role' => 'user', 'content' => $parts];
        } else {
            $messages[] = ['role' => 'user', 'content' => $newMessage];
        }

        return $messages;
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
                if (is_array($block) && isset($block['text'])) {
                    $textParts[] = $block['text'];
                } elseif (is_array($block) && isset($block['content'])) {
                    $textParts[] = $block['content'];
                } elseif (is_string($block)) {
                    $textParts[] = $block;
                }
            }
            return implode("\n", $textParts);
        }

        return '';
    }

    private function convertToOpenAITools(array $claudeTools): array
    {
        $openAITools = [];

        foreach ($claudeTools as $tool) {
            $openAITools[] = [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'parameters' => $tool['input_schema'] ?? ['type' => 'object', 'properties' => []],
                ],
            ];
        }

        return $openAITools;
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
        // gpt-4o / gpt-4-turbo: 128K
        return 128000;
    }

    private function getDefaultSystemPrompt(): string
    {
        // First, check if there's a custom system_prompt in config
        $customPrompt = $this->config->get('openai.system_prompt');
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
        $this->sseClient?->sendProgress("OpenAI: {$message}");
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
            'provider' => 'openai',
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
     * Build an HTTP request for OpenAI API (static method for parallel execution).
     * This is the base implementation for OpenAI-compatible APIs.
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
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'temperature' => $temperature,
            'max_completion_tokens' => $maxTokens,
        ];

        // Add tools in OpenAI format
        if (!empty($tools)) {
            $payload['tools'] = self::convertToolsToOpenAIFormat($tools);
        }

        $baseUrl = !empty($config['base_url']) ? $config['base_url'] : 'https://api.openai.com';
        $endpoint = !empty($config['chat_endpoint']) ? $config['chat_endpoint'] : '/v1/chat/completions';

        return [
            'url' => rtrim($baseUrl, '/') . $endpoint,
            'headers' => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $config['api_key'],
            ],
            'payload' => $payload,
            'provider' => 'openai',
        ];
    }

    /**
     * Parse OpenAI API response (static method for parallel execution).
     * This is the base implementation for OpenAI-compatible APIs.
     *
     * @param array $decoded The decoded JSON response
     * @return array [text, tool_calls, usage]
     */
    public static function parseHttpResponse(array $decoded): array
    {
        $message = $decoded['choices'][0]['message'] ?? [];

        return [
            'text' => $message['content'] ?? '',
            'tool_calls' => $message['tool_calls'] ?? [],
            'usage' => self::normalizeUsage($decoded['usage'] ?? null, 'openai'),
        ];
    }

    /**
     * Get the API family for this provider.
     *
     * @return string 'openai'
     */
    public static function getApiFamily(): string
    {
        return 'openai';
    }
}
