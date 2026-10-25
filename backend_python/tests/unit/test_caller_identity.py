"""A signed-in user who puts another user's id in the body or query string is
still treated as themselves: the authenticated request user_id wins.

Twin of backend/tests/Unit/CallerIdentityTest.php.
"""
import pytest

from app.controllers.chat_controller import ChatController
from app.controllers.hume_tool_controller import HumeToolController
from app.controllers.mcp_proxy_controller import MCPProxyController
from app.controllers.mcp_server_controller import MCPServerController
from tests.unit import test_chat_controller_flows as chat_flows
from tests.unit import test_mcp_proxy_app as proxy_t
from tests.unit import test_mcp_server_controller as srv

ME = 3
VICTIM = '9'


def test_mcp_create_owns_the_server_as_the_caller():
    db = srv.FakeDb()
    srv.c(db).create(srv.ctx(body={'user_id': VICTIM, 'name': 'n', 'url': 'http://127.0.0.1:1/mcp'}))
    assert db.calls[0][1][0] == ME


def test_mcp_update_is_scoped_to_the_caller():
    db = srv.FakeDb()
    srv.c(db).update(srv.ctx(body={'user_id': VICTIM, 'server_id': 1, 'name': 'n', 'url': 'http://127.0.0.1:1/mcp'}))
    assert db.calls[0][1][-1] == ME


def test_mcp_toggle_is_scoped_to_the_caller():
    db = srv.FakeDb()
    srv.c(db).toggle(srv.ctx(body={'user_id': VICTIM, 'server_id': 1, 'enabled': False}))
    assert db.calls[0][1][-1] == ME


def test_mcp_delete_is_scoped_to_the_caller():
    db = srv.FakeDb()
    srv.c(db).delete(srv.ctx(query={'user_id': VICTIM, 'server_id': 1}, method='DELETE'))
    assert db.calls[0][1][-1] == ME


def test_mcp_list_ignores_a_query_user_id():
    db = srv.FakeDb()
    srv.c(db).list(srv.ctx(query={'user_id': VICTIM}, method='GET'))
    assert db.calls[0][1] == {':uid': str(ME)}


def test_mcp_get_tools_ignores_a_query_user_id():
    db = srv.FakeDb()
    srv.c(db).getTools(srv.ctx(query={'user_id': VICTIM, 'server_id': 1}, method='GET'))
    assert db.calls[0][1][-1] == str(ME)


def test_mcp_get_all_tools_ignores_a_query_user_id():
    db = srv.FakeDb()
    srv.c(db).getAllTools(srv.ctx(query={'user_id': VICTIM}, method='GET'))
    assert db.calls[0][1] == {':uid': str(ME)}


def test_mcp_proxy_looks_servers_up_as_the_caller():
    db = proxy_t.FakeDb()
    MCPProxyController(db, {}).forward(proxy_t.ctx(body={'action': 'proxy', 'server_id': 1, 'user_id': VICTIM}))
    assert db.calls, 'the server lookup ran'
    assert all(p[-1] == str(ME) for _, p in db.calls)


def test_hume_tool_runs_as_the_caller():
    ctl = HumeToolController(srv.FakeDb(), {'hume_evi': {'api_key': '', 'base_url': 'https://x', 'config_id': 'c'}})
    try:
        seen = {}
        ctl.toolsManager.registerFunction('probe_tool', lambda params, context: seen.setdefault('ctx', context) and {},
                                          {'description': 'd', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}})
        ctl.execute({'body': {'toolCallId': 't1', 'toolName': 'probe_tool', 'userId': VICTIM}, 'user_id': ME})
        assert seen['ctx'] == ME
    finally:
        ctl.close()


@pytest.mark.parametrize('method,body', [
    ('chat', {'message': 'hi', 'provider': 'claude'}),
    ('agent', {'prompt': 'hi', 'provider': 'claude'}),
    ('verify', {'original_message': 'q', 'response_text': 'a', 'verifier_provider': 'claude'}),
    ('compareOnly', {'message': 'hi', 'compare_provider': 'claude'}),
])
def test_chat_endpoints_charge_the_caller_not_the_body_user(monkeypatch, method, body):
    seen = []

    def quota(self, userId):
        seen.append(userId)
        return {'success': False, 'code': 'QUOTA_EXCEEDED', 'status_code': 403}

    monkeypatch.setattr(ChatController, '_checkFreeTrialQuota', quota)
    c = ChatController(chat_flows.Db(), chat_flows.CFG)
    r = getattr(c, method)(chat_flows.ctx({**body, 'user_id': VICTIM}, user_id=ME))
    assert r['code'] == 'QUOTA_EXCEEDED'
    assert seen == [str(ME)]
