"""Port of backend/tests/Unit/GraphWorkflowRunnerRoutingModeTest.php.

The interpreter's dispatcher honours settings.routing_mode:
  a provider key (e.g. 'jev') = that decision provider only (the model is never called; no decision, or
    an unknown provider = "did not route"),
  'llm' = model only (no decision provider is consulted),
  unset = the first decision provider the user's plan allows, else the model.
  There is no hybrid: a decline never falls back to the model or another provider.
The key is the stored one (user row wins over the global row), never .env.
A fake Db answers by SQL shape (like the PHP test's PDO mock); the Jev transport is an httpx MockTransport.
"""
from __future__ import annotations

import json

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services import graph_workflow_runner as _gwr_module
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.jev_router import JevRouter
from app.services.decision_usage import DecisionUsage
from tests.unit.decision_fakes import encrypt_key, json_response, mock_client

SECRET = 'routing-mode-test-secret'
USER_ID = 7


def _jev_answer(choice: str, confidence: float):
    return json_response(200, {'model': 'jev-1.13.0', 'answers': {'route': {
        'type': 'choice', 'choice': choice, 'confidence': confidence, 'probabilities': {choice: confidence},
    }}, 'usage': {'input_tokens': 342, 'output_tokens': 39}})


class _FakeDb:
    """Answers ensureDbConnection, DecisionKeyResolver's package and key lookups, and PricingResolver's
    jev price row (the PHP test's PDO mock, by the same SQL fragments)."""

    def __init__(self, userKey='', globalKey='', jevEnabled=True, jevPrices=(0.042, 0.0), packagesOnlyJev=False):
        self.userKey, self.globalKey, self.jevEnabled, self.jevPrices = userKey, globalKey, jevEnabled, jevPrices
        self.packagesOnlyJev = packagesOnlyJev
        self._id = 0

    def fetch_one(self, sql, params=None):
        if 'FROM users' in sql:
            return {'role': 'user'}
        if 'FROM packages' in sql:
            providers = ({'jev': {'enabled': True}} if self.packagesOnlyJev
                         else {'jev': {'enabled': self.jevEnabled}, 'acme': {'enabled': self.jevEnabled}})
            return {'capabilities': json.dumps({'providers': providers}), 'updated_at': None}
        if 'user_api_keys' in sql:
            return {'api_key': encrypt_key(self.userKey, SECRET), 'base_url': None} if self.userKey != '' else None
        if 'price_input_per_1m' in sql:
            return {'price_input_per_1m': self.jevPrices[0], 'price_output_per_1m': self.jevPrices[1]}
        return None

    def fetch_all(self, sql, params=None):
        if 'api_format = :f' in sql:
            rows = [
                {'provider_key': 'acme', 'display_name': 'Acme', 'api_key': 'acme-global', 'model': 'acme-1',
                 'base_url': None, 'protocol': 'typesafe', 'enabled': 1, 'sort_order': 200},
                {'provider_key': 'jev', 'display_name': 'Jev', 'api_key': self.globalKey, 'model': 'jev-latest',
                 'base_url': None, 'protocol': 'typesafe', 'enabled': 1, 'sort_order': 100},
            ]
            if self.packagesOnlyJev:
                rows = rows[1:]
            return sorted(rows, key=lambda r: r['sort_order'])
        return []

    def fetch_column(self, sql, params=None):
        return []

    def insert(self, sql, params=None):
        self._id += 1
        return self._id

    def execute(self, sql, params=None):
        return 0


class _AgentRunner:
    """A model that answers route_to(Sales) -- or must never be called."""

    def __init__(self, expectCall: bool, answer: dict | None = None):
        self.expectCall = expectCall
        self.calls = 0
        self.answer = answer or {
            'success': True,
            'pending_client_tool_call': True,
            'pending_tool_calls': [{'name': 'route_to', 'input': {'target': 'Sales', 'notes': 'model chose'}}],
            'usage': {'input_tokens': 1000, 'output_tokens': 20},
        }

    def run(self, *a, **k):
        self.calls += 1
        if not self.expectCall:
            raise AssertionError('the model must not be called')
        if self.calls > 1:
            raise AssertionError('the model is called once')
        return dict(self.answer)


class _Graph:
    def __init__(self, nodes=None, edges=None):
        self.nodes, self.edges = nodes or [], edges or []

    def findStartNode(self, wid):
        return self.nodes[0]

    def getGraph(self, wid):
        return {'nodes': self.nodes, 'edges': self.edges}


class RoutingModeTestRunner(GraphWorkflowRunner):
    """Replaces the Jev HTTP transport with canned answers and records how the router was built."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.jevQueue: list = []
        self.made = 0
        self.madeWithKey = None
        self.madeWithFloor = None
        self.madeFor = ''
        self.recorded: list = []

    def _recordDecisionUsage(self, userId, providerKey, model, out):
        """Production's filter (DecisionUsage.record), with the database write replaced by a list."""
        recorded, outCopy = self.recorded, out

        class _Logger:
            def logTransaction(self, data):
                recorded.append({'user_id': data['user_id'], 'provider': data['provider'], **outCopy})
                return 1
        DecisionUsage.record(_Logger(), userId, providerKey, model, out)

    def _makeDecisionRouter(self, resolved, floor):
        self.made += 1
        self.madeWithKey = resolved['key']
        self.madeWithFloor = floor
        self.madeFor = str((resolved.get('row') or {}).get('provider_key') or '')
        return JevRouter(resolved['key'] if resolved['key'] != '' else None, mock_client(self.jevQueue), floor)


@pytest.fixture(autouse=True)
def _quiet(monkeypatch, tmp_path):
    monkeypatch.setattr(_gwr_module, '_sleep', lambda s: None)
    monkeypatch.setattr(_gwr_module, 'error_log', lambda m: None)
    from app.agent_team.services import workflow_run_log
    monkeypatch.setattr(workflow_run_log, '_DEFAULT_BASE_DIR', str(tmp_path / 'runs'))


def make_runner(userKey, globalKey, agentRunner, jevQueue, jevEnabled=True, jevPrices=(0.042, 0.0)):
    runner = RoutingModeTestRunner(_FakeDb(userKey, globalKey, jevEnabled, jevPrices), object(), agentRunner, _Graph(),
                                   {'auth': {'jwt_secret': SECRET}})
    runner.jevQueue = jevQueue
    runner.workflowName = 'Support desk'
    runner.graphNodes = {
        1: {'id': 1, 'node_type': 'agent', 'config': {}},
        2: {'id': 2, 'node_type': 'agent', 'config': {'agent_name': 'Billing'}},
        3: {'id': 3, 'node_type': 'agent', 'config': {'agent_name': 'Sales'}},
    }
    return runner


def dispatch(runner, settings):
    node = {'id': 1, 'node_type': 'agent', 'agent_id': None, 'config': {
        'agent_name': 'Router', 'agent_type': 'dispatcher', 'provider': 'openai', 'model': 'gpt-test',
        'instructions': 'Send the request to the right team.', 'tools': [],
        'settings': settings if settings is not None else [],
    }}
    edges = [{'from_node_id': 1, 'to_node_id': 2}, {'from_node_id': 1, 'to_node_id': 3}]
    return runner._executeAgentNode(node, USER_ID, 'I was charged twice.', edges, [])


# ── Jev mode: Jev only ─────────────────────────────────────────────────

def test_jev_mode_routed_never_calls_the_model():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.99)])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is True
    assert out['provider'] == 'jev'
    assert out['route']['name'] == 'Billing'
    assert out['usage'] == {'input_tokens': 342, 'output_tokens': 39}
    assert runner.madeWithKey == 'global-jev-key'


def test_jev_mode_unclear_stops_with_did_not_route():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer(JevRouter.UNCLEAR, 1.0)])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is True, 'no branch fits: a normal ending, not an error'
    assert out['provider'] == 'jev'
    assert 'route' not in out
    assert out['output'] == 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).'
    assert out['usage'] == {'input_tokens': 342, 'output_tokens': 39}


def test_jev_mode_low_confidence_stops_with_did_not_route():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Sales', 0.46)])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is True, 'no branch fits: a normal ending, not an error'
    assert out['output'] == ('Not classified: dispatcher "Router" did not route the request '
                             '(jev: low_confidence: confidence 0.46 below floor 0.60).')


def test_jev_mode_unclear_goes_to_the_unclear_branch():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer(JevRouter.UNCLEAR, 0.7)])
    out = dispatch(runner, {'routing_mode': 'jev', 'unclear_branch': 'Sales'})
    assert out['success'] is True
    assert out['route']['name'] == 'Sales'
    assert 'halt_branches' not in out


def test_jev_mode_low_confidence_goes_to_the_unclear_branch():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.46)])
    out = dispatch(runner, {'routing_mode': 'jev', 'unclear_branch': 'Sales'})
    assert out['route']['name'] == 'Sales'


def test_an_unclear_branch_no_longer_on_the_menu_stops():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer(JevRouter.UNCLEAR, 1.0)])
    out = dispatch(runner, {'routing_mode': 'jev', 'unclear_branch': 'Deleted branch'})
    assert 'route' not in out
    assert out['halt_branches'] is True


def test_a_missing_key_ignores_the_unclear_branch():
    runner = make_runner('', '', _AgentRunner(False), [])
    out = dispatch(runner, {'routing_mode': 'jev', 'unclear_branch': 'Sales'})
    assert out['success'] is False
    assert 'route' not in out
    assert out['output'].startswith('Error: ')


def test_jev_mode_without_a_key_stops_with_did_not_route_and_zero_usage():
    runner = make_runner('', '', _AgentRunner(False), [])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is False
    assert out['provider'] == 'jev'
    assert out['output'] == 'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).'
    assert out['usage'] == {'input_tokens': 0, 'output_tokens': 0}


def test_jev_mode_uses_the_users_own_key():
    """A user with only a personal key (no global key) still gets Jev routing."""
    runner = make_runner('personal-jev-key', '', _AgentRunner(False), [_jev_answer('Billing', 0.99)])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is True
    assert out['route']['name'] == 'Billing'
    assert runner.madeWithKey == 'personal-jev-key'


# ── LLM mode: model only ───────────────────────────────────────────────

def test_llm_mode_never_consults_jev_even_with_a_key():
    runner = make_runner('', 'global-jev-key', _AgentRunner(True), [_jev_answer('Billing', 0.99)])
    out = dispatch(runner, {'routing_mode': 'llm'})
    assert out['success'] is True
    assert out['provider'] == 'openai'
    assert out['route']['name'] == 'Sales'
    assert runner.made == 0, 'LLM mode must not build a Jev router'


def test_llm_mode_without_a_key_uses_the_model():
    runner = make_runner('', '', _AgentRunner(True), [])
    out = dispatch(runner, {'routing_mode': 'llm'})
    assert out['route']['name'] == 'Sales'
    assert runner.made == 0


# ── No mode saved: Jev when the plan allows it, else the model ─────────

def test_unset_mode_allowed_routes_with_jev():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.99)])
    out = dispatch(runner, None)
    assert out['success'] is True
    assert out['provider'] == 'jev'
    assert out['route']['name'] == 'Billing'


def test_unset_mode_allowed_unclear_stops_with_did_not_route_and_never_calls_the_model():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer(JevRouter.UNCLEAR, 1.0)])
    out = dispatch(runner, {})
    assert out['success'] is True, 'no branch fits: a normal ending, not an error'
    assert out['provider'] == 'jev'
    assert 'route' not in out
    assert out['halt_branches'] is True
    assert out['output'] == 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).'


def test_unset_mode_allowed_without_a_key_stops_with_did_not_route():
    runner = make_runner('', '', _AgentRunner(False), [])
    out = dispatch(runner, None)
    assert out['success'] is False
    assert out['provider'] == 'jev'
    assert out['halt_branches'] is True
    assert out['output'] == 'Error: dispatcher "Router" did not route the request (jev: unavailable: no Jev key).'


def test_a_node_naming_a_deleted_provider_halts():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [])
    out = dispatch(runner, {'routing_mode': 'banana'})
    assert out['success'] is False
    assert out['halt_branches'] is True
    assert out['provider'] == 'banana'
    assert runner.made == 0, 'nothing to build for an unknown provider'
    assert out['output'] == ('Error: dispatcher "Router" did not route the request '
                             "(banana: unavailable: 'banana' is not an available decision provider).")


def test_each_node_uses_its_own_provider():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Sales', 0.99)])
    out = dispatch(runner, {'routing_mode': 'acme'})
    assert out['success'] is True
    assert out['provider'] == 'acme'
    assert runner.madeFor == 'acme'
    assert runner.madeWithKey == 'acme-global'
    assert runner.recorded[0]['provider'] == 'acme'


def test_min_confidence_wins_over_the_legacy_setting():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Sales', 0.99)])
    dispatch(runner, {'routing_mode': 'jev', 'min_confidence': 0.8, 'jev_min_confidence': 0.3})
    assert runner.madeWithFloor == 0.8


# ── Minimum confidence ─────────────────────────────────────────────────

@pytest.mark.parametrize('setting,expected', [
    (None, JevRouter.DEFAULT_CONFIDENCE_FLOOR),   # absent
    (0.3, 0.3),                                   # numeric
    ('0.75', 0.75),                               # string
    (1.7, 1.0),                                   # above one
    (-2, 0.0),                                    # below zero
    ('abc', JevRouter.DEFAULT_CONFIDENCE_FLOOR),  # not numeric
])
def test_minimum_confidence_is_the_clamped_floor(setting, expected):
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.99)])
    settings = {'routing_mode': 'jev'}
    if setting is not None:
        settings['jev_min_confidence'] = setting
    dispatch(runner, settings)
    assert runner.madeWithFloor == expected


def test_a_lower_floor_lets_a_divided_answer_route():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Sales', 0.46)])
    out = dispatch(runner, {'routing_mode': 'jev', 'jev_min_confidence': 0.4})
    assert out['success'] is True
    assert out['route']['name'] == 'Sales'


# ── Run level: what happens to the branches ────────────────────────────

def run_workflow(settings, globalKey, jevQueue, agentRunner):
    """A whole run() over Start -> Router (dispatcher) -> Billing | Sales -> Output. The children are
    disabled nodes: if the traversal reaches them they record the 'disabled node' sentinel (and never
    call a model), so their presence in node_outputs is proof they ran."""
    def child(id_, name):
        return {'id': id_, 'node_type': 'agent', 'agent_id': None,
                'config': {'agent_name': name, 'instructions': f'You are {name}.', 'provider': 'openai',
                           'tools': [], 'disabled': True}}
    nodes = [
        {'id': 10, 'node_type': 'start', 'agent_id': None, 'config': {}},
        {'id': 1, 'node_type': 'agent', 'agent_id': None, 'config': {
            'agent_name': 'Router', 'agent_type': 'dispatcher', 'provider': 'openai', 'model': 'gpt-test',
            'instructions': 'Send the request to the right team.', 'tools': [],
            'settings': settings if settings is not None else []}},
        child(2, 'Billing'),
        child(3, 'Sales'),
        {'id': 4, 'node_type': 'output', 'agent_id': None, 'config': {}},
    ]
    edges = [
        {'from_node_id': 10, 'to_node_id': 1},
        {'from_node_id': 1, 'to_node_id': 2},
        {'from_node_id': 1, 'to_node_id': 3},
        {'from_node_id': 2, 'to_node_id': 4},
        {'from_node_id': 3, 'to_node_id': 4},
    ]
    # The package lookup (userId 0 resolves to the guest package) enables Jev.
    db = _FakeDb('', globalKey, packagesOnlyJev=True)
    runner = RoutingModeTestRunner(db, object(), agentRunner, _Graph(nodes, edges), {'auth': {'jwt_secret': SECRET}})
    runner.jevQueue = jevQueue
    wf = Workflow()
    wf.setId(5)
    wf.setName('Support desk')
    # userId 0: no per-user key lookup and no conversation archive.
    return runner.run(wf, 0, {'prompt': 'I was charged twice.'})


@pytest.mark.parametrize('key,queue,why', [
    ('global-jev-key', [_jev_answer(JevRouter.UNCLEAR, 1.0)], 'unclear: the request names no branch'),
    ('', [], 'unavailable: no Jev key'),
], ids=['unclear', 'no key'])
def test_a_jev_only_dispatcher_that_does_not_route_stops_its_branches(key, queue, why):
    out = run_workflow({'routing_mode': 'jev'}, key, queue, _AgentRunner(False))
    # A request no branch fits ends normally; a missing key is an error.
    notClassified = why.startswith('unclear')
    message = ('Not classified' if notClassified else 'Error') + f': dispatcher "Router" did not route the request (jev: {why}).'
    assert 2 not in out['node_outputs'], 'Billing must not run'
    assert 3 not in out['node_outputs'], 'Sales must not run'
    assert 4 not in out['node_outputs'], 'nothing downstream of the branches runs'
    assert out['node_outputs'][1]['success'] is notClassified
    assert out['node_outputs'][1]['output'] == message
    assert out['output'] == message, 'the run ends with the did-not-route result'


def test_an_unset_dispatcher_that_jev_does_not_route_stops_its_branches():
    """An unset dispatcher on a plan with Jev is Jev only: a decline stops its branches too."""
    out = run_workflow(None, 'global-jev-key', [_jev_answer(JevRouter.UNCLEAR, 1.0)], _AgentRunner(False))
    message = 'Not classified: dispatcher "Router" did not route the request (jev: unclear: the request names no branch).'
    assert 2 not in out['node_outputs'], 'Billing must not run'
    assert 3 not in out['node_outputs'], 'Sales must not run'
    assert out['output'] == message


def test_an_llm_dispatcher_that_does_not_route_keeps_todays_fan_out():
    """Scope pin: an LLM-mode dispatcher whose model does not call route_to keeps today's behaviour,
    which fans out to every branch."""
    model = _AgentRunner(True, {'success': True, 'text': 'Some prose, no route_to.',
                                'usage': {'input_tokens': 10, 'output_tokens': 5}})
    out = run_workflow({'routing_mode': 'llm'}, '', [], model)
    assert out['node_outputs'][1]['success'] is False
    assert 'did not route the request. Expected a route_to call' in out['node_outputs'][1]['output']
    assert out['node_outputs'][2]['output'] == 'disabled node', 'Billing still runs (unchanged)'
    assert out['node_outputs'][3]['output'] == 'disabled node', 'Sales still runs (unchanged)'


# ── Usage recording ────────────────────────────────────────────────────

def test_a_jev_routed_step_is_recorded_once_and_priced_from_the_row():
    """Jev is priced from its system_llm_settings row, like any provider."""
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.99)])
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['route']['name'] == 'Billing'
    assert len(runner.recorded) == 1
    assert runner.recorded[0]['user_id'] == USER_ID
    assert runner.recorded[0]['outcome'] == 'routed'
    assert runner.recorded[0]['usage'] == {'input_tokens': 342, 'output_tokens': 39}
    assert abs(runner._computeNodeCost('jev', 1_000_000, 10) - 0.042) < 1e-9


def test_an_unset_decline_is_recorded_once_and_the_model_never_runs():
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [_jev_answer(JevRouter.UNCLEAR, 1.0)])
    out = dispatch(runner, None)
    assert out['provider'] == 'jev'
    assert len(runner.recorded) == 1
    assert runner.recorded[0]['outcome'] == 'unclear'


def test_jev_mode_not_allowed_stops_with_the_plan_reason_and_records_nothing():
    # The user's own key does not bypass the plan.
    runner = make_runner('personal-jev-key', 'global-jev-key', _AgentRunner(False), [_jev_answer('Billing', 0.99)], False)
    out = dispatch(runner, {'routing_mode': 'jev'})
    assert out['success'] is False
    assert '(jev: unavailable: Jev is not enabled for your plan).' in out['output']
    assert out['halt_branches'] is True
    assert runner.recorded == [], 'a call that was never sent records nothing'


def test_jev_mode_without_a_key_records_nothing():
    runner = make_runner('', '', _AgentRunner(False), [])
    dispatch(runner, {'routing_mode': 'jev'})
    assert runner.recorded == []


def test_unset_mode_not_allowed_goes_to_the_model():
    runner = make_runner('', 'global-jev-key', _AgentRunner(True), [_jev_answer('Billing', 0.99)], False)
    out = dispatch(runner, None)
    assert out['success'] is True
    assert out['provider'] == 'openai'
    assert out['route']['name'] == 'Sales'
    assert runner.recorded == []
    assert runner.made == 0, 'not allowed: the Jev router is never built'


def test_null_jev_prices_give_an_unknown_cost_not_zero():
    """A jev row installed before prices existed: unknown cost, never a fake $0."""
    runner = make_runner('', 'global-jev-key', _AgentRunner(False), [], True, (None, None))
    assert runner._computeNodeCost('jev', 100, 0) is None


# ── DispatchRouting.unclearBranch (no PHP unit of its own; pinned here) ──

def test_unclear_branch_only_for_not_classified_outcomes():
    from app.agent_team.services.dispatch_routing import DispatchRouting
    targets = [{'id': 2, 'name': 'Billing'}, {'id': 3, 'name': 'Sales'}]
    s = {'unclear_branch': ' Sales '}
    assert DispatchRouting.unclearBranch(s, targets, 'unclear') == {'id': 3, 'name': 'Sales'}
    assert DispatchRouting.unclearBranch(s, targets, 'low_confidence') == {'id': 3, 'name': 'Sales'}
    assert DispatchRouting.unclearBranch(s, targets, 'unavailable') is None
    assert DispatchRouting.unclearBranch(s, targets, 'error') is None
    assert DispatchRouting.unclearBranch({}, targets, 'unclear') is None
    assert DispatchRouting.unclearBranch({'unclear_branch': 'Gone'}, targets, 'unclear') is None
