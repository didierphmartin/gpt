"""Port of backend/src/Controllers/SetupController.php.

First-run setup of a corporate install: creates the administrator, once.

Both endpoints are public -- before setup there is nobody to authenticate. createAdmin is safe to expose because it
refuses as soon as any gpt user exists (any role -- "no admin" is not enough, or removing the last admin would reopen
setup to anyone), and it re-checks under a MySQL named lock so two simultaneous submissions cannot both pass the check.
"""
from __future__ import annotations

from app.controllers.auth_controller import password_hash
from app.services import edition
from app.services.login_accounts import LoginAccounts
from app.support.logger import error_log
from app.support.phpcompat import php_intval, php_strval, php_trim, validate_email

_NOT_GIVEN = object()


class SetupController:
    MIN_PASSWORD = 10

    def __init__(self, db, config: dict, accounts=_NOT_GIVEN):
        self.db = db
        self.config = config
        self.accountsInjected = accounts is not _NOT_GIVEN
        self.accounts = None if accounts is _NOT_GIVEN else accounts

    def status(self, request: dict) -> dict:
        return {'success': True, 'edition': edition.current(self.config), 'needs_setup': self._needsSetup()}

    def createAdmin(self, request: dict) -> dict:
        if not edition.is_corporate(self.config):
            return self._fail('Setup is only available in the corporate edition', 404)

        body = request.get('body')
        body = body if isinstance(body, dict) else {}
        email = php_trim(php_strval(body.get('email') if body.get('email') is not None else '')).lower()
        password = php_strval(body.get('password') if body.get('password') is not None else '')
        firstName = php_trim(php_strval(body.get('first_name') if body.get('first_name') is not None else ''))
        lastName = php_trim(php_strval(body.get('last_name') if body.get('last_name') is not None else ''))

        if not validate_email(email):
            return self._fail('Enter a valid email address', 400)
        if len(password.encode('utf-8')) < self.MIN_PASSWORD:
            return self._fail(f'The password must be at least {self.MIN_PASSWORD} characters', 400)

        try:
            accounts = self._accounts()
        except Exception:  # noqa: BLE001 -- PHP catch (\Throwable)
            return self._fail('The login service database is not reachable', 503)
        if accounts is None:
            return self._fail('The login service is not configured', 503)

        if not self.lock():
            return self._fail('Setup is busy, please try again', 503)
        try:
            if not self._needsSetup():
                return self._fail('Setup is already complete', 409)
            accounts.upsertVerified(email, password_hash(password), firstName, lastName)
            self._upsertGptAdmin(email, firstName, lastName)
        except Exception as e:  # noqa: BLE001
            error_log('[setup] createAdmin failed: ' + str(e))
            return self._fail('Could not create the administrator account', 500)
        finally:
            self.unlock()

        return {'success': True, 'message': 'Administrator account created', 'email': email, 'status_code': 201}

    def _needsSetup(self) -> bool:
        if not edition.is_corporate(self.config):
            return False
        try:
            # People only: the robot service user exists from the first boot.
            return php_intval(self.db.fetch_column("SELECT COUNT(*) FROM users WHERE kind = 'person'")[0]) == 0
        except Exception:  # noqa: BLE001 -- PHP catch (\PDOException): a database not migrated to carry `kind` yet
            return php_intval(self.db.fetch_column('SELECT COUNT(*) FROM users')[0]) == 0

    def _accounts(self):
        if not self.accountsInjected:
            self.accounts = LoginAccounts.fromConfig(self.config)
            self.accountsInjected = True
        return self.accounts

    def _upsertGptAdmin(self, email: str, firstName: str, lastName: str) -> None:
        """gpt holds the role, never a password: the login service is the credential store."""
        if self.db.fetch_column('SELECT id FROM users WHERE email = ?', [email]):
            self.db.execute("UPDATE users SET role = 'admin', password = NULL, email_verified = 1,\n"
                            "                updated_at = CURRENT_TIMESTAMP WHERE email = ?", [email])
            return
        self.db.execute("INSERT INTO users (email, password, first_name, last_name, role, plan, provider,\n"
                        "            email_verified, created_at, updated_at)\n"
                        "            VALUES (?, NULL, ?, ?, 'admin', 'free', 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                        [email, firstName, lastName])

    def _isMysql(self) -> bool:
        from app.db import Db
        return isinstance(self.db, Db)

    def lock(self) -> bool:
        """True when the lock is held. GET_LOCK returns 1 on success, 0 on timeout, NULL on error."""
        if not self._isMysql():
            return True
        col = self.db.fetch_column("SELECT GET_LOCK('gpt_corporate_setup', 10)")
        return php_strval(col[0] if col else None) == '1'

    def unlock(self) -> None:
        if self._isMysql():
            self.db.fetch_column("SELECT RELEASE_LOCK('gpt_corporate_setup')")

    @staticmethod
    def _fail(message: str, status: int) -> dict:
        return {'success': False, 'message': message, 'status_code': status}
