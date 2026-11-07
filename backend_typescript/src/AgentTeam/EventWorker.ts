import { ActiveWorkflowService } from './ActiveWorkflowService';
import { WatchCall, WatchServer } from './WatchCall';
import { phpIntval } from './WorkflowRepository';

/** The event worker's long-polls: one open request per key (an active row's "{user}:{workflow}"). Mirrors WatchTransport.php. */
export interface WatchTransport {
  start(key: string, url: string, headers: string[], body: string): void;
  cancel(key: string): void;
  /** The requests that finished since the last call: key => [body | false, http status, error]. */
  done(): Map<string, [string | false, number, string]>;
}

/** The event worker's child processes: an event's runs, and the scheduler tick. Mirrors RunSpawner.php. */
export interface RunSpawner {
  /** Start the run-schedule entry point for key (an active row's "{user}:{workflow}"). */
  start(key: string, scheduleId: number): void;
  /** key => exit code, for the runs that ended since the last call. */
  done(): Map<string, number>;
  /** Start the scheduler tick for the active schedule-mode workflows, unless the previous one still runs. */
  scheduleTick(): void;
}

type Slot = {
  user: number; workflow_id: number; schedule_id: number; owner: number; watch: any; mode: string; state: string;
  until: number; backoff: number; message: string | null; run_failed: boolean;
  written_at: number; written: [string, string | null] | null; gone: boolean;
};

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The event worker's logic, without I/O of its own: every RECONCILE_S it reads the active workflows; for
 * each option-mode one it holds a wait on the option's waiting tool, starts a run on `ready`, waits again
 * when the run ends, and backs off on errors and failed runs; once a minute, while one of them is in
 * schedule mode, it starts the scheduler tick for the schedule-mode ones. One slot per active row, keyed
 * "{user}:{workflow}" (a person has one row, the robot one per workflow). State goes to active_workflows. Mirrors backend/src/AgentTeam/Services/EventWorker.php.
 */
export class EventWorker {
  static readonly RECONCILE_S = 5;
  static readonly BACKOFF_MIN_S = 30;
  static readonly BACKOFF_MAX_S = 300;
  static readonly HEARTBEAT_S = 30;
  static readonly SCHEDULE_TICK_S = 60;
  static readonly LOG_REPEAT_S = 60;

  /** row key "{user}:{workflow}" => slot */
  private slotsByKey = new Map<string, Slot>();
  private lastReconcile = -Infinity;
  private lastTick = -Infinity;
  private requestId = 0;
  /** row key => [workflow_id, schedule_id] of a run that failed while its slot was flagged for rebuild */
  private carry = new Map<string, [number, number]>();
  /** logged line => when, for the once-a-minute limit */
  private logged = new Map<string, number>();

  constructor(
    private readonly active: ActiveWorkflowService,
    private readonly serverFor: (owner: number, name: string) => Promise<WatchServer | null> | WatchServer | null,
    private readonly transport: WatchTransport,
    private readonly runs: RunSpawner,
    private readonly now: () => number,
    private readonly log: ((line: string) => void) | null = null,
  ) {}

  async step(): Promise<void> {
    const now = this.now();
    if (now - this.lastReconcile >= EventWorker.RECONCILE_S) {
      try {
        await this.reconcile();
        this.lastReconcile = now;
      } catch (e) {
        this.logError('reconcile', e); // retried on the next step
      }
    }
    for (const [key, [body, http, err]] of this.transport.done()) {
      try {
        await this.onAnswer(String(key), WatchCall.answer(body, http, String(err)), now);
      } catch (e) {
        this.logError('answer', e, String(key)); // one row's failure must not lose the others' answers
      }
    }
    for (const [key, exit] of this.runs.done()) {
      try {
        await this.onRunEnd(String(key), exit, now);
      } catch (e) {
        this.logError('run end', e, String(key));
      }
    }
    for (const key of [...this.slotsByKey.keys()]) {
      try {
        const s = this.slotsByKey.get(key)!;
        if (s.state === 'open' || (s.state === 'backoff' && now >= s.until)) {
          await this.openWait(key, now);
        }
        const cur = this.slotsByKey.get(key);
        if (cur !== undefined && now - cur.written_at >= EventWorker.HEARTBEAT_S) {
          await this.write(key, true);
        }
      } catch (e) {
        this.logError('wait', e, key);
      }
    }
    // the scheduler tick runs only while some active workflow is in schedule mode and qualifies (not idle)
    const scheduled = [...this.slotsByKey.values()].some((s) => s.state === 'scheduled');
    if (scheduled && now - this.lastTick >= EventWorker.SCHEDULE_TICK_S) {
      this.lastTick = now;
      try {
        this.runs.scheduleTick();
      } catch (e) {
        this.logError('schedule tick', e);
      }
    }
  }

  /** row key => slot */
  slots(): Record<string, { workflow_id: number; schedule_id: number; state: string; until: number; backoff: number }> {
    const out: Record<string, any> = {};
    for (const [key, s] of this.slotsByKey) {
      out[key] = { workflow_id: s.workflow_id, schedule_id: s.schedule_id, state: s.state, until: s.until, backoff: s.backoff };
    }
    return out;
  }

  stop(): void {
    for (const key of this.slotsByKey.keys()) this.transport.cancel(key);
  }

  private async reconcile(): Promise<void> {
    await this.active.sweep();
    const rows = await this.active.all();
    const seen = new Set(rows.map((r) => EventWorker.keyOf(r)));
    // the removed rows first: a person's replaced run is flagged before the new row is looked at
    for (const key of [...this.slotsByKey.keys()]) {
      if (!seen.has(key)) {
        if (this.slotsByKey.get(key)!.state === 'running') {
          this.slotsByKey.get(key)!.gone = true; // let the run finish, then forget it
        } else {
          this.drop(key);
        }
      }
    }
    for (const key of [...this.carry.keys()]) {
      if (!seen.has(key) && !this.slotsByKey.has(key)) this.carry.delete(key); // its row is gone: a later reactivation starts clean
    }
    for (const row of rows) {
      try {
        await this.reconcileRow(row);
      } catch (e) {
        this.logError('reconcile', e, EventWorker.keyOf(row)); // one row's failure must not stop the later rows
      }
    }
  }

  /** A slot's key: its active row's "{user}:{workflow}". */
  private static keyOf(row: Record<string, any>): string {
    return phpIntval(row.user_id) + ':' + phpIntval(row.workflow_id);
  }

  private async reconcileRow(row: Record<string, any>): Promise<void> {
    const key = EventWorker.keyOf(row);
    const check = await this.active.check(row);
    const schedule = check.mode.schedule;
    const ids: [number, number] = [phpIntval(row.workflow_id), schedule ? phpIntval(schedule.id) : 0];
    const watch = EventWorker.watchOf(schedule);
    let slot = this.slotsByKey.get(key) ?? null;
    if (slot !== null && slot.state === 'running') {
      // a run is in flight: nothing for this row changes until it ends; if the row changed, the slot is then rebuilt
      if (!check.ok || !same([slot.workflow_id, slot.schedule_id], ids) || slot.mode !== row.mode || !same(slot.watch, watch)) {
        slot.gone = true;
      }
      return;
    }
    if (slot === null && (row.user_kind ?? null) !== 'service' && this.replacedRunInFlight(phpIntval(row.user_id))) {
      return; // a person's replaced workflow still runs: the new one opens once it ends (the robot's run independently)
    }
    let carried: Partial<Slot> | null = null;
    if (slot === null && this.carry.has(key)) {
      // a failed run that ended while the row changed
      carried = same(this.carry.get(key), ids) ? { message: 'run_failed', run_failed: true } : null;
      this.carry.delete(key);
    }
    if (slot !== null && !same([slot.workflow_id, slot.schedule_id], ids)) {
      this.drop(key); // another schedule row of this workflow is active now
      slot = null;
    }
    if (!check.ok) {
      if (slot !== null && slot.state !== 'running') this.transport.cancel(key);
      this.slotsByKey.set(key, this.slot(ids, row, schedule, 'idle', slot ?? carried));
      this.slotsByKey.get(key)!.message = check.reason;
      await this.write(key);
      return;
    }
    if (row.mode === 'schedule') {
      this.slotsByKey.set(key, this.slot(ids, row, schedule, 'scheduled', slot ?? carried));
      this.slotsByKey.get(key)!.message = schedule?.next_run ?? null;
      await this.write(key);
      return;
    }
    if (slot !== null && !['idle', 'scheduled'].includes(slot.state) && !same(slot.watch, watch)) {
      // the option's watch was edited in place (same row): close the old wait, wait again with the new one
      this.transport.cancel(key);
      this.slotsByKey.set(key, this.slot(ids, row, schedule, 'open', slot));
      return;
    }
    if (slot === null || ['idle', 'scheduled'].includes(slot.state)) {
      this.slotsByKey.set(key, this.slot(ids, row, schedule, 'open', slot ?? carried));
    }
  }

  /** Whether a slot of this person whose row is gone still runs (they activated another workflow meanwhile). */
  private replacedRunInFlight(userId: number): boolean {
    for (const s of this.slotsByKey.values()) {
      if (s.user === userId && s.gone && s.state === 'running') return true;
    }
    return false;
  }

  /** The schedule row's event_trigger, decoded: what the wait calls. */
  private static watchOf(schedule: Record<string, any> | null): any {
    const t = schedule?.event_trigger;
    if (typeof t !== 'string') return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  private slot(key: [number, number], row: Record<string, any>, schedule: Record<string, any> | null, state: string, old: Partial<Slot> | null): Slot {
    return {
      user: phpIntval(row.user_id), workflow_id: key[0], schedule_id: key[1], owner: phpIntval(row.owner_id), watch: EventWorker.watchOf(schedule),
      mode: row.mode, state, until: 0.0, backoff: old?.backoff ?? 0, message: old?.message ?? null,
      run_failed: old?.run_failed ?? false,
      written_at: old?.written_at ?? -Infinity, written: old?.written ?? null, gone: false,
    };
  }

  private async openWait(key: string, now: number): Promise<void> {
    const s = this.slotsByKey.get(key)!;
    let server: WatchServer | null;
    try {
      server = s.watch !== null && typeof s.watch === 'object' ? await this.serverFor(s.owner, String(s.watch.server ?? '')) : null;
    } catch (e) {
      this.logError('server lookup', e, key);
      await this.backoff(key, 'unreachable', now);
      return;
    }
    if (server === null) {
      await this.backoff(key, 'server_missing', now);
      return;
    }
    const [url, headers, body] = WatchCall.request(server, s.watch, ++this.requestId);
    this.transport.start(key, url, headers, body);
    s.state = 'waiting';
    if (s.run_failed) s.message = 'run_failed'; // waiting again after a failed run: the failure still shows
    await this.write(key);
  }

  private async onAnswer(key: string, answer: ReturnType<typeof WatchCall.answer>, now: number): Promise<void> {
    const s = this.slotsByKey.get(key);
    if (s === undefined || s.state !== 'waiting') return; // deactivated or replaced meanwhile
    if (answer.status === 'error') {
      await this.backoff(key, answer.message, now);
      return;
    }
    if (s.run_failed) {
      // after a failed run, only a run that succeeds clears the failure and its backoff
      s.message = 'run_failed';
    } else {
      s.backoff = 0;
      s.message = (answer.events ?? null) === 'off' ? 'fallback' : null;
    }
    if (answer.status === 'timeout') {
      s.state = 'open';
      return;
    }
    let row: Record<string, any> | null = null;
    let ok: boolean;
    try {
      for (const r of await this.active.all()) {
        if (EventWorker.keyOf(r) === key) row = r;
      }
      ok = row !== null && (await this.active.check(row)).ok;
    } catch (e) {
      this.logError('check', e, key);
      await this.backoff(key, 'unreachable', now);
      return;
    }
    if (!ok || phpIntval(row!.workflow_id) !== s.workflow_id || row!.mode !== 'option') {
      this.slotsByKey.delete(key); // deactivated or disabled since the wait opened: no run
      return;
    }
    s.state = 'running';
    try {
      this.runs.start(key, s.schedule_id);
    } catch (e) {
      this.logError('run start', e, key);
      s.run_failed = true;
      await this.backoff(key, 'run_failed', now);
      return;
    }
    await this.write(key);
  }

  private async onRunEnd(key: string, exit: number, now: number): Promise<void> {
    const s = this.slotsByKey.get(key);
    if (s === undefined) return;
    if (s.gone) {
      if (exit !== 0) this.carry.set(key, [s.workflow_id, s.schedule_id]);
      this.slotsByKey.delete(key);
      this.lastReconcile = -Infinity; // re-evaluate before anything opens for this row (or its user's new row)
      return;
    }
    if (exit !== 0) {
      // a run that fails before the poll delivers the mail would loop ready -> run -> fail: back off (30 s .. 300 s)
      s.run_failed = true;
      await this.backoff(key, 'run_failed', now);
      return;
    }
    Object.assign(s, { state: 'open', message: null, backoff: 0, run_failed: false });
  }

  private async backoff(key: string, message: string, now: number): Promise<void> {
    const s = this.slotsByKey.get(key)!;
    const b = s.backoff === 0 ? EventWorker.BACKOFF_MIN_S : Math.min(s.backoff * 2, EventWorker.BACKOFF_MAX_S);
    Object.assign(s, { state: 'backoff', until: now + b, backoff: b, message });
    await this.write(key);
  }

  private drop(key: string): void {
    this.transport.cancel(key);
    this.slotsByKey.delete(key);
  }

  /** The slot's state to active_workflows: on a change, or on the heartbeat (force). */
  private async write(key: string, force = false): Promise<void> {
    const s = this.slotsByKey.get(key);
    if (s === undefined) return;
    const state = s.state === 'backoff' ? 'error' : s.state === 'open' ? 'waiting' : s.state;
    const written: [string, string | null] = [state, s.message];
    if (!force && same(s.written, written)) return;
    try {
      await this.active.setState(s.user, s.workflow_id, state, s.message);
    } catch (e) {
      this.logError('state write', e, key);
      return; // 'written' stays as it was: the heartbeat retries
    }
    s.written = written;
    s.written_at = this.now();
  }

  /** A swallowed error, to the log: each distinct line at most once a minute. */
  private logError(where: string, e: unknown, key: string | null = null): void {
    if (this.log === null) return;
    const err = e instanceof Error ? e : new Error(String(e));
    const line = `event worker: ${where}` + (key !== null ? ` (${key})` : '') + `: ${err.constructor.name}: ${err.message}`;
    const now = this.now();
    if (now - (this.logged.get(line) ?? -Infinity) < EventWorker.LOG_REPEAT_S) return;
    for (const [l, t] of [...this.logged]) if (now - t >= EventWorker.LOG_REPEAT_S) this.logged.delete(l);
    this.logged.set(line, now);
    try {
      this.log(line);
    } catch {
      // a broken log must not stop the worker
    }
  }
}
