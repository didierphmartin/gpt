"""Port of backend/tests/Unit/Playbook/LoaderMcpExecutorTest.php (78 lines, 3 cases)."""
from __future__ import annotations

import json

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor


class _FakeLoader:
    def __init__(self):
        self._tools = {
            'mcp_search_users': {
                'original_name': 'search_users',
                'server_id': 1,
                'server_url': 'http://localhost/mockokta/',
                'server_name': 'Okta',
                'server_headers': [],
                'description': 'Find an Okta user by email address.',
                'input_schema_json': json.dumps({
                    'type': 'object',
                    'properties': {'email': {'type': 'string'}},
                    'required': ['email'],
                }),
                'has_ui': False,
                'ui_resource_uri': None,
            },
        }
        self._executeToolCalls = []
        self._executeToolResult = None

    def getTools(self):
        return self._tools

    def executeTool(self, name, args):
        self._executeToolCalls.append((name, args))
        return self._executeToolResult


def test_available_tools_maps_slug_key():
    adapter = LoaderMcpExecutor(_FakeLoader())
    tools = adapter.availableTools()

    assert 'okta.search_users' in tools
    assert tools['okta.search_users']['description'] == 'Find an Okta user by email address.'
    assert tools['okta.search_users']['input_schema']['type'] == 'object'
    assert tools['okta.search_users']['input_schema']['required'] == ['email']


def test_call_proxies_to_loader_execute_tool():
    loader = _FakeLoader()
    loader._executeToolResult = {'content': [{'type': 'text', 'text': 'ok'}]}

    adapter = LoaderMcpExecutor(loader)
    result = adapter.call('okta', 'search_users', {'email': 'x'})

    assert loader._executeToolCalls == [('mcp_search_users', {'email': 'x'})]
    assert result['ok'] is True
    assert result['result'] == {'content': [{'type': 'text', 'text': 'ok'}]}


def test_call_maps_loader_error_to_ok_false():
    loader = _FakeLoader()
    loader._executeToolResult = {'error': True, 'message': "MCP tool 'search_users' not found"}

    adapter = LoaderMcpExecutor(loader)
    result = adapter.call('okta', 'search_users', {'email': 'x'})

    assert result['ok'] is False
    assert result['error'] == "MCP tool 'search_users' not found"
