"""Port of backend/src/AgentTeam/Services/CompiledArchitectureDoc.php.

ARCHITECTURE.md for one ADK, MAF or NOOA compile, as LangGraphArchitectureDoc writes it for LangGraph: what
the emitted program is made of and how it runs, for THIS workflow, THIS target and THIS code structure
(single file, agents in separate files, A2A). Every class or function it describes is looked up in the
generated code first (a name the code does not define is left out).
"""
from __future__ import annotations

import re

from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_php import ucfirst
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.logger import error_log
from app.support.phpcompat import php_intval, php_strval


def _mid(i: str) -> str:
    """'n' + preg_replace('/\\W/', '_', $id): byte-wise."""
    return 'n' + re.sub(rb'\W', b'_', i.encode('utf-8')).decode('utf-8', errors='replace')


class CompiledArchitectureDoc:
    TARGETS = {
        'adk': 'Google ADK (Python)',
        'maf': 'Microsoft Agent Framework (Python)',
        'nooa': 'NVIDIA NOOA (Python)',
    }
    MODES = {
        'single': 'single file',
        'modular': 'agents in separate files',
        'a2a': 'A2A (one agent server per node)',
    }

    @staticmethod
    def _catalog(target: str) -> dict:
        """Per target: name => [where it lives ('runtime' | 'assembly' | 'server' | 'orchestrator'), description]."""
        shared = {
            '_call_mcp_tool': ['runtime', "Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain JSON or SSE replies) with that server's headers from `MCP_HEADERS_<SLUG>` in `.env` (`_mcp_headers`) and its URL, or `MCP_URL_<SLUG>` when it moved; `_call_mcp_tool_raw` returns the raw result a code node reads."],
            'CODE_HARNESS': ['runtime', "The code-node contract, a copy of the file the workflow editor runs: a code node's `run(input, call_tool)` runs under it (standard-library imports only, only the MCP servers checked on the node, its exits, its `error` exit, its timeout, `NODE_NAME`). In a package it is `code_harness.py`, and each code node's Python is a file under `code/`, read at every run."],
            'DecisionResult': ['runtime', 'Frozen record of one decision-model call (TypeSafe Jev, OpenAI Decisions...): its outcome (`routed`, `unclear`, `low_confidence`, `unavailable`, `error`), the chosen target, the confidence. A decision adapter (`JevRouter`, `OpenAIDecisionRouter`) returns it; a dispatcher routes with it and never falls back to the model.'],
            '_rec_node_start': ['runtime', "Run events: each node's start and completion (a code node's exit, a dispatcher's route) go to the run's recorder, which the listener sets (`_set_recorder`): the run log under `runs/` that `GET /live` streams to the editor's live canvas."],
            'RunRecorder': ['runtime', "Writes one run's events to `runs/<date>_<run id>.jsonl` (a quiet run, nothing to do, leaves no file) and to the console view (`ConsoleView`). `live_next` reads them back for `GET /live`."],
            'Listener': ['assembly', "The Start's schedule (`--cron`) or event trigger (`--watch`: an MCP tool such as `outlook.wait_for_new` that answers `ready` or `timeout`) as a loop: in the foreground for the CLI, in a background thread for `api.py` (`POST /listen`). One copy listens at a time (`.run.lock`). `make_listener()` builds it from the baked `START_MODE`, `DEFAULT_CRON` and `DEFAULT_WATCH`; `make_run_once()` is one recorded run."],
            'AgentSupervisor': ['orchestrator', 'Starts one Python process per agent server (`servers/<id>_<name>.py --port N`), relays its output with a `[name]` prefix, waits for each Agent Card (and its version) and stops them at the end.'],
            '_run_remote_node': ['orchestrator', 'Runs one node on its A2A server: sends its input as a task, streams its status lines, answers its gates (`_handle_gate`: the run server, the console, or `PLAYBOOK_GATE_MODE`) and reads the `result` artifact (text, route, notes, status).'],
            'NodeExecutor': ['server', "The A2A agent server's executor: a new task starts a node run (`run_node`), a follow-up message answers the gate it paused at (input-required). The Agent Card (`build_agent_card`) carries the workflow version the orchestrator checks."],
        }
        match target:
            case 'adk':
                own = {
                    '_make_model': ['runtime', "Maps a node's provider and model to an ADK model: Gemini natively, every other provider through LiteLLM; the node's Thinking attribute and the hard API constraints are applied here."],
                    'build_tools_from_catalog': ['runtime', "One typed `FunctionTool` per MCP tool the workflow uses (ADK reads each function's signature as the tool schema); each calls `_call_mcp_tool`."],
                    '_CodeAgent': ['runtime', 'A code node as an ADK agent: runs the node\'s Python through `CODE_HARNESS` in a worker thread, writes its output to `state["node_<id>"]` and the exit it took to `state["route_<id>"]`.'],
                    '_PlaybookAgent': ['runtime', 'A playbook node as an ADK agent: runs the shared playbook interpreter (native verbs, human gates, bound #Actions) and publishes its transcript as the node output.'],
                    '_DispatcherAgent': ['runtime', "A dispatcher node: its menu children are nested under it, and only the child it chooses runs -- through its decision model (`routing_mode`), else its chooser `LlmAgent` (the node itself, asked for one name). The chosen child reads the dispatcher's input; nothing chosen ends the branch (Not classified, or an error)."],
                    '_PassThroughAgent': ['runtime', 'The Output node: forwards what reached it verbatim (no model), so formatting such as HTML is never reworded.'],
                    '_Gate': ['runtime', "Wraps a node that sits after a choice (a code node with several exits, a dispatcher): it runs only when a parent ran and that parent's choice leads here, so an untaken branch is skipped with everything after it."],
                    '_attach_recording': ['runtime', "Sets ADK's before/after agent callbacks on every recorded node, so each node's start and completion reach the run events."],
                    'run_workflow': ['assembly', "One run: seeds the session with the prompt (and the Start's converted documents), runs `root_agent` through ADK's `Runner` and returns the Output node's answer."],
                }
            case 'maf':
                own = {
                    'ProviderClients': ['runtime', "Builds the MAF chat client and per-call options for each node's provider and model (Anthropic natively, every other provider through the OpenAI-compatible client, `ReasoningRoundTripClient` replaying reasoning where a model requires it)."],
                    'NodeMessage': ['runtime', "The typed message on every edge: the producer's id, name and text, plus `route_to` (a dispatcher's choice), `routes` (a code node's taken exit), `task` (a dispatcher's own input, what a code branch receives) and `skipped`."],
                    'StartExecutor': ['runtime', 'The Start node: records the prompt and sends it along every outgoing edge.'],
                    'AgentNodeExecutor': ['runtime', "An agent node: waits for every parent (fan-in barrier), skips when no parent's message reaches it (`_skip_node`), runs one MAF `Agent` turn with its tools, then its skill steps, and sends its text on."],
                    'DispatcherNodeExecutor': ['runtime', 'A dispatcher node: chooses one child -- its decision model (`DECISIONS`), else one chooser model turn -- and sends a message naming it; the other children skip and still report, so every barrier below completes.'],
                    'CodeNodeExecutor': ['runtime', 'A code node: runs its Python through `CODE_HARNESS`; with several exits its message names the children of the exit it took (`routes`).'],
                    'PlaybookNodeExecutor': ['runtime', 'A playbook node: runs the shared playbook interpreter and sends its transcript on.'],
                    'OutputNodeExecutor': ['runtime', "The Output node: merges what reached it verbatim (no model) and yields the workflow's answer."],
                    'ProgressReporter': ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'],
                    'create_workflow': ['assembly', "The canvas on MAF's graph API, 1:1: one executor per node, one `add_edge` per drawn connection, built with `WorkflowBuilder`."],
                    'run_workflow': ['assembly', "One run: builds the graph, runs it on the prompt and returns the Output's answer (or why a dispatcher did not route)."],
                }
            case 'nooa':
                own = {
                    'make_llm': ['runtime', "Builds the NOOA (UnifiedLLM) client for a node's provider and model; endpoints, key variables and the hard API constraints live here."],
                    'run_agent': ['runtime', "Runs one agent node: its framed input (the request plus each parent's output under its name), its NOOA `Agent` class, then each bound skill as a mandatory step."],
                    'run_dispatcher': ['runtime', "A dispatcher's chooser: asks the dispatcher's own model for one name from its menu and returns the chosen child with the task plus its notes."],
                    '_route_dispatcher': ['assembly', 'A dispatcher\'s choice: its decision model (Jev...) when its routing names one -- no model turn; unclear goes to the unclear branch when set, else "Not classified" -- otherwise `run_dispatcher`.'],
                    '_run_graph': ['assembly', "The driver: walks `GRAPH` layer by layer; the nodes of a layer that the run reached run together (`asyncio.gather`). A node is reached when a parent ran and, for a routing parent (a dispatcher, a code node with several exits), that parent's choice leads here. The Output merges what reached it."],
                    'Progress': ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'],
                    'run_workflow': ['assembly', "One run: the Start's documents converted and placed before the prompt, then `_run_graph`."],
                }
            case _:
                own = {}
        out = dict(own)
        for k, v in shared.items():   # $own + $shared
            if k not in out:
                out[k] = v
        return out

    @classmethod
    def build(cls, analyzed: dict, target: str, mode: str, files: dict) -> str:
        """files: path => code of what the compile produced (a single file: one entry)."""
        code = '\n'.join(files.values())
        present: dict = {}
        for name, info in cls._catalog(target).items():
            n = re.escape(name)
            if re.search(r'^\s*(?:async\s+def|def|class)\s+' + n + r'\b|^' + n + r'\s*=', code, re.M | re.A):
                present[name] = info
        sections = [
            cls._overview(analyzed, target, mode),
            cls._filesSection(analyzed, target, mode, list(files.keys())),
            '## Class diagram\n\n```mermaid\n' + cls._classDiagram(target, present) + '```',
            '## Workflow diagram\n\n```mermaid\n' + cls._workflowDiagram(analyzed) + '```',
            cls._classesSection(mode, present),
            cls._runFlow(analyzed, target, mode),
            cls._changeSection(target, mode),
        ]
        return '\n\n'.join(sections) + '\n'

    @classmethod
    def attach(cls, result: dict, analyzed: dict, target: str, mode: str) -> dict:
        """result with its ARCHITECTURE.md ('architecture', and for a package the last file), or None on failure
        or for an ingestion pipeline."""
        result = dict(result)
        for n in (analyzed.get('byId') or {}).values():
            if WorkflowGraphAnalyzer.typeOf(n) in ('loader', 'splitter', 'vectorstore'):
                result.setdefault('architecture', None)
                return result
        files = {f['path']: f['code'] for f in result['files']} if 'files' in result else {result['filename']: result['code']}
        try:
            doc = cls.build(analyzed, target, mode, files)
        except Exception as e:  # noqa: BLE001 -- a companion never costs the user the code
            error_log(f'[CompiledArchitectureDoc] {target} {mode} ARCHITECTURE.md skipped: {e}')
            result.setdefault('architecture', None)
            return result
        if 'files' in result:
            result['files'] = list(result['files']) + [{'path': 'ARCHITECTURE.md', 'code': doc}]
        result['architecture'] = doc
        return result

    @classmethod
    def _overview(cls, analyzed: dict, target: str, mode: str) -> str:
        name = php_strval(analyzed['workflow']['name'])
        match mode:
            case 'single':
                shape = 'One Python file runs the whole workflow in one process: the runtime, every node and the command-line entry point.'
            case 'modular':
                shape = "One Python package runs the whole workflow in one process, in its own folder: `common.py` holds the runtime, each node is a module under `agents/`, `workflow.py` assembles the nodes and runs them (the Start's listener too), and `api.py` serves the run protocol the editor speaks."
            case _:
                shape = "Each agent, dispatcher and playbook node runs in an A2A agent server of its own (`servers/`); `orchestrator.py` starts them and walks the canvas, sending each node its input as an A2A task. The servers run their node with the package's runtime (`common.py`, `agents/`)."
        byId = analyzed.get('byId') or {}
        counts = []
        for k in ('start', 'dispatcher', 'agent', 'code', 'playbook', 'output'):
            n = len([i for i in byId if cls._kindOf(analyzed, php_strval(i)) == k])
            if n > 0:
                counts.append(f'{n} {k}' + ('s' if n > 1 and k != 'code' else (' nodes' if n > 1 else '')))
        return (f'# {name}: architecture\n\n'
                + 'Workflow ' + str(php_intval(analyzed['workflow']['id'])) + ' "' + name + '", compiled by the SynergyAI workflow editor to '
                + cls.TARGETS[target] + ', ' + cls.MODES[mode] + ' mode. ' + shape
                + ' The workflow has ' + str(len(byId)) + ' nodes: ' + ', '.join(counts) + '.'
                + ' Everything here is generated: change the workflow in the editor and generate again rather than editing the files.')

    @staticmethod
    def _kindOf(analyzed: dict, id_: str) -> str:
        t = WorkflowGraphAnalyzer.typeOf((analyzed.get('byId') or {}).get(id_) or {})
        if id_ in (analyzed.get('code') or {}):
            return 'code'
        if id_ in (analyzed.get('playbooks') or {}):
            return 'playbook'
        if id_ in WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']:
            return 'dispatcher'
        return 'agent' if t in ('agent', 'agent-template') else t

    @classmethod
    def _nameOf(cls, analyzed: dict, id_: str) -> str:
        cfg = (((analyzed.get('byId') or {}).get(id_) or {}).get('config')) or {}
        cfg = cfg if isinstance(cfg, dict) else {}
        v = None
        for cand in (((analyzed.get('code') or {}).get(id_) or {}).get('display'),
                     ((analyzed.get('playbooks') or {}).get(id_) or {}).get('display'),
                     ((analyzed.get('agents') or {}).get(id_) or {}).get('name')):
            if cand is not None:
                v = cand
                break
        if v is None:
            v = cfg.get('name') if cfg.get('name') is not None else ''
        v = php_strval(v)
        return v if v not in ('', '0') else ucfirst(cls._kindOf(analyzed, id_))

    @classmethod
    def _filesSection(cls, analyzed: dict, target: str, mode: str, paths: list) -> str:
        holds = {'adk': 'its ADK agent (`node_<id>`)',
                 'maf': 'its settings for the MAF executors (`NODE`, and `CODE_NODE` / `DECISION` / `PLAYBOOK` for those kinds)',
                 'nooa': 'its NOOA `Agent` class (the prompt is its docstring) and settings (`NODE`)'}[target]
        modules = {m['file']: [nid, m['display']] for nid, m in CompiledRuntimeEmit.moduleLayout(analyzed).items()}
        servers = {e['file']: [nid, e['display'], e['kind'], e['port']] for nid, e in CompiledA2AEmit.layout(analyzed).items()}
        rows = []
        seen: dict = {}
        for p in paths:
            if mode == 'single':
                role = 'The whole workflow: runtime, nodes, run and command-line entry point.'
            elif p == 'workflow.py':
                role = "Assembles the nodes and runs them: `run_workflow()`, the Start's listener (`make_listener`) and the command-line entry point."
            elif p == 'common.py':
                role = "The runtime every node uses (model clients, MCP client, tools, skills, the node classes, run events), plus the run server's shared pieces (run records, the live feed)."
            elif p == 'api.py':
                role = "Run server: the HTTP run protocol the editor uses to start a run, stream its events, answer human gates and (agents in separate files) listen for the Start's trigger (`POST /listen`, `GET /live`)."
            elif p == 'orchestrator.py':
                role = 'Starts the agent servers (`AgentSupervisor`) and walks the canvas, sending each node its input as an A2A task (`_run_remote_node`).'
            elif p == '__init__.py':
                role = 'Package marker.'
            elif p == 'agents/__init__.py':
                role = 'Package marker of the node modules.'
            elif p in modules:
                role = 'Node ' + modules[p][0] + ' "' + modules[p][1] + '": ' + holds + ', imported by `workflow.py`.'
            elif p in servers:
                role = ('Node ' + servers[p][0] + ' "' + servers[p][1] + '" (' + servers[p][2] + ') as an A2A agent server, port '
                        + str(servers[p][3]) + ' (`A2A_BASE_PORT` moves the range).')
            elif p == 'code_harness.py':
                role = 'The code-node contract, a copy of the file the workflow editor runs.'
            elif p.startswith('code/'):
                role = "A code node's Python, read at every run (edit it here to change the node until the next generation)."
            elif p == 'requirements.txt':
                role = 'The Python packages to install (`pip install -r requirements.txt`).'
            elif p == '.env.example':
                role = 'Every variable the program reads: provider keys, decision-model keys, MCP URLs and headers, output folder.'
            elif p == 'README.md':
                role = 'Install, run, serve.'
            elif p == 'ARCHITECTURE.md':
                role = 'This document.'
            else:
                role = None
            if p.startswith('skills/'):
                d = 'skills/' + p[7:].split('/')[0] + '/'
                p, role = d, 'Skill "' + d[7:-1] + '", copied with all its files.'
            elif p.startswith('start_documents/'):
                p, role = 'start_documents/', 'The documents attached to the Start node, copied.'
            if role is None or p in seen:
                continue
            seen[p] = True
            rows.append('| `' + p + '` | ' + role + ' |')
        if mode != 'single' and 'ARCHITECTURE.md' not in seen:
            rows.append('| `ARCHITECTURE.md` | This document. |')
        return '## Files\n\n| File | Role |\n|---|---|\n' + '\n'.join(rows)

    @classmethod
    def _classDiagram(cls, target: str, present: dict) -> str:
        L = ['classDiagram']
        match target:
            case 'adk':
                edges = [['_DispatcherAgent', 'DecisionResult', '..>', 'reads'], ['_CodeAgent', 'CODE_HARNESS', '-->', ''],
                         ['_Gate', '_DispatcherAgent', '-->', 'wraps'], ['_Gate', '_CodeAgent', '-->', 'wraps'],
                         ['run_workflow', '_attach_recording', '..>', ''], ['build_tools_from_catalog', '_call_mcp_tool', '-->', '']]
            case 'maf':
                edges = [['create_workflow', 'StartExecutor', '-->', ''], ['create_workflow', 'AgentNodeExecutor', '-->', ''],
                         ['create_workflow', 'DispatcherNodeExecutor', '-->', ''], ['create_workflow', 'CodeNodeExecutor', '-->', ''],
                         ['create_workflow', 'PlaybookNodeExecutor', '-->', ''], ['create_workflow', 'OutputNodeExecutor', '-->', ''],
                         ['AgentNodeExecutor', 'ProviderClients', '-->', ''], ['DispatcherNodeExecutor', 'DecisionResult', '..>', 'reads'],
                         ['CodeNodeExecutor', 'CODE_HARNESS', '-->', ''], ['AgentNodeExecutor', 'NodeMessage', '..>', 'sends']]
            case _:
                edges = [['run_workflow', '_run_graph', '-->', ''], ['_run_graph', 'run_agent', '-->', ''],
                         ['_run_graph', '_route_dispatcher', '-->', ''], ['_route_dispatcher', 'run_dispatcher', '..>', 'else'],
                         ['_route_dispatcher', 'DecisionResult', '..>', 'reads'], ['_run_graph', 'CODE_HARNESS', '-->', ''],
                         ['run_agent', 'make_llm', '-->', '']]
        edges += [['Listener', 'RunRecorder', '-->', 'each run'], ['AgentSupervisor', 'NodeExecutor', '..>', 'spawns'],
                  ['_run_remote_node', 'NodeExecutor', '..>', 'A2A task']]
        for a, b, arrow, label in edges:
            if a in present and b in present:
                L.append('    ' + cls._cls(a) + f' {arrow} ' + cls._cls(b) + (f' : {label}' if label != '' else ''))
        for n in present:
            L.append('    class ' + cls._cls(n))
        return '\n'.join(L) + '\n'

    @staticmethod
    def _cls(name: str) -> str:
        """Mermaid class names cannot start with "_": shown without it."""
        return name.lstrip('_')

    @classmethod
    def _workflowDiagram(cls, analyzed: dict) -> str:
        L = ['flowchart LR']
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        for i in analyzed.get('order') or []:
            i = php_strval(i)
            k = cls._kindOf(analyzed, i)
            label = cls._nameOf(analyzed, i).replace('"', "'") + ('' if k in ('start', 'output') else f' ({k})')
            match k:
                case 'start' | 'output':
                    shape = '(["' + label + '"])'
                case 'dispatcher':
                    shape = '{"' + label + '"}'
                case 'playbook':
                    shape = '[["' + label + '"]]'
                case 'code':
                    shape = '[/"' + label + '"/]'
                case _:
                    shape = '["' + label + '"]'
            L.append('    ' + _mid(i) + shape)
        for e in analyzed.get('edges') or []:
            frm = php_strval(e.get('from') if e.get('from') is not None else (e.get('from_node_id') or ''))
            to = php_strval(e.get('to') if e.get('to') is not None else (e.get('to_node_id') or ''))
            f = _mid(frm)
            t = _mid(to)
            if frm in menus:
                L.append(f'    {f} -.->|choice| {t}')
                continue
            ex = ''
            code = (analyzed.get('code') or {}).get(frm) or {}
            for x, kids in (code.get('exit_targets') or {}).items():
                if len(code['exits']) > 1 and to in [php_strval(c) for c in kids]:
                    ex = x
            L.append(f'    {f} -->|{ex}| {t}' if ex != '' else f'    {f} --> {t}')
        return '\n'.join(L) + '\n'

    @staticmethod
    def _classesSection(mode: str, present: dict) -> str:
        match mode:
            case 'single':
                where = 'Everything lives in the one file.'
            case 'modular':
                where = 'Runtime names live in `common.py`; assembly names (the run, the listener) in `workflow.py`; `agents/` only define nodes from them.'
            case _:
                where = 'Runtime names live in `common.py` (the agent servers import it), the graph walk and the supervisor in `orchestrator.py`, the A2A serving in each `servers/` file.'
        L = ['## Classes and functions', '', where]
        for name, (loc, desc) in present.items():
            if mode == 'single':
                file = ''
            elif loc == 'orchestrator':
                file = ' (`orchestrator.py`)'
            elif loc == 'server':
                file = ' (`servers/`)'
            elif loc == 'assembly' and mode != 'a2a':
                file = ' (`workflow.py`)'
            else:
                file = ' (`common.py`)'
            L += ['', f'### `{name}`{file}', '', desc]
        return '\n'.join(L)

    @classmethod
    def _runFlow(cls, analyzed: dict, target: str, mode: str) -> str:
        entry = {'single': 'python <file>.py "your prompt"', 'modular': 'python workflow.py "your prompt"'}.get(
            mode, 'python orchestrator.py "your prompt"')
        steps = [f'`{entry}`' + (' (or `api.py` calling `run()`): `AgentSupervisor` starts one agent server per node and waits for each Agent Card.'
                                 if mode == 'a2a' else
                                 (' (or `api.py` calling `run_workflow()`; with a schedule or an event trigger, the listener runs it on each tick or event).'
                                  if mode == 'modular' else
                                  " runs the workflow once on the prompt (the Start node's prompt when none is given)."))]
        if mode == 'a2a':
            steps.append("`run()` walks `GRAPH` layer by layer: each reached node gets the request plus its parents' outputs (`build_context`) as an A2A task (`_run_remote_node`), and the nodes of a layer run together.")
            steps.append('In its server, the node runs with the ' + cls.TARGETS[target] + ' runtime (`run_node`): an agent its model turn and skills, a dispatcher its decision model or chooser -- its `route` decides which children run -- a playbook its interpreter, whose gates come back to the orchestrator as input-required.')
        else:
            steps.append({
                'adk': "The Start's documents are converted to Markdown and put before the prompt; ADK's `Runner` runs `root_agent`: the canvas as topological layers (a `SequentialAgent` of `ParallelAgent` layers).",
                'maf': "The Start's documents are converted and put before the prompt; `create_workflow()` builds the graph and MAF runs it: `StartExecutor` sends the prompt along every edge, and every executor waits for all its parents (fan-in barrier).",
            }.get(target, "The Start's documents are converted and put before the prompt; `_run_graph` walks `GRAPH` layer by layer, the reached nodes of a layer together."))
            steps.append("An agent node runs its model with its MCP tools (each call through `_call_mcp_tool`, with its server's headers), then its skills in order.")
            if analyzed.get('code'):
                steps.append('A code node runs its Python under `CODE_HARNESS`; with several exits, the exit it took decides which children run (the others are skipped, with everything that only follows them).')
            if WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']:
                steps.append('A dispatcher chooses one child: through its decision model when its routing names one (no model turn; unclear goes to the unclear branch when set, else "Not classified"), else through one chooser model turn. Only the chosen child runs; a code branch receives the dispatcher\'s own input. When nothing is chosen, the dispatcher\'s message is the answer.')
            if analyzed.get('playbooks'):
                steps.append('A playbook node runs the playbook interpreter; its human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run server. Its output is the transcript.')
        steps.append("The Output node merges what reached it verbatim; that is the answer, printed and, when the Output node's storage is on, saved under `outputs/`.")
        if mode == 'modular':
            steps.append("Each node's start and completion go to the run's recorder (`runs/`), which `GET /live` streams to the editor's live canvas.")
        L = ['## How a run flows', '']
        for i, s in enumerate(steps):
            L.append(f'{i + 1}. {s}')
        return '\n'.join(L)

    @staticmethod
    def _changeSection(target: str, mode: str) -> str:
        gen = {'adk': 'ADKGenerator', 'maf': 'MAFGenerator', 'nooa': 'NOOAGenerator'}[target]
        L = ['## How to change it', '']
        L.append('- **Add or change a node** (prompt, model, tools, skills, routing, code): edit the workflow in the editor and generate again'
                 + ('.' if mode == 'single' else ': each node is regenerated in its own file.'))
        L.append("- **Change behaviour**: the runtime is emitted by the compiler (the backend's `" + gen + '`, `CompiledRuntimeEmit`'
                 + (', `CompiledA2AEmit`' if mode == 'a2a' else '') + '). Change it there, never by hand-editing the output: the next generation overwrites it.')
        L.append("- **Keys and MCP headers** come from `.env`: the program's own folder first, then the runner's `python/.env` (which the editor refreshes on every generation). `.env.example` lists every variable.")
        if mode == 'a2a':
            L.append('- **Move an agent**: set `A2A_AGENT_<id>_URL` (and start the orchestrator with `--no-spawn` when every agent runs elsewhere); `A2A_BASE_PORT` moves the whole port range.')
        return '\n'.join(L)
