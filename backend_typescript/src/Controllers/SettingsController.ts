import crypto from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { PackageResolver } from '../Services/PackageResolver';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/SettingsController.php — user-facing settings: API keys (encrypted),
 * model selections, per-provider system-prompt overrides, usage stats, phone status, storage and
 * auto-heal settings.
 *
 * Notes on faithful divergence:
 *  - Runtime DDL (ensure*TableExists / ensure*ColumnsExist) is NOT replicated — the schema already
 *    exists (parity-tracker #7). Queries assume the columns are present.
 *  - PackageResolver is not ported, so getKeys returns empty package_models/locked (fail-open),
 *    matching MCPServerController's treatment of the same missing dependency.
 *  - saveStorageSettings updates the DB faithfully but does NOT create the physical universalFS
 *    folder (filesystem side effect, out of scope) — folder_created is reported as false.
 */
export class SettingsController {
  // Canonical user data folder name — hardcoded across the project (skills root, Pyodide mounts,
  // workflow output paths). Mirrors SettingsController::OFFICIAL_USER_FOLDER.
  private static readonly OFFICIAL_USER_FOLDER = 'synergyAI';
  private static readonly VALID_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];
  private static readonly VALID_STORAGE = ['local', 's3', 'gdrive', 'onedrive'];

  // Encryption key = sha256(jwt_secret) raw bytes — identical to PHP's hash('sha256', key, true).
  private static readonly ENC_KEY = crypto.createHash('sha256').update(config.auth.jwtSecret).digest();

  private encryptApiKey(plain: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', SettingsController.ENC_KEY, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, enc]).toString('base64');
  }

  private decryptApiKey(encB64: string | null): string | null {
    if (!encB64) return null;
    try {
      const data = Buffer.from(encB64, 'base64');
      if (data.length < 17) return null;
      const iv = data.subarray(0, 16);
      const enc = data.subarray(16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', SettingsController.ENC_KEY, iv);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return dec.toString('utf8');
    } catch {
      return null;
    }
  }

  /** GET /api/v1/settings/phone */
  async getPhoneStatus(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const row = (await sql<{ phone: string | null }>`SELECT phone FROM users WHERE id = ${userId}`.execute(db)).rows[0];
    const phone = row?.phone ?? null;
    return { success: true, phone, has_phone: !!phone };
  }

  /** GET /api/v1/settings/usage */
  async getUsage(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = `${currentMonth}-01`;

    const balances = (
      await sql<any>`
        SELECT provider, month_requests, month_tokens, month_cost_usd, total_requests, total_tokens,
               total_cost_usd, monthly_budget_usd, monthly_request_limit, current_month
        FROM llm_usage_balance WHERE user_id = ${userId}`.execute(db)
    ).rows;

    const transactionStats = (
      await sql<any>`
        SELECT provider, AVG(response_time_ms) as avg_response_time,
               SUM(prompt_tokens) as month_input_tokens, SUM(completion_tokens) as month_output_tokens,
               COUNT(*) as request_count
        FROM llm_usage_transactions
        WHERE user_id = ${userId} AND created_at >= ${monthStart}
        GROUP BY provider`.execute(db)
    ).rows;

    const statsMap: Record<string, any> = {};
    for (const s of transactionStats) {
      statsMap[s.provider] = {
        avg_response_time: s.avg_response_time,
        month_input_tokens: Number(s.month_input_tokens),
        month_output_tokens: Number(s.month_output_tokens),
      };
    }

    const byProvider: Record<string, any> = {};
    let totalCost = 0;
    let totalTokens = 0;
    let totalRequests = 0;
    for (const b of balances) {
      const stats = statsMap[b.provider] ?? {};
      byProvider[b.provider] = {
        month_requests: Number(b.month_requests),
        month_tokens: Number(b.month_tokens),
        month_input_tokens: stats.month_input_tokens ?? 0,
        month_output_tokens: stats.month_output_tokens ?? 0,
        month_cost_usd: Number(b.month_cost_usd),
        total_requests: Number(b.total_requests),
        total_tokens: Number(b.total_tokens),
        total_cost_usd: Number(b.total_cost_usd),
        budget_limit: Number(b.monthly_budget_usd),
        request_limit: Number(b.monthly_request_limit),
        avg_response_time: stats.avg_response_time ?? null,
      };
      totalCost += Number(b.month_cost_usd);
      totalTokens += Number(b.month_tokens);
      totalRequests += Number(b.month_requests);
    }

    const lifetime =
      (
        await sql<any>`
          SELECT COALESCE(SUM(prompt_tokens),0) as lifetime_input_tokens,
                 COALESCE(SUM(completion_tokens),0) as lifetime_output_tokens,
                 COALESCE(SUM(total_tokens),0) as lifetime_total_tokens,
                 COALESCE(SUM(cost_usd),0) as lifetime_cost_usd,
                 COUNT(*) as lifetime_requests
          FROM llm_usage_transactions WHERE user_id = ${userId}`.execute(db)
      ).rows[0] ?? {};

    const userRow =
      (await sql<{ plan: string | null; role: string | null }>`SELECT plan, role FROM users WHERE id = ${userId}`.execute(db)).rows[0] ?? {};

    return {
      success: true,
      usage: {
        current_month: currentMonth,
        by_provider: byProvider,
        totals: { cost_usd: totalCost, tokens: totalTokens, requests: totalRequests },
        lifetime: {
          input_tokens: Number(lifetime.lifetime_input_tokens ?? 0),
          output_tokens: Number(lifetime.lifetime_output_tokens ?? 0),
          total_tokens: Number(lifetime.lifetime_total_tokens ?? 0),
          cost_usd: Number(lifetime.lifetime_cost_usd ?? 0),
          requests: Number(lifetime.lifetime_requests ?? 0),
        },
        plan: (userRow as any).plan ?? 'free',
        role: (userRow as any).role ?? 'prospect',
        free_trial_quota: 50000,
      },
    };
  }

  /** GET /api/v1/settings/keys */
  async getKeys(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;

    const keys = (
      await sql<{ provider: string; api_key: string | null; system_prompt: string | null; created_at: string | null; updated_at: string | null }>`
        SELECT provider, api_key, system_prompt, created_at, updated_at FROM user_api_keys WHERE user_id = ${userId}`.execute(db)
    ).rows;

    const result: Record<string, any> = {};
    const systemPrompts: Record<string, string> = {};
    for (const key of keys) {
      const decrypted = this.decryptApiKey(key.api_key);
      const masked = decrypted ? '****' + decrypted.slice(-4) : null;
      result[key.provider] = { has_custom_key: !!decrypted, masked_key: masked, updated_at: key.updated_at };
      if (key.system_prompt) systemPrompts[key.provider] = key.system_prompt;
    }

    const modelRows = (
      await sql<{ provider: string; model: string }>`SELECT provider, model FROM user_model_selections WHERE user_id = ${userId}`.execute(db)
    ).rows;
    const models: Record<string, string> = {};
    for (const row of modelRows) models[row.provider] = row.model;

    // Package model-lock: when the user is on the package's shared key (has_custom_key === false),
    // the package's default_model is authoritative and the user's saved selection is ignored on the
    // chat path. Frontend disables the dropdown for those providers and shows package_models[provider].
    // Mirrors ChatController/SettingsController.php's PackageResolver block (fail-open on error).
    const packageModels: Record<string, string> = {};
    const locked: Record<string, boolean> = {};
    try {
      const resolver = new PackageResolver();
      const userIdInt = /^\d+$/.test(String(userId)) ? Number(userId) : null;
      const pkg = await resolver.resolveForUser(userIdInt);
      const providersCfg = pkg.capabilities?.providers ?? [];
      if (providersCfg && typeof providersCfg === 'object') {
        for (const [providerKey, providerCfg] of Object.entries(providersCfg as Record<string, any>)) {
          if (!providerCfg || typeof providerCfg !== 'object' || !providerCfg.enabled) continue;
          const defaultModel = typeof providerCfg.default_model === 'string' ? providerCfg.default_model.trim() : '';
          if (defaultModel !== '') packageModels[providerKey] = defaultModel;
          const hasOwnKey = !!result[providerKey]?.has_custom_key;
          locked[providerKey] = !hasOwnKey;
        }
      }
    } catch {
      /* fail open — leave package_models/locked empty */
    }

    return { success: true, keys: result, models, package_models: packageModels, locked, system_prompts: systemPrompts };
  }

  /** POST /api/v1/settings/keys */
  async saveKeys(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const keys: Record<string, any> = ctx.body.keys ?? {};
    const models: Record<string, any> = ctx.body.models ?? {};
    const systemPrompts: Record<string, any> = ctx.body.system_prompts ?? {};

    if (!Object.keys(keys).length && !Object.keys(models).length && !Object.keys(systemPrompts).length) {
      return { status_code: 400, success: false, error: 'No keys, models, or system_prompts provided' };
    }

    const valid = SettingsController.VALID_PROVIDERS;
    let savedCount = 0;
    for (const [provider, apiKey] of Object.entries(keys)) {
      if (!valid.includes(provider)) continue;
      if (typeof apiKey !== 'string' || apiKey.trim() === '') continue;
      const encryptedKey = this.encryptApiKey(apiKey.trim());
      await sql`
        INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)
        VALUES (${userId}, ${provider}, ${encryptedKey}, NOW(), NOW())
        ON DUPLICATE KEY UPDATE api_key = VALUES(api_key), updated_at = NOW()`.execute(db);
      savedCount++;
    }

    let modelCount = 0;
    for (const [provider, model] of Object.entries(models)) {
      if (!valid.includes(provider)) continue;
      if (typeof model !== 'string' || model.trim() === '') continue;
      await sql`
        INSERT INTO user_model_selections (user_id, provider, model, updated_at)
        VALUES (${userId}, ${provider}, ${model.trim()}, NOW())
        ON DUPLICATE KEY UPDATE model = VALUES(model), updated_at = NOW()`.execute(db);
      modelCount++;
    }

    let promptCount = 0;
    for (const [provider, prompt] of Object.entries(systemPrompts)) {
      if (!valid.includes(provider)) continue;
      if (typeof prompt !== 'string') continue;
      const value = prompt.trim();
      const stored = value === '' ? null : value;
      await sql`
        INSERT INTO user_api_keys (user_id, provider, api_key, system_prompt, created_at, updated_at)
        VALUES (${userId}, ${provider}, '', ${stored}, NOW(), NOW())
        ON DUPLICATE KEY UPDATE system_prompt = VALUES(system_prompt), updated_at = NOW()`.execute(db);
      promptCount++;
    }

    return {
      success: true,
      message: `Saved ${savedCount} API key(s), ${modelCount} model(s), ${promptCount} system prompt(s)`,
      saved_count: savedCount,
      model_count: modelCount,
      prompt_count: promptCount,
    };
  }

  /** DELETE /api/v1/settings/keys */
  async clearKeys(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const delKeys = await sql`DELETE FROM user_api_keys WHERE user_id = ${userId}`.execute(db);
    const delModels = await sql`DELETE FROM user_model_selections WHERE user_id = ${userId}`.execute(db);
    const deletedCount = Number(delKeys.numAffectedRows ?? 0);
    const modelDeletedCount = Number(delModels.numAffectedRows ?? 0);
    return { success: true, message: `Cleared ${deletedCount} API key(s) and ${modelDeletedCount} model selection(s)` };
  }

  // --- Auto-heal settings -----------------------------------------------------------------

  private healDefaults() {
    return {
      heal_mode: 'off',
      heal_daily_budget_usd: 5.0,
      heal_per_heal_ceiling_usd: 1.0,
      heal_proposer_provider: 'claude',
      heal_eval_provider: 'kimi',
      heal_judge_provider: 'kimi',
      heal_max_iterations: 3,
      heal_runs_per_query: 3,
    } as Record<string, any>;
  }

  /** GET /api/v1/settings/heal */
  async getHealSettings(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };
    const defaults = this.healDefaults();
    try {
      const row =
        (
          await sql<any>`
            SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd, heal_proposer_provider,
                   heal_eval_provider, heal_judge_provider, heal_max_iterations, heal_runs_per_query
            FROM users WHERE id = ${userId}`.execute(db)
        ).rows[0] ?? {};
      const s = { ...defaults };
      for (const [k, def] of Object.entries(defaults)) {
        if (row[k] !== undefined && row[k] !== null) {
          s[k] = typeof def === 'number' ? (Number.isInteger(def) ? parseInt(row[k], 10) : parseFloat(row[k])) : String(row[k]);
        }
      }
      return { success: true, settings: s };
    } catch (e: any) {
      return { success: true, settings: defaults };
    }
  }

  /** POST /api/v1/settings/heal */
  async saveHealSettings(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const b = ctx.body ?? {};
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };
    const valid = SettingsController.VALID_PROVIDERS;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const mode = ['off', 'ask', 'auto'].includes(b.heal_mode) ? b.heal_mode : 'off';
    const evalP = valid.includes(b.heal_eval_provider) ? b.heal_eval_provider : 'kimi';
    const proposer = valid.includes(b.heal_proposer_provider) ? b.heal_proposer_provider : 'claude';
    const judge = valid.includes(b.heal_judge_provider) ? b.heal_judge_provider : 'kimi';
    const budget = clamp(Number(b.heal_daily_budget_usd ?? 5.0) || 0, 0, 1000);
    const ceiling = clamp(Number(b.heal_per_heal_ceiling_usd ?? 1.0) || 0, 0, 1000);
    const iters = clamp(parseInt(b.heal_max_iterations ?? 3, 10) || 3, 1, 10);
    const runs = clamp(parseInt(b.heal_runs_per_query ?? 3, 10) || 3, 1, 5);

    try {
      await sql`
        UPDATE users SET heal_mode = ${mode}, heal_daily_budget_usd = ${budget}, heal_per_heal_ceiling_usd = ${ceiling},
               heal_proposer_provider = ${proposer}, heal_eval_provider = ${evalP}, heal_judge_provider = ${judge},
               heal_max_iterations = ${iters}, heal_runs_per_query = ${runs} WHERE id = ${userId}`.execute(db);
      return {
        success: true,
        settings: {
          heal_mode: mode,
          heal_daily_budget_usd: budget,
          heal_per_heal_ceiling_usd: ceiling,
          heal_proposer_provider: proposer,
          heal_eval_provider: evalP,
          heal_judge_provider: judge,
          heal_max_iterations: iters,
          heal_runs_per_query: runs,
        },
      };
    } catch (e: any) {
      return { status_code: 500, success: false, error: 'Save failed' };
    }
  }

  // --- Active avatar / voice provider ----------------------------------------------------

  /**
   * POST /api/v1/settings/provider/active — mirrors SettingsController.php::setActiveProvider.
   * Marks one provider active within a category (avatar|voice), deactivating its siblings.
   * ensureProviderSettingsTableExists DDL is NOT replicated (user_provider_settings exists).
   * NB: PHP returns 400 (not 404) when the provider row is absent — mirrored faithfully.
   */
  async setActiveProvider(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const input = ctx.body ?? {};

    const category = input.category ?? '';
    const provider = input.provider ?? '';

    if (!['avatar', 'voice'].includes(category)) {
      return { success: false, error: 'Invalid category. Must be "avatar" or "voice"', status_code: 400 };
    }

    if (!provider) {
      return { success: false, error: 'Provider is required', status_code: 400 };
    }

    // Verify the provider exists for this user.
    const existing = (
      await sql<{ id: number }>`SELECT id FROM user_provider_settings
             WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db)
    ).rows[0];

    if (!existing) {
      return { success: false, error: `Provider '${provider}' not configured for ${category}`, status_code: 400 };
    }

    // Deactivate all providers in this category for this user.
    await sql`UPDATE user_provider_settings SET is_active = 0
              WHERE user_id = ${userId} AND category = ${category}`.execute(db);

    // Activate the selected provider.
    await sql`UPDATE user_provider_settings SET is_active = 1, updated_at = NOW()
              WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db);

    return { success: true, message: `Active ${category} provider set to '${provider}'`, status_code: 200 };
  }

  // --- Storage settings -------------------------------------------------------------------

  /** GET /api/v1/settings/storage */
  async getStorageSettings(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    const user =
      (await sql<{ storage_provider: string | null; storage_folder: string | null }>`SELECT storage_provider, storage_folder FROM users WHERE id = ${userId}`.execute(db)).rows[0] ??
      ({} as any);

    // Auto-correct stale rows to the canonical folder name (DB only; physical folder creation
    // on the storage provider is not ported — see class note).
    let folder = user.storage_folder ?? '';
    if (folder !== SettingsController.OFFICIAL_USER_FOLDER) {
      await sql`UPDATE users SET storage_folder = ${SettingsController.OFFICIAL_USER_FOLDER} WHERE id = ${userId}`.execute(db);
      folder = SettingsController.OFFICIAL_USER_FOLDER;
    }

    return {
      success: true,
      data: { provider: user.storage_provider ?? 'local', folder, available_providers: ['local', 's3', 'gdrive', 'onedrive'] },
    };
  }

  /** POST /api/v1/settings/storage */
  async saveStorageSettings(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const body = ctx.body ?? {};
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    const provider = body.provider ?? 'local';
    let folder = String(body.folder ?? '').trim();
    if (!SettingsController.VALID_STORAGE.includes(provider)) {
      return { status_code: 400, success: false, error: 'Invalid storage provider' };
    }
    // Force the canonical folder name (silent normalization, matching PHP).
    if (folder !== SettingsController.OFFICIAL_USER_FOLDER) folder = SettingsController.OFFICIAL_USER_FOLDER;

    try {
      await sql`UPDATE users SET storage_provider = ${provider}, storage_folder = ${folder} WHERE id = ${userId}`.execute(db);
      // Physical universalFS folder creation is not ported (filesystem side effect, out of scope).
      return { success: true, message: 'Storage settings saved', data: { provider, folder, folder_created: false } };
    } catch (e: any) {
      return { status_code: 500, success: false, error: e?.message ?? 'Save failed' };
    }
  }
}
