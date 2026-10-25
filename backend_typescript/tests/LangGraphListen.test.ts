/**
 * Port of backend/tests/Unit/LangGraphListenTest.php. Standalone plan task 8: api.py listens (POST /listen, --listen)
 * and streams its runs (GET /live) like SynergyAI's /live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
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

function python(): string | null {
  const py = isExecutable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
  const r = execPy(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
  return r.rc === 0 ? py : null;
}
const PY = python();
const noPy = PY === null ? 'Python 3.10+ not available' : false;
const noVenv = !existsSync(VENV) ? 'venv python missing' : false;
const noE2E = process.env.CODE_NODE_E2E !== '1' ? 'set CODE_NODE_E2E=1 to serve api.py' : noVenv;

/** runRecordBlock + liveFeedBlock, then tail; asserts exit 0 and a last line "ok". */
function py(tail: string): string[] {
  const r = runPySource(
    PY as string,
    'from __future__ import annotations\n' +
      'import json, os, re, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n' +
      LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.liveFeedBlock() + '\n' + tail,
  );
  assert.equal(r.rc, 0, r.out.join('\n'));
  assert.equal(r.out[r.out.length - 1], 'ok', r.out.join('\n'));
  return r.out;
}

test('testFeedRules', { skip: noPy }, () => {
  py(String.raw`import tempfile
d = tempfile.mkdtemp()
assert live_next(d, None) == ([], None)                                   # no pointer (Review Focus 3)
r = RunRecorder(d, 44, "W")
rid = r.begin(); r.node_start("1000000017", "T", "code")
ev, cur = live_next(d, None)
assert ev == [] and cur is None                                            # in progress but not real yet: held back
r.node_complete("1000000017", "T", "code", exit="new_mail"); r.node_start("21", "jev", "agent")
ev, cur = live_next(d, None)
assert [e["type"] for e in ev] == ["workflow_start", "node_start", "node_complete", "node_start"] and cur == f"{rid}:4"
r.node_complete("21", "jev", "agent", output="x")
ev, cur = live_next(d, cur)
assert [e["type"] for e in ev] == ["node_complete"] and cur == f"{rid}:5"
r.complete(success=True, output="done"); r.end(quiet=False)
rid2 = r.begin(); r.node_start("1000000017", "T", "code"); r.node_complete("1000000017", "T", "code", exit="no_mail"); r.complete(success=True); r.end(quiet=True)
ev, cur2 = live_next(d, cur)                                               # previous tail first; the quiet run is gone
assert [e["type"] for e in ev] == ["workflow_complete"] and cur2 == f"{rid}:6", (ev, cur2)
assert live_next(d, f"{'0'*32}:3") == ([], f"{'0'*32}:3")                 # unknown run in the cursor
ev, _ = live_next(d, None)
assert ev == []                                                            # first connect after a finished run: nothing
print("ok")`);
});

/** The rest of LiveFeedTest's cases, over files written by hand (the server's own event shapes). */
test('testTheServersOtherFeedRules', { skip: noPy }, () => {
  py(String.raw`import tempfile
A, B = "a" * 32, "b" * 32
WORK = {"node_start": {"type": "node_start", "node_id": 2598, "node_type": "agent"},
        "node_complete": {"type": "node_complete", "node_id": 2598, "node_type": "agent"}}
QUIET = [{"type": "workflow_start"}, {"type": "node_start", "node_id": 2597, "node_type": "start"},
         {"type": "node_complete", "node_id": 2597, "node_type": "start"},
         {"type": "node_start", "node_id": "1000002597", "node_type": "code"},
         {"type": "node_log", "node_id": "1000002597", "message": "poll ok"},
         {"type": "node_complete", "node_id": "1000002597", "node_type": "code"}]
def path(d, rid): return os.path.join(d, f"2026-10-16_09-00-00_{rid}.jsonl")
def append(d, rid, types):
    with open(path(d, rid), "a") as fh:
        for t in types:
            fh.write(json.dumps(t if isinstance(t, dict) else WORK.get(t, {"type": t})) + "\n")
def start(d, rid, types):
    with open(os.path.join(d, "current"), "w") as fh:
        fh.write(f"2026-10-16_09-00-00_{rid}")
    append(d, rid, types)
def types(r): return [e["type"] for e in r[0]]

d = tempfile.mkdtemp()                                   # first connect skips a finished run
start(d, A, ["workflow_start", "node_start", "workflow_complete"])
assert live_next(d, None) == ([], f"{A}:3")

d = tempfile.mkdtemp()                                   # a failed run is finished
start(d, A, ["workflow_start", "workflow_error"])
assert live_next(d, None)[0] == []

d = tempfile.mkdtemp()                                   # a new run is read from the start
start(d, A, ["workflow_start", "workflow_complete"]); start(d, B, ["workflow_start", "node_start", "workflow_complete"])
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_start", "node_start", "workflow_complete"] and r[1] == f"{B}:3"

d = tempfile.mkdtemp()                                   # a partial last line waits
start(d, A, ["workflow_start", "node_start"])
with open(path(d, A), "a") as fh:
    fh.write('{"type":"node_co')
r = live_next(d, None)
assert types(r) == ["workflow_start", "node_start"] and r[1] == f"{A}:2"
assert types(live_next(d, "nonsense")) == ["workflow_start", "node_start"]     # a bad cursor is a first connect

d = tempfile.mkdtemp()                                   # an unreadable line is still a line
start(d, A, ["workflow_start", "node_start"])
with open(path(d, A), "a") as fh:
    fh.write("not json\n")
r = live_next(d, f"{A}:2")
assert r == ([{"type": "unreadable"}], f"{A}:3"), r

d = tempfile.mkdtemp()                                   # a quiet run is held back ...
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
assert live_next(d, f"{A}:3") == ([], f"{A}:3")
assert live_next(d, None) == ([], None)
append(d, B, ["node_start"])                             # ... and returned from its first line once a work node runs
r = live_next(d, f"{A}:3")
assert len(r[0]) == 7 and r[0][0]["type"] == "workflow_start" and r[0][6]["node_id"] == 2598 and r[1] == f"{B}:7"

d = tempfile.mkdtemp()                                   # a run that fails after the trigger is returned
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
append(d, B, [{"type": "workflow_error", "error": "boom"}])
r = live_next(d, f"{A}:3")
assert len(r[0]) == 7 and r[0][6]["type"] == "workflow_error" and r[1] == f"{B}:7"

d = tempfile.mkdtemp()                                   # the cursor's tail comes before the next run
start(d, A, ["workflow_start", "node_start"]); append(d, A, [{"type": "workflow_complete", "output": "the answer"}])
start(d, B, ["workflow_start", "node_start"])
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_complete", "workflow_start", "node_start"] and r[0][0]["output"] == "the answer" and r[1] == f"{B}:2"

d = tempfile.mkdtemp()                                   # ... also while the next run is held back
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_complete"] and r[1] == f"{A}:3"

d = tempfile.mkdtemp()                                   # a deleted quiet run is skipped
start(d, A, ["workflow_start", "workflow_complete"])
with open(os.path.join(d, "current"), "w") as fh:
    fh.write(f"2026-10-16_09-00-01_{B}")
assert live_next(d, f"{A}:2") == ([], f"{A}:2")
assert live_next(os.path.join(d, "missing"), None) == ([], None)     # no runs folder yet
print("ok")`);
});

// ---------- the generated package ----------

const POLL =
  "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n" +
  "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

/** The Outlook server sits on a closed port (9): nothing here may reach a real MCP server. */
function sqlStatements(): string[] {
  return [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
    "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:9/mcp', 1)",
    "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
    "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
  ];
}

/** path => code */
async function generate(graph: any, options: any = { modular: true }): Promise<Record<string, string>> {
  const gen = lgGenerator({ sql: sqlStatements(), workflow: { id: 44, name: 'Email prototype', user_id: '3' }, graph });
  return lgFiles(await gen.generate(44, '3', options));
}

/** Task 1's fixture: Start (17) on a Start option whose trigger waits on outlook.wait_for_new. */
async function optionGraph(withWatch = true): Promise<any> {
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
    start_trigger: {
      label: 'Outlook: get new email',
      work_exit: 'new_mail',
      ...(withWatch ? { watch: { server: 'Outlook', tool: 'wait_for_new', args: { folder: 'Inbox' } } } : {}),
    },
  }));
}

/** Start (prompt) -> Output: the Start takes a prompt, so there is nothing to listen to. */
function promptGraph(): any {
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'hello' } },
      { id: '2', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2', from_port: 'output_1' }],
  };
}

test('testTheModularPackageListensAndEveryFileCompiles', { skip: noPy }, async () => {
  const files = await generate(await optionGraph());
  for (const needle of ['@app.post("/listen")', '@app.get("/live")', '"--listen"', 'from common import live_next',
    'from workflow import make_listener, RUNS_DIR, START_MODE, LoopState']) {
    assert.ok(files['api.py'].includes(needle), needle);
  }
  assert.ok(files['workflow.py'].includes('def make_listener(state: LoopState) -> Listener | None:'));
  assert.ok(files['common.py'].includes('def live_next(runs_dir: str, cursor: str | None)'));
  assert.ok(files['api.py'].includes('python api.py --listen'), 'the docstring says how');
  for (const [p, code] of Object.entries(files)) {
    if (!p.endsWith('.py')) {
      continue;
    }
    const r = pyCompile(code, PY as string);
    assert.equal(r.rc, 0, `${p}: ${r.out.join('\n')}`);
  }
});

test('testTheA2AServerDoesNotListen', async () => {
  const files = await generate(promptGraph(), { a2a: true });
  assert.ok(!files['api.py'].includes('/listen'));
  assert.ok(!files['api.py'].includes('--listen'));
});

// ---------- run with the SynergyAI venv (fastapi, langgraph) ----------

/** Writes files under a fresh temp dir; returns the package folder. */
function writePackage(files: Record<string, string>): string {
  const dir = path.join(tmpdir(), 'lglisten_' + randomBytes(4).toString('hex'), 'pkg');
  for (const [p, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), code);
  }
  return dir;
}

function env(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, MCP_URL_OUTLOOK: 'http://127.0.0.1:9/mcp' };
}

/** Runs `<venv> probe.py` in the package folder (stdout+stderr); returns [rc, text]. */
function runProbe(dir: string): [number, string] {
  const r = execPy(VENV, ['probe.py'], { cwd: dir, env: env(), timeoutMs: 180000 });
  return [r.rc, r.text];
}

test('testMakeListenerFollowsTheStartsMode', { skip: noVenv, timeout: 300000 }, async () => {
  const script = String.raw`import os, sys
sys.path.insert(0, os.getcwd())
import workflow
try:
    L = workflow.make_listener(workflow.LoopState())
except ValueError as e:                        # a Start option without a trigger: api.py answers 409 with this
    assert workflow.DEFAULT_WATCH is None and "--watch needs a trigger" in str(e), e
    print("refused"); print("ok"); sys.exit(0)
if workflow.START_MODE == "prompt":
    assert L is None
else:
    assert isinstance(L, workflow.Listener) and L.mode == "watch" and str(L.trigger) == "outlook.wait_for_new", L
    assert L.lock_path == os.path.join(workflow.PACKAGE_DIR, ".run.lock") and not L.running
print("ok")`;
  const cases: Array<[string, any]> = [
    ['option', await optionGraph()],
    ['prompt', promptGraph()],
    ['no trigger', await optionGraph(false)],
  ];
  for (const [label, graph] of cases) {
    const dir = writePackage({ ...(await generate(graph)), 'probe.py': script });
    const [rc, text] = runProbe(dir);
    assert.equal(rc, 0, `${label}: ${text}`);
    assert.ok(text.endsWith((label === 'no trigger' ? 'refused\n' : '') + 'ok\n'), `${label}: ${text}`);
  }
});

/**
 * Fix round 1 (ruling): listening and POST /runs exclude each other (409 both ways; a stop is always accepted), and
 * a /runs run after the listener stopped gets its own trace lines and nothing foreign. Driven in-process
 * (TestClient) with the MCP client faked: no server is reached.
 */
test('testListeningAndServedRunsExcludeEachOther', { skip: noVenv, timeout: 300000 }, async () => {
  const script = String.raw`import asyncio, json, os, sys, time
sys.path.insert(0, os.getcwd())
import common
fake = {"ready": 1}
def call_tool_raw(url, tool, args):
    if tool == "wait_for_new":
        if fake["ready"]:
            fake["ready"] -= 1
            return {"structuredContent": {"status": "ready", "via": "test"}, "content": []}
        time.sleep(0.05)
        return {"structuredContent": {"status": "timeout"}, "content": []}
    body = {"mail": None}                                   # the poll finds nothing: a quiet run
    return {"structuredContent": body, "content": [{"type": "text", "text": json.dumps(body)}]}
common.MCP.call_tool_raw = call_tool_raw
import api, workflow
from starlette.testclient import TestClient

def until(cond, what, limit=20.0):
    end = time.monotonic() + limit
    while not cond():
        assert time.monotonic() < end, what
        time.sleep(0.05)

with TestClient(api.app) as c:
    # a served run in progress: no listening (a stop is still accepted)
    real_run = api.run_workflow
    async def slow(prompt, session=None):
        await asyncio.sleep(1.0)
        return "slow"
    api.run_workflow = slow
    rid = c.post("/runs", json={"prompt": "x"}).json()["run_id"]
    r = c.post("/listen", json={})
    assert r.status_code == 409 and r.json() == {"detail": "A POST /runs run is in progress; listen when it ends."}, r.text
    r = c.post("/listen", json={"stop": True})
    assert r.status_code == 200 and r.json()["listening"] is False, r.text
    until(lambda: api.RUNS[rid].status != "running", "the slow run did not end")
    api.run_workflow = real_run

    # listening: one (quiet) listener run, and no served run meanwhile
    assert c.post("/listen", json={}).json()["listening"] is True
    until(lambda: fake["ready"] == 0 and api.LOOP_STATE.line == "Listening for events", "no listener run")
    assert common.RUN_OUT.mode == "print", common.RUN_OUT.mode              # left as found
    assert workflow.GRAPH_RECORDER is common.NULL_RECORDER
    r = c.post("/runs", json={"prompt": "x"})
    assert r.status_code == 409 and r.json() == {"detail": 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.'}, r.text
    assert c.post("/listen", json={"stop": True}).json()["listening"] is False
    until(lambda: not api.LISTENER.running, "the listener did not stop")

    # a served run after it: its own trace lines, nothing from the listener
    rid = c.post("/runs", json={"prompt": "x"}).json()["run_id"]
    traces, name = [], "message"
    with c.stream("GET", f"/runs/{rid}/events") as resp:
        for line in resp.iter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                if name in ("done", "error"):
                    assert name == "done", line
                    break
                ev = json.loads(line.split(":", 1)[1])
                if ev.get("type") == "trace":
                    traces.append(ev["text"])
    assert any(t.startswith("[info] Running") for t in traces), traces
    assert any(t.startswith("[node] [") for t in traces), traces
    assert not any("watch" in t or "Listening" in t or "Done in" in t for t in traces), traces
print("ok")`;
  const dir = writePackage({ ...(await generate(await optionGraph())), 'probe.py': script });
  const [rc, text] = runProbe(dir);
  assert.equal(rc, 0, text);
  assert.ok(text.endsWith('ok\n'), text);
});

/**
 * Final review M-e: a POST /runs run ended by a BaseException (a cancellation) is marked failed, with its error frame,
 * so it does not stay "running" and make every later POST /listen a 409.
 */
test('testAServedRunEndedByABaseExceptionDoesNotBlockListening', { skip: noVenv, timeout: 300000 }, async () => {
  const script = String.raw`import asyncio, json, os, sys, time
sys.path.insert(0, os.getcwd())
import common
def call_tool_raw(url, tool, args):
    time.sleep(0.05)
    return {"structuredContent": {"status": "timeout"}, "content": []}
common.MCP.call_tool_raw = call_tool_raw
import api
from starlette.testclient import TestClient

def until(cond, what, limit=10.0):
    end = time.monotonic() + limit
    while not cond():
        assert time.monotonic() < end, what
        time.sleep(0.05)

with TestClient(api.app) as c:
    async def cancelled(prompt, session=None):
        raise asyncio.CancelledError()
    api.run_workflow = cancelled
    rid = c.post("/runs", json={"prompt": "x"}).json()["run_id"]
    until(lambda: api.RUNS[rid].status != "running", "the run stayed running")
    assert api.RUNS[rid].status == "failed" and api.RUNS[rid].error == "CancelledError", (api.RUNS[rid].status, api.RUNS[rid].error)
    assert [e[1] for e in api.RUNS[rid].events][-1] == "error", api.RUNS[rid].events
    r = c.post("/listen", json={})
    assert r.status_code == 200 and r.json()["listening"] is True, r.text
    c.post("/listen", json={"stop": True})
    until(lambda: not api.LISTENER.running, "the listener did not stop")
print("ok")`;
  const dir = writePackage({ ...(await generate(await optionGraph())), 'probe.py': script });
  const [rc, text] = runProbe(dir);
  assert.equal(rc, 0, text);
  assert.ok(text.endsWith('ok\n'), text);
});

/**
 * Fix round 2: (1) a run abandoned at the cap that ends late must not reset the run that replaced it, and a served
 * run always starts from the baseline; (2) POST /runs is refused while an abandoned listener run is still alive.
 */
test('testALateAbandonedRunLeavesTheNextOneAloneAndServedRunsStartClean', { skip: noVenv, timeout: 300000 }, async () => {
  const script = String.raw`import asyncio, os, sys, threading, time, tempfile
sys.path.insert(0, os.getcwd())
import common, workflow, api
from starlette.testclient import TestClient

def until(cond, what, limit=10.0):
    end = time.monotonic() + limit
    while not cond():
        assert time.monotonic() < end, what
        time.sleep(0.02)

def _fail_fast(kind, value, tb):
    """A failed assert must not hang on the gate threads: report and leave at once."""
    import traceback
    traceback.print_exception(kind, value, tb)
    sys.stdout.flush()
    os._exit(1)
sys.excepthook = _fail_fast

class Graph:
    """Stands in for WorkflowGraph: run() waits for its gate."""
    def __init__(self):
        self.gate, self.routes, self.agents, self.ran, self.started = threading.Event(), {}, {}, [], time.time()
    async def run(self, prompt):
        await asyncio.to_thread(self.gate.wait)
        return ""
    def check_error_exits(self):
        pass

graphs = [Graph(), Graph()]
workflow.build_graph = lambda recorder=None: graphs.pop(0)
gate_a, gate_b = graphs[0].gate, graphs[1].gate
runs = workflow.RunLoop()
recorder = workflow.RunRecorder(tempfile.mkdtemp(), 44, "W")
run_once = workflow.make_run_once("x", runs, workflow.ConsoleView("quiet"), recorder, loop_mode=True)

ta = threading.Thread(target=run_once, daemon=True); ta.start()          # run A ...
until(lambda: workflow.GRAPH_RECORDER is recorder, "A did not start")
run_a = recorder.run_id
runs.loop = asyncio.new_event_loop()                                     # ... abandoned at the cap (drain swaps the loop)
tb = threading.Thread(target=run_once, daemon=True); tb.start()          # run B begins
until(lambda: recorder.run_id != run_a, "B did not start")
gate_a.set(); ta.join(5)                                                 # A's late finally
assert workflow.GRAPH_RECORDER is recorder and common.RUN_OUT.mode == "hold", (workflow.GRAPH_RECORDER, common.RUN_OUT.mode)
gate_b.set(); tb.join(5)                                                 # B ends: the baseline
assert workflow.GRAPH_RECORDER is common.NULL_RECORDER and common.RUN_OUT.mode == "print"

seen = []
async def served(prompt, session=None):
    seen.append((common.RUN_OUT.mode, workflow.GRAPH_RECORDER is common.NULL_RECORDER))
    return "ok"
api.run_workflow = served
with TestClient(api.app) as c:
    workflow.GRAPH_RECORDER = recorder; common.RUN_OUT.begin("hold")     # whatever a listener run left
    assert c.post("/runs", json={"prompt": "x"}).status_code == 200
    until(lambda: seen, "the served run did not start")
    assert seen == [("print", True)], seen                               # a served run starts clean

    assert c.post("/listen", json={}).json()["listening"] is True       # (the trigger: closed port 9)
    c.post("/listen", json={"stop": True})
    until(lambda: not api.LISTENER.running, "the listener did not stop")
    stuck = threading.Event()
    late = threading.Thread(target=stuck.wait, daemon=True); late.start()
    api.LISTENER.loop.abandoned.append(late)                             # an abandoned listener run, still alive
    r = c.post("/runs", json={"prompt": "x"})
    assert r.status_code == 409 and r.json() == {"detail": "A listener run is still finishing; try again when it ends."}, r.text
    stuck.set(); late.join(5)
    assert c.post("/runs", json={"prompt": "x"}).status_code == 200
print("ok")`;
  const dir = writePackage({ ...(await generate(await optionGraph())), 'probe.py': script });
  const [rc, text] = runProbe(dir);
  assert.equal(rc, 0, text);
  assert.ok(text.endsWith('ok\n'), text);
});

// ---------- opt-in: the real api.py served by uvicorn ----------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** status, decoded body ({} when none), lower-cased headers -- PHP's http() helper (0 when unreachable). */
function httpCall(method: string, url: string, body: any = null, headers: Record<string, string> = {}): Promise<[number, any, Record<string, string>]> {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : '';
    const h: Record<string, string> = { ...headers };
    if (body !== null) h['Content-Type'] = 'application/json';
    const req = http.request(url, { method, headers: h, timeout: 10000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let decoded: any = {};
        try {
          decoded = JSON.parse(raw) ?? {};
        } catch {
          decoded = {};
        }
        const hs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) hs[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve([res.statusCode ?? 0, decoded, hs]);
      });
    });
    req.on('error', () => resolve([0, {}, {}]));
    req.on('timeout', () => req.destroy());
    req.end(payload);
  });
}

/** Opens GET /live raw (as fsockopen does) and reads until `done(seen)` or the deadline; returns what was read. */
function readLive(port: number, request: string, done: (seen: string) => boolean, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let seen = '';
    const sock = net.connect(port, '127.0.0.1');
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(seen);
    };
    const timer = setTimeout(finish, ms);
    sock.on('connect', () => sock.write(request));
    sock.on('data', (c) => {
      seen += c.toString('utf8');
      if (done(seen)) finish();
    });
    sock.on('error', finish);
    sock.on('end', finish);
  });
}

function serve(dir: string, args: string[], log: string | null): ChildProcess {
  const out = log !== null ? openSync(log, 'a') : 'ignore';
  return spawn(VENV, ['api.py', ...args], { cwd: dir, env: env(), stdio: ['ignore', out, out] });
}

async function waitUp(port: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if ((await httpCall('GET', `http://127.0.0.1:${port}/.well-known/workflow.json`))[0] === 200) return true;
  }
  return false;
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const gone = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await gone;
}

const STATE_RE = /event: state\r?\ndata: (.*)\r?\n/;

/** Opt-in (CODE_NODE_E2E=1): the real api.py, served by uvicorn, toggled over HTTP. */
test('testListenRoutes', { skip: noE2E, timeout: 120000 }, async () => {
  const dir = writePackage(await generate(await optionGraph()));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = path.join(dir, 'server.log');
  writeFileSync(log, '');
  const proc = serve(dir, ['--port', String(port)], log);
  try {
    assert.ok(await waitUp(port), 'server did not start: ' + readFileSync(log, 'utf8'));

    // The editor's page (http://localhost/...) sends JSON, so the browser asks first.
    let [st, , h] = await httpCall('OPTIONS', `${base}/listen`, null, {
      Origin: 'http://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    });
    assert.equal(st, 200);
    assert.equal(h['access-control-allow-origin'] ?? null, 'http://localhost');

    let r1: any, r2: any, r: any;
    [st, r1] = await httpCall('POST', `${base}/listen`, {});
    assert.equal(st, 200, JSON.stringify(r1));
    [st, r2] = await httpCall('POST', `${base}/listen`, {});
    assert.equal(st, 200, JSON.stringify(r2));
    assert.equal(r1['listening'], true);
    assert.equal(r2['listening'], true);
    assert.equal(r2['mode'], 'watch');
    assert.deepEqual(Object.keys(r2['state']), ['line', 'tone']);
    [st, r] = await httpCall('POST', `${base}/runs`, { prompt: 'x' });
    assert.equal(st, 409, JSON.stringify(r));
    assert.deepEqual(r, { detail: 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.' });

    await sleep(1500); // the trigger's first call fails at once (closed port)
    // A run in progress in the package's runs/ (what RunRecorder writes): /live replays it.
    const rid = 'c'.repeat(32);
    mkdirSync(path.join(dir, 'runs'), { recursive: true });
    writeFileSync(path.join(dir, 'runs', 'current'), `2026-10-16_09-00-00_${rid}`);
    writeFileSync(
      path.join(dir, 'runs', `2026-10-16_09-00-00_${rid}.jsonl`),
      JSON.stringify({ type: 'workflow_start', run_id: rid }) + '\n' +
        JSON.stringify({ type: 'node_start', node_id: '18', node_type: 'output', node_name: 'Output' }) + '\n',
    );
    const seen = await readLive(
      port,
      'GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost\r\nAccept: text/event-stream\r\n\r\n',
      (s) => STATE_RE.test(s),
      8000,
    );
    const m = STATE_RE.exec(seen);
    const state = m ? JSON.parse(m[1]) : null;
    assert.notEqual(state, null, seen);
    const runs = [...seen.matchAll(/event: run\r?\ndata: (.*)\r?\n/g)].map((x) => JSON.parse(x[1]));
    assert.deepEqual(runs.map((f: any) => f['event']['type']), ['workflow_start', 'node_start'], seen);
    assert.equal(runs[1]['cursor'], `${rid}:2`);
    assert.ok(seen.toLowerCase().includes('access-control-allow-origin: http://localhost'), seen);
    assert.equal(state['compiled']['line'] ?? null, 'Not listening: server unreachable — retrying in 30 s', seen);
    assert.equal(state['compiled']['tone'], 'err');
    assert.equal(state['compiled']['listening'], true);

    let r3: any;
    [st, r3] = await httpCall('POST', `${base}/listen`, { stop: true });
    assert.equal(st, 200, JSON.stringify(r3));
    assert.equal(r3['listening'], false, JSON.stringify(r3));
    // Once the stop has taken effect (the backoff nap ends at once), POST /runs is served again.
    st = 409;
    for (let i = 0; i < 50 && st === 409; i++) {
      await sleep(100);
      [st, r] = await httpCall('POST', `${base}/runs`, { prompt: 'x' });
    }
    assert.equal(st, 200, JSON.stringify(r) + '\n' + readFileSync(log, 'utf8'));
  } finally {
    await stop(proc);
  }
});

/** Opt-in: `python api.py --listen` starts the listener before serving. */
test('testTheListenFlagStartsTheListener', { skip: noE2E, timeout: 120000 }, async () => {
  const dir = writePackage(await generate(await optionGraph()));
  const port = await freePort();
  const log = path.join(dir, 'server.log');
  writeFileSync(log, '');
  const proc = serve(dir, ['--port', String(port), '--listen'], log);
  try {
    await waitUp(port);
    const seen = await readLive(port, 'GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', (s) => STATE_RE.test(s), 5000);
    const m = STATE_RE.exec(seen);
    assert.equal((m ? JSON.parse(m[1]) : null)?.['compiled']?.['listening'] ?? false, true, seen);
    assert.ok(readFileSync(log, 'utf8').includes('Listening for events: outlook.wait_for_new {"folder":"Inbox"}'));
  } finally {
    await stop(proc);
  }
});

/** Opt-in: a Start that takes a prompt has nothing to listen to. */
test('testAPromptStartRefusesToListen', { skip: noE2E, timeout: 120000 }, async () => {
  const dir = writePackage(await generate(promptGraph()));
  const port = await freePort();
  const proc = serve(dir, ['--port', String(port)], null);
  try {
    await waitUp(port);
    const [st, r] = await httpCall('POST', `http://127.0.0.1:${port}/listen`, {});
    assert.equal(st, 409);
    assert.deepEqual(r, { detail: "This workflow's Start takes a prompt; use POST /runs." });
  } finally {
    await stop(proc);
  }
  const res = execPy(VENV, ['api.py', '--port', String(await freePort()), '--listen'], { cwd: dir, env: env(), timeoutMs: 60000 });
  assert.equal(res.rc, 2, res.text);
  assert.ok(res.text.includes("--listen: This workflow's Start takes a prompt; use POST /runs."), res.text);
});
