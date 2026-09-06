"""Port of Controllers/PackageController.php."""
from __future__ import annotations

import json

from app.services.package_resolver import PackageResolver
from app.support.phpcompat import is_numeric


class PackageController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.resolver = PackageResolver(db)

    def me(self, request) -> dict:
        uid = request.get('user_id')
        package = self.resolver.resolveForUser(int(uid) if is_numeric(uid) else None)
        return {'success': True, 'role': package['role'], 'capabilities': package['capabilities'],
                'updated_at': package['updated_at']}

    def adminList(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        return {'success': True, 'packages': [self.resolver.loadPackage(r) for r in PackageResolver.validRoles()]}

    def adminGet(self, request, role: str) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        if role not in PackageResolver.validRoles():
            return {'success': False, 'error': 'Invalid role', 'status_code': 400}
        return {'success': True, 'package': self.resolver.loadPackage(role)}

    def adminUpdate(self, request, role: str) -> dict:
        err = self._require_admin(request)
        if err:
            return err
        if role not in PackageResolver.validRoles():
            return {'success': False, 'error': 'Invalid role', 'status_code': 400}
        caps = (request.get('body') or {}).get('capabilities')
        if not isinstance(caps, (dict, list)):
            return {'success': False, 'error': 'capabilities object is required', 'status_code': 400}
        v = self._validate_capabilities(caps)
        if v is not None:
            return {'success': False, 'error': v, 'status_code': 400}
        encoded = json.dumps(caps, ensure_ascii=False, separators=(',', ':'))
        admin_id = int(request['user_id']) if is_numeric(request.get('user_id')) else None
        self.db.execute(
            'INSERT INTO packages (role, capabilities, updated_by) VALUES (:role, :caps, :uid)'
            ' ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)',
            {':role': role, ':caps': encoded, ':uid': admin_id})
        self.resolver = PackageResolver(self.db)   # PHP re-reads because loadPackage cache is per request
        return {'success': True, 'package': self.resolver.loadPackage(role)}

    def _require_admin(self, request) -> dict | None:
        uid = request.get('user_id')
        if not uid:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        user = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': uid})
        if not user or (user.get('role') or '') != 'admin':
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}
        return None

    @staticmethod
    def _validate_capabilities(caps) -> str | None:
        if isinstance(caps, list):
            caps = {}   # PHP array with no keys: required keys missing → first error below
        for required in ('providers', 'sidebar'):
            if required not in caps or not isinstance(caps[required], (dict, list)):
                return f'capabilities.{required} must be an object'
        for optional in ('mcp_servers', 'skills'):
            if optional in caps and caps[optional] is not None and not isinstance(caps[optional], (dict, list)):
                return f'capabilities.{optional} must be null or an array'
        if 'quota_tokens' in caps and caps['quota_tokens'] is not None and \
                (isinstance(caps['quota_tokens'], bool) or not isinstance(caps['quota_tokens'], int)):
            return 'capabilities.quota_tokens must be null or an integer'
        return None
