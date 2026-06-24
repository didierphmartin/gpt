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
 * Grok AI Provider (xAI)
 *
 * Dedicated provider for xAI's Grok models.
 * Uses OpenAI-compatible API format.
 */
class GrokProvider implements AIProviderInterface, HttpRequestBuilderInterface
{
    use ProviderRequestBuilderTrait;
    use \Quantis\AIPortfolioAssistant\Providers\Traits\ClientSideToolsTrait;

    private const BASE_URL = 'https://api.x.ai';
    private const CHAT_ENDPOINT = '/v1/chat/completions';

    private Configuration $config;
    private Client $httpClient;
    private ?FunctionExecutorInterface $functionExecutor = null;
    private ?UsageTrackerInterface $usageTracker = null;
    private ?StreamingClientInterface $sseClient = null;
    private ?DebugLogger $logger = null;

    private string $model;
    private string $displayName;
    private int $maxTokens;
    private float $temperature;
    private string $apiKey;
    private int $maxRecursionDepth;
    private array $supportedModels;
    private bool $streamingEnabled;

    public function __construct(Configuration $config)
    {
        $this->config = $config;

        $providerConfig = $config->get('providers.grok', []);

        $this->displayName = $providerConfig['display_name'] ?? 'Grok';
        $this->model = $providerConfig['model'] ?? 'grok-4-1-fast-reasoning';
        $this->maxTokens = $providerConfig['max_tokens'] ?? 16384;
        $this->temperature = $providerConfig['temperature'] ?? 0.7;
        $this->apiKey = $providerConfig['api_key'] ?? '';
        $this->maxRecursionDepth = $config->get('max_recursion_depth', 10);
        $this->supportedModels = $providerConfig['supported_models'] ?? [$this->model];
        $this->streamingEnabled = $providerConfig['streaming'] ?? true;

        $this->httpClient = new Client([
            'base_uri' => self::BASE_URL,
            'timeout' => 600,
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
        return 'grok';
    }

    public function getDisplayName(): string
    {
        return $this->displayName;
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
        return $this->supportedModels;
    }

    public function chat(
        string $message,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $startTime = microtime(true);

        $this->sendProgress("Preparing request...");

        $systemPrompt = $this->buildSystemPrompt($options);
        // Honor caller-supplied tools (e.g. workflow client-side run_skill_script)
        // regardless of functionExecutor — client tools run in the browser. The
        // gate only governs this provider's OWN server tools (getTools()).
        $tools = $options['tools'] ?? ($this->functionExecutor ? $this->getTools() : []);
        $userId = $options['user_id'] ?? null;
        $streaming = $options['streaming'] ?? false;
        $toolChoice = $options['tool_choice'] ?? 'auto';

        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        if (!empty($options['client_tools']) && is_array($options['client_tools'])) {
            foreach ($options['client_tools'] as $ct) {
                $tools[] = [
                    'name' => $ct['name'],
                    'description' => $ct['description'] ?? '',
                    'input_schema' => $ct['input_schema'] ?? ['type' => 'object', 'properties' => new \stdClass(), 'required' => []],
                ];
            }
        }

        $messages = $this->buildMessages($conversationHistory, $message, $systemPrompt, $options['image_attachments'] ?? []);

        $response = $this->makeRequest($messages, $tools, $streaming, $toolChoice);

        $inputTokens = $response['usage']['prompt_tokens'] ?? 0;
        $outputTokens = $response['usage']['completion_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        if ($this->hasToolCalls($response)) {
            $this->sendProgress("Processing tool calls...");
            $executedTools = [];

            $response = $this->handleToolCallsRecursive(
                $response,
                $messages,
                $tools,
                $userId,
                $inputTokens,
                $outputTokens,
                $functionCallCount,
                $functionsCalled,
                $mcpToolsCalled,
                0,
                $streaming,
                $executedTools,
                $toolChoice
            );
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
                'provider' => 'grok',
                'functions_called' => $functionsCalled,
                'mcp_tools_called' => $mcpToolsCalled,
                'mcp_calls_count' => count($mcpToolsCalled),
                'pending_client_tool_call' => true,
                'pending_tool_calls' => $response['_pending_tool_calls'] ?? [],
            ];
        }

        $textResponse = $this->extractTextResponse($response);
        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        $this->trackUsage($userId, $inputTokens, $outputTokens, $functionCallCount, $responseTimeMs);

        $this->sendProgress("Response ready.");

        return [
            'text' => $textResponse,
            'usage' => [
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'total_tokens' => $inputTokens + $outputTokens,
                'function_calls' => $functionCallCount,
            ],
            'model' => $this->model,
            'provider' => 'grok',
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
        if (!$this->streamingEnabled || !$this->sseClient) {
            $result = $this->chat($message, $conversationHistory, $options);
            $onChunk($result['text']);
            return $result;
        }

        return $this->chat($message, $conversationHistory, array_merge($options, ['streaming' => true]));
    }

    private function makeRequest(array $messages, array $tools = [], bool $streaming = false, string|array $toolChoice = 'auto'): array
    {
        $this->sendProgress("Connecting to xAI API...");

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'temperature' => (float) number_format($this->temperature, 1, '.', ''),
            'messages' => $messages,
        ];

        if (!empty($tools)) {
            $payload['tools'] = $this->convertToXAITools($tools);
            $payload['tool_choice'] = $toolChoice;
            // DIAGNOSTIC: confirm what tool_choice form reached xAI. Some
            // OpenAI-compatible providers (DeepSeek-v4 documented; possibly
            // Grok) silently ignore the specific-function form
            // ({type: function, function: {name: X}}) and just respond
            // with text. Knowing this is the form on the wire lets us
            // confirm whether to fall back to 'required' (which forces a
            // tool call but lets the model pick — equivalent when only
            // one tool is declared, as in single-skill mode).
            $userMsgContent = (string) (end($messages)['content'] ?? '');
            $userMsgLen = mb_strlen($userMsgContent);
            error_log("[Grok] Sending " . count($payload['tools']) . " tool(s): "
                . implode(', ', array_map(fn($t) => $t['function']['name'] ?? '?', $payload['tools']))
                . " | tool_choice: " . json_encode($toolChoice)
                . " | model: " . ($payload['model'] ?? '?')
                . " | system_msg_len: " . mb_strlen($messages[0]['content'] ?? '')
                . " | user_msg_len: " . $userMsgLen);
            // If user_msg is huge (>10K chars), dump head+tail samples to
            // show what's actually inside. Confirms whether the HTML
            // attachment was elided to a reference or inlined whole.
            if ($userMsgLen > 10000) {
                error_log("[Grok] user_msg head (first 400 chars): "
                    . json_encode(mb_substr($userMsgContent, 0, 400)));
                error_log("[Grok] user_msg tail (last 400 chars): "
                    . json_encode(mb_substr($userMsgContent, -400)));
            }
        }

        if ($streaming) {
            $payload['stream'] = true;
            // Request usage data in streaming mode (OpenAI-compatible APIs)
            $payload['stream_options'] = [
                'include_usage' => true,
            ];
        }

        $this->logger?->logApiRequest('grok', self::CHAT_ENDPOINT, $payload);

        try {
            $response = $this->httpClient->post(self::CHAT_ENDPOINT, [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'Authorization' => 'Bearer ' . $this->apiKey,
                ],
                'json' => $payload,
                'stream' => $streaming,
                'http_errors' => false,  // Don't throw on HTTP errors, handle manually
            ]);

            $statusCode = $response->getStatusCode();

            // Check for HTTP errors before processing
            if ($statusCode >= 400) {
                $errorBody = $response->getBody()->getContents();
                $errorData = json_decode($errorBody, true);
                $errorMessage = $errorData['error']['message'] ?? $errorData['error'] ?? $errorBody;

                $this->logger?->error("Grok API error", ['status' => $statusCode, 'error' => $errorMessage]);

                if ($statusCode === 429) {
                    throw ProviderException::rateLimited('grok');
                }
                if ($statusCode === 401) {
                    throw ProviderException::authenticationFailed('grok');
                }

                throw ProviderException::apiError('grok', "API error: {$errorMessage}", $statusCode);
            }

            if ($streaming) {
                return $this->handleStreamingResponse($response);
            }

            $body = json_decode($response->getBody()->getContents(), true);
            $this->logger?->logApiResponse('grok', 200, 0);
            return $body;

        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('grok');
            }
            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed('grok');
            }

            throw ProviderException::apiError('grok', $e->getMessage(), $statusCode);
        }
    }

    private function handleStreamingResponse($response): array
    {
        $body = $response->getBody();
        $buffer = '';
        $fullText = '';
        $usageData = null;
        $toolCalls = [];
        $finishReason = 'stop';
        $chunkCount = 0;
        $deltaWithDataCount = 0;

        // "Thinking..." rather than "Streaming response..." — fires
        // before any tokens actually arrive, which can be many seconds
        // for B3 skill turns or large inputs.
        $this->sendProgress("Thinking...");

        while (!$body->eof()) {
            $chunk = $body->read(1024);
            $buffer .= $chunk;

            while (($pos = strpos($buffer, "\n")) !== false) {
                $line = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 1);

                if (empty(trim($line))) {
                    continue;
                }

                if (strpos($line, 'data: ') === 0) {
                    $data = substr($line, 6);

                    if ($data === '[DONE]') {
                        break 2;
                    }

                    $json = json_decode($data, true);
                    if (!$json) {
                        continue;
                    }

                    // Check for error in stream
                    if (isset($json['error'])) {
                        $errorMessage = $json['error']['message'] ?? $json['error'] ?? 'Unknown stream error';
                        $this->logger?->error("Grok stream error", ['error' => $errorMessage]);
                        throw ProviderException::apiError('grok', "Stream error: {$errorMessage}", 500);
                    }

                    $chunkCount++;
                    $delta = $json['choices'][0]['delta'] ?? [];
                    $finishReasonFromChunk = $json['choices'][0]['finish_reason'] ?? null;
                    if (is_array($delta) && !empty($delta)) {
                        $deltaWithDataCount++;
                        // Log first chunk's full delta — if xAI returns empty
                        // {} or {role: assistant} only, we'll see exactly what.
                        if ($deltaWithDataCount === 1) {
                            error_log("[Grok] First chunk delta keys: ["
                                . implode(',', array_keys($delta))
                                . "] | first 200 chars: " . substr(json_encode($delta, JSON_UNESCAPED_SLASHES), 0, 200));
                        }
                    }

                    if ($finishReasonFromChunk) {
                        $finishReason = $finishReasonFromChunk;
                        $this->emitUsageWarningIfTruncated($finishReason, $usageData['completion_tokens'] ?? 0);
                    }

                    // DIAGNOSTIC: surface any delta keys we don't recognize.
                    // xAI reasoning models (grok-*-reasoning) may put their
                    // output in `reasoning_content` or a similar field that
                    // we're currently dropping on the floor. If that's the
                    // case, content+tool_calls both look empty here even
                    // though the model produced content.
                    if (is_array($delta)) {
                        foreach ($delta as $key => $val) {
                            if (!in_array($key, ['role', 'content', 'tool_calls', 'function_call', 'refusal'], true)) {
                                static $loggedUnknownKeys = [];
                                if (!isset($loggedUnknownKeys[$key])) {
                                    $loggedUnknownKeys[$key] = true;
                                    $sample = is_string($val) ? substr($val, 0, 200) : (is_array($val) ? json_encode($val, JSON_UNESCAPED_SLASHES) : (string) $val);
                                    error_log("[Grok] Unrecognized delta key '{$key}' (model={$this->model}); sample value: " . substr((string) $sample, 0, 200));
                                }
                            }
                        }
                    }

                    $content = $delta['content'] ?? '';
                    if ($content !== '') {
                        $fullText .= $content;
                        $this->sseClient?->sendChunk($content);
                    }

                    if (isset($delta['tool_calls'])) {
                        foreach ($delta['tool_calls'] as $toolCallDelta) {
                            $index = $toolCallDelta['index'];

                            if (!isset($toolCalls[$index])) {
                                $toolCalls[$index] = [
                                    'id' => '',
                                    'type' => 'function',
                                    'function' => ['name' => '', 'arguments' => '']
                                ];
                            }

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

                    if (isset($json['usage'])) {
                        $usageData = $json['usage'];
                        $this->emitContextWarningIfHigh($usageData['prompt_tokens'] ?? 0);
                    }
                }
            }
        }

        $this->logger?->logApiResponse('grok', 200, 0);

        // DIAGNOSTIC: log finish_reason, output length, tool-call count.
        // Mirrors what ClaudeProvider's [streaming] line does — lets us
        // tell at a glance whether Grok honored a forced tool_choice or
        // bailed to text. Specifically for B3 turns: if finish_reason is
        // "stop" with non-empty text and zero tool calls despite
        // tool_choice being set to a specific function, that's the same
        // failure mode DeepSeek-v4 has — provider silently ignores the
        // forcing constraint.
        error_log("🛑 [GrokProvider:streaming] finish_reason={$finishReason}, text_len="
            . mb_strlen($fullText) . ", tool_calls=" . count($toolCalls)
            . (count($toolCalls) > 0
                ? ' [' . implode(',', array_map(fn($tc) => $tc['function']['name'] ?? '?', $toolCalls)) . ']'
                : '')
            . ", chunks_received={$chunkCount}, chunks_with_data={$deltaWithDataCount}, model={$this->model}");

        $streamResponse = [
            'choices' => [[
                'message' => [
                    'role' => 'assistant',
                    'content' => $fullText,
                ],
                'finish_reason' => $finishReason,
            ]],
            'usage' => $usageData ?? ['prompt_tokens' => 0, 'completion_tokens' => 0, 'total_tokens' => 0],
        ];

        if (!empty($toolCalls)) {
            $streamResponse['choices'][0]['message']['tool_calls'] = array_values($toolCalls);
        }

        return $streamResponse;
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
        int $depth = 0,
        bool $streaming = false,
        array &$executedTools = [],
        string|array $toolChoice = 'auto'
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

        // B3: surface solo client-side tool turns to the frontend.
        $clientCalls = [];
        $serverCalls = [];
        foreach ($toolCalls as $tc) {
            if ($this->isClientSideTool($tc['function']['name'] ?? '')) {
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
            error_log("🔧 [GrokProvider] Client-side tool call detected; surfacing to frontend: " . json_encode(array_column($normalized, 'name')));
            $marker = $this->emitClientToolCallEvent($normalized, $assistantText);
            foreach ($clientCalls as $tc) {
                $functionCallCount++;
                $functionsCalled[] = $tc['function']['name'] ?? '';
            }
            return array_merge($response, $marker);
        }
        if (!empty($clientCalls)) {
            error_log("⚠️ [GrokProvider] Mixed client/server tool calls in one turn — failing client-side calls.");
        }

        $messages[] = $assistantMessage;
        $workflowComplete = false;  // Track if workflow completed (for manager agents)

        foreach ($toolCalls as $toolCall) {
            $functionName = $toolCall['function']['name'];
            $arguments = json_decode($toolCall['function']['arguments'], true) ?? [];

            // Mixed-turn fallback for client-side tools: if we got here
            // it means there were also server-side tool calls in this
            // turn, and the all-client-side branch above didn't fire.
            // Tell the model the client tool can't run alongside server
            // ones and let recursion continue.
            if ($this->isClientSideTool($functionName)) {
                $messages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCall['id'],
                    'content' => json_encode([
                        'error' => 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    ]),
                ];
                $functionCallCount++;
                $functionsCalled[] = $functionName;
                continue;
            }

            // Create a signature to detect duplicate/similar calls
            $callSignature = $functionName . ':' . md5(json_encode($arguments));

            // Check if we've already called this exact function with these arguments
            $duplicateCount = $executedTools[$callSignature] ?? 0;
            if ($duplicateCount >= 2) {
                $this->logger?->warning("Skipping duplicate tool call", [
                    'name' => $functionName,
                    'count' => $duplicateCount
                ]);
                $messages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCall['id'],
                    'content' => json_encode([
                        'status' => 'skipped',
                        'message' => "This tool has already been called with the same arguments. The operation is in progress - please wait for completion instead of calling again."
                    ]),
                ];
                continue;
            }

            $executedTools[$callSignature] = $duplicateCount + 1;
            $functionCallCount++;

            // Track tool name and check if it's an MCP tool
            $functionsCalled[] = $functionName;
            if ($this->functionExecutor && $this->functionExecutor->isMCPTool($functionName)) {
                $mcpToolsCalled[] = $functionName;
            }

            $this->sendProgress("Executing function: {$functionName}");
            $this->logger?->debug("Executing tool", ['name' => $functionName, 'input' => $arguments]);

            $result = $this->executeFunction($functionName, $arguments, $userId);

            // Check if result indicates async operation - add hint to not call again
            $resultContent = $result;
            if (is_array($result)) {
                $status = $result['structuredContent']['status'] ?? $result['status'] ?? null;
                if ($status === 'generating' || $status === 'in_progress' || $status === 'pending') {
                    $result['_hint'] = 'This is an async operation. DO NOT call this tool again - the UI will automatically show progress and results.';
                }
                // Check if workflow is complete (for manager agents calling complete_task)
                $marker = $result['marker'] ?? '';
                if ($marker === '___WORKFLOW_COMPLETE___') {
                    $workflowComplete = true;
                    $this->logger?->debug("Workflow complete detected - switching to auto for final response");
                }
                $resultContent = json_encode($result);
            }

            $messages[] = [
                'role' => 'tool',
                'tool_call_id' => $toolCall['id'],
                'content' => \is_string($resultContent) ? $resultContent : json_encode($resultContent),
            ];
        }

        $this->sendProgress("Processing response...");
        // Use original tool_choice to keep forcing tool use in multi-step workflows
        // BUT switch to 'auto' when workflow is complete so manager can respond to user
        $continuationToolChoice = $workflowComplete ? 'auto' : $toolChoice;
        error_log("[GrokProvider] Continuation: workflowComplete=" . ($workflowComplete ? 'YES' : 'NO') .
                  ", originalChoice={$toolChoice}, continuationChoice={$continuationToolChoice}");
        $continuationResponse = $this->makeRequest($messages, $tools, $streaming, $continuationToolChoice);

        $inputTokens += $continuationResponse['usage']['prompt_tokens'] ?? 0;
        $outputTokens += $continuationResponse['usage']['completion_tokens'] ?? 0;

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
                $depth + 1,
                $streaming,
                $executedTools,
                $toolChoice
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

            if (isset($result['_mcp_ui']) && $this->sseClient) {
                $this->sseClient->sendCustomEvent('mcp_ui', [
                    'tool_name' => $functionName,
                    'ui_info' => $result['_mcp_ui']
                ]);
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

    private function buildMessages(array $conversationHistory, string $newMessage, string $systemPrompt, array $imageAttachments = []): array
    {
        $messages = [['role' => 'system', 'content' => $systemPrompt]];

        foreach ($conversationHistory as $msg) {
            $role = $msg['role'] ?? 'user';

            // B3: tool-result and assistant-with-tool_calls turns must
            // round-trip verbatim (OpenAI-shape native).
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
                $messages[] = [
                    'role'       => 'assistant',
                    'content'    => $textContent !== '' ? $textContent : null,
                    'tool_calls' => $normalizedToolCalls,
                ];
                continue;
            }

            $textContent = $this->extractTextFromContent($msg['content'] ?? '');
            if (!empty($textContent)) {
                $messages[] = [
                    'role' => $role,
                    'content' => $textContent,
                ];
            }
        }

        // B3 continuation: skip empty user turn after a tool_result tail.
        $isToolResultContinuation = empty(trim($newMessage))
            && empty($imageAttachments)
            && !empty($messages)
            && ($messages[count($messages) - 1]['role'] ?? '') === 'tool';
        if ($isToolResultContinuation) {
            return $messages;
        }

        if (!empty($imageAttachments)) {
            $parts = [['type' => 'text', 'text' => $newMessage]];
            foreach ($imageAttachments as $img) {
                $parts[] = [
                    'type' => 'image_url',
                    'image_url' => ['url' => 'data:' . $img['mime_type'] . ';base64,' . $img['data']],
                ];
            }
            $messages[] = ['role' => 'user', 'content' => $parts];
        } else {
            $messages[] = ['role' => 'user', 'content' => $newMessage];
        }

        return $messages;
    }

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

    private function convertToXAITools(array $claudeTools): array
    {
        $xaiTools = [];

        foreach ($claudeTools as $tool) {
            $inputSchema = $tool['input_schema'] ?? ['type' => 'object', 'properties' => new \stdClass()];

            // Convert to array if it's an object
            $parameters = json_decode(json_encode($inputSchema), true);

            // Clean up parameters - remove $schema which xAI doesn't accept
            unset($parameters['$schema']);

            // Ensure required is an array, not empty
            if (!isset($parameters['required']) || empty($parameters['required'])) {
                unset($parameters['required']);
            }

            // Clean up any properties that have invalid schemas
            if (isset($parameters['properties']) && \is_array($parameters['properties'])) {
                foreach ($parameters['properties'] as $propName => $propSchema) {
                    // If property is empty or has no type, give it a default type
                    if (empty($propSchema) || !\is_array($propSchema) || !isset($propSchema['type'])) {
                        $parameters['properties'][$propName] = [
                            'type' => 'string',
                            'description' => \is_array($propSchema) ? ($propSchema['description'] ?? '') : ''
                        ];
                    } else {
                        // Remove 'default' field as xAI may not support it
                        unset($parameters['properties'][$propName]['default']);
                        // Remove 'items' field for non-array types
                        if ($propSchema['type'] !== 'array') {
                            unset($parameters['properties'][$propName]['items']);
                        }

                        // Fix enum type mismatch: if type is string but enum has non-strings, convert them
                        if (isset($propSchema['enum']) && $propSchema['type'] === 'string') {
                            $parameters['properties'][$propName]['enum'] = array_map('strval', $propSchema['enum']);
                        }
                        // If type is integer/number but enum has strings, convert them
                        if (isset($propSchema['enum']) && \in_array($propSchema['type'], ['integer', 'number'])) {
                            $parameters['properties'][$propName]['enum'] = array_map(function($v) {
                                return \is_numeric($v) ? (int)$v : $v;
                            }, $propSchema['enum']);
                        }
                        // xAI's tool-schema validator (engine_imposed) rejects
                        // string enums whose values contain '/'. Our group-
                        // folder skills carry dir_name like "GEO/geo-audit",
                        // which legitimately need the slash. Strategy: when
                        // any value in the enum contains '/', drop the enum
                        // constraint entirely (the LLM still sees the catalog
                        // of valid values in the tool description and the
                        // frontend dispatcher validates the pick at runtime,
                        // so this is purely about getting past Grok's
                        // up-front schema validation).
                        if (isset($parameters['properties'][$propName]['enum'])
                            && is_array($parameters['properties'][$propName]['enum'])) {
                            foreach ($parameters['properties'][$propName]['enum'] as $v) {
                                if (is_string($v) && strpos($v, '/') !== false) {
                                    unset($parameters['properties'][$propName]['enum']);
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Ensure properties is an object (stdClass) not an empty array for JSON encoding
            if (!isset($parameters['properties']) || empty($parameters['properties'])) {
                $parameters['properties'] = new \stdClass();
            }

            // xAI uses OpenAI-compatible format with nested "function" object
            $xaiTools[] = [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'parameters' => $parameters,
                ],
            ];
        }

        return $xaiTools;
    }

    private function getTools(): array
    {
        return $this->functionExecutor?->getToolDefinitions() ?? [];
    }

    protected function getContextWindow(): int
    {
        // grok-4-1-fast-reasoning: 2M context per xAI docs
        return 2000000;
    }

    private function getDefaultSystemPrompt(): string
    {
        $providerConfig = $this->config->get('providers.grok', []);
        if (!empty($providerConfig['system_prompt'])) {
            return $providerConfig['system_prompt'];
        }

        $promptFile = dirname(__DIR__, 2) . '/resources/prompts/portfolio_assistant.txt';
        if (file_exists($promptFile)) {
            return file_get_contents($promptFile);
        }

        return 'You are a helpful AI assistant with access to tools and functions. Use them when appropriate to help the user.';
    }

    private function sendProgress(string $message): void
    {
        $this->sseClient?->sendProgress("Grok: {$message}");
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
            'provider' => 'grok',
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
     * Build an HTTP request for Grok/xAI API (static method for parallel execution).
     * Uses OpenAI-compatible format with xAI's base URL.
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
            'temperature' => (float) number_format($temperature, 1, '.', ''),
            'max_tokens' => $maxTokens,
        ];

        // Add tools in OpenAI format with xAI-specific cleaning
        if (!empty($tools)) {
            $payload['tools'] = self::convertToolsForXAI($tools);
        }

        $baseUrl = !empty($config['base_url']) ? $config['base_url'] : self::BASE_URL;
        $endpoint = !empty($config['chat_endpoint']) ? $config['chat_endpoint'] : '/v1/chat/completions';

        return [
            'url' => rtrim($baseUrl, '/') . $endpoint,
            'headers' => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $config['api_key'],
            ],
            'payload' => $payload,
            'provider' => 'grok',
        ];
    }

    /**
     * Convert tools to xAI format with necessary schema cleaning.
     *
     * @param array $claudeTools Tools in Claude format
     * @return array Tools in xAI format
     */
    private static function convertToolsForXAI(array $claudeTools): array
    {
        $xaiTools = [];

        foreach ($claudeTools as $tool) {
            $inputSchema = $tool['input_schema'] ?? ['type' => 'object', 'properties' => new \stdClass()];

            // Convert to array if it's an object
            $parameters = json_decode(json_encode($inputSchema), true);

            // Clean up parameters - remove $schema which xAI doesn't accept
            unset($parameters['$schema']);

            // Ensure required is an array, not empty
            if (!isset($parameters['required']) || empty($parameters['required'])) {
                unset($parameters['required']);
            }

            // Clean up any properties that have invalid schemas
            if (isset($parameters['properties']) && \is_array($parameters['properties'])) {
                foreach ($parameters['properties'] as $propName => $propSchema) {
                    // If property is empty or has no type, give it a default type
                    if (empty($propSchema) || !\is_array($propSchema) || !isset($propSchema['type'])) {
                        $parameters['properties'][$propName] = [
                            'type' => 'string',
                            'description' => \is_array($propSchema) ? ($propSchema['description'] ?? '') : ''
                        ];
                    } else {
                        // Remove 'default' field as xAI may not support it
                        unset($parameters['properties'][$propName]['default']);
                        // Remove 'items' field for non-array types
                        if ($propSchema['type'] !== 'array') {
                            unset($parameters['properties'][$propName]['items']);
                        }

                        // Fix enum type mismatch
                        if (isset($propSchema['enum']) && $propSchema['type'] === 'string') {
                            $parameters['properties'][$propName]['enum'] = array_map('strval', $propSchema['enum']);
                        }
                        if (isset($propSchema['enum']) && \in_array($propSchema['type'], ['integer', 'number'])) {
                            $parameters['properties'][$propName]['enum'] = array_map(function($v) {
                                return \is_numeric($v) ? (int)$v : $v;
                            }, $propSchema['enum']);
                        }
                        // See companion fix in convertToXAITools(): xAI's
                        // tool-schema validator rejects '/' in enum string
                        // values. Drop the enum when any value contains it.
                        if (isset($parameters['properties'][$propName]['enum'])
                            && is_array($parameters['properties'][$propName]['enum'])) {
                            foreach ($parameters['properties'][$propName]['enum'] as $v) {
                                if (is_string($v) && strpos($v, '/') !== false) {
                                    unset($parameters['properties'][$propName]['enum']);
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Ensure properties is an object (stdClass) not an empty array
            if (!isset($parameters['properties']) || empty($parameters['properties'])) {
                $parameters['properties'] = new \stdClass();
            }

            $xaiTools[] = [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'parameters' => $parameters,
                ],
            ];
        }

        return $xaiTools;
    }

    /**
     * Parse Grok/xAI API response (static method for parallel execution).
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
