"""Port of backend/tests/Unit/Playbook/PlaybookDbTestCase.php (35 lines).

PHP backs the test case with an in-memory sqlite PDO. This port backs it
with the same in-memory sqlite3 database, wrapped behind the app's `Db`
surface (fetch_one/fetch_all/fetch_column/execute/insert) so
PlaybookRunState (which is written against that surface, not raw PDO/DB-API)
runs unmodified against it — see app/playbook/playbook_run_state.py.
"""
from __future__ import annotations

import sqlite3
import time
from collections.abc import Mapping

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
        self._in_tx = False

    @staticmethod
    def _params(params):
        # PDO-style named params ({':id': 1}) as the app's Db accepts them; sqlite3 wants {'id': 1}.
        if isinstance(params, Mapping):
            return {k.lstrip(':'): v for k, v in params.items()}
        return params or []

    def _run(self, sql, params):
        return self.conn.execute(sql, self._params(params))

    def _autocommit(self):
        if not self._in_tx:
            self.conn.commit()

    def fetch_one(self, sql, params=None):
        row = self._run(sql, params).fetchone()
        return dict(row) if row is not None else None

    def fetch_all(self, sql, params=None):
        return [dict(r) for r in self._run(sql, params).fetchall()]

    def fetch_column(self, sql, params=None):
        return [row[0] for row in self._run(sql, params).fetchall()]

    def execute(self, sql, params=None):
        cur = self._run(sql, params)
        self._autocommit()
        return cur.rowcount

    def insert(self, sql, params=None):
        cur = self._run(sql, params)
        self._autocommit()
        return cur.lastrowid

    def inTransaction(self) -> bool:
        return self._in_tx

    def begin(self):
        self.conn.commit()
        self._in_tx = True

    def commit(self):
        self._in_tx = False
        self.conn.commit()

    def rollback(self):
        self._in_tx = False
        self.conn.rollback()


def sqlite_db(*ddl: str) -> SqliteDb:
    """An in-memory SqliteDb with MySQL's NOW() and the given tables (the PHP tests' sqlite PDO)."""
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, lambda: time.strftime('%Y-%m-%d %H:%M:%S'))
    for statement in ddl:
        conn.execute(statement)
    conn.commit()
    return SqliteDb(conn)


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


PLAYBOOKS_DDL = [
    'CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL, '
    'title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT, '
    'published_by INTEGER NULL, published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER NULL, UNIQUE (user_id, pkey))',
    'CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, '
    "agent_type TEXT DEFAULT 'standard', instructions TEXT, playbook_id INTEGER)",
    'CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)',
    'CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT)',
]

OKTA = ("A note for colleagues: Okta prod tenant only.\n\nTitle: Okta password reset\nTrigger: A user is locked out.\n"
        "Instructions:\n1. #Search Okta Users with the email.\n2. #Reset Okta Password.\n\n"
        "(Ask Identity Team before changing step 2.)\nTools used: Okta\nActions used: #Search Okta Users; #Reset Okta Password\n")


@pytest.fixture
def pbc_db():
    db = make_sqlite_db()
    for ddl in PLAYBOOKS_DDL:
        db.execute(ddl)
    return db
