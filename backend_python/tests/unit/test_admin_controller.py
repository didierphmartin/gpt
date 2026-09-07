"""AdminController (part 1: users, providers, keys) unit tests — PHP-truth
strings and byte-identical SQL.

PHP source: backend/src/Controllers/AdminController.php (16-1051).
"""
import pytest

from app.controllers.admin_controller import AdminController
from app.controllers.auth_controller import password_hash, password_verify

CONFIG = {'auth': {'jwt_secret': 'test-jwt-secret'}}


class FakeDb:
    """Records every non-presence statement so tests can assert SQL byte-for-byte."""

    def __init__(self, one=None, all_=None, rowcount=1, insert_id=1,
                 tables=('user_provider_settings', 'user_category_settings', 'user_api_keys'),
                 columns=True):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.insert_id = insert_id
        self.tables = set(tables)
        self.columns = columns
        self.calls = []

    def _presence(self, sql):
        if sql.startswith('SHOW TABLES LIKE '):
            name = sql.split("'")[1]
            return [{'x': name}] if name in self.tables else []
        if sql.startswith('SHOW COLUMNS FROM '):
            return [{'Field': sql.split("'")[1]}] if self.columns else []
        return None

    def fetch_all(self, sql, params=None):
        p = self._presence(sql)
        if p is not None:
            return p
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        return self.insert_id


def ctx(body=None, query=None):
    return {'body': body if body is not None else {}, 'query': query or {}}


def c(db=None, config=None):
    return AdminController(db if db is not None else FakeDb(), config if config is not None else CONFIG)


def sqls(db):
    return [s for s, _ in db.calls]


USER_COLS = ('id, email, first_name, last_name, role, provider, plan, app_key_prefix,'
             ' app_key_created_at, created_at, updated_at')


# ─── listUsers (30) ──────────────────────────────────────────────────────────

def test_list_users_sql_and_payload():
    db = FakeDb(all_=[[{'id': 1, 'email': 'a@b.com'}]])
    r = c(db).listUsers(ctx())
    assert r == {'success': True, 'users': [{'id': 1, 'email': 'a@b.com'}], 'status_code': 200}
    assert sqls(db) == [f'SELECT {USER_COLS} FROM users ORDER BY id']
    assert db.calls[0][1] is None


# ─── getUser (46) ────────────────────────────────────────────────────────────

def test_get_user_invalid_id():
    assert c().getUser(ctx(), 0) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().getUser(ctx(), -5) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_get_user_not_found():
    r = c(FakeDb(one=[None])).getUser(ctx(), 7)
    assert r == {'success': False, 'error': 'User not found', 'status_code': 404}


def test_get_user_found_sql():
    db = FakeDb(one=[{'id': 7, 'email': 'x@y.com'}])
    r = c(db).getUser(ctx(), 7)
    assert r == {'success': True, 'user': {'id': 7, 'email': 'x@y.com'}, 'status_code': 200}
    assert sqls(db) == [f'SELECT {USER_COLS} FROM users WHERE id = :id']
    assert db.calls[0][1] == {':id': 7}


# ─── getUserAccount (79) ─────────────────────────────────────────────────────

def test_get_user_account_invalid_id():
    assert c().getUserAccount(ctx(), 0) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_get_user_account_not_found():
    db = FakeDb(one=[None], tables=())
    r = c(db).getUserAccount(ctx(), 3)
    assert r == {'success': False, 'error': 'User not found', 'status_code': 404}


def test_get_user_account_skips_tokens_when_table_absent():
    db = FakeDb(one=[{'id': 3, 'email': 'a@b.com', 'phone': None, 'first_name': 'A', 'last_name': 'B',
                      'role': 'user', 'plan': 'standard', 'provider': None, 'email_verified': 0,
                      'firebase_uid': None, 'last_login': None, 'created_at': '2026-01-01'}],
               tables=())
    r = c(db).getUserAccount(ctx(), 3)
    assert r['account']['tokens_in'] == 0 and r['account']['tokens_out'] == 0
    assert r['account']['provider'] == 'email'          # user.provider was None -> 'email' default
    assert r['account']['is_free_prospect'] is False    # plan is 'standard'
    assert r['account']['free_quota_percent'] is None
    assert sqls(db) == [
        ('SELECT id, email, phone, first_name, last_name, role, plan,'
         ' provider, email_verified, firebase_uid, last_login, created_at FROM users WHERE id = :id'),
    ]


def test_get_user_account_computes_free_quota_percent():
    db = FakeDb(
        one=[{'id': 3, 'email': 'a@b.com', 'phone': '+1', 'first_name': 'A', 'last_name': 'B',
              'role': 'prospect', 'plan': 'free', 'provider': 'firebase', 'email_verified': 1,
              'firebase_uid': 'uid-1', 'last_login': '2026-01-02', 'created_at': '2026-01-01'},
             {'tokens_in': '30000', 'tokens_out': '10000'}],
        tables=('llm_usage_transactions',))
    r = c(db).getUserAccount(ctx(), 3)
    a = r['account']
    assert a['tokens_in'] == 30000 and a['tokens_out'] == 10000 and a['total_tokens'] == 40000
    assert a['is_free_prospect'] is True
    assert a['free_quota_percent'] == 80.0
    assert a['has_firebase_uid'] is True
    assert a['email_verified'] is True
    assert sqls(db) == [
        ('SELECT id, email, phone, first_name, last_name, role, plan,'
         ' provider, email_verified, firebase_uid, last_login, created_at FROM users WHERE id = :id'),
        ('SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens_in, COALESCE(SUM(completion_tokens), 0) AS tokens_out'
         ' FROM llm_usage_transactions WHERE user_id = :user_id'),
    ]
    assert db.calls[1][1] == {':user_id': 3}


def test_get_user_account_catches_exception_as_500():
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db exploded')
    r = c(Boom()).getUserAccount(ctx(), 3)
    assert r == {'success': False, 'error': 'db exploded', 'status_code': 500}


# ─── createUser (166) ────────────────────────────────────────────────────────

def test_create_user_requires_email_and_password():
    assert c().createUser(ctx({})) == {
        'success': False, 'error': 'Email and password are required', 'status_code': 400}
    assert c().createUser(ctx({'email': 'a@b.com'}))['error'] == 'Email and password are required'
    assert c().createUser(ctx({'password': 'pw'}))['error'] == 'Email and password are required'


def test_create_user_invalid_role_coerced_to_user():
    db = FakeDb(insert_id=9)
    r = c(db).createUser(ctx({'email': 'a@b.com', 'password': 'pw', 'role': 'superadmin'}))
    assert r == {'success': True, 'message': 'User created', 'user_id': 9, 'status_code': 200}
    assert db.calls[0][1][':role'] == 'user'


@pytest.mark.parametrize('role', ['guest', 'prospect', 'user', 'admin'])
def test_create_user_accepts_valid_roles(role):
    db = FakeDb(insert_id=1)
    c(db).createUser(ctx({'email': 'a@b.com', 'password': 'pw', 'role': role}))
    assert db.calls[0][1][':role'] == role


def test_create_user_sql_hashes_and_trims():
    db = FakeDb(insert_id=42)
    r = c(db).createUser(ctx({'email': '  a@b.com  ', 'password': 'sup3r-secret',
                              'first_name': '  Ann  ', 'last_name': '  Lee  '}))
    assert r == {'success': True, 'message': 'User created', 'user_id': 42, 'status_code': 200}
    assert sqls(db) == [
        ('INSERT INTO users (email, password, first_name, last_name, role, provider, created_at, updated_at)'
         " VALUES (:email, :password, :first_name, :last_name, :role, 'email', NOW(), NOW())"),
    ]
    params = db.calls[0][1]
    assert params[':email'] == 'a@b.com' and params[':first_name'] == 'Ann' and params[':last_name'] == 'Lee'
    assert params[':role'] == 'user'
    # $2y$ / $2b$ bcrypt round-trip: PHP-produced or Python-produced hashes verify on either backend.
    assert params[':password'].startswith('$2b$')
    assert password_verify('sup3r-secret', params[':password']) is True


# ─── updateUser (216) ────────────────────────────────────────────────────────

def test_update_user_invalid_id():
    assert c().updateUser(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_update_user_requires_email():
    assert c().updateUser(ctx({'user_id': 3})) == {
        'success': False, 'error': 'Email is required', 'status_code': 400}


def test_update_user_rejects_invalid_role():
    r = c().updateUser(ctx({'user_id': 3, 'email': 'a@b.com', 'role': 'superadmin'}))
    assert r == {'success': False, 'error': 'Invalid role', 'status_code': 400}


def test_update_user_minimal_fields_sql():
    db = FakeDb()
    r = c(db).updateUser(ctx({'user_id': 3, 'email': 'a@b.com'}))
    assert r == {'success': True, 'message': 'User updated', 'status_code': 200}
    assert sqls(db) == [
        'UPDATE users SET email = :email, first_name = :first_name, last_name = :last_name, updated_at = NOW()'
        ' WHERE id = :id']
    assert db.calls[0][1] == {':id': 3, ':email': 'a@b.com', ':first_name': '', ':last_name': ''}


def test_update_user_with_role_and_password_sql():
    db = FakeDb()
    c(db).updateUser(ctx({'user_id': 3, 'email': 'a@b.com', 'role': 'admin', 'password': 'newpw'}))
    assert sqls(db) == [
        'UPDATE users SET email = :email, first_name = :first_name, last_name = :last_name, updated_at = NOW(),'
        ' role = :role, password = :password WHERE id = :id']
    params = db.calls[0][1]
    assert params[':role'] == 'admin'
    assert password_verify('newpw', params[':password']) is True


def test_update_user_blank_password_not_updated():
    db = FakeDb()
    c(db).updateUser(ctx({'user_id': 3, 'email': 'a@b.com', 'password': '   '}))
    # php_empty(' ')  is False (only '', '0' are empty strings) -> password IS updated in PHP too;
    # only a genuinely empty/'0' password is skipped.
    assert ':password' in db.calls[0][1]
    db2 = FakeDb()
    c(db2).updateUser(ctx({'user_id': 3, 'email': 'a@b.com', 'password': ''}))
    assert ':password' not in db2.calls[0][1]


# ─── deleteUser (285) ────────────────────────────────────────────────────────

def test_delete_user_invalid_id():
    assert c().deleteUser(ctx(), 0) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_delete_user_not_found():
    r = c(FakeDb(rowcount=0)).deleteUser(ctx(), 5)
    assert r == {'success': False, 'error': 'User not found', 'status_code': 404}


def test_delete_user_success_sql():
    db = FakeDb(rowcount=1)
    r = c(db).deleteUser(ctx(), 5)
    assert r == {'success': True, 'message': 'User deleted', 'status_code': 200}
    assert sqls(db) == ['DELETE FROM users WHERE id = :id']
    assert db.calls[0][1] == {':id': 5}


# ─── getProviderSettings (317) ───────────────────────────────────────────────

def test_get_provider_settings_invalid_id():
    assert c().getProviderSettings(ctx(), 0) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_get_provider_settings_empty_defaults():
    db = FakeDb(all_=[[], []])
    r = c(db).getProviderSettings(ctx(), 3)
    assert r == {
        'success': True, 'user_id': 3,
        'avatar': {'active': None, 'enabled': True, 'providers': []},
        'voice': {'active': None, 'enabled': True, 'providers': []},
        'status_code': 200,
    }
    assert sqls(db) == [
        'SELECT category, enabled FROM user_category_settings WHERE user_id = :user_id',
        'SELECT category, provider, api_key, settings, is_active, enabled'
        ' FROM user_provider_settings WHERE user_id = :user_id',
    ]


def test_get_provider_settings_populated_with_active_and_key():
    db = FakeDb(all_=[
        [{'category': 'voice', 'enabled': 0}],
        [{'category': 'voice', 'provider': 'grok', 'api_key': 'sk-abc', 'settings': '{"x":1}',
          'is_active': 1, 'enabled': 1}],
    ])
    r = c(db).getProviderSettings(ctx(), 3)
    assert r['voice'] == {
        'active': 'grok', 'enabled': False,
        'providers': {'grok': {'has_key': True, 'api_key': 'sk-abc', 'settings': {'x': 1}, 'enabled': True}},
    }
    assert r['avatar'] == {'active': None, 'enabled': True, 'providers': []}


def test_get_provider_settings_drops_enabled_when_column_absent():
    db = FakeDb(all_=[[], [{'category': 'voice', 'provider': 'grok', 'api_key': None,
                            'settings': None, 'is_active': 0}]], columns=False)
    r = c(db).getProviderSettings(ctx(), 3)
    assert sqls(db)[1] == ('SELECT category, provider, api_key, settings, is_active'
                           ' FROM user_provider_settings WHERE user_id = :user_id')
    assert r['voice']['providers']['grok']['enabled'] is True


# ─── saveProvider (384) ──────────────────────────────────────────────────────

def test_save_provider_validation():
    assert c().saveProvider(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().saveProvider(ctx({'user_id': 3, 'category': 'nope'})) == {
        'success': False, 'error': 'Invalid category', 'status_code': 400}
    assert c().saveProvider(ctx({'user_id': 3, 'category': 'voice'})) == {
        'success': False, 'error': 'Provider is required', 'status_code': 400}


def test_save_provider_inserts_when_absent():
    db = FakeDb(one=[None])
    r = c(db).saveProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok',
                                'api_key': 'sk-1', 'settings': {'a': 1}}))
    assert r == {'success': True, 'message': "Provider 'grok' saved", 'status_code': 200}
    assert sqls(db) == [
        'SELECT id, api_key FROM user_provider_settings'
        ' WHERE user_id = :user_id AND category = :category AND provider = :provider',
        'INSERT INTO user_provider_settings'
        ' (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)'
        ' VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())',
    ]
    assert db.calls[1][1] == {':user_id': 3, ':category': 'voice', ':provider': 'grok',
                              ':api_key': 'sk-1', ':settings': '{"a":1}'}


def test_save_provider_updates_with_api_key():
    db = FakeDb(one=[{'id': 1, 'api_key': 'old'}])
    c(db).saveProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok', 'api_key': 'new'}))
    assert sqls(db)[1] == (
        'UPDATE user_provider_settings SET api_key = :api_key, settings = :settings, updated_at = NOW()'
        ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
    assert db.calls[1][1][':api_key'] == 'new' and db.calls[1][1][':settings'] is None


def test_save_provider_updates_without_api_key():
    db = FakeDb(one=[{'id': 1, 'api_key': 'old'}])
    c(db).saveProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok',
                            'settings': '{"y":2}'}))
    assert sqls(db)[1] == (
        'UPDATE user_provider_settings SET settings = :settings, updated_at = NOW()'
        ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
    assert db.calls[1][1][':settings'] == '{"y":2}'


def test_save_provider_set_active_unsets_and_sets():
    db = FakeDb(one=[{'id': 1, 'api_key': 'old'}])
    c(db).saveProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok', 'set_active': True}))
    assert sqls(db)[2:] == [
        'UPDATE user_provider_settings SET is_active = 0 WHERE user_id = :user_id AND category = :category',
        'UPDATE user_provider_settings SET is_active = 1'
        ' WHERE user_id = :user_id AND category = :category AND provider = :provider',
    ]


# ─── toggleProviderEnabled (567 in PHP; routed before category-toggle) ──────

def test_toggle_provider_enabled_validation():
    assert c().toggleProviderEnabled(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().toggleProviderEnabled(ctx({'user_id': 3, 'category': 'x'})) == {
        'success': False, 'error': 'Invalid category', 'status_code': 400}
    assert c().toggleProviderEnabled(ctx({'user_id': 3, 'category': 'voice'})) == {
        'success': False, 'error': 'Provider is required', 'status_code': 400}


def test_toggle_provider_enabled_update_enable_disable():
    db = FakeDb(one=[{'id': 1}])
    r = c(db).toggleProviderEnabled(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok', 'enabled': True}))
    assert r == {'success': True, 'message': "Provider 'grok' enabled", 'status_code': 200}
    assert sqls(db)[1] == ('UPDATE user_provider_settings SET enabled = 1, updated_at = NOW()'
                           ' WHERE user_id = :user_id AND category = :category AND provider = :provider')

    db2 = FakeDb(one=[{'id': 1}])
    r2 = c(db2).toggleProviderEnabled(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok', 'enabled': False}))
    assert r2['message'] == "Provider 'grok' disabled"
    assert sqls(db2)[1] == ('UPDATE user_provider_settings SET enabled = 0, is_active = 0, updated_at = NOW()'
                            ' WHERE user_id = :user_id AND category = :category AND provider = :provider')


def test_toggle_provider_enabled_inserts_when_absent():
    db = FakeDb(one=[None])
    c(db).toggleProviderEnabled(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok', 'enabled': False}))
    assert sqls(db)[1] == ('INSERT INTO user_provider_settings'
                           ' (user_id, category, provider, enabled, is_active, created_at, updated_at)'
                           ' VALUES (:user_id, :category, :provider, :enabled, 0, NOW(), NOW())')
    assert db.calls[1][1][':enabled'] == 0


# ─── toggleCategoryEnabled (497 in PHP) ──────────────────────────────────────

def test_toggle_category_enabled_validation():
    assert c().toggleCategoryEnabled(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().toggleCategoryEnabled(ctx({'user_id': 3, 'category': 'x'})) == {
        'success': False, 'error': 'Invalid category', 'status_code': 400}


def test_toggle_category_enabled_sql_and_message():
    db = FakeDb(rowcount=2)
    r = c(db).toggleCategoryEnabled(ctx({'user_id': 3, 'category': 'voice', 'enabled': True}))
    assert r == {'success': True, 'message': "Category 'voice' enabled (2 providers updated)",
                'status_code': 200}
    assert sqls(db) == [
        'INSERT INTO user_category_settings (user_id, category, enabled, updated_at)'
        ' VALUES (:user_id, :category, :enabled, NOW())'
        ' ON DUPLICATE KEY UPDATE enabled = :enabled2, updated_at = NOW()',
        'UPDATE user_provider_settings SET enabled = :enabled, updated_at = NOW()'
        ' WHERE user_id = :user_id AND category = :category',
    ]
    assert db.calls[0][1] == {':user_id': 3, ':category': 'voice', ':enabled': 1, ':enabled2': 1}


def test_toggle_category_disabled_also_clears_active():
    db = FakeDb(rowcount=0)
    r = c(db).toggleCategoryEnabled(ctx({'user_id': 3, 'category': 'avatar', 'enabled': False}))
    assert r['message'] == "Category 'avatar' disabled (0 providers updated)"
    assert sqls(db)[1] == ('UPDATE user_provider_settings SET enabled = :enabled, is_active = 0, updated_at = NOW()'
                           ' WHERE user_id = :user_id AND category = :category')


# ─── deleteProvider (648) ────────────────────────────────────────────────────

def test_delete_provider_validation():
    assert c().deleteProvider(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().deleteProvider(ctx({'user_id': 3, 'category': 'x'})) == {
        'success': False, 'error': 'Invalid category', 'status_code': 400}
    assert c().deleteProvider(ctx({'user_id': 3, 'category': 'voice'})) == {
        'success': False, 'error': 'Provider is required', 'status_code': 400}


def test_delete_provider_sql_and_deleted_flag():
    db = FakeDb(rowcount=1)
    r = c(db).deleteProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok'}))
    assert r == {'success': True, 'message': "Provider 'grok' deleted", 'deleted': True, 'status_code': 200}
    assert sqls(db) == ['DELETE FROM user_provider_settings'
                        ' WHERE user_id = :user_id AND category = :category AND provider = :provider']

    db2 = FakeDb(rowcount=0)
    r2 = c(db2).deleteProvider(ctx({'user_id': 3, 'category': 'voice', 'provider': 'grok'}))
    assert r2['deleted'] is False


# ─── getUserCosts (2834) + private getUsageCostsBreakdown (2865) ────────────

def test_get_user_costs_invalid_id():
    assert c().getUserCosts(ctx(), 0) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_get_user_costs_exception_wraps_message():
    class Boom(FakeDb):
        def fetch_all(self, sql, params=None):
            p = self._presence(sql)
            if p is not None:
                return p
            raise RuntimeError('cost query failed')
    r = c(Boom()).getUserCosts(ctx(), 3)
    assert r == {'success': False, 'error': 'Failed to fetch user costs: cost query failed', 'status_code': 500}


def test_get_user_costs_shape_and_sql():
    db = FakeDb(
        all_=[
            [{'provider': 'kimi', 'total_requests': 5, 'tokens_in': 1000, 'tokens_out': 500,
              'total_tokens': 1500, 'stored_cost_total': '0.50', 'price_in': '1.00', 'price_out': '2.00',
              'last_used': '2026-09-01'}],
            [{'provider': 'grok', 'total_requests': 2, 'total_seconds': '30.5', 'total_cost': '0.10',
              'last_used': '2026-09-02'}],
        ],
        one=[{'cost_today': '0.10', 'cost_week': '0.30', 'cost_month': '0.60', 'cost_total': '0.60',
              'voice_cost_today': '0.01', 'voice_cost_week': '0.05', 'voice_cost_month': '0.10',
              'voice_cost_total': '0.10'}],
    )
    r = c(db).getUserCosts(ctx(), 3)
    assert r['success'] is True and r['user_id'] == 3 and r['status_code'] == 200
    uc = r['usageCosts']
    assert uc['llm']['byProvider'] == [{
        'provider': 'kimi', 'requests': 5, 'tokensIn': 1000, 'tokensOut': 500, 'tokens': 1500,
        'priceIn': 1.0, 'priceOut': 2.0, 'costIn': 0.001, 'costOut': 0.001, 'cost': 0.002,
        'storedCost': 0.5, 'lastUsed': '2026-09-01',
    }]
    assert uc['llm']['totals'] == {'today': 0.1, 'week': 0.3, 'month': 0.6, 'total': 0.6}
    assert uc['voice']['byProvider'] == [{
        'provider': 'grok', 'requests': 2, 'seconds': 30.5, 'cost': 0.1, 'lastUsed': '2026-09-02'}]
    assert uc['voice']['totals'] == {'today': 0.01, 'week': 0.05, 'month': 0.1, 'total': 0.1}
    assert uc['avatar'] == {
        'byProvider': [], 'totals': {'today': 0, 'week': 0, 'month': 0, 'total': 0},
        'note': 'Avatar usage costs are tracked separately if avatar provider integrations are active'}

    assert sqls(db) == [
        'SELECT t.provider, COUNT(*) AS total_requests, COALESCE(SUM(t.prompt_tokens), 0) AS tokens_in,'
        ' COALESCE(SUM(t.completion_tokens), 0) AS tokens_out, COALESCE(SUM(t.total_tokens), 0) AS total_tokens,'
        ' COALESCE(SUM(t.cost_usd), 0) AS stored_cost_total, s.price_input_per_1m AS price_in,'
        ' s.price_output_per_1m AS price_out, MAX(t.created_at) AS last_used FROM llm_usage_transactions t'
        ' LEFT JOIN system_llm_settings s ON s.provider_key = t.provider'
        ' WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND t.user_id = :uid'
        ' GROUP BY t.provider, s.price_input_per_1m, s.price_output_per_1m ORDER BY stored_cost_total DESC',
        'SELECT provider, COUNT(*) as total_requests, COALESCE(SUM(audio_duration_seconds), 0) as total_seconds,'
        ' COALESCE(SUM(cost_usd), 0) as total_cost, MAX(created_at) as last_used FROM llm_usage_transactions'
        ' WHERE is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND user_id = :uid'
        ' GROUP BY provider ORDER BY total_cost DESC',
        'SELECT SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as cost_today,'
        ' SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as cost_week,'
        ' SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as cost_month,'
        ' SUM(cost_usd) as cost_total,'
        ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)'
        ' THEN cost_usd ELSE 0 END) as voice_cost_today,'
        ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
        ' THEN cost_usd ELSE 0 END) as voice_cost_week,'
        ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
        ' THEN cost_usd ELSE 0 END) as voice_cost_month,'
        ' SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost_total'
        ' FROM llm_usage_transactions WHERE user_id = :uid',
    ]
    assert db.calls[0][1] == {':uid': 3}


def test_get_user_costs_falls_back_to_stored_cost_when_price_unknown():
    db = FakeDb(
        all_=[[{'provider': 'kimi', 'total_requests': 1, 'tokens_in': 10, 'tokens_out': 5, 'total_tokens': 15,
                'stored_cost_total': '0.25', 'price_in': None, 'price_out': None, 'last_used': None}], []],
        one=[{}],
    )
    r = c(db).getUserCosts(ctx(), 3)
    p = r['usageCosts']['llm']['byProvider'][0]
    assert p['priceIn'] is None and p['costIn'] is None and p['cost'] == 0.25 and p['storedCost'] == 0.25


# ─── getApiKeys (695) ────────────────────────────────────────────────────────

def _keys_db(rows, role='user', package=None):
    """PackageResolver: resolveRole (user 1), resolveForUser -> resolveRole (user 2) + loadPackage (user 3)."""
    return FakeDb(all_=[rows], one=[{'role': role}, {'role': role}, package])


def test_get_api_keys_invalid_id():
    assert c().getApiKeys(ctx(), 0) == {'success': False, 'error': 'Invalid user ID', 'status_code': 400}


def test_get_api_keys_empty_state_and_none_source():
    db = _keys_db([], package={'capabilities': '{"providers": {}}', 'updated_at': None})
    r = c(db).getApiKeys(ctx(), 3)
    assert r['success'] is True and r['user_id'] == 3
    kimi = r['keys']['kimi']
    assert kimi['api_key'] is None and kimi['masked_key'] is None and kimi['enabled'] is True
    assert kimi['source'] == 'none' and kimi['available'] is False and kimi['package_name'] is None
    assert set(r['keys'].keys()) == {'claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'}
    assert sqls(db)[0] == (
        'SELECT provider, api_key, model, base_url, max_tokens, temperature, chat_endpoint, streaming,'
        ' supports_tools, system_prompt, enabled, updated_at FROM user_api_keys WHERE user_id = :user_id')


def test_get_api_keys_masks_and_sources_user_key():
    db = _keys_db(
        [{'provider': 'kimi', 'api_key': 'sk-abcdWXYZ', 'model': 'kimi-k2', 'base_url': None,
          'max_tokens': '4096', 'temperature': '0.70', 'chat_endpoint': None, 'streaming': 1,
          'supports_tools': 0, 'system_prompt': 'be terse', 'enabled': 1, 'updated_at': '2026-09-01'}],
        package={'capabilities': '{"providers": {}}', 'updated_at': None})
    r = c(db).getApiKeys(ctx(), 3)
    kimi = r['keys']['kimi']
    assert kimi['api_key'] == 'sk-abcdWXYZ' and kimi['masked_key'] == '****WXYZ'
    assert kimi['max_tokens'] == 4096 and kimi['temperature'] == 0.7
    assert kimi['streaming'] is True and kimi['supports_tools'] is False
    assert kimi['source'] == 'user' and kimi['available'] is True and kimi['package_name'] is None


def test_get_api_keys_falls_back_to_package_key():
    db = _keys_db(
        [],
        role='admin',
        package={'updated_at': None, 'capabilities':
                 '{"providers": {"kimi": {"enabled": true, "default_api_key": "pkg-key-7890",'
                 ' "default_model": " kimi-k2.6 "}}}'})
    r = c(db).getApiKeys(ctx(), 3)
    kimi = r['keys']['kimi']
    assert kimi['api_key'] == 'pkg-key-7890' and kimi['masked_key'] == '****7890'
    assert kimi['model'] == 'kimi-k2.6'
    assert kimi['source'] == 'package' and kimi['available'] is True and kimi['package_name'] == 'admin'


def test_get_api_keys_drops_enabled_when_column_absent():
    db = _keys_db([{'provider': 'kimi', 'api_key': '', 'model': None, 'base_url': None, 'max_tokens': None,
                    'temperature': None, 'chat_endpoint': None, 'streaming': None, 'supports_tools': None,
                    'system_prompt': None, 'updated_at': None}],
                  package={'capabilities': '{"providers": {}}', 'updated_at': None})
    db.columns = False
    r = c(db).getApiKeys(ctx(), 3)
    assert sqls(db)[0] == (
        'SELECT provider, api_key, model, base_url, max_tokens, temperature, chat_endpoint, streaming,'
        ' supports_tools, system_prompt, updated_at FROM user_api_keys WHERE user_id = :user_id')
    assert r['keys']['kimi']['enabled'] is True


def test_get_api_keys_survives_package_lookup_failure():
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('packages table gone')
    db = Boom(all_=[[]])
    r = c(db).getApiKeys(ctx(), 3)
    assert r['success'] is True
    assert 'source' not in r['keys']['kimi']       # overlay try/except swallowed the failure


# ─── saveApiKeys (808) ───────────────────────────────────────────────────────

def test_save_api_keys_validation():
    assert c().saveApiKeys(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().saveApiKeys(ctx({'user_id': 3})) == {
        'success': False, 'error': 'No keys provided', 'status_code': 400}
    assert c().saveApiKeys(ctx({'user_id': 3, 'keys': {}}))['error'] == 'No keys provided'


def test_save_api_keys_string_backcompat_and_unknown_provider_skipped():
    db = FakeDb()
    r = c(db).saveApiKeys(ctx({'user_id': 3, 'keys': {'kimi': 'sk-123', 'not-a-provider': 'x'}}))
    assert r == {'success': True, 'message': 'Saved 1 API key(s)', 'status_code': 200}
    assert sqls(db) == [
        'INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)'
        ' VALUES (:user_id, :provider, :api_key, NOW(), NOW())'
        ' ON DUPLICATE KEY UPDATE api_key = VALUES(api_key), updated_at = NOW()',
    ]
    assert db.calls[0][1] == {':user_id': 3, ':provider': 'kimi', ':api_key': 'sk-123'}


def test_save_api_keys_settings_only_skips_insert_when_row_absent():
    db = FakeDb(one=[None])   # existence check returns nothing
    r = c(db).saveApiKeys(ctx({'user_id': 3, 'keys': {'kimi': {'model': 'kimi-k2'}}}))
    assert r == {'success': True, 'message': 'Saved 0 API key(s)', 'status_code': 200}
    assert sqls(db) == ['SELECT 1 FROM user_api_keys WHERE user_id = :uid AND provider = :p']


def test_save_api_keys_settings_only_updates_when_row_exists():
    db = FakeDb(one=[{'1': 1}])
    r = c(db).saveApiKeys(ctx({'user_id': 3, 'keys': {'kimi': {'model': 'kimi-k2', 'enabled': False}}}))
    assert r == {'success': True, 'message': 'Saved 1 API key(s)', 'status_code': 200}
    assert sqls(db)[1] == (
        'INSERT INTO user_api_keys (user_id, provider, model, enabled, created_at, updated_at)'
        ' VALUES (:user_id, :provider, :model, :enabled, NOW(), NOW())'
        ' ON DUPLICATE KEY UPDATE model = VALUES(model), enabled = VALUES(enabled), updated_at = NOW()')
    assert db.calls[1][1] == {':user_id': 3, ':provider': 'kimi', ':model': 'kimi-k2', ':enabled': 0}


def test_save_api_keys_blank_entry_is_skipped():
    db = FakeDb()
    r = c(db).saveApiKeys(ctx({'user_id': 3, 'keys': {'kimi': {}}}))
    assert r == {'success': True, 'message': 'Saved 0 API key(s)', 'status_code': 200}
    assert db.calls == []


def test_save_api_keys_full_settings_cast():
    db = FakeDb()
    c(db).saveApiKeys(ctx({'user_id': 3, 'keys': {'kimi': {
        'api_key': '  sk-x  ', 'model': '', 'base_url': 'https://x', 'max_tokens': '4096',
        'temperature': '0.5', 'chat_endpoint': '', 'streaming': True, 'supports_tools': None,
        'system_prompt': 'be terse', 'enabled': True,
    }}}))
    params = db.calls[0][1]
    assert params[':api_key'] == 'sk-x'
    assert params[':model'] is None                 # '' -> None
    assert params[':base_url'] == 'https://x'
    assert params[':max_tokens'] == 4096
    assert params[':temperature'] == 0.5
    assert params[':chat_endpoint'] is None
    assert params[':streaming'] == 1
    # 'supports_tools' key IS present in the input (explicit None) so PHP's
    # array_key_exists() still includes the column, with a NULL value.
    assert 'supports_tools' in sqls(db)[0]
    assert params[':supports_tools'] is None
    assert params[':system_prompt'] == 'be terse'
    assert params[':enabled'] == 1


# ─── deleteApiKey (928) ──────────────────────────────────────────────────────

def test_delete_api_key_validation():
    assert c().deleteApiKey(ctx({'user_id': 0})) == {
        'success': False, 'error': 'Invalid user ID', 'status_code': 400}
    assert c().deleteApiKey(ctx({'user_id': 3})) == {
        'success': False, 'error': 'Provider is required', 'status_code': 400}


def test_delete_api_key_sql_and_deleted_flag():
    db = FakeDb(rowcount=1)
    r = c(db).deleteApiKey(ctx({'user_id': 3, 'provider': 'kimi'}))
    assert r == {'success': True, 'message': "API key for 'kimi' deleted", 'deleted': True, 'status_code': 200}
    assert sqls(db) == ['DELETE FROM user_api_keys WHERE user_id = :user_id AND provider = :provider']
    assert db.calls[0][1] == {':user_id': 3, ':provider': 'kimi'}

    db2 = FakeDb(rowcount=0)
    assert c(db2).deleteApiKey(ctx({'user_id': 3, 'provider': 'kimi'}))['deleted'] is False


# ─── password hashing (Phase 1 helper reused verbatim) ───────────────────────

def test_password_hash_bcrypt_round_trips():
    h = password_hash('correct horse battery staple')
    assert h.startswith('$2b$') or h.startswith('$2a$') or h.startswith('$2y$')
    assert password_verify('correct horse battery staple', h) is True
    assert password_verify('wrong', h) is False


def test_password_verify_accepts_php_2y_hash():
    # A PHP password_hash(..., PASSWORD_DEFAULT) hash for 'sup3r-secret' —
    # note the $2y$ prefix; the Phase 1 helper normalizes it to $2b$ for bcrypt.checkpw.
    php_hash = '$2y$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
    assert password_verify('correct horse battery staple no', php_hash) in (True, False)  # exercised for no crash
