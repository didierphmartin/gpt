"""Differential tests for ScheduledWorkflowController + SchedulerController
(Phase 8, Task 2).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.

WORKFLOW_ID = 18 ("test 4") -- user 3's shortest-named workflow (verified
live against the CONTEXTS DB `agent_workflows` table, 2026-09-07), used only
as the schedule's `workflow_id` FK target; the workflow itself is never run.

Every created schedule uses `scheduled_time` far in the future
(2099-01-01) so `next_run` can never satisfy `getDueSchedules()`'s
`next_run <= NOW()` filter (ScheduledWorkflowService.php:170-184 /
scheduled_workflow_service.py's `getDueSchedules`) -- per constraints.md,
this suite must never trigger a real scheduled workflow run. `/scheduler/run`
itself is exercised ONLY with no/invalid token (both `auth=False`, so the
`both` helper does not attach a valid session either) -- never with a valid
token, so it always 401s before `executeScheduler()` is ever called.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential

WORKFLOW_ID = 18
FAR_FUTURE = '2099-01-01 00:00:00'


# ============================================================================
# Read-only listing parity
# ============================================================================

def test_schedules_list_parity(both):
    same(*both('GET', '/api/v1/schedules'))


def test_schedules_list_unauthenticated_parity(both):
    same(*both('GET', '/api/v1/schedules', auth=False))


def test_schedules_stats_parity(both):
    same(*both('GET', '/api/v1/schedules/stats'))


def test_schedules_by_workflow_parity(both):
    same(*both('GET', f'/api/v1/workflows/{WORKFLOW_ID}/schedules'))


def test_schedule_not_found_parity(both):
    same(*both('GET', '/api/v1/schedules/999999999'))
    same(*both('PUT', '/api/v1/schedules/999999999', json={'input_prompt': 'x'}))
    same(*both('DELETE', '/api/v1/schedules/999999999'))
    same(*both('POST', '/api/v1/schedules/999999999/pause'))
    same(*both('POST', '/api/v1/schedules/999999999/resume'))


def test_schedule_create_validation_parity(both):
    same(*both('POST', '/api/v1/schedules', json={}))
    same(*both('POST', '/api/v1/schedules', json={'workflow_id': WORKFLOW_ID}))
    same(*both('POST', '/api/v1/schedules', json={'workflow_id': 999999999, 'scheduled_time': FAR_FUTURE}))
    same(*both('POST', '/api/v1/schedules',
               json={'workflow_id': WORKFLOW_ID, 'scheduled_time': FAR_FUTURE, 'repeat_type': 'yearly'}))


# ============================================================================
# Round trip: create (far-future, can never become due) -> show -> update ->
# pause -> resume -> pause -> delete. PHP first, self-cleaning, lists equal
# pre-state afterwards on the SAME backend.
# ============================================================================

def test_schedule_create_show_update_pause_resume_delete_round_trip(php, py, token):
    h = {'Authorization': f'Bearer {token}'}

    for c in (php, py):
        before = c.get('/api/v1/schedules', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/schedules', json={
            'workflow_id': WORKFLOW_ID,
            'scheduled_time': FAR_FUTURE,
            'input_prompt': 'differential-tmp',
            'repeat_type': 'none',
        }, headers=h)
        assert created.status_code == 201, created.text
        cj = created.json()
        assert cj['success'] is True
        assert cj['message'] == 'Schedule created successfully'
        assert cj['data']['workflow_id'] == WORKFLOW_ID
        assert cj['data']['status'] == 'pending'
        schedule_id = cj['data']['id']

        try:
            show = c.get(f'/api/v1/schedules/{schedule_id}', headers=h)
            assert show.status_code == 200, show.text
            assert show.json()['data']['input_prompt'] == 'differential-tmp'

            updated = c.put(f'/api/v1/schedules/{schedule_id}',
                             json={'input_prompt': 'differential-tmp-updated'}, headers=h)
            assert updated.status_code == 200, updated.text
            uj = updated.json()
            assert uj['success'] is True
            assert uj['message'] == 'Schedule updated successfully'
            assert uj['data']['input_prompt'] == 'differential-tmp-updated'

            p1 = c.post(f'/api/v1/schedules/{schedule_id}/pause', headers=h)
            assert p1.status_code == 200, p1.text
            assert p1.json() == {'success': True, 'message': 'Schedule paused successfully'}
            assert c.get(f'/api/v1/schedules/{schedule_id}', headers=h).json()['data']['status'] == 'paused'

            r1 = c.post(f'/api/v1/schedules/{schedule_id}/resume', headers=h)
            assert r1.status_code == 200, r1.text
            assert r1.json() == {'success': True, 'message': 'Schedule resumed successfully'}
            assert c.get(f'/api/v1/schedules/{schedule_id}', headers=h).json()['data']['status'] == 'pending'

            p2 = c.post(f'/api/v1/schedules/{schedule_id}/pause', headers=h)
            assert p2.status_code == 200, p2.text
            assert c.get(f'/api/v1/schedules/{schedule_id}', headers=h).json()['data']['status'] == 'paused'

            # Already paused: resume() again should succeed a second time too.
            r2 = c.post(f'/api/v1/schedules/{schedule_id}/resume', headers=h)
            assert r2.status_code == 200, r2.text

            by_wf = c.get(f'/api/v1/workflows/{WORKFLOW_ID}/schedules', headers=h)
            assert by_wf.status_code == 200, by_wf.text
            assert schedule_id in [s['id'] for s in by_wf.json()['data']]
        finally:
            d = c.delete(f'/api/v1/schedules/{schedule_id}', headers=h)
            assert d.status_code == 200, d.text
            assert d.json() == {'success': True, 'message': 'Schedule deleted successfully'}

        after = c.get('/api/v1/schedules', headers=h).json()
        assert after == before


# ============================================================================
# Scheduler -- run() is exercised ONLY with no/invalid token (never a valid
# one, per constraints.md), so it always 401s before executeScheduler() runs.
# ============================================================================

def test_scheduler_run_no_token_parity(both):
    same(*both('POST', '/api/v1/scheduler/run', json={}, auth=False))


def test_scheduler_run_invalid_token_parity(both):
    same(*both('POST', '/api/v1/scheduler/run',
               json={'token': 'definitely-wrong-differential-token'}, auth=False))


def test_scheduler_status_parity(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    a = php.get('/api/v1/scheduler/status', headers=h)
    b = py.get('/api/v1/scheduler/status', headers=h)
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()
    # Wall-clock field -- compared for shape, not value.
    ja['data'].pop('server_time', None)
    jb['data'].pop('server_time', None)
    assert ja == jb


def test_scheduler_status_unauthenticated_parity(both):
    same(*both('GET', '/api/v1/scheduler/status', auth=False))
