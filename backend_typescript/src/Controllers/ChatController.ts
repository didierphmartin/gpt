import { Request, Response } from 'express';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { log } from '../Services/Logger';
import { logChatTransaction } from '../Services/UsageLogger';
import { buildCtx, Ctx, ControllerResult } from '../Support/Http';
import { SSEStream } from '../Services/SseStream';
import { UserProviderOverlay } from '../Services/UserProviderOverlay';
import { PackageResolver } from '../Services/PackageResolver';
import { DecisionProviders } from '../Services/DecisionProviders';
import { ProviderFactory } from '../Providers/ProviderFactory';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { CombinedToolsExecutor } from '../Services/CombinedToolsExecutor';
import { FilteredToolsExecutor } from '../Services/FilteredToolsExecutor';
import { SearchFunctions } from '../Functions/SearchFunctions';
import { FunctionExecutor } from '../Contracts/FunctionExecutor';
import { LLMProvider } from '../Contracts/LLMProvider';
import { ChatOptions, ChatResult, ClientTool, NativeAttachment, ProviderConfig, SkillMetadata, AvailableSkill } from '../Contracts/types';
import { AttachmentDispatcher } from '../Services/AttachmentDispatcher';
import { buildMemoryBlock } from '../AgentTeam/UserMemoryRepository';
import { MemoryAutoUpdater } from '../AgentTeam/MemoryAutoUpdater';
import { SessionSearchService } from '../AgentTeam/SessionSearchService';
import { mbLen, mbSub, phpBool, phpEmpty, uniqid } from '../Playbook/php';

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

/** Which skill-tool policy a request follows — PHP's three call sites differ (see skillPlan). */
type SkillPath = 'stream' | 'regular' | 'compare';

/**
 * The server tools a request offers next to its skill tools (PHP options['tools'] +
 * AIPortfolioAssistant::resolveToolsForRequest): 'all' = base + MCP, 'none' = skill turn (base and
 * MCP suppressed), 'mcp' = MCP only (the comparer's multi-skill turn, which bypasses the base merge).
 */
type ServerTools = 'all' | 'none' | 'mcp';

interface SkillPlan {
  /** Skill tools; they ride the per-request client_tools channel (client-side in every provider). */
  tools: any[];
  toolChoice?: string | Record<string, any>;
  serverTools: ServerTools;
}

/** The base tools + MCP loader one request's executor is built from (PHP: an AIPortfolioAssistant). */
interface ToolSet {
  toolsManager: ToolsManager;
  mcpLoader: MCPToolsLoader | null;
}

interface Resolved {
  impl: LLMProvider;
  cfg: ProviderConfig;
  executor: FunctionExecutor;
}

/** What the comparer sees — the same scene as the primary (PHP handleComparison / compareOnly). */
interface CompareScene {
  message: string;
  history: any[];
  skillMetadata: SkillMetadata | null;
  availableSkills: AvailableSkill[];
  skillContent: string;
  imageAttachments: NativeAttachment[];
  pdfAttachments: NativeAttachment[];
}

/** Parsed /chat body (ChatController::chat's locals). */
interface ChatInput {
  message: string;
  history: any[];
  provider: string | null;
  skillContent: string;
  skillMetadata: SkillMetadata | null;
  availableSkills: AvailableSkill[];
  clientTools: ClientTool[];
  systemPrompt: string | null;
  includeMemory: boolean;
  toolsFilter: string[] | null;
  maxTokens: number | null;
  temperature: number | null;
}

/** PHP is_numeric(). */
function isNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** PHP uniqid($prefix, true): the 13-hex id plus a ".dddddddd" entropy suffix. */
function uniqidMore(prefix: string): string {
  return uniqid(prefix) + '.' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}

/** Mirrors src/Controllers/ChatController.php (the /chat streaming + non-streaming path). */
export class ChatController {
  private static readonly PROVIDER_REQUIRED =
    "This method requires $options['provider']. Silent fallback to a default provider has been removed.";

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

  /**
   * Mirrors ChatController::stripVisualNoiseFromHistory: <svg>…</svg> blocks in a history
   * message's string content become a short placeholder before any provider sees them.
   */
  static stripVisualNoiseFromHistory(history: any[]): any[] {
    return history.map((m) => {
      if (m && typeof m === 'object' && typeof m.content === 'string') {
        return { ...m, content: m.content.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '[SVG illustration omitted]') };
      }
      return m;
    });
  }

  /**
   * Mirrors ChatController::sanitizeClientTools: keep {name, description, input_schema} entries whose
   * name is a webMCP tool or one of the browser-resolved tools; description capped at 2048 bytes.
   */
  static sanitizeClientTools(raw: any): ClientTool[] {
    if (!Array.isArray(raw)) return [];
    const out: ClientTool[] = [];
    raw.forEach((entry, i) => {
      if (entry === null || typeof entry !== 'object') {
        console.error(`[ChatController] client_tools[${i}] dropped: not an object`);
        return;
      }
      const name = entry.name ?? null;
      if (
        typeof name !== 'string' ||
        name === '' ||
        !/^(?:webmcp_[a-zA-Z0-9_\-.]{1,120}|route_to|save_playbook_agent|save_workflow|save_automation|install_automation)$/.test(name)
      ) {
        console.error(`[ChatController] client_tools[${i}] dropped: invalid name ` + JSON.stringify(name));
        return;
      }
      let description = typeof entry.description === 'string' ? entry.description : '';
      if (Buffer.byteLength(description) > 2048) description = Buffer.from(description).subarray(0, 2048).toString('utf8');
      const inputSchema = entry.input_schema ?? null;
      if (inputSchema === null || typeof inputSchema !== 'object') {
        console.error(`[ChatController] client_tools[${i}] dropped: input_schema not an array`);
        return;
      }
      out.push({ name, description, input_schema: inputSchema });
    });
    return out;
  }

  /** Mirrors ChatController::sanitizeSkillMetadata — clean {dir_name, scripts} or null. */
  static sanitizeSkillMetadata(raw: any): SkillMetadata | null {
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
  static sanitizeAvailableSkills(raw: any): AvailableSkill[] {
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

  /** True when a run_skill_script round already happened (discover_skill rounds do not count). */
  private static hasPriorRunSkillScript(history: any[]): boolean {
    for (const h of history) {
      if (!h || typeof h !== 'object') continue;
      if (h.role === 'tool' && h.name === 'run_skill_script') return true;
      if (h.role === 'assistant' && Array.isArray(h.tool_calls) && h.tool_calls.length) {
        for (const tc of h.tool_calls) {
          const name = tc?.function?.name ?? tc?.name ?? '';
          if (name === 'run_skill_script') return true;
        }
      }
    }
    return false;
  }

  /** True when any tool round happened (handleRegularChat's looser guard). */
  private static hasPriorToolRound(history: any[]): boolean {
    for (const h of history) {
      if (!h || typeof h !== 'object') continue;
      if (h.role === 'tool') return true;
      if (h.role === 'assistant' && Array.isArray(h.tool_calls) && h.tool_calls.length) return true;
    }
    return false;
  }

  /**
   * The skill tools, tool_choice and server-tool policy of one call — PHP builds these inline in
   * handleStreamingChat ('stream'), handleRegularChat ('regular') and compareOnly/handleComparison
   * ('compare'), and the three differ:
   *  - single skill (chip): run_skill_script + Task, base and MCP suppressed. Forced to
   *    run_skill_script until a run happened — 'stream'/'compare': specific-function form, bare
   *    'required' for grok/deepseek, only run_skill_script rounds count; 'regular': always the
   *    specific-function form, any tool round counts.
   *  - multi-skill (auto-routing): 'stream' declares discover_skill + run_skill_script beside base
   *    and MCP, forcing discover_skill only on a fresh turn that has an attachment and a deliverable
   *    verb; 'regular' declares the catalog run_skill_script only, never forced; 'compare' declares
   *    both beside MCP only.
   *  - no skill: base + MCP.
   */
  private static skillPlan(path: SkillPath, provider: string, message: string, history: any[], skillMetadata: SkillMetadata | null, availableSkills: AvailableSkill[]): SkillPlan {
    if (skillMetadata !== null) {
      const plan: SkillPlan = { tools: [ChatController.buildRunSkillScriptTool(skillMetadata), ChatController.buildTaskTool()], serverTools: 'none' };
      if (path === 'regular') {
        if (!ChatController.hasPriorToolRound(history)) plan.toolChoice = { type: 'function', function: { name: 'run_skill_script' } };
      } else if (!ChatController.hasPriorRunSkillScript(history)) {
        plan.toolChoice = ['grok', 'deepseek'].includes(provider.toLowerCase())
          ? 'required'
          : { type: 'function', function: { name: 'run_skill_script' } };
      }
      return plan;
    }
    if (availableSkills.length > 0) {
      if (path === 'regular') {
        return { tools: [ChatController.buildMultiSkillTool(availableSkills)], serverTools: 'all' };
      }
      const plan: SkillPlan = {
        tools: [ChatController.buildDiscoverSkillTool(availableSkills), ChatController.buildMultiSkillTool(availableSkills)],
        serverTools: path === 'compare' ? 'mcp' : 'all',
      };
      if (path === 'stream') {
        const last = history.length ? history[history.length - 1] : null;
        const isContinuation = !!last && typeof last === 'object' && last.role === 'tool';
        // The marker the frontend's attachment converter prepends to the outgoing message.
        const hasAttachment = message.includes('[The user attached the following document(s)');
        const promptTail = mbSub(message, Math.max(0, mbLen(message) - 600), 600);
        const deliverableSignal =
          /\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise)\b|in the (document|file)\b|attached (html|document|file)/i.test(promptTail);
        if (!isContinuation && hasAttachment && deliverableSignal) {
          plan.toolChoice = { type: 'function', function: { name: 'discover_skill' } };
        }
      }
      return plan;
    }
    return { tools: [], serverTools: 'all' };
  }

  /**
   * The base tool registry of one request (PHP: a fresh AIPortfolioAssistant's ToolsManager — the
   * search functions; the chat paths add the user-scoped session_search) and the user's MCP tools.
   * A tools filter that names no mcp_* tool skips the MCP load entirely; `mcpAllowlist` is the
   * package's server allowlist (verify / compare pass it, the chat paths do not).
   */
  private async loadToolSet(userId: number | null, opts: { sessionSearch: boolean; toolsFilter?: string[] | null; mcpAllowlist?: string[] | null } ): Promise<ToolSet> {
    const toolsManager = new ToolsManager();
    SearchFunctions.register(toolsManager);
    if (opts.sessionSearch && userId !== null) SessionSearchService.registerAsTool(toolsManager, userId);

    const filter = opts.toolsFilter ?? null;
    const wantsMcp = filter === null || filter.some((t) => String(t).startsWith('mcp_'));
    let mcpLoader: MCPToolsLoader | null = null;
    if (wantsMcp) {
      try {
        mcpLoader = new MCPToolsLoader();
        await mcpLoader.loadToolsForUser(userId, opts.mcpAllowlist);
      } catch (e: any) {
        console.error('[MCP] Failed to load MCP tools: ' + (e?.message ?? e));
        mcpLoader = null;
      }
    } else {
      console.error('[MCP] Skipped MCP load: node selected no MCP tools');
    }
    return { toolsManager, mcpLoader };
  }

  /** The executor offering the policy's server tools; a tools filter is an exact allow-list over base + MCP. */
  private static executorFor(set: ToolSet, serverTools: ServerTools, toolsFilter: string[] | null = null): FunctionExecutor {
    const all: FunctionExecutor = set.mcpLoader && set.mcpLoader.hasTools() ? new CombinedToolsExecutor(set.toolsManager, set.mcpLoader) : set.toolsManager;
    if (toolsFilter !== null) return new FilteredToolsExecutor(all, toolsFilter);
    if (serverTools === 'none') return new FilteredToolsExecutor(all, []);
    if (serverTools === 'mcp') {
      const names = set.mcpLoader && set.mcpLoader.hasTools() ? set.mcpLoader.getToolDefinitions().map((t) => t.name) : [];
      return new FilteredToolsExecutor(all, names);
    }
    return all;
  }

  /** The package's MCP server allowlist (null = all servers); fails open. */
  private async resolvePackageMcpAllowlist(userId: number | null): Promise<string[] | null> {
    try {
      return await new PackageResolver().allowedMcpServers(userId);
    } catch (e: any) {
      console.error('[ChatController] MCP allowlist resolution failed: ' + (e?.message ?? e));
      return null;
    }
  }

  /**
   * Mirrors ChatController::checkFreeTrialQuota: a free-plan, non-admin user whose package caps
   * lifetime tokens is refused once the recorded total (decision-model tokens excluded) reaches the
   * cap. Returns the 403 body, or null when the call may proceed. Fails open.
   */
  static async checkFreeTrialQuota(userId: number | null): Promise<ControllerResult | null> {
    if (userId === null || !userId) return null;
    try {
      const user = (await sql<any>`SELECT plan, role FROM users WHERE id = ${userId}`.execute(db)).rows[0];
      if (!user) return null;
      if ((user.role ?? '') === 'admin') return null;
      if ((user.plan ?? 'free') !== 'free') return null;

      let packageQuota: any = null;
      try {
        packageQuota = (await new PackageResolver().resolveForUser(userId)).capabilities?.quota_tokens ?? null;
      } catch (e: any) {
        console.error('[ChatController] Package quota resolution failed: ' + (e?.message ?? e));
        packageQuota = null;
      }
      if (packageQuota === null) return null;
      const quota = Math.trunc(Number(packageQuota)) || 0;

      if ((await sql<any>`SHOW TABLES LIKE 'llm_usage_balance'`.execute(db)).rows.length === 0) return null;

      // Decision-model tokens are recorded but never count toward the quota.
      const decisionKeys = await DecisionProviders.keys();
      const notIn = decisionKeys.length === 0 ? sql`` : sql` AND provider NOT IN (${sql.join(decisionKeys)})`;
      const row = (
        await sql<any>`SELECT COALESCE(SUM(total_tokens), 0) as total FROM llm_usage_balance WHERE user_id = ${userId}${notIn}`.execute(db)
      ).rows[0];
      const totalTokens = Math.trunc(Number(row?.total ?? 0)) || 0;

      if (totalTokens >= quota) {
        const fmt = (n: number) => n.toLocaleString('en-US');
        return {
          success: false,
          error: `Token quota reached. You have used ${fmt(totalTokens)} of ${fmt(quota)} tokens. Please upgrade your plan to continue.`,
          code: 'QUOTA_EXCEEDED',
          usage: { total_tokens: totalTokens, quota },
          status_code: 403,
        };
      }
    } catch (e: any) {
      console.error('[ChatController] Error checking free trial quota: ' + (e?.message ?? e));
    }
    return null;
  }

  /** Snapshot of what a request sends to the LLM (Context tab). Mirrors ChatController::buildLlmContextSnapshot. */
  static buildLlmContextSnapshot(
    provider: string, model: string | null, opts: ChatOptions, serverTools: any[], history: any[], message: string,
    limits: { max_tokens: number | null; temperature: number | null },
  ): Record<string, any> {
    const tools: Array<{ name: string; description: string; source: 'server' | 'client' }> = [];
    for (const t of serverTools) tools.push({ name: String(t?.name ?? ''), description: String(t?.description ?? ''), source: 'server' });
    for (const t of opts.client_tools ?? []) tools.push({ name: String((t as any)?.name ?? ''), description: String((t as any)?.description ?? ''), source: 'client' });
    const messages = history
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({ role: String(h.role ?? ''), content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content ?? '') }));
    messages.push({ role: 'user', content: message });
    const systemPrompt = opts.system_prompt ?? '';
    // strlen() counts bytes; the current message is counted on its own and again in messages.
    const bytes = (s: string) => Buffer.byteLength(s);
    const chars = bytes(systemPrompt) + bytes(message) + messages.reduce((n, m) => n + bytes(m.content), 0)
      + bytes(JSON.stringify(serverTools)) + bytes(JSON.stringify(opts.client_tools ?? []))
      + bytes(opts.memory_context ?? '') + bytes(opts.skill_content ?? '');
    return {
      provider, model, max_tokens: limits.max_tokens, temperature: limits.temperature,
      system_prompt: systemPrompt,
      memory_included: !!opts.memory_context,
      memory_context: opts.memory_context ?? '',
      skill_included: !!(opts.skill_content && opts.skill_content.length),
      skill_content: opts.skill_content ?? '',
      messages, tools, estimated_tokens: Math.ceil(chars / 4),
    };
  }

  /**
   * The provider for one call, its resolved config (system_llm_settings → package defaults → the
   * user's own key/endpoint/model/prompt) and the executor it was given. null when the provider is
   * not available (PHP: getProvider() returns null).
   */
  private async resolveProvider(
    provider: string | null,
    userId: number | null,
    executor: FunctionExecutor | null,
    overrides?: { max_tokens?: number | null; temperature?: number | null },
  ): Promise<Resolved | null> {
    if (!provider) throw new Error(ChatController.PROVIDER_REQUIRED);
    const cfg = await UserProviderOverlay.resolve(provider, userId);
    if (!cfg) return null;
    // Per-node overrides (workflow agent form) win over the provider-config defaults.
    if (overrides?.max_tokens != null) cfg.max_tokens = overrides.max_tokens;
    if (overrides?.temperature != null) cfg.temperature = overrides.temperature;
    log.info('[chat] resolved provider config', {
      provider: cfg.provider_key,
      model: cfg.model,
      api_format: cfg.api_format,
      base_url: cfg.base_url,
      chat_endpoint: cfg.chat_endpoint,
      max_tokens: cfg.max_tokens,
      temperature: cfg.temperature,
      overrides,
    });
    const impl = ProviderFactory.create(cfg); // throws for not-yet-ported formats
    if (executor) impl.setFunctionExecutor(executor);
    return { impl, cfg, executor: executor ?? new ToolsManager() };
  }

  /** The chat call's options (the PHP $options block): skill plan, memory, persona, attachments, client tools. */
  private async chatOptions(input: ChatInput, userId: number | null, path: SkillPath): Promise<{ opts: ChatOptions; plan: SkillPlan }> {
    const plan = ChatController.skillPlan(path, input.provider ?? '', input.message, input.history, input.skillMetadata, input.availableSkills);
    // A workflow node's tool filter is an exact allow-list over every declared tool, skill tools included.
    const skillTools = input.toolsFilter === null ? plan.tools : plan.tools.filter((t) => input.toolsFilter!.includes(t.name));
    const clientTools = [...input.clientTools, ...skillTools];
    const opts: ChatOptions = {
      message: input.message,
      conversation_history: input.history,
      client_tools: clientTools,
      client_tool_names: clientTools.map((t) => t.name),
      user_id: userId,
    };
    if (plan.toolChoice !== undefined) opts.tool_choice = plan.toolChoice;
    if (input.skillMetadata !== null) opts.skill_metadata = input.skillMetadata;
    else if (input.availableSkills.length > 0) opts.available_skills = input.availableSkills;
    if (input.includeMemory && userId !== null) {
      const block = await buildMemoryBlock(userId);
      if (block !== '') opts.memory_context = block;
    }
    if (input.skillContent !== '') opts.skill_content = input.skillContent;
    if (input.systemPrompt !== null) opts.system_prompt = input.systemPrompt;
    if (input.toolsFilter !== null) opts.tools = input.toolsFilter;
    return { opts, plan };
  }

  private async handleStreamingChat(req: Request, res: Response, input: ChatInput, opts: ChatOptions, plan: SkillPlan, userId: number | null): Promise<{ result: ChatResult; sessionId: string } | null> {
    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    const provider = input.provider;
    const started = Date.now();
    const sessionId = uniqidMore('chat_');
    try {
      const tools = await this.loadToolSet(userId, { sessionSearch: true, toolsFilter: input.toolsFilter });
      const executor = ChatController.executorFor(tools, plan.serverTools, input.toolsFilter);
      // PHP's streaming path never applies the max_tokens / temperature overrides.
      const resolved = await this.resolveProvider(provider, userId, executor);
      if (!resolved) throw new Error(`Provider '${provider}' not found`);
      const result: ChatResult = await resolved.impl.streamChat(opts, sse);
      const responseTimeMs = Date.now() - started;

      const providerResp: Record<string, any> = {
        text: result.text, usage: result.usage, model: result.model, provider: result.provider,
        functions_called: result.functions_called ?? [], mcp_tools_called: result.mcp_tools_called ?? [], mcp_calls_count: result.mcp_calls_count ?? 0,
      };
      const controllerResp: Record<string, any> = { success: true, text: result.text, usage: result.usage ?? [], provider: result.provider ?? 'claude' };
      if (result.pending_client_tool_call) {
        for (const r of [providerResp, controllerResp]) {
          r.pending_client_tool_call = true;
          r.pending_tool_calls = result.pending_tool_calls ?? [];
        }
      }
      // Conversations' View Context asks for what was actually sent (return_context).
      if (!phpEmpty(req.body?.return_context)) controllerResp.context = this.contextSnapshot(resolved, result, provider, opts);
      sse.send('response', providerResp);
      sse.send('complete', { status: 'done' });
      sse.send('response', controllerResp);

      // Verification / comparison are turn-level: skipped while the primary waits on a client tool
      // (they run on the real continuation) and when the verifier/comparer is the primary provider.
      const vcBody = req.body ?? {};
      const isPending = !!result.pending_client_tool_call;
      const verifierProvider: string | null = vcBody.verifier_provider ?? null;
      if (!isPending && phpBool(vcBody.verification_enabled ?? false) && verifierProvider && verifierProvider !== provider) {
        const r = await this.runVerification(sse, opts.message, result.text ?? '', verifierProvider, userId, ChatController.executorFor(tools, 'all'), false);
        if (r) this.logPaneUsage(userId, 'verify_', verifierProvider, r, Date.now() - started - responseTimeMs);
      }
      const compareProvider: string | null = vcBody.compare_provider ?? null;
      if (!isPending && phpBool(vcBody.compare_enabled ?? false) && compareProvider && compareProvider !== provider) {
        const scene: CompareScene = {
          message: opts.message, history: input.history, skillMetadata: input.skillMetadata, availableSkills: input.availableSkills,
          skillContent: input.skillContent, imageAttachments: opts.image_attachments ?? [], pdfAttachments: opts.pdf_attachments ?? [],
        };
        const r = await this.runComparison(sse, scene, compareProvider, userId, tools, true, false);
        if (r) this.logPaneUsage(userId, 'compare_', compareProvider, r, Date.now() - started - responseTimeMs);
      }

      sse.send('complete', { status: 'done' });
      sse.end();

      void logChatTransaction({
        user_id: userId,
        session_id: sessionId,
        provider: result.provider ?? 'claude',
        model: result.model ?? 'unknown',
        prompt_tokens: result.usage?.input_tokens ?? 0,
        completion_tokens: result.usage?.output_tokens ?? 0,
        response_time_ms: responseTimeMs,
        status: 'success',
        function_calls_count: result.usage?.function_calls ?? 0,
        functions_called: result.functions_called ?? null,
        mcp_calls_count: result.mcp_calls_count ?? 0,
        mcp_tools_called: result.mcp_tools_called ?? null,
      });
      return { result, sessionId };
    } catch (e: any) {
      const raw = e?.message ?? 'Unknown error';
      if (raw === 'CLIENT_ABORTED') {
        console.error('[ChatController] Client aborted, upstream LLM call cancelled');
        void logChatTransaction({
          user_id: userId, provider: provider ?? 'claude', model: 'unknown', prompt_tokens: 0, completion_tokens: 0,
          response_time_ms: Date.now() - started, status: 'aborted', error_message: 'Cancelled by user',
        });
        return null;
      }
      void logChatTransaction({
        user_id: userId, provider: provider ?? 'claude', model: 'unknown', prompt_tokens: 0, completion_tokens: 0,
        response_time_ms: Date.now() - started, status: 'error', error_message: raw,
      });
      const code = this.providerErrorStatus(raw) ?? 500;
      try {
        sse.send('error', { error: true, message: raw, code });
        sse.send('error', { message: this.humanizeProviderError(raw) });
      } catch {
        /* connection gone */
      }
      sse.end();
      return null;
    }
  }

  private async handleRegularChat(res: Response, input: ChatInput, opts: ChatOptions, plan: SkillPlan, userId: number | null, returnContext: boolean): Promise<ChatResult | null> {
    const provider = input.provider;
    let started = Date.now();
    try {
      const tools = await this.loadToolSet(userId, { sessionSearch: true, toolsFilter: input.toolsFilter });
      const executor = ChatController.executorFor(tools, plan.serverTools, input.toolsFilter);
      const resolved = await this.resolveProvider(provider, userId, executor, { max_tokens: input.maxTokens, temperature: input.temperature });
      if (!resolved) throw new Error(`Provider '${provider}' not found`);
      started = Date.now();
      const result = await resolved.impl.chat(opts);
      const responseTimeMs = Date.now() - started;

      void logChatTransaction({
        user_id: userId,
        provider: result.provider ?? 'claude',
        model: result.model ?? 'unknown',
        prompt_tokens: result.usage?.input_tokens ?? 0,
        completion_tokens: result.usage?.output_tokens ?? 0,
        response_time_ms: responseTimeMs,
        status: 'success',
        function_calls_count: result.usage?.function_calls ?? 0,
        functions_called: result.functions_called ?? null,
        mcp_calls_count: result.mcp_calls_count ?? 0,
        mcp_tools_called: result.mcp_tools_called ?? null,
      });

      const body: Record<string, any> = { success: true, text: result.text, usage: result.usage ?? [], provider: result.provider ?? 'claude', finish_reason: result.finish_reason ?? null };
      if (result.pending_client_tool_call) {
        body.pending_client_tool_call = true;
        body.pending_tool_calls = result.pending_tool_calls ?? [];
        if (result.assistant_reasoning) body.assistant_reasoning = result.assistant_reasoning;
      }
      // Workflow nodes ask for the context they sent (Context tab).
      if (returnContext) body.context = this.contextSnapshot(resolved, result, provider, opts);
      res.status(200).json(body);
      return result;
    } catch (e: any) {
      const raw = e?.message ?? 'Unknown error';
      void logChatTransaction({
        user_id: userId, provider: provider ?? 'claude', model: 'unknown', prompt_tokens: 0, completion_tokens: 0,
        response_time_ms: Date.now() - started, status: 'error', error_message: raw,
      });
      // Percolate the upstream provider's status (e.g. 429) instead of masking it as 500.
      const status = this.providerErrorStatus(raw) ?? 500;
      res.status(status).json({ success: false, error: this.humanizeProviderError(raw) });
      return null;
    }
  }

  /** The Context-tab snapshot: the resolved config's model/limits, the effective persona and the offered tools. */
  private contextSnapshot(resolved: Resolved, result: ChatResult, provider: string | null, opts: ChatOptions): Record<string, any> {
    const cfg = resolved.cfg;
    return ChatController.buildLlmContextSnapshot(
      provider ?? result.provider ?? 'claude',
      cfg.model !== '' ? cfg.model : null,
      // No override → the provider uses its configured persona; report that, not ''.
      { ...opts, system_prompt: opts.system_prompt ?? cfg.system_prompt ?? '' },
      resolved.executor.getToolDefinitions(),
      opts.conversation_history ?? [],
      opts.message ?? '',
      { max_tokens: cfg.max_tokens ?? null, temperature: cfg.temperature ?? null },
    );
  }

  /** Usage row for an inline verifier/comparer pass (its own session id; time net of the primary's). */
  private logPaneUsage(userId: number | null, prefix: string, provider: string, r: ChatResult, responseTimeMs: number): void {
    void logChatTransaction({
      user_id: userId,
      session_id: uniqidMore(prefix),
      provider,
      model: r.model ?? 'unknown',
      prompt_tokens: r.usage?.input_tokens ?? 0,
      completion_tokens: r.usage?.output_tokens ?? 0,
      response_time_ms: responseTimeMs > 0 ? responseTimeMs : 0,
      status: 'success',
      function_calls_count: r.usage?.function_calls ?? 0,
      functions_called: r.functions_called ?? null,
      mcp_calls_count: r.mcp_calls_count ?? 0,
      mcp_tools_called: r.mcp_tools_called ?? null,
    });
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

  /** Parse the /chat body the way ChatController::chat does. */
  private parseChatInput(body: Record<string, any>): ChatInput {
    const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : null;
    return {
      message: typeof body.message === 'string' ? body.message : '',
      history: ChatController.stripVisualNoiseFromHistory(Array.isArray(body.conversation_history) ? body.conversation_history : []),
      provider: body.provider ?? null,
      skillContent: typeof body.skill_content === 'string' ? body.skill_content.trim() : '',
      skillMetadata: ChatController.sanitizeSkillMetadata(body.skill_metadata ?? null),
      availableSkills: ChatController.sanitizeAvailableSkills(body.available_skills ?? null),
      clientTools: ChatController.sanitizeClientTools(body.client_tools ?? null),
      systemPrompt: systemPrompt === '' ? null : systemPrompt,
      // Optional 'memory' flag (default true): API callers (e.g. AI-Dialog) and workflow nodes send false.
      includeMemory: Object.prototype.hasOwnProperty.call(body, 'memory') ? phpBool(body.memory) : true,
      toolsFilter: Array.isArray(body.tools) ? body.tools : null,
      maxTokens: isNumeric(body.max_tokens) ? Math.trunc(Number(body.max_tokens)) : null,
      temperature: isNumeric(body.temperature) ? Number(body.temperature) : null,
    };
  }

  /**
   * Attachment ids uploaded earlier via /chat/upload: text-native files are prepended to the
   * message, images (and PDFs on native-PDF providers) ride the options; skill mode elides bodies to
   * short /scratch/ references. Returns the (possibly prefixed) message.
   */
  private async applyAttachments(body: Record<string, any>, userId: number | null, provider: string | null, skillModeActive: boolean, message: string, target: { image_attachments?: NativeAttachment[]; pdf_attachments?: NativeAttachment[] }, label: string): Promise<string> {
    const attachmentIds: any[] = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
    if (!attachmentIds.length || userId === null) return message;
    try {
      const built = await new AttachmentDispatcher().buildPrefix(attachmentIds, userId, provider, skillModeActive);
      if (built.prefix !== '') message = built.prefix + message;
      if (built.image_attachments.length) target.image_attachments = built.image_attachments;
      if (built.pdf_attachments.length) target.pdf_attachments = built.pdf_attachments;
      if (built.notes.length) console.error(`[${label}] Attachment notes: ` + built.notes.join(' | '));
    } catch (e: any) {
      console.error(`[${label}] Attachment dispatch failed: ` + (e?.message ?? e));
    }
    return message;
  }

  /** POST /api/v1/chat — protected by the global auth middleware. */
  async chat(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const body = ctx.body;
    log.info('[chat] request', {
      provider: body.provider,
      model: body.model,
      streaming: body.streaming,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      tools: Array.isArray(body.tools) ? body.tools.length : body.tools,
      msg_len: (body.message || '').length,
    });

    // App-key auth is scope-gated: an `ak_` key must carry the `chat` scope. JWT users and
    // per-user `uak_` keys are unrestricted.
    if (ctx.auth_type === 'app_key') {
      const scopes = (req as any).app_key_scopes ?? [];
      if (!Array.isArray(scopes) || !scopes.includes('chat')) {
        res.status(403).json({ success: false, error: 'App key not authorized for chat (missing scope "chat")' });
        return;
      }
    }

    if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) {
      res.status(400).json({ success: false, error: 'tools must be an array of tool names' });
      return;
    }

    const input = this.parseChatInput(body);
    const userId = typeof ctx.user_id === 'number' ? ctx.user_id : null;
    const attachments: { image_attachments?: NativeAttachment[]; pdf_attachments?: NativeAttachment[] } = {};
    const skillModeActive = input.skillMetadata !== null || input.availableSkills.length > 0;
    input.message = await this.applyAttachments(body, userId, input.provider, skillModeActive, input.message, attachments, 'ChatController');

    // An empty message is allowed only for a client-tool continuation (tool_result at the tail).
    const history = input.history;
    const isToolResultContinuation = input.message === '' && history.length > 0 && history[history.length - 1]?.role === 'tool';
    if (phpEmpty(input.message) && !isToolResultContinuation) {
      res.status(400).json({ success: false, error: 'Message is required' });
      return;
    }

    const quota = await ChatController.checkFreeTrialQuota(userId);
    if (quota !== null) {
      const { status_code = 403, ...rest } = quota;
      res.status(status_code).json(rest);
      return;
    }

    const streaming = phpBool(body.streaming ?? false);
    const { opts, plan } = await this.chatOptions(input, userId, streaming ? 'stream' : 'regular');
    if (attachments.image_attachments) opts.image_attachments = attachments.image_attachments;
    if (attachments.pdf_attachments) opts.pdf_attachments = attachments.pdf_attachments;

    let result: ChatResult | null;
    let sessionId: string;
    if (streaming) {
      const out = await this.handleStreamingChat(req, res, input, opts, plan, userId);
      result = out?.result ?? null;
      sessionId = out?.sessionId ?? uniqidMore('chat_');
    } else {
      result = await this.handleRegularChat(res, input, opts, plan, userId, !phpEmpty(body.return_context));
      sessionId = uniqidMore('chat_');
    }

    // Post-response tail: failures never affect the user (the response is already sent).
    if (input.includeMemory && userId !== null && result && result.text) {
      await this.runMemoryAutoUpdater(userId, sessionId, input.message, result.text);
    }
  }

  /** PHP's post-response MemoryAutoUpdater run, with the user's resolved Claude config (or ANTHROPIC_API_KEY). */
  private async runMemoryAutoUpdater(userId: number, sessionId: string, message: string, text: string): Promise<void> {
    try {
      // PHP reads $config['claude'] after the user overlay: the user's own Claude key (and entry
      // point) when they have one.
      const claude = await UserProviderOverlay.resolve('claude', userId).catch(() => null);
      const apiKey = claude?.api_key || process.env.ANTHROPIC_API_KEY || '';
      if (apiKey === '') {
        console.error('[ChatController] MemoryAutoUpdater skipped: no Claude API key in merged config or ANTHROPIC_API_KEY env');
        return;
      }
      await new MemoryAutoUpdater(apiKey, claude?.base_url ?? '', claude?.chat_endpoint ?? '').run(userId, sessionId, message, text);
    } catch (e: any) {
      console.error('[ChatController] MemoryAutoUpdater failed: ' + (e?.message ?? e));
    }
  }

  /**
   * POST /api/v1/agent — single-pass LLM call: prompt in, text out. No tools, no history,
   * no streaming, no skill routing. Faithful mirror of ChatController::agent: the free-trial gate,
   * the user's package defaults and own key, then one plain chat. Tools are forced off by attaching
   * no executor and no client_tools (PHP passes `tools: []`).
   */
  async agent(ctx: Ctx): Promise<ControllerResult> {
    const body = ctx.body;
    const prompt = String(body.prompt ?? '').trim();
    const provider: string | null = body.provider ?? null;
    const model = body.model !== undefined && body.model !== null ? String(body.model).trim() : '';
    const system = body.system !== undefined && body.system !== null ? String(body.system) : '';
    const userId = ctx.user_id;

    if (prompt === '') {
      return { success: false, error: 'prompt is required', status_code: 400 };
    }
    if (!provider) {
      return { success: false, error: 'provider is required', status_code: 400 };
    }

    const quota = await ChatController.checkFreeTrialQuota(userId);
    if (quota !== null) return quota;

    try {
      const cfg = await UserProviderOverlay.resolve(provider, userId);
      if (!cfg) {
        return { success: false, error: `Provider '${provider}' not available`, status_code: 400 };
      }
      if (model !== '') cfg.model = model; // PHP: setModel() only when a model was passed

      const impl = ProviderFactory.create(cfg); // throws for not-yet-ported formats
      const opts: ChatOptions = { message: prompt, conversation_history: [], user_id: userId };
      if (system !== '') opts.system_prompt = system;

      const result = await impl.chat(opts);
      return {
        success: true,
        text: result.text ?? '',
        usage: result.usage ?? null,
        provider: result.provider ?? provider,
        model: result.model ?? null,
      };
    } catch (e: any) {
      console.error('[ChatController::agent] ' + (e?.message ?? e));
      return {
        success: false,
        error: this.humanizeProviderError(e?.message ?? 'Unknown error'),
        status_code: 500,
      };
    }
  }

  /**
   * Format the current date the way PHP's date() does for the verification prompt:
   *   Y-m-d            → e.g. "2026-06-30"
   *   Y-m-d H:i:s T    → e.g. "2026-06-30 14:23:01 UTC"
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
   * Faithful mirror of ChatController::verify. Streams SSE:
   *   verification_start → verification_progress (×N) → verifier_chunk (×N)
   *     → verification_response → verification_complete
   * Validation and the quota gate return JSON BEFORE any SSE headers.
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

    const quota = await ChatController.checkFreeTrialQuota(userId);
    if (quota !== null) {
      const { status_code = 403, ...rest } = quota;
      res.status(status_code).json(rest);
      return;
    }

    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    const started = Date.now();
    // A separate assistant in PHP: the search tools (no session_search) + MCP under the package allowlist.
    const tools = await this.loadToolSet(userId, { sessionSearch: false, mcpAllowlist: await this.resolvePackageMcpAllowlist(userId) });
    const r = await this.runVerification(sse, originalMessage, responseText, verifierProvider, userId, ChatController.executorFor(tools, 'all'), true);
    if (r) this.logPaneUsage(userId, 'verify_', verifierProvider, r, Date.now() - started);
    sse.end();
  }

  /**
   * Core verification pass — emits verification_* events on `sse`; does NOT end the stream. Shared by
   * /verify (standalone: an unavailable verifier is an error) and the inline pass after the primary
   * response (PHP handleVerification: an unavailable verifier is skipped). Returns the verifier's
   * result, or null when none ran.
   */
  private async runVerification(
    sse: SSEStream,
    originalMessage: string,
    responseText: string,
    verifierProvider: string,
    userId: number | null,
    executor: FunctionExecutor,
    standalone: boolean,
  ): Promise<ChatResult | null> {
    try {
      sse.send('verification_start', { verifier: verifierProvider });

      // Verification prompt — copied VERBATIM from ChatController::verify.
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
        'Be concise and focus on the most important points.\n' +
        'IMPORTANT: Write your entire verification in the same language as the Response to Verify (if the response is in French, answer in French; if in English, answer in English, etc.).';

      const resolved = await this.resolveProvider(verifierProvider, userId, executor);
      let result: ChatResult | null = null;
      if (!resolved) {
        if (standalone) throw new Error(`Verifier provider '${verifierProvider}' not available`);
      } else {
        const sink = new PaneSseSink(sse, VERIFY_EVENT_MAP) as unknown as SSEStream;
        const opts: ChatOptions = { message: verificationPrompt, conversation_history: [], user_id: userId };
        result = await resolved.impl.streamChat(opts, sink);
        sse.send('verification_response', { success: true, text: result.text ?? '', verifier: verifierProvider });
      }
      sse.send('verification_complete', { status: 'done' });
      return result;
    } catch (e: any) {
      if (e?.message === 'CLIENT_ABORTED') {
        if (standalone) return null;
        throw e; // the primary stream's abort handling owns it
      }
      const raw = e?.message ?? 'Unknown error';
      console.error((standalone ? '[ChatController::verify] Error: ' : 'Verification error: ') + raw);
      try {
        sse.send('verification_error', { message: this.humanizeProviderError(raw) });
        sse.send('verification_complete', { status: 'error' });
      } catch {
        /* connection gone */
      }
      return null;
    }
  }

  /**
   * POST /api/v1/compare — re-answer the last user message with a different provider (compare pane).
   * Faithful mirror of ChatController::compareOnly. Streams SSE:
   *   compare_start → compare_progress (×N) → compare_chunk (×N) → compare_response → compare_complete
   * The comparer sees the primary's scene: skill tools / tool_choice / skill_content and the same
   * attachment treatment (with the comparer as the dispatch target). Validation and the quota gate
   * return JSON BEFORE any SSE headers.
   */
  async compare(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const body = ctx.body;

    let message = String(body.message ?? '').trim();
    const history = Array.isArray(body.conversation_history) ? ChatController.stripVisualNoiseFromHistory(body.conversation_history) : [];
    const compareProvider: string | null = body.compare_provider ?? null;
    const userId = ctx.user_id;
    const skillContent = typeof body.skill_content === 'string' ? body.skill_content.trim() : '';
    const skillMetadata = ChatController.sanitizeSkillMetadata(body.skill_metadata ?? null);
    const availableSkills = ChatController.sanitizeAvailableSkills(body.available_skills ?? null);

    // Allow empty message when the request is a tool-result continuation (last history entry role:'tool').
    const tail = history.length > 0 ? history[history.length - 1] : null;
    const hasToolResultTail = !!tail && typeof tail === 'object' && tail.role === 'tool';
    if ((!hasToolResultTail && message === '') || !compareProvider) {
      res.status(400).json({ success: false, error: 'message and compare_provider are required' });
      return;
    }

    const quota = await ChatController.checkFreeTrialQuota(userId);
    if (quota !== null) {
      const { status_code = 403, ...rest } = quota;
      res.status(status_code).json(rest);
      return;
    }

    const attachments: { image_attachments?: NativeAttachment[]; pdf_attachments?: NativeAttachment[] } = {};
    message = await this.applyAttachments(body, userId, compareProvider, skillMetadata !== null || availableSkills.length > 0, message, attachments, 'ChatController::compareOnly');

    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    const started = Date.now();
    const tools = await this.loadToolSet(userId, { sessionSearch: false, mcpAllowlist: await this.resolvePackageMcpAllowlist(userId) });
    const scene: CompareScene = {
      message, history, skillMetadata, availableSkills, skillContent,
      imageAttachments: attachments.image_attachments ?? [], pdfAttachments: attachments.pdf_attachments ?? [],
    };
    // Honor the frontend's streaming preference (default true).
    const r = await this.runComparison(sse, scene, compareProvider, userId, tools, phpBool(body.streaming ?? true), true);
    if (r) this.logPaneUsage(userId, 'compare_', compareProvider, r, Date.now() - started);
    sse.end();
  }

  /**
   * Core comparison pass — emits compare_* events on `sse`; does NOT end the stream. Shared by
   * /compare (standalone) and the inline pass in handleStreamingChat (PHP handleComparison, always
   * streamed; an unavailable comparer is skipped there). The comparer gets the skill tools only —
   * no webMCP client tools, no persona override, no memory, as in PHP.
   */
  private async runComparison(
    sse: SSEStream,
    scene: CompareScene,
    compareProvider: string,
    userId: number | null,
    tools: ToolSet,
    useStreaming: boolean,
    standalone: boolean,
  ): Promise<ChatResult | null> {
    try {
      sse.send('compare_start', { comparer: compareProvider });

      const plan = ChatController.skillPlan('compare', compareProvider, scene.message, scene.history, scene.skillMetadata, scene.availableSkills);
      const resolved = await this.resolveProvider(compareProvider, userId, ChatController.executorFor(tools, plan.serverTools));
      let result: ChatResult | null = null;
      if (!resolved) {
        if (standalone) throw new Error(`Compare provider '${compareProvider}' not available`);
      } else {
        const opts: ChatOptions = {
          message: scene.message,
          conversation_history: scene.history,
          client_tools: plan.tools,
          client_tool_names: plan.tools.map((t) => t.name),
          user_id: userId,
        };
        if (plan.toolChoice !== undefined) opts.tool_choice = plan.toolChoice;
        if (scene.skillMetadata !== null) opts.skill_metadata = scene.skillMetadata;
        else if (scene.availableSkills.length > 0) opts.available_skills = scene.availableSkills;
        if (scene.skillContent !== '') opts.skill_content = scene.skillContent;
        if (scene.imageAttachments.length) opts.image_attachments = scene.imageAttachments;
        if (scene.pdfAttachments.length) opts.pdf_attachments = scene.pdfAttachments;

        const sink = new PaneSseSink(sse, COMPARE_EVENT_MAP) as unknown as SSEStream;
        result = useStreaming ? await resolved.impl.streamChat(opts, sink) : await resolved.impl.chat(opts);
        sse.send('compare_response', { success: true, text: result.text ?? '', comparer: compareProvider, usage: result.usage ?? null });
      }
      sse.send('compare_complete', { status: 'done' });
      return result;
    } catch (e: any) {
      if (e?.message === 'CLIENT_ABORTED') {
        if (standalone) return null;
        throw e;
      }
      const raw = e?.message ?? 'Unknown error';
      console.error((standalone ? '[ChatController::compareOnly] Error: ' : 'Compare error: ') + raw);
      try {
        sse.send('compare_error', { message: this.humanizeProviderError(raw) });
        sse.send('compare_complete', { status: 'error' });
      } catch {
        /* connection gone */
      }
      return null;
    }
  }
}
