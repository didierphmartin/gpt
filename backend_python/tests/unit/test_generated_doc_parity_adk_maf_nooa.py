"""Port of the ADK/MAF/NOOA cases of backend/tests/Unit/GeneratedDocParityTest.php (the LangGraph cases
live in test_generated_doc_parity_langgraph.py).

Every compile target documents the generated script the same way, for any workflow shape: PROVENANCE,
GRAPH NODES, GRAPH EDGES, EXECUTION ORDER, DATA FLOW, TO RUN in the module docstring, and a uniform
comment block before each node definition. Also pins the analyzer fix that made editor-saved agent nodes
(DB node_type '') vanish from ADK/MAF/NOOA. The database is an in-memory SQLite with the PHP test's rows.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

import pytest

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.maf_generator import MAFGenerator
from app.agent_team.services.nooa_generator import NOOAGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from tests.unit import lg_support as S
from tests.unit.test_generated_doc_parity_langgraph import _CHECKER, _graph

TARGETS = {'ADK': ADKGenerator, 'MAF': MAFGenerator, 'NOOA': NOOAGenerator}


def _db():
    return S.db(*S.MCP_DDL, S.LLM_DDL,
                "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
                """INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{"type":"object","properties":{"email":{"type":"string"}}}')""",
                "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")


_ALL: dict = {}


def _generate_all() -> dict:
    """target -> generated code (the single file)."""
    if not _ALL:
        wf = {'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}
        for label, cls in TARGETS.items():
            _ALL[label] = cls(_db(), S.WfRepo(wf), S.GraphRepo(_graph()), S.AgentRepo(None)).generate(44, '3')['code']
    return _ALL


def test_analyzer_reads_empty_node_type_from_config():
    assert WorkflowGraphAnalyzer.typeOf({'node_type': '', 'config': {'type': 'agent-template'}}) == 'agent-template'
    assert WorkflowGraphAnalyzer.typeOf({'node_type': 'playbook', 'config': {'type': 'agent'}}) == 'playbook'
    assert WorkflowGraphAnalyzer.typeOf({'config': {}}) == 'agent'


@pytest.mark.parametrize('target', list(TARGETS))
def test_every_target_carries_the_same_documentation_sections(target):
    code = _generate_all()[target]
    doc = code[:code.index('"""', 3)]
    for needle in ['PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
                   'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
                   'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
                   'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
                   'layer 2:  IT claims  ||  Human resources',
                   'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF']:
        assert needle in doc, f'{target}: docstring lacks {needle}'
    assert re.search(r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor', doc), target
    # Uniform per-node comment block before every agent definition.
    assert '# ---- node 2: techBuddy (agent-template) ' in code, target
    assert '#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default' in code, target
    assert '#   dispatcher     : routes to one of: IT claims | Human resources' in code, target
    assert '#   children       : IT claims (3) | Human resources (4)' in code, target
    assert '#   parents        : techBuddy (2)' in code, target


@pytest.mark.parametrize('target', list(TARGETS))
def test_agents_with_empty_db_node_type_compile_on_every_target(target):
    assert 'You are Human resources.' in _generate_all()[target], f'{target} lost the agent node'


@pytest.mark.parametrize('target', list(TARGETS))
def test_playbook_and_dispatcher_support_is_stated_honestly(target):
    code = _generate_all()[target]
    assert 'NOT RUN BY THIS TARGET' not in code, target
    assert 'menu NOT honoured by this target' not in code, target
    assert 'dispatcher menu not honoured by this target' not in code, target
    assert 'PLAYBOOK_GATE_MODE' in code, f'{target}: the playbook gates must be reachable'
    assert 'DEEPSEEK_API_KEY' in code, f"{target}: the playbook node's provider key belongs in the run notes"
    # The three ported targets carry the shared interpreter verbatim.
    assert 'async def run_playbook_node(' in code, target
    assert 'PLAYBOOKS = {' in code, target
    assert 'pip install langchain-core langgraph' in code, f"{target}: the interpreter's requirement must be stated"


def test_every_target_routes_the_dispatcher_menu():
    all_ = _generate_all()
    # ADK: the menu is nested under the dispatcher, so the children are NOT layer members -- a
    # ParallelAgent over them would be the fan-out again.
    adk = all_['ADK']
    assert '_DispatcherAgent(' in adk
    assert 'IT claims' in adk
    assert 'ParallelAgent(name="layer_2"' not in adk
    # MAF: the edges stay drawn; the choice travels in the message.
    maf = all_['MAF']
    assert 'DispatcherNodeExecutor(' in maf
    assert 'route_to' in maf
    # NOOA: the dispatcher's choice is the only child its routes let run (GRAPH driver).
    nooa = all_['NOOA']
    assert 'run_dispatcher(' in nooa
    assert 'routes[nid] = {chosen} if chosen else set()' in nooa


@pytest.mark.parametrize('target', list(TARGETS))
def test_no_target_references_an_undefined_global(target):
    allowed = ['SkillRuntime', '_CURRENT_NODE', '_SINK', '__file__']
    d = tempfile.mkdtemp(prefix='chk')
    with open(os.path.join(d, 'chk.py'), 'w') as f:
        f.write(_CHECKER)
    with open(os.path.join(d, 'gen.py'), 'w', encoding='utf-8') as f:
        f.write(_generate_all()[target])
    r = subprocess.run([S.python3(), os.path.join(d, 'chk.py'), os.path.join(d, 'gen.py')], capture_output=True, text=True)
    assert r.returncode == 0, f'{target}: checker failed: ' + r.stdout + r.stderr
    names = [n for n in (r.stdout + r.stderr).split() if n not in allowed]
    assert names == [], f'{target} references globals it never defines: ' + ', '.join(names)


@pytest.mark.parametrize('target', list(TARGETS))
def test_every_target_still_emits_valid_python(target):
    S.assert_compiles(_generate_all()[target], target)
