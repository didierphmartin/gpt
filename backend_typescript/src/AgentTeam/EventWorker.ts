import { ActiveWorkflowService } from './ActiveWorkflowService';
import { WatchCall, WatchServer } from './WatchCall';
import { phpIntval } from './WorkflowRepository';

/** The event worker's long-polls: one open request per key (a user id). Mirrors WatchTransport.php. */
export interface WatchTransport {
  start(key: number, url: string, headers: string[], body: string): void;
  cancel(key: number): void;
  /** The requests that finished since the last call: key => [body | false, http status, error]. */
  done(): Map<number, [string | false, number, string]>;
}

/** The event worker's child processes: an event's runs, and the scheduler tick. Mirrors RunSpawner.php. */
export interface RunSpawner {
  /** Start the run-schedule entry point for key (a user id). */
  start(key: number, scheduleId: number): void;
  /** key => exit code, for the runs that ended since the last call. */
  done(): Map<number, number>;
  /** Start the scheduler tick for the active schedule-mode workflows, unless the previous one still runs. */
  scheduleTick(): void;
}

type Slot = {
  workflow_id: number; schedule_id: number; owner: number; watch: any; mode: string; state: string;
  until: number; backoff: number; message: string | null; run_failed: boolean;
  written_at: number; written: [string, string | null] | null; gone: boolean;
};

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The event worker's logic, without I/O of its own: every RECONCILE_S it reads the active workflows; for
 * each option-mode one it holds a wait on the option's waiting tool, starts a run on `ready`, waits again
 * when the run ends, and backs off on errors and failed runs; once a minute, while one of them is in
 * schedule mode, it starts the scheduler tick. One slot per user (one active workflow each). State goes to
 * active_workflows. Mirrors backend/src/AgentTeam/Services/EventWorker.php.
 */
export class EventWorker {
  static readonly RECONCILE_S = 5;
  static readonly BACKOFF_MIN_S = 30;
  static readonly BACKOFF_MAX_S = 300;
  static readonly HEARTBEAT_S = 30;
  static readonly SCHEDULE_TICK_S = 60;
  static readonly LOG_REPEAT_S = 60;

  private slotsByUser = new Map<number, Slot>();
  private lastReconcile = -Infinity;
  private lastTick = -Infinity;
  private requestId = 0;
  /** user id => [workflow_id, schedule_id] of a run that failed while its slot was flagged for rebuild */
  private carry = new Map<number, [number, number]>();
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
    for (const [user, [body, http, err]] of this.transport.done()) {
      try {
        await this.onAnswer(user, WatchCall.answer(body, http, String(err)), now);
      } catch (e) {
        this.logError('answer', e, user); // one user's failure must not lose the others' answers
      }
    }
    for (const [user, exit] of this.runs.done()) {
      try {
        await this.onRunEnd(user, exit, now);
      } catch (e) {
        this.logError('run end', e, user);
      }
    }
    for (const user of [...this.slotsByUser.keys()]) {
      try {
        const s = this.slotsByUser.get(user)!;
        if (s.state === 'open' || (s.state === 'backoff' && now >= s.until)) {
          await this.openWait(user, now);
        }
        const cur = this.slotsByUser.get(user);
        if (cur !== undefined && now - cur.written_at >= EventWorker.HEARTBEAT_S) {
          await this.write(user, true);
        }
      } catch (e) {
        this.logError('wait', e, user);
      }
    }
    // the scheduler tick runs only while some active workflow is in schedule mode and qualifies (not idle)
    const scheduled = [...this.slotsByUser.values()].some((s) => s.state === 'scheduled');
    if (scheduled && now - this.lastTick >= EventWorker.SCHEDULE_TICK_S) {
      this.lastTick = now;
      try {
        this.runs.scheduleTick();
      } catch (e) {
        this.logError('schedule tick', e);
      }
    }
  }

  slots(): Record<number, { workflow_id: number; schedule_id: number; state: string; until: number; backoff: number }> {
    const out: Record<number, any> = {};
    for (const [user, s] of this.slotsByUser) {
      out[user] = { workflow_id: s.workflow_id, schedule_id: s.schedule_id, state: s.state, until: s.until, backoff: s.backoff };
    }
    return out;
  }

  stop(): void {
    for (const user of this.slotsByUser.keys()) this.transport.cancel(user);
  }

  private async reconcile(): Promise<void> {
    await this.active.sweep();
    const seen = new Set<number>();
    for (const row of await this.active.all()) {
      seen.add(phpIntval(row.user_id));
      try {
        await this.reconcileRow(row);
      } catch (e) {
        this.logError('reconcile', e, phpIntval(row.user_id)); // one row's failure must not stop the later rows
      }
    }
    for (const user of [...this.slotsByUser.keys()]) {
      if (!seen.has(user)) {
        if (this.slotsByUser.get(user)!.state === 'running') {
          this.slotsByUser.get(user)!.gone = true; // let the run finish, then forget it
        } else {
          this.drop(user);
        }
      }
    }
  }

  private async reconcileRow(row: Record<string, any>): Promise<void> {
    const user = phpIntval(row.user_id);
    const check = await this.active.check(row);
    const schedule = check.mode.schedule;
    const key: [number, number] = [phpIntval(row.workflow_id), schedule ? phpIntval(schedule.id) : 0];
    const watch = EventWorker.watchOf(schedule);
    let slot = this.slotsByUser.get(user) ?? null;
    if (slot !== null && slot.state === 'running') {
      // a run is in flight: nothing for this user changes until it ends; if the row changed, the slot is then rebuilt
      if (!check.ok || !same([slot.workflow_id, slot.schedule_id], key) || slot.mode !== row.mode || !same(slot.watch, watch)) {
        slot.gone = true;
      }
      return;
    }
    let carried: Partial<Slot> | null = null;
    if (slot === null && this.carry.has(user)) {
      // a failed run that ended while the row changed
      carried = same(this.carry.get(user), key) ? { message: 'run_failed', run_failed: true } : null;
      this.carry.delete(user);
    }
    if (slot !== null && !same([slot.workflow_id, slot.schedule_id], key)) {
      this.drop(user); // another workflow (or row) is active now
      slot = null;
    }
    if (!check.ok) {
      if (slot !== null && slot.state !== 'running') this.transport.cancel(user);
      this.slotsByUser.set(user, this.slot(key, row, schedule, 'idle', slot ?? carried));
      this.slotsByUser.get(user)!.message = check.reason;
      await this.write(user);
      return;
    }
    if (row.mode === 'schedule') {
      this.slotsByUser.set(user, this.slot(key, row, schedule, 'scheduled', slot ?? carried));
      this.slotsByUser.get(user)!.message = schedule?.next_run ?? null;
      await this.write(user);
      return;
    }
    if (slot !== null && !['idle', 'scheduled'].includes(slot.state) && !same(slot.watch, watch)) {
      // the option's watch was edited in place (same row): close the old wait, wait again with the new one
      this.transport.cancel(user);
      this.slotsByUser.set(user, this.slot(key, row, schedule, 'open', slot));
      return;
    }
    if (slot === null || ['idle', 'scheduled'].includes(slot.state)) {
      this.slotsByUser.set(user, this.slot(key, row, schedule, 'open', slot ?? carried));
    }
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
      workflow_id: key[0], schedule_id: key[1], owner: phpIntval(row.owner_id), watch: EventWorker.watchOf(schedule),
      mode: row.mode, state, until: 0.0, backoff: old?.backoff ?? 0, message: old?.message ?? null,
      run_failed: old?.run_failed ?? false,
      written_at: old?.written_at ?? -Infinity, written: old?.written ?? null, gone: false,
    };
  }

  private async openWait(user: number, now: number): Promise<void> {
    const s = this.slotsByUser.get(user)!;
    let server: WatchServer | null;
    try {
      server = s.watch !== null && typeof s.watch === 'object' ? await this.serverFor(s.owner, String(s.watch.server ?? '')) : null;
    } catch (e) {
      this.logError('server lookup', e, user);
      await this.backoff(user, 'unreachable', now);
      return;
    }
    if (server === null) {
      await this.backoff(user, 'server_missing', now);
      return;
    }
    const [url, headers, body] = WatchCall.request(server, s.watch, ++this.requestId);
    this.transport.start(user, url, headers, body);
    s.state = 'waiting';
    if (s.run_failed) s.message = 'run_failed'; // waiting again after a failed run: the failure still shows
    await this.write(user);
  }

  private async onAnswer(user: number, answer: ReturnType<typeof WatchCall.answer>, now: number): Promise<void> {
    const s = this.slotsByUser.get(user);
    if (s === undefined || s.state !== 'waiting') return; // deactivated or replaced meanwhile
    if (answer.status === 'error') {
      await this.backoff(user, answer.message, now);
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
        if (phpIntval(r.user_id) === user) row = r;
      }
      ok = row !== null && (await this.active.check(row)).ok;
    } catch (e) {
      this.logError('check', e, user);
      await this.backoff(user, 'unreachable', now);
      return;
    }
    if (!ok || phpIntval(row!.workflow_id) !== s.workflow_id || row!.mode !== 'option') {
      this.slotsByUser.delete(user); // deactivated or disabled since the wait opened: no run
      return;
    }
    s.state = 'running';
    try {
      this.runs.start(user, s.schedule_id);
    } catch (e) {
      this.logError('run start', e, user);
      s.run_failed = true;
      await this.backoff(user, 'run_failed', now);
      return;
    }
    await this.write(user);
  }

  private async onRunEnd(user: number, exit: number, now: number): Promise<void> {
    const s = this.slotsByUser.get(user);
    if (s === undefined) return;
    if (s.gone) {
      if (exit !== 0) this.carry.set(user, [s.workflow_id, s.schedule_id]);
      this.slotsByUser.delete(user);
      this.lastReconcile = -Infinity; // re-evaluate before anything opens for this user
      return;
    }
    if (exit !== 0) {
      // a run that fails before the poll delivers the mail would loop ready -> run -> fail: back off (30 s .. 300 s)
      s.run_failed = true;
      await this.backoff(user, 'run_failed', now);
      return;
    }
    Object.assign(s, { state: 'open', message: null, backoff: 0, run_failed: false });
  }

  private async backoff(user: number, message: string, now: number): Promise<void> {
    const s = this.slotsByUser.get(user)!;
    const b = s.backoff === 0 ? EventWorker.BACKOFF_MIN_S : Math.min(s.backoff * 2, EventWorker.BACKOFF_MAX_S);
    Object.assign(s, { state: 'backoff', until: now + b, backoff: b, message });
    await this.write(user);
  }

  private drop(user: number): void {
    this.transport.cancel(user);
    this.slotsByUser.delete(user);
  }

  /** The slot's state to active_workflows: on a change, or on the heartbeat (force). */
  private async write(user: number, force = false): Promise<void> {
    const s = this.slotsByUser.get(user);
    if (s === undefined) return;
    const state = s.state === 'backoff' ? 'error' : s.state === 'open' ? 'waiting' : s.state;
    const written: [string, string | null] = [state, s.message];
    if (!force && same(s.written, written)) return;
    try {
      await this.active.setState(user, state, s.message);
    } catch (e) {
      this.logError('state write', e, user);
      return; // 'written' stays as it was: the heartbeat retries
    }
    s.written = written;
    s.written_at = this.now();
  }

  /** A swallowed error, to the log: each distinct line at most once a minute. */
  private logError(where: string, e: unknown, user: number | null = null): void {
    if (this.log === null) return;
    const err = e instanceof Error ? e : new Error(String(e));
    const line = `event worker: ${where}` + (user !== null ? ` (user ${user})` : '') + `: ${err.constructor.name}: ${err.message}`;
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
