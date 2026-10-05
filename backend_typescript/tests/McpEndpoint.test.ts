import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpEndpoint } from '../src/Services/McpEndpoint';
import { MCPAppController } from '../src/Controllers/MCPAppController';

// The proxy and the tools loader import the DB pools, which read required env
// vars at load time (no connection is made); dummy values keep this test offline.
async function load() {
  for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
    process.env[k] ??= 'test';
  }
  const { MCPProxyController } = await import('../src/Controllers/MCPProxyController');
  const { MCPToolsLoader } = await import('../src/Services/MCPToolsLoader');
  return { MCPProxyController, MCPToolsLoader };
}

// One rule for every MCP client: the registered URL is tried as given first;
// only if that fails is "/mcp" tried, inserted into the path before any query.

test('registered URL first, then /mcp appended', () => {
  assert.deepEqual(McpEndpoint.candidates('https://x.test', 'http'), ['https://x.test', 'https://x.test/mcp']);
});

test('trailing slash is kept on the as-given URL', () => {
  assert.deepEqual(McpEndpoint.candidates('http://h/srv/', 'http'), ['http://h/srv/', 'http://h/srv/mcp']);
});

test('/mcp goes into the path before the query', () => {
  assert.deepEqual(McpEndpoint.candidates('http://localhost/servicenow/?profile=mock&toolset=jobs', 'http'), [
    'http://localhost/servicenow/?profile=mock&toolset=jobs',
    'http://localhost/servicenow/mcp?profile=mock&toolset=jobs',
  ]);
  assert.deepEqual(McpEndpoint.candidates('http://h/x?a=1#f', 'http'), ['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f']);
});

test('/mcp and .php endpoints have no fallback', () => {
  assert.deepEqual(McpEndpoint.candidates('https://x.test/mcp', 'http'), ['https://x.test/mcp']);
  assert.deepEqual(McpEndpoint.candidates('https://x.test/mcp/', 'http'), ['https://x.test/mcp/']);
  assert.deepEqual(McpEndpoint.candidates('http://localhost/AI_mcp/mcp-server.php', 'http'), ['http://localhost/AI_mcp/mcp-server.php']);
  assert.deepEqual(McpEndpoint.candidates('http://h/s.php?k=1', 'http'), ['http://h/s.php?k=1']);
});

test('sse transport rewrites a /sse suffix to /mcp', () => {
  assert.deepEqual(McpEndpoint.candidates('https://x.test/sse', 'sse'), ['https://x.test/mcp']);
  assert.deepEqual(McpEndpoint.candidates('https://x.test/sse/', 'sse'), ['https://x.test/mcp']);
  assert.deepEqual(McpEndpoint.candidates('https://x.test/sse?k=1', 'sse'), ['https://x.test/mcp?k=1']);
});

test('http transport does not rewrite /sse', () => {
  assert.deepEqual(McpEndpoint.candidates('https://x.test/sse', 'http'), ['https://x.test/sse', 'https://x.test/sse/mcp']);
});

test('isJsonRpcReply: a result or an error, jsonrpc not required', () => {
  assert.equal(McpEndpoint.isJsonRpcReply({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.equal(McpEndpoint.isJsonRpcReply({ jsonrpc: '2.0', id: 1, error: { code: -1 } }), true);
  assert.equal(McpEndpoint.isJsonRpcReply(null), false);
  assert.equal(McpEndpoint.isJsonRpcReply({ result: { tools: [] } }), true);
  assert.equal(McpEndpoint.isJsonRpcReply({ status: 'ok' }), false);
  assert.equal(McpEndpoint.isJsonRpcReply([1, 2]), false);
});

/** Fake fetch: `answers` maps URL -> [status, body]; unknown URLs refuse the connection. Records the URLs hit. */
function fakeFetch(answers: Record<string, [number, string]>, hits: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, _opts: any) => {
    hits.push(String(url));
    const a = answers[String(url)];
    if (!a) throw new Error('connection refused');
    return new Response(a[1], { status: a[0] });
  }) as any;
  return () => {
    globalThis.fetch = original;
  };
}

const rpc = (o: object) => JSON.stringify({ jsonrpc: '2.0', id: 1, ...o });
const ctx = (body: any): any => ({ method: 'POST', uri: '', headers: {}, query: {}, body, user_id: 'u', auth_type: null, params: {}, remote_addr: '' });

test('proxy test_connection: a query-addressed server registers as given', async () => {
  const url = 'http://h/servicenow/?profile=mock';
  const hits: string[] = [];
  const restore = fakeFetch({ [url]: [200, rpc({ result: { serverInfo: { name: 'servicenow' } } })] }, hits);
  try {
    const { MCPProxyController } = await load();
    const r: any = await new MCPProxyController().forward(ctx({ action: 'test_connection', server_url: url }));
    assert.equal(r.success, true);
    assert.equal(r.serverInfo.name, 'servicenow');
    assert.deepEqual(hits, [url]);
  } finally {
    restore();
  }
});

test('proxy test_connection: falls back to /mcp when the URL as given fails', async () => {
  const hits: string[] = [];
  const restore = fakeFetch(
    { 'http://h/srv': [404, 'nope'], 'http://h/srv/mcp': [200, rpc({ result: { serverInfo: { name: 's' } } })] },
    hits,
  );
  try {
    const { MCPProxyController } = await load();
    const r: any = await new MCPProxyController().forward(ctx({ action: 'test_connection', server_url: 'http://h/srv' }));
    assert.equal(r.success, true);
    assert.deepEqual(hits, ['http://h/srv', 'http://h/srv/mcp']);
  } finally {
    restore();
  }
});

test('proxy: a JSON-RPC error with HTTP >= 400 is the endpoint, no further candidate', async () => {
  const hits: string[] = [];
  const restore = fakeFetch(
    { 'http://h/srv': [401, rpc({ error: { code: -32001, message: 'bad token' } })], 'http://h/srv/mcp': [200, rpc({ result: {} })] },
    hits,
  );
  try {
    const { MCPProxyController } = await load();
    const r: any = await new MCPProxyController().forward(ctx({ action: 'discover_tools', server_url: 'http://h/srv' }));
    assert.equal(r.success, false);
    assert.deepEqual(hits, ['http://h/srv']);
  } finally {
    restore();
  }
});

test('proxy: the answering endpoint is remembered for the rest of the exchange', async () => {
  const hits: string[] = [];
  const restore = fakeFetch(
    {
      'http://h/srv': [200, '<html>not rpc</html>'],
      'http://h/srv/mcp': [200, rpc({ result: { tools: [] } })],
    },
    hits,
  );
  try {
    const { MCPProxyController } = await load();
    const r: any = await new MCPProxyController().forward(ctx({ action: 'discover_tools', server_url: 'http://h/srv' }));
    assert.equal(r.success, true);
    // initialize probes both; initialized + tools/list go straight to /mcp.
    assert.deepEqual(hits, ['http://h/srv', 'http://h/srv/mcp', 'http://h/srv/mcp', 'http://h/srv/mcp']);
  } finally {
    restore();
  }
});

test('proxy test_connection: all candidates failing lists every URL tried', async () => {
  const hits: string[] = [];
  const restore = fakeFetch({}, hits);
  try {
    const { MCPProxyController } = await load();
    const r: any = await new MCPProxyController().forward(ctx({ action: 'test_connection', server_url: 'http://h/a/b' }));
    assert.equal(r.success, false);
    assert.equal(r.url_tried, 'http://h/a/b, http://h/a/b/mcp');
    assert.match(r.error, /http:\/\/h\/a\/b\/mcp/);
  } finally {
    restore();
  }
});

test('tools loader: stored URL as given, then /mcp', async () => {
  const hits: string[] = [];
  const restore = fakeFetch(
    { 'http://h/srv': [301, ''], 'http://h/srv/mcp': [200, rpc({ result: { content: [{ type: 'text', text: 'hi' }] } })] },
    hits,
  );
  try {
    const { MCPToolsLoader } = await load();
    const r = await (new MCPToolsLoader() as any).callMCPServer('http://h/srv', 'poll', {}, {});
    assert.equal(r.formatted.result, 'hi');
    assert.deepEqual(hits, ['http://h/srv', 'http://h/srv/mcp']);
  } finally {
    restore();
  }
});

test('tools loader: a query-addressed URL is used as given', async () => {
  const url = 'http://h/servicenow/?profile=mock';
  const hits: string[] = [];
  const restore = fakeFetch({ [url]: [200, rpc({ result: { content: [{ type: 'text', text: 'ok' }] } })] }, hits);
  try {
    const { MCPToolsLoader } = await load();
    const r = await (new MCPToolsLoader() as any).callMCPServer(url, 'poll', {}, {});
    assert.equal(r.formatted.result, 'ok');
    assert.deepEqual(hits, [url]);
  } finally {
    restore();
  }
});

test('app proxy: a query-addressed server is reached as given', async () => {
  const url = 'http://h/servicenow/?profile=mock';
  const hits: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: any, opts: any) => {
    hits.push(String(u));
    if (String(u) !== url) throw new Error('connection refused');
    const m = JSON.parse(opts.body).method;
    return new Response(rpc(m === 'resources/read' ? { error: { message: 'no such resource' } } : { result: {} }), { status: 200 });
  }) as any;
  try {
    const r = await new MCPAppController().getResource({ ...ctx({}), method: 'GET', query: { server: url, resource: 'ui://none' } });
    assert.match(r.raw_body, /^Failed to fetch MCP resource/);
    assert.ok(hits.every((h) => h === url), hits.join());
  } finally {
    globalThis.fetch = original;
  }
});

test('app proxy: falls back to /mcp when the URL as given is not JSON-RPC', async () => {
  const hits: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: any, opts: any) => {
    hits.push(String(u));
    if (String(u) === 'http://h/srv') return new Response('<html>', { status: 200 });
    const m = JSON.parse(opts.body).method;
    return new Response(rpc(m === 'resources/read' ? { result: { contents: [{ text: '<p>x</p>' }] } } : { result: {} }), { status: 200 });
  }) as any;
  try {
    const r = await new MCPAppController().getResource({ ...ctx({}), method: 'GET', query: { server: 'http://h/srv', resource: 'ui://x' } });
    assert.equal(r.status_code, 200);
    assert.equal(hits[0], 'http://h/srv');
    assert.ok(hits.slice(1).every((h) => h === 'http://h/srv/mcp'), hits.join());
  } finally {
    globalThis.fetch = original;
  }
});

test('emitted MCP client (LangGraph/ADK/MAF) uses the same candidates rule', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const { mcpClientBlock } = require('../src/AgentTeam/pythonEmitHelpers') as typeof import('../src/AgentTeam/pythonEmitHelpers');
  const src =
    "import json, sys, time, types\ntry:\n    import httpx\nexcept ImportError:\n    httpx = types.ModuleType('httpx')\n" +
    mcpClientBlock() +
    '\nprint(json.dumps([_mcp_candidates("https://x.test"), _mcp_candidates("http://h/srv/"),' +
    ' _mcp_candidates("http://localhost/servicenow/?profile=mock&toolset=jobs"), _mcp_candidates("http://h/x?a=1#f"),' +
    ' _mcp_candidates("https://x.test/mcp/"), _mcp_candidates("http://h/s.php?k=1")]))';
  const out = execFileSync('python3', ['-c', src], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [
    ['https://x.test', 'https://x.test/mcp'],
    ['http://h/srv/', 'http://h/srv/mcp'],
    ['http://localhost/servicenow/?profile=mock&toolset=jobs', 'http://localhost/servicenow/mcp?profile=mock&toolset=jobs'],
    ['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f'],
    ['https://x.test/mcp/'],
    ['http://h/s.php?k=1'],
  ]);
});
