"""Port of backend/tests/Unit/Playbook/PlaybookDbTestCase.php (35 lines).

PHP backs the test case with an in-memory sqlite PDO. This port backs it
with the same in-memory sqlite3 database, wrapped behind the app's `Db`
surface (fetch_one/fetch_all/fetch_column/execute/insert) so
PlaybookRunState (which is written against that surface, not raw PDO/DB-API)
runs unmodified against it — see app/playbook/playbook_run_state.py.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.playbook.playbook_run_state import PlaybookRunState
from app.playbook.playbook_transcript import PlaybookTranscript


class SqliteDb:
    """Minimal Db-surface adapter over Python's sqlite3, standing in for the
    app's pymysql-backed `Db` (app/db.py) in tests. `?` placeholders are
    native to both PDO's sqlite driver and Python's sqlite3, so PlaybookRunState's
    SQL (copied byte-identical from the PHP source) runs unmodified here."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def fetch_one(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        row = cur.fetchone()
        return dict(row) if row is not None else None

    def fetch_all(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        return [dict(r) for r in cur.fetchall()]

    def fetch_column(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        return [row[0] for row in cur.fetchall()]

    def execute(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        self.conn.commit()
        return cur.rowcount

    def insert(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        self.conn.commit()
        return cur.lastrowid


def make_sqlite_db() -> SqliteDb:
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT, "
        "document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT, "
        "current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)"
    )
    conn.execute(
        "CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, "
        "direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)"
    )
    conn.execute(
        "CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, "
        "author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)"
    )
    conn.execute(
        "CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0, "
        "seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT, "
        "sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)"
    )
    conn.execute(
        "CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0, "
        "kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)"
    )
    conn.commit()
    return SqliteDb(conn)


@pytest.fixture
def pb_db() -> SqliteDb:
    return make_sqlite_db()


@pytest.fixture
def pb_dir(tmp_path) -> str:
    d = tmp_path / 'pbtest'
    d.mkdir()
    return str(d)


@pytest.fixture
def pb_state(pb_db, pb_dir) -> PlaybookRunState:
    return PlaybookRunState(pb_db, PlaybookTranscript(pb_dir))
