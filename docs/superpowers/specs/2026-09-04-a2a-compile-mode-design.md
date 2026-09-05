# A2A compile mode for LangGraph workflows — design

Date: 2026-09-04. Branch: feat/playbook-interpreter. Status: approved in discussion, pending written review.

## 1. Goal

Add a "Code generation options" form to the Output node's LangGraph Generate menu with one option, **A2A** (off by default). When A2A is ON, the LangGraph compiler produces, instead of one script, a folder holding an **orchestrator** and one **self-contained A2A agent server per agent or playbook node**, linked over the Agent2Agent protocol (a2a-sdk 1.1, Python). Everything the single-file script does today keeps working inside each agent: MCP tools, mandatory skill steps, the playbook runtime, dispatcher routing, provider/model/sampling settings, the Output node's storage setting, and the run summary. Playbook gates become A2A `input-required` transitions.

Every generated file carries the same internal documentation standard as the single-file scripts (module docstring with PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER, DATA FLOW, TO RUN; section banners; a comment block before each definition; docstrings on every function and class). The orchestrator additionally documents the agent endpoint table and the A2A task lifecycle it drives; each agent file documents its Agent Card, its executor, and how gates are surfaced and resumed.

Out of scope for this change: the ADK, MAF and NOOA targets; an app-side gate UI for compiled runs (the orchestrator prints structured gate lines the app can render later); durable checkpointing across process restarts; authentication on the A2A endpoints (LAN deployment, see the ingestion-is-LAN-only rule).

## 2. User-facing behaviour

### 2.1 Generate options form

- The LangGraph menu's **Generate** item opens a modal titled "Code generation options" with:
  - **A2A** toggle (checkbox styled as a switch), default OFF, help text: "Generate one A2A agent server per node plus an orchestrator, linked over the Agent2Agent protocol."
  - **Generate** and **Cancel** buttons.
- The choice is remembered per workflow in `localStorage` under `wf:<id>:codegen` (`{ "a2a": true|false }`), wrapped in try/catch as elsewhere.
- **Run** and **Display Code** read the remembered choice, so a workflow last generated with A2A ON runs and displays the A2A output. They do not open the form.
- The ADK, MAF and NOOA menus are unchanged.

### 2.2 Files produced when A2A is ON

```
python/scripts/<workflow>_a2a/
  orchestrator.py                 # drives the graph; starts/stops the agents; CLI entry
  agents/
    <nodeId>_<slug>.py            # one self-contained A2A server per agent or playbook node
```

`<workflow>` is the same safe name the single-file target uses; `<slug>` is the node's display name in kebab-case (ASCII, max 40 chars). Start and Output nodes produce no agent file: the orchestrator implements them locally, exactly as the single-file script does.

### 2.3 Running

- The editor's Run sends `filename: "<workflow>_a2a/orchestrator.py"` to the runner. The runner accepts exactly one folder level under its scripts directory (still refusing `..`, absolute paths, and non-`.py` files).
- The orchestrator starts every agent as its own subprocess, waits until each serves its Agent Card, runs the graph, prints the same `[node]`, `[tool]`, `[playbook]` trace lines the single-file script prints (prefixed with the agent name), prints the FINAL OUTPUT and RUN SUMMARY, and stops the agents. `--keep-serving` leaves the agents running after the run; `--no-spawn` skips spawning and expects the endpoints to be reachable (agents hosted elsewhere).
- Direct terminal use works the same way: `python orchestrator.py "prompt"` from the folder, with `../../.env` providing the keys (the agents load the same `.env` relative to their own location).

### 2.4 Display Code

The code modal gains a file selector (a `<select>` above the code pane) listing the manifest files with `orchestrator.py` selected first; Copy copies the selected file. The "Saved to" line shows the folder.

## 3. Backend

### 3.1 Endpoint

`GET /api/v1/workflows/{id}/generate-python?a2a=1[&download=1]`

- Without `a2a`, behaviour is unchanged (single file, raw body on download).
- With `a2a=1`, the response is JSON: `{"success": true, "data": {"root": "<workflow>_a2a", "files": [{"path": "orchestrator.py", "code": "..."}, {"path": "agents/2162_techbuddy.py", "code": "..."}, ...]}}` regardless of `download`. `Content-Disposition` is not used for the manifest.

### 3.2 Generator

`LangGraphGenerator::generate(int $workflowId, ?string $userId, array $options = [])`. With `$options['a2a'] === true` it returns `['root' => ..., 'files' => [...]]` from a new `generateA2A()` path; otherwise the existing `['filename', 'code']`.

Both paths share the analysis already performed by `generate()` (agent data, playbook data, dispatcher targets, MCP catalog, provider defaults, doc descriptors). The analysis is extracted into a private `analyzeForEmit()` returning one array so the two emitters consume the same facts; the single-file emitter's output must not change (pinned by the existing tests).

New emit methods (PHP), each returning Python text:

- `emitA2AAgentFile(array $facts, string $nid): string`
- `emitA2AOrchestrator(array $facts): string`
- Shared Python blocks reused verbatim: `mcpClientBlock`, `toolBuilderBlock`, `skillDepsBlock`, `skillFsSyncBlock`, `documentConverterBlock`, `datetimeInjectorBlock`, `playbookRuntimeBlock`, `dispatchBlock` (the dispatcher's route_to tool building is reused; the routing decision travels as a data part), the `_make_llm` factory, and `workflowDocBlock` / `nodeCommentBlock` for documentation.
- New Python blocks: `a2aAgentServerBlock()` (card, executor, gate bridge, serving entry point), `a2aOrchestratorBlock()` (agent supervisor, A2A node runner, gate handler, graph wiring).

### 3.3 Agent file contents (top to bottom)

1. Module docstring: `"""A2A agent "<name>" -- node <id> of workflow <name>` then the standard documentation body (the GRAPH sections describe the whole workflow with THIS node marked `<== this agent`), a NODE section (provider/model/sampling/tools/skills or playbook facts), an A2A section (card URL, skill id, task lifecycle, how gates are raised and resumed), and TO RUN (`python agents/<file>.py --port 8701`, env keys, `A2A_HOST`).
2. Imports and `.env` loading (two levels up from `agents/`).
3. `_make_llm` (unchanged block).
4. MCP registry + catalog restricted to this node's tools; MCP client; tool builder.
5. Skill blocks when the node has skills; playbook runtime when the node is a playbook.
6. `NODE = {...}`: the node's baked definition (same keys as the AGENTS/PLAYBOOKS entries today) preceded by the standard node comment block.
7. `AGENT_CARD`: `a2a.types.AgentCard` with `name`, `description` (first 300 chars of the instructions, or the playbook title and trigger), `version` (workflow id + generation date), `supported_interfaces` (JSON-RPC over HTTP at `http://<host>:<port>/`), `capabilities.streaming = True`, `default_input_modes/default_output_modes = ["text/plain"]`, one `AgentSkill` (`id = "node-<id>"`, `name`, `description`, `tags = [node type, provider]`).
8. `class NodeExecutor(AgentExecutor)`:
   - `execute(context, event_queue)`: if the incoming message belongs to a task waiting on a gate, resolve that gate's `asyncio.Future` with the message's data/text and return. Otherwise create a `TaskUpdater`, `submit()`/`start_work()`, run the node logic in a background asyncio task, and stream `working` status messages for each trace line. On completion `add_artifact` with the text (and, for a dispatcher, a data part `{"route": "<child id>", "notes": "..."}`; for a playbook, a data part `{"status": "resolved|failed|...", "events": [...]}`), then `complete()`.
   - Gate bridge: the playbook runtime's `_playbook_gate` is replaced in this file by `_a2a_gate(kind, name, args)`, which registers a Future under the task id, calls `updater.requires_input(message with a data part {"gate": kind, "tool": name, "args": args})`, awaits the Future (with `A2A_GATE_TIMEOUT_S`, default 900 s), then returns the same result shape the single-file gate returns.
   - `cancel(context, event_queue)`: cancels the background task and marks the task canceled.
9. `main()`: builds `DefaultRequestHandler(agent_executor, InMemoryTaskStore(), AGENT_CARD)`, mounts the JSON-RPC routes on a Starlette app (a2a-sdk 1.1 `a2a.server.routes.jsonrpc_routes`), serves with uvicorn on `--host`/`--port` (defaults `127.0.0.1` / `A2A_PORT` env / 8700), and prints `[agent <name>] serving http://host:port` once ready.

### 3.4 Orchestrator contents (top to bottom)

1. Module docstring: `"""A2A orchestrator for workflow <name>` + the standard documentation body (nodes marked with their agent file), an AGENT ENDPOINTS section (id, name, file, default URL, env override), an A2A RUN section (task per node, streaming, input-required handling, `--keep-serving`, `--no-spawn`), TO RUN.
2. Imports, `.env` loading (one level up), `from a2a.client import create_client, ClientConfig`.
3. `AGENTS = {nid: {"display", "file", "url", "type", "dispatch"}}` with the node comment block before each entry. `url` defaults to `http://127.0.0.1:<8701+index>` and is overridden by env `A2A_AGENT_<nid>_URL`.
4. `EDGES`, `ORDER`, `NODE_TYPES`, `START_DOCUMENTS`, `DEFAULT_PROMPT`, storage settings (as today).
5. `class AgentSupervisor`: `start()` spawns `python agents/<file>.py --port N` per agent (skipped with `--no-spawn` or when the URL is not local), polls `/.well-known/agent-card.json` until ready (timeout 60 s, then aborts with the agent's stderr tail), `stop()` terminates the children.
6. `_run_remote_node(nid, text)`: `create_client(url, ClientConfig(streaming=True))`, sends the context as one text message, iterates streamed events: `working` status messages are printed as trace lines; `input-required` triggers `_handle_gate(event)`: on a terminal, ask on the console; otherwise apply `PLAYBOOK_GATE_MODE` (auto/deny/prompt) as the single-file script does; the answer is sent as a follow-up message on the same task id and context id (`{"decision": ..., "comment": ..., "fields": {...}}` as a data part); `completed` yields the artifact text and data parts. Every gate is also printed as a structured line `[gate] {"task": ..., "kind": ..., "question": ...}` and its answer as `[gate-answer] {...}` so the app can render them later.
7. Graph: the same `WFState`, `build_context`, start node, output node and edge wiring as the single-file script. Agent nodes call `_run_remote_node`; a dispatcher node reads the `route` data part and writes `routes[n]`; a playbook node's output is the artifact text (the transcript), unchanged downstream.
8. `run()` and `__main__`: start supervisor, run graph, print output, save per storage setting, RUN SUMMARY with per-agent time, stop supervisor unless `--keep-serving`.

### 3.5 Runner

`langchain_runner/main.py::_resolve_script_path` accepts `<folder>/<file>.py` where `<folder>` is one plain path segment (no dots) directly under `SCRIPTS_DIR`; the subprocess `cwd` stays `INSTALL_ROOT` and the script's own `.env` resolution handles the depth. The change is copied to the installed runner with `python3 setup.py --force --skip-venv` (source/install split).

Dependencies added to the runner requirements: `a2a-sdk[http-server]>=1.1,<2`, `uvicorn` (already present), `httpx` (already present).

## 4. Frontend

- `workflow-editor.js`: `_showCodegenOptionsModal()` (form), `_codegenOptions(workflowId)` / `_saveCodegenOptions()` (localStorage), `downloadGeneratedPython()` gains the `a2a` flag: manifest branch writes the folder and files through the File System Access root (`python/scripts/<root>/agents/`), then opens `_showLangGraphCodeModal(savedPath, files)` where `files` is the manifest; the modal renders a file selector when given a list. `_runLangGraphScript()` sends `<root>/orchestrator.py` when A2A is on. `_generateAndWriteScript()` returns the orchestrator path in that case.
- New i18n keys (en/es/fr): `workflow.output.codegenTitle`, `workflow.output.codegenA2A`, `workflow.output.codegenA2AHelp`, `workflow.output.codegenGenerate`.
- Cache-buster bump for `workflow-editor.js`.

## 5. Documentation standard for the generated code

Applies to every emitted file (enforced by tests):

- Module docstring using `PythonEmitHelpers::workflowDocBlock` plus the A2A-specific sections listed in 3.3 and 3.4.
- Section banners (`# ====` + title + purpose lines) before every block: provider factory, MCP registry/catalog/client, tool builder, skills, playbook runtime, node definition, agent card, executor, gate bridge, server entry point (agents); supervisor, remote node runner, gate handler, state, graph wiring, CLI entry (orchestrator).
- `PythonEmitHelpers::nodeCommentBlock` before each `NODE = {` and each `AGENTS[...]` entry.
- A docstring on every emitted function and class stating what it does, what it receives, what it returns, and the failure behaviour.
- Inline comments where behaviour is non-obvious: port assignment, env overrides, gate timeout, why the run stays in memory while a gate waits, why agent files duplicate the shared blocks (self-containment).

## 6. Testing

PHP (`backend/tests/Unit/LangGraphA2AGeneratorTest.php`, SQLite fixture like the playbook test):

- Manifest shape: root name, `orchestrator.py` first, one `agents/<id>_<slug>.py` per agent and playbook node, none for start/output.
- Every file passes `python3 -m py_compile`.
- Agent file: card name, skill id `node-<id>`, the node's tools baked and no other node's, playbook file contains the playbook runtime and `_a2a_gate`, dispatcher file contains `route_to`.
- Orchestrator: `AGENTS` table with default URLs and env override names, `add_conditional_edges` for the dispatcher, `_run_remote_node`, gate handler, `--keep-serving` / `--no-spawn`.
- Documentation: each file has PROVENANCE/GRAPH NODES/.../TO RUN, the `<== this agent` marker in agent files, the AGENT ENDPOINTS section in the orchestrator, a node comment block before `NODE = {`.
- Single-file output unchanged with `a2a` off (existing `LangGraphGeneratorPlaybookTest` and `GeneratedDocParityTest` stay green).

Runner: unit test for `_resolve_script_path` accepting `folder/file.py` and refusing `../x.py`, `a/b/c.py`, `.hidden/x.py`.

Live: generate the Dispatcher demo with A2A ON, run `orchestrator.py` through the runner: three agents plus the playbook agent start, techBuddy routes to Human resources over A2A, IT claims and Devices management receive no task, the playbook agent raises `input-required` for the manager approval which auto mode answers, the transcript comes back as the artifact, RUN SUMMARY prints, agents stop.

## 7. Risks and decisions

- **a2a-sdk 1.1 API drift.** The server-side route classes moved between 0.2 and 1.x. The plan starts with a small SDK spike (a hand-written two-file agent + client) to pin the exact imports before the emitter is written; the emitted code targets what the spike proves.
- **Gates need a live process.** A gate waits in memory for its answer; if the orchestrator dies, the agent's task stays `input-required` until the timeout, then fails. Acceptable for this step; durable checkpointing is a follow-up.
- **Duplication in agent files.** Each agent file embeds the shared blocks (roughly 800 lines). Chosen deliberately so each agent is deployable alone; a `_common.py` variant can come later if size becomes a problem.
- **Ports.** Sequential local ports from 8701; a busy port aborts the run with a clear message naming the agent and port; `A2A_BASE_PORT` moves the range.
