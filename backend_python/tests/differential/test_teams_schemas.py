"""Differential tests for TeamController + WorkflowSchemaController (Phase 4, Task 4).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_teams_list_parity(both):
    same(*both('GET', '/api/v1/teams'))


def test_workflow_schemas_list_parity(both):
    same(*both('GET', '/api/v1/workflow-schemas'))


def test_teams_unauthenticated_401(both):
    same(*both('GET', '/api/v1/teams', auth=False))


def test_workflow_schemas_unauthenticated_401(both):
    same(*both('GET', '/api/v1/workflow-schemas', auth=False))


def test_team_not_found_parity(both):
    same(*both('GET', '/api/v1/teams/999999999'))
    same(*both('PUT', '/api/v1/teams/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/teams/999999999'))
    same(*both('GET', '/api/v1/teams/999999999/agents'))


def test_workflow_schema_not_found_parity(both):
    same(*both('GET', '/api/v1/workflow-schemas/999999999'))
    same(*both('PUT', '/api/v1/workflow-schemas/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/workflow-schemas/999999999'))


def test_team_create_validation_parity(both):
    same(*both('POST', '/api/v1/teams', json={}))
    same(*both('POST', '/api/v1/teams', json={'name': ''}))


def test_workflow_schema_create_validation_parity(both):
    same(*both('POST', '/api/v1/workflow-schemas', json={}))
    same(*both('POST', '/api/v1/workflow-schemas', json={'name': 'bad name!'}))
    same(*both('POST', '/api/v1/workflow-schemas',
               json={'name': 'ok-name', 'schema_json': {'type': 'array', 'properties': {}}}))


def test_team_create_show_update_agents_delete_round_trip(php, py, token):
    """PHP first, so PHP's on-demand state lands before Python touches the same rows.
    Delete by the id each backend itself returned; assert GET /teams equals the
    pre-state on that SAME backend afterwards (self.cleaning mutation)."""
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/teams', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/teams', json={'name': 'differential-tmp-team'}, headers=h)
        assert created.status_code == 201, created.text
        cj = created.json()
        assert cj['success'] is True
        assert cj['message'] == 'Team created successfully'
        assert cj['data']['name'] == 'differential-tmp-team'
        assert cj['data']['description'] == ''
        team_id = cj['data']['id']

        try:
            show = c.get(f'/api/v1/teams/{team_id}', headers=h)
            assert show.status_code == 200, show.text
            sj = show.json()
            assert sj['success'] is True
            assert sj['data']['name'] == 'differential-tmp-team'
            assert sj['data']['agents'] == []

            updated = c.put(f'/api/v1/teams/{team_id}', json={'description': 'diff-desc'}, headers=h)
            assert updated.status_code == 200, updated.text
            uj = updated.json()
            assert uj['success'] is True
            assert uj['message'] == 'Team updated successfully'
            assert uj['data']['description'] == 'diff-desc'
            assert uj['data']['name'] == 'differential-tmp-team'   # untouched

            agents = c.get(f'/api/v1/teams/{team_id}/agents', headers=h)
            assert agents.status_code == 200, agents.text
            assert agents.json() == {'success': True, 'data': [], 'count': 0}
        finally:
            deleted = c.delete(f'/api/v1/teams/{team_id}', headers=h)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {'success': True, 'message': 'Team deleted successfully'}

        after = c.get('/api/v1/teams', headers=h).json()
        assert after == before


def test_workflow_schema_create_show_update_delete_round_trip(php, py, token):
    """PHP first; delete by each backend's own returned id; assert
    GET /workflow-schemas equals the pre-state on that SAME backend afterwards.

    KNOWN LIVE-DB GAP (not a porting defect -- verified via `SHOW COLUMNS FROM
    workflow_schemas` against the shared live DB both backends use): the live
    `workflow_schemas` table has no `strict` column (nor `updated_at`), while
    WorkflowSchemaRepository::create/update (backend/src/AgentTeam/Services/
    WorkflowSchemaRepository.php:66, 58-61) write `strict` unconditionally on
    every request. So POST /workflow-schemas 500s on PHP live today, and the
    Python port -- built from the same INSERT column list -- 500s the same
    way against the same table. This test therefore asserts parity on that
    failure (identical status code, both success=False) rather than
    completing the show/update/delete steps, since no row is ever created to
    exercise them against. If/when the live schema gains `strict` (+
    `updated_at`), this test should be extended back to the full round trip
    per the task brief."""
    h = {'Authorization': f'Bearer {token}'}
    schema_json = {'type': 'object', 'properties': {'foo': {'type': 'string'}}}
    for c in (php, py):
        before = c.get('/api/v1/workflow-schemas', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/workflow-schemas',
                          json={'name': 'differential-tmp-schema', 'schema_json': schema_json, 'strict': True},
                          headers=h)
        assert created.status_code == 500, created.text
        cj = created.json()
        assert cj['success'] is False
        assert "'strict'" in cj['error']

        after = c.get('/api/v1/workflow-schemas', headers=h).json()
        assert after == before   # the failed insert left no trace
