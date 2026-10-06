"""Port of Services/RobotAccount.php.

The one robot service user of an installation (it owns published playbooks and
runs unattended work) and its built-in `robot` role. Never signs in: no password.
"""
from __future__ import annotations


class RobotAccount:
    EMAIL = 'robot@synergyai.invalid'
    NAME = 'SynergyAI Operations'
    ROLE = 'robot'

    @classmethod
    def ensure(cls, db) -> int:
        """The robot's user id, creating its role row and the user when missing."""
        existing = cls.id(db)
        if existing is not None:
            return existing
        cls._ensure_role(db)
        first, last = cls.NAME.split(' ', 1)
        return int(db.insert(
            "INSERT INTO users (email, first_name, last_name, password, provider, role, kind, email_verified)"
            " VALUES (?, ?, ?, NULL, 'email', ?, 'service', 1)",
            [cls.EMAIL, first, last, cls.ROLE]))

    @staticmethod
    def id(db) -> int | None:
        """The robot's user id, or None when it does not exist yet."""
        row = db.fetch_one("SELECT id FROM users WHERE kind = 'service' ORDER BY id LIMIT 1")
        return None if row is None else int(row['id'])

    @classmethod
    def _ensure_role(cls, db) -> None:
        if db.fetch_one('SELECT 1 FROM packages WHERE role = ?', [cls.ROLE]) is not None:
            return
        copy = db.fetch_one('SELECT capabilities FROM packages WHERE role = ?', ['user'])
        db.execute('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)',
                   [cls.ROLE, 'Robot', '{}' if copy is None else str(copy['capabilities'])])
