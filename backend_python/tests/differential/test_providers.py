"""Per-provider streaming AND non-streaming parity vs the live PHP backend. Two
live LLM calls per backend per configured provider — run once per full run."""
import pytest

from app.db import open_primary
from .conftest import same
from .sse import normalize_usage, same_stream

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


def _norm(d):
    """normalize_usage, plus floats — a derived per-token cost would otherwise
    differ run to run for the same reason the token counts do."""
    if isinstance(d, dict):
        return {k: ('float' if isinstance(v, float) else _norm(v)) for k, v in normalize_usage(d).items()}
    if isinstance(d, list):
        return [_norm(x) for x in d]
    return 'float' if isinstance(d, float) else d


def _body(provider: str, streaming: bool = True) -> dict:
    return {
        'message': 'Reply with exactly: hello world',
        'provider': provider,
        'tools': [],
        'memory': False,
        'streaming': streaming,
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


@pytest.mark.parametrize('provider', CANDIDATES)
def test_non_streaming_parity_live(php, py, token, config, provider):
    """Spec §6 asks for streaming AND non-streaming per provider. The
    generated text and the token counts differ run to run, so parity here is
    the HTTP status, the JSON key ORDER (the result dict contract), and the
    shape of `usage` — `normalize_usage` collapses every int to 'int'.

    The status is compared, not pinned to 200: a live provider that is rate
    limited or whose model host is down must produce the SAME status and the
    SAME humanized `error` string on both backends, and that is exactly the
    error-path parity this suite otherwise cannot force (the chat body carries
    no `model` override — see test_chat.py::test_streaming_error_parity_bad_key
    and tracker row 59)."""
    h = {'Authorization': f'Bearer {token}'}
    if provider not in _configured(config):
        pytest.skip(f'{provider} not configured in system_llm_settings')
    a = php.request('POST', '/api/v1/chat', json=_body(provider, streaming=False), headers=h, timeout=180)
    b = py.request('POST', '/api/v1/chat', json=_body(provider, streaming=False), headers=h)
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb), (list(ja), list(jb))                 # result dict key order
    for k in ('text',):                                               # generated text differs run to run
        ja.pop(k, None); jb.pop(k, None)
    for k in ('response_time', 'duration', 'elapsed'):                # timing fields, if any
        ja.pop(k, None); jb.pop(k, None)
    assert _norm(ja) == _norm(jb), (a.status_code, ja, jb)


def test_unknown_provider_still_not_found(both):
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'provider': 'no-such-provider', 'tools': [], 'memory': False}))
