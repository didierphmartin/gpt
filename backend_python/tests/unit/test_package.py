from starlette.datastructures import Headers
from app.services.package_resolver import PackageResolver
from app.controllers.package_controller import PackageController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None): self.one = list(one or []); self.calls = []
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one.pop(0) if self.one else None
    def execute(self, s, p=None): self.calls.append((s, p)); return 1


def ctx(body=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='', params={},
               user_id=user_id, authenticated=user_id is not None, remote_addr='')


def test_resolver_guest_when_anonymous_unknown_or_bad_role():
    assert PackageResolver(FakeDb()).resolveRole(None) == 'guest'
    assert PackageResolver(FakeDb(one=[None])).resolveRole(5) == 'guest'
    assert PackageResolver(FakeDb(one=[{'role': 'affiliate'}])).resolveRole(5) == 'guest'
    assert PackageResolver(FakeDb(one=[{'role': 'admin'}])).resolveRole(5) == 'admin'


def test_load_package_defaults_and_cache():
    db = FakeDb(one=[None])
    r = PackageResolver(db)
    p = r.loadPackage('user')
    assert p == {'role': 'user', 'capabilities': {'providers': [], 'mcp_servers': None, 'skills': None,
                                                  'sidebar': [], 'quota_tokens': None, 'voice': False, 'avatar': False},
                 'updated_at': None}
    assert r.loadPackage('user') is p and len(db.calls) == 1
    db2 = FakeDb(one=[{'capabilities': '{"providers":{"claude":{"enabled":true}},"sidebar":{},"mcp_servers":["a",3]}',
                       'updated_at': '2026-01-01 00:00:00'}])
    r2 = PackageResolver(db2)
    assert r2.loadPackage('bogus')['role'] == 'guest'
    assert r2.allowedMcpServers(None) == ['a']


def test_me_and_admin_gates():
    db = FakeDb(one=[{'role': 'user'}, None])
    r = PackageController(db, {}).me(ctx())
    assert r['role'] == 'user' and r['success'] is True and 'status_code' not in r
    assert PackageController(FakeDb(), {}).adminList(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert PackageController(FakeDb(one=[{'role': 'user'}]), {}).adminList(ctx()) == {
        'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert PackageController(FakeDb(one=[{'role': 'admin'}]), {}).adminGet(ctx(), 'nope') == {
        'success': False, 'error': 'Invalid role', 'status_code': 400}


def test_admin_update_validation():
    def c(): return PackageController(FakeDb(one=[{'role': 'admin'}]), {})
    assert c().adminUpdate(ctx({}), 'user')['error'] == 'capabilities object is required'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}}}), 'user')['error'] == 'capabilities.sidebar must be an object'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'skills': 'x'}}), 'user')['error'] == 'capabilities.skills must be null or an array'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'quota_tokens': 1.5}}), 'user')['error'] == 'capabilities.quota_tokens must be null or an integer'
