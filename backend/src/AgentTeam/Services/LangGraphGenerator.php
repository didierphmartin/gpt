<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Services\DecisionProviders;
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
    /** Where the skill folders the modular package copies are read from (LangGraphPackage). */
    private string $skillsRoot;
    /** The requesting user's document storage: the only place a Start document is copied from (none: no copy). */
    private ?StartDocumentStore $startDocuments;

    public function __construct(
        PDO $db,
        WorkflowRepository $workflowRepo,
        WorkflowGraphRepository $graphRepo,
        AgentRepository $agentRepo,
        ?string $skillsRoot = null,
        ?StartDocumentStore $startDocuments = null
    ) {
        $this->db = $db;
        $this->workflowRepo = $workflowRepo;
        $this->graphRepo = $graphRepo;
        $this->agentRepo = $agentRepo;
        $this->skillsRoot = $skillsRoot ?? LangGraphPackage::defaultSkillsRoot();
        $this->startDocuments = $startDocuments;
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
     * Single file: {filename, code, architecture}. Modular / A2A: {root, files,
     * architecture}, files ending with ARCHITECTURE.md. Swarm: {root, files}.
     * architecture is the ARCHITECTURE.md text (LangGraphArchitectureDoc), or
     * null (and no ARCHITECTURE.md file) for an ingestion pipeline or when the
     * doc failed to build.
     *
     * @return array{filename: string, code: string, architecture: ?string}|array{root: string, files: list<array{path: string, code: string}>, architecture?: string}
     */
    public function generate(int $workflowId, ?string $userId = null, array $options = []): array
    {
        $facts = $this->analyzeForEmit($workflowId, $userId);
        if ($facts['triggerNodeId'] !== null && (!empty($options['a2a']) || ($facts['orchestration'] ?? 'workflow') === 'swarm')) {
            throw new RuntimeException('A Start option (' . $facts['startOptionLabel'] . ') needs the single-file or modular format.');
        }
        if ($facts['codeData'] !== [] && ($facts['orchestration'] ?? 'workflow') === 'swarm') {
            throw new RuntimeException('Code nodes are not supported by the swarm packaging yet. '
                . 'Compile this workflow as a single file or with agents in separate files.');
        }
        if (($facts['orchestration'] ?? 'workflow') === 'swarm') {
            // §7 defers both. A2A swarm in particular is a different design —
            // handoffs crossing the network between agent servers — not a
            // packaging variation, so refusing is honest rather than lazy.
            if (!empty($options['a2a'])) {
                throw new RuntimeException(
                    'A2A packaging is not supported for swarm workflows yet. Generate this swarm with "Agents in separate files".'
                );
            }
            if (empty($options['modular'])) {
                throw new RuntimeException(
                    'Single file packaging is not supported for swarm workflows yet. Generate this swarm with the modular layout ("Agents in separate files").'
                );
            }
            return $this->generateSwarm($facts);
        }
        if ($facts['codeData'] !== [] && !empty($options['a2a'])) {
            throw new RuntimeException('Code nodes are not supported by the A2A packaging yet. '
                . 'Compile this workflow as a single file or with agents in separate files.');
        }
        if (!empty($options['a2a'])) {
            return $this->generateA2A($facts);   // Task 4
        }
        if (!empty($options['modular'])) {
            return $this->generateModular($facts);   // "agents in separate files"
        }
        // The emitter below was written against local variables; expose the
        // facts under their original names (EXTR_SKIP: never clobber $this).
        extract($facts, EXTR_SKIP);
        $codeData = $facts['codeData'];
        $codeSlugs = $facts['codeSlugs'];
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
        foreach ($codeData as $nid => $cd) {
            $docAgents[$nid] = ['name' => $cd['display'], 'provider' => '', 'model' => '', 'temperature' => null,
                'max_tokens' => null, 'thinking' => null, 'tools' => array_map(fn($slg) => "{$slg}.*", $cd['mcp_servers']), 'skills' => []];
        }
        $docNodes = \AgentTeam\Services\WorkflowGraphAnalyzer::docNodes($byId, $order, $edges, $docAgents, $docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'code', 'output']);
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
                'extra' => array_merge(!empty($missing)
                    ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' . self::pythonListRepr($missing)]
                    : [], self::decisionDocLines($agentData), self::mcpHeaderDocLines($facts), self::modeDocLines("{$safeName}_langgraph.py"), self::cronDocLines($facts, "{$safeName}_langgraph.py"),
                    self::watchDocLines($facts, "{$safeName}_langgraph.py"),
                    ['# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); use the modular package for a self-contained copy.']),
            ],
            'storage' => ['enabled' => $workflow->isOutputStorageEnabled(), 'folder' => $workflow->getOutputFolder(),
                          'default' => 'outputs/workflow/ next to this script (SYNERGYAI_OUTPUT_ROOT overrides)'],
        ]);
        $lines[] = '"""Standalone LangGraph workflow: ' . $wfName;
        $lines[] = '';
        foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $docBody)) as $dl) {
            $lines[] = $dl;
        }
        $lines[] = '"""';
        $lines[] = 'from __future__ import annotations';
        $lines[] = '';
        $lines[] = 'import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid' . ($codeData !== [] ? ', types' : '');
        $lines[] = 'from abc import ABC, abstractmethod';
        $lines[] = 'from dataclasses import asdict, dataclass, field';
        $lines[] = 'from datetime import datetime, timedelta';
        $lines[] = 'from enum import Enum';
        $lines[] = 'from functools import cached_property';
        $lines[] = 'from pathlib import Path';
        $lines[] = '';
        $lines[] = 'from dotenv import load_dotenv';
        $lines[] = '';
        $lines[] = '# Load provider API keys from the runner env .env (one dir up from scripts/).';
        $lines[] = '# Without this a DIRECT terminal run has no credentials and every provider';
        $lines[] = '# call fails; runner-mediated runs only worked because main.py loads the';
        $lines[] = '# same file and subprocesses inherit the environment.';
        $lines[] = '# A .env next to this script comes first (load_dotenv never overrides a variable already set),';
        $lines[] = '# so a copy run outside the runner folder carries its own keys.';
        $lines[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))';
        $lines[] = 'RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the runner env folder (python/)';
        $lines[] = 'load_dotenv(os.path.join(RUNNER_DIR, ".env"))';
        $lines[] = 'DEBUG_STEM = Path(__file__).stem   # names this script\'s outputs/_debug message-history dumps';
        $lines[] = 'from typing import Annotated, Awaitable, Callable, Literal, TypedDict';
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
        $lines[] = 'from pydantic import Field, create_model';
        $lines[] = '';
        $lines[] = '# Optional global override: setting MODEL_NAME in the env forces every';
        $lines[] = "# agent to use that model regardless of its per-agent setting. Useful for";
        $lines[] = '# quick experiments. Leave unset to honour each agent\'s configured model.';
        $lines[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $lines[] = '';
        $lines[] = '';
        $lines[] = LangGraphRuntime::llmFactoryBlock();
        $lines[] = '';

        // ---------- MCP server registry (baked) ----------
        $lines[] = $sep;
        $lines[] = '# MCP SERVER REGISTRY';
        $lines[] = "# Baked at generation time from the workflow editor's config.";
        $lines[] = "# Maps server URL -> metadata. If a server moves, set MCP_URL_<SLUG> in .env";
        $lines[] = "# (e.g. MCP_URL_OUTLOOK=http://host:8770/mcp); the URL here stays the key.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($usedServers, true);
        $lines[] = '';
        if ($codeData !== []) {
            $lines[] = '# MCP_SLUGS: server slug -> URL, for code nodes\' call_tool(server, tool, args).';
            $lines[] = 'MCP_SLUGS = ' . PythonEmitHelpers::jsonToPython($codeSlugs, true);
            $lines[] = '';
        }

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
        $lines[] = $sep;
        $lines[] = '';
        // The protocol steps and the SSE note are McpClient's class docstring.
        $lines[] = self::serverSlugsLine($facts['serverSlugs'] ?? []);
        $lines[] = '';
        $lines[] = LangGraphRuntime::mcpClientBlock();
        if ($codeData !== []) {
            $lines[] = LangGraphRuntime::codeHarnessBlock();
            $lines[] = '';
        }

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
        $lines[] = LangGraphRuntime::toolCatalogBlock() . LangGraphRuntime::skillRuntimeBlock();
        $lines[] = LangGraphRuntime::runEventsBlock();
        $lines[] = LangGraphRuntime::dispatcherBlock(self::decisionProtocolsUsed($agentData));
        if ($playbookData !== []) {
            $lines[] = LangGraphRuntime::playbookBlock();
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

        // ---------- node classes (one per node kind; run() builds NODES from them) ----------
        $lines[] = '';
        $lines[] = LangGraphRuntime::nodeClassesBlock($playbookData !== [], $codeData !== []);

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
        $lines[] = LangGraphRuntime::documentConverterBlock();

        // ---------- the graph, output storage and run summary (shared with every mode) ----------
        $lines[] = '';
        $lines[] = LangGraphRuntime::runRecordBlock();
        $lines[] = LangGraphRuntime::consoleBlock();
        $lines[] = LangGraphRuntime::workflowGraphBlock();
        $lines[] = LangGraphRuntime::outputBlock(true);   // outputs/ next to the script (spec 2026-10-15 §4.3)
        $lines[] = LangGraphRuntime::cronBlock();
        $lines[] = LangGraphRuntime::watchBlock();
        $lines[] = LangGraphRuntime::listenerBlock();

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
        $lines[] = '# DOCUMENTS.convert(), and prepended to the prompt.';
        $lines[] = $sep;
        $lines[] = '';
        // Verbatim, as the package bakes it: no 80-column wrap, so the prompt is the same text in every mode.
        $lines[] = 'DEFAULT_PROMPT = ' . PythonEmitHelpers::pyStr($startPrompt);
        $lines[] = self::defaultCronLine($facts);
        $lines[] = self::defaultWatchLine($facts);
        array_push($lines, ...self::startModeLines($facts));
        $lines[] = '';
        // Output-node storage setting baked in so the compiled script persists the final
        // result (outputs/workflow/ next to the script, SYNERGYAI_OUTPUT_ROOT overriding, or a
        // custom folder) only when storage is enabled.
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
        $lines[] = '#   id, kind:      The node ID again, and which Node class runs it (make_node)';
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
            if (isset($docById[$nid])) {
                foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                    $lines[] = $cl;
                }
            }
            $kind = !empty($ad['dispatch']) ? 'dispatcher' : 'agent';
            foreach (explode("\n", $this->nodeDefinitionLines($facts, (string) $nid, $kind, $ad['display'], $ad, false, '"' . $nid . '": {', '    ')) as $nl) {
                $lines[] = $nl;
            }
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
                if (isset($docById[$nid])) {
                    foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                        $lines[] = $cl;
                    }
                }
                foreach (explode("\n", $this->nodeDefinitionLines($facts, (string) $nid, 'playbook', $pd['display'], $pd, true, '"' . $nid . '": {', '    ')) as $nl) {
                    $lines[] = $nl;
                }
            }
            $lines[] = '}';
        }
        $lines[] = '';
        $lines[] = '# CODE NODE DEFINITIONS -- run(input, call_tool), exits and declared tools, frozen from the editor';
        if ($codeData === []) {
            $lines[] = 'CODE_NODES = {}';
        } else {
            $lines[] = 'CODE_NODES = {';
            foreach ($codeData as $nid => $cd) {
                if (isset($docById[$nid])) {
                    foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($docById[$nid], '    ')) as $cl) {
                        $lines[] = $cl;
                    }
                }
                foreach (explode("\n", self::codeNodeDefinitionLines((string) $nid, $cd, '"' . $nid . '": {', '    ')) as $nl) {
                    $lines[] = $nl;
                }
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
        $lines[] = "#              A code node's type is 'code'.";
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = 'EDGES = ' . PythonEmitHelpers::jsonToPython($edgeList);
        $lines[] = 'ORDER = ' . PythonEmitHelpers::jsonToPython($order);
        $typeMap = [];
        foreach ($order as $nid) {
            $t = self::nodeType($byId[$nid]);
            $typeMap[$nid] = $t === 'agent-template' ? 'agent' : $t;
        }
        $lines[] = 'NODE_TYPES = ' . PythonEmitHelpers::jsonToPython($typeMap, true);
        $lines[] = '';

        // ---------- main function ----------
        $lines[] = $sep;
        $lines[] = '# MAIN EXECUTION';
        $lines[] = '#';
        $lines[] = '# run() builds the WorkflowGraph over this file\'s nodes and executes it;';
        $lines[] = '# every agent/playbook node runs in this process (_run_local_node).';
        $lines[] = '#';
        $lines[] = "# Agent nodes use LangChain's ReAct pattern: the LLM receives";
        $lines[] = '# the system prompt + upstream context, and can call tools in a';
        $lines[] = '# loop until it produces a final answer.';
        $lines[] = $sep;
        $lines[] = '';
        $lines[] = self::singleRunBlock(!empty($missing)
            ? '    RUN_OUT.once("[warn] Missing tools (not MCP): ' . self::pythonListRepr($missing) . '", always=True)' . "\n"
            : '');

        $code = implode("\n", $lines);
        // Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py
        // (LangGraph was the original default and previously had no suffix).
        $filename = "{$safeName}_langgraph.py";
        return ['filename' => $filename, 'code' => $code, 'architecture' => self::architectureDoc($facts, 'single')];
    }

    /**
     * This compile's ARCHITECTURE.md, or null. The document is a companion: it
     * must never cost the user the code, so a failure to build it is logged
     * and dropped. An ingestion pipeline (loader/splitter/vectorstore nodes) is
     * not the agent graph the document describes, so it gets none.
     */
    private static function architectureDoc(array $facts, string $mode): ?string
    {
        foreach ($facts['byId'] as $n) {
            if (in_array(self::nodeType($n), ['loader', 'splitter', 'vectorstore'], true)) {
                return null;
            }
        }
        try {
            return LangGraphArchitectureDoc::build($facts, $mode);
        } catch (\Throwable $e) {
            error_log("[LangGraphGenerator] {$mode} ARCHITECTURE.md skipped: " . $e->getMessage());
            return null;
        }
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

        // Only what Start reaches is the workflow: unconnected canvas nodes stay out.
        $graph = GraphWorkflowRunner::configuredTemplatesAsAgents(
            WorkflowGraphAnalyzer::reachableGraph($this->graphRepo->getGraph($workflowId)));
        // The server runner's node rules (spec 2026-10-15 §7): a template it would refuse, and any type
        // nothing runs, are compile errors -- not a silent no-op in the compiled graph.
        foreach ($graph['nodes'] ?? [] as $n) {
            $t = self::nodeType($n);
            if ($t === 'agent-template') {
                throw new RuntimeException('Unconfigured agent template node found: ' . self::displayName($n)
                    . ' — pick an agent or fill in its instructions.');
            }
            if (!in_array($t, ['start', 'agent', 'playbook', 'code', 'output'], true)) {
                throw new RuntimeException('Node "' . self::displayName($n) . '" (' . $t . ') cannot be compiled: '
                    . 'LangGraph runs start, agent, playbook, code and output nodes.');
            }
        }
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
                if (!$child || !in_array(self::nodeType($child), ['agent', 'agent-template', 'playbook', 'code'], true)) {
                    continue;
                }
                // 'description' is what Jev reads as the option's criterion
                // (JevRouter: role truncated to 400 chars, else the name). Kept
                // EMPTY on purpose: the interpreter feeds Jev DispatchRouting::targets(),
                // which carries no description, so every option is judged by its
                // name alone there. Emitting the child's role here would make the
                // compiled script route differently from the interpreter.
                $targets[] = ['id' => $childId, 'name' => self::displayName($child), 'description' => ''];
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
            // Who the dispatcher is, for its decision question. GraphWorkflowRunner asks
            // the resolved Agent (getName()/getDescription()); when this node
            // references a saved agent, use that record, else the node config.
            $dispatcherName = self::displayName($node);
            $dispatcherDesc = (string) ($cfg['description'] ?? '');
            // Routing settings (routing_mode, min_confidence): the interpreter
            // reads $agent->getSettings(), i.e. the saved record when the node
            // references one, else the node's own settings.
            $routingSettings = is_array($cfg['settings'] ?? null) ? $cfg['settings'] : [];
            if ($agentId !== null && $agentId !== '') {
                try {
                    $agent = $this->agentRepo->findById((int) $agentId);
                    if ($agent !== null) {
                        $agentArr = $agent->toArray();
                        if (trim((string) ($agentArr['name'] ?? '')) !== '') {
                            $dispatcherName = (string) $agentArr['name'];
                        }
                        if (trim((string) ($agentArr['description'] ?? '')) !== '') {
                            $dispatcherDesc = (string) $agentArr['description'];
                        }
                        $recSettings = $agentArr['settings'] ?? [];
                        if (is_string($recSettings)) {
                            $recSettings = json_decode($recSettings, true);
                        }
                        $routingSettings = is_array($recSettings) ? $recSettings : [];
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
            // subprocess runner registered into the catalog (see ToolCatalog.build).
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
                // The question a decision model answers for this dispatcher, computed exactly as
                // the interpreter does (DispatchRouting::defaultInstructions over the agent's
                // name, description and the workflow name) -- not the node's system prompt.
                'decision_question' => $dispatch !== []
                    ? DispatchRouting::defaultInstructions($dispatcherName, $dispatcherDesc, $wfName)
                    : '',
                // Routing mode as GraphWorkflowRunner reads it: 'llm', a decision provider
                // key, or '' (unset: the first candidate whose key is set, else the model).
                'routing_mode' => trim((string) ($routingSettings['routing_mode'] ?? '')),
                // The branch (by name) a not-classified request goes to (DispatchRouting::unclearBranch); '' = stop.
                'unclear_branch' => trim((string) ($routingSettings['unclear_branch'] ?? '')),
                // Same clamp as the interpreter: min_confidence, else jev_min_confidence, else the default.
                'min_confidence' => is_numeric($f = $routingSettings['min_confidence'] ?? $routingSettings['jev_min_confidence'] ?? null)
                    ? max(0.0, min(1.0, (float) $f))
                    : JevRouter::DEFAULT_CONFIDENCE_FLOOR,
                'decision' => $dispatch !== []
                    ? $this->decisionCandidates(trim((string) ($routingSettings['routing_mode'] ?? '')))
                    : [],
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

        // Code nodes: validated settings, exit -> children from the edges' ports, and the MCP
        // servers their declared tools live on (spec §5).
        // Every registered server name resolves, including a second one sharing a URL (refused below if both are used).
        $slugToUrl = [];
        $slugName = [];
        foreach ($mcpTools as $t) {
            $surl = (string) ($t['server_url'] ?? '');
            if ($surl !== '') {
                $slg = CodeNodeEmit::slug((string) ($t['server_name'] ?? ''));
                $slugToUrl[$slg] = $surl;
                $slugName[$slg] = (string) ($t['server_name'] ?? '');
            }
        }
        $codeData = [];
        $codeServerUrls = [];
        foreach ($order as $nid) {
            if (self::nodeType($byId[$nid]) !== 'code') {
                continue;
            }
            $codeData[$nid] = CodeNodeEmit::nodeData($byId[$nid], $graph['edges'] ?? [], $slugToUrl, array_keys($byId));
            foreach ($codeData[$nid]['servers'] as $surl) {
                $codeServerUrls[$surl] = true;
            }
        }
        $codeSlugs = [];
        foreach ($codeData as $cd) {
            foreach ($cd['mcp_servers'] as $slg) {
                $codeSlugs[$slg] = $slugToUrl[$slg];
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
        foreach (array_keys($codeServerUrls) as $surl) {
            if (isset($serverRegistry[$surl])) {
                $usedServers[$surl] = $serverRegistry[$surl];
            }
        }
        // The registry is keyed by URL: two used servers on one URL (two mailboxes on one Outlook MCP,
        // told apart only by their headers) would collapse into one connection. Refuse; a single used
        // server on a shared URL keeps its own name (and so its own header variable).
        $usedNamesByUrl = [];
        foreach ($usedServers as $surl => $meta) {
            $usedNamesByUrl[$surl] = [];
        }
        foreach ($codeData as $cd) {
            foreach ($cd['mcp_servers'] as $slg) {
                $usedNamesByUrl[$slugToUrl[$slg]][$slg] = $slugName[$slg] ?? $slg;
            }
        }
        foreach ($playbookData as $pd) {
            foreach ($pd['actions'] as $a) {
                if (($a['kind'] ?? '') === 'mcp') {
                    $slg = self::serverSlug(explode('.', (string) $a['target'], 2)[0]);
                    $usedNamesByUrl[$a['server_url']][$slg] = $slugName[$slg] ?? $slg;
                }
            }
        }
        foreach ($usedCatalog as $entry) {
            $surl = (string) ($entry['server_url'] ?? '');
            if (isset($usedServers[$surl])) {
                $name = (string) ($usedServers[$surl]['name'] ?? '');
                $usedNamesByUrl[$surl][CodeNodeEmit::slug($name)] = $name;
            }
        }
        foreach ($usedNamesByUrl as $surl => $names) {
            if (count($names) > 1) {
                $names = array_values($names);
                throw new \RuntimeException('MCP servers "' . $names[0] . '" and "' . $names[1] . '" share the URL ' . $surl
                    . '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                    . ' server instance on its own URL and register that.');
            }
            if (count($names) === 1 && isset($usedServers[$surl])) {
                $usedServers[$surl]['name'] = array_values($names)[0];
            }
        }
        // Header env names (MCP_HEADERS_<SLUG>) are per server name: two servers this workflow
        // uses must not share a slug, or one's connection key would go to the other.
        $serverSlugs = [];
        $slugOwner = [];
        foreach ($usedServers as $surl => $meta) {
            $slg = CodeNodeEmit::slug((string) ($meta['name'] ?? ''));
            if (isset($slugOwner[$slg]) && $slugOwner[$slg]['url'] !== (string) $surl) {
                throw new \RuntimeException('MCP servers "' . $slugOwner[$slg]['name'] . '" and "' . (string) ($meta['name'] ?? '')
                    . '" both map to MCP_HEADERS_' . strtoupper($slg) . '; rename one so each server has its own header variable.');
            }
            $slugOwner[$slg] = ['url' => (string) $surl, 'name' => (string) ($meta['name'] ?? '')];
            $serverSlugs[(string) $surl] = $slg;
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
        // Architecture is a property of the workflow, not of the build (§10):
        // read it here rather than taking it as a generate() option, so every
        // caller agrees without having to remember to pass it.
        $orchestration = $workflow->getOrchestration();
        // The Start option, if any: the hidden code node StartOptionGraph::expand added (spec 2026-10-15 §2).
        $triggerNodeId = null;
        $startTrigger = null;
        foreach ($order as $nid) {
            $st = ($byId[$nid]['config'] ?? [])['start_trigger'] ?? null;
            if (self::nodeType($byId[$nid]) === 'code' && is_array($st)) {
                $triggerNodeId = (string) $nid;
                $startTrigger = $st;
                break;
            }
        }
        $defaultCron = $this->defaultCron($workflowId);
        $startMode = $startTrigger !== null ? 'watch' : ($defaultCron !== null ? 'cron' : 'prompt');
        $defaultWatch = $startTrigger !== null
            ? $this->watchFromTrigger((array) ($startTrigger['watch'] ?? []), $serverSlugs)
            : $this->defaultWatch($workflowId, $serverSlugs);
        $workExit = $startTrigger !== null ? (string) ($startTrigger['work_exit'] ?? '') : null;
        $startOptionLabel = $startTrigger !== null ? (string) ($startTrigger['label'] ?? 'Start option') : null;
        return compact('workflow', 'workflowId', 'userId', 'wfName', 'safeName', 'gdata', 'byId', 'order', 'edges',
            'startPrompt', 'startDocuments', 'providerDefaults', 'serverRegistry', 'toolCatalog', 'availableById',
            'dispatchTargets', 'routedBy', 'agentData', 'playbookData', 'codeData', 'codeSlugs', 'serverSlugs', 'usedCatalog', 'usedServers', 'missing', 'edgeList',
            'orchestration', 'defaultCron', 'defaultWatch', 'startMode', 'triggerNodeId', 'workExit', 'startOptionLabel');
    }

    /** The workflow's active cron schedule (newest scheduled_workflows row), baked as DEFAULT_CRON for --cron. */
    private function defaultCron(int $workflowId): ?string
    {
        try {
            $stmt = $this->db->prepare("SELECT cron FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'cron' AND status <> 'paused' ORDER BY id DESC LIMIT 1");
            $stmt->execute([$workflowId]);
            $c = $stmt->fetchColumn();
            return is_string($c) && $c !== '' ? $c : null;
        } catch (\PDOException) {
            return null;   // no schedules table, or an older one without the cron column: no default
        }
    }

    /**
     * The workflow's event trigger (newest non-paused scheduled_workflows row with repeat_type 'event'),
     * baked as DEFAULT_WATCH for --watch: ['server' => slug, 'tool' => ..., 'args' => [...]], or null.
     * event_trigger holds {"server": <server name>, "tool", "args"}. The trigger's server must be one the
     * workflow uses (its URL and MCP_HEADERS_<SLUG> come from there): another one is a compile error.
     */
    private function defaultWatch(int $workflowId, array $serverSlugs): ?array
    {
        try {
            $stmt = $this->db->prepare("SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'event' AND status <> 'paused' ORDER BY id DESC LIMIT 1");
            $stmt->execute([$workflowId]);
            $raw = $stmt->fetchColumn();
        } catch (\PDOException) {
            return null;   // no schedules table, or one without the event_trigger column yet: no default
        }
        $t = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($t) || trim((string) ($t['server'] ?? '')) === '' || trim((string) ($t['tool'] ?? '')) === '') {
            return null;
        }
        return $this->watchFromTrigger($t, $serverSlugs);
    }

    /** {server, tool, args} (server = a name) as DEFAULT_WATCH, the server slugged; one the workflow does not use is an error. */
    private function watchFromTrigger(array $t, array $serverSlugs): ?array
    {
        if (trim((string) ($t['server'] ?? '')) === '' || trim((string) ($t['tool'] ?? '')) === '') {
            return null;
        }
        $slug = CodeNodeEmit::slug((string) $t['server']);
        if (!in_array($slug, $serverSlugs, true)) {
            throw new \RuntimeException('The event trigger waits on MCP server "' . $t['server'] . '", which no node of this'
                . ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).');
        }
        return ['server' => $slug, 'tool' => (string) $t['tool'], 'args' => is_array($t['args'] ?? null) ? $t['args'] : []];
    }

    /** START_MODE / WORK_EXIT / TRIGGER_NODE_ID: the Start's mode and its option's work exit and node (spec 2026-10-15 §2). */
    private static function startModeLines(array $facts): array
    {
        $s = fn(?string $v) => $v === null || $v === '' ? 'None' : PythonEmitHelpers::pyStr($v);
        return ['START_MODE = ' . PythonEmitHelpers::pyStr($facts['startMode']),
            'WORK_EXIT = ' . $s($facts['workExit']),
            'TRIGGER_NODE_ID = ' . $s($facts['triggerNodeId'])];
    }

    /** DEFAULT_WATCH's line: the baked event trigger, or None. */
    private static function defaultWatchLine(array $facts): string
    {
        return 'DEFAULT_WATCH = ' . (($facts['defaultWatch'] ?? null) === null ? 'None'
            : PythonEmitHelpers::jsonToPython(['server' => $facts['defaultWatch']['server'], 'tool' => $facts['defaultWatch']['tool'],
                                               'args' => (object) $facts['defaultWatch']['args']]));
    }

    /** TO RUN lines for --watch (single file and modular package: the modes with code nodes). */
    private static function watchDocLines(array $facts, string $file): array
    {
        $w = $facts['defaultWatch'] ?? null;
        return ["python {$file} --watch           # run whenever the event trigger says something new arrived"
            . ($w !== null ? " ({$w['server']}.{$w['tool']})" : ' (none saved: pass one)'),
            "python {$file} --watch 'outlook.wait_for_new {\"args\": {\"folder\": \"Inbox\"}}'   # or any server.tool + JSON arguments",
            '# --watch: the tool answers {"status": "ready" | "timeout"}; on ready the workflow runs and drains as a --cron tick does'];
    }

    /** TO RUN lines for the default mode and --once (single file and modular package: the entry files with choose_mode). */
    private static function modeDocLines(string $file): array
    {
        return ["python {$file}                   # the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)",
            "python {$file} --once \"text\"     # one run on \"text\", even when the Start listens or is scheduled",
            "python {$file} --quiet | --verbose   # print only each run's done / failed line | also each node's output",
            '# runs/<date>_<run id>.jsonl: each real run\'s events (RUNS_DIR overrides); a quiet run (nothing to do) leaves none'];
    }

    /** DEFAULT_CRON's line: the baked schedule, or None. */
    private static function defaultCronLine(array $facts): string
    {
        return 'DEFAULT_CRON = ' . ($facts['defaultCron'] === null ? 'None' : PythonEmitHelpers::pyStr($facts['defaultCron']));
    }

    /** TO RUN lines for --cron, naming the entry file $file. */
    private static function cronDocLines(array $facts, string $file): array
    {
        return ["python {$file} --cron            # loop on the Start node schedule"
            . (($facts['defaultCron'] ?? null) !== null ? " ({$facts['defaultCron']})" : ' (none saved: pass an expression)'),
            "python {$file} --cron \"*/5 8-18 * * 1-5\"   # or any 5-field cron, Ctrl-C (or SIGTERM) to stop",
            "python {$file} \"your prompt here\" --cron   # a prompt goes BEFORE --cron (after it, it is read as the expression)",
            ...(!empty($facts['codeData'])
                ? ['# --cron with code nodes: a run that did work runs again at once (up to 20 per tick); work = a non-empty'
                    . ' final output, so a code -> agent chain needs an Output node to drain']
                : [])];
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

    /**
     * The `_make_llm(provider, model, temperature, max_tokens, thinking)` factory, one emitted
     * line per entry. LangGraph no longer calls this: it emits LangGraphRuntime::llmFactoryBlock().
     * PUBLIC because the playbook node needs it on every target: PlaybookEmit's
     * interpreter is a LangChain agent loop, so a target emitting a playbook
     * node emits this factory too (see PlaybookEmit::supportBlock()).
     */
    public static function llmFactoryLines(): array
    {
        $lines = [];
        $lines[] = 'def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096, thinking=None):';
        $lines[] = '    """Build a LangChain chat model for the given provider/model.';
        $lines[] = '';
        $lines[] = '    The (provider, model) pair was resolved by the generator: the';
        $lines[] = "    agent's explicit model overrides the provider's default from";
        $lines[] = '    system_llm_settings, and that result is what reaches this';
        $lines[] = '    function. No hardcoded model fallbacks here: every value was read';
        $lines[] = '    from the database when this file was generated (the script never';
        $lines[] = '    reads it), so a model changed in the editor takes effect at the';
        $lines[] = '    next Generate Python.';
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
        $lines[] = '    An entry point (gateway) replaces a vendor link via <PREFIX>_BASE_URL:';
        $lines[] = '    XAI_/DEEPSEEK_/KIMI_/GLM_BASE_URL here; ANTHROPIC_BASE_URL and';
        $lines[] = '    OPENAI_BASE_URL are read by the Anthropic / OpenAI clients themselves.';
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
        $lines[] = '    match p:';
        $lines[] = '        case "claude":';
        $lines[] = '            from langchain_anthropic import ChatAnthropic';
        $lines[] = '            return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)';
        $lines[] = '        case "openai":';
        $lines[] = '            from langchain_openai import ChatOpenAI';
        $lines[] = '            return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)';
        $lines[] = '        case "gemini":';
        $lines[] = '            from langchain_google_genai import ChatGoogleGenerativeAI';
        $lines[] = '            return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)';
        $lines[] = '        case "grok":';
        $lines[] = '            from langchain_openai import ChatOpenAI';
        $lines[] = '            return ChatOpenAI(';
        $lines[] = '                model=model,';
        $lines[] = '                base_url=os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1",';
        $lines[] = '                api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),';
        $lines[] = '                temperature=temperature,';
        $lines[] = '                max_tokens=max_tokens,';
        $lines[] = '            )';
        $lines[] = '        case "deepseek":';
        $lines[] = '            from langchain_openai import ChatOpenAI';
        $lines[] = '            kwargs = dict(';
        $lines[] = '                model=model,';
        $lines[] = '                base_url=os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",';
        $lines[] = '                api_key=os.environ.get("DEEPSEEK_API_KEY"),';
        $lines[] = '                temperature=temperature,';
        $lines[] = '                max_tokens=max_tokens,';
        $lines[] = '            )';
        $lines[] = '            if model.startswith(("deepseek-v4", "deepseek-flash")):';
        $lines[] = '                # The node form Thinking attribute governs (platform parity):';
        $lines[] = '                # off -> disabled, form temperature kept; on/default -> V4 thinking';
        $lines[] = '                # stays enabled and the API rejects sampling params, so temperature';
        $lines[] = '                # is dropped (set Thinking=Off on the node to use a temperature).';
        $lines[] = '                if thinking == "off":';
        $lines[] = '                    kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}';
        $lines[] = '                else:';
        $lines[] = '                    kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "enabled"}}}';
        $lines[] = '                    if "temperature" in kwargs:';
        $lines[] = '                        print(f"[info] deepseek {model}: temperature dropped (thinking mode)", flush=True)';
        $lines[] = '                        kwargs.pop("temperature", None)';
        $lines[] = '            return ChatOpenAI(**kwargs)';
        $lines[] = '        case "kimi":';
        $lines[] = '            from langchain_openai import ChatOpenAI';
        $lines[] = '            # Kimi is OpenAI-compatible. The node form Thinking attribute governs';
        $lines[] = '            # K2 reasoning mode (default off, matching the PHP KimiProvider); the';
        $lines[] = '            # API then constrains sampling: thinking OFF -> temperature MUST be 0.6,';
        $lines[] = '            # thinking ON -> 1.0 (provider CONSTRAINT, not a preference override).';
        $lines[] = '            _k2 = model.startswith("kimi-k2")';
        $lines[] = '            if _k2:';
        $lines[] = '                _want = 1.0 if thinking == "on" else 0.6';
        $lines[] = '                if temperature != _want:';
        $lines[] = '                    print(f"[info] kimi {model}: temperature {temperature} -> {_want} (model constraint)", flush=True)';
        $lines[] = '                    temperature = _want';
        $lines[] = '            kwargs = dict(';
        $lines[] = '                model=model,';
        $lines[] = '                base_url=os.environ.get("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",';
        $lines[] = '                api_key=os.environ.get("KIMI_API_KEY"),';
        $lines[] = '                temperature=temperature,';
        $lines[] = '                max_tokens=max_tokens,';
        $lines[] = '            )';
        $lines[] = '            if _k2:';
        $lines[] = '                _mode = "enabled" if thinking == "on" else "disabled"';
        $lines[] = '                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": _mode}}}';
        $lines[] = '            return ChatOpenAI(**kwargs)';
        $lines[] = '        case "glm":';
        $lines[] = '            from langchain_openai import ChatOpenAI';
        $lines[] = '            # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible.';
        $lines[] = '            return ChatOpenAI(';
        $lines[] = '                model=model,';
        $lines[] = '                base_url=os.environ.get("GLM_BASE_URL") or "https://api.z.ai/api/paas/v4",';
        $lines[] = '                api_key=os.environ.get("GLM_API_KEY"),';
        $lines[] = '                temperature=temperature,';
        $lines[] = '                max_tokens=max_tokens,';
        $lines[] = '                # GLM 5.2 defaults to heavy reasoning; disable thinking for direct answers.';
        $lines[] = '                model_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},';
        $lines[] = '            )';
        $lines[] = '        case _:';
        $lines[] = '            raise RuntimeError(';
        $lines[] = '                f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi, glm."';
        $lines[] = '            )';
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

    /** A2A mode: orchestrator, then api.py (same run contract as the modular package), then one agent file per agent/playbook node (see a2aLayout). */
    private function generateA2A(array $facts): array
    {
        $layout = self::a2aLayout($facts);
        $files = [
            ['path' => 'orchestrator.py', 'code' => $this->emitA2AOrchestrator($facts, $layout)],
            ['path' => 'api.py', 'code' => $this->emitA2AApi($facts, $layout)],
        ];
        foreach ($layout['agents'] as $nid => $e) {
            $files[] = ['path' => $e['file'], 'code' => $this->emitA2AAgentFile($facts, $layout, (string)$nid)];
        }
        return self::withArchitecture(['root' => $layout['root'], 'files' => $files], $facts, 'a2a');
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
                      'extra' => array_merge(['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.'],
                          self::decisionDocLines($facts['agentData'] ?? []), self::mcpHeaderDocLines($facts), self::cronDocLines($facts, 'orchestrator.py')),
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
        $L[] = 'import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid';
        $L[] = 'from datetime import datetime, timedelta';
        $L[] = 'from pathlib import Path';
        $L[] = 'from typing import Annotated, Awaitable, Callable, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/; the runner .env is two levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))';
        $L[] = 'PACKAGE_DIR = _HERE   # this program\'s folder: a relative Start document path resolves here';
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
        $L[] = self::defaultCronLine($facts);
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
        $L[] = '';
        $L[] = self::stateBlock();
        $L[] = '';
        $L[] = self::datetimeInjectorBlock();
        $L[] = '';
        $L[] = self::contextBuilderBlock();
        $L[] = '';
        $L[] = LangGraphRuntime::documentConverterBlock();
        // orchestrator.py carries no common.py, so the event sink + gate rendezvous
        // (installed by api.py, consumed by _handle_gate() below) is emitted here.
        $L[] = $sep; $L[] = '# EVENT SINK -- how api.py observes a run (inert for CLI runs)'; $L[] = $sep;
        $L[] = LangGraphRuntime::runEventsBlock();
        $L[] = LangGraphRuntime::runRecordBlock();
        $L[] = LangGraphRuntime::consoleBlock();
        $L[] = LangGraphRuntime::workflowGraphBlock();
        $L[] = LangGraphRuntime::outputBlock();
        $L[] = LangGraphRuntime::cronBlock();
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

    /** api.py for the A2A folder: the same run contract as the modular package (see emitModularApi,
     *  which composes the shared RunServerEmitter::runtimeBlock() used verbatim below),
     *  plus the agent supervisor's lifecycle -- the agent servers start on the first run. */
    private function emitA2AApi(array $facts, array $layout): string
    {
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $L = [];
        $L[] = '"""Run server for workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' (A2A)';
        $L[] = '';
        $body = $this->apiPyDocBody($facts,
            'LangGraph A2A run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            'pip install fastapi uvicorn "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx pydantic python-dotenv',
            ['# The agent servers start with the first run (see _ensure_agents) and stop with this process.',
             '# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
             '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
             '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)']);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, atexit, json, os, sys, time, uuid';
        $L[] = '';
        $L[] = 'from fastapi import FastAPI, HTTPException, Request';
        $L[] = 'from fastapi.middleware.cors import CORSMiddleware';
        $L[] = 'from fastapi.responses import StreamingResponse';
        $L[] = 'import uvicorn';
        $L[] = '';
        $L[] = 'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $L[] = 'from orchestrator import set_event_sink, resolve_gate';
        $L[] = '';
        $L[] = 'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts));
        $L[] = '';
        $L[] = '# The agent servers start with the first run and stop with this process.';
        $L[] = '_SUPERVISOR = None';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _ensure_agents() -> None:';
        $L[] = '    """Start the A2A agent servers once, on the first run.';
        $L[] = '';
        $L[] = '    AgentSupervisor.start() is BLOCKING -- it spawns one subprocess per';
        $L[] = '    agent and polls each one\'s Agent Card for up to 60s. _drive() (see';
        $L[] = '    modularApiBlock below) calls this hook through asyncio.to_thread so';
        $L[] = '    the event loop stays free to serve /runs/<id>/events while the agents';
        $L[] = '    are still coming up, instead of stalling every request for that long.';
        $L[] = '    """';
        $L[] = '    global _SUPERVISOR';
        $L[] = '    if _SUPERVISOR is None:';
        $L[] = '        _SUPERVISOR = AgentSupervisor(spawn=True)';
        $L[] = '        # Registered BEFORE start() so a fleet that half-came-up is still';
        $L[] = '        # torn down. Nothing else stops these processes: the orchestrator';
        $L[] = '        # CLI does it in a finally, and this server has no such scope.';
        $L[] = '        atexit.register(_stop_agents)';
        $L[] = '        _SUPERVISOR.start()';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _stop_agents() -> None:';
        $L[] = '    """Shutdown hook: stop the agent fleet this process spawned.';
        $L[] = '';
        $L[] = '    Without it, a SIGTERM to this server leaves N agent processes';
        $L[] = '    running and holding ports 8701+, and the next start fails with';
        $L[] = '    "port may already be in use". Idempotent (the supervisor is cleared';
        $L[] = '    first, so a second call finds nothing) and non-raising -- a hook that';
        $L[] = '    throws on the way out only hides the real exit.';
        $L[] = '    """';
        $L[] = '    global _SUPERVISOR';
        $L[] = '    sup, _SUPERVISOR = _SUPERVISOR, None';
        $L[] = '    if sup is None:';
        $L[] = '        return';
        $L[] = '    try:';
        $L[] = '        sup.stop()';
        $L[] = '    except Exception as exc:   # noqa: BLE001 -- best effort on the way out';
        $L[] = '        print(f"[supervisor] stop failed: {exc}", flush=True)';
        $L[] = '';
        $L[] = RunServerEmitter::runtimeBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
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
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
        "server" if EVENTS.active
        else "prompt" if sys.stdin.isatty()
        else "auto")
    if mode == "server":
        # A host (api.py) has installed an event sink: mint a tool_call_id, tee the
        # gate onto the event stream, and block this A2A task's coroutine until
        # resolve_gate() delivers an answer or PLAYBOOK_GATE_TIMEOUT_S runs out.
        tool_call_id = uuid.uuid4().hex
        waiter = EVENTS.open_gate(tool_call_id)
        EVENTS.emit(type="gate_request", kind=kind, payload=dict(args), tool_call_id=tool_call_id)
        waiter.wait(float(os.environ.get("PLAYBOOK_GATE_TIMEOUT_S", "900")))
        # Pop unconditionally, and decide on what the pop returned: an answer
        # that lands between the wait() timing out and this line is still the
        # human's answer, and popping also clears the slot so a later POST gets
        # a truthful 404 instead of answering 200 into a run that moved on.
        answer = EVENTS.take_answer(tool_call_id)
        if answer is not None:
            print("[gate-answer] " + json.dumps({"agent": agent_name, "task": task_id, **answer}, ensure_ascii=False), flush=True)
            return answer
        # Nobody attached, or nobody answered in time: fall through to the same
        # non-interactive policy a run without a sink would get.
        mode = "auto"
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
    # Each node opens a round so a watching host can tell the legs apart. The
    # agents run in their own processes with no sink of their own, so relaying
    # their status lines here is the ONLY way an A2A run streams anything but
    # gates.
    try:
        EVENTS.emit(type="round", round=ORDER.index(nid))
    except ValueError:
        EVENTS.emit(type="round", round=0)
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
                                EVENTS.emit(type="message", text=f"[{ad['display']}] {line}", sensitive=False)
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
                # _handle_gate is SYNCHRONOUS and its server branch blocks on a
                # threading.Event for up to PLAYBOOK_GATE_TIMEOUT_S. Inside api.py
                # this coroutine shares FastAPI's event loop, so calling it
                # directly would freeze the loop: the gate_request frame is
                # scheduled with loop.call_soon_threadsafe and would never be
                # delivered, and POST /runs/<id>/tool-result could never be
                # served -- every gate would time out to the policy answer.
                # to_thread keeps the loop serving while the human decides (and
                # unblocks console 'prompt' mode for the same reason).
                answer = await asyncio.to_thread(_handle_gate, ad["display"], task_id, gate_payload)
                pending = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), task_id=task_id, context_id=ctx_id, role=T.Role.ROLE_USER,
                                                                 parts=[T.Part(text=str(answer.get("decision", ""))), new_data_part(answer)]))
        await client.close()
    dt = time.monotonic() - t0
    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt
    print(f"[node] [{nid}] {ad['display']!r} done over A2A -- {sum(len(t) for t in text_parts)} chars ({dt:.1f}s)", flush=True)
    out = {"text": "\n".join(text_parts), "route": str(data.get("route") or ""), "notes": str(data.get("notes") or ""), "status": str(data.get("status") or "ok")}
    if out["text"]:
        EVENTS.emit(type="message", text=f"**{ad['display']}**\n\n{out['text']}", sensitive=False)
    EVENTS.emit(type="final", leg=nid, status=out["status"] or "ok")
    return out


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over A2A tasks
# ==============================================================
NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)


def build_graph() -> WorkflowGraph:
    """The workflow's graph (WorkflowGraph above): agent nodes call their A2A servers."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents=AGENTS,
                         run_node=_run_remote_node, start_documents=START_DOCUMENTS)


async def run(user_prompt: str, session: str | None = None) -> str:
    """Build the graph (agent nodes call their A2A servers), run it, return the final output.

    `session` is accepted so this signature matches api.py's run contract
    (shared with the modular and swarm targets) but is ignored here: an A2A
    run dispatches independent tasks to remote agents and has no
    conversation to resume between calls.
    """
    return await build_graph().run(user_prompt)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"A2A orchestrator for workflow {WORKFLOW_NAME!r}", allow_abbrev=False)
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    ap.add_argument("--keep-serving", action="store_true", help="leave the agent servers running after the run")
    ap.add_argument("--no-spawn", action="store_true", help="do not start agents; expect their URLs to be reachable")
    ap.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",
                    help="run on a cron schedule until Ctrl-C (default: the Start node's schedule)")
    a = ap.parse_args()
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    cron = CronExpression.from_cli(ap, a.cron, DEFAULT_CRON)   # a bad --cron stops here, before any agent starts
    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)

    def run_once() -> str:
        """One run over the agent servers: its output printed and saved ('' when it ended without one)."""
        print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}", flush=True)
        NODE_DURATIONS.clear()   # this run's times only (RUN SUMMARY)
        graph = build_graph()
        output = runs.loop.run_until_complete(graph.run(prompt))
        if output:
            print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output, flush=True)
            saved = save_output(output, enabled=OUTPUT_STORAGE_ENABLED, folder=OUTPUT_FOLDER,
                                workflow_id=WORKFLOW_ID, workflow_name=WORKFLOW_NAME)
            print_run_summary(output, saved, graph.started, NODE_DURATIONS, "Time per node (A2A round trip)")
        return output

    # The agents start once and serve every run of the loop.
    sup = AgentSupervisor(spawn=not a.no_spawn)
    try:
        sup.start()
        match cron:
            case None:
                if not run_once():
                    print("[info] The run ended without output (a branch ended).", flush=True)
            case expr:
                run_cron(expr, run_once, drains=False, loop=runs)   # A2A packaging has no code nodes
    finally:
        if not a.keep_serving:
            sup.stop()
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
        $L[] = 'import argparse, asyncio, json, os, ' . ($isPlaybook ? 're, ' : '') . 'subprocess, sys, threading, time' . ($isPlaybook ? ', uuid' : '');
        $L[] = 'from abc import ABC, abstractmethod';
        $L[] = 'from dataclasses import asdict, dataclass, field';
        $L[] = 'from enum import Enum';
        $L[] = 'from functools import cached_property';
        $L[] = 'from pathlib import Path';
        $L[] = 'from typing import Callable, Literal';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(os.path.dirname(_HERE), ".env"))   # the workflow folder\'s own .env first (never overridden)';
        $L[] = 'RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))   # the runner env folder (python/)';
        $L[] = 'load_dotenv(os.path.join(RUNNER_DIR, ".env"))';
        $L[] = 'DEBUG_STEM = os.path.basename(os.path.dirname(_HERE))   # the package folder names this node\'s outputs/_debug dumps';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'import uvicorn';
        $L[] = 'from starlette.applications import Starlette';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langchain_core.tools import StructuredTool';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = 'from pydantic import Field, create_model';
        $L[] = 'from a2a import types as T';
        $L[] = 'from a2a.server.agent_execution import AgentExecutor, RequestContext';
        $L[] = 'from a2a.server.events import EventQueue';
        $L[] = 'from a2a.server.request_handlers import DefaultRequestHandler';
        $L[] = 'from a2a.server.tasks import InMemoryTaskStore, TaskUpdater';
        $L[] = 'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes';
        $L[] = 'from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts';
        $L[] = '';
        $L[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $L[] = '';
        $L[] = '# This file is SELF-CONTAINED on purpose: the LLM factory, MCP client, tool';
        $L[] = '# builder, skill and playbook blocks below are the same code the single-file';
        $L[] = '# script carries, duplicated here so this agent can be copied to another host';
        $L[] = '# alone.';
        $L[] = $sep; $L[] = '# LLM FACTORY'; $L[] = '# Provider/model -> LangChain chat model (same rules as the single-file script).'; $L[] = $sep;
        $L[] = LangGraphRuntime::llmFactoryBlock();
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP SERVER REGISTRY + TOOL CATALOG (this node only)'; $L[] = $sep;
        $L[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($servers, true);
        $L[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($catalog, true);
        $L[] = '';
        $L[] = $sep; $L[] = '# MCP CLIENT -- JSON-RPC 2.0 over HTTP'; $L[] = $sep;
        $L[] = self::serverSlugsLine(array_intersect_key($facts['serverSlugs'] ?? [], $servers));
        $L[] = '';
        $L[] = LangGraphRuntime::mcpClientBlock();
        $L[] = $sep; $L[] = '# TOOL BUILDER + SKILL RUNTIME'; $L[] = $sep;
        $L[] = LangGraphRuntime::toolCatalogBlock() . LangGraphRuntime::skillRuntimeBlock();
        $L[] = LangGraphRuntime::runEventsBlock();
        $L[] = LangGraphRuntime::dispatcherBlock(self::decisionProtocolsUsed($facts['agentData'] ?? []));
        $L[] = self::datetimeInjectorBlock();
        if ($isPlaybook) {
            $L[] = LangGraphRuntime::playbookBlock();
        }
        $L[] = LangGraphRuntime::nodeClassesBlock($isPlaybook);
        $L[] = '';
        // ---- node definition ----
        $L[] = $sep; $L[] = '# NODE DEFINITION -- frozen from the workflow editor'; $L[] = $sep;
        $docNodes = $this->a2aDocNodes($facts, $layout);
        foreach ($docNodes as $dn) {
            if ($dn['id'] === $nid) { foreach (explode("\n", PythonEmitHelpers::nodeCommentBlock($dn)) as $cl) $L[] = $cl; }
        }
        foreach (explode("\n", $this->nodeDefinitionLines($facts, $nid, $kind, $entry['display'], $def, $isPlaybook)) as $nl) $L[] = $nl;
        $L[] = '';
        $L[] = '# The executor below runs this node through run_node(request_text, trace).';
        $L[] = 'run_node = make_node(NODE).run';
        $L[] = '';
        $L[] = '';
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
        foreach ($facts['codeData'] as $n => $cd) {
            $docAgents[$n] = ['name' => $cd['display'], 'provider' => '', 'model' => '', 'temperature' => null,
                'max_tokens' => null, 'thinking' => null, 'tools' => array_map(fn($slg) => "{$slg}.*", $cd['mcp_servers']), 'skills' => []];
        }
        $nodes = \AgentTeam\Services\WorkflowGraphAnalyzer::docNodes($facts['byId'], $facts['order'], $facts['edges'], $docAgents, $docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'code', 'output']);
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
                      'extra' => array_merge(['# Card: http://127.0.0.1:' . $entry['port'] . '/.well-known/agent-card.json  --  JSON-RPC at /'],
                          self::decisionDocLines($facts['agentData'] ?? []), self::mcpHeaderDocLines($facts)),
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
    GATE_BRIDGE = _a2a_gate   # PlaybookRun.gate() hands every gate to GATE_BRIDGE(run, kind, name, args)


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
            } elseif (isset($facts['codeData'][$nid])) {
                $kind = 'code';
                $display = $facts['codeData'][$nid]['display'];
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

    /**
     * Swarm mode: the modular layout (§7 -- only layout a swarm supports),
     * with workflow.py replaced by a graph built from create_swarm() over
     * the SAME SwarmRewriter::rewrite() the editor runs live.
     *
     * common.py and api.py are emitted by the SAME emitModularCommon()/
     * emitModularApi() generateModular() calls -- a swarm shares the shared
     * runtime and the run server verbatim; only workflow.py (create_swarm()
     * over the members) and agents/*.py (create_react_agent() + one
     * create_handoff_tool() per colleague) are swarm-specific. There is no
     * agents/__init__.py: a swarm package is exactly workflow.py, common.py,
     * api.py and one module per member -- no package marker, no dispatcher.
     */
    private function generateSwarm(array $facts): array
    {
        // The shape SwarmRewriter::rewrite() expects -- {nodes:[{id,node_type,
        // config}], edges:[{from,to}]}, the same the API/editor use. analyzeForEmit()
        // already holds this as byId (node-by-id) + edges (normalised {from,to} by
        // WorkflowGraphAnalyzer), so this is a reshape, not a re-derivation.
        $nodes = [];
        $nodeNames = [];
        foreach ($facts['byId'] as $nid => $node) {
            // PHP coerces a numeric-string array key back to int, so the key here
            // may already have lost its "3"-ness -- cast it back before it travels
            // any further, or every downstream === against an edge's string id
            // silently fails.
            $id = (string) $nid;
            $nodes[] = [
                'id' => $id,
                'node_type' => self::nodeType($node),
                'config' => is_array($node['config'] ?? null) ? $node['config'] : [],
            ];
            $nodeNames[$id] = self::displayName($node);
        }
        $edges = [];
        foreach ($facts['edges'] as $e) {
            $edges[] = ['from' => (string) ($e['from'] ?? ''), 'to' => (string) ($e['to'] ?? '')];
        }

        $rw = SwarmRewriter::rewrite(['nodes' => $nodes, 'edges' => $edges]);
        if (!$rw['ok']) {
            $names = implode(', ', array_map(fn($id) => $nodeNames[(string) $id] ?? "node {$id}", $rw['nodes']));
            throw new RuntimeException(self::swarmRefusalMessage($rw['error']) . ($names !== '' ? " ({$names})" : ''));
        }
        $facts['swarm'] = $rw;

        // File layout: the same modularLayout() Task 3's real emitters reuse.
        // A canvas that reached here has already passed every swarm refusal, so
        // its agent/playbook nodes are exactly $rw['agents']'s members -- no
        // dispatcher, no playbook, no agent off Start. Iterate $rw['agents'] (built
        // in menu order, i.e. Start's fan-out order) rather than the layout's own
        // order, so the manifest is provably in canvas order regardless of how
        // topological order happens to tie-break.
        $layout = self::modularLayout($facts);
        // The package files of the modular path (spec 2026-10-15 §5): its skills, requirements,
        // .env.example and README. A swarm reads no Start documents, so none are copied.
        $package = LangGraphPackage::files(['startDocuments' => []] + $facts, $this->skillsRoot);
        $files = [
            ['path' => 'workflow.py', 'code' => $this->emitSwarmWorkflow($facts, $layout)],
            // common.py and api.py are the EXISTING modular emitters, called
            // (not copied): a swarm shares the shared runtime and run server
            // verbatim with the modular workflow path.
            ['path' => 'common.py', 'code' => $this->emitModularCommon($facts, $layout, true)],
            ['path' => 'api.py', 'code' => $this->emitModularApi($facts, $layout, false)],
            // A REGULAR package, not a namespace portion. Without __init__.py,
            // `import agents.<member>` loses to any installed top-level `agents`
            // package -- openai-agents ships one, and PEP 420 lets a regular package
            // elsewhere on sys.path beat a namespace portion here. generateModular()
            // emits this for the same reason; the swarm path omitted it, so the
            // emitted package did not import at all.
            ['path' => 'agents/__init__.py', 'code' => '"""Agent modules of workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                . ' (swarm)."""' . "\n"],
        ];
        foreach ($rw['agents'] as $id => $agent) {
            $entry = $layout['agents'][$id] ?? null;
            if ($entry === null) {
                continue;
            }
            $files[] = ['path' => $entry['file'], 'code' => $this->emitSwarmAgentFile($facts, $layout, (string) $id)];
        }
        array_push($files, ...$package);
        return ['root' => $layout['root'] . '_swarm', 'files' => $files];
    }

    /**
     * agents/<name>.py, swarm mode: ONE member -- its frozen NODE metadata
     * (shared shape with the modular agent module, via nodeDefinitionLines()),
     * the rewrite's own composed INSTRUCTIONS (colleague guide included --
     * never recomputed here), one create_handoff_tool() per colleague, and
     * build_agent() wiring them into a create_react_agent(). There is no
     * run_node(): a swarm member is a Pregel graph create_swarm() consumes
     * directly, not a function workflow.py frames input for and calls once.
     */
    private function emitSwarmAgentFile(array $facts, array $layout, string $nid): string
    {
        $rw = $facts['swarm'];
        $entry = $layout['agents'][$nid];
        $member = $rw['agents'][$nid];
        $def = $facts['agentData'][$nid];
        $sep = '# ' . str_repeat('=', 62);
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);

        $L = [];
        $L[] = '"""Swarm member ' . $j($entry['display']) . " -- node {$nid} of workflow " . $j($facts['wfName']);
        $L[] = '';
        $body = $this->swarmAgentDocBody($facts, $nid);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'from langgraph_swarm import create_handoff_tool';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = '    _PROMPT_KW = "system_prompt"   # langchain >= 1.x renamed prompt=';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = '    _PROMPT_KW = "prompt"';
        $L[] = '';
        $L[] = '# The shared runtime lives in common.py, one directory up. Python puts the';
        $L[] = '# workflow folder on sys.path when workflow.py starts, so this resolves for';
        $L[] = '# every module of the package.';
        $L[] = 'from common import _make_llm, TOOLS, inject_datetime';
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
        $node = $this->nodeDefinitionLines($facts, $nid, 'agent', $entry['display'], $def, false);
        foreach (explode("\n", $node) as $nl) {
            $L[] = $nl;
        }
        $L[] = '';
        $L[] = $sep;
        $L[] = "# INSTRUCTIONS -- SwarmRewriter's composed prompt: this member's own";
        $L[] = '# instructions, plus (when it has colleagues) the "Colleagues you can hand';
        $L[] = "# this to\" guide. Read from the rewrite, never recomputed here.";
        $L[] = $sep;
        $L[] = 'INSTRUCTIONS = """';
        foreach (explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], (string) $member['instructions'])) as $il) {
            $L[] = $il;
        }
        $L[] = '"""';
        $L[] = '';
        $L[] = $sep;
        $L[] = '# HANDOFFS -- one handoff tool per colleague. create_swarm() and';
        $L[] = "# these tools both identify agents by NAME (the display name SwarmRewriter";
        $L[] = '# guaranteed unique).';
        $L[] = $sep;
        $L[] = 'HANDOFFS = [';
        foreach ($member['handoffs'] as $otherId) {
            $otherId = (string) $otherId;
            $other = $rw['agents'][$otherId] ?? null;
            if ($other === null) {
                continue;
            }
            $role = rtrim(self::swarmColleagueRole($rw, $otherId), ". \t");
            $desc = 'Hand the conversation to ' . $other['name'] . ($role !== '' ? ' — ' . $role : '') . '.';
            $L[] = '    create_handoff_tool(';
            $L[] = '        agent_name=' . PythonEmitHelpers::pyStr((string) $other['name']) . ',';
            $L[] = '        description=' . PythonEmitHelpers::pyStr($desc) . ',';
            $L[] = '    ),';
        }
        $L[] = ']';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _llm():';
        $L[] = '    """The chat model for this member, built from NODE (provider/model/sampling/thinking)."""';
        $L[] = '    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))';
        $L[] = '';
        $L[] = '';
        $L[] = 'def build_agent():';
        $L[] = '    """Build this member\'s react agent: its own MCP tools plus one handoff per colleague.';
        $L[] = '';
        $L[] = '    name= is the member\'s DISPLAY name -- what create_swarm() and every colleague\'s';
        $L[] = '    HANDOFFS identify it by, the same name the rewrite guaranteed unique.';
        $L[] = '    """';
        $L[] = '    tools = TOOLS.tools_for(NODE["tool_names"])';
        $L[] = '    return create_react_agent(';
        $L[] = '        _llm(),';
        $L[] = '        tools + HANDOFFS,';
        // langchain's create_agent takes system_prompt=, langgraph's
        // create_react_agent takes prompt=. The import above picked one and set
        // _PROMPT_KW to match; passing the wrong name is a TypeError on every
        // call, which is what the compile probe caught.
        $L[] = '        **{_PROMPT_KW: inject_datetime(INSTRUCTIONS)},';
        // The rewrite's name, NOT NODE["display"]. create_swarm() matches
        // agents BY NAME, and every handoff tool and DEFAULT_ACTIVE_AGENT are
        // already emitted from SwarmRewriter's names. The two name functions
        // differ on empty strings, non-string values and the unnamed fallback,
        // so taking one from each source emits a graph whose handoffs point at
        // an agent that is not in it -- a package that builds and then dies at
        // the first hand-off.
        $L[] = '        name=' . PythonEmitHelpers::pyStr((string) $member['name']) . ',';
        $L[] = '    )';
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * Module-docstring body for ONE swarm member -- what a reader of THIS
     * file needs, not a whole-graph dump. A member has no dispatcher, no
     * parents/children of its own and no "GRAPH EDGES" to report: the canvas
     * fan-out off Start only ever decided membership, and printing it here
     * previously *contradicted* the file's own HANDOFFS (a full mesh), which
     * is the correctness bug this replaces. PROVENANCE keeps the same shape
     * every generated file's docstring opens with (workflowDocBlock()'s);
     * everything after it is specific to this member, sourced from
     * $facts['swarm']['agents'][$nid] and $facts['agentData'][$nid] -- never
     * recomputed.
     */
    private function swarmAgentDocBody(array $facts, string $nid): string
    {
        $rw = $facts['swarm'];
        $member = $rw['agents'][$nid];
        $def = $facts['agentData'][$nid];

        $L = [];
        $L[] = 'PROVENANCE';
        $L[] = '==========';
        $L[] = "  Workflow:   {$facts['wfName']} (id {$facts['workflowId']})";
        $L[] = '  Target:     LangGraph swarm member (Python) -- one create_react_agent(); workflow.py hands it to create_swarm()';
        $L[] = '  Generated:  ' . date('Y-m-d H:i:s T') . ' by the SynergyAI workflow editor';
        $L[] = '  This file is a frozen snapshot of the workflow. Edits made here are';
        $L[] = '  overwritten by the next Generate: change the workflow in the editor and';
        $L[] = '  re-generate instead.';
        $L[] = '';
        $L[] = 'MEMBER  (this file, not the whole workflow)';
        $L[] = '======';
        $model = ($def['model'] ?? '') !== '' ? $def['model'] : '(platform default)';
        $s = ($def['provider'] ?: '?') . ' / ' . $model;
        if (($def['temperature'] ?? null) !== null) $s .= ', temp ' . json_encode((float) $def['temperature']);
        if (($def['max_tokens'] ?? null) !== null) $s .= ', max_tokens ' . (int) $def['max_tokens'];
        $L[] = "  {$member['name']} -- node {$nid} in the workflow editor.";
        $L[] = "  Model:  {$s}";
        $L[] = '  Tools:  ' . ($member['tools'] ? implode(', ', $member['tools']) : '(none)');
        $L[] = '  Skills: ' . ($member['skills'] ? implode(', ', $member['skills']) : '(none)');
        $L[] = '';
        $L[] = "COLLEAGUES  (this member's own handoffs -- what HANDOFFS below builds, not the canvas)";
        $L[] = '==========';
        if ($member['handoffs']) {
            foreach ($member['handoffs'] as $otherId) {
                $other = $rw['agents'][(string) $otherId] ?? null;
                if ($other === null) {
                    continue;
                }
                $role = rtrim(self::swarmColleagueRole($rw, (string) $otherId), ". \t");
                $L[] = '  ' . $other['name'] . ($role !== '' ? ' -- ' . $role : '');
            }
        } else {
            $L[] = '  (none -- this member has no colleague to hand off to)';
        }
        $L[] = '';
        $L[] = 'INSTRUCTIONS  (below)';
        $L[] = '============';
        $L[] = "  SwarmRewriter's composed prompt: this member's own instructions plus,";
        $L[] = '  when it has colleagues, the "Colleagues you can hand this to" guide built';
        $L[] = '  from the list above. Change the agent\'s prompt in the workflow editor,';
        $L[] = '  not here -- this is overwritten on the next Generate.';
        $L[] = '';
        $L[] = 'BUILD_AGENT()';
        $L[] = '=============';
        $L[] = "  Returns this member's create_react_agent(): its own MCP tools (Tools,";
        $L[] = '  above) plus one handoff tool per colleague (HANDOFFS, below). workflow.py';
        $L[] = '  imports it and passes the built agent straight into create_swarm().';
        $L[] = '';
        $L[] = 'TO RUN';
        $L[] = '======';
        $L[] = '  # Requires Python 3.10+ (the generated code uses match statements)';
        $L[] = '  pip install langchain langchain-anthropic langchain-openai langgraph langgraph-swarm httpx pydantic python-dotenv';
        $k = PythonEmitHelpers::providerKeyEnv((string) ($def['provider'] ?? ''));
        $L[] = $k !== null
            ? "  # API key read from ../../../.env: {$k} (" . strtolower((string) $def['provider']) . ')'
            : '  # No LLM provider key required.';
        $L[] = '  imported by workflow.py -- run the swarm (python workflow.py), not this file directly.';
        return implode("\n", $L);
    }

    /** First line of a colleague's OWN composed instructions -- the exact role summary
     *  SwarmRewriter::rewrite() folded into every OTHER member's "Colleagues" guide.
     *  Read from the rewrite's output, never recomputed. */
    private static function swarmColleagueRole(array $rw, string $colleagueId): string
    {
        $instructions = (string) ($rw['agents'][$colleagueId]['instructions'] ?? '');
        $first = trim(explode("\n", $instructions)[0] ?? '');
        return mb_substr($first, 0, 120);
    }

    /**
     * workflow.py, swarm mode: create_swarm() over one create_react_agent()
     * per member (built by their own module's build_agent()), compiled with
     * a checkpointer -- the single injection point a database-backed saver
     * replaces later without changing this shape. Exposes the same
     * run()/DEFAULT_PROMPT/WORKFLOW_ID/WORKFLOW_NAME surface as the modular
     * workflow.py, so api.py (unchanged, reused verbatim) drives it exactly
     * the same way.
     */
    private function emitSwarmWorkflow(array $facts, array $layout): string
    {
        $rw = $facts['swarm'];
        $sep = '# ' . str_repeat('=', 62);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);

        $members = []; // nid => layout entry, in canvas (Start fan-out) order
        foreach ($rw['agents'] as $id => $agent) {
            $entry = $layout['agents'][$id] ?? null;
            if ($entry !== null) {
                $members[(string) $id] = $entry;
            }
        }
        $L = [];
        $L[] = '"""LangGraph swarm: ' . $facts['wfName'];
        $L[] = '';
        $body = $this->swarmWorkflowDocBody($facts, $members);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, re, signal, time, uuid';
        $L[] = 'from datetime import datetime, timedelta';
        $L[] = 'from typing import Callable';
        $L[] = '';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage';
        $L[] = 'from langgraph.checkpoint.memory import MemorySaver';
        $L[] = 'from langgraph_swarm import create_swarm';
        $L[] = '';
        $L[] = '# Running this file puts its own folder on sys.path, so `common` and the';
        $L[] = '# `agents` package below resolve wherever the workflow folder is copied.';
        $L[] = 'from common import EVENTS';
        foreach ($members as $nid => $e) {
            $L[] = 'from ' . $e['module'] . ' import build_agent as build_' . $e['name'];
        }
        $L[] = '';
        $L[] = 'WORKFLOW_ID = ' . (int) $facts['workflowId'];
        $L[] = 'WORKFLOW_NAME = ' . PythonEmitHelpers::pyStr($facts['wfName']);
        $L[] = 'OUTPUT_STORAGE_ENABLED = ' . ($facts['workflow']->isOutputStorageEnabled() ? 'True' : 'False');
        $ofolder = $facts['workflow']->getOutputFolder();
        $L[] = 'OUTPUT_FOLDER = ' . (($ofolder ?? '') !== '' ? PythonEmitHelpers::pyStr((string) $ofolder) : 'None');
        $L[] = 'DEFAULT_PROMPT = ' . PythonEmitHelpers::pyStr($facts['startPrompt']);
        $L[] = self::defaultCronLine($facts);
        $entryName = (string) ($rw['agents'][$rw['entry']]['name'] ?? '');
        $L[] = 'DEFAULT_ACTIVE_AGENT = ' . PythonEmitHelpers::pyStr($entryName) . '   # the member wired to Start';
        $L[] = '# Every valid create_swarm() active_agent value -- each member\'s NODE["display"],';
        $L[] = '# the same text create_react_agent(name=...) and every HANDOFFS agent_name= use.';
        // One source for every name in this graph: the rewrite's. See the
        // agent emitter -- create_swarm() matches by name, so MEMBER_NAMES,
        // DEFAULT_ACTIVE_AGENT, every agent_name= and every create_react_agent
        // name= must all be the same strings.
        // $members is keyed by node id and the layout entry carries NO 'id', so
        // this must read the key, not the entry -- an $e['id'] lookup is
        // undefined and silently falls back to the generator's own display name,
        // which is the source this exists to stop using.
        $memberNames = [];
        foreach ($members as $nid => $e) {
            $memberNames[] = PythonEmitHelpers::pyStr((string) $rw['agents'][$nid]['name']);
        }
        $L[] = 'MEMBER_NAMES = {' . implode(', ', $memberNames) . '}';
        $L[] = '';
        $L[] = $sep;
        $L[] = '# GRAPH -- create_swarm() returns an UNCOMPILED StateGraph; .compile() is ours.';
        $L[] = '# MemorySaver keeps hand-offs (active_agent + message history) coherent for';
        $L[] = '# the run; it is the single point a database-backed saver replaces later.';
        $L[] = $sep;
        $L[] = 'def build_graph():';
        $L[] = '    return create_swarm(';
        $L[] = '        [' . implode(', ', array_map(fn($e) => 'build_' . $e['name'] . '()', $members)) . '],';
        $L[] = '        default_active_agent=DEFAULT_ACTIVE_AGENT,';
        $L[] = '    ).compile(checkpointer=MemorySaver())';
        $L[] = '';
        $L[] = '';
        $L[] = '_GRAPH = None';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _graph():';
        $L[] = '    """Build the compiled graph once per process and reuse it."""';
        $L[] = '    global _GRAPH';
        $L[] = '    if _GRAPH is None:';
        $L[] = '        _GRAPH = build_graph()';
        $L[] = '    return _GRAPH';
        $L[] = '';
        $L[] = '';
        $L[] = $sep;
        $L[] = '# MAIN EXECUTION';
        $L[] = $sep;
        $L[] = 'async def run(user_prompt: str, session: str | None = None) -> str:';
        $L[] = '    """Run the swarm, starting from DEFAULT_ACTIVE_AGENT, and return the final';
        $L[] = '    message text. api.py calls this exactly as it calls the modular';
        $L[] = '    workflow.py\'s run() -- one prompt in, one answer out.';
        $L[] = '';
        $L[] = '    A swarm is a conversation: passing the same `session` on a later call';
        $L[] = '    resumes it -- same transcript, and the agent that answered last still';
        $L[] = '    holds the turn. Omitting it starts a fresh one, which is the right';
        $L[] = '    default for a single-shot invocation."""';
        $L[] = '    config = {"configurable": {"thread_id": session or uuid.uuid4().hex}}';
        $L[] = '    result = await _graph().ainvoke({"messages": [HumanMessage(content=user_prompt)]}, config=config)';
        $L[] = '    final = result["messages"][-1]';
        $L[] = '    text = final.content if isinstance(final, AIMessage) else str(final)';
        $L[] = '    if isinstance(text, list):';
        $L[] = '        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))';
        $L[] = '    # active_agent is the member holding the turn when it ended -- exactly who';
        $L[] = '    # answered. Fall back to the entry agent rather than emit an unlabelled reply';
        $L[] = '    # when it is missing (older checkpoints) or not a known member.';
        $L[] = '    active = result.get("active_agent")';
        $L[] = '    display = active if isinstance(active, str) and active in MEMBER_NAMES else DEFAULT_ACTIVE_AGENT';
        $L[] = '    # `agent` is carried as its own field, not only inside the text: the';
        $L[] = '    # conversation UI labels the bubble with it, and a label reading';
        $L[] = '    # "Playbook" over an answer from "Human resources" is worse than no';
        $L[] = '    # label at all. EVENTS.emit takes **kwargs, so this is additive.';
        $L[] = '    EVENTS.emit(type="message", text=f"**{display}**\\n\\n{text}", agent=display, sensitive=False)';
        $L[] = '    return text';
        $L[] = '';
        $L[] = '';
        $L[] = 'def _save_output(output: str) -> str | None:';
        $L[] = '    """Honour the workflow\'s output storage setting (same rule as the non-swarm workflow.py)."""';
        $L[] = '    import os, re';
        $L[] = '    if not OUTPUT_STORAGE_ENABLED:';
        $L[] = '        return None';
        $L[] = '    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")';
        $L[] = '    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")';
        $L[] = '    if not os.path.isabs(folder):';
        $L[] = '        folder = os.path.join(root, folder)';
        $L[] = '    os.makedirs(folder, exist_ok=True)';
        $L[] = '    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", output) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", output)';
        $L[] = '    ext = "html" if m else "md"';
        $L[] = '    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]';
        $L[] = '    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime(\'%Y%m%d-%H%M%S\')}.{ext}")';
        $L[] = '    with open(path, "w", encoding="utf-8") as fh:';
        $L[] = '        fh.write(m.group(0) if m else output)';
        $L[] = '    return path';
        $L[] = '';
        $L[] = '';
        $L[] = LangGraphRuntime::cronBlock();
        $L[] = 'if __name__ == "__main__":';
        $L[] = '    ap = argparse.ArgumentParser(description=f"LangGraph swarm {WORKFLOW_NAME!r}", allow_abbrev=False)';
        $L[] = '    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")';
        $L[] = '    ap.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",';
        $L[] = '                    help="run on a cron schedule until Ctrl-C (default: the Start node\'s schedule)")';
        $L[] = '    a = ap.parse_args()';
        $L[] = '    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"';
        $L[] = '    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)';
        $L[] = '';
        $L[] = '    def run_once() -> str:';
        $L[] = '        """One run of the swarm (a fresh conversation): its output printed and saved (\'\' when none)."""';
        $L[] = '        print(f"[info] Prompt: {prompt[:100]}{\'...\' if len(prompt) > 100 else \'\'}", flush=True)';
        $L[] = '        t0 = time.monotonic()';
        $L[] = '        session = uuid.uuid4().hex';
        $L[] = '        try:';
        $L[] = '            output = runs.loop.run_until_complete(run(prompt, session))';
        $L[] = '        finally:';
        $L[] = '            if _GRAPH is not None:   # a run\'s conversation is not kept, so memory stays flat';
        $L[] = '                _GRAPH.checkpointer.delete_thread(session)';
        $L[] = '        if output:';
        $L[] = '            print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)';
        $L[] = '            saved = _save_output(output)';
        $L[] = '            print("\\n" + "=" * 74 + "\\nRUN SUMMARY\\n" + "-" * 74, flush=True)';
        $L[] = '            print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)';
        $L[] = '            print(f"  Final output: {len(output)} chars", flush=True)';
        $L[] = '            print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)';
        $L[] = '            print("=" * 74, flush=True)';
        $L[] = '        return output';
        $L[] = '';
        $L[] = '    match CronExpression.from_cli(ap, a.cron, DEFAULT_CRON):';
        $L[] = '        case None:';
        $L[] = '            if not run_once():';
        $L[] = '                print("[info] The run ended without output.", flush=True)';
        $L[] = '        case expr:';
        $L[] = '            run_cron(expr, run_once, drains=False, loop=runs)   # a swarm has no code nodes';
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * Module-docstring body for workflow.py, swarm mode: the COMPILED
     * topology (members in create_swarm() order, the default active agent
     * and why, the full mesh, session resume) rather than the canvas. A
     * swarm has no topological layers and no dispatcher menu, so
     * EXECUTION ORDER and a GRAPH EDGES list (which, for a swarm, is only
     * ever the Start fan-out that decided membership -- not the running
     * topology) are dropped entirely rather than reused with a caveat.
     *
     * $members is nid => layout entry, already built by the caller in
     * create_swarm()'s own order (Start's fan-out order) -- read here, never
     * recomputed, so the header and the code that follows it can never
     * disagree about order.
     */
    private function swarmWorkflowDocBody(array $facts, array $members): string
    {
        $rw = $facts['swarm'];
        $entryId = (string) $rw['entry'];
        $entryName = (string) ($rw['agents'][$entryId]['name'] ?? '');

        $L = [];
        $L[] = 'PROVENANCE';
        $L[] = '==========';
        $L[] = "  Workflow:   {$facts['wfName']} (id {$facts['workflowId']})";
        $L[] = '  Target:     LangGraph swarm (Python) -- create_swarm() over one create_react_agent() per member';
        $L[] = '  Generated:  ' . date('Y-m-d H:i:s T') . ' by the SynergyAI workflow editor';
        $L[] = '  This file is a frozen snapshot of the workflow. Edits made here are';
        $L[] = '  overwritten by the next Generate: change the workflow in the editor and';
        $L[] = '  re-generate instead.';
        $L[] = '';
        $L[] = 'TOPOLOGY  (the compiled swarm this file builds -- not the canvas)';
        $L[] = '========';
        $L[] = '  Members, in the order create_swarm() receives them:';
        foreach ($members as $nid => $e) {
            $L[] = sprintf('    %-6s %-24s %s', $nid, $e['display'], $e['file']);
        }
        $L[] = "  Default active agent: {$entryName} -- the first agent Start connects to.";
        $L[] = '  Every member can hand the conversation to every other member: a full mesh,';
        $L[] = '  not the list of canvas edges off Start (those decide membership only, not';
        $L[] = "  this topology). Each member's own agents/<name>.py documents who it can";
        $L[] = '  hand to and why.';
        $L[] = '  common.py holds the runtime they share; api.py is the unmodified run server.';
        $L[] = '  A `session` passed to POST /runs (api.py) resumes this exact conversation --';
        $L[] = '  same transcript, same active agent picking up where it left off. Omitting it';
        $L[] = '  starts a fresh one.';
        $L[] = '';
        $L[] = 'TO RUN';
        $L[] = '======';
        $L[] = '  # Requires Python 3.10+ (the generated code uses match statements)';
        $L[] = '  pip install langchain langchain-anthropic langchain-openai langgraph langgraph-swarm httpx pydantic python-dotenv';
        $keys = [];
        foreach ($members as $nid => $e) {
            $def = $facts['agentData'][$nid] ?? null;
            if ($def === null) {
                continue;
            }
            $k = PythonEmitHelpers::providerKeyEnv((string) ($def['provider'] ?? ''));
            if ($k !== null) {
                $keys[$k][] = strtolower((string) $def['provider']);
            }
        }
        if ($keys) {
            $L[] = '  # API keys read from ../../.env for the providers this swarm uses:';
            foreach ($keys as $k => $provs) {
                $L[] = "  #   {$k} (" . implode(', ', array_unique($provs)) . ')';
            }
        } else {
            $L[] = '  # No LLM provider is used by a member of this swarm.';
        }
        $L[] = '  python workflow.py "your prompt here"';
        foreach (self::cronDocLines($facts, 'workflow.py') as $cl) {
            $L[] = '  ' . $cl;
        }
        if (!empty($facts['missing'])) {
            $L[] = '  # WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' . self::pythonListRepr($facts['missing']);
        }
        $storageOn = $facts['workflow']->isOutputStorageEnabled();
        $folder = $facts['workflow']->getOutputFolder();
        $L[] = '  # Output storage (Output node setting): ' . ($storageOn
            ? 'ON -> ' . (($folder ?? '') !== '' ? $folder : 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)')
            : 'OFF (the result is printed, not saved)');
        return implode("\n", $L);
    }

    /** One sentence per SwarmRewriter refusal code, close to the editor's copy (frontend/assets/i18n/en.json workflow.swarmError.*). Developer-facing: not i18n'd. */
    private static function swarmRefusalMessage(string $code): string
    {
        switch ($code) {
            case 'start_needs_two_agents':
                return 'A swarm needs two or more agents connected directly to Start; this canvas has fewer than two.';
            case 'dispatcher_in_swarm':
                return 'An agent is tagged Dispatcher, which has no meaning in a swarm -- every member routes for itself. Remove the Dispatcher tag and connect the agent to Start directly.';
            case 'agent_not_on_start':
                return 'This agent is not connected to Start, so it is not part of the swarm. Connect it to Start, or remove it.';
            case 'duplicate_agent_names':
                return 'Two agents share a name. A handoff names its target, so the swarm could not tell them apart -- rename one.';
            case 'multiple_outputs':
                return 'This workflow has more than one Output node. A swarm produces one answer.';
            case 'playbook_unsupported':
                return 'This workflow contains a Playbook node, which swarm mode does not support yet.';
            default:
                return "This workflow cannot run as a swarm ({$code}).";
        }
    }

    /** Modular mode: workflow.py, common.py, the package marker, then one module per agent/playbook node. */
    private function generateModular(array $facts): array
    {
        $layout = self::modularLayout($facts);
        // The package carries what it runs on (spec 2026-10-15 §5): read from the original facts, then
        // START_DOCUMENTS points at the copies and each code node at its code/ file.
        $package = LangGraphPackage::files($facts, $this->skillsRoot, $this->startDocuments);
        $facts['startDocuments'] = LangGraphPackage::startDocuments($facts['startDocuments'] ?? [], $this->startDocuments)['docs'];
        $codeFiles = [];
        foreach ($facts['codeData'] as $nid => $cd) {
            $codeFiles[(string) $nid] = LangGraphPackage::codeFile((string) $nid, $cd, (string) $nid === $facts['triggerNodeId']);
            $facts['codeData'][$nid]['source_file'] = $codeFiles[(string) $nid]['path'];
        }
        $files = [
            ['path' => 'workflow.py', 'code' => $this->emitModularWorkflow($facts, $layout)],
            ['path' => 'common.py', 'code' => $this->emitModularCommon($facts, $layout, true)],
            ['path' => 'api.py', 'code' => $this->emitModularApi($facts, $layout)],
            ['path' => 'agents/__init__.py', 'code' => '"""Agent modules of workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                . " -- one per agent/playbook node.\n\nEach module exposes NODE (the frozen editor settings) and\nrun_node = make_node(NODE).run (common.py's Node classes), which workflow.py\ncalls from its graph as run_node(request_text, trace).\n\"\"\"\n"],
        ];
        foreach ($layout['agents'] as $nid => $e) {
            $files[] = ['path' => $e['file'], 'code' => $this->emitModularAgentFile($facts, $layout, (string) $nid)];
        }
        array_push($files, ...array_values($codeFiles), ...$package);
        return self::withArchitecture(['root' => $layout['root'], 'files' => $files], $facts, 'modular');
    }

    /**
     * A multi-file result plus its ARCHITECTURE.md (architectureDoc()): under
     * 'architecture' for a caller that only shows it, and as the last file so
     * it is written beside the code wherever the package is saved. With no doc
     * (ingestion, or it failed to build) 'architecture' is null and the files
     * are the code alone.
     */
    private static function withArchitecture(array $result, array $facts, string $mode): array
    {
        $doc = self::architectureDoc($facts, $mode);
        if ($doc !== null) {
            $result['files'][] = ['path' => 'ARCHITECTURE.md', 'code' => $doc];
        }
        $result['architecture'] = $doc;
        return $result;
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
     * "# API keys read from <envPath> for the providers this workflow uses"
     * lines shared by commonPyDocBody() and apiPyDocBody() -- both files list
     * the same providers because both are shared across every node. Reads
     * provider straight off agentData/playbookData rather than through
     * a2aDocNodes()/modularDocNodes(): every entry in either array is by
     * construction a node with a provider (Start/Output never appear there),
     * so there is no "supported" filter to reapply.
     */
    private static function providerKeyLines(array $facts, string $envPath): array
    {
        $keys = [];
        foreach ($facts['agentData'] as $ad) {
            if (($ad['provider'] ?? '') === '') continue;
            $k = PythonEmitHelpers::providerKeyEnv($ad['provider']);
            if ($k !== null) $keys[$k][] = strtolower($ad['provider']);
        }
        foreach ($facts['playbookData'] as $pd) {
            if (($pd['provider'] ?? '') === '') continue;
            $k = PythonEmitHelpers::providerKeyEnv($pd['provider']);
            if ($k !== null) $keys[$k][] = strtolower($pd['provider']);
        }
        if (!$keys) {
            return ['  # No LLM provider is used by a runnable node of this workflow.'];
        }
        $L = ["  # API keys read from {$envPath} for the providers this workflow uses:"];
        foreach ($keys as $k => $provs) $L[] = "  #   {$k} (" . implode(', ', array_unique($provs)) . ')';
        return $L;
    }

    /**
     * common.py's own module-docstring body. This file has no graph data and no
     * nodes -- it is the shared runtime imported by workflow.py and every
     * agent module -- so workflowDocBlock()'s GRAPH NODES/EDGES/EXECUTION
     * ORDER dump described nothing that lives here. PROVENANCE keeps the
     * exact shape every generated file's docstring opens with
     * (workflowDocBlock()'s); PROVIDES is read off the blocks emitted below
     * by emitModularCommon(), not invented -- if a name is added or removed
     * down there, update this list to match.
     */
    private function commonPyDocBody(array $facts): string
    {
        $L = [];
        $L[] = 'PROVENANCE';
        $L[] = '==========';
        $L[] = "  Workflow:   {$facts['wfName']} (id {$facts['workflowId']})";
        $L[] = '  Target:     LangGraph modular shared runtime (Python) -- imported by workflow.py and every agent module';
        $L[] = '  Generated:  ' . date('Y-m-d H:i:s T') . ' by the SynergyAI workflow editor';
        $L[] = '  This file is a frozen snapshot of the workflow. Edits made here are';
        $L[] = '  overwritten by the next Generate: change the workflow in the editor and';
        $L[] = '  re-generate instead.';
        $L[] = '';
        $L[] = 'SHARED RUNTIME  (no graph, no nodes -- this is a library, not a workflow file)';
        $L[] = '==============';
        $L[] = '  Imported by workflow.py and every module under agents/. Emitted byte-';
        $L[] = '  identical for the DAG (modular) and swarm packages -- both import this';
        $L[] = '  exact file, so a change here reaches every node of either shape at the';
        $L[] = '  next Generate. (The A2A package does not import it: an A2A agent file';
        $L[] = '  copies what it needs into its own process instead.)';
        $L[] = '';
        $L[] = 'PROVIDES  (top-level names this file defines, in source order)';
        $L[] = '========';
        $L[] = '  _make_llm()                     provider/model -> LangChain chat model';
        $L[] = '                                   (claude, openai, gemini, grok, deepseek, kimi, glm)';
        $L[] = '  MCP_SERVERS, TOOL_CATALOG       this workflow\'s MCP servers + tool schemas, baked at generation time';
        $L[] = '  McpClient, MCP                  the MCP JSON-RPC client: handshake (endpoint remembered), tools/call, JSON or SSE replies; one reused HTTP client';
        $L[] = '  ToolCatalog, TOOLS              TOOL_CATALOG -> {name: StructuredTool}, calling out over MCP JSON-RPC; built once, each node takes its own by name';
        $L[] = '  SkillRuntime, SKILLS            folder-backed skills: run_skill_script, the per-skill tool, a skill as a mandatory node step';
        $L[] = '  RunEvents, EVENTS               how a run\'s events reach api.py; EVENTS.emit() is a no-op with no sink installed;';
        $L[] = '                                   also the human-gate rendezvous a playbook node\'s tools wait on';
        $L[] = '  set_event_sink, emit_event,';
        $L[] = '  resolve_gate                    EVENTS\' methods under their old names, for api.py and the run-server probes';
        // dispatcherBlock() is emitted for every workflow (DispatcherNode names Dispatcher);
        // only the adapter classes depend on the protocols the dispatchers use.
        $adapters = array_map(fn(string $p) => LangGraphRuntime::ADAPTER_CLASSES[$p] . ',',
            self::decisionProtocolsUsed($facts['agentData'] ?? []));
        $L[] = '  ' . implode(' ', array_merge(['DecisionResult,'], $adapters));
        $L[] = '  DECISION_ADAPTERS, RouteDecision,';
        $L[] = '  Dispatcher                      a DISPATCHER node\'s routing: a decision model or one forced route_to call, never both';
        $L[] = '  inject_datetime()               prepends a dated header, resolves [date]/[weekday]/[year]/[time] in a system prompt';
        if ($facts['playbookData'] !== []) {
            $L[] = '  PLAYBOOK_SYSTEM_PROMPT,';
            $L[] = '  GATE_BRIDGE, PlaybookRun,';
            $L[] = '  PlaybookToolset                 the playbook interpreter (this workflow has playbook nodes)';
        }
        $L[] = '  Node, AgentNode, DispatcherNode,';
        if ($facts['playbookData'] !== []) {
            $L[] = '  PlaybookNode,';
        }
        $L[] = '  NodeKind, make_node()           one Node subclass per node kind; every agent module is its NODE + make_node(NODE).run';
        $L[] = '  WFState, build_context()        the graph state type and per-node input builder (used by WorkflowGraph)';
        $L[] = '  DocumentConverter / DOCUMENTS   Start-node attachment -> Markdown, one method per format (lazy imports, text formats verbatim)';
        $L[] = '  WorkflowGraph                   the LangGraph StateGraph over workflow.py\'s EDGES/ORDER/NODE_TYPES and its node runner';
        $L[] = '  save_output(),';
        $L[] = '  print_run_summary()             the Output node\'s storage rule and the closing RUN SUMMARY (workflow.py\'s CLI)';
        $L[] = '';
        $L[] = 'CONFIGURATION';
        $L[] = '=============';
        $L[] = '  load_dotenv() resolves python/.env -- two directories above this file --';
        $L[] = '  at import time, before workflow.py or any agent module reads a provider';
        $L[] = '  key, so importing this module alone (a test, a REPL) still finds them. No';
        $L[] = '  key is checked here: building a chat model succeeds either way, and the';
        $L[] = '  underlying provider SDK raises at the first real request if a required key';
        $L[] = '  is missing or empty.';
        $L[] = '';
        $L[] = 'TO RUN';
        $L[] = '======';
        $L[] = '  # Requires Python 3.10+ (the generated code uses match statements)';
        $L[] = '  pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv';
        $L = array_merge($L, self::providerKeyLines($facts, '../../.env'));
        $L[] = '  imported, not run directly -- see workflow.py';
        $L[] = '  # Everything here is shared: change it once and every node of this workflow follows.';
        $L[] = '  # Output storage (Output node setting): OFF (the result is printed, not saved)';
        return implode("\n", $L);
    }

    /**
     * api.py's own module-docstring body, shared by the modular/swarm run
     * server (emitModularApi()) and the A2A one (emitA2AApi()) -- both speak
     * the exact same run protocol (RunServerEmitter::runtimeBlock()), so both
     * get the same HTTP SURFACE / SSE FRAMES / RECONNECT / SESSION sections;
     * only the PROVENANCE target line and the TO RUN deps/extra notes differ,
     * which callers pass in. Content here (routes, frame shape, event names)
     * is read off RunServerEmitter::runtimeBlock()'s emitted code, not invented.
     */
    private function apiPyDocBody(array $facts, string $target, string $deps, array $extraNotes): string
    {
        $L = [];
        $L[] = 'PROVENANCE';
        $L[] = '==========';
        $L[] = "  Workflow:   {$facts['wfName']} (id {$facts['workflowId']})";
        $L[] = "  Target:     {$target}";
        $L[] = '  Generated:  ' . date('Y-m-d H:i:s T') . ' by the SynergyAI workflow editor';
        $L[] = '  This file is a frozen snapshot of the workflow. Edits made here are';
        $L[] = '  overwritten by the next Generate: change the workflow in the editor and';
        $L[] = '  re-generate instead.';
        $L[] = '';
        $L[] = 'RUN SERVER  (no graph, no nodes -- it has never heard of either)';
        $L[] = '==========';
        $L[] = '  Speaks the run protocol the SynergyAI workflow editor uses to start a run';
        $L[] = '  and stream its progress. The graph itself lives elsewhere -- workflow.py';
        $L[] = '  (modular/swarm) or orchestrator.py (A2A) -- this file only drives and';
        $L[] = '  observes it (set_event_sink) over HTTP.';
        $L[] = '';
        $L[] = 'HTTP SURFACE';
        $L[] = '============';
        $L[] = '  GET  /.well-known/workflow.json     identity: {workflow_id, name, version, protocol}';
        $L[] = '  POST /runs                          {prompt, session} -> {run_id, status}; starts the run';
        $L[] = '                                       as a background task -- does not itself stream';
        $L[] = '  GET  /runs/{run_id}/events           text/event-stream -- see SSE FRAMES below';
        $L[] = '  POST /runs/{run_id}/tool-result      {tool_call_id, ...answer} -- answers a playbook\'s human gate';
        $L[] = '';
        $L[] = 'SSE FRAMES';
        $L[] = '==========';
        $L[] = '  Each frame is  id: <seq>\\nevent: <name>\\ndata: <json>\\n\\n .  `id:` is the';
        $L[] = '  sequence number a reconnecting client echoes back as Last-Event-ID.';
        $L[] = '  Event names: "message" (one run event forwarded from the graph\'s sink --';
        $L[] = '  its payload can itself be {"type": "truncated", ...} instead of a real';
        $L[] = '  event; see RECONNECT), "done" (terminal -- carries output + seconds) and';
        $L[] = '  "error" (terminal -- carries the exception text).';
        $L[] = '';
        $L[] = 'RECONNECT';
        $L[] = '=========';
        $L[] = '  Every published frame is kept in a per-run ring buffer (500 frames) for';
        $L[] = '  replay. A client that reconnects sends Last-Event-ID; the stream replays';
        $L[] = '  everything after it -- or, if the gap outran the ring, one "truncated"';
        $L[] = '  message first -- before resuming live. That is what lets a dropped client';
        $L[] = '  pick a run back up instead of losing it.';
        $L[] = '';
        $L[] = 'SESSION';
        $L[] = '=======';
        $L[] = '  The `session` field on POST /runs is forwarded to run_workflow() as the';
        $L[] = '  conversation to resume: the same value on a later POST /runs continues';
        $L[] = '  that thread on the checkpointer; omitting it starts a fresh one. Only the';
        $L[] = '  swarm target\'s run() actually reads it -- a DAG run() (modular or A2A)';
        $L[] = '  accepts the parameter and ignores it, so a caller can pass the same';
        $L[] = '  session to any target without knowing which one is behind this server.';
        $L[] = '';
        $L[] = 'TO RUN';
        $L[] = '======';
        $L[] = '  # Requires Python 3.10+ (the generated code uses match statements)';
        $L[] = '  ' . $deps;
        $L = array_merge($L, self::providerKeyLines($facts, '../../.env'));
        $L[] = '  python api.py --port 8710        # then open the workflow from the editor';
        foreach ($extraNotes as $n) $L[] = '  ' . $n;
        $L[] = '  # Output storage (Output node setting): OFF (the result is printed, not saved)';
        return implode("\n", $L);
    }

    /**
     * Module-docstring body shared by the three file kinds. $nid marks one node
     * as "<== this module" (agent modules); pass null for workflow.py/common.py.
     */
    private function modularDocBody(array $facts, array $layout, string $target, array $run, ?string $nid = null, bool $storage = false, ?string $dataFlow = null): string
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
            // $dataFlow is null for every existing (modular/workflow) caller, so
            // this is additive: swarm's emitters are the only ones that pass a
            // DATA FLOW paragraph of their own (run_node()/dispatcher/playbook
            // prose does not describe a swarm, which has none of those).
            'data_flow' => $dataFlow ?? self::modularDataFlowDoc(),
            'run' => ['extra' => array_merge((array) ($run['extra'] ?? []), self::decisionDocLines($facts['agentData'] ?? []), self::mcpHeaderDocLines($facts))] + $run,
            'storage' => $storage
                ? ['enabled' => $facts['workflow']->isOutputStorageEnabled(), 'folder' => $facts['workflow']->getOutputFolder(),
                   'default' => 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)']
                : ['enabled' => false, 'folder' => null],
        ]);
    }

    /** DATA FLOW text shared by every file of a modular package. */
    private static function modularDataFlowDoc(): string
    {
        return <<<'TXT'
This workflow is one Python package, run in ONE process. workflow.py owns the
graph data; common.py's WorkflowGraph frames each node's input (original prompt
+ labelled parent outputs) and calls that node's module through workflow.py's
node runner. agents/<name>.py holds one node's frozen settings
(NODE) and exposes run_node = make_node(NODE).run, called as
run_node(request_text, trace) -> {"text", "route", "notes", "status"}. The node
logic lives in common.py's Node classes, one per kind: an AGENT node (AgentNode)
= LangChain ReAct loop over its MCP tools plus mandatory skill steps; a
DISPATCHER node (DispatcherNode) = Jev or one forced route_to call, whose choice
comes back as "route" and drives a conditional edge, so only the chosen child
runs; a PLAYBOOK node (PlaybookNode) = the playbook runtime, whose transcript is
the text. common.py holds everything they share -- LLM factory, MCP client, tool
builder, skills, dispatcher and playbook runtimes, the Node classes -- imported
once instead of copied per node.
TXT;
    }

    /**
     * common.py: the shared runtime library, WorkflowGraph included. No graph data, no node definitions.
     *
     * $packaged: a package with its own files (LangGraphPackage): code nodes import code_harness.py;
     * skills, outputs and scratch default to folders of the package. The modular and swarm paths
     * both pass it, so their common.py stay byte-identical.
     */
    private function emitModularCommon(array $facts, array $layout, bool $packaged = false): string
    {
        $sep = '# ' . str_repeat('=', 62);
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $L = [];
        $L[] = '"""Shared runtime for workflow ' . json_encode($facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L[] = '';
        $body = $this->commonPyDocBody($facts);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $withPlaybooks = $facts['playbookData'] !== [];
        $L[] = 'import asyncio, json, os, re, subprocess, sys, threading, time, uuid' . ($facts['codeData'] !== [] && !$packaged ? ', types' : '');
        $L[] = 'from abc import ABC, abstractmethod';
        $L[] = 'from dataclasses import asdict, dataclass, field';
        $L[] = 'from datetime import datetime';
        $L[] = 'from enum import Enum';
        $L[] = 'from functools import cached_property';
        $L[] = 'from pathlib import Path';
        $L[] = 'from typing import Annotated, Awaitable, Callable, Literal, TypedDict';
        $L[] = '';
        $L[] = 'from dotenv import load_dotenv';
        $L[] = '# This file lives in <root>/; the runner .env is two levels up (python/.env).';
        $L[] = '# Loaded here rather than in workflow.py so a module imported on its own';
        $L[] = '# (a test, a REPL) still finds the provider keys.';
        $L[] = '_HERE = os.path.dirname(os.path.abspath(__file__))';
        $L[] = 'load_dotenv(os.path.join(_HERE, ".env"))   # the workflow folder\'s own .env first (never overridden)';
        $L[] = 'RUNNER_DIR = os.path.dirname(os.path.dirname(_HERE))   # the runner env folder (python/)';
        $L[] = 'load_dotenv(os.path.join(RUNNER_DIR, ".env"))';
        $L[] = 'DEBUG_STEM = os.path.basename(_HERE)   # the package folder names the agents\' outputs/_debug dumps';
        $L[] = 'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # the package folder: code/, skills/, outputs/, start_documents/';
        $L[] = '';
        $L[] = 'import httpx';
        $L[] = 'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage';
        $L[] = 'from langchain_core.tools import StructuredTool';
        $L[] = 'from langgraph.graph import END, START, StateGraph';
        $L[] = 'try:';
        $L[] = '    from langchain.agents import create_agent as create_react_agent';
        $L[] = 'except ImportError:';
        $L[] = '    from langgraph.prebuilt import create_react_agent';
        $L[] = 'from pydantic import Field, create_model';
        $L[] = '';
        $L[] = "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()";
        $L[] = '';
        $L[] = $sep;
        $L[] = '# LLM FACTORY';
        $L[] = '# Provider/model -> LangChain chat model. Every node calls this with its';
        $L[] = '# own baked settings, so one workflow can mix providers.';
        $L[] = $sep;
        $L[] = LangGraphRuntime::llmFactoryBlock();
        $L[] = '';
        $L[] = $sep;
        $L[] = '# MCP SERVER REGISTRY + TOOL CATALOG (every tool this workflow uses)';
        $L[] = '# Baked at generation time. An agent module names the tools it may use';
        $L[] = '# in NODE["tool_names"]; the catalog itself is shared.';
        $L[] = $sep;
        $L[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($facts['usedServers'], true);
        if ($facts['codeData'] !== []) {
            $L[] = 'MCP_SLUGS = ' . PythonEmitHelpers::jsonToPython($facts['codeSlugs'], true);
        }
        $L[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($facts['usedCatalog'], true);
        $L[] = '';
        $L[] = $sep;
        $L[] = '# MCP CLIENT -- JSON-RPC 2.0 over HTTP';
        $L[] = $sep;
        $L[] = self::serverSlugsLine($facts['serverSlugs'] ?? []);
        $L[] = '';
        $L[] = LangGraphRuntime::mcpClientBlock();
        if ($facts['codeData'] !== []) {
            $L[] = LangGraphRuntime::codeHarnessBlock($packaged);
            $L[] = '';
        }
        $L[] = $sep;
        $L[] = '# TOOL BUILDER + SKILL RUNTIME';
        $L[] = $sep;
        $L[] = LangGraphRuntime::toolCatalogBlock() . LangGraphRuntime::skillRuntimeBlock($packaged);
        $L[] = LangGraphRuntime::runEventsBlock();
        $L[] = $sep;
        $L[] = '# DISPATCHER RUNTIME';
        $L[] = $sep;
        $L[] = LangGraphRuntime::dispatcherBlock(self::decisionProtocolsUsed($facts['agentData'] ?? []));
        $L[] = self::datetimeInjectorBlock();
        if ($withPlaybooks) {
            $L[] = LangGraphRuntime::playbookBlock();
        }
        $L[] = LangGraphRuntime::nodeClassesBlock($withPlaybooks, $facts['codeData'] !== []);
        $L[] = '';
        $L[] = $sep;
        $L[] = '# GRAPH STATE + CONTEXT BUILDING (used by WorkflowGraph)';
        $L[] = $sep;
        $L[] = self::stateBlock();
        $L[] = '';
        $L[] = self::contextBuilderBlock();
        $L[] = $sep;
        $L[] = '# ATTACHMENT CONVERTER (Start-node documents)';
        $L[] = $sep;
        $L[] = LangGraphRuntime::documentConverterBlock();
        $L[] = LangGraphRuntime::runRecordBlock();
        $L[] = LangGraphRuntime::liveFeedBlock();
        $L[] = LangGraphRuntime::consoleBlock();
        $L[] = LangGraphRuntime::workflowGraphBlock();
        $L[] = LangGraphRuntime::outputBlock($packaged);
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * api.py: the run server — the graph behind POST /runs + an SSE event stream. With $listen (the
     * modular package; plan task 8) it also runs the Start's cron / watch loop: POST /listen, GET /live
     * and --listen, over workflow.py's make_listener(). A swarm's workflow.py has none, so it passes false.
     */
    private function emitModularApi(array $facts, array $layout, bool $listen = true): string
    {
        $esc = fn(string $s): string => str_replace(['\\', '"""'], ['\\\\', str_repeat("'", 3)], $s);
        $body = $this->apiPyDocBody($facts,
            'LangGraph modular run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            'pip install fastapi uvicorn langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
            array_merge(['# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
             '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
             '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)'], $listen ? [
             '#',
             "#   python api.py --listen    # also run the Start's schedule / event trigger (POST /listen toggles it;",
             '#                             # GET /live streams the runs and the listener\'s state)'] : []));
        return RunServerEmitter::emit(
            $facts['wfName'],
            $esc($body),
            'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
            'WORKFLOW_VERSION = ' . PythonEmitHelpers::pyStr(self::a2aVersion($facts)),
            $listen
        );
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
        $def = match ($kind) {
            'playbook' => $facts['playbookData'][$nid],
            'code' => $facts['codeData'][$nid],
            default => $facts['agentData'][$nid],
        };
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
             'extra' => ["# Exposes NODE (frozen editor settings) and run_node = make_node(NODE).run; the node logic is common.py's Node classes."],
             'env_path' => '../../../.env'], $nid);
        foreach (explode("\n", $esc($body)) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = '# The shared runtime lives in common.py, one directory up. Python puts the';
        $L[] = "# workflow folder on sys.path when workflow.py starts, so this resolves for";
        $L[] = '# every module of the package.';
        $L[] = 'from common import make_node';
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
        $defLines = $kind === 'code'
            ? self::codeNodeDefinitionLines($nid, $def)
            : $this->nodeDefinitionLines($facts, $nid, $kind, $entry['display'], $def, $isPlaybook);
        foreach (explode("\n", $defLines) as $nl) {
            $L[] = $nl;
        }
        $L[] = '';
        $L[] = "# The node logic lives in common.py's Node classes: make_node(NODE) builds the";
        $L[] = "# subclass for this NODE's kind, and workflow.py calls its run(request_text, trace).";
        $L[] = 'run_node = make_node(NODE).run';
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /** A code node's frozen settings (the NODE literal of a module, or an entry of CODE_NODES). */
    private static function codeNodeDefinitionLines(string $nid, array $cd, string $opener = 'NODE = {', string $indent = ''): string
    {
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L = [];
        $L[] = $indent . $opener;
        $L[] = $indent . '    "id": ' . $j($nid) . ',';
        $L[] = $indent . '    "kind": "code",';
        $L[] = $indent . '    "display": ' . $j($cd['display']) . ',';
        $L[] = $indent . '    "exits": ' . $j($cd['exits']) . ',';
        $L[] = $indent . '    "mcp_servers": ' . $j($cd['mcp_servers']) . ',';
        $L[] = $indent . '    "timeout_s": ' . (int) $cd['timeout_s'] . ',';
        $L[] = $indent . '    "exit_targets": ' . $j((object) $cd['exit_targets']) . ',';
        // The modular package reads the code from its file at each run (an edit takes effect on the
        // next run); the single file embeds it.
        $L[] = isset($cd['source_file'])
            ? $indent . '    "source_file": ' . $j($cd['source_file']) . ',   # relative to the package folder'
            : $indent . '    "source": ' . $j($cd['source']) . ',';
        $L[] = $indent . '}' . ($indent !== '' ? ',' : '');
        return implode("\n", $L);
    }

    /**
     * The `NODE = {...}` literal shared by the A2A agent files and the modular
     * agent modules: the node's editor settings, frozen. The single file emits
     * its AGENTS / PLAYBOOKS entries through here too ($opener `"<id>": {`,
     * $indent four spaces), so every mode bakes the same keys, and the prompt
     * text verbatim (the model gets the same text in every mode).
     */
    private function nodeDefinitionLines(array $facts, string $nid, string $kind, string $display, array $def, bool $isPlaybook,
                                         string $opener = 'NODE = {', string $indent = ''): string
    {
        $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        // Text inside a triple-quoted string is emitted as is: indenting it would change the prompt.
        $verbatim = fn(string $text): array => explode("\n", str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], $text));
        $L = [];
        $L[] = $indent . $opener;
        $L[] = $indent . '    "id": ' . $j($nid) . ',';
        $L[] = $indent . '    "kind": ' . $j($kind) . ',';
        $L[] = $indent . '    "display": ' . $j($display) . ',';
        $L[] = $indent . '    "provider": ' . $j($def['provider']) . ',';
        $L[] = $indent . '    "model": ' . $j($def['model']) . ',';
        $L[] = $indent . '    "temperature": ' . json_encode((float) $def['temperature']) . ',';
        $L[] = $indent . '    "max_tokens": ' . (int) $def['max_tokens'] . ',';
        $L[] = $indent . '    "thinking": ' . (in_array($def['thinking'] ?? null, ['on', 'off'], true) ? '"' . $def['thinking'] . '"' : 'None')
            . ',  # node form Thinking attribute';
        if ($isPlaybook) {
            $L[] = $indent . '    "title": ' . $j($def['title']) . ',';
            $L[] = $indent . '    "domain": ' . $j($def['domain']) . ',';
            $L[] = $indent . '    "writes_enabled": ' . ($def['writes_enabled'] ? 'True' : 'False') . ',';
            $L[] = $indent . '    "policy": ' . PythonEmitHelpers::jsonToPython($def['policy'], true) . ',';
            $L[] = $indent . '    "approvers": ' . PythonEmitHelpers::jsonToPython($def['approvers'], true) . ',';
            $L[] = $indent . '    "requester": ' . PythonEmitHelpers::jsonToPython($def['requester'], true) . ',';
            $L[] = $indent . '    "instructions": """';
            array_push($L, ...$verbatim($def['instructions']));
            $L[] = '""",';
            $L[] = $indent . '    "actions": ' . PythonEmitHelpers::jsonToPython($def['actions'], false) . ',';
        } else {
            $L[] = $indent . '    "system_prompt": """';
            array_push($L, ...$verbatim($def['system_prompt']));
            $L[] = '""",';
            $L[] = $indent . '    "tool_names": ' . $j(array_values($def['tool_names'])) . ',';
            // Ordered skill bindings ([{"dir": "..."}] / [{"inline": "..."}]) — the node
            // runs each as a mandatory post-agent step; the last produces the node output.
            $L[] = $indent . '    "skills": ' . $j($def['skills'] ?? []) . ',';
            // Dispatcher menu: the node calls route_to over these names and only
            // the chosen child runs (conditional edge in WorkflowGraph).
            $L[] = $indent . '    "dispatch": ' . self::dispatchMenuLiteral($def['dispatch'] ?? []) . ',';
            $L[] = $indent . '    "decision_question": ' . PythonEmitHelpers::pyStr((string) ($def['decision_question'] ?? '')) . ',';
            $L[] = $indent . '    "routing_mode": ' . PythonEmitHelpers::pyStr((string) ($def['routing_mode'] ?? '')) . ',';
            $L[] = $indent . '    "unclear_branch": ' . PythonEmitHelpers::pyStr((string) ($def['unclear_branch'] ?? '')) . ',';
            $L[] = $indent . '    "min_confidence": ' . self::pyFloor($def) . ',';
            $L[] = $indent . '    "decision": ' . self::decisionLiteral($def['decision'] ?? []) . ',';
        }
        // An entry inside a dict literal (the single file's AGENTS / PLAYBOOKS) ends with a comma.
        $L[] = $indent . '}' . ($indent !== '' ? ',' : '');
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
             'extra' => array_merge(!empty($facts['missing'])
                 ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' . self::pythonListRepr($facts['missing'])]
                 : [], self::modeDocLines('workflow.py'), self::cronDocLines($facts, 'workflow.py'), self::watchDocLines($facts, 'workflow.py')),
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
        $L[] = '  common.py holds the runtime they share and the WorkflowGraph; Start and Output run there, with no LLM.';
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, re, signal, sys, time';
        $L[] = 'from datetime import datetime, timedelta';
        $L[] = 'from typing import Callable';
        $L[] = '';
        $L[] = '# Running this file puts its own folder on sys.path, so `common` and the';
        $L[] = '# `agents` package below resolve wherever the workflow folder is copied.';
        $L[] = 'from common import EVENTS, MCP, MCP_SERVER_SLUGS, NULL_RECORDER, RUN_OUT, ConsoleView, ErrorExitTaken, RunRecorder, '
            . 'WorkflowGraph, is_quiet, print_run_summary, save_output';
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
        $L[] = self::defaultCronLine($facts);
        $L[] = self::defaultWatchLine($facts);
        array_push($L, ...self::startModeLines($facts));
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
                . ', "module": ' . $j($e['module']) . ', "dispatch": ' . $j($dispatch)
                . ($e['kind'] === 'code' ? ', "exit_targets": ' . $j((object) $facts['codeData'][$nid]['exit_targets']) : '') . '},';
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
        $L[] = LangGraphRuntime::cronBlock();
        $L[] = LangGraphRuntime::watchBlock();
        $L[] = LangGraphRuntime::listenerBlock();
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
NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)
GRAPH_RECORDER = NULL_RECORDER   # the run's RunRecorder; the program sets it before each run (trace reads it)
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # this program's folder: runs/, .run.lock
RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")   # one JSONL log per run (RUNS_DIR overrides)


async def _run_node_module(nid: str, request_text: str) -> dict:
    """Run node `nid` by calling its module. Returns {"text", "route", "notes", "status"}.

    A watching host (api.py) sees the run through these events and nothing
    else: a plain agent node has no other sink, so without the round/message
    pair below a workflow of ordinary agent nodes streams an empty overlay
    until the terminal frame. Only message/tool_call/tool_result/gate_request
    actually render there; round and final carry the structure.
    """
    ad = AGENTS[nid]
    t0 = time.monotonic()
    try:
        EVENTS.emit(type="round", round=ORDER.index(nid))
    except ValueError:
        EVENTS.emit(type="round", round=0)

    async def trace(line: str):
        """Progress callback the module calls; in one process this is just a print."""
        RUN_OUT(f"[node] [{nid}] {line}")
        GRAPH_RECORDER.node_log(nid, line)

    out = await _NODE_RUNNERS[nid](request_text, trace)
    dt = time.monotonic() - t0
    # The node's whole time (model turns and skills), written once per node, so
    # the RUN SUMMARY counts each node exactly once.
    NODE_DURATIONS[ad["display"]] = dt
    RUN_OUT(f"[node] [{nid}] {ad['display']!r} done -- {len(out['text'])} chars ({dt:.1f}s)")
    # A playbook node already streamed its own transcript through the sink --
    # re-posting its answer here would double it in the overlay.
    if ad.get("kind") != "playbook" and out.get("text"):
        EVENTS.emit(type="message", text=f"**{ad['display']}**\n\n{out['text']}", sensitive=False)
    EVENTS.emit(type="final", leg=nid, status=out.get("status") or "ok")
    return out


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over the agent modules
# ==============================================================
def build_graph(recorder: RunRecorder | None = None) -> WorkflowGraph:
    """The workflow's graph (common.WorkflowGraph): agent nodes call their modules; `recorder` records the run."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents=AGENTS,
                         run_node=_run_node_module, start_documents=START_DOCUMENTS, recorder=recorder)


async def run(user_prompt: str, session: str | None = None) -> str:
    """Build the graph (agent nodes call their modules), run it, return the final output.

    `session` is accepted so this signature matches the swarm target's run()
    (api.py calls both the same way) but is ignored here: a DAG run has no
    conversation to resume -- each call is already a fresh, independent run.
    """
    return await build_graph().run(user_prompt)


def make_run_once(prompt: str, runs: RunLoop, view: ConsoleView, recorder: RunRecorder, *,
                  loop_mode: bool = False) -> Callable[[], str]:
    """The program's run_once(): one run of the workflow on `prompt`, recorded by `recorder` (its run
    log, and `view` on the console). Returns the output ('' when the run ended without one). A quiet
    run (the server's rule: a code node's non-error exit and no agent, playbook or output node)
    leaves no log and prints nothing. Raises ErrorExitTaken when a code node took its error exit,
    and whatever the run raised, once the failure is recorded.

    Console: under --cron / --watch (`loop_mode`) the view's block is the run's only output -- the
    progress lines (RUN_OUT) show only under --verbose, no FINAL OUTPUT or RUN SUMMARY; a --once
    run prints as it goes, except under --quiet (the done / failed line only)."""
    def run_once() -> str:
        """One run (see make_run_once)."""
        global GRAPH_RECORDER
        ev_loop = runs.loop   # this run's event loop, read once: drain() may give later runs a fresh one
        NODE_DURATIONS.clear()   # this run's times only (RUN SUMMARY)
        this_run = recorder.begin()
        GRAPH_RECORDER = recorder
        RUN_OUT.begin("hold" if loop_mode else "drop" if view.verbosity == "quiet" else "print")
        show_held = loop_mode and view.verbosity == "verbose"
        chatty = not loop_mode and view.verbosity != "quiet"   # FINAL OUTPUT and RUN SUMMARY
        try:
            graph = build_graph(recorder)
            output = ev_loop.run_until_complete(graph.run(prompt))
            if is_quiet(NODE_TYPES, graph.routes, graph.agents, graph.ran):
                view.discard()
                RUN_OUT.release(False)
                recorder.end(quiet=True)
                return ""
            RUN_OUT.release(show_held)
            if output:
                if chatty:
                    print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output, flush=True)
                saved = save_output(output, enabled=OUTPUT_STORAGE_ENABLED, folder=OUTPUT_FOLDER,
                                    workflow_id=WORKFLOW_ID, workflow_name=WORKFLOW_NAME)
                if chatty:
                    print_run_summary(output, saved, graph.started, NODE_DURATIONS, "Time per node (LLM + skills)")
            graph.check_error_exits()
        except BaseException as e:
            RUN_OUT.release(show_held)
            recorder.complete(success=False, error=f"{type(e).__name__}: {e}" if str(e) else type(e).__name__)
            recorder.end(quiet=False)
            raise
        finally:
            # Back to the baseline (console printing, no recorder) -- but only while this run still owns
            # them: a run abandoned at the cap that ends late must not reset the run that replaced it.
            if GRAPH_RECORDER is recorder and recorder.run_id == this_run:
                RUN_OUT.begin("print")
                GRAPH_RECORDER = NULL_RECORDER
        recorder.complete(success=True, output=output)
        recorder.end(quiet=False)
        return output
    return run_once


def _refuse(message: str):
    """make_listener's parser error: a usage error becomes a ValueError instead of an exit."""
    raise ValueError(message)


def make_listener(state: LoopState) -> Listener | None:
    """The Start's cron or watch loop for a host (api.py --listen, POST /listen), not yet started: each
    run on the Start's prompt, recorded under RUNS_DIR, printing only its done / failed line (a quiet
    run nothing). None when the Start takes a prompt (POST /runs runs it). Its lock is the program's
    own, so api.py and `python workflow.py` never listen at once. ValueError: the Start's schedule or
    trigger is missing or bad."""
    if START_MODE not in ("cron", "watch"):
        return None
    ap = argparse.ArgumentParser()
    ap.error = _refuse
    cron = CronExpression.from_cli(ap, "" if START_MODE == "cron" else None, DEFAULT_CRON)
    watch = WatchTrigger.from_cli(ap, "" if START_MODE == "watch" else None, DEFAULT_WATCH)
    runs = RunLoop()
    view = ConsoleView("quiet")
    recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])
    run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True)
    drains = any(ad["kind"] == "code" for ad in AGENTS.values())
    return Listener(START_MODE, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=state,
                    lock_path=os.path.join(PACKAGE_DIR, ".run.lock"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"LangGraph workflow {WORKFLOW_NAME!r} (agents in separate files)",
                                 allow_abbrev=False)
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    when = ap.add_mutually_exclusive_group()
    when.add_argument("--once", action="store_true", help="run once, even when the Start listens or is scheduled")
    when.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",
                      help="run on a cron schedule until Ctrl-C (default: the Start node's schedule)")
    when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER",
                      help="run whenever an MCP tool says something new arrived, until Ctrl-C "
                           "(default: the Start option's trigger; or 'server.tool {json args}')")
    talk = ap.add_mutually_exclusive_group()
    talk.add_argument("--quiet", action="store_true", help="print only each run's done / failed line")
    talk.add_argument("--verbose", action="store_true", help="also print each node's output")
    a = ap.parse_args()
    mode = choose_mode(a, START_MODE)
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)
    view = ConsoleView("quiet" if a.quiet else "verbose" if a.verbose else "normal")
    recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])
    RUN_OUT.chatty = a.verbose if mode != "once" else not a.quiet   # startup lines (tools ready)
    run_once = make_run_once(prompt, runs, view, recorder, loop_mode=mode != "once")
    drains = any(ad["kind"] == "code" for ad in AGENTS.values())
    # The mode's flag, or the Start's mode with its baked default; a bad or missing --cron / --watch
    # stops here (exit 2), before any agent starts.
    cron = CronExpression.from_cli(ap, a.cron if a.cron is not None else ("" if mode == "cron" else None), DEFAULT_CRON)
    watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)
    if mode == "once":
        RUN_OUT.once(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
        try:
            if not run_once():
                RUN_OUT.once("[info] The run ended without output (a branch ended).")
        except ErrorExitTaken as e:
            sys.exit(1 if a.quiet else f"[error] {e}")   # --quiet: the view's Failed line says it
    else:
        Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),
                 lock_path=os.path.join(PACKAGE_DIR, ".run.lock"), verbosity=view.verbosity).run_blocking()
PY;
    }

    // ---------- static Python code blocks ----------
    // These correspond to the textwrap.dedent('''...''') heredocs in the
    // Python generator. Reproduced here byte-for-byte as nowdoc strings.
    //
    // mcpClientBlock()  → LangGraphRuntime::mcpClientBlock() (LangGraph's own McpClient;
    //                      PythonEmitHelpers::mcpClientBlock() stays for ADK/MAF/NOOA)
    // toolBuilderBlock() → LangGraphRuntime::toolCatalogBlock() + skillRuntimeBlock()
    //                      (LangGraph's own copies; the shared skill blocks stay for ADK/MAF/NOOA)

    /**
     * Bake one playbook node: parse + analyze the playbook against the
     * registry ids and describe what the emitted runtime needs. Throws when
     * the playbook text is missing or has hard binding errors, like the
     * browser runner (PlaybookNodeRunner) does.
     */
    /** @see PlaybookEmit::nodeData() -- shared with every other compile target. */
    private function playbookData(array $node, array $availableById, array $providerDefaults, ?string $userId): array
    {
        return PlaybookEmit::nodeData($node, $availableById, $providerDefaults, $userId);
    }

    /**
     * A dispatcher's menu as a Python list literal: [{"id", "name", "description"}, ...].
     * One emitter for every LangGraph mode (single script AGENTS, A2A agent NODE,
     * modular module NODE) so the menu the route_to tool and Jev see cannot drift.
     */
    private static function dispatchMenuLiteral(array $targets): string
    {
        return '[' . implode(', ', array_map(
            fn($t) => '{"id": ' . PythonEmitHelpers::pyStr((string) $t['id'])
                . ', "name": ' . PythonEmitHelpers::pyStr((string) $t['name'])
                . ', "description": ' . PythonEmitHelpers::pyStr((string) ($t['description'] ?? '')) . '}',
            $targets
        )) . ']';
    }

    /**
     * A dispatcher's decision candidates as a one-line Python list literal, spaced like
     * dispatchMenuLiteral(): [{"provider": "jev", "protocol": "typesafe", ...}, ...].
     */
    private static function decisionLiteral(array $candidates): string
    {
        return '[' . implode(', ', array_map(
            fn(array $c) => '{' . implode(', ', array_map(
                fn(string $k) => '"' . $k . '": ' . PythonEmitHelpers::pyStr((string) $c[$k]),
                array_keys($c)
            )) . '}',
            $candidates
        )) . ']';
    }

    /** A dispatcher's decision-model floor as a Python float literal (0.6, 1.0, 0.85). */
    private static function pyFloor(array $ad): string
    {
        return var_export((float) ($ad['min_confidence'] ?? JevRouter::DEFAULT_CONFIDENCE_FLOOR), true);
    }

    /** MCP_SERVER_SLUGS: every MCP server URL this workflow (or this A2A node) uses -> its slug (McpClient._headers reads MCP_HEADERS_<SLUG>). */
    private static function serverSlugsLine(array $slugs): string
    {
        return 'MCP_SERVER_SLUGS = ' . PythonEmitHelpers::jsonToPython($slugs, true);
    }

    /** The .env lines a run needs for servers that take headers (values are the user's, never emitted). */
    private static function mcpHeaderDocLines(array $facts): array
    {
        $lines = [];
        foreach (array_unique(array_values($facts['serverSlugs'] ?? [])) as $slug) {
            if ($slug === '') {
                continue;
            }
            $lines[] = '# MCP_HEADERS_' . strtoupper($slug) . '={"Header": "value"}   # in .env, only if this MCP server needs headers'
                . ' (a server you connected in the editor: the header and key saved on its MCP server row)';
            $lines[] = '# MCP_URL_' . strtoupper($slug) . '=http://host:port/mcp   # in .env, only if this MCP server no longer answers at the URL compiled in';
        }
        if ($lines) {
            $lines[] = '# (one connection per MCP URL: for a second account, run a second MCP server instance on its own URL)';
        }
        return $lines;
    }

    /**
     * The decision providers a dispatcher may route with, written into the script
     * (it never reads the database): the named row, every usable row in admin order
     * for an unset mode, none for 'llm' or a key with no usable row.
     *
     * @return list<array{provider: string, protocol: string, url: string, model: string, key_env: string, url_env: string}>
     */
    private function decisionCandidates(string $mode): array
    {
        if ($mode === 'llm') {
            return [];
        }
        $out = [];
        foreach (DecisionProviders::rows($this->db) as $row) {
            $key = (string) $row['provider_key'];
            $protocol = DecisionProviders::protocolOf($row);
            if ($protocol === null || ($mode !== '' && $key !== $mode)) {
                continue;
            }
            $stem = DecisionProviders::envStem($key);
            $out[] = [
                'provider' => $key,
                'protocol' => (string) $row['protocol'],
                'url' => trim((string) ($row['base_url'] ?? '')) ?: $protocol['url'],
                'model' => trim((string) ($row['model'] ?? '')) ?: $protocol['model'],
                'key_env' => $stem . '_API_KEY',
                'url_env' => $stem . '_BASE_URL',
            ];
        }
        return $out;
    }

    /** @return list<string> protocols any dispatcher of this workflow may use (one adapter each). */
    private static function decisionProtocolsUsed(array $agentData): array
    {
        $ids = [];
        foreach ($agentData as $ad) {
            foreach ($ad['decision'] ?? [] as $c) {
                $ids[$c['protocol']] = true;
            }
        }
        return array_keys($ids);
    }

    /**
     * TO RUN note for the decision-model env vars, per provider the dispatchers may use:
     * required for a dispatcher naming that provider, optional for an unset one.
     * LangGraph-only: the other compile targets route every dispatcher with the model.
     */
    private static function decisionDocLines(array $agentData): array
    {
        $required = [];
        $optional = [];
        foreach ($agentData as $ad) {
            if (empty($ad['dispatch'])) {
                continue;
            }
            $name = str_replace(["\r", "\n"], ' ', (string) ($ad['display'] ?? ''));
            $mode = $ad['routing_mode'] ?? '';
            foreach ($ad['decision'] ?? [] as $c) {
                if ($mode === '') {
                    $optional[$c['key_env']][] = $name;
                } else {
                    $required[$c['key_env']][] = $name;
                }
            }
        }
        $lines = [];
        foreach ($required as $env => $names) {
            $lines[] = "# Required: {$env} for dispatchers (" . implode(', ', array_unique($names)) . ');';
            $lines[] = '#   without it (or when the decision model cannot decide) they do not route and the run stops there.';
        }
        foreach ($optional as $env => $names) {
            $lines[] = "# Optional: {$env} for dispatchers with no routing mode saved (" . implode(', ', array_unique($names)) . '):';
            $lines[] = '#   the first decision model whose key is set routes (else the model); once one is chosen, a request it cannot decide stops the run there (no model fallback).';
        }
        if ($required !== [] || $optional !== []) {
            $lines[] = '#   Each key has a matching <NAME>_BASE_URL (a gateway). TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.';
        }
        return $lines;
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

    /**
     * The single file's run(): its nodes live in this process, so run_node is
     * _run_local_node, and the graph itself is the shared WorkflowGraph. Then the
     * __main__ block. $missingWarning is the '[warn] Missing tools' line (or '').
     */
    private static function singleRunBlock(string $missingWarning): string
    {
        return <<<'PY'
# One Node per agent and playbook node -- provider/model come from the AGENTS
# and PLAYBOOKS dicts, which the generator baked from each node's workflow config.
# Each node builds its chat model on first use (Node.llm), not here.
NODES = {nid: make_node(cfg) for nid, cfg in {**AGENTS, **PLAYBOOKS, **CODE_NODES}.items()}
NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)
GRAPH_RECORDER = NULL_RECORDER   # the run's RunRecorder; the program sets it before each run (trace reads it)
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # this program's folder: runs/, .run.lock
RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")   # one JSONL log per run (RUNS_DIR overrides)


async def _run_local_node(nid: str, request: str) -> dict:
    """Run node `nid` in this process: its console lines are tagged [node] [nid], and the
    whole node (model turns and skills) is timed for the RUN SUMMARY."""
    node = NODES[nid]

    async def trace(line: str):
        """Progress line of this node, printed with its id."""
        RUN_OUT(f"[node] [{nid}] {line}")
        GRAPH_RECORDER.node_log(nid, line)

    t0 = time.monotonic()
    out = await node.run(request, trace)
    NODE_DURATIONS[node.display] = time.monotonic() - t0
    return out


def build_graph(recorder: RunRecorder | None = None) -> WorkflowGraph:
    """The workflow's graph over this file's nodes (AGENTS, PLAYBOOKS and CODE_NODES, run in this process);
    `recorder` records the run."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents={**AGENTS, **PLAYBOOKS, **CODE_NODES},
                         run_node=_run_local_node, start_documents=START_DOCUMENTS, recorder=recorder)


async def run(user_prompt: str, graph: WorkflowGraph | None = None) -> str:
    """Execute the workflow with the given user prompt; returns the final output text.

    Steps:
    1. Build LangChain tools from the embedded TOOL_CATALOG
    2. Run the WorkflowGraph (`graph`, else build_graph()): one Node per agent/playbook
       node, each building its own chat model on first use
    """
    RUN_OUT.once("[info] Building tools from embedded catalog...")
    catalog = TOOLS.build()   # built once here; every node then takes its own tools from TOOLS
    RUN_OUT.once(f"[info] {len(catalog)} tools ready: {sorted(catalog.keys())}")

PY . $missingWarning . <<<'PY'
    return await (graph or build_graph()).run(user_prompt)


def make_run_once(prompt: str, runs: RunLoop, view: ConsoleView, recorder: RunRecorder, *,
                  loop_mode: bool = False) -> Callable[[], str]:
    """The program's run_once(): one run of the workflow on `prompt`, recorded by `recorder` (its run
    log, and `view` on the console). Returns the output ('' when the run ended without one). A quiet
    run (the server's rule: a code node's non-error exit and no agent, playbook or output node)
    leaves no log and prints nothing. Raises ErrorExitTaken when a code node took its error exit,
    and whatever the run raised, once the failure is recorded.

    Console: under --cron / --watch (`loop_mode`) the view's block is the run's only output -- the
    progress lines (RUN_OUT) show only under --verbose, no FINAL OUTPUT or RUN SUMMARY; a --once
    run prints as it goes, except under --quiet (the done / failed line only)."""
    def run_once() -> str:
        """One run (see make_run_once)."""
        global GRAPH_RECORDER
        ev_loop = runs.loop   # this run's event loop, read once: drain() may give later runs a fresh one
        NODE_DURATIONS.clear()   # this run's times only (RUN SUMMARY)
        this_run = recorder.begin()
        GRAPH_RECORDER = recorder
        RUN_OUT.begin("hold" if loop_mode else "drop" if view.verbosity == "quiet" else "print")
        show_held = loop_mode and view.verbosity == "verbose"
        chatty = not loop_mode and view.verbosity != "quiet"   # FINAL OUTPUT and RUN SUMMARY
        try:
            graph = build_graph(recorder)
            output = ev_loop.run_until_complete(run(prompt, graph))
            if is_quiet(NODE_TYPES, graph.routes, graph.agents, graph.ran):
                view.discard()
                RUN_OUT.release(False)
                recorder.end(quiet=True)
                return ""
            RUN_OUT.release(show_held)
            if output:
                if chatty:
                    print("\n" + "=" * 60 + "\nFINAL OUTPUT\n" + "=" * 60 + "\n" + output)
                saved = save_output(output, enabled=OUTPUT_STORAGE_ENABLED, folder=OUTPUT_FOLDER,
                                    workflow_id=WORKFLOW_ID, workflow_name=WORKFLOW_NAME)
                if chatty:
                    print_run_summary(output, saved, graph.started, NODE_DURATIONS, "Time per node")
            graph.check_error_exits()
        except BaseException as e:
            RUN_OUT.release(show_held)
            recorder.complete(success=False, error=f"{type(e).__name__}: {e}" if str(e) else type(e).__name__)
            recorder.end(quiet=False)
            raise
        finally:
            # Back to the baseline (console printing, no recorder) -- but only while this run still owns
            # them: a run abandoned at the cap that ends late must not reset the run that replaced it.
            if GRAPH_RECORDER is recorder and recorder.run_id == this_run:
                RUN_OUT.begin("print")
                GRAPH_RECORDER = NULL_RECORDER
        recorder.complete(success=True, output=output)
        recorder.end(quiet=False)
        return output
    return run_once


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"LangGraph workflow {WORKFLOW_NAME!r}", allow_abbrev=False)
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    when = ap.add_mutually_exclusive_group()
    when.add_argument("--once", action="store_true", help="run once, even when the Start listens or is scheduled")
    when.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",
                      help="run on a cron schedule until Ctrl-C (default: the Start node's schedule)")
    when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER",
                      help="run whenever an MCP tool says something new arrived, until Ctrl-C "
                           "(default: the Start option's trigger; or 'server.tool {json args}')")
    talk = ap.add_mutually_exclusive_group()
    talk.add_argument("--quiet", action="store_true", help="print only each run's done / failed line")
    talk.add_argument("--verbose", action="store_true", help="also print each node's output")
    a = ap.parse_args()
    mode = choose_mode(a, START_MODE)
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)
    view = ConsoleView("quiet" if a.quiet else "verbose" if a.verbose else "normal")
    recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])
    RUN_OUT.chatty = a.verbose if mode != "once" else not a.quiet   # startup lines (tools ready)
    run_once = make_run_once(prompt, runs, view, recorder, loop_mode=mode != "once")
    drains = bool(CODE_NODES)
    # The mode's flag, or the Start's mode with its baked default; a bad or missing --cron / --watch
    # stops here (exit 2), before any agent starts.
    cron = CronExpression.from_cli(ap, a.cron if a.cron is not None else ("" if mode == "cron" else None), DEFAULT_CRON)
    watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)
    if mode == "once":
        RUN_OUT.once(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
        try:
            if not run_once():
                RUN_OUT.once("[info] The run ended without output (a branch ended).")
        except ErrorExitTaken as e:
            sys.exit(1 if a.quiet else f"[error] {e}")   # --quiet: the view's Failed line says it
    else:
        Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),
                 lock_path=os.path.join(PACKAGE_DIR, ".run.lock"), verbosity=view.verbosity).run_blocking()

PY;
    }
}
