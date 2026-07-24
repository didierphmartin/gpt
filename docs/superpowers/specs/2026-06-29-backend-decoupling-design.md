# Backend Decoupling — Single-Source URL + Frozen API Contract

**Date:** 2026-06-29
**Status:** Design — pending implementation plan
**Goal:** Decouple the `gpt` frontend from the PHP backend so the backend can be
reimplemented in another language (TypeScript, Java, Python) and swapped in by
changing a single configuration value, with no frontend code changes.

---

## 1. Problem

The frontend reaches the backend through hardcoded URLs scattered across ~25 JS
modules in `frontend/assets/js/`. Three inconsistent patterns coexist today:

1. **Hardcoded string literals** — `fetch('/gpt/backend/api/v1/prompts')` in ~17 files.
2. **Per-class bases** — `this.apiBaseUrl = '/gpt/backend/api/v1'` redefined in
   `auth.js`, `mcp-client.js`, `file-storage.js`, `settings-panel.js`, etc.
3. **A half-built, broken config hook** — a few modules read
   `window.CONFIG?.API_BASE_URL`, but `config.js` actually exposes
   `window.APP_CONFIG` (different global) and defines **no `API_BASE_URL` key at
   all**. Those reads always fall through to the hardcoded default.

Consequences:
- No single place to repoint the app at an alternate backend.
- No written definition of the API surface that an alternate backend must honor,
  so "swap the URL" would break the app in subtle, per-endpoint ways.

This is a no-build app (plain HTML + CDN `<script>` tags, no bundler), so the
solution must be **runtime** configuration, not compile-time injection.

## 2. Goal & Non-Goals

**In scope:**
- A single runtime source of truth for the backend base URL.
- Refactor all modules to read from it; zero `/gpt/backend` literals remain
  outside that one config file.
- A frozen, language-neutral **API contract** (OpenAPI + conventions doc) that
  any backend implementation must satisfy to be a valid drop-in.
- A **portable contract-test suite** that validates any backend against the
  contract, parameterized by base URL.

**Out of scope (YAGNI for now):**
- A full typed API-client layer that hides `fetch` from the app. We centralize
  the URL + a join helper but leave existing `fetch` calls in place.
- Hand-writing all 224 endpoint schemas upfront. Stubs are generated; schemas
  are filled frontend-first, long tail deferred.
- Changing auth/CORS mechanics. We only *document* the constraints.
- Actually building the TS/Java/Python backend. This design enables it; it does
  not deliver it.

## 3. Current State (verified on disk)

- Backend routes live in one machine-readable file: `backend/src/routes.php`
  (FastRoute), **224 routes** across **27 controllers**, all under `/api/v1/...`.
- Frontend config: `frontend/assets/js/config.js` (gitignored) exposes
  `window.APP_CONFIG` with voice/firebase keys — but no API base URL.
- The API is ~95% uniform REST (JSON in / JSON out, standard verbs). Three
  endpoint classes are **not** plain request/response and must be specified
  exactly (see §5).

## 4. Part A — Single-Source Base URL

### 4.1 New file: `frontend/assets/js/api-config.js`

Loaded **first** on every HTML entry page, before any module that calls the API.

```js
// Resolution order: explicit dev override → per-host map → relative default
(function () {
  const OVERRIDE = (function () {
    try { return localStorage.getItem('API_BASE_URL'); } catch (_) { return null; }
  })();

  const BY_HOST = {
    'localhost':         '/gpt/backend/api/v1',                 // PHP under XAMPP
    '127.0.0.1':         '/gpt/backend/api/v1',
    'synergyaichat.com': 'https://api.synergyaichat.com/v1',    // future alt backend
    // ...other deployment hosts
  };

  const base = OVERRIDE || BY_HOST[location.hostname] || '/gpt/backend/api/v1';

  window.APP_CONFIG = window.APP_CONFIG || {};
  window.APP_CONFIG.API_BASE_URL = base;

  // Join helper used everywhere instead of string concatenation.
  window.apiUrl = (path) => base + (path.startsWith('/') ? path : '/' + path);

  console.log('[api-config] backend base =', base);
})();
```

**Why this shape:**
- `base` is an opaque string, so **relative** (`/gpt/backend/api/v1`) and
  **absolute** (`https://host/v1`) both work with no code change — satisfying the
  "origin not decided yet" requirement.
- The per-host map gives painless prod/dev selection.
- The `localStorage` override gives one-line backend swapping for testing:
  `localStorage.API_BASE_URL = 'http://localhost:3000/v1'; location.reload();`
  → every call in the app redirects to the alternate backend.

### 4.2 Refactor (the "single place" payoff)

- `this.apiBaseUrl = '/gpt/backend/api/v1'` → `window.APP_CONFIG.API_BASE_URL` (~6 files)
- `fetch('/gpt/backend/api/v1/x')` → `fetch(window.apiUrl('/x'))` (~17 files)
- Fix broken `window.CONFIG?.API_BASE_URL` reads → `window.APP_CONFIG.API_BASE_URL` (~3 files)
- Add `<script src="assets/js/api-config.js">` ahead of other module scripts in
  every entry HTML (`index.html`, `login.html`, `register.html`, `payment.html`,
  test pages as needed).

**Success criterion (verifiable):** a repo-wide search finds **zero**
`/gpt/backend` string literals outside `api-config.js`.

### 4.3 Cross-origin caveats (documented, not solved here)

If a future backend runs on a different origin:
- **CORS** — each backend must allow the frontend origin and the auth header.
  (Ties into the pre-prod hardening note about replacing `CORS *`.)
- **Auth transport** — if auth uses cookies, cross-origin needs
  `SameSite=None; Secure`; otherwise standardize on a bearer token in the
  `Authorization` header (preferred for a language-neutral contract).

## 5. Part B — Frozen API Contract

The URL switch only works if the alternate backend is HTTP-identical. We capture
the PHP API as a language-neutral contract with three artifacts.

### 5.1 `backend/contract/openapi.yaml` (OpenAPI 3.1)

The document an alternate backend team implements against.

- **Bootstrap:** parse `routes.php` (224 machine-readable
  `$r->method('/path', [Controller, method])` lines) to auto-emit every
  path + method as a stub.
- **Fill frontend-first:** complete request/response schemas for the ~40
  endpoints the frontend actually calls; defer the long tail.
- Covers: paths, methods, request bodies, response schemas, status codes, and
  the security scheme (bearer token).

### 5.2 The three non-REST special cases (must be specified exactly)

These "work in Postman but break the UI" if reimplemented naively.

**(a) SSE streaming — `POST /api/v1/chat`, `/api/v1/compare`, `/api/v1/verify`**

`ChatController` emits `Content-Type: text/event-stream` with **named events**:

```
event: <name>
data: <json or text line>
data: <continuation line>

```

Required response headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`,
gzip/output-compression disabled. The frontend (`chat.js`) consumes the body via
`getReader()`.

Event vocabulary (verified):
- chat: `response`, `error`, `complete`
- compare: `compare_start`, `compare_chunk`, `compare_response`,
  `compare_complete`, `compare_error`
- verify: `verification_start`, `verifier_chunk`, `verification_response`,
  `verification_complete`, `verification_error`

The contract must freeze event names, framing, ordering, and the JSON schema of
each event's `data`. (OpenAPI describes these as `text/event-stream` responses;
the framing/ordering detail lives in CONVENTIONS.md and the contract tests.)

**(b) Legacy action-dispatch — `POST /api/v1/auth`**

One endpoint whose behavior is selected by a `body.action` field, coexisting with
the newer RESTful `/auth/login`, `/auth/register`, etc. Action enum (verified):
`login`, `register`, `firebase`, `verify`, `logout`, `link_phone`,
`unlink_phone`, `upgrade_plan`, `generate_app_key`, `revoke_app_key`,
`admin_generate_app_key`, `admin_revoke_app_key`. Unknown action → 400
`{ success:false, message:'Invalid action' }`. The contract documents this enum
(and flags it as deprecated-but-supported so a reimplementation ports it
faithfully or consciously drops it).

**(c) Multipart upload — `POST /api/v1/chat/upload`, workflow upload**

`multipart/form-data`, not JSON. Contract specifies field names, accepted types,
and size limits.

### 5.2.1 Protocol scope: REST + SSE only (no backend WebSocket)

The backend contract covers exactly two wire protocols:

| Protocol | Endpoints | Note |
|---|---|---|
| REST (JSON) | ~220 routes | Plain port. Includes the multipart upload and legacy action-RPC variants above. |
| SSE | `/chat`, `/compare`, `/verify` | Replicate event framing + vocabulary exactly (§5.2a). |

**WebSocket realtime voice is out of scope for the backend contract.** The
browser opens realtime sockets **directly to the providers** (verified:
`wss://api.hume.ai/v0/evi/chat`, `wss://api.x.ai/v1/realtime`) — the backend
never hosts a WebSocket the frontend connects to. The backend's only realtime
responsibility is minting a short-lived token via the REST endpoint
`POST /api/v1/voice/token`, which is already part of the REST surface. A
reimplementation must NOT stand up a WebSocket server.

### 5.3 `backend/contract/CONVENTIONS.md`

Cross-cutting rules an OpenAPI file captures poorly:
- Auth: header name, token format, who issues/validates.
- Error envelope shape and status-code conventions.
- The LLM invocation rule: `provider` is required on chat calls; no silent
  provider fallback (see existing project memory / LLM invocation contract).
- SSE framing/ordering guarantees (cross-reference §5.2a).
- Endpoints destined for the planned shared identity/commerce service, so a
  reimplementation does not entrench them in the wrong place.

### 5.4 Contract test suite

A **portable, base-URL-parameterized** suite that asserts any backend conforms:
- **Spec-driven core:** Schemathesis (or Dredd) runs the plain-REST endpoints
  against `openapi.yaml` with `--base-url <target>`.
- **Hand-written supplement** (Python, reusing the existing `langchain_runner`
  environment) for the cases spec tools handle poorly: SSE event
  framing/vocabulary, the legacy auth action enum, and multipart upload.
- Run green against PHP first (proves spec == reality). Run the *same suite*
  against the TS/Java/Python backend later (proves it is a valid drop-in).

This suite is the operational definition of "decoupled."

## 6. Data Flow (after change)

```
HTML page
  └─ loads api-config.js  → sets window.APP_CONFIG.API_BASE_URL + window.apiUrl()
  └─ loads feature modules → call window.apiUrl('/...') → fetch
                                   │
                                   ▼
                       base URL (relative or absolute)
                                   │
                ┌──────────────────┴───────────────────┐
            PHP backend                        alt backend (TS/Java/Python)
          (must pass contract tests)        (must pass the SAME contract tests)
```

## 7. Testing Strategy

- **Frontend refactor:** repo-wide grep asserts zero `/gpt/backend` literals
  outside `api-config.js`; smoke-test key flows (login, chat SSE, prompts CRUD,
  settings) against PHP with the relative base; then re-run with
  `localStorage.API_BASE_URL` pointed at a copy to confirm redirection.
- **Contract:** Schemathesis + supplement green against PHP. CI target: same
  suite must pass against any candidate backend before it can be swapped in.

## 8. Open Decisions (defaults chosen unless overridden)

| Decision | Default |
|---|---|
| URL resolution | Per-host map **plus** `localStorage` override |
| Backend origin | Designed for both (opaque string); CORS/auth documented, not changed |
| Contract-test runner | Schemathesis core + hand-written Python supplement for SSE/auth/upload |
| Contract completeness | Frontend-used endpoints first; long tail deferred |

## 9. Implementation Phases (for the plan)

1. Add `api-config.js`; wire it into entry HTML pages.
2. Refactor modules off hardcoded literals/per-class bases onto `window.apiUrl`.
   Verify zero remaining literals; smoke-test against PHP.
3. Generate OpenAPI stubs from `routes.php`; fill frontend-used endpoints +
   the three special cases.
4. Write CONVENTIONS.md.
5. Stand up the contract-test suite; get it green against PHP.
