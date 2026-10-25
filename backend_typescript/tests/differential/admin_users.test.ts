/**
 * AdminController (part 1: users, providers, keys) PHP-vs-TS differential — twin of
 * backend_python/tests/differential/test_admin_users.py.
 *
 * Admin identity: user 3's `role` is 'admin' — every admin route below is exercised for real, not
 * skipped to 403-only (each case first asserts it, the Python autouse `_admin_is_role_admin`).
 * PHP-first; self-cleaning.
 *
 * WRITES: test_provider_toggle_round_trip_restores_state (toggles user 3's voice/grok provider and
 * restores it) and test_cross_backend_create_login_delete (creates, logs in as, deletes a tmp
 * user; the Python autouse `_cleanup_tmp_user` sweep runs around it). Everything else is read-only.
 */
import { dtest, DIFF_USER_ID, Harness, Client, same, sameRounded, assert } from './harness';

const TMP_EMAIL = 'differential-tmp-user@example.com';

async function adminIsRoleAdmin(hx: Harness): Promise<void> {
  const r = await hx.php.get(`/api/v1/admin/users/${DIFF_USER_ID}`, { headers: hx.h });
  assert.ok(r.status === 200 && r.json().user.role === 'admin', 'user 3 must be role=admin for this suite to run unskipped');
}

/** Best-effort cleanup: no lookup-by-email route, so list and delete by id. */
async function deleteTmpUserVia(client: Client, h: Record<string, string>): Promise<void> {
  const users = (await client.get('/api/v1/admin/users', { headers: h })).json().users ?? [];
  for (const u of users) {
    if (u?.email === TMP_EMAIL) await client.delete(`/api/v1/admin/users/${u.id}`, { headers: h });
  }
}

// ─── reads ───────────────────────────────────────────────────────────────────

dtest('test_admin_reads_are_identical', async (hx) => {
  await adminIsRoleAdmin(hx);
  const h = { headers: hx.h };
  same(...(await hx.both('GET', '/api/v1/admin/users', h)));
  same(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}`, h)));
  same(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}/account`, h)));
  same(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}/providers`, h)));
  sameRounded(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}/costs`, h)));
  same(...(await hx.both('GET', `/api/v1/admin/users/${DIFF_USER_ID}/keys`, h)));
});

dtest('test_admin_routes_require_auth', async (hx) => {
  await adminIsRoleAdmin(hx);
  for (const path of [
    '/api/v1/admin/users', `/api/v1/admin/users/${DIFF_USER_ID}`,
    `/api/v1/admin/users/${DIFF_USER_ID}/account`, `/api/v1/admin/users/${DIFF_USER_ID}/providers`,
    `/api/v1/admin/users/${DIFF_USER_ID}/costs`, `/api/v1/admin/users/${DIFF_USER_ID}/keys`,
  ]) {
    same(...(await hx.both('GET', path, { auth: false })));
  }
});

// ─── not-found parity ────────────────────────────────────────────────────────

// The DELETE of a non-existent id changes nothing (0 rows), so this stays a read case as in Python.
dtest('test_not_found_parity', async (hx) => {
  await adminIsRoleAdmin(hx);
  const h = { headers: hx.h };
  same(...(await hx.both('GET', '/api/v1/admin/users/999999999', h)));
  same(...(await hx.both('GET', '/api/v1/admin/users/999999999/account', h)));
  same(...(await hx.both('DELETE', '/api/v1/admin/users/999999999', h)));
});

// ─── validation (no writes) ─────────────────────────────────────────────────

dtest('test_create_user_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  same(...(await hx.both('POST', '/api/v1/admin/users', { json: {}, headers: hx.h })));
  same(...(await hx.both('POST', '/api/v1/admin/users', { json: { email: 'x@y.com' }, headers: hx.h })));
});

dtest('test_update_user_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  same(...(await hx.both('POST', '/api/v1/admin/users/update', { json: { user_id: 0 }, headers: hx.h })));
  same(...(await hx.both('POST', '/api/v1/admin/users/update', { json: { user_id: DIFF_USER_ID, role: 'superadmin' }, headers: hx.h })));
});

dtest('test_provider_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  const h = hx.h;
  same(...(await hx.both('POST', '/api/v1/admin/providers', { json: { user_id: DIFF_USER_ID, category: 'x' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/providers', { json: { user_id: DIFF_USER_ID, category: 'voice' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/providers/toggle', { json: { user_id: DIFF_USER_ID, category: 'nope', provider: 'grok' }, headers: h })));
  same(...(await hx.both('POST', '/api/v1/admin/providers/category-toggle', { json: { user_id: DIFF_USER_ID, category: 'nope' }, headers: h })));
  same(...(await hx.both('DELETE', '/api/v1/admin/providers', { json: { user_id: DIFF_USER_ID, category: 'voice', provider: '' }, headers: h })));
});

dtest('test_keys_validation', async (hx) => {
  await adminIsRoleAdmin(hx);
  same(...(await hx.both('POST', '/api/v1/admin/keys', { json: { user_id: DIFF_USER_ID }, headers: hx.h })));
  same(...(await hx.both('POST', '/api/v1/admin/keys/delete', { json: { user_id: DIFF_USER_ID }, headers: hx.h })));
});

// ─── provider toggle round-trip (restores state) — WRITES ───────────────────

dtest.write('test_provider_toggle_round_trip_restores_state', async (hx) => {
  await adminIsRoleAdmin(hx);
  const { php, ts, h } = hx;
  const providersPath = `/api/v1/admin/users/${DIFF_USER_ID}/providers`;
  const pre = (await php.get(providersPath, { headers: h })).json();
  assert.deepStrictEqual((await ts.get(providersPath, { headers: h })).json(), pre);
  const grok = pre.voice.providers.grok ?? {};
  const originalEnabled = grok.enabled ?? true;

  for (const client of [php, ts]) {
    const r = await client.post('/api/v1/admin/providers/toggle', {
      json: { user_id: DIFF_USER_ID, category: 'voice', provider: 'grok', enabled: !originalEnabled }, headers: h,
    });
    assert.equal(r.json().success, true, r.text);
  }

  const mid = (await php.get(providersPath, { headers: h })).json();
  assert.equal(mid.voice.providers.grok.enabled, !originalEnabled);
  assert.deepStrictEqual((await ts.get(providersPath, { headers: h })).json(), mid);

  for (const client of [php, ts]) {
    const r = await client.post('/api/v1/admin/providers/toggle', {
      json: { user_id: DIFF_USER_ID, category: 'voice', provider: 'grok', enabled: originalEnabled }, headers: h,
    });
    assert.equal(r.json().success, true, r.text);
  }

  const post = (await php.get(providersPath, { headers: h })).json();
  assert.deepStrictEqual(post, pre);
  assert.deepStrictEqual((await ts.get(providersPath, { headers: h })).json(), post);
});

// ─── cross-backend user create/login/delete round-trip — WRITES ─────────────
// createUser hashes with bcrypt ($2y$-family); a user created by one backend must be able to log
// in through the OTHER backend, proving the hash format round-trips (AdminController.php:166-211).

for (const [writer, reader, deleter] of [['php', 'ts', 'php'], ['ts', 'php', 'ts']] as const) {
  dtest.write(`test_cross_backend_create_login_delete[${writer}-${reader}-${deleter}]`, async (hx) => {
    await adminIsRoleAdmin(hx);
    const { h } = hx;
    const clients = { php: hx.php, ts: hx.ts };
    const w = clients[writer];
    const r = clients[reader];
    const d = clients[deleter];
    await deleteTmpUserVia(hx.php, h);
    try {
      const password = `diff-${writer}-${Math.floor(Date.now() / 1000)}-pw`;
      const created = await w.post('/api/v1/admin/users', {
        json: { email: TMP_EMAIL, password, first_name: 'Diff', last_name: 'Tmp', role: 'user' }, headers: h,
      });
      assert.ok(created.status === 200 && created.json().success === true, created.text);
      const userId = created.json().user_id;
      try {
        const login = await r.post('/api/v1/auth/login', { json: { email: TMP_EMAIL, password } });
        assert.ok(login.status === 200 && login.json().success === true, login.text);
        assert.equal(login.json().data.user.id, userId);
        // Wrong password still rejected by both sides — the hash isn't accepting everything.
        const bad = await r.post('/api/v1/auth/login', { json: { email: TMP_EMAIL, password: 'definitely-wrong' } });
        assert.equal(bad.status, 401);
      } finally {
        const deleted = await d.delete(`/api/v1/admin/users/${userId}`, { headers: h });
        assert.ok(deleted.status === 200 && deleted.json().success === true, deleted.text);
      }
    } finally {
      await deleteTmpUserVia(hx.php, h);
    }
  });
}
