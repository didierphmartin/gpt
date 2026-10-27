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


def test_challenge_register_requires_auth_and_stores_the_challenge():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.challenge(ctx({'action': 'register'}))['status_code'] == 401
    db = FakeDb()
    r = WebAuthnController(db, CONFIG).challenge(ctx({'action': 'register'}, user_id=3))
    assert r['success'] and r['rp_id'] == 'localhost' and r['rp_name'] == 'Voice Assistant'
    assert r['allow_credentials'] == []
    assert len(r['challenge']) == 43 and '=' not in r['challenge']
    assert any('INSERT INTO webauthn_challenges' in s for s, _ in db.calls)


def test_sign_in_challenge_without_id_or_email_reads_nothing():
    for body in ({'action': 'authenticate'}, {}):
        db = FakeDb()
        r = WebAuthnController(db, CONFIG).challenge(ctx(body))
        assert r['status_code'] == 400 and 'challenge' not in r
        assert db.calls == []


def test_register_and_delete():
    c = WebAuthnController(FakeDb(), CONFIG)
    assert c.register(ctx({}))['status_code'] == 401
    assert c.register(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential ID and public key are required'
    assert WebAuthnController(FakeDb(one=[{'id': 1}]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['status_code'] == 409
    assert WebAuthnController(FakeDb(one=[None]), CONFIG).register(ctx({'credential_id': 'x', 'public_key': 'k'}, user_id=3))['message'] == 'Credential registered successfully'
    assert WebAuthnController(FakeDb(rowcount=0), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential not found or not owned by user'
    assert WebAuthnController(FakeDb(rowcount=1), CONFIG).delete(ctx({'credential_id': 'x'}, user_id=3))['message'] == 'Credential deleted'


def test_authenticate_with_a_missing_field_reads_nothing():
    db = FakeDb()
    r = WebAuthnController(db, CONFIG).authenticate(ctx({'credential_id': 'x', 'signature': 's', 'authenticator_data': 'a'}))
    assert r == {'success': False,
                 'message': 'Credential ID, client data, authenticator data and signature are required',
                 'status_code': 400}
    assert db.calls == []
