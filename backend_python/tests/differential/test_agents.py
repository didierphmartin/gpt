"""Differential tests for AgentController (Phase 4, Task 5).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_agents_list_parity(both):
    same(*both('GET', '/api/v1/agents'))


def test_agents_tools_parity(both):
    same(*both('GET', '/api/v1/agents/tools'))


def test_agents_categories_parity(both):
    same(*both('GET', '/api/v1/agents/categories'))


def test_agent_not_found_parity(both):
    same(*both('GET', '/api/v1/agents/999999999'))
    same(*both('PUT', '/api/v1/agents/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/agents/999999999'))
    same(*both('POST', '/api/v1/agents/999999999/duplicate'))
    same(*both('POST', '/api/v1/agents/999999999/move-up'))
    same(*both('POST', '/api/v1/agents/999999999/move-down'))
    same(*both('GET', '/api/v1/agents/999999999/executions'))


def test_agent_create_validation_parity(both):
    same(*both('POST', '/api/v1/agents', json={}))
    same(*both('POST', '/api/v1/agents', json={'name': ''}))
    same(*both('POST', '/api/v1/agents', json={'name': 'x', 'agent_type': 'bogus'}))
    same(*both('POST', '/api/v1/agents', json={'name': 'x', 'visibility': 'bogus'}))


def test_agent_categories_rename_validation_parity(both):
    same(*both('PUT', '/api/v1/agents/categories/rename', json={}))
    same(*both('PUT', '/api/v1/agents/categories/rename', json={'old_name': 'a'}))
    same(*both('PUT', '/api/v1/agents/categories/rename', json={'old_name': 'same', 'new_name': 'same'}))


def test_agent_categories_delete_validation_parity(both):
    same(*both('DELETE', '/api/v1/agents/categories', json={}))


def test_agent_reorder_validation_parity(both):
    same(*both('POST', '/api/v1/agents/reorder', json={}))
    same(*both('POST', '/api/v1/agents/reorder', json={'team_id': 1}))
    same(*both('POST', '/api/v1/agents/reorder', json={'team_id': 1, 'agent_ids': []}))
    # An agent id owned by someone else / nonexistent -> 403 access-denied parity.
    same(*both('POST', '/api/v1/agents/reorder', json={'team_id': 1, 'agent_ids': [999999999]}))


def test_agents_unauthenticated_parity(both):
    same(*both('GET', '/api/v1/agents', auth=False))
    same(*both('GET', '/api/v1/agents/tools', auth=False))


def test_agent_create_show_update_duplicate_delete_round_trip(php, py, token):
    """PHP first, so PHP's on-demand state lands before Python touches the same
    rows. Delete by the id each backend itself returned; assert GET /agents
    equals the pre-state on that SAME backend afterwards (self-cleaning)."""
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/agents', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/agents',
                          json={'name': 'differential-tmp-agent', 'provider': 'claude', 'instructions': 'x'},
                          headers=h)
        assert created.status_code == 200, created.text
        cj = created.json()
        assert cj['success'] is True
        assert cj['message'] == "Agent 'differential-tmp-agent' created successfully"
        assert cj['data']['name'] == 'differential-tmp-agent'
        assert cj['data']['provider'] == 'claude'
        assert cj['data']['instructions'] == 'x'
        assert cj['data']['agent_type'] == 'standard'
        assert cj['data']['visibility'] == 'personal'
        agent_id = cj['data']['id']
        duplicate_id = None

        try:
            show = c.get(f'/api/v1/agents/{agent_id}', headers=h)
            assert show.status_code == 200, show.text
            sj = show.json()
            assert sj['success'] is True
            assert sj['data']['name'] == 'differential-tmp-agent'

            updated = c.put(f'/api/v1/agents/{agent_id}', json={'description': 'diff-desc'}, headers=h)
            assert updated.status_code == 200, updated.text
            uj = updated.json()
            assert uj['success'] is True
            assert uj['message'] == "Agent 'differential-tmp-agent' updated successfully"
            assert uj['data']['description'] == 'diff-desc'
            assert uj['data']['name'] == 'differential-tmp-agent'   # untouched

            executions = c.get(f'/api/v1/agents/{agent_id}/executions', headers=h)
            assert executions.status_code == 200, executions.text
            assert executions.json() == {'success': True, 'data': [], 'meta': {'count': 0, 'limit': 50, 'offset': 0}}

            dup = c.post(f'/api/v1/agents/{agent_id}/duplicate', headers=h)
            assert dup.status_code == 200, dup.text
            dj = dup.json()
            assert dj['success'] is True
            assert dj['message'] == 'Agent duplicated successfully'
            assert dj['data']['name'] == 'differential-tmp-agent (Copy)'
            assert dj['data']['description'] == 'diff-desc'
            duplicate_id = dj['data']['id']
        finally:
            deleted = c.delete(f'/api/v1/agents/{agent_id}', headers=h)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {'success': True, 'message': "Agent 'differential-tmp-agent' deleted successfully"}
            if duplicate_id is not None:
                deleted_dup = c.delete(f'/api/v1/agents/{duplicate_id}', headers=h)
                assert deleted_dup.status_code == 200, deleted_dup.text
                assert deleted_dup.json() == {'success': True,
                                               'message': "Agent 'differential-tmp-agent (Copy)' deleted successfully"}

        after = c.get('/api/v1/agents', headers=h).json()
        assert after == before


def test_agent_categories_round_trip(php, py, token):
    """PHP first; create two agents under a temp category, rename it, then
    clear it (agents fall back to Uncategorized), delete the agents, and
    assert GET /agents/categories equals the pre-state on that SAME backend
    afterwards."""
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/agents/categories', headers=h).json()
        assert before['success'] is True

        a1 = c.post('/api/v1/agents',
                     json={'name': 'differential-tmp-agent-cat', 'category': 'differential-tmp-cat'},
                     headers=h)
        assert a1.status_code == 200, a1.text
        agent_id = a1.json()['data']['id']
        assert a1.json()['data']['category'] == 'differential-tmp-cat'

        try:
            renamed = c.put('/api/v1/agents/categories/rename',
                             json={'old_name': 'differential-tmp-cat', 'new_name': 'differential-tmp-cat-2'},
                             headers=h)
            assert renamed.status_code == 200, renamed.text
            rj = renamed.json()
            assert rj == {'success': True, 'data': {'affected': 1, 'old_name': 'differential-tmp-cat',
                                                      'new_name': 'differential-tmp-cat-2'}}

            cleared = c.request('DELETE', '/api/v1/agents/categories',
                                 json={'name': 'differential-tmp-cat-2'}, headers=h)
            assert cleared.status_code == 200, cleared.text
            assert cleared.json() == {'success': True, 'data': {'affected': 1, 'name': 'differential-tmp-cat-2'}}

            show = c.get(f'/api/v1/agents/{agent_id}', headers=h)
            assert show.json()['data']['category'] is None
        finally:
            deleted = c.delete(f'/api/v1/agents/{agent_id}', headers=h)
            assert deleted.status_code == 200, deleted.text

        after = c.get('/api/v1/agents/categories', headers=h).json()
        assert after == before
