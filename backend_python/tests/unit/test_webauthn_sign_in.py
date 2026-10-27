"""Port of backend/tests/Unit/Controllers/WebAuthnSignInTest.php.

Passkey sign-in issues a token only for a verified assertion: real keys, real signatures."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time

import jwt
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from app.controllers.webauthn_controller import WebAuthnController
from tests.unit.playbook.conftest import sqlite_db

SECRET = 'test-secret-0123456789-0123456789'


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def sign(key, data: bytes) -> bytes:
    if isinstance(key, ec.EllipticCurvePrivateKey):
        return key.sign(data, ec.ECDSA(hashes.SHA256()))
    return key.sign(data, padding.PKCS1v15(), hashes.SHA256())


@pytest.fixture
def keys():
    return {}


@pytest.fixture
def db(keys):
    d = sqlite_db(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,"
        " kind TEXT NOT NULL DEFAULT 'person', role TEXT, plan TEXT, ledger_user_id TEXT, provider TEXT, last_login TEXT, created_at TEXT)",
        'CREATE TABLE webauthn_credentials (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT, public_key TEXT, created_at TEXT)',
        'CREATE TABLE webauthn_challenges (challenge TEXT PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT, created_at TEXT)')
    d.conn.create_function('UNIX_TIMESTAMP', 1, lambda t: int(time.mktime(time.strptime(t, '%Y-%m-%d %H:%M:%S'))))
    d.execute("INSERT INTO users (id, email, first_name, role, plan) VALUES (1, 'ada@x.test', 'Ada', 'user', 'premium')")
    d.execute("INSERT INTO users (id, email, kind, role) VALUES (2, 'robot@x.test', 'service', 'robot')")
    for user_id, cred_id, key in ((1, 'cred-ec', ec.generate_private_key(ec.SECP256R1())),
                                  (1, 'cred-rsa', rsa.generate_private_key(65537, 2048)),
                                  (2, 'cred-robot', ec.generate_private_key(ec.SECP256R1()))):
        # The DER SubjectPublicKeyInfo as base64url, as the frontend's getPublicKey() sends it.
        der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        d.execute('INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (?, ?, ?)', [user_id, cred_id, b64u(der)])
        keys[cred_id] = key
    return d


def controller(db, webauthn=None) -> WebAuthnController:
    return WebAuthnController(db, {'auth': {'jwt_secret': SECRET},
                                   'webauthn': {'rp_id': 'localhost'} if webauthn is None else webauthn})


def req(body, host=None):
    return {'body': body, 'headers': {'host': host} if host else {}}


def challenge_for(w, cred_id, host=None) -> str:
    r = w.challenge(req({'action': 'authenticate', 'credential_id': cred_id}, host))
    assert r['success']
    return r['challenge']


def assertion(keys, cred_id, challenge, **o) -> dict:
    """Build and sign an assertion; keyword arguments override any part."""
    client_data = json.dumps({'type': o.get('type', 'webauthn.get'), 'challenge': challenge,
                              'origin': o.get('origin', 'http://localhost'), 'crossOrigin': False}).encode()
    auth_data = hashlib.sha256(o.get('rp_id', 'localhost').encode()).digest() + bytes([o.get('flags', 0x05)]) + (1).to_bytes(4, 'big')
    sig = sign(o.get('key', keys[cred_id]), auth_data + hashlib.sha256(client_data).digest())
    return {'credential_id': cred_id, 'client_data_json': b64u(client_data),
            'authenticator_data': b64u(auth_data), 'signature': b64u(o.get('signature', sig))}


def sign_in(db, keys, cred_id, w=None, host=None, **o) -> dict:
    w = w or controller(db)
    return w.authenticate(req(assertion(keys, cred_id, challenge_for(w, cred_id, host), **o), host))


def assert_refused(r):
    assert r['status_code'] == 401
    assert r['success'] is False
    assert r['message'] == 'Passkey sign-in failed'
    assert 'token' not in r


def challenge_count(db) -> int:
    return db.fetch_one('SELECT COUNT(*) AS n FROM webauthn_challenges')['n']


def add_challenge(db, challenge, user_id, action='authenticate', age=0):
    db.execute('INSERT INTO webauthn_challenges VALUES (?, ?, ?, ?)',
               [challenge, user_id, action, time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - age))])


def test_es256_assertion_signs_in(db, keys):
    r = sign_in(db, keys, 'cred-ec')
    assert r['success'] is True and r['status_code'] == 200
    assert jwt.decode(r['token'], SECRET, algorithms=['HS256'], options={'verify_sub': False})['sub'] == 1
    assert r['user']['id'] == '1'
    assert r['user']['email'] == 'ada@x.test'
    assert r['user']['plan'] == 'premium'
    assert db.fetch_one('SELECT last_login FROM users WHERE id = 1')['last_login'] is not None
    assert challenge_count(db) == 0


def test_rs256_assertion_signs_in(db, keys):
    r = sign_in(db, keys, 'cred-rsa')
    assert r['success'] is True and r['user']['id'] == '1'


def test_signature_from_another_key_is_refused(db, keys):
    assert_refused(sign_in(db, keys, 'cred-ec', key=keys['cred-rsa']))


def test_tampered_signature_is_refused(db, keys):
    assert_refused(sign_in(db, keys, 'cred-ec', signature=os.urandom(70)))


def test_challenge_never_issued_is_refused(db, keys):
    w = controller(db)
    challenge_for(w, 'cred-ec')
    assert_refused(w.authenticate(req(assertion(keys, 'cred-ec', b64u(os.urandom(32))))))


def test_challenge_of_another_user_is_refused(db, keys):
    db.execute("INSERT INTO users (id, email) VALUES (3, 'eve@x.test')")
    add_challenge(db, 'eve-challenge', 3)
    assert_refused(controller(db).authenticate(req(assertion(keys, 'cred-ec', 'eve-challenge'))))
    assert challenge_count(db) == 0


def test_register_challenge_is_not_a_sign_in_challenge(db, keys):
    add_challenge(db, 'reg-challenge', 1, action='register')
    assert_refused(controller(db).authenticate(req(assertion(keys, 'cred-ec', 'reg-challenge'))))


def test_challenge_is_single_use(db, keys):
    w = controller(db)
    body = assertion(keys, 'cred-ec', challenge_for(w, 'cred-ec'))
    assert w.authenticate(req(body))['success'] is True
    assert_refused(w.authenticate(req(body)))


def test_failed_attempt_still_consumes_the_challenge(db, keys):
    w = controller(db)
    challenge = challenge_for(w, 'cred-ec')
    assert_refused(w.authenticate(req(assertion(keys, 'cred-ec', challenge, origin='https://evil.test'))))
    assert_refused(w.authenticate(req(assertion(keys, 'cred-ec', challenge))))


def test_expired_challenge_is_refused(db, keys):
    add_challenge(db, 'old-challenge', 1, age=121)
    assert_refused(controller(db).authenticate(req(assertion(keys, 'cred-ec', 'old-challenge'))))
    assert challenge_count(db) == 0


def test_wrong_origin_is_refused(db, keys):
    for origin in ('https://evil.test', 'http://localhost.evil.test', 'http://localhost/path', 'https://user@localhost'):
        assert_refused(sign_in(db, keys, 'cred-ec', origin=origin))


def test_localhost_origin_on_any_port_is_allowed(db, keys):
    assert sign_in(db, keys, 'cred-ec', origin='http://localhost:8080')['success'] is True


def test_origin_must_be_https_off_localhost(db, keys):
    w = controller(db, {})
    host = 'synergyaichat.com:443'
    assert sign_in(db, keys, 'cred-ec', w, host, rp_id='synergyaichat.com', origin='https://synergyaichat.com')['success'] is True
    assert_refused(sign_in(db, keys, 'cred-ec', w, host, rp_id='synergyaichat.com', origin='http://synergyaichat.com'))


def test_configured_origins_are_the_only_ones_allowed(db, keys):
    w = controller(db, {'rp_id': 'localhost', 'origins': ['chrome-extension://abc']})
    assert sign_in(db, keys, 'cred-ec', w, origin='chrome-extension://abc')['success'] is True
    assert_refused(sign_in(db, keys, 'cred-ec', w, origin='http://localhost'))


def test_wrong_rp_id_hash_is_refused(db, keys):
    assert_refused(sign_in(db, keys, 'cred-ec', rp_id='evil.test'))


def test_missing_user_verification_or_presence_is_refused(db, keys):
    assert_refused(sign_in(db, keys, 'cred-ec', flags=0x01))
    assert_refused(sign_in(db, keys, 'cred-ec', flags=0x04))


def test_registration_type_is_refused(db, keys):
    assert_refused(sign_in(db, keys, 'cred-ec', type='webauthn.create'))


def test_unknown_credential_is_not_found(db, keys):
    r = controller(db).authenticate(req({**assertion(keys, 'cred-ec', 'x'), 'credential_id': 'nope'}))
    assert r['status_code'] == 404 and r['code'] == 'CREDENTIAL_NOT_FOUND'
    assert 'token' not in r


def test_service_user_is_not_found_even_with_a_valid_assertion(db, keys):
    add_challenge(db, 'robot-challenge', 2)
    r = controller(db).authenticate(req(assertion(keys, 'cred-robot', 'robot-challenge')))
    assert r['status_code'] == 404 and r['code'] == 'CREDENTIAL_NOT_FOUND'
    assert 'token' not in r


def test_missing_fields_are_a_bad_request(db, keys):
    full = assertion(keys, 'cred-ec', 'x')
    for field in full:
        body = {k: v for k, v in full.items() if k != field}
        r = controller(db).authenticate(req(body))
        assert r['status_code'] == 400, field
        assert 'token' not in r


def test_email_challenge_lists_that_users_credentials_and_signs_in(db, keys):
    r = controller(db).challenge(req({'action': 'authenticate', 'email': 'ada@x.test'}))
    assert r['success'] is True
    assert sorted(c['id'] for c in r['allow_credentials']) == ['cred-ec', 'cred-rsa']
    assert db.fetch_one('SELECT user_id FROM webauthn_challenges')['user_id'] == 1
    assert controller(db).authenticate(req(assertion(keys, 'cred-rsa', r['challenge'])))['success'] is True


def test_discoverable_challenge_is_refused(db):
    r = controller(db).challenge(req({'action': 'authenticate'}))
    assert r['status_code'] == 400 and r['code'] == 'EMAIL_REQUIRED'
    assert 'challenge' not in r
    assert challenge_count(db) == 0


def test_challenge_for_unknown_credential_is_not_found(db):
    r = controller(db).challenge(req({'action': 'authenticate', 'credential_id': 'nope'}))
    assert r['status_code'] == 404
    assert challenge_count(db) == 0


def test_register_challenge_still_requires_a_signed_in_user(db):
    assert controller(db).challenge(req({'action': 'register'}))['status_code'] == 401
    r = controller(db).challenge({'user_id': 1, **req({'action': 'register'})})
    assert r['success'] is True and r['rp_id'] == 'localhost'
