# Backend Python Port — Phase 5 (Engines) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the execution engines so agents and workflows RUN on the Python backend exactly as on PHP: `AgentRunner` (+ delegation tools, `AgentToolsExecutor`), `WorkflowRunner` (legacy steps), `GraphWorkflowRunner` (graph workflows, parallel nodes, client-tool bridge, documents, traces, archive), `ParallelAgentExecutor`, `DispatchRouting`, `PromptTemplateProcessor`, the Playbook interpreter package, `PlaybookNodeRunner`, `WorkflowRunLog`; and the routes that drive them: `POST /agents/{id}/run`, `/agents/{id}/chat`, `/workflows/{id}/run`, `/workflows/run`, `/workflows/{id}/run-stream`, `/workflows/tool-result`, `/workflows/playbook-node/run`, `/playbooks/validate`, `/mcp/agents` (agents MCP endpoint).

**Architecture:** One Python module per PHP file under `app/agent_team/services/` and `app/playbook/` (mirroring `backend/src/Playbook/`), same class and camelCase method names. SSE run streams reuse the 2a bridge (`ctx['sse']`, `SseStream`); `StreamContext` (Phase 4) carries the event callback. Long-running server-side waits (`SkillToolBridge.awaitResult`, playbook gates) block the worker thread exactly as PHP blocks the request (memory `skill-workflows-need-browser`). Executions/run events are persisted in the same tables/files as PHP (`agent_executions`, `agent_workflow_executions`, `workflow_executions`, `execution_traces`, `WorkflowRunLog` dir) so both backends can read each other's history.

**Tech Stack:** Python 3.13, FastAPI, httpx, PyMySQL, pypdf (documents), pytest; PHP unit tests under `backend/tests/Unit/{AgentTeam,Playbook,Services}` are the oracles for pure logic (port their cases); live differential on user 3's existing workflows.

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 5 row; §3; §5). Memories that bind: `workflow-two-run-paths` (browser `_runNodeAsChatUnit` vs server `handleClientToolCall` — the server path is what we port), `dispatcher-node` (outgoing edges = choice menu, not fan-out), `workflow-lean-nodes` (node calls carry only declared tools/skill, memory=false), `never-override-agent-form-params`, `skill-workflows-need-browser`, `agents-unique-per-name`, `playbook-interpreter`.

## Global Constraints

- Everything from the Phase 1–4 plans' Global Constraints applies (PHP-semantics helpers, SQL byte-identical, no runtime DDL, `Db` API incl. transactions and `ensureDbConnection` → the 2a reconnect, by-path staging, commit trailer, never start/stop servers, PHP-first differential ordering, self-cleaning mutations).
- **Provider calls go through the ported providers** (`AIPortfolioAssistant`/`LLMManager` from 2a/2b): `AgentRunner.run/streamRun` build options exactly as PHP `buildOptions` (tools filter, `memory=false` for workflow nodes, `skill_metadata`, `client_tools`, `tool_choice`), so a node request on Python is byte-comparable to PHP's (the 2b differential harness can capture provider payloads via `MockTransport` in unit tests).
- **Event contracts verbatim:** every `emitNodeEvent`/`emitWorkflowEvent`/`StreamContext.emit*` name and payload key order as PHP; `runStream` SSE event names and the `complete` payload as PHP; `toolResult` writes through `SkillToolBridge.writeResult` (2d) with the same result dict.
- **Templates:** `PromptTemplateProcessor` placeholders (`{{date}}`, `{{time}}`, `{{user_name}}`, custom variables, timezone handling) formatted exactly as PHP in the user's timezone (`getTimezoneObject`) — `php_date` with the same format strings.
- **Parallel execution:** PHP `ParallelAgentExecutor`/`executeAgentsInParallel` fan out HTTP requests concurrently (curl_multi). Python uses a `ThreadPoolExecutor` per parallel round with the same ordering of results and the same `dispatchChunk` event interleaving rules (`runConcurrentRound` semantics: results collected per agent in agent order after the round completes — read PHP before deciding; document in the tracker).
- **Documents:** `readDocumentContent`/`extractPdfText`/`basicPdfTextExtract` use pypdf with the same fallbacks; universalFS → local path fallback (Phase 3/4 ruling).
- **Playbook package:** `backend/src/Playbook/*` → `app/playbook/*` (`PlaybookDocument`, `PlaybookAnalyzer`, `PlaybookRunState` (its own DB tables — check they exist live before porting; no DDL), `PlaybookActionSpace`, `GateManager`, `PlaybookNativeTools`, `PlaybookInterpreter`, `PlaybookTranscript`, `GateBridgeInterface`, `McpExecutorInterface`, `Adapters/{WorkflowLlmClient, LoaderMcpExecutor, SkillBridgeGateBridge}`); the PHP tests in `backend/tests/Unit/Playbook` are ported as the Python unit tests.
- **Differential (live, costs LLM calls — run ONCE):** user 3's smallest existing graph workflow (pick by node count from `workflow_nodes`; prefer the "Dispatcher demo" wf 44 if it has ≤ 4 nodes) run on both backends via `POST /workflows/{id}/run` (compare `success`, top-level keys, per-node output keys, execution row columns except timings/ids/text) and via `run-stream` (event skeleton via `same_stream` extended for the workflow event names). Agent run: `POST /agents/{id}/run` on user 3's simplest agent (compare keys + provider/model). Validation cases exact-compare (auth, missing id, app-key scope 403 text).
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```

## Porting rules

Phase 2b table + all later additions. Additions:

| PHP | Python |
|---|---|
| `curl_multi_*` fan-out | `concurrent.futures.ThreadPoolExecutor(max_workers=len(batch))` + `as_completed`/ordered `map` per the PHP result ordering |
| `set_time_limit(600)` | no-op comment (uvicorn has no per-request limit) |
| `register_shutdown_function` | `try/finally` at the same scope |
| `ignore_user_abort(true)` + streamed events | `SseStream` (abort raises at the next `send` — where PHP keeps running after abort, wrap `send` in the same `try/catch` PHP has) |
| `uniqid()`/`bin2hex(random_bytes(16))` run ids | `php_uniqid()` / `secrets.token_hex(16)` |
| `json_encode(..., JSON_PRETTY_PRINT)` in prompts | `json.dumps(v, indent=4, ensure_ascii=False)` with PHP's escaping (`phpjson.dumps_pretty` — add to `phpjson` if missing, mirroring PHP's 4-space pretty printer) |
| `mb_strlen/mb_substr` on prompt text | `len`/slicing (chars) |
| `strlen` on prompt text for limits | `len(s.encode('utf-8'))` |
| `array_column`, `array_filter`, `array_values`, `usort` | comprehensions, `sorted(key=...)` |

## Task format

Scaled (Phase 3 ruling): PHP line ranges, route rows, rulings, named unit cases (PHP-truth strings; port the PHP unit tests where they exist), exact differential requests.

---

### Task 1: `PromptTemplateProcessor` + `DispatchRouting` + `WorkflowRunLog`

**Files:** create `app/agent_team/services/prompt_template_processor.py`, `dispatch_routing.py`, `workflow_run_log.py` (if Phase 4 did not already create it — check; if present, only add the writer methods the runner needs); tests `tests/unit/test_prompt_template_processor.py`, `tests/unit/test_dispatch_routing.py`, `tests/unit/test_workflow_run_log.py`.

**Port:** `PromptTemplateProcessor.php` (214: `setContext`, `setTimezone`, `process`, `replacePlaceholder`, `formatDate`, `getTimezone`, `getTimezoneObject`, `getCustomVariable`, `getAvailablePlaceholders`, `hasPlaceholders`), `DispatchRouting.php` (169: `targets`, `toolDefinition`, `defaultInstructions`, `routedPrompt`, `routedBy`, `promptBlock`, `resolve`, `skipSet` — the dispatcher semantics from memory), `WorkflowRunLog.php` (all methods; same dir + file names as PHP).

**Unit cases:** port `backend/tests/Unit/AgentTeam/*PromptTemplate*` and `*DispatchRouting*` cases if present (list them); otherwise: each placeholder in a fixed timezone (`America/New_York`) with a frozen `now`; custom variable precedence; `hasPlaceholders`; `DispatchRouting.toolDefinition` exact dict for 3 targets; `resolve` picks by name/alias; `skipSet` excludes the unchosen edges; `WorkflowRunLog` write→read round-trip, `read` of an unknown run → `None`, path naming.

- [ ] Steps → commit `feat(py): PromptTemplateProcessor + DispatchRouting + WorkflowRunLog`.

---

### Task 2: `AgentDelegationFunctions` (full) + `AgentToolsExecutor` + `AgentRunner` + agent run routes

**Files:** modify `app/agent_team/functions/agent_delegation_functions.py` (constructor + handlers), create `app/agent_team/services/agent_tools_executor.py`, `app/agent_team/services/agent_runner.py`; modify `app/agent_team/controllers/agent_controller.py` (`run`, `chat` real implementations) and `app/routes.py` (`POST /api/v1/agents/{id:\d+}/run`, `POST /api/v1/agents/{id:\d+}/chat`); tests `tests/unit/test_agent_runner.py`, `tests/unit/test_agent_tools_executor.py`, `tests/differential/test_agent_run.py`.

**Port:** `AgentDelegationFunctions.php` (648: `delegateToAgent`, `listAvailableAgents`, `runAgentsParallel`, `completeTask`, `formatAgentInfo`, `extract*` context helpers), `AgentToolsExecutor.php` (205), `AgentRunner.php` (935: `run`, `setupFunctionExecutor`, `ensureSessionSearchRegistered`, `streamRun`, `getDelegationFunctions`, `buildToolsForAgent`, `buildOptions`, `buildMessages`, `createExecution`/`completeExecution`/`failExecution` (SQL byte-identical), `getFreshRepository`, `ensureDbConnection`, `getAvailableWorkers`, execution/stream context accessors, `getExecutionHistory`, `getExecution`, `getChildExecutions`, `createParallelExecutor` (Task 3 wires the class)); `AgentController::run/chat` (PHP 373–514: streaming through `StreamContext` + `ctx['sse']`).

**Unit cases:** `buildOptions` exact dict per agent kind (manager/worker/standard; tools filter; memory false; provider/model overrides — `never-override-agent-form-params`); `buildMessages` shape; `buildToolsForAgent` (MCP + delegation names); execution rows SQL/params; `run` happy path with a fake `LLMManager`; `streamRun` event sequence through a recording `StreamContext`; delegation: `delegateToAgent` permission branches (`canDelegateToAgent`), `listAvailableAgents` shape, `runAgentsParallel` validation; `AgentToolsExecutor.execute` routing (delegation vs base), `getToolDefinitions` merge order.

**Differential (user 3):** validation exact (`POST /agents/999999999/run`, unauthenticated, empty body); live: `POST /agents/{simplest agent id}/run {message: 'Reply with exactly: hello world'}` compare keys + `provider`/`model` + execution row created on both (then delete both rows by id).

- [ ] Steps → commit `feat(py): AgentRunner, delegation tools, AgentToolsExecutor; /agents run+chat`.

---

### Task 3: `WorkflowRunner` (steps) + `ParallelAgentExecutor`

**Files:** create `app/agent_team/services/workflow_runner.py`, `parallel_agent_executor.py`; tests `tests/unit/test_workflow_runner.py`, `tests/unit/test_parallel_agent_executor.py`.

**Port:** `WorkflowRunner.php` (414: `run`, `executeStep`, `executeAgentStep`, `executeConditionStep`, `executeTransformStep`, `evaluateCondition`, `combineOutputs`, `extractField`, `summarizeOutputs`, execution rows), `ParallelAgentExecutor.php` (423: `run`, `finalize`, `buildToolsFor`, `executeServerTool`, `runConcurrentRound` (thread pool), `callLLMs`, `dispatchChunk`, `buildAgentLLMRequestWithTools`, `parseParallelLLMResponse`, `getProviderConfigForParallel` — uses `ProviderRequestFactory` (2b) for raw HTTP requests).

**Unit cases:** condition evaluation matrix (all PHP operators), transform steps, `combineOutputs`/`extractField`/`summarizeOutputs`; parallel: `buildAgentLLMRequestWithTools` per family via the factory, `parseParallelLLMResponse` per family, `runConcurrentRound` with `MockTransport` handlers proving concurrency (timestamps overlap) and result ordering, `dispatchChunk` event order, server-tool execution loop.

- [ ] Steps → commit `feat(py): WorkflowRunner (steps) + ParallelAgentExecutor`.

---

### Task 4: Playbook package + `PlaybookNodeRunner` + `PlaybookController`

**Files:** create `app/playbook/__init__.py` + one module per PHP file (`playbook_document.py`, `playbook_analyzer.py`, `playbook_run_state.py`, `playbook_action_space.py`, `gate_manager.py`, `playbook_native_tools.py`, `playbook_interpreter.py`, `playbook_transcript.py`, `gate_bridge_interface.py`, `mcp_executor_interface.py`, `adapters/{workflow_llm_client,loader_mcp_executor,skill_bridge_gate_bridge}.py`), `app/agent_team/services/playbook_node_runner.py`, `app/controllers/playbook_controller.py`; modify `app/routes.py` (`POST /api/v1/playbooks/validate`); tests: port `backend/tests/Unit/Playbook/*` one-to-one into `tests/unit/playbook/`, plus `tests/unit/test_playbook_node_runner.py`, `tests/differential/test_playbooks.py`.

**Port:** all files in `backend/src/Playbook/` line by line; `PlaybookNodeRunner.php` (244); `PlaybookController.php` (106: `validate`, `makeLoader`, `loadAgentNames`). `PlaybookRunState` tables: check `SHOW TABLES` for the playbook run/ledger tables PHP uses (read `createRun`/`ledgerAppend` SQL) — no DDL.

**Unit cases:** the ported PHP Playbook tests (they are the oracle) + `PlaybookNodeRunner.run` with fake requester/mcp + `renderTranscript` exact text.

**Differential (user 3):** `POST /playbooks/validate` with a small console-text playbook body (copy the fixture the PHP test uses) → exact compare; validation errors exact.

- [ ] Steps → commit `feat(py): Playbook interpreter package + PlaybookNodeRunner + /playbooks/validate`.

---

### Task 5a: `GraphWorkflowRunner` — core

**Files:** create `app/agent_team/services/graph_workflow_runner.py`; tests `tests/unit/test_graph_workflow_runner_core.py`.

**Port:** `GraphWorkflowRunner.php` methods `__construct`, `setStreamContext`, `initTemplateProcessor`, `processPromptTemplate`, `getUserInfo`, `emitNodeEvent`, `nodeLog`, `emitWorkflowEvent`, `run` (251–632), `indexNodesById`, `applyRoute`, `getNextNodeIds`, `canExecuteNode`, `executeNode`, `executeAgentNode` (722–1058), `getProviderPricing`, `recordExecutionTrace` (→ `ExecutionTraceStore` 2d), `computeNodeCost`, `getBoundSkillScripts`, `buildRunSkillScriptTool`, `resolveOutputSchema`, `executeOutputNode`, `getInputForNode`, `buildContextForNode`, `applyMergeStrategy`, `formatNumberedInputs`/`formatXmlInputs`/`formatLabeledInputs`, `collectFinalOutput`, `createExecution`/`completeExecution`/`failExecution`, `ensureDbConnection`, `findAgentNodesInList`, `archiveRunToConversationContexts`, `buildArchiveOutput`, `pickMarkdownAgentOutput`, `isHtmlShaped`. The parallel/client-tool/document methods are stubs raising `NotImplementedError('Task 5b')` in this task.

**Unit cases:** port `backend/tests/Unit/AgentTeam/*Graph*Runner*` cases where they exist; else: `run` over a 3-node linear graph with a fake agent runner (events sequence exact, execution rows, final output), dispatcher node routing (`applyRoute`/`skipSet`), merge strategies (numbered/xml/labeled exact text), output node with a schema, trace recording params, archive output shaping, `computeNodeCost` with a pricing row.

- [ ] Steps → commit `feat(py): GraphWorkflowRunner core (sequential graphs, routing, outputs, traces, archive)`.

---

### Task 5b: `GraphWorkflowRunner` — parallel nodes, client-tool bridge, documents

**Files:** modify `app/agent_team/services/graph_workflow_runner.py`; tests `tests/unit/test_graph_workflow_runner_parallel.py`, `tests/unit/test_graph_workflow_runner_documents.py`.

**Port:** `runAgentWithClientToolBridge` (1231–1383: `SkillToolBridge` round-trip), `finalizeParallelNode`, `executeAgentsInParallel` (1811–2159), `getParallelExecutor`, `isClientSideToolName`, `emitClientToolCallInParallel`, `awaitClientToolResultInParallel`, `executeToolForParallel`, `buildToolsForParallelAgent`, `executeAgentsInParallelNoTools` (2298–2503), `buildAgentLLMRequest` (2504–2767), `parseAgentLLMResponse`, `buildDocumentsContext`, `getDocumentImages`, `readDocumentContent`, `readFileRaw`, `extractPdfText`, `basicPdfTextExtract`, `isImageFile`, `getDocumentStorageAdapter` (→ local fallback), `getUserStorageProvider`, `getDocumentLocalPath`.

**Unit cases:** parallel round with `MockTransport` per family (ordering + events), client-tool call → bridge wait → result injection (use a thread writing the result file), document context from a tmp local root with a pdf/txt/png fixture (exact text blocks), `buildAgentLLMRequest` per family vs `ProviderRequestFactory` output.

- [ ] Steps → commit `feat(py): GraphWorkflowRunner parallel nodes, client-tool bridge, documents`.

---

### Task 6: Workflow run routes + agents MCP endpoint

**Files:** modify `app/agent_team/controllers/workflow_controller.py` (`run`, `runByName`, `runStream`, `runPlaybookNode`, `toolResult` real implementations — PHP 719–1094), `app/routes.py` (`POST /api/v1/workflows/run`, `/workflows/{id:\d+}/run`, `/workflows/{id:\d+}/run-stream`, `/workflows/tool-result`, `/workflows/playbook-node/run`, `POST /api/v1/mcp/agents`); create `app/agent_team/controllers/agent_mcp_controller.py` (`AgentMCPController.php` 46–501: JSON-RPC `initialize`, `listAgents`, `getAgent`, `createAgent`, `updateAgent`, `deleteAgent`, `runAgent`, `listTools`, `callTool`, `jsonRpcSuccess/Error`); tests `tests/unit/test_workflow_run_routes.py`, `tests/unit/test_agent_mcp_controller.py`, `tests/differential/test_workflow_run.py`.

**Unit cases:** every validation/scope string (`Authentication required`, `Workflow ID is required`, `App key not authorized for this workflow (missing scope workflows:run)`), `runByName` lookup, `runStream` SSE event sequence with a fake runner (through `ctx['sse']`), `toolResult` validation + bridge write, `runPlaybookNode` validation + fake node runner; MCP endpoint: each JSON-RPC method's success/error envelope exactly (`jsonRpcError` codes/messages).

**Differential (user 3):** validation exact for all six routes (auth, missing id, bad body); live ONCE: `POST /workflows/{smallest wf id}/run {}` compare per the Global Constraints; `run-stream` skeleton; `POST /mcp/agents {jsonrpc:'2.0', id:1, method:'initialize'}` and `tools/list` exact.

- [ ] Steps → commit `feat(py): workflow run/run-stream/tool-result/playbook-node routes + agents MCP endpoint`.

---

### Task 7: Docs, verification, browser smoke

- README Phase 5 paragraph; tracker rows (parallel fan-out via threads, blocking bridge waits, no-DDL sites, run-log dir shared, any ruling).
- Verification: unit; Phase 5 differential (live once); `logs/backend.log` tracebacks.
- Browser smoke (controller): run user 3's smallest workflow from the editor on Python and watch the run overlay; run a skill workflow (browser Pyodide bridge round-trip).
- Commit `docs(py): Phase 5 status + parity rows`.

## Self-review notes

- **Spec coverage (umbrella §4 phase 5: WorkflowRunner, GraphWorkflowRunner, ParallelAgentExecutor, AgentRunner, DispatchRouting, Playbook interpreter, run-stream, tool-result bridge, agents MCP endpoint):** T1–T6 as mapped; `PlaybookController` (1 route) included in T4; `WorkflowRunLog` in T1.
- **Placeholders:** PHP-truth per the scaled-format ruling; PHP unit tests are ported as oracles where they exist.
- **Type consistency:** `StreamContext` (Phase 4), models/repositories (Phase 4), `ExecutionTraceStore`/`SkillToolBridge`/`SkillToolChoice` (2d), `ProviderRequestFactory` (2b), `AIPortfolioAssistant`/`LLMManager` (2a/2b), `SseStream` (2a).
