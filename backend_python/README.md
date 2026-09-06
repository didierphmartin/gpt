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
search tools, session search, memory, usage logging — differential-tested against live PHP. Other
providers (openai, gemini, kimi, grok, deepseek, mistral) are pending Phase 2b; a non-Claude
`provider` currently yields the PHP "Provider 'x' not found" error path. `/api/v1/providers` and
Functions are pending Phase 2c; verify/compare, attachments, and the client-tool bridge are pending
Phase 2d. SSE frames are byte-identical to PHP's, and the stream is closed at the same point PHP
closes it via `fastcgi_finish_request`.
