import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fflate = require('./fixtures/fflate.js');
const SkillZip = require('../assets/js/skill-zip.js');
const WP = require('../assets/js/workflow-package.js');
const enc = new TextEncoder();
const o = { fflate };
const md = (deps) => enc.encode(`---\nname: x\n${deps}---\nbody`);

test('round trip with wheels and dependencies', async () => {
    const files = { 'SKILL.md': md('dependencies: [numpy, "pandas"]\n'), 'scripts/a.py': enc.encode('print(1)') };
    const z = await SkillZip.build({ dir: 'pdf', name: 'PDF', files, pyodideWheels: { 'a.whl': enc.encode('A') }, nativeWheels: { 'b.whl': enc.encode('B') } }, o);
    const r = SkillZip.read(z, o);
    assert.equal(r.legacy, false);
    assert.equal(r.dir, 'pdf');
    assert.deepEqual(Object.keys(r.files).sort(), ['SKILL.md', 'scripts/a.py']);
    assert.deepEqual(r.manifest.dependencies, ['numpy', 'pandas']);
    assert.deepEqual(r.manifest.wheels, { pyodide: ['a.whl'], native: ['b.whl'] });
    assert.equal(dec(r.pyodideWheels['a.whl']), 'A');
    assert.equal(r.manifest.files_hash, await WP.filesHash(r.files));
    const back = SkillZip.fromStoreFiles(SkillZip.toStoreFiles(r));
    assert.deepEqual(Object.keys(back.files).sort(), ['SKILL.md', 'scripts/a.py']);
    assert.deepEqual(Object.keys(back.nativeWheels), ['b.whl']);
    assert.equal(JSON.parse(dec(SkillZip.toStoreFiles(r)['.wheels/wheels.json'])).pyodide[0], 'a.whl');
});
function dec(b) { return new TextDecoder().decode(b); }

test('single-form dependency and none', async () => {
    assert.deepEqual(SkillZip.skillDependencies('---\ndependencies: foo\n---\n'), ['foo']);
    const z = await SkillZip.build({ dir: 's', name: 's', files: { 'SKILL.md': md('') } }, o);
    assert.deepEqual(SkillZip.read(z, o).manifest.wheels, { pyodide: [], native: [] });
});

test('group dir round trips', async () => {
    const z = await SkillZip.build({ dir: 'GEO/geo-report', name: 'r', files: { 'SKILL.md': md('') } }, o);
    const r = SkillZip.read(z, o);
    assert.equal(r.dir, 'GEO/geo-report');
    assert.ok(r.files['SKILL.md']);
});

test('legacy zips', () => {
    const root = fflate.zipSync({ 'SKILL.md': enc.encode('x'), '__MACOSX/a': enc.encode('j') });
    let r = SkillZip.read(root, { ...o, fallbackName: 'mine' });
    assert.equal(r.legacy, true); assert.equal(r.dir, 'mine'); assert.deepEqual(Object.keys(r.files), ['SKILL.md']);
    assert.deepEqual(r.pyodideWheels, {});
    r = SkillZip.read(fflate.zipSync({ 'top/SKILL.md': enc.encode('x'), 'top/s/a.py': enc.encode('y') }), o);
    assert.equal(r.dir, 'top'); assert.deepEqual(Object.keys(r.files).sort(), ['SKILL.md', 's/a.py']);
    assert.throws(() => SkillZip.read(fflate.zipSync({ 'a/x.md': enc.encode('x') }), o));
});

test('unsafe paths rejected', async () => {
    assert.throws(() => SkillZip.read(fflate.zipSync({ 'top/SKILL.md': enc.encode('x'), 'top/../evil': enc.encode('y') }), o));
    assert.throws(() => SkillZip.read(fflate.zipSync({ '/abs/SKILL.md': enc.encode('x') }), o));
    assert.throws(() => SkillZip.read(fflate.zipSync({ 'a\\b/SKILL.md': enc.encode('x') }), o));
    await assert.rejects(SkillZip.build({ dir: '../x', name: 'x', files: {} }, o));
    await assert.rejects(SkillZip.build({ dir: '.hid', name: 'x', files: {} }, o));
    await assert.rejects(SkillZip.build({ dir: 'a/b/c', name: 'x', files: {} }, o));
    const bad = fflate.zipSync({ 'manifest.json': enc.encode('{"format":1,"dir":"../x"}') });
    assert.throws(() => SkillZip.read(bad, o));
});
