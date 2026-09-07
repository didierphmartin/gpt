"""Unit tests for scheduler/run_scheduled_workflows.py (Phase 8, Task 3).

Port of backend/scheduler/run-scheduled-workflows.php (CLI branch only —
see module docstring for the PHP HTTP branch's disposition). Every
dependency the module constructs inside `_run()` (ScheduledWorkflowService,
WorkflowRepository, AgentRepository, AIPortfolioAssistant, MCPToolsLoader,
AgentRunner, GraphWorkflowRunner, WorkflowRunner) is monkeypatched to a
fake at the module's own attribute (they're all `from ... import X`
bindings in `scheduler.run_scheduled_workflows`, so patching the module
attribute is what `_run()` actually calls) — no real DB, no real LLM/HTTP
calls, ever.
"""
from __future__ import annotations

import sys

import pytest

sys.path.insert(0, '.')

from scheduler import run_scheduled_workflows as rsw  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeWorkflow:
    def __init__(self, enabled=True):
        self._enabled = enabled

    def isEnabled(self):
        return self._enabled


class FakeScheduledWorkflowService:
    due: list = []
    calls: list = []   # class-level: one _run() call creates exactly one instance

    def __init__(self, db):
        self.db = db

    def getDueSchedules(self):
        return FakeScheduledWorkflowService.due

    def markRunning(self, schedule_id):
        FakeScheduledWorkflowService.calls.append(('markRunning', schedule_id))

    def markCompleted(self, schedule_id):
        FakeScheduledWorkflowService.calls.append(('markCompleted', schedule_id))

    def markFailed(self, schedule_id, error_message):
        FakeScheduledWorkflowService.calls.append(('markFailed', schedule_id, error_message))


class FakeGraphRepository:
    nodes_by_workflow: dict = {}

    def getNodes(self, workflow_id):
        return FakeGraphRepository.nodes_by_workflow.get(workflow_id, [])


class FakeWorkflowRepository:
    workflows: dict = {}

    def __init__(self, db):
        self.db = db

    def getGraphRepository(self):
        return FakeGraphRepository()

    def findById(self, workflow_id):
        return FakeWorkflowRepository.workflows.get(workflow_id)


class FakeAgentRepository:
    def __init__(self, db):
        pass


class FakeAssistant:
    def __init__(self, config):
        pass

    def setDatabase(self, db):
        pass

    def getLLMManager(self):
        return object()

    def getToolsManager(self):
        return object()


class FakeMCPToolsLoader:
    def __init__(self, db):
        pass


class FakeAgentRunner:
    def __init__(self, *a, **kw):
        pass


class FakeGraphWorkflowRunner:
    results: dict = {}
    calls: list = []

    def __init__(self, *a, **kw):
        pass

    def run(self, workflow, user_id, input_variables):
        FakeGraphWorkflowRunner.calls.append((workflow, user_id, dict(input_variables)))
        return FakeGraphWorkflowRunner.results.pop(0)


class FakeWorkflowRunner:
    results: dict = {}
    calls: list = []

    def __init__(self, *a, **kw):
        pass

    def run(self, workflow, user_id, input_variables):
        FakeWorkflowRunner.calls.append((workflow, user_id, dict(input_variables)))
        return FakeWorkflowRunner.results.pop(0)


class FakeDb:
    def close(self):
        pass


@pytest.fixture(autouse=True)
def _patch_dependencies(monkeypatch):
    monkeypatch.setattr(rsw, 'ScheduledWorkflowService', FakeScheduledWorkflowService)
    monkeypatch.setattr(rsw, 'WorkflowRepository', FakeWorkflowRepository)
    monkeypatch.setattr(rsw, 'AgentRepository', FakeAgentRepository)
    monkeypatch.setattr(rsw, 'AIPortfolioAssistant', FakeAssistant)
    monkeypatch.setattr(rsw, 'MCPToolsLoader', FakeMCPToolsLoader)
    monkeypatch.setattr(rsw, 'AgentRunner', FakeAgentRunner)
    monkeypatch.setattr(rsw, 'GraphWorkflowRunner', FakeGraphWorkflowRunner)
    monkeypatch.setattr(rsw, 'WorkflowRunner', FakeWorkflowRunner)
    # Freeze php_now() output so stdout lines are asserted without racing the
    # real clock.
    monkeypatch.setattr(rsw, 'php_now', lambda: '2026-09-07 12:00:00')

    FakeScheduledWorkflowService.due = []
    FakeScheduledWorkflowService.calls = []
    FakeGraphRepository.nodes_by_workflow = {}
    FakeWorkflowRepository.workflows = {}
    FakeGraphWorkflowRunner.results = []
    FakeGraphWorkflowRunner.calls = []
    FakeWorkflowRunner.results = []
    FakeWorkflowRunner.calls = []
    yield


def _schedule(id=1, workflow_id=10, user_id=5, input_prompt=None, workflow_name='WF'):
    return {
        'id': id, 'workflow_id': workflow_id, 'user_id': user_id,
        'input_prompt': input_prompt, 'workflow_name': workflow_name,
    }


# ---------------------------------------------------------------------------
# No due schedules
# ---------------------------------------------------------------------------

def test_no_due_schedules_prints_zero_and_returns_0(capsys):
    FakeScheduledWorkflowService.due = []
    code = rsw._run(FakeDb(), {})
    assert code == 0
    out = capsys.readouterr().out
    assert out == (
        "[2026-09-07 12:00:00] Found 0 due schedule(s)\n"
        "[2026-09-07 12:00:00] Completed: 0 succeeded, 0 failed\n"
    )


# ---------------------------------------------------------------------------
# Graph workflow success path
# ---------------------------------------------------------------------------

def test_graph_workflow_success(capsys):
    FakeScheduledWorkflowService.due = [_schedule(id=1, workflow_id=10)]
    FakeWorkflowRepository.workflows = {10: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {10: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': True, 'execution_id': 'exec-1'}]

    code = rsw._run(FakeDb(), {})
    assert code == 0
    assert FakeWorkflowRunner.calls == []
    assert len(FakeGraphWorkflowRunner.calls) == 1
    workflow, user_id, input_vars = FakeGraphWorkflowRunner.calls[0]
    assert user_id == 5
    assert input_vars == {}

    out = capsys.readouterr().out
    assert out == (
        "[2026-09-07 12:00:00] Found 1 due schedule(s)\n"
        "[2026-09-07 12:00:00] Executing schedule #1 (workflow #10)\n"
        "[2026-09-07 12:00:00] ✓ Schedule #1 completed successfully\n"
        "[2026-09-07 12:00:00] Completed: 1 succeeded, 0 failed\n"
    )


def test_input_prompt_populates_user_prompt_and_prompt_vars():
    FakeScheduledWorkflowService.due = [_schedule(id=1, workflow_id=10, input_prompt='hi there')]
    FakeWorkflowRepository.workflows = {10: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {10: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': True}]

    rsw._run(FakeDb(), {})

    _workflow, _user_id, input_vars = FakeGraphWorkflowRunner.calls[0]
    assert input_vars == {'user_prompt': 'hi there', 'prompt': 'hi there'}


# ---------------------------------------------------------------------------
# Linear (non-graph) workflow success path
# ---------------------------------------------------------------------------

def test_linear_workflow_uses_workflow_runner_when_no_graph_nodes():
    FakeScheduledWorkflowService.due = [_schedule(id=2, workflow_id=20)]
    FakeWorkflowRepository.workflows = {20: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {20: []}   # !empty() is False -> linear runner
    FakeWorkflowRunner.results = [{'success': True}]

    code = rsw._run(FakeDb(), {})
    assert code == 0
    assert len(FakeWorkflowRunner.calls) == 1
    assert FakeGraphWorkflowRunner.calls == []


# ---------------------------------------------------------------------------
# Failure paths -> markFailed with the PHP-identical error message
# ---------------------------------------------------------------------------

def test_workflow_not_found_marks_failed(capsys):
    FakeScheduledWorkflowService.due = [_schedule(id=3, workflow_id=99)]
    FakeWorkflowRepository.workflows = {}   # findById -> None

    code = rsw._run(FakeDb(), {})

    assert code == 0
    assert ('markFailed', 3, 'Workflow #99 not found') in FakeScheduledWorkflowService.calls
    out = capsys.readouterr().out
    assert "[2026-09-07 12:00:00] ✗ Schedule #3 failed: Workflow #99 not found\n" in out


def test_workflow_disabled_marks_failed():
    FakeScheduledWorkflowService.due = [_schedule(id=4, workflow_id=40)]
    FakeWorkflowRepository.workflows = {40: FakeWorkflow(enabled=False)}

    rsw._run(FakeDb(), {})

    assert ('markFailed', 4, 'Workflow #40 is disabled') in FakeScheduledWorkflowService.calls


def test_runner_failure_result_uses_error_message():
    FakeScheduledWorkflowService.due = [_schedule(id=5, workflow_id=50)]
    FakeWorkflowRepository.workflows = {50: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {50: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': False, 'error': 'boom'}]

    rsw._run(FakeDb(), {})

    assert ('markFailed', 5, 'boom') in FakeScheduledWorkflowService.calls


def test_runner_failure_without_error_key_uses_default_message():
    """PHP: `$result['error'] ?? 'Workflow execution failed'`."""
    FakeScheduledWorkflowService.due = [_schedule(id=6, workflow_id=60)]
    FakeWorkflowRepository.workflows = {60: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {60: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': False}]

    rsw._run(FakeDb(), {})

    assert ('markFailed', 6, 'Workflow execution failed') in FakeScheduledWorkflowService.calls


def test_markrunning_called_before_execution():
    FakeScheduledWorkflowService.due = [_schedule(id=7, workflow_id=70)]
    FakeWorkflowRepository.workflows = {70: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {70: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': True}]

    rsw._run(FakeDb(), {})

    kinds = [c[0] for c in FakeScheduledWorkflowService.calls]
    assert kinds == ['markRunning', 'markCompleted']


def test_multiple_schedules_mixed_outcomes():
    FakeScheduledWorkflowService.due = [
        _schedule(id=1, workflow_id=10),
        _schedule(id=2, workflow_id=99),   # not found -> failed
    ]
    FakeWorkflowRepository.workflows = {10: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {10: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': True}]

    code = rsw._run(FakeDb(), {})
    assert code == 0


# ---------------------------------------------------------------------------
# main(): argv is ignored entirely (PHP has no getopt()/$argv parsing)
# ---------------------------------------------------------------------------

def test_main_ignores_any_argv(monkeypatch, capsys):
    monkeypatch.setattr(rsw, 'load_config', lambda: {})
    monkeypatch.setattr(rsw, 'open_primary', lambda config: FakeDb())
    FakeScheduledWorkflowService.due = []

    code = rsw.main(['--help', '-h', '--bogus', 'positional'])
    assert code == 0
    out = capsys.readouterr().out
    assert "Found 0 due schedule(s)" in out


# ---------------------------------------------------------------------------
# main(): config / DB bootstrap failures
# ---------------------------------------------------------------------------

def test_main_config_error_exits_1_no_db_opened(monkeypatch, capsys):
    def _raise():
        raise rsw.ConfigError('Missing required env vars: DB_HOST.')

    monkeypatch.setattr(rsw, 'load_config', _raise)
    opened = []
    monkeypatch.setattr(rsw, 'open_primary', lambda config: opened.append(1))

    code = rsw.main([])
    assert code == 1
    assert opened == []
    err = capsys.readouterr().err
    assert err == 'Missing required env vars: DB_HOST.\n'


def test_main_db_connect_failure_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(rsw, 'load_config', lambda: {})

    def _raise(config):
        raise RuntimeError('connection refused')

    monkeypatch.setattr(rsw, 'open_primary', _raise)

    code = rsw.main([])
    assert code == 1
    err = capsys.readouterr().err
    assert err == 'Database connection failed: connection refused\n'


def test_main_closes_db_after_run(monkeypatch):
    monkeypatch.setattr(rsw, 'load_config', lambda: {})
    closed = []

    class ClosingDb(FakeDb):
        def close(self):
            closed.append(True)

    monkeypatch.setattr(rsw, 'open_primary', lambda config: ClosingDb())
    FakeScheduledWorkflowService.due = []

    rsw.main([])
    assert closed == [True]


# ---------------------------------------------------------------------------
# Lock / overlap protection: PHP has NONE — verify this module doesn't
# invent one (two "instances" run back-to-back with no cross-run state).
# ---------------------------------------------------------------------------

def test_no_overlap_protection_two_runs_both_execute(monkeypatch):
    """PHP's cron script has no flock()/lock file anywhere (grepped the
    whole backend/scheduler/ tree and the file's one-commit git history —
    confirmed absent). Two invocations back-to-back must both run to
    completion with no shared lock state between them, matching PHP."""
    monkeypatch.setattr(rsw, 'load_config', lambda: {})
    monkeypatch.setattr(rsw, 'open_primary', lambda config: FakeDb())

    FakeScheduledWorkflowService.due = [_schedule(id=1, workflow_id=10)]
    FakeWorkflowRepository.workflows = {10: FakeWorkflow(enabled=True)}
    FakeGraphRepository.nodes_by_workflow = {10: [{'id': 'start'}]}
    FakeGraphWorkflowRunner.results = [{'success': True}]
    code1 = rsw.main([])

    FakeScheduledWorkflowService.due = [_schedule(id=1, workflow_id=10)]
    FakeGraphWorkflowRunner.results = [{'success': True}]
    code2 = rsw.main([])

    assert code1 == 0
    assert code2 == 0
    import os
    assert not any('run_scheduled_workflows' in f and f.endswith('.lock') for f in os.listdir('.'))
