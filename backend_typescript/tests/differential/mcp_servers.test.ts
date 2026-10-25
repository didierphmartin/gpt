/**
 * PHP-vs-TS differential: MCPServerController (backend/src/Controllers/MCPServerController.php) —
 * twin of backend_python/tests/differential/test_mcp_servers.py.
 *
 * Read parity is exact — the server list carries `s.*`, so a drift in the int casts, the transport
 * normalization, the derived `server_type` or the global-headers redaction shows up immediately.
 *
 * WRITES (dtest.write):
 *  - test_mcp_server_round_trip creates ONE private server named `differential-tmp` pointing at
 *    `http://127.0.0.1:1/mcp` (port 1 — deliberately unroutable; nothing here ever calls it),
 *    exercises update/toggle/override on it, deletes it by the returned id on the backend that
 *    created it, and asserts both list endpoints are identical to the pre-state on BOTH backends
 *    afterwards (self-cleaning).
 *  - test_me_mcp_settings_idempotent_write_back_parity: `PUT /me/mcp-settings` writes back the
 *    value it just read, so it is idempotent — but it is still an UPDATE.
 * The validation cases write no rows (the update/toggle of id 999999999 matches nothing).
 *
 * PHP always runs first — `both` guarantees that, and the hand-written steps follow the same order.
 */
import { dtest, same, assert, Harness } from './harness';

const TMP_NAME = 'differential-tmp';
const TMP_URL = 'http://127.0.0.1:1/mcp';

// ─── reads ─────────────────────────────────────────────────────────────────

dtest('test_mcp_servers_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/mcp/servers')));
  same(...(await hx.both('GET', '/api/v1/mcp/servers?include_disabled=1')));
  same(...(await hx.both('GET', '/api/v1/mcp/servers?include_disabled=0')));
  same(...(await hx.both('GET', '/api/v1/mcp/servers?user_id=3')));
});

dtest('test_mcp_all_tools_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/mcp/servers/all-tools')));
});

dtest('test_mcp_server_tools_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/mcp/servers/tools?server_id=24')));
  same(...(await hx.both('GET', '/api/v1/mcp/servers/tools'))); // no id => empty list, 200
  same(...(await hx.both('GET', '/api/v1/mcp/servers/tools?server_id='))); // falsy id => same empty list
  same(...(await hx.both('GET', '/api/v1/mcp/servers/tools?server_id=999999999')));
});

dtest('test_me_mcp_servers_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/me/mcp-servers')));
});

// ─── validation (no rows are written by any of these) ──────────────────────

dtest('test_mcp_create_validation_parity', async (hx) => {
  const post = async (json: any) => same(...(await hx.both('POST', '/api/v1/mcp/servers', { json })));
  await post({ name: 'x', url: TMP_URL, transport: 'stdio' });
  await post({ url: TMP_URL });
  await post({ name: '   ', url: TMP_URL });
  await post({ name: 'x' });
  await post({ name: 'x', url: 'not a url' });
  await post({ name: 'x', url: 'example.com' });
  await post({ name: 'x', url: 'http://ex_ample.com/p' });
});

dtest('test_mcp_update_toggle_delete_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/servers/update', { json: { name: 'x', url: TMP_URL } })));
  same(...(await hx.both('POST', '/api/v1/mcp/servers/update', { json: { server_id: 999999999, name: '', url: TMP_URL } })));
  same(...(await hx.both('POST', '/api/v1/mcp/servers/update', { json: { server_id: 999999999, name: 'x', url: TMP_URL, transport: 'stdio' } })));
  // id nobody owns => UPDATE matches nothing => 404
  same(...(await hx.both('POST', '/api/v1/mcp/servers/update', { json: { server_id: 999999999, name: 'x', url: TMP_URL } })));
  same(...(await hx.both('POST', '/api/v1/mcp/servers/toggle', { json: { enabled: false } })));
  // toggle never checks rowCount (PHP 469-478): a foreign id still 200s
  same(...(await hx.both('POST', '/api/v1/mcp/servers/toggle', { json: { server_id: 999999999, enabled: false } })));
  same(...(await hx.both('DELETE', '/api/v1/mcp/servers')));
  same(...(await hx.both('DELETE', '/api/v1/mcp/servers?server_id=999999999')));
});

dtest('test_me_mcp_override_validation_parity', async (hx) => {
  // Server 999999999 does not exist, so no override row is written.
  same(...(await hx.both('PUT', '/api/v1/me/mcp-servers/999999999/override', { json: {} })));
  same(...(await hx.both('PUT', '/api/v1/me/mcp-servers/999999999/override', { json: { allowed: true } })));
  same(...(await hx.both('PUT', '/api/v1/me/mcp-servers/999999999/override', { json: { allowed: false } })));
  same(...(await hx.both('DELETE', '/api/v1/me/mcp-servers/999999999/override')));
});

dtest('test_me_mcp_settings_validation_parity', async (hx) => {
  same(...(await hx.both('PUT', '/api/v1/me/mcp-settings', { json: {} })));
});

/** Writes back the value the row already holds, so the DB is unchanged. */
dtest.write('test_me_mcp_settings_idempotent_write_back_parity', async (hx) => {
  const current = (await hx.php.get('/api/v1/me/mcp-servers', { headers: hx.h })).json().mcp_enabled;
  same(...(await hx.both('PUT', '/api/v1/me/mcp-settings', { json: { mcp_enabled: current } })));
  same(...(await hx.both('GET', '/api/v1/me/mcp-servers')));
});

// ─── create → override → clear → delete round-trip — WRITES ────────────────

/** PHP first, then TS (differential ordering). */
async function snapshot(hx: Harness) {
  const h = { headers: hx.h };
  return {
    php_servers: (await hx.php.get('/api/v1/mcp/servers?include_disabled=1', h)).json(),
    ts_servers: (await hx.ts.get('/api/v1/mcp/servers?include_disabled=1', h)).json(),
    php_mine: (await hx.php.get('/api/v1/me/mcp-servers', h)).json(),
    ts_mine: (await hx.ts.get('/api/v1/me/mcp-servers', h)).json(),
  };
}

/** A previous aborted run may have left the temp row behind. */
async function purgeLeftovers(hx: Harness): Promise<void> {
  const h = { headers: hx.h };
  for (const s of (await hx.php.get('/api/v1/me/mcp-servers', h)).json().servers ?? []) {
    if (s.name === TMP_NAME) {
      await hx.php.delete(`/api/v1/me/mcp-servers/${s.id}/override`, h);
      await hx.php.delete(`/api/v1/mcp/servers?server_id=${s.id}`, h);
    }
  }
}

dtest.write('test_mcp_server_round_trip', async (hx) => {
  const { php, ts } = hx;
  const h = { headers: hx.h };
  await purgeLeftovers(hx);
  const before = await snapshot(hx);

  const created = await php.post('/api/v1/mcp/servers', {
    json: { name: TMP_NAME, url: TMP_URL, description: 'differential temp', transport: 'sse' }, headers: hx.h,
  });
  assert.equal(created.status, 200, created.text);
  const body = created.json();
  assert.ok(body.success === true && body.message === 'Server added successfully');
  // PDO::lastInsertId() is a string, so json_encode quotes it (PHP 348-354).
  assert.equal(typeof body.server_id, 'string', JSON.stringify(body));
  const sid = parseInt(body.server_id, 10);

  try {
    // Both backends must render the brand-new private server identically.
    same(...(await hx.both('GET', '/api/v1/mcp/servers')));
    same(...(await hx.both('GET', '/api/v1/me/mcp-servers')));

    const mine = (await ts.get('/api/v1/me/mcp-servers', h)).json().servers;
    assert.deepStrictEqual(mine.find((s: any) => s.id === sid), {
      id: sid, name: TMP_NAME, url: TMP_URL, is_global: false,
      is_mock: false, tool_count: 0, effective_on: true,
    });
    const row = (await ts.get('/api/v1/mcp/servers', h)).json().servers.find((s: any) => s.id === sid);
    assert.ok(row.transport === 'sse' && row.server_type === 'mcp' && row.headers === null, JSON.stringify(row));

    // update on the TS backend, then compare the reads on both
    const upd = await ts.post('/api/v1/mcp/servers/update', {
      json: { server_id: sid, name: TMP_NAME, url: TMP_URL, description: 'updated' }, headers: hx.h,
    });
    assert.deepStrictEqual(upd.json(), { success: true, message: 'Server updated successfully' }, upd.text);
    same(...(await hx.both('GET', '/api/v1/mcp/servers?include_disabled=1')));

    // toggle off on PHP, back on via TS
    const off = await php.post('/api/v1/mcp/servers/toggle', { json: { server_id: sid, enabled: false }, headers: hx.h });
    assert.deepStrictEqual(off.json(), { success: true, message: 'Server disabled' });
    same(...(await hx.both('GET', '/api/v1/mcp/servers')));
    same(...(await hx.both('GET', '/api/v1/mcp/servers?include_disabled=1')));
    const on = await ts.post('/api/v1/mcp/servers/toggle', { json: { server_id: sid, enabled: true }, headers: hx.h });
    assert.deepStrictEqual(on.json(), { success: true, message: 'Server enabled' });

    // deny-only override, set on the TS backend
    const ov = await ts.put(`/api/v1/me/mcp-servers/${sid}/override`, { json: { allowed: false }, headers: hx.h });
    assert.deepStrictEqual(ov.json(), { success: true, server_id: sid, allowed: false }, ov.text);
    // the override hides it from list() on both backends; listMine() still shows a private
    // server as effective_on = its own `enabled` (PHP 601-605)
    same(...(await hx.both('GET', '/api/v1/mcp/servers')));
    same(...(await hx.both('GET', '/api/v1/me/mcp-servers')));
    assert.ok(!(await ts.get('/api/v1/mcp/servers', h)).json().servers.some((s: any) => s.id === sid));

    const cleared = await ts.delete(`/api/v1/me/mcp-servers/${sid}/override`, h);
    assert.deepStrictEqual(cleared.json(), { success: true, server_id: sid, cleared: true });
    const again = await ts.delete(`/api/v1/me/mcp-servers/${sid}/override`, h);
    assert.deepStrictEqual(again.json(), { success: true, server_id: sid, cleared: false });
    same(...(await hx.both('GET', '/api/v1/mcp/servers')));
  } finally {
    const gone = await php.delete(`/api/v1/mcp/servers?server_id=${sid}`, h);
    assert.deepStrictEqual(gone.json(), { success: true, message: 'Server deleted successfully' }, gone.text);
  }

  assert.deepStrictEqual(await snapshot(hx), before);
});
