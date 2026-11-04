import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skill-editor.js', import.meta.url)), 'utf8');
const SkillFrontmatter = createRequire(import.meta.url)('../assets/js/skill-frontmatter.js');
const EN = JSON.parse(readFileSync(fileURLToPath(new URL('../assets/i18n/en.json', import.meta.url)), 'utf8'));
const tr = (k, p = {}) => {
  const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), EN);
  return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, n) => p[n] ?? '') : k;
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- minimal DOM stub: elements built with createElement; querySelector on [attr="v"] / [attr] / tag ----
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
    this.style = {}; this._l = {}; this._text = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.readOnly = false; this.className = '';
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) self.classList.add(c); if (!want && has) self.classList.remove(c); return want; },
    };
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(new El('#text'), { _text: c }) : c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...cs) { for (const c of [...this.children]) this.removeChild(c); this.append(...cs); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  dispatch(t, extra = {}) { for (const f of this._l[t] || []) f({ type: t, target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; }
  get dataset() { return {}; }
  focus() {}
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  matches(sel) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) return m[2] === undefined ? m[1] in this.attributes : this.attributes[m[1]] === m[2];
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel) { for (const e of this.walk()) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
}

function makeDom() {
  const body = new El('body');
  const document = {
    body,
    createElement: (t) => new El(t),
    getElementById: (id) => body.querySelector(`[id="${id}"]`),
    addEventListener() {}, removeEventListener() {},
  };
  return document;
}

/** files: { rel: string | Uint8Array }; opts.fail: Set of rels whose write throws */
function makeFs(files, { fail = new Set(), importErr = null } = {}) {
  const disk = {};
  for (const [r, v] of Object.entries(files)) disk[r] = typeof v === 'string' ? enc.encode(v) : v;
  const calls = { writes: [], imports: [], reads: [] };
  const fs = {
    listSkillFiles: async () => Object.keys(disk).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a < b ? -1 : 1)).map((rel) => ({ rel, size: disk[rel].length })),
    getSkillFileBytes: async (_p, rel) => { calls.reads.push(rel); return disk[rel] || null; },
    writeSkillFile: async (path, rel, bytes) => {
      if (fail.has(rel)) throw new Error('disk full');
      calls.writes.push([path, rel, dec.decode(bytes)]);
      disk[rel] = bytes;
      return { ok: true };
    },
    importSkill: async (read, opts) => {
      if (importErr) throw importErr;
      calls.imports.push([read, opts]);
      return { status: 'installed' };
    },
  };
  return { fs, calls, disk };
}

/** A fake editor adapter (Tasks 5/6 provide the real ones): tests type through `type`. */
function fakeAdapters() {
  const mounts = [];
  const make = (kind) => () => {
    const a = { kind, text: '', cb: null, destroyed: false, opts: null };
    const api = {
      mount(el, text, opts) { a.text = text; a.opts = opts; a.el = el; mounts.push(a); },
      getText: () => a.text,
      onChange(cb) { a.cb = cb; },
      destroy() { a.destroyed = true; },
    };
    a.type = (t) => { a.text = t; a.cb && a.cb(); };
    return api;
  };
  return { mounts, adapters: { markdown: make('markdown'), code: make('code'), binary: make('binary') }, last: () => mounts[mounts.length - 1] };
}

function load({ files = {}, fsOpts, fake = true } = {}) {
  const document = makeDom();
  const { fs, calls, disk } = makeFs(files, fsOpts);
  const window = { skillsFs: fs, SkillFrontmatter, i18n: { t: tr }, document };
  const ctx = vm.createContext({ window, document, console, TextEncoder, TextDecoder, Uint8Array, setTimeout, Promise });
  vm.runInContext(SRC, ctx);
  const SE = window.SkillEditor;
  const fa = fakeAdapters();
  if (fake) Object.assign(SE.adapters, fa.adapters);
  let loads = 0;
  const manager = { loadTree: async () => { loads++; } };
  return { SE, document, calls, disk, fa, manager, loads: () => loads };
}

const q = (root, se) => root.querySelector(`[data-se="${se}"]`);
const SKILL_MD = '---\nname: demo\ndescription: >\n  folded\n  text\n---\n\n# Demo\n\nBody.\n';
const FILES = { 'SKILL.md': SKILL_MD, 'references/a.md': '# A\n', 'scripts/run.py': 'print(1)\n' };
const mine = { dir_name: 'demo', name: 'demo', mine: true };

async function select(dlg, rel) {
  const sel = q(dlg.el, 'file');
  sel.value = rel;
  sel.dispatch('change');
  await dlg.ready();
}
const optionText = (dlg, rel) => q(dlg.el, 'file').querySelectorAll('option').find((o) => o.value === rel).textContent;

test('opens SKILL.md first, editor gets the BODY only; frontmatter panel slot shows the front', async () => {
  const { SE, document, fa, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  assert.ok(document.getElementById('skill-editor-modal'));
  assert.equal(fa.last().kind, 'markdown');
  assert.equal(fa.last().text, '\n# Demo\n\nBody.\n');
  assert.equal(fa.last().opts.readOnly, false);
  assert.equal(fa.last().opts.rel, 'SKILL.md');
  assert.ok(q(dlg.el, 'front').querySelector('textarea').value.includes('folded'));
  assert.equal(q(dlg.el, 'front').querySelector('textarea').readOnly, true);   // front kept intact (Task 7: form)
  const opts = q(dlg.el, 'file').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(opts, ['SKILL.md', 'references/a.md', 'scripts/run.py']);
  assert.match(q(dlg.el, 'title').textContent, /demo/);
});

test('dirty only when the text differs from the text as loaded (RF 2)', async () => {
  const { SE, fa, manager, calls } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  const ed = fa.last();
  ed.cb();                                    // a change event without a change
  assert.equal(dlg.dirtyFiles().length, 0);
  ed.type('\n# Demo\n\nBody!\n');
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
  assert.ok(optionText(dlg, 'SKILL.md').includes('●'));
  ed.type('\n# Demo\n\nBody.\n');            // typed back to the original
  assert.equal(dlg.dirtyFiles().length, 0);
  assert.ok(!optionText(dlg, 'SKILL.md').includes('●'));
  await dlg.save();
  assert.equal(calls.writes.length, 0);
});

test('switching files keeps the edits (dot stays) and Save writes them (RF 4)', async () => {
  const { SE, fa, manager, calls } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'scripts/run.py');
  assert.equal(fa.last().kind, 'code');
  fa.last().type('print(2)\n');
  await select(dlg, 'references/a.md');
  assert.ok(fa.mounts[1].destroyed);
  assert.ok(optionText(dlg, 'scripts/run.py').includes('●'));
  await select(dlg, 'scripts/run.py');
  assert.equal(fa.last().text, 'print(2)\n');
  assert.equal(calls.reads.filter((r) => r === 'scripts/run.py').length, 1);   // loaded once
  await dlg.save();
  assert.deepEqual(calls.writes, [['demo', 'scripts/run.py', 'print(2)\n']]);
  assert.ok(!optionText(dlg, 'scripts/run.py').includes('●'));
});

test('Save writes only dirty files; SKILL.md keeps the frontmatter bytes and refreshes the tree', async () => {
  const { SE, fa, manager, calls, loads } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  fa.last().type('\n# Demo\n\nNew body.\n');
  await select(dlg, 'references/a.md');      // visited, untouched
  await dlg.save();
  assert.deepEqual(calls.writes, [['demo', 'SKILL.md', '---\nname: demo\ndescription: >\n  folded\n  text\n---\n\n# Demo\n\nNew body.\n']]);
  assert.equal(loads(), 1);
  assert.match(q(dlg.el, 'status').textContent, /Saved 1/);
  // a second Save writes nothing
  await dlg.save();
  assert.equal(calls.writes.length, 1);
});

test('a script-only save does not refresh the tree', async () => {
  const { SE, fa, manager, loads } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'scripts/run.py');
  fa.last().type('x\n');
  await dlg.save();
  assert.equal(loads(), 0);
});

test('one failure keeps its dot and is named; the others save', async () => {
  const { SE, fa, manager, calls } = load({ files: FILES, fsOpts: { fail: new Set(['references/a.md']) } });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'references/a.md');
  fa.last().type('# A2\n');
  await select(dlg, 'scripts/run.py');
  fa.last().type('print(3)\n');
  const r = await dlg.save();
  assert.deepEqual(calls.writes.map((w) => w[1]), ['scripts/run.py']);
  assert.deepEqual([...r.failed.map((f) => f.rel)], ['references/a.md']);
  assert.ok(optionText(dlg, 'references/a.md').includes('●'));
  assert.ok(!optionText(dlg, 'scripts/run.py').includes('●'));
  const status = q(dlg.el, 'status').textContent;
  assert.ok(status.includes('references/a.md') && status.includes('disk full'));
  assert.deepEqual([...dlg.dirtyFiles()], ['references/a.md']);
});

test('read-only (another user\'s skill): no Save, owner note, editors mounted read-only, nothing writes (RF 5)', async () => {
  const { SE, fa, manager, calls } = load({ files: FILES });
  const dlg = await SE.open({ skill: { dir_name: 'demo', name: 'demo', mine: false, owner_name: 'Alice' }, manager });
  assert.equal(q(dlg.el, 'save'), null);
  assert.match(q(dlg.el, 'note').textContent, /Owned by Alice/);
  assert.equal(fa.last().opts.readOnly, true);
  fa.last().type('changed');
  assert.equal(dlg.dirtyFiles().length, 0);
  await dlg.save();
  assert.equal(calls.writes.length, 0);
});

test('binary files: by sniffing (NUL / invalid UTF-8) open read-only in the binary view; known text stays text', async () => {
  const files = { ...FILES, 'assets/logo.png': new Uint8Array([0x89, 0x50, 0x00, 0x01]), 'data/notes.dat': 'plain text', 'bad.txt': new Uint8Array([0xff, 0xfe, 0x41]) };
  const { SE, fa, manager } = load({ files });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'assets/logo.png');
  assert.equal(fa.last().kind, 'binary');
  assert.equal(fa.last().opts.readOnly, true);
  assert.match(q(dlg.el, 'note').textContent, /Binary/);
  assert.ok(q(dlg.el, 'save'));               // other files can still be saved
  await select(dlg, 'data/notes.dat');
  assert.equal(fa.last().kind, 'code');
  assert.equal(fa.last().text, 'plain text');
  await select(dlg, 'bad.txt');                // invalid UTF-8 even with a text extension: never decoded lossily
  assert.equal(fa.last().kind, 'binary');
  assert.equal(dlg.dirtyFiles().length, 0);
});

test('kindOf / decode helpers', () => {
  const { SE } = load();
  assert.equal(SE.kindOf('SKILL.md'), 'markdown');
  assert.equal(SE.kindOf('references/x.MD'), 'markdown');
  assert.equal(SE.kindOf('scripts/a.py'), 'code');
  assert.equal(SE.isTextExt('a.svg'), true);
  assert.equal(SE.isTextExt('a.png'), false);
  assert.equal(SE.decode(enc.encode('héllo'), 'x.bin'), 'héllo');
  assert.equal(SE.decode(new Uint8Array([0x41, 0x00]), 'x.bin'), null);
  assert.equal(SE.decode(new Uint8Array([0x41, 0x00]), 'x.txt'), 'A\u0000');   // known text: NUL alone is not binary
  assert.equal(SE.decode(new Uint8Array([0xc3]), 'x.txt'), null);
  // a BOM survives decode so a save writes it back
  assert.equal(SE.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'x.md'), '﻿A');
});

test('close with dirty files asks in the app dialog; Keep editing keeps it, Discard closes', async () => {
  const { SE, document, fa, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  fa.last().type('changed');
  q(dlg.el, 'close').click();
  const ask = q(document.body, 'discard');
  assert.ok(ask);
  assert.match(ask.textContent, /Discard changes to 1 file/);
  q(ask, 'discard-keep').click();
  assert.equal(q(document.body, 'discard'), null);
  assert.ok(document.getElementById('skill-editor-modal'));
  q(dlg.el, 'cancel').click();
  q(q(document.body, 'discard'), 'discard-confirm').click();
  assert.equal(document.getElementById('skill-editor-modal'), null);
  assert.equal(q(document.body, 'discard'), null);
  assert.ok(fa.last().destroyed);
});

test('close with no dirty files closes at once', async () => {
  const { SE, document, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  q(dlg.el, 'close').click();
  assert.equal(document.getElementById('skill-editor-modal'), null);
  assert.equal(q(document.body, 'discard'), null);
});

test('opening again replaces an open editor dialog', async () => {
  const { SE, document, manager } = load({ files: FILES });
  await SE.open({ skill: mine, manager });
  await SE.open({ skill: mine, manager });
  assert.equal(document.body.querySelectorAll('[id="skill-editor-modal"]').length, 1);
});

// ---- New Skill ----

const setFront = (dlg, front) => { const ta = q(dlg.el, 'front').querySelector('textarea'); ta.value = front; ta.dispatch('input'); };

test('New Skill: template with name/description/dependencies and a body skeleton; only SKILL.md listed', async () => {
  const { SE, fa, manager } = load();
  const dlg = await SE.open({ skill: null, manager });
  const opts = q(dlg.el, 'file').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(opts, ['SKILL.md']);
  const ta = q(dlg.el, 'front').querySelector('textarea');
  assert.equal(ta.value, 'name:\ndescription:\ndependencies: []\n');
  assert.equal(ta.readOnly, false);
  assert.ok(fa.last().text.trim().startsWith('#'));
  assert.equal(fa.last().opts.readOnly, false);
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
});

test('New Skill validation: empty name, empty description, non-kebab or too long name -> nothing imported', async () => {
  const { SE, manager, calls } = load();
  const dlg = await SE.open({ skill: null, manager });
  for (const [front, re] of [
    ['name:\ndescription: d\n', /Name is required/],
    ['name: my-skill\ndescription:\n', /Description is required/],
    ['name: My Skill\ndescription: d\n', /kebab-case/],
    ['name: my_skill\ndescription: d\n', /kebab-case/],
    [`name: ${'a'.repeat(65)}\ndescription: d\n`, /kebab-case/],
  ]) {
    setFront(dlg, front);
    await dlg.save();
    assert.match(q(dlg.el, 'status').textContent, re, front);
  }
  assert.equal(calls.imports.length, 0);
  assert.deepEqual([...SE.validateNew(`name: ${'a'.repeat(64)}\ndescription: d\n`)], []);
});

test('New Skill: first Save imports privately, then the dialog edits that skill', async () => {
  const { SE, fa, manager, calls, loads } = load();
  const dlg = await SE.open({ skill: null, manager });
  setFront(dlg, 'name: my-skill\ndescription: Does things\ndependencies: []\n');
  fa.last().type('\n# My skill\n');
  await dlg.save();
  assert.equal(calls.imports.length, 1);
  const [read, opts] = calls.imports[0];
  assert.equal(read.dir, 'my-skill');
  assert.equal(read.name, 'my-skill');
  assert.deepEqual(Object.keys(read.files), ['SKILL.md']);
  assert.equal(dec.decode(read.files['SKILL.md']), '---\nname: my-skill\ndescription: Does things\ndependencies: []\n---\n\n# My skill\n');
  assert.deepEqual({ ...read.pyodideWheels }, {});
  assert.deepEqual({ ...read.nativeWheels }, {});
  assert.equal(opts.visibility, 'private');
  assert.equal(loads(), 1);
  assert.equal(manager.lastSkillDir, 'my-skill');
  assert.equal(dlg.dirtyFiles().length, 0);
  assert.match(q(dlg.el, 'title').textContent, /my-skill/);
  // the next save is a plain file write to the new skill
  fa.last().type('\n# My skill v2\n');
  await dlg.save();
  assert.equal(calls.imports.length, 1);
  assert.deepEqual(calls.writes.map((w) => [w[0], w[1]]), [['my-skill', 'SKILL.md']]);
});

test('New Skill: a name clash shows the existing clash message and stays a New Skill', async () => {
  const err = Object.assign(new Error('A different skill named "my-skill" already exists.'), { code: 'clash', skill: 'my-skill' });
  const { SE, manager } = load({ fsOpts: { importErr: err } });
  const dlg = await SE.open({ skill: null, manager });
  setFront(dlg, 'name: my-skill\ndescription: d\n');
  await dlg.save();
  assert.equal(q(dlg.el, 'status').textContent, tr('skills.zip.clash', { name: 'my-skill' }));
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
});

// ---- default adapters (textarea) ----

test('default textarea adapter: mount/getText/onChange/destroy, readOnly honoured', async () => {
  const { SE, document } = load({ fake: false });
  const host = document.createElement('div');
  const a = SE.adapters.code();
  let n = 0;
  await a.mount(host, 'abc', { readOnly: true, rel: 'x.py' });
  a.onChange(() => n++);
  const ta = host.querySelector('textarea');
  assert.equal(ta.value, 'abc');
  assert.equal(ta.readOnly, true);
  ta.value = 'abcd';
  ta.dispatch('input');
  assert.equal(n, 1);
  assert.equal(a.getText(), 'abcd');
  a.destroy();
  assert.equal(host.children.length, 0);
});

test('the real dialog works with the default adapters end to end', async () => {
  const { SE, manager, calls } = load({ files: FILES, fake: false });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'scripts/run.py');
  const ta = q(dlg.el, 'editor').querySelector('textarea');
  ta.value = 'print(9)\n';
  ta.dispatch('input');
  q(dlg.el, 'save').click();
  await dlg.ready();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.writes, [['demo', 'scripts/run.py', 'print(9)\n']]);
});

test('every skills.editor key exists in en, es and fr', () => {
  const langs = ['en', 'es', 'fr'].map((l) => JSON.parse(readFileSync(fileURLToPath(new URL(`../assets/i18n/${l}.json`, import.meta.url)), 'utf8')));
  const keys = [...SRC.matchAll(/tr\('(skills\.[\w.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 10);
  for (const k of keys) for (const L of langs) {
    const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), L);
    assert.equal(typeof v, 'string', k);
  }
});

test('default textarea adapter: a CRLF file is not dirty just by opening, and stays CRLF when edited', async () => {
  const { SE, document } = load({ fake: false });
  const host = document.createElement('div');
  const a = SE.adapters.markdown();
  await a.mount(host, 'a\r\nb\r\n', { readOnly: false, rel: 'x.md' });
  const ta = host.querySelector('textarea');
  ta.value = 'a\nb\n';                        // what a browser textarea reports
  assert.equal(a.getText(), 'a\r\nb\r\n');
  ta.value = 'a\nbc\n';
  assert.equal(a.getText(), 'a\r\nbc\r\n');
});

test('an editor that throws on mount is reported, and the next file still opens', async () => {
  const { SE, fa, manager } = load({ files: FILES });
  const good = SE.adapters.code;
  SE.adapters.markdown = () => ({ mount() { throw new Error('boom'); }, getText: () => '', onChange() {}, destroy() {} });
  const dlg = await SE.open({ skill: mine, manager });
  assert.match(q(dlg.el, 'status').textContent, /boom/);
  await select(dlg, 'scripts/run.py');
  assert.equal(dlg.dirtyFiles().length, 0);   // the failed editor's empty text never replaced the body
  assert.equal(fa.last().kind, 'code');
  assert.equal(SE.adapters.code, good);
});
