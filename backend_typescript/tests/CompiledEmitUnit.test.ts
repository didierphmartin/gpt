/**
 * The parts of backend/tests/Unit/CompiledA2ATest.php, CompiledArchitectureDocTest.php and CompiledRunServerTest.php
 * that need no full ADK / MAF / NOOA generator, on the TypeScript Compiled* emitters (src/AgentTeam/compiler/).
 * The analyses come from PHP (tests/fixtures/compiler/php_cmp.php): AdkCodeNodeTest::wf64Analyzed() and the
 * dispatcher demo (workflow 44).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phpSkipReason } from './support/phpCompiler';
import { cmpAnalyzed, cmpWf64, withKeys } from './support/phpCmp';
import { entries, keysOf, oarr, preg_quote, values } from '../src/AgentTeam/compiler/php';
import { CompiledA2AEmit } from '../src/AgentTeam/compiler/CompiledA2AEmit';
import { CompiledArchitectureDoc } from '../src/AgentTeam/compiler/CompiledArchitectureDoc';
import { CompiledRuntimeEmit } from '../src/AgentTeam/compiler/CompiledRuntimeEmit';

const SKIP = phpSkipReason() || undefined;
const wf64 = SKIP ? null : cmpWf64();
const demo = SKIP ? null : cmpAnalyzed('dispatcher_demo.json').analyzed;
const TITLES: Record<string, string> = { adk: 'Google ADK', maf: 'Microsoft Agent Framework', nooa: 'NVIDIA NOOA' };

// ---- CompiledA2ATest

test('layout gives one server per node on consecutive ports', { skip: SKIP }, () => {
  const l = CompiledA2AEmit.layout(withKeys(wf64));
  // wf64Analyzed has one dispatcher agent (2); its code nodes are not A2A nodes
  assert.deepEqual(keysOf(l), ['2']);
  assert.equal(l['2'].file, 'servers/2_d.py');
  assert.equal(l['2'].port, 8701);
  assert.equal(l['2'].kind, 'dispatcher');
  assert.deepEqual(l['2'].menu, [['3', 'A'], ['4', 'B']]);
});

test('code nodes are refused with LangGraph\'s message', { skip: SKIP }, () => {
  assert.throws(() => CompiledA2AEmit.refuse(withKeys(wf64)), /Code nodes are not supported by the A2A packaging yet\./);
});

test('a Start option is refused', { skip: SKIP }, () => {
  const a = withKeys(wf64, { code: [], triggerNodeId: '10' });
  assert.throws(() => CompiledA2AEmit.refuse(a), /A Start option \(an event or schedule trigger\) needs the single-file or modular format/);
});

for (const [target, title] of Object.entries(TITLES)) {
  test(`package files (${target}): orchestrator, api, workflow, common, one server per node`, { skip: SKIP }, () => {
    const a = withKeys(wf64, { code: [] });
    const runNode = 'async def run_node(request_text: str, trace) -> dict:\n    return {"text": request_text}\n';
    const runNodes = oarr(keysOf(CompiledA2AEmit.layout(a)).map((nid) => [nid, runNode] as [string, string]));
    const pkg = CompiledA2AEmit.package(a, ['W = 1\n', 'C = 1\n', []], runNodes, [{ path: 'requirements.txt', code: 'a2a-sdk[http-server]>=1.1,<2\n' }],
      `wf64_${target}_a2a`, title);
    assert.equal(pkg.root, `wf64_${target}_a2a`);
    const files: Record<string, string> = {};
    for (const f of pkg.files) files[f.path] = f.code;
    for (const p of ['orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt']) {
      assert.ok(p in files, `${target}: ${p}`);
    }
    assert.match(files['orchestrator.py'], /class AgentSupervisor/);
    assert.match(files['servers/2_d.py'], /async def run_node\(request_text: str, trace\) -> dict:/);
    assert.match(files['servers/2_d.py'], /def _a2a_pick\(reply: str, menu: list\) -> tuple:/, 'a dispatcher server carries the dispatcher helpers');
    assert.match(files['orchestrator.py'], new RegExp(`-- ${title}\\.`));
  });
}

// ---- CompiledRunServerTest (the A2A manifest's run server)

test('the A2A api.py carries the same run server', { skip: SKIP }, () => {
  const api = CompiledA2AEmit.api(withKeys(demo), 'Google ADK');
  assert.ok(api.startsWith('"""Run server for workflow "Dispatcher demo" (A2A, Google ADK)'));
  for (const needle of ['@app.post("/runs")', '@app.get("/runs/{run_id}/events")', '@app.get("/.well-known/workflow.json")',
    'AgentSupervisor', 'from orchestrator import run as run_workflow']) {
    assert.ok(api.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!api.includes('Authorization'), 'the run server has no auth');
});

test('the package common.py holds the event sink, run records, live feed and console view', { skip: SKIP }, () => {
  const common = CompiledRuntimeEmit.packageCommonBlock();
  assert.ok(common.startsWith('"""Shared by workflow.py and api.py:'));
  for (const needle of ['def set_event_sink', 'def resolve_gate', 'class RunRecorder', 'class ConsoleView']) {
    assert.ok(common.includes(needle), `missing: ${needle}`);
  }
  const withRuntime = CompiledRuntimeEmit.packageCommonWithRuntime(['"""Runtime."""\nimport os\n', 'X = 1']);
  assert.ok(withRuntime.startsWith('"""Runtime."""\nimport os\n\nimport json, os, re'), 'the runtime docstring first, the shared docstring dropped');
  assert.ok(withRuntime.endsWith('__all__ = [n for n in dir() if not n.startswith("__")]   # agents/ and workflow.py import it all (_ names too)\n'));
});

// ---- CompiledArchitectureDocTest (on synthetic compile results: the catalog lookup, the sections, the files table)

/** Code that defines every other catalog name of the target, and the result of a compile carrying it. */
function compileLike(target: string, mode: string): any {
  const names = Object.keys((CompiledArchitectureDoc as any).catalog(target));
  const code = names.map((n, i) => (i % 2 === 0 ? `def ${n}(x):\n    return x` : `# ${n} is mentioned only`)).join('\n\n');
  if (mode === 'single') return { filename: 'dispatcher_demo.py', code };
  const files = [{ path: 'workflow.py', code: 'from common import *\n' }, { path: 'common.py', code }, { path: 'api.py', code: '' },
    { path: 'requirements.txt', code: '' }, { path: 'skills/html/SKILL.md', code: '' }];
  for (const [, m] of entries(CompiledRuntimeEmit.moduleLayout(withKeys(demo)))) files.push({ path: (m as any).file, code: 'NODE = {}\n' });
  if (mode === 'a2a') {
    files.push({ path: 'orchestrator.py', code: 'class AgentSupervisor:\n    pass\n' });
    for (const [, e] of entries(CompiledA2AEmit.layout(withKeys(demo)))) files.push({ path: (e as any).file, code: 'class NodeExecutor:\n    pass\n' });
  }
  return { root: 'dispatcher_demo', files };
}

for (const target of Object.keys(TITLES)) {
  for (const mode of ['single', 'modular', 'a2a']) {
    test(`${target} ${mode}: every structure carries its architecture`, { skip: SKIP }, () => {
      const r = CompiledArchitectureDoc.attach(compileLike(target, mode), withKeys(demo), target, mode);
      const doc = String(r.architecture);
      assert.ok(doc.startsWith('# Dispatcher demo: architecture'));
      for (const section of ['## Files', '## Class diagram', '```mermaid\nclassDiagram', '## Workflow diagram', '```mermaid\nflowchart LR',
        '## Classes and functions', '## How a run flows', '## How to change it']) {
        assert.ok(doc.includes(section), `${mode}: ${section}`);
      }
      if (mode !== 'single') {
        const last = values(r.files).at(-1) as any;
        assert.equal(last.path, 'ARCHITECTURE.md', 'written beside the code, last');
        assert.equal(last.code, doc);
      }
    });

    test(`${target} ${mode}: it describes only what the code defines`, { skip: SKIP }, () => {
      const input = compileLike(target, mode);
      const r = CompiledArchitectureDoc.attach(input, withKeys(demo), target, mode);
      const code = r.files !== undefined ? values(r.files).map((f: any) => f.code).join('\n') : r.code;
      const described = [...String(r.architecture).matchAll(/^### `([A-Za-z_]+)`/gm)].map((m) => m[1]);
      assert.ok(described.length > 0);
      for (const name of described) {
        const re = new RegExp('^\\s*(?:async\\s+def|def|class)\\s+' + preg_quote(name, '/') + '\\b|^' + preg_quote(name, '/') + '\\s*=', 'm');
        assert.match(code, re, `${mode}: ${name} is described but not defined`);
      }
      // every file the table names is a file of the compile
      const paths = r.files !== undefined ? values(r.files).map((f: any) => f.path) : [r.filename];
      for (const m of String(r.architecture).matchAll(/^\| `([^`]+)` \|/gm)) {
        if (!m[1].endsWith('/')) {
          assert.ok(paths.includes(m[1]) || (mode === 'single' && m[1] === r.filename), `${mode}: ${m[1]}`);
        }
      }
    });
  }
}

test('an ingestion pipeline gets no ARCHITECTURE.md', { skip: SKIP }, () => {
  const byId = JSON.parse(JSON.stringify({ '1': { id: '1', node_type: 'loader', config: { type: 'loader' } } }));
  const r = CompiledArchitectureDoc.attach({ filename: 'x.py', code: 'X = 1' }, withKeys(demo, { byId }), 'adk', 'single');
  assert.equal(r.architecture, null);
  assert.equal(r.code, 'X = 1');
});
