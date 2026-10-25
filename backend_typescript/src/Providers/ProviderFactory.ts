import { LLMProvider } from '../Contracts/LLMProvider';
import { ProviderConfig } from '../Contracts/types';
import { ClaudeProvider } from './ClaudeProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { GeminiProvider } from './GeminiProvider';
import { GrokProvider } from './GrokProvider';
import { KimiProvider } from './KimiProvider';
import { DeepSeekProvider } from './DeepSeekProvider';
import { CustomProvider } from './CustomProvider';

/**
 * Constructs the provider class for a resolved config, as PHP AIPortfolioAssistant::makeProvider
 * does: a dedicated class per provider key (DEDICATED_PROVIDERS plus the anthropic/google aliases
 * of ProviderRequestFactory), else the generic OpenAI-compatible CustomProvider — which PHP only
 * registers for a row with a base_url, so a row without one is "not found".
 */
export class ProviderFactory {
  private static readonly DEDICATED: Record<string, new (config: ProviderConfig) => LLMProvider> = {
    claude: ClaudeProvider,
    anthropic: ClaudeProvider,
    deepseek: DeepSeekProvider,
    gemini: GeminiProvider,
    google: GeminiProvider,
    grok: GrokProvider,
    kimi: KimiProvider,
    openai: OpenAIProvider,
  };

  static create(config: ProviderConfig): LLMProvider {
    const key = (config.provider_key ?? '').toLowerCase();
    const Dedicated = ProviderFactory.DEDICATED[key];
    if (Dedicated) return new Dedicated(config);
    if (!(config.base_url ?? '').trim()) throw new Error(`Provider '${config.provider_key}' not found`);
    return new CustomProvider(config);
  }
}
