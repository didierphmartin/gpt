/**
 * A Start node on a Start option (config.start_option = a code component id, spec 2026-10-13 §10) IS that
 * component on the canvas: one output port per exit. Runners and compilers know a code node, not that, so
 * the graph they read (WorkflowGraphRepository.getGraph) has Start expanded into Start -> a code node linked
 * to the component, which takes over Start's edges on their ports. The editor never sees the extra node.
 * Mirrors backend/src/AgentTeam/Services/StartOptionGraph.php.
 */
function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object';
}

function intval(v: any): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

export const StartOptionGraph = {
  /** The extra node's id: Start's id plus this, an integer (runners cast ids) no workflow_nodes row reaches. */
  ID_OFFSET: 1000000000,

  isStart(node: any): boolean {
    const cfg = isObj(node?.config) ? node.config : {};
    const t = node?.node_type ?? '';
    return t !== '' ? t === 'start' : (cfg.type ?? null) === 'start';
  },

  /** The option's component id on a Start node, or null. */
  optionId(node: any): number | null {
    const cfg = isObj(node?.config) ? node.config : {};
    const id = intval(cfg.start_option ?? 0);
    return StartOptionGraph.isStart(node) && id > 0 ? id : null;
  },

  /**
   * graph: {nodes, edges} as getGraph() reads them (rows). componentFor(id): the component row
   * ({name, code, exits, mcp_servers, timeout_s, start_trigger}) or null. A Start whose component is gone
   * or no longer an option is left as it is.
   */
  async expand(graph: { nodes?: any[]; edges?: any[] },
    componentFor: (id: number) => Promise<Record<string, any> | null> | Record<string, any> | null): Promise<{ nodes: any[]; edges: any[] }> {
    const nodes = [...(graph.nodes ?? [])];
    const edges = (graph.edges ?? []).map((e) => e);
    for (const start of graph.nodes ?? []) {
      const cid = StartOptionGraph.optionId(start);
      const c = cid === null ? null : await componentFor(cid);
      if (c === null || c === undefined || !c.start_trigger) {
        continue;
      }
      const startId = String(start.id);
      const id = String(StartOptionGraph.ID_OFFSET + intval(startId));
      const sa = isObj(start.config) ? start.config.start_args : null;
      nodes.push({
        id, workflow_id: start.workflow_id ?? null, node_type: 'code', agent_id: null,
        config: {
          type: 'code', name: String(c.start_trigger?.label ?? c.name), code_component_id: cid, code: c.code, exits: c.exits,
          mcp_servers: c.mcp_servers, timeout_s: c.timeout_s, arg_decls: c.args ?? [], start_trigger: c.start_trigger ?? null,
          args: isObj(sa) ? sa : [],
        },
        pos_x: intval(start.pos_x ?? 0) + 1, pos_y: intval(start.pos_y ?? 0), drawflow_node_id: null,
      });
      for (let i = 0; i < edges.length; i++) {
        if (String(edges[i].from_node_id) === startId) {
          edges[i] = { ...edges[i], from_node_id: id };
        }
      }
      edges.push({
        id, workflow_id: start.workflow_id ?? null, from_node_id: startId, to_node_id: id,
        from_port: 'output_1', to_port: 'input_1', condition_expr: null,
      });
    }
    return { nodes, edges };
  },
};
