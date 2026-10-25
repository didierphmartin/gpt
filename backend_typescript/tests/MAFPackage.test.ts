/**
 * Port of backend/tests/Unit/MAFPackageTest.php: the package ("agents in separate files") of the Dispatcher demo
 * workflow (tests/fixtures/compiler/dispatcher_demo.json, the twin of DispatcherDemoFixture, in an in-memory SQLite
 * database -- never the configured one) exposes the run-server contract and keeps saving out of run_workflow().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTargetCompile } from './support/compilerFixture';

let cached: Record<string, string> | null = null;

/** The package files of the "Dispatcher demo" workflow, path => code. */
async function files(): Promise<Record<string, string>> {
  if (cached === null) {
    const r = await fixtureTargetCompile('dispatcher_demo', 'maf', 'modular');
    assert.ok(r.ok, r.error);
    cached = {};
    for (const f of r.result.files) cached[f.path] = f.code;
  }
  return cached;
}

/** run_workflow()'s own body: from its def to the next top-level statement. */
function runWorkflowBody(wf: string): string {
  const at = wf.indexOf('async def run_workflow(');
  const re = /\n(?=\S)/g;
  re.lastIndex = at + 1;
  const m = re.exec(wf);
  return wf.substring(at, m!.index);
}

test('testExposesTheContract', async () => {
  assert.ok((await files())['workflow.py'].includes('async def run_workflow(prompt: str, session: str | None = None) -> str:'));
});

test('testRunWorkflowReturnsTheTerminalOutput', async () => {
  const wf = (await files())['workflow.py'];
  assert.ok(wf.includes('_outputs = _result.get_outputs()'));
  assert.ok(wf.includes('return _text'));
});

test('testSavingStaysOutOfRunWorkflow', async () => {
  // A conversational turn (POST /runs -> run_workflow) must not write a file per prompt: saving belongs
  // to the CLI and the listener's runs (run_once), never to run_workflow itself.
  const wf = (await files())['workflow.py'];
  assert.ok(!runWorkflowBody(wf).includes('OUTPUT_STORAGE_ENABLED'), 'saving leaked into run_workflow');
  assert.ok(wf.includes('saved = _save_output(output)'));
});

test('testRunWorkflowDoesNotPreStripTheDocument', async () => {
  const wf = (await files())['workflow.py'];
  assert.ok(!runWorkflowBody(wf).includes('<!doctype html'), 'document extraction leaked into run_workflow');
});
