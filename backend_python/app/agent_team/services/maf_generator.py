"""Port of backend/src/AgentTeam/Services/MAFGenerator.php -- the Microsoft Agent Framework compiler.

Compiles a workflow DSL into a self-contained Microsoft Agent Framework (graph API) Python program: a single
file (generate), agents in separate files (generatePackage) or one A2A agent server per node plus an
orchestrator (generateA2A). The emitted bytes are PHP's for the same inputs
(tests/unit/test_compiled_targets_differential.py compiles fixtures with both and compares). The literal
Python PHP carries as nowdocs is imported from compiler_text/maf_generator.py (extract_nowdocs.php).
"""
from __future__ import annotations

import re

from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from app.agent_team.services.compiled_architecture_doc import CompiledArchitectureDoc
from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_php import json_encode, json_to_python, obj, py_str
from app.agent_team.services.compiler_text import maf_generator as T
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_floatval, php_intval, php_strval

# Python reserved words: a property named after a keyword cannot be a named parameter.
_PY_KEYWORDS = frozenset([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
    'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

_TYPE_MAP = {'string': 'str', 'integer': 'int', 'number': 'float', 'boolean': 'bool', 'array': 'list', 'object': 'dict'}


def _first(*values):
    """`$a ?? $b ?? ...`: the first value that is not None."""
    for v in values:
        if v is not None:
            return v
    return None


def _cfg(node) -> dict:
    return node.get('config') if isinstance(node, dict) and isinstance(node.get('config'), dict) else {}


def _safe_name(name: str) -> str:
    """preg_replace('/[^a-z0-9_]+/i', '_', $name)."""
    return re.sub(r'[^a-z0-9_]+', '_', name, flags=re.IGNORECASE | re.ASCII)


class MAFGenerator:
    """The package's framework requirements (CompiledPackage adds the MCP client, .env and the run server)."""
    FRAMEWORK = ['agent-framework']

    def __init__(self, db, workflowRepo, graphRepo, agentRepo, skillsRoot: str | None = None, startDocuments=None):
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo
        self.skillsRoot = skillsRoot              # the package copies the used skills from here
        self.startDocuments = startDocuments      # the package copies the Start's documents from here

    def generate(self, workflowId: int, userId: str | None = None) -> dict:
        analyzed = self._analyzeWorkflow(workflowId, userId)
        name = _safe_name(analyzed['workflow']['name'])
        return CompiledArchitectureDoc.attach({
            'filename': name.lower() + '_maf.py',
            'code': self.emitMaf(analyzed),
        }, analyzed, 'maf', 'single')

    def _analyzeWorkflow(self, workflowId: int, userId: str | None) -> dict:
        """Everything emitMaf() needs, read from the database at compile time (the program itself never reads it)."""
        # A swarm is a different architecture, not a packaging choice (see the PHP note).
        wfForArch = self.workflowRepo.findById(workflowId)
        if wfForArch and wfForArch.getOrchestration() == 'swarm':
            raise RuntimeError(
                'This workflow is set to swarm orchestration, which MAF cannot compile. '
                'Compile it with LangGraph, or switch the workflow to "workflow" orchestration.'
            )
        analyzer = WorkflowGraphAnalyzer(self.db, self.workflowRepo, self.graphRepo, self.agentRepo)
        analyzed = analyzer.analyze(workflowId, userId)

        # Platform default model per provider (system_llm_settings): an empty form model means the default.
        defaults: dict = {}
        try:
            rows = self.db.fetch_all('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1')
            for row in rows:
                if not php_empty(row['model']):
                    defaults[php_strval(row['provider_key']).lower()] = php_strval(row['model'])
        except Exception as e:  # noqa: BLE001 -- PHP catches \Throwable
            error_log('[MAFGenerator] could not load provider default models: ' + str(e))
        analyzed['providerDefaultModels'] = defaults

        # Playbook nodes: resolved once (the #Action bindings need the MCP catalog).
        analyzed['playbooks'] = {}
        for pid, pnode in dict(analyzed.get('byId') or {}).items():
            if WorkflowGraphAnalyzer.typeOf(pnode) != 'playbook':
                continue
            PlaybookEmit.refuseLangGraphOnly(pnode, self.graphRepo.getGraph(workflowId).get('edges') or [])
            analyzed['playbooks'][str(pid)] = PlaybookEmit.nodeData(
                pnode, analyzer.availableToolsById(userId), defaults, userId)

        # Code nodes, MCP server slugs (headers), decision routing, the Start's mode: CompiledRuntimeEmit's rules.
        return CompiledRuntimeEmit.analyzeRuntime(analyzed, analyzer, self.db, self.agentRepo,
                                                  self.graphRepo.getGraph(workflowId), workflowId, userId)

    def generateA2A(self, workflowId: int, userId: str | None = None) -> dict:
        """A2A: one A2A agent server per node plus an orchestrator (CompiledA2AEmit)."""
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
                                      'Microsoft Agent Framework (A2A)')
        root = _safe_name(php_strval(analyzed['workflow']['name']).lower()) + '_maf_a2a'
        return CompiledArchitectureDoc.attach(
            CompiledA2AEmit.package(analyzed, cls.packageFiles(analyzed), runNodes, files, root, 'Microsoft Agent Framework'),
            analyzed, 'maf', 'a2a')

    def generatePackage(self, workflowId: int, userId: str | None = None) -> dict:
        """The compiled package: the same script, plus the run server that makes it conversational."""
        from app.agent_team.services.run_server_emitter import RunServerEmitter
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
            'maf',
            'MAF run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
            commonPy,
            True,   # api.py also runs the Start's cron / watch loop: POST /listen, GET /live
        )
        pkg['files'] = list(pkg['files']) + list(nodeFiles) + CompiledPackage.files(
            analyzed, self.skillsRoot if self.skillsRoot is not None else LangGraphPackage.defaultSkillsRoot(),
            docs['files'], self.FRAMEWORK, 'Microsoft Agent Framework')
        return CompiledArchitectureDoc.attach(pkg, analyzed, 'maf', 'modular')

    @classmethod
    def emitMaf(cls, analyzed: dict) -> str:
        common, workflow = cls._mafParts(analyzed)
        return '\n\n'.join(common + workflow) + '\n'

    @classmethod
    def _mafParts(cls, analyzed: dict) -> list:
        """The script as [runtime parts, assembly parts]: the package's common.py and workflow.py, in the single file's order."""
        b = cls._banner
        parts = []
        parts.append(cls._headerBlock(analyzed))
        parts.append(b('PROVIDER CLIENT FACTORY',
                       'Builds the MAF chat client + per-call ChatOptions for each agent',
                       'node. Every provider-specific detail lives here: endpoints,',
                       'credential env vars, and the hard API constraints (kimi/anthropic/',
                       'deepseek sampling rules). The node form Thinking attribute is',
                       'honored here. To support a new provider: add it to',
                       'ProviderClients.OPENAI_COMPATIBLE (or a dedicated branch in make).'))
        parts.append(T.clientFactoryBlock__ret)
        if not php_empty(analyzed.get('usedCatalog')):
            parts.append(b('MCP SERVER REGISTRY',
                           'Baked at generation time from the workflow editor config.',
                           'Maps server URL -> metadata. If a server moves, update the URL here.'))
            parts.append('MCP_SERVERS = ' + json_to_python(analyzed['usedServers'], True))
            parts.append(b('TOOL CATALOG',
                           'Each entry maps a tool name to its MCP server URL and JSON Schema.',
                           'Only tools actually used by agents in this workflow are included.',
                           'To add a tool: add an entry here AND reference it in the node',
                           'metadata (AGENTS dict) below.'))
            parts.append('TOOL_CATALOG = ' + json_to_python(analyzed['usedCatalog'], True))
            parts.append(b('MCP CLIENT + TOOL WRAPPERS',
                           'HTTP JSON-RPC client for the MCP servers, one typed _tool_*',
                           'function per catalog entry, and _reported_mcp_call — the',
                           'progress wrapper that prints [tool] lines attributed to the',
                           'calling agent node (contextvar).'))
            parts.append(CompiledRuntimeEmit.mcpClientBlock(analyzed))
            parts.append(cls._mcpToolBuilderBlock(analyzed))
            parts.append('catalog = build_tools_from_catalog()')
        else:
            if not php_empty(analyzed.get('code')) or not php_empty(analyzed.get('playbooks')) \
                    or not php_empty(analyzed.get('package')):
                # No agent tools, but code nodes and playbook #Actions call MCP servers too.
                parts.append(b('MCP CLIENT',
                               'HTTP JSON-RPC client for the MCP servers the code nodes and',
                               "playbook #Actions call, with each server's headers (.env)."))
                parts.append(CompiledRuntimeEmit.mcpClientBlock(analyzed))
            parts.append('catalog = {}')
        parts.append(b('DOCUMENT CONVERTER',
                       'Turns a start-node attachment into markdown for the prompt.'))
        parts.append(PythonEmitHelpers.documentConverterBlock())
        needsSkills = any(not php_empty(ag.get('skills')) for ag in dict(analyzed['agents'] or {}).values())
        if needsSkills:
            parts.append(b('SKILL RUNTIME',
                           'Runs folder-backed skills (SKILL.md + scripts) as mandatory',
                           'post-agent steps. SkillRuntime implements the two-phase design:',
                           'phase A authors the deliverable as plain text, the runtime',
                           'stages it deterministically, phase B runs the skill script',
                           'with path-only arguments (or a full SKILL.md-driven process',
                           'for script-first skills). A failed step degrades to "skill',
                           'skipped" — it can never destroy the node output.'))
            parts.append(PythonEmitHelpers.skillDepsBlock())   # SKILLS_DIR + _ensure_skill_deps
            parts.append(cls._skillRunnerBlock())
        if not php_empty(analyzed.get('playbooks')):
            parts.append(b('PLAYBOOK NODES',
                           'A playbook node is an interpreter, not an agent: the model',
                           're-decides each round from the running transcript, with the',
                           'native verbs, the human gates, one tool per bound #Action and',
                           'a stub per unbound one. The node output is that transcript.'))
            parts.append(PlaybookEmit.supportBlock(False))   # _call_mcp_tool: the MCP client above
            parts.append(PlaybookEmit.runtimeBlock())
            parts.append('PLAYBOOKS = {}   # node id -> playbook, filled by workflow.py from agents/'
                         if not php_empty(analyzed.get('split')) else PlaybookEmit.metadataBlock(analyzed['playbooks']))
        if not php_empty(analyzed.get('code')):
            parts.append(b('CODE NODES',
                           'A code node runs its own Python run(input, call_tool) through the',
                           'harness the workflow editor runs (CODE_HARNESS, a copy): no model.',
                           "CODE_NODES: each node's exits, MCP servers, timeout and code."))
            parts.append(CompiledRuntimeEmit.codeHarnessBlock(not php_empty(analyzed.get('package'))))
            parts.append(CompiledRuntimeEmit.codeNodesLiteral(analyzed))
        if not php_empty(WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']):
            parts.append(b('DECISION-MODEL ROUTING',
                           'A dispatcher whose routing names a decision model (Jev...) asks it',
                           'and runs the child it names: no LLM turn. The adapters are the',
                           "LangGraph target's, copied. DECISIONS: each dispatcher's settings."))
            parts.append(CompiledRuntimeEmit.decisionBlock(analyzed))
        parts.append(b('RUN EVENTS',
                       "Each node's start and completion (a code node's exit, a",
                       "dispatcher's route) go to GRAPH_RECORDER when the package's",
                       "listener set one: runs/ and GET /live, the editor's live canvas."))
        parts.append(CompiledRuntimeEmit.recordingBlock(analyzed) + '\n\n\n' + CompiledRuntimeEmit.idRecordingHelpers())
        parts.append(b('FROZEN NODE METADATA + EXECUTORS',
                       'AGENTS: per-node settings verbatim from the editor forms.',
                       'ProgressReporter: console liveness (banner, node lines, heartbeat,',
                       'RUN SUMMARY). StartExecutor / AgentNodeExecutor / OutputNodeExecutor:',
                       'the graph node implementations (fan-in barrier -> agent -> skills).',
                       "To change a node's provider/model/tools: edit the workflow in the",
                       'editor and re-generate — do not hand-edit AGENTS.'))
        parts.append(cls._agentsBlock(analyzed))
        # globalsBlock MUST precede orchestrationBlock (DEFAULT_PROMPT is a default parameter value).
        parts.append(b('WORKFLOW GLOBALS',
                       'Identity + the Start node prompt baked as DEFAULT_PROMPT',
                       '(CLI args override it) + output storage settings.'))
        parts.append(cls._globalsBlock(analyzed))
        workflowFrom = len(parts)   # from here on: the assembly (workflow.py in the package)
        parts.append(b('GRAPH ASSEMBLY',
                       'create_workflow() reconstructs the editor canvas 1:1 on the MAF',
                       'graph API: one executor per node, one add_edge per drawn',
                       'connection. MAF schedules execution from this topology.'))
        parts.append(cls._orchestrationBlock(analyzed))
        parts.append(b('RUN WORKFLOW',
                       'The run-server contract: build the graph, run it once, return the',
                       'terminal output unmodified. The CLI entry below is the only',
                       'caller inside this file; api.py (the compiled package) is the',
                       'other.'))
        parts.append(T.runWorkflowBlock__ret)
        parts.append(CompiledRuntimeEmit.packageListenBlock(T.mafParts__ret)
                     if not php_empty(analyzed.get('package')) else T.entryBlock__ret)
        return [parts[:workflowFrom], parts[workflowFrom:]]

    @classmethod
    def packageFiles(cls, analyzed: dict) -> list:
        """Agents in separate files: [workflow.py, common.py, agents/ files] (CompiledRuntimeEmit.tablePackage)."""
        analyzed = dict(analyzed)
        analyzed['split'] = True
        common, assembly = cls._mafParts(analyzed)
        return CompiledRuntimeEmit.tablePackage(analyzed, common, assembly, {
            'NODE': ['AGENTS', cls.agentLiterals(analyzed)],
            'CODE_NODE': ['CODE_NODES', CompiledRuntimeEmit.codeNodeLiterals(analyzed)],
            'DECISION': ['DECISIONS', {str(k): json_to_python(d) for k, d in dict(analyzed.get('decisions') or {}).items()}],
            'PLAYBOOK': ['PLAYBOOKS', {str(k): json_to_python(pd, True) for k, pd in dict(analyzed.get('playbooks') or {}).items()}],
        }, {}, 'Microsoft Agent Framework', 'its settings for the MAF executors', 'the executor classes')

    @classmethod
    def skillRunnerBlockForTest(cls) -> str:
        """Expose skillRunnerBlock for test/inspection (test seam)."""
        return cls._skillRunnerBlock()

    @staticmethod
    def _banner(title: str, *lines: str) -> str:
        """A boxed section-banner comment naming the section and what it is for."""
        bar = '# ' + '=' * 62
        return '\n'.join([bar, '# ' + title] + ['# ' + ln for ln in lines] + [bar])

    @staticmethod
    def _mcpToolBuilderBlock(analyzed: dict) -> str:
        """Concrete _tool_* functions + build_tools_from_catalog(); catalog entries map to the plain function."""
        functions = []
        catalogEntries = []
        for toolName, spec in dict(analyzed['usedCatalog']).items():
            toolName = php_strval(toolName)
            description = php_strval(_first(spec.get('description'), toolName))
            inputSchema = spec.get('input_schema') if isinstance(spec.get('input_schema'), dict) else {}
            properties = dict(inputSchema['properties']) if isinstance(inputSchema.get('properties'), dict) \
                else ({str(i): v for i, v in enumerate(inputSchema['properties'])}
                      if isinstance(inputSchema.get('properties'), list) else {})
            required = inputSchema['required'] if isinstance(inputSchema.get('required'), (list, dict)) else []
            if isinstance(required, dict):
                required = list(required.values())
            serverUrl = php_strval(_first(spec.get('server_url'), ''))

            safeName = re.sub(r'[^A-Za-z0-9_]', '_', toolName)
            if re.match(r'[0-9]', safeName):
                safeName = '_' + safeName
            fnName = '_tool_' + safeName

            requiredSet = {php_strval(r) for r in required}
            ident = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\Z')

            validRequired: dict = {}
            validOptional: dict = {}
            hasExtra = False
            for pname in required:
                pname = php_strval(pname)
                if pname not in properties:
                    continue
                if ident.match(pname) and pname not in _PY_KEYWORDS:
                    validRequired[pname] = properties[pname] if isinstance(properties[pname], dict) else {}
                else:
                    hasExtra = True
            for pname, pspec in properties.items():
                pname = php_strval(pname)
                if pname in requiredSet:
                    continue
                if ident.match(pname) and pname not in _PY_KEYWORDS:
                    validOptional[pname] = pspec if isinstance(pspec, dict) else {}
                else:
                    hasExtra = True

            def _type(pspec):
                """$typeMap[$pspec['type'] ?? ''] ?? 'str' -- an array "type" (["string", "null"]) is an illegal offset."""
                t = pspec.get('type')
                if isinstance(t, (list, dict)):
                    raise TypeError('Illegal offset type')
                return _TYPE_MAP.get(t, 'str') if isinstance(t, str) else 'str'

            params = [f'{p}: {_type(s)}' for p, s in validRequired.items()]
            params += [f'{p}: {_type(s)} = None' for p, s in validOptional.items()]
            if hasExtra:
                params.append('**extra')
            paramStr = ', '.join(params)
            allValidProps = {**validRequired, **validOptional}

            safeDesc = description.replace('"""', '\\"\\"\\"')
            doc = f'    """{safeDesc}'
            if allValidProps:
                doc += '\n\n    Args:'
                for pname, pspec in allValidProps.items():
                    pDesc = php_strval(_first(pspec.get('description'), ''))
                    doc += f'\n        {pname}: {pDesc}'
            doc += '\n    """'

            pyUrl = py_str(serverUrl)
            pyName = py_str(toolName)
            if allValidProps or hasExtra:
                argPairs = [f'"{p}": {p}' for p in allValidProps]
                if hasExtra:
                    argDict = '{**' + '{' + ', '.join(argPairs) + '}' + ', **extra}'
                else:
                    argDict = '{' + ', '.join(argPairs) + '}'
                body = f'    _args = {{k: v for k, v in {argDict}.items() if v is not None}}\n'
                body += f'    return _reported_mcp_call({pyUrl}, {pyName}, _args)'
            else:
                body = f'    return _reported_mcp_call({pyUrl}, {pyName}, {{}})'

            functions.append(f'def {fnName}({paramStr}) -> str:\n{doc}\n{body}')
            catalogEntries.append(f'        {py_str(toolName)}: {fnName}')

        out = T.mcpToolBuilderBlock__out
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

    @staticmethod
    def _headerBlock(analyzed: dict) -> str:
        def esc(s: str) -> str:
            return s.replace('"""', "'''").replace('\\', '\\\\')
        name = esc(php_strval(analyzed['workflow']['name']))
        docBody = esc(PythonEmitHelpers.workflowDocBlock({
            'target': 'Microsoft Agent Framework (Python) -- WorkflowBuilder graph, one Executor per node',
            'dispatch_supported': True,
            'workflow': analyzed['workflow'],
            'nodes': PlaybookEmit.docNodes(analyzed),
            'edges': [[e['from'], e['to']] for e in list((analyzed.get('edges') or {}).values()
                                                       if isinstance(analyzed.get('edges'), dict)
                                                       else (analyzed.get('edges') or []))],
            'layers': _first(analyzed.get('layers'), []),
            'data_flow': T.dataFlowDoc__ret,
            'run': {
                'deps': ['pip install "agent-framework>=1.10,<2" httpx python-dotenv'] + list(PlaybookEmit.extraDeps(analyzed)),
                'usage': 'python this_file.py "your prompt here"',
            },
            'storage': {'enabled': not php_empty(analyzed.get('outputStorageEnabled')),
                        'folder': analyzed.get('outputFolder')},
        }))
        return (f'"""Standalone Microsoft Agent Framework workflow: {name}\n'
                '\n'
                f'{docBody}\n'
                '"""\n' + _HEADER_IMPORTS)

    @staticmethod
    def _skillRunnerBlock() -> str:
        """skillFsSyncBlock() (the shared sync skill FS) + the MAF-specific SkillRuntime class."""
        return PythonEmitHelpers.skillFsSyncBlock() + T.skillRunnerBlock__mafSpecific

    @classmethod
    def agentLiterals(cls, analyzed: dict) -> dict:
        """Each agent node's AGENTS entry as a Python dict literal, by node id (agents in separate files)."""
        a = dict(analyzed)
        a.setdefault('literalsOut', True)
        return cls._agentsBlock(a)

    @staticmethod
    def _agentsBlock(analyzed: dict):
        entries = []
        literals: dict = {}
        defaultModels = dict(analyzed.get('providerDefaultModels') or {})
        docById = {}
        for dn in PlaybookEmit.docNodes(analyzed):
            docById[str(dn['id'])] = dn
        for id_, ag in dict(analyzed['agents'] or {}).items():
            sid = php_strval(id_)
            if sid in docById:
                entries.append(PythonEmitHelpers.nodeCommentBlock(docById[sid], '    '))
            instr = php_strval(_first(ag.get('systemPrompt'), ''))
            # Node forms store tool names with the runtime 'mcp_' prefix; the catalog is keyed unprefixed.
            tools = []
            for t in list(_first(ag.get('tools'), []) or []):
                t = php_strval(t)
                if t.startswith('mcp_'):
                    t = t[4:]
                tools.append('catalog.get(' + py_str(t) + ')')
            toolsPy = '[' + ', '.join(tools) + ']'
            skillsPy = json_to_python(_first(ag.get('skills'), []))
            prov = php_strval(_first(ag.get('provider'), 'claude')).lower()
            canon = {'anthropic': 'claude', 'google': 'gemini'}.get(prov, prov)
            model = php_strval(_first(ag.get('model'), ''))
            if model == '':
                model = php_strval(_first(defaultModels.get(canon), defaultModels.get(prov), ''))
            thinking = ag.get('thinking')
            literals[sid] = ('{'
                             + '"name": ' + py_str(php_strval(_first(ag.get('name'), 'node ' + sid))) + ', '
                             + '"provider": ' + py_str(php_strval(_first(ag.get('provider'), 'claude'))) + ', '
                             + '"model": ' + py_str(model) + ', '
                             + '"instructions": ' + py_str(instr) + ', '
                             + '"tools": ' + toolsPy + ', '
                             + '"skills": ' + skillsPy + ', '
                             + '"max_tokens": ' + str(php_intval(_first(ag.get('max_tokens'), 4096))) + ', '
                             + '"temperature": ' + json_encode(php_floatval(_first(ag.get('temperature'), 0.7))) + ', '
                             + '"thinking": ' + (py_str(thinking) if thinking in ('on', 'off') else 'None') + '}')
            entries.append('    ' + py_str(sid) + ': ' + literals[sid] + ',')
        agents = ('AGENTS = {}   # node id -> settings, filled by workflow.py from agents/'
                  if not php_empty(analyzed.get('split')) else 'AGENTS = {\n' + '\n'.join(entries) + '\n}')
        if not php_empty(analyzed.get('literalsOut')):
            return literals

        runner = T.agentsBlock__runner
        if php_empty(analyzed.get('code')):
            # No code node: no CodeNodeExecutor (it reads CODE_NODES and CODE_HARNESS).
            frm = runner.find('class CodeNodeExecutor(Executor):')
            runner = runner[:frm] + runner[runner.find('class OutputNodeExecutor(Executor):'):]
        agentsDoc = ('# Frozen per-node metadata from the visual editor (one entry per agent\n'
                     '# node): display name, provider/model, system instructions, MCP tool\n'
                     "# selection, bound skills, and the node form's sampling settings.\n"
                     '# AgentNodeExecutor reads this by node_id; Start/Output have no entry.')
        return agentsDoc + '\n' + agents + '\n\n\n' + runner

    @staticmethod
    def _globalsBlock(analyzed: dict) -> str:
        """DEFAULT_PROMPT + workflow/storage globals (before orchestrationBlock)."""
        sp = py_str(php_strval(analyzed['startPrompt']))
        wfName = py_str(php_strval(analyzed['workflow']['name']))
        wfId = php_intval(analyzed['workflow']['id'])
        enabled = 'True' if not php_empty(analyzed.get('outputStorageEnabled')) else 'False'
        folderV = analyzed.get('outputFolder')
        folder = py_str(php_strval(folderV)) if not php_empty(folderV) else 'None'
        watch = analyzed.get('defaultWatch')
        cron = analyzed.get('defaultCron')
        return (f'DEFAULT_PROMPT = {sp}\n'
                f'WORKFLOW_NAME = {wfName}\n'
                f'WORKFLOW_ID = {wfId}\n'
                f'OUTPUT_STORAGE_ENABLED = {enabled}\n'
                f'OUTPUT_FOLDER = {folder}\n'
                'START_MODE = ' + py_str(php_strval(_first(analyzed.get('startMode'), 'prompt'))) + '\n'
                'DEFAULT_CRON = ' + ('None' if cron is None else py_str(php_strval(cron))) + '\n'
                'DEFAULT_WATCH = ' + ('None' if watch is None
                                      else json_to_python({'server': watch['server'], 'tool': watch['tool'],
                                                           'args': obj(watch['args'])})))

    @staticmethod
    def _orchestrationBlock(analyzed: dict) -> str:
        """create_workflow(): the editor canvas reconstructed 1:1 on MAF's graph API."""
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        startId = php_strval(_first(analyzed.get('startNodeId'), ''))
        outId = ''
        for id_, node in dict(analyzed['byId']).items():
            t = _first(node.get('type'), _cfg(node).get('type'), '')
            if t == 'output':
                outId = php_strval(id_)
                break

        vars_ = {startId: 'start_node'}
        vars_[outId] = 'output_node'
        used = {'start_node': True, 'output_node': True}
        displayName = {startId: 'Start'}
        displayName[outId] = 'Output'
        pbLabels: dict = {}
        for pid, pd in dict(analyzed.get('playbooks') or {}).items():
            pbLabels[str(pid)] = {'name': php_strval(_first(pd.get('display'), 'playbook ' + str(pid)))}
        for cid, cd in dict(analyzed.get('code') or {}).items():
            pbLabels[str(cid)] = {'name': php_strval(cd['display'])}
        union = {str(k): v for k, v in dict(analyzed['agents'] or {}).items()}
        for k, v in pbLabels.items():
            if k not in union:
                union[k] = v
        for id_, ag in union.items():
            label = php_strval(_first(ag.get('name'), 'node ' + id_))
            displayName[id_] = label
            v = re.sub(r'[^a-z0-9]+', '_', label, flags=re.IGNORECASE | re.ASCII).strip('_').lower()
            if v == '' or re.match(r'[0-9]', v):
                v = 'node_' + id_
            if v in used:
                v += '_' + id_
            used[v] = True
            vars_[id_] = v

        parents = analyzed['parents']
        code = analyzed.get('code') or {}
        playbooks = analyzed.get('playbooks') or {}

        def parents_of(key, nid):
            got = _first(parents.get(key), parents.get(nid) if not isinstance(nid, str) else None, [])
            return list(got.values()) if isinstance(got, dict) else list(got)

        layers = analyzed['layers']
        layers = list(layers.values()) if isinstance(layers, dict) else list(layers)
        inst = ['    # -- nodes (one executor per canvas node) --------------------------------',
                '    start_node = StartExecutor(node_id=' + py_str(startId) + ')']
        edges = []
        for layer in layers:
            for nid in (list(layer.values()) if isinstance(layer, dict) else list(layer)):
                key = php_strval(nid)
                if key == startId or key not in vars_:
                    continue
                pKept = [p for p in parents_of(key, nid) if php_strval(p) == startId or php_strval(p) in vars_]
                pPy = '[' + ', '.join(py_str(php_strval(p)) for p in pKept) + ']'
                dn = displayName[key].replace('"', "'")
                if key == outId:
                    inst.append('    output_node = OutputNodeExecutor(parents=' + pPy + ', node_id=' + py_str(key) + ')')
                elif key in code:
                    inst.append('    ' + vars_[key] + ' = CodeNodeExecutor(node_id=' + py_str(key)
                                + ', parents=' + pPy + ', id=' + py_str(vars_[key]) + ')' + '  # "' + dn + '" -- CODE')
                elif key in playbooks:
                    inst.append('    ' + vars_[key] + ' = PlaybookNodeExecutor(node_id=' + py_str(key)
                                + ', parents=' + pPy + ', id=' + py_str(vars_[key]) + ')' + '  # "' + dn + '" -- PLAYBOOK')
                elif key in menus:
                    menuPy = '[' + ', '.join('(' + py_str(php_strval(t['id'])) + ', ' + py_str(php_strval(t['name'])) + ')'
                                             for t in menus[key]) + ']'
                    inst.append('    ' + vars_[key] + ' = DispatcherNodeExecutor(node_id=' + py_str(key)
                                + ', parents=' + pPy + ', id=' + py_str(vars_[key]) + ', menu=' + menuPy + ')'
                                + '  # "' + dn + '" -- DISPATCHER')
                else:
                    inst.append('    ' + vars_[key] + ' = AgentNodeExecutor(node_id=' + py_str(key)
                                + ', parents=' + pPy + ', id=' + py_str(vars_[key]) + ')' + '  # "' + dn + '"')
        edges.append('    # -- edges (one add_edge per drawn connection) ---------------------------')
        for layer in layers:
            for nid in (list(layer.values()) if isinstance(layer, dict) else list(layer)):
                key = php_strval(nid)
                if key == startId or key not in vars_:
                    continue
                for p in parents_of(key, nid):
                    pKey = php_strval(p)
                    if pKey not in vars_:
                        continue
                    edges.append('    builder.add_edge(' + vars_[pKey] + ', ' + vars_[key] + ')'
                                 + '  # ' + displayName.get(pKey, pKey).replace('"', "'")
                                 + ' -> ' + displayName.get(key, key).replace('"', "'"))

        body = ('\n'.join(inst)
                + "\n\n    # -- graph assembly: Start is the entry executor; the Output executor is"
                + "\n    # -- explicitly declared as the workflow's output source (output_from)."
                + '\n    builder = WorkflowBuilder(start_executor=start_node, output_from=[output_node])\n'
                + '\n'.join(edges))
        return ('def create_workflow():\n'
                '    """Reconstruct the visual editor canvas on MAF\'s graph API, 1:1.\n'
                '\n'
                '    Reading this function IS reading the canvas: every executor below is\n'
                '    one node (variable named after it), every add_edge is one drawn\n'
                '    connection. MAF\'s engine schedules execution from this topology --\n'
                '    nodes whose parents are all done run concurrently -- and the Output\n'
                '    executor\'s yield becomes the workflow result.\n'
                '    """\n'
                f'{body}\n'
                '\n'
                '    return builder.build()')


# MAFGenerator.php headerBlock(): the interpolating heredoc's text after the module docstring.
_HEADER_IMPORTS = '''import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from dataclasses import dataclass
try:
    from typing import Never  # Python 3.11+
except ImportError:          # pragma: no cover
    from typing_extensions import Never

import httpx
from dotenv import load_dotenv
from agent_framework import (
    Agent,
    ChatOptions,
    Executor,
    FunctionTool,
    WorkflowBuilder,
    WorkflowContext,
    handler,
)
from agent_framework.anthropic import AnthropicClient
from agent_framework.openai import OpenAIChatCompletionClient

# MAF does not auto-load .env. Provider keys and MCP headers come from this folder's own .env first, then
# the runner's python/.env -- one level up for the single file in scripts/, two for the package in
# scripts/<folder>/. load_dotenv never overrides, so the nearest value wins.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):
    load_dotenv(os.path.join(_d, ".env"))
PACKAGE_DIR = _HERE   # this program's folder: code/, skills/, start_documents/ and outputs/ are relative to it'''
