"""Port of Providers/GrokProvider.php.

Grok AI Provider (xAI) — OpenAI-compatible wire format, dedicated base URL.
Line-for-line port; PHP method names are preserved (private PHP methods
become `_name`). PHP semantics are reproduced with the helpers in
app.support.phpcompat (`php_empty` for `empty()`, `x.get(k) if ... is not
None else d` for `??`, dict-or-list for `is_array()`).

Grok is NOT a copy of OpenAIProvider: constants for base URL/endpoint (a
`base_url` in config is ignored, PHP:30-31/1004), `streaming` flows through
as a parameter/option rather than an SSE-client-driven flag, error handling
disables Guzzle's automatic HTTP-error exceptions and checks status codes
manually (PHP:311-332) with a second mapping block for genuine transport
failures (PHP:342-352), and the tool loop carries extra duplicate-call
detection and a manager-agent "workflow complete" marker (PHP:600-663) that
OpenAIProvider's loop does not have.
"""
from __future__ import annotations

import codecs
import hashlib
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
from app.providers._http import SHARED_SSL_CONTEXT
from app.providers.totals import _Totals
from app.providers.traits.client_side_tools import ClientSideToolsMixin
from app.providers.traits.provider_request_builder import ProviderRequestBuilderMixin
from app.services.debug_logger import DebugLogger
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_empty, php_intval, php_strval
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
    return {}


def _xai_tool_parameters(tool: dict) -> dict:
    """Shared schema massaging for `convertToXAITools`/`convertToolsForXAI`
    (PHP:834-919 and PHP:1024-1100 are near-identical duplicates — kept as
    one helper here rather than two copies of the same logic).
    """
    inputSchema = tool.get('input_schema') if tool.get('input_schema') is not None else {'type': 'object', 'properties': {}}
    # PHP: json_decode(json_encode($inputSchema), true) — deep, plain-dict copy.
    parameters = json.loads(dumps(inputSchema))

    # xAI doesn't accept $schema.
    parameters.pop('$schema', None)

    # Ensure required is an array, not empty.
    if php_empty(parameters.get('required')):
        parameters.pop('required', None)

    properties = parameters.get('properties')
    if isinstance(properties, dict):
        originalProps = dict(properties)  # snapshot: PHP's foreach captures $propSchema by value
        for propName, propSchema in originalProps.items():
            if php_empty(propSchema) or not isinstance(propSchema, dict) or propSchema.get('type') is None:
                desc = propSchema.get('description') if isinstance(propSchema, dict) and propSchema.get('description') is not None else ''
                properties[propName] = {'type': 'string', 'description': desc}
            else:
                properties[propName].pop('default', None)
                if propSchema.get('type') != 'array':
                    properties[propName].pop('items', None)

                if propSchema.get('enum') is not None and propSchema.get('type') == 'string':
                    properties[propName]['enum'] = [php_strval(v) for v in propSchema['enum']]
                if propSchema.get('enum') is not None and propSchema.get('type') in ('integer', 'number'):
                    properties[propName]['enum'] = [php_intval(v) if is_numeric(v) else v for v in propSchema['enum']]

                # xAI's tool-schema validator rejects string enums whose
                # values contain '/' (e.g. skill dir_names like
                # "GEO/geo-audit"). Drop the enum entirely when any value
                # has one.
                curEnum = properties[propName].get('enum')
                if isinstance(curEnum, list):
                    for v in curEnum:
                        if isinstance(v, str) and '/' in v:
                            properties[propName].pop('enum', None)
                            break

    if php_empty(parameters.get('properties')):
        parameters['properties'] = {}

    return parameters


class GrokProvider(
    ProviderRequestBuilderMixin,
    ClientSideToolsMixin,
    AIProviderInterface,
    HttpRequestBuilderInterface,
):
    """Port of backend/src/Providers/GrokProvider.php."""

    BASE_URL = 'https://api.x.ai'
    CHAT_ENDPOINT = '/v1/chat/completions'

    def __init__(self, config: Configuration):
        self.config = config

        self.functionExecutor: FunctionExecutorInterface | None = None
        self.usageTracker: UsageTrackerInterface | None = None
        self.sseClient: StreamingClientInterface | None = None
        self.logger: DebugLogger | None = None

        providerConfig = config.get('providers.grok', {})

        self.displayName = providerConfig.get('display_name') if providerConfig.get('display_name') is not None else 'Grok'
        self.model = providerConfig.get('model') if providerConfig.get('model') is not None else 'grok-4-1-fast-reasoning'
        self.maxTokens = providerConfig.get('max_tokens') if providerConfig.get('max_tokens') is not None else 16384
        self.temperature = providerConfig.get('temperature') if providerConfig.get('temperature') is not None else 0.7
        self.apiKey = providerConfig.get('api_key') if providerConfig.get('api_key') is not None else ''
        self.maxRecursionDepth = config.get('max_recursion_depth', 10)
        self.supportedModels = providerConfig.get('supported_models') if providerConfig.get('supported_models') is not None else [self.model]
        self.streamingEnabled = providerConfig.get('streaming') if providerConfig.get('streaming') is not None else True

        # PHP constant base_uri — a `base_url` in providerConfig is ignored.
        self.httpClient = httpx.Client(
            base_url=self.BASE_URL,
            timeout=600,
            # Shared SSL context: httpx 0.28 builds (and certifi-loads) a new one
            # per Client, and every enabled provider is constructed per chat request.
            verify=SHARED_SSL_CONTEXT,
        )

        if config.isDebugEnabled():
            self.logger = DebugLogger(True)

        self._init_client_side_tools()

    # Diagnostic-only dedup cache for unrecognized streaming delta keys.
    # Mirrors PHP's `static $loggedUnknownKeys` inside handleStreamingResponse
    # (a function-static, shared across calls/instances within the process).
    _LOGGED_UNKNOWN_KEYS: set = set()

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this provider's httpx connection pool."""
        self.httpClient.close()

    def setFunctionExecutor(self, executor: FunctionExecutorInterface) -> 'GrokProvider':
        self.functionExecutor = executor
        return self

    def setUsageTracker(self, tracker: UsageTrackerInterface) -> 'GrokProvider':
        self.usageTracker = tracker
        return self

    def setSSEClient(self, client: StreamingClientInterface) -> 'GrokProvider':
        self.sseClient = client
        return self

    def setLogger(self, logger: DebugLogger) -> 'GrokProvider':
        self.logger = logger
        return self

    def getName(self) -> str:
        return 'grok'

    def getDisplayName(self) -> str:
        return self.displayName

    def isAvailable(self) -> bool:
        return not php_empty(self.apiKey)

    def getModel(self) -> str:
        return self.model

    def setModel(self, model: str) -> 'GrokProvider':
        self.model = model
        return self

    def getSupportedModels(self) -> list:
        return list(self.supportedModels)  # PHP arrays are value types; never leak the live list

    def chat(self, message: str, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        startTime = time.time()

        self._sendProgress("Preparing request...")

        systemPrompt = self.buildSystemPrompt(options)
        # Honor caller-supplied tools (e.g. workflow client-side run_skill_script)
        # regardless of functionExecutor — client tools run in the browser. The
        # gate only governs this provider's OWN server tools (_getTools()).
        tools = options.get('tools') if options.get('tools') is not None else (self._getTools() if self.functionExecutor else [])
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')
        streaming = options.get('streaming') if options.get('streaming') is not None else False
        toolChoice = options.get('tool_choice') if options.get('tool_choice') is not None else 'auto'

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

        messages = self._buildMessages(
            conversationHistory,
            message,
            systemPrompt,
            options.get('image_attachments') if options.get('image_attachments') is not None else [],
        )

        response = self._makeRequest(messages, tools, streaming, toolChoice)

        inputTokens = response['usage']['prompt_tokens'] if response.get('usage') is not None and response['usage'].get('prompt_tokens') is not None else 0
        outputTokens = response['usage']['completion_tokens'] if response.get('usage') is not None and response['usage'].get('completion_tokens') is not None else 0
        totals = _Totals(inputTokens=inputTokens, outputTokens=outputTokens)

        if self._hasToolCalls(response):
            self._sendProgress("Processing tool calls...")
            executedTools: dict = {}

            response = self._handleToolCallsRecursive(
                response,
                messages,
                tools,
                userId,
                totals,
                0,
                streaming,
                executedTools,
                toolChoice,
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
                'provider': 'grok',
                'functions_called': totals.functionsCalled,
                'mcp_tools_called': totals.mcpToolsCalled,
                'mcp_calls_count': len(totals.mcpToolsCalled),
                'pending_client_tool_call': True,
                'pending_tool_calls': response.get('_pending_tool_calls') if response.get('_pending_tool_calls') is not None else [],
            }

        textResponse = self._extractTextResponse(response)
        responseTimeMs = int((time.time() - startTime) * 1000)

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
            'provider': 'grok',
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    def streamChat(self, message: str, onChunk, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        if not self.streamingEnabled or not self.sseClient:
            result = self.chat(message, conversationHistory, options)
            onChunk(result['text'])
            return result

        return self.chat(message, conversationHistory, {**options, 'streaming': True})

    def _makeRequest(self, messages: list, tools: list | None = None, streaming: bool = False, toolChoice='auto') -> dict:
        tools = [] if tools is None else tools

        self._sendProgress("Connecting to xAI API...")

        payload = {
            'model': self.model,
            'max_tokens': self.maxTokens,
            'temperature': self._formatTemperature(self.temperature),
            'messages': messages,
        }

        if not php_empty(tools):
            payload['tools'] = self._convertToXAITools(tools)
            payload['tool_choice'] = toolChoice

            lastMsg = messages[-1] if messages else {}
            userMsgContent = lastMsg.get('content') if isinstance(lastMsg.get('content'), str) else ''
            userMsgLen = len(userMsgContent)
            firstMsg = messages[0] if messages else {}
            systemMsgLen = len(firstMsg.get('content')) if isinstance(firstMsg.get('content'), str) else 0
            toolNames = ', '.join(
                (t.get('function', {}).get('name') if t.get('function', {}).get('name') is not None else '?')
                for t in payload['tools']
            )
            error_log(
                f"[Grok] Sending {len(payload['tools'])} tool(s): {toolNames}"
                f" | tool_choice: {dumps(toolChoice)}"
                f" | model: {payload.get('model') if payload.get('model') is not None else '?'}"
                f" | system_msg_len: {systemMsgLen}"
                f" | user_msg_len: {userMsgLen}"
            )
            if userMsgLen > 10000:
                error_log("[Grok] user_msg head (first 400 chars): " + dumps(userMsgContent[:400]))
                error_log("[Grok] user_msg tail (last 400 chars): " + dumps(userMsgContent[-400:]))

        if streaming:
            payload['stream'] = True
            # Request usage data in streaming mode (OpenAI-compatible APIs)
            payload['stream_options'] = {'include_usage': True}

        if self.logger:
            self.logger.logApiRequest('grok', self.CHAT_ENDPOINT, payload)

        headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + self.apiKey,
        }
        jsonPayload = dumps(payload).encode('utf-8')

        try:
            if streaming:
                with self.httpClient.stream('POST', self.CHAT_ENDPOINT, headers=headers, content=jsonPayload) as response:
                    statusCode = response.status_code

                    if statusCode >= 400:
                        response.read()
                        errorBody = response.text
                        errorMessage = self._extractErrorMessage(_json_decode(errorBody), errorBody)

                        if self.logger:
                            self.logger.error("Grok API error", {'status': statusCode, 'error': errorMessage})

                        if statusCode == 429:
                            raise ProviderException.rateLimited('grok')
                        if statusCode == 401:
                            raise ProviderException.authenticationFailed('grok')

                        raise ProviderException.apiError('grok', f"API error: {errorMessage}", statusCode)

                    return self._handleStreamingResponse(response)
            else:
                response = self.httpClient.post(self.CHAT_ENDPOINT, headers=headers, content=jsonPayload)
                statusCode = response.status_code

                if statusCode >= 400:
                    errorBody = response.text
                    errorMessage = self._extractErrorMessage(_json_decode(errorBody), errorBody)

                    if self.logger:
                        self.logger.error("Grok API error", {'status': statusCode, 'error': errorMessage})

                    if statusCode == 429:
                        raise ProviderException.rateLimited('grok')
                    if statusCode == 401:
                        raise ProviderException.authenticationFailed('grok')

                    raise ProviderException.apiError('grok', f"API error: {errorMessage}", statusCode)

                body = _json_decode(response.text)
                if self.logger:
                    self.logger.logApiResponse('grok', 200, 0)
                return body

        except httpx.RequestError as e:
            # Guzzle's GuzzleException with http_errors=false is reachable
            # only by genuine transport failures (DNS, timeout, connection
            # refused) — HTTP status errors are handled manually above.
            # $e->getCode() for such exceptions is 0.
            statusCode = 0

            if statusCode == 429:
                raise ProviderException.rateLimited('grok')
            if statusCode == 401:
                raise ProviderException.authenticationFailed('grok')

            raise ProviderException.apiError('grok', str(e), statusCode)

    @staticmethod
    def _extractErrorMessage(errorData, errorBody: str):
        """PHP: `$errorData['error']['message'] ?? $errorData['error'] ?? $errorBody`."""
        if isinstance(errorData, dict) and errorData.get('error') is not None:
            errorField = errorData['error']
            if isinstance(errorField, dict) and errorField.get('message') is not None:
                return errorField['message']
            return errorField
        return errorBody

    def _handleStreamingResponse(self, response) -> dict:
        """Handle streaming response from xAI API."""
        buffer = ''
        fullText = ''
        usageData = None
        toolCalls = {}
        finishReason = 'stop'
        chunkCount = 0
        deltaWithDataCount = 0

        # "Thinking..." fires before any tokens actually arrive, which can
        # be many seconds for B3 skill turns or large inputs.
        self._sendProgress("Thinking...")

        done = False  # PHP `break 2` out of both loops
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

        for chunkBytes in response.iter_bytes(1024):
            buffer += decoder.decode(chunkBytes)

            while True:
                pos = buffer.find("\n")
                if pos == -1:
                    break
                line = buffer[0:pos]
                buffer = buffer[pos + 1:]

                if php_empty(line.strip()):
                    continue

                if line.find('data: ') == 0:
                    data = line[6:]

                    if data == '[DONE]':
                        done = True
                        break

                    jsonData = _json_decode(data)
                    if not jsonData:
                        continue

                    # Check for error in stream
                    if isinstance(jsonData, dict) and jsonData.get('error') is not None:
                        errorField = jsonData['error']
                        if isinstance(errorField, dict) and errorField.get('message') is not None:
                            errorMessage = errorField['message']
                        elif errorField is not None:
                            errorMessage = errorField
                        else:
                            errorMessage = 'Unknown stream error'
                        if self.logger:
                            self.logger.error("Grok stream error", {'error': errorMessage})
                        raise ProviderException.apiError('grok', f"Stream error: {errorMessage}", 500)

                    chunkCount += 1
                    choice = _first_choice(jsonData)
                    delta = choice.get('delta') if choice.get('delta') is not None else {}
                    finishReasonFromChunk = choice.get('finish_reason')

                    if isinstance(delta, dict) and not php_empty(delta):
                        deltaWithDataCount += 1
                        if deltaWithDataCount == 1:
                            error_log(
                                "[Grok] First chunk delta keys: [" + ",".join(delta.keys())
                                + "] | first 200 chars: " + dumps(delta)[:200]
                            )

                    if finishReasonFromChunk:
                        finishReason = finishReasonFromChunk
                        self.emitUsageWarningIfTruncated(
                            finishReason,
                            (usageData.get('completion_tokens') if isinstance(usageData, dict) and usageData.get('completion_tokens') is not None else 0),
                        )

                    if isinstance(delta, dict):
                        for key, val in delta.items():
                            if key not in ('role', 'content', 'tool_calls', 'function_call', 'refusal'):
                                if key not in self._LOGGED_UNKNOWN_KEYS:
                                    self._LOGGED_UNKNOWN_KEYS.add(key)
                                    if isinstance(val, str):
                                        sample = val[:200]
                                    elif isinstance(val, (dict, list)):
                                        sample = dumps(val)
                                    else:
                                        sample = str(val)
                                    error_log(f"[Grok] Unrecognized delta key '{key}' (model={self.model}); sample value: " + str(sample)[:200])

                    content = delta.get('content') if delta.get('content') is not None else ''
                    if content != '':
                        fullText += content
                        if self.sseClient:
                            self.sseClient.sendChunk(content)

                    if delta.get('tool_calls') is not None:
                        for toolCallDelta in delta['tool_calls']:
                            index = toolCallDelta['index']

                            if toolCalls.get(index) is None:
                                toolCalls[index] = {
                                    'id': '',
                                    'type': 'function',
                                    'function': {
                                        'name': '',
                                        'arguments': '',
                                    },
                                }

                            if toolCallDelta.get('id') is not None:
                                toolCalls[index]['id'] = toolCallDelta['id']
                            deltaFunction = toolCallDelta.get('function') if isinstance(toolCallDelta.get('function'), dict) else {}
                            if deltaFunction.get('name') is not None:
                                toolCalls[index]['function']['name'] = deltaFunction['name']
                            if deltaFunction.get('arguments') is not None:
                                toolCalls[index]['function']['arguments'] += deltaFunction['arguments']

                    if jsonData.get('usage') is not None:
                        usageData = jsonData['usage']
                        self.emitContextWarningIfHigh(
                            usageData.get('prompt_tokens') if usageData.get('prompt_tokens') is not None else 0
                        )

            if done:
                break

        if self.logger:
            self.logger.logApiResponse('grok', 200, 0)

        toolCallNames = ",".join(
            (tc.get('function', {}).get('name') if tc.get('function', {}).get('name') is not None else '?')
            for tc in toolCalls.values()
        )
        error_log(
            f"\U0001F6D1 [GrokProvider:streaming] finish_reason={finishReason}, text_len={len(fullText)}, "
            f"tool_calls={len(toolCalls)}" + (f" [{toolCallNames}]" if len(toolCalls) > 0 else '')
            + f", chunks_received={chunkCount}, chunks_with_data={deltaWithDataCount}, model={self.model}"
        )

        message = {
            'role': 'assistant',
            'content': fullText,
        }

        if not php_empty(toolCalls):
            message['tool_calls'] = list(toolCalls.values())

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
        streaming: bool = False,
        executedTools: dict | None = None,
        toolChoice='auto',
    ) -> dict:
        """Handle tool calls recursively.

        `totals` replaces PHP's `&$inputTokens, &$outputTokens,
        &$functionCallCount, &$functionsCalled, &$mcpToolsCalled` reference
        parameters; `messages`/`executedTools` are mutated in place like
        PHP's `&$messages`/`&$executedTools`.
        """
        executedTools = {} if executedTools is None else executedTools

        if depth >= self.maxRecursionDepth:
            if self.logger:
                self.logger.warning("Max recursion depth reached", {'depth': depth})
            return response

        choice = _first_choice(response)
        assistantMessage = choice.get('message') if choice.get('message') is not None else {}
        toolCalls = assistantMessage.get('tool_calls') if assistantMessage.get('tool_calls') is not None else []

        if php_empty(toolCalls):
            return response

        # B3: surface solo client-side tool turns to the frontend.
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
            error_log("\U0001F527 [GrokProvider] Client-side tool call detected; surfacing to frontend: " + dumps([n['name'] for n in normalized]))

            marker = self.emitClientToolCallEvent(normalized, assistantText)

            for tc in clientCalls:
                totals.functionCallCount += 1
                function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                totals.functionsCalled.append(function.get('name') if function.get('name') is not None else '')

            return {**response, **marker}

        if not php_empty(clientCalls):
            error_log("⚠️ [GrokProvider] Mixed client/server tool calls in one turn — failing client-side calls.")

        messages.append(assistantMessage)
        workflowComplete = False  # Track if workflow completed (for manager agents)

        for toolCall in toolCalls:
            functionName = toolCall['function']['name']
            arguments = _json_decode(toolCall['function']['arguments'])
            arguments = arguments if arguments is not None else []

            # Mixed-turn fallback for client-side tools: if we got here it
            # means there were also server-side tool calls in this turn,
            # and the all-client-side branch above didn't fire. Tell the
            # model the client tool can't run alongside server ones and
            # let recursion continue.
            if self.isClientSideTool(functionName):
                messages.append({
                    'role': 'tool',
                    'tool_call_id': toolCall['id'],
                    'content': dumps({
                        'error': 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    }),
                })
                totals.functionCallCount += 1
                totals.functionsCalled.append(functionName)
                continue

            # Create a signature to detect duplicate/similar calls
            callSignature = functionName + ':' + hashlib.md5(dumps(arguments).encode('utf-8')).hexdigest()

            # Check if we've already called this exact function with these arguments
            duplicateCount = executedTools.get(callSignature, 0)
            if duplicateCount >= 2:
                if self.logger:
                    self.logger.warning("Skipping duplicate tool call", {'name': functionName, 'count': duplicateCount})
                messages.append({
                    'role': 'tool',
                    'tool_call_id': toolCall['id'],
                    'content': dumps({
                        'status': 'skipped',
                        'message': "This tool has already been called with the same arguments. The operation is in progress - please wait for completion instead of calling again.",
                    }),
                })
                continue

            executedTools[callSignature] = duplicateCount + 1
            totals.functionCallCount += 1

            # Track tool name and check if it's an MCP tool
            totals.functionsCalled.append(functionName)
            if self.functionExecutor and self.functionExecutor.isMCPTool(functionName):
                totals.mcpToolsCalled.append(functionName)

            self._sendProgress(f"Executing function: {functionName}")
            if self.logger:
                self.logger.debug("Executing tool", {'name': functionName, 'input': arguments})

            result = self._executeFunction(functionName, arguments, userId)

            # Check if result indicates async operation - add hint to not call again
            resultContent = result
            if isinstance(result, dict):
                structuredContent = result.get('structuredContent')
                if isinstance(structuredContent, dict) and structuredContent.get('status') is not None:
                    status = structuredContent['status']
                else:
                    status = result.get('status')
                if status in ('generating', 'in_progress', 'pending'):
                    result['_hint'] = 'This is an async operation. DO NOT call this tool again - the UI will automatically show progress and results.'
                # Check if workflow is complete (for manager agents calling complete_task)
                marker = result.get('marker') if result.get('marker') is not None else ''
                if marker == '___WORKFLOW_COMPLETE___':
                    workflowComplete = True
                    if self.logger:
                        self.logger.debug("Workflow complete detected - switching to auto for final response")
                resultContent = dumps(result)

            messages.append({
                'role': 'tool',
                'tool_call_id': toolCall['id'],
                'content': resultContent if isinstance(resultContent, str) else dumps(resultContent),
            })

        self._sendProgress("Processing response...")
        # Use original tool_choice to keep forcing tool use in multi-step workflows
        # BUT switch to 'auto' when workflow is complete so manager can respond to user
        continuationToolChoice = 'auto' if workflowComplete else toolChoice
        error_log(
            "[GrokProvider] Continuation: workflowComplete=" + ('YES' if workflowComplete else 'NO')
            + f", originalChoice={toolChoice}, continuationChoice={continuationToolChoice}"
        )
        continuationResponse = self._makeRequest(messages, tools, streaming, continuationToolChoice)

        continuationUsage = continuationResponse.get('usage') if continuationResponse.get('usage') is not None else {}
        totals.inputTokens += continuationUsage.get('prompt_tokens') if continuationUsage.get('prompt_tokens') is not None else 0
        totals.outputTokens += continuationUsage.get('completion_tokens') if continuationUsage.get('completion_tokens') is not None else 0

        if self._hasToolCalls(continuationResponse):
            return self._handleToolCallsRecursive(
                continuationResponse,
                messages,
                tools,
                userId,
                totals,
                depth + 1,
                streaming,
                executedTools,
                toolChoice,
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

            if isinstance(result, dict) and result.get('_mcp_ui') is not None and self.sseClient:
                self.sseClient.sendCustomEvent('mcp_ui', {
                    'tool_name': functionName,
                    'ui_info': result['_mcp_ui'],
                })

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

    def _buildMessages(self, conversationHistory: list, newMessage: str, systemPrompt: str, imageAttachments: list | None = None) -> list:
        imageAttachments = [] if imageAttachments is None else imageAttachments

        messages = [{'role': 'system', 'content': systemPrompt}]

        for msg in conversationHistory:
            role = msg.get('role') if msg.get('role') is not None else 'user'

            # B3: tool-result and assistant-with-tool_calls turns must
            # round-trip verbatim (OpenAI-shape native).
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
            textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
            if not php_empty(textContent):
                messages.append({
                    'role': role,
                    'content': textContent,
                })

        # B3 continuation: skip an empty user turn after a tool_result tail.
        isToolResultContinuation = (
            php_empty(newMessage.strip())
            and php_empty(imageAttachments)
            and not php_empty(messages)
            and (messages[len(messages) - 1].get('role') if messages[len(messages) - 1].get('role') is not None else '') == 'tool'
        )
        if isToolResultContinuation:
            return messages

        if not php_empty(imageAttachments):
            parts = [{'type': 'text', 'text': newMessage}]
            for img in imageAttachments:
                parts.append({
                    'type': 'image_url',
                    'image_url': {'url': 'data:' + img['mime_type'] + ';base64,' + img['data']},
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

    def _convertToXAITools(self, claudeTools: list) -> list:
        xaiTools = []

        for tool in claudeTools:
            parameters = _xai_tool_parameters(tool)

            # xAI uses OpenAI-compatible format with nested "function" object
            xaiTools.append({
                'type': 'function',
                'function': {
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'parameters': parameters,
                },
            })

        return xaiTools

    def _getTools(self) -> list:
        return self.functionExecutor.getToolDefinitions() if self.functionExecutor else []

    def getContextWindow(self) -> int:
        # grok-4-1-fast-reasoning: 2M context per xAI docs
        return 2000000

    def getDefaultSystemPrompt(self) -> str:
        """PHP declares this `private`, but ProviderRequestBuilderTrait's
        buildSystemPrompt() calls `$this->getDefaultSystemPrompt()` from
        inside the class scope. Python mixins have no such scoping, so the
        name stays public here — same deviation as the 2a ClaudeProvider port.
        """
        providerConfig = self.config.get('providers.grok', {})
        if not php_empty(providerConfig.get('system_prompt')):
            return providerConfig['system_prompt']

        promptFile = Path(__file__).resolve().parents[2] / 'resources' / 'prompts' / 'portfolio_assistant.txt'
        if promptFile.exists():
            return promptFile.read_text(encoding='utf-8')

        return 'You are a helpful AI assistant with access to tools and functions. Use them when appropriate to help the user.'

    def _sendProgress(self, message: str) -> None:
        if self.sseClient:
            self.sseClient.sendProgress(f"Grok: {message}")

    def _trackUsage(self, userId, inputTokens: int, outputTokens: int, functionCallCount: int, responseTimeMs: int) -> None:
        if self.usageTracker:
            self.usageTracker.trackRequest({
                'user_id': userId,
                'provider': 'grok',
                'model': self.model,
                'request_type': 'chat',
                'input_tokens': inputTokens,
                'output_tokens': outputTokens,
                'function_calls_count': functionCallCount,
                'response_time_ms': responseTimeMs,
                'status': 'success',
            })

    @staticmethod
    def _formatTemperature(temperature: float) -> float:
        """PHP: (float) number_format($temperature, 1, '.', '')."""
        return float(f"{temperature:.1f}")

    @staticmethod
    def buildHttpRequest(model: str, messages: list, tools: list, config: dict, maxTokens: int, temperature: float) -> dict:
        """Build an HTTP request for Grok/xAI API (static method for parallel
        execution). Uses OpenAI-compatible format with xAI's base URL.

        Returns a dict with keys: url, headers, payload, provider.
        """
        payload = {
            'model': model,
            'messages': messages,
            'temperature': GrokProvider._formatTemperature(temperature),
            'max_tokens': maxTokens,
        }

        # Add tools in OpenAI format with xAI-specific cleaning
        if not php_empty(tools):
            payload['tools'] = GrokProvider._convertToolsForXAI(tools)

        baseUrl = config['base_url'] if not php_empty(config.get('base_url')) else GrokProvider.BASE_URL
        endpoint = config['chat_endpoint'] if not php_empty(config.get('chat_endpoint')) else GrokProvider.CHAT_ENDPOINT

        return {
            'url': baseUrl.rstrip('/') + endpoint,
            'headers': [
                'Content-Type: application/json',
                'Authorization: Bearer ' + config['api_key'],
            ],
            'payload': payload,
            'provider': 'grok',
        }

    @staticmethod
    def _convertToolsForXAI(claudeTools: list) -> list:
        """Convert tools to xAI format with necessary schema cleaning
        (static twin of `_convertToXAITools`, for use from `buildHttpRequest`).
        """
        xaiTools = []

        for tool in claudeTools:
            parameters = _xai_tool_parameters(tool)

            xaiTools.append({
                'type': 'function',
                'function': {
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'parameters': parameters,
                },
            })

        return xaiTools

    @staticmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """Parse Grok/xAI API response (static method for parallel execution).

        Returns a dict with keys: text, tool_calls, usage.
        """
        choice = _first_choice(decoded)
        message = choice.get('message') if choice.get('message') is not None else {}

        return {
            'text': message.get('content') if message.get('content') is not None else '',
            'tool_calls': message.get('tool_calls') if message.get('tool_calls') is not None else [],
            'usage': GrokProvider.normalizeUsage(decoded.get('usage'), 'openai'),
        }

    @staticmethod
    def getApiFamily() -> str:
        """Get the API family for this provider."""
        return 'openai'
