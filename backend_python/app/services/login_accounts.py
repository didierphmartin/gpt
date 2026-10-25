"""Port of backend/src/Services/LoginAccounts.php.

The login service's users table, written directly by gpt on a corporate install: gpt_admin creates every
account, so gpt must create the login row (the credential) alongside its own row (the role). Emails are lowercased.
"""
from __future__ import annotations

from app.support.phpcompat import php_empty, php_trim


class LoginAccounts:
    def __init__(self, db):
        self.db = db

    @classmethod
    def fromConfig(cls, config: dict) -> 'LoginAccounts | None':
        """None when the login DB is not configured; raises when it is configured but not reachable."""
        ld = config.get('login_db') or {}
        if php_empty(ld.get('database')) or php_empty(ld.get('username')):
            return None
        from app.db import Db
        return cls(Db.connect({'host': ld.get('host') or '', 'database': ld['database'], 'username': ld['username'],
                               'password': ld.get('password') or '', 'charset': 'utf8mb4'}, timeout=5))

    def upsertVerified(self, email: str, passwordHash: str, firstName: str, lastName: str) -> None:
        """Create the account, or -- when a row already exists (a setup retried after a partial failure) --
        overwrite its password and mark it verified. gpt's sso_exchange refuses unverified accounts."""
        email = php_trim(email).lower()
        if self.db.fetch_column('SELECT id FROM users WHERE email = ?', [email]):
            self.db.execute('UPDATE users SET password = ?, first_name = ?, last_name = ?,\n'
                            '                email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
                            [passwordHash, firstName, lastName, email])
            return
        self.db.execute("INSERT INTO users (email, password, first_name, last_name, provider,\n"
                        "            email_verified, created_at, updated_at)\n"
                        "            VALUES (?, ?, ?, ?, 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                        [email, passwordHash, firstName, lastName])

    def exists(self, email: str) -> bool:
        return bool(self.db.fetch_column('SELECT 1 FROM users WHERE email = ?', [php_trim(email).lower()]))

    def setPassword(self, email: str, passwordHash: str) -> None:
        self.db.execute('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
                        [passwordHash, php_trim(email).lower()])

    def delete(self, email: str) -> None:
        self.db.execute('DELETE FROM users WHERE email = ?', [php_trim(email).lower()])
