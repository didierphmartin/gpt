"""Port of backend/src/AgentTeam/Services/LangGraphArchitectureDoc.php.

ARCHITECTURE.md for one LangGraph compile: what the emitted package is made of and how it runs,
written for THIS workflow and THIS mode (single file, modular package or A2A). Every name it prints
is one LangGraphGenerator / LangGraphRuntime actually emits for the mode.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiler_php import ucfirst
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


class LangGraphArchitectureDoc:
    MODE_LABELS = {
        'single': 'single file',
        'modular': 'modular package',
        'a2a': 'A2A (one agent server per node)',
    }

    @classmethod
    def build(cls, facts: dict, mode: str) -> str:
        """The Markdown document. facts is LangGraphGenerator._analyzeForEmit()'s result; mode is
        'single', 'modular' or 'a2a'."""
        classes = cls._presentClasses(facts, mode)
        sections = [
            cls._overview(facts, mode),
            cls._filesSection(facts, mode),
            '## Class diagram\n\n```mermaid\n' + cls._classDiagram(classes, mode) + '```',
            '## Workflow diagram\n\n```mermaid\n' + cls._workflowDiagram(facts) + '```',
            cls._classesSection(facts, mode, classes),
            cls._runFlowSection(facts, mode),
            cls._changeSection(facts, mode),
        ]
        return '\n\n'.join(sections) + '\n'

    @staticmethod
    def _presentClasses(facts: dict, mode: str) -> list:
        withPlaybook = bool(facts.get('playbookData'))
        classes = ['WorkflowGraph', 'Node', 'AgentNode', 'DispatcherNode']
        if withPlaybook:
            classes.append('PlaybookNode')
        classes += ['NodeKind', 'Dispatcher']
        adapters: dict = {}
        for ad in (facts.get('agentData') or {}).values():
            for c in ad.get('decision') or []:
                adapters[LangGraphRuntime.ADAPTER_CLASSES[c['protocol']]] = True
        classes += list(adapters.keys())
        classes += ['DecisionResult', 'RouteDecision', 'ToolCatalog', 'McpClient', 'SkillRuntime', 'RunEvents']
        if withPlaybook:
            classes += ['PlaybookRun', 'PlaybookToolset']
        classes.append('DocumentConverter')
        if mode == 'a2a':
            classes += ['AgentSupervisor', 'NodeExecutor']
        return classes

    @classmethod
    def _overview(cls, facts: dict, mode: str) -> str:
        name = facts['wfName']
        counts = cls._nodeCounts(facts)
        match mode:
            case 'single':
                where = ('One self-contained Python script runs the whole workflow in one process: it holds the '
                         'runtime classes, the frozen settings of every node and the graph.')
            case 'modular':
                where = ('One Python package runs the whole workflow in one process. `workflow.py` wires the '
                         'LangGraph graph, `common.py` holds every runtime class, and each agent or playbook node is a '
                         'small data module under `agents/`.')
            case _:
                where = ('`orchestrator.py` runs the LangGraph graph and calls every agent or playbook node over the '
                         'A2A protocol (HTTP). Each node is its own agent server under `agents/`: a self-contained file '
                         'with its own copy of the runtime classes it needs, so it can be deployed alone. By default the '
                         'orchestrator starts those servers itself on local ports.')
        return (f'# {name}: architecture\n\n'
                + f'Workflow {facts["workflowId"]} "{name}", compiled by the SynergyAI workflow editor to LangGraph '
                + '(Python), ' + cls.MODE_LABELS[mode] + f' mode. {where} The workflow has {counts}. '
                + 'Everything here is generated: change the workflow in the editor and generate again rather than '
                + 'editing the files.')

    @classmethod
    def _nodeCounts(cls, facts: dict) -> str:
        n: dict = {}
        for nid in facts['order']:
            kind = cls._kindOf(facts, str(nid))
            n[kind] = n.get(kind, 0) + 1
        parts = []
        for kind, c in n.items():
            parts.append(f'{c} {kind}' + (('es' if kind == 'dispatcher' else 's') if c > 1 else ''))
        return str(len(facts['order'])) + ' nodes: ' + ', '.join(parts)

    @staticmethod
    def _kindOf(facts: dict, nid: str) -> str:
        if nid in (facts.get('agentData') or {}):
            return 'dispatcher' if facts['agentData'][nid].get('dispatch') else 'agent'
        if nid in (facts.get('playbookData') or {}):
            return 'playbook'
        if nid in (facts.get('codeData') or {}):
            return 'code'
        return WorkflowGraphAnalyzer.typeOf(facts['byId'].get(nid) or {})

    @classmethod
    def _nameOf(cls, facts: dict, nid: str) -> str:
        for k in ('agentData', 'playbookData', 'codeData'):
            d = (facts.get(k) or {}).get(nid)
            if d is not None and d.get('display') is not None:
                return d['display']
        return ucfirst(cls._kindOf(facts, nid))

    @classmethod
    def _filesSection(cls, facts: dict, mode: str) -> str:
        from app.agent_team.services.lang_graph_generator import LangGraphGenerator
        rows = []

        def agentRole(e: dict, nid) -> str:
            return f'Node {nid} "' + cls._cell(e['display']) + f'" ({e["kind"]})'

        match mode:
            case 'single':
                rows.append([f'{facts["safeName"]}_langgraph.py', "The whole workflow: the runtime classes, every node's "
                             + 'frozen settings (`AGENTS`, `PLAYBOOKS`), the graph structure (`EDGES`, `ORDER`, `NODE_TYPES`), '
                             + 'the node runner `_run_local_node` and the command-line entry point.'])
                principle = ('One file, read top to bottom: the classes first, then the node settings (data), then '
                             'the graph and `__main__`. Node settings are data; the classes are behaviour.')
            case 'modular':
                layout = LangGraphGenerator.modularLayout(facts)
                rows.append(['workflow.py', 'Wires the graph: the agent table (`AGENTS`), `EDGES`, `ORDER`, `NODE_TYPES`, '
                             + 'the node runner `_run_node_module` that calls each agent module, and the command-line entry point.'])
                rows.append(['common.py', 'Behaviour: every runtime class (nodes, dispatcher, Jev, tools, MCP, skills, events'
                             + ('' if not facts.get('playbookData') else ', playbook') + ', documents, graph), the LLM factory '
                             + '`_make_llm`, `save_output` and `print_run_summary`.'])
                rows.append(['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
                             + 'and answer human gates. It drives `workflow.py`; it holds no graph.'])
                rows.append(['agents/__init__.py', 'Package marker of the agent modules.'])
                for nid, e in layout['agents'].items():
                    rows.append([e['file'], agentRole(e, nid) + ': its `NODE` settings and `run_node = make_node(NODE).run`.'])
                rows += cls._packageRows(facts)
                principle = ('Agent files are data (`NODE` + `run_node = make_node(NODE).run`), `common.py` is behaviour, '
                             '`workflow.py` wires the graph.')
            case _:
                layout = LangGraphGenerator.a2aLayout(facts)
                rows.append(['orchestrator.py', 'Runs the graph (`WorkflowGraph`) and calls each node over A2A '
                             + '(`_run_remote_node`); `AgentSupervisor` starts and stops the agent servers; holds no node logic.'])
                rows.append(['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
                             + 'and answer human gates. It drives `orchestrator.py` and starts the agent servers.'])
                for nid, e in layout['agents'].items():
                    rows.append([e['file'], agentRole(e, nid) + f': a self-contained A2A server (port {e["port"]}): '
                                 + 'its `NODE` settings, `run_node = make_node(NODE).run`, the runtime classes it needs and `NodeExecutor`.'])
                principle = ('Each agent file is one deployable server: its data (`NODE`), '
                             '`run_node = make_node(NODE).run`, and its own copy of the classes it needs. `orchestrator.py` wires '
                             'the graph and never runs a model itself.')
        rows.append(['ARCHITECTURE.md', 'This document.'])
        L = ['## Files', '', '| File | Role |', '|---|---|']
        for file, role in rows:
            L.append(f'| `{file}` | {role} |')
        L.append('')
        L.append(principle)
        return '\n'.join(L)

    @classmethod
    def _packageRows(cls, facts: dict) -> list:
        rows = []
        if facts.get('codeData'):
            rows.append(['code_harness.py', 'The code-node sandbox, the same file the editor runs: standard library only, '
                         + "network only through `call_tool`, one of the node's exits, its timeout."])
            for nid, cd in facts['codeData'].items():
                if 'source_file' in cd:
                    rows.append([cd['source_file'], f'Node {nid} "' + cls._cell(cd['display']) + '" (code): its '
                                 + '`run(input, call_tool)`, read at each run, so an edit takes effect on the next run.'])
        rows.append(['requirements.txt', 'The Python packages to install (`pip install -r requirements.txt`).'])
        rows.append(['.env.example', 'Every variable the program reads: provider keys, MCP URLs and headers, output and run folders.'])
        rows.append(['README.md', 'Install, modes, files written, the run server, running as a service.'])
        for d in LangGraphPackage.skillDirs(facts):
            rows.append([f'skills/{d}/', 'Skill "' + cls._cell(d) + '", copied with all its files: what `SkillRuntime` runs.'])
        for doc in facts.get('startDocuments') or []:
            path = str(doc.get('path') or '') if isinstance(doc, dict) else ''
            if path.startswith('start_documents/'):
                rows.append(['start_documents/', "The Start node's documents, converted to Markdown by `DocumentConverter` at each run."])
                break
        return rows

    @staticmethod
    def _classDiagram(classes: list, mode: str) -> str:
        has = set(classes)
        L = ['classDiagram']
        L += ['    class Node {', '        <<abstract>>', '        +cfg', '        +llm', '        +tools',
              '        +run(request, trace)', '    }']
        L += ['    class NodeKind {', '        <<enumeration>>', '        AGENT', '        DISPATCHER']
        if 'PlaybookNode' in has:
            L.append('        PLAYBOOK')
        L.append('    }')
        L += ['    class WorkflowGraph {', '        +compile()', '        +run(prompt)', '    }']
        L += ['    class Dispatcher {', '        +mode()', '        +route(task, msgs, make_llm)', '    }']
        relations = [
            ['Node', '<|--', 'AgentNode', ''],
            ['Node', '<|--', 'DispatcherNode', ''],
            ['Node', '<|--', 'PlaybookNode', ''],
            ['Node', '..>', 'NodeKind', 'make_node'],
            ['DispatcherNode', '-->', 'Dispatcher', ''],
            ['Dispatcher', '-->', 'JevRouter', ''],
            ['Dispatcher', '-->', 'OpenAIDecisionRouter', ''],
            ['Dispatcher', '..>', 'RouteDecision', 'returns'],
            ['Dispatcher', '..>', 'DecisionResult', 'reads'],
            ['JevRouter', '..>', 'DecisionResult', 'returns'],
            ['OpenAIDecisionRouter', '..>', 'DecisionResult', 'returns'],
            ['AgentNode', '-->', 'ToolCatalog', ''],
            ['AgentNode', '-->', 'SkillRuntime', ''],
            ['ToolCatalog', '-->', 'McpClient', ''],
            ['PlaybookNode', '-->', 'PlaybookRun', ''],
            ['PlaybookNode', '-->', 'PlaybookToolset', ''],
            ['PlaybookRun', '-->', 'RunEvents', 'events and gates'],
            ['WorkflowGraph', '-->', 'DocumentConverter', 'start node'],
        ]
        if mode == 'a2a':
            # The graph reaches a node only through its server's executor.
            relations.append(['WorkflowGraph', '..>', 'NodeExecutor', 'A2A task'])
            relations.append(['NodeExecutor', '-->', 'Node', 'run_node'])
            relations.append(['AgentSupervisor', '..>', 'NodeExecutor', 'starts the servers'])
        else:
            relations.append(['WorkflowGraph', '-->', 'Node', 'run_node'])
        for a, arrow, b, label in relations:
            if a in has and b in has:
                L.append(f'    {a} {arrow} {b}' + (f' : {label}' if label != '' else ''))
        # A class no relation above names still gets drawn.
        for c in ['RunEvents', 'ToolCatalog', 'SkillRuntime', 'McpClient', 'DocumentConverter']:
            if c in has:
                L.append(f'    class {c}')
        return '\n'.join(L) + '\n'

    @classmethod
    def _workflowDiagram(cls, facts: dict) -> str:
        L = ['flowchart LR']
        inn = set()
        for nid in facts['order']:
            nid = str(nid)
            inn.add(nid)
            kind = cls._kindOf(facts, nid)
            label = cls._nameOf(facts, nid).replace('"', '#quot;')
            if kind not in ('start', 'output'):
                label += f' ({kind})'
            match kind:
                case 'start' | 'output':
                    shape = f'(["{label}"])'
                case 'dispatcher':
                    shape = '{"' + label + '"}'
                case 'playbook':
                    shape = f'[["{label}"]]'
                case 'code':
                    shape = f'[/"{label}"/]'
                case _:
                    shape = f'["{label}"]'
            L.append('    ' + cls._mid(nid) + shape)
        for frm, to in facts['edgeList']:
            frm = str(frm)
            to = str(to)
            if frm not in inn or to not in inn:
                continue
            menu = [str(t['id']) for t in ((facts.get('agentData') or {}).get(frm, {}).get('dispatch') or [])]
            arrow = '-.->|choice|' if to in menu else '-->'
            L.append('    ' + cls._mid(frm) + f' {arrow} ' + cls._mid(to))
        return '\n'.join(L) + '\n'

    @staticmethod
    def _mid(nid: str) -> str:
        """A Mermaid-safe node id (preg_replace('/\\W/', '_') is byte-wise)."""
        return 'n' + re.sub(rb'\W', b'_', nid.encode('utf-8')).decode('utf-8', errors='replace')

    @staticmethod
    def _classesSection(facts: dict, mode: str, classes: list) -> str:
        match mode:
            case 'single':
                runNode = '`_run_local_node`, which calls the node in this process'
            case 'modular':
                runNode = "`workflow.py`'s `_run_node_module`, which calls the node's agent module"
            case _:
                runNode = "`orchestrator.py`'s `_run_remote_node`, which sends the node an A2A task"
        noDispatcher = not [ad for ad in facts['agentData'].values() if ad.get('dispatch')]
        unused = ' This workflow has no dispatcher node, so it is emitted but not used.' if noDispatcher else ''
        text = {
            'WorkflowGraph': 'Builds the LangGraph `StateGraph` from the frozen `EDGES`, `ORDER` and `NODE_TYPES` and runs '
                + 'it (`run(prompt)`). Start and Output run inside it with no LLM; every agent or playbook node goes through '
                + f"the `run_node` the mode supplies, here {runNode}. A dispatcher's menu children hang off one conditional "
                + 'edge, so only the chosen child runs.',
            'Node': "Abstract base of the node kinds. Holds the node's frozen settings (`cfg`) and builds its chat model "
                + '(`llm`, through `_make_llm`) and its catalog tools on first use, so a missing provider package or key '
                + 'fails only that node. `run(request, trace)` returns `{"text", "route", "notes", "status"}`; '
                + '`make_node(cfg)` builds the subclass for `cfg["kind"]`.',
            'AgentNode': 'An agent node: a LangChain ReAct loop (`create_react_agent`) over its MCP tools, then its mandatory '
                + "skill steps in order; the last skill's produced file becomes the node's output.",
            'DispatcherNode': 'A dispatcher node: no ReAct loop. It asks its `Dispatcher` for one child and returns that '
                + "child's id as `route`." + unused,
            'PlaybookNode': 'A playbook node: runs the playbook interpreter (a ReAct loop over the `PlaybookToolset`, with '
                + 'a `PlaybookRun` recording it) and returns the Markdown transcript of what the playbook did.',
            'NodeKind': 'Enum of the node kinds `make_node` matches on (`agent`, `dispatcher`'
                + (', `playbook`' if 'PlaybookNode' in classes else '') + ').',
            'Dispatcher': 'Picks exactly one child for a dispatcher node, through a decision model or through one forced '
                + "`route_to` model call, never both. `mode()` reads the node's routing mode: `llm`, a decision provider, "
                + 'or unset (the first compiled decision model whose key is set, else the model). Returns a '
                + '`RouteDecision`; no choice means the run stops at the dispatcher.' + unused,
            'JevRouter': 'Client for TypeSafe Jev (the `typesafe` decision protocol): asks a closed routing question over '
                + "the dispatcher's menu (plus an `unclear` option) and returns a `DecisionResult`. It never raises.",
            'OpenAIDecisionRouter': "Client for OpenAI's Decisions API, GPT-6 Luna (the `openai` decision protocol): asks "
                + "a closed routing question over the dispatcher's menu (plus an `unclear` option) and returns a "
                + '`DecisionResult`. It never raises.',
            'DecisionResult': 'Frozen record of one decision-model call: its outcome (`routed`, `unclear`, `low_confidence`, '
                + '`unavailable`, `error`), the chosen target, the confidence and the evidence.',
            'RouteDecision': "Frozen record of a dispatcher's answer: the text its child receives, the chosen child's id "
                + '(`route`, empty when none), notes and status.',
            'ToolCatalog': "The workflow's tools, built once on first use: turns the baked catalog (tool name, MCP server "
                + 'URL, description, JSON Schema) into LangChain tools that call `McpClient`, plus the local '
                + '`run_skill_script`. Each node takes its own tools by name.',
            'McpClient': 'Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain '
                + 'JSON or SSE replies) and returns its text.',
            'SkillRuntime': 'Runs folder-backed skills as Python subprocesses (the skills folder, the `/outputs` and '
                + '`/scratch` folders, installed dependencies), so a skill step can hand the document it produced on as '
                + "the node's output.",
            'RunEvents': "The run's event stream and human-gate rendezvous. `api.py` installs a sink "
                + '(`set_event_sink`) and receives every event; a human gate waits on it until `resolve_gate` answers. '
                + 'One instance, `EVENTS`, per process; it does nothing when nobody watches.',
            'PlaybookRun': 'One playbook run: its event timeline, status and write ledger. It answers the human gates (on '
                + 'the console, by `PLAYBOOK_GATE_MODE`, through the run server'
                + (', or through the A2A gate bridge' if mode == 'a2a' else '') + ') and renders the transcript.',
            'PlaybookToolset': 'The whitelisted tools of one playbook run: native verbs, human gates and the bound '
                + "#Actions (MCP calls). Every call is recorded on the run's timeline.",
            'DocumentConverter': 'Converts a file attached to the Start node to Markdown: text formats verbatim; `.docx`, '
                + "`.pptx`, `.xlsx` and `.pdf` through parsers imported only when needed. Used by the graph's start node.",
            'AgentSupervisor': 'In `orchestrator.py`: starts one agent server per node (ports from 8701, moved by '
                + '`A2A_BASE_PORT`), waits for each Agent Card and checks its version, relays their output, and stops '
                + 'them after the run unless `--keep-serving`.',
            'NodeExecutor': 'In each agent file: the A2A executor. A new task runs the node through `run_node` and '
                + "returns the result (a dispatcher's chosen child travels in its data part); a follow-up message "
                + 'answers a gate the node is waiting on.',
        }
        match mode:
            case 'single':
                where = f'All classes live in `{facts["safeName"]}_langgraph.py`.'
            case 'modular':
                where = 'All classes live in `common.py`; the agent modules and `workflow.py` only import them.'
            case _:
                where = ('`orchestrator.py` holds `WorkflowGraph`, `DocumentConverter`, `RunEvents` and `AgentSupervisor`. '
                         + 'Each agent file holds its own copy of the node-side classes: `Node` with the agent and dispatcher '
                         + 'subclasses' + ('' if not facts.get('playbookData') else ' (and `PlaybookNode`, `PlaybookRun`, `PlaybookToolset` in a playbook agent)')
                         + ', the dispatcher and Jev classes, tools, MCP, skills, `RunEvents` and `NodeExecutor`.')
        L = ['## Classes', '', where]
        for c in classes:
            L += ['', f'### {c}', '', text[c]]
        return '\n'.join(L)

    @staticmethod
    def _runFlowSection(facts: dict, mode: str) -> str:
        match mode:
            case 'single':
                entry = f'`python {facts["safeName"]}_langgraph.py "your prompt"` (or code that imports the script and awaits its `run()`) builds the graph.'
                call = "`_run_local_node` runs the node's `Node.run` in this process"
            case 'modular':
                entry = '`python workflow.py "your prompt"` (or `api.py` calling `run()`) builds the graph over the agent modules.'
                call = "`_run_node_module` calls the node's module, `agents/<name>.py`, whose `run_node` is its `Node.run`"
            case _:
                entry = ('`python orchestrator.py "your prompt"` (or `api.py` calling `run()`) first has `AgentSupervisor` '
                         + 'start one agent server per node and wait until each serves its Agent Card, then builds the graph.')
                call = ("`_run_remote_node` sends an A2A task to the node's server, whose `NodeExecutor` calls `run_node` "
                        + '(its `Node.run`) and streams status updates back')
        hasPb = bool(facts.get('playbookData'))
        steps = [
            entry,
            '`WorkflowGraph.run(prompt)` compiles the `StateGraph` (one graph node per workflow node, in `ORDER`) and invokes it.',
            'The Start node passes the prompt on; files attached to it are converted to Markdown by `DocumentConverter` '
            + 'and placed before the prompt.',
            'Each agent' + ('' if not hasPb else ' or playbook') + ' node receives its framed input '
            + "(`build_context`: the original prompt plus each parent's output under its name"
            + ('' if not hasPb else "; a playbook gets its parents' texts joined") + f'), and {call}. '
            + "The node's time is recorded for the summary.",
            'An agent node (`AgentNode`) runs its ReAct loop over its tools (`ToolCatalog` calling MCP servers through '
            + '`McpClient`), then each attached skill (`SkillRuntime`) on the answer.',
        ]
        dispatchers = [ad for ad in facts['agentData'].values() if ad.get('dispatch')]
        if dispatchers:
            modes = []
            for ad in dispatchers:
                m = ad.get('routing_mode') or ''
                modes.append(f'"{ad["display"]}": ' + ('the model' if m == 'llm'
                             else ('the first decision model whose key is set, else the model' if m == '' else f'decision model `{m}`')))
            adapters: dict = {}
            for ad in dispatchers:
                for c in ad.get('decision') or []:
                    adapters['`' + LangGraphRuntime.ADAPTER_CLASSES[c['protocol']] + '`'] = True
            adapterList = ', '.join(adapters.keys()) if adapters else '`JevRouter`'
            steps.append('A dispatcher node (`DispatcherNode`) asks its `Dispatcher`, which routes with a decision model (' + adapterList + ') or '
                         + 'with one forced `route_to` model call, never both (' + '; '.join(modes) + '). The chosen '
                         + "child's id comes back as `route` and drives the conditional edge, so only that child runs. When "
                         + 'nothing is chosen (the decision model unclear or below its confidence floor, no key, an error), the run stops there '
                         + "and the dispatcher's message is the result.")
        if hasPb:
            steps.append('A playbook node (`PlaybookNode`) runs the playbook with a `PlaybookRun` and its `PlaybookToolset`; '
                         + 'human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run '
                         + 'server' + (' (from an agent server, through the orchestrator)' if mode == 'a2a' else '') + '. Its output is the transcript.')
        storage = 'ON, so the result is saved' if facts['workflow'].isOutputStorageEnabled() else 'OFF, so the result is only printed'
        steps.append("The Output node takes its lone parent's text verbatim, or every parent's text under its name.")
        steps.append(f"The final output is printed, `save_output` applies the Output node's storage setting ({storage}), "
                     + 'and `print_run_summary` prints the RUN SUMMARY (time per node, total time, where the document went).'
                     + (' The supervisor then stops the agent servers unless `--keep-serving`.' if mode == 'a2a' else ''))
        L = ['## How a run flows', '']
        for i, s in enumerate(steps):
            L.append(f'{i + 1}. {s}')
        return '\n'.join(L)

    @staticmethod
    def _changeSection(facts: dict, mode: str) -> str:
        match mode:
            case 'single':
                newAgent = 'a new entry in `AGENTS` in the script'
                runtime = 'the runtime classes in the script'
            case 'modular':
                newAgent = 'a new data file `agents/<name>.py` (its `NODE`) and its entry in `workflow.py`'
                runtime = 'the runtime classes in `common.py`'
            case _:
                newAgent = 'a new agent server `agents/<id>_<name>.py` and its entry in `orchestrator.py`'
                runtime = 'the runtime classes in `orchestrator.py` and the agent files'
        keys: dict = {}
        for d in list(facts['agentData'].values()) + list(facts['playbookData'].values()):
            k = PythonEmitHelpers.providerKeyEnv(d['provider']) if (d.get('provider') or '') != '' else None
            if k is not None:
                keys.setdefault(k, []).append(d['provider'].lower())
        keyList = [f'`{k}` (' + ', '.join(_unique(provs)) + ')' for k, provs in keys.items()]
        hasDispatcher = bool([ad for ad in facts['agentData'].values() if ad.get('dispatch')])
        L = ['## How to change it', '']
        L.append('- **Add an agent**: add the node on the workflow canvas, connect it, and generate again. That gives '
                 + f'{newAgent}, plus its edges in `EDGES`.')
        L.append(f"- **Change behaviour**: {runtime} are emitted by the compiler (the backend's `LangGraphRuntime` and "
                 + '`LangGraphGenerator`). Change them there, never by hand-editing the output: the next generation overwrites it.')
        L.append("- **Change a node's settings** (prompt, model, tools, skills, routing): edit the node in the editor and generate again.")
        L.append('- **Keys** come from `.env` in the runner folder (`python/.env`), which the editor refreshes on every '
                 + 'generation: ' + (', '.join(keyList) if keyList else 'no provider key is needed by this workflow')
                 + ('; one `<PROVIDER>_API_KEY` per decision model' if hasDispatcher else '') + '.')
        return '\n'.join(L)

    @staticmethod
    def _cell(s: str) -> str:
        """Text safe inside a Markdown table cell."""
        return s.replace('|', '\\|').replace('\n', ' ').replace('\r', ' ')
