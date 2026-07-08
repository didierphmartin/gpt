import { Ctx } from '../Support/Http';
import { config } from '../config/env';
import { ScheduledWorkflowService } from '../AgentTeam/ScheduledWorkflowService';
import { WorkflowRepository, phpIntval } from '../AgentTeam/WorkflowRepository';
import { GraphWorkflowRunner } from '../AgentTeam/GraphWorkflowRunner';
import { WorkflowRunner } from '../AgentTeam/WorkflowRunner';

/**
 * Faithful mirror of src/AgentTeam/Controllers/SchedulerController.php.
 *
 * Provides API access to the workflow scheduler: an alternative to the direct cron script that lets
 * either an authenticated user OR a cron caller (holding the scheduler token) trigger execution of
 * all due scheduled workflows.
 *
 * Runner construction differs from PHP only in shape: the TS GraphWorkflowRunner/WorkflowRunner are
 * self-contained (they build their own AgentRepository/AgentRunner/graph repository internally and
 * read providers from system_llm_settings), so PHP's explicit assistant/AgentRunner wiring
 * (AIPortfolioAssistant + MCPToolsLoader + LLMProviderResolver::applyDbSettings) has no counterpart
 * here — the same collaborators are resolved inside the runners. Behaviour is identical.
 *
 * NOTE: GraphWorkflowRunner.run here is NON-streaming (no StreamContext), which is correct for
 * scheduled runs — mirrors PHP. A scheduled graph with a browser-only skill node would block on the
 * SkillToolBridge and time out (same as PHP: there is no browser on a cron run).
 */
export class SchedulerController {
  private scheduleService = new ScheduledWorkflowService();

  /**
   * POST /api/v1/scheduler/run
   * Manually trigger the scheduler to run due workflows. Requires user auth OR a valid scheduler
   * token (allowing cron/external triggers). This route is public (see MiddlewareProcessor
   * PUBLIC_ROUTES) precisely because it does its own token validation.
   */
  async run(ctx: Ctx): Promise<Record<string, any>> {
    const userId = ctx.user_id ?? 0;

    // Check for scheduler token in body (allows cron/external trigger). Express lower-cases header names.
    const schedulerToken = ctx.body?.token ?? ctx.headers?.['x-scheduler-token'] ?? null;
    const expectedToken = config.scheduler?.token ?? '';

    // Either need valid user auth or valid scheduler token
    if (!userId && schedulerToken !== expectedToken) {
      return {
        success: false,
        error: 'Authentication required',
        status_code: 401,
      };
    }

    try {
      const results = await this.executeScheduler();

      return {
        success: true,
        data: results,
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message,
        status_code: 500,
      };
    }
  }

  /**
   * GET /api/v1/scheduler/status
   * Get scheduler status and upcoming schedules. Requires user auth (NOT public).
   */
  async status(ctx: Ctx): Promise<Record<string, any>> {
    const userId = ctx.user_id ?? 0;

    if (!userId) {
      return {
        success: false,
        error: 'Authentication required',
        status_code: 401,
      };
    }

    try {
      const dueSchedules = await this.scheduleService.getDueSchedules();
      const userStats = await this.scheduleService.getStats(userId);

      return {
        success: true,
        data: {
          due_count: dueSchedules.length,
          user_stats: userStats,
          server_time: phpDateYmdHis(new Date()),
          // PHP date_default_timezone_get(). No date_default_timezone_set() anywhere in the PHP
          // codebase, so it resolves to the ini date.timezone of the LIVE server. The XAMPP/Apache
          // php.ini (/Applications/XAMPP/xamppfiles/etc/php.ini — the env the parent diffs against,
          // NOT the Homebrew CLI which reports UTC) sets date.timezone=Europe/Berlin.
          timezone: 'Europe/Berlin',
        },
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e?.message,
        status_code: 500,
      };
    }
  }

  /**
   * Execute the scheduler logic — mirrors SchedulerController::executeScheduler().
   */
  private async executeScheduler(): Promise<Record<string, any>> {
    const workflowRepository = new WorkflowRepository();
    const graphRepository = workflowRepository.graphRepository;

    // The TS runners are self-contained: GraphWorkflowRunner(config) builds its own
    // AgentRepository/AgentRunner/graph repository; WorkflowRunner() takes no args.
    const graphWorkflowRunner = new GraphWorkflowRunner(config);
    const workflowRunner = new WorkflowRunner();

    // Get due schedules
    const dueSchedules = await this.scheduleService.getDueSchedules();

    const results: Record<string, any> = {
      timestamp: phpDateYmdHis(new Date()),
      due_count: dueSchedules.length,
      executed: [] as any[],
      failed: [] as any[],
    };

    for (const schedule of dueSchedules) {
      const scheduleId = phpIntval(schedule.id);
      const workflowId = phpIntval(schedule.workflow_id);
      const userId = phpIntval(schedule.user_id);
      const inputPrompt = schedule.input_prompt;

      try {
        // Mark as running
        await this.scheduleService.markRunning(scheduleId);

        // Load workflow
        const workflow = await workflowRepository.findById(workflowId);

        if (!workflow) {
          throw new Error(`Workflow #${workflowId} not found`);
        }

        if (!workflow.enabled) {
          throw new Error(`Workflow #${workflowId} is disabled`);
        }

        // Prepare input variables
        const inputVariables: any = {};
        if (inputPrompt) {
          inputVariables.user_prompt = inputPrompt;
          inputVariables.prompt = inputPrompt;
        }

        // Check if graph-based workflow
        const nodes = await graphRepository.getNodes(workflowId);
        const isGraphWorkflow = Array.isArray(nodes) && nodes.length > 0;

        // Execute workflow
        const result = isGraphWorkflow
          ? await graphWorkflowRunner.run(workflow, userId, inputVariables)
          : await workflowRunner.run(workflow, userId, inputVariables);

        if (result.success) {
          await this.scheduleService.markCompleted(scheduleId);
          results.executed.push({
            schedule_id: scheduleId,
            workflow_id: workflowId,
            workflow_name: schedule.workflow_name,
            execution_id: result.execution_id ?? null,
          });
        } else {
          throw new Error(result.error ?? 'Workflow execution failed');
        }
      } catch (e: any) {
        const errorMessage = e?.message;
        await this.scheduleService.markFailed(scheduleId, errorMessage);

        results.failed.push({
          schedule_id: scheduleId,
          workflow_id: workflowId,
          workflow_name: schedule.workflow_name ?? 'Unknown',
          error: errorMessage,
        });

        console.error(
          `Scheduled workflow failed: Schedule #${scheduleId}, Workflow #${workflowId}: ${errorMessage}`
        );
      }
    }

    results.executed_count = results.executed.length;
    results.failed_count = results.failed.length;

    return results;
  }
}

/** PHP date('Y-m-d H:i:s') for a Date (server-local time). Local per-controller helper matching the
 * convention used by AdminController/WebAuthnController (no shared exported one exists). */
function phpDateYmdHis(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
