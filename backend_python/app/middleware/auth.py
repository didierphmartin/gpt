"""Port of AuthMiddleware.php: JWT bearer, per-user `uak_` keys (Bearer or AppKey
scheme), and application `ak_` keys (AppKey scheme, via AppKeyRepository)."""
from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Callable

import jwt

from app.agent_team.services.app_key_repository import AppKeyRepository
from app.support.logger import error_log

_BEARER = re.compile(r'^Bearer\s+(.+)$', re.I)
_APPKEY = re.compile(r'^AppKey\s+(.+)$', re.I)


def user_app_key_pepper(config: dict, jwt_secret: str) -> str:
    explicit = str((config.get('auth') or {}).get('user_app_key_secret', '') or '')
    if explicit:
        return explicit
    return hmac.new(jwt_secret.encode(), b'user_app_key.v1', hashlib.sha256).hexdigest()


def hash_user_app_key(key: str, pepper: str) -> str:
    return hmac.new(pepper.encode(), key.encode(), hashlib.sha256).hexdigest()


def decode_hs256(token: str, secret: str) -> dict | None:
    """firebase/php-jwt JWT::decode(token, Key(secret,'HS256')) equivalent: verifies
    signature + exp/nbf/iat; returns claims or None."""
    try:
        # verify_sub disabled: gpt-chat's `sub` claim is a numeric user id (int),
        # not the RFC 7519 string PyJWT expects by default.
        return jwt.decode(token, secret, algorithms=['HS256'],
                           options={'require': [], 'verify_sub': False})
    except jwt.PyJWTError:
        return None


class AuthMiddleware:
    def __init__(self, jwt_secret: str, public_routes: list[dict], config: dict, db_factory: Callable):
        self.jwt_secret = jwt_secret
        self.public_routes = public_routes
        self.config = config
        self._db_factory = db_factory
        self._db = None

    def handle(self, ctx):
        is_public = self._is_public_route(ctx['uri'], ctx['method'])
        auth = self._extract_auth(ctx['headers'])
        identity = None
        if auth is not None:
            if auth['scheme'] == 'bearer':
                if auth['token'].startswith('uak_'):
                    uid = self._validate_user_app_key(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'user_app_key'}
                else:
                    uid = self._validate_token(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'jwt'}
            elif auth['scheme'] == 'appkey':
                if auth['token'].startswith('uak_'):
                    uid = self._validate_user_app_key(auth['token'])
                    if uid is not None:
                        identity = {'user_id': uid, 'auth_type': 'user_app_key'}
                else:
                    row = self._validate_app_key(auth['token'])
                    if row is not None:
                        identity = {'user_id': int(row['user_id']), 'auth_type': 'app_key',
                                    'app_key_id': int(row['id']), 'application_id': row['application_id'],
                                    'app_key_scopes': row['scopes']}
        if is_public:
            if identity is not None:
                ctx.update(identity)
            else:
                ctx['user_id'] = None
            ctx['authenticated'] = identity is not None
            return ctx
        if auth is None:
            return self._error(401, 'Authorization token required')
        if identity is None:
            return self._error(401, 'Invalid or expired credential')
        ctx.update(identity)
        ctx['authenticated'] = True
        return ctx

    def _is_public_route(self, uri: str, method: str) -> bool:
        for route in self.public_routes:
            pattern = route['pattern'].replace('*', '.*')
            methods = route.get('methods', ['GET', 'POST', 'PUT', 'DELETE'])
            if re.match(f'^{pattern}$', uri) and method in methods:
                return True
        return False

    @staticmethod
    def _extract_auth(headers) -> dict | None:
        value = headers.get('Authorization') or headers.get('authorization') or ''
        m = _BEARER.match(value)
        if m:
            return {'scheme': 'bearer', 'token': m.group(1).strip()}
        m = _APPKEY.match(value)
        if m:
            return {'scheme': 'appkey', 'token': m.group(1).strip()}
        return None

    def _validate_token(self, token: str) -> int | None:
        claims = decode_hs256(token, self.jwt_secret)
        if claims is None:
            error_log('[AuthMiddleware] JWT validation failed')
            return None
        try:
            return int(claims['sub'])
        except (KeyError, TypeError, ValueError):
            # PHP's (int)$decoded->sub never throws; mirror that by treating a
            # missing/non-numeric sub as "no identity" rather than a 500.
            error_log('[AuthMiddleware] JWT sub claim is missing or non-numeric')
            return None

    def _validate_app_key(self, key: str) -> dict | None:
        try:
            secret = str((self.config.get('auth') or {}).get('app_key_secret', '') or '')
            if secret == '':
                error_log('[AuthMiddleware] app_key_secret is not configured — app keys disabled.')
                return None
            repo = AppKeyRepository(self._get_db(), secret)
            row = repo.findByKey(key)
            if row is not None:
                repo.recordUse(int(row['id']))
            return row
        except Exception as e:  # noqa: BLE001
            error_log(f'[AuthMiddleware] app key validation error: {e}')
            return None

    def _validate_user_app_key(self, key: str) -> int | None:
        try:
            h = hash_user_app_key(key, user_app_key_pepper(self.config, self.jwt_secret))
            row = self._get_db().fetch_one('SELECT id FROM users WHERE app_key_hash = ? LIMIT 1', [h])
            return int(row['id']) if row else None
        except Exception as e:  # noqa: BLE001
            error_log(f'[AuthMiddleware] user app key validation error: {e}')
            return None

    def _get_db(self):
        if self._db is None:
            self._db = self._db_factory()
        return self._db

    @staticmethod
    def _error(status: int, message: str) -> dict:
        return {'error': True, 'status_code': status, 'body': {'success': False, 'message': message}}
