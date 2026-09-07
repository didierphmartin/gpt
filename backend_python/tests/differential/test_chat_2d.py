"""PHP-vs-Python parity for the Phase 2d chat endpoints (/agent, /verify, /compare)."""
import pytest
from .conftest import same
from .sse import same_stream

pytestmark = pytest.mark.differential

MSG = 'Reply with exactly: hello world'


def test_validation_parity(both):
    same(*both('POST', '/api/v1/agent', json={'prompt': '', 'provider': 'claude'}))
    same(*both('POST', '/api/v1/agent', json={'prompt': 'x'}))
    same(*both('POST', '/api/v1/agent', json={'prompt': 'x', 'provider': 'no-such'}))
    same(*both('POST', '/api/v1/verify', json={'original_message': 'q'}))
    same(*both('POST', '/api/v1/compare', json={'message': 'q'}))


def test_agent_live_parity(both):
    a, b = both('POST', '/api/v1/agent', json={'prompt': MSG, 'provider': 'claude'})
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and ja['success'] is jb['success'] is True and ja['provider'] == jb['provider'] and ja['model'] == jb['model']
    assert sorted(ja['usage']) == sorted(jb['usage'])


def _stream(client, path, body, token):
    h = {'Authorization': f'Bearer {token}'}
    with client.stream('POST', path, json=body, headers=h, timeout=180) as r:
        return r.status_code, r.headers['content-type'], b''.join(r.iter_bytes()).decode()


def test_verify_live_parity(php, py, token):
    body = {'original_message': MSG, 'response_text': 'hello world', 'verifier_provider': 'kimi'}
    sa, ca, a = _stream(php, '/api/v1/verify', body, token); sb, cb, b = _stream(py, '/api/v1/verify', body, token)
    assert sa == sb == 200 and ca.split(';')[0] == cb.split(';')[0] == 'text/event-stream'
    same_stream(a, b, ignore_response_keys=('text',))


def test_compare_live_parity(php, py, token):
    body = {'message': MSG, 'compare_provider': 'kimi', 'tools': [], 'memory': False, 'conversation_history': []}
    sa, ca, a = _stream(php, '/api/v1/compare', body, token); sb, cb, b = _stream(py, '/api/v1/compare', body, token)
    assert sa == sb == 200
    same_stream(a, b, ignore_response_keys=('text',))
