import json
import pytest
from starlette.datastructures import Headers
from app.controllers.provider_controller import ProviderController
from app.support.http import Ctx

ROW = {'provider_key': 'kimi', 'display_name': 'Kimi', 'model': 'kimi-k2.6', 'supported_models': '["kimi-k2.6"]', 'max_tokens': '32768', 'api_format': 'openai',
       'enabled': 1, 'api_key': 'K', 'base_url': 'https://api.moonshot.ai', 'sort_order': 1}
ROW2 = {**ROW, 'provider_key': 'claude', 'display_name': 'Claude', 'model': 'claude-sonnet-4-5', 'supported_models': None, 'max_tokens': '8192', 'api_format': 'anthropic', 'base_url': 'https://api.anthropic.com'}


class Db:
    def __init__(self, keys=('kimi',)): self.keys = list(keys); self.calls = []
    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        if 'FROM system_llm_settings' in sql:
            return [ROW2, ROW]
        return []
    def fetch_column(self, sql, params=None):
        self.calls.append((sql, params))
        if 'FROM user_api_keys' in sql:
            return self.keys
        return []
    def fetch_one(self, sql, params=None): self.calls.append((sql, params)); return None
    def execute(self, sql, params=None): return 1
    def insert(self, sql, params=None): return 1


CFG = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'K'}, 'database': {}, 'contexts_database': {}}


def ctx(body=None, user_id=3):
    c = Ctx(method='GET', uri='/api/v1/providers', headers=Headers({}), query={}, body=body or {}, raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


@pytest.fixture
def quiet(monkeypatch):
    # No DB-backed provider settings, no package restrictions, no MCP servers.
    monkeypatch.setattr('app.controllers.provider_controller.LLMProviderResolver.applyDbSettings', staticmethod(lambda db, cfg: cfg))
    class PR:
        def __init__(self, db): pass
        def resolveForUser(self, uid): return {'capabilities': {}}
        def allowedMcpServers(self, uid): return None
    monkeypatch.setattr('app.controllers.provider_controller.PackageResolver', PR)
    class ML:
        def __init__(self, db): pass
        def loadToolsForUser(self, uid, allow): return {}
        def hasTools(self): return False
        def getTools(self): return {}
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', ML)


def test_list_shape_types_and_key_order(quiet):
    db = Db(); r = ProviderController(db, CFG).list(ctx())
    assert list(r) == ['success', 'providers', 'current_provider', 'user_has_custom_keys', 'user_enabled_providers', 'functions', 'function_count', 'status_code']
    assert r['success'] is True and r['current_provider'] is None and r['status_code'] == 200
    assert [p['name'] for p in r['providers']] == ['claude', 'kimi']
    claude, kimi = r['providers']
    assert list(claude) == ['name', 'display_name', 'model', 'available', 'supported_models', 'max_tokens', 'api_format', 'user_has_key']
    assert claude['supported_models'] == [] and claude['max_tokens'] == 8192 and claude['user_has_key'] is False and claude['available'] is True
    assert kimi['supported_models'] == ['kimi-k2.6'] and kimi['max_tokens'] == 32768 and kimi['user_has_key'] is True
    assert r['user_has_custom_keys'] is True and r['user_enabled_providers'] == ['kimi']
    assert r['functions'][-3:] == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel'] and r['function_count'] == len(r['functions'])
    assert r['functions'][0] == 'serpapi_search'                         # built-ins first, in ToolsManager order
    sql, params = [c for c in db.calls if 'FROM user_api_keys' in c[0]][0]
    assert sql == "SELECT provider FROM user_api_keys WHERE user_id = :user_id AND api_key IS NOT NULL AND api_key != ''" and params == {':user_id': 3}


def test_list_without_user_keys_and_without_user(quiet):
    r = ProviderController(Db(keys=()), CFG).list(ctx())
    assert r['user_has_custom_keys'] is False and r['user_enabled_providers'] == [] and all(p['user_has_key'] is False for p in r['providers'])
    r2 = ProviderController(Db(), CFG).list(ctx(user_id=None))
    assert r2['user_has_custom_keys'] is False and 'FROM user_api_keys' not in ' '.join(s for s, _ in Db().calls)


def test_package_allowlist_filters_and_mcp_tools_are_appended(quiet, monkeypatch):
    class PR:
        def __init__(self, db): pass
        def resolveForUser(self, uid): return {'capabilities': {'providers': {'kimi': {'enabled': True}, 'claude': {'enabled': False}}}}
        def allowedMcpServers(self, uid): return ['S']
    monkeypatch.setattr('app.controllers.provider_controller.PackageResolver', PR)
    class ML:
        def __init__(self, db): self.seen = None
        def loadToolsForUser(self, uid, allow): ML.seen = (uid, allow); return {}
        def hasTools(self): return True
        def getTools(self): return {'mcp_a': {}, 'mcp_b': {}}
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', ML)
    r = ProviderController(Db(), CFG).list(ctx())
    assert [p['name'] for p in r['providers']] == ['kimi']
    assert ML.seen == (None, ['S'])
    assert r['functions'][-5:] == ['mcp_a', 'mcp_b', 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


def test_list_falls_back_to_assistant_providers_when_table_empty(quiet):
    class EmptyDb(Db):
        def fetch_all(self, sql, params=None): return []
    r = ProviderController(EmptyDb(keys=()), CFG).list(ctx())
    assert r['success'] is True and any(p['name'] == 'claude' for p in r['providers'])


def test_mcp_failure_is_logged_not_fatal(quiet, monkeypatch):
    class Boom:
        def __init__(self, db): raise RuntimeError('mcp down')
    monkeypatch.setattr('app.controllers.provider_controller.MCPToolsLoader', Boom)
    r = ProviderController(Db(), CFG).list(ctx())
    assert r['success'] is True and r['functions'][-3:] == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


def test_switch_paths(quiet):
    c = ProviderController(Db(), CFG)
    assert c.switch(ctx(body={})) == {'success': False, 'error': 'Provider name is required', 'status_code': 400}
    assert c.switch(ctx(body={'provider': 'nope'})) == {'success': False, 'error': "Provider 'nope' is not available", 'status_code': 400}
    assert c.switch(ctx(body={'provider': 'claude'})) == {'success': True, 'message': 'Switched to provider: claude', 'current_provider': 'claude', 'status_code': 200}


def test_assistants_are_closed(quiet, monkeypatch):
    closed = []
    import app.controllers.provider_controller as pc
    real = pc.AIPortfolioAssistant
    class Spy(real):
        def close(self): closed.append(True); super().close()
    monkeypatch.setattr(pc, 'AIPortfolioAssistant', Spy)
    c = ProviderController(Db(), CFG); c.list(ctx()); c.switch(ctx(body={'provider': 'claude'})); c.switch(ctx(body={'provider': 'nope'}))
    assert closed == [True, True, True]
