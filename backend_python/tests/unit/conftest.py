"""Unit tests never reach a real MySQL server.

backend/.env points at the production database, and load_config() reads it. Here:

- every unit test runs with the DB_* / CTX_DB_* / LOGIN_DB_* / VE_DB_* settings
  pinned to an unresolvable host, and with pymysql's socket open refused, so any
  connect attempt fails at once with an OperationalError naming the cause
  (tests that monkeypatch pymysql.connect or Db.connect with a fake still work:
  a fake never opens a real Connection);
- `config` and `client` are overridden for tests/unit: the config is loaded with
  those pinned settings, and the app opens a NoDb per request instead of a
  connection (tests/differential keeps the root conftest's real ones). Tests that
  build their own app use the `create_app` and `db_factory` fixtures.
"""
from __future__ import annotations

from contextlib import contextmanager

import pymysql
import pytest
from fastapi.testclient import TestClient

GUARD_HOST = 'unit-tests-must-not-use-a-real-db.invalid'
GUARD_ENV = {f'{prefix}_{part}': (GUARD_HOST if part == 'HOST' else 'no_real_db_in_tests')
             for prefix in ('DB', 'CTX_DB', 'LOGIN_DB', 'VE_DB')
             for part in ('HOST', 'NAME', 'USER', 'PASS')}


def _refuse_mysql(self, *args, **kwargs):
    raise pymysql.err.OperationalError(
        2003, f'Unit tests must not open a MySQL connection (host={self.host!r}); '
              'use a FakeDb/SqliteDb or monkeypatch Db.connect.')


@pytest.fixture(autouse=True)
def _no_real_database(monkeypatch):
    for key, value in GUARD_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(pymysql.connections.Connection, 'connect', _refuse_mysql)


class NoDb:
    """The per-request Db for app-level tests whose routes never query."""

    def close(self) -> None:
        pass

    def __getattr__(self, name):
        raise AssertionError(f'this test app has no database (Db.{name} was called)')


@pytest.fixture(scope='session')
def db_factory():
    return NoDb


@contextmanager
def guarded_env():
    """The pinned DB settings, for session/module fixtures (set up before the autouse guard)."""
    with pytest.MonkeyPatch.context() as mp:
        for key, value in GUARD_ENV.items():
            mp.setenv(key, value)
        yield


@pytest.fixture(scope='session')
def config():
    from app.config import load_config
    with guarded_env():
        return load_config()


@pytest.fixture(scope='session')
def create_app():
    """main.create_app, imported under the pinned settings (importing main builds its
    module-level app from load_config())."""
    with guarded_env():
        from main import create_app as factory
    return factory


@pytest.fixture(scope='session')
def client(create_app, config, db_factory):
    return TestClient(create_app(config, db_factory=db_factory))
