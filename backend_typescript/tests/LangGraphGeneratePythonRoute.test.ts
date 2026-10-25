/**
 * GET /workflows/{id}/generate-python (WorkflowController.generatePython), as PHP's controller answers it: the
 * layout options (?modular=1, ?a2a=1, a2a winning), ?download=1 for the single file, ?format=zip for every
 * layout (entries under one folder, "<workflow>_<mode>.zip"), and the auth / access errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fixtureGenerator, loadFixture } from './support/compilerFixture';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { WorkflowView } from '../src/AgentTeam/compiler/WorkflowView';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';

function controllerFor(fixture: string, access = true): { c: WorkflowController; cleanup: () => void } {
  const { cleanup: dropSkills } = fixtureGenerator(fixture); // installs the fixture's database
  const fx = loadFixture(fixture);
  // The controller reads skills from the default root (~/Documents/synergyAI/skills): point HOME at a
  // temporary one holding the fixture's skills, never the developer's own.
  const home = mkdtempSync(path.join(tmpdir(), 'lghome_'));
  for (const [dir, files] of Object.entries<any>(fx.skills ?? {})) {
    for (const [rel, text] of Object.entries<any>(files)) {
      const p = path.join(home, 'Documents/synergyAI/skills', dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, String(text));
    }
  }
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    dropSkills();
  };
  const c: any = new WorkflowController();
  c.workflowRepository = {
    canUserAccess: async () => access,
    findById: async () => WorkflowView.fromRecord(fx.workflow),
  };
  c.graphRepository = { getGraph: async () => StartOptionGraph.expand(fx.graph, () => null) };
  c.getUserStorageFolder = async () => 'user_3';
  return { c, cleanup };
}

const ctx = (query: Record<string, string>, userId: number | null = 3, id = '44'): any => ({
  method: 'GET', uri: '', headers: {}, query, body: {}, user_id: userId, auth_type: 'jwt', params: { id }, remote_addr: '',
});

function zipNames(bytes: Buffer): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'lgzip_'));
  try {
    const f = path.join(dir, 'x.zip');
    writeFileSync(f, bytes);
    const out = execFileSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print("\\n".join(z.namelist()))', f], { encoding: 'utf8' });
    return out.trim().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('single file: JSON {filename, code, architecture}; ?download=1 the raw script', async () => {
  const { c, cleanup } = controllerFor('dispatcher_demo');
  try {
    const r: any = await c.generatePython(ctx({}));
    assert.equal(r.status_code, 200);
    assert.equal(r.data.filename, 'dispatcher_demo_langgraph.py');
    assert.ok(r.data.code.startsWith('"""Standalone LangGraph workflow: Dispatcher demo'));
    assert.ok(r.data.architecture.length > 0);
    const d: any = await c.generatePython(ctx({ download: '1' }));
    assert.equal(d.raw_body, r.data.code.replace(/Generated: {2}[^\n]*/, d.raw_body.match(/Generated: {2}[^\n]*/)[0]));
    assert.equal(d.headers['Content-Type'], 'text/x-python; charset=utf-8');
    assert.equal(d.headers['Content-Disposition'], 'attachment; filename="dispatcher_demo_langgraph.py"');
  } finally {
    cleanup();
  }
});

test('modular and A2A: a JSON manifest (a2a wins when both are set); download=1 is ignored', async () => {
  const { c, cleanup } = controllerFor('dispatcher_demo');
  try {
    const m: any = await c.generatePython(ctx({ modular: '1', download: '1' }));
    assert.equal(m.data.root, 'dispatcher_demo_modular');
    assert.equal(m.data.files.at(-1).path, 'ARCHITECTURE.md');
    const a: any = await c.generatePython(ctx({ modular: '1', a2a: '1' }));
    assert.equal(a.data.root, 'dispatcher_demo_a2a');
    assert.deepEqual(a.data.files.slice(0, 2).map((f: any) => f.path), ['orchestrator.py', 'api.py']);
  } finally {
    cleanup();
  }
});

test('?format=zip: every layout as one zip under its folder, named <workflow>_<mode>.zip', async () => {
  const { c, cleanup } = controllerFor('dispatcher_demo');
  try {
    const single: any = await c.generatePython(ctx({ format: 'zip', download: '1' }));
    assert.equal(single.headers['Content-Type'], 'application/zip');
    assert.equal(single.headers['Content-Disposition'], 'attachment; filename="dispatcher_demo_single.zip"');
    assert.equal(single.headers['Content-Length'], String(single.raw_body.length));
    assert.deepEqual(zipNames(single.raw_body), ['dispatcher_demo_langgraph/dispatcher_demo_langgraph.py', 'dispatcher_demo_langgraph/ARCHITECTURE.md']);
    const mod: any = await c.generatePython(ctx({ format: 'zip', modular: '1' }));
    assert.equal(mod.headers['Content-Disposition'], 'attachment; filename="dispatcher_demo_modular.zip"');
    const names = zipNames(mod.raw_body);
    assert.ok(names.includes('dispatcher_demo_modular/workflow.py'));
    assert.ok(names.includes('dispatcher_demo_modular/skills/html/SKILL.md'));
    assert.ok(names.every((n) => n.startsWith('dispatcher_demo_modular/')));
    const a2a: any = await c.generatePython(ctx({ format: 'zip', a2a: '1' }));
    assert.equal(a2a.headers['Content-Disposition'], 'attachment; filename="dispatcher_demo_a2a.zip"');
    assert.ok(zipNames(a2a.raw_body).includes('dispatcher_demo_a2a/orchestrator.py'));
  } finally {
    cleanup();
  }
});

test('a swarm zip drops the _modular_swarm suffix; base64 entries are written as bytes', () => {
  const r: any = WorkflowController.langGraphZipResponse(
    { root: 'trip_modular_swarm', files: [{ path: 'a.py', code: 'x' }, { path: 'img.png', code: Buffer.from([0x89, 0x50, 0xff]).toString('base64'), encoding: 'base64' }] },
    'modular',
  );
  assert.equal(r.headers['Content-Disposition'], 'attachment; filename="trip_modular.zip"');
  assert.deepEqual(zipNames(r.raw_body), ['trip_modular_swarm/a.py', 'trip_modular_swarm/img.png']);
  const dir = mkdtempSync(path.join(tmpdir(), 'lgzip_'));
  try {
    writeFileSync(path.join(dir, 'x.zip'), r.raw_body);
    const hex = execFileSync('python3', ['-c', 'import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read("trip_modular_swarm/img.png").hex())', path.join(dir, 'x.zip')], { encoding: 'utf8' }).trim();
    assert.equal(hex, '8950ff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth, id and access errors; a generator refusal is a 500 with its message', async () => {
  const { c, cleanup } = controllerFor('code_nodes', true);
  try {
    assert.deepEqual(await c.generatePython(ctx({}, null)), { success: false, error: 'Authentication required', status_code: 401 });
    assert.deepEqual(await c.generatePython(ctx({}, 3, '0')), { success: false, error: 'Workflow ID is required', status_code: 400 });
    const refused: any = await c.generatePython(ctx({ a2a: '1' }));
    assert.equal(refused.status_code, 500);
    assert.match(refused.error, /^Code nodes are not supported by the A2A packaging yet\./);
  } finally {
    cleanup();
  }
  const denied = controllerFor('dispatcher_demo', false);
  try {
    assert.deepEqual(await denied.c.generatePython(ctx({})), { success: false, error: 'Workflow not found or access denied', status_code: 404 });
  } finally {
    denied.cleanup();
  }
});
