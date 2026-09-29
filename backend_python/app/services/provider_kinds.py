"""Port of Services/ProviderKinds.php.

Which system_llm_settings rows are chat providers, and which are not. A ROUTER
row (Jev, TypeSafe's dispatcher router) only borrows the table to store a key;
it cannot write a sentence, so it must never be offered, registered or fallen
back to as a chat provider. `api_format = 'router'` is the one marker.
"""
from __future__ import annotations

ROUTER_FORMAT = 'router'
JEV_KEY = 'jev'
# Router rows are allowed for these keys only.
ROUTER_KEYS = [JEV_KEY]


def is_router_row(row: dict) -> bool:
    """A system_llm_settings row (or a provider block built from one) that is a router."""
    return row.get('api_format') == ROUTER_FORMAT


def router_pairing_error(provider_key, api_format) -> str | None:
    """Two-way pairing rule of SystemSettingsController: a router key must use
    api_format 'router', and 'router' is reserved for router keys. Returns the
    error message, or None when valid."""
    is_router_key = provider_key in ROUTER_KEYS
    if is_router_key == (api_format == ROUTER_FORMAT):
        return None
    if is_router_key:
        return f"Provider '{provider_key}' is a router: api_format must be '{ROUTER_FORMAT}'"
    return f"api_format '{ROUTER_FORMAT}' is reserved for: " + ', '.join(ROUTER_KEYS)
