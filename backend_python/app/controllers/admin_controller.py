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

from decimal import ROUND_HALF_UP, Decimal
from functools import cmp_to_key

from app.controllers.auth_controller import password_hash
from app.services.package_resolver import PackageResolver
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import (
    php_array,
    php_bool,
    php_empty,
    php_floatval,
    php_intval,
    php_items,
    php_strval,
    php_trim,
)
from app.support.phpjson import php_json_decode, php_json_encode

VALID_ROLES = ['guest', 'prospect', 'user', 'admin']
VALID_CATEGORIES = ('avatar', 'voice')
VALID_KEY_PROVIDERS = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']


def _php_round(value, precision: int = 0):
    """PHP round(): half away from zero, applied to the shortest decimal
    string that reproduces `value` (matching PHP's internal correction for
    binary floating-point representation error) instead of Python round()'s
    round-half-to-even on the raw double.

    Concretely: 21790 * 15 / 1_000_000 is the double
    0.32684999999999997388... — Python's round(x, 4) reads that literal
    value and rounds DOWN to 0.3268; PHP's round(x, 4)
    (AdminController.php:2981/2985, live-verified against real
    llm_usage_transactions data) rounds UP to 0.3269, the answer a human
    reading "0.32685" would expect. Used only for the cost arithmetic in
    _getUsageCostsBreakdown — every other PHP round() call ported elsewhere
    in this codebase operates on values that don't hit this floating-point
    edge case in practice (see the codebase's plain-round() precedent in
    genesis_controller.py / heal_controller.py / voice_controller.py /
    usage_logger.py).
    """
    if value is None:
        return None
    quant = Decimal('1').scaleb(-precision) if precision > 0 else Decimal('1')
    return float(Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP))


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
                'costIn': _php_round(costIn, 4) if costIn is not None else None,
                'costOut': _php_round(costOut, 4) if costOut is not None else None,
                'cost': _php_round(total, 4),
                'storedCost': _php_round(php_floatval(p['stored_cost_total']), 4),
                'lastUsed': p['last_used'],
            })

        voiceByProvider = []
        for p in voiceCosts:
            voiceByProvider.append({
                'provider': p['provider'],
                'requests': php_intval(p['total_requests']),
                'seconds': _php_round(php_floatval(p['total_seconds']), 2),
                'cost': _php_round(php_floatval(p['total_cost']), 4),
                'lastUsed': p['last_used'],
            })

        return {
            'llm': {
                'byProvider': llmByProvider,
                'totals': {
                    'today': _php_round(_t('cost_today'), 4),
                    'week': _php_round(_t('cost_week'), 4),
                    'month': _php_round(_t('cost_month'), 4),
                    'total': _php_round(_t('cost_total'), 4),
                },
            },
            'voice': {
                'byProvider': voiceByProvider,
                'totals': {
                    'today': _php_round(_t('voice_cost_today'), 4),
                    'week': _php_round(_t('voice_cost_week'), 4),
                    'month': _php_round(_t('voice_cost_month'), 4),
                    'total': _php_round(_t('voice_cost_total'), 4),
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
