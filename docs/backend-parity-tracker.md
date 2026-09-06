# Backend Parity & Hardening Tracker

Tracks the suboptimal/quirky items found in the PHP backend (`gpt/backend`) and their status in
each backend. The TypeScript backend (`gpt/backend_typescript`) is a faithful mirror, so most items
are either **fixed in both** or **mirrored as-is** (deliberately replicating PHP). DB-schema changes
are written as `.sql` for the owner to run (migrations are applied manually).

**Legend:** ✅ done · ⬜ to do · ➖ N/A · 🪞 mirror as-is (no fix intended) · 🚫 won't do (decided) · 🧪 differential-tested vs live PHP

**Deployment context / threat model:** internal corporate access, behind authentication (not public
internet). This lowers the priority of anti-abuse hardening (e.g. login rate-limiting) but NOT of
correctness or authentication-integrity items (e.g. #1 token verification still matters).

Last updated: 2026-09-05

## A. Fixes (correct in BOTH backends)

| # | Item | PHP | TS | PY | Tested | Notes |
|---|------|-----|----|----|--------|-------|
| 1 | `firebaseAuth` verifies the Firebase ID token server-side (RS256 vs Google certs, aud/iss bound to projectId; identity from verified claims) | ✅ | ✅ | ✅ | 🧪 | Reject-parity tested (empty→400, garbage/forged/old-attack→401). Happy path needs real social-login check. New dep: reach `googleapis.com` for certs (cached 1h). |
| 2 | JWT secret fails closed (no weak `your-secret-key…` / empty fallback) | ✅ | ✅ | ✅ | 🧪 | PHP: throw if `JWT_SECRET` empty in `AuthController`, `WebAuthnController`, `MiddlewareProcessor`. TS: already fails closed via `required('JWT_SECRET')`. Verified normal boot/auth unaffected. |
| 4 | Public `/api/v1/auth` dispatcher gates protected actions centrally | ✅ | ✅ | ✅ | 🧪 | `handleAction` rejects link/unlink_phone, upgrade_plan, *_app_key with 401 when unauthenticated (defense-in-depth; methods already self-checked, so responses unchanged). Parity confirmed byte-identical. |
| 3 | Login rate-limiting / lockout | 🚫 | 🚫 | 🚫 | — | **Won't do for now (2026-06-30).** Target is internal corporate access behind authentication, so brute-force exposure is low. Revisit if the backend is exposed to the public internet. |
| 7 | Remove runtime DDL from `AuthController` (`ensureUserSubscriptionColumns`) | ✅ | ➖ | ➖ | 🧪 | Columns confirmed present in live DB → method + constructor call deleted; no migration needed. TS never did this. Live auth smoke OK. |
| 7b | Same runtime-DDL pattern in 11 other PHP files (MCP, memory repos, traces, file storage, admin, settings, heal) | ⬜ | ➖ | ⬜ | — | NOT yet ported to TS. Handle per-file when porting: if the table/columns are already in `schema/chatbot.sql` → delete the runtime DDL; if the runtime `CREATE TABLE IF NOT EXISTS` is the ONLY creator → add it to the schema (migration) first, then delete. Do NOT blind-delete. |
| 8 | `prompt_library.user_id` `varchar(255)` → integer to match JWT id | ✅ | ✅ | ✅ | 🧪 | Migration `schema/migrations/2026-06-30_prompt_library_user_id_to_int.sql` **applied** (column now `int NOT NULL`). PHP already bound the int natively (no change). TS: typed `user_id` as `number`, dropped `String()` casts. getTree parity re-confirmed. FK still optional (1 orphan row to resolve first). |
| 5 | Pre-prod hardening: CORS `*`, shared JWT secret, browser-shipped voice keys | ⬜ | ⬜ | ⬜ | — | Already on the separate pre-prod hardening checklist; cross-listed here. |

## B. Mirror as-is (replicate PHP — no fix intended unless re-prioritized)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6 | `firebaseAuth` writes arbitrary `provider` into an enum column | 🪞 | Both store the request `provider` as PHP does. Revisit only if #8-style schema cleanup happens. |
| 9 | Single inline per-user app key; regen silently invalidates old | 🪞 | Mirrored; matches PHP `users.app_key_*` semantics. |
| 10 | `getTree` loose `==` parent match, drops orphans | 🪞 | TS reproduces the same tree-building (orphans dropped). |
| 11 | Inconsistent messages ("Invalid or expired credential" vs "…token") | 🪞 | Mirrored verbatim. |
| 12 | Duplicate call paths (RESTful routes shadowed by action dispatcher) | 🪞 | Both supported, as in PHP. |
| 13 | Controllers only ever use the contexts DB | 🪞 | TS uses the contexts pool for controllers, same as PHP. |
| 14 | Body parsed unconditionally; invalid JSON → `{}` | 🪞 | TS body parser mirrors `json_decode(...) ?? []`. |
| 15 | register returns 200 (not 201); response timestamps are wall-clock | 🪞 | Mirrored. |
| 16 | `firebaseAuth` synthesizes `<phone>@phone.auth` emails | 🪞 | Mirrored (now from the verified phone claim). |
| 17 | Controller "response" array mixes transport keys with body | 🪞 | TS `handle()` replicates the convention. |
| 18 | `json_encode` full-precision floats + slash/unicode escaping | 🪞 | Cosmetic; JSON parsers (incl. the frontend) normalize. TS emits clean values. |
| 19 | PY: `password_hash` emits `$2b$` (PHP `$2y$`); both verify each other's hashes | 🪞 | Cross-backend login test in `tests/differential/test_auth.py`. |
| 20 | PY: `filter_var(FILTER_VALIDATE_EMAIL)` approximated by RFC-5322-ish regex | 🪞 | Edge cases (quoted local parts, IP literals) may differ; frontend validates first. |
| 21 | PY: `PromptLibraryController::create` returns `data.id` as string (PDO `lastInsertId`) | 🪞 | Mirrored; contexts return int. |
| 22 | PY: `debugAuth.php_version` is a mirrored constant (`8.2.4`) | 🪞 | Update when XAMPP PHP changes. |
| 23 | PY: stored JSON (`context_data`, `packages.capabilities`) written without `\/` escaping | 🪞 | Decodes identically; PHP reads it fine. |
| 24 | PY: WebAuthn assertions are not cryptographically verified (same as PHP) | 🪞 | Pre-existing PHP gap; listed for visibility. |
| 25 | PY: `date('Y-m-d H:i:s')` uses `PHP_TIMEZONE` env (default Europe/Berlin) | 🪞 | Must match php.ini `date.timezone`. |
| 26 | PY: login for a social-only user (`users.password` NULL) returns 401 'Invalid email or password'; PHP throws a TypeError → 500 | 🪞 deliberate deviation | PHP behavior is an uncaught crash, not design; frontend only reads `success:false`. |
| 27 | PY: JWT decode disables PyJWT's `verify_sub` (PyJWT ≥2.10 rejects non-string `sub`); PHP tokens carry an integer `sub` | 🪞 | Required for cross-backend token interop; signature/exp/iat/nbf still verified. |
| 28 | PY: `php_empty()` helper mirrors PHP `empty()` (incl. the string "0") wherever PHP uses `empty()` on request input; `??` is ported as `v if v is not None else default`, never `.get(k, default)` | 🪞 | Applied throughout `AuthController` (login/register/firebaseAuth/linkPhone, fixed 2026-09-05 — those five sites previously used plain truthiness, diverging on `"0"`). Convention for all future ports. |
| 29 | PY: `client_flag FOUND_ROWS` NOT set — live PHP returns 404 on a same-title context rename, so PyMySQL's default affected-rows count already matches | 🪞 | Verified live 2026-09-05. |
| 30 | PY: SSE event payloads are clean JSON (`phpjson.dumps`: no `\/` escaping, unicode unescaped) | 🪞 | Decodes identically in the browser. |
| 31 | PY: `SessionSearchService` connects to the contexts DB lazily on first use (PHP connects in the constructor) | 🪞 | A connection failure surfaces as `{'error': …}` from the tool instead of a constructor throw. |
| 32 | PY: providers other than Claude return the PHP "Provider 'x' not found" error path | 🪞 | Until Phase 2b ports openai/gemini/kimi/grok/deepseek/mistral. |
| 33 | PY: regular (non-streaming) chat runs the memory auto-updater via a post-response hook in `main.py` (`ctx['_after_response']`) after the JSON body is sent | 🪞 | PHP runs it before returning under mod_php (blocking the response ~3s). |
| 34 | PY: `AttachmentDispatcher` import is wrapped in the same `try` as PHP's attachment block | 🪞 | Until Phase 2d ports it, the `ImportError` is swallowed and attachments are ignored. |
| 35 | PY: `_handleVerification` / `_handleComparison` raise `NotImplementedError` until Phase 2d | 🪞 | A verification/compare-enabled request emits a humanized `error` SSE event plus an `error` usage row after the main answer, rather than a PHP-style verification section. |
| 36 | PY: `llm_function_usage_stats` is never created by the Python backend | 🪞 | `UsageTracker.trackFunctionCall` is ported but unused; PHP would `CREATE TABLE` on first call. |
| 37 | PY: `markHeadersInitialized` is declared on `StreamingClientInterface` | 🪞 | PHP declares it only on the concrete `SSEHubClient`. |
| 38 | PY: client-tool name validation is stricter — Python's `$` does not match before a trailing `\n` | 🪞 deliberate deviation | A tool name like `"route_to\n"` is rejected where PHP's `preg_match` would pass it to the provider. |
| 39 | PY: the 2048-byte client-tool description cap slices bytes and decodes with `errors='ignore'` | 🪞 deliberate deviation | PHP `substr` can emit a split multibyte char that `json_encode` then rejects. |
| 40 | PY: streaming path returns `stop_reason` as `None` like PHP's `makeStreamingRequest` | 🪞 | The earlier plan test asserting `'tool_use'` was wrong. |
| 41 | PY: `SseStream.end()` is called at the same point as PHP's `fastcgi_finish_request()` (inside the memory block, after usage logging) | 🪞 | When that block does not run, the stream is closed by `main.py`'s `finally`. |
| 42 | PY: SSE headers (`text/event-stream`) are sent lazily on the first event; PHP sends them eagerly on entry to `handleStreamingChat` | 🪞 | Every 2a exit path emits at least one event, so the wire is identical; a future handler that returns before any `send()` would answer a bare 200 where PHP answers an empty event-stream. |
| 43 | PY: the SSE bridge queue is unbounded (frames buffer in memory for a stalled client); PHP's `flush()` applies socket backpressure | 🪞 | Chat-sized payloads (tens of KB); revisit if an endpoint streams large bodies. |

## How items get verified
Each fix is validated by **differential testing against the live PHP backend** (byte/semantic
compare) before its 🧪 box is checked. Changes are left unstaged for the repo owner to commit;
schema changes ship as `.sql` to run manually.
