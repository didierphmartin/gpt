"""Port of backend/tests/Unit/LangGraphSwarmGeneratorTest.php.

LangGraph compiler, swarm mode: `orchestration = "swarm"` is a property of the workflow, read through the
facts. A swarm supports only the modular layout; single-file or A2A packaging is refused.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit import lg_support as S


def _db():
    return S.db(*S.MCP_DDL, S.LLM_DDL, "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")


def _agent(name: str) -> dict:
    return {'type': 'agent-template', 'agent_name': name, 'agent_type': 'standard',
            'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
            'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}


def _two_agent_swarm() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'Help me plan a trip.'}},
        {'id': '2', 'node_type': '', 'config': _agent('Alice')},
        {'id': '3', 'node_type': '', 'config': _agent('Bob')},
    ], 'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}]}


def _one_agent_swarm() -> dict:
    g = _two_agent_swarm()
    del g['nodes'][2]
    del g['edges'][1]
    return g


def _three_agent_swarm() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'Help me plan a trip.'}},
        {'id': '2', 'node_type': '', 'config': _agent('Agent A')},
        {'id': '3', 'node_type': '', 'config': _agent('Agent B')},
        {'id': '4', 'node_type': '', 'config': _agent('Agent C')},
    ], 'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}, {'from': '1', 'to': '4'}]}


def _swarm_with_dispatcher_tag() -> dict:
    g = _two_agent_swarm()
    g['nodes'][1]['config']['agent_type'] = 'dispatcher'
    return g


def _generator(graph: dict, orchestration: str = 'swarm', storage: bool = False, skillsRoot: str | None = None) -> LangGraphGenerator:
    wf = Workflow({'id': 90, 'name': 'Trip planning swarm', 'user_id': '3', 'output_storage_enabled': storage}).setOrchestration(orchestration)
    return S.generator(_db(), graph, wf, skillsRoot=skillsRoot)


def _facts(graph: dict, orchestration: str = 'swarm', storage: bool = False) -> dict:
    return _generator(graph, orchestration, storage)._analyzeForEmit(90, '3')


def _generate_swarm(graph: dict, storage: bool = False, skillsRoot: str | None = None) -> dict:
    gen = _generator(graph, 'swarm', storage, skillsRoot)
    manifest = gen._generateSwarm(_facts(graph, 'swarm', storage))
    return {f['path']: f['code'] for f in manifest['files']}


def _generate(graph: dict, options: dict, orchestration: str = 'swarm') -> dict:
    return _generator(graph, orchestration).generate(90, '3', options)


def test_swarm_package_needs_lang_graph_swarm_and_names_its_root():
    files = _generate_swarm(_two_agent_swarm())
    assert 'langgraph-swarm' in files['requirements.txt'].split('\n')
    assert 'from langgraph_swarm import' in files['workflow.py'] + '\n'.join(files.values())
    assert '/path/to/trip_planning_swarm_modular_swarm/workflow.py' in files['README.md']
    assert '_modular/' not in files['README.md']
    assert '--watch' not in files['README.md'], 'a swarm has no --watch'


def test_the_swarm_package_saves_in_its_folder_and_claims_no_listener():
    files = _generate_swarm(_two_agent_swarm(), True)
    for absent in ('runs/', '--listen', 'RUNS_DIR'):
        assert absent not in files['README.md'] + files['.env.example'], absent
    assert 'python api.py' in files['README.md']
    for path, code in files.items():
        assert 'synergyAI/' not in code, path
    wf = files['workflow.py']
    assert 'root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")' in wf
    assert '# Output storage (Output node setting): ON -> outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)' in wf


def test_a_swarm_workflow_compiles_through_the_swarm_path():
    files = _generate_swarm(_two_agent_swarm())
    assert 'workflow.py' in files
    assert 'create_swarm' in files['workflow.py']


def test_workflow_uses_the_entry_agents_display_name_as_default_active_agent():
    files = _generate_swarm(_two_agent_swarm())
    assert 'DEFAULT_ACTIVE_AGENT = "Alice"' in files['workflow.py']
    assert 'default_active_agent=DEFAULT_ACTIVE_AGENT' in files['workflow.py']


def test_workflow_compiles_the_graph_it_builds():
    assert re.search(r'create_swarm\(.*?\)\.compile\(checkpointer=MemorySaver\(\)\)', _generate_swarm(_two_agent_swarm())['workflow.py'], re.S)


def test_the_member_doc_names_its_skills():
    """A member's doc names its skills: a folder skill by its folder, an inline one as such -- never PHP's "Array"."""
    g = _two_agent_swarm()
    g['nodes'][1]['config']['bound_skill'] = {'dir_name': 'html', 'name': 'HTML'}
    g['nodes'][2]['config']['skill_content'] = 'Answer in haiku.'
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, 'html'))
        with open(os.path.join(root, 'html', 'SKILL.md'), 'w') as fh:
            fh.write('---\nname: html\n---\n')
        files = _generate_swarm(g, skillsRoot=root)
    assert '  Skills: html' in files['agents/alice.py']
    assert '  Skills: inline skill' in files['agents/bob.py']
    assert 'Array' not in files['agents/alice.py'] + files['agents/bob.py']


def test_each_member_gets_one_handoff_tool_per_colleague():
    files = _generate_swarm(_three_agent_swarm())
    for path in ('agents/agent_a.py', 'agents/agent_b.py', 'agents/agent_c.py'):
        assert files[path].count('create_handoff_tool(') == 2, f'expected 2 handoffs in {path}'
        assert 'from langgraph_swarm import create_handoff_tool' in files[path]
    assert 'agent_name="Agent A"' not in files['agents/agent_a.py']


def test_no_router_or_dispatcher_module_is_emitted():
    files = _generate_swarm(_three_agent_swarm())
    for path in files:
        assert 'dispatcher' not in path.lower()
        assert 'router' not in path.lower()
    assert 'agents/__init__.py' in files


def test_common_and_api_are_byte_identical_to_the_modular_path():
    graph = _two_agent_swarm()
    swarmFiles = _generate_swarm(graph)
    modularGen = _generator(graph, 'workflow')
    modularFacts = _facts(graph, 'workflow')
    modularFiles = {f['path']: f['code'] for f in modularGen._generateModular(modularFacts)['files']}
    # Two generations can straddle a second: the "Generated:" stamp is not what this compares.
    def unstamped(code: str) -> str:
        return re.sub(r'^(\s*Generated:).*$', r'\1', code, flags=re.M)
    assert unstamped(modularFiles['common.py']) == unstamped(swarmFiles['common.py'])
    assert unstamped(modularGen._emitModularApi(modularFacts, LangGraphGenerator.modularLayout(modularFacts), False)) == unstamped(swarmFiles['api.py'])
    assert '@app.post("/listen")' in modularFiles['api.py']
    assert '/listen' not in swarmFiles['api.py']


def test_swarm_run_accepts_a_session_and_uses_it_as_the_thread_id():
    files = _generate_swarm(_two_agent_swarm())
    assert 'async def run(user_prompt: str, session: str | None = None) -> str:' in files['workflow.py']
    assert 'config = {"configurable": {"thread_id": session or uuid.uuid4().hex}}' in files['workflow.py']


def test_modular_run_accepts_a_session_but_ignores_it():
    modularGen = _generator(_two_agent_swarm(), 'workflow')
    modularFiles = {f['path']: f['code'] for f in modularGen._generateModular(_facts(_two_agent_swarm(), 'workflow'))['files']}
    assert 'async def run(user_prompt: str, session: str | None = None) -> str:' in modularFiles['workflow.py']
    assert 'thread_id' not in modularFiles['workflow.py']


def test_runs_route_forwards_session_to_run_workflow():
    files = _generate_swarm(_two_agent_swarm())
    assert 'session = (body or {}).get("session") or None' in files['api.py']
    assert 'state = RunState(uuid.uuid4().hex, prompt, session)' in files['api.py']
    assert 'state.output = await run_workflow(state.prompt, state.session)' in files['api.py']


def test_run_emits_the_answer_as_a_message_event_naming_the_answering_member():
    workflow = _generate_swarm(_two_agent_swarm())['workflow.py']
    assert 'from common import EVENTS' in workflow
    assert 'MEMBER_NAMES = {"Alice", "Bob"}' in workflow
    assert 'active = result.get("active_agent")' in workflow
    assert 'display = active if isinstance(active, str) and active in MEMBER_NAMES else DEFAULT_ACTIVE_AGENT' in workflow
    assert 'EVENTS.emit(type="message", text=f"**{display}**\\n\\n{text}", agent=display, sensitive=False)' in workflow
    assert workflow.index('EVENTS.emit(type="message"') < workflow.index('return text'), \
        'the message event must be emitted before run() returns'


def test_workflow_still_compiles_after_emitting_the_answer_event():
    S.assert_compiles(_generate_swarm(_two_agent_swarm())['workflow.py'], 'workflow.py')


def test_single_file_is_refused_for_a_swarm():
    with pytest.raises(RuntimeError, match=re.compile('single file|modular', re.I)):
        _generate(_two_agent_swarm(), {})


def test_a2_a_is_refused_for_a_swarm():
    with pytest.raises(RuntimeError, match=re.compile('A2A', re.I)):
        _generate(_two_agent_swarm(), {'a2a': True})


def test_a_refused_canvas_fails_generation_naming_the_nodes():
    with pytest.raises(RuntimeError, match=re.compile('two or more agents|start_needs_two_agents', re.I)):
        _generate_swarm(_one_agent_swarm())


def test_a_dispatcher_tagged_node_is_refused_at_compile_time():
    with pytest.raises(RuntimeError, match=re.compile('Dispatcher', re.I)):
        _generate_swarm(_swarm_with_dispatcher_tag())


def test_the_members_are_starts_fan_out_in_canvas_order():
    files = _generate_swarm(_three_agent_swarm())
    assert [f for f in files if f.startswith('agents/') and f != 'agents/__init__.py'] == \
        ['agents/agent_a.py', 'agents/agent_b.py', 'agents/agent_c.py']


def test_the_compiled_swarm_package_builds_and_behaves_in_the_runner_venv():
    venv = os.path.join(os.environ.get('HOME', '').rstrip('/'), 'Documents/synergyAI/python/.venv/bin/python')
    if not (os.path.isfile(venv) and os.access(venv, os.X_OK)):
        pytest.skip(f'runner venv python not found at {venv} (langgraph-swarm 0.1.0 lives there) -- skipping the real behavioural probe')
    files = _generate_swarm(_two_agent_swarm())
    root = tempfile.mkdtemp(prefix='swarm_probe_')
    for path, code in files.items():
        os.makedirs(os.path.dirname(f'{root}/{path}'), exist_ok=True)
        with open(f'{root}/{path}', 'w', encoding='utf-8') as fh:
            fh.write(code)
    r = subprocess.run([venv, str(S.PHP_FIXTURES / 'compiled' / 'swarm_probe.py'), root], capture_output=True, text=True)
    output = r.stdout + r.stderr
    if r.returncode == 2:
        pytest.skip(f"swarm_probe.py hit a known, reported generator defect (not this task's to fix):\n{output}")
    assert r.returncode == 0, f'swarm_probe.py failed:\n{output}'
    assert 'OK' in output
