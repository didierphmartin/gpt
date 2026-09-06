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


def test_api_error_message_carries_the_response_body():
    # MANDATORY error-text rule: apiError message = str(e) + " | Response: " + e.response.text
    # so ChatController::humanizeProviderError's pattern-match on the body still fires.
    body = '{"error": {"message": "This model\'s maximum context length is 8192 tokens", "code": "context_length_exceeded"}}'
    p = _provider(lambda r: httpx.Response(400, text=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert 'context_length_exceeded' in str(ei.value) and ei.value.getHttpStatusCode() == 400


def test_response_body_is_truncated_like_guzzle_body_summary():
    # Guzzle Message::bodySummary: 120 chars + ' (truncated...)'.
    body = 'X' * 500 + 'TAIL'
    p = _provider(lambda r: httpx.Response(400, text=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    msg = str(ei.value)
    assert 'X' * 120 + ' (truncated...)' in msg and 'TAIL' not in msg


def test_static_builder_uses_config_base_url_and_endpoint():
    r = CustomProvider.buildHttpRequest('m', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K', 'base_url': 'https://h.example/v1', 'chat_endpoint': '/completions'}, 50, 0.1)
    assert r['url'] == 'https://h.example/v1/completions' and r['payload']['model'] == 'm'
    assert CustomProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo'}}], 'usage': {}})['text'] == 'yo'
