import json
import pathlib
import httpx
import pytest
from app.config_.configuration import Configuration
from app.providers.claude_provider import ClaudeProvider
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
    p = ClaudeProvider(Configuration({'claude': {'api_key': key, 'streaming': streaming, 'max_tokens': 100}}))
    p.httpClient = httpx.Client(base_url='https://api.anthropic.com', transport=httpx.MockTransport(handler))
    return p


def test_basics():
    p = _provider(lambda r: httpx.Response(200, json={}))
    assert p.getName() == 'claude' and p.isAvailable() and p.getModel() == 'claude-sonnet-4-5-20250929'
    assert p.getSupportedModels()[0] == 'claude-sonnet-4-5-20250929' and p.getContextWindow() == 200000
    assert not _provider(lambda r: None, key='').isAvailable()
    assert p.getDefaultSystemPrompt().startswith('You are')      # resources/prompts/portfolio_assistant.txt


def test_chat_non_streaming_text_and_usage():
    seen = {}
    def handler(req):
        seen['h'] = dict(req.headers); seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'content': [{'type': 'text', 'text': 'hi'}, {'type': 'text', 'text': 'there'}], 'usage': {'input_tokens': 3, 'output_tokens': 4}, 'stop_reason': 'end_turn'})
    p = _provider(handler, streaming=False); rec = Rec(); p.setSSEClient(rec)
    out = p.chat('hello', [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}], {'user_id': 3, 'system_prompt': 'SYS'})
    assert out == {'text': 'hi\nthere', 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7, 'function_calls': 0}, 'model': 'claude-sonnet-4-5-20250929',
                   'provider': 'claude', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    assert seen['h']['x-api-key'] == 'K' and seen['h']['anthropic-version'] == '2023-06-01'
    b = seen['b']
    assert b['system'] == [{'type': 'text', 'text': b['system'][0]['text'], 'cache_control': {'type': 'ephemeral'}}] and b['system'][0]['text'].endswith('\n\nSYS')
    assert b['messages'] == [{'role': 'user', 'content': [{'type': 'text', 'text': 'earlier'}]}, {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]},
                             {'role': 'user', 'content': [{'type': 'text', 'text': 'hello'}]}]
    assert b['max_tokens'] == 100 and 'tools' not in b
    assert [e for e in rec.events if e[0] == 'progress'] == [('progress', 'Claude: Preparing Claude request...'), ('progress', 'Claude: Connecting to Claude API...'), ('progress', 'Claude: Response ready.')]


def test_stream_chat_emits_chunks_and_usage():
    body = (FIX / 'claude_stream_text.sse').read_bytes()
    p = _provider(lambda r: httpx.Response(200, content=body, headers={'content-type': 'text/event-stream'})); rec = Rec(); p.setSSEClient(rec)
    chunks = []
    out = p.streamChat('hello', chunks.append, [], {'user_id': 3})
    assert out['text'] == 'hello world' and out['usage'] == {'input_tokens': 12, 'output_tokens': 5, 'total_tokens': 17, 'function_calls': 0}
    assert [e for e in rec.events if e[0] == 'chunk'] == [('chunk', 'hello '), ('chunk', 'world')]
    assert rec.events[0] == ('progress', 'Claude: Preparing Claude streaming request...')
    assert rec.events[1] == ('progress', 'Claude: Connecting to Claude API (streaming)...')
    assert rec.events[-1] == ('progress', 'Claude: Response ready.')


def test_stream_chat_falls_back_to_chat_when_streaming_disabled():
    p = _provider(lambda r: httpx.Response(200, json={'content': [{'type': 'text', 'text': 'x'}], 'usage': {'input_tokens': 1, 'output_tokens': 1}}), streaming=False)
    got = []
    out = p.streamChat('m', got.append, [], {})
    assert out['text'] == 'x' and got == ['x']


def test_tool_loop_executes_server_tool_then_continues():
    calls = []
    def handler(req):
        b = json.loads(req.content); calls.append(b)
        if len(calls) == 1:
            return httpx.Response(200, content=(FIX / 'claude_stream_tool.sse').read_bytes())
        return httpx.Response(200, content=(FIX / 'claude_stream_text.sse').read_bytes())
    p = _provider(handler); rec = Rec(); p.setSSEClient(rec)
    tm = ToolsManager(); tm.registerFunction('echo', lambda params, ctx=None: {'echo': params, 'ctx': ctx}, {'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}})
    p.setFunctionExecutor(tm)
    out = p.streamChat('run it', lambda t: None, [], {'user_id': 3})
    assert out['text'] == 'hello world' and out['functions_called'] == ['echo'] and out['usage']['function_calls'] == 1
    assert out['usage'] == {'input_tokens': 32, 'output_tokens': 14, 'total_tokens': 46, 'function_calls': 1}
    prog = [m for e, m in rec.events if e == 'progress']
    assert 'Claude: Processing tool calls...' in prog and 'Claude: Executing function: echo' in prog and 'Claude: Processing Claude response...' in prog
    second = calls[1]['messages']
    assert second[-2] == {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'echo', 'input': {'x': '1'}}]}
    assert second[-1]['role'] == 'user' and second[-1]['content'][0]['type'] == 'tool_result' and second[-1]['content'][0]['tool_use_id'] == 'toolu_1'
    assert json.loads(second[-1]['content'][0]['content']) == {'echo': {'x': '1'}, 'ctx': 3}
    assert calls[0]['tools'][0]['name'] == 'echo'


def test_client_tool_short_circuit_emits_event_and_pending():
    tool_sse = (FIX / 'claude_stream_tool.sse').read_text().replace('"name":"echo"', '"name":"run_skill_script"').encode()
    p = _provider(lambda r: httpx.Response(200, content=tool_sse)); rec = Rec(); p.setSSEClient(rec)
    out = p.streamChat('do', lambda t: None, [], {'user_id': 3, 'tools': [{'name': 'run_skill_script', 'description': 'd', 'input_schema': {'type': 'object', 'properties': {}}}]})
    assert out['pending_client_tool_call'] is True and out['pending_tool_calls'] == [{'id': 'toolu_1', 'name': 'run_skill_script', 'input': {'x': '1'}}]
    # PHP makeStreamingRequest never returns stop_reason
    assert out['functions_called'] == ['run_skill_script'] and out['text'] == '' and out['stop_reason'] is None
    assert ('client_tool_call', {'assistant_text': '', 'tool_calls': [{'id': 'toolu_1', 'name': 'run_skill_script', 'input': {'x': '1'}}]}) in rec.events


def test_error_mapping():
    with pytest.raises(ProviderException, match='Authentication failed for claude. Please check your API key.'):
        _provider(lambda r: httpx.Response(401, json={'error': 'x'}), streaming=False).chat('m')
    with pytest.raises(ProviderException, match='Rate limited by claude.'):
        _provider(lambda r: httpx.Response(429, json={}), streaming=False).chat('m')
    with pytest.raises(ProviderException) as ei:
        _provider(lambda r: httpx.Response(500, text='boom'), streaming=False).chat('m')
    assert str(ei.value).startswith('claude API error: ') and ei.value.getHttpStatusCode() == 500   # non-streaming path: no ' | Response:' suffix (only makeStreamingRequest appends it)
    with pytest.raises(ProviderException, match='Authentication failed for claude'):
        _provider(lambda r: None, key='').chat('m')


def test_build_messages_and_helpers():
    p = _provider(lambda r: None)
    hist = [{'role': 'tool', 'tool_call_id': 'c1', 'content': {'a': 1}},
            {'role': 'assistant', 'content': ' ', 'tool_calls': [{'id': 'c2', 'function': {'name': 'f', 'arguments': '{}'}}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'u'}]}]
    msgs = p._buildMessages(hist, 'new', [{'mime_type': 'image/png', 'data': 'AAA', 'name': 'i'}], [{'mime_type': 'application/pdf', 'data': 'BBB', 'name': 'd'}])
    assert msgs[0] == {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'c1', 'content': '{"a":1}'}]}
    assert msgs[1] == {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'c2', 'name': 'f', 'input': {}}]}
    assert msgs[-1]['content'][0]['type'] == 'document' and msgs[-1]['content'][1]['type'] == 'image' and msgs[-1]['content'][2] == {'type': 'text', 'text': 'new'}
    cont = p._buildMessages([{'role': 'tool', 'tool_call_id': 'c1', 'content': 'r'}], '', [], [])
    assert len(cont) == 1                                           # tool-result continuation: no new user turn
    assert p._stripLargeDataFromResult({'data': 'x' * 2000, 'k': [{'base64': 'y' * 2000}]}) == {'data': '[Base64 data stripped - 2000 bytes]', 'k': [{'base64': '[Base64 data stripped - 2000 bytes]'}]}
    assert p._stripLargeDataFromResult('z' * 60000) == '[Large data truncated - 60000 bytes]'
    assert p._parseClaudeStreamEvent('event: ping\ndata: {"type":"ping"}') == {'event': 'ping', 'data': {'type': 'ping'}}
    assert p._parseClaudeStreamEvent('event: x\ndata: not-json') is None
    assert ClaudeProvider.parseHttpResponse({'content': [{'type': 'text', 'text': 'a'}, {'type': 'tool_use', 'id': 'i', 'name': 'n', 'input': {'q': 1}}], 'usage': {'input_tokens': 1, 'output_tokens': 2}}) == \
        {'text': 'a', 'tool_calls': [{'id': 'i', 'type': 'function', 'function': {'name': 'n', 'arguments': '{"q":1}'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}}
    req = ClaudeProvider.buildHttpRequest('m', [{'role': 'system', 'content': 'S'}, {'role': 'user', 'content': 'u'}], [{'name': 't', 'input_schema': {'type': 'object', 'properties': {}}}], {'api_key': 'K'}, 10, 0.5)
    assert req['url'] == 'https://api.anthropic.com/v1/messages' and req['payload']['tools'][0]['input_schema'] == {'type': 'object', 'properties': {}, 'required': []} and req['provider'] == 'claude'


def test_output_schema_forces_tool_and_extracts_json():
    def handler(req):
        return httpx.Response(200, json={'content': [{'type': 'tool_use', 'id': 'i', 'name': 'answer', 'input': {'k': 'v/é'}}], 'usage': {'input_tokens': 1, 'output_tokens': 1}})
    p = _provider(handler, streaming=False)
    out = p.chat('m', [], {'output_schema': {'name': 'answer', 'schema': {'type': 'object', 'properties': {'k': {'type': 'string'}}}}})
    assert out['text'] == '{"k":"v/é"}' and out['usage']['function_calls'] == 0
