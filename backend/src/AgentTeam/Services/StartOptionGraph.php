<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * A Start node on a Start option (config.start_option = a code component id, spec 2026-10-13 §10) IS that
 * component on the canvas: one output port per exit. Runners and compilers know a code node, not that, so
 * the graph they read (WorkflowGraphRepository::getGraph) has Start expanded into Start -> a code node linked
 * to the component, which takes over Start's edges on their ports. The editor never sees the extra node.
 */
final class StartOptionGraph
{
    /** The extra node's id: Start's id plus this, an integer (runners cast ids) no workflow_nodes row reaches. */
    public const ID_OFFSET = 1000000000;

    public static function isStart(array $node): bool
    {
        $cfg = is_array($node['config'] ?? null) ? $node['config'] : [];
        return ($node['node_type'] ?? '') !== '' ? $node['node_type'] === 'start' : ($cfg['type'] ?? null) === 'start';
    }

    /** The option's component id on a Start node, or null. */
    public static function optionId(array $node): ?int
    {
        $id = (int) (($node['config'] ?? [])['start_option'] ?? 0);
        return self::isStart($node) && $id > 0 ? $id : null;
    }

    /**
     * $graph: {nodes, edges} as getGraph() reads them (rows). $componentFor(int $id): the component row
     * ({name, code, exits, mcp_servers, timeout_s, start_trigger}) or null. A Start whose component is gone
     * or no longer an option is left as it is.
     */
    public static function expand(array $graph, callable $componentFor): array
    {
        $nodes = $graph['nodes'] ?? [];
        $edges = $graph['edges'] ?? [];
        foreach ($nodes as $start) {
            $cid = self::optionId($start);
            $c = $cid === null ? null : $componentFor($cid);
            if ($c === null || empty($c['start_trigger'])) {
                continue;
            }
            $startId = (string) $start['id'];
            $id = (string) (self::ID_OFFSET + (int) $startId);
            $nodes[] = ['id' => $id, 'workflow_id' => $start['workflow_id'] ?? null, 'node_type' => 'code', 'agent_id' => null,
                'config' => ['type' => 'code', 'name' => (string) ($c['start_trigger']['label'] ?? $c['name']),
                    'code_component_id' => $cid, 'code' => $c['code'], 'exits' => $c['exits'],
                    'mcp_servers' => $c['mcp_servers'], 'timeout_s' => $c['timeout_s'],
                    'start_trigger' => $c['start_trigger'] ?? null,
                    'args' => is_array($sa = ($start['config'] ?? [])['start_args'] ?? null) ? $sa : []],
                'pos_x' => (int) ($start['pos_x'] ?? 0) + 1, 'pos_y' => (int) ($start['pos_y'] ?? 0), 'drawflow_node_id' => null];
            foreach ($edges as &$e) {
                if ((string) $e['from_node_id'] === $startId) {
                    $e['from_node_id'] = $id;
                }
            }
            unset($e);
            $edges[] = ['id' => $id, 'workflow_id' => $start['workflow_id'] ?? null, 'from_node_id' => $startId, 'to_node_id' => $id,
                'from_port' => 'output_1', 'to_port' => 'input_1', 'condition_expr' => null];
        }
        return ['nodes' => $nodes, 'edges' => $edges];
    }
}
