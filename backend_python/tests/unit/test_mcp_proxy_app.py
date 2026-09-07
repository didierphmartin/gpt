"""MCPProxyController + MCPAppController unit tests — PHP-truth strings and
byte-identical SQL.

PHP source: backend/src/Controllers/MCPProxyController.php (15-614) and
MCPAppController.php (15-225). The `resolveEndpointUrl` cases are a straight
port of the PHP oracle backend/tests/Unit/McpProxyEndpointUrlTest.php.
"""
from __future__ import annotations

import httpx
import pytest
from starlette.datastructures import Headers

from app.controllers.mcp_app_controller import MCPAppController
from app.controllers.mcp_proxy_controller import MCPProxyController
from app.support.http import Ctx

ALL_TABLES = ('mcp_servers', 'mcp_server_tools')


class FakeDb:
    """Records every statement so the tests can assert SQL byte-for-byte."""

    def __init__(self, one=None, all_=None, rowcount=1, tables=ALL_TABLES):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.tables = set(tables)
        self.calls = []

    def _presence(self, sql):
        if sql.startswith('SHOW TABLES LIKE '):
            name = sql.split("'")[1]
            return [{'x': name}] if name in self.tables else []
        return None

    def fetch_all(self, sql, params=None):
        p = self._presence(sql)
        if p is not None:
            return p
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount


def sqls(db):
    return [s for s, _ in db.calls]


def executed(db):
    """Only the write calls (execute()), skipping SELECTs recorded via fetch_one/fetch_all."""
    return [(s, p) for s, p in db.calls if s.strip().startswith(('DELETE', 'INSERT', 'UPDATE'))]


def ctx(body=None, query=None, user_id=3, method='POST'):
    return Ctx(method=method, uri='/', headers=Headers({}), query=query or {},
               body=body if body is not None else {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


def proxy(db=None, config=None):
    return MCPProxyController(db if db is not None else FakeDb(), config if config is not None else {})


def app_ctl(db=None, config=None):
    return MCPAppController(db if db is not None else FakeDb(), config if config is not None else {})


def mock(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


# ─── ported PHP oracle: McpProxyEndpointUrlTest.php ─────────────────────────

def test_resolve_endpoint_url_http_appends_mcp_when_missing():
    assert MCPProxyController.resolveEndpointUrl('https://x.test', 'http') == 'https://x.test/mcp'
    assert MCPProxyController.resolveEndpointUrl('https://x.test/', 'http') == 'https://x.test/mcp'


def test_resolve_endpoint_url_http_leaves_mcp_and_php_endpoints_alone():
    assert MCPProxyController.resolveEndpointUrl('https://x.test/mcp', 'http') == 'https://x.test/mcp'
    assert MCPProxyController.resolveEndpointUrl('http://localhost/AI_mcp/mcp-server.php', 'http') == \
        'http://localhost/AI_mcp/mcp-server.php'


def test_resolve_endpoint_url_sse_rewrites_sse_suffix_to_mcp():
    assert MCPProxyController.resolveEndpointUrl('https://x.test/sse', 'sse') == 'https://x.test/mcp'
    assert MCPProxyController.resolveEndpointUrl('https://x.test/sse/', 'sse') == 'https://x.test/mcp'


def test_resolve_endpoint_url_sse_without_sse_suffix_behaves_like_http():
    assert MCPProxyController.resolveEndpointUrl('https://x.test', 'sse') == 'https://x.test/mcp'
    assert MCPProxyController.resolveEndpointUrl('https://x.test/mcp', 'sse') == 'https://x.test/mcp'


def test_resolve_endpoint_url_http_does_not_rewrite_sse_suffix():
    # Existing behaviour for http transport is preserved verbatim.
    assert MCPProxyController.resolveEndpointUrl('https://x.test/sse', 'http') == 'https://x.test/sse/mcp'


# ─── normalizeHeaders (PHP 500-514) ─────────────────────────────────────────

def test_normalize_headers_object_form():
    c = proxy()
    assert c._normalizeHeaders({'Authorization': 'Bearer x', 'X-Foo': 'bar'}) == \
        ['Authorization: Bearer x', 'X-Foo: bar']


def test_normalize_headers_rejects_json_array_form():
    # A JSON array decodes with integer keys -> is_string($name) is always
    # false -> every entry skipped (PHP 506-507).
    c = proxy()
    assert c._normalizeHeaders(['Bearer x']) == []


def test_normalize_headers_skips_non_scalar_and_empty_names():
    c = proxy()
    assert c._normalizeHeaders({'': 'x', 'Good': 'ok', 'Bad': ['nested'], 'Null': None}) == ['Good: ok']


def test_normalize_headers_strips_crlf_and_colon_from_name_crlf_from_value():
    c = proxy()
    assert c._normalizeHeaders({'X-A\r\nB:C': 'v\r\nal'}) == ['X-ABC: val']


def test_normalize_headers_bool_cast():
    c = proxy()
    assert c._normalizeHeaders({'T': True, 'F': False}) == ['T: 1', 'F: ']


def test_normalize_headers_empty_or_invalid_input():
    c = proxy()
    assert c._normalizeHeaders(None) == []
    assert c._normalizeHeaders('not-array') == []
    assert c._normalizeHeaders({}) == []
    assert c._normalizeHeaders([]) == []


# ─── parseSSEResponse (PHP 410-429) ──────────────────────────────────────────

SSE_BODY = (
    'event: message\n'
    'data: {"jsonrpc":"2.0","id":1,"result":{"partial":true}}\n'
    '\n'
    'event: message\n'
    'data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"Metals News"},"capabilities":{}}}\n'
    '\n'
)


def test_parse_sse_response_takes_last_data_line():
    c = proxy()
    # Two "data:" lines: PHP keeps overwriting $jsonData, so the LAST one wins.
    assert c._parseSSEResponse(SSE_BODY) == {
        'jsonrpc': '2.0', 'id': 1,
        'result': {'serverInfo': {'name': 'Metals News'}, 'capabilities': []},
    }


def test_parse_sse_response_empty_object_becomes_empty_array():
    # json_decode(..., true) cannot distinguish {} from [] -> php_array().
    c = proxy()
    assert c._parseSSEResponse('data: {}\n') == []


def test_parse_sse_response_no_data_lines():
    c = proxy()
    assert c._parseSSEResponse('event: ping\n\n') is None


def test_parse_sse_response_ignores_non_json_data():
    c = proxy()
    assert c._parseSSEResponse('data: not json\n') is None


# ─── forward() validation (PHP 32-70) ───────────────────────────────────────

def test_forward_unknown_action():
    c = proxy()
    assert c.forward(ctx({'action': 'bogus'})) == {
        'success': False, 'error': {'code': -32600, 'message': 'Unknown action: bogus'}, 'status_code': 400,
    }


def test_forward_missing_action():
    c = proxy()
    assert c.forward(ctx({})) == {
        'success': False, 'error': {'code': -32600, 'message': 'Unknown action: '}, 'status_code': 400,
    }


def test_forward_discover_tools_requires_server_url():
    c = proxy()
    assert c.forward(ctx({'action': 'discover_tools'})) == {
        'success': False, 'error': {'code': -32602, 'message': 'Server URL required'}, 'status_code': 400,
    }
    assert c.forward(ctx({'action': 'discover_tools', 'server_url': ''})) == {
        'success': False, 'error': {'code': -32602, 'message': 'Server URL required'}, 'status_code': 400,
    }


def test_forward_proxy_requires_server_url_and_jsonrpc():
    c = proxy()
    assert c.forward(ctx({'action': 'proxy'})) == {
        'success': False, 'error': {'code': -32602, 'message': 'Server URL required'}, 'status_code': 400,
    }
    assert c.forward(ctx({'action': 'proxy', 'server_url': 'https://x.test'})) == {
        'success': False, 'error': {'code': -32602, 'message': 'JSON-RPC request required'}, 'status_code': 400,
    }


def test_forward_test_connection_requires_server_url():
    c = proxy()
    assert c.forward(ctx({'action': 'test_connection'})) == {
        'success': False, 'error': {'code': -32602, 'message': 'Server URL required'}, 'status_code': 400,
    }


# ─── proxyRequest happy path with MockTransport (PHP 75-168) ───────────────

def test_proxy_request_echo_and_header_injection(monkeypatch):
    seen = []

    def handler(req):
        seen.append(req)
        body = req.content
        import json as _json
        payload = _json.loads(body)
        if payload.get('method') == 'tools/list':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': payload['id'], 'result': {'tools': []}})
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': payload.get('id', 1), 'result': {}})

    db = FakeDb(one=[{'headers': '{"Authorization":"Bearer secret"}'}, {'transport': 'http'}])
    c = proxy(db)
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))

    result = c.forward(ctx({
        'action': 'proxy', 'server_id': 24, 'server_url': 'http://x.test',
        'jsonrpc': {'method': 'tools/list', 'params': {}, 'id': 1},
    }))

    assert result['success'] is True and result['status_code'] == 200
    assert result['response'] == {'jsonrpc': '2.0', 'id': 1, 'result': {'tools': []}}
    # tools/ prefix -> init handshake, notify, then the real call: 3 requests.
    assert len(seen) == 3
    for req in seen:
        assert req.headers.get('authorization') == 'Bearer secret'


def test_proxy_request_tools_call_arguments_defaults_to_empty_object(monkeypatch):
    captured = {}

    def handler(req):
        import json as _json
        payload = _json.loads(req.content)
        if payload.get('method') == 'tools/call':
            captured['params'] = payload['params']
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': payload.get('id', 1), 'result': {}})

    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))

    c.forward(ctx({
        'action': 'proxy', 'server_url': 'http://x.test',
        'jsonrpc': {'method': 'tools/call', 'params': {'name': 't', 'arguments': []}},
    }))

    assert captured['params'] == {'name': 't', 'arguments': {}}


def test_proxy_request_init_failure(monkeypatch):
    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(lambda r: httpx.Response(500)))
    result = c.forward(ctx({
        'action': 'proxy', 'server_url': 'http://x.test',
        'jsonrpc': {'method': 'tools/list', 'params': {}},
    }))
    assert result == {
        'success': False, 'error': {'code': -32603, 'message': 'Failed to initialize MCP session'}, 'status_code': 500,
    }


def test_proxy_request_connect_failure_no_init_needed(monkeypatch):
    def boom(req):
        raise httpx.ConnectError('refused', request=req)
    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(boom))
    result = c.forward(ctx({
        'action': 'proxy', 'server_url': 'http://x.test',
        'jsonrpc': {'method': 'ping'},
    }))
    assert result == {
        'success': False, 'error': {'code': -32603, 'message': 'Failed to connect to MCP server'}, 'status_code': 500,
    }


# ─── testConnection (PHP 173-225) ───────────────────────────────────────────

def test_test_connection_success(monkeypatch):
    def handler(req):
        return httpx.Response(200, json={
            'jsonrpc': '2.0', 'id': 1,
            'result': {'serverInfo': {'name': 'Metals News', 'version': '1.0'}, 'capabilities': {'tools': {}}},
        })
    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))
    result = c.forward(ctx({'action': 'test_connection', 'server_url': 'http://x.test'}))
    assert result == {
        'success': True,
        'serverInfo': {'name': 'Metals News', 'version': '1.0'},
        'capabilities': {'tools': []},
        'status_code': 200,
    }


def test_test_connection_jsonrpc_error(monkeypatch):
    def handler(req):
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32601, 'message': 'nope'}})
    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))
    result = c.forward(ctx({'action': 'test_connection', 'server_url': 'http://x.test'}))
    assert result == {
        'success': False, 'error': 'nope', 'details': {'code': -32601, 'message': 'nope'}, 'status_code': 500,
    }


def test_test_connection_network_failure(monkeypatch):
    def boom(req):
        raise httpx.ConnectError('refused', request=req)
    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(boom))
    result = c.forward(ctx({'action': 'test_connection', 'server_url': 'http://x.test'}))
    assert result['success'] is False and result['status_code'] == 500
    assert result['url_tried'] == 'http://x.test/mcp'
    assert result['error'].startswith('Connection failed:')


# ─── discoverTools + cacheTools (PHP 230-313, 519-547) ──────────────────────

def test_discover_tools_caches_and_deletes_first(monkeypatch):
    def handler(req):
        import json as _json
        payload = _json.loads(req.content)
        if payload['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {'serverInfo': {'name': 'S'}}})
        if payload['method'] == 'notifications/initialized':
            return httpx.Response(200, json={'success': True})
        if payload['method'] == 'tools/list':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2, 'result': {'tools': [
                {'name': 'a', 'description': 'desc a', 'inputSchema': {'type': 'object', 'properties': {}}},
                {'name': 'b', 'inputSchema': {'type': 'object', 'properties': {'x': {'type': 'string'}}},
                 '_meta': {'ui': {'resourceUri': 'ui://b'}}},
            ]}})
        raise AssertionError(payload)

    db = FakeDb()
    c = proxy(db)
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))

    result = c.forward(ctx({'action': 'discover_tools', 'server_id': 24, 'server_url': 'http://x.test'}))
    assert result['success'] is True and result['status_code'] == 200
    assert [t['name'] for t in result['tools']] == ['a', 'b']
    assert result['serverInfo'] == {'name': 'S'}

    writes = executed(db)
    assert writes[0] == ('DELETE FROM mcp_server_tools WHERE server_id = ?', [24])
    insert_sql = "\n                INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)\n                VALUES (?, ?, ?, ?, ?, ?)\n            "
    assert writes[1] == (insert_sql, [24, 'a', 'desc a', '{"type":"object","properties":{}}', 0, None])
    assert writes[2] == (insert_sql, [24, 'b', '', '{"type":"object","properties":{"x":{"type":"string"}}}', 1, 'ui://b'])


def test_discover_tools_list_failure(monkeypatch):
    def handler(req):
        import json as _json
        payload = _json.loads(req.content)
        if payload['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {}})
        if payload['method'] == 'notifications/initialized':
            return httpx.Response(200, json={'success': True})
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2, 'error': {'message': 'boom'}})

    c = proxy()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))
    result = c.forward(ctx({'action': 'discover_tools', 'server_url': 'http://x.test'}))
    assert result == {
        'success': False, 'error': {'code': -32603, 'message': 'Failed to list tools from MCP server'}, 'status_code': 500,
    }


# ─── sanitizeSchema (PHP 552-577) ───────────────────────────────────────────

def test_sanitize_schema_empty_becomes_object():
    c = proxy()
    assert c._sanitizeSchema({}) == {}
    assert c._sanitizeSchema([]) == {}


def test_sanitize_schema_strips_meta_keys():
    c = proxy()
    schema = {'$schema': 'http://json-schema.org/draft-07/schema#', 'default': 'x', '$id': 'id',
              'definitions': {'a': 1}, '$defs': {'b': 2}, 'type': 'object'}
    assert c._sanitizeSchema(schema) == {'type': 'object'}


def test_sanitize_schema_recurses_and_empties_nested_containers():
    c = proxy()
    schema = {'type': 'object', 'properties': {}, 'items': [], 'required': ['a', 'b'],
              'nested': {'$id': 'drop-me', 'properties': {'inner': {}}}}
    assert c._sanitizeSchema(schema) == {
        'type': 'object', 'properties': {}, 'items': {}, 'required': ['a', 'b'],
        'nested': {'properties': {'inner': {}}},
    }


def test_sanitize_schema_scalar_passthrough():
    c = proxy()
    assert c._sanitizeSchema('freeform') == 'freeform'
    assert c._sanitizeSchema(None) is None


# ─── MCPAppController.getResource (PHP 32-170) ──────────────────────────────

def app_ctx(query=None):
    return Ctx(method='GET', uri='/api/v1/mcp/app', headers=Headers({}), query=query or {}, body={},
               raw_body='', params={}, user_id=None, authenticated=False, remote_addr='')


def test_get_resource_missing_server():
    c = app_ctl()
    assert c.getResource(app_ctx({})) == {
        'error': 'Missing server parameter', 'status_code': 400, 'content_type': 'text/plain',
    }


def test_get_resource_missing_resource():
    c = app_ctl()
    assert c.getResource(app_ctx({'server': 'http://x.test'})) == {
        'error': 'Missing resource parameter', 'status_code': 400, 'content_type': 'text/plain',
    }


def test_get_resource_init_failure(monkeypatch):
    c = app_ctl()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(lambda r: httpx.Response(500)))
    result = c.getResource(app_ctx({'server': 'http://x.test', 'resource': 'ui://x'}))
    assert result == {'error': 'Failed to initialize MCP session', 'status_code': 502, 'content_type': 'text/plain'}


def test_get_resource_happy_path(monkeypatch):
    def handler(req):
        import json as _json
        payload = _json.loads(req.content)
        if payload['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {}})
        if payload['method'] == 'notifications/initialized':
            return httpx.Response(200, json={'success': True})
        if payload['method'] == 'resources/read':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2, 'result': {
                'contents': [{'uri': payload['params']['uri'], 'text': '<html><head></head><body>hi</body></html>'}],
            }})
        raise AssertionError(payload)

    c = app_ctl()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))
    result = c.getResource(app_ctx({
        'server': 'http://x.test/', 'resource': 'ui://widget', 'west': '1.5', 'label': 'Widget',
    }))
    assert result['status_code'] == 200 and result['content_type'] == 'text/html; charset=utf-8'
    assert '<script>' in result['html'] and 'window.MCP_INIT_DATA' in result['html']
    assert result['html'].endswith('<body>hi</body></html>')
    assert '"west":1.5' in result['html'] and '"label":"Widget"' in result['html']
    assert "window.MCP_SERVER_URL = 'http://x.test/';" in result['html']


def test_get_resource_no_html_content(monkeypatch):
    def handler(req):
        import json as _json
        payload = _json.loads(req.content)
        if payload['method'] == 'initialize':
            return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {}})
        if payload['method'] == 'notifications/initialized':
            return httpx.Response(200, json={'success': True})
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 2, 'result': {'contents': []}})

    c = app_ctl()
    monkeypatch.setattr(c, '_makeClient', lambda: mock(handler))
    result = c.getResource(app_ctx({'server': 'http://x.test', 'resource': 'ui://x'}))
    assert result == {'error': 'No HTML content in MCP resource', 'status_code': 502, 'content_type': 'text/plain'}
