import { createPool, Pool, PoolConnection } from 'mysql2/promise';
import { DbConfig } from '../config/env';

/**
 * A raw-SQL connection to the login service's database (PHP: a PDO opened on config['login_db'] or
 * config['login_database']). The login schema is not gpt's, so it gets no Kysely types; the
 * statements are PHP's, with `?` placeholders.
 */
export interface SqlConn {
  /** Rows of a SELECT. */
  select(sql: string, params?: unknown[]): Promise<any[]>;
  /** An INSERT/UPDATE/DELETE: the new id (0 when none) and the affected row count. */
  execute(sql: string, params?: unknown[]): Promise<{ insertId: number; affectedRows: number }>;
  /** Runs fn on one connection inside BEGIN/COMMIT; any throw rolls back and is rethrown. */
  transaction<T>(fn: (conn: SqlConn) => Promise<T>): Promise<T>;
}

const pools = new Map<string, Pool>();

function poolFor(c: DbConfig): Pool {
  const key = [c.host, c.port, c.database, c.user].join('|');
  let pool = pools.get(key);
  if (!pool) {
    pool = createPool({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      connectTimeout: 5000, // PDO::ATTR_TIMEOUT => 5
      waitForConnections: true,
      connectionLimit: 5,
    });
    pools.set(key, pool);
  }
  return pool;
}

class OneConnection implements SqlConn {
  constructor(private readonly c: PoolConnection) {}

  async select(sql: string, params: unknown[] = []): Promise<any[]> {
    const [rows] = await this.c.query(sql, params as any[]);
    return rows as any[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
    const [r] = await this.c.query(sql, params as any[]);
    return { insertId: Number((r as any).insertId ?? 0), affectedRows: Number((r as any).affectedRows ?? 0) };
  }

  async transaction<T>(fn: (conn: SqlConn) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class PooledConn implements SqlConn {
  constructor(private readonly pool: Pool) {}

  async select(sql: string, params: unknown[] = []): Promise<any[]> {
    const [rows] = await this.pool.query(sql, params as any[]);
    return rows as any[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
    const [r] = await this.pool.query(sql, params as any[]);
    return { insertId: Number((r as any).insertId ?? 0), affectedRows: Number((r as any).affectedRows ?? 0) };
  }

  async transaction<T>(fn: (conn: SqlConn) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      try {
        const out = await fn(new OneConnection(c));
        await c.commit();
        return out;
      } catch (e) {
        await c.rollback().catch(() => undefined);
        throw e;
      }
    } finally {
      c.release();
    }
  }
}

/**
 * A connection to `c`, checked reachable (PHP's `new PDO(...)` throws when it cannot connect;
 * this throws the same way, so callers keep PHP's "not reachable" answers).
 */
export async function connectSql(c: DbConfig): Promise<SqlConn> {
  const pool = poolFor(c);
  const probe = await pool.getConnection();
  probe.release();
  return new PooledConn(pool);
}
