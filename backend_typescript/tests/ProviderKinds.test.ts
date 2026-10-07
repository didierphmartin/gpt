import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatProviderRows, dispatchProviderList, isRouterRow, routerRowError } from '../src/Services/ProviderKinds';

const rows = [
  { provider_key: 'claude', api_format: 'anthropic' },
  { provider_key: 'kimi', api_format: 'openai' },
  { provider_key: 'legacy', api_format: null },
  { provider_key: 'jev', api_format: 'router' },
];

test('isRouterRow is true only for api_format router', () => {
  assert.equal(isRouterRow({ api_format: 'router' }), true);
  assert.equal(isRouterRow({ api_format: 'openai' }), false);
  assert.equal(isRouterRow({ api_format: null }), false);
  assert.equal(isRouterRow({}), false);
});

test('chatProviderRows (provider list source) drops router rows, keeps null-format rows', () => {
  const keys = chatProviderRows(rows).map((r) => r.provider_key);
  assert.deepEqual(keys, ['claude', 'kimi', 'legacy']);
});

test('an Object.prototype name is not a registered protocol', () => {
  const base = { providerKey: 'acme', apiFormat: 'router', existingFormat: null, otherDecisionKeys: [] };
  assert.match(routerRowError({ ...base, protocol: 'constructor' })!, /needs a protocol: one of typesafe/);
  assert.match(routerRowError({ ...base, protocol: 'toString' })!, /needs a protocol/);
  const row = { provider_key: 'acme', api_format: 'router', protocol: 'constructor', enabled: 1, base_url: 'https://gw/acme' };
  const [p] = dispatchProviderList([row], () => true).providers;
  assert.equal(p.legacy_env, null, 'no protocol entry for constructor');
  assert.equal(p.default_url, '');
});
