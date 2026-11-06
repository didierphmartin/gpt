"""Port of backend/tests/Unit/Services/RobotOwnershipTest.php: robot-owned workflows — who runs them, and whether
they are locked (active)."""
from __future__ import annotations

import pytest

from app.services.robot_ownership import RobotOwnership
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, kind TEXT NOT NULL DEFAULT 'person')",
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)',
        'CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT)',
        'CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL)')
    d.execute("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}')")
    d.execute("INSERT INTO users (id, email, role, kind) VALUES (3, 'p@x.test', 'user', 'person'), (120, 'r@x.test', 'robot', 'service')")
    d.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (75, 120, 'Robot wf'), (9, 3, 'Mine')")
    d.execute('INSERT INTO active_workflows (user_id, workflow_id) VALUES (120, 75)')
    return d


def own(db, edition: str = 'individual') -> RobotOwnership:
    return RobotOwnership(db, {'edition': edition})


def test_robot_owned_and_run_as(db):
    o = own(db)
    assert o.robotId() == 120
    assert o.isRobotOwned(75) is True
    assert o.isRobotOwned(9) is False
    assert o.runAs(3, 75) == 120
    assert o.runAs(3, 9) == 3


def test_locked(db):
    o = own(db)
    assert o.isLocked(75) is True
    assert o.isLocked(9) is False


def test_no_robot_permission_means_no_robot(db):
    o = own(db, 'corporate')
    assert o.robotFor(3) is None
    assert o.runAs(3, 75) == 3


def test_locked_run_name_and_link_robot_for(db):
    # beyond the PHP test: the other two public methods
    o = own(db)
    assert o.lockedRunName(3, 75) == 'Robot wf'
    assert o.lockedRunName(3, 9) is None
    assert own(db, 'corporate').lockedRunName(3, 75) is None
    assert o.linkRobotFor(120) == 120
    assert o.linkRobotFor(3) == 120
    assert own(db, 'corporate').linkRobotFor(3) is None
