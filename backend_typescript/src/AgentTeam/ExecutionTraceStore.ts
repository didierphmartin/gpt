import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * ExecutionTraceStore — faithful TS mirror of
 * src/AgentTeam/Services/ExecutionTraceStore.php (Phase 0 of self-healing).
 *
 * Captures ONE structured, classified, outcome-labelled record per skill/agent
 * execution. Deterministic classification only — no LLM calls.
 *
 * FIDELITY NOTES
 *  - ensureTable() is INTENTIONALLY NOT PORTED: `execution_traces` already exists
 *    in the DB, so the PHP CREATE is not replicated (the parent owns that schema).
 *    insert() therefore does NOT call ensureTable (the PHP call is a no-op-equivalent).
 *  - setUserAction / workflowTrace / skillWeaknesses are NOT PORTED: neither
 *    TracesController nor HealController use them (per the port spec).
 *  - Ported methods: insert, classify, outcomeQuality, diagnose, verdict (private),
 *    recommend (private), estimateHealCost, blendedCost (private), pricing (private),
 *    foundationBugs.
 *  - COUNT(*) AS n: the PHP PDO connection uses ATTR_EMULATE_PREPARES=false, so
 *    COUNT (LONGLONG) comes back as a PHP int; mysql2 likewise returns it as a JS
 *    number. diagnose casts (int) → Number(); foundationBugs leaves it raw (matches).
 */

// PHP strtolower — ASCII-only (PHP 8.2+ / C locale): only A–Z are lowercased.
function phpStrtolower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// PHP empty(): true for null/undefined, false, 0, 0.0, '', '0', [].
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === '' || v === '0') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// PHP falsy for the `?:` operator (invocation_mode ?: 'unknown', provider ?: 'unknown').
function phpFalsy(v: any): boolean {
  return phpEmpty(v);
}

// PHP (int) cast semantics (truncating; bool→1/0; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP round($v, $precision) — half away from zero, with the pre-round-to-15-sig-digits
// fix (mirrors AdminController.ts::phpRound).
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

// PHP <=> spaceship operator.
function spaceship(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Shared apology probe (identical pattern used by classify + outcomeQuality in PHP).
// PHP `/\b(i\'?m unable|i am unable|i cannot|i can\'?t|apolog|not available in (my|this))/`.
const APOLOGY_RE = /\b(i'?m unable|i am unable|i cannot|i can'?t|apolog|not available in (my|this))/;

type Trace = Record<string, any>;

interface SkillAgg {
  skill_dir: string;
  total: number;
  bad: number;
  by_mode: Record<string, { total: number; bad: number }>;
  by_class: Record<string, number>;
  providers: Record<string, number>;
  verdict?: string;
  recommended?: any;
  estimate?: any;
}

export class ExecutionTraceStore {
  /** provider => [priceIn, priceOut] per 1M (nullable) */
  private pricingCache: Record<string, [number | null, number | null]> = {};

  /**
   * Classify + label a trace and insert it. Tolerant of missing keys.
   * Returns the inserted id, or null on failure (never throws).
   */
  async insert(t: Trace): Promise<number | null> {
    try {
      // NB: PHP calls ensureTable() here — intentionally skipped (table exists).

      // Classify on the FULL record.
      t.error_class = this.classify(t);
      t.outcome_quality = this.outcomeQuality(t, t.error_class);

      // Everything bulky folds into one JSON blob.
      const payload = {
        model: t.model ?? null,
        latency_ms: t.latency_ms ?? null,
        script: t.script ?? null,
        argv: t.argv ?? [],
        input_snapshot: t.input_snapshot ?? null,
        tool_calls: t.tool_calls ?? [],
        skill_exit_code: t.skill_exit_code ?? null,
        skill_stdout: t.skill_stdout ?? null,
        skill_log_messages: t.skill_log_messages ?? null,
        output_files: t.output_files ?? [],
        final_text: t.final_text ?? null,
        rounds: t.rounds ?? null,
        round_limit_hit: !phpEmpty(t.round_limit_hit),
        loop_detected: !phpEmpty(t.loop_detected),
      };

      // Queryable columns (NOT user_action — its DEFAULT 'none' applies).
      const runId = this.coerce('run_id', t.run_id ?? null);
      const ts = this.coerce('ts', t.ts ?? null);
      const env = this.coerce('env', t.env ?? null);
      const invocationMode = this.coerce('invocation_mode', t.invocation_mode ?? null);
      const workflowId = this.coerce('workflow_id', t.workflow_id ?? null);
      const nodeId = this.coerce('node_id', t.node_id ?? null);
      const provider = this.coerce('provider', t.provider ?? null);
      const skillDir = this.coerce('skill_dir', t.skill_dir ?? null);
      const success = this.coerce('success', t.success ?? null);
      const errorClass = this.coerce('error_class', t.error_class ?? null);
      const errorText = this.coerce('error_text', t.error_text ?? null);
      const outcomeQuality = this.coerce('outcome_quality', t.outcome_quality ?? null);
      const tokensIn = this.coerce('tokens_in', t.tokens_in ?? null);
      const tokensOut = this.coerce('tokens_out', t.tokens_out ?? null);
      const costUsd = this.coerce('cost_usd', t.cost_usd ?? null);
      // JSON_UNESCAPED_SLASHES: JSON.stringify already leaves slashes unescaped.
      const payloadJson = JSON.stringify(payload);

      const res = await sql`INSERT INTO \`execution_traces\`
        (\`run_id\`, \`ts\`, \`env\`, \`invocation_mode\`, \`workflow_id\`, \`node_id\`,
         \`provider\`, \`skill_dir\`, \`success\`, \`error_class\`, \`error_text\`,
         \`outcome_quality\`, \`tokens_in\`, \`tokens_out\`, \`cost_usd\`, \`payload\`)
        VALUES (${runId}, ${ts}, ${env}, ${invocationMode}, ${workflowId}, ${nodeId},
                ${provider}, ${skillDir}, ${success}, ${errorClass}, ${errorText},
                ${outcomeQuality}, ${tokensIn}, ${tokensOut}, ${costUsd}, ${payloadJson})`.execute(db);

      const id = (res as any).insertId;
      return id === undefined || id === null ? 0 : Number(id);
    } catch (e: any) {
      console.error('[ExecutionTraceStore] insert failed: ' + (e?.message ?? e));
      return null;
    }
  }

  // ─── Deterministic classifier (no LLM) ──────────────────────────────────

  /** Assign error_class. First match wins. See spec §4.1. */
  classify(t: Trace): string {
    const err = phpStrtolower(String(t.error_text ?? ''));
    const logs = phpStrtolower(String(t.skill_log_messages ?? ''));
    const body = phpStrtolower(String((t.final_text ?? '') + ' ' + (t.skill_stdout ?? '')));
    const success = !phpEmpty(t.success);
    const exit = t.skill_exit_code ?? null;
    const argvRaw = t.argv ?? null;
    const argv = phpStrtolower(typeof argvRaw === 'string' ? argvRaw : JSON.stringify(t.argv ?? []));

    // e — transient / external (provider outage, rate limit)
    if (/\b(429|503|500|overloaded|rate.?limit|service unavailable|quota exceeded|temporarily|try again)\b/.test(err)) {
      return 'e_transient_external';
    }
    // d — foundation / plumbing bug (NOT fixable by a skill edit)
    if (/not registered|undefined variable|provider .* not found|thought_signature|reasoning_content|must be passed back|unsupported|fatal error|call to undefined|\.php on line/.test(err)) {
      return 'd_foundation_code';
    }
    // b — skill script error
    if ((exit !== null && phpIntVal(exit) !== 0)
      || logs.indexOf('traceback (most recent call last)') !== -1) {
      return 'b_skill_script';
    }
    // a — skill-prompt weakness: ran "successfully" but misbehaved
    const helpProbe = argv.indexOf('"-h"') !== -1 || argv.indexOf('"--help"') !== -1;
    const apology = APOLOGY_RE.test(body);
    if (success && (!phpEmpty(t.loop_detected) || !phpEmpty(t.round_limit_hit) || helpProbe || apology)) {
      return 'a_skill_prompt';
    }
    // c — workflow-config: failed inside a workflow node, not obviously a/b/d/e
    if (!success && (t.env ?? '') === 'workflow') {
      return 'c_workflow_config';
    }
    if (!success) {
      return 'a_skill_prompt';
    }
    return 'ok';
  }

  /** Derive outcome_quality from free signals only. See spec §4.2. */
  outcomeQuality(t: Trace, cls: string | null = null): string {
    const success = !phpEmpty(t.success);
    if (!success) {
      return 'failed';
    }
    const loop = !phpEmpty(t.loop_detected) || !phpEmpty(t.round_limit_hit);
    const body = phpStrtolower(String((t.final_text ?? '') + ' ' + (t.skill_stdout ?? '')));
    const apology = APOLOGY_RE.test(body);
    if (loop || apology || cls === 'a_skill_prompt') {
      return 'degraded';
    }
    const exit = t.skill_exit_code ?? null;
    if (exit === null || phpIntVal(exit) === 0) {
      return 'good';
    }
    return 'unknown';
  }

  // ─── Diagnosis layer (read-only, no LLM) — design §4 ────────────────────

  /**
   * Turn raw traces into an actionable diagnosis: per skill that has any
   * degraded/failed runs, a verdict + a heal-cost estimate for the skill-text
   * cases.
   */
  async diagnose(sinceDays = 30): Promise<any> {
    const rows = await this.query(
      sql<any>`SELECT skill_dir, invocation_mode, error_class, outcome_quality, provider, COUNT(*) AS n
             FROM execution_traces
             WHERE skill_dir IS NOT NULL AND skill_dir <> ''
               AND ts >= (NOW() - INTERVAL ${sinceDays} DAY)
             GROUP BY skill_dir, invocation_mode, error_class, outcome_quality, provider`
    );

    const skills: Record<string, SkillAgg> = {};
    const order: string[] = [];
    for (const r of rows) {
      const sd = r.skill_dir;
      if (!Object.prototype.hasOwnProperty.call(skills, sd)) {
        skills[sd] = { skill_dir: sd, total: 0, bad: 0, by_mode: {}, by_class: {}, providers: {} };
        order.push(sd);
      }
      const n = phpIntVal(r.n);
      const bad = ['degraded', 'failed'].includes(r.outcome_quality);
      skills[sd].total += n;
      const mode = !phpFalsy(r.invocation_mode) ? r.invocation_mode : 'unknown';
      if (!Object.prototype.hasOwnProperty.call(skills[sd].by_mode, mode)) {
        skills[sd].by_mode[mode] = { total: 0, bad: 0 };
      }
      skills[sd].by_mode[mode].total += n;
      if (bad) {
        skills[sd].bad += n;
        skills[sd].by_mode[mode].bad += n;
        skills[sd].by_class[r.error_class] = (skills[sd].by_class[r.error_class] ?? 0) + n;
        const prov = !phpFalsy(r.provider) ? r.provider : 'unknown';
        skills[sd].providers[prov] = (skills[sd].providers[prov] ?? 0) + n;
      }
    }

    const out: SkillAgg[] = [];
    for (const sd of order) {
      const s = skills[sd];
      if (s.bad === 0) {
        continue; // only report skills with problems
      }
      const verdict = this.verdict(s);
      const rec = this.recommend(verdict);
      s.verdict = verdict;
      s.recommended = rec;
      if (verdict === 'skill_description' || verdict === 'skill_body') {
        const provKeys = Object.keys(s.providers);
        const provs = provKeys.length > 0 ? provKeys : ['claude'];
        s.estimate = await this.estimateHealCost(provs);
      }
      out.push(s);
    }
    // usort by bad DESC — PHP 8 sort is stable; Array.sort is stable.
    out.sort((a, b) => spaceship(b.bad, a.bad));

    return {
      window_days: sinceDays,
      skills: out,
      foundation_bugs: await this.foundationBugs(sinceDays),
    };
  }

  /** Decide which layer/loop should fix a skill, using class + the ablation. */
  private verdict(s: SkillAgg): string {
    // arsort($cls) + array_key_first: key with the largest count, earliest-inserted on ties.
    let top: string | null = null;
    let topN = -Infinity;
    for (const [k, v] of Object.entries(s.by_class)) {
      if (v > topN) {
        topN = v;
        top = k;
      }
    }
    if (top === null) top = 'a_skill_prompt';

    if (top === 'e_transient_external') return 'transient_external';
    if (top === 'd_foundation_code') return 'foundation_code';
    if (top === 'b_skill_script') return 'skill_script';
    if (top === 'c_workflow_config') return 'workflow_config';

    // a_skill_prompt: use the invocation-mode ablation.
    const rate = (m: { total: number; bad: number } | undefined | null): number | null =>
      m && m.total > 0 ? m.bad / m.total : null;
    const ra = rate(s.by_mode['auto_discovery'] ?? null);
    const rf = rate(s.by_mode['forced'] ?? null);
    const rw = rate(s.by_mode['workflow_node'] ?? null);
    if (ra !== null && ra > 0.3
      && ((rf !== null && rf < 0.2) || (rw !== null && rw < 0.2))) {
      return 'skill_description';
    }
    return 'skill_body';
  }

  /** Map a verdict to a layer + loop + human action. */
  private recommend(verdict: string): any {
    switch (verdict) {
      case 'skill_description':
        return { layer: 'skill', loop: 'run_loop', action: 'Optimize the skill DESCRIPTION (it is being mis-discovered).' };
      case 'skill_body':
        return { layer: 'skill', loop: 'run_body_loop', action: 'Optimize the skill BODY (it runs but misbehaves).' };
      case 'skill_script':
        return { layer: 'skill', loop: null, action: 'Fix the Python script (code, but isolated to the skill).' };
      case 'workflow_config':
        return { layer: 'workflow', loop: null, action: 'Adjust workflow node config (provider / topology / forcing).' };
      case 'foundation_code':
        return { layer: 'foundation', loop: null, action: 'File a PR — runtime/plumbing bug, NOT auto-healable.' };
      case 'transient_external':
        return { layer: 'none', loop: null, action: 'Retry/backoff — external outage, nothing to fix.' };
      default:
        return { layer: 'skill', loop: 'run_body_loop', action: 'Optimize the skill body.' };
    }
  }

  // ─── Cost estimate (for the future approval overlay, design §4.4) ───────

  /**
   * Forecast the token + USD cost of a heal loop. Pure-ish (reads pricing).
   * calls = Q*R*2*(1+I) + I ; eval calls priced on the (cheap) eval model,
   * the I proposer calls on the (strong) proposer model.
   */
  async estimateHealCost(
    providers: string[],
    Q = 10,
    R = 3,
    I = 3,
    evalProvider = 'kimi',
    proposerProvider = 'claude',
    avgEvalTokens = 4000,
    avgProposerTokens = 9000
  ): Promise<any> {
    const nProv = Math.max(1, providers.length);
    const proposerCalls = I * nProv;
    const evalCalls = (Q * R * 2 * (1 + I)) * nProv;
    const totalCalls = evalCalls + proposerCalls;

    const evalTokens = evalCalls * avgEvalTokens;
    const proposerTokens = proposerCalls * avgProposerTokens;
    const tokens = evalTokens + proposerTokens;

    // ~80% input / 20% output blend.
    const usd = (await this.blendedCost(evalProvider, evalTokens))
      + (await this.blendedCost(proposerProvider, proposerTokens));

    return {
      calls: totalCalls,
      tokens: tokens,
      usd: phpRound(usd, 4),
      usd_range: [phpRound(usd * 0.7, 4), phpRound(usd * 1.4, 4)],
      assumptions: { providers, Q, R, I, evalProvider, proposerProvider },
    };
  }

  private async blendedCost(provider: string, tokens: number): Promise<number> {
    const [pinRaw, poutRaw] = await this.pricing(provider);
    const pin = pinRaw ?? 0.0;
    const pout = poutRaw ?? 0.0;
    return (0.8 * tokens * pin + 0.2 * tokens * pout) / 1_000_000;
  }

  /** Per-1M [in,out] USD from system_llm_settings, with defaults. */
  private async pricing(provider: string): Promise<[number | null, number | null]> {
    provider = phpStrtolower(provider);
    const map: Record<string, string> = { anthropic: 'claude', google: 'gemini' };
    const key = map[provider] ?? provider;
    if (Object.prototype.hasOwnProperty.call(this.pricingCache, key)) {
      return this.pricingCache[key];
    }
    const defaults: Record<string, [number, number]> = {
      claude: [3.0, 15.0], openai: [2.5, 10.0], gemini: [0.3, 2.5],
      grok: [0.2, 0.5], deepseek: [0.28, 0.42], kimi: [0.55, 2.2],
    };
    let inP: number | null = defaults[key] ? defaults[key][0] : null;
    let outP: number | null = defaults[key] ? defaults[key][1] : null;
    try {
      const row = (
        await sql<{ price_input_per_1m: any; price_output_per_1m: any }>`SELECT price_input_per_1m, price_output_per_1m FROM system_llm_settings WHERE provider_key = ${key} LIMIT 1`.execute(db)
      ).rows[0];
      if (row) {
        if (row.price_input_per_1m !== null && row.price_input_per_1m !== undefined) {
          inP = Number(row.price_input_per_1m);
        }
        if (row.price_output_per_1m !== null && row.price_output_per_1m !== undefined) {
          outP = Number(row.price_output_per_1m);
        }
      }
    } catch {
      // defaults apply
    }
    this.pricingCache[key] = [inP, outP];
    return this.pricingCache[key];
  }

  /** Foundation reader: recurring class-d bugs, ranked by frequency. */
  async foundationBugs(sinceDays = 30): Promise<any[]> {
    return this.query(
      sql<any>`SELECT provider, LEFT(error_text, 120) AS signature, COUNT(*) AS n
             FROM execution_traces
             WHERE error_class = 'd_foundation_code'
               AND ts >= (NOW() - INTERVAL ${sinceDays} DAY)
             GROUP BY provider, signature
             ORDER BY n DESC`
    );
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async query(query: ReturnType<typeof sql>): Promise<any[]> {
    try {
      // NB: PHP calls ensureTable() here — intentionally skipped (table exists).
      const res = await query.execute(db);
      return (res as any).rows ?? [];
    } catch (e: any) {
      console.error('[ExecutionTraceStore] query failed: ' + (e?.message ?? e));
      return [];
    }
  }

  /** Coerce a kept-column value to a DB-storable scalar. */
  private coerce(col: string, v: any): any {
    if (col === 'success') {
      return !phpEmpty(v) ? 1 : 0;
    }
    if (Array.isArray(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
}
