"""Port of backend/tests/Unit/Middleware/AccessTokenSubjectTest.php.

Only a gpt access token is a session: not the login service's tokens (same secret), not a refresh token."""
from __future__ import annotations

import time

import jwt

from app.controllers.auth_controller import AuthController
from app.middleware.auth import AuthMiddleware

SECRET = 'test-secret-0123456789-0123456789'


def token(claims: dict) -> str:
    return jwt.encode({'iat': int(time.time()), 'exp': int(time.time()) + 60, 'sub': 7, **claims}, SECRET, algorithm='HS256')


def test_gpt_access_token_is_accepted():
    assert AuthMiddleware.access_token_subject(token({'iss': 'gpt-chat', 'type': 'access'}), SECRET) == 7


def test_login_service_token_is_refused():
    assert AuthMiddleware.access_token_subject(token({'iss': 'login-service', 'type': 'access'}), SECRET) is None


def test_refresh_token_is_refused():
    assert AuthMiddleware.access_token_subject(token({'iss': 'gpt-chat', 'type': 'refresh'}), SECRET) is None


def test_token_without_claims_is_refused():
    assert AuthMiddleware.access_token_subject(token({}), SECRET) is None


def test_middleware_refuses_a_login_service_token():
    m = AuthMiddleware(SECRET, [], {}, lambda: None)
    assert m._validate_token(token({'iss': 'login-service', 'type': 'access'})) is None
    assert m._validate_token(token({'iss': 'gpt-chat', 'type': 'access'})) == 7


def _verify(tok: str) -> dict:
    c = AuthController.__new__(AuthController)
    c.jwt_secret = SECRET
    return c.verify({'headers': {'Authorization': 'Bearer ' + tok}})


def test_verify_accepts_only_gpt_access_tokens():
    r = _verify(token({'iss': 'gpt-chat', 'type': 'access'}))
    assert r['status_code'] == 200 and r['data'] == {'user_id': 7}
    for claims in ({'iss': 'login-service', 'type': 'access'}, {'iss': 'gpt-chat', 'type': 'refresh'}):
        r = _verify(token(claims))
        assert r == {'success': False, 'message': 'Invalid or expired token', 'status_code': 401}
