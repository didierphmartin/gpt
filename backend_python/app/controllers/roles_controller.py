"""Port of Controllers/RolesController.php.

Admin API for roles (capabilities are still edited through /admin/packages/{role}).

  GET    /api/v1/admin/roles
  POST   /api/v1/admin/roles            {role, name, copy_from?}
  PUT    /api/v1/admin/roles/{role}     {name}
  DELETE /api/v1/admin/roles/{role}

Every action checks the admin role (RequiresAdmin).
"""
from __future__ import annotations

from app.controllers.requires_admin import require_admin
from app.services.role_store import RoleStore, RoleStoreError


class RolesController:
    # main.py passes path params positionally too (`fn(ctx, *params)`); the key is
    # read from request['params'] as in PHP, so the positional copy is accepted and ignored.
    def __init__(self, db, config: dict):
        self.db = db
        self.store = RoleStore(db)

    def index(self, request: dict) -> dict:
        return self._guard(request, lambda: {'success': True, 'data': self.store.list()})

    def create(self, request: dict) -> dict:
        def action():
            b = request.get('body') or {}
            copy = b.get('copy_from')
            return {'success': True, 'data': self.store.create(
                self._str(b.get('role')), self._str(b.get('name')), copy if isinstance(copy, str) else None)}
        return self._guard(request, action)

    def rename(self, request: dict, role=None) -> dict:
        return self._guard(request, lambda: {'success': True, 'data': self.store.rename(
            self._key(request), self._str((request.get('body') or {}).get('name')))})

    def destroy(self, request: dict, role=None) -> dict:
        def action():
            self.store.delete(self._key(request))
            return {'success': True}
        return self._guard(request, action)

    @staticmethod
    def _str(v) -> str:
        return '' if v is None else str(v)

    @classmethod
    def _key(cls, request: dict) -> str:
        return cls._str((request.get('params') or {}).get('role'))

    def _guard(self, request: dict, action) -> dict:
        err = require_admin(self.db, request)
        if err:
            return err
        try:
            return action()
        except RoleStoreError as e:
            return {'success': False, 'error': str(e), 'kind': e.kind, 'status_code': e.status}
