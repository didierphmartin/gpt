import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installSqliteDb, Sqlite } from './support/sqliteSchemaDb';
import { SCHEMA } from './support/codeComponentsDb';
import { WorkflowRefResolver, UnresolvedRefsException } from '../src/AgentTeam/WorkflowRefResolver';
import { WorkflowController } from '../src/Controllers/WorkflowController';

/**
 * Twins of backend/tests/Unit/WorkflowRefResolverTest.php and Controllers/WorkflowControllerRefsTest.php:
 * names in a saved graph (playbook_ref, code_component_ref, start_option_ref, edge from_port_name) become the
 * owner's ids and ports; unknown names are a 422 listing every one, and create() inserts nothing.
 */

let d: Sqlite;
const r = new WorkflowRefResolver();

function comp(user: number, name: string, exits: string[]): void {
  d.prepare("INSERT INTO code_components (user_id, name, code, exits, mcp_servers) VALUES (?, ?, 'c', ?, '[]')").run(user, name, JSON.stringify(exits));
}

beforeEach(() => {
  d = installSqliteDb(SCHEMA + `
    CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT);
    INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'reset-pw', 'x', 'x'), (3, 'reset-pw', 'y', 'y');`);
  comp(4, 'Poll', ['x']);
  comp(3, 'Poll', ['new_mail', 'no_mail', 'error']);
});

async function missing(nodes: any[], edges: any[] = []): Promise<string[]> {
  try {
    await r.resolve(3, nodes, edges);
  } catch (e) {
    if (e instanceof UnresolvedRefsException) return e.missing;
    throw e;
  }
  throw new Error('expected UnresolvedRefsException');
}

test("a playbook ref becomes the owner's id", async () => {
  const out = await r.resolve(3, [{ id: '1', node_type: 'playbook', config: { type: 'playbook', playbook_ref: 'reset-pw', exits: ['done', 'failed'] } }], []);
  const cfg = out.nodes[0].config;
  assert.equal(cfg.playbook_id, 2);
  assert.ok(!('playbook_ref' in cfg));
  assert.deepEqual(cfg.exits, ['done', 'failed']);
});

test('a component ref, its args and the edge ports', async () => {
  const out = await r.resolve(3, [
    { id: '1', node_type: 'playbook', config: { playbook_ref: 'reset-pw' } },
    { id: '2', node_type: 'code', config: { code_component_ref: 'Poll', args: { a: 1 } } },
    { id: '3', node_type: 'agent', config: {} },
  ], [
    { from: '1', to: '3', from_port_name: 'failed' },
    { from: '1', to: '3', from_port_name: 'done' },
    { from: '2', to: '3', from_port_name: 'no_mail' },
    { from: '2', to: '3', from_port_name: 'error', to_port: 'input_1' },
    { from: '3', to: '1', from_port: 'output_1' },
  ]);
  const cfg = out.nodes[1].config;
  assert.equal(cfg.code_component_id, 2);
  assert.ok(!('code_component_ref' in cfg));
  assert.deepEqual(cfg.args, { a: 1 });
  assert.deepEqual(out.edges.map((e) => e.from_port), ['output_2', 'output_1', 'output_2', 'output_3', 'output_1']);
  assert.ok(!('from_port_name' in out.edges[0]));
  assert.equal(out.edges[3].to_port, 'input_1');
});

test('a start option ref and its edges', async () => {
  const out = await r.resolve(3, [{ id: 's', node_type: 'start', config: { start_option_ref: 'Poll', start_args: { q: 'x' } } },
    { id: 'a', node_type: 'agent', config: {} }], [{ from: 's', to: 'a', from_port_name: 'no_mail' }]);
  assert.equal(out.nodes[0].config.start_option, 2);
  assert.deepEqual(out.nodes[0].config.start_args, { q: 'x' });
  assert.ok(!('start_option_ref' in out.nodes[0].config));
  assert.equal(out.edges[0].from_port, 'output_2');
});

test('unknown playbooks, components and exits are listed together', async () => {
  const m = await missing([
    { id: '1', node_type: 'playbook', config: { playbook_ref: 'nope' } },
    { id: '2', node_type: 'code', config: { code_component_ref: 'Ghost' } },
  ]);
  assert.deepEqual(m, ["playbook 'nope'", "code component 'Ghost'"]);
  const e = await missing([{ id: '1', node_type: 'code', config: { code_component_ref: 'Poll' } }, { id: '2', node_type: 'agent', config: {} }],
    [{ from: '1', to: '2', from_port_name: 'bogus' }]);
  assert.deepEqual(e, ["exit 'bogus' on node '1'"]);
});

test("another user's playbook is not used; a graph without refs is unchanged", async () => {
  d.exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'only-theirs', 'x', 'x')");
  assert.equal((await missing([{ id: '1', node_type: 'playbook', config: { playbook_ref: 'only-theirs' } }])).length, 1);
  const nodes = [{ id: '1', node_type: 'agent', config: { x: 1 } }, { id: '2', node_type: 'code', config: { code: 'y', exits: ['next'] } }];
  const edges = [{ from: '1', to: '2', from_port: 'output_2' }];
  assert.deepEqual(await r.resolve(3, nodes, edges), { nodes, edges });
});

// ---- WorkflowController create/update ----

function controllerDb(): void {
  d.exec('DROP TABLE agent_workflows');
  d.exec(`CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,
    description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,
    output_folder TEXT, orchestration TEXT DEFAULT 'workflow', automation_id INTEGER, created_at TEXT, updated_at TEXT)`);
}
const ctx = (body: any, id?: number): any => ({ body, user_id: 3, params: id ? { id: String(id) } : {}, query: {}, headers: {} });
const create = (nodes: any[], edges: any[] = []) => new WorkflowController().create(ctx({ name: 'Reset', definition: { nodes, edges } }));
const count = () => Number((d.prepare('SELECT COUNT(*) AS c FROM agent_workflows').get() as any).c);

test('create: unknown names give 422 and insert no workflow', async () => {
  controllerDb();
  const res = await create([{ id: '1', node_type: 'playbook', config: { playbook_ref: 'nope' } }]);
  assert.equal(res.status_code, 422);
  assert.equal(res.error, 'unknown references');
  assert.deepEqual(res.missing, ["playbook 'nope'"]);
  assert.equal(count(), 0);
});

test('create: a valid named graph creates the workflow with resolved ids; update resolves too', async () => {
  controllerDb();
  const res = await create(
    [{ id: '1', node_type: 'playbook', config: { playbook_ref: 'reset-pw' } }, { id: '2', node_type: 'agent', config: {} }],
    [{ from: '1', to: '2', from_port_name: 'failed' }],
  );
  assert.equal(res.status_code, 201, JSON.stringify(res));
  const cfg = JSON.parse((d.prepare("SELECT config FROM workflow_nodes WHERE node_type = 'playbook'").get() as any).config);
  assert.equal(cfg.playbook_id, 2);
  assert.ok(!('playbook_ref' in cfg));
  assert.equal((d.prepare('SELECT from_port FROM workflow_edges').get() as any).from_port, 'output_2');
  assert.equal(count(), 1);

  const id = Number((d.prepare('SELECT id FROM agent_workflows').get() as any).id);
  const bad = await new WorkflowController().update(ctx({ definition: { nodes: [{ id: '1', node_type: 'code', config: { code_component_ref: 'Ghost' } }], edges: [] } }, id));
  assert.deepEqual(bad, { success: false, error: 'unknown references', missing: ["code component 'Ghost'"], status_code: 422 });
  const ok = await new WorkflowController().update(ctx({ definition: { nodes: [{ id: '1', node_type: 'code', config: { code_component_ref: 'Poll' } },
    { id: '2', node_type: 'agent', config: {} }], edges: [{ from: '1', to: '2', from_port_name: 'error' }] } }, id));
  assert.equal(ok.status_code, 200, JSON.stringify(ok));
  assert.equal((d.prepare('SELECT from_port FROM workflow_edges').get() as any).from_port, 'output_3');
});
