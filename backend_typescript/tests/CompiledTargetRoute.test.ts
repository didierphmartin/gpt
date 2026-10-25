/**
 * GET /workflows/{id}/generate-adk | generate-maf | generate-nooa (WorkflowController.compiledTargetResponse), as
 * PHP's controller answers them: the code structure the query names (?modular=1 or ?package=1, ?a2a=1, a2a
 * winning), ?download=1 for the single file only, ?format=zip for every structure ("<workflow>_<target>_<mode>.zip",
 * entries under one folder), and the auth / id / access errors. Includes the port of
 * backend/tests/Unit/Controllers/CompiledTargetZipExportTest.php.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fixtureGenerator, loadFixture } from './support/compilerFixture';
import { phpSkipReason, phpTargets } from './support/phpCompiler';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { WorkflowView } from '../src/AgentTeam/compiler/WorkflowView';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';

const TARGETS: Array<[string, string]> = [['adk', 'generateAdk'], ['maf', 'generateMaf'], ['nooa', 'generateNooa']];
const NO_PY = (() => {
  try {
    execFileSync('python3', ['-c', 'pass']);
    return false;
  } catch {
    return 'python3 not available';
  }
})();

function controllerFor(fixture: string, access = true): { c: any; cleanup: () => void } {
  const { cleanup: dropSkills } = fixtureGenerator(fixture); // installs the fixture's database
  const fx = loadFixture(fixture);
  // The controller reads skills from the default root (~/Documents/synergyAI/skills): point HOME at a
  // temporary one holding the fixture's skills, never the developer's own.
  const home = mkdtempSync(path.join(tmpdir(), 'cthome_'));
  for (const [dir, files] of Object.entries<any>(fx.skills ?? {})) {
    for (const [rel, text] of Object.entries<any>(files)) {
      const p = path.join(home, 'Documents/synergyAI/skills', dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, String(text));
    }
  }
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const c: any = new WorkflowController();
  c.workflowRepository = {
    canUserAccess: async () => access,
    findById: async () => WorkflowView.fromRecord(fx.workflow),
  };
  const components = fx.code_components ?? {};
  c.graphRepository = { getGraph: async () => StartOptionGraph.expand(fx.graph, (id: number) => components[String(id)] ?? null) };
  c.getUserStorageFolder = async () => 'user_3';
  return {
    c,
    cleanup: () => {
      process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
      dropSkills();
    },
  };
}

const ctx = (query: Record<string, string>, userId: number | null = 3, id = '44'): any => ({
  method: 'GET', uri: '', headers: {}, query, body: {}, user_id: userId, auth_type: 'jwt', params: { id }, remote_addr: '',
});

function zipNames(bytes: Buffer): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctzip_'));
  try {
    const f = path.join(dir, 'x.zip');
    writeFileSync(f, bytes);
    const out = execFileSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print("\\n".join(z.namelist()))', f], { encoding: 'utf8' });
    return out.trim().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [target, method] of TARGETS) {
  test(`${target}: single file JSON {filename, code, architecture}; ?download=1 the raw script`, async () => {
    const { c, cleanup } = controllerFor('dispatcher_demo');
    try {
      const r: any = await c[method](ctx({}));
      assert.equal(r.status_code, 200);
      assert.equal(r.success, true);
      assert.deepEqual(Object.keys(r.data), ['filename', 'code', 'architecture']);
      assert.equal(r.data.filename, `dispatcher_demo_${target}.py`);
      assert.ok(r.data.architecture.length > 0);
      const d: any = await c[method](ctx({ download: '1' }));
      assert.equal(typeof d.raw_body, 'string');
      assert.equal(d.headers['Content-Type'], 'text/x-python; charset=utf-8');
      assert.equal(d.headers['Content-Disposition'], `attachment; filename="dispatcher_demo_${target}.py"`);
    } finally {
      cleanup();
    }
  });

  test(`${target}: ?modular=1 / ?package=1 a package, ?a2a=1 the A2A folder (a2a wins); download=1 ignored`, async () => {
    const { c, cleanup } = controllerFor('dispatcher_demo');
    try {
      const m: any = await c[method](ctx({ modular: '1', download: '1' }));
      assert.equal(m.status_code, 200);
      assert.deepEqual(Object.keys(m.data), ['root', 'files', 'architecture']);
      assert.equal(m.data.root, `dispatcher_demo_${target}`);
      assert.ok(m.data.files.some((f: any) => f.path === 'workflow.py'));
      const p: any = await c[method](ctx({ package: '1' }));
      assert.equal(p.data.root, `dispatcher_demo_${target}`);
      const notPackage: any = await c[method](ctx({ package: '0' }));   // PHP's empty('0'): the single file
      assert.equal(notPackage.data.filename, `dispatcher_demo_${target}.py`);
      const a: any = await c[method](ctx({ modular: '1', a2a: '1' }));
      assert.equal(a.data.root, `dispatcher_demo_${target}_a2a`);
      assert.ok(a.data.files.some((f: any) => f.path === 'orchestrator.py'));
    } finally {
      cleanup();
    }
  });

  test(`${target}: the response data are PHP's generation results`, { skip: phpSkipReason() || false }, async () => {
    const php = phpTargets('dispatcher_demo');
    const { c, cleanup } = controllerFor('dispatcher_demo');
    try {
      for (const [mode, q] of [['single', {}], ['modular', { modular: '1' }], ['a2a', { a2a: '1' }]] as const) {
        const r: any = await c[method](ctx(q));
        const want = php[target][mode].result;
        assert.deepEqual(Object.keys(r.data), Object.keys(want), `${mode} keys`);
        if (mode === 'single') assert.equal(r.data.filename, want.filename);
        else assert.deepEqual(r.data.files.map((f: any) => f.path), want.files.map((f: any) => f.path), `${mode} files`);
      }
    } finally {
      cleanup();
    }
  });

  // CompiledTargetZipExportTest
  test(`testSingleFileZip (${target})`, { skip: NO_PY }, async () => {
    const { c, cleanup } = controllerFor('dispatcher_demo');
    try {
      const r: any = await c[method](ctx({ format: 'zip', download: '1' }));
      assert.equal(r.headers['Content-Type'], 'application/zip');
      assert.equal(r.headers['Content-Disposition'], `attachment; filename="dispatcher_demo_${target}_single.zip"`);
      assert.equal(r.headers['Content-Length'], String(r.raw_body.length));
      // the script and its ARCHITECTURE.md, as LangGraph's single-file zip
      assert.deepEqual(zipNames(r.raw_body), [`dispatcher_demo_${target}/dispatcher_demo_${target}.py`, `dispatcher_demo_${target}/ARCHITECTURE.md`]);
    } finally {
      cleanup();
    }
  });

  test(`testModularZipHoldsThePackage (${target})`, { skip: NO_PY }, async () => {
    const { c, cleanup } = controllerFor('dispatcher_demo');
    try {
      const pkg: any = await c[method](ctx({ modular: '1' }));
      const r: any = await c[method](ctx({ modular: '1', format: 'zip' }));
      assert.equal(r.headers['Content-Disposition'], `attachment; filename="dispatcher_demo_${target}_modular.zip"`);
      assert.deepEqual(zipNames(r.raw_body), pkg.data.files.map((f: any) => `dispatcher_demo_${target}/${f.path}`));
      const a: any = await c[method](ctx({ a2a: '1', format: 'zip' }));
      assert.equal(a.headers['Content-Disposition'], `attachment; filename="dispatcher_demo_${target}_a2a.zip"`);
      assert.ok(zipNames(a.raw_body).includes(`dispatcher_demo_${target}_a2a/orchestrator.py`));
    } finally {
      cleanup();
    }
  });

  test(`${target}: auth, id and access errors; a generator refusal is a 500 with its message`, async () => {
    const { c, cleanup } = controllerFor('code_nodes', true);
    try {
      assert.deepEqual(await c[method](ctx({}, null)), { success: false, error: 'Authentication required', status_code: 401 });
      assert.deepEqual(await c[method](ctx({}, 3, '0')), { success: false, error: 'Workflow ID is required', status_code: 400 });
      const refused: any = await c[method](ctx({ a2a: '1' }));
      assert.equal(refused.status_code, 500);
      assert.equal(refused.success, false);
      assert.match(refused.error, /^Code nodes are not supported by the A2A packaging yet\./);
    } finally {
      cleanup();
    }
    const denied = controllerFor('dispatcher_demo', false);
    try {
      assert.deepEqual(await denied.c[method](ctx({})), { success: false, error: 'Workflow not found or access denied', status_code: 404 });
    } finally {
      denied.cleanup();
    }
  });
}
