import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { decisionHandler, decisionTables, routerRow, fakeHttp, DecisionTables } from './support/decisionDb';
import { ApiKeyCrypto } from '../src/Services/ApiKeyCrypto';
import { DispatchController } from '../src/Controllers/DispatchController';

/**
 * Twins of backend/tests/Unit/Controllers/DispatchControllerTest.php and DispatchProvidersTest.php.
 * The browser run path never sees a decision key: it asks these endpoints to route (POST) and to
 * say whether a key exists (GET status). The vendor HTTP API is faked.
 */

const SECRET = 'test-jwt-secret';
const TARGETS = [
  { id: 1, name: 'Billing', description: 'Invoices.' },
  { id: 2, name: 'Sales', description: 'Plans.' },
];

let t: DecisionTables;
let left: () => number;
let seen: any[];

beforeEach(() => {
  t = decisionTables({
    users: { 7: 'user', 8: 'user' },
    packages: { user: { providers: { jev: { enabled: true } } } },
    settings: [routerRow('jev', '', { display_name: 'Jev' })],
  });
  installFakeDb(decisionHandler(t));
});

function controller(queue: any[] = [], logger: ((tx: any) => Promise<number | null>) | null = async () => 1) {
  const h = fakeHttp(queue);
  left = h.left;
  seen = h.seen;
  return new DispatchController(h.http, logger, SECRET);
}

const ctx = (userId: number | null, body: Record<string, any> = {}, params: Record<string, string> = {}): any => ({
  method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: 'jwt', params, remote_addr: '',
});
const answer = (choice: string, confidence: number) => ({
  body: { answers: { route: { choice, confidence, probabilities: { [choice]: confidence } } }, usage: { input_tokens: 342, output_tokens: 39 } },
});
const globalKey = (key = 'g-key') => (t.settings[0].api_key = key);
const userKey = (uid: number, key = 'u-key') => t.userKeys.push({ user_id: uid, provider: 'jev', api_key: ApiKeyCrypto.encrypt(key, SECRET) });
const jevOff = () => (t.packages.user = { providers: { jev: { enabled: false } } });
const body = (extra: Record<string, any> = {}) => ({ request: 'I was charged twice', targets: TARGETS, question: 'Which team?', ...extra });
const neverLogger = () => async () => {
  throw new Error('nothing may be recorded');
};

test('status per source', async () => {
  const c = controller();
  assert.deepEqual(await c.jevStatus(ctx(7)), { success: true, provider: 'jev', allowed: true, available: false, source: 'none', status_code: 200 });
  globalKey();
  assert.equal((await c.jevStatus(ctx(7))).source, 'global');
  userKey(7);
  const s = await c.jevStatus(ctx(7));
  assert.equal(s.source, 'user');
  assert.equal(s.available, true);
  assert.ok(!('key' in s));
  assert.ok(!JSON.stringify(s).includes('u-key'));
  assert.equal((await c.jevStatus(ctx(8))).source, 'global', 'another user falls back to global');
});

test('routed', async () => {
  globalKey();
  const out = await controller([answer('Billing', 0.95)]).jevRoute(ctx(7, body()));
  assert.equal(out.success, true);
  assert.equal(out.outcome, 'routed');
  assert.deepEqual(out.target, { id: 1, name: 'Billing' });
  assert.equal(out.confidence, 0.95);
  assert.ok(!('probabilities' in out) && !('usage' in out));
  assert.equal(out.status_code, 200);
});

test('unclear', async () => {
  globalKey();
  const out = await controller([answer('unclear', 1.0)]).jevRoute(ctx(7, body()));
  assert.equal(out.outcome, 'unclear');
  assert.equal(out.target, null);
});

test('custom floor and clamp', async () => {
  globalKey();
  assert.equal((await controller([answer('Billing', 0.7)]).jevRoute(ctx(7, body({ min_confidence: 0.8 })))).outcome, 'low_confidence');
  assert.equal((await controller([answer('Billing', 0.7)]).jevRoute(ctx(7, body({ min_confidence: 5 })))).outcome, 'low_confidence', 'clamped to 1.0');
  assert.equal((await controller([answer('Billing', 0.7)]).jevRoute(ctx(7, body({ min_confidence: -3 })))).outcome, 'routed', 'clamped to 0.0');
  assert.equal((await controller([answer('Billing', 0.7)]).jevRoute(ctx(7, body({ min_confidence: '0.8' })))).outcome, 'low_confidence', 'a numeric string');
  assert.equal((await controller([answer('Billing', 0.7)]).jevRoute(ctx(7, body()))).outcome, 'routed', 'default floor 0.6');
});

test('no key is unavailable without HTTP', async () => {
  const out = await controller([answer('Billing', 0.99)]).jevRoute(ctx(7, body()));
  assert.equal(out.success, true);
  assert.equal(out.outcome, 'unavailable');
  assert.equal(out.target, null);
  assert.equal(left(), 1, 'no HTTP call was made');
});

test('the user key is used', async () => {
  userKey(7);
  const out = await controller([answer('Sales', 0.9)]).jevRoute(ctx(7, body()));
  assert.equal(out.outcome, 'routed');
  assert.equal(out.target.id, 2);
  assert.equal(seen[0].headers.Authorization, 'Bearer u-key');
});

test('status says not allowed when the package switches Jev off', async () => {
  jevOff();
  globalKey();
  userKey(7);
  const out = await controller().jevStatus(ctx(7));
  assert.deepEqual([out.allowed, out.available, out.source], [false, false, 'not_allowed']);
});

test('route gives the plan reason and records nothing when not allowed', async () => {
  jevOff();
  globalKey();
  const out = await controller([answer('Billing', 0.99)], neverLogger()).jevRoute(ctx(7, body()));
  assert.equal(out.outcome, 'unavailable');
  assert.equal(out.reason, 'Jev is not enabled for your plan');
  assert.equal(left(), 1, 'no HTTP call was made');
});

test('no key keeps the no-key reason and records nothing', async () => {
  const out = await controller([], neverLogger()).jevRoute(ctx(7, body()));
  assert.equal(out.outcome, 'unavailable');
  assert.equal(out.reason, 'no Jev key');
});

test('a menu that cannot be sent records nothing', async () => {
  globalKey();
  const out = await controller([answer('Billing', 0.99)], neverLogger()).jevRoute(ctx(7, body({ targets: [TARGETS[0]] })));
  assert.equal(out.outcome, 'error');
  assert.equal(left(), 1, 'no HTTP call was made');
});

test('an answered route is recorded once; an answered decline too', async () => {
  globalKey();
  const written: any[] = [];
  const logger = async (tx: any) => (written.push(tx), 1);
  const out = await controller([answer('Billing', 0.95)], logger).jevRoute(ctx(7, body()));
  assert.equal(out.outcome, 'routed');
  assert.ok(!('usage' in out));
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].provider, written[0].user_id, written[0].prompt_tokens, written[0].completion_tokens], ['jev', 7, 342, 39]);
  await controller([answer('unclear', 1.0)], logger).jevRoute(ctx(7, body()));
  assert.deepEqual(written[1].request_metadata, { decision_outcome: 'unclear' });
});

test('an invalid body is 400', async () => {
  globalKey();
  const ok = { request: 'x', targets: TARGETS, question: 'q' };
  const { request: _r, ...missing } = ok;
  for (const b of [missing, { ...ok, request: '' }, { ...ok, targets: 'Billing' }, { ...ok, question: 5 }, { ...ok, min_confidence: 'high' }]) {
    const out = await controller().jevRoute(ctx(7, b));
    assert.equal(out.success, false, JSON.stringify(b));
    assert.equal(out.status_code, 400);
    assert.ok('message' in out);
  }
});

// ── DispatchProvidersTest ────────────────────────────────────────────────────

function providersFixture() {
  t.settings = [
    routerRow('jev', 'jev-global', { display_name: 'Jev', sort_order: 100 }),
    routerRow('acme', 'acme-global', { display_name: 'Acme', model: 'acme-1', base_url: 'https://gw.corp/acme', sort_order: 50 }),
    routerRow('broken', 'k', { display_name: 'Broken', protocol: null, sort_order: 60 }),
  ];
  t.packages.user = { providers: { jev: { enabled: true }, acme: { enabled: true }, broken: { enabled: true } } };
}

test('providers lists every row with its status', async () => {
  providersFixture();
  const out = await controller().providers(ctx(7));
  assert.deepEqual(out.providers.map((p: any) => p.key), ['acme', 'broken', 'jev']);
  assert.equal(out.default, 'acme');
  const acme = out.providers[0];
  assert.equal(acme.routable, true);
  assert.equal(acme.supported, true, 'this backend routes with decision models');
  assert.equal(acme.key_env, 'ACME_API_KEY');
  assert.equal(acme.url_env, 'ACME_BASE_URL');
  assert.deepEqual(acme.legacy_env, { key: 'TYPESAFE_API_KEY', url: 'TYPESAFE_BASE_URL' });
  assert.ok(!('api_key' in acme), 'never the key');
  assert.ok(!JSON.stringify(out).includes('acme-global'));
});

test('providers marks a row without protocol unroutable', async () => {
  providersFixture();
  const broken = (await controller().providers(ctx(7))).providers[1];
  assert.equal(broken.routable, false);
  assert.equal(broken.reason, "'broken' is not an available decision provider");
  assert.equal(broken.legacy_env, null);
});

test('route uses the named provider key and URL', async () => {
  providersFixture();
  const out = await controller([answer('Billing', 0.95)]).route(ctx(7, body({ provider: 'acme' })));
  assert.equal(out.outcome, 'routed');
  assert.equal(out.provider, 'acme');
  assert.equal(seen[0].url, 'https://gw.corp/acme');
  assert.equal(seen[0].headers.Authorization, 'Bearer acme-global');
  assert.equal(seen[0].body.model, 'acme-1');
});

test('route with an unknown provider calls nothing', async () => {
  providersFixture();
  const out = await controller([answer('Billing', 0.95)]).route(ctx(7, body({ provider: 'gone' })));
  assert.equal(out.outcome, 'unavailable');
  assert.equal(out.reason, "'gone' is not an available decision provider");
  assert.deepEqual(seen, []);
});

test('route needs a provider', async () => {
  providersFixture();
  const out = await controller().route(ctx(7, body()));
  assert.equal(out.status_code, 400);
  assert.equal(out.message, 'provider is required');
});

test('the jev aliases still work, and status is per provider', async () => {
  providersFixture();
  const c = controller([answer('Billing', 0.95)]);
  assert.equal((await c.jevStatus(ctx(7))).available, true);
  const out = await c.jevRoute(ctx(7, body()));
  assert.deepEqual([out.provider, out.outcome], ['jev', 'routed']);
  const st = await c.status(ctx(7, {}, { key: 'acme' }));
  assert.deepEqual([st.provider, st.allowed, st.available, st.source], ['acme', true, true, 'global']);
});
