import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpEndpoint } from '../src/Services/McpEndpoint';
import { McpTestRelay, HttpReply } from '../src/Services/McpTestRelay';

// Port of backend/tests/Unit/McpTestRelayTest.php and Controllers/McpTestControllerTest.php.

for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
  process.env[k] ??= 'test';
}

type Call = { url: string; lines: string[]; body: string; timeout: number };

function recorder(reply: Partial<HttpReply> = {}) {
  const calls: Call[] = [];
  const http = async (url: string, lines: string[], body: string, timeout: number): Promise<HttpReply> => {
    calls.push({ url, lines, body, timeout });
    return { status: 200, headers: {}, body: '{}', error: null, ...reply };
  };
  return { calls, relay: new McpTestRelay(http) };
}

// ─── relay ───────────────────────────────────────────────────────────────────

test('sends the message unchanged, {} kept', async () => {
  const { calls, relay } = recorder();
  const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } };
  await relay.relay('http://h/mcp', {}, msg, null, '2025-11-25');
  assert.equal(calls[0].body, JSON.stringify(msg));
  assert.ok(calls[0].body.includes('"capabilities":{}'));
  assert.equal(calls[0].timeout, 20);
});

test('protocol and session headers', async () => {
  const { calls, relay } = recorder();
  await relay.relay('http://h/mcp', { 'X-A': 'b' }, { a: 1 }, 'abc', '2025-11-25');
  assert.ok(calls[0].lines.includes('mcp-protocol-version: 2025-11-25'));
  assert.ok(calls[0].lines.includes('mcp-session-id: abc'));
  assert.ok(calls[0].lines.includes('X-A: b'));
  for (const sid of [null, '']) {
    await relay.relay('http://h/mcp', {}, { a: 1 }, sid, '2025-11-25');
    assert.ok(!calls.at(-1)!.lines.join('\n').includes('mcp-session-id'));
  }
  await relay.relay('http://h/mcp', {}, { a: 1 }, null, '');
  assert.ok(!calls.at(-1)!.lines.join('\n').includes('mcp-protocol-version'));
});

test('CR/LF stripped from session id and version', async () => {
  const { calls, relay } = recorder();
  await relay.relay('http://h/mcp', {}, { a: 1 }, 'abc\r\nX-Evil: 1', '2025-11-25\r\nX-Bad: 2');
  assert.ok(calls[0].lines.includes('mcp-session-id: abcX-Evil: 1'));
  assert.ok(calls[0].lines.includes('mcp-protocol-version: 2025-11-25X-Bad: 2'));
  for (const line of calls[0].lines) assert.doesNotMatch(line, /[\r\n]/);
});

test('parses SSE events, JSON and batches; keeps {}', () => {
  const sse = 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
  const m = McpTestRelay.parseMessages('text/event-stream; charset=utf-8', sse);
  assert.equal(m.length, 2);
  assert.equal(m[1].id, 1);
  const j = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},"serverInfo":{"name":"s"}}}';
  assert.equal(JSON.stringify(McpTestRelay.parseMessages('application/json', j)), '[' + j + ']');
  const batch = '[' + j + ',{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}]';
  assert.equal(JSON.stringify(McpTestRelay.parseMessages('application/json', batch)), batch);
  assert.deepEqual(McpTestRelay.parseMessages('text/html', '<html>no</html>'), []);
});

test('exposes only three headers', () => {
  const out = McpTestRelay.exposedHeaders({
    'Content-Type': 'a', 'mcp-session-id': 'b', 'mcp-protocol-version': 'c',
    'set-cookie': 'x', authorization: 'y', 'x-api-key': 'z',
  });
  assert.deepEqual(Object.keys(out), ['content-type', 'mcp-session-id', 'mcp-protocol-version']);
});

test('transport error is returned, not thrown', async () => {
  const { relay } = recorder({ status: 0, body: '', error: 'Could not resolve host' });
  const r = await relay.relay('http://h/mcp', {}, { a: 1 }, null, '2025-11-25');
  assert.equal(r.error, 'Could not resolve host');
  assert.deepEqual(r.messages, []);
  assert.equal(r.status, 0);
  const boom = new McpTestRelay(async () => { throw new Error('kaput'); });
  assert.equal((await boom.relay('http://h/mcp', {}, { a: 1 }, null, '')).error, 'kaput');
});

test('send() does not follow redirects', async () => {
  const realFetch = globalThis.fetch;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_u: any, i?: RequestInit) => {
    init = i;
    return new Response('', { status: 301, headers: { location: 'http://elsewhere/' } });
  }) as typeof fetch;
  try {
    const r = await McpTestRelay.send('http://h/mcp', ['mcp-session-id: s1'], '{}', 20);
    assert.equal(r.status, 301);
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>)['mcp-session-id'], 's1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── McpEndpoint additions ───────────────────────────────────────────────────

test('decodeStoredHeaders', () => {
  assert.deepEqual(McpEndpoint.decodeStoredHeaders(null), {});
  assert.deepEqual(McpEndpoint.decodeStoredHeaders('not json'), {});
  assert.deepEqual(McpEndpoint.decodeStoredHeaders('["a"]'), {});
  assert.deepEqual(McpEndpoint.decodeStoredHeaders('{"X:K\\r\\n":"v\\r\\n1","n":2,"o":{"x":1},"t":true}'), { XK: 'v1', n: '2', t: '1' });
});

test('internal() maps the public gateway', () => {
  const saved = [process.env.MCPS_GATEWAY, process.env.MCPS_PUBLIC_GATEWAY];
  try {
    delete process.env.MCPS_GATEWAY;
    assert.equal(McpEndpoint.internal('http://localhost:8790/a/mcp'), 'http://localhost:8790/a/mcp');
    process.env.MCPS_GATEWAY = 'http://mcps:8790';
    process.env.MCPS_PUBLIC_GATEWAY = 'http://localhost:8790/';
    assert.equal(McpEndpoint.internal('http://localhost:8790/a/mcp'), 'http://mcps:8790/a/mcp');
    assert.equal(McpEndpoint.internal('http://127.0.0.1:8790/a/mcp'), 'http://mcps:8790/a/mcp');
    assert.equal(McpEndpoint.internal('https://x.test/mcp'), 'https://x.test/mcp');
  } finally {
    if (saved[0] === undefined) delete process.env.MCPS_GATEWAY; else process.env.MCPS_GATEWAY = saved[0];
    if (saved[1] === undefined) delete process.env.MCPS_PUBLIC_GATEWAY; else process.env.MCPS_PUBLIC_GATEWAY = saved[1];
  }
});

// ─── controller ──────────────────────────────────────────────────────────────

const SERVERS: Record<number, { user_id: string | null; url: string; headers: string; transport: string }> = {
  1: { user_id: null, url: 'https://stored.test/mcp', headers: '{"X-Key":"s3cret"}', transport: 'http' },
  2: { user_id: 'u2', url: 'https://other.test/mcp', headers: '{"X-Key":"s3cret"}', transport: 'http' },
};
const ROLES: Record<string, string> = { u1: 'user', adm: 'admin' };

async function ctl() {
  const { McpTestController } = await import('../src/Controllers/McpTestController');
  const rec = recorder();
  const find = async (id: number, userId: string | null) => {
    const row = SERVERS[id];
    if (!row || (userId !== null && row.user_id !== null && row.user_id !== userId)) return null;
    return row;
  };
  const checkAdmin = async (c: any) =>
    !c.user_id ? { success: false, error: 'Authentication required', status_code: 401 }
      : ROLES[c.user_id] === 'admin' ? null : { success: false, error: 'Admin access required', status_code: 403 };
  return { c: new McpTestController(rec.relay, find, checkAdmin), calls: rec.calls, McpTestController };
}

function req(body: Record<string, any>, user: string | null = 'u1'): any {
  return { user_id: user, body: { message: { jsonrpc: '2.0', id: 1, method: 'ping' }, protocol_version: '2025-11-25', ...body } };
}

test('by server_id: stored URL and headers only', async () => {
  const { c, calls } = await ctl();
  const res = await c.test(req({ server_id: 1, server_url: 'https://evil.test', headers: { 'X-Key': 'evil' } }));
  assert.equal(res.success, true);
  assert.equal(calls[0].url, 'https://stored.test/mcp');
  assert.ok(calls[0].lines.includes('X-Key: s3cret'));
  assert.ok(!calls[0].lines.includes('X-Key: evil'));
  assert.ok(!JSON.stringify(res).includes('s3cret'));
});

test("another user's server is 404", async () => {
  const { c, calls } = await ctl();
  const res = await c.test(req({ server_id: 2 }));
  assert.equal(res.status_code, 404);
  assert.equal(calls.length, 0);
});

test('unsaved server by URL and headers', async () => {
  const { c, calls } = await ctl();
  const res = await c.test(req({ server_url: 'https://new.test/mcp', headers: { 'X-A': 'b' } }));
  assert.equal(res.success, true);
  assert.equal(calls[0].url, 'https://new.test/mcp');
  assert.ok(calls[0].lines.includes('X-A: b'));
});

test('sibling and sse', async () => {
  const { c, McpTestController } = await ctl();
  assert.equal(McpTestController.endpointFor('https://x.test', 'http', true), 'https://x.test/mcp');
  assert.equal(McpTestController.endpointFor('https://x.test/mcp', 'http', true), null);
  assert.equal(McpTestController.endpointFor('https://x.test/sse', 'sse', false), 'https://x.test/mcp');
  assert.equal((await c.test(req({ server_url: 'https://x.test/mcp', sibling: true }))).status_code, 400);
});

test('admin tests any row and requires admin', async () => {
  const { c, calls } = await ctl();
  assert.equal((await c.adminTest(req({ server_id: 2 }, 'u1'))).status_code, 403);
  assert.equal(calls.length, 0);
  assert.equal((await c.adminTest(req({ server_url: 'https://x.test/mcp' }, 'adm'))).status_code, 400);
  const res = await c.adminTest(req({ server_id: 2 }, 'adm'));
  assert.equal(res.success, true);
  assert.ok(calls[0].lines.includes('X-Key: s3cret'));
});

test('missing message 400, no user 401, protocol version optional', async () => {
  const { c, calls } = await ctl();
  const r = req({ server_url: 'https://x.test/mcp' });
  delete r.body.message;
  assert.equal((await c.test(r)).status_code, 400);
  assert.equal((await c.test(req({ server_id: 1 }, null))).status_code, 401);
  for (const v of [undefined, '']) {
    const q = req({ server_url: 'https://x.test/mcp' });
    if (v === undefined) delete q.body.protocol_version; else q.body.protocol_version = v;
    assert.equal((await c.test(q)).success, true);
    assert.ok(!calls.at(-1)!.lines.join('\n').includes('mcp-protocol-version'));
  }
});
