import asyncio
import pytest
from starlette.datastructures import Headers
from app.controllers.chat_controller import ChatController
from app.support.http import Ctx
from app.support.sse import SseStream


class Db:
    def __init__(self): self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return []
    def fetch_column(self, s, p=None): self.calls.append((s, p)); return []
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


CFG = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'K', 'model': 'm'}, 'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'}, 'database': {}}


def ctx(body, user_id=3, auth_type='jwt', sse=None):
    c = Ctx(method='POST', uri='/api/v1/chat', headers=Headers({}), query={}, body=body, raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')
    c['auth_type'] = auth_type; c['sse'] = sse; c['files'] = {}
    return c


def test_validation_paths():
    c = ChatController(Db(), CFG)
    assert c.chat(ctx({'message': 'x', 'tools': 'bad'})) == {'success': False, 'error': 'tools must be an array of tool names', 'status_code': 400}
    assert c.chat(ctx({'message': ''})) == {'success': False, 'error': 'Message is required', 'status_code': 400}
    r = c.chat(ctx({'message': 'x'}, auth_type='app_key'))
    assert r == {'success': False, 'error': 'App key not authorized for chat (missing scope "chat")', 'status_code': 403}


class FakeAssistant:
    def __init__(self, config): self.config = config; self.tm = __import__('app.services.tools_manager', fromlist=['ToolsManager']).ToolsManager(); self.llm = type('L', (), {'getProvider': lambda s, n: None})()
    def getToolsManager(self): return self.tm
    def getLLMManager(self): return self.llm
    def chat(self, message, userId, history, options):
        FakeAssistant.last = (message, userId, history, options); return {'text': 'reply', 'usage': {'input_tokens': 1, 'output_tokens': 2, 'total_tokens': 3, 'function_calls': 0}, 'model': 'm', 'provider': 'claude', 'provider_used': 'claude', 'functions_called': [], 'mcp_tools_called': [], 'mcp_calls_count': 0}
    def streamChat(self, message, sessionId, userId, history, options):
        from app.services.sse_hub_client import SSEHubClient
        s = SSEHubClient.current_stream.get(); s.send('progress', 'Claude: Thinking...'); s.send('chunk', 'rep'); s.send('chunk', 'ly')
        return self.chat(message, userId, history, options)


def test_regular_chat_builds_options_and_logs_usage(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    db = Db(); c = ChatController(db, CFG)
    r = c.chat(ctx({'message': 'hi', 'provider': 'claude', 'tools': [], 'memory': False, 'return_context': True, 'system_prompt': ' SP ', 'max_tokens': '512', 'temperature': '0.2'}))
    assert r['success'] is True and r['text'] == 'reply' and r['provider'] == 'claude' and r['status_code'] == 200
    assert r['context']['provider'] == 'claude' and r['context']['system_prompt'] == 'SP' and r['context']['max_tokens'] == 512 and r['context']['temperature'] == 0.2
    m, uid, hist, opts = FakeAssistant.last
    assert uid == '3' and opts['provider'] == 'claude' and opts['tools_filter'] == [] and opts['system_prompt'] == 'SP' and 'memory_context' not in opts
    assert any('INSERT INTO llm_usage_transactions' in s for s, _ in db.calls)


def test_regular_chat_schedules_memory_update_after_response(monkeypatch):
    ran = []
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater',
                        lambda db, key: type('U', (), {'run': lambda s, *a: ran.append(a)})())
    c = ChatController(Db(), CFG)
    request = ctx({'message': 'hi', 'provider': 'claude', 'tools': [], 'memory': True})
    r = c.chat(request)
    assert r['success'] is True
    # PHP registers a shutdown function; the port hands main.py a callable to run
    # after render() — nothing has run yet at return time.
    assert ran == [] and callable(request.get('_after_response'))
    request['_after_response']()
    assert len(ran) == 1 and ran[0][0] == 3 and ran[0][2] == 'hi' and ran[0][3] == 'reply'


def test_streaming_chat_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        c = ChatController(Db(), CFG)
        out = await loop.run_in_executor(None, c.chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        frames = []
        while not s.queue.empty():
            f = await s.queue.get()
            if f is not None:                 # drop the end() sentinel
                frames.append(f)
        return out, frames
    out, frames = asyncio.run(run())
    assert out == {'streaming_handled': True, 'status_code': 200}
    names = [f.split(b'\n', 1)[0] for f in frames]
    assert names == [b'event: progress', b'event: chunk', b'event: chunk', b'event: response', b'event: complete']
    assert frames[-2].startswith(b'event: response\ndata: {"success":true,"text":"reply","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"function_calls":0},"provider":"claude"}')
    assert frames[-1] == b'event: complete\ndata: {"status":"done"}\n\n'


def test_streaming_chat_returns_context_when_asked(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        c = ChatController(Db(), CFG)
        await loop.run_in_executor(None, c.chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True,
                                                     'tools': [], 'memory': False, 'return_context': True,
                                                     'system_prompt': 'SP'}, sse=s))
        frames = []
        while not s.queue.empty():
            f = await s.queue.get()
            if f is not None:
                frames.append(f)
        return frames
    frames = asyncio.run(run())
    import json
    resp = [f for f in frames if f.startswith(b'event: response')][0]
    payload = json.loads(resp.split(b'data: ', 1)[1].rsplit(b'\n\n', 1)[0])
    assert payload['context']['provider'] == 'claude' and payload['context']['system_prompt'] == 'SP'
    assert payload['context']['model'] == 'm'


def test_streaming_error_emits_humanized_error(monkeypatch):
    class Boom(FakeAssistant):
        def streamChat(self, *a):
            from app.services.sse_hub_client import SSEHubClient
            SSEHubClient.current_stream.get().send('error', '{"error":true,"message":"claude API error: 503 Service Unavailable","code":500}')
            raise RuntimeError('claude API error: 503 Service Unavailable')
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Boom)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        db = Db(); await loop.run_in_executor(None, ChatController(db, CFG).chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        frames = []
        while not s.queue.empty():
            f = await s.queue.get()
            if f is not None:
                frames.append(f)
        return frames, db
    frames, db = asyncio.run(run())
    assert frames[-1].startswith(b'event: error\ndata: {"message":"\xe2\x8f\xb3 The model provider is temporarily overloaded')
    assert any(p and p.get(':status') == 'error' for _, p in db.calls if isinstance(p, dict))


def test_client_abort_logs_aborted_transaction(monkeypatch):
    class Slow(FakeAssistant):
        def streamChat(self, *a):
            from app.services.sse_hub_client import SSEHubClient
            s = SSEHubClient.current_stream.get(); s.mark_aborted(); s.send('chunk', 'x')
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Slow)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop); db = Db()
        out = await loop.run_in_executor(None, ChatController(db, CFG).chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        return out, db
    out, db = asyncio.run(run())
    assert out == {'streaming_handled': True, 'status_code': 200}
    # error_message picks up UsageLogger's " | PRICING_ERROR: ..." suffix because the
    # fake DB has no system_llm_settings pricing row — assert the prefix.
    assert any(isinstance(p, dict) and p.get(':status') == 'aborted'
               and str(p.get(':error_message')).startswith('Cancelled by user') for _, p in db.calls)


def test_usage_logging_failure_after_complete_still_reaches_client(monkeypatch):
    # PHP ends the response (fastcgi_finish_request) only inside the memory
    # block, AFTER usage logging; a throw in the usage tail therefore still
    # produces an `error` SSE event. The port must not end the stream earlier.
    calls = []
    class BrokenLogger:
        def __init__(self, *a, **k): pass
        def logTransaction(self, data):
            calls.append(data['status'])
            if data['status'] == 'success':
                raise RuntimeError('usage insert failed')
            return 1
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr('app.controllers.chat_controller.UsageLogger', BrokenLogger)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        await loop.run_in_executor(None, ChatController(Db(), CFG).chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False}, sse=s))
        delivered = []
        while not s.queue.empty():
            f = await s.queue.get()
            if f is None:                     # end() sentinel: main.py's generator stops here
                break
            delivered.append(f)
        return delivered
    delivered = asyncio.run(run())
    names = [f.split(b'\n', 1)[0] for f in delivered]
    assert names[-2:] == [b'event: complete', b'event: error']
    assert calls == ['success', 'error']
