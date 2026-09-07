"""Unit tests for HumeToolController — port of Controllers/HumeToolController.php (1-270)
and the module-private `_HumeToolSyncService` (port of Services/HumeToolSyncService.php).

PHP-truth strings copied verbatim from the source:
  - "Missing toolCallId or toolName"                    (HumeToolController.php:55)
  - "Function not found: {toolName}"                    (HumeToolController.php:67)
  - "Copy these tool definitions to your Hume EVI configuration" (HumeToolController.php:112)
  - "Tools synchronized successfully"                    (HumeToolController.php:128)
  - "No config_id set in ai_config.php"                  (HumeToolController.php:205)
  - "Hume API key not configured"                        (HumeToolSyncService.php:33)
  - "Connected to Hume API successfully"                 (HumeToolSyncService.php:352)
"""
import hashlib

import httpx
import pytest

from app.controllers.hume_tool_controller import HumeToolController, _HumeToolSyncService, _guzzleErrorMessage
from app.support.phpjson import php_json_encode


class Db:
    """Records SQL + params; answers from a queue of canned results (same
    fake used by test_portfolio_watchlist_functions.py)."""
    def __init__(self, results=None):
        self.calls = []
        self.results = list(results or [])

    def _next(self, default):
        return self.results.pop(0) if self.results else default

    def fetch_all(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return self._next([])

    def fetch_one(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return self._next(None)

    def execute(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return self._next(1)

    def insert(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params)); return self._next(1)


CFG_NO_HUME_KEY = {'hume_evi': {'api_key': '', 'base_url': 'https://api.hume.ai/v0/evi', 'config_id': 'cfg-1'}}
CFG_WITH_HUME_KEY = {'hume_evi': {'api_key': 'TESTKEY', 'base_url': 'https://api.hume.ai/v0/evi', 'config_id': 'cfg-1'}}


def req(body=None, user_id=None):
    return {'body': body if body is not None else {}, 'user_id': user_id}


# ─── HumeToolController._initializeToolsManager (registers 2c functions) ───

def test_registers_watchlist_portfolio_search_analysis_functions():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    try:
        names = set(ctl.toolsManager.getRegisteredFunctions())
        assert names == {
            'get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist',
            'get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions',
            'serpapi_search', 'brave_search', 'search_assets', 'get_trending_assets', 'get_top_gainers', 'get_top_losers',
            'get_sec_filings', 'get_sec_filing_document',
            'get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment',
        }
    finally:
        ctl.close()


# ─── execute() ───────────────────────────────────────────────────────────────

def test_execute_missing_toolcallid_or_toolname():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    assert ctl.execute(req(body={'toolName': 'get_user_watchlist'})) == {
        'success': False, 'error': 'Missing toolCallId or toolName', 'status_code': 400,
    }
    assert ctl.execute(req(body={'toolCallId': 'tc1'})) == {
        'success': False, 'error': 'Missing toolCallId or toolName', 'status_code': 400,
    }
    assert ctl.execute(req(body={})) == {
        'success': False, 'error': 'Missing toolCallId or toolName', 'status_code': 400,
    }


def test_execute_unknown_tool_returns_404_with_available_functions():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    r = ctl.execute(req(body={'toolCallId': 'tc1', 'toolName': 'no_such_tool'}))
    assert r['success'] is False and r['status_code'] == 404
    assert r['error'] == 'Function not found: no_such_tool'
    assert r['toolCallId'] == 'tc1'
    assert 'get_user_watchlist' in r['availableFunctions']


def test_execute_routes_to_watchlist_function_with_userid_from_body():
    db = Db([[{'id': 1, 'asset_id': 5, 'name': 'Apple', 'symbol': 'AAPL', 'type': 'stock', 'exchange': 'NASDAQ', 'currency': 'USD'}]])
    ctl = HumeToolController(db, CFG_NO_HUME_KEY)
    r = ctl.execute(req(body={'toolCallId': 'tc1', 'toolName': 'get_user_watchlist', 'userId': 7}))
    assert r['success'] is True and r['status_code'] == 200
    assert r['toolCallId'] == 'tc1' and r['toolName'] == 'get_user_watchlist'
    assert r['result']['success'] is True and r['result']['count'] == 1
    # SQL executed with the userId taken from the body ("userId" ?? request user_id ?? 'demo-user')
    sql, params = db.calls[0]
    assert params == [7]
    # content is json_encode($result, JSON_PRETTY_PRINT) -- a pretty string, escaped, matching result
    assert isinstance(r['content'], str) and '"success": true' in r['content']


def test_execute_userid_falls_back_to_request_user_id_then_demo_user():
    db = Db([[]])
    ctl = HumeToolController(db, CFG_NO_HUME_KEY)
    ctl.execute(req(body={'toolCallId': 'tc1', 'toolName': 'get_user_watchlist'}, user_id=42))
    assert db.calls[0][1] == [42]

    db2 = Db([[]])
    ctl2 = HumeToolController(db2, CFG_NO_HUME_KEY)
    ctl2.execute(req(body={'toolCallId': 'tc1', 'toolName': 'get_user_watchlist'}))
    assert db2.calls[0][1] == ['demo-user']


def test_execute_input_useridzero_is_falsy_like_php_null_coalesce():
    # PHP `$input['userId'] ?? $request['user_id'] ?? 'demo-user'` only skips on
    # isset()==false (missing/null) -- a present-but-falsy 0 IS used, unlike
    # the toolCallId/toolName guard above which uses `!` (empty()). Probed with
    # a stub function (rather than get_user_watchlist) because WatchlistFunctions
    # itself treats userId=0 as falsy and short-circuits before any query.
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    seen = {}

    def probe(params, context):
        seen['context'] = context
        return {'ok': True}

    ctl.toolsManager.registerFunction('probe_tool', probe, {'description': 'd', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}})
    ctl.execute(req(body={'toolCallId': 'tc1', 'toolName': 'probe_tool', 'userId': 0}, user_id=99))
    assert seen['context'] == 0


# ─── list() ──────────────────────────────────────────────────────────────────

def test_list_converts_claude_definitions_to_hume_format():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    r = ctl.list(req())
    assert r['success'] is True and r['status_code'] == 200
    assert r['note'] == 'Copy these tool definitions to your Hume EVI configuration'
    assert r['count'] == len(r['tools']) == len(ctl_names := ctl.toolsManager.getRegisteredFunctions())
    names = {t['name'] for t in r['tools']}
    assert names == set(ctl_names)
    for t in r['tools']:
        assert set(t.keys()) == {'name', 'description', 'parameters'}
        assert isinstance(t['parameters'], dict)


# ─── getConfig() ──────────────────────────────────────────────────────────────

def test_getconfig_missing_config_id_is_400():
    ctl = HumeToolController(Db(), {'hume_evi': {'api_key': 'k', 'base_url': 'https://api.hume.ai/v0/evi', 'config_id': ''}})
    assert ctl.getConfig(req()) == {'success': False, 'error': 'No config_id set in ai_config.php', 'status_code': 400}


def test_getconfig_success_and_error_via_mocktransport(monkeypatch):
    seen = {}

    def handler(request):
        seen['method'] = request.method
        seen['url'] = str(request.url)
        seen['headers'] = dict(request.headers)
        return httpx.Response(200, json={'id': 'cfg-1', 'name': 'My Config'})

    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs.pop('verify', None)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr('app.controllers.hume_tool_controller.httpx.Client', fake_client)

    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    r = ctl.getConfig(req())
    assert r == {'success': True, 'config': {'id': 'cfg-1', 'name': 'My Config'}, 'status_code': 200}
    assert seen['method'] == 'GET'
    assert seen['url'] == 'https://api.hume.ai/v0/evi/configs/cfg-1'
    assert seen['headers'].get('x-hume-api-key') == 'TESTKEY'


def test_getconfig_http_error_becomes_guzzle_style_message(monkeypatch):
    def handler(request):
        return httpx.Response(404, text='{"message":"not found"}')

    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs.pop('verify', None)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr('app.controllers.hume_tool_controller.httpx.Client', fake_client)

    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    r = ctl.getConfig(req())
    assert r['success'] is False and r['status_code'] == 500
    assert r['error'].startswith('Client error: `GET https://api.hume.ai/v0/evi/configs/cfg-1` resulted in a `404 Not Found` response:')
    assert '"message":"not found"' in r['error']


# ─── sync() / getStatus() / testConnection() — no API key configured ────────

def test_sync_without_api_key_returns_500():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    assert ctl.sync(req()) == {'success': False, 'error': 'Hume API key not configured', 'status_code': 500}


def test_get_status_without_api_key_returns_500():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    assert ctl.getStatus(req()) == {'success': False, 'error': 'Hume API key not configured', 'status_code': 500}


def test_test_connection_without_api_key_returns_500():
    ctl = HumeToolController(Db(), CFG_NO_HUME_KEY)
    assert ctl.testConnection(req()) == {
        'success': False, 'message': 'Connection failed: Hume API key not configured', 'status_code': 500,
    }


# ─── sync() / getStatus() / testConnection() — response shaping (service faked) ─

class FakeSyncService:
    """Stands in for `_HumeToolSyncService` so controller response-shaping is
    tested independently of its HTTP internals (those are unit-tested below
    directly on `_HumeToolSyncService` via MockTransport)."""
    instances = []

    def __init__(self, config, db):
        self.config = config
        self.db = db
        self.closed = False
        FakeSyncService.instances.append(self)

    def syncAllTools(self, toolsManager):
        return {
            'total_local': 5, 'total_hume': 4,
            'created': ['a'], 'updated': ['b', 'c'], 'unchanged': ['d'], 'errors': [],
            'tool_mapping': {'a': 'id-a'},
        }

    def getSyncStatus(self, toolsManager):
        return {
            'local_count': 5, 'hume_count': 4,
            'missing_in_hume': ['a'], 'missing_in_local': [],
            'needs_sync': True, 'local_tools': ['a', 'b'], 'hume_tools': ['b'],
        }

    def testConnection(self):
        return {'success': True, 'message': 'Connected to Hume API successfully', 'tools_count': 4}

    def close(self):
        self.closed = True


def test_sync_response_shape(monkeypatch):
    FakeSyncService.instances.clear()
    monkeypatch.setattr('app.controllers.hume_tool_controller._HumeToolSyncService', FakeSyncService)
    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    r = ctl.sync(req())
    assert r['success'] is True
    assert r['message'] == 'Tools synchronized successfully'
    assert r['stats'] == {'total_local': 5, 'total_hume': 4, 'created': 1, 'updated': 2, 'unchanged': 1, 'errors': 0}
    assert r['status_code'] == 200
    assert isinstance(r['timestamp'], str) and len(r['timestamp']) == 19  # 'Y-m-d H:i:s'
    assert FakeSyncService.instances[0].closed is True


def test_get_status_response_shape_needs_action_true(monkeypatch):
    monkeypatch.setattr('app.controllers.hume_tool_controller._HumeToolSyncService', FakeSyncService)
    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    r = ctl.getStatus(req())
    assert r['success'] is True and r['needs_action'] is True and r['status_code'] == 200
    assert r['status']['missing_in_hume'] == ['a']


def test_test_connection_response_shape_success(monkeypatch):
    monkeypatch.setattr('app.controllers.hume_tool_controller._HumeToolSyncService', FakeSyncService)
    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    r = ctl.testConnection(req())
    assert r == {'success': True, 'message': 'Connected to Hume API successfully', 'tools_count': 4, 'status_code': 200}


class FakeSyncServiceFails(FakeSyncService):
    def syncAllTools(self, toolsManager):
        raise RuntimeError('boom')

    def getSyncStatus(self, toolsManager):
        raise RuntimeError('boom')


def test_sync_and_status_exception_returns_500(monkeypatch):
    monkeypatch.setattr('app.controllers.hume_tool_controller._HumeToolSyncService', FakeSyncServiceFails)
    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    assert ctl.sync(req()) == {'success': False, 'error': 'boom', 'status_code': 500}
    ctl2 = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    assert ctl2.getStatus(req()) == {'success': False, 'error': 'boom', 'status_code': 500}


def test_test_connection_failure_status_500(monkeypatch):
    class FakeFailConn(FakeSyncService):
        def testConnection(self):
            return {'success': False, 'message': 'Failed to connect: boom'}
    monkeypatch.setattr('app.controllers.hume_tool_controller._HumeToolSyncService', FakeFailConn)
    ctl = HumeToolController(Db(), CFG_WITH_HUME_KEY)
    assert ctl.testConnection(req()) == {'success': False, 'message': 'Failed to connect: boom', 'status_code': 500}


# ─── _HumeToolSyncService — HTTP internals via httpx.MockTransport ──────────

def _svc(handler, cfg=None):
    cfg = cfg or CFG_WITH_HUME_KEY
    svc = _HumeToolSyncService(cfg, None)
    # Preserve the default headers the real constructor set (X-Hume-Api-Key,
    # Content-Type) when swapping in the MockTransport client.
    svc.httpClient = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={'X-Hume-Api-Key': cfg['hume_evi']['api_key'], 'Content-Type': 'application/json'},
    )
    return svc


def test_sync_service_requires_api_key():
    with pytest.raises(RuntimeError, match='Hume API key not configured'):
        _HumeToolSyncService(CFG_NO_HUME_KEY, None)


def test_list_hume_tools_request_bytes_and_shape():
    seen = {}

    def handler(request):
        seen['method'] = request.method
        seen['url'] = str(request.url)
        return httpx.Response(200, json={'tools_page': [{'name': 't1', 'id': 'id1'}]})

    svc = _svc(handler)
    tools = svc.listHumeTools()
    assert tools == [{'name': 't1', 'id': 'id1'}]
    assert seen['method'] == 'GET'
    assert seen['url'] == 'https://api.hume.ai/v0/evi/tools?page_size=100&restrict_to_most_recent=true'


def test_list_hume_tools_http_error_wraps_guzzle_style_message():
    def handler(request):
        return httpx.Response(401, text='unauthorized')

    svc = _svc(handler)
    with pytest.raises(RuntimeError) as ei:
        svc.listHumeTools()
    assert str(ei.value).startswith('Failed to list Hume tools: Client error: `GET https://api.hume.ai/v0/evi/tools?')
    assert 'unauthorized' in str(ei.value)


def test_create_tool_payload_key_order_and_content(monkeypatch):
    seen = {}

    def handler(request):
        seen['method'] = request.method
        seen['url'] = str(request.url)
        seen['headers'] = dict(request.headers)
        seen['body'] = request.content
        return httpx.Response(200, json={'tool_id': 'new-id'})

    svc = _svc(handler)
    toolDef = {'name': 'my_tool', 'description': 'Does a thing',
               'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string', 'default': 'z'}}, 'required': []}}
    out = svc.createTool(toolDef)
    assert out == {'tool_id': 'new-id'}
    assert seen['method'] == 'POST'
    assert seen['url'] == 'https://api.hume.ai/v0/evi/tools'
    assert seen['headers'].get('x-hume-api-key') == 'TESTKEY'
    assert seen['headers'].get('content-type') == 'application/json'

    import json as _json
    body = _json.loads(seen['body'])
    assert list(body.keys()) == ['name', 'parameters', 'description', 'version_description']
    assert body['name'] == 'my_tool'
    assert body['description'] == 'Does a thing'
    assert body['version_description'] == 'Auto-synced from backend'
    # 'parameters' is a JSON-encoded STRING (double-encoded, like PHP's
    # `json_encode($cleanedSchema)` assigned into the outer payload array),
    # and 'default' fields are stripped before encoding.
    assert isinstance(body['parameters'], str)
    cleaned = _json.loads(body['parameters'])
    assert cleaned == {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': []}
    assert body['parameters'] == php_json_encode({'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': []})


def test_update_tool_delegates_to_create_tool():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json={'id': 'v2'})

    svc = _svc(handler)
    out = svc.updateTool('old-id', {'name': 't', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}})
    assert out == {'id': 'v2'} and len(calls) == 1


def test_sync_all_tools_created_updated_unchanged_and_mapping():
    def handler(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'tools_page': [
                {'name': 'same_tool', 'id': 'id-same', 'parameters': php_json_encode({'type': 'object', 'properties': {}, 'required': []}), 'description': 'd1'},
                {'name': 'changed_tool', 'id': 'id-changed', 'parameters': '{}', 'description': 'old desc'},
            ]})
        return httpx.Response(200, json={'tool_id': 'new-id'})

    svc = _svc(handler)

    class FakeToolsManager:
        def getToolDefinitions(self):
            return [
                {'name': 'same_tool', 'description': 'd1', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}},
                {'name': 'changed_tool', 'description': 'new desc', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}},
                {'name': 'brand_new_tool', 'description': 'd3', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}},
            ]

    results = svc.syncAllTools(FakeToolsManager())
    assert results['total_local'] == 3 and results['total_hume'] == 2
    assert results['unchanged'] == ['same_tool']
    assert results['updated'] == ['changed_tool']
    assert results['created'] == ['brand_new_tool']
    assert results['errors'] == []
    assert results['tool_mapping']['same_tool'] == 'id-same'
    assert results['tool_mapping']['changed_tool'] == 'new-id'
    assert results['tool_mapping']['brand_new_tool'] == 'new-id'


def test_get_sync_status_missing_diffs():
    def handler(request):
        return httpx.Response(200, json={'tools_page': [{'name': 'b', 'id': 'x'}]})

    svc = _svc(handler)

    class FakeToolsManager:
        def getToolDefinitions(self):
            return [{'name': 'a', 'description': '', 'input_schema': {}}, {'name': 'b', 'description': '', 'input_schema': {}}]

    status = svc.getSyncStatus(FakeToolsManager())
    assert status == {
        'local_count': 2, 'hume_count': 1,
        'missing_in_hume': ['a'], 'missing_in_local': [],
        'needs_sync': True, 'local_tools': ['a', 'b'], 'hume_tools': ['b'],
    }


def test_test_connection_success_and_failure():
    ok = _svc(lambda r: httpx.Response(200, json={'tools_page': [{'name': 'a'}]}))
    assert ok.testConnection() == {'success': True, 'message': 'Connected to Hume API successfully', 'tools_count': 1}

    bad = _svc(lambda r: httpx.Response(500, text='server error'))
    r = bad.testConnection()
    assert r['success'] is False and r['message'].startswith('Failed to connect: Failed to list Hume tools: Server error:')


def test_store_tool_mapping_inserts_with_md5_hash_and_swallows_db_errors():
    class BoomDb:
        def execute(self, sql, params=None):
            raise RuntimeError('table missing')

    svc = _svc(lambda r: httpx.Response(200, json={}))
    svc.db = BoomDb()
    # PHP catches \PDOException and just logs -- must not raise.
    svc._storeToolMapping('t1', 'hume-1', {'name': 't1'})

    calls = []

    class RecordingDb:
        def execute(self, sql, params=None):
            calls.append((' '.join(sql.split()), params))
            return 1

    svc2 = _svc(lambda r: httpx.Response(200, json={}))
    svc2.db = RecordingDb()
    svc2._storeToolMapping('t1', 'hume-1', {'name': 't1'})
    sql, params = calls[0]
    assert 'INSERT INTO hume_tool_mapping' in sql and 'ON DUPLICATE KEY UPDATE' in sql
    expectedHash = hashlib.md5(php_json_encode({'name': 't1'}).encode('utf-8')).hexdigest()
    assert params == ['t1', 'hume-1', expectedHash]


def test_remove_default_fields_strips_nested_defaults_and_preserves_structure():
    svc = _svc(lambda r: httpx.Response(200, json={}))
    schema = {'type': 'object', 'properties': {'x': {'type': 'string', 'default': 'z'}, 'y': {'type': 'integer'}}, 'required': ['x'], 'default': 'top'}
    cleaned = svc._removeDefaultFields(schema)
    assert cleaned == {'type': 'object', 'properties': {'x': {'type': 'string'}, 'y': {'type': 'integer'}}, 'required': ['x']}


def test_guzzle_error_message_format():
    request = httpx.Request('GET', 'https://api.hume.ai/v0/evi/tools?page_size=100')
    response = httpx.Response(404, text='not found body', request=request)
    msg = _guzzleErrorMessage(request, response)
    assert msg == "Client error: `GET https://api.hume.ai/v0/evi/tools?page_size=100` resulted in a `404 Not Found` response:\nnot found body\n"

    response5 = httpx.Response(503, text='', request=request)
    msg5 = _guzzleErrorMessage(request, response5)
    assert msg5 == "Server error: `GET https://api.hume.ai/v0/evi/tools?page_size=100` resulted in a `503 Service Unavailable` response"
