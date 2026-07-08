import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult } from '../Contracts/types';
import { SSEStream } from '../Services/SseStream';

interface GeminiFnCall {
  name: string;
  args: any;
  thoughtSignature?: string;
}

/**
 * Gemini provider. Mirrors src/Providers/GeminiProvider.php: it does NOT truly stream — it calls
 * the non-streaming `:generateContent` endpoint (looping server-side for tool calls) and forwards
 * the whole final response as a SINGLE `chunk` (after "Response ready."). The server-tool recursive
 * function-call loop + the client-tool short-circuit (B3) are mirrored here.
 */
export class GeminiProvider extends LLMProvider {
  private static readonly CLIENT_SIDE_TOOL_NAMES = ['run_skill_script', 'discover_skill', 'Task'];
  private static readonly MAX_RECURSION_DEPTH = 10;

  private isClientSide(name: string, opts: ChatOptions): boolean {
    return GeminiProvider.CLIENT_SIDE_TOOL_NAMES.includes(name) || (opts.client_tool_names ?? []).includes(name);
  }

  private buildContents(opts: ChatOptions): any[] {
    const contents: any[] = [];
    for (const turn of opts.conversation_history) {
      if (!turn) continue;
      const role = turn.role === 'assistant' ? 'model' : turn.role === 'user' ? 'user' : null;
      if (!role) continue;
      const text = this.extractText(turn.content);
      if (text && text.trim() !== '') contents.push({ role, parts: [{ text }] });
    }
    if (opts.message && opts.message.trim() !== '') {
      contents.push({ role: 'user', parts: [{ text: opts.message }] });
    }
    return contents;
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

  /** Port of GeminiProvider.php::fixSchemaForGemini — strip unsupported JSON-Schema fields, etc. */
  private fixSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || Object.keys(schema).length === 0) {
      return { type: 'string' };
    }
    const UNSUPPORTED = [
      '$schema', '$id', '$ref', '$defs', 'additionalProperties', 'definitions', 'examples', 'default', 'const',
      'title', 'format', 'nullable', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml', 'discriminator',
      'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
      'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
    ];
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) {
      if (UNSUPPORTED.includes(k)) continue;
      out[k] = v;
    }
    if (out.type === undefined) out.type = 'string';

    // Convert enum → description nudge.
    if (Array.isArray(out.enum)) {
      const allowed = out.enum.map((e: any) => String(e)).join(', ');
      out.description = `${out.description ?? ''} Allowed values: ${allowed}`.trim();
      delete out.enum;
    }

    if (out.properties !== undefined) {
      const props = out.properties;
      if (props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length) {
        const fixed: any = {};
        for (const [pn, ps] of Object.entries(props)) fixed[pn] = this.fixSchemaForGemini(ps);
        out.properties = fixed;
      } else {
        out.properties = {};
      }
    } else if (out.type === 'object') {
      out.properties = {};
    }

    if (out.items !== undefined) out.items = this.fixSchemaForGemini(out.items);
    else if (out.type === 'array') out.items = { type: 'string' };

    if (Array.isArray(out.required) && out.required.length === 0) delete out.required;

    return out;
  }

  private convertToGeminiTools(claudeTools: any[]): any[] {
    const functions = claudeTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: this.fixSchemaForGemini(tool.input_schema ?? { type: 'object', properties: {} }),
    }));
    return [{ functionDeclarations: functions }];
  }

  private url(): string {
    return `${this.config.base_url}/models/${this.config.model}:generateContent?key=${encodeURIComponent(this.config.api_key)}`;
  }

  /** One non-streaming `:generateContent` call. Emits "Connecting...". Mirrors makeRequest. */
  private async makeRequest(contents: any[], system: string, toolDefs: any[], sse: SSEStream): Promise<any> {
    sse.send('progress', 'Gemini: Connecting to Gemini API...');
    const payload: any = {
      contents,
      generationConfig: { maxOutputTokens: this.config.max_tokens, temperature: this.config.temperature },
      systemInstruction: { parts: [{ text: system }] },
    };
    if (toolDefs.length) {
      payload.tools = this.convertToGeminiTools(toolDefs);
      payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const res = await fetch(this.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json) {
      throw new Error(`gemini API error: ${res.status} ${json ? JSON.stringify(json) : ''}`);
    }
    return json;
  }

  private partsOf(json: any): any[] {
    return json?.candidates?.[0]?.content?.parts ?? [];
  }

  private functionCallsOf(json: any): GeminiFnCall[] {
    const calls: GeminiFnCall[] = [];
    for (const part of this.partsOf(json)) {
      if (part?.functionCall) calls.push({ name: part.functionCall.name ?? '', args: part.functionCall.args ?? {}, thoughtSignature: part.thoughtSignature });
    }
    return calls;
  }

  private extractTextResponse(json: any): string {
    return this.partsOf(json)
      .map((p: any) => (p?.text !== undefined ? p.text : null))
      .filter((t: any) => t !== null)
      .join('\n');
  }

  private async executeFunction(name: string, input: any, context: any): Promise<any> {
    if (!this.functionExecutor) return { error: 'No function executor configured' };
    try {
      return await this.functionExecutor.execute(name, input, context);
    } catch (e: any) {
      return { error: e?.message ?? 'Function execution failed' };
    }
  }

  private tokensOf(json: any): { input: number; output: number } {
    return { input: json?.usageMetadata?.promptTokenCount ?? 0, output: json?.usageMetadata?.candidatesTokenCount ?? 0 };
  }

  private result(text: string, input: number, output: number, functionCalls: number, extra: Partial<ChatResult> = {}): ChatResult {
    return {
      text,
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, function_calls: functionCalls },
      model: this.config.model,
      provider: 'gemini',
      ...extra,
    };
  }

  async streamChat(opts: ChatOptions, sse: SSEStream): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error('gemini API key not configured');

    const toolDefs = this.buildToolDefs(opts);
    const contents = this.buildContents(opts);
    const system = this.buildSystemPrompt(opts);

    sse.send('progress', 'Gemini: Preparing Gemini request...');

    let totalInput = 0;
    let totalOutput = 0;
    let functionCalls = 0;

    let response = await this.makeRequest(contents, system, toolDefs, sse);
    let t = this.tokensOf(response);
    totalInput += t.input;
    totalOutput += t.output;

    const hadCalls = this.functionCallsOf(response).length > 0;

    if (hadCalls) {
      sse.send('progress', 'Gemini: Processing function calls...');

      for (let depth = 0; depth <= GeminiProvider.MAX_RECURSION_DEPTH; depth++) {
        const calls = this.functionCallsOf(response);
        if (calls.length === 0) break;

        const clientCalls = calls.filter((c) => this.isClientSide(c.name, opts));
        const serverCalls = calls.filter((c) => !this.isClientSide(c.name, opts));

        // All client-side → short-circuit (B3): synthesize ids, preserve thoughtSignature.
        if (clientCalls.length && serverCalls.length === 0) {
          let assistantText = '';
          for (const p of this.partsOf(response)) if (p?.text !== undefined) assistantText += p.text;
          const normalized = clientCalls.map((c, i) => {
            const entry: any = { id: `gemini_${this.config.provider_key}_${depth}_${i}`, name: c.name, input: c.args ?? {} };
            if (c.thoughtSignature) entry.thought_signature = c.thoughtSignature;
            return entry;
          });
          sse.send('client_tool_call', { assistant_text: assistantText, tool_calls: normalized });
          functionCalls += clientCalls.length;
          return this.result(assistantText, totalInput, totalOutput, functionCalls, { pending_client_tool_call: true, pending_tool_calls: normalized });
        }

        if (depth >= GeminiProvider.MAX_RECURSION_DEPTH) break;

        // Append the model turn carrying the functionCall parts (preserve thoughtSignature for 2.5+).
        const modelParts = calls.map((c) => {
          const part: any = { functionCall: { name: c.name, args: c.args ?? {} } };
          if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
          return part;
        });
        contents.push({ role: 'model', parts: modelParts });

        const functionResults: any[] = [];
        for (const c of calls) {
          functionCalls++;
          if (this.isClientSide(c.name, opts)) {
            functionResults.push({ functionResponse: { name: c.name, response: { error: 'Client-side tools cannot be mixed with server-side tools in a single turn yet. Issue this tool call in its own turn.' } } });
            continue;
          }
          sse.send('progress', `Gemini: Executing function: ${c.name}`);
          const raw = await this.executeFunction(c.name, c.args ?? {}, opts.user_id ?? null);
          if (raw && raw._mcp_ui) sse.send('mcp_ui', { tool_name: c.name, ui_info: raw._mcp_ui });
          // Strip internal metadata before handing the result back to the model.
          const cleanResult = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { result: raw };
          delete (cleanResult as any)._mcp_ui;
          delete (cleanResult as any)._meta;
          functionResults.push({ functionResponse: { name: c.name, response: cleanResult } });
        }
        contents.push({ role: 'tool', parts: functionResults });

        sse.send('progress', 'Gemini: Processing Gemini response...');
        response = await this.makeRequest(contents, system, toolDefs, sse);
        t = this.tokensOf(response);
        totalInput += t.input;
        totalOutput += t.output;

        if (this.functionCallsOf(response).length === 0) break;
      }
    }

    // Extract final text; Gemini occasionally returns empty with tools — retry once without tools.
    let textResponse = this.extractTextResponse(response);
    if (textResponse === '' && !hadCalls) {
      const retry = await this.makeRequest(contents, system, [], sse);
      textResponse = this.extractTextResponse(retry);
      if (textResponse === '') textResponse = "I apologize, but I couldn't generate a response. Please try rephrasing your question.";
    }

    sse.send('progress', 'Gemini: Response ready.');
    sse.send('chunk', textResponse);
    return this.result(textResponse, totalInput, totalOutput, functionCalls);
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    if (!this.config.api_key) throw new Error('gemini API key not configured');
    // Non-streaming single-shot (no tool loop) — mirrors callers that pass stream:false for plain text.
    const json = await (async () => {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: this.buildContents(opts),
          generationConfig: { maxOutputTokens: this.config.max_tokens, temperature: this.config.temperature },
          systemInstruction: { parts: [{ text: this.buildSystemPrompt(opts) }] },
        }),
      });
      const j: any = await res.json().catch(() => null);
      if (!res.ok || !j) throw new Error(`gemini API error: ${res.status} ${j ? JSON.stringify(j) : ''}`);
      return j;
    })();
    const text = this.extractTextResponse(json);
    const tk = this.tokensOf(json);
    return this.result(text, tk.input, tk.output, 0);
  }
}
