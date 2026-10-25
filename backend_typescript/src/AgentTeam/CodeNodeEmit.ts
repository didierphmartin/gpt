import { WorkflowGraphAnalyzer } from './WorkflowGraphAnalyzer';

/**
 * What the runner (and the compilers) need from a code node: validated settings and exit ->
 * children. Mirrors backend/src/AgentTeam/Services/CodeNodeEmit.php.
 */
export interface CodeNodeData {
  display: string;
  kind: 'code';
  source: string;
  exits: string[];
  mcp_servers: string[];
  timeout_s: number;
  exit_targets: Record<string, string[]>;
  servers: string[];
  args: Record<string, any> | any[];
}

export const CodeNodeEmit = {
  EXIT_RE: /^[a-z][a-z0-9_]{0,31}$/,

  /** The playbook node's server slug rule (LoaderMcpExecutor::slug). */
  slug(serverName: string): string {
    return serverName.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  },

  hasCodeNodes(graph: { nodes?: any[] }): boolean {
    return (graph?.nodes ?? []).some((n) => WorkflowGraphAnalyzer.typeOf(n) === 'code');
  },

  refuseUnsupported(graph: { nodes?: any[] }, target: string): void {
    if (CodeNodeEmit.hasCodeNodes(graph)) {
      throw new Error(
        `Code nodes are not supported by the ${target} target yet. ` +
          'Compile this workflow with LangGraph (single file or agents in separate files).'
      );
    }
  },

  /**
   * @param rawEdges  the graph's edges with from/from_node_id/source and from_port
   * @param slugToUrl server slug -> MCP server URL (the user's registry)
   * @param nodeIds   the graph's node ids: an edge to any other id (dangling) is ignored
   */
  nodeData(node: any, rawEdges: any[], slugToUrl: Record<string, string>, nodeIds: Array<string | number> | null = null): CodeNodeData {
    const raw = node?.config ?? node?.data ?? {};
    const cfg: Record<string, any> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const nid = String(node?.id ?? '');
    const display = String(cfg.name ?? '').trim() || 'Code';
    const fail = (why: string): never => {
      throw new Error(`Code node '${display}' (${nid}): ${why}`);
    };
    if (!phpEmpty(cfg.code_component_missing)) {
      throw new Error(`Code component #${cfg.code_component_id} not found (node ${display}).`);
    }

    const exits = cfg.exits ?? ['next'];
    if (!Array.isArray(exits) || exits.length === 0 || exits.length > 8 || new Set(exits).size !== exits.length) {
      fail('exits must be 1 to 8 unique names');
    }
    for (const e of exits as any[]) {
      if (typeof e !== 'string' || !CodeNodeEmit.EXIT_RE.test(e)) {
        fail('exit names are lowercase letters, digits and _ (got ' + JSON.stringify(e) + ')');
      }
    }
    // The MCP servers checked on the node (names, as the agent nodes keep them); call_tool may
    // reach any tool on them, by the server's slug.
    const names = cfg.mcp_servers ?? [];
    if (!Array.isArray(names)) fail('mcp_servers must be a list of MCP server names');
    const slugs: string[] = [];
    const servers: string[] = [];
    for (const name of names as any[]) {
      const slug = typeof name === 'string' ? CodeNodeEmit.slug(name) : '';
      if (!Object.hasOwn(slugToUrl, slug)) {
        fail('MCP server ' + JSON.stringify(name) + ' is not one of your MCP servers');
      }
      if (!slugs.includes(slug)) slugs.push(slug);
      if (!servers.includes(slugToUrl[slug])) servers.push(slugToUrl[slug]);
    }
    const timeout = cfg.timeout_s ?? 30;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
      fail('timeout_s must be 1 to 300 seconds');
    }
    const exitList = (exits as string[]).slice();
    const targets = CodeNodeEmit.exitTargets(nid, exitList, rawEdges, nodeIds);
    // args: a component's settings, or a Start option's Start args; the code reads them as ARGS.
    const args = cfg.args !== null && typeof cfg.args === 'object' ? cfg.args : [];
    return {
      display, kind: 'code', source: String(cfg.code ?? ''), exits: exitList, mcp_servers: slugs,
      timeout_s: timeout, exit_targets: targets, servers, args,
    };
  },

  /**
   * The port -> exit rule shared by code and playbook nodes: an edge leaving port output_k goes to
   * the k-th exit's targets (ports outside the exit list, and dangling edges when nodeIds is given,
   * are ignored).
   */
  exitTargets(nid: string, exits: string[], rawEdges: any[], nodeIds: Array<string | number> | null = null): Record<string, string[]> {
    const targets: Record<string, string[]> = {};
    for (const e of exits) targets[e] = [];
    const known = nodeIds === null ? null : new Set(nodeIds.map(String));
    for (const e of rawEdges ?? []) {
      const from = String(e?.from ?? e?.from_node_id ?? e?.source ?? '');
      const to = String(e?.to ?? e?.to_node_id ?? e?.target ?? '');
      if (from !== nid || to === '' || (known !== null && !known.has(to))) continue;
      const k = parseInt(String(e?.from_port ?? 'output_1').replace(/^output_/, ''), 10) || 0;
      if (k >= 1 && k <= exits.length) targets[exits[k - 1]].push(to);
    }
    return targets;
  },
};

function phpEmpty(v: any): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}
