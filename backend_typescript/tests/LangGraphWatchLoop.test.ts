/** Port of backend/tests/Unit/LangGraphWatchLoopTest.php (spec 2026-10-12 mail/drive events §7: --watch in compiled LangGraph scripts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { a2aGraph } from './support/lgFixtures';
import { execLines, makeGenerator, python310, sqlite } from './support/lgFixturesB';

const PY = python310();
const NO_PY = PY === null ? 'Python 3.10+ not available' : false;

/** A scripted MCP, a clock whose sleep moves now, and run_once counting runs from a list of outputs. */
const HARNESS = String.raw`import threading, fcntl
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}

class FakeMcp:
    def __init__(self, answers):
        self.answers, self.calls = list(answers), []
    def call_tool_raw(self, url, tool, args):
        self.calls.append((url, tool, args))
        a = self.answers.pop(0)
        if isinstance(a, BaseException):
            raise a
        return a

def ok(**r):
    return {"content": [{"type": "text", "text": json.dumps(r)}], "structuredContent": r}

class Clock:
    def __init__(self):
        self.t, self.slept = datetime(2026, 10, 12, 9, 0), []
    def now(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s)
        self.t += timedelta(seconds=s)

def runner(outputs):
    outputs = list(outputs)
    def run_once():
        return outputs.pop(0) if outputs else ""
    return run_once

TRIGGER = WatchTrigger("outlook", "wait_for_new", {"args": {"folder": "Inbox"}})
`;

function runFile(source: string, args: string[] = []): [number, string[]] {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl'));
  const file = path.join(dir, 'wl.py');
  writeFileSync(file, source);
  try {
    return execLines([PY!, ...args, file], {}, { timeoutMs: 120000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** cronBlock() + watchBlock() + HARNESS + tail; [exit code, output lines]. */
function runPy(tail: string): [number, string[]] {
  return runFile('from __future__ import annotations\nimport argparse, asyncio, json, re, signal, sys, threading, time\n'
    + 'from datetime import datetime, timedelta\nfrom typing import Callable\n'
    + LangGraphRuntime.cronBlock() + '\n' + LangGraphRuntime.watchBlock() + '\n' + HARNESS + tail);
}

function py(tail: string): string[] {
  const [rc, out] = runPy(tail);
  assert.equal(rc, 0, out.join('\n'));
  return out;
}

test('testReadyDrainsTimeoutWaitsAgain', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(status="timeout", events="on"), ok(status="ready", via="event", events="on"),
               ok(status="ready", via="fallback", events="on")])
clock = Clock()
run_watch(TRIGGER, runner(["mail 1", "mail 2", "", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)
print("calls", MCP.calls[0], len(MCP.calls), "slept", clock.slept)`);
  assert.deepEqual(out, [
    '[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
    '[watch 09:00] Listening for events',
    '[watch 09:00] ready (event): 2 run(s) did work',
    '[watch 09:00] Listening for events',
    '[watch 09:00] Listening (checks every 15 min)',
    "calls ('http://mail.local/mcp', 'wait_for_new', {'args': {'folder': 'Inbox'}}) 3 slept []",
  ]);
});

/** Final review I1: a wake that finds nothing to do prints nothing (but under --verbose). */
test('testAQuietWakePrintsNothing', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(status="ready", via="event")] * 4)
clock = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=4, state=st)
assert seen.count("Running…") == 4, seen
for verbosity in ("quiet", "normal"):
    MCP = FakeMcp([ok(status="ready", via="event")] * 3)
    run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3, verbosity=verbosity)
print("verbose")
MCP = FakeMcp([ok(status="ready", via="event")])
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=1, verbosity="verbose")`);
  const quiet = ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events'];
  assert.deepEqual(out, [...quiet, ...quiet, ...quiet, 'verbose', quiet[0], '[watch 09:00] ready (event): nothing to do', quiet[1]]);
});

/** Final review I1: --quiet keeps a run that did work to its view's done line; an error still shows. */
test('testQuietShowsOnlyErrorsOfTheDrain', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 2:
        raise RuntimeError("Jev down")
    return "mail" if state["n"] == 1 else ""
run_watch(TRIGGER, run_once, drains=False, sleep=clock.sleep, now=clock.now, calls=2, verbosity="quiet")`);
  assert.deepEqual(out, ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events',
    '[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down',
    '[watch 09:00] Listening — the last run failed']);
});

test('testWithoutCodeNodesOneRunPerReady', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(status="ready", via="event")])
clock = Clock()
run_watch(TRIGGER, runner(["a", "b"]), drains=False, sleep=clock.sleep, now=clock.now, calls=1)`);
  assert.equal(out[1], '[watch 09:00] ready (event): 1 run(s) did work');
});

test('testEachFailureKindHasItsLineAndTheBackoffGrows', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([{"isError": True, "content": [{"type": "text", "text": '{"error": "reconnect_needed"}'}]},
               ConnectionError("refused"),
               {"content": [{"type": "text", "text": "not json"}]},
               ok(answer=42),
               {"isError": True, "content": [{"type": "text", "text": "boom"}]},
               ok(error="not_connected", message="Outlook is not connected"),
               {"content": [{"type": "text", "text": '{"status": "ready", "via": "pending"}'}]}])   # text only: parsed
clock = Clock()
run_watch(TRIGGER, runner(["x", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=7)
print("slept", clock.slept)`);
  assert.equal(out[1], '[watch 09:00] Not listening: reconnect_needed — retrying in 30 s');
  assert.equal(out[2], '[watch 09:00] Not listening: server unreachable — retrying in 60 s');
  assert.ok(out[3].includes('Not listening: expected {"status": "ready" | "timeout"}, got \'not json\' — retrying in 120 s'));
  assert.ok(out[4].includes('got \'{"answer": 42}\' — retrying in 240 s'));
  assert.equal(out[5], '[watch 09:07] Not listening: boom — retrying in 300 s');
  assert.equal(out[6], '[watch 09:12] Not listening: Outlook is not connected — retrying in 300 s');
  assert.deepEqual(out.slice(7), ['[watch 09:17] ready (pending): 1 run(s) did work',
    '[watch 09:17] Listening for events', 'slept [30.0, 60.0, 120.0, 240.0, 300.0, 300.0]']);
});

test('testWatchErrorKinds', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([OSError("down"), {"isError": True, "content": [{"type": "text", "text": "bad"}]},
               ok(error="reconnect_needed", message="sign in"), ok(error="not_connected"), ok(error="quota"), ok(status="later")])
for _ in range(6):
    try:
        TRIGGER.wait()
    except WatchError as e:
        print(e.kind, "|", e)`);
  assert.deepEqual(out, ['unreachable | down', 'tool_error | bad', 'reconnect_needed | sign in', 'not_connected | not_connected',
    'tool_error | quota', 'bad_answer | expected {"status": "ready" | "timeout"}, got \'{"status": "later"}\'']);
});

test('testWatchErrorObject', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(error={"code": "servicenow_error", "message": "down"})])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)`);
  assert.deepEqual(out, ['tool_error | down']);
});

/** Plan task 8: a refused connection comes back as an isError result marked transport_error: "server unreachable". */
test('testTheClientsTransportFailureIsUnreachable', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([{"isError": True, "transport_error": True, "content": [{"type": "text", "text": "[Errno 61] Connection refused"}]}])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)`);
  assert.deepEqual(out, ['unreachable | [Errno 61] Connection refused']);
  assert.ok(LangGraphRuntime.mcpClientBlock().includes('return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}'));
});

test('testBackoffDoublesToFiveMinutesAndResets', { skip: NO_PY }, () => {
  py(String.raw`MCP = FakeMcp([OSError("down")] * 6 + [ok(status="timeout"), OSError("down")])
c = Clock()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now).run(calls=8)
assert c.slept == [30, 60, 120, 240, 300, 300, 30], c.slept
print("ok")`);
});

test('testReconnectNeededShowsTheServerMessage', { skip: NO_PY }, () => {
  py(String.raw`MCP = FakeMcp([ok(error="reconnect_needed", message="sign in again at http://127.0.0.1:8770/connect")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=1)
assert st.line == "Not listening: sign in again at http://127.0.0.1:8770/connect — retrying in 30 s", st.line
assert st.tone == "err"
print("ok")`);
});

test('testFallbackPrintedOnceAndBadAnswer', { skip: NO_PY }, () => {
  py(String.raw`MCP = FakeMcp([ok(status="timeout", via="fallback"), ok(status="timeout", via="fallback"), ok(nope=1)])
c = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=3)
assert seen.count("Listening (checks every 15 min)") == 1, seen
assert seen[-1].startswith("Not listening: ") and st.tone == "err", seen
print("ok")`);
});

test('testACrashingRunDoesNotStopTheLoop', { skip: NO_PY }, () => {
  py(String.raw`def boom():
    raise RuntimeError("model down")
MCP = FakeMcp([ok(status="ready"), ok(status="timeout")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, boom, drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=2)
assert st.line == "Listening — the last run failed" and st.tone == "warn", st.line
print("ok")`);
});

test('testRunCapAbandonsALongRun', { skip: NO_PY }, () => {
  py(String.raw`import threading
gate = threading.Event()
def slow():
    gate.wait(5)
    return "late"
line = drain(slow, drains=False, max_runs=1, run_cap_s=0.2)
gate.set()
assert line == "abandoned a run after 30 min", line
print("ok")`);
});

test('testSecondCopyExits', { skip: NO_PY }, () => {
  py(String.raw`import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
with SingleInstance(p):
    code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
    assert code != 0, "the lock must be held"
code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
assert code == 0, "released on exit"
print("ok")`);
});

test('testASecondRunWatchOnTheSameLockSaysSoAndExitsZero', { skip: NO_PY }, () => {
  const out = py(String.raw`import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
hold = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(5)", p], stdout=subprocess.PIPE, text=True)
hold.stdout.readline()
try:
    run_watch(TRIGGER, runner([]), drains=True, lock_path=p, calls=1)
except SystemExit as e:
    print("exit", e.code)
hold.kill()`);
  assert.deepEqual(out.filter((l) => l.includes('waiting on')), []);
  assert.ok(out.join('\n').includes('[watch] already running ('));
  assert.ok(out.includes('exit 0'));
});

/** Final review M-c: the Listener's banner prints once the lock is held; a second copy prints only "already running". */
test('testTheListenerBannerFollowsTheLock', { skip: NO_PY }, () => {
  const [rc, out] = runPy(LangGraphRuntime.listenerBlock() + String.raw`import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
clock = Clock()
for mode in ("watch", "cron"):
    MCP = FakeMcp([ok(status="timeout")])
    L = Listener(mode, runner([]), drains=True, loop=None, cron_expr="0 0 1 1 *" if mode == "cron" else None,
                 trigger=TRIGGER if mode == "watch" else None, state=LoopState(), lock_path=p)
    if mode == "watch":
        run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=1, lock_path=p,
                  state=L.state, banner=L.banner())
    print("second copy")
    hold = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(5)", p], stdout=subprocess.PIPE, text=True)
    hold.stdout.readline()
    try:
        L.run_blocking()
    except SystemExit as e:
        print("exit", e.code)
    hold.kill(); hold.wait()`);
  assert.equal(rc, 0, out.join('\n'));
  assert.deepEqual(out.map((l) => l.replace(/\(\/.*$/, '(').replace(/^\[cron \d\d:\d\d\]/, '[cron HH:MM]')), [
    'Listening for events: outlook.wait_for_new {"args":{"folder":"Inbox"}} (Ctrl-C to stop)',
    '[watch 09:00] Listening for events', 'second copy', '[watch 09:00] Not listening: already running (', 'exit 0',
    'second copy', '[cron HH:MM] Not listening: already running (', 'exit 0',
  ]);
});

test('testCtrlCDuringARunLetsItFinish', { skip: NO_PY }, () => {
  const out = py(String.raw`import threading, _thread
done = []
def run_once():
    threading.Timer(0.05, _thread.interrupt_main).start()
    time.sleep(0.3)
    done.append(1)
    return ""
MCP = FakeMcp([ok(status="ready")] + [ok(status="timeout")] * 5)
c = Clock()
WatchLoop(TRIGGER, run_once, drains=False, max_runs=1, sleep=c.sleep, now=c.now).run(calls=3)
assert done == [1], done
print("ok")`);
  assert.deepEqual(out.slice(-2), ['[watch] stopped.', 'ok']);
});

test('testInAThreadAStopEventEndsTheLoopAndNoSignalHandlerIsInstalled', { skip: NO_PY }, () => {
  const out = py(String.raw`before = signal.getsignal(signal.SIGTERM)
stop = threading.Event()
st = LoopState()
calls = []
class Mcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(threading.current_thread() is threading.main_thread())
        if len(calls) == 3:
            stop.set()
        return ok(status="timeout")
MCP = Mcp()
t = threading.Thread(target=run_watch, args=(TRIGGER, runner([])), kwargs=dict(drains=True, state=st, stop=stop), daemon=True)
t.start(); t.join(5)
print("alive", t.is_alive(), "calls", calls, "handler kept", signal.getsignal(signal.SIGTERM) is before, "listening", st.listening)`);
  assert.deepEqual(out.slice(-2), ['[watch] stopped.', 'alive False calls [False, False, False] handler kept True listening False']);
});

test('testABackoffSleepEndsAtOnceOnStop', { skip: NO_PY }, () => {
  const out = py(String.raw`stop = threading.Event()
MCP = FakeMcp([OSError("down")])
threading.Timer(0.2, stop.set).start()
t0 = time.monotonic()
run_watch(TRIGGER, runner([]), drains=True, stop=stop)
print("quick", time.monotonic() - t0 < 5)`);
  assert.equal(out[out.length - 1], 'quick True');
});

test('testEventsOffListensOnTheFifteenMinuteCheckAndPrintsItOnce', { skip: NO_PY }, () => {
  const out = py(String.raw`off = dict(events="off", reason="EVENTHUB_NOTIFICATION_URL is not set")
MCP = FakeMcp([ok(status="timeout", **off), ok(status="timeout", **off), ok(status="timeout", events="on")])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)`);
  assert.deepEqual(out, [
    '[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
    '[watch 09:00] Listening (checks every 15 min)',
    '[watch 09:00] Listening for events',
  ]);
});

test('testAnErrorRunIsReportedAndTheLoopGoesOn', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 1:
        raise RuntimeError("Jev down")
    return ""
run_watch(TRIGGER, run_once, drains=True, sleep=clock.sleep, now=clock.now, calls=2)`);
  assert.equal(out[1], '[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down');
  assert.equal(out[2], '[watch 09:00] Listening — the last run failed');
  assert.equal(out[3], '[watch 09:00] Listening for events');
  assert.equal(out.length, 4);
});

test('testCtrlCStops', { skip: NO_PY }, () => {
  const out = py(String.raw`MCP = FakeMcp([KeyboardInterrupt()])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now)
print("after")`);
  assert.deepEqual(out, ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '', '[watch] stopped.', 'after']);
});

test('testCliTriggerFallsBackToTheBakedOneAndRefusesBadInput', { skip: NO_PY }, () => {
  const out = py(String.raw`ap = argparse.ArgumentParser(prog="wf")
baked = {"server": "outlook", "tool": "wait_for_new", "args": {"args": {"folder": "Inbox"}}}
print(WatchTrigger.from_cli(ap, None, baked))
t = WatchTrigger.from_cli(ap, "", baked)
print(t, t.args)
t = WatchTrigger.from_cli(ap, 'outlook.wait_for_new {"timeout_s": 30}', None)
print(t, t.args, t.url())`);
  assert.deepEqual(out, ['None', "outlook.wait_for_new {'args': {'folder': 'Inbox'}}",
    "outlook.wait_for_new {'timeout_s': 30} http://mail.local/mcp"]);
  const cases: Record<string, string> = {
    '"", None': 'this workflow has no event trigger',
    '"drive.wait", None': "MCP server 'drive' is not used by this workflow (its servers: outlook); set the environment variable MCP_URL_DRIVE if the server moved",
    '"outlook", None': 'expected server.tool',
    '"outlook.wait {x", None': 'the arguments are not JSON',
    '"outlook.wait [1]", None': 'must be a JSON object',
  };
  for (const [args, msg] of Object.entries(cases)) {
    const [rc, lines] = runPy(`WatchTrigger.from_cli(argparse.ArgumentParser(prog='wf'), ${args})\n`);
    assert.equal(rc, 2, args);
    assert.ok(lines.join('\n').includes(msg), args);
  }
});

// ---------- the generator: DEFAULT_WATCH, the loop, the flag and the docs ----------

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

/** Workflow 44 polls ServiceNow; trigger: its event_trigger JSON (null: no row; false: no event_trigger column). */
function pdo(trigger: string | null | false, status = 'pending'): string[] {
  const s = [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
    "INSERT INTO mcp_servers VALUES (86, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 86, 'wait_for_new', 'Wait', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
  ];
  if (trigger === false) {
    s.push('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)');
  } else {
    s.push('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
    s.push("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '*/2 * * * *', 'pending', NULL)");
    if (trigger !== null) {
      s.push(`INSERT INTO scheduled_workflows VALUES (2, 44, 'event', NULL, ${q(status)}, ${q(trigger)})`);
    }
  }
  return s;
}

function codeGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'poll' } },
      { id: '2', node_type: 'code', config: { type: 'code', name: 'Poll ServiceNow',
        code: "def run(input, call_tool):\n    return {'route': 'job', 'output': 'x'}\n",
        exits: ['job', 'error'], mcp_servers: ['ServiceNow'], timeout_s: 30 } },
      { id: '3', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
  };
}

async function generate(statements: string[], options: any = {}, graph: any = null): Promise<any> {
  sqlite(statements);
  return makeGenerator({ workflow: { id: 44, name: 'Mail poll', user_id: '3' }, graph: graph ?? codeGraph() }).generate(44, '3', options);
}

function assertWatchEntry(code: string, label: string, dflt: string, file: string): void {
  assert.ok(code.includes(`DEFAULT_WATCH = ${dflt}\n`), label);
  assert.equal(code.split('def run_watch(').length - 1, 1, label);
  assert.ok(code.includes('when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER"'), label);
  assert.ok(code.includes('watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)'), label);
  assert.ok(code.includes('Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),'), label);
  assert.ok(code.includes('run_watch(self.trigger, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,'), label);
  assert.ok(code.includes(`python ${file} --watch `), label);
  if (PY !== null) {
    const [rc, out] = runFile(code, ['-m', 'py_compile']);
    assert.equal(rc, 0, `${label}: ` + out.join('\n'));
  }
}

test('testSingleFileBakesTheEventTrigger', { skip: NO_PY }, async () => {
  const code = (await generate(pdo('{"server": "ServiceNow", "tool": "wait_jobs", "args": {"queue": "it"}}'))).code;
  assertWatchEntry(code, 'single', '{\n    "server": "servicenow",\n    "tool": "wait_jobs",\n    "args": {\n        "queue": "it"\n    }\n}', 'mail_poll_langgraph.py');
  assert.ok(code.includes('--watch           # run whenever the event trigger says something new arrived (servicenow.wait_jobs)'));
});

test('testModularWorkflowPyRunsTheWatchLoop', { skip: NO_PY }, async () => {
  const files: Record<string, string> = {};
  for (const f of (await generate(pdo('{"server": "ServiceNow", "tool": "wait_jobs"}'), { modular: true })).files) files[f.path] = f.code;
  const wf = files['workflow.py'];
  assertWatchEntry(wf, 'modular', '{\n    "server": "servicenow",\n    "tool": "wait_jobs",\n    "args": {}\n}', 'workflow.py');
  assert.ok(wf.includes('from common import EVENTS, MCP, MCP_SERVER_SLUGS, '));
  assert.match(wf, /^import argparse, asyncio, json, /m);
  assert.ok(files['common.py'].includes('MCP_SERVER_SLUGS = '));
});

test('testNoTriggerBakesNone', async () => {
  const cases: Record<string, string[]> = {
    'no row': pdo(null), paused: pdo('{"server": "ServiceNow", "tool": "w"}', 'paused'),
    'no column': pdo(false), 'no tool': pdo('{"server": "ServiceNow"}'),
  };
  for (const [name, statements] of Object.entries(cases)) {
    const code = (await generate(statements)).code;
    assert.ok(code.includes('DEFAULT_WATCH = None\n'), name);
    assert.ok(code.includes('--watch           # run whenever the event trigger says something new arrived (none saved: pass one)'), name);
  }
});

test('testATriggerOnAServerNoNodeUsesIsRefused', async () => {
  await assert.rejects(() => generate(pdo('{"server": "Outlook", "tool": "wait_for_new"}')),
    (e: any) => e instanceof Error && e.message.includes('The event trigger waits on MCP server "Outlook", which no node of this workflow uses'));
});

test('testA2AAndSwarmHaveNoWatch', async () => {
  const files: Record<string, string> = {};
  for (const f of (await generate(pdo(null), { a2a: true }, a2aGraph())).files) files[f.path] = f.code;
  assert.ok('orchestrator.py' in files);
  for (const [p, code] of Object.entries(files)) {
    assert.ok(!code.includes('add_argument("--watch"'), p);
    assert.ok(!code.includes('def run_watch('), p);
    assert.ok(!code.includes('DEFAULT_WATCH'), p);
  }
});
