import { sql } from 'kysely';
import { db } from '../db/pools';
import { phpIntval } from './WorkflowRepository';
import { parseSqlDateTime } from './CronExpression';

/** A refused activation: kind for the editor, status for the API. Mirrors ActiveWorkflowError.php. */
export class ActiveWorkflowError extends Error {
  constructor(public readonly kind: string, message: string, public readonly status: number) {
    super(message);
  }
}

export type WorkflowMode = { mode: string; schedule: Record<string, any> | null; component_id: number | null };

const seconds = (v: any): number => Math.floor(parseSqlDateTime(String(v)).getTime() / 1000);

/**
 * The workflow each user activated with ▶ on Start: the event worker runs it on its schedule, or on its
 * Start option's event. One per user. Ticking a mode never activates; a mode change deactivates.
 * Mirrors backend/src/AgentTeam/Services/ActiveWorkflowService.php.
 */
export class ActiveWorkflowService {
  static readonly TIMED = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron'];

  /**
   * The workflow's input mode, read from its saved data as the editor's StartOptions.active() reads it: the
   * newest pending/running schedule row decides; an event row counts only while Start is on that row's option.
   */
  async mode(workflowId: number): Promise<WorkflowMode> {
    const row = (await sql<any>`SELECT * FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND status IN ('pending', 'running')
      ORDER BY id DESC LIMIT 1`.execute(db)).rows[0] ?? null;
    if (row === null) {
      return { mode: 'prompt', schedule: null, component_id: null };
    }
    if ((row.repeat_type ?? '') !== 'event') {
      return { mode: ActiveWorkflowService.TIMED.includes(row.repeat_type) ? 'schedule' : 'mode_gone', schedule: row, component_id: null };
    }
    const cid = phpIntval(row.trigger_component_id ?? 0);
    const start = await this.startNode(workflowId);
    const onIt = cid > 0 && start !== null && phpIntval(start.config.start_option ?? 0) === cid && (await this.isOption(cid));
    return { mode: onIt ? 'option' : 'mode_gone', schedule: row, component_id: cid || null };
  }

  /** Only what Start reaches is active: a Start with no outgoing edge has nothing to run. */
  async startHasLinks(workflowId: number): Promise<boolean> {
    const start = await this.startNode(workflowId);
    if (start === null) return false;
    const r = (await sql<any>`SELECT COUNT(*) AS c FROM workflow_edges WHERE from_node_id = ${start.id}`.execute(db)).rows[0];
    return phpIntval(r?.c ?? 0) > 0;
  }

  async activate(userId: number, workflowId: number): Promise<{ active: Record<string, any> | null; replaced: Record<string, any> | null }> {
    const wf = (await sql<any>`SELECT id, user_id, name FROM agent_workflows WHERE id = ${workflowId}`.execute(db)).rows[0];
    if (!wf || phpIntval(wf.user_id) !== userId) {
      throw new ActiveWorkflowError('not_found', 'Workflow not found', 404);
    }
    const mode = await this.mode(workflowId);
    if (!['schedule', 'option'].includes(mode.mode)) {
      throw new ActiveWorkflowError('no_trigger', 'Pick Set Schedule or a code option first', 422);
    }
    if (!(await this.startHasLinks(workflowId))) {
      throw new ActiveWorkflowError('no_links', 'Start has no links', 422);
    }
    const before = await this.get(userId);
    const replaced = before && phpIntval(before.workflow_id) !== workflowId
      ? { workflow_id: phpIntval(before.workflow_id), workflow_name: before.workflow_name } : null;
    await db.transaction().execute(async (trx) => {
      await sql`DELETE FROM active_workflows WHERE user_id = ${userId}`.execute(trx);
      await sql`INSERT INTO active_workflows (user_id, workflow_id, mode, trigger_component_id, activated_at, watch_state)
        VALUES (${userId}, ${workflowId}, ${mode.mode}, ${mode.component_id}, NOW(), 'starting')`.execute(trx);
    });
    return { active: await this.get(userId), replaced };
  }

  async deactivate(userId: number, workflowId: number): Promise<void> {
    await sql`DELETE FROM active_workflows WHERE user_id = ${userId} AND workflow_id = ${workflowId}`.execute(db);
  }

  /** The user's active row, or null; ages in seconds from the database's NOW() (the worker's clock). */
  async get(userId: number): Promise<Record<string, any> | null> {
    const row = (await sql<any>`SELECT a.*, w.name AS workflow_name, NOW() AS db_now FROM active_workflows a
      LEFT JOIN agent_workflows w ON w.id = a.workflow_id WHERE a.user_id = ${userId}`.execute(db)).rows[0];
    if (!row) return null;
    const now = seconds(row.db_now);
    row.checked_age_s = row.watch_checked_at ? now - seconds(row.watch_checked_at) : null;
    row.activated_age_s = now - seconds(row.activated_at);
    delete row.db_now;
    return row;
  }

  /** Every active row with its workflow's owner and enabled flag (the worker's reconcile). */
  async all(): Promise<Record<string, any>[]> {
    return (await sql<any>`SELECT a.*, w.user_id AS owner_id, w.enabled FROM active_workflows a
      JOIN agent_workflows w ON w.id = a.workflow_id ORDER BY a.user_id`.execute(db)).rows;
  }

  /** Whether the worker may serve the row now; a row that may not is idle, not deactivated (fixing it resumes it). */
  async check(row: Record<string, any>): Promise<{ ok: boolean; reason: string | null; mode: WorkflowMode }> {
    const mode = await this.mode(phpIntval(row.workflow_id));
    let reason: string | null = null;
    if (phpIntval(row.enabled ?? 1) !== 1) reason = 'disabled';
    else if (mode.mode !== row.mode) reason = 'mode_gone';
    else if (!(await this.startHasLinks(phpIntval(row.workflow_id)))) reason = 'no_links';
    return { ok: reason === null, reason, mode };
  }

  /** Deactivate the rows whose workflow's mode (or option) is no longer the one activated; returns their workflow ids. */
  async sweep(): Promise<number[]> {
    const gone: number[] = [];
    for (const row of await this.all()) {
      const mode = await this.mode(phpIntval(row.workflow_id));
      const same = mode.mode === row.mode
        && (row.mode !== 'option' || phpIntval(mode.component_id) === phpIntval(row.trigger_component_id));
      if (!same) {
        await this.deactivate(phpIntval(row.user_id), phpIntval(row.workflow_id));
        gone.push(phpIntval(row.workflow_id));
      }
    }
    return gone;
  }

  async setState(userId: number, state: string, message: string | null): Promise<void> {
    await sql`UPDATE active_workflows SET watch_state = ${state}, watch_message = ${message}, watch_checked_at = NOW() WHERE user_id = ${userId}`.execute(db);
  }

  /**
   * The schedule-mode workflows the scheduler tick may run: only the rows that qualify now (check():
   * enabled, Start linked, still in schedule mode) -- an idle one must not run.
   */
  async scheduleWorkflowIds(): Promise<number[]> {
    const ids: number[] = [];
    for (const row of await this.all()) {
      if (row.mode === 'schedule' && (await this.check(row)).ok) ids.push(phpIntval(row.workflow_id));
    }
    return ids;
  }

  /** The workflow's Start node (not its other nodes), config decoded. */
  private async startNode(workflowId: number): Promise<{ id: number; config: Record<string, any> } | null> {
    const row = (await sql<any>`SELECT id, config FROM workflow_nodes WHERE workflow_id = ${workflowId} AND node_type = 'start' ORDER BY id LIMIT 1`.execute(db)).rows[0];
    if (!row) return null;
    let cfg: any = row.config;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null;
      }
    }
    return { id: phpIntval(row.id), config: cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {} };
  }

  private async isOption(componentId: number): Promise<boolean> {
    const row = (await sql<any>`SELECT start_trigger FROM code_components WHERE id = ${componentId}`.execute(db)).rows[0];
    const t = row?.start_trigger;
    if (t !== null && typeof t === 'object') return true; // mysql2 hands a JSON column back decoded
    return typeof t === 'string' && t.trim() !== '' && t.trim() !== 'null';
  }
}
