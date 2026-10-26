import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { config } from '../src/config/env';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { VoiceController } from '../src/Controllers/VoiceController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/GeminiVoiceTokenTest.php: the Gemini voice key is found
 * like every other key (user, package, admin, server) and never reaches the browser.
 */

const SECRET = 'test-secret-0123456789-0123456789';
let d: DatabaseSync;
let sent: { url: string; headers: Record<string, string>; body: any }[];
let replies: Response[];
const originalFetch = globalThis.fetch;

function pkg(role: string, providers: Record<string, unknown>): void {
  d.prepare('INSERT OR REPLACE INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)')
    .run(role, role, JSON.stringify({ providers }));
}

beforeEach(() => {
  d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)');
  d.exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
  d.exec('CREATE TABLE user_api_keys (id INTEGER PRIMARY KEY, user_id INTEGER, provider TEXT, api_key TEXT, base_url TEXT, enabled INTEGER DEFAULT 1)');
  d.exec('CREATE TABLE system_llm_settings (provider_key TEXT, api_key TEXT, enabled INTEGER)');
  d.exec("INSERT INTO users VALUES (1, 'u@x.test', 'user'), (2, 'n@x.test', 'nogemini')");
  pkg('user', { gemini: { enabled: true } });
  pkg('nogemini', { claude: { enabled: true } });
  installFakeDb((sqlText, params) => {
    const st = d.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) {
      const rows = st.all(...ps) as any[];
      // mysql2 returns the packages.capabilities json column already parsed.
      return /FROM packages/.test(sqlText) ? rows.map((r) => ('capabilities' in r ? { ...r, capabilities: JSON.parse(r.capabilities) } : r)) : rows;
    }
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid), numAffectedRows: Number(r.changes) };
  });
  sent = [];
  replies = [];
  globalThis.fetch = (async (url: any, opts: any) => {
    sent.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return replies.shift() ?? new Response('', { status: 500 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function voice(envKey = ''): VoiceController {
  return new VoiceController({ ...config, auth: { ...config.auth, jwtSecret: SECRET }, gemini_voice: { ...config.gemini_voice, api_key: envKey } });
}

function ctx(userId: number | null, o: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {}): Ctx {
  return { method: 'GET', uri: '/', headers: {}, query: o.query ?? {}, body: o.body ?? {}, user_id: userId, auth_type: userId ? 'jwt' : null, params: {}, remote_addr: '127.0.0.1' } as any;
}

const tokenReply = () => new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 });
const gemini = { query: { provider: 'gemini' } };
const geminiBody = { body: { provider: 'gemini' } };

test('config says whether a key exists and never gives it', async () => {
  const r: any = await voice('env-key').getConfig(ctx(1, gemini));
  assert.equal(r.config.available, true);
  assert.ok(!JSON.stringify(r).includes('env-key'));
  assert.ok(!('api_key' in r.config));
  assert.equal(r.config.supports_ephemeral_token, true);

  assert.equal(((await voice().getConfig(ctx(1, gemini))) as any).config.available, false);
  assert.equal(((await voice('env-key').getConfig(ctx(null, gemini))) as any).config.available, false);
});

test('a package without gemini has no voice key', async () => {
  assert.equal(((await voice('env-key').getConfig(ctx(2, gemini))) as any).config.available, false);
  const r: any = await voice('env-key').getEphemeralToken(ctx(2, geminiBody));
  assert.equal(r.code, 'NO_GEMINI_KEY');
  assert.equal(r.status_code, 404);
  assert.equal(r.error, 'No Gemini key for voice');
  assert.equal(sent.length, 0);
});

test('the token is minted with the user\'s own key, in a header', async () => {
  d.exec("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)");
  d.prepare("INSERT INTO user_api_keys (user_id, provider, api_key) VALUES (1, 'gemini', ?)").run(ApiKeyCrypto.encrypt('own-key', SECRET));
  replies.push(tokenReply());

  const r: any = await voice('env-key').getEphemeralToken(ctx(1, geminiBody));

  assert.equal(r.success, true);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.client_secret, 'auth_tokens/abc');
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
  assert.equal(sent[0].headers['x-goog-api-key'], 'own-key');
  assert.ok(!new URL(sent[0].url).search.includes('key'));
  assert.equal(sent[0].body.uses, 1);
  assert.match(sent[0].body.expireTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('package key, then admin key, then server key', async () => {
  pkg('user', { gemini: { enabled: true, default_api_key: 'pkg-key' } });
  d.exec("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)");
  replies.push(tokenReply(), tokenReply(), tokenReply());
  await voice('env-key').getEphemeralToken(ctx(1, geminiBody));
  assert.equal(sent[0].headers['x-goog-api-key'], 'pkg-key');

  pkg('user', { gemini: { enabled: true } });
  await voice('env-key').getEphemeralToken(ctx(1, geminiBody));
  assert.equal(sent[1].headers['x-goog-api-key'], 'admin-key');

  d.exec('DELETE FROM system_llm_settings');
  await voice('env-key').getEphemeralToken(ctx(1, geminiBody));
  assert.equal(sent[2].headers['x-goog-api-key'], 'env-key');
});

test('signed out gets no token', async () => {
  const r: any = await voice('env-key').getEphemeralToken(ctx(null, geminiBody));
  assert.equal(r.status_code, 401);
  assert.equal(r.error, 'Authentication required');
  assert.equal(sent.length, 0);
});

test('a Google refusal never echoes the key', async () => {
  replies.push(new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }));
  const r: any = await voice('env-key').getEphemeralToken(ctx(1, geminiBody));
  assert.equal(r.success, false);
  assert.equal(r.status_code, 400);
  assert.equal(r.error, 'Failed to obtain ephemeral token: API key not valid');
  assert.ok(!JSON.stringify(r).includes('env-key'));
});

test('an unknown voice provider is refused', async () => {
  const r: any = await voice().getEphemeralToken(ctx(1, { body: { provider: 'hume' } }));
  assert.equal(r.status_code, 400);
  assert.equal(r.error, 'Unknown voice provider');
});

test('grok config says whether the server has a grok key', async () => {
  const r: any = await new VoiceController({ ...config, grok_voice: { ...config.grok_voice, api_key: ' ' } }).getConfig(ctx(1));
  assert.equal(r.config.available, false);
  assert.ok(!('api_key' in r.config));
});
