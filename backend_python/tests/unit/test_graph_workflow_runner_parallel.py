"""Unit tests for the Task 5b parallel-execution / client-tool-bridge
methods of app.agent_team.services.graph_workflow_runner.GraphWorkflowRunner:
`executeAgentsInParallel`, `finalizeParallelNode`, `getParallelExecutor`,
`isClientSideToolName`, `emitClientToolCallInParallel`,
`awaitClientToolResultInParallel`, `executeToolForParallel`,
`buildToolsForParallelAgent`, the deprecated curl_multi twin
`executeAgentsInParallelNoTools`, and its `buildAgentLLMRequest`/
`parseAgentLLMResponse` collaborators.

No PHP oracle exists for GraphWorkflowRunner (see
test_graph_workflow_runner_core.py's module docstring), so cases are written
from GraphWorkflowRunner.php 1760-2827 directly plus the Task 5b brief's own
test list.

Ordering/interleaving rule under test (see graph_workflow_runner.py's module
docstring for the full statement): `executeAgentsInParallel` finalizes each
non-tool-call agent's `node_complete`/`node_trace` pair as soon as its turn
in the round's response dict is processed (not batched at round end), while
every round's client-tool (skill) calls are all EMITTED first and AWAITED
only afterward, so the browser worker pool runs them concurrently.
"""
from __future__ import annotations

import json
import time

import httpx

from app.agent_team.models.agent import Agent
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.parallel_agent_executor import ParallelAgentExecutor
from app.providers.provider_request_factory import ProviderRequestFactory
from app.agent_team.services.skill_tool_bridge import SkillToolBridge


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeDb:
    def __init__(self):
        self.inserts: list = []
        self.executes: list = []

    def fetch_one(self, sql, params=None):
        return None

    def fetch_all(self, sql, params=None):
        return []

    def insert(self, sql, params=None):
        self.inserts.append((sql, params))
        return 1

    def execute(self, sql, params=None):
        self.executes.append((sql, params))
        return 1


class FakeGraphRepository:
    def findStartNode(self, workflow_id):
        return None

    def getGraph(self, workflow_id):
        return {'nodes': [], 'edges': []}


class FakeAgentRepository:
    def __init__(self, agents=None):
        self._by_id = {a.getId(): a for a in (agents or [])}

    def findById(self, agent_id):
        return self._by_id.get(agent_id)


class FakeToolsManager:
    def __init__(self, tool_defs=None, execute_result=None, raise_error=None):
        self.tool_defs = tool_defs if tool_defs is not None else []
        self.execute_result = execute_result if execute_result is not None else {'result': 'TOOL_OK'}
        self.raise_error = raise_error
        self.calls: list = []

    def getToolDefinitions(self):
        return self.tool_defs

    def execute(self, name, args):
        self.calls.append((name, args))
        if self.raise_error:
            raise self.raise_error
        return self.execute_result


class FakeAgentRunner:
    """Stands in for Task 2's AgentRunner. `createParallelExecutor` returns
    whatever executor the test configured (a real `ParallelAgentExecutor`
    wired to `httpx.MockTransport`, or a hand-scripted round table)."""

    def __init__(self, executor=None, tools_manager=None):
        self._executor = executor
        self.toolsManager = tools_manager if tools_manager is not None else FakeToolsManager()

    def createParallelExecutor(self, record_executions):
        return self._executor

    def getToolsManager(self):
        return self.toolsManager


class RecordingStreamContext:
    def __init__(self):
        self.events: list = []

    def emit(self, data: dict) -> None:
        self.events.append(data)


class ScriptedExecutor:
    """A minimal `runConcurrentRound` fake -- one scripted response table per
    round, mirroring test_parallel_agent_executor.py's `FakeCallLLMsExecutor`
    but exposing the narrower surface GraphWorkflowRunner actually calls
    (`runConcurrentRound`, not the full `ParallelAgentExecutor.run` loop)."""

    def __init__(self, script: dict):
        self.script = script
        self.round = 0
        self.seen_batches: list = []

    def runConcurrentRound(self, states: dict) -> dict:
        self.seen_batches.append(list(states.keys()))
        out = self.script.get(self.round, {})
        self.round += 1
        return {k: v for k, v in out.items() if k in states}


def _agent_node(node_id: int, name: str, provider: str = 'claude', extra_config: dict | None = None) -> dict:
    config = {'agent_name': name, 'instructions': f'Do the {name} job.', 'provider': provider}
    if extra_config:
        config.update(extra_config)
    return {'id': node_id, 'node_type': 'agent', 'agent_id': None, 'drawflow_node_id': None, 'config': config}


def _make_runner(executor=None, tools_manager=None, config=None, db=None):
    db = db if db is not None else FakeDb()
    agentRepo = FakeAgentRepository()
    agentRunner = FakeAgentRunner(executor, tools_manager)
    runner = GraphWorkflowRunner(db, agentRepo, agentRunner, FakeGraphRepository(), config if config is not None else {})
    return runner, db, agentRunner


# ---------------------------------------------------------------------------
# executeAgentsInParallel: real ParallelAgentExecutor + httpx.MockTransport
# -- ordering + events + overlap proof (the brief's own required case).
# ---------------------------------------------------------------------------

def test_execute_agents_in_parallel_mock_transport_proves_concurrency_and_ordering():
    """Two OpenAI-family providers (openai, deepseek): 'slow' sleeps longer
    than 'fast' inside the mock handler, but both requests were dispatched to
    the pool at the same time (their handler intervals overlap -- a
    sequential dispatch could never overlap), and `results`/`node_complete`
    events come back in the ORIGINAL agentStates order ('slow' node 10 then
    'fast' node 20), not completion order -- per
    ParallelAgentExecutor.dispatchChunk's chunk-order collection rule."""
    intervals: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        node = request.url.params.get('node')
        start = time.time()
        delay = 0.15 if node == 'slow' else 0.02
        time.sleep(delay)
        intervals[node] = (start, time.time())
        return httpx.Response(200, json={
            'choices': [{'message': {'content': f'{node} says hi'}}],
            'usage': {'prompt_tokens': 3, 'completion_tokens': 2},
        })

    provider_config = {
        'openai': {'api_key': 'K', 'base_url': 'https://x.example', 'chat_endpoint': '/c?node=slow'},
        'deepseek': {'api_key': 'K', 'base_url': 'https://x.example', 'chat_endpoint': '/c?node=fast'},
    }
    db = FakeDb()
    exec_ = ParallelAgentExecutor(
        agent_runner=None, db=db, config=provider_config, record_executions=False,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    runner, _, _ = _make_runner(executor=exec_, db=db, config=provider_config)
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    nodes = [
        _agent_node(10, 'Slow', provider='openai'),
        _agent_node(20, 'Fast', provider='deepseek'),
    ]

    wall_start = time.time()
    results = runner._executeAgentsInParallel(nodes, userId=7, userPrompt='go', edges=[], executedNodes=[])
    wall_elapsed = time.time() - wall_start

    assert list(results.keys()) == [10, 20]
    assert results[10]['output'] == 'slow says hi'
    assert results[20]['output'] == 'fast says hi'
    assert results[10]['success'] is True and results[20]['success'] is True

    slow_start, slow_end = intervals['slow']
    fast_start, fast_end = intervals['fast']
    assert fast_start < slow_end          # overlap proof: real concurrency
    assert wall_elapsed < 0.15 + 0.02     # whole round took ~max(delay), not the sum

    complete_events = [e for e in stream.events if e['type'] == 'node_complete']
    assert [e['agent_name'] for e in complete_events] == ['Slow', 'Fast']
    assert [e['output'] for e in complete_events] == ['slow says hi', 'fast says hi']
    assert [e['input_tokens'] for e in complete_events] == [3, 3]
    assert [e['output_tokens'] for e in complete_events] == [2, 2]

    # recordExecutionTrace ran for both (via finalizeParallelNode) -- one
    # trace-store insert per agent.
    assert len(db.inserts) == 2

    exec_.close()


def test_execute_agents_in_parallel_disabled_node_skips_llm_and_emits_sentinel():
    runner, db, _ = _make_runner(executor=ScriptedExecutor({}))
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    node = _agent_node(1, 'Off', extra_config={'disabled': True})
    results = runner._executeAgentsInParallel([node], userId=1, userPrompt='x', edges=[], executedNodes=[])

    assert results[1] == {
        'type': 'agent', 'agent_id': None, 'agent_name': 'Off',
        'input': '', 'output': 'disabled node', 'success': True, 'usage': None,
    }
    event_types = [e['type'] for e in stream.events]
    assert event_types == ['node_start', 'node_log', 'node_complete']
    assert db.inserts == []  # no execution trace for a disabled node


# ---------------------------------------------------------------------------
# executeAgentsInParallel: server-side tool call executes inline via
# executeToolForParallel / buildToolsForParallelAgent.
# ---------------------------------------------------------------------------

def test_execute_agents_in_parallel_server_tool_call_then_final_text():
    tools = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 'd', 'input_schema': {}}],
                              execute_result={'hits': 3})
    script = {
        0: {
            1: {'success': True, 'parsed': {
                'text': 'let me search',
                'tool_calls': [{'id': 'call1', 'function': {'name': 'search', 'arguments': '{"q":"x"}'}}],
            }},
        },
        1: {
            1: {'success': True, 'parsed': {'text': 'final answer', 'tool_calls': [], 'usage': {'input_tokens': 5, 'output_tokens': 4}}},
        },
    }
    exec_ = ScriptedExecutor(script)
    runner, db, _ = _make_runner(executor=exec_, tools_manager=tools)
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    node = _agent_node(1, 'Searcher', provider='claude')
    results = runner._executeAgentsInParallel([node], userId=1, userPrompt='x', edges=[], executedNodes=[])

    assert results[1]['output'] == 'final answer'
    assert results[1]['success'] is True
    assert tools.calls == [('search', {'q': 'x'})]
    assert exec_.seen_batches == [[1], [1]]  # two rounds, same single pending agent both times


def test_build_tools_for_parallel_agent_filters_by_names():
    tools = FakeToolsManager(tool_defs=[{'name': 'a'}, {'name': 'b'}, {'name': 'c'}])
    runner, _, _ = _make_runner(tools_manager=tools)
    agent = Agent({'name': 'x', 'provider': 'claude', 'instructions': 'i'})

    assert runner._buildToolsForParallelAgent(agent, None) == [{'name': 'a'}, {'name': 'b'}, {'name': 'c'}]
    assert runner._buildToolsForParallelAgent(agent, ['b']) == [{'name': 'b'}]


def test_execute_tool_for_parallel_returns_json_and_swallows_exceptions():
    tools = FakeToolsManager(execute_result={'ok': True})
    runner, _, _ = _make_runner(tools_manager=tools)
    content = runner._executeToolForParallel({'function': {'name': 'x', 'arguments': '{"a":1}'}}, None)
    assert json.loads(content) == {'ok': True}
    assert tools.calls == [('x', {'a': 1})]

    boom = FakeToolsManager(raise_error=RuntimeError('kaboom'))
    runner2, _, _ = _make_runner(tools_manager=boom)
    content2 = runner2._executeToolForParallel({'function': {'name': 'y', 'arguments': '{}'}}, None)
    assert json.loads(content2) == {'error': 'kaboom'}


# ---------------------------------------------------------------------------
# executeAgentsInParallel: client-tool (run_skill_script) round-trip via
# SkillToolBridge -- a thread writes the result file into a tmp_path bridge
# dir (SKILL_TOOL_BRIDGE_DIR), matching the brief's own required case.
# ---------------------------------------------------------------------------

def test_execute_agents_in_parallel_client_tool_round_trip_via_bridge(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    monkeypatch.setattr(SkillToolBridge, 'generateToolCallId', staticmethod(lambda: 'ab' * 16))

    script = {
        0: {
            1: {'success': True, 'parsed': {
                'text': 'running the skill',
                'tool_calls': [{'id': 'orig-id', 'function': {
                    'name': 'run_skill_script', 'arguments': '{"script": "x.py", "argv": ["-o", "/outputs/y"]}',
                }}],
            }},
        },
        1: {
            1: {'success': True, 'parsed': {
                'text': 'skill result summarized', 'tool_calls': [],
                'usage': {'input_tokens': 7, 'output_tokens': 6},
            }},
        },
    }
    exec_ = ScriptedExecutor(script)
    runner, db, _ = _make_runner(executor=exec_)
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    node = _agent_node(1, 'Skiller', provider='claude', extra_config={'bound_skill': {'dir_name': 'demo', 'source': 'local'}})

    # writeResult from another thread, mirroring
    # test_skill_tool_bridge.py::test_await_sees_a_result_written_from_another_thread.
    def _write_late():
        time.sleep(0.1)
        SkillToolBridge().writeResult('ab' * 16, {'output': {'exit_code': 0, 'stdout': 'ok'}})

    import threading
    t = threading.Thread(target=_write_late)
    t.start()

    results = runner._executeAgentsInParallel([node], userId=1, userPrompt='x', edges=[], executedNodes=[])
    t.join()

    assert results[1]['output'] == 'skill result summarized'
    assert results[1]['success'] is True

    client_calls = [e for e in stream.events if e['type'] == 'client_tool_call']
    assert len(client_calls) == 1
    assert client_calls[0]['tool_call_id'] == 'ab' * 16
    assert client_calls[0]['tool_calls'][0]['name'] == 'run_skill_script'
    assert client_calls[0]['tool_calls'][0]['input'] == {'script': 'x.py', 'argv': ['-o', '/outputs/y']}
    assert client_calls[0]['dir_name'] == 'demo'

    assert runner.skillResultByNode[1]['output'] == {'exit_code': 0, 'stdout': 'ok'}
    assert runner.skillResultByNode[1]['script'] == 'x.py'


def test_await_client_tool_result_in_parallel_times_out_with_error_json(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    runner, _, _ = _make_runner(config={'parallel_skill_timeout_ms': 200})
    node = {'id': 5, 'node_type': 'agent', 'config': {}}

    t0 = time.time()
    result = runner._awaitClientToolResultInParallel({'id': 'deadbeef' * 4, 'function': {'arguments': '{}'}}, node)
    assert time.time() - t0 >= 0.15

    decoded = json.loads(result)
    assert 'did not return within' in decoded['error']


# ---------------------------------------------------------------------------
# executeAgentsInParallel: round-limit exhaustion -> forced failure sweep.
# ---------------------------------------------------------------------------

def test_execute_agents_in_parallel_never_completes_forces_failure_after_max_rounds():
    """An agent that keeps calling a SERVER tool forever never sets
    `completed=True` (each round it gets another tool_calls response), so
    after 10 rounds the end-of-function sweep force-finalizes it as failed,
    surfacing the last assistant text -- PHP 2135-2151."""
    tools = FakeToolsManager(execute_result={'again': True})
    always_tool_call = {
        1: {'success': True, 'parsed': {
            'text': 'still working',
            'tool_calls': [{'id': 'c', 'function': {'name': 'loop_tool', 'arguments': '{}'}}],
        }},
    }
    script = {r: always_tool_call for r in range(10)}
    exec_ = ScriptedExecutor(script)
    runner, db, _ = _make_runner(executor=exec_, tools_manager=tools)
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    node = _agent_node(1, 'Looper', provider='claude')
    results = runner._executeAgentsInParallel([node], userId=1, userPrompt='x', edges=[], executedNodes=[])

    assert results[1]['success'] is False
    assert results[1]['output'] == 'still working'  # last assistant text, not the generic message
    assert exec_.round == 10  # ran every round up to maxRounds


# ---------------------------------------------------------------------------
# finalizeParallelNode: idempotent per node id.
# ---------------------------------------------------------------------------

def test_finalize_parallel_node_is_idempotent():
    runner, db, _ = _make_runner()
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)
    agent = Agent({'id': 9, 'name': 'X', 'provider': 'claude', 'instructions': 'i'})
    node = {'id': 42, 'node_type': 'agent', 'config': {}}
    state = {'agent': agent, 'node': node, 'input': 'in', 'output': 'out', 'success': True, 'usage': None}

    results: dict = {}
    runner._finalizeParallelNode(42, state, results)
    runner._finalizeParallelNode(42, state, results)  # second call is a no-op

    assert len(results) == 1
    assert len([e for e in stream.events if e['type'] == 'node_complete']) == 1
    assert len(db.inserts) == 1  # one trace, not two


# ---------------------------------------------------------------------------
# isClientSideToolName / getParallelExecutor caching.
# ---------------------------------------------------------------------------

def test_is_client_side_tool_name():
    runner, _, _ = _make_runner()
    assert runner._isClientSideToolName('run_skill_script') is True
    assert runner._isClientSideToolName('discover_skill') is True
    assert runner._isClientSideToolName('Task') is True
    assert runner._isClientSideToolName('search') is False
    assert runner._isClientSideToolName('') is False


def test_get_parallel_executor_lazily_constructs_and_caches():
    sentinel = object()
    calls: list = []

    class TrackingAgentRunner(FakeAgentRunner):
        def createParallelExecutor(self, record_executions):
            calls.append(record_executions)
            return sentinel

    runner = GraphWorkflowRunner(FakeDb(), FakeAgentRepository(), TrackingAgentRunner(), FakeGraphRepository(), {})
    assert runner.parallelExecutor is None

    first = runner._getParallelExecutor()
    second = runner._getParallelExecutor()

    assert first is sentinel and second is sentinel
    assert calls == [False]  # constructed exactly once, record_executions=False like PHP


# ---------------------------------------------------------------------------
# buildAgentLLMRequest per provider family (PHP 2504-2763; [DEPRECATED],
# called only by executeAgentsInParallelNoTools). Cross-checked against
# ProviderRequestFactory.buildRequest per the brief -- PHP itself keeps these
# as two independent implementations (GraphWorkflowRunner.php never
# references ProviderRequestFactory), so this asserts semantic overlap
# (model/host/payload-shape) rather than byte-identity, and documents where
# they intentionally diverge.
# ---------------------------------------------------------------------------

def _agent(provider, model=None, settings=None):
    return Agent({'name': 'A', 'provider': provider, 'model': model, 'instructions': 'i', 'settings': settings or {}})


def test_build_agent_llm_request_openai():
    runner, _, _ = _make_runner(config={'openai': {'api_key': 'K1', 'model': 'gpt-4o-mini'}})
    req = runner._buildAgentLLMRequest(_agent('openai'), 'do it')

    assert req['url'] == 'https://api.openai.com/v1/chat/completions'
    assert req['provider'] == 'openai'
    assert req['payload']['model'] == 'gpt-4o-mini'
    assert req['payload']['messages'][-1] == {'role': 'user', 'content': 'do it'}
    assert 'Authorization: Bearer K1' in req['headers']

    # Cross-check: ProviderRequestFactory's static twin resolves the same
    # endpoint/provider family for equivalent config -- messages differ only
    # in that GraphWorkflowRunner's own version has no `tools` parameter at
    # all (the [DEPRECATED] no-tools path), matching PHP's own method
    # signature (no $tools argument).
    factory_req = ProviderRequestFactory.buildRequest(
        'openai', 'gpt-4o-mini', req['payload']['messages'], [], {'api_key': 'K1'}, 16384, 0.7,
    )
    assert factory_req['url'] == req['url']
    assert factory_req['payload']['model'] == req['payload']['model']


def test_build_agent_llm_request_claude():
    runner, _, _ = _make_runner(config={'claude': {'api_key': 'K2'}})
    req = runner._buildAgentLLMRequest(_agent('claude', model='claude-x'), 'task text')

    assert req['url'] == 'https://api.anthropic.com/v1/messages'
    assert req['provider'] == 'claude'
    assert req['payload']['model'] == 'claude-x'
    assert req['payload']['messages'] == [{'role': 'user', 'content': 'task text'}]
    assert 'x-api-key: K2' in req['headers']
    assert 'anthropic-version: 2023-06-01' in req['headers']

    factory_req = ProviderRequestFactory.buildRequest(
        'claude', 'claude-x', [{'role': 'user', 'content': 'task text'}], [], {'api_key': 'K2'}, 4096, 0.7,
    )
    assert factory_req['url'] == req['url']
    assert factory_req['provider'] == req['provider']


def test_build_agent_llm_request_gemini():
    runner, _, _ = _make_runner(config={'gemini': {'api_key': 'K3'}})
    req = runner._buildAgentLLMRequest(_agent('gemini', model='gemini-x'), 'task text')

    assert req['url'].startswith('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent?key=K3')
    assert req['provider'] == 'gemini'
    assert 'task text' in req['payload']['contents'][0]['parts'][0]['text']


def test_build_agent_llm_request_deepseek_grok_kimi():
    runner, _, _ = _make_runner(config={
        'deepseek': {'api_key': 'Kd'}, 'grok': {'api_key': 'Kg'}, 'kimi': {'api_key': 'Kk'},
    })
    d = runner._buildAgentLLMRequest(_agent('deepseek'), 't')
    assert d['url'] == 'https://api.deepseek.com/v1/chat/completions' and d['provider'] == 'deepseek'

    g = runner._buildAgentLLMRequest(_agent('grok'), 't')
    assert g['url'] == 'https://api.x.ai/v1/chat/completions' and g['provider'] == 'grok'

    k = runner._buildAgentLLMRequest(_agent('kimi'), 't')
    assert k['url'] == 'https://api.moonshot.cn/v1/chat/completions' and k['provider'] == 'kimi'
    assert 'temperature' not in k['payload']  # kimi omits temperature entirely


def test_build_agent_llm_request_returns_none_without_api_key():
    runner, _, _ = _make_runner(config={})
    assert runner._buildAgentLLMRequest(_agent('openai'), 't') is None
    assert runner._buildAgentLLMRequest(_agent('claude'), 't') is None
    assert runner._buildAgentLLMRequest(_agent('kimi'), 't') is None


def test_build_agent_llm_request_default_provider_requires_api_key_and_base_url():
    runner, _, _ = _make_runner(config={})
    assert runner._buildAgentLLMRequest(_agent('mystery'), 't') is None

    runner2, _, _ = _make_runner(config={'mystery': {'api_key': 'Km', 'base_url': 'https://mystery.example'}})
    req = runner2._buildAgentLLMRequest(_agent('mystery'), 't')
    assert req['url'] == 'https://mystery.example/v1/chat/completions'
    assert req['provider'] == 'mystery'


# ---------------------------------------------------------------------------
# parseAgentLLMResponse per provider family (PHP 2768-2815).
# ---------------------------------------------------------------------------

def test_parse_agent_llm_response_openai_family():
    runner, _, _ = _make_runner()
    resp = json.dumps({'choices': [{'message': {'content': 'hi there'}}], 'usage': {'prompt_tokens': 1}})
    for provider in ('openai', 'deepseek', 'grok', 'kimi'):
        parsed = runner._parseAgentLLMResponse(resp, provider)
        assert parsed == {'text': 'hi there', 'usage': {'prompt_tokens': 1}}


def test_parse_agent_llm_response_claude():
    runner, _, _ = _make_runner()
    resp = json.dumps({'content': [{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}], 'usage': {'x': 1}})
    assert runner._parseAgentLLMResponse(resp, 'claude') == {'text': 'ab', 'usage': {'x': 1}}


def test_parse_agent_llm_response_gemini():
    runner, _, _ = _make_runner()
    resp = json.dumps({'candidates': [{'content': {'parts': [{'text': 'gem text'}]}}], 'usageMetadata': {'y': 2}})
    assert runner._parseAgentLLMResponse(resp, 'gemini') == {'text': 'gem text', 'usage': {'y': 2}}


def test_parse_agent_llm_response_invalid_json():
    runner, _, _ = _make_runner()
    parsed = runner._parseAgentLLMResponse('not json{{{', 'openai')
    assert parsed == {'text': '', 'usage': None, 'error': 'Invalid JSON response'}


def test_parse_agent_llm_response_default_fallback():
    runner, _, _ = _make_runner()
    resp = json.dumps({'text': 'fallback text'})
    assert runner._parseAgentLLMResponse(resp, 'unknown_provider') == {'text': 'fallback text', 'usage': None}


# ---------------------------------------------------------------------------
# executeAgentsInParallelNoTools: [DEPRECATED] curl_multi twin, over
# httpx.MockTransport (swapped in for the module's `httpx.Client`).
# ---------------------------------------------------------------------------

def test_execute_agents_in_parallel_no_tools_over_mock_transport(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        return httpx.Response(200, json={
            'choices': [{'message': {'content': f"echo:{payload['messages'][-1]['content']}"}}],
            'usage': {'prompt_tokens': 2, 'completion_tokens': 1},
        })

    import app.agent_team.services.graph_workflow_runner as gwr_module
    real_client_cls = gwr_module.httpx.Client
    monkeypatch.setattr(
        gwr_module.httpx, 'Client',
        lambda *a, **kw: real_client_cls(transport=httpx.MockTransport(handler)),
    )

    runner, db, _ = _make_runner(config={'openai': {'api_key': 'K'}})
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    node = _agent_node(1, 'Solo', provider='openai')
    results = runner._executeAgentsInParallelNoTools([node], userId=1, userPrompt='ping', edges=[], executedNodes=[])

    assert results[1]['success'] is True
    # No incoming edges -> buildContextForNode returns '' -> task = userPrompt verbatim (PHP 2318-2321).
    assert results[1]['output'] == 'echo:ping'
    assert results[1]['input'] == 'ping'
    assert results[1]['usage'] == {'prompt_tokens': 2, 'completion_tokens': 1}
    complete = [e for e in stream.events if e['type'] == 'node_complete']
    assert len(complete) == 1 and complete[0]['success'] is True


def test_execute_agents_in_parallel_no_tools_returns_empty_when_no_agent_buildable():
    runner, _, _ = _make_runner(config={})
    node = {'id': 1, 'node_type': 'agent', 'agent_id': 999, 'config': {}, 'drawflow_node_id': None}
    # agent_id 999 not found by FakeAgentRepository -> agent stays None -> skipped.
    assert runner._executeAgentsInParallelNoTools([node], userId=1, userPrompt='x', edges=[], executedNodes=[]) == {}
