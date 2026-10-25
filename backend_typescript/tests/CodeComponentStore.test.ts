import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insert, ports, POLL, TRIGGER } from './support/codeComponentsDb';
import type { Sqlite } from './support/sqliteSchemaDb';
import { CodeComponentStore } from '../src/CodeComponent/CodeComponentStore';
import { CodeComponentError } from '../src/CodeComponent/CodeComponentError';

/**
 * Twins of backend/tests/Unit/CodeComponent/CodeComponentStoreTest.php, CodeComponentExitRemapTest.php and
 * CodeComponentStartOptionTest.php, on an in-memory SQLite (tests/support/sqliteDb) as the PHP ones are.
 */

let d: Sqlite;
let store: CodeComponentStore;

beforeEach(() => {
  d = freshDb();
  store = new CodeComponentStore();
});

async function error(fn: () => Promise<unknown>): Promise<CodeComponentError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CodeComponentError) return e;
    throw e;
  }
  assert.fail('expected CodeComponentError');
}

// ---------------- CodeComponentStoreTest ----------------

test('store: save round-trips typed fields', async () => {
  const row = await store.save(3, null, POLL);
  assert.equal(typeof row.id, 'number');
  assert.deepEqual(row.exits, ['new_mail', 'no_mail', 'error']);
  assert.deepEqual(row.mcp_servers, ['Outlook']);
  assert.equal(row.timeout_s, 20);
  assert.equal((await store.get(3, row.id))!.code, POLL.code);
});

test('store: create with an existing name updates that row', async () => {
  const a = await store.save(3, null, POLL);
  const b = await store.save(3, null, { ...POLL, code: 'def run(i, c):\\n    return 2' });
  assert.equal(a.id, b.id);
  assert.equal((await store.list(3)).length, 1);
  assert.ok((await store.get(3, a.id))!.code.includes('return 2'));
});

test('store: rename onto another name is refused', async () => {
  await store.save(3, null, POLL);
  const other = await store.save(3, null, { ...POLL, name: 'Poll Support' });
  const e = await error(() => store.save(3, other.id, POLL));
  assert.equal(e.kind, 'name_taken');
  assert.equal(e.status, 409);
});

test('store: names are scoped per user', async () => {
  const mine = await store.save(3, null, POLL);
  const theirs = await store.save(4, null, POLL);
  assert.notEqual(mine.id, theirs.id);
  assert.equal(await store.get(3, theirs.id), null);
});

test('store: validation', async () => {
  for (const bad of [
    { ...POLL, name: '  ' },
    { ...POLL, exits: [] },
    { ...POLL, exits: ['Bad-Exit'] },
    { ...POLL, exits: ['a', 'a'] },
    { ...POLL, exits: Array.from({ length: 9 }, (_, i) => `e${i + 1}`) },
    { ...POLL, timeout_s: 0 },
    { ...POLL, timeout_s: 301 },
    { ...POLL, mcp_servers: 'Outlook' },
  ]) {
    const e = await error(() => store.save(3, null, bad));
    assert.equal(e.kind, 'invalid', JSON.stringify(bad));
    assert.equal(e.status, 422);
  }
  const { timeout_s: _t, description: _d, ...rest } = POLL;
  const row = await store.save(3, null, rest);
  assert.equal(row.timeout_s, 30);
  assert.equal(row.description, '');
});

test('store: update of an unknown id is not found', async () => {
  const e = await error(() => store.save(3, 99, POLL));
  assert.equal(e.kind, 'not_found');
  assert.equal(e.message, 'Code component #99 not found');
});

test('store: used-by and the delete guard', async () => {
  const id = (await store.save(3, null, POLL)).id;
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')");
  d.exec(`INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', '{"name":"Poll","code_component_id":${id}}')`);
  d.exec(`INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', '{"name":"Other","code_component_id":77}')`);
  d.exec(`INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'agent', '{"code_component_id":${id}}')`);
  assert.deepEqual(await store.usedBy(3, id), [{ workflow_id: 1, workflow_name: 'Mail triage', node_name: 'Poll' }]);
  assert.equal((await store.list(3))[0].used_by, 1);
  const e = await error(() => store.delete(3, id));
  assert.equal(e.kind, 'in_use');
  assert.ok(e.message.includes('Mail triage'));
  d.exec('DELETE FROM workflow_nodes');
  await store.delete(3, id);
  assert.equal(await store.get(3, id), null);
});

// ---------------- CodeComponentExitRemapTest ----------------

async function remapSetup(): Promise<number> {
  return (await store.save(3, null, POLL)).id;
}
const workflow = (userId: string, name: string) => insert(d, 'INSERT INTO agent_workflows (user_id, name) VALUES (?, ?)', userId, name);
const node = (wf: number, type: string, config: Record<string, any>) =>
  insert(d, 'INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)', wf, type, JSON.stringify(config));
const edge = (wf: number, from: number, to: number, fromPort: string, toPort = 'input_1') =>
  insert(d, 'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (?, ?, ?, ?, ?)',
    wf, from, to, fromPort, toPort);

/** A linked code node with one child per exit (output_1..output_3 to agents A, B, C). */
function linkedNodeWithThreeChildren(wf: number, cid: number): number[] {
  const code = node(wf, 'code', { name: 'Poll', code_component_id: cid });
  const a = node(wf, 'agent', {});
  const b = node(wf, 'agent', {});
  const c = node(wf, 'agent', {});
  return [edge(wf, code, a, 'output_1'), edge(wf, code, b, 'output_2'), edge(wf, code, c, 'output_3')];
}
const saveExits = (cid: number, exits: string[]) => store.save(3, cid, { ...POLL, exits });

test('remap: a reorder swaps ports in every linked workflow', async () => {
  const cid = await remapSetup();
  const [e1, e2, e3] = linkedNodeWithThreeChildren(workflow('3', 'First'), cid);
  const [f1, f2, f3] = linkedNodeWithThreeChildren(workflow('3', 'Second'), cid);
  await saveExits(cid, ['no_mail', 'new_mail', 'error']);
  assert.deepEqual(ports(d), { [e1]: 'output_2', [e2]: 'output_1', [e3]: 'output_3', [f1]: 'output_2', [f2]: 'output_1', [f3]: 'output_3' });
});

test('remap: an insert keeps later exits on their names', async () => {
  const cid = await remapSetup();
  const [e1, e2, e3] = linkedNodeWithThreeChildren(workflow('3', 'First'), cid);
  await saveExits(cid, ['new_mail', 'skip', 'no_mail', 'error']);
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e2]: 'output_3', [e3]: 'output_4' });
});

test('remap: a removed exit drops its edges once confirmed', async () => {
  const cid = await remapSetup();
  const [e1, , e3] = linkedNodeWithThreeChildren(workflow('3', 'First'), cid);
  await store.save(3, cid, { ...POLL, exits: ['new_mail', 'error'], confirm_drop_links: true });
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e3]: 'output_2' });
});

test('remap: removing a linked exit is refused until confirmed', async () => {
  const cid = await remapSetup();
  const [e1, e2, e3] = linkedNodeWithThreeChildren(workflow('3', 'First'), cid);
  const e = await error(() => saveExits(cid, ['new_mail', 'error']));
  assert.equal(e.kind, 'links_dropped');
  assert.equal(e.status, 409);
  assert.deepEqual(e.data, [{ workflow_id: 1, workflow_name: 'First', node_name: 'Poll', exit: 'no_mail', count: 1 }]);
  assert.deepEqual((await store.get(3, cid))!.exits, ['new_mail', 'no_mail', 'error']);
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e2]: 'output_2', [e3]: 'output_3' });
});

test('remap: removing an unlinked exit needs no confirmation', async () => {
  const cid = await remapSetup();
  const wf = workflow('3', 'First');
  const code = node(wf, 'code', { name: 'Poll', code_component_id: cid });
  const e1 = edge(wf, code, node(wf, 'agent', {}), 'output_1');
  await saveExits(cid, ['new_mail', 'error']);
  assert.deepEqual(ports(d), { [e1]: 'output_1' });
});

test('remap: a collapse to one exit moves all to output_1 and drops duplicates', async () => {
  const cid = await remapSetup();
  const wf = workflow('3', 'First');
  const code = node(wf, 'code', { name: 'Poll', code_component_id: cid });
  const a = node(wf, 'agent', {});
  const b = node(wf, 'agent', {});
  const e1 = edge(wf, code, a, 'output_1');
  edge(wf, code, a, 'output_2'); // same target as e1: a duplicate once collapsed
  const e3 = edge(wf, code, b, 'output_3');
  const e4 = edge(wf, code, a, 'output_3', 'input_2'); // same node, other input: kept
  await saveExits(cid, ['done']);
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e3]: 'output_1', [e4]: 'output_1' });
});

test('remap: unchanged exits touch no edges', async () => {
  const cid = await remapSetup();
  const wf = workflow('3', 'First');
  const code = node(wf, 'code', { name: 'Poll', code_component_id: cid });
  const a = node(wf, 'agent', {});
  const e1 = edge(wf, code, a, 'output_2');
  const e2 = edge(wf, code, a, 'output_9');
  await store.save(3, cid, { ...POLL, code: 'def run(i, c):\\n    return 2' });
  assert.deepEqual(ports(d), { [e1]: 'output_2', [e2]: 'output_9' });
});

test('remap: a port beyond the old exits is left alone', async () => {
  const cid = await remapSetup();
  const wf = workflow('3', 'First');
  const code = node(wf, 'code', { name: 'Poll', code_component_id: cid });
  const e1 = edge(wf, code, node(wf, 'agent', {}), 'output_7');
  await saveExits(cid, ['error', 'new_mail']);
  assert.deepEqual(ports(d), { [e1]: 'output_7' });
});

test("remap: other users' and unlinked nodes are untouched", async () => {
  const cid = await remapSetup();
  const theirs = workflow('4', 'Theirs');
  const code4 = node(theirs, 'code', { name: 'Poll', code_component_id: cid });
  const a4 = node(theirs, 'agent', {});
  const t1 = edge(theirs, code4, a4, 'output_1');
  const t2 = edge(theirs, code4, a4, 'output_2');
  const mine = workflow('3', 'Mine');
  const plain = node(mine, 'code', { name: 'Inline', exits: ['new_mail', 'no_mail', 'error'] });
  const other = node(mine, 'code', { name: 'Other', code_component_id: cid + 100 });
  const agentLinked = node(mine, 'agent', { code_component_id: cid });
  const a = node(mine, 'agent', {});
  const p1 = edge(mine, plain, a, 'output_1');
  const p2 = edge(mine, other, a, 'output_2');
  const p3 = edge(mine, agentLinked, a, 'output_1');
  await saveExits(cid, ['no_mail', 'error']);
  assert.deepEqual(ports(d), { [t1]: 'output_1', [t2]: 'output_2', [p1]: 'output_1', [p2]: 'output_2', [p3]: 'output_1' });
});

test('remap: rolls back with the update on error', async () => {
  const cid = await remapSetup();
  const [e1, e2, e3] = linkedNodeWithThreeChildren(workflow('3', 'First'), cid);
  d.exec("CREATE TRIGGER boom BEFORE UPDATE ON workflow_edges BEGIN SELECT RAISE(ABORT, 'boom'); END");
  await assert.rejects(() => saveExits(cid, ['no_mail', 'new_mail', 'error']), /boom/);
  assert.deepEqual((await store.get(3, cid))!.exits, ['new_mail', 'no_mail', 'error']);
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e2]: 'output_2', [e3]: 'output_3' });
});

// ---------------- CodeComponentStartOptionTest ----------------

async function optionSetup(): Promise<number> {
  return (await store.save(3, null, POLL)).id;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test('option: a component is not an option by default', async () => {
  const id = await optionSetup();
  assert.equal((await store.get(3, id))!.start_trigger, null);
});

test('option: setStartTrigger stores the normalised trigger', async () => {
  const id = await optionSetup();
  const row = await store.setStartTrigger(3, id, { ...TRIGGER, label: '  New email ' });
  assert.equal(row.start_trigger!.label, 'New email');
  assert.equal(row.start_trigger!.work_exit, 'new_mail');
  assert.deepEqual(await store.watchFor(3, id), { server: 'Outlook', tool: 'wait_for_new', args: { args: { folder: 'Inbox' } } });
  assert.equal((await store.list(3))[0].start_trigger!.label, 'New email');
});

test('option: a blank label becomes the component name', async () => {
  const id = await optionSetup();
  const row = await store.setStartTrigger(3, id, { ...TRIGGER, label: ' ' });
  assert.equal(row.start_trigger!.label, 'Poll Inbox');
});

test('option: empty args stay an object', async () => {
  const id = await optionSetup();
  const t = clone(TRIGGER) as any;
  t.watch.args = [];
  await store.setStartTrigger(3, id, t);
  const raw = d.prepare('SELECT start_trigger FROM code_components').get().start_trigger;
  assert.ok(raw.includes('"args":{}'));
});

test('option: a bad trigger is refused', async () => {
  const id = await optionSetup();
  const t = TRIGGER;
  const cases: Array<[string, any, string]> = [
    ['server not among the component servers', { ...t, watch: { ...t.watch, server: 'Gmail' } }, 'Gmail'],
    ['no tool', { ...t, watch: { ...t.watch, tool: '' } }, 'tool'],
    ['args a list', { ...t, watch: { ...t.watch, args: [1, 2] } }, 'args'],
    ['work exit not an exit', { ...t, work_exit: 'job' }, 'job'],
    ['label too long', { ...t, label: 'x'.repeat(61) }, 'label'],
  ];
  for (const [why, bad, needle] of cases) {
    const e = await error(() => store.setStartTrigger(3, id, bad));
    assert.equal(e.kind, 'invalid', why);
    assert.equal(e.status, 422);
    assert.ok(e.message.includes(needle), `${why}: ${e.message}`);
  }
});

test("option: another user's component is not found", async () => {
  const id = await optionSetup();
  assert.equal((await error(() => store.setStartTrigger(4, id, TRIGGER))).kind, 'not_found');
  assert.equal((await error(() => store.watchFor(4, id))).kind, 'not_found');
});

test('option: watchFor refuses a component that is not an option', async () => {
  const id = await optionSetup();
  const e = await error(() => store.watchFor(3, id));
  assert.equal(e.kind, 'not_option');
  assert.equal(e.status, 422);
});

test('option: an edit that drops the work exit is refused', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  const e = await error(() => store.save(3, id, { ...POLL, exits: ['job', 'no_job'] }));
  assert.equal(e.kind, 'start_exit');
  assert.equal(e.status, 422);
  assert.ok(e.message.includes('new_mail'));
});

test('option: an edit that drops the watched server is refused', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  const e = await error(() => store.save(3, id, { ...POLL, mcp_servers: [] }));
  assert.equal(e.kind, 'start_exit');
  assert.ok(e.message.includes('Outlook'));
});

test('option: an edit that keeps the work exit is saved', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  const row = await store.save(3, id, { ...POLL, timeout_s: 90 });
  assert.equal(row.timeout_s, 90);
  assert.equal(row.start_trigger!.work_exit, 'new_mail');
});

/** Workflow 64 uses the option (schedule row + linked node after Start); 65 has only an unrelated schedule. */
async function seedTwoWorkflows(id: number): Promise<void> {
  await store.setStartTrigger(3, id, TRIGGER);
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, '3', 'email prototype'), (65, '3', 'AA test')");
  d.exec(`INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES
    (64, 'code', '{"type":"code","name":"Email processing","code_component_id":${id}}')`);
  d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
    VALUES (3, 64, 'event', '{}', ${id}, 'pending'), (3, 65, 'cron', NULL, NULL, 'pending'),
           (4, 99, 'event', '{}', ${id}, 'pending')`);
}

test('option: impact names the workflows', async () => {
  const id = await optionSetup();
  await seedTwoWorkflows(id);
  assert.deepEqual(await store.startTriggerImpact(3, id), [{ workflow_id: 64, workflow_name: 'email prototype' }]);
});

test('option: clear removes the option and only its schedule rows', async () => {
  const id = await optionSetup();
  await seedTwoWorkflows(id);
  const impact = await store.clearStartTrigger(3, id);
  assert.deepEqual(impact.map((r) => r.workflow_id), [64]);
  assert.equal((await store.get(3, id))!.start_trigger, null);
  const left = d.prepare('SELECT user_id, workflow_id FROM scheduled_workflows ORDER BY workflow_id').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ user_id: 3, workflow_id: 65 }, { user_id: 4, workflow_id: 99 }]);
  // the graphs are not touched: the linked node stays (decision 6)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM workflow_nodes').get().n, 1);
});

test('option: cannot be deleted before it is removed', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  const e = await error(() => store.delete(3, id));
  assert.equal(e.kind, 'is_option');
  assert.equal(e.status, 409);
  await store.clearStartTrigger(3, id);
  await store.delete(3, id);
  assert.equal(await store.get(3, id), null);
});

test('option: scheduleBody fills the event from the option', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  const b = await store.scheduleBody(3, { workflow_id: 64, repeat_type: 'cron', cron: '* * * * *', trigger_component_id: String(id) });
  assert.equal(b.repeat_type, 'event');
  assert.equal(b.cron, null);
  assert.equal(b.trigger_component_id, id);
  assert.deepEqual(b.event_trigger, TRIGGER.watch);
});

test('option: scheduleBody adds only the Start tag to the watch', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  insert(d, 'INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (64, ?, ?)', 'start',
    JSON.stringify({ type: 'start', start_option: id, start_args: { tag: 'okta-reset', version: 2, hand_back_group: 'g' } }));
  let b = await store.scheduleBody(3, { workflow_id: 64, trigger_component_id: String(id) });
  assert.deepEqual(b.event_trigger.args, { args: { folder: 'Inbox' }, tag: 'okta-reset' });
  // the update path has no workflow_id in its body: the caller names it
  b = await store.scheduleBody(3, { trigger_component_id: String(id) }, 64);
  assert.equal(b.event_trigger.args.tag, 'okta-reset');
  // another workflow, or a Start without a tag: the watch as stored
  b = await store.scheduleBody(3, { workflow_id: 65, trigger_component_id: String(id) });
  assert.deepEqual(b.event_trigger, TRIGGER.watch);
});

test('option: scheduleBody leaves other schedules alone', async () => {
  const body = { workflow_id: 64, repeat_type: 'daily' };
  assert.deepEqual(await store.scheduleBody(3, body), body);
});

test('option: scheduleBody refuses a foreign or non-option component', async () => {
  const id = await optionSetup();
  assert.equal((await error(() => store.scheduleBody(3, { trigger_component_id: id }))).kind, 'not_option');
  await store.setStartTrigger(3, id, TRIGGER);
  assert.equal((await error(() => store.scheduleBody(4, { trigger_component_id: id }))).kind, 'not_found');
});

test('option: editing the watch updates the schedules using the option', async () => {
  const id = await optionSetup();
  await seedTwoWorkflows(id);
  const other = (await store.save(3, null, { ...POLL, name: 'Poll Archive' })).id;
  d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
    VALUES (3, 66, 'event', '{}', ${other}, 'pending')`);
  const t = clone(TRIGGER);
  t.watch.args = { args: { folder: 'Archive' } };
  await store.setStartTrigger(3, id, t);
  const by: Record<number, any> = {};
  for (const r of d.prepare('SELECT workflow_id, event_trigger FROM scheduled_workflows ORDER BY workflow_id').all()) by[r.workflow_id] = r.event_trigger;
  assert.equal(by[64], '{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Archive"}}}');
  assert.equal(by[65], null);
  assert.equal(by[66], '{}'); // another component's schedule
  assert.equal(by[99], '{}'); // another user's schedule
});

const seedStart = (wf: number, id: number, startArgs: Record<string, any>) =>
  insert(d, 'INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)', wf, 'start',
    JSON.stringify({ type: 'start', start_option: id, start_args: startArgs }));

test("option: editing the watch keeps each schedule's tag", async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  seedStart(64, id, { tag: 'okta-reset' });
  d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
    VALUES (3, 64, 'event', '{}', ${id}, 'pending'), (3, 65, 'event', '{}', ${id}, 'pending')`);
  const t = clone(TRIGGER);
  t.watch.args = { args: { folder: 'Archive' } };
  await store.setStartTrigger(3, id, t);
  const by: Record<number, any> = {};
  for (const r of d.prepare('SELECT workflow_id, event_trigger FROM scheduled_workflows').all()) by[r.workflow_id] = r.event_trigger;
  assert.deepEqual(JSON.parse(by[64]).args, { args: { folder: 'Archive' }, tag: 'okta-reset' });
  assert.deepEqual(JSON.parse(by[65]).args, { args: { folder: 'Archive' } });
});

test("option: the Start tag wins over the component's own tag", async () => {
  const id = await optionSetup();
  const t = clone(TRIGGER) as any;
  t.watch.args = { tag: 'default' };
  await store.setStartTrigger(3, id, t);
  seedStart(64, id, { tag: 'okta-reset' });
  const b = await store.scheduleBody(3, { workflow_id: 64, trigger_component_id: String(id) });
  assert.equal(b.event_trigger.args.tag, 'okta-reset');
});

function dropTrigger(): any {
  const t = clone(TRIGGER) as any;
  t.watch.args = { poll: 'poll_new_mail', folder: 'To SharePoint' };
  return { pass_args: ['folder'], ...t };
}

test('pass_args: reach the event row watch', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, dropTrigger());
  assert.deepEqual((await store.get(3, id))!.start_trigger!.pass_args, ['folder']);
  seedStart(64, id, { folder: 'Mail in', sharepoint_folder: 'D' });
  const b = await store.scheduleBody(3, { workflow_id: 64, trigger_component_id: String(id) });
  assert.deepEqual(b.event_trigger.args, { poll: 'poll_new_mail', folder: 'Mail in' });
  // the schedule already on the option gets it too when the option is edited
  d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
    VALUES (3, 64, 'event', '{}', ${id}, 'pending')`);
  await store.setStartTrigger(3, id, dropTrigger());
  const row = d.prepare('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64').get().event_trigger;
  assert.deepEqual(JSON.parse(row).args, { poll: 'poll_new_mail', folder: 'Mail in' });
});

test('pass_args: undeclared Start args stay out', async () => {
  const id = await optionSetup();
  const t = dropTrigger();
  delete t.pass_args;
  await store.setStartTrigger(3, id, t);
  assert.deepEqual((await store.get(3, id))!.start_trigger!.pass_args, []); // absent = []
  seedStart(64, id, { folder: 'Mail in', sharepoint_folder: 'D' });
  const b = await store.scheduleBody(3, { workflow_id: 64, trigger_component_id: String(id) });
  assert.deepEqual(b.event_trigger.args, { poll: 'poll_new_mail', folder: 'To SharePoint' });
});

test('pass_args: the tag is still merged without them', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, TRIGGER);
  seedStart(64, id, { tag: 'okta-reset', folder: 'Mail in' });
  const b = await store.scheduleBody(3, { workflow_id: 64, trigger_component_id: String(id) });
  assert.deepEqual(b.event_trigger.args, { args: { folder: 'Inbox' }, tag: 'okta-reset' });
});

test('pass_args: validation', async () => {
  const id = await optionSetup();
  for (const [why, passArgs] of [
    ['starts with a digit', ['9x']],
    ['not a list', { a: 'folder' }],
    ['a string', 'folder'],
    ['a number in it', [1]],
    ['more than 20', Array.from({ length: 21 }, (_, i) => `a${i + 1}`)],
  ] as Array<[string, any]>) {
    const e = await error(() => store.setStartTrigger(3, id, { ...TRIGGER, pass_args: passArgs }));
    assert.equal(e.kind, 'invalid', why);
    assert.equal(e.status, 422);
    assert.ok(e.message.includes('pass_args'), why);
  }
});

test('pass_args: a save without them keeps the stored ones; an explicit [] clears them', async () => {
  const id = await optionSetup();
  await store.setStartTrigger(3, id, dropTrigger());
  seedStart(64, id, { folder: 'Mail in', sharepoint_folder: 'D' });
  d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
    VALUES (3, 64, 'event', '{}', ${id}, 'pending')`);
  const t = dropTrigger();
  delete t.pass_args;
  await store.setStartTrigger(3, id, { ...t, label: 'Renamed' });
  assert.deepEqual((await store.get(3, id))!.start_trigger!.pass_args, ['folder']);
  let row = d.prepare('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64').get().event_trigger;
  assert.deepEqual(JSON.parse(row).args, { poll: 'poll_new_mail', folder: 'Mail in' });
  await store.setStartTrigger(3, id, { ...t, pass_args: [] });
  assert.deepEqual((await store.get(3, id))!.start_trigger!.pass_args, []);
  row = d.prepare('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64').get().event_trigger;
  assert.deepEqual(JSON.parse(row).args, { poll: 'poll_new_mail', folder: 'To SharePoint' });
});
