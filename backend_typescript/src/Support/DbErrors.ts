/**
 * PHP's `$e->getCode() === '23000'` (integrity constraint violation, e.g. a duplicate key): MySQL's ER_DUP_ENTRY
 * (SQLSTATE 23000, errno 1062), or SQLite's "UNIQUE constraint failed" in the tests' in-memory database.
 */
export function isDuplicateKey(e: any): boolean {
  return e?.code === 'ER_DUP_ENTRY' || e?.sqlState === '23000' || e?.errno === 1062 || /UNIQUE constraint failed/.test(String(e?.message ?? ''));
}
