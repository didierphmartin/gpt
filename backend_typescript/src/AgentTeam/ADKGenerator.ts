import { sql } from 'kysely';
import { db } from '../db/pools';
import {
  JSON_UNESCAPED_UNICODE, PhpFloat, count, empty, entries, floatval, has, implode, in_array, intval, is_array, json_encode,
  keysOf, oarr, preg_match, preg_replace, rtrim, str_replace, str_repeat, strtolower, strval, substr, toArr, toObject, values,
  var_export_scalar,
} from './compiler/php';
import { GraphAnalyzer } from './compiler/GraphAnalyzer';
import { PythonEmitHelpers } from './compiler/PythonEmitHelpers';
import { CompiledRuntimeEmit } from './compiler/CompiledRuntimeEmit';
import { CompiledA2AEmit } from './compiler/CompiledA2AEmit';
import { CompiledArchitectureDoc } from './compiler/CompiledArchitectureDoc';
import { CompiledPackage } from './compiler/CompiledPackage';
import { PlaybookEmit } from './compiler/PlaybookEmit';
import { RunServerEmitter } from './compiler/RunServerEmitter';
import { LangGraphPackage } from './compiler/LangGraphPackage';
import { LangGraphRuntime } from './compiler/LangGraphRuntime';
import { ADKPackage } from './compiler/ADKPackage';

/** What the generator reads a workflow, its graph and its agents through (WorkflowRepository, WorkflowGraphRepository, AgentRepository). */
export interface ADKRepositories {
  workflowRepo: { findById(id: number): Promise<any | null> | any };
  graphRepo: { getGraph(workflowId: number): Promise<{ nodes?: any[]; edges?: any[] }> | any };
  agentRepo: { findById(id: number): Promise<any | null> | any };
}

/** $a['k1']['k2']... ?? null over any PHP array shape. */
function dig(v: any, ...ks: string[]): any {
  let cur = v;
  for (const k of ks) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || !has(cur, k)) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

/** isset($a['k1']['k2']...) */
function isset(v: any, ...ks: string[]): boolean {
  return dig(v, ...ks) !== null;
}

/** PHP addslashes(): \ ' " and NUL escaped with a backslash. */
function addslashes(s: string): string {
  return strval(s).replace(/[\\'"\0]/g, (c) => (c === '\0' ? '\\0' : '\\' + c));
}

/** preg_replace('/[^A-Za-z0-9_]/', '_', $s) over UTF-8 bytes: one '_' per byte of any other character. */
function identBytes(s: string): string {
  let out = '';
  for (const ch of strval(s)) out += /^[A-Za-z0-9_]$/.test(ch) ? ch : '_'.repeat(Buffer.byteLength(ch, 'utf8'));
  return out;
}

/** The last key of a PHP array (array_key_last), null when empty. */
function lastKey(x: any): string | null {
  const ks = keysOf(x);
  return ks.length ? ks[ks.length - 1] : null;
}

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * ADKGenerator -- TypeScript port of backend/src/AgentTeam/Services/ADKGenerator.php.
 *
 * Generates a standalone Python Google ADK script from a saved workflow.
 * The generated file is fully independent of the backend -- it runs
 * directly against the Google ADK runtime using LiteLLM for multi-provider
 * model support. The output is byte-identical to the PHP generator's
 * (tests/CompilerTargetsParity.test.ts compares them on fixtures).
 *
 * emitAdk() is a pure static method (no DB/I/O) so it can be unit-tested
 * without a database. generate() does the DB lookup via GraphAnalyzer
 * and then delegates to emitAdk().
 */
export class ADKGenerator {
  constructor(
    private readonly workflowRepo: ADKRepositories['workflowRepo'],
    private readonly graphRepo: ADKRepositories['graphRepo'],
    private readonly agentRepo: ADKRepositories['agentRepo'],
    private readonly skillsRoot: string | null = null,   // the package copies the used skills from here
    private readonly startDocuments: any = null,         // the package copies the Start's documents from here
  ) {}

  /** Generate a Google ADK Python script for the given workflow: {filename, code, architecture}. */
  async generate(workflowId: number, userId: string | null = null): Promise<any> {
    const analyzed = await this.analyzeWorkflow(workflowId, userId);
    const filename = ADKGenerator.filename(analyzed);
    return CompiledArchitectureDoc.attach({
      filename,
      code: ADKGenerator.emitAdk(analyzed),
      package_files: CompiledPackage.singleFiles(analyzed, ADKPackage.TARGET, filename),
    }, analyzed, 'adk', 'single');
  }

  /** The single file's name: <workflow>_adk.py. */
  private static filename(analyzed: any): string {
    return strtolower(preg_replace('/[^a-z0-9_]+/i', '_', strval(analyzed['workflow']['name']))) + '_adk.py';
  }

  /** A workflow's field through its PHP-style getter (WorkflowView, Models\Workflow) or, on a plain record, by name. */
  private static workflowField(wf: any, getter: string, field: string): any {
    return typeof wf[getter] === 'function' ? wf[getter]() : (wf[field] ?? null);
  }

  /** Everything emitAdk() needs, read from the database at compile time (the program itself never reads it). */
  private async analyzeWorkflow(workflowId: number, userId: string | null): Promise<any> {
    // A swarm is a different architecture, not a packaging choice: one active
    // agent at a time with control moving by hand-off, against this target's
    // topological walk. Compiling it here would silently emit Start's fan-out
    // as concurrent execution -- the DAG reading of a canvas that means
    // something else. ADK can express a swarm and is planned (spec §9); it is not built yet.
    const wfForArch = await this.workflowRepo.findById(workflowId);
    if (wfForArch && ADKGenerator.workflowField(wfForArch, 'getOrchestration', 'orchestration') === 'swarm') {
      throw new Error(
        'This workflow is set to swarm orchestration, which ADK cannot compile. '
        + 'Compile it with LangGraph, or switch the workflow to "workflow" orchestration.',
      );
    }
    const analyzer = new GraphAnalyzer(this.workflowRepo, this.graphRepo, this.agentRepo);
    const analyzed: any = oarr(entries(await analyzer.analyze(workflowId, userId)));

    // Platform default model per provider (system_llm_settings) — an empty
    // node/agent model means "use the platform default" and must be resolved
    // at generation time (mirrors MAFGenerator; _make_model raises otherwise).
    const defaults: any = oarr();
    try {
      const rows = (await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(db)).rows;
      for (const row of rows) {
        if (!empty(row['model'])) {
          defaults[strtolower(strval(row['provider_key']))] = strval(row['model']);
        }
      }
    } catch (e: any) {
      console.error('[ADKGenerator] could not load provider default models: ' + (e?.message ?? String(e)));
    }
    analyzed['providerDefaultModels'] = defaults;

    // Playbook nodes: resolved once here (their #Action bindings need the MCP
    // catalog) and carried on $analyzed for the static emitters below.
    // PlaybookEmit is shared, so a playbook binds identically on every target.
    const playbooks: any = oarr();
    analyzed['playbooks'] = playbooks;
    for (const [pid, pnode] of entries(toArr(analyzed['byId'] ?? []))) {
      if (GraphAnalyzer.typeOf(pnode) !== 'playbook') {
        continue;
      }
      PlaybookEmit.refuseLangGraphOnly(pnode, (await this.graphRepo.getGraph(workflowId))['edges'] ?? []);
      playbooks[strval(pid)] = PlaybookEmit.nodeData(pnode, await analyzer.availableToolsById(userId), defaults, userId);
    }

    return CompiledRuntimeEmit.analyzeRuntime(analyzed, analyzer, db, this.agentRepo,
      await this.graphRepo.getGraph(workflowId), workflowId, userId);
  }

  /**
   * Pure emit entry-point.  Takes an AnalyzedGraph (from GraphAnalyzer)
   * and returns the full Python source as a string.  No DB/I/O.
   */
  static emitAdk(analyzed: any): string {
    return ADKGenerator.parts(analyzed).map((p) => p[1]).join('\n') + '\n';
  }

  /**
   * The script as [section, text] parts, in the single file's order: 'common' (the runtime), 'node:<id>'
   * (one node's agent), 'workflow' (assembly, run, CLI), 'single' (only in the single file: a banner over
   * nodes the package puts in agents/). emitAdk() joins them all; packageFiles() groups them by file.
   */
  private static parts(analyzed: any): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const add = (section: string, text: string): void => {
      out.push([section, text]);
    };
    const addEntries = (entriesOf: any): void => {
      const last = lastKey(entriesOf);
      for (const [id, text] of entries<string>(entriesOf)) {   // a blank line between nodes, as one joined block had
        add(`node:${id}`, id === last ? text : text + '\n');
      }
    };
    add('common', ADKGenerator.headerBlock(analyzed));

    add('common', ADKGenerator.banner('MODEL FACTORY',
      'Maps a node provider+model to an ADK model. Gemini is native;',
      'every other provider routes through LiteLLM (OpenAI-compatible',
      'endpoints for Grok/Kimi/DeepSeek/GLM). The node form Thinking',
      'attribute governs reasoning mode; hard API constraints only',
      '(kimi sampling, deepseek-v4 thinking rules) are applied here.',
      'To support a new provider: add a branch in _make_model.'));
    add('common', ADKGenerator.modelFactoryBlock());

    add('common', ADKGenerator.banner('MCP SERVER REGISTRY',
      'Baked at generation time from the workflow editor config.',
      'Maps server URL -> metadata. If a server moves, update the URL here.'));
    add('common', 'MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(analyzed['usedServers'], true));
    add('common', ADKGenerator.banner('TOOL CATALOG',
      'Each entry maps a tool name to its MCP server URL and JSON Schema.',
      'Only tools actually used by agents in this workflow are included.',
      'To add a tool: add an entry here AND reference it in the agent',
      'definitions below (catalog["<tool>"]).'));
    add('common', 'TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(analyzed['usedCatalog'], true));
    add('common', ADKGenerator.banner('MCP CLIENT',
      'HTTP JSON-RPC client used by every generated _tool_* function.'));
    add('common', CompiledRuntimeEmit.mcpClientBlock(analyzed));
    add('common', ADKGenerator.banner('DOCUMENT CONVERTER',
      'Turns a start-node attachment into markdown for the prompt.'));
    add('common', PythonEmitHelpers.documentConverterBlock());
    add('common', ADKGenerator.banner('TOOL WRAPPERS',
      'One typed FunctionTool per catalog entry; ADK introspects each',
      'function signature to build the tool schema the model sees.'));
    add('common', ADKGenerator.adkToolBuilderBlock(analyzed));

    // Emit skill runner only when the workflow actually uses skills.
    // Gated on the analyzer's 'skills' list (set by GraphAnalyzer.skillsFromConfig)
    // rather than the legacy skill_content/systemPrompt text check, so the helpers are
    // emitted iff at least one agent has a non-empty skills list.
    let needsSkills = false;
    for (const agent of values(analyzed['agents'])) {
      if (!empty(agent['skills'])) {
        needsSkills = true;
        break;
      }
    }
    if (needsSkills) {
      add('common', ADKGenerator.banner('SKILL RUNTIME',
        'Runs folder-backed skills (SKILL.md + scripts) as mandatory',
        'post-agent SequentialAgent steps: an LLM turn instructed by',
        'SKILL.md, then a capture agent that makes the node output the',
        'file the script PRODUCED (else the LLM text). Staged',
        'input_files are repaired if a model delivers them',
        'JSON-over-escaped. Scripts run as async subprocesses here.'));
      add('common', PythonEmitHelpers.skillDepsBlock());
      if (!empty(analyzed['package'])) {
        add('common', 'SKILLS_DIR = os.environ.get("SYNERGYAI_SKILLS_DIR") or os.path.join(PACKAGE_DIR, "skills")   # the package\'s own skills/');
      }
      add('common', ADKGenerator.skillRunnerBlock());
    }

    // catalog must be defined after build_tools_from_catalog() (from adkToolBuilderBlock).
    add('common', '# The tool objects agents reference by name as catalog["<tool>"].');
    add('common', 'catalog = build_tools_from_catalog()');
    // START_DOCUMENTS baked from the analyzed workflow; always present (empty list when none).
    add('common', 'START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(analyzed['startDocuments']));
    add('single', ADKGenerator.banner('AGENTS — ONE LlmAgent PER WORKFLOW NODE',
      'Each agent writes its result to session.state["node_<id>"]; a',
      'child reads a parent through the literal {node_<id>} placeholder',
      'in its instruction (ADK state templating). Provider/model/tools/',
      'sampling come verbatim from the editor forms (constraint clamps',
      'are documented as comments on the affected node). To change a',
      'node: edit the workflow in the editor and re-generate.'));
    addEntries(ADKGenerator.agentEntries(analyzed));

    const consolidators = ADKGenerator.outputConsolidatorsBlock(analyzed);
    if (consolidators !== '') {
      add('common', ADKGenerator.banner('OUTPUT (FAN-IN) NODES',
        'Non-LLM pass-throughs: forward parent result(s) VERBATIM so',
        'formatting such as HTML is never reworded by another model.'));
      add('common', ADKGenerator.passThroughAgentBlock());
      add('workflow', consolidators);
    }
    if (!empty(analyzed['playbooks'])) {
      add('common', ADKGenerator.banner('PLAYBOOK NODES',
        'A playbook node is an interpreter, not an agent: the model',
        're-decides each round from the running transcript, with the',
        'native verbs, the human gates, one tool per bound #Action and',
        'a stub per unbound one. The node output is that transcript.'));
      // ADK already emits its own mcpClientBlock() above, so the
      // interpreter's _call_mcp_tool is already defined -- do not re-emit it.
      add('common', PlaybookEmit.supportBlock(false));
      add('common', PlaybookEmit.runtimeBlock());
      add('common', PlaybookEmit.metadataBlock(analyzed['playbooks']));
      add('common', ADKGenerator.playbookAgentBlock());
      addEntries(ADKGenerator.playbookInstancesEntries(analyzed));
    }
    if (!empty(analyzed['code'])) {
      add('common', ADKGenerator.banner('CODE NODES',
        'A code node runs its own Python run(input, call_tool) through the',
        'harness the workflow editor runs (CODE_HARNESS): no model. Its',
        'output is state["node_<id>"], the exit it took state["route_<id>"].'));
      add('common', CompiledRuntimeEmit.codeHarnessBlock(!empty(analyzed['package'])));
      add('common', ADKGenerator.codeAgentBlock());
      addEntries(ADKGenerator.codeInstancesEntries(analyzed));
    }
    const dispatchers = ADKGenerator.dispatcherInstancesBlock(analyzed);
    if (dispatchers !== '') {
      add('common', ADKGenerator.banner('DISPATCHER NODES',
        'A dispatcher\'s outgoing edges are a MENU, not a fan-out: the',
        'node names ONE child and only that child runs. Its menu is',
        'nested here, which is why those children are absent from the',
        'topological layers below.'));
      const protocols: any = oarr();
      for (const d of values(toArr(analyzed['decisions'] ?? []))) {
        for (const c of values(d['decision'])) {
          protocols[strval(c['protocol'])] = true;
        }
      }
      add('common', 'from dataclasses import dataclass, field\nfrom functools import cached_property\n\n'
        + LangGraphRuntime.decisionAdaptersBlock(keysOf(protocols).filter((p) => has(LangGraphRuntime.ADAPTER_CLASSES, p))));
      add('common', ADKGenerator.dispatcherAgentBlock());
      add('workflow', dispatchers);
    }
    if (ADKGenerator.needsGates(analyzed)) {
      add('common', ADKGenerator.banner('ROUTING',
        'A node after a choice (a code node with several exits, a',
        'dispatcher) runs inside a _Gate: only when a parent ran and',
        'the exit it took leads here. Untaken branches are skipped.'));
      add('common', ADKGenerator.gateAgentBlock());
    }
    add('common', ADKGenerator.banner('RUN EVENTS',
      'Each node\'s start and completion (a code node\'s exit, a',
      'dispatcher\'s route) go to GRAPH_RECORDER when the package\'s',
      'listener set one: runs/ and GET /live, the editor\'s live canvas.'));
    add('common', CompiledRuntimeEmit.recordingBlock(analyzed, true));
    add('workflow', ADKGenerator.banner('ORCHESTRATION',
      'The workflow graph as TOPOLOGICAL LAYERS: independent nodes at',
      'the same depth run together in a ParallelAgent; the layers run',
      'in order inside a SequentialAgent. This mirrors the canvas.'));
    add('workflow', ADKGenerator.rootBlock(analyzed));
    add('workflow', ADKGenerator.banner('CLI ENTRY',
      'Seeds the prompt (+ attached documents), runs the graph via',
      'Runner, streams a [node]/[tool] trace, saves the result per the',
      'Output node storage setting, and closes with a RUN SUMMARY',
      '(time per node, total wall-clock, document location).'));
    add('workflow', ADKGenerator.mainBlock(analyzed));

    return out;
  }

  /**
   * A2A: one A2A agent server per node plus an orchestrator -- LangGraph's A2A design, copied (CompiledA2AEmit).
   * The package also carries the agents-in-separate-files runtime (common.py, agents/), which each server
   * imports to run its node. Same scope as LangGraph's A2A: code nodes and Start options are refused.
   */
  async generateA2A(workflowId: number, userId: string | null = null): Promise<any> {
    const analyzed = await this.analyzeWorkflow(workflowId, userId);
    CompiledA2AEmit.refuse(analyzed);
    const docs = LangGraphPackage.startDocuments(analyzed['startDocuments'] ?? [], this.startDocuments);
    analyzed['startDocuments'] = docs['docs'];
    return ADKGenerator.a2aPackage(analyzed, docs['files'], this.skillsRoot ?? LangGraphPackage.defaultSkillsRoot());
  }

  /** The A2A package of an analysis (no database): servers/, orchestrator.py, api.py, the runtime, the package files. */
  static async a2aPackage(analyzedIn: any, documentFiles: any = [], skillsRoot: string | null = null): Promise<any> {
    CompiledA2AEmit.refuse(analyzedIn);
    const analyzed: any = oarr(entries(analyzedIn));   // PHP passes the array by value
    analyzed['package'] = true;
    const runNodes = oarr(keysOf(CompiledA2AEmit.layout(analyzed)).map((k) => [k, ADKGenerator.A2A_RUN_NODE] as [string, string]));
    const files = await ADKPackage.files(analyzed, skillsRoot ?? LangGraphPackage.defaultSkillsRoot(), documentFiles, 'a2a');
    return CompiledArchitectureDoc.attach(CompiledA2AEmit.package(analyzed, ADKGenerator.packageFiles(analyzed), runNodes, files,
      preg_replace('/[^a-z0-9_]+/i', '_', strtolower(strval(analyzed['workflow']['name']))) + '_adk_a2a', 'Google ADK'), analyzed, 'adk', 'a2a');
  }

  /** An A2A server's run_node: runs this server's node (NODE["id"]) with the runtime in common.py and workflow.py. */
  static readonly A2A_RUN_NODE: string = String.raw`async def _adk_state(agent, text: str) -> dict:
    """Run one ADK agent on ${'`'}text${'`'} in a session of its own; returns the session state after the run (the
    node's answer is state["node_<id>"])."""
    svc = InMemorySessionService()
    runner = Runner(agent=agent, app_name="node", session_service=svc)
    sess = await svc.create_session(app_name="node", user_id="a2a", state={"user_prompt": text})
    async for _ev in runner.run_async(user_id="a2a", session_id=sess.id,
                                      new_message=types.Content(role="user", parts=[types.Part(text=text)])):
        pass
    return dict((await svc.get_session(app_name="node", user_id="a2a", session_id=sess.id)).state)


async def run_node(request_text: str, trace) -> dict:
    """Run this server's node on ADK: its agent (with its skill steps) on the request, a dispatcher's choice
    (its decision model, else its chooser agent), a playbook's interpreter."""
    nid = NODE["id"]
    if NODE["kind"] == "playbook":
        return {"text": await run_playbook_node(PLAYBOOKS[nid], request_text), "route": "", "notes": "", "status": "ok"}
    if NODE["kind"] == "dispatcher":
        disp = getattr(W, f"node_{nid}__dispatch")   # the _DispatcherAgent: its routing settings and adapters
        key = disp._mode()
        if key != "llm":
            chosen, text, _nc = await _a2a_decide(key, disp._router(key), request_text, NODE["menu"],
                                                  disp.decision_question, disp.min_confidence, disp.unclear_branch,
                                                  NODE["display"])
        else:
            reply = str((await _adk_state(disp.sub_agents[0], request_text)).get(f"node_{nid}", ""))
            chosen, notes = _a2a_pick(reply, NODE["menu"])
            text = (request_text + (f"\n\n## Dispatcher notes\n{notes}" if notes else "")) if chosen \
                else _a2a_unrouted(NODE["display"], NODE["menu"])
        return {"text": text, "route": chosen or "", "notes": "", "status": "ok" if chosen else "unrouted"}
    state = await _adk_state(getattr(W, f"node_{nid}"), request_text)
    return {"text": str(state.get(f"node_{nid}", "")), "route": "", "notes": "", "status": "ok"}`;

  /**
   * The compiled package: a folder that runs on its own, like LangGraph's modular package --
   * workflow.py (the script, reading its code nodes from code/ and its skills from skills/),
   * the run server (api.py, common.py), and ADKPackage's files.
   */
  async generatePackage(workflowId: number, userId: string | null = null): Promise<any> {
    const wf = await this.workflowRepo.findById(workflowId);
    const name = wf ? strval(ADKGenerator.workflowField(wf, 'getName', 'name')) : 'workflow';
    const analyzed = await this.analyzeWorkflow(workflowId, userId);
    analyzed['package'] = true;
    const docs = LangGraphPackage.startDocuments(analyzed['startDocuments'] ?? [], this.startDocuments);
    analyzed['startDocuments'] = docs['docs'];

    const [workflowPy, commonPy, agentFiles] = ADKGenerator.packageFiles(analyzed);
    const pkg: any = RunServerEmitter.package(
      { code: workflowPy },
      name,
      'adk',
      'ADK run server (Python) -- serves the run protocol the SynergyAI frontend speaks',
      commonPy,
      true,   // api.py also runs the Start's cron / watch loop: POST /listen, GET /live
    );
    pkg['files'] = [...pkg['files'], ...agentFiles,
      ...await ADKPackage.files(analyzed, this.skillsRoot ?? LangGraphPackage.defaultSkillsRoot(), docs['files'])];
    return CompiledArchitectureDoc.attach(pkg, analyzed, 'adk', 'modular');
  }

  /**
   * Agents in separate files: [workflow.py, common.py, agents/ files]. common.py is the runtime (model
   * factory, MCP client, tools, skills, the agent classes, run events) plus the run server's shared pieces;
   * agents/<name>.py defines one node's agent (node_<id>) from it; workflow.py imports the nodes and
   * assembles them (dispatchers, gates, root_agent), with run_workflow, the listener and the CLI.
   */
  static packageFiles(analyzed: any): [string, string, Array<{ path: string; code: string }>] {
    const layout = CompiledRuntimeEmit.moduleLayout(analyzed);
    const common: string[] = [];
    const nodes: any = oarr();
    const assembly: string[] = [];
    for (const [section, text] of ADKGenerator.parts(analyzed)) {
      if (section === 'common') {
        common.push(text);
      } else if (section.startsWith('node:')) {
        nodes[section.slice(5)] = rtrim(text, '\n');
      } else if (section === 'workflow') {
        assembly.push(text);
      }
    }
    const wfName = json_encode(strval(analyzed['workflow']['name']), JSON_UNESCAPED_UNICODE);
    const q = '"""';
    const files: Array<{ path: string; code: string }> = [{ path: 'agents/__init__.py', code: `${q}The workflow's nodes, one module each (imported by workflow.py).${q}\n` }];
    const imports: string[] = [];
    for (const [nid, text] of entries<string>(nodes)) {
      const m = has(layout, nid) ? layout[nid] : { file: `agents/node_${nid}.py`, module: `agents.node_${nid}`, display: nid };
      const display = str_replace([q, '\n'], ["'''", ' '], strval(m['display']));
      files.push({ path: m['file'], code: `${q}Node ${nid} (${display}) of the workflow ${wfName}: its ADK agent, node_${nid}.\n\n`
        + `Imported by workflow.py. To change the node, edit the workflow in the editor and re-generate.${q}\n`
        + 'from common import *  # noqa: F401,F403 -- the runtime: model factory, tools, agent classes\n\n\n'
        + text + '\n' });
      imports.push(`from ${m['module']} import node_${nid}  # ${display}`);
    }
    const workflow = `${q}Workflow ${wfName} -- Google ADK, agents in separate files.\n\n`
      + 'common.py holds the runtime, agents/ one module per node; this file assembles the nodes (dispatchers,\n'
      + `gates, root_agent) and runs them: run_workflow(), the Start's listener and the CLI.\n${q}\n`
      + 'from common import *  # noqa: F401,F403 -- the runtime\n'
      + imports.join('\n') + '\n\n\n'
      + assembly.join('\n') + '\n';
    return [workflow, CompiledRuntimeEmit.packageCommonWithRuntime(common), files];
  }

  // -------------------------------------------------------------------------
  // Private emit helpers
  // -------------------------------------------------------------------------

  /** Emit the file header: module docstring + all top-level imports. */
  private static headerBlock(analyzed: any): string {
    const esc = (s: string): string => str_replace(['"""', '\\'], ["'''", '\\\\'], s);
    const name = esc(strval(analyzed['workflow']['name']));
    const docBody = esc(PythonEmitHelpers.workflowDocBlock({
      target: 'Google ADK (Python) -- LlmAgent per node, Sequential/Parallel layers',
      dispatch_supported: true,
      generated_at: analyzed['generated_at'] ?? null,   // tests pin it; otherwise now
      workflow: analyzed['workflow'],
      nodes: ADKGenerator.docNodes(analyzed),
      edges: values(toArr(analyzed['edges'] ?? [])).map((e: any) => [e['from'], e['to']]),
      layers: analyzed['layers'] ?? [],
      data_flow: ADKGenerator.dataFlowDoc(),
      run: {
        deps: !empty(analyzed['package']) ? [CompiledPackage.PIP_REQUIREMENTS]
          : ['# google-adk 2.3.x: SequentialAgent/ParallelAgent still supported',
            CompiledPackage.pipInstall(analyzed, ADKPackage.TARGET)],
        usage: 'python ' + (!empty(analyzed['package']) ? 'workflow.py' : ADKGenerator.filename(analyzed)) + ' "your prompt here"',
      },
      storage: { enabled: !empty(analyzed['outputStorageEnabled']), folder: analyzed['outputFolder'] ?? null },
    }));
    return String.raw`"""Standalone Google ADK workflow: ${name}

${docBody}
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
    session-state templating, where every {name} is a placeholder and an
    unknown key raises KeyError -- so a prompt that says "Today is {date}"
    would crash the run. The parents' outputs are appended here from
    session.state (keys "node_<id>", written by each parent's output_key),
    which is what the {node_<id>} string placeholders used to do.
    """
    def _instr(ctx):
        text = ("Current date: " + _TODAY + ". Treat this as 'now'; "
                "prefer your tools for current data over memory.\n\n" + prompt)
        for key in parent_keys:
            text += "\n\n## Input from " + key + "\n" + str(ctx.state.get(key, ""))
        return text
    return _instr`;
  }

  /** A code node's inputs as [state_key, name, is_start]; a dispatcher parent stands for its own parents (it receives the email, not the dispatcher's notes). */
  static codeParents(analyzed: any, id: string, seen: Record<string, boolean> = {}): Array<[string, string, boolean]> {
    const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
    let out: Array<[string, string, boolean]> = [];
    for (const p0 of values(dig(analyzed, 'parents', id) ?? [])) {
      const p = strval(p0);
      const node = dig(analyzed, 'byId', p) ?? [];
      const type = GraphAnalyzer.typeOf(node);
      if (type === 'start') {
        out.push(['user_prompt', 'Start', true]);
      } else if (has(menus, p)) {
        if (!Object.hasOwn(seen, p)) {
          out = [...out, ...ADKGenerator.codeParents(analyzed, p, { ...seen, [p]: true })];
        }
      } else {
        out.push(['node_' + p, CompiledRuntimeEmit.displayName(analyzed, p), false]);
      }
    }
    return out;
  }

  private static codeAgentBlock(): string {
    return String.raw`class _CodeAgent(BaseAgent):
    """A code node: the node's own Python run(input, call_tool) -- deterministic, no model.

    The contract (input, exits, declared servers, error exit, timeout) is CODE_HARNESS's, the
    file the workflow editor runs, so the compiled node behaves like the debugged one. Its
    output lands in state["node_<id>"], the exit it took in state["route_<id>"].
    """
    node_id: str = ""
    display: str = ""
    source: str = ""        # the code, in the single file
    source_file: str = ""   # or its file in the package (relative to PACKAGE_DIR), read at each run
    exits: list = []
    mcp_servers: list = []
    timeout_s: int = 30
    args: dict = {}         # the code's ARGS: the node's settings (or the Start option's Start args)
    parents: list = []      # [[state_key, name, is_start], ...]; a key not in state = a branch not taken

    async def _run_async_impl(self, ctx):
        st = ctx.session.state
        parents = [{"name": name, "text": str(st.get(key, "")), "start": bool(is_start)}
                   for key, name, is_start in self.parents if key in st]
        value = CODE_HARNESS.decode_input(parents, str(st.get("user_prompt", "")))
        print(f"[node {self.node_id}] {self.display!r} code -- exits={self.exits}, mcp_servers={self.mcp_servers}", flush=True)
        source = self.source
        if self.source_file:   # read at each run, so an edit of code/<file> takes effect on the next one
            with open(os.path.join(PACKAGE_DIR, self.source_file), encoding="utf-8") as fh:
                source = fh.read()
        res = await asyncio.to_thread(CODE_HARNESS.execute, source, value, self.exits, self.mcp_servers,
                                      _code_transport, self.timeout_s, node_name=self.display, args=self.args)
        for call in res["tool_calls"]:
            print(f"[tool] {call['server']}.{call['tool']} ok={call['ok']} ({call['ms']} ms)", flush=True)
        if res["stdout"]:
            print(f"[node {self.node_id}] stdout: {res['stdout'][:2000]}", flush=True)
        if not res["ok"]:
            raise RuntimeError(f"code node {self.display!r} failed: {res['error']}")
        print(f"[node {self.node_id}] exit {res['route']!r}", flush=True)
        text = res["output_text"]
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={"node_" + self.node_id: text, "route_" + self.node_id: res["route"]}),
            turn_complete=True,
        )`;
  }

  /** One entry per node id (the package puts each in its own file); codeInstancesBlock() joins them. */
  static codeInstancesEntries(analyzed: any): Record<string, string> {
    const out: any = oarr();
    for (const [id0, cd] of entries(toArr(analyzed['code'] ?? []))) {
      const id = strval(id0);
      const parents = ADKGenerator.codeParents(analyzed, id).map((p) => '[' + PythonEmitHelpers.pyStr(p[0]) + ', ' + PythonEmitHelpers.pyStr(p[1]) + ', '
        + (p[2] ? 'True' : 'False') + ']');
      out[id] = `# Code node ${id} -- ` + str_replace(['\n', '"'], [' ', "'"], strval(cd['display'])) + '\n'
        + `node_${id} = _CodeAgent(\n`
        + `    name="node_${id}",\n`
        + `    node_id="${id}",\n`
        + '    display=' + PythonEmitHelpers.pyStr(strval(cd['display'])) + ',\n'
        + (!empty(analyzed['package'])
          ? '    source_file=' + PythonEmitHelpers.pyStr(ADKPackage.codePath(analyzed, id)) + ',\n'
          : '    source=' + PythonEmitHelpers.pyStr(strval(cd['source'])) + ',\n')
        + '    exits=' + PythonEmitHelpers.jsonToPython(cd['exits']) + ',\n'
        + '    mcp_servers=' + PythonEmitHelpers.jsonToPython(cd['mcp_servers']) + ',\n'
        + `    timeout_s=${strval(cd['timeout_s'])},\n`
        + '    args=' + PythonEmitHelpers.jsonToPython(toObject(cd['args'] ?? [])) + ',\n'
        + '    parents=[' + parents.join(', ') + '],\n'
        + ')';
    }
    return out;
  }

  private static codeInstancesBlock(analyzed: any): string {
    return implode('\n\n', ADKGenerator.codeInstancesEntries(analyzed));
  }

  /**
   * The nodes downstream of a choice: a child of a code node with several exits, of a dispatcher's
   * nested menu child, or of a node already downstream of one. Only these get a _Gate.
   */
  private static conditionalNodes(analyzed: any): Record<string, boolean> {
    const nested: Record<string, boolean> = {};
    for (const targets of values(GraphAnalyzer.dispatchMenus(analyzed)['menus'])) {
      for (const t of values(targets)) {
        if (CompiledRuntimeEmit.menuNestable(analyzed, strval(t['id']))) {
          nested[strval(t['id'])] = true;
        }
      }
    }
    const cond: any = oarr();
    for (const n0 of values(analyzed['order'] ?? [])) {
      const n = strval(n0);
      for (const p0 of values(dig(analyzed, 'parents', n) ?? [])) {
        const p = strval(p0);
        if (count(dig(analyzed, 'code', p, 'exits') ?? []) > 1 || Object.hasOwn(nested, p) || has(cond, p)) {
          cond[n] = true;
          break;
        }
      }
    }
    return cond;
  }

  /**
   * A conditional node's _Gate rules [parent_key, route_key, exit] (any one holding runs it), or null:
   * Start -> ["user_prompt", "", ""]; a code node with several exits -> one rule per exit leading here;
   * any other parent -> it ran.
   */
  static gateRules(analyzed: any, id: string): string[][] | null {
    if (!has(ADKGenerator.conditionalNodes(analyzed), id)) {
      return null;
    }
    const rules: string[][] = [];
    for (const p0 of values(dig(analyzed, 'parents', id) ?? [])) {
      const p = strval(p0);
      if (GraphAnalyzer.typeOf(dig(analyzed, 'byId', p) ?? []) === 'start') {
        rules.push(['user_prompt', '', '']);
      } else if (count(dig(analyzed, 'code', p, 'exits') ?? []) > 1) {
        for (const [exit, children] of entries(analyzed['code'][p]['exit_targets'])) {
          if (in_array(id, values(children).map(strval), true)) {
            rules.push([`node_${p}`, `route_${p}`, strval(exit)]);
          }
        }
      } else {
        rules.push([`node_${p}`, '', '']);
      }
    }
    return rules;
  }

  /** True when some top-level node of the workflow needs a _Gate. */
  private static needsGates(analyzed: any): boolean {
    return count(ADKGenerator.conditionalNodes(analyzed)) > 0;
  }

  private static gateAgentBlock(): string {
    return String.raw`class _Gate(BaseAgent):
    """Runs its node only when the workflow reached it: a parent ran (its state key exists) and,
    for a code node with several exits, the exit it took leads here. A node after a choice that
    was not taken is skipped, and so is everything that only follows it."""
    when: list = []          # [[parent_state_key, route_state_key or "", exit or ""], ...]

    async def _run_async_impl(self, ctx):
        st = ctx.session.state
        if not any(k in st and (not rk or st.get(rk) == ex) for k, rk, ex in self.when):
            print(f"[node] {self.sub_agents[0].name} skipped (its branch was not taken)", flush=True)
            return
        async for ev in self.sub_agents[0].run_async(ctx):
            yield ev`;
  }

  /**
   * Emit the provider→model factory function.
   *
   * Gemini/google/empty providers return a bare model string (ADK native).
   * All other providers are mapped via LiteLlm with a known prefix table;
   * unknown providers default to "<provider>/" as a passthrough prefix.
   * If the model string already contains "/" it is used as-is (no prefix).
   */
  private static modelFactoryBlock(): string {
    return String.raw`def _make_model(provider: str, model: str, thinking: str | None = None):
    """Resolve a (provider, model) pair to an ADK model.

    Gemini -> native model string; everything else -> LiteLlm. Grok/DeepSeek/Kimi
    are OpenAI-compatible endpoints (mirrors the PHP providers / LangGraph runner),
    so they route through litellm's openai/ handler with a custom api_base. API keys
    come from the environment (.env). The (provider, model) pair is resolved by the
    generator — a blank model already fell back to the provider default upstream.
    """
    p = (provider or "claude").lower()
    if not model:
        raise RuntimeError(
            f"No model for provider {p!r}. Set a model on the agent in the editor, "
            "or a default in system_llm_settings."
        )
    match p:
        case "gemini" | "google" | "google-genai":
            return model
        case "claude" | "anthropic":
            return LiteLlm(model=model if "/" in model else "anthropic/" + model)
        case "openai":
            return LiteLlm(model=model if "/" in model else "openai/" + model)
        case "grok" | "xai":
            return LiteLlm(
                model="openai/" + model,
                api_base=os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1",
                api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
            )
        case "deepseek":
            kwargs = dict(
                model="openai/" + model,
                api_base=os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",
                api_key=os.environ.get("DEEPSEEK_API_KEY"),
            )
            if model.startswith(("deepseek-v4", "deepseek-flash")):
                # The node form's Thinking attribute governs (platform parity):
                # 'off' -> disabled (form temperature accepted); 'on'/default ->
                # V4's server default stays ON (sampling params are dropped at the
                # config level by the generator in that case).
                _mode = "disabled" if thinking == "off" else "enabled"
                kwargs["extra_body"] = {"thinking": {"type": _mode}}
            return LiteLlm(**kwargs)
        case "kimi":
            kwargs = dict(
                model="openai/" + model,
                api_base=os.environ.get("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",
                api_key=os.environ.get("KIMI_API_KEY"),
            )
            if model.startswith("kimi-k2"):
                # Thinking attribute governs; K2's sampling constraints per mode
                # are enforced at the config level by the generator.
                _mode = "enabled" if thinking == "on" else "disabled"
                kwargs["extra_body"] = {"thinking": {"type": _mode}}
            return LiteLlm(**kwargs)
        case "glm":
            # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible. Default: thinking off so it
            # answers directly; the node form's Thinking attribute can enable it.
            return LiteLlm(
                model="openai/" + model,
                api_base=os.environ.get("GLM_BASE_URL") or "https://api.z.ai/api/paas/v4",
                api_key=os.environ.get("GLM_API_KEY"),
                extra_body={"thinking": {"type": "enabled" if thinking == "on" else "disabled"}},
            )
        case _:
            # Fallback: best-effort litellm prefixed spec.
            return LiteLlm(model=model if "/" in model else p + "/" + model)`;
  }

  /** Test seam: exposes skillRunnerBlock() output for unit testing. */
  static skillRunnerBlockForTest(): string {
    return ADKGenerator.skillRunnerBlock();
  }

  /**
   * Emit a LangGraph-style section banner: a boxed comment block naming the
   * section and explaining what it is for / how to modify it. Requested
   * documentation standard for all compile targets.
   */
  private static banner(title: string, ...lines: string[]): string {
    const bar = '# ' + str_repeat('=', 62);
    const out = [bar, '# ' + title];
    for (const l of lines) {
      out.push('# ' + l);
    }
    out.push(bar);
    return out.join('\n');
  }

  /**
   * Emit the ADK-specific async skill runner.
   *
   * Called only when any agent uses skills (see emitAdk()).
   * Depends on PythonEmitHelpers.skillDepsBlock() being emitted first
   * (provides SKILLS_DIR + _ensure_skill_deps).
   *
   * Uses asyncio.create_subprocess_exec so skill calls inside a
   * ParallelAgent layer don't block the event loop (contrast: the
   * LangGraphGenerator path uses blocking subprocess.run).
   */
  private static skillRunnerBlock(): string {
    let py = String.raw`# Skills use the same virtual dirs the browser interpreter provides: "/outputs"
# (persisted, mounted to the host outputs folder, bucketed per skill group) and
# "/scratch" (staging for input files). Standalone Python has neither, so we (a) create
# REAL outputs/scratch dirs, (b) remap "/outputs/..." and "/scratch/..." paths in argv
# onto them, (c) stage input_files at those real paths before the run, and (d) export
# SYNERGYAI_OUTPUT_DIR/SCRATCH_DIR/SKILL_DIR_NAME/SKILL_GROUP for scripts that read the
# env. Without this a skill that hardcodes e.g. "-i /scratch/x -o /outputs/y" (like the
# html skill's create.py) fails against the read-only filesystem root.
SKILL_OUTPUTS_ROOT = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(SKILLS_DIR), "outputs")
SKILL_SCRATCH_DIR = os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(os.path.dirname(SKILLS_DIR), "scratch")

# Deliverable files a skill produced this step (via run_skill_script read_outputs),
# keyed by skill dir_name. The skill's capture step reads this so the NODE OUTPUT is
# the produced document (e.g. the html skill's rendered HTML), not the model's chatter.
_LAST_SKILL_OUTPUTS = {}


def _skill_output_dir(dir_name: str) -> str:
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    if group and all(c.isalnum() or c in "._-" for c in group):
        return os.path.join(SKILL_OUTPUTS_ROOT, group)
    return SKILL_OUTPUTS_ROOT


def _remap_virtual_path(p, out_dir: str) -> str:
    """Map the interpreter's virtual "/outputs" and "/scratch" onto real host dirs so a
    skill's hardcoded absolute paths resolve in standalone Python."""
    p = str(p)
    for virt, real in (("/outputs", out_dir), ("/scratch", SKILL_SCRATCH_DIR)):
        if p == virt:
            return real
        if p.startswith(virt + "/"):
            return os.path.join(real, p[len(virt) + 1:])
    return p


def _fix_overescaped(text):
    """Repair JSON-style over-escaping in model-carried document content
    (literal \\n / \\" sequences, zero real newlines — a known model behavior
    that ships broken HTML/CSS; mirrors the platform chat's recovery).
    Conservative: only fires on many escapes AND no real newlines."""
    s = str(text)
    if s.count("\\n") > 5 and s.count("\n") == 0:
        print("  [skill] repairing over-escaped staged content", flush=True)
        s = (s.replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t")
              .replace("\\r", "").replace('\\"', '"').replace("\\'", "'").replace("\x00", "\\"))
    return s


async def _run_skill_script(dir_name: str, script: str, argv: list[str] | None = None,
                            input_files: dict | None = None,
                            read_outputs: list[str] | None = None) -> str:
    """Run a skill's Python script as a subprocess, mirroring the interpreter's skill
    filesystem: real bucketed /outputs + /scratch, input_files staged first, requested
    outputs read back after."""
    argv = list(argv) if argv else []
    skill_path = os.path.join(SKILLS_DIR, dir_name)
    _ensure_skill_deps(skill_path)  # parse SKILL.md frontmatter, pip install once
    script_path = os.path.join(skill_path, script)
    out_dir = _skill_output_dir(dir_name)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(SKILL_SCRATCH_DIR, exist_ok=True)
    argv = [_remap_virtual_path(a, out_dir) for a in argv]
    if isinstance(input_files, dict):
        for raw_path, content in input_files.items():
            try:
                target = _remap_virtual_path(raw_path, out_dir)
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write(_fix_overescaped(content))
            except Exception as e:
                print(f"[skill] could not stage {raw_path}: {e}", flush=True)
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    env = dict(
        os.environ,
        SYNERGYAI_OUTPUT_DIR=out_dir,
        SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR,
        SYNERGYAI_SKILL_DIR_NAME=dir_name,
        SYNERGYAI_SKILL_GROUP=group,
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable, script_path, *[str(a) for a in argv],
        cwd=skill_path, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    result = out.decode("utf-8", "replace")
    if proc.returncode != 0:
        return (f"[skill error rc={proc.returncode}] "
                + err.decode("utf-8", "replace") + "\n" + result).strip()
    # Surface requested output files back to the model (interpreter parity) AND stash
    # them so the skill's capture step can use the produced document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                result += f"\n\n[output file {rel}]\n" + _content
                _produced.append(_content)
            except Exception:
                pass
    if _produced:
        _LAST_SKILL_OUTPUTS[dir_name] = _produced
    return result

RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)`;
    py += String.raw`

def _read_skill_md(dir_name: str) -> str:
    """Read the live SKILL.md body for a skill dir (progressive disclosure:
    the skill's own instructions). Strips YAML frontmatter if present."""
    path = os.path.join(SKILLS_DIR, *str(dir_name).split("/"), "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return f"(SKILL.md not found for skill '{dir_name}' at {path})"
    if text.startswith("---"):
        end = text.find("\n---\n", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            text = text[nl + 1:] if nl != -1 else ""
    return text.strip()


def _skill_instruction(dir_name: str, input_key: str, inline_md: str = ""):
    """Return an ADK InstructionProvider (callable) for a skill step. Using a
    callable makes ADK use the text verbatim (bypass_state_injection=True), so
    SKILL.md braces are safe, and it can read the prior step's output from state."""
    def _instr(ctx):
        body = inline_md if inline_md else _read_skill_md(dir_name)
        prior = ctx.state.get(input_key, "")
        return (
            "Current date: " + _TODAY + ".\n"
            "You are running the '" + dir_name + "' skill as a MANDATORY step in a compiled "
            "workflow. Follow the skill instructions below and APPLY THE SKILL to the INPUT. "
            "If the skill produces a document/file (e.g. an HTML report via a create/render "
            "script), you MUST call run_skill_script to generate it -- stage your authored "
            "content via input_files and pass the output path in read_outputs; the workflow "
            "captures that produced file as this node's output. If the skill has no script, "
            "return the transformed result as your response.\n\n"
            "=== SKILL INSTRUCTIONS ===\n" + body +
            "\n\n=== INPUT (apply the skill to this) ===\n" + str(prior)
        )
    return _instr


def _make_skill_tool(dir_name: str) -> FunctionTool:
    """run_skill_script scoped to one skill dir: the model chooses the script within the
    skill, its argv, and optionally input_files (staged before the run, e.g. the HTML a
    skill will render) and read_outputs (surfaced after); the dir is fixed to this skill."""
    async def run_skill_script(script: str, argv: list[str] | None = None,
                               input_files: dict | None = None,
                               read_outputs: list[str] | None = None) -> str:
        return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)
    return FunctionTool(run_skill_script)


class _SkillCaptureAgent(BaseAgent):
    """Resolves a skill step's output: the NODE OUTPUT becomes the document the skill just
    produced (captured via run_skill_script read_outputs -- e.g. the html skill's rendered
    HTML) when it wrote one; otherwise the skill LLM's text. This is what makes a
    file-producing skill (html/docx/pptx/xlsx) yield the actual deliverable as the node
    result instead of the model's chatter. Follows the skill LLM in the SequentialAgent."""
    skill_dir: str = ""
    llm_key: str = ""
    out_key: str = ""

    async def _run_async_impl(self, ctx):
        produced = _LAST_SKILL_OUTPUTS.pop(self.skill_dir, None)
        final = produced[-1] if produced else str(ctx.session.state.get(self.llm_key, ""))
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=final)]),
            actions=EventActions(state_delta={self.out_key: final}),
            turn_complete=True,
        )`;
    return py;
  }

  /** Uniform node descriptors (shared documentation; see GraphAnalyzer.docNodes). */
  private static docNodes(analyzed: any): any[] {
    return PlaybookEmit.docNodes(analyzed);
  }

  /** DATA FLOW section of the module docstring (ADK-specific mechanics). */
  private static dataFlowDoc(): string {
    return String.raw`HOW THIS FILE IS ORGANISED (top to bottom):
  1. _make_model(provider, model)  -- maps a node's provider+model to an ADK model
                                      (Gemini = native string; every other provider goes
                                      through LiteLLM, Grok/Kimi/DeepSeek routed to their
                                      OpenAI-compatible API).
  2. MCP_SERVERS / TOOL_CATALOG    -- the MCP tools this workflow uses, baked in.
  3. _call_mcp_tool + build_tools_from_catalog()
                                   -- an HTTP JSON-RPC MCP client; each tool is wrapped
                                      as an ADK FunctionTool the model can call.
  4. Skill runner (only when the workflow uses skills)
                                   -- runs a skill folder Python script as a subprocess.
  5. node_<id> = LlmAgent(...)     -- ONE agent per workflow node. Each agent writes its
                                      answer to session.state["node_<id>"]; a downstream
                                      agent reads a parent's output through the literal
                                      {node_<id>} placeholder in its instruction (ADK
                                      "state templating" -- the runtime substitutes it).
  6. root_agent = SequentialAgent  -- the graph as TOPOLOGICAL LAYERS: independent nodes
                                      at the same depth run together in a ParallelAgent;
                                      the layers themselves run in order.
  7. run_workflow()                -- seeds the prompt (plus attached documents), runs the
                                      graph via Runner, streams a [node]/[tool] trace,
                                      saves the result, and prints a RUN SUMMARY.

NODE-INTERNAL PIPELINE (fixed order):
    merged fan-in (parents' outputs via {node_<id>} state placeholders)
      ==> AGENT: the node's LlmAgent -- system prompt, MCP tools and sampling
          verbatim from the editor form (provider CONSTRAINT clamps only, each
          documented as an emitted comment). Instructions are grounded in
          today's date at import time.
      ==> SKILL step(s), each a SequentialAgent pair: an LLM turn whose system
          prompt is the skill's SKILL.md, then a capture agent that makes the
          node output the file the skill's script PRODUCED (else the LLM text).
    The Output node is a non-LLM pass-through: parents' text verbatim.
A DISPATCHER node routes: it names one child from its menu and only that
child runs (its menu is nested under the dispatcher, not in a layer).
A PLAYBOOK node is an interpreter, not an agent: the model re-decides each
round from the running transcript of tool calls, and that transcript IS the
node output, published to session.state like any other node's result.`;
  }

  /**
   * Emit one `LlmAgent` per agent node in analyzed['agents'] -- one entry per node id (the package puts each
   * in its own file); agentsBlock() joins them.
   *
   * Instruction assembly: the systemPrompt (skills are separate SequentialAgent steps, not prompt text),
   * plus the dispatcher's routing instructions; parent outputs are appended at call time by the emitted
   * _agent_instruction provider. Tools: catalog["<name>"] per tool; the main agent NEVER receives
   * RUN_SKILL_SCRIPT_TOOL. A node with skills becomes node_<id>_agent + one LLM turn and one capture agent
   * per skill, wrapped in `node_<id> = SequentialAgent(...)`. generate_content_config is emitted only when
   * temperature or max_tokens is set.
   */
  static agentEntries(analyzed: any): Record<string, string> {
    const out: any = oarr();
    const docById: any = oarr();
    for (const dn of ADKGenerator.docNodes(analyzed)) {
      docById[strval(dn['id'])] = dn;
    }
    const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
    for (const [id, ag0] of entries(analyzed['agents'])) {
      const ag: any = oarr(entries(ag0));   // PHP copies $ag: the clamps below change only this node's view
      let instr = strval(ag['systemPrompt']);
      // NOTE: ## Skill / skill_content is NOT appended — skills are now
      // separate SequentialAgent steps, not prompt text.

      // DISPATCHER node: the prompt has to produce a ROUTE, not an answer.
      // Appended here rather than baked into the form so the node keeps
      // reading as itself in the editor, and so a node that stops being a
      // dispatcher stops asking for a name on the next generate.
      if (has(menus, id)) {
        const names = values(menus[id]).map((t: any) => strval(t['name']));
        instr += '\n\n## Dispatching\n\n'
          + 'You are a DISPATCHER. Hand this request to EXACTLY ONE of these agents:\n\n'
          + '  - ' + names.join('\n  - ') + '\n\n'
          + "Reply with the chosen agent's name ALONE on the first line, copied exactly "
          + 'from the list above. Any notes for that agent go on the following lines. '
          + 'Do not answer the request yourself.';
      }

      // Parent outputs are read from session state by the instruction
      // PROVIDER emitted below (_agent_instruction), not through ADK's
      // {node_<id>} string templating: ADK templates EVERY {name} in a
      // string instruction and raises KeyError on an unknown key — a
      // prompt saying "Today is {date}" killed the My Newspaper journal
      // workflow, and this ADK version has no literal-brace escape. A
      // callable instruction bypasses injection (bypass_state_injection),
      // the same route the skill steps already use.
      const agentParents = values(dig(analyzed, 'parents', id) ?? []).filter(
        (p: any) => isset(analyzed, 'agents', strval(p)) || isset(analyzed, 'code', strval(p)),
      );
      const parentKeysPy = '[' + agentParents.map((p: any) => '"node_' + strval(p) + '"').join(', ') + ']';

      const skills = ag['skills'] ?? [];
      const hasSkills = count(skills) > 0;

      // Empty model = "platform default": resolve at generation time
      // (aliases share their canonical provider's default). Mirrors MAF.
      const defaults = toArr(analyzed['providerDefaultModels'] ?? []);
      const provKey = strtolower(strval(ag['provider'] ?? 'claude'));
      const canon = ({ anthropic: 'claude', google: 'gemini' } as Record<string, string>)[provKey] ?? provKey;
      let modelStr = strval(ag['model'] ?? '');
      if (modelStr === '') {
        modelStr = strval(dig(defaults, canon) ?? dig(defaults, provKey) ?? '');
      }
      ag['model'] = modelStr;

      // Provider CONSTRAINT clamps (not preference overrides — these values
      // are hard API rules; the emitted comment documents each adjustment).
      // The node form's Thinking attribute ('on'|'off'|default) governs
      // reasoning mode; sampling constraints follow the chosen mode:
      //  * kimi-k2: thinking off -> temperature MUST be 0.6; on -> 1.0.
      //  * deepseek-v4: thinking on/default -> sampling params rejected
      //    by the API, temperature dropped; off -> temperature kept.
      //  * anthropic non-streaming SDK: 16384 budget ceiling.
      const thinking = ag['thinking'] ?? null;
      const clampNotes: string[] = [];
      const temperature = (): any => ag['temperature'] ?? null;
      const maxTokens = (): any => ag['max_tokens'] ?? null;
      if (provKey === 'kimi' && modelStr.startsWith('kimi-k2')) {
        const want = thinking === 'on' ? 1.0 : 0.6;
        if (temperature() !== null && floatval(temperature()) !== want) {
          clampNotes.push(`temperature ${strval(temperature())} -> ${strval(new PhpFloat(want))} (kimi-k2 `
            + (thinking === 'on' ? 'thinking' : 'non-thinking') + ' constraint)');
          ag['temperature'] = new PhpFloat(want);
        }
      }
      if (provKey === 'deepseek' && (modelStr.startsWith('deepseek-v4') || modelStr.startsWith('deepseek-flash'))
        && thinking !== 'off' && temperature() !== null) {
        clampNotes.push(`temperature ${strval(temperature())} dropped (deepseek-v4 thinking mode `
          + "rejects sampling params; set the node's Thinking attribute to Off to keep it)");
        ag['temperature'] = null;
      }
      if (in_array(provKey, ['claude', 'anthropic'], true)
        && maxTokens() !== null && intval(maxTokens()) > 16384) {
        clampNotes.push(`max_tokens ${strval(maxTokens())} -> 16384 (anthropic non-streaming SDK limit)`);
        ag['max_tokens'] = 16384;
      }

      // The main agent NEVER carries the skill tool. (Drop the old
      // run_skill_script auto-add entirely — skills are separate steps now.)
      const toolExprs: string[] = [];
      for (const t0 of values(ag['tools'])) {
        // Node forms store the runtime 'mcp_' prefix; the catalog is keyed
        // on the UNPREFIXED DB tool_name (the analyzer's normalization).
        // Without stripping, catalog["mcp_…"] raises KeyError at import.
        let t = strval(t0);
        if (t.startsWith('mcp_')) t = substr(t, 4);
        toolExprs.push('catalog["' + t + '"]');
      }
      const toolsPy = '[' + toolExprs.join(', ') + ']';

      const thinkPy = in_array(thinking, ['on', 'off'], true) ? '"' + strval(thinking) + '"' : 'None';
      const model = '_make_model("' + strval(ag['provider']) + '", "' + strval(ag['model']) + '", thinking=' + thinkPy + ')';
      const agentVar = hasSkills ? `node_${id}_agent` : `node_${id}`;
      const agentOutKey = hasSkills ? `node_${id}_agent` : `node_${id}`;

      const sampling = (): string | null => {
        if (temperature() === null && maxTokens() === null) return null;
        const kwargs: string[] = [];
        if (temperature() !== null) {
          kwargs.push('temperature=' + json_encode(temperature()));
        }
        if (maxTokens() !== null) {
          kwargs.push('max_output_tokens=' + json_encode(maxTokens()));
        }
        return '    generate_content_config=types.GenerateContentConfig(' + kwargs.join(', ') + '),\n';
      };

      let entry = has(docById, id) ? PythonEmitHelpers.nodeCommentBlock(docById[id]) + '\n' : '';
      for (const cn of clampNotes) {
        entry += `# constraint clamp: ${cn}\n`;
      }
      entry += `${agentVar} = LlmAgent(\n`;
      entry += `    name="${agentVar}",\n`;
      entry += `    model=${model},\n`;
      // Ground the model in TODAY (runtime date, evaluated at import) — without
      // it research agents anchor on their training era (see MAF fix).
      // Callable provider: the prompt is used VERBATIM (braces and all) and the
      // parents' outputs are appended from state at call time.
      entry += '    instruction=_agent_instruction(' + PythonEmitHelpers.pyStr(instr) + `, ${parentKeysPy}),\n`;
      entry += `    tools=${toolsPy},\n`;
      // Emit the agent-form values verbatim — never override a form-stated
      // parameter. If a value is invalid for a model (e.g. Kimi K2 requires
      // temperature 0.6), that's surfaced to the user to fix in the form.
      entry += sampling() ?? '';
      // CONTEXT ISOLATION: without this, agents in the shared
      // SequentialAgent session inherit every PRIOR agent's full
      // conversation — including raw MCP tool payloads. Data flows between
      // nodes ONLY through the session state.
      entry += "    include_contents='none',\n";
      entry += `    output_key="${agentOutKey}",\n`;
      entry += ')';

      if (hasSkills) {
        let prev = `node_${id}_agent`;
        const subAgents = [`node_${id}_agent`];
        for (const [k, skill] of entries(skills)) {
          const stepNo = intval(k) + 1;
          const isLast = stepNo === count(skills);
          const llmVar = `node_${id}_skill_${stepNo}_llm`;   // the skill's LLM turn
          const capVar = `node_${id}_skill_${stepNo}`;       // capture = the step's output
          const stepOut = isLast ? `node_${id}` : capVar;    // last capture writes the node key
          let dirLiteral: string;
          let instrExpr: string;
          let toolPy: string;
          if (isset(skill, 'dir')) {
            const dir = addslashes(strval(skill['dir']));
            dirLiteral = `"${dir}"`;
            instrExpr = `_skill_instruction("${dir}", "${prev}")`;
            toolPy = `[_make_skill_tool("${dir}")]`;
          } else {
            dirLiteral = '""';   // inline skill: no dir to look up in the deliverable stash
            const inlineMd = PythonEmitHelpers.pyStr(strval(skill['inline']));
            instrExpr = `_skill_instruction("", "${prev}", inline_md=${inlineMd})`;
            toolPy = '[]';   // legacy inline skill: no script folder
          }
          // (a) the skill's LLM turn: applies the skill to the prior result, runs its script if any.
          entry += `\n\n# Skill step ${stepNo} for node ${id}: LLM applies the skill; capture makes the node output the produced deliverable (else the LLM text).\n`;
          entry += `${llmVar} = LlmAgent(\n`;
          entry += `    name="${llmVar}",\n`;
          entry += `    model=${model},\n`;
          entry += `    instruction=${instrExpr},\n`;
          entry += `    tools=${toolPy},\n`;
          // Documents flow through this step's OUTPUT (authored text and
          // tool-call arguments both count) — inherit the node's budget so
          // provider-default caps don't truncate document-carrying calls.
          entry += sampling() ?? '';
          entry += "    include_contents='none',\n";
          entry += `    output_key="${llmVar}",\n`;
          entry += ')';
          // (b) capture: node output = the produced file (via run_skill_script read_outputs), else the LLM text.
          entry += `\n${capVar} = _SkillCaptureAgent(name="${capVar}", skill_dir=${dirLiteral}, llm_key="${llmVar}", out_key="${stepOut}")`;
          subAgents.push(llmVar);
          subAgents.push(capVar);
          prev = capVar;   // next skill reads the capture's output
        }
        const subList = subAgents.join(', ');
        entry += `\n\n# Node ${id}: agent then mandatory skill pipeline (LLM turn + capture per skill); this is what the layering references.\n`;
        entry += `node_${id} = SequentialAgent(\n    name="node_${id}",\n    sub_agents=[${subList}],\n)`;
      }

      out[strval(id)] = entry;
    }
    return out;
  }

  private static agentsBlock(analyzed: any): string {
    return implode('\n\n', ADKGenerator.agentEntries(analyzed));
  }

  /**
   * The _PassThroughAgent class definition — a non-LLM fan-in used by output
   * nodes. Emitted once, before the output nodes that instantiate it.
   */
  private static passThroughAgentBlock(): string {
    return String.raw`class _PassThroughAgent(BaseAgent):
    """Output (fan-in) node: emit the parent(s) result VERBATIM -- no LLM -- so
    formatting such as HTML is preserved. A single parent is passed through
    unchanged; multiple parents are joined with a separator. (An LlmAgent here
    would re-summarise the parent and lose its original formatting, e.g. turning
    a finished HTML report back into plain markdown.)
    """
    source_keys: list = []
    took: dict = {}   # parent key -> [route key, exits leading here]: a code parent counts only through the exit it took

    async def _run_async_impl(self, ctx):
        st = ctx.session.state
        keys = [k for k in self.source_keys if k not in self.took or st.get(self.took[k][0]) in self.took[k][1]]
        vals = [str(st.get(k, "")) for k in keys]
        vals = [v for v in vals if v]
        text = vals[0] if len(vals) == 1 else "\n\n---\n\n".join(vals)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={self.name: text}),
            turn_complete=True,
        )`;
  }

  /**
   * The _PlaybookAgent class definition — a playbook node inside ADK's graph.
   *
   * The interpreter is not an ADK agent and must not be one: it runs its own
   * tool loop (native verbs, gates, bound #Actions). ADK's job is only to
   * schedule it in the right place and to publish its transcript into
   * session.state under the node's key.
   */
  private static playbookAgentBlock(): string {
    return String.raw`class _PlaybookAgent(BaseAgent):
    """Runs one playbook node and publishes its transcript as the node output."""
    node_id: str = ""
    source_keys: list = []     # parent state keys, in canvas order

    async def _run_async_impl(self, ctx):
        pb = PLAYBOOKS[self.node_id]
        parents = [("parent", str(ctx.session.state.get(k, ""))) for k in self.source_keys]
        request = _pb_request_text(parents, ctx.session.state.get("user_prompt", ""))
        text = await run_playbook_node(pb, request)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={"node_" + self.node_id: text}),
            turn_complete=True,
        )`;
  }

  /** One `node_<id> = _PlaybookAgent(...)` per playbook node, one entry per node id; playbookInstancesBlock() joins them. */
  static playbookInstancesEntries(analyzed: any): Record<string, string> {
    const out: any = oarr();
    for (const [pid0, pd] of entries(toArr(analyzed['playbooks'] ?? []))) {
      const pid = strval(pid0);
      const keys: string[] = [];
      for (const p0 of values(dig(analyzed, 'parents', pid) ?? [])) {
        const p = strval(p0);
        // Only parents that actually write a state key can be read back.
        if (isset(analyzed, 'agents', p) || isset(analyzed, 'playbooks', p) || isset(analyzed, 'code', p)) {
          keys.push('"node_' + p + '"');
        }
      }
      let entry = `# Playbook node ${pid} -- ` + str_replace(['\n', '"'], [' ', "'"], strval(pd['display'])) + '\n';
      entry += `node_${pid} = _PlaybookAgent(\n`;
      entry += `    name="node_${pid}",\n`;
      entry += `    node_id="${pid}",\n`;
      entry += '    source_keys=[' + keys.join(', ') + '],\n';
      entry += ')';
      out[pid] = entry;
    }
    return out;
  }

  private static playbookInstancesBlock(analyzed: any): string {
    return implode('\n\n', ADKGenerator.playbookInstancesEntries(analyzed));
  }

  /**
   * The _DispatcherAgent class definition — a DISPATCHER node's menu.
   *
   * A dispatcher's outgoing edges are a CHOICE, not a fan-out: the node names
   * one child and only that child runs. The menu children are nested as
   * this agent's sub_agents rather than left in their topological layer.
   * sub_agents[0] is the dispatcher's own LlmAgent (the chooser); the rest are
   * the menu, addressed by agent name.
   */
  private static dispatcherAgentBlock(): string {
    return String.raw`class _DispatcherAgent(BaseAgent):
    """DISPATCHER node: run the chooser, then run ONLY the child it named.

    The chooser's instruction (see the node's prompt) asks for the target name
    alone on the first line, with any notes after it. Its raw reply lands in
    state[route_key]; this agent replaces that with what the chosen child should
    actually read -- the incoming task plus those notes -- so the child's
    {node_<dispatcher>} placeholder resolves to a task, never to a bare name.
    """
    route_key: str = ""
    node_id: str = ""        # the dispatcher's node id and canvas name, for its run events
    display: str = ""
    routing_mode: str = ""   # "llm", a decision provider key, or "" (the first provider with a key set, else llm)
    decision: list = []      # the decision providers compiled in: [{provider, protocol, url, model, key_env, url_env}]
    decision_question: str = ""
    min_confidence: float = 0.6
    unclear_branch: str = ""   # the branch (by name) a not-classified request goes to; "" = stop there
    task_keys: list = []     # the dispatcher's own parent state keys, in canvas order
    menu: list = []          # [[child_id, display_name, agent_name], ...] in edge order

    def _router(self, provider: str):
        """The decision adapter for one compiled provider, None when it was not compiled in or has no adapter."""
        c = next((c for c in self.decision if c["provider"] == provider), None)
        cls = DECISION_ADAPTERS.get(c["protocol"]) if c else None
        return cls(key_env=c["key_env"], url_env=c["url_env"], url=c["url"], model=c["model"]) if cls else None

    def _mode(self) -> str:
        """"llm", or the decision provider this run routes with (GraphWorkflowRunner's rule): a key routes with
        that provider only (no model fallback); unset takes the first compiled provider whose key is set."""
        if self.routing_mode:
            return self.routing_mode
        for c in self.decision:
            r = self._router(c["provider"])
            if r is not None and r.available():
                return c["provider"]
        return "llm"

    async def _run_async_impl(self, ctx):
        _rec_node_start(self.node_id, self.display, "agent")
        mode = self._mode()
        if mode != "llm":
            async for ev in self._run_decision(ctx, mode):
                yield ev
            return
        async for ev in self.sub_agents[0].run_async(ctx):
            yield ev
        reply = str(ctx.session.state.get(self.route_key, "") or "")
        lines = [ln.strip() for ln in reply.strip().splitlines()]
        first = lines[0].strip(' "\'*${'`'}#:-').lower() if lines else ""
        chosen = None
        for entry in self.menu:
            if str(entry[1]).strip().lower() == first:
                chosen = entry
                break
        if chosen is None:
            # A name wrapped in a sentence still names a target; take the one that
            # appears earliest rather than failing the run over formatting.
            low = reply.lower()
            hits = [(low.index(str(e[1]).strip().lower()), e)
                    for e in self.menu if str(e[1]).strip().lower() in low]
            if hits:
                chosen = min(hits, key=lambda h: h[0])[1]
        names = [str(e[1]) for e in self.menu]
        if chosen is None:
            msg = (f"Error: dispatcher {self.name!r} did not route the request. "
                   f"Expected one of: {', '.join(names)}.")
            print(f"[node] [{self.name}] \u26a0 {msg}", flush=True)
            _RUN["unrouted"] = msg
            _rec_node_complete(self.node_id, self.display, "agent", success=False, output=msg, error=msg)
            yield Event(
                author=self.name,
                content=types.Content(role="model", parts=[types.Part(text=msg)]),
                actions=EventActions(state_delta={self.route_key: msg}),
                turn_complete=True,
            )
            return
        notes = "\n".join(lines[1:]).strip()
        task = "\n\n".join(str(ctx.session.state.get(k, "")) for k in self.task_keys
                           if str(ctx.session.state.get(k, "")).strip())
        text = (task or reply) + (f"\n\n## Dispatcher notes\n{notes}" if notes else "")
        print(f"[node] [{self.name}] routed to {str(chosen[1])!r}"
              + (f" -- notes: {notes[:120]!r}" if notes else ""), flush=True)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={self.route_key: text}),
        )
        _rec_node_complete(self.node_id, self.display, "agent", output=text,
                           route={"id": str(chosen[0]), "name": str(chosen[1])})
        picked = next(a for a in self.sub_agents[1:] if a.name == str(chosen[2]))
        async for ev in picked.run_async(ctx):
            yield ev

    async def _run_decision(self, ctx, key: str):
        """Decision model ${'`'}key${'`'} only (no LLM turn): routed -> that child; unclear / low confidence -> the
        unclear branch when set, else the run stops here ("Not classified"); anything else stops it (Error)."""
        st = ctx.session.state
        task = "\n\n".join(str(st.get(k, "")) for k in self.task_keys
                           if str(st.get(k, "")).strip()) or str(st.get("user_prompt", ""))
        targets = [{"id": str(e[0]), "name": str(e[1]), "description": ""} for e in self.menu]
        router = self._router(key)
        if router is None:
            res = DecisionResult("unavailable", reason=f"'{key}' is not an available decision provider")
        else:
            try:
                res = await asyncio.wait_for(asyncio.to_thread(router.route, task, targets, self.decision_question,
                                                               self.min_confidence), router.TIMEOUT_S + 1)
            except Exception as e:   # a timeout included: an 'error' outcome (did not route)
                res = DecisionResult("error", reason=f"{type(e).__name__}: no answer within {router.TIMEOUT_S + 1}s"
                                     if isinstance(e, asyncio.TimeoutError) else str(e))
        conf = f"{res.confidence:.2f}" if res.confidence is not None else "?"
        not_classified = res.outcome in ("unclear", "low_confidence")
        chosen = None
        if res.outcome == "routed":
            chosen = next((e for e in self.menu if str(e[0]) == str(res.target["id"])), None)
            print(f"[node] [{self.name}] {key} routed to {res.target['name']!r} (confidence {conf}, {res.ms}ms, no LLM turn)",
                  flush=True)
        elif not_classified and self.unclear_branch:
            chosen = next((e for e in self.menu if str(e[1]) == self.unclear_branch), None)
            if chosen is not None:
                print(f"[node] [{self.name}] {key} did not classify ({res.outcome}: {res.reason}{'' if res.outcome == 'low_confidence' else f', confidence {conf}'})"
                      f" -- sent to the unclear branch {self.unclear_branch!r}", flush=True)
        if chosen is None:
            msg = (f'{"Not classified" if not_classified else "Error"}: dispatcher "{self.display}" did not route the '
                   f"request ({key}: {res.outcome}: {res.reason}).")
            print(f"[node] [{self.name}] \u26a0 {msg}", flush=True)
            _RUN["unrouted"] = msg
            _rec_node_complete(self.node_id, self.display, "agent", success=not_classified, output=msg,
                               **({} if not_classified else {"error": msg}))
            yield Event(
                author=self.name,
                content=types.Content(role="model", parts=[types.Part(text=msg)]),
                actions=EventActions(state_delta={self.route_key: msg}),
                turn_complete=True,
            )
            return
        _rec_node_complete(self.node_id, self.display, "agent", output=task,
                           route={"id": str(chosen[0]), "name": str(chosen[1])})
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=task)]),
            actions=EventActions(state_delta={self.route_key: task}),
        )
        picked = next(a for a in self.sub_agents[1:] if a.name == str(chosen[2]))
        async for ev in picked.run_async(ctx):
            yield ev`;
  }

  /**
   * Each `output` node as a non-LLM _PassThroughAgent that forwards its parent(s) output from session.state
   * verbatim (single parent = pass-through, multiple = joined), one entry per node id;
   * outputConsolidatorsBlock() joins them ('' when the workflow has no output nodes).
   */
  static outputConsolidatorsEntries(analyzed: any): Record<string, string> {
    const out: any = oarr();
    for (const [id0, node] of entries(analyzed['byId'])) {
      const id = strval(id0);
      if (GraphAnalyzer.typeOf(node) !== 'output') {
        continue;
      }
      const parents = dig(analyzed, 'parents', id) ?? [];
      const keys: string[] = [];
      const took: any = oarr();
      for (const p0 of values(parents)) {
        const p = strval(p0);
        keys.push('"node_' + p + '"');
        if (count(dig(analyzed, 'code', p, 'exits') ?? []) > 1) {
          const exits = entries(analyzed['code'][p]['exit_targets'])
            .filter(([, children]) => in_array(id, values(children).map(strval), true))
            .map(([exit]) => strval(exit));
          took[`node_${p}`] = [`route_${p}`, exits];
        }
      }
      const keysPy = '[' + keys.join(', ') + ']';
      const tookPy = count(took) === 0 ? '' : ', took=' + PythonEmitHelpers.jsonToPython(toObject(took));

      let entry = `# Output (fan-in) node ${id} -- forwards its parent(s) result verbatim (no LLM),\n`;
      entry += '# so formatting such as HTML is preserved. Single parent = pass-through.\n';
      entry += `node_${id} = _PassThroughAgent(name="node_${id}", source_keys=${keysPy}${tookPy})`;
      out[id] = entry;
    }
    return out;
  }

  private static outputConsolidatorsBlock(analyzed: any): string {
    return implode('\n\n', ADKGenerator.outputConsolidatorsEntries(analyzed));
  }

  /**
   * One `node_<id>__dispatch = _DispatcherAgent(...)` per dispatcher node: the
   * chooser followed by its menu, all nested as sub_agents. Returns '' when
   * the workflow has no dispatcher.
   */
  private static dispatcherInstancesBlock(analyzed: any): string {
    const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
    if (count(menus) === 0) {
      return '';
    }
    const out: string[] = [];
    for (const [did0, targets] of entries(menus)) {
      const did = strval(did0);
      // Only children this target actually emits can be nested: a playbook
      // on the menu has no agent here, so routing to it runs nothing --
      // the same outcome as the node being skipped anywhere else.
      const menuEntries: string[] = [];
      const subs = [`node_${did}`];
      for (const t of values(targets)) {
        const cid = strval(t['id']);
        if (!CompiledRuntimeEmit.menuNestable(analyzed, cid)) {
          continue;
        }
        menuEntries.push('[' + PythonEmitHelpers.pyStr(cid) + ', '
          + PythonEmitHelpers.pyStr(strval(t['name'])) + ', '
          + PythonEmitHelpers.pyStr(`node_${cid}`) + ']');
        subs.push(`node_${cid}`);
      }
      if (subs.length < 2) {
        continue;   // nothing routable -- leave the node as a plain agent
      }
      const taskKeys = values(dig(analyzed, 'parents', did) ?? []).filter(
        (p: any) => isset(analyzed, 'agents', strval(p)) || isset(analyzed, 'code', strval(p)),
      );
      const taskKeysPy = '[' + taskKeys.map((p: any) => '"node_' + strval(p) + '"').join(', ') + ']';
      let entry = `# DISPATCHER ${did}: the chooser plus its menu. Only the child it names runs;\n`;
      entry += '# the others are never scheduled (they are NOT in a layer of their own).\n';
      entry += `node_${did}__dispatch = _DispatcherAgent(\n`;
      entry += `    name="node_${did}__dispatch",\n`;
      entry += `    route_key="node_${did}",\n`;
      entry += `    node_id="${did}",\n`;
      entry += '    display=' + PythonEmitHelpers.pyStr(CompiledRuntimeEmit.displayName(analyzed, did)) + ',\n';
      const dec = dig(analyzed, 'decisions', did);
      if (dec !== null) {
        entry += '    routing_mode=' + PythonEmitHelpers.pyStr(strval(dec['routing_mode'])) + ',\n';
        entry += '    decision=' + (count(dec['decision']) === 0 ? '[]' : PythonEmitHelpers.jsonToPython(dec['decision'])) + ',\n';
        entry += '    decision_question=' + PythonEmitHelpers.pyStr(strval(dec['decision_question'])) + ',\n';
        entry += '    min_confidence=' + var_export_scalar(new PhpFloat(floatval(dec['min_confidence']))) + ',\n';
        entry += '    unclear_branch=' + PythonEmitHelpers.pyStr(strval(dec['unclear_branch'])) + ',\n';
      }
      entry += `    task_keys=${taskKeysPy},\n`;
      entry += '    menu=[' + menuEntries.join(', ') + '],\n';
      entry += '    sub_agents=[' + subs.join(', ') + '],\n';
      entry += ')';
      out.push(entry);
    }
    return out.join('\n\n');
  }

  /**
   * Build `root_agent = SequentialAgent(...)` from the topological layers.
   *
   * Layer 0 (start node) is skipped because the start node only seeds state
   * and is not itself an LlmAgent.  For each subsequent layer:
   *  - Collect `node_<id>` var names of runnable nodes (agent / agent-template / output / playbook / code).
   *  - A layer with exactly one runnable → use that var directly.
   *  - A layer with >1 runnables → wrap in ParallelAgent.
   * Empty layers (all structural nodes) are skipped.
   */
  private static rootBlock(analyzed: any): string {
    const isRunnable = (id: string): boolean => {
      const t = GraphAnalyzer.typeOf(analyzed['byId'][id]);
      // 'playbook' is here because the target runs playbook nodes now: a
      // node missing from this list is silently dropped from root_agent.
      return in_array(t, ['agent', 'agent-template', 'output', 'playbook', 'code'], true);
    };
    // A dispatcher owns its menu (see dispatcherInstancesBlock): the wrapper
    // stands in for the dispatcher node, and the children it may pick are
    // NOT layer members -- ADK gives an agent exactly one parent, and
    // leaving them in a ParallelAgent is precisely the fan-out a dispatcher
    // is not.
    const dispatch = GraphAnalyzer.dispatchMenus(analyzed);
    const nested: Record<string, boolean> = {};
    for (const targets of values(dispatch['menus'])) {
      for (const t of values(targets)) {
        if (CompiledRuntimeEmit.menuNestable(analyzed, strval(t['id']))) {
          nested[strval(t['id'])] = true;
        }
      }
    }
    const layerExprs: string[] = [];
    for (const [k, layer] of entries(analyzed['layers'])) {
      const vars: string[] = [];
      for (const id0 of values(layer)) {
        const id = strval(id0);
        if (Object.hasOwn(nested, id)) {
          continue;
        }
        if (isRunnable(id)) {
          let v = has(dispatch['menus'], id) ? `node_${id}__dispatch` : `node_${id}`;
          const rules = ADKGenerator.gateRules(analyzed, id);
          if (rules !== null) {
            const when = '[' + rules.map((r) => '[' + r.map((x) => PythonEmitHelpers.pyStr(x)).join(', ') + ']').join(', ') + ']';
            v = `_Gate(name="gate_${id}", when=${when}, sub_agents=[${v}])`;
          }
          vars.push(v);
        }
      }
      if (vars.length === 0) {
        continue;
      }
      if (vars.length === 1) {
        layerExprs.push(vars[0]);
      } else {
        layerExprs.push(`ParallelAgent(name="layer_${k}", sub_agents=[` + vars.join(', ') + '])');
      }
    }
    const body = layerExprs.join(',\n    ');
    return `root_agent = SequentialAgent(\n    name="workflow",\n    sub_agents=[\n    ${body}\n    ],\n)\n`
      + '_attach_recording(root_agent)   # run events for every recorded node (see RUN EVENTS)';
  }

  /**
   * Emit `async def run_workflow(...)` + the CLI entry (the package's listener instead, in a package).
   *
   * run_workflow() RUNS and returns the answer un-stripped; document
   * extraction and saving belong to __main__ (a conversational turn
   * through api.py must not write a file per prompt, and the editor
   * performs the same extraction on the answer it receives).
   */
  private static mainBlock(analyzed: any): string {
    const sp = PythonEmitHelpers.pyStr(strval(analyzed['startPrompt']));
    const name = PythonEmitHelpers.pyStr(strval(analyzed['workflow']['name']));
    // The package saves into its own folder (outputs/), as LangGraph's package does.
    const outRoot = !empty(analyzed['package']) ? 'os.path.join(PACKAGE_DIR, "outputs")'
      : 'os.path.expanduser("~/Documents/synergyAI/outputs")';
    const wfId = intval(analyzed['workflow']['id'] ?? 0);
    const storageEnabled = !empty(analyzed['outputStorageEnabled']) ? 'True' : 'False';
    const folder = analyzed['outputFolder'] ?? null;
    const folderPy = (folder !== null && folder !== '') ? PythonEmitHelpers.pyStr(strval(folder)) : 'None';
    const nodeNames: any = oarr();
    for (const [nid, ag] of entries(analyzed['agents'] ?? [])) {
      nodeNames[strval(nid)] = strval(ag['name'] ?? ('node ' + nid));
    }
    for (const [nid, cd] of entries(analyzed['code'] ?? [])) {
      nodeNames[strval(nid)] = strval(cd['display']);
    }
    for (const [nid, pd] of entries(analyzed['playbooks'] ?? [])) {
      nodeNames[strval(nid)] = strval(pd['display']);
    }
    const outputIds: string[] = [];
    for (const [nid, node] of entries(analyzed['byId'] ?? [])) {
      if (GraphAnalyzer.typeOf(node) === 'output') {
        outputIds.push(strval(nid));
      }
    }
    const outputIdsPy = PythonEmitHelpers.jsonToPython(outputIds);
    // A dict even when empty (a workflow with no agent node): jsonToPython([]) would be a list.
    const nodeNamesPy = count(nodeNames) === 0 ? '{}' : PythonEmitHelpers.jsonToPython(nodeNames);
    const dw = analyzed['defaultWatch'] ?? null;
    return `WORKFLOW_NAME = ${name}\n`
      + `WORKFLOW_ID = ${wfId}\n`
      // The Start's mode (prompt | cron | watch), its schedule and its event trigger (StartTriggerFacts):
      // the package's listener and CLI read them.
      + 'START_MODE = ' + PythonEmitHelpers.pyStr(strval(analyzed['startMode'] ?? 'prompt')) + '\n'
      + 'DEFAULT_CRON = ' + ((analyzed['defaultCron'] ?? null) === null ? 'None' : PythonEmitHelpers.pyStr(strval(analyzed['defaultCron']))) + '\n'
      + 'DEFAULT_WATCH = ' + (dw === null ? 'None'
        : PythonEmitHelpers.jsonToPython({ server: dw['server'], tool: dw['tool'], args: toObject(dw['args']) })) + '\n'
      // Named (not just inlined below) so the run server's api.py -- which has
      // no argv of its own -- can import it as the fallback for an empty prompt.
      + `DEFAULT_PROMPT = ${sp}\n`
      + `OUTPUT_STORAGE_ENABLED = ${storageEnabled}\n`
      + `OUTPUT_FOLDER = ${folderPy}\n`
      + `NODE_NAMES = ${nodeNamesPy}  # node id -> human name (for readable logs)\n`
      + `OUTPUT_IDS = ${outputIdsPy}  # the Output nodes: named "Output" in the logs, not timed in the summary\n`
      + '\n'
      + ADKGenerator.RUN_WORKFLOW
      + (!empty(analyzed['package']) ? CompiledRuntimeEmit.packageListenBlock() : String.raw`if __name__ == "__main__":
    # argparse would fight the prompt's own spaces; the runner
    # passes it space-split; sys.argv[1] alone would keep only the first word.
    _text = asyncio.run(run_workflow(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else ${sp}))
    # Honour the Output node's storage setting: when ON, persist the final result
    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,
    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.
    _saved_path = None
    if OUTPUT_STORAGE_ENABLED:
        import re as _re
        _mm = _re.search(r"(?is)<!doctype html.*?</html\s*>", _text) or _re.search(r"(?is)<html[\s>].*?</html\s*>", _text)
        if _mm:
            _text = _mm.group(0)  # strip narration/fences around a full HTML doc
            _ext = "html"
        else:
            _ext = "md"
        _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
        _ts = time.strftime("%Y%m%d-%H%M%S")
        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or ${outRoot}
        if OUTPUT_FOLDER:
            _cf = os.path.expanduser(OUTPUT_FOLDER)
            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)
        else:
            _save_dir = os.path.join(_root, "workflow")
        os.makedirs(_save_dir, exist_ok=True)
        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
        with open(_out, "w", encoding="utf-8") as _f:
            _f.write(_text)
        _saved_path = os.path.abspath(_out)
    if _saved_path:
        print(f"  Document saved to: {_saved_path}", flush=True)
    else:
        print("  Document not saved (output storage is OFF in the workflow settings) -- "
              "the output is printed above.", flush=True)`);
  }

  /** run_workflow() and the CLI ENTRY comment above the entry point (mainBlock()'s fixed text). */
  private static readonly RUN_WORKFLOW: string = String.raw`async def run_workflow(prompt: str, session: str | None = None) -> str:
    if START_DOCUMENTS:
        doc_parts = []
        for doc in START_DOCUMENTS:
            name = doc.get("name", "Document")
            path = doc.get("path", "")
            if path and not os.path.isabs(path):
                path = os.path.join(PACKAGE_DIR, path)   # start_documents/ in the package
            if not path:
                doc_parts.append(f"### {name}\n\n_(no path on attachment record)_")
                continue
            try:
                md = _convert_doc_to_markdown(path)
                doc_parts.append(f"### {name}\n\n{md}")
            except Exception as e:
                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
        if doc_parts:
            prompt = (
                "## Attached Documents\n\n"
                + "\n\n---\n\n".join(doc_parts)
                + "\n\n---\n\n"
                + prompt
            )
    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)
    print(f"[workflow] prompt: {prompt[:200]!r}", flush=True)
    session_service = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)
    adk_session = await session_service.create_session(app_name="workflow", user_id="local", state={"user_prompt": prompt})
    _run_reset()
    if START_NODE:
        _rec_node_start(START_NODE[0], START_NODE[1], "start")
        _rec_node_complete(START_NODE[0], START_NODE[1], "start", output=prompt)
    outputs = {}   # the Output nodes' answers (the workflow's answer, when it has Output nodes)
    final = ""
    t0 = time.monotonic()
    seen = set()
    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    try:
        async for event in runner.run_async(user_id="local", session_id=adk_session.id, new_message=content):
            author = getattr(event, "author", "?")
            if isinstance(author, str) and author.startswith("node_"):
                _nk = author.split("_")[1] if "_" in author else author
                _t_first.setdefault(_nk, time.monotonic())
                _t_last[_nk] = time.monotonic()
            if author and author not in seen:
                seen.add(author)
                if isinstance(author, str) and author.startswith("node_"):
                    _ap = author.split("_")
                    _nid = _ap[1] if len(_ap) > 1 else author
                    _kind = "skill step" if "skill" in author else "node"
                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, 'Output' if _nid in OUTPUT_IDS else _nid)!r} \u2192 {_kind} active", flush=True)
                else:
                    print(f"[node] > {author}", flush=True)
            parts = (event.content.parts if event.content else None) or []
            for p in parts:
                fc = getattr(p, "function_call", None)
                fr = getattr(p, "function_response", None)
                if fc is not None:
                    _a = str(getattr(fc, "args", ""))[:200]
                    print(f"[tool] -> {fc.name}({_a})", flush=True)
                elif fr is not None:
                    _r = str(getattr(fr, "response", ""))[:200]
                    print(f"[tool] <- {fr.name}: {_r}", flush=True)
                else:
                    txt = (getattr(p, "text", None) or "").strip()
                    if txt:
                        print(f"[{author}] {txt[:240]}", flush=True)
            if event.is_final_response() and event.content and event.content.parts:
                final = event.content.parts[0].text or final
                if author in OUTPUT_NODE_KEYS:
                    outputs[author] = event.content.parts[0].text or ""
        if OUTPUT_NODE_KEYS:   # the answer is what the Output nodes gave: none ran (nothing to do) = ""
            final = "\n\n---\n\n".join(v for v in outputs.values() if v)
        final = final or _RUN["unrouted"]   # nothing reached the Output: why the dispatcher did not route
        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)
    except Exception as e:
        for _nid, (_name, _type) in list(_RUN["open"].items()):   # a node that failed mid-run ends as failed
            _rec_node_complete(_nid, _name, _type, success=False, error=f"{type(e).__name__}: {e}")
        print("[workflow] ERROR:", flush=True)
        traceback.print_exc()
        raise
    print(final)
    # Closing RUN SUMMARY (printed LAST): time per node, total wall-clock.
    # Where the document was saved is NOT part of this block: saving belongs
    # to __main__ (see below), so the CLI entry prints that line itself right
    # after this one.
    print("\n" + "=" * 74, flush=True)
    print("RUN SUMMARY", flush=True)
    print("-" * 74, flush=True)
    # Only named agent nodes (skip output pass-throughs: ~0s, no display name).
    _durs = {NODE_NAMES[k]: _t_last[k] - _t_first[k] for k in _t_first if k in _t_last and k in NODE_NAMES}
    if _durs:
        _w = max(len(n) for n in _durs)
        print("  Time per node:", flush=True)
        for _n, _s in sorted(_durs.items(), key=lambda kv: -kv[1]):
            print(f"    {_n:<{_w}}   {_s:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)
    print(f"  Final output: {len(final)} chars", flush=True)
    print("=" * 74, flush=True)
    return final

# ============================== CLI ENTRY =================================
# Extracting the deliverable and saving it both live HERE, not in
# run_workflow(): the run server calls run_workflow() once per
# conversational turn, and a turn must not write a file per prompt.
# run_workflow() returns the answer UN-STRIPPED for the same reason --
# the editor runs this same extraction on what it receives, so narration
# wrapped around a document (or a second document, which the non-greedy
# regex would discard) must still be there when the answer arrives.
`;

  /**
   * Emit concrete typed FunctionTool functions from TOOL_CATALOG input_schema.
   *
   * For each tool in analyzed['usedCatalog'] we emit a concrete Python
   * function `_tool_<sanitized>` whose signature is derived from the tool's
   * `input_schema.properties`.  ADK introspects the function signature to
   * build the tool's parameter schema, so a concrete signature is required
   * for the model to pass structured arguments.
   *
   * JSON type → Python hint: string→str, integer→int, number→float,
   * boolean→bool, array→list, object→dict, unknown→str.
   * Required properties have no default; optional properties default to None.
   * Required params are emitted before optional params (Python signature rule).
   * Property names that are not valid Python identifiers (or are keywords) are
   * collected into a trailing **extra parameter (rare).
   *
   * `build_tools_from_catalog()` returns a plain dict keyed by the REAL tool
   * name mapping to FunctionTool(<fn>).  When usedCatalog is empty, it
   * returns {}.
   */
  static adkToolBuilderBlock(analyzed: any): string {
    const typeMap: Record<string, string> = {
      string: 'str',
      integer: 'int',
      number: 'float',
      boolean: 'bool',
      array: 'list',
      object: 'dict',
    };
    const typeOf = (pspec: any): string => {
      const t = pspec['type'] ?? '';
      return (typeof t === 'string' || typeof t === 'number') && Object.hasOwn(typeMap, String(t)) ? typeMap[String(t)] : 'str';
    };
    const isIdent = (pname: string): boolean => preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', pname) === 1 && !PY_KEYWORDS.has(pname);

    const functions: string[] = [];
    const catalogEntries: string[] = [];

    for (const [toolName, spec] of entries(analyzed['usedCatalog'])) {
      const description = strval(spec['description'] ?? toolName);
      const inputSchema = is_array(spec['input_schema'] ?? null) ? spec['input_schema'] : [];
      const properties = is_array(dig(inputSchema, 'properties')) ? toArr(inputSchema['properties']) : [];
      const required = is_array(dig(inputSchema, 'required')) ? inputSchema['required'] : [];
      const serverUrl = strval(spec['server_url'] ?? '');

      // Sanitize tool name to a valid Python identifier for the function name.
      let safeName = identBytes(toolName);
      if (preg_match('/^[0-9]/', safeName)) {
        safeName = '_' + safeName;
      }
      const fnName = '_tool_' + safeName;

      const requiredSet = new Set(values(required).map(strval));

      // Split properties into valid-identifier required vs optional.
      // Properties whose names are not valid Python identifiers OR are Python
      // keywords (e.g. `def f(in: str)` is a SyntaxError) fall into **extra.
      const validRequired: any = oarr();
      const validOptional: any = oarr();
      let hasExtra = false;

      for (const pname0 of values(required)) {
        const pname = strval(pname0);
        if (!has(properties, pname)) {
          continue;
        }
        if (isIdent(pname)) {
          validRequired[pname] = is_array(properties[pname]) ? properties[pname] : [];
        } else {
          hasExtra = true;
        }
      }

      for (const [pname, pspec] of entries(properties)) {
        if (requiredSet.has(pname)) {
          continue;   // already handled
        }
        if (isIdent(pname)) {
          validOptional[pname] = is_array(pspec) ? pspec : [];
        } else {
          hasExtra = true;
        }
      }

      // Build parameter list: required first (no default), optional second (default=None).
      const params: string[] = [];
      for (const [pname, pspec] of entries(validRequired)) {
        params.push(`${pname}: ${typeOf(pspec)}`);
      }
      for (const [pname, pspec] of entries(validOptional)) {
        params.push(`${pname}: ${typeOf(pspec)} = None`);
      }
      if (hasExtra) {
        params.push('**extra');
      }

      const paramStr = params.join(', ');
      const allValidProps = [...entries(validRequired), ...entries(validOptional)];

      // Build Google-style docstring.
      const safeDesc = str_replace('"""', '\\"\\"\\"', description);
      let doc = `    """${safeDesc}`;
      if (allValidProps.length > 0) {
        doc += '\n\n    Args:';
        for (const [pname, pspec] of allValidProps) {
          const pDesc = strval(pspec['description'] ?? '');
          doc += `\n        ${pname}: ${pDesc}`;
        }
      }
      doc += '\n    """';

      // Build body: assemble _args (omit None optional values), then call MCP.
      const pyUrl = PythonEmitHelpers.pyStr(serverUrl);
      const pyName = PythonEmitHelpers.pyStr(toolName);

      let body: string;
      if (allValidProps.length > 0 || hasExtra) {
        const argPairs = allValidProps.map(([pname]) => `"${pname}": ${pname}`);
        let argDict: string;
        if (hasExtra) {
          const innerDict = '{' + argPairs.join(', ') + '}';
          argDict = `{**${innerDict}, **extra}`;
        } else {
          argDict = '{' + argPairs.join(', ') + '}';
        }
        body = `    _args = {k: v for k, v in ${argDict}.items() if v is not None}\n`;
        body += `    return _call_mcp_tool(${pyUrl}, ${pyName}, _args)`;
      } else {
        // No properties — empty-schema tool; pass empty dict.
        body = `    return _call_mcp_tool(${pyUrl}, ${pyName}, {})`;
      }

      functions.push(`def ${fnName}(${paramStr}) -> str:\n${doc}\n${body}`);
      catalogEntries.push(`        ${PythonEmitHelpers.pyStr(toolName)}: FunctionTool(${fnName})`);
    }

    // Emit concrete _tool_* functions at module scope before build_tools_from_catalog.
    let out = '';
    if (functions.length > 0) {
      out += functions.join('\n\n') + '\n\n';
    }

    // build_tools_from_catalog always present; returns {} when no tools.
    if (catalogEntries.length > 0) {
      out += 'def build_tools_from_catalog() -> dict:\n';
      out += '    return {\n';
      out += catalogEntries.join(',\n') + ',\n';
      out += '    }';
    } else {
      out += 'def build_tools_from_catalog() -> dict:\n';
      out += '    return {}';
    }

    return out;
  }
}
