"""Port of Controllers/VideoEditorController.php (652 lines).

Video Editor admin controller.

Reads the dedicated video-edit usage DB (netfo587_video_editor) for the
gpt_admin "Video Editor" pages: per-generation cost/usage and prices. User
names are resolved from the login DB since usage.user_id is the login user id
(the JWT `sub`). DB credentials come from config['video_editor_database'] /
['login_database'] (app/config.py's `_db('VE_DB')` / `_db('LOGIN_DB')` —
already present, mirroring PHP's ai_config.php `video_editor_database` /
`login_database` blocks, themselves sourced from VE_DB_* / LOGIN_DB_* in
.env). `self.db` (the constructor's primary connection) is the chatbot DB,
used only to verify the caller's admin role — same as PHP's constructor.

PDO-typing note (cite: PHP `connect()`, VideoEditorController.php:49-65 —
LoginAdminController.php's `login()` is byte-identical): this controller's
own `connect()` does NOT set `PDO::ATTR_EMULATE_PREPARES => false` like the
primary connection does (backend_python/app/db.py's docstring), which could
suggest every column comes back as a PHP string. Verified LIVE against
production (2026-09-07, both `/api/v1/admin/video-editor/*` over HTTP and a
direct PDO/PyMySQL query side-by-side) that this is NOT the case: mysqlnd
returns INT-typed columns (COUNT()/COUNT(DISTINCT)/INT primary keys — e.g.
getUsers' uncast `id`, getTransactions' uncast `id`/`user_id`) as native PHP
int regardless of the emulate-prepares setting, while DECIMAL-typed columns
and SUM()-over-numeric aggregates (cost_usd, units, prompt_tokens/
completion_tokens sums) come back as PHP strings either way — exactly what
PyMySQL + `Db.normalize_value` already produce with zero special handling
(Decimal -> str, native ints stay int). So rows fetched through `_ve()`/
`_login()` are used as-is, the same as `self.db` and every other ported
controller; only the casts the PHP source itself applies (`(int)`/`(float)`/
`(bool)`/`(string)`) are reproduced here.

Connection lifecycle: PHP's `connect()` caches the PDO per (class-static)
key for the life of the request and never closes it explicitly — the
request just ends and PHP's garbage collector closes the socket. This port
mirrors the caching (`self._cache`, instance-scoped) but closes every cached
connection once the endpoint method returns (`_cleanup` decorator + `main.py`
already does the same for the primary `db` per request) rather than leaking
a live PyMySQL socket per request — a resource-lifecycle detail, not an
output difference.
"""
from __future__ import annotations

import re

from app.db import Db
from app.support.db_cleanup import close_db, close_secondary_connections as _cleanup
from app.support.logger import error_log
from app.support.phpcompat import (
    is_numeric,
    is_php_array,
    php_bool,
    php_coalesce,
    php_date,
    php_empty,
    php_floatval,
    php_intval,
    php_items,
    php_strval,
    php_trim,
    php_values,
)
from app.support.phpjson import php_json_decode, php_json_encode

_NOTSET = object()
_MONTH_RE = re.compile(r'\d{4}-\d{2}')

# `_cleanup` (close-any-secondary-connections-on-return decorator) is the shared
# app.support.db_cleanup.close_secondary_connections — see LoginAdminController
# for the sibling usage; both close via _close_connections() below / there.


class VideoEditorController:
    # App identifier stored in login.app_user_roles.app (must match video-edit's VE_APP).
    APP = 'video-edit'
    VALID_ROLES = ('guest', 'prospect', 'user', 'admin', 'affiliate')

    def __init__(self, db, config):
        self.db = db  # chatbot DB — used only to verify the caller's admin role
        self.config = config
        self._cache: dict[str, Db | None] = {}
        self._ve_app_id_cache = _NOTSET

    # ─── admin gate (mirrors PackageController._require_admin) ─────────────

    def _require_admin(self, request) -> dict | None:
        user_id = request.get('user_id')
        if not user_id:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        user = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': user_id})
        if not user or (user.get('role') or '') != 'admin':
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}
        return None

    # ─── secondary connections ──────────────────────────────────────────────

    def _connect(self, key: str) -> Db | None:
        if key in self._cache:
            return self._cache[key]
        c = self.config.get(key)
        if not isinstance(c, dict) or php_empty(c.get('username')) or php_empty(c.get('database')):
            self._cache[key] = None
            return None
        try:
            conn = Db.connect(c, timeout=6)
        except Exception as e:  # noqa: BLE001
            error_log(f"[video-editor] DB '{key}' connect failed: {e}")
            conn = None
        self._cache[key] = conn
        return conn

    def _ve(self) -> Db | None:
        return self._connect('video_editor_database')

    def _login(self) -> Db | None:
        return self._connect('login_database')

    def _close_connections(self) -> None:
        for conn in self._cache.values():
            close_db(conn, log_prefix='video-editor')
        self._cache = {}

    def _ve_app_id(self) -> int | None:
        """registered_apps.id for the video-edit app — roles live in the CENTRALIZED
        login.app_user_roles keyed by this id. Cached; None if not registered."""
        if self._ve_app_id_cache is not _NOTSET:
            return self._ve_app_id_cache
        login = self._login()
        if not login:
            self._ve_app_id_cache = None
            return None
        try:
            rows = login.fetch_column("SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1", [self.APP])
            self._ve_app_id_cache = php_intval(rows[0]) if rows else None
        except Exception:  # noqa: BLE001
            self._ve_app_id_cache = None
        return self._ve_app_id_cache

    def _users_by_id(self, ids: list) -> dict:
        """Resolve {user_id: {'email':, 'name':}} from the login users table."""
        seen: list[int] = []
        for v in ids:
            iv = php_intval(v)
            if iv and iv not in seen:
                seen.append(iv)
        if not seen:
            return {}
        login = self._login()
        if not login:
            return {}
        placeholders = ','.join(['?'] * len(seen))
        rows = login.fetch_all(
            f"SELECT id, email, first_name, last_name FROM users WHERE id IN ({placeholders})", seen)
        out = {}
        for r in rows:
            name = php_trim((r.get('first_name') or '') + ' ' + (r.get('last_name') or ''))
            out[php_intval(r['id'])] = {
                'email': r.get('email') or '',
                'name': name if name != '' else (r.get('email') or ''),
            }
        return out

    def _range(self, request) -> int:
        q = request.get('query') or {}
        return max(1, min(365, php_intval(php_coalesce(q.get('days'), 30))))

    # ─── endpoints ───────────────────────────────────────────────────────────

    @_cleanup
    def getUsageStats(self, request) -> dict:
        """GET /api/v1/admin/video-editor/usage/stats?days=30 — totals, by model, daily trend."""
        ve = self._ve()
        if not ve:
            return {'success': False, 'available': False, 'message': 'Video-edit usage DB not reachable'}
        days = self._range(request)
        try:
            totals = ve.fetch_one(
                "SELECT COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,"
                " COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,"
                " COUNT(DISTINCT user_id) users"
                " FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)", [days])
            by_model = ve.fetch_all(
                "SELECT kind, model, COUNT(*) generations, COALESCE(SUM(units),0) units,"
                " COALESCE(SUM(cost_usd),0) cost FROM video_edit_usage"
                " WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY kind, model ORDER BY cost DESC",
                [days])
            daily = ve.fetch_all(
                "SELECT DATE(created_at) day, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost"
                " FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)"
                " GROUP BY DATE(created_at) ORDER BY day ASC", [days])
            return {'success': True, 'available': True, 'days': days,
                    'totals': totals, 'byModel': by_model, 'daily': daily}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'message': 'Usage query failed'}

    @_cleanup
    def getUsageByUser(self, request) -> dict:
        """GET /api/v1/admin/video-editor/usage/by-user?days=30 — per-user consumption + names."""
        ve = self._ve()
        if not ve:
            return {'success': False, 'available': False, 'users': []}
        days = self._range(request)
        try:
            rows = ve.fetch_all(
                "SELECT user_id, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,"
                " COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,"
                " MAX(created_at) last_used"
                " FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)"
                " GROUP BY user_id ORDER BY cost DESC", [days])
            names = self._users_by_id([r.get('user_id') for r in rows])
            for r in rows:
                u = names.get(php_intval(r.get('user_id')))
                r['email'] = (u or {}).get('email')
                r['name'] = (u or {}).get('name')
            return {'success': True, 'available': True, 'days': days, 'users': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'users': []}

    @_cleanup
    def getTransactions(self, request) -> dict:
        """GET /api/v1/admin/video-editor/transactions?user_id=&month=YYYY-MM&days=&all=1&page=&per_page=
        Row-level generation transactions, newest first, paged."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'available': False, 'rows': [], 'total': 0}
        q = request.get('query') or {}
        page = max(1, php_intval(php_coalesce(q.get('page'), 1)))
        per_page = max(1, min(100, php_intval(php_coalesce(q.get('per_page'), 20))))
        where: list[str] = []
        params: dict = {}
        if not php_empty(q.get('user_id')):
            where.append('user_id = :uid')
            params[':uid'] = php_intval(q.get('user_id'))
        if not php_empty(q.get('all')):
            pass  # no period filter
        elif not php_empty(q.get('days')):
            where.append('created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)')
            params[':days'] = max(1, min(365, php_intval(q.get('days'))))
        else:
            month = php_strval(php_coalesce(q.get('month'), ''))
            if not _MONTH_RE.fullmatch(month):
                month = php_date('Y-m')
            where.append("DATE_FORMAT(created_at, '%Y-%m') = :month")
            params[':month'] = month
        w = ('WHERE ' + ' AND '.join(where)) if where else ''
        try:
            count_rows = ve.fetch_column(f"SELECT COUNT(*) FROM video_edit_usage {w}", params)
            total = php_intval(count_rows[0]) if count_rows else 0
            bind = dict(params)
            bind[':lim'] = per_page
            bind[':off'] = (page - 1) * per_page
            rows = ve.fetch_all(
                f"SELECT id, user_id, kind, provider, model, units, cost_usd, status, created_at"
                f" FROM video_edit_usage {w} ORDER BY id DESC LIMIT :lim OFFSET :off", bind)
            names = self._users_by_id([r.get('user_id') for r in rows])
            for r in rows:
                u = names.get(php_intval(r.get('user_id')))
                r['email'] = (u or {}).get('email')
                r['name'] = (u or {}).get('name')
            return {'success': True, 'available': True, 'rows': rows,
                    'total': total, 'page': page, 'per_page': per_page}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'rows': [], 'total': 0}

    @_cleanup
    def getUsageSummary(self, request) -> dict:
        """GET /api/v1/admin/video-editor/usage/summary — per-kind cost/generation totals
        bucketed today / this week (ISO, since Monday) / this month (calendar) / all time,
        plus a last-30-day by-model breakdown."""
        ve = self._ve()
        if not ve:
            return {'success': False, 'available': False, 'message': 'Video-edit usage DB not reachable'}

        def blank():
            return {
                'totals': {'today': 0.0, 'week': 0.0, 'month': 0.0, 'total': 0.0},
                'counts': {'today': 0, 'week': 0, 'month': 0, 'total': 0},
                'byModel': [],
            }

        kinds = {k: blank() for k in ('video', 'image', 'music')}
        try:
            week_start = "DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)"
            month_start = "DATE_FORMAT(CURDATE(), '%Y-%m-01')"
            buckets = ve.fetch_all(
                "SELECT kind,"
                f" COALESCE(SUM(CASE WHEN DATE(created_at)=CURDATE() THEN cost_usd END),0) cost_today,"
                f" COALESCE(SUM(CASE WHEN created_at >= {week_start} THEN cost_usd END),0) cost_week,"
                f" COALESCE(SUM(CASE WHEN created_at >= {month_start} THEN cost_usd END),0) cost_month,"
                " COALESCE(SUM(cost_usd),0) cost_total,"
                " COALESCE(SUM(DATE(created_at)=CURDATE()),0) gen_today,"
                f" COALESCE(SUM(created_at >= {week_start}),0) gen_week,"
                f" COALESCE(SUM(created_at >= {month_start}),0) gen_month,"
                " COUNT(*) gen_total"
                " FROM video_edit_usage GROUP BY kind")
            for r in buckets:
                k = php_strval(r.get('kind'))
                if k not in kinds:
                    kinds[k] = blank()
                kinds[k]['totals'] = {
                    'today': php_floatval(r.get('cost_today')), 'week': php_floatval(r.get('cost_week')),
                    'month': php_floatval(r.get('cost_month')), 'total': php_floatval(r.get('cost_total')),
                }
                kinds[k]['counts'] = {
                    'today': php_intval(r.get('gen_today')), 'week': php_intval(r.get('gen_week')),
                    'month': php_intval(r.get('gen_month')), 'total': php_intval(r.get('gen_total')),
                }
            by_model = ve.fetch_all(
                "SELECT kind, model, COUNT(*) generations,"
                " COALESCE(SUM(units),0) units, COALESCE(SUM(cost_usd),0) cost, MAX(created_at) last_used"
                " FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
                " GROUP BY kind, model ORDER BY cost DESC")
            for r in by_model:
                k = php_strval(r.get('kind'))
                if k not in kinds:
                    kinds[k] = blank()
                kinds[k]['byModel'].append({
                    'model': r.get('model'),
                    'generations': php_intval(r.get('generations')),
                    'units': php_floatval(r.get('units')),
                    'cost': php_floatval(r.get('cost')),
                    'last_used': r.get('last_used'),
                })
            return {'success': True, 'available': True, 'kinds': kinds}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'message': 'Usage summary query failed'}

    @_cleanup
    def getPrices(self, request) -> dict:
        """GET /api/v1/admin/video-editor/prices — the editable price table."""
        ve = self._ve()
        if not ve:
            return {'success': False, 'prices': []}
        try:
            prices = ve.fetch_all(
                "SELECT model, unit, rate, label, updated_at FROM video_edit_prices ORDER BY model")
            return {'success': True, 'prices': prices}
        except Exception:  # noqa: BLE001
            return {'success': False, 'prices': []}

    @_cleanup
    def savePrice(self, request) -> dict:
        """POST /api/v1/admin/video-editor/prices — upsert one model's rate."""
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        b = request.get('body') or {}
        model = php_trim(php_coalesce(b.get('model'), ''))
        unit = b.get('unit') if b.get('unit') in ('sec', 'image', 'clip') else None
        if model == '' or unit is None or b.get('rate') is None:
            return {'success': False, 'message': 'model, unit (sec|image|clip) and rate are required'}
        try:
            ve.execute(
                "INSERT INTO video_edit_prices (model, unit, rate, label)"
                " VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE unit=VALUES(unit), rate=VALUES(rate), label=VALUES(label)",
                [model, unit, php_floatval(b.get('rate')), php_strval(php_coalesce(b.get('label'), ''))])
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    @_cleanup
    def getProviders(self, request) -> dict:
        """GET /api/v1/admin/video-editor/providers — provider credentials (key MASKED:
        only has_key is returned, never the secret)."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'providers': []}
        try:
            rows = ve.fetch_all(
                "SELECT provider, label, api_base, enabled, api_key,"
                " (api_key IS NOT NULL AND api_key <> '') AS has_key, updated_at"
                " FROM video_edit_providers ORDER BY provider")

            # Preferred source: the new per-provider models_json catalog (empty if the column
            # hasn't been added yet).
            mjson: dict = {}
            try:
                for r in ve.fetch_all("SELECT provider, models_json FROM video_edit_providers"):
                    d = php_json_decode(php_strval(php_coalesce(r.get('models_json'), '')))
                    if is_php_array(d) and d:
                        mjson[r.get('provider')] = list(php_values(d))
            except Exception:  # noqa: BLE001 — models_json column not added yet
                pass

            # Legacy fallback: the old video_edit_models + video_edit_prices tables, so the
            # catalog keeps showing before the migration SQL is run.
            legacy: dict = {}
            try:
                for r in ve.fetch_all(
                        "SELECT m.provider, m.model, m.label, m.kind, pr.unit, pr.rate"
                        " FROM video_edit_models m LEFT JOIN video_edit_prices pr ON pr.model = m.model"
                        " ORDER BY m.model"):
                    kind = php_strval(php_coalesce(r.get('kind'), 'video'))
                    default_unit = 'image' if kind == 'image' else ('clip' if kind == 'music' else 'sec')
                    legacy.setdefault(r.get('provider'), []).append({
                        'model': r.get('model'),
                        'label': php_strval(php_coalesce(r.get('label'), '')),
                        'kind': kind,
                        'cost': php_floatval(php_coalesce(r.get('rate'), 0)),
                        'unit': php_strval(php_coalesce(r.get('unit'), default_unit)),
                    })
            except Exception:  # noqa: BLE001 — old tables already dropped
                pass

            for r in rows:
                r['enabled'] = php_intval(r.get('enabled'))
                r['has_key'] = php_bool(r.get('has_key'))
                prov = r.get('provider')
                r['models'] = mjson.get(prov) if not php_empty(mjson.get(prov)) else legacy.get(prov, [])
            return {'success': True, 'providers': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'providers': []}

    @_cleanup
    def saveProvider(self, request) -> dict:
        """POST /api/v1/admin/video-editor/providers — upsert a provider. A blank/omitted
        api_key leaves the stored key untouched (so editing never wipes the secret)."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        b = request.get('body') or {}
        provider = php_trim(php_coalesce(b.get('provider'), ''))
        if provider == '':
            return {'success': False, 'message': 'provider is required'}
        label = php_strval(php_coalesce(b.get('label'), provider))
        api_base = php_strval(php_coalesce(b.get('api_base'), ''))
        enabled = 1 if not php_empty(b.get('enabled')) else 0
        api_key = php_trim(php_coalesce(b.get('api_key'), ''))
        # The provider's model catalog (+ cost) lives here now, as a JSON string.
        models_json = None
        if 'models' in b and is_php_array(b.get('models')):
            clean = []
            for m in php_values(b['models']):
                if not isinstance(m, dict):
                    m = {}
                mid = php_trim(php_coalesce(m.get('model'), ''))
                if mid == '':
                    continue
                row = {
                    'model': mid,
                    'label': php_strval(php_coalesce(m.get('label'), '')),
                    'kind': m.get('kind') if m.get('kind') in ('video', 'image', 'music') else 'video',
                    'cost': php_floatval(php_coalesce(m.get('cost'), 0)),
                    'unit': php_strval(php_coalesce(m.get('unit'), '')),
                }
                # Optional metadata consumed by video-edit's api/models.php.
                cid = php_trim(php_coalesce(m.get('client_id'), ''))
                if cid != '':
                    row['client_id'] = cid
                if 'start_frame' in m:
                    row['start_frame'] = php_bool(m.get('start_frame'))
                if 'end_frame' in m:
                    row['end_frame'] = php_bool(m.get('end_frame'))
                clean.append(row)
            models_json = php_json_encode(clean)
        try:
            # Build the column set conditionally: a blank api_key keeps the stored key,
            # and omitting "models" keeps the existing catalog.
            cols = {'provider': provider, 'label': label, 'api_base': api_base, 'enabled': enabled}
            if api_key != '':
                cols['api_key'] = api_key
            elif not php_empty(b.get('clear_key')):
                cols['api_key'] = None  # explicit removal only
            if models_json is not None:
                cols['models_json'] = models_json
            fields = ', '.join(cols.keys())
            holders = ', '.join(f':{k}' for k in cols.keys())
            updates = ', '.join(f'{k}=VALUES({k})' for k in cols.keys() if k != 'provider')
            sql = (f"INSERT INTO video_edit_providers ({fields}) VALUES ({holders})"
                   f" ON DUPLICATE KEY UPDATE {updates}")
            params = {f':{k}': v for k, v in cols.items()}
            ve.execute(sql, params)
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    @_cleanup
    def getModels(self, request) -> dict:
        """GET /api/v1/admin/video-editor/models — the model catalog (per provider)."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'models': []}
        try:
            rows = ve.fetch_all(
                "SELECT model, provider, kind, label, enabled, updated_at"
                " FROM video_edit_models ORDER BY provider, model")
            for r in rows:
                r['enabled'] = php_intval(r.get('enabled'))
            return {'success': True, 'models': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'models': []}

    @_cleanup
    def saveModel(self, request) -> dict:
        """POST /api/v1/admin/video-editor/models — upsert one model."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        b = request.get('body') or {}
        model = php_trim(php_coalesce(b.get('model'), ''))
        provider = php_trim(php_coalesce(b.get('provider'), ''))
        kind = b.get('kind') if b.get('kind') in ('video', 'image', 'music') else None
        if model == '' or provider == '' or kind is None:
            return {'success': False, 'message': 'model, provider and kind (video|image|music) are required'}
        enabled = 1 if not php_empty(b.get('enabled')) else 0
        try:
            ve.execute(
                "INSERT INTO video_edit_models (model, provider, kind, label, enabled)"
                " VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE"
                " provider=VALUES(provider), kind=VALUES(kind), label=VALUES(label), enabled=VALUES(enabled)",
                [model, provider, kind, php_strval(php_coalesce(b.get('label'), model)), enabled])
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    @_cleanup
    def getUserOverride(self, request) -> dict:
        """GET /api/v1/admin/video-editor/user-override?user_id= — a user's capability
        override + which providers have a BYO key (keys are masked)."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        uid = php_intval(php_coalesce((request.get('query') or {}).get('user_id'), 0))
        if uid <= 0:
            return {'success': False, 'message': 'user_id is required'}
        try:
            r = ve.fetch_one(
                "SELECT capabilities, byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1", [uid])
            caps = php_json_decode(php_strval(r.get('capabilities'))) if r else None
            byo = php_json_decode(php_strval(r.get('byo_keys'))) if r else None
            byo_providers = []
            if is_php_array(byo):
                for prov, val in php_items(byo):
                    if php_strval(val) != '':
                        byo_providers.append(prov)
            return {'success': True, 'user_id': uid,
                    'capabilities': caps if is_php_array(caps) else None,
                    'byo_providers': byo_providers}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Load failed'}

    @_cleanup
    def saveUserOverride(self, request) -> dict:
        """POST /api/v1/admin/video-editor/user-override — upsert a user's override.
        Body: { user_id, capabilities: {...}|null, byo_keys: {provider: key} }.
        A blank BYO value keeps the existing key; "__clear__" removes it."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        b = request.get('body') or {}
        uid = php_intval(php_coalesce(b.get('user_id'), 0))
        if uid <= 0:
            return {'success': False, 'message': 'user_id is required'}
        caps = b.get('capabilities') if 'capabilities' in b else None
        caps_json = php_json_encode(caps) if is_php_array(caps) else None
        incoming = b.get('byo_keys') if is_php_array(b.get('byo_keys')) else {}
        admin_uid = request.get('user_id')
        admin_id = php_intval(admin_uid) if is_numeric(admin_uid) else None
        try:
            row = ve.fetch_one(
                "SELECT byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1", [uid])
            existing = row.get('byo_keys') if row else None
            decoded = php_json_decode(php_strval(existing)) if existing else None
            byo = decoded if is_php_array(decoded) else {}
            for prov, val in php_items(incoming):
                sval = php_strval(val)
                if sval == '':
                    continue
                if sval == '__clear__':
                    if isinstance(byo, dict):
                        byo.pop(prov, None)
                    continue
                if isinstance(byo, dict):
                    byo[prov] = sval
            byo_json = php_json_encode(byo) if byo else None
            ve.execute(
                "INSERT INTO video_edit_user_overrides (user_id, capabilities, byo_keys, updated_by)"
                " VALUES (:u, :c, :b, :by)"
                " ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), byo_keys = VALUES(byo_keys),"
                " updated_by = VALUES(updated_by)",
                {':u': uid, ':c': caps_json, ':b': byo_json, ':by': admin_id})
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    @_cleanup
    def getPackages(self, request) -> dict:
        """GET /api/v1/admin/video-editor/packages — role → capabilities (video-edit DB)."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'packages': []}
        try:
            rows = ve.fetch_all(
                "SELECT role, capabilities, updated_at FROM video_edit_packages ORDER BY role")
            for r in rows:
                d = php_json_decode(php_strval(r.get('capabilities')))
                r['capabilities'] = d if is_php_array(d) else {}
            return {'success': True, 'packages': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'packages': []}

    @_cleanup
    def savePackage(self, request) -> dict:
        """POST /api/v1/admin/video-editor/packages — upsert one role's capabilities.
        Body: { role, capabilities: {...} }."""
        err = self._require_admin(request)
        if err:
            return err
        ve = self._ve()
        if not ve:
            return {'success': False, 'message': 'DB not reachable'}
        b = request.get('body') or {}
        role = php_strval(php_coalesce(b.get('role'), ''))
        if role not in self.VALID_ROLES:
            return {'success': False, 'message': 'invalid role'}
        caps = b.get('capabilities')
        if not is_php_array(caps):
            return {'success': False, 'message': 'capabilities object is required'}
        admin_uid = request.get('user_id')
        admin_id = php_intval(admin_uid) if is_numeric(admin_uid) else None
        try:
            ve.execute(
                "INSERT INTO video_edit_packages (role, capabilities, updated_by)"
                " VALUES (:r, :c, :by) ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities),"
                " updated_by = VALUES(updated_by)",
                {':r': role, ':c': php_json_encode(caps), ':by': admin_id})
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}

    @_cleanup
    def getUsers(self, request) -> dict:
        """GET /api/v1/admin/video-editor/users?q= — login users + their video-edit role.
        User names come from the login DB; roles live in the video-edit DB (app_user_roles),
        so no cross-DB grant is needed."""
        err = self._require_admin(request)
        if err:
            return err
        login = self._login()
        if not login:
            return {'success': False, 'available': False, 'users': [],
                    'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}
        q = php_trim(php_coalesce((request.get('query') or {}).get('q'), ''))
        try:
            params: dict = {}
            where = ''
            if q != '':
                where = 'WHERE (email LIKE :q OR first_name LIKE :q OR last_name LIKE :q)'
                params[':q'] = f'%{q}%'
            rows = login.fetch_all(
                "SELECT id, email, first_name, last_name, provider, email_verified, last_login"
                f" FROM users {where} ORDER BY id DESC LIMIT 100", params)

            # Roles from the CENTRALIZED login DB, keyed by user id.
            roles: dict = {}
            app_id = self._ve_app_id()
            if app_id is not None:
                for rr in login.fetch_all("SELECT user_id, role FROM app_user_roles WHERE app_id = ?", [app_id]):
                    roles[php_intval(rr.get('user_id'))] = rr.get('role')
            for r in rows:
                name = php_trim((r.get('first_name') or '') + ' ' + (r.get('last_name') or ''))
                r['name'] = name if name != '' else (r.get('email') or '')
                r['email_verified'] = php_intval(php_coalesce(r.get('email_verified'), 0))
                r['ve_role'] = roles.get(php_intval(r.get('id')))
                r.pop('first_name', None)
                r.pop('last_name', None)
            return {'success': True, 'available': True, 'app': self.APP, 'users': rows}
        except Exception:  # noqa: BLE001
            return {'success': False, 'available': False, 'users': [],
                    'message': 'User query failed — check the login DB connection'}

    @_cleanup
    def setUserRole(self, request) -> dict:
        """POST /api/v1/admin/video-editor/users/role — set (or clear) a user's video-edit role.
        Body: { user_id, role }. An empty/"none" role revokes. Stored in the CENTRALIZED
        login DB (login.app_user_roles keyed by registered_apps.id)."""
        err = self._require_admin(request)
        if err:
            return err
        login = self._login()
        if not login:
            return {'success': False, 'message': 'Login DB not reachable'}
        app_id = self._ve_app_id()
        if app_id is None:
            return {'success': False, 'message': 'video-edit app not registered in login'}
        b = request.get('body') or {}
        uid = php_intval(php_coalesce(b.get('user_id'), 0))
        role = php_strval(php_coalesce(b.get('role'), ''))
        if uid <= 0:
            return {'success': False, 'message': 'user_id is required'}
        admin_uid = request.get('user_id')
        admin_id = php_intval(admin_uid) if is_numeric(admin_uid) else None
        try:
            if role == '' or role == 'none':
                login.execute("DELETE FROM app_user_roles WHERE user_id = :u AND app_id = :a",
                              {':u': uid, ':a': app_id})
            else:
                if role not in self.VALID_ROLES:
                    return {'success': False, 'message': 'invalid role'}
                login.execute(
                    "INSERT INTO app_user_roles (user_id, app_id, role, updated_by)"
                    " VALUES (:u, :a, :r, :by)"
                    " ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)",
                    {':u': uid, ':a': app_id, ':r': role, ':by': admin_id})
            return {'success': True}
        except Exception:  # noqa: BLE001
            return {'success': False, 'message': 'Save failed'}
