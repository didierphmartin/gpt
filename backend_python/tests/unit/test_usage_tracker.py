import pytest
from app.services.usage_tracker import UsageTracker
from app.exceptions import PricingUnavailableException


class Db:
    def __init__(self, price): self.price = price; self.calls = []
    def fetch_one(self, sql, p=None): self.calls.append((sql, p)); return self.price if 'price_' in sql else {'1': 1}
    def execute(self, sql, p=None): self.calls.append((sql, p)); return 1


def test_calculate_cost_uses_db_price():
    assert UsageTracker(Db({'price_input_per_1m': '0.2000', 'price_output_per_1m': '0.5000'}), True).calculateCost('grok', 'grok-4-fast', 1_000_000, 1_000_000) == 0.7


def test_calculate_cost_throws_when_unconfigured():
    with pytest.raises(PricingUnavailableException):
        UsageTracker(Db(None), True).calculateCost('gemini', 'x', 1000, 1000)


def test_calculate_cost_rounds_half_away_from_zero():
    # php_round regression (Phase 7 final-review wave, B1): 1 token at
    # $0.5/1M is exactly 0.0000005 -> `php -r 'echo round(0.0000005, 6);'`
    # rounds UP to 1.0E-6; Python's builtin round(0.0000005, 6) rounds DOWN
    # to 0.0 (round-half-to-even on the raw double).
    cost = UsageTracker(Db({'price_input_per_1m': '0.5', 'price_output_per_1m': '0'}), True) \
        .calculateCost('grok', 'grok-4-fast', 1, 0)
    assert cost == 1e-06


def test_track_request_inserts_with_request_metadata():
    db = Db({'price_input_per_1m': '1', 'price_output_per_1m': '1'})
    UsageTracker(db, True).trackRequest({'user_id': 3, 'provider': 'claude', 'model': 'm', 'input_tokens': 10, 'output_tokens': 5, 'request_type': 'chat'})
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':total_tokens'] == 15 and ins[':request_metadata'] == '{"request_type":"chat"}'


def test_disabled_without_db():
    UsageTracker(None, True).trackRequest({'user_id': 3})   # no error, no-op
