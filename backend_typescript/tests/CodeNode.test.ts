import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installFakeDb } from './support/fakeDb';
import { CodeNodeEmit } from '../src/AgentTeam/CodeNodeEmit';
import { CodeNodeStep } from '../src/AgentTeam/CodeNodeStep';
import { CodeNodeExecutor } from '../src/AgentTeam/CodeNodeExecutor';
import { CodeNodeController } from '../src/Controllers/CodeNodeController';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Twins of backend/tests/Unit/CodeNodeEmitTest.php, CodeNodeStepTest.php, CodeNodeExecutorTest.php
 * (real python3 harness, no MCP server), Controllers/CodeNodeControllerTest.php and
 * GraphWorkflowRunnerUnsupportedNodeTest.php.
 */

// ── CodeNodeEmit ─────────────────────────────────────────────────────────────

const emitNode = (cfg: Record<string, any>) => ({
  id: '5', node_type: 'code',
  config: {
    type: 'code', name: 'Poll', code: "def run(i, c):\n    return {'route': 'job', 'output': 1}",
    exits: ['job', 'no_job', 'error'], mcp_servers: ['ServiceNow'], timeout_s: 20, ...cfg,
  },
});
const EMIT_EDGES = [
  { from: '5', to: '6', from_port: 'output_1' },
  { from: '5', to: '7', from_port: 'output_2' },
  { from: '5', to: '8', from_port: 'output_1' },
  { from: '1', to: '5', from_port: 'output_1' },
];

test('nodeData maps ports to exits', () => {
  const d = CodeNodeEmit.nodeData(emitNode({}), EMIT_EDGES, { servicenow: 'http://localhost/servicenow/' });
  assert.equal(d.kind, 'code');
  assert.deepEqual(d.exit_targets, { job: ['6', '8'], no_job: ['7'], error: [] });
  assert.deepEqual(d.servers, ['http://localhost/servicenow/']);
  assert.deepEqual(d.mcp_servers, ['servicenow']);
  assert.equal(d.timeout_s, 20);
  assert.equal(d.display, 'Poll');
});

test('nodeData defaults and validation', () => {
  const d = CodeNodeEmit.nodeData({ id: '5', node_type: 'code', config: { type: 'code', code: "def run(i, c):\n    return i" } }, [], {});
  assert.deepEqual(d.exits, ['next']);
  assert.equal(d.timeout_s, 30);
  for (const bad of [{ exits: ['Bad'] }, { exits: ['a', 'a'] }, { exits: [] }, { mcp_servers: ['Okta'] },
    { mcp_servers: [5] }, { mcp_servers: 'ServiceNow' }, { timeout_s: 0 }]) {
    assert.throws(() => CodeNodeEmit.nodeData(emitNode(bad), [], { servicenow: 'u' }), /'Poll'/, JSON.stringify(bad));
  }
});

test('slug and refusal', () => {
  assert.equal(CodeNodeEmit.slug('Service Now (prod)'), 'service_now_prod_');
  const graph = { nodes: [emitNode({})], edges: [] };
  assert.equal(CodeNodeEmit.hasCodeNodes(graph), true);
  assert.throws(() => CodeNodeEmit.refuseUnsupported(graph, 'ADK'), /Code nodes are not supported by the ADK target yet/);
  const empty = { nodes: [{ id: '5', node_type: '', config: { type: 'code' } }], edges: [] };
  assert.equal(CodeNodeEmit.hasCodeNodes(empty), true, 'an empty node_type falls through to config.type');
});

test('dangling edges are ignored', () => {
  const edges = [...EMIT_EDGES, { from: '5', to: '99', from_port: 'output_3' }];
  const d = CodeNodeEmit.nodeData(emitNode({}), edges, { servicenow: 'u' }, ['1', '5', '6', '7', '8']);
  assert.deepEqual(d.exit_targets, { job: ['6', '8'], no_job: ['7'], error: [] });
});

// ── CodeNodeStep ─────────────────────────────────────────────────────────────

const EDGES = [
  { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
  { from_node_id: 2, to_node_id: 3, from_port: 'output_1' }, // new_mail -> agent
  { from_node_id: 3, to_node_id: 4, from_port: 'output_1' }, // agent -> output
];
const NODES: Record<number, any> = {
  1: { id: 1, node_type: 'start', config: {} },
  2: { id: 2, node_type: 'code', config: { name: 'Poll Outlook', exits: ['new_mail', 'no_mail', 'error'] } },
  3: { id: 3, node_type: 'agent', config: { agent_name: 'Triage' } },
  4: { id: 4, node_type: 'output', config: {} },
};

test('parents mirror the editor', () => {
  assert.deepEqual(CodeNodeStep.parents(2, EDGES, NODES, { 1: { type: 'start', output: 'go' } }), [{ name: 'start', text: 'go', start: true }]);
  assert.deepEqual(CodeNodeStep.parents(2, EDGES, NODES, { 1: { output: '' } }), []);
});

test('route to the chosen exit', () => {
  const data = { exits: ['new_mail', 'no_mail', 'error'], exit_targets: { new_mail: ['3'], no_mail: [], error: [] } };
  assert.deepEqual(CodeNodeStep.routeAfter(data, { ok: true, route: 'new_mail', output_text: '{"id":"m1"}' }, [3]),
    { success: true, output: '{"id":"m1"}', exit: 'new_mail', chosen: [3], skip: [] });
  const r = CodeNodeStep.routeAfter(data, { ok: true, route: 'no_mail', output_text: 'null' }, [3]);
  assert.deepEqual(r.chosen, []);
  assert.deepEqual(r.skip, [3]);
});

test('a failed run skips all children', () => {
  const r = CodeNodeStep.routeAfter({ exit_targets: { next: ['3'] } }, { ok: false, error: 'CodeNodeError: boom' }, [3]);
  assert.equal(r.success, false);
  assert.equal(r.output, 'Error: CodeNodeError: boom');
  assert.deepEqual(r.skip, [3]);
});

test('quiet and drain', () => {
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 2: { type: 'code', exit: 'no_mail', success: true } }, EDGES, NODES),
    { quiet: true, drain: false });
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 2: { type: 'code', exit: 'new_mail', success: true }, 3: { type: 'agent' }, 4: { type: 'output' } }, EDGES, NODES),
    { quiet: false, drain: true });
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 3: { type: 'agent' }, 4: { type: 'output' } }, EDGES, NODES),
    { quiet: false, drain: false });
});

test('work beside the poll does not drain', () => {
  const edges = [...EDGES, { from_node_id: 1, to_node_id: 5, from_port: 'output_1' }];
  const nodes = { ...NODES, 5: { id: 5, node_type: 'agent', config: { agent_name: 'Beside' } } };
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 2: { type: 'code', exit: 'no_mail', success: true }, 5: { type: 'agent' } }, edges, nodes),
    { quiet: false, drain: false }, 'the agent beside the poll ran (not quiet) but is not behind its exit (no drain)');
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 2: { type: 'code', exit: 'new_mail', success: true }, 5: { type: 'agent' }, 3: { type: 'agent' }, 4: { type: 'output' } }, edges, nodes),
    { quiet: false, drain: true });
});

test('a code node that took no exit did not run', () => {
  const disabled = { 1: { type: 'start' }, 2: { type: 'code', output: 'disabled node', success: true } };
  assert.deepEqual(CodeNodeStep.summarize(disabled, EDGES, NODES), { quiet: false, drain: false });
  assert.deepEqual(CodeNodeStep.summarize({ ...disabled, 3: { type: 'agent' }, 4: { type: 'output' } }, EDGES, NODES), { quiet: false, drain: false });
});

test('an error exit is never quiet and does not drain', () => {
  const errored = { 1: { type: 'start' }, 2: { type: 'code', exit: 'error' } };
  assert.deepEqual(CodeNodeStep.summarize(errored, EDGES, NODES), { quiet: false, drain: false });
  assert.deepEqual(CodeNodeStep.summarize({ 1: { type: 'start' }, 2: { type: 'code', success: false } }, EDGES, NODES), { quiet: false, drain: false });
  assert.deepEqual(CodeNodeStep.summarize({ ...errored, 3: { type: 'agent' } }, EDGES, NODES), { quiet: false, drain: false });
});

test('the error exit reason is one bounded line', () => {
  assert.equal(CodeNodeStep.reason('  mailbox down:\n\t retry   later \n'), 'mailbox down: retry later');
  assert.equal(CodeNodeStep.reason('é'.repeat(250)), 'é'.repeat(200) + '…');
  assert.equal(CodeNodeStep.reason('a'.repeat(200)), 'a'.repeat(200));
});

test('an empty agent_name falls through to name', () => {
  const nodes = { 3: { config: { agent_name: '', name: 'Triage' } }, 2: NODES[2] };
  const p = CodeNodeStep.parents(2, [{ from_node_id: 3, to_node_id: 2, from_port: 'output_1' }], nodes, { 3: { output: 'x' } });
  assert.equal(p[0].name, 'Triage');
});

test('a dispatcher parent passes on what it received', () => {
  const nodes = { 1: { node_type: 'start', config: {} }, 4: { node_type: 'code', config: { name: 'Poll' } },
    3: { node_type: 'agent', config: { agent_name: 'triage' } }, 2: NODES[2] };
  const edges = [{ from_node_id: 1, to_node_id: 4 }, { from_node_id: 4, to_node_id: 3 }, { from_node_id: 3, to_node_id: 2 }];
  const outputs = { 1: { output: 'poll' }, 4: { type: 'code', output: '{"id":"m1"}' },
    3: { type: 'agent', output: '### Input from: Poll\n{"id":"m1"}', route: { id: 2, name: 'claims' } } };
  assert.deepEqual(CodeNodeStep.parents(2, edges, nodes, outputs), [{ name: 'Poll', text: '{"id":"m1"}', start: false }]);
});

test('errorExits: one line per code node that took its error exit', () => {
  const lines = CodeNodeStep.errorExits({ 2: { type: 'code', exit: 'error', output: 'mailbox\n down' }, 3: { type: 'agent' } }, NODES);
  assert.deepEqual(lines, ["code node 'Poll Outlook' took its error exit: mailbox down"]);
});

// ── CodeNodeExecutor (real python3) ──────────────────────────────────────────

const python = () => process.env.CODE_NODE_PYTHON || (fs.existsSync('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3');
const mcpRows = [{ name: 'Outlook', url: 'http://127.0.0.1:9/mcp', headers: '{"X-Outlook-Account":"k"}', user_id: '3' }];
const exec = (config: Record<string, any> = {}) => new CodeNodeExecutor({ code_nodes: { python: python() }, ...config });
const execNode = (code: string, servers: string[] = [], exits = ['a', 'b']) =>
  ({ id: 2, node_type: 'code', config: { name: 'C', code, exits, mcp_servers: servers, timeout_s: 5 } as Record<string, any> });

function assertRan(out: any, t: any): boolean {
  const err = String(out.result.error ?? '');
  if (!out.result.ok && err.includes('needs Python 3.10+')) {
    t.skip(err);
    return false;
  }
  assert.equal(out.result.ok, true, err);
  return true;
}

test('the executor runs the harness', async (t) => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  const code = "def run(input, call_tool):\n    return {'route': 'b', 'output': input.upper()}\n";
  const out = await exec().run(execNode(code), [], [2], '3', [{ name: 'start', text: 'hi', start: true }], 'hi');
  if (!assertRan(out, t)) return;
  assert.equal(out.result.route, 'b');
  assert.equal(out.result.output_text, 'HI');
});

test('config args reach the code as the ARGS global', async (t) => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  const node = execNode("def run(input, call_tool):\n    return {'route': 'a', 'output': [ARGS.get('tag'), ARGS.get('version') + 1]}\n");
  node.config.args = { tag: 'okta-reset', version: 2 };
  let out = await exec().run(node, [], [2], '3', [], '');
  if (!assertRan(out, t)) return;
  assert.equal(out.result.output_text, '["okta-reset", 3]');
  out = await exec().run(execNode("def run(i, c):\n    return {'route': 'a', 'output': ARGS}\n"), [], [2], '3', [], '');
  assertRan(out, t);
  assert.equal(out.result.output_text, '{}');
});

test('an unknown server is refused before running', async () => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  await assert.rejects(exec().run(execNode("def run(i, c):\n    return {'route': 'a', 'output': 1}\n", ['Nope']), [], [2], '3', [], ''),
    /is not one of your MCP servers/);
});

test('code nodes run unless switched off', () => {
  assert.equal(CodeNodeExecutor.enabled({}), true);
  assert.equal(CodeNodeExecutor.enabled({ code_nodes: { server_side: false } }), false);
  assert.equal(GraphWorkflowRunner.unsupportedNodeMessage('code'), null);
  assert.match(String(GraphWorkflowRunner.unsupportedNodeMessage('code', { code_nodes: { server_side: false } })), /CODE_NODES_SERVER_SIDE/);
  assert.equal(GraphWorkflowRunner.unsupportedNodeMessage('playbook'), null);
  assert.equal(GraphWorkflowRunner.unsupportedNodeMessage('agent'), null);
  const prev = process.env.CODE_NODES_SERVER_SIDE;
  process.env.CODE_NODES_SERVER_SIDE = '0';
  try {
    assert.equal(CodeNodeExecutor.enabled({}), false, 'the env switch, as PHP ai_config reads it');
  } finally {
    if (prev === undefined) delete process.env.CODE_NODES_SERVER_SIDE;
    else process.env.CODE_NODES_SERVER_SIDE = prev;
  }
});

test("the user's own server beats a global one on a name clash", async () => {
  installFakeDb((sql, p) => {
    if (!sql.includes('FROM mcp_servers')) return [];
    const all = [
      { name: 'Outlook', url: 'http://global/mcp', headers: null, user_id: null },
      { name: 'Outlook', url: 'http://own/mcp', headers: null, user_id: '3' },
      { name: 'Shared', url: 'http://shared/mcp', headers: null, user_id: null },
      { name: 'Other', url: 'http://other/mcp', headers: null, user_id: '9' },
    ];
    return all.filter((r) => r.user_id === null || r.user_id === p[0]).reverse(); // own row first: order must not matter
  });
  const servers = await new CodeNodeExecutor({}).servers('3');
  assert.equal(servers.outlook.url, 'http://own/mcp');
  assert.equal(servers.shared.url, 'http://shared/mcp');
  assert.ok(!('other' in servers));
});

test('a runner failure becomes an error result', async () => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  const out = await new CodeNodeExecutor({ code_nodes: { python: '/usr/bin/false' } })
    .run(execNode("def run(i, c):\n    return {'route': 'a', 'output': 1}\n"), [], [2], '3', [], '');
  assert.equal(out.result.ok, false);
  assert.match(String(out.result.error), /code node runner failed/);
});

test('runaway code is stopped with a timeout error', async (t) => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  const node = execNode("def run(i, c):\n    while True:\n        pass\n");
  node.config.timeout_s = 1;
  const t0 = Date.now();
  const out = await exec().run(node, [], [2], '3', [], '');
  if (!out.result.ok && String(out.result.error).includes('needs Python 3.10+')) return t.skip(out.result.error);
  assert.equal(out.result.ok, false);
  assert.match(String(out.result.error), /time/i);
  assert.ok(Date.now() - t0 < 10_000);
});

test('a child that never stops is killed by the executor', async () => {
  installFakeDb((sql) => (sql.includes('FROM mcp_servers') ? mcpRows : []));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode_stub_'));
  const stub = path.join(dir, 'python');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  try {
    const node = execNode("def run(i, c):\n    return {'route': 'a', 'output': 1}\n");
    node.config.timeout_s = 1;
    const t0 = Date.now();
    const out = await new CodeNodeExecutor({ code_nodes: { python: stub } }).run(node, [], [2], '3', [], '');
    assert.equal(out.result.ok, false);
    assert.ok(String(out.result.error).includes('(process killed)'));
    assert.ok(Date.now() - t0 < (1 + 5 + 2) * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── CodeNodeController ───────────────────────────────────────────────────────

function controller(answer: Record<string, any> = { ok: true, result: { content: [] } }) {
  const calls: any[] = [];
  const c = new CodeNodeController(async (userId) => async (server, tool, args) => {
    calls.push([userId, server, tool, args]);
    return answer;
  });
  return { c, calls };
}
const ctx = (userId: number | null, body: any): any => ({
  method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: 'jwt', params: {}, remote_addr: '',
});

test('tool-call calls the tool as the user', async () => {
  const { c, calls } = controller();
  const r = await c.toolCall(ctx(7, { server: 'servicenow', tool: 'poll_jobs', args: { tag: 'x' } }));
  assert.deepEqual(r, { ok: true, result: { content: [] } });
  assert.deepEqual(calls, [[7, 'servicenow', 'poll_jobs', { tag: 'x' }]]);
});

test('tool-call: a tool error is an ok:false answer; missing args become {}', async () => {
  const { c, calls } = controller({ ok: false, error: 'MCP tool not found' });
  const r = await c.toolCall(ctx(7, { server: 'okta', tool: 'reset' }));
  assert.deepEqual(r, { ok: false, error: 'MCP tool not found' });
  assert.deepEqual(calls[0][3], {});
});

test('tool-call refuses without a user or with bad input', async () => {
  const { c, calls } = controller();
  assert.deepEqual(await c.toolCall(ctx(null, {})), { ok: false, error: 'Authentication required', status_code: 401 });
  for (const body of [{ server: 'Service Now', tool: 'x' }, { server: 'servicenow', tool: 'a b' },
    { server: 'servicenow', tool: 'x', args: 'nope' }, { tool: 'x' }]) {
    const r = await c.toolCall(ctx(7, body));
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.status_code, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});
