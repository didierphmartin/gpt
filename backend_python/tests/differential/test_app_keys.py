import pytest
from app.db import open_primary
from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential


def test_app_keys_admin_reads_parity(both):
    """User 3 is admin, so index/workflows/agents run for real (200), not just 403 parity."""
    same(*both('GET', '/api/v1/app-keys'))
    same(*both('GET', '/api/v1/app-keys/whoami'))   # JWT auth -> 401 "requires app-key authentication"
    same(*both('GET', f'/api/v1/app-keys/workflows?user_id={DIFF_USER_ID}'))
    same(*both('GET', f'/api/v1/app-keys/agents?user_id={DIFF_USER_ID}'))


def test_app_keys_workflows_agents_missing_user_id_parity(both):
    same(*both('GET', '/api/v1/app-keys/workflows'))
    same(*both('GET', '/api/v1/app-keys/agents'))


def test_app_keys_unauthenticated_401(both):
    same(*both('GET', '/api/v1/app-keys', auth=False))
    same(*both('GET', '/api/v1/app-keys/whoami', auth=False))


def test_app_keys_destroy_not_found_parity(both):
    same(*both('DELETE', '/api/v1/app-keys/999999999'))


def test_app_keys_create_validation_parity(both):
    same(*both('POST', '/api/v1/app-keys', json={}))
    same(*both('POST', '/api/v1/app-keys', json={'user_id': DIFF_USER_ID}))
    same(*both('POST', '/api/v1/app-keys',
               json={'user_id': DIFF_USER_ID, 'application_id': 'differential', 'name': 'x', 'scopes': []}))


def test_app_keys_create_destroy_round_trip(php, py, token, config):
    """Create a `differential-tmp` key on each backend and delete it by its
    own returned id on the SAME backend that created it (PHP first).

    NOTE on the brief's "assert GET /app-keys equals the pre-state"
    (task-2-brief.md line 9): AppKeyRepository::revoke()
    (backend/src/AgentTeam/Services/AppKeyRepository.php:139-146) is a soft
    delete -- it only sets `revoked_at`, it never removes the row -- and
    `listAll()` (151-176) never filters on `revoked_at`, so a destroyed key
    stays visible in `GET /app-keys` forever with `revoked_at` populated.
    A literal before/after equality is therefore impossible to achieve
    through the public API on either backend (this is PHP's real behavior,
    ported as-is). Instead this test asserts API-level parity -- the new
    row appears in "after" on both backends with an identical shape and
    `revoked_at` set, every pre-existing row is untouched -- and then
    hard-deletes the rows it created via direct SQL so the DB is actually
    left as it was found for user 3, per the Global Constraints."""
    h = {'Authorization': f'Bearer {token}'}
    body = {'user_id': DIFF_USER_ID, 'application_id': 'differential', 'name': 'differential-tmp',
            'scopes': ['agents:run:1']}
    db = open_primary(config)
    created_ids = []
    try:
        for c in (php, py):   # PHP first, so PHP's on-demand state lands before Python touches the same rows
            before = c.get('/api/v1/app-keys', headers=h).json()
            assert before['success'] is True, before

            created = c.post('/api/v1/app-keys', json=body, headers=h)
            assert created.status_code == 201, created.text
            created_json = created.json()
            assert created_json['success'] is True
            assert created_json['data']['name'] == 'differential-tmp'
            assert created_json['data']['full_key'].startswith('ak_')
            key_id = created_json['data']['id']
            created_ids.append(key_id)

            deleted = c.delete(f'/api/v1/app-keys/{key_id}', headers=h)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {'success': True, 'data': {'id': key_id, 'revoked': True}}

            after = c.get('/api/v1/app-keys', headers=h).json()
            before_by_id = {r['id']: r for r in before['data']}
            after_by_id = {r['id']: r for r in after['data']}
            assert set(before_by_id) <= set(after_by_id)
            for rid, row in before_by_id.items():
                assert after_by_id[rid] == row   # every pre-existing row is byte-identical
            new_row = after_by_id[key_id]
            assert new_row['name'] == 'differential-tmp'
            assert new_row['application_id'] == 'differential'
            assert new_row['user_id'] == DIFF_USER_ID
            assert new_row['revoked_at'] is not None
    finally:
        if created_ids:
            placeholders = ','.join(['?'] * len(created_ids))
            db.execute(f'DELETE FROM app_keys WHERE id IN ({placeholders})', created_ids)
        db.close()
