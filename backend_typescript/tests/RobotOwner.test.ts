import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotSchema, agentsAndPlaybooks, WF, OWNER, POLL, SP } from './support/robotSchema';
import { SchedDb, workflow, row, option } from './support/schedulerDb';
import { RobotAccount } from '../src/Services/RobotAccount';
import { RobotOwnership } from '../src/Services/RobotOwnership';
import { WorkflowOwnerTransfer, WorkflowTransferError } from '../src/AgentTeam/WorkflowOwnerTransfer';
import { WorkflowRepository } from '../src/AgentTeam/WorkflowRepository';
import { ActiveWorkflowError, ActiveWorkflowService } from '../src/AgentTeam/ActiveWorkflowService';
import { ActiveWorkflowController } from '../src/Controllers/ActiveWorkflowController';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { ScheduledWorkflowController } from '../src/Controllers/ScheduledWorkflowController';
import { CodeComponentsController } from '../src/Controllers/CodeComponentsController';
import { CodeComponentStore } from '../src/CodeComponent/CodeComponentStore';
import { PlaybookStore } from '../src/Playbook/PlaybookStore';

/**
 * Twins of backend/tests/Unit/AgentTeam/WorkflowOwnerTransferTest.php, WorkflowDuplicateTest.php,
 * WorkflowRepositoryRobotTest.php, Controllers/WorkflowLockTest.php, Controllers/RobotWorkflowSaveTest.php (workflow
 * saves) and the robot cases of EventWorker/ActiveWorkflowServiceTest.php / ActiveWorkflowControllerTest.php.
 * The edition is the env's ('' here): use_robot comes from the role, as in the corporate edition.
 */

const req = (u: number, body: Record<string, any> = {}, params: Record<string, any> = {}): any =>
  ({ method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: u, auth_type: 'jwt', params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), remote_addr: '' });
const own = () => new RobotOwnership({ edition: 'corporate' });
const ownerOf = (d: SchedDb, table: string, id: number) => Number((d.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(id) as any).user_id);
const count = (d: SchedDb, q: string) => Number(Object.values(d.prepare(q).get() as any)[0]);

/** The columns WorkflowRepository writes and reads. */
function workflowColumns(d: SchedDb): void {
  const have = (d.prepare('PRAGMA table_info(agent_workflows)').all() as any[]).map((c) => c.name);
  for (const [c, t] of Object.entries({ description: 'TEXT', steps: 'TEXT', triggers: 'TEXT', variables: 'TEXT', enabled: 'INTEGER DEFAULT 1',
    workspace_id: 'INTEGER', output_storage_enabled: 'INTEGER DEFAULT 0', output_folder: 'TEXT', orchestration: 'TEXT' })) {
    if (!have.includes(c)) d.exec(`ALTER TABLE agent_workflows ADD COLUMN ${c} ${t}`);
  }
}

// ---- WorkflowOwnerTransfer ----

const TABLES = ['agent_workflows', 'workflow_nodes', 'workflow_edges', 'code_components', 'playbooks', 'agents', 'scheduled_workflows', 'active_workflows'];

async function transferSetup() {
  const { d, ids } = await robotSchema();
  agentsAndPlaybooks(d);
  const robot = await RobotAccount.ensure();
  d.exec("INSERT INTO playbooks (id, user_id, pkey, title, text) VALUES (5, 2, 'mail-pdf', 'Mail', 't'), (6, 2, 'filing', 'Filing', 't')");
  d.exec("INSERT INTO agents (id, user_id, name, playbook_id) VALUES (31, 2, 'Filer', 6)");
  d.exec("INSERT INTO agents (id, user_id, name, visibility) VALUES (32, 1, 'Public helper', 'public')");
  const node = d.prepare('INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config) VALUES (?, ?, ?, ?)');
  node.run(WF, 'playbook', null, JSON.stringify({ type: 'playbook', playbook_id: 5 }));
  node.run(WF, 'agent', 31, JSON.stringify({ type: 'agent', name: 'Filer' }));
  node.run(WF, 'agent', 32, JSON.stringify({ type: 'agent', name: 'Helper' }));
  d.exec('UPDATE scheduled_workflows SET id = 40 WHERE workflow_id = 75');
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, 2, 'Other'), (66, 2, 'Unrelated')");
  node.run(64, 'code', null, JSON.stringify({ type: 'code', code_component_id: ids['To PDF'] }));
  const snapshot = () => Object.fromEntries(TABLES.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  return { d, ids, robot, transfer: () => new WorkflowOwnerTransfer(own()), snapshot };
}

async function transferError(p: Promise<any>): Promise<WorkflowTransferError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkflowTransferError) return e;
    throw e;
  }
  throw new Error('expected WorkflowTransferError');
}

test('transfer moves the workflow and everything it uses', async () => {
  const { d, ids, robot, transfer, snapshot } = await transferSetup();
  const before = snapshot();
  const r = await transfer().toRobot(OWNER, WF);
  const components = Object.values(ids).sort((a, b) => a - b);
  assert.deepEqual(r, { workflow_id: WF, moved: { components, playbooks: [5, 6], agents: [31], schedules: [40] }, servers: [] });
  const after = snapshot();
  for (const t of TABLES) assert.equal((after as any)[t].length, (before as any)[t].length, `no new or deleted ${t} rows`);
  assert.deepEqual(after.workflow_nodes, before.workflow_nodes);
  assert.deepEqual(after.workflow_edges, before.workflow_edges);
  assert.equal(ownerOf(d, 'agent_workflows', WF), robot);
  for (const id of components) assert.equal(ownerOf(d, 'code_components', id), robot);
  assert.deepEqual([ownerOf(d, 'playbooks', 5), ownerOf(d, 'playbooks', 6)], [robot, robot]);
  assert.deepEqual([ownerOf(d, 'agents', 31), ownerOf(d, 'agents', 32)], [robot, 1]); // another user's agent stays
  assert.equal(ownerOf(d, 'scheduled_workflows', 40), robot);
  assert.deepEqual([ownerOf(d, 'agent_workflows', 64), ownerOf(d, 'agent_workflows', 66)], [OWNER, OWNER]);
});

test('a clash refuses and changes nothing; preview lists it', async () => {
  const { d, robot, transfer, snapshot } = await transferSetup();
  await new CodeComponentStore().save(robot, null, { name: 'Store SharePoint', code: 'x', exits: ['done'] });
  d.exec(`INSERT INTO agents (user_id, name) VALUES (${robot}, 'Filer')`);
  d.exec(`INSERT INTO agent_workflows (id, user_id, name) VALUES (90, ${robot}, 'Mail to PDF')`);
  const before = snapshot();
  const e = await transferError(transfer().toRobot(OWNER, WF));
  const clashes = [{ kind: 'workflow', name: 'Mail to PDF' }, { kind: 'component', name: 'Store SharePoint' }, { kind: 'agent', name: 'Filer' }];
  assert.deepEqual([e.kind, e.status, e.clashes], ['clash', 409, clashes]);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual((await transfer().preview(OWNER, WF)).clashes, clashes);
});

test('a playbook clash is by key; a published robot copy says unpublish first', async () => {
  let s = await transferSetup();
  s.d.exec(`INSERT INTO playbooks (user_id, pkey, title, text) VALUES (${s.robot}, 'filing', 'Other title', 't')`);
  assert.deepEqual((await transferError(s.transfer().toRobot(OWNER, WF))).clashes, [{ kind: 'playbook', name: 'filing' }]);

  s = await transferSetup();
  s.d.exec(`INSERT INTO playbooks (user_id, pkey, title, text, source_id) VALUES (${s.robot}, 'filing', 'Filing', 't', 6)`);
  const e = await transferError(s.transfer().toRobot(OWNER, WF));
  assert.deepEqual(e.clashes, [{ kind: 'playbook', name: 'filing', published: true }]);
  assert.match(e.message, /playbook "filing" is published to the robot: unpublish it first/);
  assert.deepEqual((await s.transfer().preview(OWNER, WF)).clashes, e.clashes);
});

test('preview lists shared workflows and missing servers, writes nothing', async () => {
  const { d, robot, transfer, snapshot } = await transferSetup();
  const add = d.prepare('INSERT INTO mcp_servers (user_id, name, url, enabled) VALUES (?, ?, ?, ?)');
  add.run(String(robot), 'outlook', 'http://o', 1); // matches "Outlook" by slug
  add.run(String(OWNER), 'Converter', 'http://c', 1); // the owner's, not the robot's
  const before = snapshot();
  assert.deepEqual(await transfer().preview(OWNER, WF), { needs_servers: ['Converter', 'SharePoint'], shared_with: [{ id: 64, name: 'Other' }], clashes: [] });
  assert.deepEqual(snapshot(), before);
});

test("the robot gets the servers it lacks from the caller's, without their keys", async () => {
  const { d, robot, transfer } = await transferSetup();
  const add = d.prepare('INSERT INTO mcp_servers (user_id, name, url, description, headers, transport, enabled, is_mock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run(String(robot), 'outlook', 'http://robot-o', '', null, 'http', 1, 0); // the robot's: kept, no copy
  add.run(String(OWNER), 'Outlook', 'http://o', 'Mail', '{"X-Outlook-Account":"k1"}', 'http', 1, 0);
  add.run(String(OWNER), 'SharePoint', 'http://sp', 'Files', '{"X-SharePoint-Account":"k2"}', 'sse', 1, 0);
  add.run(String(OWNER), 'Converter', 'http://c', 'PDF', null, 'http', 1, 1);
  add.run(String(OWNER), 'Unused', 'http://u', '', null, 'http', 1, 0); // not in the workflow
  const r = await transfer().toRobot(OWNER, WF);
  assert.deepEqual(r.servers, ['Converter', 'SharePoint']);
  const rows = d
    .prepare(`SELECT name, url, description, headers, transport, enabled, is_mock FROM mcp_servers WHERE user_id = ? ORDER BY name`)
    .all(String(robot))
    .map((x: any) => ({ ...x }));
  assert.deepEqual(rows, [
    { name: 'Converter', url: 'http://c', description: 'PDF', headers: null, transport: 'http', enabled: 1, is_mock: 1 },
    { name: 'SharePoint', url: 'http://sp', description: 'Files', headers: null, transport: 'sse', enabled: 1, is_mock: 0 },
    { name: 'outlook', url: 'http://robot-o', description: '', headers: null, transport: 'http', enabled: 1, is_mock: 0 },
  ]);
  assert.deepEqual((await transfer().preview(OWNER, WF)).needs_servers, []);
  assert.deepEqual((await transfer().toRobot(OWNER, WF)).servers, []); // a repair copies nothing twice
});

test("the owner's active row goes; a second transfer only repairs schedules", async () => {
  const { d, robot, transfer } = await transferSetup();
  await new ActiveWorkflowService().activate(OWNER, WF);
  await transfer().toRobot(OWNER, WF);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM active_workflows'), 0);
  d.exec('UPDATE scheduled_workflows SET user_id = 2 WHERE id = 40');
  assert.deepEqual(await transfer().toRobot(OWNER, WF), {
    workflow_id: WF,
    moved: { components: [], playbooks: [], agents: [], schedules: [40] },
    servers: [],
  });
  assert.equal(ownerOf(d, 'scheduled_workflows', 40), robot);
  assert.deepEqual(await transfer().preview(OWNER, WF), { needs_servers: ['Converter', 'Outlook', 'SharePoint'], shared_with: [], clashes: [] });
});

test('transfer access: no use_robot is 403, not the owner is 404', async () => {
  const { d, transfer } = await transferSetup();
  const e = await transferError(transfer().toRobot(1, WF));
  assert.deepEqual([e.kind, e.status], ['forbidden', 403]);
  d.exec("UPDATE users SET role = 'ops' WHERE id = 3");
  const e2 = await transferError(transfer().preview(3, WF));
  assert.deepEqual([e2.kind, e2.status], ['not_found', 404]);
  assert.equal(ownerOf(d, 'agent_workflows', WF), OWNER);
});

test('PUT /workflows/{id}/owner', async () => {
  const { d, robot } = await transferSetup();
  workflowColumns(d);
  const route = (u: number, body: any) => new WorkflowController().owner(req(u, body, { id: WF }));
  assert.equal((await route(2, { owner: 'me', confirm: true })).status_code, 422);
  assert.equal((await route(1, { owner: 'robot' })).status_code, 403);
  assert.equal((await route(0, { owner: 'robot' })).status_code, 401);
  let r = await route(2, { owner: 'robot', confirm: false });
  assert.deepEqual([r.success, r.status_code, r.data.shared_with], [true, 200, [{ id: 64, name: 'Other' }]]);
  assert.equal(ownerOf(d, 'agent_workflows', WF), OWNER);

  d.exec(`INSERT INTO agents (user_id, name) VALUES (${robot}, 'Filer')`);
  r = await route(2, { owner: 'robot', confirm: true });
  assert.deepEqual([r.success, r.status_code, r.error_code, r.clashes], [false, 409, 'clash', [{ kind: 'agent', name: 'Filer' }]]);
  assert.match(r.error, /Filer/);

  d.exec(`DELETE FROM agents WHERE user_id = ${robot}`);
  r = await route(2, { owner: 'robot', confirm: true });
  assert.deepEqual([r.success, r.status_code, r.data.workflow_id], [true, 200, WF]);
  assert.equal(ownerOf(d, 'agent_workflows', WF), robot);

  d.exec(`INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES (${robot}, 75, 'event', '2026-10-29 09:00:00')`);
  r = await route(2, { owner: 'robot', confirm: true });
  assert.deepEqual([r.status_code, r.error_code], [423, 'locked']);
});

// ---- WorkflowRepository: duplicate, robot visibility ----

async function duplicateSetup() {
  const { d, ids } = await robotSchema();
  agentsAndPlaybooks(d);
  workflowColumns(d);
  for (const c of ['pos_x INTEGER', 'pos_y INTEGER', 'drawflow_node_id INTEGER']) d.exec(`ALTER TABLE workflow_nodes ADD COLUMN ${c}`);
  d.exec('ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT');
  d.exec('UPDATE workflow_nodes SET pos_x = id * 10, pos_y = 5, drawflow_node_id = id');
  d.exec("UPDATE agent_workflows SET steps = '[]', triggers = '[]', variables = '{}', orchestration = 'workflow'");
  d.exec("UPDATE scheduled_workflows SET last_run = '2026-10-01 00:00:00', error_message = 'boom', running_since = '2026-10-01 00:00:01'");
  return { d, ids, repo: new WorkflowRepository() };
}

test('a copy is personal: nodes, edges and a paused schedule', async () => {
  const { d, ids, repo } = await duplicateSetup();
  const copy = (await repo.duplicate(75, 3))!;
  assert.notEqual(copy.id, 75);
  assert.equal(copy.userId, 3);
  assert.equal(copy.name, 'Mail to PDF (Copy)');
  const nodes = (wf: number) => d.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id').all(wf) as any[];
  const src = nodes(75);
  const fresh = nodes(copy.id as number);
  assert.equal(fresh.length, 4);
  src.forEach((s, i) => {
    for (const k of ['node_type', 'agent_id', 'config', 'pos_x', 'pos_y', 'drawflow_node_id']) assert.equal(fresh[i][k], s[k], k);
    assert.notEqual(fresh[i].id, s.id);
  });
  assert.equal(JSON.parse(fresh[1].config).code_component_id, ids['To PDF']);
  const newIds = fresh.map((n) => Number(n.id));
  const edges = d.prepare('SELECT from_node_id, to_node_id FROM workflow_edges WHERE workflow_id = ? ORDER BY id').all(copy.id) as any[];
  assert.deepEqual(edges.map((e) => [Number(e.from_node_id), Number(e.to_node_id)]), [[newIds[0], newIds[1]], [newIds[1], newIds[2]], [newIds[2], newIds[3]]]);
  const sched = d.prepare('SELECT * FROM scheduled_workflows WHERE workflow_id = ?').all(copy.id) as any[];
  assert.equal(sched.length, 1);
  assert.deepEqual([Number(sched[0].user_id), sched[0].status, sched[0].repeat_type, sched[0].last_run, sched[0].running_since, sched[0].error_message],
    [3, 'paused', 'event', null, null, null]);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM active_workflows'), 0);
  assert.equal(nodes(75).length, 4); // the source is untouched
  assert.equal(ownerOf(d, 'agent_workflows', 75), 2);
});

test('copy names count up per owner; an explicit name; a missing workflow', async () => {
  const { repo } = await duplicateSetup();
  assert.equal((await repo.duplicate(75, 3))!.name, 'Mail to PDF (Copy)');
  assert.equal((await repo.duplicate(75, 3))!.name, 'Mail to PDF (Copy 2)');
  assert.equal((await repo.duplicate(75, 3))!.name, 'Mail to PDF (Copy 3)');
  assert.equal((await repo.duplicate(75, 1))!.name, 'Mail to PDF (Copy)'); // another owner's copies don't clash
  assert.equal((await repo.duplicate(75, 3, 'Mine'))!.name, 'Mine');
  assert.equal(await repo.duplicate(999, 3), null);
});

test('findByUser / canUserAccess / isOwner include the robot only when given it', async () => {
  const { d } = await duplicateSetup();
  const robot = await RobotAccount.ensure();
  d.exec(`UPDATE agent_workflows SET user_id = ${robot} WHERE id = 75`);
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
  const repo = new WorkflowRepository();
  assert.deepEqual((await repo.findByUser(3)).map((w) => w.id), [9]);
  assert.deepEqual((await repo.findByUser(3, false, robot)).map((w) => w.id).sort(), [75, 9].sort());
  assert.equal(await repo.canUserAccess(3, 75), false);
  assert.equal(await repo.canUserAccess(3, 75, robot), true);
  assert.equal(await repo.isOwner(3, 75, robot), true);
  assert.equal(await repo.isOwner(1, 9, robot), false);
});

// ---- the lock (423) ----

async function lockSetup() {
  const { d, ids } = await robotSchema();
  workflowColumns(d);
  const robot = await RobotAccount.ensure();
  d.exec(`UPDATE agent_workflows SET user_id = ${robot} WHERE id = 75`);
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
  d.exec(`INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES (${robot}, 75, 'event', '2026-10-29 09:00:00'),
    (3, 9, 'event', '2026-10-29 09:00:00')`);
  return { d, ids, robot };
}

function assertLocked(r: any): void {
  assert.deepEqual([r.success, r.error_code ?? null, r.status_code, r.error ?? null],
    [false, 'locked', 423, 'Mail to PDF is running as the robot. Unlock it first.'], JSON.stringify(r));
}

test('a locked workflow refuses edits and runs', async () => {
  const { d } = await lockSetup();
  const wf = new WorkflowController();
  const p = { id: 75 };
  assertLocked(await wf.update(req(2, { name: 'X' }, p)));
  assertLocked(await wf.destroy(req(2, {}, p)));
  assertLocked(await wf.toggle(req(2, {}, p)));
  assertLocked(await wf.run(req(2, {}, p)));
  assertLocked(await wf.saveDocumentMetadata(req(2, {}, { ...p, nodeId: 1 })));
  assertLocked(await wf.deleteNodeDocument(req(2, {}, { ...p, nodeId: 1, docId: 'd' })));
  assert.equal((d.prepare('SELECT name FROM agent_workflows WHERE id = 75').get() as any).name, 'Mail to PDF');
  const shown = await wf.show(req(2, {}, p));
  assert.deepEqual([shown.data.is_robot, shown.data.locked], [true, true]);
  const list = (await wf.index(req(2))).data as any[];
  assert.deepEqual(list.map((w) => [w.id, w.is_robot, w.locked]), [[75, true, true]]);
});

test('a locked workflow refuses schedule writes and Start option changes', async () => {
  const { d, ids } = await lockSetup();
  const sc = new ScheduledWorkflowController();
  assertLocked(await sc.create(req(2, { workflow_id: 75, scheduled_time: '2026-11-01 10:00:00' })));
  const sid = Number((d.prepare('SELECT id FROM scheduled_workflows WHERE workflow_id = 75').get() as any).id);
  for (const m of ['update', 'destroy', 'pause', 'resume'] as const) {
    assertLocked(await (sc as any)[m](req(2, { scheduled_time: '2026-11-01 10:00:00' }, { id: sid })));
  }
  const cc = new CodeComponentsController();
  assertLocked(await cc.setStartOption(req(2, {}, { id: ids['Poll Drop'] })));
  assertLocked(await cc.clearStartOption(req(2, {}, { id: ids['Poll Drop'] })));
});

test('unlocking allows the edit; a personal active workflow is not locked', async () => {
  const { d } = await lockSetup();
  const wf = new WorkflowController();
  assert.equal((await wf.update(req(3, { name: 'Mine2' }, { id: 9 }))).success, true);
  d.exec('DELETE FROM active_workflows WHERE workflow_id = 75');
  const r = await wf.update(req(2, { name: 'Renamed' }, { id: 75 }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((d.prepare('SELECT name FROM agent_workflows WHERE id = 75').get() as any).name, 'Renamed');
});

test('a caller without access gets 404, never the lock', async () => {
  const { d, ids } = await lockSetup();
  const sc = new ScheduledWorkflowController();
  const sid = Number((d.prepare('SELECT id FROM scheduled_workflows WHERE workflow_id = 75').get() as any).id);
  const rs = [await sc.create(req(1, { workflow_id: 75, scheduled_time: '2026-11-01 10:00:00' }))];
  for (const m of ['update', 'destroy', 'pause', 'resume']) rs.push(await (sc as any)[m](req(1, { scheduled_time: '2026-11-01 10:00:00' }, { id: sid })));
  rs.push(await new CodeComponentsController().setStartOption(req(1, {}, { id: ids['Poll Drop'] })));
  rs.push(await new CodeComponentsController().clearStartOption(req(1, {}, { id: ids['Poll Drop'] })));
  for (const r of rs) {
    assert.equal(r.status_code, 404, JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('Mail to PDF'));
    assert.ok(!('error_code' in r));
  }
});

// ---- robot workflow saves (links resolve against the owner; foreign links refused) ----

async function saveSetup() {
  const { d, ids } = await robotSchema();
  agentsAndPlaybooks(d);
  workflowColumns(d);
  for (const c of ['pos_x INTEGER', 'pos_y INTEGER', 'drawflow_node_id TEXT']) d.exec(`ALTER TABLE workflow_nodes ADD COLUMN ${c}`);
  d.exec('ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT');
  d.exec('CREATE UNIQUE INDEX uq_workflows_user_name ON agent_workflows (user_id, name)');
  d.exec("UPDATE users SET role = 'ops' WHERE id = 3"); // user 3 may use the robot; user 1 may not
  d.exec("INSERT INTO users (id, email, role) VALUES (119, 'filler@x.test', 'user')");
  const robot = await RobotAccount.ensure();
  d.exec(`UPDATE agent_workflows SET user_id = ${robot} WHERE id = 75`);
  d.exec(`UPDATE code_components SET user_id = ${robot}`);
  d.exec(`UPDATE scheduled_workflows SET user_id = ${robot}`);
  const update = (u: number, wf: number, body: any) => new WorkflowController().update(req(u, body, { id: wf }));
  const linked = (wf: number) => (d.prepare("SELECT config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'code' ORDER BY id").all(wf) as any[])
    .map((r) => JSON.parse(r.config).code_component_id ?? null);
  return { d, ids, robot, update, linked };
}

test("a DSL save of a robot workflow links the robot's component, not the editor's", async () => {
  const { ids, update, linked } = await saveSetup();
  const mine = (await new CodeComponentStore().save(3, null, SP)).id;
  const r = await update(3, 75, { definition: { nodes: [{ id: '1', node_type: 'code', config: { type: 'code', name: 'SP', code_component_ref: 'Store SharePoint' } }], edges: [] } });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.notEqual(mine, ids['Store SharePoint']);
  assert.deepEqual(linked(75), [ids['Store SharePoint']]);
});

test('an editor save linking a personal component (or playbook, agent, Start option) into a robot workflow is refused', async () => {
  const { d, ids, robot, update, linked } = await saveSetup();
  const mine = (await new CodeComponentStore().save(3, null, { name: 'Mine', code: '', exits: ['done'], mcp_servers: [] })).id;
  const before = linked(75);
  let r = await update(3, 75, { name: 'Renamed', definition: { nodes: [
    { id: '1', node_type: 'code', config: { type: 'code', name: 'X', code_component_id: mine } },
    { id: '2', node_type: 'code', config: { type: 'code', name: 'PDF', code_component_id: ids['To PDF'] } },
  ], edges: [] } });
  assert.deepEqual([r.success, r.status_code, r.error_code ?? null], [false, 422, 'unknown_references'], JSON.stringify(r));
  assert.deepEqual(r.missing, [`code component #${mine}`]);
  assert.deepEqual(linked(75), before);
  assert.equal((d.prepare('SELECT name FROM agent_workflows WHERE id = 75').get() as any).name, 'Mail to PDF');

  const pb = (await new PlaybookStore().save(3, null, 'Title: Okta\nInstructions: #Reset.\nActions used: #Reset', 'okta-reset')).id;
  d.exec(`INSERT INTO agents (id, user_id, name) VALUES (40, 3, 'Mine'), (41, 1, 'Shared'), (42, ${robot}, 'Robots')`);
  d.exec("UPDATE agents SET visibility = 'public' WHERE id = 41");
  const opt = (await new CodeComponentStore().save(3, null, { ...POLL, name: 'My poll' })).id;
  r = await update(3, 75, { definition: { nodes: [
    { id: '1', node_type: 'start', config: { type: 'start', start_option: opt } },
    { id: '2', node_type: 'playbook', config: { type: 'playbook', playbook_id: pb } },
    { id: '3', node_type: 'agent', agent_id: 40, config: { type: 'agent' } },
    { id: '4', node_type: 'agent', agent_id: 41, config: { type: 'agent' } },
    { id: '5', node_type: 'agent', agent_id: 42, config: { type: 'agent' } },
  ], edges: [] } });
  assert.equal(r.status_code, 422, JSON.stringify(r));
  assert.deepEqual(r.missing, [`start option component #${opt}`, `playbook #${pb}`, 'agent #40']);
});

test("a personal workflow still links its owner's rows; renaming a robot workflow onto a robot name is 409", async () => {
  const { d, ids, robot, update, linked } = await saveSetup();
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
  const mine = (await new CodeComponentStore().save(3, null, SP)).id;
  const r = await update(3, 9, { definition: { nodes: [
    { id: '1', node_type: 'code', config: { type: 'code', name: 'SP', code_component_ref: 'Store SharePoint' } },
    { id: '2', node_type: 'code', config: { type: 'code', name: 'PDF', code_component_id: ids['To PDF'] } },
  ], edges: [] } });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(linked(9), [mine, ids['To PDF']]);

  d.exec(`INSERT INTO agent_workflows (id, user_id, name) VALUES (80, ${robot}, 'Other')`);
  const r2 = await update(3, 75, { name: 'Other' });
  assert.deepEqual([r2.success, r2.status_code, r2.error_code ?? null], [false, 409, 'name_taken'], JSON.stringify(r2));
  assert.equal((d.prepare('SELECT name FROM agent_workflows WHERE id = 75').get() as any).name, 'Mail to PDF');
});

// ---- active rows: a person keeps one, the robot one per workflow ----

async function activeSetup() {
  const { d } = await robotSchema('2026-10-14 09:00:00');
  d.exec("INSERT INTO users (id, email, role, kind) VALUES (9, 'robot@synergyai.invalid', 'robot', 'service')");
  const rows = () => (d.prepare('SELECT user_id, workflow_id FROM active_workflows ORDER BY user_id, workflow_id').all() as any[])
    .map((r) => [Number(r.user_id), Number(r.workflow_id)]);
  return { d, rows, svc: () => new ActiveWorkflowService() };
}

test('a person keeps one row; the robot one per workflow; forWorkflow', async () => {
  const { d, rows, svc } = await activeSetup();
  workflow(d, 9, 3, null);
  row(d, 9, 3, 'daily');
  workflow(d, 10, 3, null);
  row(d, 10, 3, 'daily');
  await svc().activate(3, 9);
  assert.deepEqual((await svc().activate(3, 10)).replaced, { workflow_id: 9, workflow_name: 'wf 9' });
  assert.deepEqual(rows(), [[3, 10]]);

  option(d, 20, 9);
  workflow(d, 85, 9, 20);
  row(d, 85, 9, 'event', 20);
  workflow(d, 86, 9, null);
  row(d, 86, 9, 'daily');
  assert.equal((await svc().activate(9, 85)).replaced, null);
  const r = await svc().activate(9, 86);
  assert.equal(r.replaced, null);
  assert.equal(Number(r.active!.workflow_id), 86);
  assert.deepEqual(rows(), [[3, 10], [9, 85], [9, 86]]);
  await svc().activate(9, 85); // again: still one row for it
  assert.deepEqual(rows(), [[3, 10], [9, 85], [9, 86]]);
  await svc().setState(9, 86, 'scheduled', 'soon'); // only that row
  assert.deepEqual((d.prepare('SELECT watch_state FROM active_workflows WHERE user_id = 9 ORDER BY workflow_id').all() as any[]).map((x) => x.watch_state),
    ['starting', 'scheduled']);
  assert.equal(Number((await svc().forWorkflow(85))!.user_id), 9);
  assert.equal(Number((await svc().forWorkflow(86))!.workflow_id), 86);
  assert.equal(await svc().forWorkflow(75), null);
  await svc().deactivate(9, 85);
  assert.deepEqual(rows(), [[3, 10], [9, 86]]);
});

test('on the old key a second robot workflow is robot_busy (409), not an SQL error', async () => {
  const { d, svc } = await activeSetup();
  d.exec('DROP TABLE active_workflows');
  d.exec(`CREATE TABLE active_workflows (user_id INTEGER NOT NULL PRIMARY KEY, workflow_id INTEGER NOT NULL,
    mode TEXT NOT NULL, trigger_component_id INTEGER, activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting',
    watch_message TEXT, watch_checked_at TEXT)`);
  workflow(d, 85, 9, null);
  row(d, 85, 9, 'daily');
  workflow(d, 86, 9, null);
  row(d, 86, 9, 'daily');
  await svc().activate(9, 85);
  let err: any = null;
  try {
    await svc().activate(9, 86);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ActiveWorkflowError, String(err));
  assert.deepEqual([err.kind, err.status, err.message], ['robot_busy', 409, 'The robot can run one workflow at a time until the database is updated.']);
  await svc().activate(9, 85); // the same one again still works
});

test('a permitted user activates and unlocks a robot workflow; a caller without access gets 404', async () => {
  const { d } = await robotSchema('2026-10-14 09:00:00');
  workflowColumns(d);
  const robot = await RobotAccount.ensure();
  d.exec(`UPDATE agent_workflows SET user_id = ${robot} WHERE id = 75`);
  d.exec(`UPDATE scheduled_workflows SET user_id = ${robot}`);
  d.exec(`UPDATE code_components SET user_id = ${robot}`);
  const c = new ActiveWorkflowController();
  const r = await c.activate(req(2, {}, { id: 75 }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(Number(r.data.active.user_id), robot);
  assert.equal(Number((await c.forWorkflow(req(2, {}, { id: 75 }))).data.user_id), robot);
  assert.equal((await c.forWorkflow(req(1, {}, { id: 75 }))).status_code, 404);
  assert.equal((await c.activate(req(1, {}, { id: 75 }))).status_code, 404);
  assert.equal((await c.deactivate(req(2, {}, { id: 75 }))).success, true);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM active_workflows'), 0);
});
