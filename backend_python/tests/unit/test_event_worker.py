"""Port of backend/tests/Unit/EventWorker/EventWorkerTest.php (spec 2026-10-14 event-worker §3)."""
from __future__ import annotations

import json
import time

import pytest

from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.event_worker import EventWorker
from app.agent_team.services.watch_call import WatchCall
from tests.unit import event_worker_schema as S


class FakeTransport:
    def __init__(self):
        self.open = {}      # key => body
        self.answers = {}   # key => (body, http, err), handed out by done()
        self.started = 0

    def start(self, key, url, headers, body):
        self.open[key] = body
        self.started += 1

    def cancel(self, key):
        self.open.pop(key, None)

    def done(self):
        out = {}
        for k, a in self.answers.items():
            if k in self.open:
                out[k] = a
                del self.open[k]
        self.answers = {}
        return out

    def answer(self, key, payload):
        self.answers[key] = (json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'structuredContent': payload}}), 200, '')


class FakeRuns:
    def __init__(self):
        self.started = []   # [key, scheduleId]
        self.ended = {}     # key => exit code, handed out by done()
        self.ticks = 0

    def start(self, key, scheduleId):
        self.started.append([key, scheduleId])

    def done(self):
        d = self.ended
        self.ended = {}
        return d

    def scheduleTick(self):
        self.ticks += 1


class Env:
    def __init__(self):
        self.t = 1000.0
        self.db = S.create(lambda: time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(int(self.t))))
        S.option(self.db, 1, 3)
        S.workflow(self.db, 64, 3, 1)
        self.row = S.row(self.db, 64, 3, 'event', 1)
        self.db.execute("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (3, 'Outlook', 'http://fake/mcp', '{}')")
        self.tr = FakeTransport()
        self.runs = FakeRuns()
        self.w = self.worker()

    def worker(self, runs=None, serverFor=None, log=None) -> EventWorker:
        return EventWorker(ActiveWorkflowService(self.db),
                           serverFor or (lambda u, n: WatchCall.server(self.db, u, n)),
                           self.tr, runs or self.runs, lambda: self.t, log)

    def active(self, user=3, wf=64):
        ActiveWorkflowService(self.db).activate(user, wf)

    def state(self, user=3) -> list:
        r = self.db.fetch_one(f'SELECT watch_state, watch_message FROM active_workflows WHERE user_id = {user}')
        return [r['watch_state'], r['watch_message']] if r else []

    def step(self, after=0.0):
        self.t += after
        self.w.step()

    def running(self):
        self.active()
        self.step()
        self.tr.answer(3, {'status': 'ready'})
        self.step(1)
        assert self.w.slots()[3]['state'] == 'running'

    def editWatch(self, folder):
        watch = json.loads(json.dumps(S.WATCH))
        watch['args']['args']['folder'] = folder
        self.db.execute('UPDATE scheduled_workflows SET event_trigger = ? WHERE id = ?', [json.dumps(watch), self.row])

    def second_user(self):
        S.option(self.db, 2, 4)
        S.workflow(self.db, 80, 4, 2)
        S.row(self.db, 80, 4, 'event', 2)
        self.db.execute("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (4, 'Outlook', 'http://fake4/mcp', '{}')")


@pytest.fixture
def e():
    return Env()


def test_nothing_active_nothing_open(e):
    e.step()
    assert e.tr.open == {}


def test_an_active_option_workflow_waits_and_runs_on_ready(e):
    e.active()
    e.step()
    assert 3 in e.tr.open
    assert e.state()[0] == 'waiting'
    e.tr.answer(3, {'status': 'ready', 'via': 'event', 'events': 'on'})
    e.step(1)
    assert e.runs.started == [[3, e.row]]
    assert e.state()[0] == 'running'
    assert 3 not in e.tr.open          # no wait during a run
    e.runs.ended[3] = 0
    e.step(1)
    assert 3 in e.tr.open             # waiting again
    assert e.state() == ['waiting', None]


def test_a_timeout_waits_again(e):
    e.active()
    e.step()
    e.tr.answer(3, {'status': 'timeout', 'events': 'off'})
    e.step(1)
    assert e.tr.started == 2
    assert e.state() == ['waiting', 'fallback']   # events off: the 15-min fallback


def test_an_error_backs_off_doubling_to_the_cap(e):
    e.active()
    e.step()
    delays = []
    for _ in range(5):
        e.tr.answer(3, {'error': 'reconnect_needed'})
        e.step(1)
        delays.append(e.w.slots()[3]['backoff'])
        assert e.state() == ['error', 'reconnect_needed']
        e.step(e.w.slots()[3]['until'] - e.t - 0.5)   # not yet
        assert 3 not in e.tr.open
        e.step(1)                                      # due: wait again
        assert 3 in e.tr.open
    assert delays == [30, 60, 120, 240, 300]
    e.tr.answer(3, {'status': 'timeout'})
    e.step(1)
    assert e.w.slots()[3]['backoff'] == 0              # a good answer resets it


def test_a_failed_run_keeps_the_watch_after_a_backoff(e):
    e.active()
    e.step()
    e.tr.answer(3, {'status': 'ready'})
    e.step(1)
    e.runs.ended[3] = 1
    e.step(1)
    assert e.state() == ['error', 'run_failed']
    assert 3 not in e.tr.open                          # no wait at once: no ready -> fail loop
    e.step(EventWorker.BACKOFF_MIN_S)
    assert 3 in e.tr.open
    assert e.state() == ['waiting', 'run_failed']
    e.tr.answer(3, {'status': 'timeout', 'events': 'off'})
    e.step(1)
    assert e.state() == ['waiting', 'run_failed']      # a timeout does not clear it
    assert e.w.slots()[3]['backoff'] == 30


def test_failed_runs_back_off_doubling_and_a_success_resets(e):
    e.active()
    e.step()
    delays = []
    for _ in range(2):
        e.tr.answer(3, {'status': 'ready', 'via': 'event', 'events': 'on'})
        e.step(1)
        assert e.w.slots()[3]['state'] == 'running'
        e.runs.ended[3] = 1
        e.step(1)
        delays.append(e.w.slots()[3]['backoff'])
        assert e.state() == ['error', 'run_failed']
        e.step(e.w.slots()[3]['until'] - e.t - 0.5)
        assert 3 not in e.tr.open
        e.step(1)
        assert 3 in e.tr.open
    assert delays == [30, 60]
    assert len(e.runs.started) == 2
    e.tr.answer(3, {'status': 'ready'})
    e.step(1)
    e.runs.ended[3] = 0
    e.step(1)
    assert e.w.slots()[3]['backoff'] == 0              # a run that succeeds resets it
    assert 3 in e.tr.open
    assert e.state() == ['waiting', None]


def test_a_run_that_cannot_start_backs_off(e):
    class BadRuns:
        def start(self, key, scheduleId):
            raise RuntimeError('proc_open failed')

        def done(self):
            return {}

        def scheduleTick(self):
            pass
    lines = []
    w = e.worker(runs=BadRuns(), log=lines.append)
    e.active()
    w.step()
    e.tr.answer(3, {'status': 'ready'})
    e.t += 1
    w.step()
    assert e.state() == ['error', 'run_failed']
    assert w.slots()[3]['backoff'] == 30
    assert lines == ['event worker: run start (user 3): RuntimeError: proc_open failed']


def test_a_ready_after_deactivation_starts_no_run(e):
    e.active()
    e.step()
    ActiveWorkflowService(e.db).deactivate(3, 64)
    e.tr.answers[3] = (json.dumps({'result': {'structuredContent': {'status': 'ready'}}}), 200, '')
    e.step(EventWorker.RECONCILE_S)
    assert e.runs.started == []
    assert e.tr.open == {}
    assert e.w.slots() == {}


def test_deactivating_during_a_run_opens_no_new_wait(e):
    e.active()
    e.step()
    e.tr.answer(3, {'status': 'ready'})
    e.step(1)
    ActiveWorkflowService(e.db).deactivate(3, 64)
    e.step(EventWorker.RECONCILE_S)
    e.runs.ended[3] = 0
    e.step(1)
    assert e.tr.open == {}
    assert e.w.slots() == {}


def test_no_links_is_idle_and_resumes_when_fixed(e):
    e.active()
    edges = e.db.fetch_all('SELECT * FROM workflow_edges')
    e.db.execute('DELETE FROM workflow_edges')
    e.step()
    assert e.tr.open == {}
    assert e.state() == ['idle', 'no_links']
    x = edges[0]
    e.db.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)',
                 [x['workflow_id'], x['from_node_id'], x['to_node_id']])
    e.step(EventWorker.RECONCILE_S)
    assert 3 in e.tr.open


def test_a_missing_server_is_an_error_with_backoff(e):
    e.db.execute('DELETE FROM mcp_servers')
    e.active()
    e.step()
    assert e.state() == ['error', 'server_missing']
    assert e.w.slots()[3]['backoff'] == 30


def test_schedule_mode_is_scheduled_and_ticks_every_minute(e):
    S.workflow(e.db, 70, 3, None)
    S.row(e.db, 70, 3, 'daily')
    e.active(3, 70)
    e.step()
    assert e.tr.open == {}
    assert e.state() == ['scheduled', '2026-10-15 09:00:00']
    assert e.runs.ticks == 1
    e.step(30)
    assert e.runs.ticks == 1
    e.step(31)
    assert e.runs.ticks == 2


def test_no_schedule_mode_slot_no_tick(e):
    e.active()                                   # option mode only
    e.step()
    e.step(EventWorker.SCHEDULE_TICK_S + 1)
    assert e.runs.ticks == 0


def test_an_idle_schedule_mode_workflow_does_not_tick(e):
    S.workflow(e.db, 70, 3, None)
    S.row(e.db, 70, 3, 'daily')
    e.active(3, 70)
    e.db.execute('UPDATE agent_workflows SET enabled = 0 WHERE id = 70')
    e.step()
    assert e.state() == ['idle', 'disabled']
    e.step(EventWorker.SCHEDULE_TICK_S + 1)
    assert e.runs.ticks == 0
    e.db.execute('UPDATE agent_workflows SET enabled = 1 WHERE id = 70')
    e.step(EventWorker.RECONCILE_S)
    assert e.runs.ticks == 1                     # scheduled again: the tick resumes at once


def test_an_edited_watch_reopens_the_wait(e):
    e.active()
    e.step()
    assert '"Inbox"' in e.tr.open[3]
    e.editWatch('Archive')
    e.step(EventWorker.RECONCILE_S)
    assert e.tr.started == 2
    assert '"Archive"' in e.tr.open[3]
    e.step(EventWorker.RECONCILE_S)
    assert e.tr.started == 2                     # unchanged since: the wait stays


def test_a_watch_edited_during_a_run_is_used_after_it(e):
    e.running()
    e.editWatch('Archive')
    e.step(EventWorker.RECONCILE_S)
    assert e.tr.open == {}
    e.runs.ended[3] = 0
    e.step(1)
    e.step(1)
    assert 3 in e.tr.open
    assert '"Archive"' in e.tr.open[3]
    assert len(e.runs.started) == 1


def test_a_swallowed_error_is_logged_once_a_minute(e):
    lines = []
    w = e.worker(log=lines.append)
    e.active()
    e.db.execute("CREATE TRIGGER no_update BEFORE UPDATE ON active_workflows BEGIN SELECT RAISE(ABORT, 'locked'); END")
    for _ in range(6):                           # 0 .. 50 s: the write fails on every heartbeat
        w.step()
        e.t += 10
    assert len(lines) == 1
    assert 'state write (user 3)' in lines[0]
    assert 'locked' in lines[0]
    e.t += 10                                    # 60 s after the first: logged again
    w.step()
    assert len(lines) == 2


def test_the_heartbeat_refreshes_the_checked_time(e):
    e.active()
    e.step()
    first = e.db.fetch_column('SELECT watch_checked_at FROM active_workflows')[0]
    e.step(EventWorker.HEARTBEAT_S + 1)
    assert e.db.fetch_column('SELECT watch_checked_at FROM active_workflows')[0] != first


def test_two_users_are_independent(e):
    e.second_user()
    e.active()
    e.active(4, 80)
    e.step()
    e.tr.answer(3, {'error': 'reconnect_needed'})
    e.tr.answer(4, {'status': 'ready'})
    e.step(1)
    assert e.state(3)[0] == 'error'
    assert e.state(4)[0] == 'running'
    assert e.w.slots()[3]['backoff'] == 30
    assert e.w.slots()[4]['backoff'] == 0


def test_switching_the_active_workflow_cancels_the_old_wait(e):
    S.workflow(e.db, 66, 3, 1)
    other = S.row(e.db, 66, 3, 'event', 1)
    e.active()
    e.step()
    e.active(3, 66)
    e.step(EventWorker.RECONCILE_S)
    assert e.w.slots()[3]['workflow_id'] == 66
    assert e.w.slots()[3]['schedule_id'] == other
    assert e.tr.started == 2


def test_switching_during_a_run_starts_nothing_until_it_ends(e):
    S.workflow(e.db, 66, 3, 1)
    S.row(e.db, 66, 3, 'event', 1)
    e.running()
    e.active(3, 66)
    e.step(EventWorker.RECONCILE_S)
    assert e.tr.open == {}
    assert e.w.slots()[3]['workflow_id'] == 64
    assert e.w.slots()[3]['state'] == 'running'
    e.runs.ended[3] = 0
    e.step(1)
    assert e.tr.open == {}                       # re-evaluated first
    e.step(1)
    assert 3 in e.tr.open
    assert e.w.slots()[3]['workflow_id'] == 66
    assert e.tr.started == 2
    assert len(e.runs.started) == 1


def test_disabling_during_a_run_idles_after_it(e):
    e.running()
    e.db.execute('UPDATE agent_workflows SET enabled = 0')
    e.step(EventWorker.RECONCILE_S)
    e.runs.ended[3] = 0
    e.step(1)
    e.step(1)
    assert e.tr.open == {}
    assert len(e.runs.started) == 1
    assert e.state() == ['idle', 'disabled']


def test_reenabling_during_a_run_opens_no_wait_until_it_ends(e):
    e.running()
    e.db.execute('UPDATE agent_workflows SET enabled = 0')
    e.step(EventWorker.RECONCILE_S)
    e.db.execute('UPDATE agent_workflows SET enabled = 1')
    e.step(EventWorker.RECONCILE_S)
    assert e.tr.open == {}
    assert e.w.slots()[3]['state'] == 'running'
    e.runs.ended[3] = 0
    e.step(1)
    e.step(1)
    assert 3 in e.tr.open
    assert len(e.runs.started) == 1


def test_a_throwing_server_lookup_backs_off_without_blocking_others(e):
    e.second_user()

    def serverFor(u, n):
        if u == 3:
            raise RuntimeError('db gone')
        return WatchCall.server(e.db, u, n)
    w = e.worker(serverFor=serverFor)
    e.active()
    e.active(4, 80)
    w.step()
    assert e.state(3) == ['error', 'unreachable']
    assert w.slots()[3]['backoff'] == 30
    assert 4 in e.tr.open
    assert 3 not in e.tr.open


def test_a_ready_between_deactivation_and_reconcile_starts_no_run(e):
    e.active()
    e.step()
    ActiveWorkflowService(e.db).deactivate(3, 64)
    e.tr.answer(3, {'status': 'ready'})
    e.step(1)
    assert e.runs.started == []
    assert e.w.slots() == {}


def test_a_failed_state_write_does_not_lose_a_run_end(e):
    e.running()
    e.db.execute('CREATE TABLE flag (v INTEGER)')
    e.db.execute('INSERT INTO flag VALUES (1)')
    e.db.execute("CREATE TRIGGER no_update BEFORE UPDATE ON active_workflows WHEN (SELECT v FROM flag) = 1"
                 " BEGIN SELECT RAISE(ABORT, 'locked'); END")
    e.runs.ended[3] = 0
    e.step(1)
    assert e.w.slots()[3]['state'] == 'waiting'     # the run end was taken
    assert 3 in e.tr.open
    assert e.state()[0] == 'running'                # the write failed
    e.db.execute('UPDATE flag SET v = 0')
    e.step(EventWorker.HEARTBEAT_S + 1)
    assert e.state()[0] == 'waiting'                # the heartbeat caught up


def test_a_long_failed_run_still_records_run_failed(e):
    e.running()
    e.step(EventWorker.RECONCILE_S)
    e.step(EventWorker.RECONCILE_S)
    e.runs.ended[3] = 1
    e.step(1)
    e.step(1)
    assert e.state() == ['error', 'run_failed']
    e.step(EventWorker.BACKOFF_MIN_S)
    assert e.state() == ['waiting', 'run_failed']
    assert 3 in e.tr.open


def test_a_ready_after_a_disable_before_the_next_reconcile_starts_no_run(e):
    e.active()
    e.step()
    e.db.execute('UPDATE agent_workflows SET enabled = 0')
    e.tr.answer(3, {'status': 'ready'})
    e.step(1)
    assert e.runs.started == []
    assert 3 not in e.tr.open


def test_a_row_whose_check_throws_does_not_stop_the_others(e):
    e.second_user()
    e.active()
    e.active(4, 80)
    # startHasLinks() raises for workflow 64's Start node only (PHP: a PDOStatement subclass that throws)
    boomOn = e.db.fetch_column("SELECT id FROM workflow_nodes WHERE workflow_id = 64 AND node_type = 'start'")[0]
    real = e.db.fetch_column

    def fetch_column(sql, params=None):
        if 'FROM workflow_edges' in sql and params == [boomOn]:
            raise RuntimeError('db gone')
        return real(sql, params)
    e.db.fetch_column = fetch_column
    e.step()
    assert 4 in e.tr.open
