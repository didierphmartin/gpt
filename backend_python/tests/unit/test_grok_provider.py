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


def test_string_enum_values_use_php_strval_on_the_wire():
    """PHP GrokProvider uses array_map('strval', ...): True -> '1', None -> '',
    1.0 -> '1'. Bare str() would put 'True'/'None'/'1.0' on the xAI wire."""
    from app.providers.grok_provider import _xai_tool_parameters
    params = _xai_tool_parameters({'name': 't', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string', 'enum': [True, None, 1.0]}}}})
    assert params['properties']['x']['enum'] == ['1', '', '1']
