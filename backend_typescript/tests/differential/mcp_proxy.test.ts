/**
 * PHP-vs-TS differential: MCPProxyController + MCPAppController
 * (backend/src/Controllers/MCPProxyController.php, MCPAppController.php) — twin of
 * backend_python/tests/differential/test_mcp_proxy.py.
 *
 * Validation-only cases use the shared `same()` deep-equality helper — they never touch the
 * network. The one live case hits server id 24 ("Metals News", http://localhost/metals/public/mcp)
 * with `action: 'proxy'` + `tools/list` only: that action never writes (unlike `discover_tools`,
 * which calls cacheTools() and would leave rows in mcp_server_tools — deliberately not exercised
 * here; NEVER call a tools/call that writes). Its response is compared by status + top-level keys
 * + the sorted tool-name list, not full deep equality (a live 3rd-party server's byte shape is not
 * this port's contract to pin).
 *
 * PHP always runs first — `both` guarantees that for every validation case; the one live case
 * follows the same order by hand. No case in this file writes data.
 */
import { dtest, same, assert, Client } from './harness';

const METALS_URL = 'http://localhost/metals/public/mcp';
const METALS_SERVER_ID = 24;

// ─── POST /api/v1/mcp/proxy — validation (no network, no DB writes) ────────

dtest('test_mcp_proxy_action_proxy_requires_server_url', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'proxy' } })));
});

dtest('test_mcp_proxy_action_proxy_unknown_server_id_has_no_url', async (hx) => {
  // getServerUrl() only matches servers OWNED by this exact user_id (PHP 436-439) — an id with
  // no server_url given resolves to null.
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'proxy', server_id: 999999999 } })));
});

dtest('test_mcp_proxy_action_proxy_requires_jsonrpc', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'proxy', server_url: METALS_URL } })));
});

dtest('test_mcp_proxy_action_discover_tools_requires_server_url', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'discover_tools' } })));
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'discover_tools', server_url: '' } })));
});

dtest('test_mcp_proxy_action_test_connection_requires_server_url', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'test_connection' } })));
});

dtest('test_mcp_proxy_unknown_action', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: { action: 'bogus' } })));
});

dtest('test_mcp_proxy_missing_action', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/proxy', { json: {} })));
});

// ─── POST /api/v1/mcp/proxy — live, read-only tools/list ───────────────────

dtest('test_mcp_proxy_tools_list_live_parity', async (hx) => {
  const reqBody = {
    action: 'proxy',
    server_id: METALS_SERVER_ID,
    server_url: METALS_URL,
    jsonrpc: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  };
  const a = await hx.php.post('/api/v1/mcp/proxy', { json: reqBody, headers: hx.h }); // PHP first
  const b = await hx.ts.post('/api/v1/mcp/proxy', { json: reqBody, headers: hx.h });

  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const ja = a.json();
  const jb = b.json();
  assert.deepStrictEqual(Object.keys(ja).sort(), ['response', 'success']);
  assert.deepStrictEqual(Object.keys(jb).sort(), ['response', 'success']);
  assert.ok(ja.success === true && jb.success === true);

  const toolNames = (doc: any) => (doc.response.result.tools as any[]).map((t) => t.name).sort();
  const namesA = toolNames(ja);
  assert.deepStrictEqual(toolNames(jb), namesA);
  assert.ok(namesA.length > 0); // sanity: the live server actually has tools
});

// ─── GET /api/v1/mcp/app (+ legacy /api/mcp-app.php) — validation parity ───
//
// getResource()'s error responses are `content_type: text/plain` (PHP index.php:169-174 echoes
// $result['error'] raw, no JSON envelope) — so these compare status + raw body directly instead
// of the JSON-based `same()` helper.

async function sameText(php: Client, ts: Client, path: string): Promise<void> {
  const a = await php.get(path); // PHP first (differential ordering)
  const b = await ts.get(path);
  assert.equal(a.status, b.status, `${a.status} ${b.status}\n${a.text}\n${b.text}`);
  assert.equal(b.text, a.text);
  assert.ok((a.headers.get('content-type') ?? '').startsWith('text/plain'), `php content-type ${a.headers.get('content-type')}`);
  assert.ok((b.headers.get('content-type') ?? '').startsWith('text/plain'), `ts content-type ${b.headers.get('content-type')}`);
}

dtest('test_mcp_app_missing_server_parameter', async (hx) => {
  await sameText(hx.php, hx.ts, '/api/v1/mcp/app');
  await sameText(hx.php, hx.ts, '/api/mcp-app.php');
});

dtest('test_mcp_app_missing_resource_parameter', async (hx) => {
  // httpx sends the query unencoded beyond its own normalisation; fetch keeps it as written.
  await sameText(hx.php, hx.ts, `/api/v1/mcp/app?server=${METALS_URL}`);
  await sameText(hx.php, hx.ts, `/api/mcp-app.php?server=${METALS_URL}`);
});
