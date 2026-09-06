# Backend Python Port — Phase 2b (Six remaining LLM providers + ProviderRequestFactory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/v1/chat` on the Python backend work for every provider PHP supports — openai, grok, kimi, deepseek, gemini and the generic OpenAI-compatible `CustomProvider` (gamma4, glm, …) — with the same SSE events, payloads, usage accounting and error messages as PHP, and port `ProviderRequestFactory` so later phases (GraphWorkflowRunner) can build/parse provider requests statically.

**Architecture:** One Python class per PHP provider file under `app/providers/`, each a line-by-line port (same camelCase method names, same private helpers as `_name`), mixing in `ProviderRequestBuilderMixin` + `ClientSideToolsMixin` from 2a and implementing `AIProviderInterface` + `HttpRequestBuilderInterface`. HTTP through a per-instance `httpx.Client` (closed by `close()`, as 2a established). `AIPortfolioAssistant._makeProvider` gets its `DEDICATED_PROVIDERS` map filled and the `CustomProvider(config, name)` branch, so `_initializeDefaultProvider` registers everything `system_llm_settings` enables. `ProviderRequestFactory` is a static registry over the seven classes.

**Tech Stack:** Python 3.13, httpx (+ `MockTransport` and recorded stream fixtures in tests), pytest; live differential against the PHP backend for every configured provider.

**Spec:** `docs/superpowers/specs/2026-09-06-backend-python-phase2-chat-design.md` (§2 row 2b, §4 providers, §6 testing) under the umbrella `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§3 conventions bind).

## Global Constraints

- Everything from the Phase 1 and Phase 2a plans' Global Constraints still applies (Python 3.13, venv, port 3002, PHP timezone via `PHP_TIMEZONE`, clean JSON, no runtime DDL, commit trailer, controllers return dicts, SSE framing byte-identical, provider result dict key order `text, usage{input_tokens,output_tokens,total_tokens,function_calls}, model, provider, functions_called, mcp_tools_called, mcp_calls_count[, pending_client_tool_call, pending_tool_calls]`).
- **PHP-semantics helpers are mandatory:** `php_empty()` for `empty()`, `v if v is not None else d` for `??`, `php_intval()` for `(int)`, `is_numeric()`, dict-or-list for `is_array()`, `ucfirst()` from `app.support.phpcompat` for `ucfirst()`.
- **Progress strings verbatim.** Each provider's `sendProgress(msg)` emits `"<Label>: <msg>"` through `self.sseClient.sendProgress` when an SSE client is set. Labels and messages (from the PHP sources):
  - OpenAI (`OpenAI: `): `Preparing OpenAI request...`, `Connecting to OpenAI API...`, `Thinking...` (streaming only), `Processing tool calls...`, `Executing function: {name}`, `Processing OpenAI response...`, `Response ready.`
  - Grok (`Grok: `): `Preparing request...`, `Connecting to xAI API...`, `Thinking...`, `Processing tool calls...`, `Executing function: {name}`, `Processing response...`, `Response ready.`
  - Kimi (`Kimi: `): `Preparing request...`, `Connecting to Kimi API...`, `Thinking...`, `Processing tool calls...`, `Executing function: {name}`, `Processing response...`, `Response ready.`
  - DeepSeek (`DeepSeek: `): `Preparing request...`, `Connecting to DeepSeek API...`, `Thinking...`, `Processing tool calls...`, `Executing function: {name}`, `Processing response...`, `Response ready.`
  - Gemini (`Gemini: `): `Preparing Gemini request...`, `Connecting to Gemini API...`, `Processing function calls...`, `Executing function: {name}`, `Processing Gemini response...`, `Response ready.`
  - Custom (`{displayName}: `): `Preparing {displayName} request...`, `Connecting to {displayName} API...`, `Thinking...`, `Processing tool calls...`, `Executing function: {name}`, `Processing {displayName} response...`, `Response ready.`
- **Exceptions:** only the three `ProviderException` factories from 2a (`apiError(provider, message, status)`, `rateLimited(provider)`, `authenticationFailed(provider)`), raised at the same sites and with the same message arguments as the PHP file (e.g. Grok's stream error is `apiError('grok', "Stream error: {msg}", 500)`; Kimi's non-2xx is `apiError('kimi', detailMsg, status)` where `detailMsg` is built exactly as PHP lines 352–363 build it). `humanizeProviderError` in the controller pattern-matches on these messages, so they reach the wire.
- **PHP constants stay constants.** Grok (`https://api.x.ai`, `/v1/chat/completions`), Kimi (`https://api.moonshot.ai`, `/v1/chat/completions`) and DeepSeek (`https://api.deepseek.com`, `/chat/completions`) hardcode `BASE_URL`/`CHAT_ENDPOINT`; a `base_url` in their `system_llm_settings` row is IGNORED by PHP and must be ignored here too (the TS port broke by reading it — see memory "TS provider parity defaults"). OpenAI reads `openai.base_url` (default `https://api.openai.com`, endpoint `/v1/chat/completions`), Gemini reads `providers.gemini.base_url` (default `https://generativelanguage.googleapis.com/v1beta`), Custom reads `providers.<name>.base_url` + `chat_endpoint` (default `/chat/completions`).
- **Config sources:** OpenAI reads the ROOT block `config.get('openai', {})`; grok/kimi/deepseek/gemini/custom read `config.get('providers.<name>', {})`. Defaults verbatim from each PHP constructor (listed per task). `Configuration.get` supports dot paths.
- **Streaming contract, OpenAI-compatible family:** request body carries `stream: true` and `stream_options: {include_usage: true}` exactly where PHP adds it; the response is read with `self.httpClient.stream('POST', endpoint, headers=..., content=json_payload)` + `iter_bytes(1024)` into a buffer split on `"\n"`, each `data: ` line JSON-decoded, `[DONE]` ends the loop, `delta.content` → `self.sseClient.sendChunk(text)` and accumulates `fullText`, `delta.tool_calls` fragments are merged by `index` into the assistant `tool_calls` list, a chunk `usage` object becomes `usageData`, `finish_reason` triggers `emitUsageWarningIfTruncated`. The reassembled `streamResponse` has the non-streaming shape (`choices[0].message{content, tool_calls}`, `usage`) so the tool loop is shared.
- **Gemini does not stream:** `streamChat` calls `chat()` then `onChunk(result['text'])` once — mirrored exactly (spec §4).
- **Tool loop:** each OpenAI-compatible provider's `handleToolCallsRecursive` mirrors PHP: assistant message with `tool_calls` appended, one `{'role': 'tool', 'tool_call_id': id, 'content': json}` per call, client-side tools short-circuit through `ClientSideToolsMixin.emitClientToolCallEvent` and return `pending_client_tool_call`/`pending_tool_calls`, `maxRecursionDepth` (config `max_recursion_depth`, default 10) caps recursion. Reference accumulators travel in the shared `_Totals` carrier (Task 1 moves it to `app/providers/totals.py`).
- **HTTP errors:** `response.raise_for_status()`; `httpx.HTTPStatusError` → status from `e.response.status_code`, mapped `429 → rateLimited`, `401 → authenticationFailed`, else `apiError(provider, <message as PHP builds it>, status)`; `httpx.RequestError` → `apiError(provider, str(e), 0)` where PHP's `GuzzleException` catch would have produced code 0/`getCode()`. Log-only text may differ; wire-visible messages may not.
- **`close()`** on every provider closes `self.httpClient` (Python-only, comment says so); `LLMManager.close()` already walks providers by identity.
- Tests: unit per class with `httpx.MockTransport`; shared fixtures under `tests/fixtures/`; the `Rec` recording SSE client from `tests/unit/test_claude_provider.py` is copied verbatim into each new test file (tests are read in isolation). Differential (Task 9) against PHP at `http://localhost/gpt/backend`, user 3, prompt `Reply with exactly: hello world`, `tools: []`, `memory: false`; skip a provider when its `system_llm_settings` row is missing/disabled/without key. Live cases run ONCE per full run (they cost real API calls).
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Work from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` with `.venv/bin/python -m pytest`; commit from the repo root with `git add backend_python` (plus the named docs files in Task 9). A uvicorn `--reload` server runs on :3002 from this tree — never start or stop servers.

## Porting rules (read before any "port verbatim" step)

Each "port" step names the PHP file and line range. Translate line by line:

| PHP | Python |
|---|---|
| `$x['k'] ?? d` | `x.get('k') if x.get('k') is not None else d` |
| `isset($x['k'])` | `x.get('k') is not None` |
| `empty($v)` / `!empty($v)` | `php_empty(v)` / `not php_empty(v)` |
| `(int) $v` / `(float) $v` | `php_intval(v)` / `float(v)` guarded by `is_numeric` |
| `is_array($v)` / `is_string($v)` | `isinstance(v, (dict, list))` / `isinstance(v, str)` |
| `json_encode($v)` (any flags) | `phpjson.dumps(v)` |
| `json_decode($s, true)` | `json.loads(s)` in `try/except ValueError → None` |
| `array_merge` (assoc / list) | `{**a, **b}` / `a + b` |
| `array_values($x)` | `list(x.values())` if dict else `list(x)` |
| `rtrim($s, '/')` | `s.rstrip('/')` |
| `ucfirst($s)` | `ucfirst(s)` (phpcompat) |
| `microtime(true)` | `time.time()` |
| `error_log(...)` | `error_log(...)` from `app.support.logger` (keep the text) |
| `$this->sseClient?->x()` | `if self.sseClient: self.sseClient.x()` |
| `$this->logger?->x()` | `if self.logger: self.logger.x()` |
| `throw ProviderException::apiError(...)` | `raise ProviderException.apiError(...)` |
| `catch (GuzzleException $e)` | `except httpx.HTTPStatusError as e` (status = `e.response.status_code`, body = `e.response.text`) then `except httpx.RequestError as e` (status 0) |
| `$response->getBody()->getContents()` / `json_decode(...)` | `response.json()` guarded → `None` on invalid JSON |
| `while (!$body->eof()) { $chunk = $body->read(1024); ... }` | `for chunkBytes in response.iter_bytes(1024): buffer += decoder.decode(chunkBytes)` with `codecs.getincrementaldecoder('utf-8')(errors='replace')` |
| `&$var` accumulators | `_Totals` instance (see Task 1) |

Keep PHP method names (camelCase); `private` PHP methods become `_name`; `protected` stay public-named (mixin overrides like `getContextWindow`); static methods `@staticmethod`.

---

### Task 1: `OpenAIProvider` (+ shared `_Totals` carrier, OpenAI-compatible stream fixtures)

**Files:**
- Create: `app/providers/totals.py`, `app/providers/openai_provider.py`
- Modify: `app/providers/claude_provider.py` (import `_Totals` from `app.providers.totals`; delete the local dataclass — nothing else changes)
- Test: `tests/unit/test_openai_provider.py`; fixtures `tests/fixtures/openai_stream_text.sse`, `tests/fixtures/openai_stream_tool.sse`

**Interfaces:**
- `app/providers/totals.py` exports `@dataclass class _Totals` with fields `inputTokens: int = 0`, `outputTokens: int = 0`, `functionCallCount: int = 0`, `functionsCalled: list`, `mcpToolsCalled: list` (default factories) — identical to the 2a dataclass in `claude_provider.py:37-49`. Tasks 2–6 import it.
- Static builders return `{'url', 'headers', 'payload', 'provider'}` where `headers` is a LIST of `"Name: value"` strings (curl style, as `ClaudeProvider.buildHttpRequest` does) — not a dict.
- `OpenAIProvider(config: Configuration)` implements `AIProviderInterface`, `HttpRequestBuilderInterface`, mixes in `ProviderRequestBuilderMixin`, `ClientSideToolsMixin`. Public: `close`, `setFunctionExecutor`, `setUsageTracker`, `setSSEClient`, `setLogger`, `getName()->'openai'`, `isAvailable`, `getModel`, `setModel`, `getSupportedModels`, `chat(message, conversationHistory=None, options=None)`, `streamChat(message, onChunk, conversationHistory=None, options=None)`, static `buildHttpRequest(model, messages, tools, config, maxTokens, temperature)`, `parseHttpResponse(decoded)`, `getApiFamily()->'openai'`. Private (PHP `private`): `_makeRequest`, `_handleStreamingResponse`, `_handleToolCallsRecursive`, `_executeFunction`, `_hasToolCalls`, `_extractTextResponse`, `_buildMessages`, `_extractTextFromContent`, `_convertToOpenAITools`, `_getTools`, `_getDefaultSystemPrompt`, `_sendProgress`, `_trackUsage`; `getContextWindow` (protected in PHP) stays public.
- Constructor defaults (PHP `OpenAIProvider.php:64-83`): block `config.get('openai', {})`; `model` default `'gpt-4-turbo-preview'`; `max_tokens` 4096; `temperature` 0.7; `base_url` default `'https://api.openai.com'` (rstrip `/`); `maxRecursionDepth = config.get('max_recursion_depth', 10)`; `httpx.Client(base_url=self.baseUrl, timeout=600)`; `DebugLogger(True)` when `config.isDebugEnabled()`. `pendingOutputSchema = None`, `pendingStreaming = True` as PHP declares.

- [ ] **Step 1: Move `_Totals` and add the fixtures**

Create `app/providers/totals.py` with the dataclass copied from `claude_provider.py:37-49` (module docstring: "Carrier for PHP by-reference accumulators shared by every provider's recursive tool loop."). In `claude_provider.py` replace the local class with `from app.providers.totals import _Totals`. Run `.venv/bin/python -m pytest -q tests/unit/test_claude_provider.py` → still passes.

`tests/fixtures/openai_stream_text.sse`:
```
data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}

data: [DONE]

```

`tests/fixtures/openai_stream_tool.sse`:
```
data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"x\":"}}]},"finish_reason":null}]}

data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"1\"}"}}]},"finish_reason":null}]}

data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"c2","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9,"total_tokens":29}}

data: [DONE]

```

- [ ] **Step 2: Write the failing tests**

`tests/unit/test_openai_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.openai_provider import OpenAIProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, streaming=True, key='K'):
    p = OpenAIProvider(Configuration({'openai': {'api_key': key, 'streaming': streaming, 'max_tokens': 100}}))
    p.httpClient = httpx.Client(base_url='https://api.openai.com', transport=httpx.MockTransport(handler))
    return p


def _sse(body: bytes):
    return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})


def test_basics_and_defaults():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'openai' and p.isAvailable() and p.getModel() == 'gpt-4-turbo-preview'
    assert p.getApiFamily() == 'openai' and p.getSupportedModels()
    assert not _provider(lambda r: None, key='').isAvailable()
    assert p.setModel('gpt-4o').getModel() == 'gpt-4o'
    p.close(); assert p.httpClient.is_closed


def test_chat_non_streaming_payload_headers_and_result():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content); seen['path'] = req.url.path
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'hi there'}, 'finish_reason': 'stop'}],
                                         'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7}, 'model': 'gpt-4-turbo-preview'})
    p = _provider(handler, streaming=False); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}], {'user_id': 3, 'system_prompt': 'SYS'})
    assert out == {'text': 'hi there', 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}, 'model': 'gpt-4-turbo-preview',
                   'provider': 'openai', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert seen['path'] == '/v1/chat/completions' and seen['h']['authorization'] == 'Bearer K'
    b = seen['b']
    assert b['model'] == 'gpt-4-turbo-preview' and b['max_tokens'] == 100 and b.get('stream') in (None, False)
    assert b['messages'][0]['role'] == 'system' and b['messages'][0]['content'].endswith('SYS')
    assert b['messages'][1:] == [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}, {'role': 'user', 'content': 'hello'}]
    assert 'tools' not in b
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'OpenAI: Preparing OpenAI request...'), ('progress', 'OpenAI: Connecting to OpenAI API...'), ('progress', 'OpenAI: Response ready.')]


def test_stream_chat_emits_chunks_and_usage():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); return _sse((FIX / 'openai_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('hello', lambda t: None, [], {'user_id': 3})
    assert seen['b']['stream'] is True and seen['b']['stream_options'] == {'include_usage': True}
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')]
    assert out['text'] == 'hello world' and out['usage'] == {'input_tokens': 12, 'output_tokens': 5, 'total_tokens': 17, 'function_calls': 0}
    assert ('progress', 'OpenAI: Thinking...') in rec.events and rec.events[-1] == ('progress', 'OpenAI: Response ready.')


def test_tool_loop_executes_function_and_continues():
    calls = []
    def handler(req):
        body = json.loads(req.content); calls.append(body)
        if len(calls) == 1:
            return _sse((FIX / 'openai_stream_tool.sse').read_bytes())
        return _sse((FIX / 'openai_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert len(calls) == 2
    assert calls[0]['tools'] == [{'type': 'function', 'function': {'name': 'echo', 'description': 'd', 'parameters': {'type': 'object', 'properties': {'x': {'type': 'string'}}}}}]
    tail = calls[1]['messages'][-2:]
    assert tail[0]['role'] == 'assistant' and tail[0]['tool_calls'][0]['function'] == {'name': 'echo', 'arguments': '{"x":"1"}'}
    assert tail[1]['role'] == 'tool' and tail[1]['tool_call_id'] == 'call_1' and json.loads(tail[1]['content']) == {'echoed': {'x': '1'}}
    assert out['text'] == 'hello world' and out['usage']['function_calls'] == 1 and out['functions_called'] == ['echo']
    assert out['usage']['input_tokens'] == 32 and out['usage']['output_tokens'] == 14      # 20+12, 9+5
    names = [m for _, m in rec.events if _ == 'progress']
    assert 'OpenAI: Processing tool calls...' in names and 'OpenAI: Executing function: echo' in names and 'OpenAI: Processing OpenAI response...' in names


def test_client_tool_short_circuit():
    p = _provider(lambda r: _sse((FIX / 'openai_stream_tool.sse').read_bytes())); rec = Rec(); p.setSSEClient(rec)
    p.setPerRequestClientSideToolNames(['echo'])
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert out['pending_client_tool_call'] and out['pending_tool_calls'][0]['name'] == 'echo'
    assert any(e[0] == 'client_tool_call' for e in rec.events)


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('openai')), (401, lambda: ProviderException.authenticationFailed('openai'))])
def test_http_errors_map_to_php_messages(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_server_error_is_api_error_with_status():
    p = _provider(lambda r: httpx.Response(503, text='Service Unavailable'), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value).startswith('openai API error: ') and ei.value.getHttpStatusCode() == 503


def test_missing_key_is_authentication_failed_before_any_request():
    hits = []
    p = _provider(lambda r: hits.append(1) or httpx.Response(200, json={}), streaming=False, key='')
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(ProviderException.authenticationFailed('openai')) and hits == []


def test_static_builder_and_parser():
    r = OpenAIProvider.buildHttpRequest('gpt-4o', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'].endswith('/v1/chat/completions') and 'Authorization: Bearer K' in r['headers'] and r['payload']['model'] == 'gpt-4o' and r['payload']['max_tokens'] == 50
    parsed = OpenAIProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo', 'tool_calls': []}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2}})
    assert parsed['text'] == 'yo' and parsed['tool_calls'] == [] and parsed['usage']['prompt_tokens'] == 1
```

- [ ] **Step 3: Run to verify failure**

Run: `.venv/bin/python -m pytest -q tests/unit/test_openai_provider.py`
Expected: FAIL with `ModuleNotFoundError: app.providers.openai_provider`.

- [ ] **Step 4: Port `OpenAIProvider.php` verbatim**

Port `backend/src/Providers/OpenAIProvider.php` lines 22–1009 into `app/providers/openai_provider.py` following the porting rules; module docstring names the PHP source. Class header:

```python
class OpenAIProvider(ProviderRequestBuilderMixin, ClientSideToolsMixin, AIProviderInterface, HttpRequestBuilderInterface):
    """Port of backend/src/Providers/OpenAIProvider.php."""
```

Constructor per the Interfaces block; call `self._init_client_side_tools()` (2a mixin contract, see `claude_provider.py:93-125`). Streaming: `with self.httpClient.stream('POST', '/v1/chat/completions', headers=..., content=dumps(payload)) as response:` → `response.raise_for_status()` inside the `with` (read `response.read()` before mapping the error so the body is available, as `claude_provider.py:753-777` does), then `_handleStreamingResponse(response)` iterating `response.iter_bytes(1024)`. Missing API key raises `authenticationFailed('openai')` before any request (PHP line 298). Any assertion in Step 2 that PHP demonstrably contradicts is a plan defect: report it as DONE_WITH_CONCERNS with the PHP line, do not bend the port.

- [ ] **Step 5: Run to verify pass**

Run: `.venv/bin/python -m pytest -q tests/unit/test_openai_provider.py tests/unit/test_claude_provider.py`
Expected: all PASS, no warnings.

- [ ] **Step 6: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): OpenAIProvider + shared _Totals carrier + OpenAI-compatible stream fixtures"
```

---

### Task 2: `GrokProvider`

**Files:**
- Create: `app/providers/grok_provider.py`
- Test: `tests/unit/test_grok_provider.py` (reuses `tests/fixtures/openai_stream_text.sse` / `openai_stream_tool.sse` from Task 1)

**Interfaces:**
- Consumes `_Totals` from `app.providers.totals`, both mixins, the two contracts, `ProviderException`.
- `GrokProvider(config)`; constants `BASE_URL = 'https://api.x.ai'`, `CHAT_ENDPOINT = '/v1/chat/completions'`; block `config.get('providers.grok', {})`; defaults (PHP `GrokProvider.php:49-73`): `display_name` `'Grok'`, `model` `'grok-4-1-fast-reasoning'`, `max_tokens` 16384, `temperature` 0.7, `api_key` `''`, `supported_models` `[model]`, `streaming` True; `httpx.Client(base_url=BASE_URL, timeout=600)`. Public adds `getDisplayName()`. Same method inventory as Task 1 plus `_convertToXAITools` (instance) and static `_convertToolsForXAI` (PHP private static line 1024). `_makeRequest(messages, tools=[], streaming=False, toolChoice='auto')` — note the `streaming` flag position (PHP line 252).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_grok_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.grok_provider import GrokProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, streaming=True, key='K', extra=None):
    cfg = {'api_key': key, 'streaming': streaming, 'max_tokens': 100, **(extra or {})}
    p = GrokProvider(Configuration({'providers': {'grok': cfg}}))
    p.httpClient = httpx.Client(base_url='https://api.x.ai', transport=httpx.MockTransport(handler))
    return p


def _sse(body: bytes):
    return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})


def test_basics_and_constants():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'grok' and p.getDisplayName() == 'Grok' and p.getModel() == 'grok-4-1-fast-reasoning' and p.isAvailable()
    assert p.getSupportedModels() == ['grok-4-1-fast-reasoning'] and GrokProvider.getApiFamily() == 'openai'
    assert GrokProvider.BASE_URL == 'https://api.x.ai' and GrokProvider.CHAT_ENDPOINT == '/v1/chat/completions'
    # a base_url in the settings row is ignored, like PHP's constant
    q = GrokProvider(Configuration({'providers': {'grok': {'api_key': 'K', 'base_url': 'https://elsewhere.example'}}}))
    assert str(q.httpClient.base_url).rstrip('/') == 'https://api.x.ai'; q.close()
    assert not _provider(lambda r: None, key='').isAvailable()


def test_chat_non_streaming_payload_and_result():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content); seen['path'] = req.url.path
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'hi there'}, 'finish_reason': 'stop'}],
                                         'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7}})
    p = _provider(handler, streaming=False); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}], {'user_id': 3, 'system_prompt': 'SYS'})
    assert out == {'text': 'hi there', 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}, 'model': 'grok-4-1-fast-reasoning',
                   'provider': 'grok', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert seen['path'] == '/v1/chat/completions' and seen['h']['authorization'] == 'Bearer K'
    b = seen['b']
    assert b['model'] == 'grok-4-1-fast-reasoning' and b['max_tokens'] == 100 and b['messages'][0]['role'] == 'system' and b['messages'][0]['content'].endswith('SYS')
    assert b['messages'][-1] == {'role': 'user', 'content': 'hello'} and 'tools' not in b
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Grok: Preparing request...'), ('progress', 'Grok: Connecting to xAI API...'), ('progress', 'Grok: Response ready.')]


def test_stream_chat_emits_chunks_and_usage():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); return _sse((FIX / 'openai_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('hello', lambda t: None, [], {'user_id': 3})
    assert seen['b']['stream'] is True and seen['b']['stream_options'] == {'include_usage': True}
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')]
    assert out['text'] == 'hello world' and out['usage'] == {'input_tokens': 12, 'output_tokens': 5, 'total_tokens': 17, 'function_calls': 0}
    assert ('progress', 'Grok: Thinking...') in rec.events


def test_tool_loop_and_required_tool_choice():
    calls = []
    def handler(req):
        calls.append(json.loads(req.content))
        return _sse((FIX / ('openai_stream_tool.sse' if len(calls) == 1 else 'openai_stream_text.sse')).read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3, 'tool_choice': 'required'})
    assert len(calls) == 2 and calls[0]['tool_choice'] == 'required' and calls[0]['tools'][0]['function']['name'] == 'echo'
    tail = calls[1]['messages'][-2:]
    assert tail[0]['role'] == 'assistant' and tail[0]['tool_calls'][0]['id'] == 'call_1'
    assert tail[1] == {'role': 'tool', 'tool_call_id': 'call_1', 'content': json.dumps({'echoed': {'x': '1'}}, separators=(',', ':'))} or tail[1]['tool_call_id'] == 'call_1'
    assert out['text'] == 'hello world' and out['functions_called'] == ['echo'] and out['usage']['function_calls'] == 1
    names = [m for k, m in rec.events if k == 'progress']
    assert 'Grok: Processing tool calls...' in names and 'Grok: Executing function: echo' in names and 'Grok: Processing response...' in names


def test_client_tool_short_circuit():
    p = _provider(lambda r: _sse((FIX / 'openai_stream_tool.sse').read_bytes())); rec = Rec(); p.setSSEClient(rec)
    p.setPerRequestClientSideToolNames(['echo'])
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert out['pending_client_tool_call'] and out['pending_tool_calls'][0]['name'] == 'echo'


def test_stream_error_object_raises_api_error():
    body = b'data: {"error":{"message":"boom"}}\n\n'
    p = _provider(lambda r: _sse(body)); p.setSSEClient(Rec())
    with pytest.raises(ProviderException) as ei:
        p.streamChat('x', lambda t: None, [], {'user_id': 3})
    assert str(ei.value) == str(ProviderException.apiError('grok', 'Stream error: boom', 500))


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('grok')), (401, lambda: ProviderException.authenticationFailed('grok'))])
def test_http_errors_map_to_php_messages(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_static_builder_and_parser():
    r = GrokProvider.buildHttpRequest('grok-4-fast', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'] == 'https://api.x.ai/v1/chat/completions' and 'Authorization: Bearer K' in r['headers'] and r['payload']['model'] == 'grok-4-fast'
    parsed = GrokProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2}})
    assert parsed['text'] == 'yo' and parsed['tool_calls'] == []
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_grok_provider.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `GrokProvider.php` verbatim** — `backend/src/Providers/GrokProvider.php` lines 25–1128 into `app/providers/grok_provider.py`. Keep the two error-mapping blocks separate as PHP has them (lines 320–331 map the non-2xx body read inside the try; lines 340–352 map the Guzzle exception). `convertToXAITools`/`convertToolsForXAI` port their schema massaging exactly (they differ from the OpenAI conversion). The `tool_choice` option flows through as PHP does (`$options['tool_choice'] ?? 'auto'`).

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_grok_provider.py` → PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): GrokProvider"
```

---

### Task 3: `KimiProvider`

**Files:**
- Create: `app/providers/kimi_provider.py`
- Test: `tests/unit/test_kimi_provider.py`

**Interfaces:**
- `KimiProvider(config)`; constants `BASE_URL = 'https://api.moonshot.ai'`, `CHAT_ENDPOINT = '/v1/chat/completions'`; block `config.get('providers.kimi', {})`; defaults (PHP `KimiProvider.php:60-84`): `display_name` `'Kimi'`, `model` `'kimi-k2.6'`, `max_tokens` 32768, `temperature` 0.6, `api_key` `''`, `supported_models` `[model]`, `streaming` True. Per-call `thinkingOverride` from `options['thinking']` (`'on'`/`'off'`, else None — PHP lines 157–158) drives `payload['thinking'] = {'type': 'enabled'|'disabled'}` exactly as PHP lines 286–290. Same method inventory as Task 2 (with `_convertToOpenAITools`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_kimi_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.kimi_provider import KimiProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, streaming=True, key='K'):
    p = KimiProvider(Configuration({'providers': {'kimi': {'api_key': key, 'streaming': streaming, 'max_tokens': 100}}}))
    p.httpClient = httpx.Client(base_url='https://api.moonshot.ai', transport=httpx.MockTransport(handler))
    return p


def _sse(body: bytes):
    return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})


def test_basics_and_constants():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'kimi' and p.getDisplayName() == 'Kimi' and p.getModel() == 'kimi-k2.6' and p.isAvailable()
    assert KimiProvider.BASE_URL == 'https://api.moonshot.ai' and KimiProvider.CHAT_ENDPOINT == '/v1/chat/completions' and KimiProvider.getApiFamily() == 'openai'
    assert KimiProvider(Configuration({})).temperature == 0.6 and KimiProvider(Configuration({})).maxTokens == 32768


def test_chat_non_streaming_result_and_progress():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content); seen['path'] = req.url.path
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'hi there'}, 'finish_reason': 'stop'}],
                                         'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7}})
    p = _provider(handler, streaming=False); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [], {'user_id': 3})
    assert out['text'] == 'hi there' and out['provider'] == 'kimi' and out['model'] == 'kimi-k2.6'
    assert out['usage'] == {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}
    assert seen['path'] == '/v1/chat/completions' and seen['h']['authorization'] == 'Bearer K' and seen['b']['model'] == 'kimi-k2.6'
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Kimi: Preparing request...'), ('progress', 'Kimi: Connecting to Kimi API...'), ('progress', 'Kimi: Response ready.')]


@pytest.mark.parametrize('switch,expected', [('on', 'enabled'), ('off', 'disabled')])
def test_thinking_override_shapes_payload(switch, expected):
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
    p = _provider(handler, streaming=False); p.setSSEClient(Rec())
    p.chat('x', [], {'user_id': 3, 'thinking': switch})
    assert seen['b']['thinking'] == {'type': expected}


def test_stream_chat_emits_chunks_and_usage():
    p = _provider(lambda r: _sse((FIX / 'openai_stream_text.sse').read_bytes())); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('hello', lambda t: None, [], {'user_id': 3})
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')]
    assert out['text'] == 'hello world' and out['usage']['input_tokens'] == 12 and out['usage']['output_tokens'] == 5
    assert ('progress', 'Kimi: Thinking...') in rec.events


def test_tool_loop():
    calls = []
    def handler(req):
        calls.append(json.loads(req.content))
        return _sse((FIX / ('openai_stream_tool.sse' if len(calls) == 1 else 'openai_stream_text.sse')).read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert len(calls) == 2 and calls[1]['messages'][-1]['role'] == 'tool' and calls[1]['messages'][-1]['tool_call_id'] == 'call_1'
    assert out['functions_called'] == ['echo'] and out['usage']['function_calls'] == 1 and out['text'] == 'hello world'
    assert ('progress', 'Kimi: Executing function: echo') in rec.events and ('progress', 'Kimi: Processing response...') in rec.events


def test_client_tool_short_circuit():
    p = _provider(lambda r: _sse((FIX / 'openai_stream_tool.sse').read_bytes())); p.setSSEClient(Rec())
    p.setPerRequestClientSideToolNames(['echo'])
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert out['pending_client_tool_call'] and out['pending_tool_calls'][0]['name'] == 'echo'


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('kimi')), (401, lambda: ProviderException.authenticationFailed('kimi'))])
def test_http_errors_map_to_php_messages(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_server_error_detail_message_carries_status_and_body():
    p = _provider(lambda r: httpx.Response(500, json={'error': {'message': 'kaput'}}), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value).startswith('kimi API error: ') and 'kaput' in str(ei.value) and ei.value.getHttpStatusCode() == 500


def test_static_builder_and_parser():
    r = KimiProvider.buildHttpRequest('kimi-k2.6', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'] == 'https://api.moonshot.ai/v1/chat/completions' and r['payload']['thinking'] == {'type': 'disabled'}
    assert KimiProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo'}}], 'usage': {}})['text'] == 'yo'
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_kimi_provider.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `KimiProvider.php` verbatim** — `backend/src/Providers/KimiProvider.php` lines 33–928 into `app/providers/kimi_provider.py`. The `detailMsg` for non-2xx (PHP ~352–363) is built exactly as PHP builds it (status + decoded error message/body excerpt); `test_server_error_detail_message_carries_status_and_body` only checks prefix, body text and status, so the exact PHP string wins.

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_kimi_provider.py` → PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): KimiProvider"
```

---

### Task 4: `DeepSeekProvider`

**Files:**
- Create: `app/providers/deepseek_provider.py`
- Test: `tests/unit/test_deepseek_provider.py`; fixture `tests/fixtures/deepseek_stream_reasoning.sse`

**Interfaces:**
- `DeepSeekProvider(config)`; constants `BASE_URL = 'https://api.deepseek.com'`, `CHAT_ENDPOINT = '/chat/completions'`; block `config.get('providers.deepseek', {})`; defaults (PHP `DeepSeekProvider.php:66-90`): `display_name` `'DeepSeek'`, `model` `'deepseek-v4-pro'`, `max_tokens` 8192, `temperature` 0.7, `api_key` `''`, `supported_models` `[model]`, `streaming` True. Per-call `disableThinkingForThisCall` (PHP 173–177): `options['thinking'] == 'off'` OR (`!= 'on'` AND `not php_empty(options['skill_metadata'])`) → `payload['thinking'] = {'type': 'disabled'}`, otherwise `{'type': 'enabled'}` and, in thinking mode, the sampling params PHP omits (`temperature`, `top_p`, `presence_penalty`, `frequency_penalty` — PHP comment lines 26–29 and the payload block ~316–345) are omitted. `reasoning_content` deltas accumulate into `choices[0].message.reasoning_content` of the reassembled stream response (PHP 437–438, 493–494); `assistant_reasoning` appears in the result when the tool loop had reasoning (PHP 552–554) and in the pending-client-tool branch (PHP 246); `_extractTextResponse` falls back to `reasoning_content` when `content` is empty (PHP 662–676); history round-trips `reasoning_content` on assistant messages (PHP 731).

- [ ] **Step 1: Write fixture and failing tests**

`tests/fixtures/deepseek_stream_reasoning.sse`:
```
data: {"id":"d1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"Let me think. "},"finish_reason":null}]}

data: {"id":"d1","choices":[{"index":0,"delta":{"reasoning_content":"Easy."},"finish_reason":null}]}

data: {"id":"d1","choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}

data: {"id":"d1","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}

data: {"id":"d1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"d1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}

data: [DONE]

```

`tests/unit/test_deepseek_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.deepseek_provider import DeepSeekProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, streaming=True, key='K'):
    p = DeepSeekProvider(Configuration({'providers': {'deepseek': {'api_key': key, 'streaming': streaming, 'max_tokens': 100}}}))
    p.httpClient = httpx.Client(base_url='https://api.deepseek.com', transport=httpx.MockTransport(handler))
    return p


def _sse(body: bytes):
    return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})


def test_basics_and_constants():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'deepseek' and p.getDisplayName() == 'DeepSeek' and p.getModel() == 'deepseek-v4-pro' and p.isAvailable()
    assert DeepSeekProvider.BASE_URL == 'https://api.deepseek.com' and DeepSeekProvider.CHAT_ENDPOINT == '/chat/completions' and DeepSeekProvider.getApiFamily() == 'openai'
    d = DeepSeekProvider(Configuration({})); assert d.maxTokens == 8192 and d.temperature == 0.7; d.close()


def test_thinking_enabled_by_default_omits_sampling_params():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); seen['path'] = req.url.path
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
    p = _provider(handler, streaming=False); p.setSSEClient(Rec())
    p.chat('x', [], {'user_id': 3})
    assert seen['path'] == '/chat/completions' and seen['b']['thinking'] == {'type': 'enabled'} and 'temperature' not in seen['b']


@pytest.mark.parametrize('options', [{'thinking': 'off'}, {'skill_metadata': {'dir_name': 'docx'}}])
def test_thinking_disabled_by_switch_or_skill_turn(options):
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
    p = _provider(handler, streaming=False); p.setSSEClient(Rec())
    p.chat('x', [], {'user_id': 3, **options})
    assert seen['b']['thinking'] == {'type': 'disabled'}


def test_chat_non_streaming_result_and_progress():
    p = _provider(lambda r: httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'hi there'}, 'finish_reason': 'stop'}],
                                                      'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7}}), streaming=False)
    rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [], {'user_id': 3})
    assert out['text'] == 'hi there' and out['provider'] == 'deepseek' and out['usage'] == {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'DeepSeek: Preparing request...'), ('progress', 'DeepSeek: Connecting to DeepSeek API...'), ('progress', 'DeepSeek: Response ready.')]


def test_reasoning_stream_keeps_text_and_usage():
    p = _provider(lambda r: _sse((FIX / 'deepseek_stream_reasoning.sse').read_bytes())); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('hello', lambda t: None, [], {'user_id': 3})
    assert out['text'] == 'hello world' and out['usage']['input_tokens'] == 12 and out['usage']['output_tokens'] == 5
    assert ''.join(t for k, t in rec.events if k == 'chunk').endswith('hello world')
    assert ('progress', 'DeepSeek: Thinking...') in rec.events


def test_reasoning_only_response_falls_back_to_reasoning_text():
    p = _provider(lambda r: httpx.Response(200, json={'choices': [{'message': {'content': '', 'reasoning_content': 'deep thoughts'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}), streaming=False)
    p.setSSEClient(Rec())
    assert p.chat('x', [], {'user_id': 3})['text'] == 'deep thoughts'


def test_tool_loop_round_trips_reasoning_and_tool_results():
    calls = []
    tool_stream = (FIX / 'openai_stream_tool.sse').read_bytes()
    def handler(req):
        calls.append(json.loads(req.content))
        return _sse(tool_stream if len(calls) == 1 else (FIX / 'openai_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert len(calls) == 2 and calls[1]['messages'][-1]['role'] == 'tool' and calls[1]['messages'][-1]['tool_call_id'] == 'call_1'
    assert out['text'] == 'hello world' and out['functions_called'] == ['echo']
    assert ('progress', 'DeepSeek: Executing function: echo') in rec.events and ('progress', 'DeepSeek: Processing response...') in rec.events


def test_history_round_trips_reasoning_content():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
    p = _provider(handler, streaming=False); p.setSSEClient(Rec())
    p.chat('next', [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a', 'reasoning_content': 'why'}], {'user_id': 3})
    assistant = [m for m in seen['b']['messages'] if m['role'] == 'assistant'][0]
    assert assistant['reasoning_content'] == 'why'


def test_client_tool_short_circuit():
    p = _provider(lambda r: _sse((FIX / 'openai_stream_tool.sse').read_bytes())); p.setSSEClient(Rec())
    p.setPerRequestClientSideToolNames(['echo'])
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert out['pending_client_tool_call'] and out['pending_tool_calls'][0]['name'] == 'echo' and 'assistant_reasoning' in out


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('deepseek')), (401, lambda: ProviderException.authenticationFailed('deepseek'))])
def test_http_errors_map_to_php_messages(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}), streaming=False)
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_static_builder_and_parser():
    r = DeepSeekProvider.buildHttpRequest('deepseek-v4-flash', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'] == 'https://api.deepseek.com/chat/completions' and r['payload']['thinking'] == {'type': 'enabled'}
    parsed = DeepSeekProvider.parseHttpResponse({'choices': [{'message': {'content': '', 'reasoning_content': 'r'}}], 'usage': {}})
    assert parsed['text'] == 'r'
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_deepseek_provider.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `DeepSeekProvider.php` verbatim** — `backend/src/Providers/DeepSeekProvider.php` lines 33–953 into `app/providers/deepseek_provider.py`. Whether reasoning deltas are also emitted as `chunk` events is whatever PHP lines 430–460 do — the test only asserts the chunk concatenation ENDS with the content text, so either behavior passes; do not add or remove emission.

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_deepseek_provider.py` → PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): DeepSeekProvider with reasoning_content handling"
```

---

### Task 5: `GeminiProvider`

**Files:**
- Create: `app/providers/gemini_provider.py`
- Test: `tests/unit/test_gemini_provider.py`

**Interfaces:**
- `GeminiProvider(config)`; block `config.get('providers.gemini', {})`; defaults (PHP `GeminiProvider.php:74-96`): `model` `'gemini-2.5-flash'`, `max_tokens` 4096, `temperature` 0.7, `base_url` `'https://generativelanguage.googleapis.com/v1beta'` (rstrip `/`), `api_key` `''`; `httpx.Client(timeout=600)` with NO base_url (PHP posts the absolute URL `f"{baseUrl}/models/{model}:generateContent?key={apiKey}"`). `SUPPORTED_MODELS` constant copied from PHP lines 56–72. Methods: `_makeRequest(contents, systemPrompt, tools=[])`, `_sanitizeSchemaForGemini`, `_handleFunctionCallsRecursive`, `_executeFunction`, `_hasFunctionCalls`, `_extractTextResponse`, `_buildContents(history, newMessage, imageAttachments=[], pdfAttachments=[])`, `_extractTextFromContent`, `_convertToGeminiTools`, `fixSchemaForGemini` (protected static → `@staticmethod`, overriding the mixin's), `_getTools`, `getContextWindow`, `_getDefaultSystemPrompt`, `_sendProgress`, `_trackUsage`, statics `buildHttpRequest`/`parseHttpResponse`/`getApiFamily()->'gemini'`. `streamChat` = `chat()` + `onChunk(result['text'])` (PHP 304–313). `pendingOutputSchema` as PHP declares. Usage from `usageMetadata.promptTokenCount`/`candidatesTokenCount` (PHP 199–200). The `thoughtSignature` per functionCall part is tracked and echoed back exactly as PHP 491–507 does.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_gemini_provider.py`:
```python
import json
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.gemini_provider import GeminiProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


TEXT = {'candidates': [{'content': {'role': 'model', 'parts': [{'text': 'hello world'}]}, 'finishReason': 'STOP'}],
        'usageMetadata': {'promptTokenCount': 12, 'candidatesTokenCount': 5, 'totalTokenCount': 17}}
CALL = {'candidates': [{'content': {'role': 'model', 'parts': [{'functionCall': {'name': 'echo', 'args': {'x': '1'}}, 'thoughtSignature': 'sig1'}]}, 'finishReason': 'STOP'}],
        'usageMetadata': {'promptTokenCount': 20, 'candidatesTokenCount': 9, 'totalTokenCount': 29}}


def _provider(handler, key='K'):
    p = GeminiProvider(Configuration({'providers': {'gemini': {'api_key': key, 'max_tokens': 100}}}))
    p.httpClient = httpx.Client(transport=httpx.MockTransport(handler))
    return p


def test_basics_and_defaults():
    p = _provider(lambda r: httpx.Response(200, json=TEXT))
    assert p.getName() == 'gemini' and p.getModel() == 'gemini-2.5-flash' and p.isAvailable() and GeminiProvider.getApiFamily() == 'gemini'
    assert 'gemini-2.5-flash' in p.getSupportedModels() and p.baseUrl == 'https://generativelanguage.googleapis.com/v1beta'
    assert not _provider(lambda r: None, key='').isAvailable()


def test_chat_url_payload_result_and_progress():
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); seen['b'] = json.loads(req.content); return httpx.Response(200, json=TEXT)
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}], {'user_id': 3, 'system_prompt': 'SYS'})
    assert seen['url'] == 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=K'
    b = seen['b']
    assert b['generationConfig']['maxOutputTokens'] == 100 and b['generationConfig']['temperature'] == 0.7
    assert [c['role'] for c in b['contents']] == ['user', 'model', 'user'] and b['contents'][-1]['parts'] == [{'text': 'hello'}]
    assert json.dumps(b).count('SYS') == 1 and 'tools' not in b
    assert out == {'text': 'hello world', 'usage': {'input_tokens': 12, 'output_tokens': 5, 'total_tokens': 17, 'function_calls': 0}, 'model': 'gemini-2.5-flash',
                   'provider': 'gemini', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Gemini: Preparing Gemini request...'), ('progress', 'Gemini: Connecting to Gemini API...'), ('progress', 'Gemini: Response ready.')]


def test_stream_chat_is_chat_plus_single_chunk():
    p = _provider(lambda r: httpx.Response(200, json=TEXT)); rec = Rec(); p.setSSEClient(rec)
    chunks = []
    out = p.streamChat('hello', chunks.append, [], {'user_id': 3})
    assert chunks == ['hello world'] and out['text'] == 'hello world'
    assert [e for e in rec.events if e[0] == 'chunk'] == []          # PHP's streamChat never calls sseClient->sendChunk itself


def test_function_call_loop_sends_function_response_and_signature():
    calls = []
    def handler(req):
        calls.append(json.loads(req.content)); return httpx.Response(200, json=CALL if len(calls) == 1 else TEXT)
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}}})
    p.setFunctionExecutor(tm)
    out = p.chat('call echo', [], {'user_id': 3})
    assert len(calls) == 2
    assert calls[0]['tools'][0]['functionDeclarations'][0]['name'] == 'echo'
    model_turn, tool_turn = calls[1]['contents'][-2], calls[1]['contents'][-1]
    assert model_turn['parts'][0]['functionCall']['name'] == 'echo' and model_turn['parts'][0].get('thoughtSignature') == 'sig1'
    fr = tool_turn['parts'][0]['functionResponse']
    assert fr['name'] == 'echo' and fr['response'] == {'echoed': {'x': '1'}} or fr['response'].get('result') == {'echoed': {'x': '1'}}
    assert out['text'] == 'hello world' and out['functions_called'] == ['echo'] and out['usage']['function_calls'] == 1
    assert out['usage']['input_tokens'] == 32 and out['usage']['output_tokens'] == 14
    names = [m for k, m in rec.events if k == 'progress']
    assert 'Gemini: Processing function calls...' in names and 'Gemini: Executing function: echo' in names and 'Gemini: Processing Gemini response...' in names


def test_client_tool_short_circuit():
    p = _provider(lambda r: httpx.Response(200, json=CALL)); p.setSSEClient(Rec())
    p.setPerRequestClientSideToolNames(['echo'])
    out = p.chat('call echo', [], {'user_id': 3})
    assert out['pending_client_tool_call'] and out['pending_tool_calls'][0]['name'] == 'echo'


def test_missing_key_is_authentication_failed_before_request():
    hits = []
    p = _provider(lambda r: hits.append(1) or httpx.Response(200, json=TEXT), key='')
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(ProviderException.authenticationFailed('gemini')) and hits == []


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('gemini')), (401, lambda: ProviderException.authenticationFailed('gemini'))])
def test_http_errors_map_to_php_messages(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_fix_schema_strips_unsupported_keywords():
    fixed = GeminiProvider.fixSchemaForGemini({'type': 'object', 'additionalProperties': False, 'properties': {'a': {'type': 'string', 'default': 'x'}}})
    assert 'additionalProperties' not in fixed and 'default' not in fixed['properties']['a']


def test_static_builder_and_parser():
    r = GeminiProvider.buildHttpRequest('gemini-2.5-flash', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'].startswith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent') and r['payload']['generationConfig']['maxOutputTokens'] == 50
    parsed = GeminiProvider.parseHttpResponse(CALL)
    assert parsed['text'] == '' and parsed['tool_calls'][0]['name'] == 'echo' and parsed['usage']['prompt_tokens'] == 20
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_gemini_provider.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `GeminiProvider.php` verbatim** — `backend/src/Providers/GeminiProvider.php` lines 26–1307 into `app/providers/gemini_provider.py`. The `functionResponse.response` wrapper shape is whatever PHP builds (~lines 600–640); the test accepts either the raw dict or `{'result': …}`. `fixSchemaForGemini` returns the sanitized dict; the keywords it strips are exactly PHP's list (lines 993–1066).

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_gemini_provider.py` → PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): GeminiProvider (non-streaming mirror, function-call loop)"
```

---

### Task 6: `CustomProvider`

**Files:**
- Create: `app/providers/custom_provider.py`
- Test: `tests/unit/test_custom_provider.py`

**Interfaces:**
- `CustomProvider(config: Configuration, providerName: str)`; block `config.get(f'providers.{providerName}', {})`; defaults (PHP `CustomProvider.php:66-104`): `display_name` `ucfirst(providerName)`, `model` `'default'`, `max_tokens` 4096, `temperature` 0.7, `base_url` `''` (rstrip `/`), `api_key` `''`, `supported_models` `[model]`, `headers` `{}`, `chat_endpoint` `'/chat/completions'`, `supports_tools` True, `streaming` False; `DEFAULT_TIMEOUT = 600`, `PROVIDER_TIMEOUTS = {'gamma4': 90}`; `requestTimeout = php_intval(cfg['timeout'] ?? PROVIDER_TIMEOUTS.get(name) ?? DEFAULT_TIMEOUT)`, `connectTimeout = php_intval(cfg['connect_timeout'] ?? 15)`; `httpx.Client(base_url=self.baseUrl or None, timeout=httpx.Timeout(self.requestTimeout, connect=self.connectTimeout))`. Requests POST to `self.baseUrl + self.chatEndpoint` (absolute URL, PHP line 372) with `Authorization: Bearer <key>` only when the key is non-empty (PHP 361) plus `self.headers`. `getName()` returns `providerName`. `thinkingOverride` per call like Kimi (PHP 170–171). `_makeRequest(messages, tools=[], streaming=False)` — no toolChoice parameter (PHP line 307). When `supportsTools` is False no `tools` key is sent. Statics `buildHttpRequest`/`parseHttpResponse`/`getApiFamily()->'openai'`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_custom_provider.py`:
```python
import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.custom_provider import CustomProvider
from app.services.tools_manager import ToolsManager
from app.exceptions import ProviderException

FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


class Rec:
    def __init__(self): self.events = []
    def sendProgress(self, m): self.events.append(('progress', m))
    def sendChunk(self, t): self.events.append(('chunk', t))
    def sendCustomEvent(self, n, d): self.events.append((n, d))
    def sendResponse(self, d): self.events.append(('response', d))
    def sendError(self, m, c=500): self.events.append(('error', m))
    def complete(self): self.events.append(('complete', None))
    def getSessionId(self): return 's'
    def isConnected(self): return True
    def markHeadersInitialized(self): pass


def _provider(handler, name='glm', **cfg):
    block = {'api_key': 'K', 'base_url': 'https://api.z.ai/api/paas/v4', 'model': 'glm-5.2', 'max_tokens': 100, **cfg}
    p = CustomProvider(Configuration({'providers': {name: block}}), name)
    p.httpClient = httpx.Client(transport=httpx.MockTransport(handler), timeout=p.httpClient.timeout)
    return p


def _sse(body: bytes):
    return httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})


def test_defaults_display_name_and_timeouts():
    glm = CustomProvider(Configuration({'providers': {'glm': {'api_key': 'K', 'base_url': 'https://x.example'}}}), 'glm')
    assert glm.getName() == 'glm' and glm.getDisplayName() == 'Glm' and glm.getModel() == 'default' and glm.maxTokens == 4096
    assert glm.chatEndpoint == '/chat/completions' and glm.supportsTools is True and glm.streamingEnabled is False
    assert glm.httpClient.timeout.read == 600.0 and glm.httpClient.timeout.connect == 15.0; glm.close()
    g4 = CustomProvider(Configuration({'providers': {'gamma4': {'api_key': 'K', 'base_url': 'https://g4.example', 'display_name': 'Gamma4'}}}), 'gamma4')
    assert g4.getDisplayName() == 'Gamma4' and g4.httpClient.timeout.read == 90.0; g4.close()
    custom = CustomProvider(Configuration({'providers': {'zed': {'api_key': 'K', 'base_url': 'https://z.example', 'timeout': '42', 'connect_timeout': 3}}}), 'zed')
    assert custom.httpClient.timeout.read == 42.0 and custom.httpClient.timeout.connect == 3.0; custom.close()
    assert CustomProvider.getApiFamily() == 'openai'


def test_chat_posts_absolute_url_with_headers_and_result():
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': 'hi there'}, 'finish_reason': 'stop'}],
                                         'usage': {'prompt_tokens': 3, 'completion_tokens': 4, 'total_tokens': 7}})
    p = _provider(handler, headers={'X-Org': 'acme'}, chat_endpoint='/chat/completions'); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [], {'user_id': 3, 'system_prompt': 'SYS'})
    assert seen['url'] == 'https://api.z.ai/api/paas/v4/chat/completions' and seen['h']['authorization'] == 'Bearer K' and seen['h']['x-org'] == 'acme'
    assert seen['b']['model'] == 'glm-5.2' and seen['b']['max_tokens'] == 100 and seen['b']['messages'][0]['role'] == 'system'
    assert out == {'text': 'hi there', 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}, 'model': 'glm-5.2',
                   'provider': 'glm', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Glm: Preparing Glm request...'), ('progress', 'Glm: Connecting to Glm API...'), ('progress', 'Glm: Response ready.')]


def test_no_bearer_header_when_key_is_empty():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {}})
    p = _provider(handler, api_key=''); p.setSSEClient(Rec())
    p.chat('x', [], {'user_id': 3})
    assert 'authorization' not in seen['h']


def test_supports_tools_false_omits_tools():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {}})
    p = _provider(handler, supports_tools=False); p.setSSEClient(Rec())
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}})
    p.setFunctionExecutor(tm)
    p.chat('x', [], {'user_id': 3})
    assert 'tools' not in seen['b']


def test_streaming_when_enabled():
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); return _sse((FIX / 'openai_stream_text.sse').read_bytes())
    p = _provider(handler, streaming=True); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('hello', lambda t: None, [], {'user_id': 3})
    assert seen['b']['stream'] is True and seen['b']['stream_options'] == {'include_usage': True}
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')] and out['text'] == 'hello world'
    assert ('progress', 'Glm: Thinking...') in rec.events


def test_tool_loop():
    calls = []
    def handler(req):
        calls.append(json.loads(req.content))
        return _sse((FIX / ('openai_stream_tool.sse' if len(calls) == 1 else 'openai_stream_text.sse')).read_bytes())
    p = _provider(handler, streaming=True); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, userId=None: {'echoed': params}, {'name': 'echo', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('call echo', lambda t: None, [], {'user_id': 3})
    assert len(calls) == 2 and calls[1]['messages'][-1]['role'] == 'tool' and out['functions_called'] == ['echo'] and out['text'] == 'hello world'
    assert ('progress', 'Glm: Executing function: echo') in rec.events and ('progress', 'Glm: Processing Glm response...') in rec.events


@pytest.mark.parametrize('switch,expected', [('on', 'enabled'), ('off', 'disabled')])
def test_thinking_override(switch, expected):
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content); return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {}})
    p = _provider(handler); p.setSSEClient(Rec())
    p.chat('x', [], {'user_id': 3, 'thinking': switch})
    assert seen['b']['thinking'] == {'type': expected}


@pytest.mark.parametrize('status,factory', [(429, lambda: ProviderException.rateLimited('glm')), (401, lambda: ProviderException.authenticationFailed('glm'))])
def test_http_errors_use_provider_name(status, factory):
    p = _provider(lambda r: httpx.Response(status, json={'error': {'message': 'nope'}}))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(factory())


def test_static_builder_uses_config_base_url_and_endpoint():
    r = CustomProvider.buildHttpRequest('m', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K', 'base_url': 'https://h.example/v1', 'chat_endpoint': '/completions'}, 50, 0.1)
    assert r['url'] == 'https://h.example/v1/completions' and r['payload']['model'] == 'm'
    assert CustomProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo'}}], 'usage': {}})['text'] == 'yo'
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_custom_provider.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `CustomProvider.php` verbatim** — `backend/src/Providers/CustomProvider.php` lines 26–1025 into `app/providers/custom_provider.py`. Build the httpx client with `base_url=self.baseUrl` only when non-empty (httpx rejects `base_url=''`? it accepts it; pass it through unchanged) — requests use the absolute URL anyway, exactly as PHP posts `$this->baseUrl . $this->chatEndpoint`.

- [ ] **Step 4: Run to verify pass** — `.venv/bin/python -m pytest -q tests/unit/test_custom_provider.py` → PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): CustomProvider (generic OpenAI-compatible: gamma4, glm, ...)"
```

---

### Task 7: `ProviderRequestFactory`

**Files:**
- Create: `app/providers/provider_request_factory.py`
- Test: `tests/unit/test_provider_request_factory.py`

**Interfaces:**
- Consumes the seven provider classes' statics `buildHttpRequest`, `parseHttpResponse`, `getApiFamily`.
- `class ProviderRequestFactory` with class attribute `_providerClasses: dict[str, type]` = `{'claude': ClaudeProvider, 'anthropic': ClaudeProvider, 'gemini': GeminiProvider, 'google': GeminiProvider, 'openai': OpenAIProvider, 'deepseek': DeepSeekProvider, 'grok': GrokProvider, 'kimi': KimiProvider, 'gamma4': CustomProvider, 'glm': CustomProvider}` (PHP lines 22–41, same order and comments). Static/class methods: `buildRequest(provider, model, messages, tools, config, maxTokens, temperature) -> dict | None`, `parseResponse(provider, decoded) -> dict`, `getApiFamily(provider) -> str`, `isSupported(provider) -> bool`, `getSupportedProviders() -> list`, `registerProvider(name, cls) -> None`. Unknown provider → `error_log("[ProviderRequestFactory] Unknown provider '{provider}', using OpenAI-compatible format")` and `OpenAIProvider` (buildRequest) / silently `OpenAIProvider` (parseResponse) / `'openai'` (getApiFamily) — PHP lines 63–68, 96–100, 113–118. The `class_implements` guard becomes `issubclass(cls, HttpRequestBuilderInterface)`; on failure `buildRequest` logs and returns `None`, `parseResponse` returns `{'text': '', 'tool_calls': [], 'usage': None}`, `getApiFamily` returns `'openai'`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test_provider_request_factory.py`:
```python
import pytest
from app.providers.provider_request_factory import ProviderRequestFactory as F
from app.providers.claude_provider import ClaudeProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.grok_provider import GrokProvider
from app.providers.kimi_provider import KimiProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.providers.custom_provider import CustomProvider

MSGS = [{'role': 'user', 'content': 'hi'}]


def test_registry_names_and_families():
    assert F.getSupportedProviders() == ['claude', 'anthropic', 'gemini', 'google', 'openai', 'deepseek', 'grok', 'kimi', 'gamma4', 'glm']
    assert F.isSupported('Claude') and F.isSupported('GLM') and not F.isSupported('nope')
    assert [F.getApiFamily(n) for n in ('anthropic', 'google', 'openai', 'deepseek', 'grok', 'kimi', 'gamma4', 'nope')] == ['claude', 'gemini', 'openai', 'openai', 'openai', 'openai', 'openai', 'openai']


@pytest.mark.parametrize('name,cls,cfg', [
    ('anthropic', ClaudeProvider, {'api_key': 'K'}),
    ('google', GeminiProvider, {'api_key': 'K'}),
    ('openai', OpenAIProvider, {'api_key': 'K'}),
    ('grok', GrokProvider, {'api_key': 'K'}),
    ('kimi', KimiProvider, {'api_key': 'K'}),
    ('deepseek', DeepSeekProvider, {'api_key': 'K'}),
    ('glm', CustomProvider, {'api_key': 'K', 'base_url': 'https://h.example', 'chat_endpoint': '/c'}),
])
def test_build_and_parse_delegate_to_the_class(name, cls, cfg):
    assert F.buildRequest(name, 'm', MSGS, [], cfg, 50, 0.1) == cls.buildHttpRequest('m', MSGS, [], cfg, 50, 0.1)
    decoded = {'choices': [{'message': {'content': 'yo'}}], 'usage': {}, 'content': [{'type': 'text', 'text': 'yo'}], 'candidates': [{'content': {'parts': [{'text': 'yo'}]}}]}
    assert F.parseResponse(name, decoded) == cls.parseHttpResponse(decoded)


def test_unknown_provider_falls_back_to_openai_format():
    cfg = {'api_key': 'K'}
    assert F.buildRequest('mystery', 'm', MSGS, [], cfg, 50, 0.1) == OpenAIProvider.buildHttpRequest('m', MSGS, [], cfg, 50, 0.1)
    assert F.parseResponse('mystery', {'choices': [{'message': {'content': 'yo'}}], 'usage': {}})['text'] == 'yo'


def test_register_provider_and_non_builder_guard():
    class NotABuilder: pass
    F.registerProvider('Weird', NotABuilder)
    try:
        assert F.isSupported('weird')
        assert F.buildRequest('weird', 'm', MSGS, [], {}, 1, 0.0) is None
        assert F.parseResponse('weird', {}) == {'text': '', 'tool_calls': [], 'usage': None}
        assert F.getApiFamily('weird') == 'openai'
    finally:
        F._providerClasses.pop('weird', None)
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_provider_request_factory.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Port `ProviderRequestFactory.php` verbatim** — lines 16–159 into `app/providers/provider_request_factory.py`.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): ProviderRequestFactory"
```

---

### Task 8: Wire the providers into `AIPortfolioAssistant`; controller propagation and error-humanization matrix tests

**Files:**
- Modify: `app/ai_portfolio_assistant.py` (`DEDICATED_PROVIDERS`, `_makeProvider`, `_initializeDefaultProvider` comments), `tests/unit/test_ai_portfolio_assistant.py`
- Test: `tests/unit/test_chat_controller_flows.py` (add two tests), `tests/unit/test_humanize_provider_error_matrix.py` (new)

**Interfaces:**
- `AIPortfolioAssistant.DEDICATED_PROVIDERS = {'claude': ClaudeProvider, 'deepseek': DeepSeekProvider, 'gemini': GeminiProvider, 'grok': GrokProvider, 'kimi': KimiProvider, 'openai': OpenAIProvider}` (PHP `AIPortfolioAssistant.php:433-441`, same order).
- `_makeProvider(name)` (PHP 447–457): `cls = DEDICATED_PROVIDERS.get(name)`; `provider = cls(self.config) if cls is not None else CustomProvider(self.config, name)`; `provider.setFunctionExecutor(self.toolsManager)`; `if self.logger: provider.setLogger(self.logger)`; return provider. It never returns `None` any more; delete the "Phase 2a … returns None" comments and the `is not None` guards in `_initializeDefaultProvider` (PHP 463–495 has none).

- [ ] **Step 1: Write the failing tests**

Replace the "pending 2b" assertions in `tests/unit/test_ai_portfolio_assistant.py::test_constructor_registers_claude_and_search_tools` (line 34 area) with:
```python
    assert a.getLLMManager().getProvider('kimi') is None                      # not configured in this fixture
```
and add to that file:
```python
def test_configured_providers_are_registered_with_dedicated_or_custom_classes():
    from app.providers.kimi_provider import KimiProvider
    from app.providers.gemini_provider import GeminiProvider
    from app.providers.openai_provider import OpenAIProvider
    from app.providers.custom_provider import CustomProvider
    cfg = {'claude': {'api_key': 'K'}, 'openai': {'api_key': 'O'},
           'providers': {'kimi': {'api_key': 'K1', 'base_url': 'https://api.moonshot.ai'},
                         'gemini': {'api_key': 'G', 'base_url': 'https://generativelanguage.googleapis.com/v1beta'},
                         'glm': {'api_key': 'Z', 'base_url': 'https://api.z.ai/api/paas/v4', 'model': 'glm-5.2'},
                         'nobase': {'api_key': 'X'}}}
    a = AIPortfolioAssistant(cfg)
    lm = a.getLLMManager()
    try:
        assert isinstance(lm.getProvider('openai'), OpenAIProvider)
        assert isinstance(lm.getProvider('kimi'), KimiProvider)
        assert isinstance(lm.getProvider('gemini'), GeminiProvider)
        glm = lm.getProvider('glm'); assert isinstance(glm, CustomProvider) and glm.getName() == 'glm' and glm.getModel() == 'glm-5.2'
        assert lm.getProvider('nobase') is None                             # empty base_url → skipped, like PHP
        assert lm.getProvider('anthropic') is lm.getProvider('claude')
        for name in ('openai', 'kimi', 'gemini', 'glm'):
            assert lm.getProvider(name).functionExecutor is a.getToolsManager()
        assert lm.fallbackOrder == ['claude', 'openai', 'kimi', 'gemini', 'glm', 'nobase']
    finally:
        a.close()
    for name in ('openai', 'kimi', 'gemini', 'glm'):
        assert lm.getProvider(name).httpClient.is_closed
```
(If `LLMManager` stores the fallback order under a different attribute name, use that name — read `app/services/llm_manager.py::setFallbackOrder`.)

Append to `tests/unit/test_chat_controller_flows.py` (uses that file's existing `Db`, `CFG`, `ctx`, `FakeAssistant`):
```python
def test_tools_filter_executor_is_attached_to_every_enabled_provider(monkeypatch):
    attached = {}
    class P:
        def __init__(self, name): self.name = name
        def setFunctionExecutor(self, ex): attached[self.name] = ex
    providers = {'claude': P('claude'), 'kimi': P('kimi')}
    class Assistant(FakeAssistant):
        def __init__(self, config):
            super().__init__(config)
            self.llm = type('L', (), {'getProvider': lambda s, n: providers.get(n)})()
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    monkeypatch.setattr(ChatController, '_getEnabledProviderKeys', lambda self: ['claude', 'kimi', 'gemini'])
    c = ChatController(Db(), CFG)
    r = c.chat(ctx({'message': 'hi', 'provider': 'claude', 'tools': ['get_trending_assets'], 'memory': False}))
    assert r['success'] is True
    from app.services.filtered_tools_executor import FilteredToolsExecutor
    assert set(attached) == {'claude', 'kimi'} and all(isinstance(e, FilteredToolsExecutor) for e in attached.values())
    assert attached['claude'] is attached['kimi']


def test_non_claude_provider_request_reaches_assistant_with_provider_option(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    c = ChatController(Db(), CFG)
    r = c.chat(ctx({'message': 'hi', 'provider': 'kimi', 'tools': [], 'memory': False}))
    assert r['success'] is True and FakeAssistant.last[3]['provider'] == 'kimi'
```

New `tests/unit/test_humanize_provider_error_matrix.py`:
```python
import httpx
import pytest
from app.controllers.chat_controller import ChatController
from app.exceptions import ProviderException

PROVIDERS = ['claude', 'openai', 'grok', 'kimi', 'deepseek', 'gemini', 'glm']


def _status_error(status: int, reason: str) -> str:
    req = httpx.Request('POST', 'https://h.example/v1/x')
    resp = httpx.Response(status, request=req, text=reason)
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        return str(e)
    raise AssertionError('no error')


@pytest.mark.parametrize('provider', PROVIDERS)
def test_every_provider_lands_in_the_intended_humanized_branch(provider):
    h = ChatController.humanizeProviderError
    assert h(str(ProviderException.rateLimited(provider))).startswith('⏳ Rate limit reached')
    assert h(str(ProviderException.authenticationFailed(provider))).startswith('🔑 Authentication failed')
    assert h(str(ProviderException.apiError(provider, _status_error(503, 'Service Unavailable'), 503))).startswith('⏳ The model provider is temporarily overloaded')
    assert h(str(ProviderException.apiError(provider, _status_error(502, 'Bad Gateway'), 502))).startswith('⏳ The model provider is temporarily overloaded')
    assert h(str(ProviderException.apiError(provider, 'This model\'s maximum context length is 8192 tokens', 400))).startswith('📏')
    assert h(str(ProviderException.apiError(provider, 'insufficient_quota: billing hard limit reached', 402))).startswith('💳')
    assert h(str(ProviderException.apiError(provider, 'Connection refused', 0))).startswith('🌐')
    generic = h(str(ProviderException.apiError(provider, 'something odd happened', 500)))
    assert generic == f'{provider} API error: something odd happened'
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python -m pytest -q tests/unit/test_ai_portfolio_assistant.py tests/unit/test_chat_controller_flows.py tests/unit/test_humanize_provider_error_matrix.py` → the assistant test fails (`getProvider('kimi') is None`), the matrix may already pass (that is fine — it is a regression net for 2b's classes), the controller tests fail only if the loop is broken (they should pass; keep them).

- [ ] **Step 3: Implement the wiring** per the Interfaces block (PHP `AIPortfolioAssistant.php:433-495`). Update the module docstring of `app/ai_portfolio_assistant.py` (drop the "pending 2b" paragraph).

- [ ] **Step 4: Run to verify pass** — the three files PASS; if `humanizeProviderError` misroutes any provider's message, that is a finding against the provider's error text (Tasks 1–6), not against the humanizer — report it, do not change the humanizer.

- [ ] **Step 5: Full unit suite, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
cd .. && git add backend_python && git commit -m "feat(py): register all configured providers (dedicated classes + CustomProvider); propagation + humanize matrix tests"
```

---

### Task 9: Differential per provider, docs, full verification

**Files:**
- Create: `tests/differential/test_providers.py`
- Modify: `backend_python/README.md` (Status: Phase 2b paragraph), `docs/backend-parity-tracker.md` (rows from 44 on)
- Verification: unit + differential suites; curl smoke per provider on :3002

**Interfaces:**
- Consumes `tests/differential/conftest.py` fixtures `php`, `py`, `token`, `config`, `both`, `same` and `tests/differential/sse.py::same_stream` (2a).

- [ ] **Step 1: Write the differential tests**

`tests/differential/test_providers.py`:
```python
"""Per-provider streaming parity vs the live PHP backend. One live LLM call per
backend per configured provider — run once per full run."""
import pytest
from app.db import Db
from .sse import same_stream

CANDIDATES = ['openai', 'grok', 'kimi', 'deepseek', 'gemini', 'gamma4', 'glm']


def _configured(config) -> set[str]:
    db = Db.connect(config.get('contexts_database') or config['database'])
    try:
        rows = db.fetch_all("SELECT provider_key FROM system_llm_settings WHERE enabled = 1 AND api_key IS NOT NULL AND api_key <> ''")
        return {r['provider_key'] for r in rows}
    finally:
        db.close()


def _body(provider: str) -> dict:
    return {'message': 'Reply with exactly: hello world', 'provider': provider, 'tools': [], 'memory': False, 'streaming': True, 'conversation_history': []}


@pytest.mark.parametrize('provider', CANDIDATES)
def test_streaming_parity_live(php, py, token, config, provider):
    if provider not in _configured(config):
        pytest.skip(f'{provider} not configured in system_llm_settings')
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    a = php.post('/api/v1/chat', json=_body(provider), headers=headers, timeout=180)
    b = py.post('/api/v1/chat', json=_body(provider), headers=headers)
    assert a.status_code == b.status_code == 200
    assert a.headers['content-type'].split(';')[0] == b.headers['content-type'].split(';')[0] == 'text/event-stream'
    same_stream(a.text, b.text)


def test_unknown_provider_still_not_found(both):
    from .conftest import same
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'provider': 'no-such-provider', 'tools': [], 'memory': False}))
```
(Adapt the `php.post`/`py.post` calls to the exact fixture API in `tests/differential/conftest.py` — read `both()` for how it issues requests and reuse the same pattern; the streaming test in `tests/differential/test_chat.py::test_streaming_chat_parity_live` is the model to copy.)

- [ ] **Step 2: Run the differential suite once**

Run: `.venv/bin/python -m pytest -q tests/differential`
Expected: all previous cases pass; each configured provider's skeleton, `response`/`complete` payloads (usage normalized) and `error` payloads match PHP. A mismatch on a provider is a defect in that provider's port (Tasks 1–6): report the provider, the two skeletons and the differing payload keys — do not weaken the comparator.

- [ ] **Step 3: Curl smoke per provider on the running server**

For each configured provider (`openai grok kimi deepseek gemini gamma4 glm`), mint a token the way `tests/differential/conftest.py::token` does and run:
```bash
curl -sN -X POST http://localhost:3002/api/v1/chat -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"Reply with exactly: hello world","provider":"<name>","tools":[],"memory":false,"streaming":true}' | head -c 1500
```
Expected: `event: progress` lines with that provider's label, `chunk` frames, a `response` frame with `"provider":"<name>"`, `complete`. Record the first 3 lines of each in the report. Browser UI smoke is deferred to 2c (the picker needs `/api/v1/providers`).

- [ ] **Step 4: Docs**

`backend_python/README.md` — after the Phase 2a paragraph add:
"Phase 2b (2026-09): all seven chat providers — Claude, OpenAI, Grok, Kimi, DeepSeek, Gemini, and the generic OpenAI-compatible `CustomProvider` for `system_llm_settings` rows without a dedicated class (gamma4, glm) — plus `ProviderRequestFactory`. Every configured provider is differential-tested against live PHP (event skeleton, `response`/`complete` payloads, error messages). Gemini does not stream (single `chunk`), exactly like PHP. `/api/v1/providers` and the built-in Functions remain pending Phase 2c."

`docs/backend-parity-tracker.md` — append rows (continue numbering from 44, same column format as rows 30–43):
- 44: PY: Grok/Kimi/DeepSeek ignore `base_url` from `system_llm_settings` (class constants, like PHP) | 🪞 | Mirrors PHP; the TS port diverged here.
- 45: PY: `CustomProvider` request timeout `providers.<name>.timeout` ?? `{'gamma4': 90}` ?? 600 s, connect 15 s, via `httpx.Timeout` | 🪞 | Same values as PHP's Guzzle options.
- 46: PY: Gemini `streamChat` = `chat()` + one `onChunk(text)`; no true streaming | 🪞 | Spec §4; identical event skeleton to PHP.
- 47: PY: provider HTTP errors map 429/401/other from `httpx.HTTPStatusError`; network errors (`httpx.RequestError`) become `apiError(provider, str(e), 0)` | 🪞 | Wire message text matches PHP's Guzzle path for status errors; network-error wording differs (log-visible via `humanizeProviderError` 🌐 branch either way).
- 48: PY: `ProviderRequestFactory` interface check is `issubclass(cls, HttpRequestBuilderInterface)` (PHP `class_implements`) | 🪞 | Same fallbacks.
- plus one row per additional ruling recorded in the ledger during 2b.

- [ ] **Step 5: Full verification, commit**

```bash
.venv/bin/python -m pytest -q tests/unit
.venv/bin/python -m pytest -q tests/differential      # already run in Step 2 — do not run twice; paste that output
cd .. && git add backend_python docs/backend-parity-tracker.md && git commit -m "test(py): per-provider differential parity; docs(py): Phase 2b status + parity rows"
```

---

## Self-review notes

- **Spec coverage (Phase 2 §2 row 2b):** `OpenAIProvider` → T1; `GrokProvider` → T2; `KimiProvider` → T3; `DeepSeekProvider` → T4; `GeminiProvider` → T5; `CustomProvider` → T6; `ProviderRequestFactory` → T7. §4 (one class per file, mixins, httpx per instance, Gemini single chunk, `ProviderException` messages) → T1–T6 constraints. §6 (MockTransport + fixtures for text/tool/client-tool/error mapping; differential per provider; browser smoke) → per-task tests + T9; browser smoke deferred to 2c by ruling (picker needs `/providers`). Registration into the assistant (PHP `makeProvider`) → T8.
- **Placeholders:** none. Where a PHP detail is not pinned by the plan text (Kimi's `detailMsg`, Gemini's `functionResponse` wrapper, DeepSeek reasoning chunk emission), the test accepts what PHP does and the step says "PHP wins".
- **Type consistency:** `_Totals` from `app.providers.totals` (T1) used by T2–T6; `Rec` identical in every test file; `ToolsManager.registerFunction(name, handler, schema)` (2a) used in T1–T6; `setPerRequestClientSideToolNames` / `emitClientToolCallEvent` from the 2a mixin; `ProviderException.getHttpStatusCode()` (2a); `AIPortfolioAssistant.DEDICATED_PROVIDERS` names match `ProviderRequestFactory._providerClasses` keys; `same_stream` signature from 2a.
