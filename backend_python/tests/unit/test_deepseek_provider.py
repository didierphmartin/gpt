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
    # NOTE ON DEVIATION: PHP only round-trips `reasoning_content` on an
    # assistant history entry that ALSO carries `tool_calls`
    # (DeepSeekProvider.php buildMessages: the `$role === 'assistant' &&
    # !empty($msg['tool_calls'])` branch at line 704, `reasoning_content`
    # assignment at line 731). A plain assistant turn with no tool_calls
    # falls through to the generic text branch (line 737+), which drops
    # reasoning_content entirely. The brief's original fixture had no
    # tool_calls on the assistant history entry, so it could never have
    # exercised the behavior it names (PHP:731). Fixed here by adding a
    # tool_calls entry so the assertion tests real, demonstrated PHP
    # behavior instead of a code path PHP doesn't have.
    seen = {}
    def handler(req):
        seen['b'] = json.loads(req.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})
    p = _provider(handler, streaming=False); p.setSSEClient(Rec())
    p.chat('next', [{'role': 'user', 'content': 'q'},
                     {'role': 'assistant', 'content': 'a', 'reasoning_content': 'why',
                      'tool_calls': [{'id': 'call_1', 'name': 'echo', 'input': {}}]}], {'user_id': 3})
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


@pytest.mark.parametrize('streaming', [True, False])
def test_api_error_message_carries_response_body(streaming):
    # Regression: httpx.HTTPStatusError's str(e) has no response body (unlike
    # PHP's Guzzle RequestException message), so DeepSeek's documented 400s
    # ("Thinking mode does not support this tool_choice") must have the body
    # appended or ChatController::humanizeProviderError can't surface them.
    # Covers both the streaming path (body read()'d before re-raise) and the
    # non-streaming path (httpx buffers the body already).
    p = _provider(lambda r: httpx.Response(400, json={'error': {'message': 'Thinking mode does not support this tool_choice'}}), streaming=streaming)
    p.setSSEClient(Rec())
    with pytest.raises(ProviderException) as ei:
        if streaming:
            p.streamChat('x', lambda t: None, [], {'user_id': 3})
        else:
            p.chat('x', [], {'user_id': 3})
    assert 'Thinking mode does not support this tool_choice' in str(ei.value)
    assert ei.value.getHttpStatusCode() == 400


def test_static_builder_and_parser():
    r = DeepSeekProvider.buildHttpRequest('deepseek-v4-flash', [{'role': 'user', 'content': 'hi'}], [], {'api_key': 'K'}, 50, 0.1)
    assert r['url'] == 'https://api.deepseek.com/chat/completions' and r['payload']['thinking'] == {'type': 'enabled'}
    parsed = DeepSeekProvider.parseHttpResponse({'choices': [{'message': {'content': '', 'reasoning_content': 'r'}}], 'usage': {}})
    assert parsed['text'] == 'r'
