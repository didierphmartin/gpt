import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { GenesisProposer, GenesisProposal } from '../Services/GenesisProposer';
import { LLMProviderResolver } from '../Services/LLMProviderResolver';
import { ProviderFactory } from '../Providers/ProviderFactory';

/**
 * GenesisController — faithful TS mirror of src/Controllers/GenesisController.php.
 * Server-side enforcement gate + promotion store for skill genesis
 * (spec: docs/specs/2026-07-14-skill-genesis-design.md §6–7).
 *
 * Mirrors HealController's philosophy: the build LOOP runs client-side
 * (skill folder written via the browser's local-FS handle; optional SkillOpt
 * hardening in Pyodide), but whether it may SPEND, and how much, is decided
 * here. Ledger: heal_spend with kind='genesis' (heal rows default 'heal').
 *
 *   GET  /api/v1/genesis/promotions?status=proposed          -> listPromotions
 *   POST /api/v1/genesis/authorize                           -> authorize
 *   POST /api/v1/genesis/record                              -> record
 *   POST /api/v1/genesis/promotions/{id}/dismiss             -> dismiss
 *   POST /api/v1/genesis/proposals                           -> createProposal
 */

// PHP (float) cast semantics (bool→1/0; leading-numeric parse; NaN→0).
function phpFloatVal(v: any): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

// PHP (int) cast semantics (leading-numeric parse; NaN→0).
function phpIntVal(v: any): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP round($v, $precision) — half away from zero, with the pre-round-to-15-sig-digits fix.
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

// Mirrors PHP `json_decode((string)$col, true) ?: fallback` on a JSON/TEXT column.
// mysql2 may hand JSON columns back already parsed; pass those through.
function decodeJsonCol(v: any, fallback: any): any {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) ?? fallback;
    } catch {
      return fallback;
    }
  }
  return typeof v === 'object' ? v : fallback;
}

interface GenesisConfig {
  mode: string;
  budget: number;
  ceiling: number;
  weekly_max: number;
  provider: string;
}

export class GenesisController {
  private tablesEnsured = false;

  /**
   * Pure decision: may this promotion build run? Extracted for testability
   * (precedent: HealController.decide).
   */
  decide(
    mode: string,
    estimate: number,
    remaining: number,
    ceiling: number,
    bornThisWeek: number,
    weeklyMax: number,
    approved: boolean,
  ): { allowed: boolean; requires_approval: boolean; reason: string } {
    if (mode === 'off') {
      return { allowed: false, requires_approval: false, reason: 'mode_off' };
    }
    if (mode === 'suggest') {
      return { allowed: false, requires_approval: false, reason: 'suggest_only' };
    }
    if (estimate > remaining) {
      return { allowed: false, requires_approval: false, reason: 'over_budget' };
    }
    if (bornThisWeek >= weeklyMax) {
      return { allowed: false, requires_approval: false, reason: 'weekly_throttle' };
    }
    if (mode === 'ask') {
      return approved
        ? { allowed: true, requires_approval: false, reason: 'ask_approved' }
        : { allowed: false, requires_approval: true, reason: 'ask' };
    }
    // auto: must also clear the per-skill ceiling.
    if (estimate > ceiling) {
      return { allowed: false, requires_approval: true, reason: 'over_ceiling' };
    }
    return { allowed: true, requires_approval: false, reason: 'auto' };
  }

  // ─── DDL (house lazy pattern) ────────────────────────────────────────────

  async ensureTables(): Promise<void> {
    if (this.tablesEnsured) {
      return;
    }
    try {
      await sql`CREATE TABLE IF NOT EXISTS skill_promotions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    class TINYINT NOT NULL,
                    status ENUM('proposed','approved','building','born','merged','dismissed','failed')
                        NOT NULL DEFAULT 'proposed',
                    source_ref VARCHAR(191) NOT NULL,
                    skill_name VARCHAR(120) NOT NULL,
                    description TEXT NOT NULL,
                    eval_queries JSON NOT NULL,
                    parameter_schema JSON NULL,
                    merge_target VARCHAR(120) NULL,
                    est_cost_usd DECIMAL(8,4) NULL,
                    born_skill_dir VARCHAR(120) NULL,
                    created_at DATETIME NOT NULL,
                    decided_at DATETIME NULL,
                    UNIQUE KEY uq_user_skill (user_id, skill_name)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);
    } catch (e: any) {
      console.error('[GenesisController] ensureTables(skill_promotions) failed: ' + (e?.message ?? e));
    }
    // heal_spend may not exist at all yet on a fresh install (HealController's
    // own ensureSpendTable() may not have run). Bootstrap it here too so genesis
    // works standalone; log-and-continue mirrors the skill_promotions block.
    try {
      await sql`CREATE TABLE IF NOT EXISTS heal_spend (
                    user_id BIGINT UNSIGNED NOT NULL,
                    day DATE NOT NULL,
                    kind ENUM('heal','genesis') NOT NULL DEFAULT 'heal',
                    spent_usd DECIMAL(10,4) NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, day, kind)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);
    } catch (e: any) {
      console.error('[GenesisController] ensureTables(heal_spend) failed: ' + (e?.message ?? e));
    }
    // heal_spend.kind — probe then alter (PK must include kind so heal and
    // genesis rows upsert independently per (user, day)).
    try {
      await sql`SELECT kind FROM heal_spend LIMIT 1`.execute(db);
    } catch {
      const alters = [
        sql`ALTER TABLE heal_spend ADD COLUMN kind ENUM('heal','genesis') NOT NULL DEFAULT 'heal'`,
        sql`ALTER TABLE heal_spend DROP PRIMARY KEY`,
        sql`ALTER TABLE heal_spend ADD PRIMARY KEY (user_id, day, kind)`,
      ];
      for (const q of alters) {
        try {
          await q.execute(db);
        } catch {
          /* already applied */
        }
      }
    }
    this.tablesEnsured = true;
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────

  /** GET /api/v1/genesis/promotions?status=proposed */
  async listPromotions(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    await this.ensureTables();
    const status = String(ctx.query?.status ?? '');
    const rows =
      status !== ''
        ? (
            await sql<any>`SELECT * FROM skill_promotions WHERE user_id = ${userId} AND status = ${status}
                           ORDER BY created_at DESC LIMIT 100`.execute(db)
          ).rows
        : (
            await sql<any>`SELECT * FROM skill_promotions WHERE user_id = ${userId}
                           ORDER BY created_at DESC LIMIT 100`.execute(db)
          ).rows;
    const promotions = rows.map((r: any) => ({
      ...r,
      eval_queries: decodeJsonCol(r.eval_queries, []),
      parameter_schema: r.parameter_schema !== null ? decodeJsonCol(r.parameter_schema, null) : null,
    }));
    return { success: true, promotions };
  }

  /** POST /api/v1/genesis/authorize {promotion_id, estimate_usd, approved?} */
  async authorize(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    await this.ensureTables();
    const b = ctx.body ?? {};
    const promotionId = phpIntVal(b.promotion_id ?? 0);
    const estimate = Math.max(0, phpFloatVal(b.estimate_usd ?? 0));
    const approved = !!b.approved;

    if (!(await this.promotionBelongsToUser(promotionId, userId))) {
      return { success: false, error: 'Promotion not found', status_code: 404 };
    }

    const statusRow = (
      await sql<any>`SELECT status FROM skill_promotions WHERE id = ${promotionId} AND user_id = ${userId}`.execute(db)
    ).rows[0];
    const currentStatus = String(statusRow?.status ?? '');
    if (!['proposed', 'approved'].includes(currentStatus)) {
      return { success: false, error: 'Promotion already decided', status_code: 409 };
    }

    const cfg = await this.genesisConfig(userId);
    const spent = await this.spentToday(userId);
    const remaining = Math.max(0, cfg.budget - spent);
    const born = await this.bornThisWeek(userId);

    const decision = this.decide(cfg.mode, estimate, remaining, cfg.ceiling, born, cfg.weekly_max, approved);

    if (decision.allowed) {
      await sql`UPDATE skill_promotions SET status = 'approved' WHERE id = ${promotionId} AND user_id = ${userId}`.execute(db);
    }

    return {
      success: true,
      mode: cfg.mode,
      estimate_usd: phpRound(estimate, 4),
      spent_today_usd: phpRound(spent, 4),
      budget_usd: cfg.budget,
      remaining_usd: phpRound(remaining, 4),
      ceiling_usd: cfg.ceiling,
      born_this_week: born,
      weekly_max: cfg.weekly_max,
      ...decision,
    };
  }

  /** POST /api/v1/genesis/record {promotion_id, actual_usd, outcome, skill_dir?} */
  async record(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    await this.ensureTables();
    const b = ctx.body ?? {};
    const promotionId = phpIntVal(b.promotion_id ?? 0);
    const actual = Math.max(0, phpFloatVal(b.actual_usd ?? 0));
    const outcome = ['born', 'failed', 'merged'].includes(b.outcome ?? '') ? b.outcome : 'failed';
    const skillDir = b.skill_dir !== undefined && b.skill_dir !== null ? String(b.skill_dir) : null;

    if (!(await this.promotionBelongsToUser(promotionId, userId))) {
      return { success: false, error: 'Promotion not found', status_code: 404 };
    }

    try {
      await db.transaction().execute(async (trx) => {
        await sql`UPDATE skill_promotions
                  SET status = ${outcome}, born_skill_dir = ${outcome === 'born' ? skillDir : null}, decided_at = NOW()
                  WHERE id = ${promotionId} AND user_id = ${userId}`.execute(trx);
        await sql`INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (${userId}, CURDATE(), 'genesis', ${actual})
                  ON DUPLICATE KEY UPDATE spent_usd = spent_usd + ${actual}`.execute(trx);
      });
    } catch (e: any) {
      console.error('[GenesisController] record failed: ' + (e?.message ?? e));
      return { success: false, error: 'record failed', status_code: 500 };
    }
    return { success: true, spent_today_usd: phpRound(await this.spentToday(userId), 4) };
  }

  /** POST /api/v1/genesis/promotions/{id}/dismiss */
  async dismiss(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    await this.ensureTables();
    const id = phpIntVal(ctx.params?.id ?? 0);
    const res = await sql`UPDATE skill_promotions SET status = 'dismissed', decided_at = NOW()
                          WHERE id = ${id} AND user_id = ${userId}`.execute(db);
    if (Number(res.numAffectedRows ?? 0) === 0) {
      return { success: false, error: 'Promotion not found', status_code: 404 };
    }
    return { success: true };
  }

  /**
   * POST /api/v1/genesis/proposals
   * {source:'conversation'|'workflow'|'prompt', context_id?|workflow_id?|prompt_id?, catalog?:[{name,description}]}
   * Runs ONE reflection LLM call (resolved through the shared provider config,
   * mirroring PHP's ChatController::agent) and stores the proposal as a promotion row.
   */
  async createProposal(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    await this.ensureTables();
    const b = ctx.body ?? {};
    const source = String(b.source ?? '');
    const catalog = Array.isArray(b.catalog) ? b.catalog : [];

    let prompt = '';
    let klass: number;
    let sourceRef: string;
    let proposal: GenesisProposal | null = null;

    if (source === 'conversation') {
      const contextId = phpIntVal(b.context_id ?? 0);
      const ctxRow = (
        await sql<any>`SELECT context_data FROM conversation_contexts WHERE id = ${contextId} AND user_id = ${userId}`.execute(db)
      ).rows[0];
      if (ctxRow === undefined) {
        return { success: false, error: 'Context not found', status_code: 404 };
      }
      const data = decodeJsonCol(ctxRow.context_data, []);
      const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
      if (messages.length === 0) {
        return { success: false, error: 'Context has no messages', status_code: 400 };
      }
      prompt = GenesisProposer.buildConversationPrompt(messages, catalog);
      klass = 1;
      sourceRef = 'context:' + contextId;
    } else if (source === 'workflow') {
      const workflowId = phpIntVal(b.workflow_id ?? 0);
      const wf = (
        await sql<any>`SELECT id, name, description, steps FROM agent_workflows WHERE id = ${workflowId} AND user_id = ${userId}`.execute(db)
      ).rows[0];
      if (!wf) {
        return { success: false, error: 'Workflow not found', status_code: 404 };
      }
      // Editor-built workflows always persist steps = [] — the real graph lives in
      // workflow_nodes (AgentTeam/WorkflowRepository.ts). Ownership was already
      // checked on the agent_workflows row above; workflow_nodes has no user_id
      // column of its own, so we scope by the already-verified workflow_id only.
      const nodeRows = (
        await sql<any>`SELECT * FROM workflow_nodes WHERE workflow_id = ${workflowId} ORDER BY id`.execute(db)
      ).rows;
      const nodes = nodeRows.map((row: any) => {
        const config = decodeJsonCol(row.config, {});
        const node: { type: string; name?: string } = { type: row.node_type ?? 'agent' };
        const name = config?.agent_name ?? config?.name ?? config?.title ?? null;
        if (typeof name === 'string' && name !== '') node.name = name;
        return node;
      });
      // Manual on-ramp = an explicit user decision, and the workflow's
      // structure is already fully declared (name, description, nodes).
      // Nothing here needs LLM judgment — build the proposal
      // DETERMINISTICALLY: instant, free, and immune to reflection
      // failures. The LLM reflection below stays only for sources that
      // require extraction from unstructured text (conversation, prompt).
      const agentNames: string[] = [];
      for (const n of nodes) {
        if (n.type === 'agent' && n.name) {
          agentNames.push(n.name);
        }
      }
      const wfName = String(wf.name ?? '').trim() !== '' ? String(wf.name).trim() : 'workflow ' + workflowId;
      let name = wfName.toLowerCase();
      name = name.replace(/[^a-z0-9]+/g, '-');
      name = name.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
      name = (name !== '' ? name : 'workflow-' + workflowId).slice(0, 60);
      const wfDescr = String(wf.description ?? '').trim();
      const descr =
        wfDescr !== ''
          ? wfDescr
          : `Runs the '${wfName}' agent workflow (${agentNames.length} agents` +
            (agentNames.length ? ': ' + agentNames.slice(0, 8).join(', ') : '') +
            ') on a user-supplied prompt.';
      proposal = {
        skill_name: name,
        description: descr.slice(0, 500),
        eval_queries: [],
        parameter_schema: null,
        merge_target: null,
        rationale: 'Manual workflow promotion — structure is explicit, no reflection needed.',
        is_merge: false,
      };
      klass = 2;
      sourceRef = 'workflow:' + workflowId;
    } else if (source === 'prompt') {
      const promptId = phpIntVal(b.prompt_id ?? 0);
      const row = (
        await sql<any>`SELECT id, name, content FROM prompt_library WHERE id = ${promptId} AND user_id = ${userId} AND type = 'prompt'`.execute(db)
      ).rows[0];
      if (!row) {
        return { success: false, error: 'Prompt not found', status_code: 404 };
      }
      if (String(row.content ?? '').trim() === '') {
        return { success: false, error: 'Prompt has no content', status_code: 400 };
      }
      prompt = GenesisProposer.buildPromptLibraryPrompt(String(row.name), String(row.content), catalog);
      klass = 1;
      sourceRef = 'prompt:' + promptId;
    } else {
      return { success: false, error: "source must be 'conversation', 'workflow' or 'prompt'", status_code: 400 };
    }

    // One-shot LLM reflection — only for sources whose procedure must be
    // EXTRACTED from unstructured text (conversation, prompt-library).
    // Workflow promotions arrive here with `proposal` already built.
    if (proposal === null) {
      const cfg = await this.genesisConfig(userId);
      let text = '';
      try {
        // Mirrors PHP's ChatController::agent: resolve the reflection provider from the
        // shared provider config and run one plain non-streaming chat (no tools).
        const providerCfg = await LLMProviderResolver.getProviderConfig(cfg.provider);
        if (!providerCfg) {
          throw new Error(`Provider '${cfg.provider}' not available`);
        }
        const impl = ProviderFactory.create(providerCfg);
        const result = await impl.chat({ message: prompt, conversation_history: [], user_id: userId });
        text = String(result.text ?? '');
      } catch (e: any) {
        return {
          success: false,
          error: 'Reflection call failed: ' + (e?.message ?? 'unknown'),
          status_code: 502,
        };
      }
      proposal = GenesisProposer.parseProposal(text);
      if (proposal === null) {
        return { success: true, promotion: null, message: 'No repeatable procedure found in this material.' };
      }
    }

    let id: number;
    try {
      const evals = JSON.stringify(proposal.eval_queries);
      const params = proposal.parameter_schema !== null ? JSON.stringify(proposal.parameter_schema) : null;
      const res = await sql`INSERT INTO skill_promotions
                (user_id, class, status, source_ref, skill_name, description, eval_queries,
                 parameter_schema, merge_target, created_at)
             VALUES (${userId}, ${klass}, 'proposed', ${sourceRef}, ${proposal.skill_name}, ${proposal.description},
                     ${evals}, ${params}, ${proposal.merge_target}, NOW())
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), class = VALUES(class),
                 description = VALUES(description),
                 eval_queries = VALUES(eval_queries), parameter_schema = VALUES(parameter_schema),
                 merge_target = VALUES(merge_target), status = 'proposed', decided_at = NULL`.execute(db);
      id = Number(res.insertId);
    } catch (e: any) {
      console.error('[GenesisController] proposal insert failed: ' + (e?.message ?? e));
      return { success: false, error: 'Could not store proposal', status_code: 500 };
    }

    return {
      success: true,
      promotion: {
        id,
        class: klass,
        status: 'proposed',
        source_ref: sourceRef,
        skill_name: proposal.skill_name,
        description: proposal.description,
        eval_queries: proposal.eval_queries,
        parameter_schema: proposal.parameter_schema,
        merge_target: proposal.merge_target,
        rationale: proposal.rationale,
        is_merge: proposal.is_merge,
      },
    };
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async promotionBelongsToUser(promotionId: number, userId: number): Promise<boolean> {
    if (promotionId <= 0) return false;
    const row = (
      await sql<any>`SELECT 1 AS ok FROM skill_promotions WHERE id = ${promotionId} AND user_id = ${userId}`.execute(db)
    ).rows[0];
    return row !== undefined;
  }

  /** Read this user's genesis mode/budgets/provider (defaults if columns absent). */
  private async genesisConfig(userId: number): Promise<GenesisConfig> {
    const d: GenesisConfig = { mode: 'off', budget: 3.0, ceiling: 1.5, weekly_max: 2, provider: 'kimi' };
    try {
      const row = (
        await sql<any>`SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,
                              genesis_max_skills_per_week, genesis_reflection_provider
                       FROM users WHERE id = ${userId}`.execute(db)
      ).rows[0] ?? {};
      return {
        mode: String(row.genesis_mode ?? d.mode) || d.mode,
        budget: row.genesis_daily_budget_usd != null ? Number(row.genesis_daily_budget_usd) : d.budget,
        ceiling: row.genesis_per_skill_ceiling_usd != null ? Number(row.genesis_per_skill_ceiling_usd) : d.ceiling,
        weekly_max: row.genesis_max_skills_per_week != null ? phpIntVal(row.genesis_max_skills_per_week) : d.weekly_max,
        provider: String(row.genesis_reflection_provider ?? d.provider) || d.provider,
      };
    } catch {
      return d; // columns not created yet → defaults (mode off = safe)
    }
  }

  private async spentToday(userId: number): Promise<number> {
    try {
      const row = (
        await sql<any>`SELECT COALESCE(SUM(spent_usd),0) AS total FROM heal_spend
                       WHERE user_id = ${userId} AND day = CURDATE() AND kind = 'genesis'`.execute(db)
      ).rows[0];
      return row !== undefined ? Number(row.total) : 0.0;
    } catch {
      return 0.0;
    }
  }

  private async bornThisWeek(userId: number): Promise<number> {
    try {
      const row = (
        await sql<any>`SELECT COUNT(*) AS n FROM skill_promotions
                       WHERE user_id = ${userId} AND status = 'born' AND decided_at >= (NOW() - INTERVAL 7 DAY)`.execute(db)
      ).rows[0];
      return row !== undefined ? phpIntVal(row.n) : 0;
    } catch {
      return 0;
    }
  }
}
