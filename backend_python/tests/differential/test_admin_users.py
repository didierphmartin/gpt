"""AdminController (part 1: users, providers, keys) PHP-vs-Python differential.

Admin identity: user 3's `role` is 'admin' (verified live) — every admin route
below is exercised for real, not skipped to 403-only. PHP-first; self-cleaning;
this file only (per constraints.md, run in isolation from the other Phase 7
differential suites).
"""
import time

import pytest

from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential

TMP_EMAIL = 'differential-tmp-user@example.com'


def _round_floats(obj, ndigits=6):
    """Recursively round every float so the comparison tolerates float noise.

    This XAMPP box's Apache php.ini sets `serialize_precision=100` (not the
    normal -1 "shortest round-trip" default) — CLI php.ini uses -1, but the
    Apache one that actually serves this differential's PHP requests is 100 —
    so PHP's json_encode of any float that is not exactly representable in
    binary (i.e. almost every value computed as tokens * price / 1e6, not
    merely read back from a column) leaks ~50 raw IEEE754 digits, e.g.
    "1.0739000000000000767386154620908200740814208984375" for round(x, 4)'s
    Python-side 1.0739. That's an environment quirk of this one machine's
    php.ini, not an application difference — the Python port already applies
    the same round(x, 4)/round(x, 2) PHP does (AdminController.php:2981-3009);
    only the JSON text differs. Compared post-round so both sides read the
    intended (correct) numeric value.
    """
    if isinstance(obj, float):
        return round(obj, ndigits)
    if isinstance(obj, dict):
        return {k: _round_floats(v, ndigits) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round_floats(v, ndigits) for v in obj]
    return obj


def same_rounded(a, b, ndigits=6):
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = _round_floats(a.json(), ndigits), _round_floats(b.json(), ndigits)
    assert ja == jb, (ja, jb)


@pytest.fixture
def h(token):
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture(autouse=True)
def _admin_is_role_admin(php, h):
    r = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}', headers=h)
    assert r.status_code == 200 and r.json()['user']['role'] == 'admin', \
        'constraints.md requires user 3 to be role=admin for this suite to run unskipped'


def _delete_tmp_user_via(client, h):
    """Best-effort cleanup: look the tmp user up by listing (no lookup-by-email
    route exists) and delete by id if found."""
    users = client.get('/api/v1/admin/users', headers=h).json().get('users', [])
    for u in users:
        if u.get('email') == TMP_EMAIL:
            client.delete(f"/api/v1/admin/users/{u['id']}", headers=h)


@pytest.fixture(autouse=True)
def _cleanup_tmp_user(php, h):
    _delete_tmp_user_via(php, h)
    yield
    _delete_tmp_user_via(php, h)


# ─── reads ───────────────────────────────────────────────────────────────────

def test_admin_reads_are_identical(both, h):
    same(*both('GET', '/api/v1/admin/users', headers=h))
    same(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}', headers=h))
    same(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}/account', headers=h))
    same(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h))
    same_rounded(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}/costs', headers=h))
    same(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}/keys', headers=h))


def test_admin_routes_require_auth(both):
    for path in (
        '/api/v1/admin/users', f'/api/v1/admin/users/{DIFF_USER_ID}',
        f'/api/v1/admin/users/{DIFF_USER_ID}/account', f'/api/v1/admin/users/{DIFF_USER_ID}/providers',
        f'/api/v1/admin/users/{DIFF_USER_ID}/costs', f'/api/v1/admin/users/{DIFF_USER_ID}/keys',
    ):
        same(*both('GET', path, auth=False))


# ─── not-found parity ────────────────────────────────────────────────────────

def test_not_found_parity(both, h):
    same(*both('GET', '/api/v1/admin/users/999999999', headers=h))
    same(*both('GET', '/api/v1/admin/users/999999999/account', headers=h))
    same(*both('DELETE', '/api/v1/admin/users/999999999', headers=h))


# ─── validation (no writes) ─────────────────────────────────────────────────

def test_create_user_validation(both, h):
    same(*both('POST', '/api/v1/admin/users', json={}, headers=h))
    same(*both('POST', '/api/v1/admin/users', json={'email': 'x@y.com'}, headers=h))


def test_update_user_validation(both, h):
    same(*both('POST', '/api/v1/admin/users/update', json={'user_id': 0}, headers=h))
    same(*both('POST', '/api/v1/admin/users/update',
               json={'user_id': DIFF_USER_ID, 'role': 'superadmin'}, headers=h))


def test_provider_validation(both, h):
    same(*both('POST', '/api/v1/admin/providers', json={'user_id': DIFF_USER_ID, 'category': 'x'}, headers=h))
    same(*both('POST', '/api/v1/admin/providers',
               json={'user_id': DIFF_USER_ID, 'category': 'voice'}, headers=h))
    same(*both('POST', '/api/v1/admin/providers/toggle',
               json={'user_id': DIFF_USER_ID, 'category': 'nope', 'provider': 'grok'}, headers=h))
    same(*both('POST', '/api/v1/admin/providers/category-toggle',
               json={'user_id': DIFF_USER_ID, 'category': 'nope'}, headers=h))
    same(*both('DELETE', '/api/v1/admin/providers',
               json={'user_id': DIFF_USER_ID, 'category': 'voice', 'provider': ''}, headers=h))


def test_keys_validation(both, h):
    same(*both('POST', '/api/v1/admin/keys', json={'user_id': DIFF_USER_ID}, headers=h))
    same(*both('POST', '/api/v1/admin/keys/delete', json={'user_id': DIFF_USER_ID}, headers=h))


# ─── provider toggle round-trip (restores state) ────────────────────────────

def test_provider_toggle_round_trip_restores_state(php, py, h):
    pre = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()
    assert pre == py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()
    grok = pre['voice']['providers'].get('grok', {})
    original_enabled = grok.get('enabled', True)

    for client in (php, py):
        r = client.post('/api/v1/admin/providers/toggle',
                        json={'user_id': DIFF_USER_ID, 'category': 'voice', 'provider': 'grok',
                              'enabled': not original_enabled}, headers=h)
        assert r.json()['success'] is True, r.text

    mid = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()
    assert mid['voice']['providers']['grok']['enabled'] == (not original_enabled)
    assert mid == py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()

    for client in (php, py):
        r = client.post('/api/v1/admin/providers/toggle',
                        json={'user_id': DIFF_USER_ID, 'category': 'voice', 'provider': 'grok',
                              'enabled': original_enabled}, headers=h)
        assert r.json()['success'] is True, r.text

    post = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()
    assert post == pre
    assert post == py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/providers', headers=h).json()


# ─── cross-backend user create/login/delete round-trip ──────────────────────
# createUser hashes with bcrypt ($2y$-family via the Phase 1 helper); a user
# created by one backend must be able to log in through the OTHER backend,
# proving the hash format round-trips (AdminController.php:166-211,
# constraints.md "Passwords").

@pytest.mark.parametrize('writer,reader,deleter', [('php', 'py', 'php'), ('py', 'php', 'py')])
def test_cross_backend_create_login_delete(php, py, h, config, writer, reader, deleter):
    clients = {'php': php, 'py': py}
    w, r_client, d_client = clients[writer], clients[reader], clients[deleter]
    password = f'diff-{writer}-{int(time.time())}-pw'

    created = w.post('/api/v1/admin/users', json={
        'email': TMP_EMAIL, 'password': password, 'first_name': 'Diff', 'last_name': 'Tmp', 'role': 'user',
    }, headers=h)
    assert created.status_code == 200 and created.json()['success'] is True, created.text
    user_id = created.json()['user_id']

    try:
        login = r_client.post('/api/v1/auth/login', json={'email': TMP_EMAIL, 'password': password})
        assert login.status_code == 200 and login.json()['success'] is True, login.text
        assert login.json()['data']['user']['id'] == user_id

        # Wrong password still rejected by both sides — proves the hash isn't
        # accepting everything.
        bad = r_client.post('/api/v1/auth/login', json={'email': TMP_EMAIL, 'password': 'definitely-wrong'})
        assert bad.status_code == 401
    finally:
        deleted = d_client.delete(f'/api/v1/admin/users/{user_id}', headers=h)
        assert deleted.status_code == 200 and deleted.json()['success'] is True, deleted.text
