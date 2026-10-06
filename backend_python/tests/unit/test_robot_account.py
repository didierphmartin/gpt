"""Port of backend/tests/Unit/Services/RobotAccountTest.php."""
from __future__ import annotations

import pytest

from app.services.robot_account import RobotAccount
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    return sqlite_db(
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT)',
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, first_name TEXT, last_name TEXT, '
        "password TEXT, provider TEXT, role TEXT, kind TEXT DEFAULT 'person', email_verified INTEGER DEFAULT 0)")


def test_ensure_creates_the_robot_once_with_its_role(db):
    db.execute("""INSERT INTO packages (role, capabilities) VALUES ('user', '{"sidebar":{},"providers":{}}')""")
    id_ = RobotAccount.ensure(db)
    assert RobotAccount.ensure(db) == id_
    assert RobotAccount.id(db) == id_
    row = db.fetch_one(f'SELECT email, first_name, last_name, password, role, kind FROM users WHERE id = {id_}')
    assert row == {'email': 'robot@synergyai.invalid', 'first_name': 'SynergyAI', 'last_name': 'Operations',
                   'password': None, 'role': 'robot', 'kind': 'service'}
    pkg = db.fetch_one("SELECT name, builtin, capabilities FROM packages WHERE role = 'robot'")
    assert pkg['name'] == 'Robot'
    assert int(pkg['builtin']) == 1
    assert pkg['capabilities'] == '{"sidebar":{},"providers":{}}'
    assert db.fetch_column("SELECT COUNT(*) FROM users WHERE kind = 'service'") == [1]
    assert db.fetch_column("SELECT COUNT(*) FROM packages WHERE role = 'robot'") == [1]


def test_ensure_without_a_user_row_gets_empty_capabilities(db):
    RobotAccount.ensure(db)
    assert db.fetch_column("SELECT capabilities FROM packages WHERE role = 'robot'") == ['{}']


def test_id_does_not_create(db):
    assert RobotAccount.id(db) is None
    assert db.fetch_column('SELECT COUNT(*) FROM users') == [0]
