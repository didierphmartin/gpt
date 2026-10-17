<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * ARCHITECTURE.md for one ADK, MAF or NOOA compile, as LangGraphArchitectureDoc writes it for LangGraph: what
 * the emitted program is made of and how it runs, for THIS workflow, THIS target and THIS code structure
 * (single file, agents in separate files, A2A). Overview, files, class diagram, workflow diagram, classes,
 * how a run flows, how to change it.
 *
 * Every class or function it describes is looked up in the generated code first (a name the code does not
 * define is left out), so the document cannot describe something the compile did not produce;
 * CompiledArchitectureDocTest checks it.
 */
final class CompiledArchitectureDoc
{
    private const TARGETS = [
        'adk' => 'Google ADK (Python)',
        'maf' => 'Microsoft Agent Framework (Python)',
        'nooa' => 'NVIDIA NOOA (Python)',
    ];

    private const MODES = [
        'single' => 'single file',
        'modular' => 'agents in separate files',
        'a2a' => 'A2A (one agent server per node)',
    ];

    /**
     * Per target: name => [where it lives ('runtime' | 'assembly' | 'server' | 'orchestrator'), description].
     * Runtime names are in common.py in a package, assembly names in workflow.py; the single file holds both.
     */
    private static function catalog(string $target): array
    {
        $shared = [
            '_call_mcp_tool' => ['runtime', 'Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain JSON or SSE replies) with that server\'s headers from `MCP_HEADERS_<SLUG>` in `.env` (`_mcp_headers`) and its URL, or `MCP_URL_<SLUG>` when it moved; `_call_mcp_tool_raw` returns the raw result a code node reads.'],
            'CODE_HARNESS' => ['runtime', 'The code-node contract, a copy of the file the workflow editor runs: a code node\'s `run(input, call_tool)` runs under it (standard-library imports only, only the MCP servers checked on the node, its exits, its `error` exit, its timeout, `NODE_NAME`). In a package it is `code_harness.py`, and each code node\'s Python is a file under `code/`, read at every run.'],
            'DecisionResult' => ['runtime', 'Frozen record of one decision-model call (TypeSafe Jev...): its outcome (`routed`, `unclear`, `low_confidence`, `unavailable`, `error`), the chosen target, the confidence. `JevRouter` returns it; a dispatcher routes with it and never falls back to the model.'],
            '_rec_node_start' => ['runtime', 'Run events: each node\'s start and completion (a code node\'s exit, a dispatcher\'s route) go to the run\'s recorder, which the listener sets (`_set_recorder`): the run log under `runs/` that `GET /live` streams to the editor\'s live canvas.'],
            'RunRecorder' => ['runtime', 'Writes one run\'s events to `runs/<date>_<run id>.jsonl` (a quiet run, nothing to do, leaves no file) and to the console view (`ConsoleView`). `live_next` reads them back for `GET /live`.'],
            'Listener' => ['assembly', 'The Start\'s schedule (`--cron`) or event trigger (`--watch`: an MCP tool such as `outlook.wait_for_new` that answers `ready` or `timeout`) as a loop: in the foreground for the CLI, in a background thread for `api.py` (`POST /listen`). One copy listens at a time (`.run.lock`). `make_listener()` builds it from the baked `START_MODE`, `DEFAULT_CRON` and `DEFAULT_WATCH`; `make_run_once()` is one recorded run.'],
            'AgentSupervisor' => ['orchestrator', 'Starts one Python process per agent server (`servers/<id>_<name>.py --port N`), relays its output with a `[name]` prefix, waits for each Agent Card (and its version) and stops them at the end.'],
            '_run_remote_node' => ['orchestrator', 'Runs one node on its A2A server: sends its input as a task, streams its status lines, answers its gates (`_handle_gate`: the run server, the console, or `PLAYBOOK_GATE_MODE`) and reads the `result` artifact (text, route, notes, status).'],
            'NodeExecutor' => ['server', 'The A2A agent server\'s executor: a new task starts a node run (`run_node`), a follow-up message answers the gate it paused at (input-required). The Agent Card (`build_agent_card`) carries the workflow version the orchestrator checks.'],
        ];
        $own = match ($target) {
            'adk' => [
                '_make_model' => ['runtime', 'Maps a node\'s provider and model to an ADK model: Gemini natively, every other provider through LiteLLM; the node\'s Thinking attribute and the hard API constraints are applied here.'],
                'build_tools_from_catalog' => ['runtime', 'One typed `FunctionTool` per MCP tool the workflow uses (ADK reads each function\'s signature as the tool schema); each calls `_call_mcp_tool`.'],
                '_CodeAgent' => ['runtime', 'A code node as an ADK agent: runs the node\'s Python through `CODE_HARNESS` in a worker thread, writes its output to `state["node_<id>"]` and the exit it took to `state["route_<id>"]`.'],
                '_PlaybookAgent' => ['runtime', 'A playbook node as an ADK agent: runs the shared playbook interpreter (native verbs, human gates, bound #Actions) and publishes its transcript as the node output.'],
                '_DispatcherAgent' => ['runtime', 'A dispatcher node: its menu children are nested under it, and only the child it chooses runs -- through its decision model (`routing_mode`), else its chooser `LlmAgent` (the node itself, asked for one name). The chosen child reads the dispatcher\'s input; nothing chosen ends the branch (Not classified, or an error).'],
                '_PassThroughAgent' => ['runtime', 'The Output node: forwards what reached it verbatim (no model), so formatting such as HTML is never reworded.'],
                '_Gate' => ['runtime', 'Wraps a node that sits after a choice (a code node with several exits, a dispatcher): it runs only when a parent ran and that parent\'s choice leads here, so an untaken branch is skipped with everything after it.'],
                '_attach_recording' => ['runtime', 'Sets ADK\'s before/after agent callbacks on every recorded node, so each node\'s start and completion reach the run events.'],
                'run_workflow' => ['assembly', 'One run: seeds the session with the prompt (and the Start\'s converted documents), runs `root_agent` through ADK\'s `Runner` and returns the Output node\'s answer.'],
            ],
            'maf' => [
                'ProviderClients' => ['runtime', 'Builds the MAF chat client and per-call options for each node\'s provider and model (Anthropic natively, every other provider through the OpenAI-compatible client, `ReasoningRoundTripClient` replaying reasoning where a model requires it).'],
                'NodeMessage' => ['runtime', 'The typed message on every edge: the producer\'s id, name and text, plus `route_to` (a dispatcher\'s choice), `routes` (a code node\'s taken exit), `task` (a dispatcher\'s own input, what a code branch receives) and `skipped`.'],
                'StartExecutor' => ['runtime', 'The Start node: records the prompt and sends it along every outgoing edge.'],
                'AgentNodeExecutor' => ['runtime', 'An agent node: waits for every parent (fan-in barrier), skips when no parent\'s message reaches it (`_skip_node`), runs one MAF `Agent` turn with its tools, then its skill steps, and sends its text on.'],
                'DispatcherNodeExecutor' => ['runtime', 'A dispatcher node: chooses one child -- its decision model (`DECISIONS`), else one chooser model turn -- and sends a message naming it; the other children skip and still report, so every barrier below completes.'],
                'CodeNodeExecutor' => ['runtime', 'A code node: runs its Python through `CODE_HARNESS`; with several exits its message names the children of the exit it took (`routes`).'],
                'PlaybookNodeExecutor' => ['runtime', 'A playbook node: runs the shared playbook interpreter and sends its transcript on.'],
                'OutputNodeExecutor' => ['runtime', 'The Output node: merges what reached it verbatim (no model) and yields the workflow\'s answer.'],
                'ProgressReporter' => ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'],
                'create_workflow' => ['assembly', 'The canvas on MAF\'s graph API, 1:1: one executor per node, one `add_edge` per drawn connection, built with `WorkflowBuilder`.'],
                'run_workflow' => ['assembly', 'One run: builds the graph, runs it on the prompt and returns the Output\'s answer (or why a dispatcher did not route).'],
            ],
            'nooa' => [
                'make_llm' => ['runtime', 'Builds the NOOA (UnifiedLLM) client for a node\'s provider and model; endpoints, key variables and the hard API constraints live here.'],
                'run_agent' => ['runtime', 'Runs one agent node: its framed input (the request plus each parent\'s output under its name), its NOOA `Agent` class, then each bound skill as a mandatory step.'],
                'run_dispatcher' => ['runtime', 'A dispatcher\'s chooser: asks the dispatcher\'s own model for one name from its menu and returns the chosen child with the task plus its notes.'],
                '_route_dispatcher' => ['assembly', 'A dispatcher\'s choice: its decision model (Jev...) when its routing names one -- no model turn; unclear goes to the unclear branch when set, else "Not classified" -- otherwise `run_dispatcher`.'],
                '_run_graph' => ['assembly', 'The driver: walks `GRAPH` layer by layer; the nodes of a layer that the run reached run together (`asyncio.gather`). A node is reached when a parent ran and, for a routing parent (a dispatcher, a code node with several exits), that parent\'s choice leads here. The Output merges what reached it.'],
                'Progress' => ['runtime', 'Console liveness: the run banner, per-node lines, a heartbeat naming the nodes still running, and the RUN SUMMARY.'],
                'run_workflow' => ['assembly', 'One run: the Start\'s documents converted and placed before the prompt, then `_run_graph`.'],
            ],
            default => [],
        };
        return $own + $shared;
    }

    /**
     * @param array<string,string> $files path => code of what the compile produced (a single file: one entry)
     */
    public static function build(array $analyzed, string $target, string $mode, array $files): string
    {
        $code = implode("\n", $files);
        $present = [];
        foreach (self::catalog($target) as $name => $info) {
            if (preg_match('/^\s*(?:async\s+def|def|class)\s+' . preg_quote($name, '/') . '\b|^' . preg_quote($name, '/') . '\s*=/m', $code)) {
                $present[$name] = $info;
            }
        }
        $sections = [
            self::overview($analyzed, $target, $mode),
            self::filesSection($analyzed, $target, $mode, array_keys($files)),
            "## Class diagram\n\n```mermaid\n" . self::classDiagram($target, $present) . "```",
            "## Workflow diagram\n\n```mermaid\n" . self::workflowDiagram($analyzed) . "```",
            self::classesSection($mode, $present),
            self::runFlow($analyzed, $target, $mode),
            self::changeSection($target, $mode),
        ];
        return implode("\n\n", $sections) . "\n";
    }

    /**
     * $result with its ARCHITECTURE.md: the 'architecture' key, and for a package the file, written last. A
     * companion never costs the user the code: a failure to build it is logged and gives null. An ingestion
     * pipeline (loader / splitter / vectorstore nodes) is not the agent graph it describes, so it gets none.
     */
    public static function attach(array $result, array $analyzed, string $target, string $mode): array
    {
        foreach ((array) ($analyzed['byId'] ?? []) as $n) {
            if (in_array(WorkflowGraphAnalyzer::typeOf($n), ['loader', 'splitter', 'vectorstore'], true)) {
                return $result + ['architecture' => null];
            }
        }
        $files = isset($result['files']) ? array_column($result['files'], 'code', 'path') : [$result['filename'] => $result['code']];
        try {
            $doc = self::build($analyzed, $target, $mode, $files);
        } catch (\Throwable $e) {
            error_log("[CompiledArchitectureDoc] {$target} {$mode} ARCHITECTURE.md skipped: " . $e->getMessage());
            return $result + ['architecture' => null];
        }
        if (isset($result['files'])) {
            $result['files'][] = ['path' => 'ARCHITECTURE.md', 'code' => $doc];
        }
        $result['architecture'] = $doc;
        return $result;
    }

    private static function overview(array $analyzed, string $target, string $mode): string
    {
        $name = (string) $analyzed['workflow']['name'];
        $shape = match ($mode) {
            'single' => 'One Python file runs the whole workflow in one process: the runtime, every node and the command-line entry point.',
            'modular' => 'One Python package runs the whole workflow in one process, in its own folder: `common.py` holds the runtime, each node is a module under `agents/`, `workflow.py` assembles the nodes and runs them (the Start\'s listener too), and `api.py` serves the run protocol the editor speaks.',
            default => 'Each agent, dispatcher and playbook node runs in an A2A agent server of its own (`servers/`); `orchestrator.py` starts them and walks the canvas, sending each node its input as an A2A task. The servers run their node with the package\'s runtime (`common.py`, `agents/`).',
        };
        $counts = [];
        foreach (['start', 'dispatcher', 'agent', 'code', 'playbook', 'output'] as $k) {
            $n = count(array_filter(array_keys((array) $analyzed['byId']), fn($id) => self::kindOf($analyzed, (string) $id) === $k));
            if ($n > 0) {
                $counts[] = "{$n} {$k}" . ($n > 1 && $k !== 'code' ? 's' : ($n > 1 ? ' nodes' : ''));
            }
        }
        return "# {$name}: architecture\n\n"
            . 'Workflow ' . (int) $analyzed['workflow']['id'] . ' "' . $name . '", compiled by the SynergyAI workflow editor to '
            . self::TARGETS[$target] . ', ' . self::MODES[$mode] . ' mode. ' . $shape
            . ' The workflow has ' . count((array) $analyzed['byId']) . ' nodes: ' . implode(', ', $counts) . '.'
            . ' Everything here is generated: change the workflow in the editor and generate again rather than editing the files.';
    }

    private static function kindOf(array $analyzed, string $id): string
    {
        $t = WorkflowGraphAnalyzer::typeOf($analyzed['byId'][$id] ?? []);
        if (isset($analyzed['code'][$id])) {
            return 'code';
        }
        if (isset($analyzed['playbooks'][$id])) {
            return 'playbook';
        }
        if (isset(WorkflowGraphAnalyzer::dispatchMenus($analyzed)['menus'][$id])) {
            return 'dispatcher';
        }
        return match ($t) {
            'agent', 'agent-template' => 'agent',
            'start', 'output' => $t,
            default => $t,
        };
    }

    private static function nameOf(array $analyzed, string $id): string
    {
        $cfg = (array) ($analyzed['byId'][$id]['config'] ?? []);
        return (string) ($analyzed['code'][$id]['display'] ?? $analyzed['playbooks'][$id]['display'] ?? $analyzed['agents'][$id]['name']
            ?? ($cfg['name'] ?? '') ?: ucfirst(self::kindOf($analyzed, $id)));
    }

    private static function filesSection(array $analyzed, string $target, string $mode, array $paths): string
    {
        $holds = ['adk' => 'its ADK agent (`node_<id>`)', 'maf' => 'its settings for the MAF executors (`NODE`, and `CODE_NODE` / `DECISION` / `PLAYBOOK` for those kinds)',
            'nooa' => 'its NOOA `Agent` class (the prompt is its docstring) and settings (`NODE`)'][$target];
        $modules = [];
        foreach (CompiledRuntimeEmit::moduleLayout($analyzed) as $nid => $m) {
            $modules[$m['file']] = [$nid, $m['display']];
        }
        $servers = [];
        foreach (CompiledA2AEmit::layout($analyzed) as $nid => $e) {
            $servers[$e['file']] = [$nid, $e['display'], $e['kind'], $e['port']];
        }
        $rows = [];
        $seen = [];
        foreach ($paths as $p) {
            $role = match (true) {
                $mode === 'single' => 'The whole workflow: runtime, nodes, run and command-line entry point.',
                $p === 'workflow.py' => 'Assembles the nodes and runs them: `run_workflow()`, the Start\'s listener (`make_listener`) and the command-line entry point.',
                $p === 'common.py' => 'The runtime every node uses (model clients, MCP client, tools, skills, the node classes, run events), plus the run server\'s shared pieces (run records, the live feed).',
                $p === 'api.py' => 'Run server: the HTTP run protocol the editor uses to start a run, stream its events, answer human gates and (agents in separate files) listen for the Start\'s trigger (`POST /listen`, `GET /live`).',
                $p === 'orchestrator.py' => 'Starts the agent servers (`AgentSupervisor`) and walks the canvas, sending each node its input as an A2A task (`_run_remote_node`).',
                $p === '__init__.py' => 'Package marker.',
                $p === 'agents/__init__.py' => 'Package marker of the node modules.',
                isset($modules[$p]) => 'Node ' . $modules[$p][0] . ' "' . $modules[$p][1] . '": ' . $holds . ', imported by `workflow.py`.',
                isset($servers[$p]) => 'Node ' . $servers[$p][0] . ' "' . $servers[$p][1] . '" (' . $servers[$p][2] . ') as an A2A agent server, port ' . $servers[$p][3] . ' (`A2A_BASE_PORT` moves the range).',
                $p === 'code_harness.py' => 'The code-node contract, a copy of the file the workflow editor runs.',
                str_starts_with($p, 'code/') => 'A code node\'s Python, read at every run (edit it here to change the node until the next generation).',
                $p === 'requirements.txt' => 'The Python packages to install (`pip install -r requirements.txt`).',
                $p === '.env.example' => 'Every variable the program reads: provider keys, decision-model keys, MCP URLs and headers, output folder.',
                $p === 'README.md' => 'Install, run, serve.',
                $p === 'ARCHITECTURE.md' => 'This document.',
                default => null,
            };
            if (str_starts_with($p, 'skills/')) {
                $dir = 'skills/' . explode('/', substr($p, 7))[0] . '/';
                [$p, $role] = [$dir, 'Skill "' . substr($dir, 7, -1) . '", copied with all its files.'];
            } elseif (str_starts_with($p, 'start_documents/')) {
                [$p, $role] = ['start_documents/', 'The documents attached to the Start node, copied.'];
            }
            if ($role === null || isset($seen[$p])) {
                continue;
            }
            $seen[$p] = true;
            $rows[] = '| `' . $p . '` | ' . $role . ' |';
        }
        if ($mode !== 'single' && !isset($seen['ARCHITECTURE.md'])) {
            $rows[] = '| `ARCHITECTURE.md` | This document. |';
        }
        return "## Files\n\n| File | Role |\n|---|---|\n" . implode("\n", $rows);
    }

    private static function classDiagram(string $target, array $present): string
    {
        $L = ["classDiagram"];
        $edges = match ($target) {
            'adk' => [['_DispatcherAgent', 'DecisionResult', '..>', 'reads'], ['_CodeAgent', 'CODE_HARNESS', '-->', ''],
                ['_Gate', '_DispatcherAgent', '-->', 'wraps'], ['_Gate', '_CodeAgent', '-->', 'wraps'],
                ['run_workflow', '_attach_recording', '..>', ''], ['build_tools_from_catalog', '_call_mcp_tool', '-->', '']],
            'maf' => [['create_workflow', 'StartExecutor', '-->', ''], ['create_workflow', 'AgentNodeExecutor', '-->', ''],
                ['create_workflow', 'DispatcherNodeExecutor', '-->', ''], ['create_workflow', 'CodeNodeExecutor', '-->', ''],
                ['create_workflow', 'PlaybookNodeExecutor', '-->', ''], ['create_workflow', 'OutputNodeExecutor', '-->', ''],
                ['AgentNodeExecutor', 'ProviderClients', '-->', ''], ['DispatcherNodeExecutor', 'DecisionResult', '..>', 'reads'],
                ['CodeNodeExecutor', 'CODE_HARNESS', '-->', ''], ['AgentNodeExecutor', 'NodeMessage', '..>', 'sends']],
            default => [['run_workflow', '_run_graph', '-->', ''], ['_run_graph', 'run_agent', '-->', ''],
                ['_run_graph', '_route_dispatcher', '-->', ''], ['_route_dispatcher', 'run_dispatcher', '..>', 'else'],
                ['_route_dispatcher', 'DecisionResult', '..>', 'reads'], ['_run_graph', 'CODE_HARNESS', '-->', ''],
                ['run_agent', 'make_llm', '-->', '']],
        };
        $edges = array_merge($edges, [['Listener', 'RunRecorder', '-->', 'each run'], ['AgentSupervisor', 'NodeExecutor', '..>', 'spawns'],
            ['_run_remote_node', 'NodeExecutor', '..>', 'A2A task']]);
        foreach ($edges as [$a, $b, $arrow, $label]) {
            if (isset($present[$a], $present[$b])) {
                $L[] = '    ' . self::cls($a) . " {$arrow} " . self::cls($b) . ($label !== '' ? " : {$label}" : '');
            }
        }
        foreach (array_keys($present) as $n) {
            $L[] = '    class ' . self::cls($n);
        }
        return implode("\n", $L) . "\n";
    }

    /** Mermaid class names cannot start with "_": shown without it. */
    private static function cls(string $name): string
    {
        return ltrim($name, '_');
    }

    private static function workflowDiagram(array $analyzed): string
    {
        $L = ['flowchart LR'];
        $menus = WorkflowGraphAnalyzer::dispatchMenus($analyzed)['menus'];
        foreach ((array) $analyzed['order'] as $id) {
            $id = (string) $id;
            $k = self::kindOf($analyzed, $id);
            $label = str_replace('"', "'", self::nameOf($analyzed, $id)) . (in_array($k, ['start', 'output'], true) ? '' : " ({$k})");
            $L[] = '    n' . preg_replace('/\W/', '_', $id) . match ($k) {
                'start', 'output' => '(["' . $label . '"])',
                'dispatcher' => '{"' . $label . '"}',
                'playbook' => '[["' . $label . '"]]',
                'code' => '[/"' . $label . '"/]',
                default => '["' . $label . '"]',
            };
        }
        foreach ((array) $analyzed['edges'] as $e) {
            $from = (string) ($e['from'] ?? $e['from_node_id'] ?? '');
            $to = (string) ($e['to'] ?? $e['to_node_id'] ?? '');
            $f = 'n' . preg_replace('/\W/', '_', $from);
            $t = 'n' . preg_replace('/\W/', '_', $to);
            if (isset($menus[$from])) {
                $L[] = "    {$f} -.->|choice| {$t}";
                continue;
            }
            $exit = '';
            foreach ((array) ($analyzed['code'][$from]['exit_targets'] ?? []) as $x => $kids) {
                if (count($analyzed['code'][$from]['exits']) > 1 && in_array($to, array_map('strval', $kids), true)) {
                    $exit = $x;
                }
            }
            $L[] = $exit !== '' ? "    {$f} -->|{$exit}| {$t}" : "    {$f} --> {$t}";
        }
        return implode("\n", $L) . "\n";
    }

    private static function classesSection(string $mode, array $present): string
    {
        $where = match ($mode) {
            'single' => 'Everything lives in the one file.',
            'modular' => 'Runtime names live in `common.py`; assembly names (the run, the listener) in `workflow.py`; `agents/` only define nodes from them.',
            default => 'Runtime names live in `common.py` (the agent servers import it), the graph walk and the supervisor in `orchestrator.py`, the A2A serving in each `servers/` file.',
        };
        $L = ["## Classes and functions", '', $where];
        foreach ($present as $name => [$loc, $desc]) {
            $file = match (true) {
                $mode === 'single' => '',
                $loc === 'orchestrator' => ' (`orchestrator.py`)',
                $loc === 'server' => ' (`servers/`)',
                $loc === 'assembly' && $mode !== 'a2a' => ' (`workflow.py`)',
                default => ' (`common.py`)',
            };
            $L[] = '';
            $L[] = "### `{$name}`{$file}";
            $L[] = '';
            $L[] = $desc;
        }
        return implode("\n", $L);
    }

    private static function runFlow(array $analyzed, string $target, string $mode): string
    {
        $entry = match ($mode) {
            'single' => 'python <file>.py "your prompt"',
            'modular' => 'python workflow.py "your prompt"',
            default => 'python orchestrator.py "your prompt"',
        };
        $steps = [];
        $steps[] = "`{$entry}`" . ($mode === 'a2a' ? ' (or `api.py` calling `run()`): `AgentSupervisor` starts one agent server per node and waits for each Agent Card.'
            : ($mode === 'modular' ? ' (or `api.py` calling `run_workflow()`; with a schedule or an event trigger, the listener runs it on each tick or event).'
                : ' runs the workflow once on the prompt (the Start node\'s prompt when none is given).'));
        if ($mode === 'a2a') {
            $steps[] = '`run()` walks `GRAPH` layer by layer: each reached node gets the request plus its parents\' outputs (`build_context`) as an A2A task (`_run_remote_node`), and the nodes of a layer run together.';
            $steps[] = 'In its server, the node runs with the ' . self::TARGETS[$target] . ' runtime (`run_node`): an agent its model turn and skills, a dispatcher its decision model or chooser -- its `route` decides which children run -- a playbook its interpreter, whose gates come back to the orchestrator as input-required.';
        } else {
            $steps[] = match ($target) {
                'adk' => 'The Start\'s documents are converted to Markdown and put before the prompt; ADK\'s `Runner` runs `root_agent`: the canvas as topological layers (a `SequentialAgent` of `ParallelAgent` layers).',
                'maf' => 'The Start\'s documents are converted and put before the prompt; `create_workflow()` builds the graph and MAF runs it: `StartExecutor` sends the prompt along every edge, and every executor waits for all its parents (fan-in barrier).',
                default => 'The Start\'s documents are converted and put before the prompt; `_run_graph` walks `GRAPH` layer by layer, the reached nodes of a layer together.',
            };
            $steps[] = 'An agent node runs its model with its MCP tools (each call through `_call_mcp_tool`, with its server\'s headers), then its skills in order.';
            if (!empty($analyzed['code'])) {
                $steps[] = 'A code node runs its Python under `CODE_HARNESS`; with several exits, the exit it took decides which children run (the others are skipped, with everything that only follows them).';
            }
            if (WorkflowGraphAnalyzer::dispatchMenus($analyzed)['menus'] !== []) {
                $steps[] = 'A dispatcher chooses one child: through its decision model when its routing names one (no model turn; unclear goes to the unclear branch when set, else "Not classified"), else through one chooser model turn. Only the chosen child runs; a code branch receives the dispatcher\'s own input. When nothing is chosen, the dispatcher\'s message is the answer.';
            }
            if (!empty($analyzed['playbooks'])) {
                $steps[] = 'A playbook node runs the playbook interpreter; its human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run server. Its output is the transcript.';
            }
        }
        $steps[] = 'The Output node merges what reached it verbatim; that is the answer, printed and, when the Output node\'s storage is on, saved under `outputs/`.';
        if ($mode === 'modular') {
            $steps[] = 'Each node\'s start and completion go to the run\'s recorder (`runs/`), which `GET /live` streams to the editor\'s live canvas.';
        }
        $L = ['## How a run flows', ''];
        foreach ($steps as $i => $s) {
            $L[] = ($i + 1) . '. ' . $s;
        }
        return implode("\n", $L);
    }

    private static function changeSection(string $target, string $mode): string
    {
        $gen = ['adk' => 'ADKGenerator', 'maf' => 'MAFGenerator', 'nooa' => 'NOOAGenerator'][$target];
        $L = ['## How to change it', ''];
        $L[] = '- **Add or change a node** (prompt, model, tools, skills, routing, code): edit the workflow in the editor and generate again'
            . ($mode === 'single' ? '.' : ': each node is regenerated in its own file.');
        $L[] = '- **Change behaviour**: the runtime is emitted by the compiler (the backend\'s `' . $gen . '`, `CompiledRuntimeEmit`'
            . ($mode === 'a2a' ? ', `CompiledA2AEmit`' : '') . '). Change it there, never by hand-editing the output: the next generation overwrites it.';
        $L[] = '- **Keys and MCP headers** come from `.env`: the program\'s own folder first, then the runner\'s `python/.env` (which the editor refreshes on every generation). `.env.example` lists every variable.';
        if ($mode === 'a2a') {
            $L[] = '- **Move an agent**: set `A2A_AGENT_<id>_URL` (and start the orchestrator with `--no-spawn` when every agent runs elsewhere); `A2A_BASE_PORT` moves the whole port range.';
        }
        return implode("\n", $L);
    }
}
