import { Ctx, ControllerResult } from '../Support/Http';
import { ScheduledWorkflowService, ScheduleInputError } from '../AgentTeam/ScheduledWorkflowService';
import { CronExpression } from '../AgentTeam/CronExpression';
import { ActiveWorkflowService } from '../AgentTeam/ActiveWorkflowService';
import { WorkflowRepository, phpEmpty, phpIntval } from '../AgentTeam/WorkflowRepository';
import { CodeComponentStore } from '../CodeComponent/CodeComponentStore';
import { CodeComponentError } from '../CodeComponent/CodeComponentError';

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
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const phpStr = (v: any) => (v === null || v === undefined || v === false ? '' : v === true ? '1' : String(v));

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
    let body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try { // a Start option names its component; the component supplies the event (spec §3)
      body = await new CodeComponentStore().scheduleBody(userId, body);
    } catch (e) {
      if (!(e instanceof CodeComponentError)) throw e;
      return { success: false, error: e.message, kind: e.kind, status_code: e.status };
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
    const validRepeatTypes = ScheduledWorkflowService.REPEAT_TYPES;
    if (!phpEmpty(body.repeat_type) && !validRepeatTypes.includes(body.repeat_type)) {
      return {
        success: false,
        error: 'Invalid repeat type. Must be one of: ' + validRepeatTypes.join(', '),
        status_code: 400,
      };
    }
    if ((body.repeat_type ?? '') === 'cron' && !CronExpression.isValid(phpTrim(phpStr(body.cron ?? '')))) {
      return { success: false, error: 'Invalid cron expression', status_code: 400 };
    }
    if ((body.repeat_type ?? '') === 'event') {
      try {
        ScheduledWorkflowService.eventTrigger(body.event_trigger ?? null);
      } catch (e: any) {
        return { success: false, error: e?.message ?? '', status_code: 400 };
      }
    }

    try {
      const schedule = await this.scheduleService.create({
        user_id: userId,
        workflow_id: phpIntval(body.workflow_id),
        input_prompt: body.input_prompt ?? null,
        scheduled_time: body.scheduled_time,
        repeat_type: body.repeat_type ?? 'none',
        repeat_interval: phpIntval(body.repeat_interval ?? 1),
        cron: body.cron ?? null,
        event_trigger: body.event_trigger ?? null,
        trigger_component_id: body.trigger_component_id ?? null,
      });

      await this.sweepActive();
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
    let body: any = ctx.body ?? {};

    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    try { // a Start option names its component; the component supplies the event (spec §3)
      body = await new CodeComponentStore().scheduleBody(userId, body,
        phpIntval((await this.scheduleService.findById(id))?.workflow_id ?? 0));
    } catch (e) {
      if (!(e instanceof CodeComponentError)) throw e;
      return { success: false, error: e.message, kind: e.kind, status_code: e.status };
    }

    // Validate repeat_type if provided
    if (!phpEmpty(body.repeat_type)) {
      if (!ScheduledWorkflowService.REPEAT_TYPES.includes(body.repeat_type)) {
        return { success: false, error: 'Invalid repeat type', status_code: 400 };
      }
    }

    // Effective cron after this update: a cron schedule must carry a valid, ever-firing expression.
    if ((body.repeat_type ?? null) === 'cron' || Object.prototype.hasOwnProperty.call(body, 'cron')) {
      const existing = await this.scheduleService.findById(id);
      const effType = body.repeat_type ?? (existing?.repeat_type ?? 'none');
      const effCron = phpTrim(phpStr(body.cron ?? existing?.cron ?? ''));
      if (effType === 'cron' && !CronExpression.isValid(effCron)) {
        return { success: false, error: 'Invalid cron expression', status_code: 400 };
      }
    }

    try {
      const schedule = await this.scheduleService.update(id, userId, body);

      if (!schedule) {
        return { success: false, error: 'Schedule not found', status_code: 404 };
      }

      await this.sweepActive();
      return {
        success: true,
        data: schedule,
        message: 'Schedule updated successfully',
        status_code: 200,
      };
    } catch (e: any) {
      if (e instanceof ScheduleInputError) { // e.g. an event schedule without a usable trigger
        return { success: false, error: e.message, status_code: 400 };
      }
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

      await this.sweepActive();
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

      await this.sweepActive();
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

      await this.sweepActive();
      return { success: true, message: 'Schedule resumed successfully', status_code: 200 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** The active-workflow sweep after a schedule write; never fails the write it follows (the event worker sweeps every 5 s too). */
  private async sweepActive(): Promise<void> {
    try {
      await new ActiveWorkflowService().sweep();
    } catch (e: any) {
      console.error('[ActiveWorkflow] sweep failed: ' + (e?.message ?? e));
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
