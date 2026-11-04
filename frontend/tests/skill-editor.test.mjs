import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skill-editor.js', import.meta.url)), 'utf8');
const SkillFrontmatter = createRequire(import.meta.url)('../assets/js/skill-frontmatter.js');
const MergeBlocksMod = createRequire(import.meta.url)('../assets/js/merge-blocks.js');
const { marked } = createRequire(import.meta.url)('marked');
const MD = { lexer: (s) => marked.lexer(s), parse: (s) => marked.parse(s) };
// the browser module defaults to window.marked; tests pass marked explicitly
const MergeBlocks = {
  merge: (a, b) => MergeBlocksMod.merge(a, b, MD),
  mergeBlocks: (a, b) => MergeBlocksMod.mergeBlocks(a, b, MD),
  diffBlocks: (a, b) => MergeBlocksMod.diffBlocks(a, b, MD),
};
const EN = JSON.parse(readFileSync(fileURLToPath(new URL('../assets/i18n/en.json', import.meta.url)), 'utf8'));
const tr = (k, p = {}) => {
  const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), EN);
  return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, n) => p[n] ?? '') : k;
};
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { ignoreBOM: true });   // keeps a BOM, so tests see the bytes written

import { makeDom } from './fixtures/dom-stub.mjs';

/** files: { rel: string | Uint8Array }; opts.fail: Set of rels whose write throws */
function makeFs(files, { fail = new Set(), importErr = null, installed = null } = {}) {
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
  // installed: skill paths the Skills list knows (the Required skills warning); null = no listSkills
  if (installed) fs.listSkills = async () => installed.map((p) => ({ path: p, dirName: p, leafName: p.split('/').pop(), name: p.split('/').pop() }));
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
  return { mounts, adapters: { markdown: make('markdown'), markdownSource: make('markdownSource'), code: make('code'), binary: make('binary') }, last: () => mounts[mounts.length - 1] };
}

const PASS = async () => ({ ok: true, changes: [], reason: '', error: '' });

/**
 * check: the open-time markdown check (default: every file passes -> the formatted adapter, kind 'markdown').
 * autoChanges: click [Save] in the "Changes to be saved" view as soon as it opens (false: the test drives it).
 */
function load({ files = {}, fsOpts, fake = true, check = PASS, autoChanges = true } = {}) {
  const document = makeDom();
  const { fs, calls, disk } = makeFs(files, fsOpts);
  const window = { skillsFs: fs, SkillFrontmatter, MergeBlocks, i18n: { t: tr }, document };
  const ctx = vm.createContext({ window, document, console, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, Promise });
  vm.runInContext(SRC, ctx);
  const SE = window.SkillEditor;
  const fa = fakeAdapters();
  if (fake) Object.assign(SE.adapters, fa.adapters);
  const checks = [];
  if (check) SE.checkMarkdown = (md) => { checks.push(md); return check(md); };
  const changesViews = [];
  const append = document.body.appendChild.bind(document.body);
  document.body.appendChild = (el) => {
    append(el);
    if (el.getAttribute && el.getAttribute('data-se') === 'changes') {
      changesViews.push(el.textContent);
      if (autoChanges) q(el, 'changes-save').click();
    }
    return el;
  };
  let loads = 0;
  const manager = { loadTree: async () => { loads++; } };
  return { SE, document, calls, disk, fa, manager, loads: () => loads, checks, changesViews };
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
  assert.equal(q(dlg.el, 'fm-description').value, 'folded text');   // the frontmatter form
  assert.equal(q(dlg.el, 'fm-name').readOnly, false);
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
  assert.equal(SE.decode(new Uint8Array([0x41, 0x00]), 'x.txt'), null);   // a NUL byte is binary for every extension
  assert.equal(SE.decode(new Uint8Array([0x41, 0x00]), 'x.md'), null);
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

const setField = (dlg, key, v) => { const el = q(dlg.el, 'fm-' + key); el.value = v; el.dispatch('input'); };

test('New Skill: template with name/description/dependencies and a body skeleton; only SKILL.md listed', async () => {
  const { SE, fa, manager } = load();
  const dlg = await SE.open({ skill: null, manager });
  const opts = q(dlg.el, 'file').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(opts, ['SKILL.md']);
  assert.equal(dlg.files.get('SKILL.md').front, 'name:\ndescription:\ndependencies: []\n');
  assert.equal(q(dlg.el, 'fm-name').value, '');
  assert.equal(q(dlg.el, 'fm-name').readOnly, false);
  assert.equal(q(dlg.el, 'fm-panel').open, true);       // open for New Skill
  assert.ok(fa.last().text.trim().startsWith('#'));
  assert.equal(fa.last().opts.readOnly, false);
  assert.deepEqual([...dlg.dirtyFiles()], []);          // untouched template: nothing to discard
});

test('New Skill validation: empty name, empty description, non-kebab or too long name -> nothing imported', async () => {
  const { SE, manager, calls } = load();
  const dlg = await SE.open({ skill: null, manager });
  for (const [name, desc, re] of [
    ['', 'd', /Name is required/],
    ['my-skill', '', /Description is required/],
    ['My Skill', 'd', /kebab-case/],
    ['my_skill', 'd', /kebab-case/],
    ['a'.repeat(65), 'd', /kebab-case/],
  ]) {
    setField(dlg, 'name', name);
    setField(dlg, 'description', desc);
    await dlg.save();
    assert.match(q(dlg.el, 'status').textContent, re, name + '|' + desc);
  }
  assert.equal(calls.imports.length, 0);
  assert.deepEqual([...SE.validateNew(`name: ${'a'.repeat(64)}\ndescription: d\n`)], []);
});

test('New Skill: first Save imports privately, then the dialog edits that skill', async () => {
  const { SE, fa, manager, calls, loads } = load();
  const dlg = await SE.open({ skill: null, manager });
  setField(dlg, 'name', 'my-skill');
  setField(dlg, 'description', 'Does things');
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
  setField(dlg, 'name', 'my-skill');
  setField(dlg, 'description', 'd');
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
  const keys = [...SRC.matchAll(/'(skills\.editor\.[\w.]+)'/g), ...SRC.matchAll(/tr\('(skills\.[\w.]+)'/g)].map((m) => m[1]);
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
  SE.adapters.code = () => ({ mount() { throw new Error('boom'); }, getText: () => '', onChange() {}, destroy() {} });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'scripts/run.py');
  assert.match(q(dlg.el, 'status').textContent, /boom/);
  assert.equal(dlg.dirtyFiles().length, 0);   // the failed editor's empty text never replaced the file
  await select(dlg, 'references/a.md');
  assert.equal(fa.last().kind, 'markdown');
  assert.equal(fa.last().text, '# A\n');
});

// ---- Task 5: per-file markdown choice, "Changes to be saved", review minors ----

const FAIL = async () => ({ ok: false, changes: [{ before: '| a |\n', after: '| a  |\n' }], reason: '', error: '' });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('open-time check passes -> the formatted editor; the check gets the BODY of SKILL.md and the text of other .md', async () => {
  const { SE, fa, manager, checks } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fa.last().kind, 'markdown');
  assert.equal(q(dlg.el, 'why'), null);
  await select(dlg, 'references/a.md');
  assert.equal(fa.last().kind, 'markdown');
  await select(dlg, 'SKILL.md');
  assert.deepEqual(checks, ['\n# Demo\n\nBody.\n', '# A\n']);   // once per file, cached across switches
});

test('open-time check fails -> the markdown pane, the note and a Why? list of the blocks that would change', async () => {
  const { SE, fa, manager } = load({ files: FILES, check: FAIL });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fa.last().kind, 'markdownSource');
  assert.equal(fa.last().text, '\n# Demo\n\nBody.\n');
  const note = q(dlg.el, 'note');
  assert.match(note.textContent, /This file opens as markdown: the formatted editor would change parts of it\./);
  const why = q(note, 'why-list');
  assert.equal(why.hidden, true);
  q(note, 'why').click();
  assert.equal(why.hidden, false);
  assert.equal(why.querySelectorAll('[data-se="change"]').length, 1);
  assert.match(why.textContent, /\| a \|[\s\S]*\| a {2}\|/);
});

test('open-time check throws -> the markdown pane; Why? says the formatted editor could not run', async () => {
  const { SE, fa, manager } = load({ files: FILES, check: async () => { throw new Error('esm.sh unreachable'); } });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fa.last().kind, 'markdownSource');
  assert.match(q(q(dlg.el, 'note'), 'why-list').textContent, /esm\.sh unreachable/);
});

test('the formatted editor failing to mount falls back to the markdown pane with the reason', async () => {
  const { SE, fa, manager } = load({ files: FILES });
  SE.adapters.markdown = () => ({ mount() { throw new Error('milkdown failed'); }, getText: () => '', onChange() {}, destroy() {} });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fa.last().kind, 'markdownSource');
  assert.match(q(dlg.el, 'note').textContent, /opens as markdown/);
  assert.match(q(q(dlg.el, 'note'), 'why-list').textContent, /milkdown failed/);
  assert.equal(q(dlg.el, 'status').textContent, '');
});

test('Changes to be saved lists only the changed blocks; Back writes nothing and keeps the dot', async () => {
  const body = '\n# Demo\n\nKeep this.\n\nBody.\n\n- a\n- b\n';
  const { SE, fa, manager, calls, document } = load({ files: { 'SKILL.md': '---\nname: demo\ndescription: d\n---\n' + body }, autoChanges: false });
  const dlg = await SE.open({ skill: mine, manager });
  fa.last().type(body.replace('Body.', 'Body EDIT.'));
  const saving = dlg.save();
  await tick();
  const view = q(document.body, 'changes');
  assert.ok(view);
  const ch = view.querySelectorAll('[data-se="change"]');
  assert.equal(ch.length, 1);
  assert.match(ch[0].textContent, /Body\.[\s\S]*Body EDIT\./);
  assert.ok(!view.textContent.includes('Keep this'));
  assert.equal(q(dlg.el, 'save').disabled, true);         // no second save while one runs
  q(view, 'changes-back').click();
  const r = await saving;
  assert.equal(r.cancelled, true);
  assert.equal(calls.writes.length, 0);
  assert.ok(optionText(dlg, 'SKILL.md').includes('●'));
  assert.equal(q(dlg.el, 'save').disabled, false);
  // [Save] writes it
  const again = dlg.save();
  await tick();
  q(q(document.body, 'changes'), 'changes-save').click();
  await again;
  assert.equal(calls.writes.length, 1);
  assert.ok(calls.writes[0][2].endsWith('Keep this.\n\nBody EDIT.\n\n- a\n- b\n'));
  assert.equal(q(document.body, 'changes'), null);
});

test('markdown-pane saves write as typed, without the changes view', async () => {
  const { SE, fa, manager, calls, changesViews } = load({ files: FILES, check: FAIL });
  const dlg = await SE.open({ skill: mine, manager });
  fa.last().type('\n# Demo\n\nBody _typed_.\n');
  await dlg.save();
  assert.equal(changesViews.length, 0);
  assert.ok(calls.writes[0][2].endsWith('\n# Demo\n\nBody _typed_.\n'));
});

test('a refused merge (reference definitions) shows the WHOLE file and says so', async () => {
  const md = 'see [x]\n\n[x]: http://a\n';
  const { SE, fa, manager, calls, changesViews } = load({ files: { 'SKILL.md': SKILL_MD, 'references/r.md': md } });
  const dlg = await SE.open({ skill: mine, manager });
  await select(dlg, 'references/r.md');
  fa.last().type('see [x] EDIT\n\n[x]: http://a\n');
  await dlg.save();
  assert.equal(changesViews.length, 1);
  assert.match(changesViews[0], /cannot be compared block by block/);
  assert.match(changesViews[0], /see \[x\]\n\n\[x\]: http:\/\/a[\s\S]*see \[x\] EDIT/);
  assert.equal(calls.writes.length, 1);
});

test('only the frontmatter changed in a formatted file: the changes view lists only the frontmatter lines', async () => {
  const { SE, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  setField(dlg, 'name', 'demo2');
  const r = dlg.reviews([dlg.files.get('SKILL.md')]);
  assert.equal(r.length, 1);
  assert.equal(JSON.stringify(r[0].changes.map((c) => [c.before, c.after])), JSON.stringify([['name: demo\n', 'name: demo2\n']]));
});

test('an untouched New Skill closes without the discard prompt; a touched one asks', async () => {
  const { SE, document, fa, manager } = load();
  let dlg = await SE.open({ skill: null, manager });
  q(dlg.el, 'close').click();
  assert.equal(q(document.body, 'discard'), null);
  assert.equal(document.getElementById('skill-editor-modal'), null);
  dlg = await SE.open({ skill: null, manager });
  fa.last().type('\n# Something\n');
  q(dlg.el, 'close').click();
  assert.ok(q(document.body, 'discard'));
});

test('a BOM-prefixed SKILL.md: the BOM is off for split, the body has none, and a save writes it back', async () => {
  const text = '﻿---\nname: demo\ndescription: d\n---\n\n# Demo\n';
  const { SE, fa, manager, calls } = load({ files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fa.last().text, '\n# Demo\n');
  assert.equal(q(dlg.el, 'fm-name').value, 'demo');
  assert.equal(dlg.dirtyFiles().length, 0);
  fa.last().type('\n# Demo 2\n');
  await dlg.save();
  assert.equal(calls.writes[0][2], '﻿---\nname: demo\ndescription: d\n---\n\n# Demo 2\n');
});

test('open() while a dialog has unsaved edits goes through the discard prompt', async () => {
  const { SE, document, fa, manager } = load({ files: FILES });
  const first = await SE.open({ skill: mine, manager });
  fa.last().type('changed');
  const p = SE.open({ skill: mine, manager });
  await tick();
  q(q(document.body, 'discard'), 'discard-keep').click();
  assert.equal(await p, first);                 // kept editing: the same dialog, still open
  assert.ok(document.getElementById('skill-editor-modal'));
  const p2 = SE.open({ skill: mine, manager });
  await tick();
  q(q(document.body, 'discard'), 'discard-confirm').click();
  const second = await p2;
  assert.notEqual(second, first);
  assert.equal(first.closed, true);
  assert.equal(document.body.querySelectorAll('[id="skill-editor-modal"]').length, 1);
});

test('closing while a file is still loading: nothing mounts afterwards; mounted editors are destroyed', async () => {
  const { SE, fa, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  let release;
  const gate = new Promise((r) => { release = r; });
  const orig = dlg.fs.getSkillFileBytes;
  dlg.fs = { ...dlg.fs, getSkillFileBytes: async (...a) => { await gate; return orig(...a); } };
  const n = fa.mounts.length;
  const switching = dlg.show('references/a.md');
  const queued = dlg.show('scripts/run.py');
  await tick();
  dlg.close();
  assert.ok(fa.mounts.every((m) => m.destroyed));
  release();
  await switching; await queued;
  assert.equal(fa.mounts.length, n, 'no editor mounted after close');
});

test('keepLineEnds: CRLF stays CRLF, LF stays LF; a mixed file is returned as loaded until edited, then saved with \\n', () => {
  const { SE } = load();
  const k = SE.keepLineEnds;
  assert.equal(k('a\r\nb\r\n', 'a\nb\n'), 'a\r\nb\r\n');
  assert.equal(k('a\r\nb\r\n', 'a\nbc\n'), 'a\r\nbc\r\n');
  assert.equal(k('a\nb\n', 'a\nbc\n'), 'a\nbc\n');
  const mixed = 'a\r\nb\nc\rd\n';
  assert.equal(k(mixed, 'a\nb\nc\nd\n'), mixed);             // untouched: as loaded, never dirty
  assert.equal(k(mixed, 'a\nb\nc\nd!\n'), 'a\nb\nc\nd!\n');  // edited: no one style to restore -> \n
  assert.equal(k('a\rb\r', 'a\nb!\n'), 'a\nb!\n');           // lone CR is not CRLF
});

// ---- Task 7: the frontmatter form ----

const RICH_FRONT = [
  '# kept comment',
  'name: rich',
  'description: |',
  '  Line one: with a colon.',
  '  Line two.',
  '',
  'license: MIT',
  'dependencies:',
  '  - python-docx',
  '  - "openpyxl>=3"',
  'allowed-tools: run_skill_script, save_playbook_agent',
  'metadata:',
  '  origin: synergyAI custom',
  '  version: 1.0.0',
  'fetches_urls: false',
  '',
].join('\n');
const RICH = `---\n${RICH_FRONT}---\n\n# Rich\n\nBody.\n`;
const richSkill = { dir_name: 'rich', name: 'rich', mine: true };
const fmEl = (dlg, key) => q(dlg.el, 'fm-' + key);

test('RF 1: editing one field rewrites only its line; block-scalar description, multi-line list, comment stay byte-identical', async () => {
  const { SE, manager, calls, changesViews } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  assert.equal(fmEl(dlg, 'description').value, 'Line one: with a colon.\nLine two.');
  assert.equal(fmEl(dlg, 'dependencies').value, 'python-docx\nopenpyxl>=3');   // one per line
  setField(dlg, 'license', 'Apache-2.0');
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
  assert.ok(optionText(dlg, 'SKILL.md').includes('●'));
  await dlg.save();
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0][2], RICH.replace('license: MIT\n', 'license: Apache-2.0\n'));
  assert.equal(changesViews.length, 1);
  assert.match(changesViews[0], /license: MIT[\s\S]*license: Apache-2\.0/);
  assert.ok(!changesViews[0].includes('python-docx'));
  // the form's baseline is now the saved file: nothing left to save
  assert.equal(dlg.dirtyFiles().length, 0);
  await dlg.save();
  assert.equal(calls.writes.length, 1);
});

test('untouched form (change events, values typed back) + untouched body: SKILL.md bytes unchanged, nothing written', async () => {
  const { SE, manager, calls, fa } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  for (const k of ['name', 'description', 'license', 'dependencies', 'allowed-tools', 'requires-skills']) {
    const el = fmEl(dlg, k);
    const v = el.value;
    el.value = v + 'x'; el.dispatch('input');
    el.value = v; el.dispatch('input');
  }
  fa.last().cb();
  assert.equal(dlg.files.get('SKILL.md').current, RICH);
  assert.equal(dlg.dirtyFiles().length, 0);
  await dlg.save();
  assert.equal(calls.writes.length, 0);
});

test('a clip block-scalar description (value ends in \\n) is not rewritten when untouched and another field is edited', async () => {
  const text = '---\nname: demo\ndescription: >\n  folded\n  text\nlicense: MIT\n---\nBody\n';
  const { SE, manager, calls } = load({ files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: mine, manager });
  setField(dlg, 'name', 'demo-2');
  await dlg.save();
  assert.equal(calls.writes[0][2], text.replace('name: demo\n', 'name: demo-2\n'));
});

test('clearing an optional field removes it (scalar and multi-line list)', async () => {
  const { SE, manager, calls } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  setField(dlg, 'license', '  ');
  setField(dlg, 'dependencies', '');
  await dlg.save();
  assert.equal(calls.writes[0][2], RICH.replace('license: MIT\n', '').replace('dependencies:\n  - python-docx\n  - "openpyxl>=3"\n', ''));
});

test('empty name / description: inline error, Save blocked, the dot stays', async () => {
  const { SE, manager, calls } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  setField(dlg, 'name', '');
  assert.match(q(dlg.el, 'fm-name-error').textContent, /Name is required/);
  assert.equal(q(dlg.el, 'fm-name-error').hidden, false);
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
  await dlg.save();
  assert.equal(calls.writes.length, 0);
  assert.match(q(dlg.el, 'status').textContent, /Name is required/);
  assert.equal(q(dlg.el, 'fm-panel').open, true);       // the error is visible
  setField(dlg, 'name', 'rich');
  setField(dlg, 'description', '');
  assert.equal(q(dlg.el, 'fm-name-error').hidden, true);
  await dlg.save();
  assert.match(q(dlg.el, 'status').textContent, /Description is required/);
  assert.equal(calls.writes.length, 0);
});

test('Required skills: a name not installed warns under the field; the save still happens and refreshes the list', async () => {
  const { SE, manager, calls, loads } = load({ files: { 'SKILL.md': RICH }, fsOpts: { installed: ['docx', 'office/xlsx'] } });
  const dlg = await SE.open({ skill: richSkill, manager });
  await tick();
  setField(dlg, 'requires-skills', 'docx\n xlsx\n\nnope-skill\n');
  const warn = q(dlg.el, 'fm-requires-skills-warning');
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /nope-skill/);
  assert.ok(!/docx|xlsx/.test(warn.textContent));
  await dlg.save();
  assert.equal(calls.writes[0][2], RICH.replace('---\n\n# Rich', 'requires-skills: [docx, xlsx, nope-skill]\n---\n\n# Rich'));
  assert.equal(loads(), 1);
  setField(dlg, 'requires-skills', 'docx');
  assert.equal(q(dlg.el, 'fm-requires-skills-warning').hidden, true);
});

test('allowed tools keep their shape: a comma scalar stays a scalar, a list stays a list', async () => {
  const { SE, manager, calls } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  setField(dlg, 'allowed-tools', 'run_skill_script,  web_fetch');
  await dlg.save();
  assert.ok(calls.writes[0][2].includes('\nallowed-tools: run_skill_script, web_fetch\n'));
  const listed = '---\nname: a\ndescription: d\nallowed-tools:\n  - x\n---\n';
  const r2 = load({ files: { 'SKILL.md': listed } });
  const d2 = await r2.SE.open({ skill: { dir_name: 'a', mine: true }, manager: r2.manager });
  assert.equal(q(d2.el, 'fm-allowed-tools').value, 'x');
  setField(d2, 'allowed-tools', 'x, z');
  await d2.save();
  assert.equal(r2.calls.writes[0][2], '---\nname: a\ndescription: d\nallowed-tools: [x, z]\n---\n');
});

test('collapsed by default for an existing skill, with a one-line summary; other fields listed read-only, kept as is', async () => {
  const { SE, manager } = load({ files: { 'SKILL.md': RICH.replace('license: MIT\n', 'license: MIT\nrequires-skills: [a, b]\n') } });
  const dlg = await SE.open({ skill: richSkill, manager });
  assert.equal(q(dlg.el, 'fm-panel').open, false);
  assert.equal(q(dlg.el, 'fm-summary').textContent, 'rich · Python libraries: 2 · Required skills: 2');
  const other = q(dlg.el, 'fm-other');
  assert.match(other.textContent, /metadata:\n {2}origin: synergyAI custom/);
  assert.match(other.textContent, /fetches_urls: false/);
  assert.match(other.textContent, /Kept as is/);
  assert.ok(!/license|python-docx/.test(other.textContent));
  assert.equal(fmEl(dlg, 'origin'), null);   // origin lives under metadata: shown there, not as its own field
  setField(dlg, 'dependencies', 'a');
  assert.equal(q(dlg.el, 'fm-summary').textContent, 'rich · Python libraries: 1 · Required skills: 2');
});

test('a field the parser marks complex (plain scalar with ": ") is read-only under Other fields and never rewritten', async () => {
  const text = '---\nname: demo\ndescription: Use it: always\nlicense: MIT\n---\nB\n';
  const { SE, manager, calls } = load({ files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: mine, manager });
  assert.equal(fmEl(dlg, 'description'), null);
  assert.match(q(dlg.el, 'fm-other').textContent, /description: Use it: always/);
  setField(dlg, 'license', 'BSD');
  await dlg.save();
  assert.equal(calls.writes[0][2], text.replace('MIT', 'BSD'));
});

test('form edits survive switching files; a top-level origin is an editable field', async () => {
  const text = '---\nname: demo\ndescription: d\norigin: here\n---\nB\n';
  const { SE, manager, calls } = load({ files: { 'SKILL.md': text, 'scripts/run.py': 'x\n' } });
  const dlg = await SE.open({ skill: mine, manager });
  setField(dlg, 'origin', 'there');
  await select(dlg, 'scripts/run.py');
  assert.ok(optionText(dlg, 'SKILL.md').includes('●'));
  await select(dlg, 'SKILL.md');
  assert.equal(fmEl(dlg, 'origin').value, 'there');
  await dlg.save();
  assert.equal(calls.writes[0][2], text.replace('origin: here', 'origin: there'));
});

test('read-only skill: the form is read-only, nothing writes; the name hint is shown', async () => {
  const { SE, manager, calls } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: { ...richSkill, mine: false, owner_name: 'Bob' }, manager });
  assert.equal(fmEl(dlg, 'name').readOnly, true);
  assert.equal(fmEl(dlg, 'description').readOnly, true);
  setField(dlg, 'name', 'x');
  await dlg.save();
  assert.equal(calls.writes.length, 0);
  assert.match(q(dlg.el, 'fm-panel').textContent, /does not rename the folder/);
});

test('description expand overlay edits the description', async () => {
  const { SE, manager, document } = load({ files: { 'SKILL.md': RICH } });
  const dlg = await SE.open({ skill: richSkill, manager });
  q(dlg.el, 'fm-description-expand').click();
  const ov = q(document.body, 'fm-description-overlay');
  const ta = ov.querySelector('textarea');
  assert.equal(ta.value, 'Line one: with a colon.\nLine two.');
  ta.value = 'New description.';
  q(ov, 'fm-description-overlay-close').click();
  assert.equal(q(document.body, 'fm-description-overlay'), null);
  assert.equal(fmEl(dlg, 'description').value, 'New description.');
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
  assert.ok(dlg.files.get('SKILL.md').current.includes('\ndescription: New description.\n\nlicense: MIT\n'))   // the span's trailing blank line stays;
});

test('New Skill: the form is open and the folder hint is not shown (the name becomes the folder)', async () => {
  const { SE, manager } = load();
  const dlg = await SE.open({ skill: null, manager });
  assert.equal(q(dlg.el, 'fm-panel').open, true);
  assert.ok(!/does not rename/.test(q(dlg.el, 'fm-panel').textContent));
  assert.equal(q(dlg.el, 'fm-other'), null);
});

// ---- fix round 1: one item per line, whitespace-only edits, hints, summary ----

test('dependencies: one per line; editing one item keeps an untouched range spec (numpy>=1.20,<2) as ONE item', async () => {
  const text = '---\nname: d\ndescription: x\ndependencies: [pandas, \'numpy>=1.20,<2\']\n---\n';
  const { SE, manager, calls } = load({ files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: { dir_name: 'd', mine: true }, manager });
  assert.equal(fmEl(dlg, 'dependencies').value, 'pandas\nnumpy>=1.20,<2');
  assert.equal(fmEl(dlg, 'dependencies').tagName, 'TEXTAREA');
  setField(dlg, 'dependencies', 'pandas>=2\nnumpy>=1.20,<2');
  await dlg.save();
  assert.equal(calls.writes[0][2], text.replace("[pandas, 'numpy>=1.20,<2']", "[pandas>=2, 'numpy>=1.20,<2']"));
  const back = SkillFrontmatter.fields(SkillFrontmatter.split(calls.writes[0][2]).front).find((f) => f.key === 'dependencies').value;
  assert.equal(JSON.stringify(back), JSON.stringify(['pandas>=2', 'numpy>=1.20,<2']));
});

test('a range and an extras spec can be entered as new items', async () => {
  const { SE, manager, calls } = load({ files: { 'SKILL.md': '---\nname: d\ndescription: x\n---\n' } });
  const dlg = await SE.open({ skill: { dir_name: 'd', mine: true }, manager });
  setField(dlg, 'dependencies', 'scipy>=1,<2\nrequests[socks,security]');
  await dlg.save();
  const back = SkillFrontmatter.fields(SkillFrontmatter.split(calls.writes[0][2]).front).find((f) => f.key === 'dependencies').value;
  assert.equal(JSON.stringify(back), JSON.stringify(['scipy>=1,<2', 'requests[socks,security]']));
});

test('whitespace-only edits never rewrite a field (> description, comma-scalar allowed-tools, list items)', async () => {
  const text = '---\nname: demo\ndescription: >\n  folded\n  text\nallowed-tools: run_skill_script, save_playbook_agent\ndependencies:\n  - a\n---\nB\n';
  const { SE, manager, calls } = load({ files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: mine, manager });
  setField(dlg, 'description', 'folded text  ');
  setField(dlg, 'allowed-tools', 'run_skill_script,save_playbook_agent ');
  setField(dlg, 'dependencies', '  a  \n\n');
  setField(dlg, 'name', ' demo ');
  assert.equal(dlg.files.get('SKILL.md').current, text);
  assert.equal(dlg.dirtyFiles().length, 0);
  await dlg.save();
  assert.equal(calls.writes.length, 0);
});

test('the description says it is saved on one line', async () => {
  const { SE, manager } = load({ files: FILES });
  const dlg = await SE.open({ skill: mine, manager });
  assert.match(q(dlg.el, 'fm-panel').textContent, /Saved on one line\./);
});
