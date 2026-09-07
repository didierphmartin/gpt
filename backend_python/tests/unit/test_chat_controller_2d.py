"""Phase 2d flows: /agent, /verify, /compare and the in-chat verification /
comparison phases (PHP ChatController::agent 942-1008, verify 1009-1178,
compareOnly 1179-1498, handleVerification 2091-2189, handleComparison 2190-2359)."""
import asyncio
from app.controllers.chat_controller import ChatController
from app.support.sse import SseStream
from tests.unit.test_chat_controller_flows import Db, CFG, ctx, FakeAssistant


class Assistant(FakeAssistant):
    """LLMManager fake with chat/streamChat + getProvider for a second provider."""
    def __init__(self, config):
        super().__init__(config)
        outer = self
        class L:
            def getProvider(self, n): return object() if n in ('claude', 'kimi') else None
            def chat(self, message, history, options): return outer.chat(message, options.get('user_id'), history, options)
            def streamChat(self, message, onChunk, history, options):
                onChunk('hel'); onChunk('lo'); return outer.chat(message, options.get('user_id'), history, options)
        self.llm = L()


def _events(s):
    out = []
    while not s.queue.empty():
        f = s.queue.get_nowait()
        if f is None: break
        out.append(f.split(b'\n', 1)[0].decode())
    return out


def test_agent_validation_and_success(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.agent(ctx({'prompt': '', 'provider': 'claude'})) == {'success': False, 'error': 'prompt is required', 'status_code': 400}
    assert c.agent(ctx({'prompt': 'hi'})) == {'success': False, 'error': 'provider is required', 'status_code': 400}
    assert c.agent(ctx({'prompt': 'hi', 'provider': 'nope'})) == {'success': False, 'error': "Provider 'nope' not available", 'status_code': 400}
    r = c.agent(ctx({'prompt': 'hi', 'provider': 'claude', 'system': 'SYS'}))
    assert list(r) == ['success', 'text', 'usage', 'provider', 'model'] and r['text'] == 'reply' and r['provider'] == 'claude'
    assert FakeAssistant.last[3]['system_prompt'] == 'SYS' and FakeAssistant.last[3]['tools'] == []


def test_verify_validation_and_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.verify(ctx({'original_message': 'q', 'response_text': ''})) == {'success': False, 'error': 'original_message, response_text, and verifier_provider are required', 'status_code': 400}
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        r = await loop.run_in_executor(None, c.verify, ctx({'original_message': 'q', 'response_text': 'a', 'verifier_provider': 'kimi'}, sse=s))
        return r, _events(s)
    r, names = asyncio.run(run())
    assert r == {'streaming': True}
    assert names[0] == 'event: verification_start' and names[-1] == 'event: verification_complete'
    assert 'event: verifier_chunk' in names and 'event: verification_response' in names
    assert names.index('event: verification_response') < names.index('event: verification_complete')


def test_compare_only_validation_and_event_sequence(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    c = ChatController(Db(), CFG)
    assert c.compareOnly(ctx({'message': 'q'})) == {'success': False, 'error': 'message and compare_provider are required', 'status_code': 400}
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        r = await loop.run_in_executor(None, c.compareOnly, ctx({'message': 'q', 'compare_provider': 'kimi', 'tools': [], 'memory': False}, sse=s))
        return r, _events(s)
    r, names = asyncio.run(run())
    assert r == {'streaming': True} and names[0] == 'event: compare_start' and names[-1] == 'event: compare_complete'
    assert 'event: compare_chunk' in names and 'event: compare_response' in names


def test_chat_with_verification_and_compare_phases(monkeypatch):
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Assistant)
    monkeypatch.setattr('app.controllers.chat_controller.MemoryAutoUpdater', lambda db, key: type('U', (), {'run': lambda s, *a: None})())
    c = ChatController(Db(), CFG)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        await loop.run_in_executor(None, c.chat, ctx({'message': 'hi', 'provider': 'claude', 'streaming': True, 'tools': [], 'memory': False,
                                                    'verification_enabled': True, 'verifier_provider': 'kimi', 'compare_enabled': True, 'compare_provider': 'kimi'}, sse=s))
        return _events(s)
    names = asyncio.run(run())
    i_resp, i_vs, i_cs, i_done = names.index('event: response'), names.index('event: verification_start'), names.index('event: compare_start'), names.index('event: complete')
    assert i_resp < i_vs < names.index('event: verification_complete') < i_cs < names.index('event: compare_complete') < i_done


def test_verify_error_path_emits_error_and_complete(monkeypatch):
    class Boom(Assistant):
        def __init__(self, config):
            super().__init__(config)
            class L:
                def getProvider(self, n): return object()
                def streamChat(self, *a): raise RuntimeError('kimi API error: 503 Service Unavailable')
            self.llm = L()
    monkeypatch.setattr('app.controllers.chat_controller.AIPortfolioAssistant', Boom)
    c = ChatController(Db(), CFG)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        await loop.run_in_executor(None, c.verify, ctx({'original_message': 'q', 'response_text': 'a', 'verifier_provider': 'kimi'}, sse=s)); return _events(s)
    names = asyncio.run(run())
    assert names[-2:] == ['event: verification_error', 'event: verification_complete']
