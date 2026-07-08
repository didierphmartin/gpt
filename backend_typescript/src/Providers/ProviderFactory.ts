import { LLMProvider } from '../Contracts/LLMProvider';
import { ProviderConfig } from '../Contracts/types';
import { ClaudeProvider } from './ClaudeProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { GeminiProvider } from './GeminiProvider';

/**
 * Constructs the right provider class for a resolved config (mirrors PHP ProviderRequestFactory /
 * LLMManager::getProvider). Throws for not-yet-ported api_formats.
 */
export class ProviderFactory {
  static create(config: ProviderConfig): LLMProvider {
    switch (config.api_format) {
      case 'anthropic':
        return new ClaudeProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      case 'openai':
        return new OpenAIProvider(config);
      default:
        throw new Error(`Provider '${config.provider_key}' is not yet implemented in the TypeScript backend`);
    }
  }
}
