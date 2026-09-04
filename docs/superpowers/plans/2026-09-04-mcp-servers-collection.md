# MCP Servers Sidebar Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "MCP Servers" collection to the AI Assistant sidebar with an overlay form (URL, transport, auto-detected MCP / MCP App type, headers) and an MCPeek-style tool tester (generated parameter form, Call Tool, rendered result).

**Architecture:** The backend already has `mcp_servers` / `mcp_server_tools` tables, per-user CRUD routes, and a cURL proxy (`/mcp/proxy`) that talks JSON-RPC to MCP servers. We add a `transport` column, a derived `server_type`, and an `include_disabled` list flag server-side; client-side we add two new JS files, `mcp-library.js` (sidebar tree + overlay modal) and `mcp-tool-tester.js` (schema → form → coerced args → `mcpClient.callTool` → rendered result), wired into `index.html` and `chat.js` exactly like the existing Agents collection.

**Tech Stack:** PHP 8.4 (FastRoute, PDO/MySQL, PHPUnit 10 via `php vendor/phpunit/phpunit/phpunit`), vanilla JS classes exposed on `window`, Tailwind utility classes (CDN), Node 22 `node --test` for pure JS helpers, XAMPP MySQL at `/Applications/XAMPP/xamppfiles/bin/mysql`.

**Spec:** `docs/superpowers/specs/2026-09-04-mcp-servers-collection-design.md`

## Global Constraints

- All paths below are relative to `/Applications/XAMPP/xamppfiles/htdocs/gpt/` (a git repo). Commit after every task.
- Transport values are exactly `http` and `sse`; default `http`.
- Server type values are exactly `mcp` and `mcp_app`; derived, never user-set.
- Tool "editing" is test-only: nothing about a tool is persisted from the UI.
- Parameter form replicates MCPeek: one `<input type="text">` per top-level `inputSchema.properties` entry, `*` on required, coercion by declared `type` at call time.
- Never call `alert()` / `confirm()` in the new UI; use inline messages and a two-step delete button.
- All user-visible strings go through `window.i18n.t(key)` with keys added to `frontend/assets/i18n/en.json`, `fr.json`, `es.json`.
- Backend tests must not need a database: test pure static helpers, constructed via `ReflectionClass::newInstanceWithoutConstructor()` when needed (pattern in `backend/tests/Unit/UserMcpSettingsTest.php`).
- Run PHP tests with: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/<File>.php`
- Run JS tests with: `cd frontend && node --test tests/<file>.test.mjs`
- Cache-bust every modified script/stylesheet tag in `frontend/index.html` with `?v=20260904-mcplib`.

---

## File map

| File | Responsibility |
|---|---|
| `backend/schema/migrations/2026-09-04_mcp_servers_transport.sql` | Create: adds `transport` column |
| `backend/schema/chatbot.sql` | Modify: document `transport` in `mcp_servers` |
| `backend/src/Controllers/MCPServerController.php` | Modify: `normalizeTransport`, `deriveServerType`, `list()` gains `include_disabled` + `server_type` + `transport`, `create()`/`update()` accept `transport`, `update()` accepts `headers` |
| `backend/tests/Unit/McpServerTransportTest.php` | Create: tests for the two static helpers |
| `backend/src/Controllers/MCPProxyController.php` | Modify: `resolveEndpointUrl()` static, `transport` plumbed through `sendToMCPServer` |
| `backend/tests/Unit/McpProxyEndpointUrlTest.php` | Create: tests for `resolveEndpointUrl` |
| `frontend/assets/js/mcp-client.js` | Modify: `loadServers(includeDisabled)`, `addServer`/`updateServer` transport + headers, `getServerTools`, `registerTools` |
| `frontend/assets/js/mcp-tool-tester.js` | Create: `MCPToolTester` — tool cards, form, coercion, call, result rendering |
| `frontend/tests/mcp-tool-tester.test.mjs` | Create: node tests for `coerceArgs` and `buildInputsHtml` |
| `frontend/assets/js/mcp-library.js` | Create: `MCPLibrary` — sidebar tree + overlay modal |
| `frontend/assets/css/mcp-library.css` | Create: tree, badges, tool card styles |
| `frontend/index.html` | Modify: nav button, rail icon, view container, context menu, script/css tags |
| `frontend/assets/js/chat.js` | Modify: element refs, nav listener, `switchView('mcp-servers')`, package gating key |
| `frontend/assets/i18n/{en,fr,es}.json` | Modify: `sidebar.mcpServers`, `mcpLibrary.*` |

---

### Task 1: Backend — transport column, static helpers, list/create/update changes

**Files:**
- Create: `backend/schema/migrations/2026-09-04_mcp_servers_transport.sql`
- Modify: `backend/schema/chatbot.sql:379-391`
- Modify: `backend/src/Controllers/MCPServerController.php` (`list()` ~line 35, `create()` ~252, `update()` ~313)
- Test: `backend/tests/Unit/McpServerTransportTest.php`

**Interfaces:**
- Produces: `MCPServerController::normalizeTransport(mixed $value): ?string` — returns `'http'` for null/empty, `'http'|'sse'` for valid input (case-insensitive, trimmed), `null` for anything else.
- Produces: `MCPServerController::deriveServerType(int $uiToolCount): string` — `'mcp_app'` when `> 0`, else `'mcp'`.
- Produces: `GET /api/v1/mcp/servers?user_id=..&include_disabled=1` rows now carry `transport` (string), `server_type` (string), `enabled` (int), `tool_count` (int), `ui_tool_count` (int).
- Produces: `POST /api/v1/mcp/servers` body accepts `transport`; `POST /api/v1/mcp/servers/update` body accepts `transport` and `headers` (object or null).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/Unit/McpServerTransportTest.php`:

```php
<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;

final class McpServerTransportTest extends TestCase
{
    public function testNormalizeTransportDefaultsToHttp(): void
    {
        $this->assertSame('http', MCPServerController::normalizeTransport(null));
        $this->assertSame('http', MCPServerController::normalizeTransport(''));
        $this->assertSame('http', MCPServerController::normalizeTransport('  '));
    }

    public function testNormalizeTransportAcceptsKnownValues(): void
    {
        $this->assertSame('http', MCPServerController::normalizeTransport('http'));
        $this->assertSame('sse', MCPServerController::normalizeTransport('sse'));
        $this->assertSame('sse', MCPServerController::normalizeTransport(' SSE '));
    }

    public function testNormalizeTransportRejectsUnknown(): void
    {
        $this->assertNull(MCPServerController::normalizeTransport('stdio'));
        $this->assertNull(MCPServerController::normalizeTransport(42));
        $this->assertNull(MCPServerController::normalizeTransport(['sse']));
    }

    public function testDeriveServerType(): void
    {
        $this->assertSame('mcp', MCPServerController::deriveServerType(0));
        $this->assertSame('mcp_app', MCPServerController::deriveServerType(1));
        $this->assertSame('mcp_app', MCPServerController::deriveServerType(7));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpServerTransportTest.php`
Expected: FAIL with `Call to undefined method ...::normalizeTransport()`

- [ ] **Step 3: Add the migration and schema documentation**

Create `backend/schema/migrations/2026-09-04_mcp_servers_transport.sql`:

```sql
-- 2026-09-04_mcp_servers_transport.sql — per-server MCP transport.
-- 'http'  = Streamable HTTP (JSON-RPC POST, default, existing behaviour)
-- 'sse'   = legacy SSE servers; the proxy POSTs to their /mcp sibling endpoint.
ALTER TABLE mcp_servers
  ADD COLUMN transport ENUM('http','sse') NOT NULL DEFAULT 'http' AFTER headers;
```

In `backend/schema/chatbot.sql`, inside `CREATE TABLE \`mcp_servers\``, add after the `headers` line:

```sql
  `transport` enum('http','sse') NOT NULL DEFAULT 'http',
```

Apply the migration to the local database (reads credentials from `backend/.env`):

```bash
cd backend && set -a && . ./.env && set +a && \
/Applications/XAMPP/xamppfiles/bin/mysql -h"$CTX_DB_HOST" -u"$CTX_DB_USER" -p"$CTX_DB_PASS" "$CTX_DB_NAME" \
  < schema/migrations/2026-09-04_mcp_servers_transport.sql && \
/Applications/XAMPP/xamppfiles/bin/mysql -h"$CTX_DB_HOST" -u"$CTX_DB_USER" -p"$CTX_DB_PASS" "$CTX_DB_NAME" \
  -e "SHOW COLUMNS FROM mcp_servers LIKE 'transport'"
```

Expected: one row `transport | enum('http','sse') | NO | | http`.

- [ ] **Step 4: Add the static helpers to `MCPServerController`**

In `backend/src/Controllers/MCPServerController.php`, add right after the constructor:

```php
    /** Allowed MCP transports. Kept here so the proxy and tests share one source. */
    public const TRANSPORTS = ['http', 'sse'];

    /**
     * Normalize a request-supplied transport. null/empty => 'http' (default);
     * a known value (case-insensitive) => canonical; anything else => null.
     */
    public static function normalizeTransport($value): ?string
    {
        if ($value === null) {
            return 'http';
        }
        if (!is_string($value)) {
            return null;
        }
        $v = strtolower(trim($value));
        if ($v === '') {
            return 'http';
        }
        return in_array($v, self::TRANSPORTS, true) ? $v : null;
    }

    /** 'mcp_app' when at least one cached tool exposes a UI resource, else 'mcp'. */
    public static function deriveServerType(int $uiToolCount): string
    {
        return $uiToolCount > 0 ? 'mcp_app' : 'mcp';
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpServerTransportTest.php`
Expected: `OK (4 tests, 12 assertions)`

- [ ] **Step 6: Extend `list()` with `include_disabled`, `transport`, `server_type`**

Replace the body of `list()` in `MCPServerController.php` with:

```php
    public function list(array $request): array
    {
        $userId = (string) ($request['query']['user_id'] ?? $request['user_id'] ?? '');
        // The sidebar needs disabled private servers too (to re-enable them);
        // chat-side callers keep the enabled-only default.
        $includeDisabled = !empty($request['query']['include_disabled']);

        $enabledClause = $includeDisabled ? '1=1' : 's.enabled = 1';
        $sql = "
            SELECT s.*,
                   COUNT(t.id) as tool_count,
                   SUM(CASE WHEN t.has_ui = 1 THEN 1 ELSE 0 END) as ui_tool_count
            FROM mcp_servers s
            LEFT JOIN mcp_server_tools t ON s.id = t.server_id
            WHERE $enabledClause AND (s.user_id IS NULL" . ($userId !== '' ? " OR s.user_id = :uid" : "") . ")
            GROUP BY s.id
            ORDER BY s.name ASC
        ";
        $stmt = $this->db->prepare($sql);
        if ($userId !== '') {
            $stmt->bindValue(':uid', $userId);
        }
        $stmt->execute();
        $servers = $stmt->fetchAll();

        // Apply the caller's package MCP allowlist: hide servers the role isn't permitted to use.
        $servers = $this->applyPackageAllowlist($servers, $userId);

        foreach ($servers as &$s) {
            $s['tool_count']    = (int)($s['tool_count'] ?? 0);
            $s['ui_tool_count'] = (int)($s['ui_tool_count'] ?? 0);
            $s['enabled']       = (int)($s['enabled'] ?? 1);
            $s['is_mock']       = (int)($s['is_mock'] ?? 0);
            $s['transport']     = self::normalizeTransport($s['transport'] ?? null) ?? 'http';
            $s['server_type']   = self::deriveServerType($s['ui_tool_count']);
            $s['headers']       = isset($s['headers']) && is_string($s['headers'])
                ? (json_decode($s['headers'], true) ?: null)
                : null;
        }
        unset($s);

        return [
            'success' => true,
            'servers' => $servers,
            'status_code' => 200
        ];
    }
```

- [ ] **Step 7: Accept `transport` in `create()`**

In `create()`, after the `$headersJson` line add:

```php
        $transport = self::normalizeTransport($input['transport'] ?? null);
        if ($transport === null) {
            return [
                'success' => false,
                'error' => 'Invalid transport (expected "http" or "sse")',
                'status_code' => 400
            ];
        }
```

Change the INSERT to:

```php
            $stmt = $this->db->prepare("
                INSERT INTO mcp_servers (user_id, name, url, description, headers, transport)
                VALUES (?, ?, ?, ?, ?, ?)
            ");
            $stmt->execute([$userId, $name, $url, $description, $headersJson, $transport]);
```

- [ ] **Step 8: Accept `transport` and `headers` in `update()`**

In `update()`, after the `Name and URL are required` check, replace the UPDATE block with:

```php
        $transport = self::normalizeTransport($input['transport'] ?? null);
        if ($transport === null) {
            return [
                'success' => false,
                'error' => 'Invalid transport (expected "http" or "sse")',
                'status_code' => 400
            ];
        }

        $sets   = ['name = ?', 'url = ?', 'description = ?', 'transport = ?'];
        $params = [$name, $url, $description, $transport];

        // Headers are only touched when the key is present in the body:
        // {} or null clears them, an object replaces them.
        if (array_key_exists('headers', $input)) {
            $headers = $input['headers'];
            $sets[]   = 'headers = ?';
            $params[] = (is_array($headers) && $headers) ? json_encode($headers) : null;
        }

        $params[] = $serverId;
        $params[] = $userId;
        $stmt = $this->db->prepare(
            "UPDATE mcp_servers SET " . implode(', ', $sets) . " WHERE id = ? AND user_id = ?"
        );
        $stmt->execute($params);
```

Keep the existing `rowCount() === 0` 404 branch and the `DELETE FROM mcp_server_tools` cache clear that follow.

- [ ] **Step 9: Smoke-test the endpoints against the running XAMPP backend**

Run (uses a throwaway `user_id`, no auth is required on these routes beyond what the middleware already enforces; if the middleware rejects, obtain a token by logging in at `http://localhost/gpt/frontend/` and copy `localStorage.token` into `TOKEN`):

```bash
TOKEN="${TOKEN:-}"; H=(-H "Content-Type: application/json"); [ -n "$TOKEN" ] && H+=(-H "Authorization: Bearer $TOKEN")
curl -s "${H[@]}" -X POST http://localhost/gpt/backend/api/v1/mcp/servers \
  -d '{"user_id":"plan-smoke","name":"plan-smoke-ai","url":"http://localhost/AI_mcp/mcp-server.php","transport":"sse"}'
echo; curl -s "${H[@]}" "http://localhost/gpt/backend/api/v1/mcp/servers?user_id=plan-smoke&include_disabled=1" | head -c 600
```

Expected: first call returns `"success":true` with a `server_id`; second lists `plan-smoke-ai` with `"transport":"sse"` and `"server_type":"mcp"`. Then clean up:

```bash
ID=$(curl -s "${H[@]}" "http://localhost/gpt/backend/api/v1/mcp/servers?user_id=plan-smoke&include_disabled=1" | php -r '$d=json_decode(stream_get_contents(STDIN),true);foreach($d["servers"] as $s){if($s["name"]==="plan-smoke-ai")echo $s["id"];}')
curl -s "${H[@]}" -X DELETE "http://localhost/gpt/backend/api/v1/mcp/servers?server_id=$ID&user_id=plan-smoke"
```

Expected: `"success":true`.

- [ ] **Step 10: Run the whole unit suite and commit**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpServerTransportTest.php tests/Unit/UserMcpSettingsTest.php`
Expected: both OK.

```bash
git add backend/schema/migrations/2026-09-04_mcp_servers_transport.sql backend/schema/chatbot.sql \
        backend/src/Controllers/MCPServerController.php backend/tests/Unit/McpServerTransportTest.php
git commit -m "feat(mcp): transport column, derived server_type, include_disabled list flag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 2: Backend — proxy honours transport

**Files:**
- Modify: `backend/src/Controllers/MCPProxyController.php` (`forward()` ~32, `proxyRequest()` ~71, `testConnection()` ~170, `discoverTools()` ~230, `sendToMCPServer()` ~318, `getServerUrl()` ~420)
- Test: `backend/tests/Unit/McpProxyEndpointUrlTest.php`

**Interfaces:**
- Consumes: `MCPServerController::normalizeTransport()` from Task 1 (same namespace `Quantis\AIPortfolioAssistant\Controllers`, no `use` needed).
- Produces: `MCPProxyController::resolveEndpointUrl(string $serverUrl, string $transport = 'http'): string` — the exact URL cURL will POST to.
- Produces: `POST /api/v1/mcp/proxy` with `action: 'test_connection'` now also accepts `transport`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/Unit/McpProxyEndpointUrlTest.php`:

```php
<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;

final class McpProxyEndpointUrlTest extends TestCase
{
    public function testHttpAppendsMcpWhenMissing(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test', 'http'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/', 'http'));
    }

    public function testHttpLeavesMcpAndPhpEndpointsAlone(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/mcp', 'http'));
        $this->assertSame('http://localhost/AI_mcp/mcp-server.php',
            MCPProxyController::resolveEndpointUrl('http://localhost/AI_mcp/mcp-server.php', 'http'));
    }

    public function testSseRewritesSseSuffixToMcp(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse', 'sse'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse/', 'sse'));
    }

    public function testSseWithoutSseSuffixBehavesLikeHttp(): void
    {
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test', 'sse'));
        $this->assertSame('https://x.test/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/mcp', 'sse'));
    }

    public function testHttpDoesNotRewriteSseSuffix(): void
    {
        // Existing behaviour for http transport is preserved verbatim.
        $this->assertSame('https://x.test/sse/mcp', MCPProxyController::resolveEndpointUrl('https://x.test/sse', 'http'));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpProxyEndpointUrlTest.php`
Expected: FAIL with `Call to undefined method ...::resolveEndpointUrl()`

- [ ] **Step 3: Add `resolveEndpointUrl()` and use it in `sendToMCPServer()`**

In `MCPProxyController.php` add before `sendToMCPServer()`:

```php
    /**
     * Compute the URL the proxy POSTs JSON-RPC to.
     *  - 'sse' transport: a trailing "/sse" is replaced by "/mcp" (MCPeek's
     *    SSEMCPClient.initializeSession behaviour). Servers that only answer
     *    over the event stream are not supported by this proxy.
     *  - then, for every transport: append "/mcp" unless the URL already ends
     *    in "/mcp" or ".php" (XAMPP-style script endpoints).
     */
    public static function resolveEndpointUrl(string $serverUrl, string $transport = 'http'): string
    {
        $url = rtrim($serverUrl, '/');
        if ($transport === 'sse' && str_ends_with($url, '/sse')) {
            $url = substr($url, 0, -4) . '/mcp';
        }
        if (!str_ends_with($url, '/mcp') && !str_ends_with($url, '.php')) {
            $url .= '/mcp';
        }
        return $url;
    }
```

Change the `sendToMCPServer` signature and its URL normalisation:

```php
    private function sendToMCPServer(string $serverUrl, array $request, bool $expectResponse = true, array $extraHeaders = [], string $transport = 'http'): ?array
    {
        $this->lastError = null;

        $mcpUrl = self::resolveEndpointUrl($serverUrl, $transport);
```

and delete the four lines that previously built `$mcpUrl` (the `rtrim` + `if (!str_ends_with(...)) $mcpUrl .= '/mcp';`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpProxyEndpointUrlTest.php`
Expected: `OK (5 tests, 9 assertions)`

- [ ] **Step 5: Plumb transport through `proxyRequest`, `discoverTools`, `testConnection`**

Add a lookup helper next to `getServerHeaders()`:

```php
    /** Transport stored for a global or caller-owned server; 'http' when unknown. */
    private function getServerTransport(int $serverId, string $userId): string
    {
        try {
            $stmt = $this->db->prepare("
                SELECT transport FROM mcp_servers
                WHERE id = ? AND (user_id IS NULL OR user_id = ?)
                LIMIT 1
            ");
            $stmt->execute([$serverId, $userId]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            return MCPServerController::normalizeTransport($row['transport'] ?? null) ?? 'http';
        } catch (\Exception $e) {
            return 'http';
        }
    }
```

In `proxyRequest()`, after `$extraHeaders = ...` add:

```php
        $transport = $serverId ? $this->getServerTransport($serverId, $userId) : 'http';
```

and append `, $transport` as the 5th argument to each of the three `sendToMCPServer(...)` calls in that method (the initialize call, the `notifications/initialized` call — pass `false, $extraHeaders, $transport` — and the main request call).

In `discoverTools(string $serverUrl, ?int $serverId, string $userId)`, add the same `$transport` line after `$extraHeaders` is computed, and append `, $transport` to its three `sendToMCPServer` calls.

Change `testConnection` to:

```php
    private function testConnection(?string $serverUrl, array $extraHeaders = [], string $transport = 'http'): array
```

and append `, $transport` to its `sendToMCPServer` call. In `forward()`, change the `test_connection` case to:

```php
            case 'test_connection':
                $transport = MCPServerController::normalizeTransport($input['transport'] ?? null) ?? 'http';
                return $this->testConnection($serverUrl, $this->normalizeHeaders($input['headers'] ?? null), $transport);
```

- [ ] **Step 6: Verify nothing regressed with the existing local server**

```bash
curl -s -H "Content-Type: application/json" -X POST http://localhost/gpt/backend/api/v1/mcp/proxy \
  -d '{"action":"test_connection","server_url":"http://localhost/AI_mcp/mcp-server.php","transport":"sse"}' | head -c 300
```

Expected: `"success":true` with `serverInfo` (the `.php` endpoint is left untouched by both transports).

- [ ] **Step 7: Run both backend test files and commit**

Run: `cd backend && php vendor/phpunit/phpunit/phpunit tests/Unit/McpProxyEndpointUrlTest.php tests/Unit/McpServerTransportTest.php`
Expected: OK.

```bash
git add backend/src/Controllers/MCPProxyController.php backend/tests/Unit/McpProxyEndpointUrlTest.php
git commit -m "feat(mcp): proxy honours per-server transport (sse -> /mcp sibling endpoint)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 3: `MCPClient` additions

**Files:**
- Modify: `frontend/assets/js/mcp-client.js` (`loadServers` :79, `addServer` :101, `updateServer` :145, `testConnection` :310, after `getTool` :488)

**Interfaces:**
- Consumes: Task 1 list/create/update contracts, Task 2 `test_connection.transport`.
- Produces (all on `window.mcpClient`):
  - `loadServers(includeDisabled = false): Promise<Server[]>` — `Server = {id, user_id, name, url, description, headers, transport, enabled, is_mock, tool_count, ui_tool_count, server_type}`.
  - `addServer(name, url, description = '', headers = {}, transport = 'http'): Promise<{success, server_id?, error?}>`
  - `updateServer(serverId, name, url, description = '', headers = undefined, transport = 'http'): Promise<{success, error?}>` — `headers` is sent only when not `undefined`.
  - `testConnection(serverUrl, headers = {}, transport = 'http')`
  - `getServerTools(serverId): Promise<CachedTool[]>` — `CachedTool = {id, server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri}`.
  - `registerTools(server, tools): Tool[]` — seeds `this.tools` so `callTool()` / `mcpAppHost.createAppFrame()` can find them; returns the normalized `Tool = {server_id, server_url, server_name, name, description, inputSchema, hasUi, uiResourceUri}` list.

- [ ] **Step 1: `loadServers(includeDisabled)`**

Replace the first lines of `loadServers()`:

```js
    async loadServers(includeDisabled = false) {
        try {
            const userId = this.getUserId();
            const qs = `user_id=${encodeURIComponent(userId)}` + (includeDisabled ? '&include_disabled=1' : '');
            const data = await this.request(`/mcp/servers?${qs}`);
```

(the rest of the method is unchanged).

- [ ] **Step 2: `addServer` and `updateServer` carry transport and headers**

Change `addServer` signature and body start to:

```js
    async addServer(name, url, description = '', headers = {}, transport = 'http') {
        try {
            const body = {
                action: 'add',
                user_id: this.getUserId(),
                name,
                url,
                description,
                transport
            };
```

Change `updateServer` to:

```js
    async updateServer(serverId, name, url, description = '', headers = undefined, transport = 'http') {
        try {
            const body = {
                user_id: this.getUserId(),
                server_id: serverId,
                name,
                url,
                description,
                transport
            };
            if (headers !== undefined) {
                body.headers = headers;   // {} or null clears, object replaces
            }
            const data = await this.request('/mcp/servers/update', {
                method: 'POST',
                body: JSON.stringify(body)
            });
```

(the `if (data.success)` block that follows is unchanged).

- [ ] **Step 3: `testConnection` carries transport**

```js
    async testConnection(serverUrl, headers = {}, transport = 'http') {
        try {
            const body = {
                action: 'test_connection',
                server_url: serverUrl,
                transport
            };
```

- [ ] **Step 4: `getServerTools` and `registerTools`**

Add after `getTool()`:

```js
    /**
     * Cached tools for one server (from mcp_server_tools). Empty array when
     * the cache is empty or the server is disabled/not visible.
     */
    async getServerTools(serverId) {
        try {
            const userId = this.getUserId();
            const data = await this.request(
                `/mcp/servers/tools?server_id=${encodeURIComponent(serverId)}&user_id=${encodeURIComponent(userId)}`
            );
            return data.success && Array.isArray(data.tools) ? data.tools : [];
        } catch (error) {
            console.error('Failed to load server tools:', error);
            return [];
        }
    }

    /**
     * Seed this.tools with a server's tools so callTool()/createAppFrame()
     * resolve them even when loadAllTools() has not run (or the server is
     * disabled). Accepts either cached rows (tool_name/input_schema) or raw
     * tools/list entries (name/inputSchema). Returns the normalized list.
     */
    registerTools(server, tools) {
        const out = [];
        for (const t of tools || []) {
            const name = t.name ?? t.tool_name;
            if (!name) continue;
            const uiUri = t.uiResourceUri ?? t.ui_resource_uri ?? t._meta?.ui?.resourceUri ?? null;
            const hasUi = t.hasUi !== undefined
                ? Boolean(t.hasUi)
                : (t.has_ui === 1 || t.has_ui === true || Boolean(uiUri));
            const tool = {
                server_id: server.id,
                server_url: server.url,
                server_name: server.name,
                name,
                description: t.description ?? t.tool_description ?? '',
                inputSchema: t.inputSchema ?? t.input_schema ?? null,
                hasUi,
                uiResourceUri: uiUri
            };
            this.tools.set(name, tool);
            out.push(tool);
        }
        return out;
    }
```

- [ ] **Step 5: Syntax check and commit**

Run: `node --check frontend/assets/js/mcp-client.js`
Expected: no output.

```bash
git add frontend/assets/js/mcp-client.js
git commit -m "feat(mcp-client): transport/headers on save, include_disabled, getServerTools, registerTools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 4: `MCPToolTester` — MCPeek-style tool cards

**Files:**
- Create: `frontend/assets/js/mcp-tool-tester.js`
- Test: `frontend/tests/mcp-tool-tester.test.mjs`

**Interfaces:**
- Consumes: `window.mcpClient.registerTools(server, tools)`, `window.mcpClient.callTool(name, args)`, `window.mcpAppHost.createAppFrame(name, container)`.
- Produces: global `MCPToolTester` with
  - `static coerceArgs(tool, values: Record<string,string>): object` — MCPeek coercion (pure).
  - `static buildInputsHtml(tool, prefix: string): string` — MCPeek `getToolInputs` port (pure; ids are `${prefix}-${index}`).
  - `static escape(s): string`
  - `new MCPToolTester({ container: HTMLElement, server, t: (key)=>string })`
  - `render(tools: Tool[]): void` — draws all cards into `container`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/mcp-tool-tester.test.mjs`:

```js
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load() {
  const code = readFileSync(new URL('../assets/js/mcp-tool-tester.js', import.meta.url), 'utf8');
  vm.runInThisContext(code);
  return globalThis.MCPToolTester;
}
const MCPToolTester = load();

const tool = {
  name: 'get_feed',
  description: 'Fetch a feed',
  inputSchema: {
    type: 'object',
    required: ['url', 'limit'],
    properties: {
      url:     { type: 'string',  description: 'Feed URL' },
      limit:   { type: 'integer' },
      verbose: { type: 'boolean' },
      tags:    { type: 'array' },
      opts:    { type: 'object' },
    },
  },
};

test('coerceArgs follows MCPeek rules', () => {
  const args = MCPToolTester.coerceArgs(tool, {
    url: ' https://a.b/rss ', limit: '5', verbose: 'TRUE', tags: 'a, b', opts: '{"x":1}',
  });
  assert.deepStrictEqual(args, {
    url: 'https://a.b/rss', limit: 5, verbose: true, tags: ['a', 'b'], opts: { x: 1 },
  });
});

test('coerceArgs skips empty values and parses JSON arrays', () => {
  const args = MCPToolTester.coerceArgs(tool, { url: '', tags: '[1,2]', opts: 'not json', verbose: '1' });
  assert.deepStrictEqual(args, { tags: [1, 2], opts: 'not json', verbose: true });
});

test('coerceArgs returns {} for tools without properties', () => {
  assert.deepStrictEqual(MCPToolTester.coerceArgs({ name: 'x' }, { a: '1' }), {});
});

test('buildInputsHtml renders one text input per property with required marker', () => {
  const html = MCPToolTester.buildInputsHtml(tool, 'mcp-arg-3-0');
  assert.match(html, /id="mcp-arg-3-0-0"/);
  assert.match(html, /id="mcp-arg-3-0-4"/);
  assert.match(html, /url<span[^>]*>\*<\/span>/);
  assert.match(html, /placeholder="Feed URL"/);
  assert.match(html, /placeholder="integer"/);
  assert.doesNotMatch(html, /verbose<span class="mcp-tool-required"/);
  assert.strictEqual((html.match(/type="text"/g) || []).length, 5);
});

test('buildInputsHtml escapes html in names and descriptions', () => {
  const html = MCPToolTester.buildInputsHtml(
    { name: 'x', inputSchema: { properties: { '<b>': { description: '"q"' } } } }, 'p');
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /placeholder="&quot;q&quot;"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test tests/mcp-tool-tester.test.mjs`
Expected: FAIL — `ENOENT ... mcp-tool-tester.js`.

- [ ] **Step 3: Create `mcp-tool-tester.js`**

```js
/**
 * MCP Tool Tester
 *
 * Port of MCPeek's tool cards (htdocs/mcPeek/index.html: getToolInputs,
 * displayTools, callToolWithInputs, renderMCPContent) for the AI Assistant.
 *
 * Read-only with respect to the tool: the user fills argument inputs and
 * presses "Call Tool"; nothing is persisted. Calls go through
 * window.mcpClient.callTool() (backend proxy: CORS-free, headers applied
 * server-side). MCP App tools render through window.mcpAppHost.
 */
class MCPToolTester {
    /**
     * @param {{container: HTMLElement, server: object, t?: (k:string)=>string}} opts
     */
    constructor({ container, server, t }) {
        this.container = container;
        this.server = server;
        this.t = typeof t === 'function' ? t : (k) => k;
        this.tools = [];
    }

    // ─── pure helpers (unit-tested) ────────────────────────────────────────
    static escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    /**
     * MCPeek getToolInputs(): one text input per top-level property.
     * Ids are `${prefix}-${index}` so odd tool/property names never break
     * querySelector. Property order == Object.entries order.
     */
    static buildInputsHtml(tool, prefix) {
        const props = tool?.inputSchema?.properties;
        if (!props || typeof props !== 'object') return '';
        const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
        const esc = MCPToolTester.escape;
        let html = '';
        Object.entries(props).forEach(([propName, propDef], index) => {
            const isReq = required.includes(propName);
            const def = propDef && typeof propDef === 'object' ? propDef : {};
            const placeholder = def.description || def.type || propName;
            html += `
                <div class="mcp-tool-input">
                    <label for="${prefix}-${index}">${esc(propName)}${isReq ? '<span class="mcp-tool-required">*</span>' : ''}${def.type ? `<span class="mcp-tool-type">${esc(def.type)}</span>` : ''}</label>
                    <input type="text" id="${prefix}-${index}" data-prop="${esc(propName)}"
                           placeholder="${esc(placeholder)}" ${isReq ? 'required' : ''}>
                </div>`;
        });
        return html;
    }

    /**
     * MCPeek callToolWithInputs() coercion. `values` maps propName -> raw
     * string. Empty strings are skipped entirely.
     */
    static coerceArgs(tool, values) {
        const args = {};
        const props = tool?.inputSchema?.properties;
        if (!props || typeof props !== 'object') return args;
        for (const propName of Object.keys(props)) {
            const raw = values?.[propName];
            if (raw === undefined || raw === null) continue;
            const value = String(raw).trim();
            if (!value) continue;
            const type = props[propName]?.type;
            if (type === 'number' || type === 'integer') {
                args[propName] = Number(value);
            } else if (type === 'boolean') {
                args[propName] = value.toLowerCase() === 'true' || value === '1';
            } else if (type === 'array') {
                try { args[propName] = JSON.parse(value); }
                catch { args[propName] = value.split(',').map(s => s.trim()); }
            } else if (type === 'object') {
                try { args[propName] = JSON.parse(value); }
                catch { args[propName] = value; }
            } else {
                args[propName] = value;
            }
        }
        return args;
    }

    // ─── rendering ─────────────────────────────────────────────────────────
    render(tools) {
        this.tools = Array.isArray(tools) ? tools : [];
        if (!this.container) return;
        if (this.tools.length === 0) {
            this.container.innerHTML = `<div class="mcp-tool-empty">${MCPToolTester.escape(this.t('mcpLibrary.noTools'))}</div>`;
            return;
        }
        const esc = MCPToolTester.escape;
        this.container.innerHTML = this.tools.map((tool, idx) => {
            const prefix = `mcp-arg-${this.server.id}-${idx}`;
            const uiBadge = tool.hasUi ? `<span class="mcp-badge mcp-badge-type mcp-badge-app">MCP App</span>` : '';
            return `
                <div class="mcp-tool-card" data-tool-index="${idx}">
                    <div class="mcp-tool-name">${esc(tool.name)}${uiBadge}</div>
                    <div class="mcp-tool-desc">${esc(tool.description || this.t('mcpLibrary.noDescription'))}</div>
                    ${tool.hasUi && tool.uiResourceUri ? `<div class="mcp-tool-ui-uri">🖼️ <code>${esc(tool.uiResourceUri)}</code></div>` : ''}
                    <div class="mcp-tool-inputs">${MCPToolTester.buildInputsHtml(tool, prefix)}</div>
                    <button type="button" class="mcp-btn mcp-btn-primary mcp-tool-call" data-tool-index="${idx}">
                        ▶ ${esc(this.t('mcpLibrary.callTool'))}
                    </button>
                    <div class="mcp-tool-result" id="mcp-result-${this.server.id}-${idx}"></div>
                </div>`;
        }).join('');

        this.container.querySelectorAll('.mcp-tool-call').forEach(btn => {
            btn.addEventListener('click', () => this.callTool(parseInt(btn.dataset.toolIndex, 10)));
        });
    }

    collectValues(idx) {
        const values = {};
        const card = this.container.querySelector(`.mcp-tool-card[data-tool-index="${idx}"]`);
        card?.querySelectorAll('input[data-prop]').forEach(input => { values[input.dataset.prop] = input.value; });
        return values;
    }

    async callTool(idx) {
        const tool = this.tools[idx];
        const resultEl = this.container.querySelector(`#mcp-result-${this.server.id}-${idx}`);
        const btn = this.container.querySelector(`.mcp-tool-call[data-tool-index="${idx}"]`);
        if (!tool || !resultEl) return;

        const args = MCPToolTester.coerceArgs(tool, this.collectValues(idx));
        const requestPayload = {
            jsonrpc: '2.0', method: 'tools/call',
            params: { name: tool.name, arguments: args }
        };

        resultEl.innerHTML = `<div class="mcp-tool-loading">⏳ ${MCPToolTester.escape(this.t('mcpLibrary.calling'))}</div>`;
        if (btn) btn.disabled = true;
        try {
            // Make sure mcpClient knows this tool (server may be disabled or
            // loadAllTools may not have run yet).
            if (!window.mcpClient.getTool(tool.name)) {
                window.mcpClient.registerTools(this.server, [tool]);
            }
            const res = await window.mcpClient.callTool(tool.name, args);
            if (!res.success) {
                resultEl.innerHTML = this.renderError(res.error || 'Tool execution failed', requestPayload, res);
                return;
            }
            resultEl.innerHTML = this.renderResult(res.result, requestPayload);
            if (tool.hasUi && window.mcpAppHost) {
                const appContainer = resultEl.querySelector('.mcp-tool-app');
                if (appContainer) {
                    try {
                        await window.mcpAppHost.createAppFrame(tool.name, appContainer);
                    } catch (err) {
                        appContainer.innerHTML = `<div class="mcp-tool-error">${MCPToolTester.escape(err.message)}</div>`;
                    }
                }
            }
        } catch (err) {
            resultEl.innerHTML = this.renderError(err.message, requestPayload, null);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderError(message, requestPayload, raw) {
        const esc = MCPToolTester.escape;
        return `
            <div class="mcp-tool-error">❌ ${esc(message)}</div>
            ${this.renderRaw(requestPayload, raw)}`;
    }

    renderResult(result, requestPayload) {
        const esc = MCPToolTester.escape;
        const contents = Array.isArray(result?.content) ? result.content : null;
        let body;
        if (contents) {
            body = contents.map((c, i) => this.renderContent(c, i)).join('') ||
                   `<div class="mcp-tool-content">${esc(this.t('mcpLibrary.emptyResult'))}</div>`;
        } else {
            body = `<pre class="mcp-tool-pre">${esc(JSON.stringify(result, null, 2))}</pre>`;
        }
        return `
            <div class="mcp-tool-success">
                <details open>
                    <summary>✅ ${esc(this.t('mcpLibrary.resultTitle'))}${contents ? ` (${contents.length})` : ''}${result?.isError ? ' ⚠️ isError' : ''}</summary>
                    ${body}
                    <div class="mcp-tool-app"></div>
                </details>
                ${this.renderRaw(requestPayload, result)}
            </div>`;
    }

    renderContent(content, index) {
        const esc = MCPToolTester.escape;
        const type = content?.type || 'unknown';
        const n = index > 0 ? ` #${index + 1}` : '';
        if (type === 'text' || (content?.mimeType || '').startsWith('text/')) {
            return `<div class="mcp-tool-content mcp-tool-content-text"><div class="mcp-tool-content-title">📝 Text${n}</div><pre class="mcp-tool-pre">${esc(content.text || '')}</pre></div>`;
        }
        if (type === 'image' || (content?.mimeType || '').startsWith('image/')) {
            const mime = content.mimeType || 'image/png';
            const src = content.data ? `data:${mime};base64,${content.data}` : (content.uri || content.url || '');
            return `<div class="mcp-tool-content mcp-tool-content-image"><div class="mcp-tool-content-title">🖼️ Image${n} (${esc(mime)})</div><img src="${esc(src)}" alt="MCP image content"></div>`;
        }
        if (type === 'resource') {
            const r = content.resource || {};
            const uri = r.uri || content.uri || 'unknown';
            return `<div class="mcp-tool-content mcp-tool-content-resource"><div class="mcp-tool-content-title">📁 Resource${n}</div><code>${esc(uri)}</code>${r.text ? `<pre class="mcp-tool-pre">${esc(r.text)}</pre>` : ''}</div>`;
        }
        return `<div class="mcp-tool-content"><div class="mcp-tool-content-title">📦 ${esc(type)}${n}</div><pre class="mcp-tool-pre">${esc(JSON.stringify(content, null, 2))}</pre></div>`;
    }

    renderRaw(requestPayload, response) {
        const esc = MCPToolTester.escape;
        return `
            <details class="mcp-tool-raw">
                <summary>🔧 ${esc(this.t('mcpLibrary.technicalDetails'))}</summary>
                <div class="mcp-tool-raw-panel"><div class="mcp-tool-raw-title">📤 Request</div><pre class="mcp-tool-pre">${esc(JSON.stringify(requestPayload, null, 2))}</pre></div>
                <div class="mcp-tool-raw-panel"><div class="mcp-tool-raw-title">📥 Response</div><pre class="mcp-tool-pre">${esc(JSON.stringify(response, null, 2))}</pre></div>
            </details>`;
    }
}

if (typeof window !== 'undefined') window.MCPToolTester = MCPToolTester;
else globalThis.MCPToolTester = MCPToolTester;
```

The `.mcp-tool-app` div is always emitted and only filled for UI tools.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node --test tests/mcp-tool-tester.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/assets/js/mcp-tool-tester.js frontend/tests/mcp-tool-tester.test.mjs
git commit -m "feat(mcp): MCPToolTester — MCPeek-style tool cards with param form and call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 5: `MCPLibrary` — sidebar tree and overlay modal

**Files:**
- Create: `frontend/assets/js/mcp-library.js`
- Create: `frontend/assets/css/mcp-library.css`

**Interfaces:**
- Consumes: `window.mcpClient` (Task 3 methods + `deleteServer`, `toggleServer`, `discoverTools`, `setMcpMasterEnabled`, `listMyMcpServers`), `window.MCPToolTester` (Task 4), `window.i18n.t`.
- Produces: global `MCPLibrary`; `new MCPLibrary(t)`, `init()`, `loadTree()`, `openServerForm(serverId | null)`. Element ids it expects are created in Task 6: `mcp-servers-tree`, `mcp-servers-search`, `mcp-servers-new-btn`, `mcp-servers-master-toggle`, `mcp-servers-context-menu`.

- [ ] **Step 1: Create `mcp-library.css`**

```css
/* MCP Servers sidebar collection + overlay (mcp-library.js) */
.mcp-lib-folder { display:flex; align-items:center; gap:4px; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:12px; }
.mcp-lib-folder:hover { background:#f3f4f6; }
.mcp-lib-item { display:flex; align-items:center; justify-content:space-between; gap:4px; padding:4px 8px 4px 24px; border-radius:4px; cursor:pointer; font-size:12px; }
.mcp-lib-item:hover { background:#f3f4f6; }
.mcp-lib-item.is-disabled .mcp-lib-name { color:#9ca3af; text-decoration:line-through; }
.mcp-lib-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.mcp-lib-dot { width:7px; height:7px; border-radius:50%; background:#22c55e; flex:none; }
.mcp-lib-dot.off { background:#d1d5db; }
.mcp-lib-count { color:#9ca3af; font-size:11px; }
.mcp-lib-menu { font-weight:700; padding:0 4px; color:#374151; }

.mcp-badge { display:inline-block; font-size:9px; line-height:1; padding:2px 5px; border-radius:3px; margin-left:4px; text-transform:uppercase; letter-spacing:.02em; }
.mcp-badge-type { background:#e5e7eb; color:#374151; }
.mcp-badge-app  { background:#17a2b8; color:#fff; }
.mcp-badge-transport { background:#eef2ff; color:#3730a3; }
.mcp-badge-mock { background:#fef3c7; color:#92400e; }
.mcp-badge-global { background:#ecfdf5; color:#065f46; }

/* modal */
#mcp-server-modal .mcp-modal-tab { padding:8px 14px; font-size:13px; border-bottom:2px solid transparent; color:#6b7280; }
#mcp-server-modal .mcp-modal-tab.active { color:#1d4ed8; border-color:#1d4ed8; font-weight:600; }
#mcp-server-modal label.mcp-field { display:block; font-size:12px; font-weight:600; color:#374151; margin-top:10px; }
#mcp-server-modal input.mcp-input, #mcp-server-modal textarea.mcp-input, #mcp-server-modal select.mcp-input {
  width:100%; border:1px solid #d1d5db; border-radius:6px; padding:6px 8px; font-size:13px; margin-top:4px; }
#mcp-server-modal textarea.mcp-input { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; min-height:70px; }
#mcp-server-modal .mcp-help { font-size:11px; color:#6b7280; margin-top:4px; }
#mcp-server-modal .mcp-msg { font-size:12px; margin-top:8px; padding:6px 8px; border-radius:6px; }
#mcp-server-modal .mcp-msg.ok { background:#ecfdf5; color:#065f46; }
#mcp-server-modal .mcp-msg.err { background:#fef2f2; color:#991b1b; }

/* tool cards (mcp-tool-tester.js) */
.mcp-tool-card { border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-bottom:12px; background:#fff; }
.mcp-tool-name { font-weight:600; font-size:14px; color:#111827; }
.mcp-tool-desc { font-size:12px; color:#6b7280; margin:4px 0 8px; }
.mcp-tool-ui-uri { font-size:11px; background:#d1ecf1; border-radius:4px; padding:6px; margin-bottom:8px; }
.mcp-tool-input { margin:5px 0; }
.mcp-tool-input label { font-size:12px; color:#4b5563; display:block; }
.mcp-tool-input input { width:100%; padding:4px 6px; margin-top:2px; border:1px solid #d1d5db; border-radius:4px; font-size:12px; }
.mcp-tool-required { color:#dc2626; margin-left:2px; }
.mcp-tool-type { color:#9ca3af; font-size:10px; margin-left:6px; }
.mcp-tool-call { margin-top:8px; }
.mcp-tool-result { margin-top:10px; }
.mcp-tool-loading { font-size:12px; color:#6b7280; }
.mcp-tool-error { background:#fef2f2; color:#991b1b; border-left:4px solid #dc2626; padding:8px; border-radius:4px; font-size:12px; }
.mcp-tool-success { background:#f0fdf4; border-radius:6px; padding:8px; }
.mcp-tool-success summary, .mcp-tool-raw summary { cursor:pointer; font-weight:600; font-size:12px; }
.mcp-tool-content { margin:8px 0; padding:8px; background:#f9fafb; border-radius:6px; border-left:4px solid #3b82f6; }
.mcp-tool-content-image { border-left-color:#22c55e; }
.mcp-tool-content-resource { border-left-color:#17a2b8; }
.mcp-tool-content-title { font-weight:600; font-size:12px; margin-bottom:4px; }
.mcp-tool-content img { max-width:100%; max-height:400px; border-radius:4px; }
.mcp-tool-pre { white-space:pre-wrap; word-break:break-word; font-size:11px; margin:0; background:#f3f4f6; padding:8px; border-radius:4px; max-height:300px; overflow:auto; }
.mcp-tool-raw { margin-top:8px; }
.mcp-tool-raw-panel { margin-top:6px; }
.mcp-tool-raw-title { font-size:11px; font-weight:600; color:#374151; margin-bottom:2px; }
.mcp-tool-app { margin-top:8px; }
.mcp-tool-empty { color:#9ca3af; font-size:12px; text-align:center; padding:16px; }
```

- [ ] **Step 2: Create `mcp-library.js`**

```js
/**
 * MCP Servers Library
 *
 * Sidebar collection listing the caller's MCP servers (own + global), and
 * the overlay modal used to view/edit a server and to test its tools with
 * an MCPeek-style tool tester (mcp-tool-tester.js).
 *
 * Data access goes through window.mcpClient (mcp-client.js); nothing here
 * talks to the backend directly.
 */
class MCPLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.servers = [];
        this.collapsed = new Set();
        this.contextTarget = null;
        this.tester = null;
    }

    init() {
        this.treeContainer = document.getElementById('mcp-servers-tree');
        this.searchInput   = document.getElementById('mcp-servers-search');
        this.newBtn        = document.getElementById('mcp-servers-new-btn');
        this.masterToggle  = document.getElementById('mcp-servers-master-toggle');
        this.contextMenu   = document.getElementById('mcp-servers-context-menu');

        if (this.newBtn)      this.newBtn.addEventListener('click', () => this.openServerForm(null));
        if (this.searchInput) this.searchInput.addEventListener('input', () => this.renderTree());
        if (this.masterToggle) {
            this.masterToggle.addEventListener('change', async () => {
                const res = await window.mcpClient.setMcpMasterEnabled(this.masterToggle.checked);
                if (!res?.success) this.masterToggle.checked = !this.masterToggle.checked;
            });
        }
        if (this.contextMenu) {
            this.contextMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = e.target.closest('[data-action]')?.dataset.action;
                if (!action) return;
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }
        document.addEventListener('click', () => this.hideContextMenu());
    }

    // ─── data ──────────────────────────────────────────────────────────────
    async loadTree() {
        try {
            const [servers, mine] = await Promise.all([
                window.mcpClient.loadServers(true),
                window.mcpClient.listMyMcpServers().catch(() => null),
            ]);
            this.servers = Array.isArray(servers) ? servers : [];
            if (this.masterToggle && mine && typeof mine.mcp_enabled === 'boolean') {
                this.masterToggle.checked = mine.mcp_enabled;
            }
            this.renderTree();
        } catch (err) {
            console.error('[mcpLibrary] loadTree failed:', err);
            if (this.treeContainer) {
                this.treeContainer.innerHTML = `<div class="text-center text-red-500 text-xs py-6">${this.esc(this.t('mcpLibrary.loadFailed'))}</div>`;
            }
        }
    }

    isOwn(server) { return server.user_id !== null && server.user_id !== undefined; }
    getServer(id) { return this.servers.find(s => Number(s.id) === Number(id)); }

    // ─── render ────────────────────────────────────────────────────────────
    renderTree() {
        if (!this.treeContainer) return;
        const q = (this.searchInput?.value || '').toLowerCase().trim();
        const visible = q
            ? this.servers.filter(s => (s.name || '').toLowerCase().includes(q) || (s.url || '').toLowerCase().includes(q))
            : this.servers;
        if (visible.length === 0) {
            this.treeContainer.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.esc(this.t('mcpLibrary.noServers'))}</div>`;
            return;
        }
        const own = visible.filter(s => this.isOwn(s));
        const global = visible.filter(s => !this.isOwn(s));
        this.treeContainer.innerHTML =
            this.renderFolder('own', this.t('mcpLibrary.myServers'), own) +
            this.renderFolder('global', this.t('mcpLibrary.globalServers'), global);
        this.attachListeners();
    }

    renderFolder(key, label, items) {
        const collapsed = this.collapsed.has(key);
        const rows = collapsed ? '' : items.map(s => this.renderRow(s)).join('');
        return `
            <div class="mb-1">
                <div class="mcp-lib-folder" data-folder="${key}">
                    <span class="text-gray-500">${collapsed ? '▶' : '▼'}</span>
                    <span>📁</span>
                    <span class="truncate">${this.esc(label)}</span>
                    <span class="mcp-lib-count">(${items.length})</span>
                </div>
                ${rows}
            </div>`;
    }

    renderRow(s) {
        const enabled = Number(s.enabled) === 1;
        const typeBadge = s.server_type === 'mcp_app'
            ? `<span class="mcp-badge mcp-badge-type mcp-badge-app">App</span>`
            : `<span class="mcp-badge mcp-badge-type">MCP</span>`;
        const transport = `<span class="mcp-badge mcp-badge-transport">${this.esc((s.transport || 'http').toUpperCase())}</span>`;
        const mock = Number(s.is_mock) === 1 ? `<span class="mcp-badge mcp-badge-mock">mock</span>` : '';
        return `
            <div class="mcp-lib-item ${enabled ? '' : 'is-disabled'}" data-server-id="${s.id}" title="${this.esc(s.url || '')}">
                <span class="mcp-lib-dot ${enabled ? '' : 'off'}"></span>
                <span class="mcp-lib-name">${this.esc(s.name || '(unnamed)')}</span>
                ${typeBadge}${transport}${mock}
                <span class="mcp-lib-count">${Number(s.tool_count) || 0}</span>
                <button class="mcp-lib-menu" data-server-id="${s.id}" title="More">⋮</button>
            </div>`;
    }

    attachListeners() {
        this.treeContainer.querySelectorAll('.mcp-lib-folder').forEach(el => {
            el.addEventListener('click', () => {
                const k = el.dataset.folder;
                this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
                this.renderTree();
            });
        });
        this.treeContainer.querySelectorAll('.mcp-lib-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.mcp-lib-menu')) return;
                this.openServerForm(parseInt(el.dataset.serverId, 10));
            });
        });
        this.treeContainer.querySelectorAll('.mcp-lib-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.contextTarget = parseInt(btn.dataset.serverId, 10);
                this.showContextMenu(e);
            });
        });
    }

    // ─── context menu ─────────────────────────────────────────────────────
    showContextMenu(event) {
        if (!this.contextMenu) return;
        const s = this.getServer(this.contextTarget);
        const own = s && this.isOwn(s);
        this.contextMenu.querySelectorAll('[data-action]').forEach(btn => {
            const a = btn.dataset.action;
            if (a === 'toggle') {
                btn.style.display = own ? '' : 'none';
                btn.textContent = Number(s?.enabled) === 1 ? this.t('mcpLibrary.disable') : this.t('mcpLibrary.enable');
            } else if (a === 'delete') {
                btn.style.display = own ? '' : 'none';
            }
        });
        this.contextMenu.style.left = `${event.clientX}px`;
        this.contextMenu.style.top  = `${event.clientY}px`;
        this.contextMenu.classList.remove('hidden');
    }
    hideContextMenu() { this.contextMenu?.classList.add('hidden'); }

    async handleContextAction(action) {
        const s = this.getServer(this.contextTarget);
        if (!s) return;
        if (action === 'edit')   return this.openServerForm(s.id);
        if (action === 'toggle') {
            await window.mcpClient.toggleServer(s.id, Number(s.enabled) !== 1);
            return this.loadTree();
        }
        if (action === 'delete') return this.openServerForm(s.id, { confirmDelete: true });
    }

    // ─── overlay modal ─────────────────────────────────────────────────────
    async openServerForm(serverId, opts = {}) {
        const server = serverId != null ? this.getServer(serverId) : null;
        const isNew = !server;
        const own = isNew || this.isOwn(server);
        const t = this.t;
        document.getElementById('mcp-server-modal')?.remove();

        const headersText = server?.headers && Object.keys(server.headers).length
            ? JSON.stringify(server.headers, null, 2) : '';
        const typeLabel = isNew || !server.tool_count
            ? t('mcpLibrary.typeUnknown')
            : (server.server_type === 'mcp_app' ? 'MCP App' : 'MCP');
        const dis = own ? '' : 'disabled';

        const html = `
        <div id="mcp-server-modal" class="fixed inset-0 z-[200] flex items-center justify-center" style="background-color: rgba(0,0,0,0.5)">
          <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h3 class="text-base font-semibold text-gray-800">🔌 ${this.esc(isNew ? t('mcpLibrary.newServer') : server.name)}
                ${!isNew && !own ? `<span class="mcp-badge mcp-badge-global">${this.esc(t('mcpLibrary.global'))}</span>` : ''}
              </h3>
              <button id="mcp-modal-close" class="text-gray-500 hover:text-gray-800 text-xl leading-none">×</button>
            </div>
            <div class="flex border-b border-gray-200 px-3">
              <button class="mcp-modal-tab active" data-tab="settings">${this.esc(t('mcpLibrary.tabSettings'))}</button>
              <button class="mcp-modal-tab" data-tab="tools" ${isNew ? 'disabled' : ''}>${this.esc(t('mcpLibrary.tabTools'))} <span id="mcp-modal-tool-count" class="mcp-lib-count">(${Number(server?.tool_count) || 0})</span></button>
            </div>
            <div class="flex-1 overflow-y-auto px-5 py-4">
              <div id="mcp-tab-settings">
                <label class="mcp-field">${this.esc(t('mcpLibrary.name'))} *<input id="mcp-f-name" class="mcp-input" ${dis} value="${this.esc(server?.name || '')}"></label>
                <label class="mcp-field">${this.esc(t('mcpLibrary.url'))} *<input id="mcp-f-url" class="mcp-input" ${dis} value="${this.esc(server?.url || '')}" placeholder="https://host/mcp"></label>
                <label class="mcp-field">${this.esc(t('mcpLibrary.description'))}<input id="mcp-f-desc" class="mcp-input" ${dis} value="${this.esc(server?.description || '')}"></label>
                <div class="grid grid-cols-2 gap-4">
                  <label class="mcp-field">${this.esc(t('mcpLibrary.transport'))}
                    <select id="mcp-f-transport" class="mcp-input" ${dis}>
                      <option value="http" ${(server?.transport || 'http') === 'http' ? 'selected' : ''}>Streamable HTTP</option>
                      <option value="sse" ${server?.transport === 'sse' ? 'selected' : ''}>SSE</option>
                    </select>
                    <div class="mcp-help">${this.esc(t('mcpLibrary.transportHelp'))}</div>
                  </label>
                  <div class="mcp-field">${this.esc(t('mcpLibrary.type'))}
                    <div class="mt-2"><span id="mcp-f-type" class="mcp-badge ${server?.server_type === 'mcp_app' ? 'mcp-badge-app' : 'mcp-badge-type'}" style="font-size:11px">${this.esc(typeLabel)}</span></div>
                    <div class="mcp-help">${this.esc(t('mcpLibrary.typeHelp'))}</div>
                  </div>
                </div>
                <label class="mcp-field">${this.esc(t('mcpLibrary.headers'))}<textarea id="mcp-f-headers" class="mcp-input" ${dis} placeholder='{"Authorization": "Bearer ..."}'>${this.esc(headersText)}</textarea></label>
                <label class="mcp-field flex items-center gap-2"><input type="checkbox" id="mcp-f-enabled" ${dis} ${isNew || Number(server.enabled) === 1 ? 'checked' : ''}> ${this.esc(t('mcpLibrary.enabled'))}</label>
                <div id="mcp-f-msg" class="mcp-msg hidden"></div>
                <div class="flex items-center gap-2 mt-4">
                  <button id="mcp-f-test" class="mcp-btn mcp-btn-secondary">${this.esc(t('mcpLibrary.testConnection'))}</button>
                  ${own ? `<button id="mcp-f-save" class="mcp-btn mcp-btn-primary">${this.esc(t('mcpLibrary.save'))}</button>` : ''}
                  <span class="flex-1"></span>
                  ${own && !isNew ? `<button id="mcp-f-delete" class="mcp-btn mcp-btn-secondary" data-armed="0">${this.esc(t('mcpLibrary.delete'))}</button>` : ''}
                </div>
              </div>
              <div id="mcp-tab-tools" class="hidden">
                <div class="flex items-center justify-between mb-3">
                  <span class="text-sm text-gray-600" id="mcp-tools-summary"></span>
                  <button id="mcp-tools-refresh" class="mcp-btn mcp-btn-secondary">🔄 ${this.esc(t('mcpLibrary.refreshTools'))}</button>
                </div>
                <div id="mcp-tools-cards"><div class="mcp-tool-empty">${this.esc(t('mcpLibrary.loadingTools'))}</div></div>
              </div>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        this.bindModal(server, own, isNew);
        if (opts.confirmDelete) document.getElementById('mcp-f-delete')?.click();
    }

    bindModal(server, own, isNew) {
        const modal = document.getElementById('mcp-server-modal');
        const close = () => modal.remove();
        document.getElementById('mcp-modal-close').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        modal.querySelectorAll('.mcp-modal-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                modal.querySelectorAll('.mcp-modal-tab').forEach(b => b.classList.toggle('active', b === btn));
                document.getElementById('mcp-tab-settings').classList.toggle('hidden', btn.dataset.tab !== 'settings');
                document.getElementById('mcp-tab-tools').classList.toggle('hidden', btn.dataset.tab !== 'tools');
                if (btn.dataset.tab === 'tools') this.loadTools(server);
            });
        });

        document.getElementById('mcp-f-test').addEventListener('click', () => this.testConnection());
        document.getElementById('mcp-f-save')?.addEventListener('click', () => this.save(server, isNew));
        document.getElementById('mcp-f-delete')?.addEventListener('click', (e) => this.deleteTwoStep(e.currentTarget, server));
        document.getElementById('mcp-tools-refresh').addEventListener('click', () => this.loadTools(server, /*force*/ true));
    }

    readForm() {
        const g = (id) => document.getElementById(id);
        let headers = null;
        const raw = g('mcp-f-headers').value.trim();
        if (raw) {
            try {
                headers = JSON.parse(raw);
                if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
            } catch {
                return { error: this.t('mcpLibrary.invalidHeaders') };
            }
        }
        return {
            name: g('mcp-f-name').value.trim(),
            url: g('mcp-f-url').value.trim(),
            description: g('mcp-f-desc').value.trim(),
            transport: g('mcp-f-transport').value,
            enabled: g('mcp-f-enabled').checked,
            headers,
        };
    }

    showMsg(text, ok) {
        const el = document.getElementById('mcp-f-msg');
        if (!el) return;
        el.textContent = text;
        el.className = `mcp-msg ${ok ? 'ok' : 'err'}`;
    }

    async testConnection() {
        const f = this.readForm();
        if (f.error) return this.showMsg(f.error, false);
        if (!f.url) return this.showMsg(this.t('mcpLibrary.urlRequired'), false);
        this.showMsg(this.t('mcpLibrary.testing'), true);
        const res = await window.mcpClient.testConnection(f.url, f.headers || {}, f.transport);
        if (res?.success) {
            const info = res.serverInfo ? ` — ${res.serverInfo.name || ''} ${res.serverInfo.version || ''}` : '';
            this.showMsg(this.t('mcpLibrary.connected') + info, true);
        } else {
            this.showMsg((res?.error?.message || res?.error || this.t('mcpLibrary.connectionFailed')), false);
        }
    }

    async save(server, isNew) {
        const f = this.readForm();
        if (f.error) return this.showMsg(f.error, false);
        if (!f.name || !f.url) return this.showMsg(this.t('mcpLibrary.nameUrlRequired'), false);
        const btn = document.getElementById('mcp-f-save');
        btn.disabled = true;
        try {
            let res;
            if (isNew) {
                res = await window.mcpClient.addServer(f.name, f.url, f.description, f.headers || {}, f.transport);
            } else {
                res = await window.mcpClient.updateServer(server.id, f.name, f.url, f.description, f.headers, f.transport);
                if (res?.success && (Number(server.enabled) === 1) !== f.enabled) {
                    await window.mcpClient.toggleServer(server.id, f.enabled);
                }
            }
            if (!res?.success) return this.showMsg(res?.error || this.t('mcpLibrary.saveFailed'), false);
            this.showMsg(this.t('mcpLibrary.saved'), true);
            await this.loadTree();
            // Re-open on the saved server so the Tools tab becomes available
            // (discovery runs in the background inside mcpClient).
            const id = isNew ? Number(res.server_id) : server.id;
            const fresh = this.getServer(id);
            if (fresh) { await this.openServerForm(id); document.querySelector('#mcp-server-modal [data-tab="tools"]')?.click(); }
        } finally {
            btn.disabled = false;
        }
    }

    async deleteTwoStep(btn, server) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = this.t('mcpLibrary.confirmDelete');
            btn.classList.add('text-red-600');
            setTimeout(() => { btn.dataset.armed = '0'; btn.textContent = this.t('mcpLibrary.delete'); btn.classList.remove('text-red-600'); }, 4000);
            return;
        }
        const res = await window.mcpClient.deleteServer(server.id);
        if (!res?.success) return this.showMsg(res?.error || this.t('mcpLibrary.deleteFailed'), false);
        document.getElementById('mcp-server-modal')?.remove();
        await this.loadTree();
    }

    // ─── tools tab ─────────────────────────────────────────────────────────
    async loadTools(server, force = false) {
        if (!server) return;
        const cards = document.getElementById('mcp-tools-cards');
        const summary = document.getElementById('mcp-tools-summary');
        cards.innerHTML = `<div class="mcp-tool-empty">${this.esc(this.t('mcpLibrary.loadingTools'))}</div>`;

        let raw = force ? [] : await window.mcpClient.getServerTools(server.id);
        if (raw.length === 0) {
            const disc = await window.mcpClient.discoverTools(server.url, server.id);
            if (!disc?.success) {
                cards.innerHTML = `<div class="mcp-tool-error">❌ ${this.esc(disc?.error?.message || disc?.error || this.t('mcpLibrary.discoveryFailed'))}</div>`;
                return;
            }
            raw = disc.tools || [];
        }
        const tools = window.mcpClient.registerTools(server, raw);
        if (summary) summary.textContent = this.t('mcpLibrary.toolsFound', { count: tools.length });
        const countEl = document.getElementById('mcp-modal-tool-count');
        if (countEl) countEl.textContent = `(${tools.length})`;
        // Type badge follows discovery (auto-detected).
        const typeEl = document.getElementById('mcp-f-type');
        if (typeEl) {
            const isApp = tools.some(t => t.hasUi);
            typeEl.textContent = isApp ? 'MCP App' : 'MCP';
            typeEl.className = `mcp-badge ${isApp ? 'mcp-badge-app' : 'mcp-badge-type'}`;
            typeEl.style.fontSize = '11px';
        }
        this.tester = new window.MCPToolTester({ container: cards, server, t: this.t });
        this.tester.render(tools);
        if (force) this.loadTree(); // tool_count / server_type changed
    }

    esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
}

window.MCPLibrary = MCPLibrary;
```

- [ ] **Step 3: Syntax check and commit**

Run: `node --check frontend/assets/js/mcp-library.js`
Expected: no output.

```bash
git add frontend/assets/js/mcp-library.js frontend/assets/css/mcp-library.css
git commit -m "feat(mcp): MCPLibrary sidebar tree and server overlay modal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 6: Wire into `index.html`, `chat.js`, i18n

**Files:**
- Modify: `frontend/index.html` (rail ~2263, nav buttons ~2300, views ~2334, context menus ~4048, css tags ~66, script tags ~4130 and ~4169)
- Modify: `frontend/assets/js/chat.js` (element refs ~100, listeners ~465, `applyUserPackage` map ~566, `switchView` ~10363 and ~10467)
- Modify: `frontend/assets/i18n/en.json`, `fr.json`, `es.json`

**Interfaces:**
- Consumes: `MCPLibrary` (Task 5), `MCPToolTester` (Task 4).
- Produces: `switchView('mcp-servers')`; `window.mcpLibrary`.

- [ ] **Step 1: `index.html` markup**

Rail — after the `data-rail-target="agents"` button add:

```html
                <button data-rail-target="mcp-servers"    class="rail-btn" title="MCP Servers"       aria-label="MCP Servers">🔌</button>
```

Nav — after the `#nav-agents` button add:

```html
                        <button id="nav-mcp-servers" class="sidebar-nav-btn text-left px-3 py-2 text-xs font-semibold rounded-md shadow-sm border transition-all">
                            🔌 <span data-i18n="sidebar.mcpServers">MCP Servers</span>
                        </button>
```

Views — after the closing `</div>` of `#agents-view` add:

```html
                    <!-- MCP Servers View (hidden by default) -->
                    <div id="mcp-servers-view" class="h-full hidden bg-gray-200 flex flex-col">
                        <div class="flex-shrink-0 px-2 py-2 border-b border-gray-200 bg-gray-200 flex flex-col gap-2">
                            <div class="flex gap-1 items-center">
                                <button id="mcp-servers-new-btn" class="flex-1 text-blue-600 hover:text-blue-700 text-xs font-medium py-1 px-2 bg-blue-50 hover:bg-blue-100 rounded transition">
                                    ➕ <span data-i18n="mcpLibrary.newServer">New Server</span>
                                </button>
                                <label class="text-xs text-gray-600 flex items-center gap-1 px-1" title="Enable/disable MCP tools for your chats">
                                    <input type="checkbox" id="mcp-servers-master-toggle" checked>
                                    <span data-i18n="mcpLibrary.master">MCP on</span>
                                </label>
                            </div>
                            <input id="mcp-servers-search" type="text" class="w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="Search servers..." data-i18n-placeholder="mcpLibrary.search">
                        </div>
                        <div id="mcp-servers-tree" class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
                            <div class="text-center text-gray-400 text-xs py-6">Loading…</div>
                        </div>
                    </div>
```

Context menu — next to `#agents-context-menu` (~line 4048) add:

```html
    <div id="mcp-servers-context-menu" class="hidden fixed bg-white border border-gray-200 rounded shadow-lg py-1 z-50 text-xs" style="min-width: 140px;">
        <button data-action="edit"   class="block w-full text-left px-3 py-1 hover:bg-gray-100" data-i18n="mcpLibrary.edit">Edit</button>
        <button data-action="toggle" class="block w-full text-left px-3 py-1 hover:bg-gray-100">Enable</button>
        <button data-action="delete" class="block w-full text-left px-3 py-1 hover:bg-gray-100 text-red-600" data-i18n="mcpLibrary.delete">Delete</button>
    </div>
```

(Match the exact classes used on `#agents-context-menu` if they differ; the ids and `data-action` values are what matter.)

Stylesheet — after the `mcp-apps.css` link add:

```html
    <link rel="stylesheet" href="assets/css/mcp-library.css?v=20260904-mcplib">
```

Scripts — change the `mcp-client.js` tag to `?v=20260904-mcplib`, and after the `agents-library.js` tag add:

```html
    <script src="assets/js/mcp-tool-tester.js?v=20260904-mcplib"></script>
    <script src="assets/js/mcp-library.js?v=20260904-mcplib"></script>
```

Also bump `chat.js` to `?v=20260904-mcplib`.

- [ ] **Step 2: `chat.js` wiring**

Element refs (after the Agents library refs ~line 102):

```js
        // MCP servers library elements
        this.navMcpServers = document.getElementById('nav-mcp-servers');
        this.mcpServersView = document.getElementById('mcp-servers-view');
```

Nav listener (after the `navAgents` listener ~line 468):

```js
        if (this.navMcpServers) {
            this.navMcpServers.addEventListener('click', () => this.switchView('mcp-servers'));
        }
```

`applyUserPackage` map — add one entry:

```js
                mcp_servers:     'nav-mcp-servers',
```

`switchView` — in the hide/deactivate block add:

```js
        if (this.mcpServersView) this.mcpServersView.classList.add('hidden');
```
and
```js
        if (this.navMcpServers) this.navMcpServers.classList.remove('active');
```

Then add a branch before `} else if (view === 'file-storage') {`:

```js
        } else if (view === 'mcp-servers') {
            if (this.mcpServersView) this.mcpServersView.classList.remove('hidden');
            if (this.navMcpServers) this.navMcpServers.classList.add('active');

            // Lazy-init the MCP library on first visit, then reload its tree.
            if (!window.mcpLibrary && window.MCPLibrary) {
                window.mcpLibrary = new window.MCPLibrary(
                    (k, p) => (window.i18n?.t ? window.i18n.t(k, p) : k),
                );
                window.mcpLibrary.init();
            }
            window.mcpLibrary?.loadTree();

            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }
```

- [ ] **Step 3: i18n keys**

In each of `en.json`, `fr.json`, `es.json`, inside the top-level `"sidebar"` object (the one at ~line 226 containing `"fileStorage"`), add `"mcpServers"`. Then add a new top-level `"mcpLibrary"` object (place it right after the `"sidebar"` object).

`en.json`:
```json
    "mcpServers": "MCP Servers",
```
```json
  "mcpLibrary": {
    "newServer": "New Server",
    "master": "MCP on",
    "search": "Search servers...",
    "myServers": "My servers",
    "globalServers": "Global servers",
    "global": "global",
    "noServers": "No MCP servers yet.",
    "loadFailed": "Failed to load MCP servers.",
    "edit": "Edit",
    "enable": "Enable",
    "disable": "Disable",
    "delete": "Delete",
    "confirmDelete": "Click again to delete",
    "deleteFailed": "Delete failed",
    "tabSettings": "Settings",
    "tabTools": "Tools",
    "name": "Name",
    "url": "URL",
    "description": "Description",
    "transport": "Transport",
    "transportHelp": "SSE servers are reached through their /mcp POST endpoint. Servers that only answer over the event stream are not supported.",
    "type": "Type",
    "typeHelp": "Auto-detected: MCP App when a tool exposes a UI resource.",
    "typeUnknown": "unknown (discover tools)",
    "headers": "Custom headers (JSON)",
    "enabled": "Enabled",
    "testConnection": "Test connection",
    "testing": "Testing…",
    "connected": "Connected",
    "connectionFailed": "Connection failed",
    "save": "Save",
    "saved": "Saved.",
    "saveFailed": "Save failed",
    "urlRequired": "URL is required",
    "nameUrlRequired": "Name and URL are required",
    "invalidHeaders": "Custom headers must be a JSON object",
    "refreshTools": "Refresh tools",
    "loadingTools": "Loading tools…",
    "discoveryFailed": "Tool discovery failed",
    "toolsFound": "{{count}} tool(s)",
    "noTools": "No tools available",
    "noDescription": "No description",
    "callTool": "Call Tool",
    "calling": "Calling tool…",
    "resultTitle": "Result",
    "emptyResult": "Empty result",
    "technicalDetails": "Technical details"
  },
```

`fr.json`:
```json
    "mcpServers": "Serveurs MCP",
```
```json
  "mcpLibrary": {
    "newServer": "Nouveau serveur",
    "master": "MCP actif",
    "search": "Rechercher des serveurs...",
    "myServers": "Mes serveurs",
    "globalServers": "Serveurs globaux",
    "global": "global",
    "noServers": "Aucun serveur MCP pour le moment.",
    "loadFailed": "Échec du chargement des serveurs MCP.",
    "edit": "Modifier",
    "enable": "Activer",
    "disable": "Désactiver",
    "delete": "Supprimer",
    "confirmDelete": "Cliquer à nouveau pour supprimer",
    "deleteFailed": "Échec de la suppression",
    "tabSettings": "Paramètres",
    "tabTools": "Outils",
    "name": "Nom",
    "url": "URL",
    "description": "Description",
    "transport": "Transport",
    "transportHelp": "Les serveurs SSE sont joints via leur point d'entrée POST /mcp. Les serveurs qui ne répondent que sur le flux d'événements ne sont pas pris en charge.",
    "type": "Type",
    "typeHelp": "Détecté automatiquement : MCP App lorsqu'un outil expose une ressource UI.",
    "typeUnknown": "inconnu (découvrir les outils)",
    "headers": "En-têtes personnalisés (JSON)",
    "enabled": "Activé",
    "testConnection": "Tester la connexion",
    "testing": "Test en cours…",
    "connected": "Connecté",
    "connectionFailed": "Échec de la connexion",
    "save": "Enregistrer",
    "saved": "Enregistré.",
    "saveFailed": "Échec de l'enregistrement",
    "urlRequired": "L'URL est requise",
    "nameUrlRequired": "Le nom et l'URL sont requis",
    "invalidHeaders": "Les en-têtes doivent être un objet JSON",
    "refreshTools": "Actualiser les outils",
    "loadingTools": "Chargement des outils…",
    "discoveryFailed": "Échec de la découverte des outils",
    "toolsFound": "{{count}} outil(s)",
    "noTools": "Aucun outil disponible",
    "noDescription": "Aucune description",
    "callTool": "Appeler l'outil",
    "calling": "Appel en cours…",
    "resultTitle": "Résultat",
    "emptyResult": "Résultat vide",
    "technicalDetails": "Détails techniques"
  },
```

`es.json`:
```json
    "mcpServers": "Servidores MCP",
```
```json
  "mcpLibrary": {
    "newServer": "Nuevo servidor",
    "master": "MCP activo",
    "search": "Buscar servidores...",
    "myServers": "Mis servidores",
    "globalServers": "Servidores globales",
    "global": "global",
    "noServers": "Aún no hay servidores MCP.",
    "loadFailed": "Error al cargar los servidores MCP.",
    "edit": "Editar",
    "enable": "Activar",
    "disable": "Desactivar",
    "delete": "Eliminar",
    "confirmDelete": "Haz clic de nuevo para eliminar",
    "deleteFailed": "Error al eliminar",
    "tabSettings": "Configuración",
    "tabTools": "Herramientas",
    "name": "Nombre",
    "url": "URL",
    "description": "Descripción",
    "transport": "Transporte",
    "transportHelp": "Los servidores SSE se contactan por su endpoint POST /mcp. Los servidores que solo responden por el flujo de eventos no están soportados.",
    "type": "Tipo",
    "typeHelp": "Detectado automáticamente: MCP App cuando una herramienta expone un recurso de UI.",
    "typeUnknown": "desconocido (descubrir herramientas)",
    "headers": "Cabeceras personalizadas (JSON)",
    "enabled": "Activado",
    "testConnection": "Probar conexión",
    "testing": "Probando…",
    "connected": "Conectado",
    "connectionFailed": "Error de conexión",
    "save": "Guardar",
    "saved": "Guardado.",
    "saveFailed": "Error al guardar",
    "urlRequired": "La URL es obligatoria",
    "nameUrlRequired": "El nombre y la URL son obligatorios",
    "invalidHeaders": "Las cabeceras deben ser un objeto JSON",
    "refreshTools": "Actualizar herramientas",
    "loadingTools": "Cargando herramientas…",
    "discoveryFailed": "Error al descubrir herramientas",
    "toolsFound": "{{count}} herramienta(s)",
    "noTools": "No hay herramientas disponibles",
    "noDescription": "Sin descripción",
    "callTool": "Llamar herramienta",
    "calling": "Llamando…",
    "resultTitle": "Resultado",
    "emptyResult": "Resultado vacío",
    "technicalDetails": "Detalles técnicos"
  },
```

- [ ] **Step 4: Validate JSON and JS syntax**

```bash
cd frontend && for f in assets/i18n/en.json assets/i18n/fr.json assets/i18n/es.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('$f ok')"; done
node --check assets/js/chat.js && node --test tests/mcp-tool-tester.test.mjs
```

Expected: three `ok` lines, no `--check` output, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/assets/js/chat.js frontend/assets/i18n/en.json frontend/assets/i18n/fr.json frontend/assets/i18n/es.json
git commit -m "feat(ui): MCP Servers sidebar collection wired into nav, rail, views and i18n

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```

---

### Task 7: Manual end-to-end verification in the browser

**Files:** none modified unless a bug is found (fix it in the file that owns the behaviour and commit with a `fix(mcp): …` message).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Open the app**

Open `http://localhost/gpt/frontend/index.html`, log in, and hard-reload (⌘⇧R) so the `?v=20260904-mcplib` assets load. Open DevTools console; there must be no red errors on load.

- [ ] **Step 2: Sidebar**

Click **🔌 MCP Servers**. Expected: two folders **My servers** and **Global servers**, rows with MCP / App, HTTP / SSE and `mock` badges, tool counts, a green or grey dot. Collapse the sidebar and check the 🔌 rail icon reopens the view.

- [ ] **Step 3: Create a server and discover tools**

Click **New Server**, fill Name `AI news feeds`, URL `http://localhost/AI_mcp/mcp-server.php`, Transport `Streamable HTTP`, click **Test connection** → green "Connected — …". Click **Save**. Expected: modal reopens on the **Tools** tab; tool cards appear (the feed tools of `AI_mcp`), the type badge shows `MCP`, the tree shows the new row with its tool count.

- [ ] **Step 4: Call a tool with typed params**

On a tool that has a numeric parameter (for instance a `limit`), type `3`, leave optional fields empty, click **Call Tool**. Expected: ✅ Result with text content rendered in a `<pre>`, and the **Technical details** panel showing the request with `"limit": 3` (a number, not a string). Enter `a, b` in an `array` parameter of any tool that has one and confirm the request shows `["a","b"]`.

- [ ] **Step 5: Error path**

Change the URL of that server to `http://localhost/does-not-exist`, Save, open Tools, click **Refresh tools**. Expected: a red inline ❌ message, no `alert()`. Restore the URL and Save.

- [ ] **Step 6: MCP App server**

Open a global mock server that has UI tools (`mockstack` or `mockokta`, rows badged **App**). Settings fields are disabled, Save / Delete are hidden, **Test connection** works. On the Tools tab, call a UI tool. Expected: result content plus the app iframe rendered under it by `mcpAppHost`.

- [ ] **Step 7: Delete two-step and disabled servers**

On your own server, click **Delete** once → button text changes to "Click again to delete"; click again → modal closes, row gone. Create it again, then use the ⋮ menu → **Disable**. Expected: the row stays listed with a grey dot and strikethrough, and the Tools tab still works through discovery.

- [ ] **Step 8: Settings modal regression**

Open Settings → MCP tab. Expected: the existing list, add-server form and tools list still work (add a server from there and confirm it shows in the sidebar after clicking the sidebar entry again).

- [ ] **Step 9: Record results**

Append a short "Verification 2026-09-04" section to the bottom of `docs/superpowers/specs/2026-09-04-mcp-servers-collection-design.md` listing each step above with ✅ or the bug found and its fix commit, then:

```bash
git add docs/superpowers/specs/2026-09-04-mcp-servers-collection-design.md
git commit -m "docs(mcp): record manual verification of MCP Servers collection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S9dpzWTmcYsbNaaQhN7uC3"
```
