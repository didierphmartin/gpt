/**
 * PHP-vs-TS differential: FileStorageController + VoiceController + DriveController — twin of
 * backend_python/tests/differential/test_storage_voice_drive.py.
 *
 * PHP is hit first in every case so any PHP on-demand DDL/normalization lands before the TS request.
 *
 * Storage reads are read-only: no fixture files are created/deleted — cases compare the live
 * filesystem/DB state as-is, including not-found parity. `POST /voice/usage` cases are
 * validation-only (fail before the INSERT, so no rows are written). `POST /voice/token`'s happy
 * path makes a REAL, billed call to xAI and returns a different opaque secret every time — it is
 * skipped by default and only runs with DIFF_VOICE_TOKEN=1, comparing success/shape only.
 * `POST /drive/save` is a placeholder on both backends (returns "not yet implemented", no write).
 *
 * No case in this file writes data.
 */
import { dtest, DIFF_USER_ID, same, assert } from './harness';

// ─── storage ──────────────────────────────────────────────────────────────

/**
 * KNOWN DIVERGENCE, pinned: PHP's getProviders() calls an undefined method (getUniversalFSClient)
 * and always 500s live. The Python port reproduces the 500; the TS FileStorageController instead
 * implements the documented client-unavailable fallback (the local-only provider list). So while
 * PHP 500s, TS must answer that fallback; once PHP is fixed the case falls back to exact parity.
 */
dtest('test_storage_providers_parity', async (hx) => {
  const [a, b] = await hx.both('GET', '/api/v1/storage/providers');
  if (a.status === 500) {
    assert.equal(b.status, 200, b.text);
    assert.deepStrictEqual(b.json(), {
      success: true,
      providers: [{ id: 'local', name: 'Local Storage', icon: 'folder', connected: true }],
    });
  } else {
    same(a, b);
  }
});

dtest('test_storage_list_parity', async (hx) => {
  // Read-only: user 3's live storage_provider is not 'local', so this deterministically returns the
  // "cloud storage not configured" message on both backends.
  same(...(await hx.both('GET', '/api/v1/storage/list')));
});

dtest('test_storage_read_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', `/api/v1/storage/read?fileId=does-not-exist-${DIFF_USER_ID}.txt`)));
});

dtest('test_storage_read_missing_file_id_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/storage/read')));
});

dtest('test_storage_unauthenticated_401_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/storage/list', { auth: false })));
});

// ─── voice ────────────────────────────────────────────────────────────────

dtest('test_voice_stats_week_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/voice/stats?period=week')));
});

dtest('test_voice_stats_default_period_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/voice/stats')));
});

dtest('test_voice_config_grok_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/voice/config?provider=grok')));
});

dtest('test_voice_config_gemini_parity', async (hx) => {
  // JWT auth -> mayReadKey true on both sides, so the gemini api_key field is present and must match.
  same(...(await hx.both('GET', '/api/v1/voice/config?provider=gemini')));
});

dtest('test_voice_config_unknown_provider_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/voice/config?provider=bogus')));
});

/** Validation failures only — they return before UsageLogger.logTransaction(), so no row is written. */
dtest('test_voice_usage_validation_parity_no_rows', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/voice/usage', { json: { provider: 'not-a-real-provider' } })));
  same(...(await hx.both('POST', '/api/v1/voice/usage', { json: { provider: 'grok' } }))); // missing audio seconds
  same(...(await hx.both('POST', '/api/v1/voice/usage', { json: { provider: 'grok', audio_input_seconds: 0, audio_output_seconds: 0 } })));
});

dtest('test_voice_usage_unauthenticated_401_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/voice/usage', { json: { provider: 'grok' }, auth: false })));
});

/** No network call: rejected before generateGrokEphemeralToken() runs. */
dtest('test_voice_token_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/voice/token', { json: { provider: 'openai' } })));
  same(...(await hx.both('POST', '/api/v1/voice/token', { json: { provider: 'some-other-provider' } })));
});

/** Both sides must succeed with the same shape; the secret/expiry values are per-call. */
dtest('test_voice_token_grok_live_shape_parity', async (hx) => {
  const a = await hx.php.post('/api/v1/voice/token', { json: { provider: 'grok' }, headers: hx.h });
  const b = await hx.ts.post('/api/v1/voice/token', { json: { provider: 'grok' }, headers: hx.h });
  assert.ok(a.status === 200 && b.status === 200, `${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();
  assert.equal(ja.success, true);
  assert.equal(jb.success, true);
  assert.ok(ja.provider === 'grok' && jb.provider === 'grok');
  assert.ok(typeof ja.client_secret === 'string' && typeof jb.client_secret === 'string');
  assert.ok(ja.client_secret && jb.client_secret);
  assert.deepStrictEqual(jb.voice, ja.voice);
}, process.env.DIFF_VOICE_TOKEN === '1' ? {} : {
  skip: 'POST /voice/token (grok, happy path) makes a real billed call to xAI and returns a fresh opaque secret every time; set DIFF_VOICE_TOKEN=1 to run it.',
});

// ─── drive ────────────────────────────────────────────────────────────────

dtest('test_drive_save_exact_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/drive/save', { json: { prompt: 'p', response: 'r', provider: 'grok' } })));
});

dtest('test_drive_save_unauthenticated_401_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/drive/save', { json: {}, auth: false })));
});
