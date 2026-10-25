/**
 * Port of backend/tests/Unit/MafParityTest.php -- MAF gets what ADK has: MCP headers, code nodes, decision routing,
 * run events, a listening package. The NOOA half of testANodeNamedLikeAModuleDoesNotShadowIt belongs to the NOOA
 * port; only MAF runs here. Both cases are also differential against PHP's MAFGenerator on the same arrays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { CODE_NODE_HARNESS_PATH, CompiledRuntimeEmit } from '../src/AgentTeam/compiler/CompiledRuntimeEmit';
import { deepCopy, json_encode, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, jsonDecodeAssoc } from '../src/AgentTeam/compiler/php';
import { phpSkipReason } from './support/phpCompiler';
import { cmpBatch, cmpWf64, withKeys } from './support/phpCmp';
import { codeAnalyzed, noPython, pyCompile } from './support/mafAnalyses';
import { execLines } from './support/lgFixturesB';

const NO_PHP = phpSkipReason() || false;
const RUNNER_PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

/** A TypeScript-built PHP array as php_cmp.php's json_decode(..., true) receives it. */
const forPhp = (a: any): any => JSON.parse(json_encode(a, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

test('testMcpClientWithHeadersForACodeOnlyWorkflow', { skip: noPython() }, () => {
  const code = MAFGenerator.emitMaf(codeAnalyzed());
  assert.ok(code.includes('MCP_SERVER_SLUGS = {\n    "http://localhost:8770": "outlook"'));
  assert.ok(code.includes('var = f"MCP_HEADERS_{slug.upper()}"'));
  assert.ok(code.includes('for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):'));
  assert.equal(pyCompile(code)[0], 0);
});

test('the code-only program is byte-identical to PHP', { skip: NO_PHP }, () => {
  const a = codeAnalyzed();
  const [php] = cmpBatch([{ class: 'MAFGenerator', method: 'emitMaf', args: [forPhp(a)] }]);
  assert.ok(php.ok, `PHP threw ${php.error}`);
  assert.equal(MAFGenerator.emitMaf(jsonDecodeAssoc(JSON.stringify(forPhp(a)))), php.result);
});

/** wf64 with its dispatcher (node 2) named "time": its module would be agents/time.py. */
function timeAnalyzed(wf64: any): { set: Record<string, any>; a: any } {
  const agents = deepCopy(wf64.agents);
  agents['2'].name = 'time';
  const set = { agents: JSON.parse(json_encode(agents, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)), package: true };
  return { set, a: withKeys(wf64, set) };
}

/** Review I2: a node named like a stdlib module ("time") must not shadow it in workflow.py (MAF package). */
test('testANodeNamedLikeAModuleDoesNotShadowIt', { skip: NO_PHP || (!existsSync(RUNNER_PY) ? 'runner venv missing' : false) }, () => {
  const { a } = timeAnalyzed(cmpWf64());
  const [workflow, common, nodes] = MAFGenerator.packageFiles(a);
  const dir = mkdtempSync(path.join(tmpdir(), 'mafp_'));
  try {
    mkdirSync(path.join(dir, 'agents'), { recursive: true });
    writeFileSync(path.join(dir, 'workflow.py'), workflow);
    writeFileSync(path.join(dir, 'common.py'), common + '\n' + CompiledRuntimeEmit.packageCommonBlock());
    for (const f of nodes) writeFileSync(path.join(dir, f.path), f.code);
    writeFileSync(path.join(dir, 'code_harness.py'), readFileSync(CODE_NODE_HARNESS_PATH, 'utf8'));
    const [rc, out] = execLines([RUNNER_PY, '-W', 'ignore', '-c', 'import workflow; print(workflow.time.sleep.__name__)'],
      { ANTHROPIC_API_KEY: 'x' }, { cwd: dir });
    assert.equal(rc, 0, 'MAFGenerator\n' + out.join('\n'));
    assert.equal(out.at(-1), 'sleep', 'MAFGenerator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packageFiles of the "time" package is byte-identical to PHP', { skip: NO_PHP }, () => {
  const { set, a } = timeAnalyzed(cmpWf64());
  const [php] = cmpBatch([{ class: 'MAFGenerator', method: 'packageFiles', args: [{ $wf64: true, set }] }]);
  assert.ok(php.ok, `PHP threw ${php.error}`);
  assert.deepEqual(MAFGenerator.packageFiles(a), php.result);
});
