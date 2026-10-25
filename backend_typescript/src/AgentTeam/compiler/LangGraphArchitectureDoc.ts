import { LangGraphGenerator } from '../LangGraphGenerator';
import { GraphAnalyzer } from './GraphAnalyzer';
import { LangGraphPackage } from './LangGraphPackage';
import { LangGraphRuntime } from './LangGraphRuntime';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { array_unique, empty, entries, has, implode, is_array, isEmptyArr, str_replace, strtolower, strval, ucfirst, values } from './php';

/**
 * ARCHITECTURE.md for one LangGraph compile: what the emitted package is made of and how it runs, written for THIS
 * workflow and THIS mode (single file, modular package or A2A). Ported from
 * backend/src/AgentTeam/Services/LangGraphArchitectureDoc.php.
 */

const MODE_LABELS: Record<string, string> = {
  single: 'single file',
  modular: 'modular package',
  a2a: 'A2A (one agent server per node)',
};

/** PHP `$x['a']['b'] ?? null`. */
function dig(x: any, ...keys: string[]): any {
  let v = x;
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== 'object') return null;
    v = Array.isArray(v) ? v[Number(k)] : v[k];
  }
  return v === undefined ? null : v;
}

function coalesce(...xs: any[]): any {
  for (const x of xs) if (x !== null && x !== undefined) return x;
  return null;
}

/** The agent entries that are dispatchers (array_filter on agentData by !empty(dispatch)). */
function dispatchersOf(facts: any): any[] {
  return values(facts['agentData']).filter((ad: any) => !empty(dig(ad, 'dispatch')));
}

export class LangGraphArchitectureDoc {
  /** The Markdown document. facts is LangGraphGenerator.analyzeForEmit()'s result; mode is 'single', 'modular' or 'a2a'. */
  static build(facts: any, mode: string): string {
    const classes = LangGraphArchitectureDoc.presentClasses(facts, mode);
    const sections = [
      LangGraphArchitectureDoc.overview(facts, mode),
      LangGraphArchitectureDoc.filesSection(facts, mode),
      '## Class diagram\n\n```mermaid\n' + LangGraphArchitectureDoc.classDiagram(classes, mode) + '```',
      '## Workflow diagram\n\n```mermaid\n' + LangGraphArchitectureDoc.workflowDiagram(facts) + '```',
      LangGraphArchitectureDoc.classesSection(facts, mode, classes),
      LangGraphArchitectureDoc.runFlowSection(facts, mode),
      LangGraphArchitectureDoc.changeSection(facts, mode),
    ];
    return implode('\n\n', sections) + '\n';
  }

  /** The classes this output really contains, in the order the Classes section describes them. */
  private static presentClasses(facts: any, mode: string): string[] {
    const withPlaybook = !empty(dig(facts, 'playbookData'));
    const classes = ['WorkflowGraph', 'Node', 'AgentNode', 'DispatcherNode'];
    if (withPlaybook) classes.push('PlaybookNode');
    classes.push('NodeKind', 'Dispatcher');
    const adapters = new Set<string>();
    for (const ad of values(coalesce(dig(facts, 'agentData'), []))) {
      for (const c of values(coalesce(dig(ad, 'decision'), []))) {
        adapters.add(strval(LangGraphRuntime.ADAPTER_CLASSES[c['protocol']]));
      }
    }
    classes.push(...adapters);
    classes.push('DecisionResult', 'RouteDecision', 'ToolCatalog', 'McpClient', 'SkillRuntime', 'RunEvents');
    if (withPlaybook) classes.push('PlaybookRun', 'PlaybookToolset');
    classes.push('DocumentConverter');
    if (mode === 'a2a') classes.push('AgentSupervisor', 'NodeExecutor');
    return classes;
  }

  /** Title and the one-paragraph overview: the workflow, the mode, what runs where. */
  private static overview(facts: any, mode: string): string {
    const name = strval(facts['wfName']);
    const counts = LangGraphArchitectureDoc.nodeCounts(facts);
    let where: string;
    switch (mode) {
      case 'single':
        where = 'One self-contained Python script runs the whole workflow in one process: it holds the '
          + 'runtime classes, the frozen settings of every node and the graph.';
        break;
      case 'modular':
        where = 'One Python package runs the whole workflow in one process. `workflow.py` wires the '
          + 'LangGraph graph, `common.py` holds every runtime class, and each agent or playbook node is a '
          + 'small data module under `agents/`.';
        break;
      default:
        where = '`orchestrator.py` runs the LangGraph graph and calls every agent or playbook node over the '
          + 'A2A protocol (HTTP). Each node is its own agent server under `agents/`: a self-contained file '
          + 'with its own copy of the runtime classes it needs, so it can be deployed alone. By default the '
          + 'orchestrator starts those servers itself on local ports.';
    }
    return `# ${name}: architecture\n\n`
      + `Workflow ${strval(facts['workflowId'])} "${name}", compiled by the SynergyAI workflow editor to LangGraph `
      + '(Python), ' + strval(MODE_LABELS[mode]) + ` mode. ${where} The workflow has ${counts}. `
      + 'Everything here is generated: change the workflow in the editor and generate again rather than '
      + 'editing the files.';
  }

  /** "7 nodes: 1 start, 3 agents, 1 dispatcher, 1 playbook, 1 output". */
  private static nodeCounts(facts: any): string {
    const n = new Map<string, number>();
    for (const nid of values(facts['order'])) {
      const kind = LangGraphArchitectureDoc.kindOf(facts, strval(nid));
      n.set(kind, (n.get(kind) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [kind, c] of n) parts.push(`${c} ${kind}` + (c > 1 ? (kind === 'dispatcher' ? 'es' : 's') : ''));
    return values(facts['order']).length + ' nodes: ' + implode(', ', parts);
  }

  /** The node's kind: agent, dispatcher or playbook (from the facts), else its canvas type (start, output...). */
  private static kindOf(facts: any, nid: string): string {
    if (has(dig(facts, 'agentData'), nid)) return !empty(dig(facts, 'agentData', nid, 'dispatch')) ? 'dispatcher' : 'agent';
    if (has(dig(facts, 'playbookData'), nid)) return 'playbook';
    if (has(dig(facts, 'codeData'), nid)) return 'code';
    return GraphAnalyzer.typeOf(coalesce(dig(facts, 'byId', nid), []));
  }

  /** The node's name as the editor shows it; Start/Output by their type. */
  private static nameOf(facts: any, nid: string): string {
    const display = coalesce(dig(facts, 'agentData', nid, 'display'), dig(facts, 'playbookData', nid, 'display'), dig(facts, 'codeData', nid, 'display'));
    return display !== null ? strval(display) : ucfirst(LangGraphArchitectureDoc.kindOf(facts, nid));
  }

  /** Files table: every file of the output and its role, then the principle that splits them. */
  private static filesSection(facts: any, mode: string): string {
    const rows: Array<[string, string]> = [];
    const agentRole = (e: any, nid: string) => `Node ${nid} "` + LangGraphArchitectureDoc.cell(strval(e['display'])) + `" (${strval(e['kind'])})`;
    let principle: string;
    switch (mode) {
      case 'single':
        rows.push([`${strval(facts['safeName'])}_langgraph.py`, 'The whole workflow: the runtime classes, every node\'s '
          + 'frozen settings (`AGENTS`, `PLAYBOOKS`), the graph structure (`EDGES`, `ORDER`, `NODE_TYPES`), '
          + 'the node runner `_run_local_node` and the command-line entry point.']);
        principle = 'One file, read top to bottom: the classes first, then the node settings (data), then '
          + 'the graph and `__main__`. Node settings are data; the classes are behaviour.';
        break;
      case 'modular': {
        const layout = LangGraphGenerator.modularLayout(facts);
        rows.push(['workflow.py', 'Wires the graph: the agent table (`AGENTS`), `EDGES`, `ORDER`, `NODE_TYPES`, '
          + 'the node runner `_run_node_module` that calls each agent module, and the command-line entry point.']);
        rows.push(['common.py', 'Behaviour: every runtime class (nodes, dispatcher, Jev, tools, MCP, skills, events'
          + (empty(dig(facts, 'playbookData')) ? '' : ', playbook') + ', documents, graph), the LLM factory '
          + '`_make_llm`, `save_output` and `print_run_summary`.']);
        rows.push(['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
          + 'and answer human gates. It drives `workflow.py`; it holds no graph.']);
        rows.push(['agents/__init__.py', 'Package marker of the agent modules.']);
        for (const [nid, e] of entries(layout['agents'])) {
          rows.push([strval(e['file']), agentRole(e, nid) + ': its `NODE` settings and `run_node = make_node(NODE).run`.']);
        }
        rows.push(...LangGraphArchitectureDoc.packageRows(facts));
        principle = 'Agent files are data (`NODE` + `run_node = make_node(NODE).run`), `common.py` is behaviour, '
          + '`workflow.py` wires the graph.';
        break;
      }
      default: {
        const layout = LangGraphGenerator.a2aLayout(facts);
        rows.push(['orchestrator.py', 'Runs the graph (`WorkflowGraph`) and calls each node over A2A '
          + '(`_run_remote_node`); `AgentSupervisor` starts and stops the agent servers; holds no node logic.']);
        rows.push(['api.py', 'Run server: the HTTP run protocol the editor uses to start a run, stream its events '
          + 'and answer human gates. It drives `orchestrator.py` and starts the agent servers.']);
        for (const [nid, e] of entries(layout['agents'])) {
          rows.push([strval(e['file']), agentRole(e, nid) + `: a self-contained A2A server (port ${strval(e['port'])}): `
            + 'its `NODE` settings, `run_node = make_node(NODE).run`, the runtime classes it needs and `NodeExecutor`.']);
        }
        principle = 'Each agent file is one deployable server: its data (`NODE`), '
          + '`run_node = make_node(NODE).run`, and its own copy of the classes it needs. `orchestrator.py` wires '
          + 'the graph and never runs a model itself.';
      }
    }
    rows.push(['ARCHITECTURE.md', 'This document.']);
    const L = ['## Files', '', '| File | Role |', '|---|---|'];
    for (const [file, role] of rows) L.push(`| \`${file}\` | ${role} |`);
    L.push('');
    L.push(principle);
    return implode('\n', L);
  }

  /** The modular package's own files (LangGraphPackage): code files, the harness, setup files, skills, documents. */
  private static packageRows(facts: any): Array<[string, string]> {
    const rows: Array<[string, string]> = [];
    if (!isEmptyArr(coalesce(dig(facts, 'codeData'), []))) {
      rows.push(['code_harness.py', 'The code-node sandbox, the same file the editor runs: standard library only, '
        + 'network only through `call_tool`, one of the node\'s exits, its timeout.']);
      for (const [nid, cd] of entries(facts['codeData'])) {
        if (has(cd, 'source_file')) {
          rows.push([strval(cd['source_file']), `Node ${nid} "` + LangGraphArchitectureDoc.cell(strval(cd['display'])) + '" (code): its '
            + '`run(input, call_tool)`, read at each run, so an edit takes effect on the next run.']);
        }
      }
    }
    rows.push(['requirements.txt', 'The Python packages to install (`pip install -r requirements.txt`).']);
    rows.push(['.env.example', 'Every variable the program reads: provider keys, MCP URLs and headers, output and run folders.']);
    rows.push(['README.md', 'Install, modes, files written, the run server, running as a service.']);
    for (const d of LangGraphPackage.skillDirs(facts)) {
      rows.push([`skills/${d}/`, 'Skill "' + LangGraphArchitectureDoc.cell(d) + '", copied with all its files: what `SkillRuntime` runs.']);
    }
    for (const doc of values(coalesce(dig(facts, 'startDocuments'), []))) {
      if (strval(is_array(doc) ? coalesce(dig(doc, 'path'), '') : '').startsWith('start_documents/')) {
        rows.push(['start_documents/', 'The Start node\'s documents, converted to Markdown by `DocumentConverter` at each run.']);
        break;
      }
    }
    return rows;
  }

  /** Mermaid classDiagram of the classes present; relations only between present classes. */
  private static classDiagram(classes: string[], mode: string): string {
    const has_ = new Set(classes);
    const L = ['classDiagram'];
    L.push('    class Node {');
    L.push('        <<abstract>>');
    L.push('        +cfg');
    L.push('        +llm');
    L.push('        +tools');
    L.push('        +run(request, trace)');
    L.push('    }');
    L.push('    class NodeKind {');
    L.push('        <<enumeration>>');
    L.push('        AGENT');
    L.push('        DISPATCHER');
    if (has_.has('PlaybookNode')) L.push('        PLAYBOOK');
    L.push('    }');
    L.push('    class WorkflowGraph {');
    L.push('        +compile()');
    L.push('        +run(prompt)');
    L.push('    }');
    L.push('    class Dispatcher {');
    L.push('        +mode()');
    L.push('        +route(task, msgs, make_llm)');
    L.push('    }');
    const relations: Array<[string, string, string, string]> = [
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
    ];
    if (mode === 'a2a') {
      relations.push(['WorkflowGraph', '..>', 'NodeExecutor', 'A2A task']);
      relations.push(['NodeExecutor', '-->', 'Node', 'run_node']);
      relations.push(['AgentSupervisor', '..>', 'NodeExecutor', 'starts the servers']);
    } else {
      relations.push(['WorkflowGraph', '-->', 'Node', 'run_node']);
    }
    for (const [a, arrow, b, label] of relations) {
      if (has_.has(a) && has_.has(b)) L.push(`    ${a} ${arrow} ${b}` + (label !== '' ? ` : ${label}` : ''));
    }
    for (const c of ['RunEvents', 'ToolCatalog', 'SkillRuntime', 'McpClient', 'DocumentConverter']) {
      if (has_.has(c)) L.push(`    class ${c}`);
    }
    return implode('\n', L) + '\n';
  }

  /** Mermaid flowchart of this workflow: its nodes in ORDER, its edges; a dispatcher's menu edges are dotted "choice" edges. */
  private static workflowDiagram(facts: any): string {
    const L = ['flowchart LR'];
    const inSet = new Set<string>();
    for (const nid0 of values(facts['order'])) {
      const nid = strval(nid0);
      inSet.add(nid);
      const kind = LangGraphArchitectureDoc.kindOf(facts, nid);
      let label = str_replace('"', '#quot;', LangGraphArchitectureDoc.nameOf(facts, nid));
      if (!['start', 'output'].includes(kind)) label += ` (${kind})`;
      let shape: string;
      switch (kind) {
        case 'start':
        case 'output':
          shape = `(["${label}"])`;
          break;
        case 'dispatcher':
          shape = `{"${label}"}`;
          break;
        case 'playbook':
          shape = `[["${label}"]]`;
          break;
        case 'code':
          shape = `[/"${label}"/]`;
          break;
        default:
          shape = `["${label}"]`;
      }
      L.push('    ' + LangGraphArchitectureDoc.mid(nid) + shape);
    }
    for (const pair of values(facts['edgeList'])) {
      const from = strval(values(pair)[0]);
      const to = strval(values(pair)[1]);
      if (!inSet.has(from) || !inSet.has(to)) continue;
      const menu = values(coalesce(dig(facts, 'agentData', from, 'dispatch'), []))
        .filter((m: any) => m !== null && typeof m === 'object' && dig(m, 'id') !== null)
        .map((m: any) => strval(m['id']));
      const arrow = menu.includes(to) ? '-.->|choice|' : '-->';
      L.push('    ' + LangGraphArchitectureDoc.mid(from) + ` ${arrow} ` + LangGraphArchitectureDoc.mid(to));
    }
    return implode('\n', L) + '\n';
  }

  /** A Mermaid-safe node id for a workflow node id (PHP's byte-wise \W: one '_' per non-word byte). */
  private static mid(nid: string): string {
    let out = 'n';
    for (const ch of nid) out += /^[A-Za-z0-9_]$/.test(ch) ? ch : '_'.repeat(Buffer.byteLength(ch, 'utf8'));
    return out;
  }

  /** Classes: where they live in this mode, then one short paragraph per class present. */
  private static classesSection(facts: any, mode: string, classes: string[]): string {
    const runNode = mode === 'single' ? '`_run_local_node`, which calls the node in this process'
      : mode === 'modular' ? '`workflow.py`\'s `_run_node_module`, which calls the node\'s agent module'
      : '`orchestrator.py`\'s `_run_remote_node`, which sends the node an A2A task';
    const noDispatcher = dispatchersOf(facts).length === 0;
    const unused = noDispatcher ? ' This workflow has no dispatcher node, so it is emitted but not used.' : '';
    const text: Record<string, string> = {
      WorkflowGraph: 'Builds the LangGraph `StateGraph` from the frozen `EDGES`, `ORDER` and `NODE_TYPES` and runs '
        + 'it (`run(prompt)`). Start and Output run inside it with no LLM; every agent or playbook node goes through '
        + `the \`run_node\` the mode supplies, here ${runNode}. A dispatcher's menu children hang off one conditional `
        + 'edge, so only the chosen child runs.',
      Node: 'Abstract base of the node kinds. Holds the node\'s frozen settings (`cfg`) and builds its chat model '
        + '(`llm`, through `_make_llm`) and its catalog tools on first use, so a missing provider package or key '
        + 'fails only that node. `run(request, trace)` returns `{"text", "route", "notes", "status"}`; '
        + '`make_node(cfg)` builds the subclass for `cfg["kind"]`.',
      AgentNode: 'An agent node: a LangChain ReAct loop (`create_react_agent`) over its MCP tools, then its mandatory '
        + 'skill steps in order; the last skill\'s produced file becomes the node\'s output.',
      DispatcherNode: 'A dispatcher node: no ReAct loop. It asks its `Dispatcher` for one child and returns that '
        + 'child\'s id as `route`.' + unused,
      PlaybookNode: 'A playbook node: runs the playbook interpreter (a ReAct loop over the `PlaybookToolset`, with '
        + 'a `PlaybookRun` recording it) and returns the Markdown transcript of what the playbook did.',
      NodeKind: 'Enum of the node kinds `make_node` matches on (`agent`, `dispatcher`'
        + (classes.includes('PlaybookNode') ? ', `playbook`' : '') + ').',
      Dispatcher: 'Picks exactly one child for a dispatcher node, through a decision model or through one forced '
        + '`route_to` model call, never both. `mode()` reads the node\'s routing mode: `llm`, a decision provider, '
        + 'or unset (the first compiled decision model whose key is set, else the model). Returns a '
        + '`RouteDecision`; no choice means the run stops at the dispatcher.' + unused,
      JevRouter: 'Client for TypeSafe Jev (the `typesafe` decision protocol): asks a closed routing question over '
        + 'the dispatcher\'s menu (plus an `unclear` option) and returns a `DecisionResult`. It never raises.',
      OpenAIDecisionRouter: 'Client for OpenAI\'s Decisions API, GPT-6 Luna (the `openai` decision protocol): asks '
        + 'a closed routing question over the dispatcher\'s menu (plus an `unclear` option) and returns a '
        + '`DecisionResult`. It never raises.',
      DecisionResult: 'Frozen record of one decision-model call: its outcome (`routed`, `unclear`, `low_confidence`, '
        + '`unavailable`, `error`), the chosen target, the confidence and the evidence.',
      RouteDecision: 'Frozen record of a dispatcher\'s answer: the text its child receives, the chosen child\'s id '
        + '(`route`, empty when none), notes and status.',
      ToolCatalog: 'The workflow\'s tools, built once on first use: turns the baked catalog (tool name, MCP server '
        + 'URL, description, JSON Schema) into LangChain tools that call `McpClient`, plus the local '
        + '`run_skill_script`. Each node takes its own tools by name.',
      McpClient: 'Calls one tool on an MCP server over JSON-RPC 2.0 on HTTP (initialize, then `tools/call`; plain '
        + 'JSON or SSE replies) and returns its text.',
      SkillRuntime: 'Runs folder-backed skills as Python subprocesses (the skills folder, the `/outputs` and '
        + '`/scratch` folders, installed dependencies), so a skill step can hand the document it produced on as '
        + 'the node\'s output.',
      RunEvents: 'The run\'s event stream and human-gate rendezvous. `api.py` installs a sink '
        + '(`set_event_sink`) and receives every event; a human gate waits on it until `resolve_gate` answers. '
        + 'One instance, `EVENTS`, per process; it does nothing when nobody watches.',
      PlaybookRun: 'One playbook run: its event timeline, status and write ledger. It answers the human gates (on '
        + 'the console, by `PLAYBOOK_GATE_MODE`, through the run server'
        + (mode === 'a2a' ? ', or through the A2A gate bridge' : '') + ') and renders the transcript.',
      PlaybookToolset: 'The whitelisted tools of one playbook run: native verbs, human gates and the bound '
        + '#Actions (MCP calls). Every call is recorded on the run\'s timeline.',
      DocumentConverter: 'Converts a file attached to the Start node to Markdown: text formats verbatim; `.docx`, '
        + '`.pptx`, `.xlsx` and `.pdf` through parsers imported only when needed. Used by the graph\'s start node.',
      AgentSupervisor: 'In `orchestrator.py`: starts one agent server per node (ports from 8701, moved by '
        + '`A2A_BASE_PORT`), waits for each Agent Card and checks its version, relays their output, and stops '
        + 'them after the run unless `--keep-serving`.',
      NodeExecutor: 'In each agent file: the A2A executor. A new task runs the node through `run_node` and '
        + 'returns the result (a dispatcher\'s chosen child travels in its data part); a follow-up message '
        + 'answers a gate the node is waiting on.',
    };
    const where = mode === 'single' ? `All classes live in \`${strval(facts['safeName'])}_langgraph.py\`.`
      : mode === 'modular' ? 'All classes live in `common.py`; the agent modules and `workflow.py` only import them.'
      : '`orchestrator.py` holds `WorkflowGraph`, `DocumentConverter`, `RunEvents` and `AgentSupervisor`. '
        + 'Each agent file holds its own copy of the node-side classes: `Node` with the agent and dispatcher '
        + 'subclasses' + (empty(dig(facts, 'playbookData')) ? '' : ' (and `PlaybookNode`, `PlaybookRun`, `PlaybookToolset` in a playbook agent)')
        + ', the dispatcher and Jev classes, tools, MCP, skills, `RunEvents` and `NodeExecutor`.';
    const L = ['## Classes', '', where];
    for (const c of classes) {
      L.push('');
      L.push(`### ${c}`);
      L.push('');
      L.push(Object.hasOwn(text, c) ? text[c] : '');
    }
    return implode('\n', L);
  }

  /** How a run flows, from the entry point to the RUN SUMMARY, for this mode and workflow. */
  private static runFlowSection(facts: any, mode: string): string {
    const entry = mode === 'single'
      ? `\`python ${strval(facts['safeName'])}_langgraph.py "your prompt"\` (or code that imports the script and awaits its \`run()\`) builds the graph.`
      : mode === 'modular'
        ? '`python workflow.py "your prompt"` (or `api.py` calling `run()`) builds the graph over the agent modules.'
        : '`python orchestrator.py "your prompt"` (or `api.py` calling `run()`) first has `AgentSupervisor` '
          + 'start one agent server per node and wait until each serves its Agent Card, then builds the graph.';
    const call = mode === 'single'
      ? '`_run_local_node` runs the node\'s `Node.run` in this process'
      : mode === 'modular'
        ? '`_run_node_module` calls the node\'s module, `agents/<name>.py`, whose `run_node` is its `Node.run`'
        : '`_run_remote_node` sends an A2A task to the node\'s server, whose `NodeExecutor` calls `run_node` '
          + '(its `Node.run`) and streams status updates back';
    const noPlaybook = empty(dig(facts, 'playbookData'));
    const steps = [
      entry,
      '`WorkflowGraph.run(prompt)` compiles the `StateGraph` (one graph node per workflow node, in `ORDER`) and invokes it.',
      'The Start node passes the prompt on; files attached to it are converted to Markdown by `DocumentConverter` '
        + 'and placed before the prompt.',
      'Each agent' + (noPlaybook ? '' : ' or playbook') + ' node receives its framed input '
        + '(`build_context`: the original prompt plus each parent\'s output under its name'
        + (noPlaybook ? '' : '; a playbook gets its parents\' texts joined') + `), and ${call}. `
        + 'The node\'s time is recorded for the summary.',
      'An agent node (`AgentNode`) runs its ReAct loop over its tools (`ToolCatalog` calling MCP servers through '
        + '`McpClient`), then each attached skill (`SkillRuntime`) on the answer.',
    ];
    const dispatchers = dispatchersOf(facts);
    if (dispatchers.length) {
      const modes: string[] = [];
      for (const ad of dispatchers) {
        const m = coalesce(dig(ad, 'routing_mode'), '');
        modes.push(`"${strval(ad['display'])}": ` + (m === 'llm' ? 'the model'
          : (m === '' ? 'the first decision model whose key is set, else the model' : `decision model \`${strval(m)}\``)));
      }
      const adapters = new Set<string>();
      for (const ad of dispatchers) {
        for (const c of values(coalesce(dig(ad, 'decision'), []))) {
          adapters.add('`' + strval(LangGraphRuntime.ADAPTER_CLASSES[c['protocol']]) + '`');
        }
      }
      const adapterList = adapters.size ? implode(', ', [...adapters]) : '`JevRouter`';
      steps.push('A dispatcher node (`DispatcherNode`) asks its `Dispatcher`, which routes with a decision model (' + adapterList + ') or '
        + 'with one forced `route_to` model call, never both (' + implode('; ', modes) + '). The chosen '
        + 'child\'s id comes back as `route` and drives the conditional edge, so only that child runs. When '
        + 'nothing is chosen (the decision model unclear or below its confidence floor, no key, an error), the run stops there '
        + 'and the dispatcher\'s message is the result.');
    }
    if (!noPlaybook) {
      steps.push('A playbook node (`PlaybookNode`) runs the playbook with a `PlaybookRun` and its `PlaybookToolset`; '
        + 'human gates are asked on the console, answered by `PLAYBOOK_GATE_MODE`, or sent to the watching run '
        + 'server' + (mode === 'a2a' ? ' (from an agent server, through the orchestrator)' : '') + '. Its output is the transcript.');
    }
    const storage = facts['workflow'].isOutputStorageEnabled() ? 'ON, so the result is saved' : 'OFF, so the result is only printed';
    steps.push('The Output node takes its lone parent\'s text verbatim, or every parent\'s text under its name.');
    steps.push(`The final output is printed, \`save_output\` applies the Output node's storage setting (${storage}), `
      + 'and `print_run_summary` prints the RUN SUMMARY (time per node, total time, where the document went).'
      + (mode === 'a2a' ? ' The supervisor then stops the agent servers unless `--keep-serving`.' : ''));
    const L = ['## How a run flows', ''];
    steps.forEach((s, i) => L.push(`${i + 1}. ` + s));
    return implode('\n', L);
  }

  /** How to change it: add an agent, change behaviour, where keys come from. */
  private static changeSection(facts: any, mode: string): string {
    const newAgent = mode === 'single' ? 'a new entry in `AGENTS` in the script'
      : mode === 'modular' ? 'a new data file `agents/<name>.py` (its `NODE`) and its entry in `workflow.py`'
      : 'a new agent server `agents/<id>_<name>.py` and its entry in `orchestrator.py`';
    const runtime = mode === 'single' ? 'the runtime classes in the script'
      : mode === 'modular' ? 'the runtime classes in `common.py`'
      : 'the runtime classes in `orchestrator.py` and the agent files';
    const keys = new Map<string, string[]>();
    for (const d of [...values(facts['agentData']), ...values(facts['playbookData'])]) {
      const p = coalesce(dig(d, 'provider'), '');
      const k = p !== '' ? PythonEmitHelpers.providerKeyEnv(strval(p)) : null;
      if (k !== null) {
        if (!keys.has(k)) keys.set(k, []);
        keys.get(k)!.push(strtolower(strval(p)));
      }
    }
    const keyList: string[] = [];
    for (const [k, provs] of keys) keyList.push(`\`${k}\` (` + implode(', ', array_unique(provs)) + ')');
    const hasDispatcher = dispatchersOf(facts).length > 0;
    const L = ['## How to change it', ''];
    L.push('- **Add an agent**: add the node on the workflow canvas, connect it, and generate again. That gives '
      + `${newAgent}, plus its edges in \`EDGES\`.`);
    L.push(`- **Change behaviour**: ${runtime} are emitted by the compiler (the backend's \`LangGraphRuntime\` and `
      + '`LangGraphGenerator`). Change them there, never by hand-editing the output: the next generation overwrites it.');
    L.push('- **Change a node\'s settings** (prompt, model, tools, skills, routing): edit the node in the editor and generate again.');
    L.push('- **Keys** come from `.env` in the runner folder (`python/.env`), which the editor refreshes on every '
      + 'generation: ' + (keyList.length ? implode(', ', keyList) : 'no provider key is needed by this workflow')
      + (hasDispatcher ? '; one `<PROVIDER>_API_KEY` per decision model' : '') + '.');
    return implode('\n', L);
  }

  /** Text safe inside a Markdown table cell. */
  private static cell(s: string): string {
    return str_replace(['|', '\n', '\r'], ['\\|', ' ', ' '], s);
  }
}
