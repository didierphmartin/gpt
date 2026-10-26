import json
from starlette.requests import Request
from app.support.http import build_ctx, render


def _req(method='POST', path='/api/v1/auth', headers=None, query=b''):
    scope = {
        'type': 'http', 'method': method, 'path': path, 'query_string': query,
        'headers': [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        'client': ('127.0.0.1', 5555), 'server': ('localhost', 3002), 'scheme': 'http',
    }
    return Request(scope)


def test_build_ctx_mirrors_php_request_array():
    ctx = build_ctx(_req(headers={'Authorization': 'Bearer x'}, query=b'a=1&b=2'),
                    b'{"action":"login"}')
    assert ctx['method'] == 'POST' and ctx['uri'] == '/api/v1/auth'
    assert ctx['body'] == {'action': 'login'} and ctx['raw_body'] == '{"action":"login"}'
    assert ctx['query'] == {'a': '1', 'b': '2'}
    assert ctx['headers'].get('Authorization') == 'Bearer x'   # case-insensitive
    assert ctx['user_id'] is None and ctx['authenticated'] is False and ctx['params'] == {}


def test_invalid_json_body_becomes_empty_dict():
    assert build_ctx(_req(), b'not json')['body'] == {}
    assert build_ctx(_req(), b'')['body'] == {}
    assert build_ctx(_req(), b'[1,2]')['body'] == {}   # PHP controllers index by key; a list is treated as {}


def test_base_path_is_stripped():
    assert build_ctx(_req(path='/gpt/backend/api/v1/auth'), b'')['uri'] == '/api/v1/auth'


def test_render_json_strips_transport_keys():
    r = render({'success': True, 'x': 1, 'status_code': 201, 'content_type': 'application/json'})
    assert r.status_code == 201
    assert json.loads(r.body) == {'success': True, 'x': 1}
    assert r.headers['content-type'].startswith('application/json')


def test_render_html_plain_and_raw():
    r = render({'content_type': 'text/html; charset=utf-8', 'html': '<b>x</b>', 'status_code': 200})
    assert r.body == b'<b>x</b>' and r.headers['content-type'] == 'text/html; charset=utf-8'
    assert r.headers['cache-control'] == 'no-cache'
    r2 = render({'content_type': 'text/plain', 'error': 'boom', 'status_code': 400})
    assert r2.body == b'boom' and r2.status_code == 400
    r3 = render({'raw_body': b'PK..', 'headers': {'Content-Type': 'application/zip', 'X-A': '1'}})
    assert r3.body == b'PK..' and r3.headers['x-a'] == '1' and r3.headers['content-type'] == 'application/zip'


def test_render_streaming_handled_returns_none():
    assert render({'streaming_handled': True}) is None


def test_json_response_writes_whole_floats_like_php():
    """PHP json_encode(500.0) is 500 and (float) '0.00' is 0: no '.0' on the wire (/settings/usage
    budget_limit, month_cost_usd). Fractions, ints, bools and big floats keep their own form."""
    from app.support.http import json_response
    body = json_response(200, {'budget_limit': 500.0, 'cost': 0.0, 'rate': {'input': 0.042, 'output': 2.0},
                               'list': [1.0, 1.5, True, None, 'x'], 'big': 1e17, 'n': 3}).body
    assert body == (b'{"budget_limit":500,"cost":0,"rate":{"input":0.042,"output":2},'
                    b'"list":[1,1.5,true,null,"x"],"big":1e+17,"n":3}')
