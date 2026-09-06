"""GET /api/v1/providers and the switch routes: exact JSON parity vs live PHP (no LLM calls)."""
from .conftest import same


def test_list_exact(both):
    same(*both('GET', '/api/v1/providers'))


def test_list_requires_auth(both):
    same(*both('GET', '/api/v1/providers', auth=False))


def test_switch_missing_invalid_and_valid(both):
    same(*both('POST', '/api/v1/providers/switch', json={}))
    same(*both('POST', '/api/v1/providers/switch', json={'provider': 'no-such-provider'}))
    same(*both('POST', '/api/v1/providers/switch', json={'provider': 'kimi'}))
    same(*both('POST', '/api/v1/providers', json={'provider': 'claude'}))         # legacy POST alias
