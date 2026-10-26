"""Port of backend/tests/Unit/Controllers/WebAuthnSignInOffTest.php.

Passkey sign-in is off until assertions are verified: no token, and no credential ids handed out by email."""
from __future__ import annotations

import pytest

from app.controllers.webauthn_controller import WebAuthnController
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)',
                  'CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT, public_key TEXT)')
    d.execute("INSERT INTO users (id, email) VALUES (1, 'admin@x.test')")
    d.execute("INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (1, 'cred-1', 'pk')")
    return d


def test_authenticate_never_issues_a_token(db):
    r = WebAuthnController(db, {}).authenticate({'body': {
        'credential_id': 'cred-1', 'signature': 'x', 'authenticator_data': 'x', 'client_data_json': 'x',
    }})
    assert r['code'] == 'PASSKEY_SIGNIN_OFF'
    assert r['success'] is False
    assert r['status_code'] == 503
    assert 'token' not in r


def test_sign_in_challenge_hands_out_no_credential_ids(db):
    w = WebAuthnController(db, {})
    for who in ({'email': 'admin@x.test'}, {'credential_id': 'cred-1'}, {}):
        r = w.challenge({'body': {'action': 'authenticate', **who}})
        assert r['code'] == 'PASSKEY_SIGNIN_OFF'
        assert 'allow_credentials' not in r
        assert 'challenge' not in r


def test_register_challenge_still_requires_a_signed_in_user(db):
    r = WebAuthnController(db, {}).challenge({'body': {'action': 'register'}})
    assert r['status_code'] == 401
