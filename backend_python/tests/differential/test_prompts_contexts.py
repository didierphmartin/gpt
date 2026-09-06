import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_prompt_tree_and_404s(both):
    same(*both('GET', '/api/v1/prompts'))
    same(*both('GET', '/api/v1/prompts/999999999'))
    same(*both('PUT', '/api/v1/prompts/999999999', json={'name': 'x'}))
    same(*both('DELETE', '/api/v1/prompts/999999999'))
    same(*both('POST', '/api/v1/prompts', json={'type': 'x', 'name': 'n'}))
    same(*both('POST', '/api/v1/prompts', json={'type': 'prompt'}))
    same(*both('POST', '/api/v1/prompts', json={'type': 'prompt', 'name': 'n', 'parent_id': 999999999}))


def test_prompt_crud_round_trip_each_backend(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        r = c.post('/api/v1/prompts', json={'type': 'folder', 'name': 'diff-folder'}, headers=h)
        assert r.status_code == 200 and isinstance(r.json()['data']['id'], str), r.text
        fid = int(r.json()['data']['id'])
        try:
            r2 = c.post('/api/v1/prompts', json={'type': 'prompt', 'name': 'p', 'content': 'c/é', 'parent_id': fid}, headers=h)
            pid = int(r2.json()['data']['id'])
            got = c.get(f'/api/v1/prompts/{pid}', headers=h).json()['data']
            assert got['content'] == 'c/é' and got['parent_id'] == fid
            assert c.put(f'/api/v1/prompts/{pid}', json={'content': 'c2'}, headers=h).json()['message'] == 'Prompt updated successfully'
            assert c.put(f'/api/v1/prompts/{pid}', json={}, headers=h).status_code == 400
            tree = c.get('/api/v1/prompts', headers=h).json()['data']
            folder = next(n for n in tree if n['id'] == fid)
            assert folder['children'][0]['id'] == pid
            assert c.delete(f'/api/v1/prompts/{pid}', headers=h).json()['message'] == 'Prompt deleted successfully'
        finally:
            c.delete(f'/api/v1/prompts/{fid}', headers=h)


def test_context_list_and_404s(both):
    same(*both('GET', '/api/v1/contexts'))
    same(*both('GET', '/api/v1/contexts/999999999'))
    same(*both('PUT', '/api/v1/contexts/999999999', json={'title': 'x'}))
    same(*both('DELETE', '/api/v1/contexts/999999999'))
    same(*both('POST', '/api/v1/contexts', json={'messages': []}))
    same(*both('PUT', '/api/v1/contexts/1', json={'title': ' '}))


def test_context_round_trip_each_backend(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    msgs = [{'role': 'user', 'content': 'hello/é'}, {'role': 'assistant', 'content': 'hi', 'provider': 'claude'}]
    for c in (php, py):
        r = c.post('/api/v1/contexts', json={'messages': msgs, 'metadata': {'m': 1}}, headers=h)
        assert r.status_code == 200 and isinstance(r.json()['data']['id'], int), r.text
        cid = r.json()['data']['id']
        try:
            got = c.get(f'/api/v1/contexts/{cid}', headers=h).json()['data']
            assert got['title'] == 'hello/é' and got['provider'] == 'claude' and got['message_count'] == 2
            assert got['context_data'] == {'messages': msgs, 'metadata': {'m': 1}}
            assert c.put(f'/api/v1/contexts/{cid}', json={'title': 'renamed'}, headers=h).status_code == 200
            # Brief assumed PDO MySQL enables CLIENT_FOUND_ROWS by default (so a same-value UPDATE
            # would report 200). Live PHP does not set PDO::MYSQL_ATTR_FOUND_ROWS (index.php only
            # passes ATTR_ERRMODE / ATTR_DEFAULT_FETCH_MODE / ATTR_EMULATE_PREPARES), so MySQL reports
            # 0 affected rows for a no-op UPDATE and PHP returns 404. Db.connect intentionally does NOT
            # set client_flag=CLIENT.FOUND_ROWS so PyMySQL matches that real (unflagged) behavior.
            assert c.put(f'/api/v1/contexts/{cid}', json={'title': 'renamed'}, headers=h).status_code == 404
            up = c.post('/api/v1/contexts', json={'id': cid, 'messages': msgs + [{'role': 'user', 'content': 'x'}]}, headers=h)
            assert up.json()['message'] == 'Context updated successfully'
        finally:
            assert c.delete(f'/api/v1/contexts/{cid}', headers=h).status_code == 200
