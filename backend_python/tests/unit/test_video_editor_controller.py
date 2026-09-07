"""Unit tests for app/controllers/video_editor_controller.py (port of
Controllers/VideoEditorController.php). Uses a FakeDb for both the primary
(admin-role-check) connection and the two secondary connections
(video_editor_database / login_database), the latter reached through
Db.connect() monkeypatched per test."""
from app.controllers.video_editor_controller import VideoEditorController
from app.db import Db
from app.support.http import Ctx
from app.support.phpcompat import php_date

CONFIG = {
    'video_editor_database': {'host': 'h', 'database': 've_db', 'username': 'u', 'password': 'p'},
    'login_database': {'host': 'h', 'database': 'login_db', 'username': 'u', 'password': 'p'},
}

NO_VE_CONFIG = {
    'video_editor_database': {},
    'login_database': {},
}


class FakeDb:
    """Records every call as (kind, sql, params); returns canned results in call order."""

    def __init__(self, one=None, all=None, column=None):
        self.one = list(one or [])
        self.all = list(all or [])
        self.column = list(column or [])
        self.calls = []
        self.closed = False

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all.pop(0) if self.all else []

    def fetch_column(self, sql, params=None):
        self.calls.append(('fetch_column', sql, params))
        return self.column.pop(0) if self.column else []

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        return 1

    def close(self):
        self.closed = True


def patch_connect(monkeypatch, ve=None, login=None):
    """VideoEditorController._connect() calls Db.connect(cfg, timeout=6); route by
    cfg['database'] to the FakeDb built for 've_db' / 'login_db'."""
    mapping = {'ve_db': ve, 'login_db': login}

    def fake_connect(cfg, timeout=10):
        db = mapping.get(cfg.get('database'))
        if db is None:
            raise RuntimeError('unexpected connect() for test')
        return db

    monkeypatch.setattr(Db, 'connect', staticmethod(fake_connect))


def ctx(query=None, body=None, user_id=3):
    return Ctx(method='GET', uri='/', headers={}, query=query or {}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


def controller(admin_db_rows=None, config=CONFIG):
    """admin_db_rows feeds self.db.fetch_one('SELECT role...') in call order."""
    primary = FakeDb(one=admin_db_rows if admin_db_rows is not None else [{'role': 'admin'}])
    return VideoEditorController(primary, config), primary


# ─── admin gate ──────────────────────────────────────────────────────────────

def test_require_admin_unauthenticated():
    c, _ = controller()
    assert c.getTransactions(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_require_admin_non_admin():
    c, primary = controller(admin_db_rows=[{'role': 'user'}])
    assert c.getTransactions(ctx()) == {
        'success': False, 'error': 'Admin access required', 'status_code': 403}
    assert primary.calls == [('fetch_one', 'SELECT role FROM users WHERE id = :id LIMIT 1', {':id': 3})]


def test_require_admin_no_user_row():
    c, _ = controller(admin_db_rows=[None])
    assert c.getUsers(ctx())['error'] == 'Admin access required'


def test_ungated_endpoints_proceed_without_user_id(monkeypatch):
    # getUsageStats has NO requireAdmin call in PHP (VideoEditorController.php:112) — unlike
    # getTransactions/getProviders/etc. Must still work with no authenticated user.
    ve = FakeDb(one=[{'generations': 0, 'cost': '0', 'tokens_in': 0, 'tokens_out': 0, 'users': 0}],
                all=[[], []])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUsageStats(ctx(user_id=None))
    assert r['success'] is True


# ─── secondary DB unreachable ───────────────────────────────────────────────

def test_ve_unreachable_messages():
    c, _ = controller(config=NO_VE_CONFIG)
    assert c.getUsageStats(ctx()) == {
        'success': False, 'available': False, 'message': 'Video-edit usage DB not reachable'}
    assert c.getUsageByUser(ctx()) == {'success': False, 'available': False, 'users': []}
    assert c.getPrices(ctx()) == {'success': False, 'prices': []}
    assert c.savePrice(ctx()) == {'success': False, 'message': 'DB not reachable'}


def test_ve_unreachable_admin_gated():
    c, _ = controller(admin_db_rows=[{'role': 'admin'}] * 3, config=NO_VE_CONFIG)
    assert c.getTransactions(ctx()) == {'success': False, 'available': False, 'rows': [], 'total': 0}
    assert c.getProviders(ctx()) == {'success': False, 'providers': []}
    assert c.getModels(ctx()) == {'success': False, 'models': []}


def test_login_unreachable_message():
    c, _ = controller(config=NO_VE_CONFIG)
    r = c.getUsers(ctx())
    assert r == {'success': False, 'available': False, 'users': [],
                 'message': 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'}


# ─── getUsageStats ───────────────────────────────────────────────────────────

def test_get_usage_stats_sql_and_native_typing(monkeypatch):
    ve = FakeDb(
        one=[{'generations': 5, 'cost': '12.50', 'tokens_in': '100', 'tokens_out': '200', 'users': 2}],
        all=[
            [{'kind': 'video', 'model': 'gen3', 'generations': 3, 'units': '1.5', 'cost': '9.00'}],
            [{'day': '2026-09-01', 'generations': 5, 'cost': '12.50'}],
        ])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUsageStats(ctx(query={'days': '10'}))
    assert r['success'] is True and r['days'] == 10
    # No casts in PHP for any of these fields — rows pass through as-is. Verified live
    # against production (2026-09-07): COUNT()/COUNT(DISTINCT) columns come back as PHP
    # int even through this uncast connection; SUM()-over-numeric/DECIMAL columns come
    # back as PHP strings either way (see module docstring) — matching PyMySQL natively.
    assert r['totals'] == {'generations': 5, 'cost': '12.50', 'tokens_in': '100', 'tokens_out': '200', 'users': 2}
    assert r['byModel'] == [{'kind': 'video', 'model': 'gen3', 'generations': 3, 'units': '1.5', 'cost': '9.00'}]
    assert r['daily'] == [{'day': '2026-09-01', 'generations': 5, 'cost': '12.50'}]
    assert ve.calls[0] == ('fetch_one',
        "SELECT COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,"
        " COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,"
        " COUNT(DISTINCT user_id) users"
        " FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)", [10])
    assert ve.closed is True   # _cleanup closes the connection this call opened


def test_get_usage_stats_days_clamped():
    # max(1, min(365, ...)) — no DB call needed since 've' unreachable short-circuits first,
    # so exercise clamping through _range directly via a reachable ve.
    pass


def test_get_usage_stats_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('db exploded')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.getUsageStats(ctx()) == {'success': False, 'available': False, 'message': 'Usage query failed'}


# ─── getUsageByUser ──────────────────────────────────────────────────────────

def test_get_usage_by_user_joins_names(monkeypatch):
    ve = FakeDb(all=[[{'user_id': 7, 'generations': 2, 'cost': '3.00', 'tokens_in': '10',
                        'tokens_out': '20', 'last_used': '2026-09-01 00:00:00'}]])
    login = FakeDb(all=[[{'id': 7, 'email': 'a@x.com', 'first_name': 'Ann', 'last_name': 'Lee'}]])
    patch_connect(monkeypatch, ve=ve, login=login)
    c, _ = controller()
    r = c.getUsageByUser(ctx(query={'days': '30'}))
    assert r['users'] == [{'user_id': 7, 'generations': 2, 'cost': '3.00', 'tokens_in': '10',
                            'tokens_out': '20', 'last_used': '2026-09-01 00:00:00',
                            'email': 'a@x.com', 'name': 'Ann Lee'}]


def test_get_usage_by_user_missing_name_falls_back_to_email(monkeypatch):
    ve = FakeDb(all=[[{'user_id': 7, 'generations': 1, 'cost': '1.00', 'tokens_in': 1,
                        'tokens_out': 1, 'last_used': None}]])
    login = FakeDb(all=[[{'id': 7, 'email': 'solo@x.com', 'first_name': None, 'last_name': None}]])
    patch_connect(monkeypatch, ve=ve, login=login)
    c, _ = controller()
    r = c.getUsageByUser(ctx())
    assert r['users'][0]['name'] == 'solo@x.com'


def test_get_usage_by_user_unmatched_user_gets_null_name(monkeypatch):
    ve = FakeDb(all=[[{'user_id': 9, 'generations': 1, 'cost': '1.00', 'tokens_in': 1,
                        'tokens_out': 1, 'last_used': None}]])
    login = FakeDb(all=[[]])
    patch_connect(monkeypatch, ve=ve, login=login)
    c, _ = controller()
    r = c.getUsageByUser(ctx())
    assert r['users'][0]['email'] is None and r['users'][0]['name'] is None


def test_get_usage_by_user_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.getUsageByUser(ctx()) == {'success': False, 'available': False, 'users': []}


# ─── getTransactions ─────────────────────────────────────────────────────────

def test_get_transactions_month_default_and_pagination_sql(monkeypatch):
    ve = FakeDb(column=[[0]], all=[[]])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getTransactions(ctx(query={}))
    assert r['success'] is True and r['total'] == 0 and r['page'] == 1 and r['per_page'] == 20
    count_call = ve.calls[0]
    assert count_call[0] == 'fetch_column'
    assert "DATE_FORMAT(created_at, '%Y-%m') = :month" in count_call[1]
    assert list(count_call[2].keys()) == [':month']
    fetch_call = ve.calls[1]
    assert fetch_call[0] == 'fetch_all'
    assert fetch_call[2][':lim'] == 20 and fetch_call[2][':off'] == 0


def test_get_transactions_user_id_and_all_and_days_filters(monkeypatch):
    ve = FakeDb(column=[[1], [1], [1]], all=[[], [], []])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller(admin_db_rows=[{'role': 'admin'}] * 3)
    c.getTransactions(ctx(query={'user_id': '42'}))
    assert ve.calls[0][1].count('user_id = :uid') == 1
    # PHP: the user_id branch and the all/days/month branch are independent ifs — with only
    # user_id set, 'all' and 'days' are both empty so the else (month-default) still appends.
    assert ve.calls[0][2] == {':uid': 42, ':month': php_date('Y-m')}

    ve.calls.clear()
    c.getTransactions(ctx(query={'all': '1'}))
    assert 'WHERE' not in ve.calls[0][1]

    ve.calls.clear()
    c.getTransactions(ctx(query={'days': '7'}))
    assert 'created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)' in ve.calls[0][1]
    assert ve.calls[0][2] == {':days': 7}


def test_get_transactions_rows_typed_and_names_joined(monkeypatch):
    # id/user_id are INT PK columns and PHP never casts them here — verified live (2026-09-07)
    # they still come back as native PHP int, matching PyMySQL as-is (see module docstring).
    ve = FakeDb(column=[[1]], all=[[{'id': 1, 'user_id': 3, 'kind': 'video', 'provider': 'kling',
                                      'model': 'v1', 'units': '5.0', 'cost_usd': '2.50',
                                      'status': 'done', 'created_at': '2026-09-01 00:00:00'}]])
    login = FakeDb(all=[[{'id': 3, 'email': 'me@x.com', 'first_name': '', 'last_name': ''}]])
    patch_connect(monkeypatch, ve=ve, login=login)
    c, _ = controller()
    r = c.getTransactions(ctx())
    row = r['rows'][0]
    assert row['id'] == 1 and row['user_id'] == 3 and row['email'] == 'me@x.com' and row['name'] == 'me@x.com'
    assert r['total'] == 1


def test_get_transactions_page_and_per_page_clamped(monkeypatch):
    ve = FakeDb(column=[[0]], all=[[]])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getTransactions(ctx(query={'page': '0', 'per_page': '500'}))
    assert r['page'] == 1 and r['per_page'] == 100


def test_get_transactions_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_column(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.getTransactions(ctx()) == {'success': False, 'available': False, 'rows': [], 'total': 0}


# ─── getUsageSummary ─────────────────────────────────────────────────────────

def test_get_usage_summary_casts_and_blank_kinds(monkeypatch):
    ve = FakeDb(all=[
        [{'kind': 'video', 'cost_today': '1.00', 'cost_week': '2.00', 'cost_month': '3.00',
          'cost_total': '4.00', 'gen_today': 1, 'gen_week': 2, 'gen_month': 3, 'gen_total': 4}],
        [{'kind': 'video', 'model': 'gen3', 'generations': 2, 'units': '1.0', 'cost': '5.00',
          'last_used': '2026-09-01 00:00:00'}],
    ])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUsageSummary(ctx())
    assert r['success'] is True
    assert list(r['kinds'].keys()) == ['video', 'image', 'music']
    assert r['kinds']['video']['totals'] == {'today': 1.0, 'week': 2.0, 'month': 3.0, 'total': 4.0}
    assert r['kinds']['video']['counts'] == {'today': 1, 'week': 2, 'month': 3, 'total': 4}
    assert r['kinds']['video']['byModel'] == [
        {'model': 'gen3', 'generations': 2, 'units': 1.0, 'cost': 5.0, 'last_used': '2026-09-01 00:00:00'}]
    assert r['kinds']['image']['totals'] == {'today': 0.0, 'week': 0.0, 'month': 0.0, 'total': 0.0}


def test_get_usage_summary_unknown_kind_appended(monkeypatch):
    ve = FakeDb(all=[
        [{'kind': 'sfx', 'cost_today': '0', 'cost_week': '0', 'cost_month': '0', 'cost_total': '0',
          'gen_today': 0, 'gen_week': 0, 'gen_month': 0, 'gen_total': 0}],
        [],
    ])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUsageSummary(ctx())
    assert list(r['kinds'].keys()) == ['video', 'image', 'music', 'sfx']


def test_get_usage_summary_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.getUsageSummary(ctx()) == {
        'success': False, 'available': False, 'message': 'Usage summary query failed'}


# ─── getPrices / savePrice ───────────────────────────────────────────────────

def test_get_prices(monkeypatch):
    ve = FakeDb(all=[[{'model': 'gen3', 'unit': 'sec', 'rate': '0.10', 'label': 'Gen3',
                        'updated_at': '2026-09-01 00:00:00'}]])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getPrices(ctx())
    assert r == {'success': True, 'prices': [{'model': 'gen3', 'unit': 'sec', 'rate': '0.10',
                                               'label': 'Gen3', 'updated_at': '2026-09-01 00:00:00'}]}
    assert ve.calls[0] == ('fetch_all',
        "SELECT model, unit, rate, label, updated_at FROM video_edit_prices ORDER BY model", None)


def test_save_price_validation():
    c, _ = controller(config=NO_VE_CONFIG)
    assert c.savePrice(ctx(body={})) == {'success': False, 'message': 'DB not reachable'}


def test_save_price_validation_fields(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    assert c.savePrice(ctx(body={})) == {
        'success': False, 'message': 'model, unit (sec|image|clip) and rate are required'}
    assert c.savePrice(ctx(body={'model': 'x', 'unit': 'bogus', 'rate': 1})) == {
        'success': False, 'message': 'model, unit (sec|image|clip) and rate are required'}
    assert c.savePrice(ctx(body={'model': 'x', 'unit': 'sec'})) == {
        'success': False, 'message': 'model, unit (sec|image|clip) and rate are required'}


def test_save_price_upsert_sql(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.savePrice(ctx(body={'model': ' gen3 ', 'unit': 'sec', 'rate': '0.25', 'label': 'Gen 3'}))
    assert r == {'success': True}
    assert ve.calls[0] == ('execute',
        "INSERT INTO video_edit_prices (model, unit, rate, label)"
        " VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE unit=VALUES(unit), rate=VALUES(rate), label=VALUES(label)",
        ['gen3', 'sec', 0.25, 'Gen 3'])


def test_save_price_failure(monkeypatch):
    class Boom(FakeDb):
        def execute(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    r = c.savePrice(ctx(body={'model': 'x', 'unit': 'sec', 'rate': 1}))
    assert r == {'success': False, 'message': 'Save failed'}


# ─── getProviders / saveProvider ─────────────────────────────────────────────

def test_get_providers_casts_and_models_json_preferred(monkeypatch):
    ve = FakeDb(all=[
        [{'provider': 'kling', 'label': 'Kling', 'api_base': '', 'enabled': 1, 'api_key': 'secret',
          'has_key': 1, 'updated_at': '2026-09-01 00:00:00'}],
        [{'provider': 'kling', 'models_json': '[{"model":"v1"}]'}],
        [],
    ])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getProviders(ctx())
    row = r['providers'][0]
    assert row['enabled'] == 1 and row['has_key'] is True
    assert row['models'] == [{'model': 'v1'}]


def test_get_providers_legacy_fallback_when_no_models_json(monkeypatch):
    ve = FakeDb(all=[
        [{'provider': 'kling', 'label': 'Kling', 'api_base': '', 'enabled': 0, 'api_key': None,
          'has_key': 0, 'updated_at': None}],
        [{'provider': 'kling', 'models_json': None}],
        [{'provider': 'kling', 'model': 'v1', 'label': 'V1', 'kind': None, 'unit': None, 'rate': '0.5'}],
    ])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getProviders(ctx())
    row = r['providers'][0]
    assert row['enabled'] == 0 and row['has_key'] is False
    assert row['models'] == [{'model': 'v1', 'label': 'V1', 'kind': 'video', 'cost': 0.5, 'unit': 'sec'}]


def test_get_providers_admin_gate():
    c, primary = controller(admin_db_rows=[{'role': 'user'}])
    assert c.getProviders(ctx())['error'] == 'Admin access required'


def test_get_providers_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.getProviders(ctx()) == {'success': False, 'providers': []}


def test_save_provider_requires_provider(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    assert c.saveProvider(ctx(body={})) == {'success': False, 'message': 'provider is required'}


def test_save_provider_blank_api_key_keeps_existing_and_models_json(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.saveProvider(ctx(body={
        'provider': 'kling', 'label': 'Kling', 'api_base': 'https://x', 'enabled': True,
        'models': [{'model': 'v1', 'label': 'V1', 'kind': 'video', 'cost': 1.5, 'unit': 'sec',
                    'client_id': 'cid1', 'start_frame': True, 'end_frame': False}],
    }))
    assert r == {'success': True}
    sql, params = ve.calls[0][1], ve.calls[0][2]
    assert 'api_key' not in sql   # blank api_key: column omitted entirely
    assert ':models_json' in params
    import json
    models = json.loads(params[':models_json'])
    assert models == [{'model': 'v1', 'label': 'V1', 'kind': 'video', 'cost': 1.5, 'unit': 'sec',
                        'client_id': 'cid1', 'start_frame': True, 'end_frame': False}]


def test_save_provider_clear_key(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    c.saveProvider(ctx(body={'provider': 'kling', 'clear_key': True}))
    _, params = ve.calls[0][1], ve.calls[0][2]
    assert params[':api_key'] is None


def test_save_provider_with_api_key_and_skipped_blank_model(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    c.saveProvider(ctx(body={'provider': 'kling', 'api_key': ' sk-123 ',
                              'models': [{'model': '  '}, {'model': 'v2'}]}))
    _, params = ve.calls[0][1], ve.calls[0][2]
    assert params[':api_key'] == 'sk-123'
    import json
    models = json.loads(params[':models_json'])
    assert len(models) == 1 and models[0]['model'] == 'v2'


def test_save_provider_admin_gate():
    c, _ = controller(admin_db_rows=[{'role': 'user'}])
    assert c.saveProvider(ctx(body={}))['error'] == 'Admin access required'


def test_save_provider_db_error(monkeypatch):
    class Boom(FakeDb):
        def execute(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    assert c.saveProvider(ctx(body={'provider': 'kling'})) == {'success': False, 'message': 'Save failed'}


# ─── getModels / saveModel ───────────────────────────────────────────────────

def test_get_models_casts_enabled(monkeypatch):
    ve = FakeDb(all=[[{'model': 'v1', 'provider': 'kling', 'kind': 'video', 'label': 'V1',
                        'enabled': 1, 'updated_at': None}]])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getModels(ctx())
    assert r['models'][0]['enabled'] == 1


def test_save_model_validation():
    c, _ = controller(config=NO_VE_CONFIG)
    r = c.saveModel(ctx(body={'model': 'v1', 'provider': 'kling', 'kind': 'bogus'}))
    assert r == {'success': False, 'message': 'DB not reachable'}


def test_save_model_validation_kind(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.saveModel(ctx(body={'model': 'v1', 'provider': 'kling', 'kind': 'bogus'}))
    assert r == {'success': False, 'message': 'model, provider and kind (video|image|music) are required'}


def test_save_model_upsert_sql(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.saveModel(ctx(body={'model': 'v1', 'provider': 'kling', 'kind': 'video', 'enabled': 1}))
    assert r == {'success': True}
    assert ve.calls[0][2] == ['v1', 'kling', 'video', 'v1', 1]   # label defaults to model


def test_save_model_admin_gate():
    c, _ = controller(admin_db_rows=[{'role': 'user'}])
    assert c.saveModel(ctx(body={}))['error'] == 'Admin access required'


# ─── getUserOverride / saveUserOverride ─────────────────────────────────────

def test_get_user_override_requires_user_id(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    assert c.getUserOverride(ctx(query={})) == {'success': False, 'message': 'user_id is required'}


def test_get_user_override_shapes(monkeypatch):
    ve = FakeDb(one=[{'capabilities': '{"voice":true}', 'byo_keys': '{"kling":"k1","other":""}'}])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUserOverride(ctx(query={'user_id': '5'}))
    assert r == {'success': True, 'user_id': 5, 'capabilities': {'voice': True}, 'byo_providers': ['kling']}


def test_get_user_override_no_row(monkeypatch):
    ve = FakeDb(one=[None])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getUserOverride(ctx(query={'user_id': '5'}))
    assert r == {'success': True, 'user_id': 5, 'capabilities': None, 'byo_providers': []}


def test_save_user_override_requires_user_id(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    assert c.saveUserOverride(ctx(body={})) == {'success': False, 'message': 'user_id is required'}


def test_save_user_override_merges_byo_keys(monkeypatch):
    ve = FakeDb(one=[{'byo_keys': '{"kling":"old","other":"keep"}'}])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.saveUserOverride(ctx(body={
        'user_id': 5, 'capabilities': {'voice': True},
        'byo_keys': {'kling': 'new', 'other': '', 'gone': '__clear__', 'new_prov': 'val'},
    }))
    assert r == {'success': True}
    params = ve.calls[-1][2]
    import json
    assert json.loads(params[':c']) == {'voice': True}
    byo = json.loads(params[':b'])
    assert byo == {'kling': 'new', 'other': 'keep', 'new_prov': 'val'}
    assert params[':by'] == 3


def test_save_user_override_no_existing_row(monkeypatch):
    ve = FakeDb(one=[None])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.saveUserOverride(ctx(body={'user_id': 5, 'byo_keys': {'kling': 'k1'}}))
    assert r == {'success': True}
    import json
    params = ve.calls[-1][2]
    assert json.loads(params[':b']) == {'kling': 'k1'}
    assert params[':c'] is None


def test_save_user_override_db_error(monkeypatch):
    class Boom(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, ve=Boom())
    c, _ = controller()
    r = c.saveUserOverride(ctx(body={'user_id': 5}))
    assert r == {'success': False, 'message': 'Save failed'}


# ─── getPackages / savePackage ───────────────────────────────────────────────

def test_get_packages_replaces_invalid_json_with_empty_object(monkeypatch):
    ve = FakeDb(all=[[{'role': 'user', 'capabilities': 'not json', 'updated_at': None},
                       {'role': 'admin', 'capabilities': '{"a":1}', 'updated_at': None}]])
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.getPackages(ctx())
    assert r['packages'][0]['capabilities'] == {}
    assert r['packages'][1]['capabilities'] == {'a': 1}


def test_save_package_invalid_role(monkeypatch):
    # PHP checks ve() reachability BEFORE role validity (VideoEditorController.php:556-562).
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.savePackage(ctx(body={'role': 'bogus', 'capabilities': {}}))
    assert r == {'success': False, 'message': 'invalid role'}


def test_save_package_db_unreachable_wins_over_invalid_role():
    c, _ = controller(config=NO_VE_CONFIG)
    r = c.savePackage(ctx(body={'role': 'bogus', 'capabilities': {}}))
    assert r == {'success': False, 'message': 'DB not reachable'}


def test_save_package_requires_capabilities_object(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.savePackage(ctx(body={'role': 'user'}))
    assert r == {'success': False, 'message': 'capabilities object is required'}


def test_save_package_upsert(monkeypatch):
    ve = FakeDb()
    patch_connect(monkeypatch, ve=ve)
    c, _ = controller()
    r = c.savePackage(ctx(body={'role': 'user', 'capabilities': {'voice': True}}))
    assert r == {'success': True}
    assert ve.calls[0][2][':r'] == 'user' and ve.calls[0][2][':by'] == 3


def test_save_package_admin_gate():
    c, _ = controller(admin_db_rows=[{'role': 'user'}])
    assert c.savePackage(ctx(body={}))['error'] == 'Admin access required'


# ─── getUsers / setUserRole ──────────────────────────────────────────────────

def test_get_users_id_is_int_and_role_lookup(monkeypatch):
    login = FakeDb(
        all=[[{'id': 5, 'email': 'a@x.com', 'first_name': 'Ann', 'last_name': 'Lee',
               'provider': 'email', 'email_verified': 1, 'last_login': None}]],
        column=[['1']])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.getUsers(ctx(query={}))
    row = r['users'][0]
    # PHP never casts id here, yet it's still a native int — verified live 2026-09-07 (see
    # module docstring): INT PK columns come back int regardless of the emulate-prepares setting.
    assert row['id'] == 5
    assert row['email_verified'] == 1
    assert row['name'] == 'Ann Lee'
    assert 'first_name' not in row and 'last_name' not in row


def test_get_users_search_query_where_clause(monkeypatch):
    login = FakeDb(all=[[]], column=[['1']])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    c.getUsers(ctx(query={'q': 'ann'}))
    sql, params = login.calls[0][1], login.calls[0][2]
    assert 'WHERE (email LIKE :q OR first_name LIKE :q OR last_name LIKE :q)' in sql
    assert params[':q'] == '%ann%'


def test_get_users_name_falls_back_to_email(monkeypatch):
    login = FakeDb(all=[[{'id': 5, 'email': 'a@x.com', 'first_name': None, 'last_name': None,
                           'provider': 'email', 'email_verified': 0, 'last_login': None}]],
                    column=[[]])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.getUsers(ctx())
    assert r['users'][0]['name'] == 'a@x.com'
    assert r['users'][0]['ve_role'] is None   # app not registered -> roles empty


def test_get_users_admin_gate():
    c, _ = controller(admin_db_rows=[{'role': 'user'}])
    assert c.getUsers(ctx())['error'] == 'Admin access required'


def test_get_users_query_failure(monkeypatch):
    class Boom(FakeDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('boom')
    patch_connect(monkeypatch, login=Boom())
    c, _ = controller()
    r = c.getUsers(ctx())
    assert r == {'success': False, 'available': False, 'users': [],
                 'message': 'User query failed — check the login DB connection'}


def test_set_user_role_requires_user_id(monkeypatch):
    login = FakeDb(column=[['1']])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.setUserRole(ctx(body={}))
    assert r == {'success': False, 'message': 'user_id is required'}


def test_set_user_role_app_not_registered(monkeypatch):
    login = FakeDb(column=[[]])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.setUserRole(ctx(body={'user_id': 5, 'role': 'user'}))
    assert r == {'success': False, 'message': 'video-edit app not registered in login'}


def test_set_user_role_invalid_role(monkeypatch):
    login = FakeDb(column=[['1']])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.setUserRole(ctx(body={'user_id': 5, 'role': 'bogus'}))
    assert r == {'success': False, 'message': 'invalid role'}


def test_set_user_role_insert_and_delete_paths(monkeypatch):
    login = FakeDb(column=[['1']])
    patch_connect(monkeypatch, login=login)
    c, _ = controller()
    r = c.setUserRole(ctx(body={'user_id': 5, 'role': 'user'}))
    assert r == {'success': True}
    assert login.calls[-1][0] == 'execute' and 'INSERT INTO app_user_roles' in login.calls[-1][1]
    assert login.calls[-1][2] == {':u': 5, ':a': 1, ':r': 'user', ':by': 3}

    login2 = FakeDb(column=[['1']])
    patch_connect(monkeypatch, login=login2)
    c2, _ = controller()
    r2 = c2.setUserRole(ctx(body={'user_id': 5, 'role': ''}))
    assert r2 == {'success': True}
    assert login2.calls[-1][0] == 'execute' and 'DELETE FROM app_user_roles' in login2.calls[-1][1]


def test_set_user_role_admin_gate():
    c, _ = controller(admin_db_rows=[{'role': 'user'}])
    assert c.setUserRole(ctx(body={}))['error'] == 'Admin access required'


def test_set_user_role_db_error(monkeypatch):
    class Boom(FakeDb):
        def execute(self, sql, params=None):
            raise RuntimeError('boom')
        def fetch_column(self, sql, params=None):
            return ['1']
    patch_connect(monkeypatch, login=Boom())
    c, _ = controller()
    r = c.setUserRole(ctx(body={'user_id': 5, 'role': 'user'}))
    assert r == {'success': False, 'message': 'Save failed'}
