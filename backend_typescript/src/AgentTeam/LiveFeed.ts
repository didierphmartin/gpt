import fs from 'fs';
import { WorkflowRunLog } from './WorkflowRunLog';
import { StartOptionGraph } from './StartOptionGraph';

/**
 * What the live overlay has not shown yet of a workflow's runs. The cursor is "<runId>:<complete lines
 * read>". On a first connect only a run in progress is replayed (finished runs are in Conversations); a
 * run the pointer names that is not the cursor's is read from its first line once it has shown it is a
 * real run (a quiet poll writes Start and the trigger node, then is unlinked without a workflow_complete).
 * When the pointer has moved on, what the cursor's run wrote after the cursor is sent first.
 * Mirrors backend/src/AgentTeam/Services/LiveFeed.php.
 */
export const LiveFeed = {
  next(log: WorkflowRunLog, workflowId: number, cursor: string | null): { events: any[]; cursor: string | null } {
    const [curRun, curLines] = parse(cursor);
    const runId = log.current(workflowId);
    let tail: any[] = [];
    if (curRun !== null && curRun !== runId) {
      const prev = read(log, curRun);
      if (prev !== null) {
        tail = prev.slice(curLines);
        cursor = curRun + ':' + Math.max(curLines, prev.length);
      }
    }
    const events = runId === null ? null : read(log, runId);
    if (events === null) return { events: tail, cursor };
    const next = runId + ':' + events.length;
    if (curRun === runId) return { events: events.slice(curLines), cursor: next };
    if (!real(events)) return { events: tail, cursor };
    if (curRun === null && finished(events)) return { events: [], cursor: next };
    return { events: [...tail, ...events], cursor: next };
  },
};

/** The run's complete lines, or null when its file is gone (whole lines only: the runner may be mid-append). */
function read(log: WorkflowRunLog, runId: string): any[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(log.pathFor(runId), 'utf8');
  } catch {
    return null;
  }
  const complete = raw.slice(0, ('\n' + raw).lastIndexOf('\n'));
  if (complete === '') return [];
  return complete.replace(/\n+$/, '').split('\n').map((line) => {
    try {
      const e = JSON.parse(line);
      return e !== null && typeof e === 'object' ? e : { type: 'unreadable' };
    } catch {
      return { type: 'unreadable' };
    }
  });
}

const isNumeric = (v: any) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));

/** A work node ran (not Start, not the Start option's trigger node) or the run ended. */
function real(events: any[]): boolean {
  for (const e of events) {
    if (['node_start', 'node_complete'].includes(e?.type) && e?.node_type !== 'start'
      && isNumeric(e?.node_id) && Math.trunc(Number(e.node_id)) < StartOptionGraph.ID_OFFSET) {
      return true;
    }
  }
  return finished(events);
}

function finished(events: any[]): boolean {
  return events.some((e) => ['workflow_complete', 'workflow_error'].includes(e?.type));
}

function parse(cursor: string | null): [string | null, number] {
  const m = cursor !== null ? /^([a-f0-9]{32}):(\d+)$/.exec(cursor) : null;
  return m ? [m[1], parseInt(m[2], 10)] : [null, 0];
}

/**
 * One connection of the live overlay: every 0.5 s the run events after the cursor, the active row every
 * 5 s, a ping every 15 s, then "bye" with the cursor the client reconnects from. Clock, sleep and output
 * are injected so the loop is testable. Mirrors backend/src/AgentTeam/Services/LiveStream.php.
 */
export const LiveStream = {
  async run(
    next: (cursor: string | null) => { events: any[]; cursor: string | null },
    state: () => Promise<any> | any,
    emit: (event: string, data: Record<string, any>) => void,
    sleep: (seconds: number) => Promise<void>,
    now: () => number,
    aborted: () => boolean,
    cursor: string | null,
    maxSeconds = 50.0,
  ): Promise<string | null> {
    const start = now();
    let stateAt: number | null = null;
    let pingAt = start;
    while (now() - start < maxSeconds) {
      if (aborted()) return cursor;
      const r = next(cursor);
      for (const e of r.events) emit('run', { cursor: r.cursor, event: e });
      cursor = r.cursor;
      if (stateAt === null || now() - stateAt >= 5.0) {
        emit('state', { active: await state() });
        stateAt = now();
      }
      if (now() - pingAt >= 15.0) {
        emit('ping', {});
        pingAt = now();
      }
      await sleep(0.5);
    }
    emit('bye', { cursor });
    return cursor;
  },
};
