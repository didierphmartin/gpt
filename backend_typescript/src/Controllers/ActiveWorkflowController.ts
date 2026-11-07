import { Ctx, ControllerResult } from '../Support/Http';
import { ActiveWorkflowError, ActiveWorkflowService } from '../AgentTeam/ActiveWorkflowService';
import { WorkflowRepository } from '../AgentTeam/WorkflowRepository';
import { RobotOwnership } from '../Services/RobotOwnership';
import { config } from '../config/env';
import { RobotSkillPolicy } from '../Services/RobotSkillPolicy';
import { PrivateSkillsRefused } from '../Services/SkillErrors';

/**
 * ▶ on Start activates the workflow the event worker runs. One per person; a robot workflow's row is the robot's, and
 * every user who may use the robot activates and deactivates (= Unlock) it.
 * Mirrors backend/src/AgentTeam/Controllers/ActiveWorkflowController.php.
 */
export class ActiveWorkflowController {
  constructor(
    private readonly active: ActiveWorkflowService = new ActiveWorkflowService(RobotSkillPolicy.fromEnv(config)),
    private readonly ownershipFactory: () => RobotOwnership = () => new RobotOwnership(config),
    private readonly workflows: Pick<WorkflowRepository, 'canUserAccess'> = new WorkflowRepository()
  ) {}

  private userId(ctx: Ctx): number {
    return Math.trunc(Number(ctx.user_id ?? 0)) || 0;
  }

  /** GET /api/v1/workflows/active: the caller's own row. */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    return { success: true, data: await this.active.get(userId), status_code: 200 };
  }

  /** GET /api/v1/workflows/{id}/active: the workflow's row, the robot's for a robot workflow. */
  async forWorkflow(ctx: Ctx): Promise<ControllerResult> {
    return this.guarded(ctx, async (_u, workflowId) => ({ success: true, data: await this.active.forWorkflow(workflowId), status_code: 200 }));
  }

  /** POST /api/v1/workflows/{id}/activate */
  async activate(ctx: Ctx): Promise<ControllerResult> {
    return this.guarded(ctx, async (userId, workflowId, own) => {
      try {
        const data = await this.active.activate(await own.runAs(userId, workflowId), workflowId);
        return { success: true, data, status_code: 200 };
      } catch (e) {
        if (e instanceof PrivateSkillsRefused) return RobotSkillPolicy.refusal(e.skills);
        if (!(e instanceof ActiveWorkflowError)) throw e;
        return { success: false, error: e.message, kind: e.kind, error_code: e.kind, status_code: e.status };
      }
    });
  }

  /** DELETE /api/v1/workflows/{id}/activate */
  async deactivate(ctx: Ctx): Promise<ControllerResult> {
    return this.guarded(ctx, async (userId, workflowId, own) => {
      await this.active.deactivate(await own.runAs(userId, workflowId), workflowId);
      return { success: true, status_code: 200 };
    });
  }

  /** Authenticated, and the workflow is the caller's or a robot workflow the caller may use; else 404, nothing more. */
  private async guarded(
    ctx: Ctx,
    fn: (userId: number, workflowId: number, own: RobotOwnership) => Promise<ControllerResult>
  ): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    const workflowId = parseInt(String(ctx.params?.id ?? 0), 10) || 0;
    const own = this.ownershipFactory();
    if (!(await this.workflows.canUserAccess(userId, workflowId, await own.robotFor(userId)))) {
      return { success: false, error: 'Workflow not found', kind: 'not_found', status_code: 404 };
    }
    return fn(userId, workflowId, own);
  }
}
