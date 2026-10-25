/**
 * Port of backend/tests/Unit/ADKPackageTest.php: generatePackage() of DispatcherDemoFixture's workflow (in-memory
 * SQLite and repositories -- never a configured database) and ADKPackage's files for a code-node workflow. The
 * package is also compared, file by file, with backend/'s generatePackage() of the same fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { ADKPackage } from '../src/AgentTeam/compiler/ADKPackage';
import { asPhpArg } from './support/phpCmp';
import { maskStamps, phpSkipReason } from './support/phpCompiler';
import { execPy, python3 } from './support/lgFixtures';
import { codeAnalyzed } from './support/adkAnalyses';
import { compile, dispatcherDemo, filesOf, phpCompile } from './support/memoryFixture';

const PHP_SKIP = phpSkipReason() || undefined;
const PY_SKIP = python3() === null ? 'python3 not found on PATH' : undefined;

/** generatePackage() of the "Dispatcher demo" workflow. */
async function pkg(): Promise<any> {
  const r = await compile(dispatcherDemo(), ADKGenerator, 'modular');
  assert.ok(r.ok, r.error);
  return r.result;
}

test('testEmitsThePackageFiles', async () => {
  const paths = (await pkg()).files.map((f: any) => f.path).sort();
  // the run server and script, plus the folder's own files (ADKPackage)
  assert.deepEqual(paths, ['.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py', 'agents/human_resources.py', 'agents/it_claims.py',
    'agents/techbuddy.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py']);   // agents in separate files
});

test('the package is backend\'s, file by file', { skip: PHP_SKIP }, async () => {
  const want = phpCompile(dispatcherDemo(), 'adk', 'modular');
  assert.ok(want.ok, want.error);
  const got = filesOf(await pkg());
  const exp = filesOf(want.result);
  assert.deepEqual(Object.keys(got), Object.keys(exp));
  for (const p of Object.keys(exp)) assert.equal(maskStamps(got[p]), maskStamps(exp[p]), p);
});

test('testWorkflowExposesTheContract', async () => {
  const files = filesOf(await pkg());
  assert.ok(files['workflow.py'].includes('async def run_workflow(prompt: str, session: str | None = None) -> str:'));
});

test('testTheCliEntryStillExists', async () => {
  // The single-file download is the only way to run this outside the editor; packaging must not remove it.
  const files = filesOf(await pkg());
  assert.ok(files['workflow.py'].includes('if __name__ == "__main__":'));
});

test('testApiPyImportsTheContract', async () => {
  const files = filesOf(await pkg());
  assert.ok(files['api.py'].includes('from workflow import run_workflow'));
});

/** run_workflow()'s own body: from its def to the next top-level statement. */
function runWorkflowBody(wf: string): string {
  const at = wf.indexOf('async def run_workflow(');
  const m = /\n(?=\S)/g;
  m.lastIndex = at + 1;
  const hit = m.exec(wf)!;
  return wf.slice(at, hit.index);
}

test('testSavingStaysOutOfRunWorkflow', async () => {
  // A conversational turn (POST /runs -> run_workflow) must not write a file per prompt: saving belongs
  // to the CLI and the listener's runs (run_once), never to run_workflow itself.
  const wf = filesOf(await pkg())['workflow.py'];
  assert.ok(!runWorkflowBody(wf).includes('OUTPUT_STORAGE_ENABLED'), 'saving leaked into run_workflow');
  assert.ok(wf.includes('saved = _save_output(output)'));
});

test('testRunWorkflowDoesNotPreStripTheDocument', async () => {
  // The editor extracts the document from the answer itself; stripping in run_workflow would lose any
  // narration around it, and with two documents the non-greedy regex would keep only the first.
  const wf = filesOf(await pkg())['workflow.py'];
  assert.equal(wf.split('<!doctype html').length - 1, 1);
  assert.ok(!runWorkflowBody(wf).includes('<!doctype html'), 'document extraction leaked into run_workflow');
});

/** A workflow with a code node on an MCP server, as the package emits it. */
async function codePackage(): Promise<Record<string, string>> {
  const a = codeAnalyzed();
  a['package'] = true;
  const files: Record<string, string> = {};
  for (const f of await ADKPackage.files(a, tmpdir())) files[f.path] = f.code;
  files['workflow.py'] = ADKGenerator.emitAdk(a);
  return files;
}

test('testCodeNodePackageCarriesItsOwnFiles', async () => {
  const f = await codePackage();
  assert.equal(f['code/2_c.py'], "def run(input, call_tool):\n    return {'output': {'got': input}}\n");
  assert.equal(f['code_harness.py'], readFileSync(path.resolve(__dirname, '../../frontend/assets/py/code_node_harness.py'), 'utf8'));
  assert.ok(f['requirements.txt'].includes('fastapi\ngoogle-adk\nhttpx\nlitellm\npython-dotenv\nuvicorn\n'));
  assert.ok(f['.env.example'].includes('MCP_URL_OUTLOOK=http://localhost:8770'));
  assert.ok(f['.env.example'].includes('# MCP_HEADERS_OUTLOOK='));
  assert.ok(f['.env.example'].includes('reads .env from its own folder first, then from the folder two levels up'));
});

test('testPackageWorkflowReadsItsCodeFromTheFolder', async () => {
  const wf = (await codePackage())['workflow.py'];
  assert.ok(wf.includes('source_file="code/2_c.py"'));
  assert.ok(wf.includes('import code_harness as CODE_HARNESS'));
  assert.ok(!wf.includes('CODE_HARNESS_SOURCE'));
  assert.ok(wf.includes('os.path.join(PACKAGE_DIR, "outputs")'));
  const single = ADKGenerator.emitAdk(codeAnalyzed());
  assert.ok(!single.includes('source_file="'));
});

test('testPackageRunsFromItsOwnFolder', { skip: PY_SKIP }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adkpkg_'));
  for (const [p, code] of Object.entries(await codePackage())) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), code);
  }
  // the folder's own modules import, and its code file is the one read (no ADK needed for this check)
  const r = execPy('python3', ['-c', "import code_harness, ast; ast.parse(open('workflow.py').read()); print(code_harness.check_code(open('code/2_c.py').read()))"], { cwd: dir });
  assert.equal(r.rc, 0, r.text);
});

/** Review I4: a playbook node runs the shared interpreter (langchain + langgraph): the package installs it. */
test('testPlaybookPackageRequiresTheInterpreter', async () => {
  const a = codeAnalyzed();
  a['playbooks'] = asPhpArg({ 7: { provider: 'claude', display: 'P', actions: [] } });
  const req = (await ADKPackage.files(a, tmpdir())).find((f: any) => f.path === 'requirements.txt').code;
  for (const p of ['langchain-core', 'langgraph', 'langchain-anthropic']) {
    assert.ok(req.trim().split('\n').includes(p), p);
  }
});
