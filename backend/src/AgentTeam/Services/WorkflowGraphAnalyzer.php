<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use PDO;

/**
 * WorkflowGraphAnalyzer
 *
 * Shared DSL-analysis front half for workflow compilers (LangGraph, ADK, etc.).
 *
 * Provides:
 *  - static analyzeGraph(array $graph): array  — pure, DB-free; normalises nodes/edges,
 *    builds adjacency maps, topological layers, and locates the start node.
 *  - static typeOf(array $node): string        — canonical node type from any DSL variant.
 *  - analyze(int $workflowId, ?string $userId): array — DB-backed; loads graph, enriches
 *    with agents/tools/servers from the database.
 *
 * Input DSL is the {nodes, edges} shape produced by WorkflowGraphRepository::getGraph().
 * Byte-identical contract to LangGraphGenerator — no reinterpretation of node/edge fields.
 */
class WorkflowGraphAnalyzer
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    // --------------------------------------------------------------------------
    // Public static: pure graph analysis (no DB, no side effects)
    // --------------------------------------------------------------------------

    /**
     * Pure, DB-free analysis of a {nodes, edges} graph.
     *
     * Accepts all edge-field aliases used across the DSL:
     *   from / from_node_id / source   →  from
     *   to   / to_node_id   / target   →  to
     *
     * Returns:
     *   byId        array<string,array>   node keyed by string id
     *   order       string[]              topological node-id order (Kahn)
     *   edges       array<int,array{from:string,to:string}>  normalised
     *   children    array<string,string[]> node id → child ids
     *   parents     array<string,string[]> node id → parent ids
     *   layers      string[][]            topological layers (layer 0 = roots)
     *   startNodeId string                id of the first 'start' node found
     */
    public static function analyzeGraph(array $graph): array
    {
        $nodes = $graph['nodes'] ?? [];
        $edges = $graph['edges'] ?? [];

        // Index nodes by string id.
        $byId = [];
        foreach ($nodes as $n) {
            $id = (string) ($n['id'] ?? '');
            if ($id === '') {
                continue;
            }
            $byId[$id] = $n;
        }

        // Normalise edges; build adjacency maps.
        $norm     = [];
        $children = [];
        $parents  = [];
        foreach ($byId as $id => $_) {
            $children[$id] = [];
            $parents[$id]  = [];
        }
        foreach ($edges as $e) {
            $from = (string) ($e['from'] ?? $e['from_node_id'] ?? $e['source'] ?? '');
            $to   = (string) ($e['to']   ?? $e['to_node_id']   ?? $e['target'] ?? '');
            if ($from === '' || $to === '' || !isset($byId[$from]) || !isset($byId[$to])) {
                continue;
            }
            $norm[]           = ['from' => $from, 'to' => $to];
            $children[$from][] = $to;
            $parents[$to][]   = $from;
        }

        // Topological layers via Kahn (longest-path level assignment).
        // Each node is assigned the maximum depth over all paths from any root.
        $indeg = [];
        foreach ($byId as $id => $_) {
            $indeg[$id] = count($parents[$id]);
        }
        $level = [];
        $queue = [];
        foreach ($indeg as $id => $d) {
            $id = (string) $id;
            if ($d === 0) {
                $queue[]    = $id;
                $level[$id] = 0;
            }
        }
        $order = [];
        $work  = $indeg;
        while ($queue) {
            $id      = (string) array_shift($queue);
            $order[] = $id;
            foreach ($children[$id] as $c) {
                $level[$c] = max($level[$c] ?? 0, ($level[$id] ?? 0) + 1);
                if (--$work[$c] === 0) {
                    $queue[] = $c;
                }
            }
        }
        if (count($order) !== count($byId)) {
            throw new \RuntimeException('Workflow graph has a cycle or disconnected node');
        }

        $layers = [];
        foreach ($level as $id => $lv) {
            // Cast to string: PHP auto-coerces numeric string keys to ints when
            // they appear as array keys, so $id here may be int — force string.
            $layers[$lv][] = (string) $id;
        }
        ksort($layers);
        $layers = array_values($layers);

        // Locate start node.
        // Cast to string: PHP auto-coerces numeric string array keys to int,
        // so $id from foreach ($byId as $id => _) may be int without the cast.
        $startNodeId = '';
        foreach ($byId as $id => $n) {
            if (self::typeOf($n) === 'start') {
                $startNodeId = (string) $id;
                break;
            }
        }

        return [
            'byId'        => $byId,
            'order'       => $order,
            'edges'       => $norm,
            'children'    => $children,
            'parents'     => $parents,
            'layers'      => $layers,
            'startNodeId' => $startNodeId,
        ];
    }

    /**
     * Canonical node type — accepts the DSL fields used across all code paths:
     *   node['node_type'], node['type'], node['config']['type']
     *
     * Field precedence mirrors LangGraphGenerator::nodeType(): node_type first.
     */
    public static function typeOf(array $n): string
    {
        return (string) ($n['node_type'] ?? $n['type'] ?? ($n['config']['type'] ?? 'agent'));
    }

    /**
     * Ordered skill bindings for an agent node's config. Prefers the structured
     * bound_skill (dir-backed, read live from disk at runtime); falls back to the
     * legacy inline skill_content string. Returns [] when the node has no skill.
     * Phase 1 supports one skill; the return is a list so N skills need no change.
     */
    public static function skillsFromConfig(array $config): array
    {
        $out = [];
        $bs = $config['bound_skill'] ?? null;
        if (is_array($bs) && trim((string) ($bs['dir_name'] ?? '')) !== '') {
            $out[] = ['dir' => trim((string) $bs['dir_name'])];
        } elseif (trim((string) ($config['skill_content'] ?? '')) !== '') {
            $out[] = ['inline' => (string) $config['skill_content']];
        }
        return $out;
    }

    // --------------------------------------------------------------------------
    // Public instance: DB-backed full analysis
    // --------------------------------------------------------------------------

    /**
     * Load a workflow from the DB, run analyzeGraph(), and enrich the result
     * with agent details, the MCP tool/server catalog filtered to only tools
     * that agents in this workflow actually use, and start-node metadata.
     *
     * @return array{
     *   workflow: array{id:int,name:string},
     *   byId: array<string,array>,
     *   order: string[],
     *   agents: array<string,array>,
     *   edges: array<int,array{from:string,to:string}>,
     *   children: array<string,string[]>,
     *   parents: array<string,string[]>,
     *   layers: string[][],
     *   startNodeId: string,
     *   usedCatalog: array<string,array>,
     *   usedServers: array<string,array>,
     *   startPrompt: string,
     *   startDocuments: array,
     * }
     */
    public function analyze(int $workflowId, ?string $userId = null): array
    {
        $wf = $this->workflowRepo->findById($workflowId);
        if (!$wf) {
            throw new \RuntimeException('Workflow not found');
        }
        $graph = $this->graphRepo->getGraph($workflowId);
        $base  = self::analyzeGraph($graph);

        // Build the agents map — only agent/agent-template nodes.
        $agents = [];
        foreach ($base['order'] as $id) {
            $n = $base['byId'][$id];
            if (!in_array(self::typeOf($n), ['agent', 'agent-template'], true)) {
                continue;
            }
            $c     = $n['config'] ?? [];
            // Read agent_id from node root or config, matching LangGraphGenerator line 350.
            $agentId = $n['agent_id'] ?? ($c['agent_id'] ?? null);
            $tools   = $c['selectedTools'] ?? $c['tools'] ?? [];
            if (!is_array($tools)) {
                $tools = [];
            }
            // agent_id fallback: when inline tool list is empty, pull tools from
            // the agent DB record — mirrors LangGraphGenerator lines 380–416.
            if ($agentId !== null && $agentId !== '') {
                try {
                    $agent = $this->agentRepo->findById((int) $agentId);
                    if ($agent !== null) {
                        $agentArr   = $agent->toArray();
                        $agentTools = $agentArr['tools'] ?? null;
                        if (empty($tools) && is_array($agentTools)) {
                            foreach ($agentTools as $tool) {
                                $tname = null;
                                if (is_string($tool)) {
                                    $tname = $tool;
                                } elseif (is_array($tool)) {
                                    $tname = $tool['name'] ?? $tool['tool_name'] ?? null;
                                }
                                if ($tname) {
                                    if (strpos($tname, 'mcp_') === 0) {
                                        $tname = substr($tname, 4);
                                    }
                                    $tools[] = $tname;
                                }
                            }
                        }
                    }
                } catch (\Throwable $_) {
                    // Swallow: matches Python's broad except in LangGraphGenerator.
                }
            }
            $agents[$id] = [
                'name'             => (string) ($c['agent_name'] ?? "agent_$id"),
                'systemPrompt'     => (string) ($c['systemPrompt'] ?? $c['instructions'] ?? ''),
                'provider'         => (string) ($c['agent_provider'] ?? $c['provider'] ?? $c['llm_provider'] ?? 'claude'),
                'model'            => (string) ($c['model'] ?? ''),
                'temperature'      => $c['settings']['temperature'] ?? null,
                'max_tokens'       => $c['settings']['max_tokens'] ?? null,
                // Per-agent Thinking switch ('on'|'off'|null=provider default) —
                // the node form attribute added 2026-07-17; compile targets
                // honor it the same way AgentRunner/providers do in-platform.
                'thinking'         => (in_array($c['settings']['thinking'] ?? null, ['on', 'off'], true)
                                        ? $c['settings']['thinking'] : null),
                'tools'            => array_values(array_map('strval', is_array($tools) ? $tools : [])),
                'skill_content'    => (string) ($c['skill_content'] ?? ''),
                'skills'           => self::skillsFromConfig($c),
                'output_schema_id' => $c['output_schema_id'] ?? null,
                'documents'        => $c['documents'] ?? [],
            ];
        }

        // Resolve empty models to the provider's default (system_llm_settings.model) —
        // the same source LangGraphGenerator uses and the "Default: <name>" the editor
        // shows. A provider-only node (blank model) then compiles to a real model
        // instead of an empty one (which produced e.g. LiteLlm(model="kimi/") at runtime).
        $providerDefaults = [];
        try {
            foreach ($this->db->query("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1") as $rowP) {
                $providerDefaults[strtolower((string) ($rowP['provider_key'] ?? ''))] = (string) ($rowP['model'] ?? '');
            }
        } catch (\Throwable $_) {
            // Table missing/unreadable: leave models blank; _make_model raises loudly at runtime.
        }
        foreach ($agents as $aid => $ag) {
            if ((string) ($ag['model'] ?? '') === '') {
                $agents[$aid]['model'] = $providerDefaults[strtolower((string) $ag['provider'])] ?? '';
            }
        }

        // Reuse the exact same tool/server catalog logic LangGraphGenerator uses.
        [$usedCatalog, $usedServers] = $this->buildToolCatalog($agents);

        $startNode = $base['byId'][$base['startNodeId']] ?? [];
        return array_merge($base, [
            'workflow'       => ['id' => $workflowId, 'name' => ($wf->getName() ?: "workflow_$workflowId")],
            'agents'         => $agents,
            'usedCatalog'    => $usedCatalog,
            'usedServers'    => $usedServers,
            'startPrompt'    => (string) ($startNode['config']['prompt'] ?? ''),
            'startDocuments' => $startNode['config']['documents'] ?? [],
            // Output-node storage setting: whether to persist the final result and where.
            // The compiled script honours these so its result lands in the same place the
            // browser interpreter uses (the Output node's advertised storage location).
            'outputStorageEnabled' => $wf->isOutputStorageEnabled(),
            'outputFolder'         => $wf->getOutputFolder(),
        ]);
    }

    // --------------------------------------------------------------------------
    // Private: tool/server catalog assembly (lifted verbatim from
    // LangGraphGenerator::loadMcpToolsWithServers + the catalog-filter block in
    // LangGraphGenerator::generate, lines ~220-244 and ~305-548).
    // --------------------------------------------------------------------------

    /**
     * Fetch MCP tools with server info (url, name, headers), matching
     * the Python loader.list_mcp_tools_with_servers() shape.
     *
     * @return array<int, array<string,mixed>>
     */
    private function loadMcpToolsWithServers(): array
    {
        $sql  = "SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND s.user_id IS NULL";
        $stmt = $this->db->query($sql);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $out = [];
        foreach ($rows as $row) {
            $schemaRaw = $row['input_schema'] ?? null;
            $schema    = null;
            if (is_string($schemaRaw) && $schemaRaw !== '') {
                // ASSOCIATIVE decode is load-bearing: the generators walk the
                // schema with is_array() checks — an object decode made every
                // check fail, silently stripping ALL tool parameters from the
                // ADK/MAF exports (models called search tools with keywords
                // that never reached the MCP server: "keyword parameter is
                // required" despite a correct call).
                $schema = json_decode($schemaRaw, true);
                if ($schema === null && json_last_error() !== JSON_ERROR_NONE) {
                    $schema = null;
                }
            }
            $row['input_schema'] = $schema;
            $out[] = $row;
        }
        return $out;
    }

    /**
     * Build the MCP tool/server catalogs filtered to only tools referenced by agents.
     *
     * This is a lift-and-shift of the catalog-assembly logic in
     * LangGraphGenerator::generate() (lines ~305-548).
     *
     * @param  array<string,array> $agents  The agents map built by analyze(); each entry
     *                                      has a 'tools' key (raw names, may include mcp_ prefix).
     * @return array{0: array<string,array>, 1: array<string,array>}
     *                                      [usedCatalog, usedServers]
     */
    private function buildToolCatalog(array $agents): array
    {
        // Load all enabled global MCP tools with their server info.
        $mcpTools = $this->loadMcpToolsWithServers();

        // Build the full server registry and tool catalog (same logic as LangGraphGenerator).
        $serverRegistry = [];
        $toolCatalog    = [];
        foreach ($mcpTools as $t) {
            $surl  = (string) ($t['server_url']  ?? '');
            $sname = (string) ($t['server_name'] ?? '');
            $tname = (string) ($t['tool_name']   ?? $t['name'] ?? '');
            if ($surl === '' || $tname === '') {
                continue;
            }
            if (!isset($serverRegistry[$surl])) {
                $serverRegistry[$surl] = ['name' => $sname];
            }
            $desc = $t['tool_description'] ?? $t['description'] ?? '';
            if ($desc === null) {
                $desc = '';
            }
            $schema = $t['input_schema'] ?? null;
            if ($schema === null) {
                $schema = new \stdClass();
            }
            $toolCatalog[$tname] = [
                'server_url'   => $surl,
                'description'  => $desc,
                'input_schema' => $schema,
            ];
        }

        // Collect all tool names referenced by agents across the workflow.
        // Strip the mcp_ prefix so names match the catalog keys (same normalisation
        // LangGraphGenerator applies during agent-data resolution).
        $allNeededTools = [];
        foreach ($agents as $agentEntry) {
            $rawTools = $agentEntry['tools'] ?? [];
            foreach ($rawTools as $tool) {
                $tname = null;
                if (is_string($tool)) {
                    $tname = $tool;
                } elseif (is_array($tool)) {
                    $tname = $tool['name'] ?? $tool['tool_name'] ?? null;
                }
                if ($tname !== null && $tname !== '') {
                    if (strpos($tname, 'mcp_') === 0) {
                        $tname = substr($tname, 4);
                    }
                    $allNeededTools[$tname] = true;
                }
            }
        }

        // Filter catalog to only tools actually used by agents.
        $usedCatalog = [];
        foreach ($toolCatalog as $k => $v) {
            if (isset($allNeededTools[$k])) {
                $usedCatalog[$k] = $v;
            }
        }

        // Filter servers to only those whose tools are used.
        $usedServers = [];
        foreach ($usedCatalog as $entry) {
            $surl = $entry['server_url'] ?? '';
            if ($surl !== '' && isset($serverRegistry[$surl])) {
                $usedServers[$surl] = $serverRegistry[$surl];
            }
        }

        return [$usedCatalog, $usedServers];
    }
}
