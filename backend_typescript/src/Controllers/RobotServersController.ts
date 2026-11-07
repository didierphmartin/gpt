import { sql } from 'kysely';
import { config } from '../config/env';
import { db } from '../db/pools';
import { CodeNodeEmit } from '../AgentTeam/CodeNodeEmit';
import { EditionConfig } from '../Services/Edition';
import { RobotAccount } from '../Services/RobotAccount';
import { RobotPolicy } from '../Services/RobotPolicy';
import { Ctx, ControllerResult } from '../Support/Http';
import { filterValidateUrl } from '../Support/PhpUrl';
import { MCPProxyController } from './MCPProxyController';

/**
 * Mirrors src/Controllers/RobotServersController.php: /api/v1/robot/mcp-servers — the robot account's own MCP
 * server rows (e.g. an "Outlook" row holding an organization connection key). Every route needs use_robot and acts
 * only on rows owned by the robot. Header values are secrets: responses carry header NAMES only -- except
 * compile-env, which hands them to a compiled robot workflow's .env (the person compiling may use the robot).
 */
export class RobotServersController {
  private readonly proxyFactory: () => Pick<MCPProxyController, 'forward'>;

  constructor(
    private readonly cfg: EditionConfig = config,
    proxyFactory?: () => Pick<MCPProxyController, 'forward'>,
    private readonly policyFactory: () => Pick<RobotPolicy, 'canUse'> = () => new RobotPolicy(cfg)
  ) {
    this.proxyFactory = proxyFactory ?? (() => new MCPProxyController());
  }

  async index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const rows = (
        await sql<any>`SELECT id, name, url, description, enabled, headers FROM mcp_servers WHERE user_id = ${String(robot)} ORDER BY name`.execute(db)
      ).rows;
      return {
        success: true,
        data: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          url: r.url,
          description: String(r.description ?? ''),
          enabled: !!Number(r.enabled),
          header_names: Object.keys(headersOf(r.headers)).map(String),
        })),
      };
    });
  }

  /**
   * GET /robot/mcp-servers/compile-env — {vars: {MCP_HEADERS_<SLUG>: headers JSON}} of the robot's enabled servers that
   * hold headers: what the interpreter sends when the robot runs, for the package .env of a compiled robot workflow.
   * The values are never logged.
   */
  async compileEnv(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const rows = (
        await sql<any>`SELECT name, headers FROM mcp_servers WHERE user_id = ${String(robot)} AND enabled = 1 ORDER BY name`.execute(db)
      ).rows;
      const vars: Record<string, string> = {};
      for (const r of rows) {
        const h = headersOf(r.headers);
        if (Object.keys(h).length > 0) vars['MCP_HEADERS_' + CodeNodeEmit.slug(String(r.name)).toUpperCase()] = JSON.stringify(h);
      }
      return { success: true, data: { vars: Object.keys(vars).length ? vars : [] } };
    });
  }

  async create(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const b = ctx.body ?? {};
      const name = str(b.name).trim();
      const url = str(b.url).trim();
      if (name === '' || !filterValidateUrl(url)) return fail('Name and a valid URL are required', 400);
      if ((await this.row(robot, null, name)) !== null) return fail('A server with this name already exists', 409);
      const res = await sql`INSERT INTO mcp_servers (user_id, name, url, description) VALUES (${String(robot)}, ${name}, ${url}, ${str(b.description).trim()})`.execute(db);
      return { success: true, data: { id: Number(res.insertId) } };
    });
  }

  async update(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const id = this.id(ctx);
      const row = await this.row(robot, id);
      if (row === null) return notFound();
      const b = ctx.body ?? {};
      const set: any[] = [];
      for (const f of ['name', 'url', 'description']) {
        if (typeof b[f] !== 'string') continue;
        const v = b[f].trim();
        if (f === 'url' && !filterValidateUrl(v)) return fail('Invalid URL format', 400);
        if (f === 'name' && v !== row.name && (await this.row(robot, null, v)) !== null) {
          return fail('A server with this name already exists', 409);
        }
        // the stored key must never travel to a different host: re-Connect is required
        if (f === 'url' && v !== row.url) set.push(sql`headers = NULL`);
        set.push(sql`${sql.ref(f)} = ${v}`);
      }
      if (Object.prototype.hasOwnProperty.call(b, 'enabled')) set.push(sql`enabled = ${b.enabled ? 1 : 0}`);
      if (set.length) {
        await sql`UPDATE mcp_servers SET ${sql.join(set)} WHERE id = ${id} AND user_id = ${String(robot)}`.execute(db);
      }
      return { success: true };
    });
  }

  async destroy(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const id = this.id(ctx);
      if ((await this.row(robot, id)) === null) return notFound();
      await sql`DELETE FROM mcp_servers WHERE id = ${id} AND user_id = ${String(robot)}`.execute(db);
      return { success: true };
    });
  }

  /** POST .../:id/call {tool, arguments}: a tools/call through the /mcp/proxy path, with the row's stored headers. */
  async call(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const id = this.id(ctx);
      const row = await this.row(robot, id);
      if (row === null) return notFound();
      if (!Number(row.enabled)) return fail('Server is disabled', 409);
      const b = ctx.body ?? {};
      if (typeof b.tool !== 'string' || b.tool === '') return fail('tool is required', 400);
      const r: any = await this.proxyFactory().forward({
        ...ctx,
        user_id: robot,
        body: {
          action: 'proxy',
          server_id: id,
          server_url: row.url,
          jsonrpc: { method: 'tools/call', params: { name: b.tool, arguments: b.arguments ?? [] } },
        },
      });
      if (!(r?.success ?? false)) {
        return { success: false, error: r?.error?.message ?? 'MCP call failed', status_code: r?.status_code ?? 500 };
      }
      return { success: true, data: r.response };
    });
  }

  /** POST .../:id/key {header, key}: merges {header: key} into the row's headers (the Connect box's save step). */
  async saveKey(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (robot) => {
      const id = this.id(ctx);
      const row = await this.row(robot, id);
      if (row === null) return notFound();
      const b = ctx.body ?? {};
      const name = str(b.header).trim();
      const key = str(b.key);
      if (name === '' || /[\r\n:\s]/.test(name) || key === '' || /[\r\n]/.test(key)) {
        return fail('A header name and a key are required', 400);
      }
      const headers = headersOf(row.headers);
      headers[name] = key;
      await sql`UPDATE mcp_servers SET headers = ${JSON.stringify(headers)} WHERE id = ${id} AND user_id = ${String(robot)}`.execute(db);
      return { success: true, data: { header_names: Object.keys(headers).map(String) } };
    });
  }

  private id(ctx: Ctx): number {
    return parseInt(String(ctx.params?.id ?? 0), 10) || 0;
  }

  /** The robot's row by id or by name, else null. */
  private async row(robot: number, id: number | null, name: string | null = null): Promise<any | null> {
    const r =
      id !== null
        ? await sql<any>`SELECT * FROM mcp_servers WHERE id = ${id} AND user_id = ${String(robot)}`.execute(db)
        : await sql<any>`SELECT * FROM mcp_servers WHERE name = ${name} AND user_id = ${String(robot)}`.execute(db);
    return r.rows[0] ?? null;
  }

  private async guard(ctx: Ctx, action: (robot: number) => Promise<ControllerResult>): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0) || 0;
    if (userId <= 0) return { success: false, error: 'Authentication required', kind: 'auth', status_code: 401 };
    if (!(await this.policyFactory().canUse(userId))) {
      return { success: false, error: "Your role can't use the robot", kind: 'forbidden', status_code: 403 };
    }
    return action(await RobotAccount.ensure());
  }
}

function str(v: any): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** The stored headers JSON as an object ({} for anything else). */
function headersOf(json: any): Record<string, any> {
  let h: any = json;
  if (typeof json === 'string') {
    if (json === '') return {};
    try {
      h = JSON.parse(json);
    } catch {
      return {};
    }
  }
  return h !== null && typeof h === 'object' ? { ...h } : {};
}

function fail(msg: string, status: number): ControllerResult {
  return { success: false, error: msg, status_code: status };
}

function notFound(): ControllerResult {
  return fail('Server not found', 404);
}
