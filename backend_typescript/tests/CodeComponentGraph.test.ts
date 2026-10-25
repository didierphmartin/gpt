import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insert, ports, POLL, TRIGGER } from './support/codeComponentsDb';
import type { Sqlite } from './support/sqliteSchemaDb';
import { CodeComponentStore } from '../src/CodeComponent/CodeComponentStore';
import { CodeComponentError } from '../src/CodeComponent/CodeComponentError';
import { WorkflowGraphRepository } from '../src/AgentTeam/WorkflowRepository';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { StartTriggerFacts } from '../src/AgentTeam/StartTriggerFacts';
import { CodeNodeEmit } from '../src/AgentTeam/CodeNodeEmit';
import { CodeComponentsController } from '../src/Controllers/CodeComponentsController';
import type { Ctx } from '../src/Support/Http';

/**
 * Twins of backend/tests/Unit/CodeComponent/CodeComponentLinkResolutionTest.php, StartOptionNodeTest.php and
 * CodeComponentsControllerTest.php (in-memory SQLite, as the PHP ones), plus StartTriggerFacts::watchArgs.
 */

let d: Sqlite;
let store: CodeComponentStore;
let repo: WorkflowGraphRepository;

beforeEach(() => {
  d = freshDb();
  store = new CodeComponentStore();
  repo = new WorkflowGraphRepository();
});

const stored = (id: number) => JSON.parse(d.prepare('SELECT config FROM workflow_nodes WHERE id = ?').get(id).config);

// ---------------- CodeComponentLinkResolutionTest ----------------

function linkSetup(): void {
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')");
}
const node1 = (type: string, cfg: Record<string, any>) =>
  insert(d, 'INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, ?, ?)', type, JSON.stringify(cfg));

test('link: getNodes fills the component for the owner', async () => {
  linkSetup();
  const id = (await store.save(3, null, POLL)).id;
  // Saved exits are stale (another workflow changed the component since): the component wins.
  node1('code', { name: 'Poll', code_component_id: id, exits: ['old'], code_component_missing: true });
  const cfg = (await repo.getNodes(1))[0].config;
  assert.equal(cfg.code, POLL.code);
  assert.deepEqual(cfg.exits, ['new_mail', 'no_mail', 'error']);
  assert.deepEqual(cfg.mcp_servers, ['Outlook']);
  assert.equal(cfg.timeout_s, 20);
  assert.ok(!('code_component_missing' in cfg));
  assert.equal(cfg.name, 'Poll');
});

test('link: a missing or foreign component is flagged', async () => {
  linkSetup();
  const foreign = (await store.save(4, null, POLL)).id;
  node1('code', { name: 'Gone', code_component_id: 99 });
  node1('code', { name: 'Theirs', code_component_id: foreign });
  const nodes = await repo.getNodes(1);
  assert.equal(nodes[0].config.code_component_missing, true);
  assert.equal(nodes[1].config.code_component_missing, true);
  assert.ok(!('code' in nodes[1].config));
});

test('link: unlinked and non-code nodes are untouched', async () => {
  linkSetup();
  node1('code', { name: 'Inline', code: 'x', exits: ['next'] });
  node1('agent', { code_component_id: 5 });
  const nodes = await repo.getNodes(1);
  assert.deepEqual(nodes[0].config, { name: 'Inline', code: 'x', exits: ['next'] });
  assert.deepEqual(nodes[1].config, { code_component_id: 5 });
});

test('link: create (saveGraph) and update store only the link', async () => {
  linkSetup();
  const full = { name: 'Poll', code_component_id: 7, code: 'x', exits: ['a'], mcp_servers: ['O'],
    timeout_s: 5, code_component_missing: true, disabled: false };
  await repo.saveGraph(1, [{ id: 'n1', node_type: 'code', config: { ...full } }], []);
  const nodeId = Number(d.prepare('SELECT id FROM workflow_nodes ORDER BY id DESC LIMIT 1').get().id);
  assert.deepEqual(stored(nodeId), { name: 'Poll', code_component_id: 7, disabled: false, type: 'code' });
  await repo.updateNode(nodeId, { node_type: 'code', config: { ...full } });
  assert.deepEqual(stored(nodeId), { name: 'Poll', code_component_id: 7, disabled: false, type: 'code' });
  // An unlinked code node keeps its own code.
  await repo.saveGraph(1, [{ id: 'n2', node_type: 'code', config: { code: 'y', exits: ['next'] } }], []);
  const inline = Number(d.prepare('SELECT id FROM workflow_nodes ORDER BY id DESC LIMIT 1').get().id);
  assert.equal(stored(inline).code, 'y');
});

test('link: args and start_args survive save and update', async () => {
  linkSetup();
  const code = { name: 'Poll', code_component_id: 7, args: { q: ['a', 1] } };
  const start = { start_option: 7, start_args: { mailbox: 'x' } };
  await repo.saveGraph(1, [{ id: 'c', node_type: 'code', config: { ...code } }, { id: 's', node_type: 'start', config: { ...start } }], []);
  const [c, s] = d.prepare('SELECT id FROM workflow_nodes ORDER BY id').all().map((r: any) => Number(r.id));
  assert.deepEqual(stored(c).args, { q: ['a', 1] });
  assert.deepEqual(stored(s).start_args, { mailbox: 'x' });
  await repo.updateNode(c, { node_type: 'code', config: { ...code } });
  await repo.updateNode(s, { node_type: 'start', config: { ...start } });
  assert.deepEqual(stored(c).args, { q: ['a', 1] });
  assert.deepEqual(stored(s).start_args, { mailbox: 'x' });
});

test('link: compile refuses a missing component, naming the node', () => {
  assert.throws(() => CodeNodeEmit.nodeData({ id: '5', config: { name: 'Gone', code_component_id: 99, code_component_missing: true } }, [], {}),
    { message: 'Code component #99 not found (node Gone).' });
});

test('link: a code node whose column lost its type is still resolved and counted', async () => {
  linkSetup();
  const id = (await store.save(3, null, POLL)).id;
  node1('', { type: 'code', name: 'Poll', code_component_id: id });
  const cfg = (await repo.getNodes(1))[0].config;
  assert.equal(cfg.code, POLL.code);
  assert.deepEqual(await store.usedBy(3, id), [{ workflow_id: 1, workflow_name: 'Mail triage', node_name: 'Poll' }]);
  assert.equal((await store.list(3))[0].used_by, 1);
});

test('link: a non-code config type with an empty column is not resolved', async () => {
  linkSetup();
  const id = (await store.save(3, null, POLL)).id;
  node1('', { type: 'agent', code_component_id: id });
  assert.deepEqual((await repo.getNodes(1))[0].config, { type: 'agent', code_component_id: id });
  assert.deepEqual(await store.usedBy(3, id), []);
});

// ---------------- StartOptionNodeTest ----------------

async function startSetup(): Promise<{ cid: number; start: number; edges: number[] }> {
  const cid = (await store.save(3, null, POLL)).id;
  await store.setStartTrigger(3, cid, { ...TRIGGER, label: 'Outlook: Get New Email' });
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (1, '3', 'Mail triage')");
  const nodeAt = (type: string, cfg: Record<string, any>) =>
    insert(d, 'INSERT INTO workflow_nodes (workflow_id, node_type, config, pos_x, pos_y) VALUES (1, ?, ?, 100, 50)', type, JSON.stringify(cfg));
  const start = nodeAt('start', { type: 'start', start_option: cid });
  const edges: number[] = [];
  for (const port of ['output_1', 'output_2', 'output_3']) {
    const to = nodeAt('agent', { type: 'agent' });
    edges.push(insert(d, 'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (1, ?, ?, ?, ?)',
      start, to, port, 'input_1'));
  }
  return { cid, start, edges };
}

test("start option: Start reads the option's exits and label", async () => {
  await startSetup();
  const start = (await repo.getNodes(1))[0];
  assert.deepEqual(start.config.exits, ['new_mail', 'no_mail', 'error']);
  assert.equal(start.config.start_option_label, 'Outlook: Get New Email');
  assert.ok(!('start_option_missing' in start.config));
});

test('start option: saving Start stores only the option', async () => {
  const { cid, start } = await startSetup();
  await repo.updateNode(start, { node_type: 'start', config: { type: 'start', start_option: cid, exits: ['x'],
    start_option_label: 'x', start_option_missing: true } });
  assert.deepEqual(stored(start), { type: 'start', start_option: cid });
});

test('start option: the graph runs the component after Start', async () => {
  const { cid, start } = await startSetup();
  const g = await repo.getGraph(1);
  const code = String(StartOptionGraph.ID_OFFSET + start);
  const n = g.nodes.find((x) => String(x.id) === code)!;
  assert.equal(n.node_type, 'code');
  assert.equal(n.config.name, 'Outlook: Get New Email');
  assert.equal(n.config.code_component_id, cid);
  assert.deepEqual(n.config.exits, ['new_mail', 'no_mail', 'error']);
  assert.deepEqual(n.config.mcp_servers, ['Outlook']);
  const from = g.edges.map((e) => [String(e.from_node_id), e.from_port]);
  assert.deepEqual(from, [[code, 'output_1'], [code, 'output_2'], [code, 'output_3'], [String(start), 'output_1']]);
  assert.equal(String(g.edges[g.edges.length - 1].to_node_id), code);
});

test('start option: a plain Start is not expanded', async () => {
  const graph = { nodes: [{ id: 5, node_type: 'start', config: { type: 'start' } }],
    edges: [{ id: 1, from_node_id: 5, to_node_id: 6, from_port: 'output_1' }] };
  assert.deepEqual(await StartOptionGraph.expand(graph, () => assert.fail('no lookup')), graph);
});

test('start option: a Start whose option is gone is not expanded', async () => {
  const graph = { nodes: [{ id: 5, node_type: 'start', config: { type: 'start', start_option: 9 } }], edges: [] };
  assert.deepEqual(await StartOptionGraph.expand(graph, () => null), graph);
  assert.deepEqual(await StartOptionGraph.expand(graph, () => ({ ...POLL, start_trigger: null })), graph);
});

test('start option: used-by lists the Start', async () => {
  const { cid } = await startSetup();
  assert.deepEqual(await store.usedBy(3, cid), [{ workflow_id: 1, workflow_name: 'Mail triage', node_name: 'Start' }]);
});

test("start option: reordering exits moves Start's links", async () => {
  const { cid, edges: [e1, e2, e3] } = await startSetup();
  await store.save(3, cid, { ...POLL, exits: ['no_mail', 'new_mail', 'error'] });
  assert.deepEqual(ports(d), { [e1]: 'output_2', [e2]: 'output_1', [e3]: 'output_3' });
});

test('start option: removing an exit with links on Start asks first', async () => {
  const { cid, edges: [e1, e2] } = await startSetup();
  await assert.rejects(() => store.save(3, cid, { ...POLL, exits: ['new_mail', 'no_mail'] }), (e: any) => {
    assert.ok(e instanceof CodeComponentError);
    assert.deepEqual(e.data, [{ workflow_id: 1, workflow_name: 'Mail triage', node_name: 'Start', exit: 'error', count: 1 }]);
    return true;
  });
  await store.save(3, cid, { ...POLL, exits: ['new_mail', 'no_mail'], confirm_drop_links: true });
  assert.deepEqual(ports(d), { [e1]: 'output_1', [e2]: 'output_2' });
});

test('start option: removing the option turns Start back into a plain Start', async () => {
  const { cid, start, edges } = await startSetup();
  const impact = await store.clearStartTrigger(3, cid);
  assert.deepEqual(impact, [{ workflow_id: 1, workflow_name: 'Mail triage' }]);
  assert.deepEqual(ports(d), { [edges[0]]: 'output_1' }); // the work exit's link stays
  assert.deepEqual(stored(start), { type: 'start' });
});

// ---------------- StartTriggerFacts::watchArgs ----------------

test('watchArgs: the tag and the named start args win; empty values and others stay out', () => {
  assert.deepEqual(StartTriggerFacts.watchArgs({ folder: 'Inbox', tag: 'x' }, { tag: 'okta', folder: 'Mail in', other: 1 }, ['folder']),
    { folder: 'Mail in', tag: 'okta' });
  assert.deepEqual(StartTriggerFacts.watchArgs({ folder: 'Inbox' }, { tag: '', folder: '' }, ['folder']), { folder: 'Inbox' });
  assert.deepEqual(StartTriggerFacts.watchArgs({}, { folder: [] }, ['folder', 5 as any]), {});
});

// ---------------- CodeComponentsControllerTest ----------------

function req(body: Record<string, any> = {}, params: Record<string, any> = {}, user = 3): Ctx {
  return { method: 'GET', uri: '/', headers: {}, query: {}, body, user_id: user, auth_type: 'jwt', params, remote_addr: '' };
}

test('controller: CRUD round trip', async () => {
  const c = new CodeComponentsController();
  const r = await c.create(req(POLL));
  assert.equal(r.success, true);
  const id = r.data.id;
  assert.equal((await c.show(req({}, { id: String(id) }))).data.name, 'Poll Inbox');
  assert.equal((await c.index(req())).data[0].used_by, 0);
  const u = await c.update(req({ ...POLL, timeout_s: 60 }, { id: String(id) }));
  assert.equal(u.data.timeout_s, 60);
  assert.deepEqual((await c.usedBy(req({}, { id: String(id) }))).data, []);
  assert.equal((await c.destroy(req({}, { id: String(id) }))).success, true);
});

test('controller: errors carry kind and status', async () => {
  const c = new CodeComponentsController();
  let r = await c.show(req({}, { id: '9' }));
  assert.deepEqual([r.kind, r.status_code], ['not_found', 404]);
  r = await c.create(req({ ...POLL, exits: [] }));
  assert.deepEqual([r.kind, r.status_code], ['invalid', 422]);
  r = await c.index(req({}, {}, 0));
  assert.deepEqual(r, { success: false, error: 'Authentication required', kind: 'auth', status_code: 401 });
});

test("controller: another user's component is not found", async () => {
  const c = new CodeComponentsController();
  const id = (await c.create(req(POLL, {}, 4))).data.id;
  assert.equal((await c.show(req({}, { id: String(id) }))).status_code, 404);
  assert.equal((await c.usedBy(req({}, { id: String(id) }))).status_code, 404);
});

test('controller: Start option round trip (the removal sweeps active workflows)', async () => {
  let sweeps = 0;
  const c = new CodeComponentsController(new CodeComponentStore(), async () => { sweeps++; });
  const id = String((await c.create(req(POLL))).data.id);
  const set = await c.setStartOption(req(TRIGGER, { id }));
  assert.equal(set.success, true);
  assert.equal(set.data.start_trigger.label, 'New email');
  assert.deepEqual((await c.startOptionImpact(req({}, { id }))).data, []);
  const del = await c.destroy(req({}, { id }));
  assert.deepEqual([del.kind, del.status_code], ['is_option', 409]);
  assert.deepEqual((await c.clearStartOption(req({}, { id }))).data, []);
  assert.equal(sweeps, 1);
  assert.equal((await c.destroy(req({}, { id }))).success, true);
});

test('controller: a failing sweep never fails the removal', async () => {
  const c = new CodeComponentsController(new CodeComponentStore(), async () => { throw new Error('db gone'); });
  const id = String((await c.create(req(POLL))).data.id);
  await c.setStartOption(req(TRIGGER, { id }));
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await c.clearStartOption(req({}, { id }))).success, true);
  } finally {
    console.error = orig;
  }
});

test('controller: a bad Start option is 422', async () => {
  const c = new CodeComponentsController();
  const id = String((await c.create(req(POLL))).data.id);
  const r = await c.setStartOption(req({ ...TRIGGER, work_exit: 'job' }, { id }));
  assert.deepEqual([r.success, r.kind, r.status_code], [false, 'invalid', 422]);
});

test('controller: links_dropped carries its data', async () => {
  const c = new CodeComponentsController();
  const id = (await c.create(req(POLL))).data.id;
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'First')");
  const code = node1('code', { name: 'Poll', code_component_id: id });
  const a = node1('agent', {});
  insert(d, 'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (1, ?, ?, ?, ?)', code, a, 'output_2', 'input_1');
  const r = await c.update(req({ ...POLL, exits: ['new_mail', 'error'] }, { id: String(id) }));
  assert.equal(r.status_code, 409);
  assert.equal(r.kind, 'links_dropped');
  assert.deepEqual(r.data, [{ workflow_id: 1, workflow_name: 'First', node_name: 'Poll', exit: 'no_mail', count: 1 }]);
});

// ---------------- ScheduledWorkflowController: a schedule on a Start option ----------------

test('schedules: create and update refuse a component that is not an option, with its kind', async () => {
  const { ScheduledWorkflowController } = await import('../src/Controllers/ScheduledWorkflowController');
  const id = (await store.save(3, null, POLL)).id;
  const c = new ScheduledWorkflowController();
  const r = await c.create(req({ workflow_id: 1, scheduled_time: '2026-10-25 10:00:00', trigger_component_id: id }));
  assert.deepEqual(r, { success: false, error: '"Poll Inbox" is not a Start option.', kind: 'not_option', status_code: 422 });
  const u = await c.update(req({ trigger_component_id: 999 }, { id: '5' }));
  assert.deepEqual(u, { success: false, error: 'Code component #999 not found', kind: 'not_found', status_code: 404 });
});
