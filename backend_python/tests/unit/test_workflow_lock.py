"""Port of backend/tests/Unit/Controllers/WorkflowLockTest.php: a robot workflow with an active row is locked —
edits, runs and schedule writes answer 423."""
from __future__ import annotations

import json

import pytest

from app.agent_team.controllers.scheduled_workflow_controller import ScheduledWorkflowController
from app.agent_team.controllers.workflow_controller import WorkflowController
from app.controllers.code_components_controller import CodeComponentsController
from app.services.robot_account import RobotAccount
from tests.unit import robot_schema

CONFIG = {'edition': 'corporate'}


def add_workflow_columns(db) -> None:
    have = {r['name'] for r in db.fetch_all('PRAGMA table_info(agent_workflows)')}
    for c, t in {'description': 'TEXT', 'steps': 'TEXT', 'triggers': 'TEXT', 'variables': 'TEXT',
                 'enabled': 'INTEGER DEFAULT 1', 'workspace_id': 'INTEGER', 'output_storage_enabled': 'INTEGER DEFAULT 0',
                 'output_folder': 'TEXT', 'orchestration': 'TEXT', 'created_at': 'TEXT', 'updated_at': 'TEXT'}.items():
        if c not in have:
            db.execute(f'ALTER TABLE agent_workflows ADD COLUMN {c} {t}')


@pytest.fixture
def env():
    db, ids = robot_schema.create()
    add_workflow_columns(db)
    robot = RobotAccount.ensure(db)
    db.execute(f'UPDATE agent_workflows SET user_id = {robot} WHERE id = 75')
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')")
    db.execute(f"INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({robot}, 75, 'event', '2026-10-29 09:00:00'),"
               " (3, 9, 'event', '2026-10-29 09:00:00')")
    return db, ids, robot


def req(u, body=None, params=None):
    return {'user_id': u, 'body': body or {}, 'params': params or {}, 'query': {}, 'files': {}}


def assert_locked(r):
    assert [r['success'], r.get('error_code'), r['status_code'], r.get('error')] == \
        [False, 'locked', 423, 'Mail to PDF is running as the robot. Unlock it first.'], r


def test_locked_workflow_refuses_edits_and_runs(env):
    db, _, _ = env
    wf = WorkflowController(db, CONFIG)
    p = {'id': 75}
    assert_locked(wf.update(req(2, {'name': 'X'}, p), 75))
    assert_locked(wf.destroy(req(2, {}, p), 75))
    assert_locked(wf.toggle(req(2, {}, p), 75))
    assert_locked(wf.run(req(2, {}, p), 75))
    assert_locked(wf.uploadNodeDocument(req(2, {}, {**p, 'nodeId': 1}), 75, 1))
    assert_locked(wf.saveDocumentMetadata(req(2, {}, {**p, 'nodeId': 1}), 75, 1))
    assert_locked(wf.deleteNodeDocument(req(2, {}, {**p, 'nodeId': 1, 'docId': 'd'}), 75, 1, 'd'))
    assert db.fetch_one('SELECT name FROM agent_workflows WHERE id = 75')['name'] == 'Mail to PDF'


def test_locked_workflow_refuses_schedule_writes(env):
    db, _, _ = env
    sc = ScheduledWorkflowController(db, CONFIG)
    assert_locked(sc.create(req(2, {'workflow_id': 75, 'scheduled_time': '2026-11-01 10:00:00'})))
    sid = db.fetch_one('SELECT id FROM scheduled_workflows WHERE workflow_id = 75')['id']
    for m in ('update', 'destroy', 'pause', 'resume'):
        assert_locked(getattr(sc, m)(req(2, {'scheduled_time': '2026-11-01 10:00:00'}, {'id': sid}), sid))


def test_locked_start_option_refuses_component_changes(env):
    db, ids, _ = env
    cc = CodeComponentsController(db, CONFIG)
    p = {'id': ids['Poll Drop']}
    assert_locked(cc.setStartOption(req(2, {}, p)))
    assert_locked(cc.clearStartOption(req(2, {}, p)))


def test_unlocking_allows_the_edit(env):
    db, _, _ = env
    wf = WorkflowController(db, CONFIG)
    db.execute('DELETE FROM active_workflows WHERE workflow_id = 75')
    r = wf.update(req(2, {'name': 'Renamed'}, {'id': 75}), 75)
    assert r['success'] is True, r
    assert db.fetch_one('SELECT name FROM agent_workflows WHERE id = 75')['name'] == 'Renamed'


def test_personal_active_workflow_is_not_locked(env):
    db, _, _ = env
    r = WorkflowController(db, CONFIG).update(req(3, {'name': 'Mine2'}, {'id': 9}), 9)
    assert r['success'] is True, r


def test_caller_without_access_gets_404_not_the_lock(env):
    # user 1 has no robot permission and owns nothing here
    db, ids, _ = env
    sc = ScheduledWorkflowController(db, CONFIG)
    sid = db.fetch_one('SELECT id FROM scheduled_workflows WHERE workflow_id = 75')['id']
    rs = [sc.create(req(1, {'workflow_id': 75, 'scheduled_time': '2026-11-01 10:00:00'}))]
    for m in ('update', 'destroy', 'pause', 'resume'):
        rs.append(getattr(sc, m)(req(1, {'scheduled_time': '2026-11-01 10:00:00'}, {'id': sid}), sid))
    rs.append(CodeComponentsController(db, CONFIG).setStartOption(req(1, {}, {'id': ids['Poll Drop']})))
    rs.append(CodeComponentsController(db, CONFIG).clearStartOption(req(1, {}, {'id': ids['Poll Drop']})))
    for r in rs:
        assert r['status_code'] == 404, r
        assert 'Mail to PDF' not in json.dumps(r)
        assert 'error_code' not in r


def test_list_and_show_mark_robot_and_locked(env):
    db, _, robot = env
    wf = WorkflowController(db, CONFIG)
    rows = {r['id']: r for r in wf.index(req(2))['data']}
    assert (rows[75]['is_robot'], rows[75]['locked']) == (True, True)
    shown = wf.show(req(2, {}, {'id': 75}), 75)['data']
    assert (shown['is_robot'], shown['locked']) == (True, True)
    # no robot permission: the robot's workflow is neither listed nor shown
    assert 75 not in {r['id'] for r in wf.index(req(1))['data']}
    assert wf.show(req(1, {}, {'id': 75}), 75)['status_code'] == 404
