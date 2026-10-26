"""Port of backend/tests/Unit/Controllers/GeminiVoiceTokenTest.php.

The Gemini voice key is found like every other key and never reaches the browser."""
from __future__ import annotations

import base64
import hashlib
import json
import os

import httpx
import pytest

from app.controllers.voice_controller import VoiceController
from app.support.crypto import aes256cbc_encrypt
from tests.unit.playbook.conftest import SqliteDb, sqlite_db

SECRET = 'test-secret-0123456789-0123456789'


class _Db(SqliteDb):
    """applyDbSettings asks MySQL's SHOW TABLES; answer it from sqlite_master."""

    def fetch_all(self, sql, params=None):
        if sql.startswith('SHOW TABLES LIKE '):
            return super().fetch_all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                                     [sql.split("'")[1]])
        return super().fetch_all(sql, params)


def encrypt(plain: str) -> str:
    """ApiKeyCrypto::encrypt (SettingsController.encryptApiKey in Python)."""
    iv = os.urandom(16)
    return base64.b64encode(iv + aes256cbc_encrypt(plain.encode(), hashlib.sha256(SECRET.encode()).digest(), iv)).decode()


@pytest.fixture
def db():
    d = _Db(sqlite_db(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)',
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)',
        'CREATE TABLE user_api_keys (id INTEGER PRIMARY KEY, user_id INTEGER, provider TEXT, api_key TEXT, base_url TEXT,'
        ' enabled INTEGER DEFAULT 1)',
        'CREATE TABLE system_llm_settings (provider_key TEXT, api_key TEXT, enabled INTEGER)').conn)
    d.execute("INSERT INTO users VALUES (1, 'u@x.test', 'user'), (2, 'n@x.test', 'nogemini')")
    for role, providers in (('user', {'gemini': {'enabled': True}}), ('nogemini', {'claude': {'enabled': True}})):
        d.execute('INSERT OR REPLACE INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)',
                  [role, role, json.dumps({'providers': providers})])
    return d


@pytest.fixture
def sent():
    return []


@pytest.fixture
def voice(db, sent):
    def make(responses=(), env_key=''):
        queue = list(responses)

        def handler(req):
            sent.append(req)
            return queue.pop(0)

        c = VoiceController(db, {'auth': {'jwt_secret': SECRET}, 'gemini_voice': {'api_key': env_key}})
        c.getHttpClient = lambda: httpx.Client(transport=httpx.MockTransport(handler))
        return c
    return make


def token():
    return httpx.Response(200, json={'name': 'auth_tokens/abc'})


def test_config_says_whether_a_key_exists_and_never_gives_it(voice):
    r = voice((), 'env-key').getConfig({'user_id': 1, 'query': {'provider': 'gemini'}})
    assert r['config']['available'] is True
    assert 'env-key' not in json.dumps(r)
    assert 'api_key' not in r['config']

    assert voice().getConfig({'user_id': 1, 'query': {'provider': 'gemini'}})['config']['available'] is False
    assert voice((), 'env-key').getConfig({'query': {'provider': 'gemini'}})['config']['available'] is False


def test_package_without_gemini_has_no_voice_key(voice, sent):
    assert voice((), 'env-key').getConfig({'user_id': 2, 'query': {'provider': 'gemini'}})['config']['available'] is False
    r = voice((), 'env-key').getEphemeralToken({'user_id': 2, 'body': {'provider': 'gemini'}})
    assert r['code'] == 'NO_GEMINI_KEY'
    assert r['status_code'] == 404
    assert sent == []


def test_token_is_minted_with_the_users_own_key_in_a_header(db, voice, sent):
    db.execute("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)")
    db.execute("INSERT INTO user_api_keys (user_id, provider, api_key) VALUES (1, 'gemini', ?)", [encrypt('own-key')])

    r = voice([token()], 'env-key').getEphemeralToken({'user_id': 1, 'body': {'provider': 'gemini'}})

    assert r['success'] is True
    assert r['client_secret'] == 'auth_tokens/abc'
    req = sent[0]
    assert str(req.url) == 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens'
    assert req.headers['x-goog-api-key'] == 'own-key'
    assert 'key' not in req.url.query.decode()
    assert json.loads(req.content)['uses'] == 1


def test_admin_key_then_server_key(db, voice, sent):
    db.execute("INSERT INTO system_llm_settings VALUES ('gemini', 'admin-key', 1)")
    voice([token()], 'env-key').getEphemeralToken({'user_id': 1, 'body': {'provider': 'gemini'}})
    assert sent[0].headers['x-goog-api-key'] == 'admin-key'

    db.execute('DELETE FROM system_llm_settings')
    voice([token()], 'env-key').getEphemeralToken({'user_id': 1, 'body': {'provider': 'gemini'}})
    assert sent[1].headers['x-goog-api-key'] == 'env-key'


def test_signed_out_gets_no_token(voice, sent):
    r = voice((), 'env-key').getEphemeralToken({'body': {'provider': 'gemini'}})
    assert r['status_code'] == 401
    assert sent == []


def test_google_refusal_never_echoes_the_key(voice):
    r = voice([httpx.Response(400, json={'error': {'message': 'API key not valid'}})], 'env-key') \
        .getEphemeralToken({'user_id': 1, 'body': {'provider': 'gemini'}})
    assert r['success'] is False
    assert r['status_code'] == 400
    assert 'env-key' not in json.dumps(r)


def test_unknown_voice_provider(voice):
    assert voice().getEphemeralToken({'user_id': 1, 'body': {'provider': 'bogus'}}) == {
        'success': False, 'error': 'Unknown voice provider', 'status_code': 400}
