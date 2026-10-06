"""Port of Services/PackageResolver.php."""
from __future__ import annotations

import json

from app.services.role_store import RoleStore


class PackageResolver:
    def __init__(self, db):
        self.db = db
        self._cache: dict[str, dict] = {}

    def resolveForUser(self, user_id: int | None) -> dict:
        return self.loadPackage(self.resolveRole(user_id))

    def resolveRole(self, user_id: int | None) -> str:
        if user_id is None:
            return 'guest'
        row = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': user_id})
        if not row or not RoleStore(self.db).exists(str(row.get('role'))):
            return 'guest'
        return str(row['role'])

    def loadPackage(self, role: str) -> dict:
        if role in self._cache:
            return self._cache[role]
        requested = role
        row = self._package_row(role)
        if not row and role != 'guest' and role not in RoleStore.BUILTIN:
            # An unknown role resolves to the guest package.
            role = 'guest'
            row = self._package_row(role)
        if not row:
            capabilities = {'providers': [], 'mcp_servers': None, 'skills': None, 'sidebar': [],
                            'quota_tokens': None, 'voice': False, 'avatar': False}
            updated_at = None
        else:
            try:
                decoded = json.loads(str(row['capabilities']))
            except ValueError:
                decoded = None
            capabilities = decoded if isinstance(decoded, (dict, list)) else []
            updated_at = row['updated_at']
        package = {'role': role, 'capabilities': capabilities, 'updated_at': updated_at}
        self._cache[requested] = package
        return package

    def _package_row(self, role: str):
        return self.db.fetch_one('SELECT capabilities, updated_at FROM packages WHERE role = :role LIMIT 1', {':role': role})

    def validRoles(self) -> list[str]:
        """The keys of every role (built-in and custom)."""
        return [r['role'] for r in RoleStore(self.db).list()]

    def allowedMcpServers(self, user_id: int | None) -> list[str] | None:
        capabilities = self.resolveForUser(user_id).get('capabilities') or {}
        lst = capabilities.get('mcp_servers') if isinstance(capabilities, dict) else None
        if lst is None:
            return None
        if isinstance(lst, dict):
            return [s for s in lst.values() if isinstance(s, str)]
        if isinstance(lst, list):
            return [s for s in lst if isinstance(s, str)]
        return []
