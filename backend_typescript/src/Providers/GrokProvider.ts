import { ChatOptions, ProviderConfig } from '../Contracts/types';
import { OpenAICompatibleProvider, ProviderError, ToolLoopState } from './OpenAICompatibleProvider';

/**
 * Mirrors src/Providers/GrokProvider.php (xAI, OpenAI-compatible). Vendor endpoint unless the
 * provider row points it at a gateway; the request always carries max_tokens and a temperature
 * rounded to one decimal; tool schemas are cleaned for xAI's validator (convertToXAITools); HTTP
 * errors are read from the answer body (http_errors=false); a stream `error` frame throws; the tool
 * loop skips a third identical call, hints async results, and keeps forcing the caller's tool_choice
 * on continuations until a manager's complete_task marker switches it to 'auto'.
 */
export class GrokProvider extends OpenAICompatibleProvider {
  static readonly BASE_URL = 'https://api.x.ai';
  static readonly CHAT_ENDPOINT = '/v1/chat/completions';
  protected readonly name = 'grok';

  constructor(config: ProviderConfig) {
    super(config, { streaming: true });
  }

  protected progressPrefix(): string {
    return 'Grok';
  }

  protected url(): string {
    const base = (this.config.base_url || GrokProvider.BASE_URL).replace(/\/+$/, '');
    return base + (this.config.chat_endpoint || GrokProvider.CHAT_ENDPOINT);
  }

  protected contextWindow(): number {
    return 2000000; // grok-4-1-fast-reasoning: 2M context per xAI docs
  }

  protected connectMessage(): string {
    return 'Connecting to xAI API...';
  }

  protected dedupesToolCalls(): boolean {
    return true;
  }

  protected continuationToolChoice(state: ToolLoopState, workflowComplete: boolean): string | Record<string, any> {
    return workflowComplete ? 'auto' : state.toolChoice;
  }

  protected throwsOnStreamError(): boolean {
    return true;
  }

  protected buildMessages(opts: ChatOptions, systemPrompt: string): any[] {
    const messages = [{ role: 'system', content: systemPrompt }, ...this.historyMessages(opts)];
    if (this.isToolResultContinuation(messages, opts, true)) return messages;
    messages.push(this.userTurn(opts, true));
    return messages;
  }

  protected buildPayload(messages: any[], tools: any[], streaming: boolean, toolChoice: string | Record<string, any>): Record<string, any> {
    const payload: Record<string, any> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: Math.round(this.temperature * 10) / 10, // (float) number_format($t, 1)
      messages,
    };
    if (tools.length) {
      payload.tools = GrokProvider.convertToXAITools(tools);
      payload.tool_choice = toolChoice;
    }
    if (streaming) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }
    return payload;
  }

  protected httpError(status: number, _reason: string, body: string): never {
    let data: any = null;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
    let msg: any = data?.error?.message ?? data?.error ?? body;
    if (msg !== null && typeof msg === 'object') msg = 'Array';
    if (status === 429) throw ProviderError.rateLimited('grok');
    if (status === 401) throw ProviderError.authenticationFailed('grok');
    throw ProviderError.apiError('grok', `API error: ${msg}`, status);
  }

  /** convertToXAITools: OpenAI function tools with the schema cleaned for xAI's validator. */
  static convertToXAITools(claudeTools: any[]): any[] {
    return claudeTools.map((tool) => {
      const inputSchema = tool.input_schema ?? { type: 'object', properties: {} };
      const parameters: Record<string, any> = JSON.parse(JSON.stringify(inputSchema ?? null)) ?? {};
      delete parameters.$schema;
      if (!hasEntries(parameters.required)) delete parameters.required;
      if (parameters.properties && typeof parameters.properties === 'object') {
        for (const [propName, propSchema] of Object.entries<any>(parameters.properties)) {
          if (!hasEntries(propSchema) || typeof propSchema !== 'object' || propSchema.type === undefined || propSchema.type === null) {
            parameters.properties[propName] = {
              type: 'string',
              description: propSchema && typeof propSchema === 'object' ? propSchema.description ?? '' : '',
            };
            continue;
          }
          const prop = parameters.properties[propName];
          delete prop.default;
          if (propSchema.type !== 'array') delete prop.items;
          if (propSchema.enum !== undefined && propSchema.enum !== null && propSchema.type === 'string') {
            prop.enum = Object.values(propSchema.enum).map((v: any) => (v === true ? '1' : v === false || v === null ? '' : String(v)));
          }
          if (propSchema.enum !== undefined && propSchema.enum !== null && ['integer', 'number'].includes(propSchema.type)) {
            prop.enum = Object.values(propSchema.enum).map((v: any) => (isNumericValue(v) ? Math.trunc(Number(v)) : v));
          }
          // xAI rejects string enums containing '/': drop the constraint (the description lists them).
          if (Array.isArray(prop.enum) && prop.enum.some((v: any) => typeof v === 'string' && v.includes('/'))) {
            delete prop.enum;
          }
        }
      }
      if (!hasEntries(parameters.properties)) parameters.properties = {};
      return { type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters } };
    });
  }
}

/** PHP !empty() for an array-ish value. */
function hasEntries(v: any): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === 0 || v === '0') return false;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** PHP is_numeric(). */
function isNumericValue(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}
