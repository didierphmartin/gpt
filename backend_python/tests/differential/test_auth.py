import time
import uuid
import pytest
from app.db import open_primary
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_login_validation_and_bad_credentials(both):
    same(*both('POST', '/api/v1/auth/login', json={'email': '', 'password': ''}, auth=False))
    same(*both('POST', '/api/v1/auth/login', json={'email': 'nobody@example.invalid', 'password': 'x'}, auth=False))


def test_register_validation_matrix(both):
    same(*both('POST', '/api/v1/auth/register', json={'email': 'x@y.com'}, auth=False))
    same(*both('POST', '/api/v1/auth/register', json={'email': 'bad', 'password': 'p'}, auth=False))
    same(*both('POST', '/api/v1/auth/register', json={'email': 'x@y.com', 'password': 'p'}, auth=False))


def test_legacy_action_dispatcher(both):
    same(*both('POST', '/api/v1/auth', json={'action': 'nope'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'logout'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'upgrade_plan', 'plan': 'premium'}, auth=False))
    same(*both('POST', '/api/v1/auth', json={'action': 'upgrade_plan', 'plan': 'gold'}))   # authed, invalid plan
    same(*both('POST', '/api/v1/auth', json={'action': 'link_phone', 'phone_number': ''}))


def test_verify_and_logout(both, token):
    same(*both('POST', '/api/v1/auth/verify'))
    same(*both('POST', '/api/v1/auth/verify', headers={'Authorization': 'Bearer junk'}, auth=False))
    same(*both('POST', '/api/v1/auth/logout', auth=False))


def test_debug_auth(both):
    same(*both('GET', '/api/v1/debug/auth'))


def test_register_on_python_login_on_php_and_vice_versa(php, py, config):
    email_a = f'diff-{uuid.uuid4().hex[:10]}@example.invalid'
    email_b = f'diff-{uuid.uuid4().hex[:10]}@example.invalid'
    body = lambda e: {'email': e, 'password': 'Pw-123456', 'ledger_user_id': 'diff-test', 'plan': 'standard'}
    try:
        ra = py.post('/api/v1/auth/register', json=body(email_a)); assert ra.status_code == 200, ra.text
        rb = php.post('/api/v1/auth/register', json=body(email_b)); assert rb.status_code == 200, rb.text
        # shape parity (ignore ids/tokens/timestamps)
        ua, ub = ra.json()['data']['user'], rb.json()['data']['user']
        assert list(ua) == list(ub) and ua['role'] == ub['role'] == 'user' and ua['plan'] == ub['plan'] == 'standard'
        # cross-login
        la = php.post('/api/v1/auth/login', json={'email': email_a, 'password': 'Pw-123456'})
        lb = py.post('/api/v1/auth/login', json={'email': email_b, 'password': 'Pw-123456'})
        assert la.status_code == 200 and lb.status_code == 200, (la.text, lb.text)
        # token interop: python-minted token verifies on PHP and vice versa
        ta, tb = ra.json()['data']['access_token'], rb.json()['data']['access_token']
        assert php.post('/api/v1/auth/verify', headers={'Authorization': f'Bearer {ta}'}).json()['data']['user_id'] == ua['id']
        assert py.post('/api/v1/auth/verify', headers={'Authorization': f'Bearer {tb}'}).json()['data']['user_id'] == ub['id']
    finally:
        db = open_primary(config)
        db.execute('DELETE FROM users WHERE email IN (?, ?)', [email_a, email_b])
        db.close()


def test_firebase_reject_parity(both):
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': ''}, auth=False))
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': 'garbage'}, auth=False))
    forged = ('eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.'
              'eyJhdWQiOiJ0cmFuc2xlZGdlcnNpdGUiLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vdHJhbnNsZWRnZXJzaXRlIiwic3ViIjoieCJ9.'
              'c2ln')
    same(*both('POST', '/api/v1/auth/firebase', json={'provider': 'google', 'idToken': forged}, auth=False))
