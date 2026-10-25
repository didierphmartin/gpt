/**
 * The LangGraph compiler, TypeScript vs PHP: every fixture in tests/fixtures/compiler/ is compiled by
 * backend/'s LangGraphGenerator (php_compile.php, no MySQL) and by src/AgentTeam/LangGraphGenerator.ts on the
 * same in-memory database, repositories and skills; the generated file maps must be byte-identical (the
 * generation time stamps masked) -- or both must refuse with the same message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { FIXTURES, fileMap, maskStamps, phpCompile, phpSkipReason } from './support/phpCompiler';
import { fixtureGenerator } from './support/compilerFixture';

/** Where two texts first differ: line number and both lines (the whole files are too long for an assertion diff). */
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

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'schema.json').sort();
const skip = phpSkipReason();

for (const name of fixtures) {
  test(`LangGraph compile parity: ${name}`, { skip: skip || false }, async () => {
    const php = phpCompile(name);
    const { gen, fx, cleanup } = fixtureGenerator(name);
    let ts: any;
    let tsError: string | null = null;
    try {
      ts = await gen.generate(Number(fx.workflow.id), fx.user_id !== undefined && fx.user_id !== null ? String(fx.user_id) : null, fx.options ?? {});
    } catch (e: any) {
      tsError = e?.message ?? String(e);
    } finally {
      cleanup();
    }
    if (!php.ok) {
      assert.equal(tsError, php.error, 'both refuse with the same message');
      return;
    }
    assert.equal(tsError, null, `TypeScript threw: ${tsError}`);
    const want = fileMap(php.result);
    const got = fileMap(ts);
    assert.deepEqual(Object.keys(got), Object.keys(want), 'same files, same order');
    for (const p of Object.keys(want)) {
      const a = maskStamps(got[p]);
      const b = maskStamps(want[p]);
      if (a !== b) assert.fail(`${p} differs from PHP: ${firstDiff(a, b)}`);
    }
    if (php.result.files === undefined) {
      assert.equal(ts.filename, php.result.filename);
    } else {
      assert.equal(ts.root, php.result.root);
      for (let i = 0; i < php.result.files.length; i++) {
        assert.equal(ts.files[i].encoding ?? null, php.result.files[i].encoding ?? null, `${php.result.files[i].path} encoding`);
      }
    }
  });
}
