/**
 * Twins of backend/tests/Unit/{PythonEmitHelpersTest, PythonEmitHelpersPinTest, RunServerEmitterTest, CodeNodeEmitTest,
 * PlaybookResolveSummaryEmitTest, LangGraphCodeNodeRuntimeTest, EmittedMcpEndpointTest}.php over the TypeScript
 * compiler ports. The python3 checks run the emitted code; they skip when python3 is absent. The two live
 * EmittedMcpEndpointTest cases (a connector at localhost/servicenow + the runner venv) are not ported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PythonEmitHelpers } from '../src/AgentTeam/compiler/PythonEmitHelpers';
import { RunServerEmitter } from '../src/AgentTeam/compiler/RunServerEmitter';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { PlaybookEmit } from '../src/AgentTeam/compiler/PlaybookEmit';
import { CodeNodeEmit } from '../src/AgentTeam/CodeNodeEmit';
import { strlen } from '../src/AgentTeam/compiler/php';

const PY_SKIP = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']).status === 0
  ? '' : 'python3 >= 3.10 is not available';

/** Runs a Python source with python3; returns [exit code, stdout+stderr lines]. */
function runPython(src: string, python = 'python3'): [number, string[]] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'emitpy_'));
  try {
    const file = path.join(dir, 'prog.py');
    writeFileSync(file, src);
    const r = spawnSync(python, [file], { encoding: 'utf8' });
    const out = (r.stdout + r.stderr).split('\n').filter((l, i, a) => !(l === '' && i === a.length - 1));
    return [r.status ?? -1, out];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The dispatcher-branch case builds a WorkflowGraph, whose block imports langgraph. */
const LANGGRAPH_SKIP = PY_SKIP || (spawnSync('python3', ['-c', 'import langgraph']).status === 0 ? '' : 'python3 has no langgraph package');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── PythonEmitHelpersTest ────────────────────────────────────────────────────

test('PythonEmitHelpers: pyStr escapes', () => {
  const out = PythonEmitHelpers.pyStr('line1\nquote"x');
  assert.ok(out.includes('\\n'));
  assert.ok(out.includes('\\"'));
});

test('PythonEmitHelpers: jsonToPython writes None/True/False', () => {
  const out = PythonEmitHelpers.jsonToPython({ a: null, b: true, c: false });
  assert.ok(out.includes('None'));
  assert.ok(out.includes('True'));
  assert.ok(out.includes('False'));
});

// ── PythonEmitHelpersPinTest ─────────────────────────────────────────────────

test('PythonEmitHelpers: pinned blocks (byte length and sha256)', () => {
  const pins: Array<[string, () => string, number, string]> = [
    ['mcpClientBlock', () => PythonEmitHelpers.mcpClientBlock(), 4959, '834b131509dd600011ad0a1002a1fc1e4246076b61f5af4200b16e66f148f0e6'],
    ['skillDepsBlock', () => PythonEmitHelpers.skillDepsBlock(), 2423, '79f69500a85e9aa03f75f4336d93f8913bb954608a18e59885f90207af20948d'],
    ['documentConverterBlock', () => PythonEmitHelpers.documentConverterBlock(), 5500, 'a1bdc4bfe79b93a46c2ae6ca526fd4bac3ca1281576caa4f3643f344e60fc7bf'],
    ['skillFsSyncBlock', () => PythonEmitHelpers.skillFsSyncBlock(), 6017, '7b9543f387e0a7fce98aa2ed74c5304e452ddc9d6c06588ecf93d7adf4d03f50'],
  ];
  for (const [name, fn, len, hash] of pins) {
    const block = fn();
    assert.equal(strlen(block), len, `${name} byte length changed`);
    assert.equal(sha256(block), hash, `${name} content changed`);
  }
});

// ── RunServerEmitterTest ─────────────────────────────────────────────────────

test('RunServerEmitter: emits the run protocol routes', () => {
  const out = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"');
  assert.ok(out.includes('@app.post("/runs")'));
  assert.ok(out.includes('@app.get("/runs/{run_id}/events")'));
  assert.ok(out.includes('@app.get("/.well-known/workflow.json")'));
});

test('RunServerEmitter: listen routes only when asked', () => {
  const withL = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"', true);
  assert.ok(withL.includes('@app.post("/listen")'));
  assert.ok(withL.includes('@app.get("/live")'));
  assert.ok(withL.includes('"--listen"'));
  const without = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"');
  for (const needle of ['/listen', '/live', '--listen', 'make_listener']) {
    assert.ok(!without.includes(needle), needle);
  }
});

test("RunServerEmitter: carries the caller's import line verbatim", () => {
  const line = 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
  assert.ok(RunServerEmitter.emit('Demo', 'doc body', line, 'WORKFLOW_VERSION = "1"').includes(line));
});

test('RunServerEmitter: the version line is always defined', () => {
  const out = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"');
  assert.ok(out.includes('\nWORKFLOW_VERSION = "1"\n'));
  assert.ok(out.includes('{WORKFLOW_VERSION}'));
});

test('RunServerEmitter: commonBlock gives the sink api.py imports', () => {
  const common = RunServerEmitter.commonBlock();
  assert.ok(common.includes('def set_event_sink('));
  assert.ok(common.includes('def emit_event('));
  assert.ok(common.includes('def resolve_gate('));
});

test('RunServerEmitter: package emits the same four files for every target', () => {
  for (const suffix of ['adk', 'maf', 'nooa']) {
    const pkg = RunServerEmitter.package({ code: '# workflow' }, 'Dispatcher demo', suffix, `${suffix} run server`);
    assert.equal(pkg.root, `dispatcher_demo_${suffix}`);
    const files: Record<string, string> = {};
    for (const f of pkg.files) files[f.path] = f.code;
    assert.deepEqual(Object.keys(files), ['__init__.py', 'workflow.py', 'common.py', 'api.py']);
    assert.equal(files['workflow.py'], '# workflow');
    assert.ok(files['common.py'].includes('import threading'));
    assert.ok(files['api.py'].includes('from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'));
    assert.ok(files['api.py'].includes('WORKFLOW_VERSION = "1"'));
    assert.ok(files['api.py'].includes(`${suffix} run server`));
  }
});

test('RunServerEmitter: emitted api.py and common.py compile', { skip: PY_SKIP || false }, () => {
  for (const listen of [false, true]) {
    const [rc, out] = runPython('import ast\nast.parse(' + JSON.stringify(RunServerEmitter.emit('Demo', 'doc', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"', listen)) + ')\nprint("ok")\n');
    assert.equal(rc, 0, out.join('\n'));
  }
  const [rc, out] = runPython(RunServerEmitter.commonBlock() + '\nset_event_sink(None)\nprint("ok")\n');
  assert.equal(rc, 0, out.join('\n'));
});

// ── CodeNodeEmitTest ─────────────────────────────────────────────────────────

const codeNode = (cfg: Record<string, any>) => ({
  id: '5', node_type: 'code',
  config: {
    type: 'code', name: 'Poll', code: "def run(i, c):\n    return {'route': 'job', 'output': 1}",
    exits: ['job', 'no_job', 'error'], mcp_servers: ['ServiceNow'], timeout_s: 20, ...cfg,
  },
});
const CODE_EDGES = [
  { from: '5', to: '6', from_port: 'output_1' },
  { from: '5', to: '7', from_port: 'output_2' },
  { from: '5', to: '8', from_port: 'output_1' },
  { from: '1', to: '5', from_port: 'output_1' },
];

test('CodeNodeEmit: nodeData maps ports to exits', () => {
  const d = CodeNodeEmit.nodeData(codeNode({}), CODE_EDGES, { servicenow: 'http://localhost/servicenow/' });
  assert.equal(d.kind, 'code');
  assert.deepEqual({ ...d.exit_targets }, { job: ['6', '8'], no_job: ['7'], error: [] });
  assert.deepEqual(Object.keys(d.exit_targets), ['job', 'no_job', 'error']);
  assert.deepEqual(d.servers, ['http://localhost/servicenow/']);
  assert.deepEqual(d.mcp_servers, ['servicenow']);
  assert.equal(d.timeout_s, 20);
  assert.equal(d.display, 'Poll');
});

test('CodeNodeEmit: defaults and validation', () => {
  const d = CodeNodeEmit.nodeData({ id: '5', node_type: 'code', config: { type: 'code', code: "def run(i, c):\n    return i" } }, [], {});
  assert.deepEqual(d.exits, ['next']);
  assert.equal(d.timeout_s, 30);
  for (const bad of [{ exits: ['Bad'] }, { exits: ['a', 'a'] }, { exits: [] }, { mcp_servers: ['Okta'] },
    { mcp_servers: [5] }, { mcp_servers: 'ServiceNow' }, { timeout_s: 0 }]) {
    assert.throws(() => CodeNodeEmit.nodeData(codeNode(bad), [], { servicenow: 'u' }), /'Poll'/, JSON.stringify(bad));
  }
});

test('CodeNodeEmit: slug and refusal', () => {
  assert.equal(CodeNodeEmit.slug('Service Now (prod)'), 'service_now_prod_');
  const graph = { nodes: [codeNode({})], edges: [] };
  assert.equal(CodeNodeEmit.hasCodeNodes(graph), true);
  assert.throws(() => CodeNodeEmit.refuseUnsupported(graph, 'ADK'), /Code nodes are not supported by the ADK target yet/);
});

test('CodeNodeEmit: an empty node_type falls through to config.type', () => {
  const graph = { nodes: [{ id: '5', node_type: '', config: { type: 'code' } }], edges: [] };
  assert.equal(CodeNodeEmit.hasCodeNodes(graph), true);
  assert.throws(() => CodeNodeEmit.refuseUnsupported(graph, 'MAF'), /Code nodes are not supported by the MAF target yet/);
});

test('CodeNodeEmit: dangling edges are ignored', () => {
  const edges = [...CODE_EDGES, { from: '5', to: '99', from_port: 'output_3' }];
  const d = CodeNodeEmit.nodeData(codeNode({}), edges, { servicenow: 'u' }, ['1', '5', '6', '7', '8']);
  assert.deepEqual({ ...d.exit_targets }, { job: ['6', '8'], no_job: ['7'], error: [] });
});

// ── PlaybookResolveSummaryEmitTest ───────────────────────────────────────────

function generatorUnloadable(): string {
  try {
    require('../src/AgentTeam/LangGraphGenerator');
    return '';
  } catch (e: any) {
    return 'LangGraphGenerator does not load yet: ' + String(e.message).split('\n')[0];
  }
}

test('PlaybookEmit: the runtime uses the resolve summary', { skip: generatorUnloadable() || false }, () => {
  const code = PlaybookEmit.supportBlock(true) + '\n' + PlaybookEmit.runtimeBlock();
  assert.ok(code.includes('run.summary = str(a.get("summary") or "").strip()'));
  assert.ok(code.includes('render_playbook_transcript(pb["title"], run.events, run.summary or text, run.status)'));
});

test('LangGraphRuntime: the playbook runtime uses the resolve summary', () => {
  const src = LangGraphRuntime.playbookBlock() + LangGraphRuntime.nodeClassesBlock(true, true);
  assert.ok(src.includes('run.summary = str(a.get("summary") or "").strip()'));
  assert.ok(src.includes('run.transcript(pb["title"], run.summary or text)'));
  assert.ok(src.includes('self.summary = ""'));
});

// ── LangGraphCodeNodeRuntimeTest ─────────────────────────────────────────────

test('LangGraphRuntime: CodeNode class only when asked', () => {
  assert.ok(!LangGraphRuntime.nodeClassesBlock(true).includes('class CodeNode'));
  const withCode = LangGraphRuntime.nodeClassesBlock(true, true);
  assert.ok(withCode.includes('class CodeNode(Node):'));
  assert.ok(withCode.includes('CODE = "code"'));
  assert.ok(withCode.includes('case NodeKind.CODE:'));
});

test('LangGraphRuntime: the harness is embedded verbatim and loads', { skip: PY_SKIP || false }, () => {
  const block = LangGraphRuntime.codeHarnessBlock();
  const py = 'import json, sys, types\nMCP_SLUGS = {}\nclass _M:\n    def call_tool_raw(self, u, t, a):\n        return {}\nMCP = _M()\n'
    + block + "\nprint(CODE_HARNESS.execute('def run(i, c):\\n    return i', 5, ['next'], [], _code_transport, 5)['output_text'])\n"
    + "print(_code_transport('nope', 't', {})['isError'])\n";
  const [rc, out] = runPython(py);
  assert.equal(rc, 0, out.join('\n'));
  assert.deepEqual(out, ['5', 'True']);
  assert.ok(block.includes('CODE_HARNESS_SOURCE = "'));
});

test('LangGraphRuntime: the MCP client has a raw call', () => {
  assert.ok(LangGraphRuntime.mcpClientBlock().includes('def call_tool_raw(self, server_url: str, tool_name: str, arguments: dict) -> dict:'));
});

test('LangGraphRuntime: the workflow graph routes code exits', () => {
  const g = LangGraphRuntime.workflowGraphBlock();
  assert.ok(g.includes('case "agent" | "playbook" | "code":'));
  assert.ok(g.includes('def _code_router(self, nid: str):'));
  assert.ok(g.includes('"start": self.node_types.get(p) == "start"'));
});

test("LangGraphRuntime: a dispatcher's code branch receives what the dispatcher received", { skip: LANGGRAPH_SKIP || false }, () => {
  const py = 'from __future__ import annotations\nimport json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n'
    + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n'
    + "g = WorkflowGraph(edges=[['1','2'],['2','3'],['3','4']], order=['1','2','3','4'],\n"
    + "    node_types={'1':'start','2':'code','3':'agent','4':'code'},\n"
    + "    agents={'2': {'kind':'code','display':'Poll'}, '3': {'kind':'dispatcher','display':'triage','dispatch':[{'id':'4','name':'claims'}]},\n"
    + "            '4': {'kind':'code','display':'claims'}}, run_node=None, start_documents=[])\n"
    + "outs = {'1': {'source':'start','text':'poll'}, '2': {'source':'Poll','text':'{\\\"id\\\": \\\"m1\\\"}'},\n"
    + "        '3': {'source':'triage','text':'### Input from: Poll'}}\n"
    + "print(json.dumps(json.loads(g._request_for('4', {'user_prompt':'poll','node_outputs':outs}))['parents']))\n";
  const [rc, out] = runPython(py);
  assert.equal(rc, 0, out.join('\n'));
  assert.equal(out[out.length - 1], '[{"name": "Poll", "text": "{\\"id\\": \\"m1\\"}", "start": false}]');
});

test('LangGraphRuntime: code nodes are checked at startup', () => {
  const withCode = LangGraphRuntime.nodeClassesBlock(true, true);
  assert.match(withCode, /class CodeNode\(Node\):[\s\S]*?def __init__\(self, cfg: dict\):\n {8}super\(\).__init__\(cfg\)\n[\s\S]*?CODE_HARNESS\.check_code\(self\.source\(\)\)/);
  assert.ok(withCode.includes('with open(os.path.join(PACKAGE_DIR, self.cfg["source_file"]), encoding="utf-8") as fh:'));
  assert.ok(withCode.includes('res = await asyncio.to_thread(CODE_HARNESS.execute, self.source(), value,'));
});

test('LangGraphRuntime: a tool error result takes the error exit in a compiled script', { skip: PY_SKIP || false }, () => {
  const block = LangGraphRuntime.codeHarnessBlock();
  const py = "import json, sys, types\nMCP_SLUGS = {'s': 'http://x/mcp'}\nclass _M:\n"
    + '    def call_tool_raw(self, u, t, a):\n'
    + "        return {'isError': True, 'content': [{'type': 'text', 'text': 'quota_exceeded'}]}\nMCP = _M()\n"
    + block
    + "\nr = CODE_HARNESS.execute('def run(i, call_tool):\\n    return {\"route\": \"ok\", \"output\": call_tool(\"s\", \"t\")}',"
    + " None, ['ok', 'error'], ['s'], _code_transport, 5)\n"
    + "print(r['route'])\nprint('quota_exceeded' in r['output_text'])\n";
  const [rc, out] = runPython(py);
  assert.equal(rc, 0, out.join('\n'));
  assert.deepEqual(out, ['error', 'True']);
});

// ── EmittedMcpEndpointTest (the pure case) ───────────────────────────────────

test('PythonEmitHelpers: MCP candidates as given first, then /mcp before the query', { skip: PY_SKIP || false }, () => {
  const [rc, out] = runPython('import json, sys, time, types\n'
    + "try:\n    import httpx\nexcept ImportError:\n    httpx = types.ModuleType('httpx')\n"
    + PythonEmitHelpers.mcpClientBlock() + '\n'
    + 'print(json.dumps([\n'
    + '    _mcp_candidates("https://x.test"),\n'
    + '    _mcp_candidates("http://h/srv/"),\n'
    + '    _mcp_candidates("http://localhost/servicenow/?profile=mock&toolset=jobs"),\n'
    + '    _mcp_candidates("http://h/x?a=1#f"),\n'
    + '    _mcp_candidates("https://x.test/mcp/"),\n'
    + '    _mcp_candidates("http://h/s.php?k=1"),\n'
    + ']))\n');
  assert.equal(rc, 0, out.join('\n'));
  assert.deepEqual(JSON.parse(out.join('\n')), [
    ['https://x.test', 'https://x.test/mcp'],
    ['http://h/srv/', 'http://h/srv/mcp'],
    ['http://localhost/servicenow/?profile=mock&toolset=jobs', 'http://localhost/servicenow/mcp?profile=mock&toolset=jobs'],
    ['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f'],
    ['https://x.test/mcp/'],
    ['http://h/s.php?k=1'],
  ]);
});
