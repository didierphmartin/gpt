"""Port of backend/tests/Unit/OpenAIDecisionRouterTest.php (the PHP-side cases; testThePythonTwinMatches
covers the LangGraph runtime emitter, which this backend does not port yet)."""
from __future__ import annotations

import json

from app.agent_team.services.decision_router import DecisionRouter
from app.agent_team.services.jev_router import JevRouter
from app.agent_team.services.openai_decision_router import OpenAIDecisionRouter
from app.services.decision_protocols import DecisionProtocols
from tests.unit.decision_fakes import ConnectFailure, json_response, mock_client

TARGETS = [
    {'id': 1, 'name': 'Billing', 'description': 'Invoices, payments, refunds.'},
    {'id': 2, 'name': 'Sales', 'description': ''},
]


class _Ctx:
    def __init__(self):
        self.seen: list = []

    def router(self, queue, floor=JevRouter.DEFAULT_CONFIDENCE_FLOOR, url='', model=''):
        self.seen = []
        return OpenAIDecisionRouter('test-key', mock_client(queue, self.seen), floor, url, model)


def _answer(choice: str, confidence: float):
    return json_response(200, {'model': 'gpt-6-luna', 'answers': [{
        'type': 'choice', 'name': 'route', 'choice': choice, 'confidence': confidence,
        'probabilities': [{'value': choice, 'probability': confidence}],
    }], 'usage': {'input_tokens': 120, 'output_tokens': 0}})


def test_it_sends_the_documented_request():
    c = _Ctx()
    c.router([_answer('Billing', 0.95)]).route('I was charged twice.', TARGETS, 'Which team?')
    req = c.seen[0]
    assert str(req.url) == OpenAIDecisionRouter.URL
    assert req.headers['Authorization'] == 'Bearer test-key'
    body = json.loads(req.content)
    assert body['model'] == 'gpt-6-luna'
    assert body['input'] == 'I was charged twice.'
    q = body['questions'][0]
    assert {k: q[k] for k in ('type', 'name', 'instructions')} == {'type': 'choice', 'name': 'route', 'instructions': 'Which team?'}
    assert [ch['value'] for ch in q['choices']] == ['Billing', 'Sales', 'unclear']
    assert q['choices'][1]['description'] == 'Sales', 'no description falls back to the name'


def test_gateway_url_and_row_model():
    c = _Ctx()
    c.router([_answer('Billing', 0.95)], 0.6, 'https://gw.corp/decisions', 'gpt-6-luna-2026-10-06').route('x', TARGETS, 'q')
    assert str(c.seen[0].url) == 'https://gw.corp/decisions'
    assert json.loads(c.seen[0].content)['model'] == 'gpt-6-luna-2026-10-06'


def test_outcomes():
    c = _Ctx()
    out = c.router([_answer('Billing', 0.93)]).route('x', TARGETS, 'q')
    assert [out['outcome'], out['target']['id'], out['confidence'], out['usage']['input_tokens']] == ['routed', 1, 0.93, 120]
    assert c.router([_answer('unclear', 1.0)]).route('hello', TARGETS, 'q')['outcome'] == 'unclear'
    low = c.router([_answer('Sales', 0.46)]).route('x', TARGETS, 'q')
    assert [low['outcome'], low['target']['id']] == ['low_confidence', 2]
    assert c.router([_answer('Support', 0.99)]).route('x', TARGETS, 'q')['outcome'] == 'error'


def test_refusal_is_an_error_that_keeps_its_usage():
    c = _Ctx()
    out = c.router([json_response(200, {'answers': [{'type': 'refusal', 'name': 'route'}],
                                        'usage': {'input_tokens': 9}})]).route('x', TARGETS, 'q')
    assert [out['outcome'], out['reason'], out['usage']['input_tokens']] == ['error', 'the model refused to answer', 9]
    assert out['ms'] is not None


def test_failures_and_bad_menus():
    assert OpenAIDecisionRouter(None).route('x', TARGETS, 'q')['outcome'] == 'unavailable'
    c = _Ctx()
    net = c.router([ConnectFailure('down')]).route('x', TARGETS, 'q')
    assert [net['outcome'], net['ms']] == ['error', None]
    assert c.router([]).route('x', [TARGETS[0], {'id': 3, 'name': 'Unclear'}], 'q')['outcome'] == 'error'
    assert c.router([]).route('x', [TARGETS[0]], 'q')['outcome'] == 'error'
    assert c.seen == [], 'a refused menu calls nobody'


def test_api_errors_report_their_own_message():
    msg = ('You have no credits remaining. Add credits to continue using the API at '
           'https://platform.openai.com/account/billing to keep going.')
    body = json.dumps({'error': {'message': msg, 'type': 'insufficient_quota', 'code': 'insufficient_quota'}})
    c = _Ctx()
    out = c.router([json_response(429, body)]).route('x', TARGETS, 'q')
    assert out['outcome'] == 'error'
    assert out['reason'] == f'OpenAI HTTP 429 (insufficient_quota): {msg}', "the whole message, not Guzzle's truncated dump"
    assert c.router([json_response(502, '<html>')]).route('x', TARGETS, 'q')['reason'] == 'OpenAI HTTP 502'


def test_it_is_registered():
    p = DecisionProtocols.get('openai')
    assert p['adapter'] is OpenAIDecisionRouter
    assert p['legacy_env'] is None, 'OPENAI_API_KEY is the chat key; the .env sync must never drop it'
    assert issubclass(p['adapter'], DecisionRouter)
