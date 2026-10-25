/**
 * Differential test: the TypeScript ports of CompiledRuntimeEmit, CompiledA2AEmit, CompiledArchitectureDoc and
 * CompiledPackage (src/AgentTeam/compiler/) against backend/'s PHP, byte for byte, on each fixture's analysis
 * (WorkflowGraphAnalyzer::analyze() + CompiledRuntimeEmit::analyzeRuntime(), as ADKGenerator builds it), for the
 * ADK, MAF and NOOA targets. The PHP side is tests/fixtures/compiler/php_cmp.php.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { installSqliteDb } from './support/sqliteDb';
import { phpSkipReason } from './support/phpCompiler';
import { PhpCall, PhpResult, analyzableFixtures, asPhpArg, asText, cmpAnalyzed, cmpBatch, cmpWf64, skillsRootFor, withKeys } from './support/phpCmp';
import { entries, keysOf, oarr, values } from '../src/AgentTeam/compiler/php';
import { CompiledRuntimeEmit } from '../src/AgentTeam/compiler/CompiledRuntimeEmit';
import { CompiledA2AEmit } from '../src/AgentTeam/compiler/CompiledA2AEmit';
import { CompiledArchitectureDoc } from '../src/AgentTeam/compiler/CompiledArchitectureDoc';
import { CompiledPackage } from '../src/AgentTeam/compiler/CompiledPackage';

const SKIP = phpSkipReason();
const TITLES: Record<string, string> = { adk: 'Google ADK', maf: 'Microsoft Agent Framework', nooa: 'NVIDIA NOOA' };
const MODES = ['single', 'modular', 'a2a'];

type Case = { name: string; php: PhpCall; ts: () => any };
const cases: Case[] = [];
const add = (name: string, php: PhpCall, ts: () => any) => cases.push({ name, php, ts });
const R = CompiledRuntimeEmit as any;
const A = CompiledA2AEmit as any;
const D = CompiledArchitectureDoc as any;
const P = CompiledPackage as any;

/** Each fixture's php_cmp.php analysis (those ADKGenerator can analyze). */
const data: Record<string, any> = {};
if (!SKIP) {
  for (const f of analyzableFixtures()) {
    const d = cmpAnalyzed(f);
    if (d && d.pre !== undefined) data[f] = d;
  }
}
const wf64 = SKIP ? null : cmpWf64();

/** Synthetic code defining part of a target's catalog names (every 4th left out), for the ARCHITECTURE.md lookup. */
function catalogCode(target: string): string {
  const names = Object.keys(D.catalog(target));
  return names.map((n, i) => (i % 4 === 3 ? `# ${n} is only mentioned` : i % 4 === 0 ? `def ${n}(x):\n    return x` : i % 4 === 1 ? `class ${n}:\n    pass` : i === 2 ? `    async def ${n}(self):` : `${n} = {}`)).join('\n\n');
}

function docFiles(a: any, target: string, mode: string): any {
  const code = catalogCode(target);
  const f: any = oarr();
  if (mode === 'single') {
    f['wf_' + target + '.py'] = code;
    return f;
  }
  if (mode === 'a2a') {
    f['orchestrator.py'] = 'class AgentSupervisor:\n    pass\nasync def _run_remote_node(nid, text):\n    pass';
    f['api.py'] = 'import orchestrator';
  }
  f['workflow.py'] = 'from common import *';
  f['common.py'] = code;
  f['api.py'] ??= 'app = None';
  f['__init__.py'] = '';
  f['agents/__init__.py'] = '';
  for (const [, m] of entries(R.moduleLayout(a))) f[(m as any)['file']] = 'NODE = {}';
  if (mode === 'a2a') for (const [, e] of entries(A.layout(a))) f[(e as any)['file']] = 'class NodeExecutor:\n    pass';
  f['code_harness.py'] = '';
  f['code/2_poll.py'] = 'def run(input, call_tool):\n    return {}';
  f['requirements.txt'] = 'httpx\n';
  f['.env.example'] = '';
  f['README.md'] = '';
  f['skills/html/SKILL.md'] = '---\nname: html\n---\n';
  f['skills/html/scripts/create.py'] = '';
  f['start_documents/a.pdf'] = '';
  f['start_documents/b.docx'] = '';
  f['notes.txt'] = 'not described';
  return f;
}

function json(v: any): any {
  return JSON.parse(asText(v));
}

if (!SKIP) {
  // ---- no analysis needed
  add('codeHarnessBlock(true)', { class: 'CompiledRuntimeEmit', method: 'codeHarnessBlock', args: [true] }, () => R.codeHarnessBlock(true));
  add('codeHarnessBlock(false)', { class: 'CompiledRuntimeEmit', method: 'codeHarnessBlock', args: [false] }, () => R.codeHarnessBlock(false));
  add('CLI_HOOKS_SILENT', { class: 'CompiledRuntimeEmit', const: 'CLI_HOOKS_SILENT' }, () => R.CLI_HOOKS_SILENT);
  add('packageListenBlock()', { class: 'CompiledRuntimeEmit', method: 'packageListenBlock', args: [] }, () => R.packageListenBlock());
  const hooks = 'def _cli_begin(prompt: str) -> None:\n    print("[run] " + prompt)\n\n\ndef _cli_end(output: str) -> None:\n    print(output)\n';
  add('packageListenBlock(hooks)', { class: 'CompiledRuntimeEmit', method: 'packageListenBlock', args: [hooks] }, () => R.packageListenBlock(hooks));
  add('packageCommonBlock()', { class: 'CompiledRuntimeEmit', method: 'packageCommonBlock', args: [] }, () => R.packageCommonBlock());
  for (const parts of [['"""The runtime."""\nimport os\n', 'X = 1', 'def f():\n    return X\n'], ['HEAD'], []]) {
    add(`packageCommonWithRuntime(${parts.length} parts)`, { class: 'CompiledRuntimeEmit', method: 'packageCommonWithRuntime', args: [parts] },
      () => R.packageCommonWithRuntime(asPhpArg(parts)));
  }
  add('idRecordingHelpers()', { class: 'CompiledRuntimeEmit', method: 'idRecordingHelpers', args: [] }, () => R.idRecordingHelpers());
  add('dispatcherHelpers()', { class: 'CompiledA2AEmit', method: 'dispatcherHelpers', args: [] }, () => A.dispatcherHelpers());
  const urlNames: Array<[string, any]> = [
    ['normal', { 'http://a/': { a: 'A' }, 'http://b/mcp': { b_srv: 'B srv' }, 'http://c/': { '': '' } }],
    ['empty', {}],
    ['shared URL', { 'http://a/': { a: 'A', a2: 'A 2' } }],
    ['shared slug', { 'http://a/': { mail: 'Mail' }, 'http://b/': { mail: 'mail' } }],
    ['numeric slug', { 'http://1/': { '123': '123' }, 'http://2/': { '7': '7', '': 'x' } }],
  ];
  for (const [label, un] of urlNames) {
    add(`serverSlugs(${label})`, { class: 'CompiledRuntimeEmit', method: 'serverSlugs', args: [un] }, () => R.serverSlugs(asPhpArg(un)));
  }
  for (const t of Object.keys(TITLES)) {
    add(`catalog(${t})`, { class: 'CompiledArchitectureDoc', method: 'catalog', args: [t] }, () => D.catalog(t));
  }

  // ---- wf64 (AdkCodeNodeTest::wf64Analyzed)
  const w = (set: Record<string, any> = {}) => ({ $wf64: true, set });
  add('wf64 refuse', { class: 'CompiledA2AEmit', method: 'refuse', args: [w()] }, () => A.refuse(withKeys(wf64)));
  add('wf64 refuse (no code, trigger)', { class: 'CompiledA2AEmit', method: 'refuse', args: [w({ code: [], triggerNodeId: '10' })] },
    () => A.refuse(withKeys(wf64, { code: [], triggerNodeId: '10' })));
  add('wf64 layout', { class: 'CompiledA2AEmit', method: 'layout', args: [w()] }, () => A.layout(withKeys(wf64)));
  add('wf64 recordingBlock(true)', { class: 'CompiledRuntimeEmit', method: 'recordingBlock', args: [w(), true] }, () => R.recordingBlock(withKeys(wf64), true));
  add('wf64 codeNodesLiteral', { class: 'CompiledRuntimeEmit', method: 'codeNodesLiteral', args: [w()] }, () => R.codeNodesLiteral(withKeys(wf64)));
  for (const t of Object.keys(TITLES)) {
    add(`wf64 build ${t} single`, { class: 'CompiledArchitectureDoc', method: 'build', args: [w(), t, 'single', { 'wf64.py': catalogCode(t) }] },
      () => D.build(withKeys(wf64), t, 'single', asPhpArg({ 'wf64.py': catalogCode(t) })));
  }

  // ---- per fixture
  for (const [f, d] of Object.entries(data)) {
    if (d.analyzed === null) continue;   // analyzeRuntime refused it (checked below)
    const an = d.analyzed;
    const spec = (set: Record<string, any> = {}, unset: string[] = []) => ({ $analyzed: f, set, unset });
    const ta = (set: Record<string, any> = {}, unset: string[] = []) => withKeys(an, set, unset);
    const ids = keysOf(an['byId']);
    const codeIds = keysOf(an['code']);
    const layoutIds = keysOf(A.layout(ta()));

    add(`${f} mcpClientBlock`, { class: 'CompiledRuntimeEmit', method: 'mcpClientBlock', args: [spec()] }, () => R.mcpClientBlock(ta()));
    for (const cb of [false, true]) {
      add(`${f} recordingBlock(${cb})`, { class: 'CompiledRuntimeEmit', method: 'recordingBlock', args: [spec(), cb] }, () => R.recordingBlock(ta(), cb));
    }
    add(`${f} moduleLayout`, { class: 'CompiledRuntimeEmit', method: 'moduleLayout', args: [spec()] }, () => R.moduleLayout(ta()));
    for (const id of ids) {
      add(`${f} displayName(${id})`, { class: 'CompiledRuntimeEmit', method: 'displayName', args: [spec(), id] }, () => R.displayName(ta(), id));
      add(`${f} menuNestable(${id})`, { class: 'CompiledRuntimeEmit', method: 'menuNestable', args: [spec(), id] }, () => R.menuNestable(ta(), id));
    }
    for (const pkg of [false, true]) {
      add(`${f} codeNodeLiterals(package=${pkg})`, { class: 'CompiledRuntimeEmit', method: 'codeNodeLiterals', args: [spec({ package: pkg })] },
        () => R.codeNodeLiterals(ta({ package: pkg })));
      for (const split of [false, true]) {
        add(`${f} codeNodesLiteral(package=${pkg}, split=${split})`, { class: 'CompiledRuntimeEmit', method: 'codeNodesLiteral', args: [spec({ package: pkg, split })] },
          () => R.codeNodesLiteral(ta({ package: pkg, split })));
      }
      for (const cid of codeIds) {
        add(`${f} codeNodeEntry(${cid}, package=${pkg})`, { class: 'CompiledRuntimeEmit', method: 'codeNodeEntry', args: [spec({ package: pkg }), cid, json(an['code'][cid])] },
          () => R.codeNodeEntry(ta({ package: pkg }), cid, asPhpArg(json(an['code'][cid]))));
        if (pkg) {
          add(`${f} codePath(${cid})`, { class: 'CompiledPackage', method: 'codePath', args: [spec({ package: true }), cid] }, () => P.codePath(ta({ package: true }), cid));
        }
      }
    }
    for (const split of [false, true]) {
      add(`${f} decisionBlock(split=${split})`, { class: 'CompiledRuntimeEmit', method: 'decisionBlock', args: [spec({ split })] }, () => R.decisionBlock(ta({ split })));
    }

    // tablePackage: synthetic tables over every module the layout names
    const layout = R.moduleLayout(ta());
    const modIds = keysOf(layout);
    const nodeLits: any = oarr(modIds.map((id, i) => [id, `{"id": "${id}", "i": ${i}}`] as [string, string]));
    const codeLits = R.codeNodeLiterals(ta());
    const tables = oarr([['NODE', ['NODES', nodeLits]], ['CODE_NODE', ['CODE_NODES', codeLits]], ['DECISION', ['DECISIONS', oarr()]]]);
    const preludes = modIds.length > 0 ? oarr([[modIds[0], `class Agent_${modIds[0]}:\n    """The prompt."""`]]) : oarr();
    const common = ['"""The runtime."""\nimport os\n', 'NODES = {}', 'CODE_NODES = {}'];
    const assembly = ['def run_workflow(prompt):\n    return prompt', 'if __name__ == "__main__":\n    run_workflow("x")'];
    for (const [t, title] of Object.entries(TITLES)) {
      const args = [common, assembly, json(tables), json(preludes), title, `its ${t} node`, `the ${t} runtime`];
      add(`${f} tablePackage(${t})`, { class: 'CompiledRuntimeEmit', method: 'tablePackage', args: [spec(), ...args] },
        () => R.tablePackage(ta(), ...args.map(asPhpArg)));
    }

    // A2A
    add(`${f} refuse`, { class: 'CompiledA2AEmit', method: 'refuse', args: [spec()] }, () => A.refuse(ta()));
    add(`${f} version`, { class: 'CompiledA2AEmit', method: 'version', args: [spec()] }, () => A.version(ta()));
    add(`${f} layout`, { class: 'CompiledA2AEmit', method: 'layout', args: [spec()] }, () => A.layout(ta()));
    for (const [t, title] of Object.entries(TITLES)) {
      add(`${f} orchestrator(${t})`, { class: 'CompiledA2AEmit', method: 'orchestrator', args: [spec(), title] }, () => A.orchestrator(ta(), title));
      add(`${f} api(${t})`, { class: 'CompiledA2AEmit', method: 'api', args: [spec(), title] }, () => A.api(ta(), title));
      for (const nid of t === 'adk' ? layoutIds : layoutIds.slice(0, 1)) {
        const runNode = `async def run_node(request_text: str, trace) -> dict:\n    return {"text": request_text, "route": None, "notes": "", "status": "${t}"}\n\n`;
        add(`${f} server(${nid}, ${t})`, { class: 'CompiledA2AEmit', method: 'server', args: [spec(), nid, runNode, title] }, () => A.server(ta(), nid, runNode, title));
      }
      const modular = ['WORKFLOW = 1\n', 'COMMON = 1\n', [{ path: 'agents/__init__.py', code: '' }, { path: 'agents/x.py', code: 'X = 1\n' }]];
      const runNodes: any = oarr(layoutIds.map((nid) => [nid, `async def run_node(request_text, trace):\n    return {"text": "${nid}"}\n`] as [string, string]));
      const pkgFiles = [{ path: 'requirements.txt', code: 'a2a-sdk\n' }, { path: 'README.md', code: '# x\n' }];
      add(`${f} package(${t})`, { class: 'CompiledA2AEmit', method: 'package', args: [spec(), modular, json(runNodes), pkgFiles, `wf_${t}_a2a`, title] },
        () => A.package(ta(), asPhpArg(modular), asPhpArg(json(runNodes)), asPhpArg(pkgFiles), `wf_${t}_a2a`, title));
    }

    // ARCHITECTURE.md
    for (const t of Object.keys(TITLES)) {
      for (const mode of MODES) {
        const files = json(docFiles(ta(), t, mode));
        add(`${f} build(${t}, ${mode})`, { class: 'CompiledArchitectureDoc', method: 'build', args: [spec(), t, mode, files] },
          () => D.build(ta(), t, mode, asPhpArg(files)));
      }
      const single = { filename: `wf_${t}.py`, code: catalogCode(t), zip: null };
      add(`${f} attach(${t}, single)`, { class: 'CompiledArchitectureDoc', method: 'attach', args: [single, spec(), t, 'single'] },
        () => D.attach(asPhpArg(single), ta(), t, 'single'));
      const pkg = { root: `wf_${t}`, files: entries(json(docFiles(ta(), t, 'modular'))).map(([p, c]) => ({ path: p, code: c })) };
      add(`${f} attach(${t}, modular)`, { class: 'CompiledArchitectureDoc', method: 'attach', args: [pkg, spec(), t, 'modular'] },
        () => D.attach(asPhpArg(pkg), ta(), t, 'modular'));
    }
    const byId = json(an['byId']);
    byId['99'] = { id: '99', node_type: 'loader', config: { type: 'loader' } };
    add(`${f} attach(ingestion)`, { class: 'CompiledArchitectureDoc', method: 'attach', args: [{ filename: 'x.py', code: 'X = 1' }, spec({ byId }), 'adk', 'single'] },
      () => D.attach(asPhpArg({ filename: 'x.py', code: 'X = 1' }), ta({ byId }), 'adk', 'single'));

    // package files
    const docs = { startDocuments: [{ name: 'a.pdf', path: 'start_documents/a.pdf' }, { name: 'Report.DOCX' }, 'not an array', { name: 'x.txt', path: 'start_documents/x.txt' }] };
    const frameworks: Record<string, string[]> = { adk: ['google-adk>=1.0', 'litellm'], maf: ['agent-framework', 'httpx'], nooa: ['nvidia-nooa'] };
    for (const [t, title] of Object.entries(TITLES)) {
      add(`${f} requirements(${t})`, { class: 'CompiledPackage', method: 'requirements', args: [spec(docs), [], frameworks[t]] },
        () => P.requirements(ta(docs), [], asPhpArg(frameworks[t])));
      const documentFiles = [{ path: 'start_documents/a.pdf', code: 'JVBERi0=', encoding: 'base64' }];
      add(`${f} files(${t})`, { class: 'CompiledPackage', method: 'files', args: [spec({ package: true, ...docs }), { $skillsRoot: f }, documentFiles, frameworks[t], title] },
        async () => {
          const root = skillsRootFor(f);
          try {
            return await P.files(ta({ package: true, ...docs }), root, asPhpArg(documentFiles), asPhpArg(frameworks[t]), title);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        });
    }
    add(`${f} envExample`, { class: 'CompiledPackage', method: 'envExample', args: [spec()] }, () => P.envExample(ta()));
    add(`${f} readme`, { class: 'CompiledPackage', method: 'readme', args: [spec(docs), 'Google ADK'] }, () => P.readme(ta(docs), 'Google ADK'));
  }
}

const results: PhpResult[] = SKIP ? [] : cmpBatch(cases.map((c) => c.php));

cases.forEach((c, i) => {
  test(c.name, async () => {
    const php = results[i];
    let ts: any;
    let err: any = null;
    try {
      ts = await c.ts();
    } catch (e) {
      err = e;
    }
    if (!php.ok) {
      assert.ok(err !== null, `PHP threw "${php.error}", TypeScript did not`);
      assert.equal(err.message, php.error);
      return;
    }
    if (err !== null) throw err;
    assert.equal(asText(ts ?? null), asText(php.result));
  });
});

// ---- analyzeRuntime: the TypeScript one on the analyzer's array (before it), against PHP's
for (const [f, d] of Object.entries(data)) {
  test(`${f} analyzeRuntime`, { skip: SKIP || undefined }, async () => {
    if (d.analyzed !== null && d.adkError === null) {   // (ADK refuses a swarm; analyzeRuntime itself does not)
      assert.equal(asText(d.adk), asText(d.analyzed), 'php_cmp.php builds what ADKGenerator::analyzeWorkflow() builds');
    }
    const sqlite = installSqliteDb();
    for (const s of values<string>(d.sql)) sqlite.exec(s);
    const { db } = require('../src/db/pools');
    const analyzer = { serverIndex: async () => d.index };
    const agents = d.agents;
    const agentRepo = { findById: async (id: number) => (agents && agents[String(id)] ? { toArray: () => agents[String(id)] } : null) };
    let ts: any;
    let err: any = null;
    try {
      ts = await CompiledRuntimeEmit.analyzeRuntime(d.pre, analyzer, db, agentRepo, d.graph, Number(d.workflowId), d.userId);
    } catch (e) {
      err = e;
    }
    if (d.error !== null) {
      assert.ok(err !== null, `PHP threw "${d.error}", TypeScript did not`);
      assert.equal(err.message, d.error);
      return;
    }
    if (err !== null) throw err;
    assert.equal(asText(ts), asText(d.analyzed));
  });
}

test('PHP side available', { skip: SKIP || undefined }, () => {
  assert.ok(Object.keys(data).length >= 8, `analyzable fixtures: ${Object.keys(data).join(', ')}`);
});
