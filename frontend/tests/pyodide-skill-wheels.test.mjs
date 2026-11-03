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
    stat(p) { if (files.has(p)) return { mode: 1 }; if (dirs.has(p) || children(p).length) return { mode: 2 }; throw new Error('ENOENT'); },
    syncfs(_populate, cb) { cb(null); },
    isDir(m) { return m === 2; },
    unlink(p) { files.delete(p); },
    rmdir(p) { dirs.delete(p); },
  };
  const py = {
    FS, files, calls, script: null,   // script(FS): what the "Python script" does when the harness runs
    globals: { set: (k, v) => globals.set(k, v), get: (k) => globals.get(k) },
    toPy: (v) => v,
    mountNativeFS: async (p) => { FS.mkdirTree(p); return { syncfs: async () => {} }; },
    loadPackage: async (n) => { calls.push(['loadPackage', n]); },
    runPythonAsync: async (code) => {
      calls.push(['python', code, globals.get('_runner_wheel_urls') || globals.get('_runner_micropip_deps')]);
      if (code.includes('runpy.run_path')) {
        if (py.script) py.script(FS);
        globals.set('_runner_exit', 0); globals.set('_runner_stdout', ''); globals.set('_runner_stderr', '');
      }
    },
  };
  return py;
}

const okHandle = { queryPermission: async () => 'granted' };
const localFs = { ensureStandardSubdirs: async () => {}, resolvePath: async () => okHandle };

function load({ skillsFs, i18n } = {}) {
  const py = fakePyodide();
  const window = { skillsFs, localFs, loadPyodide: async () => py, i18n };
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
  // Every bundled file is planned (none dropped); installBundle sorts them by kind.
  assert.deepEqual(JSON.parse(JSON.stringify(w)), { fresh: ['fpdf2', 'pillow'], wheels: ['fpdf2-2.whl', 'pillow-1.whl', 'wheels.json'] });
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

// A scipy-like bundle: scipy + numpy wheels and the openblas shared library (a .zip in Pyodide's lock).
const LOCK = {
  numpy: { name: 'numpy', file_name: 'numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl', install_dir: 'site' },
  openblas: { name: 'openblas', file_name: 'openblas-0.3.26.zip', install_dir: 'dynlib' },
  scipy: { name: 'scipy', file_name: 'scipy-1.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl', install_dir: 'site' },
};
const SCIPY_BUNDLE = () => ({
  'scipy-1.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl': enc('S'),
  'numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl': enc('N'),
  'openblas-0.3.26.zip': enc('O'),
  'fpdf2-2.8-py3-none-any.whl': enc('F'),
});
/** Give a fake Pyodide a lock + installer; `vendored` = names its local index can load. */
function withLock(py, vendored) {
  py.loadedPackages = {};
  py.installs = [];
  py.loadPackage = async (n) => {
    py.calls.push(['loadPackage', n]);
    for (const x of [].concat(n)) if (vendored.includes(x) || x === 'micropip') py.loadedPackages[x] = 'default channel';
  };
  py._api = {
    lockfile_packages: LOCK,
    package_loader: { get_install_dir: (d) => (d === 'dynlib' ? '/usr/lib' : '/lib/python3.12/site-packages') },
    install: async (bytes, file, dir) => { py.installs.push([file, dir, new TextDecoder().decode(bytes)]); },
  };
  return py;
}

test('planBundle: distro files (shared libraries included) by name, other wheels via micropip, the rest unknown', () => {
  const { runner } = load();
  const p = JSON.parse(JSON.stringify(runner._planBundle([...Object.keys(SCIPY_BUNDLE()), 'notes.txt'], LOCK)));
  assert.deepEqual(p.distro.map((d) => d.name), ['numpy', 'openblas', 'scipy']);
  assert.deepEqual(p.wheels, ['fpdf2-2.8-py3-none-any.whl']);
  assert.deepEqual(p.unknown, ['notes.txt']);
});

test('ensureDeps (bundle): distro packages, the openblas .zip included, load from the local index', async () => {
  const { runner, py } = load();
  await runner.ensureLoaded();
  withLock(py, ['numpy', 'openblas', 'scipy']);
  await runner.ensureDeps(['scipy', 'fpdf2'], { wheels: SCIPY_BUNDLE() });
  const loads = JSON.parse(JSON.stringify(py.calls.filter((c) => c[0] === 'loadPackage').map((c) => c[1])));
  assert.deepEqual(loads, [['numpy', 'openblas', 'scipy'], 'micropip']);
  assert.deepEqual(py.installs, []);
  assert.deepEqual([...py.calls.find((c) => c[0] === 'python')[2]], ['emfs:/tmp/skill-wheels/fpdf2-2.8-py3-none-any.whl']);
});

test('ensureDeps (bundle): distro files the local index lacks install from their bundled bytes', async () => {
  const { runner, py } = load();
  await runner.ensureLoaded();
  withLock(py, []);   // nothing vendored
  await runner.ensureDeps(['scipy'], { wheels: SCIPY_BUNDLE() });
  assert.deepEqual(py.installs, [['openblas-0.3.26.zip', '/usr/lib', 'O']]);
  assert.deepEqual([...py.calls.find((c) => c[0] === 'python')[2]], [
    'emfs:/tmp/skill-wheels/fpdf2-2.8-py3-none-any.whl',
    'emfs:/tmp/skill-wheels/numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl',
    'emfs:/tmp/skill-wheels/scipy-1.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl',
  ]);
});

test('ensureDeps (bundle): an unknown bundled file is a clear error, not dropped', async () => {
  const { runner, py } = load();
  await runner.ensureLoaded();
  withLock(py, []);
  await assert.rejects(runner.ensureDeps(['x'], { wheels: { 'mystery-1.0.zip': enc('?'), 'a-1-py3-none-any.whl': enc('a') } }),
    /not Python packages for this Pyodide \(0\.27\.7\): mystery-1\.0\.zip/);
  assert.equal(py.calls.filter((c) => c[0] === 'python').length, 0);
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

test('changedFiles never returns Python bytecode (__pycache__ / .pyc)', () => {
  const { runner } = load();
  const out = runner._changedFiles({}, { 'scripts/__pycache__/a.cpython-312.pyc': enc('b'), 'x.pyc': enc('c'), 'scripts/a.py': enc('1') });
  assert.deepEqual(Object.keys(out), ['scripts/a.py']);
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


/** A store-mode skillsFs: `skills` = { path: { files, mine, public } }; as=robot sees public ones only. */
function storeFs(skills) {
  const writes = [];
  const visible = (p, asRobot) => skills[p] && (!asRobot || skills[p].public);
  const notFound = () => Object.assign(new Error('HTTP 404'), { status: 404 });
  return {
    writes,
    mode: async () => 'volume',
    parseFrontmatter: () => ({ meta: {} }),
    getSkillFile: async (p, rel, o = {}) => (visible(p, o.asRobot) && skills[p].files[rel] ? new TextDecoder().decode(skills[p].files[rel]) : null),
    readSkillFiles: async (p, o = {}) => {
      if (!visible(p, o.asRobot)) throw notFound();
      const out = {};
      for (const [r, b] of Object.entries(skills[p].files)) if (!o.under || r.startsWith(o.under + '/')) out[r] = b;
      return out;
    },
    listSkills: async (o = {}) => Object.keys(skills).filter((p) => visible(p, o.asRobot))
      .map((p) => ({ path: p, dirName: p, leafName: p.split('/').pop(), mine: !!skills[p].mine })),
    writeSkillFile: async (p, rel, b) => { writes.push([p, rel]); },
    skillsRootFiles: async () => ({}),
    writeSkillsRoot: async () => ({ ok: true }),
  };
}
const skill = (extra = {}) => ({ files: { 'SKILL.md': enc('---\nname: x\n---\n'), 'scripts/a.py': enc('print(1)'), ...extra } });

test('robot run: a private skill is refused at mount; a public one runs, without write-back', async () => {
  const fs = storeFs({ 'GEO/priv': { ...skill(), mine: true }, pub: { ...skill(), mine: true, public: true } });
  const { runner, py } = load({ skillsFs: fs });
  await assert.rejects(runner.runSkillScript({ dirName: 'GEO/priv', script: 'scripts/a.py', asRobot: true }), /not available to the robot/);
  // The bare leaf does not resolve to the private grouped skill either.
  await assert.rejects(runner.runSkillScript({ dirName: 'priv', script: 'scripts/a.py', asRobot: true }), /not available to the robot/);
  py.script = (FS) => FS.writeFile('/skill/pub/scripts/a.py', enc('changed'));
  const r = await runner.runSkillScript({ dirName: 'pub', script: 'scripts/a.py', asRobot: true });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(fs.writes, []);
  // The same change on the person's own run is written back.
  await runner.runSkillScript({ dirName: 'pub', script: 'scripts/a.py' });
  assert.deepEqual(fs.writes, [['pub', 'scripts/a.py']]);
});

test('runner messages use window.i18n when present (English otherwise)', async () => {
  const fs = storeFs({ priv: { ...skill(), mine: true } });
  const i18n = { t: (k, p) => (k === 'skills.run.robotRefusal' ? `ROBOT NO ${p.name}` : k) };
  const { runner } = load({ skillsFs: fs, i18n });
  await assert.rejects(runner.runSkillScript({ dirName: 'priv', script: 'scripts/a.py', asRobot: true }), /^Error: ROBOT NO priv$/);
});

test('store: a run that writes /skills-root without having it fails with a clear error', async () => {
  const fs = storeFs({ s: { ...skill(), mine: true } });
  const { runner, py } = load({ skillsFs: fs });
  py.script = (FS) => { FS.mkdirTree('/skills-root/new'); FS.writeFile('/skills-root/new/SKILL.md', enc('x')); };
  const r = await runner.runSkillScript({ dirName: 's', script: 'scripts/a.py' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /This skill wrote to the skills folder, which is not available for it here\./);
  // Nothing is left behind for the next run.
  py.script = null;
  assert.equal((await runner.runSkillScript({ dirName: 's', script: 'scripts/a.py' })).exitCode, 0);
});

test('poolSkillPayload as the robot refuses a private skill; savePoolChanges skips robot runs and others\' skills', async () => {
  const fs = storeFs({ priv: { ...skill(), mine: true }, theirs: { ...skill(), public: true } });
  const { runner } = load({ skillsFs: fs });
  await assert.rejects(runner.poolSkillPayload('priv', { asRobot: true }), /not available to the robot/);
  await runner.savePoolChanges('priv', { 'a.txt': enc('1') }, { asRobot: true });
  await runner.savePoolChanges('theirs', { 'a.txt': enc('1') });
  assert.deepEqual(fs.writes, []);
  await runner.savePoolChanges('priv', { 'a.txt': enc('1') });
  assert.deepEqual(fs.writes, [['priv', 'a.txt']]);
});

test('savePoolChanges never throws: a failed save after a pool run is a warning (no second run)', async () => {
  const fs = storeFs({ mine: { ...skill(), mine: true } });
  fs.writeSkillFile = async () => { throw new Error('HTTP 500'); };
  const { runner } = load({ skillsFs: fs });
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    assert.equal(await runner.savePoolChanges('mine', { 'a.txt': enc('1') }), false);
  } finally { console.warn = orig; }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not save the changes of mine/);
  fs.writeSkillFile = async () => {};
  assert.equal(await runner.savePoolChanges('mine', { 'a.txt': enc('1') }), true);
});

const WORKER = readFileSync(fileURLToPath(new URL('../assets/js/pyodide.worker.js', import.meta.url)), 'utf8');

/** Run the pool worker in a vm: returns call(payload) → the worker's reply for verb runSkillScript. */
function loadWorker() {
  const py = fakePyodide();
  const replies = [];
  const self = { location: 'http://x/gpt/assets/js/pyodide.worker.js', postMessage: (m) => replies.push(m) };
  const ctx = vm.createContext({ self, importScripts: () => {}, loadPyodide: async () => py, console, URL, TextEncoder, TextDecoder, Uint8Array, Date });
  vm.runInContext(WORKER, ctx);
  let id = 0;
  const call = async (payload) => {
    const myId = ++id;
    await self.onmessage({ data: { id: myId, verb: 'runSkillScript', payload } });
    return replies.find((r) => r.id === myId);
  };
  return { py, call };
}

test('worker (store): clears the previous copy, returns the skill changes, fails on /skills-root writes', async () => {
  const { py, call } = loadWorker();
  const base = { dirName: 's', script: 'scripts/a.py', argv: [], outputsHandle: okHandle, persist: false };
  // First copy has an extra file; the second copy must not keep it.
  await call({ ...base, skillFiles: { 'scripts/a.py': enc('1'), 'old.txt': enc('o') } });
  py.script = (FS) => FS.writeFile('/skill/s/new.txt', enc('n'));
  const r = await call({ ...base, skillFiles: { 'scripts/a.py': enc('1') } });
  assert.equal(r.ok, true);
  assert.equal(py.files.has('/skill/s/old.txt'), false);
  assert.deepEqual(Object.keys(r.result.skillChanges), ['new.txt']);
  py.script = (FS) => FS.writeFile('/skills-root/x/SKILL.md', enc('x'));
  const bad = await call({ ...base, skillFiles: { 'scripts/a.py': enc('1') } });
  assert.equal(bad.result.exitCode, 1);
  assert.match(bad.result.stderr, /This skill wrote to the skills folder, which is not available for it here\./);
  assert.equal(py.files.has('/skills-root/x/SKILL.md'), false);
  // Bytecode Python writes on import is never sent back.
  py.script = (FS) => { FS.writeFile('/skill/s/scripts/__pycache__/a.cpython-312.pyc', enc('b')); FS.writeFile('/skill/s/m.pyc', enc('c')); };
  const pyc = await call({ ...base, skillFiles: { 'scripts/a.py': enc('1') } });
  assert.deepEqual(Object.keys(pyc.result.skillChanges), []);
});

test('worker (bundle): scipy-like bundle loads distro packages by name, the rest from bytes, unknown files fail', async () => {
  const { py, call } = loadWorker();
  withLock(py, ['numpy', 'scipy']);   // openblas not in the local index: installed from the bundle
  const base = { dirName: 's', script: 'scripts/a.py', argv: [], outputsHandle: okHandle, persist: false, skillFiles: { 'scripts/a.py': enc('1') } };
  const r = await call({ ...base, dependencies: ['scipy'], wheels: SCIPY_BUNDLE() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(JSON.parse(JSON.stringify(py.calls.filter((c) => c[0] === 'loadPackage').map((c) => c[1])))[0], ['numpy', 'openblas', 'scipy']);
  assert.deepEqual(py.installs, [['openblas-0.3.26.zip', '/usr/lib', 'O']]);
  const bad = await call({ ...base, dependencies: ['other'], wheels: { 'mystery-1.0.zip': enc('?') } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not Python packages for this Pyodide \(0\.27\.7\): mystery-1\.0\.zip/);
});
