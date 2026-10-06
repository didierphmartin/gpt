import { sql } from 'kysely';
import { db } from '../db/pools';

/** True for the robot's service row (never a person: no token, no app key). A row without `kind` is a person. */
export function isServiceUser(row: { kind?: any } | null | undefined): boolean {
  return (row?.kind ?? 'person') === 'service';
}

/**
 * Mirrors src/Services/RobotAccount.php. The one robot service user of an installation (it owns
 * published playbooks and runs unattended work) and its built-in `robot` role. Never signs in: no password.
 */
export class RobotAccount {
  static readonly EMAIL = 'robot@synergyai.invalid';
  static readonly NAME = 'SynergyAI Operations';
  static readonly ROLE = 'robot';

  /** The robot's user id, creating its role row and the user when missing. */
  static async ensure(): Promise<number> {
    const existing = await RobotAccount.id();
    if (existing !== null) return existing;
    await RobotAccount.ensureRole();
    const sp = RobotAccount.NAME.indexOf(' ');
    const first = RobotAccount.NAME.slice(0, sp);
    const last = RobotAccount.NAME.slice(sp + 1);
    const res = await sql`INSERT INTO users (email, first_name, last_name, password, provider, role, kind, email_verified)
      VALUES (${RobotAccount.EMAIL}, ${first}, ${last}, NULL, 'email', ${RobotAccount.ROLE}, 'service', 1)`.execute(db);
    return Number(res.insertId);
  }

  /** The robot's user id, or null when it does not exist yet. */
  static async id(): Promise<number | null> {
    const row = (await sql<any>`SELECT id FROM users WHERE kind = 'service' ORDER BY id LIMIT 1`.execute(db)).rows[0];
    return row ? Number(row.id) : null;
  }

  private static async ensureRole(): Promise<void> {
    const has = (await sql<any>`SELECT 1 AS one FROM packages WHERE role = ${RobotAccount.ROLE}`.execute(db)).rows.length > 0;
    if (has) return;
    const user = (await sql<any>`SELECT capabilities FROM packages WHERE role = ${'user'}`.execute(db)).rows[0];
    // mysql2 returns the `json` column parsed: encode it back for the copy.
    const copy = user === undefined ? '{}' : typeof user.capabilities === 'string' ? user.capabilities : JSON.stringify(user.capabilities);
    await sql`INSERT INTO packages (role, name, builtin, capabilities) VALUES (${RobotAccount.ROLE}, ${'Robot'}, 1, ${copy})`.execute(db);
  }
}
