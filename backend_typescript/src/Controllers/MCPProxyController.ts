import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/** Per-call error slot so concurrent requests don't clobber each other's message. */
interface ErrRef {
  lastError: string | null;
}

/**
 * MCP Proxy Controller — TypeScript port of `Controllers/MCPProxyController.php`.
 *
 * Forwards JSON-RPC 2.0 requests from the frontend to configured MCP servers.
 * This proxy avoids CORS issues and keeps MCP server URLs secure.
 *
 * Runtime DDL (ensureTablesExist) is not replicated — the schema already exists.
 */
export class MCPProxyController {
  /** POST /api/v1/mcp/proxy */
  async forward(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const action = input.action ?? null;
    // server_id arrives as a string when round-tripped through JSON; normalize to number|null.
    const rawServerId = input.server_id ?? null;
    const serverId = rawServerId === null || rawServerId === '' ? null : Number(rawServerId);
    const serverUrl: string | null = input.server_url ?? null;
    const userId = String(input.user_id ?? ctx.user_id ?? 'demo-user');

    switch (action) {
      case 'proxy':
        return this.proxyRequest(serverUrl, serverId, input.jsonrpc ?? null, userId);

      case 'test_connection':
        return this.testConnection(serverUrl, this.normalizeHeaders(input.headers ?? null));

      case 'discover_tools':
        if (typeof serverUrl !== 'string' || serverUrl === '') {
          return {
            success: false,
            error: { code: -32602, message: 'Server URL required' },
            status_code: 400,
          };
        }
        return this.discoverTools(serverUrl, serverId, userId);

      default:
        return {
          success: false,
          error: { code: -32600, message: 'Unknown action: ' + action },
          status_code: 400,
        };
    }
  }

  /** Proxy a JSON-RPC request to an MCP server. */
  private async proxyRequest(
    serverUrl: string | null,
    serverId: number | null,
    jsonrpc: any,
    userId: string,
  ): Promise<ControllerResult> {
    // Get server URL from ID if not provided directly
    if (!serverUrl && serverId) {
      serverUrl = await this.getServerUrl(serverId, userId);
    }

    // Look up custom headers by server id (global or caller's user scope)
    const extraHeaders = serverId ? await this.getServerHeaders(serverId, userId) : {};

    if (!serverUrl) {
      return {
        success: false,
        error: { code: -32602, message: 'Server URL required' },
        status_code: 400,
      };
    }

    if (!jsonrpc || typeof jsonrpc !== 'object') {
      return {
        success: false,
        error: { code: -32602, message: 'JSON-RPC request required' },
        status_code: 400,
      };
    }

    // Ensure proper JSON-RPC structure
    if (jsonrpc.jsonrpc === undefined) {
      jsonrpc.jsonrpc = '2.0';
    }
    if (jsonrpc.id === undefined) {
      jsonrpc.id = Math.floor(Date.now() / 1000);
    }

    // Ensure params.arguments is an object, not an empty array (for tools/call)
    const method: string = jsonrpc.method ?? '';
    if (method === 'tools/call' && jsonrpc.params && typeof jsonrpc.params === 'object') {
      const args = jsonrpc.params.arguments;
      if (args === undefined || (Array.isArray(args) && args.length === 0)) {
        jsonrpc.params.arguments = {};
      }
    }

    const err: ErrRef = { lastError: null };

    // For resources/read and tools/call requests, initialize the MCP session first
    if (method.startsWith('resources/') || method.startsWith('tools/')) {
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'GPT-Chatbot-MCP-Client', version: '1.0.0' },
          capabilities: {},
        },
      };

      const initResponse = await this.sendToMCPServer(serverUrl, initRequest, true, extraHeaders, err);
      if (initResponse === null || initResponse.error) {
        return {
          success: false,
          error: { code: -32603, message: 'Failed to initialize MCP session' },
          status_code: 500,
        };
      }

      // Send initialized notification
      await this.sendToMCPServer(
        serverUrl,
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        false,
        extraHeaders,
        err,
      );
    }

    // Forward request to MCP server
    const response = await this.sendToMCPServer(serverUrl, jsonrpc, true, extraHeaders, err);

    if (response === null) {
      return {
        success: false,
        error: { code: -32603, message: 'Failed to connect to MCP server' },
        status_code: 500,
      };
    }

    return { success: true, response, status_code: 200 };
  }

  /** Test connection to an MCP server. */
  private async testConnection(
    serverUrl: string | null,
    extraHeaders: Record<string, string> = {},
  ): Promise<ControllerResult> {
    if (!serverUrl) {
      return {
        success: false,
        error: { code: -32602, message: 'Server URL required' },
        status_code: 400,
      };
    }

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'GPT-Chatbot-MCP-Client', version: '1.0.0' },
        capabilities: {},
      },
    };

    const err: ErrRef = { lastError: null };
    const response = await this.sendToMCPServer(serverUrl, initRequest, true, extraHeaders, err);

    if (response === null) {
      const trimmed = serverUrl.replace(/\/+$/, '');
      const urlTried =
        trimmed.endsWith('/mcp') || trimmed.endsWith('.php') ? trimmed : trimmed + '/mcp';
      return {
        success: false,
        error: err.lastError ?? 'Failed to connect to MCP server',
        url_tried: urlTried,
        status_code: 500,
      };
    }

    if (response.error) {
      return {
        success: false,
        error: response.error.message ?? 'Unknown error',
        details: response.error,
        status_code: 500,
      };
    }

    return {
      success: true,
      serverInfo: response.result?.serverInfo ?? null,
      capabilities: response.result?.capabilities ?? null,
      status_code: 200,
    };
  }

  /** Discover tools from an MCP server. */
  private async discoverTools(
    serverUrl: string,
    serverId: number | null,
    userId: string,
  ): Promise<ControllerResult> {
    const extraHeaders = serverId ? await this.getServerHeaders(serverId, userId) : {};

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'GPT-Chatbot-MCP-Client', version: '1.0.0' },
        capabilities: {},
      },
    };

    const err: ErrRef = { lastError: null };
    const initResponse = await this.sendToMCPServer(serverUrl, initRequest, true, extraHeaders, err);

    if (initResponse === null) {
      return {
        success: false,
        error: { code: -32603, message: err.lastError ?? 'Failed to initialize MCP server' },
        status_code: 500,
      };
    }

    if (initResponse.error) {
      return {
        success: false,
        error: { code: -32603, message: initResponse.error.message ?? 'MCP server returned error' },
        status_code: 500,
      };
    }

    // Send initialized notification
    await this.sendToMCPServer(
      serverUrl,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      false,
      extraHeaders,
      err,
    );

    // List tools
    const toolsResponse = await this.sendToMCPServer(
      serverUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      true,
      extraHeaders,
      err,
    );

    if (toolsResponse === null || toolsResponse.error) {
      return {
        success: false,
        error: { code: -32603, message: 'Failed to list tools from MCP server' },
        status_code: 500,
      };
    }

    const tools: any[] = toolsResponse.result?.tools ?? [];

    // Cache tools in database if we have a server ID
    if (serverId) {
      await this.cacheTools(serverId, tools);
    }

    return {
      success: true,
      serverInfo: initResponse.result?.serverInfo ?? null,
      tools,
      status_code: 200,
    };
  }

  /**
   * POST a JSON-RPC request to an MCP server. Returns the parsed JSON-RPC object
   * (from a JSON or SSE `data:` line), `{ success: true }` for notifications
   * (expectResponse=false), or null on HTTP/parse failure — recording the reason
   * in err.lastError. Mirrors the PHP curl helper.
   */
  private async sendToMCPServer(
    serverUrl: string,
    request: unknown,
    expectResponse = true,
    extraHeaders: Record<string, string> = {},
    err: ErrRef = { lastError: null },
  ): Promise<any | null> {
    err.lastError = null;

    // Normalize URL: some MCP servers are exposed as XAMPP-style .php scripts
    // (e.g. mcp-server.php) that ARE the endpoint already. Only append /mcp
    // when the URL doesn't already end in /mcp or .php.
    let mcpUrl = serverUrl.replace(/\/+$/, '');
    if (!mcpUrl.endsWith('/mcp') && !mcpUrl.endsWith('.php')) {
      mcpUrl += '/mcp';
    }

    let res: globalThis.Response;
    let text: string;
    try {
      res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream, */*',
          ...extraHeaders,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(120_000),
      });
      text = await res.text();
    } catch (e: any) {
      err.lastError = `Connection failed: ${e?.message ?? e} (code: ${e?.cause?.code ?? 0})`;
      return null;
    }

    if (res.status >= 400) {
      let errorDetails = '';
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) errorDetails = ': ' + parsed.error.message;
      } catch {
        // non-JSON error body — no details to extract
      }
      err.lastError = `Server returned HTTP ${res.status}${errorDetails}`;
      return null;
    }

    if (!expectResponse) return { success: true };

    // Try to parse as plain JSON
    try {
      const decoded = JSON.parse(text);
      if (decoded !== null) return decoded;
    } catch {
      // fall through to SSE parsing
    }

    // Try to parse as SSE format (last data: <json> line wins, like the PHP parser)
    let jsonData: any = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) {
          try {
            const parsed = JSON.parse(data);
            if (parsed !== null) jsonData = parsed;
          } catch {
            // keep scanning subsequent data: lines
          }
        }
      }
    }
    if (jsonData !== null) return jsonData;

    err.lastError = 'Server returned invalid response format';
    return null;
  }

  /** Get server URL from database (caller-scoped, enabled servers only). */
  private async getServerUrl(serverId: number, userId: string): Promise<string | null> {
    const row = await db
      .selectFrom('mcp_servers')
      .select('url')
      .where('id', '=', serverId)
      .where('user_id', '=', userId)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    return row?.url ?? null;
  }

  /**
   * Get custom headers for an MCP server (global or caller-scoped), sanitized
   * the same way as the PHP version (no CR/LF anywhere, no ':' in names).
   */
  private async getServerHeaders(serverId: number, userId: string): Promise<Record<string, string>> {
    try {
      const row = await db
        .selectFrom('mcp_servers')
        .select('headers')
        .where('id', '=', serverId)
        .where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', userId)]))
        .limit(1)
        .executeTakeFirst();
      if (!row || !row.headers) return {};
      const decoded = typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers;
      return this.normalizeHeaders(decoded);
    } catch (e: any) {
      console.error('[MCPProxy] getServerHeaders failed:', e?.message ?? e);
      return {};
    }
  }

  /**
   * Convert a headers map (e.g. {"Authorization": "Bearer x"}) into a sanitized
   * Record for fetch. Mirrors the PHP normalizeHeaders() sanitization. Returns {}
   * for empty/invalid input.
   */
  private normalizeHeaders(headers: any): Record<string, string> {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    const out: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(headers)) {
      if (typeof rawName !== 'string' || rawName === '') continue;
      if (
        typeof rawValue !== 'string' &&
        typeof rawValue !== 'number' &&
        typeof rawValue !== 'boolean'
      )
        continue;
      const name = rawName.replace(/[\r\n:]/g, '');
      const value = String(rawValue).replace(/[\r\n]/g, '');
      if (name === '') continue;
      out[name] = value;
    }
    return out;
  }

  /** Cache discovered tools in database (clear-then-insert, like the PHP version). */
  private async cacheTools(serverId: number, tools: any[]): Promise<void> {
    await db.deleteFrom('mcp_server_tools').where('server_id', '=', serverId).execute();

    for (const tool of tools) {
      const uiResourceUri = tool?._meta?.ui?.resourceUri ?? null;
      const hasUi = uiResourceUri !== null && uiResourceUri !== undefined;

      const inputSchema = this.sanitizeSchema(
        tool.inputSchema ?? { type: 'object', properties: {} },
      );

      await db
        .insertInto('mcp_server_tools')
        .values({
          server_id: serverId,
          tool_name: tool.name,
          tool_description: tool.description ?? '',
          input_schema: JSON.stringify(inputSchema),
          has_ui: hasUi ? 1 : 0,
          ui_resource_uri: uiResourceUri,
        })
        .execute();
    }
  }

  /** Strip $schema/default/$id/definitions/$defs recursively, like the PHP version. */
  private sanitizeSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
      return schema.map((v) => (v !== null && typeof v === 'object' ? this.sanitizeSchema(v) : v));
    }

    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (['$schema', 'default', '$id', 'definitions', '$defs'].includes(key)) continue;
      out[key] = value !== null && typeof value === 'object' ? this.sanitizeSchema(value) : value;
    }
    return out;
  }
}
