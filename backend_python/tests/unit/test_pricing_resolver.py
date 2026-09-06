import pytest
from app.services.pricing_resolver import PricingResolver
from app.exceptions import PricingUnavailableException


def test_classify_returns_rates_for_valid_row():
    assert PricingResolver.classifyRow({'price_input_per_1m': '2.5000', 'price_output_per_1m': '10.0000'}, 'openai') == (2.5, 10.0)


def test_classify_treats_zero_as_valid():
    assert PricingResolver.classifyRow({'price_input_per_1m': '0.0000', 'price_output_per_1m': '0.0000'}, 'gamma4') == (0.0, 0.0)


def test_classify_throws_on_missing_row():
    with pytest.raises(PricingUnavailableException, match="provider 'gemini'"):
        PricingResolver.classifyRow(None, 'gemini')


def test_classify_throws_on_null_price():
    with pytest.raises(PricingUnavailableException):
        PricingResolver.classifyRow({'price_input_per_1m': None, 'price_output_per_1m': '4.0000'}, 'kimi')


def test_resolve_uses_alias_cache_and_wraps_db_errors():
    class Db:
        def __init__(self): self.calls = 0
        def fetch_one(self, sql, p=None):
            self.calls += 1; assert p == {':k': 'claude'}
            return {'price_input_per_1m': '3', 'price_output_per_1m': '15'}
    db = Db(); r = PricingResolver(db)
    assert r.resolve('anthropic') == (3.0, 15.0) and r.resolve('claude') == (3.0, 15.0) and db.calls == 1
    class Bad:
        def fetch_one(self, sql, p=None): raise RuntimeError('down')
    with pytest.raises(PricingUnavailableException, match="Pricing lookup failed for provider 'kimi' in system_llm_settings: down"):
        PricingResolver(Bad()).resolve('kimi')
