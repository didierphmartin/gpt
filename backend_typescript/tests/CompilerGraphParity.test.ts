/**
 * Differential tests of the compiler's graph front half against backend/'s PHP: GraphAnalyzer (WorkflowGraphAnalyzer),
 * LangGraphPackage, LangGraphArchitectureDoc, SwarmRewriter, DispatcherDecisionFacts. Each TS result is json_encoded
 * with the PHP harness's flags and compared with PHP's text (key order included). PHP runs through
 * tests/fixtures/compiler/php_compile.php (+ ga_analyze.php), in-memory SQLite only; skipped without a PHP binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installSqliteDb } from './support/sqliteDb';
import { FIXTURES, fixturePath, phpBin, phpFacts, phpSkipReason } from './support/phpCompiler';
import {
  JSON_PRESERVE_ZERO_FRACTION, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, jsonDecodeAssoc, jsonDecodePhp, json_encode, entries, oarr, values, deepCopy,
} from '../src/AgentTeam/compiler/php';
import { GraphAnalyzer } from '../src/AgentTeam/compiler/GraphAnalyzer';
import { SwarmRewriter } from '../src/AgentTeam/compiler/SwarmRewriter';
import { DispatcherDecisionFacts } from '../src/AgentTeam/compiler/DispatcherDecisionFacts';
import { LangGraphPackage } from '../src/AgentTeam/compiler/LangGraphPackage';
import { LangGraphArchitectureDoc } from '../src/AgentTeam/compiler/LangGraphArchitectureDoc';
import { WorkflowView } from '../src/AgentTeam/compiler/WorkflowView';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { hydrateAgent } from '../src/AgentTeam/AgentRepository';
import { StartTriggerFacts } from '../src/AgentTeam/StartTriggerFacts';

const SKIP = phpSkipReason();
const FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION;
const enc = (v: any) => json_encode(v, FLAGS);

/** Every fixture of the compiler parity suite. */
const ALL_FIXTURES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'schema.json').map((f) => f.replace(/\.json$/, '')).sort();
const GA_FIXTURES = ['dispatcher_demo', 'ga_numeric_order', 'ga_swarm', 'pkg_skills_docs'];

/** php_compile.php's schema (schema.json). */
function baseSchema(): string[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'schema.json'), 'utf8'));
}

/** A fixture as php_compile.php's fixture_load() reads it ({"extends": other} merged), floats and key order kept. */
export function loadFixture(name: string): any {
  const fx = jsonDecodeAssoc(fs.readFileSync(fixturePath(name), 'utf8'));
  if (fx.extends !== undefined) {
    const base = loadFixture(String(fx.extends));
    delete fx.extends;
    for (const [k, v] of entries(fx)) base[k] = v;
    return base;
  }
  return fx;
}

/** phpCall with the arguments json_encoded by php.ts (1.0 stays a float; key order and {} vs [] as TS holds them). */
export function phpCallX(cls: string, method: string, args: any[] = []): any {
  const req = json_encode({ class: cls, method, args: args.map((a) => (a && a.$facts ? { $facts: fixturePath(a.$facts) } : a)) }, FLAGS);
  const r = spawnSync(phpBin()!, [path.join(FIXTURES, 'php_compile.php'), 'call'], {
    input: req,
    encoding: 'utf8',
    env: { ...process.env, XDEBUG_MODE: 'off', TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`php_compile.php call exited ${r.status}: ${r.stderr}`);
  const out = jsonDecodePhp(r.stdout.trim().split('\n').pop()!);
  if (!out.ok) throw new Error(`${cls}::${method} threw: ${out.error}`);
  return out.result;
}

/** The fixture's in-memory SQLite (BASE_SCHEMA + its sql) and repository stubs mirroring php_compile.php's. */
export function fixtureEnv(fx: any): { workflowRepo: any; graphRepo: any; agentRepo: any } {
  const d = installSqliteDb();
  for (const s of [...baseSchema(), ...((fx.sql as string[]) ?? [])]) d.exec(s);
  const components = fx.code_components ?? oarr();
  return {
    workflowRepo: { findById: async () => WorkflowView.fromRecord(fx.workflow) },
    graphRepo: { getGraph: async () => StartOptionGraph.expand(fx.graph, async (id: number) => components[String(id)] ?? null) },
    agentRepo: { findById: async (id: number) => (fx.agents?.[String(id)] ? hydrateAgent(fx.agents[String(id)]) : null) },
  };
}

function phpAnalyze(fixture: string): any {
  const r = spawnSync(phpBin()!, [path.join(FIXTURES, 'ga_analyze.php'), fixturePath(fixture)], {
    encoding: 'utf8', env: { ...process.env, XDEBUG_MODE: 'off' }, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ga_analyze.php exited ${r.status}: ${r.stderr}`);
  return jsonDecodePhp(r.stdout.trim().split('\n').pop()!);
}

// ---------------------------------------------------------------- GraphAnalyzer

for (const fixture of GA_FIXTURES) {
  test(`GraphAnalyzer analyze/serverIndex/availableToolsById match PHP: ${fixture}`, { skip: SKIP || undefined }, async () => {
    const php = phpAnalyze(fixture);
    assert.equal(php.ok, true, php.error);
    const fx = loadFixture(fixture);
    const env = fixtureEnv(fx);
    const an = new GraphAnalyzer(env.workflowRepo, env.graphRepo, env.agentRepo);
    const uid = fx.user_id !== undefined ? String(fx.user_id) : null;
    assert.equal(enc(await an.analyze(Number(fx.workflow.id), uid)), enc(php.analyze));
    assert.equal(enc(await an.serverIndex(uid)), enc(php.serverIndex));
    assert.equal(enc(await an.serverIndex(null)), enc(php.serverIndexGlobal));
    assert.equal(enc(await an.availableToolsById(uid)), enc(php.availableToolsById));
    assert.equal(enc(await an.availableToolsById(null)), enc(php.availableToolsGlobal));
  });
}

for (const fixture of GA_FIXTURES) {
  test(`GraphAnalyzer statics match PHP: ${fixture}`, { skip: SKIP || undefined }, () => {
    const fx = loadFixture(fixture);
    const graph = fx.graph;
    assert.equal(enc(GraphAnalyzer.reachableGraph(graph)), enc(phpCallX('WorkflowGraphAnalyzer', 'reachableGraph', [graph])));
    const reach = GraphAnalyzer.reachableGraph(graph);
    const tsA = GraphAnalyzer.analyzeGraph(reach);
    assert.equal(enc(tsA), enc(phpCallX('WorkflowGraphAnalyzer', 'analyzeGraph', [reach])));
    for (const n of reach.nodes) {
      assert.equal(GraphAnalyzer.typeOf(n), phpCallX('WorkflowGraphAnalyzer', 'typeOf', [n]));
      assert.equal(enc(GraphAnalyzer.skillsFromConfig(n.config ?? [])), enc(phpCallX('WorkflowGraphAnalyzer', 'skillsFromConfig', [n.config ?? []])));
    }
    const php = phpAnalyze(fixture).analyze;
    assert.equal(enc(GraphAnalyzer.dispatchMenus(php)), enc(phpCallX('WorkflowGraphAnalyzer', 'dispatchMenus', [php])));
    for (const runnable of [undefined, ['start', 'agent', 'agent-template', 'playbook', 'code', 'output']]) {
      const extra = oarr([[tsA.order[1], { dispatch: ['X', 'Y'], playbook: { bound: 2, title: 'T' } }]]);
      for (const ex of [[], extra]) {
        const args = runnable ? [php, ex, runnable] : [php, ex];
        assert.equal(enc((GraphAnalyzer.docNodesFromAnalyzed as any)(...args)), enc(phpCallX('WorkflowGraphAnalyzer', 'docNodesFromAnalyzed', args)));
      }
    }
    // hand-built analyzed (only agents): the graph is reconstructed from them
    const handBuilt = { agents: oarr([['3', { name: 'A', provider: 'claude', tools: ['t1', { name: 't2' }] }], ['1', { model: 'm' }]]) };
    assert.equal(enc(GraphAnalyzer.docNodesFromAnalyzed(handBuilt)), enc(phpCallX('WorkflowGraphAnalyzer', 'docNodesFromAnalyzed', [handBuilt])));
    assert.equal(enc(GraphAnalyzer.docNodes(php.byId, php.order, php.edges, php.agents)),
      enc(phpCallX('WorkflowGraphAnalyzer', 'docNodes', [php.byId, php.order, php.edges, php.agents])));
    for (const nid of php.order) {
      assert.equal((GraphAnalyzer as any).displayNameOf(php.byId[nid], php, nid), phpCallX('WorkflowGraphAnalyzer', 'displayNameOf', [php.byId[nid], php, nid]));
    }
  });
}

test('GraphAnalyzer: a cycle throws as PHP does', { skip: SKIP || undefined }, () => {
  const g = { nodes: [{ id: '1', type: 'agent' }, { id: '2', type: 'agent' }], edges: [{ from: '1', to: '2' }, { from: '2', to: '1' }] };
  assert.throws(() => GraphAnalyzer.analyzeGraph(g), /Workflow graph has a cycle or disconnected node/);
  assert.throws(() => phpCallX('WorkflowGraphAnalyzer', 'analyzeGraph', [g]), /Workflow graph has a cycle or disconnected node/);
});

// ---------------------------------------------------------------- SwarmRewriter

const SWARM_CASES = jsonDecodeAssoc(fs.readFileSync(path.resolve(__dirname, '../../backend/tests/fixtures/swarm/rewrite-cases.json'), 'utf8'));

/** Graphs beyond the contract: odd field types, names that collide only after case folding / trimming, odd ids. */
function swarmExtraGraphs(): any[] {
  const start = { id: '1', node_type: 'start', config: { type: 'start' } };
  const ag = (id: string, cfg: any) => ({ id, node_type: '', config: { type: 'agent-template', ...cfg } });
  return [
    { nodes: [start, ag('10', { agent_name: 'Ops', instructions: '  First line \n second', tools: { a: 1 }, bound_skill: '0' }),
      ag('2', { name: 'Billing', instructions: 'x'.repeat(130) + 'é', tools: ['t1', 't2'], bound_skill: false }),
      ag('b', { agent_name: false, name: 7, instructions: "Trailing  \t\n" })],
    edges: [{ from: '1', to: '10' }, { from: '1', to: '2' }, { from: '1', to: 'b' }, { from: '1', to: '2' }] },
    { nodes: [start, ag('3', { agent_name: ' Ops ' }), ag('4', { agent_name: 'ops' }), ag('5', { agent_name: 'Other' })],
      edges: [{ from: '1', to: '3' }, { from: '1', to: '4' }, { from: '1', to: '5' }] },
    { nodes: [start, ag('3', { agent_name: 'A' }), ag('4', { agent_name: 'B' }), ag('6', { agent_name: 'C' })],
      edges: [{ from_node_id: '1', to_node_id: '3' }, { from: '1', to: '4' }, { from: '3', to: '6' }] },
    { nodes: [start, ag('3', { agent_name: 'A', agent_type: 'dispatcher' }), { id: '9', node_type: 'output', config: { type: 'output' } },
      { id: '8', config: { type: 'output' } }], edges: [] },
    { nodes: [start, ag('3', { agent_name: 'A' })], edges: [{ from: '1', to: '3' }] },
    { nodes: [], edges: [] },
  ];
}

test('SwarmRewriter.rewrite matches PHP on the contract cases, the fixtures and extra graphs', { skip: SKIP || undefined }, () => {
  const graphs = [
    ...values(SWARM_CASES.cases).map((c: any) => c.graph),
    ...ALL_FIXTURES.map((f) => loadFixture(f).graph),
    ...swarmExtraGraphs(),
  ];
  const php = phpCallX('SwarmRewriter', 'rewrite', [graphs[0]]);
  assert.equal(enc(SwarmRewriter.rewrite(graphs[0])), enc(php));
  for (const g of graphs) assert.equal(enc(SwarmRewriter.rewrite(g)), enc(phpCallX('SwarmRewriter', 'rewrite', [g])));
  const colleagues = [{ name: 'A', role: '  r1 ' }, { name: 'B|c', role: '' }, { name: 'C', role: ' ' }];
  assert.equal(SwarmRewriter.handoffGuide(colleagues), phpCallX('SwarmRewriter', 'handoffGuide', [colleagues]));
  assert.equal(SwarmRewriter.HOP_BUDGET, 25);
});

// ---------------------------------------------------------------- StartTriggerFacts (src/AgentTeam/StartTriggerFacts.ts)

test('StartTriggerFacts.watchArgs matches PHP', { skip: SKIP || undefined }, () => {
  const cases: any[] = [
    [{ folder: 'Inbox', tag: 'x' }, { tag: 'okta', folder: 'Mail in', other: 1 }, ['folder']],
    [{ folder: 'Inbox' }, { tag: '', folder: '' }, ['folder']],
    [[], { folder: [], n: 0, z: '0' }, ['folder', 5, 'n', 'z']],
    [oarr([['9', 'a'], ['folder', 'Inbox']]), { tag: 'okta', '1': { a: 1 } }, ['1', '9']],
  ];
  for (const [w, s, p] of cases) {
    assert.equal(enc(StartTriggerFacts.watchArgs(w, s, p)), enc(phpCallX('StartTriggerFacts', 'watchArgs', [w, s, p])));
  }
});

// ---------------------------------------------------------------- DispatcherDecisionFacts

const DDF_SETTINGS = [null, { routing_mode: 'llm' }, { routing_mode: 'jev', jev_min_confidence: 0.2 }, { routing_mode: 'nope' },
  { min_confidence: -3 }, { min_confidence: 'abc', unclear_branch: '  x ' }, { routing_mode: ' luna-gw.eu ', min_confidence: '1' },
  { routing_mode: 'luna-gw.eu', min_confidence: 0.75 }];

for (const fixture of ['dispatcher_demo', 'ga_numeric_order', 'pkg_skills_docs']) {
  test(`DispatcherDecisionFacts.of matches PHP: ${fixture}`, { skip: SKIP || undefined }, async () => {
    const r = spawnSync(phpBin()!, [path.join(FIXTURES, 'ddf_call.php'), fixturePath(fixture)], {
      input: json_encode({ settings: DDF_SETTINGS }, FLAGS), encoding: 'utf8', env: { ...process.env, XDEBUG_MODE: 'off' }, maxBuffer: 64 * 1024 * 1024,
    });
    const php = jsonDecodePhp(r.stdout.trim().split('\n').pop()!);
    assert.equal(php.ok, true, php.error);
    const fx = loadFixture(fixture);
    const env = fixtureEnv(fx);
    const ts: any[] = [];
    for (const node of values(fx.graph.nodes)) {
      for (const [si, settings] of DDF_SETTINGS.entries()) {
        const n = deepCopy(node);
        if (settings !== null) n.config.settings = jsonDecodeAssoc(json_encode(settings, FLAGS));
        for (const [useDb, useRepo] of [[true, true], [false, true], [true, false]]) {
          ts.push({ node: String(node.id), settings: si, db: useDb, repo: useRepo,
            facts: await DispatcherDecisionFacts.of(useDb ? {} : null, useRepo ? env.agentRepo : null, n, String(fx.workflow.name)) });
        }
      }
    }
    assert.equal(enc(ts), enc(php.result));
  });
}

// ---------------------------------------------------------------- LangGraphPackage

/** The fixture's skills folder, plus a non-UTF-8 file and a symlink out of the folder (the PHP side reads the same root). */
function skillsRoot(fx: any): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lg_pkg_parity_'));
  for (const [dir, files] of entries(fx.skills ?? [])) {
    for (const [rel, text] of entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, dir, rel), String(text));
    }
  }
  if (fs.existsSync(path.join(root, 'pdf-tools'))) {
    fs.mkdirSync(path.join(root, 'pdf-tools/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pdf-tools/bin/blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'pdf-tools/link-out.txt'));
    fs.symlinkSync(path.join(root, 'pdf-tools/scripts'), path.join(root, 'pdf-tools/linked-dir'));
  }
  return root;
}

for (const fixture of ALL_FIXTURES) {
  test(`LangGraphPackage matches PHP: ${fixture}`, { skip: SKIP || undefined }, () => {
    const fx = loadFixture(fixture);
    const facts = phpFacts(fixture);
    if (facts.ok === false) return;   // analyzeForEmit refuses this workflow: there are no facts to package
    const root = skillsRoot(fx);
    try {
      let tsFiles: any;
      try {
        tsFiles = LangGraphPackage.files(facts, root);
      } catch (e: any) {
        tsFiles = { error: e.message };
      }
      let phpFiles: any;
      try {
        phpFiles = phpCallX('LangGraphPackage', 'files', [{ $facts: fixture }, root]);
      } catch (e: any) {
        phpFiles = { error: String(e.message).replace(/^LangGraphPackage::files threw: /, '') };
      }
      assert.equal(enc(tsFiles), enc(phpFiles));
      assert.equal(enc(LangGraphPackage.skillDirs(facts)), enc(phpCallX('LangGraphPackage', 'skillDirs', [{ $facts: fixture }])));
      for (const startMode of ['prompt', 'cron', 'watch']) {
        for (const swarm of [false, true]) {
          const f = deepCopy(facts);
          f.workflow = facts.workflow;
          f.startMode = startMode;
          if (swarm) f.swarm = f.swarm ?? true;
          else delete f.swarm;
          const pf = deepCopy(f);
          pf.workflow = [];
          for (const layout of ['single', 'modular', 'a2a']) {
            // requirements.txt, .env.example and README.md of each layout
            assert.equal(enc((LangGraphPackage as any).docFiles(f, layout, [], 'wf_folder', 'wf_entry.py')),
              enc(phpCallX('LangGraphPackage', 'docFiles', [pf, layout, [], 'wf_folder', 'wf_entry.py'])), `docFiles ${layout} ${startMode} swarm=${swarm}`);
            assert.equal(LangGraphPackage.pipInstall(f, layout), phpCallX('LangGraphPackage', 'pipInstall', [pf, layout]), `pipInstall ${layout}`);
          }
          assert.equal(enc((LangGraphPackage as any).providers(f)), enc(phpCallX('LangGraphPackage', 'providers', [pf])));
        }
      }
      for (const [nid, cd] of entries(facts.codeData ?? [])) {
        for (const trig of [false, true]) {
          assert.equal(enc(LangGraphPackage.codeFile(nid, cd, trig)), enc(phpCallX('LangGraphPackage', 'codeFile', [nid, cd, trig])));
        }
      }
      assert.equal(enc(LangGraphPackage.startDocuments(facts.startDocuments ?? [])),
        enc(phpCallX('LangGraphPackage', 'startDocuments', [facts.startDocuments ?? []])));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('LangGraphPackage codeFile / skillDependencies match PHP on edge inputs', { skip: SKIP || undefined }, () => {
  for (const cd of [{ display: 'Fetch data!', source: 'x' }, { display: '___', source: 1 }, { source: 'y' }, { display: 'Ünïcode name' }, { display: '' }]) {
    for (const trig of [false, true]) {
      assert.equal(enc(LangGraphPackage.codeFile('12', cd, trig)), enc(phpCallX('LangGraphPackage', 'codeFile', ['12', cd, trig])));
    }
  }
  const mds = [
    '---\nname: x\ndependencies: [a, "b", \'c\']\n---\n', '---\r\nDEPENDENCIES:  pandas ,numpy\r\n---', 'no frontmatter\ndependencies: a',
    '---\nname: x\n---\ndependencies: late', '  ---  \ndependencies:\n---', '---\ndependencies: [ , ]\n', '---\nfoo: 1\ndependencies: ü-pkg, "x:y"\n---',
    '',
  ];
  for (const md of mds) assert.equal(enc(LangGraphPackage.skillDependencies(md)), enc(phpCallX('LangGraphPackage', 'skillDependencies', [md])), md);
  assert.equal(LangGraphPackage.defaultSkillsRoot(), phpCallX('LangGraphPackage', 'defaultSkillsRoot', []));
});

// ---------------------------------------------------------------- LangGraphArchitectureDoc

for (const fixture of ALL_FIXTURES) {
  test(`LangGraphArchitectureDoc.build matches PHP in every mode: ${fixture}`, { skip: SKIP || undefined }, () => {
    const r = spawnSync(phpBin()!, [path.join(FIXTURES, 'doc_call.php'), fixturePath(fixture)], {
      encoding: 'utf8', env: { ...process.env, XDEBUG_MODE: 'off' }, maxBuffer: 64 * 1024 * 1024,
    });
    const php = jsonDecodePhp(r.stdout.trim().split('\n').pop()!);
    const facts = phpFacts(fixture);
    if (facts.ok === false) {   // analyzeForEmit refuses this workflow: no facts, no document
      assert.equal(php.ok, false);
      return;
    }
    assert.equal(php.ok, true, php.error);
    for (const mode of ['single', 'modular', 'a2a']) {
      let ts: any;
      try {
        ts = LangGraphArchitectureDoc.build(facts, mode);
      } catch (e: any) {
        ts = { error: e.message };
      }
      assert.equal(enc(ts), enc(php.result[mode]), `${fixture} ${mode}`);
    }
  });
}
