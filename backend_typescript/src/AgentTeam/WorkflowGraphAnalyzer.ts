/**
 * The run-time graph helpers of backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php that the workflow runner
 * (GraphWorkflowRunner, StartTriggerFacts) reads: reachableGraph and typeOf. The compilers use the full port,
 * compiler/GraphAnalyzer.ts (analyzeGraph, analyze, the tool catalog), which keeps PHP's array shapes.
 */
export class WorkflowGraphAnalyzer {
  /**
   * The part of a {nodes, edges} graph a run reaches: the start node(s) and everything downstream
   * of them. A node left unconnected on the canvas (kept for later, or to compare a run with and
   * without it) is not part of the workflow, so it is dropped with its edges. A graph with no start
   * node is returned unchanged. Other keys of the graph are kept. Mirrors
   * WorkflowGraphAnalyzer::reachableGraph.
   */
  static reachableGraph<G extends { nodes?: any[]; edges?: any[] }>(graph: G): G {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];
    const edgeFrom = (e: any) => String(e?.from ?? e?.from_node_id ?? e?.source ?? '');
    const children = new Map<string, string[]>();
    for (const e of edges) {
      const from = edgeFrom(e);
      const to = String(e?.to ?? e?.to_node_id ?? e?.target ?? '');
      if (from !== '' && to !== '') {
        if (!children.has(from)) children.set(from, []);
        children.get(from)!.push(to);
      }
    }
    const queue: string[] = [];
    for (const n of nodes) {
      if (WorkflowGraphAnalyzer.typeOf(n) === 'start') queue.push(String(n?.id ?? ''));
    }
    if (queue.length === 0) return graph;
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      for (const c of children.get(id) ?? []) queue.push(c);
    }
    return {
      ...graph,
      nodes: nodes.filter((n) => seen.has(String(n?.id ?? ''))),
      edges: edges.filter((e) => seen.has(edgeFrom(e))),
    };
  }

  /**
   * Canonical node type — accepts the DSL fields used across all code paths:
   *   node.node_type, node.type, node.config.type
   *
   * Field precedence mirrors LangGraphGenerator's nodeType(): node_type first.
   */
  static typeOf(n: any): string {
    // The DB column can be '' for editor-saved agent-template nodes: an empty value falls through
    // to config.type (else those nodes vanished from every reader of the type).
    for (const t of [n?.node_type, n?.type, n?.config?.type]) {
      if (t !== null && t !== undefined && String(t) !== '') return String(t);
    }
    return 'agent';
  }
}
