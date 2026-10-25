/**
 * An in-memory SQLite database behind the fake Kysely executor (tests/support/fakeDb), for stores whose PHP tests run
 * against `sqlite::memory:`. The compiled MySQL SQL (`?` placeholders, backticked identifiers) runs as is on SQLite.
 * No MySQL, no network.
 */
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './fakeDb';

export type SqliteDb = DatabaseSync & { gone: boolean };

/** A fresh database; while `gone` is true every query fails like a MySQL connection the server dropped (2006). */
export function installSqliteDb(): SqliteDb {
  const d = new DatabaseSync(':memory:') as SqliteDb;
  d.gone = false;
  installFakeDb((sqlText, params) => {
    if (d.gone) throw new Error('SQLSTATE[HY000]: General error: 2006 MySQL server has gone away');
    const st = d.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) return st.all(...ps) as any[];
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid) };
  });
  return d;
}
