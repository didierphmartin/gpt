import { DecisionHttp, DecisionOutcome, DecisionRouter } from '../AgentTeam/DecisionRouter';
import { JevRouter } from '../AgentTeam/JevRouter';
import { OpenAIDecisionRouter } from '../AgentTeam/OpenAIDecisionRouter';
import { DecisionKeyResolver, ResolvedDecisionKey } from './DecisionKeyResolver';

type AdapterClass = new (
  apiKey: string | null,
  http: DecisionHttp | null,
  floor: number,
  url: string,
  model: string
) => DecisionRouter;

/**
 * The adapter class of each decision protocol (PHP keeps it as DecisionProtocols' `adapter`).
 * Adding a vendor = one DecisionRouter class + one entry in DecisionProtocols and here.
 */
export const DECISION_ADAPTERS: Record<string, AdapterClass> = {
  typesafe: JevRouter,
  openai: OpenAIDecisionRouter,
};

/** Builds the adapter for a resolved decision provider. Mirrors backend/src/Services/DecisionRouters.php. */
export const DecisionRouters = {
  make(resolved: ResolvedDecisionKey, floor: number, http: DecisionHttp | null = null): DecisionRouter | null {
    if (resolved.protocol === null || resolved.row === null) return null;
    const id = String(resolved.row.protocol ?? '');
    const Adapter = Object.hasOwn(DECISION_ADAPTERS, id) ? DECISION_ADAPTERS[id] : null;
    if (Adapter === null) return null;
    const model = String(resolved.row.model ?? '').trim();
    return new Adapter(resolved.key !== '' ? resolved.key : null, http, floor, String(resolved.url), model);
  },

  /** The outcome an unbuildable or keyless provider reports, without calling anyone. */
  unavailable(resolved: ResolvedDecisionKey, providerKey: string): DecisionOutcome {
    return {
      outcome: 'unavailable',
      target: null,
      confidence: null,
      probabilities: [],
      ms: null,
      usage: {},
      reason: DecisionKeyResolver.unavailableReason(resolved, providerKey),
    };
  },
};
