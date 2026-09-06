"""Port of Providers/OpenAIProvider.php.

OpenAI Provider with function calling support.

Line-for-line port; PHP method names are preserved (private PHP methods
become `_name`). PHP semantics are reproduced with the helpers in
app.support.phpcompat (`php_empty` for `empty()`, `x.get(k) if ... is not
None else d` for `??`, dict-or-list for `is_array()`).
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
from app.providers.totals import _Totals
from app.providers.traits.client_side_tools import ClientSideToolsMixin
from app.providers.traits.provider_request_builder import ProviderRequestBuilderMixin
from app.services.debug_logger import DebugLogger
from app.support.logger import error_log
from app.support.phpcompat import php_empty
from app.support.phpjson import dumps


def _json_decode(s):
    """PHP json_decode($s, true): returns None on malformed input."""
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


def _first_choice(response: dict) -> dict:
    """PHP `$response['choices'][0] ?? []` — a missing key OR a missing index
    both collapse to [] through the null-coalescing operator.
    """
    choices = response.get('choices') if isinstance(response, dict) and response.get('choices') is not None else []
    if isinstance(choices, list) and len(choices) > 0:
        first = choices[0]
        return first if isinstance(first, dict) else {}
    if isinstance(choices, dict) and 0 in choices:
        first = choices[0]
        return first if isinstance(first, dict) else {}
    return {}


class OpenAIProvider(
    ProviderRequestBuilderMixin,
    ClientSideToolsMixin,
    AIProviderInterface,
    HttpRequestBuilderInterface,
):
    """Port of backend/src/Providers/OpenAIProvider.php."""

    SUPPORTED_MODELS = [
        'gpt-4-turbo-preview',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-3.5-turbo',
    ]

    def __init__(self, config: Configuration):
        self.config = config

        self.functionExecutor: FunctionExecutorInterface | None = None
        self.usageTracker: UsageTrackerInterface | None = None
        self.sseClient: StreamingClientInterface | None = None
        self.logger: DebugLogger | None = None

        # Output schema for constrained decoding (structured outputs).
        # Set per-call by chat(), read by makeRequest() (including recursive
        # tool-loop calls).
        self.pendingOutputSchema: dict | None = None

        # Streaming opt-out for the current chat() invocation. Default true
        # preserves prior behaviour. compareOnly() and similar contexts set
        # `options['stream'] = false` so the LLM call returns a single JSON
        # response with usage included — streaming would suppress the usage
        # chunk and force per-provider opt-in flags (e.g.
        # stream_options.include_usage).
        self.pendingStreaming: bool = True

        # PHP: $config->get('openai', []) — an empty PHP array is `{}` here so
        # the `?? default` reads below still work when the block is absent.
        openaiConfig = config.get('openai', {})
        self.model = openaiConfig.get('model') if openaiConfig.get('model') is not None else 'gpt-4-turbo-preview'
        self.maxTokens = openaiConfig.get('max_tokens') if openaiConfig.get('max_tokens') is not None else 4096
        self.temperature = openaiConfig.get('temperature') if openaiConfig.get('temperature') is not None else 0.7
        baseUrl = openaiConfig.get('base_url') if openaiConfig.get('base_url') is not None else 'https://api.openai.com'
        self.baseUrl = baseUrl.rstrip('/')
        self.maxRecursionDepth = config.get('max_recursion_depth', 10)

        self.httpClient = httpx.Client(
            base_url=self.baseUrl,
            timeout=600,  # 10 minutes for large responses
        )

        if config.isDebugEnabled():
            self.logger = DebugLogger(True)

        self._init_client_side_tools()

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this provider's httpx connection pool."""
        self.httpClient.close()

    def setFunctionExecutor(self, executor: FunctionExecutorInterface) -> 'OpenAIProvider':
        self.functionExecutor = executor
        return self

    def setUsageTracker(self, tracker: UsageTrackerInterface) -> 'OpenAIProvider':
        self.usageTracker = tracker
        return self

    def setSSEClient(self, client: StreamingClientInterface) -> 'OpenAIProvider':
        self.sseClient = client
        return self

    def setLogger(self, logger: DebugLogger) -> 'OpenAIProvider':
        self.logger = logger
        return self

    def getName(self) -> str:
        return 'openai'

    def isAvailable(self) -> bool:
        return self.config.isProviderConfigured('openai')

    def getModel(self) -> str:
        return self.model

    def setModel(self, model: str) -> 'OpenAIProvider':
        self.model = model
        return self

    def getSupportedModels(self) -> list:
        return list(self.SUPPORTED_MODELS)  # PHP returns a value copy

    def chat(self, message: str, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        startTime = time.time()

        self._sendProgress("Preparing OpenAI request...")

        systemPrompt = self.buildSystemPrompt(options)
        tools = options.get('tools') if options.get('tools') is not None else self._getTools()
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')
        toolChoice = options.get('tool_choice') if options.get('tool_choice') is not None else 'auto'

        # webMCP: register client-side tool names so the dispatch loop short-circuits
        if not php_empty(options.get('client_tool_names')) and isinstance(options.get('client_tool_names'), (dict, list)):
            self.setPerRequestClientSideToolNames(options['client_tool_names'])

        # Stash output_schema for makeRequest() (including recursive tool-loop calls)
        self.pendingOutputSchema = (
            options['output_schema']
            if not php_empty(options.get('output_schema')) and isinstance(options.get('output_schema'), (dict, list))
            else None
        )
        # Stash streaming flag; default true preserves the prior
        # behaviour for primary-chat callers. Setting this to false
        # (compareOnly does) makes the LLM call return a single JSON
        # response with usage included.
        self.pendingStreaming = options.get('stream') if options.get('stream') is not None else True

        # Build messages array
        messages = self._buildMessages(
            conversationHistory,
            message,
            systemPrompt,
            options.get('image_attachments') if options.get('image_attachments') is not None else [],
            options.get('pdf_attachments') if options.get('pdf_attachments') is not None else [],
        )

        # webMCP: append browser-tab client tools; convertToOpenAITools() inside
        # makeRequest() will convert these alongside the existing tools using the
        # same input_schema→parameters rename it applies to all tools.
        clientTools = options.get('client_tools') if options.get('client_tools') is not None else []
        if isinstance(clientTools, (dict, list)):
            for ct in clientTools:
                tools.append({
                    'name': ct['name'],
                    'description': ct.get('description') if ct.get('description') is not None else '',
                    'input_schema': ct.get('input_schema') if ct.get('input_schema') is not None else {
                        'type': 'object',
                        'properties': {},
                        'required': [],
                    },
                })

        # Make initial request
        response = self._makeRequest(messages, tools, toolChoice)

        # Track tokens and tool calls
        usage = response.get('usage') if response.get('usage') is not None else {}
        totals = _Totals(
            inputTokens=usage.get('prompt_tokens') if usage.get('prompt_tokens') is not None else 0,
            outputTokens=usage.get('completion_tokens') if usage.get('completion_tokens') is not None else 0,
        )

        # Handle tool calls recursively
        if self._hasToolCalls(response):
            self._sendProgress("Processing tool calls...")

            response = self._handleToolCallsRecursive(
                response,
                messages,
                tools,
                userId,
                totals,
            )

        # B3 short-circuit: if the recursion bailed because the LLM called
        # a client-side tool, return the assistant's pre-tool text and a
        # marker the controller forwards to the frontend. The
        # 'client_tool_call' SSE event was already emitted from inside
        # handleToolCallsRecursive.
        if not php_empty(response.get('_pending_client_tool_call')):
            responseTimeMs = int((time.time() - startTime) * 1000)
            self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)
            self.pendingOutputSchema = None
            return {
                'text': response.get('_pending_assistant_text') if response.get('_pending_assistant_text') is not None else '',
                'usage': {
                    'input_tokens': totals.inputTokens,
                    'output_tokens': totals.outputTokens,
                    'total_tokens': totals.inputTokens + totals.outputTokens,
                    'function_calls': totals.functionCallCount,
                },
                'model': self.model,
                'provider': 'openai',
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

        # Clear pending schema so it doesn't bleed into the next call
        self.pendingOutputSchema = None

        return {
            'text': textResponse,
            'usage': {
                'input_tokens': totals.inputTokens,
                'output_tokens': totals.outputTokens,
                'total_tokens': totals.inputTokens + totals.outputTokens,
                'function_calls': totals.functionCallCount,
            },
            'model': self.model,
            'provider': 'openai',
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    def streamChat(self, message: str, onChunk, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        result = self.chat(message, conversationHistory, options)
        onChunk(result['text'])
        return result

    def _makeRequest(self, messages: list, tools: list | None = None, toolChoice='auto') -> dict:
        tools = [] if tools is None else tools

        self._sendProgress("Connecting to OpenAI API...")

        # Streaming is controlled by the caller via self.pendingStreaming
        # (set by chat() from options['stream']). Non-streaming returns a
        # single JSON response with reliable usage data; streaming requires
        # stream_options.include_usage to surface usage, which we can't
        # guarantee across every call site.
        streaming = self.pendingStreaming

        apiKey = self.config.get('openai.api_key')
        if php_empty(apiKey):
            raise ProviderException.authenticationFailed('openai')

        payload = {
            'model': self.model,
            'messages': messages,
        }

        # o1 and o3 models don't support temperature parameter
        isReasoningModel = self.model.startswith('o1') or self.model.startswith('o3')
        if not isReasoningModel:
            payload['temperature'] = self.temperature

        # GPT-5 and reasoning models use max_completion_tokens instead of max_tokens
        if self.model.startswith('gpt-5') or isReasoningModel:
            payload['max_completion_tokens'] = self.maxTokens
        else:
            payload['max_tokens'] = self.maxTokens

        # o1 and o3 models don't support tools/function calling
        if not php_empty(tools) and not isReasoningModel:
            payload['tools'] = self._convertToOpenAITools(tools)
            payload['tool_choice'] = toolChoice

        # Constrained decoding via Structured Outputs.
        # Requires gpt-4o-2024-08-06+, gpt-4o-mini-2024-07-18+, gpt-4.1+, etc.
        if self.pendingOutputSchema is not None:
            schema = self.pendingOutputSchema
            payload['response_format'] = {
                'type': 'json_schema',
                'json_schema': {
                    'name': schema.get('name') if schema.get('name') is not None else 'output',
                    'description': schema.get('description') if schema.get('description') is not None else '',
                    'strict': bool(schema.get('strict') if schema.get('strict') is not None else True),
                    'schema': schema.get('schema') if schema.get('schema') is not None else {},
                },
            }

        # Enable streaming if SSE client is available
        if streaming:
            payload['stream'] = True
            # Without this, OpenAI streamed responses omit the usage block
            # entirely, so token counts (and therefore cost) come back as 0.
            # The final SSE chunk then carries a usage object we capture in
            # handleStreamingResponse().
            payload['stream_options'] = {'include_usage': True}

        # Debug: Log the full payload to help diagnose 400 errors
        error_log(f"[OpenAIProvider] Model: {self.model}, MaxTokens: {self.maxTokens}, Tools count: " + str(len(tools)))
        error_log("[OpenAIProvider] Full payload: " + dumps(payload))

        if self.logger:
            self.logger.logApiRequest('openai', '/v1/chat/completions', payload)

        try:
            headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            }
            jsonPayload = dumps(payload).encode('utf-8')

            if streaming:
                with self.httpClient.stream('POST', '/v1/chat/completions', headers=headers, content=jsonPayload) as response:
                    try:
                        response.raise_for_status()
                    except httpx.HTTPStatusError as statusError:
                        # The body of a streaming response isn't read yet; read it
                        # so the handler below can quote it (Guzzle hands us the
                        # full error body on the exception).
                        statusError.response.read()
                        raise

                    return self._handleStreamingResponse(response)
            else:
                response = self.httpClient.post('/v1/chat/completions', headers=headers, content=jsonPayload)
                response.raise_for_status()
                body = _json_decode(response.text)
                if self.logger:
                    self.logger.logApiResponse('openai', 200, 0)
                return body
        except httpx.HTTPStatusError as e:
            statusCode = e.response.status_code

            if statusCode == 429:
                raise ProviderException.rateLimited('openai')

            if statusCode == 401:
                raise ProviderException.authenticationFailed('openai')

            raise ProviderException.apiError('openai', str(e), statusCode)
        except httpx.RequestError as e:
            # Guzzle's ConnectException is a GuzzleException too; it carries no
            # HTTP status, so PHP's $e->getCode() would be 0.
            raise ProviderException.apiError('openai', str(e), 0)

    def _handleStreamingResponse(self, response) -> dict:
        """Handle streaming response from OpenAI API."""
        buffer = ''
        fullText = ''
        usageData = None
        toolCalls = {}
        finishReason = 'stop'

        # "Thinking..." rather than "Streaming response..." — for B3
        # skill turns and large inputs, several seconds can elapse
        # before any tokens actually arrive, making the old wording
        # misleading. (`sendProgress` prefixes the provider name.)
        self._sendProgress("Thinking...")

        hasToolCalls = False  # Track if we encounter tool calls
        done = False  # PHP `break 2` out of both loops
        decoder = codecs.getincrementaldecoder('utf-8')()

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

                    # Extract content from delta
                    content = delta.get('content') if delta.get('content') is not None else ''
                    if content != '':
                        fullText += content

                        # Only send chunks if NO tool calls detected yet (Phase 1 simple response or Phase 2 after tools)
                        if not hasToolCalls:
                            if self.sseClient:
                                self.sseClient.sendChunk(content)

                    # Extract tool calls from delta
                    if delta.get('tool_calls') is not None:
                        hasToolCalls = True  # Mark that we have tool calls (Phase 1 with functions)
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
            self.logger.logApiResponse('openai', 200, 0)

        # Build message structure
        message = {
            'role': 'assistant',
            'content': fullText,
        }

        # Add tool calls if present
        if not php_empty(toolCalls):
            message['tool_calls'] = list(toolCalls.values())

        # Return in same format as non-streaming response
        return {
            'choices': [
                {
                    'message': message,
                    'finish_reason': finishReason,
                },
            ],
            'usage': usageData if usageData is not None else {
                'prompt_tokens': 0,
                'completion_tokens': 0,
                'total_tokens': 0,
            },
        }

    def _handleToolCallsRecursive(
        self,
        response: dict,
        messages: list,
        tools: list,
        userId,
        totals: _Totals,
        depth: int = 0,
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

        # B3: detect client-side tools (executed in the browser via
        # window.pyodideRunner). If the assistant turn invoked any of
        # them, surface to the frontend and bail out of server-side
        # recursion. We restrict to the case where ALL tool calls are
        # client-side; mixed turns fail closed for the client-side ones
        # so the existing recursion still resolves the rest.
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
            error_log("🔧 [OpenAIProvider] Client-side tool call detected; surfacing to frontend: " + dumps([n['name'] for n in normalized]))

            marker = self.emitClientToolCallEvent(normalized, assistantText)

            for tc in clientCalls:
                totals.functionCallCount += 1
                function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                totals.functionsCalled.append(function.get('name') if function.get('name') is not None else '')

            return {**response, **marker}

        if not php_empty(clientCalls) and not php_empty(serverCalls):
            error_log("⚠️ [OpenAIProvider] Mixed client/server tool calls in one turn — failing client-side calls.")

        # Add assistant message with tool calls
        messages.append(assistantMessage)

        # Process each tool call (client-side ones in mixed turns get a
        # synthetic error tool_result so the recursion can complete).
        for toolCall in toolCalls:
            totals.functionCallCount += 1
            functionName = toolCall['function']['name']
            arguments = _json_decode(toolCall['function']['arguments'])
            arguments = arguments if arguments is not None else []

            # Track tool name and check if it's an MCP tool
            totals.functionsCalled.append(functionName)
            if self.functionExecutor and self.functionExecutor.isMCPTool(functionName):
                totals.mcpToolsCalled.append(functionName)

            if self.isClientSideTool(functionName):
                # Mixed-turn fallback: tell the model the client tool call
                # can't run alongside server tools and let it continue.
                messages.append({
                    'role': 'tool',
                    'tool_call_id': toolCall['id'],
                    'content': dumps({
                        'error': 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    }),
                })
                continue

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

        # Make continuation request
        self._sendProgress("Processing OpenAI response...")
        continuationResponse = self._makeRequest(messages, tools)

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
                error_log(f"📺 [MCP] Sent UI event to frontend for tool: {functionName}")

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
        return message.get('content') if message.get('content') is not None else ''

    def _buildMessages(self, conversationHistory: list, newMessage: str, systemPrompt: str, imageAttachments: list | None = None, pdfAttachments: list | None = None) -> list:
        imageAttachments = [] if imageAttachments is None else imageAttachments
        pdfAttachments = [] if pdfAttachments is None else pdfAttachments

        messages = []

        # Add system message
        messages.append({
            'role': 'system',
            'content': systemPrompt,
        })

        # Add conversation history
        for msg in conversationHistory:
            role = msg.get('role') if msg.get('role') is not None else 'user'

            # B3: tool-result turns from a prior client-side dispatch.
            # OpenAI's native shape — pass through verbatim.
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

            # B3: assistant turns carrying tool_calls (the LLM's own
            # tool_use from the prior round). Normalize from frontend shape
            # {id, name, input} to OpenAI wire shape
            # {id, type:'function', function:{name, arguments:string}}.
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
                entry = {
                    'role': 'assistant',
                    'content': textContent if textContent != '' else None,
                    'tool_calls': normalizedToolCalls,
                }
                messages.append(entry)
                continue

            # Plain text turns (the common case).
            textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
            if not php_empty(textContent):
                messages.append({
                    'role': role,
                    'content': textContent,
                })

        # B3 continuation: the second shot of a client-tool round arrives
        # with the tool_result already at the tail and an empty
        # newMessage. Don't append an empty user turn — OpenAI 400s.
        isToolResultContinuation = (
            php_empty(newMessage.strip())
            and php_empty(imageAttachments)
            and php_empty(pdfAttachments)
            and not php_empty(messages)
            and (messages[len(messages) - 1].get('role') if messages[len(messages) - 1].get('role') is not None else '') == 'tool'
        )
        if isToolResultContinuation:
            return messages

        # Add new user message. If images or PDFs are attached, switch to the
        # structured content-array shape — OpenAI Vision spec for images
        # (`image_url`), File-input spec for PDFs (`file` block with a
        # data: URL embedding the base64).
        if not php_empty(imageAttachments) or not php_empty(pdfAttachments):
            parts = [{'type': 'text', 'text': newMessage}]
            for i, pdf in enumerate(pdfAttachments):
                parts.append({
                    'type': 'file',
                    'file': {
                        'filename': pdf.get('name') if pdf.get('name') is not None else ('document-' + str(i + 1) + '.pdf'),
                        'file_data': 'data:' + pdf['mime_type'] + ';base64,' + pdf['data'],
                    },
                })
            for img in imageAttachments:
                parts.append({
                    'type': 'image_url',
                    'image_url': {
                        'url': 'data:' + img['mime_type'] + ';base64,' + img['data'],
                    },
                })
            messages.append({'role': 'user', 'content': parts})
        else:
            messages.append({'role': 'user', 'content': newMessage})

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

    def getContextWindow(self) -> int:
        # gpt-4o / gpt-4-turbo: 128K
        return 128000

    def getDefaultSystemPrompt(self) -> str:
        """PHP declares this `private`, but ProviderRequestBuilderTrait's
        buildSystemPrompt() calls `$this->getDefaultSystemPrompt()` from
        inside the class scope. Python mixins have no such scoping, so the
        name stays public here — same deviation as the 2a ClaudeProvider port.
        """
        # First, check if there's a custom system_prompt in config
        customPrompt = self.config.get('openai.system_prompt')
        if not php_empty(customPrompt):
            return customPrompt

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
            self.sseClient.sendProgress(f"OpenAI: {message}")

    def _trackUsage(self, userId, inputTokens: int, outputTokens: int, functionCallCount: int, responseTimeMs: int) -> None:
        if self.usageTracker:
            self.usageTracker.trackRequest({
                'user_id': userId,
                'provider': 'openai',
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
        """Build an HTTP request for OpenAI API (static method for parallel execution).
        This is the base implementation for OpenAI-compatible APIs.

        Returns a dict with keys: url, headers, payload, provider.
        """
        payload = {
            'model': model,
            'messages': messages,
            'temperature': temperature,
            'max_completion_tokens': maxTokens,
        }

        # Add tools in OpenAI format
        if not php_empty(tools):
            payload['tools'] = OpenAIProvider.convertToolsToOpenAIFormat(tools)

        baseUrl = config['base_url'] if not php_empty(config.get('base_url')) else 'https://api.openai.com'
        endpoint = config['chat_endpoint'] if not php_empty(config.get('chat_endpoint')) else '/v1/chat/completions'

        return {
            'url': baseUrl.rstrip('/') + endpoint,
            'headers': [
                'Content-Type: application/json',
                'Authorization: Bearer ' + config['api_key'],
            ],
            'payload': payload,
            'provider': 'openai',
        }

    @staticmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """Parse OpenAI API response (static method for parallel execution).
        This is the base implementation for OpenAI-compatible APIs.

        Returns a dict with keys: text, tool_calls, usage.
        """
        choice = _first_choice(decoded)
        message = choice.get('message') if choice.get('message') is not None else {}

        return {
            'text': message.get('content') if message.get('content') is not None else '',
            'tool_calls': message.get('tool_calls') if message.get('tool_calls') is not None else [],
            'usage': OpenAIProvider.normalizeUsage(decoded.get('usage'), 'openai'),
        }

    @staticmethod
    def getApiFamily() -> str:
        """Get the API family for this provider."""
        return 'openai'
