"""Port of backend/tests/Unit/LangGraphGeneratorPlaybookTest.php.

LangGraph compiler: playbook nodes and dispatcher agents.
- A playbook node compiles to a PLAYBOOKS entry whose #Actions are bound against the user's MCP registry
  at generation time and runs through the emitted playbook runtime.
- A dispatcher agent's fan-out is a MENU: route_to over its children and a conditional edge.

The two PHP tests that also compile with ADK, MAF and NOOA run their other-target half over
OTHER_TARGETS: the targets whose Python port is PHP-faithful (they refuse what PHP refuses).
"""
from __future__ import annotations

import re
import subprocess
import tempfile
import os

import pytest

from tests.unit import lg_support as S

PLAYBOOK = """Title: Time Off & Leave

Trigger: Requester asks for PTO.

Instructions:
1. #Get PTO Balance for the requester.
2. #Request Approval from the manager.
3. On approval: #Submit Time Off with the dates. #Frobnicate the record.
4. #Leave Internal Note then #Resolve Request.

Tools used: Workday

Actions used: #Get PTO Balance; #Request Approval; #Submit Time Off; #Frobnicate; #Leave Internal Note; #Resolve Request"""

_STATEMENTS = (*S.MCP_DDL, S.LLM_DDL,
               "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
               "INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)",
               """INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{"type":"object","properties":{"email":{"type":"string"}},"required":["email"]}')""",
               """INSERT INTO mcp_server_tools VALUES (2, 85, 'submit_time_off', 'Submit', '{"type":"object","properties":{"start":{"type":"string"}}}')""",
               "INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')",
               "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
               "INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-flash', 1)")


def _db():
    return S.db(*_STATEMENTS)


def _robot_db():
    """The test db plus a robot (users.kind = 'service') owning the published playbook "test", and a draft of user 3."""
    database = S.db(*_STATEMENTS,
                    'CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL, '
                    'title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT, published_by INTEGER NULL, '
                    'published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER NULL, UNIQUE (user_id, pkey))',
                    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)',
                    "INSERT INTO users (id, kind) VALUES (3, 'user'), (7, 'service')")
    database.execute('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)', [7, 'test', 'Time Off & Leave', PLAYBOOK])
    database.execute('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)',
                     [3, 'draft', 'Draft only', 'Title: Draft only\n\nInstructions:\n1. #Resolve Request.\n'])
    return database


OTHER_TARGETS = ('adk', 'maf', 'nooa')


def _target_class(target: str):
    if target == 'adk':
        from app.agent_team.services.adk_generator import ADKGenerator
        return ADKGenerator
    if target == 'maf':
        from app.agent_team.services.maf_generator import MAFGenerator
        return MAFGenerator
    from app.agent_team.services.nooa_generator import NOOAGenerator
    return NOOAGenerator


def _generate(graph: dict, userId='3', database=None, options: dict | None = None, target: str = 'langgraph') -> str:
    if target != 'langgraph':
        gen = _target_class(target)(database or _db(), S.WfRepo({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}),
                                    S.GraphRepo(graph), S.AgentRepo())
        return gen.generate(44, userId)['code']
    res = S.generator(database or _db(), graph).generate(44, userId, options or {})
    if 'code' in res:
        return res['code']
    return '\n'.join(f"### {f['path']}\n" + f['code'] for f in res['files'])


def _from_input_graph() -> dict:
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': '{"playbook":"test"}'}},
            {'id': '2', 'node_type': 'playbook', 'config': {
                'type': 'playbook', 'name': 'Run job playbook', 'playbook_source': 'input',
                'playbook_input_field': 'playbook', 'exits': ['done', 'failed'],
                'agent_provider': 'deepseek', 'model': 'deepseek-flash', 'writes_enabled': True}},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
            {'id': '4', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3', 'from_port': 'output_1'},
                  {'from': '2', 'to': '4', 'from_port': 'output_2'}],
    }


def _playbook_graph() -> dict:
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': 'playbook', 'config': {
                'type': 'playbook', 'name': 'Playbook HR', 'playbook': PLAYBOOK,
                'agent_provider': 'deepseek', 'model': 'deepseek-flash', 'writes_enabled': True}},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }


def _fixed_exits_graph(failedWired: bool) -> dict:
    g = _playbook_graph()
    g['nodes'][1]['config']['exits'] = ['done', 'failed']
    g['edges'][1]['from_port'] = 'output_1'
    if failedWired:
        g['nodes'].append({'id': '4', 'node_type': 'output', 'config': {'type': 'output'}})
        g['edges'].append({'from': '2', 'to': '4', 'from_port': 'output_2'})
    return g


def _dispatcher_graph() -> dict:
    def agent(name, typ='standard'):
        return {'type': 'agent-template', 'agent_name': name, 'agent_type': typ,
                'instructions': f'You are {name}.', 'agent_provider': 'claude', 'tools': []}
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'node_type': '', 'config': agent('techBuddy', 'dispatcher')},
            {'id': '3', 'node_type': '', 'config': agent('IT claims')},
            {'id': '4', 'node_type': '', 'config': agent('Human resources')},
            {'id': '5', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
                  {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'}],
    }


def _py_compiles(code: str) -> tuple:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(code)
    try:
        r = subprocess.run(['python3', '-m', 'py_compile', f.name], capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr
    finally:
        os.unlink(f.name)


def test_from_input_bakes_published_playbooks():
    code = _generate(_from_input_graph(), '3', _robot_db())
    assert 'PUBLISHED_PLAYBOOKS = {' in code
    assert '    "test": {' in code
    assert '"draft"' not in code, "only the robot's published copies are baked"
    assert '"workday__get_pto_balance"' in code
    assert 'http://localhost/mockstack/index.php/workday' in code
    assert '"source": "input",' in code
    assert '"input_field": "playbook",' in code
    assert '"published": PUBLISHED_PLAYBOOKS,' in code
    assert '"exits": ["done","failed"],' in code
    assert '"exit_targets": {"done":["3"],"failed":["4"]},' in code
    assert code.index('PUBLISHED_PLAYBOOKS = {') < code.index('PLAYBOOKS = {\n    # ')
    assert 'loop_mode=mode != "once", unattended=mode == "watch")' in code
    assert '            graph.unattended = unattended' in code
    assert 'os.environ["PLAYBOOK_GATE_MODE"] =' not in code
    rc, out = _py_compiles(code)
    assert rc == 0, out


def test_unbakeable_published_playbook_is_a_warning():
    database = _robot_db()
    database.execute('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)', [7, 'broken', 'Broken', ''])
    code = _generate(_from_input_graph(), '3', database)
    assert re.search(r'^# WARNING: published playbook "broken" not baked: [^\n]+$', code, re.M)
    assert '    "test": {' in code
    rc, out = _py_compiles(code)
    assert rc == 0, out


def test_modular_listen_runs_are_unattended_per_run():
    code = _generate(_from_input_graph(), '3', _robot_db(), {'modular': True})
    assert 'run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True, unattended=True)' in code
    assert 'loop_mode=mode != "once", unattended=mode == "watch")' in code
    assert 'os.environ["PLAYBOOK_GATE_MODE"] =' not in code


def test_wired_failed_exit_refused_on_other_targets():
    for target in OTHER_TARGETS:
        with pytest.raises(RuntimeError) as e:
            _generate(_fixed_exits_graph(True), '3', None, None, target)
        assert str(e.value) == 'Playbook node "Playbook HR": the "failed" exit is supported by the LangGraph target only.', target
        # Only "done" wired: compiles as before.
        assert _generate(_fixed_exits_graph(False), '3', None, None, target) != '', target
    # LangGraph routes it.
    assert '"exit_targets": {"done":["3"],"failed":["4"]},' in _generate(_fixed_exits_graph(True))


def test_from_input_without_robot_bakes_an_empty_dict():
    database = _robot_db()
    database.execute("DELETE FROM users WHERE kind = 'service'")
    code = _generate(_from_input_graph(), '3', database)
    assert 'PUBLISHED_PLAYBOOKS = {}' in code
    rc, out = _py_compiles(code)
    assert rc == 0, out


def test_published_playbooks_omitted_without_from_input_nodes():
    code = _generate(_playbook_graph())
    assert 'PUBLISHED_PLAYBOOKS = ' not in code
    assert '"exit_targets": {' not in code


def test_from_input_modular_module_bakes_published_playbooks():
    code = _generate(_from_input_graph(), '3', _robot_db(), {'modular': True})
    assert re.search(r'PUBLISHED_PLAYBOOKS = \{\n    "test": \{.*?\nNODE = \{.*?"published": PUBLISHED_PLAYBOOKS,', code, re.S)


def test_from_input_refused_on_a2_a():
    with pytest.raises(RuntimeError, match='A2A'):
        _generate(_from_input_graph(), '3', _robot_db(), {'a2a': True})


def test_from_input_refused_on_other_targets():
    for target in OTHER_TARGETS:
        with pytest.raises(RuntimeError) as e:
            _generate(_from_input_graph(), '3', _robot_db(), None, target)
        assert str(e.value) == 'Playbook node "Run job playbook": "from input" is supported by the LangGraph target only.', target


def test_playbook_node_binds_actions_against_user_registry():
    code = _generate(_playbook_graph())
    assert 'PLAYBOOKS = {' in code
    assert '"2": "playbook"' in code, 'NODE_TYPES carries the playbook type'
    assert '"workday__get_pto_balance"' in code
    assert '"workday__submit_time_off"' in code
    assert '"action_name": "#Get PTO Balance"' in code
    assert '"unbound__frobnicate"' in code
    assert '"#Request Approval"' not in code
    assert '"provider": "deepseek"' in code
    assert '"model": "deepseek-flash"' in code
    assert 'if model.startswith(("deepseek-v4", "deepseek-flash")):' in code
    assert '"writes_enabled": True' in code
    assert '"display": "Playbook HR"' in code
    assert '"title": "Time Off & Leave"' in code
    assert '1. #Get PTO Balance for the requester.' in code
    assert 'http://localhost/mockstack/index.php/workday' in code


def test_playbook_runtime_emitted():
    code = _generate(_playbook_graph())
    for needle in ['class PlaybookToolset:', '    def transcript(self, title: str, final: str) -> str:', '    def gate(self',
                   'case NodeKind.PLAYBOOK:', 'PLAYBOOK_SYSTEM_PROMPT', 'writes disabled by policy',
                   '"resolve_request"', '"request_approval"', '"prompt_handoff"']:
        assert needle in code, f'missing: {needle}'
    assert 'NODES = {nid: make_node(cfg) for nid, cfg in {**AGENTS, **PLAYBOOKS, **CODE_NODES}.items()}' in code


def test_playbook_runtime_omitted_without_playbook_nodes():
    code = _generate(_dispatcher_graph())
    assert 'PLAYBOOKS = {}' in code
    assert 'class PlaybookToolset:' not in code


def test_dispatcher_agent_gets_route_menu_and_conditional_edge():
    code = _generate(_dispatcher_graph())
    assert ('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, '
            '{"id": "4", "name": "Human resources", "description": ""}]') in code
    assert '## Routing' in code, 'dispatcher prompt carries the routing block'
    assert '  - IT claims' in code
    assert '## Routed request' in code, 'children carry the routed-to fragment'
    assert code.count('## Routed request') == 2, 'both menu children are routed-to'
    assert 'The dispatcher "techBuddy" reviewed this request' in code
    assert 'add_conditional_edges' in code
    assert '"route_to"' in code
    assert 'routes: Annotated[dict[str, str], _merge]' in code


def test_non_dispatcher_agent_has_no_dispatch_entry():
    assert _generate(_dispatcher_graph()).count('"dispatch": [{') == 1, 'only the dispatcher carries a menu'


def test_emitted_script_is_valid_python():
    for graph in (_playbook_graph(), _dispatcher_graph()):
        rc, out = _py_compiles(_generate(graph))
        assert rc == 0, out
