/**
 * Port of backend/tests/Unit/LangGraphA2AGeneratorTest.php: LangGraph compiler, A2A mode: one self-contained A2A
 * agent server per agent/playbook node under agents/, one orchestrator.py driving them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LangGraphGenerator } from '../src/AgentTeam/LangGraphGenerator';
import { a2aFacts, a2aGenerator, pyCompile, python3 } from './support/lgFixtures';

const noPy = python3() === null ? 'python3 not available' : false;

function assertCompiles(code: string, label: string): void {
  const r = pyCompile(code);
  assert.equal(r.rc, 0, `${label}: ${r.out.join('\n')}`);
}

async function agentFile(nid: string): Promise<string> {
  const gen: any = a2aGenerator();
  const facts = await gen.analyzeForEmit(44, '3');
  return gen.emitA2AAgentFile(facts, LangGraphGenerator.a2aLayout(facts), nid);
}

async function orchestrator(): Promise<string> {
  const gen: any = a2aGenerator();
  const facts = await gen.analyzeForEmit(44, '3');
  return gen.emitA2AOrchestrator(facts, LangGraphGenerator.a2aLayout(facts));
}

test('testLayoutNamesOneAgentFilePerAgentOrPlaybookNode', async () => {
  const layout = LangGraphGenerator.a2aLayout(await a2aFacts());
  assert.equal(layout['root'], 'dispatcher_demo_a2a');
  assert.deepEqual(Object.keys(layout['agents']).map(String), ['2', '3', '4', '5'], 'ORDER order, no start/output');
  assert.equal(layout['agents']['2']['file'], 'agents/2_techbuddy.py');
  assert.equal(layout['agents']['4']['file'], 'agents/4_human-resources.py');
  assert.equal(layout['agents']['5']['file'], 'agents/5_playbook-hr.py');
  assert.deepEqual(Object.values(layout['agents']).map((a: any) => a['port']), [8701, 8702, 8703, 8704]);
  assert.equal(layout['agents']['2']['kind'], 'dispatcher');
  assert.equal(layout['agents']['3']['kind'], 'agent');
  assert.equal(layout['agents']['5']['kind'], 'playbook');
});

test('testSingleFileOutputUnchangedWithoutOption', async () => {
  const code = ((await a2aGenerator().generate(44, '3')) as any)['code'];
  assert.ok(code.includes('"""Standalone LangGraph workflow: Dispatcher demo'));
  assert.ok(code.includes('PLAYBOOKS = {'));
});

test('testAgentFileIsASelfContainedA2AServer', { skip: noPy }, async () => {
  const code = await agentFile('3');
  for (const needle of [
    '"""A2A agent "IT claims" -- node 3 of workflow "Dispatcher demo"',
    'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
    'new_task_from_user_message', 'class NodeExecutor(AgentExecutor)', 'def build_agent_card',
    'AGENT_CARD = build_agent_card(', 'Skill id:   node-3', 'def _make_llm(', 'class McpClient:',
    'class ToolCatalog:', 'run_node = make_node(NODE).run', 'uvicorn.run(', '"--port"',
    '# ---- node 3: IT claims (agent)', 'NODE = {', '"kind": "agent"',
    '<== this agent', 'A2A SERVING', 'A2A_GATE_TIMEOUT_S',
    // A follow-up on a task with no paused run (completed/expired) must be rejected,
    // not silently started as a second run under the same task id (live-run fix).
    'task {tid} is not waiting for input',
  ]) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  // Only this node's tools are baked.
  assert.ok(code.includes('"get_news"'));
  assert.ok(!code.includes('get_pto_balance'));
  // No playbook runtime in a plain agent file.
  assert.ok(!code.includes('class PlaybookToolset:'));
  // Skill-bound node: run_skill_script is registered into the catalog and the skill binding is baked onto NODE.
  assert.ok(code.includes('built["run_skill_script"] = SKILLS.tool'));
  assert.ok(code.includes('"skills": [{"dir":"html"}]'));
  assertCompiles(code, 'agent 3');
});

test('testDispatcherAgentFileCarriesTheMenu', { skip: noPy }, async () => {
  const code = await agentFile('2');
  assert.ok(code.includes('"kind": "dispatcher"'));
  assert.ok(code.includes('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]'));
  assert.ok(code.includes('class Dispatcher:'));
  assert.ok(code.includes('## Routing'));
  assertCompiles(code, 'agent 2');
});

test('testPlaybookAgentFileBridgesGatesToA2A', { skip: noPy }, async () => {
  const code = await agentFile('5');
  assert.ok(code.includes('"kind": "playbook"'));
  assert.ok(code.includes('class PlaybookToolset:'));
  assert.ok(code.includes('"workday__get_pto_balance"'));
  assert.ok(code.includes('def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:'));
  assert.ok(code.includes('GATE_BRIDGE = _a2a_gate'));
  assert.ok(code.includes('requires_input('));
  assertCompiles(code, 'agent 5');
});

test('testOrchestratorDrivesAgentsOverA2A', { skip: noPy }, async () => {
  const code = await orchestrator();
  for (const needle of [
    '"""A2A orchestrator for workflow "Dispatcher demo"', 'AGENT ENDPOINTS', 'A2A RUN',
    'from a2a.client import create_client, ClientConfig', 'class AgentSupervisor', 'async def _run_remote_node(',
    'def _handle_gate(', 'add_conditional_edges', 'A2A_AGENT_2_URL', '"file": "agents/2_techbuddy.py"',
    '"port": 8701', '--keep-serving', '--no-spawn', 'TASK_STATE_INPUT_REQUIRED', '[gate] ', '[gate-answer] ',
    '# ---- node 2: techBuddy (agent)', 'case "agent" | "playbook" | "code":', 'PLAYBOOK_GATE_MODE',
    // AGENTS dict keys must be strings ("2", not 2) so they match ORDER/NODE_TYPES/state (live-run fix).
    '    "2": {"display": "techBuddy"',
    // Documentation nits from the Task 3 review: docstrings + the NODE_DURATIONS comment.
    'def _is_local(url: str) -> bool:\n    """True when `url` is a loopback address',
    'def _stream_kind(ev: "T.StreamResponse") -> str:\n    """Which oneof field is set',
    'NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)',
  ]) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!code.includes('class PlaybookToolset:'), 'the orchestrator runs no node logic itself');
  assertCompiles(code, 'orchestrator');
});

test('testA2AOptionReturnsAManifest', { skip: noPy }, async () => {
  const m: any = await a2aGenerator().generate(44, '3', { a2a: true });
  assert.equal(m['root'], 'dispatcher_demo_a2a');
  assert.deepEqual(
    m['files'].map((f: any) => f['path']),
    ['orchestrator.py', 'api.py', 'agents/2_techbuddy.py', 'agents/3_it-claims.py', 'agents/4_human-resources.py', 'agents/5_playbook-hr.py',
      'requirements.txt', '.env.example', 'README.md', 'ARCHITECTURE.md'],
  );
  for (const f of m['files']) {
    if (!f['path'].endsWith('.py')) {
      continue; // documentation and setup, not Python: see LangGraphArchitectureDocTest, LangGraphPackageTest
    }
    assert.ok(f['code'].includes('PROVENANCE'), f['path']);
    if (f['path'] !== 'api.py') {
      // api.py has no graph -- apiPyDocBody() replaces the GRAPH EDGES dump with the run server's own HTTP surface.
      assert.ok(f['code'].includes('GRAPH EDGES'), f['path']);
    }
    assertCompiles(f['code'], f['path']);
  }
  assert.ok(m['files'][2]['code'].includes('<== this agent'));
  assert.ok(m['files'][0]['code'].includes('AGENT ENDPOINTS'));
  // api.py: same run contract as the modular package, plus the A2A supervisor lifecycle.
  const api: string = m['files'][1]['code'];
  for (const needle of [
    '@app.post("/runs")', '@app.get("/runs/{run_id}/events")', '@app.post("/runs/{run_id}/tool-result")',
    '@app.get("/.well-known/workflow.json")', 'class RunState', 'AgentSupervisor',
    'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
    'from orchestrator import set_event_sink, resolve_gate', 'def _ensure_agents() -> None:',
    '_SUPERVISOR = AgentSupervisor(spawn=True)',
  ]) {
    assert.ok(api.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!api.includes('Authorization'), 'the run server has no auth');
});
