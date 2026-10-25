import { Kysely, sql } from 'kysely';
import { db } from '../db/pools';
import { DB } from '../db/types';
import { AutomationError } from './AutomationError';

/**
 * The automation record: the only code that touches `automations` / `automation_instances`. Owner-scoped throughout.
 * An instance's environment is not a column (the connector profile is its only source); the last check keeps what the
 * connector reported inside `detail` as JSON {"environment": ..., "text": ...} for display.
 * Mirrors backend/src/Automation/AutomationStore.php.
 */
export const AUTOMATION_KEY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const COLS = sql`id, automation_key, title, version, spec_json, playbook_id, workflow_id, sn_scope, updated_at`;

export type AutomationRow = {
  id: number; key: string; title: string; version: number; spec: any;
  playbook_id: number | null; workflow_id: number | null; sn_scope: string | null; updated_at: string | null;
};

/** gmdate('Y-m-d H:i:s'). */
export function gmNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** PHP is_array() on a decoded JSON value: an object or a list. */
export function isPhpArray(v: any): boolean {
  return v !== null && typeof v === 'object';
}

/** PHP `$v === []` on a decoded JSON value. */
export function isEmptyPhpArray(v: any): boolean {
  return isPhpArray(v) && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
}

function tryJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class AutomationStore {
  constructor(private readonly ex: Kysely<DB> = db) {}

  /** Creates version 1, or bumps the owner's existing key (same id) and stores the new title + spec. */
  async save(userId: number, key: string, title: string, spec: any): Promise<AutomationRow> {
    if (!AUTOMATION_KEY_RE.test(key)) {
      throw new AutomationError('key must match ^[a-z0-9][a-z0-9-]{1,40}$');
    }
    title = title.trim();
    if (title === '' || [...title].length > 255) {
      throw new AutomationError('title is required (max 255 characters)');
    }
    if (isEmptyPhpArray(spec)) {
      throw new AutomationError('spec must be a non-empty object');
    }
    const json = JSON.stringify(spec);
    const now = gmNow();
    const found = (await sql<any>`SELECT id FROM automations WHERE user_id = ${userId} AND automation_key = ${key}`.execute(this.ex)).rows[0];
    let id: number;
    if (found !== undefined) {
      id = Number(found.id);
      await sql`UPDATE automations SET version = version + 1, title = ${title}, spec_json = ${json}, updated_at = ${now} WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
    } else {
      const r = await sql`INSERT INTO automations (user_id, automation_key, title, version, spec_json, created_at, updated_at) VALUES (${userId}, ${key}, ${title}, 1, ${json}, ${now}, ${now})`.execute(this.ex);
      id = Number(r.insertId);
    }
    return (await this.get(userId, id)) as AutomationRow;
  }

  /** Replaces the stored spec without touching the version (a PUT edit; only save() on an existing key bumps). */
  async replaceSpec(userId: number, id: number, spec: any): Promise<void> {
    await this.require(userId, id);
    await sql`UPDATE automations SET spec_json = ${JSON.stringify(spec)}, updated_at = ${gmNow()} WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
  }

  /** Links the owner's playbook / workflow (null = leave as is) and stamps automation_id on those rows. */
  async link(userId: number, id: number, playbookId: number | null, workflowId: number | null): Promise<AutomationRow> {
    await this.require(userId, id);
    const targets: Array<[string, string, number | null]> = [['playbooks', 'playbook_id', playbookId], ['agent_workflows', 'workflow_id', workflowId]];
    for (const [table, col, rid] of targets) {
      if (rid === null) continue;
      const hit = (await sql<any>`SELECT 1 FROM ${sql.table(table)} WHERE id = ${rid} AND user_id = ${userId}`.execute(this.ex)).rows[0];
      if (hit === undefined) {
        throw new AutomationError(`${col} not found`, 404, 'not_found');
      }
    }
    for (const [table, col, rid] of targets) {
      if (rid === null) continue;
      await sql`UPDATE ${sql.table(table)} SET automation_id = ${id} WHERE id = ${rid} AND user_id = ${userId}`.execute(this.ex);
      await sql`UPDATE automations SET ${sql.ref(col)} = ${rid} WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
    }
    return (await this.get(userId, id)) as AutomationRow;
  }

  async setScope(userId: number, id: number, scope: string): Promise<void> {
    await sql`UPDATE automations SET sn_scope = ${scope} WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
  }

  async get(userId: number, id: number): Promise<AutomationRow | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM automations WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex)).rows[0];
    return r ? AutomationStore.row(r) : null;
  }

  async list(userId: number): Promise<Array<AutomationRow & { instances: any[] }>> {
    const rows = (await sql<any>`SELECT ${COLS} FROM automations WHERE user_id = ${userId} ORDER BY automation_key`.execute(this.ex)).rows;
    const out: Array<AutomationRow & { instances: any[] }> = [];
    for (const r of rows) {
      const row = AutomationStore.row(r);
      out.push({ ...row, instances: await this.instances(row.id) });
    }
    return out;
  }

  /** The automation's instances (call only after the owner check). */
  async instances(automationId: number): Promise<any[]> {
    const rows = (await sql<any>`SELECT mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail
            FROM automation_instances WHERE automation_id = ${automationId} ORDER BY mcp_server_id`.execute(this.ex)).rows;
    return rows.map((r) => {
      const [env, text] = AutomationStore.decodeDetail(r.detail ?? null);
      return {
        mcp_server_id: Number(r.mcp_server_id),
        installed_version: r.installed_version === null ? null : Number(r.installed_version),
        sn_item_sys_id: r.sn_item_sys_id, last_check_at: r.last_check_at,
        status: r.status, environment: env, detail: text,
      };
    });
  }

  async saveInstance(automationId: number, serverId: number, status: string, version: number | null, sysId: string | null,
    environment: string | null, text: string): Promise<void> {
    const detail = JSON.stringify({ environment, text });
    const now = gmNow();
    const hit = (await sql<any>`SELECT 1 FROM automation_instances WHERE automation_id = ${automationId} AND mcp_server_id = ${serverId}`.execute(this.ex)).rows[0];
    if (hit === undefined) {
      await sql`INSERT INTO automation_instances (automation_id, mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail) VALUES (${automationId}, ${serverId}, ${version}, ${sysId}, ${now}, ${status}, ${detail})`.execute(this.ex);
    } else {
      await sql`UPDATE automation_instances SET installed_version = ${version}, sn_item_sys_id = ${sysId}, last_check_at = ${now}, status = ${status}, detail = ${detail} WHERE automation_id = ${automationId} AND mcp_server_id = ${serverId}`.execute(this.ex);
    }
  }

  /**
   * The owner's MCP servers whose name starts with "ServiceNow": [{id, name, environment|null}], environment from the
   * latest check of any of the owner's automations on that server. Never includes URL or headers.
   */
  async servers(userId: number): Promise<Array<{ id: number; name: string; environment: string | null }>> {
    const rows = (await sql<any>`SELECT id, name FROM mcp_servers WHERE user_id = ${String(userId)} AND enabled = 1 ORDER BY id`.execute(this.ex)).rows;
    const out: Array<{ id: number; name: string; environment: string | null }> = [];
    for (const r of rows) {
      if (!String(r.name ?? '').startsWith('ServiceNow')) continue;
      const e = (await sql<any>`SELECT i.detail FROM automation_instances i JOIN automations a ON a.id = i.automation_id
                WHERE a.user_id = ${userId} AND i.mcp_server_id = ${r.id} AND i.last_check_at IS NOT NULL ORDER BY i.last_check_at DESC, i.automation_id DESC LIMIT 1`.execute(this.ex)).rows[0];
      out.push({ id: Number(r.id), name: String(r.name ?? ''), environment: e === undefined ? null : AutomationStore.decodeDetail(e.detail)[0] });
    }
    return out;
  }

  /** The owner's enabled server row (id, name, url, headers JSON) or null. */
  async serverRow(userId: number, serverId: number): Promise<{ id: any; name: any; url: any; headers: any } | null> {
    const r = (await sql<any>`SELECT id, name, url, headers FROM mcp_servers WHERE id = ${serverId} AND user_id = ${String(userId)} AND enabled = 1`.execute(this.ex)).rows[0];
    return r ?? null;
  }

  private async require(userId: number, id: number): Promise<void> {
    if ((await this.get(userId, id)) === null) {
      throw new AutomationError('automation not found', 404, 'not_found');
    }
  }

  private static row(r: any): AutomationRow {
    const spec = tryJson(String(r.spec_json ?? ''));
    return {
      id: Number(r.id), key: String(r.automation_key), title: String(r.title), version: Number(r.version),
      spec: isPhpArray(spec) ? spec : [],
      playbook_id: r.playbook_id === null ? null : Number(r.playbook_id),
      workflow_id: r.workflow_id === null ? null : Number(r.workflow_id),
      sn_scope: r.sn_scope, updated_at: r.updated_at,
    };
  }

  /** [environment|null, text] from a detail column (JSON, or legacy plain text). */
  static decodeDetail(detail: string | null): [string | null, string] {
    const d = typeof detail === 'string' ? tryJson(detail) : null;
    if (!isPhpArray(d)) {
      return [null, detail === null || detail === undefined ? '' : String(detail)];
    }
    const text = d.text ?? '';
    return [typeof d.environment === 'string' ? d.environment : null, typeof text === 'string' ? text : String(text)];
  }
}
