import { sql, RawBuilder } from 'kysely';
import { db } from '../db/pools';
import { phpIntval } from './WorkflowRepository';

/**
 * Faithful mirror of src/AgentTeam/Services/ScheduledWorkflowService.php.
 *
 * PORTED: create, update, delete, findById, findByUser, findByWorkflow, pause, resume, getStats,
 *   the private calculateNextRun, plus the cron-execution engine (getDueSchedules, markRunning,
 *   markCompleted, markFailed) driven by SchedulerController. markCompleted/markFailed exercise
 *   calculateNextRun for recurring schedules.
 *
 * Rows are returned as raw DB assoc objects (mirroring PDO::FETCH_ASSOC). Columns: id, user_id,
 * workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, last_run,
 * next_run, created_at, error_message, plus workflow_name (from the LEFT JOIN on agent_workflows).
 *
 * Driver parity: PDO(EMULATE_PREPARES=false, mysqlnd) and mysql2 both return INT columns as JS
 * numbers, DATETIME as strings (dateStrings:true), and DECIMAL (SUM) as strings — so ownership
 * comparisons (number !== number) and the stats shape line up with PHP.
 */
export class ScheduledWorkflowService {
  /** Mirrors create(). Inserts with status 'pending', next_run = scheduled_time, created_at NOW(). */
  async create(data: any): Promise<any> {
    const scheduledTime = data.scheduled_time;
    const nextRun = scheduledTime; // First run is the scheduled time

    const res = await sql`
      INSERT INTO scheduled_workflows
      (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, next_run, created_at)
      VALUES
      (${data.user_id}, ${data.workflow_id}, ${data.input_prompt ?? null}, ${scheduledTime}, 'pending', ${data.repeat_type ?? 'none'}, ${data.repeat_interval ?? 1}, ${nextRun}, NOW())
    `.execute(db);

    const id = Number(res.insertId);
    return this.findById(id);
  }

  /** Mirrors update(): ownership check, then a dynamic SET of only the supplied fields. */
  async update(id: number, userId: number, data: any): Promise<any | null> {
    // First verify ownership
    const schedule = await this.findById(id);
    if (!schedule || schedule.user_id !== userId) {
      return null;
    }

    const fields: RawBuilder<unknown>[] = [];

    // PHP isset(): key present AND not null.
    const isset = (k: string) => data[k] !== undefined && data[k] !== null;

    if (isset('scheduled_time')) {
      fields.push(sql`scheduled_time = ${data.scheduled_time}`);
      fields.push(sql`next_run = ${data.scheduled_time}`);
    }

    if (isset('input_prompt')) {
      fields.push(sql`input_prompt = ${data.input_prompt}`);
    }

    if (isset('repeat_type')) {
      fields.push(sql`repeat_type = ${data.repeat_type}`);
    }

    if (isset('repeat_interval')) {
      fields.push(sql`repeat_interval = ${data.repeat_interval}`);
    }

    if (isset('status')) {
      fields.push(sql`status = ${data.status}`);
    }

    if (fields.length === 0) {
      return schedule;
    }

    await sql`UPDATE scheduled_workflows SET ${sql.join(fields)} WHERE id = ${id}`.execute(db);

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
   * Mirrors calculateNextRun(). NOTE: the PHP CRUD methods never call this (create/update set
   * next_run = scheduled_time directly); it is exercised only by the deferred cron methods
   * markCompleted/markFailed. Ported for parity.
   *
   * PHP uses DateTime + DateInterval and returns date('Y-m-d H:i:s').
   */
  private calculateNextRun(currentRun: string, repeatType: string, interval: number): string {
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
        // No repeat
        break;
    }

    return formatSqlDateTime(date);
  }

  /**
   * Mirrors getDueSchedules(): pending schedules whose next_run has arrived, joined to workflow name
   * and user email, oldest first, capped at 50. Raw assoc rows (DATETIME as strings), like PHP.
   */
  async getDueSchedules(): Promise<any[]> {
    return (
      await sql<any>`
        SELECT sw.*, w.name as workflow_name, u.email as user_email
        FROM scheduled_workflows sw
        LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
        LEFT JOIN users u ON sw.user_id = u.id
        WHERE sw.status = 'pending'
          AND sw.next_run <= NOW()
        ORDER BY sw.next_run ASC
        LIMIT 50
      `.execute(db)
    ).rows;
  }

  /** Mirrors markRunning(): flip status to 'running'. */
  async markRunning(id: number): Promise<void> {
    await sql`
      UPDATE scheduled_workflows
      SET status = 'running'
      WHERE id = ${id}
    `.execute(db);
  }

  /**
   * Mirrors markCompleted(): for one-time schedules mark 'completed'; for recurring, compute the next
   * run and reset to 'pending'. No-op when the schedule is gone. (executionId is accepted for parity
   * with PHP but unused, exactly as in PHP.)
   */
  async markCompleted(id: number, executionId: string | null = null): Promise<void> {
    void executionId;
    const schedule = await this.findById(id);
    if (!schedule) {
      return;
    }

    const repeatType = schedule.repeat_type;
    const repeatInterval = phpIntval(schedule.repeat_interval);

    if (repeatType === 'none') {
      // One-time schedule - mark as completed
      await sql`
        UPDATE scheduled_workflows
        SET status = 'completed', last_run = NOW()
        WHERE id = ${id}
      `.execute(db);
    } else {
      // Recurring - calculate next run and reset to pending
      const nextRun = this.calculateNextRun(schedule.next_run, repeatType, repeatInterval);
      await sql`
        UPDATE scheduled_workflows
        SET status = 'pending', last_run = NOW(), next_run = ${nextRun}
        WHERE id = ${id}
      `.execute(db);
    }
  }

  /**
   * Mirrors markFailed(): one-time schedules become 'failed' with the error stored; recurring ones are
   * reset to 'pending' for the next attempt (error logged), with next_run advanced. No-op when gone.
   */
  async markFailed(id: number, errorMessage: string): Promise<void> {
    const schedule = await this.findById(id);
    if (!schedule) {
      return;
    }

    const repeatType = schedule.repeat_type;

    if (repeatType === 'none') {
      // One-time - mark as failed permanently
      await sql`
        UPDATE scheduled_workflows
        SET status = 'failed', error_message = ${errorMessage}, last_run = NOW()
        WHERE id = ${id}
      `.execute(db);
    } else {
      // Recurring - reset to pending for next attempt, but log the error
      const repeatInterval = phpIntval(schedule.repeat_interval);
      const nextRun = this.calculateNextRun(schedule.next_run, repeatType, repeatInterval);
      await sql`
        UPDATE scheduled_workflows
        SET status = 'pending', error_message = ${errorMessage}, last_run = NOW(), next_run = ${nextRun}
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

/** Parse a 'Y-m-d H:i:s' string into a local Date (mirrors PHP's new DateTime() on such a string). */
function parseSqlDateTime(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
  }
  return new Date(s);
}

/** Format a Date as 'Y-m-d H:i:s' (mirrors PHP date('Y-m-d H:i:s')). */
function formatSqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
