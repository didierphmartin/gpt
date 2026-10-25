import { MCPToolsLoader } from '../../Services/MCPToolsLoader';
import { McpExecutor } from '../PlaybookActionSpace';

/**
 * Adapts MCPToolsLoader (DB-backed MCP tool cache + JSON-RPC proxy) to the playbook interpreter's
 * McpExecutor: tools are addressed as "<server_slug>.<tool_name>" (e.g. "okta.search_users").
 * The caller loads the loader's tools (loadToolsForUser) first.
 * Mirrors backend/src/Playbook/Adapters/LoaderMcpExecutor.php.
 */
export class LoaderMcpExecutor implements McpExecutor {
  constructor(private readonly loader: MCPToolsLoader) {}

  async call(server: string, tool: string, args: Record<string, any>): Promise<Record<string, any>> {
    const entry = this.findEntry(server, tool);
    if (entry === null) return { ok: false, error: `MCP tool '${server}.${tool}' not found` };
    const result = await this.loader.executeTool('mcp_' + entry.original_name, args);
    if (result !== null && typeof result === 'object' && result.error === true) {
      return { ok: false, error: result.message ?? 'MCP tool execution failed' };
    }
    return { ok: true, result };
  }

  /** call() with the raw MCP result (structuredContent and isError kept), for code nodes. */
  async callRaw(server: string, tool: string, args: Record<string, any>): Promise<Record<string, any>> {
    const entry = this.findEntry(server, tool);
    if (entry === null) return { ok: false, error: `MCP tool '${server}.${tool}' not found` };
    const r = await this.loader.executeToolRaw('mcp_' + entry.original_name, args);
    if (r.error) return { ok: false, error: String(r.message ?? 'MCP tool execution failed') };
    return { ok: true, result: r.raw };
  }

  availableTools(): Record<string, { description: string; input_schema: any }> {
    const tools: Record<string, { description: string; input_schema: any }> = {};
    for (const entry of this.loader.getTools().values()) {
      tools[LoaderMcpExecutor.slug(entry.server_name) + '.' + entry.original_name] = {
        description: entry.description ?? '',
        input_schema: LoaderMcpExecutor.schema(entry.input_schema),
      };
    }
    return tools;
  }

  private findEntry(server: string, tool: string): { original_name: string } | null {
    for (const entry of this.loader.getTools().values()) {
      if (LoaderMcpExecutor.slug(entry.server_name) === server && entry.original_name === tool) return entry;
    }
    return null;
  }

  static slug(serverName: string): string {
    return String(serverName ?? '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  }

  /** The loader holds the decoded input schema; PHP decodes the JSON column here (empty/invalid -> an empty object schema). */
  private static schema(s: any): any {
    if (typeof s === 'string') {
      if (s === '') return { type: 'object', properties: [] };
      try {
        const d = JSON.parse(s);
        return d !== null && typeof d === 'object' ? d : { type: 'object', properties: [] };
      } catch {
        return { type: 'object', properties: [] };
      }
    }
    return s !== null && typeof s === 'object' ? s : { type: 'object', properties: [] };
  }
}
