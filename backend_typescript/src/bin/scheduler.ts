import path from 'path';
import { config } from '../config/env';
import { ScheduledWorkflowService } from '../AgentTeam/ScheduledWorkflowService';
import { ScheduleTick, RunSchedule } from '../AgentTeam/ScheduleTick';
import { WorkflowRepository } from '../AgentTeam/WorkflowRepository';
import { GraphWorkflowRunner } from '../AgentTeam/GraphWorkflowRunner';
import { WorkflowRunner } from '../AgentTeam/WorkflowRunner';
import { sqlDateTime } from '../AgentTeam/CronExpression';

/**
 * What the scheduler's CLI entry points share (run-scheduled-workflows, run-schedule): the schedule service
 * and the function that runs one schedule's workflow once. Mirrors backend/scheduler/bootstrap.php; the
 * database is the CONTEXTS pool every controller uses.
 */
export function bootstrap(): { schedules: ScheduledWorkflowService; runSchedule: RunSchedule } {
  const workflows = new WorkflowRepository();
  return {
    schedules: new ScheduledWorkflowService(),
    runSchedule: ScheduleTick.workflowRunner(workflows, workflows.graphRepository, new GraphWorkflowRunner(config), new WorkflowRunner()),
  };
}

/** "[Y-m-d H:i:s] line" to stdout, the CLI log format. */
export const cliLog = (line: string): void => {
  process.stdout.write(`[${sqlDateTime(new Date())}] ${line}\n`);
};

/** How the event worker starts a child entry point: this same runtime (tsx in dev, plain node on dist). */
export function entryCommand(name: string, args: string[] = []): [string, string[]] {
  const ext = path.extname(__filename); // .ts under tsx, .js once built
  const script = path.join(__dirname, name + ext);
  return [process.execPath, [...process.execArgv, script, ...args]];
}
