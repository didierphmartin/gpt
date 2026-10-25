"""Ports of backend/tests/Unit/Controllers/CodeNodeControllerTest.php and
backend/tests/Unit/LoaderMcpExecutorRawTest.php (POST /workflows/code-node/tool-call and
the raw MCP result it hands the code node). No network: the MCP server is an httpx MockTransport."""
from __future__ import annotations

import json

import httpx

from app.agent_team.controllers.code_node_controller import CodeNodeController
from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.routes import ROUTES
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.phpjson import dumps


class _Recorder:
    def __init__(self, answer=None):
        self.calls = []
        self.answer = answer if answer is not None else {'ok': True, 'result': {'content': []}}

    def controller(self) -> CodeNodeController:
        def factory(userId):
            def call(server, tool, args):
                self.calls.append([userId, server, tool, args])
                return self.answer
            return call
        return CodeNodeController(None, {}, factory)


def test_calls_the_tool_as_the_user():
    rec = _Recorder()
    r = rec.controller().toolCall({'user_id': 7, 'body': {'server': 'servicenow', 'tool': 'poll_jobs', 'args': {'tag': 'x'}}})
    assert r == {'ok': True, 'result': {'content': []}}
    assert rec.calls == [[7, 'servicenow', 'poll_jobs', {'tag': 'x'}]]


def test_tool_error_is_an_ok_false_answer():
    rec = _Recorder({'ok': False, 'error': 'MCP tool not found'})
    r = rec.controller().toolCall({'user_id': 7, 'body': {'server': 'okta', 'tool': 'reset'}})
    assert r == {'ok': False, 'error': 'MCP tool not found'}
    assert rec.calls[0][3] == [], 'missing args become [] (sent to the MCP server as {})'


def test_refuses_without_user_or_with_bad_input():
    rec = _Recorder()
    assert rec.controller().toolCall({'body': {}}) == {'ok': False, 'error': 'Authentication required', 'status_code': 401}
    for body in [{'server': 'Service Now', 'tool': 'x'}, {'server': 'servicenow', 'tool': 'a b'},
                 {'server': 'servicenow', 'tool': 'x', 'args': 'nope'}, {'tool': 'x'}]:
        r = rec.controller().toolCall({'user_id': 7, 'body': body})
        assert r['ok'] is False, json.dumps(body)
        assert r['status_code'] == 400, json.dumps(body)
    assert rec.calls == []


def test_route_is_registered():
    assert ('POST', '/api/v1/workflows/code-node/tool-call', ('AgentTeam:CodeNodeController', 'toolCall')) in ROUTES


# --- LoaderMcpExecutorRawTest ------------------------------------------------------------

class _FakeLoader:
    def __init__(self, raw):
        self.raw = raw

    def getTools(self):
        return {'mcp_poll_jobs': {'server_name': 'ServiceNow', 'original_name': 'poll_jobs'}}

    def executeToolRaw(self, name, args):
        return self.raw if name == 'mcp_poll_jobs' else {'error': True, 'message': 'wrong name'}


def test_raw_result_keeps_structured_content_and_is_error():
    raw = {'content': [{'type': 'text', 'text': 'not_claimable: closed'}], 'isError': True,
           'structuredContent': {'error': {'code': 'not_claimable'}}}
    r = LoaderMcpExecutor(_FakeLoader({'error': False, 'raw': raw})).callRaw('servicenow', 'poll_jobs', [])
    assert r == {'ok': True, 'result': raw}


def test_unknown_tool_and_transport_failure():
    ex = LoaderMcpExecutor(_FakeLoader({'error': True, 'message': 'MCP connection failed: refused'}))
    assert ex.callRaw('okta', 'reset', []) == {'ok': False, 'error': "MCP tool 'okta.reset' not found"}
    assert ex.callRaw('servicenow', 'poll_jobs', []) == {'ok': False, 'error': 'MCP connection failed: refused'}


def _http_loader(body: str) -> MCPToolsLoader:
    """A real loader whose HTTP POST answers body (the MCP server's response)."""
    loader = MCPToolsLoader(None)
    loader._http.close()
    loader._http = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, text=body)))
    loader.tools = {'mcp_poll_jobs': {'server_url': 'http://mcp.test/', 'server_name': 'ServiceNow',
                                      'original_name': 'poll_jobs', 'server_headers': [], 'server_transport': 'http',
                                      'has_ui': False}}
    return loader


def test_empty_objects_stay_objects_through_the_controller():
    result = '{"content":[{"type":"text","text":"{}"}],"structuredContent":{"job":{"number":"SCTASK1","variables":{}},"meta":{}}}'
    for body in ['{"jsonrpc":"2.0","id":1,"result":' + result + '}',
                 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":' + result + '}\n\n']:
        executor = LoaderMcpExecutor(_http_loader(body))
        controller = CodeNodeController(None, {}, lambda uid: (lambda s, t, a: executor.callRaw(s, t, a)))
        out = dumps(controller.toolCall({'user_id': 7, 'body': {'server': 'servicenow', 'tool': 'poll_jobs'}}))
        assert out == '{"ok":true,"result":' + result + '}'


def test_formatted_result_is_unchanged():
    loader = _http_loader('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}],"structuredContent":{}}}')
    assert loader.executeTool('mcp_poll_jobs', []).get('result') == 'hello'


def test_json_rpc_error_object_is_an_error():
    """executeToolRaw: a JSON-RPC error (no content) is a failure, never a tool result."""
    loader = _http_loader('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such tool"}}')
    r = loader.executeToolRaw('poll_jobs', {})
    assert r['error'] is True
    assert loader.executeToolRaw('nope', {}) == {'error': True, 'message': "MCP tool 'nope' not found"}
