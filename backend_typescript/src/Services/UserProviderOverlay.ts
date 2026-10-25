import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { ProviderConfig } from '../Contracts/types';
import { ApiKeyCrypto } from './ApiKeyCrypto';
import { LLMProviderResolver } from './LLMProviderResolver';
import { PackageResolver } from './PackageResolver';
import { phpEmpty } from '../Playbook/php';

/**
 * The per-user layers ChatController.php puts on top of the system provider config, in its order:
 *   1. system_llm_settings            (LLMProviderResolver.getProviderConfig)
 *   2. applyPackageDefaults           — the role package's default_api_key / default_model
 *   3. applyUserApiKeys               — the user's own key (+ own entry point), model choice and
 *                                       system-prompt override
 *
 * PHP overlays every provider block of its config array at once; the TS chat path resolves one
 * provider at a time, so each layer here applies to that one ProviderConfig — the rows/entries for
 * other providers are the ones PHP would have written onto blocks this request never reads.
 *
 * Mirrors ChatController::applyPackageDefaults / ::applyUserApiKeys
 * (backend/src/Controllers/ChatController.php).
 */
export class UserProviderOverlay {
  /** getProviderConfig + package defaults + the user's overrides; null when the provider is not available. */
  static async resolve(provider: string, userId: number | null, secret: string = config.auth.jwtSecret): Promise<ProviderConfig | null> {
    const cfg = await LLMProviderResolver.getProviderConfig(provider);
    if (!cfg) return null;
    await UserProviderOverlay.applyPackageDefaults(cfg, userId);
    await UserProviderOverlay.applyUserApiKeys(cfg, userId, secret);
    return cfg;
  }

  /**
   * The user's role package: when it enables this provider, its non-blank default_api_key and
   * default_model are written onto the config. A guest (null user) gets the guest package.
   */
  static async applyPackageDefaults(cfg: ProviderConfig, userId: number | null): Promise<ProviderConfig> {
    try {
      const pkg = await new PackageResolver().resolveForUser(userId);
      const providers = pkg.capabilities?.providers ?? [];
      // PHP is_array(): a list has only integer keys, so it never names a provider.
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return cfg;

      const providerCfg = providers[cfg.provider_key];
      if (providerCfg === null || typeof providerCfg !== 'object' || Array.isArray(providerCfg)) return cfg;
      if (phpEmpty(providerCfg.enabled)) return cfg;

      const defaultKey = typeof providerCfg.default_api_key === 'string' ? providerCfg.default_api_key.trim() : '';
      const defaultModel = typeof providerCfg.default_model === 'string' ? providerCfg.default_model.trim() : '';
      if (defaultKey !== '') cfg.api_key = defaultKey;
      if (defaultModel !== '') cfg.model = defaultModel;
    } catch (e: any) {
      console.error('[ChatController] Package defaults failed: ' + (e?.message ?? e));
    }
    return cfg;
  }

  /**
   * The user's own settings for this provider (user_api_keys + user_model_selections):
   *  - an enabled row with a usable key (encrypted by Settings, or in the clear from gpt_admin)
   *    replaces the api_key, and carries the user's own base_url / chat_endpoint with it — on the
   *    package/admin key those are ignored, so that key never goes to a URL the user picked;
   *  - a non-blank system_prompt replaces the persona, with or without a key of their own;
   *  - the user's model selection applies only when they supplied their own key (on the package
   *    key the package's model stands: the admin pays, the admin picks the model).
   */
  static async applyUserApiKeys(cfg: ProviderConfig, userId: number | null, secret: string = config.auth.jwtSecret): Promise<ProviderConfig> {
    if (userId === null || !userId) return cfg;

    try {
      if ((await sql<any>`SHOW TABLES LIKE 'user_api_keys'`.execute(db)).rows.length === 0) return cfg;

      // SELECT *: base_url / chat_endpoint are added by later migrations; an install without
      // them must still get its users' keys.
      const keys = (await sql<any>`SELECT * FROM user_api_keys WHERE user_id = ${userId}`.execute(db)).rows;

      let modelRows: any[] = [];
      try {
        if ((await sql<any>`SHOW TABLES LIKE 'user_model_selections'`.execute(db)).rows.length > 0) {
          modelRows = (await sql<any>`SELECT provider, model FROM user_model_selections WHERE user_id = ${userId}`.execute(db)).rows;
        }
      } catch (e: any) {
        console.error('[ChatController] Error loading user models: ' + (e?.message ?? e));
      }

      if (keys.length === 0 && modelRows.length === 0) return cfg;

      const key = cfg.provider_key;
      let ownKey = false;

      for (const row of keys) {
        // An admin can switch a user's override off in gpt_admin.
        if (row.enabled !== undefined && row.enabled !== null && !Number(row.enabled)) continue;
        if (row.provider !== key) continue;

        const decrypted = ApiKeyCrypto.reveal(String(row.api_key ?? ''), secret);
        if (decrypted) {
          ownKey = true;
          cfg.api_key = decrypted;
          const baseUrl = String(row.base_url ?? '').trim();
          const chatEndpoint = String(row.chat_endpoint ?? '').trim();
          // Same trailing-slash normalisation LLMProviderResolver gives a system_llm_settings URL.
          if (baseUrl !== '') cfg.base_url = baseUrl.replace(/\/+$/, '');
          if (chatEndpoint !== '') cfg.chat_endpoint = chatEndpoint;
          console.error(`[ChatController] Using custom API key for provider: ${key}, user: ${userId}` + (baseUrl !== '' ? `, endpoint: ${baseUrl}` : ''));
        }

        // The prompt override is independent of the key.
        const prompt = row.system_prompt;
        if (typeof prompt === 'string' && prompt.trim() !== '') {
          cfg.system_prompt = prompt;
          console.error(`[ChatController] Using user system_prompt override for provider: ${key}, user: ${userId}`);
        }
      }

      for (const row of modelRows) {
        if (row.provider !== key) continue;
        if (!ownKey) {
          console.error(`[ChatController] Ignoring user model selection for ${key} (user ${userId} on package key); package default stands`);
          continue;
        }
        cfg.model = row.model;
        console.error(`[ChatController] Using custom model for provider: ${key} -> ${row.model}, user: ${userId}`);
      }
    } catch (e: any) {
      console.error('[ChatController] Error loading user API keys: ' + (e?.message ?? e));
    }
    return cfg;
  }
}
