/**
 * AppKeyController PHP-vs-TS differential — twin of backend_python/tests/differential/test_app_keys.py.
 *
 * WRITES: test_app_keys_create_destroy_round_trip (creates + revokes a `differential-tmp` key on
 * each backend, then hard-deletes the rows via SQL). The DELETE of id 999999999 touches no row.
 */
import { dtest, DIFF_USER_ID, same, assert } from './harness';

dtest('test_app_keys_admin_reads_parity', async (hx) => {
  // User 3 is admin, so index/workflows/agents run for real (200), not just 403 parity.
  same(...(await hx.both('GET', '/api/v1/app-keys')));
  same(...(await hx.both('GET', '/api/v1/app-keys/whoami'))); // JWT auth -> 401 "requires app-key authentication"
  same(...(await hx.both('GET', `/api/v1/app-keys/workflows?user_id=${DIFF_USER_ID}`)));
  same(...(await hx.both('GET', `/api/v1/app-keys/agents?user_id=${DIFF_USER_ID}`)));
});

dtest('test_app_keys_workflows_agents_missing_user_id_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/app-keys/workflows')));
  same(...(await hx.both('GET', '/api/v1/app-keys/agents')));
});

dtest('test_app_keys_unauthenticated_401', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/app-keys', { auth: false })));
  same(...(await hx.both('GET', '/api/v1/app-keys/whoami', { auth: false })));
});

dtest('test_app_keys_destroy_not_found_parity', async (hx) => {
  same(...(await hx.both('DELETE', '/api/v1/app-keys/999999999')));
});

dtest('test_app_keys_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/app-keys', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/app-keys', { json: { user_id: DIFF_USER_ID } })));
  same(...(await hx.both('POST', '/api/v1/app-keys', {
    json: { user_id: DIFF_USER_ID, application_id: 'differential', name: 'x', scopes: [] },
  })));
});

/**
 * Create a `differential-tmp` key on each backend and delete it by its own returned id on the SAME
 * backend that created it (PHP first).
 *
 * AppKeyRepository::revoke() (AppKeyRepository.php:139-146) is a soft delete -- it only sets
 * `revoked_at` -- and `listAll()` never filters on `revoked_at`, so a destroyed key stays visible
 * in `GET /app-keys` forever. A literal before/after equality is impossible through the public API
 * on either backend (PHP's real behaviour, ported as-is). Instead: API-level parity -- the new row
 * appears in "after" with `revoked_at` set, every pre-existing row is untouched -- then the created
 * rows are hard-deleted via direct SQL so user 3's DB is left as found.
 */
dtest.write('test_app_keys_create_destroy_round_trip', async (hx) => {
  const h = hx.h;
  const body = { user_id: DIFF_USER_ID, application_id: 'differential', name: 'differential-tmp', scopes: ['agents:run:1'] };
  const createdIds: number[] = [];
  try {
    for (const c of [hx.php, hx.ts]) { // PHP first
      const before = (await c.get('/api/v1/app-keys', { headers: h })).json();
      assert.equal(before.success, true, JSON.stringify(before));

      const created = await c.post('/api/v1/app-keys', { json: body, headers: h });
      assert.equal(created.status, 201, created.text);
      const cj = created.json();
      assert.equal(cj.success, true);
      assert.equal(cj.data.name, 'differential-tmp');
      assert.ok(String(cj.data.full_key).startsWith('ak_'));
      const keyId = cj.data.id;
      createdIds.push(keyId);

      const deleted = await c.delete(`/api/v1/app-keys/${keyId}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepStrictEqual(deleted.json(), { success: true, data: { id: keyId, revoked: true } });

      const after = (await c.get('/api/v1/app-keys', { headers: h })).json();
      const beforeById = new Map<any, any>(before.data.map((r: any) => [r.id, r]));
      const afterById = new Map<any, any>(after.data.map((r: any) => [r.id, r]));
      for (const [rid, row] of beforeById) {
        assert.ok(afterById.has(rid));
        assert.deepStrictEqual(afterById.get(rid), row); // every pre-existing row is identical
      }
      const newRow = afterById.get(keyId);
      assert.equal(newRow.name, 'differential-tmp');
      assert.equal(newRow.application_id, 'differential');
      assert.equal(newRow.user_id, DIFF_USER_ID);
      assert.notEqual(newRow.revoked_at, null);
    }
  } finally {
    if (createdIds.length) {
      await hx.primaryDb.execute(`DELETE FROM app_keys WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds);
    }
  }
});
