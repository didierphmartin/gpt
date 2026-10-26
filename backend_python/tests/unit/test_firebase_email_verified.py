"""Port of backend/tests/Unit/Controllers/FirebaseEmailVerifiedTest.php.

Firebase sign-in reaches an existing account by email only when Firebase verified that email."""
from __future__ import annotations

import pytest

from app.controllers import auth_controller
from app.controllers.auth_controller import AuthController
from tests.unit.playbook.conftest import sqlite_db

SECRET = 'test-secret-0123456789-0123456789'


@pytest.fixture
def db():
    d = sqlite_db(
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, '
        "first_name TEXT, last_name TEXT, role TEXT, plan TEXT DEFAULT 'free', provider TEXT, "
        "kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0, firebase_uid TEXT, phone TEXT, "
        'ledger_user_id TEXT, last_login TEXT, app_key_hash TEXT, app_key_prefix TEXT, app_key_created_at TEXT, '
        'created_at TEXT, updated_at TEXT)',
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)')
    d.execute("INSERT INTO users (id, email, role, plan, firebase_uid) VALUES "
              "(1, 'boss@x.test', 'admin', 'premium', NULL), (2, 'own@x.test', 'user', 'free', 'uid-own')")
    return d


@pytest.fixture
def sign_in(db, monkeypatch):
    """The verified Firebase claims (PHP overrides verifyFirebaseIdToken())."""
    def run(claims: dict) -> dict:
        monkeypatch.setattr(auth_controller, 'verify_firebase_id_token', lambda token, project: claims or None)
        c = AuthController(db, {'auth': {'jwt_secret': SECRET}})
        return c.firebaseAuth({'body': {'idToken': 'x', 'provider': 'password'}})
    return run


def firebase_uid(db, user_id):
    return db.fetch_one('SELECT firebase_uid FROM users WHERE id = ?', [user_id])['firebase_uid']


@pytest.mark.parametrize('extra', [{}, {'email_verified': False}])
def test_unverified_email_does_not_reach_an_existing_account(db, sign_in, extra):
    r = sign_in({'sub': 'uid-attacker', 'email': 'boss@x.test', **extra})
    assert r['code'] == 'EMAIL_NOT_VERIFIED'
    assert r['status_code'] == 401
    assert r['message'] == 'Verify your email address first, then sign in again.'
    assert 'data' not in r
    assert firebase_uid(db, 1) is None


def test_verified_email_links_and_signs_in(db, sign_in):
    r = sign_in({'sub': 'uid-boss', 'email': 'boss@x.test', 'email_verified': True})
    assert r['status_code'] == 200
    assert firebase_uid(db, 1) == 'uid-boss'


def test_the_imported_firebase_user_of_the_row_signs_in_unverified(sign_in):
    r = sign_in({'sub': 'local-1', 'email': 'boss@x.test'})
    assert r['status_code'] == 200


def test_the_accounts_own_firebase_user_signs_in_unverified(sign_in):
    r = sign_in({'sub': 'uid-own', 'email': 'own@x.test'})
    assert r['status_code'] == 200
