"""Port of backend/tests/Unit/Controllers/RobotControllerTest.php."""
from __future__ import annotations

import pytest

from app.controllers.playbooks_controller import PlaybooksController
from app.controllers.robot_controller import RobotController
from app.playbook.playbook_store import PlaybookStore
from app.services.robot_account import RobotAccount
from tests.unit.playbook.conftest import OKTA, PLAYBOOKS_DDL, sqlite_db


@pytest.fixture
def db():
    d = sqlite_db(
        *PLAYBOOKS_DDL,
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, first_name TEXT, '
        "last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)",
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)')
    d.execute("""INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'),
        ('admin', 'Admin', 1, '{}'), ('ops', 'Ops', 0, '{"use_robot": true}')""")
    d.execute("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), "
              "(3, 'a@x.test', 'admin')")
    return d


def req(u, body=None, params=None):
    return {'user_id': u, 'body': body or {}, 'params': params or {}}


def test_publish_without_use_is_forbidden(db):
    src = PlaybookStore(db).save(1, None, OKTA, None)
    r = PlaybooksController(db, {'edition': 'corporate'}).publish(req(1, {}, {'id': src['id']}))
    assert r['success'] is False
    assert r['status_code'] == 403
    assert r['error'] == "Your role can't publish to the robot"


def test_publish_list_unpublish_and_replaces_payload(db):
    store = PlaybookStore(db)
    a = store.save(2, None, OKTA, None)
    c = PlaybooksController(db, {'edition': 'corporate'})
    r = c.publish(req(2, {}, {'id': a['id']}))
    assert r['success'] is True
    assert db.fetch_column(f"SELECT user_id FROM playbooks WHERE id = {r['data']['id']}") == [RobotAccount.id(db)]
    rows = c.index(req(2))['data']
    assert rows[0]['published'] == 'published'
    other = PlaybooksController(db, {'edition': 'corporate'}).index(req(1))['data']
    assert 'published' not in (other[0] if other else {})

    db.execute("UPDATE users SET role = 'ops' WHERE id = 1")
    b = store.save(1, None, OKTA, None)
    r = c.publish(req(1, {}, {'id': b['id']}))
    assert r['status_code'] == 409
    assert r['kind'] == 'replaces'
    assert 'published_at' in r['data']
    assert c.publish(req(1, {'confirm_replace': True}, {'id': b['id']}))['success'] is True

    robot = RobotController(db, {'edition': 'corporate'})
    assert robot.playbooks(req(99)).get('status_code', 0) == 403
    lst = robot.playbooks(req(2))['data']
    assert len(lst) == 1
    assert robot.unpublish(req(2, {}, {'id': lst[0]['id']}))['success'] is True
    assert robot.playbooks(req(3))['data'] == []


def test_confirm_replace_must_be_true_not_truthy(db):
    store = PlaybookStore(db)
    db.execute("UPDATE users SET role = 'ops' WHERE id = 1")
    a = store.save(2, None, OKTA, None)
    b = store.save(1, None, OKTA, None)
    c = PlaybooksController(db, {'edition': 'corporate'})
    c.publish(req(2, {}, {'id': a['id']}))
    assert c.publish(req(1, {'confirm_replace': 1}, {'id': b['id']}))['status_code'] == 409


def test_show_reports_flags_edition_and_creates_the_robot(db):
    assert RobotAccount.id(db) is None
    r = RobotController(db, {'edition': 'corporate'}).show(req(1))
    assert r['data'] == {'exists': True, 'name': 'SynergyAI Operations', 'can_use': False, 'can_manage': False,
                         'edition': 'corporate'}
    assert RobotAccount.id(db) is not None
    r = RobotController(db, {'edition': 'individual'}).show(req(1))
    assert r['data']['can_use'] and r['data']['can_manage']
    assert RobotController(db, {'edition': ''}).show(req(3))['data']['can_manage'] is True


def test_robot_routes_need_authentication(db):
    assert RobotController(db, {}).show({'user_id': 0})['status_code'] == 401
    assert PlaybooksController(db, {}).publish({'user_id': 0})['status_code'] == 401
