import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * HealController — faithful TS mirror of src/Controllers/HealController.php.
 * The server-side enforcement gate for self-healing: reads per-user heal
 * settings (users.heal_*) + a daily spend ledger (heal_spend).
 *
 *   POST /api/v1/heal/authorize { skill_dir, estimate_usd } -> {allowed, mode, ...}
 *   POST /api/v1/heal/record    { actual_usd }              -> records spend
 *   GET  /api/v1/heal/status                                 -> {mode, spent_today, ...}
 *
 * ensureSpendTable() IS ported (exception to skip-DDL): `heal_spend` is created
 * only by this runtime CREATE TABLE IF NOT EXISTS (also mirrored to
 * migrations/heal_spend.sql for manual application).
 */

// PHP (float) cast semantics (bool→1/0; leading-numeric parse; NaN→0).
function phpFloatVal(v: any): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

// PHP round($v, $precision) — half away from zero, with the pre-round-to-15-sig-digits fix.
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

interface HealConfig {
  mode: string;
  budget: number;
  ceiling: number;
}

export class HealController {
  private spendTableEnsured = false;

  /** Decide whether a heal may run, per mode + budget + ceiling. */
  async authorize(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    const b = ctx.body ?? {};
    const estimate = Math.max(0, phpFloatVal(b.estimate_usd ?? 0));
    const skillDir = String(b.skill_dir ?? '');

    const cfg = await this.healConfig(userId);
    const spent = await this.spentToday(userId);
    const remaining = Math.max(0, cfg.budget - spent);

    const base = {
      success: true,
      mode: cfg.mode,
      skill_dir: skillDir,
      estimate_usd: phpRound(estimate, 4),
      spent_today_usd: phpRound(spent, 4),
      budget_usd: cfg.budget,
      remaining_usd: phpRound(remaining, 4),
      ceiling_usd: cfg.ceiling,
    };

    return { ...base, ...this.decide(cfg.mode, estimate, remaining, cfg.ceiling) };
  }

  /**
   * Pure decision: given mode + estimate + remaining budget + ceiling,
   * decide whether a heal may run.
   */
  decide(mode: string, estimate: number, remaining: number, ceiling: number): {
    allowed: boolean; requires_approval: boolean; reason: string;
  } {
    if (mode === 'off') {
      return { allowed: false, requires_approval: false, reason: 'mode_off' };
    }
    if (estimate > remaining) {
      return { allowed: false, requires_approval: false, reason: 'over_budget' };
    }
    if (mode === 'ask') {
      // Allowed, but the client must show the approval overlay first.
      return { allowed: true, requires_approval: true, reason: 'ask' };
    }
    // auto: must also be under the per-heal ceiling.
    if (estimate > ceiling) {
      return { allowed: false, requires_approval: true, reason: 'over_ceiling' };
    }
    return { allowed: true, requires_approval: false, reason: 'auto' };
  }

  /** Record actual heal spend against today's ledger. */
  async record(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    const actual = Math.max(0, phpFloatVal((ctx.body ?? {}).actual_usd ?? 0));
    await this.ensureSpendTable();
    try {
      await sql`INSERT INTO heal_spend (user_id, day, spent_usd) VALUES (${userId}, CURDATE(), ${actual})
                ON DUPLICATE KEY UPDATE spent_usd = spent_usd + ${actual}`.execute(db);
    } catch (e: any) {
      console.error('[HealController] record failed: ' + (e?.message ?? e));
      return { success: false, error: 'record failed', status_code: 500 };
    }
    return { success: true, spent_today_usd: phpRound(await this.spentToday(userId), 4) };
  }

  /** Current mode + today's spend, for the UI. */
  async status(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    const cfg = await this.healConfig(userId);
    const spent = await this.spentToday(userId);
    return {
      success: true,
      mode: cfg.mode,
      budget_usd: cfg.budget,
      ceiling_usd: cfg.ceiling,
      spent_today_usd: phpRound(spent, 4),
      remaining_usd: phpRound(Math.max(0, cfg.budget - spent), 4),
    };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /** Read this user's heal mode/budget/ceiling (defaults if columns absent). */
  private async healConfig(userId: number): Promise<HealConfig> {
    const out: HealConfig = { mode: 'off', budget: 5.0, ceiling: 1.0 };
    try {
      const row = (
        await sql<{ heal_mode: any; heal_daily_budget_usd: any; heal_per_heal_ceiling_usd: any }>`SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd FROM users WHERE id = ${userId}`.execute(db)
      ).rows[0];
      if (row) {
        if (['off', 'ask', 'auto'].includes(row.heal_mode ?? null)) {
          out.mode = row.heal_mode;
        }
        if (row.heal_daily_budget_usd !== null && row.heal_daily_budget_usd !== undefined) {
          out.budget = Number(row.heal_daily_budget_usd);
        }
        if (row.heal_per_heal_ceiling_usd !== null && row.heal_per_heal_ceiling_usd !== undefined) {
          out.ceiling = Number(row.heal_per_heal_ceiling_usd);
        }
      }
    } catch {
      // columns may not exist yet → defaults (mode off = safe)
    }
    return out;
  }

  private async spentToday(userId: number): Promise<number> {
    await this.ensureSpendTable();
    try {
      const row = (
        await sql<{ spent_usd: any }>`SELECT spent_usd FROM heal_spend WHERE user_id = ${userId} AND day = CURDATE()`.execute(db)
      ).rows[0];
      return row !== undefined && row !== null ? Number(row.spent_usd) : 0.0;
    } catch {
      return 0.0;
    }
  }

  private async ensureSpendTable(): Promise<void> {
    if (this.spendTableEnsured) {
      return;
    }
    try {
      await sql`CREATE TABLE IF NOT EXISTS heal_spend (
                    user_id BIGINT UNSIGNED NOT NULL,
                    day DATE NOT NULL,
                    spent_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, day)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);
    } catch (e: any) {
      console.error('[HealController] ensureSpendTable failed: ' + (e?.message ?? e));
    }
    this.spendTableEnsured = true;
  }
}
