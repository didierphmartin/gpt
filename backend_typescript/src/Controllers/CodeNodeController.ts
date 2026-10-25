import { Ctx, ControllerResult } from '../Support/Http';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { CodeNodeEmit } from '../AgentTeam/CodeNodeEmit';

/**
 * POST /api/v1/workflows/code-node/tool-call -- a code node's call_tool from the editor.
 * Mirrors backend/src/AgentTeam/Controllers/CodeNodeController.php.
 *
 * Runs server.tool(args) with the logged-in user's MCP servers and returns the raw MCP result (the
 * harness needs structuredContent and isError). The declared-tools check is the harness's, so it is
 * identical when compiled; this endpoint gives the user no more than their own MCP access.
 */
export type ToolCaller = (server: string, tool: string, args: Record<string, any>) => Promise<Record<string, any>>;

export class CodeNodeController {
  constructor(private callerFor: (userId: number) => Promise<ToolCaller> = defaultCallerFor) {}

  async toolCall(ctx: Ctx): Promise<ControllerResult> {
    const userId = Math.trunc(Number(ctx.user_id ?? 0)) || 0;
    if (userId <= 0) {
      return { ok: false, error: 'Authentication required', status_code: 401 };
    }
    const body: Record<string, any> = ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const server = body.server ?? null;
    const tool = body.tool ?? null;
    const args = body.args ?? {};
    if (
      typeof server !== 'string' || !/^[a-z0-9_]{1,64}$/.test(server) ||
      typeof tool !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool) ||
      args === null || typeof args !== 'object'
    ) {
      return { ok: false, error: 'body must be {server: slug, tool: name, args: object}', status_code: 400 };
    }
    return (await this.callerFor(userId))(server, tool, args);
  }
}

/** The user's MCP tools, called raw by "<server slug>.<tool>" (LoaderMcpExecutor::callRaw). */
async function defaultCallerFor(userId: number): Promise<ToolCaller> {
  const loader = new MCPToolsLoader();
  await loader.loadToolsForUser(String(userId));
  return async (server, tool, args) => {
    let entry: { original_name: string } | null = null;
    for (const meta of loader.getTools().values()) {
      if (CodeNodeEmit.slug(meta.server_name) === server && meta.original_name === tool) {
        entry = meta;
        break;
      }
    }
    if (entry === null) return { ok: false, error: `MCP tool '${server}.${tool}' not found` };
    const r = await loader.executeToolRaw('mcp_' + entry.original_name, args);
    if (r.error) return { ok: false, error: String(r.message ?? 'MCP tool execution failed') };
    return { ok: true, result: r.raw };
  };
}
