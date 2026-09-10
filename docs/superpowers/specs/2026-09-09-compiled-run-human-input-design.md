# Human input for compiled workflow runs — design

Date: 2026-09-09. Branch: feat/backend-python. Status: approved in discussion.

## 1. Goal

A compiled LangGraph run started from the editor can ask the person who started it for data, and that person can answer in the browser.

Two kinds of input:

- **Playbook gates.** The four gate kinds (`trigger_form`, `request_approval`, `prompt_handoff`, `await_message`) become answerable cards in the Run output modal instead of being auto-answered by policy.
- **The run prompt.** Run opens a prompt box pre-filled with the Start node's text, so one workflow can be run against different requests without editing the graph.

Today neither is possible. `_openRunOutputModal()` (`frontend/assets/js/workflow-editor.js:5045`) is a read-only `<pre>`; `/api/run-file` spawns the script with `stdout`/`stderr` piped and **no stdin** (`langchain_runner/main.py:242`); and the Run call sends `args: []` on purpose, so the baked Start-node prompt is the only input a run ever receives. The generated `_playbook_gate()` therefore takes its `auto` branch on every runner-driven run: approvals are auto-approved, handoffs acknowledged, forms and awaits answered `"unavailable"`.

Applies to the three LangGraph targets: single file, modular ("agents in separate files") and A2A. ADK, MAF and NOOA are out of scope — they do not run playbooks.

Out of scope: durable pause across a runner restart (a gate lives in the blocked process, the same decision the A2A design took); gates for runs started outside the runner; a new "Ask the user" node type usable by non-playbook workflows.

## 2. User-facing behaviour

1. **Run ▶** opens "Run workflow": a textarea pre-filled with the Start node's prompt, plus Cancel and Run. Running sends the text as the script's positional argument, which every generated target already accepts as an override for `DEFAULT_PROMPT`. Ingestion runs keep their current path and get no prompt box.
2. The Run output modal streams the run as it does today, minus the SSE framing that currently leaks into the pane (see §5).
3. When a playbook reaches a gate, a **gate card** appears at the bottom of the log — the same card the live interpreter shows in the conversation feed: approval with Approve/Deny plus a comment, a form with one input per field and a completeness guard, a handoff with collapsed internal notes, an await-message textarea.
4. Submitting unblocks the run; the log records `[gate-answer] {...}` and the transcript carries the human decision.
5. Closing the modal while a gate is pending answers it `cancelled` rather than leaving the subprocess blocked. If the browser goes away entirely, the gate times out after `PLAYBOOK_GATE_TIMEOUT_S` (default 900 s) and the run continues with today's auto behaviour.

A direct terminal run (`python workflow.py "prompt"`) is unchanged: `sys.stdin.isatty()` is true, so gates are asked on the console.

## 3. The channel

```
browser ──POST /api/run-input/<run_id> {id, ...answer}──▶ runner
                                                          │ writes one JSON line
                                                          ▼
                                                    script stdin

script ──[gate] {"id",...} on stdout──▶ SSE ──▶ browser renders the card
```

### 3.1 Runner (`langchain_runner/main.py`)

- `_stream_script_run()` spawns with `stdin=asyncio.subprocess.PIPE`, mints `run_id = uuid4().hex`, registers `_RUNS[run_id] = proc`, and sets `SYNERGYAI_RUN_ID` in the child environment.
- Before the output pumps start it yields one frame:
  `event: run\ndata: {"run_id": "<hex>"}\n\n`
- The registry entry is removed in a `finally` after `proc.wait()`, and stdin is closed there.
- New `POST /api/run-input/{run_id}`, body = the answer object (must carry `id`): writes `json.dumps(body) + "\n"` to `proc.stdin`, drains, returns `{"ok": true}`. Unknown or already-exited run → 404 with a message naming the run id.

`_RUNS` is the only state added to a deliberately stateless runner: in-memory, live runs only, gone when the runner restarts. Rejected alternatives: keying by PID (racy after reuse) and client-supplied ids (lets one browser write into another's run).

The change reaches the running runner only after `python3 setup.py --force --skip-venv` copies it to `~/Documents/synergyAI/python/`.

### 3.2 Generated code

One branch added to `_playbook_gate()` (single-file and modular, via `playbookRuntimeBlock()`) and to `_handle_gate()` (the A2A orchestrator, via `a2aOrchestratorBlock()`). The mode selector becomes:

```python
mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
    "prompt" if sys.stdin.isatty()
    else "bridge" if os.environ.get("SYNERGYAI_RUN_ID")
    else "auto")
```

`PLAYBOOK_GATE_MODE` keeps overriding everything, so `auto` / `deny` / `prompt` behave exactly as before, and a run with no runner around (CI, cron, a plain subprocess) still falls to `auto`.

Bridge mode:

1. mint `gid = uuid4().hex`;
2. `print("[gate] " + json.dumps({"id": gid, "kind": kind, "tool": name, "payload": args}), flush=True)`;
3. read lines from stdin until one parses as JSON **and** its `id` equals `gid` — a line that does not match is discarded, so a late or stray answer can never be consumed by the wrong gate;
4. wait with a real deadline: `select.select([sys.stdin], [], [], remaining)`, falling back to a blocking `readline()` where select cannot watch a pipe (Windows). Timeout or EOF degrades to the existing `auto` result for that gate kind, with `[gate-answer] {"actor": "policy", ...}` printed so the log says what happened;
5. on success print `[gate-answer] {...}` and return `{"ok": True, "decision": <answer>}`.

The gate tool hands its return value straight to the model, so the browser's answer needs no translation: approval `{decision, comment, actor}`, handoff `{decision, comment}`, form `{<field>: <value>, ...}`, await `{text}`.

`payload` is `args` unchanged — `{prompt, fields[]}`, `{approver, question, context}`, `{team_or_person, reason, summary}`, `{prompt}` — which is exactly the shape the existing card renderer reads.

## 4. Frontend

`frontend/assets/js/workflow-editor.js`:

- `_showRunPromptModal(defaultPrompt)` — textarea + Cancel/Run, resolving to the prompt string or null. Called by `_runLangGraphScript()` before generating; the result is sent as `args: [prompt]`.
- **SSE frame parsing** in the run-output reader: buffer the decoded text, split on `\n\n`, and dispatch by event — `run` captures `run_id`, `stdout`/`stderr` append their `data:` lines, `exit` finishes. This replaces appending the raw body.
- **Gate rendering**: a `stdout` line starting with `[gate] ` is parsed and rendered as a card instead of being appended raw. The card is built with the existing `_pbGateParts(ev)` and wired with `_pbGateBind(root, kind, finish)` (`:11973`, `:12032`) — both already transport-agnostic ("used by the inline feed card AND the fallback modal"). On submit, `POST ${this._langgraphRunnerBase}/api/run-input/${runId}` with `{id, ...answer}`.
- `_openRunOutputModal()` returns one more handle, `showGate(ev)`, and tracks the pending gate so Close can answer it `cancelled`.
- New i18n keys (en/es/fr) for the prompt modal: `workflow.output.runPromptTitle`, `runPromptHelp`, `runPromptRun`. Cache-buster bump on `workflow-editor.js`.

Reused as-is: the card markup, the form completeness guard, sensitive-field masking, and the `.storage-config-*` styling.

## 5. Behaviour changes to call out

The run log currently shows the raw SSE framing (`event: stdout`, `data: …`) because the reader appends the response body verbatim. Frame parsing removes that noise. This is a deliberate, visible change to what the pane looks like.

## 6. Testing

**Runner** (`langchain_runner/tests/`, alongside `test_resolve_script_path.py`):

- the first frame of a run is `event: run` carrying a `run_id`;
- `POST /api/run-input/<unknown>` → 404;
- `POST /api/run-input/<live>` writes the JSON line to the process stdin;
- **integration**: a fixture script that prints a `[gate]` line, reads stdin and echoes what it got, driven through `_stream_script_run()` plus the endpoint. This is the test that proves the channel end to end.

**Generator** (PHPUnit): the emitted gate function carries the bridge branch, echoes the gate id, keeps `auto`/`deny`/`prompt`, and prints `[gate-answer]` — asserted for the single-file script, a modular package and the A2A orchestrator. Every emitted file still passes `python3 -m py_compile`.

**Frontend**: no JS test infra in the repo, so manual — run the Dispatcher demo from the editor, answer the HR approval gate in the browser, and confirm the transcript records the human decision rather than "auto-approved (non-interactive run)".

## 7. Risks and decisions

- **A blocked subprocess.** A gate holds the process until answered, cancelled or timed out. Bounded by `PLAYBOOK_GATE_TIMEOUT_S` and by Close posting `cancelled`; a runner restart kills pending runs outright.
- **One gate at a time.** The script blocks, so at most one gate is pending per run and no queue is needed. The id echo is what makes that safe rather than assumed.
- **Two channels to keep in step.** The live PHP interpreter answers gates over `/workflows/tool-result`; compiled runs answer over `/api/run-input`. They share the card renderer but not the transport. Accepted: the interpreter is server-side and long-lived, the runner is a subprocess pipe, and forcing one transport on both would complicate the simpler side.
- **`select` on Windows.** Not supported for pipes; the fallback is a blocking read with no timeout there. The deployment is macOS/LAN, so this is documented rather than solved.
