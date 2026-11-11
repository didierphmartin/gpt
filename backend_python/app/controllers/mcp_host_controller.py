"""Port of Controllers/McpHostController.php.

/api/v1/mcp/host — relays signed-in users to the Docker app's server supervisor. A server is its installer's;
admins may act on any. In the corporate edition only admins install; in the individual edition the container is
the user's, so anyone signed in may. The supervisor's status and body pass through unchanged, except 503 (unreachable) and the
log tail, which only the owner (or an admin) sees. The token and request bodies are never logged or returned.
"""
from __future__ import annotations

import os
import re
from typing import Callable

from app.controllers.requires_admin import require_admin
from app.services import edition
from app.services.mcp_host_client import McpHostClient
from app.support.phpcompat import php_intval

_SAFE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*\Z')


class McpHostController:
    def __init__(self, db, config: dict, clientFactory: Callable[[], McpHostClient] | None = None):
        self.db = db
        self.config = config
        self.clientFactory = clientFactory or (
            lambda: McpHostClient(os.environ.get('MCPS_URL', ''), os.environ.get('MCPS_TOKEN', '')))

    @staticmethod
    def _available() -> bool:
        return os.environ.get('MCPS_URL', '') not in ('', '0')

    def info(self, request: dict) -> dict:
        if not self._available():
            return {'success': True, 'data': {'available': False}}
        return {'success': True, 'data': {'available': True, 'gateway': os.environ.get('MCPS_PUBLIC_GATEWAY', '')}}

    def list(self, request: dict) -> dict:
        if not self._available():
            return self._none()
        r = self._client().request('GET', '/servers')
        if r['status'] != 200:
            return self._out(r)
        admin = self._isAdmin(request)
        uid = php_intval(request.get('user_id'))
        rows = []
        body = r['body']
        for s in (body.values() if isinstance(body, dict) else body):
            if isinstance(s, dict) and not admin and php_intval(s.get('installed_by') or 0) != uid:
                s = {k: v for k, v in s.items() if k != 'log'}
            rows.append(s)
        return {'success': True, 'data': rows, 'status_code': 200}

    def install(self, request: dict, folder=None) -> dict:
        if not self._available():
            return self._none()
        folder = self._raw(request, folder)
        if not self._safe(folder):
            return self._bad()
        if edition.is_corporate(self.config) and not self._isAdmin(request):
            e = 'Only an admin can install MCP servers here.'
            return {'success': False, 'data': {'error': e}, 'error': e, 'status_code': 403}
        body = request.get('body')
        body = dict(body) if isinstance(body, dict) else {}
        body['installed_by'] = php_intval(request.get('user_id'))
        return self._out(self._client().request('POST', f'/servers/{folder}/install', body))

    def restart(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'POST', 'restart', False)

    def enabled(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'POST', 'enabled', True)

    def getSettings(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'GET', 'settings', False)

    def putSettings(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'PUT', 'settings', True)

    def putSchema(self, request: dict, folder=None) -> dict:
        """Replace the server's settings list (its manifest's env)."""
        return self._owned(request, folder, 'PUT', 'schema', True)

    def source(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'GET', 'source', False)

    def delete(self, request: dict, folder=None) -> dict:
        return self._owned(request, folder, 'DELETE', '', False)

    def _owned(self, request: dict, folder, method: str, sub: str, withBody: bool) -> dict:
        """Owner-or-admin gate (from the supervisor's own list), then the relayed call."""
        if not self._available():
            return self._none()
        folder = self._raw(request, folder)
        if not self._safe(folder):
            return self._bad()
        lst = self._client().request('GET', '/servers')
        if lst['status'] != 200:
            return self._out(lst)
        found = None
        body = lst['body']
        for s in (body.values() if isinstance(body, dict) else body):
            if isinstance(s, dict) and s.get('folder') == folder:
                found = s
                break
        if found is None:
            return {'success': False, 'data': {'error': 'not found'}, 'error': 'not found', 'status_code': 404}
        if php_intval(found.get('installed_by') or 0) != php_intval(request.get('user_id')) and not self._isAdmin(request):
            return {'success': False, 'data': {'error': 'forbidden'}, 'error': 'forbidden', 'status_code': 403}
        path = f'/servers/{folder}' + ('' if sub == '' else f'/{sub}')
        payload = None
        if withBody:
            b = request.get('body')
            payload = b if isinstance(b, (dict, list)) and len(b) > 0 else []   # PHP (array) of nothing encodes []
        return self._out(self._client().request(method, path, payload))

    def _client(self) -> McpHostClient:
        return self.clientFactory()

    def _isAdmin(self, request: dict) -> bool:
        return require_admin(self.db, request) is None

    @staticmethod
    def _raw(request: dict, folder) -> str:
        """main.py casts numeric-looking params ("007" -> 7); the raw segment is in request['params']."""
        params = request.get('params') or {}
        v = params.get('folder')
        return str(v if v is not None else ('' if folder is None else folder))

    @staticmethod
    def _safe(folder: str) -> bool:
        """Same shape the supervisor enforces: no leading dot, no separators."""
        return bool(_SAFE.match(folder))

    @staticmethod
    def _bad() -> dict:
        return {'success': False, 'data': {'error': 'bad folder'}, 'error': 'bad folder', 'status_code': 400}

    @staticmethod
    def _none() -> dict:
        return {'success': False, 'data': {'error': 'no server host'}, 'error': 'no server host', 'status_code': 404}

    @staticmethod
    def _out(r: dict) -> dict:
        if r['status'] == 503:
            e = 'The server host is not reachable'
            return {'success': False, 'data': {'error': e}, 'error': e, 'status_code': 503}
        ok = r['status'] < 400
        out = {'success': ok, 'data': r['body'], 'status_code': r['status']}
        if not ok:
            b = r['body']
            out['error'] = str(b.get('error', 'error')) if isinstance(b, dict) and b.get('error') is not None else 'error'
        return out
