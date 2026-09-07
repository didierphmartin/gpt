"""Differential tests for WorkflowController (Phase 4, Task 6) — data/CRUD/
outputs/node-document paths only. generate-python/adk/maf/nooa, run,
run-stream, tool-result, playbook-node are Phase 5/6 and not exercised here
(not routed on the Python side).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_workflows_list_parity(both):
    same(*both('GET', '/api/v1/workflows'))


def test_workflows_unauthenticated_401_parity(both):
    same(*both('GET', '/api/v1/workflows', auth=False))


def test_workflow_not_found_parity(both):
    same(*both('GET', '/api/v1/workflows/999999999'))
    same(*both('PUT', '/api/v1/workflows/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/workflows/999999999'))
    same(*both('GET', '/api/v1/workflows/999999999/executions'))
    same(*both('POST', '/api/v1/workflows/999999999/toggle'))
    same(*both('POST', '/api/v1/workflows/999999999/duplicate'))
    same(*both('GET', '/api/v1/workflows/999999999/outputs'))
    same(*both('GET', '/api/v1/workflows/999999999/outputs/f.json'))
    same(*both('GET', '/api/v1/workflows/999999999/nodes/1/documents'))
    same(*both('POST', '/api/v1/workflows/999999999/nodes/1/documents/metadata',
               json={'document': {'id': 'd', 'name': 'n'}}))
    same(*both('DELETE', '/api/v1/workflows/999999999/nodes/1/documents/doc_x'))


def test_workflow_create_validation_parity(both):
    same(*both('POST', '/api/v1/workflows', json={}))
    same(*both('POST', '/api/v1/workflows', json={'name': ''}))
    same(*both('POST', '/api/v1/workflows', json={'name': 'x', 'steps': [{}]}))


def test_run_events_not_found_parity(both):
    """32-zero id: valid runId shape, no such run on either backend.
    Also proves the Python side reads request['params']['runId'] rather
    than the router's numeric-coerced positional arg (see
    workflow_controller.py::runEvents docstring) -- an all-digit runId is
    exactly the case that coercion would corrupt."""
    same(*both('GET', '/api/v1/workflows/runs/' + '0' * 32 + '/events'))


def test_run_events_invalid_id_parity(both):
    same(*both('GET', '/api/v1/workflows/runs/not-hex-and-wrong-length/events'))


def test_workflow_create_show_update_toggle_duplicate_executions_outputs_documents_round_trip(php, py, token):
    """PHP first, so PHP's on-demand state lands before Python touches the
    same rows. Delete by the id each backend itself returned (both the
    original and its duplicate); assert GET /workflows equals the pre-state
    on that SAME backend afterwards (self-cleaning mutation)."""
    h = {'Authorization': f'Bearer {token}'}
    steps = [{'id': 's1', 'type': 'transform'}]

    for c in (php, py):
        before = c.get('/api/v1/workflows', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/workflows', json={'name': 'differential-tmp-wf', 'steps': steps}, headers=h)
        assert created.status_code == 201, created.text
        cj = created.json()
        assert cj['success'] is True
        assert cj['message'] == 'Workflow created successfully'
        assert cj['data']['name'] == 'differential-tmp-wf'
        assert cj['data']['steps'] == steps
        wf_id = cj['data']['id']
        dup_id = None

        try:
            show = c.get(f'/api/v1/workflows/{wf_id}', headers=h)
            assert show.status_code == 200, show.text
            assert show.json()['data']['name'] == 'differential-tmp-wf'

            updated = c.put(f'/api/v1/workflows/{wf_id}', json={'description': 'diff-desc'}, headers=h)
            assert updated.status_code == 200, updated.text
            uj = updated.json()
            assert uj['success'] is True
            assert uj['message'] == 'Workflow updated successfully'
            assert uj['data']['description'] == 'diff-desc'
            assert uj['data']['name'] == 'differential-tmp-wf'  # untouched

            t1 = c.post(f'/api/v1/workflows/{wf_id}/toggle', headers=h)
            assert t1.status_code == 200, t1.text
            t1j = t1.json()
            assert t1j['success'] is True
            t2 = c.post(f'/api/v1/workflows/{wf_id}/toggle', headers=h)
            assert t2.status_code == 200, t2.text
            t2j = t2.json()
            assert t1j['data']['enabled'] != t2j['data']['enabled']
            assert {t1j['message'], t2j['message']} == {'Workflow enabled', 'Workflow disabled'}

            dup = c.post(f'/api/v1/workflows/{wf_id}/duplicate', headers=h)
            assert dup.status_code == 201, dup.text
            dupj = dup.json()
            assert dupj['success'] is True
            assert dupj['message'] == 'Workflow duplicated successfully'
            assert dupj['data']['name'] == 'differential-tmp-wf (Copy)'
            dup_id = dupj['data']['id']

            execs = c.get(f'/api/v1/workflows/{wf_id}/executions', headers=h)
            assert execs.status_code == 200, execs.text
            assert execs.json() == {'success': True, 'data': [], 'count': 0}

            outs = c.get(f'/api/v1/workflows/{wf_id}/outputs', headers=h)
            assert outs.status_code == 200, outs.text
            assert outs.json()['success'] is True

            # Node id 1 does not belong to this (steps-only, no graph)
            # workflow -- exercises the not-found path deterministically
            # (verified live: workflow_nodes id=1 does not exist at all).
            docs = c.get(f'/api/v1/workflows/{wf_id}/nodes/1/documents', headers=h)
            assert docs.status_code == 404, docs.text
            assert docs.json() == {'success': False, 'error': 'Node not found'}
        finally:
            if dup_id is not None:
                d1 = c.delete(f'/api/v1/workflows/{dup_id}', headers=h)
                assert d1.status_code == 200, d1.text
                assert d1.json() == {'success': True, 'message': 'Workflow deleted successfully'}
            d2 = c.delete(f'/api/v1/workflows/{wf_id}', headers=h)
            assert d2.status_code == 200, d2.text
            assert d2.json() == {'success': True, 'message': 'Workflow deleted successfully'}

        after = c.get('/api/v1/workflows', headers=h).json()
        assert after == before
