import { sql } from 'kysely';
import { db } from '../db/pools';
import { log } from './Logger';
import { resolvePricing, PricingUnavailableError } from './PricingResolver';

/**
 * Records LLM usage — the TS port of PHP's UsageLogger for the token-based (chat) path.
 * PHP writes a row per API call to `llm_usage_transactions` and rolls up `llm_usage_balance`;
 * the TS /chat path never did (documented gap), so nothing showed in gpt_admin for Node runs.
 *
 * Cost is DATA-DRIVEN from `system_llm_settings` (price_input_per_1m / price_output_per_1m) —
 * the source of truth — rather than PHP's hardcoded (and stale) PRICING map, via PricingResolver.
 * All DB work is best-effort: a logging failure must never break a chat response, but a pricing
 * lookup failure must never be silently recorded as a $0 cost either — it surfaces as NULL +
 * an error note.
 */

/** Pure token-cost math from [input_per_1m, output_per_1m] rates. */
export function costFromRates(rates: [number, number], promptTokens: number, completionTokens: number): number {
  const cost = (promptTokens / 1_000_000) * rates[0] + (completionTokens / 1_000_000) * rates[1];
  return Math.round(cost * 1e6) / 1e6;
}

/** USD cost for a token-based call from DB pricing. Throws PricingUnavailableError when unavailable. */
export async function calculateCost(provider: string, promptTokens: number, completionTokens: number): Promise<number> {
  const rates = await resolvePricing(provider);
  return costFromRates(rates, promptTokens, completionTokens);
}

export interface ChatUsageData {
  user_id: number | string | null;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  response_time_ms?: number | null;
  status?: string;
  error_message?: string | null;
  function_calls_count?: number;
  mcp_calls_count?: number;
  session_id?: string | null;
  conversation_id?: string | null;
}

/** Insert one token-based usage row + roll up the balance ledger. Mirrors UsageLogger::logTransaction. */
export async function logChatTransaction(data: ChatUsageData): Promise<number | null> {
  if (!data.user_id) {
    log.warn('[UsageLogger] missing user_id — skipping transaction');
    return null;
  }
  try {
    const promptTokens = data.prompt_tokens ?? 0;
    const completionTokens = data.completion_tokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    let costUsd: number | null = null;
    let errorMessage: string | null = data.error_message ?? null;
    try {
      costUsd = await calculateCost(data.provider, promptTokens, completionTokens);
    } catch (e: any) {
      if (e instanceof PricingUnavailableError) {
        costUsd = null; // do NOT record a misleading $0
        errorMessage = `${errorMessage ?? ''} | PRICING_ERROR: ${e.message}`.trim();
        log.error('[UsageLogger] PRICING_ERROR', e.message);
      } else {
        throw e;
      }
    }
    const status = data.status ?? 'success';

    const res = await sql`INSERT INTO llm_usage_transactions (
        user_id, session_id, conversation_id, provider, model,
        prompt_tokens, completion_tokens, total_tokens, cost_usd,
        response_time_ms, status, error_message,
        function_calls_count, functions_called, mcp_calls_count, mcp_tools_called,
        request_metadata,
        is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds
      ) VALUES (
        ${data.user_id}, ${data.session_id ?? null}, ${data.conversation_id ?? null}, ${data.provider}, ${data.model},
        ${promptTokens}, ${completionTokens}, ${totalTokens}, ${costUsd},
        ${data.response_time_ms ?? null}, ${status}, ${errorMessage},
        ${data.function_calls_count ?? 0}, ${null}, ${data.mcp_calls_count ?? 0}, ${null},
        ${null},
        ${0}, ${null}, ${null}, ${null}
      )`.execute(db);

    const transactionId = Number((res as any).insertId ?? 0);

    await updateBalance(data.user_id, data.provider, {
      tokens: totalTokens,
      cost: costUsd ?? 0,
      success: status === 'success',
      function_calls: data.function_calls_count ?? 0,
      mcp_calls: data.mcp_calls_count ?? 0,
    });

    log.info('[UsageLogger] transaction logged', {
      id: transactionId,
      user: data.user_id,
      provider: data.provider,
      model: data.model,
      tokens: totalTokens,
      cost: costUsd,
    });
    return transactionId;
  } catch (e: any) {
    log.error('[UsageLogger] failed to log transaction', e?.message ?? e);
    return null;
  }
}

/** Roll up the running/monthly balance ledger — mirrors UsageLogger::updateBalance (token-based). */
async function updateBalance(
  userId: number | string,
  provider: string,
  d: { tokens: number; cost: number; success: boolean; function_calls: number; mcp_calls: number },
): Promise<void> {
  if (!userId) return;
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const success = d.success ? 1 : 0;
    const failure = d.success ? 0 : 1;

    await checkMonthReset(userId, provider, currentMonth);

    await sql`INSERT INTO llm_usage_balance (
        user_id, provider,
        total_requests, successful_requests, failed_requests,
        total_function_calls, total_mcp_calls,
        total_voice_requests, total_audio_seconds, total_voice_cost_usd,
        total_tokens, total_cost_usd,
        month_requests, month_tokens, month_cost_usd,
        month_function_calls, month_mcp_calls,
        month_voice_requests, month_audio_seconds, month_voice_cost_usd,
        current_month
      ) VALUES (
        ${userId}, ${provider},
        1, ${success}, ${failure},
        ${d.function_calls}, ${d.mcp_calls},
        0, 0, 0,
        ${d.tokens}, ${d.cost},
        1, ${d.tokens}, ${d.cost},
        ${d.function_calls}, ${d.mcp_calls},
        0, 0, 0,
        ${currentMonth}
      ) ON DUPLICATE KEY UPDATE
        total_requests = total_requests + 1,
        successful_requests = successful_requests + VALUES(successful_requests),
        failed_requests = failed_requests + VALUES(failed_requests),
        total_function_calls = total_function_calls + VALUES(total_function_calls),
        total_mcp_calls = total_mcp_calls + VALUES(total_mcp_calls),
        total_tokens = total_tokens + VALUES(total_tokens),
        total_cost_usd = total_cost_usd + VALUES(total_cost_usd),
        month_requests = month_requests + 1,
        month_tokens = month_tokens + VALUES(month_tokens),
        month_cost_usd = month_cost_usd + VALUES(month_cost_usd),
        month_function_calls = month_function_calls + VALUES(month_function_calls),
        month_mcp_calls = month_mcp_calls + VALUES(month_mcp_calls),
        current_month = VALUES(current_month)`.execute(db);
  } catch (e: any) {
    log.error('[UsageLogger] failed to update balance', e?.message ?? e);
  }
}

/** Reset monthly counters when the stored month differs — mirrors UsageLogger::checkMonthReset. */
async function checkMonthReset(userId: number | string, provider: string, currentMonth: string): Promise<void> {
  try {
    const row = (
      await sql<{ current_month: string | null }>`SELECT current_month FROM llm_usage_balance
        WHERE user_id = ${userId} AND provider = ${provider}`.execute(db)
    ).rows[0];

    if (row && row.current_month !== currentMonth) {
      await sql`UPDATE llm_usage_balance SET
        month_requests = 0,
        month_tokens = 0,
        month_cost_usd = 0.000000,
        month_function_calls = 0,
        month_mcp_calls = 0,
        month_voice_requests = 0,
        month_audio_seconds = 0.00,
        month_voice_cost_usd = 0.000000,
        current_month = ${currentMonth}
        WHERE user_id = ${userId} AND provider = ${provider}`.execute(db);
    }
  } catch (e: any) {
    log.error('[UsageLogger] failed to check month reset', e?.message ?? e);
  }
}
