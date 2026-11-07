import { config } from '../config/env';
import { Edition, EditionConfig } from '../Services/Edition';
import { McpHostClient } from '../Services/McpHostClient';
import { Ctx, ControllerResult } from '../Support/Http';
import { requireAdmin } from './RequiresAdmin';

/**
 * Mirrors src/Controllers/McpHostController.php: /api/v1/mcp/host relays signed-in users to the Docker app's
 * server supervisor. A server is its installer's; admins may act on any. In the corporate edition only admins
 * install; in the individual edition the container is the user's, so anyone signed in may. The supervisor's
 * status and body pass through unchanged, except 503 (unreachable) and the log tail, which only the owner (or an
 * admin) sees. The token and request bodies are never logged or returned.
 */
export class McpHostController {
  private readonly clientFactory: () => McpHostClient;

  constructor(private readonly cfg: EditionConfig = config, clientFactory?: () => McpHostClient) {
    this.clientFactory = clientFactory ?? (() => new McpHostClient(process.env.MCPS_URL ?? '', process.env.MCPS_TOKEN ?? ''));
  }

  private static available(): boolean {
    return !!process.env.MCPS_URL;
  }

  async info(_ctx: Ctx): Promise<ControllerResult> {
    if (!McpHostController.available()) return { success: true, data: { available: false } };
    return { success: true, data: { available: true, gateway: process.env.MCPS_PUBLIC_GATEWAY ?? '' } };
  }

  async list(ctx: Ctx): Promise<ControllerResult> {
    if (!McpHostController.available()) return McpHostController.none();
    const r = await this.clientFactory().request('GET', '/servers');
    if (r.status !== 200) return McpHostController.out(r);
    const admin = await this.isAdmin(ctx);
    const uid = Number(ctx.user_id);
    const rows: any[] = [];
    for (const s of Object.values(r.body ?? {}) as any[]) {
      if (!admin && Number(s?.installed_by ?? 0) !== uid && s && typeof s === 'object') {
        const { log: _log, ...rest } = s;
        rows.push(rest);
        continue;
      }
      rows.push(s);
    }
    return { success: true, data: rows, status_code: 200 };
  }

  async install(ctx: Ctx): Promise<ControllerResult> {
    if (!McpHostController.available()) return McpHostController.none();
    const folder = McpHostController.raw(ctx);
    if (!McpHostController.safe(folder)) return McpHostController.bad();
    if (Edition.isCorporate(this.cfg) && !(await this.isAdmin(ctx))) {
      const e = 'Only an admin can install MCP servers here.';
      return { success: false, data: { error: e }, error: e, status_code: 403 };
    }
    const body: Record<string, any> = { ...(ctx.body ?? {}) };
    body.installed_by = Number(ctx.user_id);
    return McpHostController.out(await this.clientFactory().request('POST', `/servers/${folder}/install`, body));
  }

  restart(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'POST', 'restart', false);
  }

  enabled(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'POST', 'enabled', true);
  }

  getSettings(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'GET', 'settings', false);
  }

  putSettings(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'PUT', 'settings', true);
  }

  source(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'GET', 'source', false);
  }

  delete(ctx: Ctx): Promise<ControllerResult> {
    return this.owned(ctx, 'DELETE', '', false);
  }

  /** Owner-or-admin gate (from the supervisor's own list), then the relayed call. */
  private async owned(ctx: Ctx, method: string, sub: string, withBody: boolean): Promise<ControllerResult> {
    if (!McpHostController.available()) return McpHostController.none();
    const folder = McpHostController.raw(ctx);
    if (!McpHostController.safe(folder)) return McpHostController.bad();
    const client = this.clientFactory();
    const list = await client.request('GET', '/servers');
    if (list.status !== 200) return McpHostController.out(list);
    const found = (Object.values(list.body ?? {}) as any[]).find((s) => s?.folder === folder) ?? null;
    if (found === null) return { success: false, data: { error: 'not found' }, error: 'not found', status_code: 404 };
    if (Number(found.installed_by ?? 0) !== Number(ctx.user_id) && !(await this.isAdmin(ctx))) {
      return { success: false, data: { error: 'forbidden' }, error: 'forbidden', status_code: 403 };
    }
    const path = `/servers/${folder}` + (sub === '' ? '' : `/${sub}`);
    return McpHostController.out(await client.request(method, path, withBody ? { ...(ctx.body ?? {}) } : null));
  }

  private async isAdmin(ctx: Ctx): Promise<boolean> {
    return (await requireAdmin(ctx)) === null;
  }

  private static raw(ctx: Ctx): string {
    return String(ctx.params?.folder ?? '');
  }

  /** Same shape the supervisor enforces: no leading dot, no separators. */
  private static safe(folder: string): boolean {
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(folder);
  }

  private static bad(): ControllerResult {
    return { success: false, data: { error: 'bad folder' }, error: 'bad folder', status_code: 400 };
  }

  private static none(): ControllerResult {
    return { success: false, data: { error: 'no server host' }, error: 'no server host', status_code: 404 };
  }

  private static out(r: { status: number; body: any }): ControllerResult {
    if (r.status === 503) {
      const e = 'The server host is not reachable';
      return { success: false, data: { error: e }, error: e, status_code: 503 };
    }
    const ok = r.status < 400;
    const out: ControllerResult = { success: ok, data: r.body, status_code: r.status };
    if (!ok) out.error = String(r.body?.error ?? 'error');
    return out;
  }
}
