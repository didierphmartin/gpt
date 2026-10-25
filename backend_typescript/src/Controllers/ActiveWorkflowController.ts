import { Ctx, ControllerResult } from '../Support/Http';
import { ActiveWorkflowError, ActiveWorkflowService } from '../AgentTeam/ActiveWorkflowService';

/**
 * ▶ on Start activates the workflow the event worker runs. One per user.
 * Mirrors backend/src/AgentTeam/Controllers/ActiveWorkflowController.php.
 */
export class ActiveWorkflowController {
  constructor(private readonly active: ActiveWorkflowService = new ActiveWorkflowService()) {}

  private userId(ctx: Ctx): number {
    return Math.trunc(Number(ctx.user_id ?? 0)) || 0;
  }

  /** GET /api/v1/workflows/active */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    return { success: true, data: await this.active.get(userId), status_code: 200 };
  }

  /** POST /api/v1/workflows/{id}/activate */
  async activate(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    try {
      return { success: true, data: await this.active.activate(userId, parseInt(String(ctx.params?.id ?? 0), 10) || 0), status_code: 200 };
    } catch (e) {
      if (!(e instanceof ActiveWorkflowError)) throw e;
      return { success: false, error: e.message, kind: e.kind, status_code: e.status };
    }
  }

  /** DELETE /api/v1/workflows/{id}/activate */
  async deactivate(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
    await this.active.deactivate(userId, parseInt(String(ctx.params?.id ?? 0), 10) || 0);
    return { success: true, status_code: 200 };
  }
}
