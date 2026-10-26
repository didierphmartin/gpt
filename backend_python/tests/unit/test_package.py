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
    guest = {'capabilities': '{"providers":{"claude":{"enabled":true}},"sidebar":{},"mcp_servers":["a",3]}',
             'updated_at': '2026-01-01 00:00:00'}
    # 'bogus' has no packages row (None), so it resolves to the guest row; the cache is keyed by the asked role.
    db2 = FakeDb(one=[None, guest, guest])
    r2 = PackageResolver(db2)
    assert r2.loadPackage('bogus')['role'] == 'guest'
    assert r2.allowedMcpServers(None) == ['a']


def test_load_package_capabilities_array_shapes():
    # invalid JSON in the capabilities cell -> PHP is_array(null) is false -> [] (JSON [])
    r_bad = PackageResolver(FakeDb(one=[{'capabilities': '{not json', 'updated_at': None}]))
    assert r_bad.loadPackage('user')['capabilities'] == []

    # capabilities cell is a JSON array -> PHP is_array($decoded) is true -> kept as-is
    r_list = PackageResolver(FakeDb(one=[{'capabilities': '["x"]', 'updated_at': None}]))
    assert r_list.loadPackage('user')['capabilities'] == ['x']

    # mcp_servers stored as a JSON object -> PHP array_filter(...) iterates its VALUES
    r_dict_mcp = PackageResolver(FakeDb(one=[{'capabilities': '{"mcp_servers":{"a":"x","b":3,"c":"y"}}',
                                              'updated_at': None}]))
    assert r_dict_mcp.allowedMcpServers(None) == ['x', 'y']


def test_me_and_admin_gates():
    db = FakeDb(one=[{'role': 'user'}, None])
    r = PackageController(db, {}).me(ctx())
    assert r['role'] == 'user' and r['success'] is True and 'status_code' not in r
    assert PackageController(FakeDb(), {}).adminList(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert PackageController(FakeDb(one=[{'role': 'user'}]), {}).adminList(ctx()) == {
        'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert PackageController(FakeDb(one=[{'role': 'admin'}, None]), {}).adminGet(ctx(), 'nope') == {
        'success': False, 'error': 'Invalid role', 'status_code': 400}


def test_admin_update_validation():
    def c(): return PackageController(FakeDb(one=[{'role': 'admin'}]), {})
    assert c().adminUpdate(ctx({}), 'user')['error'] == 'capabilities object is required'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}}}), 'user')['error'] == 'capabilities.sidebar must be an object'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'skills': 'x'}}), 'user')['error'] == 'capabilities.skills must be null or an array'
    assert c().adminUpdate(ctx({'capabilities': {'providers': {}, 'sidebar': {}, 'quota_tokens': 1.5}}), 'user')['error'] == 'capabilities.quota_tokens must be null or an integer'


# ─── PackageControllerMeTest.php (custom roles; sqlite) ──────────────────────

import json  # noqa: E402

from tests.unit.playbook.conftest import sqlite_db  # noqa: E402


def _me_db():
    db = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, kind TEXT DEFAULT "person")',
                   'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, '
                   'capabilities TEXT, updated_at TEXT)')
    db.execute("INSERT INTO users (id, role) VALUES (7, 'user')")
    return db


def _keyed_package_db():
    db = _me_db()
    db.execute('INSERT INTO packages (role, capabilities) VALUES (?, ?)', ['user', json.dumps({
        'providers': {
            'claude': {'enabled': True, 'default_model': 'claude-sonnet-4-5', 'default_api_key': 'sk-claude-pkg'},
            'jev': {'enabled': True, 'default_model': None, 'default_api_key': 'jev-pkg-key'},
            'kimi': {'enabled': False, 'default_model': 'kimi-k2', 'default_api_key': None},
        },
        'quota_tokens': 1000,
    })])
    return db


def test_me_never_returns_a_package_default_key():
    """PackageControllerMeTest::testMeNeverReturnsAPackageDefaultKey (withoutProviderKeys)."""
    db = _keyed_package_db()
    ctl = PackageController(db, {})
    out = ctl.me({'user_id': 7})
    wire = json.dumps(out)
    assert out['success'] is True
    assert 'default_api_key' not in wire and 'jev-pkg-key' not in wire and 'sk-claude-pkg' not in wire
    providers = out['capabilities']['providers']
    assert providers['claude'] == {'enabled': True, 'default_model': 'claude-sonnet-4-5'}
    assert providers['jev'] == {'enabled': True, 'default_model': None}
    assert providers['kimi'] == {'enabled': False, 'default_model': 'kimi-k2'}
    assert out['capabilities']['quota_tokens'] == 1000
    # The resolver's cached package keeps its keys (PHP copies arrays by value).
    assert 'jev-pkg-key' in json.dumps(ctl.resolver.resolveForUser(7))


def test_admin_get_still_returns_the_keys():
    """PackageControllerMeTest::testAdminGetStillReturnsTheKeys."""
    db = _keyed_package_db()
    db.execute("INSERT INTO users (id, role) VALUES (1, 'admin')")
    out = PackageController(db, {}).adminGet({'user_id': 1, 'params': {'role': 'user'}}, 'user')
    assert 'jev-pkg-key' in json.dumps(out)


def test_a_custom_roles_user_gets_that_rows_capabilities():
    db = _me_db()
    db.execute("INSERT INTO users (id, role) VALUES (8, 'it-ops-2')")
    db.execute('INSERT INTO packages (role, name, capabilities) VALUES (?, ?, ?)',
               ['it-ops-2', 'IT Ops', json.dumps({'providers': [], 'sidebar': [], 'quota_tokens': 42})])
    out = PackageController(db, {}).me({'user_id': 8})
    assert out['role'] == 'it-ops-2'
    assert out['capabilities']['quota_tokens'] == 42


def test_a_role_without_a_row_resolves_to_guest():
    db = _me_db()
    db.execute("INSERT INTO users (id, role) VALUES (9, 'affiliate')")
    db.execute('INSERT INTO packages (role, capabilities) VALUES (?, ?)',
               ['guest', json.dumps({'providers': [], 'sidebar': [], 'quota_tokens': 7})])
    out = PackageController(db, {}).me({'user_id': 9})
    assert out['role'] == 'guest'
    assert out['capabilities']['quota_tokens'] == 7


def test_admin_list_and_get_carry_name_and_builtin():
    db = _me_db()
    db.execute("INSERT INTO users (id, role) VALUES (1, 'admin')")
    db.execute('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)', ['it-ops-2', 'IT Ops', '{}'])
    c = PackageController(db, {})
    by_role = {p['role']: p for p in c.adminList({'user_id': 1})['packages']}
    assert by_role['it-ops-2']['name'] == 'IT Ops'
    assert by_role['it-ops-2']['builtin'] is False
    assert by_role['user']['name'] == 'User'
    got = c.adminGet({'user_id': 1, 'params': {'role': 'it-ops-2'}})
    assert got['package']['name'] == 'IT Ops'
    assert c.adminGet({'user_id': 1, 'params': {'role': 'nope'}})['status_code'] == 400


def test_an_all_digit_role_key_arrives_as_int_and_still_resolves():
    # main.py casts numeric route params to int, as index.php does: the key is read back as a string.
    db = _me_db()
    db.execute("INSERT INTO users (id, role) VALUES (1, 'admin')")
    db.execute("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('2024', 'Numeric', 0, '{}')")
    assert PackageController(db, {}).adminGet({'user_id': 1, 'params': {'role': '2024'}}, 2024)['package']['name'] == 'Numeric'
