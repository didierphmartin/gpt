"""Port of Controllers/MCPProxyController.php (15-614).

MCP Proxy Controller

Forwards JSON-RPC 2.0 requests from the frontend to configured MCP servers.
This proxy avoids CORS issues and keeps MCP server URLs secure.
"""
from __future__ import annotations

import json
import re
import time

import httpx

from app.controllers.mcp_server_controller import MCPServerController
from app.providers._http import SHARED_SSL_CONTEXT
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, php_items, php_strval, php_trim
from app.support.phpjson import php_json_arrays as _php_json_arrays
from app.support.phpjson import php_json_encode


def _isset_error(value) -> bool:
    """`isset($response['error'])` for a value that is either a decoded
    JSON-RPC dict or None (never a list at this position)."""
    return isinstance(value, dict) and value.get('error') is not None


class MCPProxyController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self.lastError: str | None = None
        self._presence = DbPresence(db, 'MCPProxyController')
        self.ensureTablesExist()

    # ─── forward() — single public entry point (PHP 32-70) ─────────────────

    def forward(self, request) -> dict:
        """Forward JSON-RPC request to MCP server."""
        input_ = request['body'] if request.get('body') is not None else {}
        if not isinstance(input_, dict):
            input_ = {}

        action = input_.get('action')
        # server_id arrives as a string when round-tripped through JSON (PDO::
        # lastInsertId returns string); normalize to ?int for the strict
        # signatures on proxyRequest() and discoverTools().
        rawServerId = input_.get('server_id')
        serverId = None if (rawServerId is None or rawServerId == '') else php_intval(rawServerId)
        serverUrl = input_.get('server_url')
        userId = php_strval(
            input_['user_id'] if input_.get('user_id') is not None
            else (request['user_id'] if request.get('user_id') is not None else 'demo-user')
        )

        if action == 'proxy':
            return self._proxyRequest(serverUrl, serverId, input_.get('jsonrpc'), userId)

        if action == 'test_connection':
            transport = MCPServerController.normalizeTransport(input_.get('transport'))
            transport = transport if transport is not None else 'http'
            return self._testConnection(serverUrl, self._normalizeHeaders(input_.get('headers')), transport)

        if action == 'discover_tools':
            if not isinstance(serverUrl, str) or serverUrl == '':
                return {
                    'success': False,
                    'error': {'code': -32602, 'message': 'Server URL required'},
                    'status_code': 400,
                }
            return self._discoverTools(serverUrl, serverId, userId)

        return {
            'success': False,
            'error': {'code': -32600, 'message': 'Unknown action: ' + php_strval(action)},
            'status_code': 400,
        }

    # ─── proxyRequest (PHP 75-168) ──────────────────────────────────────────

    def _proxyRequest(self, serverUrl, serverId, jsonrpc, userId: str) -> dict:
        # Get server URL from ID if not provided directly
        if not serverUrl and serverId:
            serverUrl = self._getServerUrl(serverId, userId)

        # Look up custom headers by server id (global or caller's user scope)
        extraHeaders = self._getServerHeaders(serverId, userId) if serverId else []
        transport = self._getServerTransport(serverId, userId) if serverId else 'http'

        if not serverUrl:
            return {
                'success': False,
                'error': {'code': -32602, 'message': 'Server URL required'},
                'status_code': 400,
            }

        if not jsonrpc:
            return {
                'success': False,
                'error': {'code': -32602, 'message': 'JSON-RPC request required'},
                'status_code': 400,
            }

        # PHP's `?array $jsonrpc` type-hint accepts BOTH a JSON object and a
        # JSON list (json_decode(..., true) turns either into a PHP array) —
        # only a genuine JSON scalar for `jsonrpc` would have thrown a
        # TypeError at the call site. A caller sending a scalar here is not a
        # real scenario (every frontend caller sends a JSON-RPC object), so
        # this is ported for parity, not exercised by any test.
        if isinstance(jsonrpc, list):
            jsonrpc = {i: v for i, v in enumerate(jsonrpc)}
        elif not isinstance(jsonrpc, dict):
            raise TypeError('proxyRequest(): Argument #3 ($jsonrpc) must be of type ?array')
        else:
            jsonrpc = dict(jsonrpc)

        # Ensure proper JSON-RPC structure
        if jsonrpc.get('jsonrpc') is None:
            jsonrpc['jsonrpc'] = '2.0'
        if jsonrpc.get('id') is None:
            jsonrpc['id'] = int(time.time())

        # Ensure params.arguments is an object, not an array (for tools/call)
        method = jsonrpc.get('method') if jsonrpc.get('method') is not None else ''
        if method == 'tools/call' and jsonrpc.get('params') is not None:
            params = jsonrpc['params']
            if isinstance(params, dict):
                args = params.get('arguments')
                if args is None or (isinstance(args, (list, dict)) and php_empty(args)):
                    params['arguments'] = {}

        # For resources/read and tools/call requests, initialize the MCP session first
        if method.startswith('resources/') or method.startswith('tools/'):
            initRequest = {
                'jsonrpc': '2.0',
                'id': 1,
                'method': 'initialize',
                'params': {
                    'protocolVersion': '2024-11-05',
                    'clientInfo': {'name': 'GPT-Chatbot-MCP-Client', 'version': '1.0.0'},
                    'capabilities': {},
                },
            }

            initResponse = self._sendToMCPServer(serverUrl, initRequest, True, extraHeaders, transport)
            if initResponse is None or _isset_error(initResponse):
                return {
                    'success': False,
                    'error': {'code': -32603, 'message': 'Failed to initialize MCP session'},
                    'status_code': 500,
                }

            # Send initialized notification
            self._sendToMCPServer(serverUrl, {
                'jsonrpc': '2.0',
                'method': 'notifications/initialized',
                'params': {},
            }, False, extraHeaders, transport)

        # Forward request to MCP server
        response = self._sendToMCPServer(serverUrl, jsonrpc, True, extraHeaders, transport)

        if response is None:
            return {
                'success': False,
                'error': {'code': -32603, 'message': 'Failed to connect to MCP server'},
                'status_code': 500,
            }

        return {'success': True, 'response': response, 'status_code': 200}

    # ─── testConnection (PHP 173-225) ───────────────────────────────────────

    def _testConnection(self, serverUrl, extraHeaders=None, transport: str = 'http') -> dict:
        extraHeaders = extraHeaders if extraHeaders is not None else []

        if not serverUrl:
            return {
                'success': False,
                'error': {'code': -32602, 'message': 'Server URL required'},
                'status_code': 400,
            }

        initRequest = {
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'clientInfo': {'name': 'GPT-Chatbot-MCP-Client', 'version': '1.0.0'},
                'capabilities': {},
            },
        }

        response = self._sendToMCPServer(serverUrl, initRequest, True, extraHeaders, transport)

        if response is None:
            urlTried = self.resolveEndpointUrl(serverUrl, transport)
            return {
                'success': False,
                'error': self.lastError if self.lastError is not None else 'Failed to connect to MCP server',
                'url_tried': urlTried,
                'status_code': 500,
            }

        if _isset_error(response):
            err = response['error']
            message = err.get('message') if isinstance(err, dict) and err.get('message') is not None else 'Unknown error'
            return {'success': False, 'error': message, 'details': err, 'status_code': 500}

        result = response.get('result') if isinstance(response, dict) else None
        serverInfo = result.get('serverInfo') if isinstance(result, dict) else None
        capabilities = result.get('capabilities') if isinstance(result, dict) else None
        return {
            'success': True,
            'serverInfo': serverInfo,
            'capabilities': capabilities,
            'status_code': 200,
        }

    # ─── discoverTools (PHP 230-313) ────────────────────────────────────────

    def _discoverTools(self, serverUrl: str, serverId, userId: str) -> dict:
        extraHeaders = self._getServerHeaders(serverId, userId) if serverId else []
        transport = self._getServerTransport(serverId, userId) if serverId else 'http'
        if not serverUrl:
            return {
                'success': False,
                'error': {'code': -32602, 'message': 'Server URL required'},
                'status_code': 400,
            }

        # First initialize
        initRequest = {
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'clientInfo': {'name': 'GPT-Chatbot-MCP-Client', 'version': '1.0.0'},
                'capabilities': {},
            },
        }

        initResponse = self._sendToMCPServer(serverUrl, initRequest, True, extraHeaders, transport)

        if initResponse is None:
            return {
                'success': False,
                'error': {'code': -32603, 'message': self.lastError if self.lastError is not None else 'Failed to initialize MCP server'},
                'status_code': 500,
            }

        if _isset_error(initResponse):
            err = initResponse['error']
            message = err.get('message') if isinstance(err, dict) and err.get('message') is not None else 'MCP server returned error'
            return {
                'success': False,
                'error': {'code': -32603, 'message': message},
                'status_code': 500,
            }

        # Send initialized notification
        self._sendToMCPServer(serverUrl, {
            'jsonrpc': '2.0',
            'method': 'notifications/initialized',
            'params': {},
        }, False, extraHeaders, transport)

        # List tools
        toolsRequest = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}}

        toolsResponse = self._sendToMCPServer(serverUrl, toolsRequest, True, extraHeaders, transport)

        if toolsResponse is None or _isset_error(toolsResponse):
            return {
                'success': False,
                'error': {'code': -32603, 'message': 'Failed to list tools from MCP server'},
                'status_code': 500,
            }

        result = toolsResponse.get('result') if isinstance(toolsResponse, dict) else None
        tools = result.get('tools') if isinstance(result, dict) and result.get('tools') is not None else []

        # Cache tools in database if we have a server ID
        if serverId:
            self._cacheTools(serverId, tools)

        initResult = initResponse.get('result') if isinstance(initResponse, dict) else None
        serverInfo = initResult.get('serverInfo') if isinstance(initResult, dict) else None

        return {
            'success': True,
            'serverInfo': serverInfo,
            'tools': tools,
            'status_code': 200,
        }

    # ─── resolveEndpointUrl (PHP 323-333, static) ───────────────────────────

    @staticmethod
    def resolveEndpointUrl(serverUrl: str, transport: str = 'http') -> str:
        """Compute the URL the proxy POSTs JSON-RPC to.
         - 'sse' transport: a trailing "/sse" is replaced by "/mcp" (MCPeek's
           SSEMCPClient.initializeSession behaviour). Servers that only answer
           over the event stream are not supported by this proxy.
         - then, for every transport: append "/mcp" unless the URL already ends
           in "/mcp" or ".php" (XAMPP-style script endpoints).
        """
        url = serverUrl.rstrip('/')
        if transport == 'sse' and url.endswith('/sse'):
            url = url[:-4] + '/mcp'
        if not url.endswith('/mcp') and not url.endswith('.php'):
            url += '/mcp'
        return url

    # ─── sendToMCPServer (PHP 338-405) ──────────────────────────────────────

    def _makeClient(self) -> httpx.Client:
        """Python-only: PHP re-inits a fresh curl handle per call (curl_init/
        curl_close at 350/365); an httpx.Client per call mirrors that exactly
        and keeps this monkeypatchable with httpx.MockTransport in tests."""
        return httpx.Client(
            timeout=httpx.Timeout(120.0, connect=15.0),
            follow_redirects=True,
            verify=SHARED_SSL_CONTEXT,
        )

    def _sendToMCPServer(self, serverUrl: str, request: dict, expectResponse: bool = True,
                          extraHeaders=None, transport: str = 'http'):
        """Send request to MCP server."""
        extraHeaders = extraHeaders if extraHeaders is not None else []
        self.lastError = None

        mcpUrl = self.resolveEndpointUrl(serverUrl, transport)

        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream, */*',
        }
        for h in extraHeaders:
            if ': ' in h:
                name, value = h.split(': ', 1)
                headers[name] = value

        client = self._makeClient()
        try:
            try:
                response = client.post(mcpUrl, json=request, headers=headers)
            except httpx.RequestError as e:
                # PHP: "Connection failed: $error (code: $errno)" — libcurl's
                # numeric errno has no httpx equivalent; the exception text
                # takes its place (ruling: PHP 367-370, not byte-identical).
                self.lastError = f"Connection failed: {e}"
                return None

            httpCode = response.status_code

            if httpCode >= 400:
                errorDetails = ''
                try:
                    parsed = response.json()
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    err = parsed.get('error')
                    if isinstance(err, dict) and err.get('message') is not None:
                        errorDetails = ': ' + php_strval(err['message'])
                self.lastError = f"Server returned HTTP {httpCode}{errorDetails}"
                return None

            if not expectResponse:
                return {'success': True}

            # Try to parse as plain JSON
            responseText = response.text
            try:
                decoded = json.loads(responseText)
            except (ValueError, TypeError):
                decoded = None
            if decoded is not None:
                return _php_json_arrays(decoded)

            # Try to parse as SSE format
            decoded = self._parseSSEResponse(responseText)
            if decoded is not None:
                return decoded

            self.lastError = "Server returned invalid response format"
            return None
        finally:
            client.close()

    # ─── parseSSEResponse (PHP 410-429) ─────────────────────────────────────

    def _parseSSEResponse(self, response: str):
        """Parse Server-Sent Events (SSE) response format."""
        lines = response.split("\n")
        jsonData = None

        for line in lines:
            line = php_trim(line)
            if line.startswith('data:'):
                data = php_trim(line[5:])
                if not php_empty(data):
                    try:
                        parsed = json.loads(data)
                    except (ValueError, TypeError):
                        parsed = None
                    if parsed is not None:
                        jsonData = _php_json_arrays(parsed)

        return jsonData

    # ─── getServerUrl (PHP 434-444) ─────────────────────────────────────────

    def _getServerUrl(self, serverId: int, userId: str):
        """Get server URL from database. NB: matches only servers OWNED by
        this exact userId (`user_id = ?`, no `OR user_id IS NULL`) — a global
        server can only be resolved by URL when the caller also sent
        `server_url` directly (PHP 436-439, ported verbatim)."""
        row = self.db.fetch_one(
            "SELECT url FROM mcp_servers WHERE id = ? AND user_id = ? AND enabled = 1",
            [serverId, userId])
        return row.get('url') if row is not None else None

    # ─── getServerHeaders (PHP 450-476) ─────────────────────────────────────

    def _getServerHeaders(self, serverId: int, userId: str) -> list:
        """Get custom headers for an MCP server (global or caller-scoped),
        returned as "Name: value" strings for the outgoing request headers."""
        try:
            row = self.db.fetch_one(
                "SELECT headers FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1",
                [serverId, userId])
            if row is None or php_empty(row.get('headers')):
                return []
            try:
                decoded = json.loads(row['headers'])
            except (ValueError, TypeError):
                decoded = None
            if not isinstance(decoded, (dict, list)):
                return []
            return self._normalizeHeaders(decoded)
        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log('[MCPProxy] getServerHeaders failed: ' + str(e))
            return []

    # ─── getServerTransport (PHP 479-493) ───────────────────────────────────

    def _getServerTransport(self, serverId: int, userId: str) -> str:
        """Transport stored for a global or caller-owned server; 'http' when unknown."""
        try:
            row = self.db.fetch_one(
                "SELECT transport FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1",
                [serverId, userId])
            transport = MCPServerController.normalizeTransport(row.get('transport') if row is not None else None)
            return transport if transport is not None else 'http'
        except Exception:  # noqa: BLE001 — PHP catches \Exception here
            return 'http'

    # ─── normalizeHeaders (PHP 500-514) ─────────────────────────────────────

    def _normalizeHeaders(self, headers) -> list:
        """Convert a request-supplied headers map (e.g. {"Authorization": "Bearer x"})
        into the "Name: value" string list the outgoing request needs. Mirrors
        the sanitization in getServerHeaders(). Returns [] for empty/invalid input.
        """
        if not isinstance(headers, (dict, list)) or not headers:
            return []
        out = []
        for name, value in php_items(headers):
            if not isinstance(name, str) or name == '':
                continue
            if isinstance(value, (dict, list)) or value is None:
                continue  # is_scalar() is false for array/object/null
            name = re.sub(r'[\r\n:]', '', name)
            strValue = ('1' if value else '') if isinstance(value, bool) else php_strval(value)
            value = re.sub(r'[\r\n]', '', strValue)
            out.append(f"{name}: {value}")
        return out

    # ─── cacheTools (PHP 519-547) ───────────────────────────────────────────

    def _cacheTools(self, serverId: int, tools: list) -> None:
        """Cache discovered tools in database."""
        # Clear existing tools for this server
        self.db.execute("DELETE FROM mcp_server_tools WHERE server_id = ?", [serverId])

        for tool in tools:
            if not isinstance(tool, dict):
                continue
            meta = tool.get('_meta')
            ui = meta.get('ui') if isinstance(meta, dict) else None
            hasUi = isinstance(ui, dict) and ui.get('resourceUri') is not None
            uiResourceUri = ui.get('resourceUri') if isinstance(ui, dict) else None

            # Sanitize input schema
            inputSchema = tool.get('inputSchema') if tool.get('inputSchema') is not None else {'type': 'object', 'properties': {}}
            inputSchema = self._sanitizeSchema(inputSchema)

            self.db.execute("""
                INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
                VALUES (?, ?, ?, ?, ?, ?)
            """, [
                serverId,
                tool.get('name'),
                tool.get('description') if tool.get('description') is not None else '',
                php_json_encode(inputSchema),
                1 if hasUi else 0,
                uiResourceUri,
            ])

    # ─── sanitizeSchema (PHP 552-577) ───────────────────────────────────────

    def _sanitizeSchema(self, schema):
        """Sanitize tool input schema. Every empty container (list OR dict —
        both are indistinguishable PHP arrays post-json_decode) comes back out
        as `{}`: plain Python `{}` already json-encodes that way, so no
        stdClass-equivalent sentinel is needed here."""
        if isinstance(schema, dict) and not schema:
            return {}
        if isinstance(schema, list) and not schema:
            return {}

        if isinstance(schema, dict):
            schema = dict(schema)
            for key in ('$schema', 'default', '$id', 'definitions', '$defs'):
                schema.pop(key, None)
            for key, value in list(schema.items()):
                if isinstance(value, (dict, list)):
                    schema[key] = self._sanitizeSchema(value)
            return schema

        if isinstance(schema, list):
            return [self._sanitizeSchema(v) if isinstance(v, (dict, list)) else v for v in schema]

        return schema

    # ─── ensureTablesExist (PHP 582-613; no-DDL per constraints.md §3) ─────

    def ensureTablesExist(self) -> None:
        """PHP `CREATE TABLE IF NOT EXISTS mcp_servers / mcp_server_tools`."""
        self._presence.table('mcp_servers')
        self._presence.table('mcp_server_tools')
