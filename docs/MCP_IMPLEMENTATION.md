# MCP (Model Context Protocol) Implementation

Technical documentation for the MCP integration in the backend system. This document covers the architecture, API endpoints, data structures, and implementation details.

## Overview

The MCP implementation provides a bridge between AI providers (Claude, OpenAI, Gemini, etc.) and external MCP-compliant servers. It enables dynamic tool discovery, execution, and UI rendering for MCP applications.

**Protocol Version:** `2024-11-05`
**JSON-RPC Version:** `2.0`

## Quick Reference

### API Endpoints Summary

| Operation | Method | Endpoint | Body/Params |
|-----------|--------|----------|-------------|
| List servers | GET | `/api/v1/mcp/servers?action=list&user_id=X` | Query params |
| Get server tools | GET | `/api/v1/mcp/servers?action=tools&server_id=N&user_id=X` | Query params |
| Get all tools | GET | `/api/v1/mcp/servers?action=all_tools&user_id=X` | Query params |
| Add server | POST | `/api/v1/mcp/servers` | JSON: `{action:"add", name, url, description?, user_id?}` |
| Update server | POST | `/api/v1/mcp/servers` | JSON: `{action:"update", server_id, name, url, description?, user_id?}` |
| Toggle server | POST | `/api/v1/mcp/servers` | JSON: `{action:"toggle", server_id, enabled, user_id?}` |
| Delete server | DELETE | `/api/v1/mcp/servers?server_id=N&user_id=X` | Query params |
| Test connection | POST | `/api/v1/mcp/proxy` | JSON: `{action:"test_connection", server_url}` |
| Discover tools | POST | `/api/v1/mcp/proxy` | JSON: `{action:"discover_tools", server_url, server_id?, user_id?}` |
| Proxy JSON-RPC | POST | `/api/v1/mcp/proxy` | JSON: `{action:"proxy", server_url OR server_id, jsonrpc:{...}, user_id?}` |
| Fetch app UI | GET | `/backend/api/mcp-app.php` | Query: `server, resource, viewUUID?, west?, south?, east?, north?, label?` |

**Note:** Fields marked with `?` are optional. Default `user_id` is `demo-user`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend                                 │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │  mcp-client.js  │    │  mcp-app-host.js │                    │
│  │  (Tool Mgmt)    │    │  (UI Hosting)    │                    │
│  └────────┬────────┘    └────────┬─────────┘                    │
└───────────┼──────────────────────┼──────────────────────────────┘
            │                      │
            ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend API Layer                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐     │
│  │ mcp-servers.php│  │ mcp-proxy.php  │  │  mcp-app.php   │     │
│  │ (Config CRUD)  │  │ (JSON-RPC)     │  │ (UI Resource)  │     │
│  └────────────────┘  └────────────────┘  └────────────────┘     │
└───────────┼──────────────────────┼──────────────────────────────┘
            │                      │
            ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend Services                             │
│  ┌─────────────────────┐    ┌────────────────────────────┐      │
│  │  MCPToolsLoader.php │    │ CombinedToolsExecutor.php  │      │
│  │  (Tool Loading)     │────│ (Unified Execution)        │      │
│  └─────────────────────┘    └────────────────────────────┘      │
└───────────┼─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   External MCP Servers                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ Server 1 │  │ Server 2 │  │ Server 3 │  │ Server N │         │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

### Backend API Endpoints

| File | Size | Purpose |
|------|------|---------|
| `backend/api/mcp-proxy.php` | 18.4 KB | JSON-RPC proxy to MCP servers |
| `backend/api/mcp-servers.php` | 13.8 KB | Server configuration management |
| `backend/api/mcp-app.php` | 5.2 KB | MCP app UI resource fetcher |

### Backend Services

| File | Purpose |
|------|---------|
| `backend/src/Services/MCPToolsLoader.php` | Loads and manages MCP tools from database |
| `backend/src/Services/CombinedToolsExecutor.php` | Combines regular and MCP tools for unified execution |

### Frontend Components

| File | Purpose |
|------|---------|
| `frontend/assets/js/mcp-client.js` | MCP server/tool management UI |
| `frontend/assets/js/mcp-app-host.js` | Sandboxed iframe host for MCP app UIs |
| `frontend/assets/css/mcp-apps.css` | Styling for MCP app containers |

### Integration

| File | Purpose |
|------|---------|
| `backend/api/chat.php` | Main chat API integrating MCP tools with AI providers |
| `backend/index.php` | Route definitions for MCP endpoints |

---

## API Endpoints

### Routing

| Endpoint | Route Type | Path |
|----------|------------|------|
| MCP Servers | Via `index.php` router | `/api/v1/mcp/servers` |
| MCP Proxy | Via `index.php` router | `/api/v1/mcp/proxy` |
| MCP App | Direct file access | `/backend/api/mcp-app.php` |

**Note:** The first two endpoints are routed through `backend/index.php`, while `mcp-app.php` is accessed directly because it returns HTML content (not JSON).

### 1. MCP Servers Management

**Endpoint:** `/api/v1/mcp/servers`

This endpoint uses **different HTTP methods** to handle different operations:

| HTTP Method | Purpose |
|-------------|---------|
| `GET` | Read operations (list servers, get tools) |
| `POST` | Write operations (add, update, toggle) |
| `DELETE` | Remove server |

---

#### GET Requests (Query Parameters)

##### List Servers

**Request:** `GET /api/v1/mcp/servers?action=list&user_id=demo-user`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | string | No | `list` | Action to perform |
| `user_id` | string | No | `demo-user` | User identifier |

**Response:**
```json
{
    "success": true,
    "servers": [
        {
            "id": 1,
            "user_id": "demo-user",
            "name": "my-mcp-server",
            "url": "http://localhost:3000/mcp",
            "description": "My custom MCP server",
            "enabled": 1,
            "tool_count": 5,
            "ui_tool_count": 2,
            "created_at": "2024-01-15 10:30:00",
            "updated_at": "2024-01-15 10:30:00"
        }
    ]
}
```

##### Get Server Tools

**Request:** `GET /api/v1/mcp/servers?action=tools&server_id=1&user_id=demo-user`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Must be `tools` |
| `server_id` | int | Yes | Server ID |
| `user_id` | string | No | User identifier |

**Response:**
```json
{
    "success": true,
    "tools": [
        {
            "id": 1,
            "server_id": 1,
            "tool_name": "search_documents",
            "tool_description": "Search through documents",
            "has_ui": 1,
            "ui_resource_uri": "resource://ui/search",
            "input_schema": { ... },
            "cached_at": "2024-01-15 10:30:00"
        }
    ]
}
```

##### Get All Tools (from all enabled servers)

**Request:** `GET /api/v1/mcp/servers?action=all_tools&user_id=demo-user`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Must be `all_tools` |
| `user_id` | string | No | User identifier |

**Response:**
```json
{
    "success": true,
    "tools": [
        {
            "id": 1,
            "server_id": 1,
            "tool_name": "search_documents",
            "tool_description": "Search through documents",
            "has_ui": 1,
            "ui_resource_uri": "resource://ui/search",
            "input_schema": { ... },
            "server_name": "my-mcp-server",
            "server_url": "http://localhost:3000/mcp"
        }
    ]
}
```

---

#### POST Requests (JSON Body)

##### Add Server

**Request:** `POST /api/v1/mcp/servers`

**Body:**
```json
{
    "action": "add",
    "user_id": "demo-user",
    "name": "server-name",
    "url": "http://server-url/mcp",
    "description": "Optional description"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | string | No | `add` | Must be `add` |
| `user_id` | string | No | `demo-user` | User identifier |
| `name` | string | Yes | - | Unique server name |
| `url` | string | Yes | - | MCP server URL |
| `description` | string | No | `""` | Server description |

**Response:**
```json
{
    "success": true,
    "server_id": 1,
    "message": "Server added successfully"
}
```

##### Update Server

**Request:** `POST /api/v1/mcp/servers`

**Body:**
```json
{
    "action": "update",
    "user_id": "demo-user",
    "server_id": 1,
    "name": "new-name",
    "url": "http://new-url/mcp",
    "description": "Updated description"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `update` |
| `server_id` | int | Yes | Server ID to update |
| `user_id` | string | No | User identifier |
| `name` | string | Yes | New server name |
| `url` | string | Yes | New server URL |
| `description` | string | No | New description |

**Note:** Updating a server clears all cached tools (requires re-discovery).

**Response:**
```json
{
    "success": true,
    "message": "Server updated successfully"
}
```

##### Toggle Server Enable/Disable

**Request:** `POST /api/v1/mcp/servers`

**Body:**
```json
{
    "action": "toggle",
    "user_id": "demo-user",
    "server_id": 1,
    "enabled": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `toggle` |
| `server_id` | int | Yes | Server ID to toggle |
| `user_id` | string | No | User identifier |
| `enabled` | bool | No | Enable (`true`) or disable (`false`) |

**Response:**
```json
{
    "success": true,
    "message": "Server disabled"
}
```

---

#### DELETE Requests (Query Parameters)

##### Delete Server

**Request:** `DELETE /api/v1/mcp/servers?server_id=1&user_id=demo-user`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server_id` | int | Yes | Server ID to delete |
| `user_id` | string | No | User identifier |

**Response:**
```json
{
    "success": true,
    "message": "Server deleted successfully"
}
```

**Note:** Deleting a server also deletes all cached tools (via `ON DELETE CASCADE`).

---

### 2. MCP Proxy

**Endpoint:** `POST /api/v1/mcp/proxy`

**File:** `backend/api/mcp-proxy.php`

This endpoint proxies JSON-RPC 2.0 requests to MCP servers. All requests use POST with a JSON body.

#### Common Input Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | string | Yes | - | Action to perform: `proxy`, `test_connection`, `discover_tools` |
| `server_url` | string | Varies | - | Direct MCP server URL |
| `server_id` | int | Varies | - | Server ID (looks up URL from database) |
| `user_id` | string | No | `demo-user` | User identifier (for server_id lookup) |

**Note:** For `proxy` action, you can provide either `server_url` OR `server_id` (not both required). If `server_id` is provided without `server_url`, the URL is looked up from the database.

#### URL Normalization

The proxy automatically appends `/mcp` to the server URL if not already present:
- `http://localhost:3000` → `http://localhost:3000/mcp`
- `http://localhost:3000/mcp` → `http://localhost:3000/mcp` (unchanged)

---

#### Action: test_connection

Tests if an MCP server is reachable by sending an `initialize` request.

**Request:**
```json
{
    "action": "test_connection",
    "server_url": "http://localhost:3000"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `test_connection` |
| `server_url` | string | Yes | MCP server URL to test |

**Success Response:**
```json
{
    "success": true,
    "serverInfo": {
        "name": "Server Name",
        "version": "1.0.0"
    },
    "capabilities": {
        "tools": {},
        "resources": {}
    }
}
```

**Failure Response (connection failed):**
```json
{
    "success": false,
    "error": "Connection failed: Could not resolve host",
    "url_tried": "http://localhost:3000/mcp"
}
```

**Failure Response (server error):**
```json
{
    "success": false,
    "error": "Unknown error",
    "details": {
        "code": -32600,
        "message": "Invalid request"
    }
}
```

---

#### Action: discover_tools

Initializes an MCP session and discovers available tools. Optionally caches tools in the database.

**Request:**
```json
{
    "action": "discover_tools",
    "server_url": "http://localhost:3000",
    "server_id": 1,
    "user_id": "demo-user"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `discover_tools` |
| `server_url` | string | Yes | MCP server URL |
| `server_id` | int | No | If provided, caches discovered tools in database |
| `user_id` | string | No | User identifier (default: `demo-user`) |

**Process:**
1. Send `initialize` request to MCP server
2. Send `notifications/initialized` notification
3. Send `tools/list` request
4. If `server_id` provided, cache tools in `mcp_server_tools` table

**Success Response:**
```json
{
    "success": true,
    "serverInfo": {
        "name": "My MCP Server",
        "version": "1.0.0"
    },
    "tools": [
        {
            "name": "search_documents",
            "description": "Search through documents",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query"
                    }
                },
                "required": ["query"]
            },
            "_meta": {
                "ui": {
                    "resourceUri": "resource://ui/search-view"
                }
            }
        }
    ]
}
```

**Note:** Tools with `_meta.ui.resourceUri` are flagged as `has_ui=1` when cached.

---

#### Action: proxy

Forwards a JSON-RPC request to an MCP server. Automatically initializes the MCP session for `tools/*` and `resources/*` methods.

**Request:**
```json
{
    "action": "proxy",
    "server_id": 1,
    "user_id": "demo-user",
    "jsonrpc": {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "search_documents",
            "arguments": {
                "query": "test"
            }
        }
    }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `proxy` |
| `server_url` | string | No* | Direct MCP server URL |
| `server_id` | int | No* | Server ID (URL looked up from DB) |
| `user_id` | string | No | User identifier for server_id lookup |
| `jsonrpc` | object | Yes | JSON-RPC 2.0 request object |

*Either `server_url` OR `server_id` must be provided.

**JSON-RPC Request Auto-Enhancement:**
- If `jsonrpc` field missing, adds `"jsonrpc": "2.0"`
- If `id` field missing, adds `id` with current timestamp
- For `tools/call` method: ensures `params.arguments` is an object (not empty array)

**Auto-Initialization:**
For methods starting with `tools/` or `resources/`, the proxy automatically:
1. Sends `initialize` request first
2. Sends `notifications/initialized` notification
3. Then sends the actual request

**Success Response:**
```json
{
    "success": true,
    "response": {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": "Search results..."
                }
            ],
            "_meta": {
                "viewUUID": "abc-123"
            }
        }
    }
}
```

---

#### Error Response Format

All errors follow this format:

```json
{
    "success": false,
    "error": {
        "code": -32603,
        "message": "Failed to connect to MCP server"
    }
}
```

**Error Codes:**

| Code | Meaning | Cause |
|------|---------|-------|
| `-32700` | Parse error | Invalid JSON input |
| `-32600` | Invalid request | Unknown action |
| `-32602` | Invalid params | Missing required parameters (server_url, jsonrpc) |
| `-32603` | Internal error | Failed to connect, initialize, or execute |

---

#### Schema Sanitization

When caching tools, the proxy sanitizes JSON schemas for Claude API compatibility:

**Removed fields:**
- `$schema` - Version conflicts (MCP uses draft-07, Claude uses 2020-12)
- `default` - Not supported in Claude API
- `$id` - Not supported
- `$ref` - Not supported
- `definitions` / `$defs` - Not supported

**Transformations:**
- Empty arrays `[]` converted to empty objects `{}` (PHP json_encode fix)

---

### 3. MCP App UI Resource

**Endpoint:** `GET /backend/api/mcp-app.php` (Direct access, not routed through index.php)

This endpoint fetches MCP app HTML via the `resources/read` protocol and serves it directly for iframe embedding.

#### Fetch UI Resource

**Request:** `GET /gpt/backend/api/mcp-app.php?server={url}&resource={uri}&viewUUID={uuid}&...`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | Yes | MCP server URL |
| `resource` | string | Yes | Resource URI (e.g., `resource://ui/tool-view`) |
| `viewUUID` | string | No | View UUID from tool result `_meta` |
| `west` | float | No | Geo coordinate (for map tools) |
| `south` | float | No | Geo coordinate (for map tools) |
| `east` | float | No | Geo coordinate (for map tools) |
| `north` | float | No | Geo coordinate (for map tools) |
| `label` | string | No | Display label |

**Response:** Returns raw HTML content (`Content-Type: text/html`) with an injected initialization script.

The HTML is modified to include:
```javascript
window.MCP_INIT_DATA = {
    west: null,
    south: null,
    east: null,
    north: null,
    label: "",
    viewUUID: "...",
    serverUrl: "..."
};
window.MCP_SERVER_URL = "...";
// Dispatches 'mcp-init' event when DOM is ready
```

**Example:**
```
GET /gpt/backend/api/mcp-app.php?server=http://localhost:3000&resource=resource://ui/map-view&viewUUID=abc123
```

**Error Responses:**
- `400`: Missing `server` or `resource` parameter
- `502`: Failed to initialize MCP session or fetch resource

---

## Database Schema

### Table: `mcp_servers`

Stores MCP server configurations per user.

```sql
CREATE TABLE mcp_servers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(500) NOT NULL,
    description TEXT,
    enabled TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_server (user_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Table: `mcp_server_tools`

Caches discovered tools from MCP servers.

```sql
CREATE TABLE mcp_server_tools (
    id INT AUTO_INCREMENT PRIMARY KEY,
    server_id INT NOT NULL,
    tool_name VARCHAR(255) NOT NULL,
    tool_description TEXT,
    input_schema JSON,
    has_ui TINYINT(1) DEFAULT 0,
    ui_resource_uri VARCHAR(500),
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
    UNIQUE KEY unique_server_tool (server_id, tool_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## JSON-RPC Protocol

### Client Information

```php
$clientInfo = [
    'name' => 'GPT-Chatbot-MCP-Client',
    'version' => '1.0.0'
];
```

### Request Formats

#### Initialize

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "clientInfo": {
            "name": "GPT-Chatbot-MCP-Client",
            "version": "1.0.0"
        },
        "capabilities": {}
    }
}
```

#### Initialized Notification

```json
{
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
    "params": {}
}
```

#### List Tools

```json
{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
}
```

#### Call Tool

```json
{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
        "name": "tool_name",
        "arguments": {
            "param1": "value1",
            "param2": "value2"
        }
    }
}
```

#### Read Resource

```json
{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "resources/read",
    "params": {
        "uri": "resource://ui/tool-view"
    }
}
```

### Response Format

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "Result content"
            }
        ],
        "_meta": {
            "viewUUID": "optional-uuid-for-ui"
        }
    }
}
```

### Server-Sent Events (SSE) Format

The proxy supports SSE responses from MCP servers:

```
data: {"jsonrpc":"2.0","id":1,"result":{...}}

data: {"jsonrpc":"2.0","id":2,"result":{...}}
```

---

## Classes and Methods

### MCPToolsLoader

**File:** `backend/src/Services/MCPToolsLoader.php`

Loads MCP tools from the database and executes them.

#### Constructor

```php
public function __construct(PDO $pdo)
```

#### Public Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `loadToolsForUser` | `string $userId` | `array` | Load all enabled MCP tools for a user |
| `getToolDefinitions` | - | `array` | Get tool definitions in Claude/OpenAI format |
| `isMCPTool` | `string $toolName` | `bool` | Check if a tool is an MCP tool |
| `executeTool` | `string $toolName, array $arguments` | `array` | Execute an MCP tool |
| `getTools` | - | `array` | Get all loaded tools |
| `hasTools` | - | `bool` | Check if any MCP tools are loaded |

#### Private Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `callMCPServer` | `string $serverUrl, string $toolName, array $arguments` | `array` | Send JSON-RPC request to MCP server |
| `parseResponse` | `string $response` | `?array` | Parse JSON or SSE response |
| `formatToolResult` | `array $result` | `array` | Format result for AI consumption |

---

### CombinedToolsExecutor

**File:** `backend/src/Services/CombinedToolsExecutor.php`

Combines regular functions with MCP tools for unified execution.

**Implements:** `FunctionExecutorInterface`

#### Constructor

```php
public function __construct(
    FunctionExecutorInterface $baseExecutor,
    MCPToolsLoader $mcpLoader
)
```

#### Public Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `execute` | `string $functionName, array $parameters, mixed $context = null` | `array` | Route to MCP or base executor |
| `hasFunction` | `string $functionName` | `bool` | Check if function exists |
| `getRegisteredFunctions` | - | `array` | Get combined function names |
| `getToolDefinitions` | - | `array` | Get combined tool definitions |
| `getCombinedToolDefinitions` | - | `array` | Alias for getToolDefinitions |
| `getBaseExecutor` | - | `FunctionExecutorInterface` | Get the base executor |
| `getMCPLoader` | - | `?MCPToolsLoader` | Get the MCP loader |

---

### MCPProxy

**File:** `backend/api/mcp-proxy.php`

Handles JSON-RPC proxy requests to MCP servers.

#### Private Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `proxyRequest` | `?string $serverUrl, ?int $serverId, ?array $jsonrpc, string $userId` | `void` | Proxy JSON-RPC to MCP server |
| `testConnection` | `string $serverUrl` | `void` | Test MCP server connection |
| `discoverTools` | `string $serverUrl, ?int $serverId, string $userId` | `void` | Discover and cache tools |
| `sendToMCPServer` | `string $serverUrl, array $request, bool $expectResponse = true` | `?array` | Send curl request |
| `parseSSEResponse` | `string $response` | `?array` | Parse Server-Sent Events |
| `cacheTools` | `int $serverId, array $tools` | `void` | Cache discovered tools |
| `sanitizeSchema` | `mixed $schema` | `mixed` | Sanitize JSON schema for Claude API |

---

### MCPServersManager

**File:** `backend/api/mcp-servers.php`

Manages MCP server configurations.

#### Public Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `handle` | - | `void` | Main request handler |
| `handleGet` | - | `void` | Handle GET requests |
| `handlePost` | - | `void` | Handle POST requests |
| `handleDelete` | - | `void` | Handle DELETE requests |

#### Private Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `listServers` | `string $userId` | `void` | List servers with tool counts |
| `getServerTools` | `?string $serverId, string $userId` | `void` | Get tools for specific server |
| `getAllTools` | `string $userId` | `void` | Get all tools from enabled servers |
| `addServer` | `array $input, string $userId` | `void` | Add new server |
| `updateServer` | `array $input, string $userId` | `void` | Update server configuration |
| `toggleServer` | `array $input, string $userId` | `void` | Enable/disable server |
| `deleteServer` | `int $serverId, string $userId` | `void` | Delete server |

---

## Tool Registration Flow

### 1. User Adds MCP Server

```
Frontend                Backend                     MCP Server
   │                       │                            │
   │──POST /mcp/servers────▶│                            │
   │   action: 'add'        │                            │
   │   name, url, desc      │                            │
   │                        │──INSERT mcp_servers─────▶DB│
   │◀───────────────────────│                            │
   │   server_id            │                            │
```

### 2. Tool Discovery

```
Frontend                Backend                     MCP Server
   │                       │                            │
   │──POST /mcp/proxy──────▶│                            │
   │   action: 'discover'   │                            │
   │   server_url           │──JSON-RPC: initialize────▶│
   │                        │◀──────────────────────────│
   │                        │──notifications/initialized─▶│
   │                        │──JSON-RPC: tools/list────▶│
   │                        │◀─────────tools array──────│
   │                        │──INSERT mcp_server_tools──▶DB
   │◀───────────────────────│                            │
   │   tools[]              │                            │
```

### 3. Loading Tools for Chat

**Location:** `backend/api/chat.php` (lines 82-110)

```php
// Create MCP tools loader
$mcpToolsLoader = new MCPToolsLoader($pdo);
$mcpToolsLoader->loadToolsForUser($userId);

if ($mcpToolsLoader->hasTools()) {
    // Get the base tools manager
    $baseToolsManager = $assistant->getToolsManager();

    // Create combined executor
    $combinedExecutor = new CombinedToolsExecutor(
        $baseToolsManager,
        $mcpToolsLoader
    );

    // Set on all providers
    $providers = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];
    foreach ($providers as $providerName) {
        $provider = $llmManager->getProvider($providerName);
        if ($provider && method_exists($provider, 'setFunctionExecutor')) {
            $provider->setFunctionExecutor($combinedExecutor);
        }
    }
}
```

### 4. Tool Execution

```
AI Provider             CombinedToolsExecutor         MCPToolsLoader
    │                           │                           │
    │──execute(toolName, args)──▶│                           │
    │                           │──isMCPTool(toolName)──────▶│
    │                           │◀───────true───────────────│
    │                           │──executeTool(name, args)──▶│
    │                           │                           │
    │                           │              MCPToolsLoader──▶MCP Server
    │                           │              JSON-RPC: tools/call
    │                           │              ◀────result────
    │                           │                           │
    │                           │◀────formatted result──────│
    │◀──────────result──────────│                           │
```

---

## Tool Definition Format

MCP tools are formatted for AI provider consumption:

```php
[
    'name' => 'mcp_tool_name',
    'description' => '[MCP:ServerName] Tool description from server',
    'input_schema' => (object) [
        'type' => 'object',
        'properties' => (object) [
            'param1' => (object) [
                'type' => 'string',
                'description' => 'Parameter description'
            ]
        ],
        'required' => ['param1']
    ]
]
```

**Note:** `stdClass` objects are used to preserve empty objects in JSON encoding (PHP arrays convert `{}` to `[]`).

---

## UI Metadata Structure

When a tool has UI capabilities, the result includes UI metadata:

```php
$result['_mcp_ui'] = [
    'has_ui' => true,
    'tool_name' => 'original_tool_name',
    'server_url' => 'http://server-url/mcp',
    'server_name' => 'Server Display Name',
    'resource_uri' => 'resource://ui/tool-view',
    'view_uuid' => 'uuid-from-meta',  // Optional
    'arguments' => ['param1' => 'value1'],
    'tool_result' => ['content' => [...]],
    'has_error' => false
];
```

---

## Frontend MCP App Hosting

### MCPClient Class

**File:** `frontend/assets/js/mcp-client.js`

Key methods for tool management:

```javascript
class MCPClient {
    async loadAllTools()           // Load tools with UI flags
    getToolsWithUi()               // Filter tools that have UI
    async fetchUiResource(uri, url) // Fetch UI HTML via proxy
}
```

### MCPAppHost Class

**File:** `frontend/assets/js/mcp-app-host.js`

Manages sandboxed iframes for MCP app UIs:

```javascript
class MCPAppHost {
    createAppFrame(toolName, container)  // Create sandboxed iframe
    injectBridge(html, appId, toolName)  // Inject postMessage bridge
}
```

### Bridge API

Apps running in iframes have access to `window.app`:

| Method | Parameters | Description |
|--------|------------|-------------|
| `callServerTool` | `name, args` | Call an MCP tool from the UI |
| `sendMessage` | `content, options` | Send message to chat |
| `sendLog` | `level, message, data` | Log for debugging |
| `openLink` | `url` | Open link safely |
| `getInfo` | - | Get app metadata |
| `close` | - | Close the app |
| `resize` | `width, height` | Request iframe resize |

### Sandbox Configuration

```html
<iframe
    sandbox="allow-scripts allow-forms allow-same-origin"
    allow="clipboard-write"
>
```

---

## MCP App UI Rendering Sequence

This section describes the complete sequence of events when an MCP tool with UI capabilities is executed and its content is rendered in a client iframe.

### Overview

There are two paths for displaying MCP app UIs:

1. **Automatic (SSE-triggered)**: When an AI provider executes an MCP tool with UI, the frontend automatically displays the UI
2. **Manual (MCPAppHost)**: Programmatically create an MCP app frame using `MCPAppHost.createAppFrame()`

### Sequence Diagrams: Automatic UI Rendering (Primary Flow)

The complete flow is split into two phases for clarity.

#### Phase A: Tool Execution (Steps 1-8)

```
┌────────┐      ┌───────────┐      ┌───────────────┐      ┌─────────────┐
│  User  │      │ Frontend  │      │    Backend    │      │ MCP Server  │
│        │      │ (chat.js) │      │   (Provider   │      │ (external)  │
│        │      │           │      │ + ToolsLoader)│      │             │
└───┬────┘      └─────┬─────┘      └───────┬───────┘      └──────┬──────┘
    │                 │                    │                     │
    │ 1. Send message │                    │                     │
    │────────────────>│                    │                     │
    │                 │                    │                     │
    │                 │ 2. POST /api/v1/chat                     │
    │                 │    (SSE stream)    │                     │
    │                 │───────────────────>│                     │
    │                 │                    │                     │
    │                 │                    │ 3. AI decides to    │
    │                 │                    │    call MCP tool    │
    │                 │                    │                     │
    │                 │                    │ 4. JSON-RPC         │
    │                 │                    │    tools/call       │
    │                 │                    │────────────────────>│
    │                 │                    │                     │
    │                 │                    │ 5. Tool result      │
    │                 │                    │    + _meta.viewUUID │
    │                 │                    │<────────────────────│
    │                 │                    │                     │
    │                 │                    │ 6. Add _mcp_ui      │
    │                 │                    │    metadata         │
    │                 │                    │                     │
    │                 │ 7. SSE event:      │                     │
    │                 │    type="mcp_ui"   │                     │
    │                 │    data={tool_name,│                     │
    │                 │          ui_info}  │                     │
    │                 │<───────────────────│                     │
    │                 │                    │                     │
    │                 │ 8. Parse event,    │                     │
    │                 │    call            │                     │
    │                 │    displayMCPUI()  │                     │
    │                 │                    │                     │
```

#### Phase B: UI Resource Loading (Steps 9-14)

```
┌───────────┐      ┌─────────────┐      ┌─────────────┐
│ Frontend  │      │mcp-app.php  │      │ MCP Server  │
│ (iframe)  │      │  (backend)  │      │ (external)  │
└─────┬─────┘      └──────┬──────┘      └──────┬──────┘
      │                   │                    │
      │ 9. GET /backend/api/mcp-app.php       │
      │    ?server=<url>                       │
      │    &resource=<uri>                     │
      │    &viewUUID=<id>                      │
      │    &<tool_args...>                     │
      │──────────────────>│                    │
      │                   │                    │
      │                   │ 10. JSON-RPC       │
      │                   │     initialize     │
      │                   │───────────────────>│
      │                   │                    │
      │                   │ 11. serverInfo +   │
      │                   │     capabilities   │
      │                   │<───────────────────│
      │                   │                    │
      │                   │ 12. JSON-RPC       │
      │                   │     resources/read │
      │                   │     uri=<resource> │
      │                   │───────────────────>│
      │                   │                    │
      │                   │ 13. HTML content   │
      │                   │<───────────────────│
      │                   │                    │
      │                   │ 14. Inject script: │
      │                   │     MCP_INIT_DATA  │
      │                   │     MCP_SERVER_URL │
      │                   │                    │
      │ 15. HTML response │                    │
      │     (text/html)   │                    │
      │<──────────────────│                    │
      │                   │                    │
      │ 16. Render UI,    │                    │
      │     dispatch      │                    │
      │     'mcp-init'    │                    │
      │     event         │                    │
      │                   │                    │

    ┌─────────────────────────────────────────────┐
    │           User sees MCP App UI              │
    │         rendered inside iframe              │
    └─────────────────────────────────────────────┘
```

#### Combined Flow Summary

```
┌──────┐   ┌──────────┐   ┌─────────┐   ┌────────────┐   ┌────────────┐
│ User │──>│ Frontend │──>│ Backend │──>│ MCP Server │   │mcp-app.php │
└──────┘   └──────────┘   └─────────┘   └────────────┘   └────────────┘
              │                 │              │                  │
              │<── SSE: mcp_ui ─│              │                  │
              │                 │              │                  │
              │── GET mcp-app.php ────────────────────────────────>│
              │                                │                  │
              │                                │<── initialize ───│
              │                                │─── serverInfo ──>│
              │                                │<── resources/read│
              │                                │─── HTML ────────>│
              │                                                   │
              │<── HTML + MCP_INIT_DATA ──────────────────────────│
              │
           [iframe renders UI]
```

**Note:** The SSE `mcp_ui` event is sent by the Backend (AI Provider) during tool execution. The iframe then loads content from `mcp-app.php`, which fetches the UI resource from the MCP Server.

### Detailed Step-by-Step Breakdown

#### Phase 1: Tool Execution (Backend)

**Step 1-2: User Request**
- User sends a chat message
- Frontend POSTs to `/api/v1/chat` with SSE streaming enabled

**Step 3: AI Tool Decision**
- AI provider (Claude, OpenAI, etc.) analyzes the request
- AI decides to call an MCP tool (e.g., `mcp_show_map`)

**Step 4: Tool Execution via CombinedToolsExecutor**

Location: `backend/src/Services/CombinedToolsExecutor.php`

```php
public function execute(string $functionName, array $parameters, $context = null): array
{
    // Check if it's an MCP tool
    if ($this->mcpLoader && $this->mcpLoader->isMCPTool($functionName)) {
        return $this->mcpLoader->executeTool($functionName, $parameters);
    }
    // Otherwise use base executor...
}
```

**Step 5: MCP Server Call**

Location: `backend/src/Services/MCPToolsLoader.php:152-245`

```php
private function callMCPServer(string $serverUrl, string $toolName, array $arguments): array
{
    // Normalize URL (append /mcp if needed)
    $mcpUrl = rtrim($serverUrl, '/');
    if (!str_ends_with($mcpUrl, '/mcp')) {
        $mcpUrl .= '/mcp';
    }

    // Build JSON-RPC 2.0 request
    $request = [
        'jsonrpc' => '2.0',
        'id' => time(),
        'method' => 'tools/call',
        'params' => [
            'name' => $toolName,
            'arguments' => empty($arguments) ? new \stdClass() : $arguments
        ]
    ];

    // Send via cURL (timeout: 180s)
    // ...
}
```

**Step 6: MCP Server Response**

The MCP server returns a JSON-RPC response:

```json
{
    "jsonrpc": "2.0",
    "id": 1234567890,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "Map generated successfully"
            }
        ],
        "_meta": {
            "viewUUID": "abc-123-def-456"
        }
    }
}
```

**Step 7: Adding UI Metadata**

Location: `backend/src/Services/MCPToolsLoader.php:96-147`

```php
public function executeTool(string $toolName, array $arguments): array
{
    // ... execute tool ...

    // Check for UI capability (static has_ui flag OR dynamic viewUUID)
    $hasViewUUID = isset($result['_meta']['viewUUID']);

    if ($tool['has_ui'] || $hasViewUUID) {
        $result['_mcp_ui'] = [
            'has_ui' => true,
            'tool_name' => $originalName,       // Original tool name without mcp_ prefix
            'server_url' => $serverUrl,         // MCP server URL
            'server_name' => $tool['server_name'],
            'resource_uri' => $tool['ui_resource_uri'] ?? null,  // Static UI resource
            'view_uuid' => $result['_meta']['viewUUID'] ?? null, // Dynamic view ID
            'arguments' => $arguments,          // Tool arguments for UI initialization
            'tool_result' => $rawResult,        // Raw MCP result for UI
            'has_error' => isset($result['error']) && $result['error'] === true
        ];
    }

    return $result;
}
```

#### Phase 2: SSE Event Emission (Backend → Frontend)

**Step 8: Provider Sends SSE Event**

Location: All providers (e.g., `backend/src/Providers/ClaudeProvider.php:684-690`)

```php
// After tool execution, check for UI metadata
if (isset($result['_mcp_ui']) && $this->sseClient) {
    $this->sseClient->sendCustomEvent('mcp_ui', [
        'tool_name' => $functionName,
        'ui_info' => $result['_mcp_ui']
    ]);
    error_log("📺 [MCP] Sent UI event to frontend for tool: {$functionName}");
}
```

**SSE Event Format:**

```
event: mcp_ui
data: {"tool_name":"mcp_show_map","ui_info":{"has_ui":true,"tool_name":"show_map","server_url":"http://localhost:3000","server_name":"MapServer","resource_uri":"resource://ui/map-view","view_uuid":"abc-123","arguments":{"lat":40.7128,"lng":-74.006},"tool_result":{...}}}
```

#### Phase 3: Frontend UI Rendering

**Step 9: SSE Event Handler**

Location: `frontend/assets/js/chat.js:1679-1705`

```javascript
case 'mcp_ui':
    console.log('📺 [SSE] Received mcp_ui event:', data);
    const mcpData = JSON.parse(data);

    // Deduplicate by viewUUID or tool+args hash
    const uiKey = mcpData.ui_info?.view_uuid ||
                  `${mcpData.tool_name}_${JSON.stringify(mcpData.ui_info?.arguments || {})}`;

    if (this.displayedMCPUIs.has(uiKey)) {
        console.log('📺 [SSE] Skipping duplicate MCP UI:', uiKey);
        break;
    }
    this.displayedMCPUIs.add(uiKey);

    // Clear after 5 seconds to allow re-display
    setTimeout(() => this.displayedMCPUIs.delete(uiKey), 5000);

    this.displayMCPUI(mcpData);
    break;
```

**Step 10: Create Iframe Container**

Location: `frontend/assets/js/chat.js:1051-1179`

```javascript
async displayMCPUI(mcpData) {
    const { tool_name, ui_info } = mcpData;

    // Create container
    const container = document.createElement('div');
    container.className = 'mcp-ui-container w-[80%] bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm';
    container.id = `mcp-ui-${Date.now()}`;

    // Create sandboxed iframe
    const iframe = document.createElement('iframe');
    iframe.className = 'mcp-ui-frame';
    iframe.sandbox = 'allow-scripts allow-forms allow-same-origin';

    // Store data for bridge identification
    iframe.dataset.serverUrl = ui_info.server_url;
    iframe.dataset.toolName = ui_info.tool_name || tool_name;
    iframe.dataset.toolArgs = JSON.stringify(ui_info.arguments || {});
    iframe.dataset.toolResult = JSON.stringify(ui_info.tool_result);

    // Build URL to mcp-app.php proxy
    const params = new URLSearchParams();
    params.set('server', ui_info.server_url);
    params.set('resource', ui_info.resource_uri);

    // Pass all tool arguments as query params
    if (ui_info.arguments) {
        Object.entries(ui_info.arguments).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                params.set(key, String(value));
            }
        });
    }
    if (ui_info.view_uuid) params.set('viewUUID', ui_info.view_uuid);

    // Set iframe source
    const appUrl = `/gpt/backend/api/mcp-app.php?${params.toString()}`;
    iframe.src = appUrl;

    // Register with MCP bridge
    this.mcpIframes.set(iframe.contentWindow, {
        serverUrl: ui_info.server_url,
        toolName: ui_info.tool_name || tool_name,
        toolArgs: ui_info.arguments,
        toolResult: ui_info.tool_result
    });

    // Add to chat messages
    this.messagesContainer.appendChild(container);
}
```

#### Phase 4: UI Resource Fetching (mcp-app.php)

**Step 11-12: Initialize MCP Session**

Location: `backend/api/mcp-app.php:99-126`

```php
// Initialize MCP session
$initRequest = [
    'jsonrpc' => '2.0',
    'id' => 1,
    'method' => 'initialize',
    'params' => [
        'protocolVersion' => '2024-11-05',
        'clientInfo' => [
            'name' => 'GPT-Chatbot-MCP-App-Proxy',
            'version' => '1.0.0'
        ],
        'capabilities' => new stdClass()
    ]
];

$initResponse = sendMCPRequest($mcpUrl, $initRequest);

// Send initialized notification
sendMCPRequest($mcpUrl, [
    'jsonrpc' => '2.0',
    'method' => 'notifications/initialized',
    'params' => new stdClass()
], false);
```

**Step 13-14: Fetch UI Resource**

Location: `backend/api/mcp-app.php:128-153`

```php
// Fetch the UI resource
$resourceRequest = [
    'jsonrpc' => '2.0',
    'id' => 2,
    'method' => 'resources/read',
    'params' => [
        'uri' => $resourceUri  // e.g., "resource://ui/map-view"
    ]
];

$resourceResponse = sendMCPRequest($mcpUrl, $resourceRequest);

// Extract HTML content
$htmlContent = $resourceResponse['result']['contents'][0]['text'] ?? null;
```

**Step 15: Inject Initialization Script**

Location: `backend/api/mcp-app.php:155-195`

```php
// Build initialization data from query params
$initData = json_encode([
    'west' => $west !== '' ? (float)$west : null,
    'south' => $south !== '' ? (float)$south : null,
    'east' => $east !== '' ? (float)$east : null,
    'north' => $north !== '' ? (float)$north : null,
    'label' => $label,
    'viewUUID' => $viewUUID,
    'serverUrl' => $serverUrl
]);

// Inject script before </head> or at end
$initScript = <<<SCRIPT
<script>
    // MCP App initialization data from parent
    window.MCP_INIT_DATA = {$initData};
    window.MCP_SERVER_URL = '{$serverUrl}';

    // Dispatch init event when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
        });
    } else {
        window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
    }
</script>
SCRIPT;

// Inject before </head> or at end
if (strpos($htmlContent, '</head>') !== false) {
    $htmlContent = str_replace('</head>', $initScript . '</head>', $htmlContent);
} else {
    $htmlContent = $initScript . $htmlContent;
}

// Serve the HTML
header('Content-Type: text/html; charset=utf-8');
echo $htmlContent;
```

**Step 16: UI Visible to User**

The iframe loads and displays the MCP app UI. The app can:
- Access `window.MCP_INIT_DATA` for initialization parameters
- Access `window.MCP_SERVER_URL` for the MCP server URL
- Listen for `mcp-init` CustomEvent for initialization

### Alternative Flow: MCPAppHost (Manual Creation)

For programmatic UI creation (not via SSE), use `MCPAppHost`:

Location: `frontend/assets/js/mcp-app-host.js:22-119`

```javascript
// Create app frame manually
const result = await window.mcpAppHost.createAppFrame('show_map', containerElement, {
    // optional options
});

// This:
// 1. Gets tool info from mcpClient
// 2. Calls mcpClient.fetchUiResource() which uses mcp-proxy.php
// 3. Injects bridge script into HTML
// 4. Creates iframe with srcdoc (not src)
// 5. Sets up postMessage handlers
```

**Key Difference:** MCPAppHost uses `iframe.srcdoc` with content fetched via `mcp-proxy.php`, while the SSE flow uses `iframe.src` pointing to `mcp-app.php`.

### PostMessage Communication (Optional)

Once the iframe is loaded, the app can communicate with the parent via postMessage:

**App → Parent Messages:**

| Message Type | Purpose | Data |
|--------------|---------|------|
| `mcp-app-ready` | App initialization complete | `{ appId }` |
| `mcp-app-request` | Request tool call or chat message | `{ appId, requestId, action, params }` |
| `mcp-app-log` | Debugging log | `{ appId, level, message, data }` |
| `mcp-app-openLink` | Open URL in new tab | `{ appId, url }` |
| `mcp-app-close` | Close the app | `{ appId }` |
| `mcp-app-resize` | Resize iframe | `{ appId, width, height }` |

**Parent → App Messages:**

| Message Type | Purpose | Data |
|--------------|---------|------|
| `mcp-app-response` | Response to request | `{ appId, requestId, result, error }` |

### Data Flow Summary

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              _mcp_ui Object                                 │
├────────────────────────────────────────────────────────────────────────────┤
│ {                                                                          │
│   "has_ui": true,                    // Always true when present           │
│   "tool_name": "show_map",           // Original tool name (no mcp_ prefix)│
│   "server_url": "http://...",        // MCP server URL                     │
│   "server_name": "MapServer",        // Human-readable server name         │
│   "resource_uri": "resource://...",  // Static UI resource URI (from DB)   │
│   "view_uuid": "abc-123",            // Dynamic view ID (from _meta)       │
│   "arguments": { "lat": 40.7 },      // Tool arguments for UI init         │
│   "tool_result": { ... },            // Raw MCP result for UI              │
│   "has_error": false                 // Whether tool execution failed      │
│ }                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         mcp-app.php Query Params                           │
├────────────────────────────────────────────────────────────────────────────┤
│ ?server=http://...                   // MCP server URL                     │
│ &resource=resource://ui/map-view     // UI resource URI                    │
│ &viewUUID=abc-123                    // Dynamic view ID                    │
│ &lat=40.7128                         // Tool argument                      │
│ &lng=-74.006                         // Tool argument                      │
│ &label=New%20York                    // Tool argument                      │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         Injected window.MCP_INIT_DATA                      │
├────────────────────────────────────────────────────────────────────────────┤
│ {                                                                          │
│   "west": null,                      // Geo bounds (if provided)           │
│   "south": null,                                                           │
│   "east": null,                                                            │
│   "north": null,                                                           │
│   "label": "New York",               // Label param                        │
│   "viewUUID": "abc-123",             // Dynamic view ID                    │
│   "serverUrl": "http://..."          // MCP server URL                     │
│ }                                                                          │
│                                                                            │
│ window.MCP_SERVER_URL = "http://..." // Also available as separate var     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Error Handling

| Stage | Error | Handling |
|-------|-------|----------|
| Tool execution | MCP server unreachable | `_mcp_ui.has_error = true`, error in result |
| SSE event | Duplicate UI | Skipped via `displayedMCPUIs` Set (5s cooldown) |
| mcp-app.php | Missing params | HTTP 400 with error message |
| mcp-app.php | MCP session init failed | HTTP 502 "Failed to initialize MCP session" |
| mcp-app.php | Resource fetch failed | HTTP 502 "Failed to fetch MCP resource" |
| iframe load (MCPAppHost only) | Timeout (30s) | "App load timeout" error |
| iframe load (SSE flow) | Load failure | "Failed to load app" message displayed |

**Note:** The 30-second timeout applies only to the MCPAppHost alternative flow (`mcp-app-host.js:106`). The primary SSE-triggered flow via `displayMCPUI` in `chat.js` does not have a timeout but handles errors via `iframe.onerror`.

---

## Schema Sanitization

The proxy sanitizes JSON schemas for Claude API compatibility:

**Removed fields:**
- `$schema`
- `default`
- `$id`
- `$ref`
- `definitions`
- `$defs`

**Transformations:**
- Empty arrays converted to empty objects
- Recursive sanitization for nested schemas

**Implementation:** `sanitizeSchema()` in `mcp-proxy.php`

---

## HTTP Configuration

### Request Headers

```php
$headers = [
    'Content-Type: application/json',
    'Accept: application/json, text/event-stream, */*'
];
```

### Timeouts

| Operation | Timeout |
|-----------|---------|
| Connection | 15 seconds |
| Tool call | 120-180 seconds |

### CORS

```php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
```

---

## Provider Integration

All AI providers support MCP through the `setFunctionExecutor()` method:

| Provider | File | UI Event Support |
|----------|------|------------------|
| Claude | `ClaudeProvider.php` | SSE events with `_mcp_ui` |
| OpenAI | `OpenAIProvider.php` | SSE events with `_mcp_ui` |
| Gemini | `GeminiProvider.php` | Removes `_mcp_ui` before API call |
| Grok | `GrokProvider.php` | Supported |
| DeepSeek | `DeepSeekProvider.php` | Supported |
| Kimi | `KimiProvider.php` | Supported |
| Custom | `CustomProvider.php` | Supported |

---

## Error Handling

### JSON-RPC Error Response

```json
{
    "success": false,
    "error": {
        "code": -32603,
        "message": "Failed to connect to MCP server"
    }
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 400 | Missing required parameters |
| 404 | Resource not found |
| 502 | MCP server connection failed |

---

## Logging

Log messages use emoji prefixes for clarity:

| Prefix | Category |
|--------|----------|
| `[MCP]` | MCP connection/loading events |
| `[MCP]` | Tool execution events |
| `[MCP]` | UI-related events |
| `[MCP]` | UI rendering/SSE events |
| `[MCP]` | Error conditions |
| `[MCP]` | Success confirmations |
| `[MCP]` | Warning conditions |

---

## Security Considerations

1. **User Isolation:** MCP tools are keyed by `user_id`
2. **Prepared Statements:** All database queries use prepared statements
3. **URL Validation:** Server URLs are validated with `filter_var`
4. **Iframe Sandboxing:** UI apps run in sandboxed iframes with minimum permissions
5. **CORS:** Currently permissive (`*`) - consider restricting in production

---

## Usage Examples

### Adding an MCP Server (POST with JSON body)

```javascript
const response = await fetch('/api/v1/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        action: 'add',
        user_id: 'demo-user',
        name: 'my-mcp-server',
        url: 'http://localhost:3000/mcp',
        description: 'My custom MCP server'
    })
});

const result = await response.json();
console.log('Server ID:', result.server_id);
```

### Listing Servers (GET with query params)

```javascript
const response = await fetch('/api/v1/mcp/servers?action=list&user_id=demo-user');
const result = await response.json();
console.log('Servers:', result.servers);
```

### Getting Tools for a Server (GET with query params)

```javascript
const response = await fetch('/api/v1/mcp/servers?action=tools&server_id=1&user_id=demo-user');
const result = await response.json();
console.log('Tools:', result.tools);
```

### Toggling Server Enable/Disable (POST with JSON body)

```javascript
const response = await fetch('/api/v1/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        action: 'toggle',
        user_id: 'demo-user',
        server_id: 1,
        enabled: false
    })
});

const result = await response.json();
console.log('Result:', result.message);
```

### Deleting a Server (DELETE with query params)

```javascript
const response = await fetch('/api/v1/mcp/servers?server_id=1&user_id=demo-user', {
    method: 'DELETE'
});

const result = await response.json();
console.log('Result:', result.message);
```

### Discovering Tools via Proxy

```javascript
const response = await fetch('/api/v1/mcp/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        action: 'discover_tools',
        server_url: 'http://localhost:3000/mcp',
        server_id: 1
    })
});

const result = await response.json();
console.log('Discovered tools:', result.tools);
```

### Calling a Tool via Proxy

```javascript
const response = await fetch('/api/v1/mcp/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        action: 'proxy',
        server_id: 1,
        jsonrpc: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'search_documents',
                arguments: { query: 'test' }
            }
        }
    })
});

const result = await response.json();
console.log('Tool result:', result);
```
