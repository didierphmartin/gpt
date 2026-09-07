"""Unit tests for ScheduledWorkflowController (Phase 8, Task 2) — port of
backend/src/AgentTeam/Controllers/ScheduledWorkflowController.php.

Every method delegates entirely to ScheduledWorkflowService, so these tests
replace `controller.scheduleService` with a fake that records calls and
returns canned data — same pattern as test_workflow_run_routes.py's
`c.workflowRunner = fake` overrides. `create()` additionally consults
`workflowRepository.findById(...).getUserId()` for ownership, faked the
same way.
"""
from starlette.datastructures import Headers

from app.agent_team.controllers.scheduled_workflow_controller import ScheduledWorkflowController
from app.support.http import Ctx


def ctx(body=None, user_id=3, params=None):
    return Ctx(method='GET', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='',
               params=params or {}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


class FakeDb:
    def fetch_one(self, *a, **k):
        raise AssertionError('FakeDb should not be hit directly — scheduleService is faked')

    def fetch_all(self, *a, **k):
        raise AssertionError('FakeDb should not be hit directly — scheduleService is faked')

    def execute(self, *a, **k):
        raise AssertionError('FakeDb should not be hit directly — scheduleService is faked')

    def insert(self, *a, **k):
        raise AssertionError('FakeDb should not be hit directly — scheduleService is faked')


class FakeScheduleService:
    def __init__(self):
        self.calls = []
        self.find_by_user = []
        self.created = None
        self.found_by_id = None
        self.updated = None
        self.deleted = True
        self.paused = True
        self.resumed = True
        self.stats = {'total': 0}
        self.by_workflow = []

    def findByUser(self, userId):
        self.calls.append(('findByUser', userId))
        return self.find_by_user

    def create(self, data):
        self.calls.append(('create', data))
        return self.created

    def findById(self, id):
        self.calls.append(('findById', id))
        return self.found_by_id

    def update(self, id, userId, data):
        self.calls.append(('update', id, userId, data))
        return self.updated

    def delete(self, id, userId):
        self.calls.append(('delete', id, userId))
        return self.deleted

    def pause(self, id, userId):
        self.calls.append(('pause', id, userId))
        return self.paused

    def resume(self, id, userId):
        self.calls.append(('resume', id, userId))
        return self.resumed

    def getStats(self, userId):
        self.calls.append(('getStats', userId))
        return self.stats

    def findByWorkflow(self, workflowId, userId):
        self.calls.append(('findByWorkflow', workflowId, userId))
        return self.by_workflow


class FakeWorkflow:
    def __init__(self, user_id):
        self._user_id = user_id

    def getUserId(self):
        return self._user_id


class FakeWorkflowRepository:
    def __init__(self):
        self.by_id = {}

    def findById(self, id):
        return self.by_id.get(id)


def controller():
    c = ScheduledWorkflowController(FakeDb(), {})
    fake = FakeScheduleService()
    fake_wf_repo = FakeWorkflowRepository()
    c.scheduleService = fake
    c.workflowRepository = fake_wf_repo
    return c, fake, fake_wf_repo


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------

def test_index_unauthenticated():
    c, _, _ = controller()
    assert c.index(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_index_success():
    c, fake, _ = controller()
    fake.find_by_user = [{'id': 1}, {'id': 2}]
    r = c.index(ctx())
    assert r == {'success': True, 'data': [{'id': 1}, {'id': 2}], 'count': 2, 'status_code': 200}
    assert fake.calls == [('findByUser', 3)]


def test_index_exception():
    c, fake, _ = controller()

    def boom(userId):
        raise Exception('db down')
    fake.findByUser = boom
    r = c.index(ctx())
    assert r == {'success': False, 'error': 'db down', 'status_code': 500}


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

def test_create_unauthenticated():
    c, _, _ = controller()
    assert c.create(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_create_missing_workflow_id():
    c, _, _ = controller()
    assert c.create(ctx(body={'scheduled_time': '2099-01-01 00:00:00'})) == {
        'success': False, 'error': 'Workflow ID is required', 'status_code': 400,
    }
    # 0 is empty() in PHP too
    assert c.create(ctx(body={'workflow_id': 0, 'scheduled_time': '2099-01-01 00:00:00'})) == {
        'success': False, 'error': 'Workflow ID is required', 'status_code': 400,
    }


def test_create_missing_scheduled_time():
    c, _, _ = controller()
    assert c.create(ctx(body={'workflow_id': 5})) == {
        'success': False, 'error': 'Scheduled time is required', 'status_code': 400,
    }


def test_create_workflow_not_found():
    c, _, wf_repo = controller()
    r = c.create(ctx(body={'workflow_id': 5, 'scheduled_time': '2099-01-01 00:00:00'}))
    assert r == {'success': False, 'error': 'Workflow not found', 'status_code': 404}
    wf_repo.by_id[5] = FakeWorkflow(user_id=99)  # belongs to a different user
    r = c.create(ctx(body={'workflow_id': 5, 'scheduled_time': '2099-01-01 00:00:00'}))
    assert r == {'success': False, 'error': 'Workflow not found', 'status_code': 404}


def test_create_invalid_repeat_type():
    c, _, wf_repo = controller()
    wf_repo.by_id[5] = FakeWorkflow(user_id=3)
    r = c.create(ctx(body={
        'workflow_id': 5, 'scheduled_time': '2099-01-01 00:00:00', 'repeat_type': 'yearly',
    }))
    assert r == {
        'success': False,
        'error': 'Invalid repeat type. Must be one of: none, hourly, daily, weekly, monthly',
        'status_code': 400,
    }


def test_create_success_defaults_and_types():
    c, fake, wf_repo = controller()
    wf_repo.by_id[5] = FakeWorkflow(user_id=3)
    fake.created = {'id': 1, 'workflow_id': 5}
    r = c.create(ctx(body={'workflow_id': '5', 'scheduled_time': '2099-01-01 00:00:00'}))
    assert r == {
        'success': True, 'data': {'id': 1, 'workflow_id': 5},
        'message': 'Schedule created successfully', 'status_code': 201,
    }
    assert fake.calls == [('create', {
        'user_id': 3, 'workflow_id': 5, 'input_prompt': None,
        'scheduled_time': '2099-01-01 00:00:00', 'repeat_type': 'none', 'repeat_interval': 1,
    })]


def test_create_success_explicit_repeat():
    c, fake, wf_repo = controller()
    wf_repo.by_id[5] = FakeWorkflow(user_id=3)
    fake.created = {'id': 2}
    c.create(ctx(body={
        'workflow_id': 5, 'scheduled_time': '2099-01-01 00:00:00', 'input_prompt': 'go',
        'repeat_type': 'daily', 'repeat_interval': '3',
    }))
    assert fake.calls == [('create', {
        'user_id': 3, 'workflow_id': 5, 'input_prompt': 'go',
        'scheduled_time': '2099-01-01 00:00:00', 'repeat_type': 'daily', 'repeat_interval': 3,
    })]


def test_create_exception():
    c, fake, wf_repo = controller()
    wf_repo.by_id[5] = FakeWorkflow(user_id=3)

    def boom(data):
        raise Exception('insert failed')
    fake.create = boom
    r = c.create(ctx(body={'workflow_id': 5, 'scheduled_time': '2099-01-01 00:00:00'}))
    assert r == {'success': False, 'error': 'insert failed', 'status_code': 500}


# ---------------------------------------------------------------------------
# show
# ---------------------------------------------------------------------------

def test_show_unauthenticated():
    c, _, _ = controller()
    assert c.show(ctx(user_id=None), 1) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_show_not_found():
    c, fake, _ = controller()
    fake.found_by_id = None
    r = c.show(ctx(), 1)
    assert r == {'success': False, 'error': 'Schedule not found', 'status_code': 404}
    assert fake.calls == [('findById', 1)]


def test_show_wrong_owner():
    c, fake, _ = controller()
    fake.found_by_id = {'id': 1, 'user_id': 99}
    r = c.show(ctx(), 1)
    assert r == {'success': False, 'error': 'Schedule not found', 'status_code': 404}


def test_show_success():
    c, fake, _ = controller()
    fake.found_by_id = {'id': 1, 'user_id': 3}
    r = c.show(ctx(), 1)
    assert r == {'success': True, 'data': {'id': 1, 'user_id': 3}, 'status_code': 200}


def test_show_exception():
    c, fake, _ = controller()

    def boom(id):
        raise Exception('boom')
    fake.findById = boom
    r = c.show(ctx(), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------

def test_update_unauthenticated():
    c, _, _ = controller()
    assert c.update(ctx(user_id=None), 1) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_update_invalid_repeat_type():
    c, _, _ = controller()
    r = c.update(ctx(body={'repeat_type': 'yearly'}), 1)
    assert r == {'success': False, 'error': 'Invalid repeat type', 'status_code': 400}


def test_update_not_found():
    c, fake, _ = controller()
    fake.updated = None
    r = c.update(ctx(body={'input_prompt': 'x'}), 1)
    assert r == {'success': False, 'error': 'Schedule not found', 'status_code': 404}
    assert fake.calls == [('update', 1, 3, {'input_prompt': 'x'})]


def test_update_success():
    c, fake, _ = controller()
    fake.updated = {'id': 1, 'input_prompt': 'x'}
    r = c.update(ctx(body={'input_prompt': 'x'}), 1)
    assert r == {
        'success': True, 'data': {'id': 1, 'input_prompt': 'x'},
        'message': 'Schedule updated successfully', 'status_code': 200,
    }


def test_update_exception():
    c, fake, _ = controller()

    def boom(id, userId, data):
        raise Exception('boom')
    fake.update = boom
    r = c.update(ctx(body={}), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# destroy
# ---------------------------------------------------------------------------

def test_destroy_unauthenticated():
    c, _, _ = controller()
    assert c.destroy(ctx(user_id=None), 1) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_destroy_not_found():
    c, fake, _ = controller()
    fake.deleted = False
    r = c.destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'Schedule not found', 'status_code': 404}


def test_destroy_success():
    c, fake, _ = controller()
    fake.deleted = True
    r = c.destroy(ctx(), 1)
    assert r == {'success': True, 'message': 'Schedule deleted successfully', 'status_code': 200}
    assert fake.calls == [('delete', 1, 3)]


def test_destroy_exception():
    c, fake, _ = controller()

    def boom(id, userId):
        raise Exception('boom')
    fake.delete = boom
    r = c.destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# pause / resume
# ---------------------------------------------------------------------------

def test_pause_unauthenticated():
    c, _, _ = controller()
    assert c.pause(ctx(user_id=None), 1) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_pause_not_found():
    c, fake, _ = controller()
    fake.paused = False
    r = c.pause(ctx(), 1)
    assert r == {'success': False, 'error': 'Schedule not found or cannot be paused', 'status_code': 404}


def test_pause_success():
    c, fake, _ = controller()
    fake.paused = True
    r = c.pause(ctx(), 1)
    assert r == {'success': True, 'message': 'Schedule paused successfully', 'status_code': 200}
    assert fake.calls == [('pause', 1, 3)]


def test_pause_exception():
    c, fake, _ = controller()

    def boom(id, userId):
        raise Exception('boom')
    fake.pause = boom
    r = c.pause(ctx(), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


def test_resume_unauthenticated():
    c, _, _ = controller()
    assert c.resume(ctx(user_id=None), 1) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_resume_not_found():
    c, fake, _ = controller()
    fake.resumed = False
    r = c.resume(ctx(), 1)
    assert r == {'success': False, 'error': 'Schedule not found or not paused', 'status_code': 404}


def test_resume_success():
    c, fake, _ = controller()
    fake.resumed = True
    r = c.resume(ctx(), 1)
    assert r == {'success': True, 'message': 'Schedule resumed successfully', 'status_code': 200}
    assert fake.calls == [('resume', 1, 3)]


def test_resume_exception():
    c, fake, _ = controller()

    def boom(id, userId):
        raise Exception('boom')
    fake.resume = boom
    r = c.resume(ctx(), 1)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------

def test_stats_unauthenticated():
    c, _, _ = controller()
    assert c.stats(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_stats_success():
    c, fake, _ = controller()
    fake.stats = {'total': 5, 'pending': 2}
    r = c.stats(ctx())
    assert r == {'success': True, 'data': {'total': 5, 'pending': 2}, 'status_code': 200}
    assert fake.calls == [('getStats', 3)]


def test_stats_exception():
    c, fake, _ = controller()

    def boom(userId):
        raise Exception('boom')
    fake.getStats = boom
    r = c.stats(ctx())
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}


# ---------------------------------------------------------------------------
# byWorkflow
# ---------------------------------------------------------------------------

def test_by_workflow_unauthenticated():
    c, _, _ = controller()
    assert c.byWorkflow(ctx(user_id=None), 7) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_by_workflow_success():
    c, fake, _ = controller()
    fake.by_workflow = [{'id': 1}]
    r = c.byWorkflow(ctx(), 7)
    assert r == {'success': True, 'data': [{'id': 1}], 'count': 1, 'status_code': 200}
    assert fake.calls == [('findByWorkflow', 7, 3)]


def test_by_workflow_exception():
    c, fake, _ = controller()

    def boom(workflowId, userId):
        raise Exception('boom')
    fake.findByWorkflow = boom
    r = c.byWorkflow(ctx(), 7)
    assert r == {'success': False, 'error': 'boom', 'status_code': 500}
