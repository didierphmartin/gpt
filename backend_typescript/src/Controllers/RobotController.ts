import { config } from '../config/env';
import { PlaybookStore, PlaybookStoreError } from '../Playbook/PlaybookStore';
import { Edition, EditionConfig } from '../Services/Edition';
import { RobotAccount } from '../Services/RobotAccount';
import { RobotPolicy } from '../Services/RobotPolicy';
import { Ctx, ControllerResult } from '../Support/Http';

/** Mirrors src/Controllers/RobotController.php — /api/v1/robot: the robot account's status and its published-playbook collection. */
export class RobotController {
  constructor(private readonly cfg: EditionConfig = config) {}

  /** A fresh policy per request (its PackageResolver caches per instance; this controller is a singleton). */
  private policy(): RobotPolicy {
    return new RobotPolicy(this.cfg);
  }

  async show(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      await RobotAccount.ensure();
      const policy = this.policy();
      return {
        success: true,
        data: {
          exists: true,
          name: RobotAccount.NAME,
          can_use: await policy.canUse(u),
          can_manage: await policy.canManage(u),
          edition: Edition.current(this.cfg),
        },
      };
    });
  }

  async playbooks(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      await this.requireAccess(u);
      return { success: true, data: await new PlaybookStore().robotList(await RobotAccount.ensure()) };
    });
  }

  async unpublish(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      await this.requireAccess(u);
      const id = parseInt(String((ctx.params as any)?.id ?? 0), 10) || 0;
      await new PlaybookStore().unpublish(await RobotAccount.ensure(), id);
      return { success: true };
    });
  }

  private async requireAccess(userId: number): Promise<void> {
    const policy = this.policy();
    if (!(await policy.canUse(userId)) && !(await policy.canManage(userId))) {
      throw new PlaybookStoreError('forbidden', "Your role can't use the robot", 403);
    }
  }

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
