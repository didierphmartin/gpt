"""Port of backend/src/AgentTeam/Services/StartOptionGraph.php.

A Start node on a Start option (config.start_option = a code component id, spec 2026-10-13 §10) IS that
component on the canvas: one output port per exit. Runners and compilers know a code node, not that, so
the graph they read (WorkflowGraphRepository.getGraph) has Start expanded into Start -> a code node linked
to the component, which takes over Start's edges on their ports. The editor never sees the extra node.
"""
from __future__ import annotations

from collections.abc import Callable

from app.support.phpcompat import php_empty, php_intval, php_strval


class StartOptionGraph:
    # The extra node's id: Start's id plus this, an integer (runners cast ids) no workflow_nodes row reaches.
    ID_OFFSET = 1000000000

    @staticmethod
    def isStart(node: dict) -> bool:
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        nodeType = node.get('node_type') if node.get('node_type') is not None else ''
        return nodeType == 'start' if nodeType != '' else cfg.get('type') == 'start'

    @classmethod
    def optionId(cls, node: dict) -> int | None:
        """The option's component id on a Start node, or None."""
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        id = php_intval(cfg.get('start_option') if cfg.get('start_option') is not None else 0)
        return id if cls.isStart(node) and id > 0 else None

    @classmethod
    def expand(cls, graph: dict, componentFor: Callable[[int], dict | None]) -> dict:
        """graph: {nodes, edges} as getGraph() reads them (rows). componentFor(id): the component row
        ({name, code, exits, mcp_servers, timeout_s, start_trigger}) or None. A Start whose component is gone
        or no longer an option is left as it is."""
        nodes = list(graph.get('nodes') or [])
        edges = [dict(e) for e in (graph.get('edges') or [])]
        for start in list(nodes):
            cid = cls.optionId(start)
            c = None if cid is None else componentFor(cid)
            if c is None or php_empty(c.get('start_trigger')):
                continue
            startId = php_strval(start['id'])
            id = php_strval(cls.ID_OFFSET + php_intval(startId))
            startCfg = start.get('config') if isinstance(start.get('config'), dict) else {}
            sa = startCfg.get('start_args')
            label = c['start_trigger'].get('label') if isinstance(c['start_trigger'], dict) else None
            nodes.append({
                'id': id, 'workflow_id': start.get('workflow_id'), 'node_type': 'code', 'agent_id': None,
                'config': {'type': 'code', 'name': php_strval(label if label is not None else c['name']),
                           'code_component_id': cid, 'code': c['code'], 'exits': c['exits'],
                           'mcp_servers': c['mcp_servers'], 'timeout_s': c['timeout_s'],
                           'start_trigger': c.get('start_trigger'),
                           'args': sa if isinstance(sa, (dict, list)) else []},
                'pos_x': php_intval(start.get('pos_x') if start.get('pos_x') is not None else 0) + 1,
                'pos_y': php_intval(start.get('pos_y') if start.get('pos_y') is not None else 0),
                'drawflow_node_id': None})
            for e in edges:
                if php_strval(e['from_node_id']) == startId:
                    e['from_node_id'] = id
            edges.append({'id': id, 'workflow_id': start.get('workflow_id'), 'from_node_id': startId, 'to_node_id': id,
                          'from_port': 'output_1', 'to_port': 'input_1', 'condition_expr': None})
        return {'nodes': nodes, 'edges': edges}
