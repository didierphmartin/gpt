import time
import bcrypt
import jwt
import pytest
from starlette.datastructures import Headers
from app.controllers.auth_controller import (AuthController, normalize_plan, role_for_plan, plan_rank,
                                             generate_tokens)
from app.support.http import Ctx

SECRET = 'unit-secret'
CONFIG = {'auth': {'jwt_secret': SECRET, 'jwt_expiry': 28800, 'refresh_expiry': 604800,
                   'app_key_secret': 'x', 'login_jwt_secret': ''}, 'login_db': {}}


class FakeDb:
    def __init__(self, one=None, all_=None):
        self.one = list(one or []); self.all_ = list(all_ or []); self.calls = []; self.next_id = 77
    def fetch_one(self, sql, p=None):
        self.calls.append((sql, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, sql, p=None):
        self.calls.append((sql, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, sql, p=None):
        self.calls.append((sql, p)); return 1
    def insert(self, sql, p=None):
        self.calls.append((sql, p)); return self.next_id


def ctx(body=None, user_id=None, auth_type=None, headers=None):
    c = Ctx(method='POST', uri='/api/v1/auth', headers=Headers(headers or {}), query={}, body=body or {},
            raw_body='', params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    if auth_type:
        c['auth_type'] = auth_type
    return c


def test_plan_helpers():
    assert normalize_plan('Synergy_Premium') == 'premium' and normalize_plan('standard') == 'standard'
    assert normalize_plan('gold') == 'free' and normalize_plan(None) == 'free'
    assert role_for_plan('free') == 'prospect' and role_for_plan('premium') == 'user'
    assert plan_rank('premium') == 2 and plan_rank('bogus') == 0


def test_generate_tokens_claims():
    t = generate_tokens(3, SECRET, 28800, 604800)
    # PyJWT >=2.10 raises InvalidSubjectError for a non-string `sub` unless verify_sub
    # is disabled (see app.middleware.auth.decode_hs256, which does the same for the
    # same reason: gpt-chat's `sub` claim is a numeric user id, not an RFC 7519 string).
    opts = {'options': {'verify_sub': False}}
    a = jwt.decode(t['access_token'], SECRET, algorithms=['HS256'], **opts)
    r = jwt.decode(t['refresh_token'], SECRET, algorithms=['HS256'], **opts)
    assert a['iss'] == 'gpt-chat' and a['sub'] == 3 and a['type'] == 'access' and a['exp'] - a['iat'] == 28800
    assert r['type'] == 'refresh' and r['exp'] - r['iat'] == 604800


def test_constructor_fails_closed_without_secret():
    with pytest.raises(RuntimeError, match='JWT secret is not configured'):
        AuthController(FakeDb(), {'auth': {'jwt_secret': ''}})


def test_login_validation_and_bad_credentials():
    c = AuthController(FakeDb(), CONFIG)
    assert c.login(ctx({'email': '', 'password': 'x'})) == {
        'success': False, 'message': 'Email and password are required', 'status_code': 400}
    db = FakeDb(one=[None])
    c = AuthController(db, CONFIG)
    assert c.login(ctx({'email': ' A@B.com ', 'password': 'x'}))['status_code'] == 401
    assert db.calls[0][1] == ['a@b.com']     # lowercased + trimmed


def test_login_success_shape_accepts_php_2y_hash():
    pw_hash = bcrypt.hashpw(b'secret', bcrypt.gensalt()).decode().replace('$2b$', '$2y$', 1)
    user = {'id': 3, 'email': 'a@b.com', 'password': pw_hash, 'first_name': 'A', 'last_name': 'B',
            'role': 'admin', 'plan': 'premium', 'provider': 'email', 'created_at': '2026-01-01 00:00:00',
            'app_key_prefix': None, 'app_key_created_at': None}
    db = FakeDb(one=[user])
    r = AuthController(db, CONFIG).login(ctx({'email': 'a@b.com', 'password': 'secret'}))
    assert r['success'] is True and r['message'] == 'Login successful' and r['status_code'] == 200
    u = r['data']['user']
    assert list(u) == ['id', 'email', 'first_name', 'last_name', 'role', 'plan', 'provider', 'last_login',
                       'created_at', 'app_key_prefix', 'app_key_created_at']
    assert u['id'] == 3 and r['data']['expires_in'] == 28800
    assert any('last_login = NOW()' in s for s, _ in db.calls)


def test_register_validation_order():
    c = AuthController(FakeDb(), CONFIG)
    assert c.register(ctx({'email': 'x@y.com'}))['message'] == 'Email and password are required'
    assert c.register(ctx({'email': 'bad', 'password': 'p'}))['message'] == 'Invalid email format'
    r = c.register(ctx({'email': 'x@y.com', 'password': 'p'}))
    assert r['code'] == 'LEDGER_ACCOUNT_REQUIRED' and r['status_code'] == 400
    db = FakeDb(one=[{'id': 1}])
    r2 = AuthController(db, CONFIG).register(ctx({'email': 'x@y.com', 'password': 'p', 'ledger_user_id': 'L1'}))
    assert r2 == {'success': False, 'message': 'Email already registered', 'status_code': 409}


def test_register_success_hashes_with_bcrypt_and_returns_tokens():
    db = FakeDb(one=[None])
    r = AuthController(db, CONFIG).register(ctx({'email': 'N@y.com', 'password': 'p', 'ledger_user_id': 'L1',
                                                 'plan': 'synergy_standard', 'first_name': ' F '}))
    assert r['success'] and r['data']['user'] == {
        'id': 77, 'email': 'n@y.com', 'first_name': 'F', 'last_name': '', 'role': 'user', 'plan': 'standard',
        'provider': 'email', 'last_login': r['data']['user']['last_login'],
        'created_at': r['data']['user']['created_at'], 'app_key_prefix': None, 'app_key_created_at': None}
    insert_params = [p for s, p in db.calls if s.strip().startswith('INSERT')][0]
    assert bcrypt.checkpw(b'p', insert_params[1].encode())


def test_verify_reads_authorization_header():
    c = AuthController(FakeDb(), CONFIG)
    assert c.verify(ctx())['message'] == 'Authorization token required'
    tok = generate_tokens(9, SECRET, 10, 10)['access_token']
    assert c.verify(ctx(headers={'authorization': 'Bearer ' + tok})) == {
        'success': True, 'message': 'Token is valid', 'data': {'user_id': 9}, 'status_code': 200}
    assert c.verify(ctx(headers={'authorization': 'Bearer nope'}))['message'] == 'Invalid or expired token'


def test_handle_action_gate_and_dispatch():
    c = AuthController(FakeDb(), CONFIG)
    assert c.handleAction(ctx({'action': 'upgrade_plan'})) == {
        'success': False, 'message': 'Authentication required', 'status_code': 401}
    assert c.handleAction(ctx({'action': 'nope'})) == {'success': False, 'message': 'Invalid action', 'status_code': 400}
    assert c.handleAction(ctx({'action': 'logout'})) == {'success': True, 'message': 'Logout successful', 'status_code': 200}


def test_handle_action_unhashable_action_is_invalid_action_not_500():
    """PHP's `match` falls to its default arm for a non-scalar $action; table.get() on
    a dict/list would raise TypeError: unhashable type if not guarded."""
    c = AuthController(FakeDb(), CONFIG)
    assert c.handleAction(ctx({'action': []})) == {'success': False, 'message': 'Invalid action', 'status_code': 400}
    assert c.handleAction(ctx({'action': {'a': 1}})) == {'success': False, 'message': 'Invalid action', 'status_code': 400}


def test_php_empty_semantics_on_string_zero():
    """PHP empty("0") is true; a plain truthiness check would wrongly accept "0"."""
    c = AuthController(FakeDb(), CONFIG)
    assert c.login(ctx({'email': '0', 'password': 'x'})) == {
        'success': False, 'message': 'Email and password are required', 'status_code': 400}
    assert c.login(ctx({'email': 'a@b.com', 'password': '0'})) == {
        'success': False, 'message': 'Email and password are required', 'status_code': 400}

    db = FakeDb()
    r = AuthController(db, CONFIG).register(ctx({'email': 'z@y.com', 'password': 'p', 'ledger_user_id': '0'}))
    assert r == {'success': False,
                 'message': 'Registration requires a valid subscription. Please register through synergyaichat.com',
                 'code': 'LEDGER_ACCOUNT_REQUIRED', 'status_code': 400}
    assert not any(s.strip().startswith('INSERT') for s, _ in db.calls)

    assert AuthController(FakeDb(), CONFIG).firebaseAuth(ctx({'provider': 'google', 'idToken': '0'})) == {
        'success': False, 'message': 'Invalid authentication data', 'status_code': 400}


def test_upgrade_plan_and_link_phone():
    db = FakeDb()
    c = AuthController(db, CONFIG)
    assert c.upgradePlan(ctx({'plan': 'gold'}, user_id=3))['message'] == 'Invalid plan. Must be standard or premium.'
    r = c.upgradePlan(ctx({'plan': 'app_premium'}, user_id=3))
    assert r == {'success': True, 'message': 'Plan upgraded to premium', 'plan': 'premium', 'role': 'user', 'status_code': 200}
    assert c.linkPhone(ctx({'phone_number': ''}, user_id=3))['message'] == 'Phone number is required'
    db2 = FakeDb(one=[{'id': 4}])
    assert AuthController(db2, CONFIG).linkPhone(ctx({'phone_number': '+1'}, user_id=3))['status_code'] == 409


def test_app_key_generation_requires_jwt_auth_type():
    c = AuthController(FakeDb(), CONFIG)
    assert c.generateAppKey(ctx(user_id=3, auth_type='user_app_key'))['status_code'] == 401
    r = c.generateAppKey(ctx(user_id=3, auth_type='jwt'))
    key = r['data']['app_key']
    assert key.startswith('uak_') and len(key) == 36 and r['data']['app_key_prefix'] == key[:12]


def test_admin_generate_requires_admin_role():
    db = FakeDb(one=[{'role': 'user'}])
    r = AuthController(db, CONFIG).adminGenerateAppKeyForUser(ctx({'user_id': 5}, user_id=3, auth_type='jwt'))
    assert r == {'success': False, 'message': 'Admin privileges required', 'status_code': 403}
    db2 = FakeDb(one=[{'role': 'admin'}, None])
    r2 = AuthController(db2, CONFIG).adminGenerateAppKeyForUser(ctx({'user_id': 5}, user_id=3, auth_type='jwt'))
    assert r2 == {'success': False, 'message': 'User not found', 'status_code': 404}


def test_debug_auth():
    r = AuthController(FakeDb(), CONFIG).debugAuth(ctx(user_id=3, headers={'authorization': 'Bearer x'}))
    assert r['user_id'] == 3 and r['authenticated'] is True and r['has_auth_header'] is True
    assert 'php_version' in r
