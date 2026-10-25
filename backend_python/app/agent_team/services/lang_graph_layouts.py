"""The multi-file layouts of the LangGraph compiler (port of the A2A, modular and swarm halves of
backend/src/AgentTeam/Services/LangGraphGenerator.php).

LangGraphLayouts is LangGraphGenerator's base class: the methods here use the shared helpers the
generator defines (_nodeDefinitionLines, _mcpHeaderDocLines, ...), reached through self / cls.

- A2A: orchestrator.py, api.py and one self-contained A2A agent server per agent/playbook node.
- Modular ("agents in separate files"): workflow.py owns the graph, common.py the shared runtime and
  agents/<name>.py one node each; they link by `import` and run in ONE process.
- Swarm: the modular layout with workflow.py built from create_swarm() over SwarmRewriter's rewrite.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiler_php import j, json_to_python, obj, py_str, sprintf_pad
from app.agent_team.services.compiler_text import lang_graph_generator as T
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.swarm_rewriter import SwarmRewriter
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.phpcompat import php_date, php_floatval, php_intval, php_strval

_PHP_TRIM = ' \t\n\r\x00\x0b'
SEP = '# ' + '=' * 62


def _esc(s: str) -> str:
    """A module docstring body: backslashes doubled, then any \"\"\" spelled '''."""
    return s.replace('\\', '\\\\').replace('"""', "'''")


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


def _generated() -> str:
    return '  Generated:  ' + php_date('Y-m-d H:i:s T') + ' by the SynergyAI workflow editor'


class LangGraphLayouts:
    # ==============================================================
    # A2A MODE -- one agent server per node, an orchestrator driving them
    # ==============================================================

    @staticmethod
    def _a2aVersion(facts: dict) -> str:
        """The WORKFLOW_VERSION literal baked into the orchestrator and every agent file."""
        return str(facts['workflowId']) + '-' + php_date('Ymd')

    @classmethod
    def a2aLayout(cls, facts: dict) -> dict:
        """File names, ports and kinds of the A2A agents, in ORDER: one per agent/playbook node."""
        agents: dict = {}
        i = 0
        for nid in facts['order']:
            if nid in facts['agentData']:
                ad = facts['agentData'][nid]
                kind = 'dispatcher' if ad.get('dispatch') else 'agent'
                display = ad['display']
            elif nid in facts['playbookData']:
                kind = 'playbook'
                display = facts['playbookData'][nid]['display']
            else:
                continue
            agents[nid] = {'file': f'agents/{nid}_' + cls._slug(display) + '.py', 'slug': cls._slug(display),
                           'port': 8701 + i, 'display': display, 'kind': kind}
            i += 1
        return {'root': facts['safeName'] + '_a2a', 'agents': agents}

    def _generateA2A(self, facts: dict) -> dict:
        """orchestrator.py, api.py, then one agent file per agent/playbook node."""
        layout = self.a2aLayout(facts)
        files = [
            {'path': 'orchestrator.py', 'code': self._emitA2AOrchestrator(facts, layout)},
            {'path': 'api.py', 'code': self._emitA2AApi(facts, layout)},
        ]
        for nid, e in layout['agents'].items():
            files.append({'path': e['file'], 'code': self._emitA2AAgentFile(facts, layout, nid)})
        return self._withArchitecture({'root': layout['root'], 'files': files}, facts, 'a2a')

    def _emitA2AOrchestrator(self, facts: dict, layout: dict) -> str:
        """orchestrator.py: the graph, the agent endpoint table, the supervisor and the A2A node runner."""
        sep = SEP
        nodes = self._a2aDocNodes(facts, layout)
        docById = {dn['id']: dn for dn in nodes}
        endpoints = []
        for nid, e in layout['agents'].items():
            endpoints.append('  ' + sprintf_pad(nid, 6) + ' ' + sprintf_pad(e['display'], 24) + ' ' + sprintf_pad(e['file'], 32)
                             + f" http://127.0.0.1:{e['port']}/   (env A2A_AGENT_{nid}_URL)")
        workflow = facts['workflow']
        body = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph A2A orchestrator (Python) -- StateGraph over A2A tasks, one agent process per node',
            'dispatch_supported': True,
            'workflow': {'id': facts['workflowId'], 'name': facts['wfName']},
            'nodes': nodes, 'edges': facts['edgeList'], 'layers': facts['gdata'].get('layers') or [],
            'data_flow': self._a2aOrchestratorDataFlowDoc(),
            'run': {'deps': ['pip install "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx python-dotenv'],
                    'usage': 'python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]',
                    'extra': (['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.']
                              + self._decisionDocLines(facts.get('agentData') or {}) + self._mcpHeaderDocLines(facts)
                              + self._cronDocLines(facts, 'orchestrator.py')),
                    # This file lives at <root>/orchestrator.py; python/.env is two levels up from <root>/.
                    'env_path': '../../.env'},
            'storage': {'enabled': workflow.isOutputStorageEnabled(), 'folder': workflow.getOutputFolder()},
        })
        body += ('\n\nAGENT ENDPOINTS  (id, name, file, default URL; env override)\n===============\n' + '\n'.join(endpoints)
                 + '\n\nA2A RUN\n=======\n'
                 + '  1. AgentSupervisor starts every local agent (python <file> --port N) and waits for its card.\n'
                 + '  2. Each agent node = one A2A task: the framed input goes in as text, status updates are\n'
                 + '     relayed as [<agent>] lines, an input-required status is a GATE (answered on the console,\n'
                 + "     or by PLAYBOOK_GATE_MODE when no terminal), the 'result' artifact is the node output\n"
                 + "     (+ data {route, notes, status}; a dispatcher's route drives the conditional edge).\n"
                 + '  3. Start and Output run locally; the Output merges parent outputs verbatim.\n'
                 + '  4. Agents are stopped at the end unless --keep-serving; --no-spawn expects them reachable.')

        L = ['"""A2A orchestrator for workflow ' + j(facts['wfName']), '']
        L += _esc(body).split('\n')
        L += ['"""', 'from __future__ import annotations', '',
              'import argparse, asyncio, json, os, re, signal, subprocess, sys, threading, time, uuid',
              'from datetime import datetime, timedelta',
              'from pathlib import Path',
              'from typing import Annotated, Awaitable, Callable, TypedDict',
              '',
              'from dotenv import load_dotenv',
              '# This file lives in <root>/; the runner .env is two levels up (python/.env).',
              '_HERE = os.path.dirname(os.path.abspath(__file__))',
              'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))',
              "PACKAGE_DIR = _HERE   # this program's folder: a relative Start document path resolves here",
              '',
              'import httpx',
              'from langgraph.graph import END, START, StateGraph',
              'from a2a import types as T',
              'from a2a.client import create_client, ClientConfig',
              'from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts',
              '']
        ofolder = workflow.getOutputFolder()
        L.append('WORKFLOW_ID = ' + str(php_intval(facts['workflowId'])))
        L.append('WORKFLOW_NAME = ' + py_str(facts['wfName']))
        # Same literal every agent file bakes -- the supervisor rejects a port serving a DIFFERENT version.
        L.append('WORKFLOW_VERSION = ' + py_str(self._a2aVersion(facts)))
        L.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if workflow.isOutputStorageEnabled() else 'False'))
        L.append('OUTPUT_FOLDER = ' + (py_str(php_strval(ofolder)) if (ofolder or '') != '' else 'None'))
        L.append('DEFAULT_PROMPT = ' + py_str(facts['startPrompt']))
        L.append(self._defaultCronLine(facts))
        L.append('START_DOCUMENTS = ' + json_to_python(facts['startDocuments'] or []))
        L.append('A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "8701"))   # agent i listens on A2A_BASE_PORT + i')
        L.append('')
        L += [sep, '# AGENTS -- the endpoint table (one A2A server per agent/playbook node)', sep]
        L.append('AGENTS = {')
        i = 0
        for nid, e in layout['agents'].items():
            L += PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ').split('\n')
            dispatch = ([{'id': php_strval(t['id']), 'name': t['name']} for t in facts['agentData'][nid]['dispatch']]
                        if e['kind'] == 'dispatcher' else [])
            L.append('    ' + j(php_strval(nid)) + ': {"display": ' + j(e['display']) + ', "file": ' + j(e['file'])
                     + ', "kind": ' + j(e['kind']) + ', "port": ' + str(e['port']) + ', "index": ' + str(i)
                     + ', "dispatch": ' + j(dispatch) + '},')
            i += 1
        L.append('}')
        L.append('')
        L += [sep, '# GRAPH STRUCTURE (same shape as the single-file script)', sep]
        L.append('EDGES = ' + json_to_python(facts['edgeList']))
        L.append('ORDER = ' + json_to_python(facts['order']))
        typeMap: dict = {}
        for nid in facts['order']:
            typeMap[nid] = (('playbook' if layout['agents'][nid]['kind'] == 'playbook' else 'agent')
                            if nid in layout['agents'] else self._nodeType(facts['byId'][nid]))
        L.append('NODE_TYPES = ' + json_to_python(typeMap, True))
        L += ['', '', self._stateBlock(), '', self._datetimeInjectorBlock(), '', self.contextBuilderBlock(), '',
              LangGraphRuntime.documentConverterBlock()]
        # orchestrator.py carries no common.py, so the event sink + gate rendezvous is emitted here.
        L += [sep, '# EVENT SINK -- how api.py observes a run (inert for CLI runs)', sep]
        L.append(LangGraphRuntime.runEventsBlock())
        L.append(LangGraphRuntime.runRecordBlock())
        L.append(LangGraphRuntime.consoleBlock())
        L.append(LangGraphRuntime.workflowGraphBlock())
        L.append(LangGraphRuntime.outputBlock())
        L.append(LangGraphRuntime.cronBlock())
        L.append(self._a2aOrchestratorBlock())
        return '\n'.join(L) + '\n'

    @staticmethod
    def _a2aOrchestratorDataFlowDoc() -> str:
        return T.a2aOrchestratorDataFlowDoc__ret

    def _emitA2AApi(self, facts: dict, layout: dict) -> str:
        """api.py for the A2A folder: the modular package's run contract plus the agent supervisor's lifecycle."""
        L = ['"""Run server for workflow ' + j(facts['wfName']) + ' (A2A)', '']
        body = self._apiPyDocBody(facts,
                                  'LangGraph A2A run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
                                  'pip install fastapi uvicorn "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx pydantic python-dotenv',
                                  ['# The agent servers start with the first run (see _ensure_agents) and stop with this process.',
                                   '# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
                                   '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
                                   '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)'])
        L += _esc(body).split('\n')
        L += ['"""', 'from __future__ import annotations', '',
              'import argparse, asyncio, atexit, json, os, sys, time, uuid', '',
              'from fastapi import FastAPI, HTTPException, Request',
              'from fastapi.middleware.cors import CORSMiddleware',
              'from fastapi.responses import StreamingResponse',
              'import uvicorn', '',
              'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
              'from orchestrator import set_event_sink, resolve_gate', '']
        L.append('WORKFLOW_VERSION = ' + py_str(self._a2aVersion(facts)))
        L += ['',
              '# The agent servers start with the first run and stop with this process.',
              '_SUPERVISOR = None', '', '',
              'def _ensure_agents() -> None:',
              '    """Start the A2A agent servers once, on the first run.',
              '',
              '    AgentSupervisor.start() is BLOCKING -- it spawns one subprocess per',
              "    agent and polls each one's Agent Card for up to 60s. _drive() (see",
              '    modularApiBlock below) calls this hook through asyncio.to_thread so',
              '    the event loop stays free to serve /runs/<id>/events while the agents',
              '    are still coming up, instead of stalling every request for that long.',
              '    """',
              '    global _SUPERVISOR',
              '    if _SUPERVISOR is None:',
              '        _SUPERVISOR = AgentSupervisor(spawn=True)',
              '        # Registered BEFORE start() so a fleet that half-came-up is still',
              '        # torn down. Nothing else stops these processes: the orchestrator',
              '        # CLI does it in a finally, and this server has no such scope.',
              '        atexit.register(_stop_agents)',
              '        _SUPERVISOR.start()', '', '',
              'def _stop_agents() -> None:',
              '    """Shutdown hook: stop the agent fleet this process spawned.',
              '',
              '    Without it, a SIGTERM to this server leaves N agent processes',
              '    running and holding ports 8701+, and the next start fails with',
              '    "port may already be in use". Idempotent (the supervisor is cleared',
              '    first, so a second call finds nothing) and non-raising -- a hook that',
              '    throws on the way out only hides the real exit.',
              '    """',
              '    global _SUPERVISOR',
              '    sup, _SUPERVISOR = _SUPERVISOR, None',
              '    if sup is None:',
              '        return',
              '    try:',
              '        sup.stop()',
              '    except Exception as exc:   # noqa: BLE001 -- best effort on the way out',
              '        print(f"[supervisor] stop failed: {exc}", flush=True)',
              '']
        L.append(RunServerEmitter.runtimeBlock())
        return '\n'.join(L).rstrip('\n') + '\n'

    @classmethod
    def _a2aOrchestratorBlock(cls) -> str:
        """Supervisor, remote node runner, gate handler, graph wiring, CLI entry."""
        return cls.a2aRemoteBlock() + '\n' + T.a2aOrchestratorBlock__ret

    @staticmethod
    def a2aRemoteBlock() -> str:
        """The orchestrator's framework-free part: the agent supervisor, the gate handler and the remote node
        runner (one A2A task per node). ADK, MAF and NOOA orchestrators copy it (CompiledA2AEmit)."""
        return T.a2aRemoteBlock__ret

    def _emitA2AAgentFile(self, facts: dict, layout: dict, nid: str) -> str:
        """One self-contained A2A agent server for node nid (same runtime blocks as the single file, plus the
        A2A server block)."""
        entry = layout['agents'][nid]
        kind = entry['kind']
        isPlaybook = kind == 'playbook'
        d = facts['playbookData'][nid] if isPlaybook else facts['agentData'][nid]
        wfName = facts['wfName']
        sep = SEP

        # Tool catalog restricted to this node.
        catalog: dict = {}
        if not isPlaybook:
            for tn in d['tool_names']:
                if tn in facts['usedCatalog']:
                    catalog[tn] = facts['usedCatalog'][tn]
        servers: dict = {}
        for c in catalog.values():
            if c['server_url'] in facts['serverRegistry']:
                servers[c['server_url']] = facts['serverRegistry'][c['server_url']]
        if isPlaybook:
            for a in d['actions']:
                if (a.get('kind') or '') == 'mcp' and a['server_url'] in facts['serverRegistry']:
                    servers[a['server_url']] = facts['serverRegistry'][a['server_url']]

        L = ['"""A2A agent ' + j(entry['display']) + f' -- node {nid} of workflow ' + j(wfName), '']
        L += _esc(self._a2aDocBody(facts, layout, nid)).split('\n')
        L += ['"""', 'from __future__ import annotations', '']
        L.append('import argparse, asyncio, json, os, ' + ('re, ' if isPlaybook else '') + 'subprocess, sys, threading, time'
                 + (', uuid' if isPlaybook else ''))
        L += ['from abc import ABC, abstractmethod',
              'from dataclasses import asdict, dataclass, field',
              'from enum import Enum',
              'from functools import cached_property',
              'from pathlib import Path',
              'from typing import Callable, Literal',
              '',
              'from dotenv import load_dotenv',
              '# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).',
              '_HERE = os.path.dirname(os.path.abspath(__file__))',
              'load_dotenv(os.path.join(os.path.dirname(_HERE), ".env"))   # the workflow folder\'s own .env first (never overridden)',
              'RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))   # the runner env folder (python/)',
              'load_dotenv(os.path.join(RUNNER_DIR, ".env"))',
              "DEBUG_STEM = os.path.basename(os.path.dirname(_HERE))   # the package folder names this node's outputs/_debug dumps",
              '',
              'import httpx',
              'import uvicorn',
              'from starlette.applications import Starlette',
              'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage',
              'from langchain_core.tools import StructuredTool',
              'try:',
              '    from langchain.agents import create_agent as create_react_agent',
              'except ImportError:',
              '    from langgraph.prebuilt import create_react_agent',
              'from pydantic import Field, create_model',
              'from a2a import types as T',
              'from a2a.server.agent_execution import AgentExecutor, RequestContext',
              'from a2a.server.events import EventQueue',
              'from a2a.server.request_handlers import DefaultRequestHandler',
              'from a2a.server.tasks import InMemoryTaskStore, TaskUpdater',
              'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
              'from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts',
              '',
              "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()",
              '',
              '# This file is SELF-CONTAINED on purpose: the LLM factory, MCP client, tool',
              '# builder, skill and playbook blocks below are the same code the single-file',
              '# script carries, duplicated here so this agent can be copied to another host',
              '# alone.']
        L += [sep, '# LLM FACTORY', '# Provider/model -> LangChain chat model (same rules as the single-file script).', sep]
        L.append(LangGraphRuntime.llmFactoryBlock())
        L.append('')
        L += [sep, '# MCP SERVER REGISTRY + TOOL CATALOG (this node only)', sep]
        L.append('MCP_SERVERS = ' + json_to_python(servers, True))
        L.append('TOOL_CATALOG = ' + json_to_python(catalog, True))
        L.append('')
        L += [sep, '# MCP CLIENT -- JSON-RPC 2.0 over HTTP', sep]
        slugs = facts.get('serverSlugs') or {}
        L.append(self._serverSlugsLine({k: v for k, v in slugs.items() if k in servers}))
        L.append('')
        L.append(LangGraphRuntime.mcpClientBlock())
        L += [sep, '# TOOL BUILDER + SKILL RUNTIME', sep]
        L.append(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock())
        L.append(LangGraphRuntime.runEventsBlock())
        L.append(LangGraphRuntime.dispatcherBlock(self._decisionProtocolsUsed(facts.get('agentData') or {})))
        L.append(self._datetimeInjectorBlock())
        if isPlaybook:
            L.append(LangGraphRuntime.runContextBlock())
            L.append(LangGraphRuntime.playbookBlock())
        L.append(LangGraphRuntime.nodeClassesBlock(isPlaybook))
        L.append('')
        # ---- node definition ----
        L += [sep, '# NODE DEFINITION -- frozen from the workflow editor', sep]
        for dn in self._a2aDocNodes(facts, layout):
            if dn['id'] == nid:
                L += PythonEmitHelpers.nodeCommentBlock(dn).split('\n')
        L += self._nodeDefinitionLines(facts, nid, kind, entry['display'], d, isPlaybook).split('\n')
        L += ['', '# The executor below runs this node through run_node(request_text, trace).',
              'run_node = make_node(NODE).run', '', '']
        L.append(self.a2aAgentServerBlock())
        L.append('WORKFLOW_NAME = ' + py_str(wfName))
        L.append('WORKFLOW_VERSION = ' + py_str(self._a2aVersion(facts)))
        L.append('# Default card (port from A2A_PORT or the layout); main() rebuilds it for the real host/port.')
        L.append('AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get(\'A2A_PORT\', \'' + str(entry['port']) + '\')}/")')
        L += ['', 'if __name__ == "__main__":', '    main()']
        return '\n'.join(L) + '\n'

    def _a2aDocNodes(self, facts: dict, layout: dict) -> list:
        """docNodes descriptors for the A2A layout: every node, with the agent file recorded under 'file'."""
        docAgents: dict = {}
        docExtra: dict = {}
        for n, ad in facts['agentData'].items():
            docAgents[n] = {'name': ad['display'], 'provider': ad['provider'], 'model': ad['model'], 'temperature': ad['temperature'],
                            'max_tokens': ad['max_tokens'], 'thinking': ad['thinking'], 'tools': ad['tool_names'], 'skills': ad['skills']}
            if ad.get('dispatch'):
                docExtra.setdefault(n, {})['dispatch'] = [t['name'] for t in ad['dispatch']]
        for n, pd in facts['playbookData'].items():
            mcp = len([a for a in pd['actions'] if (a.get('kind') or '') == 'mcp'])
            docExtra.setdefault(n, {})['playbook'] = {'title': pd['title'], 'writes': pd['writes_enabled'], 'bound': mcp,
                                                      'unbound': len(pd['actions']) - mcp}
            docAgents[n] = {'name': pd['display'], 'provider': pd['provider'], 'model': pd['model'], 'temperature': pd['temperature'],
                            'max_tokens': pd['max_tokens'], 'thinking': pd['thinking'], 'tools': [], 'skills': []}
        for n, cd in facts['codeData'].items():
            docAgents[n] = {'name': cd['display'], 'provider': '', 'model': '', 'temperature': None,
                            'max_tokens': None, 'thinking': None, 'tools': [f'{slg}.*' for slg in cd['mcp_servers']], 'skills': []}
        nodes = WorkflowGraphAnalyzer.docNodes(facts['byId'], facts['order'], facts['edges'], docAgents, docExtra,
                                               ['start', 'agent', 'agent-template', 'playbook', 'code', 'output'])
        for n in nodes:
            n['file'] = (layout['agents'].get(n['id']) or {}).get('file', '')
        return nodes

    def _a2aDocBody(self, facts: dict, layout: dict, nid: str) -> str:
        """Module-docstring body of an agent file: standard sections + NODE + A2A SERVING + TO RUN."""
        nodes = self._a2aDocNodes(facts, layout)
        # 'marker' (not 'name') so the "<== this agent" tag appears only on the GRAPH NODES line.
        for n in nodes:
            if n['id'] == nid:
                n['marker'] = '<== this agent'
        entry = layout['agents'][nid]
        body = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph A2A agent (Python) -- one A2A server for this node; the orchestrator drives the graph',
            'dispatch_supported': True,
            'workflow': {'id': facts['workflowId'], 'name': facts['wfName']},
            'nodes': nodes, 'edges': facts['edgeList'], 'layers': facts['gdata'].get('layers') or [],
            'data_flow': self._a2aAgentDataFlowDoc(),
            'run': {'deps': ['pip install "a2a-sdk[http-server]>=1.1,<2" langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv uvicorn'],
                    'usage': 'python ' + entry['file'] + ' --port ' + str(entry['port']) + '   # from the workflow folder; A2A_HOST/A2A_PORT also honoured',
                    'extra': (['# Card: http://127.0.0.1:' + str(entry['port']) + '/.well-known/agent-card.json  --  JSON-RPC at /']
                              + self._decisionDocLines(facts.get('agentData') or {}) + self._mcpHeaderDocLines(facts)),
                    # This file lives 3 levels under the workflow root (agents/<file>.py).
                    'env_path': '../../../.env'},
            'storage': {'enabled': False, 'folder': None},
        })
        return (body + '\n\nA2A SERVING\n===========\n'
                + f'  Skill id:   node-{nid}\n'
                + '  Task in:    one text part = the node input the orchestrator built (original prompt + parent outputs)\n'
                + "  Task out:   artifact 'result' = text part (node output) + data part {route, notes, status}\n"
                + '  Gates:      the task moves to input-required with data {gate, tool, args}; the orchestrator answers on\n'
                + '              the same task with data {decision, comment, fields}; the run resumes in memory.\n'
                + '              After A2A_GATE_TIMEOUT_S (default 900 s) with no answer the node run continues with\n'
                + '              timeout guidance, but its final artifact can no longer be delivered -- no A2A request\n'
                + '              is in flight to carry it, so the task stays stuck in input-required. Re-sending on the\n'
                + '              same task id to pick the result back up is not supported yet.\n'
                + '  One task at a time: runs are serialised with a lock; a second task waits for the first.')

    @staticmethod
    def _a2aAgentDataFlowDoc() -> str:
        return T.a2aAgentDataFlowDoc__ret

    @staticmethod
    def a2aAgentServerBlock() -> str:
        """Agent Card, executor with pause/resume legs, gate bridge, CLI entry."""
        return T.a2aAgentServerBlock__ret

    # ==============================================================
    # MODULAR MODE -- "agents in separate files"
    # ==============================================================

    @classmethod
    def modularLayout(cls, facts: dict) -> dict:
        """Module names, files and kinds of the modular agents, in ORDER: one per agent/playbook/code node.
        The base name must be a valid Python identifier: a display name that slugs to one starting with a
        digit, or collides with a name already taken, falls back to "node_<id>_<slug>"."""
        # Reserved: the package's own modules, so `import common` can never resolve to an agent module.
        used = {'common': True, 'workflow': True, 'agents': True}
        agents: dict = {}
        for nid in facts['order']:
            if nid in facts['agentData']:
                ad = facts['agentData'][nid]
                kind = 'dispatcher' if ad.get('dispatch') else 'agent'
                display = ad['display']
            elif nid in facts['playbookData']:
                kind = 'playbook'
                display = facts['playbookData'][nid]['display']
            elif nid in facts['codeData']:
                kind = 'code'
                display = facts['codeData'][nid]['display']
            else:
                continue
            name = cls._slug(display).replace('-', '_')
            if not re.match(r'^[a-z_][a-z0-9_]*$', name) or name in used:
                name = f'node_{nid}_{name}'
            used[name] = True
            agents[nid] = {'file': f'agents/{name}.py', 'module': f'agents.{name}', 'name': name,
                           'display': display, 'kind': kind}
        return {'root': facts['safeName'] + '_modular', 'agents': agents}

    def _generateSwarm(self, facts: dict) -> dict:
        """Swarm mode: the modular layout with workflow.py built from create_swarm() over SwarmRewriter.rewrite()."""
        nodes = []
        nodeNames: dict = {}
        for nid, node in facts['byId'].items():
            i = php_strval(nid)
            nodes.append({'id': i, 'node_type': self._nodeType(node),
                          'config': node['config'] if isinstance(node.get('config'), dict) else {}})
            nodeNames[i] = self._displayName(node)
        edges = [{'from': php_strval(e.get('from') or ''), 'to': php_strval(e.get('to') or '')} for e in facts['edges']]
        rw = SwarmRewriter.rewrite({'nodes': nodes, 'edges': edges})
        if not rw['ok']:
            names = ', '.join(nodeNames.get(php_strval(i), f'node {i}') for i in rw['nodes'])
            raise RuntimeError(self._swarmRefusalMessage(rw['error']) + (f' ({names})' if names != '' else ''))
        facts = dict(facts)
        facts['swarm'] = rw
        layout = self.modularLayout(facts)
        # The package files of the modular path; a swarm reads no Start documents, so none are copied.
        package = LangGraphPackage.files(_with_first(facts, 'startDocuments', []), self.skillsRoot)
        files = [
            {'path': 'workflow.py', 'code': self._emitSwarmWorkflow(facts, layout)},
            # common.py and api.py are the EXISTING modular emitters, called (not copied).
            {'path': 'common.py', 'code': self._emitModularCommon(facts, layout, True)},
            {'path': 'api.py', 'code': self._emitModularApi(facts, layout, False)},
            # A REGULAR package, not a namespace portion: an installed top-level `agents` would win otherwise.
            {'path': 'agents/__init__.py', 'code': '"""Agent modules of workflow ' + j(facts['wfName']) + ' (swarm)."""' + '\n'},
        ]
        for i in rw['agents']:
            entry = layout['agents'].get(i)
            if entry is None:
                continue
            files.append({'path': entry['file'], 'code': self._emitSwarmAgentFile(facts, layout, php_strval(i))})
        files += package
        return {'root': layout['root'] + '_swarm', 'files': files}

    def _emitSwarmAgentFile(self, facts: dict, layout: dict, nid: str) -> str:
        """agents/<name>.py, swarm mode: ONE member -- NODE, INSTRUCTIONS, HANDOFFS and build_agent()."""
        rw = facts['swarm']
        entry = layout['agents'][nid]
        member = rw['agents'][nid]
        d = facts['agentData'][nid]
        sep = SEP
        L = ['"""Swarm member ' + j(entry['display']) + f' -- node {nid} of workflow ' + j(facts['wfName']), '']
        L += _esc(self._swarmAgentDocBody(facts, nid)).split('\n')
        L += ['"""', 'from __future__ import annotations', '',
              'from langgraph_swarm import create_handoff_tool',
              'try:',
              '    from langchain.agents import create_agent as create_react_agent',
              '    _PROMPT_KW = "system_prompt"   # langchain >= 1.x renamed prompt=',
              'except ImportError:',
              '    from langgraph.prebuilt import create_react_agent',
              '    _PROMPT_KW = "prompt"',
              '',
              '# The shared runtime lives in common.py, one directory up. Python puts the',
              '# workflow folder on sys.path when workflow.py starts, so this resolves for',
              '# every module of the package.',
              'from common import _make_llm, TOOLS, inject_datetime',
              '', sep, '# NODE DEFINITION -- frozen from the workflow editor', sep]
        for dn in self._modularDocNodes(facts, layout):
            if dn['id'] == nid:
                L += PythonEmitHelpers.nodeCommentBlock(dn).split('\n')
        L += self._nodeDefinitionLines(facts, nid, 'agent', entry['display'], d, False).split('\n')
        L += ['', sep,
              "# INSTRUCTIONS -- SwarmRewriter's composed prompt: this member's own",
              '# instructions, plus (when it has colleagues) the "Colleagues you can hand',
              '# this to" guide. Read from the rewrite, never recomputed here.',
              sep, 'INSTRUCTIONS = """']
        L += php_strval(member['instructions']).replace('\\', '\\\\').replace('"""', '\\"\\"\\"').split('\n')
        L += ['"""', '', sep,
              '# HANDOFFS -- one handoff tool per colleague. create_swarm() and',
              '# these tools both identify agents by NAME (the display name SwarmRewriter',
              '# guaranteed unique).',
              sep, 'HANDOFFS = [']
        for otherId in member['handoffs']:
            otherId = php_strval(otherId)
            other = rw['agents'].get(otherId)
            if other is None:
                continue
            role = self._swarmColleagueRole(rw, otherId).rstrip('. \t')
            desc = 'Hand the conversation to ' + other['name'] + (' — ' + role if role != '' else '') + '.'
            L.append('    create_handoff_tool(')
            L.append('        agent_name=' + py_str(php_strval(other['name'])) + ',')
            L.append('        description=' + py_str(desc) + ',')
            L.append('    ),')
        L += [']', '', '',
              'def _llm():',
              '    """The chat model for this member, built from NODE (provider/model/sampling/thinking)."""',
              '    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))',
              '', '',
              'def build_agent():',
              '    """Build this member\'s react agent: its own MCP tools plus one handoff per colleague.',
              '',
              "    name= is the member's DISPLAY name -- what create_swarm() and every colleague's",
              '    HANDOFFS identify it by, the same name the rewrite guaranteed unique.',
              '    """',
              '    tools = TOOLS.tools_for(NODE["tool_names"])',
              '    return create_react_agent(',
              '        _llm(),',
              '        tools + HANDOFFS,',
              '        **{_PROMPT_KW: inject_datetime(INSTRUCTIONS)},']
        # The rewrite's name, NOT NODE["display"]: create_swarm() matches agents BY NAME.
        L.append('        name=' + py_str(php_strval(member['name'])) + ',')
        L.append('    )')
        return '\n'.join(L).rstrip('\n') + '\n'

    def _swarmAgentDocBody(self, facts: dict, nid: str) -> str:
        """Module-docstring body for ONE swarm member."""
        rw = facts['swarm']
        member = rw['agents'][nid]
        d = facts['agentData'][nid]
        L = ['PROVENANCE', '==========',
             f"  Workflow:   {facts['wfName']} (id {facts['workflowId']})",
             '  Target:     LangGraph swarm member (Python) -- one create_react_agent(); workflow.py hands it to create_swarm()',
             _generated(),
             '  This file is a frozen snapshot of the workflow. Edits made here are',
             '  overwritten by the next Generate: change the workflow in the editor and',
             '  re-generate instead.', '',
             'MEMBER  (this file, not the whole workflow)', '======']
        model = d['model'] if (d.get('model') or '') != '' else '(platform default)'
        s = (d['provider'] or '?') + ' / ' + model
        if d.get('temperature') is not None:
            s += ', temp ' + j(php_floatval(d['temperature']))
        if d.get('max_tokens') is not None:
            s += ', max_tokens ' + str(php_intval(d['max_tokens']))
        L.append(f"  {member['name']} -- node {nid} in the workflow editor.")
        L.append(f'  Model:  {s}')
        L.append('  Tools:  ' + (', '.join(_skill_str(t) for t in member['tools']) if member['tools'] else '(none)'))
        L.append('  Skills: ' + (', '.join(_skill_str(x) for x in member['skills']) if member['skills'] else '(none)'))
        L += ['', "COLLEAGUES  (this member's own handoffs -- what HANDOFFS below builds, not the canvas)", '==========']
        if member['handoffs']:
            for otherId in member['handoffs']:
                other = rw['agents'].get(php_strval(otherId))
                if other is None:
                    continue
                role = self._swarmColleagueRole(rw, php_strval(otherId)).rstrip('. \t')
                L.append('  ' + other['name'] + (' -- ' + role if role != '' else ''))
        else:
            L.append('  (none -- this member has no colleague to hand off to)')
        L += ['', 'INSTRUCTIONS  (below)', '============',
              "  SwarmRewriter's composed prompt: this member's own instructions plus,",
              '  when it has colleagues, the "Colleagues you can hand this to" guide built',
              "  from the list above. Change the agent's prompt in the workflow editor,",
              '  not here -- this is overwritten on the next Generate.', '',
              'BUILD_AGENT()', '=============',
              "  Returns this member's create_react_agent(): its own MCP tools (Tools,",
              '  above) plus one handoff tool per colleague (HANDOFFS, below). workflow.py',
              '  imports it and passes the built agent straight into create_swarm().', '',
              'TO RUN', '======',
              '  # Requires Python 3.10+ (the generated code uses match statements)',
              '  pip install langchain langchain-anthropic langchain-openai langgraph langgraph-swarm httpx pydantic python-dotenv']
        k = PythonEmitHelpers.providerKeyEnv(php_strval(d.get('provider') or ''))
        L.append(f'  # API key read from ../../../.env: {k} (' + php_strval(d['provider']).lower() + ')'
                 if k is not None else '  # No LLM provider key required.')
        L.append('  imported by workflow.py -- run the swarm (python workflow.py), not this file directly.')
        return '\n'.join(L)

    @staticmethod
    def _swarmColleagueRole(rw: dict, colleagueId: str) -> str:
        """First line of a colleague's OWN composed instructions (at most 120 characters)."""
        instructions = php_strval((rw['agents'].get(colleagueId) or {}).get('instructions') or '')
        first = instructions.split('\n')[0].strip(_PHP_TRIM)
        return first[:120]

    def _emitSwarmWorkflow(self, facts: dict, layout: dict) -> str:
        """workflow.py, swarm mode: create_swarm() over one create_react_agent() per member, compiled with a checkpointer."""
        rw = facts['swarm']
        sep = SEP
        members: dict = {}   # nid => layout entry, in canvas (Start fan-out) order
        for i in rw['agents']:
            entry = layout['agents'].get(i)
            if entry is not None:
                members[php_strval(i)] = entry
        L = ['"""LangGraph swarm: ' + facts['wfName'], '']
        L += _esc(self._swarmWorkflowDocBody(facts, members)).split('\n')
        L += ['"""', 'from __future__ import annotations', '',
              'import argparse, asyncio, re, signal, time, uuid',
              'from datetime import datetime, timedelta',
              'from typing import Callable', '',
              'from langchain_core.messages import AIMessage, HumanMessage',
              'from langgraph.checkpoint.memory import MemorySaver',
              'from langgraph_swarm import create_swarm', '',
              '# Running this file puts its own folder on sys.path, so `common` and the',
              '# `agents` package below resolve wherever the workflow folder is copied.',
              'from common import EVENTS']
        for e in members.values():
            L.append('from ' + e['module'] + ' import build_agent as build_' + e['name'])
        L.append('')
        workflow = facts['workflow']
        ofolder = workflow.getOutputFolder()
        L.append('WORKFLOW_ID = ' + str(php_intval(facts['workflowId'])))
        L.append('WORKFLOW_NAME = ' + py_str(facts['wfName']))
        L.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if workflow.isOutputStorageEnabled() else 'False'))
        L.append('OUTPUT_FOLDER = ' + (py_str(php_strval(ofolder)) if (ofolder or '') != '' else 'None'))
        L.append('DEFAULT_PROMPT = ' + py_str(facts['startPrompt']))
        L.append(self._defaultCronLine(facts))
        entryName = php_strval((rw['agents'].get(rw['entry']) or {}).get('name') or '')
        L.append('DEFAULT_ACTIVE_AGENT = ' + py_str(entryName) + '   # the member wired to Start')
        L.append('# Every valid create_swarm() active_agent value -- each member\'s NODE["display"],')
        L.append('# the same text create_react_agent(name=...) and every HANDOFFS agent_name= use.')
        memberNames = [py_str(php_strval(rw['agents'][nid]['name'])) for nid in members]
        L.append('MEMBER_NAMES = {' + ', '.join(memberNames) + '}')
        L += ['', sep,
              '# GRAPH -- create_swarm() returns an UNCOMPILED StateGraph; .compile() is ours.',
              '# MemorySaver keeps hand-offs (active_agent + message history) coherent for',
              '# the run; it is the single point a database-backed saver replaces later.',
              sep, 'def build_graph():', '    return create_swarm(']
        L.append('        [' + ', '.join('build_' + e['name'] + '()' for e in members.values()) + '],')
        L += ['        default_active_agent=DEFAULT_ACTIVE_AGENT,',
              '    ).compile(checkpointer=MemorySaver())', '', '',
              '_GRAPH = None', '', '',
              'def _graph():',
              '    """Build the compiled graph once per process and reuse it."""',
              '    global _GRAPH',
              '    if _GRAPH is None:',
              '        _GRAPH = build_graph()',
              '    return _GRAPH', '', '',
              sep, '# MAIN EXECUTION', sep,
              'async def run(user_prompt: str, session: str | None = None) -> str:',
              '    """Run the swarm, starting from DEFAULT_ACTIVE_AGENT, and return the final',
              '    message text. api.py calls this exactly as it calls the modular',
              "    workflow.py's run() -- one prompt in, one answer out.",
              '',
              '    A swarm is a conversation: passing the same `session` on a later call',
              '    resumes it -- same transcript, and the agent that answered last still',
              '    holds the turn. Omitting it starts a fresh one, which is the right',
              '    default for a single-shot invocation."""',
              '    config = {"configurable": {"thread_id": session or uuid.uuid4().hex}}',
              '    result = await _graph().ainvoke({"messages": [HumanMessage(content=user_prompt)]}, config=config)',
              '    final = result["messages"][-1]',
              '    text = final.content if isinstance(final, AIMessage) else str(final)',
              '    if isinstance(text, list):',
              '        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))',
              '    # active_agent is the member holding the turn when it ended -- exactly who',
              '    # answered. Fall back to the entry agent rather than emit an unlabelled reply',
              '    # when it is missing (older checkpoints) or not a known member.',
              '    active = result.get("active_agent")',
              '    display = active if isinstance(active, str) and active in MEMBER_NAMES else DEFAULT_ACTIVE_AGENT',
              '    # `agent` is carried as its own field, not only inside the text: the',
              '    # conversation UI labels the bubble with it, and a label reading',
              '    # "Playbook" over an answer from "Human resources" is worse than no',
              '    # label at all. EVENTS.emit takes **kwargs, so this is additive.',
              '    EVENTS.emit(type="message", text=f"**{display}**\\n\\n{text}", agent=display, sensitive=False)',
              '    return text', '', '',
              'def _save_output(output: str) -> str | None:',
              '    """Honour the workflow\'s output storage setting (same rule as the non-swarm workflow.py)."""',
              '    import os, re',
              '    if not OUTPUT_STORAGE_ENABLED:',
              '        return None',
              '    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")',
              '    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")',
              '    if not os.path.isabs(folder):',
              '        folder = os.path.join(root, folder)',
              '    os.makedirs(folder, exist_ok=True)',
              '    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", output) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", output)',
              '    ext = "html" if m else "md"',
              '    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]',
              '    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime(\'%Y%m%d-%H%M%S\')}.{ext}")',
              '    with open(path, "w", encoding="utf-8") as fh:',
              '        fh.write(m.group(0) if m else output)',
              '    return path', '', '']
        L.append(LangGraphRuntime.cronBlock())
        L += ['if __name__ == "__main__":',
              '    ap = argparse.ArgumentParser(description=f"LangGraph swarm {WORKFLOW_NAME!r}", allow_abbrev=False)',
              '    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")',
              '    ap.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",',
              '                    help="run on a cron schedule until Ctrl-C (default: the Start node\'s schedule)")',
              '    a = ap.parse_args()',
              '    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"',
              '    runs = RunLoop()   # one event loop for every run, read per run (drain() swaps in a fresh one past the 30 min cap)',
              '',
              '    def run_once() -> str:',
              '        """One run of the swarm (a fresh conversation): its output printed and saved (\'\' when none)."""',
              '        print(f"[info] Prompt: {prompt[:100]}{\'...\' if len(prompt) > 100 else \'\'}", flush=True)',
              '        t0 = time.monotonic()',
              '        session = uuid.uuid4().hex',
              '        try:',
              '            output = runs.loop.run_until_complete(run(prompt, session))',
              '        finally:',
              "            if _GRAPH is not None:   # a run's conversation is not kept, so memory stays flat",
              '                _GRAPH.checkpointer.delete_thread(session)',
              '        if output:',
              '            print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)',
              '            saved = _save_output(output)',
              '            print("\\n" + "=" * 74 + "\\nRUN SUMMARY\\n" + "-" * 74, flush=True)',
              '            print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)',
              '            print(f"  Final output: {len(output)} chars", flush=True)',
              '            print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)',
              '            print("=" * 74, flush=True)',
              '        return output',
              '',
              '    match CronExpression.from_cli(ap, a.cron, DEFAULT_CRON):',
              '        case None:',
              '            if not run_once():',
              '                print("[info] The run ended without output.", flush=True)',
              '        case expr:',
              '            run_cron(expr, run_once, drains=False, loop=runs)   # a swarm has no code nodes']
        return '\n'.join(L).rstrip('\n') + '\n'

    def _swarmWorkflowDocBody(self, facts: dict, members: dict) -> str:
        """Module-docstring body for workflow.py, swarm mode: the COMPILED topology."""
        rw = facts['swarm']
        entryId = php_strval(rw['entry'])
        entryName = php_strval((rw['agents'].get(entryId) or {}).get('name') or '')
        L = ['PROVENANCE', '==========',
             f"  Workflow:   {facts['wfName']} (id {facts['workflowId']})",
             '  Target:     LangGraph swarm (Python) -- create_swarm() over one create_react_agent() per member',
             _generated(),
             '  This file is a frozen snapshot of the workflow. Edits made here are',
             '  overwritten by the next Generate: change the workflow in the editor and',
             '  re-generate instead.', '',
             'TOPOLOGY  (the compiled swarm this file builds -- not the canvas)', '========',
             '  Members, in the order create_swarm() receives them:']
        for nid, e in members.items():
            L.append('    ' + sprintf_pad(nid, 6) + ' ' + sprintf_pad(e['display'], 24) + ' ' + e['file'])
        L.append(f'  Default active agent: {entryName} -- the first agent Start connects to.')
        L += ['  Every member can hand the conversation to every other member: a full mesh,',
              '  not the list of canvas edges off Start (those decide membership only, not',
              "  this topology). Each member's own agents/<name>.py documents who it can",
              '  hand to and why.',
              '  common.py holds the runtime they share; api.py is the unmodified run server.',
              '  A `session` passed to POST /runs (api.py) resumes this exact conversation --',
              '  same transcript, same active agent picking up where it left off. Omitting it',
              '  starts a fresh one.', '',
              'TO RUN', '======',
              '  # Requires Python 3.10+ (the generated code uses match statements)',
              '  pip install langchain langchain-anthropic langchain-openai langgraph langgraph-swarm httpx pydantic python-dotenv']
        keys: dict = {}
        for nid in members:
            d = facts['agentData'].get(nid)
            if d is None:
                continue
            k = PythonEmitHelpers.providerKeyEnv(php_strval(d.get('provider') or ''))
            if k is not None:
                keys.setdefault(k, []).append(php_strval(d['provider']).lower())
        if keys:
            L.append('  # API keys read from ../../.env for the providers this swarm uses:')
            for k, provs in keys.items():
                L.append(f'  #   {k} (' + ', '.join(_unique(provs)) + ')')
        else:
            L.append('  # No LLM provider is used by a member of this swarm.')
        L.append('  python workflow.py "your prompt here"')
        for cl in self._cronDocLines(facts, 'workflow.py'):
            L.append('  ' + cl)
        if facts.get('missing'):
            L.append('  # WARNING: these tools are NOT available as MCP servers and will be missing at runtime: '
                     + self._pythonListRepr(facts['missing']))
        workflow = facts['workflow']
        folder = workflow.getOutputFolder()
        L.append('  # Output storage (Output node setting): ' + (
            'ON -> ' + (folder if (folder or '') != '' else 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)')
            if workflow.isOutputStorageEnabled() else 'OFF (the result is printed, not saved)'))
        return '\n'.join(L)

    @staticmethod
    def _swarmRefusalMessage(code: str) -> str:
        """One sentence per SwarmRewriter refusal code."""
        match code:
            case 'start_needs_two_agents':
                return 'A swarm needs two or more agents connected directly to Start; this canvas has fewer than two.'
            case 'dispatcher_in_swarm':
                return 'An agent is tagged Dispatcher, which has no meaning in a swarm -- every member routes for itself. Remove the Dispatcher tag and connect the agent to Start directly.'
            case 'agent_not_on_start':
                return 'This agent is not connected to Start, so it is not part of the swarm. Connect it to Start, or remove it.'
            case 'duplicate_agent_names':
                return 'Two agents share a name. A handoff names its target, so the swarm could not tell them apart -- rename one.'
            case 'multiple_outputs':
                return 'This workflow has more than one Output node. A swarm produces one answer.'
            case 'playbook_unsupported':
                return 'This workflow contains a Playbook node, which swarm mode does not support yet.'
            case _:
                return f'This workflow cannot run as a swarm ({code}).'

    def _generateModular(self, facts: dict) -> dict:
        """workflow.py, common.py, api.py, the package marker, one module per node, code files, package files."""
        layout = self.modularLayout(facts)
        # The package carries what it runs on: read from the original facts, then START_DOCUMENTS points at
        # the copies and each code node at its code/ file.
        package = LangGraphPackage.files(facts, self.skillsRoot, self.startDocuments)
        facts = dict(facts)
        facts['startDocuments'] = LangGraphPackage.startDocuments(facts.get('startDocuments') or [], self.startDocuments)['docs']
        facts['codeData'] = {k: dict(v) for k, v in facts['codeData'].items()}
        codeFiles: dict = {}
        for nid, cd in facts['codeData'].items():
            codeFiles[nid] = LangGraphPackage.codeFile(nid, cd, nid == facts['triggerNodeId'])
            cd['source_file'] = codeFiles[nid]['path']
        files = [
            {'path': 'workflow.py', 'code': self._emitModularWorkflow(facts, layout)},
            {'path': 'common.py', 'code': self._emitModularCommon(facts, layout, True)},
            {'path': 'api.py', 'code': self._emitModularApi(facts, layout)},
            {'path': 'agents/__init__.py', 'code': '"""Agent modules of workflow ' + j(facts['wfName'])
             + " -- one per agent/playbook node.\n\nEach module exposes NODE (the frozen editor settings) and\nrun_node = make_node(NODE).run (common.py's Node classes), which workflow.py\ncalls from its graph as run_node(request_text, trace).\n\"\"\"\n"},
        ]
        for nid, e in layout['agents'].items():
            files.append({'path': e['file'], 'code': self._emitModularAgentFile(facts, layout, nid)})
        files += list(codeFiles.values()) + package
        return self._withArchitecture({'root': layout['root'], 'files': files}, facts, 'modular')

    @classmethod
    def _withArchitecture(cls, result: dict, facts: dict, mode: str) -> dict:
        """A multi-file result plus its ARCHITECTURE.md: the last file, and under 'architecture'."""
        doc = cls._architectureDoc(facts, mode)
        if doc is not None:
            result['files'].append({'path': 'ARCHITECTURE.md', 'code': doc})
        result['architecture'] = doc
        return result

    def _modularDocNodes(self, facts: dict, layout: dict) -> list:
        """docNodes descriptors for the modular layout: every node, with its module file under 'file'."""
        nodes = self._a2aDocNodes(facts, {'agents': {}})
        for n in nodes:
            n['file'] = (layout['agents'].get(n['id']) or {}).get('file', '')
        return nodes

    @staticmethod
    def _providerKeyLines(facts: dict, envPath: str) -> list:
        """"# API keys read from <envPath> ..." lines shared by commonPyDocBody() and apiPyDocBody()."""
        keys: dict = {}
        for d in list(facts['agentData'].values()) + list(facts['playbookData'].values()):
            if (d.get('provider') or '') == '':
                continue
            k = PythonEmitHelpers.providerKeyEnv(d['provider'])
            if k is not None:
                keys.setdefault(k, []).append(d['provider'].lower())
        if not keys:
            return ['  # No LLM provider is used by a runnable node of this workflow.']
        L = [f'  # API keys read from {envPath} for the providers this workflow uses:']
        for k, provs in keys.items():
            L.append(f'  #   {k} (' + ', '.join(_unique(provs)) + ')')
        return L

    def _commonPyDocBody(self, facts: dict) -> str:
        """common.py's own module-docstring body (a library: no graph, no nodes)."""
        L = ['PROVENANCE', '==========',
             f"  Workflow:   {facts['wfName']} (id {facts['workflowId']})",
             '  Target:     LangGraph modular shared runtime (Python) -- imported by workflow.py and every agent module',
             _generated(),
             '  This file is a frozen snapshot of the workflow. Edits made here are',
             '  overwritten by the next Generate: change the workflow in the editor and',
             '  re-generate instead.', '',
             'SHARED RUNTIME  (no graph, no nodes -- this is a library, not a workflow file)', '==============',
             '  Imported by workflow.py and every module under agents/. Emitted byte-',
             '  identical for the DAG (modular) and swarm packages -- both import this',
             '  exact file, so a change here reaches every node of either shape at the',
             '  next Generate. (The A2A package does not import it: an A2A agent file',
             '  copies what it needs into its own process instead.)', '',
             'PROVIDES  (top-level names this file defines, in source order)', '========',
             '  _make_llm()                     provider/model -> LangChain chat model',
             '                                   (claude, openai, gemini, grok, deepseek, kimi, glm)',
             "  MCP_SERVERS, TOOL_CATALOG       this workflow's MCP servers + tool schemas, baked at generation time",
             '  McpClient, MCP                  the MCP JSON-RPC client: handshake (endpoint remembered), tools/call, JSON or SSE replies; one reused HTTP client',
             '  ToolCatalog, TOOLS              TOOL_CATALOG -> {name: StructuredTool}, calling out over MCP JSON-RPC; built once, each node takes its own by name',
             '  SkillRuntime, SKILLS            folder-backed skills: run_skill_script, the per-skill tool, a skill as a mandatory node step',
             "  RunEvents, EVENTS               how a run's events reach api.py; EVENTS.emit() is a no-op with no sink installed;",
             "                                   also the human-gate rendezvous a playbook node's tools wait on",
             '  set_event_sink, emit_event,',
             "  resolve_gate                    EVENTS' methods under their old names, for api.py and the run-server probes"]
        # dispatcherBlock() is emitted for every workflow; only the adapter classes depend on the protocols used.
        adapters = [LangGraphRuntime.ADAPTER_CLASSES[p] + ',' for p in self._decisionProtocolsUsed(facts.get('agentData') or {})]
        L.append('  ' + ' '.join(['DecisionResult,'] + adapters))
        L.append('  DECISION_ADAPTERS, RouteDecision,')
        L.append("  Dispatcher                      a DISPATCHER node's routing: a decision model or one forced route_to call, never both")
        L.append('  inject_datetime()               prepends a dated header, resolves [date]/[weekday]/[year]/[time] in a system prompt')
        if facts['playbookData']:
            L += ['  PLAYBOOK_SYSTEM_PROMPT,', '  GATE_BRIDGE, PlaybookRun,',
                  '  PlaybookToolset                 the playbook interpreter (this workflow has playbook nodes)']
        L.append('  Node, AgentNode, DispatcherNode,')
        if facts['playbookData']:
            L.append('  PlaybookNode,')
        L += ['  NodeKind, make_node()           one Node subclass per node kind; every agent module is its NODE + make_node(NODE).run',
              '  WFState, build_context()        the graph state type and per-node input builder (used by WorkflowGraph)',
              '  DocumentConverter / DOCUMENTS   Start-node attachment -> Markdown, one method per format (lazy imports, text formats verbatim)',
              "  WorkflowGraph                   the LangGraph StateGraph over workflow.py's EDGES/ORDER/NODE_TYPES and its node runner",
              '  save_output(),',
              "  print_run_summary()             the Output node's storage rule and the closing RUN SUMMARY (workflow.py's CLI)",
              '', 'CONFIGURATION', '=============',
              '  load_dotenv() resolves python/.env -- two directories above this file --',
              '  at import time, before workflow.py or any agent module reads a provider',
              '  key, so importing this module alone (a test, a REPL) still finds them. No',
              '  key is checked here: building a chat model succeeds either way, and the',
              '  underlying provider SDK raises at the first real request if a required key',
              '  is missing or empty.', '',
              'TO RUN', '======',
              '  # Requires Python 3.10+ (the generated code uses match statements)',
              '  pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv']
        L += self._providerKeyLines(facts, '../../.env')
        L += ['  imported, not run directly -- see workflow.py',
              '  # Everything here is shared: change it once and every node of this workflow follows.',
              '  # Output storage (Output node setting): OFF (the result is printed, not saved)']
        return '\n'.join(L)

    def _apiPyDocBody(self, facts: dict, target: str, deps: str, extraNotes: list) -> str:
        """api.py's own module-docstring body, shared by the modular/swarm and the A2A run servers."""
        L = ['PROVENANCE', '==========',
             f"  Workflow:   {facts['wfName']} (id {facts['workflowId']})",
             f'  Target:     {target}',
             _generated(),
             '  This file is a frozen snapshot of the workflow. Edits made here are',
             '  overwritten by the next Generate: change the workflow in the editor and',
             '  re-generate instead.', '',
             'RUN SERVER  (no graph, no nodes -- it has never heard of either)', '==========',
             '  Speaks the run protocol the SynergyAI workflow editor uses to start a run',
             '  and stream its progress. The graph itself lives elsewhere -- workflow.py',
             '  (modular/swarm) or orchestrator.py (A2A) -- this file only drives and',
             '  observes it (set_event_sink) over HTTP.', '',
             'HTTP SURFACE', '============',
             '  GET  /.well-known/workflow.json     identity: {workflow_id, name, version, protocol}',
             '  POST /runs                          {prompt, session} -> {run_id, status}; starts the run',
             '                                       as a background task -- does not itself stream',
             '  GET  /runs/{run_id}/events           text/event-stream -- see SSE FRAMES below',
             "  POST /runs/{run_id}/tool-result      {tool_call_id, ...answer} -- answers a playbook's human gate", '',
             'SSE FRAMES', '==========',
             '  Each frame is  id: <seq>\\nevent: <name>\\ndata: <json>\\n\\n .  `id:` is the',
             '  sequence number a reconnecting client echoes back as Last-Event-ID.',
             '  Event names: "message" (one run event forwarded from the graph\'s sink --',
             '  its payload can itself be {"type": "truncated", ...} instead of a real',
             '  event; see RECONNECT), "done" (terminal -- carries output + seconds) and',
             '  "error" (terminal -- carries the exception text).', '',
             'RECONNECT', '=========',
             '  Every published frame is kept in a per-run ring buffer (500 frames) for',
             '  replay. A client that reconnects sends Last-Event-ID; the stream replays',
             '  everything after it -- or, if the gap outran the ring, one "truncated"',
             '  message first -- before resuming live. That is what lets a dropped client',
             '  pick a run back up instead of losing it.', '',
             'SESSION', '=======',
             '  The `session` field on POST /runs is forwarded to run_workflow() as the',
             '  conversation to resume: the same value on a later POST /runs continues',
             '  that thread on the checkpointer; omitting it starts a fresh one. Only the',
             "  swarm target's run() actually reads it -- a DAG run() (modular or A2A)",
             '  accepts the parameter and ignores it, so a caller can pass the same',
             '  session to any target without knowing which one is behind this server.', '',
             'TO RUN', '======',
             '  # Requires Python 3.10+ (the generated code uses match statements)',
             '  ' + deps]
        L += self._providerKeyLines(facts, '../../.env')
        L.append('  python api.py --port 8710        # then open the workflow from the editor')
        for n in extraNotes:
            L.append('  ' + n)
        L.append('  # Output storage (Output node setting): OFF (the result is printed, not saved)')
        return '\n'.join(L)

    def _modularDocBody(self, facts: dict, layout: dict, target: str, run: dict, nid: str | None = None,
                        storage: bool = False, dataFlow: str | None = None) -> str:
        """Module-docstring body shared by the three file kinds; nid marks one node as "<== this module"."""
        nodes = self._modularDocNodes(facts, layout)
        if nid is not None:
            for n in nodes:
                if n['id'] == nid:
                    n['marker'] = '<== this module'
        workflow = facts['workflow']
        runDoc = {'extra': list(run.get('extra') or []) + self._decisionDocLines(facts.get('agentData') or {})
                  + self._mcpHeaderDocLines(facts)}
        for k, v in run.items():   # ['extra' => ...] + $run: the merged extra wins, the rest follows
            if k != 'extra':
                runDoc[k] = v
        return PythonEmitHelpers.workflowDocBlock({
            'target': target,
            'dispatch_supported': True,
            'workflow': {'id': facts['workflowId'], 'name': facts['wfName']},
            'nodes': nodes, 'edges': facts['edgeList'], 'layers': facts['gdata'].get('layers') or [],
            'data_flow': dataFlow if dataFlow is not None else self._modularDataFlowDoc(),
            'run': runDoc,
            'storage': ({'enabled': workflow.isOutputStorageEnabled(), 'folder': workflow.getOutputFolder(),
                         'default': 'outputs/workflow/ in this folder (SYNERGYAI_OUTPUT_ROOT overrides)'}
                        if storage else {'enabled': False, 'folder': None}),
        })

    @staticmethod
    def _modularDataFlowDoc() -> str:
        return T.modularDataFlowDoc__ret

    def _emitModularCommon(self, facts: dict, layout: dict, packaged: bool = False) -> str:
        """common.py: the shared runtime library, WorkflowGraph included. No graph data, no node definitions."""
        sep = SEP
        L = ['"""Shared runtime for workflow ' + j(facts['wfName']), '']
        L += _esc(self._commonPyDocBody(facts)).split('\n')
        L += ['"""', 'from __future__ import annotations', '']
        withPlaybooks = bool(facts['playbookData'])
        L.append('import asyncio, json, os, re, subprocess, sys, threading, time, uuid'
                 + (', types' if facts['codeData'] and not packaged else ''))
        L += ['from abc import ABC, abstractmethod',
              'from dataclasses import asdict, dataclass, field',
              'from datetime import datetime',
              'from enum import Enum',
              'from functools import cached_property',
              'from pathlib import Path',
              'from typing import Annotated, Awaitable, Callable, Literal, TypedDict', '',
              'from dotenv import load_dotenv',
              '# This file lives in <root>/; the runner .env is two levels up (python/.env).',
              '# Loaded here rather than in workflow.py so a module imported on its own',
              '# (a test, a REPL) still finds the provider keys.',
              '_HERE = os.path.dirname(os.path.abspath(__file__))',
              'load_dotenv(os.path.join(_HERE, ".env"))   # the workflow folder\'s own .env first (never overridden)',
              'RUNNER_DIR = os.path.dirname(os.path.dirname(_HERE))   # the runner env folder (python/)',
              'load_dotenv(os.path.join(RUNNER_DIR, ".env"))',
              "DEBUG_STEM = os.path.basename(_HERE)   # the package folder names the agents' outputs/_debug dumps",
              'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))   # the package folder: code/, skills/, outputs/, start_documents/',
              '',
              'import httpx',
              'from langchain_core.messages import AIMessage, HumanMessage, SystemMessage',
              'from langchain_core.tools import StructuredTool',
              'from langgraph.graph import END, START, StateGraph',
              'try:',
              '    from langchain.agents import create_agent as create_react_agent',
              'except ImportError:',
              '    from langgraph.prebuilt import create_react_agent',
              'from pydantic import Field, create_model', '',
              "MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()", '',
              sep, '# LLM FACTORY', '# Provider/model -> LangChain chat model. Every node calls this with its',
              '# own baked settings, so one workflow can mix providers.', sep]
        L.append(LangGraphRuntime.llmFactoryBlock())
        L += ['', sep, '# MCP SERVER REGISTRY + TOOL CATALOG (every tool this workflow uses)',
              '# Baked at generation time. An agent module names the tools it may use',
              '# in NODE["tool_names"]; the catalog itself is shared.', sep]
        L.append('MCP_SERVERS = ' + json_to_python(facts['usedServers'], True))
        if facts['codeData']:
            L.append('MCP_SLUGS = ' + json_to_python(facts['codeSlugs'], True))
        L.append('TOOL_CATALOG = ' + json_to_python(facts['usedCatalog'], True))
        L += ['', sep, '# MCP CLIENT -- JSON-RPC 2.0 over HTTP', sep]
        L.append(self._serverSlugsLine(facts.get('serverSlugs') or {}))
        L.append('')
        L.append(LangGraphRuntime.mcpClientBlock())
        if facts['codeData']:
            L.append(LangGraphRuntime.codeHarnessBlock(packaged))
            L.append('')
        L += [sep, '# TOOL BUILDER + SKILL RUNTIME', sep]
        L.append(LangGraphRuntime.toolCatalogBlock() + LangGraphRuntime.skillRuntimeBlock(packaged))
        L.append(LangGraphRuntime.runEventsBlock())
        L += [sep, '# DISPATCHER RUNTIME', sep]
        L.append(LangGraphRuntime.dispatcherBlock(self._decisionProtocolsUsed(facts.get('agentData') or {})))
        L.append(self._datetimeInjectorBlock())
        if withPlaybooks:
            L.append(LangGraphRuntime.playbookBlock())
        L.append(LangGraphRuntime.nodeClassesBlock(withPlaybooks, bool(facts['codeData'])))
        L += ['', sep, '# GRAPH STATE + CONTEXT BUILDING (used by WorkflowGraph)', sep]
        L += [self._stateBlock(), '', self.contextBuilderBlock()]
        L += [sep, '# ATTACHMENT CONVERTER (Start-node documents)', sep]
        L.append(LangGraphRuntime.documentConverterBlock())
        L.append(LangGraphRuntime.runRecordBlock())
        L.append(LangGraphRuntime.liveFeedBlock())
        L.append(LangGraphRuntime.consoleBlock())
        L.append(LangGraphRuntime.workflowGraphBlock())
        L.append(LangGraphRuntime.outputBlock(packaged))
        return '\n'.join(L).rstrip('\n') + '\n'

    def _emitModularApi(self, facts: dict, layout: dict, listen: bool = True) -> str:
        """api.py: the run server; with listen (the modular package) also the Start's cron / watch loop."""
        body = self._apiPyDocBody(facts,
                                  'LangGraph modular run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
                                  'pip install fastapi uvicorn langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                                  ['# No authentication: bind to 127.0.0.1 or a trusted LAN interface only.',
                                   '# CORS allows loopback origins only. A LAN-hosted frontend adds itself with',
                                   '#   WORKFLOW_API_ALLOW_ORIGIN=http://host:port   (comma-separated for several)']
                                  + (['#',
                                      "#   python api.py --listen    # also run the Start's schedule / event trigger (POST /listen toggles it;",
                                      "#                             # GET /live streams the runs and the listener's state)"] if listen else []))
        return RunServerEmitter.emit(
            facts['wfName'],
            _esc(body),
            'from workflow import run as run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
            'WORKFLOW_VERSION = ' + py_str(self._a2aVersion(facts)),
            listen,
        )

    def _emitModularAgentFile(self, facts: dict, layout: dict, nid: str) -> str:
        """agents/<name>.py: ONE node -- its frozen definition plus run_node()."""
        entry = layout['agents'][nid]
        kind = entry['kind']
        isPlaybook = kind == 'playbook'
        match kind:
            case 'playbook':
                d = facts['playbookData'][nid]
            case 'code':
                d = facts['codeData'][nid]
            case _:
                d = facts['agentData'][nid]
        sep = SEP
        L = ['"""Agent module ' + j(entry['display']) + f' -- node {nid} of workflow ' + j(facts['wfName']), '']
        body = self._modularDocBody(facts, layout,
                                    'LangGraph modular agent module (Python) -- one node; workflow.py drives the graph',
                                    {'deps': ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv'],
                                     'usage': 'imported by workflow.py as ' + entry['module'] + ' -- run the workflow, not this file',
                                     'extra': ["# Exposes NODE (frozen editor settings) and run_node = make_node(NODE).run; the node logic is common.py's Node classes."],
                                     'env_path': '../../../.env'}, nid)
        L += _esc(body).split('\n')
        L += ['"""', 'from __future__ import annotations', '',
              '# The shared runtime lives in common.py, one directory up. Python puts the',
              '# workflow folder on sys.path when workflow.py starts, so this resolves for',
              '# every module of the package.',
              'from common import make_node', '',
              sep, '# NODE DEFINITION -- frozen from the workflow editor', sep]
        for dn in self._modularDocNodes(facts, layout):
            if dn['id'] == nid:
                L += PythonEmitHelpers.nodeCommentBlock(dn).split('\n')
        if isPlaybook and (d.get('source') or 'fixed') == 'input':
            L += self._publishedPlaybooksLines(facts['publishedPlaybooks'], facts['publishedSkipped'])
            L.append('')
        defLines = (self._codeNodeDefinitionLines(nid, d) if kind == 'code'
                    else self._nodeDefinitionLines(facts, nid, kind, entry['display'], d, isPlaybook))
        L += defLines.split('\n')
        L += ['', "# The node logic lives in common.py's Node classes: make_node(NODE) builds the",
              "# subclass for this NODE's kind, and workflow.py calls its run(request_text, trace).",
              'run_node = make_node(NODE).run']
        return '\n'.join(L).rstrip('\n') + '\n'

    def _emitModularWorkflow(self, facts: dict, layout: dict) -> str:
        """workflow.py: the graph over the agent modules, plus the CLI entry point."""
        sep = SEP
        modules = ['  ' + sprintf_pad(nid, 6) + ' ' + sprintf_pad(e['display'], 24) + ' ' + e['file']
                   for nid, e in layout['agents'].items()]
        L = ['"""LangGraph workflow: ' + facts['wfName'], '']
        body = self._modularDocBody(facts, layout,
                                    'LangGraph modular workflow (Python) -- StateGraph over one importable module per node',
                                    {'deps': ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                                              '# optional, only for the attachment formats you use:',
                                              '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'],
                                     'usage': 'python workflow.py "your prompt here"',
                                     'extra': ((['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: '
                                                 + self._pythonListRepr(facts['missing'])] if facts.get('missing') else [])
                                               + self._modeDocLines('workflow.py') + self._cronDocLines(facts, 'workflow.py')
                                               + self._watchDocLines(facts, 'workflow.py')),
                                     'env_path': '../../.env'}, None, True)
        L += _esc(body).split('\n')
        L += ['', 'AGENT MODULES  (id, name, file -- each exposes NODE and run_node)', '=============']
        L += modules
        L += ['  common.py holds the runtime they share and the WorkflowGraph; Start and Output run there, with no LLM.',
              '"""', 'from __future__ import annotations', '',
              'import argparse, asyncio, json, os, re, signal, sys, time',
              'from datetime import datetime, timedelta',
              'from typing import Callable', '',
              '# Running this file puts its own folder on sys.path, so `common` and the',
              '# `agents` package below resolve wherever the workflow folder is copied.',
              'from common import EVENTS, MCP, MCP_SERVER_SLUGS, NULL_RECORDER, RUN_OUT, ConsoleView, ErrorExitTaken, RunRecorder, '
              + 'WorkflowGraph, is_quiet, print_run_summary, save_output']
        for e in layout['agents'].values():
            L.append('from ' + e['module'] + ' import run_node as ' + e['name'] + '_run')
        L.append('')
        workflow = facts['workflow']
        ofolder = workflow.getOutputFolder()
        L.append('WORKFLOW_ID = ' + str(php_intval(facts['workflowId'])))
        L.append('WORKFLOW_NAME = ' + py_str(facts['wfName']))
        L.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if workflow.isOutputStorageEnabled() else 'False'))
        L.append('OUTPUT_FOLDER = ' + (py_str(php_strval(ofolder)) if (ofolder or '') != '' else 'None'))
        L.append('DEFAULT_PROMPT = ' + py_str(facts['startPrompt']))
        L.append(self._defaultCronLine(facts))
        L.append(self._defaultWatchLine(facts))
        L += self._startModeLines(facts)
        L.append('START_DOCUMENTS = ' + json_to_python(facts['startDocuments'] or []))
        L += ['', sep, '# AGENT TABLE -- what each node is, and which module runs it', sep]
        docById = {dn['id']: dn for dn in self._modularDocNodes(facts, layout)}
        L.append('AGENTS = {')
        for nid, e in layout['agents'].items():
            if nid in docById:
                L += PythonEmitHelpers.nodeCommentBlock(docById[nid], '    ').split('\n')
            dispatch = ([{'id': php_strval(t['id']), 'name': t['name']} for t in facts['agentData'][nid]['dispatch']]
                        if e['kind'] == 'dispatcher' else [])
            L.append('    ' + j(php_strval(nid)) + ': {"display": ' + j(e['display']) + ', "kind": ' + j(e['kind'])
                     + ', "module": ' + j(e['module']) + ', "dispatch": ' + j(dispatch)
                     + (', "exit_targets": ' + j(obj(facts['codeData'][nid]['exit_targets'])) if e['kind'] == 'code' else '') + '},')
        L += ['}', '', '# node id -> the module function that runs it (imported above).', '_NODE_RUNNERS = {']
        for nid, e in layout['agents'].items():
            L.append('    ' + j(php_strval(nid)) + ': ' + e['name'] + '_run,')
        L += ['}', '', sep, '# GRAPH STRUCTURE -- frozen from the workflow editor', sep]
        L.append('EDGES = ' + json_to_python(facts['edgeList']))
        L.append('ORDER = ' + json_to_python(facts['order']))
        L.append('NODE_TYPES = ' + json_to_python(self._typeMap(facts), True))
        L.append('')
        L.append(LangGraphRuntime.cronBlock())
        L.append(LangGraphRuntime.watchBlock())
        L.append(LangGraphRuntime.listenerBlock())
        L.append(self._modularRunnerBlock())
        return '\n'.join(L).rstrip('\n') + '\n'

    @staticmethod
    def _modularRunnerBlock() -> str:
        """workflow.py's runtime half: node runner, graph build, output storage, CLI."""
        return T.modularRunnerBlock__ret


def _with_first(d: dict, key: str, value) -> dict:
    """`[$key => $value] + $d`: key first with value, then every other key of d (d's value for key ignored)."""
    out = {key: value}
    for k, v in d.items():
        if k != key:
            out[k] = v
    return out


def _skill_str(s) -> str:
    """implode() of a member's skills: each a bound_skill value (a string, or an array -> "Array")."""
    if isinstance(s, (dict, list)):
        return 'Array'
    return php_strval(s)
