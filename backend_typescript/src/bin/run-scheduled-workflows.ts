/**
 * The scheduler tick from the command line (cron, or the event worker once a minute): runs the due rows
 * of the active schedule-mode workflows. Mirrors backend/scheduler/run-scheduled-workflows.php (CLI mode;
 * the HTTP mode is POST /api/v1/scheduler/run).
 *   node dist/bin/run-scheduled-workflows.js    (or: npx tsx src/bin/run-scheduled-workflows.ts)
 */
import { bootstrap, cliLog } from './scheduler';
import { ScheduleTick } from '../AgentTeam/ScheduleTick';
import { ActiveWorkflowService } from '../AgentTeam/ActiveWorkflowService';

async function main(): Promise<number> {
  let boot: ReturnType<typeof bootstrap>;
  try {
    boot = bootstrap();
  } catch (e: any) {
    process.stderr.write(String(e?.message ?? e) + '\n');
    return 1;
  }
  const tick = new ScheduleTick(boot.schedules, boot.runSchedule, cliLog);
  // Only the active schedule-mode workflows run. A missing active_workflows table (not migrated yet) must
  // not break the tick: then nothing is due, never every schedule.
  let activeWorkflowIds: number[];
  try {
    activeWorkflowIds = await new ActiveWorkflowService().scheduleWorkflowIds();
  } catch (e: any) {
    console.error('Scheduler: active workflows unavailable, running none: ' + (e?.message ?? e));
    process.stderr.write('Scheduler: active workflows unavailable, running none: ' + (e?.message ?? e) + '\n');
    activeWorkflowIds = [];
  }
  const results = await tick.run(activeWorkflowIds);
  cliLog(`Completed: ${results.executed_count} succeeded, ${results.failed_count} failed`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(String(e?.message ?? e) + '\n');
  process.exit(1);
});
