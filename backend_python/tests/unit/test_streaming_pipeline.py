import json
import time
import jwt
import pytest
from fastapi.testclient import TestClient


class StreamCtl:
    def __init__(self, db, config): pass
    def go(self, request):
        sse = request['sse']
        sse.send('progress', 'Claude: Thinking...')
        sse.send('chunk', 'hel\nlo')
        sse.send('response', {'success': True, 'text': 'hello'})
        sse.send('complete', {'status': 'done'})
        sse.end()
        request['_after'] = 'ran'          # post-stream work still runs
        return {'streaming_handled': True, 'status_code': 200}
    def boom(self, request):
        request['sse'].send('progress', 'x')
        raise RuntimeError('provider exploded')
    def upload(self, request):
        f = request['files'].get('file')
        return {'success': True, 'name': f['name'], 'size': f['size'], 'type': f['type'],
                'has_tmp': __import__('os').path.isfile(f['tmp_name']), 'note': request['body'].get('note')}


ROUTES = [('POST', '/t/stream', ('StreamCtl', 'go')), ('POST', '/t/boom', ('StreamCtl', 'boom')),
          ('POST', '/t/upload', ('StreamCtl', 'upload'))]


@pytest.fixture(scope='module')
def app_client(config):
    from main import create_app
    return TestClient(create_app(config, controllers={'StreamCtl': StreamCtl}, routes=ROUTES))


def _auth(config):
    now = int(time.time())
    return {'Authorization': 'Bearer ' + jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 600, 'sub': 3, 'type': 'access'},
                                                    config['auth']['jwt_secret'], 'HS256')}


def test_streaming_response_frames_and_headers(app_client, config):
    with app_client.stream('POST', '/t/stream', json={}, headers=_auth(config)) as r:
        assert r.status_code == 200
        assert r.headers['content-type'].startswith('text/event-stream')
        assert r.headers['cache-control'] == 'no-cache' and r.headers['x-accel-buffering'] == 'no'
        assert r.headers['access-control-allow-origin'] == '*'
        body = b''.join(r.iter_bytes())
    assert body == (b'event: progress\ndata: Claude: Thinking...\n\n'
                    b'event: chunk\ndata: hel\ndata: lo\n\n'
                    b'event: response\ndata: {"success":true,"text":"hello"}\n\n'
                    b'event: complete\ndata: {"status":"done"}\n\n')


def test_exception_after_stream_start_ends_stream_cleanly(app_client, config):
    with app_client.stream('POST', '/t/boom', json={}, headers=_auth(config)) as r:
        assert r.status_code == 200
        body = b''.join(r.iter_bytes())
    assert body == b'event: progress\ndata: x\n\n'      # stream closed; error logged, not rendered as JSON


def test_multipart_files_shape_like_php(app_client, config):
    r = app_client.post('/t/upload', files={'file': ('a.txt', b'hello', 'text/plain')}, data={'note': 'n1'},
                        headers=_auth(config))
    assert r.status_code == 200
    j = r.json()
    assert j['name'] == 'a.txt' and j['size'] == 5 and j['type'] == 'text/plain' and j['has_tmp'] is True and j['note'] == 'n1'


def test_non_stream_route_unaffected(client):
    assert client.get('/').status_code == 200
