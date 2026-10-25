import { ChatOptions, ProviderConfig } from '../Contracts/types';
import { CompletionResponse, OpenAICompatibleProvider, ProviderError, guzzleHttpErrorMessage } from './OpenAICompatibleProvider';
import { DeepSeekProvider } from './DeepSeekProvider';

/**
 * Mirrors src/Providers/CustomProvider.php: the generic OpenAI-compatible handler for every
 * system_llm_settings provider without a dedicated class (glm, gamma4, any future row). It needs a
 * base_url (the factory refuses a row without one, as PHP never registers it), sends tool_choice
 * 'auto' whenever tools go out, streams only when the row enables streaming, keeps streamed
 * reasoning_content for continuations, and caps small self-hosted endpoints with a short timeout.
 * GLM runs with thinking disabled unless the agent switch is 'on'.
 */
export class CustomProvider extends OpenAICompatibleProvider {
  /** Fallback total-request timeout (seconds). */
  static readonly DEFAULT_TIMEOUT = 600;
  /** Per-provider total-timeout overrides (seconds) for small/flaky self-hosted endpoints. */
  static readonly PROVIDER_TIMEOUTS: Record<string, number> = { gamma4: 90 };
  protected readonly name: string;
  private readonly displayName: string;
  private readonly baseUrl: string;
  private readonly chatEndpoint: string;
  private readonly supportsTools: boolean;
  private thinkingOverride: 'on' | 'off' | null = null;

  constructor(config: ProviderConfig) {
    super(config, { streaming: false });
    this.name = config.provider_key;
    this.displayName = config.display_name || config.provider_key.charAt(0).toUpperCase() + config.provider_key.slice(1);
    this.baseUrl = (config.base_url ?? '').replace(/\/+$/, '');
    this.chatEndpoint = config.chat_endpoint || '/chat/completions';
    this.supportsTools = config.supports_tools ?? true;
  }

  isAvailable(): boolean {
    return this.baseUrl !== '';
  }

  protected progressPrefix(): string {
    return this.displayName;
  }

  protected url(): string {
    return this.baseUrl + this.chatEndpoint;
  }

  protected timeoutMs(): number {
    return (CustomProvider.PROVIDER_TIMEOUTS[this.name] ?? CustomProvider.DEFAULT_TIMEOUT) * 1000;
  }

  protected requestHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey !== '') h.Authorization = 'Bearer ' + this.apiKey;
    return h;
  }

  protected toolsSupported(): boolean {
    return this.supportsTools;
  }

  protected initialToolChoice(): string {
    return 'auto';
  }

  protected prepareMessage(): string {
    return `Preparing ${this.displayName} request...`;
  }

  protected connectMessage(): string {
    return `Connecting to ${this.displayName} API...`;
  }

  protected afterToolsMessage(): string {
    return `Processing ${this.displayName} response...`;
  }

  protected beginCall(opts: ChatOptions): void {
    const t = opts.thinking;
    this.thinkingOverride = t === 'on' || t === 'off' ? t : null;
  }

  protected capturesReasoning(): boolean {
    return true;
  }

  protected extractTextResponse(response: CompletionResponse): string {
    const message = response?.choices?.[0]?.message ?? {};
    if (message.reasoning_content) {
      return message.content ? message.content : message.reasoning_content;
    }
    return message.content ?? '';
  }

  protected buildMessages(opts: ChatOptions, systemPrompt: string): any[] {
    const messages = [{ role: 'system', content: systemPrompt }, ...this.historyMessages(opts)];
    if (this.isToolResultContinuation(messages, opts, false)) return messages;
    messages.push({ role: 'user', content: opts.message ?? '' });
    return messages;
  }

  protected buildPayload(messages: any[], tools: any[], streaming: boolean): Record<string, any> {
    const isDeepSeekV4 = this.name === 'deepseek' && DeepSeekProvider.isThinkingModel(this.model);
    const payload: Record<string, any> = { model: this.model, max_tokens: this.maxTokens, messages };
    if (isDeepSeekV4) payload.thinking = { type: this.thinkingOverride === 'off' ? 'disabled' : 'enabled' };
    else payload.temperature = this.temperature;
    // GLM defaults to heavy reasoning; answer directly unless the agent switch turns thinking on.
    if (this.name === 'glm') payload.thinking = { type: this.thinkingOverride === 'on' ? 'enabled' : 'disabled' };
    if (tools.length && this.supportsTools) {
      payload.tools = this.convertToOpenAITools(tools);
      payload.tool_choice = 'auto';
    }
    if (streaming) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }
    return payload;
  }

  protected httpError(status: number, reason: string, body: string): never {
    if (status === 429) throw ProviderError.rateLimited(this.name);
    if (status === 401) throw ProviderError.authenticationFailed(this.name);
    throw ProviderError.apiError(this.name, guzzleHttpErrorMessage('POST', this.url(), status, reason, body), status);
  }
}
