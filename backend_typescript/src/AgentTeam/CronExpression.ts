/** A refused cron expression (PHP \InvalidArgumentException). */
export class CronError extends Error {}

const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
/** Day steps bound the search at about 164 years: enough for a leap day, bounded for never-firing input. */
const MAX_STEPS = 60000;

/**
 * A standard 5-field cron expression (minute hour day-of-month month day-of-week), server timezone.
 * Fields take *, n, a-b, and /step on either, comma-separated. Day-of-week 0 and 7 are Sunday. When
 * both day fields are restricted, a day matches either (standard cron).
 * Mirrors backend/src/AgentTeam/Services/CronExpression.php (local Date = PHP's server timezone).
 */
export class CronExpression {
  private sets: Array<Set<number>> = [];
  private domStar: boolean;
  private dowStar: boolean;

  constructor(expr: string) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new CronError('cron needs 5 fields: minute hour day-of-month month day-of-week');
    }
    parts.forEach((p, i) => {
      this.sets[i] = CronExpression.field(p, RANGES[i][0], RANGES[i][1]);
    });
    if (this.sets[4].has(7)) {
      this.sets[4].add(0);
      this.sets[4].delete(7);
    }
    this.domStar = parts[2] === '*';
    this.dowStar = parts[4] === '*';
  }

  static isValid(expr: string): boolean {
    try {
      new CronExpression(expr).nextAfter(new Date());
      return true;
    } catch {
      return false;
    }
  }

  private static field(f: string, lo: number, hi: number): Set<number> {
    const out = new Set<number>();
    for (const item of f.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new CronError(`bad cron field '${f}'`);
      let a: number;
      let b: number;
      if (m[1] === '*') {
        [a, b] = [lo, hi];
      } else if (m[1].includes('-')) {
        [a, b] = m[1].split('-').map((x) => parseInt(x, 10));
      } else {
        a = b = parseInt(m[1], 10);
        if (m[2] !== undefined) b = hi; // "5/10" = from 5, every 10
      }
      const step = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      if (a < lo || b > hi || a > b || step < 1) {
        throw new CronError(`cron field '${f}' is out of range ${lo}-${hi}`);
      }
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  }

  matches(t: Date): boolean {
    return this.dayMatches(t) && this.sets[1].has(t.getHours()) && this.sets[0].has(t.getMinutes());
  }

  private dayMatches(t: Date): boolean {
    if (!this.sets[3].has(t.getMonth() + 1)) return false;
    const dom = this.sets[2].has(t.getDate());
    const dow = this.sets[4].has(t.getDay());
    return this.domStar || this.dowStar ? dom && dow : dom || dow;
  }

  /** The first minute strictly after `after` that matches. */
  nextAfter(after: Date): Date {
    const t = new Date(after.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    for (let i = 0; i < MAX_STEPS; i++) {
      if (!this.dayMatches(t)) {
        t.setHours(0, 0, 0, 0);
        t.setDate(t.getDate() + 1);
        continue;
      }
      if (!this.sets[1].has(t.getHours())) {
        t.setMinutes(0, 0, 0);
        t.setHours(t.getHours() + 1);
        continue;
      }
      for (let m = t.getMinutes(); m < 60; m++) {
        if (this.sets[0].has(m)) {
          t.setMinutes(m, 0, 0);
          return t;
        }
      }
      t.setMinutes(0, 0, 0);
      t.setHours(t.getHours() + 1);
    }
    throw new CronError('cron expression never fires');
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date -> 'Y-m-d H:i:s' (local). */
export function sqlDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'Y-m-d H:i:s' (or 'Y-m-d H:i', 'Y-m-d') -> a local Date, as PHP's new DateTime() reads it. */
export function parseSqlDateTime(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  return new Date(s);
}
