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


def test_valid_jwt_with_aud_claim_is_still_accepted():
    """firebase/php-jwt (and PHP's decode) ignore an `aud` claim entirely; PyJWT
    rejects any token carrying one unless verify_aud is disabled."""
    now = int(time.time())
    tok = jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 3600, 'sub': 3, 'type': 'access',
                      'aud': 'someapp'}, SECRET, algorithm='HS256')
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + tok))
    assert r['user_id'] == 3 and r['auth_type'] == 'jwt' and r['authenticated'] is True


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


def test_jwt_validation_failure_is_logged_with_reason(monkeypatch):
    """error_log must carry the underlying jwt error message, not just a generic
    'JWT validation failed' with no detail."""
    import app.middleware.auth as auth_mod
    logged = []
    monkeypatch.setattr(auth_mod, 'error_log', logged.append)
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    a.handle(ctx(auth='Bearer ' + token(exp_delta=-10)))
    assert any(m.startswith('[AuthMiddleware] JWT validation failed: ') and len(m) > len('[AuthMiddleware] JWT validation failed: ')
              for m in logged)


def test_valid_jwt_with_non_numeric_sub_is_401_invalid_credential():
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, lambda: FakeDb())
    r = a.handle(ctx(auth='Bearer ' + token(sub='abc')))
    assert r == {'error': True, 'status_code': 401,
                'body': {'success': False, 'message': 'Invalid or expired credential'}}


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


def test_uak_validation_opens_and_closes_a_fresh_connection_per_call():
    """PHP opens/drops a DB connection per request; the middleware must not cache
    one on the instance (that would survive across every request in the process)."""
    class CountingFakeDb(FakeDb):
        def __init__(self, rows=None):
            super().__init__(rows)
            self.closed = False
        def close(self):
            self.closed = True

    made = []

    def factory():
        db = CountingFakeDb(rows=[{'id': 5}])
        made.append(db)
        return db

    key = 'uak_' + 'ab' * 16
    a = AuthMiddleware(SECRET, PUBLIC_ROUTES, CONFIG, factory)

    a.handle(ctx(auth='Bearer ' + key))
    a.handle(ctx(auth='Bearer ' + key))

    assert len(made) == 2
    assert all(db.closed for db in made)

    # No Authorization header on a public route must not touch the DB at all.
    a.handle(ctx('POST', '/api/v1/auth'))
    assert len(made) == 2
