"""Port of backend/tests/Unit/MafParityTest.php: MAF gets what ADK has -- MCP headers, code nodes, decision
routing, run events, a listening package.

The two analyses are AdkCodeNodeTest::codeAnalyzed() / ::wf64Analyzed() (PHP shares them between the ADK,
MAF and NOOA tests). testANodeNamedLikeAModuleDoesNotShadowIt runs MAF here; its NOOA half belongs with the
NOOA tests.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.maf_generator import MAFGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer

REPO = Path(__file__).resolve().parents[3]
RUNNER_PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python'


def code_analyzed(src: str = "def run(input, call_tool):\n    return {'output': {'got': input}}\n") -> dict:
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '2', 'type': 'code', 'config': {'type': 'code', 'name': 'C', 'code': src,
                                               'exits': ['next'], 'mcp_servers': ['Outlook'], 'timeout_s': 30}},
        {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}
    a = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a.update({
        'workflow': {'id': 8, 'name': 'code'}, 'generated_at': '2026-01-01 00:00:00 UTC',
        'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {'http://localhost:8770': 'outlook'},
        'startPrompt': 'GO', 'startDocuments': [], 'agents': {}, 'playbooks': {},
    })
    a['code'] = {'2': CodeNodeEmit.nodeData(graph['nodes'][1], graph['edges'],
                                            {'outlook': 'http://localhost:8770'}, ['1', '2', '3'])}
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
    a = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a.update({
        'workflow': {'id': 64, 'name': 'wf64'}, 'generated_at': '2026-01-01 00:00:00 UTC',
        'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {},
        'startPrompt': 'GO', 'startDocuments': [], 'playbooks': {},
        'agents': {'2': {'name': 'D', 'systemPrompt': 'Route the email.', 'provider': 'claude', 'model': 'm',
                         'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '',
                         'output_schema_id': None, 'documents': []}},
    })
    by_id = {n['id']: n for n in graph['nodes']}
    ids = ['1', '10', '2', '3', '4', '5']
    a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {}, ids) for cid in ('10', '3', '4')}
    return a


def _py_compile(code: str) -> tuple[int, str]:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(code)
    try:
        p = subprocess.run([sys.executable, '-m', 'py_compile', f.name], capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr
    finally:
        os.unlink(f.name)


def test_mcp_client_with_headers_for_a_code_only_workflow():
    code = MAFGenerator.emitMaf(code_analyzed())
    assert 'MCP_SERVER_SLUGS = {\n    "http://localhost:8770": "outlook"' in code
    assert 'var = f"MCP_HEADERS_{slug.upper()}"' in code
    assert 'for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):' in code
    assert _py_compile(code)[0] == 0


@pytest.mark.skipif(not os.path.isfile(RUNNER_PY), reason='runner venv missing')
def test_a_node_named_like_a_module_does_not_shadow_it(tmp_path):
    """Review I2: a node named like a stdlib module ("time") must not shadow it in workflow.py."""
    a = wf64_analyzed()
    a['agents']['2']['name'] = 'time'   # the dispatcher's module would be agents/time.py
    a['package'] = True
    workflow, common, nodes = MAFGenerator.packageFiles(a)
    (tmp_path / 'agents').mkdir()
    (tmp_path / 'workflow.py').write_text(workflow, encoding='utf-8')
    (tmp_path / 'common.py').write_text(common + '\n' + CompiledRuntimeEmit.packageCommonBlock(), encoding='utf-8')
    for f in nodes:
        (tmp_path / f['path']).write_text(f['code'], encoding='utf-8')
    (tmp_path / 'code_harness.py').write_text(
        (REPO / 'frontend/assets/py/code_node_harness.py').read_text(encoding='utf-8'), encoding='utf-8')
    p = subprocess.run([RUNNER_PY, '-W', 'ignore', '-c', 'import workflow; print(workflow.time.sleep.__name__)'],
                       cwd=tmp_path, capture_output=True, text=True, env={**os.environ, 'ANTHROPIC_API_KEY': 'x'})
    assert p.returncode == 0, p.stdout + p.stderr
    assert p.stdout.strip().splitlines()[-1] == 'sleep'
