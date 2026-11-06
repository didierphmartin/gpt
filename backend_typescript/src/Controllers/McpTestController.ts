import { sql } from 'kysely';
import { db } from '../db/pools';
import { McpEndpoint } from '../Services/McpEndpoint';
import { McpTestRelay } from '../Services/McpTestRelay';
import { Ctx, ControllerResult } from '../Support/Http';
import { requireAdmin } from './RequiresAdmin';

export interface StoredServer {
  url: string;
  headers: unknown;
  transport: string | null;
}

/** null userId = admin scope (any row). */
export type FindServer = (id: number, userId: string | null) => Promise<StoredServer | null>;

async function findServerInDb(id: number, userId: string | null): Promise<StoredServer | null> {
  const rows =
    userId === null
      ? await sql<StoredServer>`SELECT url, headers, transport FROM mcp_servers WHERE id = ${id}`.execute(db)
      : await sql<StoredServer>`SELECT url, headers, transport FROM mcp_servers WHERE id = ${id} AND (user_id IS NULL OR user_id = ${userId})`.execute(db);
  return rows.rows[0] ?? null;
}

/**
 * TypeScript port of `Controllers/McpTestController.php`.
 *
 * MCP Test tab: relays one JSON-RPC message to a server and returns the raw
 * outcome. Access rules live here (the relay does none): stored headers are
 * only ever sent to the stored server's URL (or its /mcp sibling) and are
 * never returned. JSON.parse keeps {} as {}, so ctx.body already carries the
 * message verbatim (PHP has to re-decode it from the raw body).
 */
export class McpTestController {
  constructor(
    private readonly relay: McpTestRelay = new McpTestRelay(),
    private readonly findServer: FindServer = findServerInDb,
    private readonly checkAdmin: (ctx: Ctx) => Promise<ControllerResult | null> = requireAdmin,
  ) {}

  /** POST /api/v1/mcp/test */
  async test(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id === null || ctx.user_id === undefined ? '' : String(ctx.user_id);
    if (userId === '') return fail('Authentication required', 401);
    return this.run(ctx, userId, false);
  }

  /** POST /api/v1/admin/mcp/test */
  async adminTest(ctx: Ctx): Promise<ControllerResult> {
    const err = await this.checkAdmin(ctx);
    if (err) return err;
    return this.run(ctx, null, true);
  }

  static endpointFor(url: string, transport: string, sibling: boolean): string | null {
    const found =
      transport === 'sse'
        ? (McpEndpoint.candidates(url, 'sse')[0] ?? null)
        : sibling
          ? (McpEndpoint.candidates(url, 'http')[1] ?? null)
          : url;
    return found === null ? null : McpEndpoint.internal(found);
  }

  private async run(ctx: Ctx, userId: string | null, admin: boolean): Promise<ControllerResult> {
    const input: Record<string, any> = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const message = input.message;
    if (message === null || typeof message !== 'object' || Object.keys(message).length === 0) {
      return fail('message is required', 400);
    }
    // Optional: initialize is sent before any version is negotiated.
    const version = typeof input.protocol_version === 'string' ? input.protocol_version : '';
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const sibling = !!input.sibling && input.sibling !== '0';
    let transport = (input.transport ?? 'http') === 'sse' ? 'sse' : 'http';

    let url: string;
    let headers: Record<string, string>;
    const serverId = input.server_id;
    if (serverId !== undefined && serverId !== null && serverId !== '') {
      const row = await this.findServer(Math.trunc(Number(serverId)) || 0, admin ? null : userId);
      if (!row) return fail('Unknown MCP server', 404);
      url = String(row.url);
      headers = McpEndpoint.decodeStoredHeaders(row.headers);
      transport = (row.transport ?? 'http') === 'sse' ? 'sse' : 'http';
      if (input.transport !== undefined) transport = input.transport === 'sse' ? 'sse' : 'http';
    } else if (admin) {
      return fail('server_id is required', 400);
    } else {
      if (typeof input.server_url !== 'string' || input.server_url === '') {
        return fail('server_id or server_url is required', 400);
      }
      url = input.server_url;
      headers = {};
      const given = input.headers;
      if (given && typeof given === 'object' && !Array.isArray(given)) {
        for (const [n, v] of Object.entries(given)) {
          if (n === '') continue;
          let s: string;
          if (typeof v === 'string' || typeof v === 'number') s = String(v);
          else if (typeof v === 'boolean') s = v ? '1' : '';
          else continue;
          headers[n.replace(/[\r\n:]/g, '')] = s.replace(/[\r\n]/g, '');
        }
      }
    }

    const endpoint = McpTestController.endpointFor(url, transport, sibling);
    if (endpoint === null) return fail('No sibling /mcp endpoint for this URL', 400);
    return { success: true, relay: await this.relay.relay(endpoint, headers, message, sessionId, version) };
  }
}

function fail(error: string, status: number): ControllerResult {
  return { success: false, error, status_code: status };
}
