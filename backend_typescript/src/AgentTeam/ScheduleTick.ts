import { ScheduledWorkflowService } from './ScheduledWorkflowService';
import { sqlDateTime } from './CronExpression';
import { phpEmpty, phpIntval } from './WorkflowRepository';

export type RunSchedule = (schedule: Record<string, any>) => Promise<Record<string, any>>;
export type DrainResult = { runs: number; quiet_count: number; execution_ids: Array<number | null> };

/**
 * One scheduler tick: run every due schedule once, or, for a run that did work after a code node
 * (drain), again at once until it reports nothing to do, at most MAX_RUNS_PER_TICK times. Shared by
 * SchedulerController (HTTP) and the scheduler CLI. Mirrors backend/src/AgentTeam/Services/ScheduleTick.php.
 */
export class ScheduleTick {
  static readonly MAX_RUNS_PER_TICK = 20;

  constructor(
    private readonly schedules: ScheduledWorkflowService,
    private readonly runSchedule: RunSchedule,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** workflowIds: run only these workflows' due rows (the active schedule-mode ones); null runs every due row. */
  async run(workflowIds: number[] | null = null): Promise<Record<string, any>> {
    const due = await this.schedules.getDueSchedules(workflowIds);
    const results: Record<string, any> = {
      timestamp: sqlDateTime(new Date()), due_count: due.length, executed: [] as any[], failed: [] as any[], quiet_count: 0,
    };
    this.log(`Found ${due.length} due schedule(s)`);

    for (const schedule of due) {
      const id = phpIntval(schedule.id);
      if (!(await this.schedules.claim(id))) {
        continue; // another tick took it
      }
      try {
        const r = await ScheduleTick.drain(() => this.runSchedule(schedule), () => this.schedules.touchRunning(id));
        results.quiet_count += r.quiet_count;
        for (const executionId of r.execution_ids) {
          results.executed.push({
            schedule_id: id, workflow_id: phpIntval(schedule.workflow_id),
            workflow_name: schedule.workflow_name ?? null, execution_id: executionId,
          });
        }
        await this.schedules.markCompleted(id);
        this.log(`✓ Schedule #${id}: ${r.runs} run(s)`);
      } catch (e: any) {
        const message = e?.message ?? String(e);
        await this.schedules.markFailed(id, message);
        results.failed.push({
          schedule_id: id, workflow_id: phpIntval(schedule.workflow_id),
          workflow_name: schedule.workflow_name ?? 'Unknown', error: message,
        });
        this.log(`✗ Schedule #${id} failed: ${message}`);
        console.error(`Scheduled workflow failed: Schedule #${id}, Workflow #${schedule.workflow_id}: ${message}`);
      }
    }

    results.executed_count = results.executed.length;
    results.failed_count = results.failed.length;
    return results;
  }

  /**
   * Run once, or, for a run that did work after a code node (drain), again at once until it reports
   * nothing to do, at most MAX_RUNS_PER_TICK times. Shared by the tick and run-schedule (an event's runs).
   */
  static async drain(runOnce: () => Promise<Record<string, any>>, touch: (() => Promise<void> | void) | null = null): Promise<DrainResult> {
    let runs = 0;
    let quietCount = 0;
    const executionIds: Array<number | null> = [];
    let quiet: boolean;
    let result: Record<string, any>;
    do {
      if (touch !== null) await touch(); // a long drain stays claimed
      result = await runOnce();
      runs++;
      if (phpEmpty(result.success)) {
        throw new Error(result.error ?? 'Workflow execution failed');
      }
      quiet = !phpEmpty(result.quiet);
      if (quiet) quietCount++;
      else executionIds.push(result.execution_id ?? null);
      // Drain only when a code node ran and the run found work.
    } while (!quiet && !phpEmpty(result.drain) && runs < ScheduleTick.MAX_RUNS_PER_TICK);
    return { runs, quiet_count: quietCount, execution_ids: executionIds };
  }

  /** The runSchedule both entry points use: load the workflow and run it once (graph runner when it has nodes). */
  static workflowRunner(
    workflows: { findById(id: number): Promise<any> },
    graphRepository: { getNodes(id: number): Promise<any[]> },
    graphRunner: { run(w: any, u: number, input: Record<string, any>): Promise<Record<string, any>> },
    linearRunner: { run(w: any, u: number, input: Record<string, any>): Promise<Record<string, any>> },
  ): RunSchedule {
    return async (schedule) => {
      const workflowId = phpIntval(schedule.workflow_id);
      const workflow = await workflows.findById(workflowId);
      if (!workflow) return { success: false, error: `Workflow #${workflowId} not found` };
      if (!workflow.enabled) return { success: false, error: `Workflow #${workflowId} is disabled` };
      const input: Record<string, any> = {};
      if (!phpEmpty(schedule.input_prompt)) {
        input.user_prompt = schedule.input_prompt;
        input.prompt = schedule.input_prompt;
      }
      const userId = phpIntval(schedule.user_id);
      const nodes = await graphRepository.getNodes(workflowId);
      return Array.isArray(nodes) && nodes.length > 0
        ? graphRunner.run(workflow, userId, input)
        : linearRunner.run(workflow, userId, input);
    };
  }
}
