import bcrypt from 'bcryptjs';
import { Kysely, sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { Edition, EditionConfig } from '../Services/Edition';
import { LoginAccounts } from '../Services/LoginAccounts';
import { phpTrim, phpValidEmail } from '../Support/PhpEmail';

type SetupConfig = EditionConfig & { loginDb?: typeof config.loginDb };

/**
 * Mirrors src/Controllers/SetupController.php. First-run setup of a corporate install: creates the
 * administrator, once.
 *
 * Both endpoints are public — before setup there is nobody to authenticate. createAdmin is safe to
 * expose because it refuses as soon as any gpt person exists (any role — "no admin" is not enough,
 * or removing the last admin would reopen setup to anyone), and it re-checks under a MySQL named
 * lock so two simultaneous submissions cannot both pass the check.
 *
 * GET_LOCK/RELEASE_LOCK belong to one MySQL session, and the Kysely pool hands out a different
 * connection per query, so the locked section runs on one pinned connection (pinned()); PHP's PDO
 * is a single connection already.
 */
export class SetupController {
  private static readonly MIN_PASSWORD = 10;

  private accountsInjected: boolean;

  /** Pass `accounts` (even null) to inject it; leave it out to open the configured login DB. */
  constructor(
    private readonly cfg: SetupConfig = config,
    private accounts?: LoginAccounts | null,
  ) {
    this.accountsInjected = arguments.length >= 2;
  }

  async status(_ctx: Ctx): Promise<ControllerResult> {
    return {
      success: true,
      edition: Edition.current(this.cfg),
      needs_setup: await this.needsSetup(db),
    };
  }

  async createAdmin(ctx: Ctx): Promise<ControllerResult> {
    if (!Edition.isCorporate(this.cfg)) {
      return this.fail('Setup is only available in the corporate edition', 404);
    }

    const body = ctx.body ?? {};
    const email = phpTrim(String(body.email ?? '')).toLowerCase();
    const password = String(body.password ?? '');
    const firstName = phpTrim(String(body.first_name ?? ''));
    const lastName = phpTrim(String(body.last_name ?? ''));

    if (!phpValidEmail(email)) {
      return this.fail('Enter a valid email address', 400);
    }
    if (Buffer.byteLength(password, 'utf8') < SetupController.MIN_PASSWORD) {
      return this.fail(`The password must be at least ${SetupController.MIN_PASSWORD} characters`, 400);
    }

    let accounts: LoginAccounts | null;
    try {
      accounts = await this.loginAccounts();
    } catch {
      return this.fail('The login service database is not reachable', 503);
    }
    if (accounts === null) {
      return this.fail('The login service is not configured', 503);
    }

    return this.pinned(async (conn) => {
      if (!(await this.lock(conn))) {
        return this.fail('Setup is busy, please try again', 503);
      }
      try {
        if (!(await this.needsSetup(conn))) {
          return this.fail('Setup is already complete', 409);
        }
        await accounts!.upsertVerified(email, bcrypt.hashSync(password, 10), firstName, lastName);
        await this.upsertGptAdmin(conn, email, firstName, lastName);
      } catch (e: any) {
        console.error('[setup] createAdmin failed: ' + (e?.message ?? e));
        return this.fail('Could not create the administrator account', 500);
      } finally {
        await this.unlock(conn);
      }

      return {
        success: true,
        message: 'Administrator account created',
        email,
        status_code: 201,
      };
    });
  }

  private async needsSetup(conn: Kysely<any>): Promise<boolean> {
    if (!Edition.isCorporate(this.cfg)) return false;
    try {
      // People only: the robot service user exists from the first boot.
      const r = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM users WHERE kind = 'person'`.execute(conn);
      return Number(r.rows[0]?.c ?? 0) === 0;
    } catch {
      // A database that has not been migrated to carry `kind` yet.
      const r = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM users`.execute(conn);
      return Number(r.rows[0]?.c ?? 0) === 0;
    }
  }

  private async loginAccounts(): Promise<LoginAccounts | null> {
    if (!this.accountsInjected) {
      this.accounts = await LoginAccounts.fromConfig(this.cfg);
      this.accountsInjected = true;
    }
    return this.accounts ?? null;
  }

  /** gpt holds the role, never a password: the login service is the credential store. */
  private async upsertGptAdmin(conn: Kysely<any>, email: string, firstName: string, lastName: string): Promise<void> {
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`.execute(conn);
    if (existing.rows.length > 0) {
      await sql`UPDATE users SET role = 'admin', password = NULL, email_verified = 1,
                updated_at = CURRENT_TIMESTAMP WHERE email = ${email}`.execute(conn);
      return;
    }
    await sql`INSERT INTO users (email, password, first_name, last_name, role, plan, provider,
            email_verified, created_at, updated_at)
            VALUES (${email}, NULL, ${firstName}, ${lastName}, 'admin', 'free', 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`.execute(conn);
  }

  /** Runs fn on one connection, so the named lock and the work share a MySQL session. */
  protected async pinned<T>(fn: (conn: Kysely<any>) => Promise<T>): Promise<T> {
    return (db as Kysely<any>).connection().execute(fn);
  }

  /** True when the lock is held. GET_LOCK returns 1 on success, 0 on timeout, NULL on error. */
  protected async lock(conn: Kysely<any>): Promise<boolean> {
    const r = await sql<{ l: unknown }>`SELECT GET_LOCK('gpt_corporate_setup', 10) AS l`.execute(conn);
    const v = r.rows[0]?.l;
    return v !== null && v !== undefined && String(v) === '1';
  }

  protected async unlock(conn: Kysely<any>): Promise<void> {
    await sql`SELECT RELEASE_LOCK('gpt_corporate_setup')`.execute(conn);
  }

  private fail(message: string, status: number): ControllerResult {
    return { success: false, message, status_code: status };
  }
}
