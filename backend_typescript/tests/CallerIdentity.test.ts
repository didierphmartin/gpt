import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { MCPServerController } from '../src/Controllers/MCPServerController';
import { MCPProxyController } from '../src/Controllers/MCPProxyController';
import { HumeToolController } from '../src/Controllers/HumeToolController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/CallerIdentityTest.php: a signed-in user who puts another user's id in the
 * body or query string is still treated as themselves — the authenticated ctx.user_id wins.
 */

const ME = 3;
const VICTIM = '9';
let d: DatabaseSync;

beforeEach(() => {
  d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT, description TEXT,
    headers TEXT, transport TEXT DEFAULT 'http', enabled INTEGER DEFAULT 1, is_mock INTEGER NOT NULL DEFAULT 0)`);
  d.exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, input_schema TEXT, has_ui INTEGER DEFAULT 0)');
  d.exec('CREATE TABLE user_mcp_overrides (user_id INTEGER, server_id INTEGER, allowed INTEGER)');
  d.exec(`INSERT INTO mcp_servers (id, user_id, name, url) VALUES (1, '${VICTIM}', 'victim-private', 'https://victim.test/mcp')`);
  d.exec(`INSERT INTO mcp_server_tools (id, server_id, tool_name, input_schema) VALUES (1, 1, 'secret_tool', '{}')`);
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

const row = (id: number): any => d.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);

test('MCP create owns the server as the caller', async () => {
  const r: any = await new MCPServerController().create(ctx({ user_id: VICTIM, name: 'Mine', url: 'https://me.test/mcp' }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(String(row(Number(r.server_id)).user_id), String(ME));
});

test('MCP update cannot reach another user\'s server', async () => {
  const r: any = await new MCPServerController().update(
    ctx({ user_id: VICTIM, server_id: 1, name: 'hijacked', url: 'https://evil.test/mcp' }));
  assert.equal(r.status_code, 404);
  assert.equal(row(1).name, 'victim-private');
});

test('MCP toggle cannot reach another user\'s server', async () => {
  await new MCPServerController().toggle(ctx({ user_id: VICTIM, server_id: 1, enabled: false }));
  assert.equal(Number(row(1).enabled), 1);
});

test('MCP delete cannot reach another user\'s server', async () => {
  const r: any = await new MCPServerController().delete(ctx({}, { user_id: VICTIM, server_id: 1 }));
  assert.equal(r.status_code, 404);
  assert.ok(row(1));
});

test('MCP list ignores a query user_id', async () => {
  const r: any = await new MCPServerController().list(ctx({}, { user_id: VICTIM }));
  assert.deepEqual(r.servers.map((s: any) => s.name), []);
});

test('MCP getTools ignores a query user_id', async () => {
  const r: any = await new MCPServerController().getTools(ctx({}, { user_id: VICTIM, server_id: 1 }));
  assert.equal(r.status_code, 404);
});

test('MCP getAllTools ignores a query user_id', async () => {
  const r: any = await new MCPServerController().getAllTools(ctx({}, { user_id: VICTIM }));
  assert.deepEqual(r.tools, []);
});

test('MCP proxy cannot resolve another user\'s server', async () => {
  // No jsonrpc: a resolved server answers "JSON-RPC request required", an unresolved one "Server URL required".
  const r: any = await new MCPProxyController().forward(ctx({ action: 'proxy', server_id: 1, user_id: VICTIM }));
  assert.equal(r.error.message, 'Server URL required');
});

test('Hume tool runs as the caller', async () => {
  const hume = new HumeToolController();
  const seen: unknown[] = [];
  (hume as any).toolsManager = {
    hasFunction: () => true,
    execute: async (_name: string, _params: unknown, userId: unknown) => {
      seen.push(userId);
      return { success: true };
    },
  };
  await hume.execute(ctx({ toolCallId: 't1', toolName: 'get_watchlist', userId: VICTIM }));
  assert.deepEqual(seen, [ME]);
});
