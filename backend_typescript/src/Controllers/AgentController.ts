import { Request, Response } from 'express';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult, buildCtx } from '../Support/Http';
import {
  AgentRepository,
  Agent,
  AgentFilters,
  hydrateAgent,
  agentToArray,
  agentToApiArray,
} from '../AgentTeam/AgentRepository';
import { AgentRunner } from '../AgentTeam/AgentRunner';
import { StreamContext } from '../AgentTeam/StreamContext';
import { SSEStream } from '../Services/SseStream';

/**
 * Mirrors src/AgentTeam/Controllers/AgentController.php (CRUD + ordering + tools + categories).
 *
 * executions is a plain DB read of agent_executions (runner not needed). run/chat use the engine.
 *
 * listTools depends on the runner's ToolsManager + MCPToolsLoader (the execution engine, not
 * ported) — builtin/mcp tool discovery fails open to empty lists; the hard-coded delegation tools
 * are preserved so the response shape stays faithful.  // ToolsManager/MCPToolsLoader not ported — fail-open
 */
export class AgentController {
  private repository = new AgentRepository();

  // ---- helpers (mirror the PHP private helpers) ----

  private getUserId(ctx: Ctx): number {
    return Number(ctx.user_id ?? 0);
  }

  private getAgentId(ctx: Ctx): number {
    return Number(ctx.params?.id ?? 0);
  }

  private error(message: string, status = 400): ControllerResult {
    // PHP keeps both `status` (in body) and `status_code` (used for the HTTP status).
    return { success: false, error: message, status, status_code: status };
  }

  /** GET /api/v1/agents */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const query: any = ctx.query ?? {};

    const filters: AgentFilters = {
      agent_type: query.type ?? null,
      provider: query.provider ?? null,
      visibility: query.visibility ?? null,
      search: query.search ?? null,
      category: query.category ?? null,
      limit: query.limit !== undefined && query.limit !== null ? this.intval(query.limit) : 100,
      offset: query.offset !== undefined && query.offset !== null ? this.intval(query.offset) : 0,
    };

    // Remove null filters (mirrors array_filter($filters, fn($v) => $v !== null)).
    for (const k of Object.keys(filters) as (keyof AgentFilters)[]) {
      if (filters[k] === null) delete filters[k];
    }

    const agents = await this.repository.findAccessibleByUser(userId, filters);
    const total = await this.repository.countAccessible(userId);

    return {
      success: true,
      data: agents.map((a) => agentToApiArray(a)),
      meta: {
        total,
        count: agents.length,
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      },
    };
  }

  private intval(v: any): number {
    if (typeof v === 'number') return Math.trunc(v);
    const n = parseInt(String(v), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  /** POST /api/v1/agents */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const data: any = ctx.body ?? {};

    if (!data.name) {
      return this.error('Name is required', 400);
    }

    const agentType = data.agent_type ?? 'standard';
    if (!['standard', 'manager', 'worker'].includes(agentType)) {
      return this.error('Invalid agent_type. Must be: standard, manager, or worker', 400);
    }

    const visibility = data.visibility ?? 'personal';
    if (!['personal', 'workspace', 'public'].includes(visibility)) {
      return this.error('Invalid visibility. Must be: personal, workspace, or public', 400);
    }

    const agent = hydrateAgent({
      user_id: userId,
      team_id: data.team_id ?? null,
      category: data.category ?? null,
      name: data.name,
      description: data.description ?? '',
      agent_type: agentType,
      parent_agent_id: data.parent_agent_id ?? null,
      can_delegate_to: data.can_delegate_to ?? [],
      display_order: data.display_order ?? 0,
      provider: data.provider ?? 'claude',
      model: data.model ?? null,
      instructions: data.instructions ?? '',
      tools: data.tools ?? [],
      visibility: visibility,
      settings: data.settings ?? [],
    });

    try {
      const created = await this.repository.create(agent);
      return {
        success: true,
        data: agentToArray(created),
        message: `Agent '${created.name}' created successfully`,
      };
    } catch (e: any) {
      return this.error('Failed to create agent: ' + (e?.message ?? ''), 500);
    }
  }

  /** GET /api/v1/agents/{id} */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);

    if (!(await this.repository.canUserAccess(userId, agentId))) {
      return this.error('Agent not found', 404);
    }

    const agent = (await this.repository.findById(agentId))!;

    const includeStats = ((ctx.query as any)?.include_stats ?? false) === 'true';
    const data: any = agentToArray(agent);

    if (includeStats) {
      data.stats = await this.repository.getAgentStats(agentId);
    }

    return { success: true, data };
  }

  /** PUT /api/v1/agents/{id} */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);
    const data: any = ctx.body ?? {};

    if (!(await this.repository.isOwner(userId, agentId))) {
      return this.error('Agent not found or access denied', 404);
    }

    const agent = (await this.repository.findById(agentId))!;

    const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k);
    const isset = (k: string) => has(k) && data[k] !== null;

    if (isset('name')) agent.name = data.name;
    if (isset('description')) agent.description = data.description;
    if (has('team_id')) agent.teamId = data.team_id; // array_key_exists — null allowed
    if (has('category')) this.setCategory(agent, data.category); // array_key_exists — null allowed
    if (isset('agent_type')) this.setAgentType(agent, data.agent_type);
    if (isset('parent_agent_id')) agent.parentAgentId = data.parent_agent_id;
    if (isset('can_delegate_to')) agent.canDelegateTo = this.intvalArray(data.can_delegate_to);
    if (isset('provider')) agent.provider = data.provider;
    if (isset('model')) agent.model = data.model;
    if (isset('instructions')) agent.instructions = data.instructions;
    if (isset('tools')) agent.tools = data.tools;
    if (isset('display_order')) agent.displayOrder = this.intval(data.display_order);
    if (isset('visibility')) this.setVisibility(agent, data.visibility);
    if (isset('enabled')) agent.enabled = Boolean(data.enabled);
    if (isset('settings')) agent.settings = data.settings;

    try {
      const updated = await this.repository.update(agent);
      return {
        success: true,
        data: agentToArray(updated),
        message: `Agent '${updated.name}' updated successfully`,
      };
    } catch (e: any) {
      return this.error('Failed to update agent: ' + (e?.message ?? ''), 500);
    }
  }

  private setCategory(agent: Agent, category: any): void {
    agent.category = category === null || category === '' ? null : String(category);
  }

  private setAgentType(agent: Agent, agentType: string): void {
    if (!['standard', 'manager', 'worker'].includes(agentType)) {
      throw new Error(`Invalid agent type: ${agentType}`);
    }
    agent.agentType = agentType;
  }

  private setVisibility(agent: Agent, visibility: string): void {
    if (!['personal', 'workspace', 'public'].includes(visibility)) {
      throw new Error(`Invalid visibility: ${visibility}`);
    }
    agent.visibility = visibility;
  }

  private intvalArray(arr: any): number[] {
    if (!Array.isArray(arr)) return [];
    return arr.map((v) => this.intval(v));
  }

  /** DELETE /api/v1/agents/{id} */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);

    if (!(await this.repository.isOwner(userId, agentId))) {
      return this.error('Agent not found or access denied', 404);
    }

    const agent = (await this.repository.findById(agentId))!;
    const agentName = agent.name;

    try {
      await this.repository.delete(agentId);
      return { success: true, message: `Agent '${agentName}' deleted successfully` };
    } catch (e: any) {
      return this.error('Failed to delete agent: ' + (e?.message ?? ''), 500);
    }
  }

  /** GET /api/v1/agents/categories */
  async listCategories(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const categories = await this.repository.findDistinctCategories(userId);
    return { success: true, data: categories, meta: { count: categories.length } };
  }

  /** PUT /api/v1/agents/categories/rename */
  async renameCategory(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const data: any = ctx.body ?? {};
    const old = String(data.old_name ?? '').trim();
    const neu = String(data.new_name ?? '').trim();
    if (old === '' || neu === '') {
      return this.error('old_name and new_name are required', 400);
    }
    if (old === neu) {
      return { success: true, data: { affected: 0 } };
    }
    const affected = await this.repository.renameCategory(userId, old, neu);
    return { success: true, data: { affected, old_name: old, new_name: neu } };
  }

  /** DELETE /api/v1/agents/categories */
  async deleteCategory(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const body: any = ctx.body ?? {};
    const query: any = ctx.query ?? {};
    const name = String(body.name ?? query.name ?? '').trim();
    if (name === '') {
      return this.error('name is required', 400);
    }
    const affected = await this.repository.clearCategory(userId, name);
    return { success: true, data: { affected, name } };
  }

  /** GET /api/v1/agents/tools */
  async listTools(_ctx: Ctx): Promise<ControllerResult> {
    // ToolsManager/MCPToolsLoader not ported — fail-open (empty builtin + mcp).
    const builtinTools: any[] = [];
    const mcpTools: any[] = [];

    const delegationTools = [
      {
        name: 'delegate_to_agent',
        description: 'Delegate a task to a specialized sub-agent',
        type: 'delegation',
      },
      {
        name: 'list_available_agents',
        description: 'List agents that can be delegated to',
        type: 'delegation',
      },
      {
        name: 'run_agents_parallel',
        description: 'Run multiple agents in parallel',
        type: 'delegation',
      },
    ];

    return {
      success: true,
      tools: {
        builtin: builtinTools,
        mcp: mcpTools,
        delegation: delegationTools,
      },
      counts: {
        builtin: builtinTools.length,
        mcp: mcpTools.length,
        delegation: delegationTools.length,
        total: builtinTools.length + mcpTools.length + delegationTools.length,
      },
    };
  }

  /**
   * GET /api/v1/agents/{id}/executions — execution history for an agent.
   *
   * Mirrors AgentController::executions + AgentRunner::getExecutionHistory (the plain SELECT only;
   * the runner is not ported). PHP does `SELECT *` with PDO::FETCH_ASSOC and no json_decode, so the
   * `json` columns tools_called/metadata come back as raw JSON strings. mysql2 would auto-parse them
   * into objects, so we enumerate the columns and CAST those two to CHAR to stay byte-identical.
   */
  async executions(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);
    const query: any = ctx.query ?? {};

    if (!(await this.repository.canUserAccess(userId, agentId))) {
      return this.error('Agent not found', 404);
    }

    const limit = query.limit !== undefined && query.limit !== null ? this.intval(query.limit) : 50;
    const offset = query.offset !== undefined && query.offset !== null ? this.intval(query.offset) : 0;

    const executions = (
      await sql<any>`
        SELECT id, parent_execution_id, agent_id, user_id, input, output, status, error_message,
               tokens_used, prompt_tokens, completion_tokens, cost_usd, response_time_ms,
               CAST(tools_called AS CHAR) AS tools_called,
               started_at, completed_at,
               CAST(metadata AS CHAR) AS metadata
        FROM agent_executions
        WHERE agent_id = ${agentId}
        ORDER BY started_at DESC
        LIMIT ${sql.lit(limit)} OFFSET ${sql.lit(offset)}`.execute(db)
    ).rows;

    return {
      success: true,
      data: executions,
      meta: {
        count: executions.length,
        limit,
        offset,
      },
    };
  }

  /**
   * POST /api/v1/agents/{id}/run — execute an agent (non-streaming). Returns the runner's JSON
   * object (success/text/usage/...) through the normal handle() wrapper.
   */
  async run(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);
    const data: any = ctx.body ?? {};

    // App-key auth is scope-gated. A JWT-authed user reaches the ownership check unrestricted; an
    // app key must explicitly carry agents:run or agents:run:<id>. (In the TS auth middleware
    // auth_type is never 'app_key', so this is inert — the JWT path is taken.)
    if (ctx.auth_type === 'app_key') {
      const scopes: any[] = (ctx as any).app_key_scopes ?? [];
      const scopeAllowed = scopes.includes('agents:run') || scopes.includes(`agents:run:${agentId}`);
      if (!scopeAllowed) {
        return this.error('App key not authorized for this agent (missing scope agents:run)', 403);
      }
    }

    if (!(await this.repository.canUserAccess(userId, agentId))) {
      return this.error('Agent not found', 404);
    }

    const agent = (await this.repository.findById(agentId))!;

    if (!agent.enabled) {
      return this.error('Agent is disabled', 400);
    }

    const input: string = String(data.input ?? data.message ?? '');
    if (this.phpEmptyString(input.trim())) {
      return this.error('Input message is required', 400);
    }

    const conversationHistory: any[] = data.conversation_history ?? [];

    const toolsFilter = data.tools ?? null;
    if (toolsFilter !== null && !Array.isArray(toolsFilter)) {
      return this.error('tools must be an array of tool names', 400);
    }

    const runner = new AgentRunner();
    const response = await runner.run(agent, input, conversationHistory, userId, { tools_filter: toolsFilter });
    return response as ControllerResult;
  }

  /**
   * POST /api/v1/agents/{id}/chat — execute an agent with streaming (SSE). Raw Express handler.
   *
   * Provider chunk/progress frames are written to the SSEStream (named `event:` frames); the
   * agent-level StreamContext events are written as plain `data: <json>\n\n` frames. Ends with
   * `data: [DONE]\n\n`, mirroring PHP.
   */
  async chat(req: Request, res: Response): Promise<void> {
    const ctx = buildCtx(req);
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);
    const data: any = ctx.body ?? {};

    // --- validations (all done BEFORE SSE headers so error responses stay clean JSON). PHP checks
    // the tools-filter shape AFTER setting SSE headers, which yields a malformed 200+JSON response;
    // Express cannot set status/headers post-flush, so we validate first — same status/message. ---
    if (!(await this.repository.canUserAccess(userId, agentId))) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    const agent = (await this.repository.findById(agentId))!;

    if (!agent.enabled) {
      res.status(400).json({ success: false, error: 'Agent is disabled' });
      return;
    }

    const input: string = String(data.input ?? data.message ?? '');
    if (this.phpEmptyString(input.trim())) {
      res.status(400).json({ success: false, error: 'Input message is required' });
      return;
    }

    const toolsFilter = data.tools ?? null;
    if (toolsFilter !== null && !Array.isArray(toolsFilter)) {
      res.status(400).json({ success: false, error: 'tools must be an array of tool names' });
      return;
    }

    const conversationHistory: any[] = data.conversation_history ?? [];

    // --- SSE setup ---
    const sse = new SSEStream(res);
    sse.start();
    res.on('close', () => {
      if (!res.writableEnded) sse.markAborted();
    });

    // StreamContext callback writes plain `data: <json>\n\n` frames (NOT named events).
    const streamContext = new StreamContext((event) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n');
    }, userId);

    const runner = new AgentRunner();
    runner.setStreamContext(streamContext);

    try {
      await runner.streamRun(agent, input, conversationHistory, userId, sse, { tools_filter: toolsFilter });
    } catch (e: any) {
      // streamRun already routes errors through the StreamContext; this is a final backstop.
      if (e?.message !== 'CLIENT_ABORTED') {
        try {
          if (!res.writableEnded) res.write('data: ' + JSON.stringify({ type: 'error', error: e?.message ?? 'Unknown error' }) + '\n\n');
        } catch {
          /* connection gone */
        }
      }
    }

    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  /** Mirrors PHP empty() for a string (also true for '0'). */
  private phpEmptyString(v: string): boolean {
    return v === '' || v === '0';
  }

  /** POST /api/v1/agents/{id}/duplicate */
  async duplicate(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);
    const data: any = ctx.body ?? {};

    if (!(await this.repository.canUserAccess(userId, agentId))) {
      return this.error('Agent not found', 404);
    }

    const newName = data.name ?? null;

    try {
      const duplicated = await this.repository.duplicate(agentId, userId, newName);
      if (!duplicated) {
        return this.error('Failed to duplicate agent', 500);
      }
      return {
        success: true,
        data: agentToArray(duplicated),
        message: 'Agent duplicated successfully',
      };
    } catch (e: any) {
      return this.error('Failed to duplicate agent: ' + (e?.message ?? ''), 500);
    }
  }

  /** POST /api/v1/agents/{id}/move-up */
  async moveUp(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);

    if (!(await this.repository.isOwner(userId, agentId))) {
      return this.error('Agent not found or access denied', 404);
    }

    try {
      const success = await this.repository.moveAgentUp(agentId);
      if (!success) {
        return this.error('Cannot move agent up (already at top or not in a team)', 400);
      }

      const agent = (await this.repository.findById(agentId))!;
      const teamAgents = await this.repository.findByTeamId(agent.teamId as number);

      return {
        success: true,
        message: 'Agent moved up successfully',
        agents: teamAgents.map((a) => agentToApiArray(a)),
      };
    } catch (e: any) {
      return this.error('Failed to move agent: ' + (e?.message ?? ''), 500);
    }
  }

  /** POST /api/v1/agents/{id}/move-down */
  async moveDown(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const agentId = this.getAgentId(ctx);

    if (!(await this.repository.isOwner(userId, agentId))) {
      return this.error('Agent not found or access denied', 404);
    }

    try {
      const success = await this.repository.moveAgentDown(agentId);
      if (!success) {
        return this.error('Cannot move agent down (already at bottom or not in a team)', 400);
      }

      const agent = (await this.repository.findById(agentId))!;
      const teamAgents = await this.repository.findByTeamId(agent.teamId as number);

      return {
        success: true,
        message: 'Agent moved down successfully',
        agents: teamAgents.map((a) => agentToApiArray(a)),
      };
    } catch (e: any) {
      return this.error('Failed to move agent: ' + (e?.message ?? ''), 500);
    }
  }

  /** POST /api/v1/agents/reorder */
  async reorder(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const data: any = ctx.body ?? {};

    if (this.phpEmpty(data.team_id)) {
      return this.error('team_id is required', 400);
    }

    if (this.phpEmpty(data.agent_ids) || !Array.isArray(data.agent_ids)) {
      return this.error('agent_ids array is required', 400);
    }

    const teamId = this.intval(data.team_id);
    const agentIds: number[] = data.agent_ids.map((v: any) => this.intval(v));

    // Verify user owns all agents in the list.
    for (const agentId of agentIds) {
      if (!(await this.repository.isOwner(userId, agentId))) {
        return this.error('Access denied for agent ID: ' + agentId, 403);
      }
    }

    try {
      const result = await this.repository.updateAgentOrder(agentIds, teamId);

      if (!result.success) {
        return this.error(result.error ?? 'Failed to reorder agents', 500);
      }

      const teamAgentsWithInfo = await this.repository.findByTeamIdWithPipelineInfo(teamId);

      const agents = teamAgentsWithInfo.map((item) => {
        const agentData: any = agentToApiArray(item.agent);
        agentData.pipeline_position = item.pipeline_position;
        agentData.pipeline_label = item.pipeline_label;
        agentData.can_reorder = item.can_reorder;
        return agentData;
      });

      const response: ControllerResult = {
        success: true,
        message: 'Agents reordered successfully',
        agents,
      };

      if (result.reordered) {
        response.notice = result.message;
        response.enforced = true;
      }

      return response;
    } catch (e: any) {
      return this.error('Failed to reorder agents: ' + (e?.message ?? ''), 500);
    }
  }

  private phpEmpty(v: any): boolean {
    if (v === undefined || v === null) return true;
    if (v === false) return true;
    if (v === 0) return true;
    if (v === '') return true;
    if (v === '0') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }
}
