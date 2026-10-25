/**
 * SettingsController PHP-vs-TS differential (live DB, no LLM calls) — twin of
 * backend_python/tests/differential/test_settings.py.
 *
 * Every case runs the PHP request first (so PHP's on-demand DDL lands before TS looks at the schema)
 * and leaves user 3's rows exactly as it found them.
 *
 * WRITES: test_heal_round_trip, test_genesis_round_trip, test_provider_settings_round_trip (each
 * writes the current values back), and test_keys_save_read_clear_across_backends[*] (saves a test
 * grok key, clears ALL of user 3's key/model rows, then restores the snapshot by direct SQL).
 * The reads may let PHP ALTER `users` to add the storage columns (PHP's own on-demand DDL), as in
 * the Python suite; they stay read cases.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dtest, DIFF_USER_ID, Harness, Client, same, assert } from './harness';

const SCRATCH = process.env.DIFF_SCRATCH ?? path.join(tmpdir(), 'gpt-differential-scratch');

const KEY_COLUMNS = 'user_id, provider, api_key, system_prompt, created_at, updated_at';
const MODEL_COLUMNS = 'user_id, provider, model, updated_at';

/**
 * Snapshot user 3's key/model rows and put them back byte-for-byte (Python `keys_snapshot`).
 *
 * `clearKeys` (SettingsController.php:414) has no provider filter — it wipes every `user_api_keys`
 * and `user_model_selections` row for the user — so the only way to exercise it against the live
 * user without data loss is an exact restore (which also re-writes created_at/updated_at, bypassing
 * the column's ON UPDATE CURRENT_TIMESTAMP). The snapshot is also written to DIFF_SCRATCH.
 */
async function keysSnapshot(hx: Harness): Promise<{ restore(): Promise<void> }> {
  const db = hx.primaryDb;
  const keys = await db.fetchAll(`SELECT ${KEY_COLUMNS} FROM user_api_keys WHERE user_id = ?`, [DIFF_USER_ID]);
  const models = await db.fetchAll(`SELECT ${MODEL_COLUMNS} FROM user_model_selections WHERE user_id = ?`, [DIFF_USER_ID]);
  assert.ok(keys.length, 'expected user 3 to have API-key rows to snapshot');

  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(path.join(SCRATCH, `user_api_keys_backup_${DIFF_USER_ID}.json`), JSON.stringify({ keys, models }, null, 2));

  return {
    async restore() {
      await db.execute('DELETE FROM user_api_keys WHERE user_id = ?', [DIFF_USER_ID]);
      for (const r of keys) {
        await db.execute(`INSERT INTO user_api_keys (${KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
          [r.user_id, r.provider, r.api_key, r.system_prompt, r.created_at, r.updated_at]);
      }
      await db.execute('DELETE FROM user_model_selections WHERE user_id = ?', [DIFF_USER_ID]);
      for (const r of models) {
        await db.execute(`INSERT INTO user_model_selections (${MODEL_COLUMNS}) VALUES (?, ?, ?, ?)`,
          [r.user_id, r.provider, r.model, r.updated_at]);
      }
    },
  };
}

// ─── reads ─────────────────────────────────────────────────────────────────

dtest('test_settings_reads_are_identical', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/settings/phone')));
  same(...(await hx.both('GET', '/api/v1/settings/usage')));
  same(...(await hx.both('GET', '/api/v1/settings/keys')));
  same(...(await hx.both('GET', '/api/v1/settings/providers')));
  same(...(await hx.both('GET', '/api/v1/settings/heal')));
  same(...(await hx.both('GET', '/api/v1/settings/genesis')));
  // PHP runs first and may ALTER `users` to add the storage columns.
  same(...(await hx.both('GET', '/api/v1/settings/storage')));
});

dtest('test_settings_require_auth', async (hx) => {
  for (const p of ['/api/v1/settings/keys', '/api/v1/settings/providers', '/api/v1/settings/heal',
    '/api/v1/settings/genesis', '/api/v1/settings/storage', '/api/v1/settings/phone', '/api/v1/settings/usage']) {
    same(...(await hx.both('GET', p, { auth: false })));
  }
});

// ─── validation (no writes) ────────────────────────────────────────────────

dtest('test_save_keys_validation', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/settings/keys', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/settings/keys', { json: { keys: {}, models: {}, system_prompts: {} } })));
  // Unknown provider / blank key are skipped, not rejected — counts must agree.
  same(...(await hx.both('POST', '/api/v1/settings/keys', { json: { keys: { 'not-a-provider': 'x', kimi: '   ' } } })));
});

dtest('test_provider_validation', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/settings/provider', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/settings/provider', { json: { category: 'nope', provider: 'did' } })));
  // 'deepseek' is an LLM provider, not an avatar/voice one — both categories reject it.
  same(...(await hx.both('POST', '/api/v1/settings/provider', { json: { category: 'voice', provider: 'deepseek' } })));
  same(...(await hx.both('POST', '/api/v1/settings/provider', { json: { category: 'avatar', provider: 'deepseek' } })));
  same(...(await hx.both('POST', '/api/v1/settings/provider/active', { json: { category: 'x', provider: 'grok' } })));
  same(...(await hx.both('POST', '/api/v1/settings/provider/active', { json: { category: 'voice' } })));
  same(...(await hx.both('POST', '/api/v1/settings/provider/active', { json: { category: 'avatar', provider: 'no-such-provider' } })));
  same(...(await hx.both('DELETE', '/api/v1/settings/provider', { json: { category: 'x', provider: 'grok' } })));
  same(...(await hx.both('DELETE', '/api/v1/settings/provider', { json: { category: 'voice', provider: '' } })));
});

dtest('test_storage_validation', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/settings/storage', { json: { provider: 'dropbox', folder: 'synergyAI' } })));
});

// ─── round-trips (current values written back) — WRITES ────────────────────

async function settingsRoundTrip(hx: Harness, p: string): Promise<void> {
  const { php, ts, h } = hx;
  const pre = (await php.get(p, { headers: h })).json();
  assert.deepStrictEqual((await ts.get(p, { headers: h })).json(), pre);
  for (const client of [php, ts]) {
    assert.deepStrictEqual((await client.post(p, { json: pre.settings, headers: h })).json(), pre);
    assert.deepStrictEqual((await php.get(p, { headers: h })).json(), pre);
    assert.deepStrictEqual((await ts.get(p, { headers: h })).json(), pre);
  }
}

dtest.write('test_heal_round_trip', (hx) => settingsRoundTrip(hx, '/api/v1/settings/heal'));

dtest.write('test_genesis_round_trip', (hx) => settingsRoundTrip(hx, '/api/v1/settings/genesis'));

/** `deepseek` is not an avatar/voice provider (rejected above); `voice`/`grok` is the configured row. */
dtest.write('test_provider_settings_round_trip', async (hx) => {
  const { php, ts, h } = hx;
  const pre = (await php.get('/api/v1/settings/providers', { headers: h })).json();
  assert.deepStrictEqual((await ts.get('/api/v1/settings/providers', { headers: h })).json(), pre);
  const current = pre.voice.providers.grok.settings;
  for (const client of [php, ts]) {
    const r = await client.post('/api/v1/settings/provider', { json: { category: 'voice', provider: 'grok', settings: current }, headers: h });
    assert.deepStrictEqual(r.json(), { success: true, message: "Provider 'grok' saved for voice" }, r.text);
    assert.deepStrictEqual((await php.get('/api/v1/settings/providers', { headers: h })).json(), pre);
    assert.deepStrictEqual((await ts.get('/api/v1/settings/providers', { headers: h })).json(), pre);
  }
});

dtest('test_storage_settings_read_is_stable', async (hx) => {
  const pre = (await hx.php.get('/api/v1/settings/storage', { headers: hx.h })).json();
  assert.deepStrictEqual((await hx.ts.get('/api/v1/settings/storage', { headers: hx.h })).json(), pre);
  assert.equal(pre.data.folder, 'synergyAI');
});

// ─── cross-backend encryption interop — WRITES ─────────────────────────────

async function assertPreState(php: Client, ts: Client, h: Record<string, string>, prePhp: any, preTs: any): Promise<void> {
  assert.deepStrictEqual((await php.get('/api/v1/settings/keys', { headers: h })).json(), prePhp);
  assert.deepStrictEqual((await ts.get('/api/v1/settings/keys', { headers: h })).json(), preTs);
}

/**
 * A key encrypted by one backend must decrypt on the other (same key derivation, IV layout and
 * base64 framing as SettingsController.php:841-863).
 */
for (const [writer, reader] of [['php', 'ts'], ['ts', 'php']] as const) {
  dtest.write(`test_keys_save_read_clear_across_backends[${writer}-${reader}]`, async (hx) => {
    const { php, ts, h } = hx;
    const clients = { php, ts };
    const w = clients[writer];
    const r = clients[reader];
    const snap = await keysSnapshot(hx);
    try {
      const prePhp = (await php.get('/api/v1/settings/keys', { headers: h })).json();
      const preTs = (await ts.get('/api/v1/settings/keys', { headers: h })).json();
      assert.deepStrictEqual(preTs, prePhp);

      const saved = (await w.post('/api/v1/settings/keys', { json: { keys: { grok: 'differential-test-key' } }, headers: h })).json();
      assert.equal(saved.saved_count, 1, JSON.stringify(saved));

      const seen = (await r.get('/api/v1/settings/keys', { headers: h })).json();
      assert.equal(seen.keys.grok.has_custom_key, true);
      assert.equal(seen.keys.grok.masked_key, '****-key');
      assert.deepStrictEqual((await w.get('/api/v1/settings/keys', { headers: h })).json(), seen);

      const cleared = (await r.request('DELETE', '/api/v1/settings/keys', { headers: h })).json();
      assert.ok(cleared.success === true && cleared.deleted_count > 0, JSON.stringify(cleared));
      // PHP json_encodes the now-empty key map as [], and so does the port.
      assert.deepStrictEqual((await php.get('/api/v1/settings/keys', { headers: h })).json().keys, []);
      assert.deepStrictEqual((await ts.get('/api/v1/settings/keys', { headers: h })).json().keys, []);
      assert.deepStrictEqual(
        (await ts.get('/api/v1/settings/keys', { headers: h })).json(),
        (await php.get('/api/v1/settings/keys', { headers: h })).json(),
      );

      await snap.restore();
      await assertPreState(php, ts, h, prePhp, preTs);
    } finally {
      await snap.restore();
    }
  });
}
