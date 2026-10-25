/**
 * The event worker: runs each user's active workflow -- on its schedule, or on its Start option's event --
 * until SIGTERM / SIGINT. Mirrors backend/bin/event-worker.php (supervise it the same way, e.g. launchd).
 *   node dist/bin/event-worker.js    (or: npx tsx src/bin/event-worker.ts)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { ActiveWorkflowService } from '../AgentTeam/ActiveWorkflowService';
import { EventWorker } from '../AgentTeam/EventWorker';
import { FetchTransport, ProcRunSpawner } from '../AgentTeam/EventWorkerIO';
import { WatchCall } from '../AgentTeam/WatchCall';
import { cliLog as log, entryCommand } from './scheduler';

/**
 * One worker at a time: a second one would hold a second wait on the same mailbox and run the workflow
 * twice. PHP holds an flock for the process's lifetime; Node has no flock, so the lock is a pid file whose
 * holder must still be alive.
 */
function takeLock(lockPath: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const held = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
    if (held && held !== process.pid) {
      try {
        process.kill(held, 0);
        return false; // alive
      } catch {
        // stale: its holder is gone
      }
    }
  } catch {
    // no lock file yet
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return true;
}

async function main(): Promise<void> {
  const lockPath = path.join(process.env.HOME || os.homedir(), 'Library/Caches/synergyai-event-worker-ts.lock');
  if (!takeLock(lockPath)) {
    log(`another event worker is running (lock ${lockPath} held): exiting`);
    process.exit(0);
  }
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  process.on('SIGINT', () => { stop = true; });

  const transport = new FetchTransport();
  const runs = new ProcRunSpawner((id) => entryCommand('run-schedule', [String(id)]), entryCommand('run-scheduled-workflows'),
    process.cwd(), 1800, log);
  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  let worker: EventWorker | null = null;
  let lastPing = 0;
  log(`event worker started (pid ${process.pid})`);
  while (!stop) {
    try {
      if (worker === null) {
        worker = new EventWorker(new ActiveWorkflowService(), (user, name) => WatchCall.server(user, name),
          transport, runs, () => Date.now() / 1000, log);
      }
      // EventWorker.step() swallows its own errors, so a dead connection is found here, every 5 s.
      if (Date.now() / 1000 - lastPing >= 5.0) {
        try {
          await sql`SELECT 1`.execute(db);
        } catch (e: any) {
          // The database went away: keep the waits, reconnect in 10 s.
          log('database: ' + (e?.message ?? e) + ' -- retrying in 10 s');
          worker = null;
          lastPing = 0;
          await sleep(10);
          continue;
        }
        lastPing = Date.now() / 1000;
      }
      await worker.step();
      await transport.wait(1.0);
    } catch (e: any) {
      // A bug must not kill the process: log it, carry on after 1 s.
      log(`${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`);
      await sleep(1);
    }
  }
  log('stopping: letting runs finish (≤ 30 s)');
  worker?.stop();
  await runs.stopAll(30);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
  log('event worker stopped');
  process.exit(0);
}

void main();
