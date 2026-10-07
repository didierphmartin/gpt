import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatProviderRows, isRouterRow } from '../src/Services/ProviderKinds';

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
