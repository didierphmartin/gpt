import { ChatOptions, ProviderConfig } from '../Contracts/types';
import { CompletionResponse, OpenAICompatibleProvider, ProviderError, guzzleHttpErrorMessage } from './OpenAICompatibleProvider';

/**
 * Mirrors src/Providers/DeepSeekProvider.php. V4 models (deepseek-v4-*, deepseek-flash) run in
 * thinking mode, sent explicitly as `thinking: {type: enabled}` without temperature; thinking is
 * disabled (temperature sent) when the call forces a tool, when the agent switch is 'off', or on a
 * skill turn unless the switch is 'on'. Thinking mode requires reasoning_content round-tripped:
 * streamed reasoning is kept on the assistant turn, replayed tool-call turns always carry the key
 * (empty when absent), and a pending client tool call reports it as assistant_reasoning.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  static readonly BASE_URL = 'https://api.deepseek.com';
  static readonly CHAT_ENDPOINT = '/chat/completions';
  protected readonly name = 'deepseek';
  private disableThinkingForThisCall = false;

  /** deepseek-v4-* ids and deepseek-flash (DeepSeek-V4.1-Flash) run in V4 thinking mode. */
  static isThinkingModel(model: string): boolean {
    return model.startsWith('deepseek-v4') || model.startsWith('deepseek-flash');
  }

  constructor(config: ProviderConfig) {
    super(config, { streaming: true });
  }

  protected progressPrefix(): string {
    return 'DeepSeek';
  }

  protected url(): string {
    const base = (this.config.base_url || DeepSeekProvider.BASE_URL).replace(/\/+$/, '');
    return base + (this.config.chat_endpoint || DeepSeekProvider.CHAT_ENDPOINT);
  }

  protected contextWindow(): number {
    return 128000; // deepseek-chat and deepseek-reasoner: 128K context
  }

  protected connectMessage(): string {
    return 'Connecting to DeepSeek API...';
  }

  protected beginCall(opts: ChatOptions): void {
    const tc = opts.tool_choice ?? null;
    const forced = tc !== null && tc !== 'auto' && tc !== 'none';
    const sw = opts.thinking ?? null;
    this.disableThinkingForThisCall = sw === 'off' || forced || (sw !== 'on' && !!opts.skill_metadata);
  }

  protected endCall(): void {
    this.disableThinkingForThisCall = false;
  }

  protected capturesReasoning(): boolean {
    return true;
  }

  protected clientToolCallExtra(assistantMessage: Record<string, any>): Record<string, any> {
    const r = assistantMessage.reasoning_content ?? '';
    return typeof r === 'string' && r !== '' ? { assistant_reasoning: r } : {};
  }

  protected pendingExtra(response: CompletionResponse): Record<string, any> {
    return { assistant_reasoning: response._pending_assistant_reasoning ?? '' };
  }

  protected extractTextResponse(response: CompletionResponse): string {
    const message = response?.choices?.[0]?.message ?? {};
    if (message.reasoning_content) {
      return message.content ? message.content : message.reasoning_content;
    }
    return message.content ?? '';
  }

  protected buildMessages(opts: ChatOptions, systemPrompt: string): any[] {
    const history = this.historyMessages(opts, (turn) => ({
      // Thinking mode 400s when a replayed tool-call turn has no reasoning_content key.
      reasoning_content: typeof turn.reasoning_content === 'string' ? turn.reasoning_content : '',
    }));
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    if (this.isToolResultContinuation(messages, opts, true)) return messages;
    messages.push(this.userTurn(opts, true));
    return messages;
  }

  protected buildPayload(messages: any[], tools: any[], streaming: boolean, toolChoice: string | Record<string, any>): Record<string, any> {
    const payload: Record<string, any> = { model: this.model, max_tokens: this.maxTokens, messages };
    if (DeepSeekProvider.isThinkingModel(this.model)) {
      payload.thinking = { type: this.disableThinkingForThisCall ? 'disabled' : 'enabled' };
      if (this.disableThinkingForThisCall) payload.temperature = this.temperature;
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
    console.error(`[DeepSeekProvider] HTTP ${status} response body: ` + body.slice(0, 1500));
    if (status === 429) throw ProviderError.rateLimited('deepseek');
    if (status === 401) throw ProviderError.authenticationFailed('deepseek');
    throw ProviderError.apiError('deepseek', guzzleHttpErrorMessage('POST', this.url(), status, reason, body), status);
  }
}
