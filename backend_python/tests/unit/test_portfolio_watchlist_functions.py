import pytest
from app.functions.portfolio_functions import PortfolioFunctions
from app.functions.watchlist_functions import WatchlistFunctions, _php_ge, _php_le


class Db:
    """Records SQL + params; answers from a queue of canned results."""
    def __init__(self, results=None): self.calls = []; self.results = list(results or [])
    def _next(self, default):
        return self.results.pop(0) if self.results else default
    def fetch_all(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next([])
    def fetch_one(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(None)
    def fetch_column(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next([])
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(1)
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return self._next(1)


def test_portfolio_registry_and_guards():
    pf = PortfolioFunctions()
    assert list(pf.getAllFunctions()) == ['get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions']
    assert pf.getPortfolios({}, 3) == {'error': 'Database connection or user ID not available'}
    assert PortfolioFunctions(Db()).getPortfolios({}, None) == {'error': 'Database connection or user ID not available'}
    assert pf.setPDO(Db()) is pf


def test_get_portfolios_sql_and_shape():
    db = Db([[{'id': 1, 'name': 'Main', 'description': None, 'is_default': 1, 'currency': 'USD', 'created_at': '2026-01-01 00:00:00'}]])
    out = PortfolioFunctions(db).getPortfolios({}, 3)
    sql, params = db.calls[0]
    assert sql == 'SELECT id, name, description, is_default, currency, created_at FROM portfolios WHERE user_id = ? ORDER BY is_default DESC, name ASC' and params == [3]
    assert out == {
        'success': True,
        'portfolios': [{'id': 1, 'name': 'Main', 'description': None, 'is_default': 1, 'currency': 'USD', 'created_at': '2026-01-01 00:00:00'}],
        'count': 1,
    }


def test_assets_with_discovery_falls_back_to_default_then_first_portfolio():
    db = Db([None, None])                       # no default portfolio, no portfolio at all
    out = PortfolioFunctions(db).getPortfolioAssetsWithDiscovery({}, 3)
    sqls = [s for s, _ in db.calls]
    assert 'SELECT id FROM portfolios WHERE user_id = ? AND is_default = 1 LIMIT 1' in sqls
    assert 'SELECT id FROM portfolios WHERE user_id = ? ORDER BY id ASC LIMIT 1' in sqls
    # PHP 163-169: no portfolio found at all -> this exact shape, no error key
    assert out == {'success': False, 'message': 'No portfolio found for user', 'assets': []}


def test_all_transactions_pagination_params():
    db = Db([[], [0]])
    out = PortfolioFunctions(db).getAllTransactions({'page': '2', 'limit': '10', 'sort': 'date', 'order': 'asc'}, 3)
    assert out['success'] is True and out['pagination']['page'] == 2 and out['pagination']['limit'] == 10
    first_sql, first_params = db.calls[0]
    assert first_sql.startswith('SELECT') and 'FROM transactions t' in first_sql and 3 in first_params


def test_all_transactions_defaults_sort_to_date_when_omitted():
    # PHP:281 re-reads the undefined $params['sort'] in its true branch when sort is
    # omitted -> null -> "ORDER BY t.  DESC" -> SQL error. Ruling (findings Important):
    # that's an accidental PHP crash, not a designed default; this port keeps the
    # clean 'date' default and must not crash.
    db = Db([[], [0]])
    out = PortfolioFunctions(db).getAllTransactions({}, 3)
    assert out['success'] is True
    first_sql, _ = db.calls[0]
    assert 'ORDER BY t.date DESC' in first_sql


def test_watchlist_registry_guards_and_get():
    wf = WatchlistFunctions()
    assert list(wf.getAllFunctions()) == ['get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist']
    assert wf.getUserWatchlist({}, 3) == {'error': 'Database connection or user ID not available'}
    db = Db([[{'id': 9, 'user_id': 3, 'asset_id': 4, 'name': 'Apple', 'symbol': 'AAPL', 'type': 'stock', 'exchange': 'NASDAQ', 'currency': 'USD'}]])
    out = WatchlistFunctions(db).getUserWatchlist({}, 3)
    sql, params = db.calls[0]
    assert sql == 'SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency FROM watchlist w JOIN assets a ON w.asset_id = a.id WHERE w.user_id = ? ORDER BY w.created_at DESC' and params == [3]
    assert out['success'] is True and out['count'] == 1 and out['watchlist'][0]['symbol'] == 'AAPL'


def test_add_to_watchlist_creates_asset_then_link():
    db = Db([None, 42, None, 1])                # no asset → insert id 42 → not yet in watchlist → insert link
    out = WatchlistFunctions(db).addToWatchlist({'symbol': 'aapl', 'name': 'Apple', 'type': 'stock'}, 3)
    sqls = [s for s, _ in db.calls]
    assert sqls[0] == 'SELECT id FROM assets WHERE symbol = ?'
    assert any(s.startswith('INSERT INTO assets (symbol, name, type, exchange, currency, created_at)') for s in sqls)
    assert 'SELECT id FROM watchlist WHERE user_id = ? AND asset_id = ?' in sqls
    assert 'INSERT INTO watchlist (user_id, asset_id, created_at) VALUES (?, ?, NOW())' in sqls
    assert out['success'] is True


def test_add_to_watchlist_validation_and_duplicate():
    # PHP 192-194: empty($symbol) -> {'error': 'Symbol is required'}
    assert WatchlistFunctions(Db()).addToWatchlist({'symbol': ''}, 3) == {'error': 'Symbol is required'}
    db = Db([{'id': 4}, {'id': 9}])                                                        # asset exists, already on watchlist
    out = WatchlistFunctions(db).addToWatchlist({'symbol': 'AAPL', 'name': 'Apple', 'type': 'stock'}, 3)
    # PHP 218-223: already in watchlist -> success False with message, no error key
    assert out == {'success': False, 'message': 'AAPL is already in your watchlist'}


def test_remove_from_watchlist_uses_delete_join_and_rowcount():
    db = Db([1])
    out = WatchlistFunctions(db).removeFromWatchlist({'symbol': 'aapl'}, 3)
    sql, params = db.calls[0]
    assert sql.startswith('DELETE w FROM watchlist w') and params[0] == 3 and 'AAPL' in params
    assert out['success'] is True
    # PHP 271-274: rowCount() == 0 -> success False with "not found" message, no error key
    assert WatchlistFunctions(Db([0])).removeFromWatchlist({'symbol': 'AAPL'}, 3) == {
        'success': False,
        'message': 'AAPL was not found in your watchlist',
    }


def test_php_loose_cmp_helper_matches_php8_rules():
    # WatchlistFunctions.php:24/28 compare DB-sourced values (DECIMAL-as-string, or
    # None on a LEFT JOIN miss) with PHP 8 loose `>=`/`<=` semantics.
    assert _php_ge('10.50', '9.00') is True     # numeric string vs numeric string -> numeric compare
    assert _php_le('10.50', '9.00') is False
    assert _php_ge(None, '9.00') is False       # null -> '' ; '' >= '9.00' is false (lexical)
    assert _php_le(None, '9.00') is True        # PHP quirk: '' <= '9.00' is TRUE
    assert _php_ge('abc', '9.00') is True       # neither numeric -> lexical: 'a' (0x61) > '9' (0x39)
    assert _php_le('abc', '9.00') is False


def test_watchlist_market_data_alert_uses_php_loose_comparison():
    # PHP 22-32 (php-watchlist-market-data.txt): alert_triggered/alert_type computed
    # per-row from current_price vs alert_price_above/below with PHP loose comparison.
    rows = [
        {'symbol': 'AAA', 'current_price': '10.50', 'alert_price_above': '9.00', 'alert_price_below': None},
        {'symbol': 'BBB', 'current_price': None, 'alert_price_above': None, 'alert_price_below': '9.00'},
        {'symbol': 'CCC', 'current_price': None, 'alert_price_above': '9.00', 'alert_price_below': None},
    ]
    db = Db([rows])
    out = WatchlistFunctions(db).getWatchlistWithMarketData({}, 3)
    assert 'error' not in out
    above, below_quirk, no_trigger = out['watchlist']
    assert above['alert_triggered'] is True and above['alert_type'] == 'above'
    # PHP quirk (reproduced, not "fixed"): current_price=None fires the "below" alert
    # because null <= '9.00' is true under PHP loose comparison.
    assert below_quirk['alert_triggered'] is True and below_quirk['alert_type'] == 'below'
    assert no_trigger['alert_triggered'] is False and 'alert_type' not in no_trigger
