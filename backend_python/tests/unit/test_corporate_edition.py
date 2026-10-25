"""Ports of backend/tests/Unit/Controllers/SetupControllerTest.php, CorporateSignInTest.php, AdminCorporateAccountsTest.php,
LoginAdminCorporateTest.php and Services/EditionTest.php."""
from __future__ import annotations

import sqlite3
import time

import pytest

from app.controllers.admin_controller import AdminController
from app.controllers.auth_controller import AuthController, password_hash, password_verify
from app.controllers.login_admin_controller import LoginAdminController
from app.controllers.setup_controller import SetupController
from app.services import edition
from app.services.login_accounts import LoginAccounts
from app.services.robot_account import RobotAccount
from tests.unit.playbook.conftest import SqliteDb


def sqlite(*ddl) -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, lambda: time.strftime('%Y-%m-%d %H:%M:%S'))
    for d in ddl:
        conn.execute(d)
    conn.commit()
    return SqliteDb(conn)


LOGIN_USERS = ('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, first_name TEXT,'
               ' last_name TEXT, provider TEXT, email_verified INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)')


# ---------------------------------------------------------------- Edition

def test_only_corporate_refuses_local_sign_in():
    assert edition.refuse_local_sign_in({'edition': ''}) is None
    assert edition.refuse_local_sign_in({'edition': 'individual'}) is None
    refused = edition.refuse_local_sign_in({'edition': 'corporate'})
    assert refused['status_code'] == 403
    assert refused['success'] is False


def test_is_corporate_is_exact():
    assert edition.is_corporate({'edition': 'corporate'}) is True
    assert edition.is_corporate({'edition': 'Corporate'}) is False
    assert edition.is_corporate({'edition': ''}) is False


# ---------------------------------------------------------------- SetupController

class Setup:
    def __init__(self):
        self.gpt = sqlite("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,"
                          " first_name TEXT, last_name TEXT, role TEXT, plan TEXT, provider TEXT, kind TEXT DEFAULT 'person',"
                          " email_verified INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)",
                          'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT)')
        self.login = sqlite(LOGIN_USERS)

    def controller(self, ed='corporate') -> SetupController:
        return SetupController(self.gpt, {'edition': ed}, LoginAccounts(self.login))

    def create(self, body, ed='corporate') -> dict:
        return self.controller(ed).createAdmin({'body': body})


@pytest.fixture
def s():
    return Setup()


def test_status_needs_setup_only_on_corporate_without_admin(s):
    assert s.controller().status({})['needs_setup'] is True
    assert s.controller('individual').status({})['needs_setup'] is False
    assert s.controller('').status({})['needs_setup'] is False
    assert s.controller().status({})['edition'] == 'corporate'


def test_the_robot_service_user_does_not_end_first_run_setup(s):
    RobotAccount.ensure(s.gpt)
    assert s.controller().status({})['needs_setup'] is True
    assert s.create({'email': 'boss@corp.test', 'password': 'correct-horse-1'})['success'] is True


def test_create_admin_writes_both_databases(s):
    r = s.create({'email': 'boss@corp.test', 'password': 'correct-horse-1'})
    assert r['success'] is True
    assert r['status_code'] == 201
    g = s.gpt.fetch_one("SELECT * FROM users WHERE email = 'boss@corp.test'")
    assert g['role'] == 'admin'
    assert g['password'] is None, 'gpt must not hold a password: the login service is the only credential store'
    assert int(g['email_verified']) == 1
    l = s.login.fetch_one("SELECT * FROM users WHERE email = 'boss@corp.test'")
    assert password_verify('correct-horse-1', l['password'])
    assert int(l['email_verified']) == 1
    assert s.controller().status({})['needs_setup'] is False


def test_second_setup_is_refused(s):
    s.create({'email': 'boss@corp.test', 'password': 'correct-horse-1'})
    r = s.create({'email': 'intruder@corp.test', 'password': 'another-pass-2'})
    assert r['status_code'] == 409
    assert s.login.fetch_column("SELECT COUNT(*) FROM users WHERE email = 'intruder@corp.test'")[0] == 0


def test_setup_rejects_bad_input(s):
    assert s.create({'email': 'not-an-email', 'password': 'correct-horse-1'})['status_code'] == 400
    assert s.create({'email': 'boss@corp.test', 'password': 'short'})['status_code'] == 400
    assert s.controller().status({})['needs_setup'] is True


def test_setup_is_not_available_outside_corporate(s):
    assert s.create({'email': 'boss@corp.test', 'password': 'correct-horse-1'}, 'individual')['status_code'] == 404


def test_setup_normalises_email_in_both_databases(s):
    s.create({'email': '  Boss@Corp.TEST ', 'password': 'correct-horse-1'})
    assert s.gpt.fetch_column("SELECT COUNT(*) FROM users WHERE email = 'boss@corp.test'")[0] == 1
    assert s.login.fetch_column("SELECT COUNT(*) FROM users WHERE email = 'boss@corp.test'")[0] == 1


def test_setup_retry_after_partial_failure_uses_new_password(s):
    # A previous attempt wrote the login row, then failed before the gpt row.
    s.login.execute("INSERT INTO users (email, password, email_verified) VALUES ('boss@corp.test', ?, 0)",
                    [password_hash('first-attempt-1')])
    assert s.create({'email': 'boss@corp.test', 'password': 'second-attempt-2'})['success'] is True
    l = s.login.fetch_one("SELECT * FROM users WHERE email = 'boss@corp.test'")
    assert password_verify('second-attempt-2', l['password'])
    assert int(l['email_verified']) == 1


def test_setup_is_refused_once_any_gpt_user_exists_even_without_an_admin(s):
    # The only admin demoted themselves: a regular account remains. Setup must not reopen.
    s.gpt.execute("INSERT INTO users (email, role) VALUES ('ann@corp.test', 'user')")
    s.login.execute("INSERT INTO users (email, password, email_verified) VALUES ('ann@corp.test', ?, 1)",
                    [password_hash('ann-password-1')])
    assert s.controller().status({})['needs_setup'] is False
    assert s.create({'email': 'ann@corp.test', 'password': 'takeover-pass-2'})['status_code'] == 409
    l = s.login.fetch_one("SELECT * FROM users WHERE email = 'ann@corp.test'")
    assert password_verify('ann-password-1', l['password'])
    assert s.gpt.fetch_column("SELECT role FROM users WHERE email = 'ann@corp.test'")[0] == 'user'


def test_busy_lock_is_503_without_writing_or_releasing(s):
    class Busy(SetupController):
        unlocks = 0

        def lock(self):
            return False

        def unlock(self):
            self.unlocks += 1
    c = Busy(s.gpt, {'edition': 'corporate'}, LoginAccounts(s.login))
    r = c.createAdmin({'body': {'email': 'boss@corp.test', 'password': 'correct-horse-1'}})
    assert r['status_code'] == 503
    assert r['message'] == 'Setup is busy, please try again'
    assert c.unlocks == 0, 'a lock that was not acquired must not be released'
    assert s.gpt.fetch_column('SELECT COUNT(*) FROM users')[0] == 0
    assert s.login.fetch_column('SELECT COUNT(*) FROM users')[0] == 0


def test_missing_login_database_is_503(s):
    r = SetupController(s.gpt, {'edition': 'corporate'}, None).createAdmin(
        {'body': {'email': 'boss@corp.test', 'password': 'correct-horse-1'}})
    assert r['status_code'] == 503
    assert s.controller().status({})['needs_setup'] is True


# ---------------------------------------------------------------- AuthController (CorporateSignInTest)

def auth(ed: str) -> AuthController:
    db = sqlite('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, password TEXT, role TEXT)')
    db.execute("INSERT INTO users (email, password, role) VALUES ('a@corp.test', ?, 'admin')", [password_hash('right-password')])
    return AuthController(db, {'edition': ed, 'auth': {'jwt_secret': 'test-secret-0123456789-0123456789'}})


def test_corporate_refuses_password_login():
    r = auth('corporate').login({'body': {'email': 'a@corp.test', 'password': 'right-password'}})
    assert r['status_code'] == 403
    assert 'data' not in r


def test_corporate_refuses_register_and_firebase():
    c = auth('corporate')
    assert c.register({'body': {'email': 'n@corp.test', 'password': 'x'}})['status_code'] == 403
    assert c.firebaseAuth({'body': {'idToken': 'x'}})['status_code'] == 403


# ---------------------------------------------------------------- AdminController (AdminCorporateAccountsTest)

GPT_USERS = ("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, first_name TEXT,"
             " last_name TEXT, role TEXT, plan TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person',"
             " email_verified INTEGER DEFAULT 0, app_key_prefix TEXT, app_key_created_at TEXT, created_at TEXT, updated_at TEXT)")
PACKAGES = 'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT)'


class Corp:
    def __init__(self):
        self.gpt = sqlite(GPT_USERS, PACKAGES)
        for r in ('guest', 'prospect', 'user', 'admin'):
            self.gpt.execute('INSERT INTO packages (role, builtin) VALUES (?, 1)', [r])
        self.gpt.execute("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')")
        self.login = sqlite(LOGIN_USERS)

    def admin(self, ed='corporate') -> AdminController:
        return AdminController(self.gpt, {'edition': ed}, LoginAccounts(self.login))

    def loginRow(self, email):
        return self.login.fetch_one('SELECT * FROM users WHERE email = ?', [email])

    def gid(self, email) -> int:
        return int(self.gpt.fetch_column('SELECT id FROM users WHERE email = ?', [email])[0])


def as_admin(body) -> dict:
    return {'user_id': 1, 'body': body}


@pytest.fixture
def corp():
    return Corp()


def test_create_user_creates_verified_login_account(corp):
    r = corp.admin().createUser(as_admin({'email': 'Ann@Corp.test', 'password': 'ann-password-1', 'role': 'user'}))
    assert r['success'] is True
    row = corp.loginRow('ann@corp.test')
    assert row is not None
    assert password_verify('ann-password-1', row['password'])
    assert int(row['email_verified']) == 1
    assert corp.gpt.fetch_one("SELECT * FROM users WHERE email = 'ann@corp.test'")['password'] is None


def test_update_password_changes_login_password(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    id = corp.gid('ann@corp.test')
    r = corp.admin().updateUser(as_admin({'user_id': id, 'email': 'ann@corp.test', 'password': 'new-password-2'}))
    assert r['success'] is True
    row = corp.loginRow('ann@corp.test')
    assert password_verify('new-password-2', row['password'])
    assert not password_verify('ann-password-1', row['password'])


def test_email_change_is_refused_on_corporate(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    id = corp.gid('ann@corp.test')
    assert corp.admin().updateUser(as_admin({'user_id': id, 'email': 'other@corp.test'}))['status_code'] == 400


def test_delete_user_deletes_login_account(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    corp.admin().deleteUser(as_admin({}), corp.gid('ann@corp.test'))
    assert corp.loginRow('ann@corp.test') is None


def test_individual_edition_does_not_touch_login_database(corp):
    corp.admin('individual').createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    assert corp.loginRow('ann@corp.test') is None
    assert corp.gpt.fetch_one("SELECT * FROM users WHERE email = 'ann@corp.test'")['password'] is not None


def test_duplicate_email_create_returns_409_and_preserves_existing_login_password(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    r = corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'different-password-2'}))
    assert r['success'] is False
    assert r['status_code'] == 409
    row = corp.loginRow('ann@corp.test')
    assert password_verify('ann-password-1', row['password'])
    assert not password_verify('different-password-2', row['password'])


def test_gpt_insert_failure_rolls_back_newly_created_login_row(corp):
    broken = sqlite(GPT_USERS, PACKAGES)
    for r in ('guest', 'prospect', 'user', 'admin'):
        broken.execute('INSERT INTO packages (role, builtin) VALUES (?, 1)', [r])
    broken.execute("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')")
    broken.execute("CREATE TRIGGER forced_insert_failure BEFORE INSERT ON users WHEN NEW.id IS NOT 1"
                   " BEGIN SELECT RAISE(ABORT, 'forced failure for rollback test'); END")
    admin = AdminController(broken, {'edition': 'corporate'}, LoginAccounts(corp.login))
    with pytest.raises(Exception):
        admin.createUser(as_admin({'email': 'rollback@corp.test', 'password': 'rollback-password-1'}))
    assert corp.loginRow('rollback@corp.test') is None


def test_explicit_none_accounts_on_corporate_returns_503(corp):
    r = AdminController(corp.gpt, {'edition': 'corporate'}, None).createUser(
        as_admin({'email': 'noaccounts@corp.test', 'password': 'no-accounts-pw-1'}))
    assert r['success'] is False
    assert r['status_code'] == 503
    assert r['error'] == 'The login service is not configured'


def test_deleting_the_last_admin_is_refused(corp):
    r = corp.admin().deleteUser(as_admin({}), 1)
    assert r['status_code'] == 409
    assert r['error'] == 'The last administrator cannot be removed or demoted'
    assert corp.gpt.fetch_column('SELECT role FROM users WHERE id = 1')[0] == 'admin'


def test_deleting_the_last_admin_keeps_its_login_account(corp):
    corp.login.execute("INSERT INTO users (email, password, email_verified) VALUES ('boss@corp.test', 'x', 1)")
    corp.admin().deleteUser(as_admin({}), 1)
    assert corp.loginRow('boss@corp.test') is not None


def test_demoting_the_last_admin_is_refused(corp):
    r = corp.admin().updateUser(as_admin({'user_id': 1, 'email': 'boss@corp.test', 'role': 'user'}))
    assert r['status_code'] == 409
    assert r['error'] == 'The last administrator cannot be removed or demoted'
    assert corp.gpt.fetch_column('SELECT role FROM users WHERE id = 1')[0] == 'admin'


def test_updating_the_last_admin_without_changing_role_still_works(corp):
    assert corp.admin().updateUser(as_admin({'user_id': 1, 'email': 'boss@corp.test', 'first_name': 'Big', 'role': 'admin'}))['success']
    assert corp.admin().updateUser(as_admin({'user_id': 1, 'email': 'boss@corp.test', 'first_name': 'Bigger'}))['success']


def test_a_non_last_admin_can_be_demoted_and_deleted(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1', 'role': 'admin'}))
    corp.admin().createUser(as_admin({'email': 'bob@corp.test', 'password': 'bob-password-1', 'role': 'admin'}))
    ann = corp.gid('ann@corp.test')
    bob = corp.gid('bob@corp.test')
    assert corp.admin().updateUser(as_admin({'user_id': ann, 'email': 'ann@corp.test', 'role': 'user'}))['success']
    assert corp.gpt.fetch_column(f'SELECT role FROM users WHERE id = {ann}')[0] == 'user'
    assert corp.admin().deleteUser(as_admin({}), bob)['success']
    assert corp.loginRow('bob@corp.test') is None


def test_update_user_lowercases_email(corp):
    corp.admin().createUser(as_admin({'email': 'ann@corp.test', 'password': 'ann-password-1'}))
    id = corp.gid('ann@corp.test')
    assert corp.admin().updateUser(as_admin({'user_id': id, 'email': 'Ann@Corp.test'}))['success']
    assert corp.gpt.fetch_column(f'SELECT email FROM users WHERE id = {id}')[0] == 'ann@corp.test'


# ---------------------------------------------------------------- LoginAdminController (LoginAdminCorporateTest)

REFUSAL = 'Manage accounts from the Users screen on this installation'
WRITE_ROUTES = [
    ('createUser', {'email': 'ann@corp.test'}),
    ('updateUser', {'id': 2, 'first_name': 'Ann'}),
    ('deleteUser', {'id': 2}),
    ('setAppUserRole', {'app': 'gpt', 'user_id': 2, 'role': 'user'}),
    ('addAppMember', {'app': 'gpt', 'email': 'ann@corp.test', 'role': 'user'}),
]


def admin_db() -> SqliteDb:
    db = sqlite('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)')
    db.execute("INSERT INTO users (id, email, role) VALUES (1, 'boss@corp.test', 'admin')")
    return db


@pytest.mark.parametrize('method,body', WRITE_ROUTES, ids=[m for m, _ in WRITE_ROUTES])
def test_write_routes_are_refused_on_corporate_before_any_db_access(method, body):
    c = LoginAdminController(sqlite(), {'edition': 'corporate'})   # no tables: any query would raise
    r = getattr(c, method)({'user_id': 1, 'body': body})
    assert r['success'] is False
    assert r['status_code'] == 403
    assert r['error'] == REFUSAL


@pytest.mark.parametrize('method,body', WRITE_ROUTES, ids=[m for m, _ in WRITE_ROUTES])
def test_write_routes_are_not_refused_outside_corporate(method, body):
    for ed in ('individual', ''):
        c = LoginAdminController(admin_db(), {'edition': ed})
        r = getattr(c, method)({'user_id': 1, 'body': body})
        # No login_database configured: the call gets past the edition gate and the admin check,
        # and stops at the login connection.
        assert r.get('error') != REFUSAL
        assert r.get('message') == 'Login DB not reachable'


def test_reads_stay_allowed_on_corporate():
    r = LoginAdminController(admin_db(), {'edition': 'corporate'}).getUsers({'user_id': 1, 'query': {}})
    assert r.get('status_code') != 403
    assert r['available'] is False
