import { Ctx, ControllerResult } from '../Support/Http';
import { ScheduledWorkflowService } from '../AgentTeam/ScheduledWorkflowService';
import { WorkflowRepository, phpEmpty, phpIntval } from '../AgentTeam/WorkflowRepository';

/**
 * Faithful mirror of src/AgentTeam/Controllers/ScheduledWorkflowController.php.
 *
 * PORTED: index, create, show, update, destroy, pause, resume, stats, byWorkflow.
 * DEFERRED (NOT ported / NOT routed): the SchedulerController cron engine (/scheduler/run,
 *   /scheduler/status) and the service's execution methods.
 *
 * Each method mirrors the PHP validation order, response shape (exact keys), messages and
 * status_codes. Ownership in create is checked via WorkflowRepository.findById (as PHP does with
 * $workflow->getUserId()); show/update/delete/pause/resume rely on the service's own user_id
 * scoping / ownership checks.
 */
export class ScheduledWorkflowController {
  private scheduleService = new ScheduledWorkflowService();
  private workflowRepository = new WorkflowRepository();

  private getUserId(ctx: Ctx): number {
    return Number(ctx.user_id ?? 0);
  }

  private getId(ctx: Ctx): number {
    return phpIntval(ctx.params?.id ?? 0);
  }

  /** GET /api/v1/schedules */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const schedules = await this.scheduleService.findByUser(userId);

      return {
        success: true,
        data: schedules,
        count: schedules.length,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/schedules */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    // Validate required fields
    if (phpEmpty(body.workflow_id)) {
      return { success: false, error: 'Workflow ID is required', status_code: 400 };
    }

    if (phpEmpty(body.scheduled_time)) {
      return { success: false, error: 'Scheduled time is required', status_code: 400 };
    }

    // Verify the workflow exists and belongs to the user
    const workflow = await this.workflowRepository.findById(phpIntval(body.workflow_id));
    if (!workflow || workflow.userId !== userId) {
      return { success: false, error: 'Workflow not found', status_code: 404 };
    }

    // Validate repeat_type if provided
    const validRepeatTypes = ['none', 'hourly', 'daily', 'weekly', 'monthly'];
    if (!phpEmpty(body.repeat_type) && !validRepeatTypes.includes(body.repeat_type)) {
      return {
        success: false,
        error: 'Invalid repeat type. Must be one of: ' + validRepeatTypes.join(', '),
        status_code: 400,
      };
    }

    try {
      const schedule = await this.scheduleService.create({
        user_id: userId,
        workflow_id: phpIntval(body.workflow_id),
        input_prompt: body.input_prompt ?? null,
        scheduled_time: body.scheduled_time,
        repeat_type: body.repeat_type ?? 'none',
        repeat_interval: phpIntval(body.repeat_interval ?? 1),
      });

      return {
        success: true,
        data: schedule,
        message: 'Schedule created successfully',
        status_code: 201,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/schedules/{id} */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const id = this.getId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const schedule = await this.scheduleService.findById(id);

      if (!schedule || schedule.user_id !== userId) {
        return { success: false, error: 'Schedule not found', status_code: 404 };
      }

      return { success: true, data: schedule, status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** PUT /api/v1/schedules/{id} */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const id = this.getId(ctx);
    const body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    // Validate repeat_type if provided
    if (!phpEmpty(body.repeat_type)) {
      const validRepeatTypes = ['none', 'hourly', 'daily', 'weekly', 'monthly'];
      if (!validRepeatTypes.includes(body.repeat_type)) {
        return { success: false, error: 'Invalid repeat type', status_code: 400 };
      }
    }

    try {
      const schedule = await this.scheduleService.update(id, userId, body);

      if (!schedule) {
        return { success: false, error: 'Schedule not found', status_code: 404 };
      }

      return {
        success: true,
        data: schedule,
        message: 'Schedule updated successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** DELETE /api/v1/schedules/{id} */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const id = this.getId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const deleted = await this.scheduleService.delete(id, userId);

      if (!deleted) {
        return { success: false, error: 'Schedule not found', status_code: 404 };
      }

      return { success: true, message: 'Schedule deleted successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/schedules/{id}/pause */
  async pause(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const id = this.getId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const paused = await this.scheduleService.pause(id, userId);

      if (!paused) {
        return {
          success: false,
          error: 'Schedule not found or cannot be paused',
          status_code: 404,
        };
      }

      return { success: true, message: 'Schedule paused successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/schedules/{id}/resume */
  async resume(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const id = this.getId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const resumed = await this.scheduleService.resume(id, userId);

      if (!resumed) {
        return {
          success: false,
          error: 'Schedule not found or not paused',
          status_code: 404,
        };
      }

      return { success: true, message: 'Schedule resumed successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/schedules/stats */
  async stats(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const stats = await this.scheduleService.getStats(userId);

      return { success: true, data: stats, status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/workflows/{id}/schedules */
  async byWorkflow(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.getUserId(ctx);
    const workflowId = this.getId(ctx);

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try {
      const schedules = await this.scheduleService.findByWorkflow(workflowId, userId);

      return {
        success: true,
        data: schedules,
        count: schedules.length,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }
}
