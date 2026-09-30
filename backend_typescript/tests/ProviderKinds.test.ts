import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatProviderRows, isRouterRow, routerPairingError } from '../src/Services/ProviderKinds';

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

test('chatProviderRows (provider list source) drops the jev router row, keeps null-format rows', () => {
  const keys = chatProviderRows(rows).map((r) => r.provider_key);
  assert.deepEqual(keys, ['claude', 'kimi', 'legacy']);
});

test('router pairing: jev must be router', () => {
  assert.equal(routerPairingError('jev', 'router'), null);
  assert.match(routerPairingError('jev', 'openai')!, /is a router: api_format must be 'router'/);
});

test('router pairing: router is reserved for router keys', () => {
  assert.equal(routerPairingError('claude', 'anthropic'), null);
  assert.match(routerPairingError('claude', 'router')!, /reserved for: jev/);
});
