"""Port of Services/MCPToolsLoader.php.

Loads MCP tools from database and provides execution via MCP proxy.
"""
from __future__ import annotations

import json
import re
import time

import httpx

from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_bool, php_empty, php_intval
from app.support.phpjson import dumps as json_encode


class MCPToolsLoader:
    """Loads MCP tools from database and provides execution via MCP proxy."""

    def __init__(self, db):
        self.db = db
        self.tools: dict = {}
        self.serverUrls: dict = {}
        self._http = httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0))

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this loader's httpx connection pool."""
        self._http.close()

    def loadToolsForUser(self, userId=None, allowedServerNames: list | None = None) -> dict:
        """Load enabled MCP tools: all global servers plus the caller's user-scoped servers.

        When allowedServerNames is a non-None list, the result is further
        restricted to servers whose `name` column is in that list — this is
        how role-based package allowlists gate MCP access at the chat
        runtime. Pass None for no allowlist restriction (backward-compatible
        default).
        """
        self.tools = {}
        self.serverUrls = {}

        # Master switch: if the user disabled all MCP, offer zero tools.
        uid = php_intval(userId) if (userId is not None and userId != '' and is_numeric(userId)) else None
        if uid is not None:
            try:
                row = self.db.fetch_one("SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ?", [uid])
                if row is not None and php_intval(row.get('mcp_enabled')) == 0:
                    error_log(f"[MCP] Master switch OFF for user {uid} — 0 tools")
                    return self.tools  # empty
            except Exception:
                pass  # table absent / transient => treat as enabled, continue

        try:
            # Fetch all enabled tools visible to this caller WITHOUT applying
            # the package allowlist in SQL. We resolve the effective
            # per-server enable in Python below so the per-user override
            # layer can ADD a server back that the package allowlist would
            # otherwise hide.
            if userId is not None and userId != '':
                sql = (
                    "SELECT t.*, s.id as server_id_col, s.url as server_url, s.name as server_name,"
                    " s.user_id as server_user_id, s.headers as server_headers,"
                    " s.transport as server_transport"
                    " FROM mcp_server_tools t"
                    " JOIN mcp_servers s ON t.server_id = s.id"
                    " WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ?)"
                    " ORDER BY s.name, t.tool_name"
                )
                rows = self.db.fetch_all(sql, [str(userId)])
            else:
                sql = (
                    "SELECT t.*, s.id as server_id_col, s.url as server_url, s.name as server_name,"
                    " s.user_id as server_user_id, s.headers as server_headers,"
                    " s.transport as server_transport"
                    " FROM mcp_server_tools t"
                    " JOIN mcp_servers s ON t.server_id = s.id"
                    " WHERE s.user_id IS NULL AND s.enabled = 1"
                    " ORDER BY s.name, t.tool_name"
                )
                rows = self.db.fetch_all(sql, None)

            # Per-user overrides cascade on top of the package allowlist.
            # override.allowed = true  -> include the server even if the
            #                             package allowlist excludes it
            # override.allowed = false -> exclude the server even if the
            #                             package allowlist would grant it
            # no override              -> defer to the package allowlist
            # User-private servers (s.user_id = userId) always pass when no
            # override exists for them — owners self-manage those.
            overridesByServerId: dict = {}
            userIdInt = php_intval(userId) if (userId is not None and userId != '' and is_numeric(userId)) else None
            if userIdInt is not None:
                orows = self.db.fetch_all("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?", [userIdInt])
                for r in orows:
                    overridesByServerId[php_intval(r['server_id'])] = php_bool(r.get('allowed'))

            def _allowed(r) -> bool:
                serverId = php_intval(r['server_id_col'])
                isPrivate = r.get('server_user_id') is not None
                if serverId in overridesByServerId:
                    return overridesByServerId[serverId]
                if isPrivate:
                    return True
                if allowedServerNames is None:
                    return True
                return r['server_name'] in allowedServerNames

            rows = [r for r in rows if _allowed(r)]

            for row in rows:
                toolName = 'mcp_' + row['tool_name']
                self.tools[toolName] = {
                    'original_name': row['tool_name'],
                    'server_id': row['server_id'],
                    'server_url': row['server_url'],
                    'server_name': row['server_name'],
                    'server_headers': self._parseServerHeaders(row.get('server_headers')),
                    'server_transport': row.get('server_transport') if row.get('server_transport') is not None else 'http',
                    'description': row['tool_description'],
                    'input_schema_json': row['input_schema'],  # Keep raw JSON to avoid {} -> [] corruption
                    'has_ui': php_bool(row['has_ui']),
                    'ui_resource_uri': row.get('ui_resource_uri'),
                }
                self.serverUrls[row['server_id']] = row['server_url']

            error_log(f"[MCP] Loaded {len(self.tools)} MCP tools: {', '.join(self.tools.keys())}")
        except Exception as e:
            error_log(f"MCPToolsLoader: Failed to load tools: {e}")

        return self.tools

    def getToolDefinitions(self) -> list:
        """Get tool definitions in Claude/OpenAI format."""
        definitions = []

        for toolName, tool in self.tools.items():
            schemaJson = tool.get('input_schema_json')
            if schemaJson is None:
                schemaJson = '{"type":"object","properties":{}}'
            try:
                schema = json.loads(schemaJson)
            except (ValueError, TypeError):
                schema = {'type': 'object', 'properties': {}}

            description = tool.get('description')
            description = description if not php_empty(description) else tool['original_name']

            definitions.append({
                'name': toolName,
                'description': f"[MCP:{tool['server_name']}] {description}",
                'input_schema': schema,
            })

        return definitions

    def isMCPTool(self, toolName: str) -> bool:
        """Check if a tool is an MCP tool."""
        return toolName in self.tools or ('mcp_' + toolName) in self.tools

    def executeTool(self, toolName: str, arguments: dict) -> dict:
        """Execute an MCP tool by calling the MCP server."""
        prefixedName = toolName if toolName.startswith('mcp_') else 'mcp_' + toolName

        if prefixedName not in self.tools:
            return {
                'error': True,
                'message': f"MCP tool '{toolName}' not found",
            }

        tool = self.tools[prefixedName]
        serverUrl = tool['server_url']
        originalName = tool['original_name']

        callResult = self._callMCPServer(
            serverUrl,
            originalName,
            arguments,
            tool.get('server_headers') if tool.get('server_headers') is not None else [],
            tool.get('server_transport') if tool.get('server_transport') is not None else 'http',
        )
        result = callResult['formatted']
        rawResult = callResult['raw']

        error_log(f"🔧 [MCP] Tool execution for: {originalName}")
        error_log(f"🔧 [MCP] Tool has_ui flag: {'true' if tool['has_ui'] else 'false'}")
        error_log(f"🔧 [MCP] Formatted result: {json_encode(result)}")

        # Check for UI info in the result (viewUUID indicates tool has
        # dynamic UI).
        meta = result.get('_meta') if isinstance(result, dict) else None
        hasViewUUID = isinstance(meta, dict) and meta.get('viewUUID') is not None

        # If tool has UI (either static or dynamic via viewUUID), include UI
        # info. ALWAYS include UI info for tools with has_ui=true, even on
        # errors.
        if tool['has_ui'] or hasViewUUID:
            result['_mcp_ui'] = {
                'has_ui': True,
                'tool_name': originalName,
                'server_url': serverUrl,
                'server_name': tool['server_name'],
                'resource_uri': tool.get('ui_resource_uri'),
                'view_uuid': meta.get('viewUUID') if isinstance(meta, dict) else None,
                'arguments': arguments,  # Pass arguments so UI can use them
                'tool_result': rawResult,  # Pass raw result for ui/notifications/tool-result
                'has_error': result.get('error') is True,
            }

            viewUuidForLog = meta.get('viewUUID') if isinstance(meta, dict) else None
            viewUuidForLog = viewUuidForLog if viewUuidForLog is not None else 'none'
            error_log(f"🖼️ [MCP] Tool has UI: {originalName}, viewUUID: {viewUuidForLog}")
            error_log(f"🖼️ [MCP] Arguments passed: {json_encode(arguments)}")
            error_log(f"🖼️ [MCP] Tool result (raw): {json_encode(rawResult)[:500]}")
        else:
            error_log(f"⚠️ [MCP] Tool {originalName} does NOT have UI flag set")

        return result

    def _callMCPServer(self, serverUrl: str, toolName: str, arguments: dict, extraHeaders: list | None = None, transport: str = 'http') -> dict:
        """Call an MCP server to execute a tool."""
        extraHeaders = extraHeaders or []

        # The stored server_url is used byte-for-byte — NEVER rstrip the
        # trailing slash. Apache 301-redirects a directory-style URL
        # requested without its trailing slash, and httpx does not follow
        # redirects by default, so the JSON-RPC response ends up being the
        # redirect's HTML body, which fails to parse. Several registered
        # servers legitimately have trailing-slash URLs, so this must not be
        # "fixed" by re-adding a rstrip.
        #
        # We only apply the narrower SSE rewrite (a trailing "/sse" is really
        # the "/mcp" JSON-RPC endpoint) so SSE-transport servers stop getting
        # POSTed at their event-stream URL.
        mcpUrl = serverUrl
        if transport == 'sse' and mcpUrl.rstrip('/').endswith('/sse'):
            mcpUrl = mcpUrl.rstrip('/')[:-4] + '/mcp'

        # Ensure empty arguments is an object {} not array []. MCP servers
        # expect "arguments" to be a record/object.
        args = {} if php_empty(arguments) else arguments

        request = {
            'jsonrpc': '2.0',
            'id': int(time.time()),
            'method': 'tools/call',
            'params': {
                'name': toolName,
                'arguments': args,
            },
        }

        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream, */*',
        }
        for h in extraHeaders:
            if ': ' in h:
                name, value = h.split(': ', 1)
                headers[name] = value

        try:
            response = self._http.post(mcpUrl, json=request, headers=headers)
        except httpx.RequestError as e:
            return {
                'formatted': {
                    'error': True,
                    'message': f"MCP connection failed: {e}",
                },
                'raw': None,
            }

        if response.status_code >= 400:
            return {
                'formatted': {
                    'error': True,
                    'message': f"MCP server returned HTTP {response.status_code}",
                },
                'raw': None,
            }

        parsed = self._parseResponse(response.text)

        if parsed is None:
            return {
                'formatted': {
                    'error': True,
                    'message': "Failed to parse MCP response",
                },
                'raw': None,
            }

        if isinstance(parsed, dict) and parsed.get('error') is not None:
            errorField = parsed.get('error')
            message = errorField.get('message') if isinstance(errorField, dict) and errorField.get('message') is not None else 'MCP tool execution failed'
            return {
                'formatted': {
                    'error': True,
                    'message': message,
                },
                'raw': None,
            }

        result = parsed.get('result') if isinstance(parsed, dict) and parsed.get('result') is not None else parsed

        return {
            'formatted': self._formatToolResult(result),
            'raw': result,
        }

    def _parseResponse(self, response: str):
        """Parse response (JSON or SSE format)."""
        try:
            decoded = json.loads(response)
        except (ValueError, TypeError):
            decoded = None
        if decoded is not None:
            return decoded

        for line in response.split("\n"):
            line = line.strip()
            if line.startswith('data:'):
                data = line[5:].strip()
                if not php_empty(data):
                    try:
                        parsed = json.loads(data)
                    except (ValueError, TypeError):
                        parsed = None
                    if parsed is not None:
                        return parsed

        return None

    def _formatToolResult(self, result) -> dict:
        """Format MCP tool result for AI consumption."""
        # MCP tools return content array with type/text items
        if isinstance(result, dict) and isinstance(result.get('content'), list):
            textParts = []
            for item in result['content']:
                if not isinstance(item, dict):
                    continue
                if item.get('type') == 'text' and item.get('text') is not None:
                    textParts.append(item['text'])
                elif item.get('text') is not None:
                    textParts.append(item['text'])

            if textParts:
                return {
                    'result': "\n".join(textParts),
                    '_meta': result.get('_meta'),
                }

        # Return as-is if already formatted
        if isinstance(result, dict) and result.get('result') is not None:
            return result

        # Wrap raw result
        return {'result': json_encode(result)}

    def getTools(self) -> dict:
        """Get loaded tools."""
        return self.tools

    def hasTools(self) -> bool:
        """Check if any MCP tools are loaded."""
        return not php_empty(self.tools)

    def _parseServerHeaders(self, headers_json: str | None) -> list:
        """Parse stored JSON headers into 'Name: value' strings."""
        if headers_json is None or headers_json == '':
            return []
        try:
            decoded = json.loads(headers_json)
        except (ValueError, TypeError):
            return []
        if not isinstance(decoded, dict):
            return []
        out = []
        for name, value in decoded.items():
            if not isinstance(name, str) or name == '':
                continue
            if isinstance(value, (dict, list)) or value is None:
                continue
            name = re.sub(r'[\r\n:]', '', name)
            # PHP (string) cast: bool true -> '1', false -> ''; others -> str().
            strValue = ('1' if value else '') if isinstance(value, bool) else str(value)
            value = re.sub(r'[\r\n]', '', strValue)
            out.append(f"{name}: {value}")
        return out
