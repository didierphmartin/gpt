"""Port of Services/DecisionRouters.php: builds the adapter for a resolved decision provider
(DecisionKeyResolver.resolve())."""
from __future__ import annotations

from app.services.decision_key_resolver import DecisionKeyResolver
from app.support.phpcompat import php_strval, php_trim


class DecisionRouters:
    @staticmethod
    def make(resolved: dict, floor: float, http=None):
        protocol = resolved.get('protocol')
        if not isinstance(protocol, dict):
            return None
        cls = protocol['adapter']
        row = resolved.get('row') if isinstance(resolved.get('row'), dict) else {}
        model = php_trim(php_strval(row.get('model') if row.get('model') is not None else ''))
        return cls(resolved['key'] if resolved.get('key') != '' else None, http, floor,
                   php_strval(resolved.get('url')), model)

    @staticmethod
    def unavailable(resolved: dict, providerKey: str) -> dict:
        """The outcome an unbuildable or keyless provider reports, without calling anyone."""
        return {'outcome': 'unavailable', 'target': None, 'confidence': None, 'probabilities': [],
                'ms': None, 'usage': [], 'reason': DecisionKeyResolver.unavailableReason(resolved, providerKey)}
