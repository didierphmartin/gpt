import { ChildProcess, spawn } from 'child_process';
import { RunSpawner, WatchTransport } from './EventWorker';

/**
 * WatchTransport over fetch: every active workflow's long-poll in this one process (the twin of PHP's
 * CurlMultiTransport over one curl_multi). The server answers by 150 s (wait_for_new's cap); a request still
 * open at 180 s is a dead connection.
 */
export class FetchTransport implements WatchTransport {
  static readonly TIMEOUT_S = 180;

  private open = new Map<number, AbortController>();
  private finished = new Map<number, [string | false, number, string]>();
  private wake: (() => void) | null = null;

  start(key: number, url: string, headers: string[], body: string): void {
    this.cancel(key);
    const ctrl = new AbortController();
    this.open.set(key, ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error(`Operation timed out after ${FetchTransport.TIMEOUT_S * 1000} milliseconds`)), FetchTransport.TIMEOUT_S * 1000);
    const hdrs: Record<string, string> = {};
    for (const line of headers) {
      const i = line.indexOf(':');
      if (i > 0) hdrs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const settle = (r: [string | false, number, string]) => {
      clearTimeout(timer);
      if (this.open.get(key) !== ctrl) return; // cancelled or replaced meanwhile
      this.open.delete(key);
      this.finished.set(key, r);
      this.wake?.();
    };
    fetch(url, { method: 'POST', headers: hdrs, body, signal: ctrl.signal })
      .then(async (res) => settle([await res.text(), res.status, '']))
      .catch((e: any) => settle([false, 0, String(e?.message ?? e) || 'fetch error']));
  }

  cancel(key: number): void {
    const ctrl = this.open.get(key);
    if (ctrl !== undefined) {
      this.open.delete(key);
      ctrl.abort();
    }
    this.finished.delete(key);
  }

  done(): Map<number, [string | false, number, string]> {
    const out = this.finished;
    this.finished = new Map();
    return out;
  }

  /** Sleep until a request has news, at most `seconds`. */
  wait(seconds: number): Promise<void> {
    if (this.finished.size > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, seconds * 1000);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }
}

type Command = [string, string[]];

/**
 * The event worker's children: the run-schedule entry point per event run, killed past runLimitS, and the
 * scheduler tick, one at a time. Children's output goes to the worker's own stdout/stderr. The twin of
 * PHP's ProcRunSpawner (proc_open); the commands are given (node + the entry script) instead of PHP_BINARY.
 */
export class ProcRunSpawner implements RunSpawner {
  private runs = new Map<number, { proc: ChildProcess | null; started: number; exit: number | null }>();
  private tick: { proc: ChildProcess; exit: number | null } | null = null;
  private tickStarted = 0;

  constructor(
    private readonly runCommand: (scheduleId: number) => Command,
    private readonly tickCommand: Command,
    private readonly cwd: string,
    private readonly runLimitS = 1800,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private spawnChild(cmd: Command): ChildProcess | null {
    try {
      return spawn(cmd[0], cmd[1], { cwd: this.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      return null;
    }
  }

  start(key: number, scheduleId: number): void {
    if (this.runs.has(key)) {
      this.log(`run for user ${key} is still in flight: schedule ${scheduleId} not started`);
      throw new Error(`a run for user ${key} is still in flight`);
    }
    const proc = this.spawnChild(this.runCommand(scheduleId));
    const entry = { proc, started: Date.now() / 1000, exit: null as number | null };
    if (proc === null) {
      this.log(`run for user ${key} (schedule ${scheduleId}) could not start`);
    } else {
      proc.on('error', () => { entry.exit = 127; });
      proc.on('exit', (code, signal) => { entry.exit = code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1); });
    }
    this.runs.set(key, entry);
  }

  done(): Map<number, number> {
    this.reapTick();
    const out = new Map<number, number>();
    for (const [key, r] of [...this.runs]) {
      if (r.proc === null) {
        out.set(key, 127);
        this.runs.delete(key);
        continue;
      }
      if (r.exit === null && Date.now() / 1000 - r.started > this.runLimitS) {
        this.log(`run for user ${key} passed ${this.runLimitS} s: killed`);
        r.proc.kill('SIGKILL');
        r.exit = 137;
      }
      if (r.exit !== null) {
        out.set(key, r.exit);
        this.runs.delete(key);
      }
    }
    return out;
  }

  /** Close a finished tick; kill one past runLimitS so a hung tick never blocks the schedule-mode workflows. */
  private reapTick(): void {
    if (this.tick === null) return;
    if (this.tick.exit === null) {
      if (Date.now() / 1000 - this.tickStarted <= this.runLimitS) return;
      this.log(`scheduler tick passed ${this.runLimitS} s: killed`);
      this.tick.proc.kill('SIGKILL');
    }
    this.tick = null;
  }

  scheduleTick(): void {
    this.reapTick();
    if (this.tick !== null) return; // the previous minute's tick still runs
    const proc = this.spawnChild(this.tickCommand);
    if (proc !== null) {
      const t = { proc, exit: null as number | null };
      proc.on('error', () => { t.exit = 127; });
      proc.on('exit', (code) => { t.exit = code ?? 1; });
      this.tick = t;
    }
    this.tickStarted = Date.now() / 1000;
  }

  /** SIGTERM: let the children finish up to graceS, then kill them. */
  async stopAll(graceS: number): Promise<void> {
    const end = Date.now() / 1000 + graceS;
    while ((this.runs.size > 0 || this.tick !== null) && Date.now() / 1000 < end) {
      this.done();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.tick !== null) {
      this.tick.proc.kill('SIGKILL');
      this.tick = null;
    }
    for (const r of this.runs.values()) r.proc?.kill('SIGKILL');
  }
}
