"""SystemSettingsController PHP-vs-Python differential (live DB, admin user 3).

PHP source: backend/src/Controllers/SystemSettingsController.php (18-728).
Routes: backend/src/routes.php:249-254.

`system_llm_settings` is a single SHARED table — PHP and Python both operate
on the exact same rows (no per-backend duplication like user-scoped tables),
so every mutation here is self-cleaning: round-trips restore the row to
exactly what they found (ignoring `updated_at`, which legitimately advances
on every UPDATE regardless of backend).

Live-checked before writing this file (2026-09-07): user 3 has role='admin',
`system_llm_settings` already has both `price_input_per_1m`/
`price_output_per_1m` columns, a `kimi` row exists and is enabled, and the
runtime config (`app/config.py`, a hand-written mirror of
backend/config/ai_config.php) carries no top-level provider blocks and no
`providers` array post the 2026-05 cutover to DB-backed settings (see
app/services/llm_provider_resolver.py's module docstring) — so
`seedFromConfig` seeds nothing on either backend and is safe to call for
real against the live table.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential

SAVE_FIELDS = (
    'provider_key', 'display_name', 'api_key', 'model', 'base_url', 'max_tokens',
    'temperature', 'price_input_per_1m', 'price_output_per_1m', 'chat_endpoint',
    'streaming', 'supports_tools', 'supported_models', 'api_format', 'system_prompt',
    'enabled', 'sort_order',
)


@pytest.fixture
def h(token):
    return {'Authorization': f'Bearer {token}'}


# ─── reads (no side effects) ────────────────────────────────────────────

def test_admin_llm_settings_reads_are_identical(both):
    same(*both('GET', '/api/v1/admin/llm-settings'))
    same(*both('GET', '/api/v1/admin/llm-settings/kimi'))


def test_admin_llm_settings_require_auth(both):
    same(*both('GET', '/api/v1/admin/llm-settings', auth=False))
    same(*both('GET', '/api/v1/admin/llm-settings/kimi', auth=False))


def test_admin_llm_settings_unknown_provider_404(both):
    same(*both('GET', '/api/v1/admin/llm-settings/no-such-provider-xyz'))


# ─── validation (no writes) ──────────────────────────────────────────────

def test_save_validation(both):
    same(*both('POST', '/api/v1/admin/llm-settings', json={}))
    same(*both('POST', '/api/v1/admin/llm-settings', json={'provider_key': 'kimi'}))
    same(*both('POST', '/api/v1/admin/llm-settings',
               json={'provider_key': 'kimi', 'model': 'm', 'api_format': 'bogus'}))


def test_delete_and_toggle_validation(both):
    same(*both('POST', '/api/v1/admin/llm-settings/toggle', json={}))


def test_delete_not_found(both):
    same(*both('DELETE', '/api/v1/admin/llm-settings/no-such-provider-xyz'))


# ─── round-trips (self-cleaning; real live rows) ─────────────────────────

def test_save_kimi_unchanged_round_trip(both, h, php, py):
    pre_a, pre_b = both('GET', '/api/v1/admin/llm-settings/kimi')
    same(pre_a, pre_b)
    provider = pre_a.json()['provider']
    body = {k: provider[k] for k in SAVE_FIELDS}

    r_a, r_b = both('POST', '/api/v1/admin/llm-settings', json=body)
    same(r_a, r_b)
    assert r_a.json() == {'success': True, 'message': 'Provider updated', 'provider_key': 'kimi'}, r_a.text

    after_a, after_b = both('GET', '/api/v1/admin/llm-settings/kimi')
    same(after_a, after_b)

    pre_json, after_json = pre_a.json(), after_a.json()
    pre_json['provider'].pop('updated_at', None)
    after_json['provider'].pop('updated_at', None)
    assert after_json == pre_json


def test_toggle_twice_restores_state(php, py, h):
    """Exercises Python's toggle then PHP's toggle on the SAME shared row —
    since `system_llm_settings` is one physical table, either backend's
    'NOT enabled' flip is visible to both readers immediately.

    Self-cleaning: the restore runs in `finally` regardless of which assert
    (if any) fails, so a mid-test failure never leaves the shared `kimi` row
    with its `enabled` flag flipped (mirrors test_settings.py's
    `keys_snapshot` fixture / test_providers.py's try/finally blocks)."""
    pre = php.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
    assert pre == py.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
    pre_enabled = pre['provider']['enabled']

    try:
        r1 = py.post('/api/v1/admin/llm-settings/toggle', json={'provider_key': 'kimi'}, headers=h)
        assert r1.json() == {'success': True, 'message': 'Provider toggled'}, r1.text
        mid_php = php.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
        mid_py = py.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
        assert mid_php['provider']['enabled'] is (not pre_enabled)
        mid_php['provider'] = dict(mid_php['provider'])
        mid_py['provider'] = dict(mid_py['provider'])
        mid_php['provider'].pop('updated_at', None)
        mid_py['provider'].pop('updated_at', None)
        assert mid_php == mid_py

        r2 = php.post('/api/v1/admin/llm-settings/toggle', json={'provider_key': 'kimi'}, headers=h)
        assert r2.json() == {'success': True, 'message': 'Provider toggled'}, r2.text

        after_php = php.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
        after_py = py.get('/api/v1/admin/llm-settings/kimi', headers=h).json()
        assert after_php['provider']['enabled'] == pre_enabled
        pre_cmp = dict(pre)
        for j in (after_php, after_py, pre_cmp):
            j['provider'] = dict(j['provider'])
            j['provider'].pop('updated_at', None)
        assert after_php == after_py == pre_cmp
    finally:
        # Best-effort restore: re-read the shared row and, if it still
        # differs from the pre-test state, toggle it back. Runs even if an
        # assert above raised, so the live `kimi` row is never left flipped.
        current = php.get('/api/v1/admin/llm-settings/kimi', headers=h).json()['provider']['enabled']
        if current != pre_enabled:
            php.post('/api/v1/admin/llm-settings/toggle', json={'provider_key': 'kimi'}, headers=h)


# ─── seed (no-op on the live config; see module docstring) ──────────────

def test_seed_from_config_is_a_no_op_and_matches(both):
    """The runtime config has no top-level provider blocks and no 'providers'
    array (post 2026-05 cutover to system_llm_settings as the source of
    truth), so `seeded` comes back empty on both backends and no row is
    touched -- safe to call for real."""
    r_a, r_b = both('POST', '/api/v1/admin/llm-settings/seed')
    same(r_a, r_b)
    assert r_a.json() == {'success': True, 'message': 'Providers seeded from config', 'seeded': []}, r_a.text
