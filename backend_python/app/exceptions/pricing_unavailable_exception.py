"""Exception when a token price cannot be resolved from system_llm_settings."""


class PricingUnavailableException(RuntimeError):
    """
    Thrown when a token price cannot be resolved from system_llm_settings
    (no row, a NULL price, or a failed DB query). Never swallowed into a
    hardcoded fallback — callers on the billing path surface it.
    """

    pass
