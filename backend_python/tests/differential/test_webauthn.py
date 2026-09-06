import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_challenge_and_authenticate_error_parity(both):
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'register'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate', 'credential_id': 'nope'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate', 'email': 'nobody@example.invalid'}, auth=False))
    a, b = both('POST', '/api/v1/webauthn/challenge', json={'action': 'authenticate'}, auth=False, headers={'Host': 'localhost'})
    assert a.status_code == b.status_code == 200
    assert {k: v for k, v in a.json().items() if k != 'challenge'} == {k: v for k, v in b.json().items() if k != 'challenge'}
    same(*both('POST', '/api/v1/webauthn/authenticate', json={'credential_id': 'x'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/authenticate', json={'credential_id': 'nope', 'signature': 's'}, auth=False))
    same(*both('POST', '/api/v1/webauthn/register', json={}, auth=False))          # 401 from middleware
    same(*both('POST', '/api/v1/webauthn/register', json={'credential_id': 'x'}))  # 400
    same(*both('DELETE', '/api/v1/webauthn/register', json={}))                    # 400
    same(*both('DELETE', '/api/v1/webauthn/register', json={'credential_id': 'diff-none'}))  # 200 not found message
