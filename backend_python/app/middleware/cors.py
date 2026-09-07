"""Port of CorsMiddleware.php. Headers are applied to EVERY response by main.py.

Deviation from PHP (parity tracker): PHP is served same-origin with the frontend, so
its literal `Access-Control-Allow-Origin: *` is never exercised by a browser. The
Python backend runs cross-origin in development (frontend on http://localhost, API on
http://localhost:3002) and the frontend sends `credentials: 'include'`; browsers reject
a wildcard origin for credentialed requests. So when a request carries an `Origin`
header and that origin is allowed, we echo it back and add
`Access-Control-Allow-Credentials: true` + `Vary: Origin`. Requests without an `Origin`
header (same-origin, curl, the PHP-parity differential) get PHP's exact headers.

`CORS_ALLOWED_ORIGINS` (comma-separated) restricts which origins are echoed; unset means
every origin is echoed (the deployment is LAN-only behind authentication).
"""
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
        headers = {
            'Access-Control-Allow-Origin': self._origin(request_origin),
            'Access-Control-Allow-Methods': ', '.join(self.allowed_methods),
            'Access-Control-Allow-Headers': ', '.join(self.allowed_headers),
        }
        if request_origin and self._is_allowed(request_origin):
            headers['Access-Control-Allow-Credentials'] = 'true'
            headers['Vary'] = 'Origin'
        return headers

    def _is_allowed(self, request_origin: str) -> bool:
        return '*' in self.allowed_origins or request_origin in self.allowed_origins

    def _origin(self, request_origin: str) -> str:
        # PHP: getAllowedOriginHeader() — kept verbatim for requests without an Origin.
        if request_origin and self._is_allowed(request_origin):
            return request_origin
        if '*' in self.allowed_origins:
            return '*'
        if request_origin in self.allowed_origins:
            return request_origin
        return self.allowed_origins[0] if self.allowed_origins else '*'
