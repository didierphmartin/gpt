"""Port of backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php (543 lines).

Shared DSL-analysis front half for workflow compilers (LangGraph, ADK, etc.).

Provides:
 - static analyzeGraph(graph: dict) -> dict  -- pure, DB-free; normalises
   nodes/edges, builds adjacency maps, topological layers, and locates the
   start node.
 - static typeOf(node: dict) -> str          -- canonical node type from any
   DSL variant.
 - analyze(workflowId, userId) -> dict       -- DB-backed; loads graph,
   enriches with agents/tools/servers from the database.

Input DSL is the {nodes, edges} shape produced by
WorkflowGraphRepository.getGraph(). Byte-identical contract to
LangGraphGenerator -- no reinterpretation of node/edge fields.
"""
from __future__ import annotations

import re

from app.support.phpcompat import php_coalesce as _coalesce, php_empty, php_intval, php_strval, php_trim
from app.support.phpjson import php_json_decode

# PHP `preg_match('/^\s*(?:#+\s*|\*\*)?Title:\s*(.+?)\s*(?:\*\*)?$/mi', ...)`
# (no `/u` modifier -> ASCII \s, not PCRE_UCP; re.ASCII mirrors that).
_PLAYBOOK_TITLE_RE = re.compile(r'^\s*(?:#+\s*|\*\*)?Title:\s*(.+?)\s*(?:\*\*)?$', re.M | re.I | re.A)


class WorkflowGraphAnalyzer:
    def __init__(self, db, workflowRepo, graphRepo, agentRepo):
        """PHP 24-29 (promoted constructor properties)."""
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo

    # --------------------------------------------------------------------------
    # Public static: pure graph analysis (no DB, no side effects)
    # --------------------------------------------------------------------------

    @staticmethod
    def analyzeGraph(graph: dict) -> dict:
        """PHP 51-145.

        Pure, DB-free analysis of a {nodes, edges} graph.

        Accepts all edge-field aliases used across the DSL:
          from / from_node_id / source  ->  from
          to   / to_node_id   / target  ->  to

        Returns: byId, order (topological, Kahn), edges (normalised),
        children, parents, layers (topological layers; layer 0 = roots),
        startNodeId (id of the first 'start' node found).
        """
        nodes = graph.get('nodes') or []
        edges = graph.get('edges') or []

        # Index nodes by string id.
        byId: dict[str, dict] = {}
        for n in nodes:
            id_ = php_strval(n.get('id'))
            if id_ == '':
                continue
            byId[id_] = n

        # Normalise edges; build adjacency maps.
        norm: list[dict] = []
        children: dict[str, list[str]] = {}
        parents: dict[str, list[str]] = {}
        for id_ in byId:
            children[id_] = []
            parents[id_] = []
        for e in edges:
            from_ = php_strval(_coalesce(e.get('from'), e.get('from_node_id'), e.get('source')))
            to_ = php_strval(_coalesce(e.get('to'), e.get('to_node_id'), e.get('target')))
            if from_ == '' or to_ == '' or from_ not in byId or to_ not in byId:
                continue
            norm.append({'from': from_, 'to': to_})
            children[from_].append(to_)
            parents[to_].append(from_)

        # Topological layers via Kahn (longest-path level assignment).
        # Each node is assigned the maximum depth over all paths from any root.
        indeg: dict[str, int] = {}
        for id_ in byId:
            indeg[id_] = len(parents[id_])
        level: dict[str, int] = {}
        queue: list[str] = []
        for id_, d in indeg.items():
            if d == 0:
                queue.append(id_)
                level[id_] = 0
        order: list[str] = []
        work = dict(indeg)
        while queue:
            id_ = queue.pop(0)
            order.append(id_)
            for c in children[id_]:
                level[c] = max(level.get(c) or 0, (level.get(id_) or 0) + 1)
                work[c] -= 1
                if work[c] == 0:
                    queue.append(c)

        if len(order) != len(byId):
            raise RuntimeError('Workflow graph has a cycle or disconnected node')

        layers_map: dict[int, list[str]] = {}
        for id_, lv in level.items():
            layers_map.setdefault(lv, []).append(id_)
        layers = [layers_map[k] for k in sorted(layers_map.keys())]

        # Locate start node.
        startNodeId = ''
        for id_, n in byId.items():
            if WorkflowGraphAnalyzer.typeOf(n) == 'start':
                startNodeId = id_
                break

        return {
            'byId': byId,
            'order': order,
            'edges': norm,
            'children': children,
            'parents': parents,
            'layers': layers,
            'startNodeId': startNodeId,
        }

    @staticmethod
    def typeOf(n: dict) -> str:
        """PHP 153-164.

        Canonical node type -- accepts the DSL fields used across all code
        paths: node['node_type'], node['type'], node['config']['type'].
        Field precedence mirrors LangGraphGenerator::nodeType(): node_type
        first.
        """
        config = n.get('config')
        config_type = config.get('type') if isinstance(config, dict) else None
        for t in (n.get('node_type'), n.get('type'), config_type):
            if t is not None and php_strval(t) != '':
                return php_strval(t)
        return 'agent'

    @staticmethod
    def docNodesFromAnalyzed(analyzed: dict, extra: dict | None = None,
                              runnable: list[str] | None = None) -> list[dict]:
        """PHP 185-197.

        docNodes() over an analyze()-shaped array. Hand-built fixtures
        (tests) may carry only 'agents': the graph is then reconstructed
        from them.
        """
        if extra is None:
            extra = {}
        if runnable is None:
            runnable = ['start', 'agent', 'agent-template', 'output']
        agents = analyzed.get('agents') or {}
        byId = dict(analyzed.get('byId') or {})
        if byId == {}:
            for id_, ag in agents.items():
                id_s = php_strval(id_)
                byId[id_s] = {'id': id_s, 'config': {'type': 'agent', 'agent_name': _coalesce(ag.get('name'), f'agent_{id_s}')}}
        order = analyzed.get('order')
        if order is None:
            order = list(byId.keys())
        return WorkflowGraphAnalyzer.docNodes(byId, order, analyzed.get('edges') or [], agents, extra, runnable)

    @staticmethod
    def docNodes(byId: dict, order: list, edges: list, agents: dict,
                 extra: dict | None = None, runnable: list[str] | None = None) -> list[dict]:
        """PHP 199-258."""
        if extra is None:
            extra = {}
        if runnable is None:
            runnable = ['start', 'agent', 'agent-template', 'output']
        agents = agents or {}

        children: dict[str, list[str]] = {}
        parents: dict[str, list[str]] = {}
        for e in edges:
            f = php_strval(_coalesce(e.get('from'), e.get('from_node_id')))
            t = php_strval(_coalesce(e.get('to'), e.get('to_node_id')))
            if f == '' or t == '':
                continue
            children.setdefault(f, []).append(t)
            parents.setdefault(t, []).append(f)

        def nameOf(id_: str) -> str:
            n = byId.get(id_) or {}
            c = n.get('config') if isinstance(n.get('config'), dict) else {}
            t = WorkflowGraphAnalyzer.typeOf(n)
            if t == 'start':
                return 'Start'
            if t == 'output':
                return 'Output'
            ag_entry = agents.get(id_)
            name = php_strval(_coalesce(
                ag_entry.get('name') if isinstance(ag_entry, dict) else None,
                c.get('agent_name'), c.get('name'), n.get('name'),
            ))
            return name if name != '' else f'node_{id_}'

        def label(id_: str) -> str:
            return nameOf(id_) + f' ({id_})'

        def _tool_name(x) -> str:
            if isinstance(x, dict):
                v = _coalesce(x.get('name'), '')
            else:
                v = x
            return php_strval(v)

        def _skill_label(s):
            if isinstance(s, dict):
                d = s.get('dir')
                if d is not None:
                    return d
                if s.get('inline') is not None:
                    return 'inline skill'
            return 'skill'

        out: list[dict] = []
        for raw_id in order:
            id_ = php_strval(raw_id)
            n = byId.get(id_) or {}
            c = n.get('config') if isinstance(n.get('config'), dict) else {}
            t = WorkflowGraphAnalyzer.typeOf(n)
            ag = agents.get(id_)
            settings = c.get('settings') if isinstance(c.get('settings'), dict) else None

            tools_raw = ag.get('tools') if isinstance(ag, dict) else None
            if tools_raw is None:
                tools_raw = []
            tools = [_tool_name(x) for x in (list(tools_raw.values()) if isinstance(tools_raw, dict) else tools_raw)]

            skills_raw = ag.get('skills') if isinstance(ag, dict) else None
            if skills_raw is None:
                skills_raw = WorkflowGraphAnalyzer.skillsFromConfig(c)
            skills = [_skill_label(s) for s in (list(skills_raw.values()) if isinstance(skills_raw, dict) else skills_raw)]

            d = {
                'id': id_, 'type': t, 'name': nameOf(id_),
                'provider': php_strval(_coalesce(
                    ag.get('provider') if isinstance(ag, dict) else None,
                    c.get('agent_provider'), c.get('provider'), c.get('llm_provider'),
                )),
                'model': php_strval(_coalesce(
                    ag.get('model') if isinstance(ag, dict) else None, c.get('model'),
                )),
                'temperature': _coalesce(
                    ag.get('temperature') if isinstance(ag, dict) else None,
                    settings.get('temperature') if settings else None,
                ),
                'max_tokens': _coalesce(
                    ag.get('max_tokens') if isinstance(ag, dict) else None,
                    settings.get('max_tokens') if settings else None,
                ),
                'thinking': _coalesce(
                    ag.get('thinking') if isinstance(ag, dict) else None,
                    settings.get('thinking') if settings else None,
                ),
                'tools': tools,
                'skills': skills,
                'dispatch': [], 'playbook': None,
                'supported': t in runnable,
                'parents': [label(p) for p in (parents.get(id_) or [])],
                'children': [label(ch) for ch in (children.get(id_) or [])],
                'prompt': php_strval(c.get('prompt')) if t == 'start' else '',
            }
            if t in ('start', 'output'):
                d['provider'] = ''
                d['model'] = ''
                d['temperature'] = None
                d['max_tokens'] = None
                d['thinking'] = None

            x = extra.get(id_) if isinstance(extra, dict) else None
            x = x if isinstance(x, dict) else {}
            if x.get('dispatch') is not None:
                dispatch_raw = x['dispatch']
                d['dispatch'] = list(dispatch_raw.values()) if isinstance(dispatch_raw, dict) else list(dispatch_raw)
            elif t in ('agent', 'agent-template') and php_strval(c.get('agent_type')) == 'dispatcher':
                filtered = [ch for ch in (children.get(id_) or [])
                            if WorkflowGraphAnalyzer.typeOf(byId.get(ch) or {}) in ('agent', 'agent-template', 'playbook')]
                d['dispatch'] = [nameOf(ch) for ch in filtered]

            if t == 'playbook':
                text = c.get('playbook') if isinstance(c.get('playbook'), str) else ''
                m = _PLAYBOOK_TITLE_RE.search(text)
                title = php_trim(m.group(1)) if m else ''
                x_playbook = x.get('playbook')
                x_playbook = x_playbook if isinstance(x_playbook, dict) else {}
                defaults = {'title': title, 'writes': not php_empty(c.get('writes_enabled')), 'bound': None, 'unbound': None}
                d['playbook'] = {**defaults, **x_playbook}

            out.append(d)
        return out

    @staticmethod
    def skillsFromConfig(config: dict) -> list[dict]:
        """PHP 266-276.

        Ordered skill bindings for an agent node's config. Prefers the
        structured bound_skill (dir-backed, read live from disk at
        runtime); falls back to the legacy inline skill_content string.
        Returns [] when the node has no skill. Phase 1 supports one skill;
        the return is a list so N skills need no change.
        """
        out: list[dict] = []
        bs = config.get('bound_skill')
        if isinstance(bs, dict) and php_trim(php_strval(bs.get('dir_name'))) != '':
            out.append({'dir': php_trim(php_strval(bs.get('dir_name')))})
        elif php_trim(php_strval(config.get('skill_content'))) != '':
            out.append({'inline': php_strval(config.get('skill_content'))})
        return out

    # --------------------------------------------------------------------------
    # Public instance: DB-backed full analysis
    # --------------------------------------------------------------------------

    def analyze(self, workflowId: int, userId: str | None = None) -> dict:
        """PHP 303-410.

        Load a workflow from the DB, run analyzeGraph(), and enrich the
        result with agent details, the MCP tool/server catalog filtered to
        only tools that agents in this workflow actually use, and
        start-node metadata.
        """
        wf = self.workflowRepo.findById(workflowId)
        if not wf:
            raise RuntimeError('Workflow not found')
        graph = self.graphRepo.getGraph(workflowId)
        base = self.analyzeGraph(graph)

        # Build the agents map -- only agent/agent-template nodes.
        agents: dict[str, dict] = {}
        for id_ in base['order']:
            n = base['byId'][id_]
            if self.typeOf(n) not in ('agent', 'agent-template'):
                continue
            c = n.get('config') if isinstance(n.get('config'), dict) else {}
            # Read agent_id from node root or config, matching LangGraphGenerator line 350.
            agentId = _coalesce(n.get('agent_id'), c.get('agent_id'))
            tools = _coalesce(c.get('selectedTools'), c.get('tools'))
            if isinstance(tools, dict):
                tools = list(tools.values())
            elif not isinstance(tools, list):
                tools = []
            # agent_id fallback: when inline tool list is empty, pull tools from
            # the agent DB record -- mirrors LangGraphGenerator lines 380-416.
            if agentId is not None and agentId != '':
                try:
                    agent = self.agentRepo.findById(php_intval(agentId))
                    if agent is not None:
                        agentArr = agent.toArray()
                        agentTools = agentArr.get('tools')
                        if php_empty(tools) and isinstance(agentTools, list):
                            for tool in agentTools:
                                tname = None
                                if isinstance(tool, str):
                                    tname = tool
                                elif isinstance(tool, dict):
                                    tname = _coalesce(tool.get('name'), tool.get('tool_name'))
                                if tname:
                                    if tname.startswith('mcp_'):
                                        tname = tname[4:]
                                    tools.append(tname)
                except Exception:
                    # Swallow: matches Python's broad except in LangGraphGenerator.
                    pass

            settings = c.get('settings') if isinstance(c.get('settings'), dict) else {}
            thinking_raw = settings.get('thinking')
            agents[id_] = {
                'name': php_strval(_coalesce(c.get('agent_name'), f'agent_{id_}')),
                'systemPrompt': php_strval(_coalesce(c.get('systemPrompt'), c.get('instructions'), '')),
                'provider': php_strval(_coalesce(c.get('agent_provider'), c.get('provider'), c.get('llm_provider'), 'claude')),
                'model': php_strval(c.get('model')),
                'temperature': settings.get('temperature'),
                'max_tokens': settings.get('max_tokens'),
                # Per-agent Thinking switch ('on'|'off'|None=provider default) --
                # the node form attribute added 2026-07-17; compile targets
                # honor it the same way AgentRunner/providers do in-platform.
                'thinking': thinking_raw if thinking_raw in ('on', 'off') else None,
                'tools': [php_strval(t) for t in tools],
                'skill_content': php_strval(c.get('skill_content')),
                'skills': self.skillsFromConfig(c),
                'output_schema_id': c.get('output_schema_id'),
                'documents': _coalesce(c.get('documents'), []),
            }

        # Resolve empty models to the provider's default (system_llm_settings.model) --
        # the same source LangGraphGenerator uses and the "Default: <name>" the editor
        # shows. A provider-only node (blank model) then compiles to a real model
        # instead of an empty one (which produced e.g. LiteLlm(model="kimi/") at runtime).
        providerDefaults: dict[str, str] = {}
        try:
            for rowP in self.db.fetch_all("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1"):
                providerDefaults[php_strval(rowP.get('provider_key')).lower()] = php_strval(rowP.get('model'))
        except Exception:
            # Table missing/unreadable: leave models blank; _make_model raises loudly at runtime.
            pass
        for aid, ag in agents.items():
            if php_strval(ag.get('model')) == '':
                agents[aid]['model'] = providerDefaults.get(php_strval(ag.get('provider')).lower(), '')

        # Reuse the exact same tool/server catalog logic LangGraphGenerator uses.
        usedCatalog, usedServers = self._buildToolCatalog(agents, userId)

        startNode = base['byId'].get(base['startNodeId']) or {}
        startConfig = startNode.get('config') if isinstance(startNode.get('config'), dict) else {}
        result = dict(base)
        result.update({
            'workflow': {'id': workflowId, 'name': (wf.getName() if not php_empty(wf.getName()) else f'workflow_{workflowId}')},
            'agents': agents,
            'usedCatalog': usedCatalog,
            'usedServers': usedServers,
            'startPrompt': php_strval(startConfig.get('prompt')),
            'startDocuments': _coalesce(startConfig.get('documents'), []),
            # Output-node storage setting: whether to persist the final result and where.
            # The compiled script honours these so its result lands in the same place the
            # browser interpreter uses (the Output node's advertised storage location).
            'outputStorageEnabled': wf.isOutputStorageEnabled(),
            'outputFolder': wf.getOutputFolder(),
        })
        return result

    # --------------------------------------------------------------------------
    # Private: tool/server catalog assembly (lifted verbatim from
    # LangGraphGenerator::loadMcpToolsWithServers + the catalog-filter block in
    # LangGraphGenerator::generate, lines ~220-244 and ~305-548).
    # --------------------------------------------------------------------------

    def _loadMcpToolsWithServers(self, userId: str | None = None) -> list[dict]:
        """PHP 424-456 (`private function loadMcpToolsWithServers`).

        Fetch MCP tools with server info (url, name, headers), matching the
        Python loader.list_mcp_tools_with_servers() shape.

        Global servers plus the caller's own registrations -- the registry
        chat and the browser runner see (mirrors LangGraphGenerator). The
        PHP source builds this via `$this->db->prepare()->execute()`; the
        backend_python `Db` wrapper collapses that into one `fetch_all()`
        call (see WorkflowRepository/AgentRepository for the established
        convention), so this ports as a single parameterised query.
        """
        sql = ("SELECT t.*, s.name AS server_name, s.url AS server_url\n"
               "                FROM mcp_server_tools t\n"
               "                JOIN mcp_servers s ON t.server_id = s.id\n"
               "                WHERE s.enabled = 1 AND (s.user_id IS NULL"
               + (" OR s.user_id = :uid" if userId is not None and userId != '' else '')
               + ")")
        params = {'uid': userId} if userId is not None and userId != '' else {}
        rows = self.db.fetch_all(sql, params)

        out: list[dict] = []
        for row in rows:
            row = dict(row)
            schemaRaw = row.get('input_schema')
            schema = None
            if isinstance(schemaRaw, str) and schemaRaw != '':
                # ASSOCIATIVE decode is load-bearing: the generators walk the
                # schema with is_array() checks -- an object decode made every
                # check fail, silently stripping ALL tool parameters from the
                # ADK/MAF exports (models called search tools with keywords
                # that never reached the MCP server: "keyword parameter is
                # required" despite a correct call).
                schema = php_json_decode(schemaRaw)
            row['input_schema'] = schema
            out.append(row)
        return out

    def _buildToolCatalog(self, agents: dict, userId: str | None = None) -> tuple[dict, dict]:
        """PHP 469-542 (`private function buildToolCatalog`).

        Build the MCP tool/server catalogs filtered to only tools
        referenced by agents. `agents` is the map built by analyze(); each
        entry has a 'tools' key (raw names, may include mcp_ prefix).
        Returns (usedCatalog, usedServers).
        """
        # Load the enabled MCP tools (global + the user's own) with their server info.
        mcpTools = self._loadMcpToolsWithServers(userId)

        # Build the full server registry and tool catalog (same logic as LangGraphGenerator).
        serverRegistry: dict[str, dict] = {}
        toolCatalog: dict[str, dict] = {}
        for t in mcpTools:
            surl = php_strval(t.get('server_url'))
            sname = php_strval(t.get('server_name'))
            tname = php_strval(_coalesce(t.get('tool_name'), t.get('name')))
            if surl == '' or tname == '':
                continue
            if surl not in serverRegistry:
                serverRegistry[surl] = {'name': sname}
            desc = t.get('tool_description')
            if desc is None:
                desc = t.get('description')
            if desc is None:
                desc = ''
            schema = t.get('input_schema')
            if schema is None:
                schema = {}
            toolCatalog[tname] = {
                'server_url': surl,
                'description': desc,
                'input_schema': schema,
            }

        # Collect all tool names referenced by agents across the workflow.
        # Strip the mcp_ prefix so names match the catalog keys (same normalisation
        # LangGraphGenerator applies during agent-data resolution).
        allNeededTools: dict[str, bool] = {}
        for agentEntry in agents.values():
            rawTools = agentEntry.get('tools') or []
            for tool in rawTools:
                if isinstance(tool, str):
                    tname = tool
                elif isinstance(tool, dict):
                    tname = _coalesce(tool.get('name'), tool.get('tool_name'))
                else:
                    tname = None
                if tname is not None and tname != '':
                    if tname.startswith('mcp_'):
                        tname = tname[4:]
                    allNeededTools[tname] = True

        # Filter catalog to only tools actually used by agents.
        usedCatalog: dict[str, dict] = {}
        for k, v in toolCatalog.items():
            if k in allNeededTools:
                usedCatalog[k] = v

        # Filter servers to only those whose tools are used.
        usedServers: dict[str, dict] = {}
        for entry in usedCatalog.values():
            surl = entry.get('server_url') or ''
            if surl != '' and surl in serverRegistry:
                usedServers[surl] = serverRegistry[surl]

        return usedCatalog, usedServers
