/**
 * Every compile target, TypeScript vs PHP: each fixture in tests/fixtures/compiler/ is compiled by every target
 * (LangGraph, Google ADK, Microsoft Agent Framework, NVIDIA NOOA) in every code structure (single file, agents in
 * separate files, A2A), by backend/'s generators (php_compile.php targets, no MySQL) and by src/AgentTeam/'s on the
 * same in-memory database, repositories, skills and documents -- as WorkflowController calls them. The generated
 * file maps must be byte-identical (generation stamps masked), or both must refuse with the same message.
 *
 * A fixture that only re-states another one with different options ({"extends", "options"}) is covered by that
 * one here: the mode, not the fixture, picks the structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, fileMap, maskStamps, phpSkipReason, phpTargets } from './support/phpCompiler';
import { MODES, TARGETS, fixtureTargetCompile } from './support/compilerFixture';

/** Where two texts first differ: line number and both lines. */
function firstDiff(got: string, want: string): string {
  const g = got.split('\n');
  const w = want.split('\n');
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) {
      return `line ${i + 1} (TS ${g.length} lines, PHP ${w.length})\n  TS : ${JSON.stringify(g[i])}\n  PHP: ${JSON.stringify(w[i])}`;
    }
  }
  return 'same lines, different bytes';
}

/** Compares a TypeScript result with PHP's; throws on the first difference. */
function assertSameResult(ts: { ok: boolean; result?: any; error?: string }, php: { ok: boolean; result?: any; error?: string }): void {
  if (!php.ok) {
    assert.equal(ts.ok ? null : ts.error, php.error, 'both refuse with the same message');
    return;
  }
  assert.equal(ts.ok ? null : ts.error, null, `TypeScript threw: ${ts.error}`);
  const want = fileMap(php.result);
  const got = fileMap(ts.result);
  assert.deepEqual(Object.keys(got), Object.keys(want), 'same files, same order');
  for (const p of Object.keys(want)) {
    const a = maskStamps(got[p]);
    const b = maskStamps(want[p]);
    if (a !== b) assert.fail(`${p} differs from PHP: ${firstDiff(a, b)}`);
  }
  assert.deepEqual(Object.keys(ts.result), Object.keys(php.result), 'same result keys, same order');
  if (php.result.files === undefined) {
    assert.equal(ts.result.filename, php.result.filename);
  } else {
    assert.equal(ts.result.root, php.result.root);
    for (let i = 0; i < php.result.files.length; i++) {
      assert.equal(ts.result.files[i].encoding ?? null, php.result.files[i].encoding ?? null, `${php.result.files[i].path} encoding`);
    }
  }
  if ((php.result.architecture ?? null) !== null) {
    assert.equal(maskStamps(String(ts.result.architecture ?? '')), maskStamps(String(php.result.architecture)), 'architecture');
  }
}

const OPTION_ONLY = new Set(['extends', 'options', 'description']);
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .filter((f) => {
    const fx = JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'));
    return fx.extends === undefined || Object.keys(fx).some((k) => !OPTION_ONLY.has(k));
  })
  .sort();
const skip = phpSkipReason();

for (const name of fixtures) {
  test(`compile targets parity: ${name}`, { skip: skip || false }, async (t) => {
    const php = phpTargets(name);
    for (const target of TARGETS) {
      for (const mode of MODES) {
        await t.test(`${target} ${mode}`, async () => {
          assertSameResult(await fixtureTargetCompile(name, target, mode), php[target][mode]);
        });
      }
    }
  });
}
