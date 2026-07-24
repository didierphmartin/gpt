import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Faithful mirror of:
 *  - src/AgentTeam/Models/Agent.php          (hydrate / toArray / toApiArray)
 *  - src/AgentTeam/Services/AgentRepository.php (data access used by the ported endpoints)
 *
 * The Agent "model" is represented as a mutable plain object (the PHP class has getters/setters
 * the controllers mutate). Serialization helpers (agentToArray / agentToApiArray) reproduce the
 * PHP toArray()/toApiArray() field maps exactly.
 *
 * Runtime DDL (ensureTablesExist) is NOT replicated — the schema already exists.
 */

export interface Agent {
  id: number | null;
  userId: number;
  teamId: number | null;
  category: string | null;
  name: string;
  description: string;
  agentType: string; // standard | manager | worker
  parentAgentId: number | null;
  canDelegateTo: any; // array (or object) decoded from JSON
  displayOrder: number;
  provider: string;
  model: string | null;
  instructions: string;
  tools: any; // array (or object) decoded from JSON
  visibility: string; // personal | workspace | public
  enabled: boolean;
  settings: any; // array (or object) decoded from JSON
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PipelineItem {
  agent: Agent;
  pipeline_position: number | null;
  pipeline_label: string;
  is_pipeline_head: boolean;
  is_pipeline_tail: boolean;
  can_reorder: boolean;
}

export interface OrderResult {
  success: boolean;
  reordered?: boolean;
  enforced_order?: number[];
  message?: string | null;
  error?: string;
}

/** Mirrors PHP (int) cast of a possibly-string value (leading-integer parse, default 0). */
function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Mirrors PHP empty() for the value kinds we deal with (string/number/array/null/bool). */
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (v === '') return true;
  if (v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * Mirrors Agent::decodeJson(). PHP json_decode($s, true) maps both JSON objects and arrays to PHP
 * arrays; on re-encode an empty object round-trips to [] (associative→list quirk for the empty case).
 * Non-string already-decoded values pass through (is_array($value) ? $value : []).
 */
function decodeJson(value: any): any {
  if (typeof value === 'string') {
    if (value === '') return [];
    let decoded: any;
    try {
      decoded = JSON.parse(value);
    } catch {
      return [];
    }
    if (decoded === null || typeof decoded !== 'object') return []; // PHP: is_array($decoded) ? ... : []
    // Empty JSON object {} decodes to [] in PHP and re-encodes to []. Reproduce that.
    if (!Array.isArray(decoded) && Object.keys(decoded).length === 0) return [];
    return decoded;
  }
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return value; // already an associative structure
  return [];
}

/** Mirrors Agent::hydrate(). */
export function hydrateAgent(data: any): Agent {
  return {
    id: data.id !== undefined && data.id !== null ? phpIntval(data.id) : null,
    userId: data.user_id !== undefined && data.user_id !== null ? phpIntval(data.user_id) : 0,
    teamId: data.team_id !== undefined && data.team_id !== null ? phpIntval(data.team_id) : null,
    category:
      data.category !== undefined && data.category !== null && data.category !== '' ? String(data.category) : null,
    name: data.name ?? '',
    description: data.description ?? '',
    agentType: data.agent_type ?? 'standard',
    parentAgentId:
      data.parent_agent_id !== undefined && data.parent_agent_id !== null ? phpIntval(data.parent_agent_id) : null,
    canDelegateTo: decodeJson(data.can_delegate_to ?? []),
    displayOrder: data.display_order !== undefined && data.display_order !== null ? phpIntval(data.display_order) : 0,
    provider: data.provider ?? 'claude',
    model: data.model ?? null,
    instructions: data.instructions ?? '',
    tools: decodeJson(data.tools ?? []),
    visibility: data.visibility ?? 'personal',
    enabled: Boolean(data.enabled ?? true),
    settings: decodeJson(data.settings ?? []),
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
  };
}

/** Mirrors Agent::toArray(). */
export function agentToArray(a: Agent): Record<string, any> {
  return {
    id: a.id,
    user_id: a.userId,
    team_id: a.teamId,
    category: a.category,
    name: a.name,
    description: a.description,
    agent_type: a.agentType,
    parent_agent_id: a.parentAgentId,
    can_delegate_to: a.canDelegateTo,
    display_order: a.displayOrder,
    provider: a.provider,
    model: a.model,
    instructions: a.instructions,
    tools: a.tools,
    visibility: a.visibility,
    enabled: a.enabled,
    settings: a.settings,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

/** Mirrors Agent::toApiArray(). */
export function agentToApiArray(a: Agent): Record<string, any> {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    category: a.category,
    agent_type: a.agentType,
    display_order: a.displayOrder,
    provider: a.provider,
    model: a.model,
    instructions: a.instructions,
    tools: a.tools,
    settings: a.settings,
    visibility: a.visibility,
    enabled: a.enabled,
    created_at: a.createdAt,
  };
}

export function isManager(a: Agent): boolean {
  return a.agentType === 'manager';
}

/** Mirrors Agent::canDelegateToAgent. Manager-only; empty canDelegateTo = any agent. */
export function canDelegateToAgent(manager: Agent, agentId: number): boolean {
  if (manager.agentType !== 'manager') return false;
  const list = Array.isArray(manager.canDelegateTo) ? manager.canDelegateTo : [];
  if (list.length === 0) return true;
  return list.map((x: any) => Number(x)).includes(Number(agentId));
}

/**
 * Mirrors Agent::buildSystemPrompt(). The manager block is emitted verbatim (it references the
 * delegation tools); delegation tool *registration* is deferred (Slice 1b) but the prompt text is
 * still produced exactly as PHP does so the system prompt is byte-identical.
 */
export function buildSystemPrompt(a: Agent): string {
  let prompt = `You are ${a.name}.`;
  if (!phpEmpty(a.description)) prompt += `\n\n${a.description}`;
  if (!phpEmpty(a.instructions)) prompt += `\n\n## Instructions\n${a.instructions}`;
  if (isManager(a)) {
    prompt += '\n\n## Agent Capabilities\n';
    prompt += 'You are a manager agent with the ability to delegate tasks to specialized worker agents.\n';
    prompt += 'Use the `list_available_agents` tool to see your team.\n';
    prompt += 'Use `delegate_to_agent` to assign tasks to specific agents.\n';
    prompt += 'Use `run_agents_parallel` to run multiple agents simultaneously.';
  }
  return prompt;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface AgentFilters {
  agent_type?: any;
  provider?: any;
  visibility?: any;
  search?: any;
  category?: any;
  limit?: any;
  offset?: any;
}

export class AgentRepository {
  /** Find an agent by ID. */
  async findById(id: number): Promise<Agent | null> {
    const row = (await sql<any>`SELECT * FROM agents WHERE id = ${id}`.execute(db)).rows[0];
    return row ? hydrateAgent(row) : null;
  }

  /** Mirrors AgentRepository::findWorkerAgents. Empty canDelegateTo → all enabled worker/standard. */
  async findWorkerAgents(managerId: number): Promise<Agent[]> {
    const manager = await this.findById(managerId);
    if (!manager || manager.agentType !== 'manager') return [];
    const list = Array.isArray(manager.canDelegateTo) ? manager.canDelegateTo : [];

    let rows: any[];
    if (list.length === 0) {
      rows = (
        await sql<any>`SELECT * FROM agents
          WHERE agent_type IN ('worker','standard') AND enabled = 1
          ORDER BY display_order ASC, name ASC`.execute(db)
      ).rows;
    } else {
      const ids = list.map((x: any) => Number(x));
      rows = (
        await sql<any>`SELECT * FROM agents
          WHERE id IN (${sql.join(ids)}) AND enabled = 1
          ORDER BY display_order ASC, name ASC`.execute(db)
      ).rows;
    }
    return rows.map((r) => hydrateAgent(r));
  }

  /** Mirrors findByName(): first enabled agent named `name` the user can access. */
  async findByName(name: string, userId: number): Promise<Agent | null> {
    const row = (
      await sql<any>`
        SELECT * FROM agents
        WHERE name = ${name}
          AND (user_id = ${userId} OR visibility = 'public' OR visibility = 'workspace')
          AND enabled = 1
        LIMIT 1`.execute(db)
    ).rows[0];
    return row ? hydrateAgent(row) : null;
  }

  /** Find all agents accessible by a user (with optional filters). */
  async findAccessibleByUser(userId: number, filters: AgentFilters = {}): Promise<Agent[]> {
    const conditions: any[] = [
      sql`(user_id = ${userId} OR visibility = 'public' OR visibility = 'workspace')`,
      sql`enabled = 1`,
    ];

    if (!phpEmpty(filters.agent_type)) conditions.push(sql`agent_type = ${filters.agent_type}`);
    if (!phpEmpty(filters.provider)) conditions.push(sql`provider = ${filters.provider}`);
    if (!phpEmpty(filters.visibility)) conditions.push(sql`visibility = ${filters.visibility}`);
    if (!phpEmpty(filters.search)) {
      const like = '%' + filters.search + '%';
      conditions.push(sql`(name LIKE ${like} OR description LIKE ${like})`);
    }
    if (Object.prototype.hasOwnProperty.call(filters, 'category') && filters.category !== null) {
      if (filters.category === '__none__' || filters.category === '') {
        conditions.push(sql`category IS NULL`);
      } else {
        conditions.push(sql`category = ${filters.category}`);
      }
    }

    let query = sql`SELECT * FROM agents WHERE ${sql.join(conditions, sql` AND `)} ORDER BY name ASC`;

    if (!phpEmpty(filters.limit)) {
      query = sql`${query} LIMIT ${sql.lit(phpIntval(filters.limit))}`;
      if (!phpEmpty(filters.offset)) {
        query = sql`${query} OFFSET ${sql.lit(phpIntval(filters.offset))}`;
      }
    }

    const rows = (await query.execute(db)).rows as any[];
    return rows.map(hydrateAgent);
  }

  /** Find agents by team ID (enabled only, pipeline order). */
  async findByTeamId(teamId: number): Promise<Agent[]> {
    const rows = (
      await sql<any>`SELECT * FROM agents WHERE team_id = ${teamId} AND enabled = 1 ORDER BY display_order ASC, name ASC`.execute(
        db
      )
    ).rows;
    return rows.map(hydrateAgent);
  }

  /** Find agents by team ID with pipeline position metadata. */
  async findByTeamIdWithPipelineInfo(teamId: number): Promise<PipelineItem[]> {
    const agents = await this.findByTeamId(teamId);
    if (agents.length === 0) return [];

    const managers: Agent[] = [];
    const workers: Agent[] = [];
    for (const agent of agents) {
      if (isManager(agent)) managers.push(agent);
      else workers.push(agent);
    }

    const result: PipelineItem[] = [];
    const workerCount = workers.length;

    for (const agent of managers) {
      result.push({
        agent,
        pipeline_position: null,
        pipeline_label: 'Manager',
        is_pipeline_head: false,
        is_pipeline_tail: false,
        can_reorder: false,
      });
    }

    workers.forEach((agent, index) => {
      const position = index + 1;
      result.push({
        agent,
        pipeline_position: position,
        pipeline_label: `Step ${position}` + (workerCount > 1 ? ` of ${workerCount}` : ''),
        is_pipeline_head: index === 0,
        is_pipeline_tail: index === workerCount - 1,
        can_reorder: true,
      });
    });

    return result;
  }

  /** Create a new agent. */
  /**
   * Strict lookup by the dedup key (user_id, name). Unlike findByName() this
   * never matches public/workspace agents owned by others and ignores the
   * enabled flag — used by create() to reuse instead of minting a duplicate.
   */
  async findOwnedByName(name: string, userId: number): Promise<Agent | null> {
    const row = (
      await sql<any>`
        SELECT * FROM agents
        WHERE user_id = ${userId} AND name = ${name}
        ORDER BY id ASC LIMIT 1`.execute(db)
    ).rows[0];
    return row ? hydrateAgent(row) : null;
  }

  /**
   * Create a new agent — or reuse an existing one. Agents are unique per
   * (user_id, name): reusing the same agent across workflows must point at ONE
   * row, not spawn a duplicate. If a row with this name already exists for the
   * user, update it in place and return it (keeping its id) instead of
   * inserting. Backs the UNIQUE(user_id, name) constraint.
   */
  async create(agent: Agent): Promise<Agent> {
    const existing = await this.findOwnedByName(agent.name, agent.userId);
    if (existing !== null) {
      agent.id = existing.id;
      return this.update(agent);
    }

    const data = agentToArray(agent);
    const res = await sql`
      INSERT INTO agents (
        user_id, team_id, category, name, description,
        agent_type, parent_agent_id, can_delegate_to, display_order,
        provider, model, instructions,
        tools, visibility, enabled, settings
      ) VALUES (
        ${data.user_id}, ${data.team_id}, ${data.category}, ${data.name}, ${data.description},
        ${data.agent_type}, ${data.parent_agent_id}, ${JSON.stringify(data.can_delegate_to)}, ${data.display_order},
        ${data.provider}, ${data.model}, ${data.instructions},
        ${JSON.stringify(data.tools)}, ${data.visibility}, ${data.enabled ? 1 : 0}, ${JSON.stringify(data.settings)}
      )`.execute(db);

    const id = Number(res.insertId);
    return (await this.findById(id))!;
  }

  /** Update an existing agent. */
  async update(agent: Agent): Promise<Agent> {
    const data = agentToArray(agent);
    await sql`
      UPDATE agents SET
        team_id = ${data.team_id},
        category = ${data.category},
        name = ${data.name},
        description = ${data.description},
        agent_type = ${data.agent_type},
        parent_agent_id = ${data.parent_agent_id},
        can_delegate_to = ${JSON.stringify(data.can_delegate_to)},
        display_order = ${data.display_order},
        provider = ${data.provider},
        model = ${data.model},
        instructions = ${data.instructions},
        tools = ${JSON.stringify(data.tools)},
        visibility = ${data.visibility},
        enabled = ${data.enabled ? 1 : 0},
        settings = ${JSON.stringify(data.settings)}
      WHERE id = ${data.id}`.execute(db);

    return (await this.findById(agent.id as number))!;
  }

  /** List distinct, non-empty category names for a user. */
  async findDistinctCategories(userId: number): Promise<string[]> {
    const rows = (
      await sql<{ category: string }>`
        SELECT DISTINCT category FROM agents
        WHERE user_id = ${userId} AND category IS NOT NULL AND category <> ''
        ORDER BY category ASC`.execute(db)
    ).rows;
    return rows.map((r) => r.category);
  }

  /** Bulk-rename a category across a user's agents. Returns rows affected. */
  async renameCategory(userId: number, oldName: string, newName: string): Promise<number> {
    if (oldName === '' || newName === '') return 0;
    const res = await sql`
      UPDATE agents SET category = ${newName}
      WHERE user_id = ${userId} AND category = ${oldName}`.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }

  /** Clear a category (agents fall back to NULL). Returns rows affected. */
  async clearCategory(userId: number, name: string): Promise<number> {
    if (name === '') return 0;
    const res = await sql`
      UPDATE agents SET category = NULL
      WHERE user_id = ${userId} AND category = ${name}`.execute(db);
    return Number(res.numAffectedRows ?? 0);
  }

  /** Delete an agent. */
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM agents WHERE id = ${id}`.execute(db);
  }

  /** Whether a user can access an agent (owner, public, or workspace). */
  async canUserAccess(userId: number, agentId: number): Promise<boolean> {
    const agent = await this.findById(agentId);
    if (!agent) return false;
    if (agent.userId === userId) return true;
    if (agent.visibility === 'public') return true;
    if (agent.visibility === 'workspace') return true; // simplified (no workspace membership check)
    return false;
  }

  /** Whether a user owns an agent. */
  async isOwner(userId: number, agentId: number): Promise<boolean> {
    const agent = await this.findById(agentId);
    return !!agent && agent.userId === userId;
  }

  /** Count all accessible agents for a user. */
  async countAccessible(userId: number): Promise<number> {
    const row = (
      await sql<{ c: number }>`
        SELECT COUNT(*) as c FROM agents
        WHERE (user_id = ${userId} OR visibility IN ('public', 'workspace'))
        AND enabled = 1`.execute(db)
    ).rows[0];
    return phpIntval(row?.c ?? 0);
  }

  /** Agent execution statistics. */
  async getAgentStats(agentId: number): Promise<Record<string, any>> {
    const stats =
      (
        await sql<any>`
          SELECT
            COUNT(*) as total_executions,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(tokens_used) as total_tokens,
            SUM(cost_usd) as total_cost,
            AVG(response_time_ms) as avg_response_time
          FROM agent_executions
          WHERE agent_id = ${agentId}`.execute(db)
      ).rows[0] ?? {};

    return {
      total_executions: phpIntval(stats.total_executions ?? 0),
      successful: phpIntval(stats.successful ?? 0),
      failed: phpIntval(stats.failed ?? 0),
      total_tokens: phpIntval(stats.total_tokens ?? 0),
      total_cost: Number(stats.total_cost ?? 0),
      avg_response_time_ms: Number(stats.avg_response_time ?? 0),
    };
  }

  /** Duplicate an agent. */
  async duplicate(agentId: number, newUserId: number, newName: string | null = null): Promise<Agent | null> {
    const original = await this.findById(agentId);
    if (!original) return null;

    const copy = hydrateAgent(agentToArray(original));
    copy.userId = newUserId;
    copy.name = newName ?? original.name + ' (Copy)';
    copy.visibility = 'personal';

    return this.create(copy);
  }

  /**
   * Update display order for multiple agents in a team.
   * Manager agents are ALWAYS enforced at the top (position 0..).
   */
  async updateAgentOrder(orderedIds: number[], teamId: number): Promise<OrderResult> {
    try {
      const managerIds: number[] = [];
      const workerIds: number[] = [];

      for (const rawId of orderedIds) {
        const agentId = phpIntval(rawId);
        const agent = await this.findById(agentId);
        if (agent) {
          if (agent.teamId === teamId) {
            if (isManager(agent)) managerIds.push(agentId);
            else workerIds.push(agentId);
          }
        }
      }

      const enforcedOrder = [...managerIds, ...workerIds];

      await db.transaction().execute(async (trx) => {
        let order = 0;
        for (const agentId of enforcedOrder) {
          await sql`UPDATE agents SET display_order = ${order} WHERE id = ${agentId} AND team_id = ${teamId}`.execute(
            trx
          );
          order++;
        }
      });

      const wasReordered = !arraysEqual(orderedIds, enforcedOrder);

      return {
        success: true,
        reordered: wasReordered,
        enforced_order: enforcedOrder,
        message: wasReordered ? 'Order adjusted: Manager must remain at the top of the pipeline' : null,
      };
    } catch (e) {
      return { success: false, error: 'Failed to update agent order' };
    }
  }

  /** Move an agent up in display order within its team. */
  async moveAgentUp(agentId: number): Promise<boolean> {
    const agent = await this.findById(agentId);
    if (!agent || agent.teamId === null) return false;

    const teamAgents = await this.findByTeamId(agent.teamId);
    let currentIndex = -1;
    for (let i = 0; i < teamAgents.length; i++) {
      if (teamAgents[i].id === agentId) {
        currentIndex = i;
        break;
      }
    }

    if (currentIndex <= 0) return false;

    const prevAgent = teamAgents[currentIndex - 1];
    const prevOrder = prevAgent.displayOrder;
    const currentOrder = agent.displayOrder;

    try {
      await db.transaction().execute(async (trx) => {
        await sql`UPDATE agents SET display_order = ${prevOrder} WHERE id = ${agentId}`.execute(trx);
        await sql`UPDATE agents SET display_order = ${currentOrder} WHERE id = ${prevAgent.id}`.execute(trx);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Move an agent down in display order within its team. */
  async moveAgentDown(agentId: number): Promise<boolean> {
    const agent = await this.findById(agentId);
    if (!agent || agent.teamId === null) return false;

    const teamAgents = await this.findByTeamId(agent.teamId);
    let currentIndex = -1;
    for (let i = 0; i < teamAgents.length; i++) {
      if (teamAgents[i].id === agentId) {
        currentIndex = i;
        break;
      }
    }

    if (currentIndex < 0 || currentIndex >= teamAgents.length - 1) return false;

    const nextAgent = teamAgents[currentIndex + 1];
    const nextOrder = nextAgent.displayOrder;
    const currentOrder = agent.displayOrder;

    try {
      await db.transaction().execute(async (trx) => {
        await sql`UPDATE agents SET display_order = ${nextOrder} WHERE id = ${agentId}`.execute(trx);
        await sql`UPDATE agents SET display_order = ${currentOrder} WHERE id = ${nextAgent.id}`.execute(trx);
      });
      return true;
    } catch (e) {
      return false;
    }
  }
}
