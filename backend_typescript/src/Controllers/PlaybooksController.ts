import { config } from '../config/env';
import { PlaybookStore, PlaybookStoreError } from '../Playbook/PlaybookStore';
import { EditionConfig } from '../Services/Edition';
import { RobotAccount } from '../Services/RobotAccount';
import { RobotPolicy } from '../Services/RobotPolicy';
import { Ctx, ControllerResult } from '../Support/Http';

/** /api/v1/playbooks — the playbook collection (CRUD + used-by + publish to the robot), over PlaybookStore. Mirrors PlaybooksController.php. */
export class PlaybooksController {
  private store = new PlaybookStore();

  constructor(private readonly cfg: EditionConfig = config) {}

  /** A fresh policy per request (its PackageResolver caches per instance; this controller is a singleton). */
  private policy(): RobotPolicy {
    return new RobotPolicy(this.cfg);
  }

  /** The user's playbooks; each row carries `published` (null | 'published' | 'changed') when the user can use the robot. */
  async index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const rows = await this.store.list(u);
      if (await this.policy().canUse(u)) {
        const robotId = await RobotAccount.id();
        const status = robotId === null ? {} : await this.store.publishStatus(u, robotId);
        for (const r of rows) r.published = (status as Record<number, string>)[r.id] ?? null;
      }
      return { success: true, data: rows };
    });
  }

  /** POST /api/v1/playbooks/:id/publish {confirm_replace?} — a frozen copy for the robot. */
  async publish(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      if (!(await this.policy().canUse(u))) {
        throw new PlaybookStoreError('forbidden', "Your role can't publish to the robot", 403);
      }
      const row = await this.store.publish(u, this.id(ctx), await RobotAccount.ensure(), (ctx.body as any)?.confirm_replace === true);
      return { success: true, data: row };
    });
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
      if (e instanceof PlaybookStoreError) {
        return { success: false, error: e.message, kind: e.kind, status_code: e.status, ...(Object.keys(e.data).length ? { data: e.data } : {}) };
      }
      throw e;
    }
  }
}
