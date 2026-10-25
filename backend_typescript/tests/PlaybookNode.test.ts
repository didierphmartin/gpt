import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { installSqliteDb, SqliteDb } from './support/sqliteDb';
import { makeRunnerHarness } from './support/runnerHarness';
import {
  createRunTables, createCollectionTables, FakeMcpExecutor, FakeNodeRunnerBridge, scriptedLlm, tempDir, OKTA,
} from './support/playbookDb';
import { PlaybookNodeRunner } from '../src/AgentTeam/PlaybookNodeRunner';
import { PlaybookSource } from '../src/AgentTeam/PlaybookSource';
import { PlaybookOutcome } from '../src/AgentTeam/PlaybookOutcome';
import { PlaybookAgentTools } from '../src/AgentTeam/PlaybookAgentTools';
import { PlaybookController } from '../src/Controllers/PlaybookController';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { AgentController } from '../src/Controllers/AgentController';
import { AgentRepository } from '../src/AgentTeam/AgentRepository';
import { WorkflowGraphRepository } from '../src/AgentTeam/WorkflowRepository';
import { PlaybookStore } from '../src/Playbook/PlaybookStore';
import * as pools from '../src/db/pools';

/**
 * Twins of backend/tests/Unit: Playbook/PlaybookNodeRunnerTest, Playbook/PlaybookTranscriptTextTest,
 * PlaybookSourceTest, PlaybookOutcomeTest, Playbook/PlaybookAgentToolsTest, Playbook/PlaybookControllerTest,
 * GraphWorkflowRunnerPlaybookNodeTest, AgentTeam/AgentPlaybookLinkTest and Playbook/PlaybookLinkResolutionTest,
 * plus the playbook-node/run SSE endpoint (WorkflowController::runPlaybookNode).
 */

let d: SqliteDb;
beforeEach(() => {
  d = installSqliteDb();
  createRunTables(d);
});

const simplePlaybook = () => ({
  title: 'Simple Resolve', trigger: { kind: 'request', description: 'test trigger' },
  instructions: '#Send Direct Message to the requester, then #Leave Internal Note, then #Resolve Request.',
  actions_used: ['#Send Direct Message', '#Leave Internal Note', '#Resolve Request'],
  policy: { writes_enabled: true },
});

function nodeRunner(rounds: any[], dir: string, counter?: { calls: number }) {
  const inner = scriptedLlm(rounds);
  return new PlaybookNodeRunner({ workflow_runs_dir: dir }, {
    llm: () => async (m: any[], t: any[]) => {
      if (counter) counter.calls++;
      return inner(m);
    },
    mcp: () => new FakeMcpExecutor(),
    bridge: (emit) => new FakeNodeRunnerBridge(emit),
  });
}
const q = (sql: string, ...p: any[]) => d.prepare(sql).all(...p) as any[];

// ---- PlaybookNodeRunner ----

test('node runner: a T1-shaped run resolves', async () => {
  const r = await nodeRunner([[
    { name: 'send_direct_message', arguments: { text: 'All set.' } },
    { name: 'leave_internal_note', arguments: { text: 'Handled via test.' } },
    { name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } },
  ]], tempDir()).run(1, { playbook: simplePlaybook() }, 'Please help me.', () => {});
  assert.equal(r.status, 'resolved');
  assert.equal(typeof r.run_id, 'number');
  assert.ok(r.output.includes(`[playbook run ${r.run_id}: resolved]`));
  assert.equal(q('SELECT status FROM playbook_runs WHERE id = ?', r.run_id)[0].status, 'resolved');
});

test('node runner: a gate request is emitted and approved, then the run resolves', async () => {
  const emitted: any[] = [];
  const r = await nodeRunner([
    [{ name: 'request_approval', arguments: { approver: 'boss', question: 'OK to proceed?' } }],
    [{ name: 'leave_internal_note', arguments: { text: 'Approved and handled.' } }, { name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } }],
  ], tempDir()).run(1, { playbook: simplePlaybook() }, 'Please help me.', (e) => emitted.push(e));
  assert.equal(r.status, 'resolved');
  const gates = emitted.filter((e) => e.type === 'gate_request');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].kind, 'approval');
  assert.equal(gates[0].run_id, r.run_id);
});

test('node runner: unattended stops at the first gate', async () => {
  const c = { calls: 0 };
  const r = await nodeRunner([
    [{ name: 'request_approval', arguments: { approver: 'boss', question: 'OK to proceed?' } }],
    [{ name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } }],
  ], tempDir(), c).run(1, { playbook: simplePlaybook() }, 'Please help me.', () => {}, true);
  assert.equal(r.status, 'handed_off');
  assert.equal(r.gate, 'approval');
  assert.equal(c.calls, 1);
});

test('node runner: an unattended gate then resolve in one turn stays handed off', async () => {
  const r = await nodeRunner([[
    { name: 'request_approval', arguments: { approver: 'boss', question: 'OK to proceed?' } },
    { name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } },
  ]], tempDir()).run(1, { playbook: simplePlaybook() }, 'Please help me.', () => {}, true);
  assert.equal(r.status, 'handed_off');
  assert.equal(r.gate, 'approval');
  assert.equal(q('SELECT status FROM playbook_runs WHERE id = ?', r.run_id)[0].status, 'handed_off');
});

test('node runner: an unattended gate skips the rest of the turn (tool_skipped)', async () => {
  const dir = tempDir();
  const r = await nodeRunner([[
    { name: 'request_approval', arguments: { approver: 'boss', question: 'OK to proceed?' } },
    { name: 'leave_internal_note', arguments: { text: 'SHOULD-NOT-RUN' } },
    { name: 'send_direct_message', arguments: { text: 'SHOULD-NOT-SEND' } },
  ]], dir).run(1, { playbook: simplePlaybook() }, 'Please help me.', () => {}, true);
  assert.equal(r.status, 'handed_off');
  assert.equal(q("SELECT COUNT(*) AS c FROM playbook_run_notes WHERE text LIKE '%SHOULD-NOT-RUN%'")[0].c, 0);
  assert.equal(q("SELECT COUNT(*) AS c FROM playbook_run_messages WHERE text LIKE '%SHOULD-NOT-SEND%'")[0].c, 0);
  assert.ok(!r.output.includes('SHOULD-NOT-RUN'));
  const transcript = fs.readFileSync(`${dir}/playbook-${r.run_id}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(transcript.filter((e) => e.type === 'tool_skipped').map((e) => e.name), ['leave_internal_note', 'send_direct_message']);
});

test('node runner: the first unattended gate wins', async () => {
  const r = await nodeRunner([[
    { name: 'prompt_handoff', arguments: { reason: 'needs a human' } },
    { name: 'request_approval', arguments: { approver: 'boss', question: 'OK?' } },
  ]], tempDir()).run(1, { playbook: simplePlaybook() }, 'Please help me.', () => {}, true);
  assert.equal(r.status, 'handed_off');
  assert.equal(r.gate, 'handoff');
  assert.deepEqual(q('SELECT kind FROM playbook_run_gates').map((x) => x.kind), ['handoff']);
});

test('node runner: unresolved bindings and a missing playbook throw', async () => {
  const doc = { ...simplePlaybook(), actions_used: ['#Reset It'], instructions: '#Reset It.', bindings: { '#Reset It': 'okta.nope' } };
  await assert.rejects(nodeRunner([], tempDir()).run(1, { playbook: doc }, 'x', () => {}), /^Error: Playbook has unresolved bindings: #Reset It is bound to okta.nope/);
  await assert.rejects(nodeRunner([], tempDir()).run(1, {}, 'x', () => {}), /nodeConfig.playbook \(object or string\) is required\./);
});

test('node runner: the transcript mirrors the overlay', () => {
  const t = PlaybookNodeRunner.renderTranscript('Time Off & Leave Requests', [
    { type: 'round', round: 1 },
    { type: 'tool_call', name: 'okta__lookup_users', args: { email: 'a@b' } },
    { type: 'tool_result', name: 'okta__lookup_users', result: { ok: true, id: 'u-1' } },
    { type: 'gate_request', kind: 'approval', payload: { question: 'Approve PTO for Didier?', context: '5 days' } },
    { type: 'tool_result', name: 'request_approval', result: { ok: true, decision: { tool_call_id: 'x', decision: 'approved', comment: 'fine', actor: 'me' } } },
    { type: 'message', text: 'Hi Marcus,\nApproved.' },
    { type: 'message', text: 'secret', sensitive: true },
    { type: 'tool_call', name: 'workday__submit_time_off', args: {} },
    { type: 'tool_result', name: 'workday__submit_time_off', result: { ok: false, error: 'boom' } },
    { type: 'final', leg: 0, status: 'resolved' },
  ], 'Request TO-1 submitted.', 41, 'resolved');
  for (const s of ['# Playbook: Time Off & Leave Requests', 'run 41', 'okta__lookup_users ✓', 'workday__submit_time_off ✗ — boom',
    'Approval requested: Approve PTO for Didier?', '→ approved (fine)', 'Hi Marcus,\n  Approved.', '(message redacted)', 'Request TO-1 submitted.']) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(!t.includes('tool_call_id'));
  assert.ok(!t.includes('secret'));
  assert.ok(t.indexOf('okta__lookup_users') < t.indexOf('Approval requested'));
  assert.ok(t.indexOf('Approval requested') < t.indexOf('workday__submit_time_off'));
  assert.ok(t.endsWith('[playbook run 41: resolved]'));
  assert.equal(PlaybookNodeRunner.renderTranscript('T', [], '', 2, 'failed'), '# Playbook: T (run 2 — failed)\n\n## Timeline\n- (no steps recorded)\n\n[playbook run 2: failed]');
});

// ---- PlaybookSource / PlaybookOutcome / PlaybookAgentTools ----

function collection(): void {
  createCollectionTables(d);
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)');
}
const robot = () => Number(d.prepare("INSERT INTO users (kind) VALUES ('service')").run().lastInsertRowid);
const pb = (user: number, key: string, text: string) => d.prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)').run(user, key, key, text);

test('source: from input reads the published robot copy', async () => {
  collection();
  const r = robot();
  pb(r, 'test', 'T-published');
  pb(7, 'test', 'T-draft');
  assert.deepEqual(await PlaybookSource.fromInput(7, {}, '## Get job\n{"playbook":"test","task":"x"}'), { ok: true, key: 'test', text: 'T-published' });
});

test('source: unpublished, unknown, bad input, invalid key, no robot, custom field', async () => {
  collection();
  assert.deepEqual(await PlaybookSource.fromInput(7, {}, '{"playbook":"test"}'), { ok: false, reason: 'playbook_not_found:test' }, 'no robot account');
  pb(7, 'test', 'D');
  assert.deepEqual(await PlaybookSource.fromInput(7, {}, '{"playbook":"test"}'), { ok: false, reason: 'playbook_not_published:test' }, 'no robot account, a draft');
  const r = robot();
  assert.deepEqual(await PlaybookSource.fromInput(7, {}, '{"playbook":"test"}'), { ok: false, reason: 'playbook_not_published:test' });
  assert.deepEqual(await PlaybookSource.fromInput(7, {}, '{"playbook":"nope"}'), { ok: false, reason: 'playbook_not_found:nope' });
  for (const t of ['hello', '{"task":"x"}', '[1]', '{"playbook":5}', '{"playbook":"../x"}']) {
    assert.deepEqual(await PlaybookSource.fromInput(7, {}, t), { ok: false, reason: 'bad_input' }, t);
  }
  pb(r, 'test', 'T');
  assert.equal((await PlaybookSource.fromInput(7, { playbook_input_field: 'pb' }, '{"pb":"test"}')).ok, true);
});

test('source: isFromInput and the job line', () => {
  assert.equal(PlaybookSource.isFromInput({ playbook_source: 'input' }), true);
  assert.equal(PlaybookSource.isFromInput({ playbook_source: 'fixed' }), false);
  assert.equal(PlaybookSource.isFromInput({}), false);
  assert.equal(PlaybookSource.jobLine('## Get job\n{ "playbook": "a/b",\n "task": "é" }'), 'Job: {"playbook":"a/b","task":"é"}');
  assert.equal(PlaybookSource.jobLine('{"task":"x"}'), 'Job: {"task":"x"}');
  for (const t of ['not json', '[1,2]', '"text"', '## Get job\n']) assert.equal(PlaybookSource.jobLine(t), null, t);
  assert.equal(PlaybookSource.jobLine('{}'), 'Job: {}');
  assert.equal(PlaybookSource.jobLine('{"a":{}}'), 'Job: {"a":{}}');
  assert.equal(PlaybookSource.jobLine('{"a":{"b":[]},"c":null}'), 'Job: {"a":{"b":[]},"c":null}');
});

test('outcome: statuses, node result, error reason', () => {
  assert.equal(PlaybookOutcome.exit('resolved'), 'done');
  for (const s of ['failed', 'running', 'handed_off']) assert.equal(PlaybookOutcome.exit(s), 'failed');
  assert.equal(PlaybookOutcome.reason('handed_off', 'approval'), 'gate:approval');
  assert.equal(PlaybookOutcome.reason('running', null), 'status:running');
  assert.equal(PlaybookOutcome.reason('resolved', null), null);
  assert.ok(PlaybookOutcome.failureText('bad_input', 'T').startsWith('Playbook failed: bad_input\n\nT'));
  assert.deepEqual(PlaybookOutcome.nodeResult(null, 'T', 'Job: x'), { exit: 'done', text: 'T\n\nJob: x' });
  assert.deepEqual(PlaybookOutcome.nodeResult('bad_input', 'T', 'Job: x'), { exit: 'failed', text: 'Playbook failed: bad_input\n\nT\n\nJob: x' });
  assert.deepEqual(PlaybookOutcome.nodeResult(null, 'T', null), { exit: 'done', text: 'T' });
  assert.deepEqual(PlaybookOutcome.nodeResult('status:running', 'T', null), { exit: 'failed', text: 'Playbook failed: status:running\n\nT' });
  assert.equal(PlaybookOutcome.errorReason(new Error('  boom\n  and\tmore \n')), 'error:boom and more');
});

test('agent tools: bound MCP tools become the agent tools', () => {
  const text = 'Title: T\n\nTrigger: x\n\nInstructions:\n1. #Custom Workday Get PTO Balance for the requester.\n'
    + '2. #Lookup Users on the requester.\n3. #Custom Frobnicate Widgets.\n4. #Send Direct Message; #Resolve Request.\n\n'
    + 'Tools used: Workday\n\nActions used: #Custom Workday Get PTO Balance; #Lookup Users; #Custom Frobnicate Widgets; #Send Direct Message; #Resolve Request';
  assert.deepEqual(PlaybookAgentTools.fromPlaybookText(text, ['workday.get_pto_balance', 'workday.submit_time_off', 'okta.lookup_users']),
    ['mcp_get_pto_balance', 'mcp_lookup_users']);
  assert.deepEqual(PlaybookAgentTools.fromPlaybookText('not a playbook', ['okta.lookup_users']), []);
});

// ---- PlaybookController (POST /playbooks/validate) ----

const OKTA_TOOLS = ['search_users', 'search_system_log', 'list_user_factors', 'verify_security_answers', 'reset_password', 'reset_factor', 'unlock_user'];
const mfa = () => ({
  title: 'MFA Reset', trigger: { kind: 'request', description: 'user locked out' },
  instructions: '#Search Okta User by Email first, then #Reset Password (Okta), then #Reset User Factors (Okta), then #Leave Internal Note, then #Resolve Request.',
  tools_used: ['Okta'],
  actions_used: ['#Search Okta User by Email', '#Reset Password (Okta)', '#Reset User Factors (Okta)', '#Leave Internal Note', '#Resolve Request'],
  bindings: { '#Search Okta User by Email': 'okta.search_users', '#Reset Password (Okta)': 'okta.reset_password', '#Reset User Factors (Okta)': 'okta.reset_factor' },
});
function validator(tools: string[] | null) {
  d.exec('CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY, user_id INT, name TEXT)');
  return new PlaybookController(async () => {
    if (tools === null) throw new Error('the loader must not be touched');
    return { getTools: () => new Map(tools.map((n) => [`mcp_${n}`, { original_name: n, server_name: 'Okta', description: `Mock Okta tool ${n}`, input_schema: { type: 'object', properties: [] } }])) } as any;
  });
}
const ctx = (body: any, userId: number | null = 7): any => ({ body, user_id: userId, params: {}, query: {}, headers: {} });

test('validate: a dangling binding is 422, fully bound is 200', async () => {
  const bad = await validator(OKTA_TOOLS.filter((t) => t !== 'reset_factor')).validate(ctx({ playbook: mfa() }));
  assert.equal(bad.status_code, 422);
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /#Reset User Factors \(Okta\)/);
  assert.match(bad.errors[0], /okta\.reset_factor/);

  const ok = await validator(OKTA_TOOLS).validate(ctx({ playbook: mfa() }));
  assert.equal(ok.status_code, 200);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.checklist, mfa().actions_used);
  const b = Object.fromEntries(ok.actions.map((a: any) => [a.name, a]));
  assert.equal(b['#Search Okta User by Email'].kind, 'bound');
  assert.equal(b['#Search Okta User by Email'].target, 'okta.search_users');
  assert.equal(b['#Resolve Request'].kind, 'native');
  assert.deepEqual(Object.keys(ok), ['valid', 'actions', 'gates', 'checklist', 'errors', 'warnings', 'notices', 'status_code']);
});

test('validate: missing playbook is 422 without the loader; text parses; no user is 401', async () => {
  const missing = await validator(null).validate(ctx({}));
  assert.deepEqual(missing, { valid: false, errors: ['Field "playbook" (object or string) is required.'], status_code: 422 });
  const text = 'Title: MFA Reset\nTrigger: user locked out\nInstructions: #Search Okta User by Email first, then #Resolve Request.\n'
    + 'Tools used: Okta\nActions used: #Search Okta User by Email; #Resolve Request\n';
  const r = await validator(OKTA_TOOLS).validate(ctx({ playbook: text }));
  assert.deepEqual(r.checklist, ['#Search Okta User by Email', '#Resolve Request']);
  assert.deepEqual(await validator(null).validate(ctx({ playbook: mfa() }, null)), { success: false, error: 'Authentication required', status_code: 401 });
});

// ---- POST /workflows/playbook-node/run (SSE) ----

function sse(body: any, userId: number | null = 3) {
  const chunks: string[] = [];
  const res: any = {
    writableEnded: false, statusCode: 0, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
    write(s: string) { chunks.push(s); },
    end() { this.writableEnded = true; },
  };
  const req: any = { method: 'POST', path: '/api/v1/workflows/playbook-node/run', headers: {}, query: {}, body, user_id: userId, params: {}, socket: {} };
  return { req, res, frames: () => chunks.join('').split('\n\n').filter(Boolean) };
}

test('playbook-node/run streams the events then done with the exit', async () => {
  const dir = tempDir();
  const c = new WorkflowController();
  c.playbookRunnerFactory = () => nodeRunner([[{ name: 'resolve_request', arguments: { outcome: 'success', summary: 'all good' } }]], dir);
  const { req, res, frames } = sse({ node_config: { playbook: simplePlaybook() }, prompt: 'help' });
  await c.runPlaybookNode(req, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.ok(res.writableEnded);
  const all = frames();
  assert.ok(all[0].startsWith('data: {"type":"round"'));
  const last = all[all.length - 1];
  assert.ok(last.startsWith('event: done\ndata: '));
  const done = JSON.parse(last.split('data: ')[1]);
  assert.equal(done.status, 'resolved');
  assert.equal(done.exit, 'done');
  assert.ok(done.output.endsWith(`[playbook run ${done.run_id}: resolved]`), 'a one-output node keeps its transcript');
});

test('playbook-node/run: with exits a failure is the failed exit; no exits it is an error event; no user is an error', async () => {
  const c = new WorkflowController();
  c.playbookRunnerFactory = () => { throw new Error('runner\nexploded'); };
  let s = sse({ node_config: { playbook: simplePlaybook(), exits: ['done', 'failed'] }, prompt: '{"task":"T1"}' });
  await c.runPlaybookNode(s.req, s.res);
  const done = JSON.parse(s.frames().at(-1)!.split('data: ')[1]);
  assert.equal(done.exit, 'failed');
  assert.equal(done.output, 'Playbook failed: error:runner exploded\n\n\n\nJob: {"task":"T1"}');

  s = sse({ node_config: { playbook: simplePlaybook() }, prompt: 'x' });
  await c.runPlaybookNode(s.req, s.res);
  assert.equal(s.frames().at(-1), 'event: error\ndata: {"error":"runner\\nexploded"}');

  s = sse({ node_config: {} }, null);
  await c.runPlaybookNode(s.req, s.res);
  assert.deepEqual(s.frames(), ['event: error\ndata: {"error":"Authentication required"}']);
});

test('playbook-node/run: a linked node reads its playbook; an unknown link is an error; from input names a missing key', async () => {
  collection();
  const dir = tempDir();
  const id = (await new PlaybookStore().save(3, null, 'Title: Linked\nInstructions: #Resolve Request.\nActions used: #Resolve Request', 'linked')).id;
  const c = new WorkflowController();
  c.playbookRunnerFactory = () => nodeRunner([[{ name: 'resolve_request', arguments: { outcome: 'ok', summary: 's' } }]], dir);
  let s = sse({ node_config: { playbook_id: id }, prompt: 'go' });
  await c.runPlaybookNode(s.req, s.res);
  assert.match(JSON.parse(s.frames().at(-1)!.split('data: ')[1]).output, /# Playbook: Linked/);

  s = sse({ node_config: { playbook_id: 99 }, prompt: 'go' });
  await c.runPlaybookNode(s.req, s.res);
  assert.equal(s.frames().at(-1), 'event: error\ndata: {"error":"Playbook #99 not found"}');

  s = sse({ node_config: { playbook_source: 'input' }, prompt: 'go', parent_text: '{"playbook":"nope"}' });
  await c.runPlaybookNode(s.req, s.res);
  const done = JSON.parse(s.frames().at(-1)!.split('data: ')[1]);
  assert.equal(done.exit, 'failed');
  assert.equal(done.output, 'Playbook failed: playbook_not_found:nope\n\n\n\nJob: {"playbook":"nope"}');
});

// ---- GraphWorkflowRunner: the playbook node, unattended (GraphWorkflowRunnerPlaybookNodeTest) ----

const python = () => process.env.CODE_NODE_PYTHON || (fs.existsSync('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3');

function sqliteHandler(db: DatabaseSync) {
  return (sqlText: string, params: readonly unknown[]) => {
    const st = db.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) return st.all(...ps) as any[];
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid) };
  };
}

async function go(pbConfig: Record<string, any>, codeOutput: string, opts: { withExits?: boolean; rounds?: any[]; seed?: (db: DatabaseSync) => void } = {}) {
  const withExits = opts.withExits ?? true;
  const db = new DatabaseSync(':memory:');
  createRunTables(db);
  createCollectionTables(db);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)');
  db.exec("INSERT INTO users (kind) VALUES ('service')");
  db.exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)');
  opts.seed?.(db);
  const cfg = { name: 'PB', ...(withExits ? { exits: ['done', 'failed'] } : {}), ...pbConfig };
  const nodes = [
    { id: 1, node_type: 'start', config: {} },
    { id: 2, node_type: 'code', config: { name: 'Get', exits: ['next'], mcp_servers: [], timeout_s: 10,
      code: `def run(input, call_tool):\n    return {'route': 'next', 'output': ${JSON.stringify(codeOutput)}}\n` } },
    { id: 3, node_type: 'playbook', config: cfg },
    { id: 4, node_type: 'output', config: {} },
    { id: 5, node_type: 'output', config: {} },
  ];
  const edges = [
    { from_node_id: 1, to_node_id: 2, from_port: 'output_1' },
    { from_node_id: 2, to_node_id: 3, from_port: 'output_1' },
    { from_node_id: 3, to_node_id: 4, from_port: 'output_1' },
    { from_node_id: 3, to_node_id: 5, from_port: withExits ? 'output_2' : 'output_1' },
  ];
  const h = makeRunnerHarness({ nodes, edges, config: { code_nodes: { python: python() } }, extra: sqliteHandler(db) });
  h.runner.archiveRunToConversationContexts = async () => {};
  const counter = { factoryCalls: 0 };
  h.runner.makePlaybookNodeRunner = () => {
    counter.factoryCalls++;
    return nodeRunner(opts.rounds ?? [], h.runsDir);
  };
  const out = await h.runner.run({ id: 55, name: 'PB test' }, 3, { prompt: 'go' });
  h.cleanup();
  return { out, o: out.node_outputs ?? {}, factoryCalls: counter.factoryCalls };
}
const resolveRound = [[{ name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } }]];
const pbDoc = () => ({ title: 'Simple Resolve', trigger: { kind: 'request', description: 't' }, instructions: '#Resolve Request.', actions_used: ['#Resolve Request'], policy: { writes_enabled: true } });
const lastLine = (s: string) => s.trimEnd().split('\n').at(-1);

test('runner: done routes to the done branch', async () => {
  const { out, o } = await go({ playbook: pbDoc() }, 'hello', { rounds: resolveRound });
  assert.equal(out.success, true, out.error);
  assert.equal(o[3].exit, 'done');
  assert.ok(4 in o, 'Out-done ran');
  assert.ok(!(5 in o), 'Out-failed skipped');
  assert.ok(o[3].output.includes('[playbook run'));
  assert.ok(!o[3].output.includes('Playbook failed'));
  assert.ok(!('code_route' in o[3]));
});

test('runner: a from-input node ends with the job line', async () => {
  const { out, o } = await go({ playbook_source: 'input' }, '{"playbook": "nope", "task": "INC0001", "u": "é/x"}');
  assert.equal(out.success, true, out.error);
  assert.equal(o[3].exit, 'failed');
  assert.ok(5 in o);
  assert.ok(!(4 in o));
  assert.ok(o[5].output.startsWith('Playbook failed: playbook_not_found:nope'));
  assert.equal(lastLine(o[3].output), 'Job: {"playbook":"nope","task":"INC0001","u":"é/x"}');
});

test('runner: a fixed node with exits ends with the job line when its parent is a job', async () => {
  const { out, o } = await go({ playbook: pbDoc() }, '{"task": "T1", "number": "SCTASK1"}', { rounds: resolveRound });
  assert.equal(out.success, true, out.error);
  assert.equal(o[3].exit, 'done');
  assert.equal(lastLine(o[3].output), 'Job: {"task":"T1","number":"SCTASK1"}');
});

test('runner: a gate ends the run as failed with the gate reason', async () => {
  const { o } = await go({ playbook: pbDoc() }, 'hello', {
    rounds: [[{ name: 'request_approval', arguments: { approver: 'boss', question: 'OK?' } }], ...resolveRound],
  });
  assert.equal(o[3].exit, 'failed');
  assert.ok(o[5].output.startsWith('Playbook failed: gate:approval'));
  assert.ok(!o[3].output.includes('Job: '), 'fixed source adds no Job line');
});

test('runner: from input — unknown key, bad input, missing field, a JSON list: failed without running', async () => {
  let r = await go({ playbook_source: 'input' }, '{"playbook":"nope"}');
  assert.equal(r.o[3].exit, 'failed');
  assert.ok(5 in r.o && !(4 in r.o));
  assert.equal(r.factoryCalls, 0, 'the playbook runner was never built');
  r = await go({ playbook_source: 'input' }, 'not json at all');
  assert.ok(r.o[3].output.startsWith('Playbook failed: bad_input'));
  assert.ok(!r.o[3].output.includes('Job: '));
  assert.equal(r.factoryCalls, 0);
  r = await go({ playbook_source: 'input' }, '{"task":"INC0001"}');
  assert.ok(r.o[3].output.startsWith('Playbook failed: bad_input'));
  assert.equal(lastLine(r.o[3].output), 'Job: {"task":"INC0001"}');
  r = await go({ playbook_source: 'input' }, '[1,2]');
  assert.ok(r.o[3].output.startsWith('Playbook failed: bad_input'));
  assert.ok(!r.o[3].output.includes('Job: '));
});

test('runner: a legacy playbook node without exits runs all children', async () => {
  const { out, o } = await go({ playbook: pbDoc() }, 'hello', { withExits: false, rounds: resolveRound });
  assert.equal(out.success, true, out.error);
  assert.ok(4 in o && 5 in o);
  assert.ok(!('exit' in o[3]));
});

test('runner: a resolved from-input key runs the published copy', async () => {
  const { out, o, factoryCalls } = await go({ playbook_source: 'input', writes_enabled: true }, '{"playbook":"pubpb","task":"INC0002"}', {
    rounds: resolveRound,
    seed: (db) => db.prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, ?, ?, ?)').run('pubpb', 'Pub',
      'Title: Published Copy\nTrigger: a job\nInstructions: #Resolve Request.\nActions used: #Resolve Request'),
  });
  assert.equal(out.success, true, out.error);
  assert.equal(o[3].exit, 'done');
  assert.ok(4 in o && !(5 in o));
  assert.equal(factoryCalls, 1);
  assert.ok(o[3].output.includes('# Playbook: Published Copy'));
  assert.equal(lastLine(o[3].output), 'Job: {"playbook":"pubpb","task":"INC0002"}');
});

test('runner: an error reason stays on one line', async () => {
  const { o } = await go({ playbook_source: 'input' }, '{"playbook":"badpb"}', {
    seed: (db) => db.prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, ?, ?, ?)').run('badpb', 'Bad', 'Title: only a title'),
  });
  assert.equal(o[3].exit, 'failed');
  const first = o[3].output.split('\n')[0];
  assert.ok(first.startsWith('Playbook failed: error:'));
  assert.ok(first.includes('Instructions'));
});

test('runner: a from-input node without exits fails the run on failure', async () => {
  const { out, o } = await go({ playbook_source: 'input' }, '{"playbook":"nope","task":"INC0001"}', { withExits: false });
  assert.equal(out.success, false, 'a legacy one-output node has no failed exit: the run fails');
  assert.ok(String(out.error ?? '').includes('playbook_not_found:nope'));
  assert.ok(!(4 in o) && !(5 in o));
});

// ---- links: agents and nodes by playbook_id (AgentPlaybookLinkTest, PlaybookLinkResolutionTest) ----

function agentsTable(): void {
  createCollectionTables(d);
  d.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,
    category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,
    can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,
    playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,
    created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))`);
}
const agentCtx = (body: any, userId = 3, id?: number): any => ({ body, user_id: userId, params: id ? { id: String(id) } : {}, query: {}, headers: {} });

test('agents: a playbook agent links and keeps no text; an unknown playbook is 404', async () => {
  agentsTable();
  const p = await new PlaybookStore().save(3, null, OKTA, 'okta-reset');
  const c = new AgentController();
  const r = await c.create(agentCtx({ name: 'Okta agent', agent_type: 'playbook', playbook_id: p.id, instructions: 'x' }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(Number(r.data.playbook_id), p.id);
  assert.equal(r.data.instructions, '');
  const bad = await c.create(agentCtx({ name: 'X', agent_type: 'playbook', playbook_id: 99 }));
  assert.equal(bad.status_code, 404);
  assert.equal(bad.error, 'Playbook #99 not found');
});

test('agents: update links and empties instructions; unknown or foreign playbooks are 404; a linked agent stays empty', async () => {
  agentsTable();
  const store = new PlaybookStore();
  const p = await store.save(3, null, OKTA, 'okta-reset');
  const foreign = await store.save(9, null, OKTA, 'okta-reset');
  const c = new AgentController();
  const id = (await c.create(agentCtx({ name: 'Aplaybook', agent_type: 'playbook', instructions: 'old text' }))).data.id;
  for (const badId of [99, foreign.id]) {
    const r = await c.update(agentCtx({ playbook_id: badId }, 3, id));
    assert.equal(r.status_code, 404);
    assert.equal(r.error, `Playbook #${badId} not found`);
  }
  let r = await c.update(agentCtx({ playbook_id: p.id }, 3, id));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(Number(r.data.playbook_id), p.id);
  assert.equal(r.data.instructions, '');
  r = await c.update(agentCtx({ instructions: 'stale text' }, 3, id));
  assert.equal(r.data.instructions, '');
  assert.equal(Number(r.data.playbook_id), p.id);
});

test('agents: a standard agent stores no link', async () => {
  agentsTable();
  const p = await new PlaybookStore().save(3, null, OKTA, 'okta-reset');
  const c = new AgentController();
  const r = await c.create(agentCtx({ name: 'S', agent_type: 'standard', playbook_id: p.id }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.playbook_id, null);
  const u = await c.update(agentCtx({ playbook_id: p.id }, 3, r.data.id));
  assert.equal(u.data.playbook_id, null);
});

test('agents: duplicating to another owner copies the playbook into their collection', async () => {
  agentsTable();
  const store = new PlaybookStore();
  const p = await store.save(3, null, OKTA, 'okta-reset');
  await store.save(4, null, OKTA, null); // user 4 already has key okta-password-reset
  const id = (await new AgentController().create(agentCtx({ name: 'Aplaybook', agent_type: 'playbook', playbook_id: p.id }))).data.id;
  const repo = new AgentRepository();
  const copy = (await repo.duplicate(id, 4, 'Mine'))!;
  const copied = await store.get(4, copy.playbookId!);
  assert.notEqual(copied, null, 'the copy links to a playbook its owner can read');
  assert.equal(copied!.pkey, 'okta-password-reset-2');
  assert.equal(copied!.text, OKTA);
  const same = (await repo.duplicate(id, 3, 'Again'))!;
  assert.equal(same.playbookId, p.id);
  assert.equal(q('SELECT COUNT(*) AS c FROM playbooks WHERE user_id = 4')[0].c, 2);
});

test('nodes: getNodes fills the linked text for the owner; missing, foreign and stale flags; non-playbook untouched', async () => {
  createCollectionTables(d);
  const store = new PlaybookStore();
  const id = (await store.save(3, null, OKTA, 'okta-reset')).id;
  const foreign = (await store.save(4, null, OKTA, 'okta-reset')).id;
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')");
  const ins = d.prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, ?, ?)');
  ins.run('playbook', JSON.stringify({ name: 'Reset', playbook_id: id }));
  ins.run('playbook', JSON.stringify({ name: 'Gone', playbook_id: 99 }));
  ins.run('playbook', JSON.stringify({ playbook_id: foreign }));
  ins.run('playbook', JSON.stringify({ playbook_id: id, playbook_missing: true }));
  ins.run('agent', JSON.stringify({ playbook_id: 99 }));
  const nodes = await new WorkflowGraphRepository().getNodes(1);
  assert.equal(nodes[0].config.playbook, OKTA);
  assert.ok(!('playbook' in nodes[1].config));
  assert.equal(nodes[1].config.playbook_missing, true);
  assert.equal(nodes[2].config.playbook_missing, true, "another user's playbook is not resolved");
  assert.ok(!('playbook_missing' in nodes[3].config));
  assert.equal(nodes[3].config.playbook, OKTA);
  assert.deepEqual(nodes[4].config, { playbook_id: 99 });
});

test('nodes: createNode and updateNode never store the derived keys', async () => {
  createCollectionTables(d);
  const repo: any = new WorkflowGraphRepository();
  const nodeId = await repo.createNode(pools.db, 1, { node_type: 'playbook', config: { playbook_id: 7, playbook: 'stale', playbook_missing: true } });
  let stored = JSON.parse(q('SELECT config FROM workflow_nodes WHERE id = ?', nodeId)[0].config);
  assert.equal(stored.playbook_id, 7);
  assert.ok(!('playbook' in stored) && !('playbook_missing' in stored));
  await repo.updateNode(nodeId, { node_type: 'playbook', config: { playbook_id: 7, playbook: 'stale2', playbook_missing: true } });
  stored = JSON.parse(q('SELECT config FROM workflow_nodes WHERE id = ?', nodeId)[0].config);
  assert.ok(!('playbook' in stored) && !('playbook_missing' in stored));
});
