import { DecisionOutcome } from '../AgentTeam/DecisionRouter';
import { ChatUsageData, logChatTransaction } from './UsageLogger';

/**
 * One usage row per decision-model call the vendor answered, written like an LLM call (UsageLogger)
 * under the decision row's key, so usage and cost screens show it. A call never sent (not allowed,
 * no key, bad menu) records nothing. Mirrors backend/src/Services/DecisionUsage.php.
 */
export type UsageWriter = (tx: ChatUsageData) => Promise<number | null>;

export const DecisionUsage = {
  /** The vendor answered: adapters set ms only once a response came back. */
  shouldRecord(out: Partial<DecisionOutcome>): boolean {
    return out.ms !== undefined && out.ms !== null;
  },

  transaction(userId: number, providerKey: string, model: string, out: Partial<DecisionOutcome>): ChatUsageData {
    const isError = out.outcome === 'error';
    return {
      user_id: userId,
      provider: providerKey,
      model,
      prompt_tokens: Math.trunc(Number(out.usage?.input_tokens ?? 0)) || 0,
      completion_tokens: Math.trunc(Number(out.usage?.output_tokens ?? 0)) || 0,
      response_time_ms: Math.trunc(Number(out.ms)) || 0,
      status: isError ? 'error' : 'success',
      error_message: isError ? String(out.reason ?? '') : null,
      request_metadata: { decision_outcome: String(out.outcome ?? '') },
    };
  },

  async record(
    logger: UsageWriter | null,
    userId: number | null,
    providerKey: string,
    model: string,
    out: Partial<DecisionOutcome>
  ): Promise<void> {
    if (userId === null || userId <= 0 || !DecisionUsage.shouldRecord(out)) return;
    try {
      await (logger ?? logChatTransaction)(DecisionUsage.transaction(userId, providerKey, model, out));
    } catch (e: any) {
      // Usage is bookkeeping: it must never turn a routed request into a failure.
      console.error('[DecisionUsage] could not record a decision call: ' + (e?.message ?? e));
    }
  },
};
