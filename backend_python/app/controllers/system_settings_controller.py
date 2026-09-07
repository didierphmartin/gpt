"""Port of Controllers/SystemSettingsController.php (728 lines).

System Settings Controller

Handles system-wide settings including:
- LLM provider configurations
- Default provider settings
- Migration from config file to database

Admin gating: `_require_admin` is this controller's OWN copy of the check
(PHP has no shared helper — PackageController/VideoEditorController/
LoginAdminController/AffiliateController each carry a byte-identical copy of
the same three branches; see PHP grep in the task brief).

No runtime DDL (constraints.md): PHP's `ensurePriceColumnsExist()`
(SystemSettingsController.php:41-54) issues `ALTER TABLE ... ADD COLUMN`
for `price_input_per_1m`/`price_output_per_1m` on every request, catching
and ignoring "already exists". This port only CHECKS presence (via the
shared `DbPresence` column check) and logs when a column is missing — it
never issues DDL. On the live shared DB both columns already exist (added
by PHP long ago), so this is a no-op in practice; a fresh DB missing the
columns would behave differently here than under PHP (PHP self-heals via
ALTER, this port does not) — that gap is explicitly allowed by the no-DDL
constraint.
"""
from __future__ import annotations

from app.support.db_presence import DbPresence
from app.support.phpcompat import (
    php_bool,
    php_coalesce,
    php_empty,
    php_floatval,
    php_intval,
    php_items,
    ucfirst,
)
from app.support.phpjson import php_json_decode, php_json_encode


class SystemSettingsController:
    # Allowed API formats for validation (SystemSettingsController.php:24)
    ALLOWED_API_FORMATS = ['openai', 'anthropic', 'gemini', 'custom']

    # Top-level provider keys that have dedicated config sections (php:27)
    TOP_LEVEL_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'gamma4', 'glm']

    # Provider-specific defaults used by _get_providers_from_config
    # (SystemSettingsController.php:152-217)
    _PROVIDER_DEFAULTS = {
        'claude': {
            'display_name': 'Claude',
            'base_url': 'https://api.anthropic.com',
            'model': 'claude-sonnet-4-5',
            'max_tokens': 64000,
            'api_format': 'anthropic',
            'chat_endpoint': '/v1/messages',
        },
        'openai': {
            'display_name': 'OpenAI',
            'base_url': 'https://api.openai.com',
            'model': 'gpt-4o',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/v1/chat/completions',
        },
        'gemini': {
            'display_name': 'Gemini',
            'base_url': 'https://generativelanguage.googleapis.com',
            'model': 'gemini-2.0-flash',
            'max_tokens': 8192,
            'api_format': 'gemini',
            'chat_endpoint': '/v1beta/models',
        },
        'grok': {
            'display_name': 'Grok',
            'base_url': 'https://api.x.ai',
            'model': 'grok-2-latest',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/v1/chat/completions',
        },
        'deepseek': {
            'display_name': 'DeepSeek',
            'base_url': 'https://api.deepseek.com',
            'model': 'deepseek-chat',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/v1/chat/completions',
        },
        'kimi': {
            'display_name': 'Kimi',
            'base_url': 'https://api.moonshot.cn',
            'model': 'moonshot-v1-auto',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/v1/chat/completions',
        },
        'gamma4': {
            'display_name': 'Gamma4',
            'base_url': 'https://g4eb.yellowbrickroad.info',
            'model': 'Gemma-4-E4B-it',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/v1/chat/completions',
        },
        'glm': {
            'display_name': 'GLM 5.2',
            'base_url': 'https://api.z.ai/api/paas/v4',
            'model': 'glm-5.2',
            'max_tokens': 4096,
            'api_format': 'openai',
            'chat_endpoint': '/chat/completions',
        },
    }

    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self._presence = DbPresence(db, 'SystemSettingsController')

    # ─── column presence (php:41-54) ────────────────────────────────────

    def _ensure_price_columns(self) -> None:
        self._presence.column('system_llm_settings', 'price_input_per_1m')
        self._presence.column('system_llm_settings', 'price_output_per_1m')

    # ─── admin gate (php:60-86) ──────────────────────────────────────────

    def _require_admin(self, request) -> dict | None:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        user = self.db.fetch_one('SELECT role FROM users WHERE id = :user_id', {':user_id': user_id})

        if not user or user.get('role') != 'admin':
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}

        return None

    # ─── getLLMProviders (php:92-141) ───────────────────────────────────

    def getLLMProviders(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        try:
            self._ensure_price_columns()
            sql = 'SELECT * FROM system_llm_settings ORDER BY sort_order ASC, display_name ASC'
            providers = self.db.fetch_all(sql)

            if not providers:
                return self._get_providers_from_config()

            for provider in providers:
                provider['api_key_masked'] = self._mask_api_key(provider.get('api_key'))
                # Keep actual api_key for admin editing (admin-only endpoint)
                raw_models = provider['supported_models'] if provider.get('supported_models') is not None else '[]'
                provider['supported_models'] = php_json_decode(raw_models)
                provider['streaming'] = php_bool(provider['streaming'])
                provider['supports_tools'] = php_bool(provider['supports_tools'])
                provider['enabled'] = php_bool(provider['enabled'])
                provider['max_tokens'] = php_intval(provider['max_tokens'])
                provider['temperature'] = php_floatval(provider['temperature'])
                provider['sort_order'] = php_intval(provider['sort_order'])
                provider['price_input_per_1m'] = (
                    php_floatval(provider['price_input_per_1m'])
                    if provider.get('price_input_per_1m') is not None else None
                )
                provider['price_output_per_1m'] = (
                    php_floatval(provider['price_output_per_1m'])
                    if provider.get('price_output_per_1m') is not None else None
                )

            return {'success': True, 'providers': providers, 'source': 'database', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to fetch LLM providers: {e}', 'status_code': 500}

    # ─── getProvidersFromConfig (php:146-289) ───────────────────────────

    def _get_providers_from_config(self) -> dict:
        providers = []
        sort_order = 0

        for key in self.TOP_LEVEL_PROVIDERS:
            cfg = self.config.get(key)
            if cfg is None:
                continue
            defaults = self._PROVIDER_DEFAULTS.get(key, {})
            providers.append({
                'id': None,
                'provider_key': key,
                'display_name': php_coalesce(cfg.get('display_name'), defaults.get('display_name'), ucfirst(key)),
                'api_key': php_coalesce(cfg.get('api_key'), ''),
                'api_key_masked': self._mask_api_key(cfg.get('api_key') if cfg.get('api_key') is not None else ''),
                'model': php_coalesce(cfg.get('model'), defaults.get('model'), ''),
                'base_url': php_coalesce(cfg.get('base_url'), defaults.get('base_url'), ''),
                'max_tokens': php_intval(php_coalesce(cfg.get('max_tokens'), defaults.get('max_tokens'), 4096)),
                'temperature': php_floatval(php_coalesce(cfg.get('temperature'), 0.7)),
                'price_input_per_1m': (
                    php_floatval(cfg['price_input_per_1m']) if cfg.get('price_input_per_1m') is not None else None
                ),
                'price_output_per_1m': (
                    php_floatval(cfg['price_output_per_1m']) if cfg.get('price_output_per_1m') is not None else None
                ),
                'chat_endpoint': php_coalesce(cfg.get('chat_endpoint'), defaults.get('chat_endpoint'),
                                              '/v1/chat/completions'),
                'streaming': php_bool(php_coalesce(cfg.get('streaming'), True)),
                'supports_tools': php_bool(php_coalesce(cfg.get('supports_tools'), True)),
                'supported_models': php_coalesce(cfg.get('supported_models'), []),
                'api_format': php_coalesce(cfg.get('api_format'), defaults.get('api_format'), 'openai'),
                'system_prompt': cfg.get('system_prompt'),
                'enabled': True,
                'sort_order': sort_order,
            })
            sort_order += 1

        custom_providers = self.config.get('providers')
        if isinstance(custom_providers, (dict, list)):
            for key, provider in php_items(custom_providers):
                if key in self.TOP_LEVEL_PROVIDERS and self.config.get(key) is not None:
                    continue
                if not isinstance(provider, dict):
                    provider = {}
                providers.append({
                    'id': None,
                    'provider_key': key,
                    'display_name': php_coalesce(provider.get('display_name'), ucfirst(str(key))),
                    'api_key': php_coalesce(provider.get('api_key'), ''),
                    'api_key_masked': self._mask_api_key(
                        provider.get('api_key') if provider.get('api_key') is not None else ''),
                    'model': php_coalesce(provider.get('model'), ''),
                    'base_url': php_coalesce(provider.get('base_url'), ''),
                    'max_tokens': php_intval(php_coalesce(provider.get('max_tokens'), 4096)),
                    'temperature': php_floatval(php_coalesce(provider.get('temperature'), 0.7)),
                    'price_input_per_1m': (
                        php_floatval(provider['price_input_per_1m'])
                        if provider.get('price_input_per_1m') is not None else None
                    ),
                    'price_output_per_1m': (
                        php_floatval(provider['price_output_per_1m'])
                        if provider.get('price_output_per_1m') is not None else None
                    ),
                    'chat_endpoint': php_coalesce(provider.get('chat_endpoint'), '/v1/chat/completions'),
                    'streaming': php_bool(php_coalesce(provider.get('streaming'), True)),
                    'supports_tools': php_bool(php_coalesce(provider.get('supports_tools'), True)),
                    'supported_models': php_coalesce(provider.get('supported_models'), []),
                    'api_format': php_coalesce(provider.get('api_format'), 'openai'),
                    'system_prompt': provider.get('system_prompt'),
                    'enabled': True,
                    'sort_order': sort_order,
                })
                sort_order += 1

        return {'success': True, 'providers': providers, 'source': 'config', 'status_code': 200}

    # ─── getLLMProvider (php:294-349) ───────────────────────────────────

    def getLLMProvider(self, request, key=None) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        provider_key = key

        if not provider_key:
            return {'success': False, 'error': 'Provider key is required', 'status_code': 400}

        try:
            self._ensure_price_columns()
            sql = 'SELECT * FROM system_llm_settings WHERE provider_key = :key'
            provider = self.db.fetch_one(sql, {':key': provider_key})

            if not provider:
                return {'success': False, 'error': 'Provider not found', 'status_code': 404}

            provider['api_key_masked'] = self._mask_api_key(provider.get('api_key'))
            # Keep actual api_key for admin editing (admin-only endpoint)
            raw_models = provider['supported_models'] if provider.get('supported_models') is not None else '[]'
            provider['supported_models'] = php_json_decode(raw_models)
            provider['streaming'] = php_bool(provider['streaming'])
            provider['supports_tools'] = php_bool(provider['supports_tools'])
            provider['enabled'] = php_bool(provider['enabled'])
            provider['price_input_per_1m'] = (
                php_floatval(provider['price_input_per_1m'])
                if provider.get('price_input_per_1m') is not None else None
            )
            provider['price_output_per_1m'] = (
                php_floatval(provider['price_output_per_1m'])
                if provider.get('price_output_per_1m') is not None else None
            )

            return {'success': True, 'provider': provider, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to fetch provider: {e}', 'status_code': 500}

    # ─── saveLLMProvider (php:354-485) ──────────────────────────────────

    def saveLLMProvider(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        body = request.get('body') or {}

        provider_key = body.get('provider_key')
        if not provider_key:
            return {'success': False, 'error': 'Provider key is required', 'status_code': 400}

        display_name = php_coalesce(body.get('display_name'), ucfirst(str(provider_key)))
        model = body.get('model')
        if not model:
            return {'success': False, 'error': 'Model is required', 'status_code': 400}

        api_format = php_coalesce(body.get('api_format'), 'openai')
        if api_format not in self.ALLOWED_API_FORMATS:
            return {
                'success': False,
                'error': 'Invalid api_format. Allowed values: ' + ', '.join(self.ALLOWED_API_FORMATS),
                'status_code': 400,
            }

        try:
            self._ensure_price_columns()
            existing = self.db.fetch_one(
                'SELECT id, api_key FROM system_llm_settings WHERE provider_key = :key', {':key': provider_key})

            api_key = body.get('api_key')
            if existing and (php_empty(api_key) or (isinstance(api_key, str) and '***' in api_key)):
                api_key = existing['api_key']

            supported_models = body.get('supported_models')
            if supported_models is None:
                supported_models = []
            if isinstance(supported_models, (list, dict)):
                supported_models = php_json_encode(supported_models)

            price_input = (
                php_floatval(body['price_input_per_1m'])
                if 'price_input_per_1m' in body and body['price_input_per_1m'] not in ('', None) else None
            )
            price_output = (
                php_floatval(body['price_output_per_1m'])
                if 'price_output_per_1m' in body and body['price_output_per_1m'] not in ('', None) else None
            )

            if existing:
                sql = ('UPDATE system_llm_settings SET display_name = :display_name, api_key = :api_key,'
                       ' model = :model, base_url = :base_url, max_tokens = :max_tokens,'
                       ' temperature = :temperature, price_input_per_1m = :price_input_per_1m,'
                       ' price_output_per_1m = :price_output_per_1m, chat_endpoint = :chat_endpoint,'
                       ' streaming = :streaming, supports_tools = :supports_tools,'
                       ' supported_models = :supported_models, api_format = :api_format,'
                       ' system_prompt = :system_prompt, enabled = :enabled, sort_order = :sort_order,'
                       ' updated_at = NOW() WHERE provider_key = :provider_key')
            else:
                sql = ('INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url,'
                       ' max_tokens, temperature, price_input_per_1m, price_output_per_1m, chat_endpoint,'
                       ' streaming, supports_tools, supported_models, api_format, system_prompt, enabled,'
                       ' sort_order, created_at, updated_at) VALUES (:provider_key, :display_name, :api_key,'
                       ' :model, :base_url, :max_tokens, :temperature, :price_input_per_1m,'
                       ' :price_output_per_1m, :chat_endpoint, :streaming, :supports_tools, :supported_models,'
                       ' :api_format, :system_prompt, :enabled, :sort_order, NOW(), NOW())')

            self.db.execute(sql, {
                ':provider_key': provider_key,
                ':display_name': display_name,
                ':api_key': api_key,
                ':model': model,
                ':base_url': body.get('base_url'),
                ':max_tokens': php_intval(php_coalesce(body.get('max_tokens'), 4096)),
                ':temperature': php_floatval(php_coalesce(body.get('temperature'), 0.7)),
                ':price_input_per_1m': price_input,
                ':price_output_per_1m': price_output,
                ':chat_endpoint': body.get('chat_endpoint'),
                ':streaming': php_intval(php_coalesce(body.get('streaming'), 1)),
                ':supports_tools': php_intval(php_coalesce(body.get('supports_tools'), 1)),
                ':supported_models': supported_models,
                ':api_format': php_coalesce(body.get('api_format'), 'openai'),
                ':system_prompt': body.get('system_prompt'),
                ':enabled': php_intval(php_coalesce(body.get('enabled'), 1)),
                ':sort_order': php_intval(php_coalesce(body.get('sort_order'), 0)),
            })

            return {
                'success': True,
                'message': 'Provider updated' if existing else 'Provider created',
                'provider_key': provider_key,
                'status_code': 200 if existing else 201,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to save provider: {e}', 'status_code': 500}

    # ─── deleteLLMProvider (php:490-534) ────────────────────────────────

    def deleteLLMProvider(self, request, key=None) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        provider_key = key

        if not provider_key:
            return {'success': False, 'error': 'Provider key is required', 'status_code': 400}

        try:
            existing = self.db.fetch_one(
                'SELECT id FROM system_llm_settings WHERE provider_key = :key', {':key': provider_key})
            if not existing:
                return {'success': False, 'error': 'Provider not found', 'status_code': 404}

            self.db.execute('DELETE FROM system_llm_settings WHERE provider_key = :key', {':key': provider_key})

            return {'success': True, 'message': 'Provider deleted', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to delete provider: {e}', 'status_code': 500}

    # ─── seedFromConfig (php:540-592) ───────────────────────────────────

    def seedFromConfig(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        try:
            self.db.begin()

            seeded = []
            sort_order = 0

            for key in self.TOP_LEVEL_PROVIDERS:
                cfg = self.config.get(key)
                if cfg is not None:
                    api_format = 'anthropic' if key == 'claude' else ('gemini' if key == 'gemini' else 'openai')
                    self._seed_provider(key, cfg, api_format, sort_order)
                    sort_order += 1
                    seeded.append(key)

            custom_providers = self.config.get('providers')
            if isinstance(custom_providers, (dict, list)):
                for key, provider in php_items(custom_providers):
                    if key in seeded:
                        continue
                    if not isinstance(provider, dict):
                        provider = {}
                    api_format = php_coalesce(provider.get('api_format'), 'openai')
                    self._seed_provider(key, provider, api_format, sort_order)
                    sort_order += 1
                    seeded.append(key)

            self.db.commit()

            return {
                'success': True,
                'message': 'Providers seeded from config',
                'seeded': seeded,
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            return {'success': False, 'error': f'Failed to seed providers: {e}', 'status_code': 500}

    # ─── seedProvider (php:597-658) ─────────────────────────────────────

    def _seed_provider(self, key, config: dict, api_format: str, sort_order: int) -> None:
        self._ensure_price_columns()

        supported_models = config.get('supported_models')
        if supported_models is None:
            supported_models = []
        if isinstance(supported_models, (list, dict)):
            supported_models = php_json_encode(supported_models)

        price_input = php_floatval(config['price_input_per_1m']) if config.get('price_input_per_1m') is not None \
            else None
        price_output = php_floatval(config['price_output_per_1m']) if config.get('price_output_per_1m') is not None \
            else None

        sql = ('INSERT INTO system_llm_settings (provider_key, display_name, api_key, model, base_url, max_tokens,'
               ' temperature, price_input_per_1m, price_output_per_1m, chat_endpoint, streaming, supports_tools,'
               ' supported_models, api_format, system_prompt, enabled, sort_order, created_at, updated_at)'
               ' VALUES (:provider_key, :display_name, :api_key, :model, :base_url, :max_tokens, :temperature,'
               ' :price_input_per_1m, :price_output_per_1m, :chat_endpoint, :streaming, :supports_tools,'
               ' :supported_models, :api_format, :system_prompt, :enabled, :sort_order, NOW(), NOW())'
               ' ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), api_key = VALUES(api_key),'
               ' model = VALUES(model), base_url = VALUES(base_url), max_tokens = VALUES(max_tokens),'
               ' temperature = VALUES(temperature), price_input_per_1m = VALUES(price_input_per_1m),'
               ' price_output_per_1m = VALUES(price_output_per_1m), chat_endpoint = VALUES(chat_endpoint),'
               ' streaming = VALUES(streaming), supports_tools = VALUES(supports_tools),'
               ' supported_models = VALUES(supported_models), api_format = VALUES(api_format),'
               ' system_prompt = VALUES(system_prompt), sort_order = VALUES(sort_order), updated_at = NOW()')

        self.db.execute(sql, {
            ':provider_key': key,
            ':display_name': php_coalesce(config.get('display_name'), ucfirst(str(key))),
            ':api_key': config.get('api_key'),
            ':model': php_coalesce(config.get('model'), ''),
            ':base_url': config.get('base_url'),
            ':max_tokens': php_intval(php_coalesce(config.get('max_tokens'), 4096)),
            ':temperature': php_floatval(php_coalesce(config.get('temperature'), 0.7)),
            ':price_input_per_1m': price_input,
            ':price_output_per_1m': price_output,
            ':chat_endpoint': config.get('chat_endpoint'),
            ':streaming': php_intval(php_coalesce(config.get('streaming'), 1)),
            ':supports_tools': php_intval(php_coalesce(config.get('supports_tools'), 1)),
            ':supported_models': supported_models,
            ':api_format': api_format,
            ':system_prompt': config.get('system_prompt'),
            ':enabled': 1,
            ':sort_order': sort_order,
        })

    # ─── maskApiKey (php:663-669) ────────────────────────────────────────

    def _mask_api_key(self, api_key) -> str:
        if php_empty(api_key) or len(api_key) < 12:
            return '***'
        return api_key[:4] + '***' + api_key[-4:]

    # ─── toggleProvider (php:674-727) ───────────────────────────────────

    def toggleProvider(self, request) -> dict:
        err = self._require_admin(request)
        if err:
            return err

        body = request.get('body') or {}
        provider_key = body.get('provider_key')
        enabled = php_bool(body['enabled']) if ('enabled' in body and body['enabled'] is not None) else None

        if not provider_key:
            return {'success': False, 'error': 'Provider key is required', 'status_code': 400}

        try:
            if enabled is None:
                sql = 'UPDATE system_llm_settings SET enabled = NOT enabled, updated_at = NOW() WHERE provider_key = :key'
            else:
                sql = 'UPDATE system_llm_settings SET enabled = :enabled, updated_at = NOW() WHERE provider_key = :key'

            params = {':key': provider_key}
            if enabled is not None:
                params[':enabled'] = php_intval(enabled)
            rowcount = self.db.execute(sql, params)

            if rowcount == 0:
                return {'success': False, 'error': 'Provider not found', 'status_code': 404}

            return {'success': True, 'message': 'Provider toggled', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to toggle provider: {e}', 'status_code': 500}
