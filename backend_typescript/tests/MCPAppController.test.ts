import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCPAppController } from '../src/Controllers/MCPAppController';
import type { Ctx } from '../src/Support/Http';

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
