import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { MCPAppController } from '../src/Controllers/MCPAppController';
import type { Ctx } from '../src/Support/Http';

// The route only reaches enabled, registered servers (twin of MCPAppRegisteredServerTest.php).
beforeEach(() => {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, url TEXT, enabled INTEGER)');
  d.exec("INSERT INTO mcp_servers (url, enabled) VALUES ('https://x.example/', 1), ('http://127.0.0.1:1/off', 0)");
  installFakeDb((sqlText, params) => d.prepare(sqlText).all(...(params as any[])) as any[]);
});

function ctx(query: Record<string, unknown>): Ctx {
  return {
    method: 'GET',
    uri: '/api/v1/mcp/app',
    headers: {},
    query,
    body: {},
    user_id: null,
    auth_type: null,
    params: {},
    remote_addr: '127.0.0.1',
  };
}

test('missing server param → 400 text/plain (no network)', async () => {
  const r = await new MCPAppController().getResource(ctx({}));
  assert.equal(r.status_code, 400);
  assert.equal(r.raw_body, 'Missing server parameter');
  assert.match(r.headers['Content-Type'], /text\/plain/);
});

test('missing resource param → 400', async () => {
  const r = await new MCPAppController().getResource(ctx({ server: 'https://x.example/mcp' }));
  assert.equal(r.status_code, 400);
  assert.equal(r.raw_body, 'Missing resource parameter');
});

test('happy path: fetches resource HTML and injects init script', async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  // Fake MCP server: initialize → ok; resources/read → returns HTML (as an SSE data: line)
  globalThis.fetch = (async (_url: any, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push(body.method);
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 });
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 });
    }
    if (body.method === 'resources/read') {
      const html = '<html><head><title>t</title></head><body>hi</body></html>';
      // SSE-framed to also exercise the data: parser
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { contents: [{ text: html }] } })}\n\n`,
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  }) as any;

  try {
    const r = await new MCPAppController().getResource(
      ctx({ server: 'https://x.example', resource: 'ui://form', viewUUID: 'abc' }),
    );
    assert.equal(r.status_code, 200);
    assert.match(r.headers['Content-Type'], /text\/html/);
    // init script injected right before </head>
    assert.match(r.raw_body, /window\.MCP_INIT_DATA = /);
    assert.ok(r.raw_body.indexOf('MCP_INIT_DATA') < r.raw_body.indexOf('</head>'));
    assert.match(r.raw_body, /"viewUUID":"abc"/);
    assert.match(r.raw_body, /<body>hi<\/body>/);
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'resources/read']);
  } finally {
    globalThis.fetch = original;
  }
});

test('MCP init failure → 502', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 500 })) as any;
  try {
    const r = await new MCPAppController().getResource(ctx({ server: 'https://x.example', resource: 'ui://form' }));
    assert.equal(r.status_code, 502);
    assert.match(r.raw_body, /Failed to initialize MCP session/);
  } finally {
    globalThis.fetch = original;
  }
});

test('unregistered or disabled server → 404 Unknown MCP server, no request sent', async () => {
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return new Response('', { status: 500 }); }) as any;
  try {
    for (const server of ['http://169.254.169.254/latest', 'http://127.0.0.1:1/off']) {
      const r = await new MCPAppController().getResource(ctx({ server, resource: 'ui://x' }));
      assert.equal(r.status_code, 404, server);
      assert.equal(r.raw_body, 'Unknown MCP server');
      assert.match(r.headers['Content-Type'], /text\/plain/);
    }
    assert.equal(sent, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('array server/resource parameter → 400', async () => {
  const r = await new MCPAppController().getResource(ctx({ server: ['http://x'], resource: 'ui://x' }));
  assert.equal(r.status_code, 400);
  assert.equal(r.raw_body, 'Invalid server or resource parameter');
  const r2 = await new MCPAppController().getResource(ctx({ server: 'https://x.example', resource: { a: '1' } }));
  assert.equal(r2.status_code, 400);
});

test('every answer carries the CSP sandbox header', async () => {
  const r = await new MCPAppController().getResource(ctx({}));
  assert.equal(r.headers['Content-Security-Policy'], 'sandbox allow-scripts allow-forms allow-downloads allow-modals');
});

test('injected values are JSON with PHP HEX flags', () => {
  assert.equal(MCPAppController.jsonHex(`</script>'"&/é`), '"\\u003C\\/script\\u003E\\u0027\\u0022\\u0026\\/\\u00e9"');
  assert.equal(MCPAppController.jsonHex({ a: 'x\\', b: 1 }), '{"a":"x\\\\","b":1}');
});
