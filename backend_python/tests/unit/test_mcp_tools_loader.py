import json
import httpx
from app.services.mcp_tools_loader import MCPToolsLoader

ROW = {'id': 9, 'server_id': 2, 'tool_name': 'lookup', 'tool_description': 'Find', 'input_schema': '{"type":"object","properties":{"q":{"type":"string"}}}',
       'has_ui': 0, 'ui_resource_uri': None, 'cached_at': None, 'server_id_col': 2, 'server_url': 'http://mcp.local/mcp',
       'server_name': 'srv', 'server_user_id': None, 'server_headers': '{"X-Key":"v"}', 'server_transport': 'http'}


class Db:
    def __init__(self, rows, overrides=(), settings=None): self.rows = rows; self.overrides = list(overrides); self.settings = settings; self.calls = []
    def fetch_one(self, sql, p=None):
        self.calls.append(sql); return self.settings if 'user_mcp_settings' in sql else None
    def fetch_all(self, sql, p=None):
        self.calls.append(sql)
        if 'user_mcp_overrides' in sql: return self.overrides
        return self.rows


def test_load_prefixes_and_definitions():
    ld = MCPToolsLoader(Db([ROW]))
    tools = ld.loadToolsForUser('3')
    assert list(tools) == ['mcp_lookup'] and tools['mcp_lookup']['server_headers'] == ['X-Key: v'] and tools['mcp_lookup']['has_ui'] is False
    assert ld.getToolDefinitions() == [{'name': 'mcp_lookup', 'description': '[MCP:srv] Find', 'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}}]
    assert ld.isMCPTool('lookup') and ld.isMCPTool('mcp_lookup') and ld.hasTools()


def test_master_switch_off_yields_no_tools():
    assert MCPToolsLoader(Db([ROW], settings={'mcp_enabled': 0})).loadToolsForUser('3') == {}


def test_allowlist_and_overrides():
    private = {**ROW, 'server_user_id': 3, 'server_name': 'mine'}
    assert list(MCPToolsLoader(Db([ROW])).loadToolsForUser('3', ['other'])) == []                        # global gated by allowlist
    assert list(MCPToolsLoader(Db([private])).loadToolsForUser('3', [])) == ['mcp_lookup']                  # private always allowed
    assert list(MCPToolsLoader(Db([ROW], overrides=[{'server_id': 2, 'allowed': 0}])).loadToolsForUser('3')) == []
    assert list(MCPToolsLoader(Db([ROW], overrides=[{'server_id': 2, 'allowed': 1}])).loadToolsForUser('3', [])) == ['mcp_lookup']


def _loader_with_transport(handler, row=ROW):
    ld = MCPToolsLoader(Db([row])); ld.loadToolsForUser('3')
    ld._http = httpx.Client(transport=httpx.MockTransport(handler))
    return ld


def test_execute_tool_jsonrpc_and_text_result():
    seen = {}
    def handler(req):
        seen['headers'] = dict(req.headers); seen['body'] = json.loads(req.content)
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': 1, 'result': {'content': [{'type': 'text', 'text': 'A'}, {'text': 'B'}], '_meta': None}})
    ld = _loader_with_transport(handler)
    out = ld.executeTool('lookup', {'q': 'x'})
    assert out == {'result': 'A\nB', '_meta': None}
    assert seen['body']['method'] == 'tools/call' and seen['body']['params'] == {'name': 'lookup', 'arguments': {'q': 'x'}}
    assert seen['headers']['x-key'] == 'v' and seen['headers']['accept'] == 'application/json, text/event-stream, */*'


def test_execute_tool_sse_body_http_error_and_rpc_error():
    ld = _loader_with_transport(lambda r: httpx.Response(200, text='event: message\ndata: {"result":{"content":[{"type":"text","text":"S"}]}}\n\n'))
    assert ld.executeTool('mcp_lookup', {}) == {'result': 'S', '_meta': None}
    ld2 = _loader_with_transport(lambda r: httpx.Response(500, text='x'))
    assert ld2.executeTool('lookup', {}) == {'error': True, 'message': 'MCP server returned HTTP 500'}
    ld3 = _loader_with_transport(lambda r: httpx.Response(200, json={'error': {'message': 'nope'}}))
    assert ld3.executeTool('lookup', {}) == {'error': True, 'message': 'nope'}
    assert MCPToolsLoader(Db([])).executeTool('zzz', {}) == {'error': True, 'message': "MCP tool 'zzz' not found"}


def test_execute_tool_ui_metadata():
    row = {**ROW, 'has_ui': 1, 'ui_resource_uri': 'ui://x'}
    ld = _loader_with_transport(lambda r: httpx.Response(200, json={'result': {'content': [{'type': 'text', 'text': 'T'}]}}), row)
    out = ld.executeTool('lookup', {'a': 1})
    ui = out['_mcp_ui']
    assert ui['has_ui'] is True and ui['tool_name'] == 'lookup' and ui['resource_uri'] == 'ui://x' and ui['arguments'] == {'a': 1}
    assert ui['tool_result'] == {'content': [{'type': 'text', 'text': 'T'}]} and ui['has_error'] is False


def test_execute_tool_top_level_list_response():
    # PHP isset($parsed['error']) on a list is false, and $parsed['result'] ?? $parsed
    # yields the list itself when there's no 'result' key -- must not AttributeError.
    ld = _loader_with_transport(lambda r: httpx.Response(200, json=[{'a': 1}]))
    assert ld.executeTool('lookup', {}) == {'result': '[{"a":1}]'}
