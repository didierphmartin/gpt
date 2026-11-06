"""Port of backend/tests/Unit/Controllers/MCPProxyServerScopeTest.php.

With a server_id, the proxy uses only a server the caller may use, at its stored URL; discovered tools are
cached for the caller's own server, or for a global one by an admin."""
from __future__ import annotations

import json

import httpx
import pytest

from app.controllers.mcp_proxy_controller import MCPProxyController
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)',
        'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER)',
        'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, tool_description TEXT,'
        ' input_schema TEXT, has_ui INTEGER, ui_resource_uri TEXT)')
    d.execute("INSERT INTO users VALUES (1, 'user'), (9, 'admin')")
    d.execute("""INSERT INTO mcp_servers VALUES (1, '2', 'http://127.0.0.1:1/bob', '{"Authorization":"Bearer bob"}', 'http', 1)""")
    d.execute("""INSERT INTO mcp_servers VALUES (2, NULL, 'http://127.0.0.1:1/off', '{"Authorization":"Bearer g"}', 'http', 0)""")
    d.execute("""INSERT INTO mcp_servers VALUES (3, NULL, 'http://127.0.0.1:1/global', '{"Authorization":"Bearer g"}', 'http', 1)""")
    return d


def controller(db, sent=None):
    # The constructor checks tables with MySQL's SHOW TABLES; set the fields directly, as the PHP test does.
    c = MCPProxyController.__new__(MCPProxyController)
    c.db, c.config, c.lastError, c._endpoints = db, {}, None, {}

    def handler(req):
        sent.append(req)
        payload = json.loads(req.content)
        result = {'tools': [{'name': 't', 'inputSchema': {'type': 'object', 'properties': {}}}]} \
            if payload.get('method') == 'tools/list' else {}
        return httpx.Response(200, json={'jsonrpc': '2.0', 'id': payload.get('id', 1), 'result': result})

    c._makeClient = lambda: httpx.Client(transport=httpx.MockTransport(handler))
    return c


@pytest.mark.parametrize('server_id', [1, 2])
@pytest.mark.parametrize('action', ['proxy', 'discover_tools'])
def test_another_users_or_disabled_server_is_refused(db, server_id, action):
    sent = []
    r = controller(db, sent).forward({'user_id': 1, 'body': {
        'action': action, 'server_id': server_id,
        'server_url': 'http://attacker.example/collect',
        'jsonrpc': {'method': 'tools/list'},
    }})
    assert r['status_code'] == 404
    assert r['error']['message'] == 'Unknown MCP server'
    assert sent == []


def test_a_global_server_is_reached_at_its_stored_url(db):
    sent = []
    controller(db, sent).forward({'user_id': 1, 'body': {
        'action': 'proxy', 'server_id': 3, 'server_url': 'http://attacker.example/collect',
        'jsonrpc': {'method': 'tools/list'},
    }})
    assert sent and {str(r.url) for r in sent} == {'http://127.0.0.1:1/global'}


def test_only_an_admin_caches_a_global_servers_tools(db):
    body = {'action': 'discover_tools', 'server_id': 3, 'server_url': 'http://x'}
    assert controller(db, []).forward({'user_id': 1, 'body': body})['success'] is True
    assert db.fetch_all('SELECT * FROM mcp_server_tools') == []
    assert controller(db, []).forward({'user_id': 9, 'body': body})['success'] is True
    assert [r['tool_name'] for r in db.fetch_all('SELECT * FROM mcp_server_tools')] == ['t']
