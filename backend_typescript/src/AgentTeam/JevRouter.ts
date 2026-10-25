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
 * Routing decisions from TypeSafe AI's Jev, for dispatcher nodes — the `typesafe` protocol adapter.
 * Mirrors backend/src/AgentTeam/Services/JevRouter.php (see its docblock for why a System One model
 * routes a dispatcher, and why the `unclear` option is load-bearing).
 *
 * The key comes from DecisionKeyResolver and is passed in; this class never reads the environment.
 */
export class JevRouter implements DecisionRouter {
  /** POST target. Captured from typesafe-sdk 0.7.2 rather than inferred. */
  static readonly URL = 'https://api.typesafe.ai/v1/systemone';
  /** Pinned by name, not by version: the API resolves it. */
  static readonly MODEL = 'jev-latest';
  static readonly UNCLEAR = UNCLEAR;
  static readonly DEFAULT_CONFIDENCE_FLOOR = DEFAULT_CONFIDENCE_FLOOR;

  private apiKey: string;
  private http: DecisionHttp;
  private url: string;
  private model: string;

  constructor(
    apiKey: string | null = null,
    http: DecisionHttp | null = null,
    private confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR,
    // A gateway in front of TypeSafe (DecisionKeyResolver url); '' = URL.
    url = '',
    model = ''
  ) {
    // null = not configured. .env TYPESAFE_API_KEY is deliberately NOT read, or it would bypass the
    // per-user/global precedence.
    this.apiKey = apiKey ?? '';
    this.url = url.trim() !== '' ? url.trim() : JevRouter.URL;
    this.model = model.trim() !== '' ? model.trim() : JevRouter.MODEL;
    this.http = http ?? defaultDecisionHttp;
  }

  /** Configured = a key is present. */
  isAvailable(): boolean {
    return this.apiKey !== '';
  }

  /**
   * Choose one target for `request`, or say why not. `question` is what the dispatcher is
   * deciding — the node's own prompt.
   */
  async route(request: string, targets: DecisionTarget[], question: string): Promise<DecisionOutcome> {
    if (!this.isAvailable()) return blankOutcome('unavailable', 'no Jev key');
    const named = namedMenu(targets);
    if (typeof named === 'string') return blankOutcome('error', named);

    const criteria: Record<string, string> = {};
    for (const [name, t] of named) criteria[name] = choiceDescription(name, t);
    criteria[UNCLEAR] = UNCLEAR_DESC;

    const body = {
      state: { request },
      model: this.model,
      questions: { route: { type: 'choice', instructions: question, criteria } },
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
      if (res.status >= 400) {
        // Guzzle throws on an HTTP error status; the reason is its message.
        return blankOutcome('error', guzzleMessage(this.url, res.status, res.statusText ?? '', text));
      }
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = null;
      }
    } catch (e: any) {
      return blankOutcome('error', String(e?.message ?? e));
    }
    const ms = Math.round(Date.now() - t0);

    const answer = isObject(decoded) && isObject(decoded.answers) ? decoded.answers.route ?? null : null;
    const usage = isObject(decoded) && isObject(decoded.usage) ? decoded.usage : {};
    if (!isObject(answer) || answer.choice === undefined || answer.choice === null) {
      // Answered, so it keeps its time and usage (both are recorded).
      return { ...blankOutcome('error', 'no choice in the response'), ms, usage };
    }
    return choiceOutcome(answer, named, this.confidenceFloor, ms, usage);
  }
}

/**
 * Guzzle's RequestException message for an HTTP error ("Client error: `POST url` resulted in a
 * `401 Unauthorized` response:\n<body, cut at 120 bytes>"), which is the reason PHP reports.
 */
export function guzzleMessage(url: string, status: number, statusText: string, body: string): string {
  const label = status >= 500 ? 'Server error' : 'Client error';
  let summary = body;
  if (Buffer.byteLength(summary, 'utf8') > 120) {
    summary = Buffer.from(summary, 'utf8').subarray(0, 120).toString('utf8') + ' (truncated...)';
  }
  return `${label}: \`POST ${url}\` resulted in a \`${status} ${statusText}\` response` + (summary !== '' ? `:\n${summary}\n` : '');
}
