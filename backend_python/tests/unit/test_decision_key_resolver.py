"""Port of backend/tests/Unit/DecisionKeyResolverTest.php (in-memory SQLite, no MySQL).

Decision providers are router rows (api_format 'router') naming a registered protocol. Several rows may
share a protocol (jev, jev-eu).
"""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.jev_router import JevRouter
from app.services.decision_key_resolver import DecisionKeyResolver
from app.services.decision_providers import DecisionProviders
from tests.unit.decision_fakes import encrypt_key
from tests.unit.playbook.conftest import sqlite_db

SECRET = 'decision-test-secret'
CONFIG = {'auth': {'jwt_secret': SECRET}}

LLM_DDL = ("CREATE TABLE system_llm_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_key TEXT NOT NULL UNIQUE, "
           "display_name TEXT NOT NULL, api_key TEXT, model TEXT NOT NULL, base_url TEXT, chat_endpoint TEXT, "
           "api_format TEXT DEFAULT 'openai', protocol TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, "
           "price_input_per_1m REAL, price_output_per_1m REAL, streaming INTEGER, supports_tools INTEGER, "
           "max_tokens INTEGER, temperature REAL, supported_models TEXT, system_prompt TEXT, created_at TEXT, updated_at TEXT)")
KEYS_DDL = ('CREATE TABLE user_api_keys (user_id INTEGER NOT NULL, provider TEXT NOT NULL, api_key TEXT NOT NULL, '
            'base_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, provider))')
PACKAGES_DDL = 'CREATE TABLE packages (role TEXT PRIMARY KEY, capabilities TEXT, updated_at TEXT)'


def schema():
    db = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)', LLM_DDL, KEYS_DDL, PACKAGES_DDL)
    db.execute("INSERT INTO users (id, email, role) VALUES (2, 'u@test', 'user')")
    db.execute("INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, api_format, sort_order) "
               "VALUES ('claude', 'Claude', 'sk-c', 'claude-x', 'anthropic', 0)")
    return db


@pytest.fixture
def db():
    return schema()


def row(db, key, apiKey='', protocol='typesafe', sort=100, enabled=1, url=None, label=''):
    db.execute("INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, api_format, "
               "protocol, enabled, sort_order) VALUES (?, ?, ?, 'jev-latest', ?, 'router', ?, ?, ?)",
               [key, label if label != '' else key[:1].upper() + key[1:], apiKey, url, protocol, enabled, sort])


def allow(db, entries):
    db.execute('INSERT INTO packages (role, capabilities) VALUES (?, ?)', ['user', json.dumps({'providers': entries})])


def user_key(db, provider, key, url=None):
    db.execute('INSERT INTO user_api_keys (user_id, provider, api_key, base_url) VALUES (2, ?, ?, ?)',
               [provider, encrypt_key(key, SECRET), url])


def test_rows_are_router_rows_in_admin_order(db):
    row(db, 'jev', sort=100)
    row(db, 'acme', sort=50)
    row(db, 'off', enabled=0, sort=10)
    assert [r['provider_key'] for r in DecisionProviders.rows(db)] == ['acme', 'jev']
    assert DecisionProviders.keys(db) == ['off', 'acme', 'jev']


def test_row_finds_an_enabled_row_only(db):
    row(db, 'jev')
    row(db, 'off', enabled=0)
    assert DecisionProviders.row(db, 'jev')['provider_key'] == 'jev'
    assert DecisionProviders.row(db, 'off') is None
    assert DecisionProviders.row(db, 'claude') is None, 'a chat row is never a decision provider'


def test_env_stem_sanitises():
    assert DecisionProviders.envStem('jev') == 'JEV'
    assert DecisionProviders.envStem('jev-eu') == 'JEV_EU'
    assert DecisionProviders.envStem('acme.v2') == 'ACME_V2'


def test_an_install_without_the_table_reads_no_rows(db, monkeypatch):
    from app.services import decision_providers
    monkeypatch.setattr(decision_providers, 'error_log', lambda m: None)
    db.execute('DROP TABLE system_llm_settings')
    assert DecisionProviders.rows(db) == []


def test_each_provider_resolves_its_own_key(db):
    row(db, 'jev', 'jev-global')
    row(db, 'acme', 'acme-global')
    allow(db, {'jev': {'enabled': True}, 'acme': {'enabled': True}})
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'jev')['key'] == 'jev-global'
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')['key'] == 'acme-global'


def test_precedence_is_user_then_package_then_global(db):
    row(db, 'acme', 'acme-global')
    allow(db, {'acme': {'enabled': True, 'default_api_key': 'acme-package'}})
    r = DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')
    assert [r['key'], r['source']] == ['acme-package', 'package']
    user_key(db, 'acme', 'acme-mine')
    r = DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')
    assert r['key'] == 'acme-mine'
    assert r['source'] == 'user'


def test_the_url_is_the_paired_one(db):
    row(db, 'acme', 'acme-global', url='https://gw.corp/acme')
    allow(db, {'acme': {'enabled': True}})
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')['url'] == 'https://gw.corp/acme'
    # The user's URL goes with the user's own key only.
    user_key(db, 'acme', 'acme-mine', 'https://mine.example/acme')
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')['url'] == 'https://mine.example/acme'
    db.execute("UPDATE user_api_keys SET api_key = '' WHERE provider = 'acme'")
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')['url'] == 'https://gw.corp/acme'


def test_no_row_url_is_the_protocol_default(db):
    row(db, 'jev', 'k')
    allow(db, {'jev': {'enabled': True}})
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'jev')['url'] == JevRouter.URL


def test_a_row_without_protocol_is_unknown(db):
    row(db, 'jev', 'k', protocol=None)
    allow(db, {'jev': {'enabled': True}})
    r = DecisionKeyResolver.resolve(db, CONFIG, 2, 'jev')
    assert r['source'] == 'unknown'
    assert r['key'] == ''
    assert DecisionKeyResolver.unavailableReason(r, 'jev') == "'jev' is not an available decision provider"


def test_a_deleted_or_disabled_provider_is_unknown(db):
    row(db, 'off', 'k', enabled=0)
    allow(db, {'off': {'enabled': True}})
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'off')['source'] == 'unknown'
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'gone')['source'] == 'unknown'


def test_the_plan_decides_per_provider(db):
    row(db, 'jev', 'k1')
    row(db, 'acme', 'k2', label='Acme Router')
    allow(db, {'jev': {'enabled': True}})   # acme missing from the allowlist
    r = DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')
    assert r['source'] == 'not_allowed'
    assert DecisionKeyResolver.unavailableReason(r, 'acme') == 'Acme Router is not enabled for your plan'
    assert DecisionKeyResolver.resolve(db, CONFIG, 2, 'jev')['row']['provider_key'] == 'jev'


def test_no_key_anywhere_is_none(db):
    row(db, 'acme', '', label='Acme')
    allow(db, {'acme': {'enabled': True}})
    r = DecisionKeyResolver.resolve(db, CONFIG, 2, 'acme')
    assert r['source'] == 'none'
    assert DecisionKeyResolver.unavailableReason(r, 'acme') == 'no Acme key'


def test_the_default_is_the_first_allowed_row_in_admin_order(db):
    row(db, 'jev', 'k', sort=100)
    row(db, 'acme', 'k', sort=50)
    row(db, 'broken', 'k', protocol=None, sort=10)
    allow(db, {'jev': {'enabled': True}, 'broken': {'enabled': True}})
    assert DecisionKeyResolver.defaultProvider(db, 2) == 'jev', 'acme not in plan, broken has no protocol'


def test_no_allowed_row_means_no_default(db):
    row(db, 'jev', 'k')
    allow(db, {'claude': {'enabled': True}})
    assert DecisionKeyResolver.defaultProvider(db, 2) is None


def test_a_package_without_an_allowlist_allows_every_provider(db):
    row(db, 'acme', 'k')
    db.execute('INSERT INTO packages (role, capabilities) VALUES (?, ?)', ['user', json.dumps([])])
    assert DecisionKeyResolver.allowed(db, 2, 'acme') is True
