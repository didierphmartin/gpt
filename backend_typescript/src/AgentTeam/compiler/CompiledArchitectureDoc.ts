import { array_column, count, entries, has, in_array, keysOf, ltrim, oarr, preg_match, preg_quote, str_replace, str_starts_with, strval, substr, toArr, truthy, ucfirst, values } from './php';
import { GraphAnalyzer } from './GraphAnalyzer';
import { CompiledRuntimeEmit } from './CompiledRuntimeEmit';
import { CompiledA2AEmit } from './CompiledA2AEmit';

type Entry = [string, string];

/** isset($a[$k1][$k2]...) over any PHP array shape. */
function isset(v: any, ...ks: string[]): boolean {
  let cur = v;
  for (const k of ks) {
    if (!has(cur, k)) return false;
    cur = cur[k];
  }
  return true;
}

/** preg_replace('/\W/', '_', $s) as PHP runs it without /u: every byte outside [A-Za-z0-9_] becomes "_". */
function wordId(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    out += (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f ? String.fromCharCode(b) : '_';
  }
  return out;
}

/**
 * ARCHITECTURE.md for one ADK, MAF or NOOA compile, as LangGraphArchitectureDoc writes it for LangGraph: what
 * the emitted program is made of and how it runs, for THIS workflow, THIS target and THIS code structure
 * (single file, agents in separate files, A2A). Overview, files, class diagram, workflow diagram, classes,
 * how a run flows, how to change it.
 *
 * Every class or function it describes is looked up in the generated code first (a name the code does not
 * define is left out), so the document cannot describe something the compile did not produce;
 * CompiledArchitectureDocTest checks it. Mirrors backend/src/AgentTeam/Services/CompiledArchitectureDoc.php.
 */
export class CompiledArchitectureDoc
{
    private static readonly TARGETS: Record<string, string> = {
        adk: 'Google ADK (Python)',
        maf: 'Microsoft Agent Framework (Python)',
        nooa: 'NVIDIA NOOA (Python)',
    };

    private static readonly MODES: Record<string, string> = {
        single: 'single file',
        modular: 'agents in separate files',
        a2a: 'A2A (one agent server per node)',
    };

    /**
     * Per target: name => [where it lives ('runtime' | 'assembly' | 'server' | 'orchestrator'), description].
     * Runtime names are in common.py in a package, assembly names in workflow.py; the single file holds both.
     */
    private static catalog(target: string): Record<string, Entry> {
        const shared: Record<string, Entry> = { _call_mcp_tool: ['runtime', 'Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain JSON or SSE replies) with that server\'s headers from `MCP_HEADERS_<SLUG>` in `.env` (`_mcp_headers`) and its URL, or `MCP_URL_<SLUG>` when it moved; `_call_mcp_tool_raw` returns the raw result a code node reads.'], CODE_HARNESS: ['runtime', 'The code-node contract, a copy of the file the workflow editor runs: a code node\'s `run(input, call_tool)` runs under it (standard-library imports only, only the MCP servers checked on the node, its exits, its `error` exit, its timeout, `NODE_NAME`). In a package it is `code_harness.py`, and each code node\'s Python is a file under `code/`, read at every run.'], DecisionResult: ['runtime', 'Frozen record of one decision-model call (TypeSafe Jev, OpenAI Decisions...): its outcome (`routed`, `unclear`, `low_confidence`, `unavailable`, `error`), the chosen target, the confidence. A decision adapter (`JevRouter`, `OpenAIDecisionRouter`) returns it; a dispatcher routes with it and never falls back to the model.'], _rec_node_start: ['runtime', 'Run events: each node\'s start and completion (a code node\'s exit, a dispatcher\'s route) go to the run\'s recorder, which the listener sets (`_set_recorder`): the run log under `runs/` that `GET /live` streams to the editor\'s live canvas.'], RunRecorder: ['runtime', 'Writes one run\'s events to `runs/<date>_<run id>.jsonl` (a quiet run, nothing to do, leaves no file) and to the console view (`ConsoleView`). `live_next` reads them back for `GET /live`.'], Listener: ['assembly', 'The Start\'s schedule (`--cron`) or event trigger (`--watch`: an MCP tool such as `outlook.wait_for_new` that answers `ready` or `timeout`) as a loop: in the foreground for the CLI, in a background thread for `api.py` (`POST /listen`). One copy listens at a time (`.run.lock`). `make_listener()` builds it from the baked `START_MODE`, `DEFAULT_CRON` and `DEFAULT_WATCH`; `make_run_once()` is one recorded run.'], AgentSupervisor: ['orchestrator', 'Starts one Python process per agent server (`servers/<id>_<name>.py --port N`), relays its output with a `[name]` prefix, waits for each Agent Card (and its version) and stops them at the end.'], _run_remote_node: ['orchestrator', 'Runs one node on its A2A server: sends its input as a task, streams its status lines, answers its gates (`_handle_gate`: the run server, the console, or `PLAYBOOK_GATE_MODE`) and reads the `result` artifact (text, route, notes, status).'], NodeExecutor: ['server', 'The A2A agent server\'s executor: a new task starts a node run (`run_node`), a follow-up message answers the gate it paused at (input-required). The Agent Card (`build_agent_card`) carries the workflow version the orchestrator checks.'] };
        let own: Record<string, Entry>;
        switch (target) {
            case 'adk':
                own = { _make_model: ['runtime', 'Maps a node\'s provider and model to an ADK model: Gemini natively, every other provider through LiteLLM; the node\'s Thinking attribute and the hard API constraints are applied here.'], build_tools_from_catalog: ['runtime', 'One typed `FunctionTool` per MCP tool the workflow uses (ADK reads each function\'s signature as the tool schema); each calls `_call_mcp_tool`.'], _CodeAgent: ['runtime', 'A code node as an ADK agent: runs the node\'s Python through `CODE_HARNESS` in a worker thread, writes its output to `state["node_<id>"]` and the exit it took to `state["route_<id>"]`.'], _PlaybookAgent: ['runtime', 'A playbook node as an ADK agent: runs the shared playbook interpreter (native verbs, human gates, bound #Actions) and publishes its transcript as the node output.'], _DispatcherAgent: ['runtime', 'A dispatcher node: its menu children are nested under it, and only the child it chooses runs -- through its decision model (`routing_mode`), else its chooser `LlmAgent` (the node itself, asked for one name). The chosen child reads the dispatcher\'s input; nothing chosen ends the branch (Not classified, or an error).'], _PassThroughAgent: ['runtime', 'The Output node: forwards what reached it verbatim (no model), so formatting such as HTML is never reworded.'], _Gate: ['runtime', 'Wraps a node that sits after a choice (a code node with several exits, a dispatcher): it runs only when a parent ran and that parent\'s choice leads here, so an untaken branch is skipped with everything after it.'], _attach_recording: ['runtime', 'Sets ADK\'s before/after agent callbacks on every recorded node, so each node\'s start and completion reach the run events.'], run_workflow: ['assembly', 'One run: seeds the session with the prompt (and the Start\'s converted documents), runs `root_agent` through ADK\'s `Runner` and returns the Output node\'s answer.'] };
                break;
            case 'maf':
                own = { ProviderClients: ['runtime', 'Builds the MAF chat client and per-call options for each node\'s provider and model (Anthropic natively, every other provider through the OpenAI-compatible client, `ReasoningRoundTripClient` replaying reasoning where a model requires it).'], NodeMessage: ['runtime', 'The typed message on every edge: the producer\'s id, name and text, plus `route_to` (a dispatcher\'s choice), `routes` (a code node\'s taken exit), `task` (a dispatcher\'s own input, what a code branch receives) and `skipped`.'], StartExecutor: ['runtime', 'The Start node: records the prompt and sends it along every outgoing edge.'], AgentNodeExecutor: ['runtime', 'An agent node: waits for every parent (fan-in barrier), skips when no parent\'s message reaches it (`_skip_node`), runs one MAF `Agent` turn with its tools, then its skill steps, and sends its text on.'], DispatcherNodeExecutor: ['runtime', 'A dispatcher node: chooses one child -- its decision model (`DECISIONS`), else one chooser model turn -- and sends a message naming it; the other children skip and still report, so every barrier below completes.'], CodeNodeExecutor: ['runtime', 'A code node: runs its Python through `CODE_HARNESS`; with several exits its message names the children of the exit it took (`routes`).'], PlaybookNodeExecutor: ['runtime', 'A playbook node: runs the shared playbook interpreter and sends its transcript on.'], OutputNodeExecutor: ['runtime', 'The Output node: merges what reached it verbatim (no model) and yields the workflow\'s answer.'], ProgressReporter: ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'], create_workflow: ['assembly', 'The canvas on MAF\'s graph API, 1:1: one executor per node, one `add_edge` per drawn connection, built with `WorkflowBuilder`.'], run_workflow: ['assembly', 'One run: builds the graph, runs it on the prompt and returns the Output\'s answer (or why a dispatcher did not route).'] };
                break;
            case 'nooa':
                own = { make_llm: ['runtime', 'Builds the NOOA (UnifiedLLM) client for a node\'s provider and model; endpoints, key variables and the hard API constraints live here.'], run_agent: ['runtime', 'Runs one agent node: its framed input (the request plus each parent\'s output under its name), its NOOA `Agent` class, then each bound skill as a mandatory step.'], run_dispatcher: ['runtime', 'A dispatcher\'s chooser: asks the dispatcher\'s own model for one name from its menu and returns the chosen child with the task plus its notes.'], _route_dispatcher: ['assembly', 'A dispatcher\'s choice: its decision model (Jev...) when its routing names one -- no model turn; unclear goes to the unclear branch when set, else "Not classified" -- otherwise `run_dispatcher`.'], _run_graph: ['assembly', 'The driver: walks `GRAPH` layer by layer; the nodes of a layer that the run reached run together (`asyncio.gather`). A node is reached when a parent ran and, for a routing parent (a dispatcher, a code node with several exits), that parent\'s choice leads here. The Output merges what reached it.'], Progress: ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'], run_workflow: ['assembly', 'One run: the Start\'s documents converted and placed before the prompt, then `_run_graph`.'] };
                break;
            default:
                own = {};
        }
        const out: Record<string, Entry> = { ...own };
        for (const [k, v] of Object.entries(shared)) {
            if (!Object.hasOwn(out, k)) out[k] = v;
        }
        return out;
    }

    /**
     * @param files path => code of what the compile produced (a single file: one entry)
     */
    static build(analyzed: any, target: string, mode: string, files: any): string {
        const code = values<string>(files).map((c) => strval(c)).join('\n');
        const present: Record<string, Entry> = {};
        for (const [name, info] of Object.entries(CompiledArchitectureDoc.catalog(target))) {
            if (preg_match('/^\\s*(?:async\\s+def|def|class)\\s+' + preg_quote(name, '/') + '\\b|^' + preg_quote(name, '/') + '\\s*=/m', code)) {
                present[name] = info;
            }
        }
        const sections = [
            CompiledArchitectureDoc.overview(analyzed, target, mode),
            CompiledArchitectureDoc.filesSection(analyzed, target, mode, keysOf(files)),
            '## Class diagram\n\n```mermaid\n' + CompiledArchitectureDoc.classDiagram(target, present) + '```',
            '## Workflow diagram\n\n```mermaid\n' + CompiledArchitectureDoc.workflowDiagram(analyzed) + '```',
            CompiledArchitectureDoc.classesSection(mode, present),
            CompiledArchitectureDoc.runFlow(analyzed, target, mode),
            CompiledArchitectureDoc.changeSection(target, mode),
        ];
        return sections.join('\n\n') + '\n';
    }

    /**
     * $result with its ARCHITECTURE.md: the 'architecture' key, and for a package the file, written last. A
     * companion never costs the user the code: a failure to build it is logged and gives null. An ingestion
     * pipeline (loader / splitter / vectorstore nodes) is not the agent graph it describes, so it gets none.
     * Returns a new result (the argument is not changed, as PHP passes it by value).
     */
    static attach(result: any, analyzed: any, target: string, mode: string): any {
        const withNull = (): any => {
            const r: any = oarr(entries(result));
            if (!('architecture' in r)) r['architecture'] = null;
            return r;
        };
        for (const n of values(toArr(analyzed['byId'] ?? []))) {
            if (['loader', 'splitter', 'vectorstore'].includes(GraphAnalyzer.typeOf(n))) {
                return withNull();
            }
        }
        const files = has(result, 'files') ? array_column(result['files'], 'code', 'path') : oarr([[strval(result['filename']), result['code']]]);
        let doc: string;
        try {
            doc = CompiledArchitectureDoc.build(analyzed, target, mode, files);
        } catch (e: any) {
            console.error(`[CompiledArchitectureDoc] ${target} ${mode} ARCHITECTURE.md skipped: ` + (e?.message ?? String(e)));
            return withNull();
        }
        const out: any = oarr(entries(result));
        if (has(result, 'files')) {
            out['files'] = [...values(result['files']), { path: 'ARCHITECTURE.md', code: doc }];
        }
        out['architecture'] = doc;
        return out;
    }

    private static overview(analyzed: any, target: string, mode: string): string {
        const name = strval(analyzed['workflow']['name']);
        let shape: string;
        switch (mode) {
            case 'single':
                shape = 'One Python file runs the whole workflow in one process: the runtime, every node and the command-line entry point.';
                break;
            case 'modular':
                shape = 'One Python package runs the whole workflow in one process, in its own folder: `common.py` holds the runtime, each node is a module under `agents/`, `workflow.py` assembles the nodes and runs them (the Start\'s listener too), and `api.py` serves the run protocol the editor speaks.';
                break;
            default:
                shape = 'Each agent, dispatcher and playbook node runs in an A2A agent server of its own (`servers/`); `orchestrator.py` starts them and walks the canvas, sending each node its input as an A2A task. The servers run their node with the package\'s runtime (`common.py`, `agents/`).';
        }
        const counts: string[] = [];
        const ids = keysOf(toArr(analyzed['byId']));
        for (const k of ['start', 'dispatcher', 'agent', 'code', 'playbook', 'output']) {
            const n = ids.filter((id) => CompiledArchitectureDoc.kindOf(analyzed, id) === k).length;
            if (n > 0) {
                counts.push(`${n} ${k}` + (n > 1 && k !== 'code' ? 's' : (n > 1 ? ' nodes' : '')));
            }
        }
        return `# ${name}: architecture\n\n`
            + 'Workflow ' + String(Math.trunc(Number(analyzed['workflow']['id'])) || 0) + ' "' + name + '", compiled by the SynergyAI workflow editor to '
            + strval(CompiledArchitectureDoc.TARGETS[target]) + ', ' + strval(CompiledArchitectureDoc.MODES[mode]) + ' mode. ' + shape
            + ' The workflow has ' + String(ids.length) + ' nodes: ' + counts.join(', ') + '.'
            + ' Everything here is generated: change the workflow in the editor and generate again rather than editing the files.';
    }

    private static kindOf(analyzed: any, id: string): string {
        const t = GraphAnalyzer.typeOf(isset(analyzed, 'byId', id) ? analyzed['byId'][id] : []);
        if (isset(analyzed, 'code', id)) {
            return 'code';
        }
        if (isset(analyzed, 'playbooks', id)) {
            return 'playbook';
        }
        if (has(GraphAnalyzer.dispatchMenus(analyzed)['menus'], id)) {
            return 'dispatcher';
        }
        return t === 'agent' || t === 'agent-template' ? 'agent' : t;
    }

    private static nameOf(analyzed: any, id: string): string {
        const cfgRaw = isset(analyzed, 'byId', id, 'config') ? analyzed['byId'][id]['config'] : [];
        const cfg = toArr(cfgRaw);
        const v = (isset(analyzed, 'code', id, 'display') ? analyzed['code'][id]['display'] : null)
            ?? (isset(analyzed, 'playbooks', id, 'display') ? analyzed['playbooks'][id]['display'] : null)
            ?? (isset(analyzed, 'agents', id, 'name') ? analyzed['agents'][id]['name'] : null)
            ?? (has(cfg, 'name') ? cfg['name'] : '');
        return strval(truthy(v) ? v : ucfirst(CompiledArchitectureDoc.kindOf(analyzed, id)));
    }

    private static filesSection(analyzed: any, target: string, mode: string, paths: string[]): string {
        const holds = ({ adk: 'its ADK agent (`node_<id>`)', maf: 'its settings for the MAF executors (`NODE`, and `CODE_NODE` / `DECISION` / `PLAYBOOK` for those kinds)',
            nooa: 'its NOOA `Agent` class (the prompt is its docstring) and settings (`NODE`)' } as Record<string, string>)[target];
        const modules: Record<string, [string, string]> = oarr();
        for (const [nid, m] of entries(CompiledRuntimeEmit.moduleLayout(analyzed))) {
            modules[m['file']] = [nid, m['display']];
        }
        const servers: Record<string, [string, string, string, number]> = oarr();
        for (const [nid, e] of entries(CompiledA2AEmit.layout(analyzed))) {
            servers[e['file']] = [nid, e['display'], e['kind'], e['port']];
        }
        const rows: string[] = [];
        const seen: Record<string, boolean> = oarr();
        for (let p of paths) {
            let role: string | null;
            if (mode === 'single') role = 'The whole workflow: runtime, nodes, run and command-line entry point.';
            else if (p === 'workflow.py') role = 'Assembles the nodes and runs them: `run_workflow()`, the Start\'s listener (`make_listener`) and the command-line entry point.';
            else if (p === 'common.py') role = 'The runtime every node uses (model clients, MCP client, tools, skills, the node classes, run events), plus the run server\'s shared pieces (run records, the live feed).';
            else if (p === 'api.py') role = 'Run server: the HTTP run protocol the editor uses to start a run, stream its events, answer human gates and (agents in separate files) listen for the Start\'s trigger (`POST /listen`, `GET /live`).';
            else if (p === 'orchestrator.py') role = 'Starts the agent servers (`AgentSupervisor`) and walks the canvas, sending each node its input as an A2A task (`_run_remote_node`).';
            else if (p === '__init__.py') role = 'Package marker.';
            else if (p === 'agents/__init__.py') role = 'Package marker of the node modules.';
            else if (has(modules, p)) role = 'Node ' + modules[p][0] + ' "' + modules[p][1] + '": ' + holds + ', imported by `workflow.py`.';
            else if (has(servers, p)) role = 'Node ' + servers[p][0] + ' "' + servers[p][1] + '" (' + servers[p][2] + ') as an A2A agent server, port ' + servers[p][3] + ' (`A2A_BASE_PORT` moves the range).';
            else if (p === 'code_harness.py') role = 'The code-node contract, a copy of the file the workflow editor runs.';
            else if (str_starts_with(p, 'code/')) role = 'A code node\'s Python, read at every run (edit it here to change the node until the next generation).';
            else if (p === 'requirements.txt') role = 'The Python packages to install (`pip install -r requirements.txt`).';
            else if (p === '.env.example') role = 'Every variable the program reads: provider keys, decision-model keys, MCP URLs and headers, output folder.';
            else if (p === 'README.md') role = 'Install, configure, run, serve.';
            else if (p === 'ARCHITECTURE.md') role = 'This document.';
            else role = null;
            if (str_starts_with(p, 'skills/')) {
                const dir = 'skills/' + substr(p, 7).split('/')[0] + '/';
                [p, role] = [dir, 'Skill "' + substr(dir, 7, -1) + '", copied with all its files.'];
            } else if (str_starts_with(p, 'start_documents/')) {
                [p, role] = ['start_documents/', 'The documents attached to the Start node, copied.'];
            }
            if (role === null || has(seen, p)) {
                continue;
            }
            seen[p] = true;
            rows.push('| `' + p + '` | ' + role + ' |');
        }
        if (mode !== 'single' && !has(seen, 'ARCHITECTURE.md')) {
            rows.push('| `ARCHITECTURE.md` | This document. |');
        }
        return '## Files\n\n| File | Role |\n|---|---|\n' + rows.join('\n');
    }

    private static classDiagram(target: string, present: Record<string, Entry>): string {
        const L = ['classDiagram'];
        let edges: Array<[string, string, string, string]>;
        switch (target) {
            case 'adk':
                edges = [['_DispatcherAgent', 'DecisionResult', '..>', 'reads'], ['_CodeAgent', 'CODE_HARNESS', '-->', ''],
                    ['_Gate', '_DispatcherAgent', '-->', 'wraps'], ['_Gate', '_CodeAgent', '-->', 'wraps'],
                    ['run_workflow', '_attach_recording', '..>', ''], ['build_tools_from_catalog', '_call_mcp_tool', '-->', '']];
                break;
            case 'maf':
                edges = [['create_workflow', 'StartExecutor', '-->', ''], ['create_workflow', 'AgentNodeExecutor', '-->', ''],
                    ['create_workflow', 'DispatcherNodeExecutor', '-->', ''], ['create_workflow', 'CodeNodeExecutor', '-->', ''],
                    ['create_workflow', 'PlaybookNodeExecutor', '-->', ''], ['create_workflow', 'OutputNodeExecutor', '-->', ''],
                    ['AgentNodeExecutor', 'ProviderClients', '-->', ''], ['DispatcherNodeExecutor', 'DecisionResult', '..>', 'reads'],
                    ['CodeNodeExecutor', 'CODE_HARNESS', '-->', ''], ['AgentNodeExecutor', 'NodeMessage', '..>', 'sends']];
                break;
            default:
                edges = [['run_workflow', '_run_graph', '-->', ''], ['_run_graph', 'run_agent', '-->', ''],
                    ['_run_graph', '_route_dispatcher', '-->', ''], ['_route_dispatcher', 'run_dispatcher', '..>', 'else'],
                    ['_route_dispatcher', 'DecisionResult', '..>', 'reads'], ['_run_graph', 'CODE_HARNESS', '-->', ''],
                    ['run_agent', 'make_llm', '-->', '']];
        }
        edges = [...edges, ['Listener', 'RunRecorder', '-->', 'each run'], ['AgentSupervisor', 'NodeExecutor', '..>', 'spawns'],
            ['_run_remote_node', 'NodeExecutor', '..>', 'A2A task']];
        for (const [a, b, arrow, label] of edges) {
            if (Object.hasOwn(present, a) && Object.hasOwn(present, b)) {
                L.push('    ' + CompiledArchitectureDoc.cls(a) + ` ${arrow} ` + CompiledArchitectureDoc.cls(b) + (label !== '' ? ` : ${label}` : ''));
            }
        }
        for (const n of Object.keys(present)) {
            L.push('    class ' + CompiledArchitectureDoc.cls(n));
        }
        return L.join('\n') + '\n';
    }

    /** Mermaid class names cannot start with "_": shown without it. */
    private static cls(name: string): string {
        return ltrim(name, '_');
    }

    private static workflowDiagram(analyzed: any): string {
        const L = ['flowchart LR'];
        const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
        for (const rawId of values(toArr(analyzed['order']))) {
            const id = strval(rawId);
            const k = CompiledArchitectureDoc.kindOf(analyzed, id);
            const label = str_replace('"', "'", CompiledArchitectureDoc.nameOf(analyzed, id)) + (k === 'start' || k === 'output' ? '' : ` (${k})`);
            let shape: string;
            switch (k) {
                case 'start':
                case 'output':
                    shape = '(["' + label + '"])';
                    break;
                case 'dispatcher':
                    shape = '{"' + label + '"}';
                    break;
                case 'playbook':
                    shape = '[["' + label + '"]]';
                    break;
                case 'code':
                    shape = '[/"' + label + '"/]';
                    break;
                default:
                    shape = '["' + label + '"]';
            }
            L.push('    n' + wordId(id) + shape);
        }
        for (const e of values(toArr(analyzed['edges']))) {
            const from = strval(e['from'] ?? e['from_node_id'] ?? '');
            const to = strval(e['to'] ?? e['to_node_id'] ?? '');
            const f = 'n' + wordId(from);
            const t = 'n' + wordId(to);
            if (has(menus, from)) {
                L.push(`    ${f} -.->|choice| ${t}`);
                continue;
            }
            let exit = '';
            const cd = isset(analyzed, 'code', from) ? analyzed['code'][from] : null;
            for (const [x, kids] of entries(cd !== null ? (cd['exit_targets'] ?? []) : [])) {
                if (count(cd['exits']) > 1 && in_array(to, values(kids).map((v) => strval(v)), true)) {
                    exit = x;
                }
            }
            L.push(exit !== '' ? `    ${f} -->|${exit}| ${t}` : `    ${f} --> ${t}`);
        }
        return L.join('\n') + '\n';
    }

    private static classesSection(mode: string, present: Record<string, Entry>): string {
        const where = mode === 'single' ? 'Everything lives in the one file.'
            : mode === 'modular' ? 'Runtime names live in `common.py`; assembly names (the run, the listener) in `workflow.py`; `agents/` only define nodes from them.'
            : 'Runtime names live in `common.py` (the agent servers import it), the graph walk and the supervisor in `orchestrator.py`, the A2A serving in each `servers/` file.';
        const L = ['## Classes and functions', '', where];
        for (const [name, [loc, desc]] of Object.entries(present)) {
            const file = mode === 'single' ? ''
                : loc === 'orchestrator' ? ' (`orchestrator.py`)'
                : loc === 'server' ? ' (`servers/`)'
                : loc === 'assembly' && mode !== 'a2a' ? ' (`workflow.py`)'
                : ' (`common.py`)';
            L.push('');
            L.push(`### \`${name}\`${file}`);
            L.push('');
            L.push(desc);
        }
        return L.join('\n');
    }

    private static runFlow(analyzed: any, target: string, mode: string): string {
        const entry = mode === 'single' ? 'python <file>.py "your prompt"'
            : mode === 'modular' ? 'python workflow.py "your prompt"'
            : 'python orchestrator.py "your prompt"';
        const steps: string[] = [];
        steps.push(`\`${entry}\`` + (mode === 'a2a' ? ' (or `api.py` calling `run()`): `AgentSupervisor` starts one agent server per node and waits for each Agent Card.'
            : (mode === 'modular' ? ' (or `api.py` calling `run_workflow()`; with a schedule or an event trigger, the listener runs it on each tick or event).'
                : ' runs the workflow once on the prompt (the Start node\'s prompt when none is given).')));
        if (mode === 'a2a') {
            steps.push('`run()` walks `GRAPH` layer by layer: each reached node gets the request plus its parents\' outputs (`build_context`) as an A2A task (`_run_remote_node`), and the nodes of a layer run together.');
            steps.push('In its server, the node runs with the ' + strval(CompiledArchitectureDoc.TARGETS[target]) + ' runtime (`run_node`): an agent its model turn and skills, a dispatcher its decision model or chooser -- its `route` decides which children run -- a playbook its interpreter, whose gates come back to the orchestrator as input-required.');
        } else {
            steps.push(target === 'adk' ? 'The Start\'s documents are converted to Markdown and put before the prompt; ADK\'s `Runner` runs `root_agent`: the canvas as topological layers (a `SequentialAgent` of `ParallelAgent` layers).'
                : target === 'maf' ? 'The Start\'s documents are converted and put before the prompt; `create_workflow()` builds the graph and MAF runs it: `StartExecutor` sends the prompt along every edge, and every executor waits for all its parents (fan-in barrier).'
                : 'The Start\'s documents are converted and put before the prompt; `_run_graph` walks `GRAPH` layer by layer, the reached nodes of a layer together.');
            steps.push('An agent node runs its model with its MCP tools (each call through `_call_mcp_tool`, with its server\'s headers), then its skills in order.');
            if (truthy(analyzed['code'] ?? null)) {
                steps.push('A code node runs its Python under `CODE_HARNESS`; with several exits, the exit it took decides which children run (the others are skipped, with everything that only follows them).');
            }
            if (count(GraphAnalyzer.dispatchMenus(analyzed)['menus']) > 0) {
                steps.push('A dispatcher chooses one child: through its decision model when its routing names one (no model turn; unclear goes to the unclear branch when set, else "Not classified"), else through one chooser model turn. Only the chosen child runs; a code branch receives the dispatcher\'s own input. When nothing is chosen, the dispatcher\'s message is the answer.');
            }
            if (truthy(analyzed['playbooks'] ?? null)) {
                steps.push('A playbook node runs the playbook interpreter; its human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run server. Its output is the transcript.');
            }
        }
        steps.push('The Output node merges what reached it verbatim; that is the answer, printed and, when the Output node\'s storage is on, saved under `outputs/`.');
        if (mode === 'modular') {
            steps.push('Each node\'s start and completion go to the run\'s recorder (`runs/`), which `GET /live` streams to the editor\'s live canvas.');
        }
        const L = ['## How a run flows', ''];
        steps.forEach((s, i) => L.push((i + 1) + '. ' + s));
        return L.join('\n');
    }

    private static changeSection(target: string, mode: string): string {
        const gen = ({ adk: 'ADKGenerator', maf: 'MAFGenerator', nooa: 'NOOAGenerator' } as Record<string, string>)[target];
        const L = ['## How to change it', ''];
        L.push('- **Add or change a node** (prompt, model, tools, skills, routing, code): edit the workflow in the editor and generate again'
            + (mode === 'single' ? '.' : ': each node is regenerated in its own file.'));
        L.push('- **Change behaviour**: the runtime is emitted by the compiler (the backend\'s `' + strval(gen) + '`, `CompiledRuntimeEmit`'
            + (mode === 'a2a' ? ', `CompiledA2AEmit`' : '') + '). Change it there, never by hand-editing the output: the next generation overwrites it.');
        L.push('- **Keys and MCP headers** come from `.env`: the program\'s own folder first, then the runner\'s `python/.env` (which the editor refreshes on every generation). `.env.example` lists every variable.');
        if (mode === 'a2a') {
            L.push('- **Move an agent**: set `A2A_AGENT_<id>_URL` (and start the orchestrator with `--no-spawn` when every agent runs elsewhere); `A2A_BASE_PORT` moves the whole port range.');
        }
        return L.join('\n');
    }
}
