import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { SearchFunctions } from '../Functions/SearchFunctions';
import { LLMProviderResolver } from '../Services/LLMProviderResolver';

/** Mirrors src/Controllers/ProviderController.php (the provider picker's data source). */
export class ProviderController {
  private readonly toolsManager: ToolsManager;

  constructor() {
    this.toolsManager = new ToolsManager();
    SearchFunctions.register(this.toolsManager);
  }

  private parseJson(v: any): any {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  private async getProvidersFromDatabase(): Promise<any[]> {
    const rows = await db
      .selectFrom('system_llm_settings')
      .selectAll()
      .where('enabled', '=', 1)
      .orderBy('sort_order')
      .orderBy('display_name')
      .execute();
    return rows.map((r) => ({
      name: r.provider_key,
      display_name: r.display_name,
      model: r.model,
      available: true,
      supported_models: this.parseJson(r.supported_models) ?? [],
      max_tokens: Number(r.max_tokens),
      api_format: r.api_format,
    }));
  }

  /** GET /api/v1/providers */
  async list(ctx: Ctx): Promise<ControllerResult> {
    try {
      const allProviders = await this.getProvidersFromDatabase();
      const userId = ctx.user_id;

      // Built-in function names + the user's MCP tool names (package allowlist not yet ported → all).
      const functions = this.toolsManager.getRegisteredFunctions();
      try {
        const mcp = new MCPToolsLoader();
        await mcp.loadToolsForUser(userId ?? null);
        for (const name of mcp.getTools().keys()) functions.push(name);
      } catch {
        /* fail soft */
      }

      let userHasCustomKeys = false;
      let userEnabledProviders: string[] = [];
      if (userId) {
        const keys = await db
          .selectFrom('user_api_keys')
          .select('provider')
          .where('user_id', '=', userId)
          .where('api_key', 'is not', null)
          .where('api_key', '!=', '')
          .execute();
        userEnabledProviders = keys.map((k) => k.provider);
        userHasCustomKeys = userEnabledProviders.length > 0;
      }

      const providers = allProviders.map((p) => {
        const user_has_key = userEnabledProviders.includes(p.name);
        return { ...p, user_has_key, available: userHasCustomKeys ? p.available || user_has_key : p.available };
      });

      return {
        success: true,
        providers,
        current_provider: null,
        user_has_custom_keys: userHasCustomKeys,
        user_enabled_providers: userEnabledProviders,
        functions,
        function_count: functions.length,
      };
    } catch (e: any) {
      return { status_code: 500, success: false, error: e?.message ?? 'Internal error' };
    }
  }

  /** POST /api/v1/providers and /api/v1/providers/switch — validate the provider exists. */
  async switch(ctx: Ctx): Promise<ControllerResult> {
    const newProvider = ctx.body.provider ?? null;
    if (!newProvider) {
      return { status_code: 400, success: false, error: 'Provider name is required' };
    }
    const cfg = await LLMProviderResolver.getProviderConfig(newProvider);
    if (!cfg) {
      return { status_code: 400, success: false, error: `Provider '${newProvider}' not available` };
    }
    return { success: true, message: `Switched to provider: ${newProvider}`, current_provider: newProvider };
  }
}
