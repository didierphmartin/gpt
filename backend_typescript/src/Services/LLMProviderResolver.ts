import { db } from '../db/pools';
import { ProviderConfig } from '../Contracts/types';

/**
 * Resolves a provider's runtime config from `system_llm_settings` (the source of truth since the
 * 2026-05 cutover). Mirrors LLMProviderResolver::applyDbSettings for the single-provider lookup
 * the /chat path needs.
 */
export class LLMProviderResolver {
  // Canonical request provider name → system_llm_settings.provider_key
  private static readonly ALIAS: Record<string, string> = {
    claude: 'claude',
    anthropic: 'claude',
    openai: 'openai',
    gemini: 'gemini',
    google: 'gemini',
    grok: 'grok',
    deepseek: 'deepseek',
    kimi: 'kimi',
    gamma4: 'gamma4',
  };

  static async getProviderConfig(provider: string): Promise<ProviderConfig | null> {
    const key = LLMProviderResolver.ALIAS[provider.toLowerCase()] ?? provider.toLowerCase();
    const row = await db
      .selectFrom('system_llm_settings')
      .selectAll()
      .where('provider_key', '=', key)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (!row) return null;

    return {
      provider_key: row.provider_key,
      api_key: row.api_key ?? '',
      model: row.model,
      base_url: (row.base_url ?? '').replace(/\/+$/, ''),
      chat_endpoint: row.chat_endpoint ?? '/v1/messages',
      api_format: row.api_format ?? 'openai',
      max_tokens: row.max_tokens ?? 4096,
      temperature: Number(row.temperature ?? 0.7),
      system_prompt: row.system_prompt,
    };
  }
}
