"""Port of Controllers/MCPAppController.php (15-225).

MCP App Controller

Fetches MCP app HTML via the resources/read protocol and serves it directly.
"""
from __future__ import annotations

import json

import httpx

from app.providers._http import SHARED_SSL_CONTEXT
from app.support.phpcompat import php_empty, php_floatval, php_trim
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

        # Normalize URL: servers ending in .php are already the endpoint
        # (e.g. XAMPP-style mcp-server.php). Only append /mcp otherwise.
        # PHP: rtrim($serverUrl, '/') — trailing-only, unlike php_trim()'s
        # trim() semantics, so str.rstrip('/') is used directly here.
        mcpUrl = serverUrl.rstrip('/')
        if not mcpUrl.endswith('/mcp') and not mcpUrl.endswith('.php'):
            mcpUrl += '/mcp'

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

        initResponse = self._sendMCPRequest(mcpUrl, initRequest)
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

        # Inject initialization script with the tool arguments
        initData = php_json_encode({
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
            f"    window.MCP_SERVER_URL = '{serverUrl}';\n"
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
