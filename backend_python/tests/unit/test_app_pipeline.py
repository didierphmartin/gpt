import time
import jwt


def test_health_is_public_and_returns_root_payload(client):
    r = client.get('/')
    assert r.status_code == 200
    body = r.json()
    assert body['success'] is True and body['message'] == 'GPT Chat Backend API' and body['version'] == '2.0.0'
    assert body['endpoints']['drive'] == '/api/v1/drive/*'
    assert 'status_code' not in body
    assert r.headers['access-control-allow-origin'] == '*'


def test_options_preflight_204_with_cors_headers(client):
    r = client.options('/api/v1/prompts')
    assert r.status_code == 204 and r.headers['access-control-allow-methods'] == 'GET, POST, PUT, DELETE, OPTIONS'


def test_unknown_route_404_envelope(client):
    r = client.get('/api/v1/does-not-exist', headers={'Authorization': 'Bearer nope'})
    # auth runs first: an invalid token on a protected URI is 401 before routing (same as PHP)
    assert r.status_code == 401
    r2 = client.get('/api/v1/does-not-exist', headers=_auth(client))
    assert r2.status_code == 404 and r2.json() == {'success': False, 'error': 'Endpoint not found',
                                                    'uri': '/api/v1/does-not-exist'}


def test_method_not_allowed_405(client):
    r = client.patch('/api/v1/prompts', headers=_auth(client))
    assert r.status_code == 405
    assert r.json()['error'] == 'Method not allowed' and set(r.json()['allowed_methods']) == {'GET', 'POST'}


def test_protected_route_without_token_401_message_envelope(client):
    r = client.get('/api/v1/prompts')
    assert r.status_code == 401 and r.json() == {'success': False, 'message': 'Authorization token required'}


def test_model_catalog_public(client):
    r = client.get('/api/v1/models/catalog')
    assert r.status_code == 200 and r.json()['success'] is True and isinstance(r.json()['providers'], dict | list)


def _auth(client):
    from app.config import load_config
    secret = load_config()['auth']['jwt_secret']
    now = int(time.time())
    tok = jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 600, 'sub': 3, 'type': 'access'}, secret, 'HS256')
    return {'Authorization': f'Bearer {tok}'}
