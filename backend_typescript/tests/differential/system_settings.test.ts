/**
 * SystemSettingsController PHP-vs-TS differential (live DB, admin user 3) — twin of
 * backend_python/tests/differential/test_system_settings.py.
 *
 * PHP source: backend/src/Controllers/SystemSettingsController.php. Routes: backend/src/routes.php.
 *
 * `system_llm_settings` is a single SHARED table — PHP and TS both operate on the exact same rows,
 * so every mutation here is self-cleaning: round-trips restore the row to exactly what they found
 * (ignoring `updated_at`, which legitimately advances on every UPDATE regardless of backend).
 *
 * Live-checked by the Python suite (2026-09-07): user 3 has role='admin', `system_llm_settings`
 * has both price columns, a `kimi` row exists and is enabled, and the runtime config carries no
 * provider blocks post the 2026-05 cutover to DB-backed settings — so `seedFromConfig` seeds
 * nothing on PHP; the TS controller hard-codes an empty phpConfig, so it seeds nothing either.
 *
 * WRITES: test_save_kimi_unchanged_round_trip (UPDATEs the shared `kimi` row with its own values)
 * and test_toggle_twice_restores_state (flips `kimi.enabled` twice, restored in finally).
 * test_seed_from_config_is_a_no_op_and_matches stays a read case as in Python (a no-op on both).
 */
import { dtest, same, assert } from './harness';

const SAVE_FIELDS = [
  'provider_key', 'display_name', 'api_key', 'model', 'base_url', 'max_tokens',
  'temperature', 'price_input_per_1m', 'price_output_per_1m', 'chat_endpoint',
  'streaming', 'supports_tools', 'supported_models', 'api_format', 'system_prompt',
  'enabled', 'sort_order',
];

function withoutUpdatedAt(j: any): any {
  const c = { ...j, provider: { ...j.provider } };
  delete c.provider.updated_at;
  return c;
}

// ─── reads (no side effects) ────────────────────────────────────────────

dtest('test_admin_llm_settings_reads_are_identical', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/llm-settings')));
  same(...(await hx.both('GET', '/api/v1/admin/llm-settings/kimi')));
});

dtest('test_admin_llm_settings_require_auth', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/llm-settings', { auth: false })));
  same(...(await hx.both('GET', '/api/v1/admin/llm-settings/kimi', { auth: false })));
});

dtest('test_admin_llm_settings_unknown_provider_404', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/admin/llm-settings/no-such-provider-xyz')));
});

// ─── validation (no writes) ──────────────────────────────────────────────

dtest('test_save_validation', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/admin/llm-settings', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/admin/llm-settings', { json: { provider_key: 'kimi' } })));
  same(...(await hx.both('POST', '/api/v1/admin/llm-settings', { json: { provider_key: 'kimi', model: 'm', api_format: 'bogus' } })));
});

dtest('test_delete_and_toggle_validation', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/admin/llm-settings/toggle', { json: {} })));
});

dtest('test_delete_not_found', async (hx) => {
  same(...(await hx.both('DELETE', '/api/v1/admin/llm-settings/no-such-provider-xyz')));
});

// ─── round-trips (self-cleaning; real live rows) — WRITES ────────────────

dtest.write('test_save_kimi_unchanged_round_trip', async (hx) => {
  const [preA, preB] = await hx.both('GET', '/api/v1/admin/llm-settings/kimi');
  same(preA, preB);
  const provider = preA.json().provider;
  const body: Record<string, unknown> = {};
  for (const k of SAVE_FIELDS) body[k] = provider[k];

  const [rA, rB] = await hx.both('POST', '/api/v1/admin/llm-settings', { json: body });
  same(rA, rB);
  assert.deepStrictEqual(rA.json(), { success: true, message: 'Provider updated', provider_key: 'kimi' }, rA.text);

  const [afterA, afterB] = await hx.both('GET', '/api/v1/admin/llm-settings/kimi');
  same(afterA, afterB);
  assert.deepStrictEqual(withoutUpdatedAt(afterA.json()), withoutUpdatedAt(preA.json()));
});

/**
 * Exercises TS's toggle then PHP's toggle on the SAME shared row — either backend's 'NOT enabled'
 * flip is visible to both readers immediately. Self-cleaning: the restore runs in `finally`, so a
 * mid-test failure never leaves the shared `kimi` row with its `enabled` flag flipped.
 */
dtest.write('test_toggle_twice_restores_state', async (hx) => {
  const { php, ts, h } = hx;
  const path = '/api/v1/admin/llm-settings/kimi';
  const pre = (await php.get(path, { headers: h })).json();
  assert.deepStrictEqual((await ts.get(path, { headers: h })).json(), pre);
  const preEnabled = pre.provider.enabled;

  try {
    const r1 = await ts.post('/api/v1/admin/llm-settings/toggle', { json: { provider_key: 'kimi' }, headers: h });
    assert.deepStrictEqual(r1.json(), { success: true, message: 'Provider toggled' }, r1.text);
    const midPhp = (await php.get(path, { headers: h })).json();
    const midTs = (await ts.get(path, { headers: h })).json();
    assert.equal(midPhp.provider.enabled, !preEnabled);
    assert.deepStrictEqual(withoutUpdatedAt(midTs), withoutUpdatedAt(midPhp));

    const r2 = await php.post('/api/v1/admin/llm-settings/toggle', { json: { provider_key: 'kimi' }, headers: h });
    assert.deepStrictEqual(r2.json(), { success: true, message: 'Provider toggled' }, r2.text);

    const afterPhp = (await php.get(path, { headers: h })).json();
    const afterTs = (await ts.get(path, { headers: h })).json();
    assert.equal(afterPhp.provider.enabled, preEnabled);
    assert.deepStrictEqual(withoutUpdatedAt(afterTs), withoutUpdatedAt(afterPhp));
    assert.deepStrictEqual(withoutUpdatedAt(afterPhp), withoutUpdatedAt(pre));
  } finally {
    // Best-effort restore: re-read the shared row and toggle it back if it still differs.
    const current = (await php.get(path, { headers: h })).json().provider.enabled;
    if (current !== preEnabled) await php.post('/api/v1/admin/llm-settings/toggle', { json: { provider_key: 'kimi' }, headers: h });
  }
});

// ─── seed (no-op on the live config; see header) ────────────────────────

/**
 * The runtime config has no provider blocks (post 2026-05 cutover), so `seeded` comes back empty on
 * both backends and no row is touched -- safe to call for real.
 */
dtest('test_seed_from_config_is_a_no_op_and_matches', async (hx) => {
  const [rA, rB] = await hx.both('POST', '/api/v1/admin/llm-settings/seed');
  same(rA, rB);
  assert.deepStrictEqual(rA.json(), { success: true, message: 'Providers seeded from config', seeded: [] }, rA.text);
});
