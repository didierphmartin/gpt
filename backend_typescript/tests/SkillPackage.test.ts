import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import './support/fakeDb';
import { LangGraphPackage } from '../src/AgentTeam/compiler/LangGraphPackage';
import { PythonEmitHelpers } from '../src/AgentTeam/compiler/PythonEmitHelpers';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { SkillStore } from '../src/Services/SkillStore';

// Port of the skill cases of backend/tests/Unit/LangGraphPackageTest.php (required skills, native wheels, the store
// resolver) and FrontmatterListReadersTest.php (the PHP readers; the emitted Python text is pinned to PHP's).

const tempDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const facts = (...dirs: string[]) => ({ agentData: [{ skills: dirs.map((dir) => ({ dir })) }] });
const paths = (files: Array<{ entry: { path: string } }>) => files.map((f) => f.entry.path).sort();
const write = (file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('frontmatter list readers: listItems, dependencies and requires-skills read every fixture case', () => {
  const t = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../frontend/tests/fixtures/frontmatter-list-cases.json'), 'utf8'));
  for (const c of [...t.cases, { name: 'form output', value: t.form.value, items: t.form.items }]) {
    assert.deepEqual(LangGraphPackage.listItems(c.value), c.items, c.name);
    assert.deepEqual(LangGraphPackage.skillDependencies(`---\nname: a\ndependencies: ${c.value}\n---\nbody\n`), c.items, c.name);
    assert.deepEqual(LangGraphPackage.declaredSkills(`---\nname: a\nrequires-skills: ${c.value}\n---\n`), c.items, c.name);
  }
});

test('required skills: the brief rulings', () => {
  const inst = ['html', 'docx', 'workflow-compile'];
  assert.deepEqual(LangGraphPackage.requiredSkills('me',
    { 'scripts/a.py': 'mime = "text/html"; p = "docx/out"; q = "my-workflow-compile"; r = "/x/workflow-compile.py"' }, inst), { requires: [], missing: [] });
  assert.deepEqual(LangGraphPackage.requiredSkills('me',
    { 'scripts/a.py': "F = {'html': 'html', \"docx\": \"docx\"}; c = '/root/workflow-compile/compile.py'" }, inst), { requires: ['docx', 'html', 'workflow-compile'], missing: [] });
  assert.deepEqual(LangGraphPackage.requiredSkills('me', { 'SKILL.md': '---\nrequires-skills: docx\n---\n', 'scripts/a.py': "'html'" }, inst),
    { requires: ['docx'], missing: [] });
});

const CREATE_PY = "SKILLS_ROOT = os.environ.get('SYNERGYAI_SKILLS_DIR')\n"
  + "flow = load_script('servicenow-flow-author', 'create.py')\npb = load_script(\"playbook-author\", 'create.py')\n"
  + "cat = '/skill/playbook-author/references/mcp-catalog.md'\nwf = load_script('workflow-compile', 'compile.py')\nfmt = 'html'\n";

test('required skills: detection, declared lists, requires-skills: [] declares none, resolveSkillName', () => {
  const installed = ['servicenow-automation-author', 'servicenow-flow-author', 'playbook-author', 'workflow-compile', 'GEO/geo-report'];
  const files = { 'SKILL.md': "---\nname: a\n---\n'docx'", 'scripts/create.py': CREATE_PY, 'scripts/__pycache__/x.pyc': "'GEO/geo-report'", 'references/r.md': "'geo-report'" };
  assert.deepEqual(LangGraphPackage.requiredSkills('servicenow-automation-author', files, installed),
    { requires: ['playbook-author', 'servicenow-flow-author', 'workflow-compile'], missing: [] });
  const decl = { 'SKILL.md': '---\nrequires-skills: [geo-report, ghost]\n---\n', 'scripts/a.py': "x = 'servicenow-automation-author'" };
  assert.deepEqual(LangGraphPackage.requiredSkills('servicenow-automation-author', decl, installed), { requires: ['GEO/geo-report'], missing: ['ghost'] });
  assert.deepEqual(LangGraphPackage.declaredSkills('---\nrequires-skills: docx\n---\n'), ['docx']);
  const none = { 'SKILL.md': '---\nrequires-skills: []\n---\n', 'scripts/create.py': CREATE_PY };
  assert.deepEqual(LangGraphPackage.requiredSkills('servicenow-automation-author', none, installed), { requires: [], missing: [] });
  assert.equal(LangGraphPackage.declaresSkills('---\nrequires-skills: []\n---\n'), true);
  assert.equal(LangGraphPackage.declaresSkills('---\nname: a\n---\n'), false);
  assert.equal(LangGraphPackage.resolveSkillName('x', ['SEO/x', 'GEO/x'], 'GEO/me'), 'GEO/x');
});

test('a package carries the required skills (closure, cycle-safe), their native wheels, never the browser wheels', () => {
  const root = tempDir('lgpkg_req_');
  for (const [d, py] of Object.entries({ auto: CREATE_PY, 'servicenow-flow-author': "x = 'playbook-author'\n", 'playbook-author': "y = 'auto'\n",
    'workflow-compile': 'print(1)\n', unused: 'print(2)\n' })) {
    write(`${root}/${d}/SKILL.md`, `---\nname: ${d}\n---\n`);
    write(`${root}/${d}/scripts/create.py`, py);
  }
  write(`${root}/workflow-compile/.wheels/native/w-1-py3-none-any.whl`, 'PK');
  write(`${root}/workflow-compile/.wheels/pyodide/p-1-py3-none-any.whl`, 'PK');
  const got = paths(LangGraphPackage.skillFiles(facts('auto'), root));
  for (const p of ['skills/auto/scripts/create.py', 'skills/servicenow-flow-author/scripts/create.py', 'skills/playbook-author/scripts/create.py',
    'skills/workflow-compile/scripts/create.py', 'skills/workflow-compile/.wheels/native/w-1-py3-none-any.whl']) {
    assert.ok(got.includes(p), p);
  }
  assert.ok(!got.includes('skills/unused/SKILL.md'));
  assert.ok(!got.some((p) => p.includes('.wheels/pyodide')));
  // The store resolver: the same skills, found by probing the names the scripts use.
  assert.deepEqual(paths(LangGraphPackage.skillFiles(facts('auto'), (d) => (fs.existsSync(`${root}/${d}`) ? `${root}/${d}` : null))), got);
  write(`${root}/auto/SKILL.md`, '---\nname: auto\nrequires-skills: [ghost]\n---\n');
  assert.throws(() => LangGraphPackage.skillFiles(facts('auto'), root), /Skill "auto" needs skill "ghost", which is not available on this server/);
});

test('a grouped required skill is copied at its leaf (folder root and store resolver); two with one leaf are an error', () => {
  const root = tempDir('lgpkg_grp_');
  write(`${root}/auto/SKILL.md`, '---\nname: auto\n---\n');
  write(`${root}/auto/scripts/a.py`, "load_script('geo-report', 'make.py')\n");
  write(`${root}/GEO/geo-report/SKILL.md`, '---\nname: geo-report\n---\n');
  write(`${root}/GEO/geo-report/scripts/make.py`, 'print(1)\n');
  const want = ['skills/auto/SKILL.md', 'skills/auto/scripts/a.py', 'skills/geo-report/SKILL.md', 'skills/geo-report/scripts/make.py'];
  assert.deepEqual(paths(LangGraphPackage.skillFiles(facts('auto'), root)), want);
  const store = tempDir('lgpkg_store_');
  const s = new SkillStore(store, 'individual');
  const B = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  s.import(3, 'auto', B({ 'SKILL.md': '---\nname: auto\n---\n', 'scripts/a.py': "load_script('geo-report', 'make.py')\n" }));
  s.import(3, 'GEO/geo-report', B({ 'SKILL.md': '---\nname: geo-report\n---\n', 'scripts/make.py': 'print(1)\n' }));
  assert.deepEqual(paths(LangGraphPackage.skillFiles(facts('auto'), s.compileResolver(3, false))), want);

  const two = tempDir('lgpkg_two_');
  for (const [d, md] of Object.entries({ auto: '---\nname: auto\nrequires-skills: [A/x, B/x]\n---\n', 'A/x': '---\nname: x\n---\n', 'B/x': '---\nname: x\n---\n' })) {
    write(`${two}/${d}/SKILL.md`, md);
  }
  assert.throws(() => LangGraphPackage.skillFiles(facts('auto'), two), /Skills "A\/x" and "B\/x" both need to be available as 'x'; rename one\./);
});

test('the resolver picks each skill folder; requirements leave out the libraries of a skill with wheels', () => {
  const root = tempDir('lgpkg_whl_');
  write(`${root}/pdf-report/SKILL.md`, '---\nname: pdf-report\ndependencies: [fpdf2]\n---\n');
  write(`${root}/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl`, Buffer.from('PK\x03\x04\xffnative', 'binary'));
  write(`${root}/plain-skill/SKILL.md`, '---\nname: plain-skill\ndependencies: [zz-plain-dep]\n---\n');
  const asked: string[] = [];
  const files = LangGraphPackage.skillFiles(facts('pdf-report'), (d) => { asked.push(d); return `${root}/${d}`; });
  assert.deepEqual(asked, ['pdf-report']);
  const whl = files.find((f) => f.rel.endsWith('.whl'))!;
  assert.equal(whl.entry.encoding, 'base64');
  assert.equal(Buffer.from(whl.entry.code, 'base64').toString('binary'), 'PK\x03\x04\xffnative');
  assert.ok(!LangGraphPackage.requirementNames({}, 'modular', files).includes('fpdf2'));
  assert.ok(LangGraphPackage.requirementNames({}, 'modular', LangGraphPackage.skillFiles(facts('plain-skill'), root)).includes('zz-plain-dep'));
  assert.throws(() => LangGraphPackage.skillFiles(facts('pdf-report'), () => null), /Skill folder "pdf-report" is not available on this server, so it can't be packaged\./);
});

test('the emitted skill runtime installs from the skill wheels and passes an absolute SYNERGYAI_SKILLS_DIR', () => {
  const runtime = LangGraphRuntime.skillRuntimeBlock(true);
  assert.ok(runtime.includes('"--no-index", "--find-links"') && runtime.includes('os.path.join(skill_dir, ".wheels", "native")'));
  assert.ok(runtime.includes('SYNERGYAI_SKILLS_DIR=os.path.abspath(self.skills_dir)'));
  assert.ok(PythonEmitHelpers.skillFsSyncBlock().includes('SYNERGYAI_SKILLS_DIR=os.path.abspath(SKILLS_DIR)'));
  assert.ok(PythonEmitHelpers.skillDepsBlock().includes('def _importable(dep: str) -> bool:'));
});
