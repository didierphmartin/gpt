"""Unit tests for LoginAdminController (Phase 7, Task 4).

PHP source: backend/src/Controllers/LoginAdminController.php (1-354).

`self.db` (the primary/contexts DB) is used only to resolve the caller's
admin identity; `l` (a FakeLoginDb instance) stands in for the separate
login-microservice connection PHP opens lazily via `login()`. Tests bypass
`_login()`'s real `Db.connect()` call by assigning `ctrl._login_cache`
directly (mirrors PHP's `static $pdo` cache slot) except for the dedicated
`_login()` connect-path tests at the bottom, which patch `Db.connect`.
"""
from starlette.datastructures import Headers

from app.controllers import login_admin_controller as lac_module
from app.controllers.login_admin_controller import LoginAdminController
from app.support.http import Ctx


class FakeDb:
    """Stand-in for the primary/contexts DB (admin-identity lookups only).
    `_adminRow` may run more than once per request (`deleteUser` calls it
    twice, and a test may exercise several endpoints on one controller), so
    the queued row is returned on every call rather than being popped —
    the admin-identity SELECT always yields the same row for the lifetime
    of one test's controller instance."""

    def __init__(self, one=None):
        rows = list(one or [])
        self.row = rows[0] if rows else None
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.row


class FakeLoginDb:
    """Stand-in for the separate login-DB connection (`l` in the PHP source).
    Records every statement so tests can assert SQL byte-for-byte."""

    def __init__(self, one=None, all_=None, insert_id=1, rowcount=1, raise_on=None):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.insert_id = insert_id
        self.rowcount = rowcount
        self.raise_on = raise_on or {}   # {'execute': Exception(...), 'insert': ...}
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_.pop(0) if self.all_ else []

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        if 'execute' in self.raise_on:
            raise self.raise_on['execute']
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append(('insert', sql, params))
        if 'insert' in self.raise_on:
            raise self.raise_on['insert']
        return self.insert_id

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


def ctx(body=None, query=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


def admin_ctrl(l_db=None, admin_row=None):
    """Controller whose primary-DB admin check succeeds (row = admin) and whose
    `_login()` is pre-seeded with `l_db` (bypassing the real connect)."""
    row = admin_row if admin_row is not None else {'id': 3, 'email': 'admin@x.com', 'role': 'admin'}
    ctrl = LoginAdminController(FakeDb(one=[row]), {})
    ctrl._login_cache = l_db
    return ctrl


# ─── admin gate ─────────────────────────────────────────────────────────────

def test_requireAdmin_blocks_non_admin_and_unauthenticated():
    # non-admin caller
    ctrl = LoginAdminController(FakeDb(one=[{'id': 3, 'email': 'x@x.com', 'role': 'user'}]), {})
    assert ctrl.getStats(ctx()) == {'success': False, 'error': 'Admin access required', 'status_code': 403}
    # unauthenticated — LoginAdminController has no separate 401 branch; adminRow()
    # returns None for a missing user_id too, so this also funnels to the 403.
    ctrl2 = LoginAdminController(FakeDb(), {})
    assert ctrl2.getStats(ctx(user_id=None)) == {'success': False, 'error': 'Admin access required', 'status_code': 403}
    # no row found for the id at all
    ctrl3 = LoginAdminController(FakeDb(one=[None]), {})
    assert ctrl3.getStats(ctx()) == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_requireAdmin_admin_lookup_sql():
    db = FakeDb(one=[{'id': 3, 'email': 'a@x.com', 'role': 'admin'}])
    ctrl = LoginAdminController(db, {})
    ctrl._login_cache = None   # short-circuits after the admin check
    ctrl.getStats(ctx())
    assert db.calls == [('SELECT id, email, role FROM users WHERE id = :id LIMIT 1', {':id': 3})]


# ─── login DB unreachable branch (per-method message shape) ────────────────

def test_login_db_unreachable_messages():
    ctrl = admin_ctrl(l_db=None)
    assert ctrl.getStats(ctx()) == {
        'success': False, 'available': False,
        'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
    assert ctrl.getUsers(ctx()) == {
        'success': False, 'available': False, 'users': [],
        'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
    assert ctrl.createUser(ctx(body={'email': 'a@b.com'})) == {
        'success': False, 'message': 'Login DB not reachable'}
    assert ctrl.updateUser(ctx(body={'id': 1})) == {'success': False, 'message': 'Login DB not reachable'}
    assert ctrl.deleteUser(ctx(body={'id': 1})) == {'success': False, 'message': 'Login DB not reachable'}
    assert ctrl.getApps(ctx()) == {
        'success': False, 'available': False, 'apps': [],
        'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
    assert ctrl.getAppUsers(ctx(query={'app': 'x'})) == {
        'success': False, 'available': False, 'users': [],
        'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
    assert ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 1, 'role': 'user'})) == {
        'success': False, 'message': 'Login DB not reachable'}
    assert ctrl.addAppMember(ctx(body={'app': 'x', 'email': 'a@b.com', 'role': 'user'})) == {
        'success': False, 'message': 'Login DB not reachable'}


# ─── getStats ───────────────────────────────────────────────────────────────

def test_getStats_success():
    l = FakeLoginDb(
        one=[{'c': 5}, {'c': 2}, {'total': 3, 'active': 2}, {'c': 4}, {'c': 1}, {'c': 6}],
        all_=[[{'provider': 'email', 'c': 5}]],
    )
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.getStats(ctx())
    assert result['success'] is True
    assert result['available'] is True
    assert result['stats']['total_users'] == 5
    assert result['stats']['by_provider'] == [{'provider': 'email', 'c': 5}]
    assert result['stats']['verified'] == 2
    assert result['stats']['apps'] == {'total': 3, 'active': 2}
    assert result['stats']['passkeys'] == 4
    assert result['stats']['signups_7d'] == 1
    assert result['stats']['logins_7d'] == 6


def test_getStats_query_failure():
    class RaisingLoginDb(FakeLoginDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db down')
    ctrl = admin_ctrl(l_db=RaisingLoginDb())
    assert ctrl.getStats(ctx()) == {'success': False, 'available': False, 'message': 'Stats query failed'}


# ─── getUsers ───────────────────────────────────────────────────────────────

def test_getUsers_no_filters_sql():
    l = FakeLoginDb(all_=[[]])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.getUsers(ctx())
    assert result == {'success': True, 'available': True, 'users': []}
    assert l.calls == [('fetch_all',
                         'SELECT id, email, phone, first_name, last_name, provider,\n'
                         '                profile_picture, email_verified, last_login, created_at\n'
                         '                FROM users  ORDER BY id DESC LIMIT 200', {})]


def test_getUsers_q_and_provider_filters_sql():
    l = FakeLoginDb(all_=[[]])
    ctrl = admin_ctrl(l_db=l)
    ctrl.getUsers(ctx(query={'q': 'bob', 'provider': 'google'}))
    assert l.calls == [('fetch_all',
                         'SELECT id, email, phone, first_name, last_name, provider,\n'
                         '                profile_picture, email_verified, last_login, created_at\n'
                         '                FROM users WHERE (email LIKE :q OR first_name LIKE :q OR last_name '
                         'LIKE :q OR phone LIKE :q) AND provider = :prov ORDER BY id DESC LIMIT 200',
                         {':q': '%bob%', ':prov': 'google'})]


def test_getUsers_unknown_provider_is_ignored():
    l = FakeLoginDb(all_=[[]])
    ctrl = admin_ctrl(l_db=l)
    ctrl.getUsers(ctx(query={'provider': 'bogus'}))
    _, sql, params = l.calls[0]
    assert 'WHERE' not in sql
    assert params == {}


def test_getUsers_decorates_name_and_email_verified():
    l = FakeLoginDb(all_=[[{'id': 1, 'email': 'a@x.com', 'first_name': 'Bob', 'last_name': 'X',
                             'email_verified': '1'},
                            {'id': 2, 'email': 'b@x.com', 'first_name': None, 'last_name': None,
                             'email_verified': 0}]])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.getUsers(ctx())
    assert result['users'][0]['name'] == 'Bob X'
    assert result['users'][0]['email_verified'] == 1
    assert result['users'][1]['name'] == 'b@x.com'   # blank name falls back to email
    assert result['users'][1]['email_verified'] == 0


def test_getUsers_query_failure():
    class RaisingLoginDb(FakeLoginDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('down')
    ctrl = admin_ctrl(l_db=RaisingLoginDb())
    assert ctrl.getUsers(ctx()) == {'success': False, 'available': False, 'users': [], 'message': 'User query failed'}


# ─── createUser ─────────────────────────────────────────────────────────────

def test_createUser_invalid_email():
    ctrl = admin_ctrl(l_db=FakeLoginDb())
    assert ctrl.createUser(ctx(body={'email': 'not-an-email'})) == {
        'success': False, 'message': 'A valid email is required'}
    assert ctrl.createUser(ctx(body={})) == {'success': False, 'message': 'A valid email is required'}


def test_createUser_success_sql():
    l = FakeLoginDb(insert_id=42)
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.createUser(ctx(body={'email': 'new@x.com', 'first_name': 'A', 'last_name': 'B'}))
    assert result == {'success': True, 'id': 42}
    assert l.calls == [('insert',
                         "INSERT INTO users (email, first_name, last_name, provider, email_verified)\n"
                         "                VALUES (:e, :f, :ln, 'email', 0)",
                         {':e': 'new@x.com', ':f': 'A', ':ln': 'B'})]


def test_createUser_duplicate_vs_generic_failure():
    l_dup = FakeLoginDb(raise_on={'insert': RuntimeError('Duplicate entry for key')})
    ctrl_dup = admin_ctrl(l_db=l_dup)
    assert ctrl_dup.createUser(ctx(body={'email': 'a@x.com'})) == {
        'success': False, 'message': 'That email already exists'}

    l_1062 = FakeLoginDb(raise_on={'insert': RuntimeError('SQLSTATE 1062')})
    ctrl_1062 = admin_ctrl(l_db=l_1062)
    assert ctrl_1062.createUser(ctx(body={'email': 'a@x.com'})) == {
        'success': False, 'message': 'That email already exists'}

    l_other = FakeLoginDb(raise_on={'insert': RuntimeError('connection reset')})
    ctrl_other = admin_ctrl(l_db=l_other)
    assert ctrl_other.createUser(ctx(body={'email': 'a@x.com'})) == {'success': False, 'message': 'Create failed'}


# ─── updateUser ─────────────────────────────────────────────────────────────

def test_updateUser_id_required():
    ctrl = admin_ctrl(l_db=FakeLoginDb())
    assert ctrl.updateUser(ctx(body={})) == {'success': False, 'message': 'id is required'}
    assert ctrl.updateUser(ctx(body={'id': 0})) == {'success': False, 'message': 'id is required'}


def test_updateUser_not_found():
    l = FakeLoginDb(one=[None])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.updateUser(ctx(body={'id': 5})) == {'success': False, 'message': 'User not found'}


def test_updateUser_no_fields_is_noop_success():
    l = FakeLoginDb(one=[{'id': 5, 'email': 'a@x.com'}])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.updateUser(ctx(body={'id': 5})) == {'success': True}
    assert not any(c[0] == 'execute' for c in l.calls)


def test_updateUser_success_sql():
    l = FakeLoginDb(one=[{'id': 5, 'email': 'a@x.com'}])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.updateUser(ctx(body={'id': 5, 'first_name': 'New', 'email_verified': True}))
    assert result == {'success': True}
    assert l.calls[-1] == ('execute', 'UPDATE users SET first_name = :first_name, email_verified = :ev WHERE id = :id',
                           {':id': 5, ':first_name': 'New', ':ev': 1})


def test_updateUser_failure():
    l = FakeLoginDb(one=[{'id': 5, 'email': 'a@x.com'}], raise_on={'execute': RuntimeError('boom')})
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.updateUser(ctx(body={'id': 5, 'phone': '123'})) == {'success': False, 'message': 'Update failed'}


# ─── deleteUser ─────────────────────────────────────────────────────────────

def test_deleteUser_id_required():
    ctrl = admin_ctrl(l_db=FakeLoginDb())
    assert ctrl.deleteUser(ctx(body={})) == {'success': False, 'message': 'id is required'}


def test_deleteUser_not_found():
    l = FakeLoginDb(one=[None])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.deleteUser(ctx(body={'id': 9})) == {'success': False, 'message': 'User not found'}


def test_deleteUser_blocks_self_delete_case_insensitive():
    row = {'id': 3, 'email': 'ADMIN@X.com', 'role': 'admin'}
    db = FakeDb(one=[row])
    ctrl = LoginAdminController(db, {})
    l = FakeLoginDb(one=[{'id': 3, 'email': 'admin@x.com'}])
    ctrl._login_cache = l
    result = ctrl.deleteUser(ctx(body={'id': 3}))
    assert result == {'success': False, 'message': "You can't delete your own account."}


def test_deleteUser_success_transaction_sql():
    l = FakeLoginDb(one=[{'id': 9, 'email': 'other@x.com'}])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.deleteUser(ctx(body={'id': 9}))
    assert result == {'success': True}
    assert l.began == 1 and l.committed == 1 and l.rolledback == 0
    execute_calls = [c for c in l.calls if c[0] == 'execute']
    assert execute_calls == [
        ('execute', 'DELETE FROM webauthn_credentials WHERE user_id = ?', [9]),
        ('execute', 'DELETE FROM app_user_roles WHERE user_id = ?', [9]),
        ('execute', 'DELETE FROM users WHERE id = ?', [9]),
    ]


def test_deleteUser_tolerates_missing_app_user_roles_table():
    class SelectivelyRaisingLoginDb(FakeLoginDb):
        def execute(self, sql, params=None):
            self.calls.append(('execute', sql, params))
            if 'app_user_roles' in sql:
                raise RuntimeError("table doesn't exist")
            return self.rowcount
    l = SelectivelyRaisingLoginDb(one=[{'id': 9, 'email': 'other@x.com'}])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.deleteUser(ctx(body={'id': 9}))
    assert result == {'success': True}   # the app_user_roles failure is swallowed
    assert l.committed == 1


def test_deleteUser_failure_rolls_back():
    l = FakeLoginDb(one=[{'id': 9, 'email': 'other@x.com'}], raise_on={'execute': RuntimeError('boom')})
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.deleteUser(ctx(body={'id': 9}))
    assert result == {'success': False, 'message': 'Delete failed'}
    assert l.rolledback == 1


# ─── getApps ────────────────────────────────────────────────────────────────

def test_getApps_success_computes_users_and_revoked():
    l = FakeLoginDb(all_=[
        [{'id': 1, 'app_id': 'a', 'revoked_at': None}, {'id': 2, 'app_id': 'b', 'revoked_at': '2026-01-01'}],
        [{'app_id': 1, 'c': 3}],
    ])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.getApps(ctx())
    assert result['success'] is True
    assert result['apps'][0]['users'] == 3 and result['apps'][0]['revoked'] is False
    assert result['apps'][1]['users'] == 0 and result['apps'][1]['revoked'] is True
    assert l.calls[0] == ('fetch_all',
                          'SELECT id, app_id, name, key_prefix, entry_point, created_at, last_used_at, revoked_at\n'
                          '                               FROM registered_apps ORDER BY name', None)


def test_getApps_query_failure():
    class RaisingLoginDb(FakeLoginDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('down')
    ctrl = admin_ctrl(l_db=RaisingLoginDb())
    assert ctrl.getApps(ctx()) == {'success': False, 'available': False, 'apps': [], 'message': 'Apps query failed'}


# ─── getAppUsers ────────────────────────────────────────────────────────────

def test_getAppUsers_unknown_application():
    l = FakeLoginDb(one=[None])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.getAppUsers(ctx(query={'app': 'nope'})) == {'success': False, 'message': 'Unknown application'}


def test_getAppUsers_success_decorates_and_strips_name_parts():
    l = FakeLoginDb(one=[{'id': 7}],
                    all_=[[{'id': 1, 'email': 'a@x.com', 'first_name': 'A', 'last_name': 'B',
                            'email_verified': '1', 'role': 'user'}]])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.getAppUsers(ctx(query={'app': 'myapp'}))
    assert result['success'] is True and result['app'] == 'myapp'
    row = result['users'][0]
    assert row['name'] == 'A B' and row['email_verified'] == 1
    assert 'first_name' not in row and 'last_name' not in row
    assert l.calls[-1] == ('fetch_all',
                           'SELECT u.id, u.email, u.first_name, u.last_name, u.provider,\n'
                           '                                     u.email_verified, u.last_login, r.role\n'
                           '                              FROM app_user_roles r JOIN users u ON u.id = r.user_id\n'
                           '                              WHERE r.app_id = ? ORDER BY u.id DESC', [7])


def test_getAppUsers_query_failure():
    class RaisingLoginDb(FakeLoginDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('down')
    l = RaisingLoginDb(one=[{'id': 7}])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.getAppUsers(ctx(query={'app': 'x'})) == {
        'success': False, 'available': False, 'users': [], 'message': 'User query failed'}


# ─── setAppUserRole ─────────────────────────────────────────────────────────

def test_setAppUserRole_unknown_application():
    l = FakeLoginDb(one=[None])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.setAppUserRole(ctx(body={'app': 'nope', 'user_id': 1, 'role': 'user'})) == {
        'success': False, 'message': 'Unknown application'}


def test_setAppUserRole_user_id_required():
    l = FakeLoginDb(one=[{'id': 7}])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 0, 'role': 'user'})) == {
        'success': False, 'message': 'user_id is required'}


def test_setAppUserRole_invalid_role():
    l = FakeLoginDb(one=[{'id': 7}])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 5, 'role': 'bogus'})) == {
        'success': False, 'message': 'invalid role'}


def test_setAppUserRole_empty_or_none_deletes_sql():
    for role_value in ('', 'none'):
        l = FakeLoginDb(one=[{'id': 7}])
        ctrl = admin_ctrl(l_db=l)
        result = ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 5, 'role': role_value}))
        assert result == {'success': True}
        assert l.calls[-1] == ('execute', 'DELETE FROM app_user_roles WHERE user_id = :u AND app_id = :a',
                               {':u': 5, ':a': 7})


def test_setAppUserRole_valid_role_upsert_sql():
    l = FakeLoginDb(one=[{'id': 7}])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 5, 'role': 'admin'}, user_id=3))
    assert result == {'success': True}
    assert l.calls[-1] == ('execute',
                           'INSERT INTO app_user_roles (user_id, app_id, role, updated_by)\n'
                           '                VALUES (:u, :a, :r, :by)\n'
                           '                ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)',
                           {':u': 5, ':a': 7, ':r': 'admin', ':by': 3})


def test_setAppUserRole_save_failed():
    l = FakeLoginDb(one=[{'id': 7}], raise_on={'execute': RuntimeError('boom')})
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.setAppUserRole(ctx(body={'app': 'x', 'user_id': 5, 'role': 'user'})) == {
        'success': False, 'message': 'Save failed'}


# ─── addAppMember ───────────────────────────────────────────────────────────

def test_addAppMember_invalid_email():
    l = FakeLoginDb()
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.addAppMember(ctx(body={'app': 'x', 'email': 'bad', 'role': 'user'})) == {
        'success': False, 'message': 'A valid email is required'}


def test_addAppMember_invalid_role():
    l = FakeLoginDb()
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.addAppMember(ctx(body={'app': 'x', 'email': 'a@x.com', 'role': 'bogus'})) == {
        'success': False, 'message': 'A valid role is required'}


def test_addAppMember_unknown_application():
    l = FakeLoginDb(one=[None])
    ctrl = admin_ctrl(l_db=l)
    assert ctrl.addAppMember(ctx(body={'app': 'nope', 'email': 'a@x.com', 'role': 'user'})) == {
        'success': False, 'message': 'Unknown application'}


def test_addAppMember_creates_new_user_and_links():
    l = FakeLoginDb(one=[{'id': 7}, None], insert_id=55)
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.addAppMember(ctx(body={'app': 'x', 'email': 'new@x.com', 'first_name': 'A', 'role': 'user'},
                                   user_id=3))
    assert result == {'success': True, 'created': True, 'user_id': 55}
    assert l.began == 1 and l.committed == 1
    insert_call = next(c for c in l.calls if c[0] == 'insert')
    assert insert_call == ('insert',
                           "INSERT INTO users (email, first_name, last_name, provider, email_verified)\n"
                           "                                    VALUES (?, ?, ?, 'email', 0)",
                           ['new@x.com', 'A', ''])
    link_call = [c for c in l.calls if c[0] == 'execute'][-1]
    assert link_call == ('execute',
                         'INSERT INTO app_user_roles (user_id, app_id, role, updated_by)\n'
                         '                           VALUES (?, ?, ?, ?)\n'
                         '                           ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)',
                         [55, 7, 'user', 3])


def test_addAppMember_existing_user_links_without_creating():
    l = FakeLoginDb(one=[{'id': 7}, {'id': 20}])
    ctrl = admin_ctrl(l_db=l)
    result = ctrl.addAppMember(ctx(body={'app': 'x', 'email': 'existing@x.com', 'role': 'user'}))
    assert result == {'success': True, 'created': False, 'user_id': 20}
    assert not any(c[0] == 'insert' for c in l.calls)


def test_addAppMember_duplicate_vs_generic_failure_rolls_back():
    l_dup = FakeLoginDb(one=[{'id': 7}, None], raise_on={'insert': RuntimeError('Duplicate entry')})
    ctrl_dup = admin_ctrl(l_db=l_dup)
    result = ctrl_dup.addAppMember(ctx(body={'app': 'x', 'email': 'a@x.com', 'role': 'user'}))
    assert result == {'success': False, 'message': 'That email already exists'}
    assert l_dup.rolledback == 1

    l_other = FakeLoginDb(one=[{'id': 7}, None], raise_on={'insert': RuntimeError('connection reset')})
    ctrl_other = admin_ctrl(l_db=l_other)
    result2 = ctrl_other.addAppMember(ctx(body={'app': 'x', 'email': 'a@x.com', 'role': 'user'}))
    assert result2 == {'success': False, 'message': 'Add failed'}


# ─── _login() connect path (config presence + failure handling) ────────────

def test_login_returns_none_when_unconfigured():
    ctrl = LoginAdminController(FakeDb(), {'login_database': {'host': 'h', 'database': '', 'username': '', 'password': ''}})
    assert ctrl._login() is None
    assert ctrl._login() is None   # cached


def test_login_returns_none_and_logs_on_connect_failure(monkeypatch):
    def boom(cfg, timeout=10):
        raise RuntimeError('connection refused')
    monkeypatch.setattr(lac_module.Db, 'connect', staticmethod(boom))
    ctrl = LoginAdminController(FakeDb(), {'login_database': {
        'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}})
    assert ctrl._login() is None


def test_login_caches_successful_connection(monkeypatch):
    sentinel = FakeLoginDb()
    calls = []

    def fake_connect(cfg, timeout=10):
        calls.append(cfg)
        return sentinel

    monkeypatch.setattr(lac_module.Db, 'connect', staticmethod(fake_connect))
    ctrl = LoginAdminController(FakeDb(), {'login_database': {
        'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}})
    assert ctrl._login() is sentinel
    assert ctrl._login() is sentinel
    assert len(calls) == 1   # connected once, then cached
