"""AdminController (part 2: usage stats, MCP admin, user MCP overrides, costs,
exchange rates) PHP-vs-Python differential.

Admin identity: user 3's `role` is 'admin' (verified live, same as
test_admin_users.py). PHP-first; self-cleaning; run ONLY this file
(constraints.md: differential suites run in isolation from each other).

External refreshes (refreshAllCosts/refreshProviderCosts/refreshExchangeRates)
are compared for their VALIDATION responses only — never a real refresh, per
constraints.md ("NEVER call the external APIs in the differential").
"""
import pytest

from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential

TMP_MCP_NAME = 'differential-tmp-mcp'
# Deliberately unreachable (nothing listens on this loopback port): the
# create call's internal fetchMCPServerTools handshake fails fast and
# deterministically on both backends (connection refused) instead of ever
# reaching a real MCP server — no external side effect, no flakiness.
TMP_MCP_URL = 'http://127.0.0.1:1/mcp'


def _round_floats(obj, ndigits=6):
    """See test_admin_users.py's identical helper: this XAMPP box's Apache
    php.ini sets serialize_precision=100 (not the -1 CLI default), so PHP's
    json_encode of any float computed via arithmetic (not read straight from
    a DECIMAL column) leaks ~50 raw IEEE754 digits. Usage-stats/costs here
    compute round(sum, 4)/round(sum, 6) the same way AdminController.php's
    getUserCosts already did in Task 2 — apply the same tolerant compare."""
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


def _find_tmp_mcp_id(client, h):
    servers = client.get('/api/v1/admin/mcp/servers', headers=h).json().get('servers', [])
    for s in servers:
        if s.get('name') == TMP_MCP_NAME:
            return s['id']
    return None


def _delete_tmp_mcp_via(client, h):
    sid = _find_tmp_mcp_id(client, h)
    if sid is not None:
        client.delete(f'/api/v1/admin/mcp/servers/{sid}', headers=h)


@pytest.fixture(autouse=True)
def _cleanup_tmp_mcp(php, h):
    _delete_tmp_mcp_via(php, h)
    yield
    _delete_tmp_mcp_via(php, h)


# ─── reads ───────────────────────────────────────────────────────────────────

def test_usage_reads_are_identical(both, h):
    same_rounded(*both('GET', '/api/v1/admin/usage/stats', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/by-user', headers=h))
    same_rounded(*both('GET', f'/api/v1/admin/usage/users/{DIFF_USER_ID}', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/transactions', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/tools', headers=h))


def test_mcp_and_costs_reads_are_identical(both, h):
    same(*both('GET', '/api/v1/admin/mcp/servers', headers=h))
    same(*both('GET', f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/costs', headers=h))
    same(*both('GET', '/api/v1/admin/exchange-rates', headers=h))


def test_usage_stats_with_period_and_date_range_params(both, h):
    same_rounded(*both('GET', '/api/v1/admin/usage/stats?period=week', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/stats?period=all', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/by-user?period=day&limit=5&offset=0', headers=h))
    same_rounded(*both('GET', '/api/v1/admin/usage/transactions?status=success&limit=10', headers=h))


def test_admin_routes_require_auth(both):
    for path in (
        '/api/v1/admin/usage/stats', '/api/v1/admin/usage/by-user',
        f'/api/v1/admin/usage/users/{DIFF_USER_ID}', '/api/v1/admin/usage/transactions',
        '/api/v1/admin/usage/tools', '/api/v1/admin/mcp/servers',
        f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', '/api/v1/admin/costs',
        '/api/v1/admin/exchange-rates',
    ):
        same(*both('GET', path, auth=False))


def test_not_found_parity(both, h):
    same(*both('GET', '/api/v1/admin/usage/users/999999999', headers=h))
    same(*both('DELETE', '/api/v1/admin/mcp/servers/999999999', headers=h))


# ─── validation-only parity (no writes / no external calls) ────────────────

def test_mcp_server_validation(both, h):
    same(*both('POST', '/api/v1/admin/mcp/servers', json={'name': '', 'url': ''}, headers=h))
    same(*both('POST', '/api/v1/admin/mcp/servers', json={'name': 'X', 'url': 'not a url'}, headers=h))
    same(*both('POST', '/api/v1/admin/mcp/servers/update', json={'server_id': 0}, headers=h))
    same(*both('POST', '/api/v1/admin/mcp/servers/toggle', json={}, headers=h))


def test_user_mcp_override_validation(both, h):
    same(*both('PUT', f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers/999999999/override',
              json={}, headers=h))


def test_costs_and_exchange_rate_refresh_validation(both, h):
    # Validation-only: these never reach fetchProviderPricing/fetchExchangeRatesFromApi.
    same(*both('POST', '/api/v1/admin/costs/refresh-provider', json={'category': 'bogus'}, headers=h))
    same(*both('POST', '/api/v1/admin/costs/refresh-provider',
              json={'category': 'llm', 'provider': ''}, headers=h))
    same(*both('POST', '/api/v1/admin/costs/refresh-provider',
              json={'category': 'llm', 'provider': 'totally-not-a-real-provider'}, headers=h))


# ─── MCP server round-trip (self-cleaning) ──────────────────────────────────

def test_mcp_server_create_update_toggle_delete_round_trip(php, py, h):
    # Create via PHP first (PHP-first ordering), then read back via both —
    # the URL is unreachable so the create's internal tools-fetch handshake
    # fails fast (connection refused) without any real network dependency.
    created = php.post('/api/v1/admin/mcp/servers',
                       json={'name': TMP_MCP_NAME, 'url': TMP_MCP_URL, 'description': 'diff tmp'},
                       headers=h)
    assert created.status_code == 200 and created.json()['success'] is True, created.text
    server_id = created.json()['server_id']

    try:
        listed_php = php.get('/api/v1/admin/mcp/servers', headers=h).json()
        listed_py = py.get('/api/v1/admin/mcp/servers', headers=h).json()
        php_row = next(s for s in listed_php['servers'] if s['id'] == server_id)
        py_row = next(s for s in listed_py['servers'] if s['id'] == server_id)
        assert php_row == py_row

        # Update (both backends, same target row) — verify parity after each.
        for client in (php, py):
            r = client.post('/api/v1/admin/mcp/servers/update',
                            json={'server_id': server_id, 'name': TMP_MCP_NAME,
                                  'url': TMP_MCP_URL, 'description': 'diff tmp updated'},
                            headers=h)
            assert r.json()['success'] is True, r.text

        mid_php = next(s for s in php.get('/api/v1/admin/mcp/servers', headers=h).json()['servers']
                      if s['id'] == server_id)
        mid_py = next(s for s in py.get('/api/v1/admin/mcp/servers', headers=h).json()['servers']
                     if s['id'] == server_id)
        assert mid_php == mid_py
        assert mid_php['description'] == 'diff tmp updated'

        # Toggle off (via PHP) then back on (via Python) — x2 across backends
        # so every call is a genuine value change. NOTE: toggleMCPServer's
        # `UPDATE ... SET enabled = ?, updated_at = NOW() WHERE id = ?` uses
        # PDO's/PyMySQL's default "affected rows" rowCount (no
        # MYSQL_ATTR_FOUND_ROWS anywhere in this codebase — verified by
        # grep): re-toggling to the value a row is ALREADY at returns 0
        # affected rows (and a 404 "Server not found") ONLY when the second
        # call lands within the same wall-clock second as the first, since
        # `updated_at = NOW()` then also produces an identical value and no
        # column differs at all — live-verified this is genuinely
        # non-deterministic in PHP ALONE (three same-value-twice probes
        # against plain PHP gave 200/404/404), not a PHP-vs-Python
        # discrepancy, so it is deliberately not asserted here — a flaky
        # assertion on a timing-dependent PHP quirk would be worse than no
        # assertion. Toggling with alternating target values (this loop)
        # sidesteps it entirely: those calls always change a real column.
        for target_enabled, caller in ((False, php), (True, py), (False, py), (True, php)):
            r = caller.post('/api/v1/admin/mcp/servers/toggle',
                            json={'server_id': server_id, 'enabled': target_enabled}, headers=h)
            assert r.json()['success'] is True, r.text
            after_php = next(s for s in php.get('/api/v1/admin/mcp/servers', headers=h).json()['servers']
                            if s['id'] == server_id)
            after_py = next(s for s in py.get('/api/v1/admin/mcp/servers', headers=h).json()['servers']
                           if s['id'] == server_id)
            assert after_php['enabled'] == target_enabled
            assert after_php == after_py
    finally:
        deleted = php.delete(f'/api/v1/admin/mcp/servers/{server_id}', headers=h)
        assert deleted.status_code == 200 and deleted.json()['success'] is True, deleted.text


# ─── user MCP override round-trip (self-cleaning, restores pre-state) ──────

def test_user_mcp_override_round_trip(php, py, h):
    pre = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
    assert pre == py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
    assert pre['servers'], 'need at least one existing MCP server visible to user 3 for this test'
    target = pre['servers'][0]
    server_id = target['id']
    pre_override = target['override']
    new_value = not (pre_override if pre_override is not None else target['package_default'])

    try:
        for client in (php, py):
            r = client.put(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers/{server_id}/override',
                          json={'allowed': new_value}, headers=h)
            assert r.status_code == 200 and r.json()['success'] is True, r.text

        mid_php = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
        mid_py = py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
        assert mid_php == mid_py
        mid_row = next(s for s in mid_php['servers'] if s['id'] == server_id)
        assert mid_row['override'] == new_value
    finally:
        # Restore: clear the override via both backends so pre-state comes back.
        for client in (php, py):
            client.delete(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers/{server_id}/override', headers=h)
        if pre_override is not None:
            # There WAS a pre-existing override — restore its exact value
            # (the DELETE above only clears to package-default, so re-set it).
            for client in (php, py):
                client.put(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers/{server_id}/override',
                          json={'allowed': pre_override}, headers=h)

    post = php.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
    assert post == pre
    assert post == py.get(f'/api/v1/admin/users/{DIFF_USER_ID}/mcp-servers', headers=h).json()
