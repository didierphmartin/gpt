"""Port of Controllers/LoginAdminController.php.

Login microservice admin controller (gpt_admin "Login" card).

Manages the shared login DB (netfo587_login). Reads + non-secret edits run
here directly (gpt/backend holds the login-DB credentials). Secret operations
(app-key mint, password-reset email) are brokered to the login service in a
later phase. Admin-gated; an admin cannot delete or de-admin their OWN login
account (matched by email against the gpt admin identity).

Phase 1: Overview stats + Users CRUD.
"""
from __future__ import annotations

from app.db import Db
from app.support.db_cleanup import close_db, close_secondary_connections as _cleanup
from app.support.logger import error_log
from app.support.phpcompat import (
    is_numeric,
    php_coalesce,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
    validate_email,
)


class LoginAdminController:
    ROLES = ['guest', 'prospect', 'user', 'admin', 'affiliate']
    PROVIDERS = ['email', 'google', 'facebook', 'phone']

    def __init__(self, db, config):
        self.db = db  # chatbot DB — only to verify the caller's admin identity
        self.config = config
        # `False` sentinel = not yet attempted (mirrors PHP's `static $pdo = false`,
        # scoped to this controller instance rather than the PHP worker process —
        # see deviation note in the task report).
        self._login_cache: Db | None | bool = False

    # ─── admin gate ──────────────────────────────────────────────────────────

    def _adminRow(self, request) -> dict | None:
        """The authenticated caller's row IF they are an admin, else None."""
        userId = request.get('user_id')
        if not userId:
            return None
        row = self.db.fetch_one('SELECT id, email, role FROM users WHERE id = :id LIMIT 1', {':id': userId})
        return row if (row and (row.get('role') or '') == 'admin') else None

    def _requireAdmin(self, request) -> dict | None:
        if not self._adminRow(request):
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}
        return None

    def _login(self) -> Db | None:
        """Connection to the login DB, or None if unconfigured/unreachable."""
        if self._login_cache is not False:
            return self._login_cache
        c = self.config.get('login_database')
        if not isinstance(c, dict) or php_empty(c.get('username')) or php_empty(c.get('database')):
            self._login_cache = None
            return None
        try:
            self._login_cache = Db.connect(c, timeout=6)
        except Exception as e:  # noqa: BLE001
            error_log('[login-admin] DB connect failed: ' + str(e))
            self._login_cache = None
        return self._login_cache

    def _close_connections(self) -> None:
        """Close the secondary login-DB connection (if one was opened) once the
        route method returns, success or error — mirrors VideoEditorController's
        `_close_connections` (see app.support.db_cleanup)."""
        conn = self._login_cache
        if conn is not False and conn is not None:
            close_db(conn, log_prefix='login-admin')
        self._login_cache = False

    def _loginUserById(self, l: Db, id_: int) -> dict | None:
        return l.fetch_one('SELECT id, email FROM users WHERE id = ? LIMIT 1', [id_])

    @staticmethod
    def _scalar(l: Db, sql: str):
        row = l.fetch_one(sql)
        return next(iter(row.values())) if row else None

    # ─── GET /api/v1/admin/login/stats ─────────────────────────────────────

    @_cleanup
    def getStats(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'available': False,
                    'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
        try:
            stats = {
                'total_users': php_intval(self._scalar(l, 'SELECT COUNT(*) FROM users')),
                'by_provider': l.fetch_all('SELECT provider, COUNT(*) c FROM users GROUP BY provider'),
                'verified': php_intval(self._scalar(l, 'SELECT COUNT(*) FROM users WHERE email_verified = 1')),
                'apps': l.fetch_one(
                    'SELECT COUNT(*) total, COALESCE(SUM(revoked_at IS NULL),0) active FROM registered_apps'),
                'passkeys': php_intval(self._scalar(l, 'SELECT COUNT(*) FROM webauthn_credentials')),
                'signups_7d': php_intval(self._scalar(
                    l, 'SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)')),
                'logins_7d': php_intval(self._scalar(
                    l, 'SELECT COUNT(*) FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY)')),
            }
            return {'success': True, 'available': True, 'stats': stats}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'message': 'Stats query failed'}

    # ─── GET /api/v1/admin/login/users?q&provider ──────────────────────────

    @_cleanup
    def getUsers(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'available': False, 'users': [],
                    'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
        q = php_trim(php_strval((request.get('query') or {}).get('q', '')))
        provider = php_strval((request.get('query') or {}).get('provider', ''))
        where = []
        p = {}
        if q != '':
            where.append('(email LIKE :q OR first_name LIKE :q OR last_name LIKE :q OR phone LIKE :q)')
            p[':q'] = f'%{q}%'
        if provider in self.PROVIDERS:
            where.append('provider = :prov')
            p[':prov'] = provider
        w = ('WHERE ' + ' AND '.join(where)) if where else ''
        try:
            # Accounts are auth-only now — no role column (roles are per-app in app_user_roles).
            sql = ('SELECT id, email, phone, first_name, last_name, provider,\n'
                   '                profile_picture, email_verified, last_login, created_at\n'
                   '                FROM users ' + w + ' ORDER BY id DESC LIMIT 200')
            rows = l.fetch_all(sql, p)
            for r in rows:
                r['email_verified'] = php_intval(r['email_verified'])
                name = php_trim(php_coalesce(r.get('first_name'), '') + ' ' + php_coalesce(r.get('last_name'), ''))
                r['name'] = name if name != '' else php_coalesce(r.get('email'), '')
            return {'success': True, 'available': True, 'users': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'users': [], 'message': 'User query failed'}

    # ─── POST /api/v1/admin/login/users ────────────────────────────────────

    @_cleanup
    def createUser(self, request) -> dict:
        """Create a user (no password; provider=email)."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'message': 'Login DB not reachable'}
        b = request.get('body') or {}
        email = php_trim(php_strval(b.get('email', '')))
        if not validate_email(email):
            return {'success': False, 'message': 'A valid email is required'}
        try:
            # Account only (auth). Per-app roles are assigned separately (app_user_roles).
            newId = l.insert(
                "INSERT INTO users (email, first_name, last_name, provider, email_verified)\n"
                "                VALUES (:e, :f, :ln, 'email', 0)",
                {':e': email, ':f': php_strval(b.get('first_name', '')), ':ln': php_strval(b.get('last_name', ''))},
            )
            return {'success': True, 'id': php_intval(newId)}
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            dup = 'Duplicate' in msg or '1062' in msg
            return {'success': False, 'message': 'That email already exists' if dup else 'Create failed'}

    # ─── POST /api/v1/admin/login/users/update ─────────────────────────────

    @_cleanup
    def updateUser(self, request) -> dict:
        """Edit account fields (profile / verification). Roles are per-app
        (app_user_roles), not editable here."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'message': 'Login DB not reachable'}
        b = request.get('body') or {}
        id_ = php_intval(b.get('id', 0))
        if id_ <= 0:
            return {'success': False, 'message': 'id is required'}
        target = self._loginUserById(l, id_)
        if not target:
            return {'success': False, 'message': 'User not found'}

        fields = []
        p = {':id': id_}
        for f in ('first_name', 'last_name', 'phone', 'profile_picture'):
            if f in b:
                fields.append(f'{f} = :{f}')
                p[f':{f}'] = php_strval(b[f])
        if 'email_verified' in b:
            fields.append('email_verified = :ev')
            p[':ev'] = 1 if b['email_verified'] else 0
        if not fields:
            return {'success': True}
        try:
            sql = 'UPDATE users SET ' + ', '.join(fields) + ' WHERE id = :id'
            l.execute(sql, p)
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Update failed'}

    # ─── POST /api/v1/admin/login/users/delete ─────────────────────────────

    @_cleanup
    def deleteUser(self, request) -> dict:
        """Delete a user + their passkeys. An admin cannot delete their own account."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'message': 'Login DB not reachable'}
        id_ = php_intval((request.get('body') or {}).get('id', 0))
        if id_ <= 0:
            return {'success': False, 'message': 'id is required'}
        target = self._loginUserById(l, id_)
        if not target:
            return {'success': False, 'message': 'User not found'}
        admin = self._adminRow(request)
        if admin and php_strval(admin.get('email')).lower() == php_strval(target.get('email')).lower():
            return {'success': False, 'message': "You can't delete your own account."}
        try:
            l.begin()
            l.execute('DELETE FROM webauthn_credentials WHERE user_id = ?', [id_])
            try:
                l.execute('DELETE FROM app_user_roles WHERE user_id = ?', [id_])
            except Exception:  # noqa: BLE001 — table may not exist
                pass
            l.execute('DELETE FROM users WHERE id = ?', [id_])
            l.commit()
            return {'success': True}
        except Exception:  # noqa: BLE001
            try:
                l.rollback()
            except Exception:  # noqa: BLE001
                pass
            return {'success': False, 'message': 'Delete failed'}

    # ---------- Applications (app-centric role management) ----------

    def _appIdBySlug(self, login: Db, slug: str) -> int | None:
        row = login.fetch_one('SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1', [slug])
        return php_intval(row['id']) if row else None

    # ─── GET /api/v1/admin/login/apps ──────────────────────────────────────

    @_cleanup
    def getApps(self, request) -> dict:
        """Registered applications + their user counts."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'available': False, 'apps': [],
                    'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
        try:
            rows = l.fetch_all(
                'SELECT id, app_id, name, key_prefix, entry_point, created_at, last_used_at, revoked_at\n'
                '                               FROM registered_apps ORDER BY name'
            )
            counts = {}
            for rr in l.fetch_all('SELECT app_id, COUNT(*) c FROM app_user_roles GROUP BY app_id'):
                counts[php_intval(rr['app_id'])] = php_intval(rr['c'])
            for r in rows:
                r['users'] = counts.get(php_intval(r['id']), 0)
                r['revoked'] = r['revoked_at'] is not None
            return {'success': True, 'available': True, 'apps': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'apps': [], 'message': 'Apps query failed'}

    # ─── GET /api/v1/admin/login/app-users?app=<slug>&q= ───────────────────

    @_cleanup
    def getAppUsers(self, request) -> dict:
        """Users + their role for one app."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'available': False, 'users': [],
                    'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
        slug = php_strval((request.get('query') or {}).get('app', ''))
        appId = self._appIdBySlug(l, slug)
        if appId is None:
            return {'success': False, 'message': 'Unknown application'}
        try:
            # MEMBERS of this app = users who have a role for it (in its context).
            rows = l.fetch_all(
                'SELECT u.id, u.email, u.first_name, u.last_name, u.provider,\n'
                '                                     u.email_verified, u.last_login, r.role\n'
                '                              FROM app_user_roles r JOIN users u ON u.id = r.user_id\n'
                '                              WHERE r.app_id = ? ORDER BY u.id DESC',
                [appId],
            )
            for r in rows:
                name = php_trim(php_coalesce(r.get('first_name'), '') + ' ' + php_coalesce(r.get('last_name'), ''))
                r['name'] = name if name != '' else php_coalesce(r.get('email'), '')
                r['email_verified'] = php_intval(r['email_verified'])
                r.pop('first_name', None)
                r.pop('last_name', None)
            return {'success': True, 'available': True, 'app': slug, 'users': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'users': [], 'message': 'User query failed'}

    # ─── POST /api/v1/admin/login/app-users/role ───────────────────────────

    @_cleanup
    def setAppUserRole(self, request) -> dict:
        """Set/clear a user's role for one app. Body: { app, user_id, role }.
        Empty/"none" role revokes access."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'message': 'Login DB not reachable'}
        b = request.get('body') or {}
        slug = php_strval(b.get('app', ''))
        uid = php_intval(b.get('user_id', 0))
        role = php_strval(b.get('role', ''))
        appId = self._appIdBySlug(l, slug)
        if appId is None:
            return {'success': False, 'message': 'Unknown application'}
        if uid <= 0:
            return {'success': False, 'message': 'user_id is required'}
        adminId = php_intval(request.get('user_id')) if is_numeric(request.get('user_id')) else None
        try:
            if role == '' or role == 'none':
                l.execute('DELETE FROM app_user_roles WHERE user_id = :u AND app_id = :a', {':u': uid, ':a': appId})
            else:
                if role not in self.ROLES:
                    return {'success': False, 'message': 'invalid role'}
                l.execute(
                    'INSERT INTO app_user_roles (user_id, app_id, role, updated_by)\n'
                    '                VALUES (:u, :a, :r, :by)\n'
                    '                ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)',
                    {':u': uid, ':a': appId, ':r': role, ':by': adminId},
                )
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    # ─── POST /api/v1/admin/login/app-users/add ────────────────────────────

    @_cleanup
    def addAppMember(self, request) -> dict:
        """Add a member to an app, creating the account first if the email is
        new. Writes both `users` (auth-only, no password — completed via
        reset/social/passkey) and `app_user_roles`.
        Body: { app, email, first_name?, last_name?, role }."""
        err = self._requireAdmin(request)
        if err:
            return err
        l = self._login()
        if not l:
            return {'success': False, 'message': 'Login DB not reachable'}
        b = request.get('body') or {}
        slug = php_strval(b.get('app', ''))
        email = php_trim(php_strval(b.get('email', '')))
        role = php_strval(b.get('role', ''))
        if not validate_email(email):
            return {'success': False, 'message': 'A valid email is required'}
        if role not in self.ROLES:
            return {'success': False, 'message': 'A valid role is required'}
        appId = self._appIdBySlug(l, slug)
        if appId is None:
            return {'success': False, 'message': 'Unknown application'}
        adminId = php_intval(request.get('user_id')) if is_numeric(request.get('user_id')) else None
        try:
            l.begin()
            # 1) Find the user by email; create the account if it doesn't exist yet.
            row = l.fetch_one('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
            created = False
            if row is None:
                uid = l.insert(
                    "INSERT INTO users (email, first_name, last_name, provider, email_verified)\n"
                    "                                    VALUES (?, ?, ?, 'email', 0)",
                    [email, php_strval(b.get('first_name', '')), php_strval(b.get('last_name', ''))],
                )
                created = True
            else:
                uid = php_intval(row['id'])
            # 2) Link the user to the application with the role.
            l.execute(
                'INSERT INTO app_user_roles (user_id, app_id, role, updated_by)\n'
                '                           VALUES (?, ?, ?, ?)\n'
                '                           ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)',
                [uid, appId, role, adminId],
            )
            l.commit()
            return {'success': True, 'created': created, 'user_id': uid}
        except Exception as e:  # noqa: BLE001
            try:
                l.rollback()
            except Exception:  # noqa: BLE001
                pass
            msg = str(e)
            dup = 'Duplicate' in msg or '1062' in msg
            return {'success': False, 'message': 'That email already exists' if dup else 'Add failed'}
