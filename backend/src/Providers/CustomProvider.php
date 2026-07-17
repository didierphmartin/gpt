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
 * Custom/Generic AI Provider
 *
 * Can be configured to work with any OpenAI-compatible API endpoint
 * (Kim, Ollama, LocalAI, LM Studio, etc.)
 */
class CustomProvider implements AIProviderInterface, HttpRequestBuilderInterface
{
    use ProviderRequestBuilderTrait;

    private Configuration $config;
    private Client $httpClient;
    private ?FunctionExecutorInterface $functionExecutor = null;
    private ?UsageTrackerInterface $usageTracker = null;
    private ?StreamingClientInterface $sseClient = null;
    private ?DebugLogger $logger = null;

    private string $name;
    private string $displayName;
    private string $model;
    private int $maxTokens;
    private float $temperature;
    private string $baseUrl;
    // Per-call thinking override from agent settings ('on' | 'off' | null =
    // provider default). Set in chat(), read by makeRequest().
    private ?string $thinkingOverride = null;
    private string $apiKey;
    private int $maxRecursionDepth;
    private array $supportedModels;
    private array $headers;
    private string $chatEndpoint;
    private bool $supportsTools;
    private bool $streamingEnabled;
    private int $requestTimeout;
    private int $connectTimeout;

    /** Fallback total-request timeout (seconds) — generous, for long legit streams (e.g. DeepSeek). */
    private const DEFAULT_TIMEOUT = 600;
    /**
     * Per-provider total-timeout overrides (seconds) for small/flaky self-hosted endpoints that can
     * accept a connection then never respond (e.g. gamma4's vLLM host). Caps the 0-byte stall so it
     * fails fast with a clear error instead of hanging the 10-minute default. Config `timeout` wins.
     */
    private const PROVIDER_TIMEOUTS = ['gamma4' => 90];

    public function __construct(Configuration $config, string $providerName)
    {
        $this->config = $config;
        $this->name = $providerName;

        $providerConfig = $config->get("providers.{$providerName}", []);

        $this->displayName = $providerConfig['display_name'] ?? ucfirst($providerName);
        $this->model = $providerConfig['model'] ?? 'default';
        $this->maxTokens = $providerConfig['max_tokens'] ?? 4096;
        $this->temperature = $providerConfig['temperature'] ?? 0.7;
        $this->baseUrl = rtrim($providerConfig['base_url'] ?? '', '/');
        $this->apiKey = $providerConfig['api_key'] ?? '';
        $this->maxRecursionDepth = $config->get('max_recursion_depth', 10);
        $this->supportedModels = $providerConfig['supported_models'] ?? [$this->model];
        $this->headers = $providerConfig['headers'] ?? [];
        $this->chatEndpoint = $providerConfig['chat_endpoint'] ?? '/chat/completions';
        $this->supportsTools = $providerConfig['supports_tools'] ?? true;
        $this->streamingEnabled = $providerConfig['streaming'] ?? false;

        // Fail-fast guard: a small/flaky endpoint (gamma4) can accept the socket and never send a
        // byte; the old 600s blanket timeout turned that into a 10-minute silent hang. Cap such
        // providers via PROVIDER_TIMEOUTS (config `timeout` overrides), keep others at 600, and add a
        // short connect timeout. On expiry Guzzle throws → surfaces as a clear error, not a hang.
        $this->requestTimeout = (int)($providerConfig['timeout']
            ?? self::PROVIDER_TIMEOUTS[$providerName]
            ?? self::DEFAULT_TIMEOUT);
        $this->connectTimeout = (int)($providerConfig['connect_timeout'] ?? 15);

        $this->httpClient = new Client([
            'base_uri' => $this->baseUrl,
            'timeout' => $this->requestTimeout,
            'connect_timeout' => $this->connectTimeout,
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
        return $this->name;
    }

    public function getDisplayName(): string
    {
        return $this->displayName;
    }

    public function isAvailable(): bool
    {
        return !empty($this->baseUrl);
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

        $this->sendProgress("Preparing {$this->displayName} request...");

        $t = $options['thinking'] ?? null;
        $this->thinkingOverride = ($t === 'on' || $t === 'off') ? $t : null;

        $systemPrompt = $this->buildSystemPrompt($options);
        $tools = ($this->supportsTools && $this->functionExecutor) ? ($options['tools'] ?? $this->getTools()) : [];
        $userId = $options['user_id'] ?? null;

        // Build messages array
        $messages = $this->buildMessages($conversationHistory, $message, $systemPrompt);

        // Check if streaming is requested
        $streaming = $options['streaming'] ?? false;

        // Make initial request
        $response = $this->makeRequest($messages, $tools, $streaming);

        // Track tokens and tool calls
        $inputTokens = $response['usage']['prompt_tokens'] ?? 0;
        $outputTokens = $response['usage']['completion_tokens'] ?? 0;
        $functionCallCount = 0;
        $functionsCalled = [];
        $mcpToolsCalled = [];

        // Handle tool calls recursively if supported
        if ($this->supportsTools && $this->hasToolCalls($response)) {
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

        // Extract final text response
        $textResponse = $this->extractTextResponse($response);

        $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        // Track usage
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
            'provider' => $this->name,
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
        // Debug logging
        error_log("🔍 CustomProvider::streamChat - streamingEnabled: " . ($this->streamingEnabled ? 'true' : 'false'));
        error_log("🔍 CustomProvider::streamChat - sseClient: " . ($this->sseClient ? 'set' : 'NULL'));

        // Check if streaming is enabled and SSE client is available
        if (!$this->streamingEnabled || !$this->sseClient) {
            // Fallback to non-streaming
            error_log("⚠️ CustomProvider::streamChat - Falling back to non-streaming");
            $result = $this->chat($message, $conversationHistory, $options);
            $onChunk($result['text']);
            return $result;
        }

        // Use streaming
        error_log("✅ CustomProvider::streamChat - Using streaming mode");
        return $this->chat($message, $conversationHistory, array_merge($options, ['streaming' => true]));
    }

    private function makeRequest(array $messages, array $tools = [], bool $streaming = false): array
    {
        $this->sendProgress("Connecting to {$this->displayName} API...");

        // DeepSeek V4 (deepseek-v4-pro / deepseek-v4-flash) runs in thinking mode
        // by default and rejects temperature/top_p/penalty params. Drop those
        // fields and send `thinking: {type: enabled}` explicitly. Other OpenAI-
        // compatible providers keep the legacy temperature behaviour.
        $isDeepSeekV4 = $this->name === 'deepseek' && str_starts_with($this->model, 'deepseek-v4');

        $payload = [
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'messages' => $messages,
        ];

        if ($isDeepSeekV4) {
            // Agent-level thinking switch: 'off' disables V4 thinking (cuts
            // reasoning latency); default/'on' keeps the V4 default (enabled).
            $payload['thinking'] = ['type' => $this->thinkingOverride === 'off' ? 'disabled' : 'enabled'];
        } else {
            $payload['temperature'] = $this->temperature;
        }

        // GLM 5.2 (z.ai) defaults to heavy reasoning; disable thinking so it answers directly
        // instead of spending the token budget on reasoning (temperature is kept, above).
        // The agent-level switch can re-enable it ('on') for reasoning-heavy nodes.
        if ($this->name === 'glm') {
            $payload['thinking'] = ['type' => $this->thinkingOverride === 'on' ? 'enabled' : 'disabled'];
        }

        if (!empty($tools) && $this->supportsTools) {
            $payload['tools'] = $this->convertToOpenAITools($tools);
            $payload['tool_choice'] = 'auto';
        }

        // Enable streaming if requested
        if ($streaming) {
            $payload['stream'] = true;
            // Request usage data in streaming mode (OpenAI-compatible APIs)
            $payload['stream_options'] = [
                'include_usage' => true,
            ];
        }

        $this->logger?->logApiRequest($this->name, $this->chatEndpoint, $payload);

        // Build headers
        $requestHeaders = [
            'Content-Type' => 'application/json',
        ];

        // Add API key if configured
        if (!empty($this->apiKey)) {
            $requestHeaders['Authorization'] = 'Bearer ' . $this->apiKey;
        }

        // Merge custom headers
        $requestHeaders = array_merge($requestHeaders, $this->headers);

        try {
            // Post to the fully-qualified URL rather than a root-relative path. Guzzle resolves a
            // request path beginning with "/" against the base_uri's ROOT (RFC 3986), which silently
            // drops any path segment in base_url — e.g. z.ai's "/api/paas/v4". Concatenating the
            // rtrim'd base_url with the endpoint preserves it for every provider.
            $response = $this->httpClient->post($this->baseUrl . $this->chatEndpoint, [
                'headers' => $requestHeaders,
                'json' => $payload,
                'stream' => $streaming,  // Enable Guzzle streaming mode
            ]);

            if ($streaming) {
                return $this->handleStreamingResponse($response);
            } else {
                $body = json_decode($response->getBody()->getContents(), true);
                $this->logger?->logApiResponse($this->name, 200, 0);
                return $body;
            }
        } catch (GuzzleException $e) {
            $statusCode = $e->getCode();

            if ($statusCode === 429) {
                throw ProviderException::rateLimited($this->name);
            }

            if ($statusCode === 401) {
                throw ProviderException::authenticationFailed($this->name);
            }

            throw ProviderException::apiError($this->name, $e->getMessage(), $statusCode);
        }
    }

    /**
     * Handle streaming response from API (OpenAI-compatible format)
     */
    private function handleStreamingResponse($response): array
    {
        $body = $response->getBody();
        $buffer = '';
        $fullText = '';
        $reasoningContent = '';
        $usageData = null;
        $toolCalls = [];
        $finishReason = 'stop';

        // "Thinking..." rather than "Streaming response..." — for B3
        // skill turns and large inputs, several seconds can elapse
        // before any tokens actually arrive, making the old wording
        // misleading. (`sendProgress` prefixes the provider name.)
        $this->sendProgress("Thinking...");

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

                    // Capture reasoning_content (DeepSeek V4 thinking mode).
                    // The API requires this to be round-tripped back as part of
                    // the assistant message on continuation requests, otherwise
                    // the next call returns 400 "reasoning_content must be
                    // passed back to the API".
                    if (isset($delta['reasoning_content']) && $delta['reasoning_content'] !== null) {
                        $reasoningContent .= $delta['reasoning_content'];
                    }

                    // Extract content from delta
                    $content = $delta['content'] ?? '';
                    if ($content !== '') {
                        $fullText .= $content;

                        // Always stream text content to user, even when tool calls are present
                        // Tool calls are accumulated separately and not shown to user
                        $this->sseClient?->sendChunk($content);
                    }

                    // Extract tool calls from delta
                    if (isset($delta['tool_calls'])) {
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

        $this->logger?->logApiResponse($this->name, 200, 0);

        // Build response in OpenAI format
        $streamResponse = [
            'choices' => [
                [
                    'message' => [
                        'role' => 'assistant',
                        'content' => $fullText,
                    ],
                    'finish_reason' => $finishReason,
                ]
            ],
            'usage' => $usageData ?? [
                'prompt_tokens' => 0,
                'completion_tokens' => 0,
                'total_tokens' => 0,
            ],
        ];

        // Preserve reasoning_content so handleToolCallsRecursive includes it
        // when it appends $assistantMessage to $messages — required by
        // DeepSeek V4 thinking mode on multi-turn tool-call continuations.
        if ($reasoningContent !== '') {
            $streamResponse['choices'][0]['message']['reasoning_content'] = $reasoningContent;
        }

        // Add tool calls if present
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
        bool $streaming = false
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

        // Add assistant message with tool calls
        $messages[] = $assistantMessage;

        // Process each tool call
        foreach ($toolCalls as $toolCall) {
            $functionCallCount++;
            $functionName = $toolCall['function']['name'];
            $arguments = json_decode($toolCall['function']['arguments'], true) ?? [];

            // Track tool name and check if it's an MCP tool
            $functionsCalled[] = $functionName;
            if ($this->functionExecutor && $this->functionExecutor->isMCPTool($functionName)) {
                $mcpToolsCalled[] = $functionName;
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

        // Make continuation request (with streaming if enabled)
        $this->sendProgress("Processing {$this->displayName} response...");
        $continuationResponse = $this->makeRequest($messages, $tools, $streaming);

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
                $depth + 1,
                $streaming
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
        $message = $response['choices'][0]['message'] ?? [];

        // For DeepSeek Reasoner and similar models that separate reasoning from content
        if (isset($message['reasoning_content']) && !empty($message['reasoning_content'])) {
            // Combine reasoning and content for transparency
            $reasoning = $message['reasoning_content'];
            $content = $message['content'] ?? '';

            // If there's content, show both. Otherwise just return content.
            if (!empty($content)) {
                return $content;
            }
            // Fallback to reasoning if no content
            return $reasoning;
        }

        // Standard format
        return $message['content'] ?? '';
    }

    private function buildMessages(array $conversationHistory, string $newMessage, string $systemPrompt): array
    {
        $messages = [];

        // Add system message
        $messages[] = [
            'role' => 'system',
            'content' => $systemPrompt,
        ];

        // Add conversation history
        foreach ($conversationHistory as $msg) {
            // Always extract text content - don't preserve tool call blocks from history
            $textContent = $this->extractTextFromContent($msg['content']);
            if (!empty($textContent)) {
                $messages[] = [
                    'role' => $msg['role'],
                    'content' => $textContent,
                ];
            }
        }

        // Add new user message
        $messages[] = [
            'role' => 'user',
            'content' => $newMessage,
        ];

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

    private function getDefaultSystemPrompt(): string
    {
        // First, check if provider has a custom system_prompt in config
        $providerConfig = $this->config->get("providers.{$this->name}", []);
        if (!empty($providerConfig['system_prompt'])) {
            return $providerConfig['system_prompt'];
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
        $this->sseClient?->sendProgress("{$this->displayName}: {$message}");
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
            'provider' => $this->name,
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
     * Build an HTTP request for a custom/generic OpenAI-compatible API.
     * This is a static method for parallel execution.
     *
     * @param string $model The model to use
     * @param array $messages Messages in OpenAI-compatible format
     * @param array $tools Tools in Claude format
     * @param array $config Provider configuration (must include base_url)
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
            'max_tokens' => $maxTokens,
        ];

        // Add tools in OpenAI format if supported
        $supportsTools = $config['supports_tools'] ?? true;
        if (!empty($tools) && $supportsTools) {
            $payload['tools'] = self::convertToolsToOpenAIFormat($tools);
            $payload['tool_choice'] = 'auto';
        }

        $baseUrl = rtrim($config['base_url'] ?? '', '/');
        $endpoint = $config['chat_endpoint'] ?? '/chat/completions';

        // Build headers
        $headers = ['Content-Type: application/json'];
        if (!empty($config['api_key'])) {
            $headers[] = 'Authorization: Bearer ' . $config['api_key'];
        }

        // Merge any custom headers
        if (!empty($config['headers']) && is_array($config['headers'])) {
            foreach ($config['headers'] as $key => $value) {
                $headers[] = "{$key}: {$value}";
            }
        }

        return [
            'url' => $baseUrl . $endpoint,
            'headers' => $headers,
            'payload' => $payload,
            'provider' => 'custom',
        ];
    }

    /**
     * Parse a custom/generic OpenAI-compatible API response.
     * This is a static method for parallel execution.
     *
     * @param array $decoded The decoded JSON response
     * @return array [text, tool_calls, usage]
     */
    public static function parseHttpResponse(array $decoded): array
    {
        $message = $decoded['choices'][0]['message'] ?? [];

        // Handle reasoning_content for DeepSeek-like models
        $text = $message['content'] ?? '';
        if (empty($text) && isset($message['reasoning_content'])) {
            $text = $message['reasoning_content'];
        }

        return [
            'text' => $text,
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
