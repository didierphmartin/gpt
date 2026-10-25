import { Ctx, ControllerResult } from '../Support/Http';
import { CodeComponentError } from '../CodeComponent/CodeComponentError';
import { CodeComponentStore } from '../CodeComponent/CodeComponentStore';

/**
 * /api/v1/code-components — the code components collection (CRUD + used-by + the Start option), over
 * CodeComponentStore. Mirrors backend/src/Controllers/CodeComponentsController.php.
 *
 * `sweep` is PHP's ActiveWorkflowService::sweep() after a Start option is removed (reverted Starts: their
 * active mode is gone). It never fails the write it follows; the default does nothing until the active
 * workflows service is wired in.
 */
export type ActiveSweep = () => Promise<void>;

function intval(v: any): number {
  const n = parseInt(String(v ?? 0), 10);
  return Number.isNaN(n) ? 0 : n;
}

export class CodeComponentsController {
  constructor(
    private readonly store: CodeComponentStore = new CodeComponentStore(),
    private readonly sweep: ActiveSweep = async () => {},
  ) {}

  index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.store.list(u) }));
  }

  show(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.found(u, ctx) }));
  }

  create(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true, data: await this.store.save(u, null, this.body(ctx)) }));
  }

  update(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true,
      data: await this.store.save(u, intval(ctx.params?.id ?? 0), this.body(ctx)) }));
  }

  destroy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      await this.store.delete(u, intval(ctx.params?.id ?? 0));
      return { success: true };
    });
  }

  usedBy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true,
      data: await this.store.usedBy(u, (await this.found(u, ctx)).id) }));
  }

  setStartOption(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true,
      data: await this.store.setStartTrigger(u, intval(ctx.params?.id ?? 0), this.body(ctx)) }));
  }

  startOptionImpact(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => ({ success: true,
      data: await this.store.startTriggerImpact(u, (await this.found(u, ctx)).id) }));
  }

  clearStartOption(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const data = await this.store.clearStartTrigger(u, intval(ctx.params?.id ?? 0));
      await this.sweepActive(); // reverted Starts: their mode is gone
      return { success: true, data };
    });
  }

  private async sweepActive(): Promise<void> {
    try { // never fails the write it follows: the write already happened, and the event worker sweeps every 5 s
      await this.sweep();
    } catch (e: any) {
      console.error('[ActiveWorkflow] sweep failed: ' + (e?.message ?? String(e)));
    }
  }

  private async found(u: number, ctx: Ctx) {
    const id = intval(ctx.params?.id ?? 0);
    const c = await this.store.get(u, id);
    if (c === null) throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    return c;
  }

  private body(ctx: Ctx): Record<string, any> {
    const b = ctx.body ?? {};
    return b !== null && typeof b === 'object' ? b : {};
  }

  /** Authentication, then the action; a CodeComponentError becomes {success:false, error, kind, status_code[, data]}. */
  private async guard(ctx: Ctx, action: (userId: number) => Promise<ControllerResult>): Promise<ControllerResult> {
    const userId = intval(ctx.user_id ?? 0);
    if (userId <= 0) {
      return { success: false, error: 'Authentication required', kind: 'auth', status_code: 401 };
    }
    try {
      return await action(userId);
    } catch (e) {
      if (e instanceof CodeComponentError) {
        return { success: false, error: e.message, kind: e.kind, status_code: e.status,
          ...(e.data.length > 0 ? { data: e.data } : {}) };
      }
      throw e;
    }
  }
}
