import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/pyodide-runner.js', import.meta.url)), 'utf8');

/** A tiny MEMFS: files in a Map, directories implied by paths (plus mkdirTree'd ones). */
function fakePyodide() {
  const files = new Map();
  const dirs = new Set(['/']);
  const calls = [];
  const globals = new Map();
  const children = (dir) => {
    const pre = dir.replace(/\/$/, '') + '/';
    const names = new Set();
    for (const p of [...files.keys(), ...dirs]) if (p.startsWith(pre) && p !== pre) names.add(p.slice(pre.length).split('/')[0]);
    return [...names];
  };
  const FS = {
    mkdirTree(p) { let cur = ''; for (const s of p.split('/').filter(Boolean)) { cur += '/' + s; dirs.add(cur); } },
    writeFile(p, b) { files.set(p, typeof b === 'string' ? new TextEncoder().encode(b) : b); },
    readFile(p, o) { if (!files.has(p)) throw new Error('ENOENT'); const b = files.get(p); return o && o.encoding ? new TextDecoder().decode(b) : b; },
    readdir(p) { if (!dirs.has(p) && !children(p).length) throw new Error('ENOENT'); return ['.', '..', ...children(p)]; },
    stat(p) { return { mode: files.has(p) ? 1 : 2 }; },
    isDir(m) { return m === 2; },
    unlink(p) { files.delete(p); },
    rmdir(p) { dirs.delete(p); },
  };
  return {
    FS, files, calls,
    globals: { set: (k, v) => globals.set(k, v), get: (k) => globals.get(k) },
    loadPackage: async (n) => { calls.push(['loadPackage', n]); },
    runPythonAsync: async (code) => { calls.push(['python', code, globals.get('_runner_wheel_urls') || globals.get('_runner_micropip_deps')]); },
  };
}

function load({ skillsFs } = {}) {
  const py = fakePyodide();
  const window = { skillsFs, loadPyodide: async () => py };
  const ctx = vm.createContext({ window, document: { baseURI: 'http://x/gpt/' }, console, URL, TextEncoder, TextDecoder, Uint8Array, performance });
  vm.runInContext(SRC, ctx);
  return { runner: window.pyodideRunner, py };
}

const enc = (s) => new TextEncoder().encode(s);

test('planDeps: nothing fresh → null; bundled wheels win; otherwise the prebuilt/micropip split', () => {
  const { runner } = load();
  assert.equal(runner._planDeps(['a'], new Set(['a']), ['a-1.whl']), null);
  assert.equal(runner._planDeps([], new Set(), []), null);
  const w = runner._planDeps(['fpdf2', 'pillow'], new Set(), ['pillow-1.whl', 'fpdf2-2.whl', 'wheels.json']);
  assert.deepEqual(JSON.parse(JSON.stringify(w)), { fresh: ['fpdf2', 'pillow'], wheels: ['fpdf2-2.whl', 'pillow-1.whl'] });
  const o = runner._planDeps(['fpdf2', 'pillow'], new Set(), []);
  assert.deepEqual(JSON.parse(JSON.stringify(o)), { fresh: ['fpdf2', 'pillow'], prebuilt: ['pillow'], viaMicropip: ['fpdf2'] });
});

test('ensureDeps with bundled wheels installs them from MEMFS with deps=False and nothing online', async () => {
  const { runner, py } = load();
  await runner.ensureLoaded();
  await runner.ensureDeps(['fpdf2'], { wheels: { 'fpdf2-2.8-py3-none-any.whl': enc('W') } });
  assert.deepEqual([...py.files.get('/tmp/skill-wheels/fpdf2-2.8-py3-none-any.whl')], [...enc('W')]);
  const py1 = py.calls.find((c) => c[0] === 'python');
  assert.match(py1[1], /micropip\.install\(list\(_runner_wheel_urls\), deps=False\)/);
  assert.deepEqual([...py1[2]], ['emfs:/tmp/skill-wheels/fpdf2-2.8-py3-none-any.whl']);
  assert.deepEqual(py.calls.filter((c) => c[0] === 'loadPackage').map((c) => c[1]), ['micropip']);
  // Installed once: a second call does nothing.
  py.calls.length = 0;
  await runner.ensureDeps(['fpdf2'], { wheels: { 'fpdf2-2.8-py3-none-any.whl': enc('W') } });
  assert.equal(py.calls.length, 0);
});

test('ensureDeps without wheels keeps the online path', async () => {
  const { runner, py } = load();
  await runner.ensureLoaded();
  await runner.ensureDeps(['pillow', 'fpdf2']);
  assert.deepEqual(JSON.parse(JSON.stringify(py.calls.filter((c) => c[0] === 'loadPackage').map((c) => c[1]))), [['pillow'], 'micropip']);
  assert.match(py.calls.find((c) => c[0] === 'python')[1], /for _dep in list\(_runner_micropip_deps\)/);
});

test('store mode: ensureMounted copies the skill into MEMFS at /skill/<dir> (no native mount)', async () => {
  const skillsFs = {
    mode: async () => 'volume',
    readSkillFiles: async (p) => (p === 'GEO/geo' ? { 'SKILL.md': enc('---\nname: geo\n---\n'), 'scripts/a.py': enc('print(1)') } : {}),
    listSkills: async () => [{ path: 'GEO/geo', mine: true }],
  };
  const { runner, py } = load({ skillsFs });
  await runner.ensureLoaded();
  assert.equal(await runner.ensureMounted('GEO/geo'), '/skill/GEO/geo');
  assert.equal(new TextDecoder().decode(py.files.get('/skill/GEO/geo/scripts/a.py')), 'print(1)');
  await assert.rejects(runner.ensureMounted('nope'), /not found/);
});

test('changedFiles keeps new and different files only', () => {
  const { runner } = load();
  const out = runner._changedFiles({ a: enc('1'), b: enc('2') }, { a: enc('1'), b: enc('3'), c: enc('4') });
  assert.deepEqual(Object.keys(out).sort(), ['b', 'c']);
});

test('poolSkillPayload: store sends the files and bundled wheels; folder sends the handle', async () => {
  const wheel = enc('W');
  const store = {
    mode: async () => 'volume',
    getSkillFile: async (p, rel) => (rel === 'SKILL.md' && p === 'pdf' ? '---\nname: pdf\ndependencies: fpdf2\n---\n' : null),
    parseFrontmatter: (t) => ({ meta: { dependencies: /dependencies: (.*)/.exec(t)[1] } }),
    readSkillFiles: async (p, o = {}) => (o.under === '.wheels/pyodide' ? { '.wheels/pyodide/fpdf2.whl': wheel } : { 'SKILL.md': enc('x') }),
    listSkills: async () => [],
  };
  const { runner } = load({ skillsFs: store });
  const s = await runner.poolSkillPayload('pdf');
  assert.equal(s.dirName, 'pdf');
  assert.deepEqual([...s.dependencies], ['fpdf2']);
  assert.deepEqual(Object.keys(s.wheels), ['fpdf2.whl']);
  assert.deepEqual(Object.keys(s.skillFiles), ['SKILL.md']);
  assert.equal(s.skillHandle, undefined);

  const handle = { queryPermission: async () => 'granted' };
  const folder = { ...store, mode: async () => 'folder', readSkillFiles: async () => ({}), folderHandle: async (p) => (p === 'pdf' ? handle : null) };
  const f = await load({ skillsFs: folder }).runner.poolSkillPayload('pdf');
  assert.equal(f.skillHandle, handle);
  assert.deepEqual(Object.keys(f.wheels), []);
  assert.equal(f.skillFiles, undefined);
});
