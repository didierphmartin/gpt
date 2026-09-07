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
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'providers': {'kimi': {}}})
    assert a.getLLMManager().getProvider('claude') is a.getLLMManager().getProvider('anthropic')
    assert a.getLLMManager().getProvider('kimi') is None                      # not configured in this fixture
    assert 'serpapi_search' in a.getToolsManager().getRegisteredFunctions()
    assert a.getAllProviders()[0]['name'] == 'claude' and a.getCurrentProvider() == 'claude'
    with pytest.raises(ValueError, match="Provider 'kimi' is not available"):
        a.setProvider('kimi')


def test_configured_providers_are_registered_with_dedicated_or_custom_classes():
    from app.providers.kimi_provider import KimiProvider
    from app.providers.gemini_provider import GeminiProvider
    from app.providers.openai_provider import OpenAIProvider
    from app.providers.custom_provider import CustomProvider
    cfg = {'claude': {'api_key': 'K'}, 'openai': {'api_key': 'O'},
           'providers': {'kimi': {'api_key': 'K1', 'base_url': 'https://api.moonshot.ai'},
                         'gemini': {'api_key': 'G', 'base_url': 'https://generativelanguage.googleapis.com/v1beta'},
                         'glm': {'api_key': 'Z', 'base_url': 'https://api.z.ai/api/paas/v4', 'model': 'glm-5.2'},
                         'nobase': {'api_key': 'X'}}}
    a = AIPortfolioAssistant(cfg)
    lm = a.getLLMManager()
    try:
        assert isinstance(lm.getProvider('openai'), OpenAIProvider)
        assert isinstance(lm.getProvider('kimi'), KimiProvider)
        assert isinstance(lm.getProvider('gemini'), GeminiProvider)
        glm = lm.getProvider('glm'); assert isinstance(glm, CustomProvider) and glm.getName() == 'glm' and glm.getModel() == 'glm-5.2'
        assert lm.getProvider('nobase') is None                             # empty base_url → skipped, like PHP
        assert lm.getProvider('anthropic') is lm.getProvider('claude')
        for name in ('openai', 'kimi', 'gemini', 'glm'):
            assert lm.getProvider(name).functionExecutor is a.getToolsManager()
        assert lm.fallbackOrder == ['claude', 'openai', 'kimi', 'gemini', 'glm', 'nobase']
    finally:
        a.close()
    for name in ('openai', 'kimi', 'gemini', 'glm'):
        assert lm.getProvider(name).httpClient.is_closed


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


def test_from_config_file_loads_claude_provider(tmp_path):
    import json
    p = tmp_path / 'config.json'
    p.write_text(json.dumps({'claude': {'api_key': 'K'}}))
    a = AIPortfolioAssistant.fromConfigFile(str(p))
    assert a.getLLMManager().getProvider('claude').isAvailable() is True


def test_close_closes_llm_manager_and_search_functions():
    """Important #2: AIPortfolioAssistant.close() aggregates the LLM manager
    (closes every registered provider's httpx.Client) and this instance's
    SearchFunctions httpx.Client."""
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}})
    claude = a.getLLMManager().getProvider('claude')
    search_http = a._searchFunctions.httpClient
    assert claude.httpClient.is_closed is False and search_http.is_closed is False
    a.close()
    assert claude.httpClient.is_closed is True and search_http.is_closed is True


def test_set_database_registers_portfolio_watchlist_analysis_functions_in_php_order():
    class Db:
        def fetch_all(self, *a): return []
        def fetch_one(self, *a): return None
        def fetch_column(self, *a): return []
        def execute(self, *a): return 1
        def insert(self, *a): return 1
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'tracking': {'enabled': False}})
    try:
        before = a.getToolsManager().getRegisteredFunctions()
        a.setDatabase(Db())
        after = a.getToolsManager().getRegisteredFunctions()
        assert after[:len(before)] == before
        assert after[len(before):] == ['get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions',
                                       'get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist',
                                       'get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment']
    finally:
        a.close()
    assert a._analysisFunctions.httpClient.is_closed


def test_repeated_set_database_closes_previous_analysis_functions():
    # Minor #5 (final review): setDatabase() -> _registerDatabaseFunctions()
    # builds a fresh AnalysisFunctions (and its httpx.Client) every call;
    # calling setDatabase() twice must close the FIRST one instead of just
    # overwriting self._analysisFunctions and leaking its connection pool.
    class Db:
        def fetch_all(self, *a): return []
        def fetch_one(self, *a): return None
        def fetch_column(self, *a): return []
        def execute(self, *a): return 1
        def insert(self, *a): return 1
    a = AIPortfolioAssistant({'claude': {'api_key': 'K'}, 'tracking': {'enabled': False}})
    try:
        a.setDatabase(Db())
        first = a._analysisFunctions
        assert first.httpClient.is_closed is False
        a.setDatabase(Db())
        second = a._analysisFunctions
        assert second is not first
        assert first.httpClient.is_closed is True          # the leaked one is now closed
        assert second.httpClient.is_closed is False         # the current one stays open
    finally:
        a.close()
