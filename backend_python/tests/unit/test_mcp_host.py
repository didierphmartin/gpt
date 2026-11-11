"""Port of backend/tests/Unit/McpHostControllerTest.php, McpHostClientTimeoutTest.php and McpEndpointInternalTest.php."""
from __future__ import annotations

import json

import pytest

from app.controllers.mcp_host_controller import McpHostController
from app.services.mcp_endpoint import McpEndpoint
from app.services.mcp_host_client import McpHostClient
from tests.unit.playbook.conftest import sqlite_db


class Host:
    def __init__(self):
        self.calls = []
        self.reply = (200, json.dumps([
            {'folder': 'a', 'installed_by': 3, 'log': 'x'},
            {'folder': 'b', 'installed_by': 4, 'log': 'y'},
        ]))

    def ctl(self, db, config=None):
        def transport(method, url, headers, body):
            self.calls.append({'method': method, 'url': url, 'headers': headers, 'body': body})
            return self.reply
        return McpHostController(db, config or {}, lambda: McpHostClient('http://mcps:8790', 'tok', transport))


@pytest.fixture
def db():
    d = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)')
    d.execute("INSERT INTO users VALUES (1, 'admin'), (3, 'user'), (4, 'user')")
    return d


@pytest.fixture
def host(monkeypatch):
    monkeypatch.setenv('MCPS_URL', 'http://mcps:8790')
    monkeypatch.setenv('MCPS_TOKEN', 'tok')
    monkeypatch.setenv('MCPS_PUBLIC_GATEWAY', 'http://localhost:8791')
    return Host()


def req(uid, body=None):
    return {'user_id': uid, 'body': body or {}}


def test_host_unavailable_without_mcps_url(db, host, monkeypatch):
    monkeypatch.setenv('MCPS_URL', '')
    assert host.ctl(db).info(req(3))['data'] == {'available': False}
    r = host.ctl(db).install(req(3, {'files': []}), 'a')
    assert r['status_code'] == 404
    assert r['data']['error'] == 'no server host'
    assert host.calls == []


def test_info_reports_gateway(db, host):
    assert host.ctl(db).info(req(3))['data'] == {'available': True, 'gateway': 'http://localhost:8791'}


def test_install_sends_caller_as_owner(db, host):
    host.reply = (200, '{"ok":true}')
    r = host.ctl(db).install(req(3, {'files': [], 'installed_by': 999}), 'new')
    assert r['status_code'] == 200
    assert host.calls[0]['method'] == 'POST'
    assert host.calls[0]['url'].endswith('/servers/new/install')
    assert json.loads(host.calls[0]['body'])['installed_by'] == 3


def test_corporate_install_is_admin_only(db, host):
    host.reply = (200, '{"ok":true}')
    corp = host.ctl(db, {'edition': 'corporate'})
    r = corp.install(req(3, {'files': []}), 'new')
    assert r['status_code'] == 403
    assert r['data']['error'] == 'Only an admin can install MCP servers here.'
    assert host.calls == []
    assert corp.install(req(1, {'files': []}), 'new')['status_code'] == 200
    assert host.ctl(db, {'edition': 'individual'}).install(req(3, {'files': []}), 'new')['status_code'] == 200


def test_others_cannot_touch_or_see_logs(db, host):
    c = host.ctl(db)
    assert c.restart(req(4), 'a')['status_code'] == 403
    assert len(host.calls) == 1   # only the list lookup
    lst = c.list(req(4))['data']
    assert 'log' not in lst[0]
    assert 'log' in lst[1]
    assert 'log' in c.list(req(1))['data'][0]
    assert c.restart(req(1), 'a')['status_code'] == 200
    assert c.restart(req(1), 'zzz')['status_code'] == 404


def test_supervisor_down_is_a_503_with_text(db, host):
    host.reply = (0, '')
    r = host.ctl(db).list(req(3))
    assert r['status_code'] == 503
    assert r['data']['error'] == 'The server host is not reachable'


def test_status_passes_through(db, host):
    host.reply = (409, '{"error":"disabled"}')
    r = host.ctl(db).restart(req(1), 'a')
    assert r['status_code'] == 409
    assert r['data']['error'] == 'disabled'
    assert r['error'] == 'disabled'


def test_raw_folder_survives_numeric_cast(db, host):
    host.reply = (200, '{"ok":true}')
    host.ctl(db).install({'user_id': 3, 'body': {}, 'params': {'folder': '007'}}, 7)
    assert host.calls[0]['url'].endswith('/servers/007/install')


def test_bad_folder_is_400(db, host):
    assert host.ctl(db).install(req(3), '.hidden')['status_code'] == 400


def test_token_is_sent_and_never_returned(db, host):
    r = host.ctl(db).list(req(1))
    assert 'Authorization: Bearer tok' in host.calls[0]['headers']
    assert 'tok' not in json.dumps(r)


def test_schema_put_relays_the_list(db, host):
    host.ctl(db).putSchema(req(3, {'env': [{'name': 'X', 'required': True}]}), 'a')
    assert host.calls[1]['method'] == 'PUT'
    assert host.calls[1]['url'].endswith('/servers/a/schema')
    assert json.loads(host.calls[1]['body']) == {'env': [{'name': 'X', 'required': True}]}


def test_settings_put_relays_body(db, host):
    c = host.ctl(db)
    c.putSettings(req(3, {'env': {'K': 'v'}}), 'a')
    assert host.calls[1]['method'] == 'PUT'
    assert host.calls[1]['url'].endswith('/servers/a/settings')
    assert json.loads(host.calls[1]['body']) == {'env': {'K': 'v'}}
    c.delete(req(3), 'a')
    assert host.calls[3]['method'] == 'DELETE' and host.calls[3]['url'].endswith('/servers/a')
    assert host.calls[3]['body'] is None


def test_timeout_per_route():
    base = 'http://mcps:8790/servers'
    assert McpHostClient.timeoutFor('POST', f'{base}/a/install') == 900
    assert McpHostClient.timeoutFor('POST', f'{base}/a/restart') == 30
    assert McpHostClient.timeoutFor('POST', f'{base}/a/enabled') == 30
    assert McpHostClient.timeoutFor('DELETE', f'{base}/a') == 30
    assert McpHostClient.timeoutFor('PUT', f'{base}/a/settings') == 30
    assert McpHostClient.timeoutFor('GET', f'{base}/a/settings') == 15
    assert McpHostClient.timeoutFor('GET', f'{base}/a/source') == 15
    assert McpHostClient.timeoutFor('GET', base) == 15


def test_internal_rewrites_only_the_gateway_when_set(monkeypatch):
    monkeypatch.setenv('MCPS_GATEWAY', 'http://mcps:8790')
    monkeypatch.setenv('MCPS_PUBLIC_GATEWAY', 'http://localhost:8790')
    assert McpEndpoint.internal('http://localhost:8790/outlook_mcp/mcp') == 'http://mcps:8790/outlook_mcp/mcp'
    assert McpEndpoint.internal('http://127.0.0.1:8790/outlook_mcp/mcp') == 'http://mcps:8790/outlook_mcp/mcp'
    assert McpEndpoint.internal('http://localhost:8770/mcp') == 'http://localhost:8770/mcp'
    assert McpEndpoint.internal('http://localhost:87901/x') == 'http://localhost:87901/x'
    assert McpEndpoint.candidates('http://localhost:8790/outlook_mcp/mcp') == ['http://mcps:8790/outlook_mcp/mcp']


def test_internal_unchanged_when_unset(monkeypatch):
    monkeypatch.delenv('MCPS_GATEWAY', raising=False)
    monkeypatch.delenv('MCPS_PUBLIC_GATEWAY', raising=False)
    assert McpEndpoint.internal('http://localhost:8790/a/mcp') == 'http://localhost:8790/a/mcp'
