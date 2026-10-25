import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { installFakeDb } from './support/fakeDb';
import { decisionHandler, decisionTables, routerRow, fakeHttp, jevAnswer } from './support/decisionDb';
import { makeRunnerHarness } from './support/runnerHarness';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { DecisionUsage } from '../src/Services/DecisionUsage';
import { JevRouter } from '../src/AgentTeam/JevRouter';
import { DEFAULT_CONFIDENCE_FLOOR } from '../src/AgentTeam/DecisionRouter';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Twin of backend/tests/Unit/GraphWorkflowRunnerRoutingModeTest.php. The interpreter's dispatcher
 * honours settings.routing_mode:
 *   a provider key (e.g. 'jev') = that decision provider only (the model is never called; no
 *     decision, or an unknown provider = "did not route"),
 *   'llm' = model only (no decision provider is consulted),
 *   unset = the first decision provider the user's plan allows, else the model.
 * There is no hybrid: a decline never falls back to the model or another provider.
 * The key is the stored one (user row wins over the global row), never .env.
 */

const SECRET = 'routing-mode-test-secret';
const USER_ID = 7;

/** A model that answers route_to(Sales) — or must never be called. */
function agentRunner(expectCall: boolean) {
  const calls: any[] = [];
  return {
    calls,
    run: async (...a: any[]) => {
      if (!expectCall) throw new Error('the model must not be called');
      calls.push(a);
      if (calls.length > 1) throw new Error('the model is called once');
      return {
        success: true,
        pending_client_tool_call: true,
        pending_tool_calls: [{ name: 'route_to', input: { target: 'Sales', notes: 'model chose' } }],
        usage: { input_tokens: 1000, output_tokens: 20 },
      };
    },
  };
}

/** Replaces the decision transport with canned answers and records how the router was built. */
function instrument(runner: any, queue: any[]) {
  const rec = { made: 0, madeWithKey: null as string | null, madeWithFloor: null as number | null, madeFor: '', recorded: [] as any[] };
  runner.makeDecisionRouter = (resolved: any, floor: number) => {
    rec.made++;
    rec.madeWithKey = resolved.key;
    rec.madeWithFloor = floor;
    rec.madeFor = String(resolved.row?.provider_key ?? '');
    return new JevRouter(resolved.key !== '' ? resolved.key : null, fakeHttp(queue).http, floor);
  };
  // Production's filter (DecisionUsage.record), with the database write replaced by a list.
  runner.recordDecisionUsage = async (userId: number, providerKey: string, model: string, out: any) => {
    await DecisionUsage.record(async (tx) => (rec.recorded.push({ user_id: tx.user_id, provider: tx.provider, ...out }), 1), userId, providerKey, model, out);
  };
  return rec;
}

function makeRunner(userKey: string, globalKey: string, model: any, queue: any[], jevEnabled = true, jevPrices: [number | null, number | null] = [0.042, 0.0]) {
  const t = decisionTables({
    users: { [USER_ID]: 'user' },
    packages: { user: { providers: { jev: { enabled: jevEnabled }, acme: { enabled: jevEnabled } } } },
    settings: [
      routerRow('acme', 'acme-global', { display_name: 'Acme', model: 'acme-1', sort_order: 200 }),
      routerRow('jev', globalKey, { display_name: 'Jev', sort_order: 100 }),
    ],
    userKeys: userKey !== '' ? [{ user_id: USER_ID, provider: 'jev', api_key: ApiKeyCrypto.encrypt(userKey, SECRET) }] : [],
    prices: { jev: jevPrices },
  });
  installFakeDb(decisionHandler(t));
  const runner: any = new GraphWorkflowRunner({ auth: { jwt_secret: SECRET }, workflow_runs_dir: os.tmpdir() });
  runner.agentRunner = model;
  runner.workflowName = 'Support desk';
  runner.graphNodes = {
    1: { id: 1, node_type: 'agent', config: {} },
    2: { id: 2, node_type: 'agent', config: { agent_name: 'Billing' } },
    3: { id: 3, node_type: 'agent', config: { agent_name: 'Sales' } },
  };
  runner.emitNodeEvent = () => {}; // no run id: nothing to persist
  return { runner, rec: instrument(runner, queue) };
}

async function dispatch(runner: any, settings: Record<string, any> | null) {
  const node = {
    id: 1, node_type: 'agent', agent_id: null,
    config: {
      agent_name: 'Router', agent_type: 'dispatcher', provider: 'openai', model: 'gpt-test',
      instructions: 'Send the request to the right team.', tools: [], settings: settings ?? [],
    },
  };
  const edges = [{ from_node_id: 1, to_node_id: 2 }, { from_node_id: 1, to_node_id: 3 }];
  return runner.executeAgentNode(node, USER_ID, 'I was charged twice.', edges, []);
}

// ── Jev mode: Jev only ───────────────────────────────────────────────────────

test('jev mode routed never calls the model', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.99)]);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, true);
  assert.equal(out.provider, 'jev');
  assert.equal(out.route.name, 'Billing');
  assert.deepEqual(out.usage, { input_tokens: 342, output_tokens: 39 });
  assert.equal(rec.madeWithKey, 'global-jev-key');
});

test('jev mode unclear stops with did not route', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer(JevRouter.UNCLEAR, 1.0)]);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, true, 'no branch fits: a normal ending, not an error');
  assert.equal(out.provider, 'jev');
  assert.ok(!('route' in out));
  assert.equal(out.output, 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).');
  assert.deepEqual(out.usage, { input_tokens: 342, output_tokens: 39 });
});

test('jev mode low confidence stops with did not route', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Sales', 0.46)]);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, true);
  assert.equal(out.output, 'Not classified: dispatcher "Router" did not route the request (jev: low_confidence: confidence 0.46 below floor 0.60).');
});

test('jev mode unclear goes to the unclear branch', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer(JevRouter.UNCLEAR, 0.7)]);
  const out = await dispatch(runner, { routing_mode: 'jev', unclear_branch: 'Sales' });
  assert.equal(out.success, true);
  assert.equal(out.route.name, 'Sales');
  assert.ok(!('halt_branches' in out));
});

test('jev mode low confidence goes to the unclear branch', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.46)]);
  const out = await dispatch(runner, { routing_mode: 'jev', unclear_branch: 'Sales' });
  assert.equal(out.route.name, 'Sales');
});

test('an unclear branch no longer on the menu stops', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer(JevRouter.UNCLEAR, 1.0)]);
  const out = await dispatch(runner, { routing_mode: 'jev', unclear_branch: 'Deleted branch' });
  assert.ok(!('route' in out));
  assert.equal(out.halt_branches, true);
});

test('a missing key ignores the unclear branch', async () => {
  const { runner } = makeRunner('', '', agentRunner(false), []);
  const out = await dispatch(runner, { routing_mode: 'jev', unclear_branch: 'Sales' });
  assert.equal(out.success, false);
  assert.ok(!('route' in out));
  assert.ok(out.output.startsWith('Error: '));
});

test('jev mode without a key stops with did not route and zero usage', async () => {
  const { runner } = makeRunner('', '', agentRunner(false), []);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, false);
  assert.equal(out.provider, 'jev');
  assert.equal(out.output, 'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).');
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
});

test("jev mode uses the user's own key", async () => {
  const { runner, rec } = makeRunner('personal-jev-key', '', agentRunner(false), [jevAnswer('Billing', 0.99)]);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, true);
  assert.equal(out.route.name, 'Billing');
  assert.equal(rec.madeWithKey, 'personal-jev-key');
});

// ── LLM mode: model only ─────────────────────────────────────────────────────

test('llm mode never consults Jev, even with a key', async () => {
  const model = agentRunner(true);
  const { runner, rec } = makeRunner('', 'global-jev-key', model, [jevAnswer('Billing', 0.99)]);
  const out = await dispatch(runner, { routing_mode: 'llm' });
  assert.equal(out.success, true);
  assert.equal(out.provider, 'openai');
  assert.equal(out.route.name, 'Sales');
  assert.equal(out.output, 'I was charged twice.\n\n## Dispatcher notes\nmodel chose');
  assert.equal(rec.made, 0, 'LLM mode must not build a Jev router');
  // route_to is declared and forced; the routing rules are in the instructions.
  const [agent, , , , runContext] = model.calls[0];
  assert.equal(runContext.extra_tools.at(-1).name, 'route_to');
  assert.deepEqual(runContext.tool_choice, { type: 'function', function: { name: 'route_to' } });
  assert.ok(agent.instructions.includes('## Routing'));
});

test('llm mode without a key uses the model', async () => {
  const { runner, rec } = makeRunner('', '', agentRunner(true), []);
  const out = await dispatch(runner, { routing_mode: 'llm' });
  assert.equal(out.route.name, 'Sales');
  assert.equal(rec.made, 0);
});

// ── No mode saved: Jev when the plan allows it, else the model ───────────────

test('unset mode, allowed: routes with Jev', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.99)]);
  const out = await dispatch(runner, null);
  assert.equal(out.success, true);
  assert.equal(out.provider, 'jev');
  assert.equal(out.route.name, 'Billing');
});

test('unset mode, allowed: unclear stops with did not route and never calls the model', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer(JevRouter.UNCLEAR, 1.0)]);
  const out = await dispatch(runner, {});
  assert.equal(out.success, true);
  assert.equal(out.provider, 'jev');
  assert.ok(!('route' in out));
  assert.equal(out.halt_branches, true);
  assert.equal(out.output, 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).');
});

test('unset mode, allowed, without a key: stops with did not route', async () => {
  const { runner } = makeRunner('', '', agentRunner(false), []);
  const out = await dispatch(runner, null);
  assert.equal(out.success, false);
  assert.equal(out.provider, 'jev');
  assert.equal(out.halt_branches, true);
  assert.equal(out.output, 'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).');
});

test('a node naming a deleted provider halts', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), []);
  const out = await dispatch(runner, { routing_mode: 'banana' });
  assert.equal(out.success, false);
  assert.equal(out.halt_branches, true);
  assert.equal(out.provider, 'banana');
  assert.equal(rec.made, 0, 'nothing to build for an unknown provider');
  assert.equal(out.output, "Error: dispatcher \"Router\" did not route the request (banana: unavailable: 'banana' is not an available decision provider).");
});

test('each node uses its own provider', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Sales', 0.99)]);
  const out = await dispatch(runner, { routing_mode: 'acme' });
  assert.equal(out.success, true);
  assert.equal(out.provider, 'acme');
  assert.equal(rec.madeFor, 'acme');
  assert.equal(rec.madeWithKey, 'acme-global');
  assert.equal(rec.recorded[0].provider, 'acme');
});

test('min_confidence wins over the legacy setting', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Sales', 0.99)]);
  await dispatch(runner, { routing_mode: 'jev', min_confidence: 0.8, jev_min_confidence: 0.3 });
  assert.equal(rec.madeWithFloor, 0.8);
});

// ── Minimum confidence ───────────────────────────────────────────────────────

const floors: Array<[string, any, number]> = [
  ['absent', null, DEFAULT_CONFIDENCE_FLOOR],
  ['numeric', 0.3, 0.3],
  ['string', '0.75', 0.75],
  ['above one', 1.7, 1.0],
  ['below zero', -2, 0.0],
  ['not numeric', 'abc', DEFAULT_CONFIDENCE_FLOOR],
];
for (const [label, setting, expected] of floors) {
  test(`the minimum confidence is the clamped floor (${label})`, async () => {
    const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.99)]);
    const settings: Record<string, any> = { routing_mode: 'jev' };
    if (setting !== null) settings.jev_min_confidence = setting;
    await dispatch(runner, settings);
    assert.equal(rec.madeWithFloor, expected);
  });
}

test('a lower floor lets a divided answer route', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Sales', 0.46)]);
  const out = await dispatch(runner, { routing_mode: 'jev', jev_min_confidence: 0.4 });
  assert.equal(out.success, true);
  assert.equal(out.route.name, 'Sales');
});

// ── Run level: what happens to the branches ──────────────────────────────────

/**
 * A whole run() over Start -> Router (dispatcher) -> Billing | Sales -> Output. The children are
 * disabled nodes: if the traversal reaches them they record the 'disabled node' sentinel (and never
 * call a model), so their presence in node_outputs is proof they ran.
 */
async function runWorkflow(settings: Record<string, any> | null, globalKey: string, queue: any[], model: any) {
  const child = (id: number, name: string) => ({
    id, node_type: 'agent', agent_id: null,
    config: { agent_name: name, instructions: `You are ${name}.`, provider: 'openai', tools: [], disabled: true },
  });
  const nodes = [
    { id: 10, node_type: 'start', agent_id: null, config: {} },
    { id: 1, node_type: 'agent', agent_id: null, config: {
      agent_name: 'Router', agent_type: 'dispatcher', provider: 'openai', model: 'gpt-test',
      instructions: 'Send the request to the right team.', tools: [], settings: settings ?? [],
    } },
    child(2, 'Billing'),
    child(3, 'Sales'),
    { id: 4, node_type: 'output', agent_id: null, config: {} },
  ];
  const edges = [
    { from_node_id: 10, to_node_id: 1 }, { from_node_id: 1, to_node_id: 2 }, { from_node_id: 1, to_node_id: 3 },
    { from_node_id: 2, to_node_id: 4 }, { from_node_id: 3, to_node_id: 4 },
  ];
  // The guest package (userId 0) enables Jev; the jev row holds the global key.
  const t = decisionTables({
    packages: { guest: { providers: { jev: { enabled: true } } } },
    settings: [routerRow('jev', globalKey, { display_name: 'Jev' })],
  });
  const h = makeRunnerHarness({ nodes, edges, config: { auth: { jwt_secret: SECRET } }, agentRunner: model, extra: decisionHandler(t) });
  instrument(h.runner, queue);
  try {
    // userId 0: no per-user key lookup and no conversation archive.
    return await h.runner.run({ id: 5, name: 'Support desk' }, 0, { prompt: 'I was charged twice.' });
  } finally {
    h.cleanup();
  }
}

const declines: Array<[string, string, any[], string]> = [
  ['unclear', 'global-jev-key', [jevAnswer(JevRouter.UNCLEAR, 1.0)], 'unclear: the request names no branch'],
  ['no key', '', [], 'unavailable: no Jev key'],
];
for (const [label, key, queue, why] of declines) {
  test(`a jev-only dispatcher that does not route stops its branches (${label})`, async () => {
    const out = await runWorkflow({ routing_mode: 'jev' }, key, queue, agentRunner(false));
    // A request no branch fits ends normally; a missing key is an error.
    const notClassified = why.startsWith('unclear');
    const message = `${notClassified ? 'Not classified' : 'Error'}: dispatcher "Router" did not route the request (jev: ${why}).`;
    assert.equal(out.success, true, out.error);
    assert.ok(!(2 in out.node_outputs), 'Billing must not run');
    assert.ok(!(3 in out.node_outputs), 'Sales must not run');
    assert.ok(!(4 in out.node_outputs), 'nothing downstream of the branches runs');
    assert.equal(out.node_outputs[1].success, notClassified);
    assert.equal(out.node_outputs[1].output, message);
    assert.equal(out.output, message, 'the run ends with the did-not-route result');
  });
}

test('an unset dispatcher that Jev does not route stops its branches', async () => {
  const out = await runWorkflow(null, 'global-jev-key', [jevAnswer(JevRouter.UNCLEAR, 1.0)], agentRunner(false));
  assert.ok(!(2 in out.node_outputs) && !(3 in out.node_outputs));
  assert.equal(out.output, 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).');
});

test('a routed dispatcher runs only the chosen branch, and the run ends at the Output', async () => {
  const out = await runWorkflow({ routing_mode: 'jev' }, 'global-jev-key', [jevAnswer('Sales', 0.99)], agentRunner(false));
  assert.equal(out.success, true, out.error);
  assert.ok(!(2 in out.node_outputs), 'Billing skipped');
  assert.equal(out.node_outputs[3].output, 'disabled node', 'Sales ran');
  assert.equal(out.output, 'disabled node');
});

test("an LLM dispatcher that does not route keeps today's fan-out", async () => {
  const model = {
    run: async () => ({ success: true, text: 'Some prose, no route_to.', usage: { input_tokens: 10, output_tokens: 5 } }),
  };
  const out = await runWorkflow({ routing_mode: 'llm' }, '', [], model);
  assert.equal(out.node_outputs[1].success, false);
  assert.ok(out.node_outputs[1].output.includes('did not route the request. Expected a route_to call'));
  assert.equal(out.node_outputs[2].output, 'disabled node', 'Billing still runs (unchanged)');
  assert.equal(out.node_outputs[3].output, 'disabled node', 'Sales still runs (unchanged)');
});

// ── Usage recording ──────────────────────────────────────────────────────────

test('a jev-routed step is recorded once and priced from the row', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.99)]);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.route.name, 'Billing');
  assert.equal(rec.recorded.length, 1);
  assert.equal(rec.recorded[0].user_id, USER_ID);
  assert.equal(rec.recorded[0].outcome, 'routed');
  assert.deepEqual(rec.recorded[0].usage, { input_tokens: 342, output_tokens: 39 });
  const cost = await runner.computeNodeCost('jev', 1_000_000, 10);
  assert.ok(Math.abs(cost - 0.042) < 1e-9);
});

test('an unset decline is recorded once and the model never runs', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(false), [jevAnswer(JevRouter.UNCLEAR, 1.0)]);
  const out = await dispatch(runner, null);
  assert.equal(out.provider, 'jev');
  assert.equal(rec.recorded.length, 1);
  assert.equal(rec.recorded[0].outcome, 'unclear');
});

test('jev mode not allowed stops with the plan reason and records nothing', async () => {
  // The user's own key does not bypass the plan.
  const { runner, rec } = makeRunner('personal-jev-key', 'global-jev-key', agentRunner(false), [jevAnswer('Billing', 0.99)], false);
  const out = await dispatch(runner, { routing_mode: 'jev' });
  assert.equal(out.success, false);
  assert.ok(out.output.includes('(jev: unavailable: Jev is not enabled for your plan).'));
  assert.equal(out.halt_branches, true);
  assert.deepEqual(rec.recorded, [], 'a call that was never sent records nothing');
});

test('jev mode without a key records nothing', async () => {
  const { runner, rec } = makeRunner('', '', agentRunner(false), []);
  await dispatch(runner, { routing_mode: 'jev' });
  assert.deepEqual(rec.recorded, []);
});

test('unset mode, not allowed: goes to the model', async () => {
  const { runner, rec } = makeRunner('', 'global-jev-key', agentRunner(true), [jevAnswer('Billing', 0.99)], false);
  const out = await dispatch(runner, null);
  assert.equal(out.success, true);
  assert.equal(out.provider, 'openai');
  assert.equal(out.route.name, 'Sales');
  assert.deepEqual(rec.recorded, []);
  assert.equal(rec.made, 0, 'not allowed: the Jev router is never built');
});

test('a jev row installed before prices existed: unknown cost, never a fake $0', async () => {
  const { runner } = makeRunner('', 'global-jev-key', agentRunner(false), [], true, [null, null]);
  assert.equal(await runner.computeNodeCost('jev', 100, 0), null);
});

test('a routed child is told who routed it, and a blank node gets a role prompt', async () => {
  const seen: any[] = [];
  const { runner } = makeRunner('', '', { run: async (agent: any) => (seen.push(agent), { success: true, text: 'done' }) }, []);
  runner.nodeOutputs = { 1: { agent_name: 'Router', route: { id: 3, name: 'Sales', notes: 'upgrade' } } };
  const node = { id: 3, node_type: 'agent', agent_id: null, config: { agent_name: 'Sales', provider: 'openai', skill_content: ' ' , tools: [] } };
  const out = await runner.executeAgentNode(node, USER_ID, 'go', [{ from_node_id: 1, to_node_id: 3 }], [1]);
  assert.equal(out.output, 'done');
  assert.ok(seen[0].instructions.includes('## Routed request'));
  assert.ok(seen[0].instructions.includes('Notes from the dispatcher: upgrade'));
});
