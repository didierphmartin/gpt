/**
 * AdminController (part 2: usage stats, MCP admin, user MCP overrides, costs, exchange rates)
 * PHP-vs-TS differential — twin of backend_python/tests/differential/test_admin_usage_mcp_costs.py.
 *
 * Admin identity: user 3's `role` is 'admin' (each case asserts it first, the Python autouse
 * `_admin_is_role_admin`). PHP-first; self-cleaning; run ONLY this file (differential suites run
 * in isolation from each other).
 *
 * External refreshes (refreshAllCosts/refreshProviderCosts/refreshExchangeRates) are compared for
 * their VALIDATION responses only — never a real refresh ("NEVER call the external APIs in the
 * differential").
 *
 * Floats: usage-stats/costs compute round(sum, 4)/round(sum, 6); Apache's serialize_precision=100
 * leaks ~50 IEEE754 digits from PHP (tracker rows 12 / 134), so those reads use `sameRounded`.
 *
 * WRITES (dtest.write): test_mcp_server_create_update_toggle_delete_round_trip (creates/updates/
 * toggles/deletes a tmp admin MCP server; the Python autouse `_cleanup_tmp_mcp` sweep runs around
 * it) and test_user_mcp_override_round_trip (sets then restores user 3's override on one server).
 * The not-found DELETE on id 999999999 matches no row and stays a read case.
 */
import { dtest, DIFF_USER_ID, Harness, Client, same, sameRounded, assert } from './harness';

const TMP_MCP_NAME = 'differential-tmp-mcp';
// Deliberately unreachable (nothing listens on this loopback port): the create call's internal
// fetchMCPServerTools handshake fails fast and deterministically on both backends (connection
// refused) instead of ever reaching a real MCP server — no external side effect, no flakiness.
const TMP_MCP_URL = 'http://127.0.0.1:1/mcp';

async function adminIsRoleAdmin(hx: Harness): Promise<void> {
  const r = await hx.php.get(`/api/v1/admin/users/${DIFF_USER_ID}`, { headers: hx.h });
  assert.ok(r.status === 200 && r.json().user.role === 'admin', 'user 3 must be role=admin for this suite to run unskipped');
}

async function findTmpMcpId(client: Client, h: Record<string, string>): Promise<number | null> {
  const servers = (await client.get('/api/v1/admin/mcp/servers', { headers: h })).json().servers ?? [];
  for (const s of servers) if (s?.name === TMP_MCP_NAME) return s.id;
  return null;
}

async function deleteTmpMcpVia(client: Client, h: Record<string, string>): Promise<void> {
  const sid = await findTmpMcpId(client, h);
  if (sid !== null) await client.delete(`/api/v1/admin/mcp/servers/${sid}`, { headers: h });
}

async function serverRow(client: Client, h: Record<string, string>, id: number): Promise<any> {
  const row = (await client.get('/api/v1/admin/mcp/servers', { headers: h })).json().servers.find((s: any) => s.id === id);
  assert.ok(row, `${client.label}: server ${id} not listed`);
  return row;
}

// ─── reads ───────────────────────────────────────────────────────────────────

dtest('test_usage_reads_are_identical', async (hx) => {
  await adminIsRoleAdmin(hx);
  const o = { headers: hx.h };
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/stats', o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/by-user', o)));
  sameRounded(...(await hx.both('GET', `/api/v1/admin/usage/users/${DIFF_USER_ID}`, o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/transactions', o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/tools', o)));
});

dtest('test_mcp_and_costs_reads_are_identical', async (hx) => {
  await adminIsRoleAdmin(hx);
  const o = { headers: hx.h };
  same(...(await hx.both('GET', '/api/v1/admin/mcp/servers', o)));
  same(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}/mcp-servers`, o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/costs', o)));
  same(...(await hx.both('GET', '/api/v1/admin/exchange-rates', o)));
});

dtest('test_usage_stats_with_period_and_date_range_params', async (hx) => {
  await adminIsRoleAdmin(hx);
  const o = { headers: hx.h };
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/stats?period=week', o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/stats?period=all', o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/by-user?period=day&limit=5&offset=0', o)));
  sameRounded(...(await hx.both('GET', '/api/v1/admin/usage/transactions?status=success&limit=10', o)));
});

dtest('test_admin_routes_require_auth', async (hx) => {
  await adminIsRoleAdmin(hx);
  for (const path of [
    '/api/v1/admin/usage/stats', '/api/v1/admin/usage/by-user',
    `/api/v1/admin/usage/users/${DIFF_USER_ID}`, '/api/v1/admin/usage/transactions',
    '/api/v1/admin/usage/tools', '/api/v1/admin/mcp/servers',
    `/api/v1/admin/users/${DIFF_USER_ID}/mcp-servers`, '/api/v1/admin/costs',
    '/api/v1/admin/exchange-rates',
  ]) {
    same(...(await hx.both('GET', path, { auth: false })));
  }
});

dtest('test_not_found_parity', async (hx) => {
  await adminIsRoleAdmin(hx);
  same(...(await hx.both('GET', '/api/v1/admin/usage/users/999999999', { headers: hx.h })));
  same(...(await hx.both('DELETE', '/api/v1/admin/mcp/servers/999999999', { headers: hx.h })));
});

// ─── validation-only parity (no writes / no external calls) ────────────────

dtest('test_mcp_server_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  const h = hx.h;
  same(...(await hx.both('POST', '/api/v1/admin/mcp/servers', { json: { name: '', url: '' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/mcp/servers', { json: { name: 'X', url: 'not a url' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/mcp/servers/update', { json: { server_id: 0 }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/mcp/servers/toggle', { json: {}, headers: h })));
});

dtest('test_user_mcp_override_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  same(...(await hx.both('PUT', `/api/v1/admin/users/${DIFF_USER_ID}/mcp-servers/999999999/override`, { json: {}, headers: hx.h })));
});

dtest('test_costs_and_exchange_rate_refresh_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  const h = hx.h;
  // Validation-only: these never reach fetchProviderPricing/fetchExchangeRatesFromApi.
  same(...(await hx.both('POST', '/api/v1/admin/costs/refresh-provider', { json: { category: 'bogus' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/costs/refresh-provider', { json: { category: 'llm', provider: '' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/costs/refresh-provider', { json: { category: 'llm', provider: 'totally-not-a-real-provider' }, headers: h })));
});

// ─── MCP server round-trip (self-cleaning) — WRITES ─────────────────────────

dtest.write('test_mcp_server_create_update_toggle_delete_round_trip', async (hx) => {
  await adminIsRoleAdmin(hx);
  const { php, ts, h } = hx;
  await deleteTmpMcpVia(php, h);
  try {
    // Create via PHP first, then read back via both — the URL is unreachable so the create's
    // internal tools-fetch handshake fails fast (connection refused) without network dependency.
    const created = await php.post('/api/v1/admin/mcp/servers', {
      json: { name: TMP_MCP_NAME, url: TMP_MCP_URL, description: 'diff tmp' }, headers: h,
    });
    assert.ok(created.status === 200 && created.json().success === true, created.text);
    const serverId = created.json().server_id;

    try {
      assert.deepStrictEqual(await serverRow(ts, h, serverId), await serverRow(php, h, serverId));

      // Update (both backends, same target row) — verify parity after each.
      for (const client of [php, ts]) {
        const r = await client.post('/api/v1/admin/mcp/servers/update', {
          json: { server_id: serverId, name: TMP_MCP_NAME, url: TMP_MCP_URL, description: 'diff tmp updated' }, headers: h,
        });
        assert.equal(r.json().success, true, r.text);
      }
      const midPhp = await serverRow(php, h, serverId);
      assert.deepStrictEqual(await serverRow(ts, h, serverId), midPhp);
      assert.equal(midPhp.description, 'diff tmp updated');

      // Toggle with alternating target values across backends so every call is a genuine value
      // change. NOTE: toggleMCPServer's `UPDATE ... SET enabled = ?, updated_at = NOW()` uses the
      // default "affected rows" count (no FOUND_ROWS): re-toggling to the value a row already has
      // within the same wall-clock second returns 0 rows (404 "Server not found") — genuinely
      // non-deterministic in PHP ALONE, so it is deliberately not asserted here.
      for (const [targetEnabled, caller] of [[false, php], [true, ts], [false, ts], [true, php]] as const) {
        const r = await caller.post('/api/v1/admin/mcp/servers/toggle', { json: { server_id: serverId, enabled: targetEnabled }, headers: h });
        assert.equal(r.json().success, true, r.text);
        const afterPhp = await serverRow(php, h, serverId);
        assert.equal(afterPhp.enabled, targetEnabled);
        assert.deepStrictEqual(await serverRow(ts, h, serverId), afterPhp);
      }
    } finally {
      const deleted = await php.delete(`/api/v1/admin/mcp/servers/${serverId}`, { headers: h });
      assert.ok(deleted.status === 200 && deleted.json().success === true, deleted.text);
    }
  } finally {
    await deleteTmpMcpVia(php, h);
  }
});

// ─── user MCP override round-trip (self-cleaning, restores pre-state) — WRITES

dtest.write('test_user_mcp_override_round_trip', async (hx) => {
  await adminIsRoleAdmin(hx);
  const { php, ts, h } = hx;
  const listPath = `/api/v1/admin/users/${DIFF_USER_ID}/mcp-servers`;
  const pre = (await php.get(listPath, { headers: h })).json();
  assert.deepStrictEqual((await ts.get(listPath, { headers: h })).json(), pre);
  assert.ok(pre.servers?.length, 'need at least one existing MCP server visible to user 3 for this test');
  const target = pre.servers[0];
  const serverId = target.id;
  const preOverride = target.override;
  const newValue = !(preOverride !== null && preOverride !== undefined ? preOverride : target.package_default);
  const overridePath = `/api/v1/admin/users/${DIFF_USER_ID}/mcp-servers/${serverId}/override`;

  try {
    for (const client of [php, ts]) {
      const r = await client.put(overridePath, { json: { allowed: newValue }, headers: h });
      assert.ok(r.status === 200 && r.json().success === true, r.text);
    }
    const midPhp = (await php.get(listPath, { headers: h })).json();
    assert.deepStrictEqual((await ts.get(listPath, { headers: h })).json(), midPhp);
    const midRow = midPhp.servers.find((s: any) => s.id === serverId);
    assert.equal(midRow.override, newValue);
  } finally {
    // Restore: clear the override via both backends so pre-state comes back.
    for (const client of [php, ts]) await client.delete(overridePath, { headers: h });
    if (preOverride !== null && preOverride !== undefined) {
      // There WAS a pre-existing override — restore its exact value (the DELETE only clears to
      // package-default, so re-set it).
      for (const client of [php, ts]) await client.put(overridePath, { json: { allowed: preOverride }, headers: h });
    }
  }

  const post = (await php.get(listPath, { headers: h })).json();
  assert.deepStrictEqual(post, pre);
  assert.deepStrictEqual((await ts.get(listPath, { headers: h })).json(), post);
});
