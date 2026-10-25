"""Port of backend/tests/Unit/JevRouterTest.php.

The router's decisions, against recorded API shapes. Mocked rather than live: the point is the OUTCOME
MAPPING -- which responses may decide a route and which must not -- checked without a network or a key.
"""
from __future__ import annotations

import json

from app.agent_team.services.decision_router import DecisionRouter
from app.agent_team.services.jev_router import JevRouter
from tests.unit.decision_fakes import ConnectFailure, json_response, mock_client

TARGETS = [
    {'id': 1, 'name': 'Billing', 'description': 'Invoices, payments, refunds.'},
    {'id': 2, 'name': 'Sales', 'description': 'Pricing, plans, demos.'},
]


def _router(queue, floor=JevRouter.DEFAULT_CONFIDENCE_FLOOR, history=None):
    return JevRouter('test-key', mock_client(queue, history), floor)


def _answer(choice: str, confidence: float):
    return json_response(200, {'model': 'jev-1.13.0', 'answers': {'route': {
        'type': 'choice', 'choice': choice, 'confidence': confidence, 'probabilities': {choice: confidence},
    }}, 'usage': {'input_tokens': 342, 'output_tokens': 39}})


def test_it_posts_to_a_configured_gateway_url():
    seen = []
    JevRouter('test-key', mock_client([_answer('Billing', 0.99)], seen), JevRouter.DEFAULT_CONFIDENCE_FLOOR,
              'https://gw.corp/jev').route('I was charged twice.', TARGETS, 'Which team?')
    assert str(seen[0].url) == 'https://gw.corp/jev'


def test_it_posts_to_the_vendor_url_by_default():
    seen = []
    JevRouter('test-key', mock_client([_answer('Billing', 0.99)], seen)).route('I was charged twice.', TARGETS, 'Which team?')
    assert str(seen[0].url) == JevRouter.URL
    assert seen[0].headers['Authorization'] == 'Bearer test-key'
    body = json.loads(seen[0].content)
    assert body['state'] == {'request': 'I was charged twice.'}
    assert list(body['questions']['route']['criteria']) == ['Billing', 'Sales', 'unclear']


def test_a_confident_choice_routes():
    out = _router([_answer('Billing', 0.99)]).route('I was charged twice.', TARGETS, 'Which team?')
    assert out['outcome'] == 'routed'
    assert out['target']['id'] == 1
    assert out['confidence'] == 0.99
    assert out['usage']['input_tokens'] == 342


def test_unclear_routes_nowhere():
    """Without an `unclear` option every input saturates; choosing it means "route nowhere"."""
    out = _router([_answer(JevRouter.UNCLEAR, 1.0)]).route('hello', TARGETS, 'Which team?')
    assert out['outcome'] == 'unclear'
    assert out['target'] is None


def test_low_confidence_does_not_decide():
    out = _router([_answer('Sales', 0.46)]).route('Upgrade me to annual.', TARGETS, 'Which team?')
    assert out['outcome'] == 'low_confidence'
    assert out['target']['name'] == 'Sales'
    assert 'below floor' in out['reason']
    assert out['reason'] == 'confidence 0.46 below floor 0.60'


def test_the_floor_is_configurable_not_a_belief():
    out = _router([_answer('Sales', 0.46)], 0.4).route('Upgrade me.', TARGETS, 'Which team?')
    assert out['outcome'] == 'routed', 'a lower floor must let 0.46 through'


def test_no_key_is_unavailable_not_fatal():
    r = JevRouter('', mock_client([]))
    assert r.isAvailable() is False
    assert r.route('x', TARGETS, 'q')['outcome'] == 'unavailable'


def test_null_key_ignores_the_environment(monkeypatch):
    """A None key means "not configured", even when a stale TYPESAFE_API_KEY is exported."""
    monkeypatch.setenv('TYPESAFE_API_KEY', 'env-key-must-be-ignored')
    r = JevRouter(None, mock_client([]))
    assert r.isAvailable() is False
    assert r.route('x', TARGETS, 'q')['outcome'] == 'unavailable'


def test_transport_failure_falls_back():
    out = _router([ConnectFailure('timeout')]).route('x', TARGETS, 'q')
    assert out['outcome'] == 'error'
    assert out['target'] is None


def test_a_branch_named_unclear_is_refused():
    targets = [{'id': 1, 'name': 'unclear', 'description': 'x'}, {'id': 2, 'name': 'Sales', 'description': 'y'}]
    out = _router([]).route('x', targets, 'q')
    assert out['outcome'] == 'error'
    assert 'unusable target name' in out['reason']


def test_a_menu_of_one_is_refused():
    out = _router([]).route('x', [TARGETS[0]], 'q')
    assert out['outcome'] == 'error'
    assert 'at least two' in out['reason']


def test_an_off_menu_answer_is_an_error():
    out = _router([_answer('Engineering', 0.99)]).route('x', TARGETS, 'q')
    assert out['outcome'] == 'error'
    assert 'not on the menu' in out['reason']


def test_an_answer_without_a_choice_keeps_its_time_and_usage():
    res = json_response(200, {'answers': [], 'usage': {'input_tokens': 342, 'output_tokens': 0}})
    out = _router([res]).route('x', TARGETS, 'q')
    assert out['outcome'] == 'error'
    assert out['reason'] == 'no choice in the response'
    assert isinstance(out['ms'], int)
    assert out['usage']['input_tokens'] == 342


def test_refused_and_failed_calls_have_no_time():
    assert _router([]).route('x', [TARGETS[0]], 'q')['ms'] is None
    assert _router([ConnectFailure('timeout')]).route('x', TARGETS, 'q')['ms'] is None


def test_an_http_error_is_an_error_with_guzzles_message():
    """Python-only: Guzzle throws on 4xx/5xx (http_errors); the reason is its RequestException message."""
    out = _router([json_response(401, '{"error":"bad key"}')]).route('x', TARGETS, 'q')
    assert out['outcome'] == 'error'
    assert out['ms'] is None
    assert out['reason'].startswith('Client error: `POST https://api.typesafe.ai/v1/systemone` resulted in a `401 Unauthorized` response')


def test_the_model_comes_from_the_row():
    history = []
    JevRouter('k', mock_client([_answer('Billing', 0.99)], history), 0.6, '', 'jev-2').route('x', TARGETS, 'q')
    assert json.loads(history[0].content)['model'] == 'jev-2'


def test_an_empty_model_is_the_vendor_default():
    history = []
    JevRouter('k', mock_client([_answer('Billing', 0.99)], history)).route('x', TARGETS, 'q')
    assert json.loads(history[0].content)['model'] == JevRouter.MODEL


def test_it_is_a_decision_router():
    assert isinstance(JevRouter('k'), DecisionRouter)
