/**
 * Port of backend/tests/Unit/LangGraphCronLoopTest.php. spec 2026-10-07 §7.2: the compiled loop, with
 * CronExpression's semantics (src/AgentTeam/CronExpression.ts, the port of CronExpression.php).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { CronExpression, parseSqlDateTime } from '../src/AgentTeam/CronExpression';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { a2aGraph, execPy, lgFiles, lgGenerator, pyCompile, runPySource } from './support/lgFixtures';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function python(): string | null {
  const py = isExecutable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
  const r = execPy(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
  return r.rc === 0 ? py : null;
}
const PY = python();
const noPy = PY === null ? 'Python 3.10+ not available' : false;

/** A fake clock: sleep(s) moves now() forward by s (plus `jump` seconds once, e.g. a laptop asleep). */
const CLOCK = `class Clock:
    def __init__(self, *args, jump=0):
        self.t, self.slept, self.jump = datetime(*args), [], jump
    def now(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s)
        self.t += timedelta(seconds=s + self.jump)
        self.jump = 0

`;

/** Run cronBlock() plus tail with the imports an entry file gives it; returns [exit code, output lines]. */
function runPy(tail: string): [number, string[]] {
  const r = runPySource(
    PY as string,
    'from __future__ import annotations\nimport argparse, asyncio, re, signal, time\nfrom datetime import datetime, timedelta\n' +
      LangGraphRuntime.cronBlock() + '\n' + CLOCK + tail,
  );
  return [r.rc, r.out];
}

function py(tail: string): string[] {
  const [rc, out] = runPy(tail);
  assert.equal(rc, 0, out.join('\n'));
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymdHi = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

test('testNextFireMatchesThePhpParser', { skip: noPy }, () => {
  const cases: Array<[string, string]> = [
    ['*/2 * * * *', '2026-10-07 10:42:30'], ['*/5 8-18 * * 1-5', '2026-10-09 18:57:00'],
    ['0 9 * * 7', '2026-10-07 00:00:00'], ['0 9 * * 0', '2026-10-07 00:00:00'],
    ['0 0 1 * 1', '2026-10-07 00:00:00'], ['0 0 */2 * 1', '2026-10-07 00:00:00'],
    ['0 0 * * */2', '2026-10-07 00:00:00'], ['5,35 9-17/4 * * *', '2026-10-07 13:36:00'],
    ['5/20 * * * *', '2026-10-07 10:46:00'], ['0 0 1 * *', '2026-10-31 23:59:59'],
    ['59 23 31 * *', '2026-11-01 00:00:00'], ['0 0 29 2 *', '2026-10-07 00:00:00'],
    ['30 12 29 2 1', '2027-02-27 00:00:00'], ['15 10 * * *', '2026-12-31 10:15:00'],
    ['  0   0  1 1  * ', '2026-10-07 00:00:00'], ['0-59/15 */6 1-7 1,7 1-5', '2026-10-07 00:00:00'],
  ];
  let tail = '';
  for (const [e, at] of cases) {
    tail += 'print(cron_next(' + JSON.stringify(e) + `, datetime.fromisoformat('${at}')).strftime('%Y-%m-%d %H:%M'))\n`;
  }
  const out = py(tail);
  cases.forEach(([e, at], i) => {
    const ts = ymdHi(new CronExpression(e).nextAfter(parseSqlDateTime(at)));
    assert.equal(out[i] ?? null, ts, `${e} after ${at}`);
  });
});

test('testInvalidExpressionsAreRefusedLikeThePhpParser', { skip: noPy }, () => {
  const exprs = ['* * * *', '* * * * * *', '', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
    '5-1 * * * *', '*/0 * * * *', '+5 * * * *', 'a * * * *', '1-2-3 * * * *', '5/ * * * *', ',5 * * * *',
    '0 0 31 2 *', '0 0 30 2 *', '*/2 * * * *', '0 9 * * 7'];
  let tail = '';
  for (const e of exprs) {
    tail += "try:\n    cron_next(" + JSON.stringify(e) + ", datetime(2026, 10, 7))\n    print('ok')\nexcept ValueError:\n    print('bad')\n";
  }
  const out = py(tail);
  exprs.forEach((e, i) => {
    assert.equal(out[i] ?? null, CronExpression.isValid(e) ? 'ok' : 'bad', `'${e}'`);
  });
});

test('testDrainsQuietAndSurvivesErrors', { skip: noPy }, () => {
  const out = py(String.raw`outputs = iter(["mail 1", "mail 2", "", "boom", ""])
def run_once():
    o = next(outputs)
    if o == "boom":
        raise RuntimeError("reconnect_needed")
    return o
c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=3, verbosity="verbose")   # verbose: a quiet tick says so
print("sleeps", len(c.slept))`);
  const text = out.join('\n');
  assert.ok(text.includes('2 run(s) did work'), text); // tick 1: mail 1, mail 2, then quiet
  assert.ok(text.includes('reconnect_needed'), text); // tick 2: error logged, loop continues
  assert.ok(text.includes('nothing to do'), text); // tick 3: quiet
  assert.ok(text.includes('sleeps 6'), text); // 90 s, then 120 s twice, in naps of <= 60 s
});

/** Final review I1: a tick with nothing to do prints no [tick] line (but under --verbose); work and errors do. */
test('testAQuietTickPrintsNothing', { skip: noPy }, () => {
  const out = py(String.raw`outputs = iter(["", "", "mail", "", "boom"])
def run_once():
    o = next(outputs)
    if o == "boom":
        raise RuntimeError("down")
    return o
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=4)
print("verbose")
run_cron("* * * * *", lambda: "", drains=True, sleep=c.sleep, now=c.now, ticks=1, verbosity="verbose")
print("quiet")
run_cron("* * * * *", lambda: "mail", drains=False, sleep=c.sleep, now=c.now, ticks=1, verbosity="quiet")`);
  assert.deepEqual(out, [
    "[cron] '* * * * *': next run 2026-10-07 10:01. Ctrl-C to stop.",
    '[tick 10:03] 1 run(s) did work', '[tick 10:04] error after 0 run(s) that did work: RuntimeError: down',
    'verbose', "[cron] '* * * * *': next run 2026-10-07 10:05. Ctrl-C to stop.", '[tick 10:05] nothing to do',
    'quiet', "[cron] '* * * * *': next run 2026-10-07 10:06. Ctrl-C to stop.",
  ]);
});

test('testNoDrainWithoutCodeNodes', { skip: noPy }, () => {
  const out = py(String.raw`n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "report", drains=False, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))`);
  assert.ok(out.includes('runs 1'), out.join('\n'));
});

test('testDrainStopsAtTwentyRunsPerTick', { skip: noPy }, () => {
  const out = py(String.raw`n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "mail", drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))`);
  assert.ok(out.includes('runs 20'), out.join('\n'));
  assert.ok(out.join('\n').includes('20 run(s) did work'));
});

test('testAnErrorAfterWorkIsLoggedAndEndsTheDrain', { skip: noPy }, () => {
  const out = py(String.raw`calls = []
def run_once():
    calls.append(1)
    if len(calls) == 2:
        raise RuntimeError("code node 'Poll Outlook' took its error exit")
    return "mail"
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(calls))`);
  const text = out.join('\n');
  assert.ok(out.includes('runs 2'), text);
  assert.ok(text.includes("error after 1 run(s) that did work: RuntimeError: code node 'Poll Outlook' took its error exit"), text);
  assert.ok(!text.includes('nothing to do'), text);
});

test('testTicksFireOnTheScheduleInNapsOfAMinuteAtMost', { skip: noPy }, () => {
  const out = py(String.raw`c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", lambda: "", drains=True, sleep=c.sleep, now=c.now, ticks=3, verbosity="verbose")   # verbose: a quiet tick says so
print(c.slept)`);
  // first fire 10:44 (90 s away), then 10:46 and 10:48; the clock is re-read after every nap
  assert.equal(out[out.length - 1], '[60.0, 30.0, 60.0, 60.0, 60.0, 60.0]');
  assert.ok(out.join('\n').includes('[tick 10:44] nothing to do'));
  assert.ok(out.join('\n').includes('[tick 10:48] nothing to do'));
});

test('testAClockJumpDuringANapFiresWithoutSleepingTheOldGap', { skip: noPy }, () => {
  const out = py(String.raw`c = Clock(2026, 10, 7, 10, 0, 30, jump=3600)   # the first nap lasts an hour (laptop asleep, DST change)
run_cron("*/30 * * * *", lambda: "", drains=False, sleep=c.sleep, now=c.now, ticks=2, verbosity="verbose")   # verbose: a quiet tick says so
print(c.slept)`);
  // due 10:30: one nap, then the clock reads 11:01:30 -> fire at once; the next fire is 11:30
  assert.equal(
    out[out.length - 1],
    '[60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 30.0]',
  );
  assert.ok(out.join('\n').includes('[tick 10:30] nothing to do'));
  assert.ok(out.join('\n').includes('[tick 11:30] nothing to do'));
});

test('testSigtermStopsTheLoopLikeCtrlC', { skip: noPy }, () => {
  const out = py(String.raw`import os, threading
before = signal.getsignal(signal.SIGTERM)
threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
try:
    run_cron("0 0 1 1 *", lambda: "", drains=False)
finally:
    print("finally ran")
print("handler restored", signal.getsignal(signal.SIGTERM) is before)`);
  assert.deepEqual(out.slice(-3), ['[cron] stopped.', 'finally ran', 'handler restored True']);
});

test('testACancelledRunIsAnErrorAndItsLeftoverTasksAreCancelled', { skip: noPy }, () => {
  const out = py(String.raw`runs = RunLoop()
loop = runs.loop
started = []
async def bad_run():
    started.append(loop.create_task(asyncio.sleep(1000)))   # a task the failed run leaves behind
    await asyncio.sleep(0)
    raise asyncio.CancelledError()
outputs = iter(["cancel", ""])
def run_once():
    if next(outputs) == "cancel":
        return loop.run_until_complete(bad_run())
    print("pending before run 2:", len([t for t in asyncio.all_tasks(loop) if not t.done()]))
    return ""
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=2, loop=runs, verbosity="verbose")   # verbose: a quiet tick says so
print("leftover cancelled", started[0].cancelled())`);
  const text = out.join('\n');
  assert.ok(text.includes('[tick 10:01] error after 0 run(s) that did work: CancelledError'), text);
  assert.ok(out.includes('pending before run 2: 0'), text);
  assert.ok(text.includes('[tick 10:02] nothing to do'), text);
  assert.ok(out.includes('leftover cancelled True'), text);
});

test('testDrainReturnsTheErrorLineWhenARunRaises', { skip: noPy }, () => {
  const out = py(String.raw`def run_once():
    raise RuntimeError("model down")
print(drain(run_once, drains=True, max_runs=20))`);
  assert.deepEqual(out, ['error after 0 run(s) that did work: RuntimeError: model down']);
});

test('testEachRunAndItsEventLoopStayOnOneWorkerThread', { skip: noPy }, () => {
  const out = py(String.raw`import threading
runs = RunLoop()
loop = runs.loop
threads = []
async def bad_run():
    threads.append(threading.current_thread())
    loop.create_task(asyncio.sleep(1000))
    raise RuntimeError("boom")
def run_once():
    threads.append(threading.current_thread())
    return runs.loop.run_until_complete(bad_run())
orig = cancel_leftovers
def spy(l):
    threads.append(threading.current_thread())
    orig(l)
cancel_leftovers = spy
print(drain(run_once, drains=True, max_runs=20, loop=runs))
print("off main", all(t is not threading.main_thread() for t in threads), "one thread", len(set(threads)) == 1, len(threads))
print("pending", len([t for t in asyncio.all_tasks(loop) if not t.done()]), "same loop", runs.loop is loop)`);
  assert.deepEqual(out, ['error after 0 run(s) that did work: RuntimeError: boom', 'off main True one thread True 3', 'pending 0 same loop True']);
});

test('testAnAbandonedRunKeepsItsLoopAndTheNextRunGetsAFreshOne', { skip: noPy }, () => {
  const out = py(String.raw`import threading
runs = RunLoop()
first = runs.loop
gate = threading.Event()
cancelled_on = []
orig = cancel_leftovers
def spy(l):
    cancelled_on.append(l)
    orig(l)
cancel_leftovers = spy
async def stuck():
    while not gate.is_set():
        await asyncio.sleep(0.02)
    raise RuntimeError("late failure")   # fails after the cap: its loop must not be cleaned by drain
def stuck_run():
    return runs.loop.run_until_complete(stuck())
print(drain(stuck_run, drains=False, max_runs=1, loop=runs, run_cap_s=0.2))
second = runs.loop
used = []
async def quick():
    used.append(asyncio.get_running_loop())
    return "done"
def quick_run():
    return runs.loop.run_until_complete(quick())
print(drain(quick_run, drains=False, max_runs=1, loop=runs, run_cap_s=5))
print("fresh", second is not first, "ran on fresh", used == [second], "old still busy", first.is_running())
gate.set()
for t in runs.abandoned:
    t.join(5)
print("old loop never cancelled", all(l is not first for l in cancelled_on), "abandoned threads", len(runs.abandoned))`);
  assert.deepEqual(out, ['abandoned a run after 30 min', '1 run(s) did work', 'fresh True ran on fresh True old still busy True',
    'old loop never cancelled True abandoned threads 1']);
});

test('testAFailedRunMakesTheStateWarn', { skip: noPy }, () => {
  const out = py(String.raw`outputs = iter(["boom", "", ""])
def run_once():
    if next(outputs) == "boom":
        raise RuntimeError("model down")
    return ""
st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append((s.line, s.tone)))
c = Clock(2026, 10, 7, 10, 0)
CronLoop("* * * * *", run_once, drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(ticks=1)
print(st.line, "|", st.tone, "|", st.last_failed, "|", st.listening)
print(("Scheduled — the last run failed", "warn") in seen, seen[0])`);
  assert.deepEqual(out.slice(-2), ['Scheduled — the last run failed | warn | True | False',
    "True ('Scheduled: * * * * * — next run 10:01', 'ok')"]);
  assert.ok(!out.includes('Scheduled — the last run failed'), 'cron state lines are not echoed: its [tick] line is the console');
});

test('testTheRunCapAndAStopEventInAThread', { skip: noPy }, () => {
  const out = py(String.raw`import threading
before = signal.getsignal(signal.SIGTERM)
stop = threading.Event()
gate = threading.Event()
def slow():
    gate.wait(5)
    return "late"
print(drain(slow, drains=True, max_runs=20, run_cap_s=0.2))
gate.set()
st = LoopState()
threading.Timer(0.2, stop.set).start()   # while the loop naps until 1 January: the nap ends at once
t = threading.Thread(target=run_cron, args=("0 0 1 1 *", lambda: ""), kwargs=dict(drains=False, state=st, stop=stop), daemon=True)
t.start(); t.join(5)
print("alive", t.is_alive(), "handler kept", signal.getsignal(signal.SIGTERM) is before, "listening", st.listening)`);
  assert.equal(out[0], 'abandoned a run after 30 min');
  assert.deepEqual(out.slice(-2), ['[cron] stopped.', 'alive False handler kept True listening False']);
});

test('testASecondCopyOfTheCronLoopExitsZero', { skip: noPy }, () => {
  const out = py(String.raw`import tempfile, os
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
with SingleInstance(p):
    try:
        run_cron("* * * * *", lambda: "", drains=False, lock_path=p, ticks=1)
    except SystemExit as e:
        print("exit", e.code)`);
  assert.ok(out[0].startsWith('[cron] already running ('), out[0]);
  assert.deepEqual(out.slice(1), ['exit 0']);
});

test('testCliExpressionFallsBackToTheBakedScheduleAndRefusesBadInput', { skip: noPy }, () => {
  let out = py(String.raw`ap = argparse.ArgumentParser()
print(CronExpression.from_cli(ap, None, "*/2 * * * *"))
print(CronExpression.from_cli(ap, "", "*/2 * * * *"))
print(CronExpression.from_cli(ap, "0 9 * * 1", "*/2 * * * *"))`);
  assert.deepEqual(out.slice(0, 3), ['None', '*/2 * * * *', '0 9 * * 1']);

  let rc: number;
  [rc, out] = runPy("CronExpression.from_cli(argparse.ArgumentParser(), '', None)");
  assert.equal(rc, 2);
  assert.ok(out.join('\n').includes('this workflow has no cron schedule'));
  [rc, out] = runPy("CronExpression.from_cli(argparse.ArgumentParser(), '0 0 31 2 *', None)");
  assert.equal(rc, 2);
  assert.ok(out.join('\n').includes('never fires'));
});

test('testCodeNodeErrorExitIsReportedByTheGraph', { skip: noPy }, () => {
  const out = py(
    "import json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\nEND, START, StateGraph, WFState = '__end__', '__start__', None, None\n" +
      LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() +
      String.raw`g = WorkflowGraph(edges=[], order=[], node_types={}, start_documents=[], run_node=None,
                  agents={"2": {"display": "Poll Outlook", "kind": "code"}, "5": {"display": "D", "kind": "dispatcher"}})
g.check_error_exits()
print("clean ok")
g.routes = {"2": "mail", "5": "error"}
g.check_error_exits()
print("other exits ok")
g.routes = {"2": "error"}
try:
    g.check_error_exits()
except ErrorExitTaken as e:
    print("raised", e)
g.outputs = {"2": {"source": "Poll Outlook", "text": "not_connected"}}   # the error exit's output: why the run failed
try:
    g.check_error_exits()
except ErrorExitTaken as e:
    print("raised", e, e.nodes)
g.outputs = {"2": {"source": "Poll Outlook", "text": "line one\n\n  line two\t" + "x" * 400}}   # e.g. a whole email body
try:
    g.check_error_exits()
except ErrorExitTaken as e:
    print("long", e)`,
  );
  assert.deepEqual(out.slice(0, 4), ['clean ok', 'other exits ok', "raised code node 'Poll Outlook' took its error exit",
    "raised code node 'Poll Outlook' took its error exit: not_connected ['Poll Outlook']"]);
  // a long multi-line reason (an email body, a tool error page) prints as ONE line, cut at 200 characters
  const reason = 'line one line two ' + 'x'.repeat(182);
  assert.deepEqual(out.slice(4), [`long code node 'Poll Outlook' took its error exit: ${reason}…`]);
});

// ---------- the generator: DEFAULT_CRON, the loop and the docs in every entry file ----------

/** cron: the newest schedule row of workflow 44 (null: no scheduled_workflows table); older: an older active cron row too. */
function pdo(cron: string | null, status = 'pending', older = true): string[] {
  const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const s = [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
  ];
  if (cron !== null) {
    s.push('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)');
    if (older) {
      s.push("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '0 * * * *', 'pending')");
    }
    s.push("INSERT INTO scheduled_workflows VALUES (2, 44, 'daily', NULL, 'pending')");
    s.push("INSERT INTO scheduled_workflows VALUES (3, 45, 'cron', '1 1 1 1 1', 'pending')"); // another workflow
    s.push(`INSERT INTO scheduled_workflows VALUES (4, 44, 'cron', ${q(cron)}, ${q(status)})`);
  }
  return s;
}

function codeGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'poll' } },
      {
        id: '2',
        node_type: 'code',
        config: {
          type: 'code',
          name: 'Poll ServiceNow',
          code: "def run(input, call_tool):\n    return {'route': 'job', 'output': 'x'}\n",
          exits: ['job', 'error'],
          mcp_servers: ['ServiceNow'],
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

async function generate(sqlStatements: string[], graph: any, options: any = {}, orchestration = 'workflow'): Promise<any> {
  const gen = lgGenerator({ sql: sqlStatements, workflow: { id: 44, name: 'Mail poll', user_id: '3', orchestration }, graph });
  return gen.generate(44, '3', options);
}

function assertCompiles(code: string, label: string): void {
  const r = pyCompile(code, PY as string);
  assert.equal(r.rc, 0, `${label}: ${r.out.join('\n')}`);
}

function substrCount(h: string, n: string): number {
  return h.split(n).length - 1;
}

/** The entry file's cron pieces: baked default, imports, the loop, the CLI flag and its docs. watch: an entry
 *  with --watch too (single file, modular), where --cron sits in a mutually exclusive group and drains is a name. */
function assertCronEntry(code: string, label: string, def: string, drains: string, file: string, watch = false): void {
  assert.ok(code.includes(`DEFAULT_CRON = ${def}\n`), label);
  assert.match(code, /^from datetime import datetime, timedelta$/m, label);
  assert.match(code, /^import argparse, /m, label);
  assert.equal(substrCount(code, 'def run_cron('), 1, label);
  assert.ok(code.includes((watch ? 'when' : 'ap') + '.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR"'), label);
  if (watch) {
    // single file / modular: the Start's mode decides, and the loop runs in a Listener (standalone task 6)
    assert.ok(code.includes('CronExpression.from_cli(ap, a.cron if a.cron is not None else ("" if mode == "cron" else None), DEFAULT_CRON)'), label);
    assert.ok(code.includes(`    drains = ${drains}\n`), label);
    assert.ok(code.includes('Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),'), label);
    assert.ok(code.includes('run_cron(self.cron_expr, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,'), label);
  } else {
    assert.ok(code.includes('CronExpression.from_cli(ap, a.cron, DEFAULT_CRON)'), label);
    assert.ok(code.includes(`run_cron(expr, run_once, drains=${drains}, loop=runs)`), label);
  }
  assert.match(code, /^import argparse, asyncio, [a-z, ]*\bsignal\b/m, label);
  assert.ok(code.includes('allow_abbrev=False)'), label); // --cron is never guessed from a prefix
  assert.ok(code.includes(`python ${file} "your prompt here" --cron   # a prompt goes BEFORE --cron`), label);
  // every run starts with a clean RUN SUMMARY (the swarm has no per-node times)
  assert.match(code, /def run_once\(\) -> str:\n(?: {8}[^\n]*\n)*? {8}(?:NODE_DURATIONS\.clear\(\)|session = uuid)/, label);
  assert.ok(code.includes(`python ${file} --cron `), label);
  assert.ok(code.includes(`python ${file} --cron "*/5 8-18 * * 1-5"`), label);
  assertCompiles(code, label);
}

test('testSingleFileBakesTheNewestActiveCronSchedule', { skip: noPy }, async () => {
  const code = (await generate(pdo('*/5 8-18 * * 1-5'), codeGraph()))['code'];
  assertCronEntry(code, 'single', '"*/5 8-18 * * 1-5"', 'bool(CODE_NODES)', 'mail_poll_langgraph.py', true);
  assert.ok(code.includes('python mail_poll_langgraph.py --cron            # loop on the Start node schedule (*/5 8-18 * * 1-5)'));
  assert.ok(code.includes('graph.check_error_exits()'));
});

test('testTheDocsSayWhatWorkMeansForADrain', async () => {
  const line = 'needs an Output node to drain';
  const code = (await generate(pdo('*/2 * * * *'), codeGraph()))['code'];
  assert.ok(code.includes('work = a non-empty final output'));
  assert.ok(code.includes(line));
  const files = lgFiles(await generate(pdo('*/2 * * * *'), codeGraph(), { modular: true }));
  assert.ok(files['workflow.py'].includes(line));
  // no code node, no drain: not documented
  const a2a = lgFiles(await generate(pdo('*/2 * * * *'), a2aGraph(), { a2a: true }));
  assert.ok(!a2a['orchestrator.py'].includes(line));
});

test('testAPausedNewestScheduleFallsBackToTheOlderActiveOne', async () => {
  const code = (await generate(pdo('*/2 * * * *', 'paused'), codeGraph()))['code'];
  assert.ok(code.includes('DEFAULT_CRON = "0 * * * *"\n'));
});

test('testNoScheduleBakesNone', async () => {
  const cases = [pdo(null), pdo('*/2 * * * *', 'paused', false)];
  for (let i = 0; i < cases.length; i++) {
    const code = (await generate(cases[i], codeGraph()))['code'];
    assert.ok(code.includes('DEFAULT_CRON = None\n'), `case ${i}`);
    assert.ok(code.includes('--cron            # loop on the Start node schedule (none saved: pass an expression)'), `case ${i}`);
  }
});

test('testModularWorkflowPyRunsTheLoop', { skip: noPy }, async () => {
  const files = lgFiles(await generate(pdo('*/2 * * * *'), codeGraph(), { modular: true }));
  assertCronEntry(files['workflow.py'], 'modular', '"*/2 * * * *"', 'any(ad["kind"] == "code" for ad in AGENTS.values())', 'workflow.py', true);
  assert.ok(files['workflow.py'].includes('graph.check_error_exits()'));
  assert.ok(!files['common.py'].includes('def run_cron('));
});

test('testA2AOrchestratorRunsTheLoopWithOneSupervisor', { skip: noPy }, async () => {
  const files = lgFiles(await generate(pdo('*/2 * * * *'), a2aGraph(), { a2a: true }));
  const orch = files['orchestrator.py'];
  assertCronEntry(orch, 'a2a', '"*/2 * * * *"', 'False', 'orchestrator.py');
  assert.equal(substrCount(orch, 'sup.start()'), 1);
  assert.ok(orch.indexOf('CronExpression.from_cli(') < orch.indexOf('sup = AgentSupervisor('), 'a bad --cron is refused before any agent is started');
});

test('testSwarmWorkflowPyRunsTheLoop', { skip: noPy }, async () => {
  const agent = (name: string) => ({
    type: 'agent-template', agent_name: name, agent_type: 'standard', instructions: `You are ${name}.`,
    agent_provider: 'claude', model: 'claude-sonnet-4-6', tools: [], settings: { temperature: 0.7, max_tokens: 4096 },
  });
  const graph = {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'Plan a trip.' } },
      { id: '2', node_type: '', config: agent('Alice') },
      { id: '3', node_type: '', config: agent('Bob') },
    ],
    edges: [
      { from: '1', to: '2' },
      { from: '1', to: '3' },
    ],
  };
  const files = lgFiles(await generate(pdo('*/2 * * * *'), graph, { modular: true }, 'swarm'));
  assertCronEntry(files['workflow.py'], 'swarm', '"*/2 * * * *"', 'False', 'workflow.py');
  assert.ok(files['workflow.py'].includes('_GRAPH.checkpointer.delete_thread(session)'));
});
