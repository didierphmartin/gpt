# gpt backend — TypeScript/Node (Express) port

A reimplementation of the PHP backend (`../backend`) in TypeScript on Node.js, intended to be a
**drop-in replacement** behind the same HTTP contract. It connects to the **same MySQL databases**
and shares the **same `JWT_SECRET`**, so tokens issued by either backend verify on both and the two
can run side-by-side. The frontend switches between them by changing one value
(`assets/js/api-config.js` / `localStorage.API_BASE_URL`).

## Status — implemented & validated against the live PHP backend

| Endpoint | Notes |
|---|---|
| `GET /` | health |
| `GET /api/v1/models/catalog` | public; reads `resources/model_catalog.json` |
| `POST /api/v1/auth/login` | bcrypt verify, JWT issuance (HS256, claims `iss/iat/exp/sub/type`) |
| `POST /api/v1/auth/register` | validation order + `LEDGER_ACCOUNT_REQUIRED`, bcrypt hash, issues tokens |
| `POST /api/v1/auth/verify` | reads `Authorization` header |
| `POST /api/v1/auth/logout` | stateless |
| `POST /api/v1/auth/link-phone` · `upgrade-plan` | protected; `normalizePlan` / `roleForPlan` |
| `POST /api/v1/auth/firebase` | social login; **verifies the Firebase ID token server-side** |
| `POST /api/v1/auth` | legacy action dispatcher (all 12 actions) |
| app-key actions (via `/auth`) | `generate_app_key`/`revoke_app_key` (+ admin variants); per-user `uak_` keys |
| `GET/POST/PUT/DELETE /api/v1/prompts[/:id]` | full CRUD + nested `getTree`, scoped by `user_id` |
| `POST /api/v1/chat` | **streaming (SSE) + non-streaming**; **all 6 providers** (claude, openai, kimi, grok, deepseek, gemini); config from `system_llm_settings` |

**Auth middleware** implements JWT bearer **and** per-user `uak_` app keys (Bearer or AppKey scheme),
with the `PUBLIC_ROUTES` allowlist.

**Chat scope:** plain text, streaming + non-streaming. **All 6 providers ported** — Claude
(`anthropic`), the OpenAI-compatible family openai/kimi/grok/deepseek (`openai`), and **gemini**
(`gemini` — note: PHP's gemini doesn't truly stream; it sends the whole response as one `chunk`, and
this mirror does the same). Verified structure-identical against the live PHP `/chat` for every
provider, in both success and error states: progress strings verbatim (incl. per-provider labels
`"Claude: "` / `"OpenAI: "` / `"Grok: Connecting to xAI API..."` / `"Gemini: ..."`), the
`response→complete→response→complete` interleaving, the **double error event** (raw + humanized) with
a faithful `humanizeProviderError` port, normalized `input_tokens`/`output_tokens`/`function_calls`
usage, raw newline-split chunk text, and client-abort handling. (Chunk *counts* differ only by
non-deterministic streaming segmentation.)

**Tool/function-calling — Phases 1 & 2 done (Claude).**
- **Phase 1 — client-tool short-circuit:** when the model calls only client-side tools (webMCP
  `webmcp_*` from `client_tools`, or `run_skill_script`/`discover_skill`/`Task`), a `client_tool_call`
  SSE event is emitted plus `pending_client_tool_call`/`pending_tool_calls`; two-shot `role:'tool'`
  rehydration supported.
- **Phase 2 — server-tool recursive loop:** `Contracts/FunctionExecutor` + `Services/ToolsManager`
  (registry) + `Functions/SearchFunctions` (mirrors PHP `Functions/*`). ClaudeProvider runs the loop
  (`streamOneTurn` + `handleToolUseRecursive` logic, `maxRecursionDepth=10`): detect `tool_use` →
  `Processing tool calls` → `Executing function: X` → execute via the executor → `Processing Claude
  response` → streaming continuation → recurse. Event sequence verified **identical** to PHP. Ships
  ONE stub tool (`get_trending_assets`).

- **Phase 3 — MCP integration:** `Services/MCPToolsLoader` loads per-user tools from the DB
  (`mcp_servers` ⋈ `mcp_server_tools` with the `user_mcp_overrides` cascade), exposes them as
  `mcp_<tool>` definitions, and executes them over **JSON-RPC** (`tools/call`) to the remote server;
  `Services/CombinedToolsExecutor` routes MCP names to the loader and local names to `ToolsManager`,
  behind the same `FunctionExecutor` interface (so the loop is unchanged). The `mcp_ui` SSE event +
  large-data stripping are implemented. Validated against PHP for user 3: 44 tools loaded (correct
  dedup/prefix/schema), live JSON-RPC execution, and an end-to-end chat (`mcp_list_arxiv_categories`)
  with an **identical event sequence**. (The built-in Portfolio/Watchlist DB Functions are **not**
  ported — they're being moved to MCP servers.)

**Still not ported on the chat path:** the external-API SearchFunctions (real handlers; one stub
shipped), `mcp_ui` rendering details beyond the event, attachments, skills, verify/compare, memory,
usage logging, and the server-tool loop on the non-streaming path. Everything else from the PHP
backend (the other ~205 routes, agent-team engine, WebAuthn, voice, Drive, billing, document parsing)
is **not yet ported**.

## Architecture

- **Express** + TypeScript (no transpile-time framework magic).
- **mysql2** connection pools for both DBs (`DB_*` main, `CTX_DB_*` contexts); controllers use the
  **contexts** pool, matching PHP's `$config['contexts_database'] ?? $config['database']`.
- **Kysely** typed query builder over the existing schema. **No migrations are owned here** — the
  schema is managed exactly as today by the PHP side.
- `dateStrings: true` on the pools so timestamps serialize as `YYYY-MM-DD HH:MM:SS` (matches PHP).
- Controllers return a plain object that IS the JSON body (optional `status_code` stripped),
  mirroring the PHP controller + `index.php` dispatcher convention. Error/404/401 envelopes match.

**Class-based, mirroring the PHP structure** so the two codebases read in parallel (same class
names, same directories — navigate one, the other matches):

```
src/
  index.ts                       Express bootstrap (CORS → PHP-style body parse → auth → routes → 404)
  routes.ts                      route table (mirrors routes.php)
  Contracts/LLMProvider.ts       abstract provider base (system-prompt/text helpers) + types.ts (DTOs)
  Providers/                     ClaudeProvider, OpenAIProvider, GeminiProvider, ProviderFactory
  Controllers/                   AuthController, ModelCatalogController, PromptLibraryController, ChatController
  Middleware/                    CorsMiddleware, AuthMiddleware, MiddlewareProcessor
  Services/                      LLMProviderResolver (system_llm_settings), SseStream
  Support/Http.ts                request-context (Ctx) + controller→HTTP wrapper
  config/env.ts                  .env loader + validated config
  db/{types,pools}.ts            Kysely table types + mysql2 pools
resources/model_catalog.json     (copied from ../backend/resources)
```

## Run

```bash
cp .env.example .env      # then fill in — must match ../backend/.env (DB_*, CTX_DB_*, JWT_SECRET)
npm install
npm run dev               # tsx watch on http://localhost:3001
# or: npm run build && npm start
npm run typecheck         # tsc --noEmit
```

Point the frontend at it for the implemented flows:
```js
localStorage.setItem('API_BASE_URL', 'http://localhost:3001/api/v1'); location.reload();
```

## Parity validation (vs live PHP backend)

Same request sent to both backends, responses compared:

- `models/catalog`, `auth/login` (missing-field 400 + bad-cred 401), `auth/verify`, `prompts`
  (no-token 401; with-token empty; **`getTree` with real nested data, user 3**) — all **semantically
  identical** (`JSON.parse`→re-serialize equal on both sides).
- A JWT minted once with the shared secret verifies on **both** backends (`auth/verify` → same
  `user_id`) and returns identical `prompts` data — proving token interop + shared-DB parity.
- **Auth group (27 automated differential checks, all passing):** register validation byte-identical;
  register success shape + token issuance; **cross-backend app-key interop** — a `uak_` key minted by
  TS authenticates on PHP (Bearer) and a PHP-minted key authenticates on TS (AppKey), via the
  shared-secret-derived pepper; overwrite + revoke semantics; `upgrade_plan`/`link_phone` validation
  byte-identical; `normalizePlan` app-prefix stripping. Test user created via `register` and deleted
  afterwards (no residue in the DB).
- Two cosmetic, non-functional serialization differences from PHP `json_encode` defaults: full-
  precision floats in the catalog (`0.8000…` vs `0.8`) and a minor byte delta in prompt content.
  Both decode to identical values in any JSON parser (including the browser), so they do not affect
  the frontend.

## Security fix (deviation from original PHP, applied to BOTH backends)

- **`firebaseAuth` now verifies the Firebase ID token server-side.** The original PHP trusted
  client-supplied `userData` and never verified the `idToken` — an unauthenticated account-takeover.
  Both backends now verify the token's RS256 signature against Google's secure-token certs and bind
  `aud`/`iss` to the project (`FIREBASE_PROJECT_ID`, default `transledgersite`); identity comes from
  the **verified claims**. No service account needed (only the public projectId). Reject-parity
  tested: empty→400, garbage/forged/old-attack→401, byte-identical on both backends.

## Known gaps

- **Scoped `AppKey ak_…` keys** — deferred. These live in a separate `app_keys` table / repository
  with a distinct secret and a scopes model (the `/api/v1/app-keys` controller). The self-contained
  per-user `uak_` path IS implemented. A scoped key currently resolves to no identity (401 on
  protected routes), matching PHP when `app_key_secret` is unconfigured.
- `405 Method Not Allowed` is not specially emitted (unmatched method → 404), unlike FastRoute.
- `register`'s email validation uses a regex approximation of PHP `FILTER_VALIDATE_EMAIL` (matches in
  practice; exotic edge addresses could differ).
