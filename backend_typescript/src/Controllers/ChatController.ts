import { Request, Response } from 'express';
import { buildCtx } from '../Support/Http';
import { SSEStream } from '../Services/SseStream';
import { LLMProviderResolver } from '../Services/LLMProviderResolver';
import { ProviderFactory } from '../Providers/ProviderFactory';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { CombinedToolsExecutor } from '../Services/CombinedToolsExecutor';
import { SearchFunctions } from '../Functions/SearchFunctions';
import { FunctionExecutor } from '../Contracts/FunctionExecutor';
import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult, SkillMetadata, AvailableSkill } from '../Contracts/types';

/**
 * Event-renaming SSE adapter for the /verify and /compare panes. The TS providers emit generic
 * `chunk` / `progress` / `client_tool_call` / `mcp_ui` frames onto the SSEStream they're handed;
 * verify/compare need those RENAMED to their pane-specific channels so the frontend's verify/compare
 * handlers pick them up. Faithful mirror of PHP's createVerificationSSEClient / createComparisonSSEClient
 * (ChatController.php ~2802/2851): sendProgress→*_progress, sendChunk→*_chunk, sendError→*_error, and
 * sendCustomEvent passthrough — except the comparer namespaces client_tool_call → compare_client_tool_call
 * so the two panes' tool calls don't collide. Implements only what the providers touch (send + isAborted).
 */
class PaneSseSink {
  constructor(
    private readonly real: SSEStream,
    private readonly map: { chunk: string; progress: string; error: string; clientTool: string },
  ) {}
  get isAborted(): boolean {
    return this.real.isAborted;
  }
  send(event: string, data: string | object): void {
    switch (event) {
      case 'chunk':
        this.real.send(this.map.chunk, data);
        break;
      case 'progress':
        this.real.send(this.map.progress, data);
        break;
      case 'error':
        this.real.send(this.map.error, data);
        break;
      case 'client_tool_call':
        this.real.send(this.map.clientTool, data);
        break;
      default:
        // mcp_ui and any other custom event pass through unchanged (mirrors sendCustomEvent).
        this.real.send(event, data);
    }
  }
}

const VERIFY_EVENT_MAP = {
  chunk: 'verifier_chunk',
  progress: 'verification_progress',
  error: 'verification_error',
  clientTool: 'client_tool_call',
} as const;

const COMPARE_EVENT_MAP = {
  chunk: 'compare_chunk',
  progress: 'compare_progress',
  error: 'compare_error',
  clientTool: 'compare_client_tool_call',
} as const;

/** Mirrors src/Controllers/ChatController.php (the /chat streaming + non-streaming path). */
export class ChatController {
  private static readonly PROVIDER_REQUIRED =
    "This method requires $options['provider']. Silent fallback to a default provider has been removed.";

  // Server-tool registry (Phase 2: one stub; Phase 3 adds the real Functions/* + MCP).
  private readonly toolsManager: ToolsManager;

  constructor() {
    this.toolsManager = new ToolsManager();
    SearchFunctions.register(this.toolsManager);
  }

  /**
   * Extract the upstream provider's HTTP status from an error so it percolates to the client instead
   * of being masked as a generic 500. Provider errors are formatted `"<provider> API error: <code> …"`;
   * we also map any rate-limit phrasing to 429. Returns null when the error isn't an upstream API error
   * (a real server bug) → caller uses 500.
   */
  private providerErrorStatus(raw: string): number | null {
    const m = /API error:\s*(\d{3})\b/.exec(raw ?? '');
    if (m) {
      const c = parseInt(m[1], 10);
      if (c >= 400 && c <= 599) return c;
    }
    if (/\b429\b|rate.?limit/i.test(raw ?? '')) return 429;
    return null;
  }

  /** Faithful port of ChatController::humanizeProviderError. */
  private humanizeProviderError(raw: string): string {
    const msg = (raw ?? '').replace(/([?&])(?:key|api[_-]?key|access_token|x-api-key)=[^&\s"]+/gi, '$1[REDACTED]=…');
    // Model server offline: gateway reachable but no backend to serve the model (e.g. self-hosted
    // model host down / not loaded). Distinct from transient overload; checked BEFORE the generic
    // 5xx branch since it's usually a 503 too.
    if (/no (available|healthy) (server|upstream|model|worker|backend|instance)|no (server|model|backend|worker) available|model (is )?not (loaded|available|ready)|upstream connect error/i.test(msg))
      return "🚫 This model's server is currently offline — the provider's gateway responded but has no backend available to serve the model right now. This usually isn't temporary: try again later, or switch to a different provider in the picker above.";
    if (/\b(50[023]|52[39])\b|Service Unavailable|currently experiencing high demand|overloaded|temporarily unavailable/i.test(msg))
      return '⏳ The model provider is temporarily overloaded. Please try again in a moment, or switch to a different provider in the picker above.';
    if (/\b429\b|rate.?limit/i.test(msg))
      return '⏳ Rate limit reached for this provider. Please wait a moment before trying again, or switch providers.';
    if (/\b401\b|invalid.?api.?key|authentication.?failed|unauthorized/i.test(msg))
      return '🔑 Authentication failed for this provider. Check the API key in your settings.';
    if (/context.{0,20}length|context.?window|token.{0,20}(exceed|limit)|prompt.?too.?long/i.test(msg))
      return "📏 The input is too large for this model's context window. Try shortening the conversation, removing attachments, or switching to a model with a larger context.";
    if (/quota|billing|credit balance|insufficient.?credit|payment.?required/i.test(msg))
      return '💳 The provider rejected the request for billing reasons (quota or credits). Check your provider account, then retry.';
    if (/connection.?refused|connection.?reset|timed.?out|timeout|network.?unreachable|could not resolve/i.test(msg))
      return "🌐 Couldn't reach the provider. Check your network and try again, or switch providers.";
    if (msg.length > 400) return msg.slice(0, 380) + '… (full error in server log)';
    return msg;
  }

  /** Mirrors ChatController::sanitizeClientTools: keep well-formed webMCP tools only. */
  private sanitizeClientTools(raw: any): Array<{ name: string; description?: string; input_schema?: any }> {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t) => t && typeof t === 'object' && typeof t.name === 'string' && /^webmcp_/.test(t.name) && t.input_schema && typeof t.input_schema === 'object',
    );
  }

  /** Mirrors ChatController::sanitizeSkillMetadata — clean {dir_name, scripts} or null. */
  private sanitizeSkillMetadata(raw: any): SkillMetadata | null {
    if (raw === null || typeof raw !== 'object') return null;
    const dirName = typeof raw.dir_name === 'string' ? raw.dir_name.trim() : '';
    if (dirName === '') return null;
    if (dirName.length > 128) return null;
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(dirName)) return null;
    if (dirName.includes('..')) return null;

    const scripts: string[] = [];
    if (Array.isArray(raw.scripts)) {
      for (const raw_s of raw.scripts) {
        if (typeof raw_s !== 'string') continue;
        const s = raw_s.trim();
        if (s === '' || s.startsWith('/') || s.includes('..')) continue;
        scripts.push(s);
      }
    }
    if (scripts.length === 0) return null;
    return { dir_name: dirName, scripts: Array.from(new Set(scripts)) };
  }

  /** Mirrors ChatController::sanitizeAvailableSkills — array of clean skill records or []. */
  private sanitizeAvailableSkills(raw: any): AvailableSkill[] {
    if (!Array.isArray(raw)) return [];
    const out: AvailableSkill[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const dirName = typeof entry.dir_name === 'string' ? entry.dir_name.trim() : '';
      if (dirName === '' || seen.has(dirName)) continue;
      if (dirName.length > 128) continue;
      if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(dirName)) continue;
      if (dirName.includes('..')) continue;

      const description = typeof entry.description === 'string' ? entry.description.trim() : '';

      const scripts: string[] = [];
      if (Array.isArray(entry.scripts)) {
        for (const raw_s of entry.scripts) {
          if (typeof raw_s !== 'string') continue;
          const s = raw_s.trim();
          if (s === '' || s.startsWith('/') || s.includes('..')) continue;
          scripts.push(s);
        }
      }
      const uniq = Array.from(new Set(scripts));
      if (uniq.length === 0) continue;

      seen.add(dirName);
      out.push({ dir_name: dirName, description, scripts: uniq });
    }
    return out;
  }

  /** True when a run_skill_script call has already happened in this conversation (mirrors PHP). */
  private hasPriorRunSkillScript(history: any[]): boolean {
    for (const h of history) {
      if (!h) continue;
      if (h.role === 'tool' && h.name === 'run_skill_script') return true;
      if (h.role === 'assistant' && Array.isArray(h.tool_calls)) {
        for (const tc of h.tool_calls) {
          const name = tc?.function?.name ?? tc?.name ?? '';
          if (name === 'run_skill_script') return true;
        }
      }
    }
    return false;
  }

  private buildOptions(body: Record<string, any>, userId: number | null): ChatOptions {
    const clientTools = this.sanitizeClientTools(body.client_tools);
    const clientToolNames = clientTools.map((t) => t.name);
    const conversationHistory = Array.isArray(body.conversation_history) ? body.conversation_history : [];

    const skillContent = typeof body.skill_content === 'string' ? body.skill_content.trim() : '';
    const skillMetadata = this.sanitizeSkillMetadata(body.skill_metadata ?? null);
    const availableSkills = this.sanitizeAvailableSkills(body.available_skills ?? null);

    const opts: ChatOptions = {
      message: typeof body.message === 'string' ? body.message : '',
      conversation_history: conversationHistory,
      system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt : undefined,
      client_tools: clientTools,
      client_tool_names: clientToolNames,
      user_id: userId,
    };

    // Skill-tool routing. The skill tools are CLIENT-SIDE (run_skill_script /
    // discover_skill / Task are in every provider's CLIENT_SIDE_TOOL_NAMES),
    // so they are appended to the same per-request client_tools list the
    // webMCP tools use — that is the only channel a TS provider declares
    // per-request tools through. The provider's all-client short-circuit then
    // returns pending_client_tool_call instead of executing them server-side.
    if (skillMetadata !== null) {
      // Single active skill (chip override): declare run_skill_script (+ Task)
      // and force tool_choice toward run_skill_script when no run_skill_script
      // round has happened yet this conversation.
      clientTools.push(ChatController.buildRunSkillScriptTool(skillMetadata));
      clientTools.push(ChatController.buildTaskTool());
      clientToolNames.push('run_skill_script', 'Task');
      opts.skill_metadata = skillMetadata;

      if (!this.hasPriorRunSkillScript(conversationHistory)) {
        // Provider-conditional forcing form: bare 'required' for grok/deepseek
        // (which silently ignore the specific-function form), specific-function
        // for everyone else. Each provider translates this into its native shape.
        const providerName = String(body.provider ?? '').toLowerCase();
        if (providerName === 'grok' || providerName === 'deepseek') {
          opts.tool_choice = 'required';
        } else {
          opts.tool_choice = { type: 'function', function: { name: 'run_skill_script' } };
        }
      }
    } else if (availableSkills.length > 0) {
      // Multi-skill auto-routing: declare discover_skill + the multi-skill
      // run_skill_script. No tool_choice forcing — the model decides whether
      // to call any skill at all based on intent (matching MCP-tool routing).
      clientTools.push(ChatController.buildDiscoverSkillTool(availableSkills));
      clientTools.push(ChatController.buildMultiSkillTool(availableSkills));
      clientToolNames.push('discover_skill', 'run_skill_script');
      opts.available_skills = availableSkills;
    }

    // Active Skill from the Skills Library (dragged onto prompt input) — the
    // provider's buildSystemPrompt appends this after the persona.
    if (skillContent !== '') {
      opts.skill_content = skillContent;
    }

    return opts;
  }

  /** Per-request executor: base tools (+ the user's MCP tools when any exist). Fails soft. */
  private async buildExecutor(userId: number | null): Promise<FunctionExecutor> {
    try {
      const mcpLoader = new MCPToolsLoader();
      await mcpLoader.loadToolsForUser(userId);
      if (mcpLoader.hasTools()) return new CombinedToolsExecutor(this.toolsManager, mcpLoader);
    } catch (e: any) {
      console.error('[chat] MCP load failed:', e?.message ?? e);
    }
    return this.toolsManager;
  }

  private async resolveProvider(provider: string | null, userId: number | null): Promise<LLMProvider> {
    if (!provider) throw new Error(ChatController.PROVIDER_REQUIRED);
    const cfg = await LLMProviderResolver.getProviderConfig(provider);
    if (!cfg) throw new Error(`Provider '${provider}' not available`);
    const impl = ProviderFactory.create(cfg); // throws for not-yet-ported formats
    impl.setFunctionExecutor(await this.buildExecutor(userId));
    return impl;
  }

  private async handleStreamingChat(req: Request, res: Response, provider: string | null, opts: ChatOptions): Promise<void> {
    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    try {
      const impl = await this.resolveProvider(provider, opts.user_id ?? null);
      const result: ChatResult = await impl.streamChat(opts, sse);

      const providerResp: Record<string, any> = {
        text: result.text, usage: result.usage, model: result.model, provider: result.provider,
        functions_called: [], mcp_tools_called: [], mcp_calls_count: 0,
      };
      const controllerResp: Record<string, any> = { success: true, text: result.text, usage: result.usage, provider: result.provider };
      if (result.pending_client_tool_call) {
        for (const r of [providerResp, controllerResp]) {
          r.pending_client_tool_call = true;
          r.pending_tool_calls = result.pending_tool_calls;
        }
      }
      sse.send('response', providerResp);
      sse.send('complete', { status: 'done' });
      sse.send('response', controllerResp);

      // Inline verification / comparison (turn-level) — mirrors PHP handleStreamingChat running
      // handleVerification/handleComparison from the /chat stream after the primary response, BEFORE
      // the final 'complete'. Skipped when the primary returned a pending client-tool call (they run on
      // the real turn after the tool round) and when the verifier/comparer equals the primary provider.
      const vcBody = req.body ?? {};
      const isPending = !!result.pending_client_tool_call;
      const verifierProvider: string | null = vcBody.verifier_provider ?? null;
      if (!isPending && vcBody.verification_enabled && verifierProvider && verifierProvider !== provider) {
        await this.runVerification(sse, opts.message ?? '', result.text ?? '', verifierProvider, opts.user_id ?? null);
      }
      const compareProvider: string | null = vcBody.compare_provider ?? null;
      if (!isPending && vcBody.compare_enabled && compareProvider && compareProvider !== provider) {
        await this.runComparison(sse, vcBody, compareProvider, opts.message ?? '', opts.user_id ?? null);
      }

      sse.send('complete', { status: 'done' });
      sse.end();
    } catch (e: any) {
      if (e?.message === 'CLIENT_ABORTED') return;
      const raw = e?.message ?? 'Unknown error';
      const code = this.providerErrorStatus(raw) ?? 500;
      try {
        sse.send('error', { error: true, message: raw, code });
        sse.send('error', { message: this.humanizeProviderError(raw) });
      } catch {
        /* connection gone */
      }
      sse.end();
    }
  }

  private async handleRegularChat(res: Response, provider: string | null, opts: ChatOptions): Promise<void> {
    try {
      const impl = await this.resolveProvider(provider, opts.user_id ?? null);
      const result = await impl.chat(opts);
      const body: Record<string, any> = { success: true, text: result.text, usage: result.usage, provider: result.provider };
      if (result.pending_client_tool_call) {
        body.pending_client_tool_call = true;
        body.pending_tool_calls = result.pending_tool_calls;
      }
      res.status(200).json(body);
    } catch (e: any) {
      // Percolate the upstream provider's status (e.g. 429 rate-limit) instead of masking as 500,
      // and humanize the message. A non-provider error (real bug) has no extractable code → 500.
      const raw = e?.message ?? 'Unknown error';
      const status = this.providerErrorStatus(raw) ?? 500;
      res.status(status).json({ success: false, error: this.humanizeProviderError(raw) });
    }
  }

  /**
   * Build the JSON-Schema tool definition for run_skill_script (single-skill).
   * Mirrors ChatController::buildRunSkillScriptTool — description copied verbatim.
   */
  private static buildRunSkillScriptTool(metadata: SkillMetadata): any {
    const dirName = metadata.dir_name;
    const scripts = metadata.scripts;

    const description =
      'Execute one of the Python scripts bundled with the active skill "' + dirName + '". ' +
      'This tool IS available to you and you should call it whenever the user\'s ' +
      'request maps to one of the skill\'s scripts — do not attempt the transformation ' +
      'manually if a script can do it. Available scripts: ' +
      scripts.join(', ') + '.\n\n' +
      'RUNTIME CONTRACT:\n' +
      '• ATTACHMENTS — any document(s) the user attached are pre-written to ' +
      '/scratch/<original-filename>. Reference them by that absolute path in argv ' +
      '(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that ' +
      'wastes output tokens.\n' +
      '• INPUT FILES YOU AUTHOR INLINE — when a script needs synthesized input you ' +
      'compose yourself (a JSON spec, a complete HTML document, an ops file, etc.), ' +
      'put the content in input_files under a /scratch/<name>.<ext> key, then ' +
      'reference that path from argv. The exact format and extension required vary by ' +
      'skill — **read the skill\'s body (provided as system context) to learn the ' +
      'contract**. Do not assume create-style scripts always take JSON: some expect a ' +
      'full HTML/MD document, some a JSON spec, some a CSV. The skill\'s docs are ' +
      'authoritative.\n' +
      '  ‼ VALUE SHAPE — each input_files value MUST be the file body as a plain string. ' +
      'Do NOT wrap it as {<path>: <content>} (that produces a JSON object as the file ' +
      'content, which the script will write back out verbatim and the artifact pane ' +
      'will display as broken JSON instead of HTML). For an HTML file write the literal ' +
      'characters of the document starting with <!DOCTYPE html>; for a JSON spec write ' +
      'the JSON object the script\'s contract specifies. The /scratch/ path is the OUTER ' +
      'input_files key only — never repeat it inside the value.\n' +
      '• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via ' +
      '-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n' +
      '• FILENAME — when transforming an attached document, keep the original basename ' +
      'and extension; the output lives in /outputs/, no \'-formatted\' suffix needed.';

    // NOTE: the input_files property description below intentionally contains
    // LITERAL "\n" / "\"" sequences (backslash-n, backslash-quote) — the PHP
    // source builds it with single-quoted strings, so PHP emits the two-char
    // escapes rather than real newlines/quotes. Faithful byte-for-byte mirror.
    return {
      name: 'run_skill_script',
      description,
      input_schema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Path to the script within the skill folder. Must be one of the listed scripts.',
            enum: scripts,
          },
          argv: {
            type: 'array',
            description: 'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/ — that is where generated documents are persisted to the user filesystem.',
            items: { type: 'string' },
          },
          input_files: {
            type: 'object',
            description:
              'Map of absolute path → file CONTENT to stage before the script ' +
              'runs. Use this for files YOU author inline (JSON specs, HTML ' +
              'documents, CSVs). The user\'s attachments are already at ' +
              '/scratch/<filename>; do NOT re-pass their contents here.\\n\\n' +
              'EACH VALUE IS A PLAIN STRING — the literal file body. Start an ' +
              'HTML value with `<!DOCTYPE html>` and emit the document character ' +
              'by character. DO NOT wrap the body in a JSON object that repeats ' +
              'the path — that pattern roughly DOUBLES the output tokens you ' +
              'spend (every `"` becomes `\\"`, every newline becomes `\\n`, plus ' +
              'the duplicated path key) AND the artifact pane will display the ' +
              'wrap as broken JSON instead of your HTML. The lean form costs ' +
              'you less time and produces the right output.\\n\\n' +
              'Example for a 2-byte HTML file:\\n' +
              '  CORRECT (efficient): {"/scratch/foo.html": "<!DOCTYPE html><html><body>Hi</body></html>"}\\n' +
              '  WRONG (wasteful):    {"/scratch/foo.html": "{\\"/scratch/foo.html\\": \\"<!DOCTYPE html><html><body>Hi</body></html>\\"}"}',
            additionalProperties: { type: 'string' },
          },
          read_outputs: {
            type: 'array',
            description: 'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> for files the script wrote to the outputs folder; skill-relative paths still work for files inside the skill mount. NOTE: when an output is an HTML or Markdown document, it is shown to the user in a separate artifact pane and the file content in the tool_result will be replaced with a short placeholder — do not quote, restate, or attempt to re-read the file in that case. Summarize what the script did from stdout/stderr instead.',
            items: { type: 'string' },
          },
        },
        required: ['script'],
      },
    };
  }

  /**
   * Build the JSON-Schema tool definition for the `Task` tool.
   * Mirrors ChatController::buildTaskTool — description copied verbatim.
   */
  private static buildTaskTool(): any {
    return {
      name: 'Task',
      description:
        'Spawn an isolated single-shot subagent. The subagent runs in a fresh ' +
        'context with no tools, no prior conversation history, and the agent file ' +
        '`agents/<subagent_type>.md` from the active skill as its system prompt. ' +
        'Returns the subagent\'s text response as the tool_result.\n\n' +
        'Use this for grading, comparing, analyzing, or any other task that needs ' +
        'an independent LLM judgment without polluting the current conversation. ' +
        'The subagent has access only to what you pass in `prompt` — load any ' +
        'context the subagent needs into that string. The `subagent_type` must ' +
        'match the basename (without .md) of a file in the active skill\'s ' +
        '`agents/` folder.',
      input_schema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A short (3-5 word) description of the task, for telemetry. Not seen by the subagent.',
          },
          subagent_type: {
            type: 'string',
            description: 'Basename (no .md) of an agent file in the active skill\'s agents/ folder. Example: "grader" loads agents/grader.md as the subagent\'s system prompt.',
          },
          prompt: {
            type: 'string',
            description: 'The work the subagent should do. Include any context, data, or instructions the subagent needs — it has no other access.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the subagent. Defaults to the active provider\'s configured model. Only meaningful when paired with a `provider` that knows the model name.',
          },
          provider: {
            type: 'string',
            enum: ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi'],
            description: 'Optional provider override for the subagent. Useful for cost-routing — e.g. spawn a deepseek subagent to do bulk grading at ~10× lower cost than claude. Defaults to the same provider as the primary chat.',
          },
        },
        required: ['description', 'subagent_type', 'prompt'],
      },
    };
  }

  /**
   * Build the multi-skill run_skill_script tool for auto-routing.
   * Mirrors ChatController::buildMultiSkillTool — description copied verbatim.
   */
  private static buildMultiSkillTool(skills: AvailableSkill[]): any {
    const dirNames = Array.from(new Set(skills.map((s) => s.dir_name)));

    const catalogLines = ['Available skills (pick the dir_name whose description best matches what the user is asking for):'];
    for (const s of skills) {
      const desc = s.description !== '' ? s.description : '(no description)';
      const scriptsCsv = s.scripts.join(', ');
      catalogLines.push('  • ' + s.dir_name + ' — ' + desc + ' | scripts: ' + scriptsCsv);
    }
    const catalog = catalogLines.join('\n');

    const description =
      'Execute a Python script bundled with one of the available folder-backed skills. ' +
      'Each skill in the catalog below produces a specific file deliverable.\n\n' +
      'PROGRESSIVE-DISCLOSURE PROTOCOL — MUST follow:\n' +
      'Before calling run_skill_script, you MUST first call `discover_skill` with the ' +
      'dir_name you intend to use. discover_skill returns the full SKILL.md body for ' +
      'that skill — including the input-file contract (JSON spec? complete HTML? CSV?), ' +
      'the example tool-call shape, and any skill-specific rules. The catalog below ' +
      'gives you only enough to pick a skill; the body tells you HOW to call it. ' +
      'Skipping discover_skill leads to malformed run_skill_script calls because the ' +
      'input shape varies by skill (some expect a JSON spec, some expect a complete ' +
      'HTML document inline, some expect a CSV) and you cannot reliably guess.\n\n' +
      'WHEN TO CALL run_skill_script — non-negotiable rule:\n' +
      'If the user is asking you to PRODUCE, GENERATE, CREATE, MAKE, BUILD, EDIT, or ' +
      'DELIVER a file in any of the formats listed in the catalog (HTML pages, Word docs, ' +
      'spreadsheets, presentations, etc.), you MUST call this tool. Do NOT inline file ' +
      'content in your text response — your text reply should be a short narration of ' +
      'what you produced. The tool writes the file to /outputs/ where the user previews ' +
      'it; an inline response gives the user nothing they can save or open.\n\n' +
      'WHEN NOT TO CALL — narrow exceptions:\n' +
      'Skip the tool only when the user is asking a question, having a discussion, ' +
      'summarizing/analyzing an attached document (the converter already gave you its ' +
      'text — read it directly and respond in chat), or making a request that genuinely ' +
      'doesn\'t map to any listed skill. NOTE: "use the attachment as a template / style ' +
      'reference" is NOT an exception — it\'s the core use case for create-style scripts. ' +
      'Author the new file inline as the script\'s input and call the tool; the skill ' +
      'produces the deliverable file.\n\n' +
      'URL ARGUMENTS — YOU DO NOT NEED NETWORK ACCESS:\n' +
      'If a script accepts a URL in argv (e.g. an audit/scraper skill), the runner\'s ' +
      'bridge pre-fetches that URL server-side via the user\'s own backend BEFORE the ' +
      'script runs. You — the LLM — never need to download anything. Pass the URL ' +
      'verbatim in argv as if it were a local file path; the bridge replaces it with the ' +
      'local path of the downloaded HTML and appends --source <original-url>. ' +
      'Consequences: localhost, 127.0.0.1, intranet URLs, and any URL the user can reach ' +
      'from their own machine all work — because the fetch runs on the user\'s machine, ' +
      'not yours. NEVER refuse a URL-based task with phrases like \'I cannot access ' +
      'localhost\' or \'I don\'t have network access\' — those refusals are wrong and ' +
      'forbidden. Call the tool with the URL in argv; if the bridge can\'t reach the URL ' +
      '(auth-walled etc.) you will get a clear [bridge] error in the tool_result, which ' +
      'is the only legitimate moment to surface a failure.\n\n' +
      catalog + '\n\n' +
      'RUNTIME CONTRACT (applies to every skill):\n' +
      '• ATTACHMENTS — any document(s) the user attached are pre-written to ' +
      '/scratch/<original-filename>. Reference them by that absolute path in argv ' +
      '(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that ' +
      'wastes output tokens.\n' +
      '• INPUT FILES YOU AUTHOR INLINE — the exact shape (JSON spec vs full HTML ' +
      'document vs CSV) is determined by the skill — read the body returned by ' +
      'discover_skill before guessing.\n' +
      '• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via ' +
      '-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n' +
      '• FILENAME — when transforming an attached document, keep the original basename ' +
      'and extension; the output lives in /outputs/, no \'-formatted\' suffix needed.';

    return {
      name: 'run_skill_script',
      description,
      input_schema: {
        type: 'object',
        properties: {
          dir_name: {
            type: 'string',
            description: "Which skill to invoke. Pick based on the user's intent and the skill descriptions in the tool description.",
            enum: dirNames,
          },
          script: {
            type: 'string',
            description: "Path to the script within the chosen skill (e.g. 'scripts/create.py'). Must be one of the scripts listed for the skill you picked in dir_name.",
          },
          argv: {
            type: 'array',
            description: 'Command-line arguments passed to the script (sys.argv[1:]). Output paths MUST start with /outputs/.',
            items: { type: 'string' },
          },
          input_files: {
            type: 'object',
            description: "Map of absolute path → file contents (string) to stage in the script's filesystem before it runs. Use this for SMALL FILES YOU AUTHOR INLINE — typically the JSON spec for create-style scripts and the ops JSON for edit-style scripts. Common pattern: pass `/scratch/spec.json` or `/scratch/ops.json` here, then reference that path from argv (e.g. `--ops /scratch/ops.json` or `-i /scratch/spec.json`). DO NOT put user-attached document contents here — those are already pre-written to /scratch/<filename> by the runner. Leave empty when the script doesn't need any synthesized inputs.",
            additionalProperties: { type: 'string' },
          },
          read_outputs: {
            type: 'array',
            description: 'Paths whose contents should be returned after the script finishes. Use absolute /outputs/<filename>. NOTE: HTML/Markdown outputs are rendered in a separate artifact pane and the tool_result content is replaced with a placeholder — summarize what the script did from stdout/stderr in that case.',
            items: { type: 'string' },
          },
        },
        required: ['dir_name', 'script'],
      },
    };
  }

  /**
   * Build the discover_skill tool (progressive disclosure).
   * Mirrors ChatController::buildDiscoverSkillTool — description copied verbatim.
   */
  private static buildDiscoverSkillTool(skills: AvailableSkill[]): any {
    const dirNames = Array.from(new Set(skills.map((s) => s.dir_name)));
    return {
      name: 'discover_skill',
      description:
        'Load the full SKILL.md body for a folder-backed skill. Call this ' +
        'BEFORE run_skill_script the first time you intend to use a skill on a turn. ' +
        'Returns the skill\'s complete contract: the input-file shape it expects ' +
        '(JSON spec / complete HTML document / CSV / etc.), the canonical ' +
        'tool-call example, decision rules for when to use which script, and any ' +
        'skill-specific behavior. The catalog in run_skill_script\'s description ' +
        'tells you WHICH skill to pick; this tool tells you HOW to call it. ' +
        'Cheap and local — the body is already loaded in the browser, no network ' +
        'round-trip. Skip this only if you have already received the body for the ' +
        'same dir_name in this conversation.',
      input_schema: {
        type: 'object',
        properties: {
          dir_name: {
            type: 'string',
            description: 'The skill whose body to load. Must match a dir_name ' +
              'from the run_skill_script catalog.',
            enum: dirNames,
          },
        },
        required: ['dir_name'],
      },
    };
  }

  /** POST /api/v1/chat — protected by the global auth middleware. */
  async chat(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const body = ctx.body;

    if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) {
      res.status(400).json({ success: false, error: 'tools must be an array of tool names' });
      return;
    }

    const opts = this.buildOptions(body, ctx.user_id);
    const history = opts.conversation_history;
    const isToolContinuation = history.length > 0 && history[history.length - 1]?.role === 'tool';
    if ((!opts.message || opts.message.trim() === '') && !isToolContinuation) {
      res.status(400).json({ success: false, error: 'Message is required' });
      return;
    }

    const provider: string | null = body.provider ?? null;
    if (body.streaming === true) {
      await this.handleStreamingChat(req, res, provider, opts);
    } else {
      await this.handleRegularChat(res, provider, opts);
    }
  }

  /**
   * Format the current date the way PHP's date() does for the verification prompt:
   *   Y-m-d            → e.g. "2026-06-30"
   *   Y-m-d H:i:s T    → e.g. "2026-06-30 14:23:01 UTC"
   * Uses local server time (matching PHP's default-timezone date()); the value is runtime, only the
   * surrounding prompt template is behavior-critical.
   */
  private static phpDates(): { date: string; dateTime: string } {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const Y = now.getFullYear();
    const M = p(now.getMonth() + 1);
    const D = p(now.getDate());
    const h = p(now.getHours());
    const m = p(now.getMinutes());
    const s = p(now.getSeconds());
    let tz = 'UTC';
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
        .formatToParts(now)
        .find((x) => x.type === 'timeZoneName');
      if (part?.value) tz = part.value;
    } catch {
      /* fall back to UTC */
    }
    return { date: `${Y}-${M}-${D}`, dateTime: `${Y}-${M}-${D} ${h}:${m}:${s} ${tz}` };
  }

  /**
   * POST /api/v1/verify — on-demand verification of an already-completed assistant response.
   * Faithful mirror of ChatController::verify (PHP ~line 913). Streams SSE:
   *   verification_start → verification_progress (×N) → verifier_chunk (×N)
   *     → verification_progress → verification_response → verification_complete
   * Raw Express handler (like /chat); validation returns a 400 JSON BEFORE any SSE headers.
   *
   * DIVERGENCES (pre-existing gaps in the ported TS infra, not invented here):
   *  - checkFreeTrialQuota / UsageLogger are not ported in TS (the /chat path skips them too).
   *  - applyUserApiKeys has no TS carrier: LLMProviderResolver reads only system_llm_settings, so
   *    per-user API keys are NOT overlaid (same as the ported /chat path).
   */
  async verify(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const body = ctx.body;

    const originalMessage = String(body.original_message ?? '').trim();
    const responseText = String(body.response_text ?? '').trim();
    const verifierProvider: string | null = body.verifier_provider ?? null;
    const userId = ctx.user_id;

    if (originalMessage === '' || responseText === '' || !verifierProvider) {
      res.status(400).json({
        success: false,
        error: 'original_message, response_text, and verifier_provider are required',
      });
      return;
    }

    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    await this.runVerification(sse, originalMessage, responseText, verifierProvider, userId);
    sse.end();
  }

  /**
   * Core verification pass — emits verification_* events on `sse`. Does NOT end the stream (the caller
   * decides). Shared by the standalone /verify endpoint AND the inline pass that runs after the primary
   * response in handleStreamingChat (mirrors PHP handleVerification being called from the /chat stream).
   */
  private async runVerification(
    sse: SSEStream,
    originalMessage: string,
    responseText: string,
    verifierProvider: string,
    userId: number | null,
  ): Promise<void> {
    try {
      sse.send('verification_start', { verifier: verifierProvider });

      // Verification prompt — copied VERBATIM from ChatController::verify (PHP ~982).
      const { date: currentDate, dateTime: currentDateTime } = ChatController.phpDates();
      const verificationPrompt =
        'You are a verification assistant. Your task is to analyze the following response for accuracy, completeness, and potential issues.\n\n' +
        `**Current Date:** ${currentDate} (Full timestamp: ${currentDateTime})\n\n` +
        `**Original Question:**\n${originalMessage}\n\n` +
        `**Response to Verify:**\n${responseText}\n\n` +
        '**Your Task:**\n' +
        '1. Check for factual accuracy (use the current date above as reference for time-sensitive information)\n' +
        '2. Identify any errors or omissions\n' +
        '3. Assess the quality of reasoning\n' +
        '4. Provide a brief verification summary\n\n' +
        'Be concise and focus on the most important points.';

      const impl = await this.resolveProvider(verifierProvider, userId);
      const sink = new PaneSseSink(sse, VERIFY_EVENT_MAP) as unknown as SSEStream;
      const opts: ChatOptions = { message: verificationPrompt, conversation_history: [], user_id: userId };
      const result: ChatResult = await impl.streamChat(opts, sink);

      sse.send('verification_response', { success: true, text: result.text ?? '', verifier: verifierProvider });
      sse.send('verification_complete', { status: 'done' });
    } catch (e: any) {
      if (e?.message === 'CLIENT_ABORTED') return;
      const raw = e?.message ?? 'Unknown error';
      try {
        sse.send('verification_error', { message: this.humanizeProviderError(raw) });
        sse.send('verification_complete', { status: 'error' });
      } catch {
        /* connection gone */
      }
    }
  }

  /**
   * POST /api/v1/compare — re-answer the last user message with a different provider (compare pane).
   * Faithful mirror of ChatController::compareOnly (PHP ~line 1082). Streams SSE:
   *   compare_start → compare_progress (×N) → compare_chunk (×N)
   *     → compare_progress → compare_response → compare_complete
   * Raw Express handler (like /chat); validation returns a 400 JSON BEFORE any SSE headers.
   *
   * Skill/tool handling reuses buildOptions (with the provider shimmed to compare_provider so the
   * grok/deepseek tool_choice branch keys off the comparer): single-skill forces run_skill_script,
   * multi-skill adds discover_skill + the catalog tool, no-skill runs base+MCP only. The base+MCP
   * tools reach the provider via resolveProvider's executor; the skill tools ride on client_tools.
   *
   * DIVERGENCES (gaps in the ported TS infra — not invented here):
   *  - stripVisualNoiseFromHistory and AttachmentDispatcher are not ported, so conversation_history is
   *    used as-is and attachment prefixing / native image+pdf attachments are NOT applied.
   *  - checkFreeTrialQuota / UsageLogger not ported (same as the /chat path).
   *  - applyUserApiKeys has no TS carrier (per-user keys not overlaid; same as /chat).
   */
  async compare(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const body = ctx.body;

    const message = String(body.message ?? '').trim();
    const conversationHistory = Array.isArray(body.conversation_history) ? body.conversation_history : [];
    const compareProvider: string | null = body.compare_provider ?? null;
    const userId = ctx.user_id;

    // Allow empty message when the request is a tool-result continuation (last history entry role:'tool').
    let hasToolResultTail = false;
    if (conversationHistory.length > 0) {
      const tail = conversationHistory[conversationHistory.length - 1];
      if (tail && typeof tail === 'object' && tail.role === 'tool') hasToolResultTail = true;
    }
    if ((!hasToolResultTail && message === '') || !compareProvider) {
      res.status(400).json({ success: false, error: 'message and compare_provider are required' });
      return;
    }

    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    await this.runComparison(sse, body, compareProvider, message, userId);
    sse.end();
  }

  /**
   * Core comparison pass — emits compare_* events on `sse`. Does NOT end the stream (caller decides).
   * Shared by the standalone /compare endpoint AND the inline pass in handleStreamingChat.
   */
  private async runComparison(
    sse: SSEStream,
    body: Record<string, any>,
    compareProvider: string,
    message: string,
    userId: number | null,
  ): Promise<void> {
    try {
      sse.send('compare_start', { comparer: compareProvider });

      const impl = await this.resolveProvider(compareProvider, userId);
      // Build the SAME options block the primary /chat path produces (tools / skill_content /
      // tool_choice forcing / skill_metadata / available_skills). Shim provider→compare_provider so
      // buildOptions' grok/deepseek tool_choice branch keys off the comparer, and message→trimmed.
      const opts = this.buildOptions({ ...body, provider: compareProvider, message }, userId);
      const sink = new PaneSseSink(sse, COMPARE_EVENT_MAP) as unknown as SSEStream;

      // Honor the frontend's streaming preference (default true).
      const useStreaming = body.streaming ?? true;
      const result: ChatResult = useStreaming ? await impl.streamChat(opts, sink) : await impl.chat(opts);

      sse.send('compare_response', { success: true, text: result.text ?? '', comparer: compareProvider, usage: result.usage ?? null });
      sse.send('compare_complete', { status: 'done' });
    } catch (e: any) {
      if (e?.message === 'CLIENT_ABORTED') return;
      const raw = e?.message ?? 'Unknown error';
      try {
        sse.send('compare_error', { message: this.humanizeProviderError(raw) });
        sse.send('compare_complete', { status: 'error' });
      } catch {
        /* connection gone */
      }
    }
  }
}
