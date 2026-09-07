"""Unit tests for app.agent_team.services.parallel_agent_executor.ParallelAgentExecutor.

The first four test classes/functions are ported one-to-one (same inputs,
same expected values) from the PHP oracle tests:
  - backend/tests/Unit/AgentTeam/ParallelAgentExecutorTest.php
      testTwoAgentsCompleteConcurrentlyInOneRound
      testToolCallDrivesAnotherRound
      testConcurrencyCapChunksStatesAndPreservesKeys
  - backend/tests/Unit/AgentTeam/ParallelExecutorRoundReuseTest.php
      testRunConcurrentRoundConsumesGraphShapedStates

Everything after that is this task's extra coverage (per the brief):
buildAgentLLMRequestWithTools/parseParallelLLMResponse per provider family,
a real dispatchChunk round via httpx.MockTransport proving concurrency
(overlapping timestamps) and the chunk-order result assembly rule, the
server-tool execution loop, and getProviderConfigForParallel's DB/config/
alias resolution.
"""
from __future__ import annotations

import time

import httpx
import pytest

from app.agent_team.models.agent import Agent
from app.agent_team.services.parallel_agent_executor import ParallelAgentExecutor
from app.providers._http import SHARED_SSL_CONTEXT
from app.providers.claude_provider import ClaudeProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.provider_request_factory import ProviderRequestFactory


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeToolsManager:
    def __init__(self, tool_defs=None, execute_result=None, raise_error=None):
        self.tool_defs = tool_defs if tool_defs is not None else []
        self.execute_result = execute_result if execute_result is not None else {'result': 'TOOL_OK'}
        self.raise_error = raise_error
        self.calls = []

    def getToolDefinitions(self):
        return self.tool_defs

    def execute(self, name, args):
        self.calls.append((name, args))
        if self.raise_error:
            raise self.raise_error
        return self.execute_result


class FakeAgentRunner:
    def __init__(self, tools_manager=None):
        self.tools_manager = tools_manager if tools_manager is not None else FakeToolsManager()
        self.started = []
        self.completed = []
        self._next_exec_id = 900

    def getToolsManager(self):
        return self.tools_manager

    def recordExecutionStart(self, agent, user_id, input_):
        self._next_exec_id += 1
        self.started.append((agent.getName(), user_id, input_))
        return self._next_exec_id

    def recordExecutionComplete(self, execution_id, response, response_time_ms):
        self.completed.append((execution_id, response, response_time_ms))


class FakeDb:
    def fetch_one(self, sql, params=None):
        return None


def _agent(agent_id, name, provider='claude'):
    return Agent({'id': agent_id, 'name': name, 'agent_type': 'worker', 'provider': provider, 'instructions': 'x'})


def _make_executor(record_executions=False, max_concurrency=6, tools_manager=None):
    runner = FakeAgentRunner(tools_manager)
    db = FakeDb()
    return ParallelAgentExecutor(runner, db, {}, record_executions, max_concurrency), runner


# ---------------------------------------------------------------------------
# Ported 1:1 — ParallelAgentExecutorTest::testTwoAgentsCompleteConcurrentlyInOneRound
# ---------------------------------------------------------------------------

class FakeCallLLMsExecutor(ParallelAgentExecutor):
    """Mirrors PHP's FakeExecutor: overrides callLLMs (not dispatchChunk) with
    a scripted per-round response table, exercising run()'s round loop."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.script = {}
        self.round = 0
        self.seenBatchSizes = []

    def callLLMs(self, states):
        self.seenBatchSizes.append(len(states))
        out = self.script.get(self.round, {})
        self.round += 1
        # Only answer the keys still pending this round.
        return {k: v for k, v in out.items() if k in states}


def test_two_agents_complete_concurrently_in_one_round():
    exec_, _runner = _make_executor()
    exec_ = FakeCallLLMsExecutor(exec_.agentRunner, exec_.db, {}, False)
    exec_.script = {
        0: {
            'a': {'success': True, 'parsed': {'text': 'A done', 'tool_calls': [], 'usage': None}},
            'b': {'success': True, 'parsed': {'text': 'B done', 'tool_calls': [], 'usage': None}},
        },
    }
    states = [
        {'key': 'a', 'agent': _agent(1, 'A'), 'input': 'ta',
         'messages': [{'role': 'user', 'content': 'ta'}], 'tools': [], 'tools_filter': None},
        {'key': 'b', 'agent': _agent(2, 'B'), 'input': 'tb',
         'messages': [{'role': 'user', 'content': 'tb'}], 'tools': [], 'tools_filter': None},
    ]

    res = exec_.run(states)

    assert res['a']['success'] is True
    assert res['a']['output'] == 'A done'
    assert res['b']['success'] is True
    assert res['b']['output'] == 'B done'
    # Both were dispatched in the SAME batch (concurrency, not sequential).
    assert exec_.seenBatchSizes == [2]


def test_tool_call_drives_another_round():
    exec_, _runner = _make_executor()
    exec_ = FakeCallLLMsExecutor(exec_.agentRunner, exec_.db, {}, False)
    exec_.script = {
        0: {'a': {'success': True, 'parsed': {'text': None, 'usage': None,
            'tool_calls': [{'id': 't1', 'function': {'name': 'search', 'arguments': '{}'}}]}}},
        1: {'a': {'success': True, 'parsed': {'text': 'final', 'tool_calls': [], 'usage': None}}},
    }
    states = [
        {'key': 'a', 'agent': _agent(1, 'A'), 'input': 'ta',
         'messages': [{'role': 'user', 'content': 'ta'}], 'tools': [], 'tools_filter': None},
    ]

    res = exec_.run(states)

    assert res['a']['output'] == 'final'
    assert exec_.round == 2  # took two rounds


# ---------------------------------------------------------------------------
# Ported 1:1 — ParallelAgentExecutorTest::testConcurrencyCapChunksStatesAndPreservesKeys
# ---------------------------------------------------------------------------

class ChunkSpyExecutor(ParallelAgentExecutor):
    """Mirrors PHP's ChunkSpyExecutor: overrides dispatchChunk (not callLLMs)
    so the real callLLMs() chunking/cap/key-preservation logic is exercised."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.seenChunkKeys = []
        self.seenChunkSizes = []

    def dispatchChunk(self, chunk):
        self.seenChunkKeys.append(list(chunk.keys()))
        self.seenChunkSizes.append(len(chunk))
        out = {}
        for key in chunk:
            out[key] = {'success': True, 'parsed': {'text': f'{key} done', 'tool_calls': [], 'usage': None}}
        return out


def test_concurrency_cap_chunks_states_and_preserves_keys():
    runner = FakeAgentRunner()
    db = FakeDb()
    exec_ = ChunkSpyExecutor(runner, db, {}, False, 2)  # 5th ctor arg = maxConcurrency
    states = []
    for i, key in enumerate(['a', 'b', 'c']):
        states.append({'key': key, 'agent': _agent(i + 1, key.upper()), 'input': f't{key}',
                        'messages': [{'role': 'user', 'content': f't{key}'}], 'tools': [], 'tools_filter': None})

    res = exec_.run(states)

    # Two chunks: first two keys, then the remaining one (the cap).
    assert exec_.seenChunkSizes == [2, 1]
    assert exec_.seenChunkKeys == [['a', 'b'], ['c']]
    # All three completed, keyed by their original string keys (preserve_keys).
    assert list(res.keys()) == ['a', 'b', 'c']
    assert res['a']['output'] == 'a done'
    assert res['b']['output'] == 'b done'
    assert res['c']['output'] == 'c done'
    assert res['a']['success'] and res['b']['success'] and res['c']['success']


# ---------------------------------------------------------------------------
# Ported 1:1 — ParallelExecutorRoundReuseTest::testRunConcurrentRoundConsumesGraphShapedStates
# ---------------------------------------------------------------------------

class RoundSpyExecutor(ParallelAgentExecutor):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.seenKeys = []

    def dispatchChunk(self, chunk):
        self.seenKeys.append(list(chunk.keys()))
        out = {}
        for k in chunk:
            out[k] = {'success': True, 'parsed': {'text': f'resp-{k}', 'tool_calls': [], 'usage': None}}
        return out


def test_run_concurrent_round_consumes_graph_shaped_states():
    runner = FakeAgentRunner()
    db = FakeDb()
    exec_ = RoundSpyExecutor(runner, db, {}, False)

    agent = _agent(1, 'N1')
    states = {
        101: {'agent': agent, 'messages': [{'role': 'user', 'content': 'x'}],
              'tools': [], 'force_skill': False, 'skill_ran': False},
        102: {'agent': agent, 'messages': [{'role': 'user', 'content': 'y'}],
              'tools': [], 'force_skill': False, 'skill_ran': False},
    }

    responses = exec_.runConcurrentRound(states)

    assert 101 in responses and 102 in responses
    assert responses[101]['success'] is True
    assert responses[101]['parsed']['text'] == 'resp-101'
    assert exec_.seenKeys == [[101, 102]]  # single window (<= cap 6), keys preserved


# ---------------------------------------------------------------------------
# Extra: buildAgentLLMRequestWithTools / parseParallelLLMResponse per family,
# via the real ProviderRequestFactory (no mocking of the factory itself).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('provider,expected_url_contains', [
    ('claude', 'api.anthropic.com'),
    ('openai', 'api.openai.com'),
])
def test_build_agent_llm_request_delegates_to_provider_factory(provider, expected_url_contains):
    exec_, _runner = _make_executor()
    agent = _agent(1, 'A', provider=provider)
    exec_.config = {provider: {'api_key': 'K'}}
    messages = [{'role': 'user', 'content': 'hi'}]

    request = exec_._buildAgentLLMRequestWithTools(agent, messages, [])

    assert request is not None
    assert expected_url_contains in request['url']
    assert request['provider'] == provider
    # Cross-checked against the factory directly for the same inputs.
    expected = ProviderRequestFactory.buildRequest(provider, '', messages, [], {'api_key': 'K'}, 4096, 0.7)
    assert request == expected


def test_build_agent_llm_request_returns_none_without_api_key():
    exec_, _runner = _make_executor()
    agent = _agent(1, 'A', provider='claude')
    exec_.config = {}  # no provider config anywhere -> no api_key

    assert exec_._buildAgentLLMRequestWithTools(agent, [{'role': 'user', 'content': 'hi'}], []) is None


def test_parse_parallel_llm_response_claude_and_openai_families():
    exec_, _runner = _make_executor()

    claude_decoded = {'content': [{'type': 'text', 'text': 'hi there'}], 'usage': {'input_tokens': 1, 'output_tokens': 2}}
    parsed = exec_._parseParallelLLMResponse(_dumps(claude_decoded), 'claude')
    assert parsed == ClaudeProvider.parseHttpResponse(claude_decoded)
    assert parsed['text'] == 'hi there'

    openai_decoded = {'choices': [{'message': {'content': 'yo'}}], 'usage': {'prompt_tokens': 3, 'completion_tokens': 4}}
    parsed2 = exec_._parseParallelLLMResponse(_dumps(openai_decoded), 'openai')
    assert parsed2 == OpenAIProvider.parseHttpResponse(openai_decoded)
    assert parsed2['text'] == 'yo'


def test_parse_parallel_llm_response_invalid_json_returns_empty_shape():
    exec_, _runner = _make_executor()
    parsed = exec_._parseParallelLLMResponse('not json', 'claude')
    assert parsed == {'text': '', 'tool_calls': [], 'usage': None}


def _dumps(obj):
    import json
    return json.dumps(obj)


# ---------------------------------------------------------------------------
# Extra: real dispatchChunk over httpx.MockTransport — proves concurrency
# (overlapping timestamps) and the chunk-order result-assembly rule.
# ---------------------------------------------------------------------------

def test_dispatch_chunk_runs_requests_concurrently_and_preserves_chunk_order():
    """Node 'slow' sleeps longer than node 'fast' inside the mock handler, but
    both were submitted to the pool at the same time (overlapping intervals),
    and the assembled dict is keyed in the ORIGINAL chunk order ('slow' then
    'fast'), not completion order — per ParallelAgentExecutor.php's
    `foreach ($curlHandles as $nodeId => $info)` collection loop. Exercises
    the real `_buildAgentLLMRequestWithTools` -> dispatch -> `_parseParallelLLMResponse`
    pipeline end to end (two OpenAI-compatible providers, no method mocking)."""
    intervals = {}

    def handler(request: httpx.Request) -> httpx.Response:
        node = request.url.params.get('node')
        start = time.time()
        delay = 0.15 if node == 'slow' else 0.02
        time.sleep(delay)
        intervals[node] = (start, time.time())
        return httpx.Response(200, json={
            'choices': [{'message': {'content': f'{node} says hi'}}],
            'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
        })

    runner = FakeAgentRunner()
    db = FakeDb()
    config = {
        'openai': {'api_key': 'K', 'base_url': 'https://x.example', 'chat_endpoint': '/c?node=slow'},
        'deepseek': {'api_key': 'K', 'base_url': 'https://x.example', 'chat_endpoint': '/c?node=fast'},
    }
    exec_ = ParallelAgentExecutor(
        runner, db, config, False,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    chunk = {
        'slow': {'agent': _agent(1, 'Slow', provider='openai'),
                 'messages': [{'role': 'user', 'content': 'x'}], 'tools': []},
        'fast': {'agent': _agent(2, 'Fast', provider='deepseek'),
                 'messages': [{'role': 'user', 'content': 'y'}], 'tools': []},
    }

    wall_start = time.time()
    responses = exec_.dispatchChunk(chunk)
    wall_elapsed = time.time() - wall_start

    assert list(responses.keys()) == ['slow', 'fast']  # chunk order preserved, not completion order
    assert responses['slow']['success'] is True
    assert responses['fast']['success'] is True
    assert responses['slow']['parsed']['text'] == 'slow says hi'
    assert responses['fast']['parsed']['text'] == 'fast says hi'

    slow_start, slow_end = intervals['slow']
    fast_start, fast_end = intervals['fast']
    # Concurrency proof: 'fast' started before 'slow' finished (its interval
    # overlaps 'slow's) — a sequential dispatch could never overlap.
    assert fast_start < slow_end
    # And the whole chunk took roughly max(delay), not the sum of both.
    assert wall_elapsed < 0.15 + 0.02


# ---------------------------------------------------------------------------
# Extra: server-tool execution loop (executeServerTool).
# ---------------------------------------------------------------------------

def test_execute_server_tool_returns_json_encoded_result():
    tools = FakeToolsManager(execute_result={'result': 'TOOL_OK'})
    exec_, runner = _make_executor(tools_manager=tools)

    tool_call = {'id': 't1', 'function': {'name': 'search', 'arguments': '{"q": "hi"}'}}
    content = exec_._executeServerTool(tool_call, None)

    assert tools.calls == [('search', {'q': 'hi'})]
    import json
    assert json.loads(content) == {'result': 'TOOL_OK'}


def test_execute_server_tool_string_result_passed_through():
    tools = FakeToolsManager(execute_result='already a string')
    exec_, runner = _make_executor(tools_manager=tools)
    content = exec_._executeServerTool({'id': 't1', 'function': {'name': 'x', 'arguments': '{}'}}, None)
    assert content == 'already a string'


def test_execute_server_tool_swallows_exception_as_json_error():
    tools = FakeToolsManager(raise_error=RuntimeError('boom'))
    exec_, runner = _make_executor(tools_manager=tools)
    content = exec_._executeServerTool({'id': 't1', 'function': {'name': 'x', 'arguments': '{}'}}, None)
    import json
    assert json.loads(content) == {'error': 'boom'}


def test_run_end_to_end_executes_server_tool_via_dispatch_chunk():
    """Full run() loop: round 1 gets a tool_call, executeServerTool runs
    against the fake ToolsManager, round 2 (scripted) returns final text."""
    tools = FakeToolsManager(execute_result={'result': 'TOOL_OK'})

    class ScriptedExec(ParallelAgentExecutor):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.round = 0

        def callLLMs(self, states):
            if self.round == 0:
                self.round += 1
                return {k: {'success': True, 'parsed': {'text': None, 'usage': None,
                    'tool_calls': [{'id': 't1', 'function': {'name': 'search', 'arguments': '{}'}}]}} for k in states}
            return {k: {'success': True, 'parsed': {'text': 'done after tool', 'tool_calls': [], 'usage': None}} for k in states}

    runner = FakeAgentRunner(tools)
    exec_ = ScriptedExec(runner, FakeDb(), {}, False)
    states = [{'key': 'a', 'agent': _agent(1, 'A'), 'input': 'ta',
               'messages': [{'role': 'user', 'content': 'ta'}], 'tools': [], 'tools_filter': None}]

    res = exec_.run(states)

    assert res['a']['output'] == 'done after tool'
    # json_decode('{}', true) is PHP-indistinguishable from an empty array —
    # php_json_decode mirrors that, so an empty-object arguments string
    # decodes to [] here exactly as it would server-side in PHP.
    assert tools.calls == [('search', [])]


# ---------------------------------------------------------------------------
# Extra: buildToolsFor.
# ---------------------------------------------------------------------------

def test_build_tools_for_returns_all_when_no_filter():
    tools = FakeToolsManager(tool_defs=[{'name': 'a'}, {'name': 'b'}])
    exec_, runner = _make_executor(tools_manager=tools)
    assert exec_.buildToolsFor(_agent(1, 'A'), None) == [{'name': 'a'}, {'name': 'b'}]


def test_build_tools_for_filters_by_name():
    tools = FakeToolsManager(tool_defs=[{'name': 'a'}, {'name': 'b'}, {'name': 'c'}])
    exec_, runner = _make_executor(tools_manager=tools)
    assert exec_.buildToolsFor(_agent(1, 'A'), ['b', 'c']) == [{'name': 'b'}, {'name': 'c'}]


# ---------------------------------------------------------------------------
# Extra: getProviderConfigForParallel — DB row, config-file fallback, aliases.
# ---------------------------------------------------------------------------

class DbWithRow:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append(params)
        return self.row


def test_provider_config_prefers_db_row_over_config_file():
    row = {'api_key': 'db-key', 'model': 'db-model', 'base_url': 'https://db.example',
           'max_tokens': 555, 'temperature': '0.42', 'chat_endpoint': '/v1/db'}
    db = DbWithRow(row)
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, db, {'claude': {'api_key': 'file-key'}}, False)

    cfg = exec_._getProviderConfigForParallel('claude')

    assert cfg == {
        'api_key': 'db-key', 'model': 'db-model', 'base_url': 'https://db.example',
        'max_tokens': 555, 'temperature': 0.42, 'chat_endpoint': '/v1/db',
    }
    assert db.calls == [{'key1': 'claude', 'key2': 'anthropic'}]


def test_provider_config_alias_key_query_direction():
    """Calling with the ALIAS name ('anthropic') queries primary+alias the
    other way: key1='claude' (primary), key2='anthropic' has no alternate of
    its own, so key2 falls back to primary too."""
    db = DbWithRow(None)
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, db, {}, False)

    exec_._getProviderConfigForParallel('anthropic')

    assert db.calls == [{'key1': 'claude', 'key2': 'claude'}]


def test_provider_config_db_key_falls_back_to_config_api_key_when_blank():
    row = {'api_key': '', 'model': '', 'base_url': '', 'max_tokens': None, 'temperature': None, 'chat_endpoint': ''}
    db = DbWithRow(row)
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, db, {'claude': {'api_key': 'file-key', 'model': 'file-model'}}, False)

    cfg = exec_._getProviderConfigForParallel('claude')

    assert cfg['api_key'] == 'file-key'
    assert cfg['model'] == 'file-model'
    assert cfg['max_tokens'] == 4096
    assert cfg['temperature'] is None
    assert cfg['chat_endpoint'] == '/v1/chat/completions'


def test_provider_config_falls_back_to_config_file_when_no_db_row():
    db = DbWithRow(None)
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, db, {'providers': {'claude': {'api_key': 'from-providers-block'}}}, False)

    cfg = exec_._getProviderConfigForParallel('claude')

    assert cfg == {'api_key': 'from-providers-block'}


def test_provider_config_db_error_falls_back_to_config_file():
    class ExplodingDb:
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db down')

    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, ExplodingDb(), {'claude': {'api_key': 'file-key'}}, False)

    cfg = exec_._getProviderConfigForParallel('claude')

    assert cfg == {'api_key': 'file-key'}


# ---------------------------------------------------------------------------
# Extra: close() — owned vs. injected httpx client (fix round 1).
# ---------------------------------------------------------------------------

def test_close_closes_the_owned_client():
    """No http_client injected -> the executor created its own -> close()
    releases it."""
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, FakeDb(), {}, False)

    assert exec_._httpClient.is_closed is False
    exec_.close()
    assert exec_._httpClient.is_closed is True


def test_close_does_not_close_an_injected_client():
    """An injected http_client belongs to its caller — close() must leave it
    open so the caller can keep using/closing it themselves."""
    injected = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, FakeDb(), {}, False, http_client=injected)

    exec_.close()

    assert injected.is_closed is False
    injected.close()  # cleanup


def test_close_is_idempotent():
    runner = FakeAgentRunner()
    exec_ = ParallelAgentExecutor(runner, FakeDb(), {}, False)

    exec_.close()
    exec_.close()  # must not raise

    assert exec_._httpClient.is_closed is True
