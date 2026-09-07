"""SettingsController unit tests — PHP-truth strings and byte-identical SQL.

PHP source: backend/src/Controllers/SettingsController.php (25-1346).
"""
import base64

import pytest
from starlette.datastructures import Headers

from app.controllers.settings_controller import SettingsController
from app.support.http import Ctx
from app.support.phpcompat import php_array, php_floatval
from app.support.phpjson import php_json_encode

CONFIG = {'auth': {'jwt_secret': 'test-jwt-secret'}}

# openssl_encrypt('sk-differential-1234', 'AES-256-CBC', hash('sha256','test-jwt-secret',true),
#                 OPENSSL_RAW_DATA, str_repeat("\x01", 16)) prefixed by the IV, base64'd — produced
# by the live PHP CLI so the interop is pinned against real PHP output, not our own encryptor.
PHP_CIPHERTEXT = 'AQEBAQEBAQEBAQEBAQEBAS6d1m13WSupDdCkNQG1HaiD6z7+lv4ZqQir1rWyurev'
PHP_PLAINTEXT = 'sk-differential-1234'


class FakeDb:
    """Records every statement so the tests can assert SQL byte-for-byte."""

    def __init__(self, one=None, all_=None, rowcount=1, tables=('user_api_keys', 'user_model_selections',
                                                                'user_provider_settings', 'user_category_settings'),
                 columns=True):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
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
        return 1


def ctx(body=None, user_id=3, query=None):
    return Ctx(method='POST', uri='/', headers=Headers({}), query=query or {}, body=body if body is not None else {},
               raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')


def c(db=None, config=None):
    return SettingsController(db if db is not None else FakeDb(), config if config is not None else CONFIG)


def sqls(db):
    return [s for s, _ in db.calls]


# ─── crypto interop (SettingsController.php:841-863) ───────────────────────

def test_decrypt_php_produced_ciphertext():
    assert c().decryptApiKey(PHP_CIPHERTEXT) == PHP_PLAINTEXT


def test_encrypt_round_trips_and_uses_php_iv_layout():
    ctl = c()
    blob = ctl.encryptApiKey(PHP_PLAINTEXT)
    raw = base64.b64decode(blob)
    assert len(raw) == 16 + 32                      # 16-byte IV + 2 AES blocks (PKCS#7)
    assert ctl.decryptApiKey(blob) == PHP_PLAINTEXT
    # A fresh random IV every call, exactly like openssl_random_pseudo_bytes(16).
    assert ctl.encryptApiKey(PHP_PLAINTEXT) != blob


def test_decrypt_rejects_short_and_garbage_payloads():
    ctl = c()
    assert ctl.decryptApiKey('') is None                 # strlen($data) < 17
    assert ctl.decryptApiKey(base64.b64encode(b'x' * 16).decode()) is None
    assert ctl.decryptApiKey('!!!not base64!!!') is None


def test_encryption_key_falls_back_to_php_default():
    assert SettingsController(FakeDb(), {}).encryptionKey == 'default-encryption-key-change-this'


# ─── getPhoneStatus (45) ───────────────────────────────────────────────────

def test_get_phone_status_sql_and_payload():
    db = FakeDb(one=[{'phone': '+41791112233'}])
    r = c(db).getPhoneStatus(ctx())
    assert r == {'success': True, 'phone': '+41791112233', 'has_phone': True, 'status_code': 200}
    assert db.calls == [("SELECT phone FROM users WHERE id = :user_id", {':user_id': 3})]


def test_get_phone_status_no_row_and_empty_phone():
    assert c(FakeDb(one=[None])).getPhoneStatus(ctx()) == {
        'success': True, 'phone': None, 'has_phone': False, 'status_code': 200}
    assert c(FakeDb(one=[{'phone': ''}])).getPhoneStatus(ctx())['has_phone'] is False


# ─── getUsage (65) ─────────────────────────────────────────────────────────

def test_get_usage_sql_and_aggregation():
    db = FakeDb(
        all_=[[{'provider': 'kimi', 'month_requests': 4, 'month_tokens': 100, 'month_cost_usd': '0.25',
                'total_requests': 9, 'total_tokens': 900, 'total_cost_usd': '1.50',
                'monthly_budget_usd': '500.00', 'monthly_request_limit': 10, 'current_month': '2026-09'},
               {'provider': 'grok', 'month_requests': 1, 'month_tokens': 10, 'month_cost_usd': '0.05',
                'total_requests': 1, 'total_tokens': 10, 'total_cost_usd': '0.05',
                'monthly_budget_usd': '500.00', 'monthly_request_limit': 10, 'current_month': '2026-09'}],
              [{'provider': 'kimi', 'avg_response_time': '1234.5678', 'month_input_tokens': '60',
                'month_output_tokens': '40', 'request_count': 4}]],
        one=[{'lifetime_input_tokens': '600', 'lifetime_output_tokens': '400',
              'lifetime_total_tokens': '1000', 'lifetime_cost_usd': '1.55', 'lifetime_requests': 9},
             {'plan': 'pro', 'role': 'admin'}])
    r = c(db).getUsage(ctx())
    u = r['usage']
    assert sqls(db) == [
        ("SELECT provider, month_requests, month_tokens, month_cost_usd, total_requests, total_tokens,"
         " total_cost_usd, monthly_budget_usd, monthly_request_limit, current_month"
         " FROM llm_usage_balance WHERE user_id = :user_id"),
        ("SELECT provider, AVG(response_time_ms) as avg_response_time,"
         " SUM(prompt_tokens) as month_input_tokens, SUM(completion_tokens) as month_output_tokens,"
         " COUNT(*) as request_count FROM llm_usage_transactions"
         " WHERE user_id = :user_id AND created_at >= :month_start GROUP BY provider"),
        ("SELECT COALESCE(SUM(prompt_tokens), 0) as lifetime_input_tokens,"
         " COALESCE(SUM(completion_tokens), 0) as lifetime_output_tokens,"
         " COALESCE(SUM(total_tokens), 0) as lifetime_total_tokens,"
         " COALESCE(SUM(cost_usd), 0) as lifetime_cost_usd, COUNT(*) as lifetime_requests"
         " FROM llm_usage_transactions WHERE user_id = :user_id"),
        "SELECT plan, role FROM users WHERE id = :user_id",
    ]
    assert db.calls[1][1] == {':user_id': 3, ':month_start': u['current_month'] + '-01'}
    assert u['by_provider']['kimi'] == {
        'month_requests': 4, 'month_tokens': 100, 'month_input_tokens': 60, 'month_output_tokens': 40,
        'month_cost_usd': 0.25, 'total_requests': 9, 'total_tokens': 900, 'total_cost_usd': 1.5,
        'budget_limit': 500.0, 'request_limit': 10, 'avg_response_time': '1234.5678'}
    # A provider with no transaction row gets zeros and a null response time (PHP `?? 0` / `?? null`).
    assert u['by_provider']['grok']['month_input_tokens'] == 0
    assert u['by_provider']['grok']['avg_response_time'] is None
    assert u['totals'] == {'cost_usd': 0.25 + 0.05, 'tokens': 110, 'requests': 5}
    assert u['lifetime'] == {'input_tokens': 600, 'output_tokens': 400, 'total_tokens': 1000,
                             'cost_usd': 1.55, 'requests': 9}
    assert (u['plan'], u['role'], u['free_trial_quota']) == ('pro', 'admin', 50000)


def test_get_usage_defaults_when_user_row_missing():
    db = FakeDb(all_=[[], []], one=[None, None])
    u = c(db).getUsage(ctx())['usage']
    assert (u['plan'], u['role']) == ('free', 'prospect')
    assert u['totals'] == {'cost_usd': 0, 'tokens': 0, 'requests': 0}
    assert u['lifetime']['cost_usd'] == 0.0


# ─── getKeys (194) ─────────────────────────────────────────────────────────

def _keys_db(rows, models=None, role='guest', package=None):
    """PackageResolver reads `users.role` first, then the `packages` row."""
    return FakeDb(all_=[rows, models or []], one=[{'role': role}, package])


def test_get_keys_masks_and_collects_prompts():
    ctl = c()
    blob = ctl.encryptApiKey('sk-abcdEFGH')
    db = _keys_db(
        [{'provider': 'kimi', 'api_key': blob, 'system_prompt': 'be terse',
          'created_at': '2026-01-01 00:00:00', 'updated_at': '2026-01-02 00:00:00'},
         {'provider': 'grok', 'api_key': '', 'system_prompt': None,
          'created_at': '2026-01-01 00:00:00', 'updated_at': '2026-01-02 00:00:00'}],
        models=[{'provider': 'kimi', 'model': 'kimi-k2.6'}],
        package={'capabilities': '{"providers": {}}', 'updated_at': None})
    r = SettingsController(db, CONFIG).getKeys(ctx())
    assert r['keys'] == {
        'kimi': {'has_custom_key': True, 'masked_key': '****EFGH', 'updated_at': '2026-01-02 00:00:00'},
        'grok': {'has_custom_key': False, 'masked_key': None, 'updated_at': '2026-01-02 00:00:00'}}
    assert r['system_prompts'] == {'kimi': 'be terse'}
    assert r['models'] == {'kimi': 'kimi-k2.6'}
    assert r['status_code'] == 200
    assert sqls(db)[:2] == [
        ("SELECT provider, api_key, system_prompt, created_at, updated_at"
         " FROM user_api_keys WHERE user_id = :user_id"),
        "SELECT provider, model FROM user_model_selections WHERE user_id = :user_id",
    ]


def test_get_keys_drops_system_prompt_when_column_absent():
    """PHP ALTERs the column in first and then reads NULL for every row; with no
    runtime DDL the port omits it from the SELECT and yields the same payload."""
    db = _keys_db([{'provider': 'kimi', 'api_key': '', 'created_at': None, 'updated_at': None}])
    db.columns = False
    r = SettingsController(db, CONFIG).getKeys(ctx())
    assert sqls(db)[0] == ("SELECT provider, api_key, created_at, updated_at"
                           " FROM user_api_keys WHERE user_id = :user_id")
    assert r['system_prompts'] == []


def test_get_provider_settings_drops_enabled_when_column_absent():
    """PHP's ALTER adds `enabled TINYINT(1) NOT NULL DEFAULT 1`, so every row reads
    back enabled -> true; the port drops the column and reports the same."""
    db = FakeDb(all_=[[], [{'category': 'voice', 'provider': 'grok', 'api_key': None,
                            'settings': None, 'is_active': 0}]], columns=False)
    r = c(db).getProviderSettings(ctx())
    assert sqls(db)[1] == ("SELECT category, provider, api_key, settings, is_active"
                           " FROM user_provider_settings WHERE user_id = :user_id")
    assert r['voice']['providers']['grok']['enabled'] is True


def test_get_keys_package_models_and_locks():
    ctl = c()
    db = _keys_db(
        [{'provider': 'kimi', 'api_key': ctl.encryptApiKey('sk-own-key'), 'system_prompt': None,
          'created_at': None, 'updated_at': None}],
        role='admin', package={'updated_at': None, 'capabilities':
                 '{"providers": {"kimi": {"enabled": true, "default_model": " kimi-k2.6 "},'
                 ' "grok": {"enabled": true, "default_model": ""},'
                 ' "glm": {"enabled": false, "default_model": "glm-5"}}}'})
    r = SettingsController(db, CONFIG).getKeys(ctx())
    assert r['package_models'] == {'kimi': 'kimi-k2.6'}       # trimmed; blank default_model skipped
    assert r['locked'] == {'kimi': False, 'grok': True}       # disabled providers are skipped entirely


def test_get_keys_survives_package_lookup_failure():
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('packages table gone')
    db = Boom(all_=[[], []])
    r = SettingsController(db, CONFIG).getKeys(ctx())
    # PHP json_encodes an empty array as [], not {} — php_array() keeps the wire shape.
    assert r['package_models'] == [] and r['locked'] == [] and r['success'] is True
    assert r['keys'] == [] and r['models'] == [] and r['system_prompts'] == []


# ─── saveKeys (282) ────────────────────────────────────────────────────────

def test_save_keys_empty_payload_error_string():
    assert c().saveKeys(ctx({})) == {
        'success': False, 'error': 'No keys, models, or system_prompts provided', 'status_code': 400}
    assert c().saveKeys(ctx({'keys': {}, 'models': {}, 'system_prompts': {}}))['error'] == \
        'No keys, models, or system_prompts provided'


def test_save_keys_null_key_is_trimmed_away_not_stringified():
    """PHP trim(null) === '' -> the provider is skipped. Python's str(None) would
    have stored the literal 'None' as the user's API key."""
    db = FakeDb()
    r = c(db).saveKeys(ctx({'keys': {'openai': None}}))
    assert r['saved_count'] == 0 and db.calls == []
    assert r['message'] == 'Saved 0 API key(s), 0 model(s), 0 system prompt(s)'


def test_save_keys_bool_model_follows_php_string_cast():
    """PHP trim(true) === '1' (stored) and trim(false) === '' (skipped)."""
    db = FakeDb()
    r = c(db).saveKeys(ctx({'models': {'openai': True, 'kimi': False}}))
    assert r['model_count'] == 1
    assert db.calls[0][1] == {':user_id': 3, ':provider': 'openai', ':model': '1'}


def test_save_keys_keeps_php_trim_charlist():
    """PHP trims only " \t\n\r\0\x0B" — a NBSP-wrapped key stays wrapped."""
    db = FakeDb()
    ctl = c(db)
    ctl.saveKeys(ctx({'keys': {'kimi': '\u00a0sk-live\u00a0'}}))
    assert ctl.decryptApiKey(db.calls[0][1][':api_key']) == '\u00a0sk-live\u00a0'


def test_save_keys_skips_unknown_provider_and_blank_key():
    db = FakeDb()
    r = c(db).saveKeys(ctx({'keys': {'nope': 'x', 'kimi': '   '}}))
    assert r['saved_count'] == 0 and db.calls == []
    assert r['message'] == 'Saved 0 API key(s), 0 model(s), 0 system prompt(s)'


def test_save_keys_writes_php_sql_and_encrypts():
    db = FakeDb()
    ctl = c(db)
    r = ctl.saveKeys(ctx({'keys': {'kimi': '  sk-live  '},
                          'models': {'kimi': ' kimi-k2.6 ', 'bogus': 'x'},
                          'system_prompts': {'grok': '  be terse ', 'claude': '', 'gemini': 7}}))
    assert r == {'success': True, 'message': 'Saved 1 API key(s), 1 model(s), 2 system prompt(s)',
                 'saved_count': 1, 'model_count': 1, 'prompt_count': 2, 'status_code': 200}
    assert sqls(db) == [
        ("INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)"
         " VALUES (:user_id, :provider, :api_key, NOW(), NOW())"
         " ON DUPLICATE KEY UPDATE api_key = VALUES(api_key), updated_at = NOW()"),
        ("INSERT INTO user_model_selections (user_id, provider, model, updated_at)"
         " VALUES (:user_id, :provider, :model, NOW())"
         " ON DUPLICATE KEY UPDATE model = VALUES(model), updated_at = NOW()"),
        ("INSERT INTO user_api_keys (user_id, provider, api_key, system_prompt, created_at, updated_at)"
         " VALUES (:user_id, :provider, '', :system_prompt, NOW(), NOW())"
         " ON DUPLICATE KEY UPDATE system_prompt = VALUES(system_prompt), updated_at = NOW()"),
        ("INSERT INTO user_api_keys (user_id, provider, api_key, system_prompt, created_at, updated_at)"
         " VALUES (:user_id, :provider, '', :system_prompt, NOW(), NOW())"
         " ON DUPLICATE KEY UPDATE system_prompt = VALUES(system_prompt), updated_at = NOW()"),
    ]
    assert ctl.decryptApiKey(db.calls[0][1][':api_key']) == 'sk-live'
    assert db.calls[1][1] == {':user_id': 3, ':provider': 'kimi', ':model': 'kimi-k2.6'}
    assert db.calls[2][1][':system_prompt'] == 'be terse'
    assert db.calls[3][1][':system_prompt'] is None          # '' clears the override
    # A non-string prompt (7) is skipped by PHP's is_string() guard.
    assert [p[':provider'] for _, p in db.calls[2:]] == ['grok', 'claude']


# ─── clearKeys (414) ───────────────────────────────────────────────────────

def test_clear_keys_sql_and_message():
    db = FakeDb(rowcount=6)
    assert c(db).clearKeys(ctx()) == {
        'success': True, 'message': 'Cleared 6 API key(s) and 6 model selection(s)',
        'deleted_count': 6, 'status_code': 200}
    assert db.calls == [("DELETE FROM user_api_keys WHERE user_id = :user_id", {':user_id': 3}),
                        ("DELETE FROM user_model_selections WHERE user_id = :user_id", {':user_id': 3})]


# ─── getProviderSettings (442) ─────────────────────────────────────────────

def test_get_provider_settings_shape():
    db = FakeDb(all_=[[{'category': 'avatar', 'enabled': 0}],
                      [{'category': 'voice', 'provider': 'gemini', 'api_key': 'x',
                        'settings': '{"voiceId":"Zephyr"}', 'is_active': 1, 'enabled': 1},
                       {'category': 'voice', 'provider': 'hume', 'api_key': None,
                        'settings': None, 'is_active': 0, 'enabled': 0}]])
    r = c(db).getProviderSettings(ctx())
    assert r['avatar'] == {'active': None, 'enabled': False, 'providers': []}
    assert r['voice'] == {'active': 'gemini', 'enabled': True, 'providers': {
        'gemini': {'has_key': True, 'settings': {'voiceId': 'Zephyr'}, 'enabled': True},
        'hume': {'has_key': False, 'settings': None, 'enabled': False}}}
    assert sqls(db) == [
        "SELECT category, enabled FROM user_category_settings WHERE user_id = :user_id",
        ("SELECT category, provider, api_key, settings, is_active, enabled"
         " FROM user_provider_settings WHERE user_id = :user_id"),
    ]


# ─── saveProvider (503) ────────────────────────────────────────────────────

@pytest.mark.parametrize('body,error', [
    ({}, 'Invalid category. Must be "avatar" or "voice"'),
    ({'category': 'nope', 'provider': 'did'}, 'Invalid category. Must be "avatar" or "voice"'),
    ({'category': 'avatar', 'provider': 'gemini'}, 'Invalid avatar provider'),
    ({'category': 'voice', 'provider': 'did'}, 'Invalid voice provider'),
])
def test_save_provider_validation_strings(body, error):
    assert c().saveProvider(ctx(body)) == {'success': False, 'error': error, 'status_code': 400}


def test_save_provider_insert_when_absent():
    db = FakeDb(one=[None])
    r = c(db).saveProvider(ctx({'category': 'voice', 'provider': 'grok', 'settings': {'voiceId': 'Ara'}}))
    assert r == {'success': True, 'message': "Provider 'grok' saved for voice", 'status_code': 200}
    assert sqls(db) == [
        ("SELECT id, api_key FROM user_provider_settings"
         " WHERE user_id = :user_id AND category = :category AND provider = :provider"),
        ("INSERT INTO user_provider_settings"
         " (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)"
         " VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())"),
    ]
    assert db.calls[1][1][':settings'] == '{"voiceId":"Ara"}' and db.calls[1][1][':api_key'] is None


def test_save_provider_update_without_key_omits_api_key_column():
    db = FakeDb(one=[{'id': 2, 'api_key': None}])
    c(db).saveProvider(ctx({'category': 'voice', 'provider': 'hume', 'settings': '{"configId":"a"}'}))
    assert sqls(db)[1] == ("UPDATE user_provider_settings SET settings = :settings, updated_at = NOW()"
                           " WHERE user_id = :user_id AND category = :category AND provider = :provider")
    assert db.calls[1][1] == {':user_id': 3, ':category': 'voice', ':provider': 'hume',
                              ':settings': '{"configId":"a"}'}


def test_save_provider_update_with_key_encrypts():
    db = FakeDb(one=[{'id': 2, 'api_key': 'old'}])
    ctl = c(db)
    ctl.saveProvider(ctx({'category': 'avatar', 'provider': 'did', 'api_key': ' k-123 ', 'settings': None}))
    assert sqls(db)[1] == ("UPDATE user_provider_settings"
                           " SET api_key = :api_key, settings = :settings, updated_at = NOW()"
                           " WHERE user_id = :user_id AND category = :category AND provider = :provider")
    assert ctl.decryptApiKey(db.calls[1][1][':api_key']) == 'k-123'
    assert db.calls[1][1][':settings'] is None


# ─── setActiveProvider (617) ───────────────────────────────────────────────

@pytest.mark.parametrize('body,error', [
    ({'provider': 'grok'}, 'Invalid category. Must be "avatar" or "voice"'),
    ({'category': 'voice'}, 'Provider is required'),
    ({'category': 'voice', 'provider': ''}, 'Provider is required'),
])
def test_set_active_provider_validation_strings(body, error):
    assert c().setActiveProvider(ctx(body)) == {'success': False, 'error': error, 'status_code': 400}


def test_set_active_provider_not_configured_message():
    assert c(FakeDb(one=[None])).setActiveProvider(ctx({'category': 'voice', 'provider': 'grok'})) == {
        'success': False, 'error': "Provider 'grok' not configured for voice", 'status_code': 400}


def test_set_active_provider_deactivates_then_activates():
    db = FakeDb(one=[{'id': 1}])
    r = c(db).setActiveProvider(ctx({'category': 'voice', 'provider': 'grok'}))
    assert r == {'success': True, 'message': "Active voice provider set to 'grok'", 'status_code': 200}
    assert sqls(db) == [
        ("SELECT id FROM user_provider_settings"
         " WHERE user_id = :user_id AND category = :category AND provider = :provider"),
        "UPDATE user_provider_settings SET is_active = 0 WHERE user_id = :user_id AND category = :category",
        ("UPDATE user_provider_settings SET is_active = 1, updated_at = NOW()"
         " WHERE user_id = :user_id AND category = :category AND provider = :provider"),
    ]


# ─── deleteProvider (692) ──────────────────────────────────────────────────

@pytest.mark.parametrize('body,error', [
    ({'provider': 'grok'}, 'Invalid category. Must be "avatar" or "voice"'),
    ({'category': 'voice'}, 'Provider is required'),
])
def test_delete_provider_validation_strings(body, error):
    assert c().deleteProvider(ctx(body)) == {'success': False, 'error': error, 'status_code': 400}


def test_delete_provider_messages_both_ways():
    db = FakeDb(rowcount=1)
    assert c(db).deleteProvider(ctx({'category': 'voice', 'provider': 'grok'})) == {
        'success': True, 'message': "Provider 'grok' deleted from voice", 'deleted': True, 'status_code': 200}
    assert sqls(db) == [("DELETE FROM user_provider_settings"
                         " WHERE user_id = :user_id AND category = :category AND provider = :provider")]
    assert c(FakeDb(rowcount=0)).deleteProvider(ctx({'category': 'avatar', 'provider': 'did'})) == {
        'success': True, 'message': "Provider 'did' was not configured for avatar",
        'deleted': False, 'status_code': 200}


# ─── ensure* — no runtime DDL (Global Constraints §3) ──────────────────────

def test_ensure_helpers_never_emit_ddl():
    db = FakeDb(all_=[[], []])
    ctl = c(db)
    for name in ('ensureApiKeysTableExists', 'ensureUserModelsTableExists',
                 'ensureProviderSettingsTableExists', 'ensureCategorySettingsTableExists',
                 'ensureStorageColumnsExist', 'ensureHealColumnsExist', 'ensureGenesisColumnsExist'):
        getattr(ctl, name)()
    assert db.calls == []                      # presence probes are not recorded; no CREATE/ALTER ran


def test_ensure_logs_when_table_missing(caplog):
    db = FakeDb(tables=())
    ctl = c(db)
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        ctl.ensureApiKeysTableExists()
        ctl.ensureUserModelsTableExists()
    msgs = [r.getMessage() for r in caplog.records]
    assert '[SettingsController] user_api_keys missing — PHP creates it on demand' in msgs
    assert '[SettingsController] user_model_selections missing — PHP creates it on demand' in msgs


def test_ensure_logs_when_column_missing(caplog):
    ctl = c(FakeDb(columns=False))
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        ctl.ensureApiKeysTableExists()
        ctl.ensureHealColumnsExist()
    msgs = [r.getMessage() for r in caplog.records]
    assert '[SettingsController] user_api_keys.system_prompt missing — PHP creates it on demand' in msgs
    assert '[SettingsController] users.heal_mode missing — PHP creates it on demand' in msgs


# ─── heal settings (899-1006) ──────────────────────────────────────────────

HEAL_DEFAULTS = {'heal_mode': 'off', 'heal_daily_budget_usd': 5.0, 'heal_per_heal_ceiling_usd': 1.0,
                 'heal_proposer_provider': 'claude', 'heal_eval_provider': 'kimi',
                 'heal_judge_provider': 'kimi', 'heal_max_iterations': 3, 'heal_runs_per_query': 3}


def test_get_heal_settings_requires_auth():
    assert c().getHealSettings(ctx(user_id=0)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert c().saveHealSettings(ctx({}, user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_get_heal_settings_coerces_row_types():
    db = FakeDb(one=[{'heal_mode': 'auto', 'heal_daily_budget_usd': '7.50',
                      'heal_per_heal_ceiling_usd': '2.00', 'heal_proposer_provider': 'openai',
                      'heal_eval_provider': None, 'heal_judge_provider': 'grok',
                      'heal_max_iterations': '4', 'heal_runs_per_query': 2}])
    r = c(db).getHealSettings(ctx())
    assert r == {'success': True, 'settings': {
        'heal_mode': 'auto', 'heal_daily_budget_usd': 7.5, 'heal_per_heal_ceiling_usd': 2.0,
        'heal_proposer_provider': 'openai', 'heal_eval_provider': 'kimi',   # NULL -> default
        'heal_judge_provider': 'grok', 'heal_max_iterations': 4, 'heal_runs_per_query': 2}}
    assert sqls(db) == [("SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd,"
                         " heal_proposer_provider, heal_eval_provider, heal_judge_provider,"
                         " heal_max_iterations, heal_runs_per_query FROM users WHERE id = ?")]
    assert db.calls[0][1] == [3]


def test_get_heal_settings_defaults_on_missing_row_and_on_error():
    assert c(FakeDb(one=[None])).getHealSettings(ctx())['settings'] == HEAL_DEFAULTS

    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('boom')
    assert c(Boom()).getHealSettings(ctx()) == {'success': True, 'settings': HEAL_DEFAULTS}


def test_save_heal_settings_clamps_and_falls_back():
    db = FakeDb()
    r = c(db).saveHealSettings(ctx({'heal_mode': 'nope', 'heal_eval_provider': 'anthropic',
                                    'heal_proposer_provider': 'grok', 'heal_judge_provider': None,
                                    'heal_daily_budget_usd': 5000, 'heal_per_heal_ceiling_usd': -3,
                                    'heal_max_iterations': 99, 'heal_runs_per_query': 0}))
    assert r == {'success': True, 'settings': {
        'heal_mode': 'off', 'heal_daily_budget_usd': 1000.0, 'heal_per_heal_ceiling_usd': 0.0,
        'heal_proposer_provider': 'grok', 'heal_eval_provider': 'kimi', 'heal_judge_provider': 'kimi',
        'heal_max_iterations': 10, 'heal_runs_per_query': 1}}
    assert sqls(db) == [("UPDATE users SET heal_mode = ?, heal_daily_budget_usd = ?, heal_per_heal_ceiling_usd = ?,"
                         " heal_proposer_provider = ?, heal_eval_provider = ?, heal_judge_provider = ?,"
                         " heal_max_iterations = ?, heal_runs_per_query = ? WHERE id = ?")]
    assert db.calls[0][1] == ['off', 1000.0, 0.0, 'grok', 'kimi', 'kimi', 10, 1, 3]


def test_save_heal_settings_defaults_on_empty_body_and_500_on_error():
    db = FakeDb()
    assert c(db).saveHealSettings(ctx({}))['settings'] == HEAL_DEFAULTS

    class Boom(FakeDb):
        def execute(self, sql, params=None):
            raise RuntimeError('boom')
    assert c(Boom()).saveHealSettings(ctx({})) == {
        'success': False, 'error': 'Save failed', 'status_code': 500}


# ─── genesis settings (1008-1100) ──────────────────────────────────────────

GENESIS_DEFAULTS = {'genesis_mode': 'off', 'genesis_daily_budget_usd': 3.0,
                    'genesis_per_skill_ceiling_usd': 1.5, 'genesis_max_skills_per_week': 2,
                    'genesis_reflection_provider': 'kimi'}


def test_genesis_settings_auth_defaults_and_sql():
    assert c().getGenesisSettings(ctx(user_id=0))['status_code'] == 401
    assert c().saveGenesisSettings(ctx({}, user_id=0))['error'] == 'Authentication required'
    db = FakeDb(one=[{'genesis_mode': 'ask', 'genesis_daily_budget_usd': '4.00',
                      'genesis_per_skill_ceiling_usd': '2.50',
                      'genesis_max_skills_per_week': '7', 'genesis_reflection_provider': 'glm'}])
    assert c(db).getGenesisSettings(ctx()) == {'success': True, 'settings': {
        'genesis_mode': 'ask', 'genesis_daily_budget_usd': 4.0, 'genesis_per_skill_ceiling_usd': 2.5,
        'genesis_max_skills_per_week': 7, 'genesis_reflection_provider': 'glm'}}
    assert sqls(db) == [("SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,"
                         " genesis_max_skills_per_week, genesis_reflection_provider"
                         " FROM users WHERE id = ?")]
    assert c(FakeDb(one=[None])).getGenesisSettings(ctx())['settings'] == GENESIS_DEFAULTS


def test_save_genesis_settings_allowlists_and_clamps():
    db = FakeDb()
    r = c(db).saveGenesisSettings(ctx({'genesis_mode': 'suggest', 'genesis_reflection_provider': 'gamma4',
                                       'genesis_daily_budget_usd': '2.25',
                                       'genesis_per_skill_ceiling_usd': 9999,
                                       'genesis_max_skills_per_week': -4}))
    assert r['settings'] == {'genesis_mode': 'suggest', 'genesis_daily_budget_usd': 2.25,
                             'genesis_per_skill_ceiling_usd': 1000.0, 'genesis_max_skills_per_week': 0,
                             'genesis_reflection_provider': 'gamma4'}
    assert sqls(db) == [("UPDATE users SET genesis_mode = ?, genesis_daily_budget_usd = ?,"
                         " genesis_per_skill_ceiling_usd = ?, genesis_max_skills_per_week = ?,"
                         " genesis_reflection_provider = ? WHERE id = ?")]
    assert db.calls[0][1] == ['suggest', 2.25, 1000.0, 0, 'gamma4', 3]
    assert c(FakeDb()).saveGenesisSettings(ctx({'genesis_mode': 'auto'}))['settings']['genesis_mode'] == 'auto'
    assert c(FakeDb()).saveGenesisSettings(ctx({'genesis_mode': 'x'}))['settings'] == GENESIS_DEFAULTS


# ─── storage settings (1102-1264) ──────────────────────────────────────────

def test_get_storage_settings_requires_auth():
    assert c().getStorageSettings(ctx(user_id=0)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    assert c().saveStorageSettings(ctx({}, user_id=0))['status_code'] == 401


def test_get_storage_settings_passthrough_when_folder_canonical():
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'synergyAI'}])
    assert c(db).getStorageSettings(ctx()) == {
        'success': True, 'status_code': 200,
        'data': {'provider': 's3', 'folder': 'synergyAI',
                 'available_providers': ['local', 's3', 'gdrive', 'onedrive']}}
    assert sqls(db) == ["SELECT storage_provider, storage_folder FROM users WHERE id = ?"]


def test_get_storage_settings_auto_corrects_stale_folder(tmp_path, caplog):
    db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'oldName'}])
    ctl = SettingsController(db, dict(CONFIG, storage_path=str(tmp_path)))
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        r = ctl.getStorageSettings(ctx())
    assert r['data']['folder'] == 'synergyAI'
    assert sqls(db)[1] == 'UPDATE users SET storage_folder = ? WHERE id = ?'
    assert db.calls[1][1] == ['synergyAI', 3]
    assert (tmp_path / 'synergyaichatroot' / 'synergyAI').is_dir()
    assert ("[SettingsController] auto-correcting storage_folder for user 3: 'oldName' -> synergyAI"
            in [rec.getMessage() for rec in caplog.records])


def test_save_storage_settings_rejects_unknown_provider():
    assert c().saveStorageSettings(ctx({'provider': 'dropbox'})) == {
        'success': False, 'error': 'Invalid storage provider', 'status_code': 400}


def test_save_storage_settings_normalizes_folder(tmp_path, caplog):
    db = FakeDb()
    ctl = SettingsController(db, dict(CONFIG, storage_path=str(tmp_path)))
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        r = ctl.saveStorageSettings(ctx({'provider': 'local', 'folder': ' whatever '}))
    assert r == {'success': True, 'message': 'Storage settings saved', 'status_code': 200,
                 'data': {'provider': 'local', 'folder': 'synergyAI', 'folder_created': True}}
    assert sqls(db) == ["UPDATE users SET storage_provider = ?, storage_folder = ? WHERE id = ?",
                        "SELECT universalfs_api_key FROM users WHERE id = ?"]
    assert db.calls[0][1] == ['local', 'synergyAI', 3]
    assert ("[SettingsController] normalizing requested storage_folder 'whatever' -> synergyAI"
            in [rec.getMessage() for rec in caplog.records])
    # Second call finds the folder already there and still reports success.
    assert ctl.saveStorageSettings(ctx({'provider': 'local'}))['data']['folder_created'] is True


def test_save_storage_settings_defaults_provider_to_local(tmp_path):
    ctl = SettingsController(FakeDb(), dict(CONFIG, storage_path=str(tmp_path)))
    assert ctl.saveStorageSettings(ctx({}))['data']['provider'] == 'local'


def test_local_folder_path_matches_php_default_root():
    assert SettingsController.DEFAULT_STORAGE_PATH == '/Applications/XAMPP/xamppfiles/htdocs/storage'
    assert SettingsController.ROOT_FOLDER == 'synergyaichatroot'
    assert SettingsController.OFFICIAL_USER_FOLDER == 'synergyAI'


def test_ensure_local_storage_folder_reports_failure(tmp_path, caplog):
    blocker = tmp_path / 'synergyaichatroot'
    blocker.write_text('not a directory')          # mkdir() fails -> PHP returns false
    ctl = SettingsController(FakeDb(), dict(CONFIG, storage_path=str(tmp_path)))
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert ctl.ensureLocalStorageFolderExists(3, 'synergyAI') is False
    assert any('Failed to create local folder' in rec.getMessage() for rec in caplog.records)


def test_ensure_storage_folder_falls_back_to_local(tmp_path, caplog):
    """universalFS is PHP-only; the port always lands on PHP's local fallback."""
    ctl = SettingsController(FakeDb(columns=False), dict(CONFIG, storage_path=str(tmp_path)))
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert ctl.ensureStorageFolderExists(3, 's3', 'synergyAI') is True
    assert (tmp_path / 'synergyaichatroot' / 'synergyAI').is_dir()


# ─── PHP-semantics helpers ─────────────────────────────────────────────────

def test_php_floatval_matches_php_cast():
    assert php_floatval('7.5') == 7.5
    assert php_floatval('12abc') == 12.0
    assert php_floatval('abc') == 0.0
    assert php_floatval(None) == 0.0
    assert php_floatval(True) == 1.0


def test_php_json_encode_matches_php_defaults():
    assert php_json_encode({'a': 'x/y', 'b': 'é'}) == '{"a":"x\\/y","b":"\\u00e9"}'
    assert php_json_encode([1, 2]) == '[1,2]'


def test_php_array_empty_map_encodes_as_list():
    assert php_array({}) == [] and php_array({'a': 1}) == {'a': 1}
