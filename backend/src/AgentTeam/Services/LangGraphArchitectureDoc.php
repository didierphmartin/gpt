<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * ARCHITECTURE.md for one LangGraph compile: what the emitted package is made
 * of and how it runs, written for THIS workflow and THIS mode (single file,
 * modular package or A2A).
 *
 * LangGraph-owned, like LangGraphRuntime: the other compile targets emit no
 * such document. Every name it prints -- files, classes, functions -- is one
 * LangGraphGenerator / LangGraphRuntime actually emits for the mode; when an
 * emitted class or file is renamed, this text has to follow
 * (LangGraphArchitectureDocTest checks each described class is really in the
 * generated code).
 */
final class LangGraphArchitectureDoc
{
    private const MODE_LABELS = [
        'single' => 'single file',
        'modular' => 'modular package',
        'a2a' => 'A2A (one agent server per node)',
    ];

    /**
     * The Markdown document. $facts is LangGraphGenerator::analyzeForEmit()'s
     * result; $mode is 'single', 'modular' or 'a2a'.
     */
    public static function build(array $facts, string $mode): string
    {
        $classes = self::presentClasses($facts, $mode);
        $sections = [
            self::overview($facts, $mode),
            self::filesSection($facts, $mode),
            "## Class diagram\n\n```mermaid\n" . self::classDiagram($classes, $mode) . "```",
            "## Workflow diagram\n\n```mermaid\n" . self::workflowDiagram($facts) . "```",
            self::classesSection($facts, $mode, $classes),
            self::runFlowSection($facts, $mode),
            self::changeSection($facts, $mode),
        ];
        return implode("\n\n", $sections) . "\n";
    }

    /**
     * The classes this output really contains, in the order the Classes
     * section describes them. Every mode emits the node, dispatcher, tool,
     * skill, MCP, event, document and graph classes; the playbook classes
     * only when the workflow has a playbook node; A2A adds its supervisor
     * (orchestrator.py) and executor (each agent file).
     */
    private static function presentClasses(array $facts, string $mode): array
    {
        $withPlaybook = !empty($facts['playbookData']);
        $classes = ['WorkflowGraph', 'Node', 'AgentNode', 'DispatcherNode'];
        if ($withPlaybook) {
            $classes[] = 'PlaybookNode';
        }
        array_push($classes, 'NodeKind', 'Dispatcher', 'JevRouter', 'JevResult', 'RouteDecision', 'RoutingMode',
            'ToolCatalog', 'McpClient', 'SkillRuntime', 'RunEvents');
        if ($withPlaybook) {
            array_push($classes, 'PlaybookRun', 'PlaybookToolset');
        }
        $classes[] = 'DocumentConverter';
        if ($mode === 'a2a') {
            array_push($classes, 'AgentSupervisor', 'NodeExecutor');
        }
        return $classes;
    }

    /** Title and the one-paragraph overview: the workflow, the mode, what runs where. */
    private static function overview(array $facts, string $mode): string
    {
        $name = $facts['wfName'];
        $counts = self::nodeCounts($facts);
        $where = match ($mode) {
            'single' => 'One self-contained Python script runs the whole workflow in one process: it holds the '
                . 'runtime classes, the frozen settings of every node and the graph.',
            'modular' => 'One Python package runs the whole workflow in one process. `workflow.py` wires the '
                . 'LangGraph graph, `common.py` holds every runtime class, and each agent or playbook node is a '
                . 'small data module under `agents/`.',
            default => '`orchestrator.py` runs the LangGraph graph and calls every agent or playbook node over the '
                . 'A2A protocol (HTTP). Each node is its own agent server under `agents/`: a self-contained file '
                . 'with its own copy of the runtime classes it needs, so it can be deployed alone. By default the '
                . 'orchestrator starts those servers itself on local ports.',
        };
        return "# {$name}: architecture\n\n"
            . "Workflow {$facts['workflowId']} \"{$name}\", compiled by the SynergyAI workflow editor to LangGraph "
            . '(Python), ' . self::MODE_LABELS[$mode] . " mode. {$where} The workflow has {$counts}. "
            . 'Everything here is generated: change the workflow in the editor and generate again rather than '
            . 'editing the files.';
    }

    /** "7 nodes: 1 start, 3 agents, 1 dispatcher, 1 playbook, 1 output". */
    private static function nodeCounts(array $facts): string
    {
        $n = [];
        foreach ($facts['order'] as $nid) {
            $kind = self::kindOf($facts, (string) $nid);
            $n[$kind] = ($n[$kind] ?? 0) + 1;
        }
        $parts = [];
        foreach ($n as $kind => $c) {
            $parts[] = "{$c} {$kind}" . ($c > 1 ? ($kind === 'dispatcher' ? 'es' : 's') : '');
        }
        return count($facts['order']) . ' nodes: ' . implode(', ', $parts);
    }

    /** The node's kind: agent, dispatcher or playbook (from the facts), else its canvas type (start, output...). */
    private static function kindOf(array $facts, string $nid): string
    {
        if (isset($facts['agentData'][$nid])) {
            return !empty($facts['agentData'][$nid]['dispatch']) ? 'dispatcher' : 'agent';
        }
        if (isset($facts['playbookData'][$nid])) {
            return 'playbook';
        }
        return WorkflowGraphAnalyzer::typeOf($facts['byId'][$nid] ?? []);
    }

    /** The node's name as the editor shows it; Start/Output by their type. */
    private static function nameOf(array $facts, string $nid): string
    {
        $display = $facts['agentData'][$nid]['display'] ?? $facts['playbookData'][$nid]['display'] ?? null;
        return $display ?? ucfirst(self::kindOf($facts, $nid));
    }

    /** Files table: every file of the output and its role, then the principle that splits them. */
    private static function filesSection(array $facts, string $mode): string
    {
        $rows = [];
        $agentRole = fn(array $e, $nid) => "Node {$nid} \"" . self::cell($e['display']) . "\" ({$e['kind']})";
        switch ($mode) {
            case 'single':
                $rows[] = ["{$facts['safeName']}_langgraph.py", 'The whole workflow: the runtime classes, every node\'s '
                    . 'frozen settings (`AGENTS`, `PLAYBOOKS`), the graph structure (`EDGES`, `ORDER`, `NODE_TYPES`), '
                    . 'the node runner `_run_local_node` and the command-line entry point.'];
                $principle = 'One file, read top to bottom: the classes first, then the node settings (data), then '
                    . 'the graph and `__main__`. Node settings are data; the classes are behaviour.';
                break;
            case 'modular':
                $layout = LangGraphGenerator::modularLayout($facts);
                $rows[] = ['workflow.py', 'Wires the graph: the agent table (`AGENTS`), `EDGES`, `ORDER`, `NODE_TYPES`, '
                    . 'the node runner `_run_node_module` that calls each agent module, and the command-line entry point.'];
                $rows[] = ['common.py', 'Behaviour: every runtime class (nodes, dispatcher, Jev, tools, MCP, skills, events'
                    . (empty($facts['playbookData']) ? '' : ', playbook') . ', documents, graph), the LLM factory '
                    . '`_make_llm`, `save_output` and `print_run_summary`.'];
                $rows[] = ['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
                    . 'and answer human gates. It drives `workflow.py`; it holds no graph.'];
                $rows[] = ['agents/__init__.py', 'Package marker of the agent modules.'];
                foreach ($layout['agents'] as $nid => $e) {
                    $rows[] = [$e['file'], $agentRole($e, $nid) . ': its `NODE` settings and `run_node = make_node(NODE).run`.'];
                }
                $principle = 'Agent files are data (`NODE` + `run_node = make_node(NODE).run`), `common.py` is behaviour, '
                    . '`workflow.py` wires the graph.';
                break;
            default:
                $layout = LangGraphGenerator::a2aLayout($facts);
                $rows[] = ['orchestrator.py', 'Runs the graph (`WorkflowGraph`) and calls each node over A2A '
                    . '(`_run_remote_node`); `AgentSupervisor` starts and stops the agent servers; holds no node logic.'];
                $rows[] = ['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
                    . 'and answer human gates. It drives `orchestrator.py` and starts the agent servers.'];
                foreach ($layout['agents'] as $nid => $e) {
                    $rows[] = [$e['file'], $agentRole($e, $nid) . ": a self-contained A2A server (port {$e['port']}): "
                        . 'its `NODE` settings, `run_node = make_node(NODE).run`, the runtime classes it needs and `NodeExecutor`.'];
                }
                $principle = 'Each agent file is one deployable server: its data (`NODE`), '
                    . '`run_node = make_node(NODE).run`, and its own copy of the classes it needs. `orchestrator.py` wires '
                    . 'the graph and never runs a model itself.';
        }
        $rows[] = ['ARCHITECTURE.md', 'This document.'];
        $L = ['## Files', '', '| File | Role |', '|---|---|'];
        foreach ($rows as [$file, $role]) {
            $L[] = "| `{$file}` | {$role} |";
        }
        $L[] = '';
        $L[] = $principle;
        return implode("\n", $L);
    }

    /** Mermaid classDiagram of the classes present; relations only between present classes. */
    private static function classDiagram(array $classes, string $mode): string
    {
        $has = array_flip($classes);
        $L = ['classDiagram'];
        $L[] = '    class Node {';
        $L[] = '        <<abstract>>';
        $L[] = '        +cfg';
        $L[] = '        +llm';
        $L[] = '        +tools';
        $L[] = '        +run(request, trace)';
        $L[] = '    }';
        $L[] = '    class NodeKind {';
        $L[] = '        <<enumeration>>';
        $L[] = '        AGENT';
        $L[] = '        DISPATCHER';
        if (isset($has['PlaybookNode'])) {
            $L[] = '        PLAYBOOK';
        }
        $L[] = '    }';
        $L[] = '    class RoutingMode {';
        $L[] = '        <<enumeration>>';
        $L[] = '        JEV';
        $L[] = '        LLM';
        $L[] = '    }';
        $L[] = '    class WorkflowGraph {';
        $L[] = '        +compile()';
        $L[] = '        +run(prompt)';
        $L[] = '    }';
        $L[] = '    class Dispatcher {';
        $L[] = '        +mode()';
        $L[] = '        +route(task, msgs, make_llm)';
        $L[] = '    }';
        $relations = [
            ['Node', '<|--', 'AgentNode', ''],
            ['Node', '<|--', 'DispatcherNode', ''],
            ['Node', '<|--', 'PlaybookNode', ''],
            ['Node', '..>', 'NodeKind', 'make_node'],
            ['DispatcherNode', '-->', 'Dispatcher', ''],
            ['Dispatcher', '-->', 'JevRouter', ''],
            ['Dispatcher', '..>', 'RoutingMode', ''],
            ['Dispatcher', '..>', 'RouteDecision', 'returns'],
            ['JevRouter', '..>', 'JevResult', 'returns'],
            ['AgentNode', '-->', 'ToolCatalog', ''],
            ['AgentNode', '-->', 'SkillRuntime', ''],
            ['ToolCatalog', '-->', 'McpClient', ''],
            ['PlaybookNode', '-->', 'PlaybookRun', ''],
            ['PlaybookNode', '-->', 'PlaybookToolset', ''],
            ['PlaybookRun', '-->', 'RunEvents', 'events and gates'],
            ['WorkflowGraph', '-->', 'DocumentConverter', 'start node'],
        ];
        if ($mode === 'a2a') {
            // The graph reaches a node only through its server's executor.
            $relations[] = ['WorkflowGraph', '..>', 'NodeExecutor', 'A2A task'];
            $relations[] = ['NodeExecutor', '-->', 'Node', 'run_node'];
            $relations[] = ['AgentSupervisor', '..>', 'NodeExecutor', 'starts the servers'];
        } else {
            $relations[] = ['WorkflowGraph', '-->', 'Node', 'run_node'];
        }
        foreach ($relations as [$a, $arrow, $b, $label]) {
            if (isset($has[$a], $has[$b])) {
                $L[] = "    {$a} {$arrow} {$b}" . ($label !== '' ? " : {$label}" : '');
            }
        }
        // A class no relation above names still gets drawn.
        foreach (['RunEvents', 'ToolCatalog', 'SkillRuntime', 'McpClient', 'DocumentConverter'] as $c) {
            if (isset($has[$c])) {
                $L[] = "    class {$c}";
            }
        }
        return implode("\n", $L) . "\n";
    }

    /** Mermaid flowchart of this workflow: its nodes in ORDER, its edges; a dispatcher's menu edges are dotted "choice" edges. */
    private static function workflowDiagram(array $facts): string
    {
        $L = ['flowchart LR'];
        $in = [];
        foreach ($facts['order'] as $nid) {
            $nid = (string) $nid;
            $in[$nid] = true;
            $kind = self::kindOf($facts, $nid);
            $label = str_replace('"', '#quot;', self::nameOf($facts, $nid));
            if (!in_array($kind, ['start', 'output'], true)) {
                $label .= " ({$kind})";
            }
            $L[] = '    ' . self::mid($nid) . match ($kind) {
                'start', 'output' => "([\"{$label}\"])",
                'dispatcher' => "{\"{$label}\"}",
                'playbook' => "[[\"{$label}\"]]",
                default => "[\"{$label}\"]",
            };
        }
        foreach ($facts['edgeList'] as [$from, $to]) {
            $from = (string) $from;
            $to = (string) $to;
            if (!isset($in[$from], $in[$to])) {
                continue;
            }
            $menu = array_map('strval', array_column($facts['agentData'][$from]['dispatch'] ?? [], 'id'));
            $arrow = in_array($to, $menu, true) ? '-.->|choice|' : '-->';
            $L[] = '    ' . self::mid($from) . " {$arrow} " . self::mid($to);
        }
        return implode("\n", $L) . "\n";
    }

    /** A Mermaid-safe node id for a workflow node id. */
    private static function mid(string $nid): string
    {
        return 'n' . preg_replace('/\W/', '_', $nid);
    }

    /** Classes: where they live in this mode, then one short paragraph per class present. */
    private static function classesSection(array $facts, string $mode, array $classes): string
    {
        $runNode = match ($mode) {
            'single' => '`_run_local_node`, which calls the node in this process',
            'modular' => '`workflow.py`\'s `_run_node_module`, which calls the node\'s agent module',
            default => '`orchestrator.py`\'s `_run_remote_node`, which sends the node an A2A task',
        };
        $noDispatcher = !array_filter($facts['agentData'], fn($ad) => !empty($ad['dispatch']));
        $unused = $noDispatcher ? ' This workflow has no dispatcher node, so it is emitted but not used.' : '';
        $text = [
            'WorkflowGraph' => 'Builds the LangGraph `StateGraph` from the frozen `EDGES`, `ORDER` and `NODE_TYPES` and runs '
                . 'it (`run(prompt)`). Start and Output run inside it with no LLM; every agent or playbook node goes through '
                . "the `run_node` the mode supplies, here {$runNode}. A dispatcher's menu children hang off one conditional "
                . 'edge, so only the chosen child runs.',
            'Node' => 'Abstract base of the node kinds. Holds the node\'s frozen settings (`cfg`) and builds its chat model '
                . '(`llm`, through `_make_llm`) and its catalog tools on first use, so a missing provider package or key '
                . 'fails only that node. `run(request, trace)` returns `{"text", "route", "notes", "status"}`; '
                . '`make_node(cfg)` builds the subclass for `cfg["kind"]`.',
            'AgentNode' => 'An agent node: a LangChain ReAct loop (`create_react_agent`) over its MCP tools, then its mandatory '
                . 'skill steps in order; the last skill\'s produced file becomes the node\'s output.',
            'DispatcherNode' => 'A dispatcher node: no ReAct loop. It asks its `Dispatcher` for one child and returns that '
                . 'child\'s id as `route`.' . $unused,
            'PlaybookNode' => 'A playbook node: runs the playbook interpreter (a ReAct loop over the `PlaybookToolset`, with '
                . 'a `PlaybookRun` recording it) and returns the Markdown transcript of what the playbook did.',
            'NodeKind' => 'Enum of the node kinds `make_node` matches on (`agent`, `dispatcher`'
                . (in_array('PlaybookNode', $classes, true) ? ', `playbook`' : '') . ').',
            'Dispatcher' => 'Picks exactly one child for a dispatcher node, through Jev or through one forced `route_to` '
                . 'model call, never both. `mode()` reads the node\'s routing mode; an unset mode means Jev when '
                . '`TYPESAFE_API_KEY` is set, else the model. Returns a `RouteDecision`; no choice means the run stops '
                . 'at the dispatcher.' . $unused,
            'JevRouter' => 'Client for TypeSafe Jev: asks a closed routing question over the dispatcher\'s menu (plus an '
                . '`unclear` option) and returns a `JevResult`. It never raises.',
            'JevResult' => 'Frozen record of one Jev call: its outcome (`routed`, `unclear`, `low_confidence`, '
                . '`unavailable`, `error`), the chosen target, the confidence and the evidence.',
            'RouteDecision' => 'Frozen record of a dispatcher\'s answer: the text its child receives, the chosen child\'s id '
                . '(`route`, empty when none), notes and status.',
            'RoutingMode' => 'Enum of the two routing modes, `jev` and `llm`.',
            'ToolCatalog' => 'The workflow\'s tools, built once on first use: turns the baked catalog (tool name, MCP server '
                . 'URL, description, JSON Schema) into LangChain tools that call `McpClient`, plus the local '
                . '`run_skill_script`. Each node takes its own tools by name.',
            'McpClient' => 'Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain '
                . 'JSON or SSE replies) and returns its text.',
            'SkillRuntime' => 'Runs folder-backed skills as Python subprocesses (the skills folder, the `/outputs` and '
                . '`/scratch` folders, installed dependencies), so a skill step can hand the document it produced on as '
                . 'the node\'s output.',
            'RunEvents' => 'The run\'s event stream and human-gate rendezvous. `api.py` installs a sink '
                . '(`set_event_sink`) and receives every event; a human gate waits on it until `resolve_gate` answers. '
                . 'One instance, `EVENTS`, per process; it does nothing when nobody watches.',
            'PlaybookRun' => 'One playbook run: its event timeline, status and write ledger. It answers the human gates (on '
                . 'the console, by `PLAYBOOK_GATE_MODE`, through the run server'
                . ($mode === 'a2a' ? ', or through the A2A gate bridge' : '') . ') and renders the transcript.',
            'PlaybookToolset' => 'The whitelisted tools of one playbook run: native verbs, human gates and the bound '
                . '#Actions (MCP calls). Every call is recorded on the run\'s timeline.',
            'DocumentConverter' => 'Converts a file attached to the Start node to Markdown: text formats verbatim; `.docx`, '
                . '`.pptx`, `.xlsx` and `.pdf` through parsers imported only when needed. Used by the graph\'s start node.',
            'AgentSupervisor' => 'In `orchestrator.py`: starts one agent server per node (ports from 8701, moved by '
                . '`A2A_BASE_PORT`), waits for each Agent Card and checks its version, relays their output, and stops '
                . 'them after the run unless `--keep-serving`.',
            'NodeExecutor' => 'In each agent file: the A2A executor. A new task runs the node through `run_node` and '
                . 'returns the result (a dispatcher\'s chosen child travels in its data part); a follow-up message '
                . 'answers a gate the node is waiting on.',
        ];
        $where = match ($mode) {
            'single' => "All classes live in `{$facts['safeName']}_langgraph.py`.",
            'modular' => 'All classes live in `common.py`; the agent modules and `workflow.py` only import them.',
            default => '`orchestrator.py` holds `WorkflowGraph`, `DocumentConverter`, `RunEvents` and `AgentSupervisor`. '
                . 'Each agent file holds its own copy of the node-side classes: `Node` with the agent and dispatcher '
                . 'subclasses' . (empty($facts['playbookData']) ? '' : ' (and `PlaybookNode`, `PlaybookRun`, `PlaybookToolset` in a playbook agent)')
                . ', the dispatcher and Jev classes, tools, MCP, skills, `RunEvents` and `NodeExecutor`.',
        };
        $L = ['## Classes', '', $where];
        foreach ($classes as $c) {
            $L[] = '';
            $L[] = "### {$c}";
            $L[] = '';
            $L[] = $text[$c];
        }
        return implode("\n", $L);
    }

    /** How a run flows, from the entry point to the RUN SUMMARY, for this mode and workflow. */
    private static function runFlowSection(array $facts, string $mode): string
    {
        $entry = match ($mode) {
            'single' => "`python {$facts['safeName']}_langgraph.py \"your prompt\"` (or code that imports the script and awaits its `run()`) builds the graph.",
            'modular' => '`python workflow.py "your prompt"` (or `api.py` calling `run()`) builds the graph over the agent modules.',
            default => '`python orchestrator.py "your prompt"` (or `api.py` calling `run()`) first has `AgentSupervisor` '
                . 'start one agent server per node and wait until each serves its Agent Card, then builds the graph.',
        };
        $call = match ($mode) {
            'single' => '`_run_local_node` runs the node\'s `Node.run` in this process',
            'modular' => '`_run_node_module` calls the node\'s module, `agents/<name>.py`, whose `run_node` is its `Node.run`',
            default => '`_run_remote_node` sends an A2A task to the node\'s server, whose `NodeExecutor` calls `run_node` '
                . '(its `Node.run`) and streams status updates back',
        };
        $steps = [
            $entry,
            '`WorkflowGraph.run(prompt)` compiles the `StateGraph` (one graph node per workflow node, in `ORDER`) and invokes it.',
            'The Start node passes the prompt on; files attached to it are converted to Markdown by `DocumentConverter` '
                . 'and placed before the prompt.',
            'Each agent' . (empty($facts['playbookData']) ? '' : ' or playbook') . ' node receives its framed input '
                . '(`build_context`: the original prompt plus each parent\'s output under its name'
                . (empty($facts['playbookData']) ? '' : '; a playbook gets its parents\' texts joined') . "), and {$call}. "
                . 'The node\'s time is recorded for the summary.',
            'An agent node (`AgentNode`) runs its ReAct loop over its tools (`ToolCatalog` calling MCP servers through '
                . '`McpClient`), then each attached skill (`SkillRuntime`) on the answer.',
        ];
        $dispatchers = array_filter($facts['agentData'], fn($ad) => !empty($ad['dispatch']));
        if ($dispatchers) {
            $modes = [];
            foreach ($dispatchers as $ad) {
                $m = $ad['routing_mode'] ?? '';
                $modes[] = "\"{$ad['display']}\": " . ($m === 'jev' ? 'Jev' : ($m === 'llm' ? 'the model' : 'Jev when `TYPESAFE_API_KEY` is set, else the model'));
            }
            $steps[] = 'A dispatcher node (`DispatcherNode`) asks its `Dispatcher`, which routes with Jev (`JevRouter`) or '
                . 'with one forced `route_to` model call, never both (' . implode('; ', $modes) . '). The chosen '
                . 'child\'s id comes back as `route` and drives the conditional edge, so only that child runs. When '
                . 'nothing is chosen (Jev unclear or below its confidence floor, no key, an error), the run stops there '
                . 'and the dispatcher\'s message is the result.';
        }
        if (!empty($facts['playbookData'])) {
            $steps[] = 'A playbook node (`PlaybookNode`) runs the playbook with a `PlaybookRun` and its `PlaybookToolset`; '
                . 'human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run '
                . 'server' . ($mode === 'a2a' ? ' (from an agent server, through the orchestrator)' : '') . '. Its output is the transcript.';
        }
        $storage = $facts['workflow']->isOutputStorageEnabled() ? 'ON, so the result is saved' : 'OFF, so the result is only printed';
        $steps[] = 'The Output node takes its lone parent\'s text verbatim, or every parent\'s text under its name.';
        $steps[] = "The final output is printed, `save_output` applies the Output node's storage setting ({$storage}), "
            . 'and `print_run_summary` prints the RUN SUMMARY (time per node, total time, where the document went).'
            . ($mode === 'a2a' ? ' The supervisor then stops the agent servers unless `--keep-serving`.' : '');
        $L = ['## How a run flows', ''];
        foreach ($steps as $i => $s) {
            $L[] = ($i + 1) . '. ' . $s;
        }
        return implode("\n", $L);
    }

    /** How to change it: add an agent, change behaviour, where keys come from. */
    private static function changeSection(array $facts, string $mode): string
    {
        $newAgent = match ($mode) {
            'single' => 'a new entry in `AGENTS` in the script',
            'modular' => 'a new data file `agents/<name>.py` (its `NODE`) and its entry in `workflow.py`',
            default => 'a new agent server `agents/<id>_<name>.py` and its entry in `orchestrator.py`',
        };
        $runtime = match ($mode) {
            'single' => 'the runtime classes in the script',
            'modular' => 'the runtime classes in `common.py`',
            default => 'the runtime classes in `orchestrator.py` and the agent files',
        };
        $keys = [];
        foreach (array_merge(array_values($facts['agentData']), array_values($facts['playbookData'])) as $d) {
            $k = ($d['provider'] ?? '') !== '' ? PythonEmitHelpers::providerKeyEnv($d['provider']) : null;
            if ($k !== null) {
                $keys[$k][] = strtolower($d['provider']);
            }
        }
        $keyList = [];
        foreach ($keys as $k => $provs) {
            $keyList[] = "`{$k}` (" . implode(', ', array_unique($provs)) . ')';
        }
        $hasDispatcher = (bool) array_filter($facts['agentData'], fn($ad) => !empty($ad['dispatch']));
        $L = ['## How to change it', ''];
        $L[] = '- **Add an agent**: add the node on the workflow canvas, connect it, and generate again. That gives '
            . "{$newAgent}, plus its edges in `EDGES`.";
        $L[] = "- **Change behaviour**: {$runtime} are emitted by the compiler (the backend's `LangGraphRuntime` and "
            . '`LangGraphGenerator`). Change them there, never by hand-editing the output: the next generation overwrites it.';
        $L[] = '- **Change a node\'s settings** (prompt, model, tools, skills, routing): edit the node in the editor and generate again.';
        $L[] = '- **Keys** come from `.env` in the runner folder (`python/.env`), which the editor refreshes on every '
            . 'generation: ' . ($keyList ? implode(', ', $keyList) : 'no provider key is needed by this workflow')
            . ($hasDispatcher ? '; `TYPESAFE_API_KEY` for Jev routing' : '') . '.';
        return implode("\n", $L);
    }

    /** Text safe inside a Markdown table cell. */
    private static function cell(string $s): string
    {
        return str_replace(['|', "\n", "\r"], ['\\|', ' ', ' '], $s);
    }
}
