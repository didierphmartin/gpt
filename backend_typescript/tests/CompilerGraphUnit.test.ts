/**
 * The pure parts of backend/tests/Unit/{WorkflowGraphAnalyzerTest, WorkflowGraphAnalyzerAnalyzeTest, SwarmRewriterTest,
 * LangGraphPackageTest, LangGraphArchitectureDocTest}.php, ported to the compiler's TypeScript modules (no PHP needed).
 * The cases that drive LangGraphGenerator.generate() run against the TypeScript generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installFakeDb } from './support/fakeDb';
import { installSqliteDb } from './support/sqliteDb';
import { fixtureGenerator } from './support/compilerFixture';
import { LangGraphGenerator } from '../src/AgentTeam/LangGraphGenerator';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { StartDocumentStore } from '../src/AgentTeam/compiler/StartDocumentStore';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { GraphAnalyzer } from '../src/AgentTeam/compiler/GraphAnalyzer';
import { SwarmRewriter } from '../src/AgentTeam/compiler/SwarmRewriter';
import { LangGraphPackage } from '../src/AgentTeam/compiler/LangGraphPackage';
import { WorkflowView } from '../src/AgentTeam/compiler/WorkflowView';
import { StartTriggerFacts } from '../src/AgentTeam/StartTriggerFacts';
import { F, entries, jsonDecodeAssoc, jsonU, keysOf, oarr, values, var_export_scalar } from '../src/AgentTeam/compiler/php';

// ---------------------------------------------------------------- WorkflowGraphAnalyzerTest

/** A diamond: start(1) -> a(2), start(1) -> b(3), a(2) -> out(4), b(3) -> out(4) */
function diamond(): any {
  return {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'You are A', provider: 'claude', model: 'claude-sonnet-4-6', selectedTools: [] } },
      { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'B', systemPrompt: 'You are B', provider: 'gemini', model: 'gemini-2.5-pro', selectedTools: [] } },
      { id: '4', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '1', to: '3' }, { from: '2', to: '4' }, { from: '3', to: '4' }],
  };
}

test('analyzeGraph: layers group independent nodes', () => {
  const a = GraphAnalyzer.analyzeGraph(diamond());
  assert.deepEqual(a.layers[0], ['1']);
  assert.deepEqual([...a.layers[1]].sort(), ['2', '3']);
  assert.deepEqual(a.layers[2], ['4']);
});

test('analyzeGraph: parents and children', () => {
  const a = GraphAnalyzer.analyzeGraph(diamond());
  assert.deepEqual([...a.parents['4']].sort(), ['2', '3']);
  assert.deepEqual([...a.children['1']].sort(), ['2', '3']);
});

test('analyzeGraph: start node and order guarantees', () => {
  const a = GraphAnalyzer.analyzeGraph(diamond());
  assert.equal(a.startNodeId, '1');
  assert.ok(a.order.includes('1'));
  assert.ok(a.order.every((x: any) => typeof x === 'string'));
});

test('analyzeGraph: a cycle throws', () => {
  assert.throws(() => GraphAnalyzer.analyzeGraph({
    nodes: [{ id: '1', type: 'agent' }, { id: '2', type: 'agent' }],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '1' }],
  }), /cycle or disconnected node/);
});

test('analyzeGraph: numeric ids keep insertion order in byId; order is topological', () => {
  const a = GraphAnalyzer.analyzeGraph({
    nodes: [{ id: '10', node_type: 'output' }, { id: '2', node_type: 'agent' }, { id: 7, node_type: 'start' }],
    edges: [{ from: '7', to: '2' }, { from: '2', to: '10' }, { from: '2', to: '10' }],
  });
  assert.deepEqual(keysOf(a.byId), ['10', '2', '7']);
  assert.deepEqual(a.order, ['7', '2', '10']);
  assert.equal(a.edges.length, 2, 'a doubled edge is one connection');
  assert.equal(jsonU(a.children), '{"10":[],"2":["10"],"7":["2"]}');
  assert.equal(a.startNodeId, '7');
});

test('skillsFromConfig: bound skill dir, legacy inline content, none', () => {
  const cfg = { type: 'agent', agent_name: 'A', bound_skill: { id: null, source: 'local', dir_name: 'GEO/geo-report', name: 'R' } };
  assert.deepEqual(GraphAnalyzer.skillsFromConfig(cfg), [{ dir: 'GEO/geo-report' }]);
  assert.deepEqual(GraphAnalyzer.skillsFromConfig({ type: 'agent', skill_content: 'legacy instructions' }), [{ inline: 'legacy instructions' }]);
  assert.deepEqual(GraphAnalyzer.skillsFromConfig({ type: 'agent' }), []);
});

test('reachableGraph drops nodes Start does not reach (and their edges), keeps other keys', () => {
  const graph = {
    nodes: [{ id: 1, node_type: 'start' }, { id: 2, node_type: 'agent' }, { id: 3, node_type: 'output' }, { id: 9, node_type: 'agent' }],
    edges: [{ from_node_id: 1, to_node_id: 2 }, { from_node_id: 2, to_node_id: 3 }, { from_node_id: 9, to_node_id: 3 }],
    workflow_id: 64,
  };
  const out = GraphAnalyzer.reachableGraph(graph);
  assert.deepEqual(out.nodes.map((n: any) => n.id), [1, 2, 3]);
  assert.equal(out.edges.length, 2, 'the stray arrow goes with its node');
  assert.equal(out.workflow_id, 64);
  assert.equal(graph.nodes.length, 4, 'the input is not changed');
  assert.deepEqual(GraphAnalyzer.analyzeGraph(out).order, ['1', '2', '3']);
});

test('reachableGraph without a Start is unchanged', () => {
  const graph = { nodes: [{ id: 1, node_type: 'agent' }], edges: [] };
  assert.equal(GraphAnalyzer.reachableGraph(graph), graph);
});

test('typeOf: node_type, then type, then config.type; an empty value falls through', () => {
  assert.equal(GraphAnalyzer.typeOf({ node_type: '', config: { type: 'agent-template' } }), 'agent-template');
  assert.equal(GraphAnalyzer.typeOf({ type: 'start', config: { type: 'x' } }), 'start');
  assert.equal(GraphAnalyzer.typeOf({}), 'agent');
});

test('dispatchMenus: menu in edge order, only agent/playbook/code children; routedBy', () => {
  const analyzed = GraphAnalyzer.analyzeGraph({
    nodes: [
      { id: '1', node_type: 'start' },
      { id: '2', node_type: '', config: { type: 'agent-template', agent_type: 'dispatcher', agent_name: 'D' } },
      { id: '5', node_type: 'playbook', config: { name: 'PB' } },
      { id: '3', node_type: 'agent', config: { label: 'Labelled' } },
      { id: '4', node_type: 'output' },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '5' }, { from: '2', to: '3' }, { from: '2', to: '4' }],
  });
  const m = GraphAnalyzer.dispatchMenus(analyzed);
  assert.equal(jsonU(m), '{"menus":{"2":[{"id":"5","name":"PB"},{"id":"3","name":"Labelled"}]},"routedBy":{"5":"2","3":"2"}}');
});

test('docNodes: one descriptor per node, playbook title and extra overrides', () => {
  const analyzed = GraphAnalyzer.analyzeGraph({
    nodes: [
      { id: '1', node_type: 'start', config: { prompt: 'Hi' } },
      { id: '2', node_type: 'playbook', config: { name: 'PB', playbook: 'x\n**Title: Leave request**\n', writes_enabled: 1 } },
      { id: '3', node_type: 'output' },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  });
  const d = GraphAnalyzer.docNodesFromAnalyzed(analyzed, oarr([['2', { playbook: { bound: ['a'] } }]]));
  assert.equal(d.length, 3);
  assert.equal(d[0].prompt, 'Hi');
  assert.equal(d[0].name, 'Start');
  assert.equal(jsonU(d[1].playbook), '{"bound":["a"],"title":"Leave request","writes":true,"unbound":null}');
  assert.equal(d[1].supported, false);
  assert.deepEqual(d[1].parents, ['Start (1)']);
  assert.deepEqual(d[1].children, ['Output (3)']);
});

// ---------------------------------------------------------------- WorkflowGraphAnalyzerAnalyzeTest

function analyzer(graph: any, workflow: any): GraphAnalyzer {
  installFakeDb(() => []);   // no MCP tools, no provider defaults
  return new GraphAnalyzer(
    { findById: async () => workflow },
    { getGraph: async () => graph },
    { findById: async () => null },
  );
}

test('analyze uses the workflow object API and returns its name', async () => {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', selectedTools: [] } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  const r = await analyzer(graph, WorkflowView.fromRecord({ id: 31, name: 'GEO Parallel Audit' })).analyze(31, '3');
  assert.equal(r.workflow.name, 'GEO Parallel Audit');
  assert.equal(r.workflow.id, 31);
  assert.ok(keysOf(r.agents).includes('2'));
  assert.equal(jsonU(r.usedCatalog), '[]');
  assert.equal(r.startPrompt, 'GO');
});

test('analyze falls back to a generated name when blank (the TS Workflow record too)', async () => {
  const graph = { nodes: [{ id: '1', type: 'start', config: { type: 'start' } }], edges: [] };
  assert.equal((await analyzer(graph, WorkflowView.fromRecord({ id: 99, name: '' })).analyze(99, '1')).workflow.name, 'workflow_99');
  const rec = { id: 99, name: '', outputStorageEnabled: 1, outputFolder: 'out' };
  const r = await analyzer(graph, rec).analyze(99, null);
  assert.equal(r.workflow.name, 'workflow_99');
  assert.equal(r.outputStorageEnabled, true);
  assert.equal(r.outputFolder, 'out');
});

test('analyze: a missing workflow throws', async () => {
  await assert.rejects(analyzer({ nodes: [], edges: [] }, null).analyze(1), /Workflow not found/);
});

// ---------------------------------------------------------------- SwarmRewriterTest

const CASES = jsonDecodeAssoc(fs.readFileSync(path.resolve(__dirname, '../../backend/tests/fixtures/swarm/rewrite-cases.json'), 'utf8'));

for (const c of values(CASES.cases)) {
  test(`SwarmRewriter contract: ${c.name}`, () => {
    const got = SwarmRewriter.rewrite(c.graph);
    const expect = c.expect;
    if (!expect.ok) {
      assert.equal(got.ok, false, 'expected a refusal');
      assert.equal(got.error, expect.error);
      assert.deepEqual(values(got.nodes), values(expect.nodes), 'the refusal must name the offending nodes');
      return;
    }
    assert.equal(got.ok, true, 'expected acceptance, got: ' + (got.error ?? '?'));
    assert.deepEqual(keysOf(got.agents), values(expect.agents), 'agents, by node id');
    assert.equal(got.entry, expect.entry);
    const pairs: string[][] = [];
    for (const [id, a] of entries(got.agents)) for (const to of a.handoffs) pairs.push([id, String(to)]);
    const key = (p: string[]) => p.join('\u0000');
    assert.deepEqual(pairs.map(key).sort(), values(expect.handoffs).map((p: any) => key(values(p))).sort());
    const all = values(got.agents).map((a: any) => a.instructions).join('\n');
    for (const needle of values(expect.guide_contains ?? [])) assert.ok(all.includes(needle), `guide should mention: ${needle}`);
    for (const [id, tools] of entries(expect.tools_by_agent ?? [])) assert.equal(jsonU(got.agents[id].tools), jsonU(tools), `tools of agent ${id}`);
    for (const [id, skills] of entries(expect.skills_by_agent ?? [])) assert.equal(jsonU(got.agents[id].skills), jsonU(skills), `skills of agent ${id}`);
  });
}

test('SwarmRewriter.handoffGuide lists each colleague with its own role summary', () => {
  const guide = SwarmRewriter.handoffGuide([{ name: 'Human resources', role: 'leave and payroll' }, { name: 'IT claims', role: 'passwords and access' }]);
  for (const s of ['Human resources', 'leave and payroll', 'IT claims', 'passwords and access', 'Do not hand back']) assert.ok(guide.includes(s), s);
});

test('Workflow orchestration defaults to workflow; swarm kept; anything else falls back', () => {
  assert.equal(WorkflowView.fromRecord({ id: 1, name: 'x' }).getOrchestration(), 'workflow');
  assert.equal(WorkflowView.fromRecord({ id: 2, name: 'y', orchestration: 'swarm' }).getOrchestration(), 'swarm');
  assert.equal(WorkflowView.fromRecord({ id: 3, name: 'z', orchestration: 'nonsense' }).getOrchestration(), 'workflow');
});

// ---------------------------------------------------------------- LangGraphPackageTest (pure parts)

const PNG = Buffer.from('\x89PNG\r\n\x1a\n\x00\xff', 'latin1');
const tmpRoots: string[] = [];

/** A skills root holding pdf-report (SKILL.md with a dependency, a script, a binary logo, junk that is skipped). */
function skillsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lgpkg_skills_'));
  tmpRoots.push(root);
  fs.mkdirSync(`${root}/pdf-report/__pycache__`, { recursive: true });
  fs.writeFileSync(`${root}/pdf-report/SKILL.md`, '---\nname: pdf-report\ndependencies: [pypdf]\n---\nRender a PDF.\n');
  fs.writeFileSync(`${root}/pdf-report/run.py`, "print('pdf')\n");
  fs.writeFileSync(`${root}/pdf-report/logo.png`, PNG);
  fs.writeFileSync(`${root}/pdf-report/__pycache__/run.cpython-312.pyc`, '\x00junk');
  fs.writeFileSync(`${root}/pdf-report/.DS_Store`, '\x00junk');
  fs.writeFileSync(`${root}/pdf-report/.env`, 'OPENAI_API_KEY=sk-skill-secret\n');
  fs.writeFileSync(`${root}/pdf-report/.env.local`, 'OPENAI_API_KEY=sk-skill-secret\n');
  return root;
}

test.after(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

/** The facts of the PHP test's workflow 44 "Email prototype" (Start option on Outlook -> Reporter (pdf-report) -> Output). */
function facts(skillDir = 'pdf-report', extra: any = {}): any {
  return {
    workflow: WorkflowView.fromRecord({ id: 44, name: 'Email prototype' }),
    wfName: 'Email prototype',
    safeName: 'email_prototype',
    startMode: 'watch',
    agentData: oarr([['19', { display: 'Reporter', provider: 'claude', skills: [{ dir: skillDir }], dispatch: [] }]]),
    playbookData: [],
    codeData: oarr([['1000000017', { display: 'Outlook: get new email', source: 'x' }]]),
    serverSlugs: oarr([['http://127.0.0.1:8770/mcp', 'outlook']]),
    startDocuments: [],
    ...extra,
  };
}

function files(f: any, root: string, docs: any = null): Record<string, any> {
  const out: Record<string, any> = {};
  for (const e of LangGraphPackage.files(f, root, docs)) out[e.path] = e;
  return out;
}

test('LangGraphPackage.files: harness, requirements, env, readme, skill files (binary as base64, junk skipped)', () => {
  const fl = files(facts(), skillsRoot());
  assert.equal(fl['code_harness.py'].code, fs.readFileSync(path.resolve(__dirname, '../../frontend/assets/py/code_node_harness.py'), 'utf8'));
  assert.ok(fl['requirements.txt'].code.includes('pypdf\n'));
  assert.ok(fl['requirements.txt'].code.includes('fastapi\n'));
  assert.ok(fl['.env.example'].code.includes('MCP_URL_OUTLOOK=http://127.0.0.1:8770/mcp'));
  assert.ok(fl['.env.example'].code.includes('MCP_HEADERS_OUTLOOK='));
  assert.ok(fl['.env.example'].code.includes('ANTHROPIC_API_KEY'));
  assert.ok(fl['README.md'].code.includes('launchd'));
  assert.equal(fl['skills/pdf-report/logo.png'].encoding, 'base64');
  assert.ok(Buffer.from(fl['skills/pdf-report/logo.png'].code, 'base64').equals(PNG));
  assert.equal(fl['skills/pdf-report/run.py'].encoding, undefined);
  assert.equal(fl['skills/pdf-report/run.py'].code, "print('pdf')\n");
  assert.ok('skills/pdf-report/SKILL.md' in fl);
  for (const p of Object.keys(fl)) {
    assert.ok(!p.includes('__pycache__') && !p.includes('.DS_Store'), p);
    assert.ok(!p.endsWith('/.env') && !p.endsWith('/.env.local'), p);
  }
  for (const [p, e] of Object.entries(fl)) assert.ok(!String(e.code).includes('sk-skill-secret'), p);
});

test('LangGraphPackage: requirements are sorted and unique', () => {
  const lines = files(facts(), skillsRoot())['requirements.txt'].code.replace(/\n+$/, '').split('\n');
  assert.deepEqual(lines, [...lines].sort());
  assert.deepEqual(lines, [...new Set(lines)]);
  for (const pkg of ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx', 'pydantic', 'python-dotenv', 'fastapi', 'uvicorn', 'pypdf']) {
    assert.ok(lines.includes(pkg), pkg);
  }
});

test('LangGraphPackage: .env.example and README', () => {
  const fl = files(facts(), skillsRoot());
  const env = fl['.env.example'].code;
  assert.ok(env.includes('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}'));
  for (const n of ['# MODEL_NAME=', '# SYNERGYAI_OUTPUT_ROOT=./outputs', '# RUNS_DIR=./runs', '# MCP_HEADERS_OUTLOOK=', '# ANTHROPIC_API_KEY=']) assert.ok(env.includes(n), n);
  for (const line of env.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    assert.match(line, /^[A-Z0-9_]+=\S/, `.env.example sets an empty value: ${line}`);
  }
  const readme = fl['README.md'].code;
  for (const n of ['python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt', 'cp .env.example .env',
    '<string>ai.synergy.email-prototype</string>', 'Restart=always', 'python api.py', 'outputs/', 'runs/', 'code/']) assert.ok(readme.includes(n), n);
  assert.match(readme, /\| `python workflow\.py --watch[^\n]*\(default\)/);
  assert.equal(readme.split('(default)').length - 1, 1);
  assert.equal(readme.split('<string>/path/to/email_prototype_modular/service.log</string>').length - 1, 2);
  assert.ok(!readme.includes('runs/service.log'));
});

test('LangGraphPackage.codeFile names', () => {
  assert.deepEqual(LangGraphPackage.codeFile('1000000017', { display: 'Outlook: get new email', source: 'x' }, true),
    { path: 'code/start_outlook_get_new_email.py', code: 'x' });
  assert.deepEqual(LangGraphPackage.codeFile('4', { display: 'Check mail', source: 'y' }, false), { path: 'code/4_check_mail.py', code: 'y' });
});

test('LangGraphPackage.startDocuments: only what the store reads is copied; names stay unique; fullPath/localUri dropped', () => {
  const store = {
    read(doc: any): Buffer | null {
      if (doc.path === 'workflow_docs/44/doc_1_brief.txt' && doc.storage !== 'local') return Buffer.from('the brief\n');
      if (doc.path === 'workflow_docs/44/doc_2_scan.pdf') return Buffer.from('%PDF-1.4\n\x00\xff\xfe', 'latin1');
      if (doc.path === 'other/doc_1_brief.txt') return Buffer.from('second\n');
      return null;
    },
  };
  const docs = [
    { name: 'brief.txt', path: 'workflow_docs/44/doc_1_brief.txt', fullPath: 'synergyaichatroot/user_3/workflow_docs/44/doc_1_brief.txt', localUri: 'x' },
    { name: 'scan.pdf', path: 'workflow_docs/44/doc_2_scan.pdf' },
    { name: 'server.env', path: '/etc/server.env' },
    { name: 'mine.txt', path: 'workflow_docs/44/doc_1_brief.txt', storage: 'local' },
    { name: 'again.txt', path: 'other/doc_1_brief.txt' },
    'not a record',
  ];
  const r = LangGraphPackage.startDocuments(docs, store);
  assert.deepEqual(r.files.map((f) => f.path), ['start_documents/doc_1_brief.txt', 'start_documents/doc_2_scan.pdf', 'start_documents/4_doc_1_brief.txt']);
  assert.equal(r.files[0].code, 'the brief\n');
  assert.equal(r.files[1].encoding, 'base64');
  assert.equal(jsonU(r.docs[0]), '{"name":"brief.txt","path":"start_documents/doc_1_brief.txt"}');
  assert.equal(r.docs[2], docs[2]);
  assert.equal(r.docs[5], 'not a record');
  assert.equal(jsonU(docs[0]), '{"name":"brief.txt","path":"workflow_docs/44/doc_1_brief.txt","fullPath":"synergyaichatroot/user_3/workflow_docs/44/doc_1_brief.txt","localUri":"x"}', 'the input is not changed');
  assert.deepEqual(LangGraphPackage.startDocuments(docs).files, [], 'without a store no document is copied');
});

test('LangGraphPackage: a missing skill folder is an error', () => {
  assert.throws(() => files(facts('nope'), skillsRoot()), { message: 'Skill folder "nope" is not available on this server, so it can\'t be packaged.' });
});

test('LangGraphPackage: unsafe skill dir names are refused', () => {
  const root = skillsRoot();
  for (const bad of ['.', '..', '../pdf-report', 'pdf-report/..', 'GEO/../x', './x', 'GEO//x', 'a\\b', '/tmp']) {
    assert.throws(() => files(facts(bad), root), { message: `Skill folder "${bad}" is not available on this server, so it can't be packaged.` }, bad);
  }
});

test('LangGraphPackage: dot-directories are neither named nor copied; other dot-files are', () => {
  const root = skillsRoot();
  for (const bad of ['.git', '.superpowers', 'GEO/.hidden', '.x/pdf-report']) {
    fs.mkdirSync(`${root}/${bad}`, { recursive: true });
    fs.writeFileSync(`${root}/${bad}/SKILL.md`, '---\nname: x\n---\n');
    assert.throws(() => files(facts(bad), root), { message: `Skill folder "${bad}" is not available on this server, so it can't be packaged.` });
  }
  fs.mkdirSync(`${root}/pdf-report/.git`, { recursive: true });
  fs.mkdirSync(`${root}/pdf-report/.pytest_cache/v`, { recursive: true });
  fs.mkdirSync(`${root}/pdf-report/assets/.cache`, { recursive: true });
  fs.writeFileSync(`${root}/pdf-report/.git/config`, '[remote]\n');
  fs.writeFileSync(`${root}/pdf-report/.pytest_cache/v/x`, '1');
  fs.writeFileSync(`${root}/pdf-report/assets/.cache/y`, '2');
  fs.writeFileSync(`${root}/pdf-report/assets/style.css`, 'p{}');
  fs.writeFileSync(`${root}/pdf-report/.gitignore`, '*.pyc\n');
  const skill = Object.keys(files(facts(), root)).filter((p) => p.startsWith('skills/'));
  assert.deepEqual(skill, ['skills/pdf-report/.gitignore', 'skills/pdf-report/SKILL.md', 'skills/pdf-report/assets/style.css',
    'skills/pdf-report/logo.png', 'skills/pdf-report/run.py']);
});

test('LangGraphPackage: a grouped skill is packaged under its group', () => {
  const root = skillsRoot();
  fs.mkdirSync(`${root}/GEO/geo-report/scripts`, { recursive: true });
  fs.writeFileSync(`${root}/GEO/geo-report/SKILL.md`, '---\nname: geo-report\ndependencies: [beautifulsoup4]\n---\nReport.\n');
  fs.writeFileSync(`${root}/GEO/geo-report/scripts/make.py`, "print('geo')\n");
  const fl = files(facts('GEO/geo-report'), root);
  assert.equal(fl['skills/GEO/geo-report/scripts/make.py'].code, "print('geo')\n");
  assert.ok('skills/GEO/geo-report/SKILL.md' in fl);
  assert.ok(fl['requirements.txt'].code.includes('beautifulsoup4\n'));
});

test('LangGraphPackage.skillDependencies parses the frontmatter only', () => {
  assert.deepEqual(LangGraphPackage.skillDependencies('---\nname: x\ndependencies: [a, "b", \'c\']\n---\n'), ['a', 'b', 'c']);
  assert.deepEqual(LangGraphPackage.skillDependencies('---\nname: x\n---\ndependencies: late'), []);
  assert.deepEqual(LangGraphPackage.skillDependencies('no frontmatter'), []);
});

test('LangGraphPackage.defaultSkillsRoot is under HOME', () => {
  assert.equal(LangGraphPackage.defaultSkillsRoot(), (process.env.HOME ?? '') + '/Documents/synergyAI/skills');
});

// ---------------------------------------------------------------- LangGraphPackageTest (through LangGraphGenerator.generate)

const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
  + "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";
/** A header value saved on the Outlook MCP server row: it must reach no generated file. */
const HEADER_SECRET = 'hdr-secret-5521';

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** The PHP test's PDO: the Outlook server (with a header value), its two tools, claude's default model. */
function pkgDb(): void {
  const d = installSqliteDb();
  for (const s of [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
    `INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, '{"Authorization": "Bearer ${HEADER_SECRET}"}')`,
    "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)",
  ]) d.exec(s);
}

function pkgGenerator(graph: any, root: string, storage = false, docs: any = null, outputFolder: string | null = null): LangGraphGenerator {
  pkgDb();
  const wf = WorkflowView.fromRecord({ id: 44, name: 'Email prototype', output_storage_enabled: storage || outputFolder !== null, output_folder: outputFolder });
  return new LangGraphGenerator({ findById: async () => wf }, { getGraph: async () => graph }, { findById: async () => null }, root, docs);
}

/** Start (17) on a Start option -> Reporter (19, skill pdf-report) -> Output (18). */
async function pkgGraph(skillDir = 'pdf-report', documents: any[] = []): Promise<any> {
  const raw = {
    nodes: [
      { id: '17', node_type: 'start', config: { type: 'start', start_option: 5, documents } },
      { id: '19', node_type: '', config: { type: 'agent-template', agent_name: 'Reporter', agent_type: 'standard', instructions: 'Summarize the mail.',
        agent_provider: 'claude', model: 'claude-sonnet-4-5', tools: [], settings: { temperature: F(0.7), max_tokens: 4096 }, bound_skill: { dir_name: skillDir } } },
      { id: '18', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from_node_id: '17', to_node_id: '19', from_port: 'output_1' },
      { from_node_id: '19', to_node_id: '18', from_port: 'output_1' },
    ],
  };
  return StartOptionGraph.expand(raw, () => ({
    name: 'Outlook: get new email', code: POLL, exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 30,
    start_trigger: { label: 'Outlook: get new email', work_exit: 'new_mail', watch: { server: 'Outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } } },
  }));
}

/** path => entry of one generation (a single file: its name => {code}). */
function byPath(result: any): Record<string, any> {
  if (result.files === undefined) return { [result.filename]: { code: result.code } };
  const out: Record<string, any> = {};
  for (const f of values(result.files)) out[f.path] = f;
  return out;
}

async function pkgFiles(skillDir = 'pdf-report'): Promise<Record<string, any>> {
  return byPath(await pkgGenerator(await pkgGraph(skillDir), skillsRoot()).generate(44, '3', { modular: true }));
}

/** The self-containment needles over every file of one generation (LangGraphPackageTest::assertSelfContained). */
function assertSelfContained(files: Record<string, any>, label: string): void {
  for (const [p, f] of Object.entries(files)) {
    if ((f.encoding ?? '') === 'base64') continue;
    const code = String(f.code);
    for (const needle of [HEADER_SECRET, 'sekret-conn-key', '/api/v1/', 'netfo587', 'localhost/gpt']) {
      assert.ok(!code.includes(needle), `${label} ${p}: ${needle}`);
    }
    if (p === '.env.example' || p === 'README.md') {
      for (const line of code.split('\n')) {
        if (!line.trimStart().startsWith('#') || p === 'README.md') assert.ok(!line.includes('synergyAI/'), `${label} ${p}: ${line}`);
      }
    } else if (label.endsWith('single')) {
      for (const line of code.split('\n')) {
        if (!line.includes('# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills)')) {
          assert.ok(!line.includes('synergyAI/'), `${label} ${p}: ${line}`);
        }
      }
    } else if (p !== 'ARCHITECTURE.md' && !label.endsWith('a2a')) {
      assert.ok(!code.includes('synergyAI/'), `${label} ${p}`);
    }
  }
}

test('LangGraphPackageTest::testPackageFiles (generated package)', async () => {
  const files = await pkgFiles();
  assert.equal(files['code/start_outlook_get_new_email.py'].code, POLL);
  assert.equal(files['code_harness.py'].code, fs.readFileSync(path.resolve(__dirname, '../../frontend/assets/py/code_node_harness.py'), 'utf8'));
  assert.ok(files['requirements.txt'].code.includes('pypdf\n'));
  assert.ok(files['.env.example'].code.includes('MCP_URL_OUTLOOK=http://127.0.0.1:8770/mcp'));
  assert.ok(files['.env.example'].code.includes('# MCP_HEADERS_OUTLOOK='));
  assert.equal(files['skills/pdf-report/logo.png'].encoding, 'base64');
  assert.match(files['README.md'].code, /\| `python workflow\.py --watch[^\n]*\(default\)/);
  assert.equal(files['README.md'].code.split('(default)').length - 1, 1);
});

test('LangGraphPackageTest::testCodeModuleReadsItsFile', async () => {
  const files = await pkgFiles();
  const mod = files['agents/outlook_get_new_email.py']?.code;
  assert.ok(mod !== undefined, 'modularLayout\'s name rule');
  assert.ok(mod.includes('"source_file": "code/start_outlook_get_new_email.py"'));
  assert.ok(!mod.includes('poll_new_mail'));
  assert.ok(files['common.py'].code.includes('import code_harness as CODE_HARNESS'));
  assert.ok(!files['common.py'].code.includes('CODE_HARNESS_SOURCE'));
  assert.ok(files['common.py'].code.includes('PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))'));
});

test('LangGraphPackageTest::testSingleFileKeepsEmbeddingAndSaysWhereSkillsComeFrom', async () => {
  const code = (await pkgGenerator(await pkgGraph(), skillsRoot()).generate(44, '3')).code;
  assert.ok(code.includes('poll_new_mail'));
  assert.ok(code.includes('CODE_HARNESS_SOURCE = '));
  assert.ok(code.includes('Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); '
    + 'use the modular package for a self-contained copy.'));
});

test('LangGraphPackageTest::testPackageDefaultsPointInsideThePackage', async () => {
  const common = (await pkgFiles())['common.py'].code;
  assert.ok(common.includes('SKILLS_DIR = os.environ.get("SYNERGYAI_SKILLS_DIR") or os.path.join(PACKAGE_DIR, "skills")'));
  assert.ok(common.includes('os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")'));
  assert.ok(common.includes('os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(PACKAGE_DIR, "scratch")'));
});

test('LangGraphPackageTest::testStartDocumentsAreCopiedOnlyFromTheUsersStorage (generated package)', async () => {
  const root = tempDir('lgpkg_storage_');
  const mine = `${root}/synergyaichatroot/user_3/workflow_docs/44`;
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(`${root}/synergyaichatroot/user_4`, { recursive: true });
  fs.writeFileSync(`${mine}/doc_1_brief.txt`, 'the brief\n');
  fs.writeFileSync(`${mine}/doc_2_scan.pdf`, Buffer.from('%PDF-1.4\n\x00\xff\xfe', 'latin1'));
  fs.writeFileSync(`${root}/synergyaichatroot/user_4/secret.txt`, "user 4's file\n");
  const outside = tempDir('lgpkg_outside_') + '/server.env';
  fs.writeFileSync(outside, 'DB_PASS=hunter2\n');
  fs.symlinkSync(outside, `${mine}/doc_3_link.txt`);
  const store = new StartDocumentStore('user_3', null, root);
  const docs = [
    { name: 'brief.txt', path: 'workflow_docs/44/doc_1_brief.txt', fullPath: 'synergyaichatroot/user_3/workflow_docs/44/doc_1_brief.txt' },
    { name: 'scan.pdf', path: 'workflow_docs/44/doc_2_scan.pdf' },
    { name: 'server.env', path: outside },
    { name: 'escape.txt', path: 'workflow_docs/../../user_4/secret.txt' },
    { name: 'link.txt', path: 'workflow_docs/44/doc_3_link.txt' },
    { name: 'mine.txt', path: 'workflow_docs/44/doc_1_brief.txt', storage: 'local' },
    { name: 'gone.txt', path: 'workflow_docs/44/gone.txt' },
  ];
  const files = byPath(await pkgGenerator(await pkgGraph('pdf-report', docs), skillsRoot(), false, store).generate(44, '3', { modular: true }));
  assert.equal(files['start_documents/doc_1_brief.txt'].code, 'the brief\n');
  assert.equal(files['start_documents/doc_2_scan.pdf'].encoding, 'base64');
  assert.deepEqual(Object.keys(files).filter((p) => p.startsWith('start_documents/')), ['start_documents/doc_1_brief.txt', 'start_documents/doc_2_scan.pdf']);
  for (const [p, f] of Object.entries(files)) {
    const bytes = (f.encoding ?? '') === 'base64' ? Buffer.from(f.code, 'base64').toString('latin1') : String(f.code);
    assert.ok(!bytes.includes('hunter2') && !bytes.includes("user 4's file"), p);
  }
  const wf = files['workflow.py'].code;
  assert.ok(wf.includes('"path": "start_documents/doc_1_brief.txt"'));
  assert.ok(!wf.includes('synergyaichatroot/user_3'), 'the copy drops fullPath');
  assert.ok(wf.includes(`"path": "${outside}"`), 'a path outside storage is left as is');
  assert.ok(wf.includes('"path": "workflow_docs/../../user_4/secret.txt"'));
  assert.ok(files['requirements.txt'].code.includes('pypdf\n'));
});

test('LangGraphPackageTest::testNothingPointsBackAtSynergyAI', async () => {
  for (const [p, f] of Object.entries(await pkgFiles())) {
    if (p === '.env.example' || p === 'README.md' || (f.encoding ?? '') === 'base64') continue;
    for (const needle of ['synergyAI/', '/api/v1/', 'netfo587', 'localhost/gpt']) assert.ok(!String(f.code).includes(needle), `${p}: ${needle}`);
  }
});

test('LangGraphPackageTest::testNothingPointsBackAtSynergyAIAcrossFixtures', async () => {
  for (const [mode, opts] of [['single', {}], ['modular', { modular: true }], ['a2a', { a2a: true }]] as Array<[string, any]>) {
    const { gen, cleanup } = fixtureGenerator('dispatcher_demo');
    try {
      assertSelfContained(byPath(await gen.generate(44, '3', opts)), `dispatcher_demo ${mode}`);
    } finally {
      cleanup();
    }
  }
  const custom = byPath(await pkgGenerator(await pkgGraph(), skillsRoot(), false, null, 'reports/weekly').generate(44, '3', { modular: true }));
  assertSelfContained(custom, 'custom folder modular');
  assert.ok(custom['workflow.py'].code.includes('OUTPUT_FOLDER = "reports/weekly"'));
  for (const [mode, opts] of [['single', {}], ['modular', { modular: true }]] as Array<[string, any]>) {
    assertSelfContained(byPath(await pkgGenerator(await pkgGraph(), skillsRoot()).generate(44, '3', opts)), `header ${mode}`);
  }
});

test('LangGraphPackageTest::testOutputStorageOnStaysSelfContained', async () => {
  for (const [mode, opts] of [['single', {}], ['modular', { modular: true }]] as Array<[string, any]>) {
    const files = byPath(await pkgGenerator(await pkgGraph(), skillsRoot(), true).generate(44, '3', opts));
    assertSelfContained(files, `storage on ${mode}`);
    const entry = mode === 'single' ? String(Object.values(files)[0].code) : files['workflow.py'].code;
    assert.ok(entry.includes('OUTPUT_STORAGE_ENABLED = True'), mode);
    assert.ok(entry.includes('# Output storage (Output node setting): ON -> outputs/workflow/ '
      + (mode === 'single' ? 'next to this script' : 'in this folder') + ' (SYNERGYAI_OUTPUT_ROOT overrides)'), mode);
  }
  const single = (await pkgGenerator(await pkgGraph(), skillsRoot(), true).generate(44, '3')).code;
  assert.ok(single.includes('root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")'));
  assert.ok(single.includes('SKILLS_DIR = os.environ.get(\n    "SYNERGYAI_SKILLS_DIR",'), 'the single file keeps the skills default');
  const custom = byPath(await pkgGenerator(await pkgGraph(), skillsRoot(), true, null, 'reports/weekly').generate(44, '3', { modular: true }));
  assert.ok(custom['workflow.py'].code.includes('# Output storage (Output node setting): ON -> reports/weekly'));
});

const PY3 = spawnSync('python3', ['--version']).status === 0;

test('LangGraphPackageTest::testEnsureDepsInstallsOnlyWhatIsMissingAndWarns', { skip: PY3 ? undefined : 'python3 missing' }, () => {
  const dir = tempDir('lgpkg_deps_');
  fs.mkdirSync(`${dir}/skills/s`, { recursive: true });
  fs.writeFileSync(`${dir}/skills/s/SKILL.md`, '---\nname: s\ndependencies: [json, zz-not-installed-pkg>=1.0]\n---\n');
  const py = 'from __future__ import annotations\nimport os, sys, subprocess, threading, json, re, time, asyncio, shutil\nfrom functools import cached_property\n'
    + 'def node_print(line):\n    print(line, flush=True)\n'
    + 'PACKAGE_DIR = ' + var_export_scalar(dir) + '\n'
    + LangGraphRuntime.skillRuntimeBlock(true) + '\n'
    + 'calls = []\nclass R:\n    returncode, stderr = 0, ""\n'
    + 'subprocess.run = lambda argv, **kw: calls.append(argv[-1]) or R()\n'
    + 'SKILLS.ensure_deps(os.path.join(SKILLS_DIR, "s"))\n'
    + 'SKILLS.ensure_deps(os.path.join(SKILLS_DIR, "s"))   # once per process\n'
    + 'print("pip", calls)';
  fs.writeFileSync(`${dir}/probe.py`, py);
  const r = spawnSync('python3', [`${dir}/probe.py`], { encoding: 'utf8' });
  const out = (r.stdout + r.stderr).split('\n').filter((l) => l !== '');
  assert.equal(r.status, 0, out.join('\n'));
  assert.deepEqual(out, ['[warn] installing zz-not-installed-pkg>=1.0 (not in requirements.txt)', "pip ['zz-not-installed-pkg>=1.0']"]);
});

test('LangGraphPackageTest::testEveryPythonFileOfThePackageCompiles', { skip: PY3 ? undefined : 'python3 missing' }, async () => {
  const dir = tempDir('lgpkg_compile_');
  for (const [p, f] of Object.entries(await pkgFiles())) {
    fs.mkdirSync(path.dirname(`${dir}/${p}`), { recursive: true });
    fs.writeFileSync(`${dir}/${p}`, (f.encoding ?? '') === 'base64' ? Buffer.from(f.code, 'base64') : f.code);
    if (p.endsWith('.py')) {
      const r = spawnSync('python3', ['-m', 'py_compile', `${dir}/${p}`], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${p}: ${r.stdout}${r.stderr}`);
    }
  }
});

test('LangGraphPackageTest::testEditingACodeFileTakesEffectOnTheNextRun', { skip: fs.existsSync(VENV) ? undefined : 'venv python missing' }, async () => {
  const graph = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
      { id: '2', node_type: 'code', config: { type: 'code', name: 'Check', code: "def run(input, call_tool):\n    return {'route': 'work', 'output': 'first'}\n",
        exits: ['work'], mcp_servers: [], timeout_s: 30 } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
  };
  const result = await pkgGenerator(graph, skillsRoot(), true).generate(44, '3', { modular: true });
  const dir = tempDir('lgpkg_run_');
  for (const f of values(result.files)) {
    fs.mkdirSync(path.dirname(`${dir}/${f.path}`), { recursive: true });
    fs.writeFileSync(`${dir}/${f.path}`, (f.encoding ?? '') === 'base64' ? Buffer.from(f.code, 'base64') : f.code);
  }
  assert.ok(fs.existsSync(`${dir}/code/2_check.py`));
  const driver = "import importlib.util, sys\nspec = importlib.util.spec_from_file_location('prog', 'workflow.py')\n"
    + "m = importlib.util.module_from_spec(spec)\nsys.modules['prog'] = m\nspec.loader.exec_module(m)\n"
    + "view = m.ConsoleView('quiet')\nrec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])\n"
    + "run = m.make_run_once('go', m.RunLoop(), view, rec, loop_mode=True)\n"
    + "print('RESULT', run())\n"
    + "open('code/2_check.py', 'w').write(\"def run(input, call_tool):\\n    return {'route': 'work', 'output': 'second'}\\n\")\n"
    + "print('RESULT', run())\n";
  fs.writeFileSync(`${dir}/drive.py`, driver);
  const r = spawnSync(VENV, ['drive.py'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 120000 });
  const text = r.stdout + r.stderr;
  assert.equal(r.status, 0, text);
  assert.ok(text.includes('RESULT first\n'), text);
  assert.ok(text.includes('RESULT second\n'), text);
  assert.ok(fs.existsSync(`${dir}/outputs`), 'save_output writes inside the package by default');
});

// ---------------------------------------------------------------- LangGraphArchitectureDocTest

/** LangGraphOutputStructureTest::graphs()['linear']: a plain chain, no dispatcher, no playbook. */
function linearGraph(): any {
  const agent = (name: string) => ({
    type: 'agent-template', agent_name: name, agent_type: 'standard', instructions: `You are ${name}.`, agent_provider: 'claude',
    model: 'claude-sonnet-4-5', tools: [], settings: { temperature: F(0.7), max_tokens: 4096 },
  });
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'write something' } },
      { id: '2', node_type: '', config: agent('Researcher') },
      { id: '3', node_type: '', config: agent('Writer') },
      { id: '4', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }],
  };
}

/** generate() of the dispatcher demo (or a given graph over the same database, skills and workflow) in one mode. */
async function docGenerate(graph: 'dispatcher_demo' | 'linear' | any, mode: string): Promise<any> {
  const { gen, cleanup } = fixtureGenerator('dispatcher_demo');
  try {
    if (graph !== 'dispatcher_demo') {
      const g = graph === 'linear' ? linearGraph() : graph;
      (gen as any).graphRepo = { getGraph: async () => g };
    }
    return await gen.generate(44, '3', mode === 'single' ? {} : { [mode]: true });
  } finally {
    cleanup();
  }
}

/** The ```mermaid blocks, keyed by their first line (the diagram type). */
function mermaidBlocks(doc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of doc.matchAll(/```mermaid\n([\s\S]*?)```/g)) out[m[1].split('\n')[0]] = m[1];
  return out;
}

test('LangGraphArchitectureDocTest::testEveryModeExposesTheDocAndKeepsItsExistingKeys', async () => {
  assert.deepEqual(Object.keys(await docGenerate('dispatcher_demo', 'single')), ['filename', 'code', 'architecture']);
  for (const mode of ['modular', 'a2a']) {
    const r = await docGenerate('dispatcher_demo', mode);
    assert.deepEqual(Object.keys(r), ['root', 'files', 'architecture'], mode);
    const last = r.files[r.files.length - 1];
    assert.equal(last.path, 'ARCHITECTURE.md', `${mode}: written beside the code, last`);
    assert.equal(last.code, r.architecture, mode);
  }
});

test('LangGraphArchitectureDocTest::testDocHasBothDiagramsAndEverySection', async () => {
  for (const mode of ['single', 'modular', 'a2a']) {
    const doc = (await docGenerate('dispatcher_demo', mode)).architecture;
    assert.ok(doc.startsWith('# Dispatcher demo'), mode);
    for (const h of ['## Files', '## Class diagram', '## Workflow diagram', '## Classes', '## How a run flows', '## How to change it']) {
      assert.ok(doc.includes(`\n${h}\n`), `${mode}: ${h}`);
    }
    assert.deepEqual(Object.keys(mermaidBlocks(doc)), ['classDiagram', 'flowchart LR'], mode);
  }
});

test('LangGraphArchitectureDocTest::testFilesTableNamesTheRealFilesOfEachMode', async () => {
  assert.ok((await docGenerate('dispatcher_demo', 'single')).architecture.includes('| `dispatcher_demo_langgraph.py` |'));
  const modular = await docGenerate('dispatcher_demo', 'modular');
  for (const f of modular.files) {
    const m = /^skills\/(.+)\/SKILL\.md$/.exec(f.path);
    const row = m ? `skills/${m[1]}/` : f.path;
    if (f.path.startsWith('skills/') && row === f.path) continue;
    assert.ok(modular.architecture.includes(`| \`${row}\` |`), f.path);
  }
  assert.ok(modular.architecture.includes('`run_node = make_node(NODE).run`'));
  const a2a = await docGenerate('dispatcher_demo', 'a2a');
  for (const f of a2a.files) assert.ok(a2a.architecture.includes(`| \`${f.path}\` |`), f.path);
});

test('LangGraphArchitectureDocTest::testClassDiagramListsOnlyTheClassesPresent', async () => {
  const base = ['Node', 'AgentNode', 'DispatcherNode', 'NodeKind', 'Dispatcher', 'DecisionResult', 'RouteDecision', 'WorkflowGraph',
    'ToolCatalog', 'McpClient', 'SkillRuntime', 'RunEvents', 'DocumentConverter'];
  const adapter = ['JevRouter'];
  const playbook = ['PlaybookNode', 'PlaybookRun', 'PlaybookToolset'];
  const a2aOnly = ['AgentSupervisor', 'NodeExecutor'];
  const cases: Array<[string, string, string[], string[]]> = [
    ['dispatcher_demo', 'modular', [...base, ...adapter, ...playbook], a2aOnly],
    ['dispatcher_demo', 'a2a', [...base, ...adapter, ...playbook, ...a2aOnly], []],
    ['linear', 'single', base, [...adapter, ...playbook, ...a2aOnly]],
  ];
  for (const [graph, mode, present, absent] of cases) {
    const r = await docGenerate(graph, mode);
    const doc: string = r.architecture;
    const diagram = mermaidBlocks(doc)['classDiagram'];
    const code: string = mode === 'single' ? r.code : r.files.map((f: any) => f.code).join('\n');
    for (const cls of present) {
      assert.match(diagram, new RegExp(`\\b${cls}\\b`), `${graph}/${mode}: ${cls} in the diagram`);
      assert.ok(doc.includes(`### ${cls}\n`), `${graph}/${mode}: ${cls} described`);
      assert.match(code, new RegExp(`^class ${cls}\\b`, 'm'), `${graph}/${mode}: ${cls} really emitted`);
    }
    for (const cls of absent) {
      assert.doesNotMatch(diagram, new RegExp(`\\b${cls}\\b`), `${graph}/${mode}: no ${cls}`);
      assert.ok(!doc.includes(`### ${cls}`), `${graph}/${mode}: no ${cls} section`);
    }
  }
});

test('LangGraphArchitectureDocTest::testNoPlaybookSectionWithoutAPlaybook', async () => {
  const doc = (await docGenerate('linear', 'modular')).architecture;
  assert.ok(!doc.includes('Playbook'));
  assert.ok(!doc.includes('PLAYBOOK_GATE_MODE'));
});

test('LangGraphArchitectureDocTest::testWorkflowDiagramNamesEveryNodeAndLabelsDispatcherChoices', async () => {
  const flow = mermaidBlocks((await docGenerate('dispatcher_demo', 'modular')).architecture)['flowchart LR'];
  for (const name of ['Start', 'techBuddy', 'IT claims', 'Human resources', 'Playbook HR', 'Output']) assert.ok(flow.includes(`"${name}`), name);
  for (const s of ['n1 --> n2', 'n2 -.->|choice| n3', 'n2 -.->|choice| n4', 'n4 --> n5']) assert.ok(flow.includes(s), s);
  assert.ok(!flow.includes('n1 -.->'));
  const linear = mermaidBlocks((await docGenerate('linear', 'single')).architecture)['flowchart LR'];
  for (const name of ['Start', 'Researcher', 'Writer', 'Output']) assert.ok(linear.includes(`"${name}`), name);
  assert.ok(!linear.includes('choice'));
});

test('LangGraphArchitectureDocTest::testIngestionWorkflowIsRefused', async () => {
  await assert.rejects(docGenerate({
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start' } },
      { id: '2', node_type: 'loader', config: { type: 'loader' } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  }, 'single'), { message: 'Node "node_2" (loader) cannot be compiled: LangGraph runs start, agent, playbook, code and output nodes.' });
});

/** LangGraphA2AGeneratorTest::facts(): analyzeForEmit() of the dispatcher demo. */
async function demoFacts(): Promise<any> {
  const { gen, cleanup } = fixtureGenerator('dispatcher_demo');
  try {
    return await (gen as any).analyzeForEmit(44, '3');
  } finally {
    cleanup();
  }
}

test('LangGraphArchitectureDocTest::testADocFailureStillReturnsTheCodeFiles', async () => {
  const facts = await demoFacts();
  facts.workflow = null;   // build() calls facts.workflow.isOutputStorageEnabled(): throws
  for (const mode of ['modular', 'a2a']) {
    const code = [{ path: 'workflow.py', code: 'print(1)' }, { path: 'agents/a.py', code: 'NODE = {}' }];
    const r = (LangGraphGenerator as any).withArchitecture({ root: `demo_${mode}`, files: [...code] }, facts, mode);
    assert.deepEqual(r.files, code, `${mode}: the code files, nothing added`);
    assert.ok('architecture' in r, mode);
    assert.equal(r.architecture, null, mode);
    const zip = WorkflowController.langGraphZipResponse(r, mode) as any;
    const tmp = path.join(tempDir('lgzip_'), 'x.zip');
    fs.writeFileSync(tmp, zip.raw_body);
    const names = spawnSync('unzip', ['-Z1', tmp], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '');
    assert.deepEqual(names, [`demo_${mode}/workflow.py`, `demo_${mode}/agents/a.py`], mode);
  }
});

test('LangGraphArchitectureDocTest::testIngestionPackageGetsNoArchitectureDoc', async () => {
  const facts = await demoFacts();
  facts.byId['99'] = { id: '99', node_type: 'loader', config: { type: 'loader' } };
  const r = (LangGraphGenerator as any).withArchitecture({ root: 'feed_modular', files: [{ path: 'workflow.py', code: '' }] }, facts, 'modular');
  assert.deepEqual(r.files.map((f: any) => f.path), ['workflow.py']);
  assert.equal(r.architecture, null);
});

test('LangGraphArchitectureDocTest::testRunFlowAndChangeSectionsFollowTheMode', async () => {
  const single = (await docGenerate('dispatcher_demo', 'single')).architecture;
  assert.ok(single.includes('`_run_local_node`'));
  const modular = (await docGenerate('dispatcher_demo', 'modular')).architecture;
  assert.ok(modular.includes('`_run_node_module`'));
  assert.ok(modular.includes('python workflow.py'));
  const a2a = (await docGenerate('dispatcher_demo', 'a2a')).architecture;
  assert.ok(a2a.includes('`_run_remote_node`'));
  assert.ok(a2a.includes('python orchestrator.py'));
  for (const doc of [single, modular, a2a]) {
    for (const s of ['WorkflowGraph.run(prompt)', 'save_output', 'RUN SUMMARY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', '`<PROVIDER>_API_KEY` per decision model']) {
      assert.ok(doc.includes(s), s);
    }
  }
});

// ---------------------------------------------------------------- StartTriggerFacts

test('StartTriggerFacts.watchArgs keeps an ordered array ordered (numeric-looking names in place)', () => {
  const w = oarr([['9', 'a'], ['folder', 'Inbox']]);
  const out = StartTriggerFacts.watchArgs(w, { tag: 'okta', '1': 'x' }, ['1']);
  assert.equal(jsonU(out), '{"9":"a","folder":"Inbox","tag":"okta","1":"x"}');
  assert.equal(jsonU(w), '{"9":"a","folder":"Inbox"}', 'the input is not changed');
});
