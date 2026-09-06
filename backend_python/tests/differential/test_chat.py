import pytest
from app.db import open_primary
from tests.differential.conftest import same
from tests.differential.sse import same_stream, parse_sse, payload

pytestmark = pytest.mark.differential
BODY = {'message': 'Reply with exactly: hello world', 'provider': 'claude', 'tools': [], 'memory': False, 'conversation_history': []}


def _claude_key_configured(config) -> bool:
    db = open_primary(config)
    try:
        row = db.fetch_one("SELECT api_key FROM system_llm_settings WHERE provider_key = 'claude' AND enabled = 1")
        return bool(row and row.get('api_key'))
    finally:
        db.close()


def test_validation_parity_no_llm(both):
    same(*both('POST', '/api/v1/chat', json={'message': ''}))
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'tools': 'bad'}))
    same(*both('POST', '/api/v1/chat', json={'message': 'x', 'provider': 'no-such-provider', 'tools': [], 'memory': False}))
    same(*both('POST', '/api/v1/chat', json={}, auth=False))


def test_regular_chat_parity_live(both, config):
    if not _claude_key_configured(config):
        pytest.skip('no Claude key in system_llm_settings')
    a, b = both('POST', '/api/v1/chat', json={**BODY, 'streaming': False})
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and ja['provider'] == jb['provider'] == 'claude'
    assert set(ja['usage']) == set(jb['usage']) and 'hello world' in ja['text'].lower() and 'hello world' in jb['text'].lower()


def test_streaming_chat_parity_live(php, py, token, config):
    if not _claude_key_configured(config):
        pytest.skip('no Claude key in system_llm_settings')
    h = {'Authorization': f'Bearer {token}'}
    with php.stream('POST', '/api/v1/chat', json={**BODY, 'streaming': True}, headers=h) as ra:
        a = ra.read().decode()
        assert ra.headers['content-type'].startswith('text/event-stream')
    with py.stream('POST', '/api/v1/chat', json={**BODY, 'streaming': True}, headers=h) as rb:
        b = b''.join(rb.iter_bytes()).decode()
        assert rb.headers['content-type'].startswith('text/event-stream')
    same_stream(a, b)
    ea, eb = parse_sse(a), parse_sse(b)
    assert [d for e, d in ea if e == 'progress'][0] == [d for e, d in eb if e == 'progress'][0]        # first progress string verbatim
    assert payload(ea, 'response')['success'] is True and payload(eb, 'response')['success'] is True


def test_streaming_error_parity_bad_key(php, py, token):
    """Both backends: a user API key row for claude with an invalid decryptable key → provider 401 → error events."""
    pytest.skip('requires a throwaway user with an invalid stored key; covered by unit tests in 2a, enabled in 2b')
