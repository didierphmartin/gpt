import { sql } from 'kysely';
import { db } from '../db/pools';
import { CodeComponentStore } from '../CodeComponent/CodeComponentStore';
import { StartOptionGraph } from './StartOptionGraph';

/** A workflow graph names playbooks, components or exits that do not exist for its owner. Mirrors UnresolvedRefsException.php. */
export class UnresolvedRefsException extends Error {
  constructor(public readonly missing: string[]) {
    super('unknown references: ' + missing.join('; '));
  }
}

const PLAYBOOK_EXITS = ['done', 'failed'];

const isset = (o: any, k: string) => o !== null && typeof o === 'object' && o[k] !== undefined && o[k] !== null;
const str = (v: any) => (v === true ? '1' : v === false || v === null || v === undefined ? '' : String(v));

/**
 * Turns the names a compiled workflow graph uses (playbook_ref = pkey, code_component_ref / start_option_ref =
 * component name, edge from_port_name = exit name) into the ids and ports the graph repository stores.
 * Resolution is against the workflow owner's own rows, then the robot's (shared with robot-permitted users). Mirrors backend/src/AgentTeam/Services/WorkflowRefResolver.php.
 */
export class WorkflowRefResolver {
  /** Throws UnresolvedRefsException listing every name that did not resolve. */
  async resolve(userId: number, nodes: any[], edges: any[], robotId: number | null = null): Promise<{ nodes: any[]; edges: any[] }> {
    const missing: string[] = [];
    const exitsByNode: Record<string, string[]> = {}; // node id => exit names its out-edges are named against
    nodes = Array.isArray(nodes) ? [...nodes] : Object.values(nodes ?? {});
    edges = Array.isArray(edges) ? [...edges] : Object.values(edges ?? {});

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const raw = node?.config ?? node?.data ?? null;
      if (raw === null || typeof raw !== 'object') continue;
      const key = node.config !== undefined && node.config !== null ? 'config' : 'data';
      const cfg: Record<string, any> = Array.isArray(raw) ? { ...raw } : { ...raw };
      const id = str(node.id ?? '');

      if (isset(cfg, 'playbook_ref')) {
        const ref = str(cfg.playbook_ref);
        const pid = await this.playbookId(userId, ref, robotId);
        if (pid === null) missing.push(`playbook '${ref}'`);
        else cfg.playbook_id = pid;
        delete cfg.playbook_ref;
        exitsByNode[id] = PLAYBOOK_EXITS;
      }
      if (isset(cfg, 'code_component_ref')) {
        const ref = str(cfg.code_component_ref);
        const c = await this.component(userId, ref, robotId);
        if (c === null) {
          missing.push(`code component '${ref}'`);
        } else {
          cfg.code_component_id = c.id;
          exitsByNode[id] = c.exits;
        }
        delete cfg.code_component_ref;
      }
      if (isset(cfg, 'start_option_ref')) {
        const ref = str(cfg.start_option_ref);
        const c = await this.component(userId, ref, robotId);
        if (c === null) {
          missing.push(`start option component '${ref}'`);
        } else {
          cfg.start_option = c.id;
          exitsByNode[id] = c.exits;
        }
        delete cfg.start_option_ref;
      }
      nodes[i] = { ...node, [key]: cfg };
    }

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge === null || typeof edge !== 'object' || !Object.prototype.hasOwnProperty.call(edge, 'from_port_name')) continue;
      const name = str(edge.from_port_name);
      const from = str(edge.from ?? edge.from_node_id ?? '');
      const exits = exitsByNode[from];
      const at = exits === undefined ? -1 : exits.indexOf(name);
      const out: Record<string, any> = { ...edge };
      if (at === -1) missing.push(`exit '${name}' on node '${from}'`);
      else out.from_port = 'output_' + (at + 1);
      delete out.from_port_name;
      edges[i] = out;
    }

    if (missing.length) throw new UnresolvedRefsException([...new Set(missing)]);
    return { nodes, edges };
  }

  /**
   * The links of a robot workflow's (resolved) nodes the robot cannot use: another user's code component, Start
   * option or playbook (the robot's published playbook copies included), or an agent neither the robot's nor
   * public/workspace. Named "code component #8" and so on; [] when every link is the robot's.
   */
  async foreignToRobot(robotId: number, nodes: any[]): Promise<string[]> {
    const missing: string[] = [];
    const has = async (q: ReturnType<typeof sql>): Promise<boolean> => (await (q as any).execute(db)).rows.length > 0;
    for (const node of Array.isArray(nodes) ? nodes : Object.values(nodes ?? {})) {
      let cfg: any = node?.config ?? node?.data ?? {};
      cfg = cfg !== null && typeof cfg === 'object' ? cfg : {};
      const type = str(node?.node_type ?? node?.type ?? cfg.type ?? '');
      const compId = intval(cfg.code_component_id);
      if (CodeComponentStore.isCodeNode(type, cfg) && compId !== 0 && !(await has(sql`SELECT 1 AS one FROM code_components WHERE id = ${compId} AND user_id = ${robotId}`))) {
        missing.push('code component #' + compId);
      }
      const option = StartOptionGraph.optionId({ node_type: type, config: cfg });
      if (option !== null && !(await has(sql`SELECT 1 AS one FROM code_components WHERE id = ${option} AND user_id = ${robotId}`))) {
        missing.push(`start option component #${option}`);
      }
      const pb = intval(cfg.playbook_id);
      if (pb !== 0 && !(await has(sql`SELECT 1 AS one FROM playbooks WHERE id = ${pb} AND user_id = ${robotId} AND source_id IS NULL`))) {
        missing.push('playbook #' + pb);
      }
      const agent = node?.agent_id ?? null;
      if (isNumeric(agent) && intval(agent) > 0 && !(await has(sql`SELECT 1 AS one FROM agents WHERE id = ${intval(agent)}
          AND (user_id = ${robotId} OR visibility IN ('public', 'workspace'))`))) {
        missing.push('agent #' + intval(agent));
      }
    }
    return [...new Set(missing)];
  }

  private async playbookId(userId: number, pkey: string, robotId: number | null): Promise<number | null> {
    for (const owner of robotId === null ? [userId] : [...new Set([userId, robotId])]) {
      // the robot's published copies (source_id set, the ServiceNow bridge's) are not shared rows
      const r = (
        owner === robotId
          ? await sql<any>`SELECT id FROM playbooks WHERE user_id = ${owner} AND pkey = ${pkey} AND source_id IS NULL ORDER BY id LIMIT 1`.execute(db)
          : await sql<any>`SELECT id FROM playbooks WHERE user_id = ${owner} AND pkey = ${pkey} ORDER BY id LIMIT 1`.execute(db)
      ).rows[0];
      if (r) return Number(r.id);
    }
    return null;
  }

  private async component(userId: number, name: string, robotId: number | null): Promise<{ id: number; exits: string[] } | null> {
    let r: any = undefined;
    for (const owner of robotId === null ? [userId] : [userId, robotId]) {
      r = (await sql<any>`SELECT id, exits FROM code_components WHERE user_id = ${owner} AND name = ${name} ORDER BY id LIMIT 1`.execute(db)).rows[0];
      if (r) break;
    }
    if (!r) return null;
    let exits: any = r.exits;
    if (typeof exits === 'string') {
      try {
        exits = JSON.parse(exits);
      } catch {
        exits = null;
      }
    }
    return {
      id: Number(r.id),
      exits: exits !== null && typeof exits === 'object' ? Object.values(exits).map((e) => e as string) : [],
    };
  }
}

/** PHP (int) of a config value (non-numeric strings, arrays and null are 0). */
function intval(v: any): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const m = /^\s*[+-]?\d+/.exec(v);
    return m ? parseInt(m[0], 10) : 0;
  }
  return 0;
}

/** PHP is_numeric (ints, floats, numeric strings). */
function isNumeric(v: any): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
}
