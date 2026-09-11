# Compiled workflows as run servers — design

Date: 2026-09-10. Branch: feat/backend-python. Status: approved in discussion.

Supersedes `2026-09-09-compiled-run-human-input-design.md` (stdin bridge). Only the run-prompt box survives from it; the `[gate]` stdout convention and `POST /api/run-input` are dropped.

## 1. Goal

A compiled LangGraph workflow serves its own run API, and the existing frontend drives it — same run overlay, same gate cards, same renderers — by pointing *one run* at that server instead of the app backend.

This replaces the stdin bridge because the frontend already has a rich client for exactly this: the playbook run overlay consumes an SSE event stream (`round`, `tool_call`, `tool_result`, `message`, `gate_request`, `final`) and answers gates with a POST. A compiled workflow that emits that same protocol needs **no new UI at all**.

What it unlocks beyond answering gates: a compiled folder becomes a thing you can hand to someone — one command, open the UI, use it — instead of a developer artifact in `scripts/`.

Out of scope here: a new "Ask the user" node type for non-playbook agents (the protocol reserves room for it, §7); the standalone client mode (§11, milestone 2); multi-user or authenticated access.

## 2. Architecture

Three parts, each small because each sits on an existing seam:

1. **`api.py`** — emitted into the compiled package. Imports the graph, runs it, and serves the run contract over HTTP+SSE.
2. **A run-scoped target in the frontend** — `_runTarget.base`, resolved when a run starts, used by the run's calls only. The app's `apiBase` never moves.
3. **The existing run overlay** — reused verbatim as the run view, with `markdown-renderer.js` / `mermaid-renderer.js` / `mcp-app-host.js` for rich content inside bubbles.

```
editor Run ▶
   │ POST /api/workflow-server/start {folder}
   ▼
runner ──spawns── python api.py --port 8710 ──▶ workflow server
   │ polls /.well-known/workflow.json until ready
   ◀── {url}
editor: _runTarget.base = url;  verify id + version
   │ POST   <url>/runs            {prompt}          -> {run_id}
   │ GET    <url>/runs/<id>/events (EventSource)    -> round/tool_call/message/gate_request/…
   │ POST   <url>/runs/<id>/tool-result {tool_call_id, ...answer}
   ▼
run overlay renders; gate cards answer; final closes the run
```

## 3. The run contract

The event vocabulary is taken verbatim from what `_handlePlaybookEvent()` (`workflow-editor.js:12147`) already handles, so the overlay needs no new cases:

| Event (`data:` JSON `type`) | Fields | Overlay does |
|---|---|---|
| `round` | `round` | node log line |
| `tool_call` | `name`, `args` | activity card |
| `tool_result` | `name`, `result.ok` | activity card resolves |
| `message` | `text`, `sensitive` | bubble (redacted when sensitive) |
| `gate_request` | `kind`, `payload`, `tool_call_id` | gate card, answered by POST |
| `final` | `leg`, `status` | node log line |
| SSE `event: done` | `{run_id, status, output}` | finish banner, node output |
| SSE `event: error` | `{error}` | error banner |

Three routes plus an identity endpoint:

- `POST /runs` — body `{prompt}`. Starts the run, returns `{run_id}` immediately. Does **not** stream.
- `GET /runs/{run_id}/events` — SSE. Plain GET so the browser can use native `EventSource`; every frame carries an `id:`, and `Last-Event-ID` replays from a per-run ring buffer (default 500 events) so a reloaded tab reattaches and catches up.
- `POST /runs/{run_id}/tool-result` — body `{tool_call_id, ...answer}`, the same flat shape `/workflows/tool-result` takes today (see `GateManagerTest.php`). Resolves the waiting gate.
- `GET /.well-known/workflow.json` — `{workflow_id, name, version, protocol: "run/1"}`, unauthenticated, served before any run exists.

Splitting the run from the stream is forced by SSE being client-initiated: the server cannot announce a run or push to a browser that is not attached. Making the stream a separate, replayable GET is what lets a run outlive its viewer.

**No authentication.** The server has no users and no session; the frontend sends no `Authorization` to a run target that is not the app backend. Consistent with the LAN-only posture already set for the runner and ingestion.

## 4. What the compiler emits

`api.py` is added to the **modular** package and the **A2A** folder. The single-file target is unchanged — it stays the one-file artifact you can copy anywhere, and the editor keeps running it through the existing log modal.

`api.py` (modular):

- imports `run`, `AGENTS`, `WORKFLOW_ID/NAME`, `DEFAULT_PROMPT` from `workflow`, and `NODE_DURATIONS` from `common`;
- `RunState` per run: id, status, `asyncio.Queue` of events, ring buffer, and a `dict[tool_call_id] -> asyncio.Future` of pending gates;
- an **event sink**: `common.py` gains `_SINK = None` and `set_event_sink(fn)`, and the places that already print trace lines call `_emit(type=..., ...)` (a no-op when no sink is installed) alongside the print. `api.py` installs a sink that pushes onto the current run's queue. `_run_node_module()` emits `round`/`final`, the playbook runtime emits `message`/`tool_call`/`tool_result`, and `_playbook_gate()` gets its third mode (§5). A run with no sink — the CLI — behaves exactly as today;
- FastAPI app with the four routes, uvicorn entry point, `--port` / `WORKFLOW_API_PORT` (default 8710), `--host` default 127.0.0.1.

For A2A, `api.py` sits beside `orchestrator.py`, starts the `AgentSupervisor` on first run, and maps each agent's `input-required` task state onto a `gate_request` event — the orchestrator's `_handle_gate()` becomes "emit the event, await the future" instead of console/policy.

The gate seam stays one function per target, as it is today.

## 5. The third gate mode

`_playbook_gate()` (and the A2A `_handle_gate()`) gain a `server` mode, selected when the runtime has an event sink installed:

```python
mode = PLAYBOOK_GATE_MODE
    or ("server" if _SINK else "prompt" if sys.stdin.isatty() else "auto")
```

In `server` mode the gate mints a `tool_call_id`, emits `{"type": "gate_request", "kind", "payload": args, "tool_call_id"}`, and awaits a future with a deadline (`PLAYBOOK_GATE_TIMEOUT_S`, default 900). On timeout — nobody attached, or the person walked away — it falls back to exactly today's `auto` result and emits a `tool_result` recording that a policy, not a human, answered.

`PLAYBOOK_GATE_MODE` keeps overriding everything, so terminal runs, CI and cron behave exactly as they do now.

## 6. Frontend changes

`frontend/assets/js/workflow-editor.js`:

- **`_runTarget`** — `{base, workflowVersion}` set when a compiled run starts, cleared when it ends. Never persisted: a remembered pointer at a dead port is a support call. The run's three calls read `this._runTarget?.base || this.apiBase`; everything else keeps using `apiBase`.
- **Launch handshake** — `POST <runner>/api/workflow-server/start {folder}` → `{url}`; then `GET <url>/.well-known/workflow.json` and compare `workflow_id` + `version` against the compile just written. A mismatch aborts with a message naming the port, rather than running yesterday's graph against today's canvas (the failure the A2A supervisor already learned to catch).
- **Run prompt** — `_showRunPromptModal(defaultPrompt)` before the run, pre-filled from the Start node; the text becomes `POST /runs {prompt}`. Applies to every mode, including single-file (where it stays a CLI argument).
- **Overlay reuse** — `_pbOverlayOpen()` for the run, `_handlePlaybookEvent()` for the events, `_pbGateParts` / `_pbGateBind` for the cards. The one addition is rendering bubble content through `markdown-renderer` / `mermaid-renderer` instead of plain text.
- **Header indicator** — `compiled · 127.0.0.1:8710` vs `live interpreter`, so a transcript can always be traced to the engine that produced it.
- **Manual target override** — a URL field that skips the spawn and talks to a workflow server running elsewhere (the `--no-spawn` analogue).
- New i18n keys (en/es/fr) for the prompt modal and the indicator; cache-buster bump.

## 7. Gates now, agent-authored forms later

The four known gate kinds keep their native cards — styled, validated, already written. The protocol reserves the general case: a `gate_request` may carry `ui_resource` (a `ui://` URI plus its server), in which case the overlay frames it through `mcp-app-host.js` and takes the answer over the existing postMessage bridge. Nothing emits that field in this milestone; it is specified so the later "any agent can ask the user" feature does not need a protocol change.

## 8. Drift control

This makes a third implementation of the run protocol (PHP interpreter, browser-side node runner, generated server), and two of those already drift on skill features. The contract in §3 is therefore the normative artifact, and a **conformance fixture** — one JSON file of event sequences plus the expected overlay-visible outcome — is checked by both the PHP interpreter tests and the generated-server tests. A change to the protocol that updates only one side fails the other's suite.

## 9. Runner changes

`langchain_runner/main.py`:

- `POST /api/workflow-server/start` — body `{folder}` (one path segment under `scripts/`, same validation as `_resolve_script_path`). Spawns `python <folder>/api.py --port <free>`, polls `/.well-known/workflow.json` for up to 60 s, returns `{url, pid}`. A server already running for that folder and version is reused rather than respawned.
- `POST /api/workflow-server/stop` — body `{folder}`; terminates with a 5 s grace, then kills.
- `_SERVERS: dict[folder, Process]` — in-memory, live servers only, cleaned on exit. Same bounded-state reasoning as the A2A supervisor.
- Requirements gain `fastapi` and `uvicorn` (uvicorn is already there).

Source/install split: these reach the running runner only after `python3 setup.py --force --skip-venv`.

## 10. Testing

**Generated server (pytest, run against a compiled fixture package):**
- `POST /runs` returns a run id without streaming;
- the event stream replays from `Last-Event-ID` after a dropped connection;
- a gate emits `gate_request` and blocks until `tool-result` arrives, then resumes with the human's answer in the tool result;
- an unanswered gate times out to the policy answer and says so in the stream;
- `/.well-known/workflow.json` reports the compiled id and version.

**Generator (PHPUnit):** `api.py` is present in the modular and A2A manifests and absent from single-file; it passes `py_compile`; it imports only names the package actually defines (the existing cross-module import test extended to cover it); the gate function carries the `server` branch and still honours `auto`/`deny`/`prompt`.

**Conformance (§8):** the shared fixture runs against both the PHP interpreter and the generated server.

**Runner (pytest):** start returns a URL and reuses a live server; stop terminates; a bad folder is refused.

**Frontend:** no JS test infra, so manual — run the Dispatcher demo compiled, answer the HR approval gate in the overlay, confirm the transcript records the human decision and the header shows the compiled target.

## 11. Milestones

**M1 — this spec.** Modular + A2A serve the contract; the editor's Run drives them through the existing overlay; gates answerable; prompt box for every mode.

**M2 — client mode (separate spec).** `index.html?run=<url>` opening the frontend as a pure client of one workflow server: no editor, no library, a conversation built on `chat.js` rather than the run overlay. The renderers being shared modules is what keeps this cheap; it is deliberately not attempted here.

## 12. Risks and decisions

- **Single-file gets no server.** Pressing Run with the single-file mode selected keeps today's log-pane experience, so gate answering depends on the chosen compile mode. Accepted to preserve the one-file artifact's character; the Run dialog states which experience the current mode gives.
- **A run outlives its viewer.** Deliberate — that is what the run/stream split buys. Bounded by the gate timeout and by the server exiting when the runner stops it.
- **Third protocol implementation.** Mitigated by §8; if the conformance fixture is skipped, this design makes drift worse, not better.
- **One server per compiled folder.** Concurrent runs of the same workflow share a process and are isolated by `run_id`. Concurrent runs of *different* workflows get different ports.
- **Port collisions.** The runner picks a free port and passes it explicitly; the identity check catches a stale process squatting on it.
