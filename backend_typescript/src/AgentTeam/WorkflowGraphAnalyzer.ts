import { sql } from 'kysely';
import { db } from '../db/pools';
import { WorkflowRepository, WorkflowGraphRepository, phpIntval } from './WorkflowRepository';
import { AgentRepository, agentToArray } from './AgentRepository';

/**
 * WorkflowGraphAnalyzer
 *
 * Faithful TypeScript mirror of src/AgentTeam/Services/WorkflowGraphAnalyzer.php.
 *
 * Shared DSL-analysis front half for workflow compilers (LangGraph, ADK, MAF).
 *
 * Provides:
 *  - static analyzeGraph(graph): pure, DB-free; normalises nodes/edges, builds
 *    adjacency maps, topological order + layers (Kahn's algorithm with cycle
 *    detection), and locates the start node.
 *  - static typeOf(node): canonical node type from any DSL variant.
 *  - static skillsFromConfig(config): ordered skill bindings for an agent node.
 *  - analyze(workflowId, userId?): DB-backed; loads graph, enriches with
 *    agents/tools/servers from the database.
 *
 * Input DSL is the {nodes, edges} shape produced by WorkflowGraphRepository.getGraph().
 * Byte-identical contract to LangGraphGenerator — no reinterpretation of node/edge fields.
 *
 * Return-shape note: byId/children/parents are returned as plain objects (Record<string, T>)
 * to mirror PHP's associative arrays. Unlike PHP, JS objects with purely-numeric string keys
 * (node ids are typically "1", "2", ...) enumerate in ascending numeric order regardless of
 * insertion order — this can never diverge from PHP's insertion order in practice here because
 * node ids are always read `ORDER BY id` (ascending) to begin with, but callers that need a
 * *guaranteed* traversal order should use `order` / `layers` (real arrays), which carry the
 * authoritative sequence and are unaffected by this quirk.
 */

// ---------------------------------------------------------------------------
// Public static: pure graph analysis (no DB, no side effects)
// ---------------------------------------------------------------------------

export interface NormalizedEdge {
  from: string;
  to: string;
}

export interface AnalyzedGraphBase {
  byId: Record<string, any>;
  order: string[];
  edges: NormalizedEdge[];
  children: Record<string, string[]>;
  parents: Record<string, string[]>;
  layers: string[][];
  startNodeId: string;
}

export interface AnalyzedAgent {
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: any;
  max_tokens: any;
  tools: string[];
  skill_content: string;
  skills: Array<Record<string, string>>;
  output_schema_id: any;
  documents: any;
}

export interface AnalyzeResult extends AnalyzedGraphBase {
  workflow: { id: number; name: string };
  agents: Record<string, AnalyzedAgent>;
  usedCatalog: Record<string, any>;
  usedServers: Record<string, any>;
  startPrompt: string;
  startDocuments: any;
  outputStorageEnabled: boolean;
  outputFolder: string | null;
}

/** PHP trim() default charlist: " \t\n\r\0\x0B". */
const PHP_WS = /[ \t\n\r\0\x0B]/;
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.test(s[start])) start++;
  while (end > start && PHP_WS.test(s[end - 1])) end--;
  return s.slice(start, end);
}

/**
 * Mirrors PHP strval(): arrays/objects stringify to the literal "Array" (a real PHP quirk).
 * WorkflowGraphAnalyzer::analyze() applies `array_map('strval', ...)` to the raw tools list
 * pulled from node config verbatim (unlike the agent-fallback path, which extracts names
 * properly) — replicated here for byte fidelity, warts and all.
 */
function phpStrval(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '';
  if (typeof v === 'number') return String(v);
  return 'Array';
}

export class WorkflowGraphAnalyzer {
  constructor(
    private workflowRepo: WorkflowRepository,
    private graphRepo: WorkflowGraphRepository,
    private agentRepo: AgentRepository
  ) {}

  // -------------------------------------------------------------------------
  // Public static: pure graph analysis (no DB, no side effects)
  // -------------------------------------------------------------------------

  /**
   * Pure, DB-free analysis of a {nodes, edges} graph.
   *
   * Accepts all edge-field aliases used across the DSL:
   *   from / from_node_id / source   ->  from
   *   to   / to_node_id   / target   ->  to
   *
   * Topological order + layers use Kahn's algorithm with longest-path level
   * assignment; tie-breaking follows insertion order exactly as PHP arrays do
   * (node order = DB `ORDER BY id`; child visitation order = edge insertion
   * order per parent, also `ORDER BY id`). Throws on cycle / disconnected node.
   */
  static analyzeGraph(graph: { nodes?: any[]; edges?: any[] }): AnalyzedGraphBase {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];

    // Index nodes by string id (Map preserves insertion order; a plain object
    // would silently reorder purely-numeric string keys).
    const byId = new Map<string, any>();
    for (const n of nodes) {
      const id = String(n?.id ?? '');
      if (id === '') continue;
      byId.set(id, n);
    }

    // Normalise edges; build adjacency maps.
    const norm: NormalizedEdge[] = [];
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    for (const id of byId.keys()) {
      children.set(id, []);
      parents.set(id, []);
    }
    for (const e of edges) {
      const from = String(e?.from ?? e?.from_node_id ?? e?.source ?? '');
      const to = String(e?.to ?? e?.to_node_id ?? e?.target ?? '');
      if (from === '' || to === '' || !byId.has(from) || !byId.has(to)) continue;
      norm.push({ from, to });
      children.get(from)!.push(to);
      parents.get(to)!.push(from);
    }

    // Topological layers via Kahn (longest-path level assignment).
    // Each node is assigned the maximum depth over all paths from any root.
    const indeg = new Map<string, number>();
    for (const id of byId.keys()) indeg.set(id, parents.get(id)!.length);

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
    while (queue.length > 0) {
      const id = String(queue.shift());
      order.push(id);
      for (const c of children.get(id) ?? []) {
        level.set(c, Math.max(level.get(c) ?? 0, (level.get(id) ?? 0) + 1));
        const nd = (work.get(c) ?? 0) - 1;
        work.set(c, nd);
        if (nd === 0) queue.push(c);
      }
    }
    if (order.length !== byId.size) {
      throw new Error('Workflow graph has a cycle or disconnected node');
    }

    // Bucket nodes by level (insertion order within a bucket follows `level`'s
    // own insertion order — i.e. the order each node's level was FIRST set,
    // which is a BFS-visitation order, not necessarily `order`'s sequence).
    const layersByLevel = new Map<number, string[]>();
    for (const [id, lv] of level) {
      if (!layersByLevel.has(lv)) layersByLevel.set(lv, []);
      layersByLevel.get(lv)!.push(id);
    }
    const sortedLevels = Array.from(layersByLevel.keys()).sort((a, b) => a - b);
    const layers = sortedLevels.map((lv) => layersByLevel.get(lv)!);

    // Locate start node.
    let startNodeId = '';
    for (const [id, n] of byId) {
      if (WorkflowGraphAnalyzer.typeOf(n) === 'start') {
        startNodeId = id;
        break;
      }
    }

    return {
      byId: Object.fromEntries(byId),
      order,
      edges: norm,
      children: Object.fromEntries(children),
      parents: Object.fromEntries(parents),
      layers,
      startNodeId,
    };
  }

  /**
   * Canonical node type — accepts the DSL fields used across all code paths:
   *   node.node_type, node.type, node.config.type
   *
   * Field precedence mirrors LangGraphGenerator's nodeType(): node_type first.
   */
  static typeOf(n: any): string {
    return String(n?.node_type ?? n?.type ?? n?.config?.type ?? 'agent');
  }

  /**
   * Ordered skill bindings for an agent node's config. Prefers the structured
   * bound_skill (dir-backed, read live from disk at runtime); falls back to the
   * legacy inline skill_content string. Returns [] when the node has no skill.
   * Phase 1 supports one skill; the return is a list so N skills need no change.
   */
  static skillsFromConfig(config: any): Array<Record<string, string>> {
    const out: Array<Record<string, string>> = [];
    const bs = config?.bound_skill ?? null;
    const isBsArray = bs !== null && typeof bs === 'object';
    const dirName = isBsArray ? phpTrim(String(bs.dir_name ?? '')) : '';
    if (isBsArray && dirName !== '') {
      out.push({ dir: dirName });
    } else if (phpTrim(String(config?.skill_content ?? '')) !== '') {
      out.push({ inline: String(config?.skill_content ?? '') });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Public instance: DB-backed full analysis
  // -------------------------------------------------------------------------

  /**
   * Load a workflow from the DB, run analyzeGraph(), and enrich the result
   * with agent details, the MCP tool/server catalog filtered to only tools
   * that agents in this workflow actually use, and start-node metadata.
   */
  async analyze(workflowId: number, _userId: string | null = null): Promise<AnalyzeResult> {
    const wf = await this.workflowRepo.findById(workflowId);
    if (!wf) {
      throw new Error('Workflow not found');
    }
    const graph = await this.graphRepo.getGraph(workflowId);
    const base = WorkflowGraphAnalyzer.analyzeGraph(graph);

    // Build the agents map — only agent/agent-template nodes.
    const agents: Record<string, AnalyzedAgent> = {};
    for (const id of base.order) {
      const n = base.byId[id];
      const ntype = WorkflowGraphAnalyzer.typeOf(n);
      if (ntype !== 'agent' && ntype !== 'agent-template') continue;
      const c = n?.config ?? {};
      // Read agent_id from node root or config, matching LangGraphGenerator.
      const agentId = n?.agent_id ?? c?.agent_id ?? null;
      let tools: any[] = c?.selectedTools ?? c?.tools ?? [];
      if (!Array.isArray(tools)) {
        tools = [];
      }
      // agent_id fallback: when inline tool list is empty, pull tools from
      // the agent DB record — mirrors LangGraphGenerator's agent-data resolution.
      if (agentId !== null && agentId !== '') {
        try {
          const agent = await this.agentRepo.findById(phpIntval(agentId));
          if (agent !== null) {
            const agentArr = agentToArray(agent);
            const agentTools = agentArr.tools ?? null;
            if (tools.length === 0 && agentTools !== null && typeof agentTools === 'object') {
              const iter = Array.isArray(agentTools) ? agentTools : Object.values(agentTools);
              for (const tool of iter) {
                let tname: any = null;
                if (typeof tool === 'string') {
                  tname = tool;
                } else if (tool !== null && typeof tool === 'object') {
                  tname = (tool as any).name ?? (tool as any).tool_name ?? null;
                }
                if (tname) {
                  if (String(tname).indexOf('mcp_') === 0) {
                    tname = String(tname).substring(4);
                  }
                  tools.push(tname);
                }
              }
            }
          }
        } catch (_e) {
          // Swallow: matches PHP's broad except in LangGraphGenerator.
        }
      }
      agents[id] = {
        name: String(c?.agent_name ?? `agent_${id}`),
        systemPrompt: String(c?.systemPrompt ?? c?.instructions ?? ''),
        provider: String(c?.agent_provider ?? c?.provider ?? c?.llm_provider ?? 'claude'),
        model: String(c?.model ?? ''),
        temperature: c?.settings?.temperature ?? null,
        max_tokens: c?.settings?.max_tokens ?? null,
        tools: tools.map(phpStrval),
        skill_content: String(c?.skill_content ?? ''),
        skills: WorkflowGraphAnalyzer.skillsFromConfig(c),
        output_schema_id: c?.output_schema_id ?? null,
        documents: c?.documents ?? [],
      };
    }

    // Resolve empty models to the provider's default (system_llm_settings.model) —
    // the same source LangGraphGenerator uses and the "Default: <name>" the editor
    // shows. A provider-only node (blank model) then compiles to a real model
    // instead of an empty one (which produced e.g. LiteLlm(model="kimi/") at runtime).
    const providerDefaults: Record<string, string> = {};
    try {
      const rows = (
        await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(db)
      ).rows;
      for (const row of rows) {
        providerDefaults[String(row.provider_key ?? '').toLowerCase()] = String(row.model ?? '');
      }
    } catch (_e) {
      // Table missing/unreadable: leave models blank; _make_model raises loudly at runtime.
    }
    for (const aid of Object.keys(agents)) {
      if (String(agents[aid].model ?? '') === '') {
        agents[aid].model = providerDefaults[String(agents[aid].provider).toLowerCase()] ?? '';
      }
    }

    // Reuse the exact same tool/server catalog logic LangGraphGenerator uses.
    const [usedCatalog, usedServers] = await this.buildToolCatalog(agents);

    const startNode = base.byId[base.startNodeId] ?? {};
    const startCfg = startNode?.config ?? {};

    const rawName = wf.name;
    const wfName = rawName === '' || rawName === '0' || rawName == null ? `workflow_${workflowId}` : rawName;

    return {
      ...base,
      workflow: { id: workflowId, name: wfName },
      agents,
      usedCatalog,
      usedServers,
      startPrompt: String(startCfg?.prompt ?? ''),
      startDocuments: startCfg?.documents ?? [],
      // Output-node storage setting: whether to persist the final result and where.
      // The compiled script honours these so its result lands in the same place the
      // browser interpreter uses (the Output node's advertised storage location).
      outputStorageEnabled: wf.outputStorageEnabled,
      outputFolder: wf.outputFolder,
    };
  }

  // -------------------------------------------------------------------------
  // Private: tool/server catalog assembly (lifted from LangGraphGenerator's
  // loadMcpToolsWithServers + catalog-filter logic).
  // -------------------------------------------------------------------------

  /**
   * Fetch MCP tools with server info (url, name, headers), matching
   * the Python loader.list_mcp_tools_with_servers() shape.
   */
  private async loadMcpToolsWithServers(): Promise<any[]> {
    const rows = (
      await sql<any>`
        SELECT t.*, s.name AS server_name, s.url AS server_url
        FROM mcp_server_tools t
        JOIN mcp_servers s ON t.server_id = s.id
        WHERE s.enabled = 1 AND s.user_id IS NULL`.execute(db)
    ).rows;

    const out: any[] = [];
    for (const row of rows) {
      const schemaRaw = row.input_schema ?? null;
      let schema: any = null;
      if (typeof schemaRaw === 'string') {
        if (schemaRaw !== '') {
          try {
            schema = JSON.parse(schemaRaw);
          } catch {
            schema = null;
          }
        }
      } else if (schemaRaw !== null && schemaRaw !== undefined) {
        // mysql2 may already have parsed a JSON column.
        schema = schemaRaw;
      }
      row.input_schema = schema;
      out.push(row);
    }
    return out;
  }

  /**
   * Build the MCP tool/server catalogs filtered to only tools referenced by agents.
   *
   * @param agents  The agents map built by analyze(); each entry has a 'tools' key
   *                (raw names, may include mcp_ prefix).
   * @returns [usedCatalog, usedServers]
   */
  private async buildToolCatalog(
    agents: Record<string, AnalyzedAgent>
  ): Promise<[Record<string, any>, Record<string, any>]> {
    // Load all enabled global MCP tools with their server info.
    const mcpTools = await this.loadMcpToolsWithServers();

    // Build the full server registry and tool catalog (same logic as LangGraphGenerator).
    const serverRegistry: Record<string, any> = {};
    const toolCatalog: Record<string, any> = {};
    for (const t of mcpTools) {
      const surl = String(t.server_url ?? '');
      const sname = String(t.server_name ?? '');
      const tname = String(t.tool_name ?? t.name ?? '');
      if (surl === '' || tname === '') continue;
      if (!Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        serverRegistry[surl] = { name: sname };
      }
      let desc = t.tool_description ?? t.description ?? '';
      if (desc === null || desc === undefined) desc = '';
      let schema = t.input_schema ?? null;
      if (schema === null || schema === undefined) schema = {};
      toolCatalog[tname] = { server_url: surl, description: desc, input_schema: schema };
    }

    // Collect all tool names referenced by agents across the workflow.
    // Strip the mcp_ prefix so names match the catalog keys (same normalisation
    // LangGraphGenerator applies during agent-data resolution).
    const allNeededTools: Record<string, boolean> = {};
    for (const agentEntry of Object.values(agents)) {
      const rawTools = agentEntry.tools ?? [];
      for (const tool of rawTools) {
        let tname: any = null;
        if (typeof tool === 'string') {
          tname = tool;
        } else if (tool !== null && typeof tool === 'object') {
          tname = (tool as any).name ?? (tool as any).tool_name ?? null;
        }
        if (tname !== null && tname !== '') {
          if (String(tname).indexOf('mcp_') === 0) {
            tname = String(tname).substring(4);
          }
          allNeededTools[tname] = true;
        }
      }
    }

    // Filter catalog to only tools actually used by agents.
    const usedCatalog: Record<string, any> = {};
    for (const k of Object.keys(toolCatalog)) {
      if (Object.prototype.hasOwnProperty.call(allNeededTools, k)) {
        usedCatalog[k] = toolCatalog[k];
      }
    }

    // Filter servers to only those whose tools are used.
    const usedServers: Record<string, any> = {};
    for (const entry of Object.values(usedCatalog)) {
      const surl = entry.server_url ?? '';
      if (surl !== '' && Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        usedServers[surl] = serverRegistry[surl];
      }
    }

    return [usedCatalog, usedServers];
  }
}
