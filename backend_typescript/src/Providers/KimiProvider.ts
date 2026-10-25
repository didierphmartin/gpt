import { ChatOptions, ProviderConfig } from '../Contracts/types';
import { OpenAICompatibleProvider, ProviderError, guzzleHttpErrorMessage } from './OpenAICompatibleProvider';

/**
 * Mirrors src/Providers/KimiProvider.php (Moonshot, OpenAI-compatible). K2 models get the sampling
 * values the API requires (non-thinking: thinking disabled, temperature 0.6, top_p 0.95; the
 * agent's thinking switch 'on' enables thinking at temperature 1.0); K3 models get temperature 1.0.
 * The tool loop skips a third identical call and hints async results; continuations use 'auto'.
 * A failed request reports the API's own error message.
 */
export class KimiProvider extends OpenAICompatibleProvider {
  static readonly BASE_URL = 'https://api.moonshot.ai';
  static readonly CHAT_ENDPOINT = '/v1/chat/completions';
  protected readonly name = 'kimi';
  private thinkingOverride: 'on' | 'off' | null = null;

  constructor(config: ProviderConfig) {
    super(config, { streaming: true });
  }

  protected progressPrefix(): string {
    return 'Kimi';
  }

  protected url(): string {
    const base = (this.config.base_url || KimiProvider.BASE_URL).replace(/\/+$/, '');
    return base + (this.config.chat_endpoint || KimiProvider.CHAT_ENDPOINT);
  }

  protected contextWindow(): number {
    return 256000; // kimi-k2-turbo-preview: 256K context per Moonshot docs
  }

  protected connectMessage(): string {
    return 'Connecting to Kimi API...';
  }

  protected beginCall(opts: ChatOptions): void {
    const t = opts.thinking;
    this.thinkingOverride = t === 'on' || t === 'off' ? t : null;
  }

  protected dedupesToolCalls(): boolean {
    return true;
  }

  protected buildMessages(opts: ChatOptions, systemPrompt: string): any[] {
    const messages = [{ role: 'system', content: systemPrompt }, ...this.historyMessages(opts)];
    if (this.isToolResultContinuation(messages, opts, true)) return messages;
    messages.push(this.userTurn(opts, true));
    return messages;
  }

  protected buildPayload(messages: any[], tools: any[], streaming: boolean, toolChoice: string | Record<string, any>): Record<string, any> {
    const payload: Record<string, any> = { model: this.model, max_tokens: this.maxTokens, messages };
    if (this.model.startsWith('kimi-k2')) {
      if (this.thinkingOverride === 'on') {
        payload.thinking = { type: 'enabled' };
        payload.temperature = 1.0;
      } else {
        payload.thinking = { type: 'disabled' };
        payload.temperature = 0.6;
        payload.top_p = 0.95;
      }
    } else if (this.model.startsWith('kimi-k3')) {
      payload.temperature = 1.0;
    } else {
      payload.temperature = this.temperature;
    }
    if (tools.length) {
      payload.tools = this.convertToOpenAITools(tools);
      payload.tool_choice = toolChoice;
    }
    if (streaming) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }
    return payload;
  }

  protected httpError(status: number, reason: string, body: string): never {
    if (status === 429) throw ProviderError.rateLimited('kimi');
    if (status === 401) throw ProviderError.authenticationFailed('kimi');
    let detail = guzzleHttpErrorMessage('POST', this.url(), status, reason, body);
    if (body) {
      try {
        const j = JSON.parse(body);
        if (j?.error?.message !== undefined && j?.error?.message !== null) detail = j.error.message;
        else if (j?.message !== undefined && j?.message !== null) detail = j.message;
      } catch {
        /* not JSON */
      }
    }
    throw ProviderError.apiError('kimi', detail, status);
  }
}
