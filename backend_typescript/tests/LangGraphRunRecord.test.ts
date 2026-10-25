/** Port of backend/tests/Unit/LangGraphRunRecordTest.php (standalone plan task 3: run records in the server's format, and the server's quiet rule). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { a2aGenerator } from './support/lgFixtures';
import { execLines, python310 } from './support/lgFixturesB';

const PY = python310();
const NO_PY = PY === null ? 'Python 3.10+ not available' : false;

function runFile(source: string, args: string[] = []): [number, string[]] {
  const dir = mkdtempSync(path.join(tmpdir(), 'rr'));
  const file = path.join(dir, 'rr.py');
  writeFileSync(file, source);
  try {
    return execLines([PY!, ...args, file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function py(tail: string, head = ''): string[] {
  const [rc, out] = runFile('from __future__ import annotations\nimport json, os, tempfile, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n'
    + head + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.consoleBlock() + '\n' + tail);
  assert.equal(rc, 0, out.join('\n'));
  assert.equal(out[out.length - 1], 'ok', out.join('\n'));
  return out;
}

test('testARunWritesServerFormatEventsAndThePointer', { skip: NO_PY }, () => {
  py(String.raw`d = tempfile.mkdtemp()
seen = []
r = RunRecorder(d, 44, "Email prototype", listeners=[seen.append])
rid = r.begin()
assert len(rid) == 32 and all(c in "0123456789abcdef" for c in rid)
r.node_start("1000000017", "Outlook: get new email", "code")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: a@b.c\nSubject: Claim", exit="new_mail")
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
print("ok")`);
});

/** Final review M-b: the run log is best effort; one [warn] per run, the run and its listeners carry on. */
test('testARunLogThatCannotBeWrittenWarnsOnceAndTheRunGoesOn', { skip: NO_PY }, () => {
  const out = py(String.raw`d = tempfile.mkdtemp()
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
print("ok")`);
  assert.equal(out.length, 4, out.join('\n'));
  assert.ok(out[0].startsWith('[warn] run log not written: '));
  assert.equal(out[1], 'second');
  assert.ok(out[2].startsWith('[warn] run log not written: '));
  assert.ok(out[2].includes('Permission denied'));
});

test('testAQuietRunLeavesNoFile', { skip: NO_PY }, () => {
  py(String.raw`d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("1000000017", "T", "code"); r.node_complete("1000000017", "T", "code", exit="no_mail")
r.complete(success=True); r.end(quiet=True)
assert [f for f in os.listdir(d) if f.endswith(".jsonl")] == [], os.listdir(d)
print("ok")`);
});

test('testQuietRuleMatchesTheServer', { skip: NO_PY }, () => {
  py(String.raw`types = {"1": "start", "9": "code", "2": "agent", "3": "output"}
agents = {"9": {"kind": "code"}, "2": {"kind": "agent"}}
assert is_quiet(types, {"9": "no_mail"}, agents, ["1", "9"]) is True
assert is_quiet(types, {"9": "new_mail"}, agents, ["1", "9", "2", "3"]) is False
assert is_quiet(types, {"9": "error"}, agents, ["1", "9"]) is False          # an error is never quiet
assert is_quiet(types, {}, agents, ["1", "2", "3"]) is False                 # no code node ran: a plain run
print("ok")`);
});

test('testAFailedRunIsKept', { skip: NO_PY }, () => {
  py(String.raw`d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("2", "jev", "agent"); r.node_complete("2", "jev", "agent", success=False, error="boom")
r.complete(success=False, error="boom"); r.end(quiet=False)
name = open(os.path.join(d, "current")).read().strip()
last = [json.loads(l) for l in open(os.path.join(d, name + ".jsonl"))][-1]
assert last == {**last, "type": "workflow_complete", "success": False, "error": "boom"}
print("ok")`);
});

/** Ported from frontend/assets/js/start-options.js eventSubject(); ConsoleView joins From/Subject with " · " (spec §4.2). */
test('testConsoleShowsTheLiveOverlayTexts', { skip: NO_PY }, () => {
  py(String.raw`lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_start("1", "Start", "start"); r.node_complete("1", "Start", "start", output="poll")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: jane@acme.com\nSubject: Claim for water damage\n\nBody", exit="new_mail")
r.node_log("21", "jev routed to claims (confidence 0.97)")
r.node_complete("21", "jev", "agent", output="x", route={"id": "23", "name": "claims"})
r.node_complete("23", "claims", "agent", output="y")
r.node_complete("24", "bad", "agent", success=False, error="oops")
assert lines == [], lines   # buffered until the run completes
r.complete(success=True, output="done")
assert lines[0] == "[10:42] New event — From: jane@acme.com · Subject: Claim for water damage", lines
assert not any("\n" in l for l in lines), lines
assert "    · jev routed to claims (confidence 0.97)" in lines
assert "  ✓ jev → claims" in lines and "  ✓ claims" in lines and "  ✗ bad: oops" in lines
assert not any("Start" in l for l in lines), lines
assert lines[-1].startswith("[10:42] Done in ") and "done" not in lines[-1], lines
print("ok")`);
});

test('testEventSubjectMatchesTheJs', { skip: NO_PY }, () => {
  py(String.raw`assert event_subject("From:\t  a@b.c  \nSubject:x y\nFrom: later") == "From:\t  a@b.c\nSubject:x y"
assert event_subject("Subject: only") == "Subject: only"
assert event_subject("x" * 300) == "x" * 200
assert event_subject("") == ""
print("ok")`);
});

test('testVerboseAddsOutputsAndTheAnswer', { skip: NO_PY }, () => {
  py(String.raw`lines = []
v = ConsoleView(verbosity="verbose", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y" * 600); r.complete(success=True, output="a" * 300)
assert "      " + "y" * 500 in lines and "      " + "y" * 501 not in lines, lines
assert lines[-1].endswith(" — " + "a" * 200) and "a" * 201 not in lines[-1], lines
print("ok")`);
});

test('testQuietVerbosityAndDiscard', { skip: NO_PY }, () => {
  py(String.raw`lines = []
v = ConsoleView(verbosity="quiet", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y"); r.complete(success=False, error="boom")
assert lines == ["[10:42] Failed: boom"], lines
# discard() on a normal view: the buffer is real, and discarding it prints nothing
lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_complete("1000000017", "T", "code", output="From: a@b.c", exit="new_mail")
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 2 and lines == [], (v.buffered, lines)
v.discard()
assert v.buffered == [] and lines == [], (v.buffered, lines)
# a run left uncompleted: the next begin() clears its lines, which never print
r.begin()
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 1 and lines == []
r.begin()
assert v.buffered == [] and lines == [], (v.buffered, lines)
print("ok")`);
});

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Final review M-a: the node runtime's own lines go through node_print(). */
test('testNodeLinesGoThroughRunOutWhereThereIsOne', { skip: NO_PY }, async () => {
  const head = 'import threading\n' + LangGraphRuntime.runEventsBlock() + '\n';
  const out = py(String.raw`RUN_OUT.begin("hold")
node_print("  [tool] -> x()")
assert RUN_OUT.held == ["  [tool] -> x()"], RUN_OUT.held
RUN_OUT.begin("drop")
node_print("dropped")
RUN_OUT.begin("print")
node_print("printed")
print("ok")`, head);
  assert.deepEqual(out, ['printed', 'ok']);
  const [rc, plain] = runFile('from __future__ import annotations\nfrom typing import Callable\n' + head + "node_print('no RUN_OUT here')\n");
  assert.deepEqual([rc, plain], [0, ['no RUN_OUT here']]);

  const gen = a2aGenerator();
  const codes: Record<string, string> = { single: ((await gen.generate(44, '3')) as any).code };
  for (const mode of ['modular', 'a2a']) {
    for (const f of ((await gen.generate(44, '3', { [mode]: true })) as any).files) codes[`${mode}/${f.path}`] = f.code;
  }
  let checked = 0;
  for (const [label, code] of Object.entries(codes)) {
    if ((label !== 'single' && !label.endsWith('.py'))
      || (!code.includes('class ToolCatalog') && !code.includes('class DispatcherNode'))) {
      continue;
    }
    checked++;
    assert.match(code, /^def node_print\(/m, label);
    if (code.includes('RUN_OUT = RunOutput()')) {
      assert.ok(code.indexOf('NODE_OUT: Callable') < code.indexOf('NODE_OUT = RUN_OUT'), label);
    }
    for (const bare of ['print(f"  [tool]', 'print(f"[node] [{nid}]', 'print(f"  [run_skill_script]']) {
      assert.doesNotMatch(code, new RegExp('(?<!node_)' + escRe(bare)), `${label}: ${bare}`);
    }
  }
  assert.ok(checked >= 3);
});

/** The block must land in every emission that carries WorkflowGraph, and the result must compile. */
test('testEveryEmissionCarriesTheRecorderAndCompiles', { skip: NO_PY }, async () => {
  const gen = a2aGenerator();
  const emissions: Record<string, Record<string, string>> = { single: { 'single.py': ((await gen.generate(44, '3')) as any).code } };
  for (const mode of ['modular', 'a2a']) {
    const fs: Record<string, string> = {};
    for (const f of ((await gen.generate(44, '3', { [mode]: true })) as any).files) fs[f.path] = f.code;
    emissions[mode] = fs;
  }
  for (const [label, fs] of Object.entries(emissions)) {
    let withRecorder = 0;
    for (const [p, code] of Object.entries(fs)) {
      if (!p.endsWith('.py')) continue;
      const [rc, out] = runFile(code, ['-m', 'py_compile']);
      assert.equal(rc, 0, `${label}/${p}: ` + out.join('\n'));
      if (code.includes('class RunRecorder')) {
        withRecorder++;
        assert.ok(code.includes('class WorkflowGraph'), `${label}/${p}`);
        assert.ok(code.indexOf('class RunRecorder') < code.indexOf('class WorkflowGraph'));
        for (const needed of ['uuid', 'datetime']) {
          assert.match(code, new RegExp('^(import .*\\b' + needed + '\\b|from datetime import .*\\bdatetime\\b)', 'm'), `${label}/${p} imports ${needed}`);
        }
      }
      if (code.includes('GRAPH_RECORDER.node_log')) {
        assert.match(code, /^GRAPH_RECORDER = NULL_RECORDER/m, `${label}/${p}`);
      }
    }
    assert.equal(withRecorder, 1, `${label}: exactly one file carries the recorder`);
  }
  assert.ok(emissions.single['single.py'].includes('GRAPH_RECORDER.node_log'));
  assert.ok(emissions.modular['workflow.py'].includes('GRAPH_RECORDER.node_log'));
});
