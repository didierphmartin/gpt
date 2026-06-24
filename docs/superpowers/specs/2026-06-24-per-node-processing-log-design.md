# Per-Node Processing Log (Observability v2)

**Date:** 2026-06-24
**Component:** `backend/src/AgentTeam/Services/GraphWorkflowRunner.php`, `frontend/assets/js/workflow-editor.js`
**Branch:** `feat/rag-ingestion-full`
**Builds on:** `2026-06-24-workflow-node-observability-design.md` (the per-run JSONL + hydration pipeline this reuses)

## Problem

The node form's **Logs tab is empty even when a node errored or did real work.** Two reasons:

1. **The runner narrates to the wrong place.** The executor already logs every meaningful
   step (provider/model chosen, LLM responded, tool calls requested, skill start, bridge
   timeout, completion) via `error_log()` — but that goes to Apache's `error_log`, never to
   the node. The Logs tab only ever sees `node_start`, `client_tool_call`, and (since v1)
   `node_trace`. So there is no *processing feedback*, only a terminal skill dump.

2. **Per-node outcomes are emitted only at the very end.** In `executeAgentsInParallel`, a
   node's error/result is stashed in `$state` during the round loop, and `node_complete` /
   `recordExecutionTrace` (→ `node_trace`) are emitted **only in a final collection loop that
   runs after every node in the round finishes.** If the run hangs on a slow node or the user
   aborts before that loop, **nothing** is emitted for any node — including the errors most
   worth seeing. Confirmed in a real aborted run: the JSONL had `node_start ×7`,
   `client_tool_call ×2`, `node_complete ×1` (Start node only), `node_trace ×0`; the
   DeepSeek 400 and Gemini 503 computed mid-round were never surfaced.

## Goal

Turn the Logs tab into a **per-node activity timeline** — a chronological feed of what each
node is doing — that works **live** during a run and **on replay** of a past or aborted run,
for **both** the parallel and sequential executors.

## Non-goals

- No verbose per-round token/HTTP-status spam (the rejected "verbose" option).
- No new persistence layer or endpoint — reuses v1's `WorkflowRunLog` JSONL + events endpoint.
- No auto-interception of arbitrary `error_log()` strings (fragile parsing). Milestones are
  explicit calls.
- Existing `error_log()` calls stay (server-side debugging is not removed).

---

## Design

### Part A — `node_log` event + server helper

**A1. New event type `node_log`**, emitted through the existing `emitNodeEvent` chokepoint
(so it is automatically appended to `storage/workflow-runs/{runId}.jsonl` and streamed over
SSE — v1 already does both). Payload fields:

| field | type | notes |
|---|---|---|
| `node_id` | int | added by `emitNodeEvent` |
| `drawflow_id` | string\|null | added by `emitNodeEvent` |
| `ts` | float | `microtime(true)` (from `emitNodeEvent`'s `timestamp`) |
| `level` | string | `info` \| `warn` \| `error` |
| `phase` | string | `llm` \| `tool` \| `skill` \| `analysis` \| `done` \| `error` |
| `message` | string | human-readable line |
| `data` | object | optional, small — e.g. `{provider,model}`, `{exit_code,bytes}`, `{tokens,cost_usd}` |

**A2. Server helper** on `GraphWorkflowRunner`:

```php
private function nodeLog(array $node, string $level, string $phase, string $message, array $data = []): void
{
    error_log("[GraphWorkflowRunner] node {$node['id']} {$phase}: {$message}");
    $this->emitNodeEvent('node_log', $node, [
        'level'   => $level,
        'phase'   => $phase,
        'message' => $message,
        'data'    => $data,
    ]);
}
```

One helper, called at the milestones below. It never throws (delegates to `emitNodeEvent`,
which is already failure-tolerant).

### Part B — Standard milestones (both executors), ~6 per node

Emitted in **parallel** (`executeAgentsInParallel` / `makeParallelLLMCalls`) and **sequential**
(`runAgentNode` / `runAgentWithClientToolBridge`) paths:

| phase | level | when | message (example) | data |
|---|---|---|---|---|
| `llm` | info | before the provider call | `calling grok (grok-4-fast)` | `{provider,model}` |
| `llm` | info | after response parsed | `model requested run_skill_script` / `model responded with text` | — |
| `skill` | info | before the skill round-trip | `running skill GEO/geo-content` | `{dir_name}` |
| `skill` | info/error | after the bridge returns / times out | `skill finished (exit 0, 1240 bytes)` / `skill timed out after 300s` | `{exit_code,bytes}` |
| `analysis` | info | when re-calling the LLM after a tool result | `generating final analysis` | — |
| `done` / `error` | info/error | terminal | `completed (1840 tok, $0.0041)` / `HTTP 400 — Thinking mode does not support this tool_choice` | `{tokens,cost_usd}` / `{http,error}` |

Mapping to existing log points (so milestones land on real code): provider/model at
`GraphWorkflowRunner.php:1751/2068`; response parsed at `:1797/2033`; bridge emit/return in
`roundTripClientToolInParallel` (~`:2131`) and the sequential bridge (~`:1165`); bridge timeout
at `:2144/1174`; HTTP error at `:2009`; completion at `:1863/1911`.

### Part C — Immediate terminal emit (folds in the v1 buffering fix)

In `executeAgentsInParallel`'s round loop, the moment a node reaches a terminal state, emit
its outcome **right there** instead of deferring to the final collection loop:

- **Error branch** (`!$response['success']`): emit `node_log(error)`, then `node_complete`
  (`success:false`, `output:"Error: …"`) and a `node_trace` for that node; mark it emitted.
- **Clean completion** (no tool calls): emit `node_log(done)`, then `node_complete` +
  `node_trace`; mark it emitted.
- **Graceful exhaustion** (already added in v1, at `maxRounds`): same — emit there.

Track emitted nodes in a set (e.g. `$emitted[$nodeId] = true`). The **final collection loop
skips any node already emitted** — it still runs for nodes that somehow weren't (defensive),
and token accumulation moves to the emit site so it is counted exactly once.

Net effect: a node's error/result is persisted to the JSONL and streamed the instant it is
known, so a hung or aborted run still shows every finished node's outcome.

### Part D — Frontend Logs tab as a timeline

**D1. State.** Add `nodeExecutionData[id].activity = []`. Each `node_log` event →
`{ts, level, phase, message, data}` pushed onto it. Keyed by the same
`dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id` expression the
other handlers use (so live and hydrated data agree — same invariant as v1).

**D2. Two ingestion paths, identical mapping:**
- Live SSE handler: add a `case 'node_log':` that appends to `activity` and, if the node's
  form is open, refreshes the Logs tab.
- Hydration (`_applyRunEventToNodeData`): add a `node_log` branch that appends to `activity`
  (so replay of a past/aborted run rebuilds the timeline).

**D3. Rendering.** The Logs tab renders a **single chronological timeline**: `activity` lines
interleaved with the existing skill-execution entries (`logs[]`) sorted by timestamp, each
line color-coded by `level` (`error` red, `warn` amber, `info` default) with a small
phase/icon prefix. The existing status badge + error box remain at the top.

### Data flow

```
runner milestone ─ nodeLog() ─ error_log() (server)            (unchanged)
                            └─ emitNodeEvent('node_log') ─ JSONL append + SSE
node terminal (Part C) ─ node_log + node_complete + node_trace  (emitted immediately)

Frontend:
  live    → case 'node_log' → activity[]  → Logs-tab timeline
  replay  → GET /runs/{id}/events → _applyRunEventToNodeData → activity[] → timeline
```

## Components & responsibilities

| Unit | Responsibility | Depends on |
|---|---|---|
| `nodeLog()` (runner) | error_log + emit `node_log` | `emitNodeEvent` (v1) |
| Milestone calls (both executors) | narrate provider/skill/analysis/done | `nodeLog` |
| Immediate terminal emit (Part C) | persist node outcome when known | `emitNodeEvent`, `recordExecutionTrace` |
| `_applyRunEventToNodeData` + live `node_log` handler | append to `activity[]` | `nodeExecutionData` keying (v1) |
| Logs-tab timeline render | interleave activity + skill logs by ts | `activity[]`, `logs[]` |

## Error handling

- `nodeLog()` / `emitNodeEvent` never abort a run (already failure-tolerant in v1).
- Part C must not double-emit or double-count tokens: the `$emitted` set + moving token
  accumulation to the emit site guarantees exactly-once.
- Frontend: an unknown `phase`/`level` renders as a plain info line (no crash).

## Testing

PHP unit tests (no live LLM needed):
1. A small pure formatter for the milestone `data`/message (if extracted) — e.g.
   `done` line shows tokens + cost; `error` line shows the HTTP message.
2. Regression intent for Part C is verified by manual run (constructing the runner needs a
   live PDO, as in v1) — confirm via the JSONL that an **aborted** run still contains
   `node_complete`/`node_trace`/`node_log(error)` for nodes that errored before the abort.

Manual verification:
- Run GEO Parallel Audit; while it runs, open a node form and watch the Logs tab fill with
  the live timeline.
- Force an error (e.g. a provider that 400s); confirm the `error` line appears immediately
  and survives an abort (reload → reopen form → timeline still there, sourced from JSONL).
- Sequential workflow: confirm the same timeline appears.

## Risks

- Milestone messages duplicate some text already in `error_log` — acceptable (the helper
  intentionally writes both; server log stays the low-level record, node_log is the
  user-facing feed).
- Slightly larger JSONL per run (≈6 lines/node). Acceptable; retention remains the v1
  follow-up.
