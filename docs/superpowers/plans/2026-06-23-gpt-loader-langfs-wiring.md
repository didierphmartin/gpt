# gpt loader ↔ langfs wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire gpt's ingestion loader node to the langfs MCP server: the loader form lists all 10 providers from langfs `list_providers` (`local` enabled, the other 9 disabled/"coming soon"), the read path is **scoped** to the langfs server, and `read_file`'s text flows straight through (no PHP re-decode) — so `local` files ingest end-to-end through langfs.

**Architecture:** Frontend renders the provider list dynamically from `list_providers` instead of a hard-coded array. Backend `buildLoaderClosures` is scoped to the chosen storage server (via the existing `loadToolsForUser($userId, $allowedServerNames)` filter) to avoid the `list_files`/`read_file` tool-name collision between UniversalFS and langfs. The `read_file` closure consumes langfs's `{content, format}` text payload and `loadFile` returns it without `decode()`.

**Tech Stack:** PHP (`IngestionController`, `IngestionLoader`, `MCPToolsLoader`), vanilla JS (`workflow-editor.js`), the running langfs MCP server.

**Spec:** `docs/superpowers/specs/2026-06-22-langfs-ingestion-integration-design.md` §4.

## Global Constraints

- **langfs must be registered + running** (`http://127.0.0.1:8077/`) for live verification; it exposes `list_providers`, `list_files`, `read_file` (text-out), `test_connection`, `read_next`, `reset`.
- **Read format = text.** langfs `read_file` returns `{"content": <text>, "format": "text"}` (JSON in the MCP text envelope; `$res['result']` is that JSON string). The PHP closure must `json_decode` and take `content`. `decode()` must NOT run on already-extracted text.
- **Scope dispatch to one server.** `buildLoaderClosures` must target the loader's chosen storage server so it never hits UniversalFS's `list_files`/`read_file` by accident. Use `MCPToolsLoader::loadToolsForUser($userId, [$serverName])`.
- **Provider list is dynamic** from `list_providers`; `local` selectable, the 9 with `available:false` rendered **disabled** ("coming soon"). No hard-coded provider array.
- **No JS unit-test harness exists** — frontend tasks verify by running the app and inspecting the modal (screenshot). Backend tasks verify with a PHP CLI script.
- **Existing config shape preserved:** `{types[], path, is_dir, workers, disabled, storage_mcp_id, storage_mcp_url, provider, ufskey?}` (+ `storage_mcp_name` added in Task 3).

---

## File Structure

```
gpt/
  backend/src/AgentTeam/Controllers/IngestionController.php   # buildLoaderClosures scoping + readFile text  (modify)
  backend/src/AgentTeam/Services/IngestionLoader.php          # loadFile passthrough (text-native)            (modify)
  backend/scripts/test-loader-langfs.php                      # CLI verification against live langfs          (create)
  frontend/assets/js/workflow-editor.js                       # dynamic provider render + storage_mcp_name     (modify)
```

---

### Task 1: Backend — `read_file` text + `loadFile` passthrough

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php` (`buildLoaderClosures`, the `$readFile` closure, ~lines 1212–1227)
- Modify: `backend/src/AgentTeam/Services/IngestionLoader.php` (`loadFile`, ~lines 200–204)
- Create: `backend/scripts/test-loader-langfs.php`

**Interfaces:**
- Consumes: langfs `read_file` returning `{"content","format"}` JSON in `$res['result']`.
- Produces: `$readFile(provider, fileId)` returns **text**; `IngestionLoader::loadFile($readFile, $descriptor)` returns that text **without** calling `decode()`.

- [ ] **Step 1: Write a failing CLI check**

Create `backend/scripts/test-loader-langfs.php`:
```php
<?php
// Live check: enumerate + read a local file through langfs via MCPToolsLoader.
// Requires langfs running on 8077 and registered for the user below.
require __DIR__ . '/../vendor/autoload.php';
$root = sys_get_temp_dir() . '/langfs_loader_demo';
@mkdir($root, 0777, true);
file_put_contents($root . '/hello.txt', 'hello through langfs');

$db = require __DIR__ . '/_db.php';            // returns a PDO (see existing scripts for the pattern)
$userId = $argv[1] ?? '1';                     // pass the user id that registered langfs

$ctrl = new \AgentTeam\Controllers\IngestionController($db);
$ref = new ReflectionMethod($ctrl, 'buildLoaderClosures');
$ref->setAccessible(true);
[$listFiles, $readFile] = $ref->invoke($ctrl, $userId, 'langfs');   // server-scoped (Task 2)

$listed = $listFiles('local', $root);
echo "files: " . json_encode($listed) . "\n";
$first = $listed['files'][0]['id'] ?? null;
$text  = $readFile('local', $first);
echo "read_file text: '" . $text . "'\n";
assert($text === 'hello through langfs');
echo "OK\n";
```
(If `_db.php` doesn't exist, mirror the PDO bootstrap used by `backend/scripts/test-ingestion-loader.php`.)

- [ ] **Step 2: Run it to see the current failure**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && php backend/scripts/test-loader-langfs.php 1`
Expected: FAIL — `buildLoaderClosures` doesn't yet accept a second arg (Task 2) and/or `read_file` text causes `base64_decode` to return `false` → "read_file did not return valid base64". (This script also drives Task 2; both land before it passes.)

- [ ] **Step 3: Change the `$readFile` closure to consume text**

In `IngestionController::buildLoaderClosures`, replace the `$readFile` closure body (the `encoding => 'base64'` call + `base64_decode`) with a text consumer:
```php
        // langfs read_file returns {"content": <text>, "format": "text"} as JSON in result.
        $readFile = static function (string $provider, string $fileId) use ($mcp): string {
            $res = $mcp->executeTool('read_file', [
                'provider' => $provider,
                'file_id'  => $fileId,
                'format'   => 'text',
            ]);
            if (!empty($res['error'])) {
                throw new \RuntimeException((string) ($res['message'] ?? 'read_file failed'));
            }
            $decoded = json_decode((string) ($res['result'] ?? ''), true);
            if (!is_array($decoded) || !array_key_exists('content', $decoded)) {
                throw new \RuntimeException('read_file did not return {content,format}');
            }
            if (!empty($decoded['error'])) {
                throw new \RuntimeException((string) ($decoded['message'] ?? 'read_file error'));
            }
            return (string) $decoded['content'];
        };
```

- [ ] **Step 4: Make `loadFile` text-native (skip decode)**

In `IngestionLoader::loadFile`, return the closure's text directly (langfs already extracted it; `decode()` would mis-parse a PDF's text):
```php
    public static function loadFile(callable $readFile, array $descriptor): string
    {
        // langfs returns already-extracted text; no decode needed.
        return $readFile($descriptor['provider'], $descriptor['file_id']);
    }
```
Leave `decode()` in the class (now unused by the langfs path; full removal is a follow-up per spec §5).

- [ ] **Step 5: Run the CLI check (after Task 2 lands too)**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && php backend/scripts/test-loader-langfs.php 1`
Expected: `read_file text: 'hello through langfs'` then `OK`. (Requires Task 2's scoping; if running Task 1 alone, temporarily call `buildLoaderClosures($userId)` without the second arg and ensure only langfs is registered.)

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/AgentTeam/Controllers/IngestionController.php backend/src/AgentTeam/Services/IngestionLoader.php backend/scripts/test-loader-langfs.php
git commit -m "feat(ingestion): consume langfs read_file text; loadFile passthrough (no re-decode)"
```

---

### Task 2: Backend — scope `buildLoaderClosures` to the chosen storage server

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php` (`buildLoaderClosures` ~line 1194; its ~6 call sites)

**Interfaces:**
- Consumes: `MCPToolsLoader::loadToolsForUser(?string $userId, ?array $allowedServerNames)`; the loader config's `storage_mcp_id`.
- Produces: `buildLoaderClosures($userId, ?string $storageMcpId = null): array` — when `$storageMcpId` resolves to a server, only that server's tools load, so `executeTool('list_files'|'read_file')` dispatches to langfs unambiguously.

- [ ] **Step 1: Add scoping to `buildLoaderClosures`**

Change the signature and the `loadToolsForUser` call:
```php
    private function buildLoaderClosures($userId, ?string $storageMcpId = null): array
    {
        $mcp = new MCPToolsLoader($this->db);
        $allowed = null;
        if ($storageMcpId !== null && $storageMcpId !== '') {
            $stmt = $this->db->prepare("SELECT name FROM mcp_servers WHERE id = ?");
            $stmt->execute([$storageMcpId]);
            $name = $stmt->fetchColumn();
            if ($name !== false) {
                $allowed = [(string) $name];   // scope dispatch to this server only
            }
        }
        $mcp->loadToolsForUser((string) $userId, $allowed);
        // ... existing $listFiles / $readFile closures unchanged from here ...
```
Keep the `$listFiles` closure as-is (langfs `list_files` already returns `{files:[...]}` which `json_decode` handles); keep the Task-1 `$readFile` text closure.

- [ ] **Step 2: Pass the storage id at every call site**

Find each `buildLoaderClosures($userId)` call (≈ lines 182, 243, 342, 477, 727, 809 — confirm with `grep -n 'buildLoaderClosures' IngestionController.php`). Each lives where the loader config (`$loaderCfg`/`$cfg`/`$config`) is already in scope. Change each to pass the storage id, e.g.:
```php
[$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($loaderCfg['storage_mcp_id'] ?? ''));
```
Use the correct local config variable name at each site (the one holding `storage_mcp_id`).

- [ ] **Step 3: Run the CLI check**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && php backend/scripts/test-loader-langfs.php 1`
Expected: `OK` — even with UniversalFS also registered, scoping to `langfs` makes `list_files`/`read_file` resolve to langfs. (Register langfs under the name `langfs` for this to match; see Task 3 for the UI naming.)

- [ ] **Step 4: Verify no unscoped call remains**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt && grep -n 'buildLoaderClosures(' backend/src/AgentTeam/Controllers/IngestionController.php`
Expected: the definition takes `($userId, ?string $storageMcpId = null)`, and every call passes a second argument.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add backend/src/AgentTeam/Controllers/IngestionController.php
git commit -m "feat(ingestion): scope buildLoaderClosures to the chosen storage MCP server (avoids list_files collision)"
```

---

### Task 3: Frontend — dynamic 10-provider list + langfs storage targeting

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` (`_wireLoaderStorageAndProvider` ~6123–6255; `_readIngestionFormConfig` ~7211–7266)

**Interfaces:**
- Consumes: `window.mcpClient.callTool('list_providers', {})` → `_parseListProviders` (now returning `{name, available}` per entry); `#ingestion-loader-provider-host`.
- Produces: provider radios rendered from `list_providers` — `local` enabled/checked, `available:false` providers **disabled** with "(coming soon)". `storage_mcp_name` added to the saved config.

- [ ] **Step 1: Extend `_parseListProviders` to keep availability**

Update `_parseListProviders` so each returned entry is `{name, available}` (default `available:true` for legacy string entries). The langfs payload entries are objects with `name` + `available`; map them to `{name: e.name, available: e.available !== false}`. Keep the existing four input-shape handling.

- [ ] **Step 2: Render providers dynamically from `list_providers`**

In `_wireLoaderStorageAndProvider`, replace the static render (the `this._ufsKnownProviders.map(...)` into `#ingestion-loader-provider-host`) with a render driven by the fetched provider list. Default to `[{name:'local', available:true}]` until `list_providers` returns, then re-render. Each radio:
```js
providerHost.innerHTML = providers.map(p => {
    const disabled = !p.available;
    const checked  = (p.name === savedProvider && !disabled) ? 'checked' : '';
    const suffix   = disabled ? ' (coming soon)' : '';
    return `<label class="ingestion-loader-provider-radio${disabled ? ' disabled' : ''}" `
        + `style="display:inline-flex;align-items:center;gap:6px;margin-right:14px;${disabled ? 'opacity:.5;' : ''}">`
        + `<input type="radio" name="ingestion-loader-provider" value="${this.escapeHtml(p.name)}" ${checked} ${disabled ? 'disabled' : ''}>`
        + `<span data-prov="${this.escapeHtml(p.name)}">${this.escapeHtml(p.name)}${suffix}</span></label>`;
}).join('');
```
If no enabled radio ends up checked, check the first enabled one (`local`). Remove reliance on `_ufsKnownProviders` for the render (leave the getter or delete it; it's no longer the source of truth). The `list_providers` result is now **authoritative for the list**, not just for "(needs key)" labels.

- [ ] **Step 3: Persist `storage_mcp_name` so the backend can scope**

The backend resolves the server name from `storage_mcp_id`, so no new field is strictly required — but capture the chosen server's **name** for clarity and to let the user pick langfs. In `_readIngestionFormConfig`, alongside `storage_mcp_id`/`storage_mcp_url`, also set `cfg.storage_mcp_name` from the storage picker (the `<select>` option text or the hidden input's `data-name`). This is informational; the backend keys off `storage_mcp_id`.

- [ ] **Step 4: Target langfs as the storage server**

Ensure the langfs MCP server is selectable as file storage. Register it in gpt Settings with a name containing a storage keyword (e.g. **`langfs`** or `langfs-filesystem`) so `_isFileStorageMcpServer` (regex on name/description/url incl. `filesystem`) includes it. Pick it in the loader's storage picker. (No code change if the name matches the regex; otherwise broaden `_isFileStorageMcpServer` to also match `langfs`.)

- [ ] **Step 5: Verify in the browser (no JS test harness)**

Hard-refresh (Cmd-Shift-R, 2–3 times per the cache-refresh note), open a workflow, add/open the **Loader** node:
- Storage picker lists the langfs server; select it.
- Provider list shows **10** entries: `local` enabled + checked; `s3/gcs/azure/drive/onedrive/sharepoint/dropbox/box/github` rendered **disabled** with "(coming soon)".
- Confirm via DevTools that the radios came from `list_providers` (10 `data-prov` spans), not the old 4.

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/workflow-editor.js
git commit -m "feat(loader-ui): render provider list dynamically from langfs list_providers (10 listed, local enabled)"
```

---

### Task 4: End-to-end — ingest local files through langfs

**Files:** none (verification task).

**Interfaces:** Consumes Tasks 1–3 + the running langfs server.

- [ ] **Step 1: Prepare a demo folder under the langfs root**

The running langfs uses `LANGFS_ROOTS`. Put a couple of files there:
```bash
mkdir -p /tmp/langfs_demo && printf 'first doc' > /tmp/langfs_demo/a.txt && printf 'second doc' > /tmp/langfs_demo/b.txt
```
(If langfs was started with a different `LANGFS_ROOTS`, use that folder, or restart langfs with `LANGFS_ROOTS=/tmp/langfs_demo`.)

- [ ] **Step 2: Drive the loader preview in the app**

In the Loader node: storage = langfs, provider = `local`, path = `/tmp/langfs_demo`, check the `Text (.txt)` type. Open the **Output** tab and step Prev/Next.
Expected: file count = 2; the Output shows `first doc` / `second doc` as extracted text — read **through langfs** (`POST /mcp` `list_files`/`read_file` visible in the langfs server log).

- [ ] **Step 3: Confirm langfs served the requests**

Run: `tail -n 20` on the langfs server log (the background task output file) — expect `POST /mcp ... 200` lines coinciding with the preview, and no `read_file did not return valid base64` errors.

- [ ] **Step 4: Run a full ingestion (optional, if a vector store node is configured)**

If the workflow has splitter + store nodes wired, run the ingestion and confirm chunks are stored, with the loader text sourced from langfs.

- [ ] **Step 5: Commit a short verification note**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
# (no code; optionally record the result in the plan's ledger / a CHANGELOG if the repo keeps one)
```

---

## Self-Review

**Spec coverage (§4):**
- §4.1 dynamic provider list (10, local enabled, 9 disabled) + storage targets langfs → Task 3. ✓
- §4.2 backend point-at-langfs; `read_file` text → `decode()` passthrough → Task 1. ✓
- Tool-name collision (not in spec but discovered) → Task 2 (server-scoping). ✓
- End-to-end local ingestion through langfs → Task 4. ✓

**Placeholder scan:** none — concrete PHP/JS in every step. The CLI script's `_db.php` bootstrap defers to the existing script pattern (named, not vague).

**Type consistency:** `buildLoaderClosures($userId, ?string $storageMcpId)` defined in Task 2, used by the Task-1 CLI script and all call sites (Task 2 Step 2). `$readFile` returns text (Task 1) consumed by `loadFile` passthrough (Task 1 Step 4). `_parseListProviders` → `{name, available}` defined in Task 3 Step 1, consumed by the render in Step 2. `storage_mcp_id` is the scoping key throughout. ✓

**Note on testing:** backend tasks are verified by a live CLI script against the running langfs (the gpt backend has script-based, not phpunit, ingestion checks); frontend tasks are verified in-browser (no JS unit harness). This matches the existing project conventions.
