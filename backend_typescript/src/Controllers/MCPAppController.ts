import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx } from '../Support/Http';
import { McpEndpoint } from '../Services/McpEndpoint';
import { phpJsonEscape } from '../Support/PhpJson';

/** Raw (non-JSON) response: the route handler writes raw_body with these headers/status. */
export interface RawResult {
  raw_body: string;
  headers: Record<string, string>;
  status_code: number;
}

/**
 * MCP App Controller — TypeScript port of `Controllers/MCPAppController.php`.
 *
 * Fetches an MCP app's UI HTML via the `resources/read` protocol and serves it
 * directly (raw HTML, not JSON) so the frontend can load it in an iframe. Because
 * an iframe `src` cannot carry an Authorization header, `GET /api/v1/mcp/app` is a
 * PUBLIC route (see `MiddlewareProcessor.PUBLIC_ROUTES`) — matching the PHP backend.
 */
export class MCPAppController {
  /**
   * The HTML comes from an MCP server: run it in an opaque origin (no allow-same-origin), so it
   * cannot read this site's storage or session token, even when opened directly. Sent on every
   * answer, as PHP's index.php does.
   */
  static readonly SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-downloads allow-modals';

  /** GET /api/v1/mcp/app — returns HTML (or text/plain on error). */
  async getResource(ctx: Ctx): Promise<RawResult> {
    const q = ctx.query ?? {};
    const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

    const textErr = (msg: string, status: number): RawResult => ({
      raw_body: msg,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': MCPAppController.SANDBOX_CSP },
      status_code: status,
    });

    const isStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
    if (!isStr(q.server) || !isStr(q.resource)) return textErr('Invalid server or resource parameter', 400);
    const serverUrl = str(q.server);
    const resourceUri = str(q.resource);
    const west = str(q.west);
    const south = str(q.south);
    const east = str(q.east);
    const north = str(q.north);
    const label = str(q.label);
    const viewUUID = str(q.viewUUID);

    if (!serverUrl) return textErr('Missing server parameter', 400);
    if (!resourceUri) return textErr('Missing resource parameter', 400);

    // This route is public (an iframe cannot send the session header), so it only reaches MCP
    // servers someone registered, never any URL.
    if (!(await this.isRegisteredServer(serverUrl))) return textErr('Unknown MCP server', 404);

    // The endpoint is the first candidate (McpEndpoint: the URL as given,
    // then with "/mcp" in its path) that answers initialize with JSON-RPC.
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'GPT-Chatbot-MCP-App-Proxy', version: '1.0.0' },
        capabilities: {},
      },
    };
    let mcpUrl = serverUrl;
    let initResponse: any = null;
    for (const candidate of McpEndpoint.candidates(serverUrl)) {
      mcpUrl = candidate;
      initResponse = await this.sendMCPRequest(mcpUrl, initRequest);
      if (McpEndpoint.isJsonRpcReply(initResponse)) break;
    }
    if (!initResponse || initResponse.error) {
      return textErr('Failed to initialize MCP session', 502);
    }

    // Send initialized notification (fire-and-forget; no response expected)
    await this.sendMCPRequest(
      mcpUrl,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      false,
    );

    // Fetch the UI resource
    const resourceResponse = await this.sendMCPRequest(mcpUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: resourceUri },
    });
    if (!resourceResponse || resourceResponse.error) {
      const m = resourceResponse?.error?.message ?? 'Unknown error';
      return textErr('Failed to fetch MCP resource: ' + m, 502);
    }

    // Extract HTML content
    let htmlContent: string | null = resourceResponse?.result?.contents?.[0]?.text ?? null;
    if (!htmlContent) return textErr('No HTML content in MCP resource', 502);

    // Inject initialization script with the tool arguments (HEX flags: no '</script>' or quote in
    // a value can end the script)
    const serverUrlJs = MCPAppController.jsonHex(serverUrl);
    const initData = MCPAppController.jsonHex({
      west: west !== '' ? parseFloat(west) : null,
      south: south !== '' ? parseFloat(south) : null,
      east: east !== '' ? parseFloat(east) : null,
      north: north !== '' ? parseFloat(north) : null,
      label,
      viewUUID,
      serverUrl,
    });

    const initScript = `<script>
    // MCP App initialization data from parent
    window.MCP_INIT_DATA = ${initData};

    // Override the MCP server URL to point to the actual server
    window.MCP_SERVER_URL = ${serverUrlJs};

    // Dispatch init event when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
        });
    } else {
        window.dispatchEvent(new CustomEvent('mcp-init', { detail: window.MCP_INIT_DATA }));
    }
</script>`;

    // Inject before </head> or at the start
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', initScript + '</head>');
    } else {
      htmlContent = initScript + htmlContent;
    }

    return {
      raw_body: htmlContent,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': MCPAppController.SANDBOX_CSP },
      status_code: 200,
    };
  }

  /**
   * PHP json_encode($v, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT): default-flag
   * bytes (escaped slashes, \uXXXX for non-ASCII) with < > & ' " inside strings as \u003C etc.
   */
  static jsonHex(v: unknown): string {
    const quoted = JSON.stringify(v).replace(/\\(.)/g, (m, c) => (c === '"' ? '\\u0022' : m));
    const hexed = quoted.replace(/[<>&']/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
    return phpJsonEscape(hexed);
  }

  /** Whether an enabled MCP server row has this URL (trailing slash ignored). */
  private async isRegisteredServer(url: string): Promise<boolean> {
    const want = url.replace(/\/+$/, '');
    const rows = (await sql<{ url: string | null }>`SELECT url FROM mcp_servers WHERE enabled = 1`.execute(db)).rows;
    return rows.some((r) => String(r.url ?? '').replace(/\/+$/, '') === want);
  }

  /**
   * POST a JSON-RPC request to an MCP server. Returns the parsed JSON-RPC object
   * (from a JSON or SSE `data:` line), `{ success: true }` for notifications
   * (expectResponse=false), or null on HTTP/parse failure. Mirrors the PHP curl helper.
   */
  private async sendMCPRequest(
    url: string,
    request: unknown,
    expectResponse = true,
  ): Promise<any | null> {
    let text: string;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream, */*',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 400) return null;
      text = await res.text();
    } catch {
      return null;
    }

    if (!expectResponse) return { success: true };
    if (!text) return null;

    // Try JSON first
    try {
      const decoded = JSON.parse(text);
      if (decoded !== null) return decoded;
    } catch {
      // fall through to SSE parsing
    }

    // Try SSE format (data: <json> lines)
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) {
          try {
            const parsed = JSON.parse(data);
            if (parsed !== null) return parsed;
          } catch {
            // keep scanning subsequent data: lines
          }
        }
      }
    }

    return null;
  }
}
