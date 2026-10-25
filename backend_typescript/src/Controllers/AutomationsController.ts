import { Kysely, sql } from 'kysely';
import { db as pool } from '../db/pools';
import { DB } from '../db/types';
import { Ctx, ControllerResult } from '../Support/Http';
import { AutomationError } from '../Automation/AutomationError';
import { AutomationMcp, CallRawAnswer } from '../Automation/AutomationMcp';
import { AutomationRow, AutomationStore, isEmptyPhpArray, isPhpArray } from '../Automation/AutomationStore';
import { LiveAutomationMcp } from '../Automation/LiveAutomationMcp';
import { phpIntval, phpEmpty } from '../AgentTeam/WorkflowRepository';

/**
 * /api/v1/automations -- the automation record, its drift check against the owner's ServiceNow MCP servers, and the
 * dev/test install through the connector's deploy toolset. Owner-scoped on every route. Stored server headers are
 * sent to the deploy URL and never returned or logged. Mirrors backend/src/Controllers/AutomationsController.php.
 */
const STAMP_VARIABLE = 'synergyai_automation';
const INSTALL_TIMEOUT_S = 900;

/** A PHP array key that PHP stores as an integer ("0", "12", "-3"): a JSON object key like that is not a string key. */
const PHP_INT_KEY = /^(0|-?[1-9][0-9]*)$/;

/** PHP is_numeric() for a decoded JSON value. */
function isNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

function values(v: any): any[] {
  return isPhpArray(v) ? Object.values(v) : [];
}

export class AutomationsController {
  private store: AutomationStore;
  private mcp: AutomationMcp;

  /**
   * reconnect: a fresh connection to the same database. The default is the shared pool, which hands out a live
   * connection for the next query (PHP opens a new PDO from the contexts_database config).
   */
  constructor(private ex: Kysely<DB> = pool, mcp: AutomationMcp | null = null,
    private readonly reconnect: () => Kysely<DB> = () => pool) {
    this.store = new AutomationStore(ex);
    this.mcp = mcp ?? new LiveAutomationMcp();
  }

  /** After a minutes-long call the server may have closed the idle connection (MySQL 2006): open a fresh one. */
  private async reconnectIfGone(): Promise<void> {
    try {
      await sql`SELECT 1`.execute(this.ex);
    } catch (e: any) {
      console.error('[AutomationsController] DB connection lost during the install, reconnecting: ' + (e?.message ?? e));
      this.ex = this.reconnect();
      this.store = new AutomationStore(this.ex);
    }
  }

  index(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const rows: any[] = await this.store.list(u);
      const servers = await this.store.servers(u);
      for (const r of rows) r.servers = servers;
      return { success: true, data: rows, status_code: 200 };
    });
  }

  create(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const b = this.body(ctx);
      if (typeof b.key !== 'string' || typeof b.title !== 'string' || !isPhpArray(b.spec)) {
        throw new AutomationError('body must be {key, title, spec}');
      }
      const a = await this.store.save(u, b.key, b.title, b.spec);
      return { success: true, data: await this.summary(u, a), status_code: 201 };
    });
  }

  update(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const id = phpIntval(ctx.params?.id ?? 0);
      const b = this.body(ctx);
      if ((await this.store.get(u, id)) === null) {
        throw new AutomationError('automation not found', 404, 'not_found');
      }
      if (Object.hasOwn(b, 'spec')) {
        if (!isPhpArray(b.spec) || isEmptyPhpArray(b.spec)) {
          throw new AutomationError('spec must be a non-empty object');
        }
        await this.store.replaceSpec(u, id, b.spec);
      }
      const a = await this.store.link(u, id, this.optId(b, 'playbook_id'), this.optId(b, 'workflow_id'));
      return { success: true, data: await this.summary(u, a), status_code: 200 };
    });
  }

  check(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const a = await this.owned(u, ctx);
      for (const s of await this.store.servers(u)) {
        await this.checkOne(u, a, s);
      }
      return { success: true, data: { instances: await this.store.instances(a.id), servers: await this.store.servers(u) }, status_code: 200 };
    });
  }

  install(ctx: Ctx): Promise<ControllerResult> {
    return this.guard(ctx, async (u) => {
      const a = await this.owned(u, ctx);
      const b = this.body(ctx);
      const serverId = phpIntval(b.server_id ?? 0);
      const scope = b.scope ?? null;
      const files = b.files ?? null;
      if (serverId <= 0 || typeof scope !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(scope)
        || !isPhpArray(files) || isEmptyPhpArray(files) || Array.isArray(files)
        || Object.entries(files).some(([k, v]) => PHP_INT_KEY.test(k) || typeof v !== 'string')) {
        throw new AutomationError('body must be {server_id, scope, files: {path: text}}');
      }
      const server = await this.store.serverRow(u, serverId);
      if (server === null) {
        throw new AutomationError('server not found', 404, 'not_found');
      }
      const url = String(server.name ?? '').startsWith('ServiceNow') ? AutomationsController.deployUrl(String(server.url ?? '')) : null;
      if (url === null) {
        throw new AutomationError('not a ServiceNow connector server URL (.../jobs)');
      }
      const r = await this.mcp.install(url, AutomationsController.headerLines(server.headers ?? null), { scope, files }, INSTALL_TIMEOUT_S);
      await this.reconnectIfGone();
      const [payload, err] = AutomationsController.payload(r);
      if (err !== null) {
        const status = err === 'not_allowed' ? 409 : err === 'bad_argument' ? 400 : 502;
        // the connector's message (for install_failed: the failing step and its log tail), so the cause is visible
        const res = r.result;
        let msg: any = isPhpArray(res) && isPhpArray(res.structuredContent) && isPhpArray(res.structuredContent.error)
          ? res.structuredContent.error.message ?? null : null;
        msg = typeof msg === 'string' && msg !== '' ? [...msg].slice(0, 2000).join('') : null;
        return { success: false, error: msg !== null ? `${err}: ${msg}` : err, code: err, message: msg, status_code: status };
      }
      await this.store.setScope(u, a.id, scope);
      return { success: true, data: payload, status_code: 200 };
    });
  }

  /** The deploy URL for a connector server URL: the final /jobs (optionally followed by /mcp) becomes /deploy. */
  static deployUrl(serverUrl: string): string | null {
    const re = /\/jobs(?:\/mcp)?\/?$/;
    return re.test(serverUrl) ? serverUrl.replace(re, '/deploy') : null;
  }

  private async checkOne(u: number, a: AutomationRow, server: { id: number; name: string }): Promise<void> {
    const r = await this.mcp.describe(u, server.name, a.key);
    const [payload, err] = AutomationsController.payload(r);
    if (err !== null) {
      await this.store.saveInstance(a.id, server.id, 'out_of_sync', null, null, null, 'cannot check: ' + err);
      return;
    }
    const env = typeof payload.environment === 'string' ? payload.environment : null;
    // item null = not installed; no item key, or not an object = a garbled answer the check cannot read
    const hasItem = !Array.isArray(payload) && Object.hasOwn(payload, 'item');
    if (!hasItem || (payload.item !== null && !isPhpArray(payload.item))) {
      await this.store.saveInstance(a.id, server.id, 'out_of_sync', null, null, env, 'cannot check: bad_answer');
      return;
    }
    const item = payload.item;
    if (item === null) {
      await this.store.saveInstance(a.id, server.id, 'not_installed', null, null, env, '');
      return;
    }
    const version = item.version !== undefined && item.version !== null && isNumeric(item.version) ? Math.trunc(Number(item.version)) : null;
    const diffs = AutomationsController.differences(a, item, version);
    await this.store.saveInstance(a.id, server.id, diffs.length === 0 ? 'in_sync' : 'out_of_sync', version,
      typeof item.sys_id === 'string' ? item.sys_id : null, env, diffs.join('; '));
  }

  /** Variable names and mandatory flags (bool, default false; the stamp variable ignored), then the version. */
  private static differences(a: AutomationRow, item: any, version: number | null): string[] {
    const want = new Map<string, boolean>();
    const form = isPhpArray(a.spec) && isPhpArray(a.spec.form) ? a.spec.form : null;
    for (const v of values(form?.variables)) {
      if (isPhpArray(v) && typeof v.name === 'string') want.set(v.name, (v.mandatory ?? false) === true);
    }
    const have = new Map<string, boolean>();
    for (const v of values(item.variables)) {
      if (isPhpArray(v) && typeof v.name === 'string' && v.name !== STAMP_VARIABLE) have.set(v.name, (v.mandatory ?? false) === true);
    }
    const d: string[] = [];
    for (const [n, m] of want) {
      if (!have.has(n)) {
        d.push(`variable ${n} missing in ServiceNow`);
      } else if (have.get(n) !== m) {
        d.push(`variable ${n} mandatory is ${have.get(n) ? 'true' : 'false'} in ServiceNow, ${m ? 'true' : 'false'} in the spec`);
      }
    }
    for (const n of have.keys()) {
      if (!want.has(n)) d.push(`variable ${n} exists in ServiceNow but not in the spec`);
    }
    if (version === null) {
      d.push(`version unknown in ServiceNow, spec is ${a.version}`);
    } else if (version !== a.version) {
      d.push(`version ${version} in ServiceNow, spec is ${a.version}`);
    }
    return d;
  }

  /** [payload, null] or [null, reason]: the structured payload of a callRaw answer, or the connector error code / transport reason. */
  private static payload(r: CallRawAnswer): [any, string | null] {
    if (phpEmpty(r.ok)) {
      return [null, r.error === undefined || r.error === null ? 'unreachable' : String(r.error)];
    }
    const res: any = isPhpArray(r.result) ? r.result : {};
    let p: any;
    if (isPhpArray(res.structuredContent)) {
      p = res.structuredContent;
    } else {
      const first = isPhpArray(res.content) ? res.content[0] : undefined;
      const text = isPhpArray(first) && first.text !== undefined && first.text !== null ? String(first.text) : '';
      try {
        p = JSON.parse(text);
      } catch {
        p = null;
      }
    }
    p = isPhpArray(p) ? p : {};
    if (!phpEmpty(res.isError) || (p.error !== undefined && p.error !== null)) {
      const e = p.error ?? null;
      const code = isPhpArray(e) ? e.code ?? null : e;
      return [null, typeof code === 'string' && code !== '' ? code : 'tool_error'];
    }
    return [p, null];
  }

  /** Stored headers JSON -> header lines (CR/LF/colon stripped from names, CR/LF from values). */
  private static headerLines(json: string | null): string[] {
    let h: any = null;
    if (typeof json === 'string') {
      try {
        h = JSON.parse(json);
      } catch {
        h = null;
      }
    }
    const out: string[] = [];
    if (!isPhpArray(h) || Array.isArray(h)) return out;
    for (const [k, v] of Object.entries(h)) {
      if (k !== '' && !PHP_INT_KEY.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        const value = typeof v === 'boolean' ? (v ? '1' : '') : String(v);
        out.push(k.replace(/[\r\n:]/g, '') + ': ' + value.replace(/[\r\n]/g, ''));
      }
    }
    return out;
  }

  private async summary(u: number, a: AutomationRow): Promise<Record<string, any>> {
    return {
      id: a.id, key: a.key, version: a.version, playbook_id: a.playbook_id,
      workflow_id: a.workflow_id, servers: await this.store.servers(u),
    };
  }

  private async owned(u: number, ctx: Ctx): Promise<AutomationRow> {
    const a = await this.store.get(u, phpIntval(ctx.params?.id ?? 0));
    if (a === null) {
      throw new AutomationError('automation not found', 404, 'not_found');
    }
    return a;
  }

  private optId(b: Record<string, any>, k: string): number | null {
    if (b[k] === undefined || b[k] === null) {
      return null;
    }
    if (!Number.isInteger(b[k]) || b[k] <= 0) {
      throw new AutomationError(`${k} must be a positive integer`);
    }
    return b[k];
  }

  private body(ctx: Ctx): Record<string, any> {
    return ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {};
  }

  private async guard(ctx: Ctx, fn: (u: number) => Promise<ControllerResult>): Promise<ControllerResult> {
    const u = phpIntval(ctx.user_id ?? 0);
    if (u <= 0) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    try {
      return await fn(u);
    } catch (e) {
      if (e instanceof AutomationError) {
        return { success: false, error: e.message, code: e.errorCode, status_code: e.status };
      }
      throw e;
    }
  }
}
