/**
 * Port of backend/tests/Unit/LangGraphGeneratorPlaybookTest.php. LangGraph compiler: playbook nodes and dispatcher
 * agents.
 *
 * - A playbook node compiles to a PLAYBOOKS entry whose #Actions are bound against the user's MCP registry at
 *   generation time and runs through the emitted playbook runtime.
 * - A dispatcher agent's fan-out is a MENU: the agent gets route_to over its children and the graph wires a
 *   conditional edge, so exactly one child runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { lgDb, lgGenerator, pyCompile, python3 } from './support/lgFixtures';
import { NOOAGenerator } from '../src/AgentTeam/NOOAGenerator';   // after lgFixtures: it sets the DB env vars the pools read

const noPy = python3() === null ? 'python3 not available' : false;

const PLAYBOOK = `Title: Time Off & Leave

Trigger: Requester asks for PTO.

Instructions:
1. #Get PTO Balance for the requester.
2. #Request Approval from the manager.
3. On approval: #Submit Time Off with the dates. #Frobnicate the record.
4. #Leave Internal Note then #Resolve Request.

Tools used: Workday

Actions used: #Get PTO Balance; #Request Approval; #Submit Time Off; #Frobnicate; #Leave Internal Note; #Resolve Request`;

function pdo(): string[] {
  return [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
    "INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)",
    'INSERT INTO mcp_server_tools VALUES (1, 85, \'get_pto_balance\', \'Get balances\', \'{"type":"object","properties":{"email":{"type":"string"}},"required":["email"]}\')',
    'INSERT INTO mcp_server_tools VALUES (2, 85, \'submit_time_off\', \'Submit\', \'{"type":"object","properties":{"start":{"type":"string"}}}\')',
    "INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
    "INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-flash', 1)",
  ];
}

/** PlaybookStoreTest::schema() (backend/tests/Unit/Playbook/PlaybookStoreTest.php). */
function playbookSchema(): string[] {
  return [
    `CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
            title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT,
            published_by INTEGER NULL, published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER NULL, UNIQUE (user_id, pkey))`,
    `CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            agent_type TEXT DEFAULT "standard", instructions TEXT, playbook_id INTEGER)`,
    'CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)',
    'CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT)',
  ];
}

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const insPlaybook = (uid: number, key: string, title: string, text: string) =>
  `INSERT INTO playbooks (user_id, pkey, title, text) VALUES (${uid}, ${q(key)}, ${q(title)}, ${q(text)})`;

/** The test pdo plus a robot (users.kind = 'service') owning the published playbook "test", and a draft "draft" of user 3. */
function robotPdo(): string[] {
  return [
    ...pdo(),
    ...playbookSchema(),
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)',
    "INSERT INTO users (id, kind) VALUES (3, 'user'), (7, 'service')",
    insPlaybook(7, 'test', 'Time Off & Leave', PLAYBOOK),
    insPlaybook(3, 'draft', 'Draft only', 'Title: Draft only\n\nInstructions:\n1. #Resolve Request.\n'),
  ];
}

const WORKFLOW = { id: 44, name: 'Dispatcher demo', user_id: '3' };

async function generate(graph: any, userId: string | null = '3', sqlStatements: string[] | null = null, target = 'langgraph', options: any = {}): Promise<string> {
  const statements = sqlStatements ?? pdo();
  if (target !== 'langgraph') {
    lgDb(statements);
    const repos: [any, any, any] = [
      { findById: async () => ({ id: 44, name: 'Dispatcher demo', userId: '3', outputStorageEnabled: false, outputFolder: null, orchestration: 'workflow' }) },
      { getGraph: async () => graph },
      { findById: async () => null },
    ];
    const gen: any = target === 'adk' ? new ADKGenerator(...repos) : target === 'nooa' ? new NOOAGenerator(...repos) : new MAFGenerator(...repos);
    return (await gen.generate(44, userId))['code'];
  }
  const gen = lgGenerator({ sql: statements, workflow: WORKFLOW, graph });
  const res: any = await gen.generate(44, userId, options);
  return res['code'] ?? res['files'].map((f: any) => `### ${f['path']}\n` + f['code']).join('\n');
}

/** Start -> Playbook (from input, exits done/failed) -> Done (output_1) / Failed (output_2). */
function fromInputGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: '{"playbook":"test"}' } },
      {
        id: '2',
        node_type: 'playbook',
        config: {
          type: 'playbook', name: 'Run job playbook', playbook_source: 'input', playbook_input_field: 'playbook', exits: ['done', 'failed'],
          agent_provider: 'deepseek', model: 'deepseek-flash', writes_enabled: true,
        },
      },
      { id: '3', node_type: 'output', config: { type: 'output' } },
      { id: '4', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2' },
      { from: '2', to: '3', from_port: 'output_1' },
      { from: '2', to: '4', from_port: 'output_2' },
    ],
  };
}

function pyCompiles(code: string): [number, string] {
  const r = pyCompile(code);
  return [r.rc, r.out.join('\n')];
}

function substrCount(h: string, n: string): number {
  return h.split(n).length - 1;
}

test('testFromInputBakesPublishedPlaybooks', { skip: noPy }, async () => {
  const code = await generate(fromInputGraph(), '3', robotPdo());
  assert.ok(code.includes('PUBLISHED_PLAYBOOKS = {'));
  assert.ok(code.includes('    "test": {'));
  assert.ok(!code.includes('"draft"'), "only the robot's published copies are baked");
  // The published copy is bound against the registry like a fixed playbook.
  assert.ok(code.includes('"workday__get_pto_balance"'));
  assert.ok(code.includes('http://localhost/mockstack/index.php/workday'));
  // The node: from input, its exits and their children.
  assert.ok(code.includes('"source": "input",'));
  assert.ok(code.includes('"input_field": "playbook",'));
  assert.ok(code.includes('"published": PUBLISHED_PLAYBOOKS,'));
  assert.ok(code.includes('"exits": ["done","failed"],'));
  assert.ok(code.includes('"exit_targets": {"done":["3"],"failed":["4"]},'));
  assert.ok(code.indexOf('PUBLISHED_PLAYBOOKS = {') < code.indexOf('PLAYBOOKS = {' + '\n' + '    # '));
  // A --watch run is unattended (per run, not process-wide) unless PLAYBOOK_GATE_MODE says otherwise.
  assert.ok(code.includes('loop_mode=mode != "once", unattended=mode == "watch")'));
  assert.ok(code.includes('            graph.unattended = unattended'));
  assert.ok(!code.includes('os.environ["PLAYBOOK_GATE_MODE"] ='));
  const [rc, out] = pyCompiles(code);
  assert.equal(rc, 0, out);
});

test('testUnbakeablePublishedPlaybookIsAWarning', { skip: noPy }, async () => {
  const statements = [...robotPdo(), insPlaybook(7, 'broken', 'Broken', '')];
  const code = await generate(fromInputGraph(), '3', statements);
  assert.match(code, /^# WARNING: published playbook "broken" not baked: [^\n]+$/m);
  assert.ok(code.includes('    "test": {'));
  const [rc, out] = pyCompiles(code);
  assert.equal(rc, 0, out);
});

test('testModularListenRunsAreUnattendedPerRun', async () => {
  const code = await generate(fromInputGraph(), '3', robotPdo(), 'langgraph', { modular: true });
  assert.ok(code.includes('run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True, unattended=True)'));
  assert.ok(code.includes('loop_mode=mode != "once", unattended=mode == "watch")'));
  assert.ok(!code.includes('os.environ["PLAYBOOK_GATE_MODE"] ='));
});

function playbookGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'I want to take some vacations' } },
      {
        id: '2',
        node_type: 'playbook',
        config: { type: 'playbook', name: 'Playbook HR', playbook: PLAYBOOK, agent_provider: 'deepseek', model: 'deepseek-flash', writes_enabled: true },
      },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2' },
      { from: '2', to: '3' },
    ],
  };
}

/** A fixed playbook with exits; failedWired adds an edge leaving its failed port (output_2). */
function fixedExitsGraph(failedWired: boolean): any {
  const g = playbookGraph();
  g.nodes[1].config.exits = ['done', 'failed'];
  g.edges[1].from_port = 'output_1';
  if (failedWired) {
    g.nodes.push({ id: '4', node_type: 'output', config: { type: 'output' } });
    g.edges.push({ from: '2', to: '4', from_port: 'output_2' });
  }
  return g;
}

/**
 * The TypeScript ports of the other compile targets. ADKGenerator.ts and MAFGenerator.ts are the faithful ports of
 * their PHP generators (they route playbook nodes through PlaybookEmit and refuse "from input" / a wired "failed"
 * exit); NOOAGenerator.ts refuses both, as PHP's does.
 */
const OTHER_TARGETS: Array<[string, string | false]> = [
  ['adk', false],   // ADKGenerator.ts is the faithful port (refuses through PlaybookEmit, as PHP)
  ['maf', false],   // MAFGenerator.ts is the faithful port (refuses through PlaybookEmit, as PHP)
  ['nooa', false],
];

test('testWiredFailedExitRefusedOnOtherTargets', async (t) => {
  for (const [target, skip] of OTHER_TARGETS) {
    await t.test(target, { skip }, async () => {
      await assert.rejects(generate(fixedExitsGraph(true), '3', null, target), (e: any) => {
        assert.equal(e?.message, 'Playbook node "Playbook HR": the "failed" exit is supported by the LangGraph target only.', target);
        return true;
      }, `${target} compiled a wired failed exit`);
      // Only "done" wired: compiles as before.
      assert.notEqual(await generate(fixedExitsGraph(false), '3', null, target), '', target);
    });
  }
  // LangGraph routes it.
  assert.ok((await generate(fixedExitsGraph(true))).includes('"exit_targets": {"done":["3"],"failed":["4"]},'));
});

test('testFromInputWithoutRobotBakesAnEmptyDict', { skip: noPy }, async () => {
  const statements = [...robotPdo(), "DELETE FROM users WHERE kind = 'service'"];
  const code = await generate(fromInputGraph(), '3', statements);
  assert.ok(code.includes('PUBLISHED_PLAYBOOKS = {}'));
  const [rc, out] = pyCompiles(code);
  assert.equal(rc, 0, out);
});

test('testPublishedPlaybooksOmittedWithoutFromInputNodes', async () => {
  const code = await generate(playbookGraph());
  assert.ok(!code.includes('PUBLISHED_PLAYBOOKS = '));
  assert.ok(!code.includes('"exit_targets": {'));
});

test('testFromInputModularModuleBakesPublishedPlaybooks', async () => {
  const code = await generate(fromInputGraph(), '3', robotPdo(), 'langgraph', { modular: true });
  assert.match(code, /PUBLISHED_PLAYBOOKS = \{\n {4}"test": \{[\s\S]*?\nNODE = \{[\s\S]*?"published": PUBLISHED_PLAYBOOKS,/);
});

test('testFromInputRefusedOnA2A', async () => {
  await assert.rejects(generate(fromInputGraph(), '3', robotPdo(), 'langgraph', { a2a: true }), (e: any) => {
    assert.ok(String(e?.message).includes('A2A'), String(e?.message));
    return true;
  });
});

test('testFromInputRefusedOnOtherTargets', async (t) => {
  for (const [target, skip] of OTHER_TARGETS) {
    await t.test(target, { skip }, async () => {
      await assert.rejects(generate(fromInputGraph(), '3', robotPdo(), target), (e: any) => {
        assert.equal(e?.message, 'Playbook node "Run job playbook": "from input" is supported by the LangGraph target only.', target);
        return true;
      }, `${target} compiled a from-input playbook node`);
    });
  }
});

function dispatcherGraph(): any {
  const agent = (name: string, type = 'standard') => ({
    type: 'agent-template', agent_name: name, agent_type: type, instructions: `You are ${name}.`, agent_provider: 'claude', tools: [],
  });
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', node_type: '', config: agent('techBuddy', 'dispatcher') },
      { id: '3', node_type: '', config: agent('IT claims') },
      { id: '4', node_type: '', config: agent('Human resources') },
      { id: '5', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2' },
      { from: '2', to: '3' },
      { from: '2', to: '4' },
      { from: '3', to: '5' },
      { from: '4', to: '5' },
    ],
  };
}

test('testPlaybookNodeBindsActionsAgainstUserRegistry', async () => {
  const code = await generate(playbookGraph());
  assert.ok(code.includes('PLAYBOOKS = {'));
  assert.ok(code.includes('"2": "playbook"'), 'NODE_TYPES carries the playbook type');
  // Bound MCP actions keep the runtime's llm tool naming (server__tool).
  assert.ok(code.includes('"workday__get_pto_balance"'));
  assert.ok(code.includes('"workday__submit_time_off"'));
  assert.ok(code.includes('"action_name": "#Get PTO Balance"'));
  // Unbound action becomes a stub the model can call (on_unbound policy).
  assert.ok(code.includes('"unbound__frobnicate"'));
  // Native verbs are not baked as MCP actions.
  assert.ok(!code.includes('"#Request Approval"'));
  // Node settings.
  assert.ok(code.includes('"provider": "deepseek"'));
  assert.ok(code.includes('"model": "deepseek-flash"'));
  // deepseek-flash (the renamed deepseek-v4-flash) keeps the V4 thinking rules.
  assert.ok(code.includes('if model.startswith(("deepseek-v4", "deepseek-flash")):'));
  assert.ok(code.includes('"writes_enabled": True'));
  assert.ok(code.includes('"display": "Playbook HR"'));
  // Title and the instructions travel verbatim.
  assert.ok(code.includes('"title": "Time Off & Leave"'));
  assert.ok(code.includes('1. #Get PTO Balance for the requester.'));
  // The user's own MCP server is baked into the registry (not only global ones).
  assert.ok(code.includes('http://localhost/mockstack/index.php/workday'));
});

test('testPlaybookRuntimeEmitted', async () => {
  const code = await generate(playbookGraph());
  for (const needle of [
    'class PlaybookToolset:', '    def transcript(self, title: str, final: str) -> str:', '    def gate(self',
    'case NodeKind.PLAYBOOK:', 'PLAYBOOK_SYSTEM_PROMPT', 'writes disabled by policy',
    '"resolve_request"', '"request_approval"', '"prompt_handoff"',
  ]) {
    assert.ok(code.includes(needle), `missing: ${needle}`);
  }
  // Playbook nodes get their own Node (and so their own LLM) like agents do.
  assert.ok(code.includes('NODES = {nid: make_node(cfg) for nid, cfg in {**AGENTS, **PLAYBOOKS, **CODE_NODES}.items()}'));
});

test('testPlaybookRuntimeOmittedWithoutPlaybookNodes', async () => {
  const code = await generate(dispatcherGraph());
  assert.ok(code.includes('PLAYBOOKS = {}'));
  assert.ok(!code.includes('class PlaybookToolset:'));
});

test('testDispatcherAgentGetsRouteMenuAndConditionalEdge', async () => {
  const code = await generate(dispatcherGraph());
  assert.ok(code.includes('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]'));
  assert.ok(code.includes('## Routing'), 'dispatcher prompt carries the routing block');
  assert.ok(code.includes('  - IT claims'));
  assert.ok(code.includes('## Routed request'), 'children carry the routed-to fragment');
  assert.equal(substrCount(code, '## Routed request'), 2, 'both menu children are routed-to');
  assert.ok(code.includes('The dispatcher "techBuddy" reviewed this request'));
  assert.ok(code.includes('add_conditional_edges'));
  assert.ok(code.includes('"route_to"'));
  assert.ok(code.includes('routes: Annotated[dict[str, str], _merge]'));
});

test('testNonDispatcherAgentHasNoDispatchEntry', async () => {
  const code = await generate(dispatcherGraph());
  assert.equal(substrCount(code, '"dispatch": [{'), 1, 'only the dispatcher carries a menu');
});

test('testEmittedScriptIsValidPython', { skip: noPy }, async () => {
  for (const graph of [playbookGraph(), dispatcherGraph()]) {
    const code = await generate(graph);
    const [rc, out] = pyCompiles(code);
    assert.equal(rc, 0, out);
  }
});
