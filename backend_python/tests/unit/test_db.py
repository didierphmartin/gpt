from datetime import datetime, date
from decimal import Decimal
import pytest
from app.db import Db, normalize_value, normalize_row


def test_normalize_scalars_like_pdo():
    assert normalize_value(datetime(2026, 9, 5, 18, 40, 16)) == '2026-09-05 18:40:16'
    assert normalize_value(date(2026, 9, 5)) == '2026-09-05'
    assert normalize_value(Decimal('12.50')) == '12.50'
    assert normalize_value(b'abc') == 'abc'
    assert normalize_value(7) == 7 and normalize_value(None) is None and normalize_value('s') == 's'


def test_normalize_row_keeps_key_order():
    row = normalize_row({'id': 1, 'created_at': datetime(2026, 1, 2, 3, 4, 5), 'name': 'x'})
    assert list(row) == ['id', 'created_at', 'name']
    assert row['created_at'] == '2026-01-02 03:04:05'


class _FakeCursor:
    def __init__(self):
        self.closed = False
    def execute(self, sql, params):
        raise ValueError('boom')
    def close(self):
        self.closed = True


class _FakeConn:
    def __init__(self):
        self.cur = None
    def cursor(self):
        self.cur = _FakeCursor()
        return self.cur


def test_run_closes_cursor_when_execute_raises():
    conn = _FakeConn()
    db = Db(conn)
    with pytest.raises(ValueError, match='boom'):
        db.fetch_one('SELECT 1 WHERE id = ?', [1])
    assert conn.cur.closed is True
