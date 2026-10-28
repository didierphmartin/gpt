"""Port of backend/src/AgentTeam/Services/ADKGenerator.php and ADKPackage.php -- the Google ADK compiler.

Generates a standalone Python Google ADK program from a saved workflow: a single file (generate), a package
with agents in separate files (generatePackage) or an A2A folder, one agent server per node plus an
orchestrator (generateA2A). The emitted bytes are PHP's for the same inputs
(tests/unit/test_compiled_targets_differential.py compiles the compiler fixtures with both and compares).

emitAdk() is pure (no DB/I/O) so it can be unit-tested without a database; generate() does the DB lookup
via WorkflowGraphAnalyzer and then delegates to it. The program itself never reads the database.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from app.agent_team.services.compiled_architecture_doc import CompiledArchitectureDoc
from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_php import PhpObj, array_values, j, json_encode, json_to_python, obj, py_str, var_export_float
from app.agent_team.services.compiler_text import adk_generator as T
from app.agent_team.services.compiler_text import python_emit_helpers as T_PEH
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.logger import error_log
from app.support.phpcompat import php_floatval, php_intval, php_strval

_PY_KEYWORDS = frozenset([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
    'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])
_IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
_TYPE_MAP = {'string': 'str', 'integer': 'int', 'number': 'float', 'boolean': 'bool', 'array': 'list', 'object': 'dict'}


def _d(v) -> dict:
    """`(array) ($x ?? [])` for the analysis' maps: a dict, or {} when absent / empty."""
    return v if isinstance(v, dict) else {}


def _l(v) -> list:
    """A list-valued analysis entry: list(v), or [] when absent."""
    if isinstance(v, dict):
        return list(v.values())
    return list(v) if isinstance(v, (list, tuple)) else []


def _php_lower(s: str) -> str:
    """strtolower(): ASCII letters only (PHP 8)."""
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in s)


def _safe_name(name: str) -> str:
    """preg_replace('/[^a-z0-9_]+/i', '_', $name)."""
    return re.sub(r'[^a-z0-9_]+', '_', name, flags=re.IGNORECASE | re.ASCII)


def _filename(analyzed: dict) -> str:
    """The single file's name: <workflow>_adk.py."""
    return _php_lower(_safe_name(php_strval(analyzed['workflow']['name']))) + '_adk.py'


def _addslashes(s: str) -> str:
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('"', '\\"').replace('\x00', '\\0')


def _count(v) -> int:
    return len(v) if isinstance(v, (list, dict, tuple)) else (0 if v is None else 1)


def _code_exits(analyzed: dict, p) -> list:
    cd = _d(analyzed.get('code')).get(str(p))
    return (cd or {}).get('exits') or [] if isinstance(cd, dict) else []


class ADKPackage:
    """The ADK package's own files: CompiledPackage with ADK's framework packages."""
    # google-adk 2.3.x still supports SequentialAgent/ParallelAgent; litellm carries the non-Gemini providers.
    FRAMEWORK = ['google-adk', 'litellm']
    # The compile target, as CompiledPackage reads it.
    TARGET = {'key': 'adk', 'title': 'Google ADK', 'framework': FRAMEWORK}

    @classmethod
    def files(cls, analyzed: dict, skillsRoot: str, documentFiles: list | None = None, layout: str = 'modular') -> list:
        return CompiledPackage.files(analyzed, skillsRoot, documentFiles or [], cls.TARGET, layout)

    @staticmethod
    def codePath(analyzed: dict, nid: str) -> str:
        return CompiledPackage.codePath(analyzed, nid)


class ADKGenerator:
    def __init__(self, db, workflowRepo, graphRepo, agentRepo, skillsRoot: str | None = None, startDocuments=None):
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo
        self.skillsRoot = skillsRoot              # the package copies the used skills from here
        self.startDocuments = startDocuments      # the package copies the Start's documents from here

    def generate(self, workflowId: int, userId: str | None = None) -> dict:
        """A Google ADK Python script for the workflow: {filename, code, architecture}."""
        analyzed = self._analyzeWorkflow(workflowId, userId)
        filename = _filename(analyzed)
        return CompiledArchitectureDoc.attach({
            'filename': filename,
            'code': self.emitAdk(analyzed),
            'package_files': CompiledPackage.singleFiles(analyzed, ADKPackage.TARGET, filename),
        }, analyzed, 'adk', 'single')

    def _analyzeWorkflow(self, workflowId: int, userId: str | None) -> dict:
        """Everything emitAdk() needs, read from the database at compile time."""
        # A swarm is a different architecture, not a packaging choice (spec section 9: not built yet here).
        wfForArch = self.workflowRepo.findById(workflowId)
        if wfForArch and wfForArch.getOrchestration() == 'swarm':
            raise RuntimeError(
                'This workflow is set to swarm orchestration, which ADK cannot compile. '
                'Compile it with LangGraph, or switch the workflow to "workflow" orchestration.'
            )
        analyzer = WorkflowGraphAnalyzer(self.db, self.workflowRepo, self.graphRepo, self.agentRepo)
        analyzed = analyzer.analyze(workflowId, userId)

        # Platform default model per provider (system_llm_settings): an empty node/agent model means
        # "use the platform default", resolved at generation time.
        defaults: dict = {}
        try:
            for row in self.db.fetch_all('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1'):
                if row.get('model'):
                    defaults[php_strval(row['provider_key']).lower()] = php_strval(row['model'])
        except Exception as e:  # noqa: BLE001
            error_log('[ADKGenerator] could not load provider default models: ' + str(e))
        analyzed['providerDefaultModels'] = defaults

        # Playbook nodes: resolved once here (their #Action bindings need the MCP catalog).
        analyzed['playbooks'] = {}
        for pid, pnode in _d(analyzed.get('byId')).items():
            if WorkflowGraphAnalyzer.typeOf(pnode) != 'playbook':
                continue
            PlaybookEmit.refuseLangGraphOnly(pnode, self.graphRepo.getGraph(workflowId).get('edges') or [])
            analyzed['playbooks'][str(pid)] = PlaybookEmit.nodeData(pnode, analyzer.availableToolsById(userId),
                                                                    defaults, userId)

        return CompiledRuntimeEmit.analyzeRuntime(analyzed, analyzer, self.db, self.agentRepo,
                                                  self.graphRepo.getGraph(workflowId), workflowId, userId)

    @classmethod
    def emitAdk(cls, analyzed: dict) -> str:
        """Pure emit entry point: the full Python source of an analysis. No DB/I/O."""
        return '\n'.join(text for _, text in cls._parts(analyzed)) + '\n'

    @classmethod
    def _parts(cls, analyzed: dict) -> list:
        """The script as [section, text] parts, in the single file's order: 'common' (the runtime), 'node:<id>'
        (one node's agent), 'workflow' (assembly, run, CLI), 'single' (only in the single file)."""
        parts: list = []

        def add(section: str, text: str) -> None:
            parts.append((section, text))

        def add_entries(entries: dict) -> None:
            keys = list(entries)
            for id_ in keys:   # a blank line between nodes, as one joined block had
                add(f'node:{id_}', entries[id_] if id_ == keys[-1] else entries[id_] + '\n')

        b = cls._banner
        add('common', cls._headerBlock(analyzed))

        add('common', b('MODEL FACTORY',
                        'Maps a node provider+model to an ADK model. Gemini is native;',
                        'every other provider routes through LiteLLM (OpenAI-compatible',
                        'endpoints for Grok/Kimi/DeepSeek/GLM). The node form Thinking',
                        'attribute governs reasoning mode; hard API constraints only',
                        '(kimi sampling, deepseek-v4 thinking rules) are applied here.',
                        'To support a new provider: add a branch in _make_model.'))
        add('common', T.modelFactoryBlock__ret)

        add('common', b('MCP SERVER REGISTRY',
                        'Baked at generation time from the workflow editor config.',
                        'Maps server URL -> metadata. If a server moves, update the URL here.'))
        add('common', 'MCP_SERVERS = ' + json_to_python(analyzed['usedServers'], True))
        add('common', b('TOOL CATALOG',
                        'Each entry maps a tool name to its MCP server URL and JSON Schema.',
                        'Only tools actually used by agents in this workflow are included.',
                        'To add a tool: add an entry here AND reference it in the agent',
                        'definitions below (catalog["<tool>"]).'))
        add('common', 'TOOL_CATALOG = ' + json_to_python(analyzed['usedCatalog'], True))
        add('common', b('MCP CLIENT',
                        'HTTP JSON-RPC client used by every generated _tool_* function.'))
        add('common', CompiledRuntimeEmit.mcpClientBlock(analyzed))
        add('common', b('DOCUMENT CONVERTER',
                        'Turns a start-node attachment into markdown for the prompt.'))
        add('common', T_PEH.documentConverterBlock__ret)
        add('common', b('TOOL WRAPPERS',
                        'One typed FunctionTool per catalog entry; ADK introspects each',
                        'function signature to build the tool schema the model sees.'))
        add('common', cls._adkToolBuilderBlock(analyzed))

        # The skill runner only when some agent has a non-empty skills list.
        needsSkills = any(ag.get('skills') for ag in _d(analyzed.get('agents')).values())
        if needsSkills:
            add('common', b('SKILL RUNTIME',
                            'Runs folder-backed skills (SKILL.md + scripts) as mandatory',
                            'post-agent SequentialAgent steps: an LLM turn instructed by',
                            'SKILL.md, then a capture agent that makes the node output the',
                            'file the script PRODUCED (else the LLM text). Staged',
                            'input_files are repaired if a model delivers them',
                            'JSON-over-escaped. Scripts run as async subprocesses here.'))
            add('common', T_PEH.skillDepsBlock__ret)
            if analyzed.get('package'):
                add('common', 'SKILLS_DIR = os.environ.get("SYNERGYAI_SKILLS_DIR") or os.path.join(PACKAGE_DIR, "skills")   # the package\'s own skills/')
            add('common', cls._skillRunnerBlock())

        # catalog must be defined after build_tools_from_catalog().
        add('common', '# The tool objects agents reference by name as catalog["<tool>"].')
        add('common', 'catalog = build_tools_from_catalog()')
        add('common', 'START_DOCUMENTS = ' + json_to_python(analyzed['startDocuments']))
        add('single', b('AGENTS — ONE LlmAgent PER WORKFLOW NODE',
                        'Each agent writes its result to session.state["node_<id>"]; a',
                        'child reads a parent through the literal {node_<id>} placeholder',
                        'in its instruction (ADK state templating). Provider/model/tools/',
                        'sampling come verbatim from the editor forms (constraint clamps',
                        'are documented as comments on the affected node). To change a',
                        'node: edit the workflow in the editor and re-generate.'))
        add_entries(cls.agentEntries(analyzed))

        consolidators = cls._outputConsolidatorsBlock(analyzed)
        if consolidators != '':
            add('common', b('OUTPUT (FAN-IN) NODES',
                            'Non-LLM pass-throughs: forward parent result(s) VERBATIM so',
                            'formatting such as HTML is never reworded by another model.'))
            add('common', T.passThroughAgentBlock__ret)
            add('workflow', consolidators)
        if analyzed.get('playbooks'):
            add('common', b('PLAYBOOK NODES',
                            'A playbook node is an interpreter, not an agent: the model',
                            're-decides each round from the running transcript, with the',
                            'native verbs, the human gates, one tool per bound #Action and',
                            'a stub per unbound one. The node output is that transcript.'))
            # ADK already emits its own MCP client above: do not re-emit it.
            add('common', PlaybookEmit.supportBlock(False))
            add('common', PlaybookEmit.runtimeBlock())
            add('common', PlaybookEmit.metadataBlock(analyzed['playbooks']))
            add('common', T.playbookAgentBlock__ret)
            add_entries(cls.playbookInstancesEntries(analyzed))
        if analyzed.get('code'):
            add('common', b('CODE NODES',
                            'A code node runs its own Python run(input, call_tool) through the',
                            'harness the workflow editor runs (CODE_HARNESS): no model. Its',
                            'output is state["node_<id>"], the exit it took state["route_<id>"].'))
            add('common', CompiledRuntimeEmit.codeHarnessBlock(bool(analyzed.get('package'))))
            add('common', T.codeAgentBlock__ret)
            add_entries(cls.codeInstancesEntries(analyzed))
        dispatchers = cls._dispatcherInstancesBlock(analyzed)
        if dispatchers != '':
            add('common', b('DISPATCHER NODES',
                            'A dispatcher\'s outgoing edges are a MENU, not a fan-out: the',
                            'node names ONE child and only that child runs. Its menu is',
                            'nested here, which is why those children are absent from the',
                            'topological layers below.'))
            protocols: dict = {}
            for d in _d(analyzed.get('decisions')).values():
                for c in d['decision']:
                    protocols[c['protocol']] = True
            add('common', 'from dataclasses import dataclass, field\nfrom functools import cached_property\n\n'
                + LangGraphRuntime.decisionAdaptersBlock([p for p in protocols if p in LangGraphRuntime.ADAPTER_CLASSES]))
            add('common', T.dispatcherAgentBlock__ret)
            add('workflow', dispatchers)
        if cls._needsGates(analyzed):
            add('common', b('ROUTING',
                            'A node after a choice (a code node with several exits, a',
                            'dispatcher) runs inside a _Gate: only when a parent ran and',
                            'the exit it took leads here. Untaken branches are skipped.'))
            add('common', T.gateAgentBlock__ret)
        add('common', b('RUN EVENTS',
                        'Each node\'s start and completion (a code node\'s exit, a',
                        'dispatcher\'s route) go to GRAPH_RECORDER when the package\'s',
                        'listener set one: runs/ and GET /live, the editor\'s live canvas.'))
        add('common', CompiledRuntimeEmit.recordingBlock(analyzed, True))
        add('workflow', b('ORCHESTRATION',
                          'The workflow graph as TOPOLOGICAL LAYERS: independent nodes at',
                          'the same depth run together in a ParallelAgent; the layers run',
                          'in order inside a SequentialAgent. This mirrors the canvas.'))
        add('workflow', cls._rootBlock(analyzed))
        add('workflow', b('CLI ENTRY',
                          'Seeds the prompt (+ attached documents), runs the graph via',
                          'Runner, streams a [node]/[tool] trace, saves the result per the',
                          'Output node storage setting, and closes with a RUN SUMMARY',
                          '(time per node, total wall-clock, document location).'))
        add('workflow', cls._mainBlock(analyzed))
        return parts

    # ---------- A2A ----------

    def generateA2A(self, workflowId: int, userId: str | None = None) -> dict:
        """One A2A agent server per node plus an orchestrator (CompiledA2AEmit), with the agents-in-separate-files
        runtime each server imports. Code nodes and Start options are refused."""
        analyzed = self._analyzeWorkflow(workflowId, userId)
        CompiledA2AEmit.refuse(analyzed)
        docs = LangGraphPackage.startDocuments(analyzed.get('startDocuments') or [], self.startDocuments)
        analyzed['startDocuments'] = docs['docs']
        return self.a2aPackage(analyzed, docs['files'],
                               self.skillsRoot if self.skillsRoot is not None else LangGraphPackage.defaultSkillsRoot())

    @classmethod
    def a2aPackage(cls, analyzed: dict, documentFiles: list | None = None, skillsRoot: str | None = None) -> dict:
        """The A2A package of an analysis (no database)."""
        CompiledA2AEmit.refuse(analyzed)
        analyzed = dict(analyzed)
        analyzed['package'] = True
        runNodes = {nid: T._class__A2A_RUN_NODE for nid in CompiledA2AEmit.layout(analyzed)}
        root = skillsRoot if skillsRoot is not None else LangGraphPackage.defaultSkillsRoot()
        files = ADKPackage.files(analyzed, root, documentFiles or [], 'a2a')
        return CompiledArchitectureDoc.attach(CompiledA2AEmit.package(
            analyzed, cls.packageFiles(analyzed), runNodes, files,
            _safe_name(_php_lower(php_strval(analyzed['workflow']['name']))) + '_adk_a2a', 'Google ADK'),
            analyzed, 'adk', 'a2a')

    # ---------- package ----------

    def generatePackage(self, workflowId: int, userId: str | None = None) -> dict:
        """The compiled package: workflow.py, the run server (api.py, common.py), agents/, ADKPackage's files."""
        wf = self.workflowRepo.findById(workflowId)
        name = wf.getName() if wf else 'workflow'
        analyzed = self._analyzeWorkflow(workflowId, userId)
        analyzed['package'] = True
        docs = LangGraphPackage.startDocuments(analyzed.get('startDocuments') or [], self.startDocuments)
        analyzed['startDocuments'] = docs['docs']

        workflowPy, commonPy, agentFiles = self.packageFiles(analyzed)
        pkg = RunServerEmitter.package(
            {'code': workflowPy},
            name,
            'adk',
            'ADK run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            commonPy,
            True,   # api.py also runs the Start's cron / watch loop: POST /listen, GET /live
        )
        pkg['files'] = list(pkg['files']) + list(agentFiles) + ADKPackage.files(
            analyzed, self.skillsRoot if self.skillsRoot is not None else LangGraphPackage.defaultSkillsRoot(),
            docs['files'])
        return CompiledArchitectureDoc.attach(pkg, analyzed, 'adk', 'modular')

    @classmethod
    def packageFiles(cls, analyzed: dict) -> list:
        """Agents in separate files: [workflow.py, common.py, agents/ files]."""
        layout = CompiledRuntimeEmit.moduleLayout(analyzed)
        common: list = []
        nodes: dict = {}
        assembly: list = []
        for section, text in cls._parts(analyzed):
            if section == 'common':
                common.append(text)
            elif section.startswith('node:'):
                nodes[section[5:]] = text.rstrip('\n')
            elif section == 'workflow':
                assembly.append(text)
        wfName = json_encode(php_strval(analyzed['workflow']['name']), unicode=True)
        q = '"""'
        files = [{'path': 'agents/__init__.py', 'code': f"{q}The workflow's nodes, one module each (imported by workflow.py).{q}\n"}]
        imports = []
        for nid, text in nodes.items():
            m = layout.get(nid) or {'file': f'agents/node_{nid}.py', 'module': f'agents.node_{nid}', 'display': php_strval(nid)}
            display = m['display'].replace(q, "'''").replace('\n', ' ')
            files.append({'path': m['file'], 'code': f'{q}Node {nid} ({display}) of the workflow {wfName}: its ADK agent, node_{nid}.\n\n'
                          + f'Imported by workflow.py. To change the node, edit the workflow in the editor and re-generate.{q}\n'
                          + 'from common import *  # noqa: F401,F403 -- the runtime: model factory, tools, agent classes\n\n\n'
                          + text + '\n'})
            imports.append(f"from {m['module']} import node_{nid}  # {display}")
        workflow = (f'{q}Workflow {wfName} -- Google ADK, agents in separate files.\n\n'
                    + 'common.py holds the runtime, agents/ one module per node; this file assembles the nodes (dispatchers,\n'
                    + f'gates, root_agent) and runs them: run_workflow(), the Start\'s listener and the CLI.\n{q}\n'
                    + 'from common import *  # noqa: F401,F403 -- the runtime\n'
                    + '\n'.join(imports) + '\n\n\n'
                    + '\n'.join(assembly) + '\n')
        return [workflow, CompiledRuntimeEmit.packageCommonWithRuntime(common), files]

    # ---------- emit helpers ----------

    @classmethod
    def _headerBlock(cls, analyzed: dict) -> str:
        """The module docstring and every top-level import."""
        def esc(s: str) -> str:
            return s.replace('"""', "'''").replace('\\', '\\\\')
        name = esc(php_strval(analyzed['workflow']['name']))
        docBody = esc(PythonEmitHelpers.workflowDocBlock({
            'target': 'Google ADK (Python) -- LlmAgent per node, Sequential/Parallel layers',
            'dispatch_supported': True,
            'generated_at': analyzed.get('generated_at'),   # tests pin it; otherwise now
            'workflow': analyzed['workflow'],
            'nodes': cls._docNodes(analyzed),
            'edges': [[e['from'], e['to']] for e in _l(analyzed.get('edges'))],
            'layers': analyzed.get('layers') if analyzed.get('layers') is not None else [],
            'data_flow': T.dataFlowDoc__ret,
            'run': {
                'deps': [CompiledPackage.PIP_REQUIREMENTS] if analyzed.get('package')
                else ['# google-adk 2.3.x: SequentialAgent/ParallelAgent still supported',
                      CompiledPackage.pipInstall(analyzed, ADKPackage.TARGET)],
                'usage': 'python ' + ('workflow.py' if analyzed.get('package') else _filename(analyzed)) + ' "your prompt here"',
            },
            'storage': {'enabled': bool(analyzed.get('outputStorageEnabled')), 'folder': analyzed.get('outputFolder')},
        }))
        return f'''"""Standalone Google ADK workflow: {name}

{docBody}
"""
import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request
import httpx
from typing import Any

from dotenv import load_dotenv

# Provider keys and MCP headers come from .env: this folder's own first, then the runner's
# python/.env -- one level up for the single file in scripts/, two for the package in
# scripts/<folder>/. load_dotenv never overrides, so the nearest value wins.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):
    load_dotenv(os.path.join(_d, ".env"))
PACKAGE_DIR = _HERE   # this program's folder: code/, skills/, start_documents/ and outputs/ are relative to it

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, BaseAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.events import Event, EventActions
from google.genai import types

# Runtime "today" for date-grounding every agent instruction (evaluated at import).
_TODAY = time.strftime("%Y-%m-%d")


def _agent_instruction(prompt: str, parent_keys: list):
    """Return an ADK InstructionProvider (callable) for an agent node.

    A callable instruction makes ADK use the text VERBATIM
    (bypass_state_injection=True): a string instruction would be run through
    session-state templating, where every {{name}} is a placeholder and an
    unknown key raises KeyError -- so a prompt that says "Today is {{date}}"
    would crash the run. The parents' outputs are appended here from
    session.state (keys "node_<id>", written by each parent's output_key),
    which is what the {{node_<id>}} string placeholders used to do.
    """
    def _instr(ctx):
        text = ("Current date: " + _TODAY + ". Treat this as 'now'; "
                "prefer your tools for current data over memory.\\n\\n" + prompt)
        for key in parent_keys:
            text += "\\n\\n## Input from " + key + "\\n" + str(ctx.state.get(key, ""))
        return text
    return _instr'''

    @classmethod
    def codeParents(cls, analyzed: dict, id_: str, seen: dict | None = None) -> list:
        """A code node's inputs as [state_key, name, is_start]; a dispatcher parent stands for its own parents."""
        seen = seen or {}
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        out: list = []
        for p in _l(_d(analyzed.get('parents')).get(id_)):
            p = php_strval(p)
            node = _d(analyzed.get('byId')).get(p) or {}
            type_ = WorkflowGraphAnalyzer.typeOf(node)
            if type_ == 'start':
                out.append(['user_prompt', 'Start', True])
            elif p in menus:
                if p not in seen:
                    out += cls.codeParents(analyzed, p, {**seen, p: True})
            else:
                out.append(['node_' + p, CompiledRuntimeEmit.displayName(analyzed, p), False])
        return out

    @classmethod
    def codeInstancesEntries(cls, analyzed: dict) -> dict:
        """One entry per code node id (the package puts each in its own file)."""
        out: dict = {}
        for id_, cd in _d(analyzed.get('code')).items():
            id_ = php_strval(id_)
            parents = ['[' + py_str(p[0]) + ', ' + py_str(p[1]) + ', ' + ('True' if p[2] else 'False') + ']'
                       for p in cls.codeParents(analyzed, id_)]
            args = cd.get('args')
            out[id_] = (f"# Code node {id_} -- " + cd['display'].replace('\n', ' ').replace('"', "'") + '\n'
                        + f'node_{id_} = _CodeAgent(\n'
                        + f'    name="node_{id_}",\n'
                        + f'    node_id="{id_}",\n'
                        + '    display=' + py_str(cd['display']) + ',\n'
                        + ('    source_file=' + py_str(ADKPackage.codePath(analyzed, id_)) + ',\n'
                           if analyzed.get('package') else '    source=' + py_str(cd['source']) + ',\n')
                        + '    exits=' + json_to_python(cd['exits']) + ',\n'
                        + '    mcp_servers=' + json_to_python(cd['mcp_servers']) + ',\n'
                        + '    timeout_s=' + php_strval(cd['timeout_s']) + ',\n'
                        + '    args=' + json_to_python(obj(args if args is not None else [])) + ',\n'
                        + '    arg_decls=' + json_to_python(array_values(cd.get('arg_decls'))) + ',\n'
                        + '    parents=[' + ', '.join(parents) + '],\n'
                        + ')')
        return out

    @staticmethod
    def _conditionalNodes(analyzed: dict) -> dict:
        """The nodes downstream of a choice: a child of a code node with several exits, of a dispatcher's
        nested menu child, or of a node already downstream of one. Only these get a _Gate."""
        nested: dict = {}
        for targets in WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus'].values():
            for t in targets:
                if CompiledRuntimeEmit.menuNestable(analyzed, php_strval(t['id'])):
                    nested[php_strval(t['id'])] = True
        cond: dict = {}
        for n in _l(analyzed.get('order')):
            n = php_strval(n)
            for p in _l(_d(analyzed.get('parents')).get(n)):
                p = php_strval(p)
                if _count(_code_exits(analyzed, p)) > 1 or p in nested or p in cond:
                    cond[n] = True
                    break
        return cond

    @classmethod
    def gateRules(cls, analyzed: dict, id_: str):
        """A conditional node's _Gate rules [parent_key, route_key, exit], or None."""
        if id_ not in cls._conditionalNodes(analyzed):
            return None
        rules = []
        for p in _l(_d(analyzed.get('parents')).get(id_)):
            p = php_strval(p)
            if WorkflowGraphAnalyzer.typeOf(_d(analyzed.get('byId')).get(p) or {}) == 'start':
                rules.append(['user_prompt', '', ''])
            elif _count(_code_exits(analyzed, p)) > 1:
                for exit_, children in _d(analyzed['code'][p]['exit_targets']).items():
                    if id_ in [php_strval(c) for c in _l(children)]:
                        rules.append([f'node_{p}', f'route_{p}', php_strval(exit_)])
            else:
                rules.append([f'node_{p}', '', ''])
        return rules

    @classmethod
    def _needsGates(cls, analyzed: dict) -> bool:
        return cls._conditionalNodes(analyzed) != {}

    @staticmethod
    def skillRunnerBlockForTest() -> str:
        """Test seam: exposes skillRunnerBlock() output for unit testing."""
        return ADKGenerator._skillRunnerBlock()

    @staticmethod
    def _banner(title: str, *lines: str) -> str:
        """A boxed comment block naming a section and explaining it."""
        bar = '# ' + '=' * 62
        return '\n'.join([bar, '# ' + title] + ['# ' + l for l in lines] + [bar])

    @staticmethod
    def _skillRunnerBlock() -> str:
        """The ADK-specific async skill runner (after skillDepsBlock: SKILLS_DIR + _ensure_skill_deps)."""
        return T.skillRunnerBlock__py + T.skillRunnerBlock__ret

    @staticmethod
    def _docNodes(analyzed: dict) -> list:
        """Uniform node descriptors (shared documentation; see WorkflowGraphAnalyzer.docNodes)."""
        return PlaybookEmit.docNodes(analyzed)

    @classmethod
    def agentEntries(cls, analyzed: dict) -> dict:
        """One LlmAgent entry per agent node id (the package puts each in its own file)."""
        out: dict = {}
        docById = {dn['id']: dn for dn in cls._docNodes(analyzed)}
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        agents = _d(analyzed.get('agents'))
        codes = _d(analyzed.get('code'))
        for id_, ag in agents.items():
            ag = dict(ag)
            sid = php_strval(id_)
            instr = php_strval(ag['systemPrompt'])
            # DISPATCHER node: the prompt has to produce a ROUTE, not an answer.
            if sid in menus:
                names = [php_strval(t['name']) for t in menus[sid]]
                instr += ('\n\n## Dispatching\n\n'
                          + 'You are a DISPATCHER. Hand this request to EXACTLY ONE of these agents:\n\n'
                          + '  - ' + '\n  - '.join(names) + '\n\n'
                          + "Reply with the chosen agent's name ALONE on the first line, copied exactly "
                          + 'from the list above. Any notes for that agent go on the following lines. '
                          + 'Do not answer the request yourself.')

            # Parent outputs are read from session state by the instruction PROVIDER (_agent_instruction).
            agentParents = [p for p in _l(_d(analyzed.get('parents')).get(sid))
                            if php_strval(p) in agents or php_strval(p) in codes]
            parentKeysPy = '[' + ', '.join('"node_' + php_strval(p) + '"' for p in agentParents) + ']'

            skills = _l(ag.get('skills'))
            hasSkills = len(skills) > 0

            # Empty model = "platform default": resolve at generation time.
            defaults = _d(analyzed.get('providerDefaultModels'))
            provKey = php_strval(ag.get('provider') if ag.get('provider') is not None else 'claude').lower()
            canon = {'anthropic': 'claude', 'google': 'gemini'}.get(provKey, provKey)
            modelStr = php_strval(ag.get('model') if ag.get('model') is not None else '')
            if modelStr == '':
                v = defaults.get(canon) if defaults.get(canon) is not None else defaults.get(provKey)
                modelStr = php_strval(v if v is not None else '')
            ag['model'] = modelStr

            # Provider CONSTRAINT clamps (hard API rules; the emitted comment documents each one).
            thinking = ag.get('thinking')
            clampNotes = []
            temp = ag.get('temperature')
            if provKey == 'kimi' and modelStr.startswith('kimi-k2'):
                want = 1.0 if thinking == 'on' else 0.6
                if temp is not None and php_floatval(temp) != want:
                    clampNotes.append(f'temperature {php_strval(temp)} -> {php_strval(want)} (kimi-k2 '
                                      + ('thinking' if thinking == 'on' else 'non-thinking') + ' constraint)')
                    ag['temperature'] = want
            if (provKey == 'deepseek' and (modelStr.startswith('deepseek-v4') or modelStr.startswith('deepseek-flash'))
                    and thinking != 'off' and ag.get('temperature') is not None):
                clampNotes.append(f"temperature {php_strval(ag['temperature'])} dropped (deepseek-v4 thinking mode "
                                  + "rejects sampling params; set the node's Thinking attribute to Off to keep it)")
                ag['temperature'] = None
            if provKey in ('claude', 'anthropic') and ag.get('max_tokens') is not None and php_intval(ag['max_tokens']) > 16384:
                clampNotes.append(f"max_tokens {php_strval(ag['max_tokens'])} -> 16384 (anthropic non-streaming SDK limit)")
                ag['max_tokens'] = 16384

            # The main agent NEVER carries the skill tool.
            toolExprs = []
            for t in _l(ag.get('tools')):
                t = php_strval(t)
                if t.startswith('mcp_'):
                    t = t[4:]
                toolExprs.append('catalog["' + t + '"]')
            toolsPy = '[' + ', '.join(toolExprs) + ']'

            thinkPy = '"' + thinking + '"' if thinking in ('on', 'off') else 'None'
            model = '_make_model("' + php_strval(ag.get('provider')) + '", "' + ag['model'] + '", thinking=' + thinkPy + ')'
            agentVar = f'node_{sid}_agent' if hasSkills else f'node_{sid}'
            agentOutKey = agentVar

            def gen_config() -> str:
                kwargs = []
                if ag.get('temperature') is not None:
                    kwargs.append('temperature=' + json_encode(ag['temperature']))
                if ag.get('max_tokens') is not None:
                    kwargs.append('max_output_tokens=' + json_encode(ag['max_tokens']))
                return '    generate_content_config=types.GenerateContentConfig(' + ', '.join(kwargs) + '),\n'

            entry = (PythonEmitHelpers.nodeCommentBlock(docById[sid]) + '\n') if sid in docById else ''
            for cn in clampNotes:
                entry += f'# constraint clamp: {cn}\n'
            entry += f'{agentVar} = LlmAgent(\n'
            entry += f'    name="{agentVar}",\n'
            entry += f'    model={model},\n'
            entry += '    instruction=_agent_instruction(' + py_str(instr) + f', {parentKeysPy}),\n'
            entry += f'    tools={toolsPy},\n'
            if ag.get('temperature') is not None or ag.get('max_tokens') is not None:
                entry += gen_config()
            # CONTEXT ISOLATION: data flows between nodes ONLY through state.
            entry += "    include_contents='none',\n"
            entry += f'    output_key="{agentOutKey}",\n'
            entry += ')'

            if hasSkills:
                prev = f'node_{sid}_agent'
                subAgents = [f'node_{sid}_agent']
                for k, skill in enumerate(skills):
                    stepNo = k + 1
                    isLast = stepNo == len(skills)
                    llmVar = f'node_{sid}_skill_{stepNo}_llm'
                    capVar = f'node_{sid}_skill_{stepNo}'
                    stepOut = f'node_{sid}' if isLast else capVar
                    if skill.get('dir') is not None:
                        dir_ = _addslashes(php_strval(skill['dir']))
                        dirLiteral = f'"{dir_}"'
                        instrExpr = f'_skill_instruction("{dir_}", "{prev}")'
                        toolPy = f'[_make_skill_tool("{dir_}")]'
                    else:
                        dirLiteral = '""'
                        inlineMd = py_str(php_strval(skill.get('inline')))
                        instrExpr = f'_skill_instruction("", "{prev}", inline_md={inlineMd})'
                        toolPy = '[]'
                    entry += (f'\n\n# Skill step {stepNo} for node {sid}: LLM applies the skill; capture makes the node '
                              'output the produced deliverable (else the LLM text).\n')
                    entry += f'{llmVar} = LlmAgent(\n'
                    entry += f'    name="{llmVar}",\n'
                    entry += f'    model={model},\n'
                    entry += f'    instruction={instrExpr},\n'
                    entry += f'    tools={toolPy},\n'
                    if ag.get('temperature') is not None or ag.get('max_tokens') is not None:
                        entry += gen_config()
                    entry += "    include_contents='none',\n"
                    entry += f'    output_key="{llmVar}",\n'
                    entry += ')'
                    entry += (f'\n{capVar} = _SkillCaptureAgent(name="{capVar}", skill_dir={dirLiteral}, '
                              f'llm_key="{llmVar}", out_key="{stepOut}")')
                    subAgents += [llmVar, capVar]
                    prev = capVar
                subList = ', '.join(subAgents)
                entry += (f'\n\n# Node {sid}: agent then mandatory skill pipeline (LLM turn + capture per skill); '
                          'this is what the layering references.\n')
                entry += f'node_{sid} = SequentialAgent(\n    name="node_{sid}",\n    sub_agents=[{subList}],\n)'

            out[sid] = entry
        return out

    @classmethod
    def _agentsBlock(cls, analyzed: dict) -> str:
        return '\n\n'.join(cls.agentEntries(analyzed).values())

    @staticmethod
    def playbookInstancesEntries(analyzed: dict) -> dict:
        """One `node_<id> = _PlaybookAgent(...)` per playbook node."""
        out: dict = {}
        for pid, pd in _d(analyzed.get('playbooks')).items():
            pid = php_strval(pid)
            keys = []
            for p in _l(_d(analyzed.get('parents')).get(pid)):
                p = php_strval(p)
                # Only parents that actually write a state key can be read back.
                if p in _d(analyzed.get('agents')) or p in _d(analyzed.get('playbooks')) or p in _d(analyzed.get('code')):
                    keys.append('"node_' + p + '"')
            entry = f'# Playbook node {pid} -- ' + php_strval(pd['display']).replace('\n', ' ').replace('"', "'") + '\n'
            entry += f'node_{pid} = _PlaybookAgent(\n'
            entry += f'    name="node_{pid}",\n'
            entry += f'    node_id="{pid}",\n'
            entry += '    source_keys=[' + ', '.join(keys) + '],\n'
            entry += ')'
            out[pid] = entry
        return out

    @staticmethod
    def outputConsolidatorsEntries(analyzed: dict) -> dict:
        """Each output node as a non-LLM _PassThroughAgent forwarding its parent(s) output verbatim."""
        out: dict = {}
        for id_, node in _d(analyzed.get('byId')).items():
            id_ = php_strval(id_)
            if WorkflowGraphAnalyzer.typeOf(node) != 'output':
                continue
            keys = []
            took = PhpObj()
            for p in _l(_d(analyzed.get('parents')).get(id_)):
                keys.append('"node_' + php_strval(p) + '"')
                if _count(_code_exits(analyzed, p)) > 1:
                    exits = [php_strval(e) for e, children in _d(analyzed['code'][php_strval(p)]['exit_targets']).items()
                             if id_ in [php_strval(c) for c in _l(children)]]
                    took[f'node_{php_strval(p)}'] = [f'route_{php_strval(p)}', exits]
            keysPy = '[' + ', '.join(keys) + ']'
            tookPy = '' if not took else ', took=' + json_to_python(took)
            entry = f'# Output (fan-in) node {id_} -- forwards its parent(s) result verbatim (no LLM),\n'
            entry += '# so formatting such as HTML is preserved. Single parent = pass-through.\n'
            entry += f'node_{id_} = _PassThroughAgent(name="node_{id_}", source_keys={keysPy}{tookPy})'
            out[id_] = entry
        return out

    @classmethod
    def _outputConsolidatorsBlock(cls, analyzed: dict) -> str:
        return '\n\n'.join(cls.outputConsolidatorsEntries(analyzed).values())

    @staticmethod
    def _dispatcherInstancesBlock(analyzed: dict) -> str:
        """One `node_<id>__dispatch = _DispatcherAgent(...)` per dispatcher node; '' when none."""
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        if not menus:
            return ''
        out = []
        agents = _d(analyzed.get('agents'))
        codes = _d(analyzed.get('code'))
        for did, targets in menus.items():
            did = php_strval(did)
            entries = []
            subs = [f'node_{did}']
            for t in targets:
                cid = php_strval(t['id'])
                if not CompiledRuntimeEmit.menuNestable(analyzed, cid):
                    continue
                entries.append('[' + py_str(cid) + ', ' + py_str(php_strval(t['name'])) + ', ' + py_str(f'node_{cid}') + ']')
                subs.append(f'node_{cid}')
            if len(subs) < 2:
                continue   # nothing routable -- leave the node as a plain agent
            taskKeys = [p for p in _l(_d(analyzed.get('parents')).get(did))
                        if php_strval(p) in agents or php_strval(p) in codes]
            taskKeysPy = '[' + ', '.join('"node_' + php_strval(p) + '"' for p in taskKeys) + ']'
            entry = f'# DISPATCHER {did}: the chooser plus its menu. Only the child it names runs;\n'
            entry += '# the others are never scheduled (they are NOT in a layer of their own).\n'
            entry += f'node_{did}__dispatch = _DispatcherAgent(\n'
            entry += f'    name="node_{did}__dispatch",\n'
            entry += f'    route_key="node_{did}",\n'
            entry += f'    node_id="{did}",\n'
            entry += '    display=' + py_str(CompiledRuntimeEmit.displayName(analyzed, did)) + ',\n'
            dec = _d(analyzed.get('decisions')).get(did)
            if dec is not None:
                entry += '    routing_mode=' + py_str(dec['routing_mode']) + ',\n'
                entry += '    decision=' + ('[]' if not dec['decision'] else json_to_python(dec['decision'])) + ',\n'
                entry += '    decision_question=' + py_str(dec['decision_question']) + ',\n'
                entry += '    min_confidence=' + var_export_float(php_floatval(dec['min_confidence'])) + ',\n'
                entry += '    unclear_branch=' + py_str(dec['unclear_branch']) + ',\n'
            entry += f'    task_keys={taskKeysPy},\n'
            entry += '    menu=[' + ', '.join(entries) + '],\n'
            entry += '    sub_agents=[' + ', '.join(subs) + '],\n'
            entry += ')'
            out.append(entry)
        return '\n\n'.join(out)

    @classmethod
    def _rootBlock(cls, analyzed: dict) -> str:
        """root_agent = SequentialAgent(...) from the topological layers (ParallelAgent for a multi-node layer)."""
        byId = _d(analyzed.get('byId'))

        def isRunnable(id_: str) -> bool:
            return WorkflowGraphAnalyzer.typeOf(byId[id_]) in ('agent', 'agent-template', 'output', 'playbook', 'code')

        dispatch = WorkflowGraphAnalyzer.dispatchMenus(analyzed)
        nested: dict = {}
        for targets in dispatch['menus'].values():
            for t in targets:
                if CompiledRuntimeEmit.menuNestable(analyzed, php_strval(t['id'])):
                    nested[php_strval(t['id'])] = True
        layerExprs = []
        layers = analyzed['layers']
        for k, layer in (layers.items() if isinstance(layers, dict) else enumerate(layers)):
            vars_ = []
            for id_ in layer:
                id_ = php_strval(id_)
                if id_ in nested:
                    continue
                if isRunnable(id_):
                    var = f'node_{id_}__dispatch' if id_ in dispatch['menus'] else f'node_{id_}'
                    rules = cls.gateRules(analyzed, id_)
                    if rules is not None:
                        when = '[' + ', '.join('[' + ', '.join(py_str(x) for x in r) + ']' for r in rules) + ']'
                        var = f'_Gate(name="gate_{id_}", when={when}, sub_agents=[{var}])'
                    vars_.append(var)
            if not vars_:
                continue
            if len(vars_) == 1:
                layerExprs.append(vars_[0])
            else:
                layerExprs.append(f'ParallelAgent(name="layer_{k}", sub_agents=[' + ', '.join(vars_) + '])')
        body = ',\n    '.join(layerExprs)
        return (f'root_agent = SequentialAgent(\n    name="workflow",\n    sub_agents=[\n    {body}\n    ],\n)\n'
                + '_attach_recording(root_agent)   # run events for every recorded node (see RUN EVENTS)')

    @staticmethod
    def _mainBlock(analyzed: dict) -> str:
        """async def run_workflow(...) and the CLI entry (or, in a package, the listener)."""
        sp = py_str(analyzed['startPrompt'])
        name = py_str(analyzed['workflow']['name'])
        outRoot = ('os.path.join(PACKAGE_DIR, "outputs")' if analyzed.get('package')
                   else 'os.path.expanduser("~/Documents/synergyAI/outputs")')
        wfId = php_intval(analyzed['workflow'].get('id') or 0)
        storageEnabled = 'True' if analyzed.get('outputStorageEnabled') else 'False'
        folder = analyzed.get('outputFolder')
        folderPy = py_str(php_strval(folder)) if folder is not None and folder != '' else 'None'
        nodeNames: dict = {}
        for nid, ag in _d(analyzed.get('agents')).items():
            nodeNames[php_strval(nid)] = php_strval(ag.get('name') if ag.get('name') is not None else 'node ' + php_strval(nid))
        for nid, cd in _d(analyzed.get('code')).items():
            nodeNames[php_strval(nid)] = php_strval(cd['display'])
        for nid, pd in _d(analyzed.get('playbooks')).items():
            nodeNames[php_strval(nid)] = php_strval(pd['display'])
        outputIds = [php_strval(nid) for nid, node in _d(analyzed.get('byId')).items()
                     if WorkflowGraphAnalyzer.typeOf(node) == 'output']
        outputIdsPy = json_to_python(outputIds)
        # A dict even when empty (a workflow with no agent node).
        nodeNamesPy = '{}' if not nodeNames else json_to_python(nodeNames)
        dw = analyzed.get('defaultWatch')
        cron = analyzed.get('defaultCron')
        startMode = analyzed.get('startMode')
        return (
            f'WORKFLOW_NAME = {name}\n'
            f'WORKFLOW_ID = {wfId}\n'
            'START_MODE = ' + py_str(php_strval(startMode if startMode is not None else 'prompt')) + '\n'
            'DEFAULT_CRON = ' + ('None' if cron is None else py_str(php_strval(cron))) + '\n'
            'DEFAULT_WATCH = ' + ('None' if dw is None
                                  else json_to_python({'server': dw['server'], 'tool': dw['tool'], 'args': obj(dw['args'])})) + '\n'
            f'DEFAULT_PROMPT = {sp}\n'
            f'OUTPUT_STORAGE_ENABLED = {storageEnabled}\n'
            f'OUTPUT_FOLDER = {folderPy}\n'
            f'NODE_NAMES = {nodeNamesPy}  # node id -> human name (for readable logs)\n'
            f'OUTPUT_IDS = {outputIdsPy}  # the Output nodes: named "Output" in the logs, not timed in the summary\n'
            + _MAIN_BODY
            + (CompiledRuntimeEmit.packageListenBlock() if analyzed.get('package') else
               _CLI_HEAD + sp + _CLI_MID + outRoot + _CLI_TAIL)
        )

    @staticmethod
    def _adkToolBuilderBlock(analyzed: dict) -> str:
        """One concrete typed _tool_<name> function per catalog entry, and build_tools_from_catalog()."""
        functions = []
        catalogEntries = []
        for toolName, spec in _d(analyzed.get('usedCatalog')).items():
            toolName = php_strval(toolName)
            description = php_strval(spec.get('description') if spec.get('description') is not None else toolName)
            inputSchema = spec.get('input_schema') if isinstance(spec.get('input_schema'), dict) else {}
            properties = inputSchema.get('properties') if isinstance(inputSchema.get('properties'), dict) else {}
            required = inputSchema.get('required')
            required = _l(required) if isinstance(required, (list, dict)) else []
            serverUrl = php_strval(spec.get('server_url') if spec.get('server_url') is not None else '')

            safeName = re.sub(r'[^A-Za-z0-9_]', '_', toolName)
            if re.match(r'[0-9]', safeName):
                safeName = '_' + safeName
            fnName = '_tool_' + safeName

            requiredSet = {php_strval(r) for r in required}

            validRequired: dict = {}
            validOptional: dict = {}
            hasExtra = False
            for pname in required:
                pname = php_strval(pname)
                if pname not in properties:
                    continue
                if _IDENT.fullmatch(pname) and pname not in _PY_KEYWORDS:
                    validRequired[pname] = properties[pname] if isinstance(properties[pname], dict) else {}
                else:
                    hasExtra = True
            for pname, pspec in properties.items():
                pname = php_strval(pname)
                if pname in requiredSet:
                    continue
                if _IDENT.fullmatch(pname) and pname not in _PY_KEYWORDS:
                    validOptional[pname] = pspec if isinstance(pspec, dict) else {}
                else:
                    hasExtra = True

            params = []
            for pname, pspec in validRequired.items():
                params.append(f"{pname}: {_TYPE_MAP.get(php_strval(pspec.get('type')) if pspec.get('type') is not None else '', 'str')}")
            for pname, pspec in validOptional.items():
                params.append(f"{pname}: {_TYPE_MAP.get(php_strval(pspec.get('type')) if pspec.get('type') is not None else '', 'str')} = None")
            if hasExtra:
                params.append('**extra')
            paramStr = ', '.join(params)
            allValidProps = {**validRequired, **validOptional}

            safeDesc = description.replace('"""', '\\"\\"\\"')
            doc = f'    """{safeDesc}'
            if allValidProps:
                doc += '\n\n    Args:'
                for pname, pspec in allValidProps.items():
                    pDesc = php_strval(pspec.get('description') if pspec.get('description') is not None else '')
                    doc += f'\n        {pname}: {pDesc}'
            doc += '\n    """'

            pyUrl = py_str(serverUrl)
            pyName = py_str(toolName)
            if allValidProps or hasExtra:
                argPairs = [f'"{pname}": {pname}' for pname in allValidProps]
                if hasExtra:
                    argDict = '{**{' + ', '.join(argPairs) + '}, **extra}'
                else:
                    argDict = '{' + ', '.join(argPairs) + '}'
                body = f'    _args = {{k: v for k, v in {argDict}.items() if v is not None}}\n'
                body += f'    return _call_mcp_tool({pyUrl}, {pyName}, _args)'
            else:
                body = f'    return _call_mcp_tool({pyUrl}, {pyName}, {{}})'
            functions.append(f'def {fnName}({paramStr}) -> str:\n{doc}\n{body}')
            catalogEntries.append(f'        {py_str(toolName)}: FunctionTool({fnName})')

        out = ''
        if functions:
            out += '\n\n'.join(functions) + '\n\n'
        if catalogEntries:
            out += 'def build_tools_from_catalog() -> dict:\n'
            out += '    return {\n'
            out += ',\n'.join(catalogEntries) + ',\n'
            out += '    }'
        else:
            out += 'def build_tools_from_catalog() -> dict:\n'
            out += '    return {}'
        return out


_MAIN_BODY = (
    '\n'
    'async def run_workflow(prompt: str, session: str | None = None) -> str:\n'
    '    if START_DOCUMENTS:\n'
    '        doc_parts = []\n'
    '        for doc in START_DOCUMENTS:\n'
    '            name = doc.get("name", "Document")\n'
    '            path = doc.get("path", "")\n'
    '            if path and not os.path.isabs(path):\n'
    '                path = os.path.join(PACKAGE_DIR, path)   # start_documents/ in the package\n'
    '            if not path:\n'
    '                doc_parts.append(f"### {name}\\n\\n_(no path on attachment record)_")\n'
    '                continue\n'
    '            try:\n'
    '                md = _convert_doc_to_markdown(path)\n'
    '                doc_parts.append(f"### {name}\\n\\n{md}")\n'
    '            except Exception as e:\n'
    '                doc_parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")\n'
    '        if doc_parts:\n'
    '            prompt = (\n'
    '                "## Attached Documents\\n\\n"\n'
    '                + "\\n\\n---\\n\\n".join(doc_parts)\n'
    '                + "\\n\\n---\\n\\n"\n'
    '                + prompt\n'
    '            )\n'
    '    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)\n'
    '    print(f"[workflow] prompt: {prompt[:200]!r}", flush=True)\n'
    '    session_service = InMemorySessionService()\n'
    '    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)\n'
    '    adk_session = await session_service.create_session(app_name="workflow", user_id="local", state={"user_prompt": prompt})\n'
    '    _run_reset()\n'
    '    if START_NODE:\n'
    '        _rec_node_start(START_NODE[0], START_NODE[1], "start")\n'
    '        _rec_node_complete(START_NODE[0], START_NODE[1], "start", output=prompt)\n'
    '    outputs = {}   # the Output nodes\' answers (the workflow\'s answer, when it has Output nodes)\n'
    '    final = ""\n'
    '    t0 = time.monotonic()\n'
    '    seen = set()\n'
    '    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY\n'
    '    content = types.Content(role="user", parts=[types.Part(text=prompt)])\n'
    '    try:\n'
    '        async for event in runner.run_async(user_id="local", session_id=adk_session.id, new_message=content):\n'
    '            author = getattr(event, "author", "?")\n'
    '            if isinstance(author, str) and author.startswith("node_"):\n'
    '                _nk = author.split("_")[1] if "_" in author else author\n'
    '                _t_first.setdefault(_nk, time.monotonic())\n'
    '                _t_last[_nk] = time.monotonic()\n'
    '            if author and author not in seen:\n'
    '                seen.add(author)\n'
    '                if isinstance(author, str) and author.startswith("node_"):\n'
    '                    _ap = author.split("_")\n'
    '                    _nid = _ap[1] if len(_ap) > 1 else author\n'
    '                    _kind = "skill step" if "skill" in author else "node"\n'
    '                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, \'Output\' if _nid in OUTPUT_IDS else _nid)!r} \\u2192 {_kind} active", flush=True)\n'
    '                else:\n'
    '                    print(f"[node] > {author}", flush=True)\n'
    '            parts = (event.content.parts if event.content else None) or []\n'
    '            for p in parts:\n'
    '                fc = getattr(p, "function_call", None)\n'
    '                fr = getattr(p, "function_response", None)\n'
    '                if fc is not None:\n'
    '                    _a = str(getattr(fc, "args", ""))[:200]\n'
    '                    print(f"[tool] -> {fc.name}({_a})", flush=True)\n'
    '                elif fr is not None:\n'
    '                    _r = str(getattr(fr, "response", ""))[:200]\n'
    '                    print(f"[tool] <- {fr.name}: {_r}", flush=True)\n'
    '                else:\n'
    '                    txt = (getattr(p, "text", None) or "").strip()\n'
    '                    if txt:\n'
    '                        print(f"[{author}] {txt[:240]}", flush=True)\n'
    '            if event.is_final_response() and event.content and event.content.parts:\n'
    '                final = event.content.parts[0].text or final\n'
    '                if author in OUTPUT_NODE_KEYS:\n'
    '                    outputs[author] = event.content.parts[0].text or ""\n'
    '        if OUTPUT_NODE_KEYS:   # the answer is what the Output nodes gave: none ran (nothing to do) = ""\n'
    '            final = "\\n\\n---\\n\\n".join(v for v in outputs.values() if v)\n'
    '        final = final or _RUN["unrouted"]   # nothing reached the Output: why the dispatcher did not route\n'
    '        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)\n'
    '    except Exception as e:\n'
    '        for _nid, (_name, _type) in list(_RUN["open"].items()):   # a node that failed mid-run ends as failed\n'
    '            _rec_node_complete(_nid, _name, _type, success=False, error=f"{type(e).__name__}: {e}")\n'
    '        print("[workflow] ERROR:", flush=True)\n'
    '        traceback.print_exc()\n'
    '        raise\n'
    '    print(final)\n'
    '    # Closing RUN SUMMARY (printed LAST): time per node, total wall-clock.\n'
    '    # Where the document was saved is NOT part of this block: saving belongs\n'
    '    # to __main__ (see below), so the CLI entry prints that line itself right\n'
    '    # after this one.\n'
    '    print("\\n" + "=" * 74, flush=True)\n'
    '    print("RUN SUMMARY", flush=True)\n'
    '    print("-" * 74, flush=True)\n'
    '    # Only named agent nodes (skip output pass-throughs: ~0s, no display name).\n'
    '    _durs = {NODE_NAMES[k]: _t_last[k] - _t_first[k] for k in _t_first if k in _t_last and k in NODE_NAMES}\n'
    '    if _durs:\n'
    '        _w = max(len(n) for n in _durs)\n'
    '        print("  Time per node:", flush=True)\n'
    '        for _n, _s in sorted(_durs.items(), key=lambda kv: -kv[1]):\n'
    '            print(f"    {_n:<{_w}}   {_s:7.1f}s", flush=True)\n'
    '    print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)\n'
    '    print(f"  Final output: {len(final)} chars", flush=True)\n'
    '    print("=" * 74, flush=True)\n'
    '    return final\n'
    '\n'
    '# ============================== CLI ENTRY =================================\n'
    '# Extracting the deliverable and saving it both live HERE, not in\n'
    '# run_workflow(): the run server calls run_workflow() once per\n'
    '# conversational turn, and a turn must not write a file per prompt.\n'
    '# run_workflow() returns the answer UN-STRIPPED for the same reason --\n'
    '# the editor runs this same extraction on what it receives, so narration\n'
    '# wrapped around a document (or a second document, which the non-greedy\n'
    '# regex would discard) must still be there when the answer arrives.\n'
)

_CLI_HEAD = (
    'if __name__ == "__main__":\n'
    '    # argparse would fight the prompt\'s own spaces; the runner\n'
    '    # passes it space-split; sys.argv[1] alone would keep only the first word.\n'
    '    _text = asyncio.run(run_workflow(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else '
)
_CLI_MID = (
    '))\n'
    '    # Honour the Output node\'s storage setting: when ON, persist the final result\n'
    '    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,\n'
    '    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow\'s custom folder; when OFF, skip.\n'
    '    _saved_path = None\n'
    '    if OUTPUT_STORAGE_ENABLED:\n'
    '        import re as _re\n'
    '        _mm = _re.search(r"(?is)<!doctype html.*?</html\\s*>", _text) or _re.search(r"(?is)<html[\\s>].*?</html\\s*>", _text)\n'
    '        if _mm:\n'
    '            _text = _mm.group(0)  # strip narration/fences around a full HTML doc\n'
    '            _ext = "html"\n'
    '        else:\n'
    '            _ext = "md"\n'
    '        _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"\n'
    '        _ts = time.strftime("%Y%m%d-%H%M%S")\n'
    '        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or '
)
_CLI_TAIL = (
    '\n'
    '        if OUTPUT_FOLDER:\n'
    '            _cf = os.path.expanduser(OUTPUT_FOLDER)\n'
    '            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)\n'
    '        else:\n'
    '            _save_dir = os.path.join(_root, "workflow")\n'
    '        os.makedirs(_save_dir, exist_ok=True)\n'
    '        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")\n'
    '        with open(_out, "w", encoding="utf-8") as _f:\n'
    '            _f.write(_text)\n'
    '        _saved_path = os.path.abspath(_out)\n'
    '    if _saved_path:\n'
    '        print(f"  Document saved to: {_saved_path}", flush=True)\n'
    '    else:\n'
    '        print("  Document not saved (output storage is OFF in the workflow settings) -- "\n'
    '              "the output is printed above.", flush=True)'
)
