import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { ROUTER_FORMAT, dispatchProviderList } from '../Services/ProviderKinds';
import { packageAllowed } from '../Services/DecisionAccess';

/** Decision-model dispatch. TS has no routing runtime: it only lists the providers, none routable. */
export class DispatchController {
  /** GET /api/v1/dispatch/providers */
  async providers(ctx: Ctx): Promise<ControllerResult> {
    try {
      const rows = (await sql`SELECT * FROM system_llm_settings WHERE api_format = ${ROUTER_FORMAT}`.execute(db)).rows as Record<string, any>[];
      return { success: true, ...dispatchProviderList(rows, await packageAllowed(ctx.user_id)), status_code: 200 };
    } catch (e: any) {
      return { success: false, error: 'Failed to list decision providers: ' + (e?.message ?? ''), status_code: 500 };
    }
  }
}
