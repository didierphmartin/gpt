import pymysql
from app.db import Db


class FlakyConn:
    """First execute raises 'server has gone away'; a fresh connection succeeds."""
    instances = 0
    def __init__(self): FlakyConn.instances += 1; self.calls = 0; self.closed = False
    def cursor(self): return FlakyCursor(self)
    def close(self): self.closed = True
    def begin(self): self.began = True
    def commit(self): self.committed = True
    def rollback(self): self.rolled = True


class FlakyCursor:
    def __init__(self, conn): self.conn = conn; self.rowcount = 1; self.lastrowid = 7
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def execute(self, sql, params=None):
        self.conn.calls += 1
        if FlakyConn.instances == 1 and self.conn.calls == 1:
            raise pymysql.err.OperationalError(2006, 'MySQL server has gone away')
    def fetchone(self): return {'n': 1}
    def fetchall(self): return [{'n': 1}]
    def close(self): pass


def test_reconnects_once_on_gone_away(monkeypatch):
    FlakyConn.instances = 0
    monkeypatch.setattr('app.db.pymysql.connect', lambda **kw: FlakyConn())
    db = Db.connect({'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'})
    assert db.fetch_one('SELECT 1 AS n') == {'n': 1}
    assert FlakyConn.instances == 2


def test_transaction_methods_delegate(monkeypatch):
    FlakyConn.instances = 5
    monkeypatch.setattr('app.db.pymysql.connect', lambda **kw: FlakyConn())
    db = Db.connect({'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'})
    db.begin(); db.commit(); db.rollback()
    assert db._conn.began and db._conn.committed and db._conn.rolled
