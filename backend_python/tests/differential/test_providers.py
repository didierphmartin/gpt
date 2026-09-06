"""Per-provider streaming parity vs the live PHP backend. One live LLM call per
backend per configured provider — run once per full run."""
import pytest

from app.db import open_primary
from .conftest import same
from .sse import same_stream

pytestmark = pytest.mark.differential

CANDIDATES = ['openai', 'grok', 'kimi', 'deepseek', 'gemini', 'gamma4', 'glm']


def _configured(config) -> set[str]:
    db = open_primary(config)
    try:
        rows = db.fetch_all(
            "SELECT provider_key FROM system_llm_settings WHERE enabled = 1 AND api_key IS NOT NULL AND api_key <> ''"
        )
        return {r['provider_key'] for r in rows}
    finally:
        db.close()


def _body(provider: str) -> dict:
    return {
        'message': 'Reply with exactly: hello world',
        'provider': provider,
        'tools': [],
        'memory': False,
        'streaming': True,
        'conversation_history': [],
    }


@pytest.mark.parametrize('provider', CANDIDATES)
def test_streaming_parity_live(php, py, token, config, provider):
    if provider not in _configured(config):
        pytest.skip(f'{provider} not configured in system_llm_settings')
    h = {'Authorization': f'Bearer {token}'}
    with php.stream('POST', '/api/v1/chat', json=_body(provider), headers=h, timeout=180) as ra:
        a = ra.read().decode()
        a_status, a_ctype = ra.status_code, ra.headers['content-type']
    with py.stream('POST', '/api/v1/chat', json=_body(provider), headers=h) as rb:
        b = b''.join(rb.iter_bytes()).decode()
        b_status, b_ctype = rb.status_code, rb.headers['content-type']
    assert a_status == b_status == 200, (a_status, b_status, a, b)
    assert a_ctype.split(';')[0] == b_ctype.split(';')[0] == 'text/event-stream'
    same_stream(a, b)


def test_unknown_provider_still_not_found(both):
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'provider': 'no-such-provider', 'tools': [], 'memory': False}))
