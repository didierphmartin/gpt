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
        // The DB column can be '' (editor-saved agent-template nodes): treat
        // empty like missing and fall back to config.type.
        foreach ([$n['node_type'] ?? null, $n['type'] ?? null, $cfg['type'] ?? null] as $t) {
            if ($t !== null && (string) $t !== '') {
                return (string) $t;
            }
        }
        return '';
    }

    /** "<server slug>.<tool>" ids the playbook analyzer binds against — twin of LoaderMcpExecutor::slug(). */
    private static function serverSlug(string $serverName): string
    {
        return strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $serverName));
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
    private function loadMcpToolsWithServers(?string $userId = null): array
    {
        // Global servers plus the caller's own registrations — the same
        // registry chat and the browser runner see (MCPToolsLoader).
        $sql = "SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND (s.user_id IS NULL" . ($userId !== null && $userId !== '' ? " OR s.user_id = :uid" : '') . ")";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($userId !== null && $userId !== '' ? ['uid' => $userId] : []);
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
    public function generate(int $workflowId, ?string $userId = null, array $options = []): array
    {
        $facts = $this->analyzeForEmit($workflowId, $userId);
        if (!empty($options['a2a'])) {
            return $this->generateA2A($facts);   // Task 4
        }
        if (!empty($options['modular'])) {
            return $this->generateModular($facts);   // "agents in separate files"
        }
        // The emitter below was written against local variables; expose the
        // facts under their original names (EXTR_SKIP: never clobber $this).
        extract($facts, EXTR_SKIP);
        // ---- emit code ----
        $lines = [];
        // Box-drawing separator used in section headers (62 '═' chars,
        // matching Python's literal string).
        $sep = '# ' . str_repeat("=", 62);

        // ---- module docstring: the uniform documentation every target carries ----
        $docAgents = [];
        foreach ($agentData as $nid => $ad) {
            $docAgents[$nid] = ['name' => $ad['display'], 'provider' => $ad['provider'], 'model' => $ad['model'],
                'temperature' => $ad['temperature'], 'max_tokens' => $ad['max_tokens'], 'thinking' => $ad['thinking'],
                'tools' => $ad['tool_names'], 'skills' => $ad['skills']];
        }
        $docExtra = [];
        foreach ($dispatchTargets as $nid => $targets) {
            $docExtra[$nid]['dispatch'] = array_column($targets, 'name');
        }
        foreach ($playbookData as $nid => $pd) {
            $mcpCount = count(array_filter($pd['actions'], fn($a) => ($a['kind'] ?? '') === 'mcp'));
            $docExtra[$nid]['playbook'] = ['title' => $pd['title'], 'writes' => $pd['writes_enabled'],
                'bound' => $mcpCount, 'unbound' => count($pd['actions']) - $mcpCount];
            $docAgents[$nid] = ['name' => $pd['display'], 'provider' => $pd['provider'], 'model' => $pd['model'],
                'temperature' => $pd['temperature'], 'max_tokens' => $pd['max_tokens'], 'thinking' => $pd['thinking'],
                'tools' => [], 'skills' => []];
        }
        $docNodes = \AgentTeam\Services\WorkflowGraphAnalyzer::docNodes($byId, $order, $edges, $docAgents, $docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'output']);
        $docById = [];
        foreach ($docNodes as $dn) {
            $docById[$dn['id']] = $dn;
        }
        $docBody = PythonEmitHelpers::workflowDocBlock([
            'target' => 'LangGraph (Python) -- langgraph StateGraph + LangChain ReAct agents',
            'dispatch_supported' => true,
            'workflow' => ['id' => $workflowId, 'name' => $wfName],
            'nodes' => $docNodes,
            'edges' => $edgeList,
            'layers' => $gdata['layers'] ?? [],
            'data_flow' => self::dataFlowDoc(),
            'run' => [
                'deps' => ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                           '# optional, only for the attachment formats you use:',
                           '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'],
                'usage' => "python {$safeName}_langgraph.py \"your prompt here\"",
                'extra' => !empty($missing)
                    ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' . self::pythonListRepr($missing)]
                    : [],
            ],
            'storage' => ['enabled' => $workflow->isOutputStorageEnabled(), 'folder' => $workflow->getOutputFolder()],
        ]);
        $lines[] = '"""Standalone LangGraph workflow: ' . $wfName;
        $lines[] = '';
        foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $docBody)) as $dl) {
            $lines[] = $dl;
        }
        $lines[] = '"""';
        $lines[] = 'from __future__ import annotations';
        $lines[] = '';
        $lines[] = 'import asyncio, json, os, re, subprocess, sys, threading, time';
        $lines[] = '';
        $lines[] = 'from dotenv import load_dotenv';
        $lines[] = '';
        $lines[] = '# Load provider API keys from the runner env .env (one dir up from scripts/).';
        $lines[] = '# Without this a DIRECT terminal run has no credentials and every provider';
        $lines[] = '# call fails; runner-mediated runs only worked because main.py loads the';
        $lines[] = '# same file and subprocesses inherit the environment.';
        $lines[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))';
        $lines[] = 'from typing import Annotated, Any, Literal, TypedDict';
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
        foreach (self::llmFactoryLines() as $l) {
            $lines[] = $l;
        }
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
        $lines[] = self::dispatchBlock();
        if ($playbookData !== []) {
            $lines[] = self::playbookRuntimeBlock();
        }

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
            if (isset($docById[$nid])) {
                foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                    $lines[] = $cl;
                }
            }
            $lines[] = '    "' . $nid . '": {';
            $lines[] = '        "display": ' . $displayJson . ',';
            $lines[] = '        "provider": ' . $providerJson . ',';
            $lines[] = '        "model": ' . $modelJson . ',';
            $lines[] = '        "temperature": ' . $temperatureLit . ',';
            $lines[] = '        "max_tokens": ' . $maxTokensLit . ',';
            $thinkLit = in_array($ad['thinking'] ?? null, ['on', 'off'], true)
                ? '"' . $ad['thinking'] . '"' : 'None';
            $lines[] = '        "thinking": ' . $thinkLit . ',  # node form Thinking attribute';
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
            if (!empty($ad['dispatch'])) {
                // Dispatcher menu: the node calls route_to over these names and only
                // the chosen child runs (conditional edge in run()).
                $lines[] = '        "dispatch": [' . implode(', ', array_map(
                    fn($t) => '{"id": ' . json_encode((string) $t['id']) . ', "name": ' . json_encode((string) $t['name'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '}',
                    $ad['dispatch']
                )) . '],';
            }
            $lines[] = '    },';
        }
        $lines[] = '}';
        $lines[] = '';
        $lines[] = $sep;
        $lines[] = '# PLAYBOOK DEFINITIONS';
        $lines[] = '#';
        $lines[] = '# A playbook node runs the Console-style playbook text through the';
        $lines[] = '# playbook runtime below: native verbs (messages, notes, resolve), human';
        $lines[] = '# gates, and the MCP tools its #Actions were bound to at generation time.';
        $lines[] = '#   actions:        bound MCP actions (llm_name -> server_url/tool) and';
        $lines[] = '#                   unbound stubs (the on_unbound policy applies)';
        $lines[] = '#   writes_enabled: node toggle; write tools are blocked when False';
        $lines[] = $sep;
        $lines[] = '';
        if ($playbookData === []) {
            $lines[] = 'PLAYBOOKS = {}';
        } else {
            $lines[] = 'PLAYBOOKS = {';
            foreach ($playbookData as $nid => $pd) {
                $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if (isset($docById[$nid])) {
                    foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                        $lines[] = $cl;
                    }
                }
                $lines[] = '    "' . $nid . '": {';
                $lines[] = '        "display": ' . $j($pd['display']) . ',';
                $lines[] = '        "title": ' . $j($pd['title']) . ',';
                $lines[] = '        "domain": ' . $j($pd['domain']) . ',';
                $lines[] = '        "provider": ' . $j($pd['provider']) . ',';
                $lines[] = '        "model": ' . $j($pd['model']) . ',';
                $lines[] = '        "temperature": ' . json_encode((float) $pd['temperature']) . ',';
                $lines[] = '        "max_tokens": ' . (int) $pd['max_tokens'] . ',';
                $lines[] = '        "thinking": ' . ($pd['thinking'] !== null ? '"' . $pd['thinking'] . '"' : 'None') . ',';
                $lines[] = '        "writes_enabled": ' . ($pd['writes_enabled'] ? 'True' : 'False') . ',';
                $lines[] = '        "policy": ' . PythonEmitHelpers::jsonToPython($pd['policy'], true) . ',';
                $lines[] = '        "approvers": ' . PythonEmitHelpers::jsonToPython($pd['approvers'], true) . ',';
                $lines[] = '        "requester": ' . PythonEmitHelpers::jsonToPython($pd['requester'], true) . ',';
                $lines[] = '        "instructions": """';
                foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $pd['instructions'])) as $pl) {
                    $lines[] = $pl;
                }
                $lines[] = '""",';
                $lines[] = '        "actions": ' . PythonEmitHelpers::jsonToPython($pd['actions'], false) . ',';
                $lines[] = '    },';
            }
            $lines[] = '}';
        }
        $lines[] = '';

        // ---------- edge data ----------
        $lines[] = $sep;
        $lines[] = '# GRAPH STRUCTURE';
        $lines[] = '#';
        $lines[] = '# EDGES: directed connections as (from_node_id, to_node_id) tuples.';
        $lines[] = "# ORDER: topological execution order (Kahn's algorithm).";
        $lines[] = '#        Guarantees every node runs after all its predecessors.';
        $lines[] = "# NODE_TYPES: maps node_id -> type ('start', 'agent', 'playbook', 'output').";
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
        // Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py
        // (LangGraph was the original default and previously had no suffix).
        $filename = "{$safeName}_langgraph.py";
        return ['filename' => $filename, 'code' => $code];
    }

    /**
     * Everything the emitters need, computed once: workflow identity, graph
     * (byId/order/edges/layers), start node, provider defaults, the MCP
     * registry and per-agent tool catalog, dispatcher targets, agent and
     * playbook definitions, documentation descriptors. No Python is produced
     * here. Shared by the single-file and the A2A emitters.
     */
    private function analyzeForEmit(int $workflowId, ?string $userId): array
    {
        // Force shortest round-tripping floats: the web SAPI's serialize_precision=100 makes
        // json_encode bake temperatures like 0.5999999999999999… which strict models reject
        // ("only 0.6 is allowed"). See MAFGenerator::emitMaf for the full note.
        ini_set('serialize_precision', '-1');
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
        $mcpTools = $this->loadMcpToolsWithServers($userId);

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

        // Playbook binding ids ("<server slug>.<tool>") over the same registry,
        // keyed the way LoaderMcpExecutor::availableTools() keys them.
        $availableById = [];
        foreach ($mcpTools as $t) {
            $surl = (string) ($t['server_url'] ?? '');
            $tname = (string) ($t['tool_name'] ?? $t['name'] ?? '');
            if ($surl === '' || $tname === '') {
                continue;
            }
            $schema = $t['input_schema'] ?? null;
            $availableById[self::serverSlug((string) ($t['server_name'] ?? '')) . '.' . $tname] = [
                'server_url' => $surl,
                'tool' => $tname,
                'description' => (string) ($t['tool_description'] ?? $t['description'] ?? ''),
                'input_schema' => $schema === null ? new \stdClass() : $schema,
            ];
        }

        // Dispatcher agents: their fan-out is a MENU, not a parallel fan-out
        // (DispatchRouting). Resolve each dispatcher's targets (agent/playbook
        // children, edge order) and which child is routed-to by whom BEFORE the
        // per-node loops, so a child's prompt can carry the routed fragment.
        $agentTypeCache = [];
        $agentTypeOf = function (array $node) use (&$agentTypeCache): string {
            $cfg = is_array($node['config'] ?? null) ? $node['config'] : [];
            $t = (string) ($cfg['agent_type'] ?? '');
            if ($t !== '') {
                return $t;
            }
            $aid = $node['agent_id'] ?? ($cfg['agent_id'] ?? null);
            if ($aid === null || $aid === '') {
                return 'standard';
            }
            $aid = (int) $aid;
            if (!array_key_exists($aid, $agentTypeCache)) {
                try {
                    $a = $this->agentRepo->findById($aid);
                    $agentTypeCache[$aid] = $a ? (string) ($a->toArray()['agent_type'] ?? 'standard') : 'standard';
                } catch (\Throwable $_) {
                    $agentTypeCache[$aid] = 'standard';
                }
            }
            return $agentTypeCache[$aid];
        };
        $dispatchTargets = []; // dispatcher nid => [['id' => child nid, 'name' => display], …]
        $routedBy = [];        // child nid => dispatcher display name
        foreach ($order as $nid) {
            $node = $byId[$nid];
            if (!in_array(self::nodeType($node), ['agent', 'agent-template'], true) || $agentTypeOf($node) !== 'dispatcher') {
                continue;
            }
            $targets = [];
            foreach ($edges as $e) {
                if (self::edgeFrom($e) !== $nid) {
                    continue;
                }
                $childId = self::edgeTo($e);
                $child = $byId[$childId] ?? null;
                if (!$child || !in_array(self::nodeType($child), ['agent', 'agent-template', 'playbook'], true)) {
                    continue;
                }
                $targets[] = ['id' => $childId, 'name' => self::displayName($child)];
                $routedBy[$childId] = self::displayName($node);
            }
            if ($targets !== []) {
                $dispatchTargets[$nid] = $targets;
            }
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

            // Dispatcher routing (twin of GraphWorkflowRunner): the dispatcher's
            // prompt lists its menu and demands route_to; a routed-to child is
            // told it was chosen so it handles the request instead of re-routing.
            if ($systemPrompt === '') {
                $systemPrompt = DispatchRouting::defaultInstructions(self::displayName($node), (string) ($cfg['description'] ?? ''), $wfName);
            }
            $dispatch = $dispatchTargets[$nid] ?? [];
            if ($dispatch !== []) {
                $systemPrompt = rtrim($systemPrompt) . "\n\n" . DispatchRouting::promptBlock($dispatch);
            }
            if (isset($routedBy[$nid])) {
                $systemPrompt = rtrim($systemPrompt) . "\n\n" . DispatchRouting::routedPrompt(self::displayName($node), $routedBy[$nid], '');
            }

            // Per-agent sampling/limits saved by the editor under `settings`.
            // Defaults mirror the editor form defaults so a regenerated
            // script behaves the same as the PHP runner.
            $cfgSettings = $cfg['settings'] ?? [];
            if (!is_array($cfgSettings)) {
                $cfgSettings = [];
            }
            $agentTemperature = (float) ($cfgSettings['temperature'] ?? 0.7);
            // max_tokens comes from the agent form VERBATIM -- no substitution. If a node's
            // output truncates (e.g. a full HTML report needs more than 4096), raise it in
            // that node's form; the compiler never overrides a form-stated value.
            $agentMaxTokens = (int) ($cfgSettings['max_tokens'] ?? 4096);

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
                // Per-agent Thinking switch ('on'|'off'|null) — node form attribute.
                'thinking' => (in_array($cfgSettings['thinking'] ?? null, ['on', 'off'], true)
                                ? $cfgSettings['thinking'] : null),
                'skills' => $skills,
                'dispatch' => $dispatch,
            ];
        }

        // Playbook nodes: bind the playbook's #Actions against the registry at
        // generation time (same PlaybookAnalyzer the browser runner uses) and
        // bake what the emitted playbook runtime needs.
        $playbookData = [];
        $playbookServerUrls = [];
        foreach ($order as $nid) {
            $node = $byId[$nid];
            if (self::nodeType($node) !== 'playbook') {
                continue;
            }
            $pd = $this->playbookData($node, $availableById, $providerDefaults, $userId);
            $playbookData[$nid] = $pd;
            foreach ($pd['actions'] as $a) {
                if (($a['kind'] ?? '') === 'mcp') {
                    $playbookServerUrls[$a['server_url']] = true;
                }
            }
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
        foreach (array_keys($playbookServerUrls) as $surl) {
            if (isset($serverRegistry[$surl])) {
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
        return compact('workflow', 'workflowId', 'userId', 'wfName', 'safeName', 'gdata', 'byId', 'order', 'edges',
            'startPrompt', 'startDocuments', 'providerDefaults', 'serverRegistry', 'toolCatalog', 'availableById',
            'dispatchTargets', 'routedBy', 'agentData', 'playbookData', 'usedCatalog', 'usedServers', 'missing', 'edgeList');
    }

    /** Kebab-case ASCII slug for file names (max 40 chars). */
    private static function slug(string $name): string
    {
        // //TRANSLIT spells an accented letter as "'e" / "`a" on glibc and macOS
        // alike; drop those marks first so "Rédacteur" slugs to "redacteur"
        // rather than "r-edacteur".
        $ascii = str_replace(["'", '"', '`', '^', '~'], '', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name) ?: $name);
        $s = strtolower(trim((string) preg_replace('/[^a-z0-9]+/i', '-', $ascii), '-'));
        return substr($s !== '' ? $s : 'node', 0, 40);
    }

    /** The `_make_llm(provider, model, temperature, max_tokens, thinking)` factory, one emitted line per entry. */
    private static function llmFactoryLines(): array
    {
        $lines = [];
        $lines[] = 'def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096, thinking=None):';
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
        $lines[] = '      glm        → ChatOpenAI on https://api.z.ai/api/paas/v4';
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
        $lines[] = '        kwargs = dict(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.deepseek.com",';
        $lines[] = '            api_key=os.environ.get("DEEPSEEK_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '        if model.startswith("deepseek-v4"):';
        $lines[] = '            # The node form Thinking attribute governs (platform parity):';
        $lines[] = '            # off -> disabled, form temperature kept; on/default -> V4 thinking';
        $lines[] = '            # stays enabled and the API rejects sampling params, so temperature';
        $lines[] = '            # is dropped (set Thinking=Off on the node to use a temperature).';
        $lines[] = '            if thinking == "off":';
        $lines[] = '                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}';
        $lines[] = '            else:';
        $lines[] = '                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "enabled"}}}';
        $lines[] = '                if "temperature" in kwargs:';
        $lines[] = '                    print(f"[info] deepseek {model}: temperature dropped (thinking mode)", flush=True)';
        $lines[] = '                    kwargs.pop("temperature", None)';
        $lines[] = '        return ChatOpenAI(**kwargs)';
        $lines[] = '    if p == "kimi":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        # Kimi is OpenAI-compatible. The node form Thinking attribute governs';
        $lines[] = '        # K2 reasoning mode (default off, matching the PHP KimiProvider); the';
        $lines[] = '        # API then constrains sampling: thinking OFF -> temperature MUST be 0.6,';
        $lines[] = '        # thinking ON -> 1.0 (provider CONSTRAINT, not a preference override).';
        $lines[] = '        _k2 = model.startswith("kimi-k2")';
        $lines[] = '        if _k2:';
        $lines[] = '            _want = 1.0 if thinking == "on" else 0.6';
        $lines[] = '            if temperature != _want:';
        $lines[] = '                print(f"[info] kimi {model}: temperature {temperature} -> {_want} (model constraint)", flush=True)';
        $lines[] = '                temperature = _want';
        $lines[] = '        kwargs = dict(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.moonshot.ai/v1",';
        $lines[] = '            api_key=os.environ.get("KIMI_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '        )';
        $lines[] = '        if _k2:';
        $lines[] = '            _mode = "enabled" if thinking == "on" else "disabled"';
        $lines[] = '            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": _mode}}}';
        $lines[] = '        return ChatOpenAI(**kwargs)';
        $lines[] = '    if p == "glm":';
        $lines[] = '        from langchain_openai import ChatOpenAI';
        $lines[] = '        # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible.';
        $lines[] = '        return ChatOpenAI(';
        $lines[] = '            model=model,';
        $lines[] = '            base_url="https://api.z.ai/api/paas/v4",';
        $lines[] = '            api_key=os.environ.get("GLM_API_KEY"),';
        $lines[] = '            temperature=temperature,';
        $lines[] = '            max_tokens=max_tokens,';
        $lines[] = '            # GLM 5.2 defaults to heavy reasoning; disable thinking for direct answers.';
        $lines[] = '            model_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},';
        $lines[] = '        )';
        $lines[] = '    raise RuntimeError(';
        $lines[] = '        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi, glm."';
        $lines[] = '    )';
        return $lines;
    }

    /**
     * The single WORKFLOW_VERSION literal baked into both the orchestrator
     * and every agent file, so the supervisor's version check (see
     * a2aOrchestratorBlock()) can never see them drift: both emitters call
     * this helper instead of formatting the string themselves.
     */
    private static function a2aVersion(array $facts): string
    {
        return $facts['workflowId'] . '-' . date('Ymd');
    }

    /**
     * File names, ports and kinds of the A2A agents, in ORDER: one per
     * agent/playbook node. Port = A2A base (8701) + index; the emitted
     * orchestrator lets the environment override both.
     */
    public static function a2aLayout(array $facts): array
    {
        $agents = [];
        $i = 0;
        foreach ($facts['order'] as $nid) {
            if (isset($facts['agentData'][$nid])) {
                $ad = $facts['agentData'][$nid];
                $kind = !empty($ad['dispatch']) ? 'dispatcher' : 'agent';
                $display = $ad['display'];
            } elseif (isset($facts['playbookData'][$nid])) {
                $kind = 'playbook';
                $display = $facts['playbookData'][$nid]['display'];
            } else {
                continue;
            }
            $agents[$nid] = ['file' => "agents/{$nid}_" . self::slug($display) . '.py', 'slug' => self::slug($display),
                'port' => 8701 + $i, 'display' => $display, 'kind' => $kind];
            $i++;
        }
        return ['root' => $facts['safeName'] . '_a2a', 'agents' => $agents];
    }

    /** A2A mode: orchestrator first, then one agent file per agent/playbook node (see a2aLayout). */
    private function generateA2A(array $facts): array
    {
        $layout = self::a2aLayout($facts);
        $files = [['path' => 'orchestrator.py', 'code' => $this->emitA2AOrchestrator($facts, $layout)]];
        foreach ($layout['agents'] as $nid => $e) {
            $files[] = ['path' => $e['file'], 'code' => $this->emitA2AAgentFile($facts, $layout, (string)$nid)];
        }
        return ['root' => $layout['root'], 'files' => $files];
    }

    /** orchestrator.py: the graph, the agent endpoint table, the supervisor and the A2A node runner. */
    private function emitA2AOrchestrator(array $facts, array $layout): string
    {
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $sep = '# ' . str_repeat('=', 62);
        $nodes = $this->a2aDocNodes($facts, $layout);
        $docById = [];
        foreach ($nodes as $dn) $docById[$dn['id']] = $dn;
        $endpoints = [];
        foreach ($layout['agents'] as $nid => $e) {
            $endpoints[] = sprintf('  %-6s %-24s %-32s http://127.0.0.1:%d/   (env A2A_AGENT_%s_URL)', $nid, $e['display'], $e['file'], $e['port'], $nid);
        }
        $body = PythonEmitHelpers::workflowDocBlock([
            'target' => 'LangGraph A2A orchestrator (Python) -- StateGraph over A2A tasks, one agent process per node',
            'dispatch_supported' => true,
            'workflow' => ['id' => $facts['workflowId'], 'name' => $facts['wfName']],
            'nodes' => $nodes, 'edges' => $facts['edgeList'], 'layers' => $facts['gdata']['layers'] ?? [],
            'data_flow' => self::a2aOrchestratorDataFlowDoc(),
            'run' => ['deps' => ['pip install "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx python-dotenv'],
                      'usage' => 'python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]',
                      'extra' => ['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.'],
                      // This file lives at <root>/orchestrator.py; python/.env is two levels up from <root>/.
                      'env_path' => '../../.env'],
            'storage' => ['enabled' => $facts['workflow']->isOutputStorageEnabled(), 'folder' => $facts['workflow']->getOutputFolder()],
        ]);
        $body .= "\n\nAGENT ENDPOINTS  (id, name, file, default URL; env override)\n===============\n" . implode("\n", $endpoints)
            . "\n\nA2A RUN\n=======\n"
            . "  1. AgentSupervisor starts every local agent (python <file> --port N) and waits for its card.\n"
            . "  2. Each agent node = one A2A task: the framed input goes in as text, status updates are\n"
            . "     relayed as [<agent>] lines, an input-required status is a GATE (answered on the console,\n"
            . "     or by PLAYBOOK_GATE_MODE when no terminal), the 'result' artifact is the node output\n"
            . "     (+ data {route, notes, status}; a dispatcher's route drives the conditional edge).\n"
            . "  3. Start and Output run locally; the Output merges parent outputs verbatim.\n"
            . "  4. Agents are stopped at the end unless --keep-serving; --no-spawn expects them reachable.";

        $L = [];
        $L[] = '"""A2A orchestrator for workflow ' . $j($facts['wfName']);
        $L[] = '';
        foreach (explode("\n", $esc($body)) as $dl) $L[] = $dl;
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, re, subprocess, sys, threading, time, uuid';
        $L[] = 'from typing import Annotated, Any, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/; the runner .env is two levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'from langgraph.graph import END, START, StateGraph';
        $L[] = 'from a2a import types as T';
        $L[] = 'from a2a.client import create_client, ClientConfig';
        $L[] = 'from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts';
        $L[] = '';
        $L[] = 'WORKFLOW_ID = ' . (int) $facts['workflowId'];
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($facts['wfName']);
        // Same literal every agent file bakes (see a2aVersion()) -- the supervisor
        // rejects a port already serving a DIFFERENT version instead of adopting it.
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts));
        $L[] = 'OUTPUT_STORAGE_ENABLED = ' . ($facts['workflow']->isOutputStorageEnabled() ? 'True' : 'False');
        $L[] = 'OUTPUT_FOLDER = ' . (($facts['workflow']->getOutputFolder() ?? '') !== '' ? PythonEmitHelpers::pyStr((string) $facts['workflow']->getOutputFolder()) : 'None');
        $L[] = 'DEFAULT_PROMPT = ' . PythonEmitHelpers::pyStr($facts['startPrompt']);
        $L[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($facts['startDocuments'] ?: []);
        $L[] = 'A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "8701"))   # agent i listens on A2A_BASE_PORT + i';
        $L[] = '';
        $L[] = $sep; $L[] = '# AGENTS -- the endpoint table (one A2A server per agent/playbook node)'; $L[] = $sep;
        $L[] = 'AGENTS = {';
        $i = 0;
        foreach ($layout['agents'] as $nid => $e) {
            foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) $L[] = $cl;
            $dispatch = $e['kind'] === 'dispatcher' ? array_map(fn($t) => ['id' => (string) $t['id'], 'name' => $t['name']], $facts['agentData'][$nid]['dispatch']) : [];
            $L[] = '    ' . $j((string) $nid) . ': {"display": ' . $j($e['display']) . ', "file": ' . $j($e['file']) . ', "kind": ' . $j($e['kind'])
                . ', "port": ' . $e['port'] . ', "index": ' . $i . ', "dispatch": ' . $j($dispatch) . '},';
            $i++;
        }
        $L[] = '}';
        $L[] = '';
        $L[] = $sep; $L[] = '# GRAPH STRUCTURE (same shape as the single-file script)'; $L[] = $sep;
        $L[] = 'EDGES = ' . PythonEmitHelpers::jsonToPython($facts['edgeList']);
        $L[] = 'ORDER = ' . PythonEmitHelpers::jsonToPython($facts['order']);
        $typeMap = [];
        foreach ($facts['order'] as $nid) $typeMap[$nid] = isset($layout['agents'][$nid]) ? ($layout['agents'][$nid]['kind'] === 'playbook' ? 'playbook' : 'agent') : self::nodeType($facts['byId'][$nid]);
        $L[] = 'NODE_TYPES = ' . PythonEmitHelpers::jsonToPython($typeMap, true);
        $L[] = '';
        $L[] = self::parentsChildrenBlock();
        $L[] = self::stateBlock();
        $L[] = self::datetimeInjectorBlock();
        $L[] = self::contextBuilderBlock();
        $L[] = PythonEmitHelpers::documentConverterBlock();
        $L[] = self::a2aOrchestratorBlock();
        return implode("\n", $L) . "\n";
    }

    /** DATA FLOW text for the orchestrator. */
    private static function a2aOrchestratorDataFlowDoc(): string
    {
        return <<<'TXT'
The orchestrator owns the graph and the human; the agents own the models,
tools and playbooks. Every agent node is one A2A task on that node's
server: the orchestrator sends the framed input (original prompt + labelled
parent outputs), relays status updates, answers gates, and takes the
'result' artifact as the node output. A dispatcher's chosen child comes back
in the artifact's data part and drives a LangGraph conditional edge, so only
that child runs. Start and Output nodes are local (no LLM).
TXT;
    }

    /** Supervisor, remote node runner, gate handler, graph wiring, CLI entry. */
    private static function a2aOrchestratorBlock(): string
    {
        return <<<'PY'
# ==============================================================
# AGENT SUPERVISOR
# Starts one python process per local agent, relays its stdout with a
# [<agent>] prefix, waits for the Agent Card, stops them at the end.
# ==============================================================
def agent_url(nid: str) -> str:
    """The agent's base URL: env A2A_AGENT_<id>_URL wins, else the baked port shifted
    by A2A_BASE_PORT. AGENTS[nid]["port"] (8701 + index, baked at generation time) is
    authoritative; A2A_BASE_PORT - 8701 is added so overriding the env var still moves
    the WHOLE range together instead of only affecting agents with no baked port."""
    env = os.environ.get(f"A2A_AGENT_{nid}_URL", "").strip()
    if env:
        return env
    port = AGENTS[nid]["port"] + (A2A_BASE_PORT - 8701)
    return f"http://127.0.0.1:{port}/"


def _is_local(url: str) -> bool:
    """True when `url` is a loopback address the supervisor can spawn and own."""
    return url.startswith("http://127.0.0.1") or url.startswith("http://localhost")


class AgentSupervisor:
    """Owns the agent subprocesses for one run."""
    def __init__(self, spawn: bool = True):
        self.spawn = spawn
        self.procs: dict[str, subprocess.Popen] = {}

    def start(self) -> None:
        """Spawn every local agent whose URL is ours to serve, then wait for all cards (60 s).

        Two checks guard against silently adopting an orphaned/stale process on
        what should be OUR port:
          1. proc.poll() is checked BEFORE trusting any 200 from the card
             endpoint. If we spawned this agent and it has already exited, the
             port was unusable (most likely already bound by something else)
             -- raise immediately naming the agent, its exit code and the port,
             instead of a 200 we did not send being mistaken for readiness.
          2. When a card DOES answer 200, its "version" field is compared to
             WORKFLOW_VERSION (the same literal every agent file bakes via
             a2aVersion() -- see emitA2AAgentFile). A mismatch means the port
             is already serving a different generation of this workflow (or a
             leftover process from before a regenerate); raise instead of
             running the graph against stale agent code.
        """
        for nid, ad in AGENTS.items():
            url = agent_url(nid)
            if not (self.spawn and _is_local(url)):
                continue
            port = int(url.rsplit(":", 1)[1].strip("/"))
            path = os.path.join(_HERE, ad["file"])
            proc = subprocess.Popen([sys.executable, "-u", path, "--port", str(port)], cwd=_HERE,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.procs[nid] = proc
            threading.Thread(target=self._relay, args=(ad["display"], proc), daemon=True).start()
        deadline = time.monotonic() + 60
        for nid in AGENTS:
            url = agent_url(nid)
            port = int(url.rstrip("/").rsplit(":", 1)[1])
            while True:
                proc = self.procs.get(nid)
                if proc is not None and proc.poll() is not None:
                    # Checked BEFORE the http GET below: a spawned child that already
                    # exited means the port was busy (or the agent crashed) -- a 200
                    # from that port, if one ever came, would be someone else's server.
                    raise RuntimeError(f"agent {AGENTS[nid]['display']!r} exited with code {proc.returncode} before serving {url} (port {port} may already be in use)")
                status, card = None, None
                try:
                    resp = httpx.get(url.rstrip("/") + "/.well-known/agent-card.json", timeout=2)
                    status = resp.status_code
                    if status == 200:
                        card = resp.json() or {}
                except Exception:
                    pass
                if status == 200:
                    served = card.get("version") if card else None
                    if served != WORKFLOW_VERSION:
                        raise RuntimeError(f"port {port} is already serving a different agent version ({served} != {WORKFLOW_VERSION}); stop the stale process")
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"agent {AGENTS[nid]['display']!r} did not serve its card at {url} within 60s")
                time.sleep(0.3)
            print(f"[supervisor] {AGENTS[nid]['display']!r} ready at {url}", flush=True)

    @staticmethod
    def _relay(name: str, proc: subprocess.Popen) -> None:
        """Copy an agent's stdout to ours, line by line, prefixed with its name."""
        for line in proc.stdout:
            print(f"[{name}] {line.rstrip()}", flush=True)

    def stop(self) -> None:
        """Terminate the agents we started (5 s grace, then kill)."""
        for nid, proc in self.procs.items():
            if proc.poll() is None:
                proc.terminate()
        for nid, proc in self.procs.items():
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self.procs:
            print("[supervisor] agents stopped", flush=True)


# ==============================================================
# GATE HANDLER
# An agent's input-required status reaches the human here. Terminal:
# ask on the console. Otherwise PLAYBOOK_GATE_MODE: auto (default) approves
# approvals and acknowledges handoffs, forms/await are 'unavailable';
# deny denies; prompt forces the console. Every gate and answer is also
# printed as a JSON line so the app can render them.
# ==============================================================
def _handle_gate(agent_name: str, task_id: str, gate: dict) -> dict:
    """Return the answer data part for one gate: {decision, comment, fields?}."""
    kind = str(gate.get("gate") or "gate")
    args = gate.get("args") or {}
    question = args.get("question") or args.get("prompt") or args.get("reason") or kind
    print("[gate] " + json.dumps({"agent": agent_name, "task": task_id, "kind": kind, "question": question, "args": args}, ensure_ascii=False), flush=True)
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or ("prompt" if sys.stdin.isatty() else "auto")
    if mode == "prompt":
        print(f"\n✋ [{agent_name}] {kind}: {question}", flush=True)
        if kind == "approval":
            ans = input("approve/deny [comment]: ").strip()
            answer = {"decision": "denied" if ans.lower().startswith("d") else "approved",
                      "comment": ans.split(" ", 1)[1] if " " in ans else "", "actor": "console"}
        elif kind == "form":
            fields = {}
            for f in args.get("fields") or []:
                if isinstance(f, dict) and f.get("name"):
                    fields[f["name"]] = input(f"  {f.get('label') or f['name']}: ").strip()
            answer = {"decision": "submitted", "fields": fields, "actor": "console"}
        else:
            answer = {"decision": "answered", "comment": input("your answer: ").strip(), "actor": "console"}
    elif mode == "deny":
        answer = {"decision": "denied", "comment": "denied by PLAYBOOK_GATE_MODE=deny", "actor": "policy"}
    elif kind == "approval":
        answer = {"decision": "approved", "comment": "auto-approved (non-interactive run)", "actor": "policy"}
    elif kind == "handoff":
        answer = {"decision": "acknowledged", "comment": "handed off; no human available in this non-interactive run", "actor": "policy"}
    else:
        answer = {"decision": "unavailable", "comment": "no human available in this non-interactive run", "actor": "policy"}
    print("[gate-answer] " + json.dumps({"agent": agent_name, "task": task_id, **answer}, ensure_ascii=False), flush=True)
    return answer


# ==============================================================
# REMOTE NODE RUNNER
# One A2A task per agent node: send, stream, answer gates, collect the
# 'result' artifact.
# ==============================================================
def _stream_kind(ev: "T.StreamResponse") -> str:
    """Which oneof field is set on this streaming response, or "" if none is."""
    for k in ("task", "message", "status_update", "artifact_update"):
        if ev.HasField(k):
            return k
    return ""


async def _run_remote_node(nid: str, request_text: str) -> dict:
    """Run node `nid` on its A2A server. Returns {"text", "route", "notes", "status"}."""
    ad = AGENTS[nid]
    url = agent_url(nid)
    t0 = time.monotonic()
    text_parts: list[str] = []
    data: dict = {}
    async with httpx.AsyncClient(timeout=None) as hc:
        client = await create_client(url, ClientConfig(streaming=True, httpx_client=hc))
        req = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), role=T.Role.ROLE_USER, parts=[T.Part(text=request_text)]))
        task_id = ctx_id = None
        pending = req
        while pending is not None:
            gate_payload = None
            async for ev in client.send_message(pending):
                kind = _stream_kind(ev)
                if kind == "task":
                    task_id, ctx_id = ev.task.id, ev.task.context_id
                elif kind == "status_update":
                    su = ev.status_update
                    task_id, ctx_id = su.task_id, su.context_id
                    if su.status.HasField("message"):
                        for line in get_text_parts(su.status.message.parts):
                            if line and su.status.state != T.TaskState.TASK_STATE_INPUT_REQUIRED:
                                print(f"[{ad['display']}] {line}", flush=True)
                    if su.status.state == T.TaskState.TASK_STATE_INPUT_REQUIRED:
                        parts = get_data_parts(su.status.message.parts) if su.status.HasField("message") else []
                        gate_payload = dict(parts[0]) if parts and isinstance(parts[0], dict) else {"gate": "gate", "args": {}}
                        break
                    if su.status.state in (T.TaskState.TASK_STATE_FAILED, T.TaskState.TASK_STATE_CANCELED, T.TaskState.TASK_STATE_REJECTED):
                        raise RuntimeError(f"agent {ad['display']!r} task {task_id} ended in {T.TaskState.Name(su.status.state)}")
                elif kind == "artifact_update":
                    art = ev.artifact_update.artifact
                    text_parts.extend(get_text_parts(art.parts))
                    for d in get_data_parts(art.parts):
                        if isinstance(d, dict):
                            data.update(d)
            if gate_payload is None:
                pending = None
            else:
                answer = _handle_gate(ad["display"], task_id, gate_payload)
                pending = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), task_id=task_id, context_id=ctx_id, role=T.Role.ROLE_USER,
                                                                 parts=[T.Part(text=str(answer.get("decision", ""))), new_data_part(answer)]))
        await client.close()
    dt = time.monotonic() - t0
    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt
    print(f"[node] [{nid}] {ad['display']!r} done over A2A -- {sum(len(t) for t in text_parts)} chars ({dt:.1f}s)", flush=True)
    return {"text": "\n".join(text_parts), "route": str(data.get("route") or ""), "notes": str(data.get("notes") or ""), "status": str(data.get("status") or "ok")}


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over A2A tasks
# ==============================================================
NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)
_RUN_T0 = None


async def run(user_prompt: str) -> str:
    """Build the graph (agent nodes call their A2A servers), run it, return the final output."""
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
                            try:
                                doc_parts.append(f"### {name}\n\n{_convert_doc_to_markdown(path)}")
                            except Exception as e:
                                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                        text = "## Attached Documents\n\n" + "\n\n---\n\n".join(doc_parts) + "\n\n---\n\n" + text
                    print(f"[node] [{n}] start -- {len(text)} chars", flush=True)
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())
        elif ntype in ("agent", "playbook"):
            def make_remote(n=nid):
                async def _run(state):
                    ad = AGENTS[n]
                    outs = state.get("node_outputs", {})
                    if ad["kind"] == "playbook":
                        inputs = [outs[p]["text"] for p in parents(n) if p in outs]
                        request = "\n\n".join(inputs) or state.get("user_prompt", "")
                    else:
                        request = build_context(state.get("user_prompt", ""), parents(n), outs)
                    out = await _run_remote_node(n, request)
                    result = {"node_outputs": {n: {"source": ad["display"], "text": out["text"]}}}
                    if ad["dispatch"]:
                        # Dispatcher: the agent chose a child (or none) -> conditional edge input.
                        route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END
                        if route == END:
                            print(f"[node] [{n}] ⚠ dispatcher did not route; ending the run", flush=True)
                            result["final_output"] = out["text"]
                        result["routes"] = {n: route}
                    return result
                return _run
            sg.add_node(nid, make_remote())
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
                    print(f"[node] [{n}] output -- {len(final)} chars", flush=True)
                    return {"final_output": final}
                return _run
            sg.add_node(nid, make_output())
        else:
            sg.add_node(nid, lambda s: {})
    # Wire edges; a dispatcher's menu children hang off a conditional edge (only the chosen one runs).
    pos = {n: i for i, n in enumerate(ORDER)}
    sg.add_edge(START, ORDER[0])
    for nid in ORDER:
        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}
        for child in children(nid):
            if child in pos and pos[child] > pos[nid] and child not in menu:
                sg.add_edge(nid, child)
        if menu:
            def make_router(n=nid):
                def _route(state):
                    return state.get("routes", {}).get(n) or END
                return _route
            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})
    for nid in ORDER:
        if not children(nid):
            sg.add_edge(nid, END)
    graph = sg.compile()
    print("[info] Running...", flush=True)
    global _RUN_T0
    _RUN_T0 = time.monotonic()
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


def _save_output(output: str) -> str | None:
    """Honour the Output node's storage setting (same rule as the single-file script)."""
    if not OUTPUT_STORAGE_ENABLED:
        return None
    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")
    if not os.path.isabs(folder):
        folder = os.path.join(root, folder)
    os.makedirs(folder, exist_ok=True)
    m = re.search(r"(?is)<!doctype html.*?</html\s*>", output) or re.search(r"(?is)<html[\s>].*?</html\s*>", output)
    ext = "html" if m else "md"
    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]
    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(m.group(0) if m else output)
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"A2A orchestrator for workflow {WORKFLOW_NAME!r}")
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    ap.add_argument("--keep-serving", action="store_true", help="leave the agent servers running after the run")
    ap.add_argument("--no-spawn", action="store_true", help="do not start agents; expect their URLs to be reachable")
    a = ap.parse_args()
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}", flush=True)
    sup = AgentSupervisor(spawn=not a.no_spawn)
    try:
        sup.start()
        output = asyncio.run(run(prompt))
    finally:
        if not a.keep_serving:
            sup.stop()
    print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output, flush=True)
    saved = _save_output(output)
    print("\n" + "=" * 74 + "\nRUN SUMMARY\n" + "-" * 74, flush=True)
    if NODE_DURATIONS:
        w = max(len(n) for n in NODE_DURATIONS)
        print("  Time per node (A2A round trip):", flush=True)
        for name, secs in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):
            print(f"    {name:<{w}}   {secs:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - _RUN_T0:.1f}s" if _RUN_T0 else "  Total wall-clock: n/a", flush=True)
    print(f"  Final output: {len(output)} chars", flush=True)
    print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)
    print("=" * 74, flush=True)
PY;
    }

    /**
     * One self-contained A2A agent server for node $nid. Reuses the same
     * Python blocks as the single-file script (LLM factory, MCP client, tool
     * builder, skills, playbook runtime, dispatcher tool) and adds the A2A
     * server block. Self-contained on purpose: the file can be copied to
     * another host alone (see the design's "duplication" decision).
     */
    private function emitA2AAgentFile(array $facts, array $layout, string $nid): string
    {
        $entry = $layout['agents'][$nid];
        $kind = $entry['kind'];
        $isPlaybook = $kind === 'playbook';
        $def = $isPlaybook ? $facts['playbookData'][$nid] : $facts['agentData'][$nid];
        $wfName = $facts['wfName'];
        $sep = '# ' . str_repeat('=', 62);
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);

        // Tool catalog restricted to this node.
        $catalog = [];
        if (!$isPlaybook) {
            foreach ($def['tool_names'] as $tn) {
                if (isset($facts['usedCatalog'][$tn])) {
                    $catalog[$tn] = $facts['usedCatalog'][$tn];
                }
            }
        }
        $servers = [];
        foreach ($catalog as $c) {
            if (isset($facts['serverRegistry'][$c['server_url']])) $servers[$c['server_url']] = $facts['serverRegistry'][$c['server_url']];
        }
        if ($isPlaybook) {
            foreach ($def['actions'] as $a) {
                if (($a['kind'] ?? '') === 'mcp' && isset($facts['serverRegistry'][$a['server_url']])) $servers[$a['server_url']] = $facts['serverRegistry'][$a['server_url']];
            }
        }

        $L = [];
        // ---- module docstring (standard body + agent-specific sections) ----
        $L[] = '"""A2A agent ' . $j($entry['display']) . " -- node {$nid} of workflow " . $j($wfName);
        $L[] = '';
        foreach (explode("\n", $esc($this->a2aDocBody($facts, $layout, $nid))) as $dl) $L[] = $dl;
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, re, subprocess, sys, threading, time';
        $L[] = 'from typing import Literal';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(_HERE))), ".env"))';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'import uvicorn';
        $L[] = 'from starlette.applications import Starlette';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langchain_core.tools import StructuredTool';
        $L[] = 'from langgraph.graph import END';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = 'from pydantic import BaseModel, Field, create_model';
        $L[] = 'from a2a import types as T';
        $L[] = 'from a2a.server.agent_execution import AgentExecutor, RequestContext';
        $L[] = 'from a2a.server.events import EventQueue';
        $L[] = 'from a2a.server.request_handlers import DefaultRequestHandler';
        $L[] = 'from a2a.server.tasks import InMemoryTaskStore, TaskUpdater';
        $L[] = 'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes';
        $L[] = 'from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts, get_text_parts';
        $L[] = '';
        $L[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $L[] = '';
        $L[] = '# This file is SELF-CONTAINED on purpose: the LLM factory, MCP client, tool';
        $L[] = '# builder, skill and playbook blocks below are the same code the single-file';
        $L[] = '# script carries, duplicated here so this agent can be copied to another host';
        $L[] = '# alone.';
        $L[] = $sep; $L[] = '# LLM FACTORY'; $L[] = '# Provider/model -> LangChain chat model (same rules as the single-file script).'; $L[] = $sep;
        foreach (self::llmFactoryLines() as $l) $L[] = $l;
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP SERVER REGISTRY + TOOL CATALOG (this node only)'; $L[] = $sep;
        $L[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($servers, true);
        $L[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($catalog, true);
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP CLIENT -- JSON-RPC 2.0 over HTTP (shared block)'; $L[] = $sep;
        $L[] = PythonEmitHelpers::mcpClientBlock();
        $L[] = $sep; $L[] = '# TOOL BUILDER + SKILL RUNTIME (shared blocks)'; $L[] = $sep;
        $L[] = self::toolBuilderBlock();
        $L[] = self::dispatchBlock();
        $L[] = self::datetimeInjectorBlock();
        if ($isPlaybook) {
            $L[] = self::playbookRuntimeBlock();
        }
        $L[] = 'NODE_DURATIONS = {}   # display name -> seconds (kept for the shared dispatcher block)';
        $L[] = 'def parents(_n):';
        $L[] = '    """Always []: this file has no graph, only one node. Exists so the reused';
        $L[] = '    _run_dispatcher() (which looks up parent outputs via parents(n)) finds none';
        $L[] = '    and falls back to state["user_prompt"] -- the orchestrator\'s framed input --';
        $L[] = '    instead of raising on a missing function."""';
        $L[] = '    return []';
        $L[] = '';
        // ---- node definition ----
        $L[] = $sep; $L[] = '# NODE DEFINITION -- frozen from the workflow editor'; $L[] = $sep;
        $docNodes = $this->a2aDocNodes($facts, $layout);
        foreach ($docNodes as $dn) {
            if ($dn['id'] === $nid) { foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($dn)) as $cl) $L[] = $cl; }
        }
        $L[] = 'NODE = {';
        $L[] = '    "id": ' . $j($nid) . ',';
        $L[] = '    "kind": ' . $j($kind) . ',';
        $L[] = '    "display": ' . $j($entry['display']) . ',';
        $L[] = '    "provider": ' . $j($def['provider']) . ',';
        $L[] = '    "model": ' . $j($def['model']) . ',';
        $L[] = '    "temperature": ' . json_encode((float) $def['temperature']) . ',';
        $L[] = '    "max_tokens": ' . (int) $def['max_tokens'] . ',';
        $L[] = '    "thinking": ' . (in_array($def['thinking'] ?? null, ['on', 'off'], true) ? '"' . $def['thinking'] . '"' : 'None') . ',';
        if ($isPlaybook) {
            $L[] = '    "title": ' . $j($def['title']) . ',';
            $L[] = '    "domain": ' . $j($def['domain']) . ',';
            $L[] = '    "writes_enabled": ' . ($def['writes_enabled'] ? 'True' : 'False') . ',';
            $L[] = '    "policy": ' . PythonEmitHelpers::jsonToPython($def['policy'], true) . ',';
            $L[] = '    "approvers": ' . PythonEmitHelpers::jsonToPython($def['approvers'], true) . ',';
            $L[] = '    "requester": ' . PythonEmitHelpers::jsonToPython($def['requester'], true) . ',';
            $L[] = '    "instructions": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['instructions'])) as $pl) $L[] = $pl;
            $L[] = '""",';
            $L[] = '    "actions": ' . PythonEmitHelpers::jsonToPython($def['actions'], false) . ',';
        } else {
            $L[] = '    "system_prompt": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['system_prompt'])) as $pl) $L[] = $pl;
            $L[] = '""",';
            $L[] = '    "tool_names": ' . $j(array_values($def['tool_names'])) . ',';
            $L[] = '    "skills": ' . $j($def['skills'] ?? []) . ',';
            $L[] = '    "dispatch": [' . implode(', ', array_map(fn($t) => '{"id": ' . $j((string) $t['id']) . ', "name": ' . $j($t['name']) . '}', $def['dispatch'] ?? [])) . '],';
        }
        $L[] = '}';
        $L[] = '';
        $L[] = self::a2aNodeLogicBlock();
        $L[] = self::a2aAgentServerBlock();
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($wfName);
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts));
        $L[] = '# Default card (port from A2A_PORT or the layout); main() rebuilds it for the real host/port.';
        $L[] = 'AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get(\'A2A_PORT\', \'' . $entry['port'] . '\')}/")';
        $L[] = '';
        $L[] = 'if __name__ == "__main__":';
        $L[] = '    main()';
        return implode("\n", $L) . "\n";
    }

    /** docNodes descriptors for the A2A layout: every node, with the agent file recorded under 'file'. */
    private function a2aDocNodes(array $facts, array $layout): array
    {
        $docAgents = []; $docExtra = [];
        foreach ($facts['agentData'] as $n => $ad) {
            $docAgents[$n] = ['name' => $ad['display'], 'provider' => $ad['provider'], 'model' => $ad['model'], 'temperature' => $ad['temperature'],
                'max_tokens' => $ad['max_tokens'], 'thinking' => $ad['thinking'], 'tools' => $ad['tool_names'], 'skills' => $ad['skills']];
            if (!empty($ad['dispatch'])) $docExtra[$n]['dispatch'] = array_column($ad['dispatch'], 'name');
        }
        foreach ($facts['playbookData'] as $n => $pd) {
            $mcp = count(array_filter($pd['actions'], fn($a) => ($a['kind'] ?? '') === 'mcp'));
            $docExtra[$n]['playbook'] = ['title' => $pd['title'], 'writes' => $pd['writes_enabled'], 'bound' => $mcp, 'unbound' => count($pd['actions']) - $mcp];
            $docAgents[$n] = ['name' => $pd['display'], 'provider' => $pd['provider'], 'model' => $pd['model'], 'temperature' => $pd['temperature'],
                'max_tokens' => $pd['max_tokens'], 'thinking' => $pd['thinking'], 'tools' => [], 'skills' => []];
        }
        $nodes = \AgentTeam\Services\WorkflowGraphAnalyzer::docNodes($facts['byId'], $facts['order'], $facts['edges'], $docAgents, $docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'output']);
        foreach ($nodes as &$n) { $n['file'] = $layout['agents'][$n['id']]['file'] ?? ''; }
        return $nodes;
    }

    /** Module-docstring body of an agent file: standard sections + NODE + A2A SERVING + TO RUN. */
    private function a2aDocBody(array $facts, array $layout, string $nid): string
    {
        $nodes = $this->a2aDocNodes($facts, $layout);
        // 'marker' (not 'name') so the "<== this agent" tag appears only on the
        // GRAPH NODES line -- GRAPH EDGES and EXECUTION ORDER read 'name' as-is.
        foreach ($nodes as &$n) { if ($n['id'] === $nid) $n['marker'] = '<== this agent'; }
        $entry = $layout['agents'][$nid];
        $body = PythonEmitHelpers::workflowDocBlock([
            'target' => 'LangGraph A2A agent (Python) -- one A2A server for this node; the orchestrator drives the graph',
            'dispatch_supported' => true,
            'workflow' => ['id' => $facts['workflowId'], 'name' => $facts['wfName']],
            'nodes' => $nodes, 'edges' => $facts['edgeList'], 'layers' => $facts['gdata']['layers'] ?? [],
            'data_flow' => self::a2aAgentDataFlowDoc(),
            'run' => ['deps' => ['pip install "a2a-sdk[http-server]>=1.1,<2" langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv uvicorn'],
                      'usage' => 'python ' . $entry['file'] . ' --port ' . $entry['port'] . '   # from the workflow folder; A2A_HOST/A2A_PORT also honoured',
                      'extra' => ['# Card: http://127.0.0.1:' . $entry['port'] . '/.well-known/agent-card.json  --  JSON-RPC at /'],
                      // This file lives 3 levels under the workflow root (agents/<file>.py).
                      'env_path' => '../../../.env'],
            'storage' => ['enabled' => false, 'folder' => null],
        ]);
        return $body . "\n\nA2A SERVING\n===========\n"
            . "  Skill id:   node-{$nid}\n"
            . "  Task in:    one text part = the node input the orchestrator built (original prompt + parent outputs)\n"
            . "  Task out:   artifact 'result' = text part (node output) + data part {route, notes, status}\n"
            . "  Gates:      the task moves to input-required with data {gate, tool, args}; the orchestrator answers on\n"
            . "              the same task with data {decision, comment, fields}; the run resumes in memory.\n"
            . "              After A2A_GATE_TIMEOUT_S (default 900 s) with no answer the node run continues with\n"
            . "              timeout guidance, but its final artifact can no longer be delivered -- no A2A request\n"
            . "              is in flight to carry it, so the task stays stuck in input-required. Re-sending on the\n"
            . "              same task id to pick the result back up is not supported yet.\n"
            . "  One task at a time: runs are serialised with a lock; a second task waits for the first.";
    }

    /** DATA FLOW text for agent files. */
    private static function a2aAgentDataFlowDoc(): string
    {
        return <<<'TXT'
This file serves ONE node of the workflow as an A2A agent. The orchestrator
(orchestrator.py in the parent folder) builds the node input, sends it as a
task, streams the status updates, answers gates, and reads the result
artifact. Inside this process the node runs exactly as in the single-file
script: an AGENT node = LangChain ReAct loop over its MCP tools plus
mandatory skill steps; a DISPATCHER node = one forced route_to call whose
choice travels back as the artifact's "route"; a PLAYBOOK node = the playbook
runtime (native verbs, gates, write-policed MCP actions), whose transcript is
the text part of the result.
TXT;
    }

    /** run_node(): the node body, shared by the three kinds; called by the executor. */
    private static function a2aNodeLogicBlock(): string
    {
        return <<<'PY'
# ==============================================================
# NODE LOGIC
# run_node() executes this node once for one request text and returns
# {"text", "route", "notes", "status"}. It is the single-file script's
# node function with the LangGraph state replaced by plain arguments.
# ==============================================================
PLAYBOOK_MAX_ROUNDS = 40


def _llm():
    """The chat model for this node, built from NODE (provider/model/sampling/thinking)."""
    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))


async def run_node(request_text: str, trace) -> dict:
    """Run the node on `request_text` (the orchestrator's framed input).

    trace(line) is an async callback that reports progress to the A2A client.
    Returns {"text": str, "route": str|"" , "notes": str, "status": str}.
    Exceptions propagate to the executor, which fails the task.
    """
    kind = NODE["kind"]
    if kind == "playbook":
        return await _run_playbook_kind(request_text, trace)
    catalog = build_tools_from_catalog()
    catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL   # local (non-MCP) tool, same as the single-file script
    tools = [catalog[t] for t in NODE["tool_names"] if t in catalog]
    msgs = [SystemMessage(content=inject_datetime(NODE["system_prompt"])), HumanMessage(content=request_text)]
    await trace(f"{NODE['display']!r} -- {len(tools)} tools (provider={NODE['provider']}, model={NODE['model']})")
    if kind == "dispatcher":
        return await _run_dispatcher_kind(request_text, msgs)
    agent = create_react_agent(_llm(), tools)
    result = await agent.ainvoke({"messages": msgs})
    final = result["messages"][-1]
    text = final.content if isinstance(final, AIMessage) else str(final)
    if isinstance(text, list):
        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    for skill in NODE.get("skills", []):
        text = await _run_skill_step(skill, text, _llm())
        await trace(f"after skill {skill.get('dir') or 'inline'!r}: {len(text)} chars")
    return {"text": text, "route": "", "notes": "", "status": "ok"}


async def _run_dispatcher_kind(request_text: str, msgs) -> dict:
    """Dispatcher: one forced route_to call; the chosen child id travels back as "route"."""
    ad = {"display": NODE["display"], "dispatch": NODE["dispatch"]}
    state = {"node_outputs": {}, "user_prompt": request_text}
    out = await _run_dispatcher("self", ad, state, msgs, _llm())
    route = out.get("routes", {}).get("self", "")
    text = out["node_outputs"]["self"]["text"]
    notes = text.split("## Dispatcher notes\n", 1)[1] if "## Dispatcher notes\n" in text else ""
    return {"text": text, "route": "" if route == END else str(route), "notes": notes, "status": "ok" if route != END else "unrouted"}


async def _run_playbook_kind(request_text: str, trace) -> dict:
    """Playbook: the playbook runtime; gates go through whatever _playbook_gate the
    surrounding file installed (console prompts in a modular package, an
    input-required task update in an A2A agent server)."""
    run = _PlaybookRun(bool(NODE.get("writes_enabled")), NODE.get("policy") or {})
    tools = build_playbook_tools(NODE, run)
    await trace(f"{NODE['display']!r} playbook -- {len(tools)} tools (writes={'on' if run.writes_enabled else 'off'})")
    system = PLAYBOOK_SYSTEM_PROMPT.format(
        domain=NODE.get("domain") or "this organization", instructions=NODE["instructions"],
        policy_json=json.dumps(run.policy, ensure_ascii=False),
        requester_json=json.dumps(NODE.get("requester") or {}, ensure_ascii=False),
        approvers_json=json.dumps(NODE["approvers"], ensure_ascii=False) if NODE.get("approvers") else "{}")
    msgs = [SystemMessage(content=inject_datetime(system)), HumanMessage(content="REQUEST:\n" + request_text)]
    agent = create_react_agent(_llm(), tools)
    text = ""
    try:
        result = await agent.ainvoke({"messages": msgs}, config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})
        final = result["messages"][-1]
        text = final.content if isinstance(final, AIMessage) else str(final)
        if isinstance(text, list):
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    except Exception as e:
        run.status = "failed"
        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")
    transcript = render_playbook_transcript(NODE["title"], run.events, text, run.status)
    return {"text": transcript, "route": "", "notes": "", "status": run.status}


PY;
    }

    /** Agent Card, executor with pause/resume legs, gate bridge, CLI entry. */
    private static function a2aAgentServerBlock(): string
    {
        return <<<'PY'
# ==============================================================
# A2A SERVING
# Agent Card, the AgentExecutor (one task = one node run, paused at
# gates), the gate bridge used by the playbook runtime, and the uvicorn
# entry point. Verified against a2a-sdk 1.1.0.
# ==============================================================
A2A_GATE_TIMEOUT_S = int(os.environ.get("A2A_GATE_TIMEOUT_S", "900"))   # how long a gate waits for the orchestrator's answer


def build_agent_card(url: str) -> "T.AgentCard":
    """The Agent Card served at /.well-known/agent-card.json: what this node is and how to talk to it.

    The card advertises ONE skill (this node's role); tools, prompts and credentials stay private.
    """
    desc = (NODE.get("system_prompt") or NODE.get("instructions") or "").strip().replace("\n", " ")
    return T.AgentCard(
        name=NODE["display"],
        description=(desc[:300] + ("…" if len(desc) > 300 else "")) or f"Workflow node {NODE['id']}",
        version=WORKFLOW_VERSION,
        supported_interfaces=[T.AgentInterface(url=url, protocol_binding="JSONRPC", protocol_version="1.0")],
        capabilities=T.AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"], default_output_modes=["text/plain"],
        skills=[T.AgentSkill(id=f"node-{NODE['id']}", name=NODE["display"],
                             description=f"{NODE['kind']} node of workflow {WORKFLOW_NAME!r}",
                             tags=[NODE["kind"], NODE["provider"]])],
    )


class _NodeRun:
    """One node run that may pause at gates.

    `updater` is swapped on every A2A leg (first request, then each follow-up)
    so events go to the queue of the request currently being served -- the
    SDK closes a request's queue as soon as execute() returns.
    """
    def __init__(self, updater: TaskUpdater):
        self.updater = updater
        self.answer: asyncio.Future | None = None   # pending gate answer
        self.paused = asyncio.Event()                # set when the run enters input-required
        self.task: asyncio.Task | None = None
        self.loop = asyncio.get_event_loop()

    async def gate(self, kind: str, name: str, args: dict) -> dict:
        """Raise a gate: publish input-required, wait for the answer, resume. Returns the single-file gate result shape.

        On a timeout (A2A_GATE_TIMEOUT_S with no answer) the node run itself
        continues -- it gets the guidance below back from this call, same as
        any other gate result -- but the run's FINAL artifact can no longer be
        delivered: no A2A request is in flight to carry it (the client that
        would have answered already gave up), so the task stays stuck in
        input-required. Re-sending on the same task id to pick the result back
        up is not supported yet; the caller must start a new task.
        """
        self.answer = self.loop.create_future()
        question = args.get("question") or args.get("prompt") or args.get("reason") or name
        print(f"[gate] {kind}: {question}", flush=True)
        await self.updater.requires_input(self.updater.new_agent_message(
            [T.Part(text=str(question)), new_data_part({"gate": kind, "tool": name, "args": args})]))
        self.paused.set()
        try:
            ans = await asyncio.wait_for(self.answer, A2A_GATE_TIMEOUT_S)
        except asyncio.TimeoutError:
            # The run continues below, but its eventual artifact has nowhere to
            # go: the task is still parked in input-required and there is no
            # supported way to resume it after this point (see the docstring).
            self.answer = None
            return {"ok": False, "timeout": True,
                    "guidance": "No answer arrived in time. Leave an internal note and resolve as uncompleted."}
        self.answer = None
        await self.updater.start_work()
        decision = str(ans.get("decision") or "answered")
        if decision == "unavailable":
            return {"ok": False, "timeout": True,
                    "guidance": "No human is available for this run. Continue with what you already know and note the gap with leave_internal_note."}
        d = {"decision": decision, "comment": str(ans.get("comment") or ""), "actor": str(ans.get("actor") or "a2a-client")}
        if isinstance(ans.get("fields"), dict):
            d["fields"] = ans["fields"]
        return {"ok": True, "decision": d}


_ACTIVE: _NodeRun | None = None      # the run currently executing (one at a time, see _RUN_LOCK)
_RUNS: dict[str, _NodeRun] = {}      # task id -> paused/active run
_RUN_LOCK = asyncio.Lock()           # serialises node runs: the gate bridge relies on a single active run


def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:
    """Gate bridge for the playbook runtime (called from a tool, i.e. a worker thread):
    forwards to the active run's async gate and blocks the thread until the answer arrives."""
    active = _ACTIVE
    if active is None:
        return {"ok": False, "timeout": True, "guidance": "No A2A task is active for this gate."}
    fut = asyncio.run_coroutine_threadsafe(active.gate(kind, name, args), active.loop)
    return fut.result(timeout=A2A_GATE_TIMEOUT_S + 5)


if NODE["kind"] == "playbook":
    _playbook_gate = _a2a_gate   # the playbook runtime calls _playbook_gate(run, kind, name, args)


class NodeExecutor(AgentExecutor):
    """A2A executor: a new task starts a node run; a follow-up message answers its gate."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Handle one A2A request: either start a node run or resume one paused at a gate.

        A first request (no run recorded for this task, or a run with no pending
        gate answer) enqueues the initial Task when context.current_task is None,
        then starts the node run as a background asyncio task. A follow-up message
        on a run that is waiting at a gate is a resume leg: its data part is handed
        to the paused run as the gate's answer instead of starting a new run.

        Returns as soon as the run pauses at the next gate or finishes -- the SDK
        closes this request's event queue right after this method returns, so a
        still-running node keeps making progress in the background and reports on
        the NEXT request (another gate pause, or the terminal task update). If the
        run itself raised, run.task.result() re-raises here so the SDK marks the
        task failed instead of leaving it stuck in "working".
        """
        global _ACTIVE
        tid, cid = context.task_id, context.context_id
        run = _RUNS.get(tid)
        if run is not None and run.answer is not None and not run.answer.done():
            # Resume leg: point the run at this request's queue and hand over the answer.
            run.updater = TaskUpdater(event_queue, tid, cid)
            run.paused.clear()
            data = get_data_parts(context.message.parts)
            answer = dict(data[0]) if data and isinstance(data[0], dict) else {"decision": context.get_user_input() or "answered"}
            run.answer.set_result(answer)
        else:
            if context.current_task is not None:
                # A follow-up on an existing task, but no run is paused waiting for it:
                # the run already completed, failed, or expired. Reject instead of
                # silently starting a second run under the same task id.
                updater = TaskUpdater(event_queue, tid, cid)
                await updater.failed(updater.new_agent_message(
                    [T.Part(text=f"task {tid} is not waiting for input")]))
                return
            # SDK 1.x: the executor enqueues the initial Task itself (submitted, history = the user message).
            await event_queue.enqueue_event(new_task_from_user_message(context.message))
            run = _NodeRun(TaskUpdater(event_queue, tid, cid))
            _RUNS[tid] = run
            await run.updater.start_work()
            request_text = context.get_user_input()
            run.task = asyncio.create_task(self._serve(run, request_text))
        # Return when the run pauses at a gate or finishes; the SDK closes this request's queue after that.
        pause = asyncio.create_task(run.paused.wait())
        done, _ = await asyncio.wait({run.task, pause}, return_when=asyncio.FIRST_COMPLETED)
        pause.cancel()
        if run.task in done:
            _RUNS.pop(tid, None)
            run.task.result()   # re-raise a failure so the SDK marks the task failed

    async def _serve(self, run: _NodeRun, request_text: str) -> None:
        """Run the node under the lock, publish progress, deliver the result artifact."""
        global _ACTIVE
        async with _RUN_LOCK:
            _ACTIVE = run
            t0 = time.monotonic()
            try:
                async def trace(line: str):
                    print(f"[node] {line}", flush=True)
                    await run.updater.update_status(T.TaskState.TASK_STATE_WORKING, run.updater.new_agent_message([T.Part(text=line)]))
                out = await run_node(request_text, trace)
                await run.updater.add_artifact(
                    [T.Part(text=out["text"]), new_data_part({"route": out["route"], "notes": out["notes"], "status": out["status"]})],
                    name="result")
                await run.updater.complete()
                print(f"[node] done -- {len(out['text'])} chars, status={out['status']} ({time.monotonic() - t0:.1f}s)", flush=True)
            except Exception as e:
                print(f"[node] FAILED: {e}", flush=True)
                await run.updater.failed(run.updater.new_agent_message([T.Part(text=f"node failed: {e}")]))
                raise
            finally:
                _ACTIVE = None

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancel the run behind a task (the SDK marks the task canceled)."""
        run = _RUNS.pop(context.task_id, None)
        if run and run.task:
            run.task.cancel()


def main() -> None:
    """CLI entry: `python <this file> --host 127.0.0.1 --port 8701` (env A2A_HOST / A2A_PORT are the defaults)."""
    ap = argparse.ArgumentParser(description=f"A2A agent server for workflow node {NODE['id']} ({NODE['display']})")
    ap.add_argument("--host", default=os.environ.get("A2A_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("A2A_PORT", "8700")))
    a = ap.parse_args()
    url = f"http://{a.host}:{a.port}/"
    card = build_agent_card(url)
    handler = DefaultRequestHandler(agent_executor=NodeExecutor(), task_store=InMemoryTaskStore(), agent_card=card)
    app = Starlette(routes=create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/"))
    print(f"[agent {NODE['display']}] serving {url}", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


PY;
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

    // ==============================================================
    // MODULAR MODE -- "agents in separate files"
    //
    // One Python package per workflow instead of one file: workflow.py owns
    // the graph, common.py owns the shared runtime (LLM factory, MCP client,
    // tool builder, skills, dispatcher, playbook runtime), and agents/<name>.py
    // owns one node each. They link by `import` and run in ONE process -- the
    // opposite trade from A2A, which duplicates the runtime into every file so
    // each can be deployed alone over the network.
    // ==============================================================

    /**
     * Module names, files and kinds of the modular agents, in ORDER: one per
     * agent/playbook node. Unlike a2aLayout(), the base name must be a valid
     * Python identifier (it is imported, not spawned), so a display name that
     * slugs to something starting with a digit -- or that collides with a name
     * already taken -- falls back to "node_<id>_<slug>".
     */
    public static function modularLayout(array $facts): array
    {
        // Reserved: the package's own modules, so `import common` can never
        // resolve to an agent module.
        $used = ['common' => true, 'workflow' => true, 'agents' => true];
        $agents = [];
        foreach ($facts['order'] as $nid) {
            if (isset($facts['agentData'][$nid])) {
                $ad = $facts['agentData'][$nid];
                $kind = !empty($ad['dispatch']) ? 'dispatcher' : 'agent';
                $display = $ad['display'];
            } elseif (isset($facts['playbookData'][$nid])) {
                $kind = 'playbook';
                $display = $facts['playbookData'][$nid]['display'];
            } else {
                continue;
            }
            $name = str_replace('-', '_', self::slug($display));
            if (!preg_match('/^[a-z_][a-z0-9_]*$/', $name) || isset($used[$name])) {
                $name = "node_{$nid}_{$name}";
            }
            $used[$name] = true;
            $agents[$nid] = ['file' => "agents/{$name}.py", 'module' => "agents.{$name}", 'name' => $name,
                'display' => $display, 'kind' => $kind];
        }
        return ['root' => $facts['safeName'] . '_modular', 'agents' => $agents];
    }

    /** Modular mode: workflow.py, common.py, the package marker, then one module per agent/playbook node. */
    private function generateModular(array $facts): array
    {
        $layout = self::modularLayout($facts);
        $files = [
            ['path' => 'workflow.py', 'code' => $this->emitModularWorkflow($facts, $layout)],
            ['path' => 'common.py', 'code' => $this->emitModularCommon($facts, $layout)],
            ['path' => 'agents/__init__.py', 'code' => '"""Agent modules of workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                . " -- one per agent/playbook node.\n\nEach module exposes NODE (the frozen editor settings) and\nrun_node(request_text, trace), which workflow.py calls from its graph.\n\"\"\"\n"],
        ];
        foreach ($layout['agents'] as $nid => $e) {
            $files[] = ['path' => $e['file'], 'code' => $this->emitModularAgentFile($facts, $layout, (string) $nid)];
        }
        return ['root' => $layout['root'], 'files' => $files];
    }

    /** docNodes descriptors for the modular layout: every node, with its module file under 'file'. */
    private function modularDocNodes(array $facts, array $layout): array
    {
        $nodes = $this->a2aDocNodes($facts, ['agents' => []]);
        foreach ($nodes as &$n) {
            $n['file'] = $layout['agents'][$n['id']]['file'] ?? '';
        }
        return $nodes;
    }

    /**
     * Module-docstring body shared by the three file kinds. $nid marks one node
     * as "<== this module" (agent modules); pass null for workflow.py/common.py.
     */
    private function modularDocBody(array $facts, array $layout, string $target, array $run, ?string $nid = null, bool $storage = false): string
    {
        $nodes = $this->modularDocNodes($facts, $layout);
        if ($nid !== null) {
            foreach ($nodes as &$n) {
                if ($n['id'] === $nid) {
                    $n['marker'] = '<== this module';
                }
            }
        }
        return PythonEmitHelpers::workflowDocBlock([
            'target' => $target,
            'dispatch_supported' => true,
            'workflow' => ['id' => $facts['workflowId'], 'name' => $facts['wfName']],
            'nodes' => $nodes, 'edges' => $facts['edgeList'], 'layers' => $facts['gdata']['layers'] ?? [],
            'data_flow' => self::modularDataFlowDoc(),
            'run' => $run,
            'storage' => $storage
                ? ['enabled' => $facts['workflow']->isOutputStorageEnabled(), 'folder' => $facts['workflow']->getOutputFolder()]
                : ['enabled' => false, 'folder' => null],
        ]);
    }

    /** DATA FLOW text shared by every file of a modular package. */
    private static function modularDataFlowDoc(): string
    {
        return <<<'TXT'
This workflow is one Python package, run in ONE process. workflow.py owns the
graph: it frames each node's input (original prompt + labelled parent outputs)
and calls that node's module. agents/<name>.py owns one node and exposes
run_node(request_text, trace) -> {"text", "route", "notes", "status"}: an AGENT
node = LangChain ReAct loop over its MCP tools plus mandatory skill steps; a
DISPATCHER node = one forced route_to call whose choice comes back as "route"
and drives a conditional edge, so only the chosen child runs; a PLAYBOOK node =
the playbook runtime, whose transcript is the text. common.py holds everything
they share -- LLM factory, MCP client, tool builder, skills, dispatcher and
playbook runtimes -- imported once instead of copied per node.
TXT;
    }

    /** common.py: the shared runtime library. No graph, no node definitions. */
    private function emitModularCommon(array $facts, array $layout): string
    {
        $sep = '# ' . str_repeat('=', 62);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $L = [];
        $L[] = '"""Shared runtime for workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L[] = '';
        $body = $this->modularDocBody($facts, $layout,
            'LangGraph modular shared runtime (Python) -- imported by workflow.py and every agent module',
            ['deps' => ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv'],
             'usage' => 'imported, not run directly -- see workflow.py',
             'extra' => ['# Everything here is shared: change it once and every node of this workflow follows.'],
             // This file lives at <root>/common.py; python/.env is two levels up.
             'env_path' => '../../.env']);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import asyncio, json, os, re, subprocess, sys, threading, time';
        $L[] = 'from typing import Annotated, Any, Literal, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/; the runner .env is two levels up (python/.env).';
        $L[] = '# Loaded here rather than in workflow.py so a module imported on its own';
        $L[] = '# (a test, a REPL) still finds the provider keys.';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langchain_core.tools import StructuredTool';
        $L[] = 'from langgraph.graph import END';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = 'from pydantic import BaseModel, Field, create_model';
        $L[] = '';
        $L[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $L[] = '';
        $L[] = $sep;
        $L[] = '# LLM FACTORY';
        $L[] = '# Provider/model -> LangChain chat model. Every node calls this with its';
        $L[] = '# own baked settings, so one workflow can mix providers.';
        $L[] = $sep;
        foreach (self::llmFactoryLines() as $l) {
            $L[] = $l;
        }
        $L[] = '';
        $L[] = $sep;
        $L[] = '# MCP SERVER REGISTRY + TOOL CATALOG (every tool this workflow uses)';
        $L[] = '# Baked at generation time. An agent module names the tools it may use';
        $L[] = '# in NODE["tool_names"]; the catalog itself is shared.';
        $L[] = $sep;
        $L[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($facts['usedServers'], true);
        $L[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($facts['usedCatalog'], true);
        $L[] = '';
        $L[] = $sep;
        $L[] = '# MCP CLIENT -- JSON-RPC 2.0 over HTTP';
        $L[] = $sep;
        $L[] = PythonEmitHelpers::mcpClientBlock();
        $L[] = $sep;
        $L[] = '# TOOL BUILDER + SKILL RUNTIME';
        $L[] = $sep;
        $L[] = self::toolBuilderBlock();
        $L[] = $sep;
        $L[] = '# DISPATCHER RUNTIME';
        $L[] = $sep;
        $L[] = 'NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work; workflow.py prints the RUN SUMMARY from it';
        $L[] = '';
        $L[] = '';
        $L[] = 'def parents(_n):';
        $L[] = '    """Always []: this module has no graph.';
        $L[] = '';
        $L[] = '    _run_dispatcher() below looks up its input via parents(n) when it runs';
        $L[] = '    inside the single-file script. Here the framing already happened in';
        $L[] = '    workflow.py, which passes the finished text as state["user_prompt"], so';
        $L[] = '    the lookup must find nothing and fall back to it. workflow.py defines';
        $L[] = '    its own real parents() over EDGES for the graph itself."""';
        $L[] = '    return []';
        $L[] = '';
        $L[] = '';
        $L[] = self::dispatchBlock();
        $L[] = self::datetimeInjectorBlock();
        if ($facts['playbookData'] !== []) {
            $L[] = $sep;
            $L[] = '# PLAYBOOK RUNTIME (this workflow has playbook nodes)';
            $L[] = $sep;
            $L[] = self::playbookRuntimeBlock();
        }
        $L[] = $sep;
        $L[] = '# GRAPH STATE + CONTEXT BUILDING (used by workflow.py)';
        $L[] = $sep;
        $L[] = self::stateBlock();
        $L[] = self::contextBuilderBlock();
        $L[] = $sep;
        $L[] = '# ATTACHMENT CONVERTER (Start-node documents)';
        $L[] = $sep;
        $L[] = PythonEmitHelpers::documentConverterBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * agents/<name>.py: ONE node -- its frozen definition plus run_node(). The
     * shared runtime is imported from common, never copied (the A2A trade,
     * reversed).
     */
    private function emitModularAgentFile(array $facts, array $layout, string $nid): string
    {
        $entry = $layout['agents'][$nid];
        $kind = $entry['kind'];
        $isPlaybook = $kind === 'playbook';
        $def = $isPlaybook ? $facts['playbookData'][$nid] : $facts['agentData'][$nid];
        $sep = '# ' . str_repeat('=', 62);
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);

        $L = [];
        $L[] = '"""Agent module ' . $j($entry['display']) . " -- node {$nid} of workflow " . $j($facts['wfName']);
        $L[] = '';
        $body = $this->modularDocBody($facts, $layout,
            'LangGraph modular agent module (Python) -- one node; workflow.py drives the graph',
            ['deps' => ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv'],
             'usage' => 'imported by workflow.py as ' . $entry['module'] . ' -- run the workflow, not this file',
             'extra' => ['# Exposes NODE (frozen editor settings) and run_node(request_text, trace).'],
             'env_path' => '../../../.env'], $nid);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import json, os, time';
        $L[] = '';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langgraph.graph import END';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = '';
        $L[] = '# The shared runtime lives in common.py, one directory up. Python puts the';
        $L[] = "# workflow folder on sys.path when workflow.py starts, so this resolves for";
        $L[] = '# every module of the package.';
        $imports = ['_make_llm', '_run_dispatcher', '_run_skill_step', 'build_tools_from_catalog', 'inject_datetime', 'RUN_SKILL_SCRIPT_TOOL'];
        if ($isPlaybook) {
            $imports = array_merge($imports, ['PLAYBOOK_SYSTEM_PROMPT', '_PlaybookRun', 'build_playbook_tools', 'render_playbook_transcript']);
        }
        $L[] = 'from common import ' . implode(', ', $imports);
        $L[] = '';
        $L[] = $sep;
        $L[] = '# NODE DEFINITION -- frozen from the workflow editor';
        $L[] = $sep;
        foreach ($this->modularDocNodes($facts, $layout) as $dn) {
            if ($dn['id'] === $nid) {
                foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($dn)) as $cl) {
                    $L[] = $cl;
                }
            }
        }
        foreach (explode("\n", $this->nodeDefinitionLines($facts, $nid, $kind, $entry['display'], $def, $isPlaybook)) as $nl) {
            $L[] = $nl;
        }
        $L[] = '';
        $L[] = self::a2aNodeLogicBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * The `NODE = {...}` literal shared by the A2A agent files and the modular
     * agent modules: the node's editor settings, frozen.
     */
    private function nodeDefinitionLines(array $facts, string $nid, string $kind, string $display, array $def, bool $isPlaybook): string
    {
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L = [];
        $L[] = 'NODE = {';
        $L[] = '    "id": ' . $j($nid) . ',';
        $L[] = '    "kind": ' . $j($kind) . ',';
        $L[] = '    "display": ' . $j($display) . ',';
        $L[] = '    "provider": ' . $j($def['provider']) . ',';
        $L[] = '    "model": ' . $j($def['model']) . ',';
        $L[] = '    "temperature": ' . json_encode((float) $def['temperature']) . ',';
        $L[] = '    "max_tokens": ' . (int) $def['max_tokens'] . ',';
        $L[] = '    "thinking": ' . (in_array($def['thinking'] ?? null, ['on', 'off'], true) ? '"' . $def['thinking'] . '"' : 'None') . ',';
        if ($isPlaybook) {
            $L[] = '    "title": ' . $j($def['title']) . ',';
            $L[] = '    "domain": ' . $j($def['domain']) . ',';
            $L[] = '    "writes_enabled": ' . ($def['writes_enabled'] ? 'True' : 'False') . ',';
            $L[] = '    "policy": ' . PythonEmitHelpers::jsonToPython($def['policy'], true) . ',';
            $L[] = '    "approvers": ' . PythonEmitHelpers::jsonToPython($def['approvers'], true) . ',';
            $L[] = '    "requester": ' . PythonEmitHelpers::jsonToPython($def['requester'], true) . ',';
            $L[] = '    "instructions": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['instructions'])) as $pl) {
                $L[] = $pl;
            }
            $L[] = '""",';
            $L[] = '    "actions": ' . PythonEmitHelpers::jsonToPython($def['actions'], false) . ',';
        } else {
            $L[] = '    "system_prompt": """';
            foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $def['system_prompt'])) as $pl) {
                $L[] = $pl;
            }
            $L[] = '""",';
            $L[] = '    "tool_names": ' . $j(array_values($def['tool_names'])) . ',';
            $L[] = '    "skills": ' . $j($def['skills'] ?? []) . ',';
            $L[] = '    "dispatch": [' . implode(', ', array_map(fn($t) => '{"id": ' . $j((string) $t['id']) . ', "name": ' . $j($t['name']) . '}', $def['dispatch'] ?? [])) . '],';
        }
        $L[] = '}';
        return implode("\n", $L);
    }

    /** workflow.py: the graph over the agent modules, plus the CLI entry point. */
    private function emitModularWorkflow(array $facts, array $layout): string
    {
        $sep = '# ' . str_repeat('=', 62);
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $modules = [];
        foreach ($layout['agents'] as $nid => $e) {
            $modules[] = sprintf('  %-6s %-24s %s', $nid, $e['display'], $e['file']);
        }
        $L = [];
        $L[] = '"""LangGraph workflow: ' . $facts['wfName'];
        $L[] = '';
        $body = $this->modularDocBody($facts, $layout,
            'LangGraph modular workflow (Python) -- StateGraph over one importable module per node',
            ['deps' => ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                        '# optional, only for the attachment formats you use:',
                        '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'],
             'usage' => 'python workflow.py "your prompt here"',
             'extra' => !empty($facts['missing'])
                 ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' . self::pythonListRepr($facts['missing'])]
                 : [],
             'env_path' => '../../.env'], null, true);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '';
        $L[] = 'AGENT MODULES  (id, name, file -- each exposes NODE and run_node)';
        $L[] = '=============';
        foreach ($modules as $m) {
            $L[] = $m;
        }
        $L[] = '  common.py holds the runtime they share; Start and Output run here, with no LLM.';
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, os, re, sys, time';
        $L[] = '';
        $L[] = 'from langgraph.graph import END, START, StateGraph';
        $L[] = '';
        $L[] = '# Running this file puts its own folder on sys.path, so `common` and the';
        $L[] = '# `agents` package below resolve wherever the workflow folder is copied.';
        $L[] = 'from common import NODE_DURATIONS, WFState, build_context, _convert_doc_to_markdown';
        foreach ($layout['agents'] as $nid => $e) {
            $L[] = 'from ' . $e['module'] . ' import run_node as ' . $e['name'] . '_run';
        }
        $L[] = '';
        $L[] = 'WORKFLOW_ID = ' . (int) $facts['workflowId'];
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($facts['wfName']);
        $L[] = 'OUTPUT_STORAGE_ENABLED = ' . ($facts['workflow']->isOutputStorageEnabled() ? 'True' : 'False');
        $ofolder = $facts['workflow']->getOutputFolder();
        $L[] = 'OUTPUT_FOLDER = ' . (($ofolder ?? '') !== '' ? PythonEmitHelpers::pyStr((string) $ofolder) : 'None');
        $L[] = 'DEFAULT_PROMPT = ' . PythonEmitHelpers::pyStr($facts['startPrompt']);
        $L[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($facts['startDocuments'] ?: []);
        $L[] = '';
        $L[] = $sep;
        $L[] = '# AGENT TABLE -- what each node is, and which module runs it';
        $L[] = $sep;
        $docById = [];
        foreach ($this->modularDocNodes($facts, $layout) as $dn) {
            $docById[$dn['id']] = $dn;
        }
        $L[] = 'AGENTS = {';
        foreach ($layout['agents'] as $nid => $e) {
            if (isset($docById[$nid])) {
                foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                    $L[] = $cl;
                }
            }
            $dispatch = $e['kind'] === 'dispatcher'
                ? array_map(fn($t) => ['id' => (string) $t['id'], 'name' => $t['name']], $facts['agentData'][$nid]['dispatch'])
                : [];
            $L[] = '    ' . $j((string) $nid) . ': {"display": ' . $j($e['display']) . ', "kind": ' . $j($e['kind'])
                . ', "module": ' . $j($e['module']) . ', "dispatch": ' . $j($dispatch) . '},';
        }
        $L[] = '}';
        $L[] = '';
        $L[] = '# node id -> the module function that runs it (imported above).';
        $L[] = '_NODE_RUNNERS = {';
        foreach ($layout['agents'] as $nid => $e) {
            $L[] = '    ' . $j((string) $nid) . ': ' . $e['name'] . '_run,';
        }
        $L[] = '}';
        $L[] = '';
        $L[] = $sep;
        $L[] = '# GRAPH STRUCTURE -- frozen from the workflow editor';
        $L[] = $sep;
        $L[] = 'EDGES = ' . PythonEmitHelpers::jsonToPython($facts['edgeList']);
        $L[] = 'ORDER = ' . PythonEmitHelpers::jsonToPython($facts['order']);
        $typeMap = [];
        foreach ($facts['order'] as $nid) {
            $t = self::nodeType($facts['byId'][$nid]);
            $typeMap[$nid] = $t === 'agent-template' ? 'agent' : $t;
        }
        $L[] = 'NODE_TYPES = ' . PythonEmitHelpers::jsonToPython($typeMap, true);
        $L[] = '';
        $L[] = self::parentsChildrenBlock();
        $L[] = self::modularRunnerBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /** workflow.py's runtime half: node runner, graph build, output storage, CLI. */
    private static function modularRunnerBlock(): string
    {
        return <<<'PY'
# ==============================================================
# NODE RUNNER
# Every agent/playbook node goes through here: frame nothing (workflow.py
# already did), call the module, time it, report.
# ==============================================================
_RUN_T0 = None


async def _run_node_module(nid: str, request_text: str) -> dict:
    """Run node `nid` by calling its module. Returns {"text", "route", "notes", "status"}."""
    ad = AGENTS[nid]
    t0 = time.monotonic()

    async def trace(line: str):
        """Progress callback the module calls; in one process this is just a print."""
        print(f"[node] [{nid}] {line}", flush=True)

    out = await _NODE_RUNNERS[nid](request_text, trace)
    dt = time.monotonic() - t0
    # Assignment, not +=: a dispatcher module already added its own LLM time to
    # the shared NODE_DURATIONS (common._run_dispatcher), and this is the same
    # dict in the same process. Overwrite it with the node's total so the RUN
    # SUMMARY counts each node exactly once.
    NODE_DURATIONS[ad["display"]] = dt
    print(f"[node] [{nid}] {ad['display']!r} done -- {len(out['text'])} chars ({dt:.1f}s)", flush=True)
    return out


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over the agent modules
# ==============================================================
async def run(user_prompt: str) -> str:
    """Build the graph (agent nodes call their modules), run it, return the final output."""
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
                            try:
                                doc_parts.append(f"### {name}\n\n{_convert_doc_to_markdown(path)}")
                            except Exception as e:
                                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                        text = "## Attached Documents\n\n" + "\n\n---\n\n".join(doc_parts) + "\n\n---\n\n" + text
                    print(f"[node] [{n}] start -- {len(text)} chars", flush=True)
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())
        elif ntype in ("agent", "playbook"):
            def make_node(n=nid):
                async def _run(state):
                    ad = AGENTS[n]
                    outs = state.get("node_outputs", {})
                    if ad["kind"] == "playbook":
                        inputs = [outs[p]["text"] for p in parents(n) if p in outs]
                        request = "\n\n".join(inputs) or state.get("user_prompt", "")
                    else:
                        request = build_context(state.get("user_prompt", ""), parents(n), outs)
                    out = await _run_node_module(n, request)
                    result = {"node_outputs": {n: {"source": ad["display"], "text": out["text"]}}}
                    if ad["dispatch"]:
                        # Dispatcher: the module chose a child (or none) -> conditional edge input.
                        route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END
                        if route == END:
                            print(f"[node] [{n}] ⚠ dispatcher did not route; ending the run", flush=True)
                            result["final_output"] = out["text"]
                        result["routes"] = {n: route}
                    return result
                return _run
            sg.add_node(nid, make_node())
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
                    print(f"[node] [{n}] output -- {len(final)} chars", flush=True)
                    return {"final_output": final}
                return _run
            sg.add_node(nid, make_output())
        else:
            sg.add_node(nid, lambda s: {})
    # Wire edges; a dispatcher's menu children hang off a conditional edge (only the chosen one runs).
    pos = {n: i for i, n in enumerate(ORDER)}
    sg.add_edge(START, ORDER[0])
    for nid in ORDER:
        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}
        for child in children(nid):
            if child in pos and pos[child] > pos[nid] and child not in menu:
                sg.add_edge(nid, child)
        if menu:
            def make_router(n=nid):
                def _route(state):
                    return state.get("routes", {}).get(n) or END
                return _route
            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})
    for nid in ORDER:
        if not children(nid):
            sg.add_edge(nid, END)
    graph = sg.compile()
    print("[info] Running...", flush=True)
    global _RUN_T0
    _RUN_T0 = time.monotonic()
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


def _save_output(output: str) -> str | None:
    """Honour the Output node's storage setting (same rule as the single-file script)."""
    if not OUTPUT_STORAGE_ENABLED:
        return None
    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")
    if not os.path.isabs(folder):
        folder = os.path.join(root, folder)
    os.makedirs(folder, exist_ok=True)
    m = re.search(r"(?is)<!doctype html.*?</html\s*>", output) or re.search(r"(?is)<html[\s>].*?</html\s*>", output)
    ext = "html" if m else "md"
    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]
    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(m.group(0) if m else output)
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"LangGraph workflow {WORKFLOW_NAME!r} (agents in separate files)")
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    a = ap.parse_args()
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}", flush=True)
    output = asyncio.run(run(prompt))
    print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output, flush=True)
    saved = _save_output(output)
    print("\n" + "=" * 74 + "\nRUN SUMMARY\n" + "-" * 74, flush=True)
    if NODE_DURATIONS:
        w = max(len(n) for n in NODE_DURATIONS)
        print("  Time per node (LLM + skills):", flush=True)
        for name, secs in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):
            print(f"    {name:<{w}}   {secs:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - _RUN_T0:.1f}s" if _RUN_T0 else "  Total wall-clock: n/a", flush=True)
    print(f"  Final output: {len(output)} chars", flush=True)
    print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)
    print("=" * 74, flush=True)
PY;
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
        // Part B: skillFsSyncBlock (shared, LangChain-free) + LangGraph-specific tail.
        // skillFsSyncBlock ends after _read_skill_md. The two blank lines that separate
        // _read_skill_md from RUN_SKILL_SCRIPT_TOOL are provided by the two leading blank
        // lines in $lgSpecific. RUN_SKILL_SCRIPT_TOOL lives here (not in the shared block)
        // because it uses StructuredTool/create_model which are LangChain-only.
        $lgSpecific = <<<'PY'


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
        return $partA . PythonEmitHelpers::skillDepsBlock() . PythonEmitHelpers::skillFsSyncBlock() . $lgSpecific;
    }

    /**
     * Bake one playbook node: parse + analyze the playbook against the
     * registry ids and describe what the emitted runtime needs. Throws when
     * the playbook text is missing or has hard binding errors, like the
     * browser runner (PlaybookNodeRunner) does.
     */
    private function playbookData(array $node, array $availableById, array $providerDefaults, ?string $userId): array
    {
        $nid = self::nodeId($node);
        $cfg = is_array($node['config'] ?? null) ? $node['config'] : [];
        $raw = $cfg['playbook'] ?? null;
        if (is_string($raw) && trim($raw) !== '') {
            $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromConsoleText($raw);
        } elseif (is_array($raw)) {
            $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray($raw);
        } else {
            throw new RuntimeException("Playbook node {$nid} has no playbook text.");
        }
        $writesEnabled = !empty($cfg['writes_enabled']);
        $policy = $doc->policy;
        if ($writesEnabled) {
            $policy['writes_enabled'] = true;
        }
        $analysis = (new \Quantis\AIPortfolioAssistant\Playbook\PlaybookAnalyzer())->analyze($doc, array_keys($availableById), []);
        if (!empty($analysis['errors'])) {
            throw new RuntimeException("Playbook node {$nid} has unresolved bindings: " . implode('; ', $analysis['errors']));
        }
        $actions = [];
        foreach ($analysis['actions'] as $a) {
            $name = (string) ($a['name'] ?? '');
            $kind = (string) ($a['kind'] ?? '');
            $target = $a['target'] ?? null;
            if ($kind === 'native') {
                continue; // native verbs are always exposed by the runtime
            }
            if ($kind === 'bound' && is_string($target) && str_contains($target, '.') && !str_starts_with($target, 'agent.')
                && isset($availableById[$target])) {
                $info = $availableById[$target];
                // llm tool name = PlaybookActionSpace::sanitizeTarget() ("okta.lookup_users" -> "okta__lookup_users")
                $llmName = strtolower((string) preg_replace('/[^a-z0-9_]+/i', '_', str_replace('.', '__', $target)));
                $actions[] = [
                    'llm_name' => $llmName, 'kind' => 'mcp', 'action_name' => $name, 'target' => $target,
                    'server_url' => $info['server_url'], 'tool' => $info['tool'],
                    'description' => $info['description'], 'input_schema' => $info['input_schema'],
                ];
                continue;
            }
            $slug = trim(strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $name)), '_');
            $actions[] = ['llm_name' => 'unbound__' . $slug, 'kind' => 'unbound', 'action_name' => $name, 'target' => $target];
        }
        $provider = strtolower((string) ($cfg['agent_provider'] ?? $cfg['provider'] ?? $cfg['llm_provider'] ?? ''));
        if ($provider === '') {
            $provider = 'claude';
        }
        $model = (string) ($cfg['model'] ?? '');
        if ($model === '') {
            $model = $providerDefaults[$provider] ?? '';
        }
        $settings = is_array($cfg['settings'] ?? null) ? $cfg['settings'] : [];
        return [
            'display' => (string) ($cfg['name'] ?? $cfg['agent_name'] ?? $doc->title),
            'title' => $doc->title,
            'domain' => $doc->domain,
            'instructions' => $doc->instructions,
            'policy' => $policy,
            'approvers' => $doc->approvers,
            'requester' => ['id' => (string) ($userId ?? '')],
            'provider' => $provider,
            'model' => $model,
            'temperature' => (float) ($settings['temperature'] ?? 0.7),
            'max_tokens' => (int) ($settings['max_tokens'] ?? 4096),
            'thinking' => in_array($settings['thinking'] ?? null, ['on', 'off'], true) ? $settings['thinking'] : null,
            'writes_enabled' => $writesEnabled,
            'actions' => $actions,
        ];
    }

    /** Dispatcher node runtime: one forced route_to call over the menu, result in state["routes"]. */
    private static function dispatchBlock(): string
    {
        return <<<'PY'
async def _run_dispatcher(n, ad, state, msgs, llm):
    """Dispatcher agent (twin of DispatchRouting in the PHP runner): the model
    MUST call route_to with one of the menu names; that child alone runs. The
    child receives the dispatcher's original input plus the notes."""
    targets = ad["dispatch"]
    names = [t["name"] for t in targets]
    route_args = create_model(
        "RouteToArgs",
        target=(Literal[tuple(names)], Field(..., description="Name of the agent to route to. MUST be one of the listed values.")),
        notes=(str, Field("", description="Optional short note for the target agent (what you understood, what to focus on).")),
    )
    route_tool = StructuredTool.from_function(
        func=lambda target, notes="": "routed",
        name="route_to",
        description=("REQUIRED tool to hand the request to exactly one downstream agent. Pick the agent "
                     "whose role matches the request. Available targets: " + ", ".join(names)
                     + ". The chosen agent receives the original request, plus your notes."),
        args_schema=route_args,
    )
    llm = llm.bind_tools([route_tool], tool_choice="any")
    t0 = time.monotonic()
    resp = await llm.ainvoke(msgs)
    dt = time.monotonic() - t0
    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt
    chosen, notes = None, ""
    for call in getattr(resp, "tool_calls", None) or []:
        if call.get("name") != "route_to":
            continue
        args = call.get("args") or {}
        want = str(args.get("target", "")).strip().lower()
        for t in targets:
            if t["name"].strip().lower() == want:
                chosen, notes = t, str(args.get("notes", "") or "").strip()
                break
        if chosen:
            break
    outs = state.get("node_outputs", {})
    inputs = [outs[p]["text"] for p in parents(n) if p in outs]
    task = "\n\n".join(inputs) or state.get("user_prompt", "")
    if chosen is None:
        msg = (f"Error: dispatcher {ad['display']!r} did not route the request. "
               f"Expected route_to with one of: {', '.join(names)}.")
        print(f"[node] [{n}] ⚠ {msg}", flush=True)
        return {"node_outputs": {n: {"source": ad["display"], "text": msg}}, "routes": {n: END}, "final_output": msg}
    print(f"[node] [{n}] {ad['display']!r} routed to {chosen['name']!r} ({dt:.1f}s)"
          + (f" -- notes: {notes[:120]!r}" if notes else ""), flush=True)
    text = task + (f"\n\n## Dispatcher notes\n{notes}" if notes else "")
    return {"node_outputs": {n: {"source": ad["display"], "text": text}}, "routes": {n: chosen["id"]}}


PY;
    }

    /**
     * Playbook node runtime: twin of the PHP interpreter stack
     * (PlaybookInterpreter + PlaybookActionSpace + PlaybookNativeTools +
     * GateManager + PlaybookNodeRunner::renderTranscript). Emitted only when
     * the workflow has a playbook node.
     */
    private static function playbookRuntimeBlock(): string
    {
        return <<<'PY'
# ---------------------------------------------------------------------------
# PLAYBOOK RUNTIME
#
# The LLM re-decides each round from the running transcript of tool calls
# (no pre-computed action queue). Tools it sees: the native verbs, the human
# gates, one tool per bound #Action (MCP, write-policed) and a stub per
# unbound #Action. The node output is the same Markdown transcript the app's
# run overlay shows, so downstream nodes get the story either way.
# ---------------------------------------------------------------------------
PLAYBOOK_MAX_ROUNDS = 40

PLAYBOOK_SYSTEM_PROMPT = """You are a playbook interpreter for {domain}. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
REQUESTER: {requester_json}
APPROVERS: {approvers_json}"""

# Fail-closed write classifier: a tool is a WRITE unless its name is recognizably read-only.
_PB_READ_VERB_RE = re.compile(r"^(?:[a-z0-9]+_)?(get|list|search|read|find|describe|verify|check|lookup)(_|$)", re.I)

_PB_GATES = {
    "trigger_form": ("form", "Present a form to the requester and wait for it to be submitted"),
    "request_approval": ("approval", "Ask an approver to approve or deny an action and wait for their decision"),
    "prompt_handoff": ("handoff", "Hand off to a human team or person and wait for their response"),
    "await_message": ("await_message", "Wait for a message from the requester before continuing"),
}
_PB_GATE_FIELDS = {
    "trigger_form": {"prompt": (str, True, "Instructions shown above the form"),
                     "fields": (list[dict], True, "Form fields to collect: [{name, label, type, options?, sensitive?}]")},
    "request_approval": {"approver": (str, True, "Who must approve"), "question": (str, True, "What is being approved"),
                         "context": (str, False, "Supporting context for the decision")},
    "prompt_handoff": {"team_or_person": (str, True, "Who to hand off to"), "reason": (str, True, "Why this needs a human"),
                       "summary": (str, False, "Summary of the situation so far")},
    "await_message": {"prompt": (str, True, "What to wait for")},
}


class _PlaybookRun:
    """Per-node run record: event timeline (twin of the run overlay), status, write ledger."""
    def __init__(self, writes_enabled: bool, policy: dict):
        self.events = []
        self.status = "running"
        self.writes_enabled = writes_enabled
        self.policy = policy
        self.ledger = {}

    def emit(self, **ev):
        self.events.append(ev)


def _playbook_gate(run, kind: str, name: str, args: dict) -> dict:
    """Human gate. On an interactive terminal the question is asked on the console.
    Otherwise (runner / batch) PLAYBOOK_GATE_MODE decides: auto (default) approves
    approvals and acknowledges handoffs, deny denies, prompt forces the console."""
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or ("prompt" if sys.stdin.isatty() else "auto")
    what = args.get("question") or args.get("prompt") or args.get("reason") or ""
    run.emit(type="gate_request", kind=kind, payload=dict(args))
    if mode == "prompt":
        print(f"\n✋ [{kind}] {what}", flush=True)
        if kind == "approval":
            ans = input("approve/deny [comment]: ").strip()
            decision = "denied" if ans.lower().startswith("d") else "approved"
            comment = ans.split(" ", 1)[1] if " " in ans else ""
            return {"ok": True, "decision": {"decision": decision, "comment": comment, "actor": "console"}}
        ans = input("your answer: ").strip()
        return {"ok": True, "decision": {"decision": "answered", "comment": ans, "actor": "console"}}
    if mode == "deny":
        return {"ok": True, "decision": {"decision": "denied", "comment": "denied by PLAYBOOK_GATE_MODE=deny", "actor": "policy"}}
    if kind == "approval":
        return {"ok": True, "decision": {"decision": "approved", "comment": "auto-approved (non-interactive run)", "actor": "policy"}}
    if kind == "handoff":
        return {"ok": True, "decision": {"decision": "acknowledged", "comment": "handed off; no human available in this non-interactive run", "actor": "policy"}}
    return {"ok": False, "timeout": True,
            "guidance": "No human is available in this non-interactive run. Continue with what you already know "
                        "and note the gap with leave_internal_note."}


def build_playbook_tools(pb: dict, run: _PlaybookRun) -> list:
    """The whitelisted tool surface for one playbook run (twin of PlaybookActionSpace)."""
    type_map = {"string": str, "integer": int, "number": float, "boolean": bool, "array": list, "object": dict}
    tools = []

    def model(name, fields):
        return create_model(name + "Args", **{p: (t, Field(... if req else None, description=d))
                                              for p, (t, req, d) in fields.items()})

    def wrap(name, fn, description, args_model):
        def invoke(**kwargs):
            run.emit(type="tool_call", name=name, args=kwargs)
            preview = json.dumps(kwargs, default=str, ensure_ascii=False)
            print(f"  [playbook] -> {name}({preview[:200]}{'...' if len(preview) > 200 else ''})", flush=True)
            result = fn(**kwargs)
            run.emit(type="tool_result", name=name, result=result)
            ok = result.get("ok", True) is not False
            detail = str(result.get("error") or result.get("guidance") or result.get("decision") or "")
            print(f"  [playbook] <- {name}: {'✓' if ok else '✗'} {detail[:160]}", flush=True)
            return json.dumps(result, default=str, ensure_ascii=False)
        return StructuredTool.from_function(func=invoke, name=name, description=description, args_schema=args_model)

    # Native verbs: always available, no binding needed.
    def message(**a):
        run.emit(type="message", text=str(a.get("text", "")), sensitive=bool(a.get("sensitive", False)))
        return {"ok": True}
    tools.append(wrap("send_direct_message", message, "Send a direct message to the requester",
                      model("SendDirectMessage", {"text": (str, True, "Message text"),
                                                  "sensitive": (bool, False, "Mark as sensitive for redaction")})))
    tools.append(wrap("send_channel_message", message, "Post a message in a channel",
                      model("SendChannelMessage", {"channel": (str, True, "Channel name"), "text": (str, True, "Message text")})))
    tools.append(wrap("send_email", message, "Send an email",
                      model("SendEmail", {"to": (str, True, "Email recipient"), "subject": (str, True, "Email subject"),
                                          "text": (str, True, "Email body")})))

    def note(**a):
        run.emit(type="note", text=str(a.get("text", "")))
        return {"ok": True}
    tools.append(wrap("leave_internal_note", note, "Leave an internal note on the request record",
                      model("LeaveInternalNote", {"text": (str, True, "Note text")})))

    def priority(**a):
        run.emit(type="note", text=f"priority → {a.get('priority', '')}: {a.get('reason', '')}")
        return {"ok": True}
    tools.append(wrap("set_priority", priority, "Set the request priority (escalation)",
                      model("SetPriority", {"priority": (str, True, "Priority level"), "reason": (str, True, "Reason for priority")})))

    def resolve(**a):
        run.status = "resolved"
        return {"ok": True, "terminal": True}
    tools.append(wrap("resolve_request", resolve, "Mark the request as resolved",
                      model("ResolveRequest", {"outcome": (str, True, "Resolution outcome"), "summary": (str, True, "Resolution summary")})))

    # Human gates.
    for gname, (kind, desc) in _PB_GATES.items():
        def gate_fn(_kind=kind, _name=gname, **a):
            return _playbook_gate(run, _kind, _name, a)
        tools.append(wrap(gname, gate_fn, desc, model(gname, _PB_GATE_FIELDS[gname])))

    # Bound MCP actions (write-policed) and unbound stubs.
    for act in pb.get("actions", []):
        if act.get("kind") != "mcp":
            def unbound_fn(**a):
                pol = run.policy.get("on_unbound", "handoff")
                if pol == "skip":
                    return {"ok": False, "unbound": True, "skipped": True,
                            "guidance": "This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook."}
                if pol == "fail":
                    return {"ok": False, "unbound": True, "fatal": True,
                            "guidance": "This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed."}
                return {"ok": False, "unbound": True, "policy": pol,
                        "guidance": "This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done."}
            tools.append(wrap(act["llm_name"], unbound_fn,
                              f"{act['action_name']}: NOT AVAILABLE — calling this applies the on_unbound policy",
                              create_model(act["llm_name"] + "Args")))
            continue
        schema = act.get("input_schema") or {}
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        fields = {}
        for pname, pspec in props.items():
            spec = pspec if isinstance(pspec, dict) else {}
            fields[pname] = (type_map.get(spec.get("type", "string"), str), pname in required, spec.get("description", ""))
        is_write = _PB_READ_VERB_RE.match(act["tool"]) is None

        def mcp_fn(_act=act, _write=is_write, **a):
            key = _act["target"] + "|" + json.dumps(a, sort_keys=True, default=str)
            if _write and key in run.ledger:
                return {"ok": True, "outcome": "replayed", "result": run.ledger[key]}
            if _write and not run.writes_enabled:
                return {"ok": False, "error": "writes disabled by policy"}
            raw = _call_mcp_tool(_act["server_url"], _act["tool"], a)
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if error:
                return {"ok": False, "error": str(error)}
            if _write:
                run.ledger[key] = parsed
            return {"ok": True, "result": parsed}
        desc = act["action_name"] + (" — " + act["description"] if act.get("description") else "")
        tools.append(wrap(act["llm_name"], mcp_fn, desc, model(act["llm_name"], fields)))
    return tools


def render_playbook_transcript(title: str, events: list, final: str, status: str) -> str:
    """Markdown transcript, twin of PlaybookNodeRunner::renderTranscript() (PHP)."""
    gate_titles = {"approval": "Approval requested", "form": "Form request", "handoff": "Handed off to a human",
                   "await_message": "Waiting for the requester", "wait": "Waiting"}
    gate_tools = {"request_approval", "trigger_form", "prompt_handoff", "await_message", "wait_until"}
    lines, pending = [], {}

    def s(v):
        if isinstance(v, str):
            return v.strip()
        return "" if v is None else json.dumps(v, ensure_ascii=False)

    for ev in events:
        t = ev.get("type")
        if t == "tool_call":
            name = ev.get("name", "tool")
            if name in gate_tools:
                continue
            lines.append(f"- 🔧 {name} …")
            pending[name] = len(lines) - 1
        elif t == "tool_result":
            name = ev.get("name", "tool")
            res = ev.get("result") if isinstance(ev.get("result"), dict) else {}
            if name in gate_tools:
                d = res.get("decision", res.get("status", ""))
                if isinstance(d, dict):
                    res = {**d, **res}
                    d = d.get("decision", d.get("status", d.get("outcome", "answered")))
                decision, comment = s(d), s(res.get("comment", ""))
                if decision:
                    lines.append(f"  → {decision}" + (f" ({comment})" if comment else ""))
                continue
            ok = res.get("ok", True) is not False
            mark = "✓" if ok else "✗"
            suffix = (" — " + s(res.get("error"))) if (not ok and res.get("error")) else ""
            if name in pending:
                lines[pending.pop(name)] = f"- 🔧 {name} {mark}{suffix}"
            else:
                lines.append(f"- 🔧 {name} {mark}")
        elif t == "message":
            text = "(message redacted)" if ev.get("sensitive") else s(ev.get("text", ""))
            if text:
                lines.append("- 💬 Playbook:\n" + "\n".join("  " + l for l in text.split("\n")))
        elif t == "gate_request":
            kind = ev.get("kind", "gate")
            p = ev.get("payload") or {}
            what = s(p.get("question") or p.get("prompt")
                     or (s(p.get("team_or_person", "")) + (" — " + s(p.get("reason")) if p.get("reason") else "")))
            lines.append("- ✋ " + gate_titles.get(kind, kind.capitalize()) + (f": {what}" if what else ""))
    out = f"# Playbook: {title} ({status})\n\n## Timeline\n" + ("\n".join(lines) if lines else "- (no steps recorded)")
    if final.strip():
        out += "\n\n## Result\n" + final.strip()
    return out + f"\n\n[playbook run: {status}]"


PY;
    }

    /** DATA FLOW section of the module docstring (LangGraph-specific mechanics). */
    private static function dataFlowDoc(): string
    {
        return <<<'TXT'
The script embeds the agents (AGENTS), playbooks (PLAYBOOKS), the MCP
servers and tool schemas (MCP_SERVERS, TOOL_CATALOG) and the graph
(EDGES, ORDER, NODE_TYPES), then builds a LangGraph StateGraph at run time.

  1. The Start node stores the user prompt (plus any attached documents,
     converted to Markdown) in the shared state.
  2. An AGENT node receives the original prompt plus the output of each of
     its direct parents under a "### Input from" header, then runs LangChain's
     ReAct loop (create_react_agent): the model decides when to call its MCP
     tools. Bound skills then run as mandatory post-steps; the last skill's
     produced file (or its text) becomes the node output.
  3. A DISPATCHER agent does not answer: it must call route_to with the name
     of ONE child; that child alone runs (state["routes"] drives a conditional
     edge) and receives the original input plus the dispatcher's notes. Its
     siblings are skipped.
  4. A PLAYBOOK node interprets its Console-style playbook step by step with
     the playbook runtime: native verbs (messages, notes, resolve), human
     gates (approval, form, handoff, await), one tool per bound #Action
     (write-policed unless "writes enabled") and a stub per unbound #Action.
     Its output is the run transcript (timeline, messages, gate decisions,
     result) exactly as the editor's run overlay shows it.
  5. The Output node merges its parents' outputs verbatim (no LLM) into the
     final result.

Tools are called over the MCP protocol: initialize handshake (the /mcp
endpoint first, then the URL as registered), tools/call, JSON or SSE
response, text content back to the model.
TXT;
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
    routes: Annotated[dict[str, str], _merge]
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
            thinking=ad.get("thinking"),
        )
        for nid, ad in {**AGENTS, **PLAYBOOKS}.items()
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
                    # Dispatcher: one forced route_to call picks the child; no ReAct loop.
                    if ad.get("dispatch"):
                        return await _run_dispatcher(n, ad, state, msgs, LLMS[n])
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
                    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt
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

        elif ntype == "playbook":
            def make_playbook(n=nid):
                async def _run(state):
                    pb = PLAYBOOKS[n]
                    run = _PlaybookRun(bool(pb.get("writes_enabled")), pb.get("policy") or {})
                    tools = build_playbook_tools(pb, run)
                    print(f"[node] [{n}] {pb['display']!r} playbook -- {len(tools)} tools "
                          f"(provider={pb.get('provider', '?')}, model={pb.get('model', '?')}, "
                          f"writes={'on' if run.writes_enabled else 'off'})", flush=True)
                    outs = state.get("node_outputs", {})
                    inputs = [outs[p]["text"] for p in parents(n) if p in outs]
                    request = "\n\n".join(inputs) or state.get("user_prompt", "")
                    system = PLAYBOOK_SYSTEM_PROMPT.format(
                        domain=pb.get("domain") or "this organization",
                        instructions=pb["instructions"],
                        policy_json=json.dumps(run.policy, ensure_ascii=False),
                        requester_json=json.dumps(pb.get("requester") or {}, ensure_ascii=False),
                        approvers_json=json.dumps(pb["approvers"], ensure_ascii=False) if pb.get("approvers") else "{}",
                    )
                    msgs = [SystemMessage(content=inject_datetime(system)),
                            HumanMessage(content="REQUEST:\n" + request)]
                    agent = create_react_agent(LLMS[n], tools)
                    t0 = time.monotonic()
                    text = ""
                    try:
                        result = await agent.ainvoke({"messages": msgs},
                                                     config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})
                        final = result["messages"][-1]
                        text = final.content if isinstance(final, AIMessage) else str(final)
                        if isinstance(text, list):
                            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
                    except Exception as e:
                        run.status = "failed"
                        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")
                        print(f"[node] [{n}] ⚠ playbook failed: {e}", flush=True)
                    dt = time.monotonic() - t0
                    NODE_DURATIONS[pb["display"]] = NODE_DURATIONS.get(pb["display"], 0.0) + dt
                    print(f"[node] [{n}] done -- status={run.status} ({len(run.events)} events, {dt:.1f}s)", flush=True)
                    transcript = render_playbook_transcript(pb["title"], run.events, text, run.status)
                    return {"node_outputs": {n: {"source": pb["display"], "text": transcript}}}
                return _run
            sg.add_node(nid, make_playbook())
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

    # Wire edges. A dispatcher's menu children hang off a conditional edge:
    # only the child named in state["routes"] runs (siblings are skipped).
    pos = {n: i for i, n in enumerate(ORDER)}
    sg.add_edge(START, ORDER[0])
    for nid in ORDER:
        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}
        for child in children(nid):
            if child in pos and pos[child] > pos[nid] and child not in menu:
                sg.add_edge(nid, child)
        if menu:
            def make_router(n=nid):
                def _route(state):
                    return state.get("routes", {}).get(n) or END
                return _route
            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})
    for nid in ORDER:
        if not children(nid):
            sg.add_edge(nid, END)

    graph = sg.compile()
    print("[info] Running...")
    global _RUN_T0
    _RUN_T0 = time.monotonic()
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)
_RUN_T0 = None


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
            import re as _re2
            _mm = _re2.search(r"(?is)<!doctype html.*?</html\s*>", output) or _re2.search(r"(?is)<html[\s>].*?</html\s*>", output)
            if _mm:
                output = _mm.group(0)  # strip narration/fences around a full HTML doc
                _ext = "html"
            else:
                _ext = "md"
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
            _saved_path = os.path.abspath(_out)
        except Exception as e:
            _saved_path = None
            print(f"\n[warn] failed to save result: {e}")
    else:
        _saved_path = None

    # Closing RUN SUMMARY (printed LAST): time per node, total, document location.
    import time as _t2
    print("\n" + "=" * 74)
    print("RUN SUMMARY")
    print("-" * 74)
    if NODE_DURATIONS:
        _w = max(len(k) for k in NODE_DURATIONS)
        print("  Time per node:")
        for _n, _s in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):
            print(f"    {_n:<{_w}}   {_s:7.1f}s")
    if _RUN_T0 is not None:
        print(f"  Total wall-clock: {_t2.monotonic() - _RUN_T0:.1f}s")
    print(f"  Final output: {len(output)} chars")
    if _saved_path:
        print(f"  Document saved to: {_saved_path}")
    else:
        print("  Document not saved (output storage is OFF in the workflow settings) -- "
              "the output is printed above.")
    print("=" * 74)

PY;
    }
}
