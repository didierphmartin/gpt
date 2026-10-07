from app.services.decision_protocols import DECISION_PROTOCOLS, decision_protocol_catalog, env_stem
from app.services.provider_kinds import router_row_error, decision_provider_list, dispatch_provider_list

ROWS = [
    {'provider_key': 'claude', 'api_format': 'anthropic', 'enabled': 1, 'sort_order': 0},
    {'provider_key': 'jev', 'display_name': 'Jev', 'api_format': 'router', 'protocol': 'typesafe', 'model': 'jev-latest', 'base_url': None, 'enabled': 1, 'sort_order': 100},
    {'provider_key': 'acme', 'display_name': 'Acme', 'api_format': 'router', 'protocol': 'typesafe', 'model': '', 'base_url': 'https://gw/acme', 'enabled': 1, 'sort_order': 50},
    {'provider_key': 'broken', 'display_name': 'B', 'api_format': 'router', 'protocol': None, 'model': 'm', 'base_url': None, 'enabled': 1, 'sort_order': 10},
]


def test_typesafe_matches_php():
    assert DECISION_PROTOCOLS['typesafe']['url'] == 'https://api.typesafe.ai/v1/systemone'
    assert list(decision_protocol_catalog()[0]) == ['id', 'label', 'url', 'model', 'console_url']


def test_env_stem():
    assert env_stem('jev-eu') == 'JEV_EU'
    assert env_stem('acme.v2') == 'ACME_V2'


def test_router_rows_need_a_protocol():
    assert 'needs a protocol: one of typesafe' in router_row_error('acme', 'router', None, None, [])
    assert router_row_error('acme', 'router', 'typesafe', None, []) is None


def test_kind_cannot_flip():
    assert 'cannot become an LLM' in router_row_error('jev', 'openai', None, 'router', [])
    assert 'cannot become a decision provider' in router_row_error('kimi', 'router', 'typesafe', 'openai', [])


def test_env_stem_clash():
    assert 'JEV_EU_API_KEY' in router_row_error('jev_eu', 'router', 'typesafe', None, ['jev-eu'])


def test_decision_provider_list():
    out = decision_provider_list(ROWS, lambda k: k != 'jev')
    assert [d['key'] for d in out] == ['acme']
    assert out[0]['default_url'] == 'https://gw/acme'
    assert out[0]['model'] == 'jev-latest'


def test_dispatch_provider_list_is_not_routable_here():
    out = dispatch_provider_list(ROWS, lambda k: True)
    assert out['default'] is None
    assert [p['key'] for p in out['providers']] == ['broken', 'acme', 'jev']
    assert all(p['routable'] is False and p['reason'] == 'not supported on this backend' for p in out['providers'])
