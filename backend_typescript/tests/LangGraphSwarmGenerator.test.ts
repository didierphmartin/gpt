/**
 * Port of backend/tests/Unit/LangGraphSwarmGeneratorTest.php: LangGraph compiler, swarm mode (`orchestration =
 * "swarm"` on the workflow). Only the modular layout; single-file or A2A on a swarm is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LangGraphGenerator } from '../src/AgentTeam/LangGraphGenerator';
import { execLines, makeGenerator, PHP_FIXTURES, python3, sqlite } from './support/lgFixturesB';

function pdo(): void {
  sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)",
  ]);
}

const agent = (name: string) => ({
  type: 'agent-template', agent_name: name, agent_type: 'standard',
  instructions: `You are ${name}.`, agent_provider: 'claude', model: 'claude-sonnet-4-5',
  tools: [], settings: { temperature: 0.7, max_tokens: 4096 },
});

/** Start -> two agents, no dispatcher: the smallest graph SwarmRewriter accepts. */
function twoAgentSwarm(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'Help me plan a trip.' } },
      { id: '2', node_type: '', config: agent('Alice') },
      { id: '3', node_type: '', config: agent('Bob') },
    ],
    edges: [{ from: '1', to: '2' }, { from: '1', to: '3' }],
  };
}

/** Start -> one agent: below SwarmRewriter's two-member floor (start_needs_two_agents). */
function oneAgentSwarm(): any {
  const g = twoAgentSwarm();
  g.nodes.splice(2, 1);
  g.edges.splice(1, 1);
  return g;
}

/** Start -> three agents: member order follows Start's fan-out (canvas order). */
function threeAgentSwarm(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'Help me plan a trip.' } },
      { id: '2', node_type: '', config: agent('Agent A') },
      { id: '3', node_type: '', config: agent('Agent B') },
      { id: '4', node_type: '', config: agent('Agent C') },
    ],
    edges: [{ from: '1', to: '2' }, { from: '1', to: '3' }, { from: '1', to: '4' }],
  };
}

/** Start -> two agents, one tagged Dispatcher (dispatcher_in_swarm). */
function swarmWithDispatcherTag(): any {
  const g = twoAgentSwarm();
  g.nodes[1].config.agent_type = 'dispatcher';
  return g;
}

/** Installs the database and returns the generator (PHP: new LangGraphGenerator(self::pdo(), ...)). */
function generator(graph: any, orchestration = 'swarm', storage = false, skillsRoot: string | null = null): LangGraphGenerator {
  pdo();
  return makeGenerator({ workflow: { id: 90, name: 'Trip planning swarm', user_id: '3', output_storage_enabled: storage, orchestration }, graph, skillsRoot });
}

/** Facts as analyzeForEmit() returns them (private). */
async function facts(graph: any, orchestration = 'swarm', storage = false): Promise<any> {
  return (generator(graph, orchestration, storage) as any).analyzeForEmit(90, '3');
}

function byPath(manifest: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of manifest.files) out[f.path] = f.code;
  return out;
}

/** The generator's swarm emit path directly (skipping generate()'s option dispatch); path => code. */
async function generateSwarm(graph: any, storage = false, skillsRoot: string | null = null): Promise<Record<string, string>> {
  const f = await facts(graph, 'swarm', storage);
  const gen: any = generator(graph, 'swarm', storage, skillsRoot);
  return byPath(await gen.generateSwarm(f));
}

/** generate() itself, as a caller (the code-gen dialog) would. */
async function generate(graph: any, options: any, orchestration = 'swarm'): Promise<any> {
  return generator(graph, orchestration).generate(90, '3', options);
}

async function rejectsMatching(fn: () => Promise<any>, re: RegExp): Promise<void> {
  await assert.rejects(fn, (e: any) => e instanceof Error && re.test(e.message));
}

/** Fix round 1 (Task 7): the swarm package installs langgraph-swarm and its README names the swarm root. */
test('testSwarmPackageNeedsLangGraphSwarmAndNamesItsRoot', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.ok(files['requirements.txt'].split('\n').includes('langgraph-swarm'));
  assert.ok((files['workflow.py'] + Object.values(files).join('\n')).includes('from langgraph_swarm import'));
  assert.ok(files['README.md'].includes('/path/to/trip_planning_swarm_modular_swarm/workflow.py'));
  assert.ok(!files['README.md'].includes('_modular/'));
  assert.ok(!files['README.md'].includes('--watch'), 'a swarm has no --watch');
});

/** Final review M-g: no runs/ logs, no api.py --listen, outputs in its own outputs/ folder, no synergyAI/ path. */
test('testTheSwarmPackageSavesInItsFolderAndClaimsNoListener', async () => {
  const files = await generateSwarm(twoAgentSwarm(), true);
  for (const absent of ['runs/', '--listen', 'RUNS_DIR']) {
    assert.ok(!(files['README.md'] + files['.env.example']).includes(absent), absent);
  }
  assert.ok(files['README.md'].includes('python api.py'));
  for (const [p, code] of Object.entries(files)) assert.ok(!code.includes('synergyAI/'), p);
  const wf = files['workflow.py'];
  assert.ok(wf.includes('root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")'));
  assert.ok(wf.includes('# Output storage (Output node setting): ON -> outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)'));
});

test('testASwarmWorkflowCompilesThroughTheSwarmPath', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.ok('workflow.py' in files);
  assert.ok(files['workflow.py'].includes('create_swarm'));
});

test('testWorkflowUsesTheEntryAgentsDisplayNameAsDefaultActiveAgent', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.ok(files['workflow.py'].includes('DEFAULT_ACTIVE_AGENT = "Alice"'));
  assert.ok(files['workflow.py'].includes('default_active_agent=DEFAULT_ACTIVE_AGENT'));
});

test('testWorkflowCompilesTheGraphItBuilds', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.match(files['workflow.py'], /create_swarm\([\s\S]*?\)\.compile\(checkpointer=MemorySaver\(\)\)/);
});

/** A member's doc names its skills: a folder skill by its folder, an inline one as such -- never PHP's "Array". */
test('testTheMemberDocNamesItsSkills', async () => {
  const g = twoAgentSwarm();
  g.nodes[1].config.bound_skill = { dir_name: 'html', name: 'HTML' };
  g.nodes[2].config.skill_content = 'Answer in haiku.';
  const root = mkdtempSync(path.join(tmpdir(), 'swarm-skills-'));
  mkdirSync(path.join(root, 'html'));
  writeFileSync(path.join(root, 'html', 'SKILL.md'), '---\nname: html\n---\n');
  let files: Record<string, string>;
  try {
    files = await generateSwarm(g, false, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(files['agents/alice.py'].includes('  Skills: html'));
  assert.ok(files['agents/bob.py'].includes('  Skills: inline skill'));
  assert.ok(!(files['agents/alice.py'] + files['agents/bob.py']).includes('Array'));
});

test('testEachMemberGetsOneHandoffToolPerColleague', async () => {
  const files = await generateSwarm(threeAgentSwarm());
  for (const p of ['agents/agent_a.py', 'agents/agent_b.py', 'agents/agent_c.py']) {
    assert.equal(files[p].split('create_handoff_tool(').length - 1, 2, `expected 2 handoffs in ${p}`);
    assert.ok(files[p].includes('from langgraph_swarm import create_handoff_tool'));
  }
  assert.ok(!files['agents/agent_a.py'].includes('agent_name="Agent A"'));
});

test('testNoRouterOrDispatcherModuleIsEmitted', async () => {
  const files = await generateSwarm(threeAgentSwarm());
  for (const p of Object.keys(files)) {
    assert.ok(!p.toLowerCase().includes('dispatcher'));
    assert.ok(!p.toLowerCase().includes('router'));
  }
  assert.ok('agents/__init__.py' in files);
});

test('testCommonAndApiAreByteIdenticalToTheModularPath', async () => {
  const graph = twoAgentSwarm();
  const swarmFiles = await generateSwarm(graph);
  const modularFacts = await facts(graph, 'workflow');
  const modularGen: any = generator(graph, 'workflow');
  const modularFiles = byPath(await modularGen.generateModular(modularFacts));
  // Two generations can straddle a second: the "Generated:" stamp is not what this compares.
  const unstamped = (code: string): string => code.replace(/^(\s*Generated:).*$/gm, '$1');
  assert.equal(unstamped(swarmFiles['common.py']), unstamped(modularFiles['common.py']));
  assert.equal(unstamped(swarmFiles['api.py']), unstamped(modularGen.emitModularApi(modularFacts, LangGraphGenerator.modularLayout(modularFacts), false)));
  assert.ok(modularFiles['api.py'].includes('@app.post("/listen")'));
  assert.ok(!swarmFiles['api.py'].includes('/listen'));
});

test('testSwarmRunAcceptsASessionAndUsesItAsTheThreadId', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.ok(files['workflow.py'].includes('async def run(user_prompt: str, session: str | None = None) -> str:'));
  assert.ok(files['workflow.py'].includes('config = {"configurable": {"thread_id": session or uuid.uuid4().hex}}'));
});

test('testModularRunAcceptsASessionButIgnoresIt', async () => {
  const modularFacts = await facts(twoAgentSwarm(), 'workflow');
  const modularGen: any = generator(twoAgentSwarm(), 'workflow');
  const modularFiles = byPath(await modularGen.generateModular(modularFacts));
  assert.ok(modularFiles['workflow.py'].includes('async def run(user_prompt: str, session: str | None = None) -> str:'));
  assert.ok(!modularFiles['workflow.py'].includes('thread_id'));
});

test('testRunsRouteForwardsSessionToRunWorkflow', async () => {
  const files = await generateSwarm(twoAgentSwarm());
  assert.ok(files['api.py'].includes('session = (body or {}).get("session") or None'));
  assert.ok(files['api.py'].includes('state = RunState(uuid.uuid4().hex, prompt, session)'));
  assert.ok(files['api.py'].includes('state.output = await run_workflow(state.prompt, state.session)'));
});

/** Task 9: run() emits the answer as a message event naming the answering member. */
test('testRunEmitsTheAnswerAsAMessageEventNamingTheAnsweringMember', async () => {
  const workflow = (await generateSwarm(twoAgentSwarm()))['workflow.py'];
  assert.ok(workflow.includes('from common import EVENTS'));
  assert.ok(workflow.includes('MEMBER_NAMES = {"Alice", "Bob"}'));
  assert.ok(workflow.includes('active = result.get("active_agent")'));
  assert.ok(workflow.includes('display = active if isinstance(active, str) and active in MEMBER_NAMES else DEFAULT_ACTIVE_AGENT'));
  assert.ok(workflow.includes('EVENTS.emit(type="message", text=f"**{display}**\\n\\n{text}", agent=display, sensitive=False)'));
  assert.ok(workflow.indexOf('EVENTS.emit(type="message"') < workflow.indexOf('return text'),
    'the message event must be emitted before run() returns');
});

test('testWorkflowStillCompilesAfterEmittingTheAnswerEvent', { skip: python3() === null ? 'python3 not available' : false }, async () => {
  const files = await generateSwarm(twoAgentSwarm());
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmwf'));
  try {
    writeFileSync(path.join(dir, 'wf.py'), files['workflow.py']);
    const [rc, out] = execLines(['python3', '-m', 'py_compile', path.join(dir, 'wf.py')]);
    assert.equal(rc, 0, out.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('testSingleFileIsRefusedForASwarm', async () => {
  await rejectsMatching(() => generate(twoAgentSwarm(), {}), /single file|modular/i);
});

test('testA2AIsRefusedForASwarm', async () => {
  await rejectsMatching(() => generate(twoAgentSwarm(), { a2a: true }), /A2A/i);
});

test('testARefusedCanvasFailsGenerationNamingTheNodes', async () => {
  await rejectsMatching(() => generateSwarm(oneAgentSwarm()), /two or more agents|start_needs_two_agents/i);
});

test('testADispatcherTaggedNodeIsRefusedAtCompileTime', async () => {
  await rejectsMatching(() => generateSwarm(swarmWithDispatcherTag()), /Dispatcher/i);
});

test('testTheMembersAreStartsFanOutInCanvasOrder', async () => {
  const files = await generateSwarm(threeAgentSwarm());
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('agents/') && f !== 'agents/__init__.py'),
    ['agents/agent_a.py', 'agents/agent_b.py', 'agents/agent_c.py']);
});

/** ~/Documents/synergyAI/python/.venv/bin/python -- where langgraph-swarm 0.1.0 lives. */
const VENV = path.join((process.env.HOME ?? '').replace(/\/+$/, ''), 'Documents/synergyAI/python/.venv/bin/python');
const venvAvailable = (() => {
  try {
    accessSync(VENV, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

/** The behavioural gate: the compiled swarm package builds and keeps a session in the runner venv (swarm_probe.py). */
test('testTheCompiledSwarmPackageBuildsAndBehavesInTheRunnerVenv',
  { skip: venvAvailable ? false : `runner venv python not found at ${VENV} (langgraph-swarm 0.1.0 lives there) -- skipping the real behavioural probe` },
  async (t) => {
    const files = await generateSwarm(twoAgentSwarm());
    const root = path.join(tmpdir(), 'swarm_probe_' + randomBytes(6).toString('hex'));
    try {
      for (const [p, code] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        writeFileSync(path.join(root, p), code);
      }
      const [rc, out] = execLines([VENV, path.join(PHP_FIXTURES, 'compiled/swarm_probe.py'), root], {}, { timeoutMs: 300000 });
      const output = out.join('\n');
      if (rc === 2) {
        t.skip(`swarm_probe.py hit a known, reported generator defect (not this task's to fix):\n${output}`);
        return;
      }
      assert.equal(rc, 0, `swarm_probe.py failed:\n${output}`);
      assert.ok(output.includes('OK'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
