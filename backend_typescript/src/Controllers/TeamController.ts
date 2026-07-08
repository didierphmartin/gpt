import { Ctx, ControllerResult } from '../Support/Http';
import { TeamRepository, Team, teamToArray, teamToArrayWithAgents } from '../AgentTeam/TeamRepository';
import { AgentRepository, agentToApiArray } from '../AgentTeam/AgentRepository';

/**
 * Mirrors src/AgentTeam/Controllers/TeamController.php — team CRUD + a team's agents listing.
 *
 * Runtime DDL is NOT replicated — the schema already exists.
 */
export class TeamController {
  private agentRepository = new AgentRepository();
  private teamRepository = new TeamRepository(this.agentRepository);

  private intval(v: any): number {
    if (typeof v === 'number') return Math.trunc(v);
    const n = parseInt(String(v), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  /** GET /api/v1/teams */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const teams = await this.teamRepository.findByUserWithAgents(userId);
      return {
        success: true,
        data: teams.map((t) => teamToArrayWithAgents(t)),
        count: teams.length,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/teams */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!body.name) {
      return { success: false, error: 'Team name is required', status_code: 400 };
    }

    try {
      const team: Team = {
        id: null,
        userId,
        workspaceId: body.workspace_id ?? null,
        name: body.name,
        description: body.description ?? '',
        createdAt: null,
        updatedAt: null,
        agentsWithPipelineInfo: [],
      };

      const created = await this.teamRepository.create(team);

      return {
        success: true,
        data: teamToArray(created),
        message: 'Team created successfully',
        status_code: 201,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/teams/{id} */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const teamId = this.intval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!teamId) {
      return { success: false, error: 'Team ID is required', status_code: 400 };
    }

    try {
      if (!(await this.teamRepository.canUserAccess(userId, teamId))) {
        return { success: false, error: 'Team not found or access denied', status_code: 404 };
      }

      const team = await this.teamRepository.findByIdWithAgents(teamId);
      if (!team) {
        return { success: false, error: 'Team not found', status_code: 404 };
      }

      return { success: true, data: teamToArrayWithAgents(team), status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** PUT /api/v1/teams/{id} */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const teamId = this.intval(ctx.params?.id ?? 0);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!teamId) {
      return { success: false, error: 'Team ID is required', status_code: 400 };
    }

    try {
      if (!(await this.teamRepository.isOwner(userId, teamId))) {
        return { success: false, error: 'Team not found or access denied', status_code: 404 };
      }

      const team = await this.teamRepository.findById(teamId);
      if (!team) {
        return { success: false, error: 'Team not found', status_code: 404 };
      }

      const isset = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== null;

      if (isset('name')) team.name = body.name;
      if (isset('description')) team.description = body.description;
      if (isset('workspace_id')) team.workspaceId = body.workspace_id;

      const updated = await this.teamRepository.update(team);

      return {
        success: true,
        data: teamToArray(updated),
        message: 'Team updated successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** DELETE /api/v1/teams/{id} */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const teamId = this.intval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!teamId) {
      return { success: false, error: 'Team ID is required', status_code: 400 };
    }

    try {
      if (!(await this.teamRepository.isOwner(userId, teamId))) {
        return { success: false, error: 'Team not found or access denied', status_code: 404 };
      }

      await this.teamRepository.delete(teamId);

      return { success: true, message: 'Team deleted successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/teams/{id}/agents */
  async agents(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    const teamId = this.intval(ctx.params?.id ?? 0);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    if (!teamId) {
      return { success: false, error: 'Team ID is required', status_code: 400 };
    }

    try {
      if (!(await this.teamRepository.canUserAccess(userId, teamId))) {
        return { success: false, error: 'Team not found or access denied', status_code: 404 };
      }

      const agentsWithInfo = await this.agentRepository.findByTeamIdWithPipelineInfo(teamId);

      const agents = agentsWithInfo.map((item) => {
        const agentData: any = agentToApiArray(item.agent);
        agentData.pipeline_position = item.pipeline_position;
        agentData.pipeline_label = item.pipeline_label;
        agentData.is_pipeline_head = item.is_pipeline_head;
        agentData.is_pipeline_tail = item.is_pipeline_tail;
        agentData.can_reorder = item.can_reorder;
        return agentData;
      });

      return { success: true, data: agents, count: agents.length, status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }
}
