import { sql, Kysely, Transaction } from 'kysely';
import { db } from '../db/pools';
import { DB } from '../db/types';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/SystemSettingsController.php — the admin dashboard's LLM
 * provider/model management over the `system_llm_settings` table (the same table the chat
 * app reads for provider config). Admin-gated: every endpoint calls requireAdmin first.
 *
 * Notes on faithful divergence:
 *  - Runtime DDL (ensurePriceColumnsExist) is NOT replicated — the price columns already exist
 *    (parity-tracker: schema is authoritative). Queries assume the columns are present.
 *  - PHP's $this->config is the raw ai_config.php array (index.php: `new $controllerClass($pdo, $config)`).
 *    That array no longer contains the per-provider blocks (claude/openai/…) nor a 'providers' array —
 *    they were removed and are now loaded from system_llm_settings at runtime. Consequently
 *    getProvidersFromConfig and seedFromConfig read an EMPTY provider set here (phpConfig = {}) and
 *    produce empty results — exactly matching live PHP. The full loops/seedProvider upsert are still
 *    ported for fidelity (they'd behave identically if the config ever carried provider blocks again).
 */

// PHP (float) cast semantics (leading-numeric, else 0; bool→1/0).
function phpFloatVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

// PHP (int) cast semantics (truncating; bool→1/0; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP (bool) cast semantics (false for null/0/""/"0"/false; true otherwise).
function phpBoolVal(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (v === null || v === undefined) return false;
  return true;
}

function ucfirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export class SystemSettingsController {
  // Allowed API formats for validation (SystemSettingsController::ALLOWED_API_FORMATS).
  private static readonly ALLOWED_API_FORMATS = ['openai', 'anthropic', 'gemini', 'custom'];

  // Top-level provider keys that have dedicated config sections (::TOP_LEVEL_PROVIDERS).
  private static readonly TOP_LEVEL_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'gamma4'];

  // Default per-million-token pricing (USD) fallbacks (::PRICE_DEFAULTS). [input_per_1m, output_per_1m].
  private static readonly PRICE_DEFAULTS: Record<string, [number | null, number | null]> = {
    claude: [3.0, 15.0],
    openai: [2.5, 10.0],
    gemini: [0.3, 2.5],
    grok: [0.2, 0.5],
    deepseek: [0.28, 0.42],
    kimi: [0.55, 2.2],
    gamma4: [0.0, 0.0],
  };

  // Mirrors PHP's $this->config (the ai_config.php array) for provider-seeding purposes. The array
  // no longer carries provider blocks nor a 'providers' entry (now DB-loaded), so this is empty —
  // getProvidersFromConfig/seedFromConfig therefore return empty sets, matching live PHP.
  private readonly phpConfig: Record<string, any> = {};

  /**
   * Verify the current user has admin role. Returns an error ControllerResult to short-circuit,
   * or null when the caller is an admin. Mirrors requireAdmin().
   */
  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    const userId = ctx.user_id ?? null;

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    const user = (await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId}`.execute(db)).rows[0];

    if (!user || user.role !== 'admin') {
      return { success: false, error: 'Admin access required', status_code: 403 };
    }

    return null;
  }

  /** Mask API key for display (first 4 + *** + last 4; '***' when missing or < 12 chars). */
  private maskApiKey(apiKey: string | null): string {
    if (!apiKey || apiKey.length < 12) {
      return '***';
    }
    return apiKey.slice(0, 4) + '***' + apiKey.slice(-4);
  }

  // Mirrors PHP json_decode($val ?? '[]', true). mysql2 may auto-parse a JSON column into an
  // object/array already — pass that through unchanged; decode strings; invalid JSON → null.
  private decodeSupportedModels(val: any): any {
    if (val === null || val === undefined) val = '[]';
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }

  /** GET /api/v1/admin/llm-settings — all providers (DB, falling back to config when empty). */
  async getLLMProviders(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    try {
      const providers = (
        await sql<any>`SELECT * FROM system_llm_settings ORDER BY sort_order ASC, display_name ASC`.execute(db)
      ).rows;

      if (providers.length === 0) {
        // Fall back to config file
        return this.getProvidersFromConfig();
      }

      for (const provider of providers) {
        provider.api_key_masked = this.maskApiKey(provider.api_key ?? '');
        // Keep actual api_key for admin editing (admin-only endpoint)
        provider.supported_models = this.decodeSupportedModels(provider.supported_models);
        provider.streaming = phpBoolVal(provider.streaming);
        provider.supports_tools = phpBoolVal(provider.supports_tools);
        provider.enabled = phpBoolVal(provider.enabled);
        provider.max_tokens = phpIntVal(provider.max_tokens);
        provider.temperature = phpFloatVal(provider.temperature);
        provider.sort_order = phpIntVal(provider.sort_order);
        const defaults = SystemSettingsController.PRICE_DEFAULTS[provider.provider_key] ?? [null, null];
        provider.price_input_per_1m =
          provider.price_input_per_1m !== undefined && provider.price_input_per_1m !== null
            ? phpFloatVal(provider.price_input_per_1m)
            : defaults[0];
        provider.price_output_per_1m =
          provider.price_output_per_1m !== undefined && provider.price_output_per_1m !== null
            ? phpFloatVal(provider.price_output_per_1m)
            : defaults[1];
      }

      return { success: true, providers, source: 'database', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: 'Failed to fetch LLM providers: ' + (e?.message ?? ''), status_code: 500 };
    }
  }

  /** Get providers from config (fallback). Mirrors getProvidersFromConfig(). */
  private getProvidersFromConfig(): ControllerResult {
    const providers: any[] = [];
    let sortOrder = 0;

    const providerDefaults: Record<string, Record<string, any>> = {
      claude: {
        display_name: 'Claude',
        base_url: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        max_tokens: 64000,
        api_format: 'anthropic',
        chat_endpoint: '/v1/messages',
      },
      openai: {
        display_name: 'OpenAI',
        base_url: 'https://api.openai.com',
        model: 'gpt-4o',
        max_tokens: 4096,
        api_format: 'openai',
        chat_endpoint: '/v1/chat/completions',
      },
      gemini: {
        display_name: 'Gemini',
        base_url: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        max_tokens: 8192,
        api_format: 'gemini',
        chat_endpoint: '/v1beta/models',
      },
      grok: {
        display_name: 'Grok',
        base_url: 'https://api.x.ai',
        model: 'grok-2-latest',
        max_tokens: 4096,
        api_format: 'openai',
        chat_endpoint: '/v1/chat/completions',
      },
      deepseek: {
        display_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        max_tokens: 4096,
        api_format: 'openai',
        chat_endpoint: '/v1/chat/completions',
      },
      kimi: {
        display_name: 'Kimi',
        base_url: 'https://api.moonshot.cn',
        model: 'moonshot-v1-auto',
        max_tokens: 4096,
        api_format: 'openai',
        chat_endpoint: '/v1/chat/completions',
      },
      gamma4: {
        display_name: 'Gamma4',
        base_url: 'https://g4eb.yellowbrickroad.info',
        model: 'Gemma-4-E4B-it',
        max_tokens: 4096,
        api_format: 'openai',
        chat_endpoint: '/v1/chat/completions',
      },
    };

    // Add top-level providers
    for (const key of SystemSettingsController.TOP_LEVEL_PROVIDERS) {
      if (this.phpConfig[key] !== undefined) {
        const cfg = this.phpConfig[key];
        const defaults = providerDefaults[key] ?? {};
        const prices = SystemSettingsController.PRICE_DEFAULTS[key] ?? [null, null];
        providers.push({
          id: null,
          provider_key: key,
          display_name: cfg.display_name ?? defaults.display_name ?? ucfirst(key),
          api_key: cfg.api_key ?? '',
          api_key_masked: this.maskApiKey(cfg.api_key ?? ''),
          model: cfg.model ?? defaults.model ?? '',
          base_url: cfg.base_url ?? defaults.base_url ?? '',
          max_tokens: phpIntVal(cfg.max_tokens ?? defaults.max_tokens ?? 4096),
          temperature: phpFloatVal(cfg.temperature ?? 0.7),
          price_input_per_1m: cfg.price_input_per_1m !== undefined ? phpFloatVal(cfg.price_input_per_1m) : prices[0],
          price_output_per_1m: cfg.price_output_per_1m !== undefined ? phpFloatVal(cfg.price_output_per_1m) : prices[1],
          chat_endpoint: cfg.chat_endpoint ?? defaults.chat_endpoint ?? '/v1/chat/completions',
          streaming: phpBoolVal(cfg.streaming ?? true),
          supports_tools: phpBoolVal(cfg.supports_tools ?? true),
          supported_models: cfg.supported_models ?? [],
          api_format: cfg.api_format ?? defaults.api_format ?? 'openai',
          system_prompt: cfg.system_prompt ?? null,
          enabled: true,
          sort_order: sortOrder++,
        });
      }
    }

    // Add custom providers from 'providers' array
    const custom = this.phpConfig['providers'];
    if (custom && typeof custom === 'object') {
      for (const [key, provider] of Object.entries(custom as Record<string, any>)) {
        // Skip if already added as top-level provider
        if (SystemSettingsController.TOP_LEVEL_PROVIDERS.includes(key) && this.phpConfig[key] !== undefined) {
          continue;
        }
        const prices = SystemSettingsController.PRICE_DEFAULTS[key] ?? [null, null];
        providers.push({
          id: null,
          provider_key: key,
          display_name: provider.display_name ?? ucfirst(key),
          api_key: provider.api_key ?? '',
          api_key_masked: this.maskApiKey(provider.api_key ?? ''),
          model: provider.model ?? '',
          base_url: provider.base_url ?? '',
          max_tokens: phpIntVal(provider.max_tokens ?? 4096),
          temperature: phpFloatVal(provider.temperature ?? 0.7),
          price_input_per_1m: provider.price_input_per_1m !== undefined ? phpFloatVal(provider.price_input_per_1m) : prices[0],
          price_output_per_1m: provider.price_output_per_1m !== undefined ? phpFloatVal(provider.price_output_per_1m) : prices[1],
          chat_endpoint: provider.chat_endpoint ?? '/v1/chat/completions',
          streaming: phpBoolVal(provider.streaming ?? true),
          supports_tools: phpBoolVal(provider.supports_tools ?? true),
          supported_models: provider.supported_models ?? [],
          api_format: provider.api_format ?? 'openai',
          system_prompt: provider.system_prompt ?? null,
          enabled: true,
          sort_order: sortOrder++,
        });
      }
    }

    return { success: true, providers, source: 'config', status_code: 200 };
  }

  /** GET /api/v1/admin/llm-settings/:key — single provider by key. Mirrors getLLMProvider(). */
  async getLLMProvider(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    const providerKey = ctx.params?.key ?? null;

    if (!providerKey) {
      return { success: false, error: 'Provider key is required', status_code: 400 };
    }

    try {
      const provider = (
        await sql<any>`SELECT * FROM system_llm_settings WHERE provider_key = ${providerKey}`.execute(db)
      ).rows[0];

      if (!provider) {
        return { success: false, error: 'Provider not found', status_code: 404 };
      }

      provider.api_key_masked = this.maskApiKey(provider.api_key ?? '');
      // Keep actual api_key for admin editing (admin-only endpoint)
      provider.supported_models = this.decodeSupportedModels(provider.supported_models);
      provider.streaming = phpBoolVal(provider.streaming);
      provider.supports_tools = phpBoolVal(provider.supports_tools);
      provider.enabled = phpBoolVal(provider.enabled);
      const defaults = SystemSettingsController.PRICE_DEFAULTS[provider.provider_key] ?? [null, null];
      provider.price_input_per_1m =
        provider.price_input_per_1m !== undefined && provider.price_input_per_1m !== null
          ? phpFloatVal(provider.price_input_per_1m)
          : defaults[0];
      provider.price_output_per_1m =
        provider.price_output_per_1m !== undefined && provider.price_output_per_1m !== null
          ? phpFloatVal(provider.price_output_per_1m)
          : defaults[1];

      return { success: true, provider, status_code: 200 };
    } catch (e: any) {
      return { success: false, error: 'Failed to fetch provider: ' + (e?.message ?? ''), status_code: 500 };
    }
  }

  /** POST/PUT /api/v1/admin/llm-settings — create or update a provider. Mirrors saveLLMProvider(). */
  async saveLLMProvider(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    const body: Record<string, any> = ctx.body ?? {};

    const providerKey = body.provider_key ?? null;
    if (!providerKey) {
      return { success: false, error: 'Provider key is required', status_code: 400 };
    }

    const displayName = body.display_name ?? ucfirst(providerKey);
    const model = body.model ?? null;
    if (!model) {
      return { success: false, error: 'Model is required', status_code: 400 };
    }

    // Validate api_format
    const apiFormat = body.api_format ?? 'openai';
    if (!SystemSettingsController.ALLOWED_API_FORMATS.includes(apiFormat)) {
      return {
        success: false,
        error: 'Invalid api_format. Allowed values: ' + SystemSettingsController.ALLOWED_API_FORMATS.join(', '),
        status_code: 400,
      };
    }

    try {
      // Check if provider exists
      const existing = (
        await sql<{ id: number; api_key: string | null }>`SELECT id, api_key FROM system_llm_settings WHERE provider_key = ${providerKey}`.execute(db)
      ).rows[0];

      // Handle API key - only update if a new one is provided
      let apiKey: string | null = body.api_key ?? null;
      if (existing && (!apiKey || apiKey === '' || apiKey.includes('***'))) {
        // Keep existing API key
        apiKey = existing.api_key;
      }

      let supportedModels: any = body.supported_models ?? [];
      if (Array.isArray(supportedModels) || (supportedModels !== null && typeof supportedModels === 'object')) {
        supportedModels = JSON.stringify(supportedModels);
      }

      const priceInput =
        'price_input_per_1m' in body && body.price_input_per_1m !== '' && body.price_input_per_1m !== null
          ? phpFloatVal(body.price_input_per_1m)
          : null;
      const priceOutput =
        'price_output_per_1m' in body && body.price_output_per_1m !== '' && body.price_output_per_1m !== null
          ? phpFloatVal(body.price_output_per_1m)
          : null;

      const baseUrl = body.base_url ?? null;
      const maxTokens = phpIntVal(body.max_tokens ?? 4096);
      const temperature = phpFloatVal(body.temperature ?? 0.7);
      const chatEndpoint = body.chat_endpoint ?? null;
      const streaming = phpIntVal(body.streaming ?? 1);
      const supportsTools = phpIntVal(body.supports_tools ?? 1);
      const apiFormatVal = body.api_format ?? 'openai';
      const systemPrompt = body.system_prompt ?? null;
      const enabled = phpIntVal(body.enabled ?? 1);
      const sortOrder = phpIntVal(body.sort_order ?? 0);

      if (existing) {
        await sql`
          UPDATE system_llm_settings SET
              display_name = ${displayName},
              api_key = ${apiKey},
              model = ${model},
              base_url = ${baseUrl},
              max_tokens = ${maxTokens},
              temperature = ${temperature},
              price_input_per_1m = ${priceInput},
              price_output_per_1m = ${priceOutput},
              chat_endpoint = ${chatEndpoint},
              streaming = ${streaming},
              supports_tools = ${supportsTools},
              supported_models = ${supportedModels},
              api_format = ${apiFormatVal},
              system_prompt = ${systemPrompt},
              enabled = ${enabled},
              sort_order = ${sortOrder},
              updated_at = NOW()
          WHERE provider_key = ${providerKey}`.execute(db);
      } else {
        await sql`
          INSERT INTO system_llm_settings
              (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
               price_input_per_1m, price_output_per_1m,
               chat_endpoint, streaming, supports_tools, supported_models, api_format,
               system_prompt, enabled, sort_order, created_at, updated_at)
          VALUES
              (${providerKey}, ${displayName}, ${apiKey}, ${model}, ${baseUrl}, ${maxTokens}, ${temperature},
               ${priceInput}, ${priceOutput},
               ${chatEndpoint}, ${streaming}, ${supportsTools}, ${supportedModels}, ${apiFormatVal},
               ${systemPrompt}, ${enabled}, ${sortOrder}, NOW(), NOW())`.execute(db);
      }

      return {
        success: true,
        message: existing ? 'Provider updated' : 'Provider created',
        provider_key: providerKey,
        status_code: existing ? 200 : 201,
      };
    } catch (e: any) {
      return { success: false, error: 'Failed to save provider: ' + (e?.message ?? ''), status_code: 500 };
    }
  }

  /** DELETE /api/v1/admin/llm-settings/:key. Mirrors deleteLLMProvider(). */
  async deleteLLMProvider(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    const providerKey = ctx.params?.key ?? null;

    if (!providerKey) {
      return { success: false, error: 'Provider key is required', status_code: 400 };
    }

    try {
      const existing = (
        await sql<{ id: number }>`SELECT id FROM system_llm_settings WHERE provider_key = ${providerKey}`.execute(db)
      ).rows[0];
      if (!existing) {
        return { success: false, error: 'Provider not found', status_code: 404 };
      }

      await sql`DELETE FROM system_llm_settings WHERE provider_key = ${providerKey}`.execute(db);

      return { success: true, message: 'Provider deleted', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: 'Failed to delete provider: ' + (e?.message ?? ''), status_code: 500 };
    }
  }

  /** POST /api/v1/admin/llm-settings/seed — seed DB from config. Mirrors seedFromConfig(). */
  async seedFromConfig(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    try {
      // Use transaction to ensure atomicity (mirrors PHP beginTransaction/commit).
      return await db.transaction().execute(async (trx) => {
        const seeded: string[] = [];
        let sortOrder = 0;

        // Seed all top-level providers
        for (const key of SystemSettingsController.TOP_LEVEL_PROVIDERS) {
          if (this.phpConfig[key] !== undefined) {
            const apiFormat = key === 'claude' ? 'anthropic' : key === 'gemini' ? 'gemini' : 'openai';
            await this.seedProvider(trx, key, this.phpConfig[key], apiFormat, sortOrder++);
            seeded.push(key);
          }
        }

        // Seed custom providers from 'providers' array
        const custom = this.phpConfig['providers'];
        if (custom && typeof custom === 'object') {
          for (const [key, provider] of Object.entries(custom as Record<string, any>)) {
            // Skip if already seeded as top-level provider
            if (seeded.includes(key)) {
              continue;
            }
            const apiFormat = provider.api_format ?? 'openai';
            await this.seedProvider(trx, key, provider, apiFormat, sortOrder++);
            seeded.push(key);
          }
        }

        return { success: true, message: 'Providers seeded from config', seeded, status_code: 200 };
      });
    } catch (e: any) {
      return { success: false, error: 'Failed to seed providers: ' + (e?.message ?? ''), status_code: 500 };
    }
  }

  /** Seed a single provider (helper). Mirrors seedProvider(). */
  private async seedProvider(
    executor: Kysely<DB> | Transaction<DB>,
    key: string,
    cfg: Record<string, any>,
    apiFormat: string,
    sortOrder: number
  ): Promise<void> {
    let supportedModels: any = cfg.supported_models ?? [];
    if (Array.isArray(supportedModels) || (supportedModels !== null && typeof supportedModels === 'object')) {
      supportedModels = JSON.stringify(supportedModels);
    }

    const priceDefaults = SystemSettingsController.PRICE_DEFAULTS[key] ?? [null, null];
    const priceInput = cfg.price_input_per_1m !== undefined ? phpFloatVal(cfg.price_input_per_1m) : priceDefaults[0];
    const priceOutput = cfg.price_output_per_1m !== undefined ? phpFloatVal(cfg.price_output_per_1m) : priceDefaults[1];

    await sql`
      INSERT INTO system_llm_settings
          (provider_key, display_name, api_key, model, base_url, max_tokens, temperature,
           price_input_per_1m, price_output_per_1m,
           chat_endpoint, streaming, supports_tools, supported_models, api_format,
           system_prompt, enabled, sort_order, created_at, updated_at)
      VALUES
          (${key}, ${cfg.display_name ?? ucfirst(key)}, ${cfg.api_key ?? null}, ${cfg.model ?? ''}, ${cfg.base_url ?? null}, ${phpIntVal(cfg.max_tokens ?? 4096)}, ${phpFloatVal(cfg.temperature ?? 0.7)},
           ${priceInput}, ${priceOutput},
           ${cfg.chat_endpoint ?? null}, ${phpIntVal(cfg.streaming ?? 1)}, ${phpIntVal(cfg.supports_tools ?? 1)}, ${supportedModels}, ${apiFormat},
           ${cfg.system_prompt ?? null}, ${1}, ${sortOrder}, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          api_key = VALUES(api_key),
          model = VALUES(model),
          base_url = VALUES(base_url),
          max_tokens = VALUES(max_tokens),
          temperature = VALUES(temperature),
          price_input_per_1m = VALUES(price_input_per_1m),
          price_output_per_1m = VALUES(price_output_per_1m),
          chat_endpoint = VALUES(chat_endpoint),
          streaming = VALUES(streaming),
          supports_tools = VALUES(supports_tools),
          supported_models = VALUES(supported_models),
          api_format = VALUES(api_format),
          system_prompt = VALUES(system_prompt),
          sort_order = VALUES(sort_order),
          updated_at = NOW()`.execute(executor);
  }

  /** POST /api/v1/admin/llm-settings/toggle — toggle enabled status. Mirrors toggleProvider(). */
  async toggleProvider(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;

    const body: Record<string, any> = ctx.body ?? {};
    const providerKey = body.provider_key ?? null;
    // PHP: isset($body['enabled']) is false for absent OR null.
    const enabled: boolean | null = 'enabled' in body && body.enabled !== null ? phpBoolVal(body.enabled) : null;

    if (!providerKey) {
      return { success: false, error: 'Provider key is required', status_code: 400 };
    }

    try {
      let res;
      if (enabled === null) {
        // Toggle current value
        res = await sql`UPDATE system_llm_settings SET enabled = NOT enabled, updated_at = NOW() WHERE provider_key = ${providerKey}`.execute(db);
      } else {
        res = await sql`UPDATE system_llm_settings SET enabled = ${enabled ? 1 : 0}, updated_at = NOW() WHERE provider_key = ${providerKey}`.execute(db);
      }

      if (Number(res.numAffectedRows ?? 0) === 0) {
        return { success: false, error: 'Provider not found', status_code: 404 };
      }

      return { success: true, message: 'Provider toggled', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: 'Failed to toggle provider: ' + (e?.message ?? ''), status_code: 500 };
    }
  }
}
