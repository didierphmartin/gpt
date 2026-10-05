"""Port of Services/McpEndpoint.php.

Where an MCP client POSTs JSON-RPC for a registered server URL.

One rule for every client (proxy, tools loader, app proxy): the registered
URL is tried as given first; only if that fails (HTTP error, no reply, or a
reply that is not JSON-RPC) is "/mcp" tried, inserted into the path before
any query string. Not every server lives at ".../mcp" — e.g. a PHP endpoint
addressed by query (http://localhost/servicenow/?profile=mock&toolset=jobs).
"""
from __future__ import annotations

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
