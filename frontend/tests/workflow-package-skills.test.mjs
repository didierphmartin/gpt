import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.fflate = require('./fixtures/fflate.js');
const SkillZip = require('../assets/js/skill-zip.js');
const WP = require('../assets/js/workflow-package.js');
const enc = new TextEncoder();
const md = enc.encode('---\nname: x\ndependencies: [numpy]\n---\nbody');

async function newPackage() {
    const z = await SkillZip.build({ dir: 'pdf', name: 'pdf', files: { 'SKILL.md': md, 'a.py': enc.encode('1') }, pyodideWheels: { 'n.whl': enc.encode('W') } }, { fflate });
    const manifest = WP.buildManifest({ workflowName: 'w', skills: ['pdf'], deps: {} });
    const files = { 'manifest.json': enc.encode(JSON.stringify(manifest)), 'skills/pdf.skill.zip': z };
    return WP.readPackage(files);
}
const noop = { exists: async () => false, ensureDir: async () => {}, writeFile: async () => {}, writeJson: async () => {}, readJson: async () => undefined, importComponents: async (b, n) => n };
const legacyPackage = () => {
    const manifest = { format: 'synergyai-workflow-package', version: 1, dependencies: [{ kind: 'skill', name: 'old', folder: 'skills/old/' }] };
    return WP.readPackage({ 'manifest.json': enc.encode(JSON.stringify(manifest)), 'skills/old/SKILL.md': md, 'skills/old/s.py': enc.encode('2') });
};

test('manifest names the skill zip', () => {
    const m = WP.buildManifest({ workflowName: 'w', skills: ['GEO/geo'], deps: {} });
    assert.deepEqual(m.dependencies[0], { kind: 'skill', name: 'GEO/geo', zip: 'skills/GEO/geo.skill.zip' });
});

test('review row: new, then same when the installed files are identical', async () => {
    const pkg = await newPackage();
    assert.equal((await WP.reviewRows(pkg, { skills: [] }))[0].status, 'install');
    const read = SkillZip.read(pkg.files['skills/pdf.skill.zip'], { fflate });
    const hash = await WP.filesHash(read.files);
    assert.equal((await WP.reviewRows(pkg, { skills: [{ dir: 'pdf', hash }] }))[0].status, 'present');
    assert.equal((await WP.reviewRows(pkg, { skills: [{ dir: 'pdf', hash: 'other' }] }))[0].status, 'clash');
});

test('install hands the whole skill, wheels included, to importSkill (private)', async () => {
    const pkg = await newPackage();
    const rows = await WP.reviewRows(pkg, { skills: [] });
    const calls = [];
    const io = {
        ...noop, writeFile: async () => { throw new Error('no file writes'); },
        importSkill: async (read, o) => { calls.push([read, o]); return { status: 'installed' }; },
    };
    const res = await WP.installPackage(rows, pkg, {}, io, { skills: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].dir, 'pdf');
    assert.deepEqual(Object.keys(calls[0][0].pyodideWheels), ['n.whl']);
    assert.deepEqual(calls[0][1], { visibility: 'private' });
    assert.equal(res.installed[0].name, 'pdf');
});

test('identical result counts as already installed; clash fails naming the skill', async () => {
    const pkg = await newPackage();
    const rows = await WP.reviewRows(pkg, { skills: [] });
    const base = { ...noop };
    const ok = await WP.installPackage(rows, pkg, {}, { ...base, importSkill: async () => ({ status: 'identical' }) }, {});
    assert.equal(ok.installed[0].alreadyInstalled, true);
    await assert.rejects(WP.installPackage(rows, pkg, {}, { ...base, importSkill: async () => { throw Object.assign(new Error('different'), { code: 'clash' }); } }, {}), /install skill pdf/);
});

test('an old package (skills/<dir>/ folder) still reviews and installs through importSkill', async () => {
    const pkg = legacyPackage();
    const rows = await WP.reviewRows(pkg, { skills: [] });
    assert.equal(rows[0].kind, 'skill');
    assert.equal(rows[0].status, 'install');
    let got;
    await WP.installPackage(rows, pkg, {}, {
        ...noop,
        importSkill: async (r) => { got = r; return { status: 'installed' }; },
    }, { skills: [] });
    assert.equal(got.dir, 'old');
    assert.deepEqual(Object.keys(got.files).sort(), ['SKILL.md', 's.py']);
    assert.deepEqual(got.pyodideWheels, {});
});

test('a zip naming another folder is unreadable', async () => {
    const other = await SkillZip.build({ dir: 'evil', name: 'e', files: { 'SKILL.md': md } }, { fflate });
    const manifest = WP.buildManifest({ workflowName: 'w', skills: ['pdf'], deps: {} });
    const pkg = WP.readPackage({ 'manifest.json': enc.encode(JSON.stringify(manifest)), 'skills/pdf.skill.zip': other });
    const rows = await WP.reviewRows(pkg, { skills: [] });
    assert.equal(rows[0].status, 'attention');
    assert.ok(rows[0].reasons.includes('unreadable'));
});
