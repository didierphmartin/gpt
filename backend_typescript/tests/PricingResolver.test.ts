import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRow, PricingUnavailableError } from '../src/Services/PricingResolver';

test('classifyRow returns rates for a valid row', () => {
  assert.deepEqual(
    classifyRow({ price_input_per_1m: '2.5000', price_output_per_1m: '10.0000' }, 'openai'),
    [2.5, 10.0],
  );
});

test('classifyRow treats 0 as valid', () => {
  assert.deepEqual(
    classifyRow({ price_input_per_1m: '0.0000', price_output_per_1m: '0.0000' }, 'gamma4'),
    [0, 0],
  );
});

test('classifyRow throws on missing row', () => {
  assert.throws(() => classifyRow(undefined, 'gemini'), PricingUnavailableError);
});

test('classifyRow throws on null price', () => {
  assert.throws(
    () => classifyRow({ price_input_per_1m: null, price_output_per_1m: '4.0' }, 'kimi'),
    PricingUnavailableError,
  );
});
