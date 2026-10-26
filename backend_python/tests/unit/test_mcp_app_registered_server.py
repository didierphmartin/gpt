"""Port of backend/tests/Unit/Controllers/MCPAppRegisteredServerTest.php.

The public /mcp/app route only reaches MCP servers someone registered (refusals only: no request is sent),
and its HTML is served sandboxed."""
from __future__ import annotations

import httpx

from app.controllers.mcp_app_controller import MCPAppController, _json_encode_hex
from app.support.http import render
from tests.unit.playbook.conftest import sqlite_db


def test_unregistered_or_disabled_server_is_refused(monkeypatch):
    db = sqlite_db('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, url TEXT, enabled INTEGER)')
    db.execute("INSERT INTO mcp_servers (url, enabled) VALUES ('http://127.0.0.1:1/off', 0)")
    c = MCPAppController(db, {})
    monkeypatch.setattr(c, '_makeClient', lambda: (_ for _ in ()).throw(AssertionError('no request is sent')))

    for server in ('http://169.254.169.254/latest', 'http://127.0.0.1:1/off'):
        r = c.getResource({'query': {'server': server, 'resource': 'ui://x'}})
        assert r['status_code'] == 404, server
        assert r['error'] == 'Unknown MCP server'

    r = c.getResource({'query': {'server': ['http://x'], 'resource': 'ui://x'}})
    assert r['status_code'] == 400
    assert r['error'] == 'Invalid server or resource parameter'


def test_html_is_served_with_a_csp_sandbox():
    resp = render({'html': '<p>x</p>', 'status_code': 200, 'content_type': 'text/html; charset=utf-8'})
    assert resp.headers['content-security-policy'] == 'sandbox allow-scripts allow-forms allow-downloads allow-modals'


def test_injected_values_cannot_end_the_script():
    # json_encode(..., JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT), checked against php -r
    assert _json_encode_hex({'a': '</script>"x\'&', 'b': '\\"', 'u': 'http://h/'}) == \
        '{"a":"\\u003C\\/script\\u003E\\u0022x\\u0027\\u0026","b":"\\\\\\u0022","u":"http:\\/\\/h\\/"}'
