"""Port of backend/tests/Unit/LangGraphWatchLoopTest.php (spec 2026-10-12 mail/drive events §7: --watch in
compiled LangGraph scripts)."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from tests.unit import lg_support as S

HARNESS = '''import threading, fcntl
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

'''


def _run_py(tail: str) -> tuple:
    src = ('from __future__ import annotations\nimport argparse, asyncio, json, re, signal, sys, threading, time\n'
           'from datetime import datetime, timedelta\nfrom typing import Callable\n'
           + LangGraphRuntime.cronBlock() + '\n' + LangGraphRuntime.watchBlock() + '\n' + HARNESS + tail)
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([S.require_py310(), f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    return r.returncode, S.exec_lines(r.stdout + r.stderr)


def _py(tail: str) -> list:
    rc, out = _run_py(tail)
    assert rc == 0, '\n'.join(out)
    return out


def test_ready_drains_timeout_waits_again():
    out = _py('''MCP = FakeMcp([ok(status="timeout", events="on"), ok(status="ready", via="event", events="on"),
               ok(status="ready", via="fallback", events="on")])
clock = Clock()
run_watch(TRIGGER, runner(["mail 1", "mail 2", "", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)
print("calls", MCP.calls[0], len(MCP.calls), "slept", clock.slept)
''')
    assert out == [
        '[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
        '[watch 09:00] Listening for events',
        '[watch 09:00] ready (event): 2 run(s) did work',
        '[watch 09:00] Listening for events',
        '[watch 09:00] Listening (checks every 15 min)',
        "calls ('http://mail.local/mcp', 'wait_for_new', {'args': {'folder': 'Inbox'}}) 3 slept []",
    ]


def test_a_quiet_wake_prints_nothing():
    out = _py('''MCP = FakeMcp([ok(status="ready", via="event")] * 4)
clock = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=4, state=st)
assert seen.count("Running\u2026") == 4, seen
for verbosity in ("quiet", "normal"):
    MCP = FakeMcp([ok(status="ready", via="event")] * 3)
    run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3, verbosity=verbosity)
print("verbose")
MCP = FakeMcp([ok(status="ready", via="event")])
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=1, verbosity="verbose")
''')
    quiet = ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events']
    assert out == quiet + quiet + quiet + ['verbose', quiet[0], '[watch 09:00] ready (event): nothing to do', quiet[1]]


def test_quiet_shows_only_errors_of_the_drain():
    out = _py('''MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 2:
        raise RuntimeError("Jev down")
    return "mail" if state["n"] == 1 else ""
run_watch(TRIGGER, run_once, drains=False, sleep=clock.sleep, now=clock.now, calls=2, verbosity="quiet")
''')
    assert out == ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events',
                   '[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down',
                   '[watch 09:00] Listening — the last run failed']


def test_without_code_nodes_one_run_per_ready():
    out = _py('''MCP = FakeMcp([ok(status="ready", via="event")])
clock = Clock()
run_watch(TRIGGER, runner(["a", "b"]), drains=False, sleep=clock.sleep, now=clock.now, calls=1)
''')
    assert out[1] == '[watch 09:00] ready (event): 1 run(s) did work'


def test_each_failure_kind_has_its_line_and_the_backoff_grows():
    out = _py('''MCP = FakeMcp([{"isError": True, "content": [{"type": "text", "text": '{"error": "reconnect_needed"}'}]},
               ConnectionError("refused"),
               {"content": [{"type": "text", "text": "not json"}]},
               ok(answer=42),
               {"isError": True, "content": [{"type": "text", "text": "boom"}]},
               ok(error="not_connected", message="Outlook is not connected"),
               {"content": [{"type": "text", "text": '{"status": "ready", "via": "pending"}'}]}])   # text only: parsed
clock = Clock()
run_watch(TRIGGER, runner(["x", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=7)
print("slept", clock.slept)
''')
    assert out[1] == '[watch 09:00] Not listening: reconnect_needed — retrying in 30 s'
    assert out[2] == '[watch 09:00] Not listening: server unreachable — retrying in 60 s'
    assert 'Not listening: expected {"status": "ready" | "timeout"}, got \'not json\' — retrying in 120 s' in out[3]
    assert 'got \'{"answer": 42}\' — retrying in 240 s' in out[4]
    assert out[5] == '[watch 09:07] Not listening: boom — retrying in 300 s'
    assert out[6] == '[watch 09:12] Not listening: Outlook is not connected — retrying in 300 s'
    assert out[7:] == ['[watch 09:17] ready (pending): 1 run(s) did work',
                       '[watch 09:17] Listening for events', 'slept [30.0, 60.0, 120.0, 240.0, 300.0, 300.0]']


def test_watch_error_kinds():
    out = _py('''MCP = FakeMcp([OSError("down"), {"isError": True, "content": [{"type": "text", "text": "bad"}]},
               ok(error="reconnect_needed", message="sign in"), ok(error="not_connected"), ok(error="quota"), ok(status="later")])
for _ in range(6):
    try:
        TRIGGER.wait()
    except WatchError as e:
        print(e.kind, "|", e)
''')
    assert out == ['unreachable | down', 'tool_error | bad', 'reconnect_needed | sign in', 'not_connected | not_connected',
                   'tool_error | quota', 'bad_answer | expected {"status": "ready" | "timeout"}, got \'{"status": "later"}\'']


def test_watch_error_object():
    out = _py('''MCP = FakeMcp([ok(error={"code": "servicenow_error", "message": "down"})])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)
''')
    assert out == ['tool_error | down']


def test_the_clients_transport_failure_is_unreachable():
    out = _py('''MCP = FakeMcp([{"isError": True, "transport_error": True, "content": [{"type": "text", "text": "[Errno 61] Connection refused"}]}])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)
''')
    assert out == ['unreachable | [Errno 61] Connection refused']
    assert ('return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}'
            in LangGraphRuntime.mcpClientBlock())


def test_backoff_doubles_to_five_minutes_and_resets():
    _py('''MCP = FakeMcp([OSError("down")] * 6 + [ok(status="timeout"), OSError("down")])
c = Clock()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now).run(calls=8)
assert c.slept == [30, 60, 120, 240, 300, 300, 30], c.slept
print("ok")
''')


def test_reconnect_needed_shows_the_server_message():
    _py('''MCP = FakeMcp([ok(error="reconnect_needed", message="sign in again at http://127.0.0.1:8770/connect")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=1)
assert st.line == "Not listening: sign in again at http://127.0.0.1:8770/connect \u2014 retrying in 30 s", st.line
assert st.tone == "err"
print("ok")
''')


def test_fallback_printed_once_and_bad_answer():
    _py('''MCP = FakeMcp([ok(status="timeout", via="fallback"), ok(status="timeout", via="fallback"), ok(nope=1)])
c = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=3)
assert seen.count("Listening (checks every 15 min)") == 1, seen
assert seen[-1].startswith("Not listening: ") and st.tone == "err", seen
print("ok")
''')


def test_a_crashing_run_does_not_stop_the_loop():
    _py('''def boom():
    raise RuntimeError("model down")
MCP = FakeMcp([ok(status="ready"), ok(status="timeout")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, boom, drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=2)
assert st.line == "Listening \u2014 the last run failed" and st.tone == "warn", st.line
print("ok")
''')


def test_run_cap_abandons_a_long_run():
    _py('''import threading
gate = threading.Event()
def slow():
    gate.wait(5)
    return "late"
line = drain(slow, drains=False, max_runs=1, run_cap_s=0.2)
gate.set()
assert line == "abandoned a run after 30 min", line
print("ok")
''')


def test_second_copy_exits():
    _py('''import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
with SingleInstance(p):
    code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
    assert code != 0, "the lock must be held"
code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
assert code == 0, "released on exit"
print("ok")
''')


def test_a_second_run_watch_on_the_same_lock_says_so_and_exits_zero():
    out = _py('''import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
hold = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(5)", p], stdout=subprocess.PIPE, text=True)
hold.stdout.readline()
try:
    run_watch(TRIGGER, runner([]), drains=True, lock_path=p, calls=1)
except SystemExit as e:
    print("exit", e.code)
hold.kill()
''')
    assert [line for line in out if 'waiting on' in line] == []
    assert '[watch] already running (' in '\n'.join(out)
    assert 'exit 0' in out


def test_the_listener_banner_follows_the_lock():
    rc, out = _run_py(LangGraphRuntime.listenerBlock() + '''import tempfile, os, subprocess
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
    hold.kill(); hold.wait()
''')
    assert rc == 0, '\n'.join(out)
    norm = [re.sub(r'^\[cron \d\d:\d\d\]', '[cron HH:MM]', re.sub(r'\(/.*$', '(', line)) for line in out]
    assert norm == ['Listening for events: outlook.wait_for_new {"args":{"folder":"Inbox"}} (Ctrl-C to stop)',
                    '[watch 09:00] Listening for events', 'second copy', '[watch 09:00] Not listening: already running (', 'exit 0',
                    'second copy', '[cron HH:MM] Not listening: already running (', 'exit 0']


def test_ctrl_c_during_a_run_lets_it_finish():
    out = _py('''import threading, _thread
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
print("ok")
''')
    assert out[-2:] == ['[watch] stopped.', 'ok']


def test_in_a_thread_a_stop_event_ends_the_loop_and_no_signal_handler_is_installed():
    out = _py('''before = signal.getsignal(signal.SIGTERM)
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
print("alive", t.is_alive(), "calls", calls, "handler kept", signal.getsignal(signal.SIGTERM) is before, "listening", st.listening)
''')
    assert out[-2:] == ['[watch] stopped.', 'alive False calls [False, False, False] handler kept True listening False']


def test_a_backoff_sleep_ends_at_once_on_stop():
    out = _py('''stop = threading.Event()
MCP = FakeMcp([OSError("down")])
threading.Timer(0.2, stop.set).start()
t0 = time.monotonic()
run_watch(TRIGGER, runner([]), drains=True, stop=stop)
print("quick", time.monotonic() - t0 < 5)
''')
    assert out[-1] == 'quick True'


def test_events_off_listens_on_the_fifteen_minute_check_and_prints_it_once():
    out = _py('''off = dict(events="off", reason="EVENTHUB_NOTIFICATION_URL is not set")
MCP = FakeMcp([ok(status="timeout", **off), ok(status="timeout", **off), ok(status="timeout", events="on")])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)
''')
    assert out == ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
                   '[watch 09:00] Listening (checks every 15 min)',
                   '[watch 09:00] Listening for events']


def test_an_error_run_is_reported_and_the_loop_goes_on():
    out = _py('''MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 1:
        raise RuntimeError("Jev down")
    return ""
run_watch(TRIGGER, run_once, drains=True, sleep=clock.sleep, now=clock.now, calls=2)
''')
    assert out[1] == '[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down'
    assert out[2] == '[watch 09:00] Listening — the last run failed'
    assert out[3] == '[watch 09:00] Listening for events'
    assert len(out) == 4


def test_ctrl_c_stops():
    out = _py('''MCP = FakeMcp([KeyboardInterrupt()])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now)
print("after")
''')
    assert out == ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '', '[watch] stopped.', 'after']


def test_cli_trigger_falls_back_to_the_baked_one_and_refuses_bad_input():
    out = _py('''ap = argparse.ArgumentParser(prog="wf")
baked = {"server": "outlook", "tool": "wait_for_new", "args": {"args": {"folder": "Inbox"}}}
print(WatchTrigger.from_cli(ap, None, baked))
t = WatchTrigger.from_cli(ap, "", baked)
print(t, t.args)
t = WatchTrigger.from_cli(ap, 'outlook.wait_for_new {"timeout_s": 30}', None)
print(t, t.args, t.url())
''')
    assert out == ['None', "outlook.wait_for_new {'args': {'folder': 'Inbox'}}",
                   "outlook.wait_for_new {'timeout_s': 30} http://mail.local/mcp"]
    for args, msg in {'"", None': 'this workflow has no event trigger',
                      '"drive.wait", None': "MCP server 'drive' is not used by this workflow (its servers: outlook); set the environment variable MCP_URL_DRIVE if the server moved",
                      '"outlook", None': 'expected server.tool', '"outlook.wait {x", None': 'the arguments are not JSON',
                      '"outlook.wait [1]", None': 'must be a JSON object'}.items():
        rc, lines = _run_py(f"WatchTrigger.from_cli(argparse.ArgumentParser(prog='wf'), {args})\n")
        assert rc == 2, args
        assert msg in '\n'.join(lines), args


# ---------- the generator: DEFAULT_WATCH, the loop, the flag and the docs ----------

def _db(trigger, status: str = 'pending'):
    """Workflow 44 polls ServiceNow; trigger: its event_trigger JSON (None: no row; False: no event_trigger column)."""
    database = S.db(*S.MCP_DDL, S.LLM_DDL,
                    "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
                    "INSERT INTO mcp_servers VALUES (86, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
                    "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
                    "INSERT INTO mcp_server_tools VALUES (2, 86, 'wait_for_new', 'Wait', '{}')",
                    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)")
    if trigger is False:
        database.execute('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)')
    else:
        database.execute('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)')
        database.execute("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '*/2 * * * *', 'pending', NULL)")
        if trigger is not None:
            database.execute("INSERT INTO scheduled_workflows VALUES (2, 44, 'event', NULL, ?, ?)", [status, trigger])
    return database


def _code_graph() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'poll'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Poll ServiceNow',
                                                      'code': "def run(input, call_tool):\n    return {'route': 'job', 'output': 'x'}\n",
                                                      'exits': ['job', 'error'], 'mcp_servers': ['ServiceNow'], 'timeout_s': 30}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}


def _generate(database, options: dict | None = None, graph: dict | None = None) -> dict:
    return S.generator(database, graph or _code_graph(), Workflow({'id': 44, 'name': 'Mail poll', 'user_id': '3'})).generate(44, '3', options or {})


def _assert_watch_entry(code: str, label: str, default: str, file: str) -> None:
    assert f'DEFAULT_WATCH = {default}\n' in code, label
    assert code.count('def run_watch(') == 1, label
    assert 'when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER"' in code, label
    assert 'watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)' in code, label
    assert 'Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),' in code, label
    assert 'run_watch(self.trigger, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,' in code, label
    assert f'python {file} --watch ' in code, label
    S.assert_compiles(code, label)


def test_single_file_bakes_the_event_trigger():
    code = _generate(_db('{"server": "ServiceNow", "tool": "wait_jobs", "args": {"queue": "it"}}'))['code']
    _assert_watch_entry(code, 'single', '{\n    "server": "servicenow",\n    "tool": "wait_jobs",\n    "args": {\n        "queue": "it"\n    }\n}',
                        'mail_poll_langgraph.py')
    assert '--watch           # run whenever the event trigger says something new arrived (servicenow.wait_jobs)' in code


def test_modular_workflow_py_runs_the_watch_loop():
    files = S.files_of(_generate(_db('{"server": "ServiceNow", "tool": "wait_jobs"}'), {'modular': True}))
    wf = files['workflow.py']
    _assert_watch_entry(wf, 'modular', '{\n    "server": "servicenow",\n    "tool": "wait_jobs",\n    "args": {}\n}', 'workflow.py')
    assert 'from common import EVENTS, MCP, MCP_SERVER_SLUGS, ' in wf
    assert re.search(r'^import argparse, asyncio, json, ', wf, re.M)
    assert 'MCP_SERVER_SLUGS = ' in files['common.py']


def test_no_trigger_bakes_none():
    for case, database in {'no row': _db(None), 'paused': _db('{"server": "ServiceNow", "tool": "w"}', 'paused'),
                           'no column': _db(False), 'no tool': _db('{"server": "ServiceNow"}')}.items():
        code = _generate(database)['code']
        assert 'DEFAULT_WATCH = None\n' in code, case
        assert '--watch           # run whenever the event trigger says something new arrived (none saved: pass one)' in code, case


def test_a_trigger_on_a_server_no_node_uses_is_refused():
    with pytest.raises(RuntimeError, match=re.escape('The event trigger waits on MCP server "Outlook", which no node of this workflow uses')):
        _generate(_db('{"server": "Outlook", "tool": "wait_for_new"}'))


def test_a2_a_and_swarm_have_no_watch():
    files = S.files_of(_generate(_db(None), {'a2a': True}, S.demo_graph()))
    assert 'orchestrator.py' in files
    for path, code in files.items():
        assert 'add_argument("--watch"' not in code, path
        assert 'def run_watch(' not in code, path
        assert 'DEFAULT_WATCH' not in code, path
