<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use RuntimeException;

/**
 * LangGraph Generator
 *
 * Generates a standalone Python LangGraph script from a saved workflow.
 * PHP port of langchain_runner/code_generator.py -- output is intended to
 * be byte-for-byte identical to the Python generator's output.
 *
 * The generated file is fully independent of the PHP backend. It connects
 * directly to MCP servers via JSON-RPC 2.0 over HTTP and needs only:
 *   - ANTHROPIC_API_KEY env var
 *   - A user prompt (CLI argument)
 *   - MCP servers reachable at the URLs baked into the file
 */
class LangGraphGenerator
{
    private PDO $db;
    private WorkflowRepository $workflowRepo;
    private WorkflowGraphRepository $graphRepo;
    private AgentRepository $agentRepo;

    public function __construct(
        PDO $db,
        WorkflowRepository $workflowRepo,
        WorkflowGraphRepository $graphRepo,
        AgentRepository $agentRepo
    ) {
        $this->db = $db;
        $this->workflowRepo = $workflowRepo;
        $this->graphRepo = $graphRepo;
        $this->agentRepo = $agentRepo;
    }

    // ---------- helpers (same as Python generator) ----------

    private static function nodeType(array $n): string
    {
        $cfg = $n['config'] ?? [];
        if (!is_array($cfg)) {
            $cfg = [];
        }
        return (string) ($n['node_type'] ?? $n['type'] ?? ($cfg['type'] ?? '') ?? '');
    }

    private static function nodeId(array $n): string
    {
        return (string) ($n['id'] ?? $n['drawflow_node_id'] ?? ($n['_id'] ?? ''));
    }

    private static function edgeFrom(array $e): string
    {
        return (string) ($e['from_node_id'] ?? $e['from'] ?? ($e['source'] ?? ''));
    }

    private static function edgeTo(array $e): string
    {
        return (string) ($e['to_node_id'] ?? $e['to'] ?? ($e['target'] ?? ''));
    }

    private static function children($nid, array $edges): array
    {
        $nid = (string) $nid;
        $out = [];
        foreach ($edges as $e) {
            if (self::edgeFrom($e) === $nid) {
                $out[] = self::edgeTo($e);
            }
        }
        return $out;
    }

    /**
     * Generous but provider-SAFE max_tokens used when an agent node didn't
     * deliberately set a higher value. Each provider has a different output
     * ceiling, so a single high number would error on the lower ones — these
     * stay within each provider's real limit while being large enough that a
     * full HTML report (~13-20K tokens) doesn't truncate.
     */
    private static function providerMaxTokensDefault(string $provider): int
    {
        switch ($provider) {
            case 'claude':
            case 'anthropic':
                return 32000;   // Sonnet 4.5 supports 64K output
            case 'openai':
            case 'grok':
                return 16000;   // GPT-4o / Grok ~16K
            case 'gemini':
            case 'google':
            case 'kimi':
            case 'moonshot':
            case 'deepseek':
            default:
                return 8000;    // safe floor across the rest (~8K caps)
        }
    }

    private static function displayName(array $node): string
    {
        $cfg = $node['config'] ?? [];
        if (!is_array($cfg)) {
            $cfg = [];
        }
        $name = $cfg['agent_name'] ?? $cfg['name'] ?? ($node['name'] ?? null);
        if ($name !== null && $name !== '') {
            return (string) $name;
        }
        return 'node_' . self::nodeId($node);
    }

    private static function safeVar(string $name): string
    {
        // Replace every run of non-[A-Za-z0-9] (including the bytes of multibyte
        // characters like an em-dash) with a single '_'. The old byte-by-byte
        // ctype_alnum() loop was locale-dependent and kept a stray lead byte of a
        // multibyte char (e.g. keeping \xe2 of "—" while dropping its continuation
        // bytes), producing invalid UTF-8 that broke py_compile of the emitted script.
        $out = preg_replace('/[^A-Za-z0-9]+/', '_', $name) ?? '';
        return strtolower(trim($out, '_'));
    }

    /**
     * Kahn's algorithm restricted to nodes reachable from start.
     *
     * @param array<int, array<string,mixed>> $edges
     * @return array<int, string>
     */
    private static function topoOrder(string $startId, array $edges): array
    {
        // NOTE: PHP auto-coerces numeric string array keys to ints.
        // To keep IDs as strings throughout, we track a parallel set of
        // "reachable" ids via a separate list rather than trusting keys.
        $reachable = [];
        $stack = [$startId];
        while (!empty($stack)) {
            $nid = (string) array_pop($stack);
            if (isset($reachable[$nid])) {
                continue;
            }
            $reachable[$nid] = true;
            foreach (self::children($nid, $edges) as $child) {
                $stack[] = (string) $child;
            }
        }

        $inDeg = [];
        foreach (array_keys($reachable) as $nid) {
            $inDeg[(string) $nid] = 0;
        }
        foreach ($edges as $e) {
            $f = self::edgeFrom($e);
            $t = self::edgeTo($e);
            if (isset($reachable[$f]) && isset($reachable[$t])) {
                $inDeg[$t] = ($inDeg[$t] ?? 0) + 1;
            }
        }

        $order = [];
        $queue = [];
        foreach ($inDeg as $nid => $d) {
            if ($d === 0) {
                $queue[] = (string) $nid;
            }
        }
        while (!empty($queue)) {
            $nid = (string) array_shift($queue);
            $order[] = $nid;
            foreach (self::children($nid, $edges) as $child) {
                $child = (string) $child;
                if (!array_key_exists($child, $inDeg)) {
                    continue;
                }
                $inDeg[$child]--;
                if ($inDeg[$child] === 0) {
                    $queue[] = $child;
                }
            }
        }
        return $order;
    }

    // jsonToPython() moved to PythonEmitHelpers::jsonToPython() (Task 2).

    /**
     * Fetch MCP tools with server info (url, name, headers), matching
     * the Python loader.list_mcp_tools_with_servers() shape.
     *
     * @return array<int, array<string,mixed>>
     */
    private function loadMcpToolsWithServers(): array
    {
        $sql = "SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND s.user_id IS NULL";
        $stmt = $this->db->query($sql);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $out = [];
        foreach ($rows as $row) {
            // Decode input_schema JSON; preserve objects so empty {} stays as object.
            $schemaRaw = $row['input_schema'] ?? null;
            $schema = null;
            if (is_string($schemaRaw) && $schemaRaw !== '') {
                $schema = json_decode($schemaRaw);
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
     * Generate a standalone Python script from a workflow.
     *
     * @return array{filename: string, code: string}
     */
    public function generate(int $workflowId, ?string $userId = null): array
    {
        $workflow = $this->workflowRepo->findById($workflowId);
        if (!$workflow) {
            throw new RuntimeException("Workflow $workflowId not found.");
        }
        $wfName = $workflow->getName() ?: ('workflow_' . $workflowId);
        $safeName = self::safeVar($wfName);
        if ($safeName === '') {
            $safeName = 'workflow_' . $workflowId;
        }

        $graph = $this->graphRepo->getGraph($workflowId);
        // Route pure graph analysis through WorkflowGraphAnalyzer.
        // Returns: byId, order (Kahn topo), edges (normalised), startNodeId.
        $gdata   = WorkflowGraphAnalyzer::analyzeGraph($graph);
        $byId    = $gdata['byId'];
        $order   = $gdata['order'];
        $startId = $gdata['startNodeId'];
        if ($startId === '') {
            throw new RuntimeException('No start node found.');
        }
        // Normalised edges ({from, to}) are compatible with edgeFrom()/edgeTo().
        $edges     = $gdata['edges'];
        $startNode = $byId[$startId];
        $startCfg = $startNode['config'] ?? $startNode['data'] ?? [];
        if (!is_array($startCfg)) {
            $startCfg = [];
        }
        $startPrompt = (string) ($startCfg['prompt'] ?? '');
        $startDocuments = $startCfg['documents'] ?? [];
        if (!is_array($startDocuments)) {
            $startDocuments = [];
        }

        // Provider default models (system_llm_settings.model). Used when
        // an agent has no explicit `model` field set — same source the
        // workflow editor's "Default: <name>" placeholder reads from, so
        // the generated script uses exactly what the UI would have used.
        $providerDefaults = [];
        try {
            $stmtP = $this->db->query("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1");
            foreach ($stmtP as $rowP) {
                $providerDefaults[strtolower((string) ($rowP['provider_key'] ?? ''))] = (string) ($rowP['model'] ?? '');
            }
        } catch (\Throwable $_) {
            // If the table is missing or unreadable, fall through with an
            // empty map — agents that left their model blank will fail
            // loudly at run-time rather than silently using a stale
            // hardcoded fallback.
        }

        // Fetch MCP tools with server info (url, name, headers)
        $mcpTools = $this->loadMcpToolsWithServers();

        // Build server registry and tool catalog
        $serverRegistry = [];
        $toolCatalog = [];
        foreach ($mcpTools as $t) {
            $surl = (string) ($t['server_url'] ?? '');
            $sname = (string) ($t['server_name'] ?? '');
            $tname = (string) ($t['tool_name'] ?? $t['name'] ?? '');
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
            // If null/missing, use empty object (Python uses {} default).
            if ($schema === null) {
                $schema = new \stdClass();
            }
            $toolCatalog[$tname] = [
                'server_url' => $surl,
                'description' => $desc,
                'input_schema' => $schema,
            ];
        }

        // Resolve agent data for each agent node
        $agentData = [];
        $allNeededTools = [];
        foreach ($order as $nid) {
            $node = $byId[$nid];
            $ntype = self::nodeType($node);
            if ($ntype !== 'agent' && $ntype !== 'agent-template') {
                continue;
            }
            $cfg = $node['config'] ?? [];
            if (!is_array($cfg)) {
                $cfg = [];
            }
            $agentId = $node['agent_id'] ?? ($cfg['agent_id'] ?? null);
            $systemPrompt = (string) ($cfg['systemPrompt'] ?? $cfg['instructions'] ?? '');
            // The editor saves selected MCP tools under `tools` (array of names
            // like "mcp_get_crypto_news"). Legacy/realtime nodes use
            // `selectedTools`. Accept both, normalise to bare names without
            // the `mcp_` prefix so they match the tool catalog keys.
            $rawTools = $cfg['selectedTools'] ?? $cfg['tools'] ?? [];
            if (!is_array($rawTools)) {
                $rawTools = [];
            }
            $toolNames = [];
            foreach ($rawTools as $tool) {
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
                    $toolNames[] = $tname;
                }
            }

            // Default provider/model — overridden below if the agent
            // record carries explicit fields.
            $agentProvider = '';
            $agentModel = '';
            if ($agentId !== null && $agentId !== '') {
                try {
                    $agent = $this->agentRepo->findById((int) $agentId);
                    if ($agent !== null) {
                        $agentArr = $agent->toArray();
                        if ($systemPrompt === '') {
                            $systemPrompt = (string) (
                                $agentArr['instructions']
                                ?? $agentArr['system_prompt']
                                ?? $agentArr['prompt']
                                ?? ''
                            );
                        }
                        $agentProvider = (string) ($agentArr['provider'] ?? '');
                        $agentModel = (string) ($agentArr['model'] ?? '');
                        $agentTools = $agentArr['tools'] ?? null;
                        if (empty($toolNames) && is_array($agentTools)) {
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
                                    $toolNames[] = $tname;
                                }
                            }
                        }
                    }
                } catch (\Throwable $_) {
                    // Swallow: matches Python's broad except.
                }
            }
            // Node-level overrides (config layer beats the agent record).
            // The editor saves the picked provider under `agent_provider`;
            // legacy/realtime paths use `llm_provider` or `provider`.
            $nodeProvider = (string) ($cfg['llm_provider'] ?? $cfg['provider'] ?? $cfg['agent_provider'] ?? '');
            $nodeModel = (string) ($cfg['model'] ?? '');
            if ($nodeProvider !== '') $agentProvider = $nodeProvider;
            if ($nodeModel !== '') $agentModel = $nodeModel;
            if ($agentProvider === '') $agentProvider = 'claude';
            // Final resolution: if nothing set the model explicitly, use
            // the provider's default from system_llm_settings — the same
            // value the editor's form shows in the "Default: <name>"
            // placeholder. This is the single source of truth for "what
            // model does provider X use by default?".
            if ($agentModel === '') {
                $agentModel = $providerDefaults[strtolower($agentProvider)] ?? '';
            }

            // Skills are mandatory POST-agent steps (not prompt text, not an optional
            // tool): the main agent runs, then each skill runs on its result and the last
            // skill's produced deliverable becomes the node output. Surface the ordered
            // skill bindings; skill_content is NO LONGER appended to the prompt. Mirrors ADK.
            $skills = \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig($cfg);

            // HTML-output nudge. Some agent/skill prompts (e.g. the GEO report
            // consolidator) ask for a "production-quality HTML file". In the
            // browser the html skill's create.py turns that into a file; the
            // compiled path has no create.py wiring in the prompt, so the model
            // tends to emit Markdown instead (saved as .md). The runner saves a
            // node's FINAL message verbatim and auto-detects HTML by signature,
            // so the reliable fix is to force the final message to be the raw
            // HTML document itself — and because it's the plain final message
            // (not a JSON tool argument) it also sidesteps the big-HTML escaping
            // bugs. Detect a strong "produce HTML" intent and append an explicit
            // output-format instruction.
            $pl = strtolower($systemPrompt);
            $wantsHtml = strpos($pl, 'output only the html') !== false
                || strpos($pl, 'production-quality html') !== false
                || strpos($pl, '<!doctype') !== false
                || (strpos($pl, 'self-contained') !== false && strpos($pl, '<style') !== false);
            // Only nudge the MAIN agent to emit HTML when the node has NO skill to render
            // it. When a skill (e.g. html) is attached, that skill step produces the HTML
            // deliverable, so the main agent should just write the report content.
            if ($wantsHtml && empty($skills)) {
                $systemPrompt = rtrim($systemPrompt)
                    . "\n\n## Output format (CRITICAL — read carefully)\n"
                    . "Your FINAL message MUST be the complete, self-contained HTML "
                    . "document itself: start with `<!DOCTYPE html>` and end with "
                    . "`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick "
                    . "code fences, no preamble, and no commentary before or after. Do NOT "
                    . "narrate what you are about to do; produce the HTML directly as your "
                    . "answer. The runtime saves your final message verbatim to an .html "
                    . "file, so anything that is not HTML breaks the deliverable.";
            }

            // Per-agent sampling/limits saved by the editor under `settings`.
            // Defaults mirror the editor form defaults so a regenerated
            // script behaves the same as the PHP runner.
            $cfgSettings = $cfg['settings'] ?? [];
            if (!is_array($cfgSettings)) {
                $cfgSettings = [];
            }
            $agentTemperature = (float) ($cfgSettings['temperature'] ?? 0.7);
            // max_tokens: the browser/chat path ignores the node's value and
            // lets each provider use its high config default, which is why a
            // full HTML report renders there. The compiled script, however,
            // bakes the node's value in — and the editor's legacy default of
            // 4096 truncates large outputs (a GEO report stops mid-<style>).
            // So: respect a value the user deliberately RAISED above 4096;
            // otherwise substitute a generous, provider-appropriate cap (a
            // ceiling, not a target — billing is on tokens actually used).
            $explicitMaxTokens = (int) ($cfgSettings['max_tokens'] ?? 0);
            $agentMaxTokens = $explicitMaxTokens > 4096
                ? $explicitMaxTokens
                : self::providerMaxTokensDefault(strtolower($agentProvider));

            // Skill-bound agents must be GIVEN the run_skill_script tool so
            // they can actually execute their folder-backed skill. The browser
            // auto-provides it whenever a node has a skill; the compiler never
            // did — so every skill agent had 0 tools and FABRICATED its output
            // (e.g. "Missing /llms.txt" when the file exists). Detect via the
            // assembled prompt, which carries the skill's "call run_skill_script
            // with dir_name …" instructions. The tool itself is a LOCAL
            // subprocess runner registered into the catalog (see toolBuilderBlock).
            // NOTE: the main agent NEVER gets run_skill_script — skills run as separate
            // mandatory steps after it (see the skill loop in the node function).

            foreach ($toolNames as $tn) {
                $allNeededTools[$tn] = true;
            }
            $agentData[$nid] = [
                'display' => self::displayName($node),
                'system_prompt' => $systemPrompt,
                'tool_names' => $toolNames,
                'provider' => strtolower($agentProvider),
                'model' => $agentModel,
                'temperature' => $agentTemperature,
                'max_tokens' => $agentMaxTokens,
                'skills' => $skills,
            ];
        }

        // Filter catalog to only tools actually used by agents
        $usedCatalog = [];
        foreach ($toolCatalog as $k => $v) {
            if (isset($allNeededTools[$k])) {
                $usedCatalog[$k] = $v;
            }
        }
        // Filter MCP_SERVERS the same way. It's a baked registry that's never
        // read at runtime (tool calls take their URL from each TOOL_CATALOG
        // entry's server_url), so emitting the FULL server inventory was just
        // noise — and leaked every configured MCP server into the script. Keep
        // only the servers whose tools are actually used.
        $usedServers = [];
        foreach ($usedCatalog as $entry) {
            $surl = $entry['server_url'] ?? '';
            if ($surl !== '' && isset($serverRegistry[$surl])) {
                $usedServers[$surl] = $serverRegistry[$surl];
            }
        }
        // Flag tools that agents need but aren't available as MCP.
        // run_skill_script is a LOCAL (non-MCP) tool registered directly into
        // the catalog at runtime, so it's not in $toolCatalog — exclude it from
        // the "missing" warning (it IS available).
        $missing = [];
        foreach (array_keys($allNeededTools) as $tn) {
            if ($tn === 'run_skill_script') {
                continue;
            }
            if (!array_key_exists($tn, $toolCatalog)) {
                $missing[] = $tn;
            }
        }
        sort($missing, SORT_STRING);

        $edgeList = [];
        foreach ($edges as $e) {
            $edgeList[] = [self::edgeFrom($e), self::edgeTo($e)];
        }

        // ---- emit code ----
        $lines = [];
        // Build node descriptions for the architecture doc
        $nodeDescs = [];
        foreach ($order as $nid) {
            $node = $byId[$nid];
            $ntype = self::nodeType($node);
            $name = self::displayName($node);
            if (isset($agentData[$nid])) {
                $tc = count($agentData[$nid]['tool_names']);
                $nodeDescs[] = "  $nid ($ntype): $name -- $tc tool(s)";
            } else {
                $nodeDescs[] = "  $nid ($ntype): $name";
            }
        }
        $edgeDescs = [];
        foreach ($edges as $e) {
            $edgeDescs[] = '  ' . self::edgeFrom($e) . " -> " . self::edgeTo($e);
        }

        // Box-drawing separator used in section headers (62 '═' chars,
        // matching Python's literal string).
        $sep = '# ' . str_repeat("=", 62);

        $lines[] = '"""Standalone LangGraph workflow: ' . $wfName;
        $lines[] = '';
        $lines[] = "Auto-generated -- backend-independent.";
        $lines[] = 'Connects directly to MCP servers via JSON-RPC 2.0 over HTTP.';
        $lines[] = '';
        $lines[] = 'ARCHITECTURE';
        $lines[] = '============';
        $lines[] = 'This script was generated from a visual workflow editor. It embeds:';
        $lines[] = '  - Agent system prompts and tool assignments (AGENTS dict)';
        $lines[] = '  - MCP server URLs and tool schemas (MCP_SERVERS, TOOL_CATALOG)';
        $lines[] = '  - Graph structure as edges + topological order (EDGES, ORDER)';
        $lines[] = '';
        $lines[] = 'At runtime it builds a LangGraph StateGraph where each workflow';
        $lines[] = 'node becomes a graph node. Agents use LangChain\'s ReAct pattern';
        $lines[] = '(create_react_agent) which lets the LLM decide when to call tools.';
        $lines[] = '';
        $lines[] = 'DATA FLOW';
        $lines[] = '=========';
        $lines[] = '1. Start node stores the user prompt in shared state';
        $lines[] = '2. Each agent node receives labeled context from its direct';
        $lines[] = "   upstream predecessors (not all prior nodes -- only edge parents)";
        $lines[] = "3. The context message includes the original user prompt plus";
        $lines[] = "   each predecessor's output under a ### header with source name";
        $lines[] = '4. Output node collects its parents\' outputs as final result';
        $lines[] = '';
        $lines[] = 'GRAPH NODES';
        $lines[] = '===========';
        foreach ($nodeDescs as $nd) {
            $lines[] = $nd;
        }
        $lines[] = '';
        $lines[] = 'GRAPH EDGES';
        $lines[] = '===========';
        foreach ($edgeDescs as $ed) {
            $lines[] = $ed;
        }
        $lines[] = '';
        $lines[] = 'TOOL EXECUTION';
        $lines[] = '==============';
        $lines[] = 'Tools are called via the MCP protocol (Model Context Protocol).';
        $lines[] = 'Each tool invocation:';
        $lines[] = '  1. Opens a JSON-RPC 2.0 session with the MCP server (initialize)';
        $lines[] = '  2. Sends a tools/call request with tool name + arguments';
        $lines[] = '  3. Parses the response (JSON or SSE format)';
        $lines[] = '  4. Returns the text content to the LLM agent';
        $lines[] = 'Server URLs and tool schemas are baked in at generation time.';
        $lines[] = '';
        $lines[] = 'REQUIREMENTS';
        $lines[] = '============';
        $lines[] = '  pip install langchain langchain-anthropic langgraph httpx pydantic';
        $lines[] = '  export ANTHROPIC_API_KEY=sk-ant-...';
        $lines[] = '';
        $lines[] = '  # Optional, install only formats you actually attach:';
        $lines[] = '  pip install mammoth        # for .docx attachments';
        $lines[] = '  pip install python-pptx    # for .pptx attachments';
        $lines[] = '  pip install openpyxl       # for .xlsx attachments';
        $lines[] = '  pip install pypdf          # for .pdf attachments';
        $lines[] = '';
        $lines[] = "Usage: python {$safeName}.py 'your prompt here'";
        if (!empty($missing)) {
            $lines[] = '';
            $lines[] = 'WARNING: These tools are NOT available as MCP servers';
            $lines[] = 'and will be missing at runtime: ' . self::pythonListRepr($missing);
            $lines[] = 'Convert them to MCP servers to enable full functionality.';
        }
        $lines[] = '"""';
        $lines[] = 'from __future__ import annotations';
        $lines[] = '';
        $lines[] = 'import asyncio, json, os, subprocess, sys, threading, time';
        $lines[] = 'from typing import Annotated, Any, TypedDict';
        $lines[] = '';
        $lines[] = 'import httpx';
        $lines[] = '# Provider-aware LLM wiring — each agent uses the LLM (provider/model)';
        $lines[] = '# configured for it in the workflow editor. Imports are lazy inside';
        $lines[] = '# _make_llm so a missing optional package only breaks the agents that';
        $lines[] = '# actually use that provider, not the whole script.';
        $lines[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $lines[] = 'from langchain_core.tools import StructuredTool';
        $lines[] = 'from langgraph.graph import END, START, StateGraph';
        $lines[] = 'try:';
        $lines[] = '    from langchain.agents import create_agent as create_react_agent';
        $lines[] = 'except ImportError:';
        $lines[] = '    from langgraph.prebuilt import create_react_agent';
        $lines[] = 'from pydantic import BaseModel, Field, create_model';
        $lines[] = '';
        $lines[] = '# Optional global override: setting MODEL_NAME in the env forces every';
        $lines[] = "# agent to use that model regardless of its per-agent setting. Useful for";
        $lines[] = '# quick experiments. Leave unset to honour each agent\'s configured model.';
        $lines[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $lines[] = '';
        $lines[] = '';
        $lines[] = 'def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096):';
        $lines[] = '    """Build a LangChain chat model for the given provider/model.';
        $lines[] = '';
        $lines[] = '    The (provider, model) pair was resolved by the generator: the';
        $lines[] = "    agent's explicit model overrides the provider's default from";
        $lines[] = '    system_llm_settings, and that result is what reaches this';
        $lines[] = '    function. No hardcoded model fallbacks here — every value comes';
        $lines[] = '    from the database, so changing a model in the editor propagates';
        $lines[] = '    via the next Generate Python.';
        $lines[] = '';
        $lines[] = '    Recognised providers (case-insensitive):';
        $lines[] = '      claude     → langchain_anthropic.ChatAnthropic';
        $lines[] = '      openai     → langchain_openai.ChatOpenAI';
        $lines[] = '      gemini     → langchain_google_genai.ChatGoogleGenerativeAI';
        $lines[] = '      grok       → ChatOpenAI on https://api.x.ai/v1';
        $lines[] = '      deepseek   → ChatOpenAI on https://api.deepseek.com';
        $lines[] = '      kimi       → ChatOpenAI on https://api.moonshot.ai/v1';
        $lines[] = '';
        $lines[] = '    Reads API keys from the environment (loaded from .env at startup).';
        $lines[] = '    """';
        $lines[] = '    p = (provider or "claude").lower()';
        $lines[] = '    if MODEL_NAME_OVERRIDE:';
        $lines[] = '        model = MODEL_NAME_OVERRIDE';
        $lines[] = '    if not model:';
        $lines[] = '        raise RuntimeError(';
        $lines[] = '            f"No model specified for provider {p!r}. "';
        $lines[] = '            "Set a model name on the agent in the workflow editor, "';
        $lines[] = '            "or set MODEL_NAME in .env."';
        $lines[] = '        )';
        $lines[] = '    if p == "claude":';
        $lines[] = '        from langchain_anthropic import ChatAnthropic';
        $lines[] = '        return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)';
        $lines[] = '    if p == "openai":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)';
        $lines[] = '    if p == "gemini":';
        $lines[] = '        from langchain_google_genai import ChatGoogleGenerativeAI';
        $lines[] = '        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)';
        $lines[] = '    if p == "grok":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        return ChatOpenAI(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.x.ai/v1",';
        $lines[] = '            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '    if p == "deepseek":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        return ChatOpenAI(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.deepseek.com",';
        $lines[] = '            api_key=os.environ.get("DEEPSEEK_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '    if p == "kimi":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        # Kimi is OpenAI-compatible. temperature/max_tokens come straight from';
        $lines[] = '        # the agent form -- never overridden. K2 defaults to thinking mode; disable';
        $lines[] = '        # it (not a form parameter) to match the PHP KimiProvider.';
        $lines[] = '        kwargs = dict(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.moonshot.ai/v1",';
        $lines[] = '            api_key=os.environ.get("KIMI_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '        if model.startswith("kimi-k2"):';
        $lines[] = '            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}';
        $lines[] = '        return ChatOpenAI(**kwargs)';
        $lines[] = '    raise RuntimeError(';
        $lines[] = '        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi."';
        $lines[] = '    )';
        $lines[] = '';

        // ---------- MCP server registry (baked) ----------
        $lines[] = $sep;
        $lines[] = '# MCP SERVER REGISTRY';
        $lines[] = "# Baked at generation time from the workflow editor's config.";
        $lines[] = "# Maps server URL -> metadata. If a server moves, update the URL here.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($usedServers, true);
        $lines[] = '';

        // ---------- tool catalog (baked) ----------
        $lines[] = $sep;
        $lines[] = '# TOOL CATALOG';
        $lines[] = '# Each entry maps a tool name to its MCP server URL and';
        $lines[] = '# JSON Schema for input validation. Only tools actually used';
        $lines[] = '# by agents in this workflow are included.';
        $lines[] = '# To add a tool: add an entry here AND reference it in the';
        $lines[] = "# agent's tool_names list in the AGENTS dict below.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($usedCatalog, true);
        $lines[] = '';

        // ---------- MCP JSON-RPC client ----------
        $lines[] = $sep;
        $lines[] = "# MCP CLIENT -- JSON-RPC 2.0 over HTTP";
        $lines[] = '#';
        $lines[] = '# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.';
        $lines[] = '# Each tool call requires:';
        $lines[] = "#   1. URL normalization -- append /mcp if not present";
        $lines[] = "#   2. Session initialization -- send 'initialize' + notification";
        $lines[] = "#   3. Tool invocation -- send 'tools/call' with name + arguments";
        $lines[] = "#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON";
        $lines[] = '#';
        $lines[] = '# Some MCP servers return Server-Sent Events (SSE) instead of';
        $lines[] = '# plain JSON. The parser handles both formats transparently.';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = PythonEmitHelpers::mcpClientBlock();

        // ---------- tool builder ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# TOOL BUILDER';
        $lines[] = '# Converts the baked TOOL_CATALOG into LangChain StructuredTool';
        $lines[] = '# objects. Each tool gets a dynamically-built Pydantic model for';
        $lines[] = '# input validation (from the JSON Schema), and a callable that';
        $lines[] = '# invokes the MCP server. The LLM agent calls these like any';
        $lines[] = "# other LangChain tool -- it doesn't know about MCP internals.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::toolBuilderBlock();

        // ---------- state ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# LANGGRAPH STATE';
        $lines[] = '#';
        $lines[] = '# WFState is the shared state that flows through the graph.';
        $lines[] = '# - user_prompt: the original user input (immutable after start)';
        $lines[] = "# - node_outputs: dict of node_id -> {source, text} -- each node";
        $lines[] = '#   writes its output here. Uses a merge reducer so parallel';
        $lines[] = '#   branches can both contribute without conflicts.';
        $lines[] = '# - final_output: set by the output node as the workflow result';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::stateBlock();

        // ---------- datetime injector ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# DATETIME INJECTOR';
        $lines[] = '#';
        $lines[] = "# LLMs have knowledge cutoffs and don't know the current date.";
        $lines[] = "# inject_datetime() prepends a short context block to each agent's";
        $lines[] = "# system prompt so the agent reasons with today's actual date.";
        $lines[] = '# Also resolves any [date]/[weekday]/[year]/[time] placeholders';
        $lines[] = '# that may exist inside the prompt text (legacy templating).';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::datetimeInjectorBlock();

        // ---------- context builder ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# CONTEXT BUILDER';
        $lines[] = '#';
        $lines[] = '# Each agent receives a structured message containing:';
        $lines[] = '#   1. The original user request (for reference)';
        $lines[] = '#   2. Labeled outputs from direct upstream agents only';
        $lines[] = "# This matches the PHP backend's 'labeled' merge strategy.";
        $lines[] = "# The agent's system prompt tells it what to DO with this input.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::contextBuilderBlock();

        // ---------- document converter ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# DOCUMENT CONVERTER';
        $lines[] = '#';
        $lines[] = "# Reads a file at `path` and returns Markdown the LLM can read.";
        $lines[] = '# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through';
        $lines[] = '# verbatim. Binary office formats and PDFs are routed to their';
        $lines[] = '# matching pure-Python library (mammoth / python-pptx / openpyxl /';
        $lines[] = '# pypdf). Imports are lazy so the helper only pulls in heavy deps';
        $lines[] = '# when a document of that format is actually attached.';
        $lines[] = '#';
        $lines[] = "# This mirrors the editor's frontend converter (Pyodide) so the";
        $lines[] = '# generated script behaves the same way the workflow did at design';
        $lines[] = '# time. Paths come from the doc.path field stored in the workflow';
        $lines[] = '# config — make sure the file is reachable from wherever you run';
        $lines[] = '# this script (absolute paths recommended).';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = PythonEmitHelpers::documentConverterBlock();

        // ---------- start node config ----------
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# START NODE';
        $lines[] = '#';
        $lines[] = '# The start node feeds the prompt into the workflow.';
        $lines[] = "# DEFAULT_PROMPT is baked from the workflow's start node config.";
        $lines[] = '# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.';
        $lines[] = '# If the workflow has documents attached to the start node,';
        $lines[] = "# they're read from doc.path, converted to Markdown via";
        $lines[] = '# _convert_doc_to_markdown(), and prepended to the prompt.';
        $lines[] = $sep;
        $lines[] = '';
        $promptEscaped = str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $startPrompt);
        $lines[] = 'DEFAULT_PROMPT = """';
        foreach (explode("\n", $promptEscaped) as $pline) {
            if (strlen($pline) <= 80) {
                $lines[] = $pline;
            } else {
                $lines[] = wordwrap($pline, 80, "\n", true);
            }
        }
        $lines[] = '""".strip()';
        $lines[] = '';
        // Output-node storage setting baked in so the compiled script persists the final
        // result where the app does (~/Documents/synergyAI/outputs/workflow/, or a custom
        // folder) only when storage is enabled. Mirrors the ADK generator.
        $ofolder = $workflow->getOutputFolder();
        $lines[] = 'WORKFLOW_ID = ' . (int) $workflowId;
        $lines[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($wfName);
        $lines[] = 'OUTPUT_STORAGE_ENABLED = ' . ($workflow->isOutputStorageEnabled() ? 'True' : 'False');
        $lines[] = 'OUTPUT_FOLDER = ' . (($ofolder !== null && $ofolder !== '') ? PythonEmitHelpers::pyStr((string) $ofolder) : 'None');
        $lines[] = '';
        if (!empty($startDocuments)) {
            $lines[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($startDocuments);
        } else {
            $lines[] = 'START_DOCUMENTS = []';
        }
        $lines[] = '';

        // ---------- embedded agent definitions ----------
        $lines[] = $sep;
        $lines[] = '# AGENT DEFINITIONS';
        $lines[] = '#';
        $lines[] = '# Each agent is identified by its workflow node ID.';
        $lines[] = '#   display:       Human-readable name (for logs and context labels)';
        $lines[] = "#   system_prompt: The agent's persona/instructions (sent as SystemMessage)";
        $lines[] = '#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)';
        $lines[] = '#';
        $lines[] = '# To modify an agent: edit its system_prompt or tool_names here.';
        $lines[] = '# To add a new agent: add an entry, create edges in EDGES, and';
        $lines[] = '# include the node ID in ORDER at the right topological position.';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'AGENTS = {';
        foreach ($agentData as $nid => $ad) {
            // json_encode list (no pretty) matches Python json.dumps without indent
            $toolsList = json_encode($ad['tool_names'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($toolsList === '[]' || $toolsList === false) {
                $toolsList = '[]';
            }
            $promptText = str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $ad['system_prompt']);
            $wrappedLines = [];
            foreach (explode("\n", $promptText) as $pline) {
                if (strlen($pline) <= 80) {
                    $wrappedLines[] = $pline;
                } else {
                    foreach (explode("\n", wordwrap($pline, 80, "\n", true)) as $wl) {
                        $wrappedLines[] = $wl;
                    }
                }
            }
            $displayJson = json_encode($ad['display'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $providerJson = json_encode((string) ($ad['provider'] ?? 'claude'), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $modelJson = json_encode((string) ($ad['model'] ?? ''), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $temperatureLit = json_encode((float) ($ad['temperature'] ?? 0.7));
            $maxTokensLit = (int) ($ad['max_tokens'] ?? 4096);
            $lines[] = '    "' . $nid . '": {';
            $lines[] = '        "display": ' . $displayJson . ',';
            $lines[] = '        "provider": ' . $providerJson . ',';
            $lines[] = '        "model": ' . $modelJson . ',';
            $lines[] = '        "temperature": ' . $temperatureLit . ',';
            $lines[] = '        "max_tokens": ' . $maxTokensLit . ',';
            $lines[] = '        "system_prompt": """';
            foreach ($wrappedLines as $wl) {
                $lines[] = $wl;
            }
            $lines[] = '""",';
            $skillsJson = json_encode($ad['skills'] ?? [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($skillsJson === false) {
                $skillsJson = '[]';
            }
            $lines[] = '        "tool_names": ' . $toolsList . ',';
            // Ordered skill bindings ([{"dir": "..."}] / [{"inline": "..."}]) — the node
            // runs each as a mandatory post-agent step; the last produces the node output.
            $lines[] = '        "skills": ' . $skillsJson . ',';
            $lines[] = '    },';
        }
        $lines[] = '}';
        $lines[] = '';

        // ---------- edge data ----------
        $lines[] = $sep;
        $lines[] = '# GRAPH STRUCTURE';
        $lines[] = '#';
        $lines[] = '# EDGES: directed connections as (from_node_id, to_node_id) tuples.';
        $lines[] = "# ORDER: topological execution order (Kahn's algorithm).";
        $lines[] = '#        Guarantees every node runs after all its predecessors.';
        $lines[] = "# NODE_TYPES: maps node_id -> type ('start', 'agent', 'output').";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'EDGES = ' . PythonEmitHelpers::jsonToPython($edgeList);
        $lines[] = 'ORDER = ' . PythonEmitHelpers::jsonToPython($order);
        $lines[] = '';
        $lines[] = self::parentsChildrenBlock();

        $typeMap = [];
        foreach ($order as $nid) {
            $typeMap[$nid] = self::nodeType($byId[$nid]);
        }
        $lines[] = 'NODE_TYPES = ' . PythonEmitHelpers::jsonToPython($typeMap, true);
        $lines[] = '';

        // ---------- main function ----------
        $lines[] = $sep;
        $lines[] = '# MAIN EXECUTION';
        $lines[] = '#';
        $lines[] = '# run() builds the LangGraph, wires edges, and executes it.';
        $lines[] = '# Each node type has a factory function (make_start, make_agent,';
        $lines[] = '# make_output) that returns a callable for LangGraph to invoke.';
        $lines[] = '#';
        $lines[] = "# Agent nodes use LangChain's ReAct pattern: the LLM receives";
        $lines[] = '# the system prompt + upstream context, and can call tools in a';
        $lines[] = '# loop until it produces a final answer.';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::runHeaderBlock();

        if (!empty($missing)) {
            $lines[] = '    print("[warn] Missing tools (not MCP): ' . self::pythonListRepr($missing) . '")';
            $lines[] = '';
        }

        $lines[] = self::runBodyBlock();

        $code = implode("\n", $lines);
        $filename = "{$safeName}.py";
        return ['filename' => $filename, 'code' => $code];
    }

    /**
     * Render a list of strings the way Python's repr(sorted([...])) does:
     *   ['a', 'b', 'c']
     * Note: Python repr uses single quotes unless the string contains a
     * single quote. For simplicity (and because tool names don't contain
     * quotes in practice), we always use single quotes.
     */
    private static function pythonListRepr(array $items): string
    {
        $parts = [];
        foreach ($items as $s) {
            // Escape backslash and single quote the way Python repr does.
            $esc = str_replace(['\\', "'"], ['\\\\', "\\'"], (string) $s);
            $parts[] = "'" . $esc . "'";
        }
        return '[' . implode(', ', $parts) . ']';
    }

    // ---------- static Python code blocks ----------
    // These correspond to the textwrap.dedent('''...''') heredocs in the
    // Python generator. Reproduced here byte-for-byte as nowdoc strings.
    //
    // mcpClientBlock()  → moved to PythonEmitHelpers::mcpClientBlock() (Task 2)
    // skillDepsBlock()  → moved to PythonEmitHelpers::skillDepsBlock()  (Task 2)

    private static function toolBuilderBlock(): string
    {
        // Part A: _summarize_tool_result + build_tools_from_catalog
        // Three blank lines after 'return catalog' produce content ending \n\n\n
        // so that concatenating skillDepsBlock() (which starts with '# ---')
        // yields the original two-blank-line separator.
        $partA = <<<'PY'
def _summarize_tool_result(result: str) -> str:
    """Short, informative summary of a tool result for logs.

    Parses JSON when possible and surfaces the most useful fields
    (article count + first PMIDs, error message, query text, etc.)
    so the log shows *what* came back, not just the raw first 120 chars.
    """
    try:
        parsed = json.loads(result)
    except Exception:
        s = result.strip().replace("\n", " ")
        return s[:160] + (" ..." if len(s) > 160 else "")
    if isinstance(parsed, dict):
        if "error" in parsed:
            return f"error: {str(parsed['error'])[:200]}"
        if isinstance(parsed.get("articles"), list):
            arts = parsed["articles"]
            pmids = [str(a.get("pmid", "?")) for a in arts[:5] if isinstance(a, dict)]
            more = "" if len(arts) <= 5 else f", +{len(arts) - 5} more"
            return f"{len(arts)} articles (PMIDs: {', '.join(pmids)}{more})"
        if isinstance(parsed.get("suggestions"), list):
            return f"{len(parsed['suggestions'])} suggestions"
        if isinstance(parsed.get("query"), str):
            q = parsed["query"]
            return f"query: {q[:200]}" + (" ..." if len(q) > 200 else "")
        if isinstance(parsed.get("items"), list):
            return f"{len(parsed['items'])} items"
        keys = ", ".join(list(parsed.keys())[:6])
        return f"keys: {keys}"
    if isinstance(parsed, list):
        return f"list of {len(parsed)} items"
    s = str(parsed)
    return s[:160] + (" ..." if len(s) > 160 else "")


def build_tools_from_catalog() -> dict[str, StructuredTool]:
    """Build LangChain StructuredTool wrappers from TOOL_CATALOG.

    For each tool:
    1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)
    2. Create a callable that sends the MCP JSON-RPC request
    3. Wrap both into a LangChain StructuredTool

    Returns: dict mapping tool_name -> StructuredTool
    """
    type_map = {"string": str, "integer": int, "number": float,
                "boolean": bool, "array": list, "object": dict}
    catalog = {}
    for name, info in TOOL_CATALOG.items():
        schema = info.get("input_schema") or {}
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        fields = {}
        for pname, pspec in props.items():
            spec = pspec if isinstance(pspec, dict) else {}
            ptype = type_map.get(spec.get("type", "string"), str)
            default = ... if pname in required else None
            fields[pname] = (ptype, Field(default, description=spec.get("description", "")))
        args_model = create_model(f"{name}Args", **fields) if fields else create_model(f"{name}Args")

        server_url = info["server_url"]
        def make_fn(n=name, s=server_url):
            def invoke(**kwargs):
                argv = json.dumps(kwargs, default=str)
                argv_preview = argv if len(argv) <= 250 else argv[:250] + f" ... +{len(argv) - 250} chars"
                print(f"  [tool] -> {n}({argv_preview})")
                t0 = time.monotonic()
                result = _call_mcp_tool(s, n, kwargs)
                dt = time.monotonic() - t0
                summary = _summarize_tool_result(result)
                print(f"  [tool] ← {n}: {summary} ({len(result)} chars, {dt:.1f}s)")
                return result
            return invoke

        catalog[name] = StructuredTool.from_function(
            func=make_fn(),
            name=name,
            description=info.get("description") or f"MCP tool {name}",
            args_schema=args_model,
        )
    return catalog



PY;
        // Part B: _run_skill_script + RUN_SKILL_SCRIPT_TOOL
        // Two blank lines at start join to the two blank lines in skillDepsBlock's tail.
        $partB = <<<'PY'


# Skill filesystem (mirrors the browser interpreter + ADK): real bucketed /outputs and
# /scratch dirs, virtual-path remap, env exposure, and a deliverable stash so a skill's
# produced file (not the model's chatter) can become the node output.
SKILL_OUTPUTS_ROOT = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(SKILLS_DIR), "outputs")
SKILL_SCRATCH_DIR = os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(os.path.dirname(SKILLS_DIR), "scratch")
_LAST_SKILL_OUTPUTS = {}


def _skill_output_dir(dir_name: str) -> str:
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    if group and all(c.isalnum() or c in "._-" for c in group):
        return os.path.join(SKILL_OUTPUTS_ROOT, group)
    return SKILL_OUTPUTS_ROOT


def _remap_virtual_path(p, out_dir: str) -> str:
    p = str(p)
    for virt, real in (("/outputs", out_dir), ("/scratch", SKILL_SCRATCH_DIR)):
        if p == virt:
            return real
        if p.startswith(virt + "/"):
            return os.path.join(real, p[len(virt) + 1:])
    return p


def _run_skill_script(dir_name: str, script: str, argv=None,
                      input_files=None, read_outputs=None) -> str:
    if isinstance(argv, str):
        try:
            argv = json.loads(argv)
        except Exception:
            argv = [argv]
    argv = list(argv) if argv else []
    skill_dir = os.path.join(SKILLS_DIR, *str(dir_name).split("/"))
    script_path = os.path.join(skill_dir, *str(script).split("/"))
    if not os.path.isfile(script_path):
        return f"ERROR: skill script not found: {dir_name}/{script} (looked in {script_path})"
    _ensure_skill_deps(skill_dir)
    out_dir = _skill_output_dir(dir_name)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(SKILL_SCRATCH_DIR, exist_ok=True)
    # Remap the interpreter's virtual /outputs & /scratch in argv to real dirs.
    argv = [_remap_virtual_path(a, out_dir) for a in argv]
    # Stage input_files (e.g. HTML the skill will render) at their remapped paths.
    if isinstance(input_files, dict):
        for raw_path, content in input_files.items():
            try:
                target = _remap_virtual_path(raw_path, out_dir)
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write(content if isinstance(content, str) else str(content))
            except Exception as e:
                print(f"  [run_skill_script] could not stage {raw_path}: {e}")
    env = dict(
        os.environ,
        SYNERGYAI_OUTPUT_DIR=out_dir,
        SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR,
        SYNERGYAI_SKILL_DIR_NAME=dir_name,
        SYNERGYAI_SKILL_GROUP=(dir_name.split("/")[0] if "/" in dir_name else ""),
    )
    cmd = [sys.executable, script_path] + [str(a) for a in argv]
    print(f"  [run_skill_script] → {dir_name}/{script} argv={argv}", flush=True)
    _t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, cwd=skill_dir, env=env, capture_output=True,
                              text=True, timeout=300)
    except subprocess.TimeoutExpired:
        print(f"  [run_skill_script] ← {dir_name}/{script}: TIMEOUT after 300s", flush=True)
        return f"ERROR: skill {dir_name}/{script} timed out after 300s"
    _dt = time.monotonic() - _t0
    out = proc.stdout or ""
    _stderr = (proc.stderr or "").strip()
    _head = out.replace(chr(10), " ")[:160]
    print(f"  [run_skill_script] ← {dir_name}/{script}: exit={proc.returncode}, "
          f"{len(out)} chars stdout, {_dt:.1f}s | {_head}", flush=True)
    if proc.returncode != 0 and _stderr:
        print(f"  [run_skill_script]   stderr tail: {_stderr[-400:]}", flush=True)
    if proc.returncode != 0:
        out = (out + f"\n[run_skill_script exit {proc.returncode}]\n"
               + _stderr[-2000:]).strip()
    # Read back requested outputs AND stash them so the skill step can use the produced
    # document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                out += f"\n\n[output file {rel}]\n" + _content
                _produced.append(_content)
            except Exception:
                pass
    if _produced:
        _LAST_SKILL_OUTPUTS[dir_name] = _produced
    return out or "(skill produced no stdout)"


RUN_SKILL_SCRIPT_TOOL = StructuredTool.from_function(
    func=_run_skill_script,
    name="run_skill_script",
    description=("Execute a folder-backed skill's Python script and return its "
                 "stdout. Pass the dir_name/script/argv the skill instructions "
                 "specify, e.g. dir_name='GEO/geo-llmstxt', "
                 "script='scripts/llmstxt_signals.py', argv=['https://example.com']."),
    args_schema=create_model(
        "RunSkillScriptArgs",
        dir_name=(str, ...),
        script=(str, ...),
        # list[str] (not bare list) so the generated JSON schema carries
        # `items`. Gemini rejects array params without `items` (400
        # INVALID_ARGUMENT); list[str] is valid for every provider. Leave
        # input_files as a bare dict — Gemini accepted that, and dict[str,str]
        # would add additionalProperties which Gemini may reject.
        argv=(list[str], []),
        input_files=(dict, {}),
        read_outputs=(list[str], []),
    ),
)


def _read_skill_md(dir_name: str) -> str:
    """The live SKILL.md body (progressive disclosure); frontmatter stripped."""
    path = os.path.join(SKILLS_DIR, *str(dir_name).split("/"), "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return f"(SKILL.md not found for skill '{dir_name}')"
    if text.startswith("---"):
        end = text.find("\n---\n", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            text = text[nl + 1:] if nl != -1 else ""
    return text.strip()


def _make_skill_tool(dir_name: str):
    """run_skill_script scoped to ONE skill dir: the model picks only the script + argv
    (and input_files/read_outputs); the dir is fixed to this skill."""
    def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:
        return _run_skill_script(dir_name, script, argv, input_files, read_outputs)
    return StructuredTool.from_function(
        func=run_skill_script, name="run_skill_script",
        description=(f"Run a script in the '{dir_name}' skill (dir fixed). Stage authored "
                     "content via input_files and pass the output path in read_outputs."),
        args_schema=create_model(
            "ScopedSkillArgs",
            script=(str, ...), argv=(list[str], []),
            input_files=(dict, {}), read_outputs=(list[str], []),
        ),
    )


async def _run_skill_step(skill, prior, llm):
    """Run ONE skill as a mandatory step on `prior` (the previous stage's output). A
    dir-backed skill = an LLM turn instructed by SKILL.md with run_skill_script scoped to
    the dir; the step output becomes the skill's produced deliverable file (via
    read_outputs) when it wrote one, else the LLM's text. Inline skill = an LLM transform."""
    dir_name = skill.get("dir", "")
    body = skill.get("inline") or (_read_skill_md(dir_name) if dir_name else "")
    system = (
        "You are running the '" + (dir_name or "inline") + "' skill as a MANDATORY step in "
        "a compiled workflow. Follow the skill instructions below and APPLY THE SKILL to the "
        "INPUT. If the skill produces a document/file (e.g. an HTML report via a create/"
        "render script), you MUST call run_skill_script -- stage your authored content via "
        "input_files and pass the output path in read_outputs; the workflow captures that "
        "produced file as this node's output. If the skill has no script, return the "
        "transformed result as your response.\n\n=== SKILL INSTRUCTIONS ===\n" + body
    )
    tools = [_make_skill_tool(dir_name)] if dir_name else []
    if dir_name:
        _LAST_SKILL_OUTPUTS.pop(dir_name, None)
    agent = create_react_agent(llm, tools)
    msgs = [SystemMessage(content=system),
            HumanMessage(content="## INPUT (apply the skill to this)\n" + str(prior))]
    result = await agent.ainvoke({"messages": msgs})
    final = result["messages"][-1]
    text = final.content if isinstance(final, AIMessage) else str(final)
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    produced = _LAST_SKILL_OUTPUTS.pop(dir_name, None) if dir_name else None
    return produced[-1] if produced else text

PY;
        return $partA . PythonEmitHelpers::skillDepsBlock() . $partB;
    }

    private static function stateBlock(): string
    {
        return <<<'PY'
def _merge(left: dict | None, right: dict | None) -> dict:
    """Reducer for node_outputs -- merges dicts from parallel branches.

    When two nodes run in parallel (e.g., diamond graph), both write to
    node_outputs. LangGraph needs a reducer to combine them. This does a
    shallow merge where the right (newer) value wins on key conflicts.
    """
    out = dict(left or {})
    out.update(right or {})
    return out

class WFState(TypedDict, total=False):
    """Shared state for the workflow graph.

    Attributes:
        user_prompt: The original user input, set once at the start.
        node_outputs: Each node stores its output as {source, text}.
                      Annotated with _merge so parallel nodes don't conflict.
        final_output: The final text result, set by the output node.
    """
    user_prompt: str
    node_outputs: Annotated[dict[str, dict[str, str]], _merge]
    final_output: str

PY;
    }

    private static function datetimeInjectorBlock(): string
    {
        return <<<'PY'
def inject_datetime(system_prompt: str) -> str:
    """Inject current date/time into a system prompt.

    Prepends a dated header so the LLM knows "today" relative to its
    knowledge cutoff. Also replaces [date], [weekday], [year], [time]
    placeholders in the prompt body with live values.
    """
    from datetime import datetime as _dt
    now = _dt.now()
    date_str = now.strftime("%Y-%m-%d")
    weekday_str = now.strftime("%A")
    year_str = now.strftime("%Y")
    time_str = now.strftime("%H:%M")
    iso_str = now.strftime("%Y-%m-%d %H:%M %Z").strip()

    prompt = system_prompt
    prompt = prompt.replace("[date]", date_str)
    prompt = prompt.replace("[weekday]", weekday_str)
    prompt = prompt.replace("[year]", year_str)
    prompt = prompt.replace("[time]", time_str)

    header = (
        f"## Current Date & Time\n"
        f"Today is {weekday_str}, {date_str} ({time_str}).\n"
        f"Use this as the reference for any date-sensitive reasoning "
        f"(recent research, latest news, time-relative phrasing, etc.).\n\n"
    )
    return header + prompt

PY;
    }

    private static function contextBuilderBlock(): string
    {
        return <<<'PY'
def build_context(user_prompt: str, parent_ids: list[str], outputs: dict) -> str:
    """Build the HumanMessage content for an agent node.

    Args:
        user_prompt: The original user request
        parent_ids: Node IDs of direct predecessors (from EDGES)
        outputs: Current node_outputs state dict

    Returns:
        Formatted string with labeled inputs from each predecessor.
        The agent sees this as a single HumanMessage alongside its
        SystemMessage (the agent's instructions/persona).
    """
    parts = [f'Original user request: "{user_prompt}"', "",
             "You are receiving the following inputs from upstream agents in this workflow.",
             "Use them as source material to perform your task as defined in your system prompt.",
             "", "---"]
    valid = [(p, outputs[p]) for p in parent_ids if p in outputs]
    if not valid:
        parts.append("(no upstream inputs -- respond to the original user request directly)")
    else:
        for pid, out in valid:
            parts += ["", f"### Input from: {out.get('source', pid)}", "", out.get("text", ""), "", "---"]
    return "\n".join(parts)

PY;
    }

    private static function parentsChildrenBlock(): string
    {
        return <<<'PY'
def parents(nid: str) -> list[str]:
    """Get direct predecessor node IDs (nodes with edges INTO this node)."""
    return [f for f, t in EDGES if t == nid]

def children(nid: str) -> list[str]:
    """Get direct successor node IDs (nodes this node has edges TO)."""
    return [t for f, t in EDGES if f == nid]

PY;
    }

    private static function runHeaderBlock(): string
    {
        return <<<'PY'
async def run(user_prompt: str):
    """Execute the workflow with the given user prompt.

    Steps:
    1. Build LangChain tools from the embedded TOOL_CATALOG
    2. Initialize the LLM (Anthropic Claude)
    3. Construct a LangGraph StateGraph with nodes from ORDER
    4. Wire edges from EDGES (respecting topological order)
    5. Compile and invoke the graph
    6. Return the final output text
    """
    print("[info] Building tools from embedded catalog...")
    catalog = build_tools_from_catalog()
    # Local (non-MCP) tool: lets skill-bound agents run their folder-backed
    # skill as a subprocess. Always registered; only agents whose tool_names
    # include it (skill agents) actually receive it.
    catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL
    print(f"[info] {len(catalog)} tools ready: {sorted(catalog.keys())}")

PY;
    }

    private static function runBodyBlock(): string
    {
        return <<<'PY'
    # One LLM instance per agent — provider/model come from the AGENTS
    # dict, which the generator baked from each agent's workflow config.
    # Built eagerly (not per-call) so we fail fast on missing API keys.
    LLMS = {
        nid: _make_llm(
            ad.get("provider", "claude"),
            ad.get("model", ""),
            float(ad.get("temperature", 0.7)),
            int(ad.get("max_tokens", 4096)),
        )
        for nid, ad in AGENTS.items()
    }
    sg = StateGraph(WFState)

    for nid in ORDER:
        ntype = NODE_TYPES.get(nid, "")

        if ntype == "start":
            def make_start(n=nid):
                def _run(state):
                    text = state.get("user_prompt", "")
                    if START_DOCUMENTS:
                        doc_parts = []
                        for doc in START_DOCUMENTS:
                            name = doc.get("name", "Document")
                            path = doc.get("path", "")
                            if not path:
                                doc_parts.append(f"### {name}\n\n_(no path on attachment record)_")
                                continue
                            try:
                                md = _convert_doc_to_markdown(path)
                                doc_parts.append(f"### {name}\n\n{md}")
                            except Exception as e:
                                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                        if doc_parts:
                            text = (
                                "## Attached Documents\n\n"
                                + "\n\n---\n\n".join(doc_parts)
                                + "\n\n---\n\n"
                                + text
                            )
                    print(f"[node] [{n}] start -- {len(text)} chars")
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())

        elif ntype in ("agent", "agent-template"):
            def make_agent(n=nid):
                async def _run(state):
                    from pathlib import Path
                    from datetime import datetime as _dt
                    ad = AGENTS[n]
                    tool_names = ad["tool_names"]
                    tools = [catalog[t] for t in tool_names if t in catalog]
                    print(f"[node] [{n}] {ad['display']!r} -- {len(tools)} tools "
                          f"(provider={ad.get('provider', '?')}, model={ad.get('model', '?')})")

                    ctx = build_context(state.get("user_prompt", ""), parents(n), state.get("node_outputs", {}))
                    sys_chars = len(ad["system_prompt"]) if ad.get("system_prompt") else 0
                    print(f"[node] [{n}] inputs: system={sys_chars} chars, context={len(ctx)} chars", flush=True)

                    msgs = []
                    if ad["system_prompt"]:
                        msgs.append(SystemMessage(content=inject_datetime(ad["system_prompt"])))
                    msgs.append(HumanMessage(content=ctx))

                    # Per-agent LLM. Each agent uses the provider/model
                    # it was configured with in the workflow editor.
                    agent = create_react_agent(LLMS[n], tools)
                    t0 = time.monotonic()
                    result = await agent.ainvoke({"messages": msgs})
                    dt = time.monotonic() - t0

                    final = result["messages"][-1]
                    text = final.content if isinstance(final, AIMessage) else str(final)
                    if isinstance(text, list):
                        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))

                    msgs_out = result.get("messages", [])
                    llm_rounds = sum(1 for m in msgs_out if isinstance(m, AIMessage))
                    tool_results = sum(
                        1 for m in msgs_out
                        if getattr(m, "type", None) == "tool"
                        or m.__class__.__name__ == "ToolMessage"
                    )
                    print(f"[node] [{n}] done -- {len(text)} chars "
                          f"({llm_rounds} LLM rounds, {tool_results} tool results, {dt:.1f}s)")
                    # Preview of what the agent produced, so the log shows the
                    # actual answer without opening the _debug dump.
                    print(f"[node] [{n}] output head: {text[:240]!r}", flush=True)
                    # High-signal red flag: a tool-bound agent that ran ZERO
                    # tools almost certainly fabricated its answer (the exact
                    # failure that produced "Missing /llms.txt"). Surface it.
                    if tools and tool_results == 0:
                        print(f"[node] [{n}] ⚠ answered with 0 tool calls despite "
                              f"{len(tools)} tool(s) available — likely fabricated; "
                              f"check the skill ran", flush=True)

                    try:
                        script_root = Path(__file__).resolve().parent.parent
                        debug_dir = script_root / "outputs" / "_debug"
                        debug_dir.mkdir(parents=True, exist_ok=True)
                        ts = _dt.now().strftime("%Y%m%d-%H%M%S")
                        stem = Path(__file__).stem
                        dump_path = debug_dir / f"{stem}_{n}_{ts}.json"
                        entries = []
                        for m in msgs_out:
                            content = m.content
                            if isinstance(content, list):
                                content = [
                                    (b if isinstance(b, dict) else {"type": "text", "text": str(b)})
                                    for b in content
                                ]
                            entries.append({
                                "role": m.__class__.__name__,
                                "content": content,
                                "tool_calls": getattr(m, "tool_calls", None),
                                "tool_call_id": getattr(m, "tool_call_id", None),
                                "name": getattr(m, "name", None),
                            })
                        dump_path.write_text(
                            json.dumps(entries, default=str, indent=2, ensure_ascii=False),
                            encoding="utf-8",
                        )
                        print(f"[debug] [{n}] message history → outputs/_debug/{dump_path.name}")
                    except Exception as e:
                        print(f"[debug] [{n}] failed to dump message history: {e}")

                    # Mandatory skill pipeline: each attached skill runs on the agent's
                    # result in order; the last skill's produced deliverable (e.g. the html
                    # skill's rendered HTML file) becomes this node's output.
                    for _skill in ad.get("skills", []):
                        text = await _run_skill_step(_skill, text, LLMS[n])
                        print(f"[node] [{n}] after skill {_skill.get('dir') or 'inline'!r}: "
                              f"{len(text)} chars", flush=True)

                    return {"node_outputs": {n: {"source": ad["display"], "text": text}}}
                return _run
            sg.add_node(nid, make_agent())

        elif ntype == "output":
            def make_output(n=nid):
                def _run(state):
                    pids = parents(n)
                    outs = state.get("node_outputs", {})
                    if len(pids) == 1 and pids[0] in outs:
                        final = outs[pids[0]]["text"]
                    else:
                        blocks = [f"## {outs[p]['source']}\n\n{outs[p]['text']}" for p in pids if p in outs]
                        final = "\n\n---\n\n".join(blocks)
                    print(f"[node] [{n}] output -- {len(final)} chars")
                    return {"final_output": final}
                return _run
            sg.add_node(nid, make_output())

        else:
            sg.add_node(nid, lambda s: {})

    # Wire edges
    pos = {n: i for i, n in enumerate(ORDER)}
    sg.add_edge(START, ORDER[0])
    for nid in ORDER:
        for child in children(nid):
            if child in pos and pos[child] > pos[nid]:
                sg.add_edge(nid, child)
    for nid in ORDER:
        if not children(nid):
            sg.add_edge(nid, END)

    graph = sg.compile()
    print("[info] Running...")
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


if __name__ == "__main__":
    prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
    output = asyncio.run(run(prompt))
    print("\n" + "=" * 60)
    print("FINAL OUTPUT")
    print("=" * 60)
    print(output)

    # Honour the Output node's storage setting: when ON, save the final result where the
    # app stores it (~/Documents/synergyAI/outputs/workflow/ by default, overridable via
    # SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, don't save.
    if OUTPUT_STORAGE_ENABLED:
        try:
            import os, time
            _head = output[:500].lower()
            _ext = "html" if ("<!doctype" in _head or "<html" in _head) else "md"
            _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
            _ts = time.strftime("%Y%m%d-%H%M%S")
            _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
            if OUTPUT_FOLDER:
                _cf = os.path.expanduser(OUTPUT_FOLDER)
                _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)
            else:
                _save_dir = os.path.join(_root, "workflow")
            os.makedirs(_save_dir, exist_ok=True)
            _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
            with open(_out, "w", encoding="utf-8") as _f:
                _f.write(output)
            print(f"\nResult saved to: {os.path.abspath(_out)}")
        except Exception as e:
            print(f"\n[warn] failed to save result: {e}")
    else:
        print("\n[info] output storage is OFF -- result printed above, not saved")

PY;
    }
}
