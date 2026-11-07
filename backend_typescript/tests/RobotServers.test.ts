import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installSqliteDb, Sqlite } from './support/sqliteSchemaDb';
import { MCPProxyController } from '../src/Controllers/MCPProxyController';
import { RobotServersController } from '../src/Controllers/RobotServersController';
import { RobotAccount } from '../src/Services/RobotAccount';
import { RobotMcpServers } from '../src/Services/RobotMcpServers';

// Port of backend/tests/Unit/Controllers/RobotServersControllerTest.php and RobotServersCompileEnvTest.php
// (+ the RobotMcpServers rule). The policy is stubbed: user 2 may use the robot, user 1 may not.

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, first_name TEXT, last_name TEXT,
  role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0);
CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT);
INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}');
INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops');
CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
  description TEXT, headers TEXT NULL, transport TEXT DEFAULT 'http', enabled INTEGER DEFAULT 1, is_mock INTEGER DEFAULT 0,
  UNIQUE (user_id, name));
CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, tool_name TEXT);
`;

let sent: Array<[string, any, Record<string, string>]> = [];

/** MCPProxyController with the wire stubbed: records what would have been sent. */
class RecordingProxy extends MCPProxyController {
  protected async sendToMCPServer(serverUrl: string, request: any, _e = true, extraHeaders: Record<string, string> = {}): Promise<any> {
    sent.push([serverUrl, request?.method ?? null, extraHeaders]);
    return { jsonrpc: '2.0', id: request?.id ?? 1, result: { ok: true } };
  }
}

let db: Sqlite;
let robot: number;

beforeEach(async () => {
  db = installSqliteDb(SCHEMA);
  robot = await RobotAccount.ensure();
  sent = [];
});

const ctl = () => new RobotServersController({ edition: 'corporate' }, () => new RecordingProxy(), () => ({ canUse: async (u: number) => u === 2 }));
const req = (u: number, body: Record<string, any> = {}, params: Record<string, any> = {}): any =>
  ({ method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: u, auth_type: 'jwt', params, remote_addr: '' });
const add = async (b: Record<string, any> = {}) => (await ctl().create(req(2, { name: 'Outlook', url: 'https://mcp.test/outlook', ...b }))).data.id as number;

test('list shows header names, not values', async () => {
  const id = await add({ description: 'mail' });
  await ctl().saveKey(req(2, { header: 'X-Org-Key', key: 'sekret-value' }, { id }));
  const r = await ctl().index(req(2));
  assert.deepEqual(r.data, [{ id, name: 'Outlook', url: 'https://mcp.test/outlook', description: 'mail', enabled: true, header_names: ['X-Org-Key'] }]);
  assert.ok(!JSON.stringify(r).includes('sekret-value'));
});

test('CRUD only on robot rows', async () => {
  db.exec("INSERT INTO mcp_servers (id, user_id, name, url) VALUES (99, '2', 'Mine', 'https://x.test')");
  const c = ctl();
  assert.deepEqual((await c.index(req(2))).data, []);
  for (const r of [
    await c.update(req(2, { name: 'Z' }, { id: 99 })),
    await c.destroy(req(2, {}, { id: 99 })),
    await c.call(req(2, { tool: 't' }, { id: 99 })),
    await c.saveKey(req(2, { header: 'H', key: 'k' }, { id: 99 })),
  ]) {
    assert.deepEqual([r.success, r.status_code], [false, 404]);
  }
  assert.equal(db.prepare('SELECT name FROM mcp_servers WHERE id = 99').get().name, 'Mine');
  const id = await add();
  assert.equal((await c.update(req(2, { name: 'Outlook2', enabled: false }, { id }))).success, true);
  const row = db.prepare('SELECT name, enabled, user_id FROM mcp_servers WHERE id = ?').get(id);
  assert.deepEqual([row.name, Number(row.enabled), String(row.user_id)], ['Outlook2', 0, String(robot)]);
  assert.equal((await c.destroy(req(2, {}, { id }))).success, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get().n, 1);
});

test('key merged into headers', async () => {
  const id = await add();
  await ctl().saveKey(req(2, { header: 'X-A', key: 'one' }, { id }));
  await ctl().saveKey(req(2, { header: 'X-B', key: 'two' }, { id }));
  await ctl().saveKey(req(2, { header: 'X-A', key: 'three' }, { id }));
  assert.deepEqual(JSON.parse(db.prepare('SELECT headers FROM mcp_servers WHERE id = ?').get(id).headers), { 'X-A': 'three', 'X-B': 'two' });
  assert.equal((await ctl().saveKey(req(2, { header: '', key: 'k' }, { id }))).status_code, 400);
});

test('call uses the row headers', async () => {
  const id = await add();
  await ctl().saveKey(req(2, { header: 'X-Org-Key', key: 'abc' }, { id }));
  const r = await ctl().call(req(2, { tool: 'list_mail', arguments: { n: 1 } }, { id }));
  assert.equal(r.success, true);
  assert.deepEqual(r.data.result, { ok: true });
  assert.deepEqual(sent[sent.length - 1], ['https://mcp.test/outlook', 'tools/call', { 'X-Org-Key': 'abc' }]);
});

test('url change clears the key so it is never sent elsewhere', async () => {
  const id = await add();
  await ctl().saveKey(req(2, { header: 'X-Org-Key', key: 'abc' }, { id }));
  assert.equal((await ctl().update(req(2, { url: 'https://evil.test/mcp' }, { id }))).success, true);
  assert.deepEqual((await ctl().index(req(2))).data[0].header_names, []);
  await ctl().call(req(2, { tool: 't' }, { id }));
  assert.ok(sent.every(([, , h]) => Object.keys(h).length === 0));
  assert.equal(sent[0][0], 'https://evil.test/mcp');
  // an unchanged url keeps the key
  await ctl().saveKey(req(2, { header: 'X-Org-Key', key: 'abc' }, { id }));
  await ctl().update(req(2, { url: 'https://evil.test/mcp', description: 'd' }, { id }));
  assert.deepEqual((await ctl().index(req(2))).data[0].header_names, ['X-Org-Key']);
});

test('call refuses a disabled row', async () => {
  const id = await add();
  await ctl().update(req(2, { enabled: false }, { id }));
  const r = await ctl().call(req(2, { tool: 't' }, { id }));
  assert.deepEqual([r.success, r.status_code], [false, 409]);
  assert.deepEqual(sent, []);
});

test('rename to an existing name is 409', async () => {
  const a = await add();
  const b = await add({ name: 'SharePoint' });
  const r = await ctl().update(req(2, { name: 'Outlook' }, { id: b }));
  assert.deepEqual([r.success, r.status_code], [false, 409]);
  assert.equal((await ctl().update(req(2, { name: 'Outlook', description: 'x' }, { id: a }))).success, true);
});

test('every route 403 without use_robot; 401 without a user', async () => {
  const id = await add();
  const c = ctl();
  const p = { id };
  for (const r of [
    await c.index(req(1)),
    await c.compileEnv(req(1)),
    await c.create(req(1, { name: 'N', url: 'https://a.test' })),
    await c.update(req(1, { name: 'N' }, p)),
    await c.destroy(req(1, {}, p)),
    await c.call(req(1, { tool: 't' }, p)),
    await c.saveKey(req(1, { header: 'H', key: 'k' }, p)),
  ]) {
    assert.deepEqual([r.success, r.status_code], [false, 403]);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get().n, 1);
  assert.equal((await c.index(req(0))).status_code, 401);
});

test('compile-env: MCP_HEADERS_<SLUG> of enabled robot servers with headers', async () => {
  const a = await add();
  await ctl().saveKey(req(2, { header: 'X-Org-Key', key: 'abc' }, { id: a }));
  const b = await add({ name: 'Share Point', url: 'https://mcp.test/sp' });
  await ctl().saveKey(req(2, { header: 'Authorization', key: 'Bearer t' }, { id: b }));
  await ctl().update(req(2, { enabled: false }, { id: b }));
  await add({ name: 'NoKey', url: 'https://mcp.test/nk' });
  assert.deepEqual((await ctl().compileEnv(req(2))).data, { vars: { MCP_HEADERS_OUTLOOK: '{"X-Org-Key":"abc"}' } });
});

test('RobotMcpServers.missing names the caller servers the robot has no enabled server for', async () => {
  db.exec(`INSERT INTO mcp_servers (id, user_id, name, url) VALUES (10, '2', 'Outlook', 'https://o'), (11, '2', 'Share Point', 'https://s');
    INSERT INTO mcp_server_tools (server_id, tool_name) VALUES (10, 'list_mail'), (11, 'upload');`);
  db.prepare("INSERT INTO mcp_servers (user_id, name, url) VALUES (?, 'share-point', 'https://r')").run(String(robot));
  assert.deepEqual(await RobotMcpServers.missing('2', String(robot), ['mcp_list_mail', 'mcp_upload', 'other']), ['Outlook']);
  assert.deepEqual(await RobotMcpServers.missing('2', String(robot), null), []);
  assert.equal(RobotMcpServers.missingResponse('Outlook').status_code, 422);
});
