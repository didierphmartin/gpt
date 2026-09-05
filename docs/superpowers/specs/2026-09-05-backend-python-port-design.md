# Backend Python Port — Umbrella Design

**Date:** 2026-09-05
**Status:** Approved design — phase plans follow
**Goal:** Build `gpt/backend_python` as a drop-in replacement for the PHP backend
(`gpt/backend`), reachable through the existing frontend backend switcher next to
`gpt/backend_typescript`. Same HTTP contract, same databases, same `.env`, same tokens.

---

## 1. Scope

**In scope:** everything the PHP backend does today.

- All 265 routes in `backend/src/routes.php`, with identical paths, methods, status
  codes, JSON envelopes, and SSE event sequences.
- Auth middleware (JWT + `uak_` app keys), CORS, PUBLIC_ROUTES allowlist.
- All 47 controllers (Quantis + AgentTeam), 7 LLM providers, tool/MCP loop, skills bridge,
  attachments, memory, usage logging.
- Agent-team engines: WorkflowRunner, GraphWorkflowRunner, ParallelAgentExecutor,
  AgentRunner, DispatchRouting, Playbook interpreter.
- Four code generators (LangGraph incl. A2A, ADK, MAF, NOOA) + PythonEmitHelpers,
  ingestion compiler/loader/splitter, VectorMcpStore.
- Scheduler cron script (`scheduler/run-scheduled-workflows.php`) and `scripts/` utilities.
- Ported PHPUnit tests (pytest) where they pin behavior; a differential test suite.
- Final phase: a third `python` kind in the backend switcher (gpt frontend + gpt_admin).

**Out of scope:** schema migrations (owned by PHP side), production deployment of the
Python service, new features, and fixing PHP quirks beyond those already in
`docs/backend-parity-tracker.md`.

## 2. Architecture

- **FastAPI + uvicorn**, Python 3.13, venv inside `backend_python/`. Runs in place from
  htdocs on **port 3002** locally (PHP: Apache same-origin; Node: 3001).
- **Layout mirrors the PHP tree one to one** (same class and method names) so the three
  backends read in parallel:

```
backend_python/
  main.py                 uvicorn entry: CORS → PHP-style body parse → auth → routes → 404
  app/routes.py           route table, same order/grouping as routes.php
  app/config.py           .env loader (same required-var check as load_env.php),
                          builds the same nested config dict as ai_config.php
  app/db.py               one pool per DB (main, contexts, login, video-editor),
                          dict rows, datetimes serialized 'YYYY-MM-DD HH:MM:SS'
  app/support/http.py     Ctx dataclass + controller→response wrapper
  app/support/sse.py      SSE writer (event/data framing, multi-line split, flush per event)
  app/support/phpjson.py  json_encode-compatible dumps (clean mode, see §3)
  app/support/logger.py   file logger mirroring stdout/stderr to logs/backend.log
  app/middleware/         CorsMiddleware, AuthMiddleware, MiddlewareProcessor (PUBLIC_ROUTES)
  app/controllers/        one module per PHP Controllers/*.php
  app/agent_team/         controllers/, models/, services/, functions/ as in PHP
  app/playbook/           interpreter package (adapters/ included)
  app/providers/          7 providers + ProviderRequestFactory + trait equivalents as mixins
  app/services/ app/functions/ app/models/ app/contracts/ app/exceptions/
  scheduler/run_scheduled_workflows.py
  scripts/
  tests/unit/ tests/differential/
  resources/              copied from ../backend/resources
```

## 3. Conventions

- **Request context.** `Ctx` carries `method, uri, headers, query, body, raw_body,
  user_id, auth_type, params, remote_addr` — the PHP `$request` array. Invalid JSON body
  → `{}`. Numeric route params cast to `int`, others stay `str`.
- **Controller contract.** Method receives `Ctx` (+ route params), returns a dict that IS
  the JSON body. Wrapper strips `status_code`/`content_type` and handles the four special
  shapes in `index.php`: `streaming_handled`, `content_type: text/html` (+`html`/`error`),
  `content_type: text/plain`, `raw_body` (+`headers`).
- **Envelopes.** 404 `{success:false,error:'Endpoint not found',uri}`, 405 with
  `allowed_methods`, 500 `{success:false,error:<message>}`, middleware 401 shapes verbatim.
- **Auth.** HS256 JWT, shared `JWT_SECRET`, same claims (`iss/iat/exp/sub/type`), same
  `uak_` app-key pepper derivation, same PUBLIC_ROUTES, fail-closed on empty secret.
- **Database.** Same four MySQL databases; controllers use the contexts DB exactly where PHP
  does (`contexts_database ?? database`). Raw parameterized SQL (no ORM) so queries port line
  for line. No runtime DDL: per the parity tracker, drop it when `schema/chatbot.sql`
  already has the table, otherwise add a migration `.sql` first.
- **JSON.** Clean encoding (no escaped slashes/unicode, shortest-repr floats), as the TS
  port does; PHP's defaults are cosmetic to every JSON consumer. Key order = PHP insertion
  order (dicts preserve it). The 37 `JSON_UNESCAPED_*` call sites get identical output.
- **Streaming.** Providers emit through an event callback as in PHP; SSE writer emits
  `event: X\ndata: <json>\n\n`, splits multi-line string data into one `data:` line each,
  sets `X-Accel-Buffering: no`, flushes per event. Progress strings and the double error
  event (raw + humanized) are byte-identical. Blocking provider clients run in a worker
  thread per request.
- **Parity policy.** Items marked 🪞 in `docs/backend-parity-tracker.md` are reproduced
  as-is. Fixes already applied to PHP are current truth. Every new deviation gets a tracker
  line before it ships.

## 4. Phases

Each phase = own spec (if non-trivial), own plan, own differential pass, own browser smoke.
Frontend-facing flows first.

| # | Scope | ~Routes | Depends on |
|---|-------|---------|-----------|
| 1 | Skeleton: config, pools, middleware, all auth routes + legacy action dispatcher, health, model catalog, prompts, contexts, providers list, package `me`, WebAuthn; minimal `python` switcher kind for local testing | 30 | — |
| 2 | Chat: `/chat`, `/agent`, `/verify`, `/compare`, upload, 7 providers, tool loop, MCPToolsLoader, SkillToolBridge, AttachmentDispatcher, memory, UsageLogger, traces, fetch-url | 12 | 1 |
| 3 | User surface: settings, usage, storage, heal, genesis, tools, MCP servers + overrides, MCP proxy/app, user memories, app-keys, voice, Drive | 60 | 1 |
| 4 | Agent-team data: agents, teams, workflows + schemas CRUD, node documents, outputs, executions, run events | 45 | 1 |
| 5 | Engines: WorkflowRunner, GraphWorkflowRunner, ParallelAgentExecutor, AgentRunner, DispatchRouting, Playbook interpreter, run-stream, tool-result bridge, agents MCP endpoint | 10 | 2, 4 |
| 6 | Generators: LangGraph (+A2A), ADK, MAF, NOOA, PythonEmitHelpers, ingestion compiler/loader/splitter, VectorMcpStore, ingestion endpoints | 15 | 4 |
| 7 | Back office: admin, system settings, login admin, video editor, affiliates, Hume tools, EVI webhook | 85 | 1 |
| 8 | Schedules + scheduler endpoints, cron script, `scripts/` utilities | 12 | 5 |
| 9 | Switcher: `python` kind in `frontend/assets/js/api-config.js`, `settings-panel.js`, and `gpt_admin/src/lib/backendConfig.ts`; port 3002 | 0 | 1 |

Phases 5 and 6 can run in parallel. Phase 7 is largest by lines, simplest per route.

## 5. Testing

1. **Unit (pytest, `tests/unit/`).** PHPUnit tests that pin behavior are ported in the phase
   where their subject lands. Generator tests become golden tests: Python output must equal
   PHP output byte for byte for the same workflow JSON (fixtures captured from PHP).
2. **Differential (pytest, `tests/differential/`).** Same request to
   `http://localhost/gpt/backend` and `http://localhost:3002` with a JWT minted from the
   shared secret (user 3). Compare: parsed-JSON equality for plain routes; SSE skeleton
   equality (consecutive identical events collapsed) for streaming routes. Every route gets
   ≥1 case in its phase: success + main error paths (missing field, wrong user, not found).
   Created data is deleted afterwards. Suite skips when PHP is unreachable.
3. **Browser smoke.** Frontend pointed at Python via the switcher; the phase's flows run
   end to end. This plus green differential tests is the phase acceptance gate.

## 6. Error handling and known deviations

- Unhandled exceptions → 500 envelope with the message, logged to `logs/backend.log`.
- Known deviations (all recorded in the parity tracker as they land): clean JSON encoding;
  no runtime DDL; document parsing via python-docx / openpyxl / python-pptx / pypdf in
  place of phpoffice / pdfparser, same extracted-text output shape; `subprocess` in place of
  `shell_exec`/`exec`/`proc_open` at the ten call sites.

## 7. Dependencies (initial)

fastapi, uvicorn[standard], httpx, PyMySQL (or mysqlclient), PyJWT, bcrypt, python-dotenv,
pydantic, python-docx, openpyxl, python-pptx, pypdf, markdownify (html→markdown),
feedparser (SimplePie), webauthn, pytest, pytest-asyncio. Added per phase as needed.
