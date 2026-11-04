// skill-md-editor.js with a stubbed Milkdown (no network) and a stubbed CodeMirror: the open-time check, the formatted
// adapter's Show source / Show formatted toggle (never an edit by itself), the merge on getText, the toolbar commands,
// and the markdown pane's CRLF guard. The real Milkdown is exercised by tools/md-roundtrip/run.mjs --editor milkdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeDom } from './fixtures/dom-stub.mjs';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const EDITOR_SRC = read('../assets/js/skill-editor.js');
const MD_SRC = read('../assets/js/skill-md-editor.js');
const SkillFrontmatter = require('../assets/js/skill-frontmatter.js');
const MB = require('../assets/js/merge-blocks.js');
const { marked } = require('marked');
const M = { lexer: (s) => marked.lexer(s), parse: (s) => marked.parse(s) };
const MergeBlocks = { merge: (a, b) => MB.merge(a, b, M), mergeBlocks: (a, b) => MB.mergeBlocks(a, b, M), diffBlocks: (a, b) => MB.diffBlocks(a, b, M) };
const EN = JSON.parse(read('../assets/i18n/en.json'));
const tr = (k, p = {}) => {
  const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), EN);
  return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, n) => p[n] ?? '') : k;
};
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A stand-in for the Milkdown modules. serialise(md) = what "Milkdown" writes back for a document loaded from md
 * (default: tables padded, a Milkdown-like rewrite). ed.type(md) simulates the user editing: the document changes and
 * the editor's markdown becomes md.
 */
function fakeMilkdown({ serialise = (md) => md, failCreate = false } = {}) {
  const log = { created: [], destroyed: 0, commands: [], dispatched: [], stringify: [], readOnly: [] };
  const key = (k) => ({ key: k });
  const core = {
    rootCtx: 'root', defaultValueCtx: 'default', remarkStringifyOptionsCtx: 'stringify', editorViewOptionsCtx: 'viewOpts',
    editorViewCtx: 'view', commandsCtx: 'commands',
    Editor: {
      make() {
        const conf = { values: {}, plugins: [] };
        const ctxCfg = {
          set: (k, v) => { conf.values[k] = v; },
          update: (k, f) => { conf.values[k] = f(conf.values[k] || {}); },
        };
        const b = {
          config(fn) { fn(ctxCfg); return b; },
          use(p) { conf.plugins.push(p); return b; },
          async create() {
            if (failCreate) throw new Error('milkdown create failed');
            const md0 = conf.values.default;
            log.stringify.push(conf.values.stringify);
            log.readOnly.push(!!(conf.values.viewOpts && conf.values.viewOpts.editable && !conf.values.viewOpts.editable()));
            const views = conf.plugins.filter((p) => p && p.prose).map((p) => p.prose().spec.view());
            let md = serialise(md0);
            const doc = { eq: (o) => o === doc };
            const view = {
              state: { doc, selection: { empty: true, $from: { depth: 0 } }, tr: {}, schema: {} },
              focus() {}, dispatch: (t) => log.dispatched.push(t),
            };
            const ctx = { md: () => md, get: (k) => (k === 'view' ? view : k === 'commands' ? { call: (c) => log.commands.push([c]) } : null) };
            const ed = {
              root: conf.values.root, loadedFrom: md0,
              action: (fn) => fn(ctx),
              async destroy() { log.destroyed++; },
              type(next) {
                md = next;
                const prev = { doc };
                view.state = { ...view.state, doc: { eq: () => false } };
                for (const v of views) v.update(view, prev);
              },
            };
            log.created.push(ed);
            return ed;
          },
        };
        return b;
      },
    },
  };
  const commonmark = {
    commonmark: { name: 'commonmark' },
    toggleStrongCommand: key('strong'), toggleEmphasisCommand: key('emphasis'), wrapInBulletListCommand: key('bullet'),
    wrapInOrderedListCommand: key('ordered'), wrapInHeadingCommand: key('heading'), turnIntoTextCommand: key('text'),
    createCodeBlockCommand: key('code'), toggleLinkCommand: key('link'),
  };
  const gfm = { gfm: { name: 'gfm' }, insertTableCommand: key('table') };
  const utils = {
    $prose: (fn) => ({ prose: fn }),
    callCommand: (k, payload) => () => log.commands.push([k, payload]),
    getMarkdown: () => (ctx) => ctx.md(),
  };
  const state = { Plugin: class { constructor(spec) { this.spec = spec; } } };
  return { lib: { core, commonmark, gfm, utils, state }, log };
}

/** CodeMirror 5 stand-in: getValue() reports \n line ends, like the real one. */
function fakeCodeMirror() {
  const made = [];
  function CodeMirror(el, opts) {
    let value = String(opts.value).replace(/\r\n?/g, '\n');
    const handlers = [];
    const cm = {
      opts, el,
      getValue: () => value,
      on: (ev, f) => { if (ev === 'change') handlers.push(f); },
      setSize() {},
      type(v) { value = v; handlers.forEach((f) => f()); },
    };
    made.push(cm);
    return cm;
  }
  return { CodeMirror, made };
}

function load({ milkdown = fakeMilkdown(), cm = fakeCodeMirror(), files = null } = {}) {
  const document = makeDom();
  const disk = {};
  const writes = [];
  for (const [r, v] of Object.entries(files || {})) disk[r] = enc.encode(v);
  const fs = {
    listSkillFiles: async () => Object.keys(disk).map((rel) => ({ rel, size: disk[rel].length })),
    getSkillFileBytes: async (_p, rel) => disk[rel] || null,
    writeSkillFile: async (_p, rel, bytes) => { writes.push([rel, dec.decode(bytes)]); disk[rel] = bytes; },
  };
  const window = { document, MergeBlocks, SkillFrontmatter, skillsFs: fs, i18n: { t: tr }, CodeMirror: cm.CodeMirror };
  const ctx = vm.createContext({ window, document, console, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, Promise });
  vm.runInContext(EDITOR_SRC, ctx);
  vm.runInContext(MD_SRC, ctx);
  window.SkillMdEditor.load = async () => milkdown.lib;
  // the dialog's "Changes to be saved" view: press [Save] when it opens
  const views = [];
  const append = document.body.appendChild.bind(document.body);
  document.body.appendChild = (el) => {
    append(el);
    if (el.getAttribute && el.getAttribute('data-se') === 'changes') { views.push(el.textContent); el.querySelector('[data-se="changes-save"]').click(); }
    return el;
  };
  return { window, document, SE: window.SkillEditor, SM: window.SkillMdEditor, milkdown, cm, writes, views };
}
const md = (root, k) => root.querySelector(`[data-md="${k}"]`);
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('installs itself as the markdown adapters and the open-time check', () => {
  const { SE, SM } = load();
  assert.equal(SE.adapters.markdown, SM.formattedAdapter);
  assert.equal(SE.adapters.markdownSource, SM.sourceAdapter);
  assert.equal(typeof SE.checkMarkdown, 'function');
  assert.match(SM.URLS[0], /^https:\/\/esm\.sh\/@milkdown\/kit@7\.23\.0\/core$/);
  assert.ok(SM.URLS.every((u) => u.startsWith('https://esm.sh/@milkdown/kit@7.23.0/')));
});

test('check: the round trip merged back to the original -> ok; tuned options are used; the hidden editor is gone', async () => {
  const { SM, milkdown, document } = load({ milkdown: fakeMilkdown({ serialise: (s) => s.replace('* a', '- a') }) });
  const r = await SM.check('# T\n\n* a\n');
  assert.deepEqual({ ...r, changes: [...r.changes] }, { ok: true, changes: [], reason: '', error: '' });
  assert.equal(milkdown.log.stringify[0].bullet, '-');
  assert.equal(milkdown.log.stringify[0].listItemIndent, 'one');
  assert.equal(milkdown.log.destroyed, 1);
  assert.equal(document.body.children.length, 0);
});

test('check: blocks the editor would change -> not ok, with those blocks listed', async () => {
  const { SM } = load({ milkdown: fakeMilkdown({ serialise: (s) => s.replace('a <u>b</u>', 'a b') }) });
  const r = await SM.check('# T\n\na <u>b</u>\n\nend\n');
  assert.equal(r.ok, false);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].before, 'a <u>b</u>\n\n');   // Milkdown drops unknown inline html
  assert.equal(r.changes[0].after, 'a b\n\n');
});

test('check: a throw (e.g. Milkdown does not load) is a failure with the message', async () => {
  const { SM } = load();
  SM.load = async () => { throw new Error('offline'); };
  const r = await SM.check('x\n');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'offline');
});

test('formatted adapter: Show source / Show formatted twice without typing -> same text, no change event (RF 2)', async () => {
  const text = '# T\n\n* odd  spacing kept\n';
  const { SM, document, milkdown, cm } = load({ milkdown: fakeMilkdown({ serialise: (s) => s.replace('* odd  spacing', '- odd spacing') }) });
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await a.mount(host, text, { readOnly: false, rel: 'x.md' });
  let changes = 0;
  a.onChange(() => changes++);
  assert.equal(a.getText(), text);
  const toggle = md(host, 'toggle');
  assert.equal(toggle.textContent, 'Show source');
  await a.toggle();
  assert.equal(a.mode, 'source');
  assert.equal(toggle.textContent, 'Show formatted');
  assert.equal(cm.made.at(-1).getValue(), text);          // the pane holds the (merged) markdown
  assert.equal(md(host, 'formatted'), null);             // never a second pane
  assert.equal(a.getText(), text);
  await a.toggle();
  assert.equal(a.mode, 'formatted');
  assert.equal(md(host, 'source'), null);
  await a.toggle(); await a.toggle();
  await wait();
  assert.equal(a.getText(), text);
  assert.equal(changes, 0);
  assert.equal(milkdown.log.created.length, 3);
  assert.equal(milkdown.log.destroyed, 2);               // each Milkdown left is destroyed
  a.destroy();
  await wait(0);
  assert.equal(milkdown.log.destroyed, 3);
  assert.equal(host.children.length, 0);
});

test('formatted adapter: an edit -> mergeBlocks(base, markdown): untouched blocks keep their bytes', async () => {
  const text = '# T\n\n* a\n* b\n\nold\n';
  const { SM, document, milkdown } = load({ milkdown: fakeMilkdown({ serialise: (s) => s.replace(/^\* /gm, '- ') }) });
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await a.mount(host, text, {});
  let changes = 0;
  a.onChange(() => changes++);
  milkdown.log.created[0].type('# T\n\n- a\n- b\n\nnew\n');
  await wait();
  assert.equal(changes, 1);
  assert.equal(a.getText(), '# T\n\n* a\n* b\n\nnew\n');
  // Show source carries the merged text; typing there is taken as typed
  await a.toggle();
  assert.equal(a.getText(), '# T\n\n* a\n* b\n\nnew\n');
});

test('formatted adapter: typing in Show source, then Show formatted re-parses that text', async () => {
  const { SM, document, milkdown, cm } = load();
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await a.mount(host, 'one\n', {});
  let changes = 0;
  a.onChange(() => changes++);
  await a.toggle();
  cm.made.at(-1).type('two\n');
  await wait();
  assert.equal(changes, 1);
  assert.equal(a.getText(), 'two\n');
  await a.toggle();
  assert.equal(milkdown.log.created.at(-1).loadedFrom, 'two\n');
  assert.equal(a.getText(), 'two\n');
});

test('formatted adapter: Show formatted failing keeps the source pane and says why', async () => {
  const fm = fakeMilkdown();
  const { SM, document } = load({ milkdown: fm });
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await a.mount(host, 'x\n', {});
  await a.toggle();
  fm.lib.core.Editor.make = () => { throw new Error('gone'); };
  await a.toggle();
  assert.equal(a.mode, 'source');
  assert.ok(md(host, 'source'));
  assert.equal(md(host, 'source').hidden, false);
  assert.match(md(host, 'status').textContent, /could not load: gone/);
  assert.equal(a.getText(), 'x\n');
});

test('formatted adapter: the toolbar calls Milkdown commands; read-only shows only Show source', async () => {
  const { SM, document, milkdown, cm } = load();
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await a.mount(host, 'x\n', {});
  for (const k of ['bold', 'italic', 'bulletList', 'orderedList', 'table', 'codeBlock']) md(host, k).click();
  const h = md(host, 'heading');
  h.value = '2'; h.dispatch('change');
  h.value = 'p'; h.dispatch('change');
  assert.deepEqual(milkdown.log.commands.map((c) => c[0]), ['strong', 'emphasis', 'bullet', 'ordered', 'table', 'code', 'heading', 'text']);
  assert.deepEqual({ ...milkdown.log.commands[4][1] }, { row: 3, col: 3 });
  assert.equal(milkdown.log.commands[6][1], 2);
  // every Global Constraints item is there (checklist and link too)
  for (const k of ['heading', 'bold', 'italic', 'bulletList', 'orderedList', 'checklist', 'table', 'codeBlock', 'link', 'toggle']) assert.ok(md(host, k), k);
  // in source mode the formatting buttons are disabled, Show formatted is not
  await a.toggle();
  assert.equal(md(host, 'bold').disabled, true);
  assert.equal(md(host, 'toggle').disabled, false);
  a.destroy();

  const ro = SM.formattedAdapter();
  const host2 = document.createElement('div');
  await ro.mount(host2, 'x\n', { readOnly: true });
  assert.equal(md(host2, 'bold'), null);
  assert.ok(md(host2, 'toggle'));
  assert.equal(milkdown.log.readOnly.at(-1), true);
  await ro.toggle();
  assert.equal(cm.made.at(-1).opts.readOnly, true);   // Show source of a read-only file is read-only
});

test('formatted adapter: a mount failure leaves nothing behind (the dialog falls back to the markdown pane)', async () => {
  const { SM, document } = load({ milkdown: fakeMilkdown({ failCreate: true }) });
  const host = document.createElement('div');
  const a = SM.formattedAdapter();
  await assert.rejects(a.mount(host, 'x\n', {}), /create failed/);
  assert.equal(host.children.length, 0);
});

test('markdown pane: CodeMirror markdown mode, editable; a CRLF file is not dirty by opening and stays CRLF', async () => {
  const { SM, document, cm } = load();
  const host = document.createElement('div');
  const a = SM.sourceAdapter();
  await a.mount(host, 'a\r\nb\r\n', { readOnly: false });
  const c = cm.made.at(-1);
  assert.equal(c.opts.mode, 'markdown');
  assert.equal(c.opts.readOnly, false);
  assert.equal(a.getText(), 'a\r\nb\r\n');
  let n = 0;
  a.onChange(() => n++);
  c.type('a\nbc\n');
  assert.equal(n, 1);
  assert.equal(a.getText(), 'a\r\nbc\r\n');
  a.destroy();
  assert.equal(host.children.length, 0);
});

test('in the dialog: a formatted file toggled twice is not dirty and Save writes nothing; an edit shows the changes view', async () => {
  const body = '\n# Demo\n\nKeep *this*.\n\nBody.\n';
  const text = '---\nname: demo\ndescription: d\n---\n' + body;
  const ml = fakeMilkdown({ serialise: (s) => s.replace('Keep *this*', 'Keep _this_') });
  const { SE, milkdown, writes, views } = load({ milkdown: ml, files: { 'SKILL.md': text } });
  const dlg = await SE.open({ skill: { dir_name: 'demo', mine: true }, manager: null });
  assert.equal(dlg.files.get('SKILL.md').md.ok, true);
  const a = dlg.editor;
  assert.equal(a.mode, 'formatted');
  await a.toggle(); await a.toggle(); await a.toggle(); await a.toggle();
  await wait();
  assert.equal(dlg.dirtyFiles().length, 0);
  await dlg.save();
  assert.equal(writes.length, 0);
  milkdown.log.created.at(-1).type('\n# Demo\n\nKeep _this_.\n\nBody EDIT.\n');
  await wait();
  assert.deepEqual([...dlg.dirtyFiles()], ['SKILL.md']);
  await dlg.save();
  assert.equal(views.length, 1);
  assert.ok(views[0].includes('Body EDIT.') && !views[0].includes('Keep'));
  assert.deepEqual(writes, [['SKILL.md', '---\nname: demo\ndescription: d\n---\n\n# Demo\n\nKeep *this*.\n\nBody EDIT.\n']]);
  dlg.close();
  await wait(0);
  assert.equal(milkdown.log.destroyed, milkdown.log.created.length, 'no Milkdown instance leaked');
});

test('in the dialog: a file Milkdown would change opens in the markdown pane with Why?', async () => {
  const ml = fakeMilkdown({ serialise: (s) => s.replace('see [x]\n', 'see [x][]\n') });
  const { SE, cm } = load({ milkdown: ml, files: { 'SKILL.md': '---\nname: d\ndescription: d\n---\nok\n', 'references/r.md': 'see [x]\n\n[x]: http://a\n' } });
  const dlg = await SE.open({ skill: { dir_name: 'demo', mine: true }, manager: null });
  const sel = dlg.el.querySelector('[data-se="file"]');
  sel.value = 'references/r.md'; sel.dispatch('change');
  await dlg.ready();
  assert.equal(dlg.files.get('references/r.md').md.ok, false);
  assert.equal(cm.made.at(-1).opts.mode, 'markdown');
  const note = dlg.el.querySelector('[data-se="note"]');
  assert.match(note.textContent, /opens as markdown/);
  assert.match(note.querySelector('[data-se="why-list"]').textContent, /block-by-block comparison cannot be used/);
});

test('every skills.* key used by skill-md-editor.js exists in en, es and fr', () => {
  const langs = ['en', 'es', 'fr'].map((l) => JSON.parse(read(`../assets/i18n/${l}.json`)));
  const keys = [...MD_SRC.matchAll(/tr\('(skills\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  const prefixed = [...MD_SRC.matchAll(/'skills\.editor\.md\.' \+ key/g)].length ? ['bold', 'italic', 'bulletList', 'orderedList', 'checklist', 'table', 'codeBlock', 'link'].map((k) => 'skills.editor.md.' + k) : [];
  assert.ok(keys.length > 10);
  for (const k of [...keys, ...prefixed]) for (const L of langs) {
    const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), L);
    assert.equal(typeof v, 'string', k);
  }
});

test('check: a CRLF file opens in the markdown pane, and Why? says so instead of listing every block', async () => {
  const { SM, milkdown } = load();
  const r = await SM.check('# T\r\n\r\nx\r\n');
  assert.equal(r.ok, false);
  assert.equal(r.changes.length, 0);
  assert.match(r.error, /CRLF/);
  assert.equal(milkdown.log.created.length, 0);
});
