import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load api-config.js in a non-browser context; it must expose test hooks.
const path = fileURLToPath(new URL('../assets/js/api-config.js', import.meta.url));
globalThis.window = undefined;            // ensure browser branch is skipped
new Function(readFileSync(path, 'utf8'))();
const { resolveApiBase, makeApiUrl } = globalThis.__API_CONFIG_TEST__;

const BY_HOST = { 'localhost': '/gpt/backend/api/v1', 'synergyaichat.com': 'https://api.synergyaichat.com/v1' };
const FALLBACK = '/gpt/backend/api/v1';

test('override wins over everything', () => {
  assert.equal(
    resolveApiBase({ override: 'http://localhost:3000/v1', hostname: 'synergyaichat.com', byHost: BY_HOST, fallback: FALLBACK }),
    'http://localhost:3000/v1');
});

test('known host maps to its base', () => {
  assert.equal(
    resolveApiBase({ override: null, hostname: 'synergyaichat.com', byHost: BY_HOST, fallback: FALLBACK }),
    'https://api.synergyaichat.com/v1');
});

test('unknown host falls back to relative default', () => {
  assert.equal(
    resolveApiBase({ override: null, hostname: 'example.test', byHost: BY_HOST, fallback: FALLBACK }),
    '/gpt/backend/api/v1');
});

test('apiUrl joins base and path with exactly one slash', () => {
  const apiUrl = makeApiUrl('/gpt/backend/api/v1');
  assert.equal(apiUrl('/chat'), '/gpt/backend/api/v1/chat');
  assert.equal(apiUrl('chat'), '/gpt/backend/api/v1/chat');
});

test('apiUrl works with an absolute base', () => {
  const apiUrl = makeApiUrl('https://api.host/v1');
  assert.equal(apiUrl('/chat'), 'https://api.host/v1/chat');
});
