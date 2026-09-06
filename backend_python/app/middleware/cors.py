"""Port of CorsMiddleware.php. Headers are applied to EVERY response by main.py."""
from __future__ import annotations


class CorsMiddleware:
    def __init__(self, config: dict | None = None):
        config = config or {}
        self.allowed_origins = config.get('allowed_origins', ['*'])
        self.allowed_methods = config.get('allowed_methods', ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
        self.allowed_headers = config.get('allowed_headers', ['Content-Type', 'Authorization'])

    def handle(self, ctx) -> dict | None:
        if ctx['method'] == 'OPTIONS':
            return {'status_code': 204, 'headers': {}, 'body': ''}
        return None

    def headers(self, request_origin: str = '') -> dict:
        return {
            'Access-Control-Allow-Origin': self._origin(request_origin),
            'Access-Control-Allow-Methods': ', '.join(self.allowed_methods),
            'Access-Control-Allow-Headers': ', '.join(self.allowed_headers),
        }

    def _origin(self, request_origin: str) -> str:
        if '*' in self.allowed_origins:
            return '*'
        if request_origin in self.allowed_origins:
            return request_origin
        return self.allowed_origins[0] if self.allowed_origins else '*'
