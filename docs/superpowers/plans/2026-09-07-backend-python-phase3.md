# Backend Python Port — Phase 3 (User surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the user-facing (non-admin) controllers so the frontend's Settings, Usage, Storage, Heal, Genesis, Tools, MCP servers/overrides, MCP proxy/app, User memories, App keys, Voice and Drive panels work on the Python backend with JSON-equal responses to PHP: 13 PHP controllers, 60 routes.

**Architecture:** One Python module per PHP controller under `app/controllers/` (AgentTeam ones under `app/agent_team/controllers/`), same class and camelCase method names, line-by-line ports; the services they compose already exist (`PackageResolver`, `UsageLogger`, `MCPToolsLoader`, `LLMProviderResolver`, `AIPortfolioAssistant`, the three memory repositories, `AppKeyRepository`). New services: `GenesisProposer`. Route rows are added to `app/routes.py` in PHP order (`backend/src/routes.php:110-323, 434-446`).

**Tech Stack:** Python 3.13, FastAPI, httpx, PyMySQL, cryptography (existing AES helpers), pytest; differential against live PHP for every GET and for mutation round-trips that clean up after themselves.

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 3 row; §3 conventions; §5 testing).

## Global Constraints

- Everything from the Phase 1–2d plans' Global Constraints still applies (PHP-semantics helpers, `??`/`empty()`/`is_array`/`!$x` rules, SQL byte-identical, controllers return dicts with `status_code`, `SHARED_SSL_CONTEXT` + `close()` for every `httpx.Client`, commit trailer, by-path staging, never start/stop servers).
- **No runtime DDL (spec §3).** Every PHP `ensure*TableExists()` / `ensure*ColumnsExist()` becomes a Python method of the same name that performs NO `CREATE`/`ALTER`; it checks once (`SHOW TABLES LIKE` / `SHOW COLUMNS FROM … LIKE`), caches the answer on the instance, and `error_log`s `"[<Controller>] <table/column> missing — PHP creates it on demand"` when absent. Columns PHP would add at runtime are read only when present (guard the SELECT list) — today's live DB has every table and column these controllers use except `users.universalfs_api_key` (PHP adds it on the first `/settings/storage` call). Tracker row per controller.
- **Differential ordering:** run the PHP request before the Python one in every case (so PHP's on-demand DDL lands first). Mutation cases create → read → delete their own rows only, by returned id/key, and must leave the DB as they found it for user 3 (assert the "after" read equals the "before" read).
- **Encryption:** `SettingsController::encryptApiKey/decryptApiKey` use the same AES-256-CBC + key derivation as `ChatController::decryptApiKey` (2a, `app/support/crypto.py`); a key saved by PHP must decrypt on Python and vice versa (differential: save via PHP, read via Python, and the reverse; then clear).
- **External systems:** `FileStorageController` non-`local` providers depend on the PHP `universalFS` package (`/Applications/XAMPP/xamppfiles/htdocs/universalfs`, PHP-only); Python returns exactly the response PHP returns when the adapter is unavailable (`getUniversalFSAdapter()` → `null` path), and implements the `local` provider fully. `VoiceController::getEphemeralToken` calls xAI over HTTPS (port with httpx, unit-tested with `MockTransport`; differential validation-only). `DriveController::save` returns PHP's static "not yet implemented" payload. `MCPProxyController`/`MCPAppController` speak JSON-RPC/SSE to remote MCP servers (port with httpx; unit-test with `MockTransport`; differential against the live "Metals News" server id 24 for `tools/list` only).
- **Auth:** all Phase 3 routes are protected except none (verify against `AuthMiddleware.php` `PUBLIC_ROUTES`; `/api/mcp-app.php` legacy alias included) — the Python middleware already 401s non-public routes.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```
- Work from `/Applications/XAMPP/xamppfiles/htdocs/gpt/backend_python` (`.venv/bin/python -m pytest`); commit from the repo root staging only your files by path.

## Porting rules

The Phase 2b table + 2c/2d additions apply. Additions:

| PHP | Python |
|---|---|
| `$this->db->query($sql)->fetchAll(PDO::FETCH_ASSOC)` | `db.fetch_all(sql)` |
| `$stmt->fetch(PDO::FETCH_ASSOC)` | `db.fetch_one(sql, params)` |
| `$stmt->fetchColumn()` | first value of `db.fetch_one(...)` or `db.fetch_column(...)[0]` (pick one per file) |
| `$this->db->exec("ALTER …")` / `CREATE TABLE IF NOT EXISTS` | NO-OP + presence check (see Global Constraints) |
| `openssl_encrypt/decrypt` | `app/support/crypto.py` helpers (2a) |
| `password_hash`/`password_verify` | `bcrypt` helpers (Phase 1) |
| `random_bytes(n)` / `bin2hex` | `secrets.token_bytes(n)` / `.hex()` |
| `hash('sha256', $s)` | `hashlib.sha256(s.encode()).hexdigest()` |
| `date('Y-m-d')`, `strtotime('-7 days')` | `php_date('Y-m-d')`, `datetime` arithmetic in PHP's tz |
| `number_format($x, 2, '.', '')` | `f'{x:.2f}'` (ties: PHP half-away-from-zero — use `Decimal` quantize `ROUND_HALF_UP` where the value reaches the wire) |
| `json_encode($v, JSON_PRETTY_PRINT)` | `json.dumps(v, indent=4, ensure_ascii=False)` only where PHP pretty-prints a stored blob (check each site) |
| `$_SERVER['REMOTE_ADDR']` | `request['remote_addr']` |
| `file_get_contents/scandir/filemtime` (local storage) | `pathlib` equivalents; sort order identical to PHP (`scandir` is ASCII-sorted) |

## Task format for this phase (ruling, ledger)

The controllers here are large and mostly CRUD. Each task below fixes: the PHP line ranges to port, the route rows, the rulings, the **unit-test cases** (named, with the exact PHP strings the implementer must copy — "PHP-truth" where the plan does not paste them, tightened before commit and verified by the reviewer against the PHP line), and the **differential cases** (exact requests). Test code is given in full only where its shape is non-obvious.

---

### Task 1: `UsageController` + `UserMemoryController`

**Files:** create `app/controllers/usage_controller.py`, `app/agent_team/controllers/__init__.py`, `app/agent_team/controllers/user_memory_controller.py`; modify `app/routes.py` (`# USAGE` rows for `GET /api/v1/usage`, `/usage/balance`, `/usage/transactions`, `/usage/stats` → `UsageController::getBalance/getBalance/getTransactions/getStats`; `# USER MEMORIES` rows `GET/PUT /api/v1/user-memories`, `GET /api/v1/user-memories/events`, `DELETE /api/v1/user-memories/events/{id:\d+}` → `UserMemoryController::show/update/listEvents/deleteEvent`; registry keys `'UsageController'`, `'AgentTeam:UserMemoryController'` — check how `routes.py` names AgentTeam controllers; if no convention exists yet, use the PHP-prefixed key and map it in the registry dict); tests `tests/unit/test_usage_controller.py`, `tests/unit/test_user_memory_controller.py`, `tests/differential/test_usage_memories.py`.

**Port:** `UsageController.php` 15–115 (`UsageLogger` 2a: `getBalance`, `getTransactions`, `getStats` — confirm the Python `UsageLogger` exposes them; if a method is missing, port it from `UsageLogger.php` in the same task), `AgentTeam/Controllers/UserMemoryController.php` 20–197 (repositories from 2a).

**Unit cases:** unauthenticated → PHP's exact 401 dict; `getTransactions` pagination params (`page`, `limit` via `php_intval`, defaults from PHP); `getStats` period handling; `UserMemoryController::update` validation branches (each PHP error string), `deleteEvent` not-found branch; every SQL string passed through the fake `Db` asserted byte-identical to the repositories' PHP.

**Differential (user 3):** `same()` on `GET /usage`, `/usage/balance`, `/usage/transactions?limit=5`, `/usage/stats`, `/user-memories`, `/user-memories/events?limit=5`; unauthenticated 401 on one of each; `PUT /user-memories` round-trip: read current → PUT the same content back → read equals; `DELETE /user-memories/events/999999999` (not found) parity.

- [ ] Steps: failing tests → port → routes → pass → full unit suite → commit `feat(py): UsageController + UserMemoryController`.

---

### Task 2: `AppKeyController`

**Files:** create `app/agent_team/controllers/app_key_controller.py`; modify `app/routes.py` (`# APP KEYS` rows PHP 441–446 in order: `POST /api/v1/app-keys` create, `GET /api/v1/app-keys` index, `GET /api/v1/app-keys/whoami`, `GET /api/v1/app-keys/workflows`, `GET /api/v1/app-keys/agents`, `DELETE /api/v1/app-keys/{id:\d+}` destroy); tests `tests/unit/test_app_key_controller.py`, `tests/differential/test_app_keys.py`.

**Port:** `AgentTeam/Controllers/AppKeyController.php` 22–291 (`AppKeyRepository` 2a; `requireAdmin` → the same role check PHP does — read it; `resolveNames` SQL byte-identical; `err()` helper).

**Unit cases:** non-admin → `requireAdmin` error dict verbatim; `create` validation (name/scopes/user) branches; `index` shape; `destroy` not-found; `whoami` for jwt vs app-key auth types; SQL of `resolveNames` for both tables.

**Differential (user 3 is admin? — check `users.role` for user 3 first; if not admin, run the admin cases with the expected 403 parity only):** `GET /app-keys`, `/app-keys/whoami`, `/app-keys/workflows`, `/app-keys/agents` exact; `POST /app-keys` create with name `differential-tmp` → both return a key; `DELETE` each created id; assert `GET /app-keys` equals the pre-state on both.

- [ ] Steps as Task 1; commit `feat(py): AppKeyController`.

---

### Task 3: `SettingsController`

**Files:** create `app/controllers/settings_controller.py`; modify `app/routes.py` (`# SETTINGS` rows PHP 114–134 in order); tests `tests/unit/test_settings_controller.py`, `tests/differential/test_settings.py`.

**Port:** `SettingsController.php` 25–1346: `getPhoneStatus`, `getUsage`, `getKeys`, `saveKeys`, `clearKeys`, `getProviderSettings`, `saveProvider`, `setActiveProvider`, `deleteProvider`, `getHealSettings`/`saveHealSettings` (+ `healDefaults`), `getGenesisSettings`/`saveGenesisSettings` (+ `genesisDefaults`), `getStorageSettings`/`saveStorageSettings` (+ `ensureStorageFolderExists`, `ensureLocalStorageFolderExists` — local folder creation under the same root PHP uses: read the PHP path and reuse `config['chat_upload_root']`'s sibling convention or the exact PHP constant), `encryptApiKey`/`decryptApiKey` via `app/support/crypto.py`; all `ensure*` per the no-DDL rule; `universalfs_api_key` read only when the column exists.

**Rulings:** tables `user_api_keys`, `user_model_selections`, `user_provider_settings`, `user_category_settings` exist live; `saveKeys` must produce ciphertext PHP can decrypt (same IV layout as `ChatController::decryptApiKey` expects — 2a `decrypt_api_key`; add `encrypt_api_key` to `crypto.py` if missing, with a round-trip test against a PHP-produced ciphertext captured from the live DB for user 3's kimi key — read-only).

**Unit cases:** unauthenticated 401s; `saveKeys` validation branches (empty provider, unknown provider, empty key → PHP strings); `saveProvider`/`setActiveProvider`/`deleteProvider` validation; heal/genesis settings defaults + coercion (`php_intval`/`float`/mode allowlists from PHP); storage settings provider allowlist; SQL byte-identical for every statement (fake `Db` records).

**Differential (user 3):** `same()` on `GET /settings/phone`, `/settings/usage`, `/settings/keys` (masked keys — compare exactly), `/settings/providers`, `/settings/heal`, `/settings/genesis`, `/settings/storage` (PHP first: it may ALTER `users` — fine); round-trips: `POST /settings/heal` with the current values → GET equals; `POST /settings/genesis` same; `POST /settings/provider` for provider `deepseek` with the current settings → GET equals; keys: `POST /settings/keys` `{provider: 'grok', api_key: 'differential-test-key'}` via PHP → `GET /settings/keys` on Python shows it (masked identically) → `DELETE /settings/keys?provider=grok` (or the body form PHP expects) via Python → both GETs equal the pre-state; then the reverse direction (save via Python, read via PHP, clear via PHP).

- [ ] Steps as Task 1; commit `feat(py): SettingsController (keys, providers, usage, phone, storage, heal, genesis)`.

---

### Task 4: `HealController` + `GenesisController` + `GenesisProposer`

**Files:** create `app/controllers/heal_controller.py`, `app/controllers/genesis_controller.py`, `app/services/genesis_proposer.py`; modify `app/routes.py` (`# HEAL` rows PHP 137–139; `# GENESIS` rows PHP 142–146 incl. `POST /api/v1/genesis/promotions/{id:\d+}/dismiss`); tests `tests/unit/test_heal_genesis.py`, `tests/differential/test_heal_genesis.py`.

**Port:** `HealController.php` 20–206 (`decide` is public and pure — unit-test the four mode branches with exact PHP outputs; `spentToday` SQL; `ensureSpendTable` no-DDL), `GenesisController.php` 20–507 (`decide`, `listPromotions`, `authorize`, `record`, `dismiss(request, id)`, `createProposal` (calls `GenesisProposer` + an LLM — unit-test with a fake proposer; NO live differential for createProposal), `promotionBelongsToUser`, `genesisConfig`, `spentToday`, `bornThisWeek`; `ensureTables` no-DDL — `skill_promotions` + `heal_spend` exist live), `Services/GenesisProposer.php` 1–131 (read its deps first; if it calls a provider, go through `AIPortfolioAssistant`/`LLMManager` like `MemoryExtractor` does).

**Unit cases:** `decide()` matrix for both controllers (all PHP branches, exact dicts); `authorize` validation strings; `record` insert SQL + params; `status` shape; `listPromotions` SQL; `dismiss` ownership check → PHP 403/404 strings; `createProposal` validation + fake-proposer happy path.

**Differential (user 3):** `same()` on `GET /heal/status`, `GET /genesis/promotions`; `POST /heal/authorize` with `{estimate_usd: 0.01}` (read the PHP field names) parity; `POST /genesis/authorize` parity; `POST /genesis/promotions/999999999/dismiss` parity; `POST /heal/record` and `/genesis/record` validation-only (empty body) parity — no rows written.

- [ ] Steps as Task 1; commit `feat(py): HealController + GenesisController + GenesisProposer`.

---

### Task 5: `ToolsController`

**Files:** create `app/controllers/tools_controller.py`; modify `app/routes.py` (`# TOOLS` rows PHP 259–261); tests `tests/unit/test_tools_controller.py`, `tests/differential/test_tools.py`.

**Port:** `ToolsController.php` 20–366: `list` (built-ins via `AIPortfolioAssistant.getToolsManager().getToolDefinitions()` + MCP via `MCPToolsLoader` with the package allowlist `resolvePackageMcpAllowlist`), `execute` (runs one tool by name for the caller — server tools only), `classifyIntent` (LLM call through the assistant — unit-test with a fake; differential validation-only). Close every assistant/loader in `finally`.

**Unit cases:** `list` merges + ordering + `count`; `execute` validation (missing `tool`, unknown tool → PHP strings), success wraps the handler result as PHP does; `classifyIntent` validation + fake assistant path.

**Differential (user 3):** `same()` on `GET /tools` (exact: built-ins + MCP tools with schemas — a mismatch here is a schema-serialization drift: `properties: {}` vs `[]`, key order — investigate, do not loosen); `POST /tools/execute` with `{tool: 'search_assets', ...}`? — no: pick a deterministic tool: `POST /tools/execute {tool: 'get_asset_sentiment', params: {symbol: 'AAPL'}}` only if the DB functions are registered on this path (they are not — `setDatabase` is not called) so use the static `serpapi_search` validation error (no key/params) parity; `POST /tools/classify-intent {}` validation parity.

- [ ] Steps as Task 1; commit `feat(py): ToolsController`.

---

### Task 6: `MCPServerController`

**Files:** create `app/controllers/mcp_server_controller.py`; modify `app/routes.py` (`# MCP SERVERS` rows PHP 266–276 in order, incl. `PUT /api/v1/me/mcp-settings`, `GET /api/v1/me/mcp-servers`, `PUT/DELETE /api/v1/me/mcp-servers/{serverId:\d+}/override`); tests `tests/unit/test_mcp_server_controller.py`, `tests/differential/test_mcp_servers.py`.

**Port:** `MCPServerController.php` 15–721 line by line (static `normalizeTransport`, `deriveServerType`; `list`, `isServerEffective`, `applyPackageAllowlist`, `getTools`, `getAllTools`, `create`, `update`, `toggle`, `delete`, `isMasterEnabled`, `setMasterSetting`, `serverAllowedForUser`, `listMine`, `findVisibleServer`, `setMyOverride(request, serverId)`, `clearMyOverride(request, serverId)`; `ensureTablesExist`/`ensureMcpSettingsTableExists` no-DDL — all tables exist live).

**Unit cases:** the two statics (all PHP branches); `create`/`update` validation strings; ownership/visibility branches (`findVisibleServer` → 404 string); `toggle`/`delete` for a server the user does not own; override set/clear SQL; master setting SQL (`user_mcp_settings` upsert byte-identical).

**Differential (user 3):** `same()` on `GET /mcp/servers`, `/mcp/servers/all-tools`, `/me/mcp-servers`, `GET /mcp/servers/tools?server_id=24`; round-trip: `POST /mcp/servers` create a private server `{name: 'differential-tmp', url: 'http://127.0.0.1:1/mcp', ...}` via PHP → `GET /me/mcp-servers` on Python shows it → `PUT /me/mcp-servers/{id}/override {enabled: false}` on Python → GET equal on both → `DELETE /me/mcp-servers/{id}/override` → `DELETE /mcp/servers {id}` (body form PHP expects) → both lists equal the pre-state; `PUT /me/mcp-settings {enabled: <current>}` idempotent parity.

- [ ] Steps as Task 1; commit `feat(py): MCPServerController`.

---

### Task 7: `MCPProxyController` + `MCPAppController`

**Files:** create `app/controllers/mcp_proxy_controller.py`, `app/controllers/mcp_app_controller.py`; modify `app/routes.py` (`POST /api/v1/mcp/proxy` forward; `GET /api/v1/mcp/app` + `GET /api/mcp-app.php` getResource); tests `tests/unit/test_mcp_proxy_app.py`, `tests/differential/test_mcp_proxy.py`.

**Port:** `MCPProxyController.php` 15–614 (`forward`, `proxyRequest`, `testConnection`, `discoverTools`, static `resolveEndpointUrl`, `sendToMCPServer` (httpx; SSE responses parsed by `parseSSEResponse`), `getServerUrl/Headers/Transport`, `normalizeHeaders`, `cacheTools` (writes `mcp_server_tools` — SQL byte-identical), `sanitizeSchema`, `ensureTablesExist` no-DDL); `MCPAppController.php` 15–225 (`getResource`, `sendMCPRequest`).

**Unit cases:** `resolveEndpointUrl` matrix (http vs sse transports, trailing slashes); `normalizeHeaders` (string/array/JSON forms); `parseSSEResponse` on a recorded SSE body; `forward` validation strings; `proxyRequest` happy path with `MockTransport` (JSON-RPC echo) incl. header injection from the DB row; `testConnection` success/failure dicts; `discoverTools` caching SQL; `sanitizeSchema` cases; `getResource` validation + happy path.

**Differential (user 3, live server id 24 "Metals News"):** `POST /mcp/proxy` with `{server_id: 24, jsonrpc: {jsonrpc: '2.0', id: 1, method: 'tools/list'}}` (read the exact body shape PHP expects) → compare status + top-level keys + the tool-name list; validation cases (missing server, unknown id) exact; `GET /mcp/app?server_id=24&...` — read what params `getResource` needs; validation parity at minimum.

- [ ] Steps as Task 1; commit `feat(py): MCPProxyController + MCPAppController`.

---

### Task 8: `FileStorageController` + `VoiceController` + `DriveController`

**Files:** create `app/controllers/file_storage_controller.py`, `app/controllers/voice_controller.py`, `app/controllers/drive_controller.py`; modify `app/routes.py` (`# STORAGE` rows PHP 151–153; `# VOICE` rows 315–318; `# DRIVE` row 323); tests `tests/unit/test_file_storage_controller.py`, `tests/unit/test_voice_drive_controllers.py`, `tests/differential/test_storage_voice_drive.py`.

**Port:** `FileStorageController.php` 18–545 (`local` provider fully: `buildFullPath` with the exact PHP root, `listLocalFiles` (order + fields), `readLocalFile`, `guessMimeType` map verbatim, `isBinaryContent` rule verbatim; `getUniversalFSAdapter` → always `None` with the same `error_log` → the same "provider unavailable" response PHP gives; `getUserStorageConfig` SQL; `ensureStorageColumnsExist` no-DDL), `VoiceController.php` 18–463 (`logUsage` (usage row via `UsageLogger` — SQL identical), `getStats` (+ `getDateCondition` per period, `getDefaultVoiceModel`), `getEphemeralToken` → `generateGrokEphemeralToken` (httpx to xAI; `MockTransport` test; real call only when a grok key exists AND the differential is explicitly enabled by env `DIFF_VOICE_TOKEN=1` — default skip; tracker row), `getConfig`), `DriveController.php` 15–123 (`save` static payload).

**Unit cases:** storage: provider allowlist, path traversal guard (PHP's — copy its exact check and error), list/read on a tmp root, mime map, binary rule; voice: `logUsage` validation + SQL, `getStats` period SQL, token validation (no key → PHP error), `getConfig` shape; drive: exact static dict.

**Differential (user 3):** `same()` on `GET /storage/providers`, `GET /storage/list` (local root of user 3 — create a temp file via the filesystem in both roots? No — read-only: compare as-is), `GET /storage/read?path=<a file that exists>` or the not-found parity, `GET /voice/stats?period=week`, `GET /voice/config`, `POST /voice/usage` validation parity, `POST /voice/token` validation/skip, `POST /drive/save` exact.

- [ ] Steps as Task 1; commit `feat(py): FileStorage (local) + Voice + Drive controllers`.

---

### Task 9: Docs, verification, browser smoke

- README: Phase 3 paragraph (the 60 routes; universalFS limitation; voice token env gate). Tracker rows: no-DDL per controller; `universalfs_api_key` guarded read; universalFS providers unavailable in Python; voice token differential gated; Drive static; any ledger ruling.
- Verification: `pytest -q tests/unit`; `pytest -q tests/differential -k "not live"` plus the new Phase 3 differential files (they contain no LLM calls except none); `logs/backend.log` traceback check.
- Browser smoke (controller, when signed in): Settings panel loads keys/providers/heal/genesis/storage on Python; MCP servers panel lists and toggles an override; Tools panel lists; Usage panel shows balance.
- Commit `docs(py): Phase 3 status + parity rows`.

## Self-review notes

- **Spec coverage (umbrella §4 phase 3):** settings T3, usage T1, storage T8, heal/genesis T4, tools T5, MCP servers + overrides T6, MCP proxy/app T7, user memories T1, app-keys T2, voice T8, Drive T8. 60 routes: 15+4+3+3+5+3+11+1+2+4+1+4+6 = 62 rows incl. the `/usage` alias and the legacy `/api/mcp-app.php` — matches `routes.php`.
- **Placeholders:** PHP-truth strings are named per task, not pasted; the ruling in the ledger covers this format; reviewers verify each against the PHP line.
- **Type consistency:** `Db` API (Phase 1), `crypto.py` (2a), repositories (2a), `AppKeyRepository` (2a), `MCPToolsLoader.loadToolsForUser(userId, allowlist)` (2a/2c), `PackageResolver.allowedMcpServers` (Phase 1), `AIPortfolioAssistant.getToolsManager().getToolDefinitions()` (2a).
