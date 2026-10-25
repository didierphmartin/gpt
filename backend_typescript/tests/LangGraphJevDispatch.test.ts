/**
 * Port of backend/tests/Unit/LangGraphJevDispatchTest.php. LangGraph compiler: a dispatcher routes with a decision
 * model (a provider row, e.g. TypeSafe's Jev) or with the model, never both, the same way GraphWorkflowRunner does.
 * Checked in every LangGraph mode that runs a dispatcher (single script, modular package, A2A agent server), and the
 * emitted runtime itself is exercised by backend/tests/fixtures/jev_dispatch_harness.py with a fake HTTP layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DispatchRouting } from '../src/AgentTeam/DispatchRouting';
import { LangGraphGenerator } from '../src/AgentTeam/LangGraphGenerator';
import { PHP_FIXTURES, a2aSql, execPy, lgFiles, lgGenerator, pyCompile, python3 } from './support/lgFixtures';

const noPy = python3() === null ? 'python3 not available' : false;

const BLOCK_START = '# Decision-model routing (twin of DecisionProtocols.php';
const BLOCK_END = '        return RouteDecision(text=text, route=chosen["id"], notes=notes, status="ok")';
const NODE_START = 'class Node(ABC):';
const NODE_END = '            raise ValueError(f"unknown node kind: {cfg[\'kind\']!r}")';

function graph(): any {
  const agent = (name: string, type = 'standard', extra: Record<string, any> = {}) => ({
    type: 'agent-template', agent_name: name, agent_type: type, instructions: `You are ${name}.`, agent_provider: 'claude',
    model: 'claude-sonnet-4-5', tools: [], settings: { temperature: 0.7, max_tokens: 4096 }, ...extra,
  });
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'My laptop will not boot' } },
      { id: '2', node_type: '', config: agent('techBuddy', 'dispatcher', { description: 'the front desk' }) },
      { id: '3', node_type: '', config: agent('IT claims', 'standard', { description: 'Laptops and VPN.' }) },
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

/** generatorWithPdo(): agentRecord is what the mocked AgentRepository::findById returns (an Agent's toArray(), or null). */
function generatorWithPdo(sqlStatements: string[], g: any, agentRecord: any = null): LangGraphGenerator {
  return lgGenerator({
    sql: sqlStatements,
    workflow: { id: 44, name: 'Dispatcher demo', user_id: '3' },
    graph: g,
    agents: () => agentRecord,
    rawAgents: true,
  });
}

function generator(g: any = null, agentRecord: any = null): LangGraphGenerator {
  return generatorWithPdo(a2aSql(), g ?? graph(), agentRecord);
}

/** mode => [runtime file (carries dispatcherBlock), node file (carries the dispatcher's data)] */
async function modes(): Promise<Record<string, [string, string]>> {
  const gen = generator();
  const single = ((await gen.generate(44, '3')) as any)['code'];
  const mod = lgFiles(await gen.generate(44, '3', { modular: true }));
  const a2a = lgFiles(await gen.generate(44, '3', { a2a: true }));
  return {
    single: [single, single],
    modular: [mod['common.py'] ?? '', mod['agents/techbuddy.py'] ?? ''],
    a2a: [a2a['agents/2_techbuddy.py'] ?? '', a2a['agents/2_techbuddy.py'] ?? ''],
  };
}

test('testEveryModeEmitsTheJevFastPathAndItsData', async () => {
  // What the interpreter asks Jev for this dispatcher.
  const question = DispatchRouting.defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo');
  assert.equal(
    question,
    'You are "techBuddy", the front desk, an agent in the workflow "Dispatcher demo". ' +
      'Handle the request you receive directly and completely, in the role your name implies.',
  );
  for (const [mode, [runtime, node]] of Object.entries(await modes())) {
    assert.notEqual(runtime, '', `${mode}: runtime file missing`);
    for (const needle of [
      '    def route(self, request: str, targets: list[dict], question: str, floor: float = CONFIDENCE_FLOOR) -> DecisionResult:',
      '    URL = "https://api.typesafe.ai/v1/systemone"', '    MODEL = "jev-latest"', '    CONFIDENCE_FLOOR = 0.6', '    TIMEOUT_S = 10',
      '    LEGACY_KEY_ENV = "TYPESAFE_API_KEY"', 'DECISION_ADAPTERS = {"typesafe": JevRouter}',
      '        match self.cfg.get("routing_mode", ""):', '        match self.mode():',
      'self.cfg.get("decision_question", "")',
      'ctx.load_verify_locations(certifi.where())',
      "{key} routed to {chosen['name']!r}", 'decision-model dispatcher, no model fallback',
    ]) {
      assert.ok(runtime.includes(needle), `${mode}: ${needle}`);
    }
    // No hybrid: a Jev decline never falls through to the model.
    assert.ok(!runtime.includes('asking the model'), `${mode}: no hybrid`);
    assert.ok(!runtime.includes('Jev declined'), `${mode}: no hybrid`);
    // The Jev path returns BEFORE the forced route_to turn.
    assert.ok(
      runtime.indexOf('return await self._via_decision(key, task)') <
        runtime.indexOf('llm = make_llm().bind_tools([self._route_tool()], tool_choice="any")'),
      `${mode}: the mode is decided first`,
    );
    // techBuddy has no routing_mode saved: '' (resolved at run time), at the default floor.
    assert.ok(node.includes('"routing_mode": "",'), `${mode}: routing_mode`);
    assert.ok(node.includes('"min_confidence": 0.6,'), `${mode}: floor`);
    // Unset: every usable decision provider, in admin order, with its env names.
    assert.ok(
      node.includes(
        '"decision": [{"provider": "jev", "protocol": "typesafe", "url": "https://api.typesafe.ai/v1/systemone", ' +
          '"model": "jev-latest", "key_env": "JEV_API_KEY", "url_env": "JEV_BASE_URL"}],',
      ),
      `${mode}: decision`,
    );
    // Target descriptions mirror the interpreter: DispatchRouting::targets() carries none.
    assert.ok(
      node.includes('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]'),
      `${mode}: menu`,
    );
    assert.ok(node.includes('"decision_question": ' + JSON.stringify(question) + ','), `${mode}: question`);
    assert.ok(node.includes('# Optional: JEV_API_KEY for dispatchers'), `${mode}: TO RUN note`);
  }
});

/** The dispatcher's routing data as every mode emits it: [routing_mode literal, floor literal]. */
async function routingData(g: any, agentRecord: any = null): Promise<Record<string, [string | null, string | null]>> {
  const gen = generator(g, agentRecord);
  const files: Record<string, string> = {
    single: ((await gen.generate(44, '3')) as any)['code'],
    modular: lgFiles(await gen.generate(44, '3', { modular: true }))['agents/techbuddy.py'] ?? '',
    a2a: lgFiles(await gen.generate(44, '3', { a2a: true }))['agents/2_techbuddy.py'] ?? '',
  };
  const got: Record<string, [string | null, string | null]> = {};
  for (const [mode, code] of Object.entries(files)) {
    assert.match(code, /"routing_mode": "[a-z-]*",/, `${mode}: routing_mode`);
    const m1 = /"routing_mode": ("[a-z-]*"),/.exec(code);
    const m2 = /"min_confidence": ([0-9.]+),/.exec(code);
    got[mode] = [m1?.[1] ?? null, m2?.[1] ?? null];
  }
  return got;
}

/** PHP's $settings + $base: the given settings first, then the base keys they do not set. */
function withSettings(settings: Record<string, any>): any {
  const g = graph();
  const base = g.nodes[1].config.settings;
  const merged: Record<string, any> = { ...settings };
  for (const [k, v] of Object.entries(base)) if (!(k in merged)) merged[k] = v;
  g.nodes[1].config.settings = merged;
  return g;
}

test('testRoutingModeAndFloorAreEmittedInEveryMode', async () => {
  // [node settings, expected routing_mode literal, expected floor literal]
  const cases: Array<[Record<string, any>, string, string]> = [
    [{ routing_mode: 'jev', jev_min_confidence: 0.85 }, '"jev"', '0.85'],
    [{ routing_mode: 'llm' }, '"llm"', '0.6'],
    // Any other value names a decision provider (kept verbatim); blank is unset (''), resolved at run time.
    [{ routing_mode: 'bogus' }, '"bogus"', '0.6'],
    [{ routing_mode: ' jev ' }, '"jev"', '0.6'],
    [{ routing_mode: '' }, '""', '0.6'],
    // min_confidence wins over the legacy jev_min_confidence.
    [{ routing_mode: 'jev', min_confidence: 0.8, jev_min_confidence: 0.3 }, '"jev"', '0.8'],
    [{ routing_mode: 'jev', min_confidence: 0.75 }, '"jev"', '0.75'],
    // jev_min_confidence: numeric -> clamped to [0, 1]; otherwise 0.6.
    [{ routing_mode: 'jev', jev_min_confidence: 1.7 }, '"jev"', '1.0'],
    [{ routing_mode: 'jev', jev_min_confidence: -2 }, '"jev"', '0.0'],
    [{ routing_mode: 'jev', jev_min_confidence: '0.7' }, '"jev"', '0.7'],
    [{ routing_mode: 'jev', jev_min_confidence: 'high' }, '"jev"', '0.6'],
    [{ routing_mode: 'jev', jev_min_confidence: null }, '"jev"', '0.6'],
  ];
  for (const [settings, mode, floor] of cases) {
    for (const [m, got] of Object.entries(await routingData(withSettings(settings)))) {
      assert.deepEqual(got, [mode, floor], m + ': ' + JSON.stringify(settings));
    }
  }
});

test('testSavedAgentRecordSettingsDecideTheRoutingMode', async () => {
  // GraphWorkflowRunner reads routing_mode from the saved agent's settings when the node references one.
  const g = withSettings({ routing_mode: 'jev', jev_min_confidence: 0.9 });
  g.nodes[1].config.agent_id = 77;
  const record = (settings: Record<string, any>) => ({
    id: 77, name: 'techBuddy', description: 'the front desk', agent_type: 'dispatcher', instructions: '', provider: 'claude',
    model: 'claude-sonnet-4-5', settings,
  });
  const cases: Array<[Record<string, any>, [string, string]]> = [
    [{ routing_mode: 'llm', jev_min_confidence: 0.75 }, ['"llm"', '0.75']],
    // A record without the setting is unset, whatever the node says.
    [{}, ['""', '0.6']],
  ];
  for (const [settings, want] of cases) {
    for (const [m, got] of Object.entries(await routingData(g, record(settings)))) {
      assert.deepEqual(got, want, m + ': ' + JSON.stringify(settings));
    }
  }
  // A reference whose record is gone falls back to the node config.
  for (const [m, got] of Object.entries(await routingData(g, null))) {
    assert.deepEqual(got, ['"jev"', '0.9'], m);
  }
});

test('testDispatcherWithNoRouteReachesEndInEveryGraph', async () => {
  // A dispatcher result whose route is not a menu id takes the conditional edge to END.
  const gen = generator(withSettings({ routing_mode: 'jev' }));
  const graphs: Record<string, string> = {
    single: ((await gen.generate(44, '3')) as any)['code'],
    modular: lgFiles(await gen.generate(44, '3', { modular: true }))['common.py'] ?? '', // WorkflowGraph lives here
    a2a: lgFiles(await gen.generate(44, '3', { a2a: true }))['orchestrator.py'] ?? '',
  };
  for (const [mode, code] of Object.entries(graphs)) {
    assert.ok(code.includes('return lambda state: state.get("routes", {}).get(nid) or END'), mode);
    assert.ok(code.includes('sg.add_conditional_edges(nid, router, {t: t for t in menu} | {END: END})'), mode);
    assert.ok(code.includes('route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END'), mode);
  }
});

test('testToRunNoteFollowsTheRoutingMode', async () => {
  const doc = async (settings: Record<string, any>) => ((await generator(withSettings(settings)).generate(44, '3')) as any)['code'] as string;
  // Unset: the first decision model whose key is set, else the model -- never both.
  const unset = await doc({});
  assert.ok(unset.includes('# Optional: JEV_API_KEY for dispatchers with no routing mode saved (techBuddy):'));
  assert.ok(unset.includes('#   the first decision model whose key is set routes (else the model); once one is chosen, a request it cannot decide stops the run there (no model fallback).'));
  assert.ok(unset.includes('TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.'));
  assert.ok(!unset.includes('# Required: JEV_API_KEY'));
  // A named provider: required.
  const jev = await doc({ routing_mode: 'jev' });
  assert.ok(jev.includes('# Required: JEV_API_KEY for dispatchers (techBuddy);'));
  assert.ok(!jev.includes('# Optional: JEV_API_KEY'));
  // LLM only: no decision model, so no key is asked for.
  const llm = await doc({ routing_mode: 'llm' });
  assert.ok(!llm.includes('JEV_API_KEY'));
  assert.ok(!llm.includes('TYPESAFE_API_KEY'));
  assert.ok(llm.includes('"decision": [],'));
});

test('testCommonPyProvidesListsTheDecisionRuntime', async () => {
  const common = lgFiles(await generator().generate(44, '3', { modular: true }))['common.py'] ?? '';
  assert.ok(common.includes('  DecisionResult, JevRouter,\n  DECISION_ADAPTERS, RouteDecision,\n  Dispatcher '));
  assert.ok(!common.includes('JevRouter, Dispatcher '));
  for (const def of ['class DecisionResult', 'class JevRouter', 'DECISION_ADAPTERS = {', 'class RouteDecision', 'class Dispatcher']) {
    assert.ok(common.includes(def), 'PROVIDES lists only what is emitted');
  }
});

test('testSavedAgentRecordNamesTheJevQuestion', async () => {
  // A dispatcher that references a saved agent: the compiled question comes from that record.
  const g = graph();
  g.nodes[1].config.agent_id = 77;
  const record = { id: 77, name: 'Front Desk', description: 'routes every ticket', agent_type: 'dispatcher', instructions: '', provider: 'claude', model: 'claude-sonnet-4-5' };
  const blank = { id: 78, name: '', description: '', agent_type: 'dispatcher' };
  const cases: Array<[any, string]> = [
    [record, DispatchRouting.defaultInstructions('Front Desk', 'routes every ticket', 'Dispatcher demo')],
    // A record with no name/description falls back to the node config.
    [blank, DispatchRouting.defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo')],
  ];
  for (const [agent, want] of cases) {
    const code = ((await generator(g, agent).generate(44, '3')) as any)['code'];
    assert.ok(code.includes('"decision_question": ' + JSON.stringify(want) + ','));
  }
});

test('testInterpreterTargetsCarryNoDescription', () => {
  // The premise of the empty "description" above.
  const nodes: Record<number, any> = {
    2: { node_type: 'agent', config: { agent_name: 'A', description: 'role' } },
    3: { node_type: 'agent', config: { agent_name: 'B' } },
  };
  const edges = [
    { from_node_id: 1, to_node_id: 2 },
    { from_node_id: 1, to_node_id: 3 },
  ];
  for (const t of DispatchRouting.targets(1, edges, nodes)) {
    assert.ok(!('description' in (t as any)));
  }
});

function assertCompiles(code: string, label: string): void {
  const r = pyCompile(code);
  assert.equal(r.rc, 0, `${label}: ${r.out.join('\n')}`);
}

test('testEveryModeCompiles', { skip: noPy }, async () => {
  for (const [mode, [runtime, node]] of Object.entries(await modes())) {
    [...new Set([runtime, node])].forEach((code, i) => assertCompiles(code, `${mode}#${i}`));
  }
});

test('testEmittedRuntimeRoutesOrStops', async (t) => {
  const v = python3() === null ? null : execPy('python3', ['-c', 'import sys; assert sys.version_info >= (3, 10)']);
  if (v === null || v.rc !== 0) return t.skip('python3 >= 3.10 not available');
  for (const [mode, [runtime]] of Object.entries(await modes())) {
    // The dispatch block, and the Node classes that run a dispatcher node in every mode, both sliced from the runtime file.
    const a = runtime.indexOf(BLOCK_START);
    const b = runtime.indexOf(BLOCK_END);
    assert.notEqual(a, -1, `${mode}: block start`);
    assert.notEqual(b, -1, `${mode}: block end`);
    const block = runtime.slice(a, b + BLOCK_END.length) + '\n';
    const k = runtime.indexOf(NODE_START);
    const kEnd = runtime.indexOf(NODE_END);
    assert.notEqual(k, -1, `${mode}: Node classes start`);
    assert.notEqual(kEnd, -1, `${mode}: Node classes end`);
    const classes = runtime.slice(k, kEnd + NODE_END.length) + '\n';
    const dir = mkdtempSync(path.join(tmpdir(), 'jev'));
    const base = path.join(dir, 'jev');
    writeFileSync(base + '.py', block);
    writeFileSync(base + '_nodes.py', classes);
    const env = { ...process.env };
    for (const k2 of ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_API_KEY', 'JEV_BASE_URL']) delete env[k2];
    const r = execPy('python3', [path.join(PHP_FIXTURES, 'jev_dispatch_harness.py'), base + '.py', base + '_nodes.py'], { env });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.rc, 0, `${mode}: ${r.out.join('\n')}`);
    assert.equal(r.out[r.out.length - 1], 'OK 29 cases', mode);
  }
});

test('testEachDispatcherCarriesItsProviderAndEnvNames', async () => {
  const sqlStatements = [
    ...a2aSql(),
    `INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order)
            VALUES ('jev-eu', 'Jev EU', 'jev-latest', 'https://gw.corp/jev', 'router', 'typesafe', 1, 50)`,
  ];
  const g = graph();
  g.nodes[1].config.settings.routing_mode = 'jev-eu';
  const code = ((await generatorWithPdo(sqlStatements, g).generate(44)) as any)['code'];
  assert.ok(code.includes('"routing_mode": "jev-eu"'));
  assert.ok(code.includes('"key_env": "JEV_EU_API_KEY"'));
  assert.ok(code.includes('"url": "https://gw.corp/jev"'));
  assert.equal(code.split('class JevRouter').length - 1, 1, 'one adapter per protocol used');
  assert.ok(code.includes('JEV_EU_API_KEY'), 'the TO RUN note names the per-row env var');
});

test('testAnUnsetDispatcherListsEveryProviderInAdminOrder', async () => {
  const sqlStatements = [
    ...a2aSql(),
    `INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order)
            VALUES ('acme', 'Acme', 'jev-latest', NULL, 'router', 'typesafe', 1, 50)`,
  ];
  const code = ((await generatorWithPdo(sqlStatements, graph()).generate(44)) as any)['code'];
  assert.ok(code.indexOf('"provider": "acme"') < code.indexOf('"provider": "jev"'));
});

test('testANodeNamingAMissingProviderCompilesWithNoCandidate', async () => {
  const g = graph();
  g.nodes[1].config.settings.routing_mode = 'gone';
  const code = ((await generator(g).generate(44)) as any)['code'];
  assert.ok(code.includes('"routing_mode": "gone"'));
  assert.ok(code.includes('"decision": []'));
});
