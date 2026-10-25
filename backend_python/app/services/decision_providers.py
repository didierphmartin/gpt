"""Port of Services/DecisionProviders.php.

The decision providers an admin configured: system_llm_settings rows with
api_format 'router'. Read with SELECT * so an install without the `protocol`
column (migration not applied) reads protocol None = unusable.
"""
from __future__ import annotations

from app.services.decision_protocols import DecisionProtocols, env_stem
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_strval

ROUTER_FORMAT = 'router'   # ProviderKinds::ROUTER_FORMAT


class DecisionProviders:
    @staticmethod
    def rows(db, enabledOnly: bool = True) -> list:
        try:
            rows = db.fetch_all('SELECT * FROM system_llm_settings WHERE api_format = :f '
                                'ORDER BY sort_order ASC, provider_key ASC', {':f': ROUTER_FORMAT}) or []
        except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (Throwable $e)
            error_log('[DecisionProviders] rows lookup failed: ' + str(e))
            return []
        return [r for r in rows if not enabledOnly or not php_empty(r.get('enabled'))]

    @staticmethod
    def row(db, key: str) -> dict | None:
        """The enabled decision row for a key, None when there is none."""
        for r in DecisionProviders.rows(db):
            if php_strval(r.get('provider_key')) == key:
                return r
        return None

    @staticmethod
    def keys(db) -> list:
        """Every decision key, enabled or not (quota, key screens)."""
        return [php_strval(r.get('provider_key')) for r in DecisionProviders.rows(db, False)]

    @staticmethod
    def protocolOf(row: dict) -> dict | None:
        p = row.get('protocol')
        return DecisionProtocols.get(php_strval(p) if p is not None else None)

    @staticmethod
    def envStem(key: str) -> str:
        """Env var stem for a row key: upper case, every char outside A-Z0-9 -> '_'."""
        return env_stem(key)
