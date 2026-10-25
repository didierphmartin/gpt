"""Port of backend/tests/Unit/LangGraphA2AGeneratorTest.php.

LangGraph compiler, A2A mode: one self-contained A2A agent server per agent/playbook node under agents/,
one orchestrator.py driving them. PHP reaches the private emitters through reflection; here they are
the `_camelCase` methods.
"""
from __future__ import annotations

from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit import lg_support as S


def _agent_file(nid: str) -> str:
    gen = S.demo_generator()
    facts = gen._analyzeForEmit(44, '3')
    return gen._emitA2AAgentFile(facts, LangGraphGenerator.a2aLayout(facts), nid)


def _orchestrator() -> str:
    gen = S.demo_generator()
    facts = gen._analyzeForEmit(44, '3')
    return gen._emitA2AOrchestrator(facts, LangGraphGenerator.a2aLayout(facts))


def test_layout_names_one_agent_file_per_agent_or_playbook_node():
    layout = LangGraphGenerator.a2aLayout(S.demo_facts())
    assert layout['root'] == 'dispatcher_demo_a2a'
    assert list(layout['agents']) == ['2', '3', '4', '5'], 'ORDER order, no start/output'
    assert layout['agents']['2']['file'] == 'agents/2_techbuddy.py'
    assert layout['agents']['4']['file'] == 'agents/4_human-resources.py'
    assert layout['agents']['5']['file'] == 'agents/5_playbook-hr.py'
    assert [e['port'] for e in layout['agents'].values()] == [8701, 8702, 8703, 8704]
    assert layout['agents']['2']['kind'] == 'dispatcher'
    assert layout['agents']['3']['kind'] == 'agent'
    assert layout['agents']['5']['kind'] == 'playbook'


def test_single_file_output_unchanged_without_option():
    code = S.demo_generator().generate(44, '3')['code']
    assert '"""Standalone LangGraph workflow: Dispatcher demo' in code
    assert 'PLAYBOOKS = {' in code


def test_agent_file_is_a_self_contained_a2a_server():
    code = _agent_file('3')
    for needle in ['"""A2A agent "IT claims" -- node 3 of workflow "Dispatcher demo"',
                   'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
                   'new_task_from_user_message', 'class NodeExecutor(AgentExecutor)', 'def build_agent_card',
                   'AGENT_CARD = build_agent_card(', 'Skill id:   node-3', 'def _make_llm(', 'class McpClient:',
                   'class ToolCatalog:', 'run_node = make_node(NODE).run', 'uvicorn.run(', '"--port"',
                   '# ---- node 3: IT claims (agent)', 'NODE = {', '"kind": "agent"',
                   '<== this agent', 'A2A SERVING', 'A2A_GATE_TIMEOUT_S',
                   'task {tid} is not waiting for input']:
        assert needle in code, f'missing: {needle}'
    assert '"get_news"' in code
    assert 'get_pto_balance' not in code
    assert 'class PlaybookToolset:' not in code
    assert 'built["run_skill_script"] = SKILLS.tool' in code
    assert '"skills": [{"dir":"html"}]' in code
    S.assert_compiles(code, 'agent 3')


def test_dispatcher_agent_file_carries_the_menu():
    code = _agent_file('2')
    assert '"kind": "dispatcher"' in code
    assert ('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, '
            '{"id": "4", "name": "Human resources", "description": ""}]') in code
    assert 'class Dispatcher:' in code
    assert '## Routing' in code
    S.assert_compiles(code, 'agent 2')


def test_playbook_agent_file_bridges_gates_to_a2a():
    code = _agent_file('5')
    assert '"kind": "playbook"' in code
    assert 'class PlaybookToolset:' in code
    assert '"workday__get_pto_balance"' in code
    assert 'def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:' in code
    assert 'GATE_BRIDGE = _a2a_gate' in code
    assert 'requires_input(' in code
    S.assert_compiles(code, 'agent 5')


def test_orchestrator_drives_agents_over_a2a():
    code = _orchestrator()
    for needle in ['"""A2A orchestrator for workflow "Dispatcher demo"', 'AGENT ENDPOINTS', 'A2A RUN',
                   'from a2a.client import create_client, ClientConfig', 'class AgentSupervisor', 'async def _run_remote_node(',
                   'def _handle_gate(', 'add_conditional_edges', 'A2A_AGENT_2_URL', '"file": "agents/2_techbuddy.py"',
                   '"port": 8701', '--keep-serving', '--no-spawn', 'TASK_STATE_INPUT_REQUIRED', '[gate] ', '[gate-answer] ',
                   '# ---- node 2: techBuddy (agent)', 'case "agent" | "playbook" | "code":', 'PLAYBOOK_GATE_MODE',
                   '    "2": {"display": "techBuddy"',
                   'def _is_local(url: str) -> bool:\n    """True when `url` is a loopback address',
                   'def _stream_kind(ev: "T.StreamResponse") -> str:\n    """Which oneof field is set',
                   'NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)']:
        assert needle in code, f'missing: {needle}'
    assert 'class PlaybookToolset:' not in code, 'the orchestrator runs no node logic itself'
    S.assert_compiles(code, 'orchestrator')


def test_a2a_option_returns_a_manifest():
    m = S.demo_generator().generate(44, '3', {'a2a': True})
    assert m['root'] == 'dispatcher_demo_a2a'
    assert [f['path'] for f in m['files']] == ['orchestrator.py', 'api.py', 'agents/2_techbuddy.py', 'agents/3_it-claims.py',
                                               'agents/4_human-resources.py', 'agents/5_playbook-hr.py', 'ARCHITECTURE.md']
    for f in m['files']:
        if f['path'] == 'ARCHITECTURE.md':
            continue
        assert 'PROVENANCE' in f['code'], f['path']
        if f['path'] != 'api.py':
            assert 'GRAPH EDGES' in f['code'], f['path']
        S.assert_compiles(f['code'], f['path'])
    assert '<== this agent' in m['files'][2]['code']
    assert 'AGENT ENDPOINTS' in m['files'][0]['code']
    api = m['files'][1]['code']
    for needle in ['@app.post("/runs")', '@app.get("/runs/{run_id}/events")', '@app.post("/runs/{run_id}/tool-result")',
                   '@app.get("/.well-known/workflow.json")', 'class RunState', 'AgentSupervisor',
                   'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
                   'from orchestrator import set_event_sink, resolve_gate', 'def _ensure_agents() -> None:',
                   '_SUPERVISOR = AgentSupervisor(spawn=True)']:
        assert needle in api, f'missing: {needle}'
    assert 'Authorization' not in api, 'the run server has no auth'
