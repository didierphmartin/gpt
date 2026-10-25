"""Port of backend/tests/Unit/EventWorker/WatchCallTest.php."""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.watch_call import WatchCall
from tests.unit import event_worker_schema as S


@pytest.fixture
def db():
    return S.create(lambda: '2026-10-14 09:00:00')


def server(db, user, name, url, headers, enabled=1):
    db.execute('INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (?, ?, ?, ?, ?)',
               [user, name, url, headers, enabled])


def test_the_users_own_server_wins(db):
    server(db, None, 'Outlook', 'http://global/mcp', '{}')
    server(db, 3, 'Outlook', 'http://mine/mcp', '{"X-Outlook-Key":"k"}')
    server(db, 4, 'Outlook', 'http://theirs/mcp', '{}')
    assert WatchCall.server(db, 3, 'Outlook') == {'url': 'http://mine/mcp', 'headers': {'X-Outlook-Key': 'k'}}
    assert WatchCall.server(db, 5, 'outlook')['url'] == 'http://global/mcp'   # matched by slug


def test_a_disabled_or_missing_server_is_none(db):
    server(db, 3, 'Outlook', 'http://mine/mcp', '{}', 0)
    assert WatchCall.server(db, 3, 'Outlook') is None
    assert WatchCall.server(db, 3, 'Google') is None


def test_invalid_headers_json_means_no_headers(db):
    server(db, 3, 'Outlook', 'http://mine/mcp', 'not json')
    assert WatchCall.server(db, 3, 'Outlook')['headers'] == {}
    db.execute('UPDATE mcp_servers SET headers = NULL')
    assert WatchCall.server(db, 3, 'Outlook')['headers'] == {}


def test_the_request():
    url, lines, body = WatchCall.request({'url': 'http://h/mcp', 'headers': {'X-Outlook-Key': 'k'}}, S.WATCH, 7)
    assert url == 'http://h/mcp'
    assert 'X-Outlook-Key: k' in lines
    assert 'Content-Type: application/json' in lines
    assert json.loads(body) == {'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call',
                                'params': {'name': 'wait_for_new', 'arguments': {'args': {'folder': 'Inbox'}}}}
    _, _, empty = WatchCall.request({'url': 'u', 'headers': {}}, {'server': 's', 'tool': 't', 'args': []}, 1)
    assert '"arguments":{}' in empty


def rpc(payload: dict, structured: bool = True) -> str:
    result = ({'structuredContent': payload, 'content': [{'type': 'text', 'text': json.dumps(payload)}]} if structured
              else {'content': [{'type': 'text', 'text': json.dumps(payload)}]})
    return json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': result})


def test_answers():
    assert WatchCall.answer(rpc({'status': 'ready', 'via': 'event', 'events': 'on'}), 200, '') == \
        {'status': 'ready', 'via': 'event', 'events': 'on'}
    assert WatchCall.answer(rpc({'status': 'timeout', 'events': 'off'}, False), 200, '') == \
        {'status': 'timeout', 'via': None, 'events': 'off'}
    assert WatchCall.answer('event: message\ndata: ' + rpc({'status': 'ready'}) + '\n\n', 200, '')['status'] == 'ready'


def test_errors():
    assert WatchCall.answer(rpc({'error': 'reconnect_needed', 'message': 'x'}), 200, '') == \
        {'status': 'error', 'message': 'reconnect_needed'}
    assert WatchCall.answer(False, 0, 'Connection refused') == {'status': 'error', 'message': 'unreachable'}
    assert WatchCall.answer('<html>', 502, '') == {'status': 'error', 'message': 'http_502'}
    assert WatchCall.answer('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}', 200, '') == \
        {'status': 'error', 'message': 'rpc_error'}
    assert WatchCall.answer(rpc({'status': 'maybe'}), 200, '') == {'status': 'error', 'message': 'bad_answer'}
    assert WatchCall.answer('not json', 200, '') == {'status': 'error', 'message': 'bad_answer'}


def test_error_object_from_the_servicenow_connector():
    assert WatchCall.answer(rpc({'error': {'code': 'servicenow_error', 'message': 'down'}}), 200, '') == \
        {'status': 'error', 'message': 'servicenow_error'}
