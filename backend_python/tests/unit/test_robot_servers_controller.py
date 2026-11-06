"""Port of backend/tests/Unit/Controllers/RobotServersControllerTest.php: the robot's own MCP server rows."""
from __future__ import annotations

import json

import pytest

from app.controllers.mcp_proxy_controller import MCPProxyController
from app.controllers.robot_servers_controller import RobotServersController
from app.services.robot_account import RobotAccount
from tests.unit import robot_schema

CONFIG = {'edition': 'corporate'}


class RecordingProxy(MCPProxyController):
    """MCPProxyController with the wire stubbed: records what would have been sent."""
    sent: list = []

    def ensureTablesExist(self) -> None:
        pass

    def _sendToMCPServer(self, serverUrl, request, expectResponse=True, extraHeaders=None, transport='http'):
        RecordingProxy.sent.append([serverUrl, request.get('method'), list(extraHeaders or [])])
        return {'jsonrpc': '2.0', 'id': request.get('id', 1), 'result': {'ok': True}}


@pytest.fixture
def db():
    d, _ = robot_schema.create()
    d.execute('DROP TABLE mcp_servers')   # the shared fixture's table lacks description/transport
    d.execute("CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NULL, name TEXT NOT NULL,"
              " url TEXT NOT NULL, description TEXT, headers TEXT NULL, transport TEXT DEFAULT 'http', enabled INTEGER DEFAULT 1,"
              " is_mock INTEGER DEFAULT 0, UNIQUE (user_id, name))")
    d.robot = RobotAccount.ensure(d)
    RecordingProxy.sent = []
    return d


def ctl(db) -> RobotServersController:
    return RobotServersController(db, CONFIG, lambda: RecordingProxy(db, CONFIG))


def req(u, body=None, params=None):
    return {'user_id': u, 'body': body or {}, 'params': params or {}}


def add(db, b=None) -> int:
    return ctl(db).create(req(2, {'name': 'Outlook', 'url': 'https://mcp.test/outlook', **(b or {})}))['data']['id']


def count(db) -> int:
    return db.fetch_one('SELECT COUNT(*) AS n FROM mcp_servers')['n']


def test_list_shows_header_names_not_values(db):
    id = add(db, {'description': 'mail'})
    ctl(db).saveKey(req(2, {'header': 'X-Org-Key', 'key': 'sekret-value'}, {'id': id}))
    r = ctl(db).index(req(2))
    assert r['data'] == [{'id': id, 'name': 'Outlook', 'url': 'https://mcp.test/outlook', 'description': 'mail',
                          'enabled': True, 'header_names': ['X-Org-Key']}]
    assert list(r['data'][0]) == ['id', 'name', 'url', 'description', 'enabled', 'header_names']
    assert 'sekret-value' not in json.dumps(r)


def test_crud_only_on_robot_rows(db):
    own = 99
    db.execute(f"INSERT INTO mcp_servers (id, user_id, name, url) VALUES ({own}, '2', 'Mine', 'https://x.test')")
    c = ctl(db)
    assert c.index(req(2))['data'] == []
    for r in (c.update(req(2, {'name': 'Z'}, {'id': own})), c.destroy(req(2, {}, {'id': own})),
              c.call(req(2, {'tool': 't'}, {'id': own})),
              c.saveKey(req(2, {'header': 'H', 'key': 'k'}, {'id': own}))):
        assert [r['success'], r['status_code']] == [False, 404]
        assert r['error'] == 'Server not found'
    assert db.fetch_one(f'SELECT name FROM mcp_servers WHERE id = {own}')['name'] == 'Mine'

    id = add(db)
    assert c.update(req(2, {'name': 'Outlook2', 'enabled': False}, {'id': id}))['success'] is True
    row = db.fetch_one(f'SELECT name, enabled, user_id FROM mcp_servers WHERE id = {id}')
    assert [row['name'], int(row['enabled']), str(row['user_id'])] == ['Outlook2', 0, str(db.robot)]
    assert c.destroy(req(2, {}, {'id': id}))['success'] is True
    assert count(db) == 1


def test_key_merged_into_headers(db):
    id = add(db)
    ctl(db).saveKey(req(2, {'header': 'X-A', 'key': 'one'}, {'id': id}))
    ctl(db).saveKey(req(2, {'header': 'X-B', 'key': 'two'}, {'id': id}))
    ctl(db).saveKey(req(2, {'header': 'X-A', 'key': 'three'}, {'id': id}))
    h = json.loads(db.fetch_one(f'SELECT headers FROM mcp_servers WHERE id = {id}')['headers'])
    assert h == {'X-A': 'three', 'X-B': 'two'} and list(h) == ['X-A', 'X-B']
    assert ctl(db).saveKey(req(2, {'header': '', 'key': 'k'}, {'id': id}))['status_code'] == 400
    for bad in ({'header': 'X A', 'key': 'k'}, {'header': 'X:A', 'key': 'k'}, {'header': 'X-A', 'key': 'a\nb'},
                {'header': 'X-A', 'key': ''}):
        r = ctl(db).saveKey(req(2, bad, {'id': id}))
        assert (r['status_code'], r['error']) == (400, 'A header name and a key are required')


def test_call_uses_row_headers(db):
    id = add(db)
    ctl(db).saveKey(req(2, {'header': 'X-Org-Key', 'key': 'abc'}, {'id': id}))
    r = ctl(db).call(req(2, {'tool': 'list_mail', 'arguments': {'n': 1}}, {'id': id}))
    assert r['success'] is True
    assert r['data']['result'] == {'ok': True}
    assert RecordingProxy.sent[-1] == ['https://mcp.test/outlook', 'tools/call', ['X-Org-Key: abc']]


def test_url_change_clears_key_so_it_is_never_sent_elsewhere(db):
    id = add(db)
    ctl(db).saveKey(req(2, {'header': 'X-Org-Key', 'key': 'abc'}, {'id': id}))
    assert ctl(db).update(req(2, {'url': 'https://evil.test/mcp'}, {'id': id}))['success'] is True
    assert ctl(db).index(req(2))['data'][0]['header_names'] == []
    ctl(db).call(req(2, {'tool': 't'}, {'id': id}))
    assert [h for s in RecordingProxy.sent for h in s[2]] == []
    assert RecordingProxy.sent[0][0] == 'https://evil.test/mcp'
    # an unchanged url keeps the key
    ctl(db).saveKey(req(2, {'header': 'X-Org-Key', 'key': 'abc'}, {'id': id}))
    ctl(db).update(req(2, {'url': 'https://evil.test/mcp', 'description': 'd'}, {'id': id}))
    assert ctl(db).index(req(2))['data'][0]['header_names'] == ['X-Org-Key']
    r = ctl(db).update(req(2, {'url': 'not a url'}, {'id': id}))
    assert (r['status_code'], r['error']) == (400, 'Invalid URL format')


def test_call_refuses_disabled_row(db):
    id = add(db)
    ctl(db).update(req(2, {'enabled': False}, {'id': id}))
    r = ctl(db).call(req(2, {'tool': 't'}, {'id': id}))
    assert [r['success'], r['status_code']] == [False, 409]
    assert RecordingProxy.sent == []


def test_rename_to_existing_name_409(db):
    a = add(db)
    b = add(db, {'name': 'SharePoint'})
    r = ctl(db).update(req(2, {'name': 'Outlook'}, {'id': b}))
    assert [r['success'], r['status_code']] == [False, 409]
    assert ctl(db).update(req(2, {'name': 'Outlook', 'description': 'x'}, {'id': a}))['success'] is True


def test_create_validation(db):
    add(db)
    assert ctl(db).create(req(2, {'name': 'Outlook', 'url': 'https://mcp.test/x'}))['status_code'] == 409
    r = ctl(db).create(req(2, {'name': 'N', 'url': 'nope'}))
    assert (r['status_code'], r['error']) == (400, 'Name and a valid URL are required')


def test_every_route_403_without_use_robot(db):
    id = add(db)
    c = ctl(db)
    p = {'id': id}
    for r in (c.index(req(1)), c.compileEnv(req(1)), c.create(req(1, {'name': 'N', 'url': 'https://a.test'})),
              c.update(req(1, {'name': 'N'}, p)), c.destroy(req(1, {}, p)),
              c.call(req(1, {'tool': 't'}, p)), c.saveKey(req(1, {'header': 'H', 'key': 'k'}, p))):
        assert [r['success'], r['status_code'], r['kind']] == [False, 403, 'forbidden']
    assert count(db) == 1
    assert c.index(req(0))['status_code'] == 401
