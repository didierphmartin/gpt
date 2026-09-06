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


def test_api_error_message_carries_the_response_body():
    # PHP passes Guzzle's $e->getMessage(), which embeds a body excerpt; humanizeProviderError matches on it.
    body = {'error': {'code': 404, 'message': 'models/gemini-nope is not found for API version v1beta', 'status': 'NOT_FOUND'}}
    p = _provider(lambda r: httpx.Response(404, json=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    msg = str(ei.value)
    assert msg.startswith('gemini API error: ') and ' | Response: ' in msg and 'gemini-nope is not found' in msg
    assert ei.value.getHttpStatusCode() == 404


def test_response_body_is_truncated_like_guzzle_body_summary():
    # Guzzle Message::bodySummary: 120 chars + ' (truncated...)'.
    body = 'X' * 500 + 'TAIL'
    p = _provider(lambda r: httpx.Response(400, text=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    msg = str(ei.value)
    assert 'X' * 120 + ' (truncated...)' in msg and 'TAIL' not in msg


def test_fix_schema_strips_unsupported_keywords():
    fixed = GeminiProvider.fixSchemaForGemini({'type': 'object', 'additionalProperties': False, 'properties': {'a': {'type': 'string', 'default': 'x'}}})
    assert 'additionalProperties' not in fixed and 'default' not in fixed['properties']['a']


def test_static_builder_and_parser():
    r = GeminiProvider.buildHttpRequest('gemini-2.5-flash', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'].startswith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent') and r['payload']['generationConfig']['maxOutputTokens'] == 50
    parsed = GeminiProvider.parseHttpResponse(CALL)
    # Brief said parsed['tool_calls'][0]['name']; PHP:1273-1280 emits the
    # OpenAI-compatible shape {id, type, function:{name, arguments}} with no
    # top-level 'name', so the assertion follows PHP.
    assert parsed['text'] == '' and parsed['tool_calls'][0]['function']['name'] == 'echo' and parsed['usage']['prompt_tokens'] == 20
    assert parsed['tool_calls'][0]['thought_signature'] == 'sig1' and json.loads(parsed['tool_calls'][0]['function']['arguments']) == {'x': '1'}
