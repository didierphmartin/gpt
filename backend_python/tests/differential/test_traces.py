import pytest

from .conftest import same

pytestmark = pytest.mark.differential


def test_traces_validation_and_diagnosis_parity(both):
    same(*both('POST', '/api/v1/traces', json={}, auth=False))
    same(*both('POST', '/api/v1/traces', json={}))
    same(*both('GET', '/api/v1/traces/diagnosis', auth=False))
    same(*both('GET', '/api/v1/traces/diagnosis?days=30'))
