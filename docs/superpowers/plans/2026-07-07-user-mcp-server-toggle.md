# User-Controlled MCP Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn any MCP server their plan grants on/off for their own account (per-user override), plus a master switch to disable all MCP tools, in Settings → MCP Servers.

**Architecture:** Reuse the existing chat-time cascade (`package allowlist → per-user override → effective`) and the `user_mcp_overrides` table. Add self-scoped `/me/mcp-servers…` endpoints that mirror the admin override methods but always use the JWT user id and are **deny-only** (a user can hide servers their plan grants, never enable ones it forbids). Add a per-user master flag in a new `user_mcp_settings` table that short-circuits `MCPToolsLoader` when off. Frontend adds a master toggle and makes the existing per-server toggle scope-aware (global → `/me/override`, private → existing toggle).

**Tech Stack:** PHP 8 (FastRoute-style router, PDO), vanilla JS frontend, MySQL (shared `netfo587_chatbot` DB).

## Global Constraints

- **Deny-only for users:** the `/me` override path only ever writes `allowed = 0` or deletes the row. It MUST NOT write `allowed = 1`. Re-enabling a server = deleting the override (revert to package default).
- **Self-scoped writes:** every `/me` handler derives the user id from `$request['user_id']` (JWT), never from the request body or path.
- **Package-denied servers are never returned** by `/me/mcp-servers` — a user only sees `(package-allowed globals ∪ own-private)`.
- **Master-off default is ON:** absence of a `user_mcp_settings` row = enabled.
- **No new dependencies.** Match existing patterns: idempotent `CREATE TABLE IF NOT EXISTS`, controller methods returning `['success'=>bool, ..., 'status_code'=>int]`.
- **Shared DB:** the frontend runs on the PHP backend; all changes are PHP + frontend. TypeScript backend is out of scope.

---

## File Structure

- **Modify** `backend/src/Controllers/MCPServerController.php` — add: `ensureMcpSettingsTableExists()`, `isMasterEnabled(int $userId): bool`, `listMine()`, `setMyOverride()`, `clearMyOverride()`, `setMasterSetting()`, and a private `serverAllowedForUser()` helper.
- **Modify** `backend/src/Services/MCPToolsLoader.php` — master-flag short-circuit at the top of `loadToolsForUser()`.
- **Modify** `backend/src/routes.php` — register 4 new user routes.
- **Create** `backend/migrations/add_user_mcp_settings.sql` — idempotent table create (for the shared DB).
- **Modify** `frontend/assets/js/mcp-client.js` — add `listMyMcpServers()`, `disableMyMcpServer()`, `resetMyMcpServer()`, `setMcpMasterEnabled()`.
- **Modify** `frontend/assets/js/settings-panel.js` — `loadMyMcpState()`, master toggle wiring, scope-aware `toggleMCPServer()`, effective-state overlay in `renderMCPServers()`.
- **Modify** `frontend/index.html` — master toggle element at the top of the MCP tab.

**Test strategy (adapted to this codebase):** controllers are DB-backed against a live shared DB with no unit-test seam, so each backend task's deliverable is verified with concrete `curl` calls (JWT from `localStorage.token`) and DB assertions, plus a PHPUnit test for the one pure-logic helper (`serverAllowedForUser`). Frontend tasks are verified manually in the browser. Every task ends with a commit.

**Getting a token for curl (used throughout):** in the browser console on the running app, run `copy(localStorage.token)` (or read it). Export it in the shell: `export TOK=<paste>`. Base URL: `http://localhost/gpt/backend/api/v1`.

---

### Task 1: `user_mcp_settings` table + master-flag read/write

**Files:**
- Create: `backend/migrations/add_user_mcp_settings.sql`
- Modify: `backend/src/Controllers/MCPServerController.php` (constructor calls `ensureTablesExist()` at line 27; add a new ensure method + call it there; add `isMasterEnabled` + `setMasterSetting`)
- Test: `backend/tests/Unit/UserMcpSettingsTest.php` (pure-logic only) + curl verification

**Interfaces:**
- Produces: `MCPServerController::isMasterEnabled(int $userId): bool` (true when no row), `MCPServerController::setMasterSetting(array $request): array` (reads `$request['body']['mcp_enabled']`, `$request['user_id']`).

- [ ] **Step 1: Write the migration file**

Create `backend/migrations/add_user_mcp_settings.sql`:

```sql
-- Per-user master switch for MCP tools. Absent row = enabled (default on).
-- Applies to the shared chatbot DB used by the backend. Idempotent.
CREATE TABLE IF NOT EXISTS `user_mcp_settings` (
  `user_id` BIGINT NOT NULL,
  `mcp_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Per-user MCP master on/off switch';
```

- [ ] **Step 2: Add the idempotent ensure method + call it from the constructor**

In `MCPServerController.php`, find `ensureTablesExist()` (called at line 27). Add a new private method and invoke it inside `ensureTablesExist()` (or add a call right after it in the constructor). Add:

```php
    /** Idempotently create user_mcp_settings (per-user MCP master switch). */
    private function ensureMcpSettingsTableExists(): void
    {
        $this->db->exec("CREATE TABLE IF NOT EXISTS `user_mcp_settings` (
            `user_id` BIGINT NOT NULL,
            `mcp_enabled` TINYINT(1) NOT NULL DEFAULT 1,
            `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    }
```

Then in the constructor (after `$this->ensureTablesExist();` on line 27) add:

```php
        $this->ensureMcpSettingsTableExists();
```

- [ ] **Step 3: Add `isMasterEnabled` + `setMasterSetting`**

Add to `MCPServerController.php`:

```php
    /** True unless the user has an explicit mcp_enabled=0 row. Missing table/row => true. */
    public function isMasterEnabled(int $userId): bool
    {
        try {
            $stmt = $this->db->prepare("SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ?");
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return $row === false ? true : (bool)$row['mcp_enabled'];
        } catch (\PDOException $e) {
            return true; // table absent / transient error => default enabled
        }
    }

    /** PUT /api/v1/me/mcp-settings  body: { "mcp_enabled": bool } */
    public function setMasterSetting(array $request): array
    {
        $userId = (int)($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $body = $request['body'] ?? [];
        if (!array_key_exists('mcp_enabled', $body)) {
            return ['success' => false, 'error' => 'Field "mcp_enabled" is required (boolean).', 'status_code' => 400];
        }
        $enabled = (bool)$body['mcp_enabled'] ? 1 : 0;
        $stmt = $this->db->prepare("
            INSERT INTO user_mcp_settings (user_id, mcp_enabled) VALUES (:uid, :en)
            ON DUPLICATE KEY UPDATE mcp_enabled = VALUES(mcp_enabled), updated_at = CURRENT_TIMESTAMP
        ");
        $stmt->execute([':uid' => $userId, ':en' => $enabled]);
        return ['success' => true, 'mcp_enabled' => (bool)$enabled, 'status_code' => 200];
    }
```

- [ ] **Step 4: Register the route (temporary, to test now)**

In `routes.php` after line 232 (the `DELETE /api/v1/mcp/servers` line), add:

```php
        $r->put('/api/v1/me/mcp-settings', ['MCPServerController', 'setMasterSetting']);
```

- [ ] **Step 5: Verify with curl**

Run:
```bash
curl -s -X PUT http://localhost/gpt/backend/api/v1/me/mcp-settings \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"mcp_enabled": false}'
```
Expected: `{"success":true,"mcp_enabled":false,...}`. Then confirm the row:
```bash
# in mysql: SELECT * FROM user_mcp_settings;  -> one row, mcp_enabled=0
```
Re-run with `{"mcp_enabled": true}` → row flips to 1. Missing field → 400.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/add_user_mcp_settings.sql backend/src/Controllers/MCPServerController.php backend/src/routes.php
git commit -m "feat(mcp): per-user MCP master switch (user_mcp_settings) + setMasterSetting endpoint"
```

---

### Task 2: `MCPToolsLoader` master short-circuit

**Files:**
- Modify: `backend/src/Services/MCPToolsLoader.php` (`loadToolsForUser`, lines 31-120)

**Interfaces:**
- Consumes: `user_mcp_settings` table (Task 1).
- Produces: `loadToolsForUser` returns `[]` when the user's master switch is off.

- [ ] **Step 1: Add the short-circuit**

In `loadToolsForUser()`, immediately after `$this->serverUrls = [];` (line 34), add:

```php
        // Master switch: if the user disabled all MCP, offer zero tools.
        $uid = ($userId !== null && $userId !== '' && is_numeric($userId)) ? (int)$userId : null;
        if ($uid !== null) {
            try {
                $ms = $this->pdo->prepare("SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ?");
                $ms->execute([$uid]);
                $row = $ms->fetch(PDO::FETCH_ASSOC);
                if ($row !== false && (int)$row['mcp_enabled'] === 0) {
                    error_log("[MCP] Master switch OFF for user {$uid} — 0 tools");
                    return $this->tools; // empty
                }
            } catch (\PDOException $e) {
                // table absent / transient => treat as enabled, continue
            }
        }
```

- [ ] **Step 2: Verify with curl (end-to-end tool count)**

With master OFF (`PUT /me/mcp-settings {mcp_enabled:false}` from Task 1), call the providers list which loads MCP tools:
```bash
curl -s http://localhost/gpt/backend/api/v1/providers -H "Authorization: Bearer $TOK" | python3 -c "import sys,json;d=json.load(sys.stdin);print('functions:',d.get('function_count'))"
```
Expected: `function_count` drops (no `mcp_*` tools). Flip master back ON → count returns to include MCP tools. Also confirm the Apache log shows `[MCP] Master switch OFF for user …`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/Services/MCPToolsLoader.php
git commit -m "feat(mcp): master switch short-circuits MCP tool loading"
```

---

### Task 3: `GET /api/v1/me/mcp-servers` (filtered effective list)

**Files:**
- Modify: `backend/src/Controllers/MCPServerController.php` (add `listMine` + private `serverAllowedForUser`)
- Modify: `backend/src/routes.php`
- Test: `backend/tests/Unit/UserMcpSettingsTest.php` (for `serverAllowedForUser` pure logic)

**Interfaces:**
- Consumes: `PackageResolver::allowedMcpServers(int $userId): ?array`, `isMasterEnabled` (Task 1).
- Produces: `listMine(array $request): array` returning `{ success, mcp_enabled, servers:[{id,name,url,is_global,tool_count,effective_on}], status_code }`. Private helper `serverAllowedForUser(array $server, ?array $allowlist): bool` — true if the server is user-private OR (global AND (allowlist===null OR name in allowlist)).

- [ ] **Step 1: Write the failing unit test for `serverAllowedForUser`**

Create `backend/tests/Unit/UserMcpSettingsTest.php`:

```php
<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;

final class UserMcpSettingsTest extends TestCase
{
    private function call(array $server, ?array $allow): bool
    {
        $m = new ReflectionMethod(MCPServerController::class, 'serverAllowedForUser');
        $m->setAccessible(true);
        // Construct without running the DB constructor.
        $obj = (new ReflectionClass(MCPServerController::class))->newInstanceWithoutConstructor();
        return $m->invoke($obj, $server, $allow);
    }

    public function testPrivateServerAlwaysAllowed(): void
    {
        $this->assertTrue($this->call(['name'=>'x','user_id'=>7], ['only-this']));
    }
    public function testGlobalAllowedWhenNoAllowlist(): void
    {
        $this->assertTrue($this->call(['name'=>'g','user_id'=>null], null));
    }
    public function testGlobalGatedByAllowlist(): void
    {
        $this->assertTrue($this->call(['name'=>'g','user_id'=>null], ['g']));
        $this->assertFalse($this->call(['name'=>'g','user_id'=>null], ['other']));
    }
    public function testGlobalDeniedWhenEmptyAllowlist(): void
    {
        $this->assertFalse($this->call(['name'=>'g','user_id'=>null], []));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/UserMcpSettingsTest.php`
Expected: FAIL — `serverAllowedForUser` does not exist.

- [ ] **Step 3: Implement `serverAllowedForUser` + `listMine`**

Add to `MCPServerController.php`:

```php
    /** True if the caller may see this server: private-owned always; global gated by allowlist. */
    private function serverAllowedForUser(array $server, ?array $allowlist): bool
    {
        $isGlobal = ($server['user_id'] ?? null) === null;
        if (!$isGlobal) {
            return true; // user-private (already scoped to this user by the query)
        }
        if ($allowlist === null) {
            return true; // package unrestricted
        }
        return in_array($server['name'], $allowlist, true);
    }

    /** GET /api/v1/me/mcp-servers — the caller's filtered, effective MCP list + master flag. */
    public function listMine(array $request): array
    {
        $userId = (int)($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        $allowlist = (new PackageResolver($this->db))->allowedMcpServers($userId); // null = all

        // Globals + this user's private servers, with tool counts.
        $sql = "SELECT s.id, s.name, s.url, s.user_id, s.enabled, COUNT(t.id) AS tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON t.server_id = s.id
                WHERE s.user_id IS NULL OR s.user_id = :uid
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC";
        $stmt = $this->db->prepare($sql);
        $stmt->bindValue(':uid', (string)$userId);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Overrides for this user.
        $ov = $this->db->prepare("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?");
        $ov->execute([$userId]);
        $overrides = [];
        foreach ($ov->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $overrides[(int)$r['server_id']] = (bool)$r['allowed'];
        }

        $servers = [];
        foreach ($rows as $row) {
            if (!$this->serverAllowedForUser($row, $allowlist)) {
                continue; // package-denied globals never shown
            }
            $isGlobal = $row['user_id'] === null;
            $id = (int)$row['id'];
            // Effective on: private => server.enabled; global => override if set, else on (package grants it).
            if ($isGlobal) {
                $effective = array_key_exists($id, $overrides) ? $overrides[$id] : true;
            } else {
                $effective = (bool)$row['enabled'];
            }
            $servers[] = [
                'id' => $id,
                'name' => $row['name'],
                'url' => $row['url'],
                'is_global' => $isGlobal,
                'tool_count' => (int)$row['tool_count'],
                'effective_on' => (bool)$effective,
            ];
        }

        return [
            'success' => true,
            'mcp_enabled' => $this->isMasterEnabled($userId),
            'servers' => $servers,
            'status_code' => 200,
        ];
    }
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/UserMcpSettingsTest.php`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the route + verify with curl**

In `routes.php`, add after the master-settings route from Task 1:

```php
        $r->get('/api/v1/me/mcp-servers', ['MCPServerController', 'listMine']);
```

Run:
```bash
curl -s http://localhost/gpt/backend/api/v1/me/mcp-servers -H "Authorization: Bearer $TOK" | python3 -m json.tool
```
Expected: `success:true`, a `mcp_enabled` boolean, and a `servers` array where every entry is either global-and-package-allowed or your own private server; each has `effective_on`. No package-denied server appears.

- [ ] **Step 6: Commit**

```bash
git add backend/src/Controllers/MCPServerController.php backend/src/routes.php backend/tests/Unit/UserMcpSettingsTest.php
git commit -m "feat(mcp): GET /me/mcp-servers — filtered effective list + master flag"
```

---

### Task 4: `PUT`/`DELETE /api/v1/me/mcp-servers/{id}/override` (deny-only)

**Files:**
- Modify: `backend/src/Controllers/MCPServerController.php` (add `setMyOverride`, `clearMyOverride`)
- Modify: `backend/src/routes.php`

**Interfaces:**
- Consumes: `serverAllowedForUser` (Task 3), `PackageResolver::allowedMcpServers`.
- Produces: `setMyOverride(array $request, int $serverId): array` (writes `allowed=0` only), `clearMyOverride(array $request, int $serverId): array` (deletes the row).

- [ ] **Step 1: Implement both handlers**

Add to `MCPServerController.php`:

```php
    /** Look up a single visible server for the caller, or null. Enforces the filtered set. */
    private function findVisibleServer(int $userId, int $serverId): ?array
    {
        $stmt = $this->db->prepare("SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?)");
        $stmt->execute([$serverId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $allowlist = (new PackageResolver($this->db))->allowedMcpServers($userId);
        return $this->serverAllowedForUser($row, $allowlist) ? $row : null;
    }

    /** PUT /api/v1/me/mcp-servers/{id}/override  body: { "allowed": false }  (deny-only). */
    public function setMyOverride(array $request, int $serverId): array
    {
        $userId = (int)($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $body = $request['body'] ?? [];
        if (!array_key_exists('allowed', $body)) {
            return ['success' => false, 'error' => 'Field "allowed" is required (boolean).', 'status_code' => 400];
        }
        if ((bool)$body['allowed'] !== false) {
            // Deny-only: re-enabling is done by clearing the override, not force-allow.
            return ['success' => false, 'error' => 'Only disabling is allowed here; DELETE the override to re-enable.', 'status_code' => 400];
        }
        if ($this->findVisibleServer($userId, $serverId) === null) {
            return ['success' => false, 'error' => 'MCP server not available to you', 'status_code' => 404];
        }
        $stmt = $this->db->prepare("
            INSERT INTO user_mcp_overrides (user_id, server_id, allowed) VALUES (:uid, :sid, 0)
            ON DUPLICATE KEY UPDATE allowed = 0, updated_at = CURRENT_TIMESTAMP
        ");
        $stmt->execute([':uid' => $userId, ':sid' => $serverId]);
        return ['success' => true, 'server_id' => $serverId, 'allowed' => false, 'status_code' => 200];
    }

    /** DELETE /api/v1/me/mcp-servers/{id}/override — revert to package default (re-enable). */
    public function clearMyOverride(array $request, int $serverId): array
    {
        $userId = (int)($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $stmt = $this->db->prepare("DELETE FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?");
        $stmt->execute([$userId, $serverId]);
        return ['success' => true, 'server_id' => $serverId, 'cleared' => $stmt->rowCount() > 0, 'status_code' => 200];
    }
```

- [ ] **Step 2: Register the routes**

In `routes.php`, add after the `GET /me/mcp-servers` route:

```php
        $r->put('/api/v1/me/mcp-servers/{serverId:\d+}/override', ['MCPServerController', 'setMyOverride']);
        $r->delete('/api/v1/me/mcp-servers/{serverId:\d+}/override', ['MCPServerController', 'clearMyOverride']);
```

- [ ] **Step 3: Verify deny-only + scoping with curl**

Pick a global, package-allowed `SERVER_ID` from Task 3's output. Then:
```bash
# turn off
curl -s -X PUT http://localhost/gpt/backend/api/v1/me/mcp-servers/SERVER_ID/override \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"allowed":false}'
# -> {"success":true,"allowed":false}   and GET /me/mcp-servers now shows effective_on=false for it
# attempt force-enable (must be rejected)
curl -s -X PUT .../me/mcp-servers/SERVER_ID/override -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"allowed":true}'
# -> 400 "Only disabling is allowed here…"
# re-enable via delete
curl -s -X DELETE http://localhost/gpt/backend/api/v1/me/mcp-servers/SERVER_ID/override -H "Authorization: Bearer $TOK"
# -> {"success":true,"cleared":true}   effective_on back to true
# a server NOT in your package (or nonexistent id) => 404
```
Also confirm with a fresh chat/providers call that a disabled server's `mcp_*` tools disappear from `function_count`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/Controllers/MCPServerController.php backend/src/routes.php
git commit -m "feat(mcp): deny-only per-user override endpoints (PUT/DELETE /me/mcp-servers/{id}/override)"
```

---

### Task 5: Frontend MCP client API methods

**Files:**
- Modify: `frontend/assets/js/mcp-client.js`

**Interfaces:**
- Produces (on `window.mcpClient`): `listMyMcpServers()`, `disableMyMcpServer(id)`, `resetMyMcpServer(id)`, `setMcpMasterEnabled(bool)` — each returns the parsed JSON (`{success,...}`) and uses `window.apiUrl(...)` + the auth header the other methods use.

- [ ] **Step 1: Add the methods**

In `mcp-client.js`, mirror the existing fetch/auth pattern used by `toggleServer` (same headers/`apiBaseUrl`). Add these methods to the class:

```js
    async listMyMcpServers() {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers`, { headers: this._authHeaders() });
        return res.json();
    }
    async disableMyMcpServer(id) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers/${encodeURIComponent(id)}/override`, {
            method: 'PUT', headers: this._authHeaders(), body: JSON.stringify({ allowed: false }),
        });
        return res.json();
    }
    async resetMyMcpServer(id) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers/${encodeURIComponent(id)}/override`, {
            method: 'DELETE', headers: this._authHeaders(),
        });
        return res.json();
    }
    async setMcpMasterEnabled(enabled) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-settings`, {
            method: 'PUT', headers: this._authHeaders(), body: JSON.stringify({ mcp_enabled: !!enabled }),
        });
        return res.json();
    }
```

If `mcp-client.js` has no `_authHeaders()` helper, use the exact header object the existing `toggleServer()` method builds (copy it inline). Verify the base-url property name (`this.apiBaseUrl`) matches the existing methods; if the file uses `window.apiUrl(path)` instead, use that form.

- [ ] **Step 2: Verify in the browser console**

Reload the app, open console:
```js
await window.mcpClient.listMyMcpServers()   // -> {success:true, mcp_enabled, servers:[...]}
await window.mcpClient.setMcpMasterEnabled(false)  // -> {success:true, mcp_enabled:false}
await window.mcpClient.setMcpMasterEnabled(true)
```
Expected: objects as shown; no network 404s.

- [ ] **Step 3: Commit**

```bash
git add frontend/assets/js/mcp-client.js
git commit -m "feat(mcp): frontend client methods for /me MCP endpoints"
```

---

### Task 6: Master toggle UI + settings wiring

**Files:**
- Modify: `frontend/index.html` (MCP tab, after line 2850 — before `#mcp-server-list`)
- Modify: `frontend/assets/js/settings-panel.js` (`loadMyMcpState`, wire toggle, call it from the MCP-tab load path)

**Interfaces:**
- Consumes: `window.mcpClient.listMyMcpServers()`, `setMcpMasterEnabled()` (Task 5).
- Produces: `this.myMcpEnabled` (bool) and `this.myMcpEffective` (`Map<id, {effective_on,is_global}>`) on the settings panel, populated by `loadMyMcpState()`; a working `#mcp-master-toggle` checkbox.

- [ ] **Step 1: Add the master toggle to index.html**

In `index.html`, insert immediately after the MCP description `<p>` (line 2850, before `<!-- Server List -->`):

```html
                        <!-- Master switch: disable all MCP tools for this account -->
                        <label class="flex items-center justify-between gap-3 p-3 mb-3 border border-gray-200 rounded-lg">
                            <span class="text-sm text-gray-800">
                                <strong data-i18n="settings.mcpMasterTitle">Enable MCP tools</strong>
                                <span class="block text-xs text-gray-500" data-i18n="settings.mcpMasterHint">When off, no MCP tools are offered to the AI in your chats.</span>
                            </span>
                            <input type="checkbox" id="mcp-master-toggle" class="w-5 h-5 accent-indigo-600" checked>
                        </label>
```

- [ ] **Step 2: Add `loadMyMcpState()` and wire the toggle in settings-panel.js**

Add a method (near `renderMCPServers`) and call it wherever the MCP tab currently loads data (`loadMCPData()`):

```js
    async loadMyMcpState() {
        this.myMcpEnabled = true;
        this.myMcpEffective = new Map();
        try {
            const data = await window.mcpClient?.listMyMcpServers();
            if (data?.success) {
                this.myMcpEnabled = data.mcp_enabled !== false;
                for (const s of (data.servers || [])) {
                    this.myMcpEffective.set(Number(s.id), { effective_on: !!s.effective_on, is_global: !!s.is_global });
                }
            }
        } catch (e) { console.warn('[settings:mcp] loadMyMcpState failed:', e); }

        const master = document.getElementById('mcp-master-toggle');
        if (master) {
            master.checked = this.myMcpEnabled;
            if (!master.dataset.wired) {
                master.dataset.wired = '1';
                master.addEventListener('change', async () => {
                    const r = await window.mcpClient?.setMcpMasterEnabled(master.checked);
                    if (!r?.success) { master.checked = !master.checked; this.showNotification('Failed to update MCP setting', 'error'); return; }
                    this.myMcpEnabled = master.checked;
                    this.renderMCPServers(); // re-dim list
                });
            }
        }
    }
```

In `loadMCPData()` (the method that currently populates the MCP tab and calls `renderMCPServers`), `await this.loadMyMcpState();` **before** `this.renderMCPServers();`.

- [ ] **Step 3: Verify manually**

Reload → Settings → MCP Servers. The master toggle reflects the stored state; flipping it persists (reload keeps the state) and updates the "functions available" count in a new chat. No console errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/assets/js/settings-panel.js
git commit -m "feat(mcp): master MCP toggle in settings UI"
```

---

### Task 7: Scope-aware per-server toggle + effective overlay

**Files:**
- Modify: `frontend/assets/js/settings-panel.js` (`renderMCPServers` lines 988-1064, `toggleMCPServer` lines 1106-1118)

**Interfaces:**
- Consumes: `this.myMcpEffective`, `this.myMcpEnabled` (Task 6); `window.mcpClient.disableMyMcpServer/resetMyMcpServer/toggleServer`.

- [ ] **Step 1: Drive the toggle visual from effective state + dim when master off**

In `renderMCPServers()`, replace the toggle line (lines 1027-1030) so the `active` class comes from the per-user effective state and the whole list dims when master is off. Compute per server before the return:

```js
            const eff = this.myMcpEffective?.get(Number(server.id));
            const on = eff ? eff.effective_on : !!server.enabled;
```
and change the toggle div to:
```js
                <div class="mcp-server-toggle ${on ? 'active' : ''}"
                     data-server-id="${server.id}"
                     data-is-global="${isGlobal ? '1' : '0'}"
                     title="${on ? 'Disable for me' : 'Enable for me'}">
                </div>
```
Wrap the list container’s opacity: after building `innerHTML`, add:
```js
            if (this.mcpServerList) this.mcpServerList.style.opacity = (this.myMcpEnabled === false) ? '0.45' : '';
```

- [ ] **Step 2: Make `toggleMCPServer` scope-aware**

Replace the body of `toggleMCPServer(serverId)` (lines 1106-1118) with:

```js
    async toggleMCPServer(serverId) {
        const id = parseInt(serverId, 10);
        const eff = this.myMcpEffective?.get(id);
        const server = window.mcpClient?.servers?.get(id);
        const isGlobal = eff ? eff.is_global : (server && (server.user_id === null || server.user_id === undefined || server.user_id === ''));
        const currentlyOn = eff ? eff.effective_on : !!server?.enabled;

        let result;
        if (isGlobal) {
            // Per-user override: off => disable; on => clear override (revert to package default).
            result = currentlyOn
                ? await window.mcpClient?.disableMyMcpServer(id)
                : await window.mcpClient?.resetMyMcpServer(id);
        } else {
            // Private server: existing global enabled toggle.
            result = await window.mcpClient?.toggleServer(id, !currentlyOn);
        }

        if (result?.success) {
            await this.loadMyMcpState();
            await this.loadMCPData(); // refresh servers + tools + re-render
        } else {
            this.showNotification(result?.error || 'Failed to toggle server', 'error');
        }
    }
```

If `loadMCPData()` already calls `loadMyMcpState()` (Task 6 step 2), drop the explicit `loadMyMcpState()` here to avoid a double fetch — keep just `await this.loadMCPData()`.

- [ ] **Step 3: Verify manually (the original bug)**

Reload → Settings → MCP Servers:
1. Toggle a **global** server off → it shows off, persists across reload, and its tools drop from a new chat's "functions available". Toggle on → returns. (This is the behavior that was broken.)
2. Toggle a **private** server → unchanged behavior still works.
3. Turn the master off → list dims and all MCP tools are gone from chat; turn on → restored.
No console errors, page never blanks.

- [ ] **Step 4: Commit**

```bash
git add frontend/assets/js/settings-panel.js
git commit -m "feat(mcp): scope-aware per-server toggle (global => per-user override) + effective overlay"
```

---

### Task 8: End-to-end verification + spec cross-check

**Files:** none (verification only)

- [ ] **Step 1: Full manual pass**

- Master off → new chat shows 0 MCP tools; master on → tools return.
- Disable two global servers → only those servers' tools vanish; others remain.
- Reload the app → all choices persisted.
- Confirm a package-denied server never appears in the list (compare against `GET /me/mcp-servers`).
- Confirm another user's overrides are untouched (spot-check `user_mcp_overrides` rows are scoped to your user_id).

- [ ] **Step 2: Run the unit test suite for the new file**

Run: `cd backend && ./vendor/bin/phpunit tests/Unit/UserMcpSettingsTest.php`
Expected: PASS.

- [ ] **Step 3: Commit any doc updates**

```bash
git add -A && git commit -m "docs(mcp): mark user-controlled MCP servers feature complete" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Per-user off for globals → Tasks 3/4/7. ✓
- Filtered list (package-allowed only) → Task 3 `serverAllowedForUser` + `listMine`. ✓
- On = clear override → Task 4 `clearMyOverride`, Task 7 toggle. ✓
- Master switch → Tasks 1/2/6. ✓
- Deny-only security → Task 4 rejects `allowed:true`; list never returns denied servers (Task 3). ✓
- New `user_mcp_settings` table (idempotent) → Task 1. ✓
- Cascade unchanged, one short-circuit → Task 2. ✓
- Private servers keep existing toggle → Task 7. ✓
- Frontend UI + client methods → Tasks 5/6/7. ✓

**Placeholder scan:** none — every code step has concrete code; verification steps give exact curl/commands.

**Type consistency:** `serverAllowedForUser(array,?array):bool`, `isMasterEnabled(int):bool`, `listMine`/`setMyOverride`/`clearMyOverride`/`setMasterSetting` signatures match across Tasks 1/3/4 and the routes in Task 4. Frontend `myMcpEffective` Map shape (`{effective_on,is_global}`) is consistent between Tasks 6 and 7. Client method names (`listMyMcpServers/disableMyMcpServer/resetMyMcpServer/setMcpMasterEnabled`) match between Tasks 5, 6, 7.

**Open item for the implementer to confirm at Task 5:** the exact auth-header/base-url accessor in `mcp-client.js` (`this.apiBaseUrl` + header object) — copy whatever `toggleServer()` uses rather than assuming.
