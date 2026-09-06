"""Port of MiddlewareProcessor.php (PUBLIC_ROUTES verbatim)."""
from __future__ import annotations

from collections.abc import Callable

from app.middleware.auth import AuthMiddleware
from app.middleware.cors import CorsMiddleware
from app.support.http import Ctx

PUBLIC_ROUTES = [
    {'pattern': '/api/v1/auth', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/login', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/register', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/firebase', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/verify', 'methods': ['POST']},
    {'pattern': '/api/v1/auth/logout', 'methods': ['POST']},
    {'pattern': '/api/v1/evi/webhook', 'methods': ['POST']},
    {'pattern': '/api/v1/mcp/app', 'methods': ['GET']},
    {'pattern': '/api/mcp-app.php', 'methods': ['GET']},
    {'pattern': '/api/v1/scheduler/run', 'methods': ['POST']},
    {'pattern': '/api/v1/webauthn/challenge', 'methods': ['POST']},
    {'pattern': '/api/v1/webauthn/authenticate', 'methods': ['POST']},
    {'pattern': '/api/v1/models/catalog', 'methods': ['GET']},
    {'pattern': '/', 'methods': ['GET']},
]


class MiddlewareProcessor:
    def __init__(self, config: dict, db_factory: Callable):
        self.config = config
        self.cors = CorsMiddleware(config.get('cors') or {})
        jwt_secret = str((config.get('auth') or {}).get('jwt_secret', '') or '')
        if jwt_secret == '':
            raise RuntimeError('JWT secret is not configured (set JWT_SECRET).')
        self.auth = AuthMiddleware(jwt_secret, PUBLIC_ROUTES, config, db_factory)

    def process(self, ctx) -> dict:
        cors = self.cors.handle(ctx)
        if cors is not None:
            return {'handled': True, 'response': cors}
        result = self.auth.handle(ctx)
        if not isinstance(result, Ctx):
            return {'handled': True, 'response': result}
        return {'handled': False, 'request': result}
