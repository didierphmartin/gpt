/**
 * The NVIDIA NOOA compile target (src/AgentTeam/NOOAGenerator.ts), ported from backend/tests/Unit/:
 * NOOAPackageTest, NooaGeneratorCompileTest, NooaGeneratorEmitTest, the NOOA case of EmittedMcpEndpointTest, and the
 * NOOA cases of CompiledA2ATest / CompiledArchitectureDocTest that tests/CompiledEmitUnit.test.ts could not port
 * (they need the generator). Test titles are the PHP method names.
 *
 * Differential where the PHP test builds its own analysis: the TypeScript emitNooa() / a2aPackage() of the same
 * input must equal backend/'s (tests/fixtures/compiler/php_cmp.php), generation stamps masked. The dispatcher demo
 * (DispatcherDemoFixture in PHP) is the tests/fixtures/compiler/dispatcher_demo.json fixture.
 * python3-dependent checks skip without python3, as in PHP.
 */
import './support/fakeDb';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { fileMap, maskStamps, phpSkipReason } from './support/phpCompiler';
import { asPhpArg, cmpBatch, cmpWf64, withKeys, type PhpCall } from './support/phpCmp';
import { fixtureTargetCompile } from './support/compilerFixture';
import { preg_quote, values } from '../src/AgentTeam/compiler/php';
import { CompiledRuntimeEmit } from '../src/AgentTeam/compiler/CompiledRuntimeEmit';
import { WorkflowView } from '../src/AgentTeam/compiler/WorkflowView';
import { NOOAGenerator } from '../src/AgentTeam/NOOAGenerator';

const PHP_SKIP = phpSkipReason() || undefined;
const PY_SKIP = spawnSync('python3', ['--version']).status === 0 ? undefined : 'python3 not on PATH';

/** `python3 -m py_compile` of a source: [exit code, output]. */
function pyCompile(code: string, suffix = 'test'): [number, string] {
  const dir = mkdtempSync(path.join(tmpdir(), `nooa_${suffix}_`));
  const file = path.join(dir, `nooa_${suffix}.py`);
  writeFileSync(file, code);
  const r = spawnSync('python3', ['-m', 'py_compile', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return [r.status ?? 1, (r.stdout ?? '') + (r.stderr ?? '')];
}

// ----------------------------------------------------------------------------------------------------------------
// The hand-built analyses of NooaGeneratorEmitTest / NooaGeneratorCompileTest (JS literals in PHP's array shape)
// ----------------------------------------------------------------------------------------------------------------

/** Minimal analyzed shape: start -> A(claude) -> output. */
function analyzed(): any {
  return {
    workflow: { id: 7, name: 'Demo Flow' },
    byId: {
      '1': { id: '1', type: 'start', config: [] },
      '2': { id: '2', type: 'agent', config: [] },
      '3': { id: '3', type: 'output', config: [] },
    },
    layers: [['1'], ['2'], ['3']],
    parents: { '2': ['1'], '3': ['2'] },
    startNodeId: '1',
    agents: {
      '2': { name: 'A', systemPrompt: 'You are A.', provider: 'claude',
        model: 'claude-sonnet-4-6', temperature: null, max_tokens: null,
        tools: [], skill_content: '', skills: [], documents: [] },
    },
    usedCatalog: [], usedServers: [],
    startPrompt: 'Analyze example.com', startDocuments: [],
    outputStorageEnabled: false, outputFolder: null,
  };
}

/** Diamond: start -> (A || B) -> C -> output. */
function diamond(): any {
  return {
    workflow: { id: 9, name: 'Diamond' },
    byId: {
      '1': { id: '1', type: 'start', config: [] },
      '2': { id: '2', type: 'agent', config: [] },
      '3': { id: '3', type: 'agent', config: [] },
      '4': { id: '4', type: 'agent', config: [] },
      '5': { id: '5', type: 'output', config: [] },
    },
    layers: [['1'], ['2', '3'], ['4'], ['5']],
    parents: { '2': ['1'], '3': ['1'], '4': ['2', '3'], '5': ['4'] },
    startNodeId: '1',
    agents: {
      '2': { name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', temperature: null, max_tokens: null, tools: [], skill_content: '', skills: [], documents: [] },
      '3': { name: 'B', systemPrompt: 'B', provider: 'openai', model: 'gpt-4o', temperature: null, max_tokens: null, tools: [], skill_content: '', skills: [], documents: [] },
      '4': { name: 'C', systemPrompt: 'C', provider: 'gemini', model: 'gemini-2.5-flash', temperature: null, max_tokens: null, tools: [], skill_content: '', skills: [], documents: [] },
    },
    usedCatalog: [], usedServers: [], startPrompt: 'go', startDocuments: [],
    outputStorageEnabled: true, outputFolder: null,
  };
}

/** testMcpEmission's analysis. */
function mcpAnalyzed(): any {
  const a = analyzed();
  a.usedServers = { 'https://mcp.example/mcp': { name: 'Example Server' } };
  a.usedCatalog = { web_search: {
    server_url: 'https://mcp.example/mcp', tool_name: 'web_search',
    input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } };
  a.agents['2'].tools = ['mcp_web_search'];   // runtime prefix must be stripped
  return a;
}

/** testMcpUrlTriedAsGivenThenWithMcp's analysis. */
function vectorAnalyzed(): any {
  const a = analyzed();
  a.usedServers = { 'https://vector.example.com': { name: 'Vector' } };
  a.usedCatalog = { find: { server_url: 'https://vector.example.com', tool_name: 'find', input_schema: {} } };
  a.agents['2'].tools = ['find'];
  return a;
}

const QUERY_URL = 'http://localhost/servicenow/?profile=mock&toolset=jobs';

/** testMcpQueryUrlKeepsItsQuery's analysis. */
function queryAnalyzed(): any {
  const a = analyzed();
  a.usedServers = { [QUERY_URL]: { name: 'ServiceNow' } };
  a.usedCatalog = { poll_jobs: { server_url: QUERY_URL, tool_name: 'poll_jobs', input_schema: {} } };
  a.agents['2'].tools = ['poll_jobs'];
  return a;
}

/** testMcpEndpointUrlIsBakedAsIs's analysis. */
function endpointAnalyzed(): any {
  const a = analyzed();
  a.usedServers = { 'https://mcp.example/mcp': { name: 'Example Server' } };
  a.usedCatalog = { web_search: { server_url: 'https://mcp.example/mcp', tool_name: 'web_search', input_schema: {} } };
  a.agents['2'].tools = ['web_search'];
  return a;
}

function skillAnalyzed(): any {
  const a = analyzed();
  a.agents['2'].skills = [{ dir: 'html' }];
  return a;
}

/** NooaGeneratorCompileTest's variants of the diamond. */
function diamondMcp(): any {
  const a = diamond();
  a.usedServers = { 'https://mcp.example/mcp': { name: 'Example Server' } };
  a.usedCatalog = { web_search: {
    server_url: 'https://mcp.example/mcp', tool_name: 'web_search',
    input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } };
  a.agents['2'].tools = ['web_search'];
  return a;
}

function diamondSkill(): any {
  const a = diamond();
  a.agents['4'].skills = [{ dir: 'html' }];   // consolidator renders HTML
  return a;
}

function diamondDocs(): any {
  const a = diamond();
  a.startDocuments = [{ name: 'Spec', path: '/tmp/spec.docx' }];
  return a;
}

const CASES: Record<string, () => any> = {
  analyzed, diamond, mcpAnalyzed, vectorAnalyzed, queryAnalyzed, endpointAnalyzed, skillAnalyzed, diamondMcp, diamondSkill, diamondDocs,
};

/** The TypeScript emitNooa() of a case. */
const emit = (name: string): string => NOOAGenerator.emitNooa(asPhpArg(CASES[name]()));

/** backend/'s NOOAGenerator::emitNooa() of every case, and the A2A package of wf64 without code nodes, in one PHP process. */
const PHP: Record<string, any> = {};
if (!PHP_SKIP) {
  const names = Object.keys(CASES);
  const calls: PhpCall[] = names.map((n) => ({ class: 'NOOAGenerator', method: 'emitNooa', args: [CASES[n]()] }));
  calls.push({ class: 'NOOAGenerator', method: 'a2aPackage', args: [{ $wf64: true, set: { code: [] } }] });
  calls.push({ class: 'NOOAGenerator', method: 'skillBlockForTest', args: [] });
  calls.push({ class: 'NOOAGenerator', method: 'mcpEndpointFn', args: [] });
  const res = cmpBatch(calls);
  names.forEach((n, i) => (PHP[n] = res[i]));
  PHP.a2aWf64 = res[names.length];
  PHP.skillBlock = res[names.length + 1];
  PHP.mcpEndpointFn = res[names.length + 2];
}

test('emitNooa: TypeScript === PHP on every hand-built analysis', { skip: PHP_SKIP }, () => {
  for (const name of Object.keys(CASES)) {
    assert.ok(PHP[name].ok, `PHP emitNooa(${name}) threw: ${PHP[name].error}`);
    assert.equal(maskStamps(emit(name)), maskStamps(PHP[name].result), name);
  }
});

test('skillBlockForTest and mcpEndpointFn: TypeScript === PHP', { skip: PHP_SKIP }, () => {
  assert.equal(NOOAGenerator.skillBlockForTest(), PHP.skillBlock.result);
  assert.equal((NOOAGenerator as any).mcpEndpointFn(), PHP.mcpEndpointFn.result);
});

// ---- NooaGeneratorEmitTest

test('testHeaderImportsAndFactory', () => {
  const code = emit('analyzed');
  assert.ok(code.includes('from nooa import Agent'));
  assert.ok(code.includes('from nooa.unifiedllm.registry import get_llm_client'));
  assert.ok(code.includes('def make_llm(provider'));
  assert.ok(code.includes('load_dotenv('));
  // Provider table parity with the MAF backend.
  assert.ok(code.includes('https://api.x.ai/v1'));
  assert.ok(code.includes('https://generativelanguage.googleapis.com/v1beta/openai/'));
  assert.ok(code.includes('https://api.moonshot.ai/v1'));
});

test('testDeepSeekFlashGetsV4ThinkingRules', () => {
  assert.ok(emit('analyzed').includes('elif p == "deepseek" and str(model).startswith(("deepseek-v4", "deepseek-flash")):'));
});

test('testNodeClassEmitted', () => {
  const code = emit('analyzed');
  assert.ok(code.includes('class A(Agent, llm=make_llm("claude", "claude-sonnet-4-6"'));
  assert.ok(code.includes('"You are A."'));          // docstring = system prompt
  assert.ok(code.includes('async def respond(self, prompt: str) -> str:'));
  assert.ok(code.includes('AGENTS = {'));
  assert.ok(code.includes('async def run_agent('));
  assert.ok(code.includes('Original user request:'));
});

test('testDriverAndGlobals', () => {
  const code = emit('analyzed');
  assert.ok(code.includes('async def run_workflow(prompt: str, session: str | None = None) -> str:'));
  assert.ok(code.includes('DEFAULT_PROMPT = "Analyze example.com"'));
  assert.ok(code.includes('WORKFLOW_ID = 7'));
  assert.ok(code.includes('OUTPUT_STORAGE_ENABLED = False'));
  assert.ok(code.includes('asyncio.run(run_workflow('));
  // Linear graph: one node per layer (GRAPH is the canvas as data; the driver runs each layer).
  assert.match(code, /"layers": \[\s*\[\s*"2"\s*\]\s*\]/);
  // No MCP, no skills in this fixture.
  assert.ok(!code.includes('MCPManager'));
  assert.ok(!code.includes('_run_skill_script'));
});

test('testMcpEmission', () => {
  const code = emit('mcpAnalyzed');
  assert.ok(code.includes('from nooa.mcp import MCPManager'));
  assert.ok(code.includes('from datetime import timedelta'));
  assert.ok(code.includes('MCP_SERVERS = {'));
  assert.ok(code.includes('MCPManager.create_from_server('));
  assert.ok(code.includes('transport="streamable-http"'));
  assert.ok(code.includes('mcp_0 = MCP["https://mcp.example/mcp"]'));
  assert.ok(code.includes('Tools selected for this node: web_search'));
});

test('testMcpUrlTriedAsGivenThenWithMcp', () => {
  const code = emit('vectorAnalyzed');
  // MCPManager does no URL normalization: the endpoint is probed at import, after MCP_URL_<SLUG>
  // (a moved server) is applied -- the URL as given first, then with /mcp in its path -- and
  // the server's headers come from MCP_HEADERS_<SLUG>.
  assert.ok(code.includes('url=_mcp_endpoint("https://vector.example.com"),'));
  assert.ok(code.includes('def _mcp_endpoint(server_url: str) -> str:'));
  assert.ok(code.includes('headers=_mcp_headers("https://vector.example.com"),'));
  // The dict key stays the raw catalog URL (agent attrs look it up verbatim).
  assert.ok(code.includes('MCP["https://vector.example.com"]'));
});

test('testMcpQueryUrlKeepsItsQuery', () => {
  const code = emit('queryAnalyzed');
  // The candidates come from the live URL at import (MCP_URL_<SLUG> may move the server);
  // _mcp_candidates puts /mcp into the path, before the query.
  assert.ok(code.includes('url=_mcp_endpoint("' + QUERY_URL + '"),'));
  assert.ok(code.includes('path + "/mcp" + rest'));
});

test('testMcpEndpointUrlIsBakedAsIs', () => {
  const code = emit('endpointAnalyzed');
  assert.ok(code.includes('url=_mcp_endpoint("https://mcp.example/mcp"),'));
  // A path already ending in /mcp is the endpoint: one candidate, nothing to probe.
  assert.ok(code.includes('if path.endswith("/mcp") or path.endswith(".php"):'));
});

test('testSkillRuntimeEmittedWhenSkillPresent', () => {
  const code = emit('skillAnalyzed');
  assert.ok(code.includes('class SkillStepAgent(Agent):'));
  assert.ok(code.includes('async def run_skill('));
  assert.ok(code.includes('def _run_skill_script('));   // shared FS layer
  assert.ok(code.includes('_LAST_SKILL_OUTPUTS'));
  assert.ok(code.includes('SYNERGYAI_OUTPUT_DIR'));
  assert.ok(code.includes('"dir": "html"'));            // baked into AGENTS
  // run_agent gains the mandatory skill loop.
  assert.ok(code.includes('text = await run_skill(_skill, text, request, ad)'));
  // Regression guard: the NOOA runtime must never pull in LangChain.
  const block = NOOAGenerator.skillBlockForTest();
  assert.ok(!block.includes('langchain'));
  assert.ok(!block.includes('StructuredTool'));
});

test('testNoSkillRuntimeWhenNoSkills', () => {
  const code = emit('analyzed');
  assert.ok(!code.includes('SkillStepAgent'));
  assert.ok(!code.includes('run_skill('));
  assert.ok(!code.includes('def _run_skill_script('));
});

test('testDiamondParallelLayer', () => {
  const code = emit('diamond');
  // B and C share a layer: the driver gathers the reached nodes of a layer.
  assert.match(code, /"layers": \[\s*\[\s*"2",\s*"3"\s*\]/);
  assert.ok(code.includes('await asyncio.gather(*(run_node(nid) for nid in ready))'));
  assert.ok(code.includes('text = await run_agent(nid, parent_texts, prompt)'));
  assert.ok(code.includes('OUTPUT_STORAGE_ENABLED = True'));
  assert.ok(code.includes('WORKFLOW_ID = 9'));
});

// ---- NooaGeneratorCompileTest

for (const [title, name] of [['testDiamondCompiles', 'diamond'], ['testMcpFixtureCompiles', 'diamondMcp'],
  ['testSkillFixtureCompiles', 'diamondSkill'], ['testStartDocumentsFixtureCompiles', 'diamondDocs']] as const) {
  test(title, { skip: PY_SKIP }, () => {
    const [rc, out] = pyCompile(emit(name), name);
    assert.equal(rc, 0, `${name} NOOA failed py_compile:\n${out}`);
  });
}

// ---- NOOAPackageTest (DispatcherDemoFixture = the dispatcher_demo.json fixture)

/** The package files of the "Dispatcher demo" workflow: path => code. */
async function demoFiles(): Promise<Record<string, string>> {
  const r = await fixtureTargetCompile('dispatcher_demo.json', 'nooa', 'modular');
  assert.ok(r.ok, r.error);
  return fileMap(r.result);
}

test('testExposesTheContract', async () => {
  assert.ok((await demoFiles())['workflow.py'].includes('async def run_workflow(prompt: str, session: str | None = None) -> str:'));
});

test('testEmitsThePackageFiles', async () => {
  const paths = Object.keys(await demoFiles()).sort();
  // the run server and script, plus the folder's own files (CompiledPackage); agents in separate files
  for (const p of ['.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py', 'agents/human_resources.py',
    'agents/it_claims.py', 'agents/techbuddy.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py']) {
    assert.ok(paths.includes(p), `missing ${p} in ${paths.join(', ')}`);
  }
  // Beyond PHP's DispatcherDemoFixture, the dispatcher_demo.json fixture has a playbook node ("Playbook HR") and binds
  // the html skill: its module and the skills/ files are the only other files.
  for (const p of paths) {
    assert.ok(p.startsWith('skills/') || p === 'agents/playbook_hr.py' || ['.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py',
      'agents/human_resources.py', 'agents/it_claims.py', 'agents/techbuddy.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py'].includes(p), p);
  }
});

/**
 * Spec §9: NOOA is batch-only, permanently. A workflow whose orchestration is "swarm" makes generate() throw,
 * from workflowRepo.findById() alone, before the graph is ever read.
 */
test('testSwarmIsStillRefused', async () => {
  const gen = new NOOAGenerator(
    { findById: async () => WorkflowView.fromRecord({ id: 1, user_id: '1', name: 'Swarm Fixture', orchestration: 'swarm' }) },
    { getGraph: async () => { throw new Error('the graph is never read'); } },
    { findById: async () => null },
  );
  await assert.rejects(gen.generate(1), /NOOA cannot compile/);
});

// ---- CompiledA2ATest::testPackageFiles (nooa)

test('testPackageFiles (nooa)', { skip: PHP_SKIP }, async () => {
  const a = withKeys(cmpWf64(), { code: [] });
  const pkg = await NOOAGenerator.a2aPackage(a);
  assert.equal(pkg.root, 'wf64_nooa_a2a');
  const files: Record<string, string> = {};
  for (const f of values(pkg.files)) files[(f as any).path] = (f as any).code;
  for (const p of ['orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt']) {
    assert.ok(p in files, `nooa: ${p}`);
  }
  assert.ok(files['requirements.txt'].includes('a2a-sdk[http-server]>=1.1,<2'));
  assert.ok(files['orchestrator.py'].includes('class AgentSupervisor'));
  assert.ok(files['servers/2_d.py'].includes('async def run_node(request_text: str, trace) -> dict:'));
  if (!PY_SKIP) {
    for (const p of ['orchestrator.py', 'api.py', 'servers/2_d.py']) {
      assert.equal(pyCompile(files[p], 'a2a')[0], 0, `nooa ${p}`);
    }
  }
  // Differential: backend/'s NOOAGenerator::a2aPackage() of the same analysis.
  assert.ok(PHP.a2aWf64.ok, PHP.a2aWf64.error);
  const want = fileMap(PHP.a2aWf64.result);
  const got = fileMap(pkg);
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const p of Object.keys(want)) assert.equal(maskStamps(got[p]), maskStamps(want[p]), p);
  assert.equal(maskStamps(String(pkg.architecture)), maskStamps(String(PHP.a2aWf64.result.architecture)));
});

// ---- CompiledArchitectureDocTest (nooa cases, on the real compile of the dispatcher demo)

async function compile(mode: 'single' | 'modular' | 'a2a'): Promise<any> {
  const r = await fixtureTargetCompile('dispatcher_demo.json', 'nooa', mode);
  assert.ok(r.ok, r.error);
  return r.result;
}

for (const mode of ['single', 'modular', 'a2a'] as const) {
  test(`testEveryStructureCarriesItsArchitecture (nooa ${mode})`, async () => {
    const r = await compile(mode);
    const doc = String(r.architecture);
    assert.ok(doc.startsWith('# Dispatcher demo: architecture'));
    for (const section of ['## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram', '```mermaid\nflowchart LR',
      '## Classes and functions', '## How a run flows', '## How to change it']) {
      assert.ok(doc.includes(section), `${mode}: ${section}`);
    }
    if (mode !== 'single') {
      const last = values(r.files).at(-1) as any;
      assert.equal(last.path, 'ARCHITECTURE.md', 'written beside the code, last');
      assert.equal(last.code, doc);
    }
  });

  test(`testItDescribesOnlyWhatTheCodeDefines (nooa ${mode})`, async () => {
    const r = await compile(mode);
    const code = r.files !== undefined ? values(r.files).map((f: any) => f.code).join('\n') : r.code;
    const described = [...String(r.architecture).matchAll(/^### `([A-Za-z_]+)`/gm)].map((m) => m[1]);
    assert.ok(described.length > 0);
    for (const name of described) {
      const re = new RegExp('^\\s*(?:async\\s+def|def|class)\\s+' + preg_quote(name, '/') + '\\b|^' + preg_quote(name, '/') + '\\s*=', 'm');
      assert.match(code, re, `${mode}: ${name} is described but not defined`);
    }
    // every file the table names is a file of the compile
    const paths = r.files !== undefined ? values(r.files).map((f: any) => f.path) : [r.filename];
    for (const m of String(r.architecture).matchAll(/^\| `([^`]+)` \|/gm)) {
      if (!m[1].endsWith('/')) {
        assert.ok(paths.includes(m[1]) || (mode === 'single' && m[1] === r.filename), `${mode}: ${m[1]}`);
      }
    }
  });
}

// ---- EmittedMcpEndpointTest::testNooaProbePicksTheAnsweringEndpointLive

const VENV_PY = path.join(homedir(), 'Documents/synergyAI/python/.venv/bin/python');

function liveSkipReason(): string | undefined {
  const up = spawnSync('curl', ['-s', '-o', '/dev/null', '-I', '-w', '%{http_code}', '--connect-timeout', '2', 'http://localhost/servicenow/'], { encoding: 'utf8' });
  let exec = false;
  try {
    accessSync(VENV_PY, constants.X_OK);
    exec = existsSync(VENV_PY);
  } catch {
    exec = false;
  }
  return (up.stdout ?? '000').trim() !== '000' && up.status === 0 && exec ? undefined : 'needs the connector at localhost/servicenow and the runner venv';
}

test('testNooaProbePicksTheAnsweringEndpointLive', { skip: liveSkipReason() }, () => {
  const fn: string = (NOOAGenerator as any).mcpEndpointFn();
  // _mcp_candidates as the shared compiled runtime emits it; the live URL and headers stubbed.
  const m = /^def _mcp_candidates\([\s\S]*?(?=^\S)/m.exec(CompiledRuntimeEmit.mcpClientBlock([]));
  assert.ok(m);
  const prelude = 'import httpx\n' + m[0] + '\n_mcp_live_url = lambda u: u\n'
    + "_mcp_headers = lambda u: {'Accept': 'application/json, text/event-stream'}\n";
  const dir = mkdtempSync(path.join(tmpdir(), 'nooaprobe_'));
  const file = path.join(dir, 'probe.py');
  writeFileSync(file, prelude + fn + "\nprint(_mcp_endpoint('http://localhost/servicenow/?profile=mock&toolset=jobs'))"
    + "\nprint(_mcp_endpoint('http://localhost/servicenow?profile=mock&toolset=jobs'))\n");
  const r = spawnSync(VENV_PY, [file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter((l) => l !== '');
  assert.equal(r.status, 0, out.join('\n'));
  assert.deepEqual(out, [
    'http://localhost/servicenow/?profile=mock&toolset=jobs',      // answers as given
    'http://localhost/servicenow/mcp?profile=mock&toolset=jobs',   // 301 as given -> the /mcp form
  ]);
});

