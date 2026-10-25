import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installSqliteDb, SqliteDb } from './support/sqliteDb';
import { db } from '../src/db/pools';
import { AutomationStore } from '../src/Automation/AutomationStore';
import { AutomationError } from '../src/Automation/AutomationError';
import { AutomationMcp, CallRawAnswer } from '../src/Automation/AutomationMcp';
import { AutomationsController } from '../src/Controllers/AutomationsController';
import { WorkflowRepository } from '../src/AgentTeam/WorkflowRepository';
import { PlaybookStore } from '../src/Playbook/PlaybookStore';
import { Ctx } from '../src/Support/Http';

/**
 * Twins of backend/tests/Unit/Automation/AutomationStoreTest.php and AutomationsControllerTest.php (SQLite in memory,
 * as the PHP tests use), plus PlaybookStoreTest::testListShowsWhichAutomationManagesEachPlaybook.
 */

const SPEC = { name: 'okta-reset', form: { variables: [{ name: 'user_email', mandatory: true }, { name: 'reason' }] } };

function schema(d: SqliteDb): void {
  d.exec(`CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, automation_key TEXT NOT NULL,
    title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, spec_json TEXT NOT NULL, playbook_id INTEGER, workflow_id INTEGER,
    sn_scope TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, automation_key))`);
  d.exec(`CREATE TABLE automation_instances (automation_id INTEGER NOT NULL, mcp_server_id INTEGER NOT NULL, installed_version INTEGER,
    sn_item_sys_id TEXT, last_check_at TEXT, status TEXT NOT NULL DEFAULT 'not_installed', detail TEXT, PRIMARY KEY (automation_id, mcp_server_id))`);
  d.exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER DEFAULT 1)');
  d.exec(`CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,
    description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,
    output_folder TEXT, orchestration TEXT DEFAULT 'workflow', created_at TEXT, updated_at TEXT, automation_id INTEGER)`);
  d.exec(`CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, created_at TEXT,
    updated_at TEXT, published_by INTEGER NULL, published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER, UNIQUE (user_id, pkey))`);
  d.exec('CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, playbook_id INTEGER)');
  d.exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT)');
}

const scalar = (d: SqliteDb, q: string): any => {
  const r = d.prepare(q).get() as any;
  return r === undefined ? undefined : Object.values(r)[0];
};

let d: SqliteDb;
let store: AutomationStore;

beforeEach(() => {
  d = installSqliteDb();
  schema(d);
  store = new AutomationStore();
});

async function rejects(p: Promise<any>, status: number): Promise<void> {
  await assert.rejects(p, (e: any) => e instanceof AutomationError && e.status === status);
}

// ── AutomationStore ──────────────────────────────────────────────────────────

test('store: create gives version 1 and the same key bumps keeping the id', async () => {
  const a = await store.save(3, 'okta-reset', 'Okta', SPEC);
  assert.equal(a.version, 1);
  const b = await store.save(3, 'okta-reset', 'Okta v2', { ...SPEC, x: 1 });
  assert.equal(b.id, a.id);
  assert.equal(b.version, 2);
  assert.equal(b.title, 'Okta v2');
  assert.equal((await store.get(3, a.id))!.spec.x, 1);
  assert.equal(Number(scalar(d, 'SELECT COUNT(*) FROM automations')), 1);
});

test("store: another user's key is independent", async () => {
  const a = await store.save(3, 'okta-reset', 'Okta', SPEC);
  const b = await store.save(4, 'okta-reset', 'Okta', SPEC);
  assert.notEqual(a.id, b.id);
  assert.equal(b.version, 1);
  assert.equal(await store.get(4, a.id), null);
});

test('store: a bad key is rejected', async () => {
  for (const k of ['Okta', 'a', '-x', 'has space', 'a'.repeat(42), 'x_y']) {
    await rejects(store.save(3, k, 'T', SPEC), 400);
  }
});

test('store: link stamps automation_id and refuses foreign rows', async () => {
  const a = await store.save(3, 'okta-reset', 'Okta', SPEC);
  d.exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x'), (4, 'k2', 't', 'x')");
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')");
  const r = await store.link(3, a.id, 1, 1);
  assert.equal(r.playbook_id, 1);
  assert.equal(r.workflow_id, 1);
  assert.equal(Number(scalar(d, 'SELECT automation_id FROM playbooks WHERE id = 1')), a.id);
  assert.equal(Number(scalar(d, 'SELECT automation_id FROM agent_workflows WHERE id = 1')), a.id);
  await rejects(store.link(3, a.id, 2, null), 404);
  assert.equal(scalar(d, 'SELECT automation_id FROM playbooks WHERE id = 2'), null);
});

test('store: a workflow read returns automation_id after link; a normal save keeps it', async () => {
  const a = await store.save(3, 'okta-reset', 'Okta', SPEC);
  d.exec("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')");
  await store.link(3, a.id, null, 1);
  const repo = new WorkflowRepository();
  const { workflowToArray, workflowToApiArray } = await import('../src/AgentTeam/WorkflowRepository');
  assert.equal(workflowToArray((await repo.findById(1))!).automation_id, a.id);
  assert.equal(workflowToApiArray((await repo.findById(1))!).automation_id, a.id);
  await repo.update((await repo.findById(1))!); // a normal save must not clear the stamp
  assert.equal(workflowToArray((await repo.findById(1))!).automation_id, a.id);
});

test('store: replaceSpec does not bump the version', async () => {
  const a = await store.save(3, 'okta-reset', 'Okta', SPEC);
  await store.replaceSpec(3, a.id, { name: 'okta-reset', changed: true });
  const row = (await store.get(3, a.id))!;
  assert.equal(row.version, 1);
  assert.equal(row.spec.changed, true);
});

test('playbook list shows which automation manages each playbook', async () => {
  const OKTA = 'Title: Okta password reset\nTrigger: A user is locked out.\nInstructions:\n1. #Search Okta Users with the email.\n';
  const pb = new PlaybookStore(db);
  const row = await pb.save(3, null, OKTA, 'okta-reset');
  assert.equal((await pb.list(3))[0].automation_id, null);
  d.prepare('UPDATE playbooks SET automation_id = 9 WHERE id = ?').run(row.id);
  assert.equal((await pb.list(3))[0].automation_id, 9);
});

// ── AutomationsController ────────────────────────────────────────────────────

class FakeMcp implements AutomationMcp {
  describeAnswers: Record<string, CallRawAnswer> = {}; // server name => callRaw-shaped answer
  installCalls: Array<{ url: string; headerLines: string[]; args: any; timeoutSeconds: number }> = [];
  installAnswer: CallRawAnswer = { ok: true, result: { structuredContent: { installed: true, scope: 'x_a' } } };
  duringInstall: (() => void) | null = null;

  async describe(_userId: number, serverName: string, _key: string): Promise<CallRawAnswer> {
    return this.describeAnswers[serverName] ?? { ok: false, error: 'unreachable' };
  }

  async install(url: string, headerLines: string[], args: any, timeoutSeconds: number): Promise<CallRawAnswer> {
    this.installCalls.push({ url, headerLines, args, timeoutSeconds });
    if (this.duringInstall) this.duringInstall();
    return this.installAnswer;
  }
}

function req(body: any = {}, params: Record<string, string> = {}, user: number | null = 3): Ctx {
  return { method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: user, auth_type: 'jwt', params, remote_addr: '' };
}

let mcp: FakeMcp;
let ctl: AutomationsController;

function setupController(): void {
  d.exec(`INSERT INTO mcp_servers (user_id, name, url, headers) VALUES
    ('3', 'ServiceNow PDI', 'https://h/servicenow/pdi/jobs', '{"Authorization":"Bearer SECRET"}'),
    ('3', 'ServiceNow Prod', 'https://h/servicenow/prod/jobs/mcp', NULL),
    ('3', 'Outlook', 'https://h/outlook', NULL),
    ('4', 'ServiceNow Other', 'https://h/servicenow/o/jobs', NULL)`);
  mcp = new FakeMcp();
  ctl = new AutomationsController(db, mcp);
}

const create = (user = 3) => ctl.create(req({ key: 'okta-reset', title: 'Okta', spec: SPEC }, {}, user));

const ok = (variables: any[], version: number | null = 1, env = 'dev'): CallRawAnswer =>
  ({ ok: true, result: { structuredContent: { environment: env, item: { sys_id: 'abc', name: 'Okta', version, variables } } } });

const byServer = (r: any) => Object.fromEntries(r.data.instances.map((i: any) => [i.mcp_server_id, i]));

test('controller: install records the scope on a fresh connection when the old one went away', async () => {
  d.exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES ('3', 'ServiceNow PDI', 'https://h/servicenow/pdi/jobs', NULL)");
  mcp = new FakeMcp();
  let reconnects = 0;
  const c = new AutomationsController(db, mcp, () => {
    reconnects++;
    d.gone = false; // the fresh connection
    return db;
  });
  await c.create(req({ key: 'okta-reset', title: 'Okta', spec: SPEC }));
  mcp.duringInstall = () => { d.gone = true; };
  const r = await c.install(req({ server_id: 1, scope: 'x_a', files: { a: 'b' } }, { id: '1' }));
  assert.equal(r.status_code, 200, JSON.stringify(r));
  assert.equal(reconnects, 1);
  assert.equal(scalar(d, 'SELECT sn_scope FROM automations WHERE id = 1'), 'x_a');
});

test('controller: create returns the shape and the servers', async () => {
  setupController();
  const r = await create();
  assert.equal(r.status_code, 201);
  const dd = r.data;
  assert.deepEqual({ id: dd.id, key: dd.key, version: dd.version, playbook_id: dd.playbook_id, workflow_id: dd.workflow_id },
    { id: 1, key: 'okta-reset', version: 1, playbook_id: null, workflow_id: null });
  assert.deepEqual(dd.servers, [{ id: 1, name: 'ServiceNow PDI', environment: null }, { id: 2, name: 'ServiceNow Prod', environment: null }]);
  const again = await create();
  assert.equal(again.data.version, 2);
  assert.equal(again.data.id, 1);
});

test('controller: create validates', async () => {
  setupController();
  assert.equal((await ctl.create(req({ key: 'Bad Key', title: 'T', spec: [] }))).status_code, 400);
  assert.equal((await ctl.create(req({ key: 'okta-reset', title: '', spec: { a: 1 } }))).status_code, 400);
  assert.equal((await ctl.create(req({}, {}, null))).status_code, 401);
});

test('controller: update links and replaces the spec without a bump', async () => {
  setupController();
  await create();
  d.exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x')");
  const r = await ctl.update(req({ playbook_id: 1, spec: { name: 'okta-reset', n: 2 } }, { id: '1' }));
  assert.equal(r.status_code, 200);
  assert.equal(r.data.playbook_id, 1);
  assert.equal(r.data.version, 1);
  assert.ok('servers' in r.data);
  assert.equal(JSON.parse(scalar(d, 'SELECT spec_json FROM automations')).n, 2);
  assert.equal((await ctl.update(req({ workflow_id: 5 }, { id: '1' }))).status_code, 404);
  assert.equal((await ctl.update(req({ playbook_id: 1 }, { id: '1' }, 4))).status_code, 404);
});

test('controller: check in sync, missing variable, not installed and forbidden', async () => {
  setupController();
  await create();
  const vars = [{ name: 'user_email', type: '6', mandatory: true }, { name: 'reason', type: '6', mandatory: false }];
  mcp.describeAnswers['ServiceNow PDI'] = ok(vars);
  mcp.describeAnswers['ServiceNow Prod'] = { ok: true, result: { structuredContent: { environment: 'prod', item: null } } };
  let r = await ctl.check(req({}, { id: '1' }));
  let by = byServer(r);
  assert.equal(by[1].status, 'in_sync');
  assert.equal(by[1].installed_version, 1);
  assert.equal(by[1].sn_item_sys_id, 'abc');
  assert.equal(by[1].environment, 'dev');
  assert.equal(by[2].status, 'not_installed');
  // servers now carry the environment from the latest check
  assert.equal(r.data.servers[0].environment, 'dev');
  assert.equal(r.data.servers[1].environment, 'prod');

  // drift: reason missing, mandatory flipped, older version
  mcp.describeAnswers['ServiceNow PDI'] = ok([{ name: 'user_email', type: '6', mandatory: false }, { name: 'extra', type: '6', mandatory: false }], 0);
  r = await ctl.check(req({}, { id: '1' }));
  by = byServer(r);
  assert.equal(by[1].status, 'out_of_sync');
  for (const needle of ['reason', 'extra', 'user_email', 'version']) {
    assert.ok(by[1].detail.includes(needle), needle);
  }
  assert.equal(Number(scalar(d, 'SELECT COUNT(*) FROM automation_instances WHERE mcp_server_id = 1')), 1);

  mcp.describeAnswers['ServiceNow PDI'] = { ok: true, result: { isError: true, structuredContent: { error: { code: 'forbidden', message: 'no read' } } } };
  delete mcp.describeAnswers['ServiceNow Prod'];
  r = await ctl.check(req({}, { id: '1' }));
  by = byServer(r);
  assert.equal(by[1].status, 'out_of_sync');
  assert.equal(by[1].detail, 'cannot check: forbidden');
  assert.equal(by[2].status, 'out_of_sync');
  assert.equal(by[2].detail, 'cannot check: unreachable');
});

test("controller: check reads the loader's content-text answer", async () => {
  setupController();
  await create();
  mcp.describeAnswers['ServiceNow PDI'] = { ok: true, result: JSON.parse('{"content":[{"type":"text","text":"{\\"environment\\":\\"dev\\",\\"item\\":null}"}],'
    + '"structuredContent":{"environment":"dev","item":null},"isError":false}') };
  const by = byServer(await ctl.check(req({}, { id: '1' })));
  assert.equal(by[1].status, 'not_installed');
  assert.equal(by[1].environment, 'dev');
});

test('controller: a garbled describe answer reads as bad_answer', async () => {
  setupController();
  await create();
  // no `item` key at all (or not an object): not a "not installed" answer, the check cannot conclude
  mcp.describeAnswers['ServiceNow PDI'] = { ok: true, result: { structuredContent: { environment: 'dev' } } };
  mcp.describeAnswers['ServiceNow Prod'] = { ok: true, result: { structuredContent: { environment: 'prod', item: 'abc' } } };
  const by = byServer(await ctl.check(req({}, { id: '1' })));
  for (const sid of [1, 2]) {
    assert.equal(by[sid].status, 'out_of_sync');
    assert.equal(by[sid].detail, 'cannot check: bad_answer');
  }
});

test('controller: check ignores other users and automations', async () => {
  setupController();
  await create();
  assert.equal((await ctl.check(req({}, { id: '1' }, 4))).status_code, 404);
});

test('controller: the list includes instances and servers', async () => {
  setupController();
  await create();
  mcp.describeAnswers['ServiceNow PDI'] = ok([]);
  await ctl.check(req({}, { id: '1' }));
  const r = await ctl.index(req());
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].instances.length, 2);
  assert.equal(r.data[0].servers.length, 2);
  assert.deepEqual((await ctl.index(req({}, {}, 4))).data, []);
});

test('controller: deploy URL derivation', () => {
  assert.equal(AutomationsController.deployUrl('https://h/servicenow/pdi/jobs'), 'https://h/servicenow/pdi/deploy');
  assert.equal(AutomationsController.deployUrl('https://h/servicenow/pdi/jobs/mcp'), 'https://h/servicenow/pdi/deploy');
  assert.equal(AutomationsController.deployUrl('https://h/servicenow/pdi/jobs/'), 'https://h/servicenow/pdi/deploy');
  assert.equal(AutomationsController.deployUrl('https://h/servicenow/pdi/other'), null);
});

test('controller: install sends the stored headers and never returns them', async () => {
  setupController();
  await create();
  const r = await ctl.install(req({ server_id: 1, scope: 'x_a', files: { 'package.json': '{}' } }, { id: '1' }));
  assert.equal(r.status_code, 200);
  const call = mcp.installCalls[0];
  assert.equal(call.url, 'https://h/servicenow/pdi/deploy');
  assert.ok(call.headerLines.includes('Authorization: Bearer SECRET'));
  assert.equal(call.timeoutSeconds, 900);
  assert.deepEqual(call.args, { scope: 'x_a', files: { 'package.json': '{}' } });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(scalar(d, 'SELECT sn_scope FROM automations'), 'x_a');
});

test('controller: install errors map to statuses', async () => {
  setupController();
  await create();
  const body = { server_id: 1, scope: 'x_a', files: { a: 'b' } };
  mcp.installAnswer = { ok: true, result: { isError: true, structuredContent: { error: { code: 'not_allowed', message: 'prod' } } } };
  let r = await ctl.install(req(body, { id: '1' }));
  assert.equal(r.status_code, 409);
  assert.equal(r.code, 'not_allowed');
  // the connector's message (for install_failed: the step and its log tail) reaches the caller
  mcp.installAnswer = { ok: true, result: { isError: true, structuredContent: { error: { code: 'install_failed', message: 'exit 1 from npx now-sdk install: 401 Unauthorized' } } } };
  r = await ctl.install(req(body, { id: '1' }));
  assert.equal(r.code, 'install_failed');
  assert.equal(r.message, 'exit 1 from npx now-sdk install: 401 Unauthorized');
  assert.equal(r.error, 'install_failed: exit 1 from npx now-sdk install: 401 Unauthorized');
  mcp.installAnswer = { ok: false, error: 'unreachable' };
  assert.equal((await ctl.install(req(body, { id: '1' }))).status_code, 502);
  // a server of another user, a non-ServiceNow URL, a bad body
  assert.equal((await ctl.install(req({ ...body, server_id: 4 }, { id: '1' }))).status_code, 404);
  assert.equal((await ctl.install(req({ ...body, server_id: 3 }, { id: '1' }))).status_code, 400);
  assert.equal((await ctl.install(req({ ...body, files: [] }, { id: '1' }))).status_code, 400);
  // a numeric file key is an integer key in PHP, not a path
  assert.equal((await ctl.install(req({ ...body, files: { 1: 'x' } }, { id: '1' }))).status_code, 400);
});
