/**
 * Port of backend/tests/Unit/MafGeneratorCompileTest.php: the MAF program of a diamond workflow (and its skill and
 * MCP variants) is valid Python (python3 -m py_compile; skipped without python3, as in PHP). Also differential: the
 * TypeScript emitMaf() output is byte-identical to PHP's on the same arrays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { phpSkipReason } from './support/phpCompiler';
import { asPhpArg, cmpBatch } from './support/phpCmp';
import { diamondAnalyzed, noPython, pyCompile, withMcp } from './support/mafAnalyses';

const NO_PHP = phpSkipReason() || false;

function skillAnalyzed(): any {
  const a = diamondAnalyzed();
  a.agents['4'].skills = [{ dir: 'html' }];   // consolidator renders HTML
  return a;
}

const emit = (a: any): string => MAFGenerator.emitMaf(asPhpArg(a));

test('testDiamondCompiles', { skip: noPython() }, () => {
  const [rc, out] = pyCompile(emit(diamondAnalyzed()));
  assert.equal(rc, 0, `Diamond MAF failed py_compile:\n${out}`);
});

test('testSkillFixtureCompiles', { skip: noPython() }, () => {
  const [rc, out] = pyCompile(emit(skillAnalyzed()));
  assert.equal(rc, 0, `Skill MAF failed py_compile:\n${out}`);
});

test('testMcpFixtureCompiles', { skip: noPython() }, () => {
  const [rc, out] = pyCompile(emit(withMcp(diamondAnalyzed())));
  assert.equal(rc, 0, `MCP MAF failed py_compile:\n${out}`);
});

test('the diamond, skill and MCP programs are byte-identical to PHP', { skip: NO_PHP }, () => {
  const cases: Record<string, any> = { diamond: diamondAnalyzed(), skill: skillAnalyzed(), mcp: withMcp(diamondAnalyzed()) };
  const names = Object.keys(cases);
  const php = cmpBatch(names.map((n) => ({ class: 'MAFGenerator', method: 'emitMaf', args: [cases[n]] })));
  names.forEach((n, i) => {
    assert.ok(php[i].ok, `${n}: PHP threw ${php[i].error}`);
    assert.equal(emit(cases[n]), php[i].result, `${n}: emitMaf differs from PHP`);
  });
});
