// Export path for skills: bundleSkills with stubbed skillsFs / skillsImport / SkillZip / SkillWheels.
const assert = require('assert');
const enc = (s) => new TextEncoder().encode(s);
const WP = require('../workflow-package.js');
const calls = { gather: [], build: [] };
let store = {}, gatherError = null, requiresOf = {};
global.window = {
    WorkflowPackage: WP,
    skillsFs: { mode: async () => 'volume', readSkillFiles: async (d) => store[d] || {} },
    skillsImport: {
        filterSkillFiles: (f) => f,
        readRequires: async (d) => (requiresOf[d] || []).map((x) => ({ dir: x, name: x, files: store[x] })),
        wheelsError: (e) => (e.code === 'native-missing' ? `No wheel for ${e.library} on ${e.platform}` : `gather: ${e.message}`),
    },
    SkillZip: {
        skillDependencies: (md) => (/dependencies:/.test(md) ? ['numpy'] : []),
        build: async (o) => { calls.build.push(o); return new Uint8Array([1]); },
    },
    SkillWheels: { gather: async (d, o) => { calls.gather.push(d); calls.sessions = (calls.sessions || []).concat([o && o.session]); if (gatherError) throw gatherError; return { pyodide: { 'a.whl': enc('A') }, native: {} }; } },
};
require('../workflow-package-ui.js');
const { bundleSkills } = window.WorkflowPackageUI;
const t = (k, p) => `${k}:${JSON.stringify(p)}`;
const nodes = [{ id: '3', name: 'Summarize', node_type: 'agent', config: { bound_skill: { dir_name: 'pdf' } } }];
const run = (dirs, readable = true, files = {}) => bundleSkills({ dirs, nodes, readable, t, files });

(async () => {
    // missing skill: names the node and the skill
    await assert.rejects(run(['pdf']), (e) => /errSkillMissing/.test(e.message) && e.message.includes('"node":"Summarize"') && e.message.includes('"name":"pdf"'));
    // unreadable (no folder access): an error, not a silent skip
    store = { pdf: { 'SKILL.md': enc('---\nname: pdf\n---\n') } };
    await assert.rejects(run(['pdf'], false), (e) => /errSkillUnreadable/.test(e.message) && e.message.includes('Summarize'));
    // no dependencies: gather is not called, the zip is built
    let files = {};
    assert.deepStrictEqual(await run(['pdf'], true, files), ['pdf']);
    assert.strictEqual(calls.gather.length, 0);
    assert.ok(files['skills/pdf.skill.zip']);
    assert.strictEqual(calls.build[0].dir, 'pdf');
    // dependencies: gathered fresh, wheels go into the zip
    store = { pdf: { 'SKILL.md': enc('---\ndependencies: [numpy]\n---\n') } };
    files = {};
    await run(['pdf'], true, files);
    assert.deepStrictEqual(calls.gather, [['numpy']]);
    assert.deepStrictEqual(Object.keys(calls.build[1].pyodideWheels), ['a.whl']);
    // several skills of one package share ONE export Pyodide session; the next export starts a new one
    store = { pdf: store.pdf, doc: { 'SKILL.md': enc('---\ndependencies: [numpy]\n---\n') } };
    calls.sessions = [];
    await run(['pdf', 'doc'], true, {});
    assert.strictEqual(calls.sessions.length, 2);
    assert.ok(calls.sessions[0] && typeof calls.sessions[0] === 'object');
    assert.strictEqual(calls.sessions[0], calls.sessions[1]);
    await run(['pdf'], true, {});
    assert.notStrictEqual(calls.sessions[2], calls.sessions[0]);
    // a bound skill's required skills go into its zip, each with its own wheels
    store = { pdf: { 'SKILL.md': enc('---\nname: pdf\n---\n') }, flow: { 'SKILL.md': enc('---\ndependencies: [numpy]\n---\n') } };
    requiresOf = { pdf: ['flow'] };
    calls.build.length = 0; calls.gather.length = 0;
    await run(['pdf'], true, {});
    assert.deepStrictEqual(calls.build[0].requires.map((r) => r.dir), ['flow']);
    assert.deepStrictEqual(Object.keys(calls.build[0].requires[0].pyodideWheels), ['a.whl']);
    assert.deepStrictEqual(calls.gather, [['numpy']]);
    requiresOf = {};
    store = { pdf: store.flow };
    // 422: library and platform surface
    gatherError = Object.assign(new Error('x'), { code: 'native-missing', library: 'lxml', platform: 'win-arm64' });
    await assert.rejects(run(['pdf']), /No wheel for lxml on win-arm64/);
    console.log('workflow-package-export-skills: ok');
})().catch((e) => { console.error(e); process.exit(1); });
