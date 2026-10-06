"""Port of backend/tests/Unit/Services/RobotPolicyTest.php."""
from __future__ import annotations

import pytest

from app.services.robot_policy import RobotPolicy
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)',
                  'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)')
    d.execute("""INSERT INTO packages (role, name, builtin, capabilities) VALUES
        ('guest', 'Guest', 1, '{}'), ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'),
        ('ops', 'Ops', 0, '{"use_robot": true}'), ('nope', 'Nope', 0, '{"use_robot": false}')""")
    d.execute("INSERT INTO users (id, role) VALUES (1, 'user'), (2, 'ops'), (3, 'nope'), (4, 'admin')")
    return d


def test_individual_uses_and_manages(db):
    p = RobotPolicy(db, {'edition': 'individual'})
    assert p.canUse(1)
    assert p.canManage(1)


@pytest.mark.parametrize('edition', ['corporate', ''])
def test_use_follows_the_role_capability_and_manage_is_admin(db, edition):
    p = RobotPolicy(db, {'edition': edition})
    assert not p.canUse(1)
    assert p.canUse(2)
    assert not p.canUse(3)
    assert not p.canManage(1)
    assert not p.canManage(2)
    assert p.canManage(4)
