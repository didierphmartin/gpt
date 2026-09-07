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
