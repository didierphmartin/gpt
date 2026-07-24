# User-Controlled MCP Servers — Design

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Area:** gpt backend (PHP) + gpt frontend

## Goal

Let an end user, in **Settings → MCP Servers**, turn any MCP server their plan grants them **on or off for their own account**, plus a **master switch** to disable all MCP tools at once. Off means the server's tools are not offered to the AI in that user's conversations. Nothing the user does affects other users or the admin's global configuration.

## Current state (what already exists)

- **Chat-time cascade** (`MCPToolsLoader::loadToolsForUser`): `package allowlist → per-user override → effective`. Per-user overrides are already read from `user_mcp_overrides` and applied when loading tools for a conversation.
- **`user_mcp_overrides`** table: `(id, user_id, server_id, allowed tinyint, created_at, updated_at)`, unique `(user_id, server_id)`. `allowed=1` force-include, `allowed=0` force-exclude, no row = package default.
- **Admin** can already toggle any server for any user: `PUT/DELETE /api/v1/admin/users/{id}/mcp-servers/{serverId}/override` (`AdminController::setUserMCPOverride` / `clearUserMCPOverride`), surfaced in `gpt_admin` `UserMcpServersPanel.tsx`.
- **Users** can already add/edit/delete/toggle their **own private** MCP servers (`MCPServerController`, `POST /api/v1/mcp/servers/toggle` — filters `user_id = ?`).
- `PackageResolver::allowedMcpServers($userId)` returns the role allowlist: `null` = all globals, `array` = whitelist of names, `[]` = none.

## The gap

A regular user cannot turn a **global** MCP server off for themselves. There is no user-scoped endpoint and no UI toggle for globals, and no master switch. This design adds the self-service equivalent of the admin override, scoped to the caller.

## Semantics (agreed)

- The **package defines the universe** of servers available to the user (allowlist). The user sees only that filtered list **plus their own private servers**.
- Within that list the user flips each server **on ↔ off**:
  - **Off** → write `user_mcp_overrides.allowed = 0` for `(caller, server)`.
  - **On** → **delete** the override row → revert to package default (which is "on", since the package grants it).
- **Master switch off** → no MCP tools offered at all, regardless of per-server state.
- **Package-denied servers are never shown.** Because the user only ever sees/toggles servers inside `(package-allowed globals ∪ own-private)`, they can never enable a server outside their package. The old "force-enable beyond package = privilege escalation" risk is structurally impossible — no special guard beyond scoping every write to that set.

## Design

### Data model

- **Reuse** `user_mcp_overrides` for per-server state (no schema change). User-facing writes only ever set `allowed=0` or delete the row — never `allowed=1`.
- **New** `user_mcp_settings` table for the master flag, created idempotently in the same style as `user_category_settings` / `user_memory_settings` (via `CREATE TABLE IF NOT EXISTS` in the controller):
  ```sql
  CREATE TABLE IF NOT EXISTS `user_mcp_settings` (
    `user_id` bigint NOT NULL PRIMARY KEY,
    `mcp_enabled` tinyint(1) NOT NULL DEFAULT 1,
    `updated_at` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB;
  ```
  Absent row = enabled (default on).

### Backend endpoints (new, user-scoped — user id always from JWT, never from the path)

Added to `src/routes.php`, handled by `MCPServerController` (user-facing controller; add methods) reusing the admin override logic:

- `GET /api/v1/me/mcp-servers` → the filtered list for the caller:
  `{ mcp_enabled: bool, servers: [ { id, name, is_global, tool_count, effective_on: bool } ] }`
  where `servers` = package-allowed globals ∪ caller's private servers, and `effective_on` folds in the per-user override / private `enabled`. (Mirrors `AdminController::getUserMCPServers`, self-scoped; excludes package-denied globals.)
- `PUT /api/v1/me/mcp-servers/{serverId}/override` `{ allowed: false }` → turn a **global** server off for the caller (upsert `allowed=0`). Rejects `serverId` not in the caller's allowed set (404). Only `allowed:false` is accepted.
- `DELETE /api/v1/me/mcp-servers/{serverId}/override` → clear the caller's override (revert to package default = on).
- `PUT /api/v1/me/mcp-settings` `{ mcp_enabled: bool }` → upsert `user_mcp_settings` for the caller.

Private servers keep their **existing** toggle (`POST /api/v1/mcp/servers/toggle`, `enabled` column). The frontend picks the endpoint by scope.

Shared logic: extract the override upsert/delete used by `AdminController` into a small helper (or a thin service) so the `/me` and `/admin` paths stay in sync. The `/me` variant hardcodes `user_id = caller` and enforces "server must be in caller's allowed set".

### Master-switch enforcement

- `MCPToolsLoader::loadToolsForUser($userId, $allowlist)`: at the top, if `$userId` and `user_mcp_settings.mcp_enabled = 0` → return `[]` immediately (no MCP tools). One indexed read.
- `ProviderController::list()` uses the same loader, so the "N functions available" count in the UI stays consistent when master is off.

### Frontend (Settings → MCP Servers tab)

- **Master toggle** at the top of the tab: "MCP servers — on/off. When off, no MCP tools are offered to the AI in your chats." Calls `PUT /me/mcp-settings`.
- **Per-server list** (`settings-panel.js` `renderMCPServers`): fetch from `GET /me/mcp-servers`. Each row shows name, scope badge (🌐 Global / 👤 Yours), tool count, and an on/off toggle.
  - Global row toggle → `PUT/DELETE /me/mcp-servers/{id}/override`.
  - Private row toggle → existing `POST /mcp/servers/toggle`.
  - When master is off, the list renders dimmed/disabled (informational only).
- No "restricted/locked" rows — package-denied globals are simply absent.

### Frontend JS API (`mcp-client.js`)

- `listMyMcpServers()` → `GET /me/mcp-servers`
- `disableMyMcpServer(id)` → `PUT /me/mcp-servers/{id}/override {allowed:false}`
- `resetMyMcpServer(id)` → `DELETE /me/mcp-servers/{id}/override`
- `setMcpMasterEnabled(bool)` → `PUT /me/mcp-settings {mcp_enabled}`

### Data flow (unchanged cascade + one short-circuit)

`master flag (short-circuit if off) → package allowlist → per-user override → effective`

## Edge cases

- **New global server added later**: no override row → defaults on for users whose package allows it; master-off still hides it.
- **Package allowlist `[]`**: user sees only their private servers (no globals to toggle).
- **Server the user turned off is later removed from their package**: the stale `allowed=0` row is harmless (server no longer in the filtered list); optional cleanup out of scope.
- **Private server**: unchanged behavior; keeps its own `enabled` toggle.

## Testing

- Backend: `GET /me/mcp-servers` returns exactly `(package-allowed globals ∪ own private)`, never package-denied. `PUT override {allowed:false}` hides the server's tools from the next `loadToolsForUser`. `DELETE` restores it. `PUT override` on a package-denied `serverId` → 404. Master off → `loadToolsForUser` returns `[]`. All writes scoped to caller (cannot affect another user's rows).
- Frontend: toggling a global server off persists across reload and removes it from "available tools"; master toggle disables the whole list; private-server toggle still works.

## Out of scope

- Per-tool (not per-server) toggling.
- Letting users enable servers their package denies (admin-only, unchanged).
- Cleanup of stale override rows for servers removed from a package.
- The TypeScript backend (frontend runs on PHP); mirror later if needed.
