"""Port of Providers/ClaudeProvider.php.

Claude AI Provider with native function calling support.

Line-for-line port; PHP method names are preserved (private PHP methods
become `_name`). PHP semantics are reproduced with the helpers in
app.support.phpcompat (`php_empty` for `empty()`, `x.get(k) if ... is not
None else d` for `??`, dict-or-list for `is_array()`).
"""
from __future__ import annotations

import codecs
import json
import time
import traceback
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
from app.support.phpcompat import php_bool, php_empty
from app.support.phpjson import dumps


def _gettype(v) -> str:
    """PHP gettype()."""
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'boolean'
    if isinstance(v, int):
        return 'integer'
    if isinstance(v, float):
        return 'double'
    if isinstance(v, str):
        return 'string'
    if isinstance(v, (list, dict)):
        return 'array'
    return 'object'


def _json_decode(s):
    """PHP json_decode($s, true): returns None on malformed input."""
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


class ClaudeProvider(
    ProviderRequestBuilderMixin,
    ClientSideToolsMixin,
    AIProviderInterface,
    HttpRequestBuilderInterface,
):
    """Claude AI Provider with native function calling support."""

    # Supported Claude models
    SUPPORTED_MODELS = [
        'claude-sonnet-4-5-20250929',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
    ]

    def __init__(self, config: Configuration):
        self.config = config

        self.functionExecutor: FunctionExecutorInterface | None = None
        self.usageTracker: UsageTrackerInterface | None = None
        self.sseClient: StreamingClientInterface | None = None
        self.logger: DebugLogger | None = None

        # Output schema for constrained decoding via the forced-tool pattern.
        # When set, a synthetic tool with this schema is appended; the tool's
        # `input` carries the structured output and is extracted as JSON text.
        self.pendingOutputSchema: dict | None = None
        self.pendingSchemaToolName: str | None = None

        claudeConfig = config.getClaude()
        self.model = claudeConfig.get('model') if claudeConfig.get('model') is not None else 'claude-sonnet-4-5-20250929'
        self.maxTokens = claudeConfig.get('max_tokens') if claudeConfig.get('max_tokens') is not None else 4000
        self.temperature = claudeConfig.get('temperature') if claudeConfig.get('temperature') is not None else 0.7
        baseUrl = claudeConfig.get('base_url') if claudeConfig.get('base_url') is not None else 'https://api.anthropic.com'
        self.baseUrl = baseUrl.rstrip('/')
        self.apiVersion = claudeConfig.get('api_version') if claudeConfig.get('api_version') is not None else '2023-06-01'
        self.streamingEnabled = claudeConfig.get('streaming') if claudeConfig.get('streaming') is not None else True
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

    def setFunctionExecutor(self, executor: FunctionExecutorInterface) -> 'ClaudeProvider':
        """Set the function executor for tool calling."""
        self.functionExecutor = executor
        return self

    def setUsageTracker(self, tracker: UsageTrackerInterface) -> 'ClaudeProvider':
        """Set the usage tracker."""
        self.usageTracker = tracker
        return self

    def setSSEClient(self, client: StreamingClientInterface) -> 'ClaudeProvider':
        """Set the SSE client for streaming."""
        self.sseClient = client
        return self

    def setLogger(self, logger: DebugLogger) -> 'ClaudeProvider':
        """Set the logger."""
        self.logger = logger
        return self

    def getName(self) -> str:
        """Get provider name."""
        return 'claude'

    def isAvailable(self) -> bool:
        """Check if provider is available."""
        return self.config.isProviderConfigured('claude')

    def getModel(self) -> str:
        """Get current model."""
        return self.model

    def setModel(self, model: str) -> 'ClaudeProvider':
        """Set the model."""
        self.model = model
        return self

    def getSupportedModels(self) -> list:
        """Get supported models."""
        return list(self.SUPPORTED_MODELS)  # PHP returns a value copy

    def chat(self, message: str, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        """Send a chat message and get a response."""
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        startTime = time.time()

        self._sendProgress("Preparing Claude request...")

        systemPrompt = self.buildSystemPrompt(options)
        tools = options.get('tools') if options.get('tools') is not None else self._getTools()
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')
        toolChoice = options.get('tool_choice') if options.get('tool_choice') is not None else 'auto'

        # Constrained decoding: inject schema as a forced tool
        tools, toolChoice, systemPrompt = self._applyOutputSchemaToTools(
            options.get('output_schema'),
            tools,
            toolChoice,
            systemPrompt,
        )

        # Per-request webMCP tool short-circuit. Names supplied by the
        # frontend (e.g. webmcp_get_machine_specifications) must be recognized
        # by the dispatch loop so it emits client_tool_call instead of executing.
        if not php_empty(options.get('client_tool_names')) and isinstance(options.get('client_tool_names'), (dict, list)):
            self.setPerRequestClientSideToolNames(options['client_tool_names'])

        # Append per-request client_tools (e.g. webMCP tools from the active tab).
        # Claude's shape is {name, description, input_schema} — matches our
        # sanitized input shape directly.
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

        # Build messages array
        messages = self._buildMessages(
            conversationHistory,
            message,
            options.get('image_attachments') if options.get('image_attachments') is not None else [],
            options.get('pdf_attachments') if options.get('pdf_attachments') is not None else [],
        )

        # Make initial request
        response = self._makeRequest(messages, systemPrompt, tools, toolChoice)

        # Track tokens and tool calls
        usage = response.get('usage') if response.get('usage') is not None else {}
        totals = _Totals(
            inputTokens=usage.get('input_tokens') if usage.get('input_tokens') is not None else 0,
            outputTokens=usage.get('output_tokens') if usage.get('output_tokens') is not None else 0,
        )

        # Handle tool use recursively
        if self._hasToolUse(response):
            self._sendProgress("Processing tool calls...")

            response = self._handleToolUseRecursive(
                response,
                messages,
                systemPrompt,
                tools,
                userId,
                totals,
            )

        # B3 short-circuit: the recursion bailed out because the LLM
        # called a client-side tool (e.g. run_skill_script). Surface the
        # marker so callers (workflow runner) can round-trip through the
        # browser. The 'client_tool_call' SSE event was already emitted
        # from inside handleToolUseRecursive when sseClient is set;
        # workflow runner emits its own from runAgentWithClientToolBridge
        # using this marker, so the frontend gets it either way.
        # Mirrors the same handling in streamChat().
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
                'provider': 'claude',
                'functions_called': totals.functionsCalled,
                'mcp_tools_called': totals.mcpToolsCalled,
                'mcp_calls_count': len(totals.mcpToolsCalled),
                'pending_client_tool_call': True,
                'pending_tool_calls': response.get('_pending_tool_calls') if response.get('_pending_tool_calls') is not None else [],
                # Truncation signal for the workflow runner (see handleToolUseRecursive).
                'stop_reason': response.get('stop_reason'),
            }

        # Extract final text response
        textResponse = self._extractTextResponse(response)

        responseTimeMs = int((time.time() - startTime) * 1000)

        # Track usage
        self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)

        self._sendProgress("Response ready.")

        # Debug log final tool arrays
        error_log("📊 [ClaudeProvider::chat] Final tool stats - functions_called: " + dumps(totals.functionsCalled) + ", mcp_tools_called: " + dumps(totals.mcpToolsCalled))

        # Clear pending schema state
        self.pendingOutputSchema = None
        self.pendingSchemaToolName = None

        return {
            'text': textResponse,
            'usage': {
                'input_tokens': totals.inputTokens,
                'output_tokens': totals.outputTokens,
                'total_tokens': totals.inputTokens + totals.outputTokens,
                'function_calls': totals.functionCallCount,
            },
            'model': self.model,
            'provider': 'claude',
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    def _applyOutputSchemaToTools(self, outputSchema, tools: list, toolChoice, systemPrompt: str):
        """Inject a synthetic schema tool to force structured output.

        If no other tools exist, the schema tool is forced via tool_choice.
        Otherwise, tool_choice stays 'auto' and an instruction is appended
        to the system prompt telling the model to call the schema tool last.

        Returns [tools, toolChoice, systemPrompt] (modified copies).
        """
        if php_empty(outputSchema) or not isinstance(outputSchema, (dict, list)):
            return tools, toolChoice, systemPrompt

        tools = list(tools)

        name = outputSchema.get('name') if outputSchema.get('name') is not None else 'output'
        description = outputSchema.get('description') if outputSchema.get('description') is not None else 'Return the final answer in this structured format.'
        schema = outputSchema.get('schema') if outputSchema.get('schema') is not None else {'type': 'object', 'properties': {}}

        self.pendingOutputSchema = outputSchema
        self.pendingSchemaToolName = name

        schemaTool = {
            'name': name,
            'description': description,
            'input_schema': schema,
        }

        hasOtherTools = not php_empty(tools)
        tools.append(schemaTool)

        if not hasOtherTools:
            # Force the schema tool — model has nothing else to call
            toolChoice = f"tool:{name}"
        else:
            # Mixed mode: instruct model to use the schema tool as its final action
            systemPrompt += (
                "\n\n## Output format\n"
                f"When you have your final answer, you MUST call the `{name}` tool "
                "with your output formatted according to its schema. "
                "Do not respond with plain text — your final action must be calling this tool."
            )

        return tools, toolChoice, systemPrompt

    def streamChat(self, message: str, onChunk, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        """Send a chat message with streaming response."""
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        # Check if streaming is enabled and SSE client is available
        if not self.streamingEnabled or not self.sseClient:
            # Fallback to non-streaming
            result = self.chat(message, conversationHistory, options)
            onChunk(result['text'])
            return result

        startTime = time.time()

        self._sendProgress("Preparing Claude streaming request...")

        systemPrompt = self.buildSystemPrompt(options)
        tools = options.get('tools') if options.get('tools') is not None else self._getTools()
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')
        toolChoice = options.get('tool_choice') if options.get('tool_choice') is not None else 'auto'

        # Per-request webMCP tool short-circuit. Names supplied by the
        # frontend (e.g. webmcp_get_machine_specifications) must be recognized
        # by the dispatch loop so it emits client_tool_call instead of executing.
        if not php_empty(options.get('client_tool_names')) and isinstance(options.get('client_tool_names'), (dict, list)):
            self.setPerRequestClientSideToolNames(options['client_tool_names'])

        # Append per-request client_tools (e.g. webMCP tools from the active tab).
        # Claude's shape is {name, description, input_schema} — matches our
        # sanitized input shape directly.
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

        # Build messages array
        messages = self._buildMessages(
            conversationHistory,
            message,
            options.get('image_attachments') if options.get('image_attachments') is not None else [],
            options.get('pdf_attachments') if options.get('pdf_attachments') is not None else [],
        )

        # Make streaming request
        response = self._makeStreamingRequest(messages, systemPrompt, tools, toolChoice)

        # Track tokens and tool calls
        usage = response.get('usage') if response.get('usage') is not None else {}
        totals = _Totals(
            inputTokens=usage.get('input_tokens') if usage.get('input_tokens') is not None else 0,
            outputTokens=usage.get('output_tokens') if usage.get('output_tokens') is not None else 0,
        )

        # Handle tool use recursively (non-streaming for tool calls)
        if self._hasToolUse(response):
            error_log("🔧 Tool use detected, starting recursive handling")
            self._sendProgress("Processing tool calls...")

            try:
                response = self._handleToolUseRecursive(
                    response,
                    messages,
                    systemPrompt,
                    tools,
                    userId,
                    totals,
                )
                error_log("✅ Tool use handling completed successfully")
            except Exception as e:
                error_log("❌ ERROR in handleToolUseRecursive: " + str(e))
                error_log("Stack trace: " + ''.join(traceback.format_exception(e)))
                raise

        # B3 short-circuit: if the recursion bailed out because the LLM
        # called a client-side tool, return the assistant's pre-tool text
        # (often empty) and a flag the controller can forward to the
        # frontend. The 'client_tool_call' SSE event has already been
        # emitted from inside handleToolUseRecursive.
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
                'provider': 'claude',
                'functions_called': totals.functionsCalled,
                'mcp_tools_called': totals.mcpToolsCalled,
                'mcp_calls_count': len(totals.mcpToolsCalled),
                'pending_client_tool_call': True,
                'pending_tool_calls': response.get('_pending_tool_calls') if response.get('_pending_tool_calls') is not None else [],
                # Truncation signal for the workflow runner (see handleToolUseRecursive).
                'stop_reason': response.get('stop_reason'),
            }

        # Extract final text response
        textResponse = self._extractTextResponse(response)

        # Stream the final response text (this is the complete accumulated text after all tool calls)
        # During streaming, we stream each continuation response, but we need to ensure
        # the final complete text is available
        error_log("📊 Final response length: " + str(len(textResponse)))

        responseTimeMs = int((time.time() - startTime) * 1000)

        # Track usage
        self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)

        self._sendProgress("Response ready.")

        # Debug log final tool arrays
        error_log("📊 [ClaudeProvider::streamChat] Final tool stats - functions_called: " + dumps(totals.functionsCalled) + ", mcp_tools_called: " + dumps(totals.mcpToolsCalled))

        return {
            'text': textResponse,
            'usage': {
                'input_tokens': totals.inputTokens,
                'output_tokens': totals.outputTokens,
                'total_tokens': totals.inputTokens + totals.outputTokens,
                'function_calls': totals.functionCallCount,
            },
            'model': self.model,
            'provider': 'claude',
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    @staticmethod
    def _buildCachedSystemBlocks(systemPrompt: str) -> list:
        """Wrap a system prompt string in the Anthropic content-blocks format
        with an ephemeral cache_control marker.

        Anthropic prompt caching requires the system field to be an array of
        content blocks, with cache_control set on the block where the cache
        boundary should land. The API silently skips caching for prompts
        below the per-model minimum (1024 tokens for Sonnet/Opus, 2048 for
        Haiku), so this format is safe to emit unconditionally.

        @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
        """
        return [
            {
                'type': 'text',
                'text': systemPrompt,
                'cache_control': {'type': 'ephemeral'},
            },
        ]

    def _makeRequest(self, messages: list, systemPrompt: str, tools: list | None = None, toolChoice='auto') -> dict:
        """Make a request to Claude API."""
        tools = [] if tools is None else tools

        self._sendProgress("Connecting to Claude API...")

        apiKey = self.config.get('claude.api_key')
        if php_empty(apiKey):
            raise ProviderException.authenticationFailed('claude')

        payload = {
            'model': self.model,
            'max_tokens': self.maxTokens,
            'temperature': self.temperature,
            'system': self._buildCachedSystemBlocks(systemPrompt),
            'messages': messages,
        }

        if not php_empty(tools):
            payload['tools'] = tools
            # Claude uses 'any' to force tool usage, 'auto' for optional.
            # We accept several incoming shapes (string convention,
            # OpenAI object form, or already-Claude form) and normalize.
            if isinstance(toolChoice, (dict, list)):
                # OpenAI object form: { type: 'function', function: { name } }
                function = toolChoice.get('function') if isinstance(toolChoice, dict) else None
                if (toolChoice.get('type') if isinstance(toolChoice, dict) and toolChoice.get('type') is not None else '') == 'function' \
                        and isinstance(function, dict) and not php_empty(function.get('name')):
                    payload['tool_choice'] = {
                        'type': 'tool',
                        'name': function['name'],
                    }
                else:
                    # Already in Claude's shape — pass through.
                    payload['tool_choice'] = toolChoice
            elif toolChoice == 'required':
                payload['tool_choice'] = {'type': 'any'}
            elif isinstance(toolChoice, str) and toolChoice.startswith('tool:'):
                # Force a specific tool (used for structured output schema tool)
                payload['tool_choice'] = {
                    'type': 'tool',
                    'name': toolChoice[5:],
                }
            elif toolChoice != 'auto':
                payload['tool_choice'] = {'type': toolChoice}

        if self.logger:
            self.logger.logApiRequest('claude', '/v1/messages', payload)

        try:
            # Convert empty arrays to objects for proper JSON encoding
            payload = self._convertEmptyArraysToObjects(payload)

            # Validate JSON encoding before sending to catch encoding issues early
            try:
                jsonPayload = dumps(payload)
            except (TypeError, ValueError) as encodeError:
                jsonError = str(encodeError)
                error_log(f"❌ [ClaudeProvider] JSON encoding failed: {jsonError}")
                error_log("❌ [ClaudeProvider] Payload structure: " + repr(list(payload.keys())))
                # Try to identify problematic content in messages
                if payload.get('messages') is not None:
                    for idx, msg in enumerate(payload['messages']):
                        try:
                            dumps(msg)
                        except (TypeError, ValueError) as msgError:
                            error_log(f"❌ [ClaudeProvider] Problem in message[{idx}]: " + str(msgError))
                            error_log("❌ [ClaudeProvider] Message role: " + str(msg.get('role') if msg.get('role') is not None else 'unknown'))
                raise Exception(f"Failed to encode request payload: {jsonError}")

            error_log("📤 [ClaudeProvider] Sending request with body length: " + str(len(jsonPayload.encode('utf-8'))))

            # Use body instead of json to ensure we control the exact payload
            response = self.httpClient.post('/v1/messages', headers={
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': self.apiVersion,
            }, content=jsonPayload.encode('utf-8'))
            response.raise_for_status()

            # DIAGNOSTIC: capture the LLM response *exactly as received*
            # before any of our processing touches it. Reads the wire
            # bytes, then logs both the raw body and the parsed shape so
            # we can see what Claude actually emits vs what our pipeline
            # does with it. Useful for diagnosing JSON-wrap / over-escape
            # bugs in tool_use input where the model puts unexpected
            # shapes into input_files.
            rawBody = response.text
            body = _json_decode(rawBody)
            error_log("📥 [ClaudeProvider RAW RESPONSE] " + str(len(response.content)) + " bytes received from Anthropic API")
            error_log("📥 [ClaudeProvider RAW BODY] " + rawBody)
            if isinstance(body, dict) and isinstance(body.get('content'), (dict, list)):
                for i, block in enumerate(body['content']):
                    blockType = block.get('type') if block.get('type') is not None else '?'
                    if blockType == 'tool_use':
                        name = block.get('name') if block.get('name') is not None else '?'
                        inputJson = dumps(block['input']) if block.get('input') is not None else '(no input)'
                        inputLen = len(str(inputJson).encode('utf-8'))
                        error_log(f"📥 [ClaudeProvider RAW TOOL_USE #{i}] name={name}, input bytes={inputLen}")
                        # Per-key sample so we can see input_files values verbatim
                        blockInput = block.get('input')
                        if isinstance(blockInput, (dict, list)):
                            items = enumerate(blockInput) if isinstance(blockInput, list) else blockInput.items()
                            for k, v in items:
                                if isinstance(v, str):
                                    head = v[0:200]
                                    tail = v[-100:] if len(v) > 200 else ''
                                    error_log(f"📥 [ClaudeProvider RAW TOOL_USE #{i}.{k}] string({len(v)}) head=" + dumps(head) + (" tail=" + dumps(tail) if tail != '' else ''))
                                elif isinstance(v, (dict, list)):
                                    error_log(f"📥 [ClaudeProvider RAW TOOL_USE #{i}.{k}] array, json=" + dumps(v))
                                else:
                                    error_log(f"📥 [ClaudeProvider RAW TOOL_USE #{i}.{k}] " + _gettype(v) + "=" + dumps(v))
                            # DECISIVE VERDICT: one grep-able line stating the
                            # SHAPE + validity of input_files — the exact failure
                            # mode. Claude often emits input_files as a JSON
                            # STRING instead of an object; if that string is also
                            # truncated it won't json_decode, so the script's -i
                            # input never gets staged ("input file not found").
                            # grep:  INPUT_FILES VERDICT
                            ifv = blockInput.get('input_files') if isinstance(blockInput, dict) else None
                            if ifv is not None:
                                if isinstance(ifv, str):
                                    valid = _json_decode(ifv) is not None
                                    error_log(f"📥 [ClaudeProvider INPUT_FILES VERDICT #{i}] shape=STRING len=" + str(len(ifv.encode('utf-8')))
                                              + " json_valid=" + ('true (parseable → frontend will stage it)' if valid else 'FALSE → TRUNCATED/MALFORMED, will NOT stage'))
                                elif isinstance(ifv, (dict, list)):
                                    keys = list(range(len(ifv))) if isinstance(ifv, list) else list(ifv.keys())
                                    error_log(f"📥 [ClaudeProvider INPUT_FILES VERDICT #{i}] shape=OBJECT keys=" + dumps(keys) + " (correct shape)")
                                else:
                                    error_log(f"📥 [ClaudeProvider INPUT_FILES VERDICT #{i}] shape=" + _gettype(ifv) + " (unexpected)")
                    elif blockType == 'text':
                        text = block.get('text') if block.get('text') is not None else ''
                        error_log(f"📥 [ClaudeProvider RAW TEXT #{i}] " + str(len(text)) + " chars: " + dumps(text[0:300]))
                    else:
                        error_log(f"📥 [ClaudeProvider RAW BLOCK #{i}] type={blockType}, json=" + dumps(block))

            if self.logger:
                self.logger.logApiResponse('claude', 200, 0)

            return body
        except httpx.HTTPStatusError as e:
            statusCode = e.response.status_code

            if statusCode == 429:
                raise ProviderException.rateLimited('claude')

            if statusCode == 401:
                raise ProviderException.authenticationFailed('claude')

            raise ProviderException.apiError('claude', str(e), statusCode)
        except httpx.RequestError as e:
            # Guzzle's ConnectException is a GuzzleException too; it carries no
            # HTTP status, so PHP's $e->getCode() would be 0.
            raise ProviderException.apiError('claude', str(e), 0)

    def _makeStreamingRequest(self, messages: list, systemPrompt: str, tools: list | None = None, toolChoice='auto') -> dict:
        """Make a streaming request to Claude API."""
        tools = [] if tools is None else tools

        error_log("🚀 [ClaudeProvider:streaming] makeStreamingRequest called with " + str(len(messages)) + " messages")

        self._sendProgress("Connecting to Claude API (streaming)...")

        apiKey = self.config.get('claude.api_key')
        if php_empty(apiKey):
            raise ProviderException.authenticationFailed('claude')

        # Log message roles for debugging
        for idx, msg in enumerate(messages):
            contentType = f"array({len(msg['content'])})" if isinstance(msg.get('content'), (dict, list)) else 'string'
            error_log(f"🚀 [ClaudeProvider:streaming] Message[{idx}]: role=" + str(msg.get('role') if msg.get('role') is not None else 'unknown') + f", content={contentType}")

        payload = {
            'model': self.model,
            'max_tokens': self.maxTokens,
            'temperature': self.temperature,
            'system': self._buildCachedSystemBlocks(systemPrompt),
            'messages': messages,
            'stream': True,  # Enable streaming
        }

        if not php_empty(tools):
            payload['tools'] = tools
            # Same normalization as the non-streaming path: accept the
            # OpenAI object form ({type:'function', function:{name}}) and
            # translate to Claude's {type:'tool', name}.
            if isinstance(toolChoice, (dict, list)):
                function = toolChoice.get('function') if isinstance(toolChoice, dict) else None
                if (toolChoice.get('type') if isinstance(toolChoice, dict) and toolChoice.get('type') is not None else '') == 'function' \
                        and isinstance(function, dict) and not php_empty(function.get('name')):
                    payload['tool_choice'] = {
                        'type': 'tool',
                        'name': function['name'],
                    }
                else:
                    payload['tool_choice'] = toolChoice
            elif toolChoice == 'required':
                payload['tool_choice'] = {'type': 'any'}
            elif isinstance(toolChoice, str) and toolChoice != 'auto':
                payload['tool_choice'] = {'type': toolChoice}

        if self.logger:
            self.logger.logApiRequest('claude', '/v1/messages (streaming)', payload)

        try:
            # Convert empty arrays to objects for proper JSON encoding
            payload = self._convertEmptyArraysToObjects(payload)

            # Validate JSON encoding before sending to catch encoding issues early
            try:
                jsonPayload = dumps(payload)
            except (TypeError, ValueError) as encodeError:
                jsonError = str(encodeError)
                error_log(f"❌ [ClaudeProvider:streaming] JSON encoding failed: {jsonError}")
                error_log("❌ [ClaudeProvider:streaming] Payload structure: " + repr(list(payload.keys())))
                # Try to identify problematic content in messages
                if payload.get('messages') is not None:
                    for idx, msg in enumerate(payload['messages']):
                        try:
                            dumps(msg)
                        except (TypeError, ValueError) as msgError:
                            error_log(f"❌ [ClaudeProvider:streaming] Problem in message[{idx}]: " + str(msgError))
                            error_log("❌ [ClaudeProvider:streaming] Message role: " + str(msg.get('role') if msg.get('role') is not None else 'unknown'))
                            # Check content blocks
                            if isinstance(msg.get('content'), (dict, list)):
                                for cIdx, content in enumerate(msg['content']):
                                    try:
                                        dumps(content)
                                    except (TypeError, ValueError) as contentError:
                                        error_log(f"❌ [ClaudeProvider:streaming] Problem in message[{idx}].content[{cIdx}]: " + str(contentError))
                raise Exception(f"Failed to encode request payload: {jsonError}")

            error_log("📤 [ClaudeProvider:streaming] Sending request with body length: " + str(len(jsonPayload.encode('utf-8'))))

            # Make streaming request - use body instead of json to ensure exact payload
            with self.httpClient.stream('POST', '/v1/messages', headers={
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': self.apiVersion,
            }, content=jsonPayload.encode('utf-8')) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as statusError:
                    # The body of a streaming response isn't read yet; read it
                    # so the handler below can quote it (Guzzle hands us the
                    # full error body on the exception).
                    statusError.response.read()
                    raise

                buffer = ''
                fullText = ''
                contentBlocks = []
                usage = {'input_tokens': 0, 'output_tokens': 0}
                hasToolUse = False
                currentBlockIndex = -1
                inputJsonBuffer = ''
                stopReason = None
                decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

                # Read stream line by line
                for chunkBytes in response.iter_bytes(1024):
                    buffer += decoder.decode(chunkBytes)

                    # Process complete SSE events (delimited by \n\n)
                    while True:
                        pos = buffer.find("\n\n")
                        if pos == -1:
                            break
                        eventBlock = buffer[0:pos]
                        buffer = buffer[pos + 2:]

                        if php_empty(eventBlock.strip()):
                            continue

                        # Parse SSE event
                        parsedEvent = self._parseClaudeStreamEvent(eventBlock)

                        if parsedEvent:
                            # DEBUG: Log what events we're receiving
                            if parsedEvent['event'] != 'ping' and parsedEvent['event'] != 'message_start':
                                error_log("🎯 Received SSE event: " + parsedEvent['event'])

                            # Handle different event types
                            if parsedEvent['event'] == 'content_block_delta' and parsedEvent['data'].get('delta') is not None:
                                delta = parsedEvent['data']['delta']

                                if delta['type'] == 'text_delta' and delta.get('text') is not None:
                                    textDelta = delta['text']
                                    fullText += textDelta

                                    error_log("📝 Text delta received (len=" + str(len(textDelta.encode('utf-8'))) + "): " + textDelta[0:50])

                                    # Send chunk to client
                                    if self.sseClient:
                                        self.sseClient.sendChunk(textDelta)
                                elif delta['type'] == 'input_json_delta' and delta.get('partial_json') is not None:
                                    # Accumulate tool input JSON
                                    inputJsonBuffer += delta['partial_json']
                            elif parsedEvent['event'] == 'content_block_start' and parsedEvent['data'].get('content_block') is not None:
                                contentBlock = parsedEvent['data']['content_block']
                                contentBlocks.append(contentBlock)
                                currentBlockIndex = len(contentBlocks) - 1
                                inputJsonBuffer = ''

                                # Check if this is a tool use
                                if contentBlock['type'] == 'tool_use':
                                    hasToolUse = True
                            elif parsedEvent['event'] == 'content_block_stop':
                                # Parse accumulated input JSON and add to current block
                                if currentBlockIndex >= 0 and not php_empty(inputJsonBuffer):
                                    inputData = _json_decode(inputJsonBuffer)
                                    if inputData is not None:
                                        contentBlocks[currentBlockIndex]['input'] = inputData
                                    inputJsonBuffer = ''
                                currentBlockIndex = -1
                            elif parsedEvent['event'] == 'message_delta':
                                if parsedEvent['data'].get('usage') is not None:
                                    deltaUsage = parsedEvent['data']['usage']
                                    usage['output_tokens'] += deltaUsage.get('output_tokens') if deltaUsage.get('output_tokens') is not None else 0
                                deltaBlock = parsedEvent['data'].get('delta')
                                if isinstance(deltaBlock, dict) and deltaBlock.get('stop_reason') is not None:
                                    stopReason = deltaBlock['stop_reason']
                                    stopSequence = deltaBlock.get('stop_sequence')
                                    error_log(f"🛑 [ClaudeProvider:streaming] stop_reason={stopReason}"
                                              + (", stop_sequence=" + dumps(stopSequence) if stopSequence is not None else "")
                                              + ", output_tokens=" + str(usage.get('output_tokens') if usage.get('output_tokens') is not None else 0)
                                              + ", text_len=" + str(len(fullText.encode('utf-8'))))
                                    self.emitUsageWarningIfTruncated(stopReason, usage.get('output_tokens') if usage.get('output_tokens') is not None else 0)
                            elif parsedEvent['event'] == 'message_start' and isinstance(parsedEvent['data'].get('message'), dict) and parsedEvent['data']['message'].get('usage') is not None:
                                # Initial usage (input tokens)
                                messageUsage = parsedEvent['data']['message']['usage']
                                usage['input_tokens'] = messageUsage.get('input_tokens') if messageUsage.get('input_tokens') is not None else 0
                                self.emitContextWarningIfHigh(usage['input_tokens'])
                            elif parsedEvent['event'] == 'error':
                                # Handle error event
                                errorData = parsedEvent.get('data') if parsedEvent.get('data') is not None else {}
                                errorMessage = errorData.get('message') if isinstance(errorData, dict) and errorData.get('message') is not None else 'Unknown error from Claude API'
                                error_log("❌ Claude API streaming error: " + dumps(errorData))
                                raise Exception("Claude API error: " + errorMessage)

                buffer += decoder.decode(b'', True)

                # Process any remaining data in the buffer (last event might not have \n\n)
                if not php_empty(buffer.strip()):
                    parsedEvent = self._parseClaudeStreamEvent(buffer)

                    if parsedEvent:
                        if parsedEvent['event'] == 'content_block_delta' and parsedEvent['data'].get('delta') is not None:
                            delta = parsedEvent['data']['delta']

                            if delta['type'] == 'text_delta' and delta.get('text') is not None:
                                textDelta = delta['text']
                                fullText += textDelta
                                if self.sseClient:
                                    self.sseClient.sendChunk(textDelta)
                        elif parsedEvent['event'] == 'message_delta':
                            if parsedEvent['data'].get('usage') is not None:
                                deltaUsage = parsedEvent['data']['usage']
                                usage['output_tokens'] += deltaUsage.get('output_tokens') if deltaUsage.get('output_tokens') is not None else 0
                            deltaBlock = parsedEvent['data'].get('delta')
                            if isinstance(deltaBlock, dict) and deltaBlock.get('stop_reason') is not None:
                                stopReason = deltaBlock['stop_reason']
                                stopSequence = deltaBlock.get('stop_sequence')
                                error_log(f"🛑 [ClaudeProvider:streaming:tail] stop_reason={stopReason}"
                                          + (", stop_sequence=" + dumps(stopSequence) if stopSequence is not None else "")
                                          + ", output_tokens=" + str(usage.get('output_tokens') if usage.get('output_tokens') is not None else 0)
                                          + ", text_len=" + str(len(fullText.encode('utf-8'))))
                                self.emitUsageWarningIfTruncated(stopReason, usage.get('output_tokens') if usage.get('output_tokens') is not None else 0)
                        elif parsedEvent['event'] == 'message_start' and isinstance(parsedEvent['data'].get('message'), dict) and parsedEvent['data']['message'].get('usage') is not None:
                            messageUsage = parsedEvent['data']['message']['usage']
                            usage['input_tokens'] = messageUsage.get('input_tokens') if messageUsage.get('input_tokens') is not None else 0
                            self.emitContextWarningIfHigh(usage['input_tokens'])

                if self.logger:
                    self.logger.logApiResponse('claude', 200, 0)

                # Build response structure similar to non-streaming
                response = {
                    'content': contentBlocks if hasToolUse else [{'type': 'text', 'text': fullText}],
                    'usage': usage,
                }

                return response

        except httpx.HTTPStatusError as e:
            statusCode = e.response.status_code

            # Try to get more details from the response body
            errorDetails = str(e)
            responseBody = e.response.text
            error_log("❌ [ClaudeProvider] API Error Response: " + responseBody)
            errorDetails += " | Response: " + responseBody

            if statusCode == 429:
                raise ProviderException.rateLimited('claude')

            if statusCode == 401:
                raise ProviderException.authenticationFailed('claude')

            raise ProviderException.apiError('claude', errorDetails, statusCode)
        except httpx.RequestError as e:
            raise ProviderException.apiError('claude', str(e), 0)

    def _handleToolUseRecursive(
        self,
        response: dict,
        messages: list,
        systemPrompt: str,
        tools: list,
        userId,
        totals: _Totals,
        depth: int = 0,
    ) -> dict:
        """Handle tool use recursively.

        `totals` replaces PHP's `&$inputTokens, &$outputTokens,
        &$functionCallCount, &$functionsCalled, &$mcpToolsCalled` reference
        parameters; `messages` is mutated in place like PHP's `&$messages`.
        """
        if depth >= self.maxRecursionDepth:
            if self.logger:
                self.logger.warning("Max recursion depth reached", {'depth': depth})
            return response

        toolResults = []
        assistantContent = response.get('content') if response.get('content') is not None else []

        # B3: detect client-side tools (executed in the browser via
        # window.pyodideRunner). If the assistant turn invoked any of
        # them, surface the tool_use to the frontend and bail out — the
        # frontend will run the script and re-POST /chat with the
        # tool_result prepended. We deliberately restrict this to the
        # case where ALL tool_uses in the turn are client-side; mixing
        # server-side and client-side tools in one turn would require
        # partial server execution + partial surface, which we punt on.
        clientToolBlocks = []
        serverToolBlocks = []
        for block in assistantContent:
            if (block.get('type') if block.get('type') is not None else '') != 'tool_use':
                continue
            if self.isClientSideTool(block.get('name') if block.get('name') is not None else ''):
                clientToolBlocks.append(block)
            else:
                serverToolBlocks.append(block)

        if not php_empty(clientToolBlocks) and php_empty(serverToolBlocks):
            assistantText = ''
            for b in assistantContent:
                if (b.get('type') if b.get('type') is not None else '') == 'text':
                    assistantText += b.get('text') if b.get('text') is not None else ''

            toolCalls = []
            for b in clientToolBlocks:
                blockInput = b.get('input') if b.get('input') is not None else []
                toolCalls.append({
                    'id': b['id'],
                    'name': b['name'],
                    'input': blockInput,
                })

            error_log("🔧 [ClaudeProvider] Client-side tool call detected; surfacing to frontend: " + dumps([tc['name'] for tc in toolCalls]))

            marker = self.emitClientToolCallEvent(toolCalls, assistantText)

            # Track for usage logging so the LLM call still appears as
            # having invoked these tools.
            for b in clientToolBlocks:
                totals.functionCallCount += 1
                totals.functionsCalled.append(b['name'])

            return {
                'content': assistantContent,
                'usage': response.get('usage') if response.get('usage') is not None else [],
                # Surface the API stop_reason so the workflow runner can detect
                # a TRUNCATED tool payload: stop_reason='max_tokens' means the
                # model hit its output cap mid-tool_use, so a large argument
                # (e.g. input_files HTML) is cut off and won't parse.
                'stop_reason': response.get('stop_reason'),
                **marker,
            }

        if not php_empty(clientToolBlocks) and not php_empty(serverToolBlocks):
            # Mixed-tool turn — fail closed for the client-side ones so
            # the existing recursion can still resolve the server-side
            # tools and produce a coherent answer. Revisit if real flows
            # need this; currently medium-format and friends won't hit it.
            error_log("⚠️ [ClaudeProvider] Mixed client/server tool_use in one turn — failing client-side calls.")
            for b in clientToolBlocks:
                toolResults.append({
                    'type': 'tool_result',
                    'tool_use_id': b['id'],
                    'content': dumps({
                        'error': 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                    }),
                    'is_error': True,
                })
                totals.functionCallCount += 1
                totals.functionsCalled.append(b['name'])

        for block in assistantContent:
            # Skip client-side tool_uses we already handled (mixed-turn
            # fallback above).
            if (block.get('type') if block.get('type') is not None else '') == 'tool_use' \
                    and self.isClientSideTool(block.get('name') if block.get('name') is not None else ''):
                continue
            if block['type'] == 'tool_use':
                totals.functionCallCount += 1
                toolName = block['name']
                toolInput = block.get('input') if block.get('input') is not None else []
                toolUseId = block['id']

                # Track tool name and check if it's an MCP tool
                totals.functionsCalled.append(toolName)
                isMcp = bool(self.functionExecutor) and self.functionExecutor.isMCPTool(toolName)
                if isMcp:
                    totals.mcpToolsCalled.append(toolName)
                error_log(f"📊 [ClaudeProvider] Added to functionsCalled: {toolName} (MCP: " + ('yes' if isMcp else 'no') + "), total functions: " + str(len(totals.functionsCalled)))

                self._sendProgress(f"Executing function: {toolName}")
                if self.logger:
                    self.logger.debug("Executing tool", {'name': toolName, 'input': toolInput})

                # Execute the function
                result = self._executeFunction(toolName, toolInput, userId)

                # Strip large binary data (like base64 images) from the result before sending to Claude
                # Claude doesn't need the actual image/video data - just the status
                resultForClaude = self._stripLargeDataFromResult(result)

                # Safely encode the result, handling potential encoding issues
                if isinstance(resultForClaude, str):
                    resultContent = resultForClaude
                else:
                    try:
                        resultContent = dumps(resultForClaude)
                    except (TypeError, ValueError) as encodeError:
                        error_log(f"⚠️ [ClaudeProvider] JSON encoding failed for tool '{toolName}': " + str(encodeError))
                        # Try encoding with UTF-8 sanitization (PHP:
                        # JSON_INVALID_UTF8_SUBSTITUTE; here: stringify what
                        # the encoder cannot represent)
                        try:
                            resultContent = json.dumps(resultForClaude, ensure_ascii=False, separators=(',', ':'), default=str)
                        except (TypeError, ValueError):
                            error_log("❌ [ClaudeProvider] JSON encoding still failed after UTF-8 fix, using fallback")
                            resultContent = dumps({'error': 'Tool result could not be encoded', 'tool': toolName})

                # Ensure the content is valid UTF-8. Python strs are always
                # valid Unicode, but lone surrogates cannot be encoded.
                try:
                    resultContent.encode('utf-8')
                except UnicodeEncodeError:
                    error_log(f"⚠️ [ClaudeProvider] Tool '{toolName}' result contains invalid UTF-8, sanitizing")
                    resultContent = resultContent.encode('utf-8', 'replace').decode('utf-8')

                error_log(f"🔧 Tool '{toolName}' result: " + resultContent[0:200])

                toolResults.append({
                    'type': 'tool_result',
                    'tool_use_id': toolUseId,
                    'content': resultContent,
                })

        if php_empty(toolResults):
            return response

        # Fix tool_use blocks: convert empty input arrays to objects
        # Also filter out empty text blocks
        sanitizedContent = []
        for block in assistantContent:
            if block.get('type') is not None and block['type'] == 'tool_use':
                sanitizedBlock = dict(block)
                # Convert empty array to stdClass for proper JSON {} encoding
                if sanitizedBlock.get('input') is not None and isinstance(sanitizedBlock['input'], (dict, list)) and php_empty(sanitizedBlock['input']):
                    sanitizedBlock['input'] = {}
                sanitizedContent.append(sanitizedBlock)
            elif block.get('type') is not None and block['type'] == 'text':
                # Only include text blocks if they have non-empty content
                if not php_empty((block.get('text') if block.get('text') is not None else '').strip()):
                    sanitizedContent.append(block)
            else:
                # Include other block types as-is
                sanitizedContent.append(block)

        # Add assistant message with tool use
        messages.append({
            'role': 'assistant',
            'content': sanitizedContent,
        })

        # Add user message with tool results
        messages.append({
            'role': 'user',
            'content': toolResults,
        })

        # DEBUG: Log continuation messages
        error_log("🔄 Sending continuation request with messages: " + dumps({
            'message_count': len(messages),
            'last_message_role': messages[-1]['role'],
            'sanitized_content_count': len(sanitizedContent),
        }))

        # Make continuation request (use streaming if enabled)
        self._sendProgress("Processing Claude response...")
        if self.streamingEnabled and self.sseClient:
            continuationResponse = self._makeStreamingRequest(messages, systemPrompt, tools)
        else:
            continuationResponse = self._makeRequest(messages, systemPrompt, tools)

        # Accumulate tokens
        continuationUsage = continuationResponse.get('usage') if continuationResponse.get('usage') is not None else {}
        totals.inputTokens += continuationUsage.get('input_tokens') if continuationUsage.get('input_tokens') is not None else 0
        totals.outputTokens += continuationUsage.get('output_tokens') if continuationUsage.get('output_tokens') is not None else 0

        # Check if there are more tool uses
        if self._hasToolUse(continuationResponse):
            return self._handleToolUseRecursive(
                continuationResponse,
                messages,
                systemPrompt,
                tools,
                userId,
                totals,
                depth + 1,
            )

        return continuationResponse

    def _executeFunction(self, functionName: str, parameters, userId) -> dict:
        """Execute a function."""
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

    def _hasToolUse(self, response: dict) -> bool:
        """Check if response has tool use."""
        content = response.get('content') if response.get('content') is not None else []
        for block in content:
            if (block.get('type') if block.get('type') is not None else '') == 'tool_use':
                # The schema tool is terminal — its input IS the final structured
                # output, so do not enter the tool-execution loop for it.
                if self.pendingSchemaToolName is not None \
                        and (block.get('name') if block.get('name') is not None else '') == self.pendingSchemaToolName:
                    continue
                return True
        return False

    def _extractTextResponse(self, response: dict) -> str:
        """Extract text response from Claude response.

        If a schema tool was injected for constrained decoding and Claude
        called it, return its `input` (the structured output) JSON-encoded.
        """
        content = response.get('content') if response.get('content') is not None else []

        # Constrained decoding: prefer the schema tool's structured input
        if self.pendingSchemaToolName is not None:
            for block in content:
                if (block.get('type') if block.get('type') is not None else '') == 'tool_use' \
                        and (block.get('name') if block.get('name') is not None else '') == self.pendingSchemaToolName:
                    structured = block.get('input') if block.get('input') is not None else {}
                    return dumps(structured) or ''

        textParts = []
        for block in content:
            if (block.get('type') if block.get('type') is not None else '') == 'text':
                textParts.append(block['text'])

        return "\n".join(textParts)

    def _buildMessages(self, conversationHistory: list, newMessage: str, imageAttachments: list | None = None, pdfAttachments: list | None = None) -> list:
        """Build messages array for Claude API."""
        imageAttachments = [] if imageAttachments is None else imageAttachments
        pdfAttachments = [] if pdfAttachments is None else pdfAttachments

        messages = []

        for msg in conversationHistory:
            role = msg.get('role') if msg.get('role') is not None else ''

            # Tool-result turns (role=tool) come from a prior client-side
            # tool dispatch (see B3 two-shot loop). Preserve them as Claude
            # tool_result blocks so the model sees its own previous tool
            # call and our follow-up. Without this they'd be silently
            # stripped and the next turn would land in a malformed state.
            if role == 'tool' and not php_empty(msg.get('tool_call_id')):
                messages.append({
                    'role': 'user',
                    'content': [{
                        'type': 'tool_result',
                        'tool_use_id': msg['tool_call_id'],
                        'content': msg['content'] if isinstance(msg.get('content'), str) else dumps(msg.get('content')),
                    }],
                })
                continue

            # Assistant turns may carry tool_calls (the LLM's own tool_use
            # emitted in the previous round). Re-emit them as tool_use
            # blocks alongside any text so Claude can match its own call
            # ids to the tool_result that follows.
            if role == 'assistant' and not php_empty(msg.get('tool_calls')):
                content = []
                textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
                if not php_empty(textContent.strip()):
                    content.append({'type': 'text', 'text': textContent})
                for tc in msg['tool_calls']:
                    function = tc.get('function') if isinstance(tc.get('function'), dict) else None
                    if function is not None and function.get('arguments') is not None:
                        args = function['arguments']
                    elif tc.get('input') is not None:
                        args = tc['input']
                    else:
                        args = []
                    if isinstance(args, str):
                        decoded = _json_decode(args)
                        args = decoded if isinstance(decoded, (dict, list)) else []
                    if php_empty(args):
                        args = {}
                    name = ''
                    if function is not None and function.get('name') is not None:
                        name = function['name']
                    elif tc.get('name') is not None:
                        name = tc['name']
                    content.append({
                        'type': 'tool_use',
                        'id': tc['id'],
                        'name': name,
                        'input': args,
                    })
                if not php_empty(content):
                    messages.append({'role': 'assistant', 'content': content})
                continue

            # Plain text turns (the common case): extract & emit. Empty/
            # whitespace-only entries are skipped — Anthropic rejects them.
            textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
            if not php_empty(textContent.strip()):
                messages.append({
                    'role': role,
                    'content': [
                        {'type': 'text', 'text': textContent},
                    ],
                })

        # Continuation case: the second shot of a B3 client-side tool round
        # arrives with the tool_result already at the tail of
        # conversation_history and an empty $newMessage. We must NOT append
        # an empty user turn — Anthropic rejects that, and Claude is meant
        # to keep talking after the tool_result on its own.
        isToolResultContinuation = (
            php_empty(newMessage.strip())
            and php_empty(imageAttachments)
            and php_empty(pdfAttachments)
            and not php_empty(messages)
            and (messages[len(messages) - 1].get('role') if messages[len(messages) - 1].get('role') is not None else '') == 'user'
            and self._lastBlockIsToolResult(messages[len(messages) - 1])
        )

        if isToolResultContinuation:
            error_log("🔧 [ClaudeProvider] Continuation after client tool result — not appending empty user turn.")
            error_log("🔍 Messages being sent to Claude API: " + json.dumps(messages, ensure_ascii=False, indent=4))
            return messages

        # Build the current user message's content blocks. PDFs and images
        # go FIRST so Claude sees them before the text prompt — matches the
        # order Anthropic documents in their vision/document examples.
        userContent = []
        for pdf in pdfAttachments:
            userContent.append({
                'type': 'document',
                'source': {
                    'type': 'base64',
                    'media_type': pdf['mime_type'],
                    'data': pdf['data'],
                },
            })
        for img in imageAttachments:
            userContent.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': img['mime_type'],
                    'data': img['data'],
                },
            })
        userContent.append({'type': 'text', 'text': newMessage})

        messages.append({
            'role': 'user',
            'content': userContent,
        })

        # DEBUG: Log the messages being sent (elide image/document data — huge)
        logSafe = json.loads(json.dumps(messages, ensure_ascii=False))
        for m in logSafe:
            if not isinstance(m.get('content'), (dict, list)):
                continue
            for blk in m['content']:
                blockType = blk.get('type') if blk.get('type') is not None else ''
                if (blockType == 'image' or blockType == 'document') and isinstance(blk.get('source'), dict) and blk['source'].get('data') is not None:
                    blk['source']['data'] = '[base64 elided]'
        error_log("🔍 Messages being sent to Claude API: " + json.dumps(logSafe, ensure_ascii=False, indent=4))

        return messages

    @staticmethod
    def _lastBlockIsToolResult(message: dict) -> bool:
        """True when the message's final content block is a tool_result. Used
        by buildMessages to detect B3 continuation turns where the user
        "message" is just a placeholder and the real continuation marker is
        the tool_result block.
        """
        blocks = message.get('content') if message.get('content') is not None else []
        if not isinstance(blocks, (dict, list)) or php_empty(blocks):
            return False
        last = blocks[len(blocks) - 1] if isinstance(blocks, list) else None
        return isinstance(last, (dict, list)) and (last.get('type') if isinstance(last, dict) and last.get('type') is not None else '') == 'tool_result'

    def _extractTextFromContent(self, content) -> str:
        """Extract text from content (handles both string and array formats)."""
        if isinstance(content, str):
            return content

        if isinstance(content, (dict, list)):
            textParts = []
            values = content.values() if isinstance(content, dict) else content
            for block in values:
                if isinstance(block, (dict, list)) and (block.get('type') if isinstance(block, dict) and block.get('type') is not None else '') == 'text':
                    textParts.append(block.get('text') if block.get('text') is not None else '')
                elif isinstance(block, str):
                    textParts.append(block)
            return "\n".join(textParts)

        return ''

    def _getTools(self) -> list:
        """Get tools for Claude API."""
        if not self.functionExecutor:
            return []

        return self.functionExecutor.getToolDefinitions()

    def getContextWindow(self) -> int:
        """Claude context window (Sonnet 4.5, 3.5 Sonnet, Opus, Haiku all = 200K)."""
        return 200000

    def getDefaultSystemPrompt(self) -> str:
        """Get default system prompt."""
        # First, check if there's a custom system_prompt in config
        customPrompt = self.config.get('claude.system_prompt')
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
        """Send progress to SSE client."""
        if self.sseClient:
            self.sseClient.sendProgress(f"Claude: {message}")

    def _trackUsage(self, userId, inputTokens: int, outputTokens: int, functionCallCount: int, responseTimeMs: int) -> None:
        """Track usage statistics."""
        if self.usageTracker:
            self.usageTracker.trackRequest({
                'user_id': userId,
                'provider': 'claude',
                'model': self.model,
                'request_type': 'chat',
                'input_tokens': inputTokens,
                'output_tokens': outputTokens,
                'function_calls_count': functionCallCount,
                'response_time_ms': responseTimeMs,
                'status': 'success',
            })

    def _convertEmptyArraysToObjects(self, data):
        """Recursively convert empty arrays to stdClass objects for proper JSON encoding.

        PHP quirk faithfully preserved: `$isAssociative` is computed as
        `array_keys($data) !== range(0, count($data) - 1)`, and for an EMPTY
        array that is `[] !== [0, -1]` → true. So the "empty indexed array →
        object" branch never fires and empty containers come back unchanged;
        only non-empty containers are recursed into.
        """
        if not isinstance(data, (dict, list)):
            return data

        # Empty arrays are "associative" per the quirk above → returned as-is.
        if len(data) == 0:
            return data

        # Recursively process all values
        if isinstance(data, list):
            return [self._convertEmptyArraysToObjects(value) for value in data]

        return {key: self._convertEmptyArraysToObjects(value) for key, value in data.items()}

    def _stripLargeDataFromResult(self, result):
        """Strip large binary data (base64 images, videos, etc.) from tool results
        to prevent payload size issues when sending back to Claude.
        Claude doesn't need the actual binary data - just the status/metadata.
        """
        if isinstance(result, str):
            # If it's a very long string (likely base64), truncate it
            if len(result.encode('utf-8')) > 50000:
                return '[Large data truncated - ' + str(len(result.encode('utf-8'))) + ' bytes]'
            return result

        if not isinstance(result, (dict, list)):
            return result

        # Keys that typically contain large binary data
        largeDataKeys = ['imageBase64', 'videoBase64', 'base64', 'data', 'content_base64', 'image_data', 'binary']

        isList = isinstance(result, list)
        items = list(enumerate(result)) if isList else list(result.items())
        strippedList = []
        strippedDict = {}

        for key, value in items:
            # Check if this key is known to contain large data (PHP in_array
            # with strict=true: integer list indexes never match)
            if isinstance(key, str) and key in largeDataKeys and isinstance(value, str) and len(value.encode('utf-8')) > 1000:
                newValue = '[Base64 data stripped - ' + str(len(value.encode('utf-8'))) + ' bytes]'
            # Also strip from nested _mcp_ui.tool_result which contains raw MCP response
            elif key == '_mcp_ui' and isinstance(value, (dict, list)):
                # Keep UI info but strip the raw tool_result data
                newValue = dict(value) if isinstance(value, dict) else list(value)
                if isinstance(newValue, dict) and newValue.get('tool_result') is not None:
                    newValue['tool_result'] = self._stripLargeDataFromResult(value['tool_result'])
            # Also check structuredContent which often contains base64
            elif key == 'structuredContent' and isinstance(value, (dict, list)):
                newValue = self._stripLargeDataFromResult(value)
            elif isinstance(value, (dict, list)):
                newValue = self._stripLargeDataFromResult(value)
            else:
                newValue = value

            if isList:
                strippedList.append(newValue)
            else:
                strippedDict[key] = newValue

        return strippedList if isList else strippedDict

    def _parseClaudeStreamEvent(self, eventBlock: str):
        """Parse a Claude SSE event block.

        Returns a dict with 'event' and 'data' keys, or None if invalid.
        """
        lines = eventBlock.split("\n")
        event = None
        data = None

        for line in lines:
            if line.startswith('event:'):
                event = line[6:].strip()
            elif line.startswith('data:'):
                # Don't trim data - SSE format has a space after colon, remove only that
                dataLine = line[5:]
                data = dataLine[1:] if len(dataLine) > 0 and dataLine[0] == ' ' else dataLine

        if php_bool(event) and php_bool(data):
            # Parse JSON data
            parsedData = _json_decode(data)
            if parsedData is not None:
                return {
                    'event': event,
                    'data': parsedData,
                }

        return None

    @staticmethod
    def buildHttpRequest(model: str, messages: list, tools: list, config: dict, maxTokens: int, temperature: float) -> dict:
        """Build an HTTP request for Claude API (static method for parallel execution).

        Returns a dict with keys: url, headers, payload, provider.
        """
        # Extract system prompt and convert messages to Claude format
        systemPrompt = ''
        claudeMessages = []

        for msg in messages:
            if msg['role'] == 'system':
                systemPrompt = msg['content']
            elif msg['role'] == 'assistant':
                # Handle assistant messages with tool_calls (Claude format: tool_use blocks)
                if not php_empty(msg.get('tool_calls')):
                    content = []
                    if not php_empty(msg.get('content')):
                        content.append({'type': 'text', 'text': msg['content']})
                    for tc in msg['tool_calls']:
                        function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                        arguments = function.get('arguments') if function.get('arguments') is not None else ''
                        if isinstance(arguments, str):
                            decoded = _json_decode(function['arguments']) if function.get('arguments') is not None else None
                            inputData = decoded if decoded is not None else []
                        elif function.get('arguments') is not None:
                            inputData = function['arguments']
                        elif tc.get('input') is not None:
                            inputData = tc['input']
                        else:
                            inputData = []
                        # Convert empty array to stdClass for JSON {} encoding
                        if php_empty(inputData):
                            inputData = {}
                        content.append({
                            'type': 'tool_use',
                            'id': tc['id'],
                            'name': function['name'] if function.get('name') is not None else tc['name'],
                            'input': inputData,
                        })
                    claudeMessages.append({'role': 'assistant', 'content': content})
                else:
                    # Use content blocks format
                    textContent = msg.get('content') if msg.get('content') is not None else ''
                    if not php_empty(textContent.strip()):
                        claudeMessages.append({
                            'role': 'assistant',
                            'content': [
                                {'type': 'text', 'text': textContent},
                            ],
                        })
            elif msg['role'] == 'tool':
                # Claude uses tool_result blocks in a user message
                claudeMessages.append({
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': msg['tool_call_id'],
                            'content': msg['content'],
                        },
                    ],
                })
            elif msg['role'] == 'user':
                # Use content blocks format
                claudeMessages.append({
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': msg['content']},
                    ],
                })

        payload = {
            'model': model,
            'max_tokens': maxTokens,
            'messages': claudeMessages,
        }

        # Only add system if not empty (Claude rejects empty system)
        if not php_empty(systemPrompt):
            payload['system'] = ClaudeProvider._buildCachedSystemBlocks(systemPrompt)

        # Add tools in Claude format
        if not php_empty(tools):
            mappedTools = []
            for tool in tools:
                if tool.get('input_schema') is not None:
                    inputSchema = tool['input_schema']
                elif tool.get('parameters') is not None:
                    inputSchema = tool['parameters']
                else:
                    inputSchema = {'type': 'object', 'properties': {}, 'required': []}

                inputSchema = dict(inputSchema) if isinstance(inputSchema, dict) else inputSchema

                # Ensure properties is an object, not empty array
                if isinstance(inputSchema, dict) and inputSchema.get('properties') is not None \
                        and isinstance(inputSchema['properties'], (dict, list)) and php_empty(inputSchema['properties']):
                    inputSchema['properties'] = {}

                # Ensure required is always an array (Claude rejects {} for required field)
                if isinstance(inputSchema, dict) and 'required' not in inputSchema:
                    inputSchema['required'] = []

                mappedTools.append({
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'input_schema': inputSchema,
                })
            payload['tools'] = mappedTools

        # Convert empty arrays to objects, but preserve 'required' arrays
        payload = ClaudeProvider.convertEmptyArraysToObjectsForClaude(payload)

        baseUrl = config.get('base_url') if config.get('base_url') is not None else 'https://api.anthropic.com'
        apiVersion = config.get('api_version') if config.get('api_version') is not None else '2023-06-01'

        return {
            'url': baseUrl.rstrip('/') + '/v1/messages',
            'headers': [
                'Content-Type: application/json',
                'x-api-key: ' + config['api_key'],
                'anthropic-version: ' + apiVersion,
            ],
            'payload': payload,
            'provider': 'claude',
        }

    @staticmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """Parse Claude API response (static method for parallel execution).

        Returns a dict with keys: text, tool_calls (OpenAI format), usage (normalized).
        """
        content = decoded.get('content') if decoded.get('content') is not None else []
        text = ''
        toolCalls = []

        for block in content:
            if block['type'] == 'text':
                text += block['text']
            elif block['type'] == 'tool_use':
                # Convert to OpenAI-compatible format for consistent handling
                toolCalls.append({
                    'id': block['id'],
                    'type': 'function',
                    'function': {
                        'name': block['name'],
                        'arguments': dumps(block['input'] if block.get('input') is not None else []),
                    },
                })

        usage = ClaudeProvider.normalizeUsage(decoded.get('usage'), 'claude')

        return {
            'text': text,
            'tool_calls': toolCalls,
            'usage': usage,
        }

    @staticmethod
    def getApiFamily() -> str:
        """Get the API family for this provider."""
        return 'claude'
