import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPrices, SystemSettingsController } from '../src/Controllers/SystemSettingsController';

test('catalogPrices returns a catalog model price', () => {
  assert.deepEqual(catalogPrices('claude', 'claude-opus-5-5'), [4, 20]);
  assert.deepEqual(catalogPrices('glm', 'glm-5.2'), [1.4, 4.4]);
});

test('catalogPrices returns nulls for a model outside the catalog', () => {
  assert.deepEqual(catalogPrices('openai', 'not-a-catalog-model'), [null, null]);
  assert.deepEqual(catalogPrices('nope', 'x'), [null, null]);
});

function fallback(phpConfig: Record<string, any>): Record<string, any> {
  const c: any = new SystemSettingsController();
  c.phpConfig = phpConfig;
  const out: Record<string, any> = {};
  for (const p of c.getProvidersFromConfig().providers) out[p.provider_key] = p;
  return out;
}

test('config fallback: default model keeps default prices, glm has a default', () => {
  const p = fallback({ claude: {}, glm: {} });
  assert.equal(p.claude.model, 'claude-sonnet-5');
  assert.deepEqual([p.claude.price_input_per_1m, p.claude.price_output_per_1m], [2, 10]);
  assert.equal(p.glm.model, 'glm-5.2');
  assert.equal(p.glm.base_url, 'https://api.z.ai/api/paas/v4');
  assert.equal(p.glm.chat_endpoint, '/chat/completions');
  assert.deepEqual([p.glm.price_input_per_1m, p.glm.price_output_per_1m], [1.4, 4.4]);
});

test('config fallback: a configured model gets its own catalog price, or none', () => {
  const p = fallback({ claude: { model: 'claude-opus-5-5' }, openai: { model: 'not-a-catalog-model' } });
  assert.deepEqual([p.claude.price_input_per_1m, p.claude.price_output_per_1m], [4, 20]);
  assert.deepEqual([p.openai.price_input_per_1m, p.openai.price_output_per_1m], [null, null]);
});
