"""Unit tests for SchedulerController (Phase 8, Task 2) — port of
backend/src/AgentTeam/Controllers/SchedulerController.php.

`run()`'s token/auth branching and assistant-close cleanup are tested with
`_executeScheduler` faked (assigned directly on the instance, so the
zero-arg call site `self._executeScheduler()` inside `run()` invokes it with
no args — same trick as `c.workflowRunner = fake` in
test_workflow_run_routes.py). `_executeScheduler` itself — the runner
selection, markRunning/markCompleted/markFailed sequencing, and the
AIPortfolioAssistant/AgentRunner/GraphWorkflowRunner/WorkflowRunner
construction — is tested separately with every class it imports patched at
module scope.
"""
import re

from starlette.datastructures import Headers

import app.agent_team.controllers.scheduler_controller as sc_mod
from app.agent_team.controllers.scheduler_controller import SchedulerController
from app.support.http import Ctx
from app.support.phpcompat import php_tz

CONFIG = {'scheduler': {'token': 'secret-token'}}


def ctx(body=None, user_id=3, headers=None):
    return Ctx(method='POST', uri='/', headers=Headers(headers or {}), query={}, body=body or {},
               raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


class FakeDb:
    def fetch_one(self, *a, **k):
        raise AssertionError('unexpected direct DB access')

    def fetch_all(self, *a, **k):
        raise AssertionError('unexpected direct DB access')


class FakeScheduleService:
    def __init__(self):
        self.calls = []
        self.due = []
        self.stats = {'total': 0}

    def getDueSchedules(self):
        self.calls.append(('getDueSchedules',))
        return self.due

    def getStats(self, userId):
        self.calls.append(('getStats', userId))
        return self.stats

    def markRunning(self, id):
        self.calls.append(('markRunning', id))

    def markCompleted(self, id):
        self.calls.append(('markCompleted', id))

    def markFailed(self, id, errorMessage):
        self.calls.append(('markFailed', id, errorMessage))


def controller():
    c = SchedulerController(FakeDb(), CONFIG)
    fake = FakeScheduleService()
    c.scheduleService = fake
    return c, fake


# ---------------------------------------------------------------------------
# run() — auth/token branching (constraints.md: never trigger a real run)
# ---------------------------------------------------------------------------

def test_run_no_user_no_token_401():
    c, _ = controller()
    r = c.run(ctx(user_id=None, body={}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_run_no_user_invalid_token_401():
    c, _ = controller()
    r = c.run(ctx(user_id=None, body={'token': 'wrong'}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_run_no_user_valid_token_in_body_succeeds():
    c, _ = controller()
    c._executeScheduler = lambda: {'due_count': 0, 'executed': [], 'failed': []}
    r = c.run(ctx(user_id=None, body={'token': 'secret-token'}))
    assert r == {'success': True, 'data': {'due_count': 0, 'executed': [], 'failed': []}, 'status_code': 200}


def test_run_no_user_valid_token_in_header_succeeds():
    c, _ = controller()
    c._executeScheduler = lambda: {'ok': True}
    r = c.run(ctx(user_id=None, body={}, headers={'X-Scheduler-Token': 'secret-token'}))
    assert r == {'success': True, 'data': {'ok': True}, 'status_code': 200}


def test_run_authenticated_user_bypasses_token_check():
    c, _ = controller()
    c._executeScheduler = lambda: {'ok': True}
    r = c.run(ctx(user_id=3, body={}))  # no token at all
    assert r == {'success': True, 'data': {'ok': True}, 'status_code': 200}


def test_run_authenticated_user_with_wrong_token_still_succeeds():
    """PHP: `!$userId && $schedulerToken !== $expectedToken` — a present
    userId short-circuits the token check entirely."""
    c, _ = controller()
    c._executeScheduler = lambda: {'ok': True}
    r = c.run(ctx(user_id=3, body={'token': 'wrong'}))
    assert r == {'success': True, 'data': {'ok': True}, 'status_code': 200}


def test_run_unconfigured_token_rejects_empty_string_match():
    """Default (unconfigured) token is '' — an absent token must still 401,
    not accidentally match ''."""
    c = SchedulerController(FakeDb(), {'scheduler': {'token': ''}})
    r = c.run(ctx(user_id=None, body={}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_run_exception_500():
    c, _ = controller()

    def boom():
        raise Exception('scheduler blew up')
    c._executeScheduler = boom
    r = c.run(ctx(user_id=3, body={}))
    assert r == {'success': False, 'error': 'scheduler blew up', 'status_code': 500}


# ---------------------------------------------------------------------------
# run() — assistant.close() cleanup (Python-only, Phase 5 rule)
# ---------------------------------------------------------------------------

class FakeAssistant:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_run_closes_assistant_on_success():
    c, _ = controller()
    fake_assistant = FakeAssistant()

    def fake_exec():
        c.assistant = fake_assistant
        return {'ok': True}
    c._executeScheduler = fake_exec
    c.run(ctx(user_id=3, body={}))
    assert fake_assistant.closed is True


def test_run_closes_assistant_on_exception():
    c, _ = controller()
    fake_assistant = FakeAssistant()

    def fake_exec():
        c.assistant = fake_assistant
        raise Exception('boom')
    c._executeScheduler = fake_exec
    r = c.run(ctx(user_id=3, body={}))
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}
    assert fake_assistant.closed is True


def test_run_no_assistant_never_set_does_not_crash():
    c, _ = controller()
    c._executeScheduler = lambda: {'ok': True}
    r = c.run(ctx(user_id=3, body={}))
    assert r == {'success': True, 'data': {'ok': True}, 'status_code': 200}
    assert c.assistant is None


# ---------------------------------------------------------------------------
# status()
# ---------------------------------------------------------------------------

_TS_RE = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')


def test_status_unauthenticated():
    c, _ = controller()
    r = c.status(ctx(user_id=None))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_status_success_shape():
    c, fake = controller()
    fake.due = [{'id': 1}, {'id': 2}]
    fake.stats = {'total': 5, 'pending': 3}
    r = c.status(ctx(user_id=3))
    assert r['success'] is True
    assert r['status_code'] == 200
    data = r['data']
    assert data['due_count'] == 2
    assert data['user_stats'] == {'total': 5, 'pending': 3}
    assert _TS_RE.match(data['server_time'])
    assert data['timezone'] == php_tz().key
    assert fake.calls == [('getDueSchedules',), ('getStats', 3)]


def test_status_exception():
    c, fake = controller()

    def boom():
        raise Exception('boom')
    fake.getDueSchedules = boom
    r = c.status(ctx(user_id=3))
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# _executeScheduler() — runner selection + mark* sequencing (PHP 120-237)
# ---------------------------------------------------------------------------

class FakeGraphRepo:
    def __init__(self, nodes_by_wf=None):
        self.nodes_by_wf = nodes_by_wf or {}

    def getNodes(self, workflow_id):
        return self.nodes_by_wf.get(workflow_id, [])


class FakeWorkflowRepo:
    def __init__(self, workflows=None, graph_repo=None):
        self.workflows = workflows or {}
        self._graph_repo = graph_repo or FakeGraphRepo()

    def getGraphRepository(self):
        return self._graph_repo

    def findById(self, id):
        return self.workflows.get(id)


class FakeWorkflow:
    def __init__(self, enabled=True):
        self._enabled = enabled

    def isEnabled(self):
        return self._enabled


class FakeRunner:
    """Stands in for both GraphWorkflowRunner and WorkflowRunner."""
    def __init__(self, *_a, **_k):
        self.calls = []

    def run(self, workflow, userId, inputVariables):
        self.calls.append((workflow, userId, dict(inputVariables)))
        outcome = FakeRunner.NEXT.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    NEXT = []  # class-level queue the test fills before each _executeScheduler() call


class FakeAssistant2:
    def __init__(self, *_a, **_k):
        self.closed = False

    def setDatabase(self, db):
        pass

    def getLLMManager(self):
        return None

    def getToolsManager(self):
        return None

    def close(self):
        self.closed = True


def _patch_stack(monkeypatch, workflow_repo, graph_runner_cls=None, workflow_runner_cls=None):
    monkeypatch.setattr(sc_mod, 'WorkflowRepository', lambda db: workflow_repo)
    monkeypatch.setattr(sc_mod, 'AgentRepository', lambda db: object())
    monkeypatch.setattr(
        sc_mod, 'LLMProviderResolver',
        type('R', (), {'applyDbSettings': staticmethod(lambda db, config: config)}),
    )
    monkeypatch.setattr(sc_mod, 'AIPortfolioAssistant', FakeAssistant2)
    monkeypatch.setattr(sc_mod, 'MCPToolsLoader', lambda db: object())
    monkeypatch.setattr(sc_mod, 'AgentRunner', lambda *a, **k: object())
    monkeypatch.setattr(sc_mod, 'GraphWorkflowRunner', graph_runner_cls or FakeRunner)
    monkeypatch.setattr(sc_mod, 'WorkflowRunner', workflow_runner_cls or FakeRunner)


def test_execute_scheduler_graph_success_and_step_failure_sequencing(monkeypatch):
    graph_runner = FakeRunner()
    step_runner = FakeRunner()
    FakeRunner.NEXT = [
        {'success': True, 'execution_id': 'exec-1'},   # schedule 1 (graph)
        {'success': False, 'error': 'nope'},            # schedule 2 (step)
    ]
    wf_repo = FakeWorkflowRepo(
        workflows={10: FakeWorkflow(enabled=True), 20: FakeWorkflow(enabled=True)},
        graph_repo=FakeGraphRepo({10: [{'id': 'n1'}]}),  # 20 has no nodes -> step workflow
    )
    _patch_stack(monkeypatch, wf_repo, graph_runner_cls=lambda *a, **k: graph_runner,
                 workflow_runner_cls=lambda *a, **k: step_runner)

    c, fake = controller()
    fake.due = [
        {'id': 1, 'workflow_id': 10, 'user_id': 3, 'input_prompt': 'go', 'workflow_name': 'WF Graph'},
        {'id': 2, 'workflow_id': 20, 'user_id': 3, 'input_prompt': None, 'workflow_name': 'WF Step'},
    ]

    results = c._executeScheduler()

    assert len(graph_runner.calls) == 1
    assert graph_runner.calls[0][1] == 3
    assert graph_runner.calls[0][2] == {'user_prompt': 'go', 'prompt': 'go'}

    assert len(step_runner.calls) == 1
    assert step_runner.calls[0][2] == {}  # falsy input_prompt -> no vars set

    assert fake.calls == [
        ('getDueSchedules',),
        ('markRunning', 1),
        ('markCompleted', 1),
        ('markRunning', 2),
        ('markFailed', 2, 'nope'),
    ]

    assert results['due_count'] == 2
    assert results['executed'] == [
        {'schedule_id': 1, 'workflow_id': 10, 'workflow_name': 'WF Graph', 'execution_id': 'exec-1'},
    ]
    assert results['failed'] == [
        {'schedule_id': 2, 'workflow_id': 20, 'workflow_name': 'WF Step', 'error': 'nope'},
    ]
    assert results['executed_count'] == 1
    assert results['failed_count'] == 1
    assert _TS_RE.match(results['timestamp'])


def test_execute_scheduler_workflow_not_found(monkeypatch):
    wf_repo = FakeWorkflowRepo(workflows={})
    _patch_stack(monkeypatch, wf_repo)
    FakeRunner.NEXT = []

    c, fake = controller()
    fake.due = [{'id': 1, 'workflow_id': 99, 'user_id': 3, 'input_prompt': None, 'workflow_name': None}]

    results = c._executeScheduler()

    assert fake.calls == [('getDueSchedules',), ('markRunning', 1), ('markFailed', 1, 'Workflow #99 not found')]
    assert results['failed'] == [
        {'schedule_id': 1, 'workflow_id': 99, 'workflow_name': 'Unknown', 'error': 'Workflow #99 not found'},
    ]


def test_execute_scheduler_workflow_disabled(monkeypatch):
    wf_repo = FakeWorkflowRepo(workflows={5: FakeWorkflow(enabled=False)})
    _patch_stack(monkeypatch, wf_repo)
    FakeRunner.NEXT = []

    c, fake = controller()
    fake.due = [{'id': 1, 'workflow_id': 5, 'user_id': 3, 'input_prompt': None, 'workflow_name': 'X'}]

    results = c._executeScheduler()

    assert fake.calls == [('getDueSchedules',), ('markRunning', 1), ('markFailed', 1, 'Workflow #5 is disabled')]
    assert results['failed'][0]['error'] == 'Workflow #5 is disabled'


def test_execute_scheduler_runner_raises(monkeypatch):
    runner = FakeRunner()
    FakeRunner.NEXT = [RuntimeError('runner exploded')]
    wf_repo = FakeWorkflowRepo(workflows={5: FakeWorkflow(enabled=True)},
                                graph_repo=FakeGraphRepo({}))
    _patch_stack(monkeypatch, wf_repo, workflow_runner_cls=lambda *a, **k: runner)

    c, fake = controller()
    fake.due = [{'id': 1, 'workflow_id': 5, 'user_id': 3, 'input_prompt': None, 'workflow_name': 'X'}]

    results = c._executeScheduler()

    assert fake.calls == [('getDueSchedules',), ('markRunning', 1), ('markFailed', 1, 'runner exploded')]
    assert results['failed'][0]['error'] == 'runner exploded'


def test_execute_scheduler_sets_assistant_for_cleanup(monkeypatch):
    wf_repo = FakeWorkflowRepo(workflows={})
    _patch_stack(monkeypatch, wf_repo)
    FakeRunner.NEXT = []

    c, fake = controller()
    fake.due = []

    c._executeScheduler()
    assert isinstance(c.assistant, FakeAssistant2)
