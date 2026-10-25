"""Port of backend/tests/Unit/LangGraphCronLoopTest.php (spec 2026-10-07 §7.2: the compiled loop, with
CronExpression.php's semantics -- compared here against the Python CronExpression port)."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from datetime import datetime

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.cron_expression import CronExpression
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from tests.unit import lg_support as S

CLOCK = '''class Clock:
    def __init__(self, *args, jump=0):
        self.t, self.slept, self.jump = datetime(*args), [], jump
    def now(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s)
        self.t += timedelta(seconds=s + self.jump)
        self.jump = 0

'''


def _run_py(tail: str) -> tuple:
    src = ('from __future__ import annotations\nimport argparse, asyncio, re, signal, time\nfrom datetime import datetime, timedelta\n'
           + LangGraphRuntime.cronBlock() + '\n' + CLOCK + tail)
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([S.require_py310(), f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    return r.returncode, [line for line in (r.stdout + r.stderr).split('\n') if line != '']


def _py(tail: str) -> list:
    rc, out = _run_py(tail)
    assert rc == 0, '\n'.join(out)
    return out


def test_next_fire_matches_the_php_parser():
    cases = [
        ('*/2 * * * *', '2026-10-07 10:42:30'), ('*/5 8-18 * * 1-5', '2026-10-09 18:57:00'),
        ('0 9 * * 7', '2026-10-07 00:00:00'), ('0 9 * * 0', '2026-10-07 00:00:00'),
        ('0 0 1 * 1', '2026-10-07 00:00:00'), ('0 0 */2 * 1', '2026-10-07 00:00:00'),
        ('0 0 * * */2', '2026-10-07 00:00:00'), ('5,35 9-17/4 * * *', '2026-10-07 13:36:00'),
        ('5/20 * * * *', '2026-10-07 10:46:00'), ('0 0 1 * *', '2026-10-31 23:59:59'),
        ('59 23 31 * *', '2026-11-01 00:00:00'), ('0 0 29 2 *', '2026-10-07 00:00:00'),
        ('30 12 29 2 1', '2027-02-27 00:00:00'), ('15 10 * * *', '2026-12-31 10:15:00'),
        ('  0   0  1 1  * ', '2026-10-07 00:00:00'), ('0-59/15 */6 1-7 1,7 1-5', '2026-10-07 00:00:00'),
    ]
    tail = ''.join(f"print(cron_next({json.dumps(e)}, datetime.fromisoformat('{at}')).strftime('%Y-%m-%d %H:%M'))\n" for e, at in cases)
    out = _py(tail)
    for i, (e, at) in enumerate(cases):
        ref = CronExpression(e).nextAfter(datetime.fromisoformat(at)).strftime('%Y-%m-%d %H:%M')
        assert out[i] == ref, f'{e} after {at}'


def test_invalid_expressions_are_refused_like_the_php_parser():
    exprs = ['* * * *', '* * * * * *', '', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
             '5-1 * * * *', '*/0 * * * *', '+5 * * * *', 'a * * * *', '1-2-3 * * * *', '5/ * * * *', ',5 * * * *',
             '0 0 31 2 *', '0 0 30 2 *', '*/2 * * * *', '0 9 * * 7']
    tail = ''.join(f"try:\n    cron_next({json.dumps(e)}, datetime(2026, 10, 7))\n    print('ok')\nexcept ValueError:\n    print('bad')\n"
                   for e in exprs)
    out = _py(tail)
    for i, e in enumerate(exprs):
        assert out[i] == ('ok' if CronExpression.isValid(e) else 'bad'), repr(e)


def test_drains_quiet_and_survives_errors():
    text = '\n'.join(_py('''outputs = iter(["mail 1", "mail 2", "", "boom", ""])
def run_once():
    o = next(outputs)
    if o == "boom":
        raise RuntimeError("reconnect_needed")
    return o
c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=3, verbosity="verbose")   # verbose: a quiet tick says so
print("sleeps", len(c.slept))
'''))
    assert '2 run(s) did work' in text
    assert 'reconnect_needed' in text
    assert 'nothing to do' in text
    assert 'sleeps 6' in text


def test_a_quiet_tick_prints_nothing():
    out = _py('''outputs = iter(["", "", "mail", "", "boom"])
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
run_cron("* * * * *", lambda: "mail", drains=False, sleep=c.sleep, now=c.now, ticks=1, verbosity="quiet")
''')
    assert out == ["[cron] '* * * * *': next run 2026-10-07 10:01. Ctrl-C to stop.",
                   '[tick 10:03] 1 run(s) did work', '[tick 10:04] error after 0 run(s) that did work: RuntimeError: down',
                   'verbose', "[cron] '* * * * *': next run 2026-10-07 10:05. Ctrl-C to stop.", '[tick 10:05] nothing to do',
                   'quiet', "[cron] '* * * * *': next run 2026-10-07 10:06. Ctrl-C to stop."]


def test_no_drain_without_code_nodes():
    out = _py('''n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "report", drains=False, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))
''')
    assert 'runs 1' in out


def test_drain_stops_at_twenty_runs_per_tick():
    out = _py('''n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "mail", drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))
''')
    assert 'runs 20' in out
    assert '20 run(s) did work' in '\n'.join(out)


def test_an_error_after_work_is_logged_and_ends_the_drain():
    out = _py('''calls = []
def run_once():
    calls.append(1)
    if len(calls) == 2:
        raise RuntimeError("code node 'Poll Outlook' took its error exit")
    return "mail"
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(calls))
''')
    text = '\n'.join(out)
    assert 'runs 2' in out
    assert "error after 1 run(s) that did work: RuntimeError: code node 'Poll Outlook' took its error exit" in text
    assert 'nothing to do' not in text


def test_ticks_fire_on_the_schedule_in_naps_of_a_minute_at_most():
    out = _py('''c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", lambda: "", drains=True, sleep=c.sleep, now=c.now, ticks=3, verbosity="verbose")   # verbose: a quiet tick says so
print(c.slept)
''')
    assert out[-1] == '[60.0, 30.0, 60.0, 60.0, 60.0, 60.0]'
    assert '[tick 10:44] nothing to do' in '\n'.join(out)
    assert '[tick 10:48] nothing to do' in '\n'.join(out)


def test_a_clock_jump_during_a_nap_fires_without_sleeping_the_old_gap():
    out = _py('''c = Clock(2026, 10, 7, 10, 0, 30, jump=3600)   # the first nap lasts an hour (laptop asleep, DST change)
run_cron("*/30 * * * *", lambda: "", drains=False, sleep=c.sleep, now=c.now, ticks=2, verbosity="verbose")   # verbose: a quiet tick says so
print(c.slept)
''')
    assert out[-1] == '[' + ', '.join(['60.0'] * 29 + ['30.0']) + ']'
    assert '[tick 10:30] nothing to do' in '\n'.join(out)
    assert '[tick 11:30] nothing to do' in '\n'.join(out)


def test_sigterm_stops_the_loop_like_ctrl_c():
    out = _py('''import os, threading
before = signal.getsignal(signal.SIGTERM)
threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
try:
    run_cron("0 0 1 1 *", lambda: "", drains=False)
finally:
    print("finally ran")
print("handler restored", signal.getsignal(signal.SIGTERM) is before)
''')
    assert out[-3:] == ['[cron] stopped.', 'finally ran', 'handler restored True']


def test_a_cancelled_run_is_an_error_and_its_leftover_tasks_are_cancelled():
    out = _py('''runs = RunLoop()
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
print("leftover cancelled", started[0].cancelled())
''')
    text = '\n'.join(out)
    assert '[tick 10:01] error after 0 run(s) that did work: CancelledError' in text
    assert 'pending before run 2: 0' in out
    assert '[tick 10:02] nothing to do' in text
    assert 'leftover cancelled True' in out


def test_drain_returns_the_error_line_when_a_run_raises():
    out = _py('''def run_once():
    raise RuntimeError("model down")
print(drain(run_once, drains=True, max_runs=20))
''')
    assert out == ['error after 0 run(s) that did work: RuntimeError: model down']


def test_each_run_and_its_event_loop_stay_on_one_worker_thread():
    out = _py('''import threading
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
print("pending", len([t for t in asyncio.all_tasks(loop) if not t.done()]), "same loop", runs.loop is loop)
''')
    assert out == ['error after 0 run(s) that did work: RuntimeError: boom', 'off main True one thread True 3', 'pending 0 same loop True']


def test_an_abandoned_run_keeps_its_loop_and_the_next_run_gets_a_fresh_one():
    out = _py('''import threading
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
print("old loop never cancelled", all(l is not first for l in cancelled_on), "abandoned threads", len(runs.abandoned))
''')
    assert out == ['abandoned a run after 30 min', '1 run(s) did work', 'fresh True ran on fresh True old still busy True',
                   'old loop never cancelled True abandoned threads 1']


def test_a_failed_run_makes_the_state_warn():
    out = _py('''outputs = iter(["boom", "", ""])
def run_once():
    if next(outputs) == "boom":
        raise RuntimeError("model down")
    return ""
st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append((s.line, s.tone)))
c = Clock(2026, 10, 7, 10, 0)
CronLoop("* * * * *", run_once, drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(ticks=1)
print(st.line, "|", st.tone, "|", st.last_failed, "|", st.listening)
print(("Scheduled — the last run failed", "warn") in seen, seen[0])
''')
    assert out[-2:] == ['Scheduled — the last run failed | warn | True | False',
                        "True ('Scheduled: * * * * * — next run 10:01', 'ok')"]
    assert 'Scheduled — the last run failed' not in out, 'cron state lines are not echoed: its [tick] line is the console'


def test_the_run_cap_and_a_stop_event_in_a_thread():
    out = _py('''import threading
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
print("alive", t.is_alive(), "handler kept", signal.getsignal(signal.SIGTERM) is before, "listening", st.listening)
''')
    assert out[0] == 'abandoned a run after 30 min'
    assert out[-2:] == ['[cron] stopped.', 'alive False handler kept True listening False']


def test_a_second_copy_of_the_cron_loop_exits_zero():
    out = _py('''import tempfile, os
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
with SingleInstance(p):
    try:
        run_cron("* * * * *", lambda: "", drains=False, lock_path=p, ticks=1)
    except SystemExit as e:
        print("exit", e.code)
''')
    assert out[0].startswith('[cron] already running (')
    assert out[1:] == ['exit 0']


def test_cli_expression_falls_back_to_the_baked_schedule_and_refuses_bad_input():
    out = _py('''ap = argparse.ArgumentParser()
print(CronExpression.from_cli(ap, None, "*/2 * * * *"))
print(CronExpression.from_cli(ap, "", "*/2 * * * *"))
print(CronExpression.from_cli(ap, "0 9 * * 1", "*/2 * * * *"))
''')
    assert out[:3] == ['None', '*/2 * * * *', '0 9 * * 1']
    rc, out = _run_py("CronExpression.from_cli(argparse.ArgumentParser(), '', None)")
    assert rc == 2
    assert 'this workflow has no cron schedule' in '\n'.join(out)
    rc, out = _run_py("CronExpression.from_cli(argparse.ArgumentParser(), '0 0 31 2 *', None)")
    assert rc == 2
    assert 'never fires' in '\n'.join(out)


def test_code_node_error_exit_is_reported_by_the_graph():
    out = _py("import json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
              "END, START, StateGraph, WFState = '__end__', '__start__', None, None\n"
              + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '''g = WorkflowGraph(edges=[], order=[], node_types={}, start_documents=[], run_node=None,
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
g.outputs = {"2": {"source": "Poll Outlook", "text": "line one\\n\\n  line two\\t" + "x" * 400}}   # e.g. a whole email body
try:
    g.check_error_exits()
except ErrorExitTaken as e:
    print("long", e)
''')
    assert out[:4] == ['clean ok', 'other exits ok', "raised code node 'Poll Outlook' took its error exit",
                       "raised code node 'Poll Outlook' took its error exit: not_connected ['Poll Outlook']"]
    reason = 'line one line two ' + 'x' * 182
    assert out[4:] == [f"long code node 'Poll Outlook' took its error exit: {reason}…"]


# ---------- the generator: DEFAULT_CRON, the loop and the docs in every entry file ----------

def _db(cron: str | None, status: str = 'pending', older: bool = True):
    database = S.db(*S.MCP_DDL, S.LLM_DDL,
                    "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
                    "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
                    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)")
    if cron is not None:
        database.execute('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)')
        if older:
            database.execute("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '0 * * * *', 'pending')")
        database.execute("INSERT INTO scheduled_workflows VALUES (2, 44, 'daily', NULL, 'pending')")
        database.execute("INSERT INTO scheduled_workflows VALUES (3, 45, 'cron', '1 1 1 1 1', 'pending')")
        database.execute('INSERT INTO scheduled_workflows VALUES (4, 44, ?, ?, ?)', ['cron', cron, status])
    return database


def _code_graph() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'poll'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Poll ServiceNow',
                                                      'code': "def run(input, call_tool):\n    return {'route': 'job', 'output': 'x'}\n",
                                                      'exits': ['job', 'error'], 'mcp_servers': ['ServiceNow'], 'timeout_s': 30}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}


def _generate(database, graph: dict, options: dict | None = None, orchestration: str = 'workflow') -> dict:
    wf = Workflow({'id': 44, 'name': 'Mail poll', 'user_id': '3'}).setOrchestration(orchestration)
    return S.generator(database, graph, wf).generate(44, '3', options or {})


def _assert_cron_entry(code: str, label: str, default: str, drains: str, file: str, watch: bool = False) -> None:
    assert f'DEFAULT_CRON = {default}\n' in code, label
    assert re.search(r'^from datetime import datetime, timedelta$', code, re.M), label
    assert re.search(r'^import argparse, ', code, re.M), label
    assert code.count('def run_cron(') == 1, label
    assert ('when' if watch else 'ap') + '.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR"' in code, label
    if watch:
        assert 'CronExpression.from_cli(ap, a.cron if a.cron is not None else ("" if mode == "cron" else None), DEFAULT_CRON)' in code, label
        assert f'    drains = {drains}\n' in code, label
        assert 'Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),' in code, label
        assert 'run_cron(self.cron_expr, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,' in code, label
    else:
        assert 'CronExpression.from_cli(ap, a.cron, DEFAULT_CRON)' in code, label
        assert f'run_cron(expr, run_once, drains={drains}, loop=runs)' in code, label
    assert re.search(r'^import argparse, asyncio, [a-z, ]*\bsignal\b', code, re.M), label
    assert 'allow_abbrev=False)' in code, label
    assert f'python {file} "your prompt here" --cron   # a prompt goes BEFORE --cron' in code, label
    assert re.search(r'def run_once\(\) -> str:\n(?:        [^\n]*\n)*?        (?:NODE_DURATIONS\.clear\(\)|session = uuid)', code), label
    assert f'python {file} --cron ' in code, label
    assert f'python {file} --cron "*/5 8-18 * * 1-5"' in code, label
    S.assert_compiles(code, label)


def test_single_file_bakes_the_newest_active_cron_schedule():
    code = _generate(_db('*/5 8-18 * * 1-5'), _code_graph())['code']
    _assert_cron_entry(code, 'single', '"*/5 8-18 * * 1-5"', 'bool(CODE_NODES)', 'mail_poll_langgraph.py', True)
    assert 'python mail_poll_langgraph.py --cron            # loop on the Start node schedule (*/5 8-18 * * 1-5)' in code
    assert 'graph.check_error_exits()' in code


def test_the_docs_say_what_work_means_for_a_drain():
    line = 'needs an Output node to drain'
    code = _generate(_db('*/2 * * * *'), _code_graph())['code']
    assert 'work = a non-empty final output' in code
    assert line in code
    files = S.files_of(_generate(_db('*/2 * * * *'), _code_graph(), {'modular': True}))
    assert line in files['workflow.py']
    a2a = S.files_of(_generate(_db('*/2 * * * *'), S.demo_graph(), {'a2a': True}))
    assert line not in a2a['orchestrator.py']


def test_a_paused_newest_schedule_falls_back_to_the_older_active_one():
    assert 'DEFAULT_CRON = "0 * * * *"\n' in _generate(_db('*/2 * * * *', 'paused'), _code_graph())['code']


def test_no_schedule_bakes_none():
    for i, database in enumerate((_db(None), _db('*/2 * * * *', 'paused', False))):
        code = _generate(database, _code_graph())['code']
        assert 'DEFAULT_CRON = None\n' in code, f'case {i}'
        assert '--cron            # loop on the Start node schedule (none saved: pass an expression)' in code, f'case {i}'


def test_modular_workflow_py_runs_the_loop():
    files = S.files_of(_generate(_db('*/2 * * * *'), _code_graph(), {'modular': True}))
    _assert_cron_entry(files['workflow.py'], 'modular', '"*/2 * * * *"',
                       'any(ad["kind"] == "code" for ad in AGENTS.values())', 'workflow.py', True)
    assert 'graph.check_error_exits()' in files['workflow.py']
    assert 'def run_cron(' not in files['common.py']


def test_a2_a_orchestrator_runs_the_loop_with_one_supervisor():
    orch = S.files_of(_generate(_db('*/2 * * * *'), S.demo_graph(), {'a2a': True}))['orchestrator.py']
    _assert_cron_entry(orch, 'a2a', '"*/2 * * * *"', 'False', 'orchestrator.py')
    assert orch.count('sup.start()') == 1
    assert orch.index('CronExpression.from_cli(') < orch.index('sup = AgentSupervisor('), 'a bad --cron is refused before any agent is started'


def test_swarm_workflow_py_runs_the_loop():
    def agent(name):
        return {'type': 'agent-template', 'agent_name': name, 'agent_type': 'standard',
                'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-6',
                'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}
    graph = {'nodes': [{'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'Plan a trip.'}},
                       {'id': '2', 'node_type': '', 'config': agent('Alice')}, {'id': '3', 'node_type': '', 'config': agent('Bob')}],
             'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}]}
    files = S.files_of(_generate(_db('*/2 * * * *'), graph, {'modular': True}, 'swarm'))
    _assert_cron_entry(files['workflow.py'], 'swarm', '"*/2 * * * *"', 'False', 'workflow.py')
    assert '_GRAPH.checkpointer.delete_thread(session)' in files['workflow.py']
