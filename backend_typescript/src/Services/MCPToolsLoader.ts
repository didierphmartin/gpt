import { sql } from 'kysely';
import { db } from '../db/pools';
import { ToolDefinition } from '../Contracts/FunctionExecutor';

interface ToolMeta {
  original_name: string;
  server_id: number;
  server_url: string;
  server_name: string;
  server_headers: Record<string, string>;
  description: string | null;
  input_schema: any | null;
  has_ui: boolean;
  ui_resource_uri: string | null;
}

/**
 * Loads per-user MCP tool definitions from the DB (mcp_servers ⋈ mcp_server_tools, with the
 * user_mcp_overrides cascade) and executes them over JSON-RPC. Mirrors src/Services/MCPToolsLoader.php.
 * Fails soft (never throws): on DB/HTTP error it logs and returns an empty set / `{error,message}`.
 */
export class MCPToolsLoader {
  private tools = new Map<string, ToolMeta>(); // prefixed name ("mcp_"+tool_name) → meta

  hasTools(): boolean {
    return this.tools.size > 0;
  }

  getTools(): Map<string, ToolMeta> {
    return this.tools;
  }

  isMCPTool(name: string): boolean {
    return this.tools.has(name) || this.tools.has('mcp_' + name);
  }

  private parseJsonColumn(v: any): any {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  /** Decode mcp_servers.headers (object) → ["Name: value", ...] with header-injection stripping. */
  private parseServerHeaders(headers: any): Record<string, string> {
    const out: Record<string, string> = {};
    const obj = this.parseJsonColumn(headers);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [rawName, rawValue] of Object.entries(obj)) {
      if (typeof rawName !== 'string' || rawName === '') continue;
      if (rawValue == null || typeof rawValue === 'object') continue;
      const name = rawName.replace(/[\r\n:]/g, '');
      const value = String(rawValue).replace(/[\r\n]/g, '');
      if (name) out[name] = value;
    }
    return out;
  }

  async loadToolsForUser(userId?: string | number | null, allowedServerNames?: string[] | null): Promise<void> {
    this.tools.clear();
    try {
      const hasUser = userId !== undefined && userId !== null && String(userId) !== '';

      // Master switch: if the user disabled all MCP, offer zero tools. Mirrors
      // MCPToolsLoader.php's mcp_enabled=0 short-circuit (missing row/table => enabled).
      if (hasUser && /^\d+$/.test(String(userId))) {
        try {
          const row = (
            await sql<any>`SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ${Number(userId)}`.execute(db)
          ).rows[0];
          if (row !== undefined && Number(row.mcp_enabled) === 0) {
            console.log(`[MCP] Master switch OFF for user ${userId} — 0 tools`);
            return; // empty
          }
        } catch {
          // table absent / transient => treat as enabled, continue
        }
      }

      let q = db
        .selectFrom('mcp_server_tools as t')
        .innerJoin('mcp_servers as s', 's.id', 't.server_id')
        .select([
          't.tool_name as tool_name',
          't.tool_description as tool_description',
          't.input_schema as input_schema',
          't.has_ui as has_ui',
          't.ui_resource_uri as ui_resource_uri',
          's.id as server_id',
          's.url as server_url',
          's.name as server_name',
          's.user_id as server_user_id',
          's.headers as server_headers',
        ])
        .where('s.enabled', '=', 1);
      q = hasUser
        ? q.where((eb) => eb.or([eb('s.user_id', 'is', null), eb('s.user_id', '=', String(userId))]))
        : q.where('s.user_id', 'is', null);
      const rows = await q.orderBy('s.name').orderBy('t.tool_name').execute();

      // Overrides (numeric users only).
      const overrides = new Map<number, boolean>();
      if (hasUser && /^\d+$/.test(String(userId))) {
        const ov = await db.selectFrom('user_mcp_overrides').select(['server_id', 'allowed']).where('user_id', '=', Number(userId)).execute();
        for (const o of ov) overrides.set(Number(o.server_id), Boolean(o.allowed));
      }

      for (const r of rows as any[]) {
        const serverId = Number(r.server_id);
        const isPrivate = r.server_user_id !== null && r.server_user_id !== undefined;

        // Cascade: override > private-always > global allowlist.
        let include: boolean;
        if (overrides.has(serverId)) include = overrides.get(serverId)!;
        else if (isPrivate) include = true;
        else include = allowedServerNames == null || allowedServerNames.includes(r.server_name);
        if (!include) continue;

        const prefixed = 'mcp_' + r.tool_name;
        this.tools.set(prefixed, {
          original_name: r.tool_name,
          server_id: serverId,
          server_url: r.server_url,
          server_name: r.server_name,
          server_headers: this.parseServerHeaders(r.server_headers),
          description: r.tool_description ?? null,
          input_schema: this.parseJsonColumn(r.input_schema),
          has_ui: Boolean(r.has_ui),
          ui_resource_uri: r.ui_resource_uri ?? null,
        });
      }
    } catch (e: any) {
      console.error('[MCPToolsLoader] load failed:', e?.message ?? e);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [name, t] of this.tools) {
      const schema = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} };
      defs.push({ name, description: `[MCP:${t.server_name}] ${t.description || t.original_name}`, input_schema: schema });
    }
    return defs;
  }

  // ---- remote execution (JSON-RPC) -----------------------------------------

  private parseResponse(text: string): any | null {
    try {
      const j = JSON.parse(text);
      if (j != null) return j;
    } catch {
      /* try SSE */
    }
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (l.startsWith('data:')) {
        try {
          const j = JSON.parse(l.slice(5).trim());
          if (j != null) return j;
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  }

  /** MCP result → AI-facing `{ result, _meta }` (text joined from content[]). */
  private formatToolResult(result: any): any {
    if (result && Array.isArray(result.content)) {
      const parts: string[] = [];
      for (const item of result.content) {
        if (item?.type === 'text' && item.text) parts.push(item.text);
        else if (item?.text) parts.push(item.text);
      }
      if (parts.length) return { result: parts.join('\n'), _meta: result._meta ?? null };
    }
    if (result && result.result !== undefined) return result;
    return { result: JSON.stringify(result) };
  }

  private async callMCPServer(serverUrl: string, toolName: string, args: any, extraHeaders: Record<string, string>): Promise<{ formatted: any; raw: any }> {
    const url = serverUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream, */*', ...extraHeaders };
    const body = JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Date.now() / 1000), method: 'tools/call', params: { name: toolName, arguments: args && Object.keys(args).length ? args : {} } });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (e: any) {
      clearTimeout(timer);
      return { formatted: { error: true, message: `MCP connection failed: ${e?.message ?? e}` }, raw: null };
    }
    clearTimeout(timer);

    if (res.status >= 400) return { formatted: { error: true, message: `MCP server returned HTTP ${res.status}` }, raw: null };
    const text = await res.text().catch(() => '');
    const parsed = this.parseResponse(text);
    if (parsed == null) return { formatted: { error: true, message: 'Failed to parse MCP response' }, raw: null };
    if (parsed.error) return { formatted: { error: true, message: parsed.error.message ?? 'MCP tool execution failed' }, raw: null };

    const result = parsed.result ?? parsed;
    return { formatted: this.formatToolResult(result), raw: result };
  }

  async executeTool(toolName: string, args: any): Promise<any> {
    const tool = this.tools.get(toolName) ?? this.tools.get('mcp_' + toolName);
    if (!tool) return { error: true, message: `MCP tool '${toolName}' not found` };

    const { formatted, raw } = await this.callMCPServer(tool.server_url, tool.original_name, args ?? {}, tool.server_headers);

    const hasViewUUID = formatted && formatted._meta && formatted._meta.viewUUID != null;
    if (tool.has_ui || hasViewUUID) {
      formatted._mcp_ui = {
        has_ui: true,
        tool_name: tool.original_name,
        server_url: tool.server_url,
        server_name: tool.server_name,
        resource_uri: tool.ui_resource_uri ?? null,
        view_uuid: formatted?._meta?.viewUUID ?? null,
        arguments: args,
        tool_result: raw,
        has_error: formatted?.error === true,
      };
    }
    return formatted;
  }
}
