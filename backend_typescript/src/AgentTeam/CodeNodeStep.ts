/**
 * The server runner's code-node rules, as pure functions. Twins of code-node.js (parentsFor,
 * routeAfter) so the browser and server run paths cannot drift.
 * Mirrors backend/src/AgentTeam/Services/CodeNodeStep.php.
 */

export interface CodeParent {
  name: string;
  text: string;
  start: boolean;
}

export interface CodeRoute {
  success: boolean;
  output: string;
  exit: string | null;
  chosen: number[];
  skip: number[];
}

/** Node types whose execution means the run did real work (not a quiet poll). */
const WORK_TYPES = ['agent', 'playbook', 'output'];

const intval = (v: any): number => {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
};

/** Iterate a nodeOutputs map in run (insertion) order when given, else by key. */
function entries(nodeOutputs: Record<number, any>): Array<[number, any]> {
  return Object.keys(nodeOutputs).map((k) => [Number(k), nodeOutputs[Number(k)]]);
}

export const CodeNodeStep = {
  /** Characters of an error exit's output kept in its log line (the compiled ErrorExitTaken.REASON_MAX). */
  REASON_MAX: 200,

  /** An error exit's output as one line of at most REASON_MAX characters: it may be a whole tool error page. */
  reason(out: string): string {
    const line = out.replace(/\s+/gu, ' ').trim();
    const chars = Array.from(line);
    return chars.length <= CodeNodeStep.REASON_MAX ? line : chars.slice(0, CodeNodeStep.REASON_MAX).join('') + '…';
  },

  /**
   * run()'s parents: executed parents with a non-empty output; Start flagged (CodeNode.parentsFor).
   * A dispatcher parent (its output carries the 'route' it chose) stands for its own parents: a
   * branch receives what the dispatcher received (the email), not the agent-framed context.
   */
  parents(nodeId: number, edges: any[], nodes: Record<number, any>, nodeOutputs: Record<number, any>, seen: Set<number> = new Set()): CodeParent[] {
    const out: CodeParent[] = [];
    for (const e of edges) {
      if (intval(e.to_node_id) !== nodeId) continue;
      const u = intval(e.from_node_id);
      const o = nodeOutputs[u];
      if (o !== undefined && o !== null && o.route !== undefined && o.route !== null) {
        if (!seen.has(u)) out.push(...CodeNodeStep.parents(u, edges, nodes, nodeOutputs, new Set([...seen, u])));
        continue;
      }
      const text = o?.output ?? null;
      if (text === null || text === '') continue;
      const start = (nodes[u]?.node_type ?? '') === 'start';
      const cfg = nodes[u]?.config ?? {};
      out.push({
        name: start ? 'start' : String(cfg.agent_name || cfg.name || `node_${u}`),
        text: typeof text === 'string' ? text : JSON.stringify(text),
        start,
      });
    }
    return out;
  },

  /**
   * What a code node's result means for the run (CodeNode.routeAfter): its output, the children on
   * the exit it took, and the children to skip. A failed run skips every child; an exit with no edge
   * ends that branch, which is not a failure.
   */
  routeAfter(data: { exit_targets: Record<string, any[]> }, result: Record<string, any>, children: any[]): CodeRoute {
    const kids = children.map(intval);
    if (!result.ok) {
      return { success: false, output: 'Error: ' + (result.error ?? 'code node failed'), exit: null, chosen: [], skip: kids };
    }
    const chosen = (data.exit_targets?.[result.route] ?? []).map(intval);
    return {
      success: true,
      output: String(result.output_text ?? ''),
      exit: result.route,
      chosen,
      skip: kids.filter((c) => !chosen.includes(c)),
    };
  },

  /** One line per code node that took its error exit: "code node '<name>' took its error exit: <reason>". */
  errorExits(nodeOutputs: Record<number, any>, nodes: Record<number, any>, order: number[] | null = null): string[] {
    const lines: string[] = [];
    const list = order !== null ? order.filter((id) => nodeOutputs[id] !== undefined).map((id) => [id, nodeOutputs[id]] as [number, any]) : entries(nodeOutputs);
    for (const [id, o] of list) {
      if ((o?.type ?? '') === 'code' && (o?.exit ?? null) === 'error') {
        const name = String(nodes[id]?.config?.name ?? '').trim() || 'Code';
        const reason = CodeNodeStep.reason(String(o.output ?? ''));
        lines.push(`code node '${name}' took its error exit` + (reason !== '' ? `: ${reason}` : ''));
      }
    }
    return lines;
  },

  /**
   * quiet: a code node ran, did not error, and no work node ran. drain: a code node ran, a work
   * node downstream of the exit it took ran, and nothing errored. A code node "ran" only when it
   * took an exit: a disabled one (no exit) neither quiets nor drains the run. An error exit or a
   * failed code node is never quiet and never drains: errors are always recorded.
   */
  summarize(nodeOutputs: Record<number, any>, edges: any[], nodes: Record<number, any>): { quiet: boolean; drain: boolean } {
    let codeRan = false;
    let errored = false;
    let worked = false;
    const behindExit = new Set<number>(); // node ids downstream of an exit a code node took
    for (const [id, o] of entries(nodeOutputs)) {
      const type = o?.type ?? '';
      if (WORK_TYPES.includes(type)) worked = true;
      if (type !== 'code') continue;
      if ((o.exit ?? null) === 'error' || o.success === false) {
        errored = true;
      } else if (typeof o.exit === 'string') {
        codeRan = true;
        for (const n of downstreamOfExit(id, o.exit, edges, nodes)) behindExit.add(n);
      }
    }
    let workedBehindExit = false;
    for (const id of behindExit) {
      if (WORK_TYPES.includes(nodeOutputs[id]?.type ?? '')) workedBehindExit = true;
    }
    return { quiet: codeRan && !errored && !worked, drain: codeRan && !errored && workedBehindExit };
  },
};

/** Every node reachable from the children on code node id's exit port. */
function downstreamOfExit(id: number, exit: string, edges: any[], nodes: Record<number, any>): Set<number> {
  const rawExits = nodes[id]?.config?.exits ?? ['next'];
  const exits: any[] = Array.isArray(rawExits) ? rawExits : Object.values(rawExits ?? {});
  const k = exits.indexOf(exit);
  const seen = new Set<number>();
  if (k < 0) return seen;
  const port = 'output_' + (k + 1);
  const todo: number[] = [];
  for (const e of edges) {
    if (intval(e.from_node_id) === id && (e.from_port ?? 'output_1') === port) todo.push(intval(e.to_node_id));
  }
  while (todo.length > 0) {
    const n = todo.pop() as number;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of edges) {
      if (intval(e.from_node_id) === n) todo.push(intval(e.to_node_id));
    }
  }
  return seen;
}
