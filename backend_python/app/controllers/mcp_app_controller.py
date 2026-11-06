"""Port of Controllers/MCPAppController.php (15-225).

MCP App Controller

Fetches MCP app HTML via the resources/read protocol and serves it directly.
"""
from __future__ import annotations

import json
import re

import httpx

from app.providers._http import SHARED_SSL_CONTEXT
from app.services.mcp_endpoint import McpEndpoint
from app.support.phpcompat import php_empty, php_floatval, php_strval, php_trim
from app.support.phpjson import php_json_arrays as _php_json_arrays
from app.support.phpjson import php_json_encode


class MCPAppController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config

    # ─── getResource (PHP 32-170) ───────────────────────────────────────────

    def getResource(self, request) -> dict:
        """Get MCP app resource (returns HTML directly, not JSON).

        This method is special - it outputs HTML directly and should be called
        from a route handler that doesn't JSON-encode the response.
        """
        query = request['query'] if request.get('query') is not None else {}
        serverUrl = query.get('server') if query.get('server') is not None else ''
        resourceUri = query.get('resource') if query.get('resource') is not None else ''
        if not isinstance(serverUrl, str) or not isinstance(resourceUri, str):
            return {'error': 'Invalid server or resource parameter', 'status_code': 400, 'content_type': 'text/plain'}
        west = query.get('west') if query.get('west') is not None else ''
        south = query.get('south') if query.get('south') is not None else ''
        east = query.get('east') if query.get('east') is not None else ''
        north = query.get('north') if query.get('north') is not None else ''
        label = query.get('label') if query.get('label') is not None else ''
        viewUUID = query.get('viewUUID') if query.get('viewUUID') is not None else ''

        if not serverUrl:
            return {'error': 'Missing server parameter', 'status_code': 400, 'content_type': 'text/plain'}

        if not resourceUri:
            return {'error': 'Missing resource parameter', 'status_code': 400, 'content_type': 'text/plain'}

        # This route is public (an iframe cannot send the session header), so
        # it only reaches MCP servers someone registered, never any URL.
        if not self._isRegisteredServer(serverUrl):
            return {'error': 'Unknown MCP server', 'status_code': 404, 'content_type': 'text/plain'}

        # Initialize MCP session
        initRequest = {
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'clientInfo': {'name': 'GPT-Chatbot-MCP-App-Proxy', 'version': '1.0.0'},
                'capabilities': {},
            },
        }

        # The endpoint is the first candidate (McpEndpoint: the URL as given,
        # then with "/mcp" in its path) that answers initialize with JSON-RPC.
        initResponse = None
        mcpUrl = serverUrl
        for mcpUrl in McpEndpoint.candidates(serverUrl):
            initResponse = self._sendMCPRequest(mcpUrl, initRequest)
            if McpEndpoint.isJsonRpcReply(initResponse):
                break
        if not initResponse or _isset_error(initResponse):
            return {'error': 'Failed to initialize MCP session', 'status_code': 502, 'content_type': 'text/plain'}

        # Send initialized notification
        self._sendMCPRequest(mcpUrl, {
            'jsonrpc': '2.0',
            'method': 'notifications/initialized',
            'params': {},
        }, False)

        # Fetch the UI resource
        resourceRequest = {
            'jsonrpc': '2.0',
            'id': 2,
            'method': 'resources/read',
            'params': {'uri': resourceUri},
        }

        resourceResponse = self._sendMCPRequest(mcpUrl, resourceRequest)

        if not resourceResponse or _isset_error(resourceResponse):
            err = resourceResponse.get('error') if isinstance(resourceResponse, dict) else None
            message = err.get('message') if isinstance(err, dict) and err.get('message') is not None else 'Unknown error'
            return {
                'error': f'Failed to fetch MCP resource: {message}',
                'status_code': 502,
                'content_type': 'text/plain',
            }

        # Extract HTML content
        result = resourceResponse.get('result') if isinstance(resourceResponse, dict) else None
        contents = result.get('contents') if isinstance(result, dict) else None
        htmlContent = None
        if isinstance(contents, list) and contents and isinstance(contents[0], dict):
            htmlContent = contents[0].get('text')

        if not htmlContent:
            return {'error': 'No HTML content in MCP resource', 'status_code': 502, 'content_type': 'text/plain'}

        # Inject initialization script with the tool arguments (HEX flags: no
        # '</script>' or quote in a value can end the script)
        serverUrlJs = _json_encode_hex(serverUrl)
        initData = _json_encode_hex({
            'west': php_floatval(west) if west != '' else None,
            'south': php_floatval(south) if south != '' else None,
            'east': php_floatval(east) if east != '' else None,
            'north': php_floatval(north) if north != '' else None,
            'label': label,
            'viewUUID': viewUUID,
            'serverUrl': serverUrl,
        })

        initScript = (
            "<script>\n"
            "    // MCP App initialization data from parent\n"
            f"    window.MCP_INIT_DATA = {initData};\n"
            "\n"
            "    // Override the MCP server URL to point to the actual server\n"
            f"    window.MCP_SERVER_URL = {serverUrlJs};\n"
            "\n"
            "    // Dispatch init event when DOM is ready\n"
            "    if (document.readyState === 'loading') {\n"
            "        document.addEventListener('DOMContentLoaded', function() {\n"
            "            window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));\n"
            "        });\n"
            "    } else {\n"
            "        window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));\n"
            "    }\n"
            "</script>"
        )

        # Inject before </head> or at the start
        if '</head>' in htmlContent:
            htmlContent = htmlContent.replace('</head>', initScript + '</head>')
        else:
            htmlContent = initScript + htmlContent

        return {'html': htmlContent, 'status_code': 200, 'content_type': 'text/html; charset=utf-8'}

    def _isRegisteredServer(self, url: str) -> bool:
        """Whether an enabled MCP server row has this URL (trailing slash ignored)."""
        want = url.rstrip('/')
        rows = self.db.fetch_all("SELECT url FROM mcp_servers WHERE enabled = 1")
        return any(php_strval(row.get('url')).rstrip('/') == want for row in rows)

    # ─── sendMCPRequest (PHP 175-224) ───────────────────────────────────────

    def _makeClient(self) -> httpx.Client:
        """Python-only: PHP re-inits a fresh curl handle per call; an
        httpx.Client per call mirrors that and keeps this monkeypatchable
        with httpx.MockTransport in tests."""
        return httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0), verify=SHARED_SSL_CONTEXT)

    def _sendMCPRequest(self, url: str, request: dict, expectResponse: bool = True):
        """Send request to MCP server."""
        client = self._makeClient()
        try:
            try:
                response = client.post(url, json=request, headers={
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream, */*',
                })
            except httpx.RequestError:
                return None

            httpCode = response.status_code
            if httpCode >= 400 or not response.text:
                return None

            if not expectResponse:
                return {'success': True}

            # Try JSON first
            try:
                decoded = json.loads(response.text)
            except (ValueError, TypeError):
                decoded = None
            if decoded is not None:
                return _php_json_arrays(decoded)

            # Try SSE format
            for line in response.text.split("\n"):
                line = php_trim(line)
                if line.startswith('data:'):
                    data = php_trim(line[5:])
                    if not php_empty(data):
                        try:
                            parsed = json.loads(data)
                        except (ValueError, TypeError):
                            parsed = None
                        if parsed is not None:
                            return _php_json_arrays(parsed)

            return None
        finally:
            client.close()


def _isset_error(value) -> bool:
    """`isset($response['error'])` for a decoded JSON-RPC dict (or None)."""
    return isinstance(value, dict) and value.get('error') is not None


_HEX = {'<': '\\u003C', '>': '\\u003E', '&': '\\u0026', "'": '\\u0027', '\\"': '\\u0022'}


def _json_encode_hex(value) -> str:
    """json_encode($v, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT).
    Escape pairs are matched first, so an escaped backslash is left alone."""
    return re.sub(r'\\.|[<>&\']', lambda m: _HEX.get(m.group(0), m.group(0)), php_json_encode(value))
