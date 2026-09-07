"""AdminController (part 2: usage stats, MCP admin, user MCP overrides, costs,
exchange rates) unit tests — PHP-truth strings, byte-identical SQL, and
external-call shapes pinned via httpx.MockTransport.

PHP source: backend/src/Controllers/AdminController.php (1060-3754).
Reuses the FakeDb/ctx/c/sqls/CONFIG helpers from test_admin_controller.py
(Task 2's part 1 suite) rather than duplicating them.
"""
from __future__ import annotations

import json

import httpx
import pytest

import app.controllers.admin_controller as admin_mod
from app.controllers.admin_controller import AdminController, _filter_validate_url, _strip_tags
from tests.unit.test_admin_controller import CONFIG, FakeDb as BaseFakeDb, ctx, sqls


class FakeDb(BaseFakeDb):
    """Extends the part-1 FakeDb with the extra presence checks Task 3's
    methods need: mcp_servers/provider_costs/exchange_rates table presence,
    and the two `information_schema.statistics` index checks ensureMCPSchema
    performs directly (DbPresence only covers table/column, not indexes)."""

    def __init__(self, *a, mcp_index_present=True, **kw):
        super().__init__(*a, **kw)
        self.mcp_index_present = mcp_index_present

    def _presence(self, sql):
        p = super()._presence(sql)
        if p is not None:
            return p
        if 'information_schema.statistics' in sql and "'unique_server_name'" in sql:
            return [{'c': 0}]
        if 'information_schema.statistics' in sql and "'unique_scope_name'" in sql:
            return [{'c': 1 if self.mcp_index_present else 0}]
        return None


def c(db=None, config=None):
    return AdminController(db if db is not None else FakeDb(), config if config is not None else CONFIG)


def _patch_httpx_client(monkeypatch, handler):
    """Redirect every `httpx.Client(...)` construction in admin_controller.py
    to a MockTransport-backed client, dropping the `verify=` kwarg (a real
    SSLContext object isn't meaningful against a mock transport)."""
    class _Wrapped(httpx.Client):
        def __init__(self, *a, **kw):
            kw.pop('verify', None)
            super().__init__(*a, transport=httpx.MockTransport(handler), **kw)
    monkeypatch.setattr(admin_mod.httpx, 'Client', _Wrapped)


# ─── _filter_validate_url / _strip_tags (module-private helpers) ───────────

def test_filter_validate_url():
    assert _filter_validate_url('https://example.com/mcp') is True
    assert _filter_validate_url('http://sub.example.com:8080/x?y=1') is True
    assert _filter_validate_url('not a url') is False
    assert _filter_validate_url('ftp://host') is True
    assert _filter_validate_url('http://') is False


def test_strip_tags():
    assert _strip_tags('<p>hi <b>there</b></p>') == 'hi there'
    assert _strip_tags('no tags') == 'no tags'


# ─── getDateRange (1929-1957) ───────────────────────────────────────────────

def test_get_date_range_explicit():
    r = c().getDateRange('month', '2026-01-01', '2026-01-31')
    assert r == {'from': '2026-01-01', 'to': '2026-01-31'}


def test_get_date_range_all():
    r = c().getDateRange('all')
    assert r['from'] == '2000-01-01 00:00:00'
    assert r['to'].endswith('23:59:59')


def test_get_date_range_day_week_month_year_default():
    for period in ('day', 'week', 'month', 'year', 'bogus'):
        r = c().getDateRange(period)
        assert r['from'].endswith('00:00:00')
        assert r['to'].endswith('23:59:59')


# ─── getUsageStats (1060) ────────────────────────────────────────────────────

def test_get_usage_stats_sql_and_rounding():
    db = FakeDb(
        one=[{'total_requests': 3, 'successful_requests': 2, 'failed_requests': 1,
              'total_prompt_tokens': 100, 'total_completion_tokens': 50, 'total_tokens': 150,
              'total_cost': '0.326850', 'avg_response_time': '812.5', 'unique_users': 2,
              'total_voice_requests': 1, 'total_audio_seconds': '12.345', 'total_voice_cost': '0.01',
              'total_function_calls': 4, 'total_mcp_calls': 2}],
        all_=[
            [{'provider': 'claude', 'requests': 2, 'tokens': 100, 'cost': '0.2', 'avg_response_time': '500',
              'voice_requests': 0, 'audio_seconds': 0, 'voice_cost': 0, 'function_calls': 2, 'mcp_calls': 1}],
            [{'date': '2026-01-01', 'requests': 3, 'cost': '0.3', 'tokens': 150}],
        ],
    )
    r = c(db).getUsageStats(ctx(query={'period': 'week'}))
    assert r['success'] is True
    assert r['overall']['total_cost'] == 0.3269  # PHP round() half-away-from-zero, not Python's round-half-even
    assert r['overall']['total_requests'] == 3
    assert r['by_provider'][0]['provider'] == 'claude'
    assert r['daily_trend'][0]['date'] == '2026-01-01'
    assert 'WHERE created_at BETWEEN :date_from AND :date_to' in sqls(db)[0]
    assert 'GROUP BY provider ORDER BY cost DESC' in sqls(db)[1]
    assert 'GROUP BY DATE(created_at) ORDER BY date ASC' in sqls(db)[2]


def test_get_usage_stats_db_error():
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db down')
    r = c(Boom()).getUsageStats(ctx())
    assert r == {'success': False, 'error': 'db down', 'status_code': 500}


# ─── getUsageByUser (1184) ───────────────────────────────────────────────────

def test_get_usage_by_user_limit_clamp_and_shape():
    db = FakeDb(
        one=[{'total': 1}],
        all_=[[{'user_id': 7, 'email': None, 'first_name': None, 'last_name': None,
                'total_requests': 1, 'total_tokens': 10, 'total_cost': '0.1', 'avg_response_time': '10',
                'last_activity': '2026-01-01', 'voice_requests': 0, 'audio_seconds': 0, 'voice_cost': 0,
                'function_calls': 0, 'mcp_calls': 0}]],
    )
    r = c(db).getUsageByUser(ctx(query={'limit': '9999', 'offset': '5'}))
    assert r['pagination'] == {'total': 1, 'limit': 100, 'offset': 5}  # clamped to 100
    assert r['users'][0]['email'] == 'Unknown'
    assert r['users'][0]['name'] == 'Unknown'
    assert 'LIMIT :limit OFFSET :offset' in sqls(db)[0]
    assert db.calls[0][1][':limit'] == 100 and db.calls[0][1][':offset'] == 5


# ─── getUserUsageDetail (1270) ───────────────────────────────────────────────

def test_get_user_usage_detail_not_found():
    r = c(FakeDb(one=[None])).getUserUsageDetail(ctx(), 999)
    assert r == {'success': False, 'error': 'User not found', 'status_code': 404}


def test_get_user_usage_detail_decodes_functions_called():
    db = FakeDb(
        one=[{'id': 3, 'email': 'a@b.com', 'first_name': 'A', 'last_name': 'B'},
             {'total_requests': 1, 'successful_requests': 1, 'total_tokens': 10, 'total_cost': '0.01',
              'avg_response_time': '5', 'voice_requests': 0, 'audio_seconds': 0, 'voice_cost': 0,
              'function_calls': 1, 'mcp_calls': 0}],
        all_=[
            [],  # by_provider
            [{'id': 1, 'provider': 'claude', 'model': 'x', 'prompt_tokens': 1, 'completion_tokens': 1,
              'total_tokens': 2, 'cost_usd': '0.000001', 'response_time_ms': 5, 'status': 'success',
              'function_calls_count': 1, 'created_at': '2026-01-01', 'is_voice_request': 0,
              'audio_duration_seconds': 0, 'audio_input_seconds': 0, 'audio_output_seconds': 0,
              'mcp_calls_count': 0, 'functions_called': '["search"]', 'mcp_tools_called': None}],
        ],
    )
    r = c(db).getUserUsageDetail(ctx(), 3)
    assert r['success'] is True
    assert r['user'] == {'id': 3, 'email': 'a@b.com', 'name': 'A B'}
    txn = r['recent_transactions'][0]
    assert txn['functions_called'] == ['search']
    assert txn['mcp_tools_called'] == []
    assert txn['cost'] == 0.000001


# ─── getUsageTransactions (1410) ─────────────────────────────────────────────

def test_get_usage_transactions_dynamic_where():
    db = FakeDb(one=[{'total': 0}], all_=[[]])
    r = c(db).getUsageTransactions(ctx(query={'provider': 'claude', 'user_id': '5', 'status': 'error',
                                              'date_from': '2026-01-01', 'date_to': '2026-01-31',
                                              'limit': '9999', 'offset': '2'}))
    assert r['pagination'] == {'total': 0, 'limit': 500, 'offset': 2}
    sql = sqls(db)[0]
    assert ('WHERE t.provider = :provider AND t.user_id = :user_id AND t.status = :status'
           ' AND t.created_at >= :date_from AND t.created_at <= :date_to') in sql
    params = db.calls[0][1]
    assert params == {':provider': 'claude', ':user_id': 5, ':status': 'error',
                      ':date_from': '2026-01-01', ':date_to': '2026-01-31', ':limit': 500, ':offset': 2}


def test_get_usage_transactions_no_filters_no_where():
    db = FakeDb(one=[{'total': 0}], all_=[[]])
    c(db).getUsageTransactions(ctx())
    sql = sqls(db)[0]
    assert 'WHERE' not in sql
    assert 'ORDER BY t.created_at DESC' in sql


# ─── getToolStats (1529) ─────────────────────────────────────────────────────

def test_get_tool_stats_aggregation_and_registry_lookup():
    db = FakeDb(
        one=[{'total_requests': 2, 'total_function_calls': 3, 'total_mcp_calls': 1, 'requests_with_tools': 2}],
        all_=[
            [{'tool_name': 'search_web', 'server_name': 'Search', 'server_id': 9}],  # loadRegisteredMCPTools
            [{'provider': 'claude', 'function_calls': 3, 'mcp_calls': 1}],           # by_provider
            [  # tools rows
                {'user_id': 1, 'functions_called': '["get_time"]', 'mcp_tools_called': '["search_web"]',
                 'created_at': '2026-01-02'},
                {'user_id': 2, 'functions_called': '["get_time"]', 'mcp_tools_called': None,
                 'created_at': '2026-01-01'},
            ],
            [],  # loadAllAvailableMCPTools query
        ],
    )
    r = c(db).getToolStats(ctx())
    assert r['success'] is True
    assert r['unique_tools_count'] == 2
    names = {t['name']: t for t in r['top_tools']}
    assert names['get_time']['count'] == 2 and names['get_time']['is_mcp'] is False
    assert names['search_web']['is_mcp'] is True
    assert names['search_web']['mcp_server'] == 'Search'
    assert names['get_time']['last_used'] == '2026-01-02'  # max of the two rows
    assert r['total_mcp_calls'] == 1
    assert r['mcp_servers'][0]['name'] == 'Search'
    assert r['mcp_servers'][0]['total_calls'] == 1
    assert r['tool_usage_rate'] == 100.0


def test_get_tool_stats_zero_requests_usage_rate_is_int_zero():
    db = FakeDb(
        one=[{'total_requests': 0, 'total_function_calls': 0, 'total_mcp_calls': 0, 'requests_with_tools': 0}],
        all_=[[], [], [], []],
    )
    r = c(db).getToolStats(ctx())
    assert r['tool_usage_rate'] == 0
    assert isinstance(r['tool_usage_rate'], int)


# ─── isMCPToolFromRegistry (1797) ────────────────────────────────────────────

def test_is_mcp_tool_from_registry_prefix_variants():
    reg = {'search': {'server_name': 'S'}, 'mcp_search': {'server_name': 'S'}}
    ctrl = c()
    assert ctrl.isMCPToolFromRegistry('search', reg) == {'server_name': 'S'}
    assert ctrl.isMCPToolFromRegistry('mcp_search', reg) == {'server_name': 'S'}
    assert ctrl.isMCPToolFromRegistry('unknown', reg) is None
    reg2 = {'search': {'server_name': 'S'}}
    assert ctrl.isMCPToolFromRegistry('mcp_search', reg2) == {'server_name': 'S'}


# ─── listMCPServers (1966) ───────────────────────────────────────────────────

def test_list_mcp_servers_global_scope_and_headers_decode():
    db = FakeDb(all_=[
        [{'id': 1, 'user_id': None, 'name': 'Search', 'url': 'https://s.example', 'description': 'd',
          'headers': '{"Authorization":"Bearer x"}', 'enabled': 1, 'tool_count': 3,
          'created_at': '2026-01-01', 'updated_at': '2026-01-01'}],
    ])
    r = c(db).listMCPServers(ctx(query={'scope': 'global'}))
    assert r['success'] is True
    s = r['servers'][0]
    assert s['is_global'] is True
    assert s['headers'] == {'Authorization': 'Bearer x'}
    assert s['enabled'] is True
    assert 'WHERE s.user_id IS NULL' in sqls(db)[-1]


def test_list_mcp_servers_user_scope_resolves_emails():
    db = FakeDb(all_=[
        [{'id': 2, 'user_id': '5', 'name': 'Priv', 'url': 'https://p.example', 'description': None,
          'headers': None, 'enabled': 0, 'tool_count': 0, 'created_at': None, 'updated_at': None}],
        [{'id': '5', 'email': 'u5@example.com'}],
    ])
    r = c(db).listMCPServers(ctx(query={'user_id': '5'}))
    s = r['servers'][0]
    assert s['is_global'] is False
    assert s['user_email'] == 'u5@example.com'
    assert s['enabled'] is False
    assert s['headers'] is None
    assert 'WHERE s.user_id = ?' in sqls(db)[-2]


# ─── normalizeMCPHeaders (2099) ──────────────────────────────────────────────

def test_normalize_mcp_headers_empty():
    assert c().normalizeMCPHeaders(None) == ([], None)
    assert c().normalizeMCPHeaders('') == ([], None)
    assert c().normalizeMCPHeaders([]) == ([], None)


def test_normalize_mcp_headers_valid_dict():
    headerList, headersJson = c().normalizeMCPHeaders({'Authorization': 'Bearer x'})
    assert headerList == ['Authorization: Bearer x']
    assert json.loads(headersJson) == {'Authorization': 'Bearer x'}


def test_normalize_mcp_headers_invalid_json_string():
    with pytest.raises(ValueError, match='Headers must be a JSON object'):
        c().normalizeMCPHeaders('not json')


def test_normalize_mcp_headers_invalid_name():
    with pytest.raises(ValueError, match='Invalid header name'):
        c().normalizeMCPHeaders({'Bad:Name': 'x'})


def test_normalize_mcp_headers_non_scalar_value():
    with pytest.raises(ValueError, match='value must be a string'):
        c().normalizeMCPHeaders({'X': ['a']})


def test_normalize_mcp_headers_value_with_newline():
    with pytest.raises(ValueError, match='invalid characters'):
        c().normalizeMCPHeaders({'X': 'a\nb'})


# ─── createMCPServer (2134) ──────────────────────────────────────────────────

def test_create_mcp_server_name_and_url_required():
    r = c().createMCPServer(ctx(body={'name': '', 'url': ''}))
    assert r == {'success': False, 'error': 'Name and URL are required', 'status_code': 400}


def test_create_mcp_server_invalid_url():
    r = c().createMCPServer(ctx(body={'name': 'X', 'url': 'not a url'}))
    assert r == {'success': False, 'error': 'Invalid URL format', 'status_code': 400}


def test_create_mcp_server_duplicate_global():
    db = FakeDb(one=[{'id': 1}])
    r = c(db).createMCPServer(ctx(body={'name': 'X', 'url': 'https://x.example'}))
    assert r == {'success': False, 'error': 'A global server with this name already exists',
                'status_code': 409}


def test_create_mcp_server_duplicate_user_scoped():
    db = FakeDb(one=[{'id': 1}])
    r = c(db).createMCPServer(ctx(body={'name': 'X', 'url': 'https://x.example', 'user_id': '5'}))
    assert r == {'success': False, 'error': 'This user already has a server with this name',
                'status_code': 409}


def test_create_mcp_server_success(monkeypatch):
    db = FakeDb(one=[None], insert_id=42)
    monkeypatch.setattr(AdminController, 'fetchMCPServerTools',
                        lambda self, sid, url, headers: {'count': 2, 'tools': ['a', 'b']})
    r = c(db).createMCPServer(ctx(body={'name': 'X', 'url': 'https://x.example'}))
    assert r == {'success': True, 'server_id': 42, 'tools_fetched': 2, 'tools_error': None,
                'message': 'MCP server created successfully', 'status_code': 200}
    insertSql, insertParams = db.calls[-1]
    assert 'INSERT INTO mcp_servers' in insertSql
    assert insertParams == [None, 'X', 'https://x.example', '', None]


def test_create_mcp_server_invalid_headers():
    r = c().createMCPServer(ctx(body={'name': 'X', 'url': 'https://x.example', 'headers': 'not json'}))
    assert r['status_code'] == 400
    assert 'Headers must be a JSON object' in r['error']


# ─── updateMCPServer (2222) ──────────────────────────────────────────────────

def test_update_mcp_server_id_required():
    r = c().updateMCPServer(ctx(body={'server_id': 0}))
    assert r == {'success': False, 'error': 'Server ID is required', 'status_code': 400}


def test_update_mcp_server_name_url_required():
    r = c().updateMCPServer(ctx(body={'server_id': 1, 'name': '', 'url': ''}))
    assert r == {'success': False, 'error': 'Name and URL are required', 'status_code': 400}


def test_update_mcp_server_not_found():
    db = FakeDb(one=[None])
    r = c(db).updateMCPServer(ctx(body={'server_id': 999, 'name': 'X', 'url': 'https://x.example'}))
    assert r == {'success': False, 'error': 'Server not found', 'status_code': 404}


def test_update_mcp_server_url_changed_refetches(monkeypatch):
    db = FakeDb(one=[{'url': 'https://old.example', 'headers': None}])
    called = {}
    def fake_fetch(self, sid, url, headers):
        called['args'] = (sid, url, headers)
        return {'count': 1, 'tools': ['a']}
    monkeypatch.setattr(AdminController, 'fetchMCPServerTools', fake_fetch)
    r = c(db).updateMCPServer(ctx(body={'server_id': 7, 'name': 'X', 'url': 'https://new.example'}))
    assert r == {'success': True, 'tools_fetched': 1, 'tools_error': None,
                'message': 'MCP server updated successfully', 'status_code': 200}
    assert called['args'][0] == 7 and called['args'][1] == 'https://new.example'
    assert any('DELETE FROM mcp_server_tools' in s for s, _ in db.calls)


def test_update_mcp_server_unchanged_url_no_refetch(monkeypatch):
    db = FakeDb(one=[{'url': 'https://same.example', 'headers': None}])
    monkeypatch.setattr(AdminController, 'fetchMCPServerTools',
                        lambda *a, **kw: pytest.fail('should not refetch'))
    r = c(db).updateMCPServer(ctx(body={'server_id': 7, 'name': 'X', 'url': 'https://same.example'}))
    assert r['tools_fetched'] == 0 and r['tools_error'] is None
    assert not any('DELETE FROM mcp_server_tools' in s for s, _ in db.calls)


# ─── toggleMCPServer (2308) ──────────────────────────────────────────────────

def test_toggle_mcp_server_id_required():
    r = c().toggleMCPServer(ctx(body={}))
    assert r == {'success': False, 'error': 'Server ID is required', 'status_code': 400}


def test_toggle_mcp_server_not_found():
    r = c(FakeDb(rowcount=0)).toggleMCPServer(ctx(body={'server_id': 1, 'enabled': True}))
    assert r == {'success': False, 'error': 'Server not found', 'status_code': 404}


def test_toggle_mcp_server_success():
    db = FakeDb(rowcount=1)
    r = c(db).toggleMCPServer(ctx(body={'server_id': 1, 'enabled': False}))
    assert r == {'success': True, 'message': 'Server disabled', 'status_code': 200}
    assert db.calls[-1][1] == [0, 1]


# ─── deleteMCPServer (2354) ───────────────────────────────────────────────────

def test_delete_mcp_server_id_required():
    assert c().deleteMCPServer(ctx(), 0) == {'success': False, 'error': 'Server ID is required',
                                             'status_code': 400}


def test_delete_mcp_server_not_found():
    r = c(FakeDb(one=[None])).deleteMCPServer(ctx(), 999)
    assert r == {'success': False, 'error': 'Server not found', 'status_code': 404}


def test_delete_mcp_server_success():
    db = FakeDb(one=[{'name': 'Search'}])
    r = c(db).deleteMCPServer(ctx(), 3)
    assert r == {'success': True, 'message': "Server 'Search' deleted successfully", 'status_code': 200}


# ─── refreshMCPServerTools (2399) ────────────────────────────────────────────

def test_refresh_mcp_server_tools_id_required():
    r = c().refreshMCPServerTools(ctx(body={}))
    assert r == {'success': False, 'error': 'Server ID is required', 'status_code': 400}


def test_refresh_mcp_server_tools_not_found():
    r = c(FakeDb(one=[None])).refreshMCPServerTools(ctx(body={'server_id': 1}))
    assert r == {'success': False, 'error': 'Server not found', 'status_code': 404}


def test_refresh_mcp_server_tools_success(monkeypatch):
    db = FakeDb(one=[{'url': 'https://x.example', 'headers': None}])
    monkeypatch.setattr(AdminController, 'fetchMCPServerTools',
                        lambda self, sid, url, headers: {'count': 3, 'tools': ['a', 'b', 'c']})
    r = c(db).refreshMCPServerTools(ctx(body={'server_id': 1}))
    assert r == {'success': True, 'tools_fetched': 3, 'tools_error': None, 'tools': ['a', 'b', 'c'],
                'message': 'Tools refreshed successfully', 'status_code': 200}


# ─── getUserMCPServers / setUserMCPOverride / clearUserMCPOverride ─────────
# (2466, 2545, 2591) — package → admin override → user pref cascade.

def test_get_user_mcp_servers_resolution(monkeypatch):
    db = FakeDb(all_=[
        [
            {'id': 1, 'name': 'Global-Allowed', 'url': 'u1', 'description': None, 'user_id': None,
             'enabled': 1, 'tool_count': 0},
            {'id': 2, 'name': 'Global-NotAllowed', 'url': 'u2', 'description': None, 'user_id': None,
             'enabled': 1, 'tool_count': 0},
            {'id': 3, 'name': 'Private', 'url': 'u3', 'description': None, 'user_id': '9',
             'enabled': 1, 'tool_count': 0},
        ],
        [{'server_id': 2, 'allowed': 1}],  # admin override flips server 2 back on
    ])
    monkeypatch.setattr('app.controllers.admin_controller.PackageResolver.allowedMcpServers',
                        lambda self, userId: ['Global-Allowed'])
    r = c(db).getUserMCPServers(ctx(), 9)
    assert r['package_allowlist'] == ['Global-Allowed']
    byName = {s['name']: s for s in r['servers']}
    assert byName['Global-Allowed']['package_default'] is True
    assert byName['Global-Allowed']['effective'] is True
    assert byName['Global-NotAllowed']['package_default'] is False
    assert byName['Global-NotAllowed']['override'] is True
    assert byName['Global-NotAllowed']['effective'] is True  # override wins
    assert byName['Private']['is_user_private'] is True
    assert byName['Private']['package_default'] is True  # private always passes
    assert byName['Private']['effective'] is True


def test_get_user_mcp_servers_unrestricted_allowlist(monkeypatch):
    db = FakeDb(all_=[
        [{'id': 1, 'name': 'X', 'url': 'u', 'description': None, 'user_id': None, 'enabled': 1, 'tool_count': 0}],
        [],
    ])
    monkeypatch.setattr('app.controllers.admin_controller.PackageResolver.allowedMcpServers',
                        lambda self, userId: None)
    r = c(db).getUserMCPServers(ctx(), 1)
    assert r['package_allowlist'] is None
    assert r['servers'][0]['package_default'] is True


def test_set_user_mcp_override_requires_allowed_field():
    r = c().setUserMCPOverride(ctx(body={}), 1, 2)
    assert r == {'success': False, 'error': 'Field "allowed" is required (boolean).', 'status_code': 400}


def test_set_user_mcp_override_user_not_found():
    r = c(FakeDb(one=[None])).setUserMCPOverride(ctx(body={'allowed': True}), 999, 2)
    assert r == {'success': False, 'error': 'User not found', 'status_code': 404}


def test_set_user_mcp_override_server_not_found():
    db = FakeDb(one=[{'1': 1}, None])
    r = c(db).setUserMCPOverride(ctx(body={'allowed': True}), 1, 999)
    assert r == {'success': False, 'error': 'MCP server not found', 'status_code': 404}


def test_set_user_mcp_override_success():
    db = FakeDb(one=[{'1': 1}, {'1': 1}])
    r = c(db).setUserMCPOverride(ctx(body={'allowed': False}), 1, 2)
    assert r == {'success': True, 'user_id': 1, 'server_id': 2, 'allowed': False, 'status_code': 200}
    sql, params = db.calls[-1]
    assert 'ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)' in sql
    assert params == {':uid': 1, ':sid': 2, ':allowed': 0}


def test_clear_user_mcp_override():
    db = FakeDb(rowcount=1)
    r = c(db).clearUserMCPOverride(ctx(), 1, 2)
    assert r == {'success': True, 'user_id': 1, 'server_id': 2, 'cleared': True, 'status_code': 200}

    db2 = FakeDb(rowcount=0)
    r2 = c(db2).clearUserMCPOverride(ctx(), 1, 2)
    assert r2['cleared'] is False


# ─── getCosts / refreshAllCosts / refreshProviderCosts (2615-2828) ──────────

def test_get_costs_falls_back_to_defaults_when_empty():
    db = FakeDb(all_=[[]])
    r = c(db).getCosts(ctx())
    assert r['success'] is True
    assert len(r['costs']['llm']) == 6  # getDefaultCosts()'s llm providers
    assert r['costs']['lastRefreshed'] is None
    assert 'usageCosts' in r


def test_get_costs_uses_stored_rows():
    db = FakeDb(all_=[
        [{'category': 'llm', 'provider': 'claude', 'display_name': 'Claude', 'tiers': '[{"name":"x"}]',
          'pricing_url': 'https://x', 'updated_at': '2026-01-01 00:00:00', 'notes': None}],
    ])
    r = c(db).getCosts(ctx())
    assert r['costs']['llm'] == [{'provider': 'claude', 'displayName': 'Claude', 'category': 'llm',
                                  'tiers': [{'name': 'x'}], 'pricingUrl': 'https://x',
                                  'lastUpdated': '2026-01-01 00:00:00', 'notes': None}]
    assert r['costs']['lastRefreshed'] == '2026-01-01 00:00:00'


def test_refresh_provider_costs_invalid_category():
    r = c().refreshProviderCosts(ctx(body={'category': 'bogus', 'provider': 'claude'}))
    assert r == {'success': False, 'error': 'Invalid category', 'status_code': 400}


def test_refresh_provider_costs_provider_required():
    r = c().refreshProviderCosts(ctx(body={'category': 'llm', 'provider': ''}))
    assert r == {'success': False, 'error': 'Provider is required', 'status_code': 400}


def test_refresh_provider_costs_not_found():
    db = FakeDb()
    r = c(db).refreshProviderCosts(ctx(body={'category': 'llm', 'provider': 'nonexistent'}))
    assert r == {'success': False, 'error': 'Provider not found', 'status_code': 404}


def test_refresh_provider_costs_success_no_api_key(monkeypatch):
    # getAdminApiKey returns None (no config key, no DB row) -> fetchProviderPricing
    # keeps default tiers untouched, no network call is made.
    db = FakeDb(one=[None, None])  # getAdminApiKey's user_api_keys lookup, then the reload SELECT
    r = c(db).refreshProviderCosts(ctx(body={'category': 'llm', 'provider': 'claude'}))
    assert r['success'] is True
    assert r['provider']['provider'] == 'claude'
    assert r['provider']['lastUpdated'] is not None


def test_refresh_all_costs_accumulates_errors(monkeypatch):
    db = FakeDb(all_=[[]])  # final reload SELECT

    def fake_fetch(self, provider):
        if provider['provider'] == 'claude':
            raise RuntimeError('boom')
        return dict(provider, lastUpdated='now')
    monkeypatch.setattr(AdminController, 'fetchProviderPricing', fake_fetch)
    monkeypatch.setattr(AdminController, 'saveProviderCosts', lambda self, category, provider: None)

    r = c(db).refreshAllCosts(ctx())
    assert r['success'] is True
    assert any('claude: boom' in e for e in r['errors'])
    assert r['updated_count'] > 0  # every non-claude provider still saved


def test_get_admin_api_key_prefers_config():
    ctrl = c(FakeDb(), config={'CLAUDE_API_KEY': 'cfg-key'})
    assert ctrl.getAdminApiKey('claude') == 'cfg-key'


def test_get_admin_api_key_falls_back_to_db():
    db = FakeDb(one=[{'api_key': 'db-key'}])
    ctrl = c(db, config={})
    assert ctrl.getAdminApiKey('claude') == 'db-key'


def test_get_admin_api_key_none_when_absent():
    db = FakeDb(one=[None])
    ctrl = c(db, config={})
    assert ctrl.getAdminApiKey('claude') is None


# ─── fetchPricingWithClaude (3054) — external call shapes pinned ───────────

def test_fetch_pricing_with_claude_success(monkeypatch):
    requests_seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(request)
        if str(request.url) == 'https://example.com/pricing':
            return httpx.Response(200, text='<html><body>Model X $1.00/1M</body></html>')
        if str(request.url) == 'https://api.anthropic.com/v1/messages':
            assert request.headers['x-api-key'] == 'sk-test'
            assert request.headers['anthropic-version'] == '2023-06-01'
            body = json.loads(request.content)
            assert body['model'] == 'claude-3-5-haiku-20241022'
            assert body['max_tokens'] == 2048
            assert 'Model X' in body['messages'][0]['content']
            return httpx.Response(200, json={
                'content': [{'type': 'text', 'text': '```json\n[{"name":"Model X","price":"$1.00",'
                                                     '"unit":"/1M"}]\n```'}]
            })
        raise AssertionError(f'unexpected URL {request.url}')

    _patch_httpx_client(monkeypatch, handler)
    tiers = c().fetchPricingWithClaude('https://example.com/pricing', 'ExampleProvider', 'sk-test')
    assert tiers == [{'name': 'Model X', 'price': '$1.00', 'unit': '/1M'}]
    assert len(requests_seen) == 2


def test_fetch_pricing_with_claude_page_fetch_fails(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text='error')
    _patch_httpx_client(monkeypatch, handler)
    assert c().fetchPricingWithClaude('https://example.com/x', 'P', 'k') is None


def test_fetch_pricing_with_claude_api_call_fails(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if 'anthropic.com' in str(request.url):
            return httpx.Response(401, text='unauthorized')
        return httpx.Response(200, text='<html>content</html>')
    _patch_httpx_client(monkeypatch, handler)
    assert c().fetchPricingWithClaude('https://example.com/x', 'P', 'bad-key') is None


def test_fetch_pricing_with_claude_unparseable_response(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if 'anthropic.com' in str(request.url):
            return httpx.Response(200, json={'content': [{'type': 'text', 'text': 'not json at all'}]})
        return httpx.Response(200, text='<html>content</html>')
    _patch_httpx_client(monkeypatch, handler)
    assert c().fetchPricingWithClaude('https://example.com/x', 'P', 'k') is None


# ─── getExchangeRates / refreshExchangeRates / fetchExchangeRatesFromApi ───
# (3218-3371)

def test_get_exchange_rates_defaults_when_empty():
    db = FakeDb(all_=[[]])
    r = c(db).getExchangeRates(ctx())
    assert r['rates'] == {'USD': 1.0, 'EUR': 0.92, 'CAD': 1.36}
    assert r['lastUpdated'] is None


def test_get_exchange_rates_uses_stored_rows():
    db = FakeDb(all_=[[{'currency': 'EUR', 'rate': '0.90', 'updated_at': '2026-01-01 00:00:00'}]])
    r = c(db).getExchangeRates(ctx())
    assert r['rates']['EUR'] == 0.90
    assert r['lastUpdated'] == '2026-01-01 00:00:00'


def test_fetch_exchange_rates_from_api_success(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers['user-agent'] == 'GPT-Admin/1.0'
        return httpx.Response(200, json={'rates': {'EUR': 0.88, 'CAD': 1.30, 'GBP': 0.79}})
    _patch_httpx_client(monkeypatch, handler)
    rates = c().fetchExchangeRatesFromApi()
    assert rates == {'EUR': 0.88, 'CAD': 1.30}


def test_fetch_exchange_rates_from_api_falls_back_to_defaults(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text='error')
    _patch_httpx_client(monkeypatch, handler)
    assert c().fetchExchangeRatesFromApi() == {'EUR': 0.92, 'CAD': 1.36}


def test_fetch_exchange_rates_from_api_second_api_used_on_first_failure(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if 'exchangerate-api.com' in str(request.url):
            raise httpx.ConnectError('refused', request=request)
        return httpx.Response(200, json={'rates': {'EUR': 0.5, 'CAD': 0.6}})
    _patch_httpx_client(monkeypatch, handler)
    rates = c().fetchExchangeRatesFromApi()
    assert rates == {'EUR': 0.5, 'CAD': 0.6}
    assert len(calls) == 2


def test_refresh_exchange_rates_success(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(AdminController, 'fetchExchangeRatesFromApi', lambda self: {'EUR': 0.5, 'CAD': 0.6})
    r = c(db).refreshExchangeRates(ctx())
    assert r['success'] is True
    assert r['rates'] == {'USD': 1.0, 'EUR': 0.5, 'CAD': 0.6}
    inserted = [call for call in db.calls if 'INSERT INTO exchange_rates' in call[0]]
    assert len(inserted) == 2


def test_refresh_exchange_rates_failure():
    class NoRatesController(AdminController):
        def fetchExchangeRatesFromApi(self):
            return None
    ctrl = NoRatesController(FakeDb(), CONFIG)
    r = ctrl.refreshExchangeRates(ctx())
    assert r == {'success': False, 'error': 'Failed to fetch exchange rates', 'status_code': 500}


# ─── fetchMCPServerTools / mcpHttpCall (3558-3753) — MCP handshake ─────────

def test_mcp_handshake_success_inserts_tools(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body['method'])
        if body['method'] == 'initialize':
            assert body['params']['capabilities'] == {}
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {}},
                                  headers={'Mcp-Session-Id': 'sess-123'})
        if body['method'] == 'notifications/initialized':
            assert request.headers.get('mcp-session-id') == 'sess-123'
            return httpx.Response(200, text='')
        if body['method'] == 'tools/list':
            assert request.headers.get('mcp-session-id') == 'sess-123'
            return httpx.Response(200, json={
                'jsonrpc': '2.0', 'id': 2,
                'result': {'tools': [{'name': 'search', 'description': 'searches',
                                      'inputSchema': {'type': 'object', 'properties': {}}}]},
            })
        raise AssertionError(body)

    _patch_httpx_client(monkeypatch, handler)
    db = FakeDb(one=[{'db': 'testdb'}, {'id': 1}])  # SELECT DATABASE(), verify-insert
    result = c(db).fetchMCPServerTools(1, 'https://mcp.example/', [])
    assert calls == ['initialize', 'notifications/initialized', 'tools/list']
    assert result == {'count': 1, 'tools': ['search']}
    insertCalls = [call for call in db.calls if 'INSERT INTO mcp_server_tools' in call[0]]
    assert len(insertCalls) == 1
    assert insertCalls[0][1][:3] == [1, 'search', 'searches']


def test_mcp_handshake_initialize_fails(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text='server error')
    _patch_httpx_client(monkeypatch, handler)
    result = c().fetchMCPServerTools(1, 'https://mcp.example/', [])
    assert result['count'] == 0
    assert 'initialize failed' in result['error']


def test_mcp_handshake_initialize_jsonrpc_error(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1,
                                         'error': {'message': 'unsupported protocol'}})
    _patch_httpx_client(monkeypatch, handler)
    result = c().fetchMCPServerTools(1, 'https://mcp.example/', [])
    assert result == {'count': 0, 'error': 'initialize error: unsupported protocol'}


def test_mcp_handshake_connection_error(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('connection refused', request=request)
    _patch_httpx_client(monkeypatch, handler)
    result = c().fetchMCPServerTools(1, 'http://127.0.0.1:1/mcp', [])
    assert result['count'] == 0
    assert 'initialize failed' in result['error']


def test_mcp_handshake_empty_tools_list(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'result': {}})
        if body['method'] == 'tools/list':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'result': {'tools': []}})
        return httpx.Response(200, text='')
    _patch_httpx_client(monkeypatch, handler)
    result = c().fetchMCPServerTools(1, 'https://mcp.example/', [])
    assert result == {'count': 0, 'tools': []}


def test_mcp_http_call_parses_sse_response(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
        return httpx.Response(200, text=sse, headers={'Content-Type': 'text/event-stream'})
    _patch_httpx_client(monkeypatch, handler)
    sessionRef = {'id': None}
    result = c().mcpHttpCall('https://mcp.example/', {'jsonrpc': '2.0', 'id': 1, 'method': 'x'}, [], sessionRef)
    assert result == {'ok': True, 'error': None, 'data': {'jsonrpc': '2.0', 'id': 1, 'result': {'ok': True}}}


def test_mcp_http_call_extra_headers_applied(monkeypatch):
    seen = {}
    def handler(request: httpx.Request) -> httpx.Response:
        seen['auth'] = request.headers.get('authorization')
        return httpx.Response(200, json={'ok': True})
    _patch_httpx_client(monkeypatch, handler)
    sessionRef = {'id': None}
    c().mcpHttpCall('https://mcp.example/', {'a': 1}, ['Authorization: Bearer tok'], sessionRef)
    assert seen['auth'] == 'Bearer tok'
