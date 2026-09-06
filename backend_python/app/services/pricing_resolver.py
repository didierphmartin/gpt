"""Port of Services/PricingResolver.php.

Single source of truth for LLM token pricing: system_llm_settings.
Returns (input_per_1m, output_per_1m) for a provider, or throws.
A price of 0 is valid (e.g. self-hosted). NULL / missing / query error throws.
"""
from __future__ import annotations

from app.exceptions import PricingUnavailableException

ALIASES = {'anthropic': 'claude', 'google': 'gemini'}


class PricingResolver:
    def __init__(self, db):
        self.db = db
        self._cache: dict[str, tuple[float, float]] = {}

    def resolve(self, provider: str) -> tuple[float, float]:
        key = ALIASES.get(provider.lower(), provider.lower())
        if key in self._cache:
            return self._cache[key]

        try:
            row = self.db.fetch_one(
                'SELECT price_input_per_1m, price_output_per_1m '
                'FROM system_llm_settings WHERE provider_key = :k LIMIT 1',
                {':k': key},
            )
        except Exception as e:
            raise PricingUnavailableException(
                f"Pricing lookup failed for provider '{key}' in system_llm_settings: {e}"
            ) from e

        result = self.classifyRow(row, key)
        self._cache[key] = result
        return result

    @staticmethod
    def classifyRow(row: dict | None, key: str) -> tuple[float, float]:
        """Pure classifier: a fetched row (or None) -> rates or throw. DB-free for testing."""
        if row is None:
            raise PricingUnavailableException(
                f"No price configured for provider '{key}' in system_llm_settings"
            )
        if row.get('price_input_per_1m') is None or row.get('price_output_per_1m') is None:
            raise PricingUnavailableException(
                f"Null price for provider '{key}' in system_llm_settings "
                "(set price_input_per_1m / price_output_per_1m)"
            )
        return (float(row['price_input_per_1m']), float(row['price_output_per_1m']))
