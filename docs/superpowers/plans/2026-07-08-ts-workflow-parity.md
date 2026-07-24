# TypeScript Backend — Workflow Engine Full-Parity Plan

> Bring `backend_typescript/src/AgentTeam` to full parity with `backend/src/AgentTeam` (PHP). This is "finish the original port + catch up ~1 month of drift," executed phased across sessions with review. Detailed gap evidence lives in the three audit reports under `docs/superpowers/audits/` — implementers must read the relevant audit section + the PHP source for each task.

**Branch:** `feat/ts-workflow-parity` (from the current tree).

**Audits (read these for detail):**
- `docs/superpowers/audits/audit-graphworkflowrunner.md` — executor core (13 gaps)
- `docs/superpowers/audits/audit-runtime-support.md` — support files
- `docs/superpowers/audits/audit-generators.md` — Python generators

**Porting conventions:** PHP PDO → TS Kysely-style `db` (`backend_typescript/src/db/pools.ts`; raw `sql` tags for workflow tables, matching existing code). PHP `error_log()` → the TS logger used elsewhere in AgentTeam. PHP synchronous loops → `async/await`; PHP `curl_multi` parallelism → `Promise.all`. SSE emission follows the existing `StreamContext.ts` pattern. Every ported behavior is verified against the PHP source, not re-invented.

**Global verification:** after each task, `npx tsc --noEmit -p backend_typescript/tsconfig.json` must pass. Runtime tasks are verified against a real saved workflow (e.g. the GEO #31 workflow) via the TS backend on :3001. Generator tasks: emitted Python must `py_compile` and structurally match the PHP-emitted script for the same workflow.

---

## PHASE 1 — Runtime execution parity

Goal: workflows and skills **run correctly** on the TS backend, with durable run logs, output storage, and trace/telemetry. Do the never-ported foundations first — everything else sits on them.

### 1a. Foundations (never ported)
- **Task 1 — `SkillToolChoice`**: port `backend/src/AgentTeam/Services/SkillToolChoice.php` (trivial: provider-shaped `tool_choice` for `run_skill_script`) → `backend_typescript/src/AgentTeam/SkillToolChoice.ts`. Pure function, unit-testable.
- **Task 2 — `WorkflowRunLog`**: port `WorkflowRunLog.php` → `.ts` (per-run JSONL persistence "before SSE emit", `node_log`/`node_trace` record shapes, replay read). Add the `/workflows/runs/{id}/events` route + controller method. Wire the "persist before emit" into the executor's emit path.
- **Task 3 — `WorkflowOutputStorage`**: port `WorkflowOutputStorage.php` → `.ts` (disk persistence honoring the user's storage setting). Add the `/workflows/.../outputs` route(s) + controller. Wire the currently-stubbed call site in `GraphWorkflowRunner.ts`.

### 1b. Executor completion (`GraphWorkflowRunner.ts`)
- **Task 4 — Parallel tool-round loop (Critical)**: the parallel/fan-out path must run a real tool-round loop (up to 10 rounds), handle `pending_client_tool_call`, wire bound-skill `run_skill_script` (via `SkillToolChoice`, Task 1) with a forced first call, emit-all-then-await-all skill bridging, ~120s cap. Mirror PHP's `curl_multi` path semantics with `Promise.all`. See audit-graphworkflowrunner gap #1.
- **Task 5 — Timeouts + disabled-node + node_log**: sequential skill-bridge wait cap ~60s; parallel cap ~60s (configurable) and ~120s overall; disabled-node no-op (`config.disabled`) in both executors; `node_log` milestone events from both paths via a `nodeLog()` helper (logger + event).
- **Task 6 — Trace wiring**: call the already-ported `ExecutionTraceStore.ts` from `GraphWorkflowRunner.ts` (self-heal telemetry is currently blind); populate the `node_trace` skill fields (`skill_stdout`, `exit_code`, …) by reading `skillResultByNode` (currently hardcoded `null`). Complete `NodeLogFormat` (`modelRequestedTool`/`httpError`).

### 1c. Persistence / repo / context
- **Task 7 — `saveGraph` deadlock-retry**: add the 5×-with-backoff retry wrapper for transient InnoDB lock errors to `WorkflowRepository.ts`'s `saveGraph` (guard around the transaction).
- **Task 8 — Archival + documents context**: port `archiveRunToConversationContexts` + `SessionSearchService` (chat-sidebar / session-search archival) and implement `buildDocumentsContext` (currently a hard stub returning empty when documents are attached).

**Phase 1 exit:** run the GEO #31 workflow on the TS backend (sequential AND with a parallel fan-out that includes a skill-bound node) → correct output, durable JSONL run log, stored output, populated traces. `tsc --noEmit` clean.

---

## PHASE 2 — Python generators

Goal: `generate-langgraph` / `generate-adk` / `generate-maf` on the TS backend emit the same Python as PHP (must `py_compile`; structurally match PHP output for the same workflow).

- **Task 9 — Shared foundations**: complete `pyBlocks.ts` (shared Python-block emitters from `PythonEmitHelpers.php`, 535 LOC) and a shared `WorkflowGraphAnalyzer.ts` (topo order **with cycle detection** + `layers`), replacing the divergent inline `topoOrder` in `LangGraphGenerator.ts`.
- **Task 10 — LangGraph catch-up**: bring `LangGraphGenerator.ts` to parity — mandatory skill-step pipeline, Output-node storage toggle, inline `<!doctype html>…</html>` extraction on save, `_langgraph` filename suffix, verbatim max_tokens/temperature (serialize_precision-equivalent: emit `0.6` not `0.5999…`), Kimi K2 thinking-off + temp 0.6.
- **Task 11 — ADK generator (new)**: port `ADKGenerator.php` (963 LOC) → `ADKGenerator.ts`; wire `generate-adk` route + `WorkflowController.ts` method; readable run logs (NODE_NAMES, author mapping).
- **Task 12 — MAF generator (new)**: port `MAFGenerator.php` (628 LOC) → `MAFGenerator.ts`; wire `generate-maf` route + controller; fail-fast on skill errors, argv typed as `list[str]`, skill-step gets original request last, HTML extraction.

**Phase 2 exit:** for a fixed test workflow, all three TS generators emit Python that `py_compile`s and matches the PHP output (diff-reviewed).

---

## Sequencing note
Do Phase 1 fully before Phase 2 — the generators are self-contained string emitters and lower-risk, but correct *runtime* execution is what "workflows work on TS" actually means. Within Phase 1, 1a → 1b → 1c (foundations before the executor that uses them). Each task: port from PHP verbatim-in-behavior, `tsc --noEmit`, test, commit; review between tasks.
