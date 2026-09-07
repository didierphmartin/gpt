"""Unit tests for app.agent_team.services.agent_runner.AgentRunner
(port of AgentTeam/Services/AgentRunner.php, 935 lines).

No PHP oracle test exists for this class (confirmed via `find backend/tests
-iname '*AgentRunner*'` returning nothing), so these are written directly
from the PHP source per the Phase 5 Task 2 brief's "Unit cases" list:
buildOptions per agent kind (manager/worker/standard; tools filter;
provider/model never-override-agent-form-params), buildMessages shape,
buildToolsForAgent (MCP + delegation names), execution-row SQL/params
(byte-identical to PHP), run() happy path with a fake LLMManager, and
streamRun()'s event sequence through a real StreamContext with a recording
callback.

`private` PHP methods -> `_name`; called directly here (matching the rest
of this test suite's convention of exercising `_`-prefixed ported methods,
e.g. tests/unit/test_workflow_runner.py).
"""
from __future__ import annotations

from app.agent_team.models.agent import Agent
from app.agent_team.services.agent_runner import AgentRunner
from app.support.phpjson import php_json_decode


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeDb:
    def __init__(self):
        self.inserts: list = []
        self.executes: list = []
        self.fetch_all_calls: list = []
        self.fetch_all_result: list = []
        self._next_id = 100

    def fetch_one(self, sql, params=None):
        return {'1': 1}

    def insert(self, sql, params=None):
        self.inserts.append((sql, params))
        self._next_id += 1
        return self._next_id

    def execute(self, sql, params=None):
        self.executes.append((sql, params))
        return 1

    def fetch_all(self, sql, params=None):
        self.fetch_all_calls.append((sql, params))
        return self.fetch_all_result


class FakeToolsManager:
    def __init__(self, tool_defs=None):
        self.tool_defs = tool_defs if tool_defs is not None else [
            {'name': 'search', 'description': 's', 'input_schema': {'type': 'object'}},
        ]

    def getToolDefinitions(self):
        return list(self.tool_defs)

    def execute(self, name, args, context=None):
        return {'ok': True}


class FakeMcpLoader:
    def __init__(self, tool_defs=None):
        self.tool_defs = tool_defs if tool_defs is not None else []

    def getToolDefinitions(self):
        return list(self.tool_defs)


class FakeLLMManager:
    def __init__(self, providers=None):
        self.providers = providers if providers is not None else {}

    def getProvider(self, name):
        return self.providers.get(name)


class FakeProvider:
    """Mirrors the subset of ClaudeProvider's interface AgentRunner touches:
    setModel/getModel, setFunctionExecutor, chat, streamChat."""

    def __init__(self, chat_response=None, stream_response=None, model='claude-default',
                 stream_chunks=('Hel', 'lo')):
        self.chat_response = chat_response if chat_response is not None else {
            'text': 'hi', 'usage': {'input_tokens': 1, 'output_tokens': 2}, 'functions_called': [],
        }
        self.stream_response = stream_response if stream_response is not None else {'usage': {}, 'tool_calls': []}
        self.model = model
        self.function_executor = None
        self.set_model_calls: list = []
        self.chat_calls: list = []
        self.stream_calls: list = []
        self._stream_chunks = stream_chunks

    def setModel(self, model):
        self.set_model_calls.append(model)
        self.model = model

    def getModel(self):
        return self.model

    def setFunctionExecutor(self, executor):
        self.function_executor = executor

    def chat(self, message, messages, options):
        self.chat_calls.append((message, messages, options))
        return self.chat_response

    def streamChat(self, message, on_chunk, messages, options):
        self.stream_calls.append((message, messages, options))
        for c in self._stream_chunks:
            on_chunk({'text': c})
        return self.stream_response


class ExplodingStreamProvider(FakeProvider):
    def streamChat(self, message, on_chunk, messages, options):
        raise RuntimeError('stream boom')


def _agent(id=1, name='Agent1', provider='claude', model=None, agent_type='standard',
           settings=None, tools=None, enabled=True):
    return Agent({
        'id': id, 'name': name, 'provider': provider, 'model': model,
        'agent_type': agent_type,
        'settings': settings if settings is not None else [],
        'tools': tools if tools is not None else [],
        'instructions': 'be helpful', 'description': 'test agent', 'enabled': enabled,
    })


def _make_runner(llm_manager=None, tools_manager=None, mcp_loader=None, db=None, config=None):
    return AgentRunner(
        llm_manager if llm_manager is not None else FakeLLMManager({}),
        tools_manager if tools_manager is not None else FakeToolsManager(),
        mcp_loader,
        db if db is not None else FakeDb(),
        config if config is not None else {},
    )


# ---------------------------------------------------------------------------
# _buildOptions — PHP 607-634
# ---------------------------------------------------------------------------

def test_build_options_minimal_agent_only_has_system_prompt():
    runner = _make_runner()
    a = _agent()
    options = runner._buildOptions(a)
    assert options == {'system_prompt': a.buildSystemPrompt()}


def test_build_options_temperature_max_tokens_thinking():
    runner = _make_runner()
    a = _agent(settings={'temperature': '0.7', 'max_tokens': '512', 'thinking': 'on'})
    options = runner._buildOptions(a)
    assert options['temperature'] == 0.7
    assert isinstance(options['temperature'], float)
    assert options['max_tokens'] == 512
    assert isinstance(options['max_tokens'], int)
    assert options['thinking'] == 'on'


def test_build_options_thinking_default_is_excluded():
    runner = _make_runner()
    a = _agent(settings={'thinking': 'default'})
    options = runner._buildOptions(a)
    assert 'thinking' not in options


def test_build_options_manager_and_worker_and_standard_are_identical_shape():
    """buildOptions() itself doesn't branch on agent_type at all (PHP
    607-634) -- manager/worker/standard all get the same {temperature?,
    max_tokens?, thinking?, system_prompt} shape. The manager/worker
    difference lives entirely in _buildToolsForAgent, not buildOptions."""
    runner = _make_runner()
    for kind in ('manager', 'worker', 'standard'):
        a = _agent(agent_type=kind, settings={'temperature': 0.3})
        options = runner._buildOptions(a)
        assert set(options.keys()) == {'temperature', 'system_prompt'}


def test_build_options_empty_settings_list_is_ignored():
    """Agent.settings defaults to `[]` (PHP empty array) -- isset() checks
    on a list must not crash and must not populate temperature/max_tokens."""
    runner = _make_runner()
    a = _agent(settings=[])
    options = runner._buildOptions(a)
    assert options == {'system_prompt': a.buildSystemPrompt()}


# ---------------------------------------------------------------------------
# _buildMessages — PHP 639-651
# ---------------------------------------------------------------------------

def test_build_messages_filters_invalid_entries_and_ignores_system_prompt_and_input():
    runner = _make_runner()
    history = [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant'},          # missing content -> dropped
        {'content': 'no role'},         # missing role -> dropped
        'not a dict',                   # dropped
        {'role': 'assistant', 'content': 'ok'},
    ]
    messages = runner._buildMessages('SYSTEM PROMPT TEXT', history, 'THE INPUT')
    assert messages == [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'ok'},
    ]
    # Neither systemPrompt nor input appear anywhere in the output (PHP's
    # buildMessages body never references either parameter).
    for m in messages:
        assert 'SYSTEM PROMPT TEXT' not in str(m)
        assert 'THE INPUT' not in str(m)


def test_build_messages_empty_history():
    runner = _make_runner()
    assert runner._buildMessages('sp', [], 'in') == []


# ---------------------------------------------------------------------------
# _buildToolsForAgent — PHP 522-602
# ---------------------------------------------------------------------------

def test_build_tools_for_agent_manager_returns_only_delegation_tools_in_order():
    runner = _make_runner(db=FakeDb())
    mgr = _agent(id=1, agent_type='manager')
    tools = runner._buildToolsForAgent(mgr, None)
    assert [t['name'] for t in tools] == [
        'list_available_agents', 'delegate_to_agent', 'complete_task', 'run_agents_parallel',
    ]
    for t in tools:
        assert set(t.keys()) == {'name', 'description', 'input_schema'}
        assert t['description']  # non-empty
        assert 'type' in t['input_schema']


def test_build_tools_for_agent_worker_merges_builtin_then_mcp():
    tools_mgr = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 's', 'input_schema': {}}])
    mcp = FakeMcpLoader(tool_defs=[{'name': 'mcp_x', 'description': 'm', 'input_schema': {}}])
    runner = _make_runner(tools_manager=tools_mgr, mcp_loader=mcp)
    worker = _agent(agent_type='worker')
    assert [t['name'] for t in runner._buildToolsForAgent(worker, None)] == ['search', 'mcp_x']


def test_build_tools_for_agent_standard_same_as_worker():
    tools_mgr = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 's', 'input_schema': {}}])
    runner = _make_runner(tools_manager=tools_mgr)
    standard = _agent(agent_type='standard')
    assert [t['name'] for t in runner._buildToolsForAgent(standard, None)] == ['search']


def test_build_tools_for_agent_no_mcp_loader_configured():
    tools_mgr = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 's', 'input_schema': {}}])
    runner = _make_runner(tools_manager=tools_mgr, mcp_loader=None)
    worker = _agent(agent_type='worker')
    assert [t['name'] for t in runner._buildToolsForAgent(worker, None)] == ['search']


def test_build_tools_for_agent_filter_empty_list_means_no_tools():
    tools_mgr = FakeToolsManager(tool_defs=[
        {'name': 'search', 'description': 's', 'input_schema': {}},
        {'name': 'other', 'description': 'o', 'input_schema': {}},
    ])
    runner = _make_runner(tools_manager=tools_mgr)
    worker = _agent(agent_type='worker')
    assert runner._buildToolsForAgent(worker, []) == []
    assert [t['name'] for t in runner._buildToolsForAgent(worker, ['other'])] == ['other']
    assert len(runner._buildToolsForAgent(worker, None)) == 2


# ---------------------------------------------------------------------------
# Execution row CRUD — SQL byte-identical to PHP (PHP 656-763)
# ---------------------------------------------------------------------------

def test_create_execution_sql_and_params():
    db = FakeDb()
    runner = _make_runner(db=db)
    a = _agent(id=5, provider='claude', model='m1', agent_type='worker')

    execId = runner._createExecution(a, 3, 'hello', {'parent_execution_id': 9})

    assert execId == 101
    sql, params = db.inserts[0]
    assert sql == (
        "INSERT INTO agent_executions\n"
        "                 (agent_id, user_id, parent_execution_id, input, status, metadata)\n"
        "                 VALUES (?, ?, ?, ?, 'running', ?)"
    )
    assert params[:4] == [5, 3, 9, 'hello']
    assert php_json_decode(params[4]) == {'provider': 'claude', 'model': 'm1', 'agent_type': 'worker'}


def test_create_execution_no_parent_execution_id_is_none():
    db = FakeDb()
    runner = _make_runner(db=db)
    a = _agent(id=5)
    runner._createExecution(a, 3, 'hello', {})
    _, params = db.inserts[0]
    assert params[2] is None


def test_create_execution_skips_inline_agent_with_no_id():
    db = FakeDb()
    runner = _make_runner(db=db)
    a = _agent(id=None)
    assert runner._createExecution(a, 3, 'hi', {}) == 0
    assert db.inserts == []


def test_complete_execution_sql_and_params():
    db = FakeDb()
    runner = _make_runner(db=db)

    runner._completeExecution(101, {
        'text': 'done',
        'usage': {'input_tokens': 3, 'output_tokens': 4},
        'tool_calls': [{'name': 'search'}, 'raw_name', {'no_name': True}],
    }, 1234.9)

    sql, params = db.executes[0]
    assert sql == (
        "UPDATE agent_executions SET\n"
        "                 status = 'completed',\n"
        "                 output = ?,\n"
        "                 prompt_tokens = ?,\n"
        "                 completion_tokens = ?,\n"
        "                 tokens_used = ?,\n"
        "                 response_time_ms = ?,\n"
        "                 tools_called = ?,\n"
        "                 completed_at = NOW()\n"
        "                 WHERE id = ?"
    )
    assert params[0] == 'done'
    assert params[1] == 3
    assert params[2] == 4
    assert params[3] == 7
    assert params[4] == 1234
    assert php_json_decode(params[5]) == ['search', 'raw_name', 'unknown']
    assert params[6] == 101


def test_complete_execution_usage_fallback_keys():
    """PHP: $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0 (and the
    completion_tokens/output_tokens twin)."""
    db = FakeDb()
    runner = _make_runner(db=db)
    runner._completeExecution(101, {'usage': {'prompt_tokens': 9, 'completion_tokens': 1}}, 0)
    _, params = db.executes[0]
    assert params[1] == 9 and params[2] == 1


def test_complete_execution_noop_when_execution_id_zero():
    db = FakeDb()
    runner = _make_runner(db=db)
    runner._completeExecution(0, {'text': 'x'}, 10)
    assert db.executes == []


def test_fail_execution_sql_and_params():
    db = FakeDb()
    runner = _make_runner(db=db)
    runner._failExecution(101, 'boom')
    sql, params = db.executes[0]
    assert sql == (
        "UPDATE agent_executions SET\n"
        "                 status = 'failed',\n"
        "                 error_message = ?,\n"
        "                 completed_at = NOW()\n"
        "                 WHERE id = ?"
    )
    assert params == ['boom', 101]


def test_fail_execution_noop_when_execution_id_zero():
    db = FakeDb()
    runner = _make_runner(db=db)
    runner._failExecution(0, 'boom')
    assert db.executes == []


def test_get_execution_history_sql_and_params():
    db = FakeDb()
    db.fetch_all_result = [{'id': 1, 'agent_id': 5}]
    runner = _make_runner(db=db)
    rows = runner.getExecutionHistory(5, 10, 20)
    sql, params = db.fetch_all_calls[0]
    assert sql == (
        "SELECT * FROM agent_executions\n"
        "             WHERE agent_id = ?\n"
        "             ORDER BY started_at DESC\n"
        "             LIMIT ? OFFSET ?"
    )
    assert params == [5, 10, 20]
    assert rows == [{'id': 1, 'agent_id': 5}]


def test_get_child_executions_sql_and_params():
    db = FakeDb()
    runner = _make_runner(db=db)
    runner.getChildExecutions(9)
    sql, params = db.fetch_all_calls[0]
    assert sql == (
        "SELECT e.*, a.name as agent_name\n"
        "             FROM agent_executions e\n"
        "             JOIN agents a ON e.agent_id = a.id\n"
        "             WHERE e.parent_execution_id = ?\n"
        "             ORDER BY e.started_at ASC"
    )
    assert params == [9]


# ---------------------------------------------------------------------------
# run() — PHP 75-271
# ---------------------------------------------------------------------------

def test_run_happy_path_worker():
    provider = FakeProvider(chat_response={
        'text': 'answer', 'usage': {'input_tokens': 5, 'output_tokens': 6},
        'functions_called': [{'name': 'search'}],
    })
    llm = FakeLLMManager({'claude': provider})
    db = FakeDb()
    tools_mgr = FakeToolsManager()
    runner = _make_runner(llm_manager=llm, db=db, tools_manager=tools_mgr)
    a = _agent(id=5, name='Worker1', provider='claude', model='claude-x', agent_type='worker',
               settings={'temperature': 0.5})

    result = runner.run(a, 'hi there', [{'role': 'user', 'content': 'prev'}], 3, {})

    assert result['success'] is True
    assert result['text'] == 'answer'
    assert result['usage'] == {'input_tokens': 5, 'output_tokens': 6}
    assert result['tools_used'] == [{'name': 'search'}]
    assert result['agent'] == {'id': 5, 'name': 'Worker1', 'type': 'worker'}
    assert result['provider'] == 'claude'
    assert result['model'] == 'claude-x'
    assert isinstance(result['response_time_ms'], int)
    assert result['execution_id'] == 101

    assert provider.set_model_calls == ['claude-x']
    message, messages, options = provider.chat_calls[0]
    assert message == 'hi there'
    assert messages == [{'role': 'user', 'content': 'prev'}]
    assert options['system_prompt'] == a.buildSystemPrompt()
    assert options['temperature'] == 0.5
    assert options['user_id'] == 3
    assert 'tool_choice' not in options  # not forced for non-manager
    assert [t['name'] for t in options['tools']] == ['search']

    assert len(db.inserts) == 1  # execution created
    assert len(db.executes) == 1 and "status = 'completed'" in db.executes[0][0]


def test_run_manager_forces_tool_choice_required_and_delegation_tools_only():
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    mgr = _agent(id=1, provider='claude', agent_type='manager')

    runner.run(mgr, 'go', [], 3, {})

    _, _, options = provider.chat_calls[0]
    assert options['tool_choice'] == 'required'
    assert [t['name'] for t in options['tools']] == [
        'list_available_agents', 'delegate_to_agent', 'complete_task', 'run_agents_parallel',
    ]


def test_run_caller_tool_choice_overrides_manager_default():
    """never-override-agent-form-params still lets the CALLER (workflow
    runner) override tool_choice per-call -- PHP 159-161."""
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    mgr = _agent(id=1, provider='claude', agent_type='manager')

    runner.run(mgr, 'go', [], 3, {'tool_choice': 'auto'})

    _, _, options = provider.chat_calls[0]
    assert options['tool_choice'] == 'auto'


def test_run_extra_tools_appended_after_agent_tools():
    tools_mgr = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 's', 'input_schema': {}}])
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm, tools_manager=tools_mgr)
    worker = _agent(id=2, provider='claude', agent_type='worker')
    extra = {'name': 'run_skill_script', 'description': 'x', 'input_schema': {'type': 'object'}}

    runner.run(worker, 'go', [], 3, {'extra_tools': [extra]})

    _, _, options = provider.chat_calls[0]
    assert [t['name'] for t in options['tools']] == ['search', 'run_skill_script']


def test_run_skill_metadata_and_output_schema_passthrough():
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    worker = _agent(id=2, provider='claude', agent_type='worker')

    runner.run(worker, 'go', [], 3, {
        'skill_metadata': {'dir_name': 'html', 'scripts': ['create.py']},
        'output_schema': {'type': 'object', 'properties': {}},
    })

    _, _, options = provider.chat_calls[0]
    assert options['skill_metadata'] == {'dir_name': 'html', 'scripts': ['create.py']}
    assert options['output_schema'] == {'type': 'object', 'properties': {}}


def test_run_tools_filter_empty_list_omits_tools_key():
    tools_mgr = FakeToolsManager(tool_defs=[{'name': 'search', 'description': 's', 'input_schema': {}}])
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm, tools_manager=tools_mgr)
    worker = _agent(id=2, provider='claude', agent_type='worker')

    runner.run(worker, 'go', [], 3, {'tools_filter': []})

    _, _, options = provider.chat_calls[0]
    assert 'tools' not in options


def test_run_model_none_falls_back_to_provider_default_model_never_overridden():
    """never-override-agent-form-params, negative case: when the agent form
    doesn't set a model, the provider's own default is surfaced verbatim
    (PHP 117-119, 229) -- provider.setModel() is never called with a
    fabricated value."""
    provider = FakeProvider(model='provider-default-model')
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    worker = _agent(id=2, provider='claude', model=None, agent_type='worker')

    result = runner.run(worker, 'go', [], 3, {})

    assert provider.set_model_calls == []
    assert result['model'] == 'provider-default-model'


def test_run_model_empty_string_kept_verbatim_not_treated_as_unset():
    """Caught live via the differential test against agent id 25
    ("Transformer to Medium format", `model` column is '' in the DB): PHP's
    `$agent->getModel() ?? $provider->getModel()` (AgentRunner.php:229) is
    NULL-COALESCING, not a truthy/`?:` check -- '' is not null, so PHP keeps
    it verbatim and does NOT fall back to the provider's default model.
    provider.setModel() is still skipped for a falsy model (PHP's separate
    truthy `if ($agent->getModel())` at PHP 117-119)."""
    provider = FakeProvider(model='provider-default-model')
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    worker = _agent(id=2, provider='claude', model='', agent_type='worker')

    result = runner.run(worker, 'go', [], 3, {})

    assert provider.set_model_calls == []
    assert result['model'] == ''


def test_run_provider_not_found_fails_execution():
    llm = FakeLLMManager({})
    db = FakeDb()
    runner = _make_runner(llm_manager=llm, db=db)
    a = _agent(id=2, name='Ghosted', provider='ghost', agent_type='worker')

    result = runner.run(a, 'hi', [], 3, {})

    assert result == {
        'success': False,
        'error': "Provider 'ghost' not found",
        'execution_id': 101,
        'agent': {'id': 2, 'name': 'Ghosted'},
    }
    assert any("status = 'failed'" in sql for sql, _ in db.executes)


def test_run_pending_client_tool_call_marker_surfaced():
    provider = FakeProvider(chat_response={
        'text': 'partial', 'usage': {}, 'functions_called': [],
        'pending_client_tool_call': True, 'pending_tool_calls': [{'name': 'run_skill_script'}],
        'assistant_reasoning': 'thinking...',
    })
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    a = _agent(id=2, provider='claude', agent_type='worker')

    result = runner.run(a, 'go', [], 3, {})

    assert result['pending_client_tool_call'] is True
    assert result['pending_tool_calls'] == [{'name': 'run_skill_script'}]
    assert result['pending_assistant_text'] == 'partial'
    assert result['pending_assistant_reasoning'] == 'thinking...'


def test_run_inline_agent_skips_execution_record_but_still_runs():
    provider = FakeProvider()
    llm = FakeLLMManager({'claude': provider})
    db = FakeDb()
    runner = _make_runner(llm_manager=llm, db=db)
    a = _agent(id=None, provider='claude', agent_type='worker')

    result = runner.run(a, 'go', [], 3, {})

    assert result['success'] is True
    assert result['execution_id'] == 0
    assert db.inserts == []


# ---------------------------------------------------------------------------
# streamRun() — PHP 335-496, event sequence through a real StreamContext
# ---------------------------------------------------------------------------

def test_stream_run_emits_agent_start_chunks_then_agent_complete_in_order():
    provider = FakeProvider(stream_response={'usage': {'input_tokens': 1}, 'tool_calls': []},
                             stream_chunks=('Hel', 'lo'))
    llm = FakeLLMManager({'claude': provider})
    db = FakeDb()
    runner = _make_runner(llm_manager=llm, db=db)
    a = _agent(id=3, name='Bob', provider='claude', agent_type='worker')

    events: list = []
    result = runner.streamRun(a, 'hi', [], 3, lambda ev: events.append(ev), {})

    assert result['success'] is True
    assert result['text'] == 'Hello'
    assert result['execution_id'] == 101

    types = [e['type'] for e in events]
    assert types == ['agent_start', 'chunk', 'chunk', 'agent_complete']
    assert events[0]['agent_id'] == 3 and events[0]['agent_name'] == 'Bob'
    assert [e['text'] for e in events if e['type'] == 'chunk'] == ['Hel', 'lo']
    assert events[-1]['success'] is True and events[-1]['execution_id'] == 101

    sc = runner.getStreamContext()
    assert sc is not None
    assert sc.getRootExecutionId() == 101


def test_stream_run_reuses_existing_stream_context_and_keeps_first_root_execution_id():
    provider = FakeProvider(stream_chunks=())
    llm = FakeLLMManager({'claude': provider})
    runner = _make_runner(llm_manager=llm)
    a1 = _agent(id=1, provider='claude', agent_type='worker')
    a2 = _agent(id=2, provider='claude', agent_type='worker')

    events: list = []
    r1 = runner.streamRun(a1, 'first', [], 3, lambda ev: events.append(ev), {})
    r2 = runner.streamRun(a2, 'second', [], 3, lambda ev: events.append(ev), {})

    # Same StreamContext instance reused; root execution id stays the FIRST
    # agent's (PHP 354-356: `if (!$this->streamContext->getRootExecutionId())`).
    assert runner.getStreamContext().getRootExecutionId() == r1['execution_id']
    assert r2['execution_id'] != r1['execution_id']


def test_stream_run_error_path_emits_agent_complete_false_then_error():
    provider = ExplodingStreamProvider()
    llm = FakeLLMManager({'claude': provider})
    db = FakeDb()
    runner = _make_runner(llm_manager=llm, db=db)
    a = _agent(id=4, provider='claude', agent_type='worker')

    events: list = []
    result = runner.streamRun(a, 'hi', [], 3, lambda ev: events.append(ev), {})

    assert result['success'] is False
    assert result['error'] == 'stream boom'

    types = [e['type'] for e in events]
    assert types == ['agent_start', 'agent_complete', 'error']
    assert events[1]['success'] is False and events[1]['error'] == 'stream boom'
    assert events[2]['error'] == 'stream boom' and events[2]['agent_id'] == 4
    assert any("status = 'failed'" in sql for sql, _ in db.executes)


def test_stream_run_provider_not_found():
    llm = FakeLLMManager({})
    runner = _make_runner(llm_manager=llm)
    a = _agent(id=4, provider='ghost', agent_type='worker')

    events: list = []
    result = runner.streamRun(a, 'hi', [], 3, lambda ev: events.append(ev), {})

    assert result['success'] is False
    assert result['error'] == "Provider 'ghost' not found"
    assert [e['type'] for e in events] == ['agent_start', 'agent_complete', 'error']


# ---------------------------------------------------------------------------
# createParallelExecutor — lazy import (PHP 930-934)
# ---------------------------------------------------------------------------

def test_create_parallel_executor_returns_a_wired_parallel_agent_executor():
    from app.agent_team.services.parallel_agent_executor import ParallelAgentExecutor

    db = FakeDb()
    runner = _make_runner(db=db, config={'x': 1})
    executor = runner.createParallelExecutor(True)

    assert isinstance(executor, ParallelAgentExecutor)
    assert executor.agentRunner is runner
    assert executor.recordExecutions is True
