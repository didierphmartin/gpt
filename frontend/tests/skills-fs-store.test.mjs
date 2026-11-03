import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skills-fs.js', import.meta.url)), 'utf8');
const SkillZip = createRequire(import.meta.url)('../assets/js/skill-zip.js');
const b64 = (s) => Buffer.from(s).toString('base64');

/** routes: { 'GET /skills/store': (body, url) => [status, json] } */
function load({ routes = {}, localFs } = {}) {
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
  const window = { APP_CONFIG: { API_BASE_URL: 'http://x/api/v1' }, authManager: { token: 'tok' }, SkillZip, localFs };
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
