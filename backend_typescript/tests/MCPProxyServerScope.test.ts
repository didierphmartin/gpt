import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { MCPProxyController } from '../src/Controllers/MCPProxyController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/MCPProxyServerScopeTest.php: with a server_id, the proxy
 * uses only a server the caller may use, at its stored URL. Plus the tool-cache scope: own server,
 * or a global one by an admin.
 */

let d: DatabaseSync;
let fetched: { url: string; headers: Record<string, string> }[];
const original = globalThis.fetch;

beforeEach(() => {
  d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
  d.exec("INSERT INTO users VALUES (1, 'user'), (9, 'admin')");
  d.exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER)');
  d.exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, tool_description TEXT, input_schema TEXT, has_ui INTEGER, ui_resource_uri TEXT)');
  d.exec(`INSERT INTO mcp_servers VALUES (1, '2', 'http://127.0.0.1:1/bob', '{"Authorization":"Bearer bob"}', 'http', 1)`);
  d.exec(`INSERT INTO mcp_servers VALUES (2, NULL, 'http://127.0.0.1:1/off', '{"Authorization":"Bearer g"}', 'http', 0)`);
  d.exec(`INSERT INTO mcp_servers VALUES (3, '1', 'http://own.test/mcp', '{"Authorization":"Bearer mine"}', 'http', 1)`);
  d.exec(`INSERT INTO mcp_servers VALUES (4, NULL, 'http://global.test/mcp', '{"Authorization":"Bearer g"}', 'http', 1)`);
  installFakeDb((sqlText, params) => {
    const st = d.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) return st.all(...ps) as any[];
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid), numAffectedRows: Number(r.changes) };
  });
  fetched = [];
  globalThis.fetch = (async (url: any, opts: any) => {
    fetched.push({ url: String(url), headers: opts.headers });
    const body = JSON.parse(opts.body);
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    const result = body.method === 'tools/list' ? { tools: [{ name: 't1' }] } : { serverInfo: { name: 's' } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  }) as any;
});

function ctx(userId: number, body: Record<string, any>): Ctx {
  return { method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: 'jwt', params: {}, remote_addr: '127.0.0.1' } as any;
}

test('another user\'s or a disabled server is refused, nothing is sent', async () => {
  try {
    for (const id of [1, 2]) {
      for (const action of ['proxy', 'discover_tools']) {
        const r: any = await new MCPProxyController().forward(ctx(1, {
          action, server_id: id, server_url: 'http://attacker.example/collect', jsonrpc: { method: 'tools/list' },
        }));
        assert.equal(r.status_code, 404, `${action} ${id}`);
        assert.equal(r.error.message, 'Unknown MCP server');
      }
    }
    assert.equal(fetched.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a usable server is reached at its stored URL, not the named one', async () => {
  try {
    const r: any = await new MCPProxyController().forward(ctx(1, {
      action: 'proxy', server_id: 3, server_url: 'http://attacker.example/collect', jsonrpc: { method: 'ping' },
    }));
    assert.equal(r.success, true);
    assert.ok(fetched.length > 0);
    assert.ok(fetched.every((f) => f.url.startsWith('http://own.test/')));
  } finally {
    globalThis.fetch = original;
  }
});

const cached = (serverId: number) => d.prepare('SELECT tool_name FROM mcp_server_tools WHERE server_id = ?').all(serverId);

test('discovered tools are cached for the own server, and for a global one only by an admin', async () => {
  try {
    const c = new MCPProxyController();
    let r: any = await c.forward(ctx(1, { action: 'discover_tools', server_id: 3, server_url: 'x' }));
    assert.equal(r.success, true);
    assert.equal(cached(3).length, 1);

    r = await c.forward(ctx(1, { action: 'discover_tools', server_id: 4, server_url: 'x' }));
    assert.equal(r.success, true);
    assert.deepEqual(r.tools, [{ name: 't1' }]);
    assert.equal(cached(4).length, 0);

    r = await c.forward(ctx(9, { action: 'discover_tools', server_id: 4, server_url: 'x' }));
    assert.equal(r.success, true);
    assert.equal(cached(4).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
