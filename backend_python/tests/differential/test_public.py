import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_root(both):
    same(*both('GET', '/', auth=False))


def test_model_catalog(both):
    a, b = both('GET', '/api/v1/models/catalog', auth=False)
    same(a, b)


def test_404_and_405_envelopes(both):
    same(*both('GET', '/api/v1/definitely-missing'))
    a, b = both('PATCH', '/api/v1/prompts')
    assert a.status_code == b.status_code == 405
    assert sorted(a.json()['allowed_methods']) == sorted(b.json()['allowed_methods'])


def test_401_envelopes(both):
    same(*both('GET', '/api/v1/prompts', auth=False))
    same(*both('GET', '/api/v1/prompts', headers={'Authorization': 'Bearer garbage'}, auth=False))
