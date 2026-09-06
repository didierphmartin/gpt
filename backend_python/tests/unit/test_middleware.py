import hashlib, hmac, time
import jwt
import pytest
from starlette.datastructures import Headers
from app.support.http import Ctx
from app.middleware.cors import CorsMiddleware
from app.middleware.auth import AuthMiddleware, user_app_key_pepper, hash_user_app_key
from app.middleware.processor import MiddlewareProcessor, PUBLIC_ROUTES

SECRET = 'test-secret'
CONFIG = {'auth': {'jwt_secret': SECRET, 'app_key_secret': 'ak-secret'}, 'contexts_database': {}}


class FakeDb:
    """Records queries; answers fetch_one from a canned list."""
    def __init__(self, rows=None):
        self.rows = list(rows or []); self.calls = []
    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params)); return self.rows.pop(0) if self.rows else None
    def execute(self, sql, params=None):
        self.calls.append((sql, params)); return 1
    def close(self): pass


def ctx(method='GET', uri='/api/v1/prompts', auth=None):
    h = Headers({'authorization': auth} if auth else {})
    return Ctx(method=method, uri=uri, headers=h, query={}, body={}, raw_body='', params={},
               user_id=None, authenticated=False, remote_addr='')


def token(sub=3, exp_delta=3600, secret=SECRET):
    now = int(time.time())
    return jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + exp_delta, 'sub': sub, 'type': 'access'},
                      secret, algorithm='HS256')


def test_cors_headers_and_options():
    c = CorsMiddleware({})
    assert c.headers() == {'Access-Control-Allow-Origin': '*',
                           'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                           'Access-Control-Allow-Headers': 'Content-Type, Authorization'}
    assert c.handle(ctx('OPTIONS')) == {'status_code': 204, 'headers': {}, 'body': ''}
    assert c.handle(ctx('GET')) is None


def test_protected_route_without_header_is_401():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    assert a.handle(ctx()) == {'error': True, 'status_code': 401,
                               'body': {'success': False, 'message': 'Authorization token required'}}


def test_bad_or_expired_jwt_is_401_invalid_credential():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + token(exp_delta=-10)))
    assert r['body']['message'] == 'Invalid or expired credential'
    r2 = a.handle(ctx(auth='Bearer ' + token(secret='other')))
    assert r2['status_code'] == 401


def test_valid_jwt_sets_identity():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + token(sub=3)))
    assert r['user_id'] == 3 and r['auth_type'] == 'jwt' and r['authenticated'] is True


def test_public_route_passes_without_auth_and_marks_identity_when_present():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx('POST', '/api/v1/auth'))
    assert r['user_id'] is None and r['authenticated'] is False
    r2 = a.handle(ctx('POST', '/api/v1/auth', auth='Bearer ' + token(sub=9)))
    assert r2['user_id'] == 9 and r2['authenticated'] is True
    # method matters: GET /api/v1/auth is NOT public
    assert a.handle(ctx('GET', '/api/v1/auth'))['status_code'] == 401


def test_uak_key_via_bearer_and_appkey_schemes():
    pepper = user_app_key_pepper(CONFIG, SECRET)
    assert pepper == hmac.new(SECRET.encode(), b'user_app_key.v1', hashlib.sha256).hexdigest()
    key = 'uak_' + 'ab' * 16
    db = FakeDb(rows=[{'id': 5}, {'id': 5}])
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: db)
    r = a.handle(ctx(auth='Bearer ' + key))
    assert r['user_id'] == 5 and r['auth_type'] == 'user_app_key'
    r2 = a.handle(ctx(auth='AppKey ' + key))
    assert r2['user_id'] == 5 and r2['auth_type'] == 'user_app_key'
    assert db.calls[0][1] == [hash_user_app_key(key, pepper)]


def test_ak_app_key_scheme_uses_repository():
    full = 'ak_' + '0f' * 16
    h = hmac.new(b'ak-secret', full.encode(), hashlib.sha256).hexdigest()
    row = {'id': 11, 'user_id': 3, 'application_id': 'geoapps', 'name': 'n', 'key_prefix': full[:12],
           'key_hash': h, 'scopes': '["run"]', 'created_at': 'x', 'last_used_at': None, 'revoked_at': None}
    db = FakeDb(rows=[row])
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: db)
    r = a.handle(ctx(auth='AppKey ' + full))
    assert r['user_id'] == 3 and r['auth_type'] == 'app_key' and r['app_key_id'] == 11
    assert r['application_id'] == 'geoapps' and r['app_key_scopes'] == ['run']
    assert any('last_used_at = NOW()' in c[0] for c in db.calls)   # recordUse


def test_processor_short_circuits_options_and_401():
    p = MiddlewareProcessor(CONFIG, lambda: FakeDb())
    assert p.process(ctx('OPTIONS'))['handled'] is True
    r = p.process(ctx())
    assert r['handled'] is True and r['response']['status_code'] == 401
    ok = p.process(ctx(auth='Bearer ' + token()))
    assert ok['handled'] is False and ok['request']['user_id'] == 3


def test_processor_fails_closed_without_secret():
    with pytest.raises(RuntimeError, match='JWT secret is not configured'):
        MiddlewareProcessor({'auth': {'jwt_secret': ''}}, lambda: FakeDb())
