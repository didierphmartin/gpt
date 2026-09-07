"""PHP-vs-Python differential: MCPServerController (backend/src/Controllers/MCPServerController.php).

Read parity is exact — the server list carries `s.*`, so a drift in the int
casts, the transport normalization, the derived `server_type` or the
global-headers redaction shows up immediately.

The mutation round-trip creates ONE private server named `differential-tmp`
pointing at `http://127.0.0.1:1/mcp` (port 1 — deliberately unroutable; nothing
here ever calls it), exercises update/toggle/override on it, deletes it by the
returned id on the backend that created it, and asserts both list endpoints are
byte-identical to the pre-state on BOTH backends afterwards (constraints.md
"self-cleaning mutations"). `PUT /me/mcp-settings` writes back the value it
just read, so it is idempotent.

PHP always runs first (constraints.md "differential ordering") — the `both`
fixture guarantees that, and the hand-written steps below follow the same order.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential

TMP_NAME = 'differential-tmp'
TMP_URL = 'http://127.0.0.1:1/mcp'


# ─── reads ─────────────────────────────────────────────────────────────────

def test_mcp_servers_list_parity(both):
    same(*both('GET', '/api/v1/mcp/servers'))
    same(*both('GET', '/api/v1/mcp/servers?include_disabled=1'))
    same(*both('GET', '/api/v1/mcp/servers?include_disabled=0'))
    same(*both('GET', '/api/v1/mcp/servers?user_id=3'))


def test_mcp_all_tools_parity(both):
    same(*both('GET', '/api/v1/mcp/servers/all-tools'))


def test_mcp_server_tools_parity(both):
    same(*both('GET', '/api/v1/mcp/servers/tools?server_id=24'))
    same(*both('GET', '/api/v1/mcp/servers/tools'))              # no id => empty list, 200
    same(*both('GET', '/api/v1/mcp/servers/tools?server_id='))   # falsy id => same empty list
    same(*both('GET', '/api/v1/mcp/servers/tools?server_id=999999999'))


def test_me_mcp_servers_parity(both):
    same(*both('GET', '/api/v1/me/mcp-servers'))


# ─── validation (no rows are written by any of these) ──────────────────────

def test_mcp_create_validation_parity(both):
    same(*both('POST', '/api/v1/mcp/servers', json={'name': 'x', 'url': TMP_URL, 'transport': 'stdio'}))
    same(*both('POST', '/api/v1/mcp/servers', json={'url': TMP_URL}))
    same(*both('POST', '/api/v1/mcp/servers', json={'name': '   ', 'url': TMP_URL}))
    same(*both('POST', '/api/v1/mcp/servers', json={'name': 'x'}))
    same(*both('POST', '/api/v1/mcp/servers', json={'name': 'x', 'url': 'not a url'}))
    same(*both('POST', '/api/v1/mcp/servers', json={'name': 'x', 'url': 'example.com'}))
    same(*both('POST', '/api/v1/mcp/servers', json={'name': 'x', 'url': 'http://ex_ample.com/p'}))


def test_mcp_update_toggle_delete_validation_parity(both):
    same(*both('POST', '/api/v1/mcp/servers/update', json={'name': 'x', 'url': TMP_URL}))
    same(*both('POST', '/api/v1/mcp/servers/update', json={'server_id': 999999999, 'name': '', 'url': TMP_URL}))
    same(*both('POST', '/api/v1/mcp/servers/update',
               json={'server_id': 999999999, 'name': 'x', 'url': TMP_URL, 'transport': 'stdio'}))
    # id nobody owns => UPDATE matches nothing => 404
    same(*both('POST', '/api/v1/mcp/servers/update', json={'server_id': 999999999, 'name': 'x', 'url': TMP_URL}))
    same(*both('POST', '/api/v1/mcp/servers/toggle', json={'enabled': False}))
    # toggle never checks rowCount (PHP 469-478): a foreign id still 200s
    same(*both('POST', '/api/v1/mcp/servers/toggle', json={'server_id': 999999999, 'enabled': False}))
    same(*both('DELETE', '/api/v1/mcp/servers'))
    same(*both('DELETE', '/api/v1/mcp/servers?server_id=999999999'))


def test_me_mcp_override_validation_parity(both):
    same(*both('PUT', '/api/v1/me/mcp-servers/999999999/override', json={}))
    same(*both('PUT', '/api/v1/me/mcp-servers/999999999/override', json={'allowed': True}))
    same(*both('PUT', '/api/v1/me/mcp-servers/999999999/override', json={'allowed': False}))
    same(*both('DELETE', '/api/v1/me/mcp-servers/999999999/override'))


def test_me_mcp_settings_validation_parity(both):
    same(*both('PUT', '/api/v1/me/mcp-settings', json={}))


def test_me_mcp_settings_idempotent_write_back_parity(both, php, token):
    """Writes back the value the row already holds, so the DB is unchanged."""
    h = {'Authorization': f'Bearer {token}'}
    current = php.get('/api/v1/me/mcp-servers', headers=h).json()['mcp_enabled']
    same(*both('PUT', '/api/v1/me/mcp-settings', json={'mcp_enabled': current}))
    same(*both('GET', '/api/v1/me/mcp-servers'))


# ─── create → override → clear → delete round-trip ─────────────────────────

def _snapshot(php, py, h):
    """PHP first, then Python (constraints.md differential ordering)."""
    return {
        'php_servers': php.get('/api/v1/mcp/servers?include_disabled=1', headers=h).json(),
        'py_servers': py.get('/api/v1/mcp/servers?include_disabled=1', headers=h).json(),
        'php_mine': php.get('/api/v1/me/mcp-servers', headers=h).json(),
        'py_mine': py.get('/api/v1/me/mcp-servers', headers=h).json(),
    }


def _purge_leftovers(php, h):
    """A previous aborted run may have left the temp row behind."""
    for s in php.get('/api/v1/me/mcp-servers', headers=h).json().get('servers', []):
        if s['name'] == TMP_NAME:
            php.delete(f"/api/v1/me/mcp-servers/{s['id']}/override", headers=h)
            php.delete(f"/api/v1/mcp/servers?server_id={s['id']}", headers=h)


def test_mcp_server_round_trip(both, php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    _purge_leftovers(php, h)
    before = _snapshot(php, py, h)

    created = php.post('/api/v1/mcp/servers',
                       json={'name': TMP_NAME, 'url': TMP_URL, 'description': 'differential temp',
                             'transport': 'sse'},
                       headers=h)
    assert created.status_code == 200, created.text
    body = created.json()
    assert body['success'] is True and body['message'] == 'Server added successfully'
    # PDO::lastInsertId() is a string, so json_encode quotes it (PHP 348-354).
    assert isinstance(body['server_id'], str), body
    sid = int(body['server_id'])

    try:
        # Both backends must render the brand-new private server identically.
        same(*both('GET', '/api/v1/mcp/servers'))
        same(*both('GET', '/api/v1/me/mcp-servers'))

        mine = py.get('/api/v1/me/mcp-servers', headers=h).json()['servers']
        assert next(s for s in mine if s['id'] == sid) == {
            'id': sid, 'name': TMP_NAME, 'url': TMP_URL, 'is_global': False,
            'is_mock': False, 'tool_count': 0, 'effective_on': True,
        }
        row = next(s for s in py.get('/api/v1/mcp/servers', headers=h).json()['servers'] if s['id'] == sid)
        assert row['transport'] == 'sse' and row['server_type'] == 'mcp' and row['headers'] is None

        # update on the Python backend, then compare the reads on both
        upd = py.post('/api/v1/mcp/servers/update',
                      json={'server_id': sid, 'name': TMP_NAME, 'url': TMP_URL, 'description': 'updated'},
                      headers=h)
        assert upd.json() == {'success': True, 'message': 'Server updated successfully'}, upd.text
        same(*both('GET', '/api/v1/mcp/servers?include_disabled=1'))

        # toggle off on PHP, back on via Python
        off = php.post('/api/v1/mcp/servers/toggle', json={'server_id': sid, 'enabled': False}, headers=h)
        assert off.json() == {'success': True, 'message': 'Server disabled'}
        same(*both('GET', '/api/v1/mcp/servers'))
        same(*both('GET', '/api/v1/mcp/servers?include_disabled=1'))
        on = py.post('/api/v1/mcp/servers/toggle', json={'server_id': sid, 'enabled': True}, headers=h)
        assert on.json() == {'success': True, 'message': 'Server enabled'}

        # deny-only override, set on the Python backend
        ov = py.put(f'/api/v1/me/mcp-servers/{sid}/override', json={'allowed': False}, headers=h)
        assert ov.json() == {'success': True, 'server_id': sid, 'allowed': False}, ov.text
        # the override hides it from list() on both backends; listMine() still
        # shows a private server as effective_on = its own `enabled` (PHP 601-605)
        same(*both('GET', '/api/v1/mcp/servers'))
        same(*both('GET', '/api/v1/me/mcp-servers'))
        assert not any(s['id'] == sid for s in py.get('/api/v1/mcp/servers', headers=h).json()['servers'])

        cleared = py.delete(f'/api/v1/me/mcp-servers/{sid}/override', headers=h)
        assert cleared.json() == {'success': True, 'server_id': sid, 'cleared': True}
        again = py.delete(f'/api/v1/me/mcp-servers/{sid}/override', headers=h)
        assert again.json() == {'success': True, 'server_id': sid, 'cleared': False}
        same(*both('GET', '/api/v1/mcp/servers'))
    finally:
        gone = php.delete(f'/api/v1/mcp/servers?server_id={sid}', headers=h)
        assert gone.json() == {'success': True, 'message': 'Server deleted successfully'}, gone.text

    assert _snapshot(php, py, h) == before
