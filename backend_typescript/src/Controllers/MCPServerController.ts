import { sql } from 'kysely';
import { db } from '../db/pools';
import { PackageResolver } from '../Services/PackageResolver';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/MCPServerController.php — user-facing MCP server management.
 * Effectiveness cascade (mirrors isServerEffective): per-user override (user_mcp_overrides) wins;
 * else private servers (user_id set) are always allowed; else global servers are gated by the
 * package's MCP allowlist (PackageResolver.allowedMcpServers — null = unrestricted). Fail-open on error.
 */
export class MCPServerController {
  private resolveUserId(ctx: Ctx): string {
    const q = (ctx.query as any)?.user_id;
    if (q !== undefined && q !== null && String(q) !== '') return String(q);
    if (ctx.user_id != null) return String(ctx.user_id);
    return '';
  }

  private async loadOverrides(userId: string): Promise<Map<number, boolean>> {
    const m = new Map<number, boolean>();
    if (/^\d+$/.test(userId)) {
      const ov = await db.selectFrom('user_mcp_overrides').select(['server_id', 'allowed']).where('user_id', '=', Number(userId)).execute();
      for (const o of ov) m.set(Number(o.server_id), Boolean(o.allowed));
    }
    return m;
  }

  /** The package's MCP allowlist (server names) for this user, or null when unrestricted. Fail-open. */
  private async allowList(userId: string): Promise<string[] | null> {
    try {
      const userIdInt = /^\d+$/.test(userId) ? Number(userId) : null;
      return await new PackageResolver().allowedMcpServers(userIdInt);
    } catch {
      return null; // fail open (unrestricted)
    }
  }

  /** Cascade: per-user override > private-always > package allowlist (null = unrestricted). */
  private isEffective(serverId: number, serverUserId: any, serverName: any, overrides: Map<number, boolean>, allow: string[] | null): boolean {
    if (overrides.has(serverId)) return overrides.get(serverId)!;
    const isPrivate = serverUserId !== null && serverUserId !== undefined;
    if (isPrivate) return true;
    if (allow === null) return true;
    return typeof serverName === 'string' && allow.includes(serverName);
  }

  private isValidUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return !!u.protocol;
    } catch {
      return false;
    }
  }

  /** GET /api/v1/mcp/servers */
  async list(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.resolveUserId(ctx);
    const hasUser = userId !== '';
    let q = db
      .selectFrom('mcp_servers as s')
      .leftJoin('mcp_server_tools as t', 't.server_id', 's.id')
      .selectAll('s')
      .select((eb) => [eb.fn.count('t.id').as('tool_count'), sql<number>`SUM(CASE WHEN t.has_ui = 1 THEN 1 ELSE 0 END)`.as('ui_tool_count')])
      .where('s.enabled', '=', 1);
    q = hasUser ? q.where((eb) => eb.or([eb('s.user_id', 'is', null), eb('s.user_id', '=', userId)])) : q.where('s.user_id', 'is', null);
    const rows = (await q.groupBy('s.id').orderBy('s.name').execute()) as any[];

    const overrides = await this.loadOverrides(userId);
    const allow = await this.allowList(userId);
    const servers = rows.filter((r) => this.isEffective(Number(r.id), r.user_id, r.name, overrides, allow));
    return { success: true, servers };
  }

  /** GET /api/v1/mcp/servers/tools?server_id= */
  async getTools(ctx: Ctx): Promise<ControllerResult> {
    const serverId = (ctx.query as any)?.server_id;
    if (!serverId) return { success: true, tools: [] };
    const userId = this.resolveUserId(ctx);
    const hasUser = userId !== '';

    let q = db.selectFrom('mcp_servers').select(['id', 'name', 'user_id']).where('id', '=', Number(serverId)).where('enabled', '=', 1);
    q = hasUser ? q.where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', userId)])) : q.where('user_id', 'is', null);
    const row = await q.executeTakeFirst();
    if (!row) return { status_code: 404, success: false, error: 'Server not found' };

    const overrides = await this.loadOverrides(userId);
    const allow = await this.allowList(userId);
    if (!this.isEffective(Number(row.id), row.user_id, row.name, overrides, allow)) return { status_code: 404, success: false, error: 'Server not found' };

    const tools = await db.selectFrom('mcp_server_tools').selectAll().where('server_id', '=', Number(serverId)).orderBy('tool_name').execute();
    return { success: true, tools };
  }

  /** GET /api/v1/mcp/servers/all-tools */
  async getAllTools(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.resolveUserId(ctx);
    const hasUser = userId !== '';
    let q = db
      .selectFrom('mcp_server_tools as t')
      .innerJoin('mcp_servers as s', 's.id', 't.server_id')
      .selectAll('t')
      .select(['s.name as server_name', 's.url as server_url', 's.user_id as server_user_id'])
      .where('s.enabled', '=', 1);
    q = hasUser ? q.where((eb) => eb.or([eb('s.user_id', 'is', null), eb('s.user_id', '=', userId)])) : q.where('s.user_id', 'is', null);
    const rows = (await q.orderBy('s.name').orderBy('t.tool_name').execute()) as any[];

    const overrides = await this.loadOverrides(userId);
    const allow = await this.allowList(userId);
    const tools = rows.filter((t) => this.isEffective(Number(t.server_id), t.server_user_id, t.server_name, overrides, allow));
    return { success: true, tools };
  }

  /** POST /api/v1/mcp/servers */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body;
    const userId = input.user_id ?? (ctx.user_id != null ? String(ctx.user_id) : 'demo-user');
    const name = String(input.name ?? '').trim();
    const url = String(input.url ?? '').trim();
    const description = String(input.description ?? '').trim();
    const headers = input.headers ?? null;
    const headersJson = headers && typeof headers === 'object' && Object.keys(headers).length ? JSON.stringify(headers) : null;

    if (!name || !url) return { status_code: 400, success: false, error: 'Name and URL are required' };
    if (!this.isValidUrl(url)) return { status_code: 400, success: false, error: 'Invalid URL format' };

    try {
      const res = await db
        .insertInto('mcp_servers')
        .values({ user_id: String(userId), name, url, description, headers: headersJson } as any)
        .executeTakeFirst();
      return { success: true, server_id: String(res.insertId), message: 'Server added successfully' };
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        return { status_code: 409, success: false, error: 'A server with this name already exists' };
      }
      throw e;
    }
  }

  /** POST /api/v1/mcp/servers/update */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body;
    const userId = input.user_id ?? (ctx.user_id != null ? String(ctx.user_id) : 'demo-user');
    const serverId = input.server_id ?? null;
    const name = String(input.name ?? '').trim();
    const url = String(input.url ?? '').trim();
    const description = String(input.description ?? '').trim();

    if (!serverId) return { status_code: 400, success: false, error: 'Server ID required' };
    if (!name || !url) return { status_code: 400, success: false, error: 'Name and URL are required' };

    const res = await db
      .updateTable('mcp_servers')
      .set({ name, url, description })
      .where('id', '=', Number(serverId))
      .where('user_id', '=', String(userId))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return { status_code: 404, success: false, error: 'Server not found' };

    // Clear cached tools when the server changes.
    await db.deleteFrom('mcp_server_tools').where('server_id', '=', Number(serverId)).execute();
    return { success: true, message: 'Server updated successfully' };
  }

  /** POST /api/v1/mcp/servers/toggle */
  async toggle(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body;
    const userId = input.user_id ?? (ctx.user_id != null ? String(ctx.user_id) : 'demo-user');
    const serverId = input.server_id ?? null;
    const enabled = input.enabled ?? true;

    if (!serverId) return { status_code: 400, success: false, error: 'Server ID required' };

    await db.updateTable('mcp_servers').set({ enabled: enabled ? 1 : 0 }).where('id', '=', Number(serverId)).where('user_id', '=', String(userId)).execute();
    return { success: true, message: enabled ? 'Server enabled' : 'Server disabled' };
  }

  /** DELETE /api/v1/mcp/servers?server_id= */
  async delete(ctx: Ctx): Promise<ControllerResult> {
    const serverId = (ctx.query as any)?.server_id ?? null;
    const userId = (ctx.query as any)?.user_id ?? (ctx.user_id != null ? String(ctx.user_id) : 'demo-user');

    if (!serverId) return { status_code: 400, success: false, error: 'Server ID required' };

    const res = await db.deleteFrom('mcp_servers').where('id', '=', Number(serverId)).where('user_id', '=', String(userId)).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return { status_code: 404, success: false, error: 'Server not found' };
    return { success: true, message: 'Server deleted successfully' };
  }
}
