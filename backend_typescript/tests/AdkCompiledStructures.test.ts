/**
 * The ADK cases of backend/tests/Unit/CompiledA2ATest.php and CompiledArchitectureDocTest.php that need the full
 * generator (tests/CompiledEmitUnit.test.ts ports the rest): ADKGenerator::a2aPackage() of wf64Analyzed(), and the
 * ARCHITECTURE.md of DispatcherDemoFixture's workflow in each code structure. Both are also compared with backend/'s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { preg_quote } from '../src/AgentTeam/compiler/php';
import { maskStamps, phpCall, phpSkipReason } from './support/phpCompiler';
import { pyCompile, python3 } from './support/lgFixtures';
import { wf64Analyzed } from './support/adkAnalyses';
import { compile, dispatcherDemo, phpCompile, type Mode } from './support/memoryFixture';

const PHP_SKIP = phpSkipReason() || undefined;
const PY_SKIP = python3() === null ? 'python3 not found on PATH' : undefined;

// ---- CompiledA2ATest

test('testCodeNodesAreRefusedWithLangGraphsMessage', async () => {
  await assert.rejects(ADKGenerator.a2aPackage(wf64Analyzed()), { message: /Code nodes are not supported by the A2A packaging yet\./ });
});

test('testPackageFiles (adk)', async () => {
  const a = wf64Analyzed();
  a['code'] = [];
  const pkg = await ADKGenerator.a2aPackage(a);
  assert.equal(pkg.root, 'wf64_adk_a2a');
  const paths = pkg.files.map((f: any) => f.path);
  for (const p of ['orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt']) {
    assert.ok(paths.includes(p), p);
  }
  const files: Record<string, string> = {};
  for (const f of pkg.files) files[f.path] = f.code;
  assert.ok(files['requirements.txt'].includes('a2a-sdk[http-server]>=1.1,<2'));
  assert.ok(files['orchestrator.py'].includes('class AgentSupervisor'));
  assert.ok(files['servers/2_d.py'].includes('async def run_node(request_text: str, trace) -> dict:'));
  if (!PY_SKIP) {
    for (const p of ['orchestrator.py', 'api.py', 'servers/2_d.py']) {
      assert.equal(pyCompile(files[p]).rc, 0, `adk ${p}`);
    }
  }
});

test('a2aPackage() is backend\'s ADKGenerator::a2aPackage(), file by file', { skip: PHP_SKIP }, async () => {
  const a = wf64Analyzed();
  a['code'] = [];
  const got = await ADKGenerator.a2aPackage(a);
  const want = phpCall('ADKGenerator', 'a2aPackage', [a]);
  assert.equal(got.root, want.root);
  assert.deepEqual(got.files.map((f: any) => f.path), want.files.map((f: any) => f.path));
  for (let i = 0; i < want.files.length; i++) {
    assert.equal(maskStamps(got.files[i].code), maskStamps(want.files[i].code), want.files[i].path);
  }
  assert.equal(maskStamps(got.architecture), maskStamps(want.architecture));
});

test('the refusals are backend\'s (swarm, code nodes over A2A, a Start option over A2A)', { skip: PHP_SKIP }, async () => {
  const swarm = dispatcherDemo();
  swarm.workflow.orchestration = 'swarm';
  for (const mode of ['single', 'modular', 'a2a'] as Mode[]) {
    const got = await compile(swarm, ADKGenerator, mode);
    const want = phpCompile(swarm, 'adk', mode);
    assert.equal(want.ok, false);
    assert.equal(got.error, want.error);
  }
  let phpMessage = 'no refusal';
  try {
    phpCall('ADKGenerator', 'a2aPackage', [wf64Analyzed()]);
  } catch (e: any) {
    phpMessage = String(e.message).replace(/^ADKGenerator::a2aPackage threw: /, '');
  }
  assert.equal(await ADKGenerator.a2aPackage(wf64Analyzed()).catch((e) => e.message), phpMessage);
});

// ---- CompiledArchitectureDocTest (adk)

const results = new Map<Mode, any>();
async function compiled(mode: Mode): Promise<any> {
  if (!results.has(mode)) {
    const r = await compile(dispatcherDemo(), ADKGenerator, mode);
    assert.ok(r.ok, r.error);
    results.set(mode, r.result);
  }
  return results.get(mode);
}

for (const mode of ['single', 'modular', 'a2a'] as Mode[]) {
  test(`testEveryStructureCarriesItsArchitecture (adk ${mode})`, async () => {
    const r = await compiled(mode);
    const doc = String(r.architecture);
    assert.ok(doc.startsWith('# Dispatcher demo: architecture'));
    for (const section of ['## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram', '```mermaid\nflowchart LR',
      '## Classes and functions', '## How a run flows', '## How to change it']) {
      assert.ok(doc.includes(section), `${mode}: ${section}`);
    }
    if (mode !== 'single') {
      const last = r.files[r.files.length - 1];
      assert.equal(last.path, 'ARCHITECTURE.md', 'written beside the code, last');
      assert.equal(last.code, doc);
    }
  });

  test(`testItDescribesOnlyWhatTheCodeDefines (adk ${mode})`, async () => {
    const r = await compiled(mode);
    const code = r.files !== undefined ? r.files.map((f: any) => f.code).join('\n') : r.code;
    const names = [...String(r.architecture).matchAll(/^### `([A-Za-z_]+)`/gm)].map((m) => m[1]);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.match(code, new RegExp('^\\s*(?:async\\s+def|def|class)\\s+' + preg_quote(name) + '\\b|^' + preg_quote(name) + '\\s*=', 'm'),
        `${mode}: ${name} is described but not defined`);
    }
    // every file the table names is a file of the compile
    const paths = r.files !== undefined ? r.files.map((f: any) => f.path) : [r.filename];
    for (const m of String(r.architecture).matchAll(/^\| `([^`]+)` \|/gm)) {
      const p = m[1];
      if (!p.endsWith('/')) {
        assert.ok(paths.includes(p) || (mode === 'single' && p === r.filename), `${mode}: ${p}`);
      }
    }
  });

  test(`the ${mode} compile is backend's (DispatcherDemoFixture)`, { skip: PHP_SKIP }, async () => {
    const r = await compiled(mode);
    const want = phpCompile(dispatcherDemo(), 'adk', mode);
    assert.ok(want.ok, want.error);
    assert.deepEqual(Object.keys(r), Object.keys(want.result));
    if (mode === 'single') {
      assert.equal(r.filename, want.result.filename);
      assert.equal(maskStamps(r.code), maskStamps(want.result.code));
    } else {
      assert.equal(r.root, want.result.root);
      assert.deepEqual(r.files.map((f: any) => f.path), want.result.files.map((f: any) => f.path));
      for (let i = 0; i < want.result.files.length; i++) {
        assert.equal(maskStamps(r.files[i].code), maskStamps(want.result.files[i].code), want.result.files[i].path);
      }
    }
    assert.equal(maskStamps(r.architecture), maskStamps(want.result.architecture));
  });
}
