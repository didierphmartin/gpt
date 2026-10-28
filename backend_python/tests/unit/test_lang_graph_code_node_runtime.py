"""Port of backend/tests/Unit/LangGraphCodeNodeRuntimeTest.php: the emitted runtime pieces for code nodes,
checked as text and executed by python3 where possible."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

from app.agent_team.services.lang_graph_runtime import LangGraphRuntime


def _run(py: str) -> tuple:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(py)
    try:
        r = subprocess.run(['python3', f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    return r.returncode, [line for line in (r.stdout + r.stderr).split('\n') if line != '']


def test_code_node_class_only_when_asked():
    assert 'class CodeNode' not in LangGraphRuntime.nodeClassesBlock(True)
    with_ = LangGraphRuntime.nodeClassesBlock(True, True)
    assert 'class CodeNode(Node):' in with_
    assert 'CODE = "code"' in with_
    assert 'case NodeKind.CODE:' in with_


def test_harness_is_embedded_verbatim_and_loads():
    block = LangGraphRuntime.codeHarnessBlock()
    py = ("import json, sys, types\nMCP_SLUGS = {}\nclass _M:\n    def call_tool_raw(self, u, t, a):\n        return {}\nMCP = _M()\n"
          + block + "\nprint(CODE_HARNESS.execute('def run(i, c):\\n    return i', 5, ['next'], [], _code_transport, 5)['output_text'])\n"
          + "print(_code_transport('nope', 't', {})['isError'])\n")
    rc, out = _run(py)
    assert rc == 0, '\n'.join(out)
    assert out == ['5', 'True']
    assert 'CODE_HARNESS_SOURCE = "' in block


def test_mcp_client_has_a_raw_call():
    assert 'def call_tool_raw(self, server_url: str, tool_name: str, arguments: dict) -> dict:' in LangGraphRuntime.mcpClientBlock()


def test_workflow_graph_routes_code_exits():
    g = LangGraphRuntime.workflowGraphBlock()
    assert 'case "agent" | "playbook" | "code":' in g
    assert 'def _code_router(self, nid: str):' in g
    assert '"start": self.node_types.get(p) == "start"' in g


def test_a_code_branch_of_a_dispatcher_receives_what_the_dispatcher_received():
    py = ("from __future__ import annotations\nimport json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
          + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n'
          + "g = WorkflowGraph(edges=[['1','2'],['2','3'],['3','4']], order=['1','2','3','4'],\n"
          + "    node_types={'1':'start','2':'code','3':'agent','4':'code'},\n"
          + "    agents={'2': {'kind':'code','display':'Poll'}, '3': {'kind':'dispatcher','display':'triage','dispatch':[{'id':'4','name':'claims'}]},\n"
          + "            '4': {'kind':'code','display':'claims'}}, run_node=None, start_documents=[])\n"
          + r"""outs = {'1': {'source':'start','text':'poll'}, '2': {'source':'Poll','text':'{\"id\": \"m1\"}'},""" + '\n'
          + "        '3': {'source':'triage','text':'### Input from: Poll'}}\n"
          + "print(json.dumps(json.loads(g._request_for('4', {'user_prompt':'poll','node_outputs':outs}))['parents']))\n")
    rc, out = _run(py)
    assert rc == 0, '\n'.join(out)
    assert out[-1] == '[{"name": "Poll", "text": "{\\"id\\": \\"m1\\"}", "start": false}]'


def test_code_nodes_are_checked_at_startup():
    with_ = LangGraphRuntime.nodeClassesBlock(True, True)
    assert re.search(r'class CodeNode\(Node\):.*?def __init__\(self, cfg: dict\):\n        super\(\).__init__\(cfg\)\n.*?CODE_HARNESS\.check_code\(self\.source\(\)\)',
                     with_, re.S)
    assert 'with open(os.path.join(PACKAGE_DIR, self.cfg["source_file"]), encoding="utf-8") as fh:' in with_
    assert 'res = await asyncio.to_thread(CODE_HARNESS.execute, self.source(), value,' in with_


def test_placeholder_filled_from_parent_meta():
    # The emitted CodeNode.run: ARGS {"v": "{m}"} is filled from the parent output's meta before the code runs.
    py = ("from __future__ import annotations\nimport asyncio, json, os, sys, types\nfrom abc import ABC, abstractmethod\n"
          "from enum import Enum\nfrom functools import cached_property\nPACKAGE_DIR = '.'\nMCP_SLUGS = {}\nMCP = None\n"
          + LangGraphRuntime.codeHarnessBlock() + "\n" + LangGraphRuntime.nodeClassesBlock(False, True) + "\n"
          + "node = CodeNode({'id': '2', 'kind': 'code', 'display': 'Fill', 'exits': ['next'], 'mcp_servers': [], 'timeout_s': 5,\n"
          + "    'exit_targets': {'next': []}, 'args': {'v': '{m}'}, 'arg_decls': [{'name': 'v'}],\n"
          + "    'source': 'def run(input, call_tool):\\n    return ARGS[\"v\"]\\n'})\n"
          + "async def _noop(msg):\n    pass\n"
          + "req = json.dumps({'user_prompt': '', 'parents': [{'name': 'P', 'text': json.dumps({'meta': {'m': 'V'}}), 'start': False}]})\n"
          + "print(asyncio.run(node.run(req, _noop))['text'])\n")
    rc, out = _run(py)
    assert rc == 0, '\n'.join(out)
    assert out[-1] == 'V'


def test_tool_error_result_takes_error_exit_in_compiled_script():
    block = LangGraphRuntime.codeHarnessBlock()
    py = ("import json, sys, types\nMCP_SLUGS = {'s': 'http://x/mcp'}\nclass _M:\n"
          + "    def call_tool_raw(self, u, t, a):\n"
          + "        return {'isError': True, 'content': [{'type': 'text', 'text': 'quota_exceeded'}]}\nMCP = _M()\n"
          + block
          + "\nr = CODE_HARNESS.execute('def run(i, call_tool):\\n    return {\"route\": \"ok\", \"output\": call_tool(\"s\", \"t\")}',"
          + " None, ['ok', 'error'], ['s'], _code_transport, 5)\n"
          + "print(r['route'])\nprint('quota_exceeded' in r['output_text'])\n")
    rc, out = _run(py)
    assert rc == 0, '\n'.join(out)
    assert out == ['error', 'True']
