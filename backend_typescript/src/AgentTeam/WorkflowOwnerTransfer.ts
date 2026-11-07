import { sql, RawBuilder } from 'kysely';
import { db } from '../db/pools';
import { CodeComponentStore } from '../CodeComponent/CodeComponentStore';
import { RobotOwnership } from '../Services/RobotOwnership';
import { CodeNodeEmit } from './CodeNodeEmit';
import { StartOptionGraph } from './StartOptionGraph';

/** A refused Owner -> Robot transfer: kind (forbidden, not_found, clash) for the editor, status for the API. Mirrors WorkflowTransferError.php. */
export class WorkflowTransferError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly status: number,
    public readonly clashes: Array<{ kind: string; name: string; published?: boolean }> = []
  ) {
    super(message);
  }
}

type Links = { components: number[]; playbooks: number[]; agents: number[]; servers: string[] };
type Plan = { components: number[]; playbooks: number[]; agents: number[] };

const TABLES: Record<string, string> = { code_components: 'code_components', playbooks: 'playbooks', agents: 'agents' };

/**
 * Owner -> Robot (one way): the workflow and everything it uses that its owner owns (code components incl. the Start
 * option's, playbooks, agents and their playbooks) are moved to the robot in place, same ids, nothing copied; then
 * its schedule rows. Other users' rows (a public agent, a robot component) are left as they are.
 * Mirrors backend/src/AgentTeam/Services/WorkflowOwnerTransfer.php.
 */
export class WorkflowOwnerTransfer {
  constructor(private readonly ownership: RobotOwnership) {}

  async preview(callerId: number, workflowId: number): Promise<{ needs_servers: string[]; shared_with: any[]; clashes: any[] }> {
    const [robot, owner, name] = await this.load(callerId, workflowId);
    const links = await this.links(workflowId);
    if (owner === robot) {
      return { needs_servers: await this.missingServers(robot, links.servers), shared_with: [], clashes: [] };
    }
    const plan = await this.plan(owner, links);
    return {
      needs_servers: await this.missingServers(robot, links.servers),
      shared_with: await this.sharedWith(owner, workflowId, plan),
      clashes: await this.clashes(robot, workflowId, name, plan),
    };
  }

  /** An already robot-owned workflow only has its schedule rows moved again (a repair). */
  async toRobot(callerId: number, workflowId: number): Promise<{ workflow_id: number; moved: Plan & { schedules: number[] } }> {
    const [robot, owner, name] = await this.load(callerId, workflowId);
    let moved: Plan = { components: [], playbooks: [], agents: [] };
    if (owner !== robot) {
      moved = await this.plan(owner, await this.links(workflowId));
      const clashes = await this.clashes(robot, workflowId, name, moved);
      if (clashes.length > 0) {
        const published = clashes.filter((c) => c.published);
        const named = clashes.filter((c) => !c.published);
        const say = (cs: any[]) => cs.map((c) => `${c.kind} "${c.name}"`).join(', ');
        const parts = [
          ...(named.length === 0 ? [] : [`The robot already has ${say(named)}: rename yours first.`]),
          ...published.map((c) => `The playbook "${c.name}" is published to the robot: unpublish it first.`),
        ];
        throw new WorkflowTransferError('clash', parts.join(' '), 409, clashes);
      }
      await db.transaction().execute(async (trx) => {
        await sql`DELETE FROM active_workflows WHERE user_id = ${owner} AND workflow_id = ${workflowId}`.execute(trx);
        await sql`UPDATE agent_workflows SET user_id = ${robot} WHERE id = ${workflowId} AND user_id = ${owner}`.execute(trx);
        for (const [kind, table] of [['components', 'code_components'], ['playbooks', 'playbooks'], ['agents', 'agents']] as const) {
          if (moved[kind].length > 0) {
            await sql`UPDATE ${sql.table(TABLES[table])} SET user_id = ${robot} WHERE user_id = ${owner} AND id IN (${sql.join(moved[kind])})`.execute(trx);
          }
        }
      });
    }
    // scheduled_workflows is MyISAM: outside the transaction, and re-run on a robot workflow to repair it.
    const schedules = (
      await this.column(sql`SELECT id FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND user_id <> ${robot} ORDER BY id`)
    ).map((v) => Number(v));
    if (schedules.length > 0) {
      await sql`UPDATE scheduled_workflows SET user_id = ${robot} WHERE id IN (${sql.join(schedules)})`.execute(db);
    }
    return { workflow_id: workflowId, moved: { ...moved, schedules } };
  }

  /** [robot id, owner id, workflow name]: the caller may use the robot and owns the workflow, or the robot does. */
  private async load(callerId: number, workflowId: number): Promise<[number, number, string]> {
    const robot = await this.ownership.robotFor(callerId);
    if (robot === null) throw new WorkflowTransferError('forbidden', "Your role can't use the robot", 403);
    const row = (await sql<any>`SELECT user_id, name FROM agent_workflows WHERE id = ${workflowId}`.execute(db)).rows[0];
    if (!row || ![callerId, robot].includes(Number(row.user_id))) {
      throw new WorkflowTransferError('not_found', `Workflow #${workflowId} not found`, 404);
    }
    return [robot, Number(row.user_id), String(row.name)];
  }

  /** What the workflow's nodes and schedule rows link to, whoever owns it: {components, playbooks, agents, servers}. */
  private async links(workflowId: number): Promise<Links> {
    const components: number[] = [];
    const playbooks: number[] = [];
    const agents: number[] = [];
    const servers: string[] = [];
    for (const n of (await sql<any>`SELECT * FROM workflow_nodes WHERE workflow_id = ${workflowId}`.execute(db)).rows) {
      const cfg = decodeObject(n.config);
      if (CodeComponentStore.isCodeNode(n.node_type ?? null, cfg)) {
        if (!phpEmpty(cfg.code_component_id)) components.push(intval(cfg.code_component_id));
        else if (cfg.mcp_servers !== null && typeof cfg.mcp_servers === 'object') servers.push(...Object.values(cfg.mcp_servers).map(String)); // an inline code node ticks its own
      }
      const option = StartOptionGraph.optionId({ node_type: n.node_type ?? '', config: cfg });
      if (option !== null) components.push(option);
      if ((n.node_type ?? '') === 'playbook' && !phpEmpty(cfg.playbook_id)) playbooks.push(intval(cfg.playbook_id));
      if (!phpEmpty(n.agent_id)) agents.push(intval(n.agent_id));
    }
    for (const id of await this.column(sql`SELECT trigger_component_id FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND trigger_component_id IS NOT NULL`)) {
      components.push(intval(id));
    }
    const comps = unique(components);
    if (comps.length > 0) {
      for (const json of await this.column(sql`SELECT mcp_servers FROM code_components WHERE id IN (${sql.join(comps)})`)) {
        const list = decodeAny(json);
        if (list !== null && typeof list === 'object') servers.push(...Object.values(list).map(String));
      }
    }
    return { components: comps, playbooks: unique(playbooks), agents: unique(agents), servers };
  }

  /** The owner's rows among the links, ids sorted: what moves. A moved agent's playbook moves with it. */
  private async plan(owner: number, links: Links): Promise<Plan> {
    const agents = await this.owned('agents', owner, links.agents);
    const playbooks = [...links.playbooks];
    if (agents.length > 0) {
      for (const id of await this.column(sql`SELECT playbook_id FROM agents WHERE playbook_id IS NOT NULL AND id IN (${sql.join(agents)})`)) {
        playbooks.push(intval(id));
      }
    }
    return {
      components: await this.owned('code_components', owner, links.components),
      playbooks: await this.owned('playbooks', owner, unique(playbooks)),
      agents,
    };
  }

  private async owned(table: string, owner: number, ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    return (
      await this.column(sql`SELECT id FROM ${sql.table(TABLES[table])} WHERE user_id = ${owner} AND id IN (${sql.join(ids)}) ORDER BY id`)
    ).map((v) => intval(v));
  }

  /** The robot's rows with the unique key (per owner) of one being moved: [{kind, name}]. */
  private async clashes(robot: number, workflowId: number, name: string, plan: Plan): Promise<Array<{ kind: string; name: string; published?: boolean }>> {
    const clashes: Array<{ kind: string; name: string; published?: boolean }> = [];
    if ((await this.column(sql`SELECT 1 AS one FROM agent_workflows WHERE user_id = ${robot} AND name = ${name} AND id <> ${workflowId}`)).length > 0) {
      clashes.push({ kind: 'workflow', name });
    }
    for (const [kind, table, key, planKey] of [
      ['component', 'code_components', 'name', 'components'],
      ['playbook', 'playbooks', 'pkey', 'playbooks'],
      ['agent', 'agents', 'name', 'agents'],
    ] as const) {
      const ids = plan[planKey];
      if (ids.length === 0) continue;
      // a robot playbook with a source_id is a published copy (the ServiceNow bridge's): unpublished, not renamed
      const published = kind === 'playbook' ? sql`r.source_id IS NOT NULL` : sql`0`;
      const t = sql.table(table);
      const k = sql.ref(key);
      const rows = (
        await sql<any>`SELECT m.${k} AS name, ${published} AS published FROM ${t} m JOIN ${t} r ON r.${k} = m.${k} AND r.user_id = ${robot}
          WHERE m.id IN (${sql.join(ids)}) ORDER BY m.${k}`.execute(db)
      ).rows;
      for (const r of rows) clashes.push({ kind, name: String(r.name), ...(Number(r.published) ? { published: true } : {}) });
    }
    return clashes;
  }

  /** The owner's other workflows linking a moved item: they keep working, on the robot's rows. */
  private async sharedWith(owner: number, workflowId: number, plan: Plan): Promise<Array<{ id: number; name: string }>> {
    const shared: Array<{ id: number; name: string }> = [];
    for (const w of (await sql<any>`SELECT id, name FROM agent_workflows WHERE user_id = ${owner} AND id <> ${workflowId} ORDER BY name, id`.execute(db)).rows) {
      const links = await this.links(Number(w.id));
      for (const kind of ['components', 'playbooks', 'agents'] as const) {
        if (links[kind].some((id) => plan[kind].includes(id))) {
          shared.push({ id: Number(w.id), name: String(w.name) });
          break;
        }
      }
    }
    return shared;
  }

  /** The servers (by name, sorted) the robot has no enabled row for, as code nodes resolve them: by slug, its own or shared. */
  private async missingServers(robotId: number, names: string[]): Promise<string[]> {
    const have = new Set(
      (await this.column(sql`SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ${String(robotId)})`)).map((n) =>
        CodeNodeEmit.slug(String(n))
      )
    );
    const missing = [...new Set(names.filter((n) => !have.has(CodeNodeEmit.slug(n))))];
    missing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return missing;
  }

  private async column(q: RawBuilder<unknown>): Promise<any[]> {
    return (await q.execute(db)).rows.map((r: any) => Object.values(r)[0]);
  }
}

function decodeAny(v: any): any {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function decodeObject(v: any): Record<string, any> {
  const d = decodeAny(v);
  return d !== null && typeof d === 'object' ? d : {};
}

function phpEmpty(v: any): boolean {
  return v === null || v === undefined || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
}

function intval(v: any): number {
  if (typeof v === 'number') return Math.trunc(v);
  const m = /^\s*[+-]?\d+/.exec(String(v ?? ''));
  return m ? parseInt(m[0], 10) : 0;
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}
