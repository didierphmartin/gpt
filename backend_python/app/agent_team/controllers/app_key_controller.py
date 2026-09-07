"""Port of backend/src/AgentTeam/Controllers/AppKeyController.php.

App Key Controller

Manages app keys — scoped, revocable credentials for client code that
calls the backend without a user's login JWT.

Endpoints:
    POST   /api/v1/app-keys           create  (admin only)
    GET    /api/v1/app-keys           index   (admin only)
    DELETE /api/v1/app-keys/{id}      destroy (admin only)
    GET    /api/v1/app-keys/whoami    whoami  (app-key auth — introspection)

CRUD is admin-only: only a user with role='admin' may mint, list, or
revoke keys. `whoami` is the lone endpoint an app key itself may call —
it lets client code confirm what its key authorizes.
"""
from __future__ import annotations

import re

from app.agent_team.services.app_key_repository import AppKeyRepository
from app.support.phpcompat import php_intval, php_strval, php_trim


class AppKeyController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.repo = AppKeyRepository(db, str((config.get('auth') or {}).get('app_key_secret', '') or ''))

    def create(self, request) -> dict:
        """POST /api/v1/app-keys. Body: { user_id, application_id, name, scopes: string[] }."""
        err = self._require_admin(request)
        if err:
            return err

        body = request.get('body') or {}
        userId = php_intval(body['user_id']) if body.get('user_id') is not None else 0
        applicationId = php_trim(body.get('application_id'))
        name = php_trim(body.get('name'))
        scopes = body.get('scopes')

        if userId <= 0:
            return self._err('user_id is required', 400)
        if applicationId == '':
            return self._err('application_id is required', 400)
        if name == '':
            return self._err('name is required', 400)
        if not isinstance(scopes, (list, dict)) or len(scopes) == 0:
            return self._err('scopes must be a non-empty array of strings', 400)
        scope_values = list(scopes.values()) if isinstance(scopes, dict) else scopes
        for s in scope_values:
            if not isinstance(s, str) or php_trim(s) == '':
                return self._err('every scope must be a non-empty string', 400)

        # The user the key acts for must exist.
        row = self.db.fetch_one('SELECT id FROM users WHERE id = ? LIMIT 1', [userId])
        if not row:
            return self._err(f'user_id {userId} does not exist', 400)

        created = self.repo.create(userId, applicationId, name, [php_trim(s) for s in scope_values])

        return {
            'success': True,
            'data': created,   # includes full_key — visible ONCE
            'status_code': 201,
        }

    def index(self, request) -> dict:
        """GET /api/v1/app-keys[?application_id=&user_id=]."""
        err = self._require_admin(request)
        if err:
            return err

        query = request.get('query') or {}
        applicationId = str(query['application_id']) if query.get('application_id') not in (None, '') else None
        userId = php_intval(query['user_id']) if query.get('user_id') not in (None, '') else None

        return {
            'success': True,
            'data': self.repo.listAll(applicationId, userId),
            'status_code': 200,
        }

    def destroy(self, request, id: int = 0) -> dict:
        """DELETE /api/v1/app-keys/{id}."""
        err = self._require_admin(request)
        if err:
            return err

        keyId = php_intval(id)
        if keyId <= 0:
            return self._err('Invalid key id', 400)
        if not self.repo.findById(keyId):
            return self._err('App key not found', 404)

        revoked = self.repo.revoke(keyId)
        return {
            'success': True,
            'data': {'id': keyId, 'revoked': revoked},
            'status_code': 200,
        }

    def listUserWorkflows(self, request) -> dict:
        """GET /api/v1/app-keys/workflows?user_id=N.

        Admin-only. Lists a given user's workflows (id + name) so the admin
        UI can offer a pick-by-name workflow selector when minting a key —
        the admin never has to know or type a raw workflow id. Each picked
        workflow becomes a `workflows:run:<id>` scope.
        """
        err = self._require_admin(request)
        if err:
            return err
        userId = php_intval((request.get('query') or {}).get('user_id', 0))
        if userId <= 0:
            return self._err('user_id query parameter is required', 400)
        rows = self.db.fetch_all(
            'SELECT id, name FROM agent_workflows WHERE user_id = ? ORDER BY name ASC', [userId])
        return {
            'success': True,
            'data': [{'id': php_intval(r['id']), 'name': php_strval(r['name'])} for r in rows],
            'status_code': 200,
        }

    def listUserAgents(self, request) -> dict:
        """GET /api/v1/app-keys/agents?user_id=N.

        Admin-only. Lists a given user's agents (id + name) so the admin UI
        can offer a pick-by-name agent selector when minting a key. Each
        picked agent becomes an `agents:run:<id>` scope.
        """
        err = self._require_admin(request)
        if err:
            return err
        userId = php_intval((request.get('query') or {}).get('user_id', 0))
        if userId <= 0:
            return self._err('user_id query parameter is required', 400)
        rows = self.db.fetch_all(
            'SELECT id, name FROM agents WHERE user_id = ? ORDER BY name ASC', [userId])
        return {
            'success': True,
            'data': [{'id': php_intval(r['id']), 'name': php_strval(r['name'])} for r in rows],
            'status_code': 200,
        }

    def whoami(self, request) -> dict:
        """GET /api/v1/app-keys/whoami. App-key-authed. Lets client code introspect its own key.

        No user info. Besides the raw scopes, this resolves the human-readable names of the
        workflows/agents the key is scoped to (`workflows`/`agents` arrays of
        {id, name}). That lets a client address a workflow by name instead of
        hard-coding a numeric id — it looks the name up here, then calls
        /workflows/{id}/run with the resolved id. Revealing names the key is
        already authorized for leaks nothing new.
        """
        if request.get('auth_type') != 'app_key':
            return self._err('This endpoint requires app-key authentication', 401)

        scopes = request.get('app_key_scopes') or []

        # Pull the resource ids out of `workflows:run:<id>` / `agents:run:<id>`.
        workflowIds: list[int] = []
        agentIds: list[int] = []
        for scope in scopes:
            m = re.match(r'^workflows:run:(\d+)$', str(scope))
            if m:
                workflowIds.append(int(m.group(1)))
                continue
            m = re.match(r'^agents:run:(\d+)$', str(scope))
            if m:
                agentIds.append(int(m.group(1)))

        return {
            'success': True,
            'data': {
                'application_id': request.get('application_id'),
                'scopes': scopes,
                'workflows': self._resolve_names('agent_workflows', workflowIds),
                'agents': self._resolve_names('agents', agentIds),
            },
            'status_code': 200,
        }

    def _resolve_names(self, table: str, ids: list) -> list:
        """Resolve a set of resource ids to [{id, name}], skipping any that no
        longer exist. `table` is a trusted internal literal, never user input."""
        ids = list(dict.fromkeys(i for i in ids if i > 0))
        if not ids:
            return []
        placeholders = ','.join(['?'] * len(ids))
        rows = self.db.fetch_all(
            f'SELECT id, name FROM {table} WHERE id IN ({placeholders}) ORDER BY name ASC', ids)
        return [{'id': php_intval(r['id']), 'name': php_strval(r['name'])} for r in rows]

    def _require_admin(self, request) -> dict | None:
        """Gate: caller must be a logged-in user with role='admin'.
        Mirrors SystemSettingsController::requireAdmin()."""
        # App keys can never reach the admin CRUD — only JWT users can.
        if request.get('auth_type') == 'app_key':
            return self._err('App keys cannot manage app keys', 403)
        userId = request.get('user_id')
        if not userId:
            return self._err('Authentication required', 401)
        user = self.db.fetch_one('SELECT role FROM users WHERE id = :user_id', {':user_id': userId})
        if not user or user['role'] != 'admin':
            return self._err('Admin access required', 403)
        return None

    @staticmethod
    def _err(message: str, code: int) -> dict:
        return {'success': False, 'error': message, 'status_code': code}
