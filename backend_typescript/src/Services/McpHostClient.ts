/**
 * Mirrors src/Services/McpHostClient.php: talks to the Docker app's server supervisor (docker/mcps) with the
 * shared Bearer token. Bodies carry server secrets, so nothing here logs a request or a response.
 */

/** (method, url, header lines, body) => [status, body text]; status 0 = unreachable. */
export type McpHostTransport = (method: string, url: string, headers: string[], body: string | null) => Promise<[number, string]>;

export type McpHostReply = { status: number; body: any };

export class McpHostClient {
  private readonly transport: McpHostTransport;

  constructor(private readonly baseUrl: string, private readonly token: string, transport?: McpHostTransport) {
    this.transport = transport ?? McpHostClient.http;
  }

  async request(method: string, path: string, body: Record<string, any> | any[] | null = null): Promise<McpHostReply> {
    const headers = ['Authorization: Bearer ' + this.token, 'Accept: application/json'];
    let payload: string | null = null;
    if (body !== null) {
      headers.push('Content-Type: application/json');
      payload = JSON.stringify(body);
    }
    let status: number;
    let text: string;
    try {
      [status, text] = await this.transport(method, this.baseUrl.replace(/\/+$/, '') + path, headers, payload);
    } catch {
      return { status: 503, body: { error: 'unreachable' } };
    }
    if (status < 100) return { status: 503, body: { error: 'unreachable' } };
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(String(text));
    } catch {
      decoded = null;
    }
    return { status, body: decoded !== null && typeof decoded === 'object' ? decoded : [] };
  }

  /**
   * Seconds to wait for the supervisor: install can run for minutes (dependency downloads); a call that
   * stops a server (restart, enabled, delete, settings save) waits out its 10 s stop grace; the rest is quick.
   */
  static timeoutFor(method: string, url: string): number {
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      path = '';
    }
    if (path.endsWith('/install')) return 900;
    if (method === 'DELETE' || path.endsWith('/restart') || path.endsWith('/enabled') || (method === 'PUT' && path.endsWith('/settings'))) {
      return 30;
    }
    return 15;
  }

  private static async http(method: string, url: string, headers: string[], body: string | null): Promise<[number, string]> {
    const hdrs: Record<string, string> = {};
    for (const line of headers) {
      const i = line.indexOf(':');
      if (i > 0) hdrs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    try {
      const r = await fetch(url, {
        method,
        headers: hdrs,
        body: body ?? undefined,
        signal: AbortSignal.timeout(McpHostClient.timeoutFor(method, url) * 1000),
      });
      return [r.status, await r.text()];
    } catch {
      return [0, ''];
    }
  }
}
