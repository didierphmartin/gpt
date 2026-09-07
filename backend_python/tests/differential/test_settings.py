"""SettingsController PHP-vs-Python differential (live DB, no LLM calls).

Every case runs the PHP request first (so PHP's on-demand DDL lands before Python
looks at the schema) and leaves user 3's rows exactly as it found them.
"""
import json
import os
import pathlib

import pytest

from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential

SCRATCH = pathlib.Path(os.environ.get(
    'DIFF_SCRATCH', '/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/'
                    'af5a0c64-94e5-485e-831a-9a3948b5fcfc/scratchpad'))

KEY_COLUMNS = 'user_id, provider, api_key, system_prompt, created_at, updated_at'
MODEL_COLUMNS = 'user_id, provider, model, updated_at'


@pytest.fixture
def h(token):
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture
def keys_snapshot(config):
    """Snapshot user 3's key/model rows and put them back byte-for-byte.

    `clearKeys` (SettingsController.php:414) has no provider filter — it wipes
    every `user_api_keys` and `user_model_selections` row for the user — so the
    only way to exercise it against the live user without data loss is an exact
    restore (which also re-writes created_at/updated_at, bypassing the column's
    ON UPDATE CURRENT_TIMESTAMP).
    """
    from app.db import open_primary
    db = open_primary(config)
    keys = db.fetch_all(f'SELECT {KEY_COLUMNS} FROM user_api_keys WHERE user_id = ?', [DIFF_USER_ID])
    models = db.fetch_all(f'SELECT {MODEL_COLUMNS} FROM user_model_selections WHERE user_id = ?', [DIFF_USER_ID])
    assert keys, 'expected user 3 to have API-key rows to snapshot'

    SCRATCH.mkdir(parents=True, exist_ok=True)
    (SCRATCH / f'user_api_keys_backup_{DIFF_USER_ID}.json').write_text(
        json.dumps({'keys': keys, 'models': models}, indent=2))

    class Snapshot:
        def restore(self):
            db.execute('DELETE FROM user_api_keys WHERE user_id = ?', [DIFF_USER_ID])
            for r in keys:
                db.execute(
                    f'INSERT INTO user_api_keys ({KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)',
                    [r['user_id'], r['provider'], r['api_key'], r['system_prompt'],
                     r['created_at'], r['updated_at']])
            db.execute('DELETE FROM user_model_selections WHERE user_id = ?', [DIFF_USER_ID])
            for r in models:
                db.execute(
                    f'INSERT INTO user_model_selections ({MODEL_COLUMNS}) VALUES (?, ?, ?, ?)',
                    [r['user_id'], r['provider'], r['model'], r['updated_at']])

    snap = Snapshot()
    try:
        yield snap
    finally:
        snap.restore()
        db.close()


# ─── reads ─────────────────────────────────────────────────────────────────

def test_settings_reads_are_identical(both):
    same(*both('GET', '/api/v1/settings/phone'))
    same(*both('GET', '/api/v1/settings/usage'))
    same(*both('GET', '/api/v1/settings/keys'))
    same(*both('GET', '/api/v1/settings/providers'))
    same(*both('GET', '/api/v1/settings/heal'))
    same(*both('GET', '/api/v1/settings/genesis'))
    # PHP runs first and may ALTER `users` to add the storage columns.
    same(*both('GET', '/api/v1/settings/storage'))


def test_settings_require_auth(both):
    for path in ('/api/v1/settings/keys', '/api/v1/settings/providers', '/api/v1/settings/heal',
                 '/api/v1/settings/genesis', '/api/v1/settings/storage', '/api/v1/settings/phone',
                 '/api/v1/settings/usage'):
        same(*both('GET', path, auth=False))


# ─── validation (no writes) ────────────────────────────────────────────────

def test_save_keys_validation(both):
    same(*both('POST', '/api/v1/settings/keys', json={}))
    same(*both('POST', '/api/v1/settings/keys', json={'keys': {}, 'models': {}, 'system_prompts': {}}))
    # Unknown provider / blank key are skipped, not rejected — counts must agree.
    same(*both('POST', '/api/v1/settings/keys', json={'keys': {'not-a-provider': 'x', 'kimi': '   '}}))


def test_provider_validation(both):
    same(*both('POST', '/api/v1/settings/provider', json={}))
    same(*both('POST', '/api/v1/settings/provider', json={'category': 'nope', 'provider': 'did'}))
    # 'deepseek' is an LLM provider, not an avatar/voice one (validAvatarProviders 522,
    # validVoiceProviders 523) — both categories reject it.
    same(*both('POST', '/api/v1/settings/provider', json={'category': 'voice', 'provider': 'deepseek'}))
    same(*both('POST', '/api/v1/settings/provider', json={'category': 'avatar', 'provider': 'deepseek'}))
    same(*both('POST', '/api/v1/settings/provider/active', json={'category': 'x', 'provider': 'grok'}))
    same(*both('POST', '/api/v1/settings/provider/active', json={'category': 'voice'}))
    same(*both('POST', '/api/v1/settings/provider/active',
               json={'category': 'avatar', 'provider': 'no-such-provider'}))
    same(*both('DELETE', '/api/v1/settings/provider', json={'category': 'x', 'provider': 'grok'}))
    same(*both('DELETE', '/api/v1/settings/provider', json={'category': 'voice', 'provider': ''}))


def test_storage_validation(both):
    same(*both('POST', '/api/v1/settings/storage', json={'provider': 'dropbox', 'folder': 'synergyAI'}))


# ─── round-trips (current values written back) ─────────────────────────────

def test_heal_round_trip(php, py, h):
    pre = php.get('/api/v1/settings/heal', headers=h).json()
    assert pre == py.get('/api/v1/settings/heal', headers=h).json()
    for client in (php, py):
        assert client.post('/api/v1/settings/heal', json=pre['settings'], headers=h).json() == pre
        assert php.get('/api/v1/settings/heal', headers=h).json() == pre
        assert py.get('/api/v1/settings/heal', headers=h).json() == pre


def test_genesis_round_trip(php, py, h):
    pre = php.get('/api/v1/settings/genesis', headers=h).json()
    assert pre == py.get('/api/v1/settings/genesis', headers=h).json()
    for client in (php, py):
        assert client.post('/api/v1/settings/genesis', json=pre['settings'], headers=h).json() == pre
        assert php.get('/api/v1/settings/genesis', headers=h).json() == pre
        assert py.get('/api/v1/settings/genesis', headers=h).json() == pre


def test_provider_settings_round_trip(php, py, h):
    """`deepseek` from the brief is not an avatar/voice provider (rejected above);
    `voice`/`grok` is the configured row this exercises instead."""
    pre = php.get('/api/v1/settings/providers', headers=h).json()
    assert pre == py.get('/api/v1/settings/providers', headers=h).json()
    current = pre['voice']['providers']['grok']['settings']
    for client in (php, py):
        r = client.post('/api/v1/settings/provider',
                        json={'category': 'voice', 'provider': 'grok', 'settings': current}, headers=h)
        assert r.json() == {'success': True, 'message': "Provider 'grok' saved for voice"}, r.text
        assert php.get('/api/v1/settings/providers', headers=h).json() == pre
        assert py.get('/api/v1/settings/providers', headers=h).json() == pre


def test_storage_settings_read_is_stable(php, py, h):
    pre = php.get('/api/v1/settings/storage', headers=h).json()
    assert pre == py.get('/api/v1/settings/storage', headers=h).json()
    assert pre['data']['folder'] == 'synergyAI'


# ─── cross-backend encryption interop ──────────────────────────────────────

def _assert_pre_state(php, py, h, pre_php, pre_py):
    assert php.get('/api/v1/settings/keys', headers=h).json() == pre_php
    assert py.get('/api/v1/settings/keys', headers=h).json() == pre_py


@pytest.mark.parametrize('writer,reader', [('php', 'py'), ('py', 'php')])
def test_keys_save_read_clear_across_backends(php, py, h, keys_snapshot, writer, reader):
    """A key encrypted by one backend must decrypt on the other (same key derivation,
    IV layout and base64 framing as SettingsController.php:841-863)."""
    clients = {'php': php, 'py': py}
    w, r = clients[writer], clients[reader]

    pre_php = php.get('/api/v1/settings/keys', headers=h).json()
    pre_py = py.get('/api/v1/settings/keys', headers=h).json()
    assert pre_php == pre_py

    saved = w.post('/api/v1/settings/keys',
                   json={'keys': {'grok': 'differential-test-key'}}, headers=h).json()
    assert saved['saved_count'] == 1, saved

    seen = r.get('/api/v1/settings/keys', headers=h).json()
    assert seen['keys']['grok']['has_custom_key'] is True
    assert seen['keys']['grok']['masked_key'] == '****-key'
    assert seen == w.get('/api/v1/settings/keys', headers=h).json()

    cleared = r.request('DELETE', '/api/v1/settings/keys', headers=h).json()
    assert cleared['success'] is True and cleared['deleted_count'] > 0, cleared
    # PHP json_encodes the now-empty key map as [], and so does the port.
    assert php.get('/api/v1/settings/keys', headers=h).json()['keys'] == []
    assert py.get('/api/v1/settings/keys', headers=h).json()['keys'] == []
    assert php.get('/api/v1/settings/keys', headers=h).json() == py.get('/api/v1/settings/keys', headers=h).json()

    keys_snapshot.restore()
    _assert_pre_state(php, py, h, pre_php, pre_py)
