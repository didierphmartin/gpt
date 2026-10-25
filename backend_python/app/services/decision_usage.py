"""Port of Services/DecisionUsage.php.

One usage row per decision-model call the vendor answered, written like an LLM call (UsageLogger) under
the decision row's key, so usage and cost screens show it. A call never sent (not allowed, no key, bad
menu) records nothing.
"""
from __future__ import annotations

from app.support.logger import error_log
from app.support.phpcompat import php_intval, php_strval


def _usage(out: dict) -> dict:
    u = out.get('usage')
    return u if isinstance(u, dict) else {}


class DecisionUsage:
    @staticmethod
    def shouldRecord(out: dict) -> bool:
        """The vendor answered: adapters set ms only once a response came back."""
        return out.get('ms') is not None

    @staticmethod
    def transaction(userId: int, providerKey: str, model: str, out: dict) -> dict:
        isError = out.get('outcome') == 'error'
        u = _usage(out)
        return {
            'user_id': userId,
            'provider': providerKey,
            'model': model,
            'prompt_tokens': php_intval(u.get('input_tokens') if u.get('input_tokens') is not None else 0),
            'completion_tokens': php_intval(u.get('output_tokens') if u.get('output_tokens') is not None else 0),
            'response_time_ms': php_intval(out.get('ms')),
            'status': 'error' if isError else 'success',
            'error_message': php_strval(out.get('reason') if out.get('reason') is not None else '') if isError else None,
            'request_metadata': {'decision_outcome': php_strval(out.get('outcome') if out.get('outcome') is not None else '')},
        }

    @staticmethod
    def record(logger, userId: int | None, providerKey: str, model: str, out: dict) -> None:
        if userId is None or userId <= 0 or not DecisionUsage.shouldRecord(out):
            return
        try:
            logger.logTransaction(DecisionUsage.transaction(userId, providerKey, model, out))
        except Exception as e:  # noqa: BLE001
            # Usage is bookkeeping: it must never turn a routed request into a failure.
            error_log('[DecisionUsage] could not record a decision call: ' + str(e))
