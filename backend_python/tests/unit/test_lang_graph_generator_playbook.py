"""Port of backend/tests/Unit/LangGraphGeneratorPlaybookTest.php (Phase 6, Task 2).

LangGraph compiler: playbook nodes and dispatcher agents.

- A playbook node compiles to a PLAYBOOKS entry whose #Actions are bound
  against the user's MCP registry at generation time (mirrors the browser
  runner's PlaybookAnalyzer binding) and runs through the emitted playbook
  runtime (native verbs, gates, write policy, transcript output).
- A dispatcher agent's fan-out is a MENU: the agent gets route_to over its
  children and the graph wires a conditional edge, so exactly one child runs.
"""
from __future__ import annotations

import os
import subprocess
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator

PLAYBOOK = ("Title: Time Off & Leave\n\n"
            "Trigger: Requester asks for PTO.\n\n"
            "Instructions:\n"
            "1. #Get PTO Balance for the requester.\n"
            "2. #Request Approval from the manager.\n"
            "3. On approval: #Submit Time Off with the dates. #Frobnicate the record.\n"
            "4. #Leave Internal Note then #Resolve Request.\n\n"
            "Tools used: Workday\n\n"
            "Actions used: #Get PTO Balance; #Request Approval; #Submit Time Off; #Frobnicate; "
            "#Leave Internal Note; #Resolve Request\n")

_WORKDAY_PTO = {
    'tool_name': 'get_pto_balance', 'description': 'Get balances',
    'input_schema': '{"type":"object","properties":{"email":{"type":"string"}},"required":["email"]}',
    'server_name': 'Workday', 'server_url': 'http://localhost/mockstack/index.php/workday',
    'server_user_id': '3', 'enabled': 1,
}
_WORKDAY_SUBMIT = {
    'tool_name': 'submit_time_off', 'description': 'Submit',
    'input_schema': '{"type":"object","properties":{"start":{"type":"string"}}}',
    'server_name': 'Workday', 'server_url': 'http://localhost/mockstack/index.php/workday',
    'server_user_id': '3', 'enabled': 1,
}
_GLOBAL_NEWS = {
    'tool_name': 'get_news', 'description': 'News', 'input_schema': '{}',
    'server_name': 'Global News', 'server_url': 'http://localhost/news/',
    'server_user_id': None, 'enabled': 1,
}
_LLM_ROWS = [
    {'provider_key': 'claude', 'model': 'claude-sonnet-4-6'},
    {'provider_key': 'deepseek', 'model': 'deepseek-v4-flash'},
]


class _FakeDb:
    def __init__(self, mcp_rows, llm_rows):
        self._mcp_rows = mcp_rows
        self._llm_rows = llm_rows

    def fetch_all(self, sql, params=None):
        params = params or {}
        if 'system_llm_settings' in sql:
            return list(self._llm_rows)
        if 'mcp_server_tools' in sql:
            uid = params.get('uid')
            out = []
            for row in self._mcp_rows:
                if row.get('enabled', 1) != 1:
                    continue
                row_uid = row.get('server_user_id')
                if row_uid is None or (uid is not None and str(row_uid) == str(uid)):
                    out.append(row)
            return out
        return []


class _FakeWorkflowRepo:
    def __init__(self, workflow: Workflow):
        self._wf = workflow

    def findById(self, id_, include_graph=False):
        return self._wf if id_ == self._wf.getId() else None


class _FakeGraphRepo:
    def __init__(self, graph: dict):
        self._graph = graph

    def getGraph(self, id_):
        return self._graph


class _FakeAgentRepo:
    def findById(self, id_):
        return None


def _agent(name: str, agent_type: str = 'standard') -> dict:
    return {
        'type': 'agent-template', 'agent_name': name, 'agent_type': agent_type,
        'instructions': f'You are {name}.', 'agent_provider': 'claude', 'tools': [],
    }


def playbook_graph() -> dict:
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': 'playbook', 'config': {
                'type': 'playbook', 'name': 'Playbook HR', 'playbook': PLAYBOOK,
                'agent_provider': 'deepseek', 'model': 'deepseek-v4-flash', 'writes_enabled': True,
            }},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }


def dispatcher_graph() -> dict:
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'node_type': '', 'config': _agent('techBuddy', 'dispatcher')},
            {'id': '3', 'node_type': '', 'config': _agent('IT claims')},
            {'id': '4', 'node_type': '', 'config': _agent('Human resources')},
            {'id': '5', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
            {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'},
        ],
    }


def _generate(graph: dict, user_id: str | None = '3') -> str:
    wf = Workflow({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'})
    db = _FakeDb([_WORKDAY_PTO, _WORKDAY_SUBMIT, _GLOBAL_NEWS], _LLM_ROWS)
    gen = LangGraphGenerator(db, _FakeWorkflowRepo(wf), _FakeGraphRepo(graph), _FakeAgentRepo())
    return gen.generate(44, user_id)['code']


def test_playbook_node_binds_actions_against_user_registry():
    """PHP testPlaybookNodeBindsActionsAgainstUserRegistry (lines 106-129)."""
    code = _generate(playbook_graph())
    assert 'PLAYBOOKS = {' in code
    assert '"2": "playbook"' in code, 'NODE_TYPES carries the playbook type'
    assert '"workday__get_pto_balance"' in code
    assert '"workday__submit_time_off"' in code
    assert '"action_name": "#Get PTO Balance"' in code
    assert '"unbound__frobnicate"' in code
    assert '"#Request Approval"' not in code
    assert '"provider": "deepseek"' in code
    assert '"model": "deepseek-v4-flash"' in code
    assert '"writes_enabled": True' in code
    assert '"display": "Playbook HR"' in code
    assert '"title": "Time Off & Leave"' in code
    assert '1. #Get PTO Balance for the requester.' in code
    assert 'http://localhost/mockstack/index.php/workday' in code


def test_playbook_runtime_emitted():
    """PHP testPlaybookRuntimeEmitted (lines 131-141)."""
    code = _generate(playbook_graph())
    for needle in ['def build_playbook_tools', 'def render_playbook_transcript', 'def _playbook_gate',
                   'elif ntype == "playbook":', 'PLAYBOOK_SYSTEM_PROMPT', 'writes disabled by policy',
                   '"resolve_request"', '"request_approval"', '"prompt_handoff"']:
        assert needle in code, f"missing: {needle}"
    assert 'for nid, ad in {**AGENTS, **PLAYBOOKS}.items()' in code


def test_playbook_runtime_omitted_without_playbook_nodes():
    """PHP testPlaybookRuntimeOmittedWithoutPlaybookNodes (lines 143-148)."""
    code = _generate(dispatcher_graph())
    assert 'PLAYBOOKS = {}' in code
    assert 'def build_playbook_tools' not in code


def test_dispatcher_agent_gets_route_menu_and_conditional_edge():
    """PHP testDispatcherAgentGetsRouteMenuAndConditionalEdge (lines 150-162)."""
    code = _generate(dispatcher_graph())
    assert '"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]' in code
    assert '## Routing' in code, 'dispatcher prompt carries the routing block'
    assert '  - IT claims' in code
    assert '## Routed request' in code, 'children carry the routed-to fragment'
    assert code.count('## Routed request') == 2, 'both menu children are routed-to'
    assert 'The dispatcher "techBuddy" reviewed this request' in code
    assert 'add_conditional_edges' in code
    assert '"route_to"' in code
    assert 'routes: Annotated[dict[str, str], _merge]' in code


def test_non_dispatcher_agent_has_no_dispatch_entry():
    """PHP testNonDispatcherAgentHasNoDispatchEntry (lines 164-168)."""
    code = _generate(dispatcher_graph())
    assert code.count('"dispatch": [') == 1, 'only the dispatcher carries a menu'


def test_emitted_script_is_valid_python():
    """PHP testEmittedScriptIsValidPython (lines 170-180)."""
    for graph in (playbook_graph(), dispatcher_graph()):
        code = _generate(graph)
        fd, path = tempfile.mkstemp(suffix='.py')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                fh.write(code)
            r = subprocess.run(['python3', '-m', 'py_compile', path], capture_output=True, text=True)
            assert r.returncode == 0, r.stdout + r.stderr
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
