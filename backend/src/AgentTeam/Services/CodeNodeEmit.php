<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/** What the compilers need from a code node (spec §2, §5): validated settings and exit -> children. */
final class CodeNodeEmit
{
    private const EXIT_RE = '/^[a-z][a-z0-9_]{0,31}$/';
    private const TOOL_RE = '/^([a-z0-9_]{1,64})\.([A-Za-z0-9_.-]{1,128})$/';

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
     */
    public static function nodeData(array $node, array $rawEdges, array $slugToUrl): array
    {
        $cfg = $node['config'] ?? $node['data'] ?? [];
        $cfg = is_array($cfg) ? $cfg : [];
        $nid = (string) ($node['id'] ?? '');
        $display = trim((string) ($cfg['name'] ?? '')) ?: 'Code';
        $fail = fn(string $why) => throw new RuntimeException("Code node '{$display}' ({$nid}): {$why}");

        $exits = $cfg['exits'] ?? ['next'];
        if (!is_array($exits) || $exits === [] || count($exits) > 8 || count(array_unique($exits)) !== count($exits)) {
            $fail('exits must be 1 to 8 unique names');
        }
        foreach ($exits as $e) {
            if (!is_string($e) || !preg_match(self::EXIT_RE, $e)) {
                $fail('exit names are lowercase letters, digits and _ (got ' . json_encode($e) . ')');
            }
        }
        $tools = $cfg['mcp_tools'] ?? [];
        $servers = [];
        foreach (is_array($tools) ? $tools : [] as $t) {
            if (!is_string($t) || !preg_match(self::TOOL_RE, $t, $m)) {
                $fail('tools are "server.tool" (got ' . json_encode($t) . ')');
            }
            if (!isset($slugToUrl[$m[1]])) {
                $fail("MCP server '{$m[1]}' is not one of your MCP servers");
            }
            $servers[$slugToUrl[$m[1]]] = true;
        }
        $timeout = $cfg['timeout_s'] ?? 30;
        if (!is_int($timeout) || $timeout < 1 || $timeout > 300) {
            $fail('timeout_s must be 1 to 300 seconds');
        }
        $targets = array_fill_keys($exits, []);
        foreach ($rawEdges as $e) {
            $from = (string) ($e['from'] ?? $e['from_node_id'] ?? $e['source'] ?? '');
            $to = (string) ($e['to'] ?? $e['to_node_id'] ?? $e['target'] ?? '');
            if ($from !== $nid || $to === '') {
                continue;
            }
            $k = (int) preg_replace('/^output_/', '', (string) ($e['from_port'] ?? 'output_1'));
            if ($k >= 1 && $k <= count($exits)) {
                $targets[$exits[$k - 1]][] = $to;
            }
        }
        return ['display' => $display, 'kind' => 'code', 'source' => (string) ($cfg['code'] ?? ''),
            'exits' => array_values($exits), 'tools' => array_values($tools ?: []), 'timeout_s' => $timeout,
            'exit_targets' => $targets, 'servers' => array_keys($servers)];
    }

    private static function typeOf(array $n): string
    {
        return WorkflowGraphAnalyzer::typeOf($n);
    }
}
