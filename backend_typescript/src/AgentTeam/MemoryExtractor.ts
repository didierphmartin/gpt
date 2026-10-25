/**
 * Mirrors src/AgentTeam/Services/MemoryExtractor.php: decides whether anything from a chat turn is
 * worth saving as durable memory (one non-streaming Claude call), filters paraphrased duplicates,
 * and compacts a block that outgrew its budget. Every failure answers "no update" (null / the
 * input), never an error.
 */
export interface Extraction {
  memory_additions: string[];
  user_additions: string[];
  reason: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 512;
const TIMEOUT_MS = 30_000;

const mbSubstr = (s: string, start: number, len?: number) => {
  const cp = [...s];
  return (len === undefined ? cp.slice(start) : cp.slice(start, start + len)).join('');
};
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

/** preg_replace('/^```(?:json)?\s*|\s*```$/m', '', $text) then trim. */
function stripFences(text: string): string {
  return phpTrim(text.replace(/^```(?:json)?\s*|\s*```$/gm, ''));
}

export class MemoryExtractor {
  private readonly endpoint: string;

  /** baseUrl / chatEndpoint: the resolved Claude config (a gateway when configured). */
  constructor(private readonly apiKey: string, baseUrl = '', chatEndpoint = '') {
    this.endpoint = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + (chatEndpoint || '/v1/messages');
  }

  /** One Messages API call; the first text block, or null when the call fails. */
  private async call(model: string, maxTokens: number, system: string, userContent: string, label: string): Promise<string | null> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`); // Guzzle http_errors
      let body: any = null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = null;
      }
      return String(body?.content?.[0]?.text ?? '');
    } catch (e: any) {
      console.error(`[MemoryExtractor] ${label} failed: ` + (e?.message ?? e));
      return null;
    }
  }

  async extract(model: string, currentMemory: string, currentUser: string, lastUserMsg: string, lastAssistantMsg: string): Promise<Extraction | null> {
    if (this.apiKey === '') return null;
    const text = await this.call(model, MAX_TOKENS, MemoryExtractor.systemPrompt(),
      MemoryExtractor.userContent(currentMemory, currentUser, lastUserMsg, lastAssistantMsg), 'API call');
    if (!text) return null;
    return MemoryExtractor.parseJson(text);
  }

  /**
   * Second-stage semantic guard: drops candidate additions the existing content already covers
   * (paraphrase, subset). Returns the input unchanged when the check cannot run.
   */
  async filterDuplicates(model: string, currentContent: string, additions: string[]): Promise<string[]> {
    if (this.apiKey === '' || !additions.length || phpTrim(currentContent) === '') return additions;
    const system = 'You decide which candidate facts are genuinely new vs. already covered by existing memory. '
      + 'A candidate is ALREADY COVERED if the existing memory states it — even using different words, '
      + 'even as a subset, even as a near-paraphrase, even if the existing line is more general. '
      + 'Default to COVERED when in doubt. Respond with ONLY a JSON array of the 0-based indices of '
      + 'candidates that are GENUINELY NEW (not covered). Example: [0, 2] means candidates 0 and 2 are new. '
      + 'Empty array means none are new.';
    const candidateLines = additions.map((a, i) => `[${i}] ` + a);
    const userContent = `EXISTING MEMORY:\n${currentContent}\n\nCANDIDATES:\n` + candidateLines.join('\n');

    const raw = await this.call(model, 128, system, userContent, 'filterDuplicates call');
    if (raw === null) return additions;
    let text = phpTrim(raw);
    if (text === '') return additions;
    if (text.startsWith('```')) text = stripFences(text);
    const m = /\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]/.exec(text);
    if (m) text = m[0];
    let indices: any;
    try {
      indices = JSON.parse(text);
    } catch {
      indices = null;
    }
    if (indices === null || typeof indices !== 'object') {
      console.error('[MemoryExtractor] filterDuplicates non-JSON: ' + mbSubstr(text, 0, 200));
      return additions;
    }
    const kept: string[] = [];
    for (const i of Object.values(indices)) {
      if (Number.isInteger(i) && (i as number) >= 0 && (i as number) < additions.length) kept.push(additions[i as number]);
    }
    return kept;
  }

  /** Compacts content to fit the budget, keeping mustKeep verbatim; null on failure. */
  async compact(model: string, content: string, budget: number, mustKeep: string[] = []): Promise<string | null> {
    if (this.apiKey === '' || content === '') return null;
    const system = `You are a memory compactor. Rewrite the given memory block so it fits within ${budget} characters. `
      + 'Preserve facts in the REQUIRED section verbatim. Drop the oldest or least-useful lines from the EXISTING section to make room. '
      + 'Merge duplicate or near-duplicate lines. Output ONLY the compacted text, no preamble, no quotes, no markdown fences.';
    const required = mustKeep.length ? mustKeep.join('\n') : '(none)';
    const userContent = `REQUIRED (keep verbatim):\n${required}\n\nEXISTING (may be trimmed):\n${content}`;
    const raw = await this.call(model, Math.ceil(budget / 2), system, userContent, 'compact call');
    if (raw === null) return null;
    let text = phpTrim(raw);
    if (text === '') return null;
    if ([...text].length > budget) text = mbSubstr(text, 0, budget);
    return text;
  }

  static userContent(currentMemory: string, currentUser: string, lastUserMsg: string, lastAssistantMsg: string): string {
    return `=== CURRENT MEMORY ===
${currentMemory !== '' ? currentMemory : '(empty)'}

=== CURRENT USER ===
${currentUser !== '' ? currentUser : '(empty)'}

=== LAST USER MESSAGE ===
${mbSubstr(lastUserMsg, 0, 4000)}

=== LAST ASSISTANT REPLY ===
${mbSubstr(lastAssistantMsg, 0, 4000)}`;
  }

  static parseJson(raw: string): Extraction | null {
    let text = phpTrim(raw);
    if (text.startsWith('```')) text = stripFences(text);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (data === null || typeof data !== 'object') {
      console.error('[MemoryExtractor] non-JSON response: ' + mbSubstr(text, 0, 200));
      return null;
    }
    const list = (v: any): string[] => {
      const arr = v === null || v === undefined ? [] : typeof v === 'object' ? Object.values(v) : [v];
      return arr.filter((x): x is string => typeof x === 'string' && phpTrim(x) !== '');
    };
    const reason = typeof data.reason === 'string' ? data.reason : '';
    return { memory_additions: list(data.memory_additions), user_additions: list(data.user_additions), reason: mbSubstr(reason, 0, 255) };
  }

  static systemPrompt(): string {
    return `You are a memory curator for a long-running conversational assistant.

After each turn, you decide whether anything in the user's message or the assistant's reply is worth saving as durable memory for future conversations.

Two scopes exist:

USER — **anything about the person themselves**:
  - role, profession, expertise, areas of study
  - personal biographical facts: age, location, timezone, languages spoken, family status, life circumstances
  - hobbies, lifestyle, physical activities, habits
  - communication preferences, persistent likes/dislikes
  - tools they personally prefer to use
  Rule of thumb: if it describes WHO the user is or how they live, it goes here.

MEMORY — **facts about the user's projects, work, or environment**:
  - codebases, tech stack, conventions, tools in use on a specific project
  - ongoing work, milestones, decisions, constraints
  - systems, services, or data they reference
  - domain-specific facts relevant to their professional work
  Rule of thumb: if it describes WHAT the user is working on or the environment they operate in, it goes here.

When a fact could arguably fit both (e.g. "I'm a cardiology resident" — profession AND work context), prefer USER.
Never put biographical facts (age, location, hobbies, lifestyle, languages, family) into MEMORY.

**IMPORTANT**: classify each new fact by its nature, NOT by imitating where similar facts appear in the existing blocks. Previous turns may have misclassified items — do not perpetuate those mistakes. A biographical fact always goes to USER, even if the current MEMORY block already contains biographical lines.

Rules:
- Save only facts that are non-obvious AND likely useful across future conversations.
- **Aggressive duplicate rejection**: before adding anything, read the CURRENT MEMORY and CURRENT USER blocks line by line. If the new fact is already stated there — even in different words, even as a subset, even as a near-paraphrase — DO NOT propose it. When in doubt, omit.
  Examples of what counts as duplicate:
    existing: "User is a polymath interested in biomedical and computer science topics"
    proposed: "User has research interests across health and CS" → DUPLICATE, reject
    existing: "User prefers concise answers without hedging"
    proposed: "User likes direct replies, no fillers" → DUPLICATE, reject
- Skip transient task details ("I'm about to run X", "the error said Y") — those belong in the conversation, not memory.
- Each addition is a short single-line statement, no bullets, no preamble.
- If nothing genuinely new is worth saving, return empty arrays. That is the normal, expected outcome for most turns.

Respond with ONLY a JSON object, no markdown fences, no prose:
{
  "memory_additions": ["short fact 1", "short fact 2"],
  "user_additions":   ["short preference 1"],
  "reason": "one short phrase explaining what you saved, or 'nothing worth saving'"
}`;
  }
}
