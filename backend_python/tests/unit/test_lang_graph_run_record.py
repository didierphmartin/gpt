"""Port of backend/tests/Unit/LangGraphRunRecordTest.php (standalone plan task 3: run records in the server's
format, and the server's quiet rule)."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from tests.unit import lg_support as S


def _exec(py_path_src: str) -> tuple:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(py_path_src)
    try:
        r = subprocess.run([S.require_py310(), f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    return r.returncode, [line for line in (r.stdout + r.stderr).split('\n') if line != '']


def _py(tail: str, head: str = '') -> list:
    rc, out = _exec("from __future__ import annotations\nimport json, os, tempfile, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n"
                    + head + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.consoleBlock() + '\n' + tail)
    assert rc == 0, '\n'.join(out)
    assert out[-1] == 'ok', '\n'.join(out)
    return out


def test_a_run_writes_server_format_events_and_the_pointer():
    _py('''d = tempfile.mkdtemp()
seen = []
r = RunRecorder(d, 44, "Email prototype", listeners=[seen.append])
rid = r.begin()
assert len(rid) == 32 and all(c in "0123456789abcdef" for c in rid)
r.node_start("1000000017", "Outlook: get new email", "code")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: a@b.c\\nSubject: Claim", exit="new_mail")
r.node_start("21", "jev", "agent")
r.node_log("21", "jev routed to claims (confidence 0.97)")
r.node_complete("21", "jev", "agent", output="ok", route={"id": "23", "name": "claims"})
r.complete(success=True, output="done")
r.end(quiet=False)
name = open(os.path.join(d, "current")).read().strip()
lines = [json.loads(l) for l in open(os.path.join(d, name + ".jsonl"))]
assert [e["type"] for e in lines] == ["workflow_start", "node_start", "node_complete", "node_start", "node_log", "node_complete", "workflow_complete"], lines
assert lines[0]["run_id"] == rid and lines[0]["workflow_id"] == 44
assert lines[2]["drawflow_id"] is None and lines[2]["node_id"] == "1000000017" and lines[2]["exit"] == "new_mail"
assert lines[5]["route"] == {"id": "23", "name": "claims"}
assert all(isinstance(e["timestamp"], float) for e in lines)
assert len(seen) == 7
print("ok")
''')


def test_a_run_log_that_cannot_be_written_warns_once_and_the_run_goes_on():
    out = _py('''d = tempfile.mkdtemp()
blocker = os.path.join(d, "not_a_dir")
open(blocker, "w").close()
seen = []
r = RunRecorder(os.path.join(blocker, "runs"), 44, "wf", listeners=[seen.append])
r.begin(); r.node_start("1", "a", "code"); r.complete(success=True, output="x"); r.end(quiet=False)
assert [e["type"] for e in seen] == ["workflow_start", "node_start", "workflow_complete"], seen
print("second")
seen.clear()
r = RunRecorder(os.path.join(d, "runs"), 44, "wf", listeners=[seen.append])
r.begin()
os.chmod(r.current_path(), 0o444)
r.node_start("1", "a", "code"); r.node_log("1", "x"); r.complete(success=True, output="x"); r.end(quiet=False)
assert len(seen) == 4, seen
r.begin(); r.end(quiet=True)   # the next run writes again
print("ok")
''')
    assert len(out) == 4, '\n'.join(out)
    assert out[0].startswith('[warn] run log not written: ')
    assert out[1] == 'second'
    assert out[2].startswith('[warn] run log not written: ')
    assert 'Permission denied' in out[2]


def test_a_quiet_run_leaves_no_file():
    _py('''d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("1000000017", "T", "code"); r.node_complete("1000000017", "T", "code", exit="no_mail")
r.complete(success=True); r.end(quiet=True)
assert [f for f in os.listdir(d) if f.endswith(".jsonl")] == [], os.listdir(d)
print("ok")
''')


def test_quiet_rule_matches_the_server():
    _py('''types = {"1": "start", "9": "code", "2": "agent", "3": "output"}
agents = {"9": {"kind": "code"}, "2": {"kind": "agent"}}
assert is_quiet(types, {"9": "no_mail"}, agents, ["1", "9"]) is True
assert is_quiet(types, {"9": "new_mail"}, agents, ["1", "9", "2", "3"]) is False
assert is_quiet(types, {"9": "error"}, agents, ["1", "9"]) is False          # an error is never quiet
assert is_quiet(types, {}, agents, ["1", "2", "3"]) is False                 # no code node ran: a plain run
print("ok")
''')


def test_a_failed_run_is_kept():
    _py('''d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("2", "jev", "agent"); r.node_complete("2", "jev", "agent", success=False, error="boom")
r.complete(success=False, error="boom"); r.end(quiet=False)
name = open(os.path.join(d, "current")).read().strip()
last = [json.loads(l) for l in open(os.path.join(d, name + ".jsonl"))][-1]
assert last == {**last, "type": "workflow_complete", "success": False, "error": "boom"}
print("ok")
''')


def test_console_shows_the_live_overlay_texts():
    _py('''lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_start("1", "Start", "start"); r.node_complete("1", "Start", "start", output="poll")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: jane@acme.com\\nSubject: Claim for water damage\\n\\nBody", exit="new_mail")
r.node_log("21", "jev routed to claims (confidence 0.97)")
r.node_complete("21", "jev", "agent", output="x", route={"id": "23", "name": "claims"})
r.node_complete("23", "claims", "agent", output="y")
r.node_complete("24", "bad", "agent", success=False, error="oops")
assert lines == [], lines   # buffered until the run completes
r.complete(success=True, output="done")
assert lines[0] == "[10:42] New event — From: jane@acme.com · Subject: Claim for water damage", lines
assert not any("\\n" in l for l in lines), lines
assert "    · jev routed to claims (confidence 0.97)" in lines
assert "  ✓ jev → claims" in lines and "  ✓ claims" in lines and "  ✗ bad: oops" in lines
assert not any("Start" in l for l in lines), lines
assert lines[-1].startswith("[10:42] Done in ") and "done" not in lines[-1], lines
print("ok")
''')


def test_event_subject_matches_the_js():
    _py('''assert event_subject("From:\\t  a@b.c  \\nSubject:x y\\nFrom: later") == "From:\\t  a@b.c\\nSubject:x y"
assert event_subject("Subject: only") == "Subject: only"
assert event_subject("x" * 300) == "x" * 200
assert event_subject("") == ""
print("ok")
''')


def test_verbose_adds_outputs_and_the_answer():
    _py('''lines = []
v = ConsoleView(verbosity="verbose", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y" * 600); r.complete(success=True, output="a" * 300)
assert "      " + "y" * 500 in lines and "      " + "y" * 501 not in lines, lines
assert lines[-1].endswith(" — " + "a" * 200) and "a" * 201 not in lines[-1], lines
print("ok")
''')


def test_quiet_verbosity_and_discard():
    _py('''lines = []
v = ConsoleView(verbosity="quiet", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y"); r.complete(success=False, error="boom")
assert lines == ["[10:42] Failed: boom"], lines
lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_complete("1000000017", "T", "code", output="From: a@b.c", exit="new_mail")
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 2 and lines == [], (v.buffered, lines)
v.discard()
assert v.buffered == [] and lines == [], (v.buffered, lines)
r.begin()
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 1 and lines == []
r.begin()
assert v.buffered == [] and lines == [], (v.buffered, lines)
print("ok")
''')


def test_node_lines_go_through_run_out_where_there_is_one():
    head = 'import threading\n' + LangGraphRuntime.runEventsBlock() + '\n'
    out = _py('''RUN_OUT.begin("hold")
node_print("  [tool] -> x()")
assert RUN_OUT.held == ["  [tool] -> x()"], RUN_OUT.held
RUN_OUT.begin("drop")
node_print("dropped")
RUN_OUT.begin("print")
node_print("printed")
print("ok")
''', head)
    assert out == ['printed', 'ok']
    rc, plain = _exec('from __future__ import annotations\nfrom typing import Callable\n' + head + "node_print('no RUN_OUT here')\n")
    assert [rc, plain] == [0, ['no RUN_OUT here']]

    gen = S.demo_generator()
    codes = {'single': gen.generate(44, '3')['code']}
    for mode in ('modular', 'a2a'):
        for f in gen.generate(44, '3', {mode: True})['files']:
            codes[f"{mode}/{f['path']}"] = f['code']
    checked = 0
    for label, code in codes.items():
        if ((label != 'single' and not label.endswith('.py'))
                or ('class ToolCatalog' not in code and 'class DispatcherNode' not in code)):
            continue
        checked += 1
        assert re.search(r'^def node_print\(', code, re.M), label
        if 'RUN_OUT = RunOutput()' in code:
            assert code.index('NODE_OUT: Callable') < code.index('NODE_OUT = RUN_OUT'), label
        for bare in ('print(f"  [tool]', 'print(f"[node] [{nid}]', 'print(f"  [run_skill_script]'):
            assert not re.search(r'(?<!node_)' + re.escape(bare), code), f'{label}: {bare}'
    assert checked >= 3


def test_every_emission_carries_the_recorder_and_compiles():
    py = S.require_py310()
    gen = S.demo_generator()
    emissions = {'single': {'single.py': gen.generate(44, '3')['code']}}
    for mode in ('modular', 'a2a'):
        emissions[mode] = {f['path']: f['code'] for f in gen.generate(44, '3', {mode: True})['files']}
    for label, files in emissions.items():
        withRecorder = 0
        for path, code in files.items():
            if not path.endswith('.py'):
                continue
            with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
                f.write(code)
            r = subprocess.run([py, '-m', 'py_compile', f.name], capture_output=True, text=True)
            os.unlink(f.name)
            assert r.returncode == 0, f'{label}/{path}: {r.stdout}{r.stderr}'
            if 'class RunRecorder' in code:
                withRecorder += 1
                assert 'class WorkflowGraph' in code, f'{label}/{path}'
                assert code.index('class RunRecorder') < code.index('class WorkflowGraph')
                for needed in ('uuid', 'datetime'):
                    assert re.search(r'^(import .*\b' + needed + r'\b|from datetime import .*\bdatetime\b)', code, re.M), \
                        f'{label}/{path} imports {needed}'
            if 'GRAPH_RECORDER.node_log' in code:
                assert re.search(r'^GRAPH_RECORDER = NULL_RECORDER', code, re.M), f'{label}/{path}'
        assert withRecorder == 1, f'{label}: exactly one file carries the recorder'
    assert 'GRAPH_RECORDER.node_log' in emissions['single']['single.py']
    assert 'GRAPH_RECORDER.node_log' in emissions['modular']['workflow.py']
