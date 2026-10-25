import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { chatHandler, chatTables, settingsRow, ChatTables } from './support/chatDb';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { UserProviderOverlay } from '../src/Services/UserProviderOverlay';

/**
 * ChatController::applyPackageDefaults + ::applyUserApiKeys, applied on top of the
 * system_llm_settings row: package key/model, then the user's own key (with their own entry
 * point), system prompt and model choice — the model only on their own key.
 */

const SECRET = 'overlay-test-secret';
let t: ChatTables;

beforeEach(() => {
  t = chatTables({
    settings: [settingsRow('openai'), settingsRow('claude')],
    users: { 7: { role: 'user' } },
  });
  installFakeDb(chatHandler(t));
});

const resolve = (provider = 'openai', userId: number | null = 7) => UserProviderOverlay.resolve(provider, userId, SECRET);
const ownKey = (provider: string, key: string, extra: Record<string, any> = {}) =>
  t.userKeys.push({ user_id: 7, provider, api_key: ApiKeyCrypto.encrypt(key, SECRET), system_prompt: null, base_url: null, chat_endpoint: null, ...extra });

test('without overrides the system row stands', async () => {
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sys-openai');
  assert.equal(cfg?.model, 'openai-model');
  assert.equal(cfg?.base_url, 'https://api.openai.test');
  assert.equal(cfg?.system_prompt, 'admin persona');
});

test('an unavailable provider resolves to null', async () => {
  assert.equal(await resolve('nope'), null);
});

test('the package default key and model apply when the package enables the provider', async () => {
  t.packages.user = { providers: { openai: { enabled: true, default_api_key: ' pkg-key ', default_model: 'pkg-model' } } };
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'pkg-key');
  assert.equal(cfg?.model, 'pkg-model');
});

test('a package entry that is not enabled, or blank, changes nothing', async () => {
  t.packages.user = { providers: { openai: { enabled: 0, default_api_key: 'pkg-key' }, claude: { enabled: 1, default_api_key: '  ' } } };
  assert.equal((await resolve())?.api_key, 'sys-openai');
  assert.equal((await resolve('claude'))?.api_key, 'sys-claude');
});

test('the user own key replaces the key and carries the user entry point', async () => {
  ownKey('openai', 'sk-user', { base_url: 'https://gateway.example/', chat_endpoint: '/v2/chat' });
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sk-user');
  assert.equal(cfg?.base_url, 'https://gateway.example');
  assert.equal(cfg?.chat_endpoint, '/v2/chat');
});

test('a key stored in the clear (gpt_admin) is used as is', async () => {
  t.userKeys.push({ user_id: 7, provider: 'openai', api_key: 'sk-clear', base_url: null });
  assert.equal((await resolve())?.api_key, 'sk-clear');
});

test('an entry point without a usable key is ignored, so the system key never goes there', async () => {
  t.userKeys.push({ user_id: 7, provider: 'openai', api_key: '', base_url: 'https://evil.example', chat_endpoint: '/x' });
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sys-openai');
  assert.equal(cfg?.base_url, 'https://api.openai.test');
  assert.equal(cfg?.chat_endpoint, '/v1/chat');
});

test('a disabled override row is skipped', async () => {
  ownKey('openai', 'sk-user', { enabled: 0, system_prompt: 'mine' });
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sys-openai');
  assert.equal(cfg?.system_prompt, 'admin persona');
});

test('the system prompt override applies without a key of their own', async () => {
  t.userKeys.push({ user_id: 7, provider: 'openai', api_key: '', system_prompt: 'my persona' });
  assert.equal((await resolve())?.system_prompt, 'my persona');
});

test('a blank system prompt override is ignored', async () => {
  t.userKeys.push({ user_id: 7, provider: 'openai', api_key: '', system_prompt: '   ' });
  assert.equal((await resolve())?.system_prompt, 'admin persona');
});

test('the user model applies on their own key and is locked on the package key', async () => {
  t.packages.user = { providers: { openai: { enabled: true, default_model: 'pkg-model' }, claude: { enabled: true, default_model: 'pkg-claude' } } };
  t.models.push({ user_id: 7, provider: 'openai', model: 'user-openai' }, { user_id: 7, provider: 'claude', model: 'user-claude' });
  ownKey('openai', 'sk-user');
  assert.equal((await resolve())?.model, 'user-openai');
  assert.equal((await resolve('claude'))?.model, 'pkg-claude');
});

test('rows for other providers leave this one alone', async () => {
  ownKey('claude', 'sk-claude', { system_prompt: 'claude persona' });
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sys-openai');
  assert.equal(cfg?.system_prompt, 'admin persona');
});

test('a guest never reads user_api_keys', async () => {
  await resolve('openai', null);
  assert.ok(!queries.some((q) => q.sql.includes('user_api_keys')));
});

test('an install without user_api_keys keeps the config', async () => {
  t.missing.push('user_api_keys');
  ownKey('openai', 'sk-user');
  assert.equal((await resolve())?.api_key, 'sys-openai');
});

test('an install without user_model_selections still applies the key', async () => {
  t.missing.push('user_model_selections');
  ownKey('openai', 'sk-user');
  t.models.push({ user_id: 7, provider: 'openai', model: 'user-openai' });
  const cfg = await resolve();
  assert.equal(cfg?.api_key, 'sk-user');
  assert.equal(cfg?.model, 'openai-model');
});
