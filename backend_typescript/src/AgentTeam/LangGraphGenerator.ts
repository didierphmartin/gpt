import { sql } from 'kysely';
import { db } from '../db/pools';
import {
  JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, F, PhpFloat, array_column, array_filter, array_flip, array_intersect_key,
  array_keys, array_map, array_merge, array_unique, array_values, asciiTranslit, count, date, elvis, empty, entries, explode,
  floatval, has, implode, in_array, intval, isEmptyArr, is_array, is_numeric, is_string, jsonDecodeStd, json_encode,
  keysOf, mb_substr, oarr, preg_match, preg_replace, rtrim, sortStrings, sprintf, stdObj, str_repeat, str_replace, strtolower,
  strtoupper, strval, substr, toArr, toObject, trim, truthy, union, values, var_export_scalar,
} from './compiler/php';
import { WorkflowView } from './compiler/WorkflowView';
import { GraphAnalyzer } from './compiler/GraphAnalyzer';
import { PythonEmitHelpers } from './compiler/PythonEmitHelpers';
import { LangGraphRuntime } from './compiler/LangGraphRuntime';
import { LangGraphPackage } from './compiler/LangGraphPackage';
import { LangGraphArchitectureDoc } from './compiler/LangGraphArchitectureDoc';
import { PlaybookEmit } from './compiler/PlaybookEmit';
import { RunServerEmitter } from './compiler/RunServerEmitter';
import { SwarmRewriter } from './compiler/SwarmRewriter';
import { CodeNodeEmit } from './CodeNodeEmit';
import { GraphWorkflowRunner } from './GraphWorkflowRunner';
import { DispatchRouting } from './DispatchRouting';
import { PlaybookSource } from './PlaybookSource';
import { StartTriggerFacts } from './StartTriggerFacts';
import { DEFAULT_CONFIDENCE_FLOOR } from './DecisionRouter';
import { agentToArray } from './AgentRepository';
import { DecisionProviders } from '../Services/DecisionProviders';
import { RobotAccount } from '../Services/RobotAccount';
import { PlaybookStore } from '../Playbook/PlaybookStore';

/** What the generator reads a workflow, its graph and its agents through (WorkflowRepository, WorkflowGraphRepository, AgentRepository). */
export interface LangGraphRepositories {
  workflowRepo: { findById(id: number): Promise<any | null> };
  graphRepo: { getGraph(workflowId: number): Promise<{ nodes?: any[]; edges?: any[] }> };
  agentRepo: { findById(id: number): Promise<any | null> };
}

/** A generated file: text, or base64 bytes (a skill image, a Start document) with encoding 'base64'. */
export interface GeneratedFile {
  path: string;
  code: string;
  encoding?: string;
}

/** Single file: {filename, code, architecture, package_files}; modular / A2A / swarm: {root, files[, architecture]}. */
export type LangGraphResult =
  | { filename: string; code: string; architecture: string | null; package_files: GeneratedFile[] }
  | { root: string; files: GeneratedFile[]; architecture?: string | null };

/**
 * LangGraph Generator -- TypeScript port of backend/src/AgentTeam/Services/LangGraphGenerator.php.
 *
 * Generates a standalone Python LangGraph program from a saved workflow: one file, a modular package
 * ("agents in separate files"), an A2A folder (one agent server per node + an orchestrator) or a swarm
 * package. The output is byte-identical to the PHP generator's (tests/CompilerParity.test.ts compares
 * them on fixtures); PHP array semantics come from compiler/php.ts (ordered keyed arrays, PHP floats,
 * stdClass objects, byte-based string functions).
 *
 * The generated file is fully independent of the backend. It connects
 * directly to MCP servers via JSON-RPC 2.0 over HTTP and needs only:
 *   - ANTHROPIC_API_KEY env var
 *   - A user prompt (CLI argument)
 *   - MCP servers reachable at the URLs baked into the file
 */
export class LangGraphGenerator {
  private workflowRepo: LangGraphRepositories['workflowRepo'];
  private graphRepo: LangGraphRepositories['graphRepo'];
  private agentRepo: LangGraphRepositories['agentRepo'];
  /** Where the skill folders the modular package copies are read from (LangGraphPackage). */
  private skillsRoot: string;
  /** The requesting user's document storage: the only place a Start document is copied from (none: no copy). */
  private startDocuments: any;

  constructor(
    workflowRepo: LangGraphRepositories['workflowRepo'],
    graphRepo: LangGraphRepositories['graphRepo'],
    agentRepo: LangGraphRepositories['agentRepo'],
    skillsRoot: string | null = null,
    startDocuments: any = null,
  ) {
    this.workflowRepo = workflowRepo;
    this.graphRepo = graphRepo;
    this.agentRepo = agentRepo;
    this.skillsRoot = skillsRoot ?? LangGraphPackage.defaultSkillsRoot();
    this.startDocuments = startDocuments;
  }

  // ---------- helpers (same as Python generator) ----------

  private static nodeType(n: any): string {
    let cfg = n['config'] ?? [];
    if (!is_array(cfg)) {
      cfg = [];
    }
    // The DB column can be '' (editor-saved agent-template nodes): treat
    // empty like missing and fall back to config.type; no type at all is an
    // agent, as WorkflowGraphAnalyzer::typeOf reads it.
    for (const t of [n['node_type'] ?? null, n['type'] ?? null, cfg['type'] ?? null]) {
      if (t !== null && strval(t) !== '') {
        return strval(t);
      }
    }
    return 'agent';
  }

  /** "<server slug>.<tool>" ids the playbook analyzer binds against — twin of LoaderMcpExecutor::slug(). */
  private static serverSlug(serverName: string): string {
    return strtolower(preg_replace('/[^a-z0-9]+/i', '_', serverName));
  }

  private static nodeId(n: any): string {
    return strval(n['id'] ?? n['drawflow_node_id'] ?? n['_id'] ?? '');
  }

  private static edgeFrom(e: any): string {
    return strval(e['from_node_id'] ?? e['from'] ?? e['source'] ?? '');
  }

  private static edgeTo(e: any): string {
    return strval(e['to_node_id'] ?? e['to'] ?? e['target'] ?? '');
  }

  private static displayName(node: any): string {
    let cfg = node['config'] ?? [];
    if (!is_array(cfg)) {
      cfg = [];
    }
    const name = cfg['agent_name'] ?? cfg['name'] ?? node['name'] ?? null;
    if (name !== null && name !== '') {
      return strval(name);
    }
    return 'node_' + LangGraphGenerator.nodeId(node);
  }

  private static safeVar(name: string): string {
    // Replace every run of non-[A-Za-z0-9] (including the bytes of multibyte
    // characters like an em-dash) with a single '_'.
    const out = preg_replace('/[^A-Za-z0-9]+/', '_', name);
    return strtolower(trim(out, '_'));
  }

  /**
   * Fetch MCP tools with server info (url, name, headers), matching
   * the Python loader.list_mcp_tools_with_servers() shape.
   */
  private async loadMcpToolsWithServers(userId: string | null = null): Promise<any[]> {
    // Global servers plus the caller's own registrations — the same
    // registry chat and the browser runner see (MCPToolsLoader).
    const withUser = userId !== null && userId !== '';
    const rows = (
      await (withUser
        ? sql<any>`SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ${userId})`
        : sql<any>`SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND (s.user_id IS NULL)`
      ).execute(db)
    ).rows;

    const out: any[] = [];
    for (const r of rows) {
      const row: any = oarr(Object.entries(r));
      // Decode input_schema JSON; preserve objects so empty {} stays as object.
      const schemaRaw = row['input_schema'] ?? null;
      let schema: any = null;
      if (is_string(schemaRaw) && schemaRaw !== '') {
        schema = jsonDecodeStd(schemaRaw);
      }
      row['input_schema'] = schema;
      out.push(row);
    }
    return out;
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
    async generate(workflowId: number, userId: string | null = null, options: { a2a?: any; modular?: any } = {}): Promise<LangGraphResult> {
        let codeData: any, codeSlugs: any, lines: any, sep: any, docAgents: any, docExtra: any, mcpCount: any, docNodes: any, docById: any, docBody: any, ofolder: any, kind: any, typeMap: any, t: any, code: any, filename: any;
        const facts: any = await this.analyzeForEmit(workflowId, userId);
        if (facts['triggerNodeId'] !== null && (!empty(options?.['a2a']) || (facts['orchestration'] ?? 'workflow') === 'swarm')) {
            throw new Error('A Start option (' + facts['startOptionLabel'] + ') needs the single-file or modular format.');
        }
        if (!isEmptyArr(facts['codeData']) && (facts['orchestration'] ?? 'workflow') === 'swarm') {
            throw new Error('Code nodes are not supported by the swarm packaging yet. '
                + 'Compile this workflow as a single file or with agents in separate files.');
        }
        if ((facts['orchestration'] ?? 'workflow') === 'swarm') {
            // §7 defers both. A2A swarm in particular is a different design —
            // handoffs crossing the network between agent servers — not a
            // packaging variation, so refusing is honest rather than lazy.
            if (!empty(options?.['a2a'])) {
                throw new Error(
                    'A2A packaging is not supported for swarm workflows yet. Generate this swarm with "Agents in separate files".'
                );
            }
            if (empty(options?.['modular'])) {
                throw new Error(
                    'Single file packaging is not supported for swarm workflows yet. Generate this swarm with the modular layout ("Agents in separate files").'
                );
            }
            return this.generateSwarm(facts);
        }
        if (!isEmptyArr(facts['codeData']) && !empty(options?.['a2a'])) {
            throw new Error('Code nodes are not supported by the A2A packaging yet. '
                + 'Compile this workflow as a single file or with agents in separate files.');
        }
        if (!empty(options?.['a2a']) && !isEmptyArr(array_filter(facts['playbookData'],
                (pd: any) => (pd['source'] ?? 'fixed') === 'input' || !empty(pd?.['exits'])))) {
            throw new Error('Playbook nodes with exits or "from input" are not supported by the A2A packaging yet. '
                + 'Compile this workflow as a single file or with agents in separate files.');
        }
        if (!empty(options?.['a2a'])) {
            return this.generateA2A(facts);   // Task 4
        }
        if (!empty(options?.['modular'])) {
            return this.generateModular(facts);   // "agents in separate files"
        }
        // The emitter below was written against local variables; expose the
        // facts under their original names (EXTR_SKIP: never clobber $this).
        const { workflow, wfName, safeName, gdata, byId, order, edges, startPrompt, startDocuments, agentData, playbookData,
            dispatchTargets, usedServers, usedCatalog, missing, edgeList } = facts;
        codeData = facts['codeData'];
        codeSlugs = facts['codeSlugs'];
        // ---- emit code ----
        lines = [];
        // Box-drawing separator used in section headers (62 '═' chars,
        // matching Python's literal string).
        sep = '# ' + str_repeat('=', 62);

        // ---- module docstring: the uniform documentation every target carries ----
        docAgents = oarr();
        for (let [nid, ad] of entries(agentData)) {
            docAgents[nid] = { name: ad['display'], provider: ad['provider'], model: ad['model'], temperature: ad['temperature'], max_tokens: ad['max_tokens'], thinking: ad['thinking'], tools: ad['tool_names'], skills: ad['skills'] };
        }
        docExtra = oarr();
        for (let [nid, targets] of entries(dispatchTargets)) {
            (docExtra[nid] ??= {})['dispatch'] = array_column(targets, 'name');
        }
        for (let [nid, pd] of entries(playbookData)) {
            mcpCount = count(array_filter(pd['actions'], (a: any) => (a['kind'] ?? '') === 'mcp'));
            (docExtra[nid] ??= {})['playbook'] = { title: pd['title'], writes: pd['writes_enabled'], bound: mcpCount, unbound: count(pd['actions']) - mcpCount };
            docAgents[nid] = { name: pd['display'], provider: pd['provider'], model: pd['model'], temperature: pd['temperature'], max_tokens: pd['max_tokens'], thinking: pd['thinking'], tools: [], skills: [] };
        }
        for (let [nid, cd] of entries(codeData)) {
            docAgents[nid] = { name: cd['display'], provider: '', model: '', temperature: null, max_tokens: null, thinking: null, tools: array_map((slg: any) => `${slg}.*`, cd['mcp_servers']), skills: [] };
        }
        docNodes = GraphAnalyzer.docNodes(byId, order, edges, docAgents, docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'code', 'output']);
        docById = oarr();
        for (let dn of values(docNodes)) {
            docById[dn['id']] = dn;
        }
        docBody = PythonEmitHelpers.workflowDocBlock({ target: 'LangGraph (Python) -- langgraph StateGraph + LangChain ReAct agents', dispatch_supported: true, workflow: { id: workflowId, name: wfName }, nodes: docNodes, edges: edgeList, layers: gdata['layers'] ?? [], data_flow: LangGraphGenerator.dataFlowDoc(), run: { deps: [LangGraphPackage.pipInstall(facts, 'single'), ...LangGraphPackage.OPTIONAL_FORMATS_NOTE], usage: `python ${safeName}_langgraph.py "your prompt here"`, extra: array_merge(!empty(missing)
                    ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' + LangGraphGenerator.pythonListRepr(missing)]
                    : [], LangGraphGenerator.decisionDocLines(agentData), LangGraphGenerator.mcpHeaderDocLines(facts), LangGraphGenerator.modeDocLines(`${safeName}_langgraph.py`), LangGraphGenerator.cronDocLines(facts, `${safeName}_langgraph.py`),
                    LangGraphGenerator.watchDocLines(facts, `${safeName}_langgraph.py`),
                    ['# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); use the modular package for a self-contained copy.']) }, storage: { enabled: workflow.isOutputStorageEnabled(), folder: workflow.getOutputFolder(), default: 'outputs/workflow/ next to this script (SYNERGYAI_OUTPUT_ROOT overrides)' } });
        lines.push('"""Standalone LangGraph workflow: ' + wfName);
        lines.push('');
        for (let dl of values(explode('\n', str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], docBody)))) {
            lines.push(dl);
        }
        lines.push('"""');
        lines.push('from __future__ import annotations');
        lines.push('');
        lines.push('import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid' + (!isEmptyArr(codeData) ? ', types' : ''));
        lines.push('from abc import ABC, abstractmethod');
        lines.push('from dataclasses import asdict, dataclass, field');
        lines.push('from datetime import datetime, timedelta');
        lines.push('from enum import Enum');
        lines.push('from functools import cached_property');
        lines.push('from pathlib import Path');
        lines.push('');
        lines.push('from dotenv import load_dotenv');
        lines.push('');
        lines.push('# Load provider API keys from the runner env .env (one dir up from scripts/).');
        lines.push('# Without this a DIRECT terminal run has no credentials and every provider');
        lines.push('# call fails; runner-mediated runs only worked because main.py loads the');
        lines.push('# same file and subprocesses inherit the environment.');
        lines.push('# A .env next to this script comes first (load_dotenv never overrides a variable already set),');
        lines.push('# so a copy run outside the runner folder carries its own keys.');
        lines.push('load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))');
        lines.push('RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the runner env folder (python/)');
        lines.push('load_dotenv(os.path.join(RUNNER_DIR, ".env"))');
        lines.push('DEBUG_STEM = Path(__file__).stem   # names this script\'s outputs/_debug message-history dumps');
        lines.push('from typing import Annotated, Awaitable, Callable, Literal, TypedDict');
        lines.push('');
        lines.push('import httpx');
        lines.push('# Provider-aware LLM wiring — each agent uses the LLM (provider/model)');
        lines.push('# configured for it in the workflow editor. Imports are lazy inside');
        lines.push('# _make_llm so a missing optional package only breaks the agents that');
        lines.push('# actually use that provider, not the whole script.');
        lines.push('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage');
        lines.push('from langchain_core.tools import StructuredTool');
        lines.push('from langgraph.graph import END, START, StateGraph');
        lines.push('try:');
        lines.push('    from langchain.agents import create_agent as create_react_agent');
        lines.push('except ImportError:');
        lines.push('    from langgraph.prebuilt import create_react_agent');
        lines.push('from pydantic import Field, create_model');
        lines.push('');
        lines.push('# Optional global override: setting MODEL_NAME in the env forces every');
        lines.push('# agent to use that model regardless of its per-agent setting. Useful for');
        lines.push('# quick experiments. Leave unset to honour each agent\'s configured model.');
        lines.push('MODEL_NAME_OVERRIDE = os.environ.get(\'MODEL_NAME\', \'\').strip()');
        lines.push('');
        lines.push('');
        lines.push(LangGraphRuntime.llmFactoryBlock());
        lines.push('');

        // ---------- MCP server registry (baked) ----------
        lines.push(sep);
        lines.push('# MCP SERVER REGISTRY');
        lines.push('# Baked at generation time from the workflow editor\'s config.');
        lines.push('# Maps server URL -> metadata. If a server moves, set MCP_URL_<SLUG> in .env');
        lines.push('# (e.g. MCP_URL_OUTLOOK=http://host:8770/mcp); the URL here stays the key.');
        lines.push(sep);
        lines.push('');
        lines.push('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(usedServers, true));
        lines.push('');
        if (!isEmptyArr(codeData)) {
            lines.push('# MCP_SLUGS: server slug -> URL, for code nodes\' call_tool(server, tool, args).');
            lines.push('MCP_SLUGS = ' + PythonEmitHelpers.jsonToPython(codeSlugs, true));
            lines.push('');
        }

        // ---------- tool catalog (baked) ----------
        lines.push(sep);
        lines.push('# TOOL CATALOG');
        lines.push('# Each entry maps a tool name to its MCP server URL and');
        lines.push('# JSON Schema for input validation. Only tools actually used');
        lines.push('# by agents in this workflow are included.');
        lines.push('# To add a tool: add an entry here AND reference it in the');
        lines.push('# agent\'s tool_names list in the AGENTS dict below.');
        lines.push(sep);
        lines.push('');
        lines.push('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(usedCatalog, true));
        lines.push('');

        // ---------- MCP JSON-RPC client ----------
        lines.push(sep);
        lines.push('# MCP CLIENT -- JSON-RPC 2.0 over HTTP');
        lines.push(sep);
        lines.push('');
        // The protocol steps and the SSE note are McpClient's class docstring.
        lines.push(LangGraphGenerator.serverSlugsLine(facts['serverSlugs'] ?? []));
        lines.push('');
        lines.push(LangGraphRuntime.mcpClientBlock());
        if (!isEmptyArr(codeData)) {
            lines.push(LangGraphRuntime.codeHarnessBlock());
            lines.push('');
        }

        // ---------- tool builder ----------
        lines.push('');
        lines.push(sep);
        lines.push('# TOOL BUILDER');
        lines.push('# Converts the baked TOOL_CATALOG into LangChain StructuredTool');
        lines.push('# objects. Each tool gets a dynamically-built Pydantic model for');
        lines.push('# input validation (from the JSON Schema), and a callable that');
        lines.push('# invokes the MCP server. The LLM agent calls these like any');
        lines.push('# other LangChain tool -- it doesn\'t know about MCP internals.');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock());
        lines.push(LangGraphRuntime.runEventsBlock());
        lines.push(LangGraphRuntime.dispatcherBlock(LangGraphGenerator.decisionProtocolsUsed(agentData)));
        if (!isEmptyArr(playbookData)) {
            lines.push(LangGraphRuntime.playbookBlock());
        }

        // ---------- state ----------
        lines.push('');
        lines.push(sep);
        lines.push('# LANGGRAPH STATE');
        lines.push('#');
        lines.push('# WFState is the shared state that flows through the graph.');
        lines.push('# - user_prompt: the original user input (immutable after start)');
        lines.push('# - node_outputs: dict of node_id -> {source, text} -- each node');
        lines.push('#   writes its output here. Uses a merge reducer so parallel');
        lines.push('#   branches can both contribute without conflicts.');
        lines.push('# - final_output: set by the output node as the workflow result');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphGenerator.stateBlock());

        // ---------- datetime injector ----------
        lines.push('');
        lines.push(sep);
        lines.push('# DATETIME INJECTOR');
        lines.push('#');
        lines.push('# LLMs have knowledge cutoffs and don\'t know the current date.');
        lines.push('# inject_datetime() prepends a short context block to each agent\'s');
        lines.push('# system prompt so the agent reasons with today\'s actual date.');
        lines.push('# Also resolves any [date]/[weekday]/[year]/[time] placeholders');
        lines.push('# that may exist inside the prompt text (legacy templating).');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphGenerator.datetimeInjectorBlock());

        // ---------- context builder ----------
        lines.push('');
        lines.push(sep);
        lines.push('# CONTEXT BUILDER');
        lines.push('#');
        lines.push('# Each agent receives a structured message containing:');
        lines.push('#   1. The original user request (for reference)');
        lines.push('#   2. Labeled outputs from direct upstream agents only');
        lines.push('# This matches the PHP backend\'s \'labeled\' merge strategy.');
        lines.push('# The agent\'s system prompt tells it what to DO with this input.');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphGenerator.contextBuilderBlock());

        // ---------- node classes (one per node kind; run() builds NODES from them) ----------
        lines.push('');
        lines.push(LangGraphRuntime.nodeClassesBlock(!isEmptyArr(playbookData), !isEmptyArr(codeData)));

        // ---------- document converter ----------
        lines.push('');
        lines.push(sep);
        lines.push('# DOCUMENT CONVERTER');
        lines.push('#');
        lines.push('# Reads a file at `path` and returns Markdown the LLM can read.');
        lines.push('# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through');
        lines.push('# verbatim. Binary office formats and PDFs are routed to their');
        lines.push('# matching pure-Python library (mammoth / python-pptx / openpyxl /');
        lines.push('# pypdf). Imports are lazy so the helper only pulls in heavy deps');
        lines.push('# when a document of that format is actually attached.');
        lines.push('#');
        lines.push('# This mirrors the editor\'s frontend converter (Pyodide) so the');
        lines.push('# generated script behaves the same way the workflow did at design');
        lines.push('# time. Paths come from the doc.path field stored in the workflow');
        lines.push('# config — make sure the file is reachable from wherever you run');
        lines.push('# this script (absolute paths recommended).');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphRuntime.documentConverterBlock());

        // ---------- the graph, output storage and run summary (shared with every mode) ----------
        lines.push('');
        lines.push(LangGraphRuntime.runRecordBlock());
        lines.push(LangGraphRuntime.consoleBlock());
        lines.push(LangGraphRuntime.workflowGraphBlock());
        lines.push(LangGraphRuntime.outputBlock(true));   // outputs/ next to the script (spec 2026-10-15 §4.3)
        lines.push(LangGraphRuntime.cronBlock());
        lines.push(LangGraphRuntime.watchBlock());
        lines.push(LangGraphRuntime.listenerBlock());

        // ---------- start node config ----------
        lines.push('');
        lines.push(sep);
        lines.push('# START NODE');
        lines.push('#');
        lines.push('# The start node feeds the prompt into the workflow.');
        lines.push('# DEFAULT_PROMPT is baked from the workflow\'s start node config.');
        lines.push('# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.');
        lines.push('# If the workflow has documents attached to the start node,');
        lines.push('# they\'re read from doc.path, converted to Markdown via');
        lines.push('# DOCUMENTS.convert(), and prepended to the prompt.');
        lines.push(sep);
        lines.push('');
        // Verbatim, as the package bakes it: no 80-column wrap, so the prompt is the same text in every mode.
        lines.push('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(startPrompt));
        lines.push(LangGraphGenerator.defaultCronLine(facts));
        lines.push(LangGraphGenerator.defaultWatchLine(facts));
        lines.push(...LangGraphGenerator.startModeLines(facts));
        lines.push('');
        // Output-node storage setting baked in so the compiled script persists the final
        // result (outputs/workflow/ next to the script, SYNERGYAI_OUTPUT_ROOT overriding, or a
        // custom folder) only when storage is enabled.
        ofolder = workflow.getOutputFolder();
        lines.push('WORKFLOW_ID = ' + intval(workflowId));
        lines.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(wfName));
        lines.push('OUTPUT_STORAGE_ENABLED = ' + (workflow.isOutputStorageEnabled() ? 'True' : 'False'));
        lines.push('OUTPUT_FOLDER = ' + ((ofolder !== null && ofolder !== '') ? PythonEmitHelpers.pyStr(strval(ofolder)) : 'None'));
        lines.push('');
        if (!empty(startDocuments)) {
            lines.push('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(startDocuments));
        } else {
            lines.push('START_DOCUMENTS = []');
        }
        lines.push('');

        // ---------- embedded agent definitions ----------
        lines.push(sep);
        lines.push('# AGENT DEFINITIONS');
        lines.push('#');
        lines.push('# Each agent is identified by its workflow node ID.');
        lines.push('#   id, kind:      The node ID again, and which Node class runs it (make_node)');
        lines.push('#   display:       Human-readable name (for logs and context labels)');
        lines.push('#   system_prompt: The agent\'s persona/instructions (sent as SystemMessage)');
        lines.push('#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)');
        lines.push('#');
        lines.push('# To modify an agent: edit its system_prompt or tool_names here.');
        lines.push('# To add a new agent: add an entry, create edges in EDGES, and');
        lines.push('# include the node ID in ORDER at the right topological position.');
        lines.push(sep);
        lines.push('');
        lines.push('AGENTS = {');
        for (let [nid, ad] of entries(agentData)) {
            if (((docById?.[nid]) != null)) {
                for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ')))) {
                    lines.push(cl);
                }
            }
            kind = !empty(ad?.['dispatch']) ? 'dispatcher' : 'agent';
            for (let nl of values(explode('\n', this.nodeDefinitionLines(facts, strval(nid), kind, ad['display'], ad, false, '"' + nid + '": {', '    ')))) {
                lines.push(nl);
            }
        }
        lines.push('}');
        lines.push('');
        lines.push(sep);
        lines.push('# PLAYBOOK DEFINITIONS');
        lines.push('#');
        lines.push('# A playbook node runs the Console-style playbook text through the');
        lines.push('# playbook runtime below: native verbs (messages, notes, resolve), human');
        lines.push('# gates, and the MCP tools its #Actions were bound to at generation time.');
        lines.push('#   actions:        bound MCP actions (llm_name -> server_url/tool) and');
        lines.push('#                   unbound stubs (the on_unbound policy applies)');
        lines.push('#   writes_enabled: node toggle; write tools are blocked when False');
        lines.push(sep);
        lines.push('');
        if (LangGraphGenerator.hasFromInput(playbookData)) {
            lines.push(...LangGraphGenerator.publishedPlaybooksLines(facts['publishedPlaybooks'], facts['publishedSkipped']));
            lines.push('');
        }
        if (isEmptyArr(playbookData)) {
            lines.push('PLAYBOOKS = {}');
        } else {
            lines.push('PLAYBOOKS = {');
            for (let [nid, pd] of entries(playbookData)) {
                if (((docById?.[nid]) != null)) {
                    for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ')))) {
                        lines.push(cl);
                    }
                }
                for (let nl of values(explode('\n', this.nodeDefinitionLines(facts, strval(nid), 'playbook', pd['display'], pd, true, '"' + nid + '": {', '    ')))) {
                    lines.push(nl);
                }
            }
            lines.push('}');
        }
        lines.push('');
        lines.push('# CODE NODE DEFINITIONS -- run(input, call_tool), exits and declared tools, frozen from the editor');
        if (isEmptyArr(codeData)) {
            lines.push('CODE_NODES = {}');
        } else {
            lines.push('CODE_NODES = {');
            for (let [nid, cd] of entries(codeData)) {
                if (((docById?.[nid]) != null)) {
                    for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ')))) {
                        lines.push(cl);
                    }
                }
                for (let nl of values(explode('\n', LangGraphGenerator.codeNodeDefinitionLines(strval(nid), cd, '"' + nid + '": {', '    ')))) {
                    lines.push(nl);
                }
            }
            lines.push('}');
        }
        lines.push('');

        // ---------- edge data ----------
        lines.push(sep);
        lines.push('# GRAPH STRUCTURE');
        lines.push('#');
        lines.push('# EDGES: directed connections as (from_node_id, to_node_id) tuples.');
        lines.push('# ORDER: topological execution order (Kahn\'s algorithm).');
        lines.push('#        Guarantees every node runs after all its predecessors.');
        lines.push('# NODE_TYPES: maps node_id -> type (\'start\', \'agent\', \'playbook\', \'output\').');
        lines.push('#              A code node\'s type is \'code\'.');
        lines.push(sep);
        lines.push('');
        lines.push('EDGES = ' + PythonEmitHelpers.jsonToPython(edgeList));
        lines.push('ORDER = ' + PythonEmitHelpers.jsonToPython(order));
        typeMap = oarr();
        for (let nid of values(order)) {
            t = LangGraphGenerator.nodeType(byId[nid]);
            typeMap[nid] = t === 'agent-template' ? 'agent' : t;
        }
        lines.push('NODE_TYPES = ' + PythonEmitHelpers.jsonToPython(typeMap, true));
        lines.push('');

        // ---------- main function ----------
        lines.push(sep);
        lines.push('# MAIN EXECUTION');
        lines.push('#');
        lines.push('# run() builds the WorkflowGraph over this file\'s nodes and executes it;');
        lines.push('# every agent/playbook node runs in this process (_run_local_node).');
        lines.push('#');
        lines.push('# Agent nodes use LangChain\'s ReAct pattern: the LLM receives');
        lines.push('# the system prompt + upstream context, and can call tools in a');
        lines.push('# loop until it produces a final answer.');
        lines.push(sep);
        lines.push('');
        lines.push(LangGraphGenerator.singleRunBlock(!empty(missing)
            ? '    RUN_OUT.once("[warn] Missing tools (not MCP): ' + LangGraphGenerator.pythonListRepr(missing) + '", always=True)' + '\n'
            : ''));

        code = implode('\n', lines);
        // Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py
        // (LangGraph was the original default and previously had no suffix).
        filename = `${safeName}_langgraph.py`;
        return { filename: filename, code: code, architecture: LangGraphGenerator.architectureDoc(facts, 'single'),
            package_files: LangGraphPackage.singleFiles(facts, filename) };
    }

    /**
     * This compile's ARCHITECTURE.md, or null. The document is a companion: it
     * must never cost the user the code, so a failure to build it is logged
     * and dropped. An ingestion pipeline (loader/splitter/vectorstore nodes) is
     * not the agent graph the document describes, so it gets none.
     */
    private static architectureDoc(facts: any, mode: string): string | null {
        for (let n of values(facts['byId'])) {
            if (in_array(LangGraphGenerator.nodeType(n), ['loader', 'splitter', 'vectorstore'], true)) {
                return null;
            }
        }
        try {
            return LangGraphArchitectureDoc.build(facts, mode);
        } catch (e: any) {
            console.error(`[LangGraphGenerator] ${mode} ARCHITECTURE.md skipped: ` + (e?.message ?? String(e)));
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
    private async analyzeForEmit(workflowId: number, userId: string | null): Promise<any> {
        const model = await this.workflowRepo.findById(workflowId);
        if (!model) {
            throw new Error(`Workflow ${workflowId} not found.`);
        }
        const workflow = model instanceof WorkflowView ? model : WorkflowView.fromModel(model);
        const wfName: string = truthy(workflow.getName()) ? workflow.getName() : 'workflow_' + workflowId;
        let safeName = LangGraphGenerator.safeVar(wfName);
        if (safeName === '') {
            safeName = 'workflow_' + workflowId;
        }

        // Only what Start reaches is the workflow: unconnected canvas nodes stay out.
        const graph: any = GraphWorkflowRunner.configuredTemplatesAsAgents(
            GraphAnalyzer.reachableGraph(await this.graphRepo.getGraph(workflowId)) as any);
        // The server runner's node rules (spec 2026-10-15 §7): a template it would refuse, and any type
        // nothing runs, are compile errors -- not a silent no-op in the compiled graph.
        for (const n of values(graph['nodes'] ?? [])) {
            const t = LangGraphGenerator.nodeType(n);
            if (t === 'agent-template') {
                throw new Error('Unconfigured agent template node found: ' + LangGraphGenerator.displayName(n)
                    + ' — pick an agent or fill in its instructions.');
            }
            if (!in_array(t, ['start', 'agent', 'playbook', 'code', 'output'], true)) {
                throw new Error('Node "' + LangGraphGenerator.displayName(n) + '" (' + t + ') cannot be compiled: '
                    + 'LangGraph runs start, agent, playbook, code and output nodes.');
            }
        }
        // Route pure graph analysis through WorkflowGraphAnalyzer.
        // Returns: byId, order (Kahn topo), edges (normalised), startNodeId.
        const gdata: any = GraphAnalyzer.analyzeGraph(graph);
        const byId: any = gdata['byId'];
        const order: string[] = values(gdata['order']).map(strval);
        const startId = strval(gdata['startNodeId']);
        if (startId === '') {
            throw new Error('No start node found.');
        }
        // Normalised edges ({from, to}) are compatible with edgeFrom()/edgeTo().
        const edges: any[] = values(gdata['edges']);
        const startNode = byId[startId];
        let startCfg = startNode['config'] ?? startNode['data'] ?? [];
        if (!is_array(startCfg)) {
            startCfg = [];
        }
        const startPrompt = strval(startCfg['prompt'] ?? '');
        let startDocuments = startCfg['documents'] ?? [];
        if (!is_array(startDocuments)) {
            startDocuments = [];
        }

        // Provider default models (system_llm_settings.model). Used when
        // an agent has no explicit `model` field set — same source the
        // workflow editor's "Default: <name>" placeholder reads from, so
        // the generated script uses exactly what the UI would have used.
        const providerDefaults: any = oarr();
        try {
            const rowsP = (await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(db)).rows;
            for (const rowP of rowsP) {
                providerDefaults[strtolower(strval(rowP['provider_key'] ?? ''))] = strval(rowP['model'] ?? '');
            }
        } catch {
            // If the table is missing or unreadable, fall through with an
            // empty map — agents that left their model blank will fail
            // loudly at run-time rather than silently using a stale
            // hardcoded fallback.
        }

        // Fetch MCP tools with server info (url, name, headers)
        const mcpTools = await this.loadMcpToolsWithServers(userId);

        // Build server registry and tool catalog
        const serverRegistry: any = oarr();
        const toolCatalog: any = oarr();
        for (const t of mcpTools) {
            const surl = strval(t['server_url'] ?? '');
            const sname = strval(t['server_name'] ?? '');
            const tname = strval(t['tool_name'] ?? t['name'] ?? '');
            if (surl === '' || tname === '') {
                continue;
            }
            if (!has(serverRegistry, surl)) {
                serverRegistry[surl] = { name: sname };
            }
            let desc = t['tool_description'] ?? t['description'] ?? '';
            if (desc === null) {
                desc = '';
            }
            let schema = t['input_schema'] ?? null;
            // If null/missing, use empty object (Python uses {} default).
            if (schema === null) {
                schema = stdObj({});
            }
            toolCatalog[tname] = {
                server_url: surl,
                description: desc,
                input_schema: schema,
            };
        }

        // Playbook binding ids ("<server slug>.<tool>") over the same registry,
        // keyed the way LoaderMcpExecutor::availableTools() keys them.
        const availableById: any = oarr();
        for (const t of mcpTools) {
            const surl = strval(t['server_url'] ?? '');
            const tname = strval(t['tool_name'] ?? t['name'] ?? '');
            if (surl === '' || tname === '') {
                continue;
            }
            const schema = t['input_schema'] ?? null;
            availableById[LangGraphGenerator.serverSlug(strval(t['server_name'] ?? '')) + '.' + tname] = {
                server_url: surl,
                tool: tname,
                description: strval(t['tool_description'] ?? t['description'] ?? ''),
                input_schema: schema === null ? stdObj({}) : schema,
            };
        }

        // Dispatcher agents: their fan-out is a MENU, not a parallel fan-out
        // (DispatchRouting). Resolve each dispatcher's targets (agent/playbook
        // children, edge order) and which child is routed-to by whom BEFORE the
        // per-node loops, so a child's prompt can carry the routed fragment.
        const agentTypeCache = new Map<number, string>();
        const agentTypeOf = async (node: any): Promise<string> => {
            const cfg = is_array(node['config'] ?? null) ? node['config'] : [];
            const t = strval(cfg['agent_type'] ?? '');
            if (t !== '') {
                return t;
            }
            let aid = node['agent_id'] ?? cfg['agent_id'] ?? null;
            if (aid === null || aid === '') {
                return 'standard';
            }
            aid = intval(aid);
            if (!agentTypeCache.has(aid)) {
                try {
                    const a = await this.agentRepo.findById(aid);
                    agentTypeCache.set(aid, a ? strval(LangGraphGenerator.agentArray(a)['agent_type'] ?? 'standard') : 'standard');
                } catch {
                    agentTypeCache.set(aid, 'standard');
                }
            }
            return agentTypeCache.get(aid)!;
        };
        const dispatchTargets: any = oarr(); // dispatcher nid => [{id: child nid, name: display, description}, …]
        const routedBy: any = oarr();        // child nid => dispatcher display name
        for (const nid of order) {
            const node = byId[nid];
            if (!in_array(LangGraphGenerator.nodeType(node), ['agent', 'agent-template'], true) || (await agentTypeOf(node)) !== 'dispatcher') {
                continue;
            }
            const targets: any[] = [];
            for (const e of edges) {
                if (LangGraphGenerator.edgeFrom(e) !== nid) {
                    continue;
                }
                const childId = LangGraphGenerator.edgeTo(e);
                const child = byId[childId] ?? null;
                if (!child || !in_array(LangGraphGenerator.nodeType(child), ['agent', 'agent-template', 'playbook', 'code'], true)) {
                    continue;
                }
                // 'description' is what Jev reads as the option's criterion
                // (JevRouter: role truncated to 400 chars, else the name). Kept
                // EMPTY on purpose: the interpreter feeds Jev DispatchRouting::targets(),
                // which carries no description, so every option is judged by its
                // name alone there. Emitting the child's role here would make the
                // compiled script route differently from the interpreter.
                targets.push({ id: childId, name: LangGraphGenerator.displayName(child), description: '' });
                routedBy[childId] = LangGraphGenerator.displayName(node);
            }
            if (targets.length !== 0) {
                dispatchTargets[nid] = targets;
            }
        }

        // Resolve agent data for each agent node
        const agentData: any = oarr();
        const allNeededTools: any = oarr();
        for (const nid of order) {
            const node = byId[nid];
            const ntype = LangGraphGenerator.nodeType(node);
            if (ntype !== 'agent' && ntype !== 'agent-template') {
                continue;
            }
            let cfg = node['config'] ?? [];
            if (!is_array(cfg)) {
                cfg = [];
            }
            const agentId = node['agent_id'] ?? cfg['agent_id'] ?? null;
            let systemPrompt = strval(cfg['systemPrompt'] ?? cfg['instructions'] ?? '');
            // The editor saves selected MCP tools under `tools` (array of names
            // like "mcp_get_crypto_news"). Legacy/realtime nodes use
            // `selectedTools`. Accept both, normalise to bare names without
            // the `mcp_` prefix so they match the tool catalog keys.
            let rawTools = cfg['selectedTools'] ?? cfg['tools'] ?? [];
            if (!is_array(rawTools)) {
                rawTools = [];
            }
            const toolNames: string[] = LangGraphGenerator.toolNamesOf(rawTools);

            // Default provider/model — overridden below if the agent
            // record carries explicit fields.
            let agentProvider = '';
            let agentModel = '';
            // Who the dispatcher is, for its decision question. GraphWorkflowRunner asks
            // the resolved Agent (getName()/getDescription()); when this node
            // references a saved agent, use that record, else the node config.
            let dispatcherName = LangGraphGenerator.displayName(node);
            let dispatcherDesc = strval(cfg['description'] ?? '');
            // Routing settings (routing_mode, min_confidence): the interpreter
            // reads $agent->getSettings(), i.e. the saved record when the node
            // references one, else the node's own settings.
            let routingSettings: any = is_array(cfg['settings'] ?? null) ? cfg['settings'] : [];
            if (agentId !== null && agentId !== '') {
                try {
                    const agent = await this.agentRepo.findById(intval(agentId));
                    if (agent !== null && agent !== undefined) {
                        const agentArr = LangGraphGenerator.agentArray(agent);
                        if (trim(strval(agentArr['name'] ?? '')) !== '') {
                            dispatcherName = strval(agentArr['name']);
                        }
                        if (trim(strval(agentArr['description'] ?? '')) !== '') {
                            dispatcherDesc = strval(agentArr['description']);
                        }
                        let recSettings = agentArr['settings'] ?? [];
                        if (is_string(recSettings)) {
                            recSettings = jsonDecodeStd(recSettings) !== null ? LangGraphGenerator.assoc(recSettings) : null;
                        }
                        routingSettings = is_array(recSettings) ? recSettings : [];
                        if (systemPrompt === '') {
                            systemPrompt = strval(agentArr['instructions'] ?? agentArr['system_prompt'] ?? agentArr['prompt'] ?? '');
                        }
                        agentProvider = strval(agentArr['provider'] ?? '');
                        agentModel = strval(agentArr['model'] ?? '');
                        const agentTools = agentArr['tools'] ?? null;
                        if (empty(toolNames) && is_array(agentTools)) {
                            toolNames.push(...LangGraphGenerator.toolNamesOf(agentTools));
                        }
                    }
                } catch {
                    // Swallow: matches Python's broad except.
                }
            }
            // Node-level overrides (config layer beats the agent record).
            // The editor saves the picked provider under `agent_provider`;
            // legacy/realtime paths use `llm_provider` or `provider`.
            const nodeProvider = strval(cfg['llm_provider'] ?? cfg['provider'] ?? cfg['agent_provider'] ?? '');
            const nodeModel = strval(cfg['model'] ?? '');
            if (nodeProvider !== '') agentProvider = nodeProvider;
            if (nodeModel !== '') agentModel = nodeModel;
            if (agentProvider === '') agentProvider = 'claude';
            // Final resolution: if nothing set the model explicitly, use
            // the provider's default from system_llm_settings — the same
            // value the editor's form shows in the "Default: <name>"
            // placeholder. This is the single source of truth for "what
            // model does provider X use by default?".
            if (agentModel === '') {
                agentModel = providerDefaults[strtolower(agentProvider)] ?? '';
            }

            // Skills are mandatory POST-agent steps (not prompt text, not an optional
            // tool): the main agent runs, then each skill runs on its result and the last
            // skill's produced deliverable becomes the node output. Surface the ordered
            // skill bindings; skill_content is NO LONGER appended to the prompt. Mirrors ADK.
            const skills = GraphAnalyzer.skillsFromConfig(cfg);

            // HTML-output nudge: force the final message to be the raw HTML document
            // itself when the prompt asks for HTML and no skill renders it.
            const pl = strtolower(systemPrompt);
            const wantsHtml = pl.includes('output only the html')
                || pl.includes('production-quality html')
                || pl.includes('<!doctype')
                || (pl.includes('self-contained') && pl.includes('<style'));
            // Only nudge the MAIN agent to emit HTML when the node has NO skill to render
            // it. When a skill (e.g. html) is attached, that skill step produces the HTML
            // deliverable, so the main agent should just write the report content.
            if (wantsHtml && empty(skills)) {
                systemPrompt = rtrim(systemPrompt)
                    + '\n\n## Output format (CRITICAL — read carefully)\n'
                    + 'Your FINAL message MUST be the complete, self-contained HTML '
                    + 'document itself: start with `<!DOCTYPE html>` and end with '
                    + '`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick '
                    + 'code fences, no preamble, and no commentary before or after. Do NOT '
                    + 'narrate what you are about to do; produce the HTML directly as your '
                    + 'answer. The runtime saves your final message verbatim to an .html '
                    + 'file, so anything that is not HTML breaks the deliverable.';
            }

            // Dispatcher routing (twin of GraphWorkflowRunner): the dispatcher's
            // prompt lists its menu and demands route_to; a routed-to child is
            // told it was chosen so it handles the request instead of re-routing.
            if (systemPrompt === '') {
                systemPrompt = DispatchRouting.defaultInstructions(LangGraphGenerator.displayName(node), strval(cfg['description'] ?? ''), wfName);
            }
            const dispatch: any[] = dispatchTargets[nid] ?? [];
            if (dispatch.length !== 0) {
                systemPrompt = rtrim(systemPrompt) + '\n\n' + DispatchRouting.promptBlock(dispatch as any);
            }
            if (has(routedBy, nid)) {
                systemPrompt = rtrim(systemPrompt) + '\n\n' + DispatchRouting.routedPrompt(LangGraphGenerator.displayName(node), routedBy[nid], '');
            }

            // Per-agent sampling/limits saved by the editor under `settings`.
            // Defaults mirror the editor form defaults so a regenerated
            // script behaves the same as the PHP runner.
            let cfgSettings = cfg['settings'] ?? [];
            if (!is_array(cfgSettings)) {
                cfgSettings = [];
            }
            const agentTemperature = F(cfgSettings['temperature'] ?? 0.7);
            // max_tokens comes from the agent form VERBATIM -- no substitution.
            const agentMaxTokens = intval(cfgSettings['max_tokens'] ?? 4096);

            for (const tn of toolNames) {
                allNeededTools[tn] = true;
            }
            const minConf = routingSettings['min_confidence'] ?? routingSettings['jev_min_confidence'] ?? null;
            const mode = trim(strval(routingSettings['routing_mode'] ?? ''));
            agentData[nid] = {
                display: LangGraphGenerator.displayName(node),
                system_prompt: systemPrompt,
                tool_names: toolNames,
                provider: strtolower(agentProvider),
                model: agentModel,
                temperature: agentTemperature,
                max_tokens: agentMaxTokens,
                // Per-agent Thinking switch ('on'|'off'|null) — node form attribute.
                thinking: in_array(cfgSettings['thinking'] ?? null, ['on', 'off'], true) ? cfgSettings['thinking'] : null,
                skills: skills,
                dispatch: dispatch,
                // The question a decision model answers for this dispatcher, computed exactly as
                // the interpreter does (DispatchRouting::defaultInstructions over the agent's
                // name, description and the workflow name) -- not the node's system prompt.
                decision_question: dispatch.length !== 0
                    ? DispatchRouting.defaultInstructions(dispatcherName, dispatcherDesc, wfName)
                    : '',
                // Routing mode as GraphWorkflowRunner reads it: 'llm', a decision provider
                // key, or '' (unset: the first candidate whose key is set, else the model).
                routing_mode: mode,
                // The branch (by name) a not-classified request goes to (DispatchRouting::unclearBranch); '' = stop.
                unclear_branch: trim(strval(routingSettings['unclear_branch'] ?? '')),
                // Same clamp as the interpreter: min_confidence, else jev_min_confidence, else the default.
                min_confidence: is_numeric(minConf)
                    ? F(Math.max(0.0, Math.min(1.0, floatval(minConf))))
                    : F(DEFAULT_CONFIDENCE_FLOOR),
                decision: dispatch.length !== 0 ? await this.decisionCandidates(mode) : [],
            };
        }

        // Playbook nodes: bind the playbook's #Actions against the registry at
        // generation time (same PlaybookAnalyzer the browser runner uses) and
        // bake what the emitted playbook runtime needs.
        const playbookData: any = oarr();
        const playbookServerUrls: any = oarr();
        for (const nid of order) {
            const node = byId[nid];
            if (LangGraphGenerator.nodeType(node) !== 'playbook') {
                continue;
            }
            const pd: any = PlaybookSource.isFromInput(is_array(node['config'] ?? null) ? node['config'] : {})
                ? await PlaybookEmit.inputNodeData(node, providerDefaults, userId)
                : await this.playbookData(node, availableById, providerDefaults, userId);
            // Exits (["done", "failed"]): port output_k is exit k, wired like a code node's.
            const exits = node['config']?.['exits'] ?? null;
            if (is_array(exits) && count(exits) !== 0) {
                pd['exits'] = values(exits).map(strval);
                pd['exit_targets'] = CodeNodeEmit.exitTargets(strval(nid), pd['exits'], graph['edges'] ?? [], keysOf(byId));
            }
            playbookData[nid] = pd;
        }
        // "From input" nodes run whichever published playbook the job names: bake every robot
        // copy (the compiled program never reads the database).
        let publishedPlaybooks: any = oarr();
        let publishedSkipped: any = oarr();
        if (values(playbookData).some((pd: any) => (pd['source'] ?? 'fixed') === 'input')) {
            [publishedPlaybooks, publishedSkipped] = await this.publishedPlaybooks(availableById, providerDefaults, userId);
        }
        for (const pd of [...values(playbookData), ...values(publishedPlaybooks)]) {
            for (const a of values(pd['actions'])) {
                if ((a['kind'] ?? '') === 'mcp') {
                    playbookServerUrls[a['server_url']] = true;
                }
            }
        }

        // Code nodes: validated settings, exit -> children from the edges' ports, and the MCP
        // servers their declared tools live on (spec §5).
        // Every registered server name resolves, including a second one sharing a URL (refused below if both are used).
        const slugToUrl: any = oarr();
        const slugName: any = oarr();
        for (const t of mcpTools) {
            const surl = strval(t['server_url'] ?? '');
            if (surl !== '') {
                const slg = CodeNodeEmit.slug(strval(t['server_name'] ?? ''));
                slugToUrl[slg] = surl;
                slugName[slg] = strval(t['server_name'] ?? '');
            }
        }
        const codeData: any = oarr();
        const codeServerUrls: any = oarr();
        for (const nid of order) {
            if (LangGraphGenerator.nodeType(byId[nid]) !== 'code') {
                continue;
            }
            codeData[nid] = CodeNodeEmit.nodeData(byId[nid], graph['edges'] ?? [], slugToUrl, keysOf(byId));
            for (const surl of values(codeData[nid]['servers'])) {
                codeServerUrls[surl] = true;
            }
        }
        const codeSlugs: any = oarr();
        for (const cd of values(codeData)) {
            for (const slg of values(cd['mcp_servers'])) {
                codeSlugs[slg] = slugToUrl[slg];
            }
        }

        // Filter catalog to only tools actually used by agents
        const usedCatalog: any = oarr();
        for (const [k, v] of entries(toolCatalog)) {
            if (has(allNeededTools, k)) {
                usedCatalog[k] = v;
            }
        }
        // Filter MCP_SERVERS the same way: keep only the servers whose tools are actually used.
        const usedServers: any = oarr();
        for (const entry of values(usedCatalog)) {
            const surl = entry['server_url'] ?? '';
            if (surl !== '' && has(serverRegistry, surl)) {
                usedServers[surl] = { ...serverRegistry[surl] };
            }
        }
        for (const surl of keysOf(playbookServerUrls)) {
            if (has(serverRegistry, surl)) {
                usedServers[surl] = { ...serverRegistry[surl] };
            }
        }
        for (const surl of keysOf(codeServerUrls)) {
            if (has(serverRegistry, surl)) {
                usedServers[surl] = { ...serverRegistry[surl] };
            }
        }
        // The registry is keyed by URL: two used servers on one URL (two mailboxes on one Outlook MCP,
        // told apart only by their headers) would collapse into one connection. Refuse; a single used
        // server on a shared URL keeps its own name (and so its own header variable).
        const usedNamesByUrl: any = oarr();
        for (const surl of keysOf(usedServers)) {
            usedNamesByUrl[surl] = oarr();
        }
        const nameAt = (surl: string): any => (usedNamesByUrl[surl] ??= oarr());
        for (const cd of values(codeData)) {
            for (const slg of values(cd['mcp_servers'])) {
                nameAt(slugToUrl[slg])[slg] = slugName[slg] ?? slg;
            }
        }
        for (const pd of [...values(playbookData), ...values(publishedPlaybooks)]) {
            for (const a of values(pd['actions'])) {
                if ((a['kind'] ?? '') === 'mcp') {
                    const slg = LangGraphGenerator.serverSlug(explode('.', strval(a['target']), 2)[0]);
                    nameAt(a['server_url'])[slg] = slugName[slg] ?? slg;
                }
            }
        }
        for (const entry of values(usedCatalog)) {
            const surl = strval(entry['server_url'] ?? '');
            if (has(usedServers, surl)) {
                const name = strval(usedServers[surl]['name'] ?? '');
                nameAt(surl)[CodeNodeEmit.slug(name)] = name;
            }
        }
        for (const [surl, namesMap] of entries(usedNamesByUrl)) {
            const names = values(namesMap);
            if (names.length > 1) {
                throw new Error('MCP servers "' + names[0] + '" and "' + names[1] + '" share the URL ' + surl
                    + '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                    + ' server instance on its own URL and register that.');
            }
            if (names.length === 1 && has(usedServers, surl)) {
                usedServers[surl]['name'] = names[0];
            }
        }
        // Header env names (MCP_HEADERS_<SLUG>) are per server name: two servers this workflow
        // uses must not share a slug, or one's connection key would go to the other.
        const serverSlugs: any = oarr();
        const slugOwner: any = oarr();
        for (const [surl, meta] of entries(usedServers)) {
            const slg = CodeNodeEmit.slug(strval(meta['name'] ?? ''));
            if (has(slugOwner, slg) && slugOwner[slg]['url'] !== strval(surl)) {
                throw new Error('MCP servers "' + slugOwner[slg]['name'] + '" and "' + strval(meta['name'] ?? '')
                    + '" both map to MCP_HEADERS_' + strtoupper(slg) + '; rename one so each server has its own header variable.');
            }
            slugOwner[slg] = { url: strval(surl), name: strval(meta['name'] ?? '') };
            serverSlugs[strval(surl)] = slg;
        }
        // Flag tools that agents need but aren't available as MCP.
        // run_skill_script is a LOCAL (non-MCP) tool registered directly into
        // the catalog at runtime, so it's not in toolCatalog — exclude it from
        // the "missing" warning (it IS available).
        const missing: string[] = [];
        for (const tn of keysOf(allNeededTools)) {
            if (tn === 'run_skill_script') {
                continue;
            }
            if (!(tn in toolCatalog)) {
                missing.push(tn);
            }
        }
        sortStrings(missing);

        const edgeList: string[][] = [];
        for (const e of edges) {
            edgeList.push([LangGraphGenerator.edgeFrom(e), LangGraphGenerator.edgeTo(e)]);
        }
        // Architecture is a property of the workflow, not of the build (§10).
        const orchestration = workflow.getOrchestration();
        // The Start option, if any: the hidden code node StartOptionGraph::expand added (spec 2026-10-15 §2).
        let triggerNodeId: string | null = null;
        let startTrigger: any = null;
        let startArgs: any = [];
        for (const nid of order) {
            const st = (byId[nid]['config'] ?? [])['start_trigger'] ?? null;
            if (LangGraphGenerator.nodeType(byId[nid]) === 'code' && is_array(st)) {
                triggerNodeId = strval(nid);
                startTrigger = st;
                const a = byId[nid]['config']?.['args'] ?? null;
                startArgs = is_array(a) ? a : [];   // the Start's start_args
                break;
            }
        }
        const defaultCron = await this.defaultCron(workflowId);
        const startMode = startTrigger !== null ? 'watch' : (defaultCron !== null ? 'cron' : 'prompt');
        const defaultWatch: any = startTrigger !== null
            ? this.watchFromTrigger(is_array(startTrigger['watch'] ?? null) ? startTrigger['watch'] : [], serverSlugs)
            : await this.defaultWatch(workflowId, serverSlugs);
        if (startTrigger !== null && defaultWatch !== null) {   // the Start's tag and pass_args values (spec 2026-10-22 §6.1)
            const pass = startTrigger['pass_args'] ?? [];
            defaultWatch['args'] = StartTriggerFacts.watchArgs(defaultWatch['args'], startArgs, is_array(pass) ? values(pass) : []);
        }
        const workExit = startTrigger !== null ? strval(startTrigger['work_exit'] ?? '') : null;
        const startOptionLabel = startTrigger !== null ? strval(startTrigger['label'] ?? 'Start option') : null;
        return {
            workflow, workflowId, userId, wfName, safeName, gdata, byId, order, edges,
            startPrompt, startDocuments, providerDefaults, serverRegistry, toolCatalog, availableById,
            dispatchTargets, routedBy, agentData, playbookData, publishedPlaybooks, publishedSkipped, codeData, codeSlugs, serverSlugs, usedCatalog, usedServers, missing, edgeList,
            orchestration, defaultCron, defaultWatch, startMode, triggerNodeId, workExit, startOptionLabel,
        };
    }

    /** A saved agent as PHP's Agent::toArray() reads (the TypeScript Agent record, or an array already). */
    private static agentArray(a: any): any {
        return a && typeof a === 'object' && 'userId' in a ? agentToArray(a) : a;
    }

    /** json_decode($s, true) of a settings string. */
    private static assoc(s: string): any {
        const v = jsonDecodeStd(s);
        return v === null ? null : LangGraphGenerator.unStd(v);
    }

    private static unStd(v: any): any {
        if (Array.isArray(v)) return v.map((x) => LangGraphGenerator.unStd(x));
        if (v !== null && typeof v === 'object' && !(v instanceof PhpFloat)) {
            return oarr(entries(v).map(([k, x]) => [k, LangGraphGenerator.unStd(x)] as [string, any]));
        }
        return v;
    }

    /** Tool names from a node's or agent's `tools` / `selectedTools` (strings or {name}), without the mcp_ prefix. */
    private static toolNamesOf(rawTools: any): string[] {
        const out: string[] = [];
        for (const tool of values(rawTools)) {
            let tname: any = null;
            if (is_string(tool)) {
                tname = tool;
            } else if (is_array(tool)) {
                tname = tool['name'] ?? tool['tool_name'] ?? null;
            }
            if (truthy(tname)) {
                tname = strval(tname);
                if (tname.startsWith('mcp_')) {
                    tname = substr(tname, 4);
                }
                out.push(tname);
            }
        }
        return out;
    }

    /** The workflow's active cron schedule (newest scheduled_workflows row), baked as DEFAULT_CRON for --cron. */
    private async defaultCron(workflowId: number): Promise<string | null> {
        try {
            const r = (await sql<any>`SELECT cron FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND repeat_type = 'cron' AND status <> 'paused' ORDER BY id DESC LIMIT 1`.execute(db)).rows[0];
            const c = r === undefined ? false : r['cron'];
            return is_string(c) && c !== '' ? c : null;
        } catch {
            return null;   // no schedules table, or an older one without the cron column: no default
        }
    }

    /**
     * The workflow's event trigger (newest non-paused scheduled_workflows row with repeat_type 'event'),
     * baked as DEFAULT_WATCH for --watch: {server: slug, tool, args}, or null.
     * event_trigger holds {"server": <server name>, "tool", "args"}. The trigger's server must be one the
     * workflow uses (its URL and MCP_HEADERS_<SLUG> come from there): another one is a compile error.
     */
    private async defaultWatch(workflowId: number, serverSlugs: any): Promise<any> {
        let raw: any;
        try {
            const r = (await sql<any>`SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ${workflowId} AND repeat_type = 'event' AND status <> 'paused' ORDER BY id DESC LIMIT 1`.execute(db)).rows[0];
            raw = r === undefined ? false : r['event_trigger'];
        } catch {
            return null;   // no schedules table, or one without the event_trigger column yet: no default
        }
        const t = is_string(raw) ? LangGraphGenerator.assoc(raw) : null;
        if (!is_array(t) || trim(strval(t['server'] ?? '')) === '' || trim(strval(t['tool'] ?? '')) === '') {
            return null;
        }
        return this.watchFromTrigger(t, serverSlugs);
    }

    /** {server, tool, args} (server = a name) as DEFAULT_WATCH, the server slugged; one the workflow does not use is an error. */
    private watchFromTrigger(t: any, serverSlugs: any): any {
        if (trim(strval(t['server'] ?? '')) === '' || trim(strval(t['tool'] ?? '')) === '') {
            return null;
        }
        const slug = CodeNodeEmit.slug(strval(t['server']));
        if (!in_array(slug, serverSlugs, true)) {
            throw new Error('The event trigger waits on MCP server "' + strval(t['server']) + '", which no node of this'
                + ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).');
        }
        return { server: slug, tool: strval(t['tool']), args: is_array(t['args'] ?? null) ? t['args'] : [] };
    }

    /** START_MODE / WORK_EXIT / TRIGGER_NODE_ID: the Start's mode and its option's work exit and node (spec 2026-10-15 §2). */
    private static startModeLines(facts: any): any {
        let s: any;
        s = (v: any) => v === null || v === undefined || v === '' ? 'None' : PythonEmitHelpers.pyStr(v);
        return ['START_MODE = ' + PythonEmitHelpers.pyStr(facts['startMode']),
            'WORK_EXIT = ' + s(facts['workExit']),
            'TRIGGER_NODE_ID = ' + s(facts['triggerNodeId'])];
    }

    /** DEFAULT_WATCH's line: the baked event trigger, or None. */
    private static defaultWatchLine(facts: any): string {
        return 'DEFAULT_WATCH = ' + ((facts['defaultWatch'] ?? null) === null ? 'None'
            : PythonEmitHelpers.jsonToPython({ server: facts['defaultWatch']['server'], tool: facts['defaultWatch']['tool'], args: toObject(facts['defaultWatch']['args']) }));
    }

    /** TO RUN lines for --watch (single file and modular package: the modes with code nodes). */
    private static watchDocLines(facts: any, file: any): any {
        let w: any;
        w = facts['defaultWatch'] ?? null;
        return [`python ${file} --watch           # run whenever the event trigger says something new arrived`
            + (w !== null ? ` (${w['server']}.${w['tool']})` : ' (none saved: pass one)'),
            `python ${file} --watch 'outlook.wait_for_new {"args": {"folder": "Inbox"}}'   # or any server.tool + JSON arguments`,
            '# --watch: the tool answers {"status": "ready" | "timeout"}; on ready the workflow runs and drains as a --cron tick does'];
    }

    /** TO RUN lines for the default mode and --once (single file and modular package: the entry files with choose_mode). */
    private static modeDocLines(file: any): any {
        return [`python ${file}                   # the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)`,
            `python ${file} --once "text"     # one run on "text", even when the Start listens or is scheduled`,
            `python ${file} --quiet | --verbose   # print only each run's done / failed line | also each node's output`,
            '# runs/<date>_<run id>.jsonl: each real run\'s events (RUNS_DIR overrides); a quiet run (nothing to do) leaves none'];
    }

    /** DEFAULT_CRON's line: the baked schedule, or None. */
    private static defaultCronLine(facts: any): string {
        return 'DEFAULT_CRON = ' + (facts['defaultCron'] === null ? 'None' : PythonEmitHelpers.pyStr(facts['defaultCron']));
    }

    /** TO RUN lines for --cron, naming the entry file $file. */
    private static cronDocLines(facts: any, file: any): any {
        return [`python ${file} --cron            # loop on the Start node schedule`
            + ((facts['defaultCron'] ?? null) !== null ? ` (${facts['defaultCron']})` : ' (none saved: pass an expression)'),
            `python ${file} --cron "*/5 8-18 * * 1-5"   # or any 5-field cron, Ctrl-C (or SIGTERM) to stop`,
            `python ${file} "your prompt here" --cron   # a prompt goes BEFORE --cron (after it, it is read as the expression)`,
            ...(!empty(facts?.['codeData'])
                ? ['# --cron with code nodes: a run that did work runs again at once (up to 20 per tick); work = a non-empty'
                    + ' final output, so a code -> agent chain needs an Output node to drain']
                : [])];
    }

    /** Kebab-case ASCII slug for file names (max 40 chars). */
    private static slug(name: any): string {
        let ascii: any, s: any;
        // //TRANSLIT spells an accented letter as "'e" / "`a" on glibc and macOS
        // alike; drop those marks first so "Rédacteur" slugs to "redacteur"
        // rather than "r-edacteur".
        ascii = str_replace(["'", '"', '`', '^', '~'], '', asciiTranslit(name));
        s = strtolower(trim(strval(preg_replace('/[^a-z0-9]+/i', '-', ascii)), '-'));
        return substr(s !== '' ? s : 'node', 0, 40);
    }

    /**
     * The `_make_llm(provider, model, temperature, max_tokens, thinking)` factory, one emitted
     * line per entry. LangGraph no longer calls this: it emits LangGraphRuntime::llmFactoryBlock().
     * PUBLIC because the playbook node needs it on every target: PlaybookEmit's
     * interpreter is a LangChain agent loop, so a target emitting a playbook
     * node emits this factory too (see PlaybookEmit::supportBlock()).
     */
    static llmFactoryLines(): any {
        let lines: any;
        lines = [];
        lines.push('def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096, thinking=None):');
        lines.push('    """Build a LangChain chat model for the given provider/model.');
        lines.push('');
        lines.push('    The (provider, model) pair was resolved by the generator: the');
        lines.push('    agent\'s explicit model overrides the provider\'s default from');
        lines.push('    system_llm_settings, and that result is what reaches this');
        lines.push('    function. No hardcoded model fallbacks here: every value was read');
        lines.push('    from the database when this file was generated (the script never');
        lines.push('    reads it), so a model changed in the editor takes effect at the');
        lines.push('    next Generate Python.');
        lines.push('');
        lines.push('    Recognised providers (case-insensitive):');
        lines.push('      claude     → langchain_anthropic.ChatAnthropic');
        lines.push('      openai     → langchain_openai.ChatOpenAI');
        lines.push('      gemini     → langchain_google_genai.ChatGoogleGenerativeAI');
        lines.push('      grok       → ChatOpenAI on https://api.x.ai/v1');
        lines.push('      deepseek   → ChatOpenAI on https://api.deepseek.com');
        lines.push('      kimi       → ChatOpenAI on https://api.moonshot.ai/v1');
        lines.push('      glm        → ChatOpenAI on https://api.z.ai/api/paas/v4');
        lines.push('');
        lines.push('    Reads API keys from the environment (loaded from .env at startup).');
        lines.push('    An entry point (gateway) replaces a vendor link via <PREFIX>_BASE_URL:');
        lines.push('    XAI_/DEEPSEEK_/KIMI_/GLM_BASE_URL here; ANTHROPIC_BASE_URL and');
        lines.push('    OPENAI_BASE_URL are read by the Anthropic / OpenAI clients themselves.');
        lines.push('    """');
        lines.push('    p = (provider or "claude").lower()');
        lines.push('    if MODEL_NAME_OVERRIDE:');
        lines.push('        model = MODEL_NAME_OVERRIDE');
        lines.push('    if not model:');
        lines.push('        raise RuntimeError(');
        lines.push('            f"No model specified for provider {p!r}. "');
        lines.push('            "Set a model name on the agent in the workflow editor, "');
        lines.push('            "or set the environment variable MODEL_NAME."');
        lines.push('        )');
        lines.push('    match p:');
        lines.push('        case "claude":');
        lines.push('            from langchain_anthropic import ChatAnthropic');
        lines.push('            return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)');
        lines.push('        case "openai":');
        lines.push('            from langchain_openai import ChatOpenAI');
        lines.push('            return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)');
        lines.push('        case "gemini":');
        lines.push('            from langchain_google_genai import ChatGoogleGenerativeAI');
        lines.push('            return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)');
        lines.push('        case "grok":');
        lines.push('            from langchain_openai import ChatOpenAI');
        lines.push('            return ChatOpenAI(');
        lines.push('                model=model,');
        lines.push('                base_url=os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1",');
        lines.push('                api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),');
        lines.push('                temperature=temperature,');
        lines.push('                max_tokens=max_tokens,');
        lines.push('            )');
        lines.push('        case "deepseek":');
        lines.push('            from langchain_openai import ChatOpenAI');
        lines.push('            kwargs = dict(');
        lines.push('                model=model,');
        lines.push('                base_url=os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",');
        lines.push('                api_key=os.environ.get("DEEPSEEK_API_KEY"),');
        lines.push('                temperature=temperature,');
        lines.push('                max_tokens=max_tokens,');
        lines.push('            )');
        lines.push('            if model.startswith(("deepseek-v4", "deepseek-flash")):');
        lines.push('                # The node form Thinking attribute governs (platform parity):');
        lines.push('                # off -> disabled, form temperature kept; on/default -> V4 thinking');
        lines.push('                # stays enabled and the API rejects sampling params, so temperature');
        lines.push('                # is dropped (set Thinking=Off on the node to use a temperature).');
        lines.push('                if thinking == "off":');
        lines.push('                    kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}');
        lines.push('                else:');
        lines.push('                    kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "enabled"}}}');
        lines.push('                    if "temperature" in kwargs:');
        lines.push('                        print(f"[info] deepseek {model}: temperature dropped (thinking mode)", flush=True)');
        lines.push('                        kwargs.pop("temperature", None)');
        lines.push('            return ChatOpenAI(**kwargs)');
        lines.push('        case "kimi":');
        lines.push('            from langchain_openai import ChatOpenAI');
        lines.push('            # Kimi is OpenAI-compatible. The node form Thinking attribute governs');
        lines.push('            # K2 reasoning mode (default off, matching the PHP KimiProvider); the');
        lines.push('            # API then constrains sampling: thinking OFF -> temperature MUST be 0.6,');
        lines.push('            # thinking ON -> 1.0 (provider CONSTRAINT, not a preference override).');
        lines.push('            _k2 = model.startswith("kimi-k2")');
        lines.push('            if _k2:');
        lines.push('                _want = 1.0 if thinking == "on" else 0.6');
        lines.push('                if temperature != _want:');
        lines.push('                    print(f"[info] kimi {model}: temperature {temperature} -> {_want} (model constraint)", flush=True)');
        lines.push('                    temperature = _want');
        lines.push('            kwargs = dict(');
        lines.push('                model=model,');
        lines.push('                base_url=os.environ.get("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",');
        lines.push('                api_key=os.environ.get("KIMI_API_KEY"),');
        lines.push('                temperature=temperature,');
        lines.push('                max_tokens=max_tokens,');
        lines.push('            )');
        lines.push('            if _k2:');
        lines.push('                _mode = "enabled" if thinking == "on" else "disabled"');
        lines.push('                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": _mode}}}');
        lines.push('            return ChatOpenAI(**kwargs)');
        lines.push('        case "glm":');
        lines.push('            from langchain_openai import ChatOpenAI');
        lines.push('            # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible.');
        lines.push('            return ChatOpenAI(');
        lines.push('                model=model,');
        lines.push('                base_url=os.environ.get("GLM_BASE_URL") or "https://api.z.ai/api/paas/v4",');
        lines.push('                api_key=os.environ.get("GLM_API_KEY"),');
        lines.push('                temperature=temperature,');
        lines.push('                max_tokens=max_tokens,');
        lines.push('                # GLM 5.2 defaults to heavy reasoning; disable thinking for direct answers.');
        lines.push('                model_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},');
        lines.push('            )');
        lines.push('        case _:');
        lines.push('            raise RuntimeError(');
        lines.push('                f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi, glm."');
        lines.push('            )');
        return lines;
    }

    /**
     * The single WORKFLOW_VERSION literal baked into both the orchestrator
     * and every agent file, so the supervisor's version check (see
     * a2aOrchestratorBlock()) can never see them drift: both emitters call
     * this helper instead of formatting the string themselves.
     */
    private static a2aVersion(facts: any): string {
        return facts['workflowId'] + '-' + date('Ymd');
    }

    /**
     * File names, ports and kinds of the A2A agents, in ORDER: one per
     * agent/playbook node. Port = A2A base (8701) + index; the emitted
     * orchestrator lets the environment override both.
     */
    static a2aLayout(facts: any): any {
        let agents: any, i: any, ad: any, kind: any, display: any;
        agents = oarr();
        i = 0;
        for (let nid of values(facts['order'])) {
            if (((facts?.['agentData']?.[nid]) != null)) {
                ad = facts['agentData'][nid];
                kind = !empty(ad?.['dispatch']) ? 'dispatcher' : 'agent';
                display = ad['display'];
            } else if (((facts?.['playbookData']?.[nid]) != null)) {
                kind = 'playbook';
                display = facts['playbookData'][nid]['display'];
            } else {
                continue;
            }
            agents[nid] = { file: `agents/${nid}_` + LangGraphGenerator.slug(display) + '.py', slug: LangGraphGenerator.slug(display), port: 8701 + i, display: display, kind: kind };
            i++;
        }
        return { root: facts['safeName'] + '_a2a', agents: agents };
    }

    /** A2A mode: orchestrator, then api.py (same run contract as the modular package), then one agent file per agent/playbook node (see a2aLayout). */
    private generateA2A(facts: any): any {
        let layout: any, files: any;
        layout = LangGraphGenerator.a2aLayout(facts);
        files = [
            { path: 'orchestrator.py', code: this.emitA2AOrchestrator(facts, layout) },
            { path: 'api.py', code: this.emitA2AApi(facts, layout) },
        ];
        for (let [nid, e] of entries(layout['agents'])) {
            files.push({ path: e['file'], code: this.emitA2AAgentFile(facts, layout, strval(nid)) });
        }
        files.push(...LangGraphPackage.a2aFiles(facts, layout));
        return LangGraphGenerator.withArchitecture({ root: layout['root'], files: files }, facts, 'a2a');
    }

    /** orchestrator.py: the graph, the agent endpoint table, the supervisor and the A2A node runner. */
    private emitA2AOrchestrator(facts: any, layout: any): string {
        let j: any, esc: any, sep: any, nodes: any, docById: any, endpoints: any, body: any, L: any, i: any, dispatch: any, typeMap: any;
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);
        sep = '# ' + str_repeat('=', 62);
        nodes = this.a2aDocNodes(facts, layout);
        docById = oarr();
        for (let dn of values(nodes)) docById[dn['id']] = dn;
        endpoints = [];
        for (let [nid, e] of entries(layout['agents'])) {
            endpoints.push(sprintf('  %-6s %-24s %-32s http://127.0.0.1:%d/   (env A2A_AGENT_%s_URL)', nid, e['display'], e['file'], e['port'], nid));
        }
        body = PythonEmitHelpers.workflowDocBlock({ target: 'LangGraph A2A orchestrator (Python) -- StateGraph over A2A tasks, one agent process per node', dispatch_supported: true, workflow: { id: facts['workflowId'], name: facts['wfName'] }, nodes: nodes, edges: facts['edgeList'], layers: facts['gdata']['layers'] ?? [], data_flow: LangGraphGenerator.a2aOrchestratorDataFlowDoc(), run: { deps: [LangGraphPackage.PIP_REQUIREMENTS], usage: 'python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]', extra: array_merge(['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.'],
                          LangGraphGenerator.decisionDocLines(facts['agentData'] ?? []), LangGraphGenerator.mcpHeaderDocLines(facts), LangGraphGenerator.cronDocLines(facts, 'orchestrator.py')), env_path: '../../.env' }, storage: { enabled: facts['workflow'].isOutputStorageEnabled(), folder: facts['workflow'].getOutputFolder() } });
        body += '\n\nAGENT ENDPOINTS  (id, name, file, default URL; env override)\n===============\n' + implode('\n', endpoints)
            + '\n\nA2A RUN\n=======\n'
            + '  1. AgentSupervisor starts every local agent (python <file> --port N) and waits for its card.\n'
            + '  2. Each agent node = one A2A task: the framed input goes in as text, status updates are\n'
            + '     relayed as [<agent>] lines, an input-required status is a GATE (answered on the console,\n'
            + '     or by PLAYBOOK_GATE_MODE when no terminal), the \'result\' artifact is the node output\n'
            + '     (+ data {route, notes, status}; a dispatcher\'s route drives the conditional edge).\n'
            + '  3. Start and Output run locally; the Output merges parent outputs verbatim.\n'
            + '  4. Agents are stopped at the end unless --keep-serving; --no-spawn expects them reachable.';

        L = [];
        L.push('"""A2A orchestrator for workflow ' + j(facts['wfName']));
        L.push('');
        for (let dl of values(explode('\n', esc(body)))) L.push(dl);
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid');
        L.push('from datetime import datetime, timedelta');
        L.push('from pathlib import Path');
        L.push('from typing import Annotated, Awaitable, Callable, TypedDict');
        L.push('');
        L.push('from dotenv import load_dotenv');
        L.push('# This file lives in <root>/; the runner .env is two levels up (python/.env).');
        L.push('_HERE = os.path.dirname(os.path.abspath(__file__))');
        L.push('load_dotenv(os.path.join(_HERE, ".env"))   # the workflow folder\'s own .env first (never overridden)');
        L.push('load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))');
        L.push('PACKAGE_DIR = _HERE   # this program\'s folder: a relative Start document path resolves here');
        L.push('');
        L.push('import httpx');
        L.push('from langgraph.graph import END, START, StateGraph');
        L.push('from a2a import types as T');
        L.push('from a2a.client import create_client, ClientConfig');
        L.push('from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts');
        L.push('');
        L.push('WORKFLOW_ID = ' + intval(facts['workflowId']));
        L.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(facts['wfName']));
        // Same literal every agent file bakes (see a2aVersion()) -- the supervisor
        // rejects a port already serving a DIFFERENT version instead of adopting it.
        L.push('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator.a2aVersion(facts)));
        L.push('OUTPUT_STORAGE_ENABLED = ' + (facts['workflow'].isOutputStorageEnabled() ? 'True' : 'False'));
        L.push('OUTPUT_FOLDER = ' + ((facts['workflow'].getOutputFolder() ?? '') !== '' ? PythonEmitHelpers.pyStr(strval(facts['workflow'].getOutputFolder())) : 'None'));
        L.push('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(facts['startPrompt']));
        L.push(LangGraphGenerator.defaultCronLine(facts));
        L.push('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(truthy(facts['startDocuments']) ? facts['startDocuments'] : []));
        L.push('A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "8701"))   # agent i listens on A2A_BASE_PORT + i');
        L.push('');
        L.push(sep); L.push('# AGENTS -- the endpoint table (one A2A server per agent/playbook node)'); L.push(sep);
        L.push('AGENTS = {');
        i = 0;
        for (let [nid, e] of entries(layout['agents'])) {
            for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ')))) L.push(cl);
            dispatch = e['kind'] === 'dispatcher' ? array_map((t: any) => ({ id: strval(t['id']), name: t['name'] }), facts['agentData'][nid]['dispatch']) : [];
            L.push('    ' + j(strval(nid)) + ': {"display": ' + j(e['display']) + ', "file": ' + j(e['file']) + ', "kind": ' + j(e['kind'])
                + ', "port": ' + e['port'] + ', "index": ' + i + ', "dispatch": ' + j(dispatch) + '},');
            i++;
        }
        L.push('}');
        L.push('');
        L.push(sep); L.push('# GRAPH STRUCTURE (same shape as the single-file script)'); L.push(sep);
        L.push('EDGES = ' + PythonEmitHelpers.jsonToPython(facts['edgeList']));
        L.push('ORDER = ' + PythonEmitHelpers.jsonToPython(facts['order']));
        typeMap = oarr();
        for (let nid of values(facts['order'])) typeMap[nid] = ((layout?.['agents']?.[nid]) != null) ? (layout['agents'][nid]['kind'] === 'playbook' ? 'playbook' : 'agent') : LangGraphGenerator.nodeType(facts['byId'][nid]);
        L.push('NODE_TYPES = ' + PythonEmitHelpers.jsonToPython(typeMap, true));
        L.push('');
        L.push('');
        L.push(LangGraphGenerator.stateBlock());
        L.push('');
        L.push(LangGraphGenerator.datetimeInjectorBlock());
        L.push('');
        L.push(LangGraphGenerator.contextBuilderBlock());
        L.push('');
        L.push(LangGraphRuntime.documentConverterBlock());
        // orchestrator.py carries no common.py, so the event sink + gate rendezvous
        // (installed by api.py, consumed by _handle_gate() below) is emitted here.
        L.push(sep); L.push('# EVENT SINK -- how api.py observes a run (inert for CLI runs)'); L.push(sep);
        L.push(LangGraphRuntime.runEventsBlock());
        L.push(LangGraphRuntime.runRecordBlock());
        L.push(LangGraphRuntime.consoleBlock());
        L.push(LangGraphRuntime.workflowGraphBlock());
        L.push(LangGraphRuntime.outputBlock());
        L.push(LangGraphRuntime.cronBlock());
        L.push(LangGraphGenerator.a2aOrchestratorBlock());
        return implode('\n', L) + '\n';
    }

    /** DATA FLOW text for the orchestrator. */
    private static a2aOrchestratorDataFlowDoc(): string {
        return `The orchestrator owns the graph and the human; the agents own the models,
tools and playbooks. Every agent node is one A2A task on that node's
server: the orchestrator sends the framed input (original prompt + labelled
parent outputs), relays status updates, answers gates, and takes the
'result' artifact as the node output. A dispatcher's chosen child comes back
in the artifact's data part and drives a LangGraph conditional edge, so only
that child runs. Start and Output nodes are local (no LLM).`;
    }

    /** api.py for the A2A folder: the same run contract as the modular package (see emitModularApi,
     *  which composes the shared RunServerEmitter::runtimeBlock() used verbatim below),
     *  plus the agent supervisor's lifecycle -- the agent servers start on the first run. */
    private emitA2AApi(facts: any, layout: any): string {
        let esc: any, L: any, body: any;
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);
        L = [];
        L.push('"""Run server for workflow ' + json_encode(facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) + ' (A2A)');
        L.push('');
        body = this.apiPyDocBody(facts,
            'LangGraph A2A run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            LangGraphPackage.PIP_REQUIREMENTS,
            ['# The agent servers start with the first run (see _ensure_agents) and stop with this process.',
             '# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
             '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
             '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)']);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, atexit, json, os, sys, time, uuid');
        L.push('');
        L.push('from fastapi import FastAPI, HTTPException, Request');
        L.push('from fastapi.middleware.cors import CORSMiddleware');
        L.push('from fastapi.responses import StreamingResponse');
        L.push('import uvicorn');
        L.push('');
        L.push('from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME');
        L.push('from orchestrator import set_event_sink, resolve_gate');
        L.push('');
        L.push('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator.a2aVersion(facts)));
        L.push('');
        L.push('# The agent servers start with the first run and stop with this process.');
        L.push('_SUPERVISOR = None');
        L.push('');
        L.push('');
        L.push('def _ensure_agents() -> None:');
        L.push('    """Start the A2A agent servers once, on the first run.');
        L.push('');
        L.push('    AgentSupervisor.start() is BLOCKING -- it spawns one subprocess per');
        L.push('    agent and polls each one\'s Agent Card for up to 60s. _drive() (see');
        L.push('    modularApiBlock below) calls this hook through asyncio.to_thread so');
        L.push('    the event loop stays free to serve /runs/<id>/events while the agents');
        L.push('    are still coming up, instead of stalling every request for that long.');
        L.push('    """');
        L.push('    global _SUPERVISOR');
        L.push('    if _SUPERVISOR is None:');
        L.push('        _SUPERVISOR = AgentSupervisor(spawn=True)');
        L.push('        # Registered BEFORE start() so a fleet that half-came-up is still');
        L.push('        # torn down. Nothing else stops these processes: the orchestrator');
        L.push('        # CLI does it in a finally, and this server has no such scope.');
        L.push('        atexit.register(_stop_agents)');
        L.push('        _SUPERVISOR.start()');
        L.push('');
        L.push('');
        L.push('def _stop_agents() -> None:');
        L.push('    """Shutdown hook: stop the agent fleet this process spawned.');
        L.push('');
        L.push('    Without it, a SIGTERM to this server leaves N agent processes');
        L.push('    running and holding ports 8701+, and the next start fails with');
        L.push('    "port may already be in use". Idempotent (the supervisor is cleared');
        L.push('    first, so a second call finds nothing) and non-raising -- a hook that');
        L.push('    throws on the way out only hides the real exit.');
        L.push('    """');
        L.push('    global _SUPERVISOR');
        L.push('    sup, _SUPERVISOR = _SUPERVISOR, None');
        L.push('    if sup is None:');
        L.push('        return');
        L.push('    try:');
        L.push('        sup.stop()');
        L.push('    except Exception as exc:   # noqa: BLE001 -- best effort on the way out');
        L.push('        print(f"[supervisor] stop failed: {exc}", flush=True)');
        L.push('');
        L.push(RunServerEmitter.runtimeBlock());
        return rtrim(implode('\n', L), '\n') + '\n';
    }

    /** Supervisor, remote node runner, gate handler, graph wiring, CLI entry. */
    private static a2aOrchestratorBlock(): string {
        return LangGraphGenerator.a2aRemoteBlock() + '\n' + `# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over A2A tasks
# ==============================================================
NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)


def build_graph() -> WorkflowGraph:
    """The workflow's graph (WorkflowGraph above): agent nodes call their A2A servers."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents=AGENTS,
                         run_node=_run_remote_node, start_documents=START_DOCUMENTS)


async def run(user_prompt: str, session: str | None = None) -> str:
    """Build the graph (agent nodes call their A2A servers), run it, return the final output.

    \`session\` is accepted so this signature matches api.py's run contract
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
            print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)
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
            sup.stop()`;
    }

    /**
     * The orchestrator's framework-free part: the agent supervisor, the gate handler and the remote node
     * runner (one A2A task per node). ADK, MAF and NOOA orchestrators copy it (CompiledA2AEmit).
     */
    static a2aRemoteBlock(): string {
        return `# ==============================================================
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
    """True when \`url\` is a loopback address the supervisor can spawn and own."""
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
        print(f"\\n✋ [{agent_name}] {kind}: {question}", flush=True)
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
    """Run node \`nid\` on its A2A server. Returns {"text", "route", "notes", "status"}."""
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
    out = {"text": "\\n".join(text_parts), "route": str(data.get("route") or ""), "notes": str(data.get("notes") or ""), "status": str(data.get("status") or "ok")}
    if out["text"]:
        EVENTS.emit(type="message", text=f"**{ad['display']}**\\n\\n{out['text']}", sensitive=False)
    EVENTS.emit(type="final", leg=nid, status=out["status"] or "ok")
    return out

`;
    }

    /**
     * One self-contained A2A agent server for node $nid. Reuses the same
     * Python blocks as the single-file script (LLM factory, MCP client, tool
     * builder, skills, playbook runtime, dispatcher tool) and adds the A2A
     * server block. Self-contained on purpose: the file can be copied to
     * another host alone (see the design's "duplication" decision).
     */
    private emitA2AAgentFile(facts: any, layout: any, nid: any): string {
        let entry: any, kind: any, isPlaybook: any, def: any, wfName: any, sep: any, j: any, esc: any, catalog: any, servers: any, L: any, docNodes: any;
        entry = layout['agents'][nid];
        kind = entry['kind'];
        isPlaybook = kind === 'playbook';
        def = isPlaybook ? facts['playbookData'][nid] : facts['agentData'][nid];
        wfName = facts['wfName'];
        sep = '# ' + str_repeat('=', 62);
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);

        // Tool catalog restricted to this node.
        catalog = oarr();
        if (!truthy(isPlaybook)) {
            for (let tn of values(def['tool_names'])) {
                if (((facts?.['usedCatalog']?.[tn]) != null)) {
                    catalog[tn] = facts['usedCatalog'][tn];
                }
            }
        }
        servers = oarr();
        for (let c of values(catalog)) {
            if (((facts?.['serverRegistry']?.[c['server_url']]) != null)) servers[c['server_url']] = facts['serverRegistry'][c['server_url']];
        }
        if (isPlaybook) {
            for (let a of values(def['actions'])) {
                if ((a['kind'] ?? '') === 'mcp' && ((facts?.['serverRegistry']?.[a['server_url']]) != null)) servers[a['server_url']] = facts['serverRegistry'][a['server_url']];
            }
        }

        L = [];
        // ---- module docstring (standard body + agent-specific sections) ----
        L.push('"""A2A agent ' + j(entry['display']) + ` -- node ${nid} of workflow ` + j(wfName));
        L.push('');
        for (let dl of values(explode('\n', esc(this.a2aDocBody(facts, layout, nid))))) L.push(dl);
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, json, os, ' + (isPlaybook ? 're, ' : '') + 'subprocess, sys, threading, time' + (isPlaybook ? ', uuid' : ''));
        L.push('from abc import ABC, abstractmethod');
        L.push('from dataclasses import asdict, dataclass, field');
        L.push('from enum import Enum');
        L.push('from functools import cached_property');
        L.push('from pathlib import Path');
        L.push('from typing import Callable, Literal');
        L.push('');
        L.push('from dotenv import load_dotenv');
        L.push('# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).');
        L.push('_HERE = os.path.dirname(os.path.abspath(__file__))');
        L.push('load_dotenv(os.path.join(os.path.dirname(_HERE), ".env"))   # the workflow folder\'s own .env first (never overridden)');
        L.push('RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))   # the runner env folder (python/)');
        L.push('load_dotenv(os.path.join(RUNNER_DIR, ".env"))');
        L.push('DEBUG_STEM = os.path.basename(os.path.dirname(_HERE))   # the package folder names this node\'s outputs/_debug dumps');
        L.push('');
        L.push('import httpx');
        L.push('import uvicorn');
        L.push('from starlette.applications import Starlette');
        L.push('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage');
        L.push('from langchain_core.tools import StructuredTool');
        L.push('try:');
        L.push('    from langchain.agents import create_agent as create_react_agent');
        L.push('except ImportError:');
        L.push('    from langgraph.prebuilt import create_react_agent');
        L.push('from pydantic import Field, create_model');
        L.push('from a2a import types as T');
        L.push('from a2a.server.agent_execution import AgentExecutor, RequestContext');
        L.push('from a2a.server.events import EventQueue');
        L.push('from a2a.server.request_handlers import DefaultRequestHandler');
        L.push('from a2a.server.tasks import InMemoryTaskStore, TaskUpdater');
        L.push('from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes');
        L.push('from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts');
        L.push('');
        L.push('MODEL_NAME_OVERRIDE = os.environ.get(\'MODEL_NAME\', \'\').strip()');
        L.push('');
        L.push('# This file is SELF-CONTAINED on purpose: the LLM factory, MCP client, tool');
        L.push('# builder, skill and playbook blocks below are the same code the single-file');
        L.push('# script carries, duplicated here so this agent can be copied to another host');
        L.push('# alone.');
        L.push(sep); L.push('# LLM FACTORY'); L.push('# Provider/model -> LangChain chat model (same rules as the single-file script).'); L.push(sep);
        L.push(LangGraphRuntime.llmFactoryBlock());
        L.push('');
        L.push(sep); L.push('# MCP SERVER REGISTRY + TOOL CATALOG (this node only)'); L.push(sep);
        L.push('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(servers, true));
        L.push('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(catalog, true));
        L.push('');
        L.push(sep); L.push('# MCP CLIENT -- JSON-RPC 2.0 over HTTP'); L.push(sep);
        L.push(LangGraphGenerator.serverSlugsLine(array_intersect_key(facts['serverSlugs'] ?? [], servers)));
        L.push('');
        L.push(LangGraphRuntime.mcpClientBlock());
        L.push(sep); L.push('# TOOL BUILDER + SKILL RUNTIME'); L.push(sep);
        L.push(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock());
        L.push(LangGraphRuntime.runEventsBlock());
        L.push(LangGraphRuntime.dispatcherBlock(LangGraphGenerator.decisionProtocolsUsed(facts['agentData'] ?? [])));
        L.push(LangGraphGenerator.datetimeInjectorBlock());
        if (isPlaybook) {
            L.push(LangGraphRuntime.runContextBlock());
            L.push(LangGraphRuntime.playbookBlock());
        }
        L.push(LangGraphRuntime.nodeClassesBlock(isPlaybook));
        L.push('');
        // ---- node definition ----
        L.push(sep); L.push('# NODE DEFINITION -- frozen from the workflow editor'); L.push(sep);
        docNodes = this.a2aDocNodes(facts, layout);
        for (let dn of values(docNodes)) {
            if (dn['id'] === nid) { for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(dn)))) L.push(cl); }
        }
        for (let nl of values(explode('\n', this.nodeDefinitionLines(facts, nid, kind, entry['display'], def, isPlaybook)))) L.push(nl);
        L.push('');
        L.push('# The executor below runs this node through run_node(request_text, trace).');
        L.push('run_node = make_node(NODE).run');
        L.push('');
        L.push('');
        L.push(LangGraphGenerator.a2aAgentServerBlock());
        L.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(wfName));
        L.push('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator.a2aVersion(facts)));
        L.push('# Default card (port from A2A_PORT or the layout); main() rebuilds it for the real host/port.');
        L.push('AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get(\'A2A_PORT\', \'' + entry['port'] + '\')}/")');
        L.push('');
        L.push('if __name__ == "__main__":');
        L.push('    main()');
        return implode('\n', L) + '\n';
    }

    /** docNodes descriptors for the A2A layout: every node, with the agent file recorded under 'file'. */
    private a2aDocNodes(facts: any, layout: any): any {
        let docAgents: any, docExtra: any, mcp: any, nodes: any, n: any;
        docAgents = oarr(); docExtra = oarr();
        for (let [n, ad] of entries(facts['agentData'])) {
            docAgents[n] = { name: ad['display'], provider: ad['provider'], model: ad['model'], temperature: ad['temperature'], max_tokens: ad['max_tokens'], thinking: ad['thinking'], tools: ad['tool_names'], skills: ad['skills'] };
            if (!empty(ad?.['dispatch'])) (docExtra[n] ??= {})['dispatch'] = array_column(ad['dispatch'], 'name');
        }
        for (let [n, pd] of entries(facts['playbookData'])) {
            mcp = count(array_filter(pd['actions'], (a: any) => (a['kind'] ?? '') === 'mcp'));
            (docExtra[n] ??= {})['playbook'] = { title: pd['title'], writes: pd['writes_enabled'], bound: mcp, unbound: count(pd['actions']) - mcp };
            docAgents[n] = { name: pd['display'], provider: pd['provider'], model: pd['model'], temperature: pd['temperature'], max_tokens: pd['max_tokens'], thinking: pd['thinking'], tools: [], skills: [] };
        }
        for (let [n, cd] of entries(facts['codeData'])) {
            docAgents[n] = { name: cd['display'], provider: '', model: '', temperature: null, max_tokens: null, thinking: null, tools: array_map((slg: any) => `${slg}.*`, cd['mcp_servers']), skills: [] };
        }
        nodes = GraphAnalyzer.docNodes(facts['byId'], facts['order'], facts['edges'], docAgents, docExtra,
            ['start', 'agent', 'agent-template', 'playbook', 'code', 'output']);
        for (let n of values(nodes)) { n['file'] = layout['agents'][n['id']]?.['file'] ?? ''; }
        return nodes;
    }

    /** Module-docstring body of an agent file: standard sections + NODE + A2A SERVING + TO RUN. */
    private a2aDocBody(facts: any, layout: any, nid: any): string {
        let nodes: any, n: any, entry: any, body: any;
        nodes = this.a2aDocNodes(facts, layout);
        // 'marker' (not 'name') so the "<== this agent" tag appears only on the
        // GRAPH NODES line -- GRAPH EDGES and EXECUTION ORDER read 'name' as-is.
        for (let n of values(nodes)) { if (n['id'] === nid) n['marker'] = '<== this agent'; }
        entry = layout['agents'][nid];
        body = PythonEmitHelpers.workflowDocBlock({ target: 'LangGraph A2A agent (Python) -- one A2A server for this node; the orchestrator drives the graph', dispatch_supported: true, workflow: { id: facts['workflowId'], name: facts['wfName'] }, nodes: nodes, edges: facts['edgeList'], layers: facts['gdata']['layers'] ?? [], data_flow: LangGraphGenerator.a2aAgentDataFlowDoc(), run: { deps: [LangGraphPackage.PIP_REQUIREMENTS], usage: 'python ' + entry['file'] + ' --port ' + entry['port'] + '   # from the workflow folder; A2A_HOST/A2A_PORT also honoured', extra: array_merge(['# Card: http://127.0.0.1:' + entry['port'] + '/.well-known/agent-card.json  --  JSON-RPC at /'],
                          LangGraphGenerator.decisionDocLines(facts['agentData'] ?? []), LangGraphGenerator.mcpHeaderDocLines(facts)), env_path: '../../../.env' }, storage: { enabled: false, folder: null } });
        return body + '\n\nA2A SERVING\n===========\n'
            + `  Skill id:   node-${nid}
`
            + '  Task in:    one text part = the node input the orchestrator built (original prompt + parent outputs)\n'
            + '  Task out:   artifact \'result\' = text part (node output) + data part {route, notes, status}\n'
            + '  Gates:      the task moves to input-required with data {gate, tool, args}; the orchestrator answers on\n'
            + '              the same task with data {decision, comment, fields}; the run resumes in memory.\n'
            + '              After A2A_GATE_TIMEOUT_S (default 900 s) with no answer the node run continues with\n'
            + '              timeout guidance, but its final artifact can no longer be delivered -- no A2A request\n'
            + '              is in flight to carry it, so the task stays stuck in input-required. Re-sending on the\n'
            + '              same task id to pick the result back up is not supported yet.\n'
            + '  One task at a time: runs are serialised with a lock; a second task waits for the first.';
    }

    /** DATA FLOW text for agent files. */
    private static a2aAgentDataFlowDoc(): string {
        return `This file serves ONE node of the workflow as an A2A agent. The orchestrator
(orchestrator.py in the parent folder) builds the node input, sends it as a
task, streams the status updates, answers gates, and reads the result
artifact. Inside this process the node runs exactly as in the single-file
script: an AGENT node = LangChain ReAct loop over its MCP tools plus
mandatory skill steps; a DISPATCHER node = one forced route_to call whose
choice travels back as the artifact's "route"; a PLAYBOOK node = the playbook
runtime (native verbs, gates, write-policed MCP actions), whose transcript is
the text part of the result.`;
    }

    /** Agent Card, executor with pause/resume legs, gate bridge, CLI entry. */
    static a2aAgentServerBlock(): string {
        return `# ==============================================================
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
    desc = (NODE.get("system_prompt") or NODE.get("instructions") or "").strip().replace("\\n", " ")
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

    \`updater\` is swapped on every A2A leg (first request, then each follow-up)
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
    """CLI entry: \`python <this file> --host 127.0.0.1 --port 8701\` (env A2A_HOST / A2A_PORT are the defaults)."""
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

`;
    }

    /**
     * Render a list of strings the way Python's repr(sorted([...])) does:
     *   ['a', 'b', 'c']
     * Note: Python repr uses single quotes unless the string contains a
     * single quote. For simplicity (and because tool names don't contain
     * quotes in practice), we always use single quotes.
     */
    private static pythonListRepr(items: any): string {
        let parts: any, esc: any;
        parts = [];
        for (let s of values(items)) {
            // Escape backslash and single quote the way Python repr does.
            esc = str_replace(['\\', '\''], ['\\\\', '\\\''], strval(s));
            parts.push('\'' + esc + '\'');
        }
        return '[' + implode(', ', parts) + ']';
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
    static modularLayout(facts: any): any {
        let used: any, agents: any, ad: any, kind: any, display: any, name: any;
        // Reserved: the package's own modules, so `import common` can never
        // resolve to an agent module.
        used = oarr({ common: true, workflow: true, agents: true });
        agents = oarr();
        for (let nid of values(facts['order'])) {
            if (((facts?.['agentData']?.[nid]) != null)) {
                ad = facts['agentData'][nid];
                kind = !empty(ad?.['dispatch']) ? 'dispatcher' : 'agent';
                display = ad['display'];
            } else if (((facts?.['playbookData']?.[nid]) != null)) {
                kind = 'playbook';
                display = facts['playbookData'][nid]['display'];
            } else if (((facts?.['codeData']?.[nid]) != null)) {
                kind = 'code';
                display = facts['codeData'][nid]['display'];
            } else {
                continue;
            }
            name = str_replace('-', '_', LangGraphGenerator.slug(display));
            if (!preg_match('/^[a-z_][a-z0-9_]*$/', name) || ((used?.[name]) != null)) {
                name = `node_${nid}_${name}`;
            }
            used[name] = true;
            agents[nid] = { file: `agents/${name}.py`, module: `agents.${name}`, name: name, display: display, kind: kind };
        }
        return { root: facts['safeName'] + '_modular', agents: agents };
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
    private generateSwarm(facts: any): any {
        let nodes: any, nodeNames: any, id: any, edges: any, rw: any, names: any, layout: any, package_: any, files: any, entry: any;
        // The shape SwarmRewriter::rewrite() expects -- {nodes:[{id,node_type,
        // config}], edges:[{from,to}]}, the same the API/editor use. analyzeForEmit()
        // already holds this as byId (node-by-id) + edges (normalised {from,to} by
        // WorkflowGraphAnalyzer), so this is a reshape, not a re-derivation.
        nodes = [];
        nodeNames = oarr();
        for (let [nid, node] of entries(facts['byId'])) {
            // PHP coerces a numeric-string array key back to int, so the key here
            // may already have lost its "3"-ness -- cast it back before it travels
            // any further, or every downstream === against an edge's string id
            // silently fails.
            id = strval(nid);
            nodes.push({ id: id, node_type: LangGraphGenerator.nodeType(node), config: is_array(node['config'] ?? null) ? node['config'] : [] });
            nodeNames[id] = LangGraphGenerator.displayName(node);
        }
        edges = [];
        for (let e of values(facts['edges'])) {
            edges.push({ from: strval((e['from'] ?? '')), to: strval((e['to'] ?? '')) });
        }

        rw = SwarmRewriter.rewrite({ nodes: nodes, edges: edges });
        if (!truthy(rw['ok'])) {
            names = implode(', ', array_map((id: any) => nodeNames[strval(id)] ?? `node ${id}`, rw['nodes']));
            throw new Error(LangGraphGenerator.swarmRefusalMessage(rw['error']) + (names !== '' ? ` (${names})` : ''));
        }
        facts['swarm'] = rw;

        // File layout: the same modularLayout() Task 3's real emitters reuse.
        // A canvas that reached here has already passed every swarm refusal, so
        // its agent/playbook nodes are exactly $rw['agents']'s members -- no
        // dispatcher, no playbook, no agent off Start. Iterate $rw['agents'] (built
        // in menu order, i.e. Start's fan-out order) rather than the layout's own
        // order, so the manifest is provably in canvas order regardless of how
        // topological order happens to tie-break.
        layout = LangGraphGenerator.modularLayout(facts);
        // The package files of the modular path (spec 2026-10-15 §5): its skills, requirements,
        // .env.example and README. A swarm reads no Start documents, so none are copied.
        package_ = LangGraphPackage.files({ ...facts, startDocuments: [] }, this.skillsRoot);
        files = [
            { path: 'workflow.py', code: this.emitSwarmWorkflow(facts, layout) },
            // common.py and api.py are the EXISTING modular emitters, called
            // (not copied): a swarm shares the shared runtime and run server
            // verbatim with the modular workflow path.
            { path: 'common.py', code: this.emitModularCommon(facts, layout, true) },
            { path: 'api.py', code: this.emitModularApi(facts, layout, false) },
            // A REGULAR package, not a namespace portion. Without __init__.py,
            // `import agents.<member>` loses to any installed top-level `agents`
            // package -- openai-agents ships one, and PEP 420 lets a regular package
            // elsewhere on sys.path beat a namespace portion here. generateModular()
            // emits this for the same reason; the swarm path omitted it, so the
            // emitted package did not import at all.
            { path: 'agents/__init__.py', code: '"""Agent modules of workflow ' + json_encode(facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                + ' (swarm)."""' + '\n' },
        ];
        for (let [id, agent] of entries(rw['agents'])) {
            entry = layout['agents'][id] ?? null;
            if (entry === null) {
                continue;
            }
            files.push({ path: entry['file'], code: this.emitSwarmAgentFile(facts, layout, strval(id)) });
        }
        files.push(...package_);
        return { root: layout['root'] + '_swarm', files: files };
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
    private emitSwarmAgentFile(facts: any, layout: any, nid: any): string {
        let rw: any, entry: any, member: any, def: any, sep: any, j: any, esc: any, L: any, body: any, node: any, otherId: any, other: any, role: any, desc: any;
        rw = facts['swarm'];
        entry = layout['agents'][nid];
        member = rw['agents'][nid];
        def = facts['agentData'][nid];
        sep = '# ' + str_repeat('=', 62);
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);

        L = [];
        L.push('"""Swarm member ' + j(entry['display']) + ` -- node ${nid} of workflow ` + j(facts['wfName']));
        L.push('');
        body = this.swarmAgentDocBody(facts, nid);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('from langgraph_swarm import create_handoff_tool');
        L.push('try:');
        L.push('    from langchain.agents import create_agent as create_react_agent');
        L.push('    _PROMPT_KW = "system_prompt"   # langchain >= 1.x renamed prompt=');
        L.push('except ImportError:');
        L.push('    from langgraph.prebuilt import create_react_agent');
        L.push('    _PROMPT_KW = "prompt"');
        L.push('');
        L.push('# The shared runtime lives in common.py, one directory up. Python puts the');
        L.push('# workflow folder on sys.path when workflow.py starts, so this resolves for');
        L.push('# every module of the package.');
        L.push('from common import _make_llm, TOOLS, inject_datetime');
        L.push('');
        L.push(sep);
        L.push('# NODE DEFINITION -- frozen from the workflow editor');
        L.push(sep);
        for (let dn of values(this.modularDocNodes(facts, layout))) {
            if (dn['id'] === nid) {
                for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(dn)))) {
                    L.push(cl);
                }
            }
        }
        node = this.nodeDefinitionLines(facts, nid, 'agent', entry['display'], def, false);
        for (let nl of values(explode('\n', node))) {
            L.push(nl);
        }
        L.push('');
        L.push(sep);
        L.push('# INSTRUCTIONS -- SwarmRewriter\'s composed prompt: this member\'s own');
        L.push('# instructions, plus (when it has colleagues) the "Colleagues you can hand');
        L.push('# this to" guide. Read from the rewrite, never recomputed here.');
        L.push(sep);
        L.push('INSTRUCTIONS = """');
        for (let il of values(explode('\n', str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], strval(member['instructions']))))) {
            L.push(il);
        }
        L.push('"""');
        L.push('');
        L.push(sep);
        L.push('# HANDOFFS -- one handoff tool per colleague. create_swarm() and');
        L.push('# these tools both identify agents by NAME (the display name SwarmRewriter');
        L.push('# guaranteed unique).');
        L.push(sep);
        L.push('HANDOFFS = [');
        for (let otherId of values(member['handoffs'])) {
            otherId = strval(otherId);
            other = rw['agents'][otherId] ?? null;
            if (other === null) {
                continue;
            }
            role = rtrim(LangGraphGenerator.swarmColleagueRole(rw, otherId), '. \t');
            desc = 'Hand the conversation to ' + other['name'] + (role !== '' ? ' — ' + role : '') + '.';
            L.push('    create_handoff_tool(');
            L.push('        agent_name=' + PythonEmitHelpers.pyStr(strval(other['name'])) + ',');
            L.push('        description=' + PythonEmitHelpers.pyStr(desc) + ',');
            L.push('    ),');
        }
        L.push(']');
        L.push('');
        L.push('');
        L.push('def _llm():');
        L.push('    """The chat model for this member, built from NODE (provider/model/sampling/thinking)."""');
        L.push('    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))');
        L.push('');
        L.push('');
        L.push('def build_agent():');
        L.push('    """Build this member\'s react agent: its own MCP tools plus one handoff per colleague.');
        L.push('');
        L.push('    name= is the member\'s DISPLAY name -- what create_swarm() and every colleague\'s');
        L.push('    HANDOFFS identify it by, the same name the rewrite guaranteed unique.');
        L.push('    """');
        L.push('    tools = TOOLS.tools_for(NODE["tool_names"])');
        L.push('    return create_react_agent(');
        L.push('        _llm(),');
        L.push('        tools + HANDOFFS,');
        // langchain's create_agent takes system_prompt=, langgraph's
        // create_react_agent takes prompt=. The import above picked one and set
        // _PROMPT_KW to match; passing the wrong name is a TypeError on every
        // call, which is what the compile probe caught.
        L.push('        **{_PROMPT_KW: inject_datetime(INSTRUCTIONS)},');
        // The rewrite's name, NOT NODE["display"]. create_swarm() matches
        // agents BY NAME, and every handoff tool and DEFAULT_ACTIVE_AGENT are
        // already emitted from SwarmRewriter's names. The two name functions
        // differ on empty strings, non-string values and the unnamed fallback,
        // so taking one from each source emits a graph whose handoffs point at
        // an agent that is not in it -- a package that builds and then dies at
        // the first hand-off.
        L.push('        name=' + PythonEmitHelpers.pyStr(strval(member['name'])) + ',');
        L.push('    )');
        return rtrim(implode('\n', L), '\n') + '\n';
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
    private swarmAgentDocBody(facts: any, nid: any): string {
        let rw: any, member: any, def: any, L: any, model: any, s: any, other: any, role: any, k: any;
        rw = facts['swarm'];
        member = rw['agents'][nid];
        def = facts['agentData'][nid];

        L = [];
        L.push('PROVENANCE');
        L.push('==========');
        L.push(`  Workflow:   ${facts['wfName']} (id ${facts['workflowId']})`);
        L.push('  Target:     LangGraph swarm member (Python) -- one create_react_agent(); workflow.py hands it to create_swarm()');
        L.push('  Generated:  ' + date('Y-m-d H:i:s T') + ' by the SynergyAI workflow editor');
        L.push('  This file is a frozen snapshot of the workflow. Edits made here are');
        L.push('  overwritten by the next Generate: change the workflow in the editor and');
        L.push('  re-generate instead.');
        L.push('');
        L.push('MEMBER  (this file, not the whole workflow)');
        L.push('======');
        model = (def['model'] ?? '') !== '' ? def['model'] : '(platform default)';
        s = elvis(def['provider'], '?') + ' / ' + model;
        if ((def['temperature'] ?? null) !== null) s += ', temp ' + json_encode(F(def['temperature']));
        if ((def['max_tokens'] ?? null) !== null) s += ', max_tokens ' + intval(def['max_tokens']);
        L.push(`  ${member['name']} -- node ${nid} in the workflow editor.`);
        L.push(`  Model:  ${s}`);
        L.push('  Tools:  ' + (truthy(member['tools']) ? implode(', ', member['tools']) : '(none)'));
        // The skills the compiled member runs (def), named by folder: the
        // rewriter's raw bound_skill is an array, which implode() printed as "Array".
        const skillLabels = ((def['skills'] ?? []) as any[]).map((sk: any) => (sk['dir'] !== undefined && sk['dir'] !== null) ? String(sk['dir']) : 'inline skill');
        L.push('  Skills: ' + (skillLabels.length ? skillLabels.join(', ') : '(none)'));
        L.push('');
        L.push('COLLEAGUES  (this member\'s own handoffs -- what HANDOFFS below builds, not the canvas)');
        L.push('==========');
        if (truthy(member['handoffs'])) {
            for (let otherId of values(member['handoffs'])) {
                other = rw['agents'][strval(otherId)] ?? null;
                if (other === null) {
                    continue;
                }
                role = rtrim(LangGraphGenerator.swarmColleagueRole(rw, strval(otherId)), '. \t');
                L.push('  ' + other['name'] + (role !== '' ? ' -- ' + role : ''));
            }
        } else {
            L.push('  (none -- this member has no colleague to hand off to)');
        }
        L.push('');
        L.push('INSTRUCTIONS  (below)');
        L.push('============');
        L.push('  SwarmRewriter\'s composed prompt: this member\'s own instructions plus,');
        L.push('  when it has colleagues, the "Colleagues you can hand this to" guide built');
        L.push('  from the list above. Change the agent\'s prompt in the workflow editor,');
        L.push('  not here -- this is overwritten on the next Generate.');
        L.push('');
        L.push('BUILD_AGENT()');
        L.push('=============');
        L.push('  Returns this member\'s create_react_agent(): its own MCP tools (Tools,');
        L.push('  above) plus one handoff tool per colleague (HANDOFFS, below). workflow.py');
        L.push('  imports it and passes the built agent straight into create_swarm().');
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  # Requires Python 3.10+ (the generated code uses match statements)');
        L.push('  ' + LangGraphPackage.PIP_REQUIREMENTS);
        k = PythonEmitHelpers.providerKeyEnv(strval((def['provider'] ?? '')));
        L.push(k !== null
            ? `  # API key read from ../../../.env: ${k} (` + strtolower(strval(def['provider'])) + ')'
            : '  # No LLM provider key required.');
        L.push('  imported by workflow.py -- run the swarm (python workflow.py), not this file directly.');
        return implode('\n', L);
    }

    /** First line of a colleague's OWN composed instructions -- the exact role summary
     *  SwarmRewriter::rewrite() folded into every OTHER member's "Colleagues" guide.
     *  Read from the rewrite's output, never recomputed. */
    private static swarmColleagueRole(rw: any, colleagueId: any): string {
        let instructions: any, first: any;
        instructions = strval(rw['agents'][colleagueId]?.['instructions'] ?? '');
        first = trim(explode('\n', instructions)[0] ?? '');
        return mb_substr(first, 0, 120);
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
    private emitSwarmWorkflow(facts: any, layout: any): string {
        let rw: any, sep: any, esc: any, members: any, entry: any, L: any, body: any, ofolder: any, entryName: any, memberNames: any;
        rw = facts['swarm'];
        sep = '# ' + str_repeat('=', 62);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);

        members = oarr(); // nid => layout entry, in canvas (Start fan-out) order
        for (let [id, agent] of entries(rw['agents'])) {
            entry = layout['agents'][id] ?? null;
            if (entry !== null) {
                members[strval(id)] = entry;
            }
        }
        L = [];
        L.push('"""LangGraph swarm: ' + facts['wfName']);
        L.push('');
        body = this.swarmWorkflowDocBody(facts, members);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, re, signal, time, uuid');
        L.push('from datetime import datetime, timedelta');
        L.push('from typing import Callable');
        L.push('');
        L.push('from langchain_core.messages import AIMessage, HumanMessage');
        L.push('from langgraph.checkpoint.memory import MemorySaver');
        L.push('from langgraph_swarm import create_swarm');
        L.push('');
        L.push('# Running this file puts its own folder on sys.path, so `common` and the');
        L.push('# `agents` package below resolve wherever the workflow folder is copied.');
        L.push('from common import EVENTS');
        for (let [nid, e] of entries(members)) {
            L.push('from ' + e['module'] + ' import build_agent as build_' + e['name']);
        }
        L.push('');
        L.push('WORKFLOW_ID = ' + intval(facts['workflowId']));
        L.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(facts['wfName']));
        L.push('OUTPUT_STORAGE_ENABLED = ' + (facts['workflow'].isOutputStorageEnabled() ? 'True' : 'False'));
        ofolder = facts['workflow'].getOutputFolder();
        L.push('OUTPUT_FOLDER = ' + ((ofolder ?? '') !== '' ? PythonEmitHelpers.pyStr(strval(ofolder)) : 'None'));
        L.push('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(facts['startPrompt']));
        L.push(LangGraphGenerator.defaultCronLine(facts));
        entryName = strval(rw['agents'][rw['entry']]?.['name'] ?? '');
        L.push('DEFAULT_ACTIVE_AGENT = ' + PythonEmitHelpers.pyStr(entryName) + '   # the member wired to Start');
        L.push('# Every valid create_swarm() active_agent value -- each member\'s NODE["display"],');
        L.push('# the same text create_react_agent(name=...) and every HANDOFFS agent_name= use.');
        // One source for every name in this graph: the rewrite's. See the
        // agent emitter -- create_swarm() matches by name, so MEMBER_NAMES,
        // DEFAULT_ACTIVE_AGENT, every agent_name= and every create_react_agent
        // name= must all be the same strings.
        // $members is keyed by node id and the layout entry carries NO 'id', so
        // this must read the key, not the entry -- an $e['id'] lookup is
        // undefined and silently falls back to the generator's own display name,
        // which is the source this exists to stop using.
        memberNames = [];
        for (let [nid, e] of entries(members)) {
            memberNames.push(PythonEmitHelpers.pyStr(strval(rw['agents'][nid]['name'])));
        }
        L.push('MEMBER_NAMES = {' + implode(', ', memberNames) + '}');
        L.push('');
        L.push(sep);
        L.push('# GRAPH -- create_swarm() returns an UNCOMPILED StateGraph; .compile() is ours.');
        L.push('# MemorySaver keeps hand-offs (active_agent + message history) coherent for');
        L.push('# the run; it is the single point a database-backed saver replaces later.');
        L.push(sep);
        L.push('def build_graph():');
        L.push('    return create_swarm(');
        L.push('        [' + implode(', ', array_map((e: any) => 'build_' + e['name'] + '()', members)) + '],');
        L.push('        default_active_agent=DEFAULT_ACTIVE_AGENT,');
        L.push('    ).compile(checkpointer=MemorySaver())');
        L.push('');
        L.push('');
        L.push('_GRAPH = None');
        L.push('');
        L.push('');
        L.push('def _graph():');
        L.push('    """Build the compiled graph once per process and reuse it."""');
        L.push('    global _GRAPH');
        L.push('    if _GRAPH is None:');
        L.push('        _GRAPH = build_graph()');
        L.push('    return _GRAPH');
        L.push('');
        L.push('');
        L.push(sep);
        L.push('# MAIN EXECUTION');
        L.push(sep);
        L.push('async def run(user_prompt: str, session: str | None = None) -> str:');
        L.push('    """Run the swarm, starting from DEFAULT_ACTIVE_AGENT, and return the final');
        L.push('    message text. api.py calls this exactly as it calls the modular');
        L.push('    workflow.py\'s run() -- one prompt in, one answer out.');
        L.push('');
        L.push('    A swarm is a conversation: passing the same `session` on a later call');
        L.push('    resumes it -- same transcript, and the agent that answered last still');
        L.push('    holds the turn. Omitting it starts a fresh one, which is the right');
        L.push('    default for a single-shot invocation."""');
        L.push('    config = {"configurable": {"thread_id": session or uuid.uuid4().hex}}');
        L.push('    result = await _graph().ainvoke({"messages": [HumanMessage(content=user_prompt)]}, config=config)');
        L.push('    final = result["messages"][-1]');
        L.push('    text = final.content if isinstance(final, AIMessage) else str(final)');
        L.push('    if isinstance(text, list):');
        L.push('        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))');
        L.push('    # active_agent is the member holding the turn when it ended -- exactly who');
        L.push('    # answered. Fall back to the entry agent rather than emit an unlabelled reply');
        L.push('    # when it is missing (older checkpoints) or not a known member.');
        L.push('    active = result.get("active_agent")');
        L.push('    display = active if isinstance(active, str) and active in MEMBER_NAMES else DEFAULT_ACTIVE_AGENT');
        L.push('    # `agent` is carried as its own field, not only inside the text: the');
        L.push('    # conversation UI labels the bubble with it, and a label reading');
        L.push('    # "Playbook" over an answer from "Human resources" is worse than no');
        L.push('    # label at all. EVENTS.emit takes **kwargs, so this is additive.');
        L.push('    EVENTS.emit(type="message", text=f"**{display}**\\n\\n{text}", agent=display, sensitive=False)');
        L.push('    return text');
        L.push('');
        L.push('');
        L.push('def _save_output(output: str) -> str | None:');
        L.push('    """Honour the workflow\'s output storage setting (same rule as the non-swarm workflow.py)."""');
        L.push('    import os, re');
        L.push('    if not OUTPUT_STORAGE_ENABLED:');
        L.push('        return None');
        L.push('    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")');
        L.push('    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")');
        L.push('    if not os.path.isabs(folder):');
        L.push('        folder = os.path.join(root, folder)');
        L.push('    os.makedirs(folder, exist_ok=True)');
        L.push('    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", output) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", output)');
        L.push('    ext = "html" if m else "md"');
        L.push('    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]');
        L.push('    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime(\'%Y%m%d-%H%M%S\')}.{ext}")');
        L.push('    with open(path, "w", encoding="utf-8") as fh:');
        L.push('        fh.write(m.group(0) if m else output)');
        L.push('    return path');
        L.push('');
        L.push('');
        L.push(LangGraphRuntime.cronBlock());
        L.push('if __name__ == "__main__":');
        L.push('    ap = argparse.ArgumentParser(description=f"LangGraph swarm {WORKFLOW_NAME!r}", allow_abbrev=False)');
        L.push('    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")');
        L.push('    ap.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",');
        L.push('                    help="run on a cron schedule until Ctrl-C (default: the Start node\'s schedule)")');
        L.push('    a = ap.parse_args()');
        L.push('    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"');
        L.push('    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)');
        L.push('');
        L.push('    def run_once() -> str:');
        L.push('        """One run of the swarm (a fresh conversation): its output printed and saved (\'\' when none)."""');
        L.push('        print(f"[info] Prompt: {prompt[:100]}{\'...\' if len(prompt) > 100 else \'\'}", flush=True)');
        L.push('        t0 = time.monotonic()');
        L.push('        session = uuid.uuid4().hex');
        L.push('        try:');
        L.push('            output = runs.loop.run_until_complete(run(prompt, session))');
        L.push('        finally:');
        L.push('            if _GRAPH is not None:   # a run\'s conversation is not kept, so memory stays flat');
        L.push('                _GRAPH.checkpointer.delete_thread(session)');
        L.push('        if output:');
        L.push('            print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)');
        L.push('            saved = _save_output(output)');
        L.push('            print("\\n" + "=" * 74 + "\\nRUN SUMMARY\\n" + "-" * 74, flush=True)');
        L.push('            print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)');
        L.push('            print(f"  Final output: {len(output)} chars", flush=True)');
        L.push('            print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)');
        L.push('            print("=" * 74, flush=True)');
        L.push('        return output');
        L.push('');
        L.push('    match CronExpression.from_cli(ap, a.cron, DEFAULT_CRON):');
        L.push('        case None:');
        L.push('            if not run_once():');
        L.push('                print("[info] The run ended without output.", flush=True)');
        L.push('        case expr:');
        L.push('            run_cron(expr, run_once, drains=False, loop=runs)   # a swarm has no code nodes');
        return rtrim(implode('\n', L), '\n') + '\n';
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
    private swarmWorkflowDocBody(facts: any, members: any): string {
        let rw: any, entryId: any, entryName: any, L: any, keys: any, def: any, k: any, storageOn: any, folder: any;
        rw = facts['swarm'];
        entryId = strval(rw['entry']);
        entryName = strval(rw['agents'][entryId]?.['name'] ?? '');

        L = [];
        L.push('PROVENANCE');
        L.push('==========');
        L.push(`  Workflow:   ${facts['wfName']} (id ${facts['workflowId']})`);
        L.push('  Target:     LangGraph swarm (Python) -- create_swarm() over one create_react_agent() per member');
        L.push('  Generated:  ' + date('Y-m-d H:i:s T') + ' by the SynergyAI workflow editor');
        L.push('  This file is a frozen snapshot of the workflow. Edits made here are');
        L.push('  overwritten by the next Generate: change the workflow in the editor and');
        L.push('  re-generate instead.');
        L.push('');
        L.push('TOPOLOGY  (the compiled swarm this file builds -- not the canvas)');
        L.push('========');
        L.push('  Members, in the order create_swarm() receives them:');
        for (let [nid, e] of entries(members)) {
            L.push(sprintf('    %-6s %-24s %s', nid, e['display'], e['file']));
        }
        L.push(`  Default active agent: ${entryName} -- the first agent Start connects to.`);
        L.push('  Every member can hand the conversation to every other member: a full mesh,');
        L.push('  not the list of canvas edges off Start (those decide membership only, not');
        L.push('  this topology). Each member\'s own agents/<name>.py documents who it can');
        L.push('  hand to and why.');
        L.push('  common.py holds the runtime they share; api.py is the unmodified run server.');
        L.push('  A `session` passed to POST /runs (api.py) resumes this exact conversation --');
        L.push('  same transcript, same active agent picking up where it left off. Omitting it');
        L.push('  starts a fresh one.');
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  # Requires Python 3.10+ (the generated code uses match statements)');
        L.push('  ' + LangGraphPackage.PIP_REQUIREMENTS);
        keys = oarr();
        for (let [nid, e] of entries(members)) {
            def = facts['agentData'][nid] ?? null;
            if (def === null) {
                continue;
            }
            k = PythonEmitHelpers.providerKeyEnv(strval((def['provider'] ?? '')));
            if (k !== null) {
                (keys[k] ??= []).push(strtolower(strval(def['provider'])));
            }
        }
        if (truthy(keys)) {
            L.push('  # API keys read from ../../.env for the providers this swarm uses:');
            for (let [k, provs] of entries(keys)) {
                L.push(`  #   ${k} (` + implode(', ', array_unique(provs)) + ')');
            }
        } else {
            L.push('  # No LLM provider is used by a member of this swarm.');
        }
        L.push('  python workflow.py "your prompt here"');
        for (let cl of values(LangGraphGenerator.cronDocLines(facts, 'workflow.py'))) {
            L.push('  ' + cl);
        }
        if (!empty(facts?.['missing'])) {
            L.push('  # WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' + LangGraphGenerator.pythonListRepr(facts['missing']));
        }
        storageOn = facts['workflow'].isOutputStorageEnabled();
        folder = facts['workflow'].getOutputFolder();
        L.push('  # Output storage (Output node setting): ' + (storageOn
            ? 'ON -> ' + ((folder ?? '') !== '' ? folder : 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)')
            : 'OFF (the result is printed, not saved)'));
        return implode('\n', L);
    }

    /** One sentence per SwarmRewriter refusal code, close to the editor's copy (frontend/assets/i18n/en.json workflow.swarmError.*). Developer-facing: not i18n'd. */
    private static swarmRefusalMessage(code: any): string {
        switch (code) {
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
                return `This workflow cannot run as a swarm (${code}).`;
        }
    }

    /** Modular mode: workflow.py, common.py, the package marker, then one module per agent/playbook node. */
    private generateModular(facts: any): any {
        let layout: any, package_: any, codeFiles: any, files: any;
        layout = LangGraphGenerator.modularLayout(facts);
        // The package carries what it runs on (spec 2026-10-15 §5): read from the original facts, then
        // START_DOCUMENTS points at the copies and each code node at its code/ file.
        package_ = LangGraphPackage.files(facts, this.skillsRoot, this.startDocuments);
        facts['startDocuments'] = LangGraphPackage.startDocuments(facts['startDocuments'] ?? [], this.startDocuments)['docs'];
        codeFiles = oarr();
        for (let [nid, cd] of entries(facts['codeData'])) {
            codeFiles[strval(nid)] = LangGraphPackage.codeFile(strval(nid), cd, strval(nid) === facts['triggerNodeId']);
            facts['codeData'][nid]['source_file'] = codeFiles[strval(nid)]['path'];
        }
        files = [
            { path: 'workflow.py', code: this.emitModularWorkflow(facts, layout) },
            { path: 'common.py', code: this.emitModularCommon(facts, layout, true) },
            { path: 'api.py', code: this.emitModularApi(facts, layout) },
            { path: 'agents/__init__.py', code: '"""Agent modules of workflow ' + json_encode(facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                + ' -- one per agent/playbook node.\n\nEach module exposes NODE (the frozen editor settings) and\nrun_node = make_node(NODE).run (common.py\'s Node classes), which workflow.py\ncalls from its graph as run_node(request_text, trace).\n"""\n' },
        ];
        for (let [nid, e] of entries(layout['agents'])) {
            files.push({ path: e['file'], code: this.emitModularAgentFile(facts, layout, strval(nid)) });
        }
        files.push(...array_values(codeFiles), ...package_);
        return LangGraphGenerator.withArchitecture({ root: layout['root'], files: files }, facts, 'modular');
    }

    /**
     * A multi-file result plus its ARCHITECTURE.md (architectureDoc()): under
     * 'architecture' for a caller that only shows it, and as the last file so
     * it is written beside the code wherever the package is saved. With no doc
     * (ingestion, or it failed to build) 'architecture' is null and the files
     * are the code alone.
     */
    private static withArchitecture(result: any, facts: any, mode: any): any {
        let doc: any;
        doc = LangGraphGenerator.architectureDoc(facts, mode);
        if (doc !== null) {
            result['files'].push({ path: 'ARCHITECTURE.md', code: doc });
        }
        result['architecture'] = doc;
        return result;
    }

    /** docNodes descriptors for the modular layout: every node, with its module file under 'file'. */
    private modularDocNodes(facts: any, layout: any): any {
        let nodes: any, n: any;
        nodes = this.a2aDocNodes(facts, { agents: [] });
        for (let n of values(nodes)) {
            n['file'] = layout['agents'][n['id']]?.['file'] ?? '';
        }
        return nodes;
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
    private static providerKeyLines(facts: any, envPath: any): any {
        let keys: any, k: any, L: any;
        keys = oarr();
        for (let ad of values(facts['agentData'])) {
            if ((ad['provider'] ?? '') === '') continue;
            k = PythonEmitHelpers.providerKeyEnv(ad['provider']);
            if (k !== null) (keys[k] ??= []).push(strtolower(ad['provider']));
        }
        for (let pd of values(facts['playbookData'])) {
            if ((pd['provider'] ?? '') === '') continue;
            k = PythonEmitHelpers.providerKeyEnv(pd['provider']);
            if (k !== null) (keys[k] ??= []).push(strtolower(pd['provider']));
        }
        if (!truthy(keys)) {
            return ['  # No LLM provider is used by a runnable node of this workflow.'];
        }
        L = [`  # API keys read from ${envPath} for the providers this workflow uses:`];
        for (let [k, provs] of entries(keys)) L.push(`  #   ${k} (` + implode(', ', array_unique(provs)) + ')');
        return L;
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
    private commonPyDocBody(facts: any): string {
        let L: any, adapters: any;
        L = [];
        L.push('PROVENANCE');
        L.push('==========');
        L.push(`  Workflow:   ${facts['wfName']} (id ${facts['workflowId']})`);
        L.push('  Target:     LangGraph modular shared runtime (Python) -- imported by workflow.py and every agent module');
        L.push('  Generated:  ' + date('Y-m-d H:i:s T') + ' by the SynergyAI workflow editor');
        L.push('  This file is a frozen snapshot of the workflow. Edits made here are');
        L.push('  overwritten by the next Generate: change the workflow in the editor and');
        L.push('  re-generate instead.');
        L.push('');
        L.push('SHARED RUNTIME  (no graph, no nodes -- this is a library, not a workflow file)');
        L.push('==============');
        L.push('  Imported by workflow.py and every module under agents/. Emitted byte-');
        L.push('  identical for the DAG (modular) and swarm packages -- both import this');
        L.push('  exact file, so a change here reaches every node of either shape at the');
        L.push('  next Generate. (The A2A package does not import it: an A2A agent file');
        L.push('  copies what it needs into its own process instead.)');
        L.push('');
        L.push('PROVIDES  (top-level names this file defines, in source order)');
        L.push('========');
        L.push('  _make_llm()                     provider/model -> LangChain chat model');
        L.push('                                   (claude, openai, gemini, grok, deepseek, kimi, glm)');
        L.push('  MCP_SERVERS, TOOL_CATALOG       this workflow\'s MCP servers + tool schemas, baked at generation time');
        L.push('  McpClient, MCP                  the MCP JSON-RPC client: handshake (endpoint remembered), tools/call, JSON or SSE replies; one reused HTTP client');
        L.push('  ToolCatalog, TOOLS              TOOL_CATALOG -> {name: StructuredTool}, calling out over MCP JSON-RPC; built once, each node takes its own by name');
        L.push('  SkillRuntime, SKILLS            folder-backed skills: run_skill_script, the per-skill tool, a skill as a mandatory node step');
        L.push('  RunEvents, EVENTS               how a run\'s events reach api.py; EVENTS.emit() is a no-op with no sink installed;');
        L.push('                                   also the human-gate rendezvous a playbook node\'s tools wait on');
        L.push('  set_event_sink, emit_event,');
        L.push('  resolve_gate                    EVENTS\' methods under their old names, for api.py and the run-server probes');
        // dispatcherBlock() is emitted for every workflow (DispatcherNode names Dispatcher);
        // only the adapter classes depend on the protocols the dispatchers use.
        adapters = array_map((p: any) => LangGraphRuntime.ADAPTER_CLASSES[p] + ',',
            LangGraphGenerator.decisionProtocolsUsed(facts['agentData'] ?? []));
        L.push('  ' + implode(' ', array_merge(['DecisionResult,'], adapters)));
        L.push('  DECISION_ADAPTERS, RouteDecision,');
        L.push('  Dispatcher                      a DISPATCHER node\'s routing: a decision model or one forced route_to call, never both');
        L.push('  inject_datetime()               prepends a dated header, resolves [date]/[weekday]/[year]/[time] in a system prompt');
        if (!isEmptyArr(facts['playbookData'])) {
            L.push('  PLAYBOOK_SYSTEM_PROMPT,');
            L.push('  GATE_BRIDGE, PlaybookRun,');
            L.push('  PlaybookToolset                 the playbook interpreter (this workflow has playbook nodes)');
        }
        L.push('  Node, AgentNode, DispatcherNode,');
        if (!isEmptyArr(facts['playbookData'])) {
            L.push('  PlaybookNode,');
        }
        L.push('  NodeKind, make_node()           one Node subclass per node kind; every agent module is its NODE + make_node(NODE).run');
        L.push('  WFState, build_context()        the graph state type and per-node input builder (used by WorkflowGraph)');
        L.push('  DocumentConverter / DOCUMENTS   Start-node attachment -> Markdown, one method per format (lazy imports, text formats verbatim)');
        L.push('  WorkflowGraph                   the LangGraph StateGraph over workflow.py\'s EDGES/ORDER/NODE_TYPES and its node runner');
        L.push('  save_output(),');
        L.push('  print_run_summary()             the Output node\'s storage rule and the closing RUN SUMMARY (workflow.py\'s CLI)');
        L.push('');
        L.push('CONFIGURATION');
        L.push('=============');
        L.push('  load_dotenv() resolves python/.env -- two directories above this file --');
        L.push('  at import time, before workflow.py or any agent module reads a provider');
        L.push('  key, so importing this module alone (a test, a REPL) still finds them. No');
        L.push('  key is checked here: building a chat model succeeds either way, and the');
        L.push('  underlying provider SDK raises at the first real request if a required key');
        L.push('  is missing or empty.');
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  # Requires Python 3.10+ (the generated code uses match statements)');
        L.push('  ' + LangGraphPackage.PIP_REQUIREMENTS);
        L = array_merge(L, LangGraphGenerator.providerKeyLines(facts, '../../.env'));
        L.push('  imported, not run directly -- see workflow.py');
        L.push('  # Everything here is shared: change it once and every node of this workflow follows.');
        L.push('  # Output storage (Output node setting): OFF (the result is printed, not saved)');
        return implode('\n', L);
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
    private apiPyDocBody(facts: any, target: any, deps: any, extraNotes: any): string {
        let L: any;
        L = [];
        L.push('PROVENANCE');
        L.push('==========');
        L.push(`  Workflow:   ${facts['wfName']} (id ${facts['workflowId']})`);
        L.push(`  Target:     ${target}`);
        L.push('  Generated:  ' + date('Y-m-d H:i:s T') + ' by the SynergyAI workflow editor');
        L.push('  This file is a frozen snapshot of the workflow. Edits made here are');
        L.push('  overwritten by the next Generate: change the workflow in the editor and');
        L.push('  re-generate instead.');
        L.push('');
        L.push('RUN SERVER  (no graph, no nodes -- it has never heard of either)');
        L.push('==========');
        L.push('  Speaks the run protocol the SynergyAI workflow editor uses to start a run');
        L.push('  and stream its progress. The graph itself lives elsewhere -- workflow.py');
        L.push('  (modular/swarm) or orchestrator.py (A2A) -- this file only drives and');
        L.push('  observes it (set_event_sink) over HTTP.');
        L.push('');
        L.push('HTTP SURFACE');
        L.push('============');
        L.push('  GET  /.well-known/workflow.json     identity: {workflow_id, name, version, protocol}');
        L.push('  POST /runs                          {prompt, session} -> {run_id, status}; starts the run');
        L.push('                                       as a background task -- does not itself stream');
        L.push('  GET  /runs/{run_id}/events           text/event-stream -- see SSE FRAMES below');
        L.push('  POST /runs/{run_id}/tool-result      {tool_call_id, ...answer} -- answers a playbook\'s human gate');
        L.push('');
        L.push('SSE FRAMES');
        L.push('==========');
        L.push('  Each frame is  id: <seq>\\nevent: <name>\\ndata: <json>\\n\\n .  `id:` is the');
        L.push('  sequence number a reconnecting client echoes back as Last-Event-ID.');
        L.push('  Event names: "message" (one run event forwarded from the graph\'s sink --');
        L.push('  its payload can itself be {"type": "truncated", ...} instead of a real');
        L.push('  event; see RECONNECT), "done" (terminal -- carries output + seconds) and');
        L.push('  "error" (terminal -- carries the exception text).');
        L.push('');
        L.push('RECONNECT');
        L.push('=========');
        L.push('  Every published frame is kept in a per-run ring buffer (500 frames) for');
        L.push('  replay. A client that reconnects sends Last-Event-ID; the stream replays');
        L.push('  everything after it -- or, if the gap outran the ring, one "truncated"');
        L.push('  message first -- before resuming live. That is what lets a dropped client');
        L.push('  pick a run back up instead of losing it.');
        L.push('');
        L.push('SESSION');
        L.push('=======');
        L.push('  The `session` field on POST /runs is forwarded to run_workflow() as the');
        L.push('  conversation to resume: the same value on a later POST /runs continues');
        L.push('  that thread on the checkpointer; omitting it starts a fresh one. Only the');
        L.push('  swarm target\'s run() actually reads it -- a DAG run() (modular or A2A)');
        L.push('  accepts the parameter and ignores it, so a caller can pass the same');
        L.push('  session to any target without knowing which one is behind this server.');
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  # Requires Python 3.10+ (the generated code uses match statements)');
        L.push('  ' + deps);
        L = array_merge(L, LangGraphGenerator.providerKeyLines(facts, '../../.env'));
        L.push('  python api.py --port 8710        # then open the workflow from the editor');
        for (let n of values(extraNotes)) L.push('  ' + n);
        L.push('  # Output storage (Output node setting): OFF (the result is printed, not saved)');
        return implode('\n', L);
    }

    /**
     * Module-docstring body shared by the three file kinds. $nid marks one node
     * as "<== this module" (agent modules); pass null for workflow.py/common.py.
     */
    private modularDocBody(facts: any, layout: any, target: any, run: any, nid: any = null, storage: any = false, dataFlow: any = null): string {
        let nodes: any, n: any;
        nodes = this.modularDocNodes(facts, layout);
        if (nid !== null) {
            for (let n of values(nodes)) {
                if (n['id'] === nid) {
                    n['marker'] = '<== this module';
                }
            }
        }
        return PythonEmitHelpers.workflowDocBlock({ target: target, dispatch_supported: true, workflow: { id: facts['workflowId'], name: facts['wfName'] }, nodes: nodes, edges: facts['edgeList'], layers: facts['gdata']['layers'] ?? [], data_flow: dataFlow ?? LangGraphGenerator.modularDataFlowDoc(), run: union({ extra: array_merge(toArr(run['extra'] ?? []), LangGraphGenerator.decisionDocLines(facts['agentData'] ?? []), LangGraphGenerator.mcpHeaderDocLines(facts)) }, run), storage: storage
                ? { enabled: facts['workflow'].isOutputStorageEnabled(), folder: facts['workflow'].getOutputFolder(), default: 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)' }
                : { enabled: false, folder: null } });
    }

    /** DATA FLOW text shared by every file of a modular package. */
    private static modularDataFlowDoc(): string {
        return `This workflow is one Python package, run in ONE process. workflow.py owns the
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
once instead of copied per node.`;
    }

    /**
     * common.py: the shared runtime library, WorkflowGraph included. No graph data, no node definitions.
     *
     * $packaged: a package with its own files (LangGraphPackage): code nodes import code_harness.py;
     * skills, outputs and scratch default to folders of the package. The modular and swarm paths
     * both pass it, so their common.py stay byte-identical.
     */
    private emitModularCommon(facts: any, layout: any, packaged: any = false): string {
        let sep: any, esc: any, L: any, body: any, withPlaybooks: any;
        sep = '# ' + str_repeat('=', 62);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);
        L = [];
        L.push('"""Shared runtime for workflow ' + json_encode(facts['wfName'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        L.push('');
        body = this.commonPyDocBody(facts);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        withPlaybooks = !isEmptyArr(facts['playbookData']);
        L.push('import asyncio, json, os, re, subprocess, sys, threading, time, uuid' + (!isEmptyArr(facts['codeData']) && !truthy(packaged) ? ', types' : ''));
        L.push('from abc import ABC, abstractmethod');
        L.push('from dataclasses import asdict, dataclass, field');
        L.push('from datetime import datetime');
        L.push('from enum import Enum');
        L.push('from functools import cached_property');
        L.push('from pathlib import Path');
        L.push('from typing import Annotated, Awaitable, Callable, Literal, TypedDict');
        L.push('');
        L.push('from dotenv import load_dotenv');
        L.push('# This file lives in <root>/; the runner .env is two levels up (python/.env).');
        L.push('# Loaded here rather than in workflow.py so a module imported on its own');
        L.push('# (a test, a REPL) still finds the provider keys.');
        L.push('_HERE = os.path.dirname(os.path.abspath(__file__))');
        L.push('load_dotenv(os.path.join(_HERE, ".env"))   # the workflow folder\'s own .env first (never overridden)');
        L.push('RUNNER_DIR = os.path.dirname(os.path.dirname(_HERE))   # the runner env folder (python/)');
        L.push('load_dotenv(os.path.join(RUNNER_DIR, ".env"))');
        L.push('DEBUG_STEM = os.path.basename(_HERE)   # the package folder names the agents\' outputs/_debug dumps');
        L.push('PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # the package folder: code/, skills/, outputs/, start_documents/');
        L.push('');
        L.push('import httpx');
        L.push('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage');
        L.push('from langchain_core.tools import StructuredTool');
        L.push('from langgraph.graph import END, START, StateGraph');
        L.push('try:');
        L.push('    from langchain.agents import create_agent as create_react_agent');
        L.push('except ImportError:');
        L.push('    from langgraph.prebuilt import create_react_agent');
        L.push('from pydantic import Field, create_model');
        L.push('');
        L.push('MODEL_NAME_OVERRIDE = os.environ.get(\'MODEL_NAME\', \'\').strip()');
        L.push('');
        L.push(sep);
        L.push('# LLM FACTORY');
        L.push('# Provider/model -> LangChain chat model. Every node calls this with its');
        L.push('# own baked settings, so one workflow can mix providers.');
        L.push(sep);
        L.push(LangGraphRuntime.llmFactoryBlock());
        L.push('');
        L.push(sep);
        L.push('# MCP SERVER REGISTRY + TOOL CATALOG (every tool this workflow uses)');
        L.push('# Baked at generation time. An agent module names the tools it may use');
        L.push('# in NODE["tool_names"]; the catalog itself is shared.');
        L.push(sep);
        L.push('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(facts['usedServers'], true));
        if (!isEmptyArr(facts['codeData'])) {
            L.push('MCP_SLUGS = ' + PythonEmitHelpers.jsonToPython(facts['codeSlugs'], true));
        }
        L.push('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(facts['usedCatalog'], true));
        L.push('');
        L.push(sep);
        L.push('# MCP CLIENT -- JSON-RPC 2.0 over HTTP');
        L.push(sep);
        L.push(LangGraphGenerator.serverSlugsLine(facts['serverSlugs'] ?? []));
        L.push('');
        L.push(LangGraphRuntime.mcpClientBlock());
        if (!isEmptyArr(facts['codeData'])) {
            L.push(LangGraphRuntime.codeHarnessBlock(packaged));
            L.push('');
        }
        L.push(sep);
        L.push('# TOOL BUILDER + SKILL RUNTIME');
        L.push(sep);
        L.push(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock(packaged));
        L.push(LangGraphRuntime.runEventsBlock());
        L.push(sep);
        L.push('# DISPATCHER RUNTIME');
        L.push(sep);
        L.push(LangGraphRuntime.dispatcherBlock(LangGraphGenerator.decisionProtocolsUsed(facts['agentData'] ?? [])));
        L.push(LangGraphGenerator.datetimeInjectorBlock());
        if (withPlaybooks) {
            L.push(LangGraphRuntime.playbookBlock());
        }
        L.push(LangGraphRuntime.nodeClassesBlock(withPlaybooks, !isEmptyArr(facts['codeData'])));
        L.push('');
        L.push(sep);
        L.push('# GRAPH STATE + CONTEXT BUILDING (used by WorkflowGraph)');
        L.push(sep);
        L.push(LangGraphGenerator.stateBlock());
        L.push('');
        L.push(LangGraphGenerator.contextBuilderBlock());
        L.push(sep);
        L.push('# ATTACHMENT CONVERTER (Start-node documents)');
        L.push(sep);
        L.push(LangGraphRuntime.documentConverterBlock());
        L.push(LangGraphRuntime.runRecordBlock());
        L.push(LangGraphRuntime.liveFeedBlock());
        L.push(LangGraphRuntime.consoleBlock());
        L.push(LangGraphRuntime.workflowGraphBlock());
        L.push(LangGraphRuntime.outputBlock(packaged));
        return rtrim(implode('\n', L), '\n') + '\n';
    }

    /**
     * api.py: the run server — the graph behind POST /runs + an SSE event stream. With $listen (the
     * modular package; plan task 8) it also runs the Start's cron / watch loop: POST /listen, GET /live
     * and --listen, over workflow.py's make_listener(). A swarm's workflow.py has none, so it passes false.
     */
    private emitModularApi(facts: any, layout: any, listen: any = true): string {
        let esc: any, body: any;
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);
        body = this.apiPyDocBody(facts,
            'LangGraph modular run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            LangGraphPackage.PIP_REQUIREMENTS,
            array_merge(['# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
             '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
             '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)'], listen ? [
             '#',
             '#   python api.py --listen    # also run the Start\'s schedule / event trigger (POST /listen toggles it;',
             '#                             # GET /live streams the runs and the listener\'s state)'] : []));
        return RunServerEmitter.emit(
            facts['wfName'],
            esc(body),
            'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
            'WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator.a2aVersion(facts)),
            listen
        );
    }

    /**
     * agents/<name>.py: ONE node -- its frozen definition plus run_node(). The
     * shared runtime is imported from common, never copied (the A2A trade,
     * reversed).
     */
    private emitModularAgentFile(facts: any, layout: any, nid: any): string {
        let entry: any, kind: any, isPlaybook: any, def: any, sep: any, j: any, esc: any, L: any, body: any, defLines: any;
        entry = layout['agents'][nid];
        kind = entry['kind'];
        isPlaybook = kind === 'playbook';
        def = kind === 'playbook' ? facts['playbookData'][nid]
            : kind === 'code' ? facts['codeData'][nid]
            : facts['agentData'][nid];
        sep = '# ' + str_repeat('=', 62);
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);

        L = [];
        L.push('"""Agent module ' + j(entry['display']) + ` -- node ${nid} of workflow ` + j(facts['wfName']));
        L.push('');
        body = this.modularDocBody(facts, layout,
            'LangGraph modular agent module (Python) -- one node; workflow.py drives the graph',
            { deps: [LangGraphPackage.PIP_REQUIREMENTS], usage: 'imported by workflow.py as ' + entry['module'] + ' -- run the workflow, not this file', extra: ['# Exposes NODE (frozen editor settings) and run_node = make_node(NODE).run; the node logic is common.py\'s Node classes.'], env_path: '../../../.env' }, nid);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('# The shared runtime lives in common.py, one directory up. Python puts the');
        L.push('# workflow folder on sys.path when workflow.py starts, so this resolves for');
        L.push('# every module of the package.');
        L.push('from common import make_node');
        L.push('');
        L.push(sep);
        L.push('# NODE DEFINITION -- frozen from the workflow editor');
        L.push(sep);
        for (let dn of values(this.modularDocNodes(facts, layout))) {
            if (dn['id'] === nid) {
                for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(dn)))) {
                    L.push(cl);
                }
            }
        }
        if (isPlaybook && (def['source'] ?? 'fixed') === 'input') {
            L.push(...LangGraphGenerator.publishedPlaybooksLines(facts['publishedPlaybooks'], facts['publishedSkipped']));
            L.push('');
        }
        defLines = kind === 'code'
            ? LangGraphGenerator.codeNodeDefinitionLines(nid, def)
            : this.nodeDefinitionLines(facts, nid, kind, entry['display'], def, isPlaybook);
        for (let nl of values(explode('\n', defLines))) {
            L.push(nl);
        }
        L.push('');
        L.push('# The node logic lives in common.py\'s Node classes: make_node(NODE) builds the');
        L.push('# subclass for this NODE\'s kind, and workflow.py calls its run(request_text, trace).');
        L.push('run_node = make_node(NODE).run');
        return rtrim(implode('\n', L), '\n') + '\n';
    }

    /** A code node's frozen settings (the NODE literal of a module, or an entry of CODE_NODES). */
    private static codeNodeDefinitionLines(nid: any, cd: any, opener: any = 'NODE = {', indent: any = ''): string {
        let j: any, L: any;
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        L = [];
        L.push(indent + opener);
        L.push(indent + '    "id": ' + j(nid) + ',');
        L.push(indent + '    "kind": "code",');
        L.push(indent + '    "display": ' + j(cd['display']) + ',');
        L.push(indent + '    "exits": ' + j(cd['exits']) + ',');
        L.push(indent + '    "mcp_servers": ' + j(cd['mcp_servers']) + ',');
        L.push(indent + '    "timeout_s": ' + intval(cd['timeout_s']) + ',');
        L.push(indent + '    "exit_targets": ' + j(toObject(cd['exit_targets'])) + ',');
        L.push(indent + '    "args": ' + j(toObject((cd['args'] ?? []))) + ',   # the code\'s ARGS');
        // The modular package reads the code from its file at each run (an edit takes effect on the
        // next run); the single file embeds it.
        L.push(((cd?.['source_file']) != null)
            ? indent + '    "source_file": ' + j(cd['source_file']) + ',   # relative to the package folder'
            : indent + '    "source": ' + j(cd['source']) + ',');
        L.push(indent + '}' + (indent !== '' ? ',' : ''));
        return implode('\n', L);
    }

    /**
     * The `NODE = {...}` literal shared by the A2A agent files and the modular
     * agent modules: the node's editor settings, frozen. The single file emits
     * its AGENTS / PLAYBOOKS entries through here too ($opener `"<id>": {`,
     * $indent four spaces), so every mode bakes the same keys, and the prompt
     * text verbatim (the model gets the same text in every mode).
     */
    private nodeDefinitionLines(facts: any, nid: any, kind: any, display: any, def: any, isPlaybook: any, opener: any = 'NODE = {', indent: any = ''): string {
        let j: any, verbatim: any, L: any;
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        // Text inside a triple-quoted string is emitted as is: indenting it would change the prompt.
        verbatim = (text: any) => explode('\n', str_replace(['\\', '"""'], ['\\\\', '\\"\\"\\"'], text));
        L = [];
        L.push(indent + opener);
        L.push(indent + '    "id": ' + j(nid) + ',');
        L.push(indent + '    "kind": ' + j(kind) + ',');
        L.push(indent + '    "display": ' + j(display) + ',');
        L.push(indent + '    "provider": ' + j(def['provider']) + ',');
        L.push(indent + '    "model": ' + j(def['model']) + ',');
        L.push(indent + '    "temperature": ' + json_encode(F(def['temperature'])) + ',');
        L.push(indent + '    "max_tokens": ' + intval(def['max_tokens']) + ',');
        L.push(indent + '    "thinking": ' + (in_array(def['thinking'] ?? null, ['on', 'off'], true) ? '"' + def['thinking'] + '"' : 'None')
            + ',  # node form Thinking attribute');
        if (isPlaybook) {
            L.push(indent + '    "title": ' + j(def['title']) + ',');
            L.push(indent + '    "domain": ' + j(def['domain']) + ',');
            L.push(indent + '    "writes_enabled": ' + (truthy(def['writes_enabled']) ? 'True' : 'False') + ',');
            L.push(indent + '    "policy": ' + PythonEmitHelpers.jsonToPython(def['policy'], true) + ',');
            L.push(indent + '    "approvers": ' + PythonEmitHelpers.jsonToPython(def['approvers'], true) + ',');
            L.push(indent + '    "requester": ' + PythonEmitHelpers.jsonToPython(def['requester'], true) + ',');
            L.push(indent + '    "instructions": """');
            L.push(...verbatim(def['instructions']));
            L.push('""",');
            L.push(indent + '    "actions": ' + PythonEmitHelpers.jsonToPython(def['actions'], false) + ',');
            if (!empty(def?.['exits'])) {
                // done / failed: the exit the run took picks the children (WorkflowGraph._code_router).
                L.push(indent + '    "exits": ' + j(def['exits']) + ',');
                L.push(indent + '    "exit_targets": ' + j(toObject(def['exit_targets'])) + ',');
            }
            if ((def['source'] ?? 'fixed') === 'input') {
                // The parent's JSON names the playbook (its input_field); it runs from the robot's published copies.
                L.push(indent + '    "source": "input",');
                L.push(indent + '    "input_field": ' + j(def['input_field']) + ',');
                L.push(indent + '    "published": PUBLISHED_PLAYBOOKS,');
            }
        } else {
            L.push(indent + '    "system_prompt": """');
            L.push(...verbatim(def['system_prompt']));
            L.push('""",');
            L.push(indent + '    "tool_names": ' + j(array_values(def['tool_names'])) + ',');
            // Ordered skill bindings ([{"dir": "..."}] / [{"inline": "..."}]) — the node
            // runs each as a mandatory post-agent step; the last produces the node output.
            L.push(indent + '    "skills": ' + j(def['skills'] ?? []) + ',');
            // Dispatcher menu: the node calls route_to over these names and only
            // the chosen child runs (conditional edge in WorkflowGraph).
            L.push(indent + '    "dispatch": ' + LangGraphGenerator.dispatchMenuLiteral(def['dispatch'] ?? []) + ',');
            L.push(indent + '    "decision_question": ' + PythonEmitHelpers.pyStr(strval((def['decision_question'] ?? ''))) + ',');
            L.push(indent + '    "routing_mode": ' + PythonEmitHelpers.pyStr(strval((def['routing_mode'] ?? ''))) + ',');
            L.push(indent + '    "unclear_branch": ' + PythonEmitHelpers.pyStr(strval((def['unclear_branch'] ?? ''))) + ',');
            L.push(indent + '    "min_confidence": ' + LangGraphGenerator.pyFloor(def) + ',');
            L.push(indent + '    "decision": ' + LangGraphGenerator.decisionLiteral(def['decision'] ?? []) + ',');
        }
        // An entry inside a dict literal (the single file's AGENTS / PLAYBOOKS) ends with a comma.
        L.push(indent + '}' + (indent !== '' ? ',' : ''));
        return implode('\n', L);
    }

    /** workflow.py: the graph over the agent modules, plus the CLI entry point. */
    private emitModularWorkflow(facts: any, layout: any): string {
        let sep: any, j: any, esc: any, modules: any, L: any, body: any, ofolder: any, docById: any, dispatch: any, typeMap: any, t: any;
        sep = '# ' + str_repeat('=', 62);
        j = (v: any) => json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        esc = (s: any) => str_replace(['\\', '"""'], ['\\\\', str_repeat('\'', 3)], s);
        modules = [];
        for (let [nid, e] of entries(layout['agents'])) {
            modules.push(sprintf('  %-6s %-24s %s', nid, e['display'], e['file']));
        }
        L = [];
        L.push('"""LangGraph workflow: ' + facts['wfName']);
        L.push('');
        body = this.modularDocBody(facts, layout,
            'LangGraph modular workflow (Python) -- StateGraph over one importable module per node',
            { deps: [LangGraphPackage.PIP_REQUIREMENTS, ...LangGraphPackage.OPTIONAL_FORMATS_NOTE], usage: 'python workflow.py "your prompt here"', extra: array_merge(!empty(facts?.['missing'])
                 ? ['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: ' + LangGraphGenerator.pythonListRepr(facts['missing'])]
                 : [], LangGraphGenerator.modeDocLines('workflow.py'), LangGraphGenerator.cronDocLines(facts, 'workflow.py'), LangGraphGenerator.watchDocLines(facts, 'workflow.py')), env_path: '../../.env' }, null, true);
        for (let dl of values(explode('\n', esc(body)))) {
            L.push(dl);
        }
        L.push('');
        L.push('AGENT MODULES  (id, name, file -- each exposes NODE and run_node)');
        L.push('=============');
        for (let m of values(modules)) {
            L.push(m);
        }
        L.push('  common.py holds the runtime they share and the WorkflowGraph; Start and Output run there, with no LLM.');
        L.push('"""');
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, json, os, re, signal, sys, time');
        L.push('from datetime import datetime, timedelta');
        L.push('from typing import Callable');
        L.push('');
        L.push('# Running this file puts its own folder on sys.path, so `common` and the');
        L.push('# `agents` package below resolve wherever the workflow folder is copied.');
        L.push('from common import EVENTS, MCP, MCP_SERVER_SLUGS, NULL_RECORDER, RUN_OUT, ConsoleView, ErrorExitTaken, RunRecorder, '
            + 'WorkflowGraph, is_quiet, print_run_summary, save_output');
        for (let [nid, e] of entries(layout['agents'])) {
            L.push('from ' + e['module'] + ' import run_node as ' + e['name'] + '_run');
        }
        L.push('');
        L.push('WORKFLOW_ID = ' + intval(facts['workflowId']));
        L.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(facts['wfName']));
        L.push('OUTPUT_STORAGE_ENABLED = ' + (facts['workflow'].isOutputStorageEnabled() ? 'True' : 'False'));
        ofolder = facts['workflow'].getOutputFolder();
        L.push('OUTPUT_FOLDER = ' + ((ofolder ?? '') !== '' ? PythonEmitHelpers.pyStr(strval(ofolder)) : 'None'));
        L.push('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(facts['startPrompt']));
        L.push(LangGraphGenerator.defaultCronLine(facts));
        L.push(LangGraphGenerator.defaultWatchLine(facts));
        L.push(...LangGraphGenerator.startModeLines(facts));
        L.push('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(truthy(facts['startDocuments']) ? facts['startDocuments'] : []));
        L.push('');
        L.push(sep);
        L.push('# AGENT TABLE -- what each node is, and which module runs it');
        L.push(sep);
        docById = oarr();
        for (let dn of values(this.modularDocNodes(facts, layout))) {
            docById[dn['id']] = dn;
        }
        L.push('AGENTS = {');
        for (let [nid, e] of entries(layout['agents'])) {
            if (((docById?.[nid]) != null)) {
                for (let cl of values(explode('\n', PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ')))) {
                    L.push(cl);
                }
            }
            dispatch = e['kind'] === 'dispatcher'
                ? array_map((t: any) => ({ id: strval(t['id']), name: t['name'] }), facts['agentData'][nid]['dispatch'])
                : [];
            L.push('    ' + j(strval(nid)) + ': {"display": ' + j(e['display']) + ', "kind": ' + j(e['kind'])
                + ', "module": ' + j(e['module']) + ', "dispatch": ' + j(dispatch)
                + (e['kind'] === 'code' ? ', "exit_targets": ' + j(toObject(facts['codeData'][nid]['exit_targets'])) : '') + '},');
        }
        L.push('}');
        L.push('');
        L.push('# node id -> the module function that runs it (imported above).');
        L.push('_NODE_RUNNERS = {');
        for (let [nid, e] of entries(layout['agents'])) {
            L.push('    ' + j(strval(nid)) + ': ' + e['name'] + '_run,');
        }
        L.push('}');
        L.push('');
        L.push(sep);
        L.push('# GRAPH STRUCTURE -- frozen from the workflow editor');
        L.push(sep);
        L.push('EDGES = ' + PythonEmitHelpers.jsonToPython(facts['edgeList']));
        L.push('ORDER = ' + PythonEmitHelpers.jsonToPython(facts['order']));
        typeMap = oarr();
        for (let nid of values(facts['order'])) {
            t = LangGraphGenerator.nodeType(facts['byId'][nid]);
            typeMap[nid] = t === 'agent-template' ? 'agent' : t;
        }
        L.push('NODE_TYPES = ' + PythonEmitHelpers.jsonToPython(typeMap, true));
        L.push('');
        L.push(LangGraphRuntime.cronBlock());
        L.push(LangGraphRuntime.watchBlock());
        L.push(LangGraphRuntime.listenerBlock());
        L.push(LangGraphGenerator.modularRunnerBlock());
        return rtrim(implode('\n', L), '\n') + '\n';
    }

    /** workflow.py's runtime half: node runner, graph build, output storage, CLI. */
    private static modularRunnerBlock(): string {
        return `# ==============================================================
# NODE RUNNER
# Every agent/playbook node goes through here: frame nothing (workflow.py
# already did), call the module, time it, report.
# ==============================================================
NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)
GRAPH_RECORDER = NULL_RECORDER   # the run's RunRecorder; the program sets it before each run (trace reads it)
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # this program's folder: runs/, .run.lock
RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")   # one JSONL log per run (RUNS_DIR overrides)


async def _run_node_module(nid: str, request_text: str) -> dict:
    """Run node \`nid\` by calling its module. Returns {"text", "route", "notes", "status"}.

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
        EVENTS.emit(type="message", text=f"**{ad['display']}**\\n\\n{out['text']}", sensitive=False)
    EVENTS.emit(type="final", leg=nid, status=out.get("status") or "ok")
    return out


# ==============================================================
# MAIN EXECUTION -- the LangGraph state graph over the agent modules
# ==============================================================
def build_graph(recorder: RunRecorder | None = None) -> WorkflowGraph:
    """The workflow's graph (common.WorkflowGraph): agent nodes call their modules; \`recorder\` records the run."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents=AGENTS,
                         run_node=_run_node_module, start_documents=START_DOCUMENTS, recorder=recorder)


async def run(user_prompt: str, session: str | None = None) -> str:
    """Build the graph (agent nodes call their modules), run it, return the final output.

    \`session\` is accepted so this signature matches the swarm target's run()
    (api.py calls both the same way) but is ignored here: a DAG run has no
    conversation to resume -- each call is already a fresh, independent run.
    """
    return await build_graph().run(user_prompt)


def make_run_once(prompt: str, runs: RunLoop, view: ConsoleView, recorder: RunRecorder, *,
                  loop_mode: bool = False, unattended: bool = False) -> Callable[[], str]:
    """The program's run_once(): one run of the workflow on \`prompt\`, recorded by \`recorder\` (its run
    log, and \`view\` on the console). Returns the output ('' when the run ended without one). A quiet
    run (the server's rule: a code node's non-error exit and no agent, playbook or output node)
    leaves no log and prints nothing. Raises ErrorExitTaken when a code node took its error exit,
    and whatever the run raised, once the failure is recorded.

    Console: under --cron / --watch (\`loop_mode\`) the view's block is the run's only output -- the
    progress lines (RUN_OUT) show only under --verbose, no FINAL OUTPUT or RUN SUMMARY; a --once
    run prints as it goes, except under --quiet (the done / failed line only).

    \`unattended\` (--watch, --listen): nobody answers the run's playbook gates -- a gate ends the
    playbook as handed_off (WorkflowGraph.unattended; PLAYBOOK_GATE_MODE, when set, still wins)."""
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
            graph.unattended = unattended
            output = ev_loop.run_until_complete(graph.run(prompt))
            if is_quiet(NODE_TYPES, graph.routes, graph.agents, graph.ran):
                view.discard()
                RUN_OUT.release(False)
                recorder.end(quiet=True)
                return ""
            RUN_OUT.release(show_held)
            if output:
                if chatty:
                    print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)
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
    own, so api.py and \`python workflow.py\` never listen at once. ValueError: the Start's schedule or
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
    run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True, unattended=True)
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
    run_once = make_run_once(prompt, runs, view, recorder, loop_mode=mode != "once", unattended=mode == "watch")
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
                 lock_path=os.path.join(PACKAGE_DIR, ".run.lock"), verbosity=view.verbosity).run_blocking()`;
    }

    // ---------- static Python code blocks ----------
    // These correspond to the textwrap.dedent('''...''') heredocs in the
    // Python generator. Reproduced here byte-for-byte as nowdoc strings.
    //
    // mcpClientBlock()  → LangGraphRuntime::mcpClientBlock() (LangGraph's own McpClient;
    //                      PythonEmitHelpers::mcpClientBlock() stays for ADK/MAF/NOOA)
    // toolBuilderBlock() → LangGraphRuntime::toolCatalogBlock() + skillRuntimeBlock()
    //                      (LangGraph's own copies; the shared skill blocks stay for ADK/MAF/NOOA)

    /** True when some playbook node runs "from input" (PUBLISHED_PLAYBOOKS is then emitted). */
    private static hasFromInput(playbookData: any): boolean {
        return !isEmptyArr(array_filter(playbookData, (pd: any) => (pd['source'] ?? 'fixed') === 'input'));
    }

    /**
     * The robot's published playbooks, bound like a fixed playbook node (PlaybookEmit::nodeData) and
     * keyed by playbook key: [baked documents, [key => why it was left out]]. No robot account: none.
     * A copy whose #Actions do not bind is left out (a job naming it fails as playbook_not_found)
     * rather than failing the whole compile.
     */
    private async publishedPlaybooks(availableById: any, providerDefaults: any, userId: string | null): Promise<[any, any]> {
        let key: any, d: any;
        const robotId = await RobotAccount.id();
        if (robotId === null) {
            return [oarr(), oarr()];
        }
        const baked: any = oarr();
        const skipped: any = oarr();
        for (let row of values(await new PlaybookStore().robotList(robotId))) {
            key = strval(row['pkey']);
            try {
                d = await PlaybookEmit.nodeData({ id: key, config: { playbook: strval(row['text']), name: strval(row['title']) } },
                    availableById, providerDefaults, userId);
            } catch (e: any) {
                const msg = e?.message ?? String(e);
                skipped[key] = msg;
                console.error(`[LangGraphGenerator] published playbook "${key}" not baked: ` + msg);
                continue;
            }
            baked[key] = array_intersect_key(d, array_flip(['title', 'domain', 'instructions', 'policy', 'approvers', 'actions']));
        }
        return [baked, skipped];
    }

    /** `PUBLISHED_PLAYBOOKS = {key: {title, domain, instructions, policy, approvers, actions}}` (single file, modular module). */
    private static publishedPlaybooksLines(published: any, skipped: any): any {
        let L: any;
        L = ['# PUBLISHED PLAYBOOKS -- the robot\'s published copies, baked at compile time: a "from input"',
              '# playbook node runs the one its parent\'s JSON names (an unknown key takes the failed exit).'];
        for (let [key, why] of entries(skipped)) {
            L.push('# WARNING: published playbook "' + key + '" not baked: ' + str_replace(['\r\n', '\r', '\n'], ' ', why));
        }
        if (isEmptyArr(published)) {
            L.push('PUBLISHED_PLAYBOOKS = {}');
            return L;
        }
        L.push('PUBLISHED_PLAYBOOKS = {');
        for (let [key, d] of entries(published)) {
            L.push('    ' + PythonEmitHelpers.pyStr(strval(key)) + ': {');
            L.push('        "title": ' + PythonEmitHelpers.pyStr(strval(d['title'])) + ',');
            L.push('        "domain": ' + PythonEmitHelpers.pyStr(strval((d['domain'] ?? ''))) + ',');
            L.push('        "instructions": ' + PythonEmitHelpers.pyStr(strval(d['instructions'])) + ',');
            L.push('        "policy": ' + PythonEmitHelpers.jsonToPython(d['policy'], true) + ',');
            L.push('        "approvers": ' + PythonEmitHelpers.jsonToPython(d['approvers'], true) + ',');
            L.push('        "actions": ' + PythonEmitHelpers.jsonToPython(d['actions'], false) + ',');
            L.push('    },');
        }
        L.push('}');
        return L;
    }

    /**
     * Bake one playbook node: parse + analyze the playbook against the
     * registry ids and describe what the emitted runtime needs. Throws when
     * the playbook text is missing or has hard binding errors, like the
     * browser runner (PlaybookNodeRunner) does.
     *
     * @see PlaybookEmit::nodeData() -- shared with every other compile target.
     */
    private playbookData(node: any, availableById: any, providerDefaults: any, userId: any): any {
        return PlaybookEmit.nodeData(node, availableById, providerDefaults, userId);
    }

    /**
     * A dispatcher's menu as a Python list literal: [{"id", "name", "description"}, ...].
     * One emitter for every LangGraph mode (single script AGENTS, A2A agent NODE,
     * modular module NODE) so the menu the route_to tool and Jev see cannot drift.
     */
    private static dispatchMenuLiteral(targets: any): string {
        return '[' + implode(', ', array_map(
            (t: any) => '{"id": ' + PythonEmitHelpers.pyStr(strval(t['id']))
                + ', "name": ' + PythonEmitHelpers.pyStr(strval(t['name']))
                + ', "description": ' + PythonEmitHelpers.pyStr(strval((t['description'] ?? ''))) + '}',
            targets
        )) + ']';
    }

    /**
     * A dispatcher's decision candidates as a one-line Python list literal, spaced like
     * dispatchMenuLiteral(): [{"provider": "jev", "protocol": "typesafe", ...}, ...].
     */
    private static decisionLiteral(candidates: any): string {
        return '[' + implode(', ', array_map(
            (c: any) => '{' + implode(', ', array_map(
                (k: any) => '"' + k + '": ' + PythonEmitHelpers.pyStr(strval(c[k])),
                array_keys(c)
            )) + '}',
            candidates
        )) + ']';
    }

    /** A dispatcher's decision-model floor as a Python float literal (0.6, 1.0, 0.85). */
    private static pyFloor(ad: any): string {
        return var_export_scalar(F(ad['min_confidence'] ?? DEFAULT_CONFIDENCE_FLOOR));
    }

    /** MCP_SERVER_SLUGS: every MCP server URL this workflow (or this A2A node) uses -> its slug (McpClient._headers reads MCP_HEADERS_<SLUG>). */
    private static serverSlugsLine(slugs: any): string {
        return 'MCP_SERVER_SLUGS = ' + PythonEmitHelpers.jsonToPython(slugs, true);
    }

    /** The .env lines a run needs for servers that take headers (values are the user's, never emitted). */
    private static mcpHeaderDocLines(facts: any): any {
        let lines: any;
        lines = [];
        for (let slug of values(array_unique(array_values(facts['serverSlugs'] ?? [])))) {
            if (slug === '') {
                continue;
            }
            lines.push('# MCP_HEADERS_' + strtoupper(slug) + '={"Header": "value"}   # in .env, only if this MCP server needs headers'
                + ' (a server you connected in the editor: the header and key saved on its MCP server row)');
            lines.push('# MCP_URL_' + strtoupper(slug) + '=http://host:port/mcp   # in .env, only if this MCP server no longer answers at the URL compiled in');
        }
        if (lines.length) {
            lines.push('# (one connection per MCP URL: for a second account, run a second MCP server instance on its own URL)');
        }
        return lines;
    }

    /**
     * The decision providers a dispatcher may route with, written into the script
     * (it never reads the database): the named row, every usable row in admin order
     * for an unset mode, none for 'llm' or a key with no usable row.
     *
     * @return list<array{provider: string, protocol: string, url: string, model: string, key_env: string, url_env: string}>
     */
    private async decisionCandidates(mode: string): Promise<any[]> {
        if (mode === 'llm') {
            return [];
        }
        const out: any[] = [];
        for (const row of await DecisionProviders.rows()) {
            const key = strval(row['provider_key']);
            const protocol: any = DecisionProviders.protocolOf(row);
            if (protocol === null || (mode !== '' && key !== mode)) {
                continue;
            }
            const stem = DecisionProviders.envStem(key);
            const url = trim(strval(row['base_url'] ?? ''));
            const model = trim(strval(row['model'] ?? ''));
            out.push({
                provider: key,
                protocol: strval(row['protocol']),
                url: truthy(url) ? url : protocol['url'],
                model: truthy(model) ? model : protocol['model'],
                key_env: stem + '_API_KEY',
                url_env: stem + '_BASE_URL',
            });
        }
        return out;
    }

    /** @return list<string> protocols any dispatcher of this workflow may use (one adapter each). */
    private static decisionProtocolsUsed(agentData: any): any {
        let ids: any;
        ids = oarr();
        for (let ad of values(agentData)) {
            for (let c of values(ad['decision'] ?? [])) {
                ids[c['protocol']] = true;
            }
        }
        return array_keys(ids);
    }

    /**
     * TO RUN note for the decision-model env vars, per provider the dispatchers may use:
     * required for a dispatcher naming that provider, optional for an unset one.
     * LangGraph-only: the other compile targets route every dispatcher with the model.
     */
    private static decisionDocLines(agentData: any): any {
        let required: any, optional: any, name: any, mode: any, lines: any;
        required = oarr();
        optional = oarr();
        for (let ad of values(agentData)) {
            if (empty(ad?.['dispatch'])) {
                continue;
            }
            name = str_replace(['\r', '\n'], ' ', strval((ad['display'] ?? '')));
            mode = ad['routing_mode'] ?? '';
            for (let c of values(ad['decision'] ?? [])) {
                if (mode === '') {
                    (optional[c['key_env']] ??= []).push(name);
                } else {
                    (required[c['key_env']] ??= []).push(name);
                }
            }
        }
        lines = [];
        for (let [env, names] of entries(required)) {
            lines.push(`# Required: ${env} for dispatchers (` + implode(', ', array_unique(names)) + ');');
            lines.push('#   without it (or when the decision model cannot decide) they do not route and the run stops there.');
        }
        for (let [env, names] of entries(optional)) {
            lines.push(`# Optional: ${env} for dispatchers with no routing mode saved (` + implode(', ', array_unique(names)) + '):');
            lines.push('#   the first decision model whose key is set routes (else the model); once one is chosen, a request it cannot decide stops the run there (no model fallback).');
        }
        if (!isEmptyArr(required) || !isEmptyArr(optional)) {
            lines.push('#   Each key has a matching <NAME>_BASE_URL (a gateway). TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.');
        }
        return lines;
    }

    /** DATA FLOW section of the module docstring (LangGraph-specific mechanics). */
    private static dataFlowDoc(): string {
        return `The script embeds the agents (AGENTS), playbooks (PLAYBOOKS), the MCP
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

Tools are called over the MCP protocol: initialize handshake (the URL as
registered first, then with /mcp in its path), tools/call, JSON or SSE
response, text content back to the model.`;
    }

    private static stateBlock(): string {
        return `def _merge(left: dict | None, right: dict | None) -> dict:
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
`;
    }

    private static datetimeInjectorBlock(): string {
        return `def inject_datetime(system_prompt: str) -> str:
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
        f"## Current Date & Time\\n"
        f"Today is {weekday_str}, {date_str} ({time_str}).\\n"
        f"Use this as the reference for any date-sensitive reasoning "
        f"(recent research, latest news, time-relative phrasing, etc.).\\n\\n"
    )
    return header + prompt
`;
    }

    static contextBuilderBlock(): string {
        return `def build_context(user_prompt: str, parent_ids: list[str], outputs: dict) -> str:
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
    return "\\n".join(parts)
`;
    }

    /**
     * The single file's run(): its nodes live in this process, so run_node is
     * _run_local_node, and the graph itself is the shared WorkflowGraph. Then the
     * __main__ block. $missingWarning is the '[warn] Missing tools' line (or '').
     */
    private static singleRunBlock(missingWarning: any): string {
        return `# One Node per agent and playbook node -- provider/model come from the AGENTS
# and PLAYBOOKS dicts, which the generator baked from each node's workflow config.
# Each node builds its chat model on first use (Node.llm), not here.
NODES = {nid: make_node(cfg) for nid, cfg in {**AGENTS, **PLAYBOOKS, **CODE_NODES}.items()}
NODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)
GRAPH_RECORDER = NULL_RECORDER   # the run's RunRecorder; the program sets it before each run (trace reads it)
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # this program's folder: runs/, .run.lock
RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")   # one JSONL log per run (RUNS_DIR overrides)


async def _run_local_node(nid: str, request: str) -> dict:
    """Run node \`nid\` in this process: its console lines are tagged [node] [nid], and the
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
    \`recorder\` records the run."""
    return WorkflowGraph(edges=EDGES, order=ORDER, node_types=NODE_TYPES, agents={**AGENTS, **PLAYBOOKS, **CODE_NODES},
                         run_node=_run_local_node, start_documents=START_DOCUMENTS, recorder=recorder)


async def run(user_prompt: str, graph: WorkflowGraph | None = None) -> str:
    """Execute the workflow with the given user prompt; returns the final output text.

    Steps:
    1. Build LangChain tools from the embedded TOOL_CATALOG
    2. Run the WorkflowGraph (\`graph\`, else build_graph()): one Node per agent/playbook
       node, each building its own chat model on first use
    """
    RUN_OUT.once("[info] Building tools from embedded catalog...")
    catalog = TOOLS.build()   # built once here; every node then takes its own tools from TOOLS
    RUN_OUT.once(f"[info] {len(catalog)} tools ready: {sorted(catalog.keys())}")
` + missingWarning + `    return await (graph or build_graph()).run(user_prompt)


def make_run_once(prompt: str, runs: RunLoop, view: ConsoleView, recorder: RunRecorder, *,
                  loop_mode: bool = False, unattended: bool = False) -> Callable[[], str]:
    """The program's run_once(): one run of the workflow on \`prompt\`, recorded by \`recorder\` (its run
    log, and \`view\` on the console). Returns the output ('' when the run ended without one). A quiet
    run (the server's rule: a code node's non-error exit and no agent, playbook or output node)
    leaves no log and prints nothing. Raises ErrorExitTaken when a code node took its error exit,
    and whatever the run raised, once the failure is recorded.

    Console: under --cron / --watch (\`loop_mode\`) the view's block is the run's only output -- the
    progress lines (RUN_OUT) show only under --verbose, no FINAL OUTPUT or RUN SUMMARY; a --once
    run prints as it goes, except under --quiet (the done / failed line only).

    \`unattended\` (--watch, --listen): nobody answers the run's playbook gates -- a gate ends the
    playbook as handed_off (WorkflowGraph.unattended; PLAYBOOK_GATE_MODE, when set, still wins)."""
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
            graph.unattended = unattended
            output = ev_loop.run_until_complete(run(prompt, graph))
            if is_quiet(NODE_TYPES, graph.routes, graph.agents, graph.ran):
                view.discard()
                RUN_OUT.release(False)
                recorder.end(quiet=True)
                return ""
            RUN_OUT.release(show_held)
            if output:
                if chatty:
                    print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output)
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
    run_once = make_run_once(prompt, runs, view, recorder, loop_mode=mode != "once", unattended=mode == "watch")
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
`;
    }
}

