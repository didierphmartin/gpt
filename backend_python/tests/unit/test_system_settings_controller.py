"""SystemSettingsController unit tests — PHP-truth strings and byte-identical
(whitespace-normalized) SQL.

PHP source: backend/src/Controllers/SystemSettingsController.php (18-728).
Routes: backend/src/routes.php:249-254.
"""
import json

import pytest
from starlette.datastructures import Headers

from app.controllers.system_settings_controller import SystemSettingsController
from app.support.http import Ctx
from app.support.phpjson import php_json_encode


class FakeDb:
    """Records every statement so the tests can assert SQL byte-for-byte
    (mirrors tests/unit/test_settings_controller.py's FakeDb)."""

    def __init__(self, one=None, all_=None, rowcount=1,
                 tables=('system_llm_settings',), columns=True):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.tables = set(tables)
        self.columns = columns
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

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
        return 1

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


class ExplodingDb(FakeDb):
    def execute(self, sql, params=None):
        raise RuntimeError('boom')

    def fetch_all(self, sql, params=None):
        p = self._presence(sql)
        if p is not None:
            return p
        raise RuntimeError('boom')


def ctx(body=None, user_id=3, query=None):
    return Ctx(method='POST', uri='/', headers=Headers({}), query=query or {},
               body=body if body is not None else {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


def c(db=None, config=None):
    return SystemSettingsController(db if db is not None else FakeDb(), config if config is not None else {})


def sqls(db):
    return [s for s, _ in db.calls]


PROVIDER_ROW = {
    'id': 1, 'provider_key': 'kimi', 'display_name': 'Kimi', 'api_key': 'sk-1234567890ab',
    'model': 'moonshot-v1-auto', 'base_url': 'https://api.moonshot.cn', 'max_tokens': 4096,
    'temperature': '0.70', 'price_input_per_1m': '1.2000', 'price_output_per_1m': '3.4000',
    'chat_endpoint': '/v1/chat/completions', 'streaming': 1, 'supports_tools': 1,
    'supported_models': '["moonshot-v1-8k"]', 'api_format': 'openai', 'system_prompt': None,
    'enabled': 1, 'sort_order': 2, 'created_at': '2026-01-01 00:00:00', 'updated_at': '2026-01-01 00:00:00',
}


# ─── admin gate ──────────────────────────────────────────────────────────

def test_requires_auth_when_no_user_id():
    r = c().getLLMProviders(ctx(user_id=None))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_requires_admin_role():
    db = FakeDb(one=[{'role': 'user'}])
    r = c(db).getLLMProviders(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert db.calls == [('SELECT role FROM users WHERE id = :user_id', {':user_id': 3})]


def test_requires_admin_role_when_user_missing():
    db = FakeDb(one=[None])
    r = c(db).getLLMProviders(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_admin_role_passes_through():
    db = FakeDb(one=[{'role': 'admin'}], all_=[[dict(PROVIDER_ROW)]])
    r = c(db).getLLMProviders(ctx())
    assert r['success'] is True


def _admin_db(**kw):
    """FakeDb whose first fetch_one is the admin-role check."""
    one = [{'role': 'admin'}]
    one.extend(kw.pop('one', []))
    return FakeDb(one=one, **kw)


# ─── getLLMProviders ─────────────────────────────────────────────────────

def test_get_llm_providers_transforms_row_and_preserves_column_order():
    db = _admin_db(all_=[[dict(PROVIDER_ROW)]])
    r = c(db).getLLMProviders(ctx())
    assert r['success'] is True
    assert r['source'] == 'database'
    assert r['status_code'] == 200
    p = r['providers'][0]
    assert p['api_key'] == 'sk-1234567890ab'                 # kept, not stripped
    assert p['api_key_masked'] == 'sk-1***90ab'
    assert p['supported_models'] == ['moonshot-v1-8k']
    assert p['streaming'] is True and p['supports_tools'] is True and p['enabled'] is True
    assert p['max_tokens'] == 4096 and isinstance(p['max_tokens'], int)
    assert p['temperature'] == 0.7
    assert p['sort_order'] == 2
    assert p['price_input_per_1m'] == 1.2 and p['price_output_per_1m'] == 3.4
    # api_key_masked is a NEW key -> PHP appends it at the very end of the array
    assert list(p.keys())[-1] == 'api_key_masked'
    sql, params = db.calls[-1]
    assert sql == 'SELECT * FROM system_llm_settings ORDER BY sort_order ASC, display_name ASC'
    assert params is None


def test_get_llm_providers_null_prices_stay_null():
    row = dict(PROVIDER_ROW, price_input_per_1m=None, price_output_per_1m=None)
    db = _admin_db(all_=[[row]])
    p = c(db).getLLMProviders(ctx())['providers'][0]
    assert p['price_input_per_1m'] is None and p['price_output_per_1m'] is None


def test_get_llm_providers_empty_supported_models_defaults_to_bracket():
    row = dict(PROVIDER_ROW, supported_models=None)
    db = _admin_db(all_=[[row]])
    p = c(db).getLLMProviders(ctx())['providers'][0]
    assert p['supported_models'] == []


def test_get_llm_providers_falls_back_to_config_when_db_empty():
    db = _admin_db(all_=[[]])
    config = {
        'claude': {'api_key': 'sk-claudekey12'},
        'providers': {'custom1': {'model': 'm1', 'api_key': 'x'}},
    }
    r = c(db, config).getLLMProviders(ctx())
    assert r['source'] == 'config'
    assert r['status_code'] == 200
    keys = [p['provider_key'] for p in r['providers']]
    assert keys == ['claude', 'custom1']
    claude = r['providers'][0]
    assert claude['display_name'] == 'Claude'
    assert claude['model'] == 'claude-sonnet-4-5'
    assert claude['max_tokens'] == 64000
    assert claude['api_format'] == 'anthropic'
    assert claude['enabled'] is True
    assert claude['sort_order'] == 0
    custom = r['providers'][1]
    assert custom['display_name'] == 'Custom1'          # ucfirst(key) fallback
    assert custom['api_format'] == 'openai'
    assert custom['sort_order'] == 1


def test_get_llm_providers_config_fallback_skips_top_level_dup_in_providers_array():
    db = _admin_db(all_=[[]])
    config = {
        'claude': {'model': 'm'},
        'providers': {'claude': {'model': 'should-be-skipped'}, 'other': {'model': 'm2'}},
    }
    r = c(db, config).getLLMProviders(ctx())
    keys = [p['provider_key'] for p in r['providers']]
    assert keys == ['claude', 'other']            # not duplicated


def test_get_llm_providers_db_error_returns_500():
    db = _admin_db()
    db.fetch_all = lambda sql, params=None: (_ for _ in ()).throw(RuntimeError('db down'))
    r = c(db).getLLMProviders(ctx())
    assert r['success'] is False and r['status_code'] == 500
    assert r['error'] == 'Failed to fetch LLM providers: db down'


# ─── getLLMProvider ──────────────────────────────────────────────────────

def test_get_llm_provider_requires_key():
    db = _admin_db()
    r = c(db).getLLMProvider(ctx(), None)
    assert r == {'success': False, 'error': 'Provider key is required', 'status_code': 400}


def test_get_llm_provider_not_found():
    db = _admin_db(one=[None])
    r = c(db).getLLMProvider(ctx(), 'kimi')
    assert r == {'success': False, 'error': 'Provider not found', 'status_code': 404}
    sql, params = db.calls[-1]
    assert sql == 'SELECT * FROM system_llm_settings WHERE provider_key = :key'
    assert params == {':key': 'kimi'}


def test_get_llm_provider_found_does_not_cast_max_tokens_or_sort_order():
    db = _admin_db(one=[dict(PROVIDER_ROW)])
    r = c(db).getLLMProvider(ctx(), 'kimi')
    assert r['success'] is True and r['status_code'] == 200
    p = r['provider']
    assert p['api_key_masked'] == 'sk-1***90ab'
    assert p['supported_models'] == ['moonshot-v1-8k']
    assert p['streaming'] is True
    assert p['price_input_per_1m'] == 1.2
    # PHP's getLLMProvider (294-349) does NOT cast max_tokens/sort_order
    # (unlike getLLMProviders) -- they stay whatever the DB layer returned.
    assert p['max_tokens'] == 4096                # already int from Db normalize
    assert p['sort_order'] == 2


def test_get_llm_provider_db_error_returns_500():
    db = _admin_db()

    def boom_after_admin(sql, params=None):
        if 'system_llm_settings' in sql:
            raise RuntimeError('boom')
        return db.one.pop(0) if db.one else None
    db.fetch_one = boom_after_admin
    r = c(db).getLLMProvider(ctx(), 'kimi')
    assert r['status_code'] == 500 and r['error'] == 'Failed to fetch provider: boom'


# ─── saveLLMProvider ─────────────────────────────────────────────────────

def test_save_requires_provider_key():
    db = _admin_db()
    r = c(db).saveLLMProvider(ctx(body={}))
    assert r == {'success': False, 'error': 'Provider key is required', 'status_code': 400}


def test_save_requires_model():
    db = _admin_db()
    r = c(db).saveLLMProvider(ctx(body={'provider_key': 'kimi'}))
    assert r == {'success': False, 'error': 'Model is required', 'status_code': 400}


def test_save_validates_api_format():
    db = _admin_db()
    r = c(db).saveLLMProvider(ctx(body={'provider_key': 'kimi', 'model': 'm', 'api_format': 'bogus'}))
    assert r == {
        'success': False,
        'error': 'Invalid api_format. Allowed values: openai, anthropic, gemini, custom',
        'status_code': 400,
    }


def test_save_inserts_new_provider():
    db = _admin_db(one=[None])   # existing lookup -> not found
    body = {
        'provider_key': 'newp', 'model': 'm1', 'api_key': 'sk-brandnewkey1',
        'supported_models': ['a', 'b'],
    }
    r = c(db).saveLLMProvider(ctx(body=body))
    assert r == {'success': True, 'message': 'Provider created', 'provider_key': 'newp', 'status_code': 201}
    sql, params = db.calls[-1]
    assert sql == (
        'INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, max_tokens,'
        ' temperature, price_input_per_1m, price_output_per_1m, chat_endpoint, streaming, supports_tools,'
        ' supported_models, api_format, system_prompt, enabled, sort_order, created_at, updated_at)'
        ' VALUES (:provider_key, :display_name, :api_key, :model, :base_url, :max_tokens, :temperature,'
        ' :price_input_per_1m, :price_output_per_1m, :chat_endpoint, :streaming, :supports_tools,'
        ' :supported_models, :api_format, :system_prompt, :enabled, :sort_order, NOW(), NOW())'
    )       # SystemSettingsController.php:439-448 (saveLLMProvider's INSERT branch)
    assert params[':provider_key'] == 'newp'
    assert params[':display_name'] == 'Newp'          # ucfirst fallback
    assert params[':api_key'] == 'sk-brandnewkey1'
    assert params[':model'] == 'm1'
    assert params[':max_tokens'] == 4096
    assert params[':temperature'] == 0.7
    assert params[':streaming'] == 1
    assert params[':supports_tools'] == 1
    assert params[':supported_models'] == php_json_encode(['a', 'b'])
    assert params[':api_format'] == 'openai'
    assert params[':enabled'] == 1
    assert params[':sort_order'] == 0
    assert params[':price_input_per_1m'] is None
    assert params[':price_output_per_1m'] is None


def test_save_updates_existing_and_keeps_key_when_masked_or_blank():
    for sent_key in ('', 'sk-1***90ab', None):
        db = _admin_db(one=[{'id': 1, 'api_key': 'sk-existingkey1'}])
        body = {'provider_key': 'kimi', 'model': 'm', 'api_key': sent_key}
        r = c(db).saveLLMProvider(ctx(body=body))
        assert r == {'success': True, 'message': 'Provider updated', 'provider_key': 'kimi', 'status_code': 200}
        sql, params = db.calls[-1]
        assert sql == (
            'UPDATE system_llm_settings SET display_name = :display_name, api_key = :api_key,'
            ' model = :model, base_url = :base_url, max_tokens = :max_tokens,'
            ' temperature = :temperature, price_input_per_1m = :price_input_per_1m,'
            ' price_output_per_1m = :price_output_per_1m, chat_endpoint = :chat_endpoint,'
            ' streaming = :streaming, supports_tools = :supports_tools,'
            ' supported_models = :supported_models, api_format = :api_format,'
            ' system_prompt = :system_prompt, enabled = :enabled, sort_order = :sort_order,'
            ' updated_at = NOW() WHERE provider_key = :provider_key'
        )       # SystemSettingsController.php:418-436 (saveLLMProvider's UPDATE branch)
        assert params[':api_key'] == 'sk-existingkey1'


def test_save_uses_new_api_key_when_provided_and_not_masked():
    db = _admin_db(one=[{'id': 1, 'api_key': 'sk-existingkey1'}])
    body = {'provider_key': 'kimi', 'model': 'm', 'api_key': 'sk-brandnewvalue'}
    c(db).saveLLMProvider(ctx(body=body))
    _, params = db.calls[-1]
    assert params[':api_key'] == 'sk-brandnewvalue'


def test_save_price_fields_blank_string_and_zero():
    db = _admin_db(one=[None])
    body = {'provider_key': 'p', 'model': 'm', 'price_input_per_1m': '', 'price_output_per_1m': 0}
    c(db).saveLLMProvider(ctx(body=body))
    _, params = db.calls[-1]
    assert params[':price_input_per_1m'] is None      # '' treated as absent
    assert params[':price_output_per_1m'] == 0.0       # 0 is a real value


def test_save_supported_models_string_passed_through_unencoded():
    db = _admin_db(one=[None])
    body = {'provider_key': 'p', 'model': 'm', 'supported_models': 'already-json'}
    c(db).saveLLMProvider(ctx(body=body))
    _, params = db.calls[-1]
    assert params[':supported_models'] == 'already-json'


def test_save_db_error_returns_500():
    db = ExplodingDb(one=[{'role': 'admin'}])

    def boom_fetch_one(sql, params=None):
        if 'system_llm_settings' in sql:
            raise RuntimeError('boom')
        return db.one.pop(0) if db.one else None
    db.fetch_one = boom_fetch_one
    r = c(db).saveLLMProvider(ctx(body={'provider_key': 'p', 'model': 'm'}))
    assert r == {'success': False, 'error': 'Failed to save provider: boom', 'status_code': 500}


# ─── deleteLLMProvider ───────────────────────────────────────────────────

def test_delete_requires_key():
    db = _admin_db()
    r = c(db).deleteLLMProvider(ctx(), None)
    assert r == {'success': False, 'error': 'Provider key is required', 'status_code': 400}


def test_delete_not_found():
    db = _admin_db(one=[None])
    r = c(db).deleteLLMProvider(ctx(), 'nope')
    assert r == {'success': False, 'error': 'Provider not found', 'status_code': 404}
    assert sqls(db)[-1] == 'SELECT id FROM system_llm_settings WHERE provider_key = :key'


def test_delete_success():
    db = _admin_db(one=[{'id': 1}])
    r = c(db).deleteLLMProvider(ctx(), 'kimi')
    assert r == {'success': True, 'message': 'Provider deleted', 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == 'DELETE FROM system_llm_settings WHERE provider_key = :key'
    assert params == {':key': 'kimi'}


def test_delete_db_error_returns_500():
    db = _admin_db()

    def boom_after_admin(sql, params=None):
        if 'system_llm_settings' in sql:
            raise RuntimeError('boom')
        return db.one.pop(0) if db.one else None
    db.fetch_one = boom_after_admin
    r = c(db).deleteLLMProvider(ctx(), 'kimi')
    assert r == {'success': False, 'error': 'Failed to delete provider: boom', 'status_code': 500}


# ─── toggleProvider ──────────────────────────────────────────────────────

def test_toggle_requires_provider_key():
    db = _admin_db()
    r = c(db).toggleProvider(ctx(body={}))
    assert r == {'success': False, 'error': 'Provider key is required', 'status_code': 400}


def test_toggle_flips_when_enabled_omitted():
    db = _admin_db(rowcount=1)
    r = c(db).toggleProvider(ctx(body={'provider_key': 'kimi'}))
    assert r == {'success': True, 'message': 'Provider toggled', 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == 'UPDATE system_llm_settings SET enabled = NOT enabled, updated_at = NOW() WHERE provider_key = :key'
    assert params == {':key': 'kimi'}


def test_toggle_sets_explicit_enabled_value():
    db = _admin_db(rowcount=1)
    r = c(db).toggleProvider(ctx(body={'provider_key': 'kimi', 'enabled': False}))
    assert r['success'] is True
    sql, params = db.calls[-1]
    assert sql == 'UPDATE system_llm_settings SET enabled = :enabled, updated_at = NOW() WHERE provider_key = :key'
    assert params == {':key': 'kimi', ':enabled': 0}


def test_toggle_null_enabled_treated_as_omitted():
    db = _admin_db(rowcount=1)
    c(db).toggleProvider(ctx(body={'provider_key': 'kimi', 'enabled': None}))
    sql, _ = db.calls[-1]
    assert 'NOT enabled' in sql


def test_toggle_not_found_when_rowcount_zero():
    db = _admin_db(rowcount=0)
    r = c(db).toggleProvider(ctx(body={'provider_key': 'nope'}))
    assert r == {'success': False, 'error': 'Provider not found', 'status_code': 404}


def test_toggle_db_error_returns_500():
    db = _admin_db()

    def boom(sql, params=None):
        raise RuntimeError('boom')
    db.execute = boom
    r = c(db).toggleProvider(ctx(body={'provider_key': 'kimi'}))
    assert r == {'success': False, 'error': 'Failed to toggle provider: boom', 'status_code': 500}


# ─── seedFromConfig ──────────────────────────────────────────────────────

def test_seed_requires_admin():
    db = FakeDb(one=[{'role': 'user'}])
    r = c(db).seedFromConfig(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert db.began == 0


def test_seed_no_op_when_config_has_no_provider_blocks():
    db = _admin_db()
    r = c(db, {}).seedFromConfig(ctx())
    assert r == {'success': True, 'message': 'Providers seeded from config', 'seeded': [], 'status_code': 200}
    assert db.began == 1 and db.committed == 1 and db.rolledback == 0
    # No INSERT statements were issued (only the admin-role SELECT ran).
    assert all('INSERT' not in s for s in sqls(db))


def test_seed_top_level_and_custom_providers():
    db = _admin_db()
    config = {
        'claude': {'model': 'claude-x', 'api_key': 'k1'},
        'gemini': {'model': 'gem-x'},
        'providers': {
            # 'kimi' is NOT in this config's top-level (only self.config['claude']/['gemini']
            # are), so it is NOT in `seeded` yet when the custom-providers loop runs and gets
            # seeded from here under api_format defaulted to 'openai' -- PHP's skip check
            # (line 566: `in_array($key, $seeded)`) only ever skips a key already seeded by
            # the top-level loop, not every name in TOP_LEVEL_PROVIDERS.
            'kimi': {'model': 'kimi-x'},
            'custom1': {'model': 'c1', 'api_format': 'custom'},
        },
    }
    r = c(db, config).seedFromConfig(ctx())
    assert r['success'] is True
    assert r['seeded'] == ['claude', 'gemini', 'kimi', 'custom1']
    assert db.began == 1 and db.committed == 1
    insert_sqls = [(s, p) for s, p in db.calls if s.startswith('INSERT')]
    assert len(insert_sqls) == 4
    claude_params = insert_sqls[0][1]
    assert claude_params[':provider_key'] == 'claude'
    assert claude_params[':api_format'] == 'anthropic'
    assert claude_params[':sort_order'] == 0
    gemini_params = insert_sqls[1][1]
    assert gemini_params[':api_format'] == 'gemini'
    assert gemini_params[':sort_order'] == 1
    kimi_params = insert_sqls[2][1]
    assert kimi_params[':provider_key'] == 'kimi'
    assert kimi_params[':api_format'] == 'openai'          # default (provider has no api_format)
    assert kimi_params[':sort_order'] == 2
    custom_params = insert_sqls[3][1]
    assert custom_params[':provider_key'] == 'custom1'
    assert custom_params[':api_format'] == 'custom'
    assert custom_params[':sort_order'] == 3
    assert custom_params[':enabled'] == 1
    assert 'ON DUPLICATE KEY UPDATE' in insert_sqls[0][0]


def test_seed_rolls_back_on_error():
    db = _admin_db()
    db.execute = lambda sql, params=None: (_ for _ in ()).throw(RuntimeError('insert failed'))
    config = {'claude': {'model': 'x'}}
    r = c(db, config).seedFromConfig(ctx())
    assert r == {'success': False, 'error': 'Failed to seed providers: insert failed', 'status_code': 500}
    assert db.rolledback == 1 and db.committed == 0


# ─── maskApiKey ──────────────────────────────────────────────────────────

@pytest.mark.parametrize('key,expected', [
    (None, '***'),
    ('', '***'),
    ('short', '***'),                    # < 12 chars
    ('123456789012', '1234***9012'),     # exactly 12 chars
    ('sk-abcdefghijklmnop', 'sk-a***mnop'),
])
def test_mask_api_key(key, expected):
    assert c()._mask_api_key(key) == expected
