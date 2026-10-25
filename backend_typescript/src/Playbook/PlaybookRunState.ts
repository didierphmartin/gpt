import { sql } from 'kysely';
import { db } from '../db/pools';
import { PlaybookDocument } from './PlaybookDocument';
import { PlaybookTranscript } from './PlaybookTranscript';
import { phpJson, sqlNow } from './php';

const REDACTED = '«redacted»';

/** Recursively sort object keys so identical args match regardless of key order (PHP ksort, recursive). */
function ksortRecursive(v: any): any {
  if (Array.isArray(v)) return v.map(ksortRecursive);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = ksortRecursive(v[k]);
    return out;
  }
  return v;
}

/**
 * The run record of one playbook run: playbook_runs and its messages, notes, ledger and gates.
 * Mirrors backend/src/Playbook/PlaybookRunState.php.
 *
 * PHP drops its PDO connection before a human gate blocks (the remote MySQL kills idle connections)
 * and reconnects lazily; here every query takes a pooled connection, so there is no connection to
 * hold across a gate and disconnect() is a no-op kept for the same call site.
 */
export class PlaybookRunState {
  constructor(readonly transcript: PlaybookTranscript | null = null) {}

  disconnect(): void {}

  async createRun(userId: number, doc: PlaybookDocument, requester: any, variables: any): Promise<number> {
    const now = sqlNow();
    const res = await sql`INSERT INTO playbook_runs
        (user_id, playbook_title, document, status, requester, variables, pending_gate, current_leg, coverage, created_at, updated_at, resolved_at)
      VALUES (${userId}, ${doc.title}, ${phpJson(doc.toArray())}, ${'running'}, ${phpJson(requester)}, ${phpJson(variables)}, NULL, 0, NULL, ${now}, ${now}, NULL)`.execute(db);
    return Number(res.insertId ?? 0);
  }

  async setStatus(runId: number, status: string): Promise<void> {
    await sql`UPDATE playbook_runs SET status = ${status}, updated_at = ${sqlNow()} WHERE id = ${runId}`.execute(db);
  }

  async addMessage(runId: number, direction: string, audience: string | null, text: string, sensitive = false): Promise<void> {
    await sql`INSERT INTO playbook_run_messages (run_id, direction, audience, text, \`sensitive\`, created_at)
      VALUES (${runId}, ${direction}, ${audience}, ${sensitive ? REDACTED : text}, ${sensitive ? 1 : 0}, ${sqlNow()})`.execute(db);
  }

  async addNote(runId: number, text: string, author = 'agent'): Promise<void> {
    await sql`INSERT INTO playbook_run_notes (run_id, author, text, created_at) VALUES (${runId}, ${author}, ${text}, ${sqlNow()})`.execute(db);
  }

  async ledgerAppend(runId: number, leg: number, actionName: string, tool: string, args: any, outcome: string,
    summary: string | null, sensitive = false): Promise<void> {
    const seqRow = (await sql<any>`SELECT COALESCE(MAX(seq), 0) AS seq FROM playbook_run_ledger WHERE run_id = ${runId}`.execute(db)).rows[0];
    const seq = 1 + Number(seqRow?.seq ?? 0);
    const argsJson = sensitive ? phpJson(REDACTED) : this.canon(args);
    const resultSummary = sensitive ? REDACTED : summary;
    await sql`INSERT INTO playbook_run_ledger
        (run_id, leg, seq, action_name, tool, args, outcome, result_summary, returned_ids, \`sensitive\`, duration_ms, created_at)
      VALUES (${runId}, ${leg}, ${seq}, ${actionName}, ${tool}, ${argsJson}, ${outcome}, ${resultSummary}, NULL, ${sensitive ? 1 : 0}, NULL, ${sqlNow()})`.execute(db);
  }

  async ledgerFindOk(runId: number, tool: string, args: any): Promise<Record<string, any> | null> {
    const row = (await sql<any>`SELECT * FROM playbook_run_ledger WHERE run_id = ${runId} AND tool = ${tool} AND outcome = 'ok' AND args = ${this.canon(args)}
      ORDER BY seq DESC`.execute(db)).rows[0];
    return row ?? null;
  }

  async gateOpen(runId: number, leg: number, kind: string, args: any, askedOf: string): Promise<number> {
    const res = await sql`INSERT INTO playbook_run_gates (run_id, leg, kind, args, asked_of, opened_at, closed_at, decision, actor)
      VALUES (${runId}, ${leg}, ${kind}, ${phpJson(args)}, ${askedOf}, ${sqlNow()}, NULL, NULL, NULL)`.execute(db);
    return Number(res.insertId ?? 0);
  }

  async gateClose(gateId: number, decision: any, actor: string): Promise<void> {
    await sql`UPDATE playbook_run_gates SET closed_at = ${sqlNow()}, decision = ${phpJson(decision)}, actor = ${actor} WHERE id = ${gateId}`.execute(db);
  }

  async getRun(runId: number): Promise<Record<string, any>> {
    return (await sql<any>`SELECT * FROM playbook_runs WHERE id = ${runId}`.execute(db)).rows[0] ?? {};
  }

  async ledgerAll(runId: number): Promise<Record<string, any>[]> {
    return (await sql<any>`SELECT * FROM playbook_run_ledger WHERE run_id = ${runId} ORDER BY seq ASC`.execute(db)).rows;
  }

  private canon(a: any): string {
    return phpJson(ksortRecursive(a));
  }
}
