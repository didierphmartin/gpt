"""Port of backend/src/AgentTeam/Services/CodeNodeEmit.php.

What the compilers and the server runner need from a code node (spec §2, §5):
validated settings and exit -> children.
"""
from __future__ import annotations

import json
import re

from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.phpcompat import php_empty, php_intval, php_strval, php_trim

_SLUG_RE = re.compile(r'[^a-z0-9]+', re.IGNORECASE)
_PORT_RE = re.compile(r'^output_')


def _json(v) -> str:
    """json_encode() of a scalar/array for an error message (PHP escapes '/')."""
    return json.dumps(v, separators=(',', ':')).replace('/', '\\/')


def _unique_key(v):
    # array_unique() compares the string forms of the values.
    return php_strval(v) if not isinstance(v, (list, dict)) else 'Array'


class CodeNodeEmit:
    EXIT_RE = re.compile(r'^[a-z][a-z0-9_]{0,31}$')

    @staticmethod
    def slug(serverName: str) -> str:
        """The playbook node's server slug rule (LoaderMcpExecutor::slug)."""
        return _SLUG_RE.sub('_', serverName).lower()

    @staticmethod
    def hasCodeNodes(graph: dict) -> bool:
        for n in graph.get('nodes') or []:
            if WorkflowGraphAnalyzer.typeOf(n) == 'code':
                return True
        return False

    @staticmethod
    def refuseUnsupported(graph: dict, target: str) -> None:
        if CodeNodeEmit.hasCodeNodes(graph):
            raise RuntimeError(f"Code nodes are not supported by the {target} target yet. "
                               'Compile this workflow with LangGraph (single file or agents in separate files).')

    @staticmethod
    def nodeData(node: dict, rawEdges: list, slugToUrl: dict, nodeIds: list | None = None) -> dict:
        """rawEdges: the graph's edges with from/from_node_id/source and from_port; slugToUrl: server
        slug -> MCP server URL (the user's registry); nodeIds: the graph's node ids (an edge to any
        other id, dangling, is ignored)."""
        cfg = node.get('config')
        if cfg is None:
            cfg = node.get('data')
        cfg = cfg if isinstance(cfg, dict) else {}
        nid = php_strval(node.get('id') if node.get('id') is not None else '')
        name = php_trim(php_strval(cfg.get('name') if cfg.get('name') is not None else ''))
        display = name if not php_empty(name) else 'Code'

        def fail(why: str):
            raise RuntimeError(f"Code node '{display}' ({nid}): {why}")

        if not php_empty(cfg.get('code_component_missing')):
            raise RuntimeError(f"Code component #{php_strval(cfg.get('code_component_id'))} not found (node {display}).")

        exits = cfg.get('exits') if cfg.get('exits') is not None else ['next']
        if isinstance(exits, dict):
            exits = list(exits.values())
        if (not isinstance(exits, list) or exits == [] or len(exits) > 8
                or len({_unique_key(e) for e in exits}) != len(exits)):
            fail('exits must be 1 to 8 unique names')
        for e in exits:
            if not isinstance(e, str) or not CodeNodeEmit.EXIT_RE.match(e):
                fail('exit names are lowercase letters, digits and _ (got ' + _json(e) + ')')
        # The MCP servers checked on the node (names, as the agent nodes keep them); call_tool may
        # reach any tool on them, by the server's slug.
        names = cfg.get('mcp_servers') if cfg.get('mcp_servers') is not None else []
        if not isinstance(names, (list, dict)):
            fail('mcp_servers must be a list of MCP server names')
        slugs: dict = {}
        servers: dict = {}
        for n in (names.values() if isinstance(names, dict) else names):
            s = CodeNodeEmit.slug(n) if isinstance(n, str) else ''
            if s not in slugToUrl:
                fail('MCP server ' + _json(n) + ' is not one of your MCP servers')
            slugs[s] = True
            servers[slugToUrl[s]] = True
        timeout = cfg.get('timeout_s') if cfg.get('timeout_s') is not None else 30
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 300:
            fail('timeout_s must be 1 to 300 seconds')
        targets = CodeNodeEmit.exitTargets(nid, list(exits), rawEdges, nodeIds)
        # args: a component's settings, or a Start option's Start args (StartOptionGraph); the code reads them as ARGS.
        args = cfg.get('args') if isinstance(cfg.get('args'), (list, dict)) else []
        # arg_decls: the linked component's argument declarations (defaults, required), applied by the harness.
        argDecls = cfg.get('arg_decls') if isinstance(cfg.get('arg_decls'), list) else []
        return {'display': display, 'kind': 'code', 'source': php_strval(cfg.get('code') if cfg.get('code') is not None else ''),
                'exits': list(exits), 'mcp_servers': list(slugs.keys()), 'timeout_s': timeout,
                'exit_targets': targets, 'servers': list(servers.keys()), 'args': args,
                'arg_decls': argDecls}

    @staticmethod
    def exitTargets(nid: str, exits: list, rawEdges: list, nodeIds: list | None = None) -> dict:
        """The port -> exit rule shared by code and playbook nodes: an edge leaving port output_k goes to
        the k-th exit's targets (ports outside the exit list, and dangling edges when nodeIds is given,
        are ignored). Returns exit name -> target node ids (strings)."""
        targets = {e: [] for e in exits}
        known = None if nodeIds is None else {php_strval(i): True for i in nodeIds}
        for e in rawEdges:
            frm = php_strval(_first(e, 'from', 'from_node_id', 'source'))
            to = php_strval(_first(e, 'to', 'to_node_id', 'target'))
            if frm != nid or to == '' or (known is not None and to not in known):
                continue
            port = e.get('from_port') if e.get('from_port') is not None else 'output_1'
            k = php_intval(_PORT_RE.sub('', php_strval(port), count=1))
            if 1 <= k <= len(exits):
                targets[exits[k - 1]].append(to)
        return targets


def _first(d: dict, *keys):
    """`$d[a] ?? $d[b] ?? $d[c] ?? ''`."""
    for k in keys:
        if d.get(k) is not None:
            return d[k]
    return ''
