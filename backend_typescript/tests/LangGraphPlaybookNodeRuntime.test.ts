/**
 * Port of backend/tests/Unit/LangGraphPlaybookNodeRuntimeTest.php: the compiled LangGraph playbook node (spec
 * 2026-10-19 Task 7): "from input" over the baked PUBLISHED_PLAYBOOKS, the done/failed exits, and unattended gates.
 * langchain / langgraph are not needed: the harness stubs the few names the playbook runtime and the Node classes use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { execLines, python310 } from './support/lgFixturesB';

const HARNESS = `class _Msg:
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
`;

const PY = python310();
const NO_PY = PY === null ? 'Python 3.10+ not available' : false;

function runFile(source: string): [number, string[]] {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbn'));
  const file = path.join(dir, 'pbn.py');
  writeFileSync(file, source);
  try {
    return execLines([PY!, file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The playbook runtime + node classes + HARNESS + tail; the last output line decoded as JSON. */
function py(tail: string, env: Record<string, string> = {}): any {
  const [rc, out] = runFile("from __future__ import annotations\nimport asyncio, json, os, re, sys, threading, time, uuid\n"
    + "from abc import ABC, abstractmethod\nfrom dataclasses import asdict\nfrom datetime import datetime\nfrom enum import Enum\n"
    + "from functools import cached_property\nfrom typing import Awaitable, Callable\n"
    + "os.environ.pop('PLAYBOOK_GATE_MODE', None)\n"
    + Object.entries(env).map(([k, v]) => 'os.environ[' + JSON.stringify(k) + '] = ' + JSON.stringify(v) + '\n').join('')
    + HARNESS + '\n'
    + LangGraphRuntime.playbookBlock() + '\n' + LangGraphRuntime.nodeClassesBlock(true) + '\n'
    + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n' + tail);
  assert.equal(rc, 0, out.join('\n'));
  return JSON.parse(out[out.length - 1] ?? 'null');
}

test('testFromInputPicksPublishedPlaybook', { skip: NO_PY }, () => {
  const r = py("r = run(node(**FROM_INPUT), '## Claim\\n{\"playbook\": \"test\", \"sys_id\": \"a/1\", \"t\": \"é\"}', [RESOLVE])\n"
    + "print(json.dumps({**r, 'system': SEEN['system'], 'request': SEEN['request']}))\n");
  assert.equal(r.route, 'done');
  assert.equal(r.status, 'resolved');
  assert.ok(r.system.includes('DO THE TEST THING'));
  assert.ok(!r.system.includes('FIXED'));
  assert.ok(r.system.includes('"writes_enabled": true'), "the node's writes toggle applies to the published copy");
  assert.ok(r.text.startsWith('# Playbook: Test PB (resolved)'));
  assert.ok(r.text.endsWith('\n\nJob: {"playbook":"test","sys_id":"a/1","t":"é"}'));
});

test('testFromInputUnknownKeyRoutesFailed', { skip: NO_PY }, () => {
  const r = py("r = run(node(**FROM_INPUT), '{\"playbook\": \"nope\"}', [RESOLVE])\nprint(json.dumps({**r, 'ran': 'system' in SEEN}))\n");
  assert.equal(r.route, 'failed');
  assert.equal(r.ran, false, 'no playbook ran');
  assert.equal(r.text, 'Playbook failed: playbook_not_found:nope\n\n\n\nJob: {"playbook":"nope"}');
});

test('testFromInputBadInput', { skip: NO_PY }, () => {
  const r = py("print(json.dumps([run(node(**FROM_INPUT), t)['text'] for t in\n"
    + "    ['not json', '[\"test\"]', '{\"other\": \"test\"}', '{\"playbook\": \"Bad Key\"}', '{\"playbook\": 5}', '\"test\"']]))\n");
  assert.deepEqual(r, [
    'Playbook failed: bad_input\n\n',
    'Playbook failed: bad_input\n\n',
    'Playbook failed: bad_input\n\n\n\nJob: {"other":"test"}',
    'Playbook failed: bad_input\n\n\n\nJob: {"playbook":"Bad Key"}',
    'Playbook failed: bad_input\n\n\n\nJob: {"playbook":5}',
    'Playbook failed: bad_input\n\n',
  ]);
});

test('testFromInputCustomField', { skip: NO_PY }, () => {
  const r = py("r = run(node(**{**FROM_INPUT, 'input_field': 'pb'}), '{\"pb\": \"test\"}', [RESOLVE])\nprint(json.dumps(r))\n");
  assert.equal(r.route, 'done');
});

test('testResolvedRoutesDone', { skip: NO_PY }, () => {
  const r = py("r = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])\nprint(json.dumps(r))\n");
  assert.equal(r.route, 'done');
  assert.ok(r.text.startsWith('# Playbook: Fixed PB (resolved)'));
  assert.ok(!r.text.includes('Job: '), 'a fixed playbook adds no Job line');
});

test('testFixedNodeWithExitsEndsWithTheJobLineWhenItsParentIsAJob', { skip: NO_PY }, () => {
  const r = py("r = run(node(exits=['done', 'failed']), '{\"task\": \"T1\"}', [RESOLVE])\nprint(json.dumps(r))\n");
  assert.equal(r.route, 'done');
  assert.ok(r.text.endsWith('\n\nJob: {"task":"T1"}'));
});

test('testUnresolvedRoutesFailedWithStatus', { skip: NO_PY }, () => {
  const r = py("r = run(node(exits=['done', 'failed']), 'hello', [])\nprint(json.dumps(r))\n");
  assert.equal(r.route, 'failed');
  assert.ok(r.text.startsWith('Playbook failed: status:running\n\n# Playbook: Fixed PB (running)'));
});

test('testErrorRoutesFailedOnOneLine', { skip: NO_PY }, () => {
  const r = py("LLM_ERROR = 'no key\\n   for   provider'\nr = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])\nprint(json.dumps(r))\n");
  assert.equal(r.route, 'failed');
  assert.equal(r.text, "Playbook failed: error:node 2 'Run job' cannot build its 'claude' model: no key for provider\n\n");
});

test('testUnattendedGateEndsRunAsHandedOff', { skip: NO_PY }, () => {
  const r = py("r = run(node(**FROM_INPUT), '{\"playbook\": \"test\"}', [APPROVAL, RESOLVE])\nprint(json.dumps({**r, 'called': SEEN['called']}))\n",
    { PLAYBOOK_GATE_MODE: 'unattended' });
  assert.equal(r.route, 'failed');
  assert.equal(r.status, 'handed_off');
  assert.deepEqual(r.called, ['request_approval'], 'the gate ends the run at once');
  assert.ok(r.text.startsWith('Playbook failed: gate:approval\n\n# Playbook: Test PB (handed_off)'));
  assert.ok(!r.text.includes('approved'), 'never auto-approved');
  assert.ok(r.text.endsWith('\n\nJob: {"playbook":"test"}'));
});

test('testUnattendedGateKinds', { skip: NO_PY }, () => {
  const r = py("print(json.dumps([run(node(exits=['done', 'failed']), 'x', [(g, a), RESOLVE])['text'].split('\\n')[0] for g, a in [\n"
    + "    ('trigger_form', {'prompt': 'p', 'fields': []}), ('prompt_handoff', {'team_or_person': 't', 'reason': 'r'}),\n"
    + "    ('await_message', {'prompt': 'p'})]]))\n", { PLAYBOOK_GATE_MODE: 'unattended' });
  assert.deepEqual(r, ['Playbook failed: gate:form', 'Playbook failed: gate:handoff', 'Playbook failed: gate:await_message']);
});

test('testNodeWithoutExitsBehavesAsBefore', { skip: NO_PY }, () => {
  const r = py("r = run(node(), 'hello', [])\nprint(json.dumps(r))\n");
  assert.equal(r.route, '');
  assert.equal(r.status, 'running');
  assert.ok(r.text.startsWith('# Playbook: Fixed PB (running)'));
});

test('testUnattendedGateInParallelWithAnotherToolEndsTheLeg', { skip: NO_PY }, () => {
  const r = py("r = run(node(exits=['done', 'failed']), 'x', [[APPROVAL, NOTE], RESOLVE])\n"
    + "print(json.dumps({**r, 'called': SEEN['called'], 'llm_calls': SEEN['llm_calls']}))\n",
  { PLAYBOOK_GATE_MODE: 'unattended' });
  assert.equal(r.route, 'failed');
  assert.equal(r.status, 'handed_off');
  assert.deepEqual(r.called, ['request_approval']);
  assert.equal(r.llm_calls, 1);
  assert.ok(r.text.startsWith('Playbook failed: gate:approval\n\n'));
  assert.ok(!r.text.includes('after the gate'));
});

test('testAfterAnUnattendedGateToolsRefuseAndTheFirstGateWins', { skip: NO_PY }, () => {
  const r = py("pr = PlaybookRun(True, {})\ntools = {t.name: t for t in PlaybookToolset({'actions': []}, pr).build()}\n"
    + "out = []\nfor name, args in [APPROVAL, ('trigger_form', {'prompt': 'p', 'fields': []}), NOTE]:\n"
    + "    try:\n        tools[name].func(**args)\n        out.append('ran')\n"
    + "    except PlaybookHandedOff:\n        out.append('stopped')\n"
    + "second = pr.gate('form', 'trigger_form', {'prompt': 'p'})\n"
    + "print(json.dumps({'out': out, 'stop': pr.gate_stop, 'status': pr.status, 'second': second,\n"
    + "    'gates': [e['kind'] for e in pr.events if e['type'] == 'gate_request'], 'direct': tools['request_approval'].return_direct}))\n",
  { PLAYBOOK_GATE_MODE: 'unattended' });
  assert.deepEqual(r.out, ['stopped', 'stopped', 'stopped']);
  assert.equal(r.stop, 'approval');
  assert.equal(r.status, 'handed_off');
  assert.deepEqual(r.gates, ['approval'], 'one gate_request: later gates neither run nor overwrite');
  assert.equal(r.second.ok, false);
  assert.equal(r.direct, true);
});

test('testGateModeIsPerRun', { skip: NO_PY }, () => {
  const r = py("async def in_run(mode):\n    t = RUN_GATE_MODE.set(mode)\n"
    + "    try:\n        return await asyncio.to_thread(PlaybookRun.gate_mode)\n    finally:\n        RUN_GATE_MODE.reset(t)\n"
    + "a = asyncio.run(in_run('unattended'))\nb = asyncio.run(in_run(''))\nc = PlaybookRun.gate_mode()\n"
    + "os.environ['PLAYBOOK_GATE_MODE'] = 'deny'\nd = asyncio.run(in_run('unattended'))\n"
    + "print(json.dumps([a, b, c, d, 'PLAYBOOK_GATE_MODE' in os.environ and os.environ['PLAYBOOK_GATE_MODE']]))\n");
  assert.deepEqual(r, ['unattended', 'auto', 'auto', 'deny', 'deny']);
  const g = LangGraphRuntime.workflowGraphBlock();
  assert.ok(g.includes('token = RUN_GATE_MODE.set("unattended" if self.unattended else "")'));
});

test('testFromInputReadsTheFirstParentOnly', { skip: NO_PY }, () => {
  const r = py("async def run_node(nid, request):\n    return await node(**FROM_INPUT).run(request, _trace)\n"
    + "SCRIPT[:] = [RESOLVE]\n"
    + "g = WorkflowGraph(edges=[['1','2'],['5','2'],['2','3']], order=['1','5','2','3'],\n"
    + "    node_types={'1':'code','5':'code','2':'playbook','3':'output'},\n"
    + "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':[]}}},\n"
    + "    run_node=run_node, start_documents=[])\n"
    + "outs = {'1': {'source': 'Claim', 'text': '## Claim\\n{\"playbook\": \"test\"}'}, '5': {'source': 'Other', 'text': 'more context'}}\n"
    + "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': outs}))\n"
    + "print(json.dumps({'routes': res['routes'], 'text': res['node_outputs']['2']['text'], 'request': SEEN['request'],\n"
    + "    'after': PLAYBOOK_JOB_TEXT.get()}))\n");
  assert.deepEqual(r.routes, { 2: 'done' });
  assert.ok(r.text.endsWith('\n\nJob: {"playbook":"test"}'));
  assert.ok(r.request.includes('more context'));
  assert.equal(r.after, null, 'the job text is reset after the node');
});

/** The routes and the node text for the playbook '2' fed by outs over edges. */
function firstParentRun(edges: string, order: string, types: string, agentsExtra: string, outs: string): any {
  return py("async def run_node(nid, request):\n    return await node(**FROM_INPUT).run(request, _trace)\n"
    + "SCRIPT[:] = [RESOLVE]\n"
    + `g = WorkflowGraph(edges=${edges}, order=${order},\n`
    + `    node_types=${types},\n`
    + "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':[]}}" + agentsExtra + '},\n'
    + '    run_node=run_node, start_documents=[])\n'
    + `outs = ${outs}\n`
    + "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': outs}))\n"
    + "print(json.dumps({'routes': res['routes'], 'text': res['node_outputs']['2']['text']}))\n");
}

test('testFromInputFirstParentLooksThroughADispatcher', { skip: NO_PY }, () => {
  const r = firstParentRun("[['1','6'],['6','2'],['2','3']]", "['1','6','2','3']",
    "{'1':'code','6':'agent','2':'playbook','3':'output'}",
    ", '6': {'kind':'agent','display':'Disp','dispatch':[{'id':'pb','targets':['2']}]}",
    "{'1': {'source': 'Claim', 'text': '## Claim\\n{\"playbook\": \"test\", \"task\": \"T1\"}'}, '6': {'source': 'Disp', 'text': 'routing to the playbook'}}");
  assert.deepEqual(r.routes, { 2: 'done' });
  assert.ok(r.text.endsWith('\n\nJob: {"playbook":"test","task":"T1"}'));
});

test('testFromInputSkipsAnEmptyFirstParent', { skip: NO_PY }, () => {
  const r = firstParentRun("[['5','2'],['1','2'],['2','3']]", "['5','1','2','3']",
    "{'5':'code','1':'code','2':'playbook','3':'output'}", '',
    "{'5': {'source': 'Empty', 'text': ''}, '1': {'source': 'Claim', 'text': '{\"playbook\": \"test\"}'}}");
  assert.deepEqual(r.routes, { 2: 'done' });
  assert.ok(r.text.endsWith('\n\nJob: {"playbook":"test"}'));
});

test('testWorkflowGraphRoutesPlaybookExits', { skip: NO_PY }, () => {
  const [rc, out] = runFile("from __future__ import annotations\nimport asyncio, json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
    + LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n'
    + "async def run_node(nid, request):\n    return {'text': 'Playbook failed: bad_input', 'route': 'failed', 'notes': '', 'status': 'failed'}\n"
    + "g = WorkflowGraph(edges=[['1','2'],['2','3'],['2','4']], order=['1','2','3','4'],\n"
    + "    node_types={'1':'start','2':'playbook','3':'output','4':'output'},\n"
    + "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':['4']}}},\n"
    + '    run_node=run_node, start_documents=[])\n'
    + "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': {'1': {'source': 'start', 'text': 'x'}}}))\n"
    + "print(json.dumps([res.get('routes'), g._code_router('2')({'routes': res['routes']})]))\n");
  assert.equal(rc, 0, out.join('\n'));
  assert.deepEqual(JSON.parse(out[out.length - 1]), [{ 2: 'failed' }, ['4']]);
  assert.ok(LangGraphRuntime.workflowGraphBlock().includes('def _routes_by_exit(entry: dict) -> bool:'));
});
