import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { PackageResolver, ResolvedPackage } from '../Services/PackageResolver';
import { Role, RoleStore } from '../Services/RoleStore';

/**
 * Mirrors src/Controllers/PackageController.php — `me` + the admin CRUD (adminList/adminGet/adminUpdate).
 *
 * PHP instantiates the controller (and its PackageResolver) per request, so the resolver's per-role
 * cache never survives a request. This controller is a singleton (created once in routes.ts), so we
 * create a FRESH PackageResolver per action instead of holding one on `this` — otherwise a package
 * edited via adminUpdate would read back stale from cache until a server restart.
 */
export class PackageController {
  /** GET /api/v1/me/package */
  async me(ctx: Ctx): Promise<ControllerResult> {
    const userIdInt = /^\d+$/.test(String(ctx.user_id)) ? Number(ctx.user_id) : null;
    const pkg = await new PackageResolver().resolveForUser(userIdInt);
    return { success: true, role: pkg.role, capabilities: pkg.capabilities, updated_at: pkg.updated_at };
  }

  /** GET /api/v1/admin/packages — every package (admin only), each with its role's name and builtin flag. */
  async adminList(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const resolver = new PackageResolver();
    const packages = [];
    for (const row of await new RoleStore().list()) {
      packages.push(this.withRoleInfo(await resolver.loadPackage(row.role), row));
    }
    return { success: true, packages };
  }

  /** GET /api/v1/admin/packages/:role — a single package (admin only). */
  async adminGet(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const role = String(ctx.params.role ?? '');
    const row = await new RoleStore().get(role);
    if (row === null) {
      return { success: false, error: 'Invalid role', status_code: 400 };
    }
    return { success: true, package: this.withRoleInfo(await new PackageResolver().loadPackage(role), row) };
  }

  /** PUT /api/v1/admin/packages/:role — replace a package's capabilities (admin only). */
  async adminUpdate(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.requireAdmin(ctx);
    if (err) return err;
    const role = String(ctx.params.role ?? '');
    if (!(await new RoleStore().exists(role))) {
      return { success: false, error: 'Invalid role', status_code: 400 };
    }

    const capabilities = ctx.body?.capabilities ?? null;
    // PHP: !is_array($capabilities) — a JSON object OR array passes; scalars/null fail.
    if (capabilities === null || typeof capabilities !== 'object') {
      return { success: false, error: 'capabilities object is required', status_code: 400 };
    }
    const validationError = this.validateCapabilities(capabilities);
    if (validationError !== null) {
      return { success: false, error: validationError, status_code: 400 };
    }

    // JS JSON.stringify already leaves `/` and non-ASCII unescaped — matches PHP's
    // JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
    const encoded = JSON.stringify(capabilities);
    const adminId = /^\d+$/.test(String(ctx.user_id)) ? Number(ctx.user_id) : null;

    // Atomic upsert (mirrors PHP): INSERT ... ON DUPLICATE KEY UPDATE avoids the
    // rowCount()-semantics trap where re-saving unchanged capabilities would otherwise
    // fall through to a duplicate-PK INSERT and 500.
    await sql`
      INSERT INTO packages (role, capabilities, updated_by) VALUES (${role}, ${encoded}, ${adminId})
      ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)`.execute(db);

    // Fresh resolver → reads the just-written row (not a stale cache entry).
    return {
      success: true,
      package: this.withRoleInfo(await new PackageResolver().loadPackage(role), (await new RoleStore().get(role)) ?? {}),
    };
  }

  /** The package plus its role's display name and builtin flag (gpt_admin renders role tabs from them). */
  private withRoleInfo(pkg: ResolvedPackage, row: Partial<Role>): ResolvedPackage & { name: string; builtin: boolean } {
    const role = String(pkg.role);
    return { ...pkg, name: row.name ?? (role === '' ? role : role[0].toUpperCase() + role.slice(1)), builtin: Boolean(row.builtin ?? false) };
  }

  /** Mirrors PackageController.php validateCapabilities: returns an error string or null. */
  private validateCapabilities(caps: any): string | null {
    for (const required of ['providers', 'sidebar']) {
      // PHP requires an array; a JSON object or array both pass is_array in PHP's json_decode(...,true).
      if (!(required in caps) || caps[required] === null || typeof caps[required] !== 'object') {
        return `capabilities.${required} must be an object`;
      }
    }
    for (const optional of ['mcp_servers', 'skills']) {
      if (optional in caps && caps[optional] !== null && typeof caps[optional] !== 'object') {
        return `capabilities.${optional} must be null or an array`;
      }
    }
    if ('quota_tokens' in caps && caps.quota_tokens !== null && !Number.isInteger(caps.quota_tokens)) {
      return 'capabilities.quota_tokens must be null or an integer';
    }
    return null;
  }

  /** Mirrors PackageController.php requireAdmin: 401 if unauthenticated, 403 if not role=admin. */
  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    const userId = ctx.user_id ?? null;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    const row = (await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)).rows[0];
    if (!row || (row.role ?? '') !== 'admin') {
      return { success: false, error: 'Admin access required', status_code: 403 };
    }
    return null;
  }
}
