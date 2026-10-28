import { Kysely, sql } from 'kysely';
import { db } from '../db/pools';
import { DB } from '../db/types';
import { CodeNodeEmit } from '../AgentTeam/CodeNodeEmit';
import { ScheduledWorkflowService } from '../AgentTeam/ScheduledWorkflowService';
import { StartOptionGraph } from '../AgentTeam/StartOptionGraph';
import { StartTriggerFacts } from '../AgentTeam/StartTriggerFacts';
import { CodeComponentError } from './CodeComponentError';

/**
 * The code components collection: the only code that touches `code_components`. A component is a
 * code node's body (code, exits, MCP servers, timeout) under a name unique per user; workflow code
 * nodes link to it by config.code_component_id. Owner-scoped throughout.
 * Mirrors backend/src/CodeComponent/CodeComponentStore.php (same SQL, messages, kinds and statuses).
 *
 * mysql2 hands back the `json` columns (exits, mcp_servers, workflow_nodes.config) already parsed, where
 * PDO hands json_decode a string: decodeJson accepts both.
 */
export interface StartTrigger {
  label: string;
  watch: { server: string; tool: string; args: Record<string, any> };
  work_exit: string;
  pass_args: string[];
}

export interface CodeComponent {
  id: number;
  name: string;
  description: string;
  code: string;
  exits: string[];
  mcp_servers: string[];
  timeout_s: number;
  start_trigger: StartTrigger | null;
  /** The arguments it declares: [{name, description?, default?, required?}]. */
  args: ArgDecl[];
  /** The meta names its output carries on: [{name, description?}]. */
  provides: ProvidedDecl[];
  updated_at: any;
  used_by?: number;
}

export interface ArgDecl {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface ProvidedDecl {
  name: string;
  description?: string;
}

export interface LinkedNode {
  workflow_id: number;
  workflow_name: string;
  node_name: string;
  node_id: number;
  is_start: boolean;
}

const NAME_MAX = 191;
const LABEL_MAX = 60;
const PASS_ARGS_MAX = 20;
const DECLS_MAX = 20;
/** An argument or provided name: an identifier (no trailing-newline loophole: JS `$` without the m flag). */
const DECL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLS = sql.raw('id, name, description, code, exits, mcp_servers, timeout_s, start_trigger, args, provides, updated_at');

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object';
}

/** PHP json_decode($v, true) over a value mysql2 may already have parsed; null on invalid. */
function decodeJson(v: unknown): any {
  if (isObj(v)) return v;
  if (v === null || v === undefined) return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

/** PHP (string) for scalars; arrays become "Array". */
function str(v: unknown): string {
  if (v === undefined || v === null || v === false) return '';
  if (v === true) return '1';
  if (isObj(v)) return 'Array';
  return String(v);
}

function phpTrim(v: unknown): string {
  return str(v).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

function intval(v: any): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP empty(). */
function phpEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

/** mb_strlen: code points. */
function mbLen(s: string): number {
  return [...s].length;
}

/** PHP 8 asort (SORT_REGULAR) on strings: numeric strings compare as numbers, others byte-wise. */
function phpCompare(a: string, b: string): number {
  const num = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
  if (num.test(a) && num.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class CodeComponentStore {
  /** `ex` is the pool, or the transaction a write runs in. */
  constructor(private readonly ex: Kysely<DB> = db) {}

  /** Run `fn` in a transaction unless one is already open (PHP's $outer). */
  private async inTx<T>(fn: (s: CodeComponentStore) => Promise<T>): Promise<T> {
    if (this.ex.isTransaction) return fn(this);
    return this.ex.transaction().execute((trx) => fn(new CodeComponentStore(trx)));
  }

  async list(userId: number): Promise<CodeComponent[]> {
    const rows = (await sql<any>`SELECT ${COLS} FROM code_components WHERE user_id = ${userId} ORDER BY name`.execute(this.ex)).rows
      .map((r) => this.row(r));
    for (const r of rows) {
      r.used_by = (await this.usedBy(userId, r.id)).length;
    }
    return rows;
  }

  async get(userId: number, id: number): Promise<CodeComponent | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM code_components WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex)).rows[0];
    return r ? this.row(r) : null;
  }

  async getByName(userId: number, name: string): Promise<CodeComponent | null> {
    const r = (await sql<any>`SELECT ${COLS} FROM code_components WHERE name = ${name} AND user_id = ${userId}`.execute(this.ex)).rows[0];
    return r ? this.row(r) : null;
  }

  /** Create (id null; an existing name updates that row, as agents do) or update by id. */
  async save(userId: number, id: number | null, data: Record<string, any>): Promise<CodeComponent> {
    const c = CodeComponentStore.validate(data);
    let before = id === null ? null : await this.get(userId, id);
    if (id !== null && before === null) {
      throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    }
    const clash = await this.getByName(userId, c.name);
    if (id === null && clash !== null) {
      id = clash.id;
      before = clash;
    } else if (clash !== null && clash.id !== id) {
      throw new CodeComponentError('name_taken', `A code component named "${c.name}" already exists.`, 409);
    }
    if (before !== null && before.start_trigger !== null) {
      const t = before.start_trigger;
      if (!c.exits.includes(t.work_exit)) {
        throw new CodeComponentError('start_exit',
          `Exit "${t.work_exit}" starts workflows: keep it or change the Start option first.`, 422);
      }
      if (!c.mcp_servers.includes(t.watch.server)) {
        throw new CodeComponentError('start_exit',
          `MCP server "${t.watch.server}" starts workflows: keep it or change the Start option first.`, 422);
      }
    }
    if (before !== null && !same(before.exits, c.exits) && phpEmpty(data.confirm_drop_links)) {
      const lost = await this.droppedLinks(userId, id as number, before.exits, c.exits);
      if (lost.length > 0) {
        const what = lost.map((l) => `"${l.exit}" on ${l.node_name} in "${l.workflow_name}"`);
        throw new CodeComponentError('links_dropped', 'Removing these exits removes the links on '
          + what.join(', ') + '. Save again to confirm.', 409, lost);
      }
    }
    const exits = JSON.stringify(c.exits);
    const servers = JSON.stringify(c.mcp_servers);
    // absent args/provides keep the stored lists (a save from an older client must not wipe them)
    const args = JSON.stringify(c.args ?? before?.args ?? []);
    const provides = JSON.stringify(c.provides ?? before?.provides ?? []);
    if (id === null) {
      const res = await sql`INSERT INTO code_components (user_id, name, description, code, exits, mcp_servers, timeout_s, args, provides, created_at, updated_at)
        VALUES (${userId}, ${c.name}, ${c.description}, ${c.code}, ${exits}, ${servers}, ${c.timeout_s}, ${args}, ${provides}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`.execute(this.ex);
      id = Number(res.insertId);
    } else {
      const oldExits = before!.exits;
      const cid = id;
      await this.inTx(async (s) => {
        await sql`UPDATE code_components SET name = ${c.name}, description = ${c.description}, code = ${c.code}, exits = ${exits},
          mcp_servers = ${servers}, timeout_s = ${c.timeout_s}, args = ${args}, provides = ${provides}, updated_at = CURRENT_TIMESTAMP WHERE id = ${cid} AND user_id = ${userId}`.execute(s.ex);
        if (!same(oldExits, c.exits)) {
          await s.remapExits(userId, cid, oldExits, c.exits);
        }
      });
    }
    return (await this.get(userId, id))!;
  }

  async delete(userId: number, id: number): Promise<void> {
    const c = await this.get(userId, id);
    if (c === null) {
      throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    }
    if (c.start_trigger !== null) {
      throw new CodeComponentError('is_option', 'This code component is a Start option: remove the option first.', 409);
    }
    const used = await this.usedBy(userId, id);
    if (used.length > 0) {
      const names = used.map((n) => `node "${n.node_name}" in workflow "${n.workflow_name}"`);
      throw new CodeComponentError('in_use', 'This code component is used by ' + names.join(', ') + '.', 409);
    }
    await sql`DELETE FROM code_components WHERE id = ${id} AND user_id = ${userId}`.execute(this.ex);
  }

  /** Make the component a Start option (spec §1); the trigger is validated against the component. */
  async setStartTrigger(userId: number, id: number, trigger: Record<string, any>): Promise<CodeComponent> {
    const c = await this.get(userId, id);
    if (c === null) throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    const t = CodeComponentStore.validateStartTrigger(c, trigger);
    await this.inTx(async (s) => {
      await sql`UPDATE code_components SET start_trigger = ${JSON.stringify(t)}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND user_id = ${userId}`.execute(s.ex);
      // the schedules already on this option carry a copy of its watch: an edit reaches them too
      const watch = JSON.parse(JSON.stringify(t.watch));
      const rows = (await sql<any>`SELECT id, workflow_id FROM scheduled_workflows WHERE user_id = ${userId} AND trigger_component_id = ${id}`
        .execute(s.ex)).rows;
      for (const r of rows) { // each keeps its own Start's args
        const et = ScheduledWorkflowService.eventTrigger(JSON.stringify(await s.watchWithStartArgs(watch, intval(r.workflow_id), t.pass_args)));
        await sql`UPDATE scheduled_workflows SET event_trigger = ${et} WHERE id = ${r.id}`.execute(s.ex);
      }
    });
    return (await this.get(userId, id))!;
  }

  /** The user's workflows on this option: their schedule runs on it, or their Start shows its exits. */
  async startTriggerImpact(userId: number, id: number): Promise<Array<{ workflow_id: number; workflow_name: string }>> {
    const rows = (await sql<any>`SELECT DISTINCT s.workflow_id, w.name FROM scheduled_workflows s
      JOIN agent_workflows w ON w.id = s.workflow_id
      WHERE s.user_id = ${userId} AND s.trigger_component_id = ${id}`.execute(this.ex)).rows;
    const names = new Map<number, string>();
    for (const r of rows) {
      names.set(intval(r.workflow_id), str(r.name));
    }
    for (const n of await this.linkedNodes(userId, id)) {
      if (n.is_start) {
        names.set(n.workflow_id, n.workflow_name);
      }
    }
    return [...names.entries()]
      .sort((a, b) => phpCompare(a[1], b[1]))
      .map(([wid, name]) => ({ workflow_id: wid, workflow_name: name }));
  }

  /**
   * Remove the option: its schedule rows are deleted (a 'none' row would still run once at its time) and the
   * component stops being an option. Start nodes on it go back to one port (revertStarts); linked code nodes stay.
   */
  async clearStartTrigger(userId: number, id: number): Promise<Array<{ workflow_id: number; workflow_name: string }>> {
    const c = await this.get(userId, id);
    if (c === null) throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    const impact = await this.startTriggerImpact(userId, id);
    await this.inTx(async (s) => {
      await sql`DELETE FROM scheduled_workflows WHERE user_id = ${userId} AND trigger_component_id = ${id}`.execute(s.ex);
      if (c.start_trigger !== null) {
        await s.revertStarts(userId, id, c.exits, c.start_trigger.work_exit);
      }
      await sql`UPDATE code_components SET start_trigger = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ${id} AND user_id = ${userId}`
        .execute(s.ex);
    });
    return impact;
  }

  /**
   * A schedule save naming an option becomes that option's event schedule (spec §3); other bodies pass through.
   * The watch is the option's, plus the Start node's start_args.tag and the start_args the option names in
   * pass_args, as MCP arguments (the other start_args are not). workflowId: the workflow when the body does
   * not carry it (an update).
   */
  async scheduleBody(userId: number, body: Record<string, any>, workflowId: number | null = null): Promise<Record<string, any>> {
    if (phpEmpty(body.trigger_component_id)) {
      return body;
    }
    const id = intval(body.trigger_component_id);
    let watch: Record<string, any> = await this.watchFor(userId, id); // refuses a foreign or non-option component
    const pass = (await this.get(userId, id))?.start_trigger?.pass_args ?? [];
    watch = await this.watchWithStartArgs(watch, intval(body.workflow_id ?? workflowId ?? 0), Array.isArray(pass) ? pass : []);
    const { repeat_type: _r, event_trigger: _e, cron: _c, trigger_component_id: _t, ...rest } = body;
    return { repeat_type: 'event', event_trigger: watch, cron: null, trigger_component_id: id, ...rest };
  }

  /** The watch with the workflow's Start args merged into its args (StartTriggerFacts.watchArgs); the Start's values win. */
  private async watchWithStartArgs(watch: Record<string, any>, workflowId: number, passArgs: any[]): Promise<Record<string, any>> {
    const args = isObj(watch.args) ? watch.args : {};
    const merged = StartTriggerFacts.watchArgs(args, await this.startArgs(workflowId), passArgs);
    if (!same(merged, args)) {
      return { ...watch, args: merged };
    }
    return watch;
  }

  /** The workflow's Start node's start_args, or {}. */
  private async startArgs(workflowId: number): Promise<Record<string, any>> {
    if (workflowId <= 0) {
      return {};
    }
    const r = (await sql<any>`SELECT config FROM workflow_nodes WHERE workflow_id = ${workflowId} AND node_type = 'start' ORDER BY id LIMIT 1`
      .execute(this.ex)).rows[0];
    const cfg = decodeJson(r?.config ?? null);
    const args = isObj(cfg) ? (cfg.start_args ?? null) : null;
    return isObj(args) ? args : {};
  }

  /** The option's watch, as an event schedule stores it: {server, tool, args}. */
  async watchFor(userId: number, id: number): Promise<StartTrigger['watch']> {
    const c = await this.get(userId, id);
    if (c === null) throw new CodeComponentError('not_found', `Code component #${id} not found`, 404);
    if (c.start_trigger === null) {
      throw new CodeComponentError('not_option', `"${c.name}" is not a Start option.`, 422);
    }
    return c.start_trigger.watch;
  }

  /**
   * A workflow_nodes row is a code node. The column decides when it has a value; a DB whose node_type
   * is still the old ENUM (no 'code') stores '' for one, and then the config's type decides.
   */
  static isCodeNode(nodeType: string | null | undefined, cfg: unknown): boolean {
    return (nodeType ?? '') !== '' ? nodeType === 'code' : isObj(cfg) && (cfg.type ?? null) === 'code';
  }

  /** The user's workflow code nodes that link to the component, and the Start nodes on its option. */
  async usedBy(userId: number, id: number): Promise<Array<{ workflow_id: number; workflow_name: string; node_name: string }>> {
    return (await this.linkedNodes(userId, id)).map(({ node_id: _n, is_start: _s, ...rest }) => rest);
  }

  /** usedBy plus each node's workflow_nodes.id. */
  private async linkedNodes(userId: number, id: number): Promise<LinkedNode[]> {
    // The link lives in the node's config JSON: decoded here, so the query stays portable (MySQL and SQLite).
    const rows = (await sql<any>`SELECT n.id AS node_id, n.node_type, n.config, w.id AS workflow_id, w.name AS workflow_name
      FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
      WHERE w.user_id = ${String(userId)} ORDER BY w.name, n.id`.execute(this.ex)).rows;
    const nodes: LinkedNode[] = [];
    for (const r of rows) {
      const cfg = decodeJson(r.config);
      const code = CodeComponentStore.isCodeNode(r.node_type, cfg) && intval(isObj(cfg) ? (cfg.code_component_id ?? 0) : 0) === id;
      const start = !code && isObj(cfg) && StartOptionGraph.optionId({ node_type: r.node_type, config: cfg }) === id;
      if (code || start) {
        nodes.push({
          workflow_id: intval(r.workflow_id), workflow_name: str(r.workflow_name),
          node_name: start ? 'Start' : str(cfg?.name ?? 'Code'), node_id: intval(r.node_id), is_start: start,
        });
      }
    }
    return nodes;
  }

  /**
   * The links an exit change would remove (remapExits' rules): [{workflow_id, workflow_name, node_name, exit,
   * count}], one per linked node and removed exit that has links. Collapsing to one exit removes none.
   */
  async droppedLinks(userId: number, id: number, oldExits: string[], newExits: string[]): Promise<any[]> {
    if (newExits.length === 1 || oldExits.length === 1) {
      return [];
    }
    const lost: any[] = [];
    for (const node of await this.linkedNodes(userId, id)) {
      for (let k = 0; k < oldExits.length; k++) {
        const exit = oldExits[k];
        if (newExits.includes(exit)) {
          continue;
        }
        const r = (await sql<any>`SELECT COUNT(*) AS n FROM workflow_edges WHERE from_node_id = ${node.node_id} AND from_port = ${'output_' + (k + 1)}`
          .execute(this.ex)).rows[0];
        const n = intval(r?.n ?? 0);
        if (n > 0) {
          lost.push({ workflow_id: node.workflow_id, workflow_name: node.workflow_name, node_name: node.node_name, exit, count: n });
        }
      }
    }
    return lost;
  }

  /**
   * Start nodes on the option go back to a plain Start: one port, holding the work exit's links; the other
   * exits' links are removed, and so is config.start_option.
   */
  private async revertStarts(userId: number, id: number, exits: string[], workExit: string): Promise<void> {
    const work = 'output_' + (Math.max(exits.indexOf(workExit), 0) + 1);
    for (const node of await this.linkedNodes(userId, id)) {
      if (!node.is_start) {
        continue;
      }
      const edges = (await sql<any>`SELECT id, from_port FROM workflow_edges WHERE from_node_id = ${node.node_id}`.execute(this.ex)).rows;
      for (const e of edges) {
        if (e.from_port === work) {
          await sql`UPDATE workflow_edges SET from_port = 'output_1' WHERE id = ${e.id}`.execute(this.ex);
        } else {
          await sql`DELETE FROM workflow_edges WHERE id = ${e.id}`.execute(this.ex);
        }
      }
      const r = (await sql<any>`SELECT config FROM workflow_nodes WHERE id = ${node.node_id}`.execute(this.ex)).rows[0];
      let cfg = decodeJson(r?.config ?? null);
      if (!isObj(cfg) || phpEmpty(cfg)) cfg = {};
      delete cfg.start_option;
      // PHP json_encode of an emptied array is "[]"
      const json = Object.keys(cfg).length === 0 ? '[]' : JSON.stringify(cfg);
      await sql`UPDATE workflow_nodes SET config = ${json} WHERE id = ${node.node_id}`.execute(this.ex);
    }
  }

  /**
   * Edges are stored by port index (output_k = exit k), so an exit change moves each linked node's
   * edges BY NAME, as the editor's CodeNode.remapExits does: a surviving exit keeps its edges on its
   * new port, a removed exit's edges go; one exit left moves every edge onto output_1 (duplicates
   * dropped); one exit before lands on output_1 unless its name survives. Ports beyond the old exits
   * are left alone.
   */
  private async remapExits(userId: number, id: number, oldExits: string[], newExits: string[]): Promise<void> {
    for (const node of await this.linkedNodes(userId, id)) {
      const rows = (await sql<any>`SELECT id, to_node_id, to_port, from_port FROM workflow_edges WHERE from_node_id = ${node.node_id} ORDER BY id`
        .execute(this.ex)).rows;
      const edges: any[] = [];
      for (const e of rows) {
        const m = /^output_(\d+)$/.exec(str(e.from_port));
        const k = m ? parseInt(m[1], 10) : 0;
        if (k >= 1 && k <= oldExits.length) {
          edges.push({ ...e, k });
        }
      }
      // old port order, so a collapse keeps the edge of the earliest exit (as the editor does)
      edges.sort((a, b) => a.k - b.k || intval(a.id) - intval(b.id));
      const seen = new Set<string>();
      for (const e of edges) {
        let j: number;
        if (newExits.length === 1) {
          const key = e.to_node_id + '|' + e.to_port;
          if (seen.has(key)) {
            await sql`DELETE FROM workflow_edges WHERE id = ${e.id}`.execute(this.ex);
            continue;
          }
          seen.add(key);
          j = 0;
        } else {
          const exit = oldExits[e.k - 1];
          const found = newExits.indexOf(exit);
          j = oldExits.length === 1 && found === -1 ? 0 : found;
        }
        if (j < 0) {
          await sql`DELETE FROM workflow_edges WHERE id = ${e.id}`.execute(this.ex);
        } else if ('output_' + (j + 1) !== e.from_port) {
          await sql`UPDATE workflow_edges SET from_port = ${'output_' + (j + 1)} WHERE id = ${e.id}`.execute(this.ex);
        }
      }
    }
  }

  /** The editor's rules (CodeNode.validateConfig): a name, 1-8 unique exits, server names, 1-300 s. */
  private static validate(d: Record<string, any>): { name: string; description: string; code: string; exits: string[];
    mcp_servers: string[]; timeout_s: number; args?: ArgDecl[]; provides?: ProvidedDecl[] } {
    const bad = (why: string): never => {
      throw new CodeComponentError('invalid', why, 422);
    };
    const name = phpTrim(d.name ?? '');
    if (name === '' || mbLen(name) > NAME_MAX) {
      bad('The name is required (at most 191 characters).');
    }
    const code = d.code ?? '';
    if (typeof code !== 'string') {
      bad('code must be text.');
    }
    // PHP is_array() holds for a JSON list or object; array_values() keeps the values
    const rawExits = d.exits ?? null;
    const exits: any[] | null = Array.isArray(rawExits) ? rawExits : isObj(rawExits) ? Object.values(rawExits) : null;
    if (exits === null || exits.length === 0 || exits.length > 8 || new Set(exits.map(str)).size !== exits.length) {
      bad('exits must be 1 to 8 unique names.');
    }
    for (const e of exits!) {
      if (typeof e !== 'string' || !CodeNodeEmit.EXIT_RE.test(e)) {
        bad('Exit names are lowercase letters, digits and _ (got ' + JSON.stringify(e) + ').');
      }
    }
    const rawServers = d.mcp_servers ?? [];
    const servers: any[] | null = Array.isArray(rawServers) ? rawServers : isObj(rawServers) ? Object.values(rawServers) : null;
    if (servers === null || servers.some((s) => typeof s !== 'string')) {
      bad('mcp_servers must be a list of MCP server names.');
    }
    const timeout = d.timeout_s ?? 30;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
      bad('timeout_s must be 1 to 300 seconds.');
    }
    const out: { name: string; description: string; code: string; exits: string[]; mcp_servers: string[]; timeout_s: number;
      args?: ArgDecl[]; provides?: ProvidedDecl[] } = { name, description: str(d.description ?? ''), code: code as string,
      exits: exits as string[], mcp_servers: servers as string[], timeout_s: timeout as number };
    if (Object.prototype.hasOwnProperty.call(d, 'args') && d.args !== undefined) {
      out.args = CodeComponentStore.validateDecls(d.args, true) as ArgDecl[];
    }
    if (Object.prototype.hasOwnProperty.call(d, 'provides') && d.provides !== undefined) {
      out.provides = CodeComponentStore.validateDecls(d.provides, false);
    }
    return out;
  }

  /**
   * The arguments ({name, description?, default?, required?}) or provided names ({name, description?}) a component
   * declares: a list of identifiers, unique, at most 20; optional keys stay as given, unknown keys are dropped.
   */
  private static validateDecls(list: unknown, isArgs: boolean): Array<ArgDecl | ProvidedDecl> {
    const bad = (why: string): never => {
      throw new CodeComponentError('invalid', why, 422);
    };
    const what = isArgs ? 'args must be a list of {name, description, default, required}.'
      : 'provides must be a list of {name, description}.';
    // PHP decodes an empty JSON object to [] too, so {} reads as an empty list
    const items: unknown[] = Array.isArray(list) ? list
      : isObj(list) && Object.keys(list).length === 0 ? [] : bad(what);
    if (items.length > DECLS_MAX) {
      bad(`At most ${DECLS_MAX} arguments and ${DECLS_MAX} provided names.`);
    }
    const out: Array<ArgDecl | ProvidedDecl> = [];
    const seen = new Set<string>();
    for (const e of items) {
      // an entry is an object (an empty JSON list decodes to PHP's empty array, so [] passes on to the name check)
      if (!isObj(e) || (Array.isArray(e) && e.length > 0)) {
        bad(what);
      }
      const entry = e as Record<string, any>;
      const n = Array.isArray(entry) ? undefined : entry.name;
      if (typeof n !== 'string' || !DECL_NAME_RE.test(n)) {
        bad('Argument and provided names are letters, digits and _, not starting with a digit (got '
          + (n === undefined ? 'null' : JSON.stringify(n)) + ').');
      }
      if (seen.has(n)) {
        bad((isArgs ? 'Argument' : 'Provided name') + ` "${n}" is listed twice.`);
      }
      seen.add(n);
      const decl: Record<string, any> = { name: n };
      for (const k of isArgs ? ['description', 'default'] : ['description']) {
        if (Object.prototype.hasOwnProperty.call(entry, k)) {
          if (typeof entry[k] !== 'string') bad(what);
          decl[k] = entry[k];
        }
      }
      if (isArgs && Object.prototype.hasOwnProperty.call(entry, 'required')) {
        if (typeof entry.required !== 'boolean') bad(what);
        decl.required = entry.required;
      }
      out.push(decl as ArgDecl | ProvidedDecl);
    }
    return out;
  }

  /**
   * {label, watch: {server, tool, args}, work_exit, pass_args} against the component; args stay a JSON object.
   * pass_args: the Start args merged into the watch's args (spec 2026-10-22 §6.1); absent = the stored list, or [].
   */
  private static validateStartTrigger(c: CodeComponent, t: Record<string, any>): StartTrigger {
    const bad = (why: string): never => {
      throw new CodeComponentError('invalid', why, 422);
    };
    let label = phpTrim(t.label ?? '');
    label = label === '' ? c.name : label;
    if (mbLen(label) > LABEL_MAX) {
      bad('The option label is at most ' + LABEL_MAX + ' characters.');
    }
    let watch: StartTrigger['watch'];
    try { // the shape an event schedule accepts (ScheduledWorkflowService.eventTrigger), normalised
      watch = JSON.parse(ScheduledWorkflowService.eventTrigger(t.watch ?? null));
    } catch (e: any) {
      return bad(e?.message ?? '');
    }
    if (!c.mcp_servers.includes(watch.server)) {
      bad(`MCP server "${watch.server}" is not one of this component's servers.`);
    }
    const exit = str(t.work_exit ?? '');
    if (!c.exits.includes(exit)) {
      bad(`Exit "${exit}" is not one of this component's exits.`);
    }
    // a save without the key (the editor's option dialog) keeps the stored list; an explicit one, [] too, replaces it
    const pass = Object.prototype.hasOwnProperty.call(t, 'pass_args') ? t.pass_args : (c.start_trigger?.pass_args ?? []);
    if (!Array.isArray(pass) || pass.length > PASS_ARGS_MAX) {
      bad('pass_args must be a list of at most ' + PASS_ARGS_MAX + ' argument names.');
    }
    for (const p of pass as any[]) {
      if (typeof p !== 'string' || !/^[A-Za-z_]\w*$/.test(p)) {
        bad('pass_args names are letters, digits and _, not starting with a digit (got ' + JSON.stringify(p) + ').');
      }
    }
    return { label, watch, work_exit: exit, pass_args: pass as string[] };
  }

  /** A declarations column: json_decode(...) ?: [] (NULL, '' and invalid JSON read as an empty list). */
  private static declList(v: unknown): any[] {
    const d = decodeJson(v ?? '');
    return phpEmpty(d) || !Array.isArray(d) ? [] : d;
  }

  private row(r: Record<string, any>): CodeComponent {
    const exits = decodeJson(r.exits);
    const servers = decodeJson(r.mcp_servers);
    return {
      id: intval(r.id), name: str(r.name), description: str(r.description ?? ''),
      code: str(r.code), exits: phpEmpty(exits) ? [] : exits,
      mcp_servers: phpEmpty(servers) ? [] : servers, timeout_s: intval(r.timeout_s),
      start_trigger: (r.start_trigger ?? null) && r.start_trigger !== '0' ? decodeJson(r.start_trigger) : null,
      args: CodeComponentStore.declList(r.args),
      provides: CodeComponentStore.declList(r.provides),
      updated_at: r.updated_at,
    };
  }
}
