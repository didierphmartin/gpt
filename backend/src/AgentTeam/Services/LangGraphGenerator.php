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
        $out = '';
        $len = strlen($name);
        for ($i = 0; $i < $len; $i++) {
            $c = $name[$i];
            $out .= ctype_alnum($c) ? $c : '_';
        }
        $out = trim($out, '_');
        return strtolower($out);
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

    /**
     * Serialize a value to a Python-valid literal string.
     *
     * json_encode produces 'true'/'false'/'null' which are not valid Python.
     * This converts to 'True'/'False'/'None'. Uses 4-space indent matching
     * Python's json.dumps(indent=4) output.
     *
     * @param mixed $value
     */
    private static function jsonToPython($value, bool $forceObject = false): string
    {
        if ($forceObject && is_array($value)) {
            // Cast top-level array to object so empty arrays encode as {}
            // and associative arrays encode as object literals.
            $value = (object) $value;
        }
        $raw = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $raw = str_replace(': true', ': True', $raw);
        $raw = str_replace(': false', ': False', $raw);
        $raw = str_replace(': null', ': None', $raw);
        return $raw;
    }

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
        $nodes = $graph['nodes'] ?? [];
        $edges = $graph['edges'] ?? [];

        $byId = [];
        foreach ($nodes as $n) {
            $byId[self::nodeId($n)] = $n;
        }
        $startNodes = array_values(array_filter($nodes, fn($n) => self::nodeType($n) === 'start'));
        if (empty($startNodes)) {
            throw new RuntimeException('No start node found.');
        }
        $startNode = $startNodes[0];
        $startId = self::nodeId($startNode);
        $startCfg = $startNode['config'] ?? $startNode['data'] ?? [];
        if (!is_array($startCfg)) {
            $startCfg = [];
        }
        $startPrompt = (string) ($startCfg['prompt'] ?? '');
        $startDocuments = $startCfg['documents'] ?? [];
        if (!is_array($startDocuments)) {
            $startDocuments = [];
        }
        $order = self::topoOrder($startId, $edges);

        // ---- RAG ingestion graph detection ----
        // An ingestion graph has no agent/tool/skill nodes; instead its
        // pipeline is loader -> splitter -> vectorstore. When detected we emit
        // a tiny self-contained script that calls ingestion.ingest() rather
        // than the full LangGraph runtime. The agent/tool/skill path below is
        // left completely untouched.
        $hasExecNode = false;
        foreach ($nodes as $n) {
            $t = self::nodeType($n);
            if (in_array($t, ['agent', 'agent-template', 'tool', 'skill'], true)) {
                $hasExecNode = true;
                break;
            }
        }
        $loaderNode = null;
        $splitterNode = null;
        $vectorstoreNode = null;
        foreach ($nodes as $n) {
            switch (self::nodeType($n)) {
                case 'loader':
                    $loaderNode = $loaderNode ?? $n;
                    break;
                case 'splitter':
                    $splitterNode = $splitterNode ?? $n;
                    break;
                case 'vectorstore':
                    $vectorstoreNode = $vectorstoreNode ?? $n;
                    break;
            }
        }
        if (!$hasExecNode && $vectorstoreNode !== null && $loaderNode !== null) {
            return self::generateIngestionScript(
                $workflowId,
                $wfName,
                $loaderNode,
                $splitterNode,
                $vectorstoreNode,
                $startDocuments
            );
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

            // Append node-level skill content as a distinct "## Skill" section
            // to mirror GraphWorkflowRunner::executeAgentNode behaviour.
            $skillContent = trim((string) ($cfg['skill_content'] ?? ''));
            if ($skillContent !== '') {
                $systemPrompt = rtrim($systemPrompt) . "\n\n## Skill\n" . $skillContent;
            }

            // Per-agent sampling/limits saved by the editor under `settings`.
            // Defaults mirror the editor form defaults so a regenerated
            // script behaves the same as the PHP runner.
            $cfgSettings = $cfg['settings'] ?? [];
            if (!is_array($cfgSettings)) {
                $cfgSettings = [];
            }
            $agentTemperature = (float) ($cfgSettings['temperature'] ?? 0.7);
            $agentMaxTokens = (int) ($cfgSettings['max_tokens'] ?? 4096);

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
            ];
        }

        // Filter catalog to only tools actually used by agents
        $usedCatalog = [];
        foreach ($toolCatalog as $k => $v) {
            if (isset($allNeededTools[$k])) {
                $usedCatalog[$k] = $v;
            }
        }
        // Flag tools that agents need but aren't available as MCP
        $missing = [];
        foreach (array_keys($allNeededTools) as $tn) {
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
        $lines[] = 'import asyncio, json, os, sys, time';
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
        $lines[] = '        # K2 models enforce non-thinking sampling values; mirror the';
        $lines[] = '        # PHP KimiProvider so the API accepts the request. The';
        $lines[] = "        # editor's temperature is overridden here (API requirement);";
        $lines[] = '        # max_tokens is still honoured.';
        $lines[] = '        kwargs = dict(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.moonshot.ai/v1",';
        $lines[] = '            api_key=os.environ.get("KIMI_API_KEY"),';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '        if model.startswith("kimi-k2"):';
        $lines[] = '            kwargs["temperature"] = 0.6';
        $lines[] = '            kwargs["top_p"] = 0.95';
        $lines[] = '            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}';
        $lines[] = '        else:';
        $lines[] = '            kwargs["temperature"] = temperature';
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
        $lines[] = 'MCP_SERVERS = ' . self::jsonToPython($serverRegistry, true);
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
        $lines[] = 'TOOL_CATALOG = ' . self::jsonToPython($usedCatalog, true);
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
        $lines[] = self::mcpClientBlock();

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
        $lines[] = self::documentConverterBlock();

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
        if (!empty($startDocuments)) {
            $lines[] = 'START_DOCUMENTS = ' . self::jsonToPython($startDocuments);
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
            $lines[] = '        "tool_names": ' . $toolsList . ',';
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
        $lines[] = 'EDGES = ' . self::jsonToPython($edgeList);
        $lines[] = 'ORDER = ' . self::jsonToPython($order);
        $lines[] = '';
        $lines[] = self::parentsChildrenBlock();

        $typeMap = [];
        foreach ($order as $nid) {
            $typeMap[$nid] = self::nodeType($byId[$nid]);
        }
        $lines[] = 'NODE_TYPES = ' . self::jsonToPython($typeMap, true);
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
     * Read a node's `config` array (same shape the agent/tool/skill path uses).
     *
     * @param array<string,mixed>|null $node
     * @return array<string,mixed>
     */
    private static function nodeConfig(?array $node): array
    {
        if ($node === null) {
            return [];
        }
        $cfg = $node['config'] ?? [];
        if (!is_array($cfg)) {
            $cfg = [];
        }
        return $cfg;
    }

    /**
     * Slugify a workflow name for a default vectorstore collection:
     * lowercase, non-alphanumeric runs collapsed to '_', trimmed.
     */
    private static function slugify(string $name): string
    {
        $slug = strtolower($name);
        $slug = (string) preg_replace('/[^a-z0-9]+/', '_', $slug);
        $slug = trim($slug, '_');
        return $slug;
    }

    /**
     * Emit a self-contained Python ingestion script that calls
     * langchain_runner/ingestion.py's ingest(loader_cfg, splitter_cfg,
     * store_cfg). Returned in the same {filename, code} shape generate() uses.
     *
     * @param array<string,mixed>      $loaderNode
     * @param array<string,mixed>|null $splitterNode
     * @param array<string,mixed>      $vectorstoreNode
     * @param array<int,mixed>         $startDocuments
     * @return array{filename: string, code: string}
     */
    private static function generateIngestionScript(
        int $workflowId,
        string $wfName,
        array $loaderNode,
        ?array $splitterNode,
        array $vectorstoreNode,
        array $startDocuments
    ): array {
        // ───────────────────────────────────────────────────────────────
        // EXTENSION POINTS (v1 is the strict minimum — extend these together
        // with the editor's dropdowns when adding options; see the design spec
        // docs/superpowers/specs/2026-06-10-rag-ingestion-components-design.md §4/§5):
        //   • loader.source : v1 pdf/text → future web (WebBaseLoader),
        //                     sql (SQLDatabaseLoader), mcp:<server>.
        //   • vectorstore.store : v1 pgvector → future faiss/chroma/mcp:<server>.
        //   • splitter.strategy : v1 recursive only → future "auto", which MUST
        //     pick the splitter from the loader's FILE TYPE / content kind:
        //       markdown → MarkdownHeaderTextSplitter
        //       code     → RecursiveCharacterTextSplitter.from_language
        //       html     → HTMLHeaderTextSplitter
        //       json     → RecursiveJsonSplitter
        //       rows     → row-serialization template (tabular)
        // The emitted python below (the source switch, the strategy, the store
        // check) is where each new option gets a branch.
        // ───────────────────────────────────────────────────────────────
        $loaderCfg = self::nodeConfig($loaderNode);
        $splitterCfg = self::nodeConfig($splitterNode);
        $storeCfg = self::nodeConfig($vectorstoreNode);

        $firstDoc = $startDocuments[0] ?? null;
        if (is_array($firstDoc)) {
            // Start documents may be stored as {path: ...} objects.
            $firstDoc = $firstDoc['path'] ?? null;
        }

        $loaderJson = [
            'source' => $loaderCfg['source'] ?? 'pdf',
            'path'   => $loaderCfg['path'] ?? $firstDoc,
        ];
        $splitterJson = [
            'strategy'   => $splitterCfg['strategy'] ?? 'recursive',
            'chunk_size' => $splitterCfg['chunk_size'] ?? 1000,
            'overlap'    => $splitterCfg['overlap'] ?? 150,
        ];
        $defaultCollection = self::slugify($wfName);
        if ($defaultCollection === '') {
            $defaultCollection = 'workflow_' . $workflowId;
        }
        $storeJson = [
            'store'      => $storeCfg['store'] ?? 'pgvector',
            'embeddings' => $storeCfg['embeddings'] ?? 'openai:text-embedding-3-small',
            'collection' => $storeCfg['collection'] ?? $defaultCollection,
        ];

        $loaderLit = json_encode($loaderJson, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $splitterLit = json_encode($splitterJson, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $storeLit = json_encode($storeJson, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        // ── Python pipeline fragments (one per choice) ───────────────────
        // Each fragment is a self-contained block that advances the pipeline:
        // a loader sets `docs`, a splitter sets `chunks` from `docs`, the
        // embeddings sets `embeddings`, the store writes + sets `result`.
        // To add a new loader source / splitter strategy / store / embeddings
        // provider: add ONE fragment + its dispatch entry below (and the
        // matching editor dropdown). The skeleton stays choice-agnostic.
        $pyLoadPdf = <<<'PYB'
if not LOADER.get("path"):
    raise RuntimeError("loader path is empty (set the loader Path or the Start node's document)")
docs = PyPDFLoader(LOADER["path"]).load()
PYB;
        $pyLoadText = <<<'PYB'
if not LOADER.get("path"):
    raise RuntimeError("loader path is empty (set the loader Path or the Start node's document)")
docs = TextLoader(LOADER["path"], encoding="utf-8").load()
PYB;
        $pyLoadWord = <<<'PYB'
if not LOADER.get("path"):
    raise RuntimeError("loader path is empty (set the loader Path or the Start node's document)")
docs = Docx2txtLoader(LOADER["path"]).load()
PYB;
        $pyLoadCsv = <<<'PYB'
if not LOADER.get("path"):
    raise RuntimeError("loader path is empty (set the loader Path or the Start node's document)")
docs = CSVLoader(LOADER["path"]).load()
PYB;
        $pySplitRecursive = <<<'PYB'
splitter = RecursiveCharacterTextSplitter(
    chunk_size=int(SPLITTER.get("chunk_size", 1000)),
    chunk_overlap=int(SPLITTER.get("overlap", 150)),
)
chunks = splitter.split_documents(docs)
PYB;
        $pyEmbedOpenAI = <<<'PYB'
emb_model = (STORE.get("embeddings") or "openai:text-embedding-3-small").partition(":")[2]
embeddings = OpenAIEmbeddings(model=emb_model or "text-embedding-3-small")
PYB;
        $pyStorePgvector = <<<'PYB'
dsn = os.environ.get("VECTOR_DB_DSN")
if not dsn:
    raise RuntimeError("VECTOR_DB_DSN is not set")
collection = STORE.get("collection") or "default"
PGVector.from_documents(
    documents=chunks,
    embedding=embeddings,
    collection_name=collection,
    connection=dsn,
    use_jsonb=True,
)
result = {"store": "pgvector", "collection": collection, "chunks": len(chunks)}
PYB;

        // ── Dispatch tables: choice → { python import, pipeline fragment } ──
        $loaderDispatch = [
            'pdf'  => ['import' => 'from langchain_community.document_loaders import PyPDFLoader',   'block' => $pyLoadPdf],
            'word' => ['import' => 'from langchain_community.document_loaders import Docx2txtLoader', 'block' => $pyLoadWord],
            'text' => ['import' => 'from langchain_community.document_loaders import TextLoader',     'block' => $pyLoadText],
            'csv'  => ['import' => 'from langchain_community.document_loaders import CSVLoader',      'block' => $pyLoadCsv],
            // future: 'web' => WebBaseLoader, 'sql' => SQLDatabaseLoader, 'mcp:<srv>' => MCP adapter
        ];
        $splitterDispatch = [
            'recursive' => ['import' => 'from langchain_text_splitters import RecursiveCharacterTextSplitter', 'block' => $pySplitRecursive],
            // future: 'markdown' => MarkdownHeaderTextSplitter, 'auto' => route by content kind, 'rows' => row template
        ];
        $embeddingsDispatch = [
            'openai' => ['import' => 'from langchain_openai import OpenAIEmbeddings', 'block' => $pyEmbedOpenAI],
            // future: 'ollama' => OllamaEmbeddings, 'hf' => HuggingFaceEmbeddings, 'mcp:<srv>'
        ];
        $storeDispatch = [
            'pgvector' => ['import' => 'from langchain_postgres import PGVector', 'block' => $pyStorePgvector],
            // future: 'faiss', 'chroma', 'mcp:<srv>'
        ];

        // Resolve the chosen options; fail loudly if the editor offered an
        // option the compiler has no fragment for yet.
        $source = $loaderJson['source'];
        $strategy = $splitterJson['strategy'];
        $store = $storeJson['store'];
        $embProvider = strtok((string) $storeJson['embeddings'], ':') ?: 'openai';
        foreach ([
            ['loader source', $source, $loaderDispatch],
            ['splitter strategy', $strategy, $splitterDispatch],
            ['embeddings provider', $embProvider, $embeddingsDispatch],
            ['vector store', $store, $storeDispatch],
        ] as [$label, $choice, $table]) {
            if (!isset($table[$choice])) {
                throw new \RuntimeException("ingestion compiler: no fragment for {$label} '{$choice}' yet — add it to the dispatch table.");
            }
        }
        $L = $loaderDispatch[$source];
        $S = $splitterDispatch[$strategy];
        $E = $embeddingsDispatch[$embProvider];
        $V = $storeDispatch[$store];

        // Compose only the imports the chosen fragments need (dedup, stable order).
        $importBlock = implode("\n", array_values(array_unique([$L['import'], $S['import'], $E['import'], $V['import']])));
        $loaderBlock = $L['block'];
        $splitterBlock = $S['block'];
        $embeddingsBlock = $E['block'];
        $storeBlock = $V['block'];

        // Choice-agnostic skeleton. Self-contained standalone script: needs only
        // the venv libs for the chosen backends + VECTOR_DB_DSN/OPENAI_API_KEY,
        // so it can be downloaded and run anywhere.
        $code = <<<PY
# Standalone RAG ingestion script — generated from workflow {$workflowId}.
# Composed from the chosen loader/splitter/embeddings/store fragments.
import json, os
{$importBlock}

LOADER = {$loaderLit}
SPLITTER = {$splitterLit}
STORE = {$storeLit}

# 1. Load → docs
{$loaderBlock}

# 2. Split → chunks
{$splitterBlock}

# 3. Embeddings → embeddings
{$embeddingsBlock}

# 4. Store (writes chunks, sets `result`)
{$storeBlock}

print(json.dumps(result))
PY;

        return [
            'filename' => "ingestion_{$workflowId}.py",
            'code'     => $code,
        ];
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

    private static function mcpClientBlock(): string
    {
        return <<<'PY'
def _normalize_mcp_url(url: str) -> str:
    """Ensure the URL points to the MCP endpoint.

    - If it already ends with /mcp, leave it alone.
    - If it ends with a .php file, it IS the endpoint already (XAMPP-style
      MCP server scripts like mcp-server.php). Don't append anything.
    - Otherwise, append /mcp per the MCP convention.
    """
    url = url.rstrip("/")
    if url.endswith("/mcp") or url.endswith(".php"):
        return url
    return url + "/mcp"

def _init_mcp_session(url: str, headers: dict) -> bool:
    """Initialize an MCP session with the server.

    The MCP protocol requires a handshake before tool calls:
    1. Client sends 'initialize' with protocol version and capabilities
    2. Server responds with its capabilities
    3. Client sends 'notifications/initialized' to confirm

    Returns True on success, False on failure.
    """
    mcp_url = _normalize_mcp_url(url)
    init_req = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "LangGraph-Workflow", "version": "1.0.0"},
            "capabilities": {}
        }
    }
    try:
        with httpx.Client(timeout=30) as c:
            r = c.post(mcp_url, json=init_req, headers=headers)
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
            if data is None or "error" in (data or {}):
                return False
            # Send initialized notification
            c.post(mcp_url, json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {}
            }, headers=headers)
            return True
    except Exception as e:
        print(f"[warn] MCP init failed for {url}: {e}")
        return False

def _parse_mcp_response(text: str) -> dict | None:
    """Parse a JSON-RPC response from an MCP server.

    MCP servers may respond in two formats:
    - Plain JSON: standard JSON-RPC response body
    - SSE (Server-Sent Events): lines prefixed with 'data:' containing JSON
    This function tries plain JSON first, then falls back to SSE parsing.
    """
    import json as _json
    try:
        return _json.loads(text)
    except _json.JSONDecodeError:
        pass
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                try:
                    return _json.loads(data)
                except _json.JSONDecodeError:
                    continue
    return None

def _call_mcp_tool(server_url: str, tool_name: str,
                   arguments: dict) -> str:
    """Call a tool on an MCP server via JSON-RPC 2.0.

    Sequence: init session -> send tools/call -> parse response -> extract text.
    The MCP response contains a 'content' array; we extract all text items
    and join them. If no text is found, falls back to raw JSON.
    """
    mcp_url = _normalize_mcp_url(server_url)
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream, */*"}

    _init_mcp_session(server_url, headers)

    request = {
        "jsonrpc": "2.0", "id": int(time.time()),
        "method": "tools/call",
        "params": {"name": tool_name,
                   "arguments": arguments or {}}
    }
    try:
        with httpx.Client(timeout=180) as c:
            r = c.post(mcp_url, json=request, headers=headers)
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
    except Exception as e:
        return json.dumps({"error": str(e)})

    if data is None:
        return json.dumps({"error": "invalid response"})
    if "error" in data:
        return json.dumps({"error": data["error"].get("message", "unknown")})

    content = (data.get("result") or {}).get("content", [])
    texts = [c.get("text", "") for c in content
             if isinstance(c, dict) and c.get("type") == "text"]
    return "\n".join(t for t in texts if t) or json.dumps(data.get("result"))[:8000]

PY;
    }

    private static function toolBuilderBlock(): string
    {
        return <<<'PY'
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

    private static function documentConverterBlock(): string
    {
        return <<<'PY'
def _convert_doc_to_markdown(path: str) -> str:
    """Read a file and return its contents as Markdown.

    Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/XML/source) are returned
    verbatim. Binary office formats and PDFs are routed to their matching
    pure-Python parser. Imports are lazy so the script doesn't pull in a
    library unless the corresponding format is actually attached.

    Raises FileNotFoundError if the path doesn't exist, ValueError for an
    unsupported extension, ImportError if the format's library is missing.
    """
    from pathlib import Path
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"document not found: {path}")
    ext = p.suffix.lower()

    text_native = {
        ".html", ".htm", ".md", ".markdown", ".txt", ".text",
        ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv",
        ".css", ".scss", ".less",
        ".js", ".mjs", ".ts", ".tsx", ".jsx",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
        ".sh", ".bash", ".zsh", ".sql", ".log", ".rtf", ".ini", ".toml",
    }
    if ext in text_native:
        return p.read_text(encoding="utf-8", errors="replace")

    if ext == ".docx":
        import mammoth
        with p.open("rb") as f:
            return mammoth.convert_to_markdown(f).value

    if ext == ".pptx":
        from pptx import Presentation
        prs = Presentation(str(p))
        sections = [f"# {p.name}", f"_{len(prs.slides)} slide(s)_"]
        for i, slide in enumerate(prs.slides, start=1):
            layout = slide.slide_layout.name if slide.slide_layout else "?"
            sections.append(f"## Slide {i} -- {layout}")
            title_text = ""
            if slide.shapes.title and slide.shapes.title.has_text_frame:
                title_text = slide.shapes.title.text_frame.text.strip()
            if title_text:
                sections.append(f"### {title_text}")
            body = []
            for shape in slide.shapes:
                if shape == slide.shapes.title:
                    continue
                if not getattr(shape, "has_text_frame", False):
                    continue
                for para in shape.text_frame.paragraphs:
                    line = "".join(run.text or "" for run in para.runs).strip()
                    if not line and para.text:
                        line = para.text.strip()
                    if line:
                        indent = "  " * (para.level or 0)
                        body.append(f"{indent}- {line}")
            if body:
                sections.append("\n".join(body))
            if slide.has_notes_slide:
                notes = (slide.notes_slide.notes_text_frame.text or "").strip()
                if notes:
                    sections.append("### Notes")
                    sections.append(notes)
        return "\n\n".join(sections) + "\n"

    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(str(p), data_only=True)
        sections = [f"# {p.name}", f"_{len(wb.sheetnames)} sheet(s)_"]
        max_rows = 200
        for name in wb.sheetnames:
            ws = wb[name]
            rows = []
            for row in ws.iter_rows(values_only=True):
                row_vals = list(row)
                while row_vals and (row_vals[-1] is None or row_vals[-1] == ""):
                    row_vals.pop()
                if row_vals or not rows:
                    rows.append(row_vals)
            while rows and not any(c not in (None, "") for c in rows[-1]):
                rows.pop()
            sections.append(f"## Sheet: {name}")
            sections.append(f"_{len(rows)} row(s) -- {ws.max_column} col(s)_")
            if not rows:
                sections.append("_(empty)_")
                continue
            width = max(len(r) for r in rows)
            rows = [list(r) + [""] * (width - len(r)) for r in rows]
            truncated = len(rows) > max_rows
            if truncated:
                rows = rows[:max_rows]
            def cell(v):
                return ("" if v is None else str(v)).replace("|", "\\|").replace("\n", " ")
            table = ["| " + " | ".join(cell(v) for v in rows[0]) + " |",
                     "| " + " | ".join(["---"] * width) + " |"]
            for r in rows[1:]:
                table.append("| " + " | ".join(cell(v) for v in r) + " |")
            if truncated:
                table.append(f"\n_(showing first {max_rows} rows)_")
            sections.append("\n".join(table))
        return "\n\n".join(sections) + "\n"

    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        parts = [f"# {p.name} -- {len(reader.pages)} page(s)"]
        for i, page in enumerate(reader.pages, start=1):
            try:
                t = (page.extract_text() or "").strip()
            except Exception as e:
                t = ""
            parts.append(f"## Page {i}")
            parts.append(t if t else "_(no extractable text)_")
        return "\n\n".join(parts) + "\n"

    raise ValueError(f"unsupported document format: {ext}")

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
    print(f"[info] {len(catalog)} MCP tools ready: {sorted(catalog.keys())}")

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

    # Save via script_io.write_output -- writes to <install>/outputs/
    # with auto HTML/MD detection. The scripts/ folder stays scripts-only.
    try:
        from script_io import write_output
        result_file = write_output(output, __file__, prompt=prompt)
        print(f"\nResult saved to: {result_file}")
    except Exception as e:
        print(f"\n[warn] failed to save result via script_io: {e}")

PY;
    }
}
