import { Ctx, ControllerResult } from '../Support/Http';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { PackageResolver } from '../Services/PackageResolver';
import { SearchFunctions } from '../Functions/SearchFunctions';

/**
 * Mirrors src/Controllers/ToolsController.php.
 *
 * GET  /api/v1/tools                 — lists all tools the workflow editor's agent-form tool
 *                                      picker can offer: built-in functions + the caller's MCP
 *                                      server tools. The frontend (workflow-editor.js loadTools)
 *                                      reads `data.tools` as a FLAT array of
 *                                      { name, description, type: 'builtin'|'mcp', server?, input_schema }.
 * POST /api/v1/tools/execute         — executes a single tool by name (realtime audio runner).
 * POST /api/v1/tools/classify-intent — asks a cheap LLM whether a transcript implied a tool call.
 *
 * Parity note (list): PHP filters MCP servers by the role-based package allowlist. list() predates
 * the TS PackageResolver and still loads the caller's servers with no allowlist (show all), like
 * ProviderController.list. execute() below DOES apply the allowlist (PackageResolver has since
 * landed) — wire it into list() when revisiting.
 */
export class ToolsController {
  private readonly toolsManager: ToolsManager;

  constructor() {
    this.toolsManager = new ToolsManager();
    SearchFunctions.register(this.toolsManager);
  }

  /** GET /api/v1/tools */
  async list(ctx: Ctx): Promise<ControllerResult> {
    const query: any = ctx.query ?? {};
    const typeFilter = (query.type as string) ?? 'all';
    const searchTerm = (query.search as string) ?? null;

    if (!['all', 'builtin', 'mcp'].includes(typeFilter)) {
      return {
        success: false,
        error: 'Invalid type filter. Must be: all, builtin, or mcp',
        status_code: 400,
      };
    }

    const builtinTools: any[] = [];
    const mcpTools: any[] = [];

    // Built-in tools.
    if (typeFilter === 'all' || typeFilter === 'builtin') {
      for (const tool of this.toolsManager.getToolDefinitions()) {
        builtinTools.push({
          name: tool.name,
          description: tool.description ?? '',
          type: 'builtin',
          input_schema: tool.input_schema ?? {},
        });
      }
    }

    // MCP tools (server name is carried in the description as a `[MCP:name]`
    // prefix; extract it into its own field, mirroring the PHP regex).
    if (typeFilter === 'all' || typeFilter === 'mcp') {
      try {
        const mcpLoader = new MCPToolsLoader();
        await mcpLoader.loadToolsForUser(ctx.user_id ?? null, null);

        if (mcpLoader.hasTools()) {
          for (const tool of mcpLoader.getToolDefinitions()) {
            let description = tool.description ?? '';
            let serverName: string | null = null;
            const m = description.match(/^\[MCP:([^\]]+)\]/);
            if (m) {
              serverName = m[1];
              description = description.replace(/^\[MCP:[^\]]+\]\s*/, '').trim();
            }
            mcpTools.push({
              name: tool.name,
              description,
              type: 'mcp',
              server: serverName,
              input_schema: tool.input_schema ?? {},
            });
          }
        }
      } catch (e: any) {
        console.error('[ToolsController] Failed to load MCP tools:', e?.message ?? e);
      }
    }

    let allTools = [...builtinTools, ...mcpTools];

    // Search filter (name or description, case-insensitive).
    if (searchTerm !== null && searchTerm !== '') {
      const needle = String(searchTerm).toLowerCase();
      allTools = allTools.filter(
        (t) =>
          String(t.name).toLowerCase().includes(needle) ||
          String(t.description ?? '').toLowerCase().includes(needle),
      );
    }

    return {
      success: true,
      tools: allTools,
      counts: {
        builtin: builtinTools.length,
        mcp: mcpTools.length,
        total: allTools.length,
      },
    };
  }

  /**
   * POST /api/v1/tools/execute — mirrors ToolsController.php execute().
   *
   * Execute a single tool by name. Used by the realtime audio workflow runner
   * on the frontend — when a voice agent calls a user-selected function, the
   * runner POSTs here, gets the result, and feeds it back to the LLM via the
   * realtime WebSocket.
   *
   * Body: { "tool_name": "search_web", "parameters": { ... } }
   * Returns: { "success": bool, "result": <json>, "error"?: string }
   *
   * Parity note: PHP's built-in registry (AIPortfolioAssistant) carries ~5
   * Functions/* sets; the TS ToolsManager registers SearchFunctions only —
   * same fail-open divergence list() already documents. Tools missing from the
   * TS registry fall through to the MCP branch and ultimately the 404.
   */
  async execute(ctx: Ctx): Promise<ControllerResult> {
    const body: any = ctx.body ?? {};
    const userId: number | string = ctx.user_id ?? 'demo-user';

    const toolName = body.tool_name ?? body.name ?? null;
    let parameters: any = body.parameters ?? body.args ?? {};
    // PHP: if (!is_array($parameters)) $parameters = [] — coerce scalars to empty.
    if (parameters === null || typeof parameters !== 'object') parameters = {};

    if (!toolName) {
      return {
        success: false,
        error: 'Missing tool_name',
        status_code: 400,
      };
    }

    // Try built-in tools first.
    if (this.toolsManager.hasFunction(toolName)) {
      try {
        const result = await this.toolsManager.execute(toolName, parameters, userId);
        return { success: true, result, status_code: 200 };
      } catch (e: any) {
        console.error(`[ToolsController] Built-in tool ${toolName} failed:`, e?.message ?? e);
        return { success: false, error: e?.message ?? String(e), status_code: 500 };
      }
    }

    // Fall back to MCP tools (restricted by the caller's package allowlist
    // so you can't execute a tool whose server the role isn't permitted to see).
    try {
      const mcpLoader = new MCPToolsLoader();
      // PHP passes userId=null here (allowlist-only filtering) — mirror that.
      await mcpLoader.loadToolsForUser(null, await this.resolvePackageMcpAllowlist(ctx));
      if (mcpLoader.isMCPTool(toolName)) {
        const result = await mcpLoader.executeTool(toolName, parameters);
        return { success: true, result, status_code: 200 };
      }
    } catch (e: any) {
      console.error(`[ToolsController] MCP tool ${toolName} failed:`, e?.message ?? e);
      return { success: false, error: e?.message ?? String(e), status_code: 500 };
    }

    return {
      success: false,
      error: `Unknown tool: ${toolName}`,
      status_code: 404,
    };
  }

  /**
   * POST /api/v1/tools/classify-intent — mirrors ToolsController.php classifyIntent().
   *
   * Given what an audio agent just said and the list of tools it had available,
   * ask a cheap LLM whether the agent intended to call one of those tools. Used
   * by the Gemini adapter as a multilingual safety net when Gemini narrates a
   * transfer but forgets to emit the function call.
   *
   * Body:
   *   { "transcript": "je vais vous transférer au service de facturation",
   *     "tools": [ { "name": "handoff_to", "description": "...",
   *                  "parameters": { "properties": { "target": { "enum": ["billing"] } } } }, ... ] }
   * Returns:
   *   { "success": true, "tool": "handoff_to", "args": { "target": "billing" } }
   * or
   *   { "success": true, "tool": null }
   */
  async classifyIntent(ctx: Ctx): Promise<ControllerResult> {
    const body: any = ctx.body ?? {};
    const transcript = String(body.transcript ?? '').trim();
    const tools: any = body.tools ?? [];
    const userId: number | string = ctx.user_id ?? 'demo-user';

    if (transcript === '' || !Array.isArray(tools) || tools.length === 0) {
      return { success: true, tool: null, status_code: 200 };
    }

    // Build a compact description of each tool the agent had available.
    const toolLines: string[] = [];
    for (const t of tools) {
      const name = t?.name ?? '?';
      const desc = t?.description ?? '';
      const enumVals = t?.parameters?.properties?.target?.enum ?? null;
      let line = `- ${name}: ${desc}`;
      if (Array.isArray(enumVals) && enumVals.length > 0) {
        line += ` (valid target values: ${enumVals.join(', ')})`;
      }
      toolLines.push(line);
    }

    const systemPrompt =
      'You are a function-call classifier for a voice assistant.\n' +
      "An AI agent just said something to a caller but did NOT emit a function call. " +
      "Decide whether the agent's utterance implies it intended to call one of the tools below, " +
      'and if so, pick exactly one tool and fill in its arguments. ' +
      'Respond with JSON ONLY, no other text, using this schema:\n' +
      '  { "tool": "<tool name or null>", "args": {<arguments>} }\n' +
      'Rules:\n' +
      '- If the utterance is normal conversation (answering a question, greeting, etc.) ' +
      'and does NOT imply a tool call, respond with {"tool": null, "args": {}}.\n' +
      '- If the utterance announces a transfer / end-of-call / completion, pick the matching tool.\n' +
      '- For handoff_to, pick the target whose description best matches where the agent is sending the caller. ' +
      'The utterance may be in any language (English, French, Spanish, etc.) — reason about the meaning.\n\n' +
      'Tools available to the agent:\n' +
      toolLines.join('\n');

    const userMessage = 'Agent\'s utterance:\n"""\n' + transcript + '\n"""\n\nRespond with JSON only.';

    try {
      // PHP calls $assistant->getLLMManager()->chat(...) here — see llmManagerChat().
      const response = await this.llmManagerChat(userMessage, [], {
        user_id: userId,
        system_prompt: systemPrompt,
        tools: [],
        temperature: 0,
        max_tokens: 120,
      });
      const text: string = response.text ?? response.content ?? '';
      // Extract the first {...} block — LLM sometimes wraps in ```json.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* PHP json_decode returns null on invalid JSON — fall through */
        }
        if (parsed !== null && typeof parsed === 'object') {
          const tool = parsed.tool ?? null;
          const args = parsed.args ?? {};
          // Validate tool exists in the provided list.
          let valid = false;
          for (const t of tools) {
            if ((t?.name ?? null) === tool) {
              valid = true;
              break;
            }
          }
          if (tool && valid) {
            return {
              success: true,
              tool,
              args,
              status_code: 200,
            };
          }
          return { success: true, tool: null, status_code: 200 };
        }
      }
      return { success: true, tool: null, status_code: 200 };
    } catch (e: any) {
      console.error('[ToolsController] classifyIntent failed:', e?.message ?? e);
      return {
        success: false,
        tool: null,
        error: e?.message ?? String(e),
        status_code: 500,
      };
    }
  }

  /**
   * Mirrors the entry guard of PHP Services/LLMManager::chat().
   *
   * PARITY NOTE (deliberate): PHP's classifyIntent passes NO options['provider'],
   * and PHP's LLMManager::chat() throws an InvalidArgumentException when the
   * provider is missing (silent default-provider fallback was removed upstream).
   * So the PHP endpoint, as it stands, ALWAYS returns the 500 envelope
   *   { success: false, tool: null, error: "LLMManager::chat requires ..." }
   * for a non-empty transcript+tools. We reproduce that exact behavior (same
   * message, same status) rather than inventing a default provider PHP doesn't
   * have. When the PHP call site gains a provider, route this through
   * LLMProviderResolver + ProviderFactory (see ChatController.resolveProvider).
   */
  private async llmManagerChat(
    _message: string,
    _conversationHistory: any[],
    options: Record<string, any>,
  ): Promise<{ text?: string; content?: string }> {
    if (!options.provider) {
      throw new Error(
        "LLMManager::chat requires $options['provider'] to be set explicitly. " +
          'Missing provider at this point indicates a bug in the caller.',
      );
    }
    // No TS provider registry is wired here yet — mirrors PHP's "Provider not
    // found" ProviderException for the (currently unreachable) provider-set path.
    throw new Error(`Provider '${options.provider}' not found`);
  }

  /**
   * Resolve the MCP server allowlist for the caller's role-based package —
   * mirrors ToolsController.php resolvePackageMcpAllowlist(). Returns null
   * (no restriction), an array of allowed server names, or an empty array
   * (allow nothing). Suitable to pass straight to MCPToolsLoader.loadToolsForUser().
   */
  private async resolvePackageMcpAllowlist(ctx: Ctx): Promise<string[] | null> {
    const userId = ctx.user_id;
    try {
      // PHP instantiates PackageResolver per call (see PackageController's
      // freshness note) — do the same so the role cache never goes stale.
      return await new PackageResolver().allowedMcpServers(typeof userId === 'number' ? userId : null);
    } catch (e: any) {
      console.error('[ToolsController] Package allowlist failed:', e?.message ?? e);
      return null;
    }
  }
}
