"""Port of backend/tests/Unit/Controllers/RolesControllerTest.php."""
from __future__ import annotations

import pytest

from app.controllers.roles_controller import RolesController
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def c():
    db = sqlite_db(
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, '
        'updated_at TEXT, updated_by INTEGER)',
        "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, role TEXT, kind TEXT DEFAULT 'person')")
    db.execute("INSERT INTO users (id, email, role) VALUES (1, 'admin@x.test', 'admin'), (2, 'u@x.test', 'user')")
    db.execute("""INSERT INTO packages (role, name, builtin, capabilities) VALUES
        ('user', NULL, 1, '{"providers":{},"sidebar":{}}'), ('admin', NULL, 1, '{}')""")
    return RolesController(db, {})


def req(uid, body=None, role=None):
    return {'user_id': uid, 'body': body or {}, 'params': {} if role is None else {'role': role}}


def test_non_admin_is_refused_everywhere(c):
    for call in (
        lambda: c.index(req(2)),
        lambda: c.create(req(2, {'role': 'x', 'name': 'X'})),
        lambda: c.rename(req(2, {'name': 'X'}, 'user')),
        lambda: c.destroy(req(2, {}, 'user')),
    ):
        out = call()
        assert out['success'] is False
        assert out['status_code'] == 403
        assert out['error'] == 'Admin access required'
    assert c.index(req(None))['status_code'] == 401


def test_admin_flow_with_digits_and_dashes(c):
    out = c.create(req(1, {'role': 'it-ops-2', 'name': 'IT Ops', 'copy_from': 'user'}))
    assert out['success'] is True
    assert out['data']['role'] == 'it-ops-2'

    keys = [r['role'] for r in c.index(req(1))['data']]
    assert 'it-ops-2' in keys

    out = c.rename(req(1, {'name': 'Ops Two'}, 'it-ops-2'))
    assert out['data']['name'] == 'Ops Two'

    out = c.create(req(1, {'role': '2024', 'name': 'Numeric'}))
    assert out['success'] is True
    # main.py hands an all-digit route param over as an int too; the key comes from params as a string.
    assert c.destroy(req(1, {}, 2024), 2024)['success'] is True

    out = c.destroy(req(1, {}, 'it-ops-2'))
    assert out['success'] is True


def test_errors_carry_kind_and_status(c):
    out = c.create(req(1, {'role': 'Bad Key', 'name': 'x'}))
    assert [out['success'], out['kind'], out['status_code']] == [False, 'invalid_key', 422]
    out = c.destroy(req(1, {}, 'user'))
    assert out['status_code'] == 409
