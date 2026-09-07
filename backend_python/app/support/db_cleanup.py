"""Shared helper for admin controllers that open a secondary DB connection
(login DB / video-edit DB / ...) on top of the primary `self.db` connection.

PHP caches these secondary PDO handles for the life of the request and never
closes them explicitly (see VideoEditorController.php / LoginAdminController.php
`connect()`) — the request just ends and PHP's garbage collector closes the
socket. These ports cache the connection on the controller instance instead
(`self._cache` / `self._login_cache`), so they must close it explicitly once
the route method returns — success or error — rather than leaking a live
PyMySQL socket per request. This is a resource-lifecycle detail, not an
output difference from PHP.
"""
from __future__ import annotations

import functools

from app.support.logger import error_log


def close_secondary_connections(fn):
    """Method decorator: after `fn` returns (return OR exception), calls
    `self._close_connections()`. `self` must implement that method."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        finally:
            self._close_connections()
    return wrapper


def close_db(conn, *, log_prefix: str) -> None:
    """Close one secondary DB connection. Log-and-swallow on failure — a close
    error must never surface as (or mask) the route's own response."""
    if conn is None:
        return
    try:
        conn.close()
    except Exception as e:  # noqa: BLE001
        error_log(f"[{log_prefix}] close failed: {e}")
