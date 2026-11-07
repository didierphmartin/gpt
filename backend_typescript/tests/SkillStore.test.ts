import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import './support/fakeDb';
import { SkillStore } from '../src/Services/SkillStore';
import { SkillClashException, SkillForbidden, SkillNotFound, SkillPathInvalid, SkillRequiredBy } from '../src/Services/SkillErrors';

// Port of backend/tests/Unit/SkillStoreTest.php.

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(os.tmpdir() + '/skillstore_');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const store = (edition = 'corporate') => new SkillStore(root, edition);
const B = (o: Record<string, string>): Record<string, Buffer> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'binary')]));
const skill = (name = 'docx', extra = '') => B({
  'SKILL.md': `---\nname: ${name}\ndescription: Does ${name}\ndependencies: [python-docx, lxml]\n---\nBody${extra}\n`,
  'scripts/run.py': "print('hi')\n",
});
/** A skill whose script loads needs (load_script-style quoted name). */
const loader = (name: string, ...needs: string[]) => B({
  'SKILL.md': `---\nname: ${name}\n---\n`, 'scripts/create.py': needs.map((n) => `load_script('${n}', 'create.py')`).join('\n') + '\n',
});
const decl = (n: string, req: string) => B({ 'SKILL.md': `---\nname: ${n}\nrequires-skills: [${req}]\n---\n` });
const keys = (o: Record<string, any>) => Object.keys(o).sort();
const col = (rows: any[], k: string) => rows.map((r) => r[k]);
const byPath = (rows: any[], k: string) => Object.fromEntries(rows.map((r) => [r.path, r[k]]));

async function throwsAsync<T>(fn: () => any, cls: new (...a: any[]) => T): Promise<T> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof cls) return e;
    throw e;
  }
  throw new Error('expected ' + cls.name);
}

test('import defaults private and lists only for the owner', () => {
  const s = store();
  assert.deepEqual(s.import(1, 'docx', skill()), { status: 'installed' });
  const rows = s.list(1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].visibility, rows[0].mine, rows[0].name, rows[0].description, rows[0].dependencies],
    ['private', true, 'docx', 'Does docx', ['python-docx', 'lxml']]);
  assert.deepEqual(s.list(2), []);
});

test('listing strips one matching quote pair and reads quoted list items', () => {
  const s = store();
  const cases: Array<[string, string]> = [['say "hi"', 'say "hi"'], ["'say \"hi\"'", 'say "hi"'], ["\"'x'\"", "'x'"], ["'a' and 'b'", "a' and 'b"], ['"open', '"open']];
  cases.forEach(([raw], i) => {
    s.import(1, `q${i + 1}`, B({ 'SKILL.md': `---\nname: q${i + 1}\ndescription: ${raw}\ndependencies: [pandas>=2, 'numpy>=1.20,<2', 'requests[socks,security]']\n---\nB\n` }));
  });
  const rows = s.list(1);
  assert.deepEqual(col(rows, 'description'), cases.map((c) => c[1]));
  assert.deepEqual(rows[0].dependencies, ['pandas>=2', 'numpy>=1.20,<2', 'requests[socks,security]']);
});

test('a public skill is listed for everyone with its owner; individual edition is never public', async () => {
  const s = store();
  s.import(1, 'docx', skill());
  await s.setVisibility(1, 'docx', 'public');
  const rows = s.list(2);
  assert.deepEqual([rows.length, rows[0].visibility, rows[0].mine, rows[0].owner_id], [1, 'public', false, 1]);
  assert.ok(fs.existsSync(root + '/public/docx'));
  assert.ok(!fs.existsSync(root + '/users/1/docx'));
  const ind = new SkillStore(root + '/ind', 'individual');
  ind.import(1, 'docx', skill());
  await throwsAsync(() => ind.setVisibility(1, 'docx', 'public'), SkillForbidden);
});

test('the robot sees all in the individual edition, public only in corporate', async () => {
  for (const [edition, expected] of [['individual', 2], ['corporate', 1]] as const) {
    const r = `${root}/${edition}`;
    fs.mkdirSync(r);
    const s = new SkillStore(r, edition);
    s.import(1, 'a', skill('a'));
    s.import(2, 'b', skill('b'));
    if (edition === 'corporate') await s.setVisibility(1, 'a', 'public');
    assert.equal(s.list(99, true).length, expected, edition);
  }
  assert.equal(new SkillStore(root + '/individual', 'individual').readFile(99, 'b', 'scripts/run.py', true).toString(), "print('hi')\n");
  const c = store('corporate');
  c.import(99, 'mine', skill('mine'));
  assert.deepEqual(c.list(99, true), []);
  assert.equal(c.absolutePath(99, 'mine', true), null);
});

test('python bytecode is not skill content; identical re-imports; dry run; clash', () => {
  const s = store();
  s.import(1, 'docx', skill());
  s.writeFile(1, 'docx', 'scripts/__pycache__/run.cpython-312.pyc', Buffer.from('\x00bytecode'));
  s.writeFile(1, 'docx', 'scripts/old.pyc', Buffer.from('\x00bytecode'));
  assert.deepEqual(s.import(1, 'docx', skill()), { status: 'identical' });
  assert.equal(s.import(1, 'g/docx', skill()).status, 'identical');
  assert.deepEqual(s.import(1, 'docx', { ...skill(), 'scripts/__pycache__/x.pyc': Buffer.from('b') }), { status: 'identical' });
  assert.deepEqual(keys(s.files(1, 'docx')), ['SKILL.md', 'scripts/run.py']);
  assert.throws(() => s.import(1, 'docx', skill('docx', 'changed')), SkillClashException);

  const t = new SkillStore(root + '/t', 'corporate');
  assert.deepEqual(t.import(1, 'docx', skill(), 'private', true), { status: 'new' });
  assert.deepEqual(t.list(1), []);
  t.import(1, 'docx', skill());
  assert.deepEqual(t.import(1, 'docx', skill(), 'private', true), { status: 'identical' });
  assert.throws(() => t.import(1, 'docx', skill('docx', 'changed'), 'private', true), SkillClashException);
});

test('the leaf is unique across public and the own area; another private never blocks or reveals', async () => {
  const s = store();
  s.import(1, 'docx', skill());
  await s.setVisibility(1, 'docx', 'public');
  const e = await throwsAsync(() => s.import(2, 'x/docx', skill('docx', 'other')), SkillClashException);
  assert.equal(e.statusCode(), 409);
  assert.ok(!e.message.includes('users/1') && !e.message.toLowerCase().includes('owner'));
  s.import(1, 'pdf', skill('pdf'));
  assert.deepEqual(s.import(2, 'x/pdf', skill('pdf')), { status: 'installed' });
  assert.throws(() => s.import(2, 'y/pdf', skill('pdf', 'other')), SkillClashException);
  s.import(2, 'g/docx2', skill('docx2', 'b'));
  assert.deepEqual(store().import(3, 'pdf', skill('pdf', 'mine')), { status: 'installed' });
});

test('only the owner writes, deletes, moves and changes visibility; another private is not found', async () => {
  const s = store();
  s.import(1, 'docx', skill());
  await s.setVisibility(1, 'docx', 'public');
  for (const op of [() => s.writeFile(2, 'docx', 'SKILL.md', Buffer.from('x')), () => s.delete(2, 'docx'), () => s.move(2, 'docx', 'other'),
    () => s.setVisibility(2, 'docx', 'private')]) {
    assert.equal((await throwsAsync(op, SkillForbidden)).statusCode(), 403);
  }
  assert.equal(s.readFile(2, 'docx', 'scripts/run.py').toString(), "print('hi')\n");
  s.import(1, 'priv', skill('priv'));
  assert.throws(() => s.files(2, 'priv'), SkillNotFound);
});

test('owner write and delete; group paths; unsafe paths', async () => {
  const s = store();
  s.import(1, 'g/docx', skill());
  s.writeFile(1, 'g/docx', 'notes/a.txt', Buffer.from('A'));
  assert.equal(s.readFile(1, 'g/docx', 'notes/a.txt').toString(), 'A');
  await s.delete(1, 'g/docx');
  assert.deepEqual(s.list(1), []);
  assert.equal(s.absolutePath(1, 'g/docx'), null);

  s.import(1, 'GEO/geo-report', skill('geo-report'));
  assert.equal(s.list(1)[0].path, 'GEO/geo-report');
  await s.move(1, 'GEO/geo-report', 'geo-report');
  assert.equal(s.list(1)[0].path, 'geo-report');
  assert.ok(!fs.existsSync(root + '/users/1/GEO'));

  for (const bad of ['../x', '/x', 'a/.hidden', 'a//b', '', 'a\\b', 'a/b/c']) {
    assert.equal((await throwsAsync(() => s.import(1, bad, skill()), SkillPathInvalid)).statusCode(), 400, bad);
  }
  assert.throws(() => s.readFile(1, 'geo-report', '../../secret'), SkillPathInvalid);
});

test('listing gives paths and sizes, sorted, without hidden files; not found for another private; bad path', () => {
  const s = store();
  const f = { ...skill(), ...B({ 'references/b.md': 'bb', 'references/a.md': 'a', 'Zed.txt': 'zzz', '.hidden': 'h', '.wheels/a.whl': 'W',
    'scripts/__pycache__/x.pyc': 'P', 'scripts/.dot/y.py': 'y', 'scripts/mod.pyc': 'P' }) };
  s.import(1, 'docx', f);
  const out = s.listing(1, 'docx');
  assert.deepEqual(col(out, 'rel'), ['SKILL.md', 'Zed.txt', 'references/a.md', 'references/b.md', 'scripts/run.py']);
  assert.equal(out[0].size, f['SKILL.md'].length);
  assert.deepEqual(Object.keys(out[1]), ['rel', 'size']);
  assert.equal(out[1].size, 3);
  assert.throws(() => s.listing(2, 'docx'), SkillNotFound);
  assert.throws(() => s.listing(1, '../x'), SkillPathInvalid);
});

test('files leave native wheels out; identical ignores wheels; a stale folder is cleared', () => {
  const s = store();
  s.import(1, 'docx', { ...skill(), ...B({ '.wheels/a.whl': 'W', '.wheels/native/b.whl': 'N' }) });
  assert.deepEqual(keys(s.files(1, 'docx')), ['.wheels/a.whl', 'SKILL.md', 'scripts/run.py']);
  assert.deepEqual(keys(s.files(1, 'docx', false, false)), ['SKILL.md', 'scripts/run.py']);
  assert.equal(s.import(1, 'docx', skill()).status, 'identical');
  fs.mkdirSync(root + '/users/1/pdf', { recursive: true });
  fs.writeFileSync(root + '/users/1/pdf/stale.txt', 'old');
  s.import(1, 'pdf', skill('pdf'));
  assert.ok(!('stale.txt' in s.files(1, 'pdf')));
});

test('delete and rename are refused while another skill requires it; regrouping is allowed', async () => {
  const s = store();
  s.import(1, 'flow', loader('flow'));
  s.import(1, 'auto', loader('auto', 'flow'));
  let e = await throwsAsync(() => s.delete(1, 'flow'), SkillRequiredBy);
  assert.equal(e.statusCode(), 409);
  assert.deepEqual(e.data().required_by, ['auto']);
  assert.equal(e.message, '"flow" can\'t be deleted: auto need(s) it to run (listed in its required skills). Delete auto first, or remove "flow" from its required skills.');
  e = await throwsAsync(() => s.move(1, 'flow', 'flow2'), SkillRequiredBy);
  assert.equal(e.message, '"flow" can\'t be renamed: auto need(s) it to run (listed in its required skills).');
  await s.move(1, 'flow', 'grp/flow');
  assert.deepEqual(col(s.list(1), 'path'), ['auto', 'grp/flow']);
  await s.delete(1, 'auto');
  await s.delete(1, 'grp/flow');
  assert.deepEqual(s.list(1), []);
});

test('make public takes my private required skills along, atomically; private is refused while needed', async () => {
  const s = store();
  s.import(1, 'pb', loader('pb'));
  s.import(1, 'flow', loader('flow', 'pb'));
  s.import(1, 'auto', loader('auto', 'flow'));
  assert.deepEqual(await s.setVisibility(1, 'auto', 'public', true), { made_public: ['flow', 'pb'] });
  assert.deepEqual(col(s.list(1), 'visibility'), ['private', 'private', 'private']);
  assert.deepEqual(await s.setVisibility(1, 'auto', 'public'), { made_public: ['flow', 'pb'] });
  assert.deepEqual(col(s.list(1), 'visibility'), ['public', 'public', 'public']);
  assert.equal(s.list(2).length, 3);
  const e = await throwsAsync(() => s.setVisibility(1, 'flow', 'private'), SkillRequiredBy);
  assert.equal(e.message, '"flow" can\'t be made private: the public skill(s) auto need it to run.');
  await s.setVisibility(1, 'auto', 'private');
  assert.deepEqual(await s.setVisibility(1, 'auto', 'public'), { made_public: [] });
});

test('make public: a clash rolls back; an invisible requirement refuses; a changed confirmed list is refused', async () => {
  let s = store();
  s.import(1, 'pb', loader('pb'));
  s.import(1, 'auto', loader('auto', 'pb'));
  s.import(2, 'g/pb', loader('pb', 'zzz'));
  await s.setVisibility(2, 'g/pb', 'public');
  const c = await throwsAsync(() => s.setVisibility(1, 'auto', 'public'), SkillClashException);
  assert.match(c.message, /'pb'/);
  assert.deepEqual(col(s.list(1).filter((r) => r.mine), 'visibility'), ['private', 'private']);

  s = new SkillStore(root + '/b', 'corporate');
  s.import(1, 'auto', B({ 'SKILL.md': '---\nname: auto\nrequires-skills: [secret]\n---\n' }));
  s.import(2, 'secret', loader('secret'));
  const e = await throwsAsync(() => s.setVisibility(1, 'auto', 'public'), SkillRequiredBy);
  assert.equal(e.message, '"auto" needs "secret", which you can\'t make public.');

  s = new SkillStore(root + '/c', 'corporate');
  s.import(1, 'pb', loader('pb'));
  s.import(1, 'auto', loader('auto', 'pb'));
  const e2 = await throwsAsync(() => s.setVisibility(1, 'auto', 'public', false, []), SkillRequiredBy);
  assert.deepEqual(e2.data().required_by, ['pb']);
  assert.deepEqual(await s.setVisibility(1, 'auto', 'public', false, ['pb']), { made_public: ['pb'] });
});

test('a failed relocation rolls back every move', async () => {
  const s = store();
  s.import(1, 'a1', loader('a1'));
  s.import(1, 'b2', loader('b2'));
  s.import(1, 'auto', loader('auto', 'a1', 'b2'));
  fs.mkdirSync(root + '/public/b2', { recursive: true });
  fs.writeFileSync(root + '/public/b2/x', 'a non-empty folder: the move cannot land');
  const e = await throwsAsync(() => s.setVisibility(1, 'auto', 'public'), Error);
  assert.ok(!(e instanceof SkillRequiredBy));
  assert.ok(fs.existsSync(root + '/users/1/auto') && fs.existsSync(root + '/users/1/a1'));
  assert.ok(!fs.existsSync(root + '/public/auto'));
  assert.deepEqual(col(s.list(1), 'visibility'), ['private', 'private', 'private']);
});

test('a public import takes an identical own private required skill public; a zip whose skills declare each other', () => {
  let s = store();
  s.import(1, 'flow', loader('flow'));
  assert.deepEqual(s.import(1, 'flow', loader('flow'), 'public', true), { status: 'identical' });
  const auto = loader('auto', 'flow');
  assert.deepEqual(s.import(1, 'auto', auto, 'public', true), { status: 'new', made_public: ['flow'] });
  assert.equal(s.list(1)[0].visibility, 'private');
  const e = (() => {
    try {
      s.import(1, 'auto', auto, 'public', false, []);
    } catch (x) {
      return x as SkillRequiredBy;
    }
    throw new Error('expected');
  })();
  assert.equal(e.data().reason, 'changed');
  assert.deepEqual(s.import(1, 'auto', auto, 'public', false, ['flow']), { status: 'installed', made_public: ['flow'] });
  assert.deepEqual(col(s.list(1), 'visibility'), ['public', 'public']);

  s = new SkillStore(root + '/z', 'corporate');
  const batch = ['pb', 'flow', 'auto'];
  assert.deepEqual(s.import(1, 'pb', loader('pb'), 'public', true, null, batch), { status: 'new', made_public: [] });
  assert.deepEqual(s.import(1, 'flow', decl('flow', 'pb'), 'public', true, null, batch), { status: 'new', made_public: [] });
  assert.deepEqual(s.import(1, 'auto', decl('auto', 'flow'), 'public', true, null, batch), { status: 'new', made_public: [] });
  s.import(1, 'pb', loader('pb'), 'public', false, [], batch);
  s.import(1, 'flow', decl('flow', 'pb'), 'public', false, [], batch);
  s.import(1, 'auto', decl('auto', 'flow'), 'public', false, [], batch);
  assert.deepEqual(col(s.list(1), 'visibility'), ['public', 'public', 'public']);
  assert.throws(() => s.import(1, 'lone', decl('lone', 'ghost'), 'public', true, null, ['lone']),
    (x: any) => x instanceof SkillRequiredBy && x.message === '"lone" needs "ghost", which you can\'t make public.');
});

test("another user's skills never block mine; same leaf private mine and public theirs", async () => {
  let s = store();
  s.import(1, 'flow', loader('flow'));
  await s.setVisibility(1, 'flow', 'public');
  s.import(2, 'auto', loader('auto', 'flow'));
  await s.delete(1, 'flow');
  assert.deepEqual(s.list(1), []);

  s = new SkillStore(root + '/y', 'corporate');
  s.import(3, 'y', loader('y'));
  s.import(4, 'g/needs-y', loader('needs-y', 'y'));
  await s.setVisibility(4, 'g/needs-y', 'public');
  assert.ok(col(s.list(3), 'path').includes('g/needs-y'));
  await s.delete(3, 'y');
  assert.deepEqual(col(s.list(3), 'path'), ['g/needs-y']);

  s = new SkillStore(root + '/x', 'corporate');
  s.import(1, 'x', loader('x', 'v1'));
  s.import(2, 'x', loader('x', 'v2'));
  s.import(2, 'uses-x', loader('uses-x', 'x'));
  await s.setVisibility(2, 'uses-x', 'public', false, ['x']);
  await s.delete(1, 'x');
  const e = await throwsAsync(() => s.delete(2, 'x'), SkillRequiredBy);
  assert.deepEqual(e.data().required_by, ['uses-x']);
});

test('group delete: dry run and with; except compares area and path', async () => {
  let s = store();
  s.import(1, 'g/flow', loader('flow'));
  s.import(1, 'g/auto', loader('auto', 'flow'));
  s.import(1, 'other', loader('other'));
  await s.delete(1, 'g/flow', true, ['g/auto']);
  assert.equal(s.list(1).length, 3);
  s.import(1, 'outside', loader('outside', 'flow'));
  let e = await throwsAsync(() => s.delete(1, 'g/flow', true, ['g/auto']), SkillRequiredBy);
  assert.deepEqual(e.data().required_by, ['outside']);

  s = new SkillStore(root + '/e', 'corporate');
  s.import(1, 'g/flow', loader('flow'));
  await s.setVisibility(1, 'g/flow', 'public');
  s.import(2, 'g/auto', loader('auto', 'flow'));
  await s.setVisibility(2, 'g/auto', 'public');
  e = await throwsAsync(() => s.delete(1, 'g/flow', true, ['g/auto']), SkillRequiredBy);
  assert.deepEqual(e.data().required_by, ['g/auto']);
});

test("list rows carry direct requires from the caller's view; another's public resolves against public; the robot's view", async () => {
  let s = store();
  s.import(1, 'leaf', decl('leaf', ''));
  s.import(1, 'mid', decl('mid', 'leaf'));
  s.import(1, 'top', decl('top', 'mid'));
  s.import(2, 'theirs', decl('theirs', 'secret'));
  s.import(2, 'secret', decl('secret', ''));
  s.import(2, 'viewer', decl('viewer', 'pub'));
  s.import(2, 'pub', decl('pub', ''));
  await s.setVisibility(2, 'viewer', 'public');
  await s.setVisibility(2, 'pub', 'public');
  assert.ok(!('requires' in s.list(1)[0]));
  const r1 = byPath(s.list(1, false, true), 'requires');
  assert.deepEqual([r1.leaf, r1.mid, r1.top, r1.viewer], [[], ['leaf'], ['mid'], ['pub']]);
  assert.ok(!('theirs' in r1) && !('secret' in r1));

  s = new SkillStore(root + '/p', 'corporate');
  s.import(1, 'g/x', decl('x', ''));
  s.import(2, 'h/x', decl('x', ''));
  await s.setVisibility(2, 'h/x', 'public');
  s.import(2, 'p', decl('p', 'x'));
  await s.setVisibility(2, 'p', 'public');
  s.import(1, 'mine', decl('mine', 'x'));
  const r = byPath(s.list(1, false, true), 'requires');
  assert.deepEqual([r.p, r.mine], [['h/x'], ['g/x']]);

  s = new SkillStore(root + '/r', 'corporate');
  s.import(1, 'x', decl('x', ''));
  s.import(1, 'a', decl('a', 'x'));
  await s.setVisibility(1, 'a', 'public');
  s.import(1, 'priv', decl('priv', ''));
  assert.deepEqual(byPath(s.list(1, true, true), 'requires'), { a: ['x'], x: [] });
});

test("the compile resolver prefers the dependent's group, then own, then public", async () => {
  const s = store();
  s.import(1, 'B/y', loader('y', '2'));
  s.import(2, 'A/y', loader('y', '1'));
  await s.setVisibility(2, 'A/y', 'public');
  const r = s.compileResolver(1, false);
  const real = (p: string | null) => fs.realpathSync(String(p));
  assert.equal(real(r('y', 'me')), real(root + '/users/1/B/y'));
  assert.equal(real(r('y', 'A/needs')), real(root + '/public/A/y'));
  assert.equal(real(s.compileResolver(3, false)('y')), real(root + '/public/A/y'));
  assert.equal(s.compileResolver(3, false)('../x'), null);
});
