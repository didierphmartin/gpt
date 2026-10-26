import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { decisionHandler, decisionTables, routerRow, DecisionTables } from './support/decisionDb';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { config } from '../src/config/env';
import { SettingsController } from '../src/Controllers/SettingsController';
import { PackageController } from '../src/Controllers/PackageController';
import { AdminController } from '../src/Controllers/AdminController';

/**
 * Twins of backend/tests/Unit/SettingsUsageJevRateTest.php, Controllers/PackageControllerMeTest.php
 * and the Settings/Admin halves of JevKeyStorageTest.php: what /me/package, /settings/usage,
 * /settings/keys and the admin per-user keys say about decision providers.
 */

let t: DecisionTables;
let balances: any[] = [];

function ctx(userId: number, body: Record<string, any> = {}, params: Record<string, string> = {}): any {
  return { method: 'GET', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: 'jwt', params, remote_addr: '' };
}

beforeEach(() => {
  balances = [];
  t = decisionTables({
    users: { 1: 'admin', 2: 'user' },
    settings: [
      { provider_key: 'claude', api_format: 'anthropic', enabled: 1, sort_order: 0 },
      routerRow('jev', '', { sort_order: 100, model: '' }),
      routerRow('acme', '', { sort_order: 50, display_name: 'Acme', model: 'acme-1', base_url: 'https://gw.corp/acme' }),
      routerRow('hidden', '', { sort_order: 60 }),
    ],
    prices: { jev: [0.042, 0] },
  });
  t.packages.user = { providers: { jev: { enabled: true }, acme: { enabled: true } } };
  installFakeDb(
    decisionHandler(t, (sql) => {
      if (sql === 'SELECT provider_key FROM system_llm_settings') return t.settings.map((r) => ({ provider_key: r.provider_key }));
      if (sql.includes('FROM llm_usage_balance')) return balances;
      return [];
    })
  );
});

test('rateOf and routerRates: a priced row gives numbers, an unpriced one null', async () => {
  assert.deepEqual(await SettingsController.rateOf('jev'), { input: 0.042, output: 0 });
  assert.equal(await SettingsController.rateOf('acme'), null);
  assert.deepEqual(await SettingsController.routerRates(['jev', 'acme']), { jev: { input: 0.042, output: 0 }, acme: null });
});

test('quotaTokensUsed leaves every decision provider out', () => {
  const rows = [
    { provider: 'claude', total_tokens: '1200' },
    { provider: 'jev', total_tokens: '90000' },
    { provider: 'acme', total_tokens: 70000 },
    { provider: 'kimi', total_tokens: 300 },
  ];
  assert.equal(SettingsController.quotaTokensUsed(rows, ['jev', 'acme']), 1500);
  assert.equal(SettingsController.quotaTokensUsed([{ provider: 'jev', total_tokens: 5 }], ['jev', 'acme']), 0);
  assert.equal(SettingsController.quotaTokensUsed([], ['jev']), 0);
});

test('/settings/usage reports rates, quota_tokens_used and the allowed decision providers', async () => {
  balances = [
    { provider: 'claude', month_requests: 1, month_tokens: 10, month_cost_usd: '0.00', total_requests: 1, total_tokens: 1200,
      total_cost_usd: '0.00', monthly_budget_usd: '500.00', monthly_request_limit: 10 },
    { provider: 'jev', month_requests: 1, month_tokens: 5, month_cost_usd: '0.00', total_requests: 1, total_tokens: 90000,
      total_cost_usd: '0.00', monthly_budget_usd: '500.00', monthly_request_limit: 10 },
  ];
  const out: any = await new SettingsController().getUsage(ctx(2));
  const u = out.usage;
  assert.deepEqual(u.rates, { acme: null, hidden: null, jev: { input: 0.042, output: 0 } });
  assert.equal(u.quota_tokens_used, 1200);
  assert.deepEqual(u.decision_providers.map((d: any) => d.key), ['acme', 'jev']);
  assert.equal(u.decision_providers[0].default_url, 'https://gw.corp/acme');
  assert.deepEqual(u.decision_providers[1].rate, { input: 0.042, output: 0 });
  assert.deepEqual(Object.keys(u), [
    'current_month', 'by_provider', 'rates', 'totals', 'lifetime', 'quota_tokens_used', 'plan', 'role', 'free_trial_quota', 'decision_providers',
  ]);
  // PHP json_encode(500.0) / (float) '0.00': no fraction on the wire.
  assert.match(JSON.stringify(u.by_provider.claude), /"month_cost_usd":0,.*"budget_limit":500,/);
});

test('/settings/usage with no decision rows encodes rates as PHP\'s empty array', async () => {
  t.settings = t.settings.filter((r) => r.api_format !== 'router');
  const u: any = (await new SettingsController().getUsage(ctx(2))).usage;
  assert.deepEqual(u.rates, []);
  assert.deepEqual(u.decision_providers, []);
});

test('/settings/keys lists the rates and the allowed decision providers with their rate', async () => {
  const out: any = await new SettingsController().getKeys(ctx(2));
  assert.deepEqual(out.rates, { acme: null, hidden: null, jev: { input: 0.042, output: 0 } });
  assert.deepEqual(out.decision_providers.map((d: any) => [d.key, d.rate]), [['acme', null], ['jev', { input: 0.042, output: 0 }]]);
});

test('POST /settings/keys stores a decision key and endpoint, never a model or prompt', async () => {
  const out: any = await new SettingsController().saveKeys(
    ctx(2, {
      keys: { acme: 'acme-mine' },
      models: { acme: 'm' },
      system_prompts: { acme: 'p' },
      endpoints: { acme: 'https://mine.example/acme' },
    })
  );
  assert.deepEqual([out.saved_count, out.model_count, out.prompt_count, out.endpoint_count], [1, 0, 0, 1]);
  const writes = queries.filter((q) => q.sql.includes('INSERT INTO user_api_keys'));
  assert.equal(writes.length, 2);
  assert.equal(ApiKeyCrypto.decrypt(String(writes[0].parameters[2]), config.auth.jwtSecret), 'acme-mine');
  assert.equal(writes[1].parameters[2], 'https://mine.example/acme');
});

test('/me/package never returns a package default key', async () => {
  t.packages.user = {
    providers: {
      claude: { enabled: true, default_model: 'claude-sonnet-4-5', default_api_key: 'sk-claude-pkg' },
      jev: { enabled: true, default_model: null, default_api_key: 'jev-pkg-key' },
      kimi: { enabled: false, default_model: 'kimi-k2', default_api_key: null },
    },
    quota_tokens: 1000,
  };
  const out: any = await new PackageController().me(ctx(2));
  const wire = JSON.stringify(out);
  assert.equal(out.success, true);
  for (const s of ['default_api_key', 'jev-pkg-key', 'sk-claude-pkg']) assert.ok(!wire.includes(s), s);
  assert.deepEqual(out.capabilities.providers, {
    claude: { enabled: true, default_model: 'claude-sonnet-4-5' },
    jev: { enabled: true, default_model: null },
    kimi: { enabled: false, default_model: 'kimi-k2' },
  });
  assert.equal(out.capabilities.quota_tokens, 1000);
  assert.ok(JSON.stringify(t.packages.user).includes('jev-pkg-key'), 'the stored package is not mutated');
});

test('withoutProviderKeys leaves capabilities without a providers map alone', () => {
  assert.deepEqual(PackageController.withoutProviderKeys({ sidebar: [] }), { sidebar: [] });
  assert.deepEqual(PackageController.withoutProviderKeys({ providers: [{ default_api_key: 'x', a: 1 }] }), { providers: [{ a: 1 }] });
});

test('admin per-user keys list and accept every configured row, chat or decision', async () => {
  t.settings.push({ provider_key: 'glm', api_format: 'openai', enabled: 1, sort_order: 5 });
  const admin = new AdminController();
  const before: any = await admin.getApiKeys(ctx(1, {}, { id: '2' }));
  assert.deepEqual(Object.keys(before.keys), ['claude', 'jev', 'acme', 'hidden', 'glm']);
  assert.equal(before.keys.acme.masked_key, null);

  installFakeDb(decisionHandler(t, (sql) => (sql === 'SELECT provider_key FROM system_llm_settings' ? t.settings.map((r) => ({ provider_key: r.provider_key })) : [])));
  const saved: any = await admin.saveApiKeys(
    ctx(1, { user_id: 2, keys: { acme: { api_key: 'k-acme', model: 'm', base_url: 'https://gw/acme', enabled: true }, glm: 'k-glm', kimi: 'k-kimi' } })
  );
  assert.equal(saved.success, true);
  const writes = queries.filter((q) => q.sql.includes('INSERT INTO user_api_keys'));
  assert.deepEqual(writes.map((w) => w.parameters[1]), ['acme', 'glm'], 'kimi has no system_llm_settings row here');
  assert.match(writes[0].sql, /\(`user_id`, `provider`, `api_key`, `base_url`, `enabled`, `created_at`, `updated_at`\)/);
});
