/**
 * In-memory stand-ins for the two databases a corporate install writes (PHP's tests use SQLite):
 *  - GptUsers: the gpt `users` table behind the faked Kysely executor (tests/support/fakeDb), which
 *    answers the statements SetupController, AdminController and AuthController send.
 *  - FakeLoginDb: the login service's `users` table behind a SqlConn (Services/LoginDb), which
 *    answers LoginAccounts' and sso_exchange's statements.
 * An unknown statement throws, so a test notices a query it did not expect.
 */
import bcrypt from 'bcryptjs';
import type { SqlConn } from '../../src/Services/LoginDb';
import type { FakeResult } from './fakeDb';

export type Row = Record<string, any>;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export class GptUsers {
  rows: Row[] = [];
  private nextId = 1;
  /** When set, every INSERT INTO users throws (PHP's forced_insert_failure trigger). */
  failInserts = false;
  /** When set, a query naming `kind` throws (a database not migrated to carry it). */
  noKindColumn = false;
  lockResult: unknown = 1;
  locks = 0;
  unlocks = 0;
  roles = new Set(['guest', 'prospect', 'user', 'admin', 'affiliate', 'robot']);

  add(row: Row): Row {
    const r = { id: row.id ?? this.nextId, kind: 'person', email_verified: 0, password: null, role: null, ...row };
    this.nextId = Math.max(this.nextId, r.id) + 1;
    this.rows.push(r);
    return r;
  }

  byEmail(email: string): Row | undefined {
    return this.rows.find((r) => r.email === email);
  }

  byId(id: unknown): Row | undefined {
    return this.rows.find((r) => r.id === Number(id));
  }

  handler = (sqlText: string, p: readonly unknown[]): FakeResult => {
    const q = norm(sqlText);
    if (this.noKindColumn && /\bkind\b/.test(q)) throw new Error("Unknown column 'kind'");
    if (q.startsWith('SELECT GET_LOCK')) {
      this.locks++;
      return [{ l: this.lockResult }];
    }
    if (q.startsWith('SELECT RELEASE_LOCK')) {
      this.unlocks++;
      return [{ r: 1 }];
    }
    if (q === "SELECT COUNT(*) AS c FROM users WHERE kind = 'person'") {
      return [{ c: this.rows.filter((r) => r.kind === 'person').length }];
    }
    if (q === 'SELECT COUNT(*) AS c FROM users') return [{ c: this.rows.length }];
    if (q === "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'") {
      return [{ c: this.rows.filter((r) => r.role === 'admin').length }];
    }
    if (q === 'SELECT 1 AS one FROM packages WHERE role = ?') return this.roles.has(String(p[0])) ? [{ one: 1 }] : [];
    if (q === 'SELECT role FROM users WHERE id = ? LIMIT 1' || q === 'SELECT role FROM users WHERE id = ?') {
      const r = this.byId(p[0]);
      return r ? [{ role: r.role }] : [];
    }
    if (q === 'SELECT kind FROM users WHERE id = ?') {
      const r = this.byId(p[0]);
      return r ? [{ kind: r.kind }] : [];
    }
    if (q === 'SELECT email FROM users WHERE id = ?') {
      const r = this.byId(p[0]);
      return r ? [{ email: r.email }] : [];
    }
    if (q === 'SELECT id, email, role FROM users WHERE id = ? LIMIT 1') {
      const r = this.byId(p[0]);
      return r ? [{ id: r.id, email: r.email, role: r.role }] : [];
    }
    if (q === 'SELECT id FROM users WHERE email = ?') {
      const r = this.byEmail(String(p[0]));
      return r ? [{ id: r.id }] : [];
    }
    if (q === 'SELECT 1 AS one FROM users WHERE email = ?') return this.byEmail(String(p[0])) ? [{ one: 1 }] : [];
    if (q === 'select * from `users` where `email` = ?') {
      const r = this.byEmail(String(p[0]));
      return r ? [{ ...r }] : [];
    }
    if (q.startsWith("UPDATE users SET role = 'admin', password = NULL, email_verified = 1")) {
      const r = this.byEmail(String(p[0]))!;
      Object.assign(r, { role: 'admin', password: null, email_verified: 1 });
      return { rows: [] };
    }
    if (q.startsWith('INSERT INTO users')) {
      if (this.failInserts) throw new Error('forced failure for rollback test');
      const cols = /INSERT INTO users \(([^)]*)\)/.exec(q)![1].split(',').map((c) => c.trim());
      const vals = /VALUES \((.*)\)$/.exec(q)![1].split(',').map((v) => v.trim());
      const row: Row = {};
      let i = 0;
      cols.forEach((c, k) => {
        const v = vals[k];
        if (v === '?') row[c] = p[i++];
        else if (v === 'NULL') row[c] = null;
        else if (/^'.*'$/.test(v)) row[c] = v.slice(1, -1);
        else if (/^\d+$/.test(v)) row[c] = Number(v);
        else row[c] = v; // NOW() / CURRENT_TIMESTAMP
      });
      if (this.byEmail(row.email)) throw new Error('Duplicate entry for key users.email');
      const added = this.add(row);
      return { rows: [], insertId: added.id };
    }
    if (q.startsWith('UPDATE users SET last_login = NOW() WHERE id = ?')) return { rows: [] };
    if (q.startsWith('UPDATE users SET ')) {
      // AdminController.updateUser: "col = ?" pairs then WHERE id = ?
      const sets = /UPDATE users SET (.*) WHERE id = \?$/.exec(q)![1].split(', ');
      const r = this.byId(p[p.length - 1]);
      let i = 0;
      for (const s of sets) {
        const [col, v] = s.split(' = ');
        if (v === '?') {
          const val = p[i++];
          if (r) r[col] = val;
        }
      }
      return { rows: [] };
    }
    if (q === 'DELETE FROM users WHERE id = ?') {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r.id !== Number(p[0]));
      return { rows: [], numAffectedRows: before - this.rows.length };
    }
    throw new Error('GptUsers: unexpected statement: ' + q);
  };
}

export class FakeLoginDb implements SqlConn {
  rows: Row[] = [];
  statements: string[] = [];
  private nextId = 1;

  add(row: Row): Row {
    const r = { id: this.nextId++, email_verified: 0, password: null, ...row };
    this.rows.push(r);
    return r;
  }

  byEmail(email: string): Row | undefined {
    return this.rows.find((r) => r.email === email);
  }

  verifies(email: string, password: string): boolean {
    const r = this.byEmail(email);
    return !!r && typeof r.password === 'string' && bcrypt.compareSync(password, r.password.replace(/^\$2y\$/, '$2b$'));
  }

  async select(sqlText: string, p: unknown[] = []): Promise<any[]> {
    const q = norm(sqlText);
    this.statements.push(q);
    if (q === 'SELECT id FROM users WHERE email = ?') {
      const r = this.byEmail(String(p[0]));
      return r ? [{ id: r.id }] : [];
    }
    if (q === 'SELECT 1 FROM users WHERE email = ?') return this.byEmail(String(p[0])) ? [{ 1: 1 }] : [];
    if (q === 'SELECT email, email_verified FROM users WHERE id = ?') {
      const r = this.rows.find((x) => x.id === Number(p[0]));
      return r ? [{ email: r.email, email_verified: r.email_verified }] : [];
    }
    throw new Error('FakeLoginDb: unexpected select: ' + q);
  }

  async execute(sqlText: string, p: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
    const q = norm(sqlText);
    this.statements.push(q);
    if (q.startsWith('UPDATE users SET password = ?, first_name = ?, last_name = ?, email_verified = 1')) {
      const r = this.byEmail(String(p[3]))!;
      Object.assign(r, { password: p[0], first_name: p[1], last_name: p[2], email_verified: 1 });
      return { insertId: 0, affectedRows: 1 };
    }
    if (q.startsWith('INSERT INTO users (email, password, first_name, last_name, provider, email_verified')) {
      if (this.byEmail(String(p[0]))) throw new Error('Duplicate entry');
      const r = this.add({ email: p[0], password: p[1], first_name: p[2], last_name: p[3], provider: 'email', email_verified: 1 });
      return { insertId: r.id, affectedRows: 1 };
    }
    if (q.startsWith('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?')) {
      const r = this.byEmail(String(p[1]));
      if (r) r.password = p[0];
      return { insertId: 0, affectedRows: r ? 1 : 0 };
    }
    if (q === 'DELETE FROM users WHERE email = ?') {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r.email !== String(p[0]));
      return { insertId: 0, affectedRows: before - this.rows.length };
    }
    throw new Error('FakeLoginDb: unexpected execute: ' + q);
  }

  async transaction<T>(fn: (conn: SqlConn) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
