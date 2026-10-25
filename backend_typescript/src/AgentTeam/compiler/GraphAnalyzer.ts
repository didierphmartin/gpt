import { Kysely, sql } from 'kysely';
import { db } from '../../db/pools';
import { DB } from '../../db/types';
import { agentToArray } from '../AgentRepository';
import {
  array_key_exists, array_map, copy, entries, has, in_array, intval, isEmptyArr, is_array, is_string, jsonDecodeAssoc,
  keysOf, oarr, preg_match, preg_replace, stdObj, strtolower, strval, substr, trim, truthy, values, deepCopy, empty,
} from './php';

/**
 * WorkflowGraphAnalyzer for the LangGraph compiler: the shared DSL-analysis front half, ported from
 * backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php with PHP's array shapes (keyed arrays are oarr(), so
 * numeric-looking node ids keep their insertion order and json_encode prints what PHP prints).
 *
 *  - static reachableGraph / analyzeGraph / typeOf / dispatchMenus / docNodesFromAnalyzed / docNodes /
 *    skillsFromConfig: pure, no DB.
 *  - analyze(workflowId, userId) / serverIndex(userId) / availableToolsById(userId): read the database
 *    (mcp_servers, mcp_server_tools, system_llm_settings) and the repositories.
 *
 * (The legacy src/AgentTeam/WorkflowGraphAnalyzer.ts stays as ADK/MAF read it.)
 */

/** What analyze() reads a workflow through (WorkflowRepository.findById). */
export interface GraphAnalyzerWorkflowRepo {
  findById(id: number): Promise<any> | any;
}
/** What analyze() reads the graph through (WorkflowGraphRepository.getGraph). */
export interface GraphAnalyzerGraphRepo {
  getGraph(workflowId: number): Promise<any> | any;
}
/** What analyze() reads saved agents through (AgentRepository.findById). */
export interface GraphAnalyzerAgentRepo {
  findById(id: number): Promise<any> | any;
}

/** PHP `$x['a']['b'] ?? null`: null when any level is missing or not an array. */
function dig(x: any, ...keys: string[]): any {
  let v = x;
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== 'object' || Buffer.isBuffer(v)) return null;
    v = Array.isArray(v) ? v[Number(k)] : v[k];
  }
  return v === undefined ? null : v;
}

/** PHP `$a ?? $b ?? ...` over already-read values. */
function coalesce(...xs: any[]): any {
  for (const x of xs) if (x !== null && x !== undefined) return x;
  return null;
}

/** Edge endpoints as every DSL variant spells them. */
function edgeFrom(e: any): string {
  return strval(coalesce(dig(e, 'from'), dig(e, 'from_node_id'), dig(e, 'source'), ''));
}
function edgeTo(e: any): string {
  return strval(coalesce(dig(e, 'to'), dig(e, 'to_node_id'), dig(e, 'target'), ''));
}

/** CodeNodeEmit::slug (a server name as an identifier). */
function serverSlug(name: string): string {
  return strtolower(preg_replace('/[^a-z0-9]+/i', '_', name));
}

export class GraphAnalyzer {
  constructor(
    private readonly workflowRepo: GraphAnalyzerWorkflowRepo,
    private readonly graphRepo: GraphAnalyzerGraphRepo,
    private readonly agentRepo: GraphAnalyzerAgentRepo,
    private readonly ex: Kysely<DB> = db,
  ) {}

  // ------------------------------------------------------------------ pure graph analysis

  /**
   * The part of a {nodes, edges} graph a run reaches: the start node(s) and everything downstream of them.
   * A graph with no start node is returned unchanged. Other keys of the graph are kept.
   */
  static reachableGraph(graph: any): any {
    const nodes = coalesce(dig(graph, 'nodes'), []);
    const edges = coalesce(dig(graph, 'edges'), []);
    const children = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const e of values(edges)) {
      const from = edgeFrom(e);
      const to = edgeTo(e);
      if (from !== '' && to !== '') {
        if (!children.has(from)) children.set(from, []);
        children.get(from)!.push(to);
      }
    }
    const queue: string[] = [];
    for (const n of values(nodes)) {
      if (GraphAnalyzer.typeOf(n) === 'start') queue.push(strval(coalesce(dig(n, 'id'), '')));
    }
    if (queue.length === 0) return graph;
    while (queue.length) {
      const id = queue.shift()!;
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      for (const c of children.get(id) ?? []) queue.push(c);
    }
    const out = copy(graph);
    out['nodes'] = values(nodes).filter((n) => seen.has(strval(coalesce(dig(n, 'id'), ''))));
    out['edges'] = values(edges).filter((e) => seen.has(edgeFrom(e)));
    return out;
  }

  /**
   * Pure, DB-free analysis of a {nodes, edges} graph: byId (oarr), order (Kahn), edges ({from, to}),
   * children / parents (oarr of lists), layers (longest-path levels), startNodeId.
   */
  static analyzeGraph(graph: any): any {
    const nodes = coalesce(dig(graph, 'nodes'), []);
    const edges = coalesce(dig(graph, 'edges'), []);

    const byId = oarr();
    for (const n of values(nodes)) {
      const id = strval(coalesce(dig(n, 'id'), ''));
      if (id === '') continue;
      byId[id] = n;
    }

    const norm: Array<{ from: string; to: string }> = [];
    const children = oarr<string[]>();
    const parents = oarr<string[]>();
    for (const id of keysOf(byId)) {
      children[id] = [];
      parents[id] = [];
    }
    for (const e of values(edges)) {
      const from = edgeFrom(e);
      const to = edgeTo(e);
      if (from === '' || to === '' || !has(byId, from) || !has(byId, to) || children[from].includes(to)) continue;
      norm.push({ from, to });
      children[from].push(to);
      parents[to].push(from);
    }

    const indeg = new Map<string, number>();
    for (const id of keysOf(byId)) indeg.set(id, parents[id].length);
    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, d] of indeg) {
      if (d === 0) {
        queue.push(id);
        level.set(id, 0);
      }
    }
    const order: string[] = [];
    const work = new Map(indeg);
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const c of children[id]) {
        level.set(c, Math.max(level.get(c) ?? 0, (level.get(id) ?? 0) + 1));
        const w = work.get(c)! - 1;
        work.set(c, w);
        if (w === 0) queue.push(c);
      }
    }
    if (order.length !== keysOf(byId).length) {
      throw new Error('Workflow graph has a cycle or disconnected node');
    }

    const byLevel = new Map<number, string[]>();
    for (const [id, lv] of level) {
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)!.push(id);
    }
    const layers = [...byLevel.keys()].sort((a, b) => a - b).map((lv) => byLevel.get(lv)!);

    let startNodeId = '';
    for (const [id, n] of entries(byId)) {
      if (GraphAnalyzer.typeOf(n) === 'start') {
        startNodeId = id;
        break;
      }
    }

    return { byId, order, edges: norm, children, parents, layers, startNodeId };
  }

  /** Canonical node type: node_type, then type, then config.type (an empty value falls through); else 'agent'. */
  static typeOf(n: any): string {
    for (const t of [dig(n, 'node_type'), dig(n, 'type'), dig(n, 'config', 'type')]) {
      if (t !== null && strval(t) !== '') return strval(t);
    }
    return 'agent';
  }

  /**
   * Dispatcher menus over an analyze()-shaped array: menus (dispatcher id => [{id, name}] in edge order) and
   * routedBy (child id => its dispatcher id).
   */
  static dispatchMenus(analyzed: any): any {
    const byId = coalesce(dig(analyzed, 'byId'), []);
    const order = coalesce(dig(analyzed, 'order'), keysOf(byId));
    const menus = oarr();
    const routedBy = oarr();
    for (const nid0 of values(order)) {
      const nid = strval(nid0);
      const node = dig(byId, nid);
      if (!is_array(node) || !in_array(GraphAnalyzer.typeOf(node), ['agent', 'agent-template'], true)) continue;
      const cfg = is_array(dig(node, 'config')) ? node['config'] : [];
      if (strval(coalesce(dig(cfg, 'agent_type'), '')) !== 'dispatcher') continue;
      const targets: any[] = [];
      for (const e of values(coalesce(dig(analyzed, 'edges'), []))) {
        const from = strval(coalesce(dig(e, 'from'), dig(e, 'from_node_id'), ''));
        const to = strval(coalesce(dig(e, 'to'), dig(e, 'to_node_id'), ''));
        if (from !== nid || to === '') continue;
        const child = dig(byId, to);
        if (!is_array(child) || !in_array(GraphAnalyzer.typeOf(child), ['agent', 'agent-template', 'playbook', 'code'], true)) continue;
        targets.push({ id: to, name: GraphAnalyzer.displayNameOf(child, analyzed, to) });
        routedBy[to] = nid;
      }
      if (targets.length) menus[nid] = targets;
    }
    return { menus, routedBy };
  }

  /** Display name for a node: the agents map first (it carries the resolved name), then config. */
  private static displayNameOf(node: any, analyzed: any, id: string): string {
    const fromAgents = strval(coalesce(dig(analyzed, 'agents', id, 'name'), ''));
    if (fromAgents !== '') return fromAgents;
    const cfg = is_array(dig(node, 'config')) ? node['config'] : [];
    for (const k of ['agent_name', 'name', 'label']) {
      if (strval(coalesce(dig(cfg, k), '')) !== '') return strval(cfg[k]);
    }
    return strval(coalesce(dig(node, 'name'), id));
  }

  /** docNodes() over an analyze()-shaped array (a hand-built one may carry only 'agents'). */
  static docNodesFromAnalyzed(analyzed: any, extra: any = [], runnable: string[] = ['start', 'agent', 'agent-template', 'output']): any[] {
    const agents = coalesce(dig(analyzed, 'agents'), []);
    let byId = coalesce(dig(analyzed, 'byId'), []);
    if (isEmptyArr(byId)) {
      byId = oarr();
      for (const [id, ag] of entries(agents)) {
        byId[id] = { id, config: { type: 'agent', agent_name: coalesce(dig(ag, 'name'), `agent_${id}`) } };
      }
    }
    const order = coalesce(dig(analyzed, 'order'), keysOf(byId));
    return GraphAnalyzer.docNodes(byId, order, coalesce(dig(analyzed, 'edges'), []), agents, extra, runnable);
  }

  /**
   * Uniform node descriptors for the generated-script documentation, one per node in `order`: id, type, name,
   * provider, model, temperature, max_tokens, thinking, tools, skills, dispatch, playbook, supported, parents,
   * children, prompt.
   */
  static docNodes(byId: any, order: any, edges: any, agents: any, extra: any = [], runnable: string[] = ['start', 'agent', 'agent-template', 'output']): any[] {
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    for (const e of values(edges)) {
      const f = strval(coalesce(dig(e, 'from'), dig(e, 'from_node_id'), ''));
      const t = strval(coalesce(dig(e, 'to'), dig(e, 'to_node_id'), ''));
      if (f === '' || t === '') continue;
      if (!children.has(f)) children.set(f, []);
      children.get(f)!.push(t);
      if (!parents.has(t)) parents.set(t, []);
      parents.get(t)!.push(f);
    }
    const nameOf = (id: string): string => {
      const n = coalesce(dig(byId, id), []);
      const c = is_array(dig(n, 'config')) ? n['config'] : [];
      const t = GraphAnalyzer.typeOf(n);
      if (t === 'start') return 'Start';
      if (t === 'output') return 'Output';
      const name = strval(coalesce(dig(agents, id, 'name'), dig(c, 'agent_name'), dig(c, 'name'), dig(n, 'name'), ''));
      return name !== '' ? name : `node_${id}`;
    };
    const label = (id: string): string => nameOf(id) + ` (${id})`;
    const out: any[] = [];
    for (const id0 of values(order)) {
      const id = strval(id0);
      const n = coalesce(dig(byId, id), []);
      const c = is_array(dig(n, 'config')) ? n['config'] : [];
      const t = GraphAnalyzer.typeOf(n);
      const ag = dig(agents, id);
      const agSkills = dig(ag, 'skills');
      const d: any = {
        id,
        type: t,
        name: nameOf(id),
        provider: strval(coalesce(dig(ag, 'provider'), dig(c, 'agent_provider'), dig(c, 'provider'), dig(c, 'llm_provider'), '')),
        model: strval(coalesce(dig(ag, 'model'), dig(c, 'model'), '')),
        temperature: coalesce(dig(ag, 'temperature'), dig(c, 'settings', 'temperature')),
        max_tokens: coalesce(dig(ag, 'max_tokens'), dig(c, 'settings', 'max_tokens')),
        thinking: coalesce(dig(ag, 'thinking'), dig(c, 'settings', 'thinking')),
        tools: values(coalesce(dig(ag, 'tools'), [])).map((x: any) => strval(is_array(x) ? coalesce(dig(x, 'name'), '') : x)),
        skills: array_map(
          (s: any) => coalesce(dig(s, 'dir'), has(s, 'inline') ? 'inline skill' : 'skill'),
          agSkills !== null ? agSkills : GraphAnalyzer.skillsFromConfig(c),
        ),
        dispatch: [],
        playbook: null,
        supported: in_array(t, runnable, true),
        parents: (parents.get(id) ?? []).map(label),
        children: (children.get(id) ?? []).map(label),
        prompt: t === 'start' ? strval(coalesce(dig(c, 'prompt'), '')) : '',
      };
      if (t === 'start' || t === 'output') {
        d.provider = '';
        d.model = '';
        d.temperature = null;
        d.max_tokens = null;
        d.thinking = null;
      }
      const x = coalesce(dig(extra, id), []);
      if (has(x, 'dispatch')) {
        d.dispatch = values(x['dispatch']);
      } else if (in_array(t, ['agent', 'agent-template'], true) && strval(coalesce(dig(c, 'agent_type'), '')) === 'dispatcher') {
        d.dispatch = (children.get(id) ?? [])
          .filter((ch) => in_array(GraphAnalyzer.typeOf(coalesce(dig(byId, ch), [])), ['agent', 'agent-template', 'playbook', 'code'], true))
          .map(nameOf);
      }
      if (t === 'playbook') {
        const pb = dig(c, 'playbook');
        const text = is_string(pb) ? pb : '';
        const m: string[] = [];
        const title = preg_match('/^\\s*(?:#+\\s*|\\*\\*)?Title:\\s*(.+?)\\s*(?:\\*\\*)?$/mi', text, m) ? trim(m[1]) : '';
        const left = coalesce(dig(x, 'playbook'), []);
        const merged = oarr(entries(left));
        const right: Array<[string, any]> = [['title', title], ['writes', !empty(dig(c, 'writes_enabled'))], ['bound', null], ['unbound', null]];
        for (const [k, v] of right) if (!array_key_exists(k, merged)) merged[k] = v;
        d.playbook = merged;
      }
      out.push(d);
    }
    return out;
  }

  /** Ordered skill bindings for an agent node's config: [{dir}] (bound_skill), [{inline}] (skill_content) or []. */
  static skillsFromConfig(config: any): any[] {
    const out: any[] = [];
    const bs = dig(config, 'bound_skill');
    if (is_array(bs) && trim(strval(coalesce(dig(bs, 'dir_name'), ''))) !== '') {
      out.push({ dir: trim(strval(bs['dir_name'])) });
    } else if (trim(strval(coalesce(dig(config, 'skill_content'), ''))) !== '') {
      out.push({ inline: strval(config['skill_content']) });
    }
    return out;
  }

  // ------------------------------------------------------------------ DB-backed analysis

  /**
   * The workflow's graph (what Start reaches) analysed, with the agents map, the MCP catalog and servers its
   * agents use, the Start's prompt and documents, and the Output storage setting.
   */
  async analyze(workflowId: number, userId: string | null = null): Promise<any> {
    const wf = await this.workflowRepo.findById(workflowId);
    if (!wf) throw new Error('Workflow not found');
    const graph = GraphAnalyzer.reachableGraph(await this.graphRepo.getGraph(workflowId));
    const base = GraphAnalyzer.analyzeGraph(graph);

    const agents = oarr();
    for (const id of base.order as string[]) {
      const n = base.byId[id];
      if (!in_array(GraphAnalyzer.typeOf(n), ['agent', 'agent-template'], true)) continue;
      const c = coalesce(dig(n, 'config'), []);
      const agentId = coalesce(dig(n, 'agent_id'), dig(c, 'agent_id'));
      let tools: any = coalesce(dig(c, 'selectedTools'), dig(c, 'tools'), []);
      if (!is_array(tools)) tools = [];
      if (agentId !== null && agentId !== '') {
        try {
          const agent = await this.agentRepo.findById(intval(agentId));
          if (agent !== null && agent !== undefined) {
            const agentArr = typeof agent.toArray === 'function' ? agent.toArray() : agentToArray(agent);
            const agentTools = coalesce(dig(agentArr, 'tools'));
            if (empty(tools) && is_array(agentTools)) {
              tools = [];
              for (const tool of values(agentTools)) {
                let tname: any = null;
                if (is_string(tool)) tname = tool;
                else if (is_array(tool)) tname = coalesce(dig(tool, 'name'), dig(tool, 'tool_name'));
                if (truthy(tname)) {
                  if (strval(tname).startsWith('mcp_')) tname = substr(strval(tname), 4);
                  tools.push(tname);
                }
              }
            }
          }
        } catch {
          // Swallow, as PHP does.
        }
      }
      const thinking = dig(c, 'settings', 'thinking');
      agents[id] = {
        name: strval(coalesce(dig(c, 'agent_name'), `agent_${id}`)),
        systemPrompt: strval(coalesce(dig(c, 'systemPrompt'), dig(c, 'instructions'), '')),
        provider: strval(coalesce(dig(c, 'agent_provider'), dig(c, 'provider'), dig(c, 'llm_provider'), 'claude')),
        model: strval(coalesce(dig(c, 'model'), '')),
        temperature: dig(c, 'settings', 'temperature'),
        max_tokens: dig(c, 'settings', 'max_tokens'),
        thinking: in_array(thinking, ['on', 'off'], true) ? thinking : null,
        tools: values(tools).map(strval),
        skill_content: strval(coalesce(dig(c, 'skill_content'), '')),
        skills: GraphAnalyzer.skillsFromConfig(c),
        output_schema_id: dig(c, 'output_schema_id'),
        documents: coalesce(dig(c, 'documents'), []),
      };
    }

    const providerDefaults = new Map<string, string>();
    try {
      const rows = (await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(this.ex)).rows;
      for (const r of rows) providerDefaults.set(strtolower(strval(coalesce(r.provider_key, ''))), strval(coalesce(r.model, '')));
    } catch {
      // Table missing/unreadable: leave models blank.
    }
    for (const [, ag] of entries(agents)) {
      if (strval(coalesce(ag.model, '')) === '') ag.model = providerDefaults.get(strtolower(strval(ag.provider))) ?? '';
    }

    const [usedCatalog, usedServers] = await this.buildToolCatalog(agents, userId);

    const startNode = coalesce(dig(base.byId, base.startNodeId), []);
    const name = typeof wf.getName === 'function' ? wf.getName() : wf.name;
    const storage = typeof wf.isOutputStorageEnabled === 'function' ? wf.isOutputStorageEnabled() : !!truthy(wf.outputStorageEnabled);
    const folder = typeof wf.getOutputFolder === 'function' ? wf.getOutputFolder() : (wf.outputFolder ?? null);
    return {
      ...base,
      workflow: { id: workflowId, name: truthy(name) ? name : `workflow_${workflowId}` },
      agents,
      usedCatalog,
      usedServers,
      startPrompt: strval(coalesce(dig(startNode, 'config', 'prompt'), '')),
      startDocuments: coalesce(dig(startNode, 'config', 'documents'), []),
      outputStorageEnabled: storage,
      outputFolder: folder,
    };
  }

  /** slug => {url, name} for every MCP server the user can call (CodeNodeEmit::slug of the name). */
  async serverIndex(userId: string | null = null): Promise<any> {
    const out = oarr();
    for (const t of await this.loadMcpToolsWithServers(userId)) {
      const url = strval(coalesce(t['server_url'], ''));
      const name = strval(coalesce(t['server_name'], ''));
      if (url !== '' && name !== '') out[serverSlug(name)] = { url, name };
    }
    return out;
  }

  /** Playbook binding ids ("<server slug>.<tool>") over the MCP registry. */
  async availableToolsById(userId: string | null = null): Promise<any> {
    const out = oarr();
    for (const t of await this.loadMcpToolsWithServers(userId)) {
      const surl = strval(coalesce(t['server_url'], ''));
      const tname = strval(coalesce(t['tool_name'], t['name'], ''));
      if (surl === '' || tname === '') continue;
      const slug = serverSlug(strval(coalesce(t['server_name'], '')));
      const schema = coalesce(t['input_schema']);
      out[slug + '.' + tname] = {
        server_url: surl,
        tool: tname,
        description: strval(coalesce(t['tool_description'], t['description'], '')),
        input_schema: schema === null ? stdObj({}) : schema,
      };
    }
    return out;
  }

  /** Global MCP tools plus the user's own, each row with server_name / server_url and input_schema decoded. */
  private async loadMcpToolsWithServers(userId: string | null = null): Promise<any[]> {
    const own = userId !== null && userId !== '';
    const rows = (
      await sql<any>`SELECT t.*, s.name AS server_name, s.url AS server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                WHERE s.enabled = 1 AND (s.user_id IS NULL${own ? sql` OR s.user_id = ${userId}` : sql``})`.execute(this.ex)
    ).rows;
    const out: any[] = [];
    for (const r of rows) {
      const row: any = { ...r };
      const raw = row.input_schema ?? null;
      let schema: any = null;
      if (is_string(raw) && raw !== '') schema = jsonDecodeAssoc(raw);
      else if (raw !== null && typeof raw === 'object' && !Buffer.isBuffer(raw)) schema = deepCopy(raw);   // a JSON column mysql2 parsed
      row.input_schema = schema;
      out.push(row);
    }
    return out;
  }

  /** [usedCatalog, usedServers]: the MCP catalog and servers filtered to the tools the agents use. */
  private async buildToolCatalog(agents: any, userId: string | null = null): Promise<[any, any]> {
    const mcpTools = await this.loadMcpToolsWithServers(userId);
    const serverRegistry = oarr();
    const toolCatalog = oarr();
    for (const t of mcpTools) {
      const surl = strval(coalesce(t['server_url'], ''));
      const sname = strval(coalesce(t['server_name'], ''));
      const tname = strval(coalesce(t['tool_name'], t['name'], ''));
      if (surl === '' || tname === '') continue;
      if (!has(serverRegistry, surl)) serverRegistry[surl] = { name: sname };
      const desc = coalesce(t['tool_description'], t['description'], '');
      const schema = coalesce(t['input_schema']);
      toolCatalog[tname] = { server_url: surl, description: desc, input_schema: schema === null ? stdObj({}) : schema };
    }

    const needed = new Set<string>();
    for (const ag of values(agents)) {
      for (const tool of values(coalesce(dig(ag, 'tools'), []))) {
        let tname: any = null;
        if (is_string(tool)) tname = tool;
        else if (is_array(tool)) tname = coalesce(dig(tool, 'name'), dig(tool, 'tool_name'));
        if (tname !== null && tname !== '') {
          tname = strval(tname);
          if (tname.startsWith('mcp_')) tname = substr(tname, 4);
          needed.add(tname);
        }
      }
    }

    const usedCatalog = oarr();
    for (const [k, v] of entries(toolCatalog)) if (needed.has(k)) usedCatalog[k] = v;
    const usedServers = oarr();
    for (const e of values(usedCatalog)) {
      const surl = coalesce(dig(e, 'server_url'), '');
      if (surl !== '' && has(serverRegistry, surl)) usedServers[surl] = serverRegistry[surl];
    }
    return [usedCatalog, usedServers];
  }
}
