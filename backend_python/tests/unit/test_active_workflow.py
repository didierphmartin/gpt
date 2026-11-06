"""Ports of backend/tests/Unit/EventWorker/ActiveWorkflowServiceTest.php and ActiveWorkflowControllerTest.php."""
from __future__ import annotations

import pytest

from app.agent_team.controllers.active_workflow_controller import ActiveWorkflowController
from app.agent_team.controllers.scheduled_workflow_controller import ScheduledWorkflowController
from app.agent_team.services.active_workflow_service import ActiveWorkflowError, ActiveWorkflowService
from tests.unit import event_worker_schema as S



class Clock:
    now = '2026-10-14 09:00:00'


@pytest.fixture
def db():
    clock = Clock()
    d = S.create(lambda: clock.now)
    d.clock = clock
    d.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, kind TEXT NOT NULL DEFAULT 'person')")   # the robot keeps several rows
    d.execute("INSERT INTO users (id, role, kind) VALUES (3, 'user', 'person'), (4, 'user', 'person'), (9, 'robot', 'service')")
    d.execute('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)')
    S.option(d, 1, 3)
    return d


def svc(db) -> ActiveWorkflowService:
    return ActiveWorkflowService(db)


def refused(fn) -> ActiveWorkflowError:
    with pytest.raises(ActiveWorkflowError) as e:
        fn()
    return e.value


def test_mode_reads_the_newest_live_row(db):
    S.workflow(db, 64, 3, 1)
    assert svc(db).mode(64)['mode'] == 'prompt'
    S.row(db, 64, 3, 'daily')
    assert svc(db).mode(64)['mode'] == 'schedule'
    id = S.row(db, 64, 3, 'event', 1)
    m = svc(db).mode(64)
    assert [m['mode'], int(m['schedule']['id']), m['component_id']] == ['option', id, 1]


def test_a_paused_row_is_not_a_mode(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1, 'paused')
    assert svc(db).mode(64)['mode'] == 'prompt'


def test_an_event_row_whose_start_is_not_on_its_option_is_mode_gone(db):
    S.workflow(db, 62, 3, None)          # Start on Enter Prompt, row left behind
    S.row(db, 62, 3, 'event', 1)
    assert svc(db).mode(62)['mode'] == 'mode_gone'
    db.execute('UPDATE workflow_nodes SET config = \'{"type":"start","start_option":1}\' WHERE node_type = \'start\'')
    db.execute('UPDATE code_components SET start_trigger = NULL')   # no longer an option
    assert svc(db).mode(62)['mode'] == 'mode_gone'


def test_activate_an_option_workflow(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    r = svc(db).activate(3, 64)
    assert r['replaced'] is None
    a = r['active']
    assert [int(a['workflow_id']), a['mode'], int(a['trigger_component_id']), a['watch_state']] == [64, 'option', 1, 'starting']
    assert a['workflow_name'] == 'wf 64'


def test_activating_another_replaces_it(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    S.workflow(db, 70, 3, None)
    S.row(db, 70, 3, 'daily')
    svc(db).activate(3, 64)
    r = svc(db).activate(3, 70)
    assert r['replaced'] == {'workflow_id': 64, 'workflow_name': 'wf 64'}
    assert svc(db).get(3)['mode'] == 'schedule'
    assert db.fetch_column('SELECT COUNT(*) FROM active_workflows')[0] == 1


def test_refusals(db):
    S.workflow(db, 64, 3, 1)
    e = refused(lambda: svc(db).activate(3, 64))
    assert [e.kind, e.status] == ['no_trigger', 422]
    S.workflow(db, 65, 3, 1, False)       # no links
    S.row(db, 65, 3, 'event', 1)
    assert refused(lambda: svc(db).activate(3, 65)).kind == 'no_links'
    assert refused(lambda: svc(db).activate(4, 64)).kind == 'not_found'   # not the owner
    assert refused(lambda: svc(db).activate(3, 999)).kind == 'not_found'


def test_deactivate_only_that_workflow(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    svc(db).activate(3, 64)
    svc(db).deactivate(3, 70)
    assert svc(db).get(3) is not None
    svc(db).deactivate(3, 64)
    assert svc(db).get(3) is None


def test_sweep_deactivates_when_the_mode_changed(db):
    S.workflow(db, 64, 3, 1)
    row = S.row(db, 64, 3, 'event', 1)
    svc(db).activate(3, 64)
    assert svc(db).sweep() == []
    db.execute(f'DELETE FROM scheduled_workflows WHERE id = {row}')   # switched to Enter Prompt
    assert svc(db).sweep() == [64]
    assert svc(db).get(3) is None


def test_sweep_deactivates_another_option(db):
    S.option(db, 2, 3)
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    svc(db).activate(3, 64)
    db.execute('UPDATE workflow_nodes SET config = \'{"type":"start","start_option":2}\' WHERE workflow_id = 64 AND node_type = \'start\'')
    S.row(db, 64, 3, 'event', 2)
    assert svc(db).sweep() == [64]


def test_check_reasons(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    svc(db).activate(3, 64)

    def row():
        return svc(db).all()[0]
    c = svc(db).check(row())
    assert [c['ok'], c['reason']] == [True, None]
    db.execute('DELETE FROM workflow_edges')
    assert svc(db).check(row())['reason'] == 'no_links'
    db.execute('UPDATE agent_workflows SET enabled = 0')
    assert svc(db).check(row())['reason'] == 'disabled'


def test_state_and_ages(db):
    S.workflow(db, 64, 3, 1)
    S.row(db, 64, 3, 'event', 1)
    svc(db).activate(3, 64)
    assert svc(db).get(3)['checked_age_s'] is None
    db.clock.now = '2026-10-14 09:00:40'
    svc(db).setState(3, 64, 'waiting', 'fallback')
    db.clock.now = '2026-10-14 09:01:00'
    a = svc(db).get(3)
    assert [a['watch_state'], a['watch_message'], a['checked_age_s'], a['activated_age_s']] == ['waiting', 'fallback', 20, 60]


def test_schedule_workflow_ids_and_cascade(db):
    S.workflow(db, 70, 3, None)
    S.row(db, 70, 3, 'daily')
    svc(db).activate(3, 70)
    assert svc(db).scheduleWorkflowIds() == [70]
    db.execute('DELETE FROM agent_workflows WHERE id = 70')
    assert svc(db).get(3) is None


def test_schedule_workflow_ids_skips_rows_that_do_not_qualify(db):
    S.workflow(db, 70, 3, None)
    S.row(db, 70, 3, 'daily')
    svc(db).activate(3, 70)
    S.workflow(db, 71, 4, None)
    S.row(db, 71, 4, 'daily')
    svc(db).activate(4, 71)
    assert svc(db).scheduleWorkflowIds() == [70, 71]
    db.execute('UPDATE agent_workflows SET enabled = 0 WHERE id = 70')   # disabled
    db.execute('DELETE FROM workflow_edges WHERE workflow_id = 71')      # no links
    assert svc(db).scheduleWorkflowIds() == []
    db.execute('UPDATE agent_workflows SET enabled = 1 WHERE id = 70')
    assert svc(db).scheduleWorkflowIds() == [70]


# ---------------------------------------------------------------- controller

@pytest.fixture
def cdb(db):
    S.workflow(db, 64, 3, 1)
    return db


def ctl(db) -> ActiveWorkflowController:
    return ActiveWorkflowController(db, {})


def test_activate_get_deactivate(cdb):
    S.row(cdb, 64, 3, 'event', 1)
    r = ctl(cdb).activate({'user_id': 3, 'params': {'id': 64}})
    assert [r['success'], r['status_code'], int(r['data']['active']['workflow_id'])] == [True, 200, 64]
    assert int(ctl(cdb).show({'user_id': 3})['data']['workflow_id']) == 64
    assert ctl(cdb).deactivate({'user_id': 3, 'params': {'id': 64}})['status_code'] == 200
    assert ctl(cdb).show({'user_id': 3})['data'] is None


def test_a_refusal_carries_its_kind(cdb):
    r = ctl(cdb).activate({'user_id': 3, 'params': {'id': 64}})
    assert [r['success'], r['kind'], r['status_code']] == [False, 'no_trigger', 422]


def test_authentication_is_required(cdb):
    assert ctl(cdb).show({})['status_code'] == 401


def test_deleting_the_event_row_deactivates(cdb):
    row = S.row(cdb, 64, 3, 'event', 1)
    ActiveWorkflowService(cdb).activate(3, 64)
    r = ScheduledWorkflowController(cdb, {}).destroy({'user_id': 3, 'params': {'id': row}}, row)
    assert r['success'] is True
    assert ActiveWorkflowService(cdb).get(3) is None


def test_a_failing_sweep_does_not_fail_the_write(cdb):
    row = S.row(cdb, 64, 3, 'event', 1)
    cdb.execute('DROP TABLE active_workflows')   # the table is not migrated yet
    r = ScheduledWorkflowController(cdb, {}).destroy({'user_id': 3, 'params': {'id': row}}, row)
    assert r['success'] is True
    assert cdb.fetch_column(f'SELECT COUNT(*) FROM scheduled_workflows WHERE id = {row}')[0] == 0


# ---------------------------------------------------------------- robot rows (PHP ActiveWorkflowServiceTest / ActiveWorkflowControllerTest)

def rows(db) -> list:
    return [[int(r['user_id']), int(r['workflow_id'])] for r in db.fetch_all('SELECT user_id, workflow_id FROM active_workflows ORDER BY user_id, workflow_id')]


def test_a_person_keeps_one_row(db):
    S.workflow(db, 9, 3, None)
    S.row(db, 9, 3, 'daily')
    S.workflow(db, 10, 3, None)
    S.row(db, 10, 3, 'daily')
    svc(db).activate(3, 9)
    r = svc(db).activate(3, 10)
    assert r['replaced'] == {'workflow_id': 9, 'workflow_name': 'wf 9'}
    assert rows(db) == [[3, 10]]


def test_the_robot_keeps_one_row_per_workflow(db):
    S.option(db, 2, 9)
    S.workflow(db, 75, 9, 2)
    S.row(db, 75, 9, 'event', 2)
    S.workflow(db, 76, 9, None)
    S.row(db, 76, 9, 'daily')
    assert svc(db).activate(9, 75)['replaced'] is None
    r = svc(db).activate(9, 76)
    assert r['replaced'] is None
    assert int(r['active']['workflow_id']) == 76
    assert rows(db) == [[9, 75], [9, 76]]
    svc(db).activate(9, 75)                                   # again: still one row for it
    assert rows(db) == [[9, 75], [9, 76]]
    db.clock.now = '2026-10-14 09:00:30'
    svc(db).setState(9, 76, 'scheduled', 'soon')              # only that row
    assert db.fetch_column('SELECT watch_state FROM active_workflows ORDER BY workflow_id') == ['starting', 'scheduled']
    svc(db).deactivate(9, 75)
    assert rows(db) == [[9, 76]]


def test_for_workflow(db):
    S.workflow(db, 75, 9, None)
    S.row(db, 75, 9, 'daily')
    S.workflow(db, 76, 9, None)
    S.row(db, 76, 9, 'daily')
    assert svc(db).forWorkflow(75) is None
    svc(db).activate(9, 75)
    svc(db).activate(9, 76)
    db.clock.now = '2026-10-14 09:00:20'
    a = svc(db).forWorkflow(75)
    assert [int(a['user_id']), int(a['workflow_id']), a['workflow_name'], a['checked_age_s'], a['activated_age_s']] == [9, 75, 'wf 75', None, 20]
    assert int(svc(db).forWorkflow(76)['workflow_id']) == 76


def old_primary_key(db) -> None:
    """The production table before 2026-10-29_active_workflows_per_workflow.sql: keyed by user_id alone."""
    db.execute('DROP TABLE active_workflows')
    db.execute("CREATE TABLE active_workflows (user_id INTEGER NOT NULL PRIMARY KEY, workflow_id INTEGER NOT NULL,"
               " mode TEXT NOT NULL, trigger_component_id INTEGER, activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting',"
               " watch_message TEXT, watch_checked_at TEXT)")


def test_on_the_old_key_a_second_robot_workflow_is_busy_not_an_sql_error(db):
    old_primary_key(db)
    S.workflow(db, 75, 9, None)
    S.row(db, 75, 9, 'daily')
    S.workflow(db, 76, 9, None)
    S.row(db, 76, 9, 'daily')
    svc(db).activate(9, 75)
    e = refused(lambda: svc(db).activate(9, 76))
    assert [e.kind, e.status, str(e)] == ['robot_busy', 409, 'The robot can run one workflow at a time until the database is updated.']
    assert rows(db) == [[9, 75]]
    svc(db).activate(9, 75)                                   # the same one again still works
    assert rows(db) == [[9, 75]]


def test_for_workflow_of_a_personal_workflow(cdb):
    S.row(cdb, 64, 3, 'event', 1)
    assert ctl(cdb).forWorkflow({'user_id': 3, 'params': {'id': 64}})['data'] is None
    ctl(cdb).activate({'user_id': 3, 'params': {'id': 64}})
    assert int(ctl(cdb).forWorkflow({'user_id': 3, 'params': {'id': 64}})['data']['workflow_id']) == 64
    assert ctl(cdb).forWorkflow({'user_id': 4, 'params': {'id': 64}})['status_code'] == 404
    assert ctl(cdb).forWorkflow({'params': {'id': 64}})['status_code'] == 401


@pytest.fixture
def rdb():
    """RobotSchema's wf 75 owned by the robot; user 2 (ops) may use the robot, user 1 may not."""
    from app.services.robot_account import RobotAccount
    from tests.unit import robot_schema
    d, _ = robot_schema.create()
    robot = RobotAccount.ensure(d)
    d.execute(f'UPDATE agent_workflows SET user_id = {robot} WHERE id = 75')
    d.robot = robot
    return d


def rc(db) -> ActiveWorkflowController:
    return ActiveWorkflowController(db, {'edition': 'corporate'})


def test_a_permitted_user_activates_and_unlocks_a_robot_workflow(rdb):
    r = rc(rdb).activate({'user_id': 2, 'params': {'id': 75}})
    assert [r['success'], r['status_code'], int(r['data']['active']['user_id']), int(r['data']['active']['workflow_id'])] == \
        [True, 200, rdb.robot, 75]
    assert rc(rdb).show({'user_id': 2})['data'] is None              # the row is the robot's, not the caller's
    f = rc(rdb).forWorkflow({'user_id': 2, 'params': {'id': 75}})
    assert [f['success'], f['status_code'], int(f['data']['user_id'])] == [True, 200, rdb.robot]
    assert rc(rdb).deactivate({'user_id': 2, 'params': {'id': 75}})['status_code'] == 200
    assert rdb.fetch_one('SELECT COUNT(*) AS n FROM active_workflows')['n'] == 0
    assert rc(rdb).forWorkflow({'user_id': 2, 'params': {'id': 75}})['data'] is None


def test_on_the_old_key_a_second_robot_activation_answers_409(rdb):
    old_primary_key(rdb)
    rdb.execute(f"INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({rdb.robot}, 80, 'schedule', '2026-10-29 09:00:00')")
    r = rc(rdb).activate({'user_id': 2, 'params': {'id': 75}})
    assert [r['success'], r['status_code'], r.get('error_code'), r['error']] == \
        [False, 409, 'robot_busy', 'The robot can run one workflow at a time until the database is updated.']


def test_a_caller_without_access_gets_not_found(rdb):
    r = rc(rdb).activate({'user_id': 1, 'params': {'id': 75}})
    assert [r['success'], r['kind'], r['status_code'], r['error']] == [False, 'not_found', 404, 'Workflow not found']
    ActiveWorkflowService(rdb).activate(rdb.robot, 75)
    for m in ('deactivate', 'forWorkflow'):
        r = getattr(rc(rdb), m)({'user_id': 1, 'params': {'id': 75}})
        assert [r['success'], r['status_code'], r['error']] == [False, 404, 'Workflow not found']
        assert 'data' not in r
    assert rdb.fetch_one('SELECT COUNT(*) AS n FROM active_workflows')['n'] == 1   # still active
