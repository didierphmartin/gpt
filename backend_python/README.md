# gpt backend — Python (FastAPI) port

Third implementation of the PHP backend (`../backend`) behind the same HTTP contract, next to
`../backend_typescript`. Same MySQL databases, same `.env` values, same `JWT_SECRET`, so tokens
interoperate across all three backends. Spec: `../docs/superpowers/specs/2026-09-05-backend-python-port-design.md`.

## Run
    python3.13 -m venv .venv && source .venv/bin/activate
    pip install -r requirements-dev.txt
    ./run.sh                      # uvicorn on http://localhost:3002 (reads ../backend/.env if no local .env)

Point the frontend at it: Settings → Account → Backend Connection → Python (admin only), or
`localStorage.setItem('BACKEND_KIND','python'); location.reload()`.

## Test
    pytest tests/unit -q                 # no external services
    pytest tests/differential -q         # needs Apache (PHP backend) + the DBs; skips cleanly otherwise
    DIFF_USER_ID=3 pytest -q             # differential user (default 3)

## Layout
Mirrors `../backend/src` one to one (class names, camelCase method names, raw SQL):
`main.py` (index.php) · `app/routes.py` (routes.php) · `app/middleware/` · `app/controllers/` ·
`app/agent_team/` · `app/services/` · `app/support/` (Ctx, renderer, dispatcher, PDO placeholder
shim, PHP compat helpers). `resources/model_catalog.json` is a copy of the PHP file — re-copy when it changes.

## Status
Phase 1 (2026-09): pipeline, auth (all actions, Firebase verify, SSO, app keys), model catalog,
prompts, contexts, packages, WebAuthn — differential-tested against live PHP. `ProviderController`
is deferred to Phase 2 (see the phase table in the spec). The differential suite runs against
user 3 by default (`DIFF_USER_ID`). Everything else: see the phase table in the spec.

Phase 2a (2026-09): the Claude chat path — streaming and regular `POST /api/v1/chat`, MCP tools,
search tools, session search, memory, usage logging — differential-tested against live PHP. The
other providers (openai, grok, kimi, deepseek, gemini, and the generic `CustomProvider`) landed in
Phase 2b, below; at the close of 2a a non-Claude `provider` still yielded the PHP "Provider 'x' not
found" error path. `/api/v1/providers` and Functions are pending Phase 2c; verify/compare,
attachments, and the client-tool bridge are pending Phase 2d. SSE frames are byte-identical to
PHP's, and the stream is closed at the same point PHP closes it via `fastcgi_finish_request`.

Phase 2b (2026-09): all seven chat providers — Claude, OpenAI, Grok, Kimi, DeepSeek, Gemini, and the
generic OpenAI-compatible `CustomProvider` for `system_llm_settings` rows without a dedicated class
(gamma4, glm) — plus `ProviderRequestFactory`. Every configured provider is differential-tested
against live PHP on both the streaming path (event skeleton, `response`/`complete` payloads) and the
non-streaming path (status, JSON key order, `usage` key set). Provider ERROR parity cannot be
FORCED differentially — the chat request body carries no `model` override, so neither backend can
be steered into a provider error without editing `system_llm_settings` — but it is asserted
opportunistically: the non-streaming case compares the HTTP status and the humanized `error` string
whenever a live provider happens to be rate limited or offline, and the humanizer's own branch
coverage lives in `tests/unit/test_humanize_provider_error_matrix.py` (tracker rows 59-60). Gemini
does not stream (single `chunk`), exactly like PHP. `/api/v1/providers` and the built-in Functions
remain pending Phase 2c.

Phase 2c (2026-09): `GET /api/v1/providers` (+ `POST /api/v1/providers`, `POST /api/v1/providers/switch`) with a
JSON-equal body to PHP (exact-JSON differential, user 3), so the frontend provider picker works on Python;
built-in `AnalysisFunctions` (FMP), `PortfolioFunctions` and `WatchlistFunctions` (registered by `setDatabase`,
used by the agent-team paths in Phase 5), and the delegation tool names (`AgentDelegationFunctions.getToolNames`;
handlers land in Phase 5). Verify/compare, attachments and the client-tool bridge remain pending Phase 2d.

Phase 2d (2026-09): the chat path is complete — `POST /api/v1/agent`, `/verify`, `/compare` (with the in-chat
verification/comparison phases), `/chat/upload` + document text extraction (pypdf / python-docx / openpyxl /
python-pptx) feeding the chat prefix, `/traces` + `GET /traces/diagnosis`, `POST /fetch-url`, and the file-based
`SkillToolBridge`/`SkillToolChoice` the workflow runner (Phase 5) uses. Live differential vs PHP: agent, verify,
compare, upload, traces diagnosis, fetch-url. Uploads land in the same `backend/storage/chat-uploads` tree PHP
uses. Phases 3–8 follow (see below).

Phase 3 (2026-09): the user surface — settings (keys, providers, usage, phone, storage, heal, genesis), usage,
user memories, app keys, heal, genesis, tools, MCP servers + per-user overrides, MCP proxy/app, local file
storage, voice, Drive: 13 controllers, 62 routes, each differential-tested against live PHP for user 3 with
self-cleaning round-trips (keys saved by one backend decrypt on the other). Non-local storage providers depend
on the PHP-only universalFS package and answer with PHP's "adapter unavailable" path; the voice ephemeral-token
live case is gated behind `DIFF_VOICE_TOKEN=1`. Phases 4–8 (agent-team data, engines, generators, back office,
schedules) follow.

Phase 4 (2026-09): agent-team data — models (`Agent`, `Team`, `Workflow`, `WorkflowSchema`) and their
repositories, `StreamContext`, `WorkflowOutputStorage` (local fallback; non-local providers still answer with
PHP's "adapter unavailable" path per Phase 3), and `WorkflowRunLog` (reads/writes the same
`backend/storage/workflow-runs/*.jsonl` directory PHP uses, shared across both backends). Four new route
blocks, each differential-tested against live PHP for user 3: teams (6 routes), workflow-schemas (5 routes),
agents (14 routes), workflows (15 routes — data, outputs, node documents only). `run`, `chat`, `run-stream`,
`tool-result`, `playbook-node`, and the `generate-python/adk/maf/nooa` code-gen routes are stubbed
(`NotImplementedError`) and not yet routed; they land in Phases 5/6 along with the Playbook-interpreter-backed
tool auto-derivation. One live-DB gap surfaced (not a port defect): `POST /workflow-schemas` 500s on both
backends because the live `workflow_schemas` table lacks the `strict` column `WorkflowSchemaRepository::create`
writes unconditionally.

Phase 5 (2026-09): the agent-team engines — `AgentRunner` + `AgentDelegationFunctions` + `AgentToolsExecutor`
(delegation, worker fan-out, tool routing), `WorkflowRunner` (step-based workflows), `ParallelAgentExecutor`
(thread-pool fan-out, `ThreadPoolExecutor` in place of PHP's `curl_multi`), `GraphWorkflowRunner` (sequential
and parallel node execution, the client-tool bridge that blocks the request thread on `run_skill_script` the
way PHP blocks Apache, and node-document upload/list/delete), the Playbook interpreter package (analyzer, gate
manager, action space, transcript, adapters) plus `PlaybookNodeRunner`, `PromptTemplateProcessor`, and
`DispatchRouting`. Nine new routes, each differential-tested against live PHP for user 3: `agents/{id}/run`,
`agents/{id}/chat`, `workflows/run`, `workflows/{id}/run`, `workflows/{id}/run-stream`,
`workflows/tool-result`, `workflows/playbook-node/run`, `playbooks/validate`, and `mcp/agents`
(full JSON-RPC surface: `agents/*`, `tools/*`, `initialize`). `chat()` and `run-stream` frame SSE as bare
`data: {json}\n\n` (no `event:` line), matching PHP's raw callback on those two endpoints specifically, while
`run-stream`'s and `playbook-node/run`'s own `if (!$userId)` branches are dead code on live PHP — the shared
auth middleware already rejects unauthenticated requests before either controller method runs — and are
ported anyway for fidelity. Full unit suite: 1817 passing. Phase 5 differential suite green against live PHP
(validation-parity plus one live LLM/agent/workflow/playbook run each, run once to avoid repeat spend).
One known defect carried forward: `GraphWorkflowRunner._createExecution` encodes an empty `input_variables`
body as JSON `"{}"` where PHP's untyped empty array encodes `"[]"`; fix pending in the Phase 5 final wave.

Phase 6 (2026-09): code generators + ingestion. `PythonEmitHelpers` (the literal nowdoc/heredoc blocks —
MCP client, skill deps/FS-sync, document-converter, workflow-doc/node-comment blocks — extracted
programmatically from the PHP source, never hand-transcribed) and `WorkflowGraphAnalyzer` (graph typing,
doc-node assembly, per-user MCP tool catalog) underpin all four generators: `LangGraphGenerator` (incl. A2A
compile mode — one orchestrator + one agent server per node — and the playbook runtime), `ADKGenerator`,
`MAFGenerator`, and `NOOAGenerator`. Byte-identical emission was verified with `php -r` oracles run against
the live PHP source (autoloading `backend/vendor/autoload.php`), a regenerated golden fixture
(`adk_diamond.golden.py` — the committed PHP golden was stale), and an all-workflows differential: user 3's
24 workflows × 4 generators × 3 modes (default JSON, `?download=1`, `?a2a=1` for `generate-python`), byte-equal
after normalising the `Generated: ...` docstring timestamp the same way PHP's own `GeneratedDocParityTest`
does. The four `generate-{python,adk,maf,nooa}` routes reuse this. The ingestion pipeline —
`IngestionCompiler`/`IngestionLoader`/`IngestionSplitter`/`VectorMcpStore` plus `IngestionController`'s 10
routes (compile/save-script/loader-text/splitter-chunks/store-chunks/store-find/run-stream/run-start/
run-worker/node-code) — talks to the langfs and vector-store MCP servers over HTTP exactly as PHP does
(session handshake, JSON-RPC field order, `CURLOPT_TIMEOUT`-equivalent `httpx` timeouts); its differential
suite gates real vector-DB writes behind `DIFF_INGESTION=1` pending a collection-isolation strategy, and
skips the langfs-backed loader/splitter cases when that MCP server isn't reachable. Policy set this phase:
stale PHP oracles (several fixtures predate current PHP — `PythonEmitHelpersPinTest`, `WorkflowGraphAnalyzerAnalyzeTest`,
`AdkGeneratorEmitTest`/its golden, `MafGeneratorEmitTest`, `test-ingestion-loader.php`) are pinned to LIVE PHP
behaviour, not the stale fixture; and PHP's `\w` under the `/u` modifier is Unicode-aware, so ASCII narrowing
only applies to patterns without `/u` (every generator regex qualifies). Full unit suite: 2705 passing. One
real bug caught and fixed by the all-workflows differential: `jsonToPython` rendered an empty dict as `{}`
where PHP's `json_encode([])` always emits `[]`, affecting `ADKGenerator`'s `NODE_NAMES` for every
zero-agent-node workflow.

Phase 7 (2026-09): the back office (`gpt_admin`) — seven admin-facing controllers, 88 routes:
`SystemSettingsController` (6), `AdminController` (34: users/providers/keys from Phase 3's Task 1/2
plus usage stats, MCP server management + per-user overrides, and costs/exchange-rates), `LoginAdminController`
(9, the centralized login DB's own user/app-role admin panel), `AffiliateController` (16, admin CRUD +
accounts/transactions/products + the affiliate's own `/me` self-service routes), `VideoEditorController`
(16, a second app's admin panel that shares the chatbot DB only for its own role gate),
`HumeToolController` (6) and `EVIWebhookController` (1, `POST /api/v1/evi/webhook`, PHP's only genuinely
public route among these seven). SECURITY finding, ported verbatim for parity (tracker row 10): PHP's
`AdminController` has NO admin-role gate at all — every `/api/v1/admin/*` method (including costs and MCP
admin) is reachable by any authenticated user; TS already documents and mirrors this, so PY does too.
The EVI webhook inherits a second PHP bug (tracker row 11): `handleWebhook` calls
`ToolsManager::getAvailableTools()`/`executeTool()`, neither of which exists, so any payload past its
`tool_name` check crashes into a 500 — TS deliberately implements the evident intent instead, but PY mirrors
the crash on purpose (a public, unauthenticated endpoint is the wrong place to guess at intended behavior).
`round()` half-tie divergence on real cost data got its own PHP-round helper (`_php_round`, tracker row 12,
same pattern as TS's `phpRound`). Apache's `serialize_precision=100` still leaks float noise into PHP's
JSON on `/admin/costs`/`/admin/usage/*` (tracker row 134); the differentials round both sides to 6 dp.
Cross-backend bcrypt login parity holds for the new affiliate accounts too (`AffiliateController::adminCreate`
is the actual bcrypt call site — the login-admin controller's `createUser` never writes a password column).
Full unit suite: 2690 passing. `gpt_admin`'s `py` backend kind is now served end-to-end — every panel it
calls (Users, LLM settings, MCP servers, Usage, Costs, Video Editor, Affiliates, Login-DB admin) has a
routed, differential-tested Python handler.

Phase 8 (2026-09): scheduled workflows — `ScheduledWorkflowService` (create/update/delete/pause/resume,
`getDueSchedules`, `markRunning`/`markCompleted`/`markFailed`, and a `calculateNextRun` that reproduces PHP's
`DateInterval` field arithmetic byte-for-byte, including month-end overflow and Europe/Berlin DST-gap
re-localization), plus `ScheduledWorkflowController` and `SchedulerController` wired into `app/routes.py`:
nine schedules routes (`index`, `create`, `show`, `update`, `destroy`, `pause`, `resume`, `stats`,
`byWorkflow`) and two scheduler routes (`run`, `status`). `POST /api/v1/scheduler/run` is public, gated by
either an authenticated user or the internal `X-Scheduler-Token` header/body token checked against
`config['scheduler']['token']` (`SCHEDULER_TOKEN` env var). The cron entry point,
`backend_python/scheduler/run_scheduled_workflows.py`, ports only the CLI branch of
`backend/scheduler/run-scheduled-workflows.php` (the HTTP branch is superseded by `SchedulerController::run`)
and is meant to be invoked as:

    * * * * * cd /path/to/backend_python && .venv/bin/python \
        -m scheduler.run_scheduled_workflows >> /var/log/workflow-scheduler.log 2>&1

Four standalone operational scripts were also ported: `scripts/firebase_auth_export.py` (read-only Firebase
export, `--write`/`--out`/`--help`), `scripts/migrate_skills_to_fs.py` (legacy `skills` table → folder-backed
skills), and `scripts/register_mock_okta.py` / `scripts/register_mock_stack.py` (idempotent mock-MCP-server
registration for the New Hire Provisioning playbook demo). Four PHP files were deliberately not ported —
`backend/scripts/test-ingestion-{compiler,loader,splitter}.php` and `test-vector-mcp-store.php` are plain-
assert CLI test harnesses, not application code; their coverage lives in the Phase 6 unit suite instead.
