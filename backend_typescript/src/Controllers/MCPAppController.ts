import { Ctx } from '../Support/Http';

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
  /** GET /api/v1/mcp/app — returns HTML (or text/plain on error). */
  async getResource(ctx: Ctx): Promise<RawResult> {
    const q = ctx.query ?? {};
    const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

    const serverUrl = str(q.server);
    const resourceUri = str(q.resource);
    const west = str(q.west);
    const south = str(q.south);
    const east = str(q.east);
    const north = str(q.north);
    const label = str(q.label);
    const viewUUID = str(q.viewUUID);

    const textErr = (msg: string, status: number): RawResult => ({
      raw_body: msg,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      status_code: status,
    });

    if (!serverUrl) return textErr('Missing server parameter', 400);
    if (!resourceUri) return textErr('Missing resource parameter', 400);

    // Normalize URL: servers ending in .php are already the endpoint
    // (e.g. XAMPP-style mcp-server.php). Only append /mcp otherwise.
    let mcpUrl = serverUrl.replace(/\/+$/, '');
    if (!mcpUrl.endsWith('/mcp') && !mcpUrl.endsWith('.php')) {
      mcpUrl += '/mcp';
    }

    // Initialize MCP session
    const initResponse = await this.sendMCPRequest(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'GPT-Chatbot-MCP-App-Proxy', version: '1.0.0' },
        capabilities: {},
      },
    });
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

    // Inject initialization script with the tool arguments
    const initData = JSON.stringify({
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
    window.MCP_SERVER_URL = ${JSON.stringify(serverUrl)};

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
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status_code: 200,
    };
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
