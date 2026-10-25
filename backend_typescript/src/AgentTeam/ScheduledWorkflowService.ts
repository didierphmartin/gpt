import { sql, RawBuilder } from 'kysely';
import { db } from '../db/pools';
import { phpIntval, phpEmpty, phpBool } from './WorkflowRepository';
import { CronExpression, parseSqlDateTime, sqlDateTime } from './CronExpression';

/** A refused schedule input (PHP \InvalidArgumentException): the controllers answer it with 400. */
export class ScheduleInputError extends Error {}

const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const phpStr = (v: any) => (v === null || v === undefined || v === false ? '' : v === true ? '1' : String(v));

/**
 * Faithful mirror of src/AgentTeam/Services/ScheduledWorkflowService.php: schedule CRUD, the cron and
 * event repeat types, and the tick's engine (getDueSchedules, the atomic claim, touchRunning,
 * markCompleted, markFailed).
 *
 * Rows are returned as raw DB assoc objects (mirroring PDO::FETCH_ASSOC), with workflow_name from the
 * LEFT JOIN on agent_workflows. The clock is injectable; the default reads the database's NOW(), so
 * "server time" matches the NOW() used in the SQL.
 */
export class ScheduledWorkflowService {
  static readonly REPEAT_TYPES = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron', 'event'];
  /** A run 'running' for longer than this is treated as crashed and may be claimed again. */
  static readonly STALE_RUNNING_MINUTES = 60;

  constructor(private readonly clock: (() => Date | Promise<Date>) | null = null) {}

  private async now(): Promise<Date> {
    if (this.clock !== null) return new Date((await this.clock()).getTime());
    const row = (await sql<any>`SELECT NOW() AS now`.execute(db)).rows[0];
    const v = row?.now ?? Object.values(row ?? {})[0];
    return v instanceof Date ? v : parseSqlDateTime(String(v));
  }

  /** One clock read as [now, stale-threshold] strings, so a statement sees a single instant. */
  private async nowAndStale(): Promise<[string, string]> {
    const t = await this.now();
    const stale = new Date(t.getTime());
    stale.setMinutes(stale.getMinutes() - ScheduledWorkflowService.STALE_RUNNING_MINUTES);
    return [sqlDateTime(t), sqlDateTime(stale)];
  }

  private async nextCronRun(cron: string): Promise<string> {
    return sqlDateTime(new CronExpression(cron).nextAfter(await this.now()));
  }

  /**
   * Mirrors ScheduledWorkflowService::eventTrigger(): an event schedule's trigger {server, tool, args}
   * (a JSON string or an object), validated and normalised to its stored JSON; args stay an object.
   * Throws (PHP InvalidArgumentException) with the PHP message on a bad shape.
   */
  static eventTrigger(raw: unknown): string {
    let t: any = raw;
    if (typeof raw === 'string') {
      try {
        t = JSON.parse(raw);
      } catch {
        t = null;
      }
    }
    if (t === null || typeof t !== 'object') {
      throw new ScheduleInputError('An event schedule needs event_trigger: {"server", "tool", "args"}');
    }
    const trim = (v: unknown) =>
      (v === undefined || v === null ? '' : typeof v === 'object' ? 'Array' : String(v)).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
    const server = trim(t.server);
    const tool = trim(t.tool);
    const args = t.args ?? [];
    if (server === '' || tool === '') {
      throw new ScheduleInputError('event_trigger needs an MCP server and a tool');
    }
    // PHP: !is_array($args) || ($args !== [] && array_is_list($args)) -- a JSON object, or [] (stored as {})
    if (args === null || typeof args !== 'object' || (Array.isArray(args) && args.length > 0)) {
      throw new ScheduleInputError('event_trigger.args must be a JSON object');
    }
    return JSON.stringify({ server, tool, args: Array.isArray(args) ? {} : args });
  }

  /** Mirrors create(): a cron schedule first fires on its next cron minute, an event schedule never (no next_run). */
  async create(data: any): Promise<any> {
    const repeatType = data.repeat_type ?? 'none';
    const cron = repeatType === 'cron' ? phpTrim(phpStr(data.cron ?? '')) : null;
    if (repeatType === 'cron' && !CronExpression.isValid(cron as string)) {
      throw new ScheduleInputError('Invalid cron expression');
    }
    const event = repeatType === 'event' ? ScheduledWorkflowService.eventTrigger(data.event_trigger ?? null) : null;
    const scheduledTime = data.scheduled_time ?? sqlDateTime(await this.now());
    const nextRun = cron !== null ? await this.nextCronRun(cron) : event !== null ? null : scheduledTime;
    // event_trigger is written only for event schedules: the others keep working on a database the event
    // migration has not reached yet.
    const optionId = event !== null && !phpEmpty(data.trigger_component_id) ? phpIntval(data.trigger_component_id) : null;
    const cols = [sql`user_id`, sql`workflow_id`, sql`input_prompt`, sql`scheduled_time`, sql`status`, sql`repeat_type`,
      sql`repeat_interval`, sql`cron`, sql`next_run`, sql`created_at`];
    const vals = [sql`${data.user_id}`, sql`${data.workflow_id}`, sql`${data.input_prompt ?? null}`, sql`${scheduledTime}`,
      sql`'pending'`, sql`${repeatType}`, sql`${data.repeat_interval ?? 1}`, sql`${cron}`, sql`${nextRun}`, sql`NOW()`];
    if (event !== null) {
      cols.push(sql`event_trigger`);
      vals.push(sql`${event}`);
    }
    if (optionId !== null) {
      cols.push(sql`trigger_component_id`);
      vals.push(sql`${optionId}`);
    }
    const res = await sql`INSERT INTO scheduled_workflows (${sql.join(cols)}) VALUES (${sql.join(vals)})`.execute(db);
    return this.findById(Number(res.insertId));
  }

  /** Mirrors update(): ownership check, then a dynamic SET of the supplied fields, with the cron and event rules. */
  async update(id: number, userId: number, data: any): Promise<any | null> {
    const schedule = await this.findById(id);
    if (!schedule || phpIntval(schedule.user_id) !== userId) {
      return null;
    }

    // [key, fragment]: the key lets the cron/event rules drop the scheduled_time-derived next_run.
    let fields: Array<[string, RawBuilder<unknown>]> = [];
    const isset = (k: string) => data[k] !== undefined && data[k] !== null;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k);
    const NEXT = 'next_run = :next_run';

    if (isset('scheduled_time')) {
      fields.push(['scheduled_time', sql`scheduled_time = ${data.scheduled_time}`]);
      fields.push([NEXT, sql`next_run = ${data.scheduled_time}`]);
    }
    if (isset('input_prompt')) fields.push(['input_prompt', sql`input_prompt = ${data.input_prompt}`]);
    if (isset('repeat_type')) fields.push(['repeat_type', sql`repeat_type = ${data.repeat_type}`]);
    if (isset('repeat_interval')) fields.push(['repeat_interval', sql`repeat_interval = ${data.repeat_interval}`]);

    const repeatType = data.repeat_type ?? schedule.repeat_type;
    if (has('cron') || repeatType === 'cron') {
      const cron = repeatType === 'cron' ? phpTrim(phpStr(data.cron ?? schedule.cron ?? '')) : null;
      if (repeatType === 'cron' && !CronExpression.isValid(cron as string)) {
        throw new ScheduleInputError('Invalid cron expression');
      }
      fields.push(['cron', sql`cron = ${cron}`]);
      if (cron !== null) {
        // The cron decides the next run; replace any scheduled_time-derived next_run.
        fields = fields.filter(([k]) => k !== NEXT);
        fields.push([NEXT, sql`next_run = ${await this.nextCronRun(cron)}`]);
      }
    }

    // Event: the trigger is (re)validated and next_run cleared; leaving 'event' clears the trigger.
    if (repeatType === 'event') {
      fields = fields.filter(([k]) => k !== NEXT);
      const trigger = ScheduledWorkflowService.eventTrigger(data.event_trigger ?? schedule.event_trigger ?? null);
      fields.push(['event_trigger', sql`event_trigger = ${trigger}`]);
      fields.push(['next_run = NULL', sql`next_run = NULL`]);
      if (has('trigger_component_id')) {
        const cid = phpBool(data.trigger_component_id) ? phpIntval(data.trigger_component_id) : null;
        fields.push(['trigger_component_id', sql`trigger_component_id = ${cid}`]);
      } else if (has('event_trigger')) { // a hand-made trigger: no longer the option's
        fields.push(['trigger_component_id', sql`trigger_component_id = NULL`]);
      }
    } else if ((schedule.repeat_type ?? '') === 'event') {
      fields.push(['event_trigger', sql`event_trigger = NULL`]);
      fields.push(['trigger_component_id', sql`trigger_component_id = NULL`]);
      if (!fields.some(([k]) => k === NEXT)) { // back to a timed schedule: from its time
        fields.push([NEXT, sql`next_run = ${schedule.scheduled_time}`]);
      }
    }

    if (isset('status')) fields.push(['status', sql`status = ${data.status}`]);

    if (fields.length === 0) {
      return schedule;
    }

    await sql`UPDATE scheduled_workflows SET ${sql.join(fields.map(([, f]) => f))} WHERE id = ${id}`.execute(db);
    return this.findById(id);
  }

  /** Mirrors delete(): DELETE scoped by id + user_id; true when a row was removed. */
  async delete(id: number, userId: number): Promise<boolean> {
    const res = await sql`
      DELETE FROM scheduled_workflows
      WHERE id = ${id} AND user_id = ${userId}
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /** Mirrors findById(): raw row (with workflow_name join) or null. */
  async findById(id: number): Promise<any | null> {
    const row = (
      await sql<any>`
        SELECT sw.*, w.name as workflow_name
        FROM scheduled_workflows sw
        LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
        WHERE sw.id = ${id}
      `.execute(db)
    ).rows[0];
    return row ?? null;
  }

  /** Mirrors findByUser(): all of a user's schedules, ordered by next_run ASC. */
  async findByUser(userId: number): Promise<any[]> {
    return (
      await sql<any>`
        SELECT sw.*, w.name as workflow_name
        FROM scheduled_workflows sw
        LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
        WHERE sw.user_id = ${userId}
        ORDER BY sw.next_run ASC
      `.execute(db)
    ).rows;
  }

  /** Mirrors findByWorkflow(): a workflow's schedules scoped to the user, ordered by next_run ASC. */
  async findByWorkflow(workflowId: number, userId: number): Promise<any[]> {
    return (
      await sql<any>`
        SELECT sw.*, w.name as workflow_name
        FROM scheduled_workflows sw
        LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
        WHERE sw.workflow_id = ${workflowId} AND sw.user_id = ${userId}
        ORDER BY sw.next_run ASC
      `.execute(db)
    ).rows;
  }

  /**
   * Mirrors calculateNextRun(): a cron schedule from now (a late tick must not replay missed minutes),
   * the others from the last next_run (PHP DateTime + DateInterval).
   */
  private async calculateNextRun(currentRun: string, repeatType: string, interval: number, cron: string | null = null): Promise<string> {
    if (repeatType === 'cron') {
      return this.nextCronRun(String(cron ?? ''));
    }
    const date = parseSqlDateTime(currentRun);
    switch (repeatType) {
      case 'hourly':
        date.setHours(date.getHours() + interval);
        break;
      case 'daily':
        date.setDate(date.getDate() + interval);
        break;
      case 'weekly':
        date.setDate(date.getDate() + interval * 7);
        break;
      case 'monthly':
        date.setMonth(date.getMonth() + interval);
        break;
      default:
        break;
    }
    return sqlDateTime(date);
  }

  /**
   * Mirrors getDueSchedules(): pending and due, or 'running' for longer than STALE_RUNNING_MINUTES (a
   * crashed run). workflowIds limits them (only active workflows run); [] means none, null every one.
   */
  async getDueSchedules(workflowIds: number[] | null = null): Promise<any[]> {
    if (workflowIds !== null && workflowIds.length === 0) {
      return [];
    }
    const only = workflowIds === null ? sql`` : sql` AND sw.workflow_id IN (${sql.raw(workflowIds.map((v) => phpIntval(v)).join(','))})`;
    const [now, stale] = await this.nowAndStale();
    return (
      await sql<any>`
        SELECT sw.*, w.name as workflow_name, u.email as user_email
        FROM scheduled_workflows sw
        LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
        LEFT JOIN users u ON sw.user_id = u.id
        WHERE ((sw.status = 'pending' AND sw.next_run <= ${now})
           OR (sw.status = 'running' AND (sw.running_since IS NULL OR sw.running_since < ${stale})))${only}
        ORDER BY sw.next_run ASC
        LIMIT 50
      `.execute(db)
    ).rows;
  }

  /**
   * Mirrors claim(): take a due schedule for this tick. Atomic: of two overlapping ticks only one gets
   * true. A 'running' row older than STALE_RUNNING_MINUTES can be taken again.
   */
  async claim(id: number): Promise<boolean> {
    const [now, stale] = await this.nowAndStale();
    const res = await sql`
      UPDATE scheduled_workflows
      SET status = 'running', running_since = ${now}
      WHERE id = ${id}
        AND ((status = 'pending' AND next_run <= ${now})
             OR (status = 'running' AND (running_since IS NULL OR running_since < ${stale})))
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /** Mirrors touchRunning(): a long drain keeps its claim fresh; only a running schedule is touched. */
  async touchRunning(id: number): Promise<void> {
    await sql`UPDATE scheduled_workflows SET running_since = ${sqlDateTime(await this.now())} WHERE id = ${id} AND status = 'running'`.execute(db);
  }

  /**
   * Mirrors markCompleted(): an event row goes back to pending with no next run; a one-time schedule is
   * 'completed'; a recurring one computes its next run and resets to 'pending'. executionId is unused, as in PHP.
   */
  async markCompleted(id: number, executionId: string | null = null): Promise<void> {
    void executionId;
    const schedule = await this.findById(id);
    if (!schedule) return;
    const repeatType = schedule.repeat_type;
    const repeatInterval = phpIntval(schedule.repeat_interval);

    if (repeatType === 'event') {
      // An event row has no next run: it runs when its event fires.
      await sql`UPDATE scheduled_workflows SET status = 'pending', last_run = NOW(), running_since = NULL WHERE id = ${id}`.execute(db);
      return;
    }
    if (repeatType === 'none') {
      await sql`
        UPDATE scheduled_workflows
        SET status = 'completed', last_run = NOW(), running_since = NULL
        WHERE id = ${id}
      `.execute(db);
    } else {
      const nextRun = await this.calculateNextRun(schedule.next_run, repeatType, repeatInterval, schedule.cron ?? null);
      await sql`
        UPDATE scheduled_workflows
        SET status = 'pending', last_run = NOW(), running_since = NULL, next_run = ${nextRun}
        WHERE id = ${id}
      `.execute(db);
    }
  }

  /**
   * Mirrors markFailed(): a one-time schedule becomes 'failed' with the error; a recurring one is reset to
   * 'pending' for its next run, the error kept.
   */
  async markFailed(id: number, errorMessage: string): Promise<void> {
    const schedule = await this.findById(id);
    if (!schedule) return;
    const repeatType = schedule.repeat_type;
    if (repeatType === 'none') {
      await sql`
        UPDATE scheduled_workflows
        SET status = 'failed', error_message = ${errorMessage}, last_run = NOW(), running_since = NULL
        WHERE id = ${id}
      `.execute(db);
    } else {
      const repeatInterval = phpIntval(schedule.repeat_interval);
      const nextRun = await this.calculateNextRun(schedule.next_run, repeatType, repeatInterval, schedule.cron ?? null);
      await sql`
        UPDATE scheduled_workflows
        SET status = 'pending', error_message = ${errorMessage}, last_run = NOW(), running_since = NULL, next_run = ${nextRun}
        WHERE id = ${id}
      `.execute(db);
    }
  }

  /** Mirrors pause(): set status 'paused' scoped by id + user_id; true when a row changed. */
  async pause(id: number, userId: number): Promise<boolean> {
    const res = await sql`
      UPDATE scheduled_workflows
      SET status = 'paused'
      WHERE id = ${id} AND user_id = ${userId}
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /** Mirrors resume(): set status 'pending' only when currently 'paused'; true when a row changed. */
  async resume(id: number, userId: number): Promise<boolean> {
    const res = await sql`
      UPDATE scheduled_workflows
      SET status = 'pending'
      WHERE id = ${id} AND user_id = ${userId} AND status = 'paused'
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /** Mirrors getStats(): single aggregate row. total is a number; the SUM() columns are strings
   * (DECIMAL) or null when the user has no schedules — matching PHP's PDO output. */
  async getStats(userId: number): Promise<any> {
    const row = (
      await sql<any>`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused
        FROM scheduled_workflows
        WHERE user_id = ${userId}
      `.execute(db)
    ).rows[0];
    return row;
  }
}

