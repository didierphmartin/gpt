"""Port of the LangGraph cases of backend/tests/Unit/GeneratedDocParityTest.php (the ADK/MAF/NOOA cases
live in test_generated_doc_parity_adk_maf_nooa.py).

Every compile target documents the generated script the same way: PROVENANCE, GRAPH NODES, GRAPH EDGES,
EXECUTION ORDER, DATA FLOW, TO RUN in the module docstring, and a uniform comment block before each node
definition. Also pins the analyzer fix that made editor-saved agent nodes (DB node_type '') visible.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from tests.unit import lg_support as S


def _graph() -> dict:
    """The Dispatcher-demo shape, with the '' node_type the editor really saves."""
    def agent(name, typ='standard'):
        return {'type': 'agent-template', 'agent_name': name, 'agent_type': typ,
                'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
                'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': '', 'config': agent('techBuddy', 'dispatcher')},
            {'id': '3', 'node_type': '', 'config': agent('IT claims')},
            {'id': '4', 'node_type': '', 'config': agent('Human resources')},
            {'id': '5', 'node_type': 'playbook', 'config': {'type': 'playbook', 'name': 'Playbook HR', 'playbook': S.PLAYBOOK,
                                                              'agent_provider': 'deepseek', 'model': 'deepseek-flash', 'writes_enabled': True}},
            {'id': '6', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
                  {'from': '3', 'to': '6'}, {'from': '4', 'to': '5'}, {'from': '5', 'to': '6'}],
    }


def _code() -> str:
    database = S.db(*S.MCP_DDL, 'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
                    "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
                    """INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{"type":"object","properties":{"email":{"type":"string"}}}')""",
                    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")
    return S.generator(database, _graph()).generate(44, '3')['code']


def test_analyzer_reads_empty_node_type_from_config():
    assert WorkflowGraphAnalyzer.typeOf({'node_type': '', 'config': {'type': 'agent-template'}}) == 'agent-template'
    assert WorkflowGraphAnalyzer.typeOf({'node_type': 'playbook', 'config': {'type': 'agent'}}) == 'playbook'
    assert WorkflowGraphAnalyzer.typeOf({'config': {}}) == 'agent'


def test_every_target_carries_the_same_documentation_sections():
    code = _code()
    doc = code[:code.index('"""', 3)]
    for needle in ['PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
                   'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
                   'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
                   'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
                   'layer 2:  IT claims  ||  Human resources',
                   'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF']:
        assert needle in doc, f'LangGraph: docstring lacks {needle}'
    assert re.search(r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor', doc)
    assert '# ---- node 2: techBuddy (agent) ' in code
    assert '#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default' in code
    assert '#   dispatcher     : routes to one of: IT claims | Human resources' in code
    assert '#   children       : IT claims (3) | Human resources (4)' in code
    assert '#   parents        : techBuddy (2)' in code


def test_agents_with_empty_db_node_type_compile_on_every_target():
    assert 'You are Human resources.' in _code(), 'LangGraph lost the agent node'


def test_playbook_and_dispatcher_support_is_stated_honestly():
    lg = _code()
    assert 'playbook "Time Off", 1 bound / 0 unbound action(s), writes ON' in lg
    assert '(dispatcher: only the chosen one runs)' in lg
    assert 'NOT RUN BY THIS TARGET' not in lg
    assert 'menu NOT honoured by this target' not in lg
    assert 'dispatcher menu not honoured by this target' not in lg
    assert 'PLAYBOOK_GATE_MODE' in lg, 'the playbook gates must be reachable'
    assert 'DEEPSEEK_API_KEY' in lg, "the playbook node's provider key belongs in the run notes"


def test_every_target_routes_the_dispatcher_menu():
    assert 'add_conditional_edges' in _code()


_CHECKER = '''import ast, builtins, sys
tree = ast.parse(open(sys.argv[1]).read())
known = set(dir(builtins))
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        known.add(node.name)
    elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
        known.add(node.id)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        for a in node.names:
            known.add((a.asname or a.name).split(".")[0])
    elif isinstance(node, ast.ExceptHandler) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.arg):
        known.add(node.arg)
    elif isinstance(node, ast.Global):
        known.update(node.names)
    elif isinstance(node, ast.MatchAs) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.MatchStar) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.MatchMapping) and node.rest:
        known.add(node.rest)
used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
print(" ".join(sorted(used - known)))
'''


def test_no_target_references_an_undefined_global():
    allowed = ['SkillRuntime', '_CURRENT_NODE', '_SINK', '__file__']
    d = tempfile.mkdtemp(prefix='chk')
    with open(f'{d}/chk.py', 'w') as f:
        f.write(_CHECKER)
    with open(f'{d}/gen.py', 'w', encoding='utf-8') as f:
        f.write(_code())
    r = subprocess.run(['python3', f'{d}/chk.py', f'{d}/gen.py'], capture_output=True, text=True)
    assert r.returncode == 0, 'LangGraph: checker failed: ' + r.stdout + r.stderr
    names = [n for n in (r.stdout + r.stderr).split() if n not in allowed]
    assert names == [], 'LangGraph references globals it never defines: ' + ', '.join(names)


def test_every_target_still_emits_valid_python():
    S.assert_compiles(_code(), 'LangGraph')
