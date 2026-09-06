"""Port of Services/PackageResolver.php."""
from __future__ import annotations

import json

VALID_ROLES = ['guest', 'prospect', 'user', 'admin']


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
        if not row or row.get('role') not in VALID_ROLES:
            return 'guest'
        return str(row['role'])

    def loadPackage(self, role: str) -> dict:
        if role not in VALID_ROLES:
            role = 'guest'
        if role in self._cache:
            return self._cache[role]
        row = self.db.fetch_one('SELECT capabilities, updated_at FROM packages WHERE role = :role LIMIT 1', {':role': role})
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
        self._cache[role] = package
        return package

    @classmethod
    def validRoles(cls) -> list[str]:
        return list(VALID_ROLES)

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
