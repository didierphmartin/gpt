"""Port of backend/tests/Unit/LangGraphPlaybookNodeRuntimeTest.php.

Compiled LangGraph playbook node (spec 2026-10-19 Task 7): "from input" over the baked PUBLISHED_PLAYBOOKS,
the done/failed exits, and unattended gates. langchain / langgraph are not needed: the harness stubs the
names the playbook runtime and the Node classes use, and a scripted create_react_agent calls the tools in
order (stopping after a return_direct tool, as langgraph's create_react_agent does).
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

from app.agent_team.services.lang_graph_runtime import LangGraphRuntime
from tests.unit import lg_support as S

HARNESS = r'''class _Msg:
    def __init__(self, content=""):
        self.content = content
class SystemMessage(_Msg): pass
class HumanMessage(_Msg): pass
class AIMessage(_Msg): pass
class ToolMessage(_Msg):
    def __str__(self):
        return self.content

def inject_datetime(s):
    return s

class _Events:
    active = False
    def emit(self, **ev):
        pass
EVENTS = _Events()

def Field(default=None, description=""):
    return default

def create_model(name, **fields):
    return name

class StructuredTool:
    def __init__(self, func, name, return_direct):
        self.func, self.name, self.return_direct = func, name, return_direct
    @classmethod
    def from_function(cls, func, name, description, args_schema, return_direct=False):
        return cls(func, name, return_direct)

SCRIPT, SEEN = [], {}

def create_react_agent(llm, tools):
    by = {t.name: t for t in tools}
    class _Agent:
        async def ainvoke(self, inp, config=None):
            SEEN["system"] = inp["messages"][0].content
            SEEN["request"] = inp["messages"][-1].content
            SEEN["called"], SEEN["llm_calls"] = [], 0
            # A SCRIPT entry is one model turn: a (name, args) call, or a list of calls made in parallel.
            for turn in SCRIPT:
                SEEN["llm_calls"] += 1
                direct = None
                for name, args in (turn if isinstance(turn, list) else [turn]):
                    SEEN["called"].append(name)
                    out = by[name].func(**args)   # an exception ends ainvoke, as in langchain 1.x / langgraph 1.x
                    direct = out if by[name].return_direct else direct
                if direct is not None:
                    return {"messages": [ToolMessage(direct)]}
            SEEN["llm_calls"] += 1
            return {"messages": [AIMessage("final answer")]}
    return _Agent()

LLM_ERROR = None
def _make_llm(*a, **k):
    if LLM_ERROR:
        raise ValueError(LLM_ERROR)
    return object()

TOOLS = MCP = ToolCatalog = None

PUBLISHED_PLAYBOOKS = {
    "test": {"title": "Test PB", "domain": "IT", "instructions": "DO THE TEST THING", "policy": {"on_unbound": "skip"},
             "approvers": {}, "actions": []},
}

def node(**over):
    cfg = {"id": "2", "kind": "playbook", "display": "Run job", "provider": "claude", "model": "m", "temperature": 0.2,
           "max_tokens": 100, "thinking": None, "title": "Fixed PB", "domain": "", "writes_enabled": True,
           "policy": {}, "approvers": {}, "requester": {"id": "3"}, "instructions": "FIXED", "actions": []}
    cfg.update(over)
    return PlaybookNode(cfg)

async def _trace(line):
    pass

def run(n, request, script=()):
    SCRIPT[:] = list(script)
    SEEN.clear()
    return asyncio.run(n.run(request, _trace))

FROM_INPUT = {"source": "input", "input_field": "playbook", "published": PUBLISHED_PLAYBOOKS, "exits": ["done", "failed"],
              "exit_targets": {"done": ["3"], "failed": ["4"]}}
RESOLVE = ("resolve_request", {"outcome": "done", "summary": "all good"})
NOTE = ("leave_internal_note", {"text": "after the gate"})
APPROVAL = ("request_approval", {"approver": "boss", "question": "ok?"})
'''


def _run_file(src: str) -> list:
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run([S.require_py310(), f.name], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    finally:
        os.unlink(f.name)
    out = [line for line in (r.stdout + r.stderr).split('\n') if line != '']
    assert r.returncode == 0, '\n'.join(out)
    return out


def _py(tail: str, env: dict | None = None):
    """The playbook runtime + node classes + HARNESS + tail; the last output line decoded as JSON."""
    src = ("from __future__ import annotations\nimport asyncio, json, os, re, sys, threading, time, uuid\n"
           "from abc import ABC, abstractmethod\nfrom dataclasses import asdict\nfrom datetime import datetime\nfrom enum import Enum\n"
           "from functools import cached_property\nfrom typing import Awaitable, Callable\n"
           "os.environ.pop('PLAYBOOK_GATE_MODE', None)\n"
           + ''.join(f'os.environ[{json.dumps(k)}] = {json.dumps(v)}\n' for k, v in (env or {}).items())
           + HARNESS + '\n'
           + LangGraphRuntime.playbookBlock() + '\n' + LangGraphRuntime.nodeClassesBlock(True) + '\n'
           + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n' + tail)
    return json.loads(_run_file(src)[-1])


def test_from_input_picks_published_playbook():
    r = _py(r'''r = run(node(**FROM_INPUT), '## Claim\n{"playbook": "test", "sys_id": "a/1", "t": "é"}', [RESOLVE])
print(json.dumps({**r, 'system': SEEN['system'], 'request': SEEN['request']}))
''')
    assert r['route'] == 'done'
    assert r['status'] == 'resolved'
    assert 'DO THE TEST THING' in r['system']
    assert 'FIXED' not in r['system']
    assert '"writes_enabled": true' in r['system'], "the node's writes toggle applies to the published copy"
    assert r['text'].startswith('# Playbook: Test PB (resolved)')
    assert r['text'].endswith('\n\nJob: {"playbook":"test","sys_id":"a/1","t":"é"}')


def test_from_input_unknown_key_routes_failed():
    r = _py(r'''r = run(node(**FROM_INPUT), '{"playbook": "nope"}', [RESOLVE])
print(json.dumps({**r, 'ran': 'system' in SEEN}))
''')
    assert r['route'] == 'failed'
    assert r['ran'] is False, 'no playbook ran'
    assert r['text'] == 'Playbook failed: playbook_not_found:nope\n\n\n\nJob: {"playbook":"nope"}'


def test_from_input_bad_input():
    r = _py(r'''print(json.dumps([run(node(**FROM_INPUT), t)['text'] for t in
    ['not json', '["test"]', '{"other": "test"}', '{"playbook": "Bad Key"}', '{"playbook": 5}', '"test"']]))
''')
    assert r == [
        'Playbook failed: bad_input\n\n',
        'Playbook failed: bad_input\n\n',
        'Playbook failed: bad_input\n\n\n\nJob: {"other":"test"}',
        'Playbook failed: bad_input\n\n\n\nJob: {"playbook":"Bad Key"}',
        'Playbook failed: bad_input\n\n\n\nJob: {"playbook":5}',
        'Playbook failed: bad_input\n\n',
    ]


def test_from_input_custom_field():
    r = _py(r'''r = run(node(**{**FROM_INPUT, 'input_field': 'pb'}), '{"pb": "test"}', [RESOLVE])
print(json.dumps(r))
''')
    assert r['route'] == 'done'


def test_resolved_routes_done():
    r = _py("r = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])\nprint(json.dumps(r))\n")
    assert r['route'] == 'done'
    assert r['text'].startswith('# Playbook: Fixed PB (resolved)')
    assert 'Job: ' not in r['text'], 'a fixed playbook adds no Job line'


def test_fixed_node_with_exits_ends_with_the_job_line_when_its_parent_is_a_job():
    r = _py(r'''r = run(node(exits=['done', 'failed']), '{"task": "T1"}', [RESOLVE])
print(json.dumps(r))
''')
    assert r['route'] == 'done'
    assert r['text'].endswith('\n\nJob: {"task":"T1"}')


def test_unresolved_routes_failed_with_status():
    r = _py("r = run(node(exits=['done', 'failed']), 'hello', [])\nprint(json.dumps(r))\n")
    assert r['route'] == 'failed'
    assert r['text'].startswith('Playbook failed: status:running\n\n# Playbook: Fixed PB (running)')


def test_error_routes_failed_on_one_line():
    r = _py(r'''LLM_ERROR = 'no key\n   for   provider'
r = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])
print(json.dumps(r))
''')
    assert r['route'] == 'failed'
    assert r['text'] == "Playbook failed: error:node 2 'Run job' cannot build its 'claude' model: no key for provider\n\n"


def test_unattended_gate_ends_run_as_handed_off():
    r = _py(r'''r = run(node(**FROM_INPUT), '{"playbook": "test"}', [APPROVAL, RESOLVE])
print(json.dumps({**r, 'called': SEEN['called']}))
''', {'PLAYBOOK_GATE_MODE': 'unattended'})
    assert r['route'] == 'failed'
    assert r['status'] == 'handed_off'
    assert r['called'] == ['request_approval'], 'the gate ends the run at once'
    assert r['text'].startswith('Playbook failed: gate:approval\n\n# Playbook: Test PB (handed_off)')
    assert 'approved' not in r['text'], 'never auto-approved'
    assert r['text'].endswith('\n\nJob: {"playbook":"test"}')


def test_unattended_gate_kinds():
    r = _py(r'''print(json.dumps([run(node(exits=['done', 'failed']), 'x', [(g, a), RESOLVE])['text'].split('\n')[0] for g, a in [
    ('trigger_form', {'prompt': 'p', 'fields': []}), ('prompt_handoff', {'team_or_person': 't', 'reason': 'r'}),
    ('await_message', {'prompt': 'p'})]]))
''', {'PLAYBOOK_GATE_MODE': 'unattended'})
    assert r == ['Playbook failed: gate:form', 'Playbook failed: gate:handoff', 'Playbook failed: gate:await_message']


def test_node_without_exits_behaves_as_before():
    r = _py("r = run(node(), 'hello', [])\nprint(json.dumps(r))\n")
    assert r['route'] == ''
    assert r['status'] == 'running'
    assert r['text'].startswith('# Playbook: Fixed PB (running)')


def test_unattended_gate_in_parallel_with_another_tool_ends_the_leg():
    r = _py('''r = run(node(exits=['done', 'failed']), 'x', [[APPROVAL, NOTE], RESOLVE])
print(json.dumps({**r, 'called': SEEN['called'], 'llm_calls': SEEN['llm_calls']}))
''', {'PLAYBOOK_GATE_MODE': 'unattended'})
    assert r['route'] == 'failed'
    assert r['status'] == 'handed_off'
    assert r['called'] == ['request_approval']
    assert r['llm_calls'] == 1
    assert r['text'].startswith('Playbook failed: gate:approval\n\n')
    assert 'after the gate' not in r['text']


def test_after_an_unattended_gate_tools_refuse_and_the_first_gate_wins():
    r = _py('''pr = PlaybookRun(True, {})
tools = {t.name: t for t in PlaybookToolset({'actions': []}, pr).build()}
out = []
for name, args in [APPROVAL, ('trigger_form', {'prompt': 'p', 'fields': []}), NOTE]:
    try:
        tools[name].func(**args)
        out.append('ran')
    except PlaybookHandedOff:
        out.append('stopped')
second = pr.gate('form', 'trigger_form', {'prompt': 'p'})
print(json.dumps({'out': out, 'stop': pr.gate_stop, 'status': pr.status, 'second': second,
    'gates': [e['kind'] for e in pr.events if e['type'] == 'gate_request'], 'direct': tools['request_approval'].return_direct}))
''', {'PLAYBOOK_GATE_MODE': 'unattended'})
    assert r['out'] == ['stopped', 'stopped', 'stopped']
    assert r['stop'] == 'approval'
    assert r['status'] == 'handed_off'
    assert r['gates'] == ['approval'], 'one gate_request: later gates neither run nor overwrite'
    assert r['second']['ok'] is False
    assert r['direct'] is True


def test_gate_mode_is_per_run():
    r = _py('''async def in_run(mode):
    t = RUN_GATE_MODE.set(mode)
    try:
        return await asyncio.to_thread(PlaybookRun.gate_mode)
    finally:
        RUN_GATE_MODE.reset(t)
a = asyncio.run(in_run('unattended'))
b = asyncio.run(in_run(''))
c = PlaybookRun.gate_mode()
os.environ['PLAYBOOK_GATE_MODE'] = 'deny'
d = asyncio.run(in_run('unattended'))
print(json.dumps([a, b, c, d, 'PLAYBOOK_GATE_MODE' in os.environ and os.environ['PLAYBOOK_GATE_MODE']]))
''')
    assert r == ['unattended', 'auto', 'auto', 'deny', 'deny']
    assert 'token = RUN_GATE_MODE.set("unattended" if self.unattended else "")' in LangGraphRuntime.workflowGraphBlock()


def test_from_input_reads_the_first_parent_only():
    r = _py(r'''async def run_node(nid, request):
    return await node(**FROM_INPUT).run(request, _trace)
SCRIPT[:] = [RESOLVE]
g = WorkflowGraph(edges=[['1','2'],['5','2'],['2','3']], order=['1','5','2','3'],
    node_types={'1':'code','5':'code','2':'playbook','3':'output'},
    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':[]}}},
    run_node=run_node, start_documents=[])
outs = {'1': {'source': 'Claim', 'text': '## Claim\n{"playbook": "test"}'}, '5': {'source': 'Other', 'text': 'more context'}}
res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': outs}))
print(json.dumps({'routes': res['routes'], 'text': res['node_outputs']['2']['text'], 'request': SEEN['request'],
    'after': PLAYBOOK_JOB_TEXT.get()}))
''')
    assert r['routes'] == {'2': 'done'}
    assert r['text'].endswith('\n\nJob: {"playbook":"test"}')
    assert 'more context' in r['request']
    assert r['after'] is None, 'the job text is reset after the node'


def _first_parent_run(edges: str, order: str, types: str, agentsExtra: str, outs: str) -> dict:
    return _py("async def run_node(nid, request):\n    return await node(**FROM_INPUT).run(request, _trace)\n"
               "SCRIPT[:] = [RESOLVE]\n"
               f"g = WorkflowGraph(edges={edges}, order={order},\n"
               f"    node_types={types},\n"
               "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':[]}}"
               + agentsExtra + "},\n"
               "    run_node=run_node, start_documents=[])\n"
               f"outs = {outs}\n"
               "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': outs}))\n"
               "print(json.dumps({'routes': res['routes'], 'text': res['node_outputs']['2']['text']}))\n")


def test_from_input_first_parent_looks_through_a_dispatcher():
    r = _first_parent_run("[['1','6'],['6','2'],['2','3']]", "['1','6','2','3']",
                          "{'1':'code','6':'agent','2':'playbook','3':'output'}",
                          ", '6': {'kind':'agent','display':'Disp','dispatch':[{'id':'pb','targets':['2']}]}",
                          r"""{'1': {'source': 'Claim', 'text': '## Claim\n{"playbook": "test", "task": "T1"}'}, '6': {'source': 'Disp', 'text': 'routing to the playbook'}}""")
    assert r['routes'] == {'2': 'done'}
    assert r['text'].endswith('\n\nJob: {"playbook":"test","task":"T1"}')


def test_from_input_skips_an_empty_first_parent():
    r = _first_parent_run("[['5','2'],['1','2'],['2','3']]", "['5','1','2','3']",
                          "{'5':'code','1':'code','2':'playbook','3':'output'}", '',
                          """{'5': {'source': 'Empty', 'text': ''}, '1': {'source': 'Claim', 'text': '{"playbook": "test"}'}}""")
    assert r['routes'] == {'2': 'done'}
    assert r['text'].endswith('\n\nJob: {"playbook":"test"}')


def test_workflow_graph_routes_playbook_exits():
    src = ("from __future__ import annotations\nimport asyncio, json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
           + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n'
           + "async def run_node(nid, request):\n    return {'text': 'Playbook failed: bad_input', 'route': 'failed', 'notes': '', 'status': 'failed'}\n"
           + "g = WorkflowGraph(edges=[['1','2'],['2','3'],['2','4']], order=['1','2','3','4'],\n"
           + "    node_types={'1':'start','2':'playbook','3':'output','4':'output'},\n"
           + "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':['4']}}},\n"
           + "    run_node=run_node, start_documents=[])\n"
           + "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': {'1': {'source': 'start', 'text': 'x'}}}))\n"
           + "print(json.dumps([res.get('routes'), g._code_router('2')({'routes': res['routes']})]))\n")
    assert json.loads(_run_file(src)[-1]) == [{'2': 'failed'}, ['4']]
    assert 'def _routes_by_exit(entry: dict) -> bool:' in LangGraphRuntime.workflowGraphBlock()
