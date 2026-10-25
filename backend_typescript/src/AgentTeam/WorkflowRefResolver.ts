import { sql } from 'kysely';
import { db } from '../db/pools';

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
 * Resolution is against the workflow owner's own rows only. Mirrors backend/src/AgentTeam/Services/WorkflowRefResolver.php.
 */
export class WorkflowRefResolver {
  /** Throws UnresolvedRefsException listing every name that did not resolve. */
  async resolve(userId: number, nodes: any[], edges: any[]): Promise<{ nodes: any[]; edges: any[] }> {
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
        const pid = await this.playbookId(userId, ref);
        if (pid === null) missing.push(`playbook '${ref}'`);
        else cfg.playbook_id = pid;
        delete cfg.playbook_ref;
        exitsByNode[id] = PLAYBOOK_EXITS;
      }
      if (isset(cfg, 'code_component_ref')) {
        const ref = str(cfg.code_component_ref);
        const c = await this.component(userId, ref);
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
        const c = await this.component(userId, ref);
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

  private async playbookId(userId: number, pkey: string): Promise<number | null> {
    const r = (await sql<any>`SELECT id FROM playbooks WHERE user_id = ${userId} AND pkey = ${pkey} ORDER BY id LIMIT 1`.execute(db)).rows[0];
    return r ? Number(r.id) : null;
  }

  private async component(userId: number, name: string): Promise<{ id: number; exits: string[] } | null> {
    const r = (await sql<any>`SELECT id, exits FROM code_components WHERE user_id = ${userId} AND name = ${name} ORDER BY id LIMIT 1`.execute(db)).rows[0];
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
