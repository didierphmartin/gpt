"""Port of backend/tests/Unit/LangGraphCliTest.php (standalone plan task 6: the program runs in the Start's mode;
--once; the recorder and console wired; Listener)."""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S


def _py(tail: str) -> list:
    src = ('from __future__ import annotations\n'
           'import argparse, asyncio, json, os, re, signal, sys, threading, time, uuid\n'
           'from datetime import datetime, timedelta\nfrom typing import Callable\n'
           + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.consoleBlock() + '\n'
           + LangGraphRuntime.cronBlock() + '\n' + LangGraphRuntime.watchBlock() + '\n'
           + LangGraphRuntime.listenerBlock() + '\n' + tail)
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([S.require_py310(), f.name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    finally:
        os.unlink(f.name)
    out = S.exec_lines(r.stdout)
    assert r.returncode == 0, '\n'.join(out)
    assert out[-1] == 'ok', '\n'.join(out)
    return out


def test_choose_mode():
    _py('''from types import SimpleNamespace as A
def a(**k): return A(**{"prompt": [], "once": False, "cron": None, "watch": None, **k})
assert choose_mode(a(), "watch") == "watch"
assert choose_mode(a(), "cron") == "cron"
assert choose_mode(a(), "prompt") == "once"
assert choose_mode(a(prompt=["hi"]), "watch") == "once"
assert choose_mode(a(once=True), "watch") == "once"
assert choose_mode(a(cron=""), "watch") == "cron"
assert choose_mode(a(watch=""), "prompt") == "watch"
print("ok")
''')


def test_listener_starts_once_and_stops():
    _py('''import tempfile, threading
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
print("ok")
''')


def test_listener_starts_again_after_a_stop_and_installs_no_signal_handler():
    _py('''import tempfile
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
print("ok")
''')


def test_stop_then_start_at_once_leaves_a_running_listener():
    _py('''import tempfile, threading
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
print("ok")
''')


def test_banner_names_the_mode():
    out = _py('''MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
w = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {"folder": "Inbox"}), state=LoopState(), lock_path=None)
print(w.banner())
c = Listener("cron", lambda: "", drains=True, loop=None, cron_expr="0 9 * * *", trigger=None, state=LoopState(), lock_path=None)
print(c.banner(now=datetime(2026, 10, 15, 8, 0)))
print("ok")
''')
    assert out[0] == 'Listening for events: outlook.wait_for_new {"folder":"Inbox"} (Ctrl-C to stop)'
    assert out[1] == 'Scheduled: 0 9 * * * — next run 2026-10-15 09:00 (Ctrl-C to stop)'


def test_a_lock_held_elsewhere_sets_the_state_and_ends_the_thread():
    out = _py('''import tempfile, fcntl
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
print("ok")
''')
    assert 'Traceback' not in '\n'.join(out)


def test_a_broken_state_listener_does_not_stop_the_others():
    out = _py('''st = LoopState(echo=False)
seen = []
def broken(s): raise RuntimeError("feed gone")
st.on_change += [broken, lambda s: seen.append(s.line)]
st.set("Listening for events", "ok")
assert seen == ["Listening for events"], seen
print("ok")
''')
    assert '[warn] state listener failed: feed gone' in out


# ---------- the generator: the entry files ----------

POLL = ("def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n")
_DEFAULT_WATCH = {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}


def _db():
    return S.db(*S.MCP_DDL, S.LLM_DDL,
                'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
                "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
                "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')")


def _generate(graph: dict, options: dict | None = None) -> dict:
    return S.generator(_db(), graph, Workflow({'id': 44, 'name': 'Email prototype', 'user_id': '3'})).generate(44, '3', options or {})


def _option_graph(watch=_DEFAULT_WATCH) -> dict:
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 5}},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from_node_id': '17', 'to_node_id': '18', 'from_port': 'output_1'}]}
    trigger = {'label': 'Outlook: get new email', 'work_exit': 'new_mail', **({'watch': watch} if watch is not None else {})}
    return StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get new email', 'code': POLL,
        'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30, 'start_trigger': trigger})


def _code_graph() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'NOTHING'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Check',
                                                      'code': "def run(input, call_tool):\n    if 'WORKNOW' in str(input):\n        return {'route': 'work', 'output': 'mail for you'}\n"
                                                              "    if 'FAILNOW' in str(input):\n        return {'route': 'error', 'output': 'mailbox gone'}\n"
                                                              "    return {'route': 'no_mail', 'output': None}\n",
                                                      'exits': ['work', 'no_mail', 'error'], 'mcp_servers': [], 'timeout_s': 30}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}


def _files(gen: dict) -> dict:
    return S.files_of(gen) if 'files' in gen else {'workflow.py': gen['code']}


def test_entry_files_run_in_the_starts_mode_and_compile():
    S.require_py310()
    for label, opts in (('single', {}), ('modular', {'modular': True})):
        files = _files(_generate(_option_graph(), opts))
        wf = files['workflow.py']
        for needle in ('mode = choose_mode(a, START_MODE)', 'when.add_argument("--once"', 'talk.add_argument("--quiet"',
                       'talk.add_argument("--verbose"', 'RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")',
                       'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))', 'def make_run_once(',
                       'lock_path=os.path.join(PACKAGE_DIR, ".run.lock")', 'class Listener', 'def choose_mode(',
                       'recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])', 'global GRAPH_RECORDER'):
            assert needle in wf, f'{label}: {needle}'
        assert wf.index('def run_watch(') < wf.index('class Listener'), f'{label}: Listener after the watch block'
        assert "the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)" in wf, label
        assert ' --once ' in wf, label
        for path, code in files.items():
            if path.endswith('.py'):
                S.assert_compiles(code, f'{label}/{path}')


# ---------- the generated program, run (needs langgraph: the SynergyAI venv) ----------

def _run_program(files: dict, args: list, script: str | None = None) -> tuple:
    venv = S.venv()
    if script is not None:
        files = {**files, 'drive.py': script}
    d = tempfile.mkdtemp(prefix='lgcli_')
    os.makedirs(f'{d}/pkg')
    for path, code in files.items():
        os.makedirs(os.path.dirname(f'{d}/pkg/{path}'), exist_ok=True)
        with open(f'{d}/pkg/{path}', 'w', encoding='utf-8') as fh:
            fh.write(code)
    r = subprocess.run([venv, 'drive.py' if script is not None else 'workflow.py', *args], cwd=f'{d}/pkg',
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''), 'SYNERGYAI_OUTPUT_ROOT': f'{d}/outputs'})
    return r.returncode, r.stdout, d


def test_a_generated_program_records_a_work_run_and_drops_a_quiet_one():
    S.venv()
    for label, opts in (('single', {}), ('modular', {'modular': True})):
        files = _files(_generate(_code_graph(), opts))
        rc, text, d = _run_program(files, ['--once', 'NOTHING'])
        assert rc == 0, f'{label} quiet: {text}'
        assert glob.glob(f'{d}/pkg/runs/*.jsonl') == [], f'{label}: a quiet run leaves no run log\n{text}'
        assert 'Done in' not in text, label
        assert 'FINAL OUTPUT' not in text, label
        assert '✓' not in text, label

        rc, text, d = _run_program(files, ['--once', 'WORKNOW'])
        assert rc == 0, f'{label} work: {text}'
        logs = glob.glob(f'{d}/pkg/runs/*.jsonl')
        assert len(logs) == 1, f'{label}\n{text}'
        assert os.path.basename(logs[0])[:-6] == open(f'{d}/pkg/runs/current').read().strip()
        events = [json.loads(line) for line in open(logs[0]).read().split('\n') if line != '']
        code = [e for e in events if e['type'] == 'node_complete' and e['node_id'] == '2']
        assert len(code) == 1, label
        assert code[0]['exit'] == 'work', label
        assert code[0]['node_name'] == 'Check', label
        assert [e['type'] for e in events[:3]] == ['workflow_start', 'node_start', 'node_complete'], label
        last = events[-1]
        assert last['type'] == 'workflow_complete', label
        assert last['success'] is True, label
        assert last['output'] == 'mail for you', label
        assert '  ✓ Check' in text, label
        assert re.search(r'\[\d\d:\d\d\] Done in \d+\.\d s', text), label


LOOP_DRIVER = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location("prog", "workflow.py")
m = importlib.util.module_from_spec(spec)
sys.modules["prog"] = m
spec.loader.exec_module(m)
view = m.ConsoleView(sys.argv[1])
rec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])
m.RUN_OUT.chatty = sys.argv[1] == "verbose"
print("RESULT", repr(m.make_run_once(sys.argv[2], m.RunLoop(), view, rec, loop_mode=True)()))
'''


def test_loop_runs_print_only_the_block_and_quiet_runs_nothing():
    S.venv()
    for label, opts in (('single', {}), ('modular', {'modular': True})):
        files = _files(_generate(_code_graph(), opts))
        rc, text, _ = _run_program(files, ['normal', 'NOTHING'], LOOP_DRIVER)
        assert rc == 0, f'{label}: {text}'
        assert text.strip() == "RESULT ''", f'{label}: a quiet loop run prints nothing'

        rc, text, _ = _run_program(files, ['normal', 'WORKNOW'], LOOP_DRIVER)
        assert rc == 0, f'{label}: {text}'
        lines = text.rstrip().split('\n')
        assert lines[:4] == ["    · 'Check' code -- exits=['work', 'no_mail', 'error'], mcp_servers=[]", "    · exit 'work'",
                             '  ✓ Check', '  ✓ Output'], f'{label}: {text}'
        assert re.match(r'^\[\d\d:\d\d\] Done in \d+\.\d s$', lines[4]), f'{label}: {text}'
        assert lines[5] == "RESULT 'mail for you'", f'{label}: {text}'
        assert len(lines) == 6, f'{label}: no [node], [info], FINAL OUTPUT or RUN SUMMARY\n{text}'

        rc, text, _ = _run_program(files, ['verbose', 'WORKNOW'], LOOP_DRIVER)
        assert rc == 0, f'{label}: {text}'
        assert '[info] Running...' in text, label
        assert "[node] [2] exit 'work'" in text, label
        assert 'FINAL OUTPUT' not in text, label
        assert text.index('[info] Running...') < text.index('  ✓ Check'), f'{label}: progress lines before the block'

        rc, text, _ = _run_program(files, ['--once', '--quiet', 'WORKNOW'])
        assert rc == 0, f'{label}: {text}'
        assert re.match(r'^\[\d\d:\d\d\] Done in \d+\.\d s$', text.strip()), f'{label} --once --quiet: {text}'

        rc, text, _ = _run_program(files, ['--once', '--quiet', 'FAILNOW'])
        assert rc == 1, f'{label}: {text}'
        assert re.match(r"^\[\d\d:\d\d\] Failed: ErrorExitTaken: code node 'Check' took its error exit: mailbox gone$", text.strip()), \
            f'{label} --once --quiet: {text}'


def test_a_start_option_without_a_watch_is_a_usage_error():
    S.venv()
    for label, opts in (('single', {}), ('modular', {'modular': True})):
        files = _files(_generate(_option_graph(None), opts))
        assert 'START_MODE = "watch"' in files['workflow.py'], label
        assert 'DEFAULT_WATCH = None' in files['workflow.py'], label
        rc, text, _ = _run_program(files, [])
        assert rc == 2, f'{label}: {text}'
        assert '--watch needs a trigger: this workflow has no event trigger' in text, label
        assert 'Traceback' not in text, label
