import {
  array_unique, count, elvis, empty, has, intval, is_array, is_string, json_encode, oarr, preg_match, preg_replace, strtolower,
  strval, trim, values,
} from './compiler/php';

/**
 * What the runner (and the compilers) need from a code node: validated settings and exit ->
 * children. Mirrors backend/src/AgentTeam/Services/CodeNodeEmit.php, PHP shapes included:
 * exit_targets is an insertion-ordered PHP array (oarr), and mcp_servers / servers are
 * array_keys() lists (a canonical-integer key comes back as an int, as in PHP).
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

/** PHP array_keys(): a key that is a canonical decimal integer comes back as an int. */
function phpArrayKeys(a: Record<string, any>): any[] {
  return Object.keys(a).map((k) => (/^(0|-?[1-9]\d*)$/.test(k) && Number.isSafeInteger(Number(k)) ? Number(k) : k));
}

/** WorkflowGraphAnalyzer::typeOf: node_type, then type, then config.type (an empty value falls through). */
function typeOf(n: any): string {
  for (const t of [n?.['node_type'], n?.['type'], n?.['config']?.['type']]) {
    if (t !== null && t !== undefined && strval(t) !== '') return strval(t);
  }
  return 'agent';
}

export const CodeNodeEmit = {
  EXIT_RE: /^[a-z][a-z0-9_]{0,31}$/,

  /** The playbook node's server slug rule (LoaderMcpExecutor::slug). */
  slug(serverName: string): string {
    return strtolower(preg_replace('/[^a-z0-9]+/i', '_', strval(serverName)));
  },

  hasCodeNodes(graph: any): boolean {
    for (const n of values(graph?.['nodes'] ?? [])) {
      if (typeOf(n) === 'code') return true;
    }
    return false;
  },

  refuseUnsupported(graph: any, target: string): void {
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
  nodeData(node: any, rawEdges: any, slugToUrl: Record<string, string>, nodeIds: any = null): CodeNodeData {
    const raw = node?.['config'] ?? node?.['data'] ?? [];
    const cfg: any = is_array(raw) ? raw : [];
    const nid = strval(node?.['id'] ?? '');
    const display = elvis(trim(strval(cfg['name'] ?? '')), 'Code');
    const fail = (why: string): never => {
      throw new Error(`Code node '${display}' (${nid}): ${why}`);
    };
    if (!empty(cfg['code_component_missing'])) {
      throw new Error(`Code component #${strval(cfg['code_component_id'])} not found (node ${display}).`);
    }

    const exits = cfg['exits'] ?? ['next'];
    if (!is_array(exits) || count(exits) === 0 || count(exits) > 8 || count(array_unique(exits)) !== count(exits)) {
      fail('exits must be 1 to 8 unique names');
    }
    for (const e of values(exits)) {
      if (!is_string(e) || !preg_match('/^[a-z][a-z0-9_]{0,31}$/', e)) {
        fail('exit names are lowercase letters, digits and _ (got ' + json_encode(e) + ')');
      }
    }
    // The MCP servers checked on the node (names, as the agent nodes keep them); call_tool may
    // reach any tool on them, by the server's slug.
    const names = cfg['mcp_servers'] ?? [];
    if (!is_array(names)) fail('mcp_servers must be a list of MCP server names');
    const slugs = oarr<boolean>();
    const servers = oarr<boolean>();
    for (const name of values(names)) {
      const slug = is_string(name) ? CodeNodeEmit.slug(name) : '';
      if (!has(slugToUrl, slug)) {
        fail('MCP server ' + json_encode(name) + ' is not one of your MCP servers');
      }
      slugs[slug] = true;
      servers[strval(slugToUrl[slug])] = true;
    }
    const timeout = cfg['timeout_s'] ?? 30;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
      fail('timeout_s must be 1 to 300 seconds');
    }
    const exitList = values<string>(exits).slice();
    const targets = CodeNodeEmit.exitTargets(nid, exitList, rawEdges, nodeIds);
    // args: a component's settings, or a Start option's Start args (StartOptionGraph); the code reads them as ARGS.
    const args = is_array(cfg['args'] ?? null) ? cfg['args'] : [];
    return {
      display, kind: 'code', source: strval(cfg['code'] ?? ''), exits: exitList, mcp_servers: phpArrayKeys(slugs),
      timeout_s: timeout, exit_targets: targets, servers: phpArrayKeys(servers), args,
    };
  },

  /**
   * The port -> exit rule shared by code and playbook nodes: an edge leaving port output_k goes to
   * the k-th exit's targets (ports outside the exit list, and dangling edges when nodeIds is given,
   * are ignored). Returns exit name -> target node ids as an insertion-ordered PHP array (oarr).
   */
  exitTargets(nid: string, exits: string[], rawEdges: any, nodeIds: any = null): Record<string, string[]> {
    const exitList = values<any>(exits);
    const targets = oarr<string[]>();
    for (const e of exitList) targets[strval(e)] = [];
    const known = nodeIds === null || nodeIds === undefined ? null : new Set(values(nodeIds).map((x: any) => strval(x)));
    for (const e of values<any>(rawEdges ?? [])) {
      const from = strval(e?.['from'] ?? e?.['from_node_id'] ?? e?.['source'] ?? '');
      const to = strval(e?.['to'] ?? e?.['to_node_id'] ?? e?.['target'] ?? '');
      if (from !== nid || to === '' || (known !== null && !known.has(to))) continue;
      const k = intval(preg_replace('/^output_/', '', strval(e?.['from_port'] ?? 'output_1')));
      if (k >= 1 && k <= exitList.length) targets[strval(exitList[k - 1])].push(to);
    }
    return targets;
  },
};

