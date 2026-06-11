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
 * Kimi AI Provider (Moonshot AI)
 *
 * Dedicated provider for Kimi K2.6 (https://platform.moonshot.ai).
 *
 * K2.6 enforces fixed sampling values — anything else returns 400:
 *   - temperature: 1.0 (thinking) or 0.6 (non-thinking)
 *   - top_p:       0.95
 *   - n:           1
 *   - presence_penalty / frequency_penalty: 0.0
 * We default to non-thinking mode (temperature 0.6) for tool compatibility,
 * matching the previous K2 behaviour. Override sampling fields are forced
 * regardless of what callers pass.
 */
class KimiProvider implements AIProviderInterface, HttpRequestBuilderInterface
{
    use ProviderRequestBuilderTrait;
    use \Quantis\AIPortfolioAssistant\Providers\Traits\ClientSideToolsTrait;

    private const BASE_URL = 'https://api.moonshot.ai';
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

        $providerConfig = $config->get('providers.kimi', []);

        $this->displayName = $providerConfig['display_name'] ?? 'Kimi';
        $this->model = $providerConfig['model'] ?? 'kimi-k2.6';
        $this->maxTokens = $providerConfig['max_tokens'] ?? 32768;
        $this->temperature = $providerConfig['temperature'] ?? 0.6;
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
        return 'kimi';
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
        $tools = $this->functionExecutor ? ($options['tools'] ?? $this->getTools()) : [];
        $userId = $options['user_id'] ?? null;
        $streaming = $options['streaming'] ?? false;
        $toolChoice = $options['tool_choice'] ?? 'auto';

        // Client-side tools support: register names and append tool definitions
        if (!empty($options['client_tool_names']) && is_array($options['client_tool_names'])) {
            $this->setPerRequestClientSideToolNames($options['client_tool_names']);
        }

        if (!empty($options['client_tools']) && is_array($options['client_tools'])) {
            foreach ($options['client_tools'] as $ct) {
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

        $messages = $this->buildMessages($conversationHistory, $message, $systemPrompt, $options['image_attachments'] ?? []);

        $response = $this->makeRequest($messages, $tools, $streaming, $toolChoice);

        $inputTokens = $response['usage']['prompt_tokens'] ?? 0;
        $outputTokens = $response['usage']['completion_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

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
                $mcpToolsCalled,
                0,
                $streaming
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
                'provider' => 'kimi',
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
            'provider' => 'kimi',
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
        $this->sendProgress("Connecting to Kimi API...");

        // K2.6 enforces specific sampling values; we default to non-thinking
        // mode for tool compatibility and force the API-required values.
        $isK2 = str_starts_with($this->model, 'kimi-k2');

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'messages' => $messages,
        ];

        if ($isK2) {
            // Non-thinking mode: temp must be exactly 0.6, top_p exactly 0.95.
            // Disabling thinking keeps tool_choice and reasoning_content
            // round-trip behaviour predictable.
            $payload['thinking'] = ['type' => 'disabled'];
            $payload['temperature'] = 0.6;
            $payload['top_p'] = 0.95;
        } else {
            $payload['temperature'] = $this->temperature;
        }

        if (!empty($tools)) {
            $payload['tools'] = $this->convertToOpenAITools($tools);
            $payload['tool_choice'] = $toolChoice;
        }

        if ($streaming) {
            $payload['stream'] = true;
            // Try to request usage data in streaming mode (if API supports it)
            $payload['stream_options'] = [
                'include_usage' => true,
            ];
        }

        $this->logger?->logApiRequest('kimi', self::CHAT_ENDPOINT, $payload);
        error_log("[KimiProvider] Request model=" . $this->model . " max_tokens=" . $this->maxTokens . " has_tools=" . (!empty($tools) ? 'yes' : 'no'));

        try {
            $response = $this->httpClient->post(self::CHAT_ENDPOINT, [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'Authorization' => 'Bearer ' . $this->apiKey,
                ],
                'json' => $payload,
                'stream' => $streaming,
            ]);

            if ($streaming) {
                return $this->handleStreamingResponse($response);
            }

            $body = json_decode($response->getBody()->getContents(), true);
            $this->logger?->logApiResponse('kimi', 200, 0);
            return $body;

        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            // Extract the actual API error response body for debugging
            $errorBody = '';
            if (method_exists($e, 'hasResponse') && $e->hasResponse()) {
                $errorBody = (string)$e->getResponse()->getBody();
                error_log("[KimiProvider] API error body: " . $errorBody);
            }
            error_log("[KimiProvider] Payload was: " . json_encode($payload));

            if ($statusCode === 429) {
                throw ProviderException::rateLimited('kimi');
            }
            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed('kimi');
            }

            $detailMsg = $e->getMessage();
            if ($errorBody) {
                $errorJson = json_decode($errorBody, true);
                if (isset($errorJson['error']['message'])) {
                    $detailMsg = $errorJson['error']['message'];
                } elseif (isset($errorJson['message'])) {
                    $detailMsg = $errorJson['message'];
                }
            }

            throw ProviderException::apiError('kimi', $detailMsg, $statusCode);
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

                    $delta = $json['choices'][0]['delta'] ?? [];
                    $finishReasonFromChunk = $json['choices'][0]['finish_reason'] ?? null;

                    if ($finishReasonFromChunk) {
                        $finishReason = $finishReasonFromChunk;
                        $this->emitUsageWarningIfTruncated($finishReason, $usageData['completion_tokens'] ?? 0);
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

        $this->logger?->logApiResponse('kimi', 200, 0);

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
        array &$executedTools = []
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
            error_log("🔧 [KimiProvider] Client-side tool call detected; surfacing to frontend: " . json_encode(array_column($normalized, 'name')));
            $marker = $this->emitClientToolCallEvent($normalized, $assistantText);
            foreach ($clientCalls as $tc) {
                $functionCallCount++;
                $functionsCalled[] = $tc['function']['name'] ?? '';
            }
            return array_merge($response, $marker);
        }
        if (!empty($clientCalls)) {
            error_log("⚠️ [KimiProvider] Mixed client/server tool calls in one turn — failing client-side calls.");
        }

        $messages[] = $assistantMessage;

        foreach ($toolCalls as $toolCall) {
            $functionName = $toolCall['function']['name'];
            $arguments = json_decode($toolCall['function']['arguments'], true) ?? [];

            // Mixed-turn fallback for client-side tools (the all-client
            // branch above didn't fire, so there's at least one server
            // call present). Emit an error tool_result and continue.
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
                $resultContent = json_encode($result);
            }

            $messages[] = [
                'role' => 'tool',
                'tool_call_id' => $toolCall['id'],
                'content' => \is_string($resultContent) ? $resultContent : json_encode($resultContent),
            ];
        }

        $this->sendProgress("Processing response...");
        $continuationResponse = $this->makeRequest($messages, $tools, $streaming);

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
                $executedTools
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

            // B3: round-trip tool_result and assistant-with-tool_calls.
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

        // B3 continuation: skip empty user turn after tool_result tail.
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
        return $this->functionExecutor?->getToolDefinitions() ?? [];
    }

    protected function getContextWindow(): int
    {
        // kimi-k2-turbo-preview: 256K context per Moonshot docs
        return 256000;
    }

    private function getDefaultSystemPrompt(): string
    {
        $providerConfig = $this->config->get('providers.kimi', []);
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
        $this->sseClient?->sendProgress("Kimi: {$message}");
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
            'provider' => 'kimi',
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
     * Build an HTTP request for Kimi API (static method for parallel execution).
     * Uses OpenAI-compatible format with Moonshot's base URL and thinking mode config.
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
            'max_tokens' => $maxTokens,
        ];

        // Add tools in OpenAI format
        if (!empty($tools)) {
            $payload['tools'] = self::convertToolsToOpenAIFormat($tools);
        }

        // K2.6 (and K2.x in general) enforces fixed sampling values; ignore the
        // caller's $temperature for these models and force the API-required pair.
        if (str_starts_with($model, 'kimi-k2')) {
            $payload['thinking'] = ['type' => 'disabled'];
            $payload['temperature'] = 0.6;
            $payload['top_p'] = 0.95;
        } else {
            $payload['temperature'] = $temperature;
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
            'provider' => 'kimi',
        ];
    }

    /**
     * Parse Kimi API response (static method for parallel execution).
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
