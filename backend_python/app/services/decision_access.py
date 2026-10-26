"""The package allowlist rule as an `allowed(key)` callable (DecisionKeyResolver::packageEntry).

No provider allowlist = everything allowed; otherwise a provider missing or not
enabled is refused. Fails open on a lookup error, like the LLM provider list.
"""
from __future__ import annotations

from app.services.package_resolver import PackageResolver
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_empty, php_intval


def router_rows(db) -> list[dict]:
    """Every router row (DecisionProviders::rows); [] when the lookup fails."""
    try:
        return db.fetch_all('SELECT * FROM system_llm_settings WHERE api_format = :f'
                            ' ORDER BY sort_order ASC, provider_key ASC', {':f': 'router'}) or []
    except Exception as e:  # noqa: BLE001
        error_log('[DecisionProviders] rows lookup failed: ' + str(e))
        return []


def package_allowed(db, user_id):
    try:
        uid = php_intval(user_id) if is_numeric(user_id) else None
        providers = (PackageResolver(db).resolveForUser(uid).get('capabilities') or {}).get('providers')
    except Exception as e:  # noqa: BLE001
        error_log('[DecisionAccess] package lookup failed: ' + str(e))
        return lambda key: True
    if isinstance(providers, list):
        # PHP is_array() holds for a JSON list too: an allowlist naming no provider key.
        return lambda key: False
    if not isinstance(providers, dict):
        return lambda key: True

    def allowed(key):
        entry = providers.get(key)
        return isinstance(entry, dict) and not php_empty(entry.get('enabled'))
    return allowed
