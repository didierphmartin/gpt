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

  // PHP-parity endpoint defaults for OpenAI-compatible providers whose dedicated PHP provider
  // class HARDCODES its base URL / chat endpoint (e.g. GrokProvider: BASE_URL='https://api.x.ai',
  // CHAT_ENDPOINT='/v1/chat/completions'). Because PHP never reads those columns, the
  // `system_llm_settings` row typically leaves them blank — which the TS OpenAIProvider CANNOT
  // recover from (it fetches `base_url + chat_endpoint`, yielding a broken relative URL). These
  // defaults fill the gap AND pin api_format to 'openai' so the ProviderFactory routes them to
  // OpenAIProvider instead of throwing "not yet implemented". A non-empty DB value always wins.
  // max_tokens matters for REASONING models (e.g. grok-*-reasoning): the reasoning phase draws from
  // the same budget as the visible answer, so too small a cap exhausts on reasoning and returns an
  // EMPTY content field ("no usable content"). PHP's GrokProvider defaults to 16384 for exactly this
  // reason; the generic TS default of 4096 is too small for Grok's reasoning models. Mirror PHP.
  private static readonly OPENAI_COMPAT_DEFAULTS: Record<string, { base_url: string; chat_endpoint: string; max_tokens?: number }> = {
    grok: { base_url: 'https://api.x.ai', chat_endpoint: '/v1/chat/completions', max_tokens: 16384 },
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

    // Apply PHP-parity endpoint defaults when the DB row leaves base_url/chat_endpoint blank
    // (see OPENAI_COMPAT_DEFAULTS). DB values, when present, always take precedence.
    const defaults = LLMProviderResolver.OPENAI_COMPAT_DEFAULTS[key];
    const rowBaseUrl = (row.base_url ?? '').trim();
    const rowChatEndpoint = (row.chat_endpoint ?? '').trim();
    const base_url = (rowBaseUrl || defaults?.base_url || '').replace(/\/+$/, '');
    const chat_endpoint = rowChatEndpoint || defaults?.chat_endpoint || '/v1/messages';
    // For providers with parity defaults (OpenAI-compatible), pin the format so the factory
    // routes to OpenAIProvider even if the row's api_format is blank or a legacy name.
    const api_format = defaults ? 'openai' : (row.api_format ?? 'openai');

    return {
      provider_key: row.provider_key,
      api_key: row.api_key ?? '',
      model: row.model,
      base_url,
      chat_endpoint,
      api_format,
      max_tokens: row.max_tokens ?? defaults?.max_tokens ?? 4096,
      temperature: Number(row.temperature ?? 0.7),
      system_prompt: row.system_prompt,
    };
  }
}
