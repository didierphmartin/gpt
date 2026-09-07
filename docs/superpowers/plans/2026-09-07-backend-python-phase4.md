# Backend Python Port — Phase 4 (Agent-team data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the agent-team DATA layer and its CRUD routes — agents, teams, workflows (+ graph nodes/edges), workflow schemas, node documents, workflow outputs, executions and run-event reads — with JSON-equal responses to PHP. Execution endpoints (`run`, `runByName`, `runStream`, `runPlaybookNode`, `toolResult`, `AgentController::run/chat`) and the code generators (`generate-*`) are Phase 5/6 and are registered there; in Phase 4 their routes are NOT added (the frontend shows the PHP-identical `Endpoint not found` for them until then).

**Architecture:** `app/agent_team/models/{agent,team,workflow,workflow_schema}.py`, `app/agent_team/services/{stream_context,agent_repository,team_repository,workflow_repository,workflow_schema_repository,workflow_graph_repository,workflow_output_storage}.py`, `app/agent_team/controllers/{agent,team,workflow,workflow_schema}_controller.py` — one Python module per PHP file, same class and camelCase method names, SQL byte-identical. Models mirror PHP's hydrate/toArray/toApiArray exactly (key order matters: the frontend and the differential compare the API arrays).

**Tech Stack:** Python 3.13, FastAPI, PyMySQL, pytest; differential against live PHP with self-cleaning round-trips.

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 4 row; §3 conventions; §5 testing).

## Global Constraints

- Everything from the Phase 1–3 plans' Global Constraints still applies (PHP-semantics helpers, SQL byte-identical, no runtime DDL, `Db` API, by-path staging, commit trailer, never start/stop servers, PHP-first differential ordering, self-cleaning mutations).
- **Tables (all exist live):** `agents`, `agent_teams`, `agent_workflows`, `workflow_nodes`, `workflow_edges`, `workflow_schemas`, `agent_executions`, `agent_workflow_executions`, `workflow_executions`, `users`. Any `CREATE TABLE IF NOT EXISTS` in the PHP repositories → no-DDL presence check + log (Phase 3 rule).
- **JSON columns:** PHP `json_decode($row['x'] ?? '[]', true)` → `json.loads` guarded (`None` on invalid → PHP falls back per site; copy each site); `json_encode` on write → `phpjson.dumps` (same flags as PHP at each site — check `JSON_UNESCAPED_UNICODE`/`SLASHES` per call).
- **Models:** `toArray()`/`toApiArray()` key order verbatim from PHP; getters/setters keep PHP names (`getId`, `setName`, …); `hydrate(row)` tolerant of missing keys exactly as PHP (`??` chains); `decodeJson` helper semantics per model.
- **Uniqueness rule (memory `agents-unique-per-name`):** `AgentRepository::create` updates the existing row for `(user_id, name)` instead of inserting a duplicate — port that exactly (PHP 312–360).
- **`WorkflowGraphRepository::saveGraph` retry** (`isTransientLockError`, `saveGraphOnce`): port the retry loop and the MySQL error-code test (`1205`/`1213`) — PyMySQL raises `pymysql.err.OperationalError` with `args[0]` = code.
- **Node documents / outputs:** `WorkflowOutputStorage` and `WorkflowController::uploadNodeDocument…` use universalFS for non-local providers → Python implements the `local` fallback paths fully (same directories as PHP: read `getLocalStoragePath`/`saveToLocalFallback` for the exact roots) and returns PHP's "adapter unavailable" responses otherwise (Phase 3 ruling).
- **Differential user:** user 3. Create/update/delete round-trips use names prefixed `differential-tmp-` and delete by returned id; assert list endpoints equal the pre-state afterwards on BOTH backends.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```

## Porting rules

Phase 2b table + 2c/2d/3 additions. Additions:

| PHP | Python |
|---|---|
| `new Agent($row)` / `Agent::fromArray` | `Agent(row)` / `Agent.fromArray(row)` (classmethod) |
| `$stmt->rowCount() > 0` | `db.execute(...) > 0` |
| `$this->db->beginTransaction()/commit()/rollBack()` | `db.begin()/commit()/rollback()` (Phase 2a `Db`) |
| `PDOException` `errorInfo[1]` | `pymysql.err.OperationalError.args[0]` |
| `array_map(fn($r) => (new Agent($r))->toApiArray(), $rows)` | `[Agent(r).toApiArray() for r in rows]` |
| `usort($a, fn($x,$y) => $x['display_order'] <=> $y['display_order'])` | `sorted(a, key=lambda x: x['display_order'])` (stable — note where PHP's instability could show) |
| `$_FILES['document']` | `request['files']['document']` |

## Task format

As Phase 3 (scaled): PHP line ranges, route rows, rulings, named unit cases with PHP-truth strings, exact differential requests.

---

### Task 1: Models + `StreamContext`

**Files:** create `app/agent_team/models/__init__.py`, `agent.py`, `team.py`, `workflow.py`, `workflow_schema.py`; `app/agent_team/services/stream_context.py`; tests `tests/unit/test_agent_team_models.py`, `tests/unit/test_stream_context.py`.

**Port:** `AgentTeam/Models/Agent.php` (486), `Team.php` (217), `Workflow.php` (415 — incl. `detectRuntimeMode`, `validateSteps`, `getStep`, `getDependentSteps`, `getEntrySteps`, `interpolateVariables`, graph accessors), `WorkflowSchema.php` (141 — incl. `toOutputSchema`, `validate`), `Services/StreamContext.php` (188 — `emit*` methods building the exact event dicts and calling the callback).

**Unit cases:** for each model: `hydrate` from a full row and from a minimal row (defaults per PHP), `toArray` and `toApiArray` exact key order and values (incl. JSON-decoded fields, bools, `null`s), each predicate (`isManager/isWorker/isStandard/canDelegateToAgent/isAccessibleBy`), `Workflow.validateSteps` error strings for each PHP branch, `interpolateVariables` cases, `WorkflowSchema.validate` branches + `toOutputSchema` shape; `StreamContext`: each `emit*` produces PHP's exact event dict and `isStreaming` semantics.

- [ ] Steps: failing tests → port → pass → full suite → commit `feat(py): agent-team models + StreamContext`.

---

### Task 2: Repositories

**Files:** create `app/agent_team/services/agent_repository.py`, `team_repository.py`, `workflow_repository.py`, `workflow_schema_repository.py`, `workflow_graph_repository.py`; tests `tests/unit/test_agent_team_repositories.py`.

**Port:** `AgentRepository.php` (760), `TeamRepository.php` (195), `WorkflowRepository.php` (254, incl. `getGraphRepository`), `WorkflowSchemaRepository.php` (112), `WorkflowGraphRepository.php` (524). Every SQL string byte-identical; transactions via `db.begin/commit/rollback`; the `saveGraph` retry.

**Unit cases (fake `Db` recording SQL+params, canned rows):** per repository, one test per public method asserting the SQL text (whitespace-normalized) and params; `AgentRepository.create` upsert-by-name path; `findAccessibleByUser` visibility SQL; `updateAgentOrder`/`moveAgentUp/Down` transaction + statements; `WorkflowGraphRepository.saveGraph` retries on a fake `OperationalError(1213, ...)` twice then succeeds, gives up after PHP's max attempts with the same exception; `getGraphForFrontend` shape; `validateGraph` error strings.

- [ ] Steps as Task 1; commit `feat(py): agent-team repositories`.

---

### Task 3: `WorkflowOutputStorage`

**Files:** create `app/agent_team/services/workflow_output_storage.py`; tests `tests/unit/test_workflow_output_storage.py`.

**Port:** `WorkflowOutputStorage.php` (478): `buildFullPath`, `saveOutput`, `listOutputs`, `getOutput`, `getWorkflow`, `getStorageConfig`, `generateFilename`, `sanitizeFilename`, `saveToStorage`/`listFromStorage`/`readFromStorage` (universalFS → unavailable path), `getUniversalFSClient` → `None` + log, `getUserUniversalFSApiKey` (guarded column read), `saveToLocalFallback`/`listFromLocalFallback`/`readFromLocalFallback` (exact roots, filename patterns, ordering).

**Unit cases:** `generateFilename` pattern (date/time in PHP tz), `sanitizeFilename` cases, local save/list/read round-trip in a tmp root with the exact metadata dict PHP returns, `getStorageConfig` SQL, unavailable-provider response.

- [ ] Steps as Task 1; commit `feat(py): WorkflowOutputStorage (local fallback)`.

---

### Task 4: `TeamController` + `WorkflowSchemaController` + routes

**Files:** create `app/agent_team/controllers/team_controller.py`, `workflow_schema_controller.py`; modify `app/routes.py` (`# TEAMS` rows PHP 340–345; `# WORKFLOW SCHEMAS` rows PHP 395–399); tests `tests/unit/test_team_schema_controllers.py`, `tests/differential/test_teams_schemas.py`.

**Port:** `TeamController.php` (373), `WorkflowSchemaController.php` (221).

**Unit cases:** every validation branch string (name required, not found, forbidden), `index`/`show` shapes via the repositories (fake Db rows), `agents(id)` shape.

**Differential (user 3):** `same()` on `GET /teams`, `GET /workflow-schemas`; round-trips: `POST /teams {name: 'differential-tmp-team'}` → `GET /teams/{id}` → `PUT` (description) → `GET /teams/{id}/agents` → `DELETE`; same for `POST /workflow-schemas {name, schema_json, strict}` → show → update → delete; `GET /teams/999999999` and `/workflow-schemas/999999999` not-found parity; lists equal pre-state after.

- [ ] Steps as Task 1; commit `feat(py): TeamController + WorkflowSchemaController`.

---

### Task 5: `AgentController` (CRUD, categories, ordering, tools, executions, duplicate)

**Files:** create `app/agent_team/controllers/agent_controller.py`; modify `app/routes.py` (`# AGENTS` rows PHP 408–424 EXCEPT `run` (419) and `chat` (420), which Phase 5 adds); tests `tests/unit/test_agent_controller.py`, `tests/differential/test_agents.py`.

**Port:** `AgentController.php` all methods except `run` and `chat` (leave two methods raising `NotImplementedError('Phase 5')` — not routed); `listTools` composes `AIPortfolioAssistant` + `MCPToolsLoader` like `ToolsController` (close in `finally`).

**Unit cases:** validation strings for create/update (name, provider, agent_type allowlist, delegation rules), visibility/ownership 403/404 strings, categories rename/delete SQL, reorder validation + repository calls, moveUp/moveDown, duplicate naming rule, `executions` shape, `listTools` shape.

**Differential (user 3):** `same()` on `GET /agents`, `/agents/tools`, `/agents/categories`; round-trip: `POST /agents {name: 'differential-tmp-agent', provider: 'claude', instructions: 'x', ...}` → `GET /agents/{id}` → `PUT` → `POST /agents/{id}/duplicate` → `DELETE` both → lists equal pre-state; not-found parity for `GET /agents/999999999`; `GET /agents/{id}/executions` on the created agent (empty) parity.

- [ ] Steps as Task 1; commit `feat(py): AgentController (data paths)`.

---

### Task 6: `WorkflowController` (CRUD, toggle, duplicate, executions, run events, outputs, node documents)

**Files:** create `app/agent_team/controllers/workflow_controller.py`, `app/agent_team/services/workflow_run_log.py` (port of `AgentTeam/Services/WorkflowRunLog.php`: `defaultDir(config)`, `read(runId)`, and the writer methods the runner uses — same directory and file naming as PHP so both backends read each other's run logs); modify `app/routes.py` (`# WORKFLOWS` rows PHP 348–350, 374–375, 381–384, 391–392, 402–405 in PHP order — NOT 351–354 generate-*, NOT 376–380 run*/toolResult); tests `tests/unit/test_workflow_controller.py`, `tests/differential/test_workflows.py`.

**Port:** `WorkflowController.php` methods `index`, `create`, `show`, `update`, `destroy`, `executions`, `runEvents`, `toggle`, `duplicate`, `listOutputs`, `getOutput`, `uploadNodeDocument`, `saveDocumentMetadata`, `listNodeDocuments`, `deleteNodeDocument`, and the private helpers `getUniversalFSAdapter` (→ `None`), `getUserStorageProvider`, `getUserStorageFolder`, `getLocalStoragePath`, `detectMimeType`, `guessMimeTypeFromExtension`, `isAllowedMimeType`, `sanitizeFilename`, `getUploadErrorMessage`; `generatePython/Adk/Maf/Nooa`, `run`, `runByName`, `runStream`, `runPlaybookNode`, `toolResult` are declared raising `NotImplementedError('Phase 5/6')` and not routed. `runEvents` reads whatever store PHP reads (file or table — copy exactly, incl. the `runId` regex route param).

**Unit cases:** create/update validation strings (name, steps/graph shape via `Workflow.validateSteps`/`validateGraph`), ownership 403/404, toggle/duplicate, executions shape, runEvents not-found, outputs list/read via a tmp local root, node document upload validation (mime allowlist, size, upload error messages verbatim), metadata save, list, delete.

**Differential (user 3):** `same()` on `GET /workflows`; round-trip: `POST /workflows {name: 'differential-tmp-wf', steps: [...]}` (copy a minimal valid steps/graph body from the frontend's create payload) → `GET /workflows/{id}` → `PUT` → `POST /workflows/{id}/toggle` ×2 → `POST /workflows/{id}/duplicate` → `GET /workflows/{id}/executions` → `GET /workflows/{id}/outputs` → `GET /workflows/{id}/nodes/1/documents` → `DELETE` both → list equals pre-state; `GET /workflows/runs/{32 zeros}/events` parity; not-found parity.

- [ ] Steps as Task 1; commit `feat(py): WorkflowController (data, outputs, node documents)`.

---

### Task 7: Docs, verification, browser smoke

- README Phase 4 paragraph (routes; run/generate pending 5/6); tracker rows (no-DDL sites, universalFS fallback, stable sort notes, any ruling).
- Verification: unit suite; Phase 4 differential files (no LLM calls); `logs/backend.log` tracebacks.
- Browser smoke (controller): Agent Teams panel lists agents/teams/workflows on Python; create + delete an agent through the UI.
- Commit `docs(py): Phase 4 status + parity rows`.

## Self-review notes

- **Spec coverage (umbrella §4 phase 4: agents, teams, workflows + schemas CRUD, node documents, outputs, executions, run events):** T1–T6 as mapped; 45 routes minus the 9 execution/generator routes deferred to Phases 5/6 (documented in the README/tracker).
- **Placeholders:** PHP-truth strings named per task per the scaled-format ruling.
- **Type consistency:** `Db` (Phase 1, `begin/commit/rollback` from 2a), `AIPortfolioAssistant`/`MCPToolsLoader` (2a/2c), `request['files']` (2a multipart), `php_date`.
