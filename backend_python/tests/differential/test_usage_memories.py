import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_usage_routes_parity(both):
    same(*both('GET', '/api/v1/usage'))
    same(*both('GET', '/api/v1/usage/balance'))
    same(*both('GET', '/api/v1/usage/transactions?limit=5'))
    same(*both('GET', '/api/v1/usage/stats'))


def test_user_memories_routes_parity(both):
    same(*both('GET', '/api/v1/user-memories'))
    same(*both('GET', '/api/v1/user-memories/events?limit=5'))


def test_usage_unauthenticated_401(both):
    same(*both('GET', '/api/v1/usage', auth=False))


def test_user_memories_unauthenticated_401(both):
    same(*both('GET', '/api/v1/user-memories', auth=False))


def test_user_memories_delete_event_not_found_parity(both):
    same(*both('DELETE', '/api/v1/user-memories/events/999999999'))


def test_user_memories_put_round_trip_leaves_content_unchanged(php, py, token):
    """PUT the same content back must be a no-op: user 3's memory content
    is identical before and after, on both backends."""
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/user-memories', headers=h).json()
        assert before['success'] is True, before
        mem_content = before['data']['memory']['content']
        user_content = before['data']['user']['content']

        r = c.put('/api/v1/user-memories', json={'memory': mem_content, 'user': user_content}, headers=h)
        assert r.status_code == 200 and r.json()['success'] is True, r.text

        after = c.get('/api/v1/user-memories', headers=h).json()
        assert after['data']['memory']['content'] == mem_content
        assert after['data']['user']['content'] == user_content
        assert after['data']['memory']['budget'] == before['data']['memory']['budget']
        assert after['data']['user']['budget'] == before['data']['user']['budget']
