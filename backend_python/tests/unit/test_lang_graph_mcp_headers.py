"""Port of backend/tests/Unit/LangGraphMcpHeadersTest.php (spec 2026-10-07 §7.1: MCP headers come from
MCP_HEADERS_<SLUG>, never from the script)."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

import pytest

from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from tests.unit import lg_support as S

SECRET = 'sekret-conn-key-7731'


def _run_py(tail: str, env: dict | None = None) -> tuple:
    py = S.require_py310()
    src = ("import json, os, sys, time\nclass httpx:\n    class Client:\n        pass\n"
           "MCP_SERVER_SLUGS = {'http://o/mcp': 'outlook'}\n" + LangGraphRuntime.mcpClientBlock() + '\n' + tail)
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([py, f.name], capture_output=True, text=True, env={**os.environ, **(env or {})})
    finally:
        os.unlink(f.name)
    return r.returncode, [line for line in (r.stdout + r.stderr).split('\n') if line != '']


def test_headers_from_environment_are_merged():
    rc, out = _run_py("print(json.dumps(MCP._headers('http://o/mcp'), sort_keys=True))",
                      {'MCP_HEADERS_OUTLOOK': '{"X-Outlook-Account": "k-1"}'})
    assert rc == 0, '\n'.join(out)
    h = json.loads(out[0])
    assert h['X-Outlook-Account'] == 'k-1'
    assert h['Content-Type'] == 'application/json'


def test_no_variable_means_base_headers():
    _, out = _run_py("print('X-Outlook-Account' in MCP._headers('http://o/mcp'), 'Accept' in MCP._headers('http://x/mcp'))")
    assert out == ['False True']


def test_bad_header_json_names_the_variable():
    rc, out = _run_py("MCP._headers('http://o/mcp')", {'MCP_HEADERS_OUTLOOK': 'not json'})
    assert rc != 0
    assert 'MCP_HEADERS_OUTLOOK' in '\n'.join(out)


def test_non_object_header_json_names_the_variable():
    rc, out = _run_py("MCP._headers('http://o/mcp')", {'MCP_HEADERS_OUTLOOK': '["a"]'})
    assert rc != 0
    assert 'MCP_HEADERS_OUTLOOK' in '\n'.join(out)


def test_non_string_or_multiline_header_value_names_the_variable_not_the_value():
    for bad in ('{"X-A": 5}', '{"X-A": "a\\nb"}'):
        rc, out = _run_py("MCP._headers('http://o/mcp')", {'MCP_HEADERS_OUTLOOK': bad})
        assert rc != 0
        text = '\n'.join(out)
        assert 'MCP_HEADERS_OUTLOOK' in text
        assert 'a\\nb' not in text


def test_every_request_uses_server_headers():
    src = LangGraphRuntime.mcpClientBlock()
    assert src.count('headers=self.HEADERS') == 0, 'all requests go through _headers()'
    assert src.count('headers=h,') == 2
    assert src.count('headers=self._headers(server_url)') == 2


_DDL = ('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
        'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
        S.LLM_DDL)


def _generate(options: dict, extraServers: list | None = None, useExtra: bool = False) -> dict:
    extraServers = extraServers or []
    stmts = [*_DDL, "INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, "
                    "'{\"X-Outlook-Account\": \"" + SECRET + "\"}')"]
    for i, (name, url) in enumerate(extraServers):
        stmts.append(f"INSERT INTO mcp_servers VALUES ({10 + i}, '3', '{name}', '{url}', 1, NULL)")
        stmts.append(f"INSERT INTO mcp_server_tools VALUES ({10 + i}, {10 + i}, 'tool_{i}', 'T', '{{}}')")
    stmts += ["INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')",
              "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)"]
    tools = ['mcp_list_messages'] + ([f'mcp_tool_{i}' for i in range(len(extraServers))] if useExtra else [])
    graph = {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            {'id': '2', 'node_type': '', 'config': {'type': 'agent-template', 'agent_name': 'Mailer', 'agent_type': 'standard',
                                                     'instructions': 'Read mail.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-6',
                                                     'tools': tools, 'settings': {'temperature': 0.7, 'max_tokens': 4096}}},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}],
    }
    return S.generator(S.db(*stmts), graph, {'id': 44, 'name': 'Mail', 'user_id': '3'}).generate(44, '3', options)


def test_single_file_emits_slugs_and_docs_but_no_header_value():
    import re
    code = _generate({})['code']
    assert re.search(r'MCP_SERVER_SLUGS = \{\s*"http://localhost/outlook/mcp": "outlook"\s*\}', code)
    assert code.index('MCP_SERVER_SLUGS = ') < code.index('class McpClient')
    assert 'MCP_HEADERS_OUTLOOK=' in code
    assert SECRET not in code


def test_modular_emits_slugs_and_no_header_value():
    allc = ''.join(f['code'] + '\n' for f in _generate({'modular': True})['files'])
    assert 'MCP_SERVER_SLUGS = ' in allc
    assert 'MCP_HEADERS_OUTLOOK=' in allc
    assert SECRET not in allc


def test_only_servers_the_workflow_uses_are_listed_and_documented():
    code = _generate({}, [('Calendar', 'http://localhost/cal/mcp')])['code']
    assert '"http://localhost/outlook/mcp": "outlook"' in code
    assert 'calendar' not in code.lower()
    assert 'MCP_HEADERS_CALENDAR' not in code


def test_two_used_servers_with_the_same_slug_are_refused():
    with pytest.raises(RuntimeError, match='MCP_HEADERS_OUTLOOK'):
        _generate({}, [('outlook', 'http://localhost/other/mcp')], True)


def test_same_slug_on_an_unused_server_is_fine():
    assert 'http://localhost/other/mcp' not in _generate({}, [('outlook', 'http://localhost/other/mcp')])['code']


def _generate_code(servers: list) -> dict:
    stmts = [*_DDL,
             "INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://localhost/outlook/mcp', 1, NULL)",
             "INSERT INTO mcp_servers VALUES (6, '3', 'Outlook Work', 'http://localhost/outlook/mcp', 1, NULL)",
             "INSERT INTO mcp_server_tools VALUES (1, 5, 'list_messages', 'List', '{}')",
             "INSERT INTO mcp_server_tools VALUES (2, 6, 'list_messages', 'List', '{}')"]
    graph = {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Poll',
                                                          'code': "def run(input, call_tool):\n    return {'route': 'next', 'output': 'x'}\n",
                                                          'exits': ['next'], 'mcp_servers': servers, 'timeout_s': 30}},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}],
    }
    return S.generator(S.db(*stmts), graph, {'id': 44, 'name': 'Mail', 'user_id': '3'}).generate(44, '3', {})


def test_two_used_servers_on_one_url_are_refused():
    with pytest.raises(RuntimeError) as e:
        _generate_code(['Outlook', 'Outlook Work'])
    assert '"Outlook"' in str(e.value)
    assert '"Outlook Work"' in str(e.value)
    assert 'one connection per MCP URL' in str(e.value)


def test_the_one_used_server_on_a_shared_url_keeps_its_own_header_variable():
    code = _generate_code(['Outlook Work'])['code']
    assert '"http://localhost/outlook/mcp": "outlook_work"' in code
    assert 'MCP_HEADERS_OUTLOOK_WORK=' in code
    assert 'MCP_HEADERS_OUTLOOK=' not in code


def test_the_docs_say_one_connection_per_url():
    assert 'one connection per MCP URL' in _generate({})['code']
