# Compiled Workflow Run Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A compiled LangGraph workflow serves its own run API, and the editor's existing run overlay drives it — streaming events, rendering tool cards, and letting a human answer playbook gates in the browser.

**Architecture:** The PHP compiler emits one more file into the modular package, `api.py`, which imports the graph and serves three routes plus an identity endpoint. The generated runtime gains an *event sink* (a callback installed by `api.py`) so the code that already prints trace lines also emits protocol events, and a *server* gate mode that blocks on a `threading.Event` until an HTTP POST supplies the answer. The frontend resolves a run-scoped base URL (`_runTarget`) for that run only; `apiBase` never moves.

**Tech Stack:** PHP 8.4 + PHPUnit 10.5 (the compiler and its tests), Python 3.13 + FastAPI 0.135 + uvicorn + pytest 9.1 (the generated server and the runner), vanilla JS (the editor).

**Spec:** `docs/superpowers/specs/2026-09-10-compiled-workflow-server-design.md`

## Global Constraints

- **Never edit generated Python.** Fix `backend/src/AgentTeam/Services/LangGraphGenerator.php` or `PythonEmitHelpers.php` and regenerate. Files under `~/Documents/synergyAI/python/scripts/` are output, never input.
- **Protocol vocabulary is fixed** (spec §3): `round{round}`, `tool_call{name,args}`, `tool_result{name,result}`, `message{text,sensitive}`, `gate_request{kind,payload,tool_call_id}`, `final{leg,status}`, terminal SSE `event: done` → `{run_id,status,output}` and `event: error` → `{error}`. Do not invent fields.
- **Answer shape** is flat, as `/workflows/tool-result` takes today: `{tool_call_id, ...answer}`.
- **`PLAYBOOK_GATE_MODE` still wins** over every automatic mode selection.
- **No authentication** on the generated server (LAN-only posture); it must not read or require an `Authorization` header.
- **Single-file target is unchanged.** `api.py` ships only in the modular package (Tasks 1–6) and the A2A folder (Task 8).
- **Ports:** `--port` argument, `WORKFLOW_API_PORT` env, default `8710`; host defaults to `127.0.0.1`.
- **Timeout:** `PLAYBOOK_GATE_TIMEOUT_S`, default `900`.
- **Runner source/install split:** changes to `langchain_runner/` reach the running runner only after `python3 setup.py --force --skip-venv`.
- **Frontend cache-buster:** any edit to `frontend/assets/js/workflow-editor.js` requires bumping its `?v=` in `frontend/index.html` (currently `20260909-modular1`).
- **i18n:** every new `t()` key must exist in `en.json`, `es.json` and `fr.json` — a missing key renders as the raw key, the `||` fallback never fires.

---

### Task 1: Event sink in the generated runtime

The sink is one small Python block emitted into `common.py`. Nothing consumes it yet; this task proves it exists, is inert without a sink installed, and tees the playbook run's own events.

**Files:**
- Modify: `backend/src/AgentTeam/Services/PythonEmitHelpers.php` (add `eventSinkBlock()`)
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (`emitModularCommon()` — emit the block; `playbookRuntimeBlock()` — tee `_PlaybookRun.emit`)
- Create: `backend/tests/fixtures/compiled/sink_probe.py` (Python probe run by the PHP test)
- Create: `backend/tests/Unit/CompiledRunServerTest.php`

**Interfaces:**
- Consumes: `LangGraphGenerator::generate($id, $userId, ['modular' => true])` → `['root' => string, 'files' => [['path','code'],...]]`
- Produces: in the generated `common.py` — `set_event_sink(fn) -> prev`, `emit_event(**ev) -> None`, `resolve_gate(tool_call_id, answer) -> bool`, `open_gate(tool_call_id) -> threading.Event`, module globals `_SINK`, `_GATES`, `_GATES_LOCK`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/CompiledRunServerTest.php`:

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * The compiled package's run server: event sink, server gate mode, api.py.
 * Each test writes the generated package to a temp dir and runs a Python
 * probe against it, so these assert BEHAVIOUR of the emitted code, not text.
 */
class CompiledRunServerTest extends TestCase
{
    /** Write the modular manifest for workflow 44 to a fresh temp dir; returns the package root. */
    public static function writePackage(): string
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['modular' => true]);
        $root = sys_get_temp_dir() . '/compiled_' . bin2hex(random_bytes(6));
        foreach ($m['files'] as $f) {
            $path = $root . '/' . $f['path'];
            @mkdir(dirname($path), 0777, true);
            file_put_contents($path, $f['code']);
        }
        return $root;
    }

    /** Run a probe script from tests/fixtures/compiled/ with the package root as argv[1]. */
    protected function probe(string $name, string $root): array
    {
        $probe = __DIR__ . '/../fixtures/compiled/' . $name;
        exec('python3 ' . escapeshellarg($probe) . ' ' . escapeshellarg($root) . ' 2>&1', $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testEventSinkIsInertUntilInstalledThenReceivesPlaybookEvents(): void
    {
        [$rc, $out] = $this->probe('sink_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }
}
```

Create `backend/tests/fixtures/compiled/sink_probe.py`:

```python
"""Probe: the generated common.py sink is inert by default and tees run events.

argv[1] is a compiled modular package root. Exits non-zero with a message on
failure; prints OK on success.
"""
import sys, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")

# 1. Inert with no sink installed: emitting must not raise.
common.emit_event(type="message", text="ignored")

# 2. Installed sink receives events, including a playbook run's own emits.
seen = []
prev = common.set_event_sink(seen.append)
assert prev is None, "set_event_sink should return the previous sink"
common.emit_event(type="round", round=1)
run = common._PlaybookRun(False, {})
run.emit(type="message", text="hello", sensitive=False)

assert seen[0] == {"type": "round", "round": 1}, seen
assert seen[1] == {"type": "message", "text": "hello", "sensitive": False}, seen
# The run's own timeline is unaffected by the tee.
assert run.events == [{"type": "message", "text": "hello", "sensitive": False}], run.events

# 3. Uninstalling restores inertness.
common.set_event_sink(None)
common.emit_event(type="round", round=2)
assert len(seen) == 2, seen

print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit --filter testEventSinkIsInert tests/Unit/CompiledRunServerTest.php`
Expected: FAIL — the probe exits non-zero with `AttributeError: module 'common' has no attribute 'emit_event'`.

- [ ] **Step 3: Add the sink block to PythonEmitHelpers**

In `backend/src/AgentTeam/Services/PythonEmitHelpers.php`, add:

```php
    /**
     * Event sink + gate rendezvous. Inert unless a host (the generated api.py)
     * installs a sink, so CLI runs behave exactly as before. Gates block a
     * worker thread on a threading.Event rather than an asyncio.Future: the
     * playbook's gate tools are sync callables that LangChain runs in an
     * executor, so the server's event loop stays free to serve the POST that
     * answers them.
     */
    public static function eventSinkBlock(): string
    {
        return <<<'PY'
# ==============================================================
# EVENT SINK + GATE RENDEZVOUS
# Inert until a host installs a sink (see api.py). With no sink the
# generated code prints its trace lines and nothing else changes.
# ==============================================================
_SINK = None            # callable(dict) -> None, or None
_GATES = {}             # tool_call_id -> {"event": threading.Event, "answer": dict | None}
_GATES_LOCK = threading.Lock()


def set_event_sink(fn):
    """Install (or clear with None) the run-event sink. Returns the previous one."""
    global _SINK
    prev, _SINK = _SINK, fn
    return prev


def emit_event(**ev):
    """Publish one protocol event. A no-op when no sink is installed."""
    sink = _SINK
    if sink is not None:
        sink(dict(ev))


def open_gate(tool_call_id: str):
    """Register a pending gate and return the Event the waiter blocks on."""
    with _GATES_LOCK:
        slot = {"event": threading.Event(), "answer": None}
        _GATES[tool_call_id] = slot
    return slot["event"]


def resolve_gate(tool_call_id: str, answer: dict) -> bool:
    """Deliver a human answer to a waiting gate. False when no gate is waiting."""
    with _GATES_LOCK:
        slot = _GATES.get(tool_call_id)
    if slot is None:
        return False
    slot["answer"] = dict(answer or {})
    slot["event"].set()
    return True


def take_gate_answer(tool_call_id: str):
    """Pop a resolved gate's answer (None when unanswered), clearing the slot."""
    with _GATES_LOCK:
        slot = _GATES.pop(tool_call_id, None)
    return slot["answer"] if slot else None

PY;
    }
```

- [ ] **Step 4: Emit the block and tee the playbook run**

In `LangGraphGenerator::emitModularCommon()`, immediately after the `$L[] = self::toolBuilderBlock();` line and its section banner, add:

```php
        $L[] = $sep;
        $L[] = '# EVENT SINK -- how api.py observes a run (inert for CLI runs)';
        $L[] = $sep;
        $L[] = PythonEmitHelpers::eventSinkBlock();
```

In `LangGraphGenerator::playbookRuntimeBlock()`, change `_PlaybookRun.emit` from:

```python
    def emit(self, **ev):
        self.events.append(ev)
```

to:

```python
    def emit(self, **ev):
        # The run's own timeline AND, when a host is watching, the live stream.
        self.events.append(ev)
        try:
            emit_event(**ev)
        except NameError:
            pass   # single-file/A2A targets without the sink block
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit --filter testEventSinkIsInert tests/Unit/CompiledRunServerTest.php`
Expected: PASS

- [ ] **Step 6: Verify nothing else regressed**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/LangGraphModularGeneratorTest.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/GeneratedDocParityTest.php`
Expected: PASS (17+ tests). The modular test's `testCommonModuleHoldsTheSharedRuntimeAndNoGraph` still passes because the sink adds no forbidden name.

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/PythonEmitHelpers.php \
        backend/src/AgentTeam/Services/LangGraphGenerator.php \
        backend/tests/Unit/CompiledRunServerTest.php \
        backend/tests/fixtures/compiled/sink_probe.py
git commit -m "feat(compiler): event sink + gate rendezvous in the generated runtime"
```

---

### Task 2: Server gate mode

With a sink installed, a playbook gate stops auto-answering: it emits `gate_request` and blocks until `resolve_gate()` delivers an answer or the timeout expires.

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (`playbookRuntimeBlock()` — `_playbook_gate`)
- Create: `backend/tests/fixtures/compiled/gate_probe.py`
- Modify: `backend/tests/Unit/CompiledRunServerTest.php`

**Interfaces:**
- Consumes: `set_event_sink`, `open_gate`, `resolve_gate`, `take_gate_answer` (Task 1)
- Produces: `_playbook_gate(run, kind, name, args) -> {"ok": bool, "decision": dict}` gains a `server` mode; emits `{"type": "gate_request", "kind", "payload", "tool_call_id"}`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/Unit/CompiledRunServerTest.php`:

```php
    public function testServerGateModeBlocksUntilAnsweredAndFallsBackOnTimeout(): void
    {
        [$rc, $out] = $this->probe('gate_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }
```

Create `backend/tests/fixtures/compiled/gate_probe.py`:

```python
"""Probe: server gate mode emits gate_request, blocks, and resumes on an answer.

argv[1] is a compiled modular package root.
"""
import os, sys, threading, importlib

os.environ["PLAYBOOK_GATE_TIMEOUT_S"] = "5"
sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")

seen = []
common.set_event_sink(seen.append)
run = common._PlaybookRun(False, {})

# 1. A gate blocks until answered, and returns the human's decision.
result = {}


def ask():
    result["value"] = common._playbook_gate(
        run, "approval", "request_approval",
        {"approver": "manager", "question": "Approve the PTO?"})


t = threading.Thread(target=ask)
t.start()

gate = None
for _ in range(50):
    gate = next((e for e in seen if e.get("type") == "gate_request"), None)
    if gate:
        break
    threading.Event().wait(0.05)
assert gate, f"no gate_request emitted: {seen}"
assert gate["kind"] == "approval", gate
assert gate["payload"]["question"] == "Approve the PTO?", gate
assert gate["tool_call_id"], gate
assert t.is_alive(), "the gate must block until answered"

assert common.resolve_gate(gate["tool_call_id"], {"decision": "denied", "comment": "not now", "actor": "me@x"})
t.join(5)
assert not t.is_alive(), "the gate did not resume after resolve_gate"
assert result["value"]["ok"] is True, result
assert result["value"]["decision"]["decision"] == "denied", result
assert result["value"]["decision"]["comment"] == "not now", result

# 2. An unanswered gate times out to the policy answer (PLAYBOOK_GATE_TIMEOUT_S=5).
seen.clear()
timed = common._playbook_gate(run, "approval", "request_approval",
                              {"approver": "manager", "question": "Nobody home?"})
assert timed["ok"] is True, timed
assert timed["decision"]["actor"] == "policy", timed

# 3. PLAYBOOK_GATE_MODE still wins over the sink.
os.environ["PLAYBOOK_GATE_MODE"] = "deny"
denied = common._playbook_gate(run, "approval", "request_approval", {"question": "x"})
assert denied["decision"]["decision"] == "denied", denied
assert denied["decision"]["actor"] == "policy", denied
del os.environ["PLAYBOOK_GATE_MODE"]

print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit --filter testServerGateMode tests/Unit/CompiledRunServerTest.php`
Expected: FAIL — no `gate_request` is emitted; the probe asserts `no gate_request emitted` because the gate takes its `auto` branch and returns immediately.

- [ ] **Step 3: Add the server branch**

In `playbookRuntimeBlock()`, replace the body of `_playbook_gate` down to (not including) the `if mode == "deny":` line with:

```python
def _playbook_gate(run, kind: str, name: str, args: dict) -> dict:
    """Human gate. A host watching this run (api.py) gets the question over the
    event stream and answers it with resolve_gate(). On an interactive terminal
    the question is asked on the console. Otherwise PLAYBOOK_GATE_MODE decides:
    auto (default) approves approvals and acknowledges handoffs, deny denies,
    prompt forces the console. PLAYBOOK_GATE_MODE always wins."""
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
        "server" if _SINK is not None
        else "prompt" if sys.stdin.isatty()
        else "auto")
    what = args.get("question") or args.get("prompt") or args.get("reason") or ""
    if mode == "server":
        # NOTE: run.emit() already tees a gate_request into the stream, but
        # without the tool_call_id the answer must come back on, so the server
        # mode emits its own and skips the bare one.
        tool_call_id = uuid.uuid4().hex
        waiter = open_gate(tool_call_id)
        run.events.append({"type": "gate_request", "kind": kind, "payload": dict(args)})
        emit_event(type="gate_request", kind=kind, payload=dict(args), tool_call_id=tool_call_id)
        answered = waiter.wait(float(os.environ.get("PLAYBOOK_GATE_TIMEOUT_S", "900")))
        answer = take_gate_answer(tool_call_id)
        if answered and answer is not None:
            emit_event(type="tool_result", name=name, result={"ok": True, "decision": answer})
            return {"ok": True, "decision": answer}
        # Nobody attached, or nobody answered in time: same result as a
        # non-interactive run, recorded so the transcript says who decided.
        fallback = _playbook_gate_policy(kind, "no answer within PLAYBOOK_GATE_TIMEOUT_S")
        emit_event(type="tool_result", name=name, result=fallback)
        return fallback
    run.emit(type="gate_request", kind=kind, payload=dict(args))
    if mode == "prompt":
        print(f"\n✋ [{kind}] {what}", flush=True)
        if kind == "approval":
            ans = input("approve/deny [comment]: ").strip()
            decision = "denied" if ans.lower().startswith("d") else "approved"
            comment = ans.split(" ", 1)[1] if " " in ans else ""
            return {"ok": True, "decision": {"decision": decision, "comment": comment, "actor": "console"}}
        ans = input("your answer: ").strip()
        return {"ok": True, "decision": {"decision": "answered", "comment": ans, "actor": "console"}}
    if mode == "deny":
        return _playbook_gate_policy(kind, "denied by PLAYBOOK_GATE_MODE=deny", deny=True)
    return _playbook_gate_policy(kind, "non-interactive run")


def _playbook_gate_policy(kind: str, why: str, deny: bool = False) -> dict:
    """The answer a policy gives when no human is available. One definition so
    the auto, deny and timed-out-server paths cannot drift apart."""
    if deny:
        return {"ok": True, "decision": {"decision": "denied", "comment": why, "actor": "policy"}}
    if kind == "approval":
        return {"ok": True, "decision": {"decision": "approved", "comment": f"auto-approved ({why})", "actor": "policy"}}
    if kind == "handoff":
        return {"ok": True, "decision": {"decision": "acknowledged", "comment": f"handed off; no human available ({why})", "actor": "policy"}}
    return {"ok": False, "timeout": True,
            "guidance": "No human is available in this non-interactive run. Continue with what you already know "
                        "and note the gap with leave_internal_note."}
```

Then ensure `uuid` is imported by `common.py`: in `emitModularCommon()` change the import line

```php
        $L[] = 'import asyncio, json, os, re, subprocess, sys, threading, time';
```

to

```php
        $L[] = 'import asyncio, json, os, re, subprocess, sys, threading, time, uuid';
```

and make the same addition to the single-file emitter's import line in `generate()` and to `emitA2AAgentFile()`, since all three carry `playbookRuntimeBlock()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit --filter testServerGateMode tests/Unit/CompiledRunServerTest.php`
Expected: PASS (takes ~6 s — the timeout case waits 5 s).

- [ ] **Step 5: Verify the other targets still compile and behave**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/LangGraphModularGeneratorTest.php tests/Unit/LangGraphA2AGeneratorTest.php tests/Unit/LangGraphGeneratorPlaybookTest.php`
Expected: PASS. Every emitted file still passes `py_compile`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php \
        backend/tests/Unit/CompiledRunServerTest.php \
        backend/tests/fixtures/compiled/gate_probe.py
git commit -m "feat(compiler): server gate mode — emit gate_request, block for a human answer"
```

---

### Task 3: `api.py` — run lifecycle and the three routes

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (`generateModular()`, new `emitModularApi()`, new `modularApiBlock()`)
- Create: `backend/tests/fixtures/compiled/api_probe.py`
- Modify: `backend/tests/Unit/CompiledRunServerTest.php`

**Interfaces:**
- Consumes: `workflow.run(prompt)`, `workflow.WORKFLOW_ID`, `workflow.WORKFLOW_NAME`, `workflow.DEFAULT_PROMPT` (Task 0 — already emitted), `common.set_event_sink`, `common.resolve_gate`
- Produces: in `api.py` — `app` (FastAPI), `RUNS: dict[str, RunState]`, `class RunState`, `WORKFLOW_VERSION: str`; routes `POST /runs`, `GET /runs/{run_id}/events`, `POST /runs/{run_id}/tool-result`, `GET /.well-known/workflow.json`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/Unit/CompiledRunServerTest.php`:

```php
    public function testApiFileIsEmittedIntoTheModularPackage(): void
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['modular' => true]);
        $this->assertSame([
            'workflow.py', 'common.py', 'api.py', 'agents/__init__.py',
            'agents/techbuddy.py', 'agents/it_claims.py', 'agents/human_resources.py', 'agents/playbook_hr.py',
        ], array_column($m['files'], 'path'));
        $api = $m['files'][2]['code'];
        foreach (['"""Run server for workflow "Dispatcher demo"', 'PROVENANCE', 'GRAPH EDGES',
                  'from fastapi import FastAPI', 'from workflow import run as run_workflow',
                  'from common import set_event_sink, resolve_gate', 'class RunState',
                  '@app.post("/runs")', '@app.get("/runs/{run_id}/events")',
                  '@app.post("/runs/{run_id}/tool-result")', '@app.get("/.well-known/workflow.json")',
                  'uvicorn.run(', 'WORKFLOW_API_PORT'] as $needle) {
            $this->assertStringContainsString($needle, $api, "missing: {$needle}");
        }
        $this->assertStringNotContainsString('Authorization', $api, 'the run server has no auth');
    }

    public function testApiServesARunEndToEnd(): void
    {
        [$rc, $out] = $this->probe('api_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }
```

Create `backend/tests/fixtures/compiled/api_probe.py`:

```python
"""Probe: the generated api.py serves a run end to end with a stubbed graph.

The graph itself is replaced so no LLM or MCP server is needed: this asserts
the SERVER contract (run id, event stream, gate answering, done frame), which
is what the frontend depends on.

argv[1] is a compiled modular package root.
"""
import json, sys, importlib, threading

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")


# Stub the graph: emit one message, raise one gate, return the answer as output.
async def fake_run(prompt: str) -> str:
    common.emit_event(type="round", round=1)
    common.emit_event(type="message", text=f"echo: {prompt}", sensitive=False)
    run = common._PlaybookRun(False, {})
    decision = common._playbook_gate(run, "approval", "request_approval", {"question": "ok?"})
    return "decision=" + decision["decision"]["decision"]


workflow.run = fake_run
api = importlib.import_module("api")
api.run_workflow = fake_run

from starlette.testclient import TestClient

client = TestClient(api.app)

card = client.get("/.well-known/workflow.json").json()
assert card["workflow_id"] == 44, card
assert card["protocol"] == "run/1", card

started = client.post("/runs", json={"prompt": "hello"}).json()
run_id = started["run_id"]
assert run_id, started

events = []
gate_id = {}


def answer_when_asked():
    """Answer the gate as soon as the stream shows it (the browser's job)."""
    for _ in range(200):
        g = next((e for e in events if e.get("type") == "gate_request"), None)
        if g:
            gate_id["v"] = g["tool_call_id"]
            client.post(f"/runs/{run_id}/tool-result",
                        json={"tool_call_id": g["tool_call_id"], "decision": "approved", "comment": "go"})
            return
        threading.Event().wait(0.05)


threading.Thread(target=answer_when_asked, daemon=True).start()

done = None
with client.stream("GET", f"/runs/{run_id}/events") as resp:
    assert resp.status_code == 200, resp.status_code
    name = "message"
    for line in resp.iter_lines():
        if line.startswith("event:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            payload = json.loads(line.split(":", 1)[1].strip())
            if name == "done":
                done = payload
                break
            if name == "error":
                raise AssertionError(f"run errored: {payload}")
            events.append(payload)

kinds = [e["type"] for e in events]
assert "round" in kinds and "message" in kinds and "gate_request" in kinds, kinds
assert gate_id.get("v"), "the gate was never answered"
assert done["status"] == "completed", done
assert done["output"] == "decision=approved", done
assert done["run_id"] == run_id, done

# A tool-result for an unknown run is refused, not silently swallowed.
assert client.post("/runs/nope/tool-result", json={"tool_call_id": "x"}).status_code == 404

print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit --filter testApi tests/Unit/CompiledRunServerTest.php`
Expected: FAIL — the manifest has 7 files, not 8 (`api.py` missing), and the probe fails with `ModuleNotFoundError: No module named 'api'`.

- [ ] **Step 3: Emit `api.py`**

In `LangGraphGenerator::generateModular()`, insert `api.py` after `common.py`:

```php
            ['path' => 'common.py', 'code' => $this->emitModularCommon($facts, $layout)],
            ['path' => 'api.py', 'code' => $this->emitModularApi($facts, $layout)],
```

Add the emitter next to the other modular emitters:

```php
    /** api.py: the run server — the graph behind POST /runs + an SSE event stream. */
    private function emitModularApi(array $facts, array $layout): string
    {
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $L = [];
        $L[] = '"""Run server for workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L[] = '';
        $body = $this->modularDocBody($facts, $layout,
            'LangGraph modular run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            ['deps' => ['pip install fastapi uvicorn langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv'],
             'usage' => 'python api.py --port 8710        # then open the workflow from the editor',
             'extra' => ['# Routes: POST /runs | GET /runs/<id>/events (SSE) | POST /runs/<id>/tool-result',
                         '#         GET /.well-known/workflow.json (identity)',
                         '# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.'],
             'env_path' => '../../.env']);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, time, uuid';
        $L[] = '';
        $L[] = 'from fastapi import FastAPI, HTTPException';
        $L[] = 'from fastapi.middleware.cors import CORSMiddleware';
        $L[] = 'from fastapi.responses import StreamingResponse';
        $L[] = 'import uvicorn';
        $L[] = '';
        $L[] = 'from common import set_event_sink, resolve_gate';
        $L[] = 'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $L[] = '';
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts));
        $L[] = '';
        $L[] = self::modularApiBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }
```

- [ ] **Step 4: Add the server block**

Add `modularApiBlock()` beside `modularRunnerBlock()`:

```php
    /** api.py's runtime half: run state, the four routes, the uvicorn entry point. */
    private static function modularApiBlock(): string
    {
        return <<<'PY'
# ==============================================================
# RUN STATE
# One RunState per POST /runs. The graph runs as an asyncio task; its
# events land in a queue the SSE route drains, and in a ring buffer so a
# reconnecting client can replay what it missed (see Last-Event-ID).
# ==============================================================
RING = 500          # events kept per run for replay
RUNS = {}           # run_id -> RunState


class RunState:
    """One run: its status, its event history and the queue feeding the stream."""

    def __init__(self, run_id: str, prompt: str):
        self.id = run_id
        self.prompt = prompt
        self.status = "running"
        self.output = ""
        self.error = ""
        self.seq = 0
        self.events = []                  # [(seq, name, payload)] capped at RING
        self.queue = asyncio.Queue()
        self.task = None

    def publish(self, name: str, payload: dict) -> None:
        """Record one frame and hand it to whoever is streaming."""
        self.seq += 1
        frame = (self.seq, name, payload)
        self.events.append(frame)
        if len(self.events) > RING:
            del self.events[0]
        self.queue.put_nowait(frame)

    def since(self, last_id: int):
        """Frames after `last_id`, for a client that reconnected."""
        return [f for f in self.events if f[0] > last_id]


# ==============================================================
# THE APP
# No authentication by design: this server has no users and no session.
# Bind it to 127.0.0.1 or a trusted LAN interface.
# ==============================================================
app = FastAPI(title=f"{WORKFLOW_NAME} run server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/.well-known/workflow.json")
async def identity() -> dict:
    """Who this server is. The editor checks it before trusting a port."""
    return {"workflow_id": WORKFLOW_ID, "name": WORKFLOW_NAME,
            "version": WORKFLOW_VERSION, "protocol": "run/1"}


@app.post("/runs")
async def start_run(body: dict) -> dict:
    """Start a run and return its id. Does not stream -- GET its events next."""
    prompt = str((body or {}).get("prompt") or "").strip() or DEFAULT_PROMPT or "Hello"
    state = RunState(uuid.uuid4().hex, prompt)
    RUNS[state.id] = state
    state.task = asyncio.create_task(_drive(state))
    return {"run_id": state.id, "status": state.status}


async def _drive(state: RunState) -> None:
    """Run the graph with the event sink installed, then publish the terminal frame."""
    loop = asyncio.get_running_loop()

    def sink(ev: dict) -> None:
        # Called from graph code that may be on a worker thread (sync tools),
        # so hop back onto the loop before touching the queue.
        loop.call_soon_threadsafe(state.publish, "message", ev)

    prev = set_event_sink(sink)
    t0 = time.monotonic()
    try:
        state.output = await run_workflow(state.prompt)
        state.status = "completed"
        state.publish("done", {"run_id": state.id, "status": state.status,
                               "output": state.output, "seconds": round(time.monotonic() - t0, 1)})
    except Exception as e:
        state.status = "failed"
        state.error = str(e)
        state.publish("error", {"run_id": state.id, "error": state.error})
    finally:
        set_event_sink(prev)


@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str, request: "Request" = None) -> StreamingResponse:
    """SSE stream of one run. Replays from Last-Event-ID when reconnecting."""
    state = RUNS.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    last_id = 0
    if request is not None:
        try:
            last_id = int(request.headers.get("last-event-id") or 0)
        except ValueError:
            last_id = 0

    async def frames():
        for seq, name, payload in state.since(last_id):
            yield _frame(seq, name, payload)
            if name in ("done", "error"):
                return
        while True:
            seq, name, payload = await state.queue.get()
            if seq <= last_id:
                continue
            yield _frame(seq, name, payload)
            if name in ("done", "error"):
                return

    return StreamingResponse(frames(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _frame(seq: int, name: str, payload: dict) -> str:
    """One SSE frame. `id:` is what a reconnecting client sends back."""
    return f"id: {seq}\nevent: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/runs/{run_id}/tool-result")
async def tool_result(run_id: str, body: dict) -> dict:
    """Answer a gate. Body is flat: {tool_call_id, ...answer} -- the same shape
    the app backend's /workflows/tool-result takes."""
    if run_id not in RUNS:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    payload = dict(body or {})
    tool_call_id = str(payload.pop("tool_call_id", ""))
    if not tool_call_id:
        raise HTTPException(status_code=400, detail="tool_call_id is required")
    if not resolve_gate(tool_call_id, payload):
        raise HTTPException(status_code=409, detail=f"no gate waiting for {tool_call_id}")
    return {"ok": True}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"Run server for workflow {WORKFLOW_NAME!r}")
    ap.add_argument("--host", default=os.environ.get("WORKFLOW_API_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("WORKFLOW_API_PORT", "8710")))
    a = ap.parse_args()
    print(f"[api] {WORKFLOW_NAME!r} serving http://{a.host}:{a.port}/ (workflow {WORKFLOW_ID}, {WORKFLOW_VERSION})", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
PY;
    }
```

Fix the one forward reference: add `from fastapi import Request` to the imports in `emitModularApi()` (Step 3's import list becomes `from fastapi import FastAPI, HTTPException, Request`) and change the route signature to `async def stream_events(run_id: str, request: Request) -> StreamingResponse:` with the `if request is not None` guard removed.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit --filter testApi tests/Unit/CompiledRunServerTest.php`
Expected: PASS, both tests.

- [ ] **Step 6: Update the modular manifest test**

`tests/Unit/LangGraphModularGeneratorTest.php::testModularOptionReturnsAManifest` lists the expected paths; add `'api.py'` after `'common.py'`. Also add to `testWorkflowModuleWiresTheGraphOverTheAgentModules` nothing — `workflow.py` is unchanged.

Run: `cd backend && php vendor/bin/phpunit tests/Unit/LangGraphModularGeneratorTest.php`
Expected: PASS (10 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php \
        backend/tests/Unit/CompiledRunServerTest.php \
        backend/tests/Unit/LangGraphModularGeneratorTest.php \
        backend/tests/fixtures/compiled/api_probe.py
git commit -m "feat(compiler): emit api.py — the compiled workflow's run server"
```

---

### Task 4: Reconnect replay

Prove the thing the run/stream split was for: a client that drops mid-run reattaches and misses nothing.

**Files:**
- Create: `backend/tests/fixtures/compiled/replay_probe.py`
- Modify: `backend/tests/Unit/CompiledRunServerTest.php`
- Modify (only if the test fails): `backend/src/AgentTeam/Services/LangGraphGenerator.php` (`modularApiBlock()`)

**Interfaces:**
- Consumes: `RunState.since(last_id)`, `_frame(seq, name, payload)` (Task 3)
- Produces: nothing new — this task hardens existing behaviour

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/Unit/CompiledRunServerTest.php`:

```php
    public function testAReconnectingClientReplaysMissedEvents(): void
    {
        [$rc, $out] = $this->probe('replay_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }
```

Create `backend/tests/fixtures/compiled/replay_probe.py`:

```python
"""Probe: dropping the stream mid-run and reattaching with Last-Event-ID
replays exactly the frames that were missed, then continues live.

Drives the app in-process over httpx's ASGI transport so everything -- the run,
both streams and the release -- shares one event loop. No threads, no races.

argv[1] is a compiled modular package root.
"""
import asyncio, json, sys, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")

gate = asyncio.Event()


async def fake_run(prompt: str) -> str:
    common.emit_event(type="round", round=1)
    common.emit_event(type="message", text="first", sensitive=False)
    await gate.wait()                       # hold the run open across the reconnect
    common.emit_event(type="message", text="second", sensitive=False)
    return "done"


workflow.run = fake_run
api = importlib.import_module("api")
api.run_workflow = fake_run

import httpx


async def read(client, run_id, headers=None, stop_after=None):
    """Read frames until `stop_after` of them, or the terminal frame."""
    got, seq, name = [], 0, "message"
    async with client.stream("GET", f"/runs/{run_id}/events", headers=headers or {}) as resp:
        assert resp.status_code == 200, resp.status_code
        async for line in resp.aiter_lines():
            if line.startswith("id:"):
                seq = int(line.split(":", 1)[1].strip())
            elif line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                got.append((seq, name, json.loads(line.split(":", 1)[1].strip())))
                if name in ("done", "error") or (stop_after and len(got) >= stop_after):
                    return got
    return got


async def main():
    transport = httpx.ASGITransport(app=api.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
        run_id = (await client.post("/runs", json={"prompt": "x"})).json()["run_id"]

        first = await read(client, run_id, stop_after=2)
        assert [f[2]["type"] for f in first] == ["round", "message"], first
        last_seq = first[-1][0]

        # The client "reloads": the stream above is closed, the run keeps going.
        gate.set()
        rest = await read(client, run_id, headers={"Last-Event-ID": str(last_seq)})

        seqs = [f[0] for f in rest]
        assert min(seqs) == last_seq + 1, f"replayed a frame the client already had: {seqs}"
        assert rest[-1][1] == "done", rest
        assert any(f[1] == "message" and f[2].get("text") == "second" for f in rest), rest
        assert rest[-1][2]["status"] == "completed", rest

    print("OK")


asyncio.run(main())
```

- [ ] **Step 2: Run test to verify it fails or reveals a defect**

Run: `cd backend && php vendor/bin/phpunit --filter testAReconnecting tests/Unit/CompiledRunServerTest.php`
Expected: FAIL. `RunState` has one shared `asyncio.Queue`, so the first stream's reader already consumed the frames the second one needs, and the reattached client hangs until the run ends — the probe fails on `min(seqs) == last_seq + 1` or times out. That is the real defect Step 3 fixes.

- [ ] **Step 3: Make the stream replay-safe**

Replace `RunState.queue` (one shared queue) with a per-subscriber fan-out in `modularApiBlock()`:

```python
    def __init__(self, run_id: str, prompt: str):
        ...
        self.subscribers = []             # list[asyncio.Queue] -- one per attached client
        self.task = None

    def publish(self, name: str, payload: dict) -> None:
        """Record one frame and hand it to every attached client."""
        self.seq += 1
        frame = (self.seq, name, payload)
        self.events.append(frame)
        if len(self.events) > RING:
            del self.events[0]
        for q in list(self.subscribers):
            q.put_nowait(frame)

    def subscribe(self) -> asyncio.Queue:
        """Attach a client. Returns its own queue of frames."""
        q = asyncio.Queue()
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Detach a client (stream closed, browser gone)."""
        if q in self.subscribers:
            self.subscribers.remove(q)
```

and in the route:

```python
    async def frames():
        q = state.subscribe()
        try:
            for seq, name, payload in state.since(last_id):
                yield _frame(seq, name, payload)
                if name in ("done", "error"):
                    return
            while True:
                seq, name, payload = await q.get()
                if seq <= last_id:
                    continue
                yield _frame(seq, name, payload)
                if name in ("done", "error"):
                    return
        finally:
            state.unsubscribe(q)
```

Also record the loop in `_drive()` — Task 8's A2A supervisor hook needs it:

```python
    loop = asyncio.get_running_loop()
    app.state.loop = loop
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit --filter testAReconnecting tests/Unit/CompiledRunServerTest.php`
Expected: PASS

- [ ] **Step 5: Re-run the whole compiled-server suite**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/CompiledRunServerTest.php`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php \
        backend/tests/Unit/CompiledRunServerTest.php \
        backend/tests/fixtures/compiled/replay_probe.py
git commit -m "feat(compiler): per-subscriber fan-out so a reconnecting client replays cleanly"
```

---

### Task 5: Runner starts and stops workflow servers

**Files:**
- Modify: `langchain_runner/main.py`
- Create: `langchain_runner/tests/test_workflow_server.py`
- Modify: `langchain_runner/requirements.txt` (add `fastapi`)

**Interfaces:**
- Consumes: the compiled package layout `scripts/<folder>/api.py`
- Produces: `POST /api/workflow-server/start {folder} -> {url, pid, reused}`, `POST /api/workflow-server/stop {folder} -> {stopped}`, module globals `_SERVERS: dict[str, subprocess.Popen]`, `_free_port() -> int`, `_resolve_package_dir(folder) -> Path`

- [ ] **Step 1: Write the failing test**

Create `langchain_runner/tests/test_workflow_server.py`:

```python
import os, sys, socket
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main as runner


def _pkg(tmp_path, monkeypatch, name="demo_modular"):
    scripts = tmp_path / "scripts"
    (scripts / name).mkdir(parents=True)
    # A stand-in for the generated api.py: serves the identity endpoint only.
    (scripts / name / "api.py").write_text(
        "import argparse, json, http.server\n"
        "ap = argparse.ArgumentParser(); ap.add_argument('--host', default='127.0.0.1')\n"
        "ap.add_argument('--port', type=int, default=8710); a = ap.parse_args()\n"
        "CARD = json.dumps({'workflow_id': 44, 'name': 'Demo', 'version': '44-x', 'protocol': 'run/1'}).encode()\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200 if self.path == '/.well-known/workflow.json' else 404)\n"
        "        self.send_header('Content-Type', 'application/json'); self.end_headers()\n"
        "        self.wfile.write(CARD)\n"
        "    def log_message(self, *a): pass\n"
        "http.server.HTTPServer((a.host, a.port), H).serve_forever()\n"
    )
    monkeypatch.setattr(runner, "SCRIPTS_DIR", scripts)
    return scripts


def test_resolve_package_dir_refuses_traversal_and_missing_api(tmp_path, monkeypatch):
    _pkg(tmp_path, monkeypatch)
    assert runner._resolve_package_dir("demo_modular").name == "demo_modular"
    for bad in ("../etc", "demo_modular/agents", "nope", ".hidden"):
        with pytest.raises(ValueError):
            runner._resolve_package_dir(bad)


def test_start_serves_and_is_reused_then_stopped(tmp_path, monkeypatch):
    _pkg(tmp_path, monkeypatch)
    try:
        first = runner._start_workflow_server("demo_modular")
        assert first["url"].startswith("http://127.0.0.1:")
        assert first["reused"] is False
        again = runner._start_workflow_server("demo_modular")
        assert again["url"] == first["url"]
        assert again["reused"] is True
    finally:
        assert runner._stop_workflow_server("demo_modular")["stopped"] is True
    # The port is free again.
    port = int(first["url"].rsplit(":", 1)[1].strip("/"))
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd langchain_runner && python3 -m pytest tests/test_workflow_server.py -v`
Expected: FAIL with `AttributeError: module 'main' has no attribute '_resolve_package_dir'`

- [ ] **Step 3: Implement in the runner**

Add to `langchain_runner/main.py`, next to `_resolve_script_path`:

```python
_SERVERS: dict[str, subprocess.Popen] = {}   # folder -> live workflow server process


def _resolve_package_dir(folder: str) -> Path:
    """Path-traversal-safe lookup of a compiled package under scripts/.

    One plain path segment holding an api.py. Mirrors _resolve_script_path's
    rules: no '..', no absolute paths, no dotfiles, no nesting.
    """
    if not folder or "/" in folder or "\\" in folder or folder.startswith("."):
        raise ValueError(f"Invalid workflow folder: {folder!r}")
    candidate = (SCRIPTS_DIR / folder).resolve()
    if SCRIPTS_DIR.resolve() not in candidate.parents:
        raise ValueError(f"Path escapes scripts directory: {folder!r}")
    if not (candidate / "api.py").is_file():
        raise ValueError(f"No api.py in {folder!r} — regenerate with 'Agents in separate files'")
    return candidate


def _free_port() -> int:
    """A port the OS says is free right now. Racy in theory; the child binds it immediately."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_workflow_server(folder: str) -> dict:
    """Start (or reuse) the run server for a compiled package. Returns {url, pid, reused}."""
    pkg = _resolve_package_dir(folder)
    proc = _SERVERS.get(folder)
    if proc is not None and proc.poll() is None:
        return {"url": proc._workflow_url, "pid": proc.pid, "reused": True}
    port = _free_port()
    url = f"http://127.0.0.1:{port}/"
    proc = subprocess.Popen([sys.executable, "-u", str(pkg / "api.py"), "--port", str(port)],
                            cwd=str(pkg), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    proc._workflow_url = url
    _SERVERS[folder] = proc
    deadline = time.monotonic() + 60
    while True:
        if proc.poll() is not None:
            out = (proc.stdout.read() or "")[-2000:]
            _SERVERS.pop(folder, None)
            raise RuntimeError(f"{folder}/api.py exited with code {proc.returncode} before serving {url}:\n{out}")
        try:
            if httpx.get(url + ".well-known/workflow.json", timeout=2).status_code == 200:
                break
        except Exception:
            pass
        if time.monotonic() > deadline:
            _stop_workflow_server(folder)
            raise RuntimeError(f"{folder}/api.py did not serve its identity at {url} within 60s")
        time.sleep(0.2)
    return {"url": url, "pid": proc.pid, "reused": False}


def _stop_workflow_server(folder: str) -> dict:
    """Terminate the run server for a package (5 s grace, then kill)."""
    proc = _SERVERS.pop(folder, None)
    if proc is None or proc.poll() is not None:
        return {"stopped": False}
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    return {"stopped": True}


@app.post("/api/workflow-server/start")
async def workflow_server_start(req: dict):
    """Start the compiled workflow's run server and return its URL."""
    try:
        return _start_workflow_server(str(req.get("folder") or ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/workflow-server/stop")
async def workflow_server_stop(req: dict):
    """Stop the compiled workflow's run server."""
    return _stop_workflow_server(str(req.get("folder") or ""))
```

Add `import socket` and `import subprocess` to the imports at the top of `main.py` if not already present, and `fastapi` to `langchain_runner/requirements.txt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd langchain_runner && python3 -m pytest tests/test_workflow_server.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the rest of the runner suite**

Run: `cd langchain_runner && python3 -m pytest tests/ -v`
Expected: PASS — `test_resolve_script_path.py` unaffected.

- [ ] **Step 6: Install into the running runner**

Run: `python3 setup.py --force --skip-venv`
Expected: the copy step reports `main.py` updated under `~/Documents/synergyAI/python/`.

- [ ] **Step 7: Commit**

```bash
git add langchain_runner/main.py langchain_runner/requirements.txt \
        langchain_runner/tests/test_workflow_server.py
git commit -m "feat(runner): start/stop a compiled workflow's run server"
```

---

### Task 6: Editor — run target, handshake and the prompt box

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js`
- Modify: `frontend/assets/i18n/en.json`, `es.json`, `fr.json`
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: runner `POST /api/workflow-server/start` (Task 5), server `GET /.well-known/workflow.json` (Task 3)
- Produces: `this._runTarget = {base, version} | null`; `_showRunPromptModal(defaultPrompt) -> Promise<string|null>`; `_acquireRunTarget(root) -> Promise<{base, version}>`; `_startNodePrompt() -> string`

- [ ] **Step 1: Add the prompt modal**

Add next to `_showCodegenOptionsModal()`:

```js
    /**
     * "Run workflow" — the prompt for this run, pre-filled from the Start node.
     * Resolves with the text, or null when cancelled.
     */
    _showRunPromptModal(defaultPrompt) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
            backdrop.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg" role="dialog" aria-modal="true">
                    <h3 class="text-lg font-semibold text-gray-900 mb-1">${this.escapeHtml(this.t('workflow.output.runPromptTitle') || 'Run workflow')}</h3>
                    <p class="text-xs text-gray-500 mb-3">${this.escapeHtml(this.t('workflow.output.runPromptHelp') || "This run only — the Start node's saved prompt is unchanged.")}</p>
                    <textarea class="run-prompt w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" rows="6"></textarea>
                    <div class="flex justify-end gap-2 mt-4">
                        <button class="run-cancel px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded">${this.escapeHtml(this.t('common.cancel') || 'Cancel')}</button>
                        <button class="run-go px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">${this.escapeHtml(this.t('workflow.output.runPromptRun') || 'Run')}</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            const ta = backdrop.querySelector('.run-prompt');
            ta.value = defaultPrompt || '';
            ta.focus();
            const done = (v) => { backdrop.remove(); resolve(v); };
            backdrop.querySelector('.run-cancel').addEventListener('click', () => done(null));
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
            backdrop.querySelector('.run-go').addEventListener('click', () => done(ta.value));
        });
    }

    /** The Start node's saved prompt, or '' when the graph has none. */
    _startNodePrompt() {
        try {
            const data = this.editor?.drawflow?.drawflow?.Home?.data || {};
            for (const id of Object.keys(data)) {
                const nd = data[id]?.data || {};
                if (nd.type === 'start') return String(nd.prompt || '');
            }
        } catch (_) { /* unsaved canvas */ }
        return '';
    }
```

- [ ] **Step 2: Add the handshake**

```js
    /**
     * Start (or reuse) the compiled workflow's run server and verify it is THIS
     * workflow's current compile. Throws with an actionable message otherwise.
     * Returns {base, version}; also sets this._runTarget.
     */
    async _acquireRunTarget(root) {
        const resp = await fetch(`${this._langgraphRunnerBase}/api/workflow-server/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: root }),
        });
        if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
        const { url } = await resp.json();
        // A stale process squatting on the port answers 200 too — check identity
        // before trusting it, or we run yesterday's graph against today's canvas.
        const cardResp = await fetch(`${url}.well-known/workflow.json`);
        if (!cardResp.ok) throw new Error(`${url} did not serve its identity`);
        const card = await cardResp.json();
        if (String(card.workflow_id) !== String(this.currentWorkflowId)) {
            throw new Error(`${url} is serving workflow ${card.workflow_id}, not ${this.currentWorkflowId} — stop that process`);
        }
        if (card.protocol !== 'run/1') {
            throw new Error(`${url} speaks protocol ${card.protocol}, this editor speaks run/1`);
        }
        this._runTarget = { base: url.replace(/\/$/, ''), version: card.version };
        return this._runTarget;
    }
```

- [ ] **Step 3: Add the i18n keys**

In `frontend/assets/i18n/en.json`, inside the same `workflow.output` object that holds `codegenTitle`:

```json
      "runPromptTitle": "Run workflow",
      "runPromptHelp": "This run only — the Start node's saved prompt is unchanged.",
      "runPromptRun": "Run",
      "runTargetCompiled": "compiled",
      "runTargetLive": "live interpreter",
```

`es.json`:

```json
      "runPromptTitle": "Ejecutar flujo de trabajo",
      "runPromptHelp": "Solo para esta ejecución: el prompt guardado en el nodo Inicio no cambia.",
      "runPromptRun": "Ejecutar",
      "runTargetCompiled": "compilado",
      "runTargetLive": "intérprete en vivo",
```

`fr.json`:

```json
      "runPromptTitle": "Exécuter le workflow",
      "runPromptHelp": "Pour cette exécution seulement — le prompt enregistré du nœud Début est inchangé.",
      "runPromptRun": "Exécuter",
      "runTargetCompiled": "compilé",
      "runTargetLive": "interpréteur en direct",
```

- [ ] **Step 4: Verify the JSON and the JS still parse**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
```
Expected: `en ok`, `es ok`, `fr ok`, `JS ok`

- [ ] **Step 5: Bump the cache-buster**

In `frontend/index.html`, change `workflow-editor.js?v=20260909-modular1` to `workflow-editor.js?v=20260910-runserver1`.

- [ ] **Step 6: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/i18n/*.json frontend/index.html
git commit -m "feat(editor): run-scoped target, launch handshake and the run prompt box"
```

---

### Task 7: Editor — drive a compiled run through the overlay

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (`_runLangGraphScript()`, new `_runCompiled()`, `_pbOverlayOpen()` header)
- Modify: `frontend/index.html` (cache-buster)

**Interfaces:**
- Consumes: `_acquireRunTarget`, `_showRunPromptModal`, `_startNodePrompt` (Task 6); `_pbOverlayOpen`, `_handlePlaybookEvent`, `_pbOverlayFinish` (existing); `_handlePlaybookGate` (existing, extended below)
- Produces: `_runCompiled(root) -> Promise<void>`

- [ ] **Step 1: Route gate answers to the run target**

`_handlePlaybookGate()` currently posts to `${this.apiBase}/workflows/tool-result`. Change only the destination:

```js
        try {
            const base = this._runTarget?.base;
            const url = base
                ? `${base}/runs/${this._runTarget.runId}/tool-result`
                : `${this.apiBase}/workflows/tool-result`;
            const headers = base
                ? { 'Content-Type': 'application/json' }
                : { ...this.getAuthHeaders(), 'Content-Type': 'application/json' };
            await fetch(url, {
                method: 'POST',
                headers,
                ...(base ? {} : { credentials: 'include' }),
                body: JSON.stringify({ tool_call_id: ev.tool_call_id, ...answer }),
            });
        } catch (e) {
            this._wfNodeLog(dfId, 'error', 'failed to post gate answer: ' + (e?.message || e), 'error');
        }
```

- [ ] **Step 2: Add the compiled run driver**

```js
    /**
     * Run a compiled workflow through its own server: start it, open the overlay,
     * stream the run protocol into the same handlers the live interpreter uses.
     */
    async _runCompiled(root) {
        const prompt = await this._showRunPromptModal(this._startNodePrompt());
        if (prompt === null) return;
        const dfId = 'compiled';
        this.nodeExecutionData[dfId] = { pbEvents: [] };
        let target;
        try {
            target = await this._acquireRunTarget(root);
        } catch (e) {
            alert(`Could not start the workflow server: ${e?.message || e}`);
            return;
        }
        this._pbOverlayOpen(dfId, this.currentWorkflowName || 'Workflow', [], prompt);
        try {
            const started = await fetch(`${target.base}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });
            if (!started.ok) throw new Error((await started.text()) || `HTTP ${started.status}`);
            const { run_id: runId } = await started.json();
            this._runTarget.runId = runId;

            await new Promise((resolve, reject) => {
                const es = new EventSource(`${target.base}/runs/${runId}/events`);
                es.addEventListener('done', (m) => {
                    const ev = JSON.parse(m.data);
                    es.close();
                    this._pbOverlayFinish(true, `run ${ev.run_id} ${ev.status} — ${String(ev.output || '').slice(0, 300)}`);
                    resolve();
                });
                es.addEventListener('error', (m) => {
                    // A transport error has no data; a protocol error does.
                    if (!m.data) return;   // EventSource reconnects on its own
                    const ev = JSON.parse(m.data);
                    es.close();
                    reject(new Error(ev.error || 'run failed'));
                });
                es.onmessage = (m) => {
                    try { this._handlePlaybookEvent(dfId, JSON.parse(m.data)); } catch (_) { /* keep streaming */ }
                };
            });
        } catch (e) {
            this._pbOverlayFinish(false, String(e?.message || e));
        } finally {
            this._runTarget = null;
        }
    }
```

- [ ] **Step 3: Call it from Run**

In `_runLangGraphScript()`, replace the multi-file branch added in the modular work:

```js
        const codegenMode = this._codegenOptions().mode;
        if (codegenMode === 'modular') {
            // The compiled package serves its own run API; the overlay drives it.
            let data;
            try { data = await this._writeManifest(codegenMode); }
            catch (e) { alert(`Could not generate the workflow package: ${e?.message || e}`); return; }
            return this._runCompiled(data.root);
        }
        if (codegenMode !== 'single') {
            const entry = 'orchestrator.py';
            try { const data = await this._writeManifest(codegenMode); filename = `${data.root}/${entry}`; }
            catch (e) { alert(`Could not generate the A2A folder: ${e?.message || e}`); return; }
        } else {
            filename = await this._generateAndWriteScript('generate-python', 'workflow.py');
        }
```

- [ ] **Step 4: Show which engine is running**

In `_pbOverlayOpen()`, where the overlay header is built, append a target badge:

```js
        const target = this._runTarget
            ? `${this.t('workflow.output.runTargetCompiled') || 'compiled'} · ${this._runTarget.base.replace(/^https?:\/\//, '')}`
            : (this.t('workflow.output.runTargetLive') || 'live interpreter');
```

and render it next to the overlay title as `<span class="text-xs text-gray-400">${this.escapeHtml(target)}</span>`.

- [ ] **Step 5: Render bubble content through the shared renderers**

Spec §6: a compiled run's messages should render like chat content, not plain text.
`_pbBubble(who, text, opts)` currently escapes and inserts the text. Route it
through the modules `chat.js` already uses — they are standalone, so this is a
call, not a refactor:

```js
    /** Message body HTML: markdown + mermaid when the renderers are loaded, escaped text otherwise. */
    _pbRenderBody(text) {
        try {
            if (window.markdownRenderer?.render) {
                const html = window.markdownRenderer.render(String(text || ''));
                // Mermaid blocks are upgraded in place after insertion (same
                // contract chat.js uses), so hand back the markdown result now.
                return html;
            }
        } catch (_) { /* fall through to plain text */ }
        return this.escapeHtml(String(text || '')).replace(/\n/g, '<br>');
    }
```

Call it where `_pbBubble()` builds the bubble's inner HTML, and after inserting
run the mermaid pass the same way chat.js does:

```js
        const el = this._pbAppend(html);
        try { window.mermaidRenderer?.renderIn?.(el); } catch (_) { /* diagram stays as code */ }
        return el;
```

Verify the exact global names and method signatures before writing this — read
`frontend/assets/js/markdown-renderer.js` and `mermaid-renderer.js` and call
them the way `chat.js` does. If either exposes a different entry point, use
that one; do not add a second renderer.

- [ ] **Step 6: Manual run-target override**

Spec §6: talk to a workflow server that is already running (another machine, a
`--no-spawn` equivalent). In the LangGraph menu, add an item `Run against a URL…`
next to Run:

```js
        menu.querySelector('[data-action="run-url"]')?.addEventListener('click', async () => {
            menu.remove();
            const url = prompt(this.t('workflow.output.runTargetPrompt') || 'Workflow server URL', 'http://127.0.0.1:8710/');
            if (!url) return;
            try {
                await this._verifyRunTarget(url);        // identity check only, no spawn
            } catch (e) {
                alert(`That server cannot run this workflow: ${e?.message || e}`);
                return;
            }
            await this._runCompiled(null);               // null root: never spawn, use _runTarget
        });
```

Split the identity check out of `_acquireRunTarget()` so both paths share it:

```js
    /** Verify a run server is this workflow's current compile; sets this._runTarget. */
    async _verifyRunTarget(url) {
        const base = url.endsWith('/') ? url : url + '/';
        const cardResp = await fetch(`${base}.well-known/workflow.json`);
        if (!cardResp.ok) throw new Error(`${base} did not serve its identity`);
        const card = await cardResp.json();
        if (String(card.workflow_id) !== String(this.currentWorkflowId)) {
            throw new Error(`serving workflow ${card.workflow_id}, not ${this.currentWorkflowId}`);
        }
        if (card.protocol !== 'run/1') {
            throw new Error(`speaks protocol ${card.protocol}, this editor speaks run/1`);
        }
        this._runTarget = { base: base.replace(/\/$/, ''), version: card.version };
        return this._runTarget;
    }
```

`_acquireRunTarget(root)` becomes: POST to the runner's start endpoint, then
`return this._verifyRunTarget(url)`. `_runCompiled(root)` skips the acquire step
when `root` is null and `this._runTarget` is already set.

Add the menu item to the LangGraph menu markup beside the existing `data-action="run"`
entry, labelled from `t('workflow.output.runTargetUrl') || 'Run against a URL…'`.

Add both i18n keys to en/es/fr:

```json
      "runTargetUrl": "Run against a URL…",
      "runTargetPrompt": "Workflow server URL",
```
```json
      "runTargetUrl": "Ejecutar contra una URL…",
      "runTargetPrompt": "URL del servidor del flujo de trabajo",
```
```json
      "runTargetUrl": "Exécuter sur une URL…",
      "runTargetPrompt": "URL du serveur de workflow",
```

- [ ] **Step 7: Syntax check and cache-buster**

Run:
```bash
node --check frontend/assets/js/workflow-editor.js && echo "JS ok"
for f in en es fr; do python3 -c "import json;json.load(open('frontend/assets/i18n/$f.json'));print('$f ok')"; done
```
Expected: `JS ok`, `en ok`, `es ok`, `fr ok`

Bump `frontend/index.html` to `workflow-editor.js?v=20260910-runserver2`.

- [ ] **Step 8: Manual verification (the only test for this layer)**

1. Start the runner: `cd ~/Documents/synergyAI/python && ./.venv/bin/python main.py` (or however it is normally started).
2. Open the editor on workflow 44 (Dispatcher demo), Output node → LangGraph → Generate → **Agents in separate files** → Generate.
3. Press Run. Confirm: the prompt box appears pre-filled; the overlay opens with a `compiled · 127.0.0.1:<port>` badge; tool cards and messages stream in.
4. When the HR playbook reaches the manager approval, confirm an approval card appears with Approve/Deny; click **Deny** with a comment.
5. Confirm the run continues, the transcript records `denied` with your comment and `actor` set to you — not `auto-approved (non-interactive run)`.
6. Reload the page mid-run and reattach (re-press Run is not needed — this step only verifies the run survives; the reattach UI is M2).

- [ ] **Step 9: Commit**

```bash
git add frontend/assets/js/workflow-editor.js frontend/assets/i18n/*.json frontend/index.html
git commit -m "feat(editor): drive a compiled run through the playbook overlay"
```

---

### Task 8: A2A serves the same contract

**Files:**
- Modify: `backend/src/AgentTeam/Services/LangGraphGenerator.php` (`generateA2A()`, new `emitA2AApi()`; `a2aOrchestratorBlock()` — `_handle_gate`)
- Modify: `backend/tests/Unit/CompiledRunServerTest.php`
- Modify: `frontend/assets/js/workflow-editor.js` (route A2A through `_runCompiled` too)

**Interfaces:**
- Consumes: `modularApiBlock()` (Task 3), `AgentSupervisor` (existing, in `orchestrator.py`)
- Produces: `agents/`-sibling `api.py` in the A2A manifest; `_handle_gate()` gains the `server` branch

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/Unit/CompiledRunServerTest.php`:

```php
    public function testA2AManifestCarriesTheSameRunServer(): void
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['a2a' => true]);
        $paths = array_column($m['files'], 'path');
        $this->assertContains('api.py', $paths);
        $api = $m['files'][array_search('api.py', $paths, true)]['code'];
        foreach (['@app.post("/runs")', '@app.get("/runs/{run_id}/events")',
                  '@app.get("/.well-known/workflow.json")', 'AgentSupervisor',
                  'from orchestrator import run as run_workflow'] as $needle) {
            $this->assertStringContainsString($needle, $api, "missing: {$needle}");
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit --filter testA2AManifest tests/Unit/CompiledRunServerTest.php`
Expected: FAIL — `Failed asserting that an array contains 'api.py'`.

- [ ] **Step 3: Emit `api.py` for A2A**

In `generateA2A()`, after the orchestrator entry:

```php
        $files[] = ['path' => 'api.py', 'code' => $this->emitA2AApi($facts, $layout)];
```

Add the emitter — identical to `emitModularApi()` except for the imports, the supervisor lifecycle and the docstring:

```php
    /** api.py for the A2A folder: same run contract, with the agent supervisor's lifecycle. */
    private function emitA2AApi(array $facts, array $layout): string
    {
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $L = [];
        $L[] = '"""Run server for workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' (A2A)';
        $L[] = '';
        foreach (explode("\n", $esc($this->a2aDocBody($facts, $layout, array_key_first($layout['agents'])))) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, time, uuid';
        $L[] = '';
        $L[] = 'from fastapi import FastAPI, HTTPException, Request';
        $L[] = 'from fastapi.middleware.cors import CORSMiddleware';
        $L[] = 'from fastapi.responses import StreamingResponse';
        $L[] = 'import uvicorn';
        $L[] = '';
        $L[] = 'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $L[] = 'from orchestrator import set_event_sink, resolve_gate';
        $L[] = '';
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts));
        $L[] = '';
        $L[] = '# The agent servers start with the first run and stop with this process.';
        $L[] = '_SUPERVISOR = None';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _ensure_agents():';
        $L[] = '    """Start the A2A agent servers once, on the first run."""';
        $L[] = '    global _SUPERVISOR';
        $L[] = '    if _SUPERVISOR is None:';
        $L[] = '        _SUPERVISOR = AgentSupervisor(spawn=True)';
        $L[] = '        _SUPERVISOR.start()';
        $L[] = '';
        $L[] = self::modularApiBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }
```

In `modularApiBlock()`, add the hook `_drive()` needs so A2A can start its agents (a no-op in the modular package):

```python
async def _drive(state: RunState) -> None:
    """Run the graph with the event sink installed, then publish the terminal frame."""
    loop = asyncio.get_running_loop()
    app.state.loop = loop
    if "_ensure_agents" in globals():
        globals()["_ensure_agents"]()
    ...
```

- [ ] **Step 4: Add the sink and gate rendezvous to the orchestrator**

`orchestrator.py` does not carry `common.py`, so emit the same block into it. In `emitA2AOrchestrator()`, after the dispatch block:

```php
        $L[] = PythonEmitHelpers::eventSinkBlock();
```

and in `a2aOrchestratorBlock()`, change `_handle_gate()` to try the sink first:

```python
def _handle_gate(agent_name: str, task_id: str, gate: dict) -> dict:
    """Return the answer data part for one gate: {decision, comment, fields?}."""
    kind = str(gate.get("gate") or "gate")
    args = gate.get("args") or {}
    question = args.get("question") or args.get("prompt") or args.get("reason") or kind
    print("[gate] " + json.dumps({"agent": agent_name, "task": task_id, "kind": kind, "question": question, "args": args}, ensure_ascii=False), flush=True)
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
        "server" if _SINK is not None
        else "prompt" if sys.stdin.isatty()
        else "auto")
    if mode == "server":
        tool_call_id = uuid.uuid4().hex
        waiter = open_gate(tool_call_id)
        emit_event(type="gate_request", kind=kind, payload=dict(args), tool_call_id=tool_call_id)
        answered = waiter.wait(float(os.environ.get("PLAYBOOK_GATE_TIMEOUT_S", "900")))
        answer = take_gate_answer(tool_call_id)
        if answered and answer is not None:
            print("[gate-answer] " + json.dumps({"agent": agent_name, "task": task_id, **answer}, ensure_ascii=False), flush=True)
            return answer
    # ... existing prompt / deny / auto branches unchanged ...
```

Add `uuid` to the orchestrator's import line in `emitA2AOrchestrator()`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/CompiledRunServerTest.php tests/Unit/LangGraphA2AGeneratorTest.php`
Expected: PASS. Every A2A file still passes `py_compile` (the A2A suite checks this).

- [ ] **Step 6: Route A2A runs through the same driver**

In `_runLangGraphScript()`, change the modular branch condition to cover both:

```js
        if (codegenMode !== 'single') {
            let data;
            try { data = await this._writeManifest(codegenMode); }
            catch (e) { alert(`Could not generate the workflow package: ${e?.message || e}`); return; }
            return this._runCompiled(data.root);
        }
        filename = await this._generateAndWriteScript('generate-python', 'workflow.py');
```

Run: `node --check frontend/assets/js/workflow-editor.js && echo "JS ok"` and bump the cache-buster to `20260910-runserver3`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/AgentTeam/Services/LangGraphGenerator.php \
        backend/tests/Unit/CompiledRunServerTest.php \
        frontend/assets/js/workflow-editor.js frontend/index.html
git commit -m "feat(compiler): A2A folder serves the same run contract"
```

---

### Task 9: Protocol conformance fixture

Spec §8's drift control. One fixture, checked by both implementations, so a protocol change that updates only one side fails the other's suite.

**Files:**
- Create: `docs/run-protocol-v1.json`
- Create: `backend/tests/Unit/RunProtocolConformanceTest.php`
- Create: `backend/tests/fixtures/compiled/conformance_probe.py`

**Interfaces:**
- Consumes: the emitted event vocabulary (Tasks 1–3), the PHP interpreter's SSE events (existing `PlaybookNodeRunner`)
- Produces: `docs/run-protocol-v1.json` — `{version, events: {name: {required: [...], optional: [...]}}, terminal: {...}}`

- [ ] **Step 1: Write the contract**

Create `docs/run-protocol-v1.json`:

```json
{
  "version": "run/1",
  "note": "The run event protocol. Both the PHP playbook interpreter and every compiled run server must emit events that validate against this. Changing it requires updating both sides; RunProtocolConformanceTest.php enforces that.",
  "events": {
    "round":        { "required": ["type", "round"],                  "optional": [] },
    "tool_call":    { "required": ["type", "name"],                   "optional": ["args"] },
    "tool_result":  { "required": ["type", "name"],                   "optional": ["result"] },
    "message":      { "required": ["type", "text"],                   "optional": ["sensitive"] },
    "note":         { "required": ["type", "text"],                   "optional": [] },
    "gate_request": { "required": ["type", "kind", "payload"],        "optional": ["tool_call_id", "ui_resource"] },
    "final":        { "required": ["type", "status"],                 "optional": ["leg"] }
  },
  "terminal": {
    "done":  { "required": ["run_id", "status", "output"], "optional": ["seconds"] },
    "error": { "required": ["error"],                      "optional": ["run_id"] }
  },
  "answer": {
    "required": ["tool_call_id"],
    "note": "Flat: {tool_call_id, ...answer}. Answer keys vary by gate kind — approval {decision, comment, actor}, handoff {decision, comment}, form {<field>: <value>}, await_message {text}. gate_request.ui_resource is reserved for agent-authored forms (spec §7): {uri, server_url}, hosted through mcp-app-host.js. Nothing emits it yet."
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/Unit/RunProtocolConformanceTest.php`:

```php
<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Spec §8: the run protocol has three implementations (the PHP interpreter,
 * the browser-side node runner, the compiled run server). This pins the
 * contract so a change to one side fails the others' suite.
 */
class RunProtocolConformanceTest extends TestCase
{
    private static function contract(): array
    {
        return json_decode(file_get_contents(__DIR__ . '/../../../docs/run-protocol-v1.json'), true);
    }

    public function testTheCompiledServerEmitsOnlyContractEvents(): void
    {
        $root = CompiledRunServerTest::writePackage();
        $probe = __DIR__ . '/../fixtures/compiled/conformance_probe.py';
        exec('python3 ' . escapeshellarg($probe) . ' ' . escapeshellarg($root)
            . ' ' . escapeshellarg(__DIR__ . '/../../../docs/run-protocol-v1.json') . ' 2>&1', $out, $rc);
        $this->assertSame(0, $rc, implode("\n", $out));
    }

    public function testThePhpInterpreterEmitsOnlyContractEvents(): void
    {
        $contract = self::contract();
        $src = file_get_contents(__DIR__ . '/../../src/AgentTeam/Services/PlaybookInterpreter.php');
        preg_match_all("/'type'\s*=>\s*'([a-z_]+)'/", $src, $m);
        $emitted = array_unique($m[1]);
        $known = array_merge(array_keys($contract['events']), ['error']);
        foreach ($emitted as $type) {
            $this->assertContains($type, $known, "PlaybookInterpreter emits '{$type}', which run-protocol-v1.json does not describe");
        }
    }
}
```

Create `backend/tests/fixtures/compiled/conformance_probe.py`:

```python
"""Probe: every event the compiled runtime emits validates against the contract.

argv[1] = compiled package root, argv[2] = run-protocol-v1.json
"""
import json, sys, importlib, threading

sys.path.insert(0, sys.argv[1])
contract = json.load(open(sys.argv[2]))
common = importlib.import_module("common")

seen = []
common.set_event_sink(seen.append)

run = common._PlaybookRun(False, {})
run.emit(type="message", text="hi", sensitive=False)
run.emit(type="tool_call", name="get_pto_balance", args={"email": "a@b"})
run.emit(type="tool_result", name="get_pto_balance", result={"ok": True})
run.emit(type="note", text="noted")
common.emit_event(type="round", round=1)
common.emit_event(type="final", status="resolved", leg=1)

import os
os.environ["PLAYBOOK_GATE_TIMEOUT_S"] = "1"
common._playbook_gate(run, "approval", "request_approval", {"question": "q"})

problems = []
for ev in seen:
    spec = contract["events"].get(ev.get("type"))
    if spec is None:
        problems.append(f"undescribed event type: {ev.get('type')} ({ev})")
        continue
    for key in spec["required"]:
        if key not in ev:
            problems.append(f"{ev['type']} is missing required field {key}: {ev}")
    extra = set(ev) - set(spec["required"]) - set(spec["optional"])
    if extra:
        problems.append(f"{ev['type']} has undescribed fields {sorted(extra)}: {ev}")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("OK")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/RunProtocolConformanceTest.php`
Expected: FAIL on the first test — the `tool_result` the server-mode gate emits carries `decision` inside `result`, which is allowed, but `gate_request` carries `tool_call_id`; if either mismatch appears, the probe prints the exact field and event.

- [ ] **Step 4: Reconcile contract and code**

Fix whichever side is wrong: if the emitted event is right, add the field to `docs/run-protocol-v1.json`; if the contract is right, fix the emitter in `LangGraphGenerator.php`. Do not loosen the contract to silence a real mismatch — `gate_request.tool_call_id` is optional precisely because the console path has no id, and that is the only optionality of its kind.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/RunProtocolConformanceTest.php`
Expected: PASS (2 tests)

- [ ] **Step 6: Run everything**

Run:
```bash
cd backend && php vendor/bin/phpunit tests/Unit
cd ../langchain_runner && python3 -m pytest tests/ -v
```
Expected: the 25 pre-existing failures in the PHP suite are unchanged (`AgentDelegationFunctions`, `MafGeneratorEmit`, `GenesisProposer`, `AdkGenerator*`, `PythonEmitHelpersPin`, `WorkflowGraphAnalyzerAnalyze`, `AgentTest`, `AIPortfolioAssistant`) and no new ones appear; the runner suite is green.

- [ ] **Step 7: Commit**

```bash
git add docs/run-protocol-v1.json backend/tests/Unit/RunProtocolConformanceTest.php \
        backend/tests/fixtures/compiled/conformance_probe.py
git commit -m "test: pin the run protocol so its three implementations cannot drift"
```

---

## Deferred to M2 (separate spec)

- `index.html?run=<url>` client mode built on `chat.js`.
- `ui_resource` on `gate_request` → agent-authored forms hosted through `mcp-app-host.js`.
- Reattaching the overlay to a run in progress after a page reload (the server already supports it; only the UI is missing).
- The TypeScript and Python backend twins of the generator changes.
