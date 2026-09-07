"""Port of backend/tests/Unit/LangGraphA2AGeneratorTest.php (Phase 6, Task 2).

LangGraph compiler, A2A mode: one self-contained A2A agent server per
agent/playbook node under agents/, one orchestrator.py driving them.

The PHP oracle reaches `analyzeForEmit`/`emitA2AAgentFile`/`emitA2AOrchestrator`
via ReflectionMethod (they are `private` in PHP). Python has no such access
control, so this port calls the `_camelCase` methods directly.
"""
from __future__ import annotations

import os
import subprocess
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator

PLAYBOOK = ("Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n"
            "1. #Get PTO Balance for the requester.\n"
            "2. #Request Approval from the manager then #Resolve Request.\n\n"
            "Tools used: Workday\n\n"
            "Actions used: #Get PTO Balance; #Request Approval; #Resolve Request\n")

_WORKDAY_TOOL = {
    'tool_name': 'get_pto_balance', 'description': 'Get balances',
    'input_schema': '{"type":"object","properties":{"email":{"type":"string"}}}',
    'server_name': 'Workday', 'server_url': 'http://localhost/mockstack/index.php/workday',
    'server_user_id': '3', 'enabled': 1,
}
_NEWS_TOOL = {
    'tool_name': 'get_news', 'description': 'News', 'input_schema': '{}',
    'server_name': 'News', 'server_url': 'http://localhost/news/',
    'server_user_id': None, 'enabled': 1,
}


class _FakeDb:
    """Mirrors the PHP test's SQLite fixture (mcp_servers/mcp_server_tools/
    system_llm_settings) via fetch_all() -- see WorkflowGraphAnalyzerAnalyzeTest's
    FakeDb docstring for why fetch_all (not prepare/execute) is the right shape
    for the backend_python Db wrapper convention."""

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


def _agent(name: str, agent_type: str = 'standard', tools=None, extra=None) -> dict:
    tools = tools if tools is not None else []
    extra = extra if extra is not None else {}
    base = {
        'type': 'agent-template', 'agent_name': name, 'agent_type': agent_type,
        'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
        'tools': tools, 'settings': {'temperature': 0.7, 'max_tokens': 4096},
    }
    return {**extra, **base}


def graph() -> dict:
    """Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output."""
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'I want to take some vacations'}},
            {'id': '2', 'node_type': '', 'config': _agent('techBuddy', 'dispatcher')},
            # Skill-bound (html): run_skill_script must be baked into the tool
            # catalog and "skills" onto NODE (see test_agent_file_is_a_self_contained_a2a_server).
            {'id': '3', 'node_type': '', 'config': _agent('IT claims', 'standard', ['mcp_get_news', 'run_skill_script'],
                                                            {'bound_skill': {'dir_name': 'html'}})},
            {'id': '4', 'node_type': '', 'config': _agent('Human resources')},
            {'id': '5', 'node_type': 'playbook', 'config': {'type': 'playbook', 'name': 'Playbook HR',
                'playbook': PLAYBOOK, 'agent_provider': 'deepseek', 'model': 'deepseek-v4-flash', 'writes_enabled': True}},
            {'id': '6', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
            {'from': '3', 'to': '6'}, {'from': '4', 'to': '5'}, {'from': '5', 'to': '6'},
        ],
    }


def generator() -> LangGraphGenerator:
    wf = Workflow({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'})
    db = _FakeDb([_WORKDAY_TOOL, _NEWS_TOOL], [{'provider_key': 'claude', 'model': 'claude-sonnet-4-5'}])
    return LangGraphGenerator(db, _FakeWorkflowRepo(wf), _FakeGraphRepo(graph()), _FakeAgentRepo())


def facts() -> dict:
    gen = generator()
    return gen._analyzeForEmit(44, '3')


def _agent_file(nid: str) -> str:
    gen = generator()
    f = facts()
    return gen._emitA2AAgentFile(f, LangGraphGenerator.a2aLayout(f), nid)


def _orchestrator() -> str:
    gen = generator()
    f = facts()
    return gen._emitA2AOrchestrator(f, LangGraphGenerator.a2aLayout(f))


def _assert_compiles(code: str, label: str) -> None:
    fd, path = tempfile.mkstemp(suffix='.py')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(code)
        r = subprocess.run(['python3', '-m', 'py_compile', path], capture_output=True, text=True)
        assert r.returncode == 0, f"{label}: {r.stdout}{r.stderr}"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def test_layout_names_one_agent_file_per_agent_or_playbook_node():
    """PHP testLayoutNamesOneAgentFilePerAgentOrPlaybookNode (lines 84-99)."""
    layout = LangGraphGenerator.a2aLayout(facts())
    assert layout['root'] == 'dispatcher_demo_a2a'
    assert list(layout['agents'].keys()) == ['2', '3', '4', '5'], 'ORDER order, no start/output'
    assert layout['agents']['2']['file'] == 'agents/2_techbuddy.py'
    assert layout['agents']['4']['file'] == 'agents/4_human-resources.py'
    assert layout['agents']['5']['file'] == 'agents/5_playbook-hr.py'
    assert [a['port'] for a in layout['agents'].values()] == [8701, 8702, 8703, 8704]
    assert layout['agents']['2']['kind'] == 'dispatcher'
    assert layout['agents']['3']['kind'] == 'agent'
    assert layout['agents']['5']['kind'] == 'playbook'


def test_single_file_output_unchanged_without_option():
    """PHP testSingleFileOutputUnchangedWithoutOption (lines 101-106)."""
    code = generator().generate(44, '3')['code']
    assert '"""Standalone LangGraph workflow: Dispatcher demo' in code
    assert 'PLAYBOOKS = {' in code


def test_agent_file_is_a_self_contained_a2a_server():
    """PHP testAgentFileIsASelfContainedA2AServer (lines 128-154)."""
    code = _agent_file('3')
    for needle in [
        '"""A2A agent "IT claims" -- node 3 of workflow "Dispatcher demo"',
        'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
        'new_task_from_user_message', 'class NodeExecutor(AgentExecutor)', 'def build_agent_card',
        'AGENT_CARD = build_agent_card(', 'Skill id:   node-3', 'def _make_llm(', 'def _call_mcp_tool(',
        'def build_tools_from_catalog', 'async def run_node(', 'uvicorn.run(', '"--port"',
        '# ---- node 3: IT claims (agent-template)', 'NODE = {', '"kind": "agent"',
        '<== this agent', 'A2A SERVING', 'A2A_GATE_TIMEOUT_S',
        'task {tid} is not waiting for input',
    ]:
        assert needle in code, f"missing: {needle}"
    # Only this node's tools are baked.
    assert '"get_news"' in code
    assert 'get_pto_balance' not in code
    # No playbook runtime in a plain agent file.
    assert 'def build_playbook_tools' not in code
    # Skill-bound node: run_skill_script is registered into the catalog and the
    # skill binding is baked onto NODE.
    assert 'catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL' in code
    assert '"skills": [{"dir":"html"}]' in code
    _assert_compiles(code, 'agent 3')


def test_dispatcher_agent_file_carries_the_menu():
    """PHP testDispatcherAgentFileCarriesTheMenu (lines 156-164)."""
    code = _agent_file('2')
    assert '"kind": "dispatcher"' in code
    assert '"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]' in code
    assert 'async def _run_dispatcher(' in code
    assert '## Routing' in code
    _assert_compiles(code, 'agent 2')


def test_playbook_agent_file_bridges_gates_to_a2a():
    """PHP testPlaybookAgentFileBridgesGatesToA2A (lines 166-176)."""
    code = _agent_file('5')
    assert '"kind": "playbook"' in code
    assert 'def build_playbook_tools' in code
    assert '"workday__get_pto_balance"' in code
    assert 'def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:' in code
    assert '_playbook_gate = _a2a_gate' in code
    assert 'requires_input(' in code
    _assert_compiles(code, 'agent 5')


def test_orchestrator_drives_agents_over_a2a():
    """PHP testOrchestratorDrivesAgentsOverA2A (lines 187-205)."""
    code = _orchestrator()
    for needle in [
        '"""A2A orchestrator for workflow "Dispatcher demo"', 'AGENT ENDPOINTS', 'A2A RUN',
        'from a2a.client import create_client, ClientConfig', 'class AgentSupervisor', 'async def _run_remote_node(',
        'def _handle_gate(', 'add_conditional_edges', 'A2A_AGENT_2_URL', '"file": "agents/2_techbuddy.py"',
        '"port": 8701', '--keep-serving', '--no-spawn', 'TASK_STATE_INPUT_REQUIRED', '[gate] ', '[gate-answer] ',
        '# ---- node 2: techBuddy (agent-template)', 'elif ntype in ("agent", "playbook"):', 'PLAYBOOK_GATE_MODE',
        '    "2": {"display": "techBuddy"',
        "def _is_local(url: str) -> bool:\n    \"\"\"True when `url` is a loopback address",
        "def _stream_kind(ev: \"T.StreamResponse\") -> str:\n    \"\"\"Which oneof field is set",
        'NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)',
    ]:
        assert needle in code, f"missing: {needle}"
    assert 'def build_playbook_tools' not in code, 'the orchestrator runs no node logic itself'
    _assert_compiles(code, 'orchestrator')


def test_a2a_option_returns_a_manifest():
    """PHP testA2AOptionReturnsAManifest (lines 207-220)."""
    m = generator().generate(44, '3', {'a2a': True})
    assert m['root'] == 'dispatcher_demo_a2a'
    assert [f['path'] for f in m['files']] == [
        'orchestrator.py', 'agents/2_techbuddy.py', 'agents/3_it-claims.py',
        'agents/4_human-resources.py', 'agents/5_playbook-hr.py',
    ]
    for f in m['files']:
        assert 'PROVENANCE' in f['code'], f['path']
        assert 'GRAPH EDGES' in f['code'], f['path']
        _assert_compiles(f['code'], f['path'])
    assert '<== this agent' in m['files'][1]['code']
    assert 'AGENT ENDPOINTS' in m['files'][0]['code']
