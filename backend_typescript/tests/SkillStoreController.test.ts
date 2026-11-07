import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { installFakeDb } from './support/fakeDb';
import { SkillStoreController } from '../src/Controllers/SkillStoreController';
import { SkillStore } from '../src/Services/SkillStore';
import { SkillWheelError, SkillWheelFetcher } from '../src/Services/SkillWheelFetcher';

// Port of backend/tests/Unit/Controllers/SkillStoreControllerTest.php and SkillWheelFetcherTest.php.

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(os.tmpdir() + '/skillctl-');
  installFakeDb((sqlText) => (/FROM users WHERE id IN/.test(sqlText) ? [{ id: 7, email: 'seven@x.test', first_name: 'Ann', last_name: 'Lee' }] : []));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ctl = (volume = true, edition = 'individual') => {
  const store = volume ? new SkillStore(root, edition) : null;
  return new SkillStoreController({ edition }, () => store);
};
const req = (q: Record<string, any> = {}, b: any = {}, uid = 7): any =>
  ({ method: 'GET', uri: '/', headers: {}, query: q, body: b, user_id: uid, auth_type: 'jwt', params: {}, remote_addr: '' });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const importSkill = (c: SkillStoreController, path = 'g/demo', text = 'hi', uid = 7) =>
  c.import(req({}, { path, visibility: 'private', files: { 'SKILL.md': b64(`---\nname: demo\ndescription: d\n---\n${text}`) } }, uid));

test('store reports folder mode without SKILLS_DIR, volume mode and edition with one', async () => {
  const saved = process.env.SKILLS_DIR;
  delete process.env.SKILLS_DIR;
  try {
    const r = await new SkillStoreController({}).store(req());
    assert.deepEqual([r.success, r.data.mode], [true, 'folder']);
  } finally {
    if (saved !== undefined) process.env.SKILLS_DIR = saved;
  }
  assert.deepEqual((await ctl(true, 'corporate').store(req())).data, { mode: 'volume', edition: 'corporate' });
});

test('every route but store and native-wheels is 404 in folder mode', async () => {
  const c = ctl(false);
  for (const r of [await c.list(req()), await c.files(req({ path: 'a' })), await c.listing(req({ path: 'a' })), await c.readFile(req({ path: 'a', rel: 'b' })),
    await c.writeFile(req()), await c.import(req()), await c.visibility(req()), await c.move(req()), await c.delete(req({ path: 'a' }))]) {
    assert.deepEqual([r.status_code, r.error, r.data], [404, 'no skill store', { message: 'no skill store' }]);
  }
});

test('import, list, files, file round trip; listing is rel and size; wheels=0 leaves .wheels out', async () => {
  const c = ctl();
  assert.deepEqual((await importSkill(c)).data, { status: 'installed' });
  const list = (await c.list(req())).data;
  assert.deepEqual([list[0].path, list[0].name, list[0].mine, list[0].owner_name], ['g/demo', 'demo', true, '']);
  assert.equal(Buffer.from((await c.files(req({ path: 'g/demo' }))).data.files['SKILL.md'], 'base64').toString(), '---\nname: demo\ndescription: d\n---\nhi');
  await c.writeFile(req({}, { path: 'g/demo', rel: '.wheels/pyodide/a.whl', content: b64('W') }));
  assert.deepEqual(Object.keys((await c.files(req({ path: 'g/demo' }))).data.files).sort(), ['.wheels/pyodide/a.whl', 'SKILL.md']);
  assert.deepEqual(Object.keys((await c.files(req({ path: 'g/demo', wheels: '0' }))).data.files), ['SKILL.md']);
  assert.equal(Buffer.from((await c.readFile(req({ path: 'g/demo', rel: '.wheels/pyodide/a.whl' }))).data.content, 'base64').toString(), 'W');
  assert.deepEqual((await c.listing(req({ path: 'g/demo' }))).data, { files: [{ rel: 'SKILL.md', size: 36 }] });
  assert.deepEqual((await importSkill(c, 'other', 'x', 7)).data, { status: 'installed' });
  const dry = await c.import(req({}, { path: 'dry', dry_run: true, files: { 'SKILL.md': b64('---\nname: dry\n---\n') } }));
  assert.deepEqual(dry.data, { status: 'new' });
  assert.ok(!fs.existsSync(root + '/users/7/dry'));
});

test('the list names the owner of skills that are not mine', async () => {
  const c = ctl(true, 'corporate');
  await importSkill(c);
  await c.visibility(req({}, { path: 'g/demo', visibility: 'public' }));
  const rows = (await c.list(req({}, {}, 8))).data;
  assert.deepEqual([rows[0].mine, rows[0].owner_id, rows[0].owner_name], [false, 7, 'Ann Lee']);
});

test('error statuses pass through: clash, move onto a taken path, 404, 403, 400, bad base64', async () => {
  const c = ctl(true, 'corporate');
  await importSkill(c);
  await c.visibility(req({}, { path: 'g/demo', visibility: 'public' }));
  const clash = await importSkill(c, 'g/demo', 'other');
  assert.deepEqual([clash.status_code, clash.error, clash.data], [409, 'clash', { clash: 'different', message: "A different skill is already installed at 'g/demo'." }]);
  await importSkill(c, 'g/a', 'a');
  await importSkill(c, 'g/b', 'b');
  const mv = await c.move(req({}, { from: 'g/a', to: 'g/b' }));
  assert.deepEqual([mv.status_code, mv.data.message], [409, "A skill already exists at 'g/b'."]);
  assert.equal((await c.files(req({ path: 'nope' }))).status_code, 404);
  assert.equal((await c.writeFile(req({}, { path: 'g/demo', rel: 'x', content: '' }, 8))).status_code, 403);
  assert.equal((await c.readFile(req({ path: 'g/demo', rel: 'zzz' }))).status_code, 404);
  assert.equal((await c.files(req({ path: '../x' }))).status_code, 400);
  assert.equal((await c.import(req({}, { path: '../x', files: [] }))).status_code, 400);
  assert.equal((await c.import(req({}, { path: 'a', files: { 'SKILL.md': '***' } }))).status_code, 400);
  assert.equal((await c.writeFile(req({}, { path: 'a', rel: 'x', content: '!!' }))).status_code, 400);
  assert.equal((await c.import(req({}, { path: 'a', files: 'nope' }))).status_code, 400);
});

test('a required skill refuses delete with required_by; a robot workflow binding a public skill refuses it (SkillInUse)', async () => {
  const c = ctl(true, 'corporate');
  await c.import(req({}, { path: 'flow', files: { 'SKILL.md': b64('---\nname: flow\n---\n') } }));
  await c.import(req({}, { path: 'auto', files: { 'SKILL.md': b64('---\nname: auto\nrequires-skills: [flow]\n---\n') } }));
  const r = await c.delete(req({ path: 'flow' }));
  assert.deepEqual([r.status_code, r.data.reason, r.data.required_by], [409, 'delete', ['auto']]);
  assert.equal((await c.delete(req({ path: 'flow', dry_run: '1', with: 'auto' }))).success, true);

  const store = new SkillStore(root + '/inuse', 'corporate', async (leaf) => (leaf === 'pub' ? [{ id: 75, name: 'Mail to PDF' }] : []));
  const d = new SkillStoreController({ edition: 'corporate' }, () => store);
  await d.import(req({}, { path: 'pub', visibility: 'public', files: { 'SKILL.md': b64('---\nname: pub\n---\n') } }));
  for (const x of [await d.delete(req({ path: 'pub' })), await d.visibility(req({}, { path: 'pub', visibility: 'private' })),
    await d.move(req({}, { from: 'pub', to: 'pub2' }))]) {
    assert.deepEqual([x.status_code, x.data.robot_workflows], [409, [{ id: 75, name: 'Mail to PDF' }]]);
  }
  assert.equal((await d.move(req({}, { from: 'pub', to: 'grp/pub' }))).success, true); // regrouping keeps the leaf
});

test('as=robot only narrows the view; visibility, move, delete', async () => {
  const c = ctl(true, 'corporate');
  await importSkill(c);
  assert.equal((await c.list(req())).data.length, 1);
  const r = await c.list(req({ as: 'robot' }, {}, 8));
  assert.deepEqual([r.success, r.data], [true, []]);
  assert.equal((await c.files(req({ path: 'g/demo', as: 'robot' }))).status_code, 404);
  assert.equal((await c.visibility(req({}, { path: 'g/demo', visibility: 'public' }))).success, true);
  assert.equal((await c.list(req())).data[0].visibility, 'public');
  assert.deepEqual((await c.move(req({}, { from: 'g/demo', to: 'g/new' }))).data, { path: 'g/new' });
  assert.equal((await c.delete(req({ path: 'g/new' }))).success, true);
  assert.deepEqual((await c.list(req())).data, []);
});

test('native-wheels: 400 on a bad list, the fetcher error status, base64 wheels; folder mode too', async () => {
  const wheels = { fetch: async (deps: string[]) => {
    if (deps[0] === 'bad') throw new SkillWheelError('No compatible wheel for bad on manylinux_2_17_x86_64.', 422, { library: 'bad', platform: 'manylinux_2_17_x86_64' });
    return { 'foo-1-py3-none-any.whl': Buffer.from('PK') };
  } };
  const c = new SkillStoreController({}, () => null, wheels);
  assert.equal((await c.nativeWheels(req({}, { dependencies: 'x' }))).status_code, 400);
  assert.equal((await c.nativeWheels(req({}, { dependencies: [1] }))).status_code, 400);
  assert.deepEqual((await c.nativeWheels(req({}, { dependencies: ['foo'] }))).data, { wheels: { 'foo-1-py3-none-any.whl': b64('PK') } });
  const e = await c.nativeWheels(req({}, { dependencies: ['bad'] }));
  assert.deepEqual([e.status_code, e.data.library, e.data.platform], [422, 'bad', 'manylinux_2_17_x86_64']);
});

// ---- SkillWheelFetcher ----

const opt = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

function fetcher(handler: (argv: string[], dest: string) => { code: number; out: string }, calls: string[][]) {
  return new SkillWheelFetcher(async (argv) => {
    calls.push(argv);
    if (argv.includes('--version')) return { code: 0, out: 'pip 24' };
    return handler(argv, (opt(argv, '--dest') ?? opt(argv, '--wheel-dir'))!);
  }, 'python3');
}

test('wheels: one pip download per platform group; identical filenames deduped', async () => {
  const calls: string[][] = [];
  const f = fetcher((argv, dest) => {
    const plat = opt(argv, '--platform');
    fs.writeFileSync(`${dest}/foo-1.0-cp312-cp312-${plat}.whl`, 'w' + plat);
    return { code: 0, out: '' };
  }, calls);
  const wheels = await f.fetch(['foo', 'bar>=2']);
  const dl = calls.filter((a) => a[3] === 'download');
  assert.equal(dl.length, 3);
  for (const argv of dl) {
    assert.ok(argv.includes('--only-binary=:all:') && argv.includes('foo') && argv.includes('bar>=2') && argv.includes('--no-cache-dir'));
    assert.deepEqual([opt(argv, '--python-version'), opt(argv, '--implementation')], ['3.12', 'cp']);
    for (const abi of ['cp312', 'abi3', 'none']) assert.ok(argv.includes(abi));
  }
  assert.ok(dl[0].includes('manylinux_2_17_x86_64') && dl[0].includes('manylinux2014_x86_64'));
  assert.ok(dl[1].includes('manylinux2014_aarch64') && dl[2].includes('macosx_11_0_arm64'));
  assert.equal(Object.keys(wheels).length, 3);
  assert.ok(!fs.existsSync(opt(dl[0], '--dest')!));

  const same = fetcher((_a, dest) => {
    fs.writeFileSync(`${dest}/foo-1.0-py3-none-any.whl`, 'same');
    return { code: 0, out: '' };
  }, []);
  assert.deepEqual(Object.fromEntries(Object.entries(await same.fetch(['foo'])).map(([k, v]) => [k, v.toString()])), { 'foo-1.0-py3-none-any.whl': 'same' });
});

test('wheels: a pure-Python sdist is built once; a native build is 422; other pip failures are 502', async () => {
  const calls: string[][] = [];
  const f = fetcher((argv, dest) => {
    if (argv[3] === 'wheel') {
      fs.writeFileSync(`${dest}/foo-1.0-py3-none-any.whl`, 'built');
      return { code: 0, out: '' };
    }
    if (argv.includes('--find-links')) {
      fs.writeFileSync(`${dest}/foo-1.0-py3-none-any.whl`, 'built');
      fs.writeFileSync(`${dest}/dep-2.0-py3-none-any.whl`, 'dep');
      return { code: 0, out: '' };
    }
    return argv.includes('foo') ? { code: 1, out: 'ERROR: No matching distribution found for foo' } : { code: 0, out: '' };
  }, calls);
  const w = await f.fetch(['foo']);
  assert.deepEqual(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v.toString()])), { 'dep-2.0-py3-none-any.whl': 'dep', 'foo-1.0-py3-none-any.whl': 'built' });
  const builds = calls.filter((a) => a[3] === 'wheel');
  assert.equal(builds.length, 1, 'sdist built once across the three platform groups');
  assert.ok(builds[0].includes('--no-deps') && builds[0].includes('foo'));

  const native = fetcher((argv, dest) => {
    if (argv[3] === 'wheel') {
      fs.writeFileSync(`${dest}/foo-1.0-cp312-cp312-linux_x86_64.whl`, 'native');
      return { code: 0, out: '' };
    }
    return { code: 1, out: 'ERROR: No matching distribution found for foo' };
  }, []);
  await assert.rejects(native.fetch(['foo']), (e: any) => e instanceof SkillWheelError && e.statusCode() === 422
    && JSON.stringify(e.data()) === JSON.stringify({ library: 'foo', platform: 'manylinux_2_17_x86_64' }));

  const other: string[][] = [];
  await assert.rejects(fetcher(() => ({ code: 1, out: 'WARNING: connection refused to pypi.org' }), other).fetch(['foo']),
    (e: any) => e instanceof SkillWheelError && e.statusCode() === 502 && /Could not download the libraries: .*connection refused/.test(e.message));
  assert.deepEqual(other.filter((a) => a[3] === 'wheel'), []);
});

test('wheels: no deps runs nothing; an option-looking dependency is 400; no python is 503', async () => {
  const calls: string[][] = [];
  assert.deepEqual(await fetcher(() => { throw new Error('no command expected'); }, calls).fetch([]), {});
  assert.deepEqual(calls, []);
  await assert.rejects(fetcher(() => ({ code: 0, out: '' }), calls).fetch(['--index-url=http://evil']),
    (e: any) => e instanceof SkillWheelError && e.statusCode() === 400);
  assert.deepEqual(calls.filter((a) => a[3] === 'download'), []);
  await assert.rejects(new SkillWheelFetcher(async () => ({ code: 127, out: 'not found' }), 'python3').fetch(['foo']),
    (e: any) => e instanceof SkillWheelError && e.statusCode() === 503 && e.message === 'Exporting a skill with libraries needs Python 3 on the server.');
});
