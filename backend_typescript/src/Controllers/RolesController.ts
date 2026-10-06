import { RoleStore, RoleStoreError } from '../Services/RoleStore';
import { Ctx, ControllerResult } from '../Support/Http';
import { requireAdmin } from './RequiresAdmin';

/**
 * Mirrors src/Controllers/RolesController.php — admin API for roles (capabilities are still edited
 * through /admin/packages/:role). Every action checks the caller's admin role in the database.
 *
 *   GET    /api/v1/admin/roles
 *   POST   /api/v1/admin/roles            {role, name, copy_from?}
 *   PUT    /api/v1/admin/roles/:role      {name}
 *   DELETE /api/v1/admin/roles/:role
 */
export class RolesController {
  private store = new RoleStore();

  async index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async () => ({ success: true, data: await this.store.list() }));
  }

  async create(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async () => {
      const b = ctx.body ?? {};
      const copy = b.copy_from ?? null;
      return {
        success: true,
        data: await this.store.create(phpString(b.role), phpString(b.name), typeof copy === 'string' ? copy : null),
      };
    });
  }

  async rename(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async () => ({
      success: true,
      data: await this.store.rename(this.key(ctx), phpString((ctx.body ?? {}).name)),
    }));
  }

  async destroy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async () => {
      await this.store.delete(this.key(ctx));
      return { success: true };
    });
  }

  private key(ctx: Ctx): string {
    return String(ctx.params?.role ?? '');
  }

  private async guard(ctx: Ctx, action: () => Promise<ControllerResult>): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    try {
      return await action();
    } catch (e) {
      if (e instanceof RoleStoreError) return { success: false, error: e.message, kind: e.kind, status_code: e.status };
      throw e;
    }
  }
}

/** PHP (string) cast of a body value: null/absent → '', scalars as text, anything else '' (PHP would warn on arrays). */
function phpString(v: any): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return '';
}
