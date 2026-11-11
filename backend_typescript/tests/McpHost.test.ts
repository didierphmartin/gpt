import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { McpHostController } from '../src/Controllers/McpHostController';
import { McpHostClient } from '../src/Services/McpHostClient';
import { McpEndpoint } from '../src/Services/McpEndpoint';
import { AdminController } from '../src/Controllers/AdminController';

// Port of backend/tests/Unit/McpHostControllerTest.php, McpHostClientTimeoutTest.php,
// McpEndpointInternalTest.php and Controllers/AdminMcpInternalUrlTest.php.

const ROLES: Record<number, string> = { 1: 'admin', 3: 'user', 4: 'user' };
type Call = { method: string; url: string; headers: string[]; body: string | null };
let calls: Call[] = [];
let reply: [number, string] = [200, ''];
const ENV_KEYS = ['MCPS_URL', 'MCPS_TOKEN', 'MCPS_PUBLIC_GATEWAY', 'MCPS_GATEWAY'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  installFakeDb((sqlText, params) => {
    if (sqlText === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
      const role = ROLES[Number(params[0])];
      return role ? [{ role }] : [];
    }
    return [];
  });
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MCPS_URL = 'http://mcps:8790';
  process.env.MCPS_TOKEN = 'tok';
  process.env.MCPS_PUBLIC_GATEWAY = 'http://localhost:8791';
  delete process.env.MCPS_GATEWAY;
  calls = [];
  reply = [200, JSON.stringify([
    { folder: 'a', installed_by: 3, log: 'x' },
    { folder: 'b', installed_by: 4, log: 'y' },
  ])];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function ctl(cfg: Record<string, any> = {}) {
  const transport = async (method: string, url: string, headers: string[], body: string | null): Promise<[number, string]> => {
    calls.push({ method, url, headers, body });
    return reply;
  };
  return new McpHostController(cfg, () => new McpHostClient('http://mcps:8790', 'tok', transport));
}

function req(uid: number, body: Record<string, any> = {}, folder?: string): any {
  return { method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: uid, auth_type: 'jwt', params: folder === undefined ? {} : { folder }, remote_addr: '' };
}

test('host unavailable without MCPS_URL', async () => {
  process.env.MCPS_URL = '';
  assert.deepEqual((await ctl().info(req(3))).data, { available: false });
  const r = await ctl().install(req(3, { files: [] }, 'a'));
  assert.equal(r.status_code, 404);
  assert.equal(r.data.error, 'no server host');
  assert.deepEqual(calls, []);
});

test('info carries the public gateway', async () => {
  assert.deepEqual((await ctl().info(req(3))).data, { available: true, gateway: 'http://localhost:8791' });
});

test('install sends the caller as owner', async () => {
  reply = [200, '{"ok":true}'];
  const r = await ctl().install(req(3, { files: [], installed_by: 999 }, 'new'));
  assert.equal(r.status_code, 200);
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].url.endsWith('/servers/new/install'));
  assert.equal(JSON.parse(calls[0].body!).installed_by, 3);
});

test('corporate install is admin-only', async () => {
  reply = [200, '{"ok":true}'];
  const corp = ctl({ edition: 'corporate' });
  const r = await corp.install(req(3, { files: [] }, 'new'));
  assert.equal(r.status_code, 403);
  assert.equal(r.data.error, 'Only an admin can install MCP servers here.');
  assert.deepEqual(calls, []);
  assert.equal((await corp.install(req(1, { files: [] }, 'new'))).status_code, 200);
  assert.equal((await ctl({ edition: 'individual' }).install(req(3, { files: [] }, 'new'))).status_code, 200);
});

test('others cannot touch a server or see its log', async () => {
  const c = ctl();
  const r = await c.restart(req(4, {}, 'a'));
  assert.equal(r.status_code, 403);
  assert.equal(calls.length, 1); // only the list lookup
  const list = (await c.list(req(4))).data;
  assert.ok(!('log' in list[0]));
  assert.ok('log' in list[1]);
  assert.ok('log' in (await c.list(req(1))).data[0]);
  assert.equal((await c.restart(req(1, {}, 'a'))).status_code, 200);
  assert.equal((await c.restart(req(1, {}, 'zzz'))).status_code, 404);
});

test('supervisor down is a 503 with text', async () => {
  reply = [0, ''];
  const r = await ctl().list(req(3));
  assert.equal(r.status_code, 503);
  assert.equal(r.data.error, 'The server host is not reachable');
});

test('status passes through', async () => {
  reply = [409, '{"error":"disabled"}'];
  const r = await ctl().restart(req(1, {}, 'a'));
  assert.equal(r.status_code, 409);
  assert.equal(r.data.error, 'disabled');
  assert.equal(r.error, 'disabled');
});

test('raw folder segment is used as is', async () => {
  reply = [200, '{"ok":true}'];
  await ctl().install(req(3, {}, '007'));
  assert.ok(calls[0].url.endsWith('/servers/007/install'));
});

test('bad folder is 400', async () => {
  assert.equal((await ctl().install(req(3, {}, '.hidden'))).status_code, 400);
});

test('token is sent and never returned', async () => {
  const r = await ctl().list(req(1));
  assert.ok(calls[0].headers.includes('Authorization: Bearer tok'));
  assert.ok(!JSON.stringify(r).includes('tok'));
});

test('timeout per route', () => {
  const base = 'http://mcps:9000/servers';
  assert.equal(McpHostClient.timeoutFor('POST', `${base}/a/install`), 900);
  assert.equal(McpHostClient.timeoutFor('POST', `${base}/a/restart`), 30);
  assert.equal(McpHostClient.timeoutFor('POST', `${base}/a/enabled`), 30);
  assert.equal(McpHostClient.timeoutFor('DELETE', `${base}/a`), 30);
  assert.equal(McpHostClient.timeoutFor('PUT', `${base}/a/settings`), 30);
  assert.equal(McpHostClient.timeoutFor('GET', `${base}/a/settings`), 15);
  assert.equal(McpHostClient.timeoutFor('GET', `${base}/a/source`), 15);
  assert.equal(McpHostClient.timeoutFor('GET', base), 15);
});

test('internal rewrites only the gateway when set (candidates too)', () => {
  process.env.MCPS_GATEWAY = 'http://mcps:8790';
  process.env.MCPS_PUBLIC_GATEWAY = 'http://localhost:8790';
  assert.equal(McpEndpoint.internal('http://localhost:8790/outlook_mcp/mcp'), 'http://mcps:8790/outlook_mcp/mcp');
  assert.equal(McpEndpoint.internal('http://127.0.0.1:8790/outlook_mcp/mcp'), 'http://mcps:8790/outlook_mcp/mcp');
  assert.equal(McpEndpoint.internal('http://localhost:8770/mcp'), 'http://localhost:8770/mcp');
  assert.equal(McpEndpoint.internal('http://localhost:87901/x'), 'http://localhost:87901/x');
  assert.deepEqual(McpEndpoint.candidates('http://localhost:8790/outlook_mcp/mcp'), ['http://mcps:8790/outlook_mcp/mcp']);
});

test('internal leaves the URL unchanged when unset', () => {
  delete process.env.MCPS_GATEWAY;
  delete process.env.MCPS_PUBLIC_GATEWAY;
  assert.equal(McpEndpoint.internal('http://localhost:8790/a/mcp'), 'http://localhost:8790/a/mcp');
});

test('admin tool fetch (mcpHttpCall) uses the internal gateway', async () => {
  process.env.MCPS_GATEWAY = 'http://mcps-internal.invalid:8790';
  process.env.MCPS_PUBLIC_GATEWAY = 'http://localhost:8790';
  const realFetch = globalThis.fetch;
  let seen = '';
  globalThis.fetch = (async (url: any) => {
    seen = String(url);
    throw new Error('getaddrinfo ENOTFOUND mcps-internal.invalid');
  }) as any;
  try {
    const out = await (new AdminController({}) as any).mcpHttpCall('http://localhost:8790/outlook_mcp/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, [], { id: null });
    assert.equal(out.ok, false);
    assert.ok(seen.includes('mcps-internal.invalid'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('schema relays the settings list to its owner only', async () => {
  await ctl().putSchema(req(3, { env: [{ name: 'X', required: true }] }, 'a'));
  const put = calls[calls.length - 1];
  assert.equal(put.method, 'PUT');
  assert.ok(put.url.endsWith('/servers/a/schema'));
  assert.deepEqual(JSON.parse(put.body!), { env: [{ name: 'X', required: true }] });
  assert.equal((await ctl().putSchema(req(4, { env: [] }, 'a'))).status_code, 403);
});
