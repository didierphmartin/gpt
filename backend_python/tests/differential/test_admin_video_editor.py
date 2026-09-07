"""PHP-vs-Python differential tests for VideoEditorController
(routes.php 199-214, /api/v1/admin/video-editor/*).

User 3 IS admin on both backends (verified live 2026-09-07: `SELECT role FROM
users WHERE id=3` -> 'admin'), so every route here is exercised for its real
200 response, not just the 403 text.

NOTE: as of this test's authorship, backend_python/app/routes.py had not yet
been updated with the video-editor route block (another agent held it
uncommitted at the time — see task-5 routes.py guard). Every test below will
404 on the `py` side until that block lands; they are written to pass once
it does, PHP-first, self-cleaning.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential

BASE = '/api/v1/admin/video-editor'


def test_reads_exact_for_admin_user(both):
    same(*both('GET', f'{BASE}/usage/stats'))
    same(*both('GET', f'{BASE}/usage/stats?days=7'))
    same(*both('GET', f'{BASE}/usage/summary'))
    same(*both('GET', f'{BASE}/usage/by-user'))
    same(*both('GET', f'{BASE}/usage/by-user?days=90'))
    same(*both('GET', f'{BASE}/transactions'))
    same(*both('GET', f'{BASE}/transactions?all=1&per_page=5'))
    same(*both('GET', f'{BASE}/prices'))
    same(*both('GET', f'{BASE}/providers'))
    same(*both('GET', f'{BASE}/models'))
    same(*both('GET', f'{BASE}/users'))
    same(*both('GET', f'{BASE}/users?q=a'))
    same(*both('GET', f'{BASE}/packages'))
    same(*both('GET', f'{BASE}/user-override?user_id=3'))


def test_auth_required(both):
    # Not in MiddlewareProcessor::PUBLIC_ROUTES — every video-editor route needs a JWT,
    # even the ones with no controller-level admin gate (e.g. usage/stats).
    same(*both('GET', f'{BASE}/usage/stats', auth=False))
    same(*both('GET', f'{BASE}/transactions', auth=False))


def test_save_price_roundtrip_noop(php, py, token):
    """Read one existing price row via PHP, POST it back byte-for-byte (no delete
    route exists for video_edit_prices), assert both backends still list it
    identically before and after — self-cleaning since nothing actually changes."""
    before = php.get(f'{BASE}/prices', headers={'Authorization': f'Bearer {token}'}).json()
    assert before['success'] is True and before['prices'], 'no price rows to round-trip against'
    row = before['prices'][0]
    r = php.post(f'{BASE}/prices', json={'model': row['model'], 'unit': row['unit'],
                                          'rate': row['rate'], 'label': row['label']},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    same(*both('GET', f'{BASE}/prices'))


def test_save_model_roundtrip_noop(php, py, token):
    before = php.get(f'{BASE}/models', headers={'Authorization': f'Bearer {token}'}).json()
    assert before['success'] is True and before['models'], 'no model rows to round-trip against'
    row = before['models'][0]
    r = php.post(f'{BASE}/models', json={'model': row['model'], 'provider': row['provider'],
                                          'kind': row['kind'], 'label': row['label'],
                                          'enabled': row['enabled']},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    same(*both('GET', f'{BASE}/models'))


def test_save_provider_roundtrip_noop(php, py, token):
    """Echo back label/api_base/enabled for an existing provider, omitting api_key and
    models entirely so both stay untouched (PHP: blank api_key keeps the stored key,
    omitted 'models' keeps the existing catalog) — a true no-op save."""
    before = php.get(f'{BASE}/providers', headers={'Authorization': f'Bearer {token}'}).json()
    assert before['success'] is True and before['providers'], 'no provider rows to round-trip against'
    row = before['providers'][0]
    r = php.post(f'{BASE}/providers', json={'provider': row['provider'], 'label': row['label'],
                                             'api_base': row['api_base'], 'enabled': bool(row['enabled'])},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    same(*both('GET', f'{BASE}/providers'))


def test_save_package_roundtrip_noop(php, py, token):
    """'guest' carries no secrets (unlike 'admin', whose capabilities.provider_keys holds
    real API keys) — safe role to exercise the upsert with."""
    before = php.get(f'{BASE}/packages', headers={'Authorization': f'Bearer {token}'}).json()
    assert before['success'] is True
    guest = next((p for p in before['packages'] if p['role'] == 'guest'), None)
    assert guest is not None, 'no guest package row to round-trip against'
    r = php.post(f'{BASE}/packages', json={'role': 'guest', 'capabilities': guest['capabilities']},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    same(*both('GET', f'{BASE}/packages'))


def test_save_user_override_roundtrip_noop(php, py, token):
    """user 3's pre-state capabilities is null (verified live) — omitting 'capabilities'
    from the body makes PHP write null again (array_key_exists check, not isset), a true
    no-op; omitting 'byo_keys' leaves the existing BYO map untouched (merge, not replace)."""
    before = php.get(f'{BASE}/user-override?user_id=3', headers={'Authorization': f'Bearer {token}'}).json()
    assert before['success'] is True
    assert before['capabilities'] is None, 'pre-state capabilities changed since authorship — re-verify round-trip'
    r = php.post(f'{BASE}/user-override', json={'user_id': 3},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    same(*both('GET', f'{BASE}/user-override?user_id=3'))


def test_set_user_role_roundtrip_restore(php, py, token):
    """Restore user 3's own video-edit role after a temporary change — verified live
    pre-state: 'admin' (login.app_user_roles via registered_apps 'video-edit')."""
    before = php.get(f'{BASE}/users?q=', headers={'Authorization': f'Bearer {token}'}).json()
    me = next((u for u in before['users'] if u['id'] == '3'), None)
    assert me is not None, 'user 3 not present in the video-edit users list'
    original_role = me['ve_role']

    temp_role = 'user' if original_role != 'user' else 'admin'
    r = php.post(f'{BASE}/users/role', json={'user_id': 3, 'role': temp_role},
                 headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json()['success'] is True
    try:
        same(*both('GET', f'{BASE}/users?q='), ignore=())
    finally:
        restore_role = original_role if original_role else ''
        r = php.post(f'{BASE}/users/role', json={'user_id': 3, 'role': restore_role},
                     headers={'Authorization': f'Bearer {token}'})
        assert r.status_code == 200 and r.json()['success'] is True

    after = php.get(f'{BASE}/users?q=', headers={'Authorization': f'Bearer {token}'}).json()
    me_after = next((u for u in after['users'] if u['id'] == '3'), None)
    assert me_after is not None and me_after['ve_role'] == original_role
    same(*both('GET', f'{BASE}/users?q='))
