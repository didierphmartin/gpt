/**
 * TypeScript port of `Services/McpTestRelay.php`.
 *
 * Carries ONE JSON-RPC message, unchanged, to an MCP server for the Test tab
 * and returns what came back. Transport errors are returned, never thrown.
 * JSON.parse keeps {} as {}, so the server's answer reaches the browser verbatim.
 */

const EXPOSED = ['content-type', 'mcp-session-id', 'mcp-protocol-version'] as const;

export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  body: string;
  error: string | null;
}

/** (url, header lines, body, timeout seconds) → reply */
export type RelayHttp = (url: string, headerLines: string[], body: string, timeoutS: number) => Promise<HttpReply>;

export interface RelayResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  messages: Record<string, unknown>[];
  duration_ms: number;
  error: string | null;
}

export class McpTestRelay {
  constructor(private readonly http: RelayHttp = McpTestRelay.send) {}

  /** An empty protocol version sends no mcp-protocol-version header. */
  async relay(
    url: string,
    headers: Record<string, string>,
    message: unknown,
    sessionId: string | null,
    protocolVersion: string,
  ): Promise<RelayResult> {
    const lines: string[] = [];
    const version = (protocolVersion ?? '').replace(/[\r\n]/g, '');
    if (version !== '') lines.push('mcp-protocol-version: ' + version);
    const sid = sessionId === null ? '' : sessionId.replace(/[\r\n]/g, '');
    if (sid !== '') lines.push('mcp-session-id: ' + sid);
    for (const [name, value] of Object.entries(headers)) lines.push(name + ': ' + value);

    const t0 = Date.now();
    let res: Partial<HttpReply>;
    try {
      res = await this.http(url, lines, JSON.stringify(message), 20);
    } catch (e: any) {
      res = { status: 0, headers: {}, body: '', error: String(e?.message ?? e) };
    }
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) resHeaders[k.toLowerCase()] = String(v);
    const body = String(res.body ?? '');
    return {
      url,
      status: Number(res.status ?? 0) || 0,
      headers: McpTestRelay.exposedHeaders(resHeaders),
      body,
      messages: McpTestRelay.parseMessages(resHeaders['content-type'] ?? '', body),
      duration_ms: Date.now() - t0,
      error: res.error ?? null,
    };
  }

  static parseMessages(contentType: string, body: string): Record<string, unknown>[] {
    if (!contentType.toLowerCase().includes('text/event-stream')) return McpTestRelay.messagesOf(body);
    const out: Record<string, unknown>[] = [];
    for (const event of body.replace(/\r\n|\r/g, '\n').split(/\n\n+/)) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ +/, ''));
      if (data.length > 0) out.push(...McpTestRelay.messagesOf(data.join('\n')));
    }
    return out;
  }

  /** One JSON text → its JSON-RPC message objects (a batch array gives several). */
  private static messagesOf(text: string): Record<string, unknown>[] {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return [];
    }
    const isObj = (m: unknown): m is Record<string, unknown> => m !== null && typeof m === 'object' && !Array.isArray(m);
    if (isObj(decoded)) return [decoded];
    return Array.isArray(decoded) ? decoded.filter(isObj) : [];
  }

  static exposedHeaders(headers: Record<string, string>): Record<string, string> {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const out: Record<string, string> = {};
    for (const name of EXPOSED) if (lower[name] !== undefined) out[name] = String(lower[name]);
    return out;
  }

  /** POST without following redirects; the curl() of the PHP relay. */
  static async send(url: string, headerLines: string[], body: string, timeoutS: number): Promise<HttpReply> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    for (const line of headerLines) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutS * 1000),
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
      return { status: res.status, headers: out, body: await res.text(), error: null };
    } catch (e: any) {
      const cause = e?.cause?.message ? ' (' + e.cause.message + ')' : '';
      return { status: 0, headers: {}, body: '', error: String(e?.message ?? e) + cause };
    }
  }
}
