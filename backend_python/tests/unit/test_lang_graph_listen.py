"""Port of backend/tests/Unit/LangGraphListenTest.php (standalone plan task 8: api.py listens -- POST /listen,
--listen -- and streams its runs -- GET /live -- like SynergyAI's /live)."""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S


def _py(tail: str) -> list:
    src = ('from __future__ import annotations\nimport json, os, re, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n'
           + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.liveFeedBlock() + '\n' + tail)
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([S.require_py310(), f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    out = S.exec_lines(r.stdout + r.stderr)
    assert r.returncode == 0, '\n'.join(out)
    assert out[-1] == 'ok', '\n'.join(out)
    return out


def test_feed_rules():
    _py('''import tempfile
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
print("ok")
''')


def test_the_servers_other_feed_rules():
    _py('''import tempfile
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
            fh.write(json.dumps(t if isinstance(t, dict) else WORK.get(t, {"type": t})) + "\\n")
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
    fh.write("not json\\n")
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
print("ok")
''')


# ---------- the generated package ----------

POLL = ("def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n")


def _db():
    """The Outlook server sits on a closed port (9): nothing here may reach a real MCP server."""
    return S.db(*S.MCP_DDL, S.LLM_DDL,
                'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
                "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:9/mcp', 1)",
                "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')")


def _generate(graph: dict, options: dict | None = None) -> dict:
    gen = S.generator(_db(), graph, Workflow({'id': 44, 'name': 'Email prototype', 'user_id': '3'}))
    return S.files_of(gen.generate(44, '3', options if options is not None else {'modular': True}))


def _option_graph(withWatch: bool = True) -> dict:
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 5}},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from_node_id': '17', 'to_node_id': '18', 'from_port': 'output_1'}]}
    trigger = {'label': 'Outlook: get new email', 'work_exit': 'new_mail'}
    if withWatch:
        trigger['watch'] = {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}
    return StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get new email', 'code': POLL,
        'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30, 'start_trigger': trigger})


def _prompt_graph() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'hello'}},
        {'id': '2', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}]}


def test_the_modular_package_listens_and_every_file_compiles():
    S.require_py310()
    files = _generate(_option_graph())
    for needle in ('@app.post("/listen")', '@app.get("/live")', '"--listen"', 'from common import live_next',
                   'from workflow import make_listener, RUNS_DIR, START_MODE, LoopState'):
        assert needle in files['api.py'], needle
    assert 'def make_listener(state: LoopState) -> Listener | None:' in files['workflow.py']
    assert 'def live_next(runs_dir: str, cursor: str | None)' in files['common.py']
    assert 'python api.py --listen' in files['api.py'], 'the docstring says how'
    for path, code in files.items():
        if path.endswith('.py'):
            S.assert_compiles(code, path)


def test_the_a2_a_server_does_not_listen():
    files = _generate(_prompt_graph(), {'a2a': True})
    assert '/listen' not in files['api.py']
    assert '--listen' not in files['api.py']


# ---------- run with the SynergyAI venv (fastapi, langgraph) ----------

def _write_package(files: dict) -> str:
    d = tempfile.mkdtemp(prefix='lglisten_') + '/pkg'
    for path, code in files.items():
        os.makedirs(os.path.dirname(f'{d}/{path}'), exist_ok=True)
        with open(f'{d}/{path}', 'w', encoding='utf-8') as fh:
            fh.write(code)
    return d


def _env() -> dict:
    return {'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''), 'MCP_URL_OUTLOOK': 'http://127.0.0.1:9/mcp'}


def _run_probe(files: dict, script: str) -> tuple:
    venv = S.venv()
    d = _write_package({**files, 'probe.py': script})
    # stderr merged into stdout, in write order (PHP: 2 => ['redirect', 1])
    r = subprocess.run([venv, 'probe.py'], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=_env())
    return r.returncode, r.stdout


def test_make_listener_follows_the_starts_mode():
    S.venv()
    script = '''import os, sys
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
print("ok")
'''
    for label, graph in (('option', _option_graph()), ('prompt', _prompt_graph()), ('no trigger', _option_graph(False))):
        rc, text = _run_probe(_generate(graph), script)
        assert rc == 0, f'{label}: {text}'
        assert text.endswith(('refused\n' if label == 'no trigger' else '') + 'ok\n'), label


def test_listening_and_served_runs_exclude_each_other():
    S.venv()
    script = '''import asyncio, json, os, sys, time
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

    assert c.post("/listen", json={}).json()["listening"] is True
    until(lambda: fake["ready"] == 0 and api.LOOP_STATE.line == "Listening for events", "no listener run")
    assert common.RUN_OUT.mode == "print", common.RUN_OUT.mode              # left as found
    assert workflow.GRAPH_RECORDER is common.NULL_RECORDER
    r = c.post("/runs", json={"prompt": "x"})
    assert r.status_code == 409 and r.json() == {"detail": 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.'}, r.text
    assert c.post("/listen", json={"stop": True}).json()["listening"] is False
    until(lambda: not api.LISTENER.running, "the listener did not stop")

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
print("ok")
'''
    rc, text = _run_probe(_generate(_option_graph()), script)
    assert rc == 0, text
    assert text.endswith('ok\n'), text


def test_a_served_run_ended_by_a_base_exception_does_not_block_listening():
    S.venv()
    script = '''import asyncio, json, os, sys, time
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
print("ok")
'''
    rc, text = _run_probe(_generate(_option_graph()), script)
    assert rc == 0, text
    assert text.endswith('ok\n'), text


def test_a_late_abandoned_run_leaves_the_next_one_alone_and_served_runs_start_clean():
    S.venv()
    script = '''import asyncio, os, sys, threading, time, tempfile
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
print("ok")
'''
    rc, text = _run_probe(_generate(_option_graph()), script)
    assert rc == 0, text
    assert text.endswith('ok\n'), text


# ---------- opt-in (CODE_NODE_E2E=1): the real api.py served by uvicorn ----------

def _free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _http(method: str, url: str, body=None, headers: dict | None = None) -> tuple:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={**({'Content-Type': 'application/json'} if body is not None else {}),
                                                                        **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw, status, h = r.read(), r.status, {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        raw, status, h = e.read(), e.code, {k.lower(): v for k, v in e.headers.items()}
    except OSError:
        return 0, {}, {}
    try:
        decoded = json.loads(raw) if raw else {}
    except ValueError:
        decoded = {}
    return status, decoded if decoded is not None else {}, h


def _serve(d: str, args: list, log: str):
    with open(log, 'w') as fh:
        return subprocess.Popen([S.VENV, 'api.py', *args], cwd=d, stdout=fh, stderr=subprocess.STDOUT, env=_env())


def _wait_up(base: str) -> bool:
    for _ in range(100):
        time.sleep(0.2)
        if _http('GET', f'{base}/.well-known/workflow.json')[0] == 200:
            return True
    return False


def _read_until_state(port: int, request: bytes, limit: float) -> str:
    sock = socket.create_connection(('127.0.0.1', port), timeout=5)
    sock.sendall(request)
    sock.settimeout(limit)
    seen = ''
    deadline = time.monotonic() + limit
    try:
        while time.monotonic() < deadline and not re.search(r'event: state\r?\ndata: (.*)\r?\n', seen):
            chunk = sock.recv(4096)
            if not chunk:
                break
            seen += chunk.decode('utf-8', errors='replace')
    except socket.timeout:
        pass
    sock.close()
    return seen


def test_listen_routes():
    if os.environ.get('CODE_NODE_E2E') != '1':
        pytest.skip('set CODE_NODE_E2E=1 to serve api.py')
    S.venv()
    d = _write_package(_generate(_option_graph()))
    port = _free_port()
    base = f'http://127.0.0.1:{port}'
    log = f'{d}/server.log'
    proc = _serve(d, ['--port', str(port)], log)
    try:
        assert _wait_up(base), 'server did not start: ' + open(log).read()
        st, _, h = _http('OPTIONS', f'{base}/listen', None, {'Origin': 'http://localhost',
                                                              'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
        assert st == 200
        assert h.get('access-control-allow-origin') == 'http://localhost'
        st, r1, _ = _http('POST', f'{base}/listen', {})
        assert st == 200, r1
        st, r2, _ = _http('POST', f'{base}/listen', {})
        assert st == 200, r2
        assert r1['listening'] is True and r2['listening'] is True
        assert r2['mode'] == 'watch'
        assert list(r2['state']) == ['line', 'tone']
        st, r, _ = _http('POST', f'{base}/runs', {'prompt': 'x'})
        assert st == 409, r
        assert r == {'detail': 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.'}
        time.sleep(1.5)
        rid = 'c' * 32
        os.makedirs(f'{d}/runs', exist_ok=True)
        with open(f'{d}/runs/current', 'w') as fh:
            fh.write(f'2026-10-16_09-00-00_{rid}')
        with open(f'{d}/runs/2026-10-16_09-00-00_{rid}.jsonl', 'w') as fh:
            fh.write(json.dumps({'type': 'workflow_start', 'run_id': rid}) + '\n'
                     + json.dumps({'type': 'node_start', 'node_id': '18', 'node_type': 'output', 'node_name': 'Output'}) + '\n')
        seen = _read_until_state(port, b'GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost\r\nAccept: text/event-stream\r\n\r\n', 8)
        m = re.search(r'event: state\r?\ndata: (.*)\r?\n', seen)
        assert m, seen
        state = json.loads(m.group(1))
        runs = [json.loads(x) for x in re.findall(r'event: run\r?\ndata: (.*)\r?\n', seen)]
        assert [f['event']['type'] for f in runs] == ['workflow_start', 'node_start'], seen
        assert runs[1]['cursor'] == f'{rid}:2'
        assert 'access-control-allow-origin: http://localhost' in seen.lower()
        assert state['compiled']['line'] == 'Not listening: server unreachable — retrying in 30 s', seen
        assert state['compiled']['tone'] == 'err'
        assert state['compiled']['listening'] is True
        st, r3, _ = _http('POST', f'{base}/listen', {'stop': True})
        assert st == 200 and r3['listening'] is False, r3
        st = 409
        for _ in range(50):
            if st != 409:
                break
            time.sleep(0.1)
            st, r, _ = _http('POST', f'{base}/runs', {'prompt': 'x'})
        assert st == 200, f'{r}\n' + open(log).read()
    finally:
        proc.terminate()
        proc.wait()


def test_the_listen_flag_starts_the_listener():
    if os.environ.get('CODE_NODE_E2E') != '1':
        pytest.skip('set CODE_NODE_E2E=1 to serve api.py')
    S.venv()
    d = _write_package(_generate(_option_graph()))
    port = _free_port()
    log = f'{d}/server.log'
    proc = _serve(d, ['--port', str(port), '--listen'], log)
    try:
        _wait_up(f'http://127.0.0.1:{port}')
        seen = _read_until_state(port, b'GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', 5)
        m = re.search(r'event: state\r?\ndata: (.*)\r?\n', seen)
        assert m and json.loads(m.group(1))['compiled']['listening'] is True, seen
        assert 'Listening for events: outlook.wait_for_new {"folder":"Inbox"}' in open(log).read()
    finally:
        proc.terminate()
        proc.wait()


def test_a_prompt_start_refuses_to_listen():
    if os.environ.get('CODE_NODE_E2E') != '1':
        pytest.skip('set CODE_NODE_E2E=1 to serve api.py')
    S.venv()
    d = _write_package(_generate(_prompt_graph()))
    port = _free_port()
    proc = _serve(d, ['--port', str(port)], os.devnull)
    try:
        _wait_up(f'http://127.0.0.1:{port}')
        st, r, _ = _http('POST', f'http://127.0.0.1:{port}/listen', {})
        assert st == 409
        assert r == {'detail': "This workflow's Start takes a prompt; use POST /runs."}
    finally:
        proc.terminate()
        proc.wait()
    r = subprocess.run([S.VENV, 'api.py', '--port', str(_free_port()), '--listen'], cwd=d, capture_output=True, text=True, env=_env())
    assert r.returncode == 2, r.stdout + r.stderr
    assert "--listen: This workflow's Start takes a prompt; use POST /runs." in r.stdout + r.stderr
