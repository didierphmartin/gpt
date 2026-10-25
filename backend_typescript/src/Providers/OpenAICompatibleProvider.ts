import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult, ProviderConfig, ToolCall } from '../Contracts/types';
import { SSEStream } from '../Services/SseStream';
import { phpJsonEncode } from '../Support/PhpJson';

/** An OpenAI-shaped chat completion response (PHP keeps the decoded array). */
export type CompletionResponse = Record<string, any>;

/** What the tool loop needs to know about the current turn. */
export interface ToolLoopState {
  messages: any[];
  tools: any[];
  userId: number | null;
  inputTokens: number;
  outputTokens: number;
  functionCallCount: number;
  functionsCalled: string[];
  mcpToolsCalled: string[];
  streaming: boolean;
  toolChoice: string | Record<string, any>;
  executedTools: Record<string, number>;
}

/** Error carrying the provider and HTTP status, like PHP's ProviderException. */
export class ProviderError extends Error {
  constructor(message: string, readonly code: number, readonly provider: string) {
    super(message);
  }

  /** ProviderException::rateLimited (no Retry-After is ever passed). */
  static rateLimited(provider: string): ProviderError {
    return new ProviderError(`Rate limited by ${provider}. `, 429, provider);
  }

  /** ProviderException::authenticationFailed. */
  static authenticationFailed(provider: string): ProviderError {
    return new ProviderError(`Authentication failed for ${provider}. Please check your API key.`, 401, provider);
  }

  /** ProviderException::apiError. */
  static apiError(provider: string, message: string, statusCode = 500): ProviderError {
    return new ProviderError(`${provider} API error: ${message}`, statusCode, provider);
  }
}

/** Guzzle's RequestException message for a 4xx/5xx answer (its BodySummarizer truncates at 120). */
export function guzzleHttpErrorMessage(method: string, url: string, status: number, reason: string, body: string): string {
  const label = status >= 500 ? 'Server error' : 'Client error';
  const phrase = reason || http.STATUS_CODES[status] || '';
  let msg = `${label}: \`${method} ${url}\` resulted in a \`${status} ${phrase}\` response`;
  if (body !== '') msg += ':\n' + (Buffer.byteLength(body) > 120 ? Buffer.from(body).subarray(0, 120).toString() + ' (truncated...)' : body);
  return msg;
}

const PROMPT_FILE = path.resolve(__dirname, '../../resources/prompts/portfolio_assistant.txt');

/** Names of the statically-known client-side tools (ClientSideToolsTrait::getClientSideToolNames). */
export const CLIENT_SIDE_TOOL_NAMES = ['run_skill_script', 'discover_skill', 'Task', 'route_to'];

/**
 * The shared shape of PHP's OpenAI-compatible provider classes — GrokProvider, KimiProvider,
 * DeepSeekProvider and CustomProvider are near-copies of one another (chat → makeRequest →
 * handleStreamingResponse → handleToolCallsRecursive). This class holds that common code; each
 * subclass supplies what its PHP class does differently (payload, messages, error handling, the
 * tool loop's dedupe / async hint / continuation tool_choice, text extraction).
 *
 * streamChat mirrors PHP streamChat(): with streaming disabled for the provider it runs the
 * non-streaming request (progress still reported) and emits the whole text as one chunk.
 */
export abstract class OpenAICompatibleProvider extends LLMProvider {
  /** Lower-case provider name (PHP getName()). */
  protected abstract readonly name: string;
  protected readonly maxRecursionDepth = 10;

  private perRequestClientSideToolNames: string[] = [];
  protected sse: SSEStream | null = null;

  // Resolved settings (the PHP constructor's fields).
  protected model: string;
  protected maxTokens: number;
  protected temperature: number;
  protected apiKey: string;
  protected streamingEnabled: boolean;

  constructor(config: ProviderConfig, defaults: { streaming: boolean }) {
    super(config);
    this.model = config.model;
    this.maxTokens = config.max_tokens;
    this.temperature = config.temperature;
    this.apiKey = config.api_key ?? '';
    this.streamingEnabled = config.streaming ?? defaults.streaming;
  }

  // ---------------------------------------------------------------- hooks

  /** The prefix sendProgress puts before every message. */
  protected abstract progressPrefix(): string;
  /** Full request URL (base_url + chat endpoint). */
  protected abstract url(): string;
  /** Total request timeout in ms. */
  protected timeoutMs(): number {
    return 600_000;
  }
  /** PHP isAvailable(). */
  isAvailable(): boolean {
    return this.apiKey !== '';
  }
  /** Context window for the context_high warning (0 = disabled, the trait default). */
  protected contextWindow(): number {
    return 0;
  }
  /** Request headers. */
  protected requestHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey };
  }
  /** Called at the start of chat() with the options (thinking switches etc.). */
  protected beginCall(_opts: ChatOptions): void {}
  /** Called when chat() leaves (PHP finally blocks). */
  protected endCall(): void {}
  /** Whether chat() advertises the executor's tools / runs the tool loop (CustomProvider: supports_tools). */
  protected toolsSupported(): boolean {
    return true;
  }
  /** The initial request's tool_choice. */
  protected initialToolChoice(opts: ChatOptions): string | Record<string, any> {
    return opts.tool_choice ?? 'auto';
  }
  /** Progress label of makeRequest. */
  protected abstract connectMessage(): string;
  /** Progress label at the start of chat(). */
  protected prepareMessage(): string {
    return 'Preparing request...';
  }
  /** Progress label after a tool batch, before the continuation request. */
  protected afterToolsMessage(): string {
    return 'Processing response...';
  }
  /** The JSON body of one request. */
  protected abstract buildPayload(messages: any[], tools: any[], streaming: boolean, toolChoice: string | Record<string, any>): Record<string, any>;
  /** OpenAI messages from the system prompt, history and the new message. */
  protected abstract buildMessages(opts: ChatOptions, systemPrompt: string): any[];
  /** Tool loop flavour: duplicate-call skipping + the async-status hint (Grok, Kimi). */
  protected dedupesToolCalls(): boolean {
    return false;
  }
  /** Tool loop flavour: function_call_count bumped for every call up front (DeepSeek, Custom) or as Grok/Kimi count. */
  protected countsBeforeChecks(): boolean {
    return !this.dedupesToolCalls();
  }
  /** The continuation request's tool_choice. */
  protected continuationToolChoice(_state: ToolLoopState, _workflowComplete: boolean): string | Record<string, any> {
    return 'auto';
  }
  /** Extra fields for the client_tool_call event (DeepSeek: the turn's reasoning). */
  protected clientToolCallExtra(_assistantMessage: Record<string, any>): Record<string, any> {
    return {};
  }
  /** The final text of a response. */
  protected extractTextResponse(response: CompletionResponse): string {
    return response?.choices?.[0]?.message?.content ?? '';
  }
  /** Throws the provider's error for an HTTP failure (status >= 400). */
  protected abstract httpError(status: number, reason: string, body: string, payload: Record<string, any>): never;
  /** Whether a stream `error` frame throws (GrokProvider). */
  protected throwsOnStreamError(): boolean {
    return false;
  }
  /** Whether the stream accumulates delta.reasoning_content (DeepSeek, Custom). */
  protected capturesReasoning(): boolean {
    return false;
  }

  // ---------------------------------------------------------------- shared helpers

  protected sendProgress(message: string): void {
    this.sse?.send('progress', `${this.progressPrefix()}: ${message}`);
  }

  protected setPerRequestClientSideToolNames(names: unknown[]): void {
    this.perRequestClientSideToolNames = names.filter((n): n is string => typeof n === 'string' && n !== '');
  }

  protected isClientSideTool(name: string): boolean {
    return CLIENT_SIDE_TOOL_NAMES.includes(name) || this.perRequestClientSideToolNames.includes(name);
  }

  /** ProviderRequestBuilderTrait::buildSystemPrompt with each class's getDefaultSystemPrompt. */
  protected buildSystemPrompt(opts: ChatOptions): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const persona = opts.system_prompt && opts.system_prompt.trim() !== '' ? opts.system_prompt : this.defaultSystemPrompt();
    let systemPrompt = `Current date: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${days[d.getDay()]}).` + '\n\n' + persona.replace(/^\s+/, '');
    if (opts.skill_content) systemPrompt = systemPrompt.replace(/\s+$/, '') + '\n\n' + opts.skill_content;
    return systemPrompt;
  }

  /** getDefaultSystemPrompt(): the provider row's prompt, else resources/prompts/portfolio_assistant.txt, else the fallback. */
  protected defaultSystemPrompt(): string {
    if (this.config.system_prompt) return this.config.system_prompt;
    try {
      return fs.readFileSync(PROMPT_FILE, 'utf8');
    } catch {
      return this.fallbackSystemPrompt();
    }
  }

  protected fallbackSystemPrompt(): string {
    return 'You are a helpful AI assistant with access to tools and functions. Use them when appropriate to help the user.';
  }

  /** extractTextFromContent: a string, or the text/content of each block joined by newlines. */
  protected extractTextFromContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) || (content && typeof content === 'object')) {
      const parts: string[] = [];
      for (const block of Object.values(content)) {
        if (block && typeof block === 'object' && (block as any).text !== undefined && (block as any).text !== null) parts.push((block as any).text);
        else if (block && typeof block === 'object' && (block as any).content !== undefined && (block as any).content !== null) parts.push((block as any).content);
        else if (typeof block === 'string') parts.push(block);
      }
      return parts.join('\n');
    }
    return '';
  }

  /**
   * The history half of buildMessages shared by all four classes: tool results and assistant
   * tool_call turns round-trip in OpenAI wire shape, other turns keep their non-empty text.
   */
  protected historyMessages(opts: ChatOptions, assistantExtra?: (turn: any) => Record<string, any>): any[] {
    const out: any[] = [];
    for (const msg of opts.conversation_history ?? []) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role ?? 'user';
      if (role === 'tool' && phpTruthy(msg.tool_call_id)) {
        const entry: any = {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : phpJsonEncode(msg.content ?? null),
        };
        if (phpTruthy(msg.name) && typeof msg.name === 'string') entry.name = msg.name;
        out.push(entry);
        continue;
      }
      if (role === 'assistant' && phpTruthy(msg.tool_calls)) {
        const text = this.extractTextFromContent(msg.content ?? '');
        const toolCalls = Object.values(msg.tool_calls as Record<string, any>).map((tc: any) => {
          if (tc && typeof tc === 'object' && tc.function !== undefined && tc.function !== null) return tc;
          if (tc && typeof tc === 'object' && tc.name !== undefined && tc.name !== null) {
            return {
              id: tc.id ?? '',
              type: 'function',
              function: { name: tc.name, arguments: tc.input === undefined || tc.input === null ? '{}' : phpJsonEncode(tc.input) },
            };
          }
          return tc;
        });
        out.push({ role: 'assistant', content: text !== '' ? text : null, ...(assistantExtra ? assistantExtra(msg) : {}), tool_calls: toolCalls });
        continue;
      }
      const text = this.extractTextFromContent(msg.content ?? '');
      if (phpTruthy(text)) out.push({ role, content: text });
    }
    return out;
  }

  /** True when the history ends on a tool result and there is no new message (B3 continuation). */
  protected isToolResultContinuation(messages: any[], opts: ChatOptions, withImages: boolean): boolean {
    const imgs = withImages ? opts.image_attachments ?? [] : [];
    return (opts.message ?? '').trim() === '' && imgs.length === 0 && messages.length > 0 && (messages[messages.length - 1].role ?? '') === 'tool';
  }

  /** The new user turn, as an image_url content array when images are attached (Grok, Kimi, DeepSeek). */
  protected userTurn(opts: ChatOptions, withImages: boolean): any {
    const imgs = withImages ? opts.image_attachments ?? [] : [];
    if (imgs.length) {
      const parts: any[] = [{ type: 'text', text: opts.message ?? '' }];
      for (const img of imgs) parts.push({ type: 'image_url', image_url: { url: 'data:' + img.mime_type + ';base64,' + img.data } });
      return { role: 'user', content: parts };
    }
    return { role: 'user', content: opts.message ?? '' };
  }

  /** convertToOpenAITools (Kimi, DeepSeek, Custom): input_schema → parameters, PHP's [] default. */
  protected convertToOpenAITools(claudeTools: any[]): any[] {
    return claudeTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: [] },
      },
    }));
  }

  /** Executor tool definitions + the per-request client tools. */
  private assembleTools(opts: ChatOptions): any[] {
    const tools: any[] = this.toolsSupported() && this.functionExecutor ? [...this.functionExecutor.getToolDefinitions()] : [];
    if (Array.isArray(opts.client_tool_names) && opts.client_tool_names.length) this.setPerRequestClientSideToolNames(opts.client_tool_names);
    if (Array.isArray(opts.client_tools) && opts.client_tools.length) {
      for (const ct of opts.client_tools) {
        tools.push({
          name: ct.name,
          description: ct.description ?? '',
          input_schema: ct.input_schema ?? { type: 'object', properties: {}, required: [] },
        });
      }
    }
    return tools;
  }

  protected emitUsageWarningIfTruncated(finishReason: string, outputTokens: number): void {
    if (!['max_tokens', 'length', 'MAX_TOKENS'].includes(finishReason)) return;
    if (outputTokens <= 0) return;
    this.sse?.send('usage_warning', {
      reason: 'output_truncated', provider: this.name, model: this.model, max_tokens: this.maxTokens, output_tokens: outputTokens,
    });
  }

  protected emitContextWarningIfHigh(inputTokens: number): void {
    const window = this.contextWindow();
    if (window <= 0) return;
    const percent = Math.round((inputTokens / window) * 100);
    if (percent < 75) return;
    this.sse?.send('usage_warning', {
      reason: 'context_high', provider: this.name, model: this.model, input_tokens: inputTokens, context_window: window, percent,
    });
  }

  // ---------------------------------------------------------------- request

  /** One request: the JSON response, or the stream folded into one (handleStreamingResponse). */
  protected async makeRequest(messages: any[], tools: any[], streaming: boolean, toolChoice: string | Record<string, any>): Promise<CompletionResponse> {
    this.sendProgress(this.connectMessage());
    const payload = this.buildPayload(messages, tools, streaming, toolChoice);
    let res: Response;
    try {
      res = await fetch(this.url(), {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (e: any) {
      // A transport failure (Guzzle ConnectException: no status).
      throw ProviderError.apiError(this.name, e?.cause?.message ?? e?.message ?? 'Request failed', 0);
    }
    if (res.status >= 400) {
      const body = await res.text().catch(() => '');
      this.httpError(res.status, res.statusText, body, payload);
    }
    if (streaming) return this.handleStreamingResponse(res);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  /** Folds an SSE stream into one completion, streaming content as `chunk` events. */
  protected async handleStreamingResponse(res: Response): Promise<CompletionResponse> {
    let buffer = '';
    let fullText = '';
    let reasoning = '';
    let usageData: any = null;
    const toolCalls: Record<string, any> = {};
    const order: string[] = [];
    let finishReason = 'stop';

    this.sendProgress('Thinking...');

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    outer: while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let pos;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        if (line.trim() === '' || line.trim() === '0') continue;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break outer;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (!phpTruthy(json) || typeof json !== 'object') continue;

        if (this.throwsOnStreamError() && json.error !== undefined && json.error !== null) {
          const msg = json.error?.message ?? json.error ?? 'Unknown stream error';
          throw ProviderError.apiError(this.name, `Stream error: ${typeof msg === 'object' ? 'Array' : msg}`, 500);
        }

        const delta = json.choices?.[0]?.delta ?? {};
        const finishFromChunk = json.choices?.[0]?.finish_reason ?? null;
        if (finishFromChunk) {
          finishReason = finishFromChunk;
          this.emitUsageWarningIfTruncated(finishReason, usageData?.completion_tokens ?? 0);
        }
        if (this.capturesReasoning() && delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          reasoning += delta.reasoning_content;
        }
        const content = delta.content ?? '';
        if (content !== '') {
          fullText += content;
          this.sse?.send('chunk', content);
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          for (const tcd of Object.values(delta.tool_calls as Record<string, any>)) {
            const index = String(tcd.index ?? 0);
            if (!toolCalls[index]) {
              toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              order.push(index);
            }
            if (tcd.id !== undefined && tcd.id !== null) toolCalls[index].id = tcd.id;
            if (tcd.function?.name !== undefined && tcd.function?.name !== null) toolCalls[index].function.name = tcd.function.name;
            if (tcd.function?.arguments !== undefined && tcd.function?.arguments !== null) toolCalls[index].function.arguments += tcd.function.arguments;
          }
        }
        if (json.usage !== undefined && json.usage !== null) {
          usageData = json.usage;
          this.emitContextWarningIfHigh(usageData.prompt_tokens ?? 0);
        }
      }
      if (this.sse?.isAborted) throw new Error('CLIENT_ABORTED');
    }

    const message: Record<string, any> = { role: 'assistant', content: fullText };
    if (reasoning !== '') message.reasoning_content = reasoning;
    // PHP array_values: tool calls in index order of first appearance.
    if (order.length) message.tool_calls = order.map((i) => toolCalls[i]);
    return {
      choices: [{ message, finish_reason: finishReason }],
      usage: usageData ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // ---------------------------------------------------------------- tool loop

  private hasToolCalls(response: CompletionResponse): boolean {
    return phpTruthy(response?.choices?.[0]?.message?.tool_calls);
  }

  private async executeFunction(name: string, params: any, userId: number | null): Promise<any> {
    if (!this.functionExecutor) return { error: 'No function executor configured' };
    try {
      const result = await this.functionExecutor.execute(name, params, userId);
      if (result && typeof result === 'object' && result._mcp_ui !== undefined && result._mcp_ui !== null && this.sse) {
        this.sse.send('mcp_ui', { tool_name: name, ui_info: result._mcp_ui });
      }
      return result;
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
  }

  private static decodeArgs(raw: any): any {
    if (typeof raw !== 'string') return raw ?? [];
    try {
      const v = JSON.parse(raw);
      return v === null ? [] : v;
    } catch {
      return [];
    }
  }

  /** handleToolCallsRecursive, unrolled (each round re-checks the depth cap first). */
  private async handleToolCalls(response: CompletionResponse, state: ToolLoopState): Promise<CompletionResponse> {
    for (let depth = 0; ; depth++) {
      if (depth >= this.maxRecursionDepth) return response;
      const assistantMessage: Record<string, any> = response?.choices?.[0]?.message ?? {};
      const toolCalls: any[] = phpTruthy(assistantMessage.tool_calls) ? Object.values(assistantMessage.tool_calls) : [];
      if (!toolCalls.length) return response;

      const clientCalls = toolCalls.filter((tc) => this.isClientSideTool(tc?.function?.name ?? ''));
      const serverCalls = toolCalls.filter((tc) => !this.isClientSideTool(tc?.function?.name ?? ''));
      if (clientCalls.length && !serverCalls.length) {
        const assistantText = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
        const normalized: ToolCall[] = clientCalls.map((tc) => {
          const args = tc.function?.arguments ?? '{}';
          return { id: tc.id, name: tc.function?.name ?? '', input: typeof args === 'string' ? OpenAICompatibleProvider.decodeArgs(args) : args ?? [] };
        });
        const extra = this.clientToolCallExtra(assistantMessage);
        this.sse?.send('client_tool_call', { ...extra, assistant_text: assistantText, tool_calls: normalized });
        for (const tc of clientCalls) {
          state.functionCallCount++;
          state.functionsCalled.push(tc.function?.name ?? '');
        }
        return {
          ...response,
          _pending_client_tool_call: true,
          _pending_tool_calls: normalized,
          _pending_assistant_text: assistantText,
          _pending_assistant_reasoning: String(extra.assistant_reasoning ?? ''),
        };
      }

      state.messages.push(assistantMessage);
      let workflowComplete = false;

      for (const toolCall of toolCalls) {
        const functionName: string = toolCall.function?.name;
        const args = OpenAICompatibleProvider.decodeArgs(toolCall.function?.arguments);
        if (this.countsBeforeChecks()) state.functionCallCount++;

        if (this.isClientSideTool(functionName)) {
          state.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: phpJsonEncode({ error: 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.' }),
          });
          if (!this.countsBeforeChecks()) state.functionCallCount++;
          state.functionsCalled.push(functionName);
          continue;
        }

        if (this.dedupesToolCalls()) {
          const signature = functionName + ':' + crypto.createHash('md5').update(phpJsonEncode(args)).digest('hex');
          const seen = state.executedTools[signature] ?? 0;
          if (seen >= 2) {
            state.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: phpJsonEncode({
                status: 'skipped',
                message: 'This tool has already been called with the same arguments. The operation is in progress - please wait for completion instead of calling again.',
              }),
            });
            continue;
          }
          state.executedTools[signature] = seen + 1;
          state.functionCallCount++;
        }

        state.functionsCalled.push(functionName);
        if (this.functionExecutor && this.functionExecutor.isMCPTool(functionName)) state.mcpToolsCalled.push(functionName);

        this.sendProgress(`Executing function: ${functionName}`);
        let result = await this.executeFunction(functionName, args, state.userId);

        let content: string;
        if (this.dedupesToolCalls() && result !== null && typeof result === 'object') {
          const status = result.structuredContent?.status ?? result.status ?? null;
          if (status === 'generating' || status === 'in_progress' || status === 'pending') {
            result = { ...result, _hint: 'This is an async operation. DO NOT call this tool again - the UI will automatically show progress and results.' };
          }
          if ((result.marker ?? '') === '___WORKFLOW_COMPLETE___') workflowComplete = true;
          content = phpJsonEncode(result);
        } else {
          content = typeof result === 'string' ? result : phpJsonEncode(result);
        }
        state.messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
      }

      this.sendProgress(this.afterToolsMessage());
      const continuation = await this.makeRequest(state.messages, state.tools, state.streaming, this.continuationToolChoice(state, workflowComplete));
      state.inputTokens += continuation?.usage?.prompt_tokens ?? 0;
      state.outputTokens += continuation?.usage?.completion_tokens ?? 0;
      if (!this.hasToolCalls(continuation)) return continuation;
      response = continuation;
    }
  }

  // ---------------------------------------------------------------- entry points

  private async run(opts: ChatOptions, streaming: boolean): Promise<ChatResult> {
    if (!this.isAvailable()) throw new ProviderError(`Provider '${this.name}' is not available (check API key)`, 0, this.name);
    this.sendProgress(this.prepareMessage());
    this.beginCall(opts);
    try {
      const systemPrompt = this.buildSystemPrompt(opts);
      const tools = this.assembleTools(opts);
      const userId = opts.user_id ?? null;
      const toolChoice = this.initialToolChoice(opts);
      const messages = this.buildMessages(opts, systemPrompt);

      let response = await this.makeRequest(messages, tools, streaming, toolChoice);
      const state: ToolLoopState = {
        messages, tools, userId, streaming, toolChoice,
        inputTokens: response?.usage?.prompt_tokens ?? 0,
        outputTokens: response?.usage?.completion_tokens ?? 0,
        functionCallCount: 0, functionsCalled: [], mcpToolsCalled: [], executedTools: {},
      };

      if (this.toolsSupported() && this.hasToolCalls(response)) {
        this.sendProgress('Processing tool calls...');
        response = await this.handleToolCalls(response, state);
      }

      const usage = {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
        function_calls: state.functionCallCount,
      };
      const common = {
        model: this.model,
        provider: this.name,
        functions_called: state.functionsCalled,
        mcp_tools_called: state.mcpToolsCalled,
        mcp_calls_count: state.mcpToolsCalled.length,
      };

      if (response._pending_client_tool_call) {
        return {
          text: response._pending_assistant_text ?? '',
          ...this.pendingExtra(response),
          usage,
          ...common,
          pending_client_tool_call: true,
          pending_tool_calls: response._pending_tool_calls ?? [],
        };
      }

      const text = this.extractTextResponse(response);
      this.sendProgress('Response ready.');
      return { text, usage, ...common };
    } finally {
      this.endCall();
    }
  }

  /** Extra fields of a pending client-tool result (DeepSeek: assistant_reasoning). */
  protected pendingExtra(_response: CompletionResponse): Record<string, any> {
    return {};
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    return this.run(opts, false);
  }

  async streamChat(opts: ChatOptions, sse: SSEStream): Promise<ChatResult> {
    this.sse = sse;
    try {
      if (!this.streamingEnabled) {
        const result = await this.run(opts, false);
        sse.send('chunk', result.text);
        return result;
      }
      return await this.run(opts, true);
    } finally {
      this.sse = null;
    }
  }
}

/** PHP truthiness / !empty(). */
export function phpTruthy(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
