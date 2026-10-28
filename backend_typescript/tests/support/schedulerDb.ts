/**
 * The scheduler / event-worker tests' database: an in-memory SQLite behind the fake Kysely executor, with
 * NOW() from the test's clock (PHP: sqliteCreateFunction('NOW', ...)), affected-row counts (claim is
 * atomic on them) and db.transaction() as BEGIN/COMMIT/ROLLBACK. Twin of
 * backend/tests/Unit/EventWorker/EventWorkerSchema.php. No MySQL, no network.
 */
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb, FakeHandler } from './fakeDb';

export type SchedDb = DatabaseSync;

let current: DatabaseSync | null = null;
let patchedTx = false;

/** The executor handler that runs every query on d (exported so a test can wrap it). */
export function handlerFor(d: DatabaseSync): FakeHandler {
  const bind = (ps: readonly unknown[]) => ps.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
  return (sqlText, params) => {
    const st = d.prepare(sqlText);
    if (/^\s*(select|with)\b/i.test(sqlText)) return (st.all(...bind(params)) as any[]).map((r) => ({ ...r }));
    const r = st.run(...bind(params));
    return { rows: [], insertId: Number(r.lastInsertRowid), numAffectedRows: Number(r.changes) } as any;
  };
}

export function installSchedulerDb(now: () => string): SchedDb {
  const d = new DatabaseSync(':memory:');
  d.function('NOW', () => now());
  d.exec('PRAGMA foreign_keys = ON');
  installFakeDb(handlerFor(d));
  current = d;
  if (!patchedTx) {
    patchedTx = true;
    const pools: typeof import('../../src/db/pools') = require('../../src/db/pools');
    (pools.db as any).transaction = () => ({
      execute: async (cb: (trx: any) => Promise<any>) => {
        current!.exec('BEGIN');
        try {
          const out = await cb(pools.db);
          current!.exec('COMMIT');
          return out;
        } catch (e) {
          current!.exec('ROLLBACK');
          throw e;
        }
      },
    });
  }
  return d;
}

export const SCHEDULES_DDL = `CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,
  input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending', repeat_type TEXT DEFAULT 'none',
  repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT, trigger_component_id INTEGER,
  last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)`;

/** EventWorkerSchema::create. */
export function eventWorkerSchema(d: DatabaseSync): void {
  d.exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, enabled INTEGER DEFAULT 1)');
  d.exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, config TEXT)');
  d.exec(`CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,
    to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1')`);
  d.exec('CREATE TABLE code_components (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, start_trigger TEXT, args TEXT, provides TEXT)');
  d.exec(`CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, url TEXT,
    headers TEXT, enabled INTEGER DEFAULT 1)`);
  d.exec(SCHEDULES_DDL);
  d.exec(`CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL
    REFERENCES agent_workflows (id) ON DELETE CASCADE, mode TEXT NOT NULL, trigger_component_id INTEGER,
    activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting', watch_message TEXT, watch_checked_at TEXT)`);
}

export const WATCH = { server: 'Outlook', tool: 'wait_for_new', args: { args: { folder: 'Inbox' } } };

/** Workflow id of user: Start (on option, or plain) linked to an Output unless linked is false. */
export function workflow(d: DatabaseSync, id: number, user: number, option: number | null, linked = true): void {
  d.prepare('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)').run(id, user, `wf ${id}`);
  const cfg = JSON.stringify({ type: 'start', ...(option ? { start_option: option } : {}) });
  const start = Number(d.prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'start', ?)").run(id, cfg).lastInsertRowid);
  const out = Number(d.prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'output', '{}')").run(id).lastInsertRowid);
  if (linked) d.prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)').run(id, start, out);
}

export function option(d: DatabaseSync, id: number, user: number): void {
  d.prepare('INSERT INTO code_components (id, user_id, name, start_trigger) VALUES (?, ?, ?, ?)')
    .run(id, user, `c ${id}`, JSON.stringify({ label: 'New email', watch: WATCH, work_exit: 'new_mail' }));
}

/** A saved schedule row; returns its id. */
export function row(d: DatabaseSync, wf: number, user: number, type: string, component: number | null = null, status = 'pending'): number {
  return Number(d.prepare(`INSERT INTO scheduled_workflows (user_id, workflow_id, status, repeat_type, event_trigger, trigger_component_id, next_run)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(user, wf, status, type, type === 'event' ? JSON.stringify(WATCH) : null, component,
    type === 'event' ? null : '2026-10-15 09:00:00').lastInsertRowid);
}

/** 'Y-m-d H:i:s' of a local Date; at(s) the reverse. */
export const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const at = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)!;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
};
