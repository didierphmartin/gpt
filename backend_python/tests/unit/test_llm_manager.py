"""Tests for app.services.llm_manager.LLMManager (port of LLMManagerHistoryTest.php + extras)."""
import pytest
from app.config_.configuration import Configuration
from app.services.llm_manager import LLMManager
from app.exceptions import ProviderException


class Prov:
    def __init__(self, name, avail=True): self.n = name; self.a = avail; self.last = None
    def getName(self): return self.n
    def isAvailable(self): return self.a
    def getModel(self): return 'm'
    def getSupportedModels(self): return ['m']
    def chat(self, message, history=None, options=None): self.last = (message, history, options); return {'text': 'ok'}
    def streamChat(self, message, onChunk, history=None, options=None): onChunk('c'); self.last = (message, history, options); return {'text': 'ok'}


def test_assistant_tool_call_turn_keeps_reasoning_content():
    m = LLMManager(Configuration({}))
    out = m.normalizeConversationHistory([
        {'role': 'user', 'content': 'Create a playbook'},
        {'role': 'assistant', 'content': '', 'reasoning_content': 'I should discover the skill first.',
         'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'discover_skill', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': '{"ok":true}'}])
    assert out[1]['role'] == 'assistant' and out[1]['reasoning_content'] == 'I should discover the skill first.' and out[1]['tool_calls'][0]['id'] == 'c1'
    assert out[2] == {'role': 'tool', 'tool_call_id': 'c1', 'content': '{"ok":true}'}


def test_assistant_tool_call_turn_without_reasoning_has_no_key():
    out = LLMManager(Configuration({})).normalizeConversationHistory([
        {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'x', 'arguments': '{}'}}]}])
    assert 'reasoning_content' not in out[0]


def test_normalize_roles_blanks_blocks_and_tool_results():
    m = LLMManager(Configuration({}))
    out = m.normalizeConversationHistory([
        {'role': 'model', 'content': [{'type': 'text', 'text': 'a'}, {'type': 'tool_use', 'name': 'srch'}, {'type': 'tool_result'}]},
        {'role': 'user', 'content': '   '},
        {'role': 'user', 'text': 'from text', 'provider': 'kimi', 'tool_results': [{'name': 't1'}, {'tool_name': 't2'}]},
        'garbage'])
    assert out == [{'role': 'assistant', 'content': 'a\n[Called tool: srch]\n[Tool returned results]'},
                   {'role': 'user', 'content': 'from text\n\n[Tool Results: t1, t2]'}]


def test_chat_and_stream_require_provider_and_availability():
    m = LLMManager(Configuration({'default_provider': 'claude'}))
    m.registerProvider('claude', Prov('claude')); m.registerProvider('dead', Prov('dead', False))
    with pytest.raises(ValueError, match="LLMManager::chat requires \\$options\\['provider'\\] to be set explicitly"):
        m.chat('x', [], {})
    with pytest.raises(ProviderException, match="Provider 'nope' not found"):
        m.chat('x', [], {'provider': 'nope'})
    with pytest.raises(ProviderException, match="Provider 'dead' is not available \\(check API key\\)"):
        m.streamChat('x', lambda c: None, [], {'provider': 'dead'})
    out = m.chat('x', [{'role': 'user', 'content': 'h'}], {'provider': 'claude'})
    assert out == {'text': 'ok', 'provider_used': 'claude', 'fallback_used': False}
    got = []
    assert m.streamChat('x', got.append, [], {'provider': 'claude'})['provider_used'] == 'claude' and got == ['c']
    assert m.getAvailableProviders() == ['claude'] and m.getDefaultProvider().getName() == 'claude'
    assert m.getProviderInfo('dead') == {'name': 'dead', 'model': 'm', 'available': False, 'supported_models': ['m']}
    assert m.getProviderInfo('zz') == {'error': "Provider 'zz' not found"}


def test_close_closes_registered_providers_once_each_and_tolerates_no_close():
    """Important #2: LLMManager.close() closes every registered provider that
    has a close(); providers registered under multiple names for the SAME
    instance (e.g. 'claude'/'anthropic' alias) must only be closed once, and
    a provider without close() must not raise."""
    class Closeable(Prov):
        def __init__(self, name):
            super().__init__(name)
            self.close_calls = 0
        def close(self):
            self.close_calls += 1

    m = LLMManager(Configuration({}))
    shared = Closeable('claude')
    m.registerProvider('claude', shared)
    m.registerProvider('anthropic', shared)         # same instance, second name
    m.registerProvider('bare', Prov('bare'))          # no close() at all

    m.close()

    assert shared.close_calls == 1
