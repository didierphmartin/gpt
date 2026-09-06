"""Port of Services/LLMProviderResolver.php.

LLM provider config resolver.

Loads enabled provider rows from `system_llm_settings` and overlays them on
the runtime config. As of the 2026-05 cutover, this is the *source* of LLM
provider config (the ai_config.php blocks were removed); per-user
overrides still apply on top in `ChatController::applyUserApiKeys`.

Placement of each provider matches what
`AIPortfolioAssistant::initializeDefaultProvider` reads:
  - `claude`, `openai`           -> at config root
  - everything else (`kimi`, `grok`, `gemini`, `deepseek`, ...) -> nested
    under `config['providers'][<key>]`
"""
from __future__ import annotations

import json

from app.support.logger import error_log
from app.support.phpcompat import php_empty

ROOT_PROVIDERS = ('claude', 'openai')


def _php_bool(v) -> bool:
    """PHP (bool) cast: '' and '0' are false; any other string is true; 0/0.0 false."""
    if isinstance(v, str):
        return v not in ('', '0')
    return bool(v)


class LLMProviderResolver:
    @staticmethod
    def applyDbSettings(db, config: dict) -> dict:
        """Return config with provider blocks built from `system_llm_settings`.
        Failures (table missing, permission denied) log and return the input
        unchanged so the caller doesn't crash on an environment that hasn't
        been seeded yet.
        """
        try:
            rows = db.fetch_all("SHOW TABLES LIKE 'system_llm_settings'")
            if len(rows) == 0:
                return config

            rows = db.fetch_all("SELECT * FROM system_llm_settings WHERE enabled = 1")

            if not isinstance(config.get('providers'), (dict, list)):
                config['providers'] = {}

            for row in rows:
                key = row['provider_key']
                built = LLMProviderResolver.buildProviderFromDb(row)

                if key in ROOT_PROVIDERS:
                    existing = config.get(key) if config.get(key) is not None else {}
                    config[key] = {**existing, **built}
                else:
                    existing = config['providers'].get(key) if config['providers'].get(key) is not None else {}
                    config['providers'][key] = {**existing, **built}
        except Exception as e:
            error_log(f"[LLMProviderResolver] applyDbSettings failed: {e}")

        return config

    @staticmethod
    def buildProviderFromDb(row: dict) -> dict:
        """Build a provider config block from one `system_llm_settings` row.
        Skips empty/null fields so a sparsely populated row doesn't clobber
        sensible defaults that downstream code may rely on.
        """
        cfg: dict = {}
        if not php_empty(row.get('display_name')):
            cfg['display_name'] = row['display_name']
        if not php_empty(row.get('model')):
            cfg['model'] = row['model']
        if not php_empty(row.get('api_key')):
            cfg['api_key'] = row['api_key']
        if not php_empty(row.get('base_url')):
            cfg['base_url'] = row['base_url']
        if not php_empty(row.get('chat_endpoint')):
            cfg['chat_endpoint'] = row['chat_endpoint']
        if not php_empty(row.get('api_format')):
            cfg['api_format'] = row['api_format']
        if row.get('max_tokens') is not None and row.get('max_tokens') != '':
            cfg['max_tokens'] = int(row['max_tokens'])
        if row.get('temperature') is not None and row.get('temperature') != '':
            cfg['temperature'] = float(row['temperature'])
        if not php_empty(row.get('system_prompt')):
            cfg['system_prompt'] = row['system_prompt']
        if row.get('streaming') is not None:
            cfg['streaming'] = _php_bool(row['streaming'])
        if row.get('supports_tools') is not None:
            cfg['supports_tools'] = _php_bool(row['supports_tools'])
        if not php_empty(row.get('supported_models')):
            try:
                decoded = json.loads(row['supported_models'])
            except (ValueError, TypeError):
                decoded = None
            if isinstance(decoded, (dict, list)):
                cfg['supported_models'] = decoded
        return cfg
