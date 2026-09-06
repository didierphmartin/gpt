from datetime import datetime, date
from decimal import Decimal
from app.db import normalize_value, normalize_row


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
