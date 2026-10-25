"""Port of backend/tests/Unit/DispatchProvidersTest.php: the browser asks the server to route with a
named decision provider; keys never leave it. In-memory SQLite + an httpx MockTransport (no network)."""
from __future__ import annotations

import json

import pytest

from app.controllers.dispatch_controller import DispatchController
from app.routes import ROUTES
from tests.unit.decision_fakes import json_response, mock_client
from tests.unit.playbook.conftest import sqlite_db

TARGETS = [{'id': 2, 'name': 'Billing'}, {'id': 3, 'name': 'Sales'}]


class _Usage:
    def __init__(self):
        self.calls = []

    def logTransaction(self, data):
        self.calls.append(data)
        return 1


class _Env:
    def __init__(self):
        self.db = sqlite_db(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)',
            'CREATE TABLE system_llm_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_key TEXT UNIQUE, '
            'display_name TEXT, api_key TEXT, model TEXT, base_url TEXT, api_format TEXT, protocol TEXT, '
            'enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, price_input_per_1m REAL, price_output_per_1m REAL)',
            'CREATE TABLE user_api_keys (user_id INTEGER, provider TEXT, api_key TEXT, base_url TEXT, '
            'enabled INTEGER DEFAULT 1, PRIMARY KEY (user_id, provider))',
            'CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)')
        self.db.execute("INSERT INTO users (id, email, role) VALUES (2, 'u@test', 'user')")
        self.db.execute(
            "INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, api_format, protocol, sort_order) VALUES "
            "('jev', 'Jev', 'jev-global', 'jev-latest', NULL, 'router', 'typesafe', 100), "
            "('acme', 'Acme', 'acme-global', 'acme-1', 'https://gw.corp/acme', 'router', 'typesafe', 50), "
            "('broken', 'Broken', 'k', 'm', NULL, 'router', NULL, 60), "
            "('claude', 'Claude', 'sk', 'c', 'https://api.anthropic.com', 'anthropic', NULL, 0)")
        self.db.execute('INSERT INTO packages (role, capabilities) VALUES (?, ?)', ['user', json.dumps({'providers': {
            'jev': {'enabled': True}, 'acme': {'enabled': True}, 'broken': {'enabled': True}}})])
        self.history: list = []
        self.usage = _Usage()

    def controller(self, answers=None) -> DispatchController:
        return DispatchController(self.db, {'auth': {'jwt_secret': 's'}}, mock_client(answers or [], self.history), self.usage)


@pytest.fixture
def env():
    return _Env()


def _answer(choice: str):
    return json_response(200, {'answers': {'route': {'choice': choice, 'confidence': 0.99}},
                               'usage': {'input_tokens': 3, 'output_tokens': 1}})


def test_providers_lists_every_row_with_its_status(env):
    out = env.controller().providers({'user_id': 2})
    assert [p['key'] for p in out['providers']] == ['acme', 'broken', 'jev']
    assert out['default'] == 'acme'
    acme = out['providers'][0]
    assert acme['routable'] is True
    assert acme['supported'] is True, 'this backend routes with decision models'
    assert acme['key_env'] == 'ACME_API_KEY'
    assert acme['url_env'] == 'ACME_BASE_URL'
    assert acme['legacy_env'] == {'key': 'TYPESAFE_API_KEY', 'url': 'TYPESAFE_BASE_URL'}
    assert 'api_key' not in acme, 'never the key'
    assert acme['default_url'] == 'https://gw.corp/acme'


def test_providers_list_marks_a_row_without_protocol_unroutable(env):
    broken = env.controller().providers({'user_id': 2})['providers'][1]
    assert broken['routable'] is False
    assert broken['reason'] == "'broken' is not an available decision provider"
    assert broken['legacy_env'] is None


def test_route_uses_the_named_providers_key_and_url(env):
    out = env.controller([_answer('Sales')]).route({'user_id': 2, 'body': {
        'provider': 'acme', 'request': 'buy', 'targets': TARGETS, 'question': 'q'}})
    assert out['outcome'] == 'routed'
    assert out['provider'] == 'acme'
    assert out['target'] == {'id': 3, 'name': 'Sales'}
    req = env.history[0]
    assert str(req.url) == 'https://gw.corp/acme'
    assert req.headers['Authorization'] == 'Bearer acme-global'
    assert json.loads(req.content)['model'] == 'acme-1'
    assert len(env.usage.calls) == 1 and env.usage.calls[0]['provider'] == 'acme'


def test_route_with_an_unknown_provider_calls_nothing(env):
    out = env.controller().route({'user_id': 2, 'body': {
        'provider': 'gone', 'request': 'x', 'targets': TARGETS, 'question': 'q'}})
    assert out['outcome'] == 'unavailable'
    assert out['reason'] == "'gone' is not an available decision provider"
    assert env.history == []
    assert env.usage.calls == [], 'a call never sent records nothing'


def test_route_needs_a_provider(env):
    out = env.controller().route({'user_id': 2, 'body': {'request': 'x', 'targets': TARGETS, 'question': 'q'}})
    assert out['status_code'] == 400


@pytest.mark.parametrize('body,message', [
    ({'provider': 'jev', 'targets': TARGETS, 'question': 'q'}, 'request is required'),
    ({'provider': 'jev', 'request': '  ', 'targets': TARGETS, 'question': 'q'}, 'request is required'),
    ({'provider': 'jev', 'request': 'x', 'targets': 'Billing', 'question': 'q'}, 'targets must be an array'),
    ({'provider': 'jev', 'request': 'x', 'targets': TARGETS}, 'question must be a string'),
    ({'provider': 'jev', 'request': 'x', 'targets': TARGETS, 'question': 'q', 'min_confidence': 'high'},
     'min_confidence must be a number'),
])
def test_route_validation_messages(env, body, message):
    """DispatchController::route's 400 answers, message for message."""
    assert env.controller().route({'user_id': 2, 'body': body}) == {'success': False, 'message': message, 'status_code': 400}


def test_route_clamps_min_confidence(env):
    out = env.controller([json_response(200, {'answers': {'route': {'choice': 'Sales', 'confidence': 0.5}}})]).route(
        {'user_id': 2, 'body': {'provider': 'jev', 'request': 'x', 'targets': TARGETS, 'question': 'q', 'min_confidence': -3}})
    assert out['outcome'] == 'routed', 'a floor below 0 is clamped to 0'


def test_the_jev_aliases_still_work(env):
    st = env.controller().jevStatus({'user_id': 2})
    assert st['available'] is True
    out = env.controller([_answer('Billing')]).jevRoute({'user_id': 2, 'body': {
        'request': 'x', 'targets': TARGETS, 'question': 'q'}})
    assert out['provider'] == 'jev'
    assert out['outcome'] == 'routed'


def test_status_is_per_provider(env):
    st = env.controller().status({'user_id': 2, 'params': {'key': 'acme'}}, 'acme')
    assert [st['provider'], st['allowed'], st['available'], st['source']] == ['acme', True, True, 'global']


def test_the_four_routes_are_registered_as_in_php():
    for r in [('POST', '/api/v1/dispatch/route', ('DispatchController', 'route')),
              ('GET', '/api/v1/dispatch/jev/status', ('DispatchController', 'jevStatus')),
              ('POST', '/api/v1/dispatch/jev', ('DispatchController', 'jevRoute')),
              ('GET', '/api/v1/dispatch/{key}/status', ('DispatchController', 'status'))]:
        assert r in ROUTES
