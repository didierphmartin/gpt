import {
  DecisionHttp,
  DecisionOutcome,
  DecisionRouter,
  DecisionTarget,
  DEFAULT_CONFIDENCE_FLOOR,
  UNCLEAR,
  UNCLEAR_DESC,
  blankOutcome,
  choiceDescription,
  choiceOutcome,
  defaultDecisionHttp,
  isObject,
  namedMenu,
} from './DecisionRouter';

/**
 * Routing decisions from OpenAI's Decisions API (GPT-6 Luna), for dispatcher nodes — the `openai`
 * protocol adapter. Mirrors backend/src/AgentTeam/Services/OpenAIDecisionRouter.php.
 *
 * Wire differences from Jev: `input` instead of `state`; `questions` and `answers` are arrays
 * matched by `name`; choices are [{value, description}] (2..255); an answer may come back as type
 * `refusal`.
 */
export class OpenAIDecisionRouter implements DecisionRouter {
  static readonly URL = 'https://api.openai.com/v1/decisions';
  /** The only model the Decisions API serves (public beta, 2026-10). */
  static readonly MODEL = 'gpt-6-luna';
  static readonly UNCLEAR = UNCLEAR;
  /** The API's limit on choices per question, the unclear option included. */
  private static readonly MAX_CHOICES = 255;

  private apiKey: string;
  private http: DecisionHttp;
  private url: string;
  private model: string;

  constructor(
    apiKey: string | null = null,
    http: DecisionHttp | null = null,
    private confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR,
    // A gateway in front of OpenAI (DecisionKeyResolver url); '' = URL.
    url = '',
    model = ''
  ) {
    this.apiKey = apiKey ?? '';
    this.url = url.trim() !== '' ? url.trim() : OpenAIDecisionRouter.URL;
    this.model = model.trim() !== '' ? model.trim() : OpenAIDecisionRouter.MODEL;
    this.http = http ?? defaultDecisionHttp;
  }

  isAvailable(): boolean {
    return this.apiKey !== '';
  }

  async route(request: string, targets: DecisionTarget[], question: string): Promise<DecisionOutcome> {
    if (!this.isAvailable()) return blankOutcome('unavailable', 'no OpenAI key');
    const named = namedMenu(targets);
    if (typeof named === 'string') return blankOutcome('error', named);
    if (named.size + 1 > OpenAIDecisionRouter.MAX_CHOICES) {
      return blankOutcome('error', `a menu allows at most ${OpenAIDecisionRouter.MAX_CHOICES - 1} targets`);
    }

    const choices: Array<{ value: string; description: string }> = [];
    for (const [name, t] of named) choices.push({ value: name, description: choiceDescription(name, t) });
    choices.push({ value: UNCLEAR, description: UNCLEAR_DESC });

    const body = {
      model: this.model,
      input: request,
      questions: [{ type: 'choice', name: 'route', instructions: question, choices }],
    };

    const t0 = Date.now();
    let decoded: any;
    try {
      const res = await this.http(this.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status >= 400) return blankOutcome('error', OpenAIDecisionRouter.apiError(res.status, text));
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = null;
      }
    } catch (e: any) {
      return blankOutcome('error', String(e?.message ?? e));
    }
    const ms = Math.round(Date.now() - t0);

    let answer: any = null;
    for (const a of isObject(decoded) && Array.isArray(decoded.answers) ? decoded.answers : []) {
      if (isObject(a) && a.name === 'route') {
        answer = a;
        break;
      }
    }
    const usage = isObject(decoded) && isObject(decoded.usage) ? decoded.usage : {};
    if (isObject(answer) && answer.type === 'refusal') {
      return { ...blankOutcome('error', 'the model refused to answer'), ms, usage };
    }
    if (!isObject(answer) || answer.choice === undefined || answer.choice === null) {
      return { ...blankOutcome('error', 'no choice in the response'), ms, usage };
    }
    return choiceOutcome(answer, named, this.confidenceFloor, ms, usage);
  }

  /**
   * An HTTP error as OpenAI states it ("OpenAI HTTP 429 (insufficient_quota): You have no
   * credits..."), the whole message rather than a truncated dump.
   */
  private static apiError(status: number, body: string): string {
    let err: any = null;
    try {
      err = JSON.parse(body)?.error ?? null;
    } catch {
      err = null;
    }
    const out = 'OpenAI HTTP ' + status;
    if (!isObject(err) || Array.isArray(err)) return out;
    const code = String(err.code ?? err.type ?? '');
    const msg = String(err.message ?? '').trim();
    return out + (code !== '' ? ` (${code})` : '') + (msg !== '' ? `: ${msg}` : '');
  }
}
