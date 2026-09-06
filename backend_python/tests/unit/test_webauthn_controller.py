import jwt
from starlette.datastructures import Headers
from app.controllers.webauthn_controller import WebAuthnController
from app.support.http import Ctx

CONFIG = {'auth': {'jwt_secret': 's', 'jwt_expiry': 28800, 'refresh_expiry': 604800}}


class FakeDb:
    def __init__(self, one=None, all_=None, rowcount=1):
        self.one = list(one or []); self.all_ = list(all_ or []); self.rowcount = rowcount; self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.all_.pop(0) if self.all_ else []
    def execute(self, s, p=None): self.calls.append((s, p)); return self.rowcount
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


def ctx(body=None, user_id=None, host='localhost:3002'):
    return Ctx(method='POST', uri='/', headers=Headers({'host': host}), query={}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


def test_challenge_register_requires_auth_and_authenticate_by_email():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.challenge(ctx({'action': 'register'}))['status_code'] == 401
    db = FakeDb(one=[{'id': 3}], all_=[[{'credential_id': 'abc'}]])
    r = WebAuthnController(db, CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'a@b.c'}))
    assert r['success'] and r['rp_id'] == 'localhost' and r['rp_name'] == 'Voice Assistant'
    assert r['allow_credentials'] == [{'id': 'abc', 'type': 'public-key', 'transports': ['internal']}]
    assert len(r['challenge']) == 43 and '=' not in r['challenge']
    assert any('INSERT INTO webauthn_challenges' in s for s, _ in db.calls)


def test_challenge_error_codes():
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).challenge(ctx({'action': 'authenticate', 'credential_id': 'x'}))['code'] == 'CREDENTIAL_NOT_FOUND'
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'x'}))['code'] == 'USER_NOT_FOUND'
    assert WebAuthnController(FakeDb(one=[{'id': 1}], all_=[[]]), CONFIG).challenge(ctx({'action': 'authenticate', 'email': 'x'}))['code'] == 'NO_CREDENTIALS'
    db = FakeDb()
    r = WebAuthnController(db, CONFIG).challenge(ctx({'action': 'authenticate'}))
    assert r['success'] and not any('INSERT' in s for s, _ in db.calls)     # user_id 0 → not stored


def test_register_and_delete():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.register(ctx({}))['status_code'] == 401
    assert c.register(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential ID and public key are required'
    assert WebAuthnController(FakeDb(one=[{'id': 1}]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['status_code'] == 409
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['message'] == 'Credential registered successfully'
    assert WebAuthnController(FakeDb(rowcount=0), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential not found or not owned by user'
    assert WebAuthnController(FakeDb(rowcount=1), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential deleted'


def test_authenticate_issues_token_and_string_id():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.authenticate(ctx({'credential_id': 'x'}))['message'] == 'Credential ID and signature are required'
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's'}))['code'] == 'CREDENTIAL_NOT_FOUND'
    row = {'uid': 3, 'email': 'e', 'first_name': 'f', 'last_name': 'l', 'role': 'admin', 'plan': 'premium',
           'provider': 'email', 'created_at': 'c'}
    assert WebAuthnController(FakeDb(one=[row]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's'}))['message'] == 'Invalid authentication data'
    r = WebAuthnController(FakeDb(one=[row]), CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's', 'authenticator_data': 'a'}))
    # PyJWT >=2.10 raises InvalidSubjectError for a non-string `sub` unless verify_sub
    # is disabled (same reason as test_auth_controller.py / app.middleware.auth.decode_hs256).
    claims = jwt.decode(r['token'], 's', algorithms=['HS256'], options={'verify_sub': False})
    assert r['success'] and r['user']['id'] == '3' and claims['sub'] == 3
    assert list(r['user']) == ['id', 'email', 'first_name', 'last_name', 'role', 'plan', 'provider', 'last_login', 'created_at']
