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
    # PHP OpenAIProvider.php:162 reads the streaming flag from options['stream'] (default true),
    # NOT from the openai.streaming config block — so non-streaming must be requested here.
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}], {'user_id': 3, 'system_prompt': 'SYS', 'stream': False})
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


def test_api_error_message_carries_the_response_body():
    # PHP:384 passes $e->getMessage(); Guzzle embeds the response-body summary,
    # and ChatController::humanizeProviderError pattern-matches on it.
    body = '{"error": {"message": "This model\'s maximum context length is 8192 tokens", "code": "context_length_exceeded"}}'
    p = _provider(lambda r: httpx.Response(400, text=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert 'context_length_exceeded' in str(ei.value) and ei.value.getHttpStatusCode() == 400


def test_response_body_is_truncated_like_guzzle_body_summary():
    # Guzzle's RequestException embeds Message::bodySummary($response), which
    # reads at most 120 bytes and appends ' (truncated...)'. Unbounded
    # appends change the user-visible text, the humanizer's regex surface and
    # the error_message column width.
    body = 'X' * 500 + 'TAIL'
    p = _provider(lambda r: httpx.Response(400, text=body))
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    msg = str(ei.value)
    assert 'X' * 120 + ' (truncated...)' in msg and 'TAIL' not in msg


def test_missing_key_is_authentication_failed_before_any_request():
    hits = []
    p = _provider(lambda r: hits.append(1) or httpx.Response(200, json={}), streaming=False, key='')
    with pytest.raises(ProviderException) as ei:
        p.chat('x', [], {'user_id': 3})
    assert str(ei.value) == str(ProviderException.authenticationFailed('openai')) and hits == []


def test_static_builder_and_parser():
    r = OpenAIProvider.buildHttpRequest('gpt-4o', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    # PHP OpenAIProvider.php:960 emits max_completion_tokens (not max_tokens) in the static builder.
    assert r['url'].endswith('/v1/chat/completions') and 'Authorization: Bearer K' in r['headers'] and r['payload']['model'] == 'gpt-4o' and r['payload']['max_completion_tokens'] == 50
    parsed = OpenAIProvider.parseHttpResponse({'choices': [{'message': {'content': 'yo', 'tool_calls': []}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2}})
    assert parsed['text'] == 'yo' and parsed['tool_calls'] == [] and parsed['usage']['prompt_tokens'] == 1
