"""Port of backend/src/AgentTeam/Services/LangGraphGenerator.php -- the LangGraph compiler.

Generates a standalone Python LangGraph program from a saved workflow: a single file, a modular package
("agents in separate files", one importable module per node), an A2A folder (one agent server per node and
an orchestrator) or, for a swarm workflow, the modular swarm package. The emitted bytes are PHP's for the
same inputs (tests/unit/test_lang_graph_compiler_differential.py compiles fixtures with both and compares).

The generated program is fully independent of the backend: it connects directly to MCP servers via
JSON-RPC 2.0 over HTTP and reads only its .env.

This module holds the analysis (analyzeForEmit), the single-file emitter and the helpers every layout
shares; the A2A, modular and swarm emitters live in lang_graph_layouts.py (LangGraphLayouts, a base class).
"""
from __future__ import annotations

import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.compiler_php import (
    PhpObj, j, json_decode_obj, json_to_python, obj, py_str, var_export_float,
)
from app.agent_team.services.compiler_text import lang_graph_generator as T
from app.agent_team.services.compiler_text.llm_factory_lines import LLM_FACTORY_LINES
from app.agent_team.services.dispatch_routing import DispatchRouting
from app.agent_team.services.jev_router import JevRouter
from app.agent_team.services.lang_graph_layouts import LangGraphLayouts
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.playbook_source import PlaybookSource
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.start_trigger_facts import StartTriggerFacts
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.playbook.playbook_store import PlaybookStore
from app.services.decision_providers import DecisionProviders
from app.services.robot_account import RobotAccount
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_floatval, php_intval, php_strval, php_trim

_PHP_TRIM = ' \t\n\r\x00\x0b'


def _first(*values):
    """`$a ?? $b ?? ...`: the first value that is not None (None when all are)."""
    for v in values:
        if v is not None:
            return v
    return None


def _elvis(v: str, alt):
    """`$v ?: $alt` for a string: '' and '0' are falsy."""
    return alt if v in ('', '0') else v


def _esc_doc(s: str) -> str:
    """A module docstring body: backslashes doubled, then any \"\"\" spelled '''."""
    return s.replace('\\', '\\\\').replace('"""', "'''")


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


def _byte_sorted(items: list) -> list:
    """sort($a, SORT_STRING): byte order."""
    return sorted(items, key=lambda s: str(s).encode('utf-8'))


SEP = '# ' + '=' * 62


class LangGraphGenerator(LangGraphLayouts):
    def __init__(self, db, workflowRepo, graphRepo, agentRepo, skillsRoot: str | None = None, startDocuments=None):
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo
        # Where the skill folders the modular package copies are read from (LangGraphPackage).
        self.skillsRoot = skillsRoot if skillsRoot is not None else LangGraphPackage.defaultSkillsRoot()
        # The requesting user's document storage: the only place a Start document is copied from.
        self.startDocuments = startDocuments

    # ---------- helpers ----------

    @staticmethod
    def _nodeType(n: dict) -> str:
        """node_type, else type, else config.type ('' counts as missing); no type at all is an agent."""
        cfg = n.get('config') if isinstance(n.get('config'), dict) else {}
        for t in (n.get('node_type'), n.get('type'), cfg.get('type')):
            if t is not None and php_strval(t) != '':
                return php_strval(t)
        return 'agent'

    @staticmethod
    def _serverSlug(serverName: str) -> str:
        """"<server slug>.<tool>" ids the playbook analyzer binds against -- twin of LoaderMcpExecutor::slug()."""
        return re.sub(r'[^a-z0-9]+', '_', serverName, flags=re.IGNORECASE | re.ASCII).lower()

    @staticmethod
    def _nodeId(n: dict) -> str:
        return php_strval(_first(n.get('id'), n.get('drawflow_node_id'), n.get('_id'), ''))

    @staticmethod
    def _edgeFrom(e: dict) -> str:
        return php_strval(_first(e.get('from_node_id'), e.get('from'), e.get('source'), ''))

    @staticmethod
    def _edgeTo(e: dict) -> str:
        return php_strval(_first(e.get('to_node_id'), e.get('to'), e.get('target'), ''))

    @classmethod
    def _displayName(cls, node: dict) -> str:
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        name = _first(cfg.get('agent_name'), cfg.get('name'), node.get('name'))
        if name is not None and name != '':
            return php_strval(name)
        return 'node_' + cls._nodeId(node)

    @staticmethod
    def _safeVar(name: str) -> str:
        """Every run of non-[A-Za-z0-9] becomes one '_', trimmed and lower-cased."""
        out = re.sub(r'[^A-Za-z0-9]+', '_', name)
        return out.strip('_').lower()

    def _loadMcpToolsWithServers(self, userId: str | None = None) -> list:
        """MCP tools with server info (url, name), global servers plus the caller's own registrations."""
        sql = ('SELECT t.*, s.name AS server_name, s.url AS server_url\n'
               '                FROM mcp_server_tools t\n'
               '                JOIN mcp_servers s ON t.server_id = s.id\n'
               '                WHERE s.enabled = 1 AND (s.user_id IS NULL'
               + (' OR s.user_id = :uid' if userId is not None and userId != '' else '') + ')')
        rows = self.db.fetch_all(sql, {'uid': userId} if userId is not None and userId != '' else {})
        out = []
        for row in rows:
            row = dict(row)
            # Decode input_schema JSON; keep objects so an empty {} stays an object.
            raw = row.get('input_schema')
            schema = None
            if isinstance(raw, str) and raw != '':
                schema = json_decode_obj(raw)
            row['input_schema'] = schema
            out.append(row)
        return out

    # ---------- generate ----------

    def generate(self, workflowId: int, userId: str | None = None, options: dict | None = None) -> dict:
        """Single file: {filename, code, architecture}. Modular / A2A: {root, files, architecture}, files ending
        with ARCHITECTURE.md. Swarm: {root, files}. architecture is None for an ingestion pipeline."""
        options = options or {}
        facts = self._analyzeForEmit(workflowId, userId)
        orchestration = facts.get('orchestration') or 'workflow'
        if facts['triggerNodeId'] is not None and (options.get('a2a') or orchestration == 'swarm'):
            raise RuntimeError('A Start option (' + facts['startOptionLabel'] + ') needs the single-file or modular format.')
        if facts['codeData'] and orchestration == 'swarm':
            raise RuntimeError('Code nodes are not supported by the swarm packaging yet. '
                               'Compile this workflow as a single file or with agents in separate files.')
        if orchestration == 'swarm':
            if options.get('a2a'):
                raise RuntimeError(
                    'A2A packaging is not supported for swarm workflows yet. Generate this swarm with "Agents in separate files".')
            if not options.get('modular'):
                raise RuntimeError(
                    'Single file packaging is not supported for swarm workflows yet. Generate this swarm with the modular layout ("Agents in separate files").')
            return self._generateSwarm(facts)
        if facts['codeData'] and options.get('a2a'):
            raise RuntimeError('Code nodes are not supported by the A2A packaging yet. '
                               'Compile this workflow as a single file or with agents in separate files.')
        if options.get('a2a') and [pd for pd in facts['playbookData'].values()
                                   if (pd.get('source') or 'fixed') == 'input' or pd.get('exits')]:
            raise RuntimeError('Playbook nodes with exits or "from input" are not supported by the A2A packaging yet. '
                               'Compile this workflow as a single file or with agents in separate files.')
        if options.get('a2a'):
            return self._generateA2A(facts)
        if options.get('modular'):
            return self._generateModular(facts)
        return self._generateSingle(facts)

    def _generateSingle(self, facts: dict) -> dict:
        f = facts
        agentData, playbookData, codeData = f['agentData'], f['playbookData'], f['codeData']
        workflow, wfName, safeName, workflowId = f['workflow'], f['wfName'], f['safeName'], f['workflowId']
        missing = f['missing']
        lines: list = []
        sep = SEP

        # ---- module docstring: the uniform documentation every target carries ----
        docAgents: dict = {}
        for nid, ad in agentData.items():
            docAgents[nid] = {'name': ad['display'], 'provider': ad['provider'], 'model': ad['model'],
                              'temperature': ad['temperature'], 'max_tokens': ad['max_tokens'], 'thinking': ad['thinking'],
                              'tools': ad['tool_names'], 'skills': ad['skills']}
        docExtra: dict = {}
        for nid, targets in f['dispatchTargets'].items():
            docExtra.setdefault(nid, {})['dispatch'] = [t['name'] for t in targets]
        for nid, pd in playbookData.items():
            mcpCount = len([a for a in pd['actions'] if (a.get('kind') or '') == 'mcp'])
            docExtra.setdefault(nid, {})['playbook'] = {'title': pd['title'], 'writes': pd['writes_enabled'],
                                                        'bound': mcpCount, 'unbound': len(pd['actions']) - mcpCount}
            docAgents[nid] = {'name': pd['display'], 'provider': pd['provider'], 'model': pd['model'],
                              'temperature': pd['temperature'], 'max_tokens': pd['max_tokens'], 'thinking': pd['thinking'],
                              'tools': [], 'skills': []}
        for nid, cd in codeData.items():
            docAgents[nid] = {'name': cd['display'], 'provider': '', 'model': '', 'temperature': None,
                              'max_tokens': None, 'thinking': None, 'tools': [f'{slg}.*' for slg in cd['mcp_servers']],
                              'skills': []}
        docNodes = WorkflowGraphAnalyzer.docNodes(f['byId'], f['order'], f['edges'], docAgents, docExtra,
                                                  ['start', 'agent', 'agent-template', 'playbook', 'code', 'output'])
        docById = {dn['id']: dn for dn in docNodes}
        script = f'{safeName}_langgraph.py'
        docBody = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph (Python) -- langgraph StateGraph + LangChain ReAct agents',
            'dispatch_supported': True,
            'workflow': {'id': workflowId, 'name': wfName},
            'nodes': docNodes,
            'edges': f['edgeList'],
            'layers': f['gdata'].get('layers') or [],
            'data_flow': self._dataFlowDoc(),
            'run': {
                'deps': ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                         '# optional, only for the attachment formats you use:',
                         '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'],
                'usage': f'python {script} "your prompt here"',
                'extra': ((['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: '
                            + self._pythonListRepr(missing)] if missing else [])
                          + self._decisionDocLines(agentData) + self._mcpHeaderDocLines(f) + self._modeDocLines(script)
                          + self._cronDocLines(f, script) + self._watchDocLines(f, script)
                          + ['# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); use the modular package for a self-contained copy.']),
            },
            'storage': {'enabled': workflow.isOutputStorageEnabled(), 'folder': workflow.getOutputFolder(),
                        'default': 'outputs/workflow/ next to this script (SYNERGYAI_OUTPUT_ROOT overrides)'},
        })
        lines.append('"""Standalone LangGraph workflow: ' + wfName)
        lines.append('')
        lines.extend(_esc_doc(docBody).split('\n'))
        lines.append('"""')
        lines.append('from __future__ import annotations')
        lines.append('')
        lines.append('import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid' + (', types' if codeData else ''))
        lines.append('from abc import ABC, abstractmethod')
        lines.append('from dataclasses import asdict, dataclass, field')
        lines.append('from datetime import datetime, timedelta')
        lines.append('from enum import Enum')
        lines.append('from functools import cached_property')
        lines.append('from pathlib import Path')
        lines.append('')
        lines.append('from dotenv import load_dotenv')
        lines.append('')
        lines.append('# Load provider API keys from the runner env .env (one dir up from scripts/).')
        lines.append('# Without this a DIRECT terminal run has no credentials and every provider')
        lines.append('# call fails; runner-mediated runs only worked because main.py loads the')
        lines.append('# same file and subprocesses inherit the environment.')
        lines.append('# A .env next to this script comes first (load_dotenv never overrides a variable already set),')
        lines.append('# so a copy run outside the runner folder carries its own keys.')
        lines.append('load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))')
        lines.append('RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the runner env folder (python/)')
        lines.append('load_dotenv(os.path.join(RUNNER_DIR, ".env"))')
        lines.append("DEBUG_STEM = Path(__file__).stem   # names this script's outputs/_debug message-history dumps")
        lines.append('from typing import Annotated, Awaitable, Callable, Literal, TypedDict')
        lines.append('')
        lines.append('import httpx')
        lines.append('# Provider-aware LLM wiring — each agent uses the LLM (provider/model)')
        lines.append('# configured for it in the workflow editor. Imports are lazy inside')
        lines.append('# _make_llm so a missing optional package only breaks the agents that')
        lines.append('# actually use that provider, not the whole script.')
        lines.append('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage')
        lines.append('from langchain_core.tools import StructuredTool')
        lines.append('from langgraph.graph import END, START, StateGraph')
        lines.append('try:')
        lines.append('    from langchain.agents import create_agent as create_react_agent')
        lines.append('except ImportError:')
        lines.append('    from langgraph.prebuilt import create_react_agent')
        lines.append('from pydantic import Field, create_model')
        lines.append('')
        lines.append('# Optional global override: setting MODEL_NAME in the env forces every')
        lines.append('# agent to use that model regardless of its per-agent setting. Useful for')
        lines.append("# quick experiments. Leave unset to honour each agent's configured model.")
        lines.append("MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()")
        lines.append('')
        lines.append('')
        lines.append(LangGraphRuntime.llmFactoryBlock())
        lines.append('')

        # ---------- MCP server registry (baked) ----------
        lines += [sep, '# MCP SERVER REGISTRY', "# Baked at generation time from the workflow editor's config.",
                  '# Maps server URL -> metadata. If a server moves, set MCP_URL_<SLUG> in .env',
                  '# (e.g. MCP_URL_OUTLOOK=http://host:8770/mcp); the URL here stays the key.', sep, '']
        lines.append('MCP_SERVERS = ' + json_to_python(f['usedServers'], True))
        lines.append('')
        if codeData:
            lines.append("# MCP_SLUGS: server slug -> URL, for code nodes' call_tool(server, tool, args).")
            lines.append('MCP_SLUGS = ' + json_to_python(f['codeSlugs'], True))
            lines.append('')

        # ---------- tool catalog (baked) ----------
        lines += [sep, '# TOOL CATALOG', '# Each entry maps a tool name to its MCP server URL and',
                  '# JSON Schema for input validation. Only tools actually used',
                  '# by agents in this workflow are included.',
                  '# To add a tool: add an entry here AND reference it in the',
                  "# agent's tool_names list in the AGENTS dict below.", sep, '']
        lines.append('TOOL_CATALOG = ' + json_to_python(f['usedCatalog'], True))
        lines.append('')

        # ---------- MCP JSON-RPC client ----------
        lines += [sep, '# MCP CLIENT -- JSON-RPC 2.0 over HTTP', sep, '']
        # The protocol steps and the SSE note are McpClient's class docstring.
        lines.append(self._serverSlugsLine(f.get('serverSlugs') or {}))
        lines.append('')
        lines.append(LangGraphRuntime.mcpClientBlock())
        if codeData:
            lines.append(LangGraphRuntime.codeHarnessBlock())
            lines.append('')

        # ---------- tool builder ----------
        lines += ['', sep, '# TOOL BUILDER', '# Converts the baked TOOL_CATALOG into LangChain StructuredTool',
                  '# objects. Each tool gets a dynamically-built Pydantic model for',
                  '# input validation (from the JSON Schema), and a callable that',
                  '# invokes the MCP server. The LLM agent calls these like any',
                  "# other LangChain tool -- it doesn't know about MCP internals.", sep, '']
        lines.append(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock())
        lines.append(LangGraphRuntime.runEventsBlock())
        lines.append(LangGraphRuntime.dispatcherBlock(self._decisionProtocolsUsed(agentData)))
        if playbookData:
            lines.append(LangGraphRuntime.playbookBlock())

        # ---------- state ----------
        lines += ['', sep, '# LANGGRAPH STATE', '#', '# WFState is the shared state that flows through the graph.',
                  '# - user_prompt: the original user input (immutable after start)',
                  '# - node_outputs: dict of node_id -> {source, text} -- each node',
                  '#   writes its output here. Uses a merge reducer so parallel',
                  '#   branches can both contribute without conflicts.',
                  '# - final_output: set by the output node as the workflow result', sep, '']
        lines.append(self._stateBlock())

        # ---------- datetime injector ----------
        lines += ['', sep, '# DATETIME INJECTOR', '#', "# LLMs have knowledge cutoffs and don't know the current date.",
                  "# inject_datetime() prepends a short context block to each agent's",
                  "# system prompt so the agent reasons with today's actual date.",
                  '# Also resolves any [date]/[weekday]/[year]/[time] placeholders',
                  '# that may exist inside the prompt text (legacy templating).', sep, '']
        lines.append(self._datetimeInjectorBlock())

        # ---------- context builder ----------
        lines += ['', sep, '# CONTEXT BUILDER', '#', '# Each agent receives a structured message containing:',
                  '#   1. The original user request (for reference)',
                  '#   2. Labeled outputs from direct upstream agents only',
                  "# This matches the PHP backend's 'labeled' merge strategy.",
                  "# The agent's system prompt tells it what to DO with this input.", sep, '']
        lines.append(self.contextBuilderBlock())

        # ---------- node classes ----------
        lines.append('')
        lines.append(LangGraphRuntime.nodeClassesBlock(bool(playbookData), bool(codeData)))

        # ---------- document converter ----------
        lines += ['', sep, '# DOCUMENT CONVERTER', '#', '# Reads a file at `path` and returns Markdown the LLM can read.',
                  '# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through',
                  '# verbatim. Binary office formats and PDFs are routed to their',
                  '# matching pure-Python library (mammoth / python-pptx / openpyxl /',
                  '# pypdf). Imports are lazy so the helper only pulls in heavy deps',
                  '# when a document of that format is actually attached.', '#',
                  "# This mirrors the editor's frontend converter (Pyodide) so the",
                  '# generated script behaves the same way the workflow did at design',
                  '# time. Paths come from the doc.path field stored in the workflow',
                  '# config — make sure the file is reachable from wherever you run',
                  '# this script (absolute paths recommended).', sep, '']
        lines.append(LangGraphRuntime.documentConverterBlock())

        # ---------- the graph, output storage and run summary (shared with every mode) ----------
        lines.append('')
        lines.append(LangGraphRuntime.runRecordBlock())
        lines.append(LangGraphRuntime.consoleBlock())
        lines.append(LangGraphRuntime.workflowGraphBlock())
        lines.append(LangGraphRuntime.outputBlock(True))   # outputs/ next to the script (spec 2026-10-15 §4.3)
        lines.append(LangGraphRuntime.cronBlock())
        lines.append(LangGraphRuntime.watchBlock())
        lines.append(LangGraphRuntime.listenerBlock())

        # ---------- start node config ----------
        lines += ['', sep, '# START NODE', '#', '# The start node feeds the prompt into the workflow.',
                  "# DEFAULT_PROMPT is baked from the workflow's start node config.",
                  '# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.',
                  '# If the workflow has documents attached to the start node,',
                  "# they're read from doc.path, converted to Markdown via",
                  '# DOCUMENTS.convert(), and prepended to the prompt.', sep, '']
        # Verbatim, as the package bakes it: no 80-column wrap, so the prompt is the same text in every mode.
        lines.append('DEFAULT_PROMPT = ' + py_str(f['startPrompt']))
        lines.append(self._defaultCronLine(f))
        lines.append(self._defaultWatchLine(f))
        lines += self._startModeLines(f)
        lines.append('')
        ofolder = workflow.getOutputFolder()
        lines.append('WORKFLOW_ID = ' + str(php_intval(workflowId)))
        lines.append('WORKFLOW_NAME = ' + py_str(wfName))
        lines.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if workflow.isOutputStorageEnabled() else 'False'))
        lines.append('OUTPUT_FOLDER = ' + (py_str(php_strval(ofolder)) if ofolder is not None and ofolder != '' else 'None'))
        lines.append('')
        if f['startDocuments']:
            lines.append('START_DOCUMENTS = ' + json_to_python(f['startDocuments']))
        else:
            lines.append('START_DOCUMENTS = []')
        lines.append('')

        # ---------- embedded agent definitions ----------
        lines += [sep, '# AGENT DEFINITIONS', '#', '# Each agent is identified by its workflow node ID.',
                  '#   id, kind:      The node ID again, and which Node class runs it (make_node)',
                  '#   display:       Human-readable name (for logs and context labels)',
                  "#   system_prompt: The agent's persona/instructions (sent as SystemMessage)",
                  '#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)', '#',
                  '# To modify an agent: edit its system_prompt or tool_names here.',
                  '# To add a new agent: add an entry, create edges in EDGES, and',
                  '# include the node ID in ORDER at the right topological position.', sep, '']
        lines.append('AGENTS = {')
        for nid, ad in agentData.items():
            if nid in docById:
                lines += PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ').split('\n')
            kind = 'dispatcher' if ad.get('dispatch') else 'agent'
            lines += self._nodeDefinitionLines(f, nid, kind, ad['display'], ad, False, '"' + nid + '": {', '    ').split('\n')
        lines.append('}')
        lines.append('')
        lines += [sep, '# PLAYBOOK DEFINITIONS', '#', '# A playbook node runs the Console-style playbook text through the',
                  '# playbook runtime below: native verbs (messages, notes, resolve), human',
                  '# gates, and the MCP tools its #Actions were bound to at generation time.',
                  '#   actions:        bound MCP actions (llm_name -> server_url/tool) and',
                  '#                   unbound stubs (the on_unbound policy applies)',
                  '#   writes_enabled: node toggle; write tools are blocked when False', sep, '']
        if self._hasFromInput(playbookData):
            lines += self._publishedPlaybooksLines(f['publishedPlaybooks'], f['publishedSkipped'])
            lines.append('')
        if not playbookData:
            lines.append('PLAYBOOKS = {}')
        else:
            lines.append('PLAYBOOKS = {')
            for nid, pd in playbookData.items():
                if nid in docById:
                    lines += PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ').split('\n')
                lines += self._nodeDefinitionLines(f, nid, 'playbook', pd['display'], pd, True, '"' + nid + '": {', '    ').split('\n')
            lines.append('}')
        lines.append('')
        lines.append('# CODE NODE DEFINITIONS -- run(input, call_tool), exits and declared tools, frozen from the editor')
        if not codeData:
            lines.append('CODE_NODES = {}')
        else:
            lines.append('CODE_NODES = {')
            for nid, cd in codeData.items():
                if nid in docById:
                    lines += PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ').split('\n')
                lines += self._codeNodeDefinitionLines(nid, cd, '"' + nid + '": {', '    ').split('\n')
            lines.append('}')
        lines.append('')

        # ---------- edge data ----------
        lines += [sep, '# GRAPH STRUCTURE', '#', '# EDGES: directed connections as (from_node_id, to_node_id) tuples.',
                  "# ORDER: topological execution order (Kahn's algorithm).",
                  '#        Guarantees every node runs after all its predecessors.',
                  "# NODE_TYPES: maps node_id -> type ('start', 'agent', 'playbook', 'output').",
                  "#              A code node's type is 'code'.", sep, '']
        lines.append('EDGES = ' + json_to_python(f['edgeList']))
        lines.append('ORDER = ' + json_to_python(f['order']))
        lines.append('NODE_TYPES = ' + json_to_python(self._typeMap(f), True))
        lines.append('')

        # ---------- main function ----------
        lines += [sep, '# MAIN EXECUTION', '#', "# run() builds the WorkflowGraph over this file's nodes and executes it;",
                  '# every agent/playbook node runs in this process (_run_local_node).', '#',
                  "# Agent nodes use LangChain's ReAct pattern: the LLM receives",
                  '# the system prompt + upstream context, and can call tools in a',
                  '# loop until it produces a final answer.', sep, '']
        lines.append(self._singleRunBlock(
            '    RUN_OUT.once("[warn] Missing tools (not MCP): ' + self._pythonListRepr(missing) + '", always=True)' + '\n'
            if missing else ''))

        code = '\n'.join(lines)
        # Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py.
        return {'filename': script, 'code': code, 'architecture': self._architectureDoc(facts, 'single')}

    def _typeMap(self, facts: dict) -> dict:
        typeMap: dict = {}
        for nid in facts['order']:
            t = self._nodeType(facts['byId'][nid])
            typeMap[nid] = 'agent' if t == 'agent-template' else t
        return typeMap

    @classmethod
    def _architectureDoc(cls, facts: dict, mode: str) -> str | None:
        """This compile's ARCHITECTURE.md, or None (an ingestion pipeline, or the doc failed to build)."""
        from app.agent_team.services.lang_graph_architecture_doc import LangGraphArchitectureDoc
        for n in facts['byId'].values():
            if cls._nodeType(n) in ('loader', 'splitter', 'vectorstore'):
                return None
        try:
            return LangGraphArchitectureDoc.build(facts, mode)
        except Exception as e:  # noqa: BLE001 -- the doc is a companion: never cost the user the code
            error_log(f'[LangGraphGenerator] {mode} ARCHITECTURE.md skipped: {e}')
            return None

    # ---------- analysis ----------

    def _analyzeForEmit(self, workflowId: int, userId: str | None) -> dict:
        """Everything the emitters need, computed once. No Python is produced here."""
        from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
        workflow = self.workflowRepo.findById(workflowId)
        if not workflow:
            raise RuntimeError(f'Workflow {workflowId} not found.')
        wfName = workflow.getName() or ('workflow_' + str(workflowId))
        safeName = self._safeVar(wfName)
        if safeName == '':
            safeName = 'workflow_' + str(workflowId)

        # Only what Start reaches is the workflow: unconnected canvas nodes stay out.
        graph = GraphWorkflowRunner.configuredTemplatesAsAgents(
            WorkflowGraphAnalyzer.reachableGraph(self.graphRepo.getGraph(workflowId)))
        # The server runner's node rules: a template it would refuse, and any type nothing runs, are compile errors.
        for n in graph.get('nodes') or []:
            t = self._nodeType(n)
            if t == 'agent-template':
                raise RuntimeError('Unconfigured agent template node found: ' + self._displayName(n)
                                   + ' — pick an agent or fill in its instructions.')
            if t not in ('start', 'agent', 'playbook', 'code', 'output'):
                raise RuntimeError('Node "' + self._displayName(n) + '" (' + t + ') cannot be compiled: '
                                   + 'LangGraph runs start, agent, playbook, code and output nodes.')
        gdata = WorkflowGraphAnalyzer.analyzeGraph(graph)
        byId = gdata['byId']
        order = gdata['order']
        startId = gdata['startNodeId']
        if startId == '':
            raise RuntimeError('No start node found.')
        edges = gdata['edges']
        startNode = byId[startId]
        startCfg = _first(startNode.get('config'), startNode.get('data'), {})
        if not isinstance(startCfg, dict):
            startCfg = {}
        startPrompt = php_strval(_first(startCfg.get('prompt'), ''))
        startDocuments = _first(startCfg.get('documents'), [])
        if not isinstance(startDocuments, (list, dict)):
            startDocuments = []

        # Provider default models (system_llm_settings.model), used when an agent has no explicit model.
        providerDefaults: dict = {}
        try:
            for rowP in self.db.fetch_all('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1'):
                providerDefaults[php_strval(_first(rowP.get('provider_key'), '')).lower()] = php_strval(_first(rowP.get('model'), ''))
        except Exception:  # noqa: BLE001 -- a missing table: agents with no model fail at run time
            pass

        mcpTools = self._loadMcpToolsWithServers(userId)

        # Server registry and tool catalog.
        serverRegistry: dict = {}
        toolCatalog: dict = {}
        for t in mcpTools:
            surl = php_strval(_first(t.get('server_url'), ''))
            sname = php_strval(_first(t.get('server_name'), ''))
            tname = php_strval(_first(t.get('tool_name'), t.get('name'), ''))
            if surl == '' or tname == '':
                continue
            if surl not in serverRegistry:
                serverRegistry[surl] = {'name': sname}
            desc = _first(t.get('tool_description'), t.get('description'), '')
            schema = t.get('input_schema')
            if schema is None:
                schema = PhpObj()
            toolCatalog[tname] = {'server_url': surl, 'description': desc, 'input_schema': schema}

        # Playbook binding ids ("<server slug>.<tool>") over the same registry.
        availableById: dict = {}
        for t in mcpTools:
            surl = php_strval(_first(t.get('server_url'), ''))
            tname = php_strval(_first(t.get('tool_name'), t.get('name'), ''))
            if surl == '' or tname == '':
                continue
            schema = t.get('input_schema')
            availableById[self._serverSlug(php_strval(_first(t.get('server_name'), ''))) + '.' + tname] = {
                'server_url': surl,
                'tool': tname,
                'description': php_strval(_first(t.get('tool_description'), t.get('description'), '')),
                'input_schema': PhpObj() if schema is None else schema,
            }

        # Dispatcher agents: their fan-out is a MENU (DispatchRouting).
        agentTypeCache: dict = {}

        def agentTypeOf(node: dict) -> str:
            cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
            t = php_strval(_first(cfg.get('agent_type'), ''))
            if t != '':
                return t
            aid = _first(node.get('agent_id'), cfg.get('agent_id'))
            if aid is None or aid == '':
                return 'standard'
            aid = php_intval(aid)
            if aid not in agentTypeCache:
                try:
                    a = self.agentRepo.findById(aid)
                    agentTypeCache[aid] = php_strval(_first(a.toArray().get('agent_type'), 'standard')) if a else 'standard'
                except Exception:  # noqa: BLE001
                    agentTypeCache[aid] = 'standard'
            return agentTypeCache[aid]

        dispatchTargets: dict = {}   # dispatcher nid => [{id, name, description}, ...]
        routedBy: dict = {}          # child nid => dispatcher display name
        for nid in order:
            node = byId[nid]
            if self._nodeType(node) not in ('agent', 'agent-template') or agentTypeOf(node) != 'dispatcher':
                continue
            targets = []
            for e in edges:
                if self._edgeFrom(e) != nid:
                    continue
                childId = self._edgeTo(e)
                child = byId.get(childId)
                if not child or self._nodeType(child) not in ('agent', 'agent-template', 'playbook', 'code'):
                    continue
                # 'description' stays EMPTY on purpose: the interpreter judges every option by its name alone.
                targets.append({'id': childId, 'name': self._displayName(child), 'description': ''})
                routedBy[childId] = self._displayName(node)
            if targets:
                dispatchTargets[nid] = targets

        # Agent data for each agent node.
        agentData: dict = {}
        allNeededTools: dict = {}
        for nid in order:
            node = byId[nid]
            ntype = self._nodeType(node)
            if ntype not in ('agent', 'agent-template'):
                continue
            cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
            agentId = _first(node.get('agent_id'), cfg.get('agent_id'))
            systemPrompt = php_strval(_first(cfg.get('systemPrompt'), cfg.get('instructions'), ''))
            rawTools = _first(cfg.get('selectedTools'), cfg.get('tools'), [])
            toolNames = self._toolNames(rawTools)
            agentProvider = ''
            agentModel = ''
            dispatcherName = self._displayName(node)
            dispatcherDesc = php_strval(_first(cfg.get('description'), ''))
            routingSettings = cfg.get('settings') if isinstance(cfg.get('settings'), dict) else {}
            if agentId is not None and agentId != '':
                try:
                    agent = self.agentRepo.findById(php_intval(agentId))
                    if agent is not None:
                        agentArr = agent.toArray()
                        if php_trim(php_strval(_first(agentArr.get('name'), ''))) != '':
                            dispatcherName = php_strval(agentArr['name'])
                        if php_trim(php_strval(_first(agentArr.get('description'), ''))) != '':
                            dispatcherDesc = php_strval(agentArr['description'])
                        recSettings = _first(agentArr.get('settings'), [])
                        if isinstance(recSettings, str):
                            from app.agent_team.services.compiler_php import json_decode_assoc
                            recSettings = json_decode_assoc(recSettings)
                        routingSettings = recSettings if isinstance(recSettings, dict) else {}
                        if systemPrompt == '':
                            systemPrompt = php_strval(_first(agentArr.get('instructions'), agentArr.get('system_prompt'),
                                                             agentArr.get('prompt'), ''))
                        agentProvider = php_strval(_first(agentArr.get('provider'), ''))
                        agentModel = php_strval(_first(agentArr.get('model'), ''))
                        agentTools = agentArr.get('tools')
                        if not toolNames and isinstance(agentTools, (list, dict)):
                            toolNames = self._toolNames(agentTools)
                except Exception:  # noqa: BLE001 -- matches the broad catch of the reference
                    pass
            # Node-level overrides (config beats the agent record).
            nodeProvider = php_strval(_first(cfg.get('llm_provider'), cfg.get('provider'), cfg.get('agent_provider'), ''))
            nodeModel = php_strval(_first(cfg.get('model'), ''))
            if nodeProvider != '':
                agentProvider = nodeProvider
            if nodeModel != '':
                agentModel = nodeModel
            if agentProvider == '':
                agentProvider = 'claude'
            if agentModel == '':
                agentModel = providerDefaults.get(agentProvider.lower(), '')

            # Skills are mandatory POST-agent steps, never prompt text.
            skills = WorkflowGraphAnalyzer.skillsFromConfig(cfg)

            # HTML-output nudge for a strong "produce HTML" intent with no skill to render it.
            pl = systemPrompt.lower()
            wantsHtml = ('output only the html' in pl or 'production-quality html' in pl or '<!doctype' in pl
                         or ('self-contained' in pl and '<style' in pl))
            if wantsHtml and not skills:
                systemPrompt = (systemPrompt.rstrip(_PHP_TRIM)
                                + '\n\n## Output format (CRITICAL — read carefully)\n'
                                + 'Your FINAL message MUST be the complete, self-contained HTML '
                                + 'document itself: start with `<!DOCTYPE html>` and end with '
                                + '`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick '
                                + 'code fences, no preamble, and no commentary before or after. Do NOT '
                                + 'narrate what you are about to do; produce the HTML directly as your '
                                + 'answer. The runtime saves your final message verbatim to an .html '
                                + 'file, so anything that is not HTML breaks the deliverable.')

            # Dispatcher routing (twin of GraphWorkflowRunner).
            if systemPrompt == '':
                systemPrompt = DispatchRouting.defaultInstructions(self._displayName(node),
                                                                   php_strval(_first(cfg.get('description'), '')), wfName)
            dispatch = dispatchTargets.get(nid, [])
            if dispatch:
                systemPrompt = systemPrompt.rstrip(_PHP_TRIM) + '\n\n' + DispatchRouting.promptBlock(dispatch)
            if nid in routedBy:
                systemPrompt = (systemPrompt.rstrip(_PHP_TRIM) + '\n\n'
                                + DispatchRouting.routedPrompt(self._displayName(node), routedBy[nid], ''))

            cfgSettings = cfg.get('settings') if isinstance(cfg.get('settings'), dict) else {}
            agentTemperature = php_floatval(_first(cfgSettings.get('temperature'), 0.7))
            # max_tokens comes from the agent form VERBATIM -- no substitution.
            agentMaxTokens = php_intval(_first(cfgSettings.get('max_tokens'), 4096))

            for tn in toolNames:
                allNeededTools[tn] = True
            routingMode = php_trim(php_strval(_first(routingSettings.get('routing_mode'), '')))
            fconf = _first(routingSettings.get('min_confidence'), routingSettings.get('jev_min_confidence'))
            thinking = cfgSettings.get('thinking')
            agentData[nid] = {
                'display': self._displayName(node),
                'system_prompt': systemPrompt,
                'tool_names': toolNames,
                'provider': agentProvider.lower(),
                'model': agentModel,
                'temperature': agentTemperature,
                'max_tokens': agentMaxTokens,
                'thinking': thinking if thinking in ('on', 'off') else None,
                'skills': skills,
                'dispatch': dispatch,
                'decision_question': (DispatchRouting.defaultInstructions(dispatcherName, dispatcherDesc, wfName)
                                      if dispatch else ''),
                'routing_mode': routingMode,
                'unclear_branch': php_trim(php_strval(_first(routingSettings.get('unclear_branch'), ''))),
                'min_confidence': (max(0.0, min(1.0, php_floatval(fconf))) if fconf is not None and is_numeric(fconf)
                                   else JevRouter.DEFAULT_CONFIDENCE_FLOOR),
                'decision': self._decisionCandidates(routingMode) if dispatch else [],
            }

        # Playbook nodes: bound against the registry at generation time.
        playbookData: dict = {}
        playbookServerUrls: dict = {}
        for nid in order:
            node = byId[nid]
            if self._nodeType(node) != 'playbook':
                continue
            ncfg = node.get('config') if isinstance(node.get('config'), dict) else {}
            pd = (PlaybookEmit.inputNodeData(node, providerDefaults, userId) if PlaybookSource.isFromInput(ncfg)
                  else self._playbookData(node, availableById, providerDefaults, userId))
            # Exits (["done", "failed"]): port output_k is exit k, wired like a code node's.
            exits = ncfg.get('exits')
            if isinstance(exits, dict):
                exits = list(exits.values())
            if isinstance(exits, list) and exits:
                pd['exits'] = [php_strval(x) for x in exits]
                pd['exit_targets'] = CodeNodeEmit.exitTargets(nid, pd['exits'], graph.get('edges') or [], list(byId.keys()))
            playbookData[nid] = pd
        # "From input" nodes run whichever published playbook the job names: bake every robot copy.
        publishedPlaybooks: dict = {}
        publishedSkipped: dict = {}
        if [pd for pd in playbookData.values() if (pd.get('source') or 'fixed') == 'input']:
            publishedPlaybooks, publishedSkipped = self._publishedPlaybooks(availableById, providerDefaults, userId)
        for pd in list(playbookData.values()) + list(publishedPlaybooks.values()):
            for a in pd['actions']:
                if (a.get('kind') or '') == 'mcp':
                    playbookServerUrls[a['server_url']] = True

        # Code nodes: validated settings, exit -> children, and the MCP servers of their declared tools.
        slugToUrl: dict = {}
        slugName: dict = {}
        for t in mcpTools:
            surl = php_strval(_first(t.get('server_url'), ''))
            if surl != '':
                slg = CodeNodeEmit.slug(php_strval(_first(t.get('server_name'), '')))
                slugToUrl[slg] = surl
                slugName[slg] = php_strval(_first(t.get('server_name'), ''))
        codeData: dict = {}
        codeServerUrls: dict = {}
        for nid in order:
            if self._nodeType(byId[nid]) != 'code':
                continue
            codeData[nid] = CodeNodeEmit.nodeData(byId[nid], graph.get('edges') or [], slugToUrl, list(byId.keys()))
            for surl in codeData[nid]['servers']:
                codeServerUrls[surl] = True
        codeSlugs: dict = {}
        for cd in codeData.values():
            for slg in cd['mcp_servers']:
                codeSlugs[slg] = slugToUrl[slg]

        # Catalog filtered to the tools agents use; MCP_SERVERS to the servers those (and playbooks, code) use.
        usedCatalog = {k: v for k, v in toolCatalog.items() if k in allNeededTools}
        usedServers: dict = {}
        for entry in usedCatalog.values():
            surl = entry.get('server_url') or ''
            if surl != '' and surl in serverRegistry:
                usedServers[surl] = dict(serverRegistry[surl])
        for surl in playbookServerUrls:
            if surl in serverRegistry:
                usedServers[surl] = dict(serverRegistry[surl])
        for surl in codeServerUrls:
            if surl in serverRegistry:
                usedServers[surl] = dict(serverRegistry[surl])
        # Two used servers on one URL would collapse into one connection: refuse.
        usedNamesByUrl: dict = {surl: {} for surl in usedServers}
        for cd in codeData.values():
            for slg in cd['mcp_servers']:
                usedNamesByUrl.setdefault(slugToUrl[slg], {})[slg] = slugName.get(slg, slg)
        for pd in list(playbookData.values()) + list(publishedPlaybooks.values()):
            for a in pd['actions']:
                if (a.get('kind') or '') == 'mcp':
                    slg = self._serverSlug(php_strval(a['target']).split('.', 1)[0])
                    usedNamesByUrl.setdefault(a['server_url'], {})[slg] = slugName.get(slg, slg)
        for entry in usedCatalog.values():
            surl = php_strval(_first(entry.get('server_url'), ''))
            if surl in usedServers:
                name = php_strval(_first(usedServers[surl].get('name'), ''))
                usedNamesByUrl.setdefault(surl, {})[CodeNodeEmit.slug(name)] = name
        for surl, names in usedNamesByUrl.items():
            if len(names) > 1:
                vals = list(names.values())
                raise RuntimeError('MCP servers "' + vals[0] + '" and "' + vals[1] + '" share the URL ' + surl
                                   + '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                                   + ' server instance on its own URL and register that.')
            if len(names) == 1 and surl in usedServers:
                usedServers[surl]['name'] = list(names.values())[0]
        # Header env names (MCP_HEADERS_<SLUG>) are per server name: two used servers must not share a slug.
        serverSlugs: dict = {}
        slugOwner: dict = {}
        for surl, meta in usedServers.items():
            slg = CodeNodeEmit.slug(php_strval(_first(meta.get('name'), '')))
            if slg in slugOwner and slugOwner[slg]['url'] != php_strval(surl):
                raise RuntimeError('MCP servers "' + slugOwner[slg]['name'] + '" and "' + php_strval(_first(meta.get('name'), ''))
                                   + '" both map to MCP_HEADERS_' + slg.upper() + '; rename one so each server has its own header variable.')
            slugOwner[slg] = {'url': php_strval(surl), 'name': php_strval(_first(meta.get('name'), ''))}
            serverSlugs[php_strval(surl)] = slg
        # Tools agents need that are not available as MCP (run_skill_script is local, so not missing).
        missing = _byte_sorted([tn for tn in allNeededTools if tn != 'run_skill_script' and tn not in toolCatalog])

        edgeList = [[self._edgeFrom(e), self._edgeTo(e)] for e in edges]
        orchestration = workflow.getOrchestration()
        # The Start option, if any: the hidden code node StartOptionGraph.expand added.
        triggerNodeId = None
        startTrigger = None
        startArgs: dict | list = []
        for nid in order:
            ncfg = byId[nid].get('config') if isinstance(byId[nid].get('config'), dict) else {}
            st = ncfg.get('start_trigger')
            if self._nodeType(byId[nid]) == 'code' and isinstance(st, dict):
                triggerNodeId = php_strval(nid)
                startTrigger = st
                a = ncfg.get('args')
                startArgs = a if isinstance(a, (dict, list)) else []
                break
        defaultCron = self._defaultCron(workflowId)
        startMode = 'watch' if startTrigger is not None else ('cron' if defaultCron is not None else 'prompt')
        if startTrigger is not None:
            w = startTrigger.get('watch')
            defaultWatch = self._watchFromTrigger(w if isinstance(w, dict) else {}, serverSlugs)
        else:
            defaultWatch = self._defaultWatch(workflowId, serverSlugs)
        if startTrigger is not None and defaultWatch is not None:
            p = _first(startTrigger.get('pass_args'), [])
            defaultWatch['args'] = StartTriggerFacts.watchArgs(defaultWatch['args'], startArgs, p if isinstance(p, list) else [])
        workExit = php_strval(_first(startTrigger.get('work_exit'), '')) if startTrigger is not None else None
        startOptionLabel = php_strval(_first(startTrigger.get('label'), 'Start option')) if startTrigger is not None else None
        return {
            'workflow': workflow, 'workflowId': workflowId, 'userId': userId, 'wfName': wfName, 'safeName': safeName,
            'gdata': gdata, 'byId': byId, 'order': order, 'edges': edges,
            'startPrompt': startPrompt, 'startDocuments': startDocuments, 'providerDefaults': providerDefaults,
            'serverRegistry': serverRegistry, 'toolCatalog': toolCatalog, 'availableById': availableById,
            'dispatchTargets': dispatchTargets, 'routedBy': routedBy, 'agentData': agentData, 'playbookData': playbookData,
            'publishedPlaybooks': publishedPlaybooks, 'publishedSkipped': publishedSkipped, 'codeData': codeData,
            'codeSlugs': codeSlugs, 'serverSlugs': serverSlugs, 'usedCatalog': usedCatalog, 'usedServers': usedServers,
            'missing': missing, 'edgeList': edgeList, 'orchestration': orchestration, 'defaultCron': defaultCron,
            'defaultWatch': defaultWatch, 'startMode': startMode, 'triggerNodeId': triggerNodeId, 'workExit': workExit,
            'startOptionLabel': startOptionLabel,
        }

    @staticmethod
    def _toolNames(rawTools) -> list:
        """Tool names from the editor's `tools` / `selectedTools` (strings or {name|tool_name}), `mcp_` prefix dropped."""
        if isinstance(rawTools, dict):
            rawTools = list(rawTools.values())
        if not isinstance(rawTools, list):
            return []
        out = []
        for tool in rawTools:
            tname = None
            if isinstance(tool, str):
                tname = tool
            elif isinstance(tool, dict):
                tname = _first(tool.get('name'), tool.get('tool_name'))
            if tname:
                tname = php_strval(tname)
                if tname.startswith('mcp_'):
                    tname = tname[4:]
                out.append(tname)
        return out

    def _defaultCron(self, workflowId: int) -> str | None:
        """The workflow's active cron schedule (newest scheduled_workflows row), baked as DEFAULT_CRON."""
        try:
            row = self.db.fetch_one("SELECT cron FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'cron' "
                                    "AND status <> 'paused' ORDER BY id DESC LIMIT 1", [workflowId])
        except Exception:  # noqa: BLE001 -- no schedules table, or one without the cron column
            return None
        c = row.get('cron') if row else None
        return c if isinstance(c, str) and c != '' else None

    def _defaultWatch(self, workflowId: int, serverSlugs: dict) -> dict | None:
        """The workflow's event trigger (newest non-paused 'event' row) as DEFAULT_WATCH, or None."""
        try:
            row = self.db.fetch_one("SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'event' "
                                    "AND status <> 'paused' ORDER BY id DESC LIMIT 1", [workflowId])
        except Exception:  # noqa: BLE001 -- no schedules table, or one without the event_trigger column
            return None
        raw = row.get('event_trigger') if row else None
        from app.agent_team.services.compiler_php import json_decode_assoc
        t = json_decode_assoc(raw) if isinstance(raw, str) else None
        if (not isinstance(t, dict) or php_trim(php_strval(_first(t.get('server'), ''))) == ''
                or php_trim(php_strval(_first(t.get('tool'), ''))) == ''):
            return None
        return self._watchFromTrigger(t, serverSlugs)

    @staticmethod
    def _watchFromTrigger(t: dict, serverSlugs: dict) -> dict | None:
        """{server, tool, args} (server = a name) as DEFAULT_WATCH, the server slugged; one the workflow does not use is an error."""
        if php_trim(php_strval(_first(t.get('server'), ''))) == '' or php_trim(php_strval(_first(t.get('tool'), ''))) == '':
            return None
        slug = CodeNodeEmit.slug(php_strval(t['server']))
        if slug not in serverSlugs.values():
            raise RuntimeError('The event trigger waits on MCP server "' + php_strval(t['server']) + '", which no node of this'
                               + ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).')
        args = t.get('args')
        return {'server': slug, 'tool': php_strval(t['tool']), 'args': args if isinstance(args, (dict, list)) else []}

    @staticmethod
    def _startModeLines(facts: dict) -> list:
        """START_MODE / WORK_EXIT / TRIGGER_NODE_ID."""
        def s(v):
            return 'None' if v is None or v == '' else py_str(v)
        return ['START_MODE = ' + py_str(facts['startMode']),
                'WORK_EXIT = ' + s(facts['workExit']),
                'TRIGGER_NODE_ID = ' + s(facts['triggerNodeId'])]

    @staticmethod
    def _defaultWatchLine(facts: dict) -> str:
        """DEFAULT_WATCH's line: the baked event trigger, or None."""
        w = facts.get('defaultWatch')
        if w is None:
            return 'DEFAULT_WATCH = None'
        return 'DEFAULT_WATCH = ' + json_to_python({'server': w['server'], 'tool': w['tool'], 'args': obj(w['args'])})

    @staticmethod
    def _watchDocLines(facts: dict, file: str) -> list:
        """TO RUN lines for --watch."""
        w = facts.get('defaultWatch')
        return [f'python {file} --watch           # run whenever the event trigger says something new arrived'
                + (f" ({w['server']}.{w['tool']})" if w is not None else ' (none saved: pass one)'),
                f'python {file} --watch \'outlook.wait_for_new {{"args": {{"folder": "Inbox"}}}}\'   # or any server.tool + JSON arguments',
                '# --watch: the tool answers {"status": "ready" | "timeout"}; on ready the workflow runs and drains as a --cron tick does']

    @staticmethod
    def _modeDocLines(file: str) -> list:
        """TO RUN lines for the default mode and --once."""
        return [f"python {file}                   # the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)",
                f'python {file} --once "text"     # one run on "text", even when the Start listens or is scheduled',
                f"python {file} --quiet | --verbose   # print only each run's done / failed line | also each node's output",
                "# runs/<date>_<run id>.jsonl: each real run's events (RUNS_DIR overrides); a quiet run (nothing to do) leaves none"]

    @staticmethod
    def _defaultCronLine(facts: dict) -> str:
        return 'DEFAULT_CRON = ' + ('None' if facts['defaultCron'] is None else py_str(facts['defaultCron']))

    @staticmethod
    def _cronDocLines(facts: dict, file: str) -> list:
        """TO RUN lines for --cron, naming the entry file."""
        cron = facts.get('defaultCron')
        return ([f'python {file} --cron            # loop on the Start node schedule'
                 + (f' ({cron})' if cron is not None else ' (none saved: pass an expression)'),
                 f'python {file} --cron "*/5 8-18 * * 1-5"   # or any 5-field cron, Ctrl-C (or SIGTERM) to stop',
                 f'python {file} "your prompt here" --cron   # a prompt goes BEFORE --cron (after it, it is read as the expression)']
                + (['# --cron with code nodes: a run that did work runs again at once (up to 20 per tick); work = a non-empty'
                    + ' final output, so a code -> agent chain needs an Output node to drain']
                   if facts.get('codeData') else []))

    @staticmethod
    def _slug(name: str) -> str:
        """Kebab-case ASCII slug for file names (max 40 chars)."""
        from app.agent_team.services.compiler_php import ascii_translit
        ascii_ = ascii_translit(name)
        for ch in ("'", '"', '`', '^', '~'):
            ascii_ = ascii_.replace(ch, '')
        s = re.sub(r'[^a-z0-9]+', '-', ascii_, flags=re.IGNORECASE).strip('-').lower()
        return (s if s != '' else 'node')[:40]

    @staticmethod
    def llmFactoryLines() -> list:
        """The `_make_llm(provider, model, temperature, max_tokens, thinking)` factory, one emitted line per entry.
        LangGraph emits LangGraphRuntime.llmFactoryBlock(); the playbook node needs this on every other target."""
        return list(LLM_FACTORY_LINES)

    # ---------- shared emit helpers ----------

    @staticmethod
    def _pythonListRepr(items: list) -> str:
        """['a', 'b', 'c'] the way Python's repr() writes a list of strings (always single quotes)."""
        parts = []
        for s in items:
            esc = php_strval(s).replace('\\', '\\\\').replace("'", "\\'")
            parts.append("'" + esc + "'")
        return '[' + ', '.join(parts) + ']'

    @staticmethod
    def _hasFromInput(playbookData: dict) -> bool:
        return bool([pd for pd in playbookData.values() if (pd.get('source') or 'fixed') == 'input'])

    def _publishedPlaybooks(self, availableById: dict, providerDefaults: dict, userId: str | None) -> tuple:
        """The robot's published playbooks, bound like a fixed playbook node and keyed by playbook key:
        (baked documents, {key: why it was left out}). No robot account: none."""
        robotId = RobotAccount.id(self.db)
        if robotId is None:
            return {}, {}
        baked: dict = {}
        skipped: dict = {}
        for row in PlaybookStore(self.db).robotList(robotId):
            key = php_strval(row['pkey'])
            try:
                d = PlaybookEmit.nodeData({'id': key, 'config': {'playbook': php_strval(row['text']), 'name': php_strval(row['title'])}},
                                          availableById, providerDefaults, userId)
            except RuntimeError as e:
                skipped[key] = str(e)
                error_log(f'[LangGraphGenerator] published playbook "{key}" not baked: {e}')
                continue
            baked[key] = {k: d[k] for k in d if k in ('title', 'domain', 'instructions', 'policy', 'approvers', 'actions')}
        return baked, skipped

    @staticmethod
    def _publishedPlaybooksLines(published: dict, skipped: dict) -> list:
        """`PUBLISHED_PLAYBOOKS = {key: {title, domain, instructions, policy, approvers, actions}}`."""
        L = ['# PUBLISHED PLAYBOOKS -- the robot\'s published copies, baked at compile time: a "from input"',
             "# playbook node runs the one its parent's JSON names (an unknown key takes the failed exit)."]
        for key, why in skipped.items():
            L.append('# WARNING: published playbook "' + key + '" not baked: '
                     + why.replace('\r\n', ' ').replace('\r', ' ').replace('\n', ' '))
        if not published:
            L.append('PUBLISHED_PLAYBOOKS = {}')
            return L
        L.append('PUBLISHED_PLAYBOOKS = {')
        for key, d in published.items():
            L.append('    ' + py_str(php_strval(key)) + ': {')
            L.append('        "title": ' + py_str(php_strval(d['title'])) + ',')
            L.append('        "domain": ' + py_str(php_strval(_first(d.get('domain'), ''))) + ',')
            L.append('        "instructions": ' + py_str(php_strval(d['instructions'])) + ',')
            L.append('        "policy": ' + json_to_python(d['policy'], True) + ',')
            L.append('        "approvers": ' + json_to_python(d['approvers'], True) + ',')
            L.append('        "actions": ' + json_to_python(d['actions'], False) + ',')
            L.append('    },')
        L.append('}')
        return L

    def _playbookData(self, node: dict, availableById: dict, providerDefaults: dict, userId: str | None) -> dict:
        """Bake one playbook node (PlaybookEmit.nodeData, shared with every other compile target)."""
        return PlaybookEmit.nodeData(node, availableById, providerDefaults, userId)

    @staticmethod
    def _dispatchMenuLiteral(targets: list) -> str:
        """A dispatcher's menu as a Python list literal: [{"id", "name", "description"}, ...]."""
        return '[' + ', '.join(
            '{"id": ' + py_str(php_strval(t['id'])) + ', "name": ' + py_str(php_strval(t['name']))
            + ', "description": ' + py_str(php_strval(_first(t.get('description'), ''))) + '}'
            for t in targets) + ']'

    @staticmethod
    def _decisionLiteral(candidates: list) -> str:
        """A dispatcher's decision candidates as a one-line Python list literal."""
        return '[' + ', '.join(
            '{' + ', '.join('"' + k + '": ' + py_str(php_strval(c[k])) for k in c) + '}'
            for c in candidates) + ']'

    @staticmethod
    def _pyFloor(ad: dict) -> str:
        """A dispatcher's decision-model floor as a Python float literal (0.6, 1.0, 0.85)."""
        return var_export_float(php_floatval(_first(ad.get('min_confidence'), JevRouter.DEFAULT_CONFIDENCE_FLOOR)))

    @staticmethod
    def _serverSlugsLine(slugs: dict) -> str:
        """MCP_SERVER_SLUGS: every MCP server URL this workflow (or this A2A node) uses -> its slug."""
        return 'MCP_SERVER_SLUGS = ' + json_to_python(slugs, True)

    @staticmethod
    def _mcpHeaderDocLines(facts: dict) -> list:
        """The .env lines a run needs for servers that take headers (values are never emitted)."""
        lines = []
        for slug in _unique(list((facts.get('serverSlugs') or {}).values())):
            if slug == '':
                continue
            lines.append('# MCP_HEADERS_' + slug.upper() + '={"Header": "value"}   # in .env, only if this MCP server needs headers'
                         + ' (a server you connected in the editor: the header and key saved on its MCP server row)')
            lines.append('# MCP_URL_' + slug.upper() + '=http://host:port/mcp   # in .env, only if this MCP server no longer answers at the URL compiled in')
        if lines:
            lines.append('# (one connection per MCP URL: for a second account, run a second MCP server instance on its own URL)')
        return lines

    def _decisionCandidates(self, mode: str) -> list:
        """The decision providers a dispatcher may route with: the named row, every usable row in admin order
        for an unset mode, none for 'llm' or a key with no usable row."""
        if mode == 'llm':
            return []
        out = []
        for row in DecisionProviders.rows(self.db):
            key = php_strval(row['provider_key'])
            protocol = DecisionProviders.protocolOf(row)
            if protocol is None or (mode != '' and key != mode):
                continue
            stem = DecisionProviders.envStem(key)
            out.append({
                'provider': key,
                'protocol': php_strval(row['protocol']),
                'url': _elvis(php_trim(php_strval(_first(row.get('base_url'), ''))), protocol['url']),
                'model': _elvis(php_trim(php_strval(_first(row.get('model'), ''))), protocol['model']),
                'key_env': stem + '_API_KEY',
                'url_env': stem + '_BASE_URL',
            })
        return out

    @staticmethod
    def _decisionProtocolsUsed(agentData: dict) -> list:
        """Protocols any dispatcher of this workflow may use (one adapter each)."""
        ids: dict = {}
        for ad in agentData.values():
            for c in ad.get('decision') or []:
                ids[c['protocol']] = True
        return list(ids.keys())

    @staticmethod
    def _decisionDocLines(agentData: dict) -> list:
        """TO RUN note for the decision-model env vars, per provider the dispatchers may use."""
        required: dict = {}
        optional: dict = {}
        for ad in agentData.values():
            if not ad.get('dispatch'):
                continue
            name = php_strval(_first(ad.get('display'), '')).replace('\r', ' ').replace('\n', ' ')
            mode = _first(ad.get('routing_mode'), '')
            for c in ad.get('decision') or []:
                (optional if mode == '' else required).setdefault(c['key_env'], []).append(name)
        lines = []
        for env, names in required.items():
            lines.append(f'# Required: {env} for dispatchers (' + ', '.join(_unique(names)) + ');')
            lines.append('#   without it (or when the decision model cannot decide) they do not route and the run stops there.')
        for env, names in optional.items():
            lines.append(f'# Optional: {env} for dispatchers with no routing mode saved (' + ', '.join(_unique(names)) + '):')
            lines.append('#   the first decision model whose key is set routes (else the model); once one is chosen, a request it cannot decide stops the run there (no model fallback).')
        if required or optional:
            lines.append('#   Each key has a matching <NAME>_BASE_URL (a gateway). TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.')
        return lines

    @staticmethod
    def _codeNodeDefinitionLines(nid: str, cd: dict, opener: str = 'NODE = {', indent: str = '') -> str:
        """A code node's frozen settings (the NODE literal of a module, or an entry of CODE_NODES)."""
        L = [indent + opener,
             indent + '    "id": ' + j(nid) + ',',
             indent + '    "kind": "code",',
             indent + '    "display": ' + j(cd['display']) + ',',
             indent + '    "exits": ' + j(cd['exits']) + ',',
             indent + '    "mcp_servers": ' + j(cd['mcp_servers']) + ',',
             indent + '    "timeout_s": ' + str(php_intval(cd['timeout_s'])) + ',',
             indent + '    "exit_targets": ' + j(obj(cd['exit_targets'])) + ',',
             indent + '    "args": ' + j(obj(_first(cd.get('args'), []))) + ",   # the code's ARGS"]
        # The modular package reads the code from its file at each run; the single file embeds it.
        L.append(indent + '    "source_file": ' + j(cd['source_file']) + ',   # relative to the package folder'
                 if 'source_file' in cd else indent + '    "source": ' + j(cd['source']) + ',')
        L.append(indent + '}' + (',' if indent != '' else ''))
        return '\n'.join(L)

    def _nodeDefinitionLines(self, facts: dict, nid: str, kind: str, display: str, d: dict, isPlaybook: bool,
                             opener: str = 'NODE = {', indent: str = '') -> str:
        """The `NODE = {...}` literal shared by the A2A agent files and the modular agent modules (and, with
        opener `"<id>": {` and four spaces, the single file's AGENTS / PLAYBOOKS entries)."""
        def verbatim(text: str) -> list:
            # Text inside a triple-quoted string is emitted as is: indenting it would change the prompt.
            return text.replace('\\', '\\\\').replace('"""', '\\"\\"\\"').split('\n')

        thinking = d.get('thinking')
        L = [indent + opener,
             indent + '    "id": ' + j(nid) + ',',
             indent + '    "kind": ' + j(kind) + ',',
             indent + '    "display": ' + j(display) + ',',
             indent + '    "provider": ' + j(d['provider']) + ',',
             indent + '    "model": ' + j(d['model']) + ',',
             indent + '    "temperature": ' + j(php_floatval(d['temperature'])) + ',',
             indent + '    "max_tokens": ' + str(php_intval(d['max_tokens'])) + ',',
             indent + '    "thinking": ' + ('"' + thinking + '"' if thinking in ('on', 'off') else 'None')
             + ',  # node form Thinking attribute']
        if isPlaybook:
            L.append(indent + '    "title": ' + j(d['title']) + ',')
            L.append(indent + '    "domain": ' + j(d['domain']) + ',')
            L.append(indent + '    "writes_enabled": ' + ('True' if d['writes_enabled'] else 'False') + ',')
            L.append(indent + '    "policy": ' + json_to_python(d['policy'], True) + ',')
            L.append(indent + '    "approvers": ' + json_to_python(d['approvers'], True) + ',')
            L.append(indent + '    "requester": ' + json_to_python(d['requester'], True) + ',')
            L.append(indent + '    "instructions": """')
            L += verbatim(d['instructions'])
            L.append('""",')
            L.append(indent + '    "actions": ' + json_to_python(d['actions'], False) + ',')
            if d.get('exits'):
                # done / failed: the exit the run took picks the children (WorkflowGraph._code_router).
                L.append(indent + '    "exits": ' + j(d['exits']) + ',')
                L.append(indent + '    "exit_targets": ' + j(obj(d['exit_targets'])) + ',')
            if (d.get('source') or 'fixed') == 'input':
                # The parent's JSON names the playbook (its input_field); it runs from the robot's published copies.
                L.append(indent + '    "source": "input",')
                L.append(indent + '    "input_field": ' + j(d['input_field']) + ',')
                L.append(indent + '    "published": PUBLISHED_PLAYBOOKS,')
        else:
            L.append(indent + '    "system_prompt": """')
            L += verbatim(d['system_prompt'])
            L.append('""",')
            L.append(indent + '    "tool_names": ' + j(list(d['tool_names'])) + ',')
            # Ordered skill bindings ([{"dir": "..."}] / [{"inline": "..."}]): mandatory post-agent steps.
            L.append(indent + '    "skills": ' + j(_first(d.get('skills'), [])) + ',')
            # Dispatcher menu: the node calls route_to over these names and only the chosen child runs.
            L.append(indent + '    "dispatch": ' + self._dispatchMenuLiteral(_first(d.get('dispatch'), [])) + ',')
            L.append(indent + '    "decision_question": ' + py_str(php_strval(_first(d.get('decision_question'), ''))) + ',')
            L.append(indent + '    "routing_mode": ' + py_str(php_strval(_first(d.get('routing_mode'), ''))) + ',')
            L.append(indent + '    "unclear_branch": ' + py_str(php_strval(_first(d.get('unclear_branch'), ''))) + ',')
            L.append(indent + '    "min_confidence": ' + self._pyFloor(d) + ',')
            L.append(indent + '    "decision": ' + self._decisionLiteral(_first(d.get('decision'), [])) + ',')
        # An entry inside a dict literal (the single file's AGENTS / PLAYBOOKS) ends with a comma.
        L.append(indent + '}' + (',' if indent != '' else ''))
        return '\n'.join(L)

    # ---------- static Python code blocks (PHP nowdocs, compiler_text.lang_graph_generator) ----------

    @staticmethod
    def _dataFlowDoc() -> str:
        return T.dataFlowDoc__ret

    @staticmethod
    def _stateBlock() -> str:
        return T.stateBlock__ret

    @staticmethod
    def _datetimeInjectorBlock() -> str:
        return T.datetimeInjectorBlock__ret

    @staticmethod
    def contextBuilderBlock() -> str:
        return T.contextBuilderBlock__ret

    @staticmethod
    def _singleRunBlock(missingWarning: str) -> str:
        """The single file's run() (its nodes live in this process) and the __main__ block."""
        return T.singleRunBlock__ret + missingWarning + T.singleRunBlock__ret_2

