import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/RequiresAdmin.php: null when the caller is an admin, else the error to return.
 * The role is re-read from the database on every request (a demoted or deleted admin loses access at once);
 * a database failure never reads as "permission granted".
 */
export async function requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
  const userId = ctx.user_id ?? null;
  if (!userId) return { success: false, error: 'Authentication required', status_code: 401 };
  let row: { role: string | null } | undefined;
  try {
    row = (await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)).rows[0];
  } catch (e: any) {
    console.error('[RequiresAdmin] role lookup failed: ' + (e?.message ?? e));
    return { success: false, error: 'Admin access required', status_code: 403 };
  }
  if (!row || (row.role ?? '') !== 'admin') return { success: false, error: 'Admin access required', status_code: 403 };
  return null;
}
