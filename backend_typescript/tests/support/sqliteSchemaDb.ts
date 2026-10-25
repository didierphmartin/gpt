/**
 * The PHP unit tests for SQL-heavy stores run on an in-memory SQLite PDO. This is their twin: the shared Kysely
 * instance's executor (tests/support/fakeDb) runs every compiled query on node:sqlite's in-memory database, and
 * db.transaction() becomes BEGIN / COMMIT / ROLLBACK on it. No MySQL, no network.
 *
 * Only for code whose raw SQL is portable (MySQL and SQLite), as the PHP stores tested this way are.
 */
import { installFakeDb, queries } from './fakeDb';
// node:sqlite is experimental in Node 22 (a warning, no flag); required lazily so the warning comes once.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

export type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: any[]): any[]; get(...p: any[]): any; run(...p: any[]): { lastInsertRowid: number | bigint; changes: number } };
};

export { queries };

let patchedTx = false;
let current: Sqlite | null = null;

/** A fresh in-memory database behind the shared Kysely instance; `schema` is run first. */
export function installSqliteDb(schema: string): Sqlite {
  const sqlite: Sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const bind = (ps: readonly unknown[]) => ps.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  installFakeDb((sqlText, parameters) => {
    const st = sqlite.prepare(sqlText);
    if (/^\s*(SELECT|WITH)\b/i.test(sqlText)) {
      return st.all(...bind(parameters)).map((r: any) => ({ ...r }));
    }
    const res = st.run(...bind(parameters));
    return /^\s*INSERT\b/i.test(sqlText) ? { rows: [], insertId: Number(res.lastInsertRowid) } : [];
  });
  current = sqlite;
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
  return sqlite;
}
