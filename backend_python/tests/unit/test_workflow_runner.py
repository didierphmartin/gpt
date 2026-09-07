"""Unit tests for app.agent_team.services.workflow_runner.WorkflowRunner.

No PHP oracle test exists for WorkflowRunner.php (backend/tests/Unit/AgentTeam
has no WorkflowRunnerTest.php — confirmed via `find tests -iname
'*WorkflowRunner*'` returning nothing), so these are written from the PHP
source directly: condition evaluation matrix (all PHP operators, PHP 8
loose-equality verified against the real `php -r` CLI), transform steps,
combineOutputs/extractField/summarizeOutputs exact text, and the full run()
dependency-ordered execution/failure paths.
"""
from __future__ import annotations

from app.agent_team.models.agent import Agent
from app.agent_team.models.workflow import Workflow
from app.agent_team.services.workflow_runner import WorkflowRunner
from app.support.phpjson import php_json_encode


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeDb:
    def __init__(self):
        self.inserts = []
        self.executes = []
        self._next_id = 100

    def insert(self, sql, params):
        self.inserts.append((sql, params))
        self._next_id += 1
        return self._next_id

    def execute(self, sql, params):
        self.executes.append((sql, params))
        return 1

    def fetch_all(self, sql, params):
        self.executes.append((sql, params))
        return [{'id': 1, 'workflow_id': params[0], 'status': 'completed'}]


class FakeAgentRepository:
    def __init__(self, agents):
        self._by_id = {a.getId(): a for a in agents}
        self._by_name = {a.getName(): a for a in agents}

    def findById(self, agent_id):
        return self._by_id.get(agent_id)

    def findByName(self, name, user_id):
        return self._by_name.get(name)


class FakeAgentRunner:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = responses or {}

    def run(self, agent, task, conversation_history, user_id, context):
        self.calls.append({'agent': agent.getName(), 'task': task, 'context': context})
        if agent.getName() in self.responses:
            resp = self.responses[agent.getName()]
            if isinstance(resp, Exception):
                raise resp
            return resp
        return {'text': f'{agent.getName()} response', 'success': True, 'usage': {'total_tokens': 5}}


def _agent(agent_id, name):
    return Agent({'id': agent_id, 'name': name, 'agent_type': 'standard', 'provider': 'claude'})


def _wf(steps, variables=None, workflow_id=1, name='WF'):
    wf = Workflow()
    wf.setId(workflow_id)
    wf.setName(name)
    wf.setSteps(steps)
    wf.setVariables(variables if variables is not None else {})
    return wf


def _runner(agents=None, responses=None, db=None):
    db = db if db is not None else FakeDb()
    repo = FakeAgentRepository(agents or [])
    agent_runner = FakeAgentRunner(responses)
    return WorkflowRunner(db, repo, agent_runner), db, agent_runner


# ---------------------------------------------------------------------------
# evaluateCondition matrix (WorkflowRunner.php 266-295) — all operators.
# PHP 8 loose-equality behaviour cross-checked with `php -r`:
#   var_dump(true == "1")   -> true
#   var_dump(true == "0")   -> false
#   var_dump("5" == 5)      -> true
#   var_dump(null == "0")   -> false
#   var_dump(null == "")    -> true
# ---------------------------------------------------------------------------

def _vars():
    return {
        'flag': True,
        'zero': 0,
        'emptystr': '',
        'text': 'hello',
        'num': '5',
        'num2': 5,
        'missingish': None,
    }


def test_evaluate_condition_truthiness():
    runner, _, _ = _runner()
    v = _vars()
    assert runner._evaluateCondition('flag', v) is True
    assert runner._evaluateCondition('zero', v) is False       # 0 is empty()
    assert runner._evaluateCondition('emptystr', v) is False   # '' is empty()
    assert runner._evaluateCondition('text', v) is True
    assert runner._evaluateCondition('unknown_var', v) is False
    assert runner._evaluateCondition('missingish', v) is False  # None is empty()


def test_evaluate_condition_negation():
    runner, _, _ = _runner()
    v = _vars()
    assert runner._evaluateCondition('!flag', v) is False
    assert runner._evaluateCondition('!zero', v) is True
    assert runner._evaluateCondition('!unknown_var', v) is True


def test_evaluate_condition_equality_numeric_string_coercion():
    runner, _, _ = _runner()
    v = _vars()
    # "5" (string var) == 5 (literal, non-numeric-as-var -> numeric compare)
    assert runner._evaluateCondition('num == 5', v) is True
    # both sides resolve through variables: '5' == 5 (int) -> numeric compare
    assert runner._evaluateCondition('num == num2', v) is True
    assert runner._evaluateCondition('num != num2', v) is False


def test_evaluate_condition_equality_string_literal_fallback():
    runner, _, _ = _runner()
    v = _vars()
    # 'hello' is not a variable name -> falls back to the literal string
    assert runner._evaluateCondition('text == hello', v) is True
    assert runner._evaluateCondition('text != world', v) is True
    assert runner._evaluateCondition('text == world', v) is False


def test_evaluate_condition_bool_comparison_matches_php():
    runner, _, _ = _runner()
    v = _vars()
    # true == '1' -> true ; true == '0' -> false (verified via php -r above)
    assert runner._evaluateCondition('flag == 1', v) is True
    assert runner._evaluateCondition('flag == 0', v) is False


def test_evaluate_condition_whitespace_trimmed():
    runner, _, _ = _runner()
    v = _vars()
    assert runner._evaluateCondition('  text   ==   hello  ', v) is True


# ---------------------------------------------------------------------------
# Transform steps (WorkflowRunner.php 241-261, 300-350).
# ---------------------------------------------------------------------------

def test_transform_json_encode_matches_php_bytes():
    r"""php -r 'echo json_encode(["path"=>"a/b","name"=>"héllo"]);'
    -> {"path":"a\/b","name":"héllo"} (escaped slash + \uXXXX)."""
    runner, _, _ = _runner()
    variables = {'obj': {'path': 'a/b', 'name': 'héllo'}}
    step = {'transform': 'json_encode', 'input': 'obj'}
    result = runner._executeTransformStep(step, variables)
    assert result == {
        'transform': 'json_encode',
        'output': '{"path":"a\\/b","name":"h\\u00e9llo"}',
    }


def test_transform_json_decode():
    runner, _, _ = _runner()
    variables = {'raw': '{"x":1,"y":[2,3]}'}
    step = {'transform': 'json_decode', 'input': 'raw'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'json_decode', 'output': {'x': 1, 'y': [2, 3]}}


def test_transform_json_decode_passthrough_when_not_string():
    """`is_string($inputData) ? json_decode(...) : $inputData` — a non-string
    input (e.g. already-decoded data with no `input` key -> whole $variables)
    passes through untouched."""
    runner, _, _ = _runner()
    variables = {'a': 1}
    step = {'transform': 'json_decode'}  # no 'input' -> $inputData = $variables
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'json_decode', 'output': {'a': 1}}


def test_transform_combine():
    runner, _, _ = _runner()
    variables = {'a': 1, 'b': 2, 'c': 3}
    step = {'transform': 'combine', 'inputs': ['a', 'b']}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'combine', 'output': {'a': 1, 'b': 2}}


def test_transform_extract_nested_dict():
    runner, _, _ = _runner()
    variables = {'data': {'a': {'b': {'c': 42}}}}
    step = {'transform': 'extract', 'input': 'data', 'field': 'a.b.c'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'extract', 'output': 42}


def test_transform_extract_list_index():
    runner, _, _ = _runner()
    variables = {'data': {'items': [{'name': 'first'}, {'name': 'second'}]}}
    step = {'transform': 'extract', 'input': 'data', 'field': 'items.1.name'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'extract', 'output': 'second'}


def test_transform_extract_missing_field_is_none():
    runner, _, _ = _runner()
    variables = {'data': {'a': 1}}
    step = {'transform': 'extract', 'input': 'data', 'field': 'a.b.c'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'extract', 'output': None}


def test_transform_extract_non_array_data_is_none():
    runner, _, _ = _runner()
    variables = {'data': 'a plain string'}
    step = {'transform': 'extract', 'input': 'data', 'field': 'a'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'extract', 'output': None}


def test_transform_summarize_result_key_and_plain_value():
    runner, _, _ = _runner()
    variables = {'s1': {'result': 'ok1'}, 's2': 'plain text'}
    step = {'transform': 'summarize', 'inputs': ['s1', 's2']}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'summarize', 'output': 's1: ok1\n\ns2: plain text'}


def test_transform_summarize_array_without_result_key_json_encodes():
    runner, _, _ = _runner()
    variables = {'s3': {'foo': 'bar'}}
    step = {'transform': 'summarize', 'inputs': ['s3']}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'summarize', 'output': 's3: ' + php_json_encode({'foo': 'bar'})}


def test_transform_unknown_type_passes_through_input():
    runner, _, _ = _runner()
    variables = {'obj': {'a': 1}}
    step = {'transform': 'noop', 'input': 'obj'}
    result = runner._executeTransformStep(step, variables)
    assert result == {'transform': 'noop', 'output': {'a': 1}}


# ---------------------------------------------------------------------------
# combineOutputs / extractField / summarizeOutputs directly.
# ---------------------------------------------------------------------------

def test_combine_outputs_skips_missing_keys():
    runner, _, _ = _runner()
    combined = runner._combineOutputs(['a', 'missing', 'b'], {'a': 1, 'b': 2})
    assert combined == {'a': 1, 'b': 2}


def test_extract_field_isset_semantics_null_value_is_missing():
    """isset($current['x']) is false when the value is explicitly null."""
    runner, _, _ = _runner()
    assert runner._extractField({'a': None}, 'a') is None


def test_summarize_outputs_empty_when_no_keys_present():
    runner, _, _ = _runner()
    assert runner._summarizeOutputs(['nope'], {}) == ''


# ---------------------------------------------------------------------------
# Full run(): dependency ordering, condition branch, agent step, DB rows.
# ---------------------------------------------------------------------------

def test_run_sequential_agent_steps_in_dependency_order():
    a1 = _agent(1, 'Alpha')
    a2 = _agent(2, 'Beta')
    steps = [
        {'id': 's2', 'type': 'agent', 'agent': 'Beta', 'task': 'second', 'depends_on': ['s1']},
        {'id': 's1', 'type': 'agent', 'agent': 'Alpha', 'task': 'first'},
    ]
    runner, db, agent_runner = _runner([a1, a2])
    wf = _wf(steps)

    result = runner.run(wf, user_id=7)

    assert result['success'] is True
    assert result['steps_completed'] == ['s1', 's2']
    assert result['outputs']['s1']['agent'] == 'Alpha'
    assert result['outputs']['s2']['agent'] == 'Beta'
    assert result['workflow'] == {'id': 1, 'name': 'WF'}
    assert 'response_time_ms' in result
    # Execution order matches dependency order, not the input list order.
    assert [c['agent'] for c in agent_runner.calls] == ['Alpha', 'Beta']
    # createExecution then completeExecution both ran.
    assert len(db.inserts) == 1
    assert "INSERT INTO agent_workflow_executions" in db.inserts[0][0]
    assert any("status = 'completed'" in sql for sql, _ in db.executes)


def test_run_condition_step_then_branch():
    a1 = _agent(1, 'Alpha')
    steps = [
        {'id': 'c1', 'type': 'condition', 'condition': 'go',
         'then': {'id': 't1', 'type': 'agent', 'agent': 'Alpha', 'task': 'do it'},
         'else': {'id': 'e1', 'type': 'transform', 'transform': 'noop'}},
    ]
    runner, _, agent_runner = _runner([a1])
    wf = _wf(steps, variables={'go': True})

    result = runner.run(wf, user_id=1)

    assert result['success'] is True
    branch = result['outputs']['c1']
    assert branch['branch'] == 'then'
    assert branch['result'] is True
    assert branch['output']['agent'] == 'Alpha'
    assert agent_runner.calls[0]['agent'] == 'Alpha'


def test_run_condition_step_else_branch():
    steps = [
        {'id': 'c1', 'type': 'condition', 'condition': 'go',
         'then': {'id': 't1', 'type': 'transform', 'transform': 'noop', 'input': 'go'},
         'else': {'id': 'e1', 'type': 'transform', 'transform': 'json_encode', 'input': 'go'}},
    ]
    runner, _, _ = _runner()
    wf = _wf(steps, variables={'go': False})

    result = runner.run(wf, user_id=1)

    assert result['success'] is True
    branch = result['outputs']['c1']
    assert branch['branch'] == 'else'
    assert branch['result'] is False
    assert branch['output'] == {'transform': 'json_encode', 'output': php_json_encode(False)}


def test_run_agent_not_found_fails_execution():
    runner, db, _ = _runner([])
    steps = [{'id': 's1', 'type': 'agent', 'agent': 'Ghost', 'task': 'x'}]
    wf = _wf(steps)

    result = runner.run(wf, user_id=1)

    assert result['success'] is False
    assert result['error'] == 'Agent not found: Ghost'
    assert result['execution_id'] is not None
    assert any("status = 'failed'" in sql for sql, _ in db.executes)


def test_run_unresolvable_dependencies_fails():
    # s1 is the (only) entry step so getEntrySteps() succeeds and the main
    # loop makes one pass; s2/s3 then depend on each other in a cycle that
    # can never become satisfied, which is the RuntimeError this guards.
    steps = [
        {'id': 's1', 'type': 'transform', 'transform': 'noop'},
        {'id': 's2', 'type': 'agent', 'agent': 'Ghost', 'task': 'x', 'depends_on': ['s3']},
        {'id': 's3', 'type': 'agent', 'agent': 'Ghost', 'task': 'y', 'depends_on': ['s2']},
    ]
    runner, _, _ = _runner([])
    wf = _wf(steps)

    result = runner.run(wf, user_id=1)

    assert result['success'] is False
    assert result['error'] == 'Workflow has unresolvable dependencies'
    assert result['partial_outputs'] == {'s1': {'transform': 'noop', 'output': {}}}


def test_run_invalid_step_type_fails():
    steps = [{'id': 's1', 'type': 'bogus'}]
    runner, _, _ = _runner([])
    wf = _wf(steps)

    result = runner.run(wf, user_id=1)

    assert result['success'] is False
    assert "Invalid workflow" in result['error']


def test_run_no_steps_fails():
    runner, _, _ = _runner([])
    wf = _wf([])

    result = runner.run(wf, user_id=1)

    assert result['success'] is False
    assert "Invalid workflow" in result['error']


def test_run_output_key_overrides_step_id_for_variable_storage():
    a1 = _agent(1, 'Alpha')
    steps = [
        {'id': 's1', 'type': 'agent', 'agent': 'Alpha', 'task': 'first', 'output_key': 'greeting'},
    ]
    runner, _, _ = _runner([a1])
    wf = _wf(steps)

    result = runner.run(wf, user_id=1)

    assert result['success'] is True
    assert 'greeting' in result['outputs']
    assert 's1' not in result['outputs']


def test_run_interpolates_prior_step_output_into_next_task():
    a1 = _agent(1, 'Alpha')
    a2 = _agent(2, 'Beta')
    steps = [
        {'id': 's1', 'type': 'agent', 'agent': 'Alpha', 'task': 'first'},
        {'id': 's2', 'type': 'agent', 'agent': 'Beta', 'task': 'echo {{s1}}', 'depends_on': ['s1']},
    ]
    runner, _, agent_runner = _runner([a1, a2])
    wf = _wf(steps)

    runner.run(wf, user_id=1)

    # s1's stored variable is the whole step-output dict (an array) — PHP's
    # (string) cast on an array yields the literal string "Array".
    beta_call = next(c for c in agent_runner.calls if c['agent'] == 'Beta')
    assert beta_call['task'] == 'echo Array'


def test_get_execution_history_delegates_to_db():
    runner, db, _ = _runner([])
    rows = runner.getExecutionHistory(1, limit=10, offset=5)
    assert rows == [{'id': 1, 'workflow_id': 1, 'status': 'completed'}]
    sql, params = db.executes[-1]
    assert params == [1, 10, 5]
    assert "ORDER BY started_at DESC" in sql
