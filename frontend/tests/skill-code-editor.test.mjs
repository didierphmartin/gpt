// The code adapter (skill-editor.js) with a stubbed CodeMirror: extension -> mode, Python indent, read-only, byte-exact
// untouched text (CRLF / lone CR / mixed / BOM / no final newline), change events on edits only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './fixtures/dom-stub.mjs';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skill-editor.js', import.meta.url)), 'utf8');

function load({ withCm = true } = {}) {
  const document = makeDom();
  const made = [];
  function CodeMirror(el, opts) {
    let value = String(opts.value).replace(/\r\n?/g, '\n');
    const handlers = [];
    const cm = { opts, getValue: () => value, on: (ev, f) => { if (ev === 'change') handlers.push(f); }, setSize() {},
      type(v) { value = v; handlers.forEach((f) => f()); } };
    made.push(cm);
    return cm;
  }
  const window = { document, i18n: { t: (k) => k } };
  if (withCm) window.CodeMirror = CodeMirror;
  const ctx = vm.createContext({ window, document, console, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, Promise });
  vm.runInContext(SRC, ctx);
  return { SE: window.SkillEditor, document, made };
}

const MODES = { 'a.py': 'python', 'a.js': 'javascript', 'a.mjs': 'javascript', 'a.json': 'application/json', 'a.sh': 'shell',
  'a.yaml': 'yaml', 'a.yml': 'yaml', 'a.html': 'htmlmixed', 'a.css': 'css', 'a.mmd': 'text/plain', 'a.txt': 'text/plain',
  'a.csv': 'text/plain', 'a.toml': 'text/plain', 'Makefile': 'text/plain', 'a.PY': 'python' };

test('code adapter is registered for kind code', () => {
  const { SE } = load();
  assert.equal(SE.adapters.code, SE.codeAdapter);
});

test('extension -> CodeMirror mode', async () => {
  const { SE, document, made } = load();
  for (const [rel, mode] of Object.entries(MODES)) {
    assert.equal(SE.modeOf(rel), mode, rel);
    const a = SE.adapters.code();
    await a.mount(document.createElement('div'), 'x', { rel });
    assert.equal(made.at(-1).opts.mode, mode, rel);
    assert.equal(made.at(-1).opts.lineNumbers, true);
  }
});

test('indent is 4 spaces; no auto-formatting options', async () => {
  const { SE, document, made } = load();
  const a = SE.adapters.code();
  await a.mount(document.createElement('div'), 'def f():\n', { rel: 'x.py' });
  const o = made.at(-1).opts;
  assert.equal(o.indentUnit, 4);
  assert.equal(o.indentWithTabs, false);
  assert.ok(!o.autoCloseBrackets);
});

test('readOnly is honoured', async () => {
  const { SE, document, made } = load();
  for (const ro of [true, false]) {
    const a = SE.adapters.code();
    await a.mount(document.createElement('div'), 'x', { rel: 'a.py', readOnly: ro });
    assert.equal(made.at(-1).opts.readOnly, ro);
  }
});

test('untouched getText is byte-exact: CRLF, lone CR, mixed, BOM, no final newline, empty', async () => {
  const { SE, document } = load();
  const cases = ['a\r\nb\r\n', 'a\rb\r', 'a\r\nb\nc\rd', '﻿print(1)\n', 'no newline', '', '\n\n', 'x\r\n'];
  for (const t of cases) {
    const a = SE.adapters.code();
    await a.mount(document.createElement('div'), t, { rel: 'a.py' });
    assert.equal(a.getText(), t, JSON.stringify(t));
  }
});

test('an edited CRLF file stays CRLF; setOriginal is a no-op', async () => {
  const { SE, document, made } = load();
  const a = SE.adapters.code();
  await a.mount(document.createElement('div'), 'a\r\nb\r\n', { rel: 'a.sh' });
  a.setOriginal('whatever');
  made.at(-1).type('a\nbc\n');
  assert.equal(a.getText(), 'a\r\nbc\r\n');
});

test('onChange fires on an edit only, not on mount', async () => {
  const { SE, document, made } = load();
  const a = SE.adapters.code();
  let n = 0;
  await a.mount(document.createElement('div'), 'x\n', { rel: 'a.js' });
  a.onChange(() => n++);
  assert.equal(n, 0);
  made.at(-1).type('xy\n');
  assert.equal(n, 1);
});

test('destroy removes the pane; without CodeMirror the textarea adapter is used', async () => {
  const { SE, document } = load();
  const host = document.createElement('div');
  const a = SE.adapters.code();
  await a.mount(host, 'x', { rel: 'a.py' });
  assert.equal(host.children.length, 1);
  a.destroy();
  assert.equal(host.children.length, 0);
  const b = load({ withCm: false });
  const h2 = b.document.createElement('div');
  const t = b.SE.adapters.code();
  await t.mount(h2, 'x\r\n', { rel: 'a.py' });
  assert.equal(t.getText(), 'x\r\n');
});
