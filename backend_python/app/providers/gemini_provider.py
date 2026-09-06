"""Port of Providers/GeminiProvider.php.

Google Gemini Provider

Gemini uses a different API format than OpenAI:
- API key passed as query parameter
- Different request/response structure

Line-for-line port; PHP method names are preserved (private PHP methods
become `_name`). PHP semantics are reproduced with the helpers in
app.support.phpcompat (`php_empty` for `empty()`, `x.get(k) if ... is not
None else d` for `??`, dict-or-list for `is_array()`).

PHP's `is_object($x) -> json_decode(json_encode($x), true)` re-hydration
guards appear all over the PHP file because Guzzle bodies decoded without
the assoc flag hand back stdClass trees. `json.loads` in Python always
produces dicts/lists, so those guards are unreachable here and are dropped
(noted at each site).
"""
from __future__ import annotations

import json
import secrets
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
from app.support.phpcompat import php_empty, php_strval, php_uniqid
from app.support.phpjson import dumps


def _json_decode(s):
    """PHP json_decode($s, true): returns None on malformed input."""
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


def _to_object(value):
    """PHP `(object) $array` — an assoc array becomes a JSON object, a list
    array becomes an object with the numeric indexes as string keys.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return {str(i): v for i, v in enumerate(value)}
    return value


def _first_candidate(response) -> dict:
    """PHP `$response['candidates'][0] ?? []` — a missing key OR a missing
    index both collapse to [] through the null-coalescing operator.
    """
    candidates = response.get('candidates') if isinstance(response, dict) and response.get('candidates') is not None else []
    if isinstance(candidates, list) and len(candidates) > 0:
        first = candidates[0]
        return first if isinstance(first, dict) else {}
    return {}


def _parts_of(response) -> list:
    """The `$response['candidates'][0]['content']['parts'] ?? []` chain PHP
    repeats verbatim in handleFunctionCallsRecursive(), hasFunctionCalls()
    and extractTextResponse(). Every step is a `??` fallback to [].
    """
    candidate = _first_candidate(response)
    content = candidate.get('content') if candidate.get('content') is not None else []
    if not isinstance(content, dict):
        content = {}
    parts = content.get('parts') if content.get('parts') is not None else []
    if not isinstance(parts, list):
        parts = []
    return parts


class GeminiProvider(
    ProviderRequestBuilderMixin,
    ClientSideToolsMixin,
    AIProviderInterface,
    HttpRequestBuilderInterface,
):
    """Port of backend/src/Providers/GeminiProvider.php."""

    # Keep this list in sync with backend/resources/model_catalog.json's
    # `gemini` array. Catalog is the user-facing source of truth (admin
    # dropdown + Settings panel pricing); this constant is the runtime
    # allow-list that the provider uses to validate model selections.
    # Diverging the two leads to "model X is in the dropdown but the
    # backend rejects it" — confusing for admins who just configured it.
    SUPPORTED_MODELS = [
        # Gemini 3 (preview)
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3-flash-lite-preview',
        # Gemini 2.5
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        # Gemini 2.0
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        # Gemini 1.5 (legacy — kept for backwards-compatibility with users
        # who set up before Gemini 2.x existed)
        'gemini-1.5-flash',
        'gemini-1.5-pro',
    ]

    def __init__(self, config: Configuration):
        self.config = config

        self.functionExecutor: FunctionExecutorInterface | None = None
        self.usageTracker: UsageTrackerInterface | None = None
        self.sseClient: StreamingClientInterface | None = None
        self.logger: DebugLogger | None = None

        # Output schema for constrained decoding via Gemini's responseSchema.
        self.pendingOutputSchema: dict | None = None

        # Get Gemini config from providers section
        geminiConfig = config.get('providers.gemini', {})

        self.model = geminiConfig.get('model') if geminiConfig.get('model') is not None else 'gemini-2.5-flash'
        self.maxTokens = geminiConfig.get('max_tokens') if geminiConfig.get('max_tokens') is not None else 4096
        self.temperature = geminiConfig.get('temperature') if geminiConfig.get('temperature') is not None else 0.7
        baseUrl = geminiConfig.get('base_url') if geminiConfig.get('base_url') is not None else 'https://generativelanguage.googleapis.com/v1beta'
        self.baseUrl = baseUrl.rstrip('/')
        self.apiKey = geminiConfig.get('api_key') if geminiConfig.get('api_key') is not None else ''
        self.maxRecursionDepth = config.get('max_recursion_depth', 10)

        # No base_url: makeRequest() posts the absolute URL because the API
        # key rides in the query string (PHP:324).
        self.httpClient = httpx.Client(
            timeout=600,  # 10 minutes for large responses
        )

        if config.isDebugEnabled():
            self.logger = DebugLogger(True)

        self._init_client_side_tools()

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this provider's httpx connection pool."""
        self.httpClient.close()

    def setFunctionExecutor(self, executor: FunctionExecutorInterface) -> 'GeminiProvider':
        self.functionExecutor = executor
        return self

    def setUsageTracker(self, tracker: UsageTrackerInterface) -> 'GeminiProvider':
        self.usageTracker = tracker
        return self

    def setSSEClient(self, client: StreamingClientInterface) -> 'GeminiProvider':
        self.sseClient = client
        return self

    def setLogger(self, logger: DebugLogger) -> 'GeminiProvider':
        self.logger = logger
        return self

    def getName(self) -> str:
        return 'gemini'

    def isAvailable(self) -> bool:
        return not php_empty(self.apiKey)

    def getModel(self) -> str:
        return self.model

    def setModel(self, model: str) -> 'GeminiProvider':
        self.model = model
        return self

    def getSupportedModels(self) -> list:
        return list(self.SUPPORTED_MODELS)  # PHP returns a value copy

    def chat(self, message: str, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        startTime = time.time()

        self._sendProgress("Preparing Gemini request...")

        systemPrompt = self.buildSystemPrompt(options)
        # Honor caller-supplied tools (e.g. workflow client-side run_skill_script)
        # regardless of functionExecutor — client tools run in the browser. The
        # gate only governs this provider's OWN server tools (getTools()).
        tools = options.get('tools') if options.get('tools') is not None else (self._getTools() if self.functionExecutor else [])
        tools = list(tools)  # PHP arrays are value types; never mutate the caller's list
        userId = options.get('user_id')

        # Register client-side tool names so isClientSideTool() works during this request
        if not php_empty(options.get('client_tool_names')) and isinstance(options.get('client_tool_names'), (dict, list)):
            self.setPerRequestClientSideToolNames(options['client_tool_names'])

        # Append client tools in source shape — convertToGeminiTools() will map input_schema → parameters
        if not php_empty(options.get('client_tools')) and isinstance(options.get('client_tools'), (dict, list)):
            for ct in options['client_tools']:
                tools.append({
                    'name': ct['name'],
                    'description': ct.get('description') if ct.get('description') is not None else '',
                    'input_schema': ct.get('input_schema') if ct.get('input_schema') is not None else {'type': 'object', 'properties': {}},
                })

        # Stash output_schema for makeRequest()
        self.pendingOutputSchema = (
            options['output_schema']
            if not php_empty(options.get('output_schema')) and isinstance(options.get('output_schema'), (dict, list))
            else None
        )

        # Build Gemini-format messages
        contents = self._buildContents(
            conversationHistory,
            message,
            options.get('image_attachments') if options.get('image_attachments') is not None else [],
            options.get('pdf_attachments') if options.get('pdf_attachments') is not None else [],
        )

        # Make initial request
        response = self._makeRequest(contents, systemPrompt, tools)

        # Debug: Log full response for troubleshooting
        error_log("[Gemini] FULL RESPONSE: " + dumps(response))

        # Track tokens and tool calls
        usageMetadata = response.get('usageMetadata') if isinstance(response, dict) and response.get('usageMetadata') is not None else {}
        totals = _Totals(
            inputTokens=usageMetadata.get('promptTokenCount') if usageMetadata.get('promptTokenCount') is not None else 0,
            outputTokens=usageMetadata.get('candidatesTokenCount') if usageMetadata.get('candidatesTokenCount') is not None else 0,
        )
        self.emitContextWarningIfHigh(totals.inputTokens)

        # Handle function calls recursively
        hasCalls = self._hasFunctionCalls(response)
        error_log("[Gemini] Has function calls: " + ('YES' if hasCalls else 'NO'))

        if hasCalls:
            self._sendProgress("Processing function calls...")

            response = self._handleFunctionCallsRecursive(
                response,
                contents,
                systemPrompt,
                tools,
                userId,
                totals,
            )

            afterContent = _first_candidate(response).get('content')
            error_log("[Gemini] After function calls, response: " + dumps(afterContent if afterContent is not None else 'none'))

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
                'provider': 'gemini',
                'functions_called': totals.functionsCalled,
                'mcp_tools_called': totals.mcpToolsCalled,
                'mcp_calls_count': len(totals.mcpToolsCalled),
                'pending_client_tool_call': True,
                'pending_tool_calls': response.get('_pending_tool_calls') if response.get('_pending_tool_calls') is not None else [],
            }

        # Emit truncation warning if model hit max output tokens
        finishReason = _first_candidate(response).get('finishReason')
        self.emitUsageWarningIfTruncated(
            finishReason if finishReason is not None else '',
            totals.outputTokens,
        )

        # Extract final text response
        textResponse = self._extractTextResponse(response)
        error_log("[Gemini] Extracted text length: " + str(len(textResponse)))

        # Detect empty response issue (Gemini sometimes returns empty with tools)
        if php_empty(textResponse) and not hasCalls:
            emptyFinishReason = _first_candidate(response).get('finishReason')
            emptyFinishReason = emptyFinishReason if emptyFinishReason is not None else 'UNKNOWN'
            error_log(f"[Gemini] WARNING: Empty response with finishReason={emptyFinishReason}, retrying without tools...")

            # Retry without tools as fallback
            retryResponse = self._makeRequest(contents, systemPrompt, [])
            textResponse = self._extractTextResponse(retryResponse)

            if php_empty(textResponse):
                textResponse = "I apologize, but I couldn't generate a response. Please try rephrasing your question."
                error_log("[Gemini] Retry also failed, returning fallback message")
            else:
                error_log("[Gemini] Retry without tools succeeded, text length: " + str(len(textResponse)))

        responseTimeMs = int((time.time() - startTime) * 1000)

        # Track usage
        self._trackUsage(userId, totals.inputTokens, totals.outputTokens, totals.functionCallCount, responseTimeMs)

        self._sendProgress("Response ready.")

        # Clear pending schema state
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
            'provider': 'gemini',
            'functions_called': totals.functionsCalled,
            'mcp_tools_called': totals.mcpToolsCalled,
            'mcp_calls_count': len(totals.mcpToolsCalled),
        }

    def streamChat(self, message: str, onChunk, conversationHistory: list | None = None, options: dict | None = None) -> dict:
        """Gemini has no streaming path here: chat() then one onChunk() with
        the whole text (PHP:304-313)."""
        conversationHistory = [] if conversationHistory is None else conversationHistory
        options = {} if options is None else options

        result = self.chat(message, conversationHistory, options)
        onChunk(result['text'])
        return result

    def _makeRequest(self, contents: list, systemPrompt: str, tools: list | None = None) -> dict:
        tools = [] if tools is None else tools

        self._sendProgress("Connecting to Gemini API...")

        if php_empty(self.apiKey):
            raise ProviderException.authenticationFailed('gemini')

        # Gemini API URL format with API key as query parameter
        url = f"{self.baseUrl}/models/{self.model}:generateContent?key={self.apiKey}"

        payload = {
            'contents': contents,
            'generationConfig': {
                'maxOutputTokens': self.maxTokens,
                'temperature': self.temperature,
            },
        }

        # Constrained decoding via Gemini's controlled generation.
        # Note: Gemini does not allow tools + responseSchema in the same call.
        if self.pendingOutputSchema is not None and php_empty(tools):
            schema = self.pendingOutputSchema
            payload['generationConfig']['responseMimeType'] = 'application/json'
            payload['generationConfig']['responseSchema'] = self._sanitizeSchemaForGemini(
                schema.get('schema') if schema.get('schema') is not None else {}
            )
        elif self.pendingOutputSchema is not None:
            # Falling back to a strong system-prompt nudge when tools are present
            schemaJson = dumps(
                self.pendingOutputSchema.get('schema') if self.pendingOutputSchema.get('schema') is not None else {}
            )
            systemPrompt += ("\n\n## Required output format\n"
                             "Your final response MUST be a single JSON object that conforms to this JSON Schema (no prose, no markdown):\n"
                             + schemaJson)

        # Add system instruction
        if not php_empty(systemPrompt):
            payload['systemInstruction'] = {
                'parts': [{'text': systemPrompt}],
            }

        # Add tools if available
        if not php_empty(tools):
            geminiTools = self._convertToGeminiTools(tools)
            payload['tools'] = geminiTools

            # Add toolConfig - AUTO allows model to choose between text and function calls
            payload['toolConfig'] = {
                'functionCallingConfig': {
                    'mode': 'AUTO',
                },
            }

            error_log("[Gemini] Sending " + str(len(tools)) + " tools with AUTO mode")

        # DEBUG: Log the exact contents being sent
        error_log("[Gemini] REQUEST PAYLOAD contents: " + dumps(payload['contents']))

        if self.logger:
            self.logger.logApiRequest('gemini', url, payload)

        try:
            response = self.httpClient.post(
                url,
                headers={'Content-Type': 'application/json'},
                content=dumps(payload).encode('utf-8'),
            )
            response.raise_for_status()

            body = _json_decode(response.text)
            if self.logger:
                self.logger.logApiResponse('gemini', 200, 0)

            return body
        except httpx.HTTPStatusError as e:
            statusCode = e.response.status_code

            # PHP passes $e->getMessage() (PHP:410); Guzzle's RequestException
            # message embeds the response-body summary, and
            # ChatController::humanizeProviderError pattern-matches on it.
            # httpx's str(e) carries only the status line, so append the body —
            # same shape as openai_provider.py.
            message = str(e) + " | Response: " + e.response.text

            # Log the full error for debugging
            error_log(f"[Gemini] API error (code {statusCode}): {message}")
            error_log(f"[Gemini] Error response body: {e.response.text}")

            if statusCode == 429:
                raise ProviderException.rateLimited('gemini')

            if statusCode == 401 or statusCode == 403:
                raise ProviderException.authenticationFailed('gemini')

            raise ProviderException.apiError('gemini', message, statusCode)
        except httpx.RequestError as e:
            # Guzzle's ConnectException is a GuzzleException too; it carries no
            # HTTP status, so PHP's $e->getCode() would be 0.
            error_log(f"[Gemini] API error (code 0): {e}")
            raise ProviderException.apiError('gemini', str(e), 0)

    def _sanitizeSchemaForGemini(self, schema):
        """Recursively strip JSON Schema fields that Gemini's responseSchema does
        not accept (e.g. additionalProperties, $schema, definitions, $ref).
        """
        if not isinstance(schema, (dict, list)):
            return schema

        disallowed = [
            'additionalProperties', '$schema', '$id', '$ref', '$defs',
            'definitions', 'oneOf', 'anyOf', 'allOf', 'not',
            'patternProperties', 'unevaluatedProperties',
        ]

        clean = {}
        items = schema.items() if isinstance(schema, dict) else enumerate(schema)
        for key, value in items:
            if key in disallowed:
                continue
            if key == 'type' and isinstance(value, str):
                # Gemini expects uppercase types
                clean[key] = value.upper()
            elif key == 'properties' and isinstance(value, (dict, list)):
                clean[key] = {}
                propItems = value.items() if isinstance(value, dict) else enumerate(value)
                for propName, propSchema in propItems:
                    clean[key][propName] = self._sanitizeSchemaForGemini(propSchema)
            elif key == 'items' and isinstance(value, (dict, list)):
                clean[key] = self._sanitizeSchemaForGemini(value)
            else:
                clean[key] = value

        return clean

    def _handleFunctionCallsRecursive(
        self,
        response: dict,
        contents: list,
        systemPrompt: str,
        tools: list,
        userId,
        totals: _Totals,
        depth: int = 0,
    ) -> dict:
        """Handle function calls recursively.

        `totals` replaces PHP's `&$inputTokens, &$outputTokens,
        &$functionCallCount, &$functionsCalled, &$mcpToolsCalled` reference
        parameters; `contents` is mutated in place like PHP's `&$contents`.
        """
        if depth >= self.maxRecursionDepth:
            if self.logger:
                self.logger.warning("Max recursion depth reached", {'depth': depth})
            return response

        # PHP re-hydrates stdClass at each level here; json.loads never
        # produces objects, so _parts_of() is the whole chain.
        parts = _parts_of(response)

        functionCalls = []
        functionResults = []
        # Track each functionCall's per-part thoughtSignature alongside it
        # (Gemini 2.5+ requires this to be re-emitted on the next turn or
        # the API rejects the request with "Function call is missing a
        # thought_signature").
        functionCallSignatures = []

        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get('functionCall') is not None:
                fc = part['functionCall']
                functionCalls.append(fc)
                functionCallSignatures.append(part.get('thoughtSignature'))

        if php_empty(functionCalls):
            return response

        # B3: surface solo client-side tool turns to the frontend. The
        # detection mirrors Claude/OpenAI but the input shape is Gemini's
        # (no id field — synthesize one so the frontend can correlate
        # tool_use → tool_result on the round-trip).
        clientCalls = []
        clientCallSignatures = []
        serverCalls = []
        for i, fc in enumerate(functionCalls):
            if self.isClientSideTool(fc.get('name') if fc.get('name') is not None else ''):
                clientCalls.append(fc)
                clientCallSignatures.append(functionCallSignatures[i] if i < len(functionCallSignatures) else None)
            else:
                serverCalls.append(fc)

        if not php_empty(clientCalls) and php_empty(serverCalls):
            # Pre-tool text from any text parts in this assistant turn.
            assistantText = ''
            for p in parts:
                if isinstance(p, dict) and p.get('text') is not None:
                    assistantText += p['text']
            normalized = []
            for i, fc in enumerate(clientCalls):
                args = fc.get('args') if fc.get('args') is not None else []
                entry = {
                    # Synthesize an id — Gemini doesn't supply one, but
                    # the frontend round-trip protocol needs a stable
                    # identifier to bind tool_use ↔ tool_result.
                    'id': 'gemini_' + secrets.token_hex(8)[0:16],
                    'name': fc.get('name') if fc.get('name') is not None else '',
                    'input': args,
                }
                # Preserve thoughtSignature so the frontend can put it
                # back on the assistant tool_calls turn it synthesizes
                # for the second-shot conversation_history. Gemini 2.5+
                # checks for this on every functionCall part.
                if not php_empty(clientCallSignatures[i] if i < len(clientCallSignatures) else None):
                    entry['thought_signature'] = clientCallSignatures[i]
                normalized.append(entry)
            error_log("🔧 [GeminiProvider] Client-side tool call detected; surfacing to frontend: " + dumps([n['name'] for n in normalized]))
            marker = self.emitClientToolCallEvent(normalized, assistantText)
            for fc in clientCalls:
                totals.functionCallCount += 1
                totals.functionsCalled.append(fc.get('name') if fc.get('name') is not None else '')
            return {**response, **marker}

        if not php_empty(clientCalls):
            error_log("⚠️ [GeminiProvider] Mixed client/server function calls in one turn — failing client-side calls.")

        # Convert model's functionCall response to request format
        # Response uses camelCase (functionCall, args), but request might need different format
        modelParts = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get('functionCall') is not None:
                fc = part['functionCall']
                # Keep the full functionCall including thoughtSignature at part level
                modelPart = {
                    'functionCall': {
                        'name': fc.get('name') if fc.get('name') is not None else '',
                        'args': _to_object(fc['args']) if not php_empty(fc.get('args')) else {},
                    },
                }
                # Include thoughtSignature if present (required for Gemini 2.5+)
                if part.get('thoughtSignature') is not None:
                    modelPart['thoughtSignature'] = part['thoughtSignature']
                modelParts.append(modelPart)

        contents.append({
            'role': 'model',
            'parts': modelParts,
        })

        error_log("[Gemini] Model parts being sent: " + dumps(modelParts))

        # Execute each function call
        for call in functionCalls:
            totals.functionCallCount += 1
            functionName = call.get('name') if call.get('name') is not None else ''
            arguments = call.get('args') if call.get('args') is not None else []

            # Mixed-turn fallback for client-side tools: emit a synthetic
            # error functionResponse and continue. The all-client branch
            # above already short-circuits the common case.
            if self.isClientSideTool(functionName):
                functionResults.append({
                    'functionResponse': {
                        'name': functionName,
                        'response': {
                            'error': 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.',
                        },
                    },
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

            # Clean result for Gemini - remove internal metadata like _mcp_ui
            cleanResult = result
            if isinstance(cleanResult, dict):
                cleanResult = {k: v for k, v in cleanResult.items() if k not in ('_mcp_ui', '_meta')}

            functionResults.append({
                'functionResponse': {
                    'name': functionName,
                    'response': cleanResult,
                },
            })

        # Add function results to contents with role 'tool' (not 'user')
        contents.append({
            'role': 'tool',
            'parts': functionResults,
        })

        error_log("[Gemini] Function results being sent with role 'tool': " + dumps(functionResults))
        error_log("[Gemini] Full contents count: " + str(len(contents)))

        # Make continuation request
        self._sendProgress("Processing Gemini response...")
        continuationResponse = self._makeRequest(contents, systemPrompt, tools)

        # Accumulate tokens
        continuationUsage = (
            continuationResponse.get('usageMetadata')
            if isinstance(continuationResponse, dict) and continuationResponse.get('usageMetadata') is not None
            else {}
        )
        totals.inputTokens += continuationUsage.get('promptTokenCount') if continuationUsage.get('promptTokenCount') is not None else 0
        totals.outputTokens += continuationUsage.get('candidatesTokenCount') if continuationUsage.get('candidatesTokenCount') is not None else 0

        # Check if there are more function calls
        if self._hasFunctionCalls(continuationResponse):
            return self._handleFunctionCallsRecursive(
                continuationResponse,
                contents,
                systemPrompt,
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

    def _hasFunctionCalls(self, response: dict) -> bool:
        parts = _parts_of(response)

        for part in parts:
            if isinstance(part, dict) and part.get('functionCall') is not None:
                return True

        return False

    def _extractTextResponse(self, response: dict) -> str:
        parts = _parts_of(response)

        textParts = []
        for part in parts:
            if isinstance(part, dict) and part.get('text') is not None:
                textParts.append(part['text'])

        return "\n".join(textParts)

    def _buildContents(self, conversationHistory: list, newMessage: str, imageAttachments: list | None = None, pdfAttachments: list | None = None) -> list:
        imageAttachments = [] if imageAttachments is None else imageAttachments
        pdfAttachments = [] if pdfAttachments is None else pdfAttachments

        contents = []

        # Add conversation history
        for msg in conversationHistory:
            msgRole = msg.get('role') if msg.get('role') is not None else 'user'

            # B3: tool_result turns from a prior client-side dispatch.
            # Translate to Gemini's functionResponse part so the model can
            # bind its prior functionCall to our follow-up. Gemini's
            # production handleFunctionCallsRecursive uses role 'user' for
            # functionResponse parts; matching that here so the model
            # recognizes our reply (otherwise it loops, calling the
            # tool over and over because it never "sees" the result).
            if msgRole == 'tool' and not php_empty(msg.get('tool_call_id')):
                contents.append({
                    'role': 'user',
                    'parts': [{
                        'functionResponse': {
                            'name': msg.get('name') if msg.get('name') is not None else 'function',
                            'response': {'result': (
                                msg['content'] if isinstance(msg.get('content'), str)
                                else dumps(msg.get('content'))
                            )},
                        },
                    }],
                })
                continue

            # B3: assistant turns carrying tool_calls (the LLM's own
            # tool_use from the prior round). Re-emit as functionCall
            # parts alongside any text so Gemini sees its own call ids.
            if msgRole == 'assistant' and not php_empty(msg.get('tool_calls')):
                parts = []
                textContent = self._extractTextFromContent(msg.get('content') if msg.get('content') is not None else '')
                if not php_empty(textContent.strip()):
                    parts.append({'text': textContent})
                for tc in msg['tool_calls']:
                    tcFunction = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                    args = tcFunction.get('arguments') if tcFunction.get('arguments') is not None else (
                        tc.get('input') if tc.get('input') is not None else []
                    )
                    if isinstance(args, str):
                        decoded = _json_decode(args)
                        args = decoded if isinstance(decoded, (dict, list)) else []
                    part = {
                        'functionCall': {
                            'name': (
                                tcFunction.get('name') if tcFunction.get('name') is not None
                                else (tc.get('name') if tc.get('name') is not None else '')
                            ),
                            'args': {} if php_empty(args) else _to_object(args),
                        },
                    }
                    # Re-emit thoughtSignature at part level — Gemini 2.5+
                    # rejects the request without it (matches the format
                    # the working in-flight handleFunctionCallsRecursive
                    # path uses for continuation turns).
                    if not php_empty(tc.get('thought_signature')):
                        part['thoughtSignature'] = tc['thought_signature']
                    parts.append(part)
                if not php_empty(parts):
                    contents.append({'role': 'model', 'parts': parts})
                continue

            role = 'model' if msgRole == 'assistant' else 'user'
            content = msg.get('content') if msg.get('content') is not None else ''
            # Plain text turns: extract text, skip empties.
            textContent = self._extractTextFromContent(content)
            if not php_empty(textContent):
                contents.append({
                    'role': role,
                    'parts': [{'text': textContent}],
                })

        # B3 continuation case: the second shot of a client-tool round
        # arrives with the tool_result already at the tail and an empty
        # newMessage. Don't append an empty user turn — Gemini would
        # reject it.
        lastContent = contents[len(contents) - 1] if not php_empty(contents) else None
        lastIsFunctionResponse = bool(
            lastContent
            and (lastContent.get('role') if lastContent.get('role') is not None else '') == 'user'
            and not php_empty(lastContent.get('parts'))
            and isinstance(lastContent['parts'][0], dict)
            and lastContent['parts'][0].get('functionResponse') is not None
        )
        isToolResultContinuation = (
            php_empty(newMessage.strip())
            and php_empty(imageAttachments)
            and php_empty(pdfAttachments)
            and lastIsFunctionResponse
        )
        if isToolResultContinuation:
            return contents

        # Build the current user turn. PDFs and images both ride in
        # `inline_data` parts, distinguished by mime_type (Gemini handles both
        # natively from the same shape).
        parts = [{'text': newMessage}]
        for pdf in pdfAttachments:
            parts.append({
                'inline_data': {
                    'mime_type': pdf['mime_type'],
                    'data': pdf['data'],
                },
            })
        for img in imageAttachments:
            parts.append({
                'inline_data': {
                    'mime_type': img['mime_type'],
                    'data': img['data'],
                },
            })
        contents.append({
            'role': 'user',
            'parts': parts,
        })

        return contents

    def _extractTextFromContent(self, content) -> str:
        """Extract text from content (handles string, array, and stdClass formats)."""
        if isinstance(content, str):
            return content

        if isinstance(content, (dict, list)):
            textParts = []
            blocks = content.values() if isinstance(content, dict) else content
            for block in blocks:
                if isinstance(block, dict) and block.get('text') is not None:
                    textParts.append(block['text'])
                elif isinstance(block, str):
                    textParts.append(block)
            return "\n".join(textParts)

        return ''

    def _convertToGeminiTools(self, claudeTools: list) -> list:
        functions = []

        for tool in claudeTools:
            inputSchema = tool.get('input_schema') if tool.get('input_schema') is not None else {'type': 'object', 'properties': {}}

            # Fix and validate schema for Gemini
            inputSchema = self.fixSchemaForGemini(inputSchema)

            functions.append({
                'name': tool['name'],
                'description': tool.get('description') if tool.get('description') is not None else '',
                'parameters': inputSchema,
            })

        error_log("[Gemini] Sending " + str(len(functions)) + " tools: " + ', '.join(f['name'] for f in functions))

        # Log first tool schema for debugging
        if not php_empty(functions):
            error_log("[Gemini] First tool schema sample: " + dumps(functions[0]))

        return [{'functionDeclarations': functions}]

    @staticmethod
    def fixSchemaForGemini(schema) -> dict:
        """Fix schema to be valid for Gemini API
        - Removes unsupported fields ($schema, additionalProperties, etc.)
        - Ensures all properties have a type
        - Converts empty schemas to string type

        Note: This method is static to allow use from both instance and static
        contexts. ProviderRequestBuilderMixin also has this method, but the
        class method takes precedence (PHP: class methods win over trait
        methods). Both bodies are identical — PHP:993-1066 vs the trait's
        259-327 — so the override is behaviour-preserving either way.
        """
        # Empty or non-array schema defaults to string. (PHP also accepts list
        # arrays here; a JSON-Schema node is always an object in practice.)
        if not isinstance(schema, dict) or php_empty(schema):
            return {'type': 'string'}

        schema = dict(schema)  # PHP arrays are value types — don't mutate the caller's dict

        # Remove fields not supported by Gemini
        unsupportedFields = [
            '$schema', '$id', '$ref', '$defs', 'additionalProperties',
            'definitions', 'examples', 'default', 'const', 'title', 'format',
            'nullable', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs',
            'xml', 'discriminator', 'minLength', 'maxLength', 'pattern',
            'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
            'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
        ]
        for field in unsupportedFields:
            schema.pop(field, None)

        # Ensure type exists
        if schema.get('type') is None:
            schema['type'] = 'string'

        # Convert enum to description (Gemini can be picky about enum)
        if schema.get('enum') is not None and isinstance(schema['enum'], (dict, list)):
            enumList = list(schema['enum'].values()) if isinstance(schema['enum'], dict) else schema['enum']
            enumValues = ', '.join(php_strval(v) for v in enumList)
            desc = schema.get('description') if schema.get('description') is not None else ''
            schema['description'] = (desc + " Allowed values: " + enumValues).strip()
            del schema['enum']

        # Fix properties recursively
        if schema.get('properties') is not None:
            props = schema['properties']

            if isinstance(props, (dict, list)) and not php_empty(props):
                fixedProps = {}
                propItems = props.items() if isinstance(props, dict) else enumerate(props)
                for propName, propSchema in propItems:
                    # Recursively fix each property schema
                    fixedProps[propName] = GeminiProvider.fixSchemaForGemini(propSchema)
                schema['properties'] = fixedProps
            else:
                # Empty properties
                schema['properties'] = {}
        elif schema['type'] == 'object':
            schema['properties'] = {}

        # Fix items for array type
        if schema.get('items') is not None:
            schema['items'] = GeminiProvider.fixSchemaForGemini(schema['items'])
        elif schema['type'] == 'array':
            schema['items'] = {'type': 'string'}

        # Remove empty required arrays
        if schema.get('required') is not None and php_empty(schema['required']):
            del schema['required']

        return schema

    def _getTools(self) -> list:
        if not self.functionExecutor:
            return []

        return self.functionExecutor.getToolDefinitions()

    def getContextWindow(self) -> int:
        # Gemini 2.5/3 Flash and Pro: 1M input context window
        return 1000000

    def getDefaultSystemPrompt(self) -> str:
        """PHP declares this `private`, but ProviderRequestBuilderTrait's
        buildSystemPrompt() calls `$this->getDefaultSystemPrompt()` from
        inside the class scope. Python mixins have no such scoping, so the
        name stays public here — same deviation as the 2a ClaudeProvider port.
        """
        # First, check if there's a custom system_prompt in config
        customPrompt = self.config.get('providers.gemini.system_prompt')
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
            self.sseClient.sendProgress(f"Gemini: {message}")
        # PHP also ob_flush()/flush()es here to push the SSE frame out ahead of
        # the blocking API call; the ASGI stack has no output buffer to flush.

    def _trackUsage(self, userId, inputTokens: int, outputTokens: int, functionCallCount: int, responseTimeMs: int) -> None:
        if self.usageTracker:
            self.usageTracker.trackRequest({
                'user_id': userId,
                'provider': 'gemini',
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
        """Build an HTTP request for Gemini API (static method for parallel execution).

        Returns a dict with keys: url, headers, payload, provider.
        """
        apiKey = config.get('api_key') if config.get('api_key') is not None else ''

        # Convert messages to Gemini format
        systemInstruction = None
        contents = []

        for msg in messages:
            if msg['role'] == 'system':
                systemInstruction = {'parts': [{'text': msg['content']}]}
            elif msg['role'] == 'user':
                contents.append({'role': 'user', 'parts': [{'text': msg['content']}]})
            elif msg['role'] == 'assistant':
                if not php_empty(msg.get('tool_calls')):
                    # Gemini uses functionCall in model response
                    parts = []
                    if not php_empty(msg.get('content')):
                        parts.append({'text': msg['content']})
                    for tc in msg['tool_calls']:
                        tcFunction = tc.get('function') if isinstance(tc.get('function'), dict) else {}
                        rawArgs = tcFunction.get('arguments') if tcFunction.get('arguments') is not None else ''
                        if isinstance(rawArgs, str):
                            decoded = _json_decode(rawArgs)
                            args = decoded if decoded is not None else []
                        else:
                            args = tcFunction.get('arguments') if tcFunction.get('arguments') is not None else []
                        part = {
                            'functionCall': {
                                'name': tcFunction.get('name') if tcFunction.get('name') is not None else tc['name'],
                                'args': _to_object(args),
                            },
                        }
                        # Include thoughtSignature if present (required for Gemini 2.5+)
                        if tc.get('thought_signature') is not None:
                            part['thoughtSignature'] = tc['thought_signature']
                        parts.append(part)
                    contents.append({'role': 'model', 'parts': parts})
                else:
                    contents.append({
                        'role': 'model',
                        'parts': [{'text': msg.get('content') if msg.get('content') is not None else ''}],
                    })
            elif msg['role'] == 'tool':
                # Gemini uses functionResponse with role 'tool'
                contents.append({
                    'role': 'tool',
                    'parts': [
                        {
                            'functionResponse': {
                                'name': msg.get('name') if msg.get('name') is not None else 'function',
                                'response': {'result': msg['content']},
                            },
                        },
                    ],
                })

        payload = {
            'contents': contents,
            'generationConfig': {
                'temperature': temperature,
                'maxOutputTokens': maxTokens,
            },
        }

        if systemInstruction:
            payload['systemInstruction'] = systemInstruction

        # Add tools in Gemini format
        if not php_empty(tools):
            payload['tools'] = GeminiProvider.convertToolsToGeminiFormat(tools)

        # Base URL should include /v1beta
        baseUrl = config['base_url'].rstrip('/') if not php_empty(config.get('base_url')) else 'https://generativelanguage.googleapis.com/v1beta'

        # If base_url doesn't include v1beta, add it
        if baseUrl.find('/v1beta') == -1 and baseUrl.find('/v1') == -1:
            baseUrl += '/v1beta'

        return {
            'url': f"{baseUrl}/models/{model}:generateContent?key={apiKey}",
            'headers': [
                'Content-Type: application/json',
            ],
            'payload': payload,
            'provider': 'gemini',
        }

    @staticmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """Parse Gemini API response (static method for parallel execution).

        Returns a dict with keys: text, tool_calls (OpenAI format), usage (normalized).
        """
        candidate = _first_candidate(decoded)
        content = candidate.get('content') if isinstance(candidate.get('content'), dict) else {}
        parts = content.get('parts') if content.get('parts') is not None else []
        text = ''
        toolCalls = []

        for part in parts:
            if part.get('text') is not None:
                text += part['text']
            elif part.get('functionCall') is not None:
                # Convert to OpenAI-compatible format, preserve thoughtSignature for Gemini 2.5+
                toolCall = {
                    'id': 'call_' + php_uniqid(),
                    'type': 'function',
                    'function': {
                        'name': part['functionCall']['name'],
                        'arguments': dumps(part['functionCall'].get('args') if part['functionCall'].get('args') is not None else []),
                    },
                }
                # Capture thoughtSignature if present (required for Gemini 2.5+)
                if part.get('thoughtSignature') is not None:
                    toolCall['thought_signature'] = part['thoughtSignature']
                toolCalls.append(toolCall)

        usage = GeminiProvider.normalizeUsage(decoded.get('usageMetadata'), 'gemini')

        return {
            'text': text,
            'tool_calls': toolCalls,
            'usage': usage,
        }

    @staticmethod
    def getApiFamily() -> str:
        """Get the API family for this provider."""
        return 'gemini'
