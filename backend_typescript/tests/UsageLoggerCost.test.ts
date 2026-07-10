import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFromRates } from '../src/Services/UsageLogger';

test('costFromRates computes token cost', () => {
  // 1M in @2.5 + 1M out @10 = 12.5
  assert.equal(costFromRates([2.5, 10], 1_000_000, 1_000_000), 12.5);
});

test('costFromRates handles zero rates', () => {
  assert.equal(costFromRates([0, 0], 5000, 5000), 0);
});
