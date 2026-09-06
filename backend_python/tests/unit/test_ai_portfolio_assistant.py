"""Tests for app.ai_portfolio_assistant.AIPortfolioAssistant (port of ToolsForRequestTest.php + wiring)."""
import asyncio
import pytest
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.sse_hub_client import SSEHubClient
from app.support.sse import SseStream

BASE = [{'name': 'serpapi_search'}, {'name': 'search_assets'}]
EXTRA = [{'name': 'mcp_lookup_users'}, {'name': 'mcp_pin_message'}]


def names(x): return [t['name'] for t in x]


def test_default_merges_base_and_caller_tools():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {})) == ['serpapi_search', 'search_assets', 'mcp_lookup_users', 'mcp_pin_message']


def test_skill_turn_keeps_caller_tools_only():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'skill_metadata': {'dir_name': 'x'}})) == ['mcp_lookup_users', 'mcp_pin_message']


def test_empty_filter_yields_no_tools():
    assert AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'tools_filter': []}) == []


def test_filter_keeps_only_named_tools_from_both_sets():
    assert names(AIPortfolioAssistant.resolveToolsForRequest(BASE, EXTRA, {'tools_filter': ['mcp_pin_message', 'search_assets']})) == ['search_assets', 'mcp_pin_message']


def test_constructor_registers_claude_and_search_tools():
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'providers': {'kimi': {'base_url': 'u'}}})
    assert a.getLLMManager().getProvider('claude') is a.getLLMManager().getProvider('anthropic')
    assert a.getLLMManager().getProvider('kimi') is None                      # pending 2b
    assert 'serpapi_search' in a.getToolsManager().getRegisteredFunctions()
    assert a.getAllProviders()[0]['name'] == 'claude' and a.getCurrentProvider() == 'claude'
    with pytest.raises(ValueError, match="Provider 'kimi' is not available"):
        a.setProvider('kimi')


def test_stream_chat_wires_sse_client_and_requires_provider():
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}})
    class FakeProv:
        def __init__(self): self.sse = None
        def setSSEClient(self, c): self.sse = c
        def isAvailable(self): return True
        def getName(self): return 'claude'
        def getModel(self): return 'm'
        def getSupportedModels(self): return []
        def streamChat(self, message, onChunk, history=None, options=None):
            onChunk('piece'); return {'text': 'piece', 'usage': {}}
    fp = FakeProv(); a.getLLMManager().registerProvider('claude', fp)
    async def run():
        loop = asyncio.get_running_loop(); s = SseStream(loop)
        SSEHubClient.current_stream.set(s)
        # asyncio.to_thread (not raw loop.run_in_executor) is required here:
        # it copies the current contextvars.Context into the worker thread
        # (via contextvars.copy_context().run(...)), same as Starlette's
        # run_in_threadpool does for real requests. A bare run_in_executor
        # spawns a thread with a fresh empty Context, so the ContextVar set
        # above would be invisible to SSEHubClient.create() inside streamChat
        # and every frame would silently no-op (verified empirically).
        out = await asyncio.to_thread(a.streamChat, 'hi', 'sess1', 3, [], {'provider': 'claude', 'tools': []})
        frames = []
        while not s.queue.empty(): frames.append(await s.queue.get())
        return out, frames
    out, frames = asyncio.run(run())
    assert out['provider_used'] == 'claude' and fp.sse.getSessionId() == 'sess1'
    assert frames[0] == b'event: chunk\ndata: piece\n\n' and frames[1].startswith(b'event: response\ndata: {"text":"piece"') and frames[-1] == b'event: complete\ndata: {"status":"done"}\n\n'
    with pytest.raises(ValueError, match="AIPortfolioAssistant::streamChat requires \\$options\\['provider'\\]"):
        a.streamChat('hi', 's', 3, [], {})
