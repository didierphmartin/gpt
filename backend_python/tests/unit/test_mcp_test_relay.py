"""McpTestRelay + McpTestController — port of the PHP oracles
backend/tests/Unit/McpTestRelayTest.php and Controllers/McpTestControllerTest.php."""
from __future__ import annotations

import json

import pytest

from app.controllers.mcp_test_controller import McpTestController
from app.services.mcp_endpoint import McpEndpoint
from app.services.mcp_test_relay import McpTestRelay


class Recorder:
    def __init__(self, reply=None):
        self.reply = {'status': 200, 'headers': {}, 'body': '{}', 'error': None, **(reply or {})}
        self.calls = []

    def __call__(self, url, lines, body, timeout):
        self.calls.append({'url': url, 'lines': lines, 'body': body, 'timeout': timeout})
        return self.reply


# ─── relay ──────────────────────────────────────────────────────────────────

def test_sends_message_unchanged():
    rec = Recorder()
    msg = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'x', 'arguments': {}}}
    McpTestRelay(rec).relay('http://h/mcp', {}, msg, None, '2025-11-25')
    assert json.loads(rec.calls[0]['body']) == msg
    assert '"arguments":{}' in rec.calls[0]['body']
    assert '"params":{"capabilities":{}}' in _sent({'params': {'capabilities': {}}})
    assert rec.calls[0]['timeout'] == 20


def _sent(msg):
    rec = Recorder()
    McpTestRelay(rec).relay('http://h/mcp', {}, msg, None, '')
    return rec.calls[0]['body']


def test_protocol_and_session_headers():
    rec = Recorder()
    r = McpTestRelay(rec)
    r.relay('http://h/mcp', {'X-A': 'b'}, {'a': 1}, 'abc', '2025-11-25')
    assert 'mcp-protocol-version: 2025-11-25' in rec.calls[0]['lines']
    assert 'mcp-session-id: abc' in rec.calls[0]['lines']
    assert 'X-A: b' in rec.calls[0]['lines']
    for sid in (None, ''):
        r.relay('http://h/mcp', {}, {'a': 1}, sid, '2025-11-25')
        assert 'mcp-session-id' not in '\n'.join(rec.calls[-1]['lines'])


def test_empty_protocol_version_omits_header():
    rec = Recorder()
    McpTestRelay(rec).relay('http://h/mcp', {}, {'a': 1}, None, '')
    assert 'mcp-protocol-version' not in '\n'.join(rec.calls[0]['lines'])


def test_session_and_version_crlf_stripped():
    rec = Recorder()
    McpTestRelay(rec).relay('http://h/mcp', {}, {'a': 1}, 'abc\r\nX-Evil: 1', '2025-11-25\r\nX-Bad: 2')
    lines = rec.calls[0]['lines']
    assert 'mcp-session-id: abcX-Evil: 1' in lines
    assert 'mcp-protocol-version: 2025-11-25X-Bad: 2' in lines
    assert not any('\r' in ln or '\n' in ln for ln in lines)


def test_parses_sse_events():
    body = ('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'
            'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
    m = McpTestRelay.parseMessages('text/event-stream; charset=utf-8', body)
    assert len(m) == 2
    assert m[1]['id'] == 1


def test_parsed_messages_keep_empty_objects():
    j = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},"serverInfo":{"name":"s"}}}'
    dump = lambda v: json.dumps(v, separators=(',', ':'))  # noqa: E731
    assert dump(McpTestRelay.parseMessages('application/json', j)) == '[' + j + ']'
    assert dump(McpTestRelay.parseMessages('text/event-stream', f'event: message\ndata: {j}\n\n')) == '[' + j + ']'
    batch = '[' + j + ',{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}]'
    assert dump(McpTestRelay.parseMessages('application/json', batch)) == batch


def test_parses_json_and_batch():
    assert len(McpTestRelay.parseMessages('application/json', '{"id":1}')) == 1
    assert len(McpTestRelay.parseMessages('application/json', '[{"id":1},{"id":2}]')) == 2
    assert McpTestRelay.parseMessages('text/html', '<html>no</html>') == []


def test_exposes_only_three_headers():
    out = McpTestRelay.exposedHeaders({
        'Content-Type': 'a', 'mcp-session-id': 'b', 'mcp-protocol-version': 'c',
        'set-cookie': 'x', 'authorization': 'y', 'x-api-key': 'z',
    })
    assert list(out) == ['content-type', 'mcp-session-id', 'mcp-protocol-version']


def test_transport_error_is_returned_not_thrown():
    r = McpTestRelay(Recorder({'status': 0, 'body': '', 'error': 'Could not resolve host'})).relay(
        'http://h/mcp', {}, {'a': 1}, None, '2025-11-25')
    assert r['error'] == 'Could not resolve host'
    assert r['messages'] == []
    assert r['status'] == 0

    def boom(*_):
        raise RuntimeError('kaput')
    assert McpTestRelay(boom).relay('http://h/mcp', {}, {'a': 1}, None, '')['error'] == 'kaput'


def test_send_does_not_follow_redirects(monkeypatch):
    import httpx
    seen = {}
    real = httpx.Client

    def handler(req):
        seen['headers'] = dict(req.headers)
        return httpx.Response(301, headers={'location': 'http://elsewhere/'})
    monkeypatch.setattr(httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    res = McpTestRelay.send('http://h/mcp', ['mcp-session-id: s1'], '{}', 20)
    assert res['status'] == 301
    assert seen['headers']['mcp-session-id'] == 's1'
    assert seen['headers']['accept'] == 'application/json, text/event-stream'


# ─── McpEndpoint additions ──────────────────────────────────────────────────

def test_decode_stored_headers():
    assert McpEndpoint.decodeStoredHeaders(None) == {}
    assert McpEndpoint.decodeStoredHeaders('not json') == {}
    assert McpEndpoint.decodeStoredHeaders('["a"]') == {}
    assert McpEndpoint.decodeStoredHeaders('{"X:K\\r\\n":"v\\r\\n1","n":2,"o":{"x":1},"t":true}') == {'XK': 'v1', 'n': '2', 't': '1'}


def test_internal_maps_public_gateway(monkeypatch):
    monkeypatch.delenv('MCPS_GATEWAY', raising=False)
    assert McpEndpoint.internal('http://localhost:8790/a/mcp') == 'http://localhost:8790/a/mcp'
    monkeypatch.setenv('MCPS_GATEWAY', 'http://mcps:8790')
    monkeypatch.setenv('MCPS_PUBLIC_GATEWAY', 'http://localhost:8790/')
    assert McpEndpoint.internal('http://localhost:8790/a/mcp') == 'http://mcps:8790/a/mcp'
    assert McpEndpoint.internal('http://127.0.0.1:8790/a/mcp') == 'http://mcps:8790/a/mcp'
    assert McpEndpoint.internal('https://x.test/mcp') == 'https://x.test/mcp'


# ─── controller ─────────────────────────────────────────────────────────────

SERVERS = {
    1: {'user_id': None, 'url': 'https://stored.test/mcp', 'headers': '{"X-Key":"s3cret"}', 'transport': 'http', 'enabled': 0},
    2: {'user_id': 'u2', 'url': 'https://other.test/mcp', 'headers': '{"X-Key":"s3cret"}', 'transport': 'http', 'enabled': 1},
}
ROLES = {'u1': 'user', 'adm': 'admin'}


class FakeDb:
    def fetch_one(self, sql, params=None):
        params = params or {}
        if sql.startswith('SELECT role FROM users'):
            role = ROLES.get(params[':id'])
            return {'role': role} if role else None
        row = SERVERS.get(params[':id'])
        if row is None:
            return None
        if ':uid' in params and row['user_id'] not in (None, params[':uid']):
            return None
        return dict(row)


@pytest.fixture
def rec():
    return Recorder()


def ctl(rec):
    return McpTestController(FakeDb(), {}, McpTestRelay(rec))


def req(body, user='u1'):
    return {'user_id': user, 'body': {'message': {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'},
                                      'protocol_version': '2025-11-25', **body}}


def test_by_server_id_uses_stored_url_and_headers(rec):
    res = ctl(rec).test(req({'server_id': 1, 'server_url': 'https://evil.test', 'headers': {'X-Key': 'evil'}}))
    assert res['success'] is True
    assert rec.calls[0]['url'] == 'https://stored.test/mcp'
    assert 'X-Key: s3cret' in rec.calls[0]['lines']
    assert 'X-Key: evil' not in rec.calls[0]['lines']


def test_other_users_server_is_404(rec):
    res = ctl(rec).test(req({'server_id': 2}))
    assert res['success'] is False and res['status_code'] == 404
    assert rec.calls == []


def test_unsaved_server_by_url_and_headers(rec):
    res = ctl(rec).test(req({'server_url': 'https://new.test/mcp', 'headers': {'X-A': 'b'}}))
    assert res['success'] is True
    assert rec.calls[0]['url'] == 'https://new.test/mcp'
    assert 'X-A: b' in rec.calls[0]['lines']


def test_sibling_and_sse(rec):
    assert McpTestController.endpointFor('https://x.test', 'http', True) == 'https://x.test/mcp'
    assert McpTestController.endpointFor('https://x.test/mcp', 'http', True) is None
    assert McpTestController.endpointFor('https://x.test/sse', 'sse', False) == 'https://x.test/mcp'
    assert ctl(rec).test(req({'server_url': 'https://x.test/mcp', 'sibling': True}))['status_code'] == 400


def test_admin_tests_any_row_and_requires_admin(rec):
    assert ctl(rec).adminTest(req({'server_id': 2}, 'u1'))['status_code'] == 403
    assert rec.calls == []
    assert ctl(rec).adminTest(req({'server_url': 'https://x.test/mcp'}, 'adm'))['status_code'] == 400
    res = ctl(rec).adminTest(req({'server_id': 2}, 'adm'))
    assert res['success'] is True
    assert 'X-Key: s3cret' in rec.calls[0]['lines']


def test_missing_message_is_400(rec):
    r = req({'server_url': 'https://x.test/mcp'})
    del r['body']['message']
    assert ctl(rec).test(r)['status_code'] == 400
    assert ctl(rec).test(req({'server_id': 1}, None))['status_code'] == 401


@pytest.mark.parametrize('version', [None, ''])
def test_protocol_version_optional(rec, version):
    r = req({'server_url': 'https://x.test/mcp'})
    if version is None:
        del r['body']['protocol_version']
    else:
        r['body']['protocol_version'] = version
    assert ctl(rec).test(r)['success'] is True
    assert 'mcp-protocol-version' not in '\n'.join(rec.calls[0]['lines'])


def test_message_relayed_verbatim(rec):
    raw = ('{"message":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},'
           '"clientInfo":{"name":"t"}}},"server_url":"https://x.test/mcp","protocol_version":"2025-11-25"}')
    res = ctl(rec).test({'user_id': 'u1', 'body': json.loads(raw), 'raw_body': raw})
    assert res['success'] is True
    assert rec.calls[0]['body'] == json.dumps(json.loads(raw)['message'], separators=(',', ':'))


def test_response_never_contains_stored_secrets(rec):
    assert 's3cret' not in json.dumps(ctl(rec).test(req({'server_id': 1})))
