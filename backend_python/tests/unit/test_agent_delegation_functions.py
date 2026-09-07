"""Tests for app.agent_team.functions.agent_delegation_functions.AgentDelegationFunctions
(port of AgentTeam/Functions/AgentDelegationFunctions.php, 648 lines).

Phase 2c ported/tested only the static `getToolNames()` (kept green below,
unchanged). Phase 5, Task 2 ports the full class; the tests below are a
one-to-one port of the PHP oracle tests:
  - backend/tests/Unit/AgentTeam/AgentDelegationFunctionsTest.php
  - backend/tests/Unit/AgentTeam/RunAgentsParallelTest.php
plus extra coverage for branches those oracle tests don't reach (permission
checks, completeTask, context extraction on the actual instance handlers
rather than just listAvailableAgents).
"""
from __future__ import annotations

from app.agent_team.functions.agent_delegation_functions import AgentDelegationFunctions
from app.agent_team.models.agent import Agent
from app.agent_team.services.stream_context import StreamContext


def test_tool_names_match_php():
    assert AgentDelegationFunctions.getToolNames() == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeAgentRepository:
    def __init__(self):
        self.by_name: dict = {}
        self.by_id: dict = {}
        self.accessible: list = []
        self.workers: dict = {}
        self.calls: list = []

    def findByName(self, name, user_id):
        self.calls.append(('findByName', name, user_id))
        return self.by_name.get(name)

    def findById(self, agent_id):
        self.calls.append(('findById', agent_id))
        return self.by_id.get(agent_id)

    def findAccessibleByUser(self, user_id, filters=None):
        self.calls.append(('findAccessibleByUser', user_id, filters))
        return self.accessible

    def findWorkerAgents(self, manager_id):
        self.calls.append(('findWorkerAgents', manager_id))
        return self.workers.get(manager_id, [])


class FakeAgentRunner:
    def __init__(self, repo=None):
        self.repo = repo if repo is not None else FakeAgentRepository()
        self.run_result = {'success': True, 'text': 'ok', 'tools_used': [], 'execution_id': 42}
        self.run_exception = None
        self.run_calls: list = []
        self.stream_context = None
        self.available_workers: list = []
        # Real AgentRunner.createParallelExecutor() never returns None (PHP
        # has no nullable variant either) -- default to a real fake here so
        # tests that don't override it still exercise `executor.close()`.
        self.parallel_executor = FakeParallelExecutor()
        self.parallel_executor_calls: list = []

    def getFreshRepository(self):
        return self.repo

    def run(self, agent, input_, conversation_history, user_id, context):
        self.run_calls.append((agent, input_, conversation_history, user_id, context))
        if self.run_exception:
            raise self.run_exception
        return self.run_result

    def setStreamContext(self, sc):
        self.stream_context = sc

    def getAvailableWorkers(self, manager_id):
        return self.available_workers

    def createParallelExecutor(self, record_executions):
        self.parallel_executor_calls.append(record_executions)
        return self.parallel_executor


class FakeParallelExecutor:
    def __init__(self, run_result=None):
        self.run_result = run_result if run_result is not None else {}
        self.build_tools_calls: list = []
        self.run_calls: list = []
        self.close_calls = 0

    def buildToolsFor(self, agent, tools_filter):
        self.build_tools_calls.append((agent, tools_filter))
        return []

    def run(self, states):
        self.run_calls.append(states)
        return self.run_result

    def close(self):
        self.close_calls += 1


def _worker(id=5, name='Researcher', provider='claude', tools=None, enabled=True):
    return Agent({'id': id, 'name': name, 'agent_type': 'worker', 'provider': provider,
                  'tools': tools if tools is not None else [], 'enabled': enabled})


def _manager(id=1, name='Manager', can_delegate_to=None):
    return Agent({'id': id, 'name': name, 'agent_type': 'manager',
                  'can_delegate_to': can_delegate_to if can_delegate_to is not None else []})


def _fns(repo=None, runner=None):
    repo = repo if repo is not None else FakeAgentRepository()
    runner = runner if runner is not None else FakeAgentRunner(repo)
    return AgentDelegationFunctions(repo, runner), repo, runner


# ---------------------------------------------------------------------------
# getAllFunctions — AgentDelegationFunctionsTest::testGetAllFunctionsReturnsExpectedFunctions/
# testEachFunctionHasHandlerAndSchema/testDelegateToAgentSchema/
# testListAvailableAgentsSchema/testRunAgentsParallelSchema
# ---------------------------------------------------------------------------

def test_get_all_functions_returns_expected_functions():
    fns, _, _ = _fns()
    functions = fns.getAllFunctions()
    assert 'delegate_to_agent' in functions
    assert 'list_available_agents' in functions
    assert 'run_agents_parallel' in functions
    assert 'complete_task' in functions


def test_each_function_has_handler_and_schema():
    fns, _, _ = _fns()
    for name, func in fns.getAllFunctions().items():
        assert 'handler' in func, f'{name} should have handler'
        assert 'schema' in func, f'{name} should have schema'
        assert 'description' in func['schema'], f'{name} should have description'
        assert 'input_schema' in func['schema'], f'{name} should have input_schema'
        assert callable(func['handler'])


def test_delegate_to_agent_schema():
    fns, _, _ = _fns()
    schema = fns.getAllFunctions()['delegate_to_agent']['schema']
    assert 'delegate' in schema['description'].lower()
    properties = schema['input_schema']['properties']
    assert 'agent_id' in properties
    assert 'agent_name' in properties
    assert 'task' in properties
    assert 'context' in properties
    assert 'task' in schema['input_schema']['required']


def test_list_available_agents_schema():
    fns, _, _ = _fns()
    schema = fns.getAllFunctions()['list_available_agents']['schema']
    assert 'list' in schema['description'].lower()
    assert 'agent_type' in schema['input_schema']['properties']


def test_run_agents_parallel_schema():
    fns, _, _ = _fns()
    schema = fns.getAllFunctions()['run_agents_parallel']['schema']
    assert 'parallel' in schema['description'].lower()
    assert 'delegations' in schema['input_schema']['properties']
    assert 'delegations' in schema['input_schema']['required']


# ---------------------------------------------------------------------------
# delegateToAgent — AgentDelegationFunctionsTest::testDelegateToAgent*
# ---------------------------------------------------------------------------

def test_delegate_to_agent_requires_task():
    fns, _, _ = _fns()
    result = fns.delegateToAgent({'agent_name': 'Test Agent'}, {'user_id': 1})
    assert result['success'] is False
    assert 'required' in result['error']


def test_delegate_to_agent_requires_agent_identifier():
    fns, _, _ = _fns()
    result = fns.delegateToAgent({'task': 'Do something'}, {'user_id': 1})
    assert result['success'] is False
    assert 'agent_id or agent_name' in result['error']


def test_delegate_to_agent_handles_agent_not_found():
    repo = FakeAgentRepository()
    fns, repo, _ = _fns(repo)
    result = fns.delegateToAgent({'agent_name': 'NonExistent', 'task': 'Do something'}, {'user_id': 1})
    assert result['success'] is False
    assert 'not found' in result['error']
    assert ('findByName', 'NonExistent', 1) in repo.calls


def test_delegate_to_agent_agent_not_found_lists_available_workers():
    repo = FakeAgentRepository()
    repo.workers[7] = [_worker(id=8, name='Helper')]
    fns, repo, _ = _fns(repo)
    result = fns.delegateToAgent(
        {'agent_name': 'Ghost', 'task': 'x'}, {'user_id': 1, 'current_agent_id': 7},
    )
    assert result['success'] is False
    assert result['available_agents'] == ['Helper']
    assert '"Helper"' in result['error']


def test_delegate_to_agent_disabled_agent():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot', enabled=False)
    fns, _, _ = _fns(repo)
    result = fns.delegateToAgent({'agent_name': 'Bot', 'task': 'x'}, {'user_id': 1})
    assert result == {'success': False, 'error': "Agent 'Bot' is disabled"}


def test_delegate_to_agent_permission_denied():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    repo.by_id[1] = _manager(id=1, can_delegate_to=[999])  # only allowed to delegate to 999
    fns, _, _ = _fns(repo)
    result = fns.delegateToAgent(
        {'agent_name': 'Bot', 'task': 'x'}, {'user_id': 1, 'current_agent_id': 1},
    )
    assert result == {'success': False, 'error': "Manager cannot delegate to agent 'Bot'"}


def test_delegate_to_agent_success_by_name_runs_agent_and_returns_shape():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    repo.by_id[1] = _manager(id=1)  # empty can_delegate_to == delegate to anyone
    runner = FakeAgentRunner(repo)
    runner.run_result = {'success': True, 'text': 'the result', 'tools_used': ['search'], 'execution_id': 77}
    runner.available_workers = [{'name': 'Bot', 'id': 5}]
    fns, _, _ = _fns(repo, runner)

    result = fns.delegateToAgent(
        {'agent_name': 'Bot', 'task': 'Do X', 'context': 'extra info'},
        {'user_id': 1, 'current_agent_id': 1, 'execution_id': 50},
    )

    assert result['success'] is True
    assert result['delegated_to'] == 'Bot'
    assert result['agent_id'] == 5
    assert result['agent_type'] == 'worker'
    assert result['status'] == 'completed'
    assert result['result'] == 'the result'
    assert result['result_word_count'] == 2
    assert result['tools_used'] == ['search']
    assert result['execution_id'] == 77
    assert result['available_agents'] == ['Bot']
    assert 'hint' in result

    called_agent, called_input, called_history, called_user, called_context = runner.run_calls[0]
    assert called_agent.getId() == 5
    assert called_input == '## Context from Previous Analysis\nextra info\n\n## Your Task\nDo X'
    assert called_history == []
    assert called_user == 1
    assert called_context == {'parent_execution_id': 50, 'parent_agent_id': 1}


def test_delegate_to_agent_success_by_id_no_context_field():
    repo = FakeAgentRepository()
    repo.by_id[5] = _worker(id=5, name='Bot')
    runner = FakeAgentRunner(repo)
    fns, _, _ = _fns(repo, runner)

    fns.delegateToAgent({'agent_id': 5, 'task': 'Do X'}, {'user_id': 1})

    called_agent, called_input, *_rest = runner.run_calls[0]
    assert called_agent.getId() == 5
    assert called_input == 'Do X'  # no "## Context" prefix when context param absent


def test_delegate_to_agent_failed_run_result():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    runner = FakeAgentRunner(repo)
    runner.run_result = {'success': False, 'error': 'LLM exploded'}
    fns, _, _ = _fns(repo, runner)

    result = fns.delegateToAgent({'agent_name': 'Bot', 'task': 'x'}, {'user_id': 1})

    assert result == {'success': False, 'agent_name': 'Bot', 'error': 'LLM exploded'}


def test_delegate_to_agent_runner_exception_is_caught():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    runner = FakeAgentRunner(repo)
    runner.run_exception = RuntimeError('kaboom')
    fns, _, _ = _fns(repo, runner)

    result = fns.delegateToAgent({'agent_name': 'Bot', 'task': 'x'}, {'user_id': 1})

    assert result == {'success': False, 'agent_name': 'Bot', 'error': 'Delegation failed: kaboom'}


def test_delegate_to_agent_emits_stream_events_and_propagates_stream_context_to_runner():
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    repo.by_id[1] = _manager(id=1)
    runner = FakeAgentRunner(repo)
    fns, _, _ = _fns(repo, runner)

    events: list = []
    sc = StreamContext(lambda ev: events.append(ev), 1)

    fns.delegateToAgent(
        {'agent_name': 'Bot', 'task': 'Do X'},
        {'user_id': 1, 'current_agent_id': 1, 'stream_context': sc},
    )

    assert [e['type'] for e in events] == ['agent_delegate']
    assert events[0]['from_agent_id'] == 1
    assert events[0]['from_agent_name'] == 'Manager'
    assert events[0]['to_agent_id'] == 5
    assert events[0]['to_agent_name'] == 'Bot'
    assert runner.stream_context is sc


# ---------------------------------------------------------------------------
# listAvailableAgents — AgentDelegationFunctionsTest::testListAvailableAgents*
# ---------------------------------------------------------------------------

def test_list_available_agents_without_manager():
    fns, repo, _ = _fns()
    result = fns.listAvailableAgents({'agent_type': 'all'}, {'user_id': 1})
    assert result['success'] is True
    assert 'agents' in result
    assert result['count'] == 0
    assert ('findAccessibleByUser', 1, {}) in repo.calls


def test_list_available_agents_returns_success_message():
    fns, _, _ = _fns()
    result = fns.listAvailableAgents({}, {'user_id': 1})
    assert 'message' in result
    assert result['message'] == 'No agents available for delegation'


def test_list_available_agents_with_manager_uses_worker_agents_and_filters_by_type():
    repo = FakeAgentRepository()
    repo.workers[1] = [_worker(id=5, name='W1'), Agent({'id': 6, 'name': 'S1', 'agent_type': 'standard'})]
    fns, _, _ = _fns(repo)
    result = fns.listAvailableAgents({'agent_type': 'worker'}, {'user_id': 1, 'current_agent_id': 1})
    assert [a['name'] for a in result['agents']] == ['W1']
    assert result['message'] == 'Found 1 agents available for delegation'


def test_list_available_agents_without_manager_excludes_manager_type():
    repo = FakeAgentRepository()
    repo.accessible = [_worker(id=5, name='W1'), _manager(id=2, name='M1')]
    fns, _, _ = _fns(repo)
    result = fns.listAvailableAgents({}, {'user_id': 1})
    assert [a['name'] for a in result['agents']] == ['W1']


# ---------------------------------------------------------------------------
# Context extraction — AgentDelegationFunctionsTest::test{Extracts,Handles}*
# ---------------------------------------------------------------------------

def test_extracts_user_id_from_array_context():
    repo = FakeAgentRepository()
    fns, _, _ = _fns(repo)
    fns.listAvailableAgents({}, {'user_id': 42})
    assert ('findAccessibleByUser', 42, {}) in repo.calls


def test_extracts_user_id_from_int_context():
    repo = FakeAgentRepository()
    fns, _, _ = _fns(repo)
    fns.listAvailableAgents({}, 99)
    assert ('findAccessibleByUser', 99, {}) in repo.calls


def test_handles_null_context():
    repo = FakeAgentRepository()
    fns, _, _ = _fns(repo)
    result = fns.listAvailableAgents({}, None)
    assert result['success'] is True
    assert ('findAccessibleByUser', 0, {}) in repo.calls


def test_extract_parent_execution_id_reads_execution_id_key():
    """PHP's extractParentExecutionId reads context['execution_id'] (the
    CURRENT agent's own execution id becomes the delegated sub-agent's
    parent_execution_id) -- PHP 599-605."""
    repo = FakeAgentRepository()
    repo.by_name['Bot'] = _worker(id=5, name='Bot')
    runner = FakeAgentRunner(repo)
    fns, _, _ = _fns(repo, runner)

    fns.delegateToAgent({'agent_name': 'Bot', 'task': 'x'}, {'user_id': 1, 'execution_id': 123})

    assert runner.run_calls[0][4]['parent_execution_id'] == 123


# ---------------------------------------------------------------------------
# runAgentsParallel — AgentDelegationFunctionsTest::testRunAgentsParallel*
# ---------------------------------------------------------------------------

def test_run_agents_parallel_requires_delegations():
    # PHP oracle calls runAgentsParallel([], ...) -- PHP's untyped `array`
    # doesn't distinguish list/dict, so an empty `[]` there just means "no
    # keys". Python's `params: dict` always receives a JSON-decoded object
    # from a real LLM tool call, so the faithful equivalent of PHP's "empty
    # array, no 'delegations' key" is `{}`.
    fns, _, _ = _fns()
    result = fns.runAgentsParallel({}, {'user_id': 1})
    assert result['success'] is False
    assert 'No delegations' in result['error']


def test_run_agents_parallel_requires_array():
    fns, _, _ = _fns()
    result = fns.runAgentsParallel({'delegations': 'not an array'}, {'user_id': 1})
    assert result['success'] is False
    assert 'No delegations' in result['error']


def test_run_agents_parallel_dict_shaped_delegations_is_an_error():
    # D5 -- `delegations` is always a JSON *array* argument in a real tool
    # call; a dict (JSON object) shape is rejected with the same validation
    # error, not silently accepted as a keyed collection.
    fns, _, _ = _fns()
    result = fns.runAgentsParallel({'delegations': {'a': {'agent_name': 'Test', 'task': 'x'}}}, {'user_id': 1})
    assert result['success'] is False
    assert 'No delegations' in result['error']


def test_run_agents_parallel_handles_missing_fields():
    repo = FakeAgentRepository()
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = FakeParallelExecutor()
    fns, _, _ = _fns(repo, runner)

    result = fns.runAgentsParallel({'delegations': [{'agent_name': 'Test'}]}, {'user_id': 1})

    assert result['failed'] == 1
    assert result['successful'] == 0


def test_run_agents_parallel_returns_correct_structure():
    repo = FakeAgentRepository()  # findByName('Test', 1) -> None (not registered)
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = FakeParallelExecutor()
    fns, _, _ = _fns(repo, runner)

    result = fns.runAgentsParallel(
        {'delegations': [{'agent_name': 'Test', 'task': 'Do X'}]}, {'user_id': 1},
    )

    for key in ('total_agents', 'successful', 'failed', 'results', 'message'):
        assert key in result


# ---------------------------------------------------------------------------
# RunAgentsParallelTest.php — ported one-to-one
# ---------------------------------------------------------------------------

def test_runs_batch_through_executor_and_maps_results():
    worker1 = Agent({'id': 5, 'name': 'Researcher', 'agent_type': 'worker', 'provider': 'claude'})
    worker2 = Agent({'id': 6, 'name': 'Writer', 'agent_type': 'worker', 'provider': 'claude'})

    repo = FakeAgentRepository()
    repo.by_name['Researcher'] = worker1
    repo.by_name['Writer'] = worker2
    # findById always returns None (no manager row) -- manager permission
    # check is skipped since `manager` ends up None.

    executor = FakeParallelExecutor(run_result={
        0: {'agent_id': 5, 'agent_name': 'Researcher', 'output': 'R', 'success': True, 'usage': None, 'execution_id': 101},
        1: {'agent_id': 6, 'agent_name': 'Writer', 'output': 'W', 'success': True, 'usage': None, 'execution_id': 102},
    })
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = executor
    fns, _, _ = _fns(repo, runner)

    out = fns.runAgentsParallel({
        'delegations': [
            {'agent_name': 'Researcher', 'task': 'find X'},
            {'agent_name': 'Writer', 'task': 'write Y'},
        ],
    }, {'user_id': 1, 'current_agent_id': 1})

    assert out['success'] is True
    assert out['successful'] == 2
    assert out['failed'] == 0
    assert out['results'][0]['result'] == 'R'
    assert out['results'][1]['agent'] == 'Writer'
    assert out['results'][1]['execution_id'] == 102
    assert runner.parallel_executor_calls == [True]  # createParallelExecutor(True)


def test_runs_batch_closes_executor_on_success():
    """A2 -- ParallelAgentExecutor owns an httpx.Client; runAgentsParallel
    must release it in `finally` (mirrors GraphWorkflowRunner.run())."""
    worker1 = Agent({'id': 5, 'name': 'Researcher', 'agent_type': 'worker', 'provider': 'claude'})
    repo = FakeAgentRepository()
    repo.by_name['Researcher'] = worker1
    executor = FakeParallelExecutor(run_result={
        0: {'agent_id': 5, 'agent_name': 'Researcher', 'output': 'R', 'success': True, 'usage': None, 'execution_id': 101},
    })
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = executor
    fns, _, _ = _fns(repo, runner)

    fns.runAgentsParallel({
        'delegations': [{'agent_name': 'Researcher', 'task': 'find X'}],
    }, {'user_id': 1})

    assert executor.close_calls == 1


def test_runs_batch_closes_executor_on_exception():
    worker1 = Agent({'id': 5, 'name': 'Researcher', 'agent_type': 'worker', 'provider': 'claude'})
    repo = FakeAgentRepository()
    repo.by_name['Researcher'] = worker1

    class BoomExecutor(FakeParallelExecutor):
        def run(self, states):
            raise RuntimeError('boom')

    executor = BoomExecutor()
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = executor
    fns, _, _ = _fns(repo, runner)

    try:
        fns.runAgentsParallel({
            'delegations': [{'agent_name': 'Researcher', 'task': 'find X'}],
        }, {'user_id': 1})
        raised = False
    except RuntimeError:
        raised = True

    assert raised is True
    assert executor.close_calls == 1


def test_empty_delegations_is_an_error():
    fns, _, _ = _fns()
    out = fns.runAgentsParallel({'delegations': []}, {'user_id': 1})
    assert out['success'] is False


def test_preflight_error_item_carries_full_seven_key_shape():
    """A manager-typed target is rejected pre-flight (worker/standard only),
    so this delegation never reaches the executor."""
    managerTarget = Agent({'id': 9, 'name': 'BossAgent', 'agent_type': 'manager', 'provider': 'claude'})
    repo = FakeAgentRepository()
    repo.by_name['BossAgent'] = managerTarget

    executor = FakeParallelExecutor()
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = executor
    fns, _, _ = _fns(repo, runner)

    out = fns.runAgentsParallel({
        'delegations': [{'agent_name': 'BossAgent', 'task': 'do boss things'}],
    }, {'user_id': 1, 'current_agent_id': 1})

    assert out['success'] is False
    assert out['failed'] == 1

    item = out['results'][0]
    for key in ('index', 'agent', 'task', 'success', 'result', 'error', 'execution_id'):
        assert key in item, f"results[0] must carry '{key}'"
    assert item['task'] == 'do boss things'
    assert item['result'] is None
    assert item['success'] is False
    assert item['error'] is not None
    assert executor.run_calls == []  # no valid states -> executor.run() never called


def test_missing_agent_name_error_item_carries_full_seven_key_shape():
    repo = FakeAgentRepository()
    runner = FakeAgentRunner(repo)
    fns, _, _ = _fns(repo, runner)

    out = fns.runAgentsParallel({
        'delegations': [{'task': 'orphan task'}],  # missing agent_name
    }, {'user_id': 1, 'current_agent_id': 1})

    item = out['results'][0]
    for key in ('index', 'agent', 'task', 'success', 'result', 'error', 'execution_id'):
        assert key in item, f"results[0] must carry '{key}'"
    assert item['task'] == 'orphan task'
    assert item['result'] is None


def test_run_agents_parallel_disabled_and_permission_denied_preflight_errors():
    repo = FakeAgentRepository()
    repo.by_name['Off'] = _worker(id=5, name='Off', enabled=False)
    repo.by_name['NoPerm'] = _worker(id=6, name='NoPerm')
    repo.by_id[1] = _manager(id=1, can_delegate_to=[999])
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = FakeParallelExecutor()
    fns, _, _ = _fns(repo, runner)

    out = fns.runAgentsParallel({
        'delegations': [
            {'agent_name': 'Off', 'task': 'x'},
            {'agent_name': 'NoPerm', 'task': 'y'},
        ],
    }, {'user_id': 1, 'current_agent_id': 1})

    assert out['failed'] == 2
    assert 'disabled' in out['results'][0]['error']
    assert "cannot delegate to 'NoPerm'" in out['results'][1]['error']


def test_run_agents_parallel_emits_start_and_complete_stream_events():
    worker1 = Agent({'id': 5, 'name': 'Researcher', 'agent_type': 'worker', 'provider': 'claude'})
    repo = FakeAgentRepository()
    repo.by_name['Researcher'] = worker1
    executor = FakeParallelExecutor(run_result={
        0: {'agent_id': 5, 'agent_name': 'Researcher', 'output': 'R', 'success': True, 'usage': None, 'execution_id': 101},
    })
    runner = FakeAgentRunner(repo)
    runner.parallel_executor = executor
    fns, _, _ = _fns(repo, runner)

    events: list = []
    sc = StreamContext(lambda ev: events.append(ev), 1)

    fns.runAgentsParallel({
        'delegations': [{'agent_name': 'Researcher', 'task': 'find X'}],
    }, {'user_id': 1, 'stream_context': sc})

    types = [e['type'] for e in events]
    assert types == ['parallel_start', 'parallel_complete']
    assert events[0]['count'] == 1
    assert events[0]['agents'] == ['Researcher']
    assert events[1]['successful'] == 1
    assert events[1]['failed'] == 0


# ---------------------------------------------------------------------------
# completeTask — AgentDelegationFunctions.php 632-647
# ---------------------------------------------------------------------------

def test_complete_task_default_reason():
    fns, _, _ = _fns()
    result = fns.completeTask({}, {'user_id': 1})
    assert result == {
        'success': True,
        'status': 'workflow_complete',
        'marker': '___WORKFLOW_COMPLETE___',
        'reason': 'Workflow complete',
        'summary': '',
        'instruction': 'You may now synthesize all results and respond to the user with your final answer.',
    }


def test_complete_task_custom_reason_and_summary():
    fns, _, _ = _fns()
    result = fns.completeTask({'reason': 'All done', 'summary': 'Found the answer'}, {'user_id': 1})
    assert result['reason'] == 'All done'
    assert result['summary'] == 'Found the answer'
