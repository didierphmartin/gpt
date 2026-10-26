import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { costFromRates, getTransactions } from '../src/Services/UsageLogger';

test('costFromRates computes token cost', () => {
  // 1M in @2.5 + 1M out @10 = 12.5
  assert.equal(costFromRates([2.5, 10], 1_000_000, 1_000_000), 12.5);
});

test('costFromRates handles zero rates', () => {
  assert.equal(costFromRates([0, 0], 5000, 5000), 0);
});

test('getTransactions answers the json columns as JSON text, as PHP PDO does', async () => {
  installFakeDb(() => [{ id: 1, functions_called: '["mcp_x"]' }]);
  const rows = await getTransactions(3, {}, 5, 0);
  assert.deepEqual(rows, [{ id: 1, functions_called: '["mcp_x"]' }]);
  for (const col of ['functions_called', 'mcp_tools_called', 'request_metadata']) {
    assert.match(queries[0].sql, new RegExp(`CAST\\(${col} AS CHAR\\) AS ${col}`));
  }
});
