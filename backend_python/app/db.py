"""One PyMySQL connection per request, PDO-like typing of result rows.

PHP (`PDO::ATTR_EMULATE_PREPARES => false`, mysqlnd) returns INT columns as int,
DECIMAL/DATETIME/TIMESTAMP/JSON as strings. PyMySQL returns datetime/Decimal
objects, so rows are normalized here before controllers see them.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pymysql
import pymysql.cursors

from app.support.sql import translate


def normalize_value(v):
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, date):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode('utf-8', errors='replace')
    return v


def normalize_row(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {k: normalize_value(v) for k, v in row.items()}


class Db:
    def __init__(self, conn: pymysql.connections.Connection):
        self._conn = conn

    @classmethod
    def connect(cls, cfg: dict, timeout: int = 10) -> 'Db':
        conn = pymysql.connect(
            host=cfg['host'], user=cfg['username'], password=cfg['password'],
            database=cfg['database'], charset=cfg.get('charset', 'utf8mb4'),
            port=int(cfg.get('port', 3306)), connect_timeout=timeout,
            cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        )
        return cls(conn)

    def _run(self, sql, params):
        sql, params = translate(sql, params)
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return cur

    def fetch_one(self, sql: str, params=None) -> dict | None:
        with self._run(sql, params) as cur:
            return normalize_row(cur.fetchone())

    def fetch_all(self, sql: str, params=None) -> list[dict]:
        with self._run(sql, params) as cur:
            return [normalize_row(r) for r in cur.fetchall()]

    def fetch_column(self, sql: str, params=None) -> list:
        with self._run(sql, params) as cur:
            return [normalize_value(next(iter(r.values()))) for r in cur.fetchall()]

    def execute(self, sql: str, params=None) -> int:
        with self._run(sql, params) as cur:
            return cur.rowcount

    def insert(self, sql: str, params=None) -> int:
        with self._run(sql, params) as cur:
            return int(cur.lastrowid or 0)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def open_primary(config: dict) -> Db:
    """index.php: $config['contexts_database'] ?? $config['database']."""
    return Db.connect(config.get('contexts_database') or config['database'])
