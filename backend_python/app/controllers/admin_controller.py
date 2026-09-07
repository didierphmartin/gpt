"""Port of Controllers/AdminController.php — part 1: users, provider settings
(avatar/voice), per-user costs, and per-user LLM API keys (routes.php 175-189).

Task 3 appends the usage-statistics, MCP-server-admin, per-user MCP override,
costs (global), and exchange-rate methods (routes.php 192-196, 228-246) to
the SAME class below the marker near the end of this file — keep that
section boundary intact.

No admin-role gate: unlike AffiliateController/PackageController/
VideoEditorController/SystemSettingsController/LoginAdminController (each of
which checks `($user['role'] ?? '') !== 'admin'` and returns 403 'Admin
access required'), AdminController.php has NO such check anywhere in its
~3750 lines — every method here is reachable by any authenticated JWT user
(gpt_admin's frontend is the only gate). Verified by grep across the whole
PHP file. Ported verbatim: this class adds none either.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from functools import cmp_to_key
from pathlib import Path

import httpx

from app.controllers.auth_controller import password_hash
from app.providers._http import SHARED_SSL_CONTEXT
from app.services.package_resolver import PackageResolver
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import (
    filter_validate_url as _filter_validate_url,
    php_array,
    php_bool,
    php_coalesce,
    php_empty,
    php_floatval,
    php_intval,
    php_items,
    php_now,
    php_round,
    php_strval,
    php_trim,
    php_tz,
    php_values,
)
from app.support.phpjson import php_json_decode, php_json_encode

VALID_ROLES = ['guest', 'prospect', 'user', 'admin']
VALID_CATEGORIES = ('avatar', 'voice')
VALID_KEY_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']

# `_filter_validate_url` (filter_var($url, FILTER_VALIDATE_URL) — needed by
# createMCPServer, MCPServerController::create) now lives in
# app.support.phpcompat.filter_validate_url (Phase 7 final-review wave, B2);
# imported above under its old module-private name so existing call sites and
# tests keep working unchanged.


def _strip_tags(html: str) -> str:
    """Pragmatic port of PHP strip_tags() with no allowed-tags list: removes
    every `<...>` span. AdminController::fetchPricingWithClaude (3074) uses
    the result only as free-text context fed to an LLM prompt — this is
    unit-tested via httpx.MockTransport (request bytes pinned) and NEVER
    exercised by the differential (constraints.md: external refreshes are
    validation-only there), so byte-parity with PHP's tokenizer-based
    strip_tags() on malformed/edge-case HTML is not externally observable;
    a regex is sufficient for the well-formed pricing pages this targets."""
    return re.sub(r'<[^>]*>', '', html)


# `_php_round` (PHP round(): half away from zero, pre-rounded off the shortest
# decimal string that reproduces the double — see phpcompat.php_round's
# docstring for the 21790*15/1_000_000 -> 0.3269 derivation,
# AdminController.php:2981/2985, live-verified against real
# llm_usage_transactions data) now lives in app.support.phpcompat.php_round
# (Phase 7 final-review wave, B1); every call site below uses that name.


class AdminController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self._presence = DbPresence(db, 'AdminController')

    # ─── users (AdminController.php:30-312; routes.php 175-180) ────────────

    def listUsers(self, request) -> dict:
        sql = ("SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix,"
               " app_key_created_at, created_at, updated_at FROM users ORDER BY id")
        users = self.db.fetch_all(sql)
        return {'success': True, 'users': users, 'status_code': 200}

    def getUser(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        sql = ("SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix,"
               " app_key_created_at, created_at, updated_at FROM users WHERE id = :id")
        user = self.db.fetch_one(sql, {':id': userId})

        if not user:
            return {'success': False, 'error': 'User not found', 'status_code': 404}

        return {'success': True, 'user': user, 'status_code': 200}

    def getUserAccount(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        try:
            sql = ("SELECT id, email, phone, first_name, last_name, role, plan,"
                   " provider, email_verified, firebase_uid, last_login, created_at"
                   " FROM users WHERE id = :id")
            user = self.db.fetch_one(sql, {':id': userId})

            if not user:
                return {'success': False, 'error': 'User not found', 'status_code': 404}

            tokensIn = 0
            tokensOut = 0

            # Plain presence check, not one of the ensure*TableExists() DDL
            # helpers below — PHP never creates llm_usage_transactions here,
            # it just skips the token totals when the table is absent.
            tableCheck = self.db.fetch_all("SHOW TABLES LIKE 'llm_usage_transactions'")
            if tableCheck:
                tokenSql = ("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens_in,"
                           " COALESCE(SUM(completion_tokens), 0) AS tokens_out"
                           " FROM llm_usage_transactions WHERE user_id = :user_id")
                tokenRow = self.db.fetch_one(tokenSql, {':user_id': userId}) or {}
                tokensIn = php_intval(tokenRow.get('tokens_in') if tokenRow.get('tokens_in') is not None else 0)
                tokensOut = php_intval(tokenRow.get('tokens_out') if tokenRow.get('tokens_out') is not None else 0)

            plan = user.get('plan') if user.get('plan') is not None else 'free'
            role = user.get('role') if user.get('role') is not None else 'user'
            totalTokens = tokensIn + tokensOut
            freeQuota = 50000
            isFreeProspect = (plan == 'free' and role == 'prospect')

            return {
                'success': True,
                'account': {
                    'id': php_intval(user['id']),
                    'email': user['email'],
                    'phone': user['phone'],
                    'first_name': user['first_name'],
                    'last_name': user['last_name'],
                    'plan': plan,
                    'role': role,
                    'provider': user.get('provider') if user.get('provider') is not None else 'email',
                    'email_verified': php_bool(user.get('email_verified') if user.get('email_verified') is not None else False),
                    'has_firebase_uid': not php_empty(user.get('firebase_uid')),
                    'last_login': user['last_login'],
                    'created_at': user['created_at'],
                    'tokens_in': tokensIn,
                    'tokens_out': tokensOut,
                    'total_tokens': totalTokens,
                    'free_quota': freeQuota,
                    'is_free_prospect': isFreeProspect,
                    'free_quota_percent': (min(100, round((totalTokens / freeQuota) * 100, 2))
                                           if isFreeProspect else None),
                },
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def createUser(self, request) -> dict:
        input_ = request['body']

        firstName = php_trim(input_.get('first_name') if input_.get('first_name') is not None else '')
        lastName = php_trim(input_.get('last_name') if input_.get('last_name') is not None else '')
        email = php_trim(input_.get('email') if input_.get('email') is not None else '')
        password = input_.get('password') if input_.get('password') is not None else ''
        role = input_.get('role') if input_.get('role') is not None else 'user'

        if php_empty(email) or php_empty(password):
            return {'success': False, 'error': 'Email and password are required', 'status_code': 400}

        if role not in VALID_ROLES:
            role = 'user'

        hashedPassword = password_hash(php_strval(password))

        sql = ("INSERT INTO users (email, password, first_name, last_name, role, provider, created_at, updated_at)"
               " VALUES (:email, :password, :first_name, :last_name, :role, 'email', NOW(), NOW())")
        newUserId = self.db.insert(sql, {
            ':email': email,
            ':password': hashedPassword,
            ':first_name': firstName,
            ':last_name': lastName,
            ':role': role,
        })

        return {'success': True, 'message': 'User created', 'user_id': php_intval(newUserId), 'status_code': 200}

    def updateUser(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        firstName = php_trim(input_.get('first_name') if input_.get('first_name') is not None else '')
        lastName = php_trim(input_.get('last_name') if input_.get('last_name') is not None else '')
        email = php_trim(input_.get('email') if input_.get('email') is not None else '')
        password = input_.get('password') if input_.get('password') is not None else ''
        role = input_.get('role')

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if php_empty(email):
            return {'success': False, 'error': 'Email is required', 'status_code': 400}

        if role is not None and role not in VALID_ROLES:
            return {'success': False, 'error': 'Invalid role', 'status_code': 400}

        fields = ['email = :email', 'first_name = :first_name', 'last_name = :last_name', 'updated_at = NOW()']
        params = {':id': userId, ':email': email, ':first_name': firstName, ':last_name': lastName}

        if role is not None:
            fields.append('role = :role')
            params[':role'] = role

        if not php_empty(password):
            fields.append('password = :password')
            params[':password'] = password_hash(php_strval(password))

        sql = 'UPDATE users SET ' + ', '.join(fields) + ' WHERE id = :id'
        self.db.execute(sql, params)

        return {'success': True, 'message': 'User updated', 'status_code': 200}

    def deleteUser(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        sql = 'DELETE FROM users WHERE id = :id'
        rowcount = self.db.execute(sql, {':id': userId})

        if rowcount == 0:
            return {'success': False, 'error': 'User not found', 'status_code': 404}

        return {'success': True, 'message': 'User deleted', 'status_code': 200}

    # ─── provider settings — avatar/voice (AdminController.php:317-690;
    #     routes.php 181-185) ────────────────────────────────────────────────

    def getProviderSettings(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        self.ensureProviderSettingsTableExists()
        self.ensureCategorySettingsTableExists()

        categorySql = 'SELECT category, enabled FROM user_category_settings WHERE user_id = :user_id'
        categoryRows = self.db.fetch_all(categorySql, {':user_id': userId})

        categoryEnabled = {'avatar': True, 'voice': True}
        for row in categoryRows:
            categoryEnabled[row['category']] = php_bool(row['enabled'])

        if self._presence.column('user_provider_settings', 'enabled'):
            sql = ('SELECT category, provider, api_key, settings, is_active, enabled'
                   ' FROM user_provider_settings WHERE user_id = :user_id')
        else:
            # ensureProviderSettingsTableExists() ALTERs `enabled` in for PHP
            # before this SELECT runs, so PHP always reads enabled=1 here;
            # drop the column and let the isset()-less branch below default
            # to the same `True`.
            sql = ('SELECT category, provider, api_key, settings, is_active'
                   ' FROM user_provider_settings WHERE user_id = :user_id')
        rows = self.db.fetch_all(sql, {':user_id': userId})

        result = {
            'avatar': {'active': None, 'enabled': categoryEnabled['avatar'], 'providers': {}},
            'voice': {'active': None, 'enabled': categoryEnabled['voice'], 'providers': {}},
        }

        for row in rows:
            category = row['category']
            provider = row['provider']
            settingsRaw = row.get('settings')
            settings = php_json_decode(settingsRaw) if settingsRaw else None
            enabled = php_bool(row['enabled']) if row.get('enabled') is not None else True

            if category not in result:      # PHP auto-vivifies; only avatar/voice are ever real
                result[category] = {'providers': {}}
            result[category]['providers'][provider] = {
                'has_key': not php_empty(row.get('api_key')),
                'api_key': row.get('api_key'),   # actual key for admin
                'settings': settings,
                'enabled': enabled,
            }

            if row['is_active'] == 1 or row['is_active'] is True:
                result[category]['active'] = provider

        return {
            'success': True,
            'user_id': userId,
            'avatar': dict(result['avatar'], providers=php_array(result['avatar']['providers'])),
            'voice': dict(result['voice'], providers=php_array(result['voice']['providers'])),
            'status_code': 200,
        }

    def saveProvider(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        category = input_.get('category') if input_.get('category') is not None else ''
        provider = input_.get('provider') if input_.get('provider') is not None else ''
        apiKey = input_.get('api_key')
        settings = input_.get('settings')

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if category not in VALID_CATEGORIES:
            return {'success': False, 'error': 'Invalid category', 'status_code': 400}

        if php_empty(provider):
            return {'success': False, 'error': 'Provider is required', 'status_code': 400}

        self.ensureProviderSettingsTableExists()

        if isinstance(settings, str):
            settings = php_json_decode(settings)
        settingsJson = php_json_encode(settings) if php_bool(settings) else None

        checkSql = ('SELECT id, api_key FROM user_provider_settings'
                   ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
        existing = self.db.fetch_one(checkSql, {':user_id': userId, ':category': category, ':provider': provider})

        if existing:
            if apiKey is not None:
                sql = ('UPDATE user_provider_settings'
                       ' SET api_key = :api_key, settings = :settings, updated_at = NOW()'
                       ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
                params = {':user_id': userId, ':category': category, ':provider': provider,
                          ':api_key': apiKey, ':settings': settingsJson}
            else:
                sql = ('UPDATE user_provider_settings'
                       ' SET settings = :settings, updated_at = NOW()'
                       ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
                params = {':user_id': userId, ':category': category, ':provider': provider,
                          ':settings': settingsJson}
            self.db.execute(sql, params)
        else:
            sql = ('INSERT INTO user_provider_settings'
                   ' (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)'
                   ' VALUES (:user_id, :category, :provider, :api_key, :settings, 0, NOW(), NOW())')
            self.db.execute(sql, {':user_id': userId, ':category': category, ':provider': provider,
                                   ':api_key': apiKey, ':settings': settingsJson})

        if not php_empty(input_.get('set_active')):
            unsetSql = ('UPDATE user_provider_settings SET is_active = 0'
                       ' WHERE user_id = :user_id AND category = :category')
            self.db.execute(unsetSql, {':user_id': userId, ':category': category})

            activeSql = ('UPDATE user_provider_settings SET is_active = 1'
                        ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
            self.db.execute(activeSql, {':user_id': userId, ':category': category, ':provider': provider})

        return {'success': True, 'message': f"Provider '{provider}' saved", 'status_code': 200}

    def toggleProviderEnabled(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        category = input_.get('category') if input_.get('category') is not None else ''
        provider = input_.get('provider') if input_.get('provider') is not None else ''
        enabled = php_bool(input_.get('enabled') if input_.get('enabled') is not None else True)

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if category not in VALID_CATEGORIES:
            return {'success': False, 'error': 'Invalid category', 'status_code': 400}

        if php_empty(provider):
            return {'success': False, 'error': 'Provider is required', 'status_code': 400}

        self.ensureProviderSettingsTableExists()

        checkSql = ('SELECT id FROM user_provider_settings'
                   ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
        existing = self.db.fetch_one(checkSql, {':user_id': userId, ':category': category, ':provider': provider})

        if existing:
            if enabled:
                sql = ('UPDATE user_provider_settings SET enabled = 1, updated_at = NOW()'
                       ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
            else:
                sql = ('UPDATE user_provider_settings SET enabled = 0, is_active = 0, updated_at = NOW()'
                       ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
            self.db.execute(sql, {':user_id': userId, ':category': category, ':provider': provider})
        else:
            sql = ('INSERT INTO user_provider_settings'
                   ' (user_id, category, provider, enabled, is_active, created_at, updated_at)'
                   ' VALUES (:user_id, :category, :provider, :enabled, 0, NOW(), NOW())')
            self.db.execute(sql, {':user_id': userId, ':category': category, ':provider': provider,
                                   ':enabled': 1 if enabled else 0})

        return {'success': True,
                'message': f"Provider '{provider}' " + ('enabled' if enabled else 'disabled'),
                'status_code': 200}

    def toggleCategoryEnabled(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        category = input_.get('category') if input_.get('category') is not None else ''
        enabled = php_bool(input_.get('enabled') if input_.get('enabled') is not None else True)

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if category not in VALID_CATEGORIES:
            return {'success': False, 'error': 'Invalid category', 'status_code': 400}

        self.ensureCategorySettingsTableExists()
        self.ensureProviderSettingsTableExists()

        enabledValue = 1 if enabled else 0
        sql = ('INSERT INTO user_category_settings (user_id, category, enabled, updated_at)'
               ' VALUES (:user_id, :category, :enabled, NOW())'
               ' ON DUPLICATE KEY UPDATE enabled = :enabled2, updated_at = NOW()')
        self.db.execute(sql, {':user_id': userId, ':category': category,
                              ':enabled': enabledValue, ':enabled2': enabledValue})

        if enabled:
            updateProvidersSql = ('UPDATE user_provider_settings SET enabled = :enabled, updated_at = NOW()'
                                  ' WHERE user_id = :user_id AND category = :category')
        else:
            updateProvidersSql = ('UPDATE user_provider_settings'
                                  ' SET enabled = :enabled, is_active = 0, updated_at = NOW()'
                                  ' WHERE user_id = :user_id AND category = :category')
        updatedCount = self.db.execute(updateProvidersSql,
                                       {':user_id': userId, ':category': category, ':enabled': enabledValue})

        return {'success': True,
                'message': (f"Category '{category}' " + ('enabled' if enabled else 'disabled')
                           + f' ({updatedCount} providers updated)'),
                'status_code': 200}

    def deleteProvider(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        category = input_.get('category') if input_.get('category') is not None else ''
        provider = input_.get('provider') if input_.get('provider') is not None else ''

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if category not in VALID_CATEGORIES:
            return {'success': False, 'error': 'Invalid category', 'status_code': 400}

        if php_empty(provider):
            return {'success': False, 'error': 'Provider is required', 'status_code': 400}

        sql = ('DELETE FROM user_provider_settings'
               ' WHERE user_id = :user_id AND category = :category AND provider = :provider')
        rowcount = self.db.execute(sql, {':user_id': userId, ':category': category, ':provider': provider})

        return {'success': True, 'message': f"Provider '{provider}' deleted",
                'deleted': rowcount > 0, 'status_code': 200}

    # ─── per-user costs (AdminController.php:2830-3023; routes.php 186) ────

    def getUserCosts(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        try:
            usageCosts = self._getUsageCostsBreakdown(userId)
            return {'success': True, 'user_id': userId, 'usageCosts': usageCosts, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': f'Failed to fetch user costs: {e}', 'status_code': 500}

    def _getUsageCostsBreakdown(self, userId: int | None = None) -> dict:
        """Get usage costs breakdown by category (LLM, Voice, Avatar). When
        userId is given, all aggregates are scoped to that user. Task 3's
        getCosts() (global, no userId) reuses this same private helper."""
        userClause = ' AND t.user_id = :uid' if userId is not None else ''
        userClauseNoAlias = ' AND user_id = :uid' if userId is not None else ''
        bind = {':uid': userId} if userId is not None else None

        llmSql = ('SELECT t.provider, COUNT(*) AS total_requests,'
                 ' COALESCE(SUM(t.prompt_tokens), 0) AS tokens_in,'
                 ' COALESCE(SUM(t.completion_tokens), 0) AS tokens_out,'
                 ' COALESCE(SUM(t.total_tokens), 0) AS total_tokens,'
                 ' COALESCE(SUM(t.cost_usd), 0) AS stored_cost_total,'
                 ' s.price_input_per_1m AS price_in, s.price_output_per_1m AS price_out,'
                 ' MAX(t.created_at) AS last_used'
                 ' FROM llm_usage_transactions t'
                 ' LEFT JOIN system_llm_settings s ON s.provider_key = t.provider'
                 ' WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)' + userClause
                 + ' GROUP BY t.provider, s.price_input_per_1m, s.price_output_per_1m'
                 ' ORDER BY stored_cost_total DESC')
        llmCostsRaw = self.db.fetch_all(llmSql, bind)

        # No hardcoded fallback: a provider with no/NULL price in
        # system_llm_settings shows "-" (single source of truth).
        llmCosts = []
        for row in llmCostsRaw:
            row = dict(row)
            priceIn = php_floatval(row['price_in']) if row.get('price_in') is not None else None
            priceOut = php_floatval(row['price_out']) if row.get('price_out') is not None else None
            row['resolved_price_in'] = priceIn
            row['resolved_price_out'] = priceOut
            row['cost_in'] = (php_intval(row['tokens_in']) * priceIn / 1_000_000) if priceIn is not None else None
            row['cost_out'] = (php_intval(row['tokens_out']) * priceOut / 1_000_000) if priceOut is not None else None
            llmCosts.append(row)

        def _cmp(a, b):
            ta = (a['cost_in'] or 0) + (a['cost_out'] or 0)
            tb = (b['cost_in'] or 0) + (b['cost_out'] or 0)
            if ta == 0.0 and tb == 0.0:
                bs, as_ = php_floatval(b['stored_cost_total']), php_floatval(a['stored_cost_total'])
                return (bs > as_) - (bs < as_)
            return (tb > ta) - (tb < ta)
        llmCosts.sort(key=cmp_to_key(_cmp))

        voiceSql = ('SELECT provider, COUNT(*) as total_requests,'
                   ' COALESCE(SUM(audio_duration_seconds), 0) as total_seconds,'
                   ' COALESCE(SUM(cost_usd), 0) as total_cost,'
                   ' MAX(created_at) as last_used'
                   ' FROM llm_usage_transactions'
                   ' WHERE is_voice_request = 1'
                   ' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)' + userClauseNoAlias
                   + ' GROUP BY provider ORDER BY total_cost DESC')
        voiceCosts = self.db.fetch_all(voiceSql, bind)

        totalsWhere = ' WHERE user_id = :uid' if userId is not None else ''
        totalsSql = ('SELECT'
                    ' SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as cost_today,'
                    ' SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as cost_week,'
                    ' SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as cost_month,'
                    ' SUM(cost_usd) as cost_total,'
                    ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)'
                    ' THEN cost_usd ELSE 0 END) as voice_cost_today,'
                    ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
                    ' THEN cost_usd ELSE 0 END) as voice_cost_week,'
                    ' SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
                    ' THEN cost_usd ELSE 0 END) as voice_cost_month,'
                    ' SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost_total'
                    ' FROM llm_usage_transactions' + totalsWhere)
        totals = self.db.fetch_one(totalsSql, bind) or {}

        def _t(key):
            v = totals.get(key)
            return php_floatval(v) if v is not None else 0.0

        llmByProvider = []
        for p in llmCosts:
            costIn, costOut = p['cost_in'], p['cost_out']
            total = (costIn + costOut) if (costIn is not None and costOut is not None) \
                else php_floatval(p['stored_cost_total'])
            llmByProvider.append({
                'provider': p['provider'],
                'requests': php_intval(p['total_requests']),
                'tokensIn': php_intval(p['tokens_in']),
                'tokensOut': php_intval(p['tokens_out']),
                'tokens': php_intval(p['total_tokens']),
                'priceIn': p['resolved_price_in'],
                'priceOut': p['resolved_price_out'],
                'costIn': php_round(costIn, 4) if costIn is not None else None,
                'costOut': php_round(costOut, 4) if costOut is not None else None,
                'cost': php_round(total, 4),
                'storedCost': php_round(php_floatval(p['stored_cost_total']), 4),
                'lastUsed': p['last_used'],
            })

        voiceByProvider = []
        for p in voiceCosts:
            voiceByProvider.append({
                'provider': p['provider'],
                'requests': php_intval(p['total_requests']),
                'seconds': php_round(php_floatval(p['total_seconds']), 2),
                'cost': php_round(php_floatval(p['total_cost']), 4),
                'lastUsed': p['last_used'],
            })

        return {
            'llm': {
                'byProvider': llmByProvider,
                'totals': {
                    'today': php_round(_t('cost_today'), 4),
                    'week': php_round(_t('cost_week'), 4),
                    'month': php_round(_t('cost_month'), 4),
                    'total': php_round(_t('cost_total'), 4),
                },
            },
            'voice': {
                'byProvider': voiceByProvider,
                'totals': {
                    'today': php_round(_t('voice_cost_today'), 4),
                    'week': php_round(_t('voice_cost_week'), 4),
                    'month': php_round(_t('voice_cost_month'), 4),
                    'total': php_round(_t('voice_cost_total'), 4),
                },
            },
            'avatar': {
                'byProvider': [],
                'totals': {'today': 0, 'week': 0, 'month': 0, 'total': 0},
                'note': 'Avatar usage costs are tracked separately if avatar provider integrations are active',
            },
        }

    # ─── per-user LLM API keys (AdminController.php:692-961; routes.php 187-189) ─

    def getApiKeys(self, request, userId: int) -> dict:
        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        self.ensureApiKeysTableExists()

        if self._presence.column('user_api_keys', 'enabled'):
            sql = ('SELECT provider, api_key, model, base_url, max_tokens, temperature,'
                   ' chat_endpoint, streaming, supports_tools, system_prompt, enabled, updated_at'
                   ' FROM user_api_keys WHERE user_id = :user_id')
        else:
            # ensureApiKeysTableExists() ALTERs `enabled` in for PHP before this
            # SELECT runs (DEFAULT 1); drop the column and default to True below.
            sql = ('SELECT provider, api_key, model, base_url, max_tokens, temperature,'
                   ' chat_endpoint, streaming, supports_tools, system_prompt, updated_at'
                   ' FROM user_api_keys WHERE user_id = :user_id')
        rows = self.db.fetch_all(sql, {':user_id': userId})

        emptyState = {
            'api_key': None, 'masked_key': None,
            'model': None, 'base_url': None,
            'max_tokens': None, 'temperature': None,
            'chat_endpoint': None, 'streaming': None,
            'supports_tools': None, 'system_prompt': None,
            'enabled': True, 'updated_at': None,
        }

        keys: dict = {}
        for row in rows:
            apiKey = row.get('api_key') if row.get('api_key') is not None else ''
            keys[row['provider']] = {
                'api_key': apiKey,   # actual key for admin
                'masked_key': ('****' + apiKey[-4:]) if apiKey != '' else None,
                'model': row['model'],
                'base_url': row['base_url'],
                'max_tokens': php_intval(row['max_tokens']) if row['max_tokens'] is not None else None,
                'temperature': php_floatval(row['temperature']) if row['temperature'] is not None else None,
                'chat_endpoint': row['chat_endpoint'],
                'streaming': php_bool(row['streaming']) if row['streaming'] is not None else None,
                'supports_tools': php_bool(row['supports_tools']) if row['supports_tools'] is not None else None,
                'system_prompt': row['system_prompt'],
                'enabled': php_bool(row['enabled']) if row.get('enabled') is not None else True,
                'updated_at': row['updated_at'],
            }

        for provider in VALID_KEY_PROVIDERS:
            if provider not in keys:
                keys[provider] = dict(emptyState)

        # Overlay the keys this user inherits from their package (role). A
        # user without a personal key still has the keys their package
        # grants at chat time (ChatController::applyPackageDefaults) —
        # surface those here, tagged source: 'package', so the admin can see
        # (and, by editing, override per-user) what the user effectively has.
        try:
            resolver = PackageResolver(self.db)
            packageName = resolver.resolveRole(userId)
            package = resolver.resolveForUser(userId)
            capabilities = package.get('capabilities') if isinstance(package, dict) else None
            pkgProviders = capabilities.get('providers') if isinstance(capabilities, dict) else None
            if not isinstance(pkgProviders, (dict, list)):
                pkgProviders = []

            for provider in VALID_KEY_PROVIDERS:
                userKey = keys[provider].get('api_key')
                if userKey is not None and userKey != '':
                    # Personal key set on the user — that wins over the package.
                    keys[provider]['source'] = 'user'
                    keys[provider]['available'] = True
                    keys[provider]['package_name'] = None
                    continue
                raw = pkgProviders.get(provider) if isinstance(pkgProviders, dict) else None
                pkg = raw if isinstance(raw, (dict, list)) else {}
                pkgEnabled = not php_empty(pkg.get('enabled')) if isinstance(pkg, dict) else False
                pkgKey = (php_trim(php_strval(pkg.get('default_api_key')))
                         if pkgEnabled and isinstance(pkg, dict) and pkg.get('default_api_key') is not None else '')
                pkgModel = (php_trim(php_strval(pkg.get('default_model')))
                           if pkgEnabled and isinstance(pkg, dict) and pkg.get('default_model') is not None else '')
                if pkgKey != '':
                    keys[provider]['api_key'] = pkgKey       # actual key for admin (display + reveal + edit)
                    keys[provider]['masked_key'] = '****' + pkgKey[-4:]
                    if keys[provider].get('model') is None and pkgModel != '':
                        keys[provider]['model'] = pkgModel
                    keys[provider]['source'] = 'package'
                    keys[provider]['available'] = True
                    keys[provider]['package_name'] = packageName
                else:
                    keys[provider]['source'] = 'none'
                    keys[provider]['available'] = False
                    keys[provider]['package_name'] = None
        except Exception as e:  # noqa: BLE001
            error_log('[AdminController] package key overlay failed: ' + str(e))

        return {'success': True, 'user_id': userId, 'keys': keys, 'status_code': 200}

    def saveApiKeys(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        keys = input_.get('keys') if input_.get('keys') is not None else {}

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if php_empty(keys):
            return {'success': False, 'error': 'No keys provided', 'status_code': 400}

        self.ensureApiKeysTableExists()

        savedCount = 0

        # Columns that can be updated individually (without requiring an
        # api_key). Map: input field => (db column, caster). Order matters —
        # it is the column order in the generated INSERT.
        settingFields = {
            'model':          ('model', lambda v: None if v == '' else php_strval(v)),
            'base_url':       ('base_url', lambda v: None if v == '' else php_strval(v)),
            'max_tokens':     ('max_tokens', lambda v: None if v == '' or v is None else php_intval(v)),
            'temperature':    ('temperature', lambda v: None if v == '' or v is None else php_floatval(v)),
            'chat_endpoint':  ('chat_endpoint', lambda v: None if v == '' else php_strval(v)),
            'streaming':      ('streaming', lambda v: None if v is None else (1 if v else 0)),
            'supports_tools': ('supports_tools', lambda v: None if v is None else (1 if v else 0)),
            'system_prompt':  ('system_prompt', lambda v: None if v == '' else php_strval(v)),
            'enabled':        ('enabled', lambda v: 1 if v else 0),
        }

        for provider, entry in php_items(keys):
            if provider not in VALID_KEY_PROVIDERS:
                continue

            # Back-compat: allow plain string (api_key only)
            if isinstance(entry, str):
                entry = {'api_key': entry}
            if not isinstance(entry, dict):
                continue

            hasApiKey = 'api_key' in entry and php_trim(php_strval(entry['api_key'])) != ''
            apiKey = php_trim(php_strval(entry['api_key'])) if hasApiKey else None

            cols = ['user_id', 'provider']
            placeholders = [':user_id', ':provider']
            updates = []
            params = {':user_id': userId, ':provider': provider}

            if hasApiKey:
                cols.append('api_key')
                placeholders.append(':api_key')
                updates.append('api_key = VALUES(api_key)')
                params[':api_key'] = apiKey

            for inputKey, (col, cast) in settingFields.items():
                if inputKey not in entry:
                    continue
                cols.append(col)
                placeholders.append(':' + col)
                updates.append(f'{col} = VALUES({col})')
                params[':' + col] = cast(entry[inputKey])

            # If only provider/user_id (no api_key, no settings), skip
            if len(cols) <= 2:
                continue

            # If inserting a brand-new row without an api_key, we can't
            # (api_key is NOT NULL). Check existence and skip insert.
            if not hasApiKey:
                check = self.db.fetch_one('SELECT 1 FROM user_api_keys WHERE user_id = :uid AND provider = :p',
                                          {':uid': userId, ':p': provider})
                if not check:
                    continue

            cols.append('created_at')
            cols.append('updated_at')
            placeholders.append('NOW()')
            placeholders.append('NOW()')
            updates.append('updated_at = NOW()')

            sql = ('INSERT INTO user_api_keys (' + ', '.join(cols) + ')'
                   ' VALUES (' + ', '.join(placeholders) + ')'
                   ' ON DUPLICATE KEY UPDATE ' + ', '.join(updates))
            self.db.execute(sql, params)
            savedCount += 1

        return {'success': True, 'message': f'Saved {savedCount} API key(s)', 'status_code': 200}

    def deleteApiKey(self, request) -> dict:
        input_ = request['body']

        userId = php_intval(input_.get('user_id') if input_.get('user_id') is not None else 0)
        provider = input_.get('provider') if input_.get('provider') is not None else ''

        if userId <= 0:
            return {'success': False, 'error': 'Invalid user ID', 'status_code': 400}

        if php_empty(provider):
            return {'success': False, 'error': 'Provider is required', 'status_code': 400}

        sql = 'DELETE FROM user_api_keys WHERE user_id = :user_id AND provider = :provider'
        rowcount = self.db.execute(sql, {':user_id': userId, ':provider': provider})

        return {'success': True, 'message': f"API key for '{provider}' deleted",
                'deleted': rowcount > 0, 'status_code': 200}

    # ─── ensure* (AdminController.php:966-1051 — no runtime DDL: presence
    #     check + log only, constraints.md §3). Task 3's usage/MCP/costs/
    #     exchange-rate methods append below this section. ────────────────

    def ensureProviderSettingsTableExists(self) -> None:
        if self._presence.table('user_provider_settings'):
            self._presence.column('user_provider_settings', 'enabled')

    def ensureCategorySettingsTableExists(self) -> None:
        self._presence.table('user_category_settings')

    def ensureApiKeysTableExists(self) -> None:
        if self._presence.table('user_api_keys'):
            self._presence.column('user_api_keys', 'enabled')

    # ─── admin usage statistics (AdminController.php:1060-1757;
    #     routes.php 192-196) ────────────────────────────────────────────────

    def getUsageStats(self, request) -> dict:
        try:
            query = request['query'] if request.get('query') is not None else {}
            period = query['period'] if query.get('period') is not None else 'month'
            dateFrom = query.get('date_from')
            dateTo = query.get('date_to')

            dateRange = self.getDateRange(period, dateFrom, dateTo)

            overallSql = ("SELECT"
                         " COUNT(*) as total_requests,"
                         " SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,"
                         " SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_requests,"
                         " COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,"
                         " COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,"
                         " COALESCE(SUM(total_tokens), 0) as total_tokens,"
                         " COALESCE(SUM(cost_usd), 0) as total_cost,"
                         " COALESCE(AVG(response_time_ms), 0) as avg_response_time,"
                         " COUNT(DISTINCT user_id) as unique_users,"
                         " SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as total_voice_requests,"
                         " COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,"
                         " SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as total_voice_cost,"
                         " COALESCE(SUM(function_calls_count), 0) as total_function_calls,"
                         " COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls"
                         " FROM llm_usage_transactions"
                         " WHERE created_at BETWEEN :date_from AND :date_to")
            overall = self.db.fetch_one(
                overallSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']}) or {}

            byProviderSql = ("SELECT"
                            " provider,"
                            " COUNT(*) as requests,"
                            " COALESCE(SUM(total_tokens), 0) as tokens,"
                            " COALESCE(SUM(cost_usd), 0) as cost,"
                            " COALESCE(AVG(response_time_ms), 0) as avg_response_time,"
                            " SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,"
                            " COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,"
                            " SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,"
                            " COALESCE(SUM(function_calls_count), 0) as function_calls,"
                            " COALESCE(SUM(mcp_calls_count), 0) as mcp_calls"
                            " FROM llm_usage_transactions"
                            " WHERE created_at BETWEEN :date_from AND :date_to"
                            " GROUP BY provider ORDER BY cost DESC")
            byProvider = self.db.fetch_all(
                byProviderSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']})

            trendSql = ("SELECT"
                       " DATE(created_at) as date,"
                       " COUNT(*) as requests,"
                       " COALESCE(SUM(cost_usd), 0) as cost,"
                       " COALESCE(SUM(total_tokens), 0) as tokens"
                       " FROM llm_usage_transactions"
                       " WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
                       " GROUP BY DATE(created_at) ORDER BY date ASC")
            dailyTrend = self.db.fetch_all(trendSql)

            return {
                'success': True,
                'period': period,
                'date_range': dateRange,
                'overall': {
                    'total_requests': php_intval(overall.get('total_requests')),
                    'successful_requests': php_intval(overall.get('successful_requests')),
                    'failed_requests': php_intval(overall.get('failed_requests')),
                    'total_tokens': php_intval(overall.get('total_tokens')),
                    'prompt_tokens': php_intval(overall.get('total_prompt_tokens')),
                    'completion_tokens': php_intval(overall.get('total_completion_tokens')),
                    'total_cost': php_round(php_floatval(overall.get('total_cost')), 4),
                    'avg_response_time_ms': php_round(php_floatval(overall.get('avg_response_time'))),
                    'unique_users': php_intval(overall.get('unique_users')),
                    'voice_requests': php_intval(
                        overall['total_voice_requests'] if overall.get('total_voice_requests') is not None else 0),
                    'audio_seconds': php_round(php_floatval(
                        overall['total_audio_seconds'] if overall.get('total_audio_seconds') is not None else 0), 2),
                    'voice_cost': php_round(php_floatval(
                        overall['total_voice_cost'] if overall.get('total_voice_cost') is not None else 0), 4),
                    'total_function_calls': php_intval(
                        overall['total_function_calls'] if overall.get('total_function_calls') is not None else 0),
                    'total_mcp_calls': php_intval(
                        overall['total_mcp_calls'] if overall.get('total_mcp_calls') is not None else 0),
                },
                'by_provider': [
                    {
                        'provider': p['provider'],
                        'requests': php_intval(p['requests']),
                        'tokens': php_intval(p['tokens']),
                        'cost': php_round(php_floatval(p['cost']), 4),
                        'avg_response_time_ms': php_round(php_floatval(p['avg_response_time'])),
                        'voice_requests': php_intval(p['voice_requests'] if p.get('voice_requests') is not None else 0),
                        'audio_seconds': php_round(
                            php_floatval(p['audio_seconds'] if p.get('audio_seconds') is not None else 0), 2),
                        'voice_cost': php_round(
                            php_floatval(p['voice_cost'] if p.get('voice_cost') is not None else 0), 4),
                        'function_calls': php_intval(p['function_calls'] if p.get('function_calls') is not None else 0),
                        'mcp_calls': php_intval(p['mcp_calls'] if p.get('mcp_calls') is not None else 0),
                    }
                    for p in byProvider
                ],
                'daily_trend': [
                    {
                        'date': d['date'],
                        'requests': php_intval(d['requests']),
                        'cost': php_round(php_floatval(d['cost']), 4),
                        'tokens': php_intval(d['tokens']),
                    }
                    for d in dailyTrend
                ],
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def getUsageByUser(self, request) -> dict:
        try:
            query = request['query'] if request.get('query') is not None else {}
            period = query['period'] if query.get('period') is not None else 'month'
            limit = min(php_intval(query['limit']) if query.get('limit') is not None else 50, 100)
            offset = php_intval(query['offset']) if query.get('offset') is not None else 0

            dateRange = self.getDateRange(period)

            sql = ("SELECT"
                  " t.user_id,"
                  " u.email,"
                  " u.first_name,"
                  " u.last_name,"
                  " COUNT(*) as total_requests,"
                  " COALESCE(SUM(t.total_tokens), 0) as total_tokens,"
                  " COALESCE(SUM(t.cost_usd), 0) as total_cost,"
                  " COALESCE(AVG(t.response_time_ms), 0) as avg_response_time,"
                  " MAX(t.created_at) as last_activity,"
                  " SUM(CASE WHEN t.is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,"
                  " COALESCE(SUM(t.audio_duration_seconds), 0) as audio_seconds,"
                  " SUM(CASE WHEN t.is_voice_request = 1 THEN t.cost_usd ELSE 0 END) as voice_cost,"
                  " COALESCE(SUM(t.function_calls_count), 0) as function_calls,"
                  " COALESCE(SUM(t.mcp_calls_count), 0) as mcp_calls"
                  " FROM llm_usage_transactions t"
                  " LEFT JOIN users u ON t.user_id = u.id"
                  " WHERE t.created_at BETWEEN :date_from AND :date_to"
                  " GROUP BY t.user_id, u.email, u.first_name, u.last_name"
                  " ORDER BY total_cost DESC"
                  " LIMIT :limit OFFSET :offset")
            users = self.db.fetch_all(sql, {':date_from': dateRange['from'], ':date_to': dateRange['to'],
                                            ':limit': limit, ':offset': offset})

            countSql = ("SELECT COUNT(DISTINCT user_id) as total FROM llm_usage_transactions"
                       " WHERE created_at BETWEEN :date_from AND :date_to")
            countRow = self.db.fetch_one(
                countSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']}) or {}
            total = php_intval(countRow.get('total'))

            def _fmt_user(u):
                firstName = u['first_name'] if u.get('first_name') is not None else ''
                lastName = u['last_name'] if u.get('last_name') is not None else ''
                name = php_trim(f'{firstName} {lastName}')
                if php_empty(name):
                    name = 'Unknown'
                return {
                    'user_id': php_intval(u['user_id']),
                    'email': u['email'] if u.get('email') is not None else 'Unknown',
                    'name': name,
                    'requests': php_intval(u['total_requests']),
                    'tokens': php_intval(u['total_tokens']),
                    'cost': php_round(php_floatval(u['total_cost']), 4),
                    'avg_response_time_ms': php_round(php_floatval(u['avg_response_time'])),
                    'last_activity': u['last_activity'],
                    'voice_requests': php_intval(u['voice_requests'] if u.get('voice_requests') is not None else 0),
                    'audio_seconds': php_round(
                        php_floatval(u['audio_seconds'] if u.get('audio_seconds') is not None else 0), 2),
                    'voice_cost': php_round(php_floatval(u['voice_cost'] if u.get('voice_cost') is not None else 0), 4),
                    'function_calls': php_intval(u['function_calls'] if u.get('function_calls') is not None else 0),
                    'mcp_calls': php_intval(u['mcp_calls'] if u.get('mcp_calls') is not None else 0),
                }

            return {
                'success': True,
                'period': period,
                'date_range': dateRange,
                'users': [_fmt_user(u) for u in users],
                'pagination': {'total': total, 'limit': limit, 'offset': offset},
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def getUserUsageDetail(self, request, userId: int) -> dict:
        try:
            query = request['query'] if request.get('query') is not None else {}
            period = query['period'] if query.get('period') is not None else 'month'
            dateRange = self.getDateRange(period)

            user = self.db.fetch_one(
                "SELECT id, email, first_name, last_name FROM users WHERE id = :id", {':id': userId})
            if not user:
                return {'success': False, 'error': 'User not found', 'status_code': 404}

            statsSql = ("SELECT"
                       " COUNT(*) as total_requests,"
                       " SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,"
                       " COALESCE(SUM(total_tokens), 0) as total_tokens,"
                       " COALESCE(SUM(cost_usd), 0) as total_cost,"
                       " COALESCE(AVG(response_time_ms), 0) as avg_response_time,"
                       " SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,"
                       " COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,"
                       " SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,"
                       " COALESCE(SUM(function_calls_count), 0) as function_calls,"
                       " COALESCE(SUM(mcp_calls_count), 0) as mcp_calls"
                       " FROM llm_usage_transactions"
                       " WHERE user_id = :user_id AND created_at BETWEEN :date_from AND :date_to")
            stats = self.db.fetch_one(
                statsSql, {':user_id': userId, ':date_from': dateRange['from'], ':date_to': dateRange['to']}) or {}

            byProviderSql = ("SELECT"
                            " provider,"
                            " COUNT(*) as requests,"
                            " COALESCE(SUM(total_tokens), 0) as tokens,"
                            " COALESCE(SUM(cost_usd), 0) as cost,"
                            " SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,"
                            " COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,"
                            " COALESCE(SUM(function_calls_count), 0) as function_calls,"
                            " COALESCE(SUM(mcp_calls_count), 0) as mcp_calls"
                            " FROM llm_usage_transactions"
                            " WHERE user_id = :user_id AND created_at BETWEEN :date_from AND :date_to"
                            " GROUP BY provider ORDER BY cost DESC")
            byProvider = self.db.fetch_all(
                byProviderSql, {':user_id': userId, ':date_from': dateRange['from'], ':date_to': dateRange['to']})

            recentSql = ("SELECT"
                        " id, provider, model, prompt_tokens, completion_tokens, total_tokens,"
                        " cost_usd, response_time_ms, status, function_calls_count, created_at,"
                        " is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds,"
                        " mcp_calls_count, functions_called, mcp_tools_called"
                        " FROM llm_usage_transactions"
                        " WHERE user_id = :user_id"
                        " ORDER BY created_at DESC LIMIT 50")
            recentTransactions = self.db.fetch_all(recentSql, {':user_id': userId})

            firstName = user['first_name'] if user.get('first_name') is not None else ''
            lastName = user['last_name'] if user.get('last_name') is not None else ''

            def _fmt_provider(p):
                return {
                    'provider': p['provider'],
                    'requests': php_intval(p['requests']),
                    'tokens': php_intval(p['tokens']),
                    'cost': php_round(php_floatval(p['cost']), 4),
                    'voice_requests': php_intval(p['voice_requests'] if p.get('voice_requests') is not None else 0),
                    'audio_seconds': php_round(
                        php_floatval(p['audio_seconds'] if p.get('audio_seconds') is not None else 0), 2),
                    'function_calls': php_intval(p['function_calls'] if p.get('function_calls') is not None else 0),
                    'mcp_calls': php_intval(p['mcp_calls'] if p.get('mcp_calls') is not None else 0),
                }

            def _fmt_txn(t):
                functionsCalled = t.get('functions_called')
                mcpToolsCalled = t.get('mcp_tools_called')
                return {
                    'id': php_intval(t['id']),
                    'provider': t['provider'],
                    'model': t['model'],
                    'prompt_tokens': php_intval(t['prompt_tokens']),
                    'completion_tokens': php_intval(t['completion_tokens']),
                    'total_tokens': php_intval(t['total_tokens']),
                    'cost': php_round(php_floatval(t['cost_usd']), 6),
                    'response_time_ms': php_intval(t['response_time_ms']),
                    'status': t['status'],
                    'function_calls': php_intval(t['function_calls_count']),
                    'mcp_calls': php_intval(t['mcp_calls_count'] if t.get('mcp_calls_count') is not None else 0),
                    'functions_called': php_json_decode(functionsCalled) if php_bool(functionsCalled) else [],
                    'mcp_tools_called': php_json_decode(mcpToolsCalled) if php_bool(mcpToolsCalled) else [],
                    'created_at': t['created_at'],
                    'is_voice': php_bool(t['is_voice_request'] if t.get('is_voice_request') is not None else 0),
                    'audio_seconds': php_round(
                        php_floatval(t['audio_duration_seconds'] if t.get('audio_duration_seconds') is not None else 0), 2),
                }

            return {
                'success': True,
                'user': {
                    'id': php_intval(user['id']),
                    'email': user['email'],
                    'name': php_trim(f'{firstName} {lastName}'),
                },
                'period': period,
                'date_range': dateRange,
                'stats': {
                    'total_requests': php_intval(stats.get('total_requests')),
                    'successful_requests': php_intval(stats.get('successful_requests')),
                    'total_tokens': php_intval(stats.get('total_tokens')),
                    'total_cost': php_round(php_floatval(stats.get('total_cost')), 4),
                    'avg_response_time_ms': php_round(php_floatval(stats.get('avg_response_time'))),
                    'voice_requests': php_intval(stats['voice_requests'] if stats.get('voice_requests') is not None else 0),
                    'audio_seconds': php_round(
                        php_floatval(stats['audio_seconds'] if stats.get('audio_seconds') is not None else 0), 2),
                    'voice_cost': php_round(
                        php_floatval(stats['voice_cost'] if stats.get('voice_cost') is not None else 0), 4),
                    'function_calls': php_intval(stats['function_calls'] if stats.get('function_calls') is not None else 0),
                    'mcp_calls': php_intval(stats['mcp_calls'] if stats.get('mcp_calls') is not None else 0),
                },
                'by_provider': [_fmt_provider(p) for p in byProvider],
                'recent_transactions': [_fmt_txn(t) for t in recentTransactions],
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def getUsageTransactions(self, request) -> dict:
        try:
            query = request['query'] if request.get('query') is not None else {}
            provider = query.get('provider')
            userIdFilter = query.get('user_id')
            status = query.get('status')
            dateFrom = query.get('date_from')
            dateTo = query.get('date_to')
            limit = min(php_intval(query['limit']) if query.get('limit') is not None else 100, 500)
            offset = php_intval(query['offset']) if query.get('offset') is not None else 0

            conditions = []
            params: dict = {}

            if provider:
                conditions.append('t.provider = :provider')
                params[':provider'] = provider
            if userIdFilter:
                conditions.append('t.user_id = :user_id')
                params[':user_id'] = php_intval(userIdFilter)
            if status:
                conditions.append('t.status = :status')
                params[':status'] = status
            if dateFrom:
                conditions.append('t.created_at >= :date_from')
                params[':date_from'] = dateFrom
            if dateTo:
                conditions.append('t.created_at <= :date_to')
                params[':date_to'] = dateTo

            whereClause = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''

            sql = ("SELECT"
                  " t.id, t.user_id, t.provider, t.model, t.prompt_tokens, t.completion_tokens,"
                  " t.total_tokens, t.cost_usd, t.response_time_ms, t.status, t.error_message,"
                  " t.function_calls_count, t.mcp_calls_count, t.functions_called, t.mcp_tools_called,"
                  " t.created_at,"
                  " t.is_voice_request, t.audio_duration_seconds, t.audio_input_seconds, t.audio_output_seconds,"
                  " u.email, u.first_name, u.last_name"
                  " FROM llm_usage_transactions t"
                  " LEFT JOIN users u ON t.user_id = u.id"
                  + (f" {whereClause}" if whereClause else "")
                  + " ORDER BY t.created_at DESC"
                    " LIMIT :limit OFFSET :offset")
            txnParams = dict(params)
            txnParams[':limit'] = limit
            txnParams[':offset'] = offset
            transactions = self.db.fetch_all(sql, txnParams)

            countSql = "SELECT COUNT(*) as total FROM llm_usage_transactions t" + (
                f" {whereClause}" if whereClause else "")
            countRow = self.db.fetch_one(countSql, params if params else None) or {}
            total = php_intval(countRow.get('total'))

            def _fmt(t):
                firstName = t['first_name'] if t.get('first_name') is not None else ''
                lastName = t['last_name'] if t.get('last_name') is not None else ''
                name = php_trim(f'{firstName} {lastName}')
                if php_empty(name):
                    name = 'Unknown'
                functionsCalled = t.get('functions_called')
                mcpToolsCalled = t.get('mcp_tools_called')
                return {
                    'id': php_intval(t['id']),
                    'user_id': php_intval(t['user_id']),
                    'user_email': t['email'] if t.get('email') is not None else 'Unknown',
                    'user_name': name,
                    'provider': t['provider'],
                    'model': t['model'],
                    'prompt_tokens': php_intval(t['prompt_tokens']),
                    'completion_tokens': php_intval(t['completion_tokens']),
                    'total_tokens': php_intval(t['total_tokens']),
                    'cost': php_round(php_floatval(t['cost_usd']), 6),
                    'response_time_ms': php_intval(t['response_time_ms']),
                    'status': t['status'],
                    'error_message': t['error_message'],
                    'function_calls': php_intval(t['function_calls_count']),
                    'mcp_calls': php_intval(t['mcp_calls_count'] if t.get('mcp_calls_count') is not None else 0),
                    'functions_called': php_json_decode(functionsCalled) if php_bool(functionsCalled) else [],
                    'mcp_tools_called': php_json_decode(mcpToolsCalled) if php_bool(mcpToolsCalled) else [],
                    'created_at': t['created_at'],
                    'is_voice': php_bool(t['is_voice_request'] if t.get('is_voice_request') is not None else 0),
                    'audio_seconds': php_round(
                        php_floatval(t['audio_duration_seconds'] if t.get('audio_duration_seconds') is not None else 0), 2),
                    'audio_input_seconds': php_round(
                        php_floatval(t['audio_input_seconds'] if t.get('audio_input_seconds') is not None else 0), 2),
                    'audio_output_seconds': php_round(
                        php_floatval(t['audio_output_seconds'] if t.get('audio_output_seconds') is not None else 0), 2),
                }

            return {
                'success': True,
                'transactions': [_fmt(t) for t in transactions],
                'pagination': {'total': total, 'limit': limit, 'offset': offset},
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def getToolStats(self, request) -> dict:
        try:
            query = request['query'] if request.get('query') is not None else {}
            period = query['period'] if query.get('period') is not None else 'month'
            dateRange = self.getDateRange(period)

            mcpToolsFromDb = self.loadRegisteredMCPTools()

            overallSql = ("SELECT"
                         " COUNT(*) as total_requests,"
                         " COALESCE(SUM(function_calls_count), 0) as total_function_calls,"
                         " COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls,"
                         " SUM(CASE WHEN function_calls_count > 0 THEN 1 ELSE 0 END) as requests_with_tools"
                         " FROM llm_usage_transactions"
                         " WHERE created_at BETWEEN :date_from AND :date_to")
            overall = self.db.fetch_one(
                overallSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']}) or {}

            byProviderSql = ("SELECT"
                            " provider,"
                            " COALESCE(SUM(function_calls_count), 0) as function_calls,"
                            " COALESCE(SUM(mcp_calls_count), 0) as mcp_calls"
                            " FROM llm_usage_transactions"
                            " WHERE created_at BETWEEN :date_from AND :date_to"
                            " AND function_calls_count > 0"
                            " GROUP BY provider ORDER BY function_calls DESC")
            byProvider = self.db.fetch_all(
                byProviderSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']})

            toolsSql = ("SELECT user_id, functions_called, mcp_tools_called, created_at"
                       " FROM llm_usage_transactions"
                       " WHERE created_at BETWEEN :date_from AND :date_to"
                       " AND functions_called IS NOT NULL")
            rows = self.db.fetch_all(
                toolsSql, {':date_from': dateRange['from'], ':date_to': dateRange['to']})

            toolStats: dict = {}
            mcpToolStats: dict = {}

            for row in rows:
                functions = php_values(php_json_decode(row.get('functions_called')))
                mcpTools = php_values(php_json_decode(row.get('mcp_tools_called')))
                userId = row.get('user_id')
                createdAt = row.get('created_at')

                for fn in functions:
                    if fn not in toolStats:
                        toolStats[fn] = {'count': 0, 'users': {}, 'last_used': None, 'is_mcp': False}
                    toolStats[fn]['count'] += 1
                    toolStats[fn]['users'][userId] = True
                    if toolStats[fn]['last_used'] is None or (
                            createdAt is not None and createdAt > toolStats[fn]['last_used']):
                        toolStats[fn]['last_used'] = createdAt

                for toolName in mcpTools:
                    if toolName not in toolStats:
                        toolStats[toolName] = {'count': 0, 'users': {}, 'last_used': None, 'is_mcp': True}
                    toolStats[toolName]['count'] += 1
                    toolStats[toolName]['is_mcp'] = True
                    toolStats[toolName]['users'][userId] = True
                    if toolStats[toolName]['last_used'] is None or (
                            createdAt is not None and createdAt > toolStats[toolName]['last_used']):
                        toolStats[toolName]['last_used'] = createdAt

                    if toolName not in mcpToolStats:
                        mcpToolStats[toolName] = {'count': 0, 'users': {}, 'last_used': None}
                    mcpToolStats[toolName]['count'] += 1
                    mcpToolStats[toolName]['users'][userId] = True
                    if mcpToolStats[toolName]['last_used'] is None or (
                            createdAt is not None and createdAt > mcpToolStats[toolName]['last_used']):
                        mcpToolStats[toolName]['last_used'] = createdAt

            # uasort($toolStats, fn($a,$b) => $b['count']-$a['count']) — PHP
            # 8's sort functions are stable, matching Python's sorted().
            toolStatsSorted = sorted(toolStats.items(), key=lambda kv: -kv[1]['count'])

            detailedTools = []
            totalMcpCalls = 0
            count = 0
            for name, stats in toolStatsSorted:
                mcpInfo = self.isMCPToolFromRegistry(name, mcpToolsFromDb)
                isMcp = mcpInfo is not None
                if isMcp:
                    totalMcpCalls += stats['count']
                detailedTools.append({
                    'name': name,
                    'count': stats['count'],
                    'unique_users': len(stats['users']),
                    'last_used': stats['last_used'],
                    'is_mcp': isMcp,
                    'mcp_server': mcpInfo.get('server_name') if mcpInfo else None,
                })
                count += 1
                if count >= 50:
                    break

            mcpServerStats: dict = {}
            for tool in detailedTools:
                if tool['is_mcp'] and tool['mcp_server']:
                    serverName = tool['mcp_server']
                    if serverName not in mcpServerStats:
                        mcpServerStats[serverName] = {
                            'name': serverName, 'total_calls': 0, 'tool_count': 0,
                            'unique_users': {}, 'tools': [],
                        }
                    mcpServerStats[serverName]['total_calls'] += tool['count']
                    mcpServerStats[serverName]['tool_count'] += 1
                    if tool['name'] in toolStats:
                        for uid in toolStats[tool['name']]['users']:
                            mcpServerStats[serverName]['unique_users'][uid] = True
                    mcpServerStats[serverName]['tools'].append({
                        'name': tool['name'], 'count': tool['count'],
                        'unique_users': tool['unique_users'], 'last_used': tool['last_used'],
                    })

            for server in mcpServerStats.values():
                server['tools'].sort(key=lambda t: -t['count'])
                server['unique_users'] = len(server['unique_users'])

            mcpServers = [s for _, s in sorted(mcpServerStats.items(), key=lambda kv: -kv[1]['total_calls'])]

            totalRequests = php_intval(overall.get('total_requests'))
            requestsWithTools = php_intval(overall.get('requests_with_tools'))
            toolUsageRate = php_round((requestsWithTools / totalRequests) * 100, 1) if totalRequests > 0 else 0

            regularToolsUsed = [t for t in detailedTools if not t['is_mcp']]
            mcpToolsUsed = [t for t in detailedTools if t['is_mcp']]

            allAvailableRegularTools = self.loadAllAvailableRegularTools(toolStats)
            allAvailableMcpTools = self.loadAllAvailableMCPTools(toolStats)

            return {
                'success': True,
                'period': period,
                'date_range': dateRange,
                'total_function_calls': php_intval(overall.get('total_function_calls')),
                'total_mcp_calls': totalMcpCalls,
                'total_requests': totalRequests,
                'requests_with_tools': requestsWithTools,
                'tool_usage_rate': toolUsageRate,
                'unique_tools_count': len(toolStats),
                'unique_mcp_tools_count': len(mcpToolsUsed),
                'top_tools': detailedTools,
                'regular_tools': regularToolsUsed,
                'mcp_tools': mcpToolsUsed,
                'mcp_servers': mcpServers,
                'all_regular_tools': allAvailableRegularTools,
                'all_mcp_tools': allAvailableMcpTools,
                'by_provider': [
                    {
                        'provider': p['provider'],
                        'function_calls': php_intval(p['function_calls']),
                        'mcp_calls': php_intval(p['mcp_calls']),
                    }
                    for p in byProvider
                ],
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def loadRegisteredMCPTools(self) -> dict:
        """AdminController.php:1763-1791."""
        mcpTools: dict = {}
        try:
            rows = self.db.fetch_all(
                "SELECT t.tool_name, s.name as server_name, s.id as server_id"
                " FROM mcp_server_tools t JOIN mcp_servers s ON t.server_id = s.id")
            for row in rows:
                toolName = row['tool_name']
                info = {'server_name': row['server_name'], 'server_id': row['server_id']}
                mcpTools[toolName] = info
                mcpTools['mcp_' + toolName] = dict(info)
        except Exception as e:  # noqa: BLE001
            error_log('Failed to load MCP tools: ' + str(e))
        return mcpTools

    def isMCPToolFromRegistry(self, toolName: str, mcpToolsRegistry: dict):
        """AdminController.php:1797-1818."""
        if toolName in mcpToolsRegistry:
            return mcpToolsRegistry[toolName]
        if ('mcp_' + toolName) in mcpToolsRegistry:
            return mcpToolsRegistry['mcp_' + toolName]
        if toolName.startswith('mcp_'):
            withoutPrefix = toolName[4:]
            if withoutPrefix in mcpToolsRegistry:
                return mcpToolsRegistry[withoutPrefix]
        return None

    def loadAllAvailableRegularTools(self, usageStats: dict) -> list:
        """AdminController.php:1824-1867. `claude_tools.json` is mirrored
        byte-for-byte into backend_python/resources/ (Phase 7 final-review
        wave, B7 — previously read straight from the PHP repo's copy at
        `../backend/resources/...`, with no local copy at all; see
        test_admin_controller_part2.py's test_claude_tools_json_matches_php_source
        for the drift check). Falls back to the PHP tree's copy only if the
        local mirror is ever deleted."""
        tools = []
        toolsJsonPath = Path(__file__).resolve().parents[2] / 'resources' / 'claude_tools.json'
        if not toolsJsonPath.exists():
            toolsJsonPath = Path(__file__).resolve().parents[3] / 'backend' / 'resources' / 'claude_tools.json'

        if toolsJsonPath.exists():
            content = toolsJsonPath.read_text(encoding='utf-8')
            toolDefinitions = php_values(php_json_decode(content))
            for tool in toolDefinitions:
                if not isinstance(tool, dict):
                    continue
                name = tool.get('name') if tool.get('name') is not None else ''
                if not name:
                    continue
                usage = usageStats.get(name)
                tools.append({
                    'name': name,
                    'description': tool['description'] if tool.get('description') is not None else '',
                    'count': usage['count'] if usage else 0,
                    'unique_users': len(usage['users']) if usage else 0,
                    'last_used': usage['last_used'] if usage else None,
                    'is_mcp': False,
                    'has_been_used': usage is not None,
                })

        def _cmp(a, b):
            if a['has_been_used'] != b['has_been_used']:
                return -1 if a['has_been_used'] else 1
            if a['count'] != b['count']:
                return b['count'] - a['count']
            return (a['name'] > b['name']) - (a['name'] < b['name'])
        tools.sort(key=cmp_to_key(_cmp))
        return tools

    def loadAllAvailableMCPTools(self, usageStats: dict) -> list:
        """AdminController.php:1873-1924."""
        tools = []
        try:
            rows = self.db.fetch_all(
                "SELECT t.tool_name, t.tool_description, s.name as server_name, s.url as server_url"
                " FROM mcp_server_tools t JOIN mcp_servers s ON t.server_id = s.id"
                " ORDER BY s.name, t.tool_name")
            for row in rows:
                originalName = row['tool_name']
                prefixedName = 'mcp_' + originalName
                usage = php_coalesce(usageStats.get(prefixedName), usageStats.get(originalName))
                tools.append({
                    'name': prefixedName,
                    'original_name': originalName,
                    'description': row['tool_description'] if row.get('tool_description') is not None else '',
                    'mcp_server': row['server_name'],
                    'server_url': row['server_url'],
                    'count': usage['count'] if usage else 0,
                    'unique_users': len(usage['users']) if usage else 0,
                    'last_used': usage['last_used'] if usage else None,
                    'is_mcp': True,
                    'has_been_used': usage is not None,
                })
        except Exception as e:  # noqa: BLE001
            error_log('Failed to load MCP tools: ' + str(e))

        def _cmp(a, b):
            if a['has_been_used'] != b['has_been_used']:
                return -1 if a['has_been_used'] else 1
            if a['count'] != b['count']:
                return b['count'] - a['count']
            serverCmp = (a['mcp_server'] > b['mcp_server']) - (a['mcp_server'] < b['mcp_server'])
            if serverCmp != 0:
                return serverCmp
            return (a['name'] > b['name']) - (a['name'] < b['name'])
        tools.sort(key=cmp_to_key(_cmp))
        return tools

    def getDateRange(self, period: str, dateFrom: str | None = None, dateTo: str | None = None) -> dict:
        """AdminController.php:1929-1957. `strtotime('-N days')` relative to
        "now" then formatted as just Y-m-d (with a literal 00:00:00 time) is
        equivalent to (today's date - N calendar days) — negligible DST/exact
        -midnight edge cases aside, not observable in the differential."""
        if dateFrom and dateTo:
            return {'from': dateFrom, 'to': dateTo}

        now = datetime.now(php_tz())
        to = now.strftime('%Y-%m-%d 23:59:59')
        today = now.date()

        if period == 'day':
            fromDate = today
        elif period == 'week':
            fromDate = today - timedelta(days=7)
        elif period == 'month':
            fromDate = today - timedelta(days=30)
        elif period == 'year':
            fromDate = today - timedelta(days=365)
        elif period == 'all':
            return {'from': '2000-01-01 00:00:00', 'to': to}
        else:
            fromDate = today - timedelta(days=30)

        return {'from': fromDate.strftime('%Y-%m-%d 00:00:00'), 'to': to}

    # ─── admin MCP server management (AdminController.php:1966-2449;
    #     routes.php 228-233) ───────────────────────────────────────────────

    def listMCPServers(self, request) -> dict:
        try:
            self.ensureMCPSchema()
            query = request['query'] if request.get('query') is not None else {}
            scope = query['scope'] if query.get('scope') is not None else 'all'
            rawUserId = query.get('user_id')
            filterUserId = php_strval(rawUserId) if (rawUserId is not None and rawUserId != '') else None

            where = ''
            params: list = []
            if scope == 'global':
                where = 'WHERE s.user_id IS NULL'
            elif scope == 'user' and filterUserId is not None:
                where = 'WHERE s.user_id = ?'
                params.append(filterUserId)
            elif filterUserId is not None:
                where = 'WHERE s.user_id = ?'
                params.append(filterUserId)

            sql = ("SELECT s.*, COUNT(t.id) as tool_count FROM mcp_servers s"
                  " LEFT JOIN mcp_server_tools t ON s.id = t.server_id"
                  + (f" {where}" if where else "")
                  + " GROUP BY s.id ORDER BY (s.user_id IS NULL) DESC, s.name ASC")
            servers = self.db.fetch_all(sql, params if params else None)

            userIds = []
            seen = set()
            for s in servers:
                uid = s.get('user_id')
                if uid is not None and uid not in seen:
                    seen.add(uid)
                    userIds.append(uid)

            userEmails: dict = {}
            if userIds:
                placeholders = ','.join('?' for _ in userIds)
                urows = self.db.fetch_all(f"SELECT id, email FROM users WHERE id IN ({placeholders})", userIds)
                for u in urows:
                    userEmails[php_strval(u['id'])] = u['email']

            def _fmt(s):
                headers = None
                if not php_empty(s.get('headers')):
                    decoded = php_json_decode(s['headers'])
                    if isinstance(decoded, (dict, list)):
                        headers = decoded
                return {
                    'id': php_intval(s['id']),
                    'is_global': s.get('user_id') is None,
                    'user_id': s.get('user_id'),
                    'user_email': (userEmails.get(php_strval(s['user_id'])) if s.get('user_id') is not None else None),
                    'name': s['name'],
                    'url': s['url'],
                    'description': s['description'],
                    'headers': headers,
                    'enabled': php_bool(s['enabled']),
                    'tool_count': php_intval(s['tool_count']),
                    'created_at': s['created_at'],
                    'updated_at': s['updated_at'],
                }

            return {'success': True, 'servers': [_fmt(s) for s in servers], 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def ensureMCPSchema(self) -> None:
        """AdminController.php:2048-2092. No runtime DDL (constraints.md §3):
        presence-check + log only, mirroring the ensure*TableExists() pattern
        — including for the two index checks DbPresence itself doesn't cover."""
        try:
            legacyIndex = self.db.fetch_all(
                "SELECT COUNT(*) as c FROM information_schema.statistics"
                " WHERE table_schema = DATABASE() AND table_name = 'mcp_servers'"
                " AND index_name = 'unique_server_name'")
            legacyCount = php_intval(legacyIndex[0]['c']) if legacyIndex else 0
            if legacyCount > 0:
                error_log('[AdminController] mcp_servers.unique_server_name legacy index present'
                         ' — PHP drops it on demand')

            scopeIndex = self.db.fetch_all(
                "SELECT COUNT(*) as c FROM information_schema.statistics"
                " WHERE table_schema = DATABASE() AND table_name = 'mcp_servers'"
                " AND index_name = 'unique_scope_name'")
            scopeCount = php_intval(scopeIndex[0]['c']) if scopeIndex else 0
            if scopeCount == 0:
                error_log('[AdminController] mcp_servers.unique_scope_name index missing — PHP adds it on demand')

            self._presence.column('mcp_servers', 'headers')
        except Exception as e:  # noqa: BLE001
            error_log('[Admin] ensureMCPSchema warning: ' + str(e))

    def normalizeMCPHeaders(self, raw):
        """AdminController.php:2099-2129. Returns (headerList, jsonToStore);
        raises ValueError (mirrors PHP's `throw new Exception(...)`) on
        invalid input — callers translate that to a 400."""
        if raw is None or raw == '' or raw == []:
            return [], None
        if isinstance(raw, str):
            decoded = php_json_decode(raw)
            if not isinstance(decoded, (list, dict)):
                raise ValueError('Headers must be a JSON object, e.g. {"Authorization":"Bearer ..."}')
            raw = decoded
        if not isinstance(raw, (list, dict)):
            raise ValueError('Headers must be a JSON object')

        headerList = []
        for name, value in php_items(raw):
            if not isinstance(name, str) or name == '' or re.search(r'[\r\n:]', name):
                raise ValueError(f'Invalid header name: {php_strval(name)}')
            if value is None or isinstance(value, (list, dict)):
                raise ValueError(f"Header '{name}' value must be a string")
            strValue = php_strval(value)
            if re.search(r'[\r\n]', strValue):
                raise ValueError(f"Header '{name}' contains invalid characters")
            headerList.append(f'{name}: {strValue}')
        return headerList, php_json_encode(raw)

    def createMCPServer(self, request) -> dict:
        try:
            self.ensureMCPSchema()
            input_ = request['body']

            name = php_trim(input_['name'] if input_.get('name') is not None else '')
            url = php_trim(input_['url'] if input_.get('url') is not None else '')
            description = php_trim(input_['description'] if input_.get('description') is not None else '')
            rawUserId = input_.get('user_id')
            userId = (None if (rawUserId is None or rawUserId == '' or rawUserId == 0 or rawUserId == '0')
                     else php_strval(rawUserId))

            if php_empty(name) or php_empty(url):
                return {'success': False, 'error': 'Name and URL are required', 'status_code': 400}

            if not _filter_validate_url(url):
                return {'success': False, 'error': 'Invalid URL format', 'status_code': 400}

            if userId is None:
                existing = self.db.fetch_one(
                    "SELECT id FROM mcp_servers WHERE user_id IS NULL AND name = ?", [name])
            else:
                existing = self.db.fetch_one(
                    "SELECT id FROM mcp_servers WHERE user_id = ? AND name = ?", [userId, name])
            if existing:
                return {
                    'success': False,
                    'error': ('A global server with this name already exists' if userId is None
                             else 'This user already has a server with this name'),
                    'status_code': 409,
                }

            try:
                headerList, headersJson = self.normalizeMCPHeaders(input_.get('headers'))
            except ValueError as e:
                return {'success': False, 'error': str(e), 'status_code': 400}

            serverId = self.db.insert(
                "INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled)"
                " VALUES (?, ?, ?, ?, ?, 1)",
                [userId, name, url, description, headersJson])

            toolsResult = self.fetchMCPServerTools(php_intval(serverId), url, headerList)

            return {
                'success': True,
                'server_id': php_intval(serverId),
                'tools_fetched': toolsResult['count'] if toolsResult.get('count') is not None else 0,
                'tools_error': toolsResult.get('error'),
                'message': 'MCP server created successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def updateMCPServer(self, request) -> dict:
        try:
            input_ = request['body']
            serverId = php_intval(input_['server_id'] if input_.get('server_id') is not None else 0)
            name = php_trim(input_['name'] if input_.get('name') is not None else '')
            url = php_trim(input_['url'] if input_.get('url') is not None else '')
            description = php_trim(input_['description'] if input_.get('description') is not None else '')

            if not serverId:
                return {'success': False, 'error': 'Server ID is required', 'status_code': 400}

            if php_empty(name) or php_empty(url):
                return {'success': False, 'error': 'Name and URL are required', 'status_code': 400}

            self.ensureMCPSchema()

            try:
                headerList, headersJson = self.normalizeMCPHeaders(input_.get('headers'))
            except ValueError as e:
                return {'success': False, 'error': str(e), 'status_code': 400}

            existing = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ?", [serverId])
            if not existing:
                return {'success': False, 'error': 'Server not found', 'status_code': 404}

            urlChanged = existing['url'] != url
            headersChanged = existing.get('headers') != headersJson

            self.db.execute(
                "UPDATE mcp_servers SET name = ?, url = ?, description = ?, headers = ?, updated_at = NOW()"
                " WHERE id = ?",
                [name, url, description, headersJson, serverId])

            toolsFetched = 0
            toolsError = None
            if urlChanged or headersChanged:
                self.db.execute("DELETE FROM mcp_server_tools WHERE server_id = ?", [serverId])
                toolsResult = self.fetchMCPServerTools(serverId, url, headerList)
                toolsFetched = toolsResult['count'] if toolsResult.get('count') is not None else 0
                toolsError = toolsResult.get('error')

            return {
                'success': True,
                'tools_fetched': toolsFetched,
                'tools_error': toolsError,
                'message': 'MCP server updated successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def toggleMCPServer(self, request) -> dict:
        try:
            input_ = request['body']
            serverId = php_intval(input_['server_id'] if input_.get('server_id') is not None else 0)
            enabled = php_bool(input_['enabled'] if input_.get('enabled') is not None else True)

            if not serverId:
                return {'success': False, 'error': 'Server ID is required', 'status_code': 400}

            rowcount = self.db.execute(
                "UPDATE mcp_servers SET enabled = ?, updated_at = NOW() WHERE id = ?",
                [1 if enabled else 0, serverId])

            if rowcount == 0:
                return {'success': False, 'error': 'Server not found', 'status_code': 404}

            return {'success': True, 'message': 'Server enabled' if enabled else 'Server disabled',
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def deleteMCPServer(self, request, serverId: int) -> dict:
        try:
            if not serverId:
                return {'success': False, 'error': 'Server ID is required', 'status_code': 400}

            server = self.db.fetch_one("SELECT name FROM mcp_servers WHERE id = ?", [serverId])
            if not server:
                return {'success': False, 'error': 'Server not found', 'status_code': 404}

            self.db.execute("DELETE FROM mcp_servers WHERE id = ?", [serverId])

            return {'success': True, 'message': f"Server '{server['name']}' deleted successfully",
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def refreshMCPServerTools(self, request) -> dict:
        try:
            input_ = request['body']
            serverId = php_intval(input_['server_id'] if input_.get('server_id') is not None else 0)

            if not serverId:
                return {'success': False, 'error': 'Server ID is required', 'status_code': 400}

            server = self.db.fetch_one("SELECT url, headers FROM mcp_servers WHERE id = ?", [serverId])
            if not server:
                return {'success': False, 'error': 'Server not found', 'status_code': 404}

            headerList, _ = self.normalizeMCPHeaders(server.get('headers'))

            self.db.execute("DELETE FROM mcp_server_tools WHERE server_id = ?", [serverId])

            result = self.fetchMCPServerTools(serverId, server['url'], headerList)

            return {
                'success': True,
                'tools_fetched': result['count'] if result.get('count') is not None else 0,
                'tools_error': result.get('error'),
                'tools': result['tools'] if result.get('tools') is not None else [],
                'message': 'Tools refreshed successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def fetchMCPServerTools(self, serverId: int, serverUrl: str, extraHeaders: list | None = None) -> dict:
        """AdminController.php:3558-3672. Performs the full MCP handshake
        (initialize -> notifications/initialized -> tools/list) and stores
        the resulting tools.

        `data` here comes from mcpHttpCall()'s assoc-mode JSON decode — PHP's
        own re-decode-as-object trick at line 3610 (`json_decode(json_encode(
        ...))` without `true`, "to preserve {} in inputSchema") is a no-op
        given PHP already assoc-decoded the body once inside mcpHttpCall: an
        originally-empty `{}` inputSchema is already an indistinguishable-
        from-`[]` PHP array by that point, and re-encoding+re-decoding it
        (even in object mode) cannot recover information already lost —
        `json_decode("[]")` returns array(), never stdClass, regardless of
        the assoc flag. So this port skips PHP's redundant intermediate step
        (behaviorally identical) and reads `tool['inputSchema']` directly
        from the already-decoded dict.
        """
        extraHeaders = extraHeaders or []
        try:
            mcpUrl = serverUrl.rstrip('/')
            error_log(f'[Admin] fetchMCPServerTools: serverId={serverId}, url={mcpUrl}')

            sessionRef: dict = {'id': None}

            initResult = self.mcpHttpCall(mcpUrl, {
                'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                'params': {
                    'protocolVersion': '2024-11-05',
                    'clientInfo': {'name': 'GPT-Admin-MCP-Client', 'version': '1.0.0'},
                    'capabilities': {},
                },
            }, extraHeaders, sessionRef)
            if not initResult['ok']:
                error_log('[Admin] fetchMCPServerTools initialize FAILED: ' + str(initResult['error']))
                return {'count': 0, 'error': 'initialize failed: ' + str(initResult['error'])}
            if isinstance(initResult.get('data'), dict) and 'error' in initResult['data']:
                errObj = initResult['data']['error']
                msg = errObj.get('message', 'server error') if isinstance(errObj, dict) else 'server error'
                return {'count': 0, 'error': 'initialize error: ' + str(msg)}

            self.mcpHttpCall(mcpUrl, {
                'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {},
            }, extraHeaders, sessionRef, expectResponse=False)

            listResult = self.mcpHttpCall(mcpUrl, {
                'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {},
            }, extraHeaders, sessionRef)
            if not listResult['ok']:
                error_log('[Admin] fetchMCPServerTools tools/list FAILED: ' + str(listResult['error']))
                return {'count': 0, 'error': 'tools/list failed: ' + str(listResult['error'])}
            if isinstance(listResult.get('data'), dict) and 'error' in listResult['data']:
                errObj = listResult['data']['error']
                msg = errObj.get('message', 'server error') if isinstance(errObj, dict) else 'server error'
                return {'count': 0, 'error': 'tools/list error: ' + str(msg)}

            data = listResult.get('data') or {}
            result = data.get('result') if isinstance(data, dict) else None
            tools = result.get('tools') if isinstance(result, dict) else None
            if not isinstance(tools, list):
                tools = []

            error_log(f'[Admin] fetchMCPServerTools found {len(tools)} tools')

            if not tools:
                return {'count': 0, 'tools': []}

            insertSql = ("INSERT INTO mcp_server_tools"
                        " (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)"
                        " VALUES (?, ?, ?, ?, ?, ?)"
                        " ON DUPLICATE KEY UPDATE tool_description = VALUES(tool_description),"
                        " input_schema = VALUES(input_schema), has_ui = VALUES(has_ui),"
                        " ui_resource_uri = VALUES(ui_resource_uri)")

            toolNames = []
            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                name = tool['name'] if tool.get('name') is not None else ''
                if not name:
                    continue

                description = tool['description'] if tool.get('description') is not None else ''
                inputSchema = (php_json_encode(tool['inputSchema'])
                               if tool.get('inputSchema') is not None
                               else '{"type":"object","properties":{}}')

                meta = tool.get('_meta') if isinstance(tool.get('_meta'), dict) else {}
                annotations = tool.get('annotations') if isinstance(tool.get('annotations'), dict) else {}
                metaUi = meta.get('ui') if isinstance(meta.get('ui'), dict) else None
                hasUi = 1 if (not php_empty(metaUi) or not php_empty(annotations.get('hasUI'))) else 0
                uiResourceUri = php_coalesce(
                    metaUi.get('resourceUri') if metaUi else None, annotations.get('uiResourceUri'))

                dbInfo = self.db.fetch_one('SELECT DATABASE() as db')
                error_log('[Admin] Using database: ' + str((dbInfo or {}).get('db', 'unknown')))
                error_log(f'[Admin] Inserting tool: name={name}, serverId={serverId}, hasUi={hasUi}')
                try:
                    self.db.execute(insertSql, [serverId, name, description, inputSchema, hasUi, uiResourceUri])
                    verify = self.db.fetch_one(
                        "SELECT id FROM mcp_server_tools WHERE server_id = ? AND tool_name = ?", [serverId, name])
                    error_log('[Admin] Verify insert - found: ' + (f"YES id={verify['id']}" if verify else 'NO'))
                except Exception as e:  # noqa: BLE001
                    error_log(f'[Admin] INSERT FAILED for {name}: {e}')

                toolNames.append(name)

            return {'count': len(toolNames), 'tools': toolNames}
        except Exception as e:  # noqa: BLE001
            error_log('Failed to fetch MCP tools: ' + str(e))
            return {'count': 0, 'error': str(e)}

    def mcpHttpCall(self, url: str, requestBody: dict, extraHeaders: list, sessionRef: dict,
                    expectResponse: bool = True) -> dict:
        """AdminController.php:3679-3753. Low-level MCP HTTP call with SSE
        support + session id propagation. `sessionRef['id']` plays the role
        of PHP's by-reference `&$sessionId` — mutated in place across calls."""
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream, */*'}
        for h in extraHeaders:
            if ':' in h:
                k, v = h.split(':', 1)
                headers[php_trim(k)] = php_trim(v)
        if sessionRef.get('id'):
            headers['Mcp-Session-Id'] = sessionRef['id']

        try:
            with httpx.Client(verify=SHARED_SSL_CONTEXT,
                              timeout=httpx.Timeout(30.0, connect=10.0)) as client:
                resp = client.post(url, content=php_json_encode(requestBody), headers=headers,
                                   follow_redirects=True)
        except Exception as e:  # noqa: BLE001
            return {'ok': False, 'error': str(e), 'data': None}

        sid = resp.headers.get('mcp-session-id')
        if sid:
            sessionRef['id'] = php_trim(sid)

        if resp.status_code >= 400:
            body = resp.text or ''
            return {'ok': False, 'error': f'HTTP {resp.status_code}: {body[:200]}', 'data': None}

        if not expectResponse:
            return {'ok': True, 'error': None, 'data': None}

        body = resp.text or ''
        decoded = php_json_decode(body)
        if isinstance(decoded, (dict, list)):
            return {'ok': True, 'error': None, 'data': decoded}

        sseData = None
        for line in body.split('\n'):
            line = php_trim(line)
            if line.startswith('data:'):
                d = php_trim(line[5:])
                if d != '':
                    parsed = php_json_decode(d)
                    if isinstance(parsed, (dict, list)):
                        sseData = parsed
        if sseData is not None:
            return {'ok': True, 'error': None, 'data': sseData}

        return {'ok': False, 'error': 'Unparseable response: ' + body[:200], 'data': None}

    # ─── per-user MCP overrides (AdminController.php:2451-2606;
    #     routes.php 235-238) — cascade: package → admin override → user pref ─

    def getUserMCPServers(self, request, userId: int) -> dict:
        try:
            resolver = PackageResolver(self.db)
            packageAllowlist = resolver.allowedMcpServers(userId)  # None = allow all

            sql = ("SELECT s.id, s.name, s.url, s.description, s.user_id, s.enabled,"
                  " COUNT(t.id) AS tool_count"
                  " FROM mcp_servers s"
                  " LEFT JOIN mcp_server_tools t ON t.server_id = s.id"
                  " WHERE s.user_id IS NULL OR s.user_id = :uid"
                  " GROUP BY s.id"
                  " ORDER BY (s.user_id IS NULL) DESC, s.name ASC")
            rows = self.db.fetch_all(sql, {':uid': php_strval(userId)})

            overrideRows = self.db.fetch_all(
                "SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?", [userId])
            overrides = {php_intval(r['server_id']): php_bool(r['allowed']) for r in overrideRows}

            def _fmt(row):
                serverId = php_intval(row['id'])
                isGlobal = row.get('user_id') is None
                isPrivate = not isGlobal

                packageDefault = (isPrivate
                                 or packageAllowlist is None
                                 or row['name'] in packageAllowlist)

                override = overrides[serverId] if serverId in overrides else None
                effective = override if override is not None else packageDefault

                return {
                    'id': serverId,
                    'name': row['name'],
                    'url': row['url'],
                    'description': row['description'],
                    'is_global': isGlobal,
                    'is_user_private': isPrivate,
                    'enabled': php_bool(row['enabled']),
                    'tool_count': php_intval(row['tool_count']),
                    'package_default': packageDefault,
                    'override': override,
                    'effective': php_bool(effective),
                }

            return {
                'success': True,
                'user_id': userId,
                'package_allowlist': packageAllowlist,
                'servers': [_fmt(r) for r in rows],
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def setUserMCPOverride(self, request, userId: int, serverId: int) -> dict:
        try:
            body = request['body'] if request.get('body') is not None else {}
            if 'allowed' not in body:
                return {'success': False, 'error': 'Field "allowed" is required (boolean).', 'status_code': 400}
            allowed = php_bool(body['allowed'])

            userRow = self.db.fetch_one("SELECT 1 FROM users WHERE id = ?", [userId])
            if not userRow:
                return {'success': False, 'error': 'User not found', 'status_code': 404}
            serverRow = self.db.fetch_one("SELECT 1 FROM mcp_servers WHERE id = ?", [serverId])
            if not serverRow:
                return {'success': False, 'error': 'MCP server not found', 'status_code': 404}

            self.db.execute(
                "INSERT INTO user_mcp_overrides (user_id, server_id, allowed) VALUES (:uid, :sid, :allowed)"
                " ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), updated_at = CURRENT_TIMESTAMP",
                {':uid': userId, ':sid': serverId, ':allowed': 1 if allowed else 0})

            return {'success': True, 'user_id': userId, 'server_id': serverId, 'allowed': allowed,
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def clearUserMCPOverride(self, request, userId: int, serverId: int) -> dict:
        try:
            rowcount = self.db.execute(
                "DELETE FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?", [userId, serverId])
            return {'success': True, 'user_id': userId, 'server_id': serverId, 'cleared': rowcount > 0,
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ─── costs management (AdminController.php:2608-3376; routes.php 240-244) ─

    def getCosts(self, request) -> dict:
        try:
            self.ensureCostsTableExists()
            rows = self.db.fetch_all("SELECT * FROM provider_costs ORDER BY category, provider")

            costs = {'llm': [], 'voice': [], 'avatar': [], 'lastRefreshed': None}
            for row in rows:
                tiers = php_json_decode(row.get('tiers'))
                costs[row['category']].append({
                    'provider': row['provider'],
                    'displayName': row['display_name'],
                    'category': row['category'],
                    'tiers': tiers if tiers is not None else [],
                    'pricingUrl': row['pricing_url'],
                    'lastUpdated': row['updated_at'],
                    'notes': row['notes'],
                })
                if not costs['lastRefreshed'] or (
                        row['updated_at'] is not None and row['updated_at'] > costs['lastRefreshed']):
                    costs['lastRefreshed'] = row['updated_at']

            if not costs['llm'] and not costs['voice'] and not costs['avatar']:
                costs = self.getDefaultCosts()

            usageCosts = self._getUsageCostsBreakdown()

            return {'success': True, 'costs': costs, 'usageCosts': usageCosts, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def refreshAllCosts(self, request) -> dict:
        try:
            self.ensureCostsTableExists()

            allCosts = self.getDefaultCosts()
            updated = 0
            errors = []

            for category in ('llm', 'voice', 'avatar'):
                for provider in allCosts[category]:
                    try:
                        updatedProvider = self.fetchProviderPricing(provider)
                        if updatedProvider:
                            self.saveProviderCosts(category, updatedProvider)
                            updated += 1
                    except Exception as e:  # noqa: BLE001
                        errors.append(f"{provider['provider']}: {e}")

            rows = self.db.fetch_all("SELECT * FROM provider_costs ORDER BY category, provider")
            costs = {'llm': [], 'voice': [], 'avatar': [], 'lastRefreshed': php_now()}
            for row in rows:
                tiers = php_json_decode(row.get('tiers'))
                costs[row['category']].append({
                    'provider': row['provider'],
                    'displayName': row['display_name'],
                    'category': row['category'],
                    'tiers': tiers if tiers is not None else [],
                    'pricingUrl': row['pricing_url'],
                    'lastUpdated': row['updated_at'],
                    'notes': row['notes'],
                })

            usageCosts = self._getUsageCostsBreakdown()

            return {
                'success': True, 'costs': costs, 'usageCosts': usageCosts,
                'updated_count': updated, 'errors': errors, 'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def refreshProviderCosts(self, request) -> dict:
        try:
            input_ = request['body']
            category = input_['category'] if input_.get('category') is not None else ''
            providerName = input_['provider'] if input_.get('provider') is not None else ''

            if category not in ('llm', 'voice', 'avatar'):
                return {'success': False, 'error': 'Invalid category', 'status_code': 400}

            if php_empty(providerName):
                return {'success': False, 'error': 'Provider is required', 'status_code': 400}

            self.ensureCostsTableExists()

            allCosts = self.getDefaultCosts()
            providerData = None
            for p in allCosts[category]:
                if p['provider'] == providerName:
                    providerData = p
                    break

            if providerData is None:
                return {'success': False, 'error': 'Provider not found', 'status_code': 404}

            updatedProvider = self.fetchProviderPricing(providerData)
            if updatedProvider:
                self.saveProviderCosts(category, updatedProvider)

            row = self.db.fetch_one(
                "SELECT * FROM provider_costs WHERE category = ? AND provider = ?", [category, providerName])

            if row:
                tiers = php_json_decode(row.get('tiers'))
                provider = {
                    'provider': row['provider'],
                    'displayName': row['display_name'],
                    'category': row['category'],
                    'tiers': tiers if tiers is not None else [],
                    'pricingUrl': row['pricing_url'],
                    'lastUpdated': row['updated_at'],
                    'notes': row['notes'],
                }
            else:
                provider = dict(providerData)
                provider['lastUpdated'] = php_now()

            return {'success': True, 'provider': provider, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def fetchProviderPricing(self, provider: dict):
        """AdminController.php:3028-3049."""
        provider = dict(provider)
        provider['lastUpdated'] = php_now()
        try:
            apiKey = self.getAdminApiKey('claude')
            if apiKey:
                updatedTiers = self.fetchPricingWithClaude(provider['pricingUrl'], provider['displayName'], apiKey)
                if updatedTiers:
                    provider['tiers'] = updatedTiers
        except Exception as e:  # noqa: BLE001
            error_log(f"Failed to fetch pricing for {provider['provider']}: {e}")
        return provider

    def fetchPricingWithClaude(self, url: str, providerName: str, apiKey: str):
        """AdminController.php:3054-3139. Two sequential HTTP calls (fetch the
        pricing page, then ask Claude to extract tiers from it) — ported with
        httpx/SHARED_SSL_CONTEXT, client closed in `finally`. NEVER exercised
        by the differential (constraints.md); pinned via httpx.MockTransport
        in unit tests instead."""
        client = httpx.Client(verify=SHARED_SSL_CONTEXT)
        try:
            try:
                pageResp = client.get(
                    url, follow_redirects=True, timeout=30.0,
                    headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'})
                httpCode, html = pageResp.status_code, pageResp.text
            except Exception:  # noqa: BLE001
                httpCode, html = None, None

            if httpCode != 200 or not html:
                error_log(f'Failed to fetch pricing page for {providerName}: HTTP {httpCode}')
                return None

            text = _strip_tags(
                html.replace('<br>', '\n').replace('</div>', '\n').replace('</p>', '\n').replace('</li>', '\n'))
            text = re.sub(r'\s+', ' ', text)
            text = text[:15000]

            prompt = (
                f"Extract the current API pricing information for {providerName} from this webpage content.\n\n"
                "Return ONLY a JSON array of pricing tiers in this exact format:\n"
                "[\n"
                '  {"name": "Model or Plan Name", "price": "$X.XX", "unit": "per unit (e.g., / 1M tokens, / month)",'
                ' "details": "optional additional info"}\n'
                "]\n\n"
                "Focus on API/developer pricing, not consumer subscription plans unless that's all available.\n"
                "Include input/output token prices separately if available.\n\n"
                f"Webpage content:\n{text}\n\n"
                "Return ONLY the JSON array, no explanation or markdown."
            )

            try:
                claudeResp = client.post(
                    'https://api.anthropic.com/v1/messages',
                    headers={'Content-Type': 'application/json', 'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01'},
                    content=php_json_encode({
                        'model': 'claude-3-5-haiku-20241022',
                        'max_tokens': 2048,
                        'messages': [{'role': 'user', 'content': prompt}],
                    }),
                    timeout=60.0)
                claudeHttpCode, claudeBody = claudeResp.status_code, claudeResp.text
            except Exception:  # noqa: BLE001
                claudeHttpCode, claudeBody = None, None

            if claudeHttpCode != 200:
                error_log(f'Claude API call failed for {providerName}: HTTP {claudeHttpCode}')
                return None

            data = php_json_decode(claudeBody) if claudeBody is not None else None
            contentList = data.get('content') if isinstance(data, dict) else None
            content = ''
            if isinstance(contentList, list) and contentList and isinstance(contentList[0], dict):
                content = contentList[0]['text'] if contentList[0].get('text') is not None else ''

            content = php_trim(content)
            content = re.sub(r'^```json?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)

            tiers = php_json_decode(content)

            if not isinstance(tiers, list) or not tiers:
                error_log(f'Failed to parse Claude response for {providerName}: {content[:200]}')
                return None

            return tiers
        finally:
            client.close()

    def getAdminApiKey(self, provider: str):
        """AdminController.php:3144-3162."""
        try:
            configKey = provider.upper() + '_API_KEY'
            val = self.config.get(configKey)
            if val is not None:
                return val
            row = self.db.fetch_one(
                "SELECT api_key FROM user_api_keys WHERE provider = ? AND user_id = 1", [provider])
            return row.get('api_key') if row else None
        except Exception:  # noqa: BLE001
            return None

    def saveProviderCosts(self, category: str, provider: dict) -> None:
        """AdminController.php:3167-3188."""
        sql = ("INSERT INTO provider_costs (category, provider, display_name, tiers, pricing_url, notes, updated_at)"
              " VALUES (?, ?, ?, ?, ?, ?, NOW())"
              " ON DUPLICATE KEY UPDATE"
              " display_name = VALUES(display_name),"
              " tiers = VALUES(tiers),"
              " pricing_url = VALUES(pricing_url),"
              " notes = VALUES(notes),"
              " updated_at = NOW()")
        self.db.execute(sql, [
            category, provider['provider'], provider['displayName'],
            php_json_encode(provider['tiers']), provider['pricingUrl'], provider.get('notes'),
        ])

    def ensureCostsTableExists(self) -> None:
        self._presence.table('provider_costs')

    # ─── exchange rates (AdminController.php:3218-3371; routes.php 245-246) ──

    def getExchangeRates(self, request) -> dict:
        try:
            self.ensureExchangeRatesTableExists()
            rows = self.db.fetch_all("SELECT * FROM exchange_rates ORDER BY currency")

            rates = {'USD': 1.0, 'EUR': 0.92, 'CAD': 1.36}
            lastUpdated = None
            for row in rows:
                rates[row['currency']] = php_floatval(row['rate'])
                if not lastUpdated or (row['updated_at'] is not None and row['updated_at'] > lastUpdated):
                    lastUpdated = row['updated_at']

            return {'success': True, 'rates': rates, 'baseCurrency': 'USD', 'lastUpdated': lastUpdated,
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def refreshExchangeRates(self, request) -> dict:
        try:
            self.ensureExchangeRatesTableExists()

            rates = self.fetchExchangeRatesFromApi()
            if not rates:
                return {'success': False, 'error': 'Failed to fetch exchange rates', 'status_code': 500}

            for currency in ('EUR', 'CAD'):
                if currency in rates:
                    self.db.execute(
                        "INSERT INTO exchange_rates (currency, rate, updated_at) VALUES (?, ?, NOW())"
                        " ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()",
                        [currency, rates[currency]])

            merged = {'USD': 1.0}
            merged.update(rates)

            return {'success': True, 'rates': merged, 'baseCurrency': 'USD', 'lastUpdated': php_now(),
                   'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def fetchExchangeRatesFromApi(self):
        """AdminController.php:3306-3356. PHP's second `isset($data['rates'])`
        check (the "frankfurter.app format" branch) is unreachable dead code
        — the first branch already returns whenever 'rates' is present —
        ported behaviorally (always takes the first branch's shape) rather
        than literally duplicating unreachable code."""
        apis = (
            'https://api.exchangerate-api.com/v4/latest/USD',
            'https://api.frankfurter.app/latest?from=USD&to=EUR,CAD',
        )
        for apiUrl in apis:
            try:
                with httpx.Client(verify=SHARED_SSL_CONTEXT) as client:
                    resp = client.get(apiUrl, timeout=10.0, follow_redirects=True,
                                      headers={'User-Agent': 'GPT-Admin/1.0'})
                if resp.status_code == 200 and resp.text:
                    data = php_json_decode(resp.text)
                    if isinstance(data, dict) and data.get('rates') is not None:
                        r = data['rates']
                        return {
                            'EUR': r.get('EUR') if (isinstance(r, dict) and r.get('EUR') is not None) else 0.92,
                            'CAD': r.get('CAD') if (isinstance(r, dict) and r.get('CAD') is not None) else 1.36,
                        }
            except Exception as e:  # noqa: BLE001
                error_log(f'Failed to fetch exchange rates from {apiUrl}: {e}')
                continue

        return {'EUR': 0.92, 'CAD': 1.36}

    def ensureExchangeRatesTableExists(self) -> None:
        self._presence.table('exchange_rates')

    def getDefaultCosts(self) -> dict:
        """AdminController.php:3376-3550."""
        return {
            'llm': [
                {
                    'provider': 'claude', 'displayName': 'Claude (Anthropic)', 'category': 'llm',
                    'tiers': [
                        {'name': 'Claude 3.5 Sonnet', 'price': '$3.00', 'unit': '/ 1M input tokens',
                         'details': '$15.00 / 1M output tokens'},
                        {'name': 'Claude 3.5 Haiku', 'price': '$0.80', 'unit': '/ 1M input tokens',
                         'details': '$4.00 / 1M output tokens'},
                        {'name': 'Claude 3 Opus', 'price': '$15.00', 'unit': '/ 1M input tokens',
                         'details': '$75.00 / 1M output tokens'},
                    ],
                    'pricingUrl': 'https://www.anthropic.com/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'openai', 'displayName': 'OpenAI', 'category': 'llm',
                    'tiers': [
                        {'name': 'GPT-4o', 'price': '$2.50', 'unit': '/ 1M input tokens',
                         'details': '$10.00 / 1M output tokens'},
                        {'name': 'GPT-4o mini', 'price': '$0.15', 'unit': '/ 1M input tokens',
                         'details': '$0.60 / 1M output tokens'},
                        {'name': 'GPT-4 Turbo', 'price': '$10.00', 'unit': '/ 1M input tokens',
                         'details': '$30.00 / 1M output tokens'},
                    ],
                    'pricingUrl': 'https://openai.com/api/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'gemini', 'displayName': 'Gemini (Google)', 'category': 'llm',
                    'tiers': [
                        {'name': 'Gemini 1.5 Pro', 'price': '$1.25', 'unit': '/ 1M input tokens',
                         'details': '$5.00 / 1M output tokens'},
                        {'name': 'Gemini 1.5 Flash', 'price': '$0.075', 'unit': '/ 1M input tokens',
                         'details': '$0.30 / 1M output tokens'},
                        {'name': 'Gemini 2.0 Flash', 'price': '$0.10', 'unit': '/ 1M input tokens',
                         'details': '$0.40 / 1M output tokens'},
                    ],
                    'pricingUrl': 'https://ai.google.dev/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'grok', 'displayName': 'Grok (xAI)', 'category': 'llm',
                    'tiers': [
                        {'name': 'Grok-2', 'price': '$2.00', 'unit': '/ 1M input tokens',
                         'details': '$10.00 / 1M output tokens'},
                        {'name': 'Grok-2 mini', 'price': '$0.20', 'unit': '/ 1M input tokens',
                         'details': '$1.00 / 1M output tokens'},
                    ],
                    'pricingUrl': 'https://x.ai/api', 'lastUpdated': None,
                },
                {
                    'provider': 'deepseek', 'displayName': 'DeepSeek', 'category': 'llm',
                    'tiers': [
                        {'name': 'DeepSeek-V3', 'price': '$0.27', 'unit': '/ 1M input tokens',
                         'details': '$1.10 / 1M output tokens'},
                        {'name': 'DeepSeek-R1', 'price': '$0.55', 'unit': '/ 1M input tokens',
                         'details': '$2.19 / 1M output tokens'},
                    ],
                    'pricingUrl': 'https://platform.deepseek.com/api-docs/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'kimi', 'displayName': 'Kimi (Moonshot)', 'category': 'llm',
                    'tiers': [
                        {'name': 'Moonshot-v1-8k', 'price': '$0.012', 'unit': '/ 1K tokens'},
                        {'name': 'Moonshot-v1-32k', 'price': '$0.024', 'unit': '/ 1K tokens'},
                        {'name': 'Moonshot-v1-128k', 'price': '$0.06', 'unit': '/ 1K tokens'},
                    ],
                    'pricingUrl': 'https://platform.moonshot.cn/docs/pricing', 'lastUpdated': None,
                },
            ],
            'voice': [
                {
                    'provider': 'elevenlabs', 'displayName': 'ElevenLabs', 'category': 'voice',
                    'tiers': [
                        {'name': 'Free', 'price': '$0', 'unit': '/ month', 'details': '10,000 characters/month'},
                        {'name': 'Starter', 'price': '$5', 'unit': '/ month', 'details': '30,000 characters/month'},
                        {'name': 'Creator', 'price': '$22', 'unit': '/ month', 'details': '100,000 characters/month'},
                        {'name': 'Pro', 'price': '$99', 'unit': '/ month', 'details': '500,000 characters/month'},
                    ],
                    'pricingUrl': 'https://elevenlabs.io/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'hume', 'displayName': 'Hume AI', 'category': 'voice',
                    'tiers': [
                        {'name': 'EVI (Empathic Voice)', 'price': '$0.07', 'unit': '/ minute',
                         'details': 'Real-time voice with emotion'},
                        {'name': 'Expression Measurement', 'price': '$0.0036', 'unit': '/ API call'},
                    ],
                    'pricingUrl': 'https://www.hume.ai/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'gemini', 'displayName': 'Gemini Live (Google)', 'category': 'voice',
                    'tiers': [
                        {'name': 'Gemini 2.0 Flash Live', 'price': '$0.35', 'unit': '/ 1M audio tokens input',
                         'details': '$8.75 / 1M audio tokens output'},
                    ],
                    'pricingUrl': 'https://ai.google.dev/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'grok', 'displayName': 'Grok Voice (xAI)', 'category': 'voice',
                    'tiers': [
                        {'name': 'Grok Voice Agent API', 'price': '$0.05', 'unit': '/ minute',
                         'details': 'Real-time voice conversation'},
                        {'name': 'Tool Invocations', 'price': 'Additional', 'unit': 'per call',
                         'details': 'Web search, X search, function calls charged separately'},
                    ],
                    'pricingUrl': 'https://docs.x.ai/developers/models', 'lastUpdated': None,
                },
            ],
            'avatar': [
                {
                    'provider': 'did', 'displayName': 'D-ID', 'category': 'avatar',
                    'tiers': [
                        {'name': 'Free Trial', 'price': '$0', 'unit': '', 'details': '5 minutes of video'},
                        {'name': 'Lite', 'price': '$5.90', 'unit': '/ month', 'details': '10 minutes/month'},
                        {'name': 'Pro', 'price': '$49', 'unit': '/ month', 'details': '15 minutes/month'},
                        {'name': 'Advanced', 'price': '$299', 'unit': '/ month', 'details': '65 minutes/month'},
                    ],
                    'pricingUrl': 'https://www.d-id.com/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'heygen', 'displayName': 'HeyGen', 'category': 'avatar',
                    'tiers': [
                        {'name': 'Free', 'price': '$0', 'unit': '', 'details': '1 credit (limited features)'},
                        {'name': 'Creator', 'price': '$24', 'unit': '/ month', 'details': '15 credits/month'},
                        {'name': 'Business', 'price': '$72', 'unit': '/ month', 'details': '30 credits/month'},
                        {'name': 'Enterprise', 'price': 'Custom', 'unit': '', 'details': 'Contact sales'},
                    ],
                    'pricingUrl': 'https://www.heygen.com/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'tavus', 'displayName': 'Tavus', 'category': 'avatar',
                    'tiers': [
                        {'name': 'Starter', 'price': '$39', 'unit': '/ month', 'details': '30 minutes/month'},
                        {'name': 'Pro', 'price': '$149', 'unit': '/ month', 'details': '120 minutes/month'},
                        {'name': 'Enterprise', 'price': 'Custom', 'unit': '', 'details': 'Contact sales'},
                    ],
                    'pricingUrl': 'https://www.tavus.io/pricing', 'lastUpdated': None,
                },
                {
                    'provider': 'anam', 'displayName': 'Anam AI', 'category': 'avatar',
                    'tiers': [
                        {'name': 'API Access', 'price': 'Contact', 'unit': 'for pricing',
                         'details': 'Real-time avatar streaming'},
                    ],
                    'pricingUrl': 'https://www.anam.ai', 'lastUpdated': None,
                },
            ],
            'lastRefreshed': None,
        }
