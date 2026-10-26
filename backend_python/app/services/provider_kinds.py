"""Port of Services/ProviderKinds.php.

Which system_llm_settings rows are chat providers, and which are not. A ROUTER
row (a decision-model provider such as TypeSafe's Jev) only borrows the table to
store a key; it cannot write a sentence, so it must never be offered,
registered or fallen back to as a chat provider. `api_format = 'router'` is
the one marker.
"""
from __future__ import annotations

from app.services.decision_protocols import DECISION_PROTOCOLS, env_stem

ROUTER_FORMAT = 'router'


def is_router_row(row: dict) -> bool:
    """A system_llm_settings row (or a provider block built from one) that is a router."""
    return row.get('api_format') == ROUTER_FORMAT


def router_row_error(provider_key, api_format, protocol, existing_format, other_decision_keys) -> str | None:
    """Save rules for a row's kind: the kind is fixed at creation, a router row
    names a registered protocol, and no two decision keys share an env stem.
    Returns the error message, or None when valid."""
    is_router = api_format == ROUTER_FORMAT
    if existing_format is not None and (existing_format == ROUTER_FORMAT) != is_router:
        return (f"Provider '{provider_key}' is an LLM; it cannot become a decision provider" if is_router
                else f"Provider '{provider_key}' is a decision provider; it cannot become an LLM")
    if not is_router:
        return None
    if not protocol or protocol not in DECISION_PROTOCOLS:
        return 'Decision provider needs a protocol: one of ' + ', '.join(DECISION_PROTOCOLS)
    stem = env_stem(provider_key)
    for other in other_decision_keys:
        if other != provider_key and env_stem(other) == stem:
            return f"'{other}' and '{provider_key}' would share the env name {stem}_API_KEY"
    return None


def _decision_rows(rows: list[dict]) -> list[dict]:
    """Enabled router rows in admin order (sort_order, then key)."""
    return sorted((r for r in rows if is_router_row(r) and r.get('enabled')),
                  key=lambda r: (int(r.get('sort_order') or 0), str(r['provider_key'])))


def _protocol_of(row: dict):
    return DECISION_PROTOCOLS.get(row.get('protocol') or '')


def decision_provider_list(rows: list[dict], allowed, rates: dict | None = None) -> list[dict]:
    """`decision_providers` of GET /settings/keys and /settings/usage
    (SettingsController::decisionProviderList): usable rows the plan allows,
    admin order. Never a key. `rates` is routerRates() keyed by provider."""
    rates = rates or {}
    out = []
    for row in _decision_rows(rows):
        key = str(row['provider_key'])
        protocol = _protocol_of(row)
        if protocol is None or not allowed(key):
            continue
        out.append({
            'key': key,
            'label': str(row.get('display_name') or key),
            'protocol': str(row['protocol']),
            'model': str(row.get('model') or protocol['model']),
            'default_url': str(row.get('base_url') or '').strip() or protocol['url'],
            'rate': rates.get(key),
            'console_url': protocol['console_url'],
        })
    return out
