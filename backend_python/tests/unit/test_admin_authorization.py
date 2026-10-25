"""Every /api/v1/admin/* endpoint must refuse a caller who is not an admin.

Port of backend/tests/Unit/AdminAuthorizationTest.php. The JWT carries only `sub`, so the auth
middleware establishes WHO the caller is and nothing more; the role check is the controller's job,
and AdminController used not to do it (any signed-in user could POST /admin/users with
{"role": "admin"}).

An in-memory SQLite database holds just the `users` columns the guard reads (as the PHP test does).
The tests assert the REFUSAL, which returns before any MySQL-specific query runs.
"""
import pytest

from app.controllers.admin_controller import AdminController
from app.controllers.video_editor_controller import VideoEditorController
from tests.unit.playbook.conftest import sqlite_db

USERS_DDL = (
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, password TEXT, first_name TEXT,'
    ' last_name TEXT, role TEXT, plan TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT "person",'
    ' app_key_prefix TEXT, app_key_created_at TEXT, created_at TEXT, updated_at TEXT)'
)


@pytest.fixture
def db():
    d = sqlite_db(USERS_DDL)
    d.execute("INSERT INTO users (id, email, role) VALUES (1, 'admin@test', 'admin')")
    d.execute("INSERT INTO users (id, email, role) VALUES (2, 'plain@test', 'user')")
    d.execute("INSERT INTO users (id, email, role) VALUES (3, 'guest@test', 'guest')")
    return d


def request(user_id, body=None):
    return {'user_id': user_id, 'body': body or {}, 'query': {}}


# Every AdminController endpoint (the 34 PHP guards): method -> (body, extra positional args).
ADMIN_ENDPOINTS = {
    'listUsers': ({}, ()),
    'getUser': ({}, (1,)),
    'getUserAccount': ({}, (1,)),
    'createUser': ({'email': 'x@y.z', 'password': 'pw', 'role': 'admin'}, ()),
    'updateUser': ({'user_id': 1, 'role': 'admin'}, ()),
    'deleteUser': ({}, (1,)),
    'getProviderSettings': ({}, (1,)),
    'saveProvider': ({'provider_key': 'claude'}, ()),
    'toggleCategoryEnabled': ({}, ()),
    'toggleProviderEnabled': ({}, ()),
    'deleteProvider': ({}, ()),
    'getApiKeys': ({}, (1,)),
    'saveApiKeys': ({'user_id': 1, 'keys': []}, ()),
    'deleteApiKey': ({}, ()),
    'getUsageStats': ({}, ()),
    'getUsageByUser': ({}, ()),
    'getUserUsageDetail': ({}, (1,)),
    'getUsageTransactions': ({}, ()),
    'getToolStats': ({}, ()),
    'listMCPServers': ({}, ()),
    'createMCPServer': ({'name': 'x', 'url': 'http://x'}, ()),
    'updateMCPServer': ({}, ()),
    'toggleMCPServer': ({}, ()),
    'deleteMCPServer': ({}, (1,)),
    'refreshMCPServerTools': ({}, ()),
    'getUserMCPServers': ({}, (1,)),
    'setUserMCPOverride': ({}, (1, 1)),
    'clearUserMCPOverride': ({}, (1, 1)),
    'getCosts': ({}, ()),
    'refreshAllCosts': ({}, ()),
    'refreshProviderCosts': ({}, ()),
    'getUserCosts': ({}, (1,)),
    'getExchangeRates': ({}, ()),
    'refreshExchangeRates': ({}, ()),
}


def test_every_admin_endpoint_is_listed():
    assert len(ADMIN_ENDPOINTS) == 34
    for name in ADMIN_ENDPOINTS:
        assert callable(getattr(AdminController, name, None)), name


@pytest.mark.parametrize('method', sorted(ADMIN_ENDPOINTS))
def test_plain_user_is_refused(db, method):
    body, args = ADMIN_ENDPOINTS[method]
    result = getattr(AdminController(db, {}), method)(request(2, body), *args)
    assert result == {'success': False, 'error': 'Admin access required', 'status_code': 403}, \
        f"AdminController.{method}() let a role='user' caller through"


@pytest.mark.parametrize('method', sorted(ADMIN_ENDPOINTS))
def test_unauthenticated_caller_is_refused(db, method):
    body, args = ADMIN_ENDPOINTS[method]
    result = getattr(AdminController(db, {}), method)(request(None, body), *args)
    assert result == {'success': False, 'error': 'Authentication required', 'status_code': 401}, \
        f'AdminController.{method}() accepted a request with no user_id'


def test_plain_user_cannot_create_an_admin_account(db):
    before = db.fetch_column('SELECT COUNT(*) FROM users')
    AdminController(db, {}).createUser(request(2, {'email': 'escalated@test', 'password': 'pw', 'role': 'admin'}))
    assert db.fetch_column('SELECT COUNT(*) FROM users') == before, 'a non-admin created a user row'
    assert db.fetch_column("SELECT COUNT(*) FROM users WHERE email = 'escalated@test'") == [0], \
        'a non-admin granted themselves the admin role'


def test_guest_is_refused(db):
    assert AdminController(db, {}).listUsers(request(3))['status_code'] == 403


def test_deleted_user_is_refused(db):
    assert AdminController(db, {}).listUsers(request(999))['status_code'] == 403, \
        'a JWT for a deleted user was accepted'


def test_failed_role_lookup_refuses():
    class Down:
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db down')
    assert AdminController(Down(), {}).listUsers(request(1)) == {
        'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_admin_is_not_refused(db):
    result = AdminController(db, {}).listUsers(request(1))
    assert result.get('status_code') not in (401, 403), 'the guard locked out a real admin'
    assert result['success'] is True
    assert [u['email'] for u in result['users']] == ['admin@test', 'plain@test', 'guest@test']


@pytest.mark.parametrize('method', ['getUsageStats', 'getUsageSummary', 'getUsageByUser', 'getPrices', 'savePrice'])
def test_video_editor_admin_routes_refuse_plain_user(db, method):
    """The same gap existed on five video-editor admin routes (usage figures and pricing)."""
    result = getattr(VideoEditorController(db, {}), method)(request(2))
    assert result == {'success': False, 'error': 'Admin access required', 'status_code': 403}, \
        f"VideoEditorController.{method}() let a role='user' caller through"
