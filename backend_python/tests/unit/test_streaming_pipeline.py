import asyncio
import glob
import os
import tempfile
import time
import jwt
import pytest
from fastapi.testclient import TestClient

ABORT_ERRORS = []


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
                'has_tmp': os.path.isfile(f['tmp_name']), 'note': request['body'].get('note')}
    def no_send(self, request):
        # streaming_handled but the controller never called sse.send()/end() — the
        # non-streaming fallback path in main.py must still render a real response.
        return {'streaming_handled': True}
    def slow(self, request):
        sse = request['sse']
        sse.send('progress', 'first')
        time.sleep(0.3)          # give the test time to disconnect after the first frame
        try:
            sse.send('progress', 'second')
        except RuntimeError as e:
            ABORT_ERRORS.append(str(e))
        request['_after'] = 'ran'
        return {'streaming_handled': True, 'status_code': 200}


ROUTES = [('POST', '/t/stream', ('StreamCtl', 'go')), ('POST', '/t/boom', ('StreamCtl', 'boom')),
          ('POST', '/t/upload', ('StreamCtl', 'upload')), ('POST', '/t/no-send', ('StreamCtl', 'no_send')),
          ('POST', '/t/slow', ('StreamCtl', 'slow'))]


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
        assert r.headers['connection'] == 'keep-alive'
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


def test_multipart_repeated_field_cleans_up_all_temp_files(app_client, config):
    tmp_dir = tempfile.gettempdir()
    before = set(glob.glob(os.path.join(tmp_dir, 'php_upload_*')))
    r = app_client.post('/t/upload', headers=_auth(config),
                        files=[('file', ('a.txt', b'aaa', 'text/plain')),
                               ('file', ('b.txt', b'bbb', 'text/plain'))])
    assert r.status_code == 200
    after = set(glob.glob(os.path.join(tmp_dir, 'php_upload_*')))
    assert after - before == set()   # both temp files removed, including the one the dict-collision orphaned


def test_non_stream_route_unaffected(client):
    assert client.get('/').status_code == 200


def test_streaming_handled_without_any_send_falls_back_to_empty_200(app_client, config):
    r = app_client.post('/t/no-send', json={}, headers=_auth(config))
    assert r.status_code == 200
    assert r.content == b''
    assert r.headers['access-control-allow-origin'] == '*'


def test_client_disconnect_marks_aborted_and_stops_controller_thread(app_client, config):
    """Starlette's TestClient (httpx-backed) fully drains a StreamingResponse before
    returning anything to the caller, so a client-side `break` out of `iter_bytes()`
    can't reproduce a real mid-stream disconnect here. Instead this drives the ASGI
    app directly and cancels the request task while it is suspended *inside*
    Starlette's `send()` call for the first chunk — i.e. NOT inside gen()'s own
    `await sse.queue.get()`. That mirrors spec_version >= 2.4's real disconnect path
    (StreamingResponse.stream_response has no try/finally around `body_iterator`), so
    gen() is abandoned mid-yield and only reclaimed later by asyncio's async-generator
    finalizer throwing GeneratorExit into it. A bare `except asyncio.CancelledError`
    inside gen() would never see that GeneratorExit; only the `finally` does — this
    test would fail against the pre-fix code."""
    ABORT_ERRORS.clear()
    auth_header = _auth(config)['Authorization'].encode()
    scope = {
        'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'}, 'http_version': '1.1',
        'method': 'POST', 'path': '/t/slow', 'raw_path': b'/t/slow', 'root_path': '', 'scheme': 'http',
        'query_string': b'', 'headers': [(b'authorization', auth_header), (b'content-type', b'application/json')],
        'client': ('test', 123), 'server': ('test', 80), 'state': {},
    }

    async def run():
        body_sent = False

        async def receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {'type': 'http.request', 'body': b'{}', 'more_body': False}
            await asyncio.sleep(3600)

        first_body = asyncio.Event()

        async def send(message):
            if message['type'] == 'http.response.body' and message.get('body'):
                first_body.set()
                await asyncio.sleep(3600)   # stay suspended here (inside send()), not inside gen()

        task = asyncio.ensure_future(app_client.app(scope, receive, send))
        await asyncio.wait_for(first_body.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # give the abandoned async generator's finalizer (which schedules aclose() on
        # the loop) and the controller thread's next send() a moment to run
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 3
        while not ABORT_ERRORS and loop.time() < deadline:
            await asyncio.sleep(0.02)

    asyncio.run(run())
    assert ABORT_ERRORS == ['CLIENT_ABORTED']
