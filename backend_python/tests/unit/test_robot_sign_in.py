"""Port of backend/tests/Unit/Controllers/RobotSignInTest.php.

The robot (users.kind = 'service') is never a person: no token, no app key, not editable."""
from __future__ import annotations

import time

import jwt
import pytest

from app.controllers import auth_controller
from app.controllers.admin_controller import AdminController
from app.controllers.auth_controller import AuthController
from app.controllers.webauthn_controller import WebAuthnController
from app.services.robot_account import RobotAccount
from tests.unit.playbook.conftest import sqlite_db

SECRET = 'test-secret-0123456789-0123456789'
LOGIN_SECRET = 'login-secret-0123456789-0123456789'


@pytest.fixture
def db():
    d = sqlite_db(
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, '
        "first_name TEXT, last_name TEXT, role TEXT, plan TEXT DEFAULT 'free', provider TEXT, "
        "kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0, firebase_uid TEXT, phone TEXT, "
        'ledger_user_id TEXT, last_login TEXT, app_key_hash TEXT, app_key_prefix TEXT, app_key_created_at TEXT, '
        'created_at TEXT, updated_at TEXT)',
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)',
        'CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, credential_id TEXT)')
    d.execute("INSERT INTO users (id, email, role, plan) VALUES (1, 'boss@x.test', 'admin', 'premium')")
    return d


@pytest.fixture
def robot_id(db):
    return RobotAccount.ensure(db)


class _AuthWithSeams(AuthController):
    """The login-service database, answered from sqlite (PHP overrides loginDbConnection())."""

    def _login_db_connection(self, ld):
        login = sqlite_db('CREATE TABLE users (id INTEGER, email TEXT, email_verified INTEGER)')
        login.execute("INSERT INTO users VALUES (1, 'robot@synergyai.invalid', 1)")
        login.close = lambda: None
        return login


@pytest.fixture
def auth(db):
    return _AuthWithSeams(db, {'auth': {'jwt_secret': SECRET, 'login_jwt_secret': LOGIN_SECRET}, 'login_db': {}})


@pytest.fixture
def claims(monkeypatch):
    """The verified Firebase claims (PHP overrides verifyFirebaseIdToken())."""
    box = {}
    monkeypatch.setattr(auth_controller, 'verify_firebase_id_token', lambda token, project: box.get('claims') or None)
    return box


def row_count(db) -> int:
    return db.fetch_column('SELECT COUNT(*) FROM users')[0]


def test_password_login_as_robot_is_the_unknown_account_answer(auth, robot_id):
    r = auth.login({'body': {'email': RobotAccount.EMAIL, 'password': 'anything'}})
    assert r['status_code'] == 401
    assert r['message'] == 'Invalid email or password'
    assert 'data' not in r


def test_sso_exchange_for_robot_answers_like_no_account(auth, robot_id):
    now = int(time.time())
    tok = jwt.encode({'iss': 'login-service', 'type': 'access', 'sub': 1, 'iat': now, 'exp': now + 60},
                     LOGIN_SECRET, algorithm='HS256')
    r = auth.ssoExchange({'body': {'login_token': tok}})
    assert r['status_code'] == 403
    assert r['message'].startswith('No account for robot@synergyai.invalid')
    assert 'data' not in r


def test_firebase_for_robot_is_refused_and_touches_nothing(db, auth, claims, robot_id):
    claims['claims'] = {'sub': 'uid-1', 'email': RobotAccount.EMAIL}
    r = auth.firebaseAuth({'body': {'idToken': 'x', 'provider': 'google', 'plan': 'premium'}})
    assert r['status_code'] == 401
    assert 'data' not in r
    row = db.fetch_one("SELECT * FROM users WHERE kind = 'service'")
    assert row['firebase_uid'] is None
    assert row['last_login'] is None
    assert row['role'] == 'robot'
    assert row_count(db) == 2


def test_webauthn_for_robot_is_credential_not_found(db, robot_id):
    db.execute(f"INSERT INTO webauthn_credentials (user_id, credential_id) VALUES ({robot_id}, 'cred-r')")
    w = WebAuthnController(db, {'auth': {'jwt_secret': SECRET}})
    r = w.authenticate({'body': {'credential_id': 'cred-r', 'signature': 's', 'authenticator_data': 'a',
                                 'client_data_json': 'c'}})
    assert r['status_code'] == 404
    assert r['code'] == 'CREDENTIAL_NOT_FOUND'
    assert 'token' not in r


def test_paid_plan_resign_in_keeps_custom_and_user_roles_but_promotes_prospect(db, auth, claims, robot_id):
    db.execute("""INSERT INTO users (email, role, plan) VALUES
        ('ops@x.test', 'it-ops-2', 'free'), ('u@x.test', 'user', 'free'), ('p@x.test', 'prospect', 'free'),
        ('g@x.test', 'guest', 'free')""")
    expect = {'ops@x.test': 'it-ops-2', 'u@x.test': 'user', 'p@x.test': 'user', 'g@x.test': 'user'}
    for email, role in expect.items():
        claims['claims'] = {'sub': 'uid-' + email, 'email': email}
        r = auth.firebaseAuth({'body': {'idToken': 'x', 'provider': 'google', 'plan': 'premium'}})
        assert r['success'] is True, email
        got = db.fetch_one('SELECT role, plan FROM users WHERE email = ?', [email])
        assert got['role'] == role, email
        assert got['plan'] == 'premium', email
        assert r['data']['user']['role'] == role, email


def test_no_personal_app_key_for_the_robot(db, auth, robot_id):
    r = auth.generateAppKey({'user_id': robot_id, 'auth_type': 'jwt'})
    assert r['success'] is False
    r = auth.adminGenerateAppKeyForUser({'user_id': 1, 'auth_type': 'jwt', 'body': {'user_id': robot_id}})
    assert r['status_code'] == 404
    assert r['message'] == 'User not found'
    assert db.fetch_column(f'SELECT app_key_hash FROM users WHERE id = {robot_id}') == [None]
    # A person still gets one.
    assert auth.adminGenerateAppKeyForUser({'user_id': 1, 'auth_type': 'jwt', 'body': {'user_id': 1}})['success'] is True


def test_admin_never_sees_or_edits_the_robot(db, robot_id):
    a = AdminController(db, {})
    rq = {'user_id': 1}
    assert [int(u['id']) for u in a.listUsers(rq)['users']] == [1]
    for r in (
        a.getUser(rq, robot_id),
        a.getUserAccount(rq, robot_id),
        a.updateUser({**rq, 'body': {'user_id': robot_id, 'email': 'x@x.test', 'role': 'user'}}),
        a.deleteUser(rq, robot_id),
    ):
        assert r['status_code'] == 404
        assert r['error'] == 'User not found'
    assert row_count(db) == 2
    assert db.fetch_column(f'SELECT email FROM users WHERE id = {robot_id}') == [RobotAccount.EMAIL]


def test_admin_create_and_update_refuse_an_unknown_role(db, robot_id):
    a = AdminController(db, {})
    r = a.createUser({'user_id': 1, 'body': {'email': 'n@x.test', 'password': 'pw-123456', 'role': 'nope'}})
    assert [r['success'], r['error'], r['status_code']] == [False, 'Invalid role', 400]
    assert row_count(db) == 2
    db.execute("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('it-ops-2', 'IT Ops', 0, '{}')")
    assert a.createUser({'user_id': 1, 'body': {'email': 'n@x.test', 'password': 'pw-123456',
                                                'role': 'it-ops-2'}})['success'] is True
    r = a.updateUser({'user_id': 1, 'body': {'user_id': 1, 'email': 'boss@x.test', 'role': ['admin']}})
    assert r['status_code'] == 400 and r['error'] == 'Invalid role'
