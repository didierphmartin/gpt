# Audit: AgentTeam runtime SUPPORT files — PHP → TypeScript porting gaps

Scope: `Services/{WorkflowRunner,SkillToolBridge,SkillToolChoice,WorkflowGraphRepository,WorkflowGraphAnalyzer,WorkflowRunLog,WorkflowOutputStorage}.php`
vs `backend_typescript/src/AgentTeam/{WorkflowRunner,SkillToolBridge,WorkflowRepository}.ts` (+ callers `GraphWorkflowRunner.ts`, `LangGraphGenerator.ts`, `WorkflowController.ts`).

PHP base: `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend/src/AgentTeam/Services/`
TS base: `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_typescript/src/AgentTeam/`

---

## 1. WorkflowRunner.php → WorkflowRunner.ts

**PHP responsibility**: Executes legacy STEP-based (non-graph) workflows — sequential/condition/transform steps resolved by `depends_on` dependency order. Fallback path when a workflow has no graph nodes; graph workflows go through `GraphWorkflowRunner` instead.

**TS status**: Present and largely faithful (`WorkflowRunner.ts`, 361 lines vs 414 PHP). Core `run()`, `executeStep`, `executeAgentStep`, `executeConditionStep`, `executeTransformStep`, `evaluateCondition`, `combineOutputs`, `extractField`, `summarizeOutputs`, `createExecution`, `completeExecution`, `failExecution` are all ported with matching semantics (including PHP loose `==`/`!=` condition comparisons and `empty()` semantics via `phpEmptyVal`).

**Gaps**:
- `public function getExecutionHistory(int $workflowId, int $limit = 50, int $offset = 0)` (PHP lines 403-413) has **no counterpart method on `WorkflowRunner.ts`**. It is NOT missing overall — it was relocated to `WorkflowRepository.getExecutionHistory()` in `WorkflowRepository.ts` (line 620), which is a faithful port (same SELECT, same `CAST(... AS CHAR)` trick to keep `input_variables`/`output` as raw JSON strings rather than mysql2 auto-parsed objects). No functional loss, but any caller expecting `WorkflowRunner.getExecutionHistory()` specifically (vs `WorkflowRepository`) will not find it — confirm all callers were updated to the new location.
- PHP constructor takes `array $config` (stored, never referenced elsewhere in the class — dead field). TS correctly drops it; not a gap.
- Architectural-only difference: PHP takes `PDO $db, AgentRepository, AgentRunner, array $config` via DI constructor; TS instantiates `AgentRepository`/`AgentRunner` as class fields with no constructor. Behaviorally equivalent for this class.

**Porting notes**: none further — this file is in good shape.

**DB dependencies**: `agent_workflow_executions` (workflow_id, user_id, input_variables, status, started_at, output, response_time_ms, completed_at, error_message). Accessed via raw `sql` tagged-template in TS (not through `db/types.ts` typed tables) — consistent with the rest of this porting slice; table has no `db/types.ts` entry, which is fine given the raw-SQL pattern already used throughout `WorkflowRepository.ts`.

---

## 2. SkillToolBridge.php → SkillToolBridge.ts

**PHP responsibility**: File-based (`/tmp`) rendezvous between the SSE-driven workflow run and the browser's Pyodide dispatcher for `run_skill_script` client-tool calls. Polls a `.result` file every 100ms up to a 5-minute timeout.

**TS status**: Present and intentionally re-architected, not gapped. Since the TS backend is a single long-lived Node process (vs one PHP process per request), `SkillToolBridge.ts` uses an in-memory `Map<toolCallId, resolver>` + `Promise`/`setTimeout` instead of file polling — documented in the file's header comment as a deliberate, cleaner equivalent. `generateToolCallId()`, `awaitResult()`, `writeResult()` all present with matching timeout default (300_000ms) and latest-write-wins semantics.

**Gaps**: none of substance. Only a semantic nuance: PHP's file-based approach could theoretically survive a process restart between `awaitResult` starting and the browser POSTing (it wouldn't, in practice, since PHP is one-process-per-request anyway); TS's in-memory Map would lose pending resolvers on a server restart. Not exploitable in the current single-worker deployment model — flag only if the Node process is expected to restart/scale horizontally under a pending workflow run.

**Cross-file**: consumed by `GraphWorkflowRunner.ts`, `WorkflowController.ts`, `SchedulerController.ts`, `IngestionController.ts`.

---

## 3. SkillToolChoice.php → MISSING in TS (small, but has a real consuming gap)

**PHP responsibility**: Pure value builder — `SkillToolChoice::forProvider(string $provider): ?array` returns the provider-shaped `tool_choice` payload that forces the model to call `run_skill_script`:
- `openai|grok|deepseek|kimi` → `['type' => 'function', 'function' => ['name' => 'run_skill_script']]`
- `claude|anthropic` → `['type' => 'tool', 'name' => 'run_skill_script']`
- anything else (e.g. gemini) → `null` (soft fallback to prompt instructions)

Used **only** in `GraphWorkflowRunner.php`'s parallel/fan-out path (`~line 2075`), where requests are built via `ProviderRequestFactory` and dispatched with raw `curl_multi`, bypassing each Provider class's own tool_choice translation — so the payload must already be in the correct provider-native shape. The **sequential** path (`runAgentNode`, PHP ~line 890-900) does NOT use this class; it sets the OpenAI-shaped `tool_choice` and relies on `ClaudeProvider`'s `nativeToolChoice()`-style translation.

**TS status**: Class not ported. **However**, the class alone would be unhelpful without its call site:
- TS's sequential path (`GraphWorkflowRunner.ts` line 622-638, `runAgentNode`) mirrors PHP correctly: sets the OpenAI-shaped `tool_choice` on `runContext`, and `ClaudeProvider.ts` (`nativeToolChoice()`, lines ~100, 246, 331) translates it to Claude's native shape — parity confirmed.
- TS's **parallel path** (`executeAgentsInParallel`, `GraphWorkflowRunner.ts` lines 940-1035+) is architected differently from PHP: it dispatches via `Promise.all` reusing `AgentRunner`/Provider objects (not raw `curl_multi` + `ProviderRequestFactory`), per the file's own header comment (lines 37-40). Because it goes through the same Provider classes as the sequential path, it does **not need** `SkillToolChoice::forProvider`'s per-provider branching — `ClaudeProvider` would translate a plain OpenAI-shaped `tool_choice` the same way it does for the sequential path.
- **Real gap**: TS's parallel path never wires the bound-skill/`run_skill_script` tool at all. `getBoundSkillScripts` / `buildRunSkillScriptTool` / any `tool_choice` forcing are only called from the sequential `runAgentNode` path (confirmed via grep — zero hits in `executeAgentsInParallel`). PHP's parallel path (`GraphWorkflowRunner.php` ~line 1848-1861) explicitly adds the skill tool and sets `$forceSkillFirstRound = true` specifically because, per its own comment, *"the sequential path does this in runAgentNode. Without it the agent has no way to run its skill in a fan-out and loops empty tool-call rounds to the cap."* This means: **a workflow with a folder-backed skill bound to an agent node that participates in implicit parallel fan-out will silently fail to expose `run_skill_script` in the TS backend**, not just miss the forced `tool_choice`.

**Porting notes for TS**:
1. Port `SkillToolChoice.forProvider(provider: string): Record<string, any> | null` as a small pure utility (trivial — 5-line switch) — needed only if/when the parallel path is rearchitected to bypass Provider translation (currently it doesn't need it).
2. The higher-value fix is in `GraphWorkflowRunner.ts`'s `executeAgentsInParallel`: port the bound-skill wiring (`getBoundSkillScripts`, `buildRunSkillScriptTool`, forced `tool_choice` on first round) that currently only exists in the sequential path. This is a `GraphWorkflowRunner.ts` gap, not a `SkillToolChoice.ts` gap per se, but the two are linked — note it even though `GraphWorkflowRunner.ts` itself is tracked in a separate (moderate-gap) audit.

---

## 4. WorkflowGraphRepository.php → MISSING as standalone file; **most methods ARE ported**, folded into `WorkflowRepository.ts`

**PHP responsibility**: CRUD for `workflow_nodes` / `workflow_edges` (the graph structure), plus `saveGraph()` transactional replace-all with a **deadlock retry wrapper**.

**TS status**: Not a separate file, but a `WorkflowGraphRepository` class is exported from `WorkflowRepository.ts` (lines 240-507) and covers most of the surface:

| PHP method | TS status |
|---|---|
| `findRealtimeWorkflowIds` | ✅ ported |
| `getNodes` | ✅ ported |
| `getNode` | ✅ ported |
| `updateNode` | ✅ ported |
| `getEdges` | ✅ ported |
| `getGraph` | ✅ ported |
| `getGraphForFrontend` | ✅ ported |
| `createNode` (private) | ✅ ported (private, trx-aware) |
| `createEdge` (private) | ✅ ported (private, trx-aware) |
| `clearGraph` (public) | ⚠️ inlined into `saveGraph`'s transaction only — no standalone public method |
| `saveGraph` | ⚠️ ported logic-wise (uses `db.transaction().execute()`), but **missing the retry-on-deadlock wrapper** — see below |
| `deleteNode` | ❌ not ported |
| `deleteEdge` | ❌ not ported |
| `findStartNode` | ✅ ported |
| `findOutputNodes` | ❌ not ported |
| `getOutgoingEdges` | ❌ not ported |
| `getIncomingEdges` | ❌ not ported |
| `getNextNodes` | ❌ not ported |
| `validateGraph` | ✅ ported (error strings match, including loose-`==` id comparisons via `phpIntval`) |

**Biggest gap — save-deadlock retry (as flagged)**: PHP's `saveGraph()` wraps `saveGraphOnce()` in a retry loop (`Services/WorkflowGraphRepository.php` lines 238-265): on `PDOException`, retries up to 5 attempts with `usleep(50000 * $attempt)` backoff (50/100/150/200ms) when `isTransientLockError()` matches SQLSTATE `40001`, MySQL error `1213` (deadlock) or `1205` (lock-wait timeout), or the message contains "deadlock"/"lock wait timeout". It also explicitly guards `rollBack()` with `inTransaction()` to avoid a rollback-without-transaction error. **TS's `saveGraph()` (`WorkflowRepository.ts` lines 470-506) has none of this** — it's a single `db.transaction().execute(async (trx) => {...})` call with no retry on transient lock errors. Concurrent saves of the same workflow (manual Save + a debounced auto-save, per the PHP comment) can deadlock on the `DELETE` + node `INSERT`s; in TS this will surface as an unhandled error to the caller instead of transparently retrying.

**Low-priority missing methods**: `deleteNode`, `deleteEdge`, `findOutputNodes`, `getOutgoingEdges`, `getIncomingEdges`, `getNextNodes`, standalone `clearGraph` are **not called anywhere in the PHP backend outside `WorkflowGraphRepository.php` itself** (verified via repo-wide grep — no controller or other service calls them). They appear to be dead/unused surface in PHP too. Low priority to port unless a future PHP change starts using them.

**Porting notes**:
- Add a retry wrapper around `WorkflowGraphRepository.saveGraph()` in TS: catch errors from `db.transaction().execute()`, inspect for MySQL error code `1213`/`1205` or SQLSTATE `40001` (mysql2/Kysely surfaces this as `err.code === 'ER_LOCK_DEADLOCK'` / `'ER_LOCK_WAIT_TIMEOUT'` or `err.errno === 1213/1205`), retry up to 5 attempts with the same 50ms×attempt backoff. Kysely's `db.transaction().execute()` already auto-rolls-back on throw, so the PHP `inTransaction()` guard has no TS analog to port (non-issue under Kysely's transaction model).

**DB dependencies**: `workflow_nodes` (id, workflow_id, node_type, agent_id, config JSON, pos_x, pos_y, drawflow_node_id), `workflow_edges` (id, workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr). Both accessed via raw `sql` tag, not declared in `db/types.ts` — consistent with existing pattern, not a blocker.

**Cross-file**: `GraphWorkflowRunner.php` only calls `findStartNode()` and `getGraph()` from this repository (verified via grep) — both already ported. So the graph *runner* itself is not blocked by the missing retry logic or the unported CRUD methods; the retry gap only bites the **editor's save endpoint**.

---

## 5. WorkflowGraphAnalyzer.php → MISSING as a standalone/shared module; logic **duplicated inline** in `LangGraphGenerator.ts`

**PHP responsibility**: Shared DSL-analysis front half for the workflow-to-code compilers (LangGraph, ADK, MAF generators — confirmed via grep, all three PHP generators call it). Two halves:
1. **Pure/static, DB-free**: `analyzeGraph(array $graph): array` — normalizes node/edge field aliases (`from`/`from_node_id`/`source`, etc.), builds `byId`, `children`/`parents` adjacency, Kahn's-algorithm topological `order` + `layers` (throws `RuntimeException` on cycle/disconnected graph), and finds `startNodeId`. Also `typeOf(array $node): string` (canonical type resolution: `node_type` → `type` → `config.type` → `'agent'`) and `skillsFromConfig(array $config): array` (bound-skill vs inline `skill_content` resolution).
2. **DB-backed instance**: `analyze(int $workflowId, ?string $userId): array` — loads the workflow + graph, builds an `agents` map (provider/model/tools/skills per agent node, with agent_id → DB tool fallback and provider-default model resolution from `system_llm_settings`), and builds a filtered MCP tool/server catalog (`usedCatalog`/`usedServers`) scoped to only the tools actually referenced by the workflow's agents.

**TS status**: No `WorkflowGraphAnalyzer.ts` file exists, and no shared module is called `analyzeGraph`. Instead, `LangGraphGenerator.ts` (the only PHP consumer of this class that has a TS port — `ADKGenerator.php`/`MAFGenerator.php` are not ported at all) reimplements the needed subset **inline**:
- `nodeType()`, `nodeId()`, `edgeFrom()`, `edgeTo()`, `children()` (lines 258-283) ≈ PHP's `typeOf` + edge-alias normalization.
- `topoOrder(startId, edges)` (lines 339-375) is a **different algorithm** from PHP's `analyzeGraph`: it's Kahn's algorithm restricted to nodes *reachable from `startId`* via a DFS/stack walk first, then in-degree-based topo sort over just that reachable set. It does **not** build `parents`, does **not** build `layers`, and does **not throw on a cycle** (a cycle would simply leave some reachable nodes with permanently nonzero in-degree, silently dropped from `order` — PHP throws `'Workflow graph has a cycle or disconnected node'`).
- `loadProviderDefaults()` (line 422) ≈ PHP's provider-default lookup from `system_llm_settings`.
- `loadMcpToolsWithServers()` (line 439) + inline `usedCatalog`/`usedServers` filtering (lines 501-625) ≈ PHP's `buildToolCatalog`.
- No equivalent of `skillsFromConfig()` was found by name in `LangGraphGenerator.ts` — worth confirming its bound-skill vs inline-skill resolution logic is still present under a different name if `LangGraphGenerator.ts` needs to be re-audited separately.

**Impact assessment**: Since `ADKGenerator.php` and `MAFGenerator.php` (the other two consumers of `WorkflowGraphAnalyzer`) are **not ported to TS at all**, and `LangGraphGenerator.ts` already has working (if divergently-implemented) equivalent logic, porting `WorkflowGraphAnalyzer.ts` as a shared module is **not currently blocking** anything. It becomes necessary only if/when ADK or MAF generator porting is undertaken (at which point sharing one analyzer avoids re-duplicating this logic a third time), or if `LangGraphGenerator.ts`'s divergent `topoOrder` (no cycle detection, no `layers`) is judged to be a correctness risk worth fixing by porting the real algorithm.

**Porting notes** (if/when undertaken): Port as pure functions `analyzeGraph(graph)`, `typeOf(node)`, `skillsFromConfig(config)` plus a `WorkflowGraphAnalyzer` class wrapping `analyze(workflowId, userId?)`. No controller currently instantiates it directly in PHP (confirmed via grep) — it's purely a service-to-service dependency of the three generators.

**DB dependencies**: `agent_workflows` (via `WorkflowRepository::findById`), `workflow_nodes`/`workflow_edges` (via `WorkflowGraphRepository::getGraph`), `system_llm_settings` (provider_key, model, enabled — **present** in `db/types.ts` as `SystemLlmSettingsTable`), `mcp_server_tools` joined to `mcp_servers` (**present** in `db/types.ts` as `McpServerToolsTable`/`McpServersTable`). No `db/types.ts` changes needed — all referenced tables/columns already exist there (already used by `LangGraphGenerator.ts`'s inline duplicate).

---

## 6. WorkflowRunLog.php → MISSING in TS; call site explicitly stubbed

**PHP responsibility**: Per-run append-only JSONL event log (`storage/workflow-runs/{runId}.jsonl`). `append(string $runId, array $event)` validates `runId` against `/^[a-f0-9]{32}$/`, then appends a JSON line with `FILE_APPEND | LOCK_EX` (creating the dir if needed); failures are swallowed and `error_log`'d, never thrown. `read(string $runId): ?array` re-parses all lines back into an event array (or `null` if the run doesn't exist / bad id). `defaultDir()` resolves to `backend/storage/workflow-runs` unless overridden by `$config['workflow_runs_dir']`. This is what makes a run's `node_log`/`node_trace` history durable and replayable after the run ends, the browser reloads, or the SSE connection drops — read back via `GET /api/v1/workflows/runs/{runId:[a-f0-9]{32}}/events` → `WorkflowController::runEvents`.

**TS status**: **Not ported at all.** `GraphWorkflowRunner.ts`'s own header comment says it plainly: *"WorkflowRunLog JSONL persistence: stubbed"* (line 30), and the event-emission helper comment reads *"delegates to StreamContext; stubs WorkflowRunLog persistence"* (line 181). `node_log`/`node_trace` SSE events are still emitted live during a run, but nothing writes them durably to disk. Consistent with this, `WorkflowController.ts` explicitly lists `runEvents` among endpoints marked *"DEFERRED (NOT ported / NOT routed)"* (lines 27-28) — the `/workflows/runs/{runId}/events` route itself doesn't exist in `routes.ts`.

**Net effect**: in the TS backend, if a workflow run's SSE stream drops (tab closed, network blip, browser reload), **the run's log history is unrecoverable** — no replay is possible, unlike PHP where the JSONL file survives independent of the SSE connection.

**Porting notes / public API to port**:
- `class WorkflowRunLog { constructor(baseDir: string); static defaultDir(config?): string; pathFor(runId): string; append(runId, event): Promise<void> | void; read(runId): Promise<any[] | null> | null }`
- Preserve: runId validation regex `^[a-f0-9]{32}$` (reject/no-op + log otherwise, never throw), append-only writes (Node: `fs.appendFile` with a lock/queue since Node lacks `LOCK_EX` — consider a per-runId write queue or `fs.appendFileSync` if write volume is low), JSONL parse-back on `read` skipping malformed lines, default dir resolution (`backend_typescript/storage/workflow-runs` equivalent, overridable via config).
- Wire into `GraphWorkflowRunner.ts`'s `emitNodeEvent`/`nodeLog`/`recordExecutionTrace` call sites (replacing the "stubbed" comments) so every SSE event is also durably appended.
- Route: add `GET /api/v1/workflows/runs/:runId([a-f0-9]{32})/events` → controller method reading via `WorkflowRunLog.read()`.
- No DB dependency — this is filesystem-only (`/tmp`-adjacent persistent storage dir, not `/tmp` itself).

---

## 7. WorkflowOutputStorage.php → MISSING in TS; call site explicitly stubbed

**PHP responsibility**: Persists a completed workflow's output to external/local storage (local disk, S3, Google Drive, OneDrive — via the separate `universalFS` PHP library at `/Applications/XAMPP/xamppfiles/htdocs/universalfs`). Public API:
- `saveOutput(int $workflowId, int $userId, array $output): array` — checks `agent_workflows.output_storage_enabled`, resolves storage config (workflow-specific `output_folder` overrides the user's global `users.storage_provider`/`storage_folder`), generates a sanitized filename `{WorkflowName}_{Y-m-d_H-i-s}.json`, writes JSON via `universalFS` (or a local-filesystem fallback under `storage/workflow_outputs/{userId}/...` if `universalFS`'s bootstrap/API key isn't available).
- `listOutputs(int $workflowId, int $userId): array` — lists files matching the sanitized workflow-name prefix, sorted newest-first.
- `getOutput(int $workflowId, int $userId, string $filename): array` — reads one file's content back.
- Routed via `GET /api/v1/workflows/{id}/outputs` and `GET /api/v1/workflows/{id}/outputs/{filename}` → `WorkflowController::listOutputs`/`getOutput`.

**TS status**: **Not ported at all.** `GraphWorkflowRunner.ts` header comment: *"WorkflowOutputStorage (disk writes): stubbed — workflow_complete.output/node_outputs still computed"* (line 27), and inline at the save call site: *"STUBBED: WorkflowOutputStorage.saveOutput (no disk write)"* (line 420). `WorkflowController.ts` lists `listOutputs`/`getOutput` among the explicitly deferred/unrouted endpoints (same block as `runEvents`, lines 27-28). The `Workflow` model in `WorkflowRepository.ts` DOES round-trip `outputStorageEnabled`/`outputFolder` through CRUD (`hydrateWorkflow`, `workflowToArray`, controller PATCH handling) — so the **settings** persist correctly, but toggling "save output" **does nothing** at runtime in TS.

**Porting notes / public API to port**:
- `class WorkflowOutputStorage { saveOutput(workflowId, userId, output): Promise<{success, filename?, path?, provider?, error?}>; listOutputs(workflowId, userId): Promise<{success, files, provider?, folder?, message?}>; getOutput(workflowId, userId, filename): Promise<{success, content?, filename, error?}> }`
- `universalFS` is a PHP-only library (`require_once $bootstrapPath`) — **there is no Node/TS equivalent available**. Decide scope before porting: (a) port only the local-filesystem fallback path (`saveToLocalFallback`/`listFromLocalFallback`/`readFromLocalFallback` — pure Node `fs` calls, straightforward), or (b) also need an S3/GDrive/OneDrive-capable TS storage abstraction if any user actually has `storage_provider != 'local'` configured. Check `users.storage_provider` distribution in production data before committing to (b) — recall the project's stated stack avoids AWS, so an S3-backed `universalFS` provider may not be in active use; confirm before treating it as required scope.
- Preserve filename sanitization exactly (`sanitizeFilename`: spaces→`_`, strip non `[a-zA-Z0-9_-]`, collapse repeated `_`, trim, default `'workflow'`) and the `Workflow_Name_2026-03-31_19-45-30.json` timestamp format, since existing files on disk must remain listable/gettable by the same pattern-match logic (`{sanitizedName}_` prefix).
- Root path convention: `synergyaichatroot/{user_folder}/{filename}` (`buildFullPath`) — preserve if any non-local provider is ported.
- Wire into `GraphWorkflowRunner.ts`'s stubbed save call site (line ~420) and add the two deferred routes.

**DB dependencies**: `agent_workflows` (id, name, user_id, output_storage_enabled, output_folder — already used elsewhere in `WorkflowRepository.ts`, no `db/types.ts` gap since accessed via raw `sql`), `users` (storage_provider, storage_folder — **present** in `db/types.ts` `UsersTable`, already typed). No `db/types.ts` changes required.

---

## Summary table

| File | TS status | Severity | Key blocking issue |
|---|---|---|---|
| WorkflowRunner.php | Ported, minor relocation | Trivial | `getExecutionHistory` lives on `WorkflowRepository` not `WorkflowRunner` — verify callers |
| SkillToolBridge.php | Ported (re-architected, justified) | None | — |
| SkillToolChoice.php | Missing (5-line util) | Low standalone / **Medium via linked gap** | Parallel-path skill-tool wiring itself missing in `GraphWorkflowRunner.ts`, not just this class |
| WorkflowGraphRepository.php | Mostly ported (in `WorkflowRepository.ts`) | **Medium** | `saveGraph()` missing 5x deadlock-retry-with-backoff wrapper |
| WorkflowGraphAnalyzer.php | Missing as shared module; logic duplicated inline in `LangGraphGenerator.ts` | Low (not currently blocking) | Only needed if ADK/MAF generators get ported, or to fix `LangGraphGenerator.ts`'s missing cycle detection |
| WorkflowRunLog.php | **Missing entirely**, stubbed call site | **High** | No durable run-log persistence; `/workflows/runs/{id}/events` route doesn't exist |
| WorkflowOutputStorage.php | **Missing entirely**, stubbed call site | **High** | "Save output" setting is a no-op at runtime; `/outputs` routes don't exist |

Biggest items to prioritize: (1) `WorkflowRunLog` + `WorkflowOutputStorage` — both fully missing with explicitly stubbed call sites and unrouted endpoints, representing real user-facing feature gaps; (2) `WorkflowGraphRepository.saveGraph()`'s deadlock-retry wrapper — a reliability fix for concurrent editor saves; (3) the parallel-path bound-skill wiring gap surfaced while investigating `SkillToolChoice` (lives in `GraphWorkflowRunner.ts`, tracked separately but noted here for the linkage).
