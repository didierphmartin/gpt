"""PHP-vs-Python differential fixtures. PHP is hit over HTTP (Apache), Python in-process."""
import os
import time

import httpx
import jwt
import pytest

PHP_BASE = os.environ.get('DIFF_PHP_BASE', 'http://localhost/gpt/backend')
DIFF_USER_ID = int(os.environ.get('DIFF_USER_ID', '3'))


def _php_up() -> bool:
    try:
        return httpx.get(PHP_BASE + '/', timeout=3).status_code == 200
    except Exception:  # noqa: BLE001
        return False


@pytest.fixture(scope='session', autouse=True)
def _require_php():
    if not _php_up():
        pytest.skip(f'PHP backend not reachable at {PHP_BASE}', allow_module_level=True)


@pytest.fixture(scope='session')
def php():
    return httpx.Client(base_url=PHP_BASE, timeout=60)


@pytest.fixture(scope='session')
def py(client):
    return client


@pytest.fixture(scope='session')
def token(config):
    now = int(time.time())
    return jwt.encode({'iss': 'gpt-chat', 'iat': now, 'exp': now + 3600, 'sub': DIFF_USER_ID, 'type': 'access'},
                      config['auth']['jwt_secret'], algorithm='HS256')


@pytest.fixture(scope='session')
def both(php, py, token):
    def _both(method: str, path: str, json=None, headers=None, auth=True):
        h = dict(headers or {})
        if auth and 'Authorization' not in h:
            h['Authorization'] = f'Bearer {token}'
        a = php.request(method, path, json=json, headers=h)
        b = py.request(method, path, json=json, headers=h)
        return a, b
    return _both


def same(a, b, ignore=()):
    """Assert status + JSON equality, ignoring listed top-level keys (e.g. wall-clock fields)."""
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = a.json(), b.json()
    for k in ignore:
        ja.pop(k, None); jb.pop(k, None)
    assert ja == jb, (ja, jb)
