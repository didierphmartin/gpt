"""Port of Controllers/SettingsController.php.

Settings Controller

Handles user settings including:
- Usage statistics
- Custom API keys
- Provider settings (avatar/voice)
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

from app.config import PHP_BACKEND
from app.services.package_resolver import PackageResolver
from app.support.crypto import aes256cbc_decrypt, aes256cbc_encrypt
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import (
    is_numeric,
    php_array,
    php_bool,
    php_date,
    php_empty,
    php_floatval,
    php_intval,
    php_items,
    php_strval,
    php_trim,
)
from app.support.phpjson import php_json_encode


class SettingsController:
    # Canonical name of the user's local data folder. Hardcoded everywhere
    # else in the project (skills root at ~/Documents/synergyAI/skills/,
    # Pyodide mounts, workflow output paths). Storing this as a constant
    # here lets us enforce it in storage settings so a stale install-wizard
    # value can't drift the folder name out of sync with the rest of the
    # codebase.
    OFFICIAL_USER_FOLDER = 'synergyAI'

    UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs'
    ROOT_FOLDER = 'synergyaichatroot'

    # SettingsController.php:1332 — `__DIR__ . '/../../../../storage'` from
    # backend/src/Controllers, i.e. htdocs/storage (same physical directory).
    DEFAULT_STORAGE_PATH = str(Path(PHP_BACKEND).parent.parent / 'storage')

    def __init__(self, db, config):
        self.db = db
        self.config = config
        auth = config.get('auth') or {}
        self.encryptionKey = auth['jwt_secret'] if auth.get('jwt_secret') is not None \
            else 'default-encryption-key-change-this'
        self._presence = DbPresence(db, 'SettingsController')

    # ─── endpoints ─────────────────────────────────────────────────────────

    def getPhoneStatus(self, request) -> dict:
        """Get phone linking status for user."""
        userId = request['user_id']

        sql = "SELECT phone FROM users WHERE id = :user_id"
        user = self.db.fetch_one(sql, {':user_id': userId})

        return {
            'success': True,
            'phone': (user or {}).get('phone'),
            'has_phone': not php_empty((user or {}).get('phone')),
            'status_code': 200,
        }

    def getUsage(self, request) -> dict:
        """Get usage statistics."""
        userId = request['user_id']
        currentMonth = php_date('Y-m')

        # Get balance data for all providers
        sql = ("SELECT provider, month_requests, month_tokens, month_cost_usd,"
               " total_requests, total_tokens, total_cost_usd, monthly_budget_usd,"
               " monthly_request_limit, current_month"
               " FROM llm_usage_balance"
               " WHERE user_id = :user_id")

        balances = self.db.fetch_all(sql, {':user_id': userId})

        # Get stats per provider for this month (response time + input/output tokens)
        sql = ("SELECT provider, AVG(response_time_ms) as avg_response_time,"
               " SUM(prompt_tokens) as month_input_tokens,"
               " SUM(completion_tokens) as month_output_tokens,"
               " COUNT(*) as request_count"
               " FROM llm_usage_transactions"
               " WHERE user_id = :user_id"
               " AND created_at >= :month_start"
               " GROUP BY provider")

        monthStart = currentMonth + '-01'
        transactionStats = self.db.fetch_all(sql, {':user_id': userId, ':month_start': monthStart})

        # Build stats map (response time + token breakdown)
        statsMap = {}
        for stat in transactionStats:
            statsMap[stat['provider']] = {
                'avg_response_time': stat['avg_response_time'],
                'month_input_tokens': php_intval(stat['month_input_tokens']),
                'month_output_tokens': php_intval(stat['month_output_tokens']),
            }

        # Organize by provider
        byProvider = {}
        totalCost = 0
        totalTokens = 0
        totalRequests = 0

        for balance in balances:
            provider = balance['provider']
            stats = statsMap.get(provider) or {}
            byProvider[provider] = {
                'month_requests': php_intval(balance['month_requests']),
                'month_tokens': php_intval(balance['month_tokens']),
                'month_input_tokens': stats['month_input_tokens'] if stats.get('month_input_tokens') is not None else 0,
                'month_output_tokens': stats['month_output_tokens'] if stats.get('month_output_tokens') is not None else 0,
                'month_cost_usd': php_floatval(balance['month_cost_usd']),
                'total_requests': php_intval(balance['total_requests']),
                'total_tokens': php_intval(balance['total_tokens']),
                'total_cost_usd': php_floatval(balance['total_cost_usd']),
                'budget_limit': php_floatval(balance['monthly_budget_usd']),
                'request_limit': php_intval(balance['monthly_request_limit']),
                'avg_response_time': stats['avg_response_time'] if stats.get('avg_response_time') is not None else None,
            }

            totalCost += php_floatval(balance['month_cost_usd'])
            totalTokens += php_intval(balance['month_tokens'])
            totalRequests += php_intval(balance['month_requests'])

        # Get lifetime input/output token totals from transactions table
        lifetimeSql = ("SELECT COALESCE(SUM(prompt_tokens), 0) as lifetime_input_tokens,"
                       " COALESCE(SUM(completion_tokens), 0) as lifetime_output_tokens,"
                       " COALESCE(SUM(total_tokens), 0) as lifetime_total_tokens,"
                       " COALESCE(SUM(cost_usd), 0) as lifetime_cost_usd,"
                       " COUNT(*) as lifetime_requests"
                       " FROM llm_usage_transactions"
                       " WHERE user_id = :user_id")
        lifetime = self.db.fetch_one(lifetimeSql, {':user_id': userId}) or {}

        # Get user's plan and role to compute quota usage
        planSql = "SELECT plan, role FROM users WHERE id = :user_id"
        userRow = self.db.fetch_one(planSql, {':user_id': userId}) or {}

        return {
            'success': True,
            'usage': {
                'current_month': currentMonth,
                'by_provider': php_array(byProvider),
                'totals': {
                    'cost_usd': totalCost,
                    'tokens': totalTokens,
                    'requests': totalRequests,
                },
                'lifetime': {
                    'input_tokens': php_intval(lifetime['lifetime_input_tokens'] if lifetime.get('lifetime_input_tokens') is not None else 0),
                    'output_tokens': php_intval(lifetime['lifetime_output_tokens'] if lifetime.get('lifetime_output_tokens') is not None else 0),
                    'total_tokens': php_intval(lifetime['lifetime_total_tokens'] if lifetime.get('lifetime_total_tokens') is not None else 0),
                    'cost_usd': php_floatval(lifetime['lifetime_cost_usd'] if lifetime.get('lifetime_cost_usd') is not None else 0),
                    'requests': php_intval(lifetime['lifetime_requests'] if lifetime.get('lifetime_requests') is not None else 0),
                },
                'plan': userRow['plan'] if userRow.get('plan') is not None else 'free',
                'role': userRow['role'] if userRow.get('role') is not None else 'prospect',
                'free_trial_quota': 50000,
            },
            'status_code': 200,
        }

    def getKeys(self, request) -> dict:
        """Get user's custom API keys (masked)."""
        userId = request['user_id']

        self.ensureApiKeysTableExists()
        self.ensureUserModelsTableExists()

        if self._presence.column('user_api_keys', 'system_prompt'):
            sql = ("SELECT provider, api_key, system_prompt, created_at, updated_at"
                   " FROM user_api_keys"
                   " WHERE user_id = :user_id")
        else:
            # ensureApiKeysTableExists() ALTERs the column in for PHP before this
            # SELECT runs, so PHP reads NULL for every row; drop it and do the same.
            sql = ("SELECT provider, api_key, created_at, updated_at"
                   " FROM user_api_keys"
                   " WHERE user_id = :user_id")

        keys = self.db.fetch_all(sql, {':user_id': userId})

        result = {}
        systemPrompts = {}
        for key in keys:
            decrypted = self.decryptApiKey(key['api_key'])
            masked = '****' + decrypted[-4:] if not php_empty(decrypted) else None

            result[key['provider']] = {
                'has_custom_key': not php_empty(decrypted),
                'masked_key': masked,
                'updated_at': key['updated_at'],
            }

            # Per-provider system_prompt override (raw text, returned as-is).
            # Frontend prefills its textarea from this; null/missing = "no
            # override → using admin global or file default".
            if not php_empty(key.get('system_prompt')):
                systemPrompts[key['provider']] = key['system_prompt']

        # Load user model selections
        modelSql = "SELECT provider, model FROM user_model_selections WHERE user_id = :user_id"
        modelRows = self.db.fetch_all(modelSql, {':user_id': userId})

        models = {}
        for row in modelRows:
            models[row['provider']] = row['model']

        # Resolve the user's package so the UI can render the model lock:
        # when the user is on the package's API key (has_custom_key === false),
        # the package's default_model is authoritative and the user's saved
        # selection is ignored on the chat path. Frontend disables the
        # dropdown for those providers and shows package_models[provider].
        packageModels = {}
        locked = {}
        try:
            resolver = PackageResolver(self.db)
            userIdInt = php_intval(userId) if is_numeric(userId) else None
            package = resolver.resolveForUser(userIdInt)
            capabilities = package.get('capabilities')
            providersCfg = capabilities.get('providers') if isinstance(capabilities, dict) else None
            if providersCfg is None:
                providersCfg = []
            if isinstance(providersCfg, (dict, list)):
                for providerKey, providerCfg in php_items(providersCfg):
                    if not isinstance(providerCfg, (dict, list)) or php_empty(
                            providerCfg.get('enabled') if isinstance(providerCfg, dict) else None):
                        continue
                    defaultModel = php_trim(providerCfg['default_model']) \
                        if isinstance(providerCfg.get('default_model'), str) else ''
                    if defaultModel != '':
                        packageModels[providerKey] = defaultModel
                    hasOwnKey = not php_empty((result.get(providerKey) or {}).get('has_custom_key'))
                    locked[providerKey] = not hasOwnKey
        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] Package lookup failed in getKeys: ' + str(e))

        return {
            'success': True,
            'keys': php_array(result),
            'models': php_array(models),
            'package_models': php_array(packageModels),
            'locked': php_array(locked),
            'system_prompts': php_array(systemPrompts),
            'status_code': 200,
        }

    def saveKeys(self, request) -> dict:
        """Save user's custom API keys."""
        userId = request['user_id']
        body = request['body'] if request.get('body') is not None else {}
        keys = body['keys'] if body.get('keys') is not None else []
        models = body['models'] if body.get('models') is not None else []
        # Per-provider system_prompt overrides. Empty string clears the
        # override (falls back to admin global / file default). Missing entry
        # leaves the existing value untouched.
        systemPrompts = body['system_prompts'] if body.get('system_prompts') is not None else []

        validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']

        if php_empty(keys) and php_empty(models) and php_empty(systemPrompts):
            return {
                'success': False,
                'error': 'No keys, models, or system_prompts provided',
                'status_code': 400,
            }

        self.ensureApiKeysTableExists()
        self.ensureUserModelsTableExists()

        savedCount = 0

        # Save API keys
        for provider, apiKey in php_items(keys):
            if provider not in validProviders:
                continue

            if php_empty(php_trim(apiKey)):
                continue

            # Encrypt the API key
            encryptedKey = self.encryptApiKey(php_trim(apiKey))

            # Upsert the key. VALUES(api_key) references the would-be-inserted
            # row so we can bind :api_key only once — PDO with emulated prepares
            # off rejects the same placeholder appearing twice.
            sql = ("INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)"
                   " VALUES (:user_id, :provider, :api_key, NOW(), NOW())"
                   " ON DUPLICATE KEY UPDATE"
                   " api_key = VALUES(api_key),"
                   " updated_at = NOW()")

            self.db.execute(sql, {
                ':user_id': userId,
                ':provider': provider,
                ':api_key': encryptedKey,
            })

            savedCount += 1

        # Save model selections
        modelCount = 0
        for provider, model in php_items(models):
            if provider not in validProviders:
                continue

            if php_empty(php_trim(model)):
                continue

            sql = ("INSERT INTO user_model_selections (user_id, provider, model, updated_at)"
                   " VALUES (:user_id, :provider, :model, NOW())"
                   " ON DUPLICATE KEY UPDATE"
                   " model = VALUES(model),"
                   " updated_at = NOW()")

            self.db.execute(sql, {
                ':user_id': userId,
                ':provider': provider,
                ':model': php_trim(model),
            })

            modelCount += 1

        # Save per-provider system_prompt overrides. Empty string clears the
        # override (column set to NULL → falls back to admin / file default).
        # Stored on user_api_keys so a single row holds all per-(user,provider)
        # overrides; the row is created even when no api_key is set.
        promptCount = 0
        for provider, prompt in php_items(systemPrompts):
            if provider not in validProviders:
                continue
            if not isinstance(prompt, str):
                continue

            value = php_trim(prompt)
            stored = None if value == '' else value

            # Upsert. Insert path needs an api_key column (NOT NULL); use
            # empty string as a placeholder when the user only supplies a
            # prompt — applyUserApiKeys decrypts it and skips if blank.
            sql = ("INSERT INTO user_api_keys (user_id, provider, api_key, system_prompt, created_at, updated_at)"
                   " VALUES (:user_id, :provider, '', :system_prompt, NOW(), NOW())"
                   " ON DUPLICATE KEY UPDATE"
                   " system_prompt = VALUES(system_prompt),"
                   " updated_at = NOW()")

            self.db.execute(sql, {
                ':user_id': userId,
                ':provider': provider,
                ':system_prompt': stored,
            })

            promptCount += 1

        return {
            'success': True,
            'message': f'Saved {savedCount} API key(s), {modelCount} model(s), {promptCount} system prompt(s)',
            'saved_count': savedCount,
            'model_count': modelCount,
            'prompt_count': promptCount,
            'status_code': 200,
        }

    def clearKeys(self, request) -> dict:
        """Clear all user's custom API keys."""
        userId = request['user_id']

        self.ensureApiKeysTableExists()
        self.ensureUserModelsTableExists()

        sql = "DELETE FROM user_api_keys WHERE user_id = :user_id"
        deletedCount = self.db.execute(sql, {':user_id': userId})

        modelSql = "DELETE FROM user_model_selections WHERE user_id = :user_id"
        modelDeletedCount = self.db.execute(modelSql, {':user_id': userId})

        return {
            'success': True,
            'message': f'Cleared {deletedCount} API key(s) and {modelDeletedCount} model selection(s)',
            'deleted_count': deletedCount,
            'status_code': 200,
        }

    def getProviderSettings(self, request) -> dict:
        """Get provider settings (avatar/voice)."""
        userId = request['user_id']

        self.ensureProviderSettingsTableExists()
        self.ensureCategorySettingsTableExists()

        # Get category-level enabled settings
        categorySql = "SELECT category, enabled FROM user_category_settings WHERE user_id = :user_id"
        categoryRows = self.db.fetch_all(categorySql, {':user_id': userId})

        categoryEnabled = {'avatar': True, 'voice': True}
        for row in categoryRows:
            categoryEnabled[row['category']] = php_bool(row['enabled'])

        # Get provider-level settings
        if self._presence.column('user_provider_settings', 'enabled'):
            sql = ("SELECT category, provider, api_key, settings, is_active, enabled"
                   " FROM user_provider_settings"
                   " WHERE user_id = :user_id")
        else:
            # ensureProviderSettingsTableExists() ALTERs `enabled TINYINT(1) NOT NULL
            # DEFAULT 1` in for PHP first, so every row reads back enabled=1; drop the
            # column and let the isset() branch below yield the same `true`.
            sql = ("SELECT category, provider, api_key, settings, is_active"
                   " FROM user_provider_settings"
                   " WHERE user_id = :user_id")

        rows = self.db.fetch_all(sql, {':user_id': userId})

        result = {
            'avatar': {'active': None, 'enabled': categoryEnabled['avatar'], 'providers': {}},
            'voice': {'active': None, 'enabled': categoryEnabled['voice'], 'providers': {}},
        }

        for row in rows:
            category = row['category']
            provider = row['provider']
            hasKey = not php_empty(row['api_key'])
            settings = self._jsonDecode(row['settings']) if not php_empty(row['settings']) else None
            enabled = php_bool(row['enabled']) if row.get('enabled') is not None else True

            if category not in result:      # PHP auto-vivifies; only avatar/voice are returned
                result[category] = {'providers': {}}
            result[category]['providers'][provider] = {
                'has_key': hasKey,
                'settings': php_array(settings) if isinstance(settings, dict) else settings,
                'enabled': enabled,
            }

            if row['is_active'] == 1 or row['is_active'] is True:
                result[category]['active'] = provider

        return {
            'success': True,
            'avatar': dict(result['avatar'], providers=php_array(result['avatar']['providers'])),
            'voice': dict(result['voice'], providers=php_array(result['voice']['providers'])),
            'status_code': 200,
        }

    def saveProvider(self, request) -> dict:
        """Save a provider configuration."""
        userId = request['user_id']
        input_ = request['body']

        category = input_['category'] if input_.get('category') is not None else ''
        provider = input_['provider'] if input_.get('provider') is not None else ''
        apiKey = input_.get('api_key')
        settings = input_.get('settings')

        # Validate category
        if category not in ('avatar', 'voice'):
            return {
                'success': False,
                'error': 'Invalid category. Must be "avatar" or "voice"',
                'status_code': 400,
            }

        # Validate provider names
        validAvatarProviders = ['did', 'anam', 'heygen', 'tavus']
        validVoiceProviders = ['gemini', 'grok', 'hume', 'elevenlabs']

        if category == 'avatar' and provider not in validAvatarProviders:
            return {
                'success': False,
                'error': 'Invalid avatar provider',
                'status_code': 400,
            }
        if category == 'voice' and provider not in validVoiceProviders:
            return {
                'success': False,
                'error': 'Invalid voice provider',
                'status_code': 400,
            }

        self.ensureProviderSettingsTableExists()

        # Encrypt API key if provided
        encryptedKey = None
        if not php_empty(apiKey) and php_trim(apiKey) != '':
            encryptedKey = self.encryptApiKey(php_trim(apiKey))

        # Parse settings if string
        if isinstance(settings, str):
            settings = self._jsonDecode(settings)
        settingsJson = php_json_encode(settings) if not php_empty(settings) else None

        # Check if record exists
        checkSql = ("SELECT id, api_key FROM user_provider_settings"
                    " WHERE user_id = :user_id AND category = :category AND provider = :provider")
        existing = self.db.fetch_one(checkSql, {
            ':user_id': userId,
            ':category': category,
            ':provider': provider,
        })

        if existing:
            # Update existing record
            if encryptedKey is not None:
                sql = ("UPDATE user_provider_settings"
                       " SET api_key = :api_key, settings = :settings, updated_at = NOW()"
                       " WHERE user_id = :user_id AND category = :category AND provider = :provider")
                params = {
                    ':user_id': userId,
                    ':category': category,
                    ':provider': provider,
                    ':api_key': encryptedKey,
                    ':settings': settingsJson,
                }
            else:
                sql = ("UPDATE user_provider_settings"
                       " SET settings = :settings, updated_at = NOW()"
                       " WHERE user_id = :user_id AND category = :category AND provider = :provider")
                params = {
                    ':user_id': userId,
                    ':category': category,
                    ':provider': provider,
                    ':settings': settingsJson,
                }
            self.db.execute(sql, params)
        else:
            # Insert new record
            sql = ("INSERT INTO user_provider_settings"
                   " (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)"
                   " VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())")
            self.db.execute(sql, {
                ':user_id': userId,
                ':category': category,
                ':provider': provider,
                ':api_key': encryptedKey,
                ':settings': settingsJson,
            })

        return {
            'success': True,
            'message': f"Provider '{provider}' saved for {category}",
            'status_code': 200,
        }

    def setActiveProvider(self, request) -> dict:
        """Set active provider for a category."""
        userId = request['user_id']
        input_ = request['body']

        category = input_['category'] if input_.get('category') is not None else ''
        provider = input_['provider'] if input_.get('provider') is not None else ''

        if category not in ('avatar', 'voice'):
            return {
                'success': False,
                'error': 'Invalid category. Must be "avatar" or "voice"',
                'status_code': 400,
            }

        if php_empty(provider):
            return {
                'success': False,
                'error': 'Provider is required',
                'status_code': 400,
            }

        self.ensureProviderSettingsTableExists()

        # Verify the provider exists for this user
        checkSql = ("SELECT id FROM user_provider_settings"
                    " WHERE user_id = :user_id AND category = :category AND provider = :provider")
        found = self.db.fetch_one(checkSql, {
            ':user_id': userId,
            ':category': category,
            ':provider': provider,
        })

        if not found:
            return {
                'success': False,
                'error': f"Provider '{provider}' not configured for {category}",
                'status_code': 400,
            }

        # Deactivate all providers in this category for this user
        deactivateSql = ("UPDATE user_provider_settings"
                         " SET is_active = 0"
                         " WHERE user_id = :user_id AND category = :category")
        self.db.execute(deactivateSql, {
            ':user_id': userId,
            ':category': category,
        })

        # Activate the selected provider
        activateSql = ("UPDATE user_provider_settings"
                       " SET is_active = 1, updated_at = NOW()"
                       " WHERE user_id = :user_id AND category = :category AND provider = :provider")
        self.db.execute(activateSql, {
            ':user_id': userId,
            ':category': category,
            ':provider': provider,
        })

        return {
            'success': True,
            'message': f"Active {category} provider set to '{provider}'",
            'status_code': 200,
        }

    def deleteProvider(self, request) -> dict:
        """Delete a provider configuration."""
        userId = request['user_id']
        input_ = request['body']

        category = input_['category'] if input_.get('category') is not None else ''
        provider = input_['provider'] if input_.get('provider') is not None else ''

        if category not in ('avatar', 'voice'):
            return {
                'success': False,
                'error': 'Invalid category. Must be "avatar" or "voice"',
                'status_code': 400,
            }

        if php_empty(provider):
            return {
                'success': False,
                'error': 'Provider is required',
                'status_code': 400,
            }

        self.ensureProviderSettingsTableExists()

        sql = ("DELETE FROM user_provider_settings"
               " WHERE user_id = :user_id AND category = :category AND provider = :provider")
        deletedCount = self.db.execute(sql, {
            ':user_id': userId,
            ':category': category,
            ':provider': provider,
        })

        return {
            'success': True,
            'message': (f"Provider '{provider}' deleted from {category}" if deletedCount > 0
                        else f"Provider '{provider}' was not configured for {category}"),
            'deleted': deletedCount > 0,
            'status_code': 200,
        }

    # ─── ensure* (no runtime DDL — presence check + error_log only) ────────

    def ensureApiKeysTableExists(self) -> None:
        """PHP CREATEs `user_api_keys` (+ the idempotent system_prompt ALTER) on demand;
        the Python port never issues DDL — it only reports what is missing."""
        if self._presence.table('user_api_keys'):
            self._presence.column('user_api_keys', 'system_prompt')

    def ensureUserModelsTableExists(self) -> None:
        self._presence.table('user_model_selections')

    def ensureProviderSettingsTableExists(self) -> None:
        if self._presence.table('user_provider_settings'):
            self._presence.column('user_provider_settings', 'enabled')

    def ensureCategorySettingsTableExists(self) -> None:
        self._presence.table('user_category_settings')

    def ensureStorageColumnsExist(self) -> None:
        for column in ('storage_provider', 'storage_folder', 'universalfs_api_key'):
            self._presence.column('users', column)

    def ensureHealColumnsExist(self) -> None:
        for column in ('heal_mode', 'heal_daily_budget_usd', 'heal_per_heal_ceiling_usd',
                       'heal_eval_provider', 'heal_proposer_provider', 'heal_judge_provider',
                       'heal_max_iterations', 'heal_runs_per_query'):
            self._presence.column('users', column)

    def ensureGenesisColumnsExist(self) -> None:
        for column in ('genesis_mode', 'genesis_daily_budget_usd', 'genesis_per_skill_ceiling_usd',
                       'genesis_max_skills_per_week', 'genesis_reflection_provider'):
            self._presence.column('users', column)

    # ─── crypto ────────────────────────────────────────────────────────────

    def encryptApiKey(self, apiKey: str) -> str:
        """Encrypt API key for storage."""
        key = hashlib.sha256(self.encryptionKey.encode()).digest()
        iv = os.urandom(16)
        encrypted = aes256cbc_encrypt(apiKey.encode('utf-8'), key, iv)
        return base64.b64encode(iv + encrypted).decode('ascii')

    def decryptApiKey(self, encryptedKey: str) -> str | None:
        """Decrypt API key from storage."""
        try:
            try:
                data = base64.b64decode(encryptedKey, validate=False)
            except Exception:  # noqa: BLE001 — base64_decode() === false
                return None
            if len(data) < 17:
                return None

            key = hashlib.sha256(self.encryptionKey.encode()).digest()
            iv = data[:16]
            encrypted = data[16:]

            decrypted = aes256cbc_decrypt(encrypted, key, iv)
            if decrypted is None:
                return None
            try:
                return decrypted.decode('utf-8')
            except Exception:  # noqa: BLE001
                return None
        except Exception:  # noqa: BLE001
            return None

    # ─── Auto-heal settings (self-healing mode + cost guards) ───────────────
    # Persisted per-user as columns on `users` (mirrors storage settings).
    # Default mode 'off' = the system only diagnoses (free), never spends.

    def healDefaults(self) -> dict:
        return {
            'heal_mode': 'off',                   # off | ask | auto
            'heal_daily_budget_usd': 5.00,        # hard cap on heal spend/day
            'heal_per_heal_ceiling_usd': 1.00,    # auto only heals if estimate < this
            'heal_proposer_provider': 'claude',   # PROPOSER: rewrites SKILL.md (strong model)
            'heal_eval_provider': 'kimi',         # EVALUATOR fallback
            'heal_judge_provider': 'kimi',        # JUDGE: scores transcripts (cheap, reliable)
            'heal_max_iterations': 3,             # SkillOpt I
            'heal_runs_per_query': 3,             # SkillOpt R
        }

    def getHealSettings(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        defaults = self.healDefaults()
        try:
            self.ensureHealColumnsExist()
            row = self.db.fetch_one(
                "SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd,"
                " heal_proposer_provider, heal_eval_provider, heal_judge_provider,"
                " heal_max_iterations, heal_runs_per_query"
                " FROM users WHERE id = ?",
                [userId],
            ) or {}
            s = dict(defaults)
            for k, def_ in defaults.items():
                if row.get(k) is not None:
                    s[k] = self._coerceLike(def_, row[k])
            return {'success': True, 'settings': s}
        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] getHealSettings failed: ' + str(e))
            return {'success': True, 'settings': defaults}

    def saveHealSettings(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        b = request['body'] if request.get('body') is not None else {}
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']
        mode = b['heal_mode'] if self._strictIn(b.get('heal_mode'), ['off', 'ask', 'auto']) else 'off'
        eval_ = b['heal_eval_provider'] if self._strictIn(b.get('heal_eval_provider'), validProviders) else 'kimi'
        proposer = b['heal_proposer_provider'] if self._strictIn(b.get('heal_proposer_provider'), validProviders) else 'claude'
        judge = b['heal_judge_provider'] if self._strictIn(b.get('heal_judge_provider'), validProviders) else 'kimi'
        budget = max(0.0, min(1000.0, php_floatval(b['heal_daily_budget_usd'] if b.get('heal_daily_budget_usd') is not None else 5.0)))
        ceiling = max(0.0, min(1000.0, php_floatval(b['heal_per_heal_ceiling_usd'] if b.get('heal_per_heal_ceiling_usd') is not None else 1.0)))
        iters = max(1, min(10, php_intval(b['heal_max_iterations'] if b.get('heal_max_iterations') is not None else 3)))
        runs = max(1, min(5, php_intval(b['heal_runs_per_query'] if b.get('heal_runs_per_query') is not None else 3)))
        try:
            self.ensureHealColumnsExist()
            self.db.execute(
                "UPDATE users SET heal_mode = ?, heal_daily_budget_usd = ?, heal_per_heal_ceiling_usd = ?,"
                " heal_proposer_provider = ?, heal_eval_provider = ?, heal_judge_provider = ?,"
                " heal_max_iterations = ?, heal_runs_per_query = ? WHERE id = ?",
                [mode, budget, ceiling, proposer, eval_, judge, iters, runs, userId],
            )
            return {'success': True, 'settings': {
                'heal_mode': mode, 'heal_daily_budget_usd': budget,
                'heal_per_heal_ceiling_usd': ceiling, 'heal_proposer_provider': proposer,
                'heal_eval_provider': eval_, 'heal_judge_provider': judge,
                'heal_max_iterations': iters, 'heal_runs_per_query': runs,
            }}
        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] saveHealSettings failed: ' + str(e))
            return {'success': False, 'error': 'Save failed', 'status_code': 500}

    # ─── Skill-genesis settings (promotion mode + cost guards) ──────────────
    # Spec: docs/specs/2026-07-14-skill-genesis-design.md §8 (L0 subset).
    # Default mode 'off' = the system only lists proposals a user creates
    # manually; it never spends.

    def genesisDefaults(self) -> dict:
        return {
            'genesis_mode': 'off',   # off | suggest | ask | auto
            'genesis_daily_budget_usd': 3.00,
            'genesis_per_skill_ceiling_usd': 1.50,
            'genesis_max_skills_per_week': 2,
            'genesis_reflection_provider': 'kimi',
        }

    def getGenesisSettings(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        defaults = self.genesisDefaults()
        try:
            self.ensureGenesisColumnsExist()
            row = self.db.fetch_one(
                "SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,"
                " genesis_max_skills_per_week, genesis_reflection_provider"
                " FROM users WHERE id = ?",
                [userId],
            ) or {}
            s = dict(defaults)
            for k, def_ in defaults.items():
                if row.get(k) is not None:
                    s[k] = self._coerceLike(def_, row[k])
            return {'success': True, 'settings': s}
        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] getGenesisSettings failed: ' + str(e))
            return {'success': True, 'settings': defaults}

    def saveGenesisSettings(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        b = request['body'] if request.get('body') is not None else {}
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'glm', 'gamma4']
        mode = b['genesis_mode'] if self._strictIn(b.get('genesis_mode'), ['off', 'suggest', 'ask', 'auto']) else 'off'
        prov = b['genesis_reflection_provider'] if self._strictIn(b.get('genesis_reflection_provider'), validProviders) else 'kimi'
        budget = max(0.0, min(1000.0, php_floatval(b['genesis_daily_budget_usd'] if b.get('genesis_daily_budget_usd') is not None else 3.0)))
        ceiling = max(0.0, min(1000.0, php_floatval(b['genesis_per_skill_ceiling_usd'] if b.get('genesis_per_skill_ceiling_usd') is not None else 1.5)))
        weekly = max(0, min(50, php_intval(b['genesis_max_skills_per_week'] if b.get('genesis_max_skills_per_week') is not None else 2)))
        try:
            self.ensureGenesisColumnsExist()
            self.db.execute(
                "UPDATE users SET genesis_mode = ?, genesis_daily_budget_usd = ?,"
                " genesis_per_skill_ceiling_usd = ?, genesis_max_skills_per_week = ?,"
                " genesis_reflection_provider = ? WHERE id = ?",
                [mode, budget, ceiling, weekly, prov, userId],
            )
            return {'success': True, 'settings': {
                'genesis_mode': mode, 'genesis_daily_budget_usd': budget,
                'genesis_per_skill_ceiling_usd': ceiling,
                'genesis_max_skills_per_week': weekly,
                'genesis_reflection_provider': prov,
            }}
        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] saveGenesisSettings failed: ' + str(e))
            return {'success': False, 'error': 'Save failed', 'status_code': 500}

    # ─── storage settings ──────────────────────────────────────────────────

    def getStorageSettings(self, request) -> dict:
        """Get user's storage settings."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if php_empty(userId):
            return {
                'success': False,
                'error': 'Authentication required',
                'status_code': 401,
            }

        try:
            # Ensure columns exist
            self.ensureStorageColumnsExist()

            user = self.db.fetch_one(
                "SELECT storage_provider, storage_folder FROM users WHERE id = ?",
                [userId],
            )

            # Auto-correct stale rows: the canonical user folder is
            # 'synergyAI' (hardcoded everywhere — skills root, Pyodide mounts,
            # workflow output paths). If a row from an earlier install
            # wizard has a different value, repair it AND make sure the
            # matching folder actually exists on the storage provider —
            # otherwise the listFiles endpoint would point at a path that
            # doesn't exist yet on S3 / gdrive / local and return empty.
            folder = (user or {}).get('storage_folder')
            if folder is None:
                folder = ''
            if folder != self.OFFICIAL_USER_FOLDER:
                error_log(
                    '[SettingsController] auto-correcting storage_folder for user '
                    + str(userId) + ': ' + _var_export(folder) + ' -> '
                    + self.OFFICIAL_USER_FOLDER
                )
                self.db.execute('UPDATE users SET storage_folder = ? WHERE id = ?',
                                [self.OFFICIAL_USER_FOLDER, userId])
                folder = self.OFFICIAL_USER_FOLDER

                # Create the canonical folder on the storage provider so
                # the very next listFiles call finds something rather than
                # an empty / 404 path. Idempotent — ensureStorageFolderExists
                # is a no-op if the folder already exists.
                try:
                    provider = (user or {}).get('storage_provider')
                    self.ensureStorageFolderExists(
                        userId,
                        provider if provider is not None else 'local',
                        self.OFFICIAL_USER_FOLDER,
                    )
                except Exception as createErr:  # noqa: BLE001
                    error_log(
                        '[SettingsController] auto-correct: folder-create failed (non-fatal): '
                        + str(createErr)
                    )

            storageProvider = (user or {}).get('storage_provider')
            return {
                'success': True,
                'data': {
                    'provider': storageProvider if storageProvider is not None else 'local',
                    'folder': folder,
                    'available_providers': ['local', 's3', 'gdrive', 'onedrive'],
                },
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {
                'success': False,
                'error': str(e),
                'status_code': 500,
            }

    def saveStorageSettings(self, request) -> dict:
        """Save user's storage settings."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}

        if php_empty(userId):
            return {
                'success': False,
                'error': 'Authentication required',
                'status_code': 401,
            }

        provider = body['provider'] if body.get('provider') is not None else 'local'
        folder = (body['folder'] if body.get('folder') is not None else '')
        folder = php_trim(folder)

        # Validate provider
        validProviders = ['local', 's3', 'gdrive', 'onedrive']
        if provider not in validProviders:
            return {
                'success': False,
                'error': 'Invalid storage provider',
                'status_code': 400,
            }

        # Force the canonical user folder name. The rest of the codebase
        # (skills root, Pyodide mounts, workflow paths) hardcodes
        # 'synergyAI' — accepting any other value here would put the file
        # storage UI permanently out of sync. Silent normalization rather
        # than rejection: an old client that POSTs the wrong name still
        # succeeds, it just gets the canonical name written.
        if folder != self.OFFICIAL_USER_FOLDER:
            error_log(
                '[SettingsController] normalizing requested storage_folder '
                + _var_export(folder) + ' -> '
                + self.OFFICIAL_USER_FOLDER
            )
            folder = self.OFFICIAL_USER_FOLDER

        try:
            # Ensure columns exist
            self.ensureStorageColumnsExist()

            # Save to database
            self.db.execute(
                "UPDATE users SET storage_provider = ?, storage_folder = ? WHERE id = ?",
                [provider, folder, userId],
            )

            # Create folder structure in universalFS if folder is specified
            folderCreated = False
            if not php_empty(folder):
                folderCreated = self.ensureStorageFolderExists(userId, provider, folder)

            return {
                'success': True,
                'message': 'Storage settings saved',
                'data': {
                    'provider': provider,
                    'folder': folder,
                    'folder_created': folderCreated,
                },
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {
                'success': False,
                'error': str(e),
                'status_code': 500,
            }

    def ensureStorageFolderExists(self, userId: int, provider: str, userFolder: str) -> bool:
        """Ensure storage folder exists in universalFS. Creates:
        synergyaichatroot/{user_folder}

        universalFS is a PHP-only package (Global Constraints): there is no
        `getUniversalFSClientWithApiKey` in Python, so the function_exists()
        guard PHP evaluates at line 1291 is permanently false here and this
        method always lands on PHP's local-folder fallback — the same
        behaviour PHP shows today, where the API key is configured nowhere.
        """
        bootstrapPath = self.UNIVERSALFS_PATH + '/bootstrap.php'

        if not os.path.exists(bootstrapPath):
            error_log('[SettingsController] universalFS not found at: ' + bootstrapPath)
            return self.ensureLocalStorageFolderExists(userId, userFolder)

        try:
            # require_once $bootstrapPath — PHP-only, no Python equivalent.

            # Get API key from config or user
            universalfs = self.config.get('universalfs')
            apiKey = universalfs.get('api_key') if isinstance(universalfs, dict) else None

            if not apiKey:
                # Try to get from users table. PHP adds `universalfs_api_key`
                # only inside ensureStorageColumnsExist()'s failure branch, so
                # on today's schema this SELECT raises for PHP too; read it
                # only when the column is actually there (spec §3) and mirror
                # PHP's PDOException otherwise.
                if not self._presence.column('users', 'universalfs_api_key'):
                    raise RuntimeError(
                        "SQLSTATE[42S22]: Column not found: 1054 Unknown column "
                        "'universalfs_api_key' in 'field list'")
                result = self.db.fetch_one("SELECT universalfs_api_key FROM users WHERE id = ?", [userId])
                apiKey = (result or {}).get('universalfs_api_key')

            # PHP also requires function_exists('getUniversalFSClientWithApiKey'),
            # which bootstrap.php defines — Python has no such client, so this
            # branch is where the port always ends up.
            error_log('[SettingsController] No universalFS API key configured')
            return self.ensureLocalStorageFolderExists(userId, userFolder)

        except Exception as e:  # noqa: BLE001
            error_log('[SettingsController] Failed to create folder in universalFS: ' + str(e))
            return self.ensureLocalStorageFolderExists(userId, userFolder)

    def ensureLocalStorageFolderExists(self, userId: int, userFolder: str) -> bool:
        """Fallback: Create local storage folder."""
        basePath = self.config['storage_path'] if self.config.get('storage_path') is not None \
            else self.DEFAULT_STORAGE_PATH
        fullPath = basePath + '/' + self.ROOT_FOLDER + '/' + userFolder

        if not os.path.isdir(fullPath):
            try:
                os.makedirs(fullPath, mode=0o755)
            except OSError:
                error_log('[SettingsController] Failed to create local folder: ' + fullPath)
                return False
            error_log('[SettingsController] Created local folder: ' + fullPath)
            return True

        return True

    # ─── helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _strictIn(value, allowed: list) -> bool:
        """in_array($v ?? '', $allowed, true) — strict, so only strings match."""
        v = value if value is not None else ''
        return isinstance(v, str) and v in allowed

    @staticmethod
    def _coerceLike(default, value):
        """is_int($def) ? (int)$v : (is_float($def) ? (float)$v : (string)$v)."""
        if isinstance(default, bool):
            return php_strval(value)
        if isinstance(default, int):
            return php_intval(value)
        if isinstance(default, float):
            return php_floatval(value)
        return php_strval(value)

    @staticmethod
    def _jsonDecode(raw):
        """json_decode($s, true) — null on invalid JSON."""
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return None


def _var_export(value) -> str:
    """var_export($v, true) for the scalars this controller logs."""
    if value is None:
        return 'NULL'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, str):
        return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"
    return str(value)
