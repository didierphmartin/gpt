/**
 * The MAF cases of backend/tests/Unit/CompiledA2ATest.php (testPackageFiles) and CompiledArchitectureDocTest.php
 * (every structure carries its architecture; it describes only what the code defines), which
 * tests/CompiledEmitUnit.test.ts could not port without a MAF generator. The A2A package is also differential:
 * TypeScript's MAFGenerator.a2aPackage() equals PHP's on the same wf64 analysis (generation stamps masked).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { preg_quote } from '../src/AgentTeam/compiler/php';
import { maskStamps, phpSkipReason } from './support/phpCompiler';
import { cmpBatch, cmpWf64, withKeys } from './support/phpCmp';
import { fixtureTargetCompile } from './support/compilerFixture';
import { pyCompile } from './support/mafAnalyses';
import { python3 } from './support/lgFixturesB';

const NO_PHP = phpSkipReason() || false;
const wf64 = NO_PHP ? null : cmpWf64();

// ---- CompiledA2ATest (maf)

test('testPackageFiles (maf)', { skip: NO_PHP }, async () => {
  const pkg = await MAFGenerator.a2aPackage(withKeys(wf64, { code: [] }));
  assert.equal(pkg.root, 'wf64_maf_a2a');
  const paths = pkg.files.map((f: any) => f.path);
  for (const p of ['orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt']) {
    assert.ok(paths.includes(p), `maf: ${p}`);
  }
  const files: Record<string, string> = {};
  for (const f of pkg.files) files[f.path] = f.code;
  assert.ok(files['requirements.txt'].includes('a2a-sdk[http-server]>=1.1,<2'));
  assert.ok(files['orchestrator.py'].includes('class AgentSupervisor'));
  assert.ok(files['servers/2_d.py'].includes('async def run_node(request_text: str, trace) -> dict:'));
  if (python3() !== null) {   // MafParityTest::pyCompile needs python3
    for (const p of ['orchestrator.py', 'api.py', 'servers/2_d.py']) {
      assert.equal(pyCompile(files[p])[0], 0, `maf ${p}`);
    }
  }
});

test('the wf64 A2A package is byte-identical to PHP', { skip: NO_PHP }, async () => {
  const [php] = cmpBatch([{ class: 'MAFGenerator', method: 'a2aPackage', args: [{ $wf64: true, set: { code: [] } }] }]);
  assert.ok(php.ok, `PHP threw ${php.error}`);
  const ts = await MAFGenerator.a2aPackage(withKeys(wf64, { code: [] }));
  assert.equal(ts.root, php.result.root);
  assert.deepEqual(ts.files.map((f: any) => f.path), php.result.files.map((f: any) => f.path));
  for (let i = 0; i < ts.files.length; i++) {
    assert.equal(maskStamps(ts.files[i].code), maskStamps(php.result.files[i].code), ts.files[i].path);
  }
  assert.equal(maskStamps(String(ts.architecture)), maskStamps(String(php.result.architecture)));
});

// ---- CompiledArchitectureDocTest (maf): the Dispatcher demo (workflow 44) in each code structure

for (const mode of ['single', 'modular', 'a2a'] as const) {
  test(`testEveryStructureCarriesItsArchitecture (maf ${mode})`, async () => {
    const c = await fixtureTargetCompile('dispatcher_demo', 'maf', mode);
    assert.ok(c.ok, c.error);
    const r = c.result;
    const doc = String(r.architecture);
    assert.ok(doc.startsWith('# Dispatcher demo: architecture'));
    for (const section of ['## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram', '```mermaid\nflowchart LR',
      '## Classes and functions', '## How a run flows', '## How to change it']) {
      assert.ok(doc.includes(section), `${mode}: ${section}`);
    }
    if (mode !== 'single') {
      const last = r.files.at(-1);
      assert.equal(last.path, 'ARCHITECTURE.md', 'written beside the code, last');
      assert.equal(last.code, doc);
    }
  });

  test(`testItDescribesOnlyWhatTheCodeDefines (maf ${mode})`, async () => {
    const c = await fixtureTargetCompile('dispatcher_demo', 'maf', mode);
    assert.ok(c.ok, c.error);
    const r = c.result;
    const code: string = r.files !== undefined ? r.files.map((f: any) => f.code).join('\n') : r.code;
    const names = [...String(r.architecture).matchAll(/^### `([A-Za-z_]+)`/gm)].map((m) => m[1]);
    assert.ok(names.length > 0);
    for (const name of names) {
      const q = preg_quote(name, '/');
      assert.match(code, new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${q}\\b|^${q}\\s*=`, 'm'), `${mode}: ${name} is described but not defined`);
    }
    // every file the table names is a file of the compile
    const tabled = [...String(r.architecture).matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    const paths: string[] = r.files !== undefined ? r.files.map((f: any) => f.path) : [r.filename];
    for (const p of tabled) {
      if (!p.endsWith('/')) {
        assert.ok(paths.includes(p) || (mode === 'single' && p === r.filename), `${mode}: ${p}`);
      }
    }
  });
}
