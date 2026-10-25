import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { installSqliteDb, SqliteDb } from './support/sqliteDb';
import { createRunTables, FakeMcpExecutor, FakeGateBridge, scriptedLlm, tempDir } from './support/playbookDb';
import { PlaybookDocument, InvalidPlaybookError } from '../src/Playbook/PlaybookDocument';
import { PlaybookAnalyzer } from '../src/Playbook/PlaybookAnalyzer';
import { PlaybookRunState } from '../src/Playbook/PlaybookRunState';
import { PlaybookTranscript } from '../src/Playbook/PlaybookTranscript';
import { PlaybookNativeTools } from '../src/Playbook/PlaybookNativeTools';
import { PlaybookActionSpace } from '../src/Playbook/PlaybookActionSpace';
import { GateManager } from '../src/Playbook/GateManager';
import { PlaybookInterpreter } from '../src/Playbook/PlaybookInterpreter';
import { WorkflowLlmClient } from '../src/Playbook/Adapters/WorkflowLlmClient';
import { LoaderMcpExecutor } from '../src/Playbook/Adapters/LoaderMcpExecutor';

/**
 * Twins of backend/tests/Unit/Playbook: PlaybookDocumentTest, PlaybookAnalyzerTest, PlaybookRunStateTest,
 * PlaybookNativeToolsTest, PlaybookActionSpaceTest, GateManagerTest, PlaybookInterpreterTest,
 * WorkflowLlmClientTest, LoaderMcpExecutorTest and RunProtocolConformanceTest (the interpreter half).
 * The run tables are in-memory SQLite, as in PlaybookDbTestCase.
 */

let d: SqliteDb;
let dir: string;
let state: PlaybookRunState;

beforeEach(() => {
  d = installSqliteDb();
  createRunTables(d);
  dir = tempDir();
  state = new PlaybookRunState(new PlaybookTranscript(dir));
});

const simpleDoc = () => PlaybookDocument.fromArray({ title: 'T', trigger: { kind: 'request', description: 'd' }, instructions: '#Resolve Request.' });
const rows = (q: string, ...p: any[]) => d.prepare(q).all(...p) as any[];

// ---- PlaybookDocument ----

test('document: fromArray defaults the policy', () => {
  const doc = PlaybookDocument.fromArray({
    title: 'T', trigger: { kind: 'request', description: 'x' }, instructions: 'Do #Foo.', tools_used: ['Okta'],
    actions_used: ['#Foo'], bindings: { '#Foo': 'okta.foo' },
  });
  assert.equal(doc.title, 'T');
  assert.equal(doc.policy.writes_enabled, false);
  assert.equal(doc.policy.on_unbound, 'handoff');
  assert.equal(doc.policy.on_failure, 'continue_then_handoff');
  assert.deepEqual(doc.bindings, { '#Foo': 'okta.foo' });
});

test('document: fromConsoleText parses the sections', () => {
  const doc = PlaybookDocument.fromConsoleText('Title: Okta Password / MFA Reset\n\nTrigger: Requester reports being locked out.\n\n'
    + 'Instructions: #Search Okta User by Email for the requester. #Resolve Request.\n\nTools used: Okta\n\n'
    + 'Actions used: #Search Okta User by Email; #Resolve Request');
  assert.equal(doc.title, 'Okta Password / MFA Reset');
  assert.equal(doc.trigger.kind, 'request');
  assert.match(doc.trigger.description, /locked out/);
  assert.match(doc.instructions, /#Search Okta User by Email/);
  assert.deepEqual(doc.toolsUsed, ['Okta']);
  assert.deepEqual(doc.actionsUsed, ['#Search Okta User by Email', '#Resolve Request']);
  assert.deepEqual(doc.bindings, {});
  assert.deepEqual(doc.toArray().bindings, []);
});

test('document: section headers tolerate list markers and markdown', () => {
  const doc = PlaybookDocument.fromConsoleText('## Title: Time Off\n\n**Trigger:** Requester asks for PTO.\n\n'
    + '1. Instructions: Parse start date.\n2. #Lookup Users on the requester.\n- Tools used: Slack; Workday\n\nActions used: #Lookup Users');
  assert.equal(doc.title, 'Time Off');
  assert.equal(doc.trigger.description, 'Requester asks for PTO.');
  assert.ok(doc.instructions.startsWith('1. Parse start date.\n2. #Lookup Users'));
  assert.deepEqual(doc.toolsUsed, ['Slack', 'Workday']);
  assert.deepEqual(doc.actionsUsed, ['#Lookup Users']);
});

test('document: the domain field', () => {
  assert.equal(PlaybookDocument.fromArray({ title: 'T', instructions: '#Resolve Request.', domain: 'an HR benefits desk' }).domain, 'an HR benefits desk');
  assert.equal(PlaybookDocument.fromConsoleText('Title: T\n\nDomain: a finance operations team\n\nTrigger: y\n\nInstructions: #Resolve Request.').domain,
    'a finance operations team');
  assert.equal(PlaybookDocument.fromArray({ title: 'T', instructions: '#Resolve Request.' }).domain, '');
});

test('document: a missing section is named with what was found', () => {
  assert.throws(() => PlaybookDocument.fromConsoleText('Title: T\n\nTrigger: y\n\nSteps: do things\n\nActions used: #Resolve Request'), (e: any) => {
    assert.ok(e instanceof InvalidPlaybookError);
    assert.match(e.message, /Missing "Instructions:" section/);
    assert.match(e.message, /Recognized sections: Title, Trigger, Actions used/);
    return true;
  });
  assert.throws(() => PlaybookDocument.fromArray({ instructions: 'x' }), InvalidPlaybookError);
  assert.throws(() => PlaybookDocument.fromArray({}), /missing the required "title" and "instructions" fields/);
});

// ---- PlaybookAnalyzer ----

const mfaDoc = (over: Record<string, any> = {}) => PlaybookDocument.fromArray({
  title: 'MFA', trigger: { kind: 'request', description: 'locked out' },
  instructions: '#Search Okta User by Email first. Medium risk: #Request Approval from manager. '
    + 'High: #Prompt for Handoff to security. Then #Reset Password (Okta). '
    + '#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.',
  tools_used: ['Okta'],
  actions_used: ['#Search Okta User by Email', '#Request Approval', '#Prompt for Handoff',
    '#Reset Password (Okta)', '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
  bindings: { '#Search Okta User by Email': 'okta.search_users', '#Reset Password (Okta)': 'okta.reset_password', '#Reset User Factors (Custom)': null },
  ...over,
});
const byName = (r: any) => Object.fromEntries(r.actions.map((a: any) => [a.name, a]));

test('analyzer: classification', () => {
  const r = new PlaybookAnalyzer().analyze(mfaDoc(), ['okta.search_users', 'okta.reset_password']);
  const b = byName(r);
  assert.equal(b['#Search Okta User by Email'].kind, 'bound');
  assert.equal(b['#Search Okta User by Email'].target, 'okta.search_users');
  assert.equal(b['#Request Approval'].kind, 'native');
  assert.equal(b['#Resolve Request'].kind, 'native');
  assert.equal(b['#Reset User Factors (Custom)'].kind, 'unbound');
  assert.ok(r.gates.includes('approval'));
  assert.ok(r.gates.includes('handoff'));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.length > 0);
});

test('analyzer: a dangling binding is an error', () => {
  const r = new PlaybookAnalyzer().analyze(mfaDoc(), ['okta.search_users']);
  assert.ok(r.errors.length > 0);
  assert.match(r.errors[0], /#Reset Password \(Okta\)/);
});

test('analyzer: messages point at the faulty step', () => {
  const doc = PlaybookDocument.fromArray({
    title: 'T', trigger: { kind: 'request', description: 'x' },
    instructions: '1. Greet.\n2. #Reset Password (Okta) for the user.\n3. #Slack Pin Message on it.\n- then #Sub Bullet Action too\n4. #Resolve Request.',
    actions_used: ['#Reset Password (Okta)', '#Resolve Request', '#Never Used'],
    bindings: { '#Reset Password (Okta)': 'okta.reset_password', '#Never Used': null },
  });
  const r = new PlaybookAnalyzer().analyze(doc, []);
  assert.ok(r.errors[0].includes('step 2: "2. #Reset Password (Okta) for the user."'));
  const unlisted = r.warnings.filter((w) => w.includes('#Slack Pin Message'));
  assert.equal(unlisted.length, 1);
  assert.ok(unlisted[0].includes('not listed under "Actions used"'));
  assert.ok(unlisted[0].includes('step 3:'));
  const sub = r.warnings.filter((w) => w.includes('#Sub Bullet Action'));
  assert.ok(sub[0].includes('step 3, line 4: "- then #Sub Bullet Action too"'));
  assert.ok(r.notices.join('\n').includes('#Never Used is listed under "Actions used" but never appears'));
  assert.ok(!r.warnings.join('\n').includes('#Resolve Request is used'));
});

test('analyzer: the checklist keeps prose order, overlapping names included', () => {
  const r = new PlaybookAnalyzer().analyze(mfaDoc(), ['okta.search_users', 'okta.reset_password']);
  assert.equal(r.checklist[0], '#Search Okta User by Email');
  assert.equal(r.checklist[r.checklist.length - 1], '#Resolve Request');
  const doc = PlaybookDocument.fromArray({
    title: 'Overlap', trigger: { kind: 'request', description: 'd' },
    instructions: '#Reset User Factors (Custom) if the device is lost. Separately, later, #Reset User Factor for legacy systems. #Resolve Request.',
    actions_used: ['#Reset User Factor', '#Reset User Factors (Custom)', '#Resolve Request'],
    bindings: { '#Reset User Factor': null, '#Reset User Factors (Custom)': null },
  });
  assert.deepEqual(new PlaybookAnalyzer().analyze(doc, []).checklist, ['#Reset User Factors (Custom)', '#Reset User Factor', '#Resolve Request']);
});

test('analyzer: auto-binding from Console text with no bindings', () => {
  const doc = PlaybookDocument.fromArray({
    title: 'MFA', trigger: { kind: 'request', description: 'locked out' },
    instructions: '#Search Okta User by Email first. #Search Okta System Log Custom next. '
      + '#List User Factors. Then #Reset Password (Okta) or #Reset User Factor. '
      + '#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.',
    tools_used: ['Okta'],
    actions_used: ['#Search Okta User by Email', '#Search Okta System Log Custom', '#List User Factors', '#Reset Password (Okta)',
      '#Reset User Factor', '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
  });
  const tools = ['okta.search_users', 'okta.search_system_log', 'okta.list_user_factors', 'okta.verify_security_answers',
    'okta.reset_password', 'okta.reset_factor', 'okta.unlock_user'];
  const r = new PlaybookAnalyzer().analyze(doc, tools);
  const b = byName(r);
  assert.equal(b['#Search Okta User by Email'].kind, 'bound');
  assert.equal(b['#Search Okta User by Email'].target, 'okta.search_users');
  assert.equal(b['#Search Okta User by Email'].auto, true);
  assert.equal(b['#Search Okta System Log Custom'].target, 'okta.search_system_log');
  assert.equal(b['#List User Factors'].target, 'okta.list_user_factors');
  assert.equal(b['#Reset Password (Okta)'].target, 'okta.reset_password');
  assert.equal(b['#Reset User Factor'].target, 'okta.reset_factor');
  assert.equal(b['#Reset User Factors (Custom)'].target, 'okta.reset_factor');
  assert.equal(b['#Leave Internal Note'].kind, 'native');
  assert.deepEqual(r.errors, []);
  assert.ok(r.notices.some((n) => n.includes('Auto-bound')));
  assert.ok(!r.warnings.some((w) => w.includes('Auto-bound')));
});

test('analyzer: an explicit null binding is not auto-bound; no overlap stays unbound', () => {
  const nullDoc = PlaybookDocument.fromArray({
    title: 'T', instructions: '#Reset User Factors (Custom) then #Resolve Request.',
    actions_used: ['#Reset User Factors (Custom)', '#Resolve Request'], bindings: { '#Reset User Factors (Custom)': null },
  });
  assert.equal(byName(new PlaybookAnalyzer().analyze(nullDoc, ['okta.reset_factor']))['#Reset User Factors (Custom)'].kind, 'unbound');
  const vague = PlaybookDocument.fromArray({ title: 'T', instructions: '#Do Thing then #Resolve Request.', actions_used: ['#Do Thing', '#Resolve Request'] });
  assert.equal(byName(new PlaybookAnalyzer().analyze(vague, ['okta.reset_password', 'okta.reset_factor']))['#Do Thing'].kind, 'unbound');
});

test('analyzer: agent bindings', () => {
  const doc = mfaDoc({ bindings: { '#Search Okta User by Email': 'agent.researcher', '#Reset Password (Okta)': 'okta.reset_password', '#Reset User Factors (Custom)': null } });
  assert.equal(byName(new PlaybookAnalyzer().analyze(doc, ['okta.reset_password'], ['researcher']))['#Search Okta User by Email'].kind, 'bound');
  assert.ok(new PlaybookAnalyzer().analyze(doc, ['okta.reset_password'], []).errors.length > 0);
});

// ---- PlaybookRunState / PlaybookTranscript ----

test('run state: create, status, replay guard, sensitive redaction, transcript', async () => {
  const id = await state.createRun(1, simpleDoc(), { email: 'low@test' }, []);
  assert.equal((await state.getRun(id)).status, 'running');
  await state.setStatus(id, 'resolved');
  assert.equal((await state.getRun(id)).status, 'resolved');

  await state.ledgerAppend(id, 0, '#Reset Password (Okta)', 'okta.reset_password', { user_id: 'u1', send_email: true }, 'ok', 'done');
  assert.notEqual(await state.ledgerFindOk(id, 'okta.reset_password', { send_email: true, user_id: 'u1' }), null, 'key order does not matter');
  assert.equal(await state.ledgerFindOk(id, 'okta.reset_password', { user_id: 'OTHER' }), null);
  assert.equal(await state.ledgerFindOk(id + 1, 'okta.reset_password', { user_id: 'u1', send_email: true }), null);

  await state.ledgerAppend(id, 0, '#Get Key', 'okta.get_key', { secret: 'ABC' }, 'ok', 'key=ABC', true);
  const row = (await state.ledgerAll(id))[1];
  assert.equal(row.args, '"«redacted»"');
  assert.equal(row.result_summary, '«redacted»');
  assert.equal(row.seq, 2);

  const t = new PlaybookTranscript(dir);
  t.append(id, { type: 'leg_started', leg: 0 });
  t.append(id, { type: 'tool_call', tool: 'okta.search_users' });
  const events = t.read(id);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'leg_started');
  assert.ok('ts' in events[0]);
});

// ---- PlaybookNativeTools ----

test('native tools: definitions and each verb', async () => {
  const native = new PlaybookNativeTools(state);
  assert.deepEqual(native.definitions().map((x) => x.function.name),
    ['send_direct_message', 'send_channel_message', 'send_email', 'leave_internal_note', 'set_priority', 'resolve_request']);
  const id = await state.createRun(1, simpleDoc(), [], []);
  assert.deepEqual(await native.execute(id, 0, 'send_direct_message', { text: 'Hello user' }), { ok: true });
  await native.execute(id, 0, 'send_direct_message', { text: 'secret', sensitive: true });
  await native.execute(id, 0, 'send_channel_message', { channel: 'general', text: 'Channel message' });
  await native.execute(id, 0, 'send_email', { to: 'user@example.com', subject: 's', text: 'Email body' });
  const msgs = rows('SELECT * FROM playbook_run_messages WHERE run_id = ? ORDER BY id', id);
  assert.deepEqual(msgs.map((m) => [m.direction, m.audience, m.text, Number(m.sensitive)]), [
    ['to_requester', null, 'Hello user', 0],
    ['to_requester', null, '«redacted»', 1],
    ['to_channel', 'general', 'Channel message', 0],
    ['to_email', 'user@example.com', 'Email body', 0],
  ]);
  await native.execute(id, 0, 'leave_internal_note', { text: 'Internal note' });
  await native.execute(id, 0, 'set_priority', { priority: 'high', reason: 'VIP' });
  const notes = rows('SELECT * FROM playbook_run_notes WHERE run_id = ? ORDER BY id', id);
  assert.deepEqual(notes.map((n) => [n.author, n.text]), [['agent', 'Internal note'], ['agent', 'priority → high: VIP']]);
  assert.deepEqual(await native.execute(id, 0, 'resolve_request', { outcome: 'ok', summary: 's' }), { ok: true, terminal: true });
  assert.equal((await state.getRun(id)).status, 'resolved');
  assert.deepEqual(await native.execute(id, 0, 'nope', {}), { ok: false, error: 'Unknown tool: nope' });
});

// ---- PlaybookActionSpace ----

const spaceActions = () => [
  { name: '#Search Okta User by Email', kind: 'bound', target: 'okta.search_users' },
  { name: '#Reset Okta Password', kind: 'bound', target: 'okta.reset_password' },
  { name: '#Reset User Factors Custom', kind: 'unbound', target: null },
  { name: '#Resolve Request', kind: 'native', target: 'resolve_request' },
];
const makeSpace = (actions: any[], mcp: FakeMcpExecutor, policy: Record<string, any> = {}, gates: GateManager | null = null) =>
  new PlaybookActionSpace(actions, new PlaybookNativeTools(state), mcp, state, { writes_enabled: false, on_unbound: 'prompt_handoff', ...policy }, gates);

test('action space: definitions include bound and unbound', () => {
  const defs = makeSpace(spaceActions(), new FakeMcpExecutor()).toolDefinitions();
  const names = defs.map((x) => x.function.name);
  assert.ok(names.includes('okta__search_users'));
  assert.ok(names.includes('unbound__reset_user_factors_custom'));
  assert.ok(names.includes('resolve_request'));
  const search = defs[names.indexOf('okta__search_users')];
  assert.match(search.function.description, /#Search Okta User by Email/);
  assert.deepEqual(search.function.parameters.properties, { email: { type: 'string' } });
  const unbound = defs[names.indexOf('unbound__reset_user_factors_custom')];
  assert.match(unbound.function.description, /NOT AVAILABLE/);
  assert.deepEqual(unbound.function.parameters, { type: 'object', properties: [] });
});

test('action space: dispatch, whitelist, replay guard, reads, write policy', async () => {
  let mcp = new FakeMcpExecutor();
  let space = makeSpace(spaceActions(), mcp);
  let id = await state.createRun(1, simpleDoc(), [], []);
  assert.equal((await space.execute(id, 0, 'some_made_up_tool', {})).ok, false);
  assert.equal((await state.ledgerAll(id))[0].outcome, 'skipped');

  const r = await space.execute(id, 0, 'okta__search_users', { email: 'a@b.com' });
  assert.equal(r.ok, true);
  assert.deepEqual(mcp.calls[0], { server: 'okta', tool: 'search_users', args: { email: 'a@b.com' } });
  assert.equal((await state.ledgerAll(id))[1].tool, 'okta.search_users');
  // a read re-executes
  const again = await space.execute(id, 1, 'okta__search_users', { email: 'a@b.com' });
  assert.equal(again.outcome, undefined);
  assert.equal(mcp.calls.length, 2);

  // writes disabled
  const blocked = await space.execute(id, 0, 'okta__reset_password', { user_id: '123' });
  assert.deepEqual(blocked, { ok: false, error: 'writes disabled by policy' });
  assert.equal(mcp.calls.length, 2);

  // writes enabled + replay guard
  mcp = new FakeMcpExecutor();
  space = makeSpace(spaceActions(), mcp, { writes_enabled: true });
  id = await state.createRun(1, simpleDoc(), [], []);
  assert.equal((await space.execute(id, 0, 'okta__reset_password', { user_id: '123' })).ok, true);
  const second = await space.execute(id, 1, 'okta__reset_password', { user_id: '123' });
  assert.equal(second.outcome, 'replayed');
  assert.equal(mcp.calls.length, 1);
  assert.deepEqual((await state.ledgerAll(id)).map((x) => x.outcome), ['ok', 'replayed']);
});

test('action space: lookup and namespaced list are reads; an unknown verb fails closed', async () => {
  const mcp = new FakeMcpExecutor();
  const space = makeSpace([...spaceActions(),
    { name: '#Lookup Users', kind: 'bound', target: 'okta.lookup_users' },
    { name: '#List IAM Policies', kind: 'bound', target: 'aws.iam_list_attached_user_policies' },
    { name: '#Deactivate Okta User', kind: 'bound', target: 'okta.deactivate_user' }], mcp);
  const id = await state.createRun(1, simpleDoc(), [], []);
  assert.equal((await space.execute(id, 0, 'okta__lookup_users', { email: 'a@b.com' })).ok, true);
  assert.equal((await space.execute(id, 0, 'aws__iam_list_attached_user_policies', { user_name: 'a' })).ok, true);
  assert.deepEqual(await space.execute(id, 0, 'okta__deactivate_user', { user_id: '1' }), { ok: false, error: 'writes disabled by policy' });
  assert.equal(mcp.calls.length, 2);
});

test('action space: native verbs always run, never blocked, sensitive args redacted', async () => {
  const space = makeSpace([...spaceActions(), { name: '#Send Direct Message', kind: 'native', target: 'send_direct_message' }], new FakeMcpExecutor());
  const id = await state.createRun(1, simpleDoc(), [], []);
  assert.equal((await space.execute(id, 0, 'leave_internal_note', { text: 'noted' })).ok, true);
  assert.equal((await space.execute(id, 0, 'send_direct_message', { text: 'Secret token 12345', sensitive: true })).ok, true);
  assert.equal((await space.execute(id, 0, 'resolve_request', { outcome: 'success', summary: 'done' })).ok, true);
  const ledger = await state.ledgerAll(id);
  assert.deepEqual(ledger.map((x) => [x.tool, x.outcome]), [['leave_internal_note', 'ok'], ['send_direct_message', 'ok'], ['resolve_request', 'ok']]);
  assert.equal(Number(ledger[1].sensitive), 1);
  assert.ok(!String(ledger[1].args).includes('Secret token'));
  assert.ok(String(ledger[1].args).includes('«redacted»'));
  assert.equal(ledger[1].result_summary, '«redacted»');
  assert.equal(ledger[1].action_name, '#Send Direct Message');
});

test('action space: the unbound policies', async () => {
  for (const [policy, check] of [
    ['prompt_handoff', (r: any) => { assert.equal(r.policy, 'prompt_handoff'); assert.match(r.guidance, /hand off to a human/); }],
    ['skip', (r: any) => { assert.equal(r.skipped, true); assert.match(r.guidance, /skip it/); }],
    ['fail', (r: any) => { assert.equal(r.fatal, true); assert.match(r.guidance, /fail/); }],
  ] as const) {
    const space = makeSpace(spaceActions(), new FakeMcpExecutor(), { on_unbound: policy });
    const id = await state.createRun(1, simpleDoc(), [], []);
    const r = await space.execute(id, 0, 'unbound__reset_user_factors_custom', {});
    assert.equal(r.ok, false);
    assert.equal(r.unbound, true);
    check(r);
    assert.equal((await state.ledgerAll(id))[0].outcome, 'skipped');
  }
  const agent = makeSpace([{ name: '#Escalate to Triage Agent', kind: 'bound', target: 'agent.triage' }], new FakeMcpExecutor());
  assert.ok(agent.toolDefinitions().map((x) => x.function.name).includes('unbound__escalate_to_triage_agent'));
  const id = await state.createRun(1, simpleDoc(), [], []);
  assert.equal((await agent.execute(id, 0, 'unbound__escalate_to_triage_agent', {})).unbound, true);
});

test('action space: a gate timeout is ledgered as failed', async () => {
  const gates = new GateManager(state, new FakeGateBridge([]));
  const space = makeSpace(spaceActions(), new FakeMcpExecutor(), {}, gates);
  const id = await state.createRun(1, simpleDoc(), [], []);
  const r = await space.execute(id, 0, 'request_approval', { approver: 'mgr', question: 'reset the password?' });
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true);
  assert.equal(r.gate, true);
  const ledger = await state.ledgerAll(id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].outcome, 'failed');
  assert.match(String(ledger[0].result_summary), /timeout/);
});

// ---- GateManager ----

const gateDoc = () => PlaybookDocument.fromArray({
  title: 'T', instructions: 'Ask for approval, then reset the password. Stop when resolved.',
  policy: { writes_enabled: true, on_unbound: 'prompt_handoff' },
});
const lastGate = (runId: number) => rows('SELECT * FROM playbook_run_gates WHERE run_id = ? ORDER BY id DESC LIMIT 1', runId)[0];

test('gates: an approved approval moves the status and closes the gate with the actor', async () => {
  const id = await state.createRun(1, gateDoc(), { id: 'req1' }, []);
  const answer = { decision: 'approved', comment: 'looks fine', actor: 'mgr@example.com' };
  let during: string | null = null;
  const gm = new GateManager(state, new FakeGateBridge([answer], async () => { during = (await state.getRun(id)).status; }));
  const result = await gm.execute(id, 0, 'request_approval', { approver: 'mgr', question: 'reset the password?', context: 'locked out' });
  assert.deepEqual(result, { ok: true, decision: answer });
  assert.equal(during, 'awaiting_approval');
  assert.equal((await state.getRun(id)).status, 'running');
  const row = lastGate(id);
  assert.equal(row.kind, 'approval');
  assert.equal(row.asked_of, 'approver');
  assert.notEqual(row.closed_at, null);
  assert.equal(row.actor, 'mgr@example.com');
  assert.deepEqual(JSON.parse(row.decision), answer);
});

test('gates: unattended ends the leg without asking', async () => {
  const id = await state.createRun(1, gateDoc(), { id: 'req1' }, []);
  const bridge = new FakeGateBridge([]);
  const result = await new GateManager(state, bridge, 900000, true).execute(id, 0, 'request_approval', { summary: 'x' });
  assert.deepEqual(result, { ok: false, gate_ended_leg: true, unattended: true, kind: 'approval' });
  assert.deepEqual(bridge.calls, []);
  assert.equal((await state.getRun(id)).status, 'handed_off');
  assert.deepEqual(JSON.parse(lastGate(id).decision), { decision: 'unattended' });
});

test('gates: a timeout returns guidance and closes the gate', async () => {
  const id = await state.createRun(1, gateDoc(), { id: 'req1' }, []);
  const result = await new GateManager(state, new FakeGateBridge([])).execute(id, 0, 'request_approval', { approver: 'mgr', question: 'q?' });
  assert.deepEqual(result, { ok: false, timeout: true, guidance: 'No human answered in time. Leave an internal note and resolve as uncompleted.' });
  assert.deepEqual(JSON.parse(lastGate(id).decision), { decision: 'timeout' });
  assert.equal((await state.getRun(id)).status, 'running');
});

test('gates: a sensitive form field is redacted when stored, intact when returned', async () => {
  const id = await state.createRun(1, gateDoc(), { id: 'req1' }, []);
  const answer = { password: 'hunter2', username: 'bob', actor: 'req1' };
  const result = await new GateManager(state, new FakeGateBridge([answer])).execute(id, 0, 'trigger_form', {
    prompt: 'Set your new password',
    fields: [{ name: 'password', label: 'New password', type: 'text', sensitive: true }, { name: 'username', label: 'Username', type: 'text' }],
  });
  assert.deepEqual(result.decision, answer);
  const stored = JSON.parse(lastGate(id).decision);
  assert.equal(stored.password, GateManager.REDACTED);
  assert.equal(stored.username, 'bob');
});

test('gates: the interpreter runs the approval before the reset and feeds the decision forward', async () => {
  const mcp = new FakeMcpExecutor();
  const gates = new GateManager(state, new FakeGateBridge([{ decision: 'approved', comment: 'go ahead', actor: 'mgr@example.com' }]));
  const space = new PlaybookActionSpace([
    { name: '#Reset Okta Password', kind: 'bound', target: 'okta.reset_password' },
    { name: '#Resolve Request', kind: 'native', target: 'resolve_request' },
  ], new PlaybookNativeTools(state), mcp, state, { writes_enabled: true, on_unbound: 'prompt_handoff' }, gates);
  const doc = gateDoc();
  const id = await state.createRun(1, doc, { id: 'req1' }, []);
  const captured: any[][] = [];
  const llm = scriptedLlm([
    [{ name: 'request_approval', arguments: { approver: 'mgr', question: 'reset password for u1?' } }],
    [{ name: 'okta__reset_password', arguments: { user_id: 'u1' } }],
    [{ name: 'resolve_request', arguments: { outcome: 'success', summary: 'reset after approval' } }],
  ], captured);
  const result = await new PlaybookInterpreter(space, state, new PlaybookTranscript(dir), llm, 40).runLeg(id, 0, doc, [], { id: 'req1' }, 'Reset u1');
  assert.equal(result.status, 'resolved');
  const ledger = await state.ledgerAll(id);
  assert.deepEqual(ledger.map((x) => x.tool), ['request_approval', 'okta.reset_password', 'resolve_request']);
  assert.equal(ledger[0].outcome, 'ok');
  assert.equal(captured.length, 3);
  const toolMsg = captured[1].find((m) => m.role === 'tool' && m.name === 'request_approval');
  const decoded = JSON.parse(toolMsg.content);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.gate, true);
  assert.equal(decoded.decision.decision, 'approved');
  assert.equal(decoded.decision.actor, 'mgr@example.com');
});

// ---- PlaybookInterpreter ----

const interpDoc = () => PlaybookDocument.fromArray({
  title: 'Password Reset', trigger: { kind: 'request', description: 'user locked out' },
  instructions: 'Search for the user. Check their recent activity and factors. Verify their identity with security questions. '
    + 'Reset the password and email them. Tell the requester it is done. Stop when resolved.',
  policy: { writes_enabled: true, on_unbound: 'prompt_handoff' },
});
const interpSpace = (mcp = new FakeMcpExecutor()) => new PlaybookActionSpace([
  { name: '#Search Okta User by Email', kind: 'bound', target: 'okta.search_users' },
  { name: '#Search Okta System Log', kind: 'bound', target: 'okta.search_system_log' },
  { name: '#List User Factors', kind: 'bound', target: 'okta.list_user_factors' },
  { name: '#Verify Security Answers', kind: 'bound', target: 'okta.verify_security_answers' },
  { name: '#Reset Okta Password', kind: 'bound', target: 'okta.reset_password' },
  { name: '#Send Direct Message', kind: 'native', target: 'send_direct_message' },
  { name: '#Leave Internal Note', kind: 'native', target: 'leave_internal_note' },
  { name: '#Resolve Request', kind: 'native', target: 'resolve_request' },
], new PlaybookNativeTools(state), mcp, state, { writes_enabled: true, on_unbound: 'prompt_handoff' });

test('interpreter: a T-shaped scenario resolves in order, with transcript and message event', async () => {
  const doc = interpDoc();
  const id = await state.createRun(1, doc, { id: 'req1' }, []);
  const events: any[] = [];
  const captured: any[][] = [];
  const llm = scriptedLlm([
    [{ name: 'okta__search_users', arguments: { email: 'a@b.com' } }],
    [{ name: 'okta__search_system_log', arguments: { user_id: 'u1' } }, { name: 'okta__list_user_factors', arguments: { user_id: 'u1' } }],
    [{ name: 'okta__verify_security_answers', arguments: { user_id: 'u1', answers: ['a', 'b'] } }],
    [{ name: 'okta__reset_password', arguments: { user_id: 'u1', send_email: true } }],
    [{ name: 'send_direct_message', arguments: { text: 'Your password has been reset.', sensitive: true } }],
    [{ name: 'leave_internal_note', arguments: { text: 'Reset password for u1 after verifying identity.' } },
      { name: 'resolve_request', arguments: { outcome: 'success', summary: 'Password reset and requester notified.' } }],
  ], captured);
  const transcript = new PlaybookTranscript(dir);
  const result = await new PlaybookInterpreter(interpSpace(), state, transcript, llm, 40, (e) => events.push(e))
    .runLeg(id, 0, doc, [], { id: 'req1' }, 'I am locked out of my account.');
  assert.equal(result.status, 'resolved');
  const ledger = await state.ledgerAll(id);
  assert.deepEqual(ledger.map((x) => x.tool), ['okta.search_users', 'okta.search_system_log', 'okta.list_user_factors',
    'okta.verify_security_answers', 'okta.reset_password', 'send_direct_message', 'leave_internal_note', 'resolve_request']);
  assert.ok(String(ledger[4].args).includes('"send_email":true'));

  const tr = transcript.read(id);
  assert.equal(tr[0].type, 'leg_started');
  assert.equal(tr[tr.length - 1].type, 'leg_ended');
  assert.equal(tr[1].type, 'prompt');
  assert.equal(tr[1].text, 'I am locked out of my account.');

  const msgs = events.filter((e) => e.type === 'message');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Your password has been reset.');
  assert.equal(msgs[0].sensitive, true);
  const dbMsg = rows('SELECT text, sensitive FROM playbook_run_messages WHERE run_id = ?', id)[0];
  assert.equal(Number(dbMsg.sensitive), 1);
  assert.ok(!dbMsg.text.includes('Your password has been reset.'));

  const expected = `You are a playbook interpreter for this organization. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
${doc.instructions}
POLICY: ${JSON.stringify(doc.policy)}
REQUESTER: {"id":"req1"}
APPROVERS: {}`;
  assert.equal(captured[0][0].role, 'system');
  assert.equal(captured[0][0].content, expected);
  assert.equal(captured[0][1].content, 'REQUEST:\nI am locked out of my account.');
});

test('interpreter: the resolve summary is the result, not the narration', async () => {
  for (const [summary, expected] of [['SCTASK0000101 - low@test - completed', 'SCTASK0000101 - low@test - completed'], ['  ', "Now I'll document the completion and resolve:"]]) {
    const doc = interpDoc();
    const id = await state.createRun(1, doc, { id: 'req1' }, []);
    const llm = async () => ({ text: "Now I'll document the completion and resolve:", tool_calls: [{ id: 'c1', name: 'resolve_request', arguments: { outcome: 'completed', summary } }] });
    const result = await new PlaybookInterpreter(interpSpace(), state, new PlaybookTranscript(dir), llm, 40).runLeg(id, 0, doc, [], { id: 'req1' }, 'job');
    assert.equal(result.status, 'resolved');
    assert.equal(result.output, expected);
  }
});

test('interpreter: an exhausted round budget fails the run and leaves a note', async () => {
  const doc = interpDoc();
  const id = await state.createRun(1, doc, { id: 'req1' }, []);
  const llm = async () => ({ text: null, tool_calls: [{ id: 'call_x', name: 'leave_internal_note', arguments: { text: 'still working' } }] });
  const result = await new PlaybookInterpreter(interpSpace(), state, new PlaybookTranscript(dir), llm, 2).runLeg(id, 0, doc, [], { id: 'req1' }, 'Help me.');
  assert.equal(result.status, 'failed');
  assert.equal((await state.getRun(id)).status, 'failed');
  const notes = rows('SELECT text FROM playbook_run_notes WHERE run_id = ? ORDER BY id', id).map((n) => n.text);
  assert.equal(notes.length, 3);
  assert.match(notes[2].toLowerCase(), /exhausted/);
});

test("interpreter: round 2's messages carry round 1's tool result", async () => {
  const doc = interpDoc();
  const id = await state.createRun(1, doc, { id: 'req1' }, []);
  const captured: any[][] = [];
  const llm = scriptedLlm([
    [{ name: 'okta__search_users', arguments: { email: 'a@b.com' } }],
    [{ name: 'resolve_request', arguments: { outcome: 'success', summary: 'done' } }],
  ], captured);
  const result = await new PlaybookInterpreter(interpSpace(), state, new PlaybookTranscript(dir), llm, 40).runLeg(id, 0, doc, [], { id: 'req1' }, 'Find this user.');
  assert.equal(result.status, 'resolved');
  assert.equal(captured.length, 2);
  const roles = captured[1].map((m) => m.role);
  assert.ok(roles.includes('assistant'));
  const assistant = captured[1].find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'okta__search_users', arguments: '{"email":"a@b.com"}' } });
  const tool = captured[1].find((m) => m.role === 'tool');
  assert.equal(tool.name, 'okta__search_users');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(typeof JSON.parse(tool.content), 'object');
});

// ---- adapters ----

test('WorkflowLlmClient flattens the nested tool shape and normalizes tool calls', async () => {
  assert.deepEqual(WorkflowLlmClient.flattenToolDefs([{
    type: 'function', function: { name: 'leave_internal_note', description: 'Leave an internal note on the run',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  }]), [{ name: 'leave_internal_note', description: 'Leave an internal note on the run',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]);
  assert.deepEqual(WorkflowLlmClient.flattenToolDefs([{ type: 'function', function: { name: 'bare_tool' } }]),
    [{ name: 'bare_tool', description: '', input_schema: { type: 'object', properties: [] } }]);
  const flat = [{ name: 'okta__search_users', description: 'Search', input_schema: { type: 'object', properties: {} } }];
  assert.deepEqual(WorkflowLlmClient.flattenToolDefs(flat), flat);

  assert.deepEqual(WorkflowLlmClient.normalizeToolCalls([
    { id: 'a', function: { name: 'x', arguments: '{"k":1}' } },
    { id: 'b', name: 'y', input: { k: 2 } },
  ]), [{ id: 'a', name: 'x', arguments: { k: 1 } }, { id: 'b', name: 'y', arguments: { k: 2 } }]);

  // One round: every tool declared client-side; the model's tool calls come back unexecuted.
  let seen: any = null;
  const client = new WorkflowLlmClient({ agent_provider: '', provider: 'claude', model: 'm' }, async (provider, model) => {
    seen = { provider, model };
    return {
      chat: async (opts: any) => {
        seen.opts = opts;
        return { text: '', usage: {}, model: 'm', provider: 'claude', pending_client_tool_call: true, pending_tool_calls: [{ id: 't1', name: 'resolve_request', input: { summary: 's' } }] };
      },
    } as any;
  });
  const out = await client.invoke([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'REQUEST:\nx' }],
    [{ type: 'function', function: { name: 'resolve_request', description: 'd', parameters: { type: 'object' } } }]);
  assert.deepEqual(seen.provider, 'claude', 'an empty agent_provider falls back to provider');
  assert.equal(seen.opts.system_prompt, 'SYS');
  assert.deepEqual(seen.opts.conversation_history, [{ role: 'user', content: 'REQUEST:\nx' }]);
  assert.deepEqual(seen.opts.client_tool_names, ['resolve_request']);
  assert.deepEqual(out.tool_calls, [{ id: 't1', name: 'resolve_request', arguments: { summary: 's' } }]);

  const failing = new WorkflowLlmClient({}, async () => ({ chat: async () => { throw new Error('boom'); } }) as any);
  await assert.rejects(failing.invoke([], []), /LLM call failed: boom/);
});

test('LoaderMcpExecutor keys tools by server slug and maps loader errors', async () => {
  let reply: any = { content: [{ type: 'text', text: 'ok' }] };
  const calls: any[] = [];
  const loader: any = {
    getTools: () => new Map([['mcp_search_users', {
      original_name: 'search_users', server_name: 'Okta', description: 'Find an Okta user by email address.',
      input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    }]]),
    executeTool: async (name: string, args: any) => { calls.push([name, args]); return reply; },
  };
  const ex = new LoaderMcpExecutor(loader);
  const tools = ex.availableTools();
  assert.equal(tools['okta.search_users'].description, 'Find an Okta user by email address.');
  assert.deepEqual(tools['okta.search_users'].input_schema.required, ['email']);
  assert.deepEqual(await ex.call('okta', 'search_users', { email: 'x' }), { ok: true, result: reply });
  assert.deepEqual(calls[0], ['mcp_search_users', { email: 'x' }]);
  reply = { error: true, message: "MCP tool 'search_users' not found" };
  assert.deepEqual(await ex.call('okta', 'search_users', { email: 'x' }), { ok: false, error: "MCP tool 'search_users' not found" });
  assert.deepEqual(await ex.call('okta', 'nope', {}), { ok: false, error: "MCP tool 'okta.nope' not found" });
});

// ---- the run protocol (RunProtocolConformanceTest, interpreter half) ----

test('the interpreter emits only events run-protocol-v1.json describes', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '../../backend/schema/run-protocol-v1.json'), 'utf8'));
  const schemaWords = ['array', 'boolean', 'function', 'integer', 'number', 'object', 'string'];
  const emitted = new Set<string>();
  const walk = (p: string) => {
    for (const f of fs.readdirSync(p)) {
      const full = path.join(p, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (f.endsWith('.ts')) for (const m of fs.readFileSync(full, 'utf8').matchAll(/\btype:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
    }
  };
  walk(path.join(__dirname, '../src/Playbook'));
  const types = [...emitted].filter((t) => !schemaWords.includes(t));
  assert.ok(types.length > 0, 'found no emitted event types — the scan path is wrong');
  assert.ok(types.includes('tool_skipped'));
  const known = [...Object.keys(contract.events), 'error', 'done'];
  for (const t of types) assert.ok(known.includes(t), `the interpreter emits '${t}', which run-protocol-v1.json does not describe`);
});
