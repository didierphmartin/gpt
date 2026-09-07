"""PHP-vs-Python differential: MCPProxyController + MCPAppController
(backend/src/Controllers/MCPProxyController.php, MCPAppController.php).

Validation-only cases use the shared `same()` deep-equality helper — they
never touch the network. The one live case hits server id 24 ("Metals
News", http://localhost/metals/public/mcp) with `action: 'proxy'` +
`tools/list` only: that action never writes (unlike `discover_tools`, which
calls cacheTools() and would leave rows in mcp_server_tools — deliberately
not exercised here per constraints.md "self-cleaning mutations" and the task
brief's "NEVER call a tools/call that writes"). Its response is compared by
status + top-level keys + the sorted tool-name list, not full deep equality,
since the brief calls that out explicitly (a live 3rd-party server's byte
shape is not this port's contract to pin).

PHP always runs first (constraints.md "differential ordering") — the `both`
fixture guarantees that for every validation case; the one live case follows
the same order by hand.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential

METALS_URL = 'http://localhost/metals/public/mcp'
METALS_SERVER_ID = 24


# ─── POST /api/v1/mcp/proxy — validation (no network, no DB writes) ────────

def test_mcp_proxy_action_proxy_requires_server_url(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'proxy'}))


def test_mcp_proxy_action_proxy_unknown_server_id_has_no_url(both):
    # getServerUrl() only matches servers OWNED by this exact user_id
    # (PHP 436-439) — an id with no server_url given resolves to null.
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'proxy', 'server_id': 999999999}))


def test_mcp_proxy_action_proxy_requires_jsonrpc(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'proxy', 'server_url': METALS_URL}))


def test_mcp_proxy_action_discover_tools_requires_server_url(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'discover_tools'}))
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'discover_tools', 'server_url': ''}))


def test_mcp_proxy_action_test_connection_requires_server_url(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'test_connection'}))


def test_mcp_proxy_unknown_action(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={'action': 'bogus'}))


def test_mcp_proxy_missing_action(both):
    same(*both('POST', '/api/v1/mcp/proxy', json={}))


# ─── POST /api/v1/mcp/proxy — live, read-only tools/list ───────────────────

def test_mcp_proxy_tools_list_live_parity(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    body = {
        'action': 'proxy',
        'server_id': METALS_SERVER_ID,
        'server_url': METALS_URL,
        'jsonrpc': {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
    }
    a = php.post('/api/v1/mcp/proxy', json=body, headers=h)   # PHP first
    b = py.post('/api/v1/mcp/proxy', json=body, headers=h)

    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    ja, jb = a.json(), b.json()

    assert set(ja.keys()) == {'success', 'response'}
    assert set(jb.keys()) == {'success', 'response'}
    assert ja['success'] is True and jb['success'] is True

    def tool_names(doc):
        return sorted(t['name'] for t in doc['response']['result']['tools'])

    names_a, names_b = tool_names(ja), tool_names(jb)
    assert names_a == names_b
    assert len(names_a) > 0   # sanity: the live server actually has tools


# ─── GET /api/v1/mcp/app (+ legacy /api/mcp-app.php) — validation parity ───
#
# getResource()'s error responses are `content_type: text/plain` (PHP
# index.php:169-174 echoes $result['error'] raw, no JSON envelope) — so these
# compare status + raw body directly instead of the JSON-based `same()` helper.

def _same_text(php, py, path):
    a = php.get(path)   # PHP first (differential ordering)
    b = py.get(path)
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    assert a.text == b.text, (a.text, b.text)
    assert a.headers.get('content-type', '').startswith('text/plain')
    assert b.headers.get('content-type', '').startswith('text/plain')


def test_mcp_app_missing_server_parameter(php, py):
    _same_text(php, py, '/api/v1/mcp/app')
    _same_text(php, py, '/api/mcp-app.php')


def test_mcp_app_missing_resource_parameter(php, py):
    _same_text(php, py, f'/api/v1/mcp/app?server={METALS_URL}')
    _same_text(php, py, f'/api/mcp-app.php?server={METALS_URL}')
