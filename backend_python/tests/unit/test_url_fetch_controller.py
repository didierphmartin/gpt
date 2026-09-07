import httpx
import pytest
from starlette.datastructures import Headers
from app.controllers.url_fetch_controller import UrlFetchController
from app.support.http import Ctx


def ctx(body=None, remote='203.0.113.9'):
    c = Ctx(method='POST', uri='/api/v1/fetch-url', headers=Headers({}), query={}, body=body or {}, raw_body='', params={}, user_id=3, authenticated=True, remote_addr=remote)
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = {}
    return c


def _ctl(handler, monkeypatch):
    c = UrlFetchController(None, {})
    monkeypatch.setattr(c, '_makeClient', lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))
    monkeypatch.setattr(c, '_resolve', lambda host: ['93.184.216.34'])
    return c


def test_validation_paths(monkeypatch):
    c = _ctl(lambda r: httpx.Response(200), monkeypatch)
    assert c.fetch(ctx({})) == {'success': False, 'error': 'Missing required field: url', 'status_code': 400}
    assert c.fetch(ctx({'url': 'not a url'})) == {'success': False, 'error': 'Input is not a URL or recognizable domain', 'status_code': 400}
    assert c.fetch(ctx({'url': 'http://'})) == {'success': False, 'error': 'Invalid URL', 'status_code': 400}


def test_private_host_refused_unless_caller_is_loopback(monkeypatch):
    c = _ctl(lambda r: httpx.Response(200, text='<p>hi</p>', headers={'content-type': 'text/html; charset=utf-8'}), monkeypatch)
    monkeypatch.setattr(c, '_resolve', lambda host: ['10.0.0.5'])
    assert c.fetch(ctx({'url': 'https://intranet.example'})) == {'success': False, 'error': 'Refusing to fetch from a private/internal address', 'status_code': 403}
    assert c.fetch(ctx({'url': 'https://intranet.example'}, remote='127.0.0.1'))['success'] is True


def test_bare_domain_is_upgraded_and_success_shape(monkeypatch):
    seen = {}
    def handler(req):
        seen['url'] = str(req.url); seen['ua'] = req.headers['user-agent']
        return httpx.Response(200, content='<html><meta charset="iso-8859-1"><p>caf\xe9</p></html>'.encode('latin-1'), headers={'content-type': 'text/html'})
    c = _ctl(handler, monkeypatch)
    r = c.fetch(ctx({'url': 'example.com/page'}))
    assert seen['url'] == 'https://example.com/page' and seen['ua'].startswith('Mozilla/5.0')
    assert list(r) == ['success', 'data'] and list(r['data']) == ['url', 'final_url', 'status', 'content_type', 'bytes', 'html']
    assert r['data']['status'] == 200 and 'café' in r['data']['html'] and r['data']['bytes'] == len('<html><meta charset="iso-8859-1"><p>caf\xe9</p></html>'.encode('latin-1'))


def test_upstream_error_and_size_cap(monkeypatch):
    c = _ctl(lambda r: httpx.Response(404, text='nope'), monkeypatch)
    assert c.fetch(ctx({'url': 'https://example.com/x'})) == {'success': False, 'error': 'Upstream returned HTTP 404', 'data': {'upstream_status': 404, 'final_url': 'https://example.com/x'}}
    big = _ctl(lambda r: httpx.Response(200, content=b'x' * (5 * 1024 * 1024 + 1), headers={'content-type': 'text/plain'}), monkeypatch)
    assert big.fetch(ctx({'url': 'https://example.com/big'})) == {'success': False, 'error': 'Response exceeded 5242880 bytes', 'status_code': 502}


def test_network_failure_is_502(monkeypatch):
    def boom(req): raise httpx.ConnectError('Connection refused', request=req)
    r = _ctl(boom, monkeypatch).fetch(ctx({'url': 'https://example.com/'}))
    assert r['success'] is False and r['status_code'] == 502 and r['error'].startswith('Fetch failed (httpx ConnectError): ')
