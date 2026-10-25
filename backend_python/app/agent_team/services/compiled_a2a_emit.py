"""Port of backend/src/AgentTeam/Services/CompiledA2AEmit.php -- the A2A layout of the ADK, MAF and NOOA targets.

One A2A agent server per agent, dispatcher and playbook node (servers/<id>_<slug>.py, ports from 8701), an
orchestrator.py that starts them (AgentSupervisor, LangGraph's) and walks the canvas, and an api.py serving
the run protocol over orchestrator.run(). The servers run their node with the package's runtime.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiler_php import ascii_translit, j, json_encode, json_to_python, obj, py_str, sprintf_pad
from app.agent_team.services.compiler_text import compiled_a2a_emit as T
from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.phpcompat import php_date, php_intval, php_strval


class CompiledA2AEmit:
    BASE_PORT = 8701

    @staticmethod
    def refuse(analyzed: dict) -> None:
        """What the A2A layout does not support yet: a Start option, code nodes."""
        if analyzed.get('triggerNodeId') is not None:
            raise RuntimeError('A Start option (an event or schedule trigger) needs the single-file or modular format: '
                               'compile this workflow as a single file or with agents in separate files.')
        if analyzed.get('code'):
            raise RuntimeError('Code nodes are not supported by the A2A packaging yet. Compile this workflow as a single file'
                               ' or with agents in separate files.')

    @staticmethod
    def version(analyzed: dict) -> str:
        return str(php_intval((analyzed.get('workflow') or {}).get('id') or 0)) + '-' + php_date('Ymd')

    @classmethod
    def layout(cls, analyzed: dict) -> dict:
        """node id => {display, kind, file, port, index[, menu]}, one per agent / dispatcher / playbook node."""
        menus = WorkflowGraphAnalyzer.dispatchMenus(analyzed)['menus']
        out: dict = {}
        i = 0
        for nid in analyzed.get('order') or []:
            nid = php_strval(nid)
            if nid in (analyzed.get('playbooks') or {}):
                kind = 'playbook'
                display = php_strval(analyzed['playbooks'][nid]['display'])
            elif nid in (analyzed.get('agents') or {}):
                kind = 'dispatcher' if nid in menus else 'agent'
                display = php_strval(analyzed['agents'][nid]['name'])
            else:
                continue
            ascii_ = ascii_translit(display)
            for ch in ("'", '"', '`', '^', '~'):
                ascii_ = ascii_.replace(ch, '')
            slug = re.sub(r'[^a-z0-9]+', '-', ascii_, flags=re.IGNORECASE).strip('-').lower()
            slug = (slug if slug not in ('', '0') else 'node')[:40]
            out[nid] = {'display': display, 'kind': kind, 'file': f'servers/{nid}_{slug}.py',
                        'port': cls.BASE_PORT + i, 'index': i}
            if kind == 'dispatcher':
                out[nid]['menu'] = [[php_strval(t['id']), php_strval(t['name'])] for t in menus[nid]]
            i += 1
        return out

    @classmethod
    def orchestrator(cls, analyzed: dict, title: str) -> str:
        """orchestrator.py: GRAPH (the canvas as layers), the supervisor, the remote node runner and run()."""
        from app.agent_team.services.lang_graph_generator import LangGraphGenerator
        layout = cls.layout(analyzed)
        startId = php_strval(analyzed.get('startNodeId') or '')
        outId = ''
        for i, node in (analyzed.get('byId') or {}).items():
            if WorkflowGraphAnalyzer.typeOf(node) == 'output':
                outId = php_strval(i)
                break

        def eff(i: str) -> list:
            keep = []
            for p in (analyzed.get('parents') or {}).get(i) or []:
                p = php_strval(p)
                if p == startId or p in layout:
                    keep.append(p)
            return keep if keep else ([startId] if startId != '' else [])

        nodes: dict = {}
        layers = []
        for layer in analyzed.get('layers') or []:
            ids = [php_strval(x) for x in layer if php_strval(x) in layout]
            for n in ids:
                nodes[n] = {'kind': layout[n]['kind'], 'name': layout[n]['display'], 'parents': eff(n)}
            if ids:
                layers.append(ids)
        agents = {nid: {'display': e['display'], 'file': e['file'], 'kind': e['kind'], 'port': e['port'], 'index': e['index']}
                  for nid, e in layout.items()}
        graph = {'start': startId, 'output': outId, 'output_parents': eff(outId) if outId != '' else [],
                 'sinks': layers[-1] if outId == '' and layers else [], 'layers': layers, 'nodes': obj(nodes)}
        name = php_strval(analyzed['workflow']['name'])
        endpoints = ['  ' + sprintf_pad(nid, 6) + ' ' + sprintf_pad(e['display'], 24) + ' ' + sprintf_pad(e['file'], 36)
                     + f" http://127.0.0.1:{e['port']}/   (env A2A_AGENT_{nid}_URL)" for nid, e in layout.items()]
        q = '"""'
        L = [f'{q}A2A orchestrator for workflow ' + json_encode(name, unicode=True) + f' -- {title}.', '',
             'One A2A agent server per node (servers/, spawned by AgentSupervisor at the first run), each running its',
             'node with the ' + title + " runtime in common.py; this file walks the canvas (GRAPH): each layer's reached",
             "nodes get their input (the request plus their parents' outputs) as an A2A task, together; a dispatcher's",
             'route decides which of its children run; the Output node merges what reached it.', '',
             'AGENT ENDPOINTS  (id, name, file, default URL; env override)', '===============']
        L += endpoints
        L += ['', 'TO RUN', '======',
              '  pip install -r requirements.txt',
              '  python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]',
              "  python api.py --port 8000                    # the run server SynergyAI's editor talks to",
              '  # A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.',
              q, 'from __future__ import annotations', '',
              'import argparse, asyncio, json, os, subprocess, sys, threading, time, uuid',
              'from typing import Callable', '',
              'from dotenv import load_dotenv', '',
              '_HERE = os.path.dirname(os.path.abspath(__file__))',
              'for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):   # own .env first, then python/.env',
              '    load_dotenv(os.path.join(_d, ".env"))', '',
              'import httpx',
              'from a2a import types as T',
              'from a2a.client import create_client, ClientConfig',
              'from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts', '']
        L.append('WORKFLOW_ID = ' + str(php_intval(analyzed['workflow']['id'])))
        L.append('WORKFLOW_NAME = ' + py_str(name))
        L.append('WORKFLOW_VERSION = ' + py_str(cls.version(analyzed)) + '   # every agent card must carry it')
        L.append('DEFAULT_PROMPT = ' + py_str(php_strval(analyzed.get('startPrompt') or '')))
        L.append('A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "' + str(cls.BASE_PORT) + '"))')
        L.append('START_DOCUMENTS = ' + json_to_python(analyzed['startDocuments'] if analyzed.get('startDocuments') is not None else [])
                 + "   # the Start's documents (start_documents/ in this folder)")
        L.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if analyzed.get('outputStorageEnabled') else 'False'))
        folder = analyzed.get('outputFolder')
        L.append('OUTPUT_FOLDER = ' + (py_str(php_strval(folder)) if folder is not None and folder != '' else 'None'))
        L.append('')
        L.append('AGENTS = ' + json_to_python(agents) + '   # node id -> server file, port, kind')
        L.append('ORDER = ' + json_to_python([php_strval(k) for k in layout]))
        L.append('GRAPH = ' + json_to_python(graph) + "   # the canvas: layers, each node's kind and parents")
        L += ['', '']
        L.append(LangGraphRuntime.runEventsBlock())
        L.append(LangGraphGenerator.contextBuilderBlock())
        L.append(PythonEmitHelpers.documentConverterBlock())
        L += ['NODE_DURATIONS = {}   # display name -> seconds of A2A round trip', '', '']
        L.append(LangGraphGenerator.a2aRemoteBlock())
        L.append(T.orchestrator__ret)
        return '\n'.join(L) + '\n'

    @staticmethod
    def api(analyzed: dict, title: str) -> str:
        """api.py: the run server over orchestrator.run(); the agent servers start with the first run."""
        name = j(php_strval(analyzed['workflow']['name']))
        return ('"""Run server for workflow ' + name + f' (A2A, {title})\n\n'
                + 'Serves the run protocol the SynergyAI frontend speaks over orchestrator.run(); the agent servers start\n'
                + 'with the first run (_ensure_agents) and stop with this process. No authentication: bind to 127.0.0.1\n'
                + 'or a trusted LAN interface only.\n' + '"""' + '\n'
                + T.api__ret
                + RunServerEmitter.runtimeBlock())

    @classmethod
    def server(cls, analyzed: dict, nid: str, runNode: str, title: str) -> str:
        """servers/<id>_<slug>.py: one node's A2A agent server around the target's run_node."""
        from app.agent_team.services.lang_graph_generator import LangGraphGenerator
        e = cls.layout(analyzed)[nid]
        ag = (analyzed.get('agents') or {}).get(nid) or {}
        pb = (analyzed.get('playbooks') or {}).get(nid) or {}
        provider = ag.get('provider') if ag.get('provider') is not None else pb.get('provider')
        prompt = ag.get('systemPrompt') if ag.get('systemPrompt') is not None else pb.get('instructions')
        node = {'id': nid, 'kind': e['kind'], 'display': e['display'],
                'provider': php_strval(provider if provider is not None else ''),
                'system_prompt': php_strval(prompt if prompt is not None else '')}
        if 'menu' in e:
            node['menu'] = e['menu']
        q = '"""'
        return (f'{q}A2A agent server for node {nid} (' + e['display'].replace(q, "'''").replace('\n', ' ') + ') of workflow '
                + json_encode(php_strval(analyzed['workflow']['name']), unicode=True) + f' -- {title}.\n\n'
                + 'The orchestrator (orchestrator.py, one folder up) sends this node its input as an A2A task, streams its\n'
                + "status, answers its gates and reads the 'result' artifact (text + route/notes/status). The node runs with\n"
                + f"the package's runtime (common.py, agents/).\n{q}\n"
                + T.server__ret
                + 'NODE = ' + json_to_python(node) + '\n\n\n'
                + (cls.dispatcherHelpers() + '\n\n\n' if e['kind'] == 'dispatcher' else '')
                + runNode.rstrip('\n') + '\n\n\n'
                + LangGraphGenerator.a2aAgentServerBlock() + '\n'
                + '# The shared playbook runtime (common.py) asks GATE_BRIDGE for its gates: over A2A here.\n'
                + '_C.GATE_BRIDGE = _a2a_gate if NODE["kind"] == "playbook" else None\n'
                + 'WORKFLOW_NAME = ' + py_str(php_strval(analyzed['workflow']['name'])) + '\n'
                + 'WORKFLOW_VERSION = ' + py_str(cls.version(analyzed)) + '\n'
                + f"AGENT_CARD = build_agent_card(f\"http://127.0.0.1:{{os.environ.get('A2A_PORT', '{e['port']}')}}/\")\n\n"
                + 'if __name__ == "__main__":\n    main()\n')

    @staticmethod
    def dispatcherHelpers() -> str:
        return T.dispatcherHelpers__ret

    @classmethod
    def package(cls, analyzed: dict, modular: list, runNodes: dict, packageFiles: list, root: str, title: str) -> dict:
        """The A2A folder: orchestrator.py, api.py, the modular package (workflow.py, common.py, agents/), one
        server per node, then the package's own files."""
        workflowPy, commonPy, nodeFiles = modular
        files = [
            {'path': 'orchestrator.py', 'code': cls.orchestrator(analyzed, title)},
            {'path': 'api.py', 'code': cls.api(analyzed, title)},
            {'path': 'workflow.py', 'code': workflowPy},
            {'path': 'common.py', 'code': commonPy},
        ]
        files += list(nodeFiles)
        for nid, src in runNodes.items():
            files.append({'path': cls.layout(analyzed)[nid]['file'], 'code': cls.server(analyzed, php_strval(nid), src, title)})
        return {'root': root, 'files': files + list(packageFiles)}
