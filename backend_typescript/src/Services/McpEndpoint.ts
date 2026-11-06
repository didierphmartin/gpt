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

  /**
   * The address this backend can reach for a registered URL. In the Docker
   * app servers are registered as the public gateway (http://localhost:8790/...)
   * but the web container reaches the supervisor as MCPS_GATEWAY (http://mcps:8790).
   * Both env values must be set; otherwise the URL is returned unchanged.
   */
  static internal(url: string): string {
    const gateway = process.env.MCPS_GATEWAY ?? '';
    const pub = (process.env.MCPS_PUBLIC_GATEWAY ?? '').replace(/\/+$/, '');
    if (gateway === '' || pub === '') return url;
    for (const prefix of [pub + '/', pub.replace('//localhost', '//127.0.0.1') + '/']) {
      if (url.startsWith(prefix)) return gateway.replace(/\/+$/, '') + '/' + url.slice(prefix.length);
    }
    return url;
  }

  /**
   * Stored headers JSON as name => value. Skips non-string names and
   * non-scalar values; strips CR/LF and ":" from names, CR/LF from values.
   */
  static decodeStoredHeaders(raw: unknown): Record<string, string> {
    if (raw === null || raw === undefined || raw === '') return {};
    let decoded: unknown = raw;
    if (typeof raw === 'string') {
      try {
        decoded = JSON.parse(raw);
      } catch {
        return {};
      }
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
      if (name === '') continue;
      let v: string;
      if (typeof value === 'string' || typeof value === 'number') v = String(value);
      else if (typeof value === 'boolean') v = value ? '1' : '';
      else continue;
      out[name.replace(/[\r\n:]/g, '')] = v.replace(/[\r\n]/g, '');
    }
    return out;
  }
}
