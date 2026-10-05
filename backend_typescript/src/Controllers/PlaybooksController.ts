import { PlaybookStore, PlaybookStoreError } from '../Playbook/PlaybookStore';
import { Ctx, ControllerResult } from '../Support/Http';

/** /api/v1/playbooks — the playbook collection (CRUD + used-by), over PlaybookStore. Mirrors PlaybooksController.php. */
export class PlaybooksController {
  private store = new PlaybookStore();

  async index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.store.list(u) }));
  }

  async show(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const id = this.id(ctx);
      const row = await this.store.get(u, id);
      if (row === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
      return { success: true, data: row };
    });
  }

  async create(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.store.save(u, null, this.text(ctx), this.key(ctx)) }));
  }

  async update(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.store.save(u, this.id(ctx), this.text(ctx), this.key(ctx)) }));
  }

  async destroy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      await this.store.delete(u, this.id(ctx));
      return { success: true };
    });
  }

  async usedBy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const id = this.id(ctx);
      if ((await this.store.get(u, id)) === null) throw new PlaybookStoreError('not_found', `Playbook #${id} not found`, 404);
      return { success: true, data: await this.store.usedBy(u, id) };
    });
  }

  private id(ctx: Ctx): number {
    return parseInt(String((ctx.params as any)?.id ?? 0), 10) || 0;
  }

  private text(ctx: Ctx): string {
    const t = (ctx.body as any)?.text;
    if (typeof t !== 'string' || t.trim() === '') {
      throw new PlaybookStoreError('invalid_text', 'text is required (the playbook, as written).', 400);
    }
    return t;
  }

  private key(ctx: Ctx): string | null {
    const k = (ctx.body as any)?.pkey;
    return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
  }

  /** Authentication, then the action; a PlaybookStoreError becomes {success:false, error, kind, status_code}. */
  private async guard(ctx: Ctx, action: (userId: number) => Promise<ControllerResult>): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0) || 0;
    if (userId <= 0) return { success: false, error: 'Authentication required', kind: 'auth', status_code: 401 };
    try {
      return await action(userId);
    } catch (e) {
      if (e instanceof PlaybookStoreError) return { success: false, error: e.message, kind: e.kind, status_code: e.status };
      throw e;
    }
  }
}
