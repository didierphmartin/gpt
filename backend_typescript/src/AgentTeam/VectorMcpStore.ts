/**
 * Faithful TypeScript mirror of src/AgentTeam/Services/VectorMcpStore.php.
 *
 * Read/write chunks to a registered vector-store MCP server (the LangChain
 * `mcp_qrant` server) through its provider-agnostic `store` / `find` tools. The
 * MCP call is injected as a `dispatch` callback so this stays testable and the
 * dispatch mechanism remains the single source of truth for how tools run.
 *
 * The injected dispatch returns the MCP `result` object — the mcp_qrant envelope
 * `{content:[{type:text,text:"<json>"}]}`. Tool-level errors ride INSIDE that
 * payload as `{error:true,code?,message}` (not as JSON-RPC isError), so we decode
 * content[0].text and check `error` ourselves.
 */

export type VectorMcpDispatch = (serverId: number, tool: string, args: any) => Promise<any>;

/** PHP trim() charset. */
const PHP_WS = ' \t\n\r\0\x0B';
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.indexOf(s[start]) !== -1) start++;
  while (end > start && PHP_WS.indexOf(s[end - 1]) !== -1) end--;
  return s.slice(start, end);
}

/** PHP (int) cast (leading-integer parse, default 0). */
function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP empty() for the value kinds we deal with. */
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === 0) return true;
  if (v === '') return true;
  if (v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

/** PHP is_array() over a json_decode(..,true) value: JS objects AND arrays qualify. */
function phpIsArray(v: any): boolean {
  return v !== null && typeof v === 'object';
}

/** PHP is_numeric() closely enough for a score. */
function phpIsNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return false;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

/** PHP (array) cast used for the `connection` argument (object/array pass through). */
function phpCastArray(v: any): any {
  if (v === null || v === undefined) return [];
  if (typeof v === 'object') return v;
  return [v];
}

export interface StoreResult {
  stored: number;
  errors: number;
  collection: string | null;
}

export interface FindResult {
  results: Array<{ text: string; metadata: any; score: number | null }>;
}

export class VectorMcpStore {
  private dispatch: VectorMcpDispatch;

  constructor(dispatch: VectorMcpDispatch) {
    this.dispatch = dispatch;
  }

  /**
   * Store all chunks for one file in a SINGLE `store` call. Blank chunks are
   * skipped; every stored chunk carries the same per-file metadata.
   */
  async store(serverId: number, chunks: any[], cfg: Record<string, any>): Promise<StoreResult> {
    const collection: string | null = cfg.collection ?? null;
    const metadata = phpIsArray(cfg.metadata ?? null) ? cfg.metadata : [];

    const items: Array<{ text: string; metadata: any }> = [];
    for (const chunk of chunks) {
      const text = String(chunk);
      if (phpTrim(text) === '') {
        continue;
      }
      items.push({ text, metadata });
    }
    if (items.length === 0) {
      return { stored: 0, errors: 0, collection };
    }

    const args: Record<string, any> = {
      provider: String(cfg.provider ?? ''),
      connection: phpCastArray(cfg.connection ?? []),
      collection: String(collection ?? ''),
      items,
    };
    const embedding = cfg.embedding ?? null;
    if (embedding !== null && embedding !== '') {
      args.embedding = String(embedding);
    }

    const payload = this.decode(await this.dispatch(serverId, 'store', args));
    if (!phpEmpty(payload.error)) {
      throw new Error(String(payload.message ?? 'store failed'));
    }
    // A valid store result MUST carry `stored`. Anything else (empty body, a
    // redirect/HTML page, a non-MCP response) is a transport/endpoint failure.
    if (!Object.prototype.hasOwnProperty.call(payload, 'stored')) {
      throw new Error(
        'store: the vector MCP returned no {stored} field — likely a transport/endpoint problem ' +
          '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
      );
    }
    return {
      stored: phpIntval(payload.stored ?? 0),
      errors: phpIntval(payload.errors ?? 0),
      collection,
    };
  }

  /**
   * Semantic search via `find`. Maps the payload's results to a normalized
   * shape; tolerates a missing/non-numeric score.
   */
  async find(serverId: number, query: string, cfg: Record<string, any>): Promise<FindResult> {
    const args: Record<string, any> = {
      provider: String(cfg.provider ?? ''),
      connection: phpCastArray(cfg.connection ?? []),
      collection: String(cfg.collection ?? ''),
      query,
      limit: phpIntval(cfg.limit ?? 5),
    };
    const embedding = cfg.embedding ?? null;
    if (embedding !== null && embedding !== '') {
      args.embedding = String(embedding);
    }

    const payload = this.decode(await this.dispatch(serverId, 'find', args));
    if (!phpEmpty(payload.error)) {
      throw new Error(String(payload.message ?? 'find failed'));
    }
    // A valid find result MUST carry `results`.
    if (!Object.prototype.hasOwnProperty.call(payload, 'results')) {
      throw new Error(
        'find: the vector MCP returned no {results} field — likely a transport/endpoint problem ' +
          '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
      );
    }
    const results: Array<{ text: string; metadata: any; score: number | null }> = [];
    const rawResults = phpCastArray(payload.results ?? []);
    const iterable = Array.isArray(rawResults) ? rawResults : Object.values(rawResults);
    for (const r of iterable) {
      if (!phpIsArray(r)) {
        continue;
      }
      results.push({
        text: String(r.text ?? ''),
        metadata: phpIsArray(r.metadata ?? null) ? r.metadata : [],
        score: r.score !== undefined && r.score !== null && phpIsNumeric(r.score) ? Number(r.score) : null,
      });
    }
    return { results };
  }

  /**
   * Decode the mcp_qrant envelope: pull content[0].text and json-decode it to the
   * payload. A transport/tool error already normalized to {error:true,...} passes
   * through unchanged. If there's no envelope, the input is returned as-is.
   */
  private decode(res: any): any {
    if (res && !phpEmpty(res.error)) {
      return res;
    }
    const text = res && res.content && res.content[0] ? res.content[0].text : undefined;
    if (typeof text === 'string') {
      try {
        const decoded = JSON.parse(text);
        if (phpIsArray(decoded)) {
          return decoded;
        }
      } catch {
        /* fall through */
      }
    }
    return res;
  }
}
