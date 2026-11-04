import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skills-fs.js', import.meta.url)), 'utf8');
const SkillZip = createRequire(import.meta.url)('../assets/js/skill-zip.js');
const SkillRequires = createRequire(import.meta.url)('../assets/js/skill-requires.js');
const EN = JSON.parse(readFileSync(fileURLToPath(new URL('../assets/i18n/en.json', import.meta.url)), 'utf8'));
const i18n = { t: (k, p = {}) => { const v = k.split('.').reduce((a, x) => (a ? a[x] : undefined), EN); return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, n) => p[n] ?? '') : k; } };
const b64 = (s) => Buffer.from(s).toString('base64');

/** routes: { 'GET /skills/store': (body, url) => [status, json] } */
function load({ routes = {}, localFs, extra = {} } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = url.replace('http://x/api/v1', '');
    const key = `${init.method || 'GET'} ${path.split('?')[0]}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, path, body, headers: init.headers });
    const h = routes[key];
    if (!h) return { ok: false, status: 404, statusText: 'nf', text: async () => '{"error":"nf"}' };
    const [status, json] = h(body, path);
    return { ok: status < 400, status, statusText: '', text: async () => JSON.stringify(json) };
  };
  const window = { APP_CONFIG: { API_BASE_URL: 'http://x/api/v1' }, authManager: { token: 'tok' }, SkillZip, SkillRequires, i18n, localFs, ...extra };
  const ctx = vm.createContext({ window, fetch, console, TextEncoder, TextDecoder, btoa, atob, Uint8Array, encodeURIComponent });
  vm.runInContext(SRC, ctx);
  return { fs: window.skillsFs, calls };
}

const volume = { 'GET /skills/store': () => [200, { mode: 'volume', edition: 'corporate' }] };

test('mode is fetched once and cached; edition shares the call', async () => {
  const { fs, calls } = load({ routes: volume });
  assert.equal(await fs.mode(), 'volume');
  assert.equal(await fs.mode(), 'volume');
  assert.equal(await fs.edition(), 'corporate');
  assert.equal(calls.filter((c) => c.key === 'GET /skills/store').length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
});

test('mode falls back to folder when /skills/store fails', async () => {
  const { fs } = load({ routes: {} });
  assert.equal(await fs.mode(), 'folder');
});

test('volume listSkills maps rows; asRobot adds as=robot', async () => {
  const rows = [
    { path: 'research/pubmed', name: 'PubMed', description: 'd', visibility: 'public', owner_id: 3, mine: false, dependencies: ['x'] },
    { path: 'alpha', name: 'Alpha', description: '', visibility: 'private', owner_id: 1, mine: true, dependencies: [] },
  ];
  const { fs, calls } = load({ routes: { ...volume, 'GET /skills': () => [200, rows] } });
  const out = await fs.listSkills();
  assert.deepEqual(JSON.parse(JSON.stringify(out.map((r) => [r.name, r.group, r.visibility, r.mine, r.ownerId, r.dirName]))),
    [['Alpha', null, 'private', true, 1, 'alpha'], ['PubMed', 'research', 'public', false, 3, 'research/pubmed']]);
  assert.deepEqual([...out[1].dependencies], ['x']);
  await fs.listSkills({ asRobot: true });
  assert.ok(calls.some((c) => c.path === '/skills?as=robot'));
});

function fakeDir(tree, name = '') {
  return {
    name, kind: 'directory',
    async getFileHandle(n) { if (tree[n] === undefined || typeof tree[n] === 'object') throw new Error('nf'); const v = tree[n]; return { name: n, kind: 'file', getFile: async () => ({ text: async () => v }) }; },
    async *values() {
      for (const [n, v] of Object.entries(tree)) {
        if (typeof v === 'string') yield { name: n, kind: 'file', getFile: async () => ({ text: async () => v, arrayBuffer: async () => new TextEncoder().encode(v).buffer }) };
        else yield fakeDir(v, n);
      }
    },
  };
}

test('folder mode keeps the list shape and adds private/mine/dependencies', async () => {
  const skills = fakeDir({ pubmed: { 'SKILL.md': '---\nname: pubmed\ndescription: hi\ndependencies: a, b\n---\nbody' } });
  const localFs = { resolvePath: async (p) => (p === 'skills' ? skills : null) };
  const { fs } = load({ localFs });
  const out = await fs.listSkills();
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.dirName, 'pubmed');
  assert.equal(r.group, null);
  assert.equal(r.visibility, 'private');
  assert.equal(r.mine, true);
  assert.equal(r.ownerId, null);
  assert.deepEqual([...r.dependencies], ['a', 'b']);
  assert.ok(r.dirHandle);
});

test('volume listSkills maps requires (empty when absent)', async () => {
  const rows = [{ path: 'a', name: 'a', visibility: 'private', owner_id: 1, mine: true, requires: ['g/b'] }, { path: 'b', name: 'b', visibility: 'private', owner_id: 1, mine: true }];
  const { fs } = load({ routes: { ...volume, 'GET /skills': () => [200, rows] } });
  const out = await fs.listSkills();
  assert.deepEqual([...out[0].requires], ['g/b']);
  assert.deepEqual([...out[1].requires], []);
});

test('folder mode lists the direct required skills (declared, or named in scripts/)', async () => {
  const tree = {
    top: { 'SKILL.md': '---\nname: top\nrequires-skills: [mid]\n---\n' },
    mid: { 'SKILL.md': '---\nname: mid\n---\n', scripts: { 'run.py': "load_script('leaf', 'x.py')\n" } },
    leaf: { 'SKILL.md': '---\nname: leaf\n---\n' },
  };
  const at = (parts) => parts.reduce((d, n) => (d && typeof d === 'object' ? d[n] : undefined), tree);
  const fileOf = (v) => ({ kind: 'file', getFile: async () => ({ text: async () => v, arrayBuffer: async () => new TextEncoder().encode(v).buffer }) });
  const { fs } = load({ localFs: { resolvePath: async (p) => {
    const parts = p.split('/').slice(1);
    const v = parts.length ? at(parts) : tree;
    if (v === undefined) return null;
    return typeof v === 'string' ? fileOf(v) : fakeDir(v, parts[parts.length - 1] || '');
  } } });
  const out = await fs.listSkills();
  assert.deepEqual(Object.fromEntries(out.map((r) => [r.dirName, [...r.requires]])), { leaf: [], mid: ['leaf'], top: ['mid'] });
});

test('importSkill posts base64 toStoreFiles at read.dir and maps 409 to code clash', async () => {
  let sent;
  const read = { dir: 'g/s', name: 's', files: { 'SKILL.md': new TextEncoder().encode('hi') }, pyodideWheels: { 'a.whl': new Uint8Array([1]) }, nativeWheels: {} };
  const { fs } = load({ routes: { ...volume, 'POST /skills/import': (b) => { sent = b; return [200, { status: 'installed' }]; } } });
  assert.equal((await fs.importSkill(read, { visibility: 'public' })).status, 'installed');
  assert.equal(sent.path, 'g/s');
  assert.equal(sent.visibility, 'public');
  assert.equal(sent.files['SKILL.md'], b64('hi'));
  assert.ok(sent.files['.wheels/pyodide/a.whl'] && sent.files['.wheels/wheels.json']);

  const c = load({ routes: { ...volume, 'POST /skills/import': () => [409, { clash: 'different' }] } });
  await assert.rejects(() => c.fs.importSkill(read), (e) => e.code === 'clash');
});

test('volume readSkillFiles decodes and hides wheels unless asked', async () => {
  const files = { 'SKILL.md': b64('x'), '.wheels/pyodide/a.whl': b64('w') };
  const { fs, calls } = load({ routes: { ...volume, 'GET /skills/files': () => [200, { files }] } });
  const plain = await fs.readSkillFiles('s');
  assert.equal(Object.keys(plain).join(), 'SKILL.md');
  assert.equal(Buffer.from(plain['SKILL.md']).toString(), 'x');
  const all = await fs.readSkillFiles('s', { withWheels: true, asRobot: true });
  assert.equal(Object.keys(all).length, 2);
  assert.ok(calls.some((c) => c.path === '/skills/files?path=s&as=robot'));
});

test('volume getSkillContent, writeSkillFile, setVisibility, move, delete, createFolder', async () => {
  let put, vis, mv, del;
  const { fs } = load({ routes: {
    ...volume,
    'GET /skills/file': () => [200, { content: b64('---\nname: s\n---\nBODY') }],
    'PUT /skills/file': (b) => { put = b; return [200, {}]; },
    'PUT /skills/visibility': (b) => { vis = b; return [200, {}]; },
    'POST /skills/move': (b) => { mv = b; return [200, {}]; },
    'DELETE /skills': (b, p) => { del = p; return [200, {}]; },
  } });
  assert.equal(await fs.getSkillContent('s'), 'BODY');
  await fs.writeSkillFile('s', 'a.txt', 'hey');
  assert.equal(put.rel, 'a.txt'); assert.equal(put.content, b64('hey'));
  await fs.setVisibility('s', 'public');
  assert.equal(vis.visibility, 'public');
  assert.equal((await fs.moveSkill('a/s', 'b')).path, 'b/s');
  assert.equal(mv.to, 'b/s');
  assert.equal((await fs.renameSkill('a/s', 't')).path, 'a/t');
  assert.equal((await fs.deleteSkill('s')).ok, true);
  assert.equal(del, '/skills?path=s');
  assert.equal((await fs.createFolder('grp')).name, 'grp');
});

test('volume move/rename onto a taken path returns the backend clash message', async () => {
  const { fs } = load({ routes: { ...volume,
    'POST /skills/move': () => [409, { success: false, data: { clash: 'different', message: "A skill already exists at 'b/s'." }, error: 'clash' }],
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(await fs.moveSkill('a/s', 'b'))), { ok: false, error: "A skill already exists at 'b/s'." });
  assert.equal((await fs.renameSkill('a/s', 't')).error, "A skill already exists at 'b/s'.");
});

test('volume skillsRootFiles lists own skills only; writeSkillsRoot imports new, writes existing', async () => {
  const puts = []; let imp;
  const { fs } = load({ routes: {
    ...volume,
    'GET /skills': () => [200, [{ path: 'mine', name: 'm', visibility: 'private', owner_id: 1, mine: true }, { path: 'theirs', name: 't', visibility: 'public', owner_id: 2, mine: false }]],
    'GET /skills/files': (b, p) => [200, { files: { 'SKILL.md': b64(p.includes('mine') ? 'M' : 'T') } }],
    'PUT /skills/file': (b) => { puts.push(b); return [200, {}]; },
    'POST /skills/import': (b) => { imp = b; return [200, { status: 'installed' }]; },
  } });
  const root = await fs.skillsRootFiles();
  assert.equal(Object.keys(root).join(), 'mine/SKILL.md');
  await fs.writeSkillsRoot({ 'mine/SKILL.md': 'M2', 'fresh/SKILL.md': 'F', 'fresh/scripts/a.py': 'p' });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, 'mine');
  assert.equal(imp.path, 'fresh');
  assert.equal(imp.files['scripts/a.py'], b64('p'));
});

test('mode: a transient failure is not cached, a 404 is', async () => {
  let n = 0;
  const flaky = load({ routes: { 'GET /skills/store': () => (n++ ? [200, { mode: 'volume', edition: 'x' }] : [401, {}]) } });
  assert.equal(await flaky.fs.mode(), 'folder');
  assert.equal(await flaky.fs.mode(), 'volume');
  assert.equal(await flaky.fs.mode(), 'volume');
  assert.equal(n, 2);
  const absent = load({ routes: {} });
  await absent.fs.mode(); await absent.fs.mode();
  assert.equal(absent.calls.length, 1);
});

function writableDir(tree, name = '') {
  const d = fakeDir(tree, name);
  d.getDirectoryHandle = async (n) => { if (typeof tree[n] !== 'object') throw new Error('nf'); return writableDir(tree[n], n); };
  return d;
}

test('folder-mode importSkill: installed, identical, clash', async () => {
  const read = { dir: 's', name: 's', files: { 'SKILL.md': new TextEncoder().encode('hi') }, pyodideWheels: {}, nativeWheels: {} };
  const writes = [];
  const mk = (tree) => {
    const skills = writableDir(tree, 'skills');
    const localFs = { resolvePath: async (p, o) => {
      if (p === 'skills') return skills;
      if (p === 'skills/s') return tree.s ? writableDir(tree.s, 's') : (o && o.create ? { async getFileHandle(n) { return { createWritable: async () => ({ write: async () => writes.push(n), close: async () => {} }) }; } } : null);
      if (p === 'skills') return skills;
      return { async getFileHandle(n) { return { createWritable: async () => ({ write: async () => writes.push(n), close: async () => {} }) }; } };
    } };
    return load({ localFs }).fs;
  };
  assert.equal((await mk({}).importSkill(read)).status, 'installed');
  assert.ok(writes.length > 0);
  writes.length = 0;
  assert.equal((await mk({ s: { 'SKILL.md': 'hi' } }).importSkill(read)).status, 'identical');
  assert.equal(writes.length, 0);
  await assert.rejects(() => mk({ s: { 'SKILL.md': 'other' } }).importSkill(read), (e) => e.code === 'clash');
});

test('readSkillFiles under: store filters, folder walks only that folder (keys stay skill-relative)', async () => {
  const files = { 'SKILL.md': b64('x'), 'runs/a/r.json': b64('1'), 'runsx/b': b64('2') };
  const v = load({ routes: { ...volume, 'GET /skills/files': () => [200, { files }] } });
  assert.deepEqual(Object.keys(await v.fs.readSkillFiles('s', { under: 'runs' })), ['runs/a/r.json']);

  const asked = [];
  const runs = fakeDir({ a: { 'r.json': '1' } }, 'runs');
  const localFs = { resolvePath: async (p) => { asked.push(p); return p === 'skills/s/runs' ? runs : null; } };
  const f = load({ localFs });
  assert.deepEqual(Object.keys(await f.fs.readSkillFiles('s', { under: 'runs' })), ['runs/a/r.json']);
  assert.deepEqual(asked, ['skills/s/runs']);
});

test('store: getSkillContent / listSkillScripts read as the robot when asked', async () => {
  const { fs, calls } = load({ routes: {
    ...volume,
    'GET /skills/file': () => [200, { content: b64('---\nname: s\n---\nB') }],
    'GET /skills/files': () => [200, { files: { 'scripts/a.py': b64('p'), 'SKILL.md': b64('x') } }],
  } });
  assert.equal(await fs.getSkillContent('s', { asRobot: true }), 'B');
  assert.deepEqual([...await fs.listSkillScripts('s', { asRobot: true })], ['scripts/a.py']);
  assert.ok(calls.some((c) => c.path === '/skills/file?path=s&rel=SKILL.md&as=robot'));
  assert.ok(calls.some((c) => c.path === '/skills/files?path=s&as=robot&wheels=0'));
});

test('store: readSkillFiles asks the server to leave wheels out unless they are wanted', async () => {
  const { fs, calls } = load({ routes: { ...volume, 'GET /skills/files': () => [200, { files: {} }] } });
  await fs.readSkillFiles('s');
  await fs.readSkillFiles('s', { withWheels: true });
  assert.deepEqual(calls.filter((c) => c.key === 'GET /skills/files').map((c) => c.path), ['/skills/files?path=s&wheels=0', '/skills/files?path=s']);
});

test('listSkillFolders: folder lists directories without reading files; the store derives them', async () => {
  const runs = fakeDir({ 'run-1': { 'r.json': '1' }, 'run-2': {}, 'note.txt': 'x' }, 'body-opt-results');
  const localFs = { resolvePath: async (p) => (p === 'skills/s/body-opt-results' ? runs : null) };
  assert.deepEqual([...await load({ localFs }).fs.listSkillFolders('s', 'body-opt-results')], ['run-1', 'run-2']);
  const files = { 'body-opt-results/run-1/r.json': b64('1'), 'body-opt-results/run-3/logs/a.json': b64('2'), 'SKILL.md': b64('x') };
  const v = load({ routes: { ...volume, 'GET /skills/files': () => [200, { files }] } });
  assert.deepEqual([...await v.fs.listSkillFolders('s', 'body-opt-results')], ['run-1', 'run-3']);
});

test('store writeSkillFiles: a new skill is imported private, my existing one is written file by file', async () => {
  const puts = []; let imp;
  const { fs } = load({ routes: {
    ...volume,
    'GET /skills': () => [200, [{ path: 'mine', name: 'm', visibility: 'private', owner_id: 1, mine: true }]],
    'PUT /skills/file': (b) => { puts.push(b); return [200, {}]; },
    'POST /skills/import': (b) => { imp = b; return [200, { status: 'installed' }]; },
  } });
  await fs.writeSkillFiles('mine', { 'SKILL.md': 'M', 'x.json': '{}' });
  assert.deepEqual(puts.map((p) => p.rel), ['SKILL.md', 'x.json']);
  await fs.writeSkillFiles('fresh', { 'SKILL.md': 'F' });
  assert.equal(imp.path, 'fresh');
  assert.equal(imp.visibility, 'private');
  assert.equal(imp.files['SKILL.md'], b64('F'));
  assert.equal(await fs.skillExists('mine'), true);
  assert.equal(await fs.skillExists('g/mine'), true);   // same leaf name
  assert.equal(await fs.skillExists('other'), false);
  assert.equal(await fs.folderHandle('mine'), null);
});

test('the backend envelope { success, data } is unwrapped', async () => {
  const { fs } = load({ routes: {
    'GET /skills/store': () => [200, { success: true, data: { mode: 'volume', edition: 'individual' } }],
    'GET /skills': () => [200, { success: true, data: [{ path: 'a', name: 'A', visibility: 'private', owner_id: 1, mine: true }] }],
  } });
  assert.equal(await fs.mode(), 'volume');
  assert.equal(await fs.edition(), 'individual');
  assert.deepEqual([...(await fs.listSkills()).map((s) => s.dirName)], ['a']);
});

const sk = (dir, text, requires) => ({ dir, name: dir.split('/').pop(), files: { 'SKILL.md': new TextEncoder().encode(text) }, pyodideWheels: {}, nativeWheels: {}, ...(requires ? { requires } : {}) });

test('store importSkill with required skills: every skill is checked first; a clash in a required one writes nothing', async () => {
  const posts = [];
  const { fs } = load({ routes: { ...volume, 'POST /skills/import': (b) => {
    posts.push(b);
    if (b.path === 'flow') return [409, { data: { clash: 'different' } }];
    return [200, { status: b.dry_run ? 'new' : 'installed' }];
  } } });
  const read = sk('auto', 'A', [sk('pb', 'P'), sk('flow', 'F')]);
  await assert.rejects(() => fs.importSkill(read, { visibility: 'public' }), (e) => e.code === 'clash' && e.skill === 'flow');
  assert.ok(posts.every((p) => p.dry_run === true), 'only dry runs before the clash');
  assert.deepEqual(posts.map((p) => p.path), ['pb', 'flow', 'auto']);
});

test('store importSkill: required skills install first with the same visibility; an identical one counts as already installed', async () => {
  const real = [];
  const { fs } = load({ routes: { ...volume, 'POST /skills/import': (b) => {
    if (!b.dry_run) real.push([b.path, b.visibility]);
    return [200, { status: b.path === 'pb' ? 'identical' : (b.dry_run ? 'new' : 'installed') }];
  } } });
  const r = await fs.importSkill(sk('auto', 'A', [sk('pb', 'P'), sk('flow', 'F')]), { visibility: 'public' });
  assert.equal(r.status, 'installed');
  assert.deepEqual(JSON.parse(JSON.stringify(r.requires)), [{ dir: 'pb', name: 'pb', status: 'identical' }, { dir: 'flow', name: 'flow', status: 'installed' }]);
  assert.deepEqual(real, [['flow', 'public'], ['auto', 'public']]);
  const plan = await fs.importPlan(sk('auto', 'A', [sk('pb', 'P')]));
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), [{ dir: 'pb', name: 'pb', status: 'identical', madePublic: [] }, { dir: 'auto', name: 'auto', status: 'new', madePublic: [] }]);
});

test('folder importSkill with required skills: a clash in a required skill writes nothing; identical ones are kept', async () => {
  const writes = [];
  const tree = { pb: { 'SKILL.md': 'P' }, flow: { 'SKILL.md': 'other' } };
  const sink = { async getFileHandle(n) { return { createWritable: async () => ({ write: async () => writes.push(n), close: async () => {} }) }; } };
  const localFs = { resolvePath: async (p, o) => {
    const d = p.replace(/^skills\/?/, '');
    if (tree[d]) return writableDir(tree[d], d);
    return o && o.create ? sink : null;
  } };
  const { fs } = load({ localFs });
  await assert.rejects(() => fs.importSkill(sk('auto', 'A', [sk('pb', 'P'), sk('flow', 'F')])), (e) => e.code === 'clash' && e.skill === 'flow');
  assert.equal(writes.length, 0);
  delete tree.flow;
  const r = await fs.importSkill(sk('auto', 'A', [sk('pb', 'P'), sk('flow', 'F')]));
  assert.deepEqual(JSON.parse(JSON.stringify(r.requires.map((x) => x.status))), ['identical', 'installed']);
  assert.equal(writes.length, 2);   // flow/SKILL.md and auto/SKILL.md
});

/** A folder skills root (fake FSA tree) that records deletes. */
function folderRoot(tree) {
  const removed = [];
  const dirAt = (p) => p.split('/').filter(Boolean).reduce((t, x) => (t && typeof t[x] === 'object' ? t[x] : undefined), tree);
  const mk = (t, name) => {
    const d = writableDir(t, name);
    d.removeEntry = async (n) => { removed.push(n); delete t[n]; };
    d.getDirectoryHandle = async (n, o) => { if (typeof t[n] !== 'object') { if (o && o.create) { t[n] = {}; } else throw new Error('nf'); } return mk(t[n], n); };
    return d;
  };
  const localFs = { resolvePath: async (p, o) => {
    if (o && o.kind === 'file') {
      const parts = p.replace(/^skills\//, '').split('/');
      const leaf = parts.pop();
      const d = dirAt(parts.join('/'));
      return d && typeof d[leaf] === 'string' ? { getFile: async () => ({ text: async () => d[leaf] }) } : null;
    }
    const d = p === 'skills' ? tree : dirAt(p.replace(/^skills\//, ''));
    return d ? mk(d, p.split('/').pop()) : null;
  } };
  return { localFs, removed };
}

test('folder: delete / rename of a skill another one requires is refused naming it; regroup is allowed', async () => {
  const tree = {
    flow: { 'SKILL.md': '---\nname: flow\n---\n', scripts: { 'c.py': 'print(1)' } },
    auto: { 'SKILL.md': '---\nname: auto\n---\n', scripts: { 'a.py': "load_script('flow', 'c.py')" } },
    grp: {},
  };
  const { localFs, removed } = folderRoot(tree);
  const { fs } = load({ localFs });
  const del = await fs.deleteSkill('flow');
  assert.equal(del.ok, false);
  assert.equal(del.error, '"flow" can\'t be deleted: auto need(s) it to run (listed in its required skills). Delete auto first, or remove "flow" from its required skills.');
  assert.deepEqual(removed, []);
  const ren = await fs.renameSkill('flow', 'flow2');
  assert.equal(ren.error, '"flow" can\'t be renamed: auto need(s) it to run (listed in its required skills).');
  assert.equal((await fs.renameSkill('flow', 'flow')).ok, true);   // same leaf: nothing to refuse
  // auto itself is needed by nobody: it can go.
  assert.equal((await fs.deleteSkill('auto')).ok, true);
  assert.equal((await fs.deleteSkill('flow')).ok, true);
});

test('store: a SkillRequiredBy refusal is shown translated, naming the dependents', async () => {
  const body = (reason) => [409, { success: false, data: { message: 'x', reason, skill: 'g/flow', required_by: ['auto'] }, error: 'x' }];
  const { fs } = load({ routes: { ...volume, 'DELETE /skills': () => body('delete'), 'POST /skills/move': () => body('rename') } });
  const d = await fs.deleteSkill('g/flow');
  assert.match(d.error, /^"flow" can't be deleted: auto need\(s\) it to run/);
  assert.deepEqual([...d.requiredBy], ['auto']);
  assert.match((await fs.renameSkill('g/flow', 'x')).error, /^"flow" can't be renamed: auto/);
});

test('store setVisibility: dryRun asks which required skills go public along', async () => {
  const sent = [];
  const { fs } = load({ routes: { ...volume, 'PUT /skills/visibility': (b) => { sent.push(b); return [200, { made_public: ['flow'] }]; } } });
  assert.deepEqual([...(await fs.setVisibility('auto', 'public', { dryRun: true })).made_public], ['flow']);
  assert.equal(sent[0].dry_run, true);
  await fs.setVisibility('auto', 'public', { expectPublic: ['flow'] });
  assert.equal(sent[1].dry_run, undefined);
  assert.deepEqual(sent[1].expect_public, ['flow']);   // the server refuses when the closure is no longer what was confirmed
});

test('store public import: the plan says which of my private skills go public along; the confirmed list goes with each import', async () => {
  const posts = [];
  const { fs } = load({ routes: { ...volume, 'POST /skills/import': (b) => {
    posts.push(b);
    if (b.dry_run) return [200, b.path === 'auto' ? { status: 'new', made_public: ['flow'] } : { status: 'identical' }];
    return [200, { status: 'installed', made_public: b.expect_public || [] }];
  } } });
  const read = sk('auto', 'A', [sk('flow', 'F')]);   // flow: already my identical PRIVATE skill
  const plan = await fs.importPlan(read, { visibility: 'public' });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map((x) => [x.dir, x.status, x.madePublic]))), [['flow', 'identical', []], ['auto', 'new', ['flow']]]);
  posts.length = 0;
  await fs.importSkill(read, { visibility: 'public', confirmed: { auto: ['flow'], flow: [] } });
  const real = posts.filter((p) => !p.dry_run);
  assert.deepEqual(real.map((p) => [p.path, p.visibility, p.expect_public]), [['auto', 'public', ['flow']]]);   // flow identical: not re-sent
});

test('store group delete: every skill is checked (dry run, with the rest of the group) before any is deleted', async () => {
  const calls = [];
  const { fs } = load({ routes: { ...volume,
    'GET /skills': () => [200, [{ path: 'g/a', mine: true }, { path: 'g/b', mine: true }, { path: 'c', mine: true }]],
    'DELETE /skills': (b, p) => { calls.push(p); return p.includes('g%2Fb') && p.includes('dry_run=1') ? [409, { data: { reason: 'delete', skill: 'g/b', required_by: ['c'] } }] : [200, {}]; },
  } });
  const r = await fs.deleteFolder('g');
  assert.equal(r.ok, false);
  assert.match(r.error, /^"b" can't be deleted: c need/);
  assert.ok(calls.every((c) => c.includes('dry_run=1')), 'nothing deleted');
  assert.ok(calls[0].includes('with=g%2Fb'));
});

test('folder group delete: a skill outside the group that needs one inside refuses it; needs inside the group do not', async () => {
  const tree = { g: { flow: { 'SKILL.md': 'x', scripts: { 'c.py': '1' } }, auto: { 'SKILL.md': 'x', scripts: { 'a.py': "'flow'" } } } };
  const { localFs, removed } = folderRoot(tree);
  const { fs } = load({ localFs });
  assert.equal((await fs.deleteFolder('g')).ok, true);
  assert.deepEqual(removed, ['g']);
  const tree2 = { g: { flow: { 'SKILL.md': 'x' } }, out: { 'SKILL.md': 'x', scripts: { 'a.py': "'flow'" } } };
  const f2 = folderRoot(tree2);
  const r = await load({ localFs: f2.localFs }).fs.deleteFolder('g');
  assert.equal(r.ok, false);
  assert.deepEqual([...r.requiredBy], ['out']);
  assert.deepEqual(f2.removed, []);
});

test('store import of a zip: every dry run and import names the other skills of the zip (incoming)', async () => {
  const posts = [];
  const { fs } = load({ routes: { ...volume, 'POST /skills/import': (b) => { posts.push(b); return [200, { status: b.dry_run ? 'new' : 'installed', made_public: [] }]; } } });
  const read = sk('auto', '---\nrequires-skills: [flow]\n---\n', [sk('pb', 'P'), sk('flow', '---\nrequires-skills: [pb]\n---\n')]);
  await fs.importSkill(read, { visibility: 'public' });
  const by = (dry) => posts.filter((p) => !!p.dry_run === dry).map((p) => [p.path, p.incoming]);
  assert.deepEqual(by(true), [['pb', ['flow', 'auto']], ['flow', ['pb', 'auto']], ['auto', ['pb', 'flow']]]);
  assert.deepEqual(by(false), [['pb', ['flow', 'auto']], ['flow', ['pb', 'auto']], ['auto', ['pb', 'flow']]]);
  // A single skill sends none.
  posts.length = 0;
  await fs.importSkill(sk('solo', 'S'), { visibility: 'public' });
  assert.equal(posts[0].incoming, undefined);
});
