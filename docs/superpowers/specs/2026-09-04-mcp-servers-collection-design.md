# MCP Servers sidebar collection — design

Date: 2026-09-04
Status: approved in chat, pending spec review

## Goal

Add an "MCP Servers" collection to the AI Assistant left sidebar (`frontend/index.html`).
Each row is an MCP server. Clicking a row opens an overlay form showing the server's
attributes (URL, transport, type MCP / MCP App, headers, enabled) and a **Tools** tab that
replicates MCPeek's tool cards: name, description, a parameter form generated from the
tool's `inputSchema`, a **Call Tool** button and the rendered result.

MCP management already exists in the Settings modal (tab `mcp`) with full backend support.
This work adds a sidebar entry point and the MCPeek-style tool tester; it reuses
`MCPClient`, the `/mcp/*` routes, and `mcpAppHost`.

## Decisions

| Topic | Decision |
|---|---|
| "MCP type" | Auto-detected, read-only badge: `mcp_app` if any cached tool has `has_ui = 1`, else `mcp`. |
| Transport | New stored column `transport ENUM('http','sse')`, user-selected in the form, default `http`. |
| Tool "editing" | Test-only, exactly like MCPeek: argument inputs are editable, nothing is persisted. |
| Parameter form | MCPeek behaviour: one text input per top-level property, `*` on required, coercion by declared type at call time. |
| Settings modal MCP tab | Kept unchanged. Both UIs share `MCPClient`. |

## Frontend

### Sidebar (`frontend/index.html`, `frontend/assets/js/chat.js`)

- Nav button `#nav-mcp-servers` ("🔌 MCP Servers", i18n key `sidebar.mcpServers`) after `#nav-agents`,
  plus the matching `#sidebar-rail` icon.
- View container `#mcp-servers-view` (hidden by default) containing:
  - header row: search input `#mcp-servers-search`, button `#mcp-servers-new-btn`, master toggle
    `#mcp-servers-master-toggle` (calls `MCPClient.setMcpMasterEnabled`).
  - tree `#mcp-servers-tree`.
  - context menu `#mcp-servers-context-menu` (Edit / Enable-Disable / Delete).
- `switchView('mcp-servers')` case in `chat.js`, wired like the other collections.
- Package gating: `applyUserPackage()` reads `capabilities.sidebar.mcpServers`; when absent the
  button is shown (backwards compatible with existing package rows).

### `frontend/assets/js/mcp-library.js` — class `MCPLibrary`

Modeled on `agents-library.js`. Instantiated as `window.mcpLibrary` after `mcp-client.js`.

- `init()` binds buttons, search, context menu.
- `loadTree()` calls `MCPClient.loadServers()` (returns own + global servers with `tool_count`,
  `is_mock`, `enabled`, `transport`, `server_type`).
- `renderTree()` groups into two collapsible folders: **My servers** (`user_id` = current user)
  and **Global servers** (`user_id` null). Row: name, type badge (`MCP` / `MCP App`), transport
  badge (`HTTP` / `SSE`), `mock` badge if `is_mock`, tool count, enabled dot.
- Row click → `openServerForm(serverId)`. New button → `openServerForm(null)`.
- Context actions call `MCPClient.updateServer / toggleServer / deleteServer` then `loadTree()`.

### Overlay `#mcp-server-modal` (built by `MCPLibrary.openServerForm`)

Same fixed-overlay pattern as `#agent-edit-modal` (`fixed inset-0 z-[200]`, white card,
`max-w-4xl`, `max-h-[90vh]`, header with title + close). Two tabs.

**Settings tab**
- Name (required), URL (required), Description, Transport `<select>` (`http` = Streamable HTTP,
  `sse` = SSE), Type badge (read-only, from `server_type`; shows "unknown" until tools are
  discovered), Custom headers JSON textarea (validated on save), Enabled checkbox.
- Buttons: **Test connection** (`MCPClient.testConnection(url, headers)`), **Save**
  (`addServer` / `updateServer`, then `discoverTools`, then `loadTree()`), **Delete** (own servers only,
  `confirm()` is not used; an inline two-step confirm button is used instead).
- Global servers: fields disabled, Save/Delete hidden, Test connection allowed.
- Help text under Transport: "SSE servers are reached through their `/mcp` POST endpoint.
  Servers that only answer over the event stream are not supported."

**Tools tab**
- Header: tool count, **Refresh tools** button (`MCPClient.discoverTools(url, id)` then re-render).
- Tools come from the server's cached tools (`GET /mcp/servers/tools?server_id=<id>`, existing route) and
  fall back to a discovery call when the cache is empty.
- One `.mcp-tool-card` per tool, ported from MCPeek `displayTools()`:
  - name, "MCP App" badge when `has_ui`, description.
  - parameter form from `getToolInputs(tool)` (port of MCPeek `index.html:2227-2251`):
    iterate `inputSchema.properties`; label `propName` + `*` if in `required`; hint = property
    `description`; `<input type="text">` with a stable id `mcp-arg-<serverId>-<idx>-<propName>`
    (index-based to avoid unescaped tool names in selectors); `placeholder` = declared type.
  - **Call Tool** button → `callTool(tool)`:
    - read inputs, skip empty strings, coerce per property `type` exactly as MCPeek
      `index.html:1845-1866` (`number`/`integer` → `Number`, `boolean` → `'true'|'1'`,
      `array` → `JSON.parse` fallback comma-split, `object` → `JSON.parse` fallback raw string).
    - call `MCPClient.callTool(tool.name, args)`. `MCPClient.tools` must contain the tool; the
      Tools tab registers the server's tools into `MCPClient.tools` on render (so testing works
      even for tools not yet loaded by `loadAllTools`).
  - result area `#mcp-result-<serverId>-<idx>`:
    - error → red box with message.
    - `result.content[]` → text items as `<pre>`, image items as `<img>` data URI, resource
      items as a link/pre, `ui` items (`_meta.ui.resourceUri` on the tool) rendered by
      `mcpAppHost.createAppFrame(tool.name, container, { toolResult })`.
    - collapsible "Request / Response" panel with pretty-printed JSON of the JSON-RPC payload
      and raw result (MCPeek's split view, simplified to two stacked `<pre>`).

### CSS

New `frontend/assets/css/mcp-library.css`: `.mcp-lib-folder`, `.mcp-lib-item`, badges
(`.mcp-badge-type`, `.mcp-badge-transport`, `.mcp-badge-mock`), `.mcp-tool-card`,
`.mcp-tool-input`, `.mcp-tool-result`, `.mcp-tool-raw`. Reuse `.mcp-btn*` from `mcp-apps.css`.

### i18n

Add `sidebar.mcpServers` and a `mcpLibrary.*` block (folders, badges, form labels, buttons,
help text, errors) to `frontend/assets/i18n/en.json`, `fr.json`, `es.json`.

## Backend

### Migration `backend/schema/migrations/2026-09-04_mcp_servers_transport.sql`

```sql
ALTER TABLE mcp_servers
  ADD COLUMN transport ENUM('http','sse') NOT NULL DEFAULT 'http' AFTER headers;
```

`backend/schema/chatbot.sql` updated to include the column.

### `MCPServerController`

- `create()` and `update()` accept `transport` (validated against `http|sse`, default `http`).
- `update()` also accepts `headers` (array → JSON, empty → NULL), matching `create()`.
- `index()` / the list used by `MCPClient.loadServers()` returns `transport` and `server_type`
  (`mcp_app` when `EXISTS(SELECT 1 FROM mcp_server_tools t WHERE t.server_id = s.id AND t.has_ui = 1)`,
  else `mcp`).

### `MCPProxyController`

- `getServerUrl()` also loads `transport`. In `sendToMCPServer()`, when transport is `sse` and
  the URL ends with `/sse`, replace that suffix with `/mcp` before POSTing (MCPeek
  `SSEMCPClient.initializeSession` behaviour). Otherwise unchanged.
- Existing `/mcp` suffix logic and SSE-body parsing stay.

### `MCPClient` (`frontend/assets/js/mcp-client.js`)

- `addServer(name, url, description, headers, transport = 'http')`.
- `updateServer(serverId, name, url, description, headers = null, transport = null)`; only
  provided fields are sent.
- New `getServerTools(serverId)` → `GET /mcp/servers/tools?server_id=<id>`.
- New `registerTools(serverId, serverUrl, tools[])` to seed `this.tools` for the tester.

## Error handling

- Discovery/connection failures show the proxy's `error` string inline in the modal (no alerts).
- Invalid headers JSON blocks Save with an inline message.
- Coercion failures for array/object fall back to the raw string, as MCPeek does.
- `callTool` errors (JSON-RPC `error` or HTTP) render in the tool's result area.

## Testing

- PHPUnit (`backend/tests`, `composer test`):
  - `MCPServerControllerTransportTest`: create with `transport=sse` persists; update changes
    transport and headers; invalid transport rejected; list returns `server_type` = `mcp_app`
    when a cached tool has `has_ui = 1`.
  - `MCPProxyControllerUrlTest`: `/sse` → `/mcp` rewrite applied only for `sse` transport.
- Frontend manual run at `http://localhost/gpt/frontend/index.html` against the local
  `mockokta` / `mockstack` servers and `http://localhost/AI_mcp/mcp-server.php`:
  list renders, overlay opens, Save + discovery populates tools, a tool call with a number and
  an array argument returns and renders, an MCP App tool renders in the iframe host.

## Out of scope

- Editing or persisting tool descriptions / schemas.
- True streamed-SSE transport through the PHP proxy.
- Removing the Settings modal MCP tab.
- OAuth flows (MCPeek's `MCPOAuthClient`); custom headers cover bearer tokens.
