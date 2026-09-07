"""Port of Providers/CustomProvider.php.

Custom/Generic AI Provider — can be configured to work with any
OpenAI-compatible API endpoint (Kimi, Ollama, LocalAI, LM Studio, gamma4,
GLM/z.ai, etc.). One instance per configured `providers.<name>` block; the
provider name is a constructor argument rather than a hardcoded constant
(the trait shared with dedicated providers like KimiProvider/GrokProvider).

Line-for-line port; PHP method names are preserved (private PHP methods
become `_name`). PHP semantics are reproduced with the helpers in
app.support.phpcompat (`php_empty` for `empty()`, `x.get(k) if ... is not
None else d` for `??`, dict-or-list for `is_array()`, `ucfirst` for
`ucfirst()`).

Deviation from PHP: the non-2xx error path (`except httpx.HTTPStatusError`)
does NOT reproduce PHP's `$e->getMessage()` verbatim — Guzzle's message
already embeds a response-body excerpt that httpx's str(e) does not, so the
body is appended explicitly (`str(e) + " | Response: " + guzzle_body_summary(e.response.text)`)
to keep ChatController::humanizeProviderError's body pattern-matching
working over the wire. Same fix as openai_provider.py/claude_provider.py.
"""
from __future__ import annotations

import codecs
import json
import time
from pathlib import Path

import httpx

from app.config_.configuration import Configuration
from app.contracts.ai_provider import AIProviderInterface
from app.contracts.function_executor import FunctionExecutorInterface
from app.contracts.http_request_builder import HttpRequestBuilderInterface
from app.contracts.streaming_client import StreamingClientInterface
from app.contracts.usage_tracker import UsageTrackerInterface
from app.exceptions import ProviderException
from app.providers._http import SHARED_SSL_CONTEXT, guzzle_body_summary
from app.providers.totals import _Totals
from app.providers.traits.client_side_tools import ClientSideToolsMixin
from app.providers.traits.provider_request_builder import ProviderRequestBuilderMixin
from app.services.debug_logger import DebugLogger
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, ucfirst
from app.support.phpjson import dumps


def _json_decode(s):
    """PHP json_decode($s, true): returns None on malformed input."""
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


def _first_choice(response: dict) -> dict:
    """PHP `$response['choices'][0] ?? []` — a missing key OR a missing
    index both collapse to [] through the null-coalescing operator.
    """
    choices = response.get('choices') if isinstance(response, dict) and response.get('choices') is not None else []
    if isinstance(choices, list) and len(choices) > 0:
        first = choices[0]
        return first if isinstance(first, dict) else {}
    return {}


class CustomProvider(
    ProviderRequestBuilderMixin,
    ClientSideToolsMixin,
    AIProviderInterface,
    HttpRequestBuilderInterface,
):
    """Port of backend/src/Providers/CustomProvider.php."""

    # Fallback total-request timeout (seconds) — generous, for long legit
    # streams (e.g. DeepSeek).
    DEFAULT_TIMEOUT = 600
    # Per-provider total-timeout overrides (seconds) for small/flaky
    # self-hosted endpoints that can accept a connection then never respond
    # (e.g. gamma4's vLLM host). Caps the 0-byte stall so it fails fast with
    # a clear error instead of hanging the 10-minute default. Config
    # `timeout` wins.
    PROVIDER_TIMEOUTS = {'gamma4': 90}

    def __init__(self, config: Configuration, providerName: str):
        self.config = config
        self.name = providerName

        self.functionExecutor: FunctionExecutorInterface | None = None
        self.usageTracker: UsageTrackerInterface | None = None
        self.sseClient: StreamingClientInterface | None = None
        self.logger: DebugLogger | None = None

        # Per-call thinking override from agent settings ('on' | 'off' | None
        # = provider default). Set in chat(), read by _makeRequest().
        self.thinkingOverride: str | None = None

        providerConfig = config.get(f'providers.{providerName}', {})

        self.displayName = providerConfig.get('display_name') if providerConfig.get('display_name') is not None else ucfirst(providerName)
        self.model = providerConfig.get('model') if providerConfig.get('model') is not None else 'default'
        self.maxTokens = providerConfig.get('max_tokens') if providerConfig.get('max_tokens') is not None else 4096
        self.temperature = providerConfig.get('temperature') if providerConfig.get('temperature') is not None else 0.7
        self.baseUrl = (providerConfig.get('base_url') if providerConfig.get('base_url') is not None else '').rstrip('/')
        self.apiKey = providerConfig.get('api_key') if providerConfig.get('api_key') is not None else ''
        self.maxRecursionDepth = config.get('max_recursion_depth', 10)
        self.supportedModels = providerConfig.get('supported_models') if providerConfig.get('supported_models') is not None else [self.model]
        self.headers = providerConfig.get('headers') if providerConfig.get('headers') is not None else {}
        self.chatEndpoint = providerConfig.get('chat_endpoint') if providerConfig.get('chat_endpoint') is not None else '/chat/completions'
        self.supportsTools = providerConfig.get('supports_tools') if providerConfig.get('supports_tools') is not None else True
        self.streamingEnabled = providerConfig.get('streaming') if providerConfig.get('streaming') is not None else False

        # Fail-fast guard: a small/flaky endpoint (gamma4) can accept the
        # socket and never send a byte; a blanket 600s timeout turns that
        # into a 10-minute silent hang. Cap such providers via
        # PROVIDER_TIMEOUTS (config `timeout` overrides), keep others at
        # 600, and add a short connect timeout. On expiry httpx raises →
        # surfaces as a clear error, not a hang.
        self.requestTimeout = php_intval(
            providerConfig.get('timeout')
            if providerConfig.get('timeout') is not None
            else (self.PROVIDER_TIMEOUTS.get(providerName) if self.PROVIDER_TIMEOUTS.get(providerName) is not None else self.DEFAULT_TIMEOUT)
        )
        self.connectTimeout = php_intval(providerConfig.get('connect_timeout') if providerConfig.get('connect_timeout') is not None else 15)

        self.httpClient = httpx.Client(
            base_url=self.baseUrl or None,
            timeout=httpx.Timeout(self.requestTimeout, connect=self.connectTimeout),
            # Shared SSL context: httpx 0.28 builds (and certifi-loads) a new one
            # per Client, and every enabled provider is constructed per chat request.
            verify=SHARED_SSL_CONTEXT,
        )

        if config.isDebugEnabled():
            self.logger = DebugLogger(True)

        self._init_client_side_tools()

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this provider's httpx connection pool."""
        self.httpClient.close()

    def setFunctionExecutor(self, executor: FunctionExecutorInterface) -> 'CustomProvider':
        self.functionExecutor = executor
        return self

    def setUsageTracker(self, tracker: UsageTrackerInterface) -> 'CustomProvider':
        self.usageTracker = tracker
        return self

    def setSSEClient(self, client: StreamingClientInterface) -> 'CustomProvider':
        self.sseClient = client
        return self

    def setLogger(self, logger: DebugLogger) -> 'CustomProvider':
        self.logger = logger
        return self

    def getName(self) -> str:
        return self.name

    def getDisplayName(self) -> str:
        return self.displayName

    def isAvailable(self) -> bool:
        return not php_empty(self.baseUrl)

    def getModel(self) -> str:
        return self.model

    def setModel(self, model: str) -> 'CustomProvider':
        self.model = model
        return self

    def getSupportedModels(self) -> list:
        return list(self.supportedModels)  # PHP arrays are value types; never leak the live list

    def chat(self, message: str, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        startTime = time.time()

        self._sendProgress(f"Preparing {self.displayName} request...")

        t = options.get('thinking') if options.get('thinking') is not None else None
        self.thinkingOverride = t if t in ('on', 'off') else None

        systemPrompt = self.buildSystemPrompt(options)
        # Honor caller-supplied tools (e.g. run_skill_script from chat B3 or
        # the browser-driven workflow engine) REGARDLESS of functionExecutor —
        # client tools run in the browser, not via a server executor. The
        # gate only governs this provider's OWN server tools (_getTools()).
        tools = options.get('tools') if options.get('tools') is not None else (self._getTools() if (self.supportsTools and self.functionExecutor) else [])
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')

        # Client-side tools support: register names and append tool definitions
        if not php_empty(options.get('client_tool_names')) and isinstance(options.get('client_tool_names'), (dict, list)):
            self.setPerRequestClientSideToolNames(options['client_tool_names'])

        if not php_empty(options.get('client_tools')) and isinstance(options.get('client_tools'), (dict, list)):
            for ct in options['client_tools']:
                tools.append({
                    'name': ct['name'],
                    'description': ct.get('description') if ct.get('description') is not None else '',
                    'input_schema': ct.get('input_schema') if ct.get('input_schema') is not None else {
                        'type': 'object',
                        'properties': {},
                        'required': [],
                    },
                })

        # Build messages array
        messages = self._buildMessages(conversationHistory, message, systemPrompt)

        # Check if streaming is requested
        streaming = options.get('streaming') if options.get('streaming') is not None else False

        # Make initial request
        response = self._makeRequest(messages, tools, streaming)

        # Track tokens and tool calls
        inputTokens = response['usage']['prompt_tokens'] if response.get('usage') is not None and response['usage'].get('prompt_tokens') is not None else 0
        outputTokens = response['usage']['completion_tokens'] if response.get('usage') is not None and response['usage'].get('completion_tokens') is not None else 0
        totals = _Totals(inputTokens=inputTokens, outputTokens=outputTokens)

        # Handle tool calls recursively if supported
        if self.supportsTools and self._hasToolCalls(response):
            self._sendProgress("Processing tool calls...")

            response = self._handleToolCallsRecursive(
                response,
                messages,
                tools,
                userId,
                totals,
                0,
                streaming,
            )

        # B3 short-circuit: surface client-side tool call to frontend.
        if not php_empty(response.get('_pending_client_tool_call')):
            responseTimeMs = int((time.time() - startTime) * 1000)
            self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)
            return {
                'text': response.get('_pending_assistant_text') if response.get('_pending_assistant_text') is not None else '',
                'usage': {
                    'input_tokens': totals.inputTokens,
                    'output_tokens': totals.outputTokens,
                    'total_tokens': totals.inputTokens + totals.outputTokens,
                    'function_calls': totals.functionCallCount,
                },
                'model': self.model,
                'provider': self.name,
                'functions_called': totals.functionsCalled,
                'mcp_tools_called': totals.mcpToolsCalled,
                'mcp_calls_count': len(totals.mcpToolsCalled),
                'pending_client_tool_call': True,
                'pending_tool_calls': response.get('_pending_tool_calls') if response.get('_pending_tool_calls') is not None else [],
            }

        # Extract final text response
        textResponse = self._extractTextResponse(response)

        responseTimeMs = int((time.time() - startTime) * 1000)

        # Track usage
        self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)

        self._sendProgress("Response ready.")

        return {
            'text': textResponse,
            'usage': {
                'input_tokens': totals.inputTokens,
                'output_tokens': totals.outputTokens,
                'total_tokens': totals.inputTokens + totals.outputTokens,
                'function_calls': totals.functionCallCount,
            },
            'model': self.model,
            'provider': self.name,
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    def streamChat(self, message: str, onChunk, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        error_log(f"\U0001F50D CustomProvider::streamChat - streamingEnabled: {'true' if self.streamingEnabled else 'false'}")
        error_log(f"\U0001F50D CustomProvider::streamChat - sseClient: {'set' if self.sseClient else 'NULL'}")

        # Check if streaming is enabled and SSE client is available
        if not self.streamingEnabled or not self.sseClient:
            # Fallback to non-streaming
            error_log("⚠️ CustomProvider::streamChat - Falling back to non-streaming")
            result = self.chat(message, conversationHistory, options)
            onChunk(result['text'])
            return result

        # Use streaming
        error_log("✅ CustomProvider::streamChat - Using streaming mode")
        return self.chat(message, conversationHistory, {**options, 'streaming': True})

    def _makeRequest(self, messages: list, tools: list | None = None, streaming: bool = False) -> dict:
        tools = [] if tools is None else tools

        self._sendProgress(f"Connecting to {self.displayName} API...")

        # DeepSeek V4 (deepseek-v4-pro / deepseek-v4-flash) runs in thinking
        # mode by default and rejects temperature/top_p/penalty params. Drop
        # those fields and send `thinking: {type: enabled}` explicitly.
        # Other OpenAI-compatible providers keep the legacy temperature
        # behaviour.
        isDeepSeekV4 = self.name == 'deepseek' and self.model.startswith('deepseek-v4')

        payload = {
            'model': self.model,
            'max_tokens': self.maxTokens,
            'messages': messages,
        }

        if isDeepSeekV4:
            # Agent-level thinking switch: 'off' disables V4 thinking (cuts
            # reasoning latency); default/'on' keeps the V4 default (enabled).
            payload['thinking'] = {'type': 'disabled' if self.thinkingOverride == 'off' else 'enabled'}
        else:
            payload['temperature'] = self.temperature

        # GLM 5.2 (z.ai) defaults to heavy reasoning; disable thinking so it
        # answers directly instead of spending the token budget on reasoning
        # (temperature is kept, above). The agent-level switch can re-enable
        # it ('on') for reasoning-heavy nodes.
        if self.name == 'glm':
            payload['thinking'] = {'type': 'enabled' if self.thinkingOverride == 'on' else 'disabled'}

        if not php_empty(tools) and self.supportsTools:
            payload['tools'] = self._convertToOpenAITools(tools)
            payload['tool_choice'] = 'auto'

        # Enable streaming if requested
        if streaming:
            payload['stream'] = True
            # Request usage data in streaming mode (OpenAI-compatible APIs)
            payload['stream_options'] = {'include_usage': True}

        if self.logger:
            self.logger.logApiRequest(self.name, self.chatEndpoint, payload)

        # Build headers
        requestHeaders = {
            'Content-Type': 'application/json',
        }

        # Add API key if configured
        if not php_empty(self.apiKey):
            requestHeaders['Authorization'] = 'Bearer ' + self.apiKey

        # Merge custom headers
        requestHeaders = {**requestHeaders, **self.headers}

        jsonPayload = dumps(payload).encode('utf-8')

        try:
            # Post to the fully-qualified URL rather than a root-relative
            # path. httpx (like Guzzle) resolves a request path beginning
            # with "/" against the client base_url's ROOT, which silently
            # drops any path segment in base_url — e.g. z.ai's
            # "/api/paas/v4". Concatenating the rtrim'd base_url with the
            # endpoint preserves it for every provider.
            url = self.baseUrl + self.chatEndpoint

            if streaming:
                with self.httpClient.stream('POST', url, headers=requestHeaders, content=jsonPayload) as response:
                    try:
                        response.raise_for_status()
                    except httpx.HTTPStatusError as statusError:
                        # The body of a streaming response isn't read yet;
                        # read it so the handler below can quote it.
                        statusError.response.read()
                        raise

                    return self._handleStreamingResponse(response)
            else:
                response = self.httpClient.post(url, headers=requestHeaders, content=jsonPayload)
                response.raise_for_status()

                body = _json_decode(response.text)
                if self.logger:
                    self.logger.logApiResponse(self.name, 200, 0)
                return body

        except httpx.HTTPStatusError as e:
            statusCode = e.response.status_code

            if statusCode == 429:
                raise ProviderException.rateLimited(self.name)

            if statusCode == 401:
                raise ProviderException.authenticationFailed(self.name)

            # httpx's str(e) carries only the status line, unlike Guzzle's
            # RequestException message which embeds a response-body
            # excerpt; ChatController::humanizeProviderError pattern-matches
            # on that body (e.g. context_length_exceeded), so append it
            # explicitly. The streaming branch above read() it for exactly
            # this reason.
            errorDetails = str(e) + " | Response: " + guzzle_body_summary(e.response.text)

            raise ProviderException.apiError(self.name, errorDetails, statusCode)

        except httpx.RequestError as e:
            # Guzzle's ConnectException is a GuzzleException too; it carries
            # no HTTP status/response body, so PHP's $e->getCode() would be
            # 0.
            raise ProviderException.apiError(self.name, str(e), 0)

    def _handleStreamingResponse(self, response) -> dict:
        """Handle streaming response from API (OpenAI-compatible format)."""
        buffer = ''
        fullText = ''
        reasoningContent = ''
        usageData = None
        toolCalls = {}
        finishReason = 'stop'

        # "Thinking..." rather than "Streaming response..." — for B3 skill
        # turns and large inputs, several seconds can elapse before any
        # tokens actually arrive, making the old wording misleading.
        # (`_sendProgress` prefixes the display name.)
        self._sendProgress("Thinking...")

        done = False  # PHP `break 2` out of both loops
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

        for chunkBytes in response.iter_bytes(1024):
            buffer += decoder.decode(chunkBytes)

            # Process complete lines (SSE format: one line per event)
            while True:
                pos = buffer.find("\n")
                if pos == -1:
                    break
                line = buffer[0:pos]
                buffer = buffer[pos + 1:]

                # Skip empty lines
                if php_empty(line.strip()):
                    continue

                # Parse "data: " prefix
                if line.find('data: ') == 0:
                    data = line[6:]

                    # Check for stream end marker
                    if data == '[DONE]':
                        done = True
                        break

                    jsonData = _json_decode(data)
                    if not jsonData:
                        continue

                    choice = _first_choice(jsonData)
                    delta = choice.get('delta') if choice.get('delta') is not None else {}
                    finishReasonFromChunk = choice.get('finish_reason')

                    if finishReasonFromChunk:
                        finishReason = finishReasonFromChunk
                        self.emitUsageWarningIfTruncated(
                            finishReason,
                            (usageData.get('completion_tokens') if isinstance(usageData, dict) and usageData.get('completion_tokens') is not None else 0),
                        )

                    # Capture reasoning_content (DeepSeek V4 thinking mode).
                    # The API requires this to be round-tripped back as part
                    # of the assistant message on continuation requests,
                    # otherwise the next call returns 400 "reasoning_content
                    # must be passed back to the API".
                    if delta.get('reasoning_content') is not None:
                        reasoningContent += delta['reasoning_content']

                    # Extract content from delta
                    content = delta.get('content') if delta.get('content') is not None else ''
                    if content != '':
                        fullText += content

                        # Always stream text content to user, even when tool
                        # calls are present. Tool calls are accumulated
                        # separately and not shown to user.
                        if self.sseClient:
                            self.sseClient.sendChunk(content)

                    # Extract tool calls from delta
                    if delta.get('tool_calls') is not None:
                        for toolCallDelta in delta['tool_calls']:
                            index = toolCallDelta['index']

                            # Initialize tool call if not exists
                            if toolCalls.get(index) is None:
                                toolCalls[index] = {
                                    'id': '',
                                    'type': 'function',
                                    'function': {
                                        'name': '',
                                        'arguments': '',
                                    },
                                }

                            # Accumulate tool call data
                            if toolCallDelta.get('id') is not None:
                                toolCalls[index]['id'] = toolCallDelta['id']
                            deltaFunction = toolCallDelta.get('function') if isinstance(toolCallDelta.get('function'), dict) else {}
                            if deltaFunction.get('name') is not None:
                                toolCalls[index]['function']['name'] = deltaFunction['name']
                            if deltaFunction.get('arguments') is not None:
                                toolCalls[index]['function']['arguments'] += deltaFunction['arguments']

                    # Capture usage data if present (usually in final chunk)
                    if jsonData.get('usage') is not None:
                        usageData = jsonData['usage']
                        self.emitContextWarningIfHigh(
                            usageData.get('prompt_tokens') if usageData.get('prompt_tokens') is not None else 0
                        )

            if done:
                break

        if self.logger:
            self.logger.logApiResponse(self.name, 200, 0)

        # Build response in OpenAI format
        streamResponse = {
            'choices': [
                {
                    'message': {
                        'role': 'assistant',
                        'content': fullText,
                    },
                    'finish_reason': finishReason,
                },
            ],
            'usage': usageData if usageData is not None else {
                'prompt_tokens': 0,
                'completion_tokens': 0,
                'total_tokens': 0,
            },
        }

        # Preserve reasoning_content so _handleToolCallsRecursive includes
        # it when it appends assistantMessage to messages — required by
        # DeepSeek V4 thinking mode on multi-turn tool-call continuations.
        if reasoningContent != '':
            streamResponse['choices'][0]['message']['reasoning_content'] = reasoningContent

        # Add tool calls if present
        if not php_empty(toolCalls):
            streamResponse['choices'][0]['message']['tool_calls'] = list(toolCalls.values())

        return streamResponse

    def _handleToolCallsRecursive(
        self,
        response: dict,
        messages: list,
        tools: list,
        userId,
        totals: _Totals,
        depth: int = 0,
        streaming: bool = False,
    ) -> dict:
        """Handle tool calls recursively.

        `totals` replaces PHP's `&$inputTokens, &$outputTokens,
        &$functionCallCount, &$functionsCalled, &$mcpToolsCalled` reference
        parameters; `messages` is mutated in place like PHP's `&$messages`.
        """
        if depth >= self.maxRecursionDepth:
            if self.logger:
                self.logger.warning("Max recursion depth reached", {'depth': depth})
            return response

        choice = _first_choice(response)
        assistantMessage = choice.get('message') if choice.get('message') is not None else {}
        toolCalls = assistantMessage.get('tool_calls') if assistantMessage.get('tool_calls') is not None else []

        if php_empty(toolCalls):
            return response

        # B3: surface solo client-side tool turns to the frontend instead of
        # executing them server-side (run_skill_script lives in the
        # browser). Without this split, CustomProvider-backed models
        # (deepseek, glm, gamma4) silently fed 'No function executor'-style
        # errors to the model, which then fabricated results.
        clientCalls = []
        serverCalls = []
        for tc in toolCalls:
            function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
            name = function.get('name') if function.get('name') is not None else ''
            if self.isClientSideTool(name):
                clientCalls.append(tc)
            else:
                serverCalls.append(tc)

        if not php_empty(clientCalls) and php_empty(serverCalls):
            assistantText = assistantMessage.get('content') if assistantMessage.get('content') is not None else ''
            if not isinstance(assistantText, str):
                assistantText = ''
            normalized = []
            for tc in clientCalls:
                function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                args = function.get('arguments') if function.get('arguments') is not None else '{}'
                if isinstance(args, str):
                    decoded = _json_decode(args)
                    inputData = decoded if decoded is not None else []
                else:
                    inputData = args if args is not None else []
                normalized.append({
                    'id': tc['id'],
                    'name': function.get('name') if function.get('name') is not None else '',
                    'input': inputData,
                })
            error_log(f"\U0001F527 [CustomProvider:{self.name}] Client-side tool call detected; surfacing to frontend: " + dumps([n['name'] for n in normalized]))

            marker = self.emitClientToolCallEvent(normalized, assistantText)

            for tc in clientCalls:
                totals.functionCallCount += 1
                function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                totals.functionsCalled.append(function.get('name') if function.get('name') is not None else '')

            return {**response, **marker}

        if not php_empty(clientCalls):
            error_log(f"⚠️ [CustomProvider:{self.name}] Mixed client/server tool calls in one turn — failing client-side calls.")

        # Add assistant message with tool calls
        messages.append(assistantMessage)

        # Process each tool call
        for toolCall in toolCalls:
            totals.functionCallCount += 1
            functionName = toolCall['function']['name']
            arguments = _json_decode(toolCall['function']['arguments'])
            arguments = arguments if arguments is not None else []

            # Mixed-turn fallback for client-side tools.
            if self.isClientSideTool(functionName):
                messages.append({
                    'role': 'tool',
                    'tool_call_id': toolCall['id'],
                    'content': dumps({
                        'error': 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    }),
                })
                totals.functionsCalled.append(functionName)
                continue

            # Track tool name and check if it's an MCP tool
            totals.functionsCalled.append(functionName)
            if self.functionExecutor and self.functionExecutor.isMCPTool(functionName):
                totals.mcpToolsCalled.append(functionName)

            self._sendProgress(f"Executing function: {functionName}")
            if self.logger:
                self.logger.debug("Executing tool", {'name': functionName, 'input': arguments})

            # Execute the function
            result = self._executeFunction(functionName, arguments, userId)

            # Add tool result message
            messages.append({
                'role': 'tool',
                'tool_call_id': toolCall['id'],
                'content': result if isinstance(result, str) else dumps(result),
            })

        # Make continuation request (with streaming if enabled)
        self._sendProgress(f"Processing {self.displayName} response...")
        continuationResponse = self._makeRequest(messages, tools, streaming)

        # Accumulate tokens
        continuationUsage = continuationResponse.get('usage') if continuationResponse.get('usage') is not None else {}
        totals.inputTokens += continuationUsage.get('prompt_tokens') if continuationUsage.get('prompt_tokens') is not None else 0
        totals.outputTokens += continuationUsage.get('completion_tokens') if continuationUsage.get('completion_tokens') is not None else 0

        # Check if there are more tool calls
        if self._hasToolCalls(continuationResponse):
            return self._handleToolCallsRecursive(
                continuationResponse,
                messages,
                tools,
                userId,
                totals,
                depth + 1,
                streaming,
            )

        return continuationResponse

    def _executeFunction(self, functionName: str, parameters, userId) -> dict:
        if not self.functionExecutor:
            return {'error': 'No function executor configured'}

        try:
            startTime = time.time()
            result = self.functionExecutor.execute(functionName, parameters, userId)
            executionTime = int((time.time() - startTime) * 1000)

            if self.logger:
                self.logger.logFunctionCall(functionName, parameters, executionTime, True)

            # If MCP tool has UI, send SSE event to frontend
            if isinstance(result, dict) and result.get('_mcp_ui') is not None and self.sseClient:
                self.sseClient.sendCustomEvent('mcp_ui', {
                    'tool_name': functionName,
                    'ui_info': result['_mcp_ui'],
                })
                error_log(f"\U0001F4FA [MCP] Sent UI event to frontend for tool: {functionName}")

            return result
        except Exception as e:
            if self.logger:
                self.logger.logFunctionCall(functionName, parameters, 0, False)
            return {'error': str(e)}

    def _hasToolCalls(self, response: dict) -> bool:
        choice = _first_choice(response)
        message = choice.get('message') if choice.get('message') is not None else {}
        return not php_empty(message.get('tool_calls'))

    def _extractTextResponse(self, response: dict) -> str:
        choice = _first_choice(response)
        message = choice.get('message') if isinstance(choice.get('message'), dict) else {}

        # For DeepSeek Reasoner and similar models that separate reasoning
        # from content.
        if not php_empty(message.get('reasoning_content')):
            reasoning = message['reasoning_content']
            content = message.get('content') if message.get('content') is not None else ''

            # If there's content, show both. Otherwise just return content.
            if not php_empty(content):
                return content
            # Fallback to reasoning if no content
            return reasoning

        # Standard format
        return message.get('content') if message.get('content') is not None else ''

    def _buildMessages(self, conversationHistory: list, newMessage: str, systemPrompt: str) -> list:
        messages = [{'role': 'system', 'content': systemPrompt}]

        # Add conversation history
        for msg in conversationHistory:
            role = msg.get('role') if msg.get('role') is not None else 'user'

            # B3: round-trip tool_result and assistant-with-tool_calls so
            # client-side tool continuations (run_skill_script results from
            # the browser) reach the API intact. Stripping these turns broke
            # every continuation round for CustomProvider-backed models.
            if role == 'tool' and not php_empty(msg.get('tool_call_id')):
                entry = {
                    'role': 'tool',
                    'tool_call_id': msg['tool_call_id'],
                    'content': (
                        msg['content'] if isinstance(msg.get('content'), str)
                        else dumps(msg.get('content'))
                    ),
                }
                if not php_empty(msg.get('name')) and isinstance(msg.get('name'), str):
                    entry['name'] = msg['name']
                messages.append(entry)
                continue

            if role == 'assistant' and not php_empty(msg.get('tool_calls')):
                textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
                normalizedToolCalls = []
                for tc in msg['tool_calls']:
                    # Already in OpenAI wire shape — pass through.
                    if tc.get('function') is not None:
                        normalizedToolCalls.append(tc)
                        continue
                    # Frontend/webMCP shape: {id, name, input}.
                    if tc.get('name') is not None:
                        normalizedToolCalls.append({
                            'id': tc.get('id') if tc.get('id') is not None else '',
                            'type': 'function',
                            'function': {
                                'name': tc['name'],
                                'arguments': dumps(tc['input'] if tc.get('input') is not None else {}),
                            },
                        })
                        continue
                    normalizedToolCalls.append(tc)  # unknown shape — pass through
                messages.append({
                    'role': 'assistant',
                    'content': textContent if textContent != '' else None,
                    'tool_calls': normalizedToolCalls,
                })
                continue

            # Plain text turns (the common case).
            textContent = self._extractTextFromContent(msg.get('content'))
            if not php_empty(textContent):
                messages.append({
                    'role': role,
                    'content': textContent,
                })

        # B3 continuation: skip empty user turn after tool_result tail.
        isToolResultContinuation = (
            php_empty(newMessage.strip())
            and not php_empty(messages)
            and (messages[len(messages) - 1].get('role') if messages[len(messages) - 1].get('role') is not None else '') == 'tool'
        )
        if isToolResultContinuation:
            return messages

        # Add new user message
        messages.append({
            'role': 'user',
            'content': newMessage,
        })

        return messages

    def _extractTextFromContent(self, content) -> str:
        """Extract text from content (handles both string and array formats)."""
        if isinstance(content, str):
            return content

        if isinstance(content, (dict, list)):
            textParts = []
            values = content.values() if isinstance(content, dict) else content
            for block in values:
                if isinstance(block, dict) and block.get('text') is not None:
                    textParts.append(block['text'])
                elif isinstance(block, dict) and block.get('content') is not None:
                    textParts.append(block['content'])
                elif isinstance(block, str):
                    textParts.append(block)
            return "\n".join(textParts)

        return ''

    def _convertToOpenAITools(self, claudeTools: list) -> list:
        openAITools = []

        for tool in claudeTools:
            openAITools.append({
                'type': 'function',
                'function': {
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'parameters': tool.get('input_schema') if tool.get('input_schema') is not None else {'type': 'object', 'properties': []},
                },
            })

        return openAITools

    def _getTools(self) -> list:
        if not self.functionExecutor:
            return []

        return self.functionExecutor.getToolDefinitions()

    def getDefaultSystemPrompt(self) -> str:
        """PHP declares this `private`, but ProviderRequestBuilderTrait's
        buildSystemPrompt() calls `$this->getDefaultSystemPrompt()` from
        inside the class scope. Python mixins have no such scoping, so the
        name stays public here — same deviation as the 2a ClaudeProvider
        port.
        """
        # First, check if provider has a custom system_prompt in config
        providerConfig = self.config.get(f'providers.{self.name}', {})
        if not php_empty(providerConfig.get('system_prompt')):
            return providerConfig['system_prompt']

        # Fall back to prompt file
        promptFile = Path(__file__).resolve().parents[2] / 'resources' / 'prompts' / 'portfolio_assistant.txt'

        if promptFile.exists():
            return promptFile.read_text(encoding='utf-8')

        # Default fallback prompt
        return """You are a portfolio management assistant with direct access to user data and web search. Always use available functions - never claim lack of access.

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
- Never say "I don't have access" - you do via functions"""

    def _sendProgress(self, message: str) -> None:
        if self.sseClient:
            self.sseClient.sendProgress(f"{self.displayName}: {message}")

    def _trackUsage(self, userId, inputTokens: int, outputTokens: int, functionCallCount: int, responseTimeMs: int) -> None:
        if self.usageTracker:
            self.usageTracker.trackRequest({
                'user_id': userId,
                'provider': self.name,
                'model': self.model,
                'request_type': 'chat',
                'input_tokens': inputTokens,
                'output_tokens': outputTokens,
                'function_calls_count': functionCallCount,
                'response_time_ms': responseTimeMs,
                'status': 'success',
            })

    @staticmethod
    def buildHttpRequest(model: str, messages: list, tools: list, config: dict, maxTokens: int, temperature: float) -> dict:
        """Build an HTTP request for a custom/generic OpenAI-compatible API.
        This is a static method for parallel execution.

        Returns a dict with keys: url, headers, payload, provider.
        """
        payload = {
            'model': model,
            'messages': messages,
            'temperature': temperature,
            'max_tokens': maxTokens,
        }

        # Add tools in OpenAI format if supported
        supportsTools = config.get('supports_tools') if config.get('supports_tools') is not None else True
        if not php_empty(tools) and supportsTools:
            payload['tools'] = CustomProvider.convertToolsToOpenAIFormat(tools)
            payload['tool_choice'] = 'auto'

        baseUrl = (config.get('base_url') if config.get('base_url') is not None else '').rstrip('/')
        endpoint = config.get('chat_endpoint') if config.get('chat_endpoint') is not None else '/chat/completions'

        # Build headers
        headers = ['Content-Type: application/json']
        if not php_empty(config.get('api_key')):
            headers.append('Authorization: Bearer ' + config['api_key'])

        # Merge any custom headers
        if not php_empty(config.get('headers')) and isinstance(config.get('headers'), dict):
            for key, value in config['headers'].items():
                headers.append(f"{key}: {value}")

        return {
            'url': baseUrl + endpoint,
            'headers': headers,
            'payload': payload,
            'provider': 'custom',
        }

    @staticmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """Parse a custom/generic OpenAI-compatible API response. This is a
        static method for parallel execution.

        Returns a dict with keys: text, tool_calls, usage.
        """
        choice = _first_choice(decoded)
        message = choice.get('message') if choice.get('message') is not None else {}

        # Handle reasoning_content for DeepSeek-like models
        text = message.get('content') if message.get('content') is not None else ''
        if php_empty(text) and message.get('reasoning_content') is not None:
            text = message['reasoning_content']

        return {
            'text': text,
            'tool_calls': message.get('tool_calls') if message.get('tool_calls') is not None else [],
            'usage': CustomProvider.normalizeUsage(decoded.get('usage'), 'openai'),
        }

    @staticmethod
    def getApiFamily() -> str:
        """Get the API family for this provider."""
        return 'openai'
