"""Unit tests for the scheduler CLI entry points: scheduler/run_scheduled_workflows.py
(backend/scheduler/run-scheduled-workflows.php) and scheduler/run_schedule.py (backend/bin/run-schedule.php).
`boot()` is replaced by a fake: no real DB, no LLM, ever."""
from __future__ import annotations

import json
import sys

sys.path.insert(0, '.')

from scheduler import run_schedule as rs  # noqa: E402
from scheduler import run_scheduled_workflows as rsw  # noqa: E402
import scheduler.bootstrap as boot_mod  # noqa: E402


class FakeSchedules:
    def __init__(self, due=None, rows=None):
        self.due = due or []
        self.rows = rows or {}
        self.calls = []

    def getDueSchedules(self, workflowIds=None):
        self.calls.append(('getDueSchedules', workflowIds))
        return [d for d in self.due if workflowIds is None or d['workflow_id'] in workflowIds]

    def claim(self, id):
        self.calls.append(('claim', id))
        return True

    def touchRunning(self, id):
        self.calls.append(('touchRunning', id))

    def markCompleted(self, id):
        self.calls.append(('markCompleted', id))

    def markFailed(self, id, err):
        self.calls.append(('markFailed', id, err))

    def findById(self, id):
        return self.rows.get(id)


def fake_boot(schedules, runner, closed):
    return lambda: {'config': {}, 'pdo': object(), 'schedules': schedules, 'runSchedule': runner,
                    'close': lambda: closed.append(True)}


def test_tick_runs_only_active_schedule_workflows(monkeypatch, capsys):
    s = FakeSchedules(due=[{'id': 1, 'workflow_id': 10, 'user_id': 3, 'workflow_name': 'A'},
                           {'id': 2, 'workflow_id': 20, 'user_id': 3, 'workflow_name': 'B'}])
    closed = []
    monkeypatch.setattr(rsw, 'boot', fake_boot(s, lambda sch: {'success': True, 'execution_id': 'e'}, closed))
    monkeypatch.setattr(rsw, 'ActiveWorkflowService',
                        lambda db: type('A', (), {'scheduleWorkflowIds': lambda self: [20]})())
    assert rsw.main([]) == 0
    assert s.calls[0] == ('getDueSchedules', [20])
    assert ('markCompleted', 2) in s.calls and ('claim', 1) not in s.calls
    out = capsys.readouterr().out
    assert 'Found 1 due schedule(s)' in out
    assert 'Completed: 1 succeeded, 0 failed' in out
    assert closed == [True]


def test_missing_active_table_runs_nothing(monkeypatch, capsys):
    s = FakeSchedules(due=[{'id': 1, 'workflow_id': 10, 'user_id': 3}])
    monkeypatch.setattr(rsw, 'boot', fake_boot(s, lambda sch: {'success': True}, []))

    def boom(db):
        raise RuntimeError('no such table')
    monkeypatch.setattr(rsw, 'ActiveWorkflowService', boom)
    assert rsw.main([]) == 0
    assert s.calls == [('getDueSchedules', [])]
    assert 'active workflows unavailable, running none: no such table' in capsys.readouterr().err


def test_boot_failure_exits_1(monkeypatch, capsys):
    def bad():
        raise RuntimeError('Database connection failed: nope')
    monkeypatch.setattr(rsw, 'boot', bad)
    assert rsw.main([]) == 1
    assert 'Database connection failed: nope' in capsys.readouterr().err


def test_run_schedule_drains_and_marks_completed(monkeypatch, capsys):
    s = FakeSchedules(rows={7: {'id': 7, 'repeat_type': 'event', 'workflow_id': 64, 'user_id': 3}})
    answers = [{'success': True, 'drain': True, 'execution_id': 'a'}, {'success': True, 'quiet': True}]
    closed = []
    monkeypatch.setattr(boot_mod, 'boot', fake_boot(s, lambda sch: answers.pop(0), closed))
    assert rs.main(['7']) == 0
    assert json.loads(capsys.readouterr().out) == {'ok': True, 'runs': 2, 'quiet_count': 1, 'execution_ids': ['a']}
    assert s.calls == [('markCompleted', 7)]
    assert closed == [True]


def test_run_schedule_refuses_a_non_event_row(monkeypatch, capsys):
    s = FakeSchedules(rows={7: {'id': 7, 'repeat_type': 'daily'}})
    monkeypatch.setattr(boot_mod, 'boot', fake_boot(s, lambda sch: {'success': True}, []))
    assert rs.main(['7']) == 1
    assert json.loads(capsys.readouterr().out) == {'ok': False, 'error': 'schedule #7 is not an event schedule'}


def test_run_schedule_failed_run_exits_1(monkeypatch, capsys):
    s = FakeSchedules(rows={7: {'id': 7, 'repeat_type': 'event'}})
    monkeypatch.setattr(boot_mod, 'boot', fake_boot(s, lambda sch: {'success': False, 'error': 'boom'}, []))
    assert rs.main(['7']) == 1
    assert json.loads(capsys.readouterr().out) == {'ok': False, 'error': 'boom'}
    assert s.calls == []
