import { sql } from 'kysely';
import { db } from '../db/pools';
import { Agent, buildSystemPrompt, AgentRepository } from './AgentRepository';
import { AgentDelegationFunctions } from './AgentDelegationFunctions';
import { AgentToolsExecutor } from './AgentToolsExecutor';
import { StreamContext } from './StreamContext';
import { SSEStream } from '../Services/SseStream';
import { ToolsManager } from '../Services/ToolsManager';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { CombinedToolsExecutor } from '../Services/CombinedToolsExecutor';
import { LLMProviderResolver } from '../Services/LLMProviderResolver';
import { ProviderFactory } from '../Providers/ProviderFactory';
import { LLMProvider } from '../Contracts/LLMProvider';
import { FunctionExecutor, ToolDefinition } from '../Contracts/FunctionExecutor';
import { ChatOptions, ChatResult } from '../Contracts/types';

/**
 * Exposes an explicit, pre-built tool-definition list to the provider while delegating actual tool
 * EXECUTION to the unfiltered base executor — mirrors the PHP runner, which sets options['tools'] to
 * the (possibly filtered / delegation-only) list it sends to the LLM but keeps the full
 * CombinedToolsExecutor for execution. The TS providers derive the API tool list from
 * functionExecutor.getToolDefinitions(), so this wrapper is how the agent's tool list reaches the API.
 */
class AgentToolDefsExecutor implements FunctionExecutor {
  constructor(private readonly base: FunctionExecutor, private readonly defs: ToolDefinition[]) {}
  execute(name: string, params: any, context?: any): Promise<any> {
    return this.base.execute(name, params, context);
  }
  hasFunction(name: string): boolean {
    return this.base.hasFunction(name);
  }
  isMCPTool(name: string): boolean {
    return this.base.isMCPTool(name);
  }
  getToolDefinitions(): ToolDefinition[] {
    return this.defs;
  }
}

/**
 * Adapter that makes a provider (which writes named `event:` frames to an SSEStream) behave like
 * PHP's agent streamRun: only text deltas reach the wire, wrapped as plain `data: {type:'chunk',...}`
 * frames via the StreamContext. progress / mcp_ui / client_tool_call are dropped (PHP's agent provider
 * has no SSEClient). Only the members the providers actually use are implemented (send + isAborted).
 */
class AgentChunkSink {
  constructor(
    private readonly real: SSEStream,
    private readonly ctx: StreamContext,
    private readonly agentId: number,
    private readonly agentName: string
  ) {}
  get isAborted(): boolean {
    return this.real.isAborted;
  }
  send(event: string, data: string | object): void {
    if (event === 'chunk') {
      this.ctx.emitChunk(typeof data === 'string' ? data : String(data), this.agentId, this.agentName);
    }
    // progress / mcp_ui / client_tool_call: intentionally dropped (faithful to PHP agent streaming).
  }
}

/**
 * Faithful mirror of src/AgentTeam/Services/AgentRunner.php — run() (non-streaming) and streamRun()
 * (SSE) plus the private helpers they use.
 *
 * Provider invocation diverges from PHP's LLMManager/provider pair: we reuse the already-ported TS
 * provider infra (LLMProviderResolver + ProviderFactory + the provider's built-in tool loop). As a
 * result a few PHP option plumbings have no carrier in the TS ChatOptions contract and are documented
 * as fail-open divergences below (temperature / max_tokens / tool_choice / per-agent model override).
 *
 * DEFERRED to Slice 1b (stubbed, see setupFunctionExecutor / buildToolsForAgent):
 *  - getDelegationFunctions() / AgentDelegationFunctions (manager → worker delegation tools)
 *  - ensureSessionSearchRegistered() / SessionSearchService (the session_search tool)
 */
export class AgentRunner {
  // Built-in function tools are NOT ported (empty), consistent with the existing fail-open in
  // AgentController.listTools / ChatController.
  private toolsManager = new ToolsManager();

  private executionContext: Record<string, any> = {};
  private streamContext: StreamContext | null = null;

  // ---- stream-context accessors (mirror PHP) ----
  getStreamContext(): StreamContext | null {
    return this.streamContext;
  }
  setStreamContext(context: StreamContext | null): this {
    this.streamContext = context;
    return this;
  }
  getExecutionContext(): Record<string, any> {
    return this.executionContext;
  }
  setExecutionContext(context: Record<string, any>): this {
    this.executionContext = context;
    return this;
  }

  /**
   * Run an agent with the given input (non-streaming). Uses the provider's built-in tool loop.
   */
  async run(
    agent: Agent,
    input: string,
    conversationHistory: any[] = [],
    userId = 0,
    context: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    // Create execution record
    const executionId = await this.createExecution(agent, userId, input, context);

    // Set execution context for delegation tools
    this.executionContext = {
      current_agent_id: agent.id,
      execution_id: executionId,
      user_id: userId,
      parent_execution_id: context.parent_execution_id ?? null,
      stream_context: this.streamContext,
    };

    // Emit agent_start event
    if (this.streamContext) {
      this.streamContext.emitAgentStart(
        agent.id as number,
        agent.name,
        agent.agentType,
        context.parent_agent_id ?? null,
        executionId
      );
    }

    try {
      // Get the LLM provider (applies the agent's model/temperature/max_tokens overrides)
      const provider = await this.resolveProvider(agent);

      // Set up unified function executor (built-in + MCP; managers also get delegation tools)
      const toolsFilter: string[] | null = context.tools_filter ?? null;
      const tools = await this.setupFunctionExecutor(provider, agent, userId, toolsFilter);

      // Build options + messages
      const opts = this.buildOptions(agent, input, conversationHistory, userId, context);
      // tools[] is exposed to the provider via the executor (AgentToolDefsExecutor); for a manager
      // PHP additionally forces tool_choice='required' — not plumbed (no carrier in ChatOptions).
      void tools;

      const startTime = Date.now();
      const response: ChatResult = await provider.chat(opts);
      const responseTime = Date.now() - startTime;

      const text = response.text ?? '';
      const usage = response.usage ?? {};
      // ChatResult carries no functions_called list (the provider returns []); mirror PHP's
      // $response['functions_called'] ?? [].
      const functionsCalled: any[] = [];

      await this.completeExecution(executionId, { text, usage, tool_calls: functionsCalled }, responseTime);

      if (this.streamContext) {
        this.streamContext.emitAgentComplete(agent.id as number, agent.name, agent.agentType, true, null, executionId);
      }

      const result: Record<string, any> = {
        success: true,
        text,
        usage,
        tools_used: functionsCalled,
        execution_id: executionId,
        agent: { id: agent.id, name: agent.name, type: agent.agentType },
        provider: agent.provider,
        model: agent.model ?? response.model,
        response_time_ms: Math.round(responseTime),
      };

      if (response.pending_client_tool_call) {
        result.pending_client_tool_call = true;
        result.pending_tool_calls = response.pending_tool_calls ?? [];
        result.pending_assistant_text = text;
      }

      return result;
    } catch (e: any) {
      const msg = e?.message ?? 'Unknown error';
      await this.failExecution(executionId, msg);

      if (this.streamContext) {
        this.streamContext.emitAgentComplete(agent.id as number, agent.name, agent.agentType, false, msg, executionId);
      }

      return {
        success: false,
        error: msg,
        execution_id: executionId,
        agent: { id: agent.id, name: agent.name },
      };
    }
  }

  /**
   * Run an agent with streaming response (SSE). The provider streams chunk/progress frames onto
   * `sse` (named events) while the agent-level StreamContext emits plain `data:` frames.
   */
  async streamRun(
    agent: Agent,
    input: string,
    conversationHistory: any[] = [],
    userId = 0,
    sse: SSEStream,
    context: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    // Create execution record (PHP passes [] context here — no parent_execution_id)
    const executionId = await this.createExecution(agent, userId, input, {});

    // The controller already created+set the StreamContext (with the SSE callback). Mirror PHP's
    // root-execution-id bootstrap.
    if (this.streamContext && !this.streamContext.getRootExecutionId()) {
      this.streamContext.setRootExecutionId(executionId);
    }

    // Set execution context
    this.executionContext = {
      current_agent_id: agent.id,
      execution_id: executionId,
      user_id: userId,
      stream_context: this.streamContext,
    };

    // Emit agent_start event
    if (this.streamContext) {
      this.streamContext.emitAgentStart(agent.id as number, agent.name, agent.agentType, null, executionId);
    }

    try {
      const provider = await this.resolveProvider(agent); // applies agent model/temperature/max_tokens

      const toolsFilter: string[] | null = context.tools_filter ?? null;
      await this.setupFunctionExecutor(provider, agent, userId, toolsFilter);

      const opts = this.buildOptions(agent, input, conversationHistory, userId, context);

      // Execute streaming chat. PHP's agent streamRun gives the provider only an $onChunk callback
      // (no SSEClient), so the provider emits NO named progress/event frames — text deltas are wrapped
      // as plain `data: {type:'chunk',text,agent_id,agent_name}` frames via the StreamContext. Route
      // the provider through an adapter that does exactly that (chunk → emitChunk; progress/mcp_ui/
      // client_tool_call dropped), instead of the named-event SSEStream.
      const sink = this.streamContext
        ? (new AgentChunkSink(sse, this.streamContext, agent.id as number, agent.name) as unknown as SSEStream)
        : sse;
      const startTime = Date.now();
      const response: ChatResult = await provider.streamChat(opts, sink);
      const responseTime = Date.now() - startTime;

      const fullText = response.text ?? '';

      await this.completeExecution(
        executionId,
        { text: fullText, usage: response.usage ?? {}, tool_calls: [] },
        responseTime
      );

      if (this.streamContext) {
        this.streamContext.emitAgentComplete(agent.id as number, agent.name, agent.agentType, true, null, executionId);
      }

      return {
        success: true,
        text: fullText,
        usage: response.usage ?? {},
        execution_id: executionId,
      };
    } catch (e: any) {
      const msg = e?.message ?? 'Unknown error';
      await this.failExecution(executionId, msg);

      if (this.streamContext) {
        this.streamContext.emitAgentComplete(agent.id as number, agent.name, agent.agentType, false, msg, executionId);
      }

      // Send error through the stream (plain data frame, same shape PHP's $onChunk emits — note: no
      // timestamp field, agent_id only; this is NOT StreamContext::emitError).
      if (this.streamContext) {
        this.streamContext.emit({ type: 'error', error: msg, agent_id: agent.id });
      }

      return {
        success: false,
        error: msg,
        execution_id: executionId,
      };
    }
  }

  // ========================================
  // Provider / executor / option assembly
  // ========================================

  /**
   * Resolve the provider for an agent, applying the agent's per-run overrides onto the config
   * resolved from system_llm_settings — mirroring PHP: `if ($agent->getModel()) $provider->setModel(...)`
   * and buildOptions' `isset($settings['temperature'|'max_tokens'])` overrides. The TS providers read
   * model/temperature/max_tokens off their config, so we override the config rather than the provider.
   */
  private async resolveProvider(agent: Agent): Promise<LLMProvider> {
    const base = await LLMProviderResolver.getProviderConfig(agent.provider);
    if (!base) throw new Error(`Provider '${agent.provider}' not found`);
    const cfg: any = { ...base };
    if (agent.model) cfg.model = agent.model; // PHP: only when getModel() is truthy
    const settings = agent.settings;
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      if (settings.temperature !== undefined && settings.temperature !== null) cfg.temperature = parseFloat(String(settings.temperature));
      if (settings.max_tokens !== undefined && settings.max_tokens !== null) cfg.max_tokens = parseInt(String(settings.max_tokens), 10);
    }
    return ProviderFactory.create(cfg); // throws for not-yet-ported api_formats
  }

  /**
   * Set up the function executor on the provider and return the agent's tool-definition list.
   *
   * Mirrors AgentRunner::setupFunctionExecutor + buildToolsForAgent: base executor is the
   * CombinedToolsExecutor (built-in [empty] + per-user MCP). Managers get delegation tools (DEFERRED).
   */
  private async setupFunctionExecutor(
    provider: LLMProvider,
    agent: Agent,
    userId: number,
    toolsFilter: string[] | null
  ): Promise<ToolDefinition[]> {
    // DEFERRED (Slice 1b): ensureSessionSearchRegistered() / SessionSearchService — the session_search
    // tool is NOT registered. Stub, fail-open (no session_search tool available to the agent).

    const mcpLoader = new MCPToolsLoader();
    await mcpLoader.loadToolsForUser(userId); // fails soft internally

    const baseExecutor = new CombinedToolsExecutor(this.toolsManager, mcpLoader);

    // Managers get a delegation-aware executor: delegation tool names route to the
    // delegation handlers (with this runner's executionContext); all else → base.
    const executor: FunctionExecutor =
      agent.agentType === 'manager'
        ? new AgentToolsExecutor(baseExecutor, this.getDelegationFunctions(), this)
        : baseExecutor;

    const tools = this.buildToolsForAgent(agent, mcpLoader, toolsFilter);
    provider.setFunctionExecutor(new AgentToolDefsExecutor(executor, tools));
    return tools;
  }

  /** Fresh delegation-functions instance bound to this runner. Mirrors AgentRunner::getDelegationFunctions. */
  private getDelegationFunctions(): AgentDelegationFunctions {
    return new AgentDelegationFunctions(new AgentRepository(), this);
  }

  /**
   * Build tool definitions for an agent. Mirrors AgentRunner::buildToolsForAgent.
   *  - Manager: ONLY delegation tools (delegate_to_agent / list_available_agents / complete_task).
   *  - Worker/Standard: built-in [empty] + ALL MCP tools, then the optional request-level tools_filter.
   *    NOTE the PHP quirk: the agent's own configured `tools` field is NOT used to filter here.
   */
  private buildToolsForAgent(agent: Agent, mcpLoader: MCPToolsLoader, toolsFilter: string[] | null): ToolDefinition[] {
    if (agent.agentType === 'manager') {
      // Managers get ONLY the delegation tools (no built-in / MCP tools) — they must delegate.
      return this.getDelegationFunctions().toolDefinitions();
    }

    const byName = new Map<string, ToolDefinition>();
    for (const tool of this.toolsManager.getToolDefinitions()) byName.set(tool.name, tool); // empty (no builtins)
    for (const tool of mcpLoader.getToolDefinitions()) byName.set(tool.name, tool);
    const allTools = [...byName.values()];

    if (toolsFilter !== null && toolsFilter.length > 0) {
      return allTools.filter((t) => toolsFilter.includes(t.name));
    }
    return allTools;
  }

  /**
   * Build the ChatOptions the provider consumes. Mirrors buildOptions + buildMessages: system prompt
   * from the agent, conversation history filtered to {role, content} entries, user input as message.
   *
   * (divergence) PHP buildOptions also carries temperature/max_tokens from agent settings; the TS
   * providers read those from the resolved provider config, so they are not plumbed here.
   */
  private buildOptions(
    agent: Agent,
    input: string,
    conversationHistory: any[],
    userId: number,
    runContext?: Record<string, any>
  ): ChatOptions {
    const history = (Array.isArray(conversationHistory) ? conversationHistory : []).filter(
      (m) => m && typeof m === 'object' && m.role !== undefined && m.role !== null && m.content !== undefined && m.content !== null
    );
    const opts: ChatOptions = {
      message: input,
      conversation_history: history,
      system_prompt: buildSystemPrompt(agent),
      user_id: userId,
    };

    // Thread the workflow runner's bound-skill wiring into the provider: the extra run_skill_script
    // tool def, its skill_metadata, and the forced tool_choice. The providers short-circuit
    // run_skill_script (a CLIENT_SIDE_TOOL_NAME) into pending_client_tool_call, which the runner's
    // round-trip loop bridges to the browser.
    if (runContext?.extra_tools?.length) {
      opts.client_tools = [...(opts.client_tools ?? []), ...runContext.extra_tools];
    }
    if (runContext?.skill_metadata) {
      opts.skill_metadata = runContext.skill_metadata;
    }
    if (runContext?.tool_choice) {
      opts.tool_choice = runContext.tool_choice;
    }

    return opts;
  }

  // ========================================
  // Execution records (agent_executions)
  // ========================================

  /** Mirrors createExecution: INSERT a 'running' row, return the new id (0 for inline/no-id agents). */
  private async createExecution(agent: Agent, userId: number, input: string, context: Record<string, any>): Promise<number> {
    if (agent.id === null) return 0; // inline agent — no DB row
    try {
      const metadata = JSON.stringify({ provider: agent.provider, model: agent.model, agent_type: agent.agentType });
      const res = await sql`
        INSERT INTO agent_executions
          (agent_id, user_id, parent_execution_id, input, status, metadata)
        VALUES (${agent.id}, ${userId}, ${context.parent_execution_id ?? null}, ${input}, 'running', ${metadata})
      `.execute(db);
      return Number((res as any).insertId ?? 0);
    } catch (e: any) {
      console.error('[AgentRunner] Failed to create execution record:', e?.message ?? e);
      return 0;
    }
  }

  /** Mirrors completeExecution. */
  private async completeExecution(
    executionId: number,
    response: { text?: string; usage?: any; tool_calls?: any[] },
    responseTime: number
  ): Promise<void> {
    if (executionId === 0) return;
    try {
      const usage = response.usage ?? {};
      const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      const toolsCalled = JSON.stringify(
        (response.tool_calls ?? []).map((t) => (t && typeof t === 'object' ? (t.name ?? 'unknown') : t))
      );
      await sql`
        UPDATE agent_executions SET
          status = 'completed',
          output = ${response.text ?? ''},
          prompt_tokens = ${promptTokens},
          completion_tokens = ${completionTokens},
          tokens_used = ${promptTokens + completionTokens},
          response_time_ms = ${Math.trunc(responseTime)},
          tools_called = ${toolsCalled},
          completed_at = NOW()
        WHERE id = ${executionId}
      `.execute(db);
    } catch (e: any) {
      console.error('[AgentRunner] Failed to complete execution record:', e?.message ?? e);
    }
  }

  /** Mirrors failExecution. */
  private async failExecution(executionId: number, error: string): Promise<void> {
    console.error('[AgentRunner] Agent execution failed:', error);
    if (executionId === 0) return;
    try {
      await sql`
        UPDATE agent_executions SET
          status = 'failed',
          error_message = ${error},
          completed_at = NOW()
        WHERE id = ${executionId}
      `.execute(db);
    } catch (e: any) {
      console.error('[AgentRunner] Failed to mark execution as failed:', e?.message ?? e);
    }
  }
}
