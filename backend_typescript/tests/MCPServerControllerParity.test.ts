import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { MCPServerController } from '../src/Controllers/MCPServerController';
import { MCPProxyController } from '../src/Controllers/MCPProxyController';
import { filterValidateUrl } from '../src/Support/PhpUrl';
import { Ctx } from '../src/Support/Http';

/**
 * MCPServerController response shapes vs backend/src/Controllers/MCPServerController.php: the int
 * casts, the derived server_type, the transport validation, the global-headers redaction and PHP's
 * json_decode($s, true) of input_schema (an empty `{}` answers as `[]`).
 */

const ME = 3;
let d: DatabaseSync;

beforeEach(() => {
  d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT UNIQUE, url TEXT, description TEXT,
    headers TEXT, transport TEXT DEFAULT 'http', enabled INTEGER DEFAULT 1, is_mock INTEGER NOT NULL DEFAULT 0)`);
  d.exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, input_schema TEXT, has_ui INTEGER DEFAULT 0)');
  d.exec('CREATE TABLE user_mcp_overrides (user_id INTEGER, server_id INTEGER, allowed INTEGER)');
  d.exec(`INSERT INTO mcp_servers (id, user_id, name, url, headers, transport, is_mock) VALUES
    (1, NULL, 'Global', 'https://g.test/mcp', '{"Authorization":"secret"}', 'SSE', 1),
    (2, '${ME}', 'Mine', 'https://me.test/mcp', '{"X-Key":"k"}', NULL, 0)`);
  d.exec(`INSERT INTO mcp_servers (id, user_id, name, url, enabled) VALUES (3, '${ME}', 'Off', 'https://off.test/mcp', 0)`);
  d.exec(`INSERT INTO mcp_server_tools (id, server_id, tool_name, input_schema, has_ui) VALUES
    (1, 1, 'app_tool', '{"type":"object","properties":{}}', 1), (2, 2, 'plain', '{"type":"object","properties":{}}', 0)`);
  installFakeDb((sqlText, params) => {
    const st = d.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) return st.all(...ps) as any[];
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid), numAffectedRows: Number(r.changes) };
  });
});

function ctx(body: Record<string, any> = {}, query: Record<string, unknown> = {}): Ctx {
  return { method: 'POST', uri: '/', headers: {}, query, body, user_id: ME, auth_type: 'jwt', params: {}, remote_addr: '127.0.0.1' };
}

const count = () => (d.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as any).n;

test('list casts the counts, derives server_type, normalizes transport and redacts global headers', async () => {
  const r: any = await new MCPServerController().list(ctx());
  const [g, mine] = r.servers;
  assert.deepEqual(r.servers.map((s: any) => s.name), ['Global', 'Mine']);
  assert.deepEqual(
    { ui: g.ui_tool_count, tc: g.tool_count, type: g.server_type, transport: g.transport, mock: g.is_mock, enabled: g.enabled, headers: g.headers },
    { ui: 1, tc: 1, type: 'mcp_app', transport: 'sse', mock: 1, enabled: 1, headers: null },
  );
  assert.deepEqual(
    { ui: mine.ui_tool_count, type: mine.server_type, transport: mine.transport, mock: mine.is_mock, headers: mine.headers },
    { ui: 0, type: 'mcp', transport: 'http', mock: 0, headers: { 'X-Key': 'k' } },
  );
});

test('list includes disabled servers only with include_disabled', async () => {
  const on: any = await new MCPServerController().list(ctx({}, { include_disabled: '1' }));
  assert.deepEqual(on.servers.map((s: any) => s.name), ['Global', 'Mine', 'Off']);
  const off: any = await new MCPServerController().list(ctx({}, { include_disabled: '0' }));
  assert.deepEqual(off.servers.map((s: any) => s.name), ['Global', 'Mine']);
});

test('all-tools and tools answer an empty properties object as [] (PHP json_decode assoc)', async () => {
  const all: any = await new MCPServerController().getAllTools(ctx());
  assert.deepEqual(all.tools.map((t: any) => t.input_schema), [{ type: 'object', properties: [] }, { type: 'object', properties: [] }]);
  const one: any = await new MCPServerController().getTools(ctx({}, { server_id: '2' }));
  assert.deepEqual(one.tools[0].input_schema, { type: 'object', properties: [] });
});

test('create refuses an unknown transport and a URL filter_var rejects, writing nothing', async () => {
  const c = new MCPServerController();
  const bad: any = await c.create(ctx({ name: 'x', url: 'http://127.0.0.1:1/mcp', transport: 'stdio' }));
  assert.deepEqual(bad, { status_code: 400, success: false, error: 'Invalid transport (expected "http" or "sse")' });
  const host: any = await c.create(ctx({ name: 'x', url: 'http://ex_ample.com/p' }));
  assert.equal(host.error, 'Invalid URL format');
  const zero: any = await c.create(ctx({ name: '0', url: 'http://127.0.0.1:1/mcp' }));
  assert.equal(zero.error, 'Name and URL are required');
  assert.equal(count(), 3);
});

test('create stores the transport; update validates and stores it only when sent', async () => {
  const c = new MCPServerController();
  const r: any = await c.create(ctx({ name: 'S', url: 'https://s.test/mcp', transport: 'SSE' }));
  const id = Number(r.server_id);
  const row = () => d.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any;
  assert.equal(row().transport, 'sse');
  const bad: any = await c.update(ctx({ server_id: id, name: 'S', url: 'https://s.test/mcp', transport: 'stdio' }));
  assert.equal(bad.status_code, 400);
  assert.equal(bad.error, 'Invalid transport (expected "http" or "sse")');
  await c.update(ctx({ server_id: id, name: 'S', url: 'https://s.test/mcp' }));
  assert.equal(row().transport, 'sse');
  await c.update(ctx({ server_id: id, name: 'S', url: 'https://s.test/mcp', transport: 'http', headers: { A: 'b/c' } }));
  assert.equal(row().transport, 'http');
  assert.equal(row().headers, '{"A":"b\\/c"}');
});

test('me/mcp-servers carries is_mock as a boolean', async () => {
  const r: any = await new MCPServerController().listMine(ctx());
  assert.deepEqual(r.servers.map((s: any) => [s.name, s.is_mock]), [['Global', true], ['Mine', false], ['Off', false]]);
});

test('the proxy names a missing action as PHP concatenates null: empty', async () => {
  const r: any = await new MCPProxyController().forward(ctx({}));
  assert.deepEqual(r.error, { code: -32600, message: 'Unknown action: ' });
});

test('filterValidateUrl follows PHP FILTER_VALIDATE_URL', () => {
  for (const ok of ['http://127.0.0.1:1/mcp', 'https://a.b/c?d=1', 'http://[::1]:8080/', 'http://u@h.test/', 'mailto:x']) assert.ok(filterValidateUrl(ok), ok);
  for (const no of ['not a url', 'example.com', 'http://ex_ample.com/p', 'http://', 'http://-a.com/', 'foo:bar']) assert.equal(filterValidateUrl(no), false, no);
});
