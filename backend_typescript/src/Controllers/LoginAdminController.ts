import { sql } from 'kysely';
import { db } from '../db/pools';
import { config, DbConfig } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { Edition, EditionConfig } from '../Services/Edition';
import { SqlConn, connectSql } from '../Services/LoginDb';
import { phpTrim, phpValidEmail } from '../Support/PhpEmail';

type LoginAdminConfig = EditionConfig & { loginDatabase?: DbConfig };

const NOT_REACHABLE_HINT = 'Login DB not reachable — set the LOGIN_DB_* environment variables';

/** PHP (int) cast. */
function intVal(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const n = parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP is_numeric() for a request value. */
function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}

/** PHP truthiness of a body value. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function isDuplicate(e: any): boolean {
  const msg = String(e?.message ?? '');
  return msg.includes('Duplicate') || msg.includes('1062') || e?.errno === 1062;
}

/**
 * Mirrors src/Controllers/LoginAdminController.php — the gpt_admin "Login" card over the shared
 * login DB (netfo587_login). Reads + non-secret edits run here directly (the backend holds the
 * login-DB credentials). Admin-gated; an admin cannot delete their OWN login account (matched by
 * email against the gpt admin identity). On a corporate install the write routes refuse before
 * any database access: AdminController (the Users screen) is the only writer there.
 *
 * Statements are PHP's with `?` placeholders (PHP binds named ones). PHP keeps one PDO per
 * request in a static; here the login pool is probed per request (Services/LoginDb).
 */
export class LoginAdminController {
  private static readonly ROLES = ['guest', 'prospect', 'user', 'admin', 'affiliate'];
  private static readonly PROVIDERS = ['email', 'google', 'facebook', 'phone'];

  constructor(private readonly cfg: LoginAdminConfig = config) {}

  /** The authenticated caller's row IF they are an admin, else null. */
  private async adminRow(ctx: Ctx): Promise<{ id: number; email: string; role: string } | null> {
    const userId = ctx.user_id ?? null;
    if (!userId) return null;
    const r = (await sql<any>`SELECT id, email, role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)).rows[0];
    return r && (r.role ?? '') === 'admin' ? r : null;
  }

  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    if (!(await this.adminRow(ctx))) {
      return { success: false, error: 'Admin access required', status_code: 403 };
    }
    return null;
  }

  /**
   * On a corporate install AdminController (the Users screen) is the only writer of the login
   * database: it keeps each login row in step with its gpt row. Checked before any database access.
   */
  private refuseWriteOnCorporate(): ControllerResult | null {
    if (!Edition.isCorporate(this.cfg)) return null;
    return { success: false, error: 'Manage accounts from the Users screen on this installation', status_code: 403 };
  }

  /** The login DB, or null if unconfigured/unreachable (overridable seam for tests). */
  protected async login(): Promise<SqlConn | null> {
    const c = this.cfg.loginDatabase;
    if (!c || !c.user || !c.database) return null;
    try {
      return await connectSql(c);
    } catch (e: any) {
      console.error('[login-admin] DB connect failed: ' + (e?.message ?? e));
      return null;
    }
  }

  private async loginUserById(l: SqlConn, id: number): Promise<{ id: number; email: string } | null> {
    return (await l.select('SELECT id, email FROM users WHERE id = ? LIMIT 1', [id]))[0] ?? null;
  }

  /** GET /api/v1/admin/login/stats — Overview counts. */
  async getStats(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, available: false, message: NOT_REACHABLE_HINT };
    try {
      const count = async (q: string) => intVal(Object.values((await l.select(q))[0] ?? {})[0]);
      const stats = {
        total_users: await count('SELECT COUNT(*) FROM users'),
        by_provider: await l.select('SELECT provider, COUNT(*) c FROM users GROUP BY provider'),
        verified: await count('SELECT COUNT(*) FROM users WHERE email_verified = 1'),
        apps: (await l.select('SELECT COUNT(*) total, COALESCE(SUM(revoked_at IS NULL),0) active FROM registered_apps'))[0] ?? false,
        passkeys: await count('SELECT COUNT(*) FROM webauthn_credentials'),
        signups_7d: await count('SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'),
        logins_7d: await count('SELECT COUNT(*) FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY)'),
      };
      return { success: true, available: true, stats };
    } catch {
      return { success: false, available: false, message: 'Stats query failed' };
    }
  }

  /** GET /api/v1/admin/login/users?q&role&provider — user list. */
  async getUsers(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, available: false, users: [], message: NOT_REACHABLE_HINT };
    const q = phpTrim(String(ctx.query?.q ?? ''));
    const provider = String(ctx.query?.provider ?? '');
    const where: string[] = [];
    const p: unknown[] = [];
    if (q !== '') {
      where.push('(email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)');
      p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (LoginAdminController.PROVIDERS.includes(provider)) {
      where.push('provider = ?');
      p.push(provider);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    try {
      // Accounts are auth-only now — no role column (roles are per-app in app_user_roles).
      const rows = await l.select(
        `SELECT id, email, phone, first_name, last_name, provider,
                profile_picture, email_verified, last_login, created_at
                FROM users ${w} ORDER BY id DESC LIMIT 200`,
        p,
      );
      for (const r of rows) {
        r.email_verified = intVal(r.email_verified);
        const name = phpTrim(`${r.first_name ?? ''} ${r.last_name ?? ''}`);
        r.name = name !== '' ? name : r.email ?? '';
      }
      return { success: true, available: true, users: rows };
    } catch {
      return { success: false, available: false, users: [], message: 'User query failed' };
    }
  }

  /** POST /api/v1/admin/login/users — create a user (no password; provider=email). */
  async createUser(ctx: Ctx): Promise<ControllerResult> {
    const refused = this.refuseWriteOnCorporate();
    if (refused) return refused;
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, message: 'Login DB not reachable' };
    const b = ctx.body ?? {};
    const email = phpTrim(String(b.email ?? ''));
    if (!phpValidEmail(email)) return { success: false, message: 'A valid email is required' };
    try {
      // Account only (auth). Per-app roles are assigned separately (app_user_roles).
      const r = await l.execute(
        "INSERT INTO users (email, first_name, last_name, provider, email_verified) VALUES (?, ?, ?, 'email', 0)",
        [email, String(b.first_name ?? ''), String(b.last_name ?? '')],
      );
      return { success: true, id: r.insertId };
    } catch (e) {
      return { success: false, message: isDuplicate(e) ? 'That email already exists' : 'Create failed' };
    }
  }

  /** POST /api/v1/admin/login/users/update — edit account fields (profile / verification). Roles are per-app. */
  async updateUser(ctx: Ctx): Promise<ControllerResult> {
    const refused = this.refuseWriteOnCorporate();
    if (refused) return refused;
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, message: 'Login DB not reachable' };
    const b = ctx.body ?? {};
    const id = intVal(b.id ?? 0);
    if (id <= 0) return { success: false, message: 'id is required' };
    const target = await this.loginUserById(l, id);
    if (!target) return { success: false, message: 'User not found' };

    const fields: string[] = [];
    const p: unknown[] = [];
    for (const f of ['first_name', 'last_name', 'phone', 'profile_picture']) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        fields.push(`${f} = ?`);
        p.push(String(b[f] ?? ''));
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'email_verified')) {
      fields.push('email_verified = ?');
      p.push(truthy(b.email_verified) ? 1 : 0);
    }
    if (!fields.length) return { success: true };
    try {
      await l.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...p, id]);
      return { success: true };
    } catch {
      return { success: false, message: 'Update failed' };
    }
  }

  /** POST /api/v1/admin/login/users/delete — delete a user + their passkeys. An admin cannot delete their own account. */
  async deleteUser(ctx: Ctx): Promise<ControllerResult> {
    const refused = this.refuseWriteOnCorporate();
    if (refused) return refused;
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, message: 'Login DB not reachable' };
    const id = intVal((ctx.body ?? {}).id ?? 0);
    if (id <= 0) return { success: false, message: 'id is required' };
    const target = await this.loginUserById(l, id);
    if (!target) return { success: false, message: 'User not found' };
    const admin = await this.adminRow(ctx);
    if (admin && String(admin.email ?? '').toLowerCase() === String(target.email ?? '').toLowerCase()) {
      return { success: false, message: "You can't delete your own account." };
    }
    try {
      await l.transaction(async (t) => {
        await t.execute('DELETE FROM webauthn_credentials WHERE user_id = ?', [id]);
        try {
          await t.execute('DELETE FROM app_user_roles WHERE user_id = ?', [id]);
        } catch {
          /* table may not exist */
        }
        await t.execute('DELETE FROM users WHERE id = ?', [id]);
      });
      return { success: true };
    } catch {
      return { success: false, message: 'Delete failed' };
    }
  }

  // ---------- Applications (app-centric role management) ----------

  private async appIdBySlug(l: SqlConn, slug: string): Promise<number | null> {
    const r = (await l.select('SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1', [slug]))[0];
    return r ? intVal(r.id) : null;
  }

  /** GET /api/v1/admin/login/apps — registered applications + their user counts. */
  async getApps(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, available: false, apps: [], message: NOT_REACHABLE_HINT };
    try {
      const rows = await l.select(
        `SELECT id, app_id, name, key_prefix, entry_point, created_at, last_used_at, revoked_at
                               FROM registered_apps ORDER BY name`,
      );
      const counts = new Map<number, number>();
      for (const rr of await l.select('SELECT app_id, COUNT(*) c FROM app_user_roles GROUP BY app_id')) {
        counts.set(intVal(rr.app_id), intVal(rr.c));
      }
      for (const r of rows) {
        r.users = counts.get(intVal(r.id)) ?? 0;
        r.revoked = r.revoked_at !== null && r.revoked_at !== undefined;
      }
      return { success: true, available: true, apps: rows };
    } catch {
      return { success: false, available: false, apps: [], message: 'Apps query failed' };
    }
  }

  /** GET /api/v1/admin/login/app-users?app=<slug>&q= — users + their role for one app. */
  async getAppUsers(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, available: false, users: [], message: NOT_REACHABLE_HINT };
    const slug = String(ctx.query?.app ?? '');
    const appId = await this.appIdBySlug(l, slug);
    if (appId === null) return { success: false, message: 'Unknown application' };
    try {
      // MEMBERS of this app = users who have a role for it (in its context).
      const rows = await l.select(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.provider,
                                     u.email_verified, u.last_login, r.role
                              FROM app_user_roles r JOIN users u ON u.id = r.user_id
                              WHERE r.app_id = ? ORDER BY u.id DESC`,
        [appId],
      );
      const users = rows.map((r) => {
        const name = phpTrim(`${r.first_name ?? ''} ${r.last_name ?? ''}`);
        const { first_name: _f, last_name: _l, ...rest } = r;
        return { ...rest, name: name !== '' ? name : r.email ?? '', email_verified: intVal(r.email_verified) };
      });
      return { success: true, available: true, app: slug, users };
    } catch {
      return { success: false, available: false, users: [], message: 'User query failed' };
    }
  }

  /** POST /api/v1/admin/login/app-users/role — set/clear a user's role for one app. Empty/"none" role revokes access. */
  async setAppUserRole(ctx: Ctx): Promise<ControllerResult> {
    const refused = this.refuseWriteOnCorporate();
    if (refused) return refused;
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, message: 'Login DB not reachable' };
    const b = ctx.body ?? {};
    const slug = String(b.app ?? '');
    const uid = intVal(b.user_id ?? 0);
    const role = String(b.role ?? '');
    const appId = await this.appIdBySlug(l, slug);
    if (appId === null) return { success: false, message: 'Unknown application' };
    if (uid <= 0) return { success: false, message: 'user_id is required' };
    const adminId = isNumeric(ctx.user_id) ? intVal(ctx.user_id) : null;
    try {
      if (role === '' || role === 'none') {
        await l.execute('DELETE FROM app_user_roles WHERE user_id = ? AND app_id = ?', [uid, appId]);
      } else {
        if (!LoginAdminController.ROLES.includes(role)) return { success: false, message: 'invalid role' };
        await l.execute(
          `INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)`,
          [uid, appId, role, adminId],
        );
      }
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /**
   * POST /api/v1/admin/login/app-users/add — add a member to an app, creating the account first if
   * the email is new. Writes both `users` (auth-only, no password) and `app_user_roles`.
   * Body: { app, email, first_name?, last_name?, role }.
   */
  async addAppMember(ctx: Ctx): Promise<ControllerResult> {
    const refused = this.refuseWriteOnCorporate();
    if (refused) return refused;
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const l = await this.login();
    if (!l) return { success: false, message: 'Login DB not reachable' };
    const b = ctx.body ?? {};
    const slug = String(b.app ?? '');
    const email = phpTrim(String(b.email ?? ''));
    const role = String(b.role ?? '');
    if (!phpValidEmail(email)) return { success: false, message: 'A valid email is required' };
    if (!LoginAdminController.ROLES.includes(role)) return { success: false, message: 'A valid role is required' };
    const appId = await this.appIdBySlug(l, slug);
    if (appId === null) return { success: false, message: 'Unknown application' };
    const adminId = isNumeric(ctx.user_id) ? intVal(ctx.user_id) : null;
    try {
      return await l.transaction(async (t) => {
        // 1) Find the user by email; create the account if it doesn't exist yet.
        const found = (await t.select('SELECT id FROM users WHERE email = ? LIMIT 1', [email]))[0];
        let uid: number;
        let created = false;
        if (!found) {
          const ins = await t.execute(
            "INSERT INTO users (email, first_name, last_name, provider, email_verified) VALUES (?, ?, ?, 'email', 0)",
            [email, String(b.first_name ?? ''), String(b.last_name ?? '')],
          );
          uid = ins.insertId;
          created = true;
        } else {
          uid = intVal(found.id);
        }
        // 2) Link the user to the application with the role.
        await t.execute(
          `INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                               VALUES (?, ?, ?, ?)
                               ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)`,
          [uid, appId, role, adminId],
        );
        return { success: true, created, user_id: uid };
      });
    } catch (e) {
      return { success: false, message: isDuplicate(e) ? 'That email already exists' : 'Add failed' };
    }
  }
}
