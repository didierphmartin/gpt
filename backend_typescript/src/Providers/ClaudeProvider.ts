import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult } from '../Contracts/types';
import { SSEStream } from '../Services/SseStream';

interface ToolBlock {
  id: string;
  name: string;
  inputBuf: string;
  input?: any;
}

interface TurnResult {
  fullText: string;
  toolBlocks: ToolBlock[];
  assistantContent: any[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * Claude (Anthropic) provider — plain text + the client-tool short-circuit (Phase 1) + the
 * server-tool recursive continuation loop (Phase 2). Mirrors src/Providers/ClaudeProvider.php
 * (makeStreamingRequest + handleToolUseRecursive).
 */
export class ClaudeProvider extends LLMProvider {
  private static readonly CLIENT_SIDE_TOOL_NAMES = ['run_skill_script', 'discover_skill', 'Task'];
  private static readonly MAX_RECURSION_DEPTH = 10;

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.config.api_key, 'anthropic-version': '2023-06-01' };
  }

  private buildMessages(opts: ChatOptions): any[] {
    const messages: any[] = [];
    for (const turn of opts.conversation_history) {
      if (!turn) continue;
      if (turn.role === 'user') {
        const text = this.extractText(turn.content);
        if (text !== '') messages.push({ role: 'user', content: [{ type: 'text', text }] });
      } else if (turn.role === 'assistant') {
        const blocks: any[] = [];
        const text = this.extractText(turn.content);
        if (text && text.trim() !== '') blocks.push({ type: 'text', text });
        if (Array.isArray(turn.tool_calls)) {
          for (const tc of turn.tool_calls) {
            const name = tc.function?.name ?? tc.name;
            let input = tc.input;
            if (input === undefined && tc.function?.arguments !== undefined) {
              try {
                input = JSON.parse(tc.function.arguments);
              } catch {
                input = {};
              }
            }
            blocks.push({ type: 'tool_use', id: tc.id, name, input: input ?? {} });
          }
        }
        if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      } else if (turn.role === 'tool') {
        const content = typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content);
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.tool_call_id, content }] });
      }
    }
    // PDFs and images go FIRST so Claude sees them before the text prompt —
    // matches the order Anthropic documents in their vision/document examples.
    const imgs = opts.image_attachments ?? [];
    const pdfs = opts.pdf_attachments ?? [];
    if (imgs.length || pdfs.length) {
      const userContent: any[] = [];
      for (const pdf of pdfs) {
        userContent.push({ type: 'document', source: { type: 'base64', media_type: pdf.mime_type, data: pdf.data } });
      }
      for (const img of imgs) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mime_type, data: img.data } });
      }
      userContent.push({ type: 'text', text: opts.message });
      messages.push({ role: 'user', content: userContent });
    } else if (opts.message && opts.message.trim() !== '') {
      messages.push({ role: 'user', content: [{ type: 'text', text: opts.message }] });
    }
    return messages;
  }

  /** Assembled tool definitions: per-request client_tools + the server executor's definitions. */
  private buildToolDefs(opts: ChatOptions): any[] {
    const tools: any[] = [];
    for (const ct of opts.client_tools ?? []) {
      if (!ct?.name) continue;
      tools.push({ name: ct.name, description: ct.description ?? '', input_schema: ct.input_schema ?? { type: 'object', properties: {}, required: [] } });
    }
    if (this.functionExecutor) tools.push(...this.functionExecutor.getToolDefinitions());
    return tools;
  }

  private parseEvent(raw: string): any | null {
    const dataStr = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('');
    if (!dataStr || dataStr === '[DONE]') return null;
    try {
      return JSON.parse(dataStr);
    } catch {
      return null;
    }
  }

  private isClientSide(name: string, opts: ChatOptions): boolean {
    return ClaudeProvider.CLIENT_SIDE_TOOL_NAMES.includes(name) || (opts.client_tool_names ?? []).includes(name);
  }

  /**
   * Translate the incoming tool_choice into Claude's native shape. Mirrors
   * ClaudeProvider.php: OpenAI object form {type:'function',function:{name}} →
   * {type:'tool',name}; 'required' → {type:'any'}; 'tool:<name>' → {type:'tool',name};
   * any other non-'auto' string → {type:<value>}. Returns undefined for 'auto'/absent
   * (Claude defaults to auto, so no field is set).
   */
  private nativeToolChoice(tc: any): any | undefined {
    if (tc === undefined || tc === null) return undefined;
    if (typeof tc === 'object') {
      if (tc.type === 'function' && tc.function?.name) return { type: 'tool', name: tc.function.name };
      return tc; // already Claude's shape — pass through
    }
    if (tc === 'required') return { type: 'any' };
    if (typeof tc === 'string' && tc.startsWith('tool:')) return { type: 'tool', name: tc.slice(5) };
    if (tc !== 'auto') return { type: tc };
    return undefined;
  }

  private async executeFunction(name: string, input: any, context: any): Promise<any> {
    if (!this.functionExecutor || !this.functionExecutor.hasFunction(name)) return { error: `Function not available: ${name}` };
    try {
      return await this.functionExecutor.execute(name, input, context);
    } catch (e: any) {
      return { error: e?.message ?? 'Function execution failed' };
    }
  }

  /** Mirrors stripLargeDataFromResult — replace heavy base64-ish strings before sending to the model. */
  private stripLargeData(value: any): any {
    const HEAVY = new Set(['imageBase64', 'videoBase64', 'base64', 'data', 'content_base64', 'image_data', 'binary']);
    const walk = (v: any): any => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: any = {};
        for (const [k, val] of Object.entries(v)) {
          if (HEAVY.has(k) && typeof val === 'string' && val.length > 1000) out[k] = `[${val.length} bytes stripped]`;
          else out[k] = walk(val);
        }
        return out;
      }
      return v;
    };
    return walk(value);
  }

  private encodeResult(result: any): string {
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /** One streaming request: streams text as `chunk`, accumulates tool_use blocks + usage. */
  private async streamOneTurn(messages: any[], tools: any[], system: string, sse: SSEStream, toolChoice?: any): Promise<TurnResult> {
    const body: any = {
      model: this.config.model,
      max_tokens: this.config.max_tokens,
      temperature: this.config.temperature,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      stream: true,
    };
    if (tools.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }

    const res = await fetch(this.config.base_url + this.config.chat_endpoint, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Claude API error: ${res.status} ${errText}`);
    }

    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolBlocks: ToolBlock[] = [];
    const blockByIndex: Record<number, ToolBlock | 'text'> = {};

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = this.parseEvent(rawEvent);
        if (!ev) continue;

        if (ev.type === 'content_block_start') {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use') {
            const blk: ToolBlock = { id: cb.id, name: cb.name, inputBuf: '' };
            toolBlocks.push(blk);
            blockByIndex[ev.index] = blk;
          } else {
            blockByIndex[ev.index] = 'text';
          }
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullText += ev.delta.text;
          sse.send('chunk', ev.delta.text);
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
          const b = blockByIndex[ev.index];
          if (b && b !== 'text') b.inputBuf += ev.delta.partial_json ?? '';
        } else if (ev.type === 'content_block_stop') {
          const b = blockByIndex[ev.index];
          if (b && b !== 'text') {
            try {
              b.input = b.inputBuf ? JSON.parse(b.inputBuf) : {};
            } catch {
              b.input = {};
            }
          }
        } else if (ev.type === 'message_start') {
          inputTokens = ev.message?.usage?.input_tokens ?? inputTokens;
        } else if (ev.type === 'message_delta') {
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
        } else if (ev.type === 'error') {
          throw new Error(`Claude API error: ${ev.error?.message ?? 'unknown error'}`);
        }
      }

      if (sse.isAborted) throw new Error('CLIENT_ABORTED');
    }

    const assistantContent: any[] = [];
    if (fullText) assistantContent.push({ type: 'text', text: fullText });
    for (const b of toolBlocks) assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });

    return { fullText, toolBlocks, assistantContent, inputTokens, outputTokens };
  }

  async streamChat(opts: ChatOptions, sse: SSEStream): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error('Claude API key not configured');

    const system = this.buildSystemPrompt(opts);
    const tools = this.buildToolDefs(opts);
    const messages = this.buildMessages(opts);
    const toolChoice = this.nativeToolChoice(opts.tool_choice);

    sse.send('progress', 'Claude: Preparing Claude streaming request...');

    let answerText = '';
    let totalInput = 0;
    let totalOutput = 0;
    let functionCalls = 0;

    for (let depth = 0; depth <= ClaudeProvider.MAX_RECURSION_DEPTH; depth++) {
      sse.send('progress', 'Claude: Connecting to Claude API (streaming)...');
      const turn = await this.streamOneTurn(messages, tools, system, sse, toolChoice);
      totalInput += turn.inputTokens;
      totalOutput += turn.outputTokens;
      answerText = turn.fullText;

      if (turn.toolBlocks.length === 0) break;

      const clientBlocks = turn.toolBlocks.filter((b) => this.isClientSide(b.name, opts));
      const serverBlocks = turn.toolBlocks.filter((b) => !this.isClientSide(b.name, opts));

      // All client-side → short-circuit (Phase 1).
      if (serverBlocks.length === 0) {
        const toolCalls = clientBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
        sse.send('client_tool_call', { assistant_text: turn.fullText, tool_calls: toolCalls });
        sse.send('progress', 'Claude: Response ready.');
        return {
          text: turn.fullText,
          usage: { input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput, function_calls: functionCalls },
          model: this.config.model, provider: 'claude', pending_client_tool_call: true, pending_tool_calls: toolCalls,
        };
      }

      if (depth >= ClaudeProvider.MAX_RECURSION_DEPTH) break;

      // Server-tool execution + continuation (Phase 2).
      sse.send('progress', 'Claude: Processing tool calls...');
      messages.push({ role: 'assistant', content: turn.assistantContent });

      const toolResults: any[] = [];
      for (const block of serverBlocks) {
        sse.send('progress', `Claude: Executing function: ${block.name}`);
        functionCalls++;
        const result = await this.executeFunction(block.name, block.input ?? {}, opts.user_id ?? null);
        // MCP UI: emit the mcp_ui event when the tool result carries UI info (prefixed name at top level).
        if (result && result._mcp_ui) {
          sse.send('mcp_ui', { tool_name: block.name, ui_info: result._mcp_ui });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: this.encodeResult(this.stripLargeData(result)) });
      }
      // Mixed turn: client-side blocks fail closed (must be called alone).
      for (const block of clientBlocks) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'This client-side tool must be called by itself. Please call it in a separate turn without other tools.' });
      }

      sse.send('progress', 'Claude: Processing Claude response...');
      messages.push({ role: 'user', content: toolResults });
    }

    sse.send('progress', 'Claude: Response ready.');
    return {
      text: answerText,
      usage: { input_tokens: totalInput, output_tokens: totalOutput, total_tokens: totalInput + totalOutput, function_calls: functionCalls },
      model: this.config.model, provider: 'claude',
    };
  }

  /**
   * Non-streaming chat. Handles the client-tool short-circuit; the server-tool recursive loop is
   * implemented on the streaming path only for now (the frontend chat always streams).
   */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error('Claude API key not configured');

    const body: any = {
      model: this.config.model,
      max_tokens: this.config.max_tokens,
      temperature: this.config.temperature,
      system: [{ type: 'text', text: this.buildSystemPrompt(opts), cache_control: { type: 'ephemeral' } }],
      messages: this.buildMessages(opts),
      stream: false,
    };
    const tools = this.buildToolDefs(opts);
    if (tools.length) {
      body.tools = tools;
      const toolChoice = this.nativeToolChoice(opts.tool_choice);
      if (toolChoice) body.tool_choice = toolChoice;
    }

    const res = await fetch(this.config.base_url + this.config.chat_endpoint, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json) {
      throw new Error(`Claude API error: ${res.status} ${json ? JSON.stringify(json) : ''}`);
    }

    const blocks: any[] = Array.isArray(json.content) ? json.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const input = json.usage?.input_tokens ?? 0;
    const output = json.usage?.output_tokens ?? 0;
    const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, function_calls: 0 };

    const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
    if (toolBlocks.length > 0 && toolBlocks.every((b) => this.isClientSide(b.name, opts))) {
      const toolCalls = toolBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
      return { text, usage, model: this.config.model, provider: 'claude', pending_client_tool_call: true, pending_tool_calls: toolCalls };
    }

    return { text, usage, model: this.config.model, provider: 'claude' };
  }
}
