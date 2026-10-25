/**
 * Port of backend/tests/Unit/LangGraphCliTest.php. Standalone plan task 6: the program runs in the Start's mode;
 * --once; the recorder and console wired; Listener.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { StartOptionGraph } from '../src/AgentTeam/StartOptionGraph';
import { execPy, lgFiles, lgGenerator, pyCompile, runPySource } from './support/lgFixtures';

const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The python to run the blocks with, or null when no Python 3.10+ (the PHP test's markTestSkipped). */
function python(): string | null {
  const py = isExecutable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
  const r = execPy(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
  return r.rc === 0 ? py : null;
}
const PY = python();
const noPy = PY === null ? 'Python 3.10+ not available' : false;
const noVenv = !existsSync(VENV) ? 'venv python missing' : false;

/** runRecordBlock + consoleBlock + cronBlock + watchBlock + listenerBlock, then tail; asserts exit 0 and a last line "ok". */
function py(tail: string): string[] {
  const src =
    'from __future__ import annotations\n' +
    'import argparse, asyncio, json, os, re, signal, sys, threading, time, uuid\n' +
    'from datetime import datetime, timedelta\nfrom typing import Callable\n' +
    LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.consoleBlock() + '\n' +
    LangGraphRuntime.cronBlock() + '\n' + LangGraphRuntime.watchBlock() + '\n' +
    LangGraphRuntime.listenerBlock() + '\n' + tail;
  const r = runPySource(PY as string, src);
  assert.equal(r.rc, 0, r.out.join('\n'));
  assert.equal(r.out[r.out.length - 1], 'ok', r.out.join('\n'));
  return r.out;
}

test('testChooseMode', { skip: noPy }, () => {
  py(String.raw`from types import SimpleNamespace as A
def a(**k): return A(**{"prompt": [], "once": False, "cron": None, "watch": None, **k})
assert choose_mode(a(), "watch") == "watch"
assert choose_mode(a(), "cron") == "cron"
assert choose_mode(a(), "prompt") == "once"
assert choose_mode(a(prompt=["hi"]), "watch") == "once"
assert choose_mode(a(once=True), "watch") == "once"
assert choose_mode(a(cron=""), "watch") == "cron"
assert choose_mode(a(watch=""), "prompt") == "watch"
print("ok")`);
});

test('testListenerStartsOnceAndStops', { skip: noPy }, () => {
  py(String.raw`import tempfile, threading
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        time.sleep(0.05)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
st = LoopState()
L = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=st,
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); L.start()
time.sleep(0.2)
assert L.running and threading.active_count() >= 2
L.stop()
time.sleep(0.3)
assert not L.running
print("ok")`);
});

test('testListenerStartsAgainAfterAStopAndInstallsNoSignalHandler', { skip: noPy }, () => {
  py(String.raw`import tempfile
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        time.sleep(0.02)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
before = signal.getsignal(signal.SIGTERM)
L = Listener("watch", lambda: "", drains=False, loop=RunLoop(), cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=LoopState(),
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); time.sleep(0.1)
assert signal.getsignal(signal.SIGTERM) is before
L.stop(); time.sleep(0.2)
assert not L.running
L.start(); time.sleep(0.1)
assert L.running
L.stop(); time.sleep(0.2)
assert not L.running
print("ok")`);
});

/** Task 6 review: start() right after stop() -- the thread still finishing its trigger call -- leaves a listener that
 *  listens, in the same thread (a second thread would find the lock held); a later stop() still stops it. */
test('testStopThenStartAtOnceLeavesARunningListener', { skip: noPy }, () => {
  py(String.raw`import tempfile, threading
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
calls = []
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(time.monotonic())
        time.sleep(0.3)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
L = Listener("watch", lambda: "", drains=False, loop=RunLoop(), cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=LoopState(echo=False),
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); time.sleep(0.1)                     # inside the first trigger call
L.stop(); assert not L.listening               # stopping: no longer reported as listening
L.start()                                      # the old thread is still in its call
assert L.listening
time.sleep(1.0)
assert L.running and L.listening and len(calls) >= 3, calls        # it went on calling the trigger
assert threading.active_count() == 2, threading.enumerate()       # one listener thread, not two
L.stop(); time.sleep(0.5)
assert not L.running and not L.listening
# the loop already left (a nap the stop woke): the same thread runs it again
class FailingMcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(time.monotonic())
        raise OSError("refused")
MCP = FailingMcp()
L.start(); time.sleep(0.1)                     # now napping 30 s after a failed call
n = len(calls)
L.stop(); L.start()
time.sleep(0.3)
assert L.running and L.listening and len(calls) == n + 1, (n, calls)
L.stop(); time.sleep(0.3)
assert not L.running
print("ok")`);
});

test('testBannerNamesTheMode', { skip: noPy }, () => {
  const out = py(String.raw`MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
w = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {"folder": "Inbox"}), state=LoopState(), lock_path=None)
print(w.banner())
c = Listener("cron", lambda: "", drains=True, loop=None, cron_expr="0 9 * * *", trigger=None, state=LoopState(), lock_path=None)
print(c.banner(now=datetime(2026, 10, 15, 8, 0)))
print("ok")`);
  assert.equal(out[0], 'Listening for events: outlook.wait_for_new {"folder":"Inbox"} (Ctrl-C to stop)');
  assert.equal(out[1], 'Scheduled: 0 9 * * * — next run 2026-10-15 09:00 (Ctrl-C to stop)');
});

/** Deferred finding: a Listener whose lock is held shows "Not listening: already running" (tone off), in a thread too. */
test('testALockHeldElsewhereSetsTheStateAndEndsTheThread', { skip: noPy }, () => {
  const out = py(String.raw`import tempfile, fcntl
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
path = os.path.join(tempfile.mkdtemp(), ".run.lock")
held = open(path, "a")
fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
seen = []
st = LoopState()
st.on_change.append(lambda s: seen.append((s.line, s.tone)))
L = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=st, lock_path=path)
L.start()
time.sleep(0.2)
assert not L.running
assert seen == [(f"Not listening: already running ({path})", "off")], seen
print("ok")`);
  assert.ok(!out.join('\n').includes('Traceback'));
});

/** Deferred finding: a LoopState listener that raises is reported and the others still run. */
test('testABrokenStateListenerDoesNotStopTheOthers', { skip: noPy }, () => {
  const out = py(String.raw`st = LoopState(echo=False)
seen = []
def broken(s): raise RuntimeError("feed gone")
st.on_change += [broken, lambda s: seen.append(s.line)]
st.set("Listening for events", "ok")
assert seen == ["Listening for events"], seen
print("ok")`);
  assert.ok(out.includes('[warn] state listener failed: feed gone'), out.join('\n'));
});

// ---------- the generator: the entry files ----------

const POLL =
  "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n" +
  "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

function sqlStatements(): string[] {
  return [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
    "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
  ];
}

async function generate(graph: any, options: any = {}): Promise<any> {
  const gen = lgGenerator({ sql: sqlStatements(), workflow: { id: 44, name: 'Email prototype', user_id: '3' }, graph });
  return gen.generate(44, '3', options);
}

/** Start (17) on a Start option, expanded as WorkflowGraphRepository::getGraph does (LangGraphStartModeTest's fixture). */
async function optionGraph(watch: any = { server: 'Outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } }): Promise<any> {
  const raw = {
    nodes: [
      { id: '17', node_type: 'start', config: { type: 'start', start_option: 5 } },
      { id: '18', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from_node_id: '17', to_node_id: '18', from_port: 'output_1' }],
  };
  return StartOptionGraph.expand(raw, (_id: number) => ({
    name: 'Outlook: get new email',
    code: POLL,
    exits: ['new_mail', 'no_mail'],
    mcp_servers: ['Outlook'],
    timeout_s: 30,
    start_trigger: { label: 'Outlook: get new email', work_exit: 'new_mail', ...(watch !== null ? { watch } : {}) },
  }));
}

/** Start -> code node "Check" (exits work / no_mail / error) -> Output on `work` only: no_mail ends the run
 *  quietly; FAILNOW takes the error exit. */
function codeGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'NOTHING' } },
      {
        id: '2',
        node_type: 'code',
        config: {
          type: 'code',
          name: 'Check',
          code:
            "def run(input, call_tool):\n    if 'WORKNOW' in str(input):\n        return {'route': 'work', 'output': 'mail for you'}\n" +
            "    if 'FAILNOW' in str(input):\n        return {'route': 'error', 'output': 'mailbox gone'}\n" +
            "    return {'route': 'no_mail', 'output': None}\n",
          exits: ['work', 'no_mail', 'error'],
          mcp_servers: [],
          timeout_s: 30,
        },
      },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2', from_port: 'output_1' },
      { from: '2', to: '3', from_port: 'output_1' },
    ],
  };
}

const MODES: Array<[string, any]> = [
  ['single', {}],
  ['modular', { modular: true }],
];

test('testEntryFilesRunInTheStartsModeAndCompile', { skip: noPy }, async () => {
  for (const [label, opts] of MODES) {
    const files = lgFiles(await generate(await optionGraph(), opts));
    const wf = files['workflow.py'];
    for (const needle of [
      'mode = choose_mode(a, START_MODE)', 'when.add_argument("--once"', 'talk.add_argument("--quiet"',
      'talk.add_argument("--verbose"', 'RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")',
      'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))', 'def make_run_once(',
      'lock_path=os.path.join(PACKAGE_DIR, ".run.lock")', 'class Listener', 'def choose_mode(',
      'recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])',
      'global GRAPH_RECORDER',
    ]) {
      assert.ok(wf.includes(needle), `${label}: ${needle}`);
    }
    assert.ok(wf.indexOf('def run_watch(') < wf.indexOf('class Listener'), `${label}: Listener after the watch block`);
    assert.ok(wf.includes("the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)"), label);
    assert.ok(wf.includes(' --once '), label);
    for (const [p, code] of Object.entries(files)) {
      if (!p.endsWith('.py')) {
        continue;
      }
      const r = pyCompile(code, PY as string);
      assert.equal(r.rc, 0, `${label}/${p}: ${r.out.join('\n')}`);
    }
  }
});

// ---------- the generated program, run (needs langgraph: the SynergyAI venv) ----------

/** Writes files to a new temp dir; runs workflow.py (or script, written next to it) with args; returns [rc, output, dir]. */
function runProgram(files: Record<string, string>, args: string[], script: string | null = null): [number, string, string] {
  files = { ...files };
  if (script !== null) {
    files['drive.py'] = script;
  }
  const dir = path.join(tmpdir(), 'lgcli_' + randomBytes(4).toString('hex'));
  mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  for (const [p, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, 'pkg', p)), { recursive: true });
    writeFileSync(path.join(dir, 'pkg', p), code);
  }
  const r = execPy(VENV, [script !== null ? 'drive.py' : 'workflow.py', ...args], {
    cwd: path.join(dir, 'pkg'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SYNERGYAI_OUTPUT_ROOT: path.join(dir, 'outputs') },
    timeoutMs: 120000,
  });
  return [r.rc, r.text, dir];
}

function runLogs(dir: string): string[] {
  const runs = path.join(dir, 'pkg', 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(runs, f));
}

/** Deferred finding (Task 3): the WorkflowGraph hooks, executed -- a quiet run leaves nothing; a work run one log. */
test('testAGeneratedProgramRecordsAWorkRunAndDropsAQuietOne', { skip: noVenv, timeout: 300000 }, async () => {
  for (const [label, opts] of MODES) {
    const files = lgFiles(await generate(codeGraph(), opts));

    let [rc, text, dir] = runProgram(files, ['--once', 'NOTHING']);
    assert.equal(rc, 0, `${label} quiet: ${text}`);
    assert.deepEqual(runLogs(dir), [], `${label}: a quiet run leaves no run log\n${text}`);
    assert.ok(!text.includes('Done in'), label);
    assert.ok(!text.includes('FINAL OUTPUT'), label);
    assert.ok(!text.includes('✓'), label);

    [rc, text, dir] = runProgram(files, ['--once', 'WORKNOW']);
    assert.equal(rc, 0, `${label} work: ${text}`);
    const logs = runLogs(dir);
    assert.equal(logs.length, 1, `${label}\n${text}`);
    assert.equal(path.basename(logs[0], '.jsonl'), readFileSync(path.join(dir, 'pkg', 'runs', 'current'), 'utf8').trim());
    const events = readFileSync(logs[0], 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
    const code = events.filter((e: any) => e['type'] === 'node_complete' && e['node_id'] === '2');
    assert.equal(code.length, 1, label);
    assert.equal(code[0]['exit'], 'work', label);
    assert.equal(code[0]['node_name'], 'Check', label);
    assert.deepEqual(events.slice(0, 3).map((e: any) => e['type']), ['workflow_start', 'node_start', 'node_complete'], label);
    const last = events[events.length - 1];
    assert.equal(last['type'], 'workflow_complete', label);
    assert.equal(last['success'], true, label);
    assert.equal(last['output'], 'mail for you', label);
    assert.ok(text.includes('  ✓ Check'), label);
    assert.match(text, /\[\d\d:\d\d\] Done in \d+\.\d s/, label);
  }
});

/** Loads workflow.py as a module and calls make_run_once as --cron / --watch do (loop_mode) at verbosity argv[1] on argv[2]. */
const LOOP_DRIVER = String.raw`import importlib.util, sys
spec = importlib.util.spec_from_file_location("prog", "workflow.py")
m = importlib.util.module_from_spec(spec)
sys.modules["prog"] = m
spec.loader.exec_module(m)
view = m.ConsoleView(sys.argv[1])
rec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])
m.RUN_OUT.chatty = sys.argv[1] == "verbose"
print("RESULT", repr(m.make_run_once(sys.argv[2], m.RunLoop(), view, rec, loop_mode=True)()))`;

/** Fix round 1 (spec §4.1/§4.2): in a loop mode a quiet run prints nothing, a real run only the view's block
 *  (the progress lines under --verbose); --once --quiet prints only the Done / Failed line. */
test('testLoopRunsPrintOnlyTheBlockAndQuietRunsNothing', { skip: noVenv, timeout: 600000 }, async () => {
  for (const [label, opts] of MODES) {
    const files = lgFiles(await generate(codeGraph(), opts));

    let [rc, text] = runProgram(files, ['normal', 'NOTHING'], LOOP_DRIVER);
    assert.equal(rc, 0, `${label}: ${text}`);
    assert.equal(text.trim(), "RESULT ''", `${label}: a quiet loop run prints nothing`);

    [rc, text] = runProgram(files, ['normal', 'WORKNOW'], LOOP_DRIVER);
    assert.equal(rc, 0, `${label}: ${text}`);
    const lines = text.replace(/\s+$/, '').split('\n');
    assert.deepEqual(
      lines.slice(0, 4),
      ["    · 'Check' code -- exits=['work', 'no_mail', 'error'], mcp_servers=[]", "    · exit 'work'", '  ✓ Check', '  ✓ Output'],
      `${label}: ${text}`,
    );
    assert.match(lines[4], /^\[\d\d:\d\d\] Done in \d+\.\d s$/, `${label}: ${text}`);
    assert.equal(lines[5], "RESULT 'mail for you'", `${label}: ${text}`);
    assert.equal(lines.length, 6, `${label}: no [node], [info], FINAL OUTPUT or RUN SUMMARY\n${text}`);

    [rc, text] = runProgram(files, ['verbose', 'WORKNOW'], LOOP_DRIVER);
    assert.equal(rc, 0, `${label}: ${text}`);
    assert.ok(text.includes('[info] Running...'), label);
    assert.ok(text.includes("[node] [2] exit 'work'"), label);
    assert.ok(!text.includes('FINAL OUTPUT'), label);
    assert.ok(text.indexOf('[info] Running...') < text.indexOf('  ✓ Check'), `${label}: progress lines before the block`);

    [rc, text] = runProgram(files, ['--once', '--quiet', 'WORKNOW']);
    assert.equal(rc, 0, `${label}: ${text}`);
    assert.match(text.trim(), /^\[\d\d:\d\d\] Done in \d+\.\d s$/, `${label} --once --quiet: ${text}`);

    [rc, text] = runProgram(files, ['--once', '--quiet', 'FAILNOW']);
    assert.equal(rc, 1, `${label}: ${text}`);
    assert.match(
      text.trim(),
      /^\[\d\d:\d\d\] Failed: ErrorExitTaken: code node 'Check' took its error exit: mailbox gone$/,
      `${label} --once --quiet: ${text}`,
    );
  }
});

/** Task 1 left DEFAULT_WATCH None for a Start option without a watch: the default mode then fails as a usage error. */
test('testAStartOptionWithoutAWatchIsAUsageError', { skip: noVenv, timeout: 300000 }, async () => {
  for (const [label, opts] of MODES) {
    const files = lgFiles(await generate(await optionGraph(null), opts));
    assert.ok(files['workflow.py'].includes('START_MODE = "watch"'), label);
    assert.ok(files['workflow.py'].includes('DEFAULT_WATCH = None'), label);
    const [rc, text] = runProgram(files, []);
    assert.equal(rc, 2, `${label}: ${text}`);
    assert.ok(text.includes('--watch needs a trigger: this workflow has no event trigger'), label);
    assert.ok(!text.includes('Traceback'), label);
  }
});
