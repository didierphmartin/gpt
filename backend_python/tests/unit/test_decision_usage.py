"""Port of backend/tests/Unit/DecisionUsageTest.php."""
from __future__ import annotations

from app.services.decision_usage import DecisionUsage


def _answered(outcome='routed'):
    return {'outcome': outcome, 'target': None, 'confidence': 0.9, 'ms': 212,
            'usage': {'input_tokens': 342, 'output_tokens': 39},
            'reason': 'no choice in the response' if outcome == 'error' else None}


class _Logger:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def logTransaction(self, data):
        if self.fail:
            raise RuntimeError('db down')
        self.calls.append(data)
        return 1


def test_transaction_payload():
    t = DecisionUsage.transaction(7, 'jev', 'jev-latest', _answered())
    assert t['user_id'] == 7
    assert t['provider'] == 'jev'
    assert t['model'] == 'jev-latest'
    assert t['prompt_tokens'] == 342
    assert t['completion_tokens'] == 39
    assert t['response_time_ms'] == 212
    assert t['status'] == 'success'
    assert t['error_message'] is None
    assert t['request_metadata'] == {'decision_outcome': 'routed'}


def test_unclear_and_low_confidence_are_successful_calls():
    assert DecisionUsage.transaction(7, 'jev', 'jev-latest', _answered('unclear'))['status'] == 'success'
    assert DecisionUsage.transaction(7, 'jev', 'jev-latest', _answered('low_confidence'))['status'] == 'success'


def test_an_answered_error_is_recorded_as_error():
    t = DecisionUsage.transaction(7, 'jev', 'jev-latest', _answered('error'))
    assert t['status'] == 'error'
    assert t['error_message'] == 'no choice in the response'


def test_a_call_that_was_never_sent_is_not_recorded():
    logger = _Logger()
    DecisionUsage.record(logger, 7, 'jev', 'jev-latest', {'outcome': 'unavailable', 'ms': None, 'usage': [], 'reason': 'no Jev key'})
    DecisionUsage.record(logger, 7, 'jev', 'jev-latest',
                         {'outcome': 'error', 'ms': None, 'usage': [], 'reason': 'a menu needs at least two targets'})
    assert logger.calls == []


def test_no_user_no_record():
    logger = _Logger()
    DecisionUsage.record(logger, None, 'jev', 'jev-latest', _answered())
    assert logger.calls == []


def test_answered_call_is_recorded_once():
    logger = _Logger()
    DecisionUsage.record(logger, 7, 'jev', 'jev-latest', _answered())
    assert len(logger.calls) == 1
    assert logger.calls[0]['provider'] == 'jev' and logger.calls[0]['prompt_tokens'] == 342


def test_a_logger_failure_never_throws():
    DecisionUsage.record(_Logger(fail=True), 7, 'jev', 'jev-latest', _answered())


def test_the_row_key_and_model_are_recorded():
    tx = DecisionUsage.transaction(7, 'acme', 'acme-1', {'outcome': 'routed', 'ms': 12,
                                                         'usage': {'input_tokens': 5, 'output_tokens': 1}})
    assert tx['provider'] == 'acme'
    assert tx['model'] == 'acme-1'
    assert tx['request_metadata'] == {'decision_outcome': 'routed'}
