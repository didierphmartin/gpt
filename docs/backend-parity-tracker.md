# Backend Parity & Hardening Tracker

Tracks the suboptimal/quirky items found in the PHP backend (`gpt/backend`) and their status in
each backend. The TypeScript backend (`gpt/backend_typescript`) is a faithful mirror, so most items
are either **fixed in both** or **mirrored as-is** (deliberately replicating PHP). DB-schema changes
are written as `.sql` for the owner to run (migrations are applied manually).

**Legend:** ✅ done · ⬜ to do · ➖ N/A · 🪞 mirror as-is (no fix intended) · 🚫 won't do (decided) · 🧪 differential-tested vs live PHP

**Deployment context / threat model:** internal corporate access, behind authentication (not public
internet). This lowers the priority of anti-abuse hardening (e.g. login rate-limiting) but NOT of
correctness or authentication-integrity items (e.g. #1 token verification still matters).

Last updated: 2026-09-06

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
| 33 | PY: regular (non-streaming) chat runs the memory auto-updater via a hook in `main.py` (`ctx['_after_response']`) after the body is rendered but BEFORE it is written to the client | 🪞 | Same latency as PHP under mod_php (no `fastcgi_finish_request`, ~3s when memory is on); the hook can never fail the response. |
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
| 44 | PY: Grok/Kimi/DeepSeek ignore `base_url` from `system_llm_settings` (class constants, like PHP) | 🪞 | Mirrors PHP; the TS port diverged here. |
| 45 | PY: `CustomProvider` request timeout `providers.<name>.timeout` ?? `{'gamma4': 90}` ?? 600 s, connect 15 s, via `httpx.Timeout` | 🪞 | Same values as PHP's Guzzle options. |
| 46 | PY: Gemini `streamChat` = `chat()` + one `onChunk(text)`; no true streaming | 🪞 | Spec §4; identical event skeleton to PHP. |
| 47 | PY: provider HTTP errors map 429/401/other from `httpx.HTTPStatusError`; network errors (`httpx.RequestError`) become `apiError(provider, str(e), 0)` | 🪞 | Category mapping (429 / 401 / other) matches PHP. The message TEXT differs from Guzzle's — httpx's `str(e)` is the status line only, and Guzzle's embeds a body summary — so the ported providers rebuild it (see rows 50 and 55). |
| 48 | PY: `ProviderRequestFactory` interface check is `issubclass(cls, HttpRequestBuilderInterface)` (PHP `class_implements`) | 🪞 | Same fallbacks. |
| 49 | PY: OpenAI streaming is decided by `options['stream'] ?? true`; the `openai.streaming` config key is never read | 🪞 | PHP parity. |
| 50 | PY: ` \| Response: <body>` is appended to the `apiError` message on the paths where PHP's Guzzle message would have carried a body excerpt: OpenAI, DeepSeek, Custom, Gemini, Claude STREAMING (`makeStreamingRequest`), and Kimi's non-JSON fallback | 🪞 | NOT everywhere: Grok extracts `error.message` out of the body instead (PHP mirror), and Claude's NON-streaming `_makeRequest` keeps a bare `str(e)` because PHP only has the idiom on its streaming path. `humanizeProviderError` depends on the body reaching it. |
| 51 | PY: `getDefaultSystemPrompt` is public on every provider (PHP private) | 🪞 | The shared mixin calls it. |
| 52 | PY: DeepSeek `disableThinkingForThisCall` also triggers on a forced `tool_choice` (PHP 166-177) | 🪞 | Mirrored. |
| 53 | PY: Gemini `parseHttpResponse` returns OpenAI-shaped `tool_calls` (`{id, type, function{name, arguments}}`, PHP 1273-1280) | 🪞 | Mirrored. |
| 54 | PY: `php_strval` helper mirrors PHP `strval` for enum coercion in tool schemas (bool → "1"/"", float 1.0 → "1") | 🪞 | Used wherever a tool schema enum value needs PHP-style stringification. |
| 55 | PY: the appended ` \| Response: <body>` is truncated by `guzzle_body_summary` (`app/providers/_http.py`) at 120 chars + `' (truncated...)'`, mirroring `GuzzleHttp\Psr7\Message::bodySummary` | 🪞 | Only the truncation rule is mirrored; Guzzle also returns null for empty/non-seekable bodies and for summaries containing non-printable characters — here an empty body yields `''` and binary bodies pass through. Applied at all six append sites of row 50. |
| 56 | PY: all seven providers share one `ssl.SSLContext` (`app/providers._http.SHARED_SSL_CONTEXT`) via `httpx.Client(verify=...)` | 🪞 | Not a behaviour deviation — curl (and so Guzzle) caches CA material process-wide, while httpx 0.28 builds a fresh context per Client. `_initializeDefaultProvider` constructs every enabled provider per chat request: ~410 ms → ~39 ms. |
| 57 | PY: `humanizeProviderError`'s 🌐 branch also matches `nodename`/`servname`/`name or service not known`/`getaddrinfo` | 🪞 | Behavioural parity over regex-text parity: PHP/curl says "Could not resolve host", httpx surfaces the OS getaddrinfo text. Same humanized line either way. |
| 58 | PY: `fixSchemaForGemini` / `convertToolsToGeminiFormat` are `@classmethod`s recursing through `cls.` | 🪞 | Reproduces PHP's `self::` inside a trait, which resolves to the USING class — so calls entering through the mixin land on `GeminiProvider`'s override. |
| 59 | Differential: the chat path has NO `model` override in the request body (PHP `ChatController::chat` never reads `$input['model']`; only `agent()` does, at ChatController.php:947), so provider error parity cannot be forced per-request | ⏳ | `tests/differential/test_chat.py::test_streaming_error_parity_bad_key` stays skipped: exercising it needs a throwaway `system_llm_settings` row (or user API-key row) pointing at an unroutable host / carrying an invalid key. Error-message parity is covered by the unit matrix (`test_humanize_provider_error_matrix.py`) instead. |
| 60 | Differential: NON-streaming parity is asserted per provider (`tests/differential/test_providers.py`), comparing HTTP status + JSON key order + `usage` shape, ignoring `text` and token counts | 🪞 | Streaming was already covered; spec §6 asks for both. The status is COMPARED, not pinned to 200, so a live provider that is rate limited (openai, observed 429) or whose model host is offline (gamma4, observed 503) yields opportunistic error-path parity: same status, same humanized `error` string on both backends. |
| 61 | PY: `ProviderController` closes every `AIPortfolioAssistant` it constructs (`finally: assistant.close()`) | 🪞 | Python-only; PHP relies on request teardown. Up to eight httpx clients per call otherwise wait for GC. |
| 62 | PY: `AgentDelegationFunctions` is names-only until Phase 5 (`getToolNames()`); the handlers land with `AgentRunner` | 🪞 | `/api/v1/providers` advertises the three names exactly as PHP. |
| 63 | PY: built-in Functions call `raise_for_status()` on FMP responses so 4xx/5xx reach the same `except` PHP's Guzzle exception reaches | 🪞 | Error text differs only after the PHP prefix (`Failed to fetch …: `). |
| 64 | PHP+PY: `MetalsNewsFunctions` deleted (it was commented out in PHP; Metals News is an MCP server) | ✅ | Owner rule 2026-09-06: commented-out functions are deleted in every implementation. |
| 65 | PY: `get_all_transactions` defaults `sort` to `date` when omitted; PHP re-reads the undefined key (`PortfolioFunctions.php:281`) → `ORDER BY t.  DESC` → SQL error → `{"error": …}` | 🪞 deliberate deviation | PHP behavior is an accidental crash, not design (same precedent as row 26). PHP fix is the owner's call. |
| 66 | PY: watchlist alert comparisons (`get_watchlist_with_market_data`) use a PHP-8 loose-comparison helper: numeric strings compare numerically, `NULL` prices compare as `''` (so `NULL <= alert` is true, `NULL >= alert` is false) | 🪞 | DECIMAL columns arrive as strings from PyMySQL; mirrors PHP's `>=`/`<=` on the same values. |
| 67 | PY: `add_to_watchlist` returns `watchlist_id` as an int (`db.insert()`); PHP's `lastInsertId()` returns a string | 🪞 deliberate deviation | Owner-sanctioned (2026-09-06 final review): the plan's `lastInsertId()` → `db.insert(...)` porting rule types the return as an int; not worth widening every insert-id call site to `strval()` for this one JSON field. |
| 68 | PHP+PY: the chat body's `user_id` overrides the authenticated user id for tool execution (`ChatController` chat/agent/verify/compare: `$input['user_id'] ?? $request['user_id']`) | 🪞 | Pre-existing PHP behaviour kept for parity; harmless until DB Functions are registered on the chat path (Phase 5) — owner to fix in PHP first. |
| 69 | PY: `ExecutionTraceStore.ensureTable()` performs no DDL (presence check + log); PHP `CREATE TABLE IF NOT EXISTS` on demand | 🪞 | Spec rule "no runtime DDL"; the table exists live. Same for every later `ensure*` site. |
| 70 | PY: `SkillToolBridge` directory is `$SKILL_TOOL_BRIDGE_DIR` or `/tmp/synergy-workflow-tool`; PHP uses `sys_get_temp_dir()` (a `/var/folders/…/T` path on this Mac) | 🪞 | Each backend's runner and bridge live in the same process family, so the dirs need not be shared. |
| 71 | PY: upload MIME detection = byte sniffer + libmagic-like text typing (svg/xml/html/json) + PHP's extension fallback; PHP uses `finfo`. On this box XAMPP's old libmagic types `.docx`/`.pptx` as `application/octet-stream`, so PHP 415s them while Python accepts them via PHP's own OOXML branch | 🪞 deliberate deviation (environment) | Pinned by `tests/differential/test_chat_upload.py`; pdf/xlsx/txt/md/csv/html/json/svg/xml parity verified against the XAMPP php `finfo`. |
| 72 | PY: document text extraction uses pypdf / python-docx / openpyxl / python-pptx (PHP: smalot/pdfparser, PhpWord, PhpSpreadsheet, PhpPresentation) | 🪞 | Block layout, headers, separators, elision text, truncation marker and note strings are verbatim; extracted text may differ; python-docx drops hyperlink-run text; latin-1 `.txt` bytes decode with replacement. |
| 73 | PY: `fetch-url` network failures read `Fetch failed (httpx <ExceptionClass>): <err>` (PHP: `Fetch failed (curl errno N): <err>`) | 🪞 | Same 502 and dict shape. |
| 74 | PY: `fetch-url` does not verify TLS (`verify=False`), mirroring PHP's `CURLOPT_SSL_VERIFYPEER=false` | 🪞 | LAN deployment; parity over hardening. |
| 75 | Differential: `fetch-url`'s private-address 403 cannot be compared — both backends are called from localhost and PHP's `callerIsLoopback()` bypasses the guard | 🪞 | Unit-tested on both the refuse and bypass branches. |
| 76 | PY: `fetch-url` body decoding: unknown charset names fall back to utf-8 with replacement (PHP returns the raw bytes) | 🪞 | Edge case; header/meta charsets handled like PHP. |
| 77 | PY: `ExecutionTraceStore.diagnose` sorts with a stable sort (PHP `usort` is not stable) | 🪞 | Ties in `bad` counts may order differently. |
| 78 | PY: `SkillToolBridge` result files are read/written as UTF-8 with replacement (PHP: raw bytes) | 🪞 | Malformed bytes yield `None` like PHP's failed `json_decode`. |

## How items get verified
Each fix is validated by **differential testing against the live PHP backend** (byte/semantic
compare) before its 🧪 box is checked. Changes are left unstaged for the repo owner to commit;
schema changes ship as `.sql` to run manually.
