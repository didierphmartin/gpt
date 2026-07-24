import { createHash } from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { ToolsManager } from '../Services/ToolsManager';
import { ToolDefinition } from '../Contracts/FunctionExecutor';
import { SearchFunctions } from '../Functions/SearchFunctions';

/**
 * HumeToolController — faithful TS mirror of src/Controllers/HumeToolController.php.
 *
 * Handles Hume EVI tool operations (PHP src/routes.php lines 250-257, public):
 *   POST /api/v1/hume/tools/execute         -> execute
 *   GET  /api/v1/hume/tools/list            -> list
 *   POST /api/v1/hume/tools/sync            -> sync
 *   GET  /api/v1/hume/tools/status          -> getStatus
 *   GET  /api/v1/hume/tools/test-connection -> testConnection
 *   GET  /api/v1/hume/config                -> getConfig
 *
 * Faithful-divergence notes:
 *  - Config: config/ai_config.php 'hume_evi' has no counterpart in src/config/env.ts (editing
 *    env.ts is out of scope for this port), so the same values are read here from process.env:
 *    HUME_API_KEY, plus optional HUME_BASE_URL / HUME_CONFIG_ID overrides that default to the
 *    values PHP hardcodes. cleanup_orphaned_tools stays hardcoded false like ai_config.php.
 *  - Tool registry: PHP registers WatchlistFunctions + PortfolioFunctions (PDO-backed) and
 *    SearchFunctions + AnalysisFunctions (config-backed). Only Functions/SearchFunctions exists on
 *    the TS side so far (the same registry gap as ChatController/ToolsController), so fewer tools
 *    are listed/synced/executable until the remaining Functions/* classes are ported.
 *  - HumeToolSyncService (PHP src/Services/HumeToolSyncService.php) is used only by this
 *    controller, so it is ported inline below as a private class instead of a new Services file.
 *    Its methods unused by the controller (linkToolsToConfig, getStoredMappings) are omitted.
 *  - Guzzle → Node fetch with AbortSignal.timeout(30_000). Non-2xx responses throw like Guzzle's
 *    default http_errors=true, but the exact exception message text differs from Guzzle's.
 *  - No runtime DDL (parity rule): PHP has none here either. storeToolMapping() writes to the
 *    hume_tool_mapping table and swallows the error if it doesn't exist, exactly like PHP.
 */

interface HumeEviConfig {
  api_key: string;
  base_url: string;
  config_id: string;
  cleanup_orphaned_tools: boolean;
}

/** Mirrors config/ai_config.php 'hume_evi' (lines 106-112). */
function humeEviConfig(): HumeEviConfig {
  return {
    api_key: process.env.HUME_API_KEY ?? '',
    base_url: process.env.HUME_BASE_URL ?? 'https://api.hume.ai/v0/evi',
    // PHP hardcodes this EVI configuration id in ai_config.php (optional, for auto-linking tools).
    config_id: process.env.HUME_CONFIG_ID ?? '0d9df320-ec1d-4e08-8c2e-300e4e8de3b1',
    cleanup_orphaned_tools: false,
  };
}

/** PHP boolean falsiness for `!$var` guards ('0' and [] are falsy in PHP, unlike JS). */
function phpFalsy(v: any): boolean {
  return !v || v === '0' || (Array.isArray(v) && v.length === 0);
}

/** PHP json_encode default flags escape '/' as '\/' and non-ASCII as \uXXXX. */
function phpJsonEscape(s: string): string {
  return s
    .replace(/\//g, '\\/')
    .replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Mirrors PHP json_encode($v) (compact, escaped slashes/unicode). */
function phpJsonEncode(v: any): string {
  return phpJsonEscape(JSON.stringify(v));
}

/** Mirrors PHP json_encode($v, JSON_PRETTY_PRINT) — 4-space indent, slashes/unicode still escaped. */
function phpJsonPrettyPrint(v: any): string {
  return phpJsonEscape(JSON.stringify(v, null, 4));
}

/** PHP date('Y-m-d H:i:s') for a Date (server-local time). Local per-controller helper matching the
 * convention used by AdminController/SchedulerController (no shared exported one exists). */
function phpDateYmdHis(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Synchronizes backend functions with the Hume EVI Tools API — inline port of
 * src/Services/HumeToolSyncService.php (used only by HumeToolController; see header note).
 */
class HumeToolSyncService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly config: HumeEviConfig;

  constructor(config: HumeEviConfig) {
    this.config = config;
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url;

    if (!this.apiKey) {
      throw new Error('Hume API key not configured');
    }
  }

  /** Guzzle-equivalent HTTP call: 30s timeout, Hume headers, throws on non-2xx. */
  private async request(method: string, url: string, body?: any): Promise<any> {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Hume-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? phpJsonEncode(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Guzzle http_errors=true throws here too (message wording differs from Guzzle's).
      throw new Error(`HTTP ${res.status} ${method} ${url}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Sync all backend tools to Hume EVI. Returns sync results with statistics. */
  async syncAllTools(toolsManager: ToolsManager): Promise<Record<string, any>> {
    const localTools = toolsManager.getToolDefinitions();
    const humeTools = await this.listHumeTools();

    const results: Record<string, any> = {
      total_local: localTools.length,
      total_hume: humeTools.length,
      created: [] as string[],
      updated: [] as string[],
      unchanged: [] as string[],
      errors: [] as Array<{ tool: string; error: string }>,
      tool_mapping: {} as Record<string, string>,
    };

    // Create mapping of Hume tools by name for quick lookup.
    const humeToolsMap: Record<string, any> = {};
    for (const tool of humeTools) humeToolsMap[tool.name] = tool;

    // Process each local tool.
    for (const localTool of localTools) {
      try {
        const toolName = localTool.name;

        if (humeToolsMap[toolName] !== undefined) {
          // Tool exists - check if update needed.
          const humeTool = humeToolsMap[toolName];

          if (this.toolNeedsUpdate(localTool, humeTool)) {
            const updated = await this.updateTool(humeTool.id, localTool);
            results.updated.push(toolName);
            results.tool_mapping[toolName] = updated.tool_id ?? updated.id;
          } else {
            results.unchanged.push(toolName);
            results.tool_mapping[toolName] = humeTool.id;
          }
        } else {
          // Tool doesn't exist - create it.
          const created = await this.createTool(localTool);
          results.created.push(toolName);
          results.tool_mapping[toolName] = created.tool_id ?? created.id;
        }

        // Store mapping in database if available.
        if (results.tool_mapping[toolName] !== undefined) {
          await this.storeToolMapping(toolName, results.tool_mapping[toolName], localTool);
        }
      } catch (e: any) {
        results.errors.push({
          tool: localTool.name ?? 'unknown',
          error: e?.message ?? String(e),
        });
      }
    }

    // Optionally cleanup orphaned tools (hume_evi.cleanup_orphaned_tools is false in ai_config.php).
    if (this.config.cleanup_orphaned_tools) {
      results.deleted = await this.cleanupOrphanedTools(localTools, humeTools);
    }

    return results;
  }

  /** Get synchronization status (compare local vs Hume). */
  async getSyncStatus(toolsManager: ToolsManager): Promise<Record<string, any>> {
    const localTools = toolsManager.getToolDefinitions();
    const humeTools = await this.listHumeTools();

    const localNames = localTools.map((t) => t.name);
    const humeNames = humeTools.map((t: any) => t.name);

    const missingInHume = localNames.filter((n) => !humeNames.includes(n));
    const missingInLocal = humeNames.filter((n: string) => !localNames.includes(n));

    return {
      local_count: localTools.length,
      hume_count: humeTools.length,
      missing_in_hume: missingInHume,
      missing_in_local: missingInLocal,
      needs_sync: missingInHume.length > 0,
      local_tools: localNames,
      hume_tools: humeNames,
    };
  }

  /** List all tools from the Hume API. */
  async listHumeTools(): Promise<any[]> {
    try {
      // PHP sends 'restrict_to_most_recent' => true, which http_build_query encodes as "1".
      const data = await this.request(
        'GET',
        `${this.baseUrl}/tools?page_size=100&restrict_to_most_recent=1`,
      );
      return data?.tools_page ?? [];
    } catch (e: any) {
      throw new Error('Failed to list Hume tools: ' + (e?.message ?? String(e)));
    }
  }

  /** Create a new tool in Hume. */
  async createTool(toolDefinition: ToolDefinition): Promise<any> {
    try {
      // Remove 'default' fields from schema (Hume doesn't support them).
      const cleanedSchema = this.removeDefaultFields(toolDefinition.input_schema);

      const payload = {
        name: toolDefinition.name,
        parameters: phpJsonEncode(cleanedSchema),
        description: toolDefinition.description ?? '',
        version_description: 'Auto-synced from backend',
      };

      return await this.request('POST', `${this.baseUrl}/tools`, payload);
    } catch (e: any) {
      throw new Error(
        `Failed to create tool '${toolDefinition.name}': ` + (e?.message ?? String(e)),
      );
    }
  }

  /** Remove 'default' fields from schema at any depth (Hume doesn't support them). */
  private removeDefaultFields(schema: any): any {
    if (Array.isArray(schema)) {
      return schema.map((v) => (v !== null && typeof v === 'object' ? this.removeDefaultFields(v) : v));
    }
    if (schema !== null && typeof schema === 'object') {
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'default') continue;
        out[key] = value !== null && typeof value === 'object' ? this.removeDefaultFields(value) : value;
      }
      return out;
    }
    return schema;
  }

  /**
   * Update an existing tool in Hume.
   * Note: Hume creates new versions, doesn't update in place.
   */
  async updateTool(_toolId: string, toolDefinition: ToolDefinition): Promise<any> {
    // Hume uses versioning - creating new version updates the tool.
    return this.createTool(toolDefinition);
  }

  /** Delete a tool from Hume. */
  async deleteTool(toolId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `${this.baseUrl}/tools/${toolId}`);
      return true;
    } catch (e: any) {
      throw new Error('Failed to delete tool: ' + (e?.message ?? String(e)));
    }
  }

  /** Check if tool needs update. */
  private toolNeedsUpdate(localTool: ToolDefinition, humeTool: any): boolean {
    // Clean local params first (remove default fields before comparing).
    const cleanedLocalSchema = this.removeDefaultFields(localTool.input_schema);
    const localParams = phpJsonEncode(cleanedLocalSchema);
    const humeParams = humeTool.parameters ?? '{}';

    if (localParams !== humeParams) {
      return true;
    }

    // Compare description.
    const localDesc = localTool.description ?? '';
    const humeDesc = humeTool.description ?? '';

    return localDesc !== humeDesc;
  }

  /** Cleanup tools that exist in Hume but not in backend. */
  private async cleanupOrphanedTools(localTools: ToolDefinition[], humeTools: any[]): Promise<string[]> {
    const localNames = localTools.map((t) => t.name);
    const deleted: string[] = [];

    for (const humeTool of humeTools) {
      if (!localNames.includes(humeTool.name)) {
        try {
          await this.deleteTool(humeTool.tool_id);
          deleted.push(humeTool.name);
        } catch (e: any) {
          // Log error but continue (mirrors PHP error_log).
          console.error(`Failed to delete orphaned tool ${humeTool.name}: ` + (e?.message ?? e));
        }
      }
    }

    return deleted;
  }

  /** Store tool mapping in database. */
  private async storeToolMapping(
    toolName: string,
    humeToolId: string,
    definition: ToolDefinition,
  ): Promise<void> {
    try {
      const definitionHash = createHash('md5').update(phpJsonEncode(definition)).digest('hex');

      await sql`
        INSERT INTO hume_tool_mapping (tool_name, hume_tool_id, definition_hash, last_synced)
        VALUES (${toolName}, ${humeToolId}, ${definitionHash}, NOW())
        ON DUPLICATE KEY UPDATE
          hume_tool_id = VALUES(hume_tool_id),
          definition_hash = VALUES(definition_hash),
          last_synced = NOW()
      `.execute(db);
    } catch (e: any) {
      // Table might not exist yet, that's okay (mirrors PHP).
      console.error('Could not store tool mapping: ' + (e?.message ?? e));
    }
  }

  /** Test connection to the Hume API. */
  async testConnection(): Promise<{ success: boolean; message: string; tools_count?: number }> {
    try {
      const tools = await this.listHumeTools();

      return {
        success: true,
        message: 'Connected to Hume API successfully',
        tools_count: tools.length,
      };
    } catch (e: any) {
      return {
        success: false,
        message: 'Failed to connect: ' + (e?.message ?? String(e)),
      };
    }
  }
}

export class HumeToolController {
  private readonly config: HumeEviConfig;
  private readonly toolsManager: ToolsManager;

  constructor() {
    this.config = humeEviConfig();
    this.toolsManager = this.initializeToolsManager();
  }

  /** POST /api/v1/hume/tools/execute — execute a tool function. */
  async execute(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body;

    const toolCallId = input.toolCallId ?? null;
    const toolName = input.toolName ?? null;
    const parameters = input.parameters ?? {};

    if (phpFalsy(toolCallId) || phpFalsy(toolName)) {
      return {
        success: false,
        error: 'Missing toolCallId or toolName',
        status_code: 400,
      };
    }

    // Get user ID from session or input.
    const userId = input.userId ?? ctx.user_id ?? 'demo-user';

    // Check if function exists.
    if (!this.toolsManager.hasFunction(toolName)) {
      return {
        success: false,
        error: `Function not found: ${toolName}`,
        toolCallId,
        availableFunctions: this.toolsManager.getRegisteredFunctions(),
        status_code: 404,
      };
    }

    // Execute the tool. PHP's ToolsManager wraps handler failures in FunctionExecutionException
    // ("Function 'x' execution failed: reason", surfaced by index.php's Throwable handler as a
    // 500 {success:false,error} envelope) and wraps scalar results as ['result' => ...]; the TS
    // ToolsManager does neither, so both behaviors are replicated here (the rethrown error reaches
    // the client via handle()'s identical 500 envelope).
    let result: any;
    try {
      result = await this.toolsManager.execute(toolName, parameters, userId);
    } catch (e: any) {
      throw new Error(`Function '${toolName}' execution failed: ` + (e?.message ?? String(e)));
    }
    if (result === null || typeof result !== 'object') {
      result = { result };
    }

    // Format response for Hume EVI (content must be a string).
    const content = phpJsonPrettyPrint(result);

    return {
      success: true,
      toolCallId,
      toolName,
      content,
      result,
      status_code: 200,
    };
  }

  /** GET /api/v1/hume/tools/list — list available tools in Hume format. */
  async list(_ctx: Ctx): Promise<ControllerResult> {
    // Get Claude-format definitions and convert to Hume EVI format.
    const claudeDefinitions = this.toolsManager.getToolDefinitions();

    const humeTools = claudeDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));

    return {
      success: true,
      tools: humeTools,
      count: humeTools.length,
      note: 'Copy these tool definitions to your Hume EVI configuration',
      status_code: 200,
    };
  }

  /** POST /api/v1/hume/tools/sync — sync tools to the Hume API. */
  async sync(_ctx: Ctx): Promise<ControllerResult> {
    try {
      const syncService = new HumeToolSyncService(this.config);
      const results = await syncService.syncAllTools(this.toolsManager);

      return {
        success: true,
        message: 'Tools synchronized successfully',
        stats: {
          total_local: results.total_local,
          total_hume: results.total_hume,
          created: results.created.length,
          updated: results.updated.length,
          unchanged: results.unchanged.length,
          errors: results.errors.length,
        },
        details: results,
        timestamp: phpDateYmdHis(new Date()),
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message ?? String(e),
        status_code: 500,
      };
    }
  }

  /** GET /api/v1/hume/tools/status — get sync status. */
  async getStatus(_ctx: Ctx): Promise<ControllerResult> {
    try {
      const syncService = new HumeToolSyncService(this.config);
      const status = await syncService.getSyncStatus(this.toolsManager);

      return {
        success: true,
        status,
        needs_action: status.missing_in_hume.length > 0 || status.missing_in_local.length > 0,
        timestamp: phpDateYmdHis(new Date()),
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message ?? String(e),
        status_code: 500,
      };
    }
  }

  /** GET /api/v1/hume/tools/test-connection — test the Hume API connection. */
  async testConnection(_ctx: Ctx): Promise<ControllerResult> {
    try {
      const syncService = new HumeToolSyncService(this.config);
      const result = await syncService.testConnection();

      return { ...result, status_code: result.success ? 200 : 500 };
    } catch (e: any) {
      return {
        success: false,
        message: 'Connection failed: ' + (e?.message ?? String(e)),
        status_code: 500,
      };
    }
  }

  /** GET /api/v1/hume/config — get the current Hume EVI configuration. */
  async getConfig(_ctx: Ctx): Promise<ControllerResult> {
    try {
      const configId = this.config.config_id ?? '';

      if (!configId) {
        return {
          success: false,
          error: 'No config_id set in ai_config.php',
          status_code: 400,
        };
      }

      const apiKey = this.config.api_key;
      const baseUrl = this.config.base_url;

      const res = await fetch(`${baseUrl}/configs/${configId}`, {
        headers: { 'X-Hume-Api-Key': apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) {
        // Guzzle (http_errors=true) throws on non-2xx too; message wording differs from Guzzle's.
        throw new Error(`HTTP ${res.status} GET ${baseUrl}/configs/${configId}: ${text.slice(0, 300)}`);
      }

      const configData = text ? JSON.parse(text) : null;

      return {
        success: true,
        config: configData,
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message ?? String(e),
        status_code: 500,
      };
    }
  }

  /**
   * Initialize and register all functions. PHP registers Watchlist/Portfolio (PDO) and
   * Search/Analysis (config) function sets; only SearchFunctions exists in TS so far
   * (see header divergence note).
   */
  private initializeToolsManager(): ToolsManager {
    const toolsManager = new ToolsManager();
    SearchFunctions.register(toolsManager);
    return toolsManager;
  }
}
