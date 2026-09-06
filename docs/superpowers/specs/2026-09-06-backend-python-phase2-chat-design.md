# Backend Python Port — Phase 2: Chat Path Design

**Date:** 2026-09-06
**Status:** Approved design — sub-phase plans follow (2a → 2d)
**Parent:** `2026-09-05-backend-python-port-design.md` (umbrella spec; its §3 conventions and §5 testing rules bind this phase)
**Goal:** Port the PHP chat path — `/api/v1/chat`, `/agent`, `/verify`, `/compare`, `/chat/upload`, `/traces*`, `/fetch-url`, `/providers*` — with byte-faithful SSE streaming, all seven LLM providers, the recursive tool loop, MCP tools, built-in functions, skills tools, attachments, user memory and usage logging.

---

## 1. Scope

**In:** `ChatController`, `ChatAttachmentController`, `TracesController`, `UrlFetchController`, `ProviderController` (deferred from Phase 1); `AIPortfolioAssistant`, `Config/Configuration`, `Services/{LLMManager, LLMProviderResolver, ToolsManager, CombinedToolsExecutor, FilteredToolsExecutor, MCPToolsLoader, AttachmentDispatcher, UsageLogger, UsageTracker, PricingResolver, DebugLogger, SSEHubClient}`, `Providers/*` (7 classes + `ProviderRequestFactory` + the two traits), `Contracts/*`, `Exceptions/*`, `Functions/{Search, Analysis, Portfolio, Watchlist, MetalsNews}Functions`, `AgentTeam/Services/{SessionSearchService, SkillToolBridge, SkillToolChoice, UserMemoryRepository, UserMemoryEventsRepository, MemoryAutoUpdater, MemoryExtractor, ExecutionTraceStore}`, `AgentTeam/Functions/AgentDelegationFunctions` (tool names only, as `ProviderController::list` needs them; delegation execution is Phase 5).

**Out:** workflow/agent execution (Phase 5), MCP server CRUD routes (Phase 3), voice, Drive.

## 2. Sub-phases (each: own plan, differential pass, browser smoke)

| # | Scope |
|---|-------|
| 2a | Streaming bridge (`SseStream`, `main.py` race), `Db` reconnect + transactions, worker-pool config, contracts + exceptions, `Configuration`, models, `LLMProviderResolver`, `ToolsManager`, `PricingResolver`, `UsageLogger`, `UsageTracker`, `DebugLogger`, `SSEHubClient`, traits as mixins, `SearchFunctions`, `SessionSearchService`, `MCPToolsLoader`, `CombinedToolsExecutor`, `FilteredToolsExecutor`, memory (`UserMemoryRepository`, events + settings repos, `MemoryExtractor`, `MemoryAutoUpdater`), `ClaudeProvider`, `LLMManager`, `AIPortfolioAssistant`, `ChatController` (`chat` + `handleStreamingChat` + `handleRegularChat` + config appliers + quota + sanitizers + skill tool builders, Claude only), SSE differential comparator |
| 2b | `OpenAIProvider`, `GrokProvider`, `KimiProvider`, `DeepSeekProvider`, `GeminiProvider`, `CustomProvider`, `ProviderRequestFactory` |
| 2c | `Functions/{Analysis, Portfolio, Watchlist}Functions` (`MetalsNewsFunctions` deleted 2026-09-06: it was commented out in PHP in favour of the Metals News MCP server), `AgentDelegationFunctions` (names), `ProviderController` |
| 2d | Client tools + `SkillToolBridge`/`SkillToolChoice`, `ChatAttachmentController` + `AttachmentDispatcher`, `verify` / `compareOnly` / `handleVerification` / `handleComparison`, `agent`, `TracesController` + `ExecutionTraceStore`, `UrlFetchController` |

## 3. Streaming architecture (decision: thread-to-queue bridge)

- Controllers stay synchronous and PHP-shaped. `ctx['sse']` is an `SseStream` (`app/support/sse.py`) with `start()`, `send(event, data)`, `end()`, `aborted`. `send` frames exactly like PHP's `$sendEvent`: `event: X\n`, then one `data:` line per `\n`-split segment for strings or a single JSON `data:` line for objects, then `\n`; strings are raw (not JSON). Frames go on a `queue.Queue`.
- `main.py` runs the pipeline in a worker thread and races two futures: *controller returned* vs *stream started*. When the stream starts first it returns a `StreamingResponse` (`text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, CORS headers) whose async generator drains the queue until `end()`. The controller's later `{'streaming_handled': True}` is discarded, as in `index.php`.
- Client abort: generator cancellation sets `aborted`; the next `send` raises `RuntimeError('CLIENT_ABORTED')`, mirroring `connection_aborted()`; controllers catch it exactly as PHP does (log an `aborted` usage row, return).
- Post-stream work (usage logging, memory auto-update) runs in the same thread after `end()`, mirroring `fastcgi_finish_request()`.
- The per-request DB connection stays open for the stream (as PHP's PDO does). `Db` gains a one-shot reconnect on MySQL 2006/2013 ("server has gone away") because the contexts DB drops idle connections after 60 s and usage is logged after the stream. `Db` also gains `begin()/commit()/rollback()` for later phases.
- Worker pool: `PY_WORKERS` env (default 100) sets anyio's default thread limiter at startup; each in-flight request holds one thread + one connection; MySQL `max_connections` is 500.
- Multipart: for `multipart/form-data` the async handler parses the form and provides `ctx['files']` shaped like `$_FILES` (`name, type, tmp_name, size, error`) with the upload saved to a temp file; `ChatAttachmentController::upload` ports line for line.

## 4. Providers and tool loop

- One class per PHP provider file under `app/providers/`, traits under `app/providers/traits/` as mixins, same public and private method names (`chat`, `streamChat`, `makeRequest`, `makeStreamingRequest`, `handleToolUseRecursive`, …). Contracts under `app/contracts/` as ABCs; `app/exceptions/` mirrors the PHP exception classes and static factories (`ProviderException::apiError/rateLimited/authenticationFailed`, …) because `humanizeProviderError` matches on their messages.
- HTTP via `httpx.Client` per provider instance with the Guzzle base URL, headers and timeouts; streaming via `client.stream(...)` with the same buffer/`\n\n`-split parsing and the same `chunk` emission per text delta. Progress strings verbatim.
- Gemini streams as PHP does (single `chunk`), mirrored.
- Provider errors map to the same `ProviderException` messages; the controller emits the double error (raw + humanized) exactly as PHP.

## 5. Chat controller

- All public methods and private flows port one to one, including `applyDatabaseProviderSettings`, `applyPackageDefaults`, `applyUserApiKeys` (+ `decryptApiKey`), `checkFreeTrialQuota`, `stripVisualNoiseFromHistory`, the sanitizers, `buildRunSkillScriptTool/TaskTool/MultiSkillTool/DiscoverSkillTool`, `buildLlmContextSnapshot`, and the two inline SSE-client classes (as `VerificationSseClient`, `ComparisonSseClient`).
- Request field handling keeps PHP semantics (`php_empty`, `is_numeric`, `??` → `is not None`).
- Attachment text extraction: pypdf, python-docx, openpyxl, python-pptx; same block layout and notes strings as the PHP extractor; `.doc`/`.xls`/`.ppt` legacy formats produce the same "unsupported" note PHP produces when its reader fails.

## 6. Testing

- Unit: per class; providers tested with `httpx.MockTransport` and recorded stream fixtures (Claude SSE, OpenAI-style `data:` lines, Gemini JSON) covering text, tool_use, client-tool short-circuit, mixed-tool error, depth limit, usage accounting, and error mapping.
- Differential (`tests/differential/`): new `sse_skeleton(resp)` helper parses an SSE body into `[(event, data)]`, collapses consecutive identical event names, and returns the skeleton plus the parsed `response`/`complete`/`error` payloads with usage numbers normalized to type. Exact-compare (no LLM call): missing message, `tools` not an array, app-key without `chat` scope, unknown provider, provider without key, invalid JSON body. Live cases (skip when the provider has no key in `system_llm_settings`/user keys): one-line deterministic prompt per configured provider, streaming and non-streaming; one server-tool call per API family; one client-tool short-circuit (`client_tools` with a webmcp tool) which needs no server execution.
- Browser smoke per sub-phase with the frontend on Python: 2a Claude chat; 2b each configured provider; 2c a chat that calls an MCP tool and `/providers` populating the picker; 2d a skill run, an attachment, verify and compare.

## 7. Deviations to record in the parity tracker as they land

Clean JSON (existing); Python document parsers; `httpx` in place of Guzzle/curl; `PY_WORKERS` pool bound; `Db` reconnect-once; multipart via Starlette instead of `$_FILES` (same shape).
