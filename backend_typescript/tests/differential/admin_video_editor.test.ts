/**
 * PHP-vs-TS differential tests for VideoEditorController (routes.php 199-214,
 * /api/v1/admin/video-editor/*) — twin of backend_python/tests/differential/test_admin_video_editor.py.
 *
 * User 3 IS admin on both backends, so every route here is exercised for its real 200 response,
 * not just the 403 text. PHP-first, self-cleaning.
 *
 * WRITES (dtest.write): every test_save_*_roundtrip_noop case (each POSTs an existing row back
 * byte-for-byte through PHP — a no-op upsert, but still a write) and
 * test_set_user_role_roundtrip_restore (temporarily changes user 3's video-edit role in the LOGIN
 * DB, then restores it). The two first cases are read-only.
 */
import { dtest, same, assert } from './harness';

const BASE = '/api/v1/admin/video-editor';

dtest('test_reads_exact_for_admin_user', async (hx) => {
  for (const p of [
    '/usage/stats', '/usage/stats?days=7', '/usage/summary', '/usage/by-user', '/usage/by-user?days=90',
    '/transactions', '/transactions?all=1&per_page=5', '/prices', '/providers', '/models', '/users',
    '/users?q=a', '/packages', '/user-override?user_id=3',
  ]) {
    same(...(await hx.both('GET', `${BASE}${p}`)));
  }
});

dtest('test_auth_required', async (hx) => {
  // Not in MiddlewareProcessor::PUBLIC_ROUTES — every video-editor route needs a JWT, even the ones
  // with no controller-level admin gate (e.g. usage/stats).
  same(...(await hx.both('GET', `${BASE}/usage/stats`, { auth: false })));
  same(...(await hx.both('GET', `${BASE}/transactions`, { auth: false })));
});

/**
 * Read one existing price row via PHP, POST it back byte-for-byte (no delete route exists for
 * video_edit_prices), assert both backends still list it identically — self-cleaning since
 * nothing actually changes.
 */
dtest.write('test_save_price_roundtrip_noop', async (hx) => {
  const before = (await hx.php.get(`${BASE}/prices`, { headers: hx.h })).json();
  assert.ok(before.success === true && before.prices?.length, 'no price rows to round-trip against');
  const row = before.prices[0];
  const r = await hx.php.post(`${BASE}/prices`, { json: { model: row.model, unit: row.unit, rate: row.rate, label: row.label }, headers: hx.h });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  same(...(await hx.both('GET', `${BASE}/prices`)));
});

dtest.write('test_save_model_roundtrip_noop', async (hx) => {
  const before = (await hx.php.get(`${BASE}/models`, { headers: hx.h })).json();
  assert.ok(before.success === true && before.models?.length, 'no model rows to round-trip against');
  const row = before.models[0];
  const r = await hx.php.post(`${BASE}/models`, {
    json: { model: row.model, provider: row.provider, kind: row.kind, label: row.label, enabled: row.enabled }, headers: hx.h,
  });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  same(...(await hx.both('GET', `${BASE}/models`)));
});

/**
 * Echo back label/api_base/enabled for an existing provider, omitting api_key and models so both
 * stay untouched (PHP: blank api_key keeps the stored key, omitted 'models' keeps the catalog).
 */
dtest.write('test_save_provider_roundtrip_noop', async (hx) => {
  const before = (await hx.php.get(`${BASE}/providers`, { headers: hx.h })).json();
  assert.ok(before.success === true && before.providers?.length, 'no provider rows to round-trip against');
  const row = before.providers[0];
  const r = await hx.php.post(`${BASE}/providers`, {
    json: { provider: row.provider, label: row.label, api_base: row.api_base, enabled: Boolean(row.enabled) }, headers: hx.h,
  });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  same(...(await hx.both('GET', `${BASE}/providers`)));
});

/** 'guest' carries no secrets (unlike 'admin', whose capabilities.provider_keys holds real keys). */
dtest.write('test_save_package_roundtrip_noop', async (hx) => {
  const before = (await hx.php.get(`${BASE}/packages`, { headers: hx.h })).json();
  assert.equal(before.success, true);
  const guest = (before.packages ?? []).find((p: any) => p.role === 'guest');
  assert.ok(guest, 'no guest package row to round-trip against');
  const r = await hx.php.post(`${BASE}/packages`, { json: { role: 'guest', capabilities: guest.capabilities }, headers: hx.h });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  same(...(await hx.both('GET', `${BASE}/packages`)));
});

/**
 * user 3's pre-state capabilities is null — omitting 'capabilities' makes PHP write null again
 * (array_key_exists, not isset), a true no-op; omitting 'byo_keys' leaves the BYO map untouched.
 */
dtest.write('test_save_user_override_roundtrip_noop', async (hx) => {
  const before = (await hx.php.get(`${BASE}/user-override?user_id=3`, { headers: hx.h })).json();
  assert.equal(before.success, true);
  assert.equal(before.capabilities, null, 'pre-state capabilities changed since authorship — re-verify round-trip');
  const r = await hx.php.post(`${BASE}/user-override`, { json: { user_id: 3 }, headers: hx.h });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  same(...(await hx.both('GET', `${BASE}/user-override?user_id=3`)));
});

/** Restore user 3's own video-edit role after a temporary change (pre-state: 'admin'). */
dtest.write('test_set_user_role_roundtrip_restore', async (hx) => {
  const before = (await hx.php.get(`${BASE}/users?q=`, { headers: hx.h })).json();
  const me = (before.users ?? []).find((u: any) => u.id === 3);
  assert.ok(me, 'user 3 not present in the video-edit users list');
  const originalRole = me.ve_role;

  const tempRole = originalRole !== 'user' ? 'user' : 'admin';
  let r = await hx.php.post(`${BASE}/users/role`, { json: { user_id: 3, role: tempRole }, headers: hx.h });
  assert.ok(r.status === 200 && r.json().success === true, r.text);
  try {
    same(...(await hx.both('GET', `${BASE}/users?q=`)));
  } finally {
    r = await hx.php.post(`${BASE}/users/role`, { json: { user_id: 3, role: originalRole ? originalRole : '' }, headers: hx.h });
    assert.ok(r.status === 200 && r.json().success === true, r.text);
  }

  const after = (await hx.php.get(`${BASE}/users?q=`, { headers: hx.h })).json();
  const meAfter = (after.users ?? []).find((u: any) => u.id === 3);
  assert.ok(meAfter && meAfter.ve_role === originalRole);
  same(...(await hx.both('GET', `${BASE}/users?q=`)));
});
