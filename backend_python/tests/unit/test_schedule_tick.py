"""Ports of backend/tests/Unit/ScheduleTickTest.php and EventWorker/ScheduleTickDrainTest.php."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from app.agent_team.services.schedule_tick import ScheduleTick
from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from tests.unit import event_worker_schema as S
from tests.unit.playbook.conftest import SqliteDb

CLOCK = datetime.fromisoformat('2026-10-07 10:42:30')


@pytest.fixture
def env():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, lambda: CLOCK.strftime('%Y-%m-%d %H:%M:%S'))
    conn.execute("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,"
                 " workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',"
                 " repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, last_run TEXT,"
                 " next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)")
    conn.execute('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)')
    conn.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)')
    # A due cron schedule (next_run in the past).
    conn.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)"
                 " VALUES (3, 44, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')")
    conn.commit()
    db = SqliteDb(conn)
    return db, ScheduledWorkflowService(db, lambda: CLOCK)


def tick(svc, results: list) -> tuple[dict, int]:
    """results are returned in order, the last one repeated."""
    calls = {'n': 0}

    def runner(s):
        r = results[min(calls['n'], len(results) - 1)]
        calls['n'] += 1
        return r
    r = ScheduleTick(svc, runner).run()
    return r, calls['n']


def test_quiet_run_is_not_listed_and_does_not_drain(env):
    db, svc = env
    r, calls = tick(svc, [{'success': True, 'quiet': True, 'drain': False}])
    assert calls == 1
    assert r['executed'] == []
    assert r['quiet_count'] == 1
    assert svc.findById(1)['status'] == 'pending'


def test_work_run_drains_until_quiet(env):
    db, svc = env
    work = {'success': True, 'quiet': False, 'drain': True, 'execution_id': 9}
    quiet = {'success': True, 'quiet': True, 'drain': False}
    r, calls = tick(svc, [work, work, work, quiet])
    assert calls == 4
    assert len(r['executed']) == 3


def test_drain_is_capped_at_twenty(env):
    db, svc = env
    _, calls = tick(svc, [{'success': True, 'quiet': False, 'drain': True}])
    assert calls == ScheduleTick.MAX_RUNS_PER_TICK


def test_each_drain_run_refreshes_running_since(env):
    # A drain longer than the stale window must not be reclaimed by another tick mid-way.
    db, _ = env
    clock = {'t': CLOCK}
    svc = ScheduledWorkflowService(db, lambda: clock['t'])
    seen = []
    calls = {'n': 0}

    def runner(s):
        seen.append(svc.findById(1)['running_since'])
        clock['t'] += timedelta(minutes=40)
        calls['n'] += 1
        return {'success': True, 'quiet': False, 'drain': True} if calls['n'] < 3 else {'success': True, 'quiet': True}
    ScheduleTick(svc, runner).run()
    assert seen == ['2026-10-07 10:42:30', '2026-10-07 11:22:30', '2026-10-07 12:02:30']


def test_plain_cron_workflow_does_not_drain(env):
    # No code node ran: the runner reports drain=false although the run did work.
    db, svc = env
    _, calls = tick(svc, [{'success': True, 'quiet': False, 'drain': False}])
    assert calls == 1


def test_quiet_run_never_drains_even_if_runner_says_drain(env):
    db, svc = env
    _, calls = tick(svc, [{'success': True, 'quiet': True, 'drain': True}])
    assert calls == 1


def test_failure_stops_drain_and_is_recorded(env):
    db, svc = env
    r, calls = tick(svc, [{'success': True, 'drain': True}, {'success': False, 'error': 'reconnect_needed'}])
    assert calls == 2
    assert r['failed'][0]['error'] == 'reconnect_needed'
    row = svc.findById(1)
    assert row['status'] == 'pending'
    assert row['error_message'] == 'reconnect_needed'


def test_a_schedule_claimed_by_an_overlapping_tick_is_skipped(env):
    db, svc = env
    db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)"
               " VALUES (3, 45, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')")
    calls = {'n': 0}

    def runner(s):
        calls['n'] += 1
        svc.claim(2)   # an overlapping tick takes row 2 while we run row 1
        return {'success': True, 'quiet': True}
    ScheduleTick(svc, runner).run()
    assert calls['n'] == 1
    assert svc.findById(2)['status'] == 'running'


# ---------------------------------------------------------------- ScheduleTickDrainTest

@pytest.fixture
def ew():
    db = S.create(lambda: '2026-10-15 10:00:00')
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)')
    return db


def drain_svc(db):
    return ScheduledWorkflowService(db, lambda: datetime.fromisoformat('2026-10-15 10:00:00'))


def test_drain_stops_on_a_quiet_run():
    answers = [{'success': True, 'drain': True, 'execution_id': 'a'}, {'success': True, 'quiet': True}]
    r = ScheduleTick.drain(lambda: answers.pop(0))
    assert r == {'runs': 2, 'quiet_count': 1, 'execution_ids': ['a']}


def test_drain_stops_at_twenty():
    r = ScheduleTick.drain(lambda: {'success': True, 'drain': True})
    assert r['runs'] == 20


def test_drain_raises_on_a_failed_run():
    with pytest.raises(RuntimeError):
        ScheduleTick.drain(lambda: {'success': False, 'error': 'boom'})


def test_due_schedules_can_be_restricted_to_workflows(ew):
    S.workflow(ew, 70, 3, None)
    S.workflow(ew, 71, 3, None)
    S.row(ew, 70, 3, 'daily')
    S.row(ew, 71, 3, 'daily')

    def ids(only):
        return [int(r['workflow_id']) for r in drain_svc(ew).getDueSchedules(only)]
    assert ids(None) == [70, 71]
    assert ids([71]) == [71]
    assert ids([]) == []


def test_mark_completed_leaves_an_event_row_without_a_next_run(ew):
    S.workflow(ew, 64, 3, 1)
    id = S.row(ew, 64, 3, 'event', 1)
    drain_svc(ew).markCompleted(id)
    row = ew.fetch_one(f'SELECT status, next_run, last_run FROM scheduled_workflows WHERE id = {id}')
    assert [row['status'], row['next_run'], row['last_run']] == ['pending', None, '2026-10-15 10:00:00']
