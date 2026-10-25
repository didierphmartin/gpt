"""Port of backend/tests/Unit/AdkCodeNodeTest.php: ADK code nodes, the MCP client's slugs and headers, gates
after a choice. mcp_analyzed(), code_analyzed() and wf64_analyzed() are the analyses the other ADK (and
MAF / NOOA) tests build on, as PHP's AdkCodeNodeTest statics are."""
from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import tempfile

import pytest

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def _agent(name, prompt, model='m', tools=None) -> dict:
    return {'name': name, 'systemPrompt': prompt, 'provider': 'claude', 'model': model, 'temperature': None,
            'max_tokens': None, 'tools': tools or [], 'skill_content': '', 'output_schema_id': None, 'documents': []}


def mcp_analyzed() -> dict:
    """Start -> agent A (one MCP tool on server "Outlook") -> Output."""
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A',
                                                'provider': 'claude', 'model': 'm', 'selectedTools': ['list_mail']}},
        {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}]}
    return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
            'workflow': {'id': 7, 'name': 'mcp'}, 'generated_at': '2026-01-01 00:00:00 UTC',
            'usedCatalog': {'list_mail': {'server_url': 'http://localhost:8770', 'description': 'List',
                                          'input_schema': {'type': 'object', 'properties': []}}},
            'usedServers': {'http://localhost:8770': {'name': 'Outlook'}},
            'serverSlugs': {'http://localhost:8770': 'outlook'},
            'startPrompt': 'GO', 'startDocuments': [],
            'agents': {'2': _agent('A', 'A', tools=['list_mail'])}}


def code_analyzed(src: str = "def run(input, call_tool):\n    return {'output': {'got': input}}\n") -> dict:
    """Start -> code C (exits next, server Outlook) -> Output."""
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '2', 'type': 'code', 'config': {'type': 'code', 'name': 'C', 'code': src,
                                               'exits': ['next'], 'mcp_servers': ['Outlook'], 'timeout_s': 30}},
        {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}
    a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
         'workflow': {'id': 8, 'name': 'code'}, 'generated_at': '2026-01-01 00:00:00 UTC',
         'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {'http://localhost:8770': 'outlook'},
         'startPrompt': 'GO', 'startDocuments': [], 'agents': {}, 'playbooks': {}}
    a['code'] = {'2': CodeNodeEmit.nodeData(graph['nodes'][1], graph['edges'], {'outlook': 'http://localhost:8770'},
                                            ['1', '2', '3'])}
    return a


def wf64_analyzed() -> dict:
    """wf 64's shape: Start -> trigger T (exits new_mail, no_mail) -> dispatcher D -> code A | code B -> Output O."""
    code = "def run(input, call_tool):\n    return {'output': input}\n"
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '10', 'type': 'code', 'config': {'type': 'code', 'name': 'T', 'code': "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': {'subject': 'hi'}}\n",
                                                'exits': ['new_mail', 'no_mail'], 'mcp_servers': []}},
        {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'D', 'agent_type': 'dispatcher', 'provider': 'claude', 'model': 'm'}},
        {'id': '3', 'type': 'code', 'config': {'type': 'code', 'name': 'A', 'code': code, 'exits': ['next'], 'mcp_servers': []}},
        {'id': '4', 'type': 'code', 'config': {'type': 'code', 'name': 'B', 'code': code, 'exits': ['next'], 'mcp_servers': []}},
        {'id': '5', 'type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from': '1', 'to': '10', 'from_port': 'output_1'},
        {'from': '10', 'to': '2', 'from_port': 'output_1'},
        {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
        {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'},
    ]}
    a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
         'workflow': {'id': 64, 'name': 'wf64'}, 'generated_at': '2026-01-01 00:00:00 UTC',
         'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {},
         'startPrompt': 'GO', 'startDocuments': [], 'playbooks': {},
         'agents': {'2': _agent('D', 'Route the email.')}}
    by_id = {n['id']: n for n in graph['nodes']}
    a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {}, ['1', '10', '2', '3', '4', '5'])
                 for cid in ('10', '3', '4')}
    return a


def _python3() -> str:
    py = shutil.which('python3')
    if py is None:
        pytest.skip('python3 not on PATH')
    return py


def _run_py(code: str, snippet: str, env: dict | None = None) -> tuple[int, str]:
    """Runs a snippet against the emitted module's MCP CLIENT section (no network)."""
    d = tempfile.mkdtemp(prefix='adkcn_')
    start = code.index('MCP_SERVER_SLUGS = ')
    end = code.index('# =====', start)
    with open(os.path.join(d, 'm.py'), 'w', encoding='utf-8') as f:
        f.write('import json, os, time\nimport httpx\n' + code[start:end] + '\n' + snippet)
    r = subprocess.run([_python3(), 'm.py'], cwd=d, capture_output=True, text=True, env={**os.environ, **(env or {})})
    return r.returncode, (r.stdout + r.stderr).rstrip('\n')


def py_compile(code: str) -> tuple[int, str]:
    path = os.path.join(tempfile.gettempdir(), f'adkcn_{secrets.token_hex(4)}.py')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(code)
    r = subprocess.run([_python3(), '-m', 'py_compile', path], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def test_mcp_client_bakes_slugs_and_reads_headers_from_env():
    code = ADKGenerator.emitAdk(mcp_analyzed())
    assert 'MCP_SERVER_SLUGS = {\n    "http://localhost:8770": "outlook"' in code
    assert 'MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}' in code
    assert 'var = f"MCP_HEADERS_{slug.upper()}"' in code
    assert 'def _call_mcp_tool_raw(server_url: str, tool_name: str, arguments: dict) -> dict:' in code
    assert 'def _init_mcp_session(url: str, headers: dict)' not in code


def test_dotenv_lookup_covers_single_file_and_package():
    code = ADKGenerator.emitAdk(mcp_analyzed())
    assert 'for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):' in code


def test_headers_merge_and_bad_json_names_the_variable():
    code = ADKGenerator.emitAdk(mcp_analyzed())
    rc, out = _run_py(code, 'print(_mcp_headers("http://localhost:8770")["X-Outlook-Account"])',
                      {'MCP_HEADERS_OUTLOOK': '{"X-Outlook-Account":"acc-1"}'})
    assert rc == 0, out
    assert out.strip() == 'acc-1'
    rc, out = _run_py(code, '_mcp_headers("http://localhost:8770")', {'MCP_HEADERS_OUTLOOK': '{oops'})
    assert rc != 0
    assert 'MCP_HEADERS_OUTLOOK in .env is not valid JSON' in out


def test_url_override_from_env():
    code = ADKGenerator.emitAdk(mcp_analyzed())
    rc, out = _run_py(code, 'print(_mcp_live_url("http://localhost:8770"))', {'MCP_URL_OUTLOOK': 'http://h:1'})
    assert rc == 0, out
    assert out.strip() == 'http://h:1'


def test_code_node_emits_code_agent_with_harness():
    code = ADKGenerator.emitAdk(code_analyzed())
    assert 'CODE_HARNESS = types_module.ModuleType("code_node_harness")' in code
    assert 'class _CodeAgent(BaseAgent):' in code
    assert 'node_2 = _CodeAgent(' in code
    assert 'parents=[["user_prompt", "Start", True]]' in code
    assert 'node_name=self.display' in code
    assert re.search(r'sub_agents=\[\s*node_2,\s*node_3\s*\]', code)
    rc, out = py_compile(code)
    assert rc == 0, out


def test_code_parents_substitute_dispatcher():
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start'}},
        {'id': '2', 'type': 'code', 'config': {'type': 'code', 'name': 'T', 'code': "def run(input, call_tool):\n    return 1\n", 'exits': ['next'], 'mcp_servers': []}},
        {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'D', 'agent_type': 'dispatcher'}},
        {'id': '4', 'type': 'code', 'config': {'type': 'code', 'name': 'B', 'code': "def run(input, call_tool):\n    return 1\n", 'exits': ['next'], 'mcp_servers': []}},
    ], 'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '3', 'to': '4'}]}
    a = WorkflowGraphAnalyzer.analyzeGraph(graph)
    assert ADKGenerator.codeParents(a, '2') == [['user_prompt', 'Start', True]]
    assert ADKGenerator.codeParents(a, '4') == [['node_2', 'T', False]]


def test_wf64_shape_routes_through_gates_and_nests_code_in_dispatcher():
    code = ADKGenerator.emitAdk(wf64_analyzed())
    assert re.search(r'node_2__dispatch = _DispatcherAgent\(.*?sub_agents=\[node_2, node_3, node_4\]', code, re.S)
    assert 'task_keys=["node_10"]' in code
    assert re.search(r'_agent_instruction\(.*?\["node_10"\]\)', code, re.S)
    assert '_Gate(name="gate_2", when=[["node_10", "route_10", "new_mail"]], sub_agents=[node_2__dispatch])' in code
    assert '_Gate(name="gate_5", when=[["node_3", "", ""], ["node_4", "", ""]], sub_agents=[node_5])' in code
    assert 'parents=[["node_10", "T", False]]' in code
    assert py_compile(code)[0] == 0


def test_ungated_workflow_unchanged():
    assert '_Gate(' not in ADKGenerator.emitAdk(mcp_analyzed())
