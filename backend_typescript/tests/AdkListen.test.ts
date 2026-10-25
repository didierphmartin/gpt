/**
 * Port of backend/tests/Unit/AdkListenTest.php: the Start's mode (StartTriggerFacts), the RUN EVENTS block of an ADK
 * script (run with a fake recorder), and the listening package (api.py's POST /listen, GET /live). The scripts are
 * also compared with PHP's ADKGenerator::emitAdk() of the same analysis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { ADKPackage } from '../src/AgentTeam/compiler/ADKPackage';
import { CompiledRuntimeEmit } from '../src/AgentTeam/compiler/CompiledRuntimeEmit';
import { RunServerEmitter } from '../src/AgentTeam/compiler/RunServerEmitter';
import { StartTriggerFacts } from '../src/AgentTeam/StartTriggerFacts';
import { jsonDecodePhp } from '../src/AgentTeam/compiler/php';
import { db } from '../src/db/pools';
import { installSqliteDb } from './support/sqliteDb';
import { asPhpArg } from './support/phpCmp';
import { execPy, python3 } from './support/lgFixtures';
import { assertSameAsPhp, codeAnalyzed, wf64Analyzed } from './support/adkAnalyses';

const PY_SKIP = python3() === null ? 'python3 not found on PATH' : undefined;
const VENV_PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

function triggerNodes(server = 'Outlook'): any[] {
  return [
    { id: '1', type: 'start', config: { type: 'start' } },
    { id: '1000000001', type: 'code', config: { type: 'code', name: 'T',
      start_trigger: { label: 'T', work_exit: 'new_mail',
        watch: { server, tool: 'wait_for_new', args: { folder: 'Inbox' } } } } },
  ];
}

test('testTriggerNodeMakesTheStartWatch', async () => {
  const f = await StartTriggerFacts.of(null, 64, triggerNodes(), { 'http://x': 'outlook' });
  assert.equal(f.startMode, 'watch');
  assert.deepEqual(f.defaultWatch, { server: 'outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } });
  assert.equal(f.triggerNodeId, '1000000001');
});

/** spec 2026-10-22 §6.1: the trigger node's args (the Start's start_args) named in pass_args, and the tag, reach the watch. */
test('testCompiledWatchMergesPassArgsAndTag', async () => {
  const nodes = triggerNodes();
  nodes[1].config.start_trigger.pass_args = ['folder'];
  nodes[1].config.args = { folder: 'Mail in', tag: 't', sharepoint_folder: 'D' };
  const f = await StartTriggerFacts.of(null, 64, nodes, { 'http://x': 'outlook' });
  assert.deepEqual(f.defaultWatch!.args, { folder: 'Mail in', tag: 't' });
});

test('testWatchArgsMergesOnlyTheNamedStartArgs', () => {
  assert.deepEqual(StartTriggerFacts.watchArgs({ poll: 'p', folder: 'To SharePoint' }, { folder: 'Mail in', x: 1 }, ['folder']),
    { poll: 'p', folder: 'Mail in' });
  assert.deepEqual(StartTriggerFacts.watchArgs({ folder: 'To SharePoint' }, { folder: '', tag: '', x: 1 }, ['folder', 'y']),
    { folder: 'To SharePoint' });   // a blank Start value keeps the default; no tag, nothing named
});

test('testWatchOnAnUnusedServerIsRefused', async () => {
  await assert.rejects(StartTriggerFacts.of(null, 64, triggerNodes('Gmail'), { 'http://x': 'outlook' }), /which no node of this workflow uses/);
});

test('testNoTriggerNoScheduleIsAPromptStart', async () => {
  installSqliteDb();   // no scheduled_workflows table
  const f = await StartTriggerFacts.of(db, 64, [{ id: '1', type: 'start', config: { type: 'start' } }], {});
  assert.deepEqual(f, { startMode: 'prompt', defaultCron: null, defaultWatch: null, triggerNodeId: null });
});

test('testScriptBakesTheStartMode', () => {
  const a = codeAnalyzed();
  a['startMode'] = 'watch';
  a['defaultWatch'] = asPhpArg({ server: 'outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } });
  const code = ADKGenerator.emitAdk(a);
  assert.ok(code.includes('START_MODE = "watch"'));
  assert.ok(code.includes('DEFAULT_CRON = None'));
  assert.match(code, /DEFAULT_WATCH = \{\s*"server": "outlook",\s*"tool": "wait_for_new",\s*"args": \{\s*"folder": "Inbox"\s*\}\s*\}/);
  assert.ok(ADKGenerator.emitAdk(codeAnalyzed()).includes('START_MODE = "prompt"'));
  assertSameAsPhp(a);
});

test('testRecordingCoversNodesButNotTheDispatcherChooser', () => {
  const code = ADKGenerator.emitAdk(wf64Analyzed());
  assert.match(code, /NODE_META = \{.*"node_10": \[\s*"10",\s*"code",\s*"T"\s*\]/s);
  assert.match(code, /"node_5": \[\s*"5",\s*"output",\s*"Output"\s*\]/s);
  assert.ok(!code.includes('"node_2": ['));   // the chooser: _DispatcherAgent records node 2
  assert.ok(code.includes('START_NODE = ["1", "Start"]'));
  assert.ok(code.includes('OUTPUT_NODE_KEYS = ["node_5"]'));
  assert.ok(code.includes('_attach_recording(root_agent)'));
  assert.ok(code.includes('node_id="2",\n    display="D",'));
});

/** The RUN EVENTS helpers, run with a fake recorder and fake callback contexts. */
test('testRecordingHelpersEmitTheRunEvents', { skip: PY_SKIP }, () => {
  const code = ADKGenerator.emitAdk(wf64Analyzed());
  const start = code.indexOf('NODE_META = ');
  const end = code.indexOf('# =====', start);
  const py = code.slice(start, end) + `
class Rec:
    def __init__(self): self.ev = []
    def node_start(self, *a): self.ev.append(["start", *a])
    def node_complete(self, *a, **k): self.ev.append(["complete", *a, k])
class Ctx:
    def __init__(self, name, state): self.agent_name, self.state = name, state
class Agent:
    def __init__(self, name, subs=()): self.name, self.sub_agents = name, list(subs)
GRAPH_RECORDER = Rec()
_run_reset()
root = Agent("workflow", [Agent("node_10"), Agent("gate_2", [Agent("node_2__dispatch", [Agent("node_2"), Agent("node_3")])])])
_attach_recording(root)
t = root.sub_agents[0]
assert t.before_agent_callback is _rec_before and not hasattr(root.sub_agents[1].sub_agents[0].sub_agents[0], "before_agent_callback")
st = {"node_10": '{"subject": "hi"}', "route_10": "new_mail"}
_rec_before(Ctx("node_10", st)); _rec_after(Ctx("node_10", st))
_rec_node_start("3", "A", "code")   # then the run fails: run_workflow closes it
for nid, (name, typ) in list(_RUN["open"].items()):
    _rec_node_complete(nid, name, typ, success=False, error="RuntimeError: boom")
import json
print(json.dumps([GRAPH_RECORDER.ev, _RUN["ran"], _RUN["routes"]]))`;
  const dir = mkdtempSync(path.join(tmpdir(), 'adkrec_'));
  const f = path.join(dir, 'rec.py');
  writeFileSync(f, py);
  const r = execPy('python3', [f]);
  assert.equal(r.rc, 0, r.text);
  const [ev, ran, routes] = JSON.parse(r.out[r.out.length - 1]);
  assert.deepEqual(ev[0], ['start', '10', 'T', 'code']);
  assert.deepEqual(ev[1], ['complete', '10', 'T', 'code', { output: '{"subject": "hi"}', exit: 'new_mail' }]);
  assert.deepEqual(ev[3], ['complete', '3', 'A', 'code', { output: '', success: false, error: 'RuntimeError: boom' }]);
  assert.deepEqual(ran, ['10', '3']);
  assert.deepEqual(routes, { 10: 'new_mail' });
});

/** The wf 64-shaped package as files (no DB): workflow.py, common.py, api.py and ADKPackage's. */
async function listeningPackage(url = 'http://localhost:8770'): Promise<Record<string, string>> {
  const a = wf64Analyzed();
  a['serverSlugs'] = asPhpArg({ [url]: 'outlook' });
  a['startMode'] = 'watch';
  a['defaultWatch'] = { server: 'outlook', tool: 'wait_for_new', args: [] };
  a['package'] = true;
  const pkg = RunServerEmitter.package({ code: ADKGenerator.emitAdk(a) }, 'wf64', 'adk', 'ADK run server',
    CompiledRuntimeEmit.packageCommonBlock(), true);
  const files: Record<string, string> = {};
  for (const f of pkg.files) files[f.path] = f.code;
  for (const f of await ADKPackage.files(a, tmpdir())) files[f.path] = f.code;
  return files;
}

test('testPackageServesListenAndLive', async () => {
  const f = await listeningPackage();
  assert.ok(f['api.py'].includes('@app.post("/listen")'));
  assert.ok(f['api.py'].includes('from workflow import make_listener, RUNS_DIR, START_MODE, LoopState'));
  assert.ok(f['common.py'].includes('class RunRecorder'));
  assert.ok(f['common.py'].includes('def live_next('));
  assert.ok(f['workflow.py'].includes('def make_listener(state'));
  assert.ok(f['workflow.py'].includes('MCP = _McpShim()'));
  assert.ok(f['workflow.py'].includes('class Listener:'));
});

test('testPackageImportsUnderTheRunnerVenv', { skip: existsSync(VENV_PY) ? undefined : 'runner venv missing' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adklisten_'));
  for (const [p, code] of Object.entries(await listeningPackage())) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), code);
  }
  const r = execPy(VENV_PY, ['-c', 'import common, workflow, api; l = workflow.make_listener(workflow.LoopState()); print(type(l).__name__, workflow.START_MODE)'],
    { cwd: dir, env: { ...process.env, ANTHROPIC_API_KEY: 'x' } });
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.out[r.out.length - 1], 'Listener watch');
});

test('testEnvExampleNamesTheDecisionKeys', async () => {
  const a = wf64Analyzed();
  a['decisions'] = jsonDecodePhp(JSON.stringify({ 2: { decision_question: 'q', routing_mode: 'jev', unclear_branch: '', min_confidence: 0.6,
    decision: [{ provider: 'jev', protocol: 'typesafe', url: 'https://x', model: 'jev-latest', key_env: 'JEV_API_KEY', url_env: 'JEV_BASE_URL' }] } }));
  const env = (await ADKPackage.files(a, tmpdir())).find((f: any) => f.path === '.env.example').code;
  assert.ok(env.includes('# JEV_API_KEY=\n# JEV_BASE_URL='));
  const code = ADKGenerator.emitAdk(a);
  assert.ok(code.includes('routing_mode="jev",'));
  assert.ok(code.includes('class JevRouter:'));
  assert.ok(code.includes('DECISION_ADAPTERS = {'));
  assertSameAsPhp(a);
});
