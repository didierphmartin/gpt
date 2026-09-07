"""Unit tests for ToolsController — port of Controllers/ToolsController.php (20-366).

PHP-truth strings copied verbatim from the source:
  - "Invalid type filter. Must be: all, builtin, or mcp"  (line 80)
  - "Missing tool_name"                                    (line 193)
  - "Unknown tool: $toolName"                               (line 227)

classifyIntent's LLM call (getLLMManager().chat(...)) is unit-tested only
via a fake AIPortfolioAssistant/LLMManager — never a live provider.
"""
from starlette.datastructures import Headers

from app.controllers.tools_controller import ToolsController
from app.support.http import Ctx

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}


def ctx(method='GET', uri='/api/v1/tools', body=None, query=None, user_id=3):
    c = Ctx(method=method, uri=uri, headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
            params={}, user_id=user_id, authenticated=True, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


class Db:
    """Never actually queried — PackageResolver/MCPToolsLoader/AIPortfolioAssistant
    are faked in every test below."""
    def fetch_all(self, sql, params=None): raise AssertionError(f'unexpected query: {sql}')
    def fetch_one(self, sql, params=None): raise AssertionError(f'unexpected query: {sql}')
    def fetch_column(self, sql, params=None): raise AssertionError(f'unexpected query: {sql}')


class FakeToolsManager:
    def __init__(self, defs=None, functions=None):
        self._defs = defs if defs is not None else []
        self._functions = functions or {}

    def getToolDefinitions(self):
        return self._defs

    def hasFunction(self, name):
        return name in self._functions

    def execute(self, name, params, context):
        return self._functions[name](params, context)


class FakeLLMManager:
    def __init__(self, chat_fn):
        self._chat_fn = chat_fn

    def chat(self, message, history, options):
        return self._chat_fn(message, history, options)


def make_fake_assistant_class(tools_manager=None, llm_manager=None, closed=None):
    class FakeAssistant:
        def __init__(self, config):
            self.config = config

        def getToolsManager(self):
            return tools_manager if tools_manager is not None else FakeToolsManager()

        def getLLMManager(self):
            return llm_manager

        def close(self):
            if closed is not None:
                closed.append(True)

    return FakeAssistant


class FakeMCPToolsLoader:
    def __init__(self, db, has_tools=False, defs=None, mcp_tool_names=(), exec_fn=None, closed=None):
        self._has_tools = has_tools
        self._defs = defs if defs is not None else []
        self._mcp_tool_names = set(mcp_tool_names)
        self._exec_fn = exec_fn
        self._closed = closed
        self.load_calls = []

    def loadToolsForUser(self, userId, allowedServerNames):
        self.load_calls.append((userId, allowedServerNames))
        return {}

    def hasTools(self):
        return self._has_tools

    def getToolDefinitions(self):
        return self._defs

    def isMCPTool(self, name):
        return name in self._mcp_tool_names

    def executeTool(self, name, arguments):
        return self._exec_fn(name, arguments)

    def close(self):
        if self._closed is not None:
            self._closed.append(True)


def patch_common(monkeypatch, assistant_class=None, mcp_loader_factory=None, allowlist=None):
    monkeypatch.setattr('app.controllers.tools_controller.LLMProviderResolver.applyDbSettings',
                         staticmethod(lambda db, cfg: cfg))
    if assistant_class is not None:
        monkeypatch.setattr('app.controllers.tools_controller.AIPortfolioAssistant', assistant_class)

    class PR:
        def __init__(self, db): pass
        def allowedMcpServers(self, uid): return allowlist
    monkeypatch.setattr('app.controllers.tools_controller.PackageResolver', PR)

    if mcp_loader_factory is not None:
        monkeypatch.setattr('app.controllers.tools_controller.MCPToolsLoader', mcp_loader_factory)
    else:
        def _default_factory(db):
            return FakeMCPToolsLoader(db)
        monkeypatch.setattr('app.controllers.tools_controller.MCPToolsLoader', _default_factory)


# ─── list() ──────────────────────────────────────────────────────────────────

def test_list_invalid_type_filter(monkeypatch):
    patch_common(monkeypatch)
    r = ToolsController(Db(), CFG).list(ctx(query={'type': 'bogus'}))
    assert r == {'success': False, 'error': 'Invalid type filter. Must be: all, builtin, or mcp', 'status_code': 400}


def test_list_merges_builtin_and_mcp_ordering_counts_and_defaults(monkeypatch):
    closed = []
    defs = [
        {'name': 'serpapi_search', 'description': 'Search the web', 'input_schema': {'type': 'object', 'properties': {}}},
        {'name': 'no_description_tool'},   # description/input_schema absent -> defaults
    ]
    tm = FakeToolsManager(defs=defs)
    assistant_cls = make_fake_assistant_class(tools_manager=tm, closed=closed)

    mcp_defs = [
        {'name': 'mcp_get_price', 'description': '[MCP:okta] Get the current price', 'input_schema': {'type': 'object', 'properties': {'symbol': {'type': 'string'}}}},
    ]
    mcp_closed = []
    def mcp_factory(db):
        return FakeMCPToolsLoader(db, has_tools=True, defs=mcp_defs, closed=mcp_closed)
    patch_common(monkeypatch, assistant_class=assistant_cls, mcp_loader_factory=mcp_factory, allowlist=None)

    r = ToolsController(Db(), CFG).list(ctx())
    assert r['success'] is True and r['status_code'] == 200
    assert r['counts'] == {'builtin': 2, 'mcp': 1, 'total': 3}
    # builtins first, in ToolsManager order, then MCP
    assert [t['name'] for t in r['tools']] == ['serpapi_search', 'no_description_tool', 'mcp_get_price']
    assert r['tools'][0] == {'name': 'serpapi_search', 'description': 'Search the web', 'type': 'builtin',
                              'input_schema': {'type': 'object', 'properties': {}}}
    # missing description/input_schema default to '' / {}
    assert r['tools'][1] == {'name': 'no_description_tool', 'description': '', 'type': 'builtin', 'input_schema': {}}
    # MCP: server name extracted from the "[MCP:xxx]" prefix and stripped from description
    assert r['tools'][2] == {'name': 'mcp_get_price', 'description': 'Get the current price', 'type': 'mcp',
                              'server': 'okta', 'input_schema': {'type': 'object', 'properties': {'symbol': {'type': 'string'}}}}
    assert closed == [True]        # assistant closed (Python-only)
    assert mcp_closed == [True]    # mcp loader closed (Python-only)


def test_list_type_filter_builtin_skips_mcp_loader(monkeypatch):
    tm = FakeToolsManager(defs=[{'name': 'x', 'description': 'd'}])
    assistant_cls = make_fake_assistant_class(tools_manager=tm)

    def boom(db):
        raise AssertionError('MCPToolsLoader should not be constructed for type=builtin')
    patch_common(monkeypatch, assistant_class=assistant_cls, mcp_loader_factory=boom)

    r = ToolsController(Db(), CFG).list(ctx(query={'type': 'builtin'}))
    assert r['counts'] == {'builtin': 1, 'mcp': 0, 'total': 1}


def test_list_type_filter_mcp_skips_builtin_assistant(monkeypatch):
    def boom(config):
        raise AssertionError('AIPortfolioAssistant should not be constructed for type=mcp')
    mcp_defs = [{'name': 'mcp_x', 'description': '[MCP:s1] d'}]
    def mcp_factory(db):
        return FakeMCPToolsLoader(db, has_tools=True, defs=mcp_defs)
    patch_common(monkeypatch, assistant_class=boom, mcp_loader_factory=mcp_factory)

    r = ToolsController(Db(), CFG).list(ctx(query={'type': 'mcp'}))
    assert r['counts'] == {'builtin': 0, 'mcp': 1, 'total': 1}


def test_list_search_filters_by_name_or_description_case_insensitive(monkeypatch):
    defs = [
        {'name': 'serpapi_search', 'description': 'Search the web via SerpAPI'},
        {'name': 'get_trending_assets', 'description': 'Trending crypto and stocks'},
    ]
    tm = FakeToolsManager(defs=defs)
    assistant_cls = make_fake_assistant_class(tools_manager=tm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    r = ToolsController(Db(), CFG).list(ctx(query={'type': 'builtin', 'search': 'SERP'}))
    assert [t['name'] for t in r['tools']] == ['serpapi_search']
    assert r['counts'] == {'builtin': 2, 'mcp': 0, 'total': 1}   # counts reflect pre-filter builtin total


def test_list_mcp_load_failure_is_logged_and_yields_zero_mcp_tools(monkeypatch):
    tm = FakeToolsManager(defs=[])
    assistant_cls = make_fake_assistant_class(tools_manager=tm)

    def boom(db):
        raise RuntimeError('mcp servers unreachable')
    patch_common(monkeypatch, assistant_class=assistant_cls, mcp_loader_factory=boom)

    r = ToolsController(Db(), CFG).list(ctx())
    assert r['success'] is True
    assert r['counts'] == {'builtin': 0, 'mcp': 0, 'total': 0}


# ─── execute() ───────────────────────────────────────────────────────────────

def test_execute_missing_tool_name_is_400_before_any_construction(monkeypatch):
    def boom(config):
        raise AssertionError('AIPortfolioAssistant must not be constructed when tool_name is missing')
    patch_common(monkeypatch, assistant_class=boom)
    r = ToolsController(Db(), CFG).execute(ctx(method='POST', body={}))
    assert r == {'success': False, 'error': 'Missing tool_name', 'status_code': 400}


def test_execute_unknown_tool_checks_builtin_then_mcp_then_404(monkeypatch):
    tm = FakeToolsManager(functions={})
    assistant_cls = make_fake_assistant_class(tools_manager=tm)
    def mcp_factory(db):
        return FakeMCPToolsLoader(db, mcp_tool_names=())
    patch_common(monkeypatch, assistant_class=assistant_cls, mcp_loader_factory=mcp_factory)

    r = ToolsController(Db(), CFG).execute(ctx(method='POST', body={'tool_name': 'no_such_tool'}))
    assert r == {'success': False, 'error': 'Unknown tool: no_such_tool', 'status_code': 404}


def test_execute_builtin_success_wraps_handler_result(monkeypatch):
    def handler(params, context):
        return {'echo': params, 'user': context}
    tm = FakeToolsManager(functions={'echo_tool': handler})
    assistant_cls = make_fake_assistant_class(tools_manager=tm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    r = ToolsController(Db(), CFG).execute(
        ctx(method='POST', body={'tool_name': 'echo_tool', 'parameters': {'a': 1}}, user_id=42))
    assert r == {'success': True, 'result': {'echo': {'a': 1}, 'user': 42}, 'status_code': 200}


def test_execute_builtin_failure_returns_500_with_exception_message(monkeypatch):
    def handler(params, context):
        raise RuntimeError('boom handler')
    tm = FakeToolsManager(functions={'bad_tool': handler})
    assistant_cls = make_fake_assistant_class(tools_manager=tm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    r = ToolsController(Db(), CFG).execute(ctx(method='POST', body={'tool_name': 'bad_tool'}))
    assert r['success'] is False and r['status_code'] == 500
    assert 'boom handler' in r['error']


def test_execute_falls_back_to_mcp_tool(monkeypatch):
    tm = FakeToolsManager(functions={})
    assistant_cls = make_fake_assistant_class(tools_manager=tm)

    def exec_fn(name, arguments):
        return {'result': f'{name}:{arguments}'}
    def mcp_factory(db):
        return FakeMCPToolsLoader(db, mcp_tool_names={'mcp_get_price'}, exec_fn=exec_fn)
    patch_common(monkeypatch, assistant_class=assistant_cls, mcp_loader_factory=mcp_factory)

    r = ToolsController(Db(), CFG).execute(
        ctx(method='POST', body={'tool_name': 'mcp_get_price', 'parameters': {'symbol': 'AAPL'}}))
    assert r['success'] is True and r['status_code'] == 200
    assert r['result'] == {'result': "mcp_get_price:{'symbol': 'AAPL'}"}


def test_execute_name_and_args_aliases_are_accepted(monkeypatch):
    def handler(params, context):
        return params
    tm = FakeToolsManager(functions={'aliased': handler})
    assistant_cls = make_fake_assistant_class(tools_manager=tm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    r = ToolsController(Db(), CFG).execute(ctx(method='POST', body={'name': 'aliased', 'args': {'x': 1}}))
    assert r == {'success': True, 'result': {'x': 1}, 'status_code': 200}


# ─── classifyIntent() ────────────────────────────────────────────────────────

def test_classify_intent_empty_body_short_circuits(monkeypatch):
    def boom(config):
        raise AssertionError('AIPortfolioAssistant must not be constructed for an empty body')
    patch_common(monkeypatch, assistant_class=boom)

    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body={}))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_blank_transcript_short_circuits(monkeypatch):
    def boom(config):
        raise AssertionError('must not construct assistant')
    patch_common(monkeypatch, assistant_class=boom)

    r = ToolsController(Db(), CFG).classifyIntent(
        ctx(method='POST', body={'transcript': '   ', 'tools': [{'name': 'done'}]}))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_no_tools_short_circuits(monkeypatch):
    def boom(config):
        raise AssertionError('must not construct assistant')
    patch_common(monkeypatch, assistant_class=boom)

    r = ToolsController(Db(), CFG).classifyIntent(
        ctx(method='POST', body={'transcript': 'je vous transfère', 'tools': []}))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_fake_llm_valid_tool_and_args(monkeypatch):
    closed = []
    def chat_fn(message, history, options):
        assert options['system_prompt'].startswith('You are a function-call classifier')
        assert options['tools'] == [] and options['temperature'] == 0 and options['max_tokens'] == 120
        return {'text': 'Sure: {"tool": "handoff_to", "args": {"target": "billing"}}'}
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm, closed=closed)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'je vais vous transférer au service de facturation',
            'tools': [{'name': 'handoff_to', 'description': 'Transfer the caller',
                       'parameters': {'properties': {'target': {'enum': ['billing', 'sales']}}}},
                      {'name': 'end_session', 'description': 'End the call'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    assert r == {'success': True, 'tool': 'handoff_to', 'args': {'target': 'billing'}, 'status_code': 200}
    assert closed == [True]


def test_classify_intent_fake_llm_empty_args_object_encodes_as_php_array(monkeypatch):
    def chat_fn(message, history, options):
        return {'text': '{"tool": "done", "args": {}}'}
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'all set', 'tools': [{'name': 'done'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    # php_array(): an empty PHP associative array json-encodes as [] not {}
    assert r == {'success': True, 'tool': 'done', 'args': [], 'status_code': 200}


def test_classify_intent_fake_llm_tool_not_in_provided_list_is_rejected(monkeypatch):
    def chat_fn(message, history, options):
        return {'text': '{"tool": "delete_everything", "args": {}}'}
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'hello', 'tools': [{'name': 'done'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_fake_llm_null_tool_normal_conversation(monkeypatch):
    def chat_fn(message, history, options):
        return {'text': '{"tool": null, "args": {}}'}
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'how are you today', 'tools': [{'name': 'done'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_fake_llm_unparseable_response_falls_back_to_null(monkeypatch):
    def chat_fn(message, history, options):
        return {'text': 'not json at all'}
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'hello', 'tools': [{'name': 'done'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    assert r == {'success': True, 'tool': None, 'status_code': 200}


def test_classify_intent_llm_exception_returns_500(monkeypatch):
    closed = []
    def chat_fn(message, history, options):
        raise RuntimeError('provider unavailable')
    llm = FakeLLMManager(chat_fn)
    assistant_cls = make_fake_assistant_class(llm_manager=llm, closed=closed)
    patch_common(monkeypatch, assistant_class=assistant_cls)

    body = {'transcript': 'hello', 'tools': [{'name': 'done'}]}
    r = ToolsController(Db(), CFG).classifyIntent(ctx(method='POST', body=body))
    assert r['success'] is False and r['tool'] is None and r['status_code'] == 500
    assert 'provider unavailable' in r['error']
    assert closed == [True]      # assistant still closed on the exception path
