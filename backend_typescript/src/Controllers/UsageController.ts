import { Ctx, ControllerResult } from '../Support/Http';
import { getBalance, getTransactions, getStats, TransactionFilters } from '../Services/UsageLogger';

/**
 * UsageController — faithful TS mirror of src/Controllers/UsageController.php.
 * Read-only access to the LLM usage ledger the UsageLogger service writes
 * (llm_usage_transactions / llm_usage_balance).
 *
 *   GET /api/v1/usage               -> getBalance
 *   GET /api/v1/usage/balance       -> getBalance
 *   GET /api/v1/usage/transactions  -> getTransactions
 *   GET /api/v1/usage/stats         -> getStats
 */

// PHP (int) cast semantics (truncating; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

export class UsageController {
  /** Get usage balance/ledger for current user */
  async getBalance(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const provider = (ctx.query.provider as string | undefined) ?? null;

    const balance = await getBalance(userId as any, provider);

    return {
      success: true,
      data: balance,
      status_code: 200,
    };
  }

  /** Get transaction history for current user */
  async getTransactions(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;
    const q = ctx.query;

    // Parse query parameters (a filter applies only when the key is present — PHP isset())
    const filters: TransactionFilters = {};
    if (q.provider !== undefined) {
      filters.provider = String(q.provider);
    }
    if (q.date_from !== undefined) {
      filters.date_from = String(q.date_from);
    }
    if (q.date_to !== undefined) {
      filters.date_to = String(q.date_to);
    }
    if (q.status !== undefined) {
      filters.status = String(q.status);
    }

    let limit = q.limit !== undefined ? phpIntVal(q.limit) : 100;
    const offset = q.offset !== undefined ? phpIntVal(q.offset) : 0;

    // Validate limit
    if (limit < 1 || limit > 1000) {
      limit = 100;
    }

    const transactions = await getTransactions(userId as any, filters, limit, offset);

    return {
      success: true,
      data: transactions,
      pagination: {
        limit,
        offset,
        count: transactions.length,
      },
      status_code: 200,
    };
  }

  /** Get aggregated statistics for current user */
  async getStats(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id;

    let period = (ctx.query.period as string | undefined) ?? 'month';
    const provider = (ctx.query.provider as string | undefined) ?? null;

    // Validate period
    if (!['day', 'week', 'month', 'year', 'all'].includes(period)) {
      period = 'month';
    }

    const stats = await getStats(userId as any, period, provider);

    return {
      success: true,
      data: stats,
      period,
      provider,
      status_code: 200,
    };
  }
}
