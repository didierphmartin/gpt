import { sql } from 'kysely';
import { db } from '../db/pools';
import { CodeNodeEmit } from './CodeNodeEmit';

export type WatchServer = { url: string; headers: Record<string, string> };
export type WatchAnswer = { status: 'ready' | 'timeout'; via: any; events: any } | { status: 'error'; message: string };

/**
 * The event worker's call to a Start option's waiting tool: which server, the JSON-RPC request (the one
 * MCPToolsLoader sends), and what the answer means. A waiting tool answers
 * {"status": "ready"|"timeout", "via"?, "events"?}. Mirrors backend/src/AgentTeam/Services/WatchCall.php.
 */
export const WatchCall = {
  /** The user's enabled server named `name` (by slug, as code nodes match it); the user's own row wins over a global one. */
  async server(userId: number, name: string): Promise<WatchServer | null> {
    const rows = (await sql<any>`SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ${userId})`.execute(db)).rows;
    let found: any = null;
    for (const r of rows) {
      if (CodeNodeEmit.slug(String(r.name ?? '')) === CodeNodeEmit.slug(name) && (found === null || (r.user_id !== null && r.user_id !== undefined))) {
        found = r;
      }
    }
    if (found === null) return null;
    let headers: any = found.headers;
    if (typeof headers === 'string') {
      try {
        headers = JSON.parse(headers);
      } catch {
        headers = null;
      }
    }
    const out: Record<string, string> = {};
    if (headers !== null && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) out[k] = v === null || v === undefined || v === false ? '' : v === true ? '1' : String(v);
    }
    return { url: String(found.url), headers: out };
  },

  /** [url, header lines, body]: the stored URL as is, the stored headers, watch.tool with watch.args as stored. */
  request(server: WatchServer, watch: Record<string, any>, id: number): [string, string[], string] {
    const args = watch.args ?? [];
    const empty = Array.isArray(args) ? args.length === 0 : false;
    const body = JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: String(watch.tool ?? ''), arguments: empty ? {} : args },
    });
    const lines = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
    for (const [k, v] of Object.entries(server.headers)) lines.push(`${k}: ${v}`);
    return [server.url, lines, body];
  },

  answer(body: string | false, http: number, curlError: string): WatchAnswer {
    const error = (message: string): WatchAnswer => ({ status: 'error', message });
    if (body === false || curlError !== '') return error('unreachable');
    if (http >= 400) return error('http_' + http);
    const rpc = decode(lastData(body));
    if (rpc === null || typeof rpc !== 'object') return error('bad_answer');
    if (rpc.error !== undefined && rpc.error !== null) return error('rpc_error');
    const result = rpc.result ?? {};
    const payload = result?.structuredContent !== null && typeof result?.structuredContent === 'object'
      ? result.structuredContent
      : decode(String(result?.content?.[0]?.text ?? ''));
    if (payload === null || typeof payload !== 'object') return error('bad_answer');
    if (payload.error !== undefined && payload.error !== null) {
      const e = payload.error; // a string, or {code, message} (the ServiceNow connector)
      return error(e !== null && typeof e === 'object' ? String(e.code ?? 'tool_error') : String(e));
    }
    const status = payload.status ?? null;
    if (status !== 'ready' && status !== 'timeout') return error('bad_answer');
    return { status, via: payload.via ?? null, events: payload.events ?? null };
  },
};

function decode(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** A plain JSON body as is; an SSE body's last "data:" line. */
function lastData(body: string): string {
  const m = [...body.matchAll(/^data:\s?(.*)$/gm)];
  return m.length === 0 ? body : m[m.length - 1][1];
}
