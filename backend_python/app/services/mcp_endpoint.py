"""Port of Services/McpEndpoint.php.

Where an MCP client POSTs JSON-RPC for a registered server URL.

One rule for every client (proxy, tools loader, app proxy): the registered
URL is tried as given first; only if that fails (HTTP error, no reply, or a
reply that is not JSON-RPC) is "/mcp" tried, inserted into the path before
any query string. Not every server lives at ".../mcp" — e.g. a PHP endpoint
addressed by query (http://localhost/servicenow/?profile=mock&toolset=jobs).
"""
from __future__ import annotations

import json
import os
import re


class McpEndpoint:
    @staticmethod
    def candidates(serverUrl: str, transport: str = 'http') -> list[str]:
        """The URLs to try, in order.
         - 'sse' transport: a trailing "/sse" path is the event stream; its
           JSON-RPC endpoint is the sibling "/mcp" (MCPeek's SSEMCPClient), the
           only candidate.
         - a path already ending in "/mcp" or ".php" is the endpoint: no fallback.
         - the as-given URL is used byte-for-byte (never trim its trailing slash:
           Apache 301-redirects a directory URL requested without it).
        """
        cut = re.search(r'[?#]', serverUrl)
        cut = cut.start() if cut else len(serverUrl)
        path, rest = serverUrl[:cut], serverUrl[cut:]
        trimmed = path.rstrip('/')

        if transport == 'sse' and trimmed.endswith('/sse'):
            return [trimmed[:-4] + '/mcp' + rest]
        if trimmed.endswith('/mcp') or trimmed.endswith('.php'):
            return [serverUrl]
        return [serverUrl, trimmed + '/mcp' + rest]

    @staticmethod
    def isJsonRpcReply(decoded) -> bool:
        """True for a decoded JSON-RPC reply (a result or an error). "jsonrpc"
        is not required: lenient servers omit it and have always been accepted."""
        return isinstance(decoded, dict) and ('result' in decoded or 'error' in decoded)

    @staticmethod
    def internal(url: str) -> str:
        """The address this backend can reach for a registered URL. In the Docker
        app servers are registered as the public gateway (http://localhost:8790/...)
        but the web container reaches the supervisor as MCPS_GATEWAY (http://mcps:8790).
        Both env values must be set; otherwise the URL is returned unchanged."""
        gateway = os.environ.get('MCPS_GATEWAY', '')
        public = os.environ.get('MCPS_PUBLIC_GATEWAY', '').rstrip('/')
        if gateway == '' or public == '':
            return url
        for prefix in (public + '/', public.replace('//localhost', '//127.0.0.1') + '/'):
            if url.startswith(prefix):
                return gateway.rstrip('/') + '/' + url[len(prefix):]
        return url

    @staticmethod
    def decodeStoredHeaders(raw) -> dict[str, str]:
        """Stored headers JSON as name => value. Skips non-string names and
        non-scalar values; strips CR/LF and ":" from names, CR/LF from values."""
        if raw is None or raw == '':
            return {}
        try:
            decoded = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except ValueError:
            return {}
        if not isinstance(decoded, dict):
            return {}
        out: dict[str, str] = {}
        for name, value in decoded.items():
            if not isinstance(name, str) or name == '' or not _is_scalar(value):
                continue
            out[re.sub(r'[\r\n:]', '', name)] = re.sub(r'[\r\n]', '', _scalar_str(value))
        return out


def _is_scalar(value) -> bool:
    return isinstance(value, (str, int, float, bool))


def _scalar_str(value) -> str:
    """PHP (string) cast of a scalar: true → '1', false → ''."""
    if isinstance(value, bool):
        return '1' if value else ''
    return str(value)
