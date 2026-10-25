"""Ports of backend/tests/Unit/ScheduledWorkflowServiceCronTest.php, ScheduledWorkflowServiceEventTest.php and
ScheduledWorkflowServiceStartOptionTest.php (in-memory SQLite, injected clock)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.exceptions.invalid_argument import InvalidArgumentException
from tests.unit.playbook.conftest import SqliteDb

SCHEMA_CRON = ("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,"
               " workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',"
               " repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, last_run TEXT,"
               " next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)")
SCHEMA_EVENT = ("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,"
                " workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',"
                " repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT,"
                " trigger_component_id INTEGER, last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT,"
                " error_message TEXT)")


class Env:
    def __init__(self, clock: str, schema: str):
        self.clock = datetime.fromisoformat(clock)
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        conn.create_function('NOW', 0, lambda: self.clock.strftime('%Y-%m-%d %H:%M:%S'))
        conn.execute(schema)
        conn.execute('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)')
        conn.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)')
        conn.commit()
        self.db = SqliteDb(conn)

    def svc(self) -> ScheduledWorkflowService:
        return ScheduledWorkflowService(self.db, lambda: self.clock)

    def exec(self, sql: str) -> None:
        self.db.execute(sql)


# ---------------------------------------------------------------- cron

@pytest.fixture
def c():
    return Env('2026-10-07 10:42:30', SCHEMA_CRON)


def cron_schedule(e: Env, cron: str = '*/2 * * * *') -> dict:
    return e.svc().create({'user_id': 3, 'workflow_id': 44, 'scheduled_time': '2026-10-07 10:00:00',
                           'repeat_type': 'cron', 'cron': cron})


def due_cron_schedule(e: Env) -> dict:
    """A cron schedule whose next_run has already passed, so claim() may take it."""
    s = cron_schedule(e)
    e.exec(f"UPDATE scheduled_workflows SET next_run = '2026-10-07 10:42:00' WHERE id = {int(s['id'])}")
    return s


def test_create_cron_computes_next_run_from_now(c):
    s = cron_schedule(c)
    assert s['repeat_type'] == 'cron'
    assert s['cron'] == '*/2 * * * *'
    assert s['next_run'] == '2026-10-07 10:44:00'


def test_create_rejects_bad_cron(c):
    with pytest.raises(InvalidArgumentException):
        cron_schedule(c, '61 * * * *')


def test_completed_cron_run_schedules_from_now_not_from_last_next_run(c):
    s = cron_schedule(c)
    c.clock = datetime.fromisoformat('2026-10-07 11:30:10')   # the tick ran late
    c.svc().markCompleted(s['id'])
    row = c.svc().findById(s['id'])
    assert row['next_run'] == '2026-10-07 11:32:00'
    assert row['status'] == 'pending'
    assert row['running_since'] is None


def test_failed_cron_run_stays_recurring(c):
    s = cron_schedule(c)
    c.svc().markFailed(s['id'], 'boom')
    row = c.svc().findById(s['id'])
    assert row['status'] == 'pending'
    assert row['next_run'] == '2026-10-07 10:44:00'


def test_claim_is_exclusive(c):
    s = due_cron_schedule(c)
    assert c.svc().claim(s['id']) is True
    assert c.svc().claim(s['id']) is False, 'a second tick must not claim a running schedule'


def test_stale_running_is_reclaimed(c):
    s = due_cron_schedule(c)
    assert c.svc().claim(s['id'])
    c.clock += timedelta(minutes=61)
    assert [r['id'] for r in c.svc().getDueSchedules()] == [s['id']]
    assert c.svc().claim(s['id'])


def test_touch_running_keeps_a_long_run_from_being_reclaimed(c):
    s = due_cron_schedule(c)
    assert c.svc().claim(s['id'])
    c.clock += timedelta(minutes=50)
    c.svc().touchRunning(s['id'])
    assert c.svc().findById(s['id'])['running_since'] == '2026-10-07 11:32:30'
    c.clock += timedelta(minutes=50)   # 100 minutes after the claim, 50 after the touch
    assert c.svc().getDueSchedules() == []
    assert c.svc().claim(s['id']) is False


def test_touch_running_leaves_a_schedule_that_is_not_running(c):
    s = due_cron_schedule(c)
    c.svc().touchRunning(s['id'])
    row = c.svc().findById(s['id'])
    assert row['status'] == 'pending'
    assert row['running_since'] is None


def test_running_within_window_is_not_due(c):
    s = due_cron_schedule(c)
    assert c.svc().claim(s['id'])
    c.clock += timedelta(minutes=10)
    assert c.svc().getDueSchedules() == []


def test_hourly_schedule_unchanged(c):
    s = c.svc().create({'user_id': 3, 'workflow_id': 44, 'scheduled_time': '2026-10-07 10:00:00',
                        'repeat_type': 'hourly', 'repeat_interval': 2})
    c.svc().markCompleted(s['id'])
    assert c.svc().findById(s['id'])['next_run'] == '2026-10-07 12:00:00'


def test_update_to_cron_recomputes_next_run(c):
    s = c.svc().create({'user_id': 3, 'workflow_id': 44, 'scheduled_time': '2026-10-08 10:00:00'})
    u = c.svc().update(s['id'], 3, {'repeat_type': 'cron', 'cron': '*/15 * * * *', 'scheduled_time': '2026-10-08 10:00:00'})
    assert u['next_run'] == '2026-10-07 10:45:00'


def test_default_clock_reads_db_now(c):
    svc = ScheduledWorkflowService(c.db)   # no injected clock
    s = svc.create({'user_id': 3, 'workflow_id': 44, 'repeat_type': 'cron', 'cron': '*/2 * * * *'})
    assert s['next_run'] == '2026-10-07 10:44:00'


def test_running_with_null_running_since_counts_as_stale(c):
    s = cron_schedule(c)
    c.exec(f"UPDATE scheduled_workflows SET status = 'running', running_since = NULL WHERE id = {s['id']}")
    assert [r['id'] for r in c.svc().getDueSchedules()] == [s['id']]
    assert c.svc().claim(s['id'])


def test_clock_is_read_once_per_method(c):
    reads = {'n': 0}

    def clock():
        reads['n'] += 1
        return c.clock
    svc = ScheduledWorkflowService(c.db, clock)
    s = cron_schedule(c)
    reads['n'] = 0
    svc.getDueSchedules()
    assert reads['n'] == 1, 'getDueSchedules reads the clock once'
    reads['n'] = 0
    svc.claim(s['id'])
    assert reads['n'] == 1, 'claim reads the clock once'


def test_claim_refuses_a_pending_schedule_edited_into_the_future(c):
    s = cron_schedule(c)
    c.exec(f"UPDATE scheduled_workflows SET next_run = '2026-10-07 11:00:00' WHERE id = {s['id']}")
    assert c.svc().claim(s['id']) is False


# ---------------------------------------------------------------- event

TRIGGER = {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'args': {'folder': 'Inbox'}}}


@pytest.fixture
def ev():
    return Env('2026-10-12 10:42:30', SCHEMA_EVENT)


def event_schedule(e: Env, trigger=TRIGGER) -> dict:
    return e.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-12 10:00:00',
                           'repeat_type': 'event', 'event_trigger': trigger})


def test_create_stores_the_trigger_and_no_next_run(ev):
    s = event_schedule(ev)
    assert s['repeat_type'] == 'event'
    assert s['next_run'] is None
    assert s['cron'] is None
    assert s['event_trigger'] == '{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Inbox"}}}'


def test_a_tick_never_claims_an_event_schedule(ev):
    s = event_schedule(ev)
    ev.clock = ev.clock.replace(year=ev.clock.year + 10)
    assert ev.svc().getDueSchedules() == []
    assert ev.svc().claim(s['id']) is False


def test_the_trigger_is_normalised(ev):
    s = event_schedule(ev, '{"server": " Outlook ", "tool": "wait_for_new"}')   # JSON text, no args
    assert s['event_trigger'] == '{"server":"Outlook","tool":"wait_for_new","args":{}}'


@pytest.mark.parametrize('trigger', [
    None, '{oops', {'tool': 'w'}, {'server': 'Outlook'}, {'server': 'Outlook', 'tool': '  '},
    {'server': 'O', 'tool': 'w', 'args': [1, 2]}, {'server': 'O', 'tool': 'w', 'args': 'x'},
], ids=['missing', 'not JSON', 'no server', 'no tool', 'blank tool', 'args a list', 'args a string'])
def test_a_bad_trigger_is_refused(ev, trigger):
    with pytest.raises(InvalidArgumentException):
        event_schedule(ev, trigger)


def test_other_schedules_do_not_touch_the_column(ev):
    # A database the event migration has not reached: cron and timed schedules still work.
    ev.exec('ALTER TABLE scheduled_workflows DROP COLUMN event_trigger')
    s = ev.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-12 11:00:00', 'repeat_type': 'daily'})
    assert s['next_run'] == '2026-10-12 11:00:00'
    s = ev.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-12 11:00:00',
                         'repeat_type': 'cron', 'cron': '*/5 * * * *'})
    assert s['next_run'] == '2026-10-12 10:45:00'
    ev.svc().update(s['id'], 3, {'input_prompt': 'poll'})
    assert ev.svc().findById(s['id'])['input_prompt'] == 'poll'


def test_update_changes_the_trigger(ev):
    s = event_schedule(ev)
    u = ev.svc().update(s['id'], 3, {'repeat_type': 'event',
                                     'event_trigger': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'timeout_s': 60}}})
    assert u['event_trigger'] == '{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}'
    assert u['next_run'] is None
    u = ev.svc().update(s['id'], 3, {'input_prompt': 'go'})   # the trigger is kept
    assert u['event_trigger'] == '{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}'


def test_cron_becomes_event_and_back(ev):
    s = ev.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-12 10:00:00',
                         'repeat_type': 'cron', 'cron': '*/2 * * * *'})
    assert s['next_run'] == '2026-10-12 10:44:00'
    u = ev.svc().update(s['id'], 3, {'repeat_type': 'event', 'event_trigger': TRIGGER, 'cron': None})
    assert u['repeat_type'] == 'event'
    assert u['next_run'] is None
    assert u['cron'] is None
    u = ev.svc().update(s['id'], 3, {'repeat_type': 'cron', 'cron': '*/2 * * * *'})
    assert u['event_trigger'] is None
    assert u['next_run'] == '2026-10-12 10:44:00'
    ev.svc().update(s['id'], 3, {'repeat_type': 'event', 'event_trigger': TRIGGER})
    u = ev.svc().update(s['id'], 3, {'repeat_type': 'daily'})   # timed again: from its time
    assert u['event_trigger'] is None
    assert u['next_run'] == '2026-10-12 10:00:00'


def test_update_to_event_without_a_trigger_is_refused(ev):
    s = ev.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-12 10:00:00', 'repeat_type': 'daily'})
    with pytest.raises(InvalidArgumentException):
        ev.svc().update(s['id'], 3, {'repeat_type': 'event'})


# ---------------------------------------------------------------- start option

WATCH = TRIGGER


@pytest.fixture
def so():
    return Env('2026-10-14 09:00:00', SCHEMA_EVENT)


def test_create_stores_the_component(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 09:00:00',
                         'repeat_type': 'event', 'event_trigger': WATCH, 'trigger_component_id': 7})
    assert int(s['trigger_component_id']) == 7
    assert s['next_run'] is None


def test_create_without_an_option_leaves_it_null(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 09:00:00',
                         'repeat_type': 'event', 'event_trigger': WATCH})
    assert s['trigger_component_id'] is None


def test_update_sets_the_component(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 10:00:00', 'repeat_type': 'none'})
    u = so.svc().update(s['id'], 3, {'repeat_type': 'event', 'event_trigger': WATCH, 'trigger_component_id': 7})
    assert int(u['trigger_component_id']) == 7
    assert u['repeat_type'] == 'event'


def test_leaving_the_event_clears_the_component(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 10:00:00',
                         'repeat_type': 'event', 'event_trigger': WATCH, 'trigger_component_id': 7})
    u = so.svc().update(s['id'], 3, {'repeat_type': 'daily'})
    assert u['trigger_component_id'] is None
    assert u['event_trigger'] is None


def test_a_hand_made_event_save_clears_the_component(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 10:00:00',
                         'repeat_type': 'event', 'event_trigger': WATCH, 'trigger_component_id': 7})
    u = so.svc().update(s['id'], 3, {'repeat_type': 'event',
                                     'event_trigger': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': []}})
    assert u['trigger_component_id'] is None
    assert u['repeat_type'] == 'event'


def test_an_event_save_without_a_trigger_keeps_the_component(so):
    s = so.svc().create({'user_id': 3, 'workflow_id': 64, 'scheduled_time': '2026-10-14 10:00:00',
                         'repeat_type': 'event', 'event_trigger': WATCH, 'trigger_component_id': 7})
    u = so.svc().update(s['id'], 3, {'repeat_type': 'event', 'input_prompt': 'go'})
    assert int(u['trigger_component_id']) == 7
