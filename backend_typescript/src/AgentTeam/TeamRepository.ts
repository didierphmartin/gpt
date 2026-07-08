import { sql } from 'kysely';
import { db } from '../db/pools';
import { AgentRepository, PipelineItem, agentToApiArray } from './AgentRepository';

/**
 * Faithful mirror of:
 *  - src/AgentTeam/Models/Team.php            (hydrate / toArray / toArrayWithAgents)
 *  - src/AgentTeam/Services/TeamRepository.php (data access used by the ported endpoints)
 *
 * Runtime DDL is NOT replicated — the schema already exists.
 */

export interface Team {
  id: number | null;
  userId: number;
  workspaceId: number | null;
  name: string;
  description: string;
  createdAt: string | null;
  updatedAt: string | null;
  // Agents with pipeline info (set separately, like the PHP model's transient property).
  agentsWithPipelineInfo: PipelineItem[];
}

function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Mirrors Team::hydrate(). */
export function hydrateTeam(data: any): Team {
  return {
    id: data.id !== undefined && data.id !== null ? phpIntval(data.id) : null,
    userId: data.user_id !== undefined && data.user_id !== null ? phpIntval(data.user_id) : 0,
    workspaceId: data.workspace_id !== undefined && data.workspace_id !== null ? phpIntval(data.workspace_id) : null,
    name: data.name ?? '',
    description: data.description ?? '',
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
    agentsWithPipelineInfo: [],
  };
}

/** Mirrors Team::toArray(). */
export function teamToArray(t: Team): Record<string, any> {
  return {
    id: t.id,
    user_id: t.userId,
    workspace_id: t.workspaceId,
    name: t.name,
    description: t.description,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

/** Mirrors Team::toArrayWithAgents(). */
export function teamToArrayWithAgents(t: Team): Record<string, any> {
  const data = teamToArray(t);
  if (t.agentsWithPipelineInfo.length > 0) {
    data.agents = t.agentsWithPipelineInfo.map((item) => {
      const agentData = agentToApiArray(item.agent);
      agentData.pipeline_position = item.pipeline_position;
      agentData.pipeline_label = item.pipeline_label;
      agentData.is_pipeline_head = item.is_pipeline_head;
      agentData.is_pipeline_tail = item.is_pipeline_tail;
      agentData.can_reorder = item.can_reorder;
      return agentData;
    });
  } else {
    // Fallback to basic agents array (empty when no pipeline info was set).
    data.agents = [];
  }
  return data;
}

export class TeamRepository {
  private agentRepository: AgentRepository;

  constructor(agentRepository?: AgentRepository) {
    this.agentRepository = agentRepository ?? new AgentRepository();
  }

  /** Find a team by ID. */
  async findById(id: number): Promise<Team | null> {
    const row = (await sql<any>`SELECT * FROM agent_teams WHERE id = ${id}`.execute(db)).rows[0];
    return row ? hydrateTeam(row) : null;
  }

  /** Find a team by ID with its agents (pipeline info). */
  async findByIdWithAgents(id: number): Promise<Team | null> {
    const team = await this.findById(id);
    if (!team) return null;
    team.agentsWithPipelineInfo = await this.agentRepository.findByTeamIdWithPipelineInfo(id);
    return team;
  }

  /** Find all teams for a user. */
  async findByUser(userId: number): Promise<Team[]> {
    const rows = (await sql<any>`SELECT * FROM agent_teams WHERE user_id = ${userId} ORDER BY name ASC`.execute(db))
      .rows;
    return rows.map(hydrateTeam);
  }

  /** Find all teams for a user with their agents (pipeline info). */
  async findByUserWithAgents(userId: number): Promise<Team[]> {
    const teams = await this.findByUser(userId);
    for (const team of teams) {
      team.agentsWithPipelineInfo = await this.agentRepository.findByTeamIdWithPipelineInfo(team.id as number);
    }
    return teams;
  }

  /** Create a new team. */
  async create(team: Team): Promise<Team> {
    const data = teamToArray(team);
    const res = await sql`
      INSERT INTO agent_teams (user_id, workspace_id, name, description)
      VALUES (${data.user_id}, ${data.workspace_id}, ${data.name}, ${data.description})`.execute(db);
    const id = Number(res.insertId);
    return (await this.findById(id))!;
  }

  /** Update an existing team. */
  async update(team: Team): Promise<Team> {
    const data = teamToArray(team);
    await sql`
      UPDATE agent_teams SET
        name = ${data.name},
        description = ${data.description},
        workspace_id = ${data.workspace_id}
      WHERE id = ${data.id}`.execute(db);
    return (await this.findById(team.id as number))!;
  }

  /** Delete a team and all its agents. */
  async delete(id: number): Promise<void> {
    await sql`DELETE FROM agents WHERE team_id = ${id}`.execute(db);
    await sql`DELETE FROM agent_teams WHERE id = ${id}`.execute(db);
  }

  /** Whether a user can access a team (owner only). */
  async canUserAccess(userId: number, teamId: number): Promise<boolean> {
    const team = await this.findById(teamId);
    if (!team) return false;
    return team.userId === userId;
  }

  /** Whether a user owns a team. */
  async isOwner(userId: number, teamId: number): Promise<boolean> {
    const team = await this.findById(teamId);
    return !!team && team.userId === userId;
  }
}
