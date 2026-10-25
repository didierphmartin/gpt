/**
 * A decision-model adapter: asks one vendor's API a closed question (which of these targets?) and
 * never writes text. One class per protocol (JevRouter, OpenAIDecisionRouter), registered in
 * DecisionRouters. Every adapter takes the same constructor:
 *   (apiKey: string | null, http: DecisionHttp | null, confidenceFloor, url, model)
 * where '' url/model mean the protocol default. Mirrors backend/src/AgentTeam/Services/DecisionRouter.php.
 */

export type DecisionOutcomeKind = 'routed' | 'unclear' | 'low_confidence' | 'unavailable' | 'error';

export interface DecisionTarget {
  id: any;
  name: string;
  description?: string;
  [k: string]: any;
}

/** 'routed' is the only outcome that decides; ms is set only when the vendor answered. */
export interface DecisionOutcome {
  outcome: DecisionOutcomeKind;
  target: DecisionTarget | null;
  confidence: number | null;
  probabilities: any;
  ms: number | null;
  usage: Record<string, any>;
  reason: string | null;
}

export interface DecisionRouter {
  /** Configured = a key is present. */
  isAvailable(): boolean;
  route(request: string, targets: DecisionTarget[], question: string): Promise<DecisionOutcome>;
}

/** The HTTP transport a router posts with (the Guzzle client of the PHP adapters); tests pass a fake. */
export interface DecisionHttpResponse {
  status: number;
  statusText?: string;
  text(): Promise<string>;
}
export type DecisionHttp = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string }
) => Promise<DecisionHttpResponse>;

/**
 * Below this, the decision is treated as divided. 0.6 sits above every straddling case measured
 * (0.46, 0.51) and well below every clean one (>= 0.95). (JevRouter::DEFAULT_CONFIDENCE_FLOOR)
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

/** The synthetic option that lets "I cannot tell" be sayable. Never a real branch name. */
export const UNCLEAR = 'unclear';

export const UNCLEAR_DESC =
  'The request does not say enough to choose, or it genuinely spans ' +
  'several of the options. Pick this rather than guessing.';

/**
 * 10s: a measured p50 of ~160ms and max of 385ms means a request still running after ten seconds
 * is broken, not slow.
 */
export const defaultDecisionHttp: DecisionHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, statusText: res.statusText, text: () => res.text() };
};

/** A blank result, the fields every non-answer shares. */
export function blankOutcome(outcome: DecisionOutcomeKind, reason: string): DecisionOutcome {
  return { outcome, target: null, confidence: null, probabilities: [], ms: null, usage: {}, reason };
}

/** PHP (float) for a JSON value. */
export function toFloat(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

/** The first `max` characters (code points, like mb_substr). */
export function mbSubstr(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

export function isObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object';
}

/**
 * The menu as name => target (first position kept, last value wins on a duplicate name, as a PHP
 * array keyed by name does), or the error reason that refuses the call.
 */
export function namedMenu(targets: DecisionTarget[]): Map<string, DecisionTarget> | string {
  const named = new Map<string, DecisionTarget>();
  for (const t of targets ?? []) {
    const name = String(t?.name ?? '').trim();
    if (name === '' || name.toLowerCase() === UNCLEAR) {
      // A branch literally named "unclear" would collide with the escape hatch and make its answer
      // ambiguous. Refuse the whole call rather than route on a menu we cannot read back.
      return `unusable target name: '${name}'`;
    }
    named.set(name, t);
  }
  if (named.size < 2) return 'a menu needs at least two targets';
  return named;
}

/** The description a choice carries: the target's own role, else its name (mb_substr 400). */
export function choiceDescription(name: string, t: DecisionTarget): string {
  const desc = String(t?.description ?? '').trim();
  return desc !== '' ? mbSubstr(desc, 400) : name;
}

/** The outcome of an answered choice (shared by every adapter). */
export function choiceOutcome(
  answer: Record<string, any>,
  named: Map<string, DecisionTarget>,
  floor: number,
  ms: number,
  usage: Record<string, any>
): DecisionOutcome {
  const choice = String(answer.choice);
  const conf = answer.confidence !== undefined && answer.confidence !== null ? toFloat(answer.confidence) : null;
  const probs = isObject(answer.probabilities) ? answer.probabilities : [];
  const common = { confidence: conf, probabilities: probs, ms, usage };
  if (choice === UNCLEAR) {
    return { ...common, outcome: 'unclear', target: null, reason: 'the request names no branch' };
  }
  const target = named.get(choice);
  if (target === undefined) {
    // Should be unreachable: the answer is constrained to what we sent. Treated as an error rather
    // than trusted, because the whole reason to use a decision model here is that this cannot happen.
    return { ...common, outcome: 'error', target: null, reason: `answer '${choice}' is not on the menu` };
  }
  if (conf !== null && conf < floor) {
    return {
      ...common,
      outcome: 'low_confidence',
      target,
      reason: `confidence ${conf.toFixed(2)} below floor ${floor.toFixed(2)}`,
    };
  }
  return { ...common, outcome: 'routed', target, reason: null };
}
