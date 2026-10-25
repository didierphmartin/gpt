/**
 * A test-only stand-in for MySQL: the shared Kysely instance's executor is patched so every query
 * goes to `handler` (as tests/AdminAuthorization.test.ts does). No connection is ever opened.
 *
 * The handler gets the compiled SQL and its parameters and returns the rows (an array), or a full
 * result ({ rows, insertId }) for an INSERT. Every query is also recorded in `queries`.
 */
for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
  process.env[k] ||= 'x';
}

export type FakeQuery = { sql: string; parameters: readonly unknown[] };
export type FakeResult = any[] | { rows?: any[]; insertId?: number } | undefined | void;
export type FakeHandler = (sql: string, parameters: readonly unknown[]) => FakeResult;

export const queries: FakeQuery[] = [];
let current: FakeHandler = () => [];
let installed = false;

/** Patch the executor once per process; later calls only swap the handler (and clear `queries`). */
export function installFakeDb(handler: FakeHandler = () => []): void {
  current = handler;
  queries.length = 0;
  if (installed) return;
  installed = true;
  const pools: typeof import('../../src/db/pools') = require('../../src/db/pools');
  const executor: any = pools.db.getExecutor();
  executor.executeQuery = async (compiled: FakeQuery) => {
    queries.push({ sql: compiled.sql, parameters: compiled.parameters });
    const out = current(compiled.sql, compiled.parameters);
    if (Array.isArray(out)) return { rows: out };
    if (out && typeof out === 'object') {
      return { rows: out.rows ?? [], insertId: out.insertId !== undefined ? BigInt(out.insertId) : undefined };
    }
    return { rows: [] };
  };
}
