<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/** What the compilers need from a code node (spec §2, §5): validated settings and exit -> children. */
final class CodeNodeEmit
{
    public const EXIT_RE = '/^[a-z][a-z0-9_]{0,31}$/';

    /** The playbook node's server slug rule (LoaderMcpExecutor::slug). */
    public static function slug(string $serverName): string
    {
        return strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $serverName));
    }

    public static function hasCodeNodes(array $graph): bool
    {
        foreach ($graph['nodes'] ?? [] as $n) {
            if (self::typeOf($n) === 'code') {
                return true;
            }
        }
        return false;
    }

    public static function refuseUnsupported(array $graph, string $target): void
    {
        if (self::hasCodeNodes($graph)) {
            throw new RuntimeException("Code nodes are not supported by the {$target} target yet. "
                . 'Compile this workflow with LangGraph (single file or agents in separate files).');
        }
    }

    /**
     * @param array $rawEdges  the graph's edges with from/from_node_id/source and from_port
     * @param array $slugToUrl server slug -> MCP server URL (the user's registry)
     * @param array|null $nodeIds the graph's node ids: an edge to any other id (dangling) is ignored
     */
    public static function nodeData(array $node, array $rawEdges, array $slugToUrl, ?array $nodeIds = null): array
    {
        $cfg = $node['config'] ?? $node['data'] ?? [];
        $cfg = is_array($cfg) ? $cfg : [];
        $nid = (string) ($node['id'] ?? '');
        $display = trim((string) ($cfg['name'] ?? '')) ?: 'Code';
        $fail = fn(string $why) => throw new RuntimeException("Code node '{$display}' ({$nid}): {$why}");
        if (!empty($cfg['code_component_missing'])) {
            throw new RuntimeException("Code component #{$cfg['code_component_id']} not found (node {$display}).");
        }

        $exits = $cfg['exits'] ?? ['next'];
        if (!is_array($exits) || $exits === [] || count($exits) > 8 || count(array_unique($exits)) !== count($exits)) {
            $fail('exits must be 1 to 8 unique names');
        }
        foreach ($exits as $e) {
            if (!is_string($e) || !preg_match(self::EXIT_RE, $e)) {
                $fail('exit names are lowercase letters, digits and _ (got ' . json_encode($e) . ')');
            }
        }
        // The MCP servers checked on the node (names, as the agent nodes keep them); call_tool may
        // reach any tool on them, by the server's slug.
        $names = $cfg['mcp_servers'] ?? [];
        if (!is_array($names)) {
            $fail('mcp_servers must be a list of MCP server names');
        }
        $slugs = [];
        $servers = [];
        foreach ($names as $name) {
            $slug = is_string($name) ? self::slug($name) : '';
            if (!isset($slugToUrl[$slug])) {
                $fail('MCP server ' . json_encode($name) . ' is not one of your MCP servers');
            }
            $slugs[$slug] = true;
            $servers[$slugToUrl[$slug]] = true;
        }
        $timeout = $cfg['timeout_s'] ?? 30;
        if (!is_int($timeout) || $timeout < 1 || $timeout > 300) {
            $fail('timeout_s must be 1 to 300 seconds');
        }
        $targets = array_fill_keys($exits, []);
        $known = $nodeIds === null ? null : array_fill_keys(array_map('strval', $nodeIds), true);
        foreach ($rawEdges as $e) {
            $from = (string) ($e['from'] ?? $e['from_node_id'] ?? $e['source'] ?? '');
            $to = (string) ($e['to'] ?? $e['to_node_id'] ?? $e['target'] ?? '');
            if ($from !== $nid || $to === '' || ($known !== null && !isset($known[$to]))) {
                continue;
            }
            $k = (int) preg_replace('/^output_/', '', (string) ($e['from_port'] ?? 'output_1'));
            if ($k >= 1 && $k <= count($exits)) {
                $targets[$exits[$k - 1]][] = $to;
            }
        }
        return ['display' => $display, 'kind' => 'code', 'source' => (string) ($cfg['code'] ?? ''),
            'exits' => array_values($exits), 'mcp_servers' => array_keys($slugs), 'timeout_s' => $timeout,
            'exit_targets' => $targets, 'servers' => array_keys($servers)];
    }

    private static function typeOf(array $n): string
    {
        return WorkflowGraphAnalyzer::typeOf($n);
    }
}
