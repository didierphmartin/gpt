"""VoiceController + DriveController unit tests — PHP-truth strings and
byte-identical SQL.

PHP source: backend/src/Controllers/VoiceController.php (18-463) and
DriveController.php (15-123).
"""
from __future__ import annotations

import httpx
import pytest
from starlette.datastructures import Headers

from app.controllers.drive_controller import DriveController
from app.controllers.voice_controller import VoiceController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None, all_=None, insert_id=1):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.insert_id = insert_id
        self.calls = []

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one.pop(0) if self.one else None

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        return 1

    def insert(self, sql, params=None):
        self.calls.append(('insert', sql, params))
        return self.insert_id


def ctx(body=None, query=None, user_id=3, method='POST', auth_type=None, app_key_scopes=None):
    c = Ctx(method=method, uri='/', headers=Headers({}), query=query or {},
            body=body if body is not None else {}, raw_body='', params={},
            user_id=user_id, authenticated=True, remote_addr='')
    if auth_type is not None:
        c['auth_type'] = auth_type
    if app_key_scopes is not None:
        c['app_key_scopes'] = app_key_scopes
    return c


def voice(db=None, config=None):
    return VoiceController(db if db is not None else FakeDb(), config if config is not None else {})


def drive(db=None, config=None):
    return DriveController(db if db is not None else FakeDb(), config if config is not None else {})


def mock(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


# ─── logUsage validation (PHP 61-142) ────────────────────────────────────────

def test_log_usage_requires_auth():
    c = voice()
    assert c.logUsage(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_log_usage_invalid_provider():
    c = voice()
    assert c.logUsage(ctx({'provider': 'openai'})) == {
        'success': False, 'error': 'Invalid or missing provider. Must be "gemini" or "grok".',
        'status_code': 400,
    }
    assert c.logUsage(ctx({})) == {
        'success': False, 'error': 'Invalid or missing provider. Must be "gemini" or "grok".',
        'status_code': 400,
    }


def test_log_usage_requires_positive_audio_seconds():
    c = voice()
    assert c.logUsage(ctx({'provider': 'grok', 'audio_input_seconds': 0, 'audio_output_seconds': 0})) == {
        'success': False,
        'error': 'At least one of audio_input_seconds or audio_output_seconds must be > 0',
        'status_code': 400,
    }
    assert c.logUsage(ctx({'provider': 'grok', 'audio_input_seconds': -1})) == {
        'success': False,
        'error': 'At least one of audio_input_seconds or audio_output_seconds must be > 0',
        'status_code': 400,
    }


def test_log_usage_success_logs_transaction_and_computes_cost():
    db = FakeDb(insert_id=42)
    c = voice(db)
    result = c.logUsage(ctx({
        'provider': 'grok', 'audio_input_seconds': 10, 'audio_output_seconds': 5,
        'session_id': 's1',
    }, user_id=3))
    assert result['success'] is True
    assert result['transaction_id'] == 42
    assert result['provider'] == 'grok'
    assert result['model'] == 'grok-2-voice'  # getDefaultVoiceModel
    assert result['audio_input_seconds'] == 10.0
    assert result['audio_output_seconds'] == 5.0
    assert result['audio_duration_seconds'] == 15.0
    assert result['cost_usd'] == round(10 * 0.0004 + 5 * 0.0008, 6)
    assert result['status_code'] == 200

    inserts = [c for c in db.calls if c[0] == 'insert']
    assert len(inserts) == 1
    _, sql, params = inserts[0]
    assert 'INSERT INTO llm_usage_transactions' in sql
    assert params[':user_id'] == 3
    assert params[':provider'] == 'grok'
    assert params[':is_voice_request'] == 1
    assert params[':audio_input_seconds'] == 10.0
    assert params[':audio_output_seconds'] == 5.0


def test_log_usage_explicit_model_overrides_default():
    c = voice(FakeDb())
    result = c.logUsage(ctx({'provider': 'gemini', 'model': 'custom-model', 'audio_input_seconds': 1}))
    assert result['model'] == 'custom-model'


# ─── getStats (PHP 147-235) — SQL byte-identical ────────────────────────────

def test_get_stats_requires_auth():
    c = voice()
    assert c.getStats(ctx(user_id=None, method='GET')) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401,
    }


def test_get_stats_default_period_month_sql_and_shape():
    db = FakeDb(one=[{
        'total_voice_requests': 5, 'total_audio_seconds': 12.345, 'total_input_seconds': 8.1,
        'total_output_seconds': 4.245, 'total_cost': 0.0012345, 'avg_session_seconds': 2.469,
    }], all_=[[
        {'provider': 'grok', 'requests': 3, 'audio_seconds': 9.0, 'cost': 0.0008},
        {'provider': 'gemini', 'requests': 2, 'audio_seconds': 3.345, 'cost': 0.0004345},
    ]])
    c = voice(db)
    result = c.getStats(ctx(query={}, user_id=3, method='GET'))

    assert result['success'] is True
    assert result['period'] == 'month'
    # round(0.0012345, 6): Python's float round() (usage_logger.py's own
    # round(cost, 6) precedent — not number_format, so no Decimal/half-up
    # treatment) lands on 0.001234 here due to IEEE-754 representation.
    assert result['stats'] == {
        'total_voice_requests': 5, 'total_audio_seconds': 12.35, 'total_input_seconds': 8.1,
        'total_output_seconds': 4.25, 'total_cost': 0.001234, 'avg_session_seconds': 2.47,
    }
    assert result['by_provider'] == [
        {'provider': 'grok', 'requests': 3, 'audio_seconds': 9.0, 'cost': 0.0008},
        {'provider': 'gemini', 'requests': 2, 'audio_seconds': 3.35, 'cost': 0.000434},
    ]
    assert result['status_code'] == 200

    fetch_ones = [c for c in db.calls if c[0] == 'fetch_one']
    sql, params = fetch_ones[0][1], fetch_ones[0][2]
    assert sql == (
        "SELECT\n"
        "                COUNT(*) as total_voice_requests,\n"
        "                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,\n"
        "                COALESCE(SUM(audio_input_seconds), 0) as total_input_seconds,\n"
        "                COALESCE(SUM(audio_output_seconds), 0) as total_output_seconds,\n"
        "                COALESCE(SUM(cost_usd), 0) as total_cost,\n"
        "                COALESCE(AVG(audio_duration_seconds), 0) as avg_session_seconds\n"
        "            FROM llm_usage_transactions\n"
        "            WHERE user_id = :user_id\n"
        "                AND is_voice_request = 1\n"
        "                AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)"
    )
    assert params == {':user_id': 3}

    fetch_alls = [c for c in db.calls if c[0] == 'fetch_all']
    bsql, bparams = fetch_alls[0][1], fetch_alls[0][2]
    assert bsql == (
        "SELECT\n"
        "                provider,\n"
        "                COUNT(*) as requests,\n"
        "                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,\n"
        "                COALESCE(SUM(cost_usd), 0) as cost\n"
        "            FROM llm_usage_transactions\n"
        "            WHERE user_id = :user_id\n"
        "                AND is_voice_request = 1\n"
        "                AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)\n"
        "            GROUP BY provider"
    )
    assert bparams == {':user_id': 3}


def test_get_stats_period_and_provider_filter_sql():
    db = FakeDb(one=[{}], all_=[[]])
    c = voice(db)
    c.getStats(ctx(query={'period': 'week', 'provider': 'grok'}, user_id=3, method='GET'))
    fetch_ones = [c for c in db.calls if c[0] == 'fetch_one']
    sql, params = fetch_ones[0][1], fetch_ones[0][2]
    assert "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)" in sql
    assert sql.endswith(" AND provider = :provider")
    assert params == {':user_id': 3, ':provider': 'grok'}


@pytest.mark.parametrize('period,expected', [
    ('day', 'AND DATE(created_at) = CURDATE()'),
    ('week', 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)'),
    ('month', 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'),
    ('year', 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)'),
    ('all', ''),
    ('bogus', 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'),
])
def test_get_date_condition(period, expected):
    assert voice().getDateCondition(period) == expected


@pytest.mark.parametrize('provider,expected', [
    ('gemini', 'gemini-2.5-flash-native-audio-preview'),
    ('grok', 'grok-2-voice'),
    ('other', 'other-voice'),
])
def test_get_default_voice_model(provider, expected):
    assert voice().getDefaultVoiceModel(provider) == expected


# ─── getEphemeralToken validation (PHP 282-312) ─────────────────────────────

def test_get_ephemeral_token_rejects_non_grok_provider():
    c = voice()
    assert c.getEphemeralToken(ctx({'provider': 'gemini'})) == {
        'success': False,
        'error': 'Ephemeral tokens are currently only supported for Grok provider',
        'status_code': 400,
    }


def test_get_ephemeral_token_no_api_key_configured():
    c = voice(config={'grok_voice': {}})
    result = c.getEphemeralToken(ctx({'provider': 'grok'}))
    assert result == {
        'success': False, 'error': 'Grok voice API key not configured on server', 'status_code': 500,
    }


def test_get_ephemeral_token_default_provider_is_grok_and_missing_key():
    c = voice(config={})
    result = c.getEphemeralToken(ctx({}))
    assert result == {
        'success': False, 'error': 'Grok voice API key not configured on server', 'status_code': 500,
    }


# ─── generateGrokEphemeralToken via httpx.MockTransport (PHP 317-398) ───────

def test_generate_grok_token_success(monkeypatch):
    seen = {}

    def handler(req):
        seen['headers'] = dict(req.headers)
        seen['url'] = str(req.url)
        return httpx.Response(200, json={
            'client_secret': {'value': 'xai-secret-abc', 'expires_at': '2026-01-01T00:00:00Z'},
        })

    c = voice(config={'grok_voice': {'api_key': 'K', 'default_voice': 'Rex'}})
    monkeypatch.setattr(c, 'getHttpClient', lambda: mock(handler))
    result = c.generateGrokEphemeralToken('3')

    assert result == {
        'success': True, 'provider': 'grok', 'client_secret': 'xai-secret-abc',
        'expires_at': '2026-01-01T00:00:00Z', 'voice': 'Rex', 'status_code': 200,
    }
    assert seen['headers']['authorization'] == 'Bearer K'
    assert seen['url'] == 'https://api.x.ai/v1/realtime/client_secrets'


def test_generate_grok_token_flat_value_shape(monkeypatch):
    def handler(req):
        return httpx.Response(200, json={'value': 'flat-secret'})

    c = voice(config={'grok_voice': {'api_key': 'K'}})
    monkeypatch.setattr(c, 'getHttpClient', lambda: mock(handler))
    result = c.generateGrokEphemeralToken(None)
    assert result['success'] is True
    assert result['client_secret'] == 'flat-secret'
    assert result['voice'] == 'Aria'  # default fallback


def test_generate_grok_token_xai_error_status(monkeypatch):
    def handler(req):
        return httpx.Response(401, json={'error': {'message': 'invalid api key'}})

    c = voice(config={'grok_voice': {'api_key': 'BAD'}})
    monkeypatch.setattr(c, 'getHttpClient', lambda: mock(handler))
    result = c.generateGrokEphemeralToken(None)
    assert result == {
        'success': False, 'error': 'Failed to obtain ephemeral token: invalid api key', 'status_code': 401,
    }


def test_generate_grok_token_no_secret_in_response(monkeypatch):
    def handler(req):
        return httpx.Response(200, json={'client_secret': {}})

    c = voice(config={'grok_voice': {'api_key': 'K'}})
    monkeypatch.setattr(c, 'getHttpClient', lambda: mock(handler))
    result = c.generateGrokEphemeralToken(None)
    assert result == {
        'success': False, 'error': 'Invalid response from xAI API - no secret returned', 'status_code': 500,
    }


def test_generate_grok_token_network_failure(monkeypatch):
    def boom(req):
        raise httpx.ConnectError('refused', request=req)

    c = voice(config={'grok_voice': {'api_key': 'K'}})
    monkeypatch.setattr(c, 'getHttpClient', lambda: mock(boom))
    result = c.generateGrokEphemeralToken(None)
    assert result == {
        'success': False, 'error': 'Network error while obtaining ephemeral token', 'status_code': 503,
    }


def test_generate_grok_token_closes_client(monkeypatch):
    client_holder = {}

    def handler(req):
        return httpx.Response(200, json={'value': 's'})

    def make():
        client = mock(handler)
        client_holder['client'] = client
        return client

    c = voice(config={'grok_voice': {'api_key': 'K'}})
    monkeypatch.setattr(c, 'getHttpClient', make)
    c.generateGrokEphemeralToken(None)
    assert client_holder['client'].is_closed


# ─── getConfig (PHP 406-462) ──────────────────────────────────────────────────

def test_get_config_grok_default_shape():
    c = voice(config={})
    result = c.getConfig(ctx(query={}, method='GET'))
    assert result['success'] is True
    cfg = result['config']
    assert cfg['provider'] == 'grok'
    assert cfg['voices'] == ['Eve', 'Ara', 'Rex', 'Sal', 'Leo']
    assert cfg['default_voice'] == 'Eve'
    assert cfg['supports_ephemeral_token'] is True
    assert cfg['websocket_url'] == 'wss://api.x.ai/v1/realtime'
    assert 'api_key' not in cfg
    assert result['status_code'] == 200


def test_get_config_unknown_provider():
    c = voice()
    assert c.getConfig(ctx(query={'provider': 'bogus'}, method='GET')) == {
        'success': False, 'error': 'Unknown voice provider', 'status_code': 400,
    }


def test_get_config_gemini_jwt_user_gets_api_key():
    c = voice(config={'gemini_voice': {'api_key': 'GEMKEY', 'default_voice': 'Puck', 'model': 'm1'}})
    result = c.getConfig(ctx(query={'provider': 'gemini'}, method='GET', auth_type='jwt'))
    assert result['config']['api_key'] == 'GEMKEY'
    assert result['config']['default_voice'] == 'Puck'
    assert result['config']['model'] == 'm1'
    assert result['config']['supports_ephemeral_token'] is False


def test_get_config_gemini_app_key_without_scope_hides_key():
    c = voice(config={'gemini_voice': {'api_key': 'GEMKEY'}})
    result = c.getConfig(ctx(query={'provider': 'gemini'}, method='GET', auth_type='app_key', app_key_scopes=['other:scope']))
    assert 'api_key' not in result['config']


def test_get_config_gemini_app_key_with_scope_gets_key():
    c = voice(config={'gemini_voice': {'api_key': 'GEMKEY'}})
    result = c.getConfig(ctx(query={'provider': 'gemini'}, method='GET', auth_type='app_key', app_key_scopes=['voice:config']))
    assert result['config']['api_key'] == 'GEMKEY'


# ─── DriveController.save (PHP 32-49) — exact static payload ───────────────

def test_drive_save_returns_exact_not_implemented_payload():
    c = drive()
    assert c.save(ctx({'prompt': 'x', 'response': 'y'})) == {
        'success': False,
        'message': 'Google Drive integration not yet implemented',
        'details': {
            'status': 'pending',
            'required_steps': [
                'User authentication system',
                'Google OAuth setup',
                'Database configuration',
                'GoogleDriveService integration',
            ],
            'documentation': 'See GOOGLE_DRIVE_INTEGRATION.md for details',
        },
        'status_code': 501,
    }


def test_drive_save_ignores_request_content():
    c = drive()
    # Static payload regardless of body/auth — PHP never reads $request.
    assert c.save(ctx({}, user_id=None)) == c.save(ctx({'anything': 'goes'}, user_id=99))
