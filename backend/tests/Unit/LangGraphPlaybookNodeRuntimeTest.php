<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LangGraphRuntime;
use PHPUnit\Framework\TestCase;

/**
 * Compiled LangGraph playbook node (spec 2026-10-19 Task 7): "from input" over the baked
 * PUBLISHED_PLAYBOOKS, the done/failed exits, and unattended gates. Twin of
 * GraphWorkflowRunnerPlaybookNodeTest: the texts and routes must be the PHP runner's.
 *
 * langchain / langgraph are not needed: the harness stubs the few names the playbook
 * runtime and the Node classes use, and a scripted create_react_agent calls the tools in
 * order (stopping after a return_direct tool, as langgraph's create_react_agent does).
 */
final class LangGraphPlaybookNodeRuntimeTest extends TestCase
{
    private const HARNESS = <<<'PY'
class _Msg:
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

PY;

    private function python(): string
    {
        $py = is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
        exec($py . ' -c ' . escapeshellarg('import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)') . ' 2>&1', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('Python 3.10+ not available');
        }
        return $py;
    }

    /** The playbook runtime + node classes + HARNESS + $tail; the last output line decoded as JSON. */
    private function py(string $tail, array $env = []): mixed
    {
        $file = tempnam(sys_get_temp_dir(), 'pbn') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport asyncio, json, os, re, sys, threading, time, uuid\n"
            . "from abc import ABC, abstractmethod\nfrom dataclasses import asdict\nfrom datetime import datetime\nfrom enum import Enum\n"
            . "from functools import cached_property\nfrom typing import Awaitable, Callable\n"
            . "os.environ.pop('PLAYBOOK_GATE_MODE', None)\n"
            . implode('', array_map(fn($k, $v) => 'os.environ[' . json_encode($k) . '] = ' . json_encode($v) . "\n", array_keys($env), $env))
            . self::HARNESS . "\n"
            . LangGraphRuntime::playbookBlock() . "\n" . LangGraphRuntime::nodeClassesBlock(true) . "\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::workflowGraphBlock() . "\n" . $tail);
        exec($this->python() . ' ' . escapeshellarg($file) . ' </dev/null 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, implode("\n", $out));
        return json_decode((string) end($out), true);
    }

    public function testFromInputPicksPublishedPlaybook(): void
    {
        $r = $this->py("r = run(node(**FROM_INPUT), '## Claim\\n{\"playbook\": \"test\", \"sys_id\": \"a/1\", \"t\": \"é\"}', [RESOLVE])\n"
            . "print(json.dumps({**r, 'system': SEEN['system'], 'request': SEEN['request']}))\n");
        self::assertSame('done', $r['route']);
        self::assertSame('resolved', $r['status']);
        self::assertStringContainsString('DO THE TEST THING', $r['system']);
        self::assertStringNotContainsString('FIXED', $r['system']);
        self::assertStringContainsString('"writes_enabled": true', $r['system'], 'the node\'s writes toggle applies to the published copy');
        self::assertStringStartsWith('# Playbook: Test PB (resolved)', $r['text']);
        self::assertStringEndsWith("\n\nJob: {\"playbook\":\"test\",\"sys_id\":\"a/1\",\"t\":\"é\"}", $r['text']);
    }

    public function testFromInputUnknownKeyRoutesFailed(): void
    {
        $r = $this->py("r = run(node(**FROM_INPUT), '{\"playbook\": \"nope\"}', [RESOLVE])\nprint(json.dumps({**r, 'ran': 'system' in SEEN}))\n");
        self::assertSame('failed', $r['route']);
        self::assertFalse($r['ran'], 'no playbook ran');
        self::assertSame("Playbook failed: playbook_not_found:nope\n\n\n\nJob: {\"playbook\":\"nope\"}", $r['text']);
    }

    public function testFromInputBadInput(): void
    {
        $r = $this->py("print(json.dumps([run(node(**FROM_INPUT), t)['text'] for t in\n"
            . "    ['not json', '[\"test\"]', '{\"other\": \"test\"}', '{\"playbook\": \"Bad Key\"}', '{\"playbook\": 5}', '\"test\"']]))\n");
        self::assertSame([
            "Playbook failed: bad_input\n\n",
            "Playbook failed: bad_input\n\n",
            "Playbook failed: bad_input\n\n\n\nJob: {\"other\":\"test\"}",
            "Playbook failed: bad_input\n\n\n\nJob: {\"playbook\":\"Bad Key\"}",
            "Playbook failed: bad_input\n\n\n\nJob: {\"playbook\":5}",
            "Playbook failed: bad_input\n\n",
        ], $r);
    }

    public function testFromInputCustomField(): void
    {
        $r = $this->py("r = run(node(**{**FROM_INPUT, 'input_field': 'pb'}), '{\"pb\": \"test\"}', [RESOLVE])\nprint(json.dumps(r))\n");
        self::assertSame('done', $r['route']);
    }

    public function testResolvedRoutesDone(): void
    {
        $r = $this->py("r = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])\nprint(json.dumps(r))\n");
        self::assertSame('done', $r['route']);
        self::assertStringStartsWith('# Playbook: Fixed PB (resolved)', $r['text']);
        self::assertStringNotContainsString('Job: ', $r['text'], 'a fixed playbook adds no Job line');
    }

    public function testUnresolvedRoutesFailedWithStatus(): void
    {
        $r = $this->py("r = run(node(exits=['done', 'failed']), 'hello', [])\nprint(json.dumps(r))\n");
        self::assertSame('failed', $r['route']);
        self::assertStringStartsWith("Playbook failed: status:running\n\n# Playbook: Fixed PB (running)", $r['text']);
    }

    public function testErrorRoutesFailedOnOneLine(): void
    {
        $r = $this->py("LLM_ERROR = 'no key\\n   for   provider'\nr = run(node(exits=['done', 'failed']), 'hello', [RESOLVE])\nprint(json.dumps(r))\n");
        self::assertSame('failed', $r['route']);
        self::assertSame("Playbook failed: error:node 2 'Run job' cannot build its 'claude' model: no key for provider\n\n", $r['text']);
    }

    public function testUnattendedGateEndsRunAsHandedOff(): void
    {
        $r = $this->py("r = run(node(**FROM_INPUT), '{\"playbook\": \"test\"}', [APPROVAL, RESOLVE])\nprint(json.dumps({**r, 'called': SEEN['called']}))\n",
            ['PLAYBOOK_GATE_MODE' => 'unattended']);
        self::assertSame('failed', $r['route']);
        self::assertSame('handed_off', $r['status']);
        self::assertSame(['request_approval'], $r['called'], 'the gate ends the run at once');
        self::assertStringStartsWith("Playbook failed: gate:approval\n\n# Playbook: Test PB (handed_off)", $r['text']);
        self::assertStringNotContainsString('approved', $r['text'], 'never auto-approved');
        self::assertStringEndsWith("\n\nJob: {\"playbook\":\"test\"}", $r['text']);
    }

    public function testUnattendedGateKinds(): void
    {
        $r = $this->py("print(json.dumps([run(node(exits=['done', 'failed']), 'x', [(g, a), RESOLVE])['text'].split('\\n')[0] for g, a in [\n"
            . "    ('trigger_form', {'prompt': 'p', 'fields': []}), ('prompt_handoff', {'team_or_person': 't', 'reason': 'r'}),\n"
            . "    ('await_message', {'prompt': 'p'})]]))\n", ['PLAYBOOK_GATE_MODE' => 'unattended']);
        self::assertSame(['Playbook failed: gate:form', 'Playbook failed: gate:handoff', 'Playbook failed: gate:await_message'], $r);
    }

    public function testNodeWithoutExitsBehavesAsBefore(): void
    {
        $r = $this->py("r = run(node(), 'hello', [])\nprint(json.dumps(r))\n");
        self::assertSame('', $r['route']);
        self::assertSame('running', $r['status']);
        self::assertStringStartsWith('# Playbook: Fixed PB (running)', $r['text']);
    }

    public function testUnattendedGateInParallelWithAnotherToolEndsTheLeg(): void
    {
        // The model calls a gate and another tool in the same turn: nothing runs after the gate,
        // and the model is not called again.
        $r = $this->py("r = run(node(exits=['done', 'failed']), 'x', [[APPROVAL, NOTE], RESOLVE])\n"
            . "print(json.dumps({**r, 'called': SEEN['called'], 'llm_calls': SEEN['llm_calls']}))\n",
            ['PLAYBOOK_GATE_MODE' => 'unattended']);
        self::assertSame('failed', $r['route']);
        self::assertSame('handed_off', $r['status']);
        self::assertSame(['request_approval'], $r['called']);
        self::assertSame(1, $r['llm_calls']);
        self::assertStringStartsWith("Playbook failed: gate:approval\n\n", $r['text']);
        self::assertStringNotContainsString('after the gate', $r['text']);
    }

    public function testAfterAnUnattendedGateToolsRefuseAndTheFirstGateWins(): void
    {
        $r = $this->py("pr = PlaybookRun(True, {})\ntools = {t.name: t for t in PlaybookToolset({'actions': []}, pr).build()}\n"
            . "out = []\nfor name, args in [APPROVAL, ('trigger_form', {'prompt': 'p', 'fields': []}), NOTE]:\n"
            . "    try:\n        tools[name].func(**args)\n        out.append('ran')\n"
            . "    except PlaybookHandedOff:\n        out.append('stopped')\n"
            . "second = pr.gate('form', 'trigger_form', {'prompt': 'p'})\n"
            . "print(json.dumps({'out': out, 'stop': pr.gate_stop, 'status': pr.status, 'second': second,\n"
            . "    'gates': [e['kind'] for e in pr.events if e['type'] == 'gate_request'], 'direct': tools['request_approval'].return_direct}))\n",
            ['PLAYBOOK_GATE_MODE' => 'unattended']);
        self::assertSame(['stopped', 'stopped', 'stopped'], $r['out']);
        self::assertSame('approval', $r['stop']);
        self::assertSame('handed_off', $r['status']);
        self::assertSame(['approval'], $r['gates'], 'one gate_request: later gates neither run nor overwrite');
        self::assertFalse($r['second']['ok']);
        self::assertTrue($r['direct']);
    }

    public function testGateModeIsPerRun(): void
    {
        // A listener's run (RUN_GATE_MODE, set by WorkflowGraph.run for graph.unattended) is unattended;
        // a run outside it is attended again; an explicit PLAYBOOK_GATE_MODE always wins.
        $r = $this->py("async def in_run(mode):\n    t = RUN_GATE_MODE.set(mode)\n"
            . "    try:\n        return await asyncio.to_thread(PlaybookRun.gate_mode)\n    finally:\n        RUN_GATE_MODE.reset(t)\n"
            . "a = asyncio.run(in_run('unattended'))\nb = asyncio.run(in_run(''))\nc = PlaybookRun.gate_mode()\n"
            . "os.environ['PLAYBOOK_GATE_MODE'] = 'deny'\nd = asyncio.run(in_run('unattended'))\n"
            . "print(json.dumps([a, b, c, d, 'PLAYBOOK_GATE_MODE' in os.environ and os.environ['PLAYBOOK_GATE_MODE']]))\n");
        self::assertSame(['unattended', 'auto', 'auto', 'deny', 'deny'], $r);
        $g = LangGraphRuntime::workflowGraphBlock();
        self::assertStringContainsString('token = RUN_GATE_MODE.set("unattended" if self.unattended else "")', $g);
    }

    public function testFromInputReadsTheFirstParentOnly(): void
    {
        // Two parents: the first is the job JSON, the second anything. The key and the Job line come
        // from the first (PHP's parents[0]); the playbook's request is still both texts joined.
        $r = $this->py("async def run_node(nid, request):\n    return await node(**FROM_INPUT).run(request, _trace)\n"
            . "SCRIPT[:] = [RESOLVE]\n"
            . "g = WorkflowGraph(edges=[['1','2'],['5','2'],['2','3']], order=['1','5','2','3'],\n"
            . "    node_types={'1':'code','5':'code','2':'playbook','3':'output'},\n"
            . "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':[]}}},\n"
            . "    run_node=run_node, start_documents=[])\n"
            . "outs = {'1': {'source': 'Claim', 'text': '## Claim\\n{\"playbook\": \"test\"}'}, '5': {'source': 'Other', 'text': 'more context'}}\n"
            . "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': outs}))\n"
            . "print(json.dumps({'routes': res['routes'], 'text': res['node_outputs']['2']['text'], 'request': SEEN['request'],\n"
            . "    'after': PLAYBOOK_JOB_TEXT.get()}))\n");
        self::assertSame(['2' => 'done'], $r['routes']);
        self::assertStringEndsWith("\n\nJob: {\"playbook\":\"test\"}", $r['text']);
        self::assertStringContainsString('more context', $r['request']);
        self::assertNull($r['after'], 'the job text is reset after the node');
    }

    public function testWorkflowGraphRoutesPlaybookExits(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'pbg') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport asyncio, json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::workflowGraphBlock() . "\n"
            . "async def run_node(nid, request):\n    return {'text': 'Playbook failed: bad_input', 'route': 'failed', 'notes': '', 'status': 'failed'}\n"
            . "g = WorkflowGraph(edges=[['1','2'],['2','3'],['2','4']], order=['1','2','3','4'],\n"
            . "    node_types={'1':'start','2':'playbook','3':'output','4':'output'},\n"
            . "    agents={'2': {'kind':'playbook','display':'PB','exits':['done','failed'],'exit_targets':{'done':['3'],'failed':['4']}}},\n"
            . "    run_node=run_node, start_documents=[])\n"
            . "res = asyncio.run(g._module_node('2')({'user_prompt': 'x', 'node_outputs': {'1': {'source': 'start', 'text': 'x'}}}))\n"
            . "print(json.dumps([res.get('routes'), g._code_router('2')({'routes': res['routes']})]))\n");
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame([['2' => 'failed'], ['4']], json_decode((string) end($out), true));
        self::assertStringContainsString('def _routes_by_exit(entry: dict) -> bool:', LangGraphRuntime::workflowGraphBlock());
    }
}
