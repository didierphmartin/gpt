import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { decisionHandler, decisionTables, routerRow, DecisionTables } from './support/decisionDb';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { DecisionProviders } from '../src/Services/DecisionProviders';
import { DecisionKeyResolver } from '../src/Services/DecisionKeyResolver';
import { DecisionUsage } from '../src/Services/DecisionUsage';
import { JevRouter } from '../src/AgentTeam/JevRouter';

/**
 * Twins of backend/tests/Unit/DecisionKeyResolverTest.php and DecisionUsageTest.php. Decision
 * providers are router rows (api_format 'router') naming a registered protocol; several rows may
 * share a protocol (jev, jev-eu).
 */

const SECRET = 'decision-test-secret';
let t: DecisionTables;

beforeEach(() => {
  t = decisionTables({
    users: { 2: 'user' },
    settings: [{ provider_key: 'claude', display_name: 'Claude', api_key: 'sk-c', model: 'claude-x', api_format: 'anthropic', sort_order: 0, enabled: 1 }],
  });
  installFakeDb(decisionHandler(t));
});

const row = (key: string, apiKey = '', o: { protocol?: string | null; sort?: number; enabled?: number; url?: string | null; label?: string } = {}) =>
  t.settings.push(routerRow(key, apiKey, {
    protocol: o.protocol === undefined ? 'typesafe' : o.protocol, sort_order: o.sort ?? 100, enabled: o.enabled ?? 1,
    base_url: o.url ?? null, display_name: o.label || key.charAt(0).toUpperCase() + key.slice(1),
  }));
const allow = (entries: Record<string, any>) => (t.packages.user = { providers: entries });
const userKey = (provider: string, key: string, url: string | null = null) =>
  t.userKeys.push({ user_id: 2, provider, api_key: ApiKeyCrypto.encrypt(key, SECRET), base_url: url });
const resolve = (key: string) => DecisionKeyResolver.resolve(2, key, SECRET);

test('rows are router rows in admin order', async () => {
  row('jev', '', { sort: 100 });
  row('acme', '', { sort: 50 });
  row('off', '', { enabled: 0, sort: 10 });
  assert.deepEqual((await DecisionProviders.rows()).map((r) => r.provider_key), ['acme', 'jev']);
  assert.deepEqual(await DecisionProviders.keys(), ['off', 'acme', 'jev']);
});

test('row finds an enabled row only', async () => {
  row('jev');
  row('off', '', { enabled: 0 });
  assert.equal((await DecisionProviders.row('jev'))?.provider_key, 'jev');
  assert.equal(await DecisionProviders.row('off'), null);
  assert.equal(await DecisionProviders.row('claude'), null, 'a chat row is never a decision provider');
});

test('envStem sanitises', () => {
  assert.equal(DecisionProviders.envStem('jev'), 'JEV');
  assert.equal(DecisionProviders.envStem('jev-eu'), 'JEV_EU');
  assert.equal(DecisionProviders.envStem('acme.v2'), 'ACME_V2');
});

test('an install without the table reads no rows', async () => {
  installFakeDb(() => {
    throw new Error("Table 'system_llm_settings' doesn't exist");
  });
  assert.deepEqual(await DecisionProviders.rows(), []);
});

test('each provider resolves its own key', async () => {
  row('jev', 'jev-global');
  row('acme', 'acme-global');
  allow({ jev: { enabled: true }, acme: { enabled: true } });
  assert.equal((await resolve('jev')).key, 'jev-global');
  assert.equal((await resolve('acme')).key, 'acme-global');
});

test('precedence is user, then package, then global', async () => {
  row('acme', 'acme-global');
  allow({ acme: { enabled: true, default_api_key: 'acme-package' } });
  const p = await resolve('acme');
  assert.deepEqual([p.key, p.source], ['acme-package', 'package']);
  userKey('acme', 'acme-mine');
  const u = await resolve('acme');
  assert.deepEqual([u.key, u.source], ['acme-mine', 'user']);
});

test('the URL is the paired one', async () => {
  row('acme', 'acme-global', { url: 'https://gw.corp/acme' });
  allow({ acme: { enabled: true } });
  assert.equal((await resolve('acme')).url, 'https://gw.corp/acme');
  // The user's URL goes with the user's own key only.
  userKey('acme', 'acme-mine', 'https://mine.example/acme');
  assert.equal((await resolve('acme')).url, 'https://mine.example/acme');
  t.userKeys[0].api_key = '';
  assert.equal((await resolve('acme')).url, 'https://gw.corp/acme');
});

test('no row URL is the protocol default', async () => {
  row('jev', 'k');
  allow({ jev: { enabled: true } });
  assert.equal((await resolve('jev')).url, JevRouter.URL);
});

test('a row without protocol is unknown', async () => {
  row('jev', 'k', { protocol: null });
  allow({ jev: { enabled: true } });
  const r = await resolve('jev');
  assert.equal(r.source, 'unknown');
  assert.equal(r.key, '');
  assert.equal(DecisionKeyResolver.unavailableReason(r, 'jev'), "'jev' is not an available decision provider");
});

test('a deleted or disabled provider is unknown', async () => {
  row('off', 'k', { enabled: 0 });
  allow({ off: { enabled: true } });
  assert.equal((await resolve('off')).source, 'unknown');
  assert.equal((await resolve('gone')).source, 'unknown');
});

test('the plan decides per provider', async () => {
  row('jev', 'k1');
  row('acme', 'k2', { label: 'Acme Router' });
  allow({ jev: { enabled: true } }); // acme missing from the allowlist
  const r = await resolve('acme');
  assert.equal(r.source, 'not_allowed');
  assert.equal(DecisionKeyResolver.unavailableReason(r, 'acme'), 'Acme Router is not enabled for your plan');
  assert.equal((await resolve('jev')).row?.provider_key, 'jev');
});

test('no key anywhere is none', async () => {
  row('acme', '', { label: 'Acme' });
  allow({ acme: { enabled: true } });
  const r = await resolve('acme');
  assert.equal(r.source, 'none');
  assert.equal(DecisionKeyResolver.unavailableReason(r, 'acme'), 'no Acme key');
});

test('the default is the first allowed row in admin order', async () => {
  row('jev', 'k', { sort: 100 });
  row('acme', 'k', { sort: 50 });
  row('broken', 'k', { protocol: null, sort: 10 });
  allow({ jev: { enabled: true }, broken: { enabled: true } });
  assert.equal(await DecisionKeyResolver.defaultProvider(2), 'jev', 'acme not in plan, broken has no protocol');
});

test('no allowed row means no default', async () => {
  row('jev', 'k');
  allow({ claude: { enabled: true } });
  assert.equal(await DecisionKeyResolver.defaultProvider(2), null);
});

test('a package without an allowlist allows every provider', async () => {
  row('acme', 'k');
  t.packages.user = {};
  assert.equal(await DecisionKeyResolver.allowed(2, 'acme'), true);
});

// ── DecisionUsage ────────────────────────────────────────────────────────────

const answered = (outcome = 'routed'): any => ({
  outcome, target: null, confidence: 0.9, ms: 212, usage: { input_tokens: 342, output_tokens: 39 },
  reason: outcome === 'error' ? 'no choice in the response' : null,
});

test('usage: the transaction payload', () => {
  const tx = DecisionUsage.transaction(7, 'jev', 'jev-latest', answered());
  assert.deepEqual(tx, {
    user_id: 7, provider: 'jev', model: 'jev-latest', prompt_tokens: 342, completion_tokens: 39,
    response_time_ms: 212, status: 'success', error_message: null, request_metadata: { decision_outcome: 'routed' },
  });
});

test('usage: unclear and low confidence are successful calls', () => {
  assert.equal(DecisionUsage.transaction(7, 'jev', 'jev-latest', answered('unclear')).status, 'success');
  assert.equal(DecisionUsage.transaction(7, 'jev', 'jev-latest', answered('low_confidence')).status, 'success');
});

test('usage: an answered error is recorded as error', () => {
  const tx = DecisionUsage.transaction(7, 'jev', 'jev-latest', answered('error'));
  assert.equal(tx.status, 'error');
  assert.equal(tx.error_message, 'no choice in the response');
});

test('usage: a call never sent, or no user, is not recorded; an answered one once', async () => {
  const written: any[] = [];
  const logger = async (tx: any) => (written.push(tx), 1);
  await DecisionUsage.record(logger, 7, 'jev', 'jev-latest', { outcome: 'unavailable', ms: null, usage: {}, reason: 'no Jev key' });
  await DecisionUsage.record(logger, 7, 'jev', 'jev-latest', { outcome: 'error', ms: null, usage: {}, reason: 'a menu needs at least two targets' });
  await DecisionUsage.record(logger, null, 'jev', 'jev-latest', answered());
  assert.equal(written.length, 0);
  await DecisionUsage.record(logger, 7, 'jev', 'jev-latest', answered());
  assert.equal(written.length, 1);
  assert.equal(written[0].prompt_tokens, 342);
});

test('usage: a logger failure never throws', async () => {
  await DecisionUsage.record(async () => {
    throw new Error('db down');
  }, 7, 'jev', 'jev-latest', answered());
});

test('usage: the row key and model are recorded', () => {
  const tx = DecisionUsage.transaction(7, 'acme', 'acme-1', { outcome: 'routed', ms: 12, usage: { input_tokens: 5, output_tokens: 1 } });
  assert.deepEqual([tx.provider, tx.model, tx.request_metadata], ['acme', 'acme-1', { decision_outcome: 'routed' }]);
});
