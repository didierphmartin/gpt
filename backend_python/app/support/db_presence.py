"""Shared no-runtime-DDL table/column presence checker (constraints.md §3).

PHP's `ensure*TableExists()` / `ensure*ColumnsExist()` methods used to
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` on demand. Every
ported controller instead checks presence once (`SHOW TABLES LIKE` /
`SHOW COLUMNS FROM ... LIKE`), caches the answer for its own lifetime, and
`error_log()`s that PHP creates the table/column on demand when it is
missing — the port never issues DDL itself.

SettingsController, HealController, GenesisController, MCPServerController,
MCPProxyController and FileStorageController each carried a byte-identical
copy of this pair of checks; this is the single copy they now delegate to.
Each controller's own `ensure*` method names are unchanged — only the
bodies now call `self._presence.table(...)` / `self._presence.column(...)`.
"""
from __future__ import annotations

from app.support.logger import error_log


class DbPresence:
    def __init__(self, db, tag: str):
        self.db = db
        self.tag = tag
        self._cache: dict[str, bool] = {}

    def table(self, name: str) -> bool:
        cache_key = 't:' + name
        if cache_key not in self._cache:
            self._cache[cache_key] = len(self.db.fetch_all(f"SHOW TABLES LIKE '{name}'")) > 0
        exists = self._cache[cache_key]
        if not exists:
            error_log(f'[{self.tag}] {name} missing — PHP creates it on demand')
        return exists

    def column(self, table: str, name: str) -> bool:
        cache_key = f'c:{table}.{name}'
        if cache_key not in self._cache:
            try:
                rows = self.db.fetch_all(f"SHOW COLUMNS FROM `{table}` LIKE '{name}'")
            except Exception:  # noqa: BLE001 — missing table => missing column
                rows = []
            self._cache[cache_key] = len(rows) > 0
        exists = self._cache[cache_key]
        if not exists:
            error_log(f'[{self.tag}] {table}.{name} missing — PHP creates it on demand')
        return exists
