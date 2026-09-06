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
