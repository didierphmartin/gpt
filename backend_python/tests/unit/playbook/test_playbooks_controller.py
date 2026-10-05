"""Port of backend/tests/Unit/Playbook/PlaybooksControllerTest.php."""
from __future__ import annotations

import pytest

from app.controllers.playbooks_controller import PlaybooksController
from tests.unit.playbook.conftest import OKTA


@pytest.fixture
def c(pbc_db):
    return PlaybooksController(pbc_db, {})


def req(body=None, params=None, user=3):
    return {'user_id': user, 'body': body or {}, 'query': {}, 'params': params or {}}


def test_create_show_list_round_trip_the_text_verbatim(c):
    r = c.create(req({'text': OKTA, 'pkey': 'okta-reset'}))
    assert r['success'] is True
    id_ = r['data']['id']
    assert c.show(req({}, {'id': id_}))['data']['text'] == OKTA
    lst = c.index(req())
    assert lst['data'][0]['pkey'] == 'okta-reset'
    assert lst['data'][0]['used_by'] == 0


def test_errors_carry_kind_and_status(c):
    bad = c.create(req({'text': "Trigger: x\n"}))
    assert bad['success'] is False and bad['kind'] == 'invalid_text'
    assert bad['status_code'] == 422
    assert c.show(req({}, {'id': 42}))['status_code'] == 404
    assert c.show(req({}, {'id': 42}))['error'] == 'Playbook #42 not found'
    assert c.index({'user_id': 0})['status_code'] == 401
    assert c.create(req({'text': ''}))['status_code'] == 400


def test_update_used_by_and_delete(c):
    id_ = c.create(req({'text': OKTA}))['data']['id']
    u = c.update(req({'text': OKTA, 'pkey': 'okta-reset'}, {'id': id_}))
    assert u['data']['pkey'] == 'okta-reset'
    assert c.usedBy(req({}, {'id': id_}))['data'] == {'agents': [], 'nodes': []}
    assert c.destroy(req({}, {'id': id_}))['success'] is True
    assert c.index(req())['data'] == []
