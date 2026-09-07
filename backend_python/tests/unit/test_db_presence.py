"""DbPresence — shared no-runtime-DDL table/column presence checker
(constraints.md §3), replacing the byte-identical _tableExists/_columnExists
triads duplicated across SettingsController, HealController,
GenesisController, MCPServerController, MCPProxyController and
FileStorageController.
"""
from app.support.db_presence import DbPresence


class FakeDb:
    def __init__(self, tables=(), columns=()):
        """`tables`: names for which SHOW TABLES LIKE returns a row.
        `columns`: (table, column) pairs for which SHOW COLUMNS returns a row.
        `raise_columns_for`: tables whose SHOW COLUMNS raises (simulates a
        missing table under MySQL's error-on-unknown-table behaviour)."""
        self.tables = set(tables)
        self.columns = set(columns)
        self.raise_columns_for = set()
        self.calls = []

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        if sql.startswith('SHOW TABLES LIKE '):
            name = sql.split("'")[1]
            return [{'x': name}] if name in self.tables else []
        if sql.startswith('SHOW COLUMNS FROM '):
            table = sql.split('`')[1]
            if table in self.raise_columns_for:
                raise RuntimeError(f"Table '{table}' doesn't exist")
            column = sql.split("'")[1]
            return [{'x': column}] if (table, column) in self.columns else []
        raise AssertionError(f'unexpected SQL: {sql}')


def sqls(db):
    return [s for s, _ in db.calls]


# ─── table() ────────────────────────────────────────────────────────────────

def test_table_present_returns_true_and_does_not_log(caplog):
    db = FakeDb(tables=('mcp_servers',))
    p = DbPresence(db, 'Tag')
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert p.table('mcp_servers') is True
    assert caplog.records == []


def test_table_missing_returns_false_and_logs(caplog):
    db = FakeDb(tables=())
    p = DbPresence(db, 'Tag')
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert p.table('mcp_servers') is False
    msgs = [r.getMessage() for r in caplog.records]
    assert msgs == ['[Tag] mcp_servers missing — PHP creates it on demand']


def test_table_sql_is_byte_identical():
    db = FakeDb(tables=('mcp_servers',))
    DbPresence(db, 'Tag').table('mcp_servers')
    assert sqls(db) == ["SHOW TABLES LIKE 'mcp_servers'"]


def test_table_caches_and_does_not_re_query():
    db = FakeDb(tables=('mcp_servers',))
    p = DbPresence(db, 'Tag')
    p.table('mcp_servers')
    p.table('mcp_servers')
    p.table('mcp_servers')
    assert len(db.calls) == 1


def test_table_issues_no_ddl():
    db = FakeDb(tables=())
    DbPresence(db, 'Tag').table('missing_table')
    assert all('CREATE' not in s and 'ALTER' not in s for s in sqls(db))


# ─── column() ───────────────────────────────────────────────────────────────

def test_column_present_returns_true_and_does_not_log(caplog):
    db = FakeDb(columns={('users', 'heal_mode')})
    p = DbPresence(db, 'Tag')
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert p.column('users', 'heal_mode') is True
    assert caplog.records == []


def test_column_missing_returns_false_and_logs(caplog):
    db = FakeDb(columns=set())
    p = DbPresence(db, 'Tag')
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert p.column('users', 'heal_mode') is False
    msgs = [r.getMessage() for r in caplog.records]
    assert msgs == ['[Tag] users.heal_mode missing — PHP creates it on demand']


def test_column_sql_is_byte_identical():
    db = FakeDb(columns={('users', 'heal_mode')})
    DbPresence(db, 'Tag').column('users', 'heal_mode')
    assert sqls(db) == ["SHOW COLUMNS FROM `users` LIKE 'heal_mode'"]


def test_column_caches_and_does_not_re_query():
    db = FakeDb(columns={('users', 'heal_mode')})
    p = DbPresence(db, 'Tag')
    p.column('users', 'heal_mode')
    p.column('users', 'heal_mode')
    assert len(db.calls) == 1


def test_column_swallows_exception_from_missing_table(caplog):
    """SHOW COLUMNS FROM a nonexistent table raises under MySQL; a missing
    table means the column is missing too — same ruling as the six
    controllers' own _columnExists (`except Exception: rows = []`)."""
    db = FakeDb()
    db.raise_columns_for = {'heal_spend'}
    p = DbPresence(db, 'Tag')
    with caplog.at_level('INFO', logger='gpt-backend-py'):
        assert p.column('heal_spend', 'kind') is False
    msgs = [r.getMessage() for r in caplog.records]
    assert msgs == ['[Tag] heal_spend.kind missing — PHP creates it on demand']


def test_column_issues_no_ddl():
    db = FakeDb(columns=set())
    DbPresence(db, 'Tag').column('users', 'heal_mode')
    assert all('CREATE' not in s and 'ALTER' not in s for s in sqls(db))


# ─── instance isolation ─────────────────────────────────────────────────────

def test_cache_is_per_instance_not_shared():
    db = FakeDb(tables=())
    p1 = DbPresence(db, 'Tag')
    p1.table('mcp_servers')
    db.tables.add('mcp_servers')
    p2 = DbPresence(db, 'Tag')
    assert p2.table('mcp_servers') is True
