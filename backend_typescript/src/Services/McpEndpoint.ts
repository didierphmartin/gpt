/**
 * Where an MCP client POSTs JSON-RPC for a registered server URL.
 * TypeScript port of `Services/McpEndpoint.php`.
 *
 * One rule for every client (proxy, tools loader, app proxy): the registered
 * URL is tried as given first; only if that fails (HTTP error, no reply, or a
 * reply that is not JSON-RPC) is "/mcp" tried, inserted into the path before
 * any query string. Not every server lives at ".../mcp" — e.g. a PHP endpoint
 * addressed by query (http://localhost/servicenow/?profile=mock&toolset=jobs).
 */
export class McpEndpoint {
  /**
   * The URLs to try, in order.
   *  - 'sse' transport: a trailing "/sse" path is the event stream; its
   *    JSON-RPC endpoint is the sibling "/mcp", the only candidate.
   *  - a path already ending in "/mcp" or ".php" is the endpoint: no fallback.
   *  - the as-given URL is used byte-for-byte (never trim its trailing slash:
   *    Apache 301-redirects a directory URL requested without it).
   */
  static candidates(serverUrl: string, transport = 'http'): string[] {
    const cut = serverUrl.search(/[?#]/);
    const path = cut < 0 ? serverUrl : serverUrl.slice(0, cut);
    const rest = cut < 0 ? '' : serverUrl.slice(cut);
    const trimmed = path.replace(/\/+$/, '');

    if (transport === 'sse' && trimmed.endsWith('/sse')) {
      return [trimmed.slice(0, -4) + '/mcp' + rest];
    }
    if (trimmed.endsWith('/mcp') || trimmed.endsWith('.php')) {
      return [serverUrl];
    }
    return [serverUrl, trimmed + '/mcp' + rest];
  }

  /**
   * True for a decoded JSON-RPC reply (a result or an error). "jsonrpc" is
   * not required: lenient servers omit it and have always been accepted.
   */
  static isJsonRpcReply(decoded: unknown): boolean {
    return (
      decoded !== null &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      ('result' in (decoded as object) || 'error' in (decoded as object))
    );
  }
}
