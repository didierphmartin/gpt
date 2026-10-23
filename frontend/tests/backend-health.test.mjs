import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/backend-health.js', import.meta.url)), 'utf8');

/** Minimal DOM: enough for the banner, nothing more. */
function makeEl(tag) {
  return {
    tagName: tag, id: '', textContent: '', children: [],
    style: { cssText: '' }, attrs: {}, listeners: {}, removed: false,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { this.removed = true; },
  };
}

function textOf(el) {
  return [el.textContent || '', ...el.children.map(textOf)].join(' ');
}

function findById(el, id) {
  if (el.id === id) return el;
  for (const c of el.children) { const hit = findById(c, id); if (hit) return hit; }
  return null;
}

/**
 * Evaluate the module against a fresh fake browser.
 * `fetchImpl` stands in for the network; `calls` records what it was asked for.
 */
function load({ kind = 'python', base = 'http://localhost:3002/api/v1', language = null, fetchImpl } = {}) {
  const calls = [];
  const body = makeEl('body');
  const impl = fetchImpl || (() => Promise.reject(new TypeError('Failed to fetch')));

  const fetchStub = (input, init) => { calls.push({ url: input, init }); return impl(input, init); };

  const store = language === null ? {} : { chatbot_language: language };
  const window = {
    APP_CONFIG: { BACKEND_KIND: kind, API_BASE_URL: base },
    fetch: fetchStub,
    setBackendKind: (k) => { window.switchedTo = k; },
  };

  globalThis.window = window;
  globalThis.fetch = fetchStub;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null) };
  globalThis.document = {
    body,
    createElement: makeEl,
    getElementById: (id) => findById(body, id),
    addEventListener() {},
  };

  new Function(SRC)();
  return { window, body, calls, banner: () => findById(body, 'backend-health-banner') };
}

const tick = () => new Promise((r) => setImmediate(r));

test('php is not probed — Apache already served this page', async () => {
  const { calls } = load({ kind: 'php', base: '/gpt/backend/api/v1' });
  await tick();
  assert.equal(calls.length, 0, 'the default path must not spend a request');
});

test('a non-php backend is probed once, opaquely', async () => {
  const { calls } = load({ kind: 'python' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:3002/api/v1');
  // no-cors resolves for any server that answers, so a rejection can only mean
  // "nothing is listening" — a CORS-blocked live backend would otherwise look dead.
  assert.equal(calls[0].init.mode, 'no-cors');
});

test('a refused probe names the backend and gives the start command', async () => {
  const { banner } = load({ kind: 'python' });
  await tick();
  const text = textOf(banner());
  assert.match(text, /Python backend is not running/);
  assert.match(text, /http:\/\/localhost:3002\/api\/v1/);
  assert.match(text, /cd backend_python && \.\/run\.sh/);
});

test('the TypeScript backend gets its own command', async () => {
  const { banner } = load({ kind: 'node', base: 'http://localhost:3001/api/v1' });
  await tick();
  assert.match(textOf(banner()), /cd backend_typescript && npm run dev/);
});

test('a reachable backend produces no banner', async () => {
  const { banner } = load({ kind: 'python', fetchImpl: () => Promise.resolve({ status: 404 }) });
  await tick();
  assert.equal(banner(), null);
});

test('an HTTP error status is not a dead backend', async () => {
  const { window, banner } = load({
    kind: 'php', base: '/gpt/backend/api/v1',
    fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
  });
  await window.fetch('/gpt/backend/api/v1/auth');
  await tick();
  assert.equal(banner(), null, 'the server answered — that is a different problem');
});

test('a network failure mid-session raises the banner and still rejects', async () => {
  const { window, banner } = load({ kind: 'php', base: '/gpt/backend/api/v1' });
  await assert.rejects(() => window.fetch('/gpt/backend/api/v1/auth'), TypeError);
  assert.ok(banner(), 'the caller sees the banner');
  assert.match(textOf(banner()), /Apache and MySQL/, 'php gets XAMPP advice, not a shell command');
});

test('a failure on some other origin is ignored', async () => {
  const { window, banner } = load({ kind: 'php', base: '/gpt/backend/api/v1' });
  await assert.rejects(() => window.fetch('https://graph.facebook.com/me'), TypeError);
  assert.equal(banner(), null);
});

test('the banner appears once, however many calls fail', async () => {
  const { window, body } = load({ kind: 'php', base: '/gpt/backend/api/v1' });
  await assert.rejects(() => window.fetch('/gpt/backend/api/v1/a'), TypeError);
  await assert.rejects(() => window.fetch('/gpt/backend/api/v1/b'), TypeError);
  assert.equal(body.children.filter((c) => c.id === 'backend-health-banner').length, 1);
});

test('switching to PHP is offered for a dead non-php backend, and works', async () => {
  const { window, banner } = load({ kind: 'python' });
  await tick();
  const button = banner().children.flatMap((c) => c.children)
    .find((c) => c.tagName === 'button' && /PHP/.test(c.textContent));
  assert.ok(button, 'the one-click way out of a stale selection');
  button.listeners.click[0]();
  assert.equal(window.switchedTo, 'php');
});

test('php does not offer to switch to php', async () => {
  const { window, banner } = load({ kind: 'php', base: '/gpt/backend/api/v1' });
  await assert.rejects(() => window.fetch('/gpt/backend/api/v1/auth'), TypeError);
  assert.ok(!/Switch to/.test(textOf(banner())));
});

test('the message follows the chosen language', async () => {
  for (const [lang, expected] of [['fr', /n'est pas démarré/], ['es', /no está en ejecución/]]) {
    const { banner } = load({ kind: 'python', language: lang });
    await tick();
    assert.match(textOf(banner()), expected, lang + ' must not fall back to English');
  }
});

test('an unknown language falls back to English rather than a raw key', async () => {
  const { banner } = load({ kind: 'python', language: 'de' });
  await tick();
  assert.match(textOf(banner()), /is not running/);
});
