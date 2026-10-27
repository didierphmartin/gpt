import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { SearchFunctions } from '../Functions/SearchFunctions';
import { LLMProviderResolver } from '../Services/LLMProviderResolver';
import { chatProviderRows } from '../Services/ProviderKinds';
import { PackageResolver } from '../Services/PackageResolver';
import { AgentDelegationFunctions } from '../AgentTeam/AgentDelegationFunctions';
import { phpEmpty } from '../Playbook/php';

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
    // Router rows (Jev) store a key here but cannot chat: never offer them.
    return chatProviderRows(rows).map((r) => ({
      name: r.provider_key,
      display_name: r.display_name,
      model: r.model,
      available: true,
      supported_models: this.parseJson(r.supported_models) ?? [],
      max_tokens: Number(r.max_tokens),
      api_format: r.api_format,
    }));
  }

  /**
   * The provider names the caller's package enables (providers[name].enabled truthy), or null when the
   * package has no providers entry ("show everything"). Mirrors resolvePackageAllowedProviders.
   */
  private async resolvePackageAllowedProviders(userId: number | null): Promise<string[] | null> {
    try {
      const pkg: any = await new PackageResolver().resolveForUser(userId);
      const providers = pkg?.capabilities?.providers ?? null;
      if (providers === null || typeof providers !== 'object') return null;
      return Object.entries(providers)
        .filter(([, cfg]: [string, any]) => cfg !== null && typeof cfg === 'object' && !phpEmpty(cfg.enabled))
        .map(([name]) => name);
    } catch (e: any) {
      console.error('[ProviderController] Package allowlist resolution failed: ' + (e?.message ?? e));
      return null;
    }
  }

  /** GET /api/v1/providers */
  async list(ctx: Ctx): Promise<ControllerResult> {
    try {
      let allProviders = await this.getProvidersFromDatabase();
      const userId = ctx.user_id;
      const userIdForPackage = userId !== null && userId !== undefined && /^\d+$/.test(String(userId)) ? Number(userId) : null;

      // Package-based allowlist: keep only providers the caller's role-based package has enabled.
      const allowedProviders = await this.resolvePackageAllowedProviders(userIdForPackage);
      if (allowedProviders !== null) allProviders = allProviders.filter((p) => allowedProviders.includes(p.name ?? ''));

      // Built-in function names + the GLOBAL MCP servers' tool names the package allows (PHP loads
      // with no user, so private servers are not listed) + the delegation tools.
      const functions = this.toolsManager.getRegisteredFunctions();
      try {
        const mcpAllowlist = await new PackageResolver().allowedMcpServers(userIdForPackage);
        const mcp = new MCPToolsLoader();
        await mcp.loadToolsForUser(null, mcpAllowlist);
        for (const name of mcp.getTools().keys()) functions.push(name);
      } catch (e: any) {
        console.error('ProviderController: Failed to load MCP tools: ' + (e?.message ?? e));
      }
      for (const name of AgentDelegationFunctions.getToolNames()) functions.push(name);

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
      return { status_code: 400, success: false, error: `Provider '${newProvider}' is not available` };
    }
    return { success: true, message: `Switched to provider: ${newProvider}`, current_provider: newProvider };
  }
}
