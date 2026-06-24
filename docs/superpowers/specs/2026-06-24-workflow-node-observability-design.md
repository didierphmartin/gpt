# Workflow Node Observability + Parallel Skill-Tool Fix

**Date:** 2026-06-24
**Component:** `backend/src/AgentTeam/Services/GraphWorkflowRunner.php`, `backend/src/AgentTeam/Controllers/WorkflowController.php`, `backend/src/routes.php`, `frontend/assets/js/workflow-editor.js`
**Branch:** `feat/rag-ingestion-full`

## Problem

Running the "GEO Parallel Audit" workflow gets stuck: nodes glow orange (running) for a
while, then the run stops with **no results, and no input/output/logs in the node form** —
no way to debug what happened.

Two independent root causes were found.

### Cause 1 — Parallel fan-out never gives skill-bound nodes their tool

The graph runner has two executors:

- **Sequential** (`runAgentNode`, ~lines 816–860): for a node bound to a folder-backed
  skill it builds the `run_skill_script` tool (`buildRunSkillScriptTool`), passes it as
  `extra_tools`, and forces `tool_choice = run_skill_script` on the first turn.
- **Parallel** (`executeAgentsInParallel` / `buildToolsForParallelAgent`, ~lines 1706,
  2111): only returns **server** tools from `ToolsManager::getToolDefinitions()`. The
  per-skill **client** tool `run_skill_script` is never added, and there is no forced
  `tool_choice` and no `bound_skill` handling.

So in a parallel fan-out, a skill-bound agent is handed a tool list **without**
`run_skill_script`. The model is told (via its skill system prompt) to run the skill but
cannot. It keeps emitting empty tool-call rounds (`tool_calls=1, text_len=0`) until the
`maxRounds = 10` cap, then finishes with empty output and `success=false`.

Evidence from the captured 12–13 Jun runs:
- `Node 925 (grok, "Content E-E-A-T")` and `Node 927 (openai, "Platform Optimization")`
  loop `tool_calls=1, text_len=0` every ~2s.
- `Parallel round 9: 2 agents pending` — the cap was reached.
- Agent text: *"the `run_skill_script` function is not available in my current function
  registry."*
- No `client_tool_call` was ever emitted for 925/927 (they never reached the bridge).

### Cause 2 — Node run data is ephemeral; nothing is debuggable after the fact

- `emitNodeEvent` (line 168) and `emitWorkflowEvent` **only** push to SSE and
  `return` early when `streamContext` is null. They persist nothing.
- The frontend node form is fed **only** by live SSE into an in-memory map
  `nodeExecutionData`, which is **cleared on every `workflow_start`** and never re-fetched
  from the backend (`workflow-editor.js`: init ~line 40, clear ~line 9566, getters
  ~12238). There is no historical/persisted read path.
- `recordExecutionTrace` (line 955) does persist a DB trace row at **node end** with
  `skill_stdout` / `skill_log_messages` / `final_text` / `success`, but: (a) it omits the
  node **input**, (b) it only fires when a node finishes — a looping/crashing run records
  nothing, and (c) the frontend never reads it.

Net effect: if a run dies, loops, drops its SSE connection, or the editor is reopened, the
node form shows placeholders — **no input, no output, no logs, no means to debug.**

## Goals

1. Skill-bound nodes work in parallel fan-out (Cause 1).
2. Every node's input/output/logs are persisted server-side as the run happens, and the
   node form can read them back after the run — even a dead, looping, or disconnected run
   (Cause 2).

## Non-goals

- No new run-history browser UI (list of past runs, diffing). Readback targets the
  **current/last** run for a workflow.
- No changes to the provider `buildHttpRequest` interface.
- No change to the `maxRounds = 10` value.
- No migration of the existing `traceStore` schema beyond what is stated below.

---

## Design

### Part A — Per-run JSONL event log + readback

**A1. Persist-then-emit (single chokepoint).**
Reorder `emitNodeEvent` and `emitWorkflowEvent` so they **persist first, then emit to SSE
if a stream exists** (instead of returning early when `streamContext` is null):

1. Build the `$data` array exactly as today.
2. Append it as one JSON line to the run log file (A2).
3. `if ($this->streamContext) { $this->streamContext->emit($data); }`

This captures `node_start` (carries **input**), `node_complete` (carries **output**),
`client_tool_call`, `workflow_start/complete`, and every round — regardless of whether a
browser is attached or the run later dies.

**A2. Run log file.**
- Path: `backend/storage/workflow-runs/{runId}.jsonl` (`$this->runId`, set at line 221).
- Created on demand (`mkdir -p` the directory once per run; append with `FILE_APPEND | LOCK_EX`).
- One event per line: the full `$data` payload. JSONL matches the existing on-disk log
  style (e.g. `langchain_runner/ingestion.log`).
- A small helper `appendRunEvent(array $data): void` owns the path building and write,
  and swallows/logs its own I/O errors so logging never breaks a run.

**A3. Skill stdout/logs into the same log.**
Skill `stdout`/`log_messages` only reach the server inside `recordExecutionTrace`
(node end, via the Pyodide bridge). Add an emission there: after inserting the DB trace,
call `emitNodeEvent('node_trace', $node, [...])` carrying `skill_stdout`,
`skill_log_messages`, `final_text`, `success`, `error_text`, `exit_code`. Because
`emitNodeEvent` now persists (A1), this lands in the JSONL automatically and is also
streamed live. One record format; everything in one place.

**A4. Expose `run_id` to the client.**
Add `run_id => $this->runId` to the `workflow_start` payload (line 283). The frontend
stores it as `localStorage.lastRunId` (scoped per workflow id) on `workflow_start`.

**A5. Read endpoint.**
`GET /api/v1/workflows/runs/{runId}/events` → `WorkflowController::runEvents`.
- `runId` validated as 32-char hex (matches `bin2hex(random_bytes(16))`).
- Reads `backend/storage/workflow-runs/{runId}.jsonl`, returns
  `{ run_id, events: [ ... ] }` (one object per line). 404 if the file is absent.
- Auth: same middleware as other `/workflows` routes; the run file is only addressable by
  its unguessable 128-bit id.

**A6. Frontend readback / hydration.**
- `hydrateNodeDataFromRun(runId)`: `GET` the events, then **replay** them into
  `nodeExecutionData` using the same event→field mapping the live SSE handlers use
  (`node_start`→input, `node_complete`→output/tokens/cost/success, `client_tool_call` and
  `node_trace`→logs).
- Trigger: when a node form opens (`showAgentEditForm`) and
  `nodeExecutionData[nodeId]` is empty/missing, call `hydrateNodeDataFromRun(lastRunId)`
  (once per run id; cache the parsed result), then render.
- Live-run behavior is unchanged: live SSE still fills `nodeExecutionData` in real time;
  hydration only fills gaps when in-memory data is absent.

### Part B — Parallel skill-tool fix

**B1. Inject the client tool in the parallel init.**
In `executeAgentsInParallel`, after `$tools = $this->buildToolsForParallelAgent(...)`
(~line 1708), mirror the sequential path:

```php
$skillScripts = $this->getBoundSkillScripts($config);
$skillDirName = $config['bound_skill']['dir_name'] ?? null;
if (!empty($skillScripts) && is_string($skillDirName) && $skillDirName !== '') {
    $skillMeta = ['dir_name' => $skillDirName, 'scripts' => $skillScripts];
    $tools[] = $this->buildRunSkillScriptTool($skillMeta);
    // mark this agent so round 0 forces the skill call (B2)
    $forceSkill = true;
}
```

Store `'force_skill' => $forceSkill` in `$agentStates[$nodeId]`.

**B2. Force `tool_choice` on the first round — payload injection, no interface change.**
The parallel path builds requests via `ProviderRequestFactory`, which has no
`tool_choice` parameter. Instead, in `makeParallelLLMCalls`, after
`buildAgentLLMRequestWithTools` returns `$request`, if the agent still has
`force_skill` set **and** has not yet run its skill (`empty($state['skill_ran'])`),
inject the provider-appropriate `tool_choice` into `$request['payload']`:

- OpenAI / Grok / DeepSeek / Kimi: `['type' => 'function', 'function' => ['name' => 'run_skill_script']]`
- Claude/Anthropic: `['type' => 'tool', 'name' => 'run_skill_script']`
- Gemini: skip (uses its own `function_calling_config`); the skill system-prompt
  instruction is the soft fallback.

Once `skill_ran` is set (after the first successful round-trip), the force is dropped and
the existing run-once note (line 1786) prevents re-calling.

**B3. Graceful exhaustion.**
In the final collection loop (~line 1833), if an agent never reached `completed` (still
pending at `maxRounds`):
- set `output` to the last assistant text captured in `messages` (fallback to an explicit
  message: *"Agent did not finish within N tool rounds."*),
- set `success = false`,
- emit/record as usual.

This guarantees a stuck node reports *something* (visible in the form + JSONL), instead of
an empty result.

---

## Data flow (after change)

```
run() ─ runId set ─ emitWorkflowEvent(workflow_start{run_id})
                         │ persist→jsonl ; emit→SSE
node executes ─ emitNodeEvent(node_start{input})      → jsonl + SSE
            ─ (parallel) run_skill_script available ─ client_tool_call → jsonl + SSE
            ─ recordExecutionTrace ─ emitNodeEvent(node_trace{stdout,logs}) → jsonl + SSE
            ─ emitNodeEvent(node_complete{output})     → jsonl + SSE

Frontend:
  live   → SSE handlers fill nodeExecutionData (unchanged)
  reopen / dead run / dropped SSE
         → form opens, nodeExecutionData empty
         → GET /workflows/runs/{runId}/events → replay → nodeExecutionData → render
```

## Components & responsibilities

| Unit | Responsibility | Depends on |
|---|---|---|
| `appendRunEvent()` (runner) | Write one event line to `{runId}.jsonl` | `$this->runId`, filesystem |
| `emitNodeEvent` / `emitWorkflowEvent` | Persist-then-emit | `appendRunEvent`, `streamContext` |
| `node_trace` emission in `recordExecutionTrace` | Surface skill stdout/logs into the log | `emitNodeEvent`, `skillResultByNode` |
| Parallel init (B1) + `makeParallelLLMCalls` (B2) | Give fan-out skill nodes their tool + force first call | `getBoundSkillScripts`, `buildRunSkillScriptTool` |
| Exhaustion handling (B3) | Non-empty result for stuck nodes | — |
| `WorkflowController::runEvents` | Serve persisted run events | run log file, auth middleware |
| `hydrateNodeDataFromRun()` (frontend) | Replay persisted events into `nodeExecutionData` | read endpoint, existing SSE mapping |

## Error handling

- Log file I/O failures are caught and logged; they never abort a run or a request.
- Read endpoint: 404 when the file is missing, 400 on a malformed `runId`.
- Hydration fetch failure leaves the form on its existing placeholders (no crash).
- `mkdir`/append use `LOCK_EX`; concurrent parallel agents writing the same file are
  serialized by the lock.

## Testing

Repo to be checked for phpunit; tests that need **no live LLM**:

1. `appendRunEvent` / `emitNodeEvent` writes a JSONL line **even when `streamContext` is
   null** (the core inversion).
2. `WorkflowController::runEvents` round-trips: write N events → endpoint returns N parsed
   events; 404 on missing file; 400 on bad id.
3. Parallel init includes `run_skill_script` in the tool list when `bound_skill` is set,
   and omits it when not.
4. `makeParallelLLMCalls` payload contains the correct provider-shaped `tool_choice` on
   round 0 and drops it after `skill_ran`.

Manual verification: re-run "GEO Parallel Audit"; confirm 925/927 emit `client_tool_call`,
produce non-empty output, and that opening each node form after the run (and after a forced
reload) shows input, output, and skill logs sourced from the JSONL.

## Risks

- **Disk growth:** one JSONL per run accumulates. Out of scope to prune here; note for a
  follow-up retention/cleanup task.
- **Large payloads:** node input/output text is duplicated into the JSONL. Acceptable for
  debuggability; the file is per-run and local.
