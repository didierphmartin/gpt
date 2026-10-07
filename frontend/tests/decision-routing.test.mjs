import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../assets/js/decision-routing.js', import.meta.url));
globalThis.window = undefined;
new Function(readFileSync(path, 'utf8'))();
const { routingChoice, effectiveKey, minConfidence, envPlan } = globalThis.__DECISION_ROUTING_TEST__;

const P = (key, extra = {}) => ({ key, label: key.toUpperCase(), allowed: true, routable: true,
  key_env: key.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY',
  url_env: key.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_BASE_URL',
  legacy_env: { key: 'TYPESAFE_API_KEY', url: 'TYPESAFE_BASE_URL' }, ...extra });
const LIST = { default: 'jev', providers: [P('jev'), P('acme')] };

test('llm is the model', () => {
  assert.deepEqual(routingChoice('llm', LIST), { mode: 'llm' });
  assert.equal(effectiveKey('llm', LIST), null);
});

test('a saved key names its provider; a saved jev keeps working', () => {
  assert.equal(routingChoice('acme', LIST).provider.key, 'acme');
  assert.equal(effectiveKey('jev', LIST), 'jev');
});

test('a deleted provider stays selected and is marked unavailable', () => {
  const c = routingChoice('gone', LIST);
  assert.equal(c.mode, 'decision');
  assert.equal(c.key, 'gone');
  assert.equal(c.provider, null);
  assert.equal(effectiveKey('gone', LIST), 'gone', 'never silently another provider or the model');
});

test('unset is the server default, or the model when there is none', () => {
  assert.equal(effectiveKey('', LIST), 'jev');
  assert.equal(effectiveKey(undefined, { default: null, providers: [] }), null);
});

test('an unreadable list never turns a decision node into the model', () => {
  assert.equal(effectiveKey('acme', null), 'acme');
  assert.equal(effectiveKey('', null), '');   // '' = unknown default: the caller halts
});

test('min_confidence wins, then jev_min_confidence, then 0.6, clamped', () => {
  assert.equal(minConfidence({ min_confidence: 0.8, jev_min_confidence: 0.3 }), 0.8);
  assert.equal(minConfidence({ jev_min_confidence: 0.3 }), 0.3);
  assert.equal(minConfidence({}), 0.6);
  assert.equal(minConfidence({ min_confidence: 7 }), 1);
  assert.equal(minConfidence({ min_confidence: 'x' }), 0.6);
});

test('envPlan writes allowed keys and URLs, drops forbidden ones and every legacy name', () => {
  const rows = [
    { provider_key: 'jev', api_format: 'router', enabled: true, api_key: 'k-jev', base_url: null },
    { provider_key: 'acme', api_format: 'router', enabled: true, api_key: 'k-acme', base_url: 'https://gw/acme' },
  ];
  const list = { default: 'jev', providers: [P('jev'), P('acme', { allowed: false })] };
  const plan = envPlan(rows, list);
  assert.deepEqual(plan.set, { JEV_API_KEY: 'k-jev' });
  assert.deepEqual(plan.drop.sort(), ['ACME_API_KEY', 'ACME_BASE_URL', 'JEV_BASE_URL', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL'].sort());
});

test('envPlan with an unreadable list writes nothing and drops nothing', () => {
  assert.deepEqual(envPlan([], null), { set: {}, drop: [] });
});
