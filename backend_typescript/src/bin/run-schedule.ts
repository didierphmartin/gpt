/**
 * One event's runs: the event worker starts this for a `ready`. Runs the workflow of the event row <id>
 * with the drain rule, records last_run, prints one JSON line. Exit 0 ok, 1 failed.
 * Mirrors backend/bin/run-schedule.php.
 *   node dist/bin/run-schedule.js <schedule id>
 */
import { bootstrap } from './scheduler';
import { ScheduleTick } from '../AgentTeam/ScheduleTick';

const out = (line: Record<string, any>, code: number): never => {
  process.stdout.write(JSON.stringify(line) + '\n');
  process.exit(code);
};

async function main(): Promise<void> {
  try {
    const boot = bootstrap();
    const id = parseInt(process.argv[2] ?? '0', 10) || 0;
    const schedule = await boot.schedules.findById(id);
    if (!schedule || (schedule.repeat_type ?? '') !== 'event') {
      out({ ok: false, error: `schedule #${id} is not an event schedule` }, 1);
    }
    const r = await ScheduleTick.drain(() => boot.runSchedule(schedule));
    await boot.schedules.markCompleted(id); // last_run; an event row keeps no next_run
    out({ ok: true, ...r }, 0);
  } catch (e: any) {
    out({ ok: false, error: e?.message ?? String(e) }, 1);
  }
}

void main();
