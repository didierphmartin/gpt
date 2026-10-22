import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_PROTOCOLS, decisionProtocolCatalog, envStem } from '../src/Services/DecisionProtocols';
import { routerRowError, decisionProviderList, dispatchProviderList } from '../src/Services/ProviderKinds';

const rows = [
  { provider_key: 'claude', api_format: 'anthropic', enabled: 1, sort_order: 0 },
  { provider_key: 'jev', display_name: 'Jev', api_format: 'router', protocol: 'typesafe', model: 'jev-latest', base_url: null, enabled: 1, sort_order: 100 },
  { provider_key: 'acme', display_name: 'Acme', api_format: 'router', protocol: 'typesafe', model: '', base_url: 'https://gw/acme', enabled: 1, sort_order: 50 },
  { provider_key: 'broken', display_name: 'B', api_format: 'router', protocol: null, model: 'm', base_url: null, enabled: 1, sort_order: 10 },
];

test('typesafe is registered with the PHP defaults', () => {
  assert.equal(DECISION_PROTOCOLS.typesafe.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(DECISION_PROTOCOLS.typesafe.model, 'jev-latest');
  assert.deepEqual(Object.keys(decisionProtocolCatalog()[0]), ['id', 'label', 'url', 'model', 'console_url']);
});

test('envStem sanitises like PHP', () => {
  assert.equal(envStem('jev-eu'), 'JEV_EU');
  assert.equal(envStem('acme.v2'), 'ACME_V2');
});

test('router rows need a registered protocol', () => {
  const base = { providerKey: 'acme', apiFormat: 'router', existingFormat: null, otherDecisionKeys: [] };
  assert.match(routerRowError({ ...base, protocol: null })!, /needs a protocol: one of typesafe, openai/);
  assert.equal(routerRowError({ ...base, protocol: 'typesafe' }), null);
});

test('the kind cannot flip', () => {
  assert.match(routerRowError({ providerKey: 'jev', apiFormat: 'openai', protocol: null, existingFormat: 'router', otherDecisionKeys: [] })!,
    /is a decision provider; it cannot become an LLM/);
  assert.match(routerRowError({ providerKey: 'kimi', apiFormat: 'router', protocol: 'typesafe', existingFormat: 'openai', otherDecisionKeys: [] })!,
    /is an LLM; it cannot become a decision provider/);
});

test('two keys sharing an env stem are refused', () => {
  assert.match(routerRowError({ providerKey: 'jev_eu', apiFormat: 'router', protocol: 'typesafe', existingFormat: null, otherDecisionKeys: ['jev-eu'] })!,
    /JEV_EU_API_KEY/);
});

test('decision_providers: allowed usable rows in admin order', () => {
  const list = decisionProviderList(rows, (k) => k !== 'jev');
  assert.deepEqual(list.map((d) => d.key), ['acme']);
  assert.equal(list[0].default_url, 'https://gw/acme');
  assert.equal(list[0].model, 'jev-latest');
});

test('/dispatch/providers says routing is not supported here', () => {
  const out = dispatchProviderList(rows, () => true);
  assert.equal(out.default, null);
  assert.deepEqual(out.providers.map((p) => p.key), ['broken', 'acme', 'jev']);
  assert.ok(out.providers.every((p) => p.routable === false && p.reason === 'not supported on this backend'));
  assert.ok(out.providers.every((p) => p.supported === false), 'the form greys these out');
  assert.equal(out.providers[1].key_env, 'ACME_API_KEY');
});
