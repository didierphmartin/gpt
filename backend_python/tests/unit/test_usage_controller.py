from starlette.datastructures import Headers

from app.controllers.usage_controller import UsageController
from app.support.http import Ctx


class FakeDb:
    """Records queries; answers fetch_one/fetch_all from canned values."""
    def __init__(self, one=None, all_=None):
        self.one = one
        self.all_ = all_ if all_ is not None else []
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        return self.all_

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return 1

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        return 1


def ctx(query=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body={}, raw_body='',
               params={}, user_id=user_id, authenticated=True, remote_addr='')


# --- getBalance --------------------------------------------------------

def test_get_balance_no_provider_queries_all_rows_for_user():
    db = FakeDb(all_=[{'provider': 'claude', 'total_tokens': 10}])
    r = UsageController(db, {}).getBalance(ctx())
    assert r == {'success': True, 'data': [{'provider': 'claude', 'total_tokens': 10}], 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == "SELECT * FROM llm_usage_balance WHERE user_id = :user_id" and params == {':user_id': 3}


def test_get_balance_with_provider_queries_single_row():
    db = FakeDb(one={'provider': 'claude', 'total_tokens': 10})
    r = UsageController(db, {}).getBalance(ctx(query={'provider': 'claude'}))
    assert r == {'success': True, 'data': {'provider': 'claude', 'total_tokens': 10}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == "SELECT * FROM llm_usage_balance\n                        WHERE user_id = :user_id AND provider = :provider"
    assert params == {':user_id': 3, ':provider': 'claude'}


def test_get_balance_no_row_returns_empty_dict():
    db = FakeDb(one=None)
    r = UsageController(db, {}).getBalance(ctx(query={'provider': 'claude'}))
    assert r['data'] == {}


# --- getTransactions -----------------------------------------------------

def test_get_transactions_defaults_limit_100_offset_0():
    db = FakeDb(all_=[])
    r = UsageController(db, {}).getTransactions(ctx())
    assert r == {'success': True, 'data': [], 'pagination': {'limit': 100, 'offset': 0, 'count': 0}, 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == "SELECT * FROM llm_usage_transactions WHERE user_id = :user_id ORDER BY created_at DESC LIMIT 100 OFFSET 0"
    assert params == {':user_id': 3}


def test_get_transactions_php_intval_on_limit_and_offset():
    db = FakeDb(all_=[{'id': 1}])
    r = UsageController(db, {}).getTransactions(ctx(query={'limit': '5', 'offset': '2'}))
    assert r['pagination'] == {'limit': 5, 'offset': 2, 'count': 1}
    sql, _ = db.calls[-1]
    assert 'LIMIT 5 OFFSET 2' in sql


def test_get_transactions_limit_out_of_range_resets_to_100():
    db = FakeDb(all_=[])
    assert UsageController(db, {}).getTransactions(ctx(query={'limit': '0'}))['pagination']['limit'] == 100
    db2 = FakeDb(all_=[])
    assert UsageController(db2, {}).getTransactions(ctx(query={'limit': '5000'}))['pagination']['limit'] == 100


def test_get_transactions_filters_are_applied_when_present():
    db = FakeDb(all_=[])
    UsageController(db, {}).getTransactions(ctx(query={
        'provider': 'claude', 'date_from': '2026-01-01', 'date_to': '2026-02-01', 'status': 'success',
    }))
    sql, params = db.calls[-1]
    assert sql == (
        "SELECT * FROM llm_usage_transactions WHERE user_id = :user_id"
        " AND provider = :provider AND created_at >= :date_from AND created_at < :date_to"
        " AND status = :status ORDER BY created_at DESC LIMIT 100 OFFSET 0"
    )
    assert params == {
        ':user_id': 3, ':provider': 'claude', ':date_from': '2026-01-01',
        ':date_to': '2026-02-01', ':status': 'success',
    }


# --- getStats --------------------------------------------------------------

def test_get_stats_defaults_to_month():
    db = FakeDb(one={'total_requests': 0})
    r = UsageController(db, {}).getStats(ctx())
    assert r == {'success': True, 'data': {'total_requests': 0}, 'period': 'month', 'provider': None, 'status_code': 200}
    sql, _ = db.calls[-1]
    assert 'DATE_SUB(CURDATE(), INTERVAL 30 DAY)' in sql


def test_get_stats_valid_period_passes_through():
    db = FakeDb(one={})
    r = UsageController(db, {}).getStats(ctx(query={'period': 'year'}))
    assert r['period'] == 'year'
    sql, _ = db.calls[-1]
    assert 'INTERVAL 1 YEAR' in sql


def test_get_stats_invalid_period_resets_to_month():
    db = FakeDb(one={})
    r = UsageController(db, {}).getStats(ctx(query={'period': 'decade'}))
    assert r['period'] == 'month'


def test_get_stats_all_period_has_no_date_condition():
    db = FakeDb(one={})
    UsageController(db, {}).getStats(ctx(query={'period': 'all'}))
    sql, _ = db.calls[-1]
    assert 'DATE_SUB' not in sql and 'CURDATE' not in sql


def test_get_stats_provider_filter_applied():
    db = FakeDb(one={})
    r = UsageController(db, {}).getStats(ctx(query={'provider': 'claude'}))
    assert r['provider'] == 'claude'
    sql, params = db.calls[-1]
    assert sql.endswith('AND provider = :provider') and params[':provider'] == 'claude'
