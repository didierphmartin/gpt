"""Port of backend/src/AgentTeam/Services/CompiledRuntimeEmit.php.

The runtime pieces the ADK, MAF and NOOA compile targets share (LangGraph has its own): the run-time facts
an analysis needs (code nodes, MCP server slugs, decision routing, the Start's mode), the MCP client with
per-server headers, the code-node harness, run recording, the package listener, the agents-in-separate-files
layout, code-node and decision literals. Reusable by the Python ADK/MAF/NOOA generators.
"""
from __future__ import annotations

import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.compiler_php import ascii_translit, j, json_to_python, obj, py_str
from app.agent_team.services.compiler_text import compiled_runtime_emit as T
from app.agent_team.services.dispatcher_decision_facts import DispatcherDecisionFacts
from app.agent_team.services.lang_graph_runtime import CODE_HARNESS_PATH, LangGraphRuntime
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.start_trigger_facts import StartTriggerFacts
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.phpcompat import php_strval


def _first(*values):
    for v in values:
        if v is not None:
            return v
    return None


class CompiledRuntimeEmit:
    @staticmethod
    def analyzeRuntime(analyzed: dict, analyzer, db, agentRepo, graphRaw: dict, workflowId: int,
                       userId: str | None) -> dict:
        """The analysis plus what the compiled runtime needs: code nodes, MCP server slugs, each dispatcher's
        decision routing and the Start's mode (StartTriggerFacts). analyzed['playbooks'] must be set."""
        analyzed = dict(analyzed)
        index = analyzer.serverIndex(userId)   # slug => {url, name}: the user's MCP servers
        slugToUrl = {k: v['url'] for k, v in index.items()}
        analyzed['code'] = {}
        for nid in analyzed['order']:   # analyzeGraph()'s topological order
            node = (analyzed.get('byId') or {}).get(nid)
            if node is not None and WorkflowGraphAnalyzer.typeOf(node) == 'code':
                analyzed['code'][php_strval(nid)] = CodeNodeEmit.nodeData(node, graphRaw.get('edges') or [], slugToUrl,
                                                                          list((analyzed.get('byId') or {}).keys()))
        urlName: dict = {}
        for surl, meta in (analyzed.get('usedServers') or {}).items():
            urlName.setdefault(php_strval(surl), {})[CodeNodeEmit.slug(php_strval(_first(meta.get('name'), '')))] = \
                php_strval(_first(meta.get('name'), ''))
        for pd in analyzed['playbooks'].values():
            for a in pd['actions']:
                if (a.get('kind') or '') == 'mcp':
                    slg = CodeNodeEmit.slug(php_strval(a['target']).split('.', 1)[0])
                    urlName.setdefault(php_strval(a['server_url']), {})[slg] = (index.get(slg) or {}).get('name', slg)
        for cd in analyzed['code'].values():
            for slg in cd['mcp_servers']:
                urlName.setdefault(index[slg]['url'], {})[slg] = index[slg]['name']
        analyzed['serverSlugs'] = CompiledRuntimeEmit.serverSlugs(urlName)
        analyzed['decisions'] = {}
        for did in WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']:
            analyzed['decisions'][php_strval(did)] = DispatcherDecisionFacts.of(
                db, agentRepo, analyzed['byId'][did], php_strval(analyzed['workflow']['name']))
        ordered = [{'id': php_strval(i), **{k: v for k, v in analyzed['byId'][i].items() if k != 'id'}}
                   for i in analyzed['order']]
        for k, v in StartTriggerFacts.of(db, workflowId, ordered, analyzed['serverSlugs']).items():
            if k not in analyzed:   # $analyzed += ...
                analyzed[k] = v
        return analyzed

    @staticmethod
    def mcpClientBlock(analyzed: dict) -> str:
        """MCP_SERVER_SLUGS / MCP_SLUGS and the MCP client with per-server headers (MCP_HEADERS_<SLUG>)."""
        slugs = analyzed.get('serverSlugs') or {}
        head = ('MCP_SERVER_SLUGS = ' + ('{}' if not slugs else json_to_python(slugs, True))
                + '   # registered URL -> slug: MCP_HEADERS_<SLUG> / MCP_URL_<SLUG> in .env\n'
                + 'MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}   # slug -> URL (a code node\'s call_tool)\n\n')
        return head + T.mcpClientBlock__ret

    @staticmethod
    def codeHarnessBlock(package: bool) -> str:
        """The code-node harness: imported from the package's code_harness.py, or embedded in a single file."""
        if package:
            load = 'import code_harness as CODE_HARNESS   # code_harness.py in this folder\n\n\n'
        else:
            try:
                with open(CODE_HARNESS_PATH, encoding='utf-8', newline='') as f:
                    src = f.read()
            except OSError:
                raise RuntimeError('code node harness not found (frontend/assets/py/code_node_harness.py)')
            load = ("import types as types_module   # google.genai's `types` already holds the name\n"
                    + 'CODE_HARNESS_SOURCE = ' + j(src) + '\n'
                    + 'CODE_HARNESS = types_module.ModuleType("code_node_harness")\n'
                    + 'exec(CODE_HARNESS_SOURCE, CODE_HARNESS.__dict__)\n\n\n')
        return (load
                + 'def _code_transport(server: str, tool: str, args: dict) -> dict:\n'
                + '    """call_tool\'s transport: the raw MCP result of server.tool(args)."""\n'
                + '    url = MCP_SLUGS.get(server)\n'
                + '    if not url:\n'
                + '        return {"isError": True, "content": [{"type": "text", "text": f"MCP server {server!r} is not in this workflow"}]}\n'
                + '    return _call_mcp_tool_raw(url, tool, args)\n')

    @classmethod
    def recordingBlock(cls, analyzed: dict, agentCallbacks: bool = False) -> str:
        """NODE_META / START_NODE / DISPATCHER_IDS / OUTPUT_NODE_KEYS and the run-recording helpers."""
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        routed: dict = {}
        for did, targets in menus.items():
            for t in targets:
                if cls.menuNestable(analyzed, php_strval(t['id'])):
                    routed[php_strval(did)] = True   # a _DispatcherAgent stands for this node
        meta: dict = {}
        outputs = []
        start = None
        for i in analyzed.get('order') or []:
            i = php_strval(i)
            typ = WorkflowGraphAnalyzer.typeOf((analyzed.get('byId') or {}).get(i) or {})
            name = cls.displayName(analyzed, i)
            if typ == 'start':
                if start is None:
                    start = [i, 'Start' if name == i else name]
            elif i in (analyzed.get('code') or {}):
                meta[f'node_{i}'] = [i, 'code', name]
            elif i in (analyzed.get('playbooks') or {}):
                meta[f'node_{i}'] = [i, 'playbook', name]
            elif typ == 'output':
                meta[f'node_{i}'] = [i, 'output', 'Output' if name == i else name]
                outputs.append(f'node_{i}')
            elif i in (analyzed.get('agents') or {}) and i not in routed:
                meta[f'node_{i}'] = [i, 'agent', name]
        metaPy = '{}' if not meta else json_to_python(meta)
        startPy = 'None' if start is None else '[' + py_str(start[0]) + ', ' + py_str(start[1]) + ']'
        outPy = '[' + ', '.join(py_str(o) for o in outputs) + ']'
        return (f'NODE_META = {metaPy}   # agent name -> [node id, type, canvas name]: the nodes whose runs are recorded\n'
                + f'START_NODE = {startPy}   # [id, name] of the Start node\n'
                + 'DISPATCHER_IDS = [' + ', '.join(py_str(php_strval(k)) for k in routed)
                + ']   # dispatchers record themselves; their choice is work (not a quiet poll)\n'
                + f"OUTPUT_NODE_KEYS = {outPy}   # the Output nodes: their answers are the workflow's answer\n"
                + T.recordingBlock__ret
                + ('\n\n\n' + T.recordingBlock__ret_2 if agentCallbacks else ''))

    CLI_HOOKS_SILENT = T._class__CLI_HOOKS_SILENT

    @classmethod
    def packageListenBlock(cls, cliHooks: str | None = None) -> str:
        """The package's listener: the Start's cron / watch loop, the CLI hooks, make_listener()."""
        if cliHooks is None:
            cliHooks = cls.CLI_HOOKS_SILENT
        return (T.packageListenBlock__head.replace('{CLI_HOOKS}', cliHooks) + LangGraphRuntime.cronBlock() + '\n\n'
                + LangGraphRuntime.watchBlock() + '\n\n' + LangGraphRuntime.listenerBlock() + '\n\n' + T.packageListenBlock__tail)

    @staticmethod
    def moduleLayout(analyzed: dict) -> dict:
        """Agents in separate files: node id => {name, file, module, display}, in the analysis order."""
        used = {'common': True, 'workflow': True, 'agents': True}
        out: dict = {}
        for nid in analyzed.get('order') or []:
            nid = php_strval(nid)
            display = _first(((analyzed.get('code') or {}).get(nid) or {}).get('display'),
                             ((analyzed.get('playbooks') or {}).get(nid) or {}).get('display'),
                             ((analyzed.get('agents') or {}).get(nid) or {}).get('name'))
            if display is None:
                continue
            display = php_strval(display)
            ascii_ = ascii_translit(display)
            for ch in ("'", '"', '`', '^', '~'):
                ascii_ = ascii_.replace(ch, '')
            slug = re.sub(r'[^a-z0-9]+', '-', ascii_, flags=re.IGNORECASE).strip('-').lower()
            name = (slug if slug != '' else 'node')[:40].replace('-', '_')
            if not re.match(r'^[a-z_][a-z0-9_]*$', name) or name in used:
                name = f'node_{nid}_{name}'
            used[name] = True
            out[nid] = {'name': name, 'file': f'agents/{name}.py', 'module': f'agents.{name}', 'display': display}
        return out

    @classmethod
    def tablePackage(cls, analyzed: dict, common: list, assembly: list, tables: dict, preludes: dict,
                     title: str, nodeRole: str, runtimeRole: str) -> list:
        """A table-driven package: [workflow.py, common.py, [agents/ files]]. tables: VAR => [TABLE, {nid: literal}];
        preludes: nid => the module's own code ahead of its table entries."""
        layout = cls.moduleLayout(analyzed)
        wfName = json_encode_unicode(php_strval(analyzed['workflow']['name']))
        q = '"""'
        files = [{'path': 'agents/__init__.py', 'code': f"{q}The workflow's nodes, one module each (imported by workflow.py).{q}\n"}]
        imports = []
        fills: dict = {}
        for nid, m in layout.items():
            body = [preludes[nid]] if nid in preludes else []
            for var, (table, literals) in tables.items():
                if nid in literals:
                    body.append(f'{var} = ' + literals[nid] + f'   # {table}["{nid}"]')
                    fills.setdefault(table, []).append('    ' + py_str(php_strval(nid)) + f': _node_{nid}.{var},')
            if not body:
                continue
            display = m['display'].replace(q, "'''").replace('\n', ' ')
            files.append({'path': m['file'], 'code': f'{q}Node {nid} ({display}) of the workflow {wfName}: {nodeRole}.\n\n'
                          + f'Imported by workflow.py. To change the node, edit the workflow in the editor and re-generate.{q}\n'
                          + 'from common import *  # noqa: F401,F403 -- the runtime\n\n\n'
                          + '\n\n\n'.join(body) + '\n'})
            imports.append(f"from agents import {m['name']} as _node_{nid}  # {display}")
        fill = ''
        for table, lines in fills.items():
            fill += f'{table}.update({{\n' + '\n'.join(lines) + '\n})\n'
        workflow = (f'{q}Workflow {wfName} -- {title}, agents in separate files.\n\n'
                    + f'common.py holds the runtime ({runtimeRole}), agents/ one module per node; this file fills the node\n'
                    + f"tables, then builds and runs the workflow: run_workflow(), the Start's listener and the CLI.\n{q}\n"
                    + 'from common import *  # noqa: F401,F403 -- the runtime\n'
                    + '\n'.join(imports) + '\n\n'
                    + fill + '\n\n'
                    + '\n\n'.join(assembly) + '\n')
        return [workflow, cls.packageCommonWithRuntime(common), files]

    @classmethod
    def packageCommonWithRuntime(cls, runtimeParts: list) -> str:
        """common.py of a package: the runtime's head, the run server's shared pieces, the rest of the runtime."""
        parts = list(runtimeParts)
        head = parts.pop(0) if parts else None
        server = re.sub(r'\A"""[^\n]*"""\n', '', cls.packageCommonBlock())   # its docstring: the runtime's comes first
        return ((head if head is not None else '') + '\n' + server + '\n' + '\n'.join(parts) + '\n\n'
                + '__all__ = [n for n in dir() if not n.startswith("__")]   # agents/ and workflow.py import it all (_ names too)\n')

    @staticmethod
    def packageCommonBlock() -> str:
        return ('"""Shared by workflow.py and api.py: the event sink, run records (runs/), the live feed (GET /live), the console view."""\n'
                + 'import json, os, re, threading, time, uuid\n'
                + 'from datetime import datetime\n'
                + 'from typing import Callable\n\n'
                + PythonEmitHelpers.eventSinkBlock() + '\n\n'
                + LangGraphRuntime.runRecordBlock() + '\n\n'
                + LangGraphRuntime.liveFeedBlock() + '\n\n'
                + LangGraphRuntime.consoleBlock() + '\n')

    @staticmethod
    def serverSlugs(urlName: dict) -> dict:
        """URL => slug of the MCP servers a compile uses; two used servers on one URL, or two URLs one slug, is an error."""
        out: dict = {}
        owner: dict = {}
        for url, names in urlName.items():
            names = {s: n for s, n in names.items() if s != ''}
            if not names:
                continue
            if len(names) > 1:
                n = list(names.values())
                raise RuntimeError('MCP servers "' + n[0] + '" and "' + n[1] + '" share the URL ' + php_strval(url)
                                   + '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                                   + ' server instance on its own URL and register that.')
            slug = php_strval(next(iter(names)))
            if slug in owner and owner[slug] != url:
                raise RuntimeError('Two MCP servers both map to MCP_HEADERS_' + slug.upper()
                                   + '; rename one so each server has its own header variable.')
            owner[slug] = php_strval(url)
            out[php_strval(url)] = slug
        return out

    @staticmethod
    def displayName(analyzed: dict, id_: str) -> str:
        cfg = (((analyzed.get('byId') or {}).get(id_) or {}).get('config')) or {}
        cfg = cfg if isinstance(cfg, dict) else {}
        own = php_strval(_first(cfg.get('name'), cfg.get('agent_name'), '')).strip(' \t\n\r\x00\x0b')
        return php_strval(_first(((analyzed.get('code') or {}).get(id_) or {}).get('display'),
                                 ((analyzed.get('agents') or {}).get(id_) or {}).get('name'),
                                 ((analyzed.get('playbooks') or {}).get(id_) or {}).get('display'),
                                 own if own != '' else id_))

    @staticmethod
    def menuNestable(analyzed: dict, cid: str) -> bool:
        return cid in (analyzed.get('agents') or {}) or cid in (analyzed.get('code') or {})

    @classmethod
    def codeNodeLiterals(cls, analyzed: dict) -> dict:
        return {php_strval(i): json_to_python(cls._codeNodeEntry(analyzed, php_strval(i), cd))
                for i, cd in (analyzed.get('code') or {}).items()}

    @staticmethod
    def _codeNodeEntry(analyzed: dict, id_: str, cd: dict) -> dict:
        from app.agent_team.services.compiled_package import CompiledPackage
        entry = {'display': cd['display'], 'exits': cd['exits'], 'mcp_servers': cd['mcp_servers'],
                 'timeout_s': cd['timeout_s'],
                 'exit_targets': obj({k: [php_strval(x) for x in ids] for k, ids in cd['exit_targets'].items()}),
                 'args': obj(_first(cd.get('args'), []))}
        if analyzed.get('package'):
            entry['source_file'] = CompiledPackage.codePath(analyzed, id_)   # code/<file>, read at each run
        else:
            entry['source'] = cd['source']
        return entry

    @classmethod
    def codeNodesLiteral(cls, analyzed: dict) -> str:
        out = {php_strval(i): cls._codeNodeEntry(analyzed, php_strval(i), cd) for i, cd in analyzed['code'].items()}
        if analyzed.get('split'):
            return 'CODE_NODES = {}   # node id -> settings and code, filled by workflow.py from agents/'
        return 'CODE_NODES = ' + json_to_python(out)

    @staticmethod
    def decisionBlock(analyzed: dict) -> str:
        """DecisionResult, the adapters of the protocols used, DECISIONS and _decision_router()."""
        protocols: dict = {}
        decisions: dict = {}
        for did, d in (analyzed.get('decisions') or {}).items():
            for c in d['decision']:
                protocols[c['protocol']] = True
            decisions[php_strval(did)] = d
        known = [p for p in protocols if p in LangGraphRuntime.ADAPTER_CLASSES]
        return ('from dataclasses import dataclass, field\nfrom functools import cached_property\n\n'
                + LangGraphRuntime.decisionAdaptersBlock(known) + '\n\n'
                + 'DECISIONS = ' + ('{}   # dispatcher id -> decision routing, filled by workflow.py from agents/' if analyzed.get('split')
                                    else ('{}' if not decisions else json_to_python(decisions))) + '\n\n\n'
                + T.decisionBlock__ret)

    @staticmethod
    def idRecordingHelpers() -> str:
        return T.idRecordingHelpers__ret


def json_encode_unicode(s: str) -> str:
    """json_encode($s, JSON_UNESCAPED_UNICODE): slashes stay escaped."""
    from app.agent_team.services.compiler_php import json_encode
    return json_encode(s, unicode=True)
