"""Port of backend/src/AgentTeam/Services/NOOAGenerator.php -- the NVIDIA OO Agents (NOOA) compiler.

Compiles a workflow DSL into a self-contained NOOA Python program. Fourth backend beside LangGraphGenerator /
ADKGenerator / MAFGenerator; reuses WorkflowGraphAnalyzer + PythonEmitHelpers and the shared Compiled* emitters.

NOOA (github.com/NVIDIA-NeMo/labs-OO-Agents, PyPI `nooa`) has no graph orchestration API -- agents are plain
Python classes and orchestration is ordinary asyncio code. The compiled file therefore emits:
  - one `class <Node>(Agent, llm=make_llm(...))` per editor agent node (class docstring = the node's system
    prompt, one respond() generation method the LLM fulfils via NOOA's CodeAct strategy),
  - MCP servers attached natively via nooa.mcp.MCPManager (streamable-http),
  - mandatory skill post-steps on the shared _run_skill_script machinery,
  - a driver that walks the topological layers, with asyncio.gather for the nodes of a layer the run reached
    and a verbatim text merge for the Output node (fan-in).

The emitted bytes are PHP's for the same inputs (tests/unit/test_compiled_targets_differential.py compiles the
fixtures with both and compares); the PHP nowdocs are imported from compiler_text/nooa_generator.py.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from app.agent_team.services.compiled_architecture_doc import CompiledArchitectureDoc
from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_php import PhpObj, json_encode, json_to_python, obj, py_str
from app.agent_team.services.compiler_text import nooa_generator as T
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_floatval, php_intval, php_strval

_SLUG = re.compile(r'[^a-z0-9_]+', re.IGNORECASE | re.ASCII)


def _first(*values):
    """`$a ?? $b ?? ...`: the first value that is not None."""
    for v in values:
        if v is not None:
            return v
    return None


def _name_slug(name) -> str:
    return _SLUG.sub('_', php_strval(name))


def _temp(ag: dict) -> str:
    """`$ag['temperature'] !== null ? json_encode((float) $ag['temperature']) : json_encode(0.7)`."""
    t = ag.get('temperature')
    return json_encode(php_floatval(t)) if t is not None else json_encode(0.7)


def _think(ag: dict) -> str:
    th = ag.get('thinking')
    return py_str(php_strval(th)) if th in ('on', 'off') else 'None'


def _max_tokens(ag: dict) -> int:
    return php_intval(_first(ag.get('max_tokens'), 4096)) or 4096


class NOOAGenerator:
    """The package's framework requirements (CompiledPackage adds the MCP client, .env and the run server)."""
    FRAMEWORK = ['nooa']

    def __init__(self, db, workflowRepo, graphRepo, agentRepo, skillsRoot: str | None = None, startDocuments=None):
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo
        self.skillsRoot = skillsRoot              # the package copies the used skills from here
        self.startDocuments = startDocuments      # the package copies the Start's documents from here

    def generate(self, workflowId: int, userId: str | None = None) -> dict:
        analyzed = self._analyzeWorkflow(workflowId, userId)
        name = _name_slug(analyzed['workflow']['name'])
        return CompiledArchitectureDoc.attach({
            'filename': name.lower() + '_nooa.py',
            'code': self.emitNooa(analyzed),
        }, analyzed, 'nooa', 'single')

    def _analyzeWorkflow(self, workflowId: int, userId: str | None) -> dict:
        """Everything emitNooa() needs, read from the database at compile time (the program never reads it)."""
        # A swarm is a different architecture, not a packaging choice. NOOA is excluded: at 0.0.8 it has no
        # multi-agent primitives to build one from (spec §9).
        wfForArch = self.workflowRepo.findById(workflowId)
        if wfForArch and wfForArch.getOrchestration() == 'swarm':
            raise RuntimeError(
                'This workflow is set to swarm orchestration, which NOOA cannot compile. '
                'Compile it with LangGraph, or switch the workflow to "workflow" orchestration.'
            )
        analyzer = WorkflowGraphAnalyzer(self.db, self.workflowRepo, self.graphRepo, self.agentRepo)
        analyzed = analyzer.analyze(workflowId, userId)

        # Platform default model per provider (system_llm_settings): the analyzer does NOT alias
        # 'anthropic'->'claude' or 'google'->'gemini', so a node saved with the alias provider stays empty.
        defaults: dict = {}
        try:
            for row in self.db.fetch_all('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1'):
                if not php_empty(row.get('model')):
                    defaults[php_strval(row.get('provider_key')).lower()] = php_strval(row.get('model'))
        except Exception as e:  # noqa: BLE001
            error_log('[NOOAGenerator] could not load provider default models: ' + str(e))
        for id_, ag in analyzed['agents'].items():
            if php_strval(_first(ag.get('model'), '')) == '':
                prov = php_strval(_first(ag.get('provider'), 'claude')).lower()
                canon = {'anthropic': 'claude', 'google': 'gemini'}.get(prov, prov)
                analyzed['agents'][id_]['model'] = php_strval(_first(defaults.get(canon), defaults.get(prov), ''))

        # Playbook nodes: resolved ONCE here (the #Action bindings need the MCP catalog and the analyzer).
        analyzed['playbooks'] = {}
        for pid, pnode in (analyzed.get('byId') or {}).items():
            if WorkflowGraphAnalyzer.typeOf(pnode) != 'playbook':
                continue
            PlaybookEmit.refuseLangGraphOnly(pnode, self.graphRepo.getGraph(workflowId).get('edges') or [])
            analyzed['playbooks'][php_strval(pid)] = PlaybookEmit.nodeData(
                pnode, analyzer.availableToolsById(userId), defaults, userId)

        # Code nodes, MCP server slugs (headers), decision routing, the Start's mode: CompiledRuntimeEmit's rules.
        return CompiledRuntimeEmit.analyzeRuntime(analyzed, analyzer, self.db, self.agentRepo,
                                                  self.graphRepo.getGraph(workflowId), workflowId, userId)

    def generateA2A(self, workflowId: int, userId: str | None = None) -> dict:
        """A2A: one A2A agent server per node plus an orchestrator -- LangGraph's A2A design (CompiledA2AEmit)."""
        analyzed = self._analyzeWorkflow(workflowId, userId)
        CompiledA2AEmit.refuse(analyzed)
        docs = LangGraphPackage.startDocuments(analyzed.get('startDocuments') or [], self.startDocuments)
        analyzed['startDocuments'] = docs['docs']
        return self.a2aPackage(analyzed, docs['files'],
                               self.skillsRoot if self.skillsRoot is not None else LangGraphPackage.defaultSkillsRoot())

    @classmethod
    def a2aPackage(cls, analyzed: dict, documentFiles: list | None = None, skillsRoot: str | None = None) -> dict:
        """The A2A package of an analysis (no database): servers/, orchestrator.py, api.py, the runtime, the package files."""
        CompiledA2AEmit.refuse(analyzed)
        analyzed = dict(analyzed)
        analyzed['package'] = True
        runNodes = {k: T._class__A2A_RUN_NODE for k in CompiledA2AEmit.layout(analyzed)}
        files = CompiledPackage.files(analyzed, skillsRoot if skillsRoot is not None else LangGraphPackage.defaultSkillsRoot(),
                                      documentFiles or [], cls.FRAMEWORK + ['a2a-sdk[http-server]>=1.1,<2'],
                                      'NVIDIA NOOA (A2A)')
        return CompiledArchitectureDoc.attach(CompiledA2AEmit.package(
            analyzed, cls.packageFiles(analyzed), runNodes, files,
            _name_slug(php_strval(analyzed['workflow']['name']).lower()) + '_nooa_a2a', 'NVIDIA NOOA'),
            analyzed, 'nooa', 'a2a')

    def generatePackage(self, workflowId: int, userId: str | None = None) -> dict:
        """The compiled package: the same script, plus the run server that makes it conversational."""
        wf = self.workflowRepo.findById(workflowId)
        name = wf.getName() if wf else 'workflow'

        analyzed = self._analyzeWorkflow(workflowId, userId)
        analyzed['package'] = True
        docs = LangGraphPackage.startDocuments(analyzed.get('startDocuments') or [], self.startDocuments)
        analyzed['startDocuments'] = docs['docs']
        workflowPy, commonPy, nodeFiles = self.packageFiles(analyzed)
        pkg = RunServerEmitter.package(
            {'code': workflowPy},
            name,
            'nooa',
            'NOOA run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            commonPy,
            True,   # api.py also runs the Start's cron / watch loop: POST /listen, GET /live
        )
        pkg['files'] = pkg['files'] + nodeFiles + CompiledPackage.files(
            analyzed, self.skillsRoot if self.skillsRoot is not None else LangGraphPackage.defaultSkillsRoot(),
            docs['files'], self.FRAMEWORK, 'NVIDIA NOOA')
        return CompiledArchitectureDoc.attach(pkg, analyzed, 'nooa', 'modular')

    @classmethod
    def emitNooa(cls, analyzed: dict) -> str:
        common, workflow = cls._nooaParts(analyzed)
        return '\n\n'.join(common + workflow) + '\n'

    @classmethod
    def _nooaParts(cls, analyzed: dict) -> tuple:
        """The script as [runtime parts, assembly parts]: the package's common.py and workflow.py, in the single file's order."""
        hasMcp = not php_empty(analyzed.get('usedCatalog'))
        hasSkills = any(not php_empty(ag.get('skills')) for ag in analyzed['agents'].values())
        hasDocs = not php_empty(analyzed.get('startDocuments'))
        banner = cls._banner
        hasMenus = bool(WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus'])

        parts = [cls._headerBlock(analyzed, hasMcp)]
        parts.append(banner('PROVIDER CLIENT FACTORY',
                            'make_llm() builds the NOOA UnifiedLLM client (litellm routing) for',
                            'each agent node. Every provider-specific detail lives here:',
                            'endpoints, credential env vars, and the hard API constraints',
                            '(kimi/deepseek/glm sampling rules). The node form Thinking',
                            'attribute is honored here. To support a new provider: add it to',
                            'OPENAI_COMPATIBLE (or a dedicated branch in make_llm).'))
        parts.append(T.llmFactoryBlock__ret)
        if hasMcp or not php_empty(analyzed.get('code')) or not php_empty(analyzed.get('playbooks')) \
                or not php_empty(analyzed.get('package')):
            parts.append(banner('MCP CLIENT',
                                'HTTP JSON-RPC client for the code nodes, playbook #Actions and the',
                                'event trigger, and each server\'s headers / URL from .env',
                                '(MCP_HEADERS_<SLUG>, MCP_URL_<SLUG>), which the agents\' native',
                                'MCP connections below use too.'))
            parts.append(CompiledRuntimeEmit.mcpClientBlock(analyzed))
        if hasMcp:
            parts.append(banner('MCP SERVERS (native NOOA integration)',
                                'One MCPManager.create_from_server per server used by any node,',
                                'baked at generation time from the workflow editor config.',
                                'The returned object exposes every server tool as a method;',
                                'agent classes attach it as a class attribute (tools via self).',
                                'If a server moves, update the URL here.'))
            parts.append(cls._mcpBlock(analyzed))
        if hasDocs:
            parts.append(banner('DOCUMENT CONVERTER',
                                'Turns a start-node attachment into markdown for the prompt.'))
            parts.append(PythonEmitHelpers.documentConverterBlock())
        if hasSkills:
            parts.append(banner('SKILL RUNTIME',
                                'Runs folder-backed skills (SKILL.md + scripts) as mandatory',
                                'post-agent steps. Single-phase by design: NOOA\'s CodeAct',
                                'strategy lets the model stage content and run scripts from',
                                'generated code, so the two-phase author/stage/render split the',
                                'MAF target needs is unnecessary here. A failed step degrades',
                                'to "skill skipped" — it can never destroy the node output.'))
            parts.append(PythonEmitHelpers.skillDepsBlock())
            parts.append(cls._skillBlock())
        parts.append(banner('PROGRESS REPORTING',
                            'Console liveness: run banner, per-node start/done lines, a 15s',
                            'heartbeat naming in-flight nodes, and the closing RUN SUMMARY.'))
        parts.append(T.progressBlock__ret)
        parts.append(banner('AGENT NODE CLASSES + FROZEN METADATA',
                            'One NOOA Agent class per editor node: the class docstring IS the',
                            'node\'s system prompt (verbatim from the form), respond() is the',
                            'generation method the LLM fulfils. AGENTS maps node id -> class +',
                            'the form\'s sampling settings and bound skills. To change a node:',
                            'edit the workflow in the editor and re-generate.'))
        parts.append(cls._agentsBlock(analyzed, hasMcp))
        parts.append(banner('NODE RUNNER',
                            'run_agent(): frames the node input (original request + labelled',
                            'parent outputs, date-grounded), runs the node class, then applies',
                            'each bound skill as a MANDATORY post-step.'))
        parts.append(cls._runnerBlock(hasSkills))
        if hasMenus:
            parts.append(banner('DISPATCHER',
                                'run_dispatcher(): a dispatcher node\'s outgoing edges are a MENU,',
                                'not a fan-out. The node names ONE child; only that child runs,',
                                'and it receives the incoming task plus the dispatcher\'s notes.'))
            parts.append(T.dispatcherBlock__ret)
        if not php_empty(analyzed.get('playbooks')):
            parts.append(banner('PLAYBOOK NODES',
                                'A playbook node is an interpreter, not an agent: the model',
                                're-decides each round from the running transcript, with the',
                                'native verbs, the human gates, one tool per bound #Action and',
                                'a stub per unbound one. The node output is that transcript.'))
            parts.append(PlaybookEmit.supportBlock(False))   # _call_mcp_tool: the MCP client above
            parts.append(PlaybookEmit.runtimeBlock())
            parts.append('PLAYBOOKS = {}   # node id -> playbook, filled by workflow.py from agents/'
                         if not php_empty(analyzed.get('split')) else PlaybookEmit.metadataBlock(analyzed['playbooks']))
        if not php_empty(analyzed.get('code')):
            parts.append(banner('CODE NODES',
                                'A code node runs its own Python run(input, call_tool) through the',
                                'harness the workflow editor runs (CODE_HARNESS, a copy): no model.',
                                'CODE_NODES: each node\'s exits, MCP servers, timeout and code.'))
            parts.append(CompiledRuntimeEmit.codeHarnessBlock(not php_empty(analyzed.get('package'))))
            parts.append(CompiledRuntimeEmit.codeNodesLiteral(analyzed))
        if hasMenus:
            parts.append(banner('DECISION-MODEL ROUTING',
                                'A dispatcher whose routing names a decision model (Jev...) asks it',
                                'and runs the child it names: no LLM turn. The adapters are the',
                                'LangGraph target\'s, copied. DECISIONS: each dispatcher\'s settings.'))
            parts.append(CompiledRuntimeEmit.decisionBlock(analyzed))
        parts.append(banner('RUN EVENTS',
                            'Each node\'s start and completion (a code node\'s exit, a',
                            'dispatcher\'s route) go to GRAPH_RECORDER when the package\'s',
                            'listener set one: runs/ and GET /live, the editor\'s live canvas.'))
        parts.append(CompiledRuntimeEmit.recordingBlock(analyzed) + '\n\n\n' + CompiledRuntimeEmit.idRecordingHelpers())
        parts.append(banner('WORKFLOW GLOBALS',
                            'Identity + the Start node prompt baked as DEFAULT_PROMPT',
                            '(CLI args override it) + output storage settings.'))
        parts.append(cls._globalsBlock(analyzed))
        workflowFrom = len(parts)   # from here on: the assembly (workflow.py in the package)
        parts.append(banner('DRIVER',
                            'GRAPH is the editor canvas as data: each node\'s kind and parents,',
                            'and the topological layers. run_workflow() walks the layers; the',
                            'nodes of a layer that the run reached run together (asyncio.gather).',
                            'A node is reached when a parent ran and, for a routing parent (a',
                            'dispatcher, a code node with several exits), its choice leads here.',
                            'The Output node merges what reached it verbatim (no model pass).'))
        parts.append(cls._mainBlock(analyzed, hasDocs))
        parts.append(CompiledRuntimeEmit.packageListenBlock(T.nooaParts__ret)
                     if not php_empty(analyzed.get('package')) else T.entryBlock__ret)
        return parts[:workflowFrom], parts[workflowFrom:]

    @classmethod
    def packageFiles(cls, analyzed: dict) -> list:
        """Agents in separate files: [workflow.py, common.py, agents/ files]. agents/<name>.py holds one node's
        NOOA Agent class (its prompt is the docstring) and its AGENTS entry, or its code / decision / playbook
        entry; common.py the runtime with empty tables; workflow.py fills them, then GRAPH and the driver."""
        analyzed = dict(analyzed)
        analyzed['split'] = True
        common, assembly = cls._nooaParts(analyzed)
        agents = cls.agentParts(analyzed)
        return CompiledRuntimeEmit.tablePackage(analyzed, common, assembly, {
            'NODE': ['AGENTS', {k: p[1] for k, p in agents.items()}],
            'CODE_NODE': ['CODE_NODES', CompiledRuntimeEmit.codeNodeLiterals(analyzed)],
            'DECISION': ['DECISIONS', {k: json_to_python(d) for k, d in (analyzed.get('decisions') or {}).items()}],
            'PLAYBOOK': ['PLAYBOOKS', {k: json_to_python(pd, True) for k, pd in (analyzed.get('playbooks') or {}).items()}],
        }, {k: p[0] for k, p in agents.items()}, 'NVIDIA NOOA', 'its NOOA Agent class and settings',
            'LLM factory, MCP, run_agent, the driver helpers')

    @classmethod
    def skillBlockForTest(cls) -> str:
        """Expose skillBlock for test/inspection (test seam, mirrors MAFGenerator)."""
        return cls._skillBlock()

    @staticmethod
    def _banner(title: str, *lines: str) -> str:
        """LangGraph-style boxed section banner (documentation standard for all targets)."""
        bar = '# ' + '=' * 62
        return '\n'.join([bar, '# ' + title] + ['# ' + ln for ln in lines] + [bar])

    # ---------- header ----------

    @staticmethod
    def _headerBlock(analyzed: dict, hasMcp: bool) -> str:
        def esc(s: str) -> str:
            # str_replace(['"""', '\\'], ["'''", '\\\\']): each search in turn over the whole string.
            return s.replace('"""', "'''").replace('\\', '\\\\')
        name = esc(php_strval(analyzed['workflow']['name']))
        docBody = esc(PythonEmitHelpers.workflowDocBlock({
            'target': 'NVIDIA OO Agents (Python) -- one NOOA Agent class per node, asyncio orchestration',
            'dispatch_supported': True,
            'workflow': analyzed['workflow'],
            'nodes': PlaybookEmit.docNodes(analyzed),
            'edges': [[e['from'], e['to']] for e in (analyzed.get('edges') or [])],
            'layers': analyzed.get('layers') or [],
            'data_flow': T.dataFlowDoc__ret,
            'run': {
                'deps': ['# "mcp<2": nooa 0.0.8 targets the mcp 1.x SDK API (mcp 2.0 changed the client yield shape).',
                         'pip install "nooa[mcp]" "mcp<2" python-dotenv'] + PlaybookEmit.extraDeps(analyzed),
                'usage': 'python this_file.py "your prompt here"',
            },
            'storage': {'enabled': not php_empty(analyzed.get('outputStorageEnabled')),
                        'folder': analyzed.get('outputFolder')},
        }))
        mcpImports = '\nfrom datetime import timedelta\nfrom nooa.mcp import MCPManager' if hasMcp else ''
        return ('"""Standalone NVIDIA OO Agents (NOOA) workflow: ' + name + '\n'
                '\n'
                + docBody + '\n'
                '"""\n'
                'import asyncio\n'
                'import json\n'
                'import os\n'
                'import subprocess\n'
                'import sys\n'
                'import threading\n'
                'import time\n'
                '\n'
                'import httpx   # the MCP client (code nodes, playbook #Actions, the event trigger)\n'
                'from dotenv import load_dotenv\n'
                '\n'
                "# Provider keys and MCP headers come from this folder's own .env first, then the runner's python/.env --\n"
                '# one level up for the single file in scripts/, two for the package in scripts/<folder>/. load_dotenv\n'
                '# never overrides, so the nearest value wins. Loaded BEFORE nooa is imported: importing nooa loads the\n'
                "# .env nearest to its own install (the runner's python/.env), which would otherwise win.\n"
                '_HERE = os.path.dirname(os.path.abspath(__file__))\n'
                'for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):\n'
                '    load_dotenv(os.path.join(_d, ".env"))\n'
                "PACKAGE_DIR = _HERE   # this program's folder: code/, skills/, start_documents/ and outputs/ are relative to it\n"
                '\n'
                'from nooa import Agent\n'
                'from nooa.unifiedllm.registry import get_llm_client' + mcpImports + '\n')

    # ---------- MCP (native MCPManager) ----------

    @staticmethod
    def _mcpBlock(analyzed: dict) -> str:
        servers = analyzed.get('usedServers') or {}
        lines = ['# Server registry (metadata only, for logs/debugging).',
                 'MCP_SERVERS = ' + json_to_python(servers, True),
                 '',
                 T.mcpEndpointFn__ret,
                 '',
                 '# One live connection per server; the value exposes each server tool as a',
                 '# method. tool_call_timeout matches the 180s the other targets allow.',
                 'MCP = {']
        for url, meta in servers.items():
            nm = php_strval(_first(meta.get('name') if isinstance(meta, dict) else None, ''))
            safeName = re.sub(r'[^A-Za-z0-9_-]+', '-', nm if nm not in ('', '0') else 'server')
            u = py_str(php_strval(url))
            lines.append('    ' + u + ': MCPManager.create_from_server(')
            lines.append('        ' + py_str(safeName) + ',')
            lines.append('        url=_mcp_endpoint(' + u + '),   # MCP_URL_<SLUG> overrides')
            lines.append('        headers=_mcp_headers(' + u + '),   # MCP_HEADERS_<SLUG> from .env')
            lines.append('        transport="streamable-http",')
            lines.append('        tool_call_timeout=timedelta(seconds=180),')
            lines.append('    ),')
        lines.append('}')
        return '\n'.join(lines)

    # ---------- skills ----------

    @staticmethod
    def _skillBlock() -> str:
        # NOOA-specific runtime on top of the shared skill FS layer.
        return PythonEmitHelpers.skillFsSyncBlock() + T.skillBlock__nooaSpecific

    # ---------- agent classes + AGENTS metadata ----------

    @staticmethod
    def _classNames(analyzed: dict) -> dict:
        """Python class name per agent node: CamelCased editor label, deduped, reserved/invalid names replaced by Node<id>."""
        reserved = {'Agent', 'Progress', 'SkillStepAgent', 'MCP', 'MCP_SERVERS', 'OPENAI_COMPATIBLE'}
        names: dict = {}
        used = set(reserved)
        for id_, ag in analyzed['agents'].items():
            label = php_strval(_first(ag.get('name'), ''))
            cls = ''
            for word in re.split(r'[^a-z0-9]+', label, flags=re.IGNORECASE | re.ASCII):
                if word != '':
                    cls += word[0].upper() + word[1:]
            if cls == '' or re.match(r'[0-9]', cls) or cls in reserved:
                cls = 'Node' + re.sub(r'[^A-Za-z0-9_]', '_', php_strval(id_))
            if cls in used:
                cls += '_' + re.sub(r'[^A-Za-z0-9_]', '_', php_strval(id_))
            used.add(cls)
            names[php_strval(id_)] = cls
        return names

    @classmethod
    def agentParts(cls, analyzed: dict) -> dict:
        """Each agent node's class and AGENTS entry, by node id: [class source, dict literal] (agents in separate files)."""
        a = dict(analyzed)
        a.setdefault('literalsOut', True)
        return cls._agentsBlock(a, not php_empty(analyzed.get('usedCatalog')))

    @staticmethod
    def _agentsBlock(analyzed: dict, hasMcp: bool):
        byId: dict = {}
        classNames = NOOAGenerator._classNames(analyzed)
        catalog = analyzed.get('usedCatalog') or {}
        out = []
        docById = {dn['id']: dn for dn in PlaybookEmit.docNodes(analyzed)}

        for id_, ag in analyzed['agents'].items():
            id_ = php_strval(id_)
            cls = classNames[id_]
            prov = php_strval(_first(ag.get('provider'), 'claude'))
            model = php_strval(_first(ag.get('model'), ''))
            maxT = _max_tokens(ag)
            temp = _temp(ag)
            think = _think(ag)
            prompt = php_strval(_first(ag.get('systemPrompt'), '')).strip(' \t\n\r\x00\x0b')
            if prompt == '':
                prompt = 'You are a helpful agent.'

            # Selected tools (mcp_ prefix stripped) -> the servers this node needs.
            tools = []
            for t in (ag.get('tools') or []):
                t = php_strval(t)
                if t.startswith('mcp_'):
                    t = t[4:]
                if t != '':
                    tools.append(t)
            serverUrls: dict = {}
            for t in tools:
                entry = catalog.get(t) if isinstance(catalog, dict) else None
                surl = php_strval(_first(entry.get('server_url') if isinstance(entry, dict) else None, ''))
                if surl != '':
                    serverUrls[surl] = True

            lines = []
            if id_ in docById:
                lines.append(PythonEmitHelpers.nodeCommentBlock(docById[id_]))
            lines.append(f'class {cls}(Agent, llm=make_llm(' + py_str(prov) + ', ' + py_str(model)
                         + f', {maxT}, {temp}, {think})):')
            lines.append('    ' + py_str(prompt))
            if hasMcp and serverUrls:
                lines.append('')
                lines.append('    # MCP server(s) selected for this node (tools via self).')
                for i, surl in enumerate(serverUrls):
                    lines.append(f'    mcp_{i} = MCP[' + py_str(php_strval(surl)) + ']')
            doc = ("Complete this node's task on the given input, per your class instructions. "
                   'Return the complete deliverable text.')
            if tools:
                doc += (' Tools selected for this node: ' + ', '.join(tools)
                        + ' — use these via the attached MCP server(s); other server tools are out of scope.')
            lines.append('')
            lines.append('    async def respond(self, prompt: str) -> str:')
            lines.append('        ' + py_str(doc))
            lines.append('        ...')
            out.append('\n'.join(lines))
            byId[id_] = ['\n'.join(lines)]

        # Frozen per-node metadata consumed by run_agent / run_skill.
        entries = []
        for id_, ag in analyzed['agents'].items():
            id_ = php_strval(id_)
            literal = ('{'
                       + '"name": ' + py_str(php_strval(_first(ag.get('name'), 'node ' + id_))) + ', '
                       + '"cls": ' + classNames[id_] + ', '
                       + '"provider": ' + py_str(php_strval(_first(ag.get('provider'), 'claude'))) + ', '
                       + '"model": ' + py_str(php_strval(_first(ag.get('model'), ''))) + ', '
                       + '"max_tokens": ' + str(_max_tokens(ag)) + ', '
                       + '"temperature": ' + _temp(ag) + ', '
                       + '"thinking": ' + _think(ag) + ', '
                       + '"skills": ' + json_to_python(_first(ag.get('skills'), [])) + '}')
            entries.append('    ' + py_str(id_) + ': ' + literal + ',')
            byId[id_].append(literal)
        if not php_empty(analyzed.get('literalsOut')):
            return byId
        if not php_empty(analyzed.get('split')):
            # Agents in separate files: each agents/<name>.py holds its class and entry; workflow.py fills AGENTS.
            return 'AGENTS = {}   # node id -> class and settings, filled by workflow.py from agents/'
        out.append('AGENTS = {\n' + '\n'.join(entries) + '\n}')
        return '\n\n\n'.join(out)

    # ---------- node runner ----------

    @staticmethod
    def _runnerBlock(hasSkills: bool) -> str:
        skillLoop = T.runnerBlock__ret if hasSkills else ''
        return ('async def run_agent(node_id, parent_texts, request):\n'
                '    """Run ONE agent node: framed input -> NOOA class -> mandatory skills.\n'
                '\n'
                '    parent_texts is a list of (source_name, text) tuples in canvas order.\n'
                '    The framing mirrors the other compile targets: the ORIGINAL user\n'
                '    request plus each parent\'s labelled output, so every agent sees the\n'
                '    prompt no matter how deep it sits in the graph. Date grounding keeps\n'
                '    research nodes anchored to \'now\' instead of their training era.\n'
                '    """\n'
                '    ad = AGENTS[node_id]\n'
                '    name = str(ad["name"])\n'
                '    parts = ["Current date: " + time.strftime("%Y-%m-%d") + ". Treat this as "\n'
                '             "\'now\'; prefer your tools for current data over memory.", "",\n'
                '             \'Original user request: "\' + str(request) + \'"\', "",\n'
                '             "Upstream inputs from this workflow (source material for your task):",\n'
                '             "", "---"]\n'
                '    labeled = [(src, txt) for src, txt in parent_texts if txt and src != "Start"]\n'
                '    if not labeled:\n'
                '        parts.append("(no upstream inputs -- respond to the original request directly)")\n'
                '    else:\n'
                '        for src, txt in labeled:\n'
                '            parts += ["", "### Input from " + str(src), "", str(txt), "", "---"]\n'
                '    Progress.node_start(name, f"agent {ad[\'provider\']}/{ad[\'model\'] or \'default\'} — generating…")\n'
                '    text = str(await ad["cls"]().respond("\\n".join(parts)) or "")\n'
                + skillLoop + '\n'
                '    Progress.node_done(name, len(text))\n'
                '    return text')

    # ---------- globals ----------

    @staticmethod
    def _globalsBlock(analyzed: dict) -> str:
        sp = py_str(php_strval(analyzed['startPrompt']))
        wfName = py_str(php_strval(analyzed['workflow']['name']))
        wfId = php_intval(analyzed['workflow']['id'])
        enabled = 'True' if not php_empty(analyzed.get('outputStorageEnabled')) else 'False'
        folder = py_str(php_strval(analyzed['outputFolder'])) if not php_empty(analyzed.get('outputFolder')) else 'None'
        dw = analyzed.get('defaultWatch')
        return (f'DEFAULT_PROMPT = {sp}\n'
                f'WORKFLOW_NAME = {wfName}\n'
                f'WORKFLOW_ID = {wfId}\n'
                f'OUTPUT_STORAGE_ENABLED = {enabled}\n'
                f'OUTPUT_FOLDER = {folder}\n'
                + 'START_DOCUMENTS = ' + json_to_python(_first(analyzed.get('startDocuments'), [])) + '\n'
                # The Start's mode (prompt | cron | watch), its schedule and its event trigger: the listener reads them.
                + 'START_MODE = ' + py_str(php_strval(_first(analyzed.get('startMode'), 'prompt'))) + '\n'
                + 'DEFAULT_CRON = ' + ('None' if analyzed.get('defaultCron') is None
                                       else py_str(php_strval(analyzed['defaultCron']))) + '\n'
                + 'DEFAULT_WATCH = ' + ('None' if dw is None
                                        else json_to_python({'server': dw['server'], 'tool': dw['tool'],
                                                             'args': obj(dw['args'])})))

    # ---------- driver ----------

    @classmethod
    def _mainBlock(cls, analyzed: dict, hasDocs: bool) -> str:
        startId = php_strval(_first(analyzed.get('startNodeId'), ''))
        agents = analyzed['agents'] or {}
        playbooks = analyzed.get('playbooks') or {}
        code = analyzed.get('code') or {}
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        outId = ''
        for id_, node in analyzed['byId'].items():
            if WorkflowGraphAnalyzer.typeOf(node) == 'output':
                outId = php_strval(id_)
                break

        def kind(id_: str):
            if id_ in code:
                return 'code'
            if id_ in playbooks:
                return 'playbook'
            if id_ in menus and id_ in agents:
                return 'dispatcher'
            if id_ in agents:
                return 'agent'
            return None

        parentsMap = analyzed.get('parents') or {}

        def eff(id_: str) -> list:
            """A node's parents that exist at run time (Start or a runnable node); with none it reads Start."""
            keep = []
            for p in (parentsMap.get(id_) or []):
                p = php_strval(p)
                if p == startId or kind(p) is not None:
                    keep.append(p)
            return keep or ([startId] if startId != '' else [])

        nodes: dict = {}
        layers = []
        for layer in list(analyzed['layers']):
            ids = []
            for nid in (layer or []):
                nid = php_strval(nid)
                k = kind(nid)
                if k is None:
                    continue
                name = php_strval(_first((code.get(nid) or {}).get('display'), (playbooks.get(nid) or {}).get('display'),
                                         (agents.get(nid) or {}).get('name'), nid))
                nodes[nid] = {'kind': k, 'name': name, 'parents': eff(nid)}
                if k == 'dispatcher':
                    nodes[nid]['menu'] = [[php_strval(t['id']), php_strval(t['name'])] for t in menus[nid]]
                ids.append(nid)
            if ids:
                layers.append(ids)
        graph = {'start': startId, 'output': outId, 'output_parents': eff(outId) if outId != '' else [],
                 'sinks': layers[-1] if outId == '' and layers else [], 'layers': layers, 'nodes': PhpObj(nodes)}

        body = []
        if hasDocs:
            # ADK-parity: attached start documents are converted to markdown and prefixed to the prompt.
            body += [
                '    if START_DOCUMENTS:',
                '        doc_parts = []',
                '        for doc in START_DOCUMENTS:',
                '            doc_name = doc.get("name", "Document")',
                '            path = doc.get("path", "")',
                '            if not path:',
                '                doc_parts.append(f"### {doc_name}\\n\\n_(no path on attachment record)_")',
                '                continue',
                '            try:',
                '                md = _convert_doc_to_markdown(path)',
                '                doc_parts.append(f"### {doc_name}\\n\\n{md}")',
                '            except Exception as e:',
                '                doc_parts.append(f"### {doc_name}\\n\\n_(conversion failed: {e})_")',
                '        if doc_parts:',
                '            prompt = ("## Attached Documents\\n\\n"',
                '                      + "\\n\\n---\\n\\n".join(doc_parts)',
                '                      + "\\n\\n---\\n\\n" + prompt)',
            ]
        body.append('    return await _run_graph(prompt)')

        return ('GRAPH = ' + json_to_python(graph) + '\n\n\n' + cls._driverBlock(bool(code), bool(menus)) + '\n\n\n'
                + 'async def run_workflow(prompt: str, session: str | None = None) -> str:\n' + '\n'.join(body))

    @staticmethod
    def _driverBlock(hasCode: bool, hasDispatch: bool) -> str:
        """_run_graph(): walk GRAPH's layers, running the reached nodes of each together; the Output's merge is the answer."""
        py = T.driverBlock__py

        # A workflow without dispatchers or code nodes gets no branch for them.
        def cut(py: str, frm: str, to: str, keep: bool) -> str:
            a = py.index(frm)
            b = py.index(to, a)
            if keep:
                return py[:a] + py[a + len(frm) + 1:b] + py[b + len(to) + 1:]
            return py[:a] + py[b + len(to) + 1:]

        head = py.index('#--END-DISPATCH--')
        route = py[:head]
        py = py[head + len('#--END-DISPATCH--\n\n\n'):]
        py = cut(py, '            #--DISPATCH--', '            #--END-DISPATCH-CASE--', hasDispatch)
        py = cut(py, '            #--CODE--', '            #--END-CODE--', hasCode)
        return (route + '\n\n' if hasDispatch else '') + py
