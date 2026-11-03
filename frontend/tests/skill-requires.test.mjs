import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SR = require('../assets/js/skill-requires.js');
const enc = (s) => new TextEncoder().encode(s);
const plain = (v) => JSON.parse(JSON.stringify(v));

const CREATE_PY = `
SKILLS_ROOT = Path('/skills-root' if sys.platform == 'emscripten' else Path.home() / 'Documents' / 'synergyAI' / 'skills')
def _catalog():
    return [str(SKILLS_ROOT / 'playbook-author' / 'references' / 'mcp-catalog.md'),
            '/skill/playbook-author/references/mcp-catalog.md']
flow_mod = load_script('servicenow-flow-author', 'create.py')
pb_mod = load_script("playbook-author", 'create.py')
wf_mod = load_script('workflow-compile', 'compile.py')
fmt = 'html'   # not a skill here: only installed names count
`;
const INSTALLED = ['servicenow-automation-author', 'servicenow-flow-author', 'playbook-author', 'workflow-compile', 'docx', 'GEO/geo-report'];

test('detect: a create.py-like script names three other installed skills', () => {
    const files = { 'SKILL.md': enc('---\nname: a\n---\n'), 'scripts/create.py': enc(CREATE_PY), 'scripts/__pycache__/create.cpython-312.pyc': enc("'docx'") };
    const r = SR.direct('servicenow-automation-author', files, INSTALLED);
    assert.deepEqual(plain(r), { requires: ['playbook-author', 'servicenow-flow-author', 'workflow-compile'], missing: [] });
});

test('detect: only scripts/** count; the skill never requires itself; unknown quoted strings are ignored', () => {
    const files = {
        'SKILL.md': enc("---\nname: x\n---\nuse 'docx'"),
        'references/a.md': enc("'docx'"),
        'scripts/a.py': enc("x = 'servicenow-automation-author'; y = 'no-such-skill'; z = \"/tmp/geo-report/out\""),
    };
    assert.deepEqual(plain(SR.direct('servicenow-automation-author', files, INSTALLED)), { requires: ['GEO/geo-report'], missing: [] });
});

test('frontmatter requires-skills: list or single form; it replaces scanning; unknown → missing', () => {
    assert.deepEqual(plain(SR.declared('---\nname: x\nrequires-skills: [docx, "workflow-compile"]\n---\n')), ['docx', 'workflow-compile']);
    assert.deepEqual(plain(SR.declared('---\nrequires-skills: docx\n---\n')), ['docx']);
    assert.deepEqual(plain(SR.declared('no frontmatter')), []);
    // A declared list REPLACES scanning: 'docx' in the script is not added.
    const files = { 'SKILL.md': enc('---\nname: x\nrequires-skills: [geo-report, ghost]\n---\n'), 'scripts/a.py': enc("load('docx')") };
    assert.deepEqual(plain(SR.direct('me', files, INSTALLED)), { requires: ['GEO/geo-report'], missing: ['ghost'] });
});

test('closure: follows requirements, dependencies first, cycle-safe', async () => {
    const skills = {
        a: { 'scripts/a.py': enc("'b'") },
        b: { 'scripts/b.py': enc("'c' and 'a'") },     // cycle back to a
        c: { 'SKILL.md': enc('---\nrequires-skills: d\n---\n') },
        d: { 'scripts/d.py': enc('print(1)') },
    };
    const r = await SR.closure('a', Object.keys(skills), async (p) => skills[p]);
    assert.deepEqual(plain(r), { requires: ['d', 'c', 'b'], missing: [] });
});

test('closure: a required skill that is not installed is reported with who needs it; missingError names it', async () => {
    const skills = { a: { 'SKILL.md': enc('---\nrequires-skills: [b]\n---\n') }, b: { 'SKILL.md': enc('---\nrequires-skills: [ghost]\n---\n') } };
    const r = await SR.closure('a', ['a', 'b'], async (p) => skills[p]);
    assert.deepEqual(plain(r), { requires: ['b'], missing: [{ name: 'ghost', by: 'b' }] });
    const e = SR.missingError(r.missing);
    assert.equal(e.code, 'missing-skill');
    assert.equal(e.skill, 'ghost');
    assert.equal(e.by, 'b');
    assert.match(e.message, /b needs skill ghost, which is not installed/);
    // A required skill whose files cannot be read counts as missing too.
    const r2 = await SR.closure('a', ['a', 'b'], async (p) => (p === 'a' ? skills.a : null));
    assert.deepEqual(plain(r2.missing), [{ name: 'b', by: 'a' }]);
});

test('resolveName: exact path, else the leaf (same group first, then top level, then the first)', () => {
    const inst = ['GEO/x', 'SEO/x', 'x', 'GEO/y', 'SEO/y'];
    assert.equal(SR.resolveName('SEO/x', inst, 'GEO/me'), 'SEO/x');
    assert.equal(SR.resolveName('x', inst, 'GEO/me'), 'x');
    assert.equal(SR.resolveName('y', inst, 'SEO/me'), 'SEO/y');
    assert.equal(SR.resolveName('y', inst, 'me'), 'GEO/y');
    assert.equal(SR.resolveName('z', inst, 'me'), null);
});

test('only exact quoted literals or /leaf/ segments count: "text/html", "docx/" and prefixes do not', () => {
    const inst = ['html', 'docx', 'workflow-compile'];
    const files = { 'scripts/a.py': enc('mime = "text/html"; p = "docx/out"; q = "my-workflow-compile"; r = "/x/workflow-compile.py"') };
    assert.deepEqual(plain(SR.direct('me', files, inst)), { requires: [], missing: [] });
    const ok = { 'scripts/a.py': enc("FORMAT = {'html': 'html', \"docx\": \"docx\"}; c = '/root/workflow-compile/compile.py'") };
    assert.deepEqual(plain(SR.direct('me', ok, inst)), { requires: ['docx', 'html', 'workflow-compile'], missing: [] });
});

test('leafCollision: two required skills with one leaf (or one taking the main skill\'s place) is an error naming both', () => {
    const e = SR.leafCollision('auto', ['A/x', 'flow', 'B/x']);
    assert.equal(e.code, 'leaf-collision');
    assert.equal(e.message, "Skills A/x and B/x both need to be available as 'x'; rename one.");
    assert.equal(SR.leafCollision('x', ['GEO/x']).leaf, 'x');
    assert.equal(SR.leafCollision('G/m', ['m2', 'H/n']), null);
});
