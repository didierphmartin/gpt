"""PHP-vs-Python differential: FileStorageController + VoiceController +
DriveController.

PHP is hit first in every case (per constraints.md "Differential ordering")
so any PHP on-demand DDL/normalization lands before the Python request.

Storage reads are read-only (constraints.md ruling): no fixture files are
created/deleted — cases compare the live filesystem/DB state as-is,
including not-found parity. `POST /voice/usage` cases are validation-only
(fail before the INSERT, so no rows are written). `POST /voice/token`'s
happy path makes a REAL, billed call to xAI (the live grok_voice API key is
configured) and returns a different opaque secret every time it succeeds —
it is skipped by default and only runs with DIFF_VOICE_TOKEN=1, in which
case only success/shape is compared, not exact secret bytes.
"""
import os

import pytest

from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential


# ─── storage ──────────────────────────────────────────────────────────────

def test_storage_providers_parity(both):
    # DONE_WITH_CONCERNS (see file_storage_controller.py module docstring):
    # PHP's getProviders() calls an undefined method and always 500s live;
    # ported verbatim (raise, uncaught) so both sides return the identical
    # 500 body.
    same(*both('GET', '/api/v1/storage/providers'))


def test_storage_list_parity(both):
    # Read-only: user 3's live storage_provider is not 'local', so this
    # deterministically returns the "cloud storage not configured" message
    # on both backends (getUniversalFSAdapter() always None on both).
    same(*both('GET', '/api/v1/storage/list'))


def test_storage_read_not_found_parity(both):
    same(*both('GET', f'/api/v1/storage/read?fileId=does-not-exist-{DIFF_USER_ID}.txt'))


def test_storage_read_missing_file_id_parity(both):
    same(*both('GET', '/api/v1/storage/read'))


def test_storage_unauthenticated_401_parity(both):
    same(*both('GET', '/api/v1/storage/list', auth=False))


# ─── voice ────────────────────────────────────────────────────────────────

def test_voice_stats_week_parity(both):
    same(*both('GET', '/api/v1/voice/stats?period=week'))


def test_voice_stats_default_period_parity(both):
    same(*both('GET', '/api/v1/voice/stats'))


def test_voice_config_grok_parity(both):
    same(*both('GET', '/api/v1/voice/config?provider=grok'))


def test_voice_config_gemini_parity(both):
    # JWT auth (the `both` fixture's token) -> mayReadKey True on both sides,
    # so the gemini api_key field is present and must match byte-for-byte.
    same(*both('GET', '/api/v1/voice/config?provider=gemini'))


def test_voice_config_unknown_provider_parity(both):
    same(*both('GET', '/api/v1/voice/config?provider=bogus'))


def test_voice_usage_validation_parity_no_rows(both):
    """Validation failures only — these return before UsageLogger.logTransaction()
    ever runs, so no llm_usage_transactions row is written on either side."""
    same(*both('POST', '/api/v1/voice/usage', json={'provider': 'not-a-real-provider'}))
    same(*both('POST', '/api/v1/voice/usage', json={'provider': 'grok'}))  # missing audio seconds
    same(*both('POST', '/api/v1/voice/usage',
               json={'provider': 'grok', 'audio_input_seconds': 0, 'audio_output_seconds': 0}))


def test_voice_usage_unauthenticated_401_parity(both):
    same(*both('POST', '/api/v1/voice/usage', json={'provider': 'grok'}, auth=False))


def test_voice_token_validation_parity(both):
    """No network call: rejected before generateGrokEphemeralToken() runs."""
    same(*both('POST', '/api/v1/voice/token', json={'provider': 'openai'}))
    same(*both('POST', '/api/v1/voice/token', json={'provider': 'some-other-provider'}))


@pytest.mark.skipif(
    os.environ.get('DIFF_VOICE_TOKEN') != '1',
    reason='POST /voice/token (grok, happy path) makes a real billed call to xAI and '
           'returns a fresh opaque secret every time; skipped by default per constraints.md '
           '("voice token env gate"). Set DIFF_VOICE_TOKEN=1 to run it.',
)
def test_voice_token_grok_live_shape_parity(php, py, token):
    """Both sides must succeed with the same shape; the secret/expiry values
    themselves are per-call and cannot be compared byte-for-byte."""
    h = {'Authorization': f'Bearer {token}'}
    a = php.post('/api/v1/voice/token', json={'provider': 'grok'}, headers=h)
    b = py.post('/api/v1/voice/token', json={'provider': 'grok'}, headers=h)
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()
    assert ja['success'] is True and jb['success'] is True
    assert ja['provider'] == jb['provider'] == 'grok'
    assert isinstance(ja['client_secret'], str) and isinstance(jb['client_secret'], str)
    assert ja['client_secret'] and jb['client_secret']
    assert ja['voice'] == jb['voice']


# ─── drive ────────────────────────────────────────────────────────────────

def test_drive_save_exact_parity(both):
    same(*both('POST', '/api/v1/drive/save', json={'prompt': 'p', 'response': 'r', 'provider': 'grok'}))


def test_drive_save_unauthenticated_401_parity(both):
    same(*both('POST', '/api/v1/drive/save', json={}, auth=False))
