import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { decisionHandler, decisionTables, DecisionTables } from './support/decisionDb';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { config } from '../src/config/env';
import { SettingsController } from '../src/Controllers/SettingsController';
import { AdminController } from '../src/Controllers/AdminController';
import { phpAssoc } from '../src/Support/PhpJson';

/**
 * The settings and admin answers built from keyed PHP arrays: PHP's json_encode writes an EMPTY one as
 * `[]` and a filled one as an object, so the TypeScript port must too (GET /api/v1/settings/keys,
 * /settings/usage, /settings/providers, /admin/users/:id/providers, /admin/users/:id/keys).
 */

let t: DecisionTables;
let keyRows: any[] = [];
let modelRows: any[] = [];
let providerRows: any[] = [];

function ctx(userId: number, params: Record<string, string> = {}): any {
  return { method: 'GET', uri: '/', headers: {}, query: {}, body: {}, user_id: userId, auth_type: 'jwt', params, remote_addr: '' };
}

beforeEach(() => {
  keyRows = [];
  modelRows = [];
  providerRows = [];
  t = decisionTables({ users: { 1: 'admin', 2: 'user' }, settings: [] });
  installFakeDb(
    decisionHandler(t, (sql) => {
      if (sql.includes('FROM user_api_keys WHERE user_id')) return keyRows;
      if (sql.includes('FROM user_model_selections')) return modelRows;
      if (sql.includes('FROM user_provider_settings')) return providerRows;
      if (sql === 'SELECT provider_key FROM system_llm_settings') return t.settings.map((r) => ({ provider_key: r.provider_key }));
      return [];
    })
  );
});

test('phpAssoc: an empty map is [], a filled one stays as it is', () => {
  assert.deepEqual(phpAssoc({}), []);
  const m = { claude: 'x' };
  assert.equal(phpAssoc(m), m);
});

test('/settings/keys with nothing stored answers every map as PHP\'s empty array', async () => {
  const out: any = await new SettingsController().getKeys(ctx(2));
  for (const f of ['keys', 'models', 'package_models', 'locked', 'system_prompts', 'endpoints', 'rates']) {
    assert.deepEqual(out[f], [], f);
  }
  assert.equal(
    JSON.stringify(out),
    '{"success":true,"keys":[],"models":[],"package_models":[],"locked":[],"system_prompts":[],"endpoints":[],"rates":[],"decision_providers":[]}'
  );
});

test('/settings/keys with stored values answers each map as an object', async () => {
  keyRows = [{ provider: 'claude', api_key: ApiKeyCrypto.encrypt('sk-abcd1234', config.auth.jwtSecret), system_prompt: 'Be brief',
    base_url: 'https://gw.example/claude', created_at: null, updated_at: '2026-10-01 10:00:00' }];
  modelRows = [{ provider: 'claude', model: 'claude-sonnet-4-5' }];
  t.packages.user = { providers: { openai: { enabled: true, default_model: 'gpt-5' } } };
  const out: any = await new SettingsController().getKeys(ctx(2));
  assert.deepEqual(out.keys, { claude: { has_custom_key: true, masked_key: '****1234', updated_at: '2026-10-01 10:00:00' } });
  assert.deepEqual(out.models, { claude: 'claude-sonnet-4-5' });
  assert.deepEqual(out.system_prompts, { claude: 'Be brief' });
  assert.deepEqual(out.endpoints, { claude: 'https://gw.example/claude' });
  assert.deepEqual(out.package_models, { openai: 'gpt-5' });
  assert.deepEqual(out.locked, { openai: true });
});

test('/settings/usage with no balance row answers by_provider as PHP\'s empty array', async () => {
  const u: any = (await new SettingsController().getUsage(ctx(2))).usage;
  assert.deepEqual(u.by_provider, []);
});

test('/settings/providers: no provider is [], a stored {} settings is [] too', async () => {
  const empty: any = await new SettingsController().getProviderSettings(ctx(2));
  assert.equal(JSON.stringify(empty.avatar), '{"active":null,"enabled":true,"providers":[]}');
  assert.equal(JSON.stringify(empty.voice), '{"active":null,"enabled":true,"providers":[]}');

  providerRows = [
    { category: 'voice', provider: 'elevenlabs', api_key: 'k', settings: '{}', is_active: 1, enabled: 1 },
    { category: 'voice', provider: 'openai', api_key: '', settings: '{"voice":"alloy"}', is_active: 0, enabled: 0 },
    { category: 'music', provider: 'suno', api_key: 'k', settings: null, is_active: 1, enabled: 1 },
  ];
  const out: any = await new SettingsController().getProviderSettings(ctx(2));
  assert.deepEqual(out.voice, {
    active: 'elevenlabs', enabled: true,
    providers: { elevenlabs: { has_key: true, settings: [], enabled: true }, openai: { has_key: false, settings: { voice: 'alloy' }, enabled: false } },
  });
  assert.deepEqual(out.avatar.providers, []);
  assert.deepEqual(Object.keys(out), ['success', 'avatar', 'voice', 'status_code'], 'another category is not answered');
});

test('/admin/users/:id/providers: no provider is [], a stored {} settings is [] too', async () => {
  const admin = new AdminController();
  const empty: any = await admin.getProviderSettings(ctx(1, { id: '2' }));
  assert.equal(JSON.stringify(empty.avatar.providers), '[]');
  assert.equal(JSON.stringify(empty.voice.providers), '[]');

  providerRows = [{ category: 'avatar', provider: 'heygen', api_key: 'k', settings: '{}', is_active: 1, enabled: 1 }];
  const out: any = await admin.getProviderSettings(ctx(1, { id: '2' }));
  assert.deepEqual(out.avatar.providers, { heygen: { has_key: true, api_key: 'k', settings: [], enabled: true } });
  assert.equal(out.avatar.active, 'heygen');
});

test('/admin/users/:id/keys with no configured provider and no row answers keys as []', async () => {
  const out: any = await new AdminController().getApiKeys(ctx(1, { id: '2' }));
  assert.equal(JSON.stringify(out.keys), '[]');
});
