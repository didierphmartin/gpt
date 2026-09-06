import json
import pytest
from app.services.usage_logger import UsageLogger
from app.exceptions import PricingUnavailableException


class Db:
    def __init__(self, price=None):
        self.price = price; self.calls = []; self.next_id = 41
    def fetch_one(self, sql, p=None):
        self.calls.append((sql, p))
        if 'price_input_per_1m' in sql: return self.price
        if 'current_month' in sql: return None
        return {'1': 1}
    def fetch_all(self, sql, p=None): self.calls.append((sql, p)); return []
    def execute(self, sql, p=None): self.calls.append((sql, p)); return 1
    def insert(self, sql, p=None): self.calls.append((sql, p)); return self.next_id


def test_calculate_cost_uses_db_price():
    assert UsageLogger(Db({'price_input_per_1m': '2.5000', 'price_output_per_1m': '10.0000'}), True).calculateCost('openai', 'gpt-4o', 1_000_000, 1_000_000) == 12.5


def test_calculate_cost_throws_when_unconfigured():
    with pytest.raises(PricingUnavailableException):
        UsageLogger(Db(None), True).calculateCost('gemini', 'gemini-3-flash-preview', 1000, 1000)


def test_log_transaction_inserts_and_updates_balance():
    db = Db({'price_input_per_1m': '1', 'price_output_per_1m': '2'})
    tid = UsageLogger(db, True).logTransaction({'user_id': 3, 'session_id': 's', 'provider': 'claude', 'model': 'm',
                                               'prompt_tokens': 1000, 'completion_tokens': 500, 'response_time_ms': 12,
                                               'status': 'success', 'function_calls_count': 1, 'functions_called': ['a'],
                                               'mcp_calls_count': 0, 'mcp_tools_called': None})
    assert tid == 41
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':total_tokens'] == 1500 and ins[':cost_usd'] == 0.002 and ins[':functions_called'] == '["a"]' and ins[':mcp_tools_called'] is None
    assert ins[':is_voice_request'] == 0 and ins[':error_message'] is None
    bal = next(p for s, p in db.calls if 'INSERT INTO llm_usage_balance' in s)
    assert bal[':tokens'] == 1500 and bal[':success'] == 1 and bal[':failure'] == 0 and bal[':cost'] == 0.002


def test_log_transaction_pricing_error_records_null_cost_and_suffix():
    db = Db(None)
    UsageLogger(db, True).logTransaction({'user_id': 3, 'provider': 'gemini', 'model': 'x', 'prompt_tokens': 1, 'completion_tokens': 1, 'error_message': 'orig'})
    ins = next(p for s, p in db.calls if s.strip().startswith('INSERT INTO llm_usage_transactions'))
    assert ins[':cost_usd'] is None and ins[':error_message'].startswith('orig | PRICING_ERROR: No price configured')


def test_log_transaction_without_user_returns_none():
    db = Db()
    assert UsageLogger(db, True).logTransaction({'provider': 'claude'}) is None and not any('INSERT' in s for s, _ in db.calls)


def test_voice_cost_table():
    assert UsageLogger(Db(), True).calculateVoiceCost('grok', 10, 10) == 0.012
    assert UsageLogger(Db(), True).calculateVoiceCost('unknown', 10, 10) == 0.0075
