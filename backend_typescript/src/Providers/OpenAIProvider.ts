import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult } from '../Contracts/types';
import { SSEStream } from '../Services/SseStream';

interface OpenAIToolCall {
  id: string;
  name: string;
  argsBuf: string;
}

interface TurnResult {
  fullText: string;
  toolCalls: OpenAIToolCall[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * OpenAI-compatible provider — serves openai / kimi / grok / deepseek (api_format='openai').
 * Plain text chat + the client-tool short-circuit (B3) + the server-tool recursive continuation
 * loop. Mirrors src/Providers/OpenAIProvider.php (chat + makeRequest + handleStreamingResponse +
 * handleToolCallsRecursive); the kimi/grok/deepseek classes extend it, overriding only the
 * progress labels.
 */
export class OpenAIProvider extends LLMProvider {
  private static readonly CLIENT_SIDE_TOOL_NAMES = ['run_skill_script', 'discover_skill', 'Task'];
  private static readonly MAX_RECURSION_DEPTH = 10;

  // Per-provider progress strings, captured verbatim from the live PHP wire.
  private static readonly PROGRESS: Record<
    string,
    { prefix: string; prepare: string; connect: string; thinking: string; processing_response: string; ready: string }
  > = {
    openai: {
      prefix: 'OpenAI',
      prepare: 'OpenAI: Preparing OpenAI request...',
      connect: 'OpenAI: Connecting to OpenAI API...',
      thinking: 'OpenAI: Thinking...',
      processing_response: 'OpenAI: Processing OpenAI response...',
      ready: 'OpenAI: Response ready.',
    },
    kimi: {
      prefix: 'Kimi',
      prepare: 'Kimi: Preparing request...',
      connect: 'Kimi: Connecting to Kimi API...',
      thinking: 'Kimi: Thinking...',
      processing_response: 'Kimi: Processing response...',
      ready: 'Kimi: Response ready.',
    },
    grok: {
      prefix: 'Grok',
      prepare: 'Grok: Preparing request...',
      connect: 'Grok: Connecting to xAI API...',
      thinking: 'Grok: Thinking...',
      processing_response: 'Grok: Processing response...',
      ready: 'Grok: Response ready.',
    },
    deepseek: {
      prefix: 'Deepseek',
      prepare: 'Deepseek: Preparing Deepseek request...',
      connect: 'Deepseek: Connecting to Deepseek API...',
      thinking: 'Deepseek: Thinking...',
      processing_response: 'Deepseek: Processing Deepseek response...',
      ready: 'Deepseek: Response ready.',
    },
    gamma4: {
      prefix: 'Gamma4',
      prepare: 'Gamma4: Preparing Gamma4 request...',
      connect: 'Gamma4: Connecting to Gamma4 API...',
      thinking: 'Gamma4: Thinking...',
      processing_response: 'Gamma4: Processing Gamma4 response...',
      ready: 'Gamma4: Response ready.',
    },
  };

  private get progress() {
    return OpenAIProvider.PROGRESS[this.config.provider_key] ?? OpenAIProvider.PROGRESS.openai;
  }

  private isReasoningModel(model: string): boolean {
    return /^o1/.test(model) || /^o3/.test(model);
  }

  private isClientSide(name: string, opts: ChatOptions): boolean {
    return OpenAIProvider.CLIENT_SIDE_TOOL_NAMES.includes(name) || (opts.client_tool_names ?? []).includes(name);
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.api_key}` };
  }

  /**
   * Build the OpenAI messages array from the system prompt + conversation history + new message.
   * Mirrors OpenAIProvider.php::buildMessages — including B3 tool/assistant-tool_calls passthrough
   * and the tool-result-continuation guard (no trailing empty user turn).
   */
  private buildMessages(opts: ChatOptions): any[] {
    const messages: any[] = [{ role: 'system', content: this.buildSystemPrompt(opts) }];

    for (const turn of opts.conversation_history) {
      if (!turn) continue;
      const role = turn.role ?? 'user';

      // B3: tool-result turns from a prior client-side dispatch — OpenAI's native shape.
      if (role === 'tool' && turn.tool_call_id) {
        const entry: any = {
          role: 'tool',
          tool_call_id: turn.tool_call_id,
          content: typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content ?? null),
        };
        if (turn.name && typeof turn.name === 'string') entry.name = turn.name;
        messages.push(entry);
        continue;
      }

      // B3: assistant turns carrying tool_calls — normalize to OpenAI wire shape.
      if (role === 'assistant' && Array.isArray(turn.tool_calls) && turn.tool_calls.length) {
        const text = this.extractText(turn.content);
        const normalized = turn.tool_calls.map((tc: any) => {
          if (tc.function) return tc; // already OpenAI wire shape
          if (tc.name) {
            return { id: tc.id ?? '', type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) } };
          }
          return tc;
        });
        messages.push({ role: 'assistant', content: text !== '' ? text : null, tool_calls: normalized });
        continue;
      }

      // Plain text turns (the common case).
      if (role === 'user' || role === 'assistant') {
        const text = this.extractText(turn.content);
        if (text !== '' && text.trim() !== '') messages.push({ role, content: text });
      }
    }

    // B3 continuation: tool_result already at the tail with an empty new message — don't append
    // an empty user turn (OpenAI 400s).
    const last = messages[messages.length - 1];
    const isToolResultContinuation = (!opts.message || opts.message.trim() === '') && last && last.role === 'tool';
    if (isToolResultContinuation) return messages;

    if (opts.message && opts.message.trim() !== '') {
      messages.push({ role: 'user', content: opts.message });
    }
    return messages;
  }

  /** Assembled tool definitions (Claude shape): server executor's defs + per-request client_tools. */
  private buildToolDefs(opts: ChatOptions): any[] {
    const tools: any[] = [];
    if (this.functionExecutor) tools.push(...this.functionExecutor.getToolDefinitions());
    for (const ct of opts.client_tools ?? []) {
      if (!ct?.name) continue;
      tools.push({ name: ct.name, description: ct.description ?? '', input_schema: ct.input_schema ?? { type: 'object', properties: {}, required: [] } });
    }
    return tools;
  }

  /** input_schema → parameters, wrapped in OpenAI's {type:'function', function:{...}} shape. */
  private convertToOpenAITools(claudeTools: any[]): any[] {
    return claudeTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }

  private buildBody(messages: any[], toolDefs: any[], stream: boolean, toolChoice?: any): Record<string, any> {
    const model = this.config.model;
    const body: Record<string, any> = { model, messages };
    if (!this.isReasoningModel(model)) body.temperature = this.config.temperature;
    if (/^gpt-5/.test(model) || this.isReasoningModel(model)) body.max_completion_tokens = this.config.max_tokens;
    else body.max_tokens = this.config.max_tokens;
    // Kimi K2.6: thinking mode (temp 1.0) is INCOMPATIBLE with a forced tool_choice (the API 400s
    // with "tool_choice 'specified' is incompatible with thinking enabled"). PHP's dedicated
    // KimiProvider forces non-thinking sampling for K2 models; mirror it here (this provider serves
    // kimi). thinking disabled, temp 0.6, top_p 0.95 — the exact values the K2.6 API requires.
    if (model.startsWith('kimi-k2')) {
      body.thinking = { type: 'disabled' };
      body.temperature = 0.6;
      body.top_p = 0.95;
    }
    // o1/o3 don't support tools.
    if (toolDefs.length && !this.isReasoningModel(model)) {
      body.tools = this.convertToOpenAITools(toolDefs);
      // Forwarded verbatim (PHP: $options['tool_choice'] ?? 'auto'); ChatController
      // builds the OpenAI-native shape ({type:'function',function:{name}} or 'required').
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private async executeFunction(name: string, input: any, context: any): Promise<any> {
    if (!this.functionExecutor) return { error: 'No function executor configured' };
    try {
      return await this.functionExecutor.execute(name, input, context);
    } catch (e: any) {
      return { error: e?.message ?? 'Function execution failed' };
    }
  }

  private encodeResult(result: any): string {
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private parseArgs(argsBuf: string): any {
    if (!argsBuf) return {};
    try {
      return JSON.parse(argsBuf);
    } catch {
      return {};
    }
  }

  /**
   * One streaming request: emits connect + thinking, streams text as `chunk` (suppressed once a
   * tool_call delta appears), accumulates tool_calls (by index) + usage. Mirrors makeRequest +
   * handleStreamingResponse.
   */
  private async streamOneTurn(messages: any[], toolDefs: any[], sse: SSEStream, toolChoice?: any): Promise<TurnResult> {
    const prog = this.progress;
    sse.send('progress', prog.connect);

    const res = await fetch(this.config.base_url + this.config.chat_endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(messages, toolDefs, true, toolChoice)),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${this.config.provider_key} API error: ${res.status} ${errText}`);
    }

    sse.send('progress', prog.thinking);

    let fullText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let hasToolCalls = false;
    const byIndex: Record<number, OpenAIToolCall> = {};
    const order: number[] = [];

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') break outer;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = json.choices?.[0]?.delta ?? {};

        const content = delta.content ?? '';
        if (content !== '') {
          fullText += content;
          // Mirror PHP: only stream content while no tool calls have appeared in this turn.
          if (!hasToolCalls) sse.send('chunk', content);
        }

        if (Array.isArray(delta.tool_calls)) {
          hasToolCalls = true;
          for (const tcd of delta.tool_calls) {
            const index = tcd.index ?? 0;
            if (!byIndex[index]) {
              byIndex[index] = { id: '', name: '', argsBuf: '' };
              order.push(index);
            }
            if (tcd.id) byIndex[index].id = tcd.id;
            if (tcd.function?.name) byIndex[index].name = tcd.function.name;
            if (tcd.function?.arguments) byIndex[index].argsBuf += tcd.function.arguments;
          }
        }

        if (json.usage) {
          promptTokens = json.usage.prompt_tokens ?? promptTokens;
          completionTokens = json.usage.completion_tokens ?? completionTokens;
        }
      }

      if (sse.isAborted) throw new Error('CLIENT_ABORTED');
    }

    const toolCalls = order.map((i) => byIndex[i]);
    return { fullText, toolCalls, inputTokens: promptTokens, outputTokens: completionTokens };
  }

  async streamChat(opts: ChatOptions, sse: SSEStream): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error(`${this.config.provider_key} API key not configured`);
    const prog = this.progress;

    const toolDefs = this.buildToolDefs(opts);
    const messages = this.buildMessages(opts);

    sse.send('progress', prog.prepare);

    let answerText = '';
    let totalInput = 0;
    let totalOutput = 0;
    let functionCalls = 0;
    let processingToolsSent = false;

    for (let depth = 0; depth <= OpenAIProvider.MAX_RECURSION_DEPTH; depth++) {
      const turn = await this.streamOneTurn(messages, toolDefs, sse, opts.tool_choice);
      totalInput += turn.inputTokens;
      totalOutput += turn.outputTokens;
      answerText = turn.fullText;

      if (turn.toolCalls.length === 0) break;

      const clientCalls = turn.toolCalls.filter((tc) => this.isClientSide(tc.name, opts));
      const serverCalls = turn.toolCalls.filter((tc) => !this.isClientSide(tc.name, opts));

      // All client-side → short-circuit (B3).
      if (clientCalls.length && serverCalls.length === 0) {
        const normalized = clientCalls.map((tc) => ({ id: tc.id, name: tc.name, input: this.parseArgs(tc.argsBuf) }));
        sse.send('client_tool_call', { assistant_text: turn.fullText, tool_calls: normalized });
        functionCalls += clientCalls.length;
        sse.send('progress', prog.ready);
        return {
          text: turn.fullText,
          usage: { input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput, function_calls: functionCalls },
          model: this.config.model, provider: this.config.provider_key, pending_client_tool_call: true, pending_tool_calls: normalized,
        };
      }

      if (depth >= OpenAIProvider.MAX_RECURSION_DEPTH) break;

      // "Processing tool calls..." — emitted once, before the first continuation (mirrors chat()).
      if (!processingToolsSent) {
        sse.send('progress', `${prog.prefix}: Processing tool calls...`);
        processingToolsSent = true;
      }

      // Append the assistant turn carrying the tool_calls (OpenAI wire shape).
      messages.push({
        role: 'assistant',
        content: turn.fullText !== '' ? turn.fullText : null,
        tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argsBuf || '{}' } })),
      });

      // Execute each tool call in order; client-side ones in a mixed turn fail closed.
      for (const tc of turn.toolCalls) {
        functionCalls++;
        if (this.isClientSide(tc.name, opts)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.' }),
          });
          continue;
        }
        sse.send('progress', `${prog.prefix}: Executing function: ${tc.name}`);
        const result = await this.executeFunction(tc.name, this.parseArgs(tc.argsBuf), opts.user_id ?? null);
        if (result && result._mcp_ui) {
          sse.send('mcp_ui', { tool_name: tc.name, ui_info: result._mcp_ui });
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: this.encodeResult(result) });
      }

      sse.send('progress', prog.processing_response);
      // Loop continues → next streamOneTurn is the continuation request.
    }

    sse.send('progress', prog.ready);
    return {
      text: answerText,
      usage: { input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput, function_calls: functionCalls },
      model: this.config.model,
      provider: this.config.provider_key,
    };
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error(`${this.config.provider_key} API key not configured`);

    const toolDefs = this.buildToolDefs(opts);
    const res = await fetch(this.config.base_url + this.config.chat_endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(this.buildMessages(opts), toolDefs, false, opts.tool_choice)),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json) {
      throw new Error(`${this.config.provider_key} API error: ${res.status} ${json ? JSON.stringify(json) : ''}`);
    }

    const message = json.choices?.[0]?.message ?? {};
    const text = message.content ?? '';
    const input = json.usage?.prompt_tokens ?? 0;
    const output = json.usage?.completion_tokens ?? 0;
    const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, function_calls: 0 };

    // Non-streaming client-tool short-circuit (mirrors the streaming path's all-client case).
    const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length && toolCalls.every((tc) => this.isClientSide(tc.function?.name ?? '', opts))) {
      const normalized = toolCalls.map((tc) => ({ id: tc.id, name: tc.function?.name ?? '', input: this.parseArgs(tc.function?.arguments ?? '{}') }));
      return { text, usage, model: this.config.model, provider: this.config.provider_key, pending_client_tool_call: true, pending_tool_calls: normalized };
    }

    return { text, usage, model: this.config.model, provider: this.config.provider_key };
  }
}
