"""Port of Services/RoleStore.php and RoleStoreError.php.

The roles of an installation: one `packages` row per role (key, display name,
capabilities). Built-in roles cannot be deleted; custom roles can while no person holds them.
"""
from __future__ import annotations

import json
import re

from app.support.phpcompat import php_bool, php_trim, ucfirst
from app.support.phpjson import dumps


class RoleStoreError(RuntimeError):
    """RoleStoreError.php: a refused role operation: kind (invalid_key, invalid_name,
    exists, not_found, builtin, in_use) and its HTTP status."""

    def __init__(self, kind: str, message: str, status: int):
        super().__init__(message)
        self.kind = kind
        self.status = status


class RoleStore:
    BUILTIN = ['guest', 'prospect', 'user', 'admin', 'robot']
    KEY_RE = re.compile(r'[a-z0-9]+(-[a-z0-9]+)*')
    KEY_MAX = 64
    NAME_MAX = 100

    def __init__(self, db):
        self.db = db

    @staticmethod
    def isValidKey(key: str) -> bool:
        return len(key) <= RoleStore.KEY_MAX and RoleStore.KEY_RE.fullmatch(key) is not None

    def list(self) -> list:
        """Every role, built-ins first (in BUILTIN order), then custom roles by name."""
        rows = self.db.fetch_all('SELECT role, name, builtin, capabilities FROM packages')
        # A built-in role with no row yet (fresh install) is still a role, with no capabilities.
        have = [r['role'] for r in rows]
        rows += [self._missing_builtin(key) for key in self.BUILTIN if key not in have]
        return sorted((self._shape(r) for r in rows), key=self._order)

    def get(self, key: str):
        row = self.db.fetch_one('SELECT role, name, builtin, capabilities FROM packages WHERE role = ?', [key])
        if not row and key in self.BUILTIN:
            row = self._missing_builtin(key)
        return self._shape(row) if row else None

    def exists(self, key: str) -> bool:
        """A role exists when it has a row, or is built-in (a fresh install has no rows yet)."""
        return key in self.BUILTIN or self._has_row(key)

    def create(self, key: str, name: str, copyFrom) -> dict:
        if not self.isValidKey(key):
            raise RoleStoreError('invalid_key', 'Role key: lowercase letters and digits, words separated by single '
                                 f'dashes, at most {self.KEY_MAX} characters', 422)
        name = self._clean_name(name)
        if self.exists(key):
            raise RoleStoreError('exists', f"Role '{key}' already exists", 409)
        caps = '{"providers":{},"sidebar":{}}'
        if copyFrom is not None and copyFrom != '':
            src = self.get(copyFrom)
            if src is None:
                raise RoleStoreError('not_found', f"Role '{copyFrom}' not found", 404)
            caps = dumps(src['capabilities'])
        self.db.execute('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)', [key, name, caps])
        return self.get(key)

    def rename(self, key: str, name: str) -> dict:
        name = self._clean_name(name)
        if not self.exists(key):
            raise RoleStoreError('not_found', f"Role '{key}' not found", 404)
        if self._has_row(key):
            self.db.execute('UPDATE packages SET name = ? WHERE role = ?', [name, key])
        else:
            self.db.execute('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)',
                            [key, name, '{}'])
        return self.get(key)

    def delete(self, key: str) -> None:
        row = self.get(key)
        if row is None:
            raise RoleStoreError('not_found', f"Role '{key}' not found", 404)
        if row['builtin'] or key in self.BUILTIN:
            raise RoleStoreError('builtin', "Built-in roles can't be deleted", 409)
        holders = self.usersWith(key)
        if holders:
            emails = ', '.join(h['email'] for h in holders)
            raise RoleStoreError('in_use', f"Role '{key}' is held by: {emails}", 409)
        self.db.execute('DELETE FROM packages WHERE role = ?', [key])

    def usersWith(self, key: str) -> list:
        """The people (not the robot) holding the role: [{id, email}]."""
        rows = self.db.fetch_all("SELECT id, email FROM users WHERE role = ? AND kind = 'person' ORDER BY id", [key])
        return [{'id': int(r['id']), 'email': str(r['email'])} for r in rows]

    def _has_row(self, key: str) -> bool:
        return self.db.fetch_one('SELECT 1 FROM packages WHERE role = ?', [key]) is not None

    def _clean_name(self, name: str) -> str:
        name = php_trim(name)
        if name == '' or len(name) > self.NAME_MAX:
            raise RoleStoreError('invalid_name', f'Role name is required (at most {self.NAME_MAX} characters)', 422)
        return name

    @staticmethod
    def _missing_builtin(key: str) -> dict:
        return {'role': key, 'name': None, 'builtin': 1, 'capabilities': '{}'}

    def _order(self, r: dict) -> tuple:
        if r['role'] in self.BUILTIN:
            return (0, self.BUILTIN.index(r['role']), '', '')
        return (1, 0 if r['builtin'] else 1, r['name'], r['role'])

    def _shape(self, r: dict) -> dict:
        key = str(r['role'])
        try:
            caps = json.loads(str(r['capabilities']))
        except ValueError:
            caps = None
        name = php_trim(str(r.get('name') or ''))
        return {
            'role': key,
            'name': name if name != '' else ucfirst(key),
            'builtin': php_bool(r.get('builtin')) or key in self.BUILTIN,
            'capabilities': caps if isinstance(caps, (dict, list)) else [],
            'used_by': len(self.usersWith(key)),
        }
