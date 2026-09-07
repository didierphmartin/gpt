"""Unit tests for scripts/register_mock_okta.py (Phase 8, Task 3).

Port of backend/scripts/register_mock_okta.php. No real DB, no real network
(httpx.MockTransport stands in for the mock Okta server).
"""
from __future__ import annotations

import json
import sys

import httpx
import pytest

sys.path.insert(0, '.')

from scripts import register_mock_okta as rmo  # noqa: E402

_CONFIG = {'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}}
_TOOLS_RESPONSE = {
    'jsonrpc': '2.0', 'id': 1,
    'result': {'tools': [
        {'name': 'lookup_user', 'description': 'Look up a user', 'inputSchema': {'type': 'object', 'properties': {'email': {'type': 'string'}}}},
        {'name': 'create_user', 'inputSchema': {}},
    ]},
}


class FakeDb:
    def __init__(self, one=None):
        self.one_queue = list(one) if one else []
        self.calls = []
        self.closed = False

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one_queue.pop(0) if self.one_queue else None

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        return 1

    def close(self):
        self.closed = True


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def _patch_db(monkeypatch, db):
    monkeypatch.setattr(rmo, 'load_config', lambda: _CONFIG)
    monkeypatch.setattr(rmo, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: db)}))


# ---------------------------------------------------------------------------
# Config guards
# ---------------------------------------------------------------------------

def test_config_error_exits_1(monkeypatch, capsys):
    def _raise():
        raise rmo.ConfigError('Missing required env vars: CTX_DB_HOST.')

    monkeypatch.setattr(rmo, 'load_config', _raise)
    assert rmo.main(['5']) == 1
    assert capsys.readouterr().err == 'Missing required env vars: CTX_DB_HOST.\n'


def test_missing_contexts_database_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(rmo, 'load_config', lambda: {})
    code = rmo.main(['5'])
    assert code == 1
    assert "no usable 'contexts_database' section" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# user_id resolution
# ---------------------------------------------------------------------------

def test_explicit_user_id_prints_using_message(monkeypatch, capsys):
    db = FakeDb(one=[{'id': 10}])  # mcp_servers upsert find
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    code = rmo.main(['5'], http_client=client)
    assert code == 0
    assert "Using user id: 5" in capsys.readouterr().out


def test_no_user_id_defaults_to_first_user(monkeypatch, capsys):
    db = FakeDb(one=[{'id': 3}, {'id': 10}])  # SELECT id FROM users, then mcp_servers find
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    code = rmo.main([], http_client=client)
    assert code == 0
    out = capsys.readouterr().out
    assert "No user id given — defaulting to first user in `users`: 3" in out


def test_no_user_id_no_users_exits_1(monkeypatch, capsys):
    db = FakeDb(one=[None])
    _patch_db(monkeypatch, db)
    code = rmo.main([])
    assert code == 1
    assert "no user_id given and no rows in `users`" in capsys.readouterr().err


def test_empty_string_user_id_treated_as_missing(monkeypatch, capsys):
    db = FakeDb(one=[{'id': 3}, {'id': 10}])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    code = rmo.main([''], http_client=client)
    assert code == 0
    assert "defaulting to first user" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# HTTP failure paths
# ---------------------------------------------------------------------------

def test_unreachable_server_exits_1(monkeypatch, capsys):
    db = FakeDb()
    _patch_db(monkeypatch, db)

    def _boom(request):
        raise httpx.ConnectError('connection refused', request=request)

    client = _client(_boom)
    code = rmo.main(['5'], http_client=client)
    assert code == 1
    err = capsys.readouterr().err
    assert f"ERROR: could not reach {rmo.MOCK_OKTA_URL}:" in err


def test_http_4xx_exits_1(monkeypatch, capsys):
    db = FakeDb()
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(500, text='boom'))
    code = rmo.main(['5'], http_client=client)
    assert code == 1
    err = capsys.readouterr().err
    assert "ERROR: mock Okta server returned HTTP 500: boom" in err


def test_empty_tools_list_exits_1(monkeypatch, capsys):
    db = FakeDb()
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json={'result': {'tools': []}}))
    code = rmo.main(['5'], http_client=client)
    assert code == 1
    assert "ERROR: tools/list returned no tools." in capsys.readouterr().err


def test_missing_tools_key_exits_1(monkeypatch, capsys):
    db = FakeDb()
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json={'result': {}}))
    code = rmo.main(['5'], http_client=client)
    assert code == 1


# ---------------------------------------------------------------------------
# Success path: SQL + insert loop
# ---------------------------------------------------------------------------

def test_success_upsert_find_delete_insert_sequence(monkeypatch, capsys):
    db = FakeDb(one=[{'id': 10}])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    code = rmo.main(['5'], http_client=client)
    assert code == 0

    kinds = [c[0] for c in db.calls]
    assert kinds == ['execute', 'fetch_one', 'execute', 'execute', 'execute']
    # 0: upsert mcp_servers
    assert 'INSERT INTO mcp_servers' in db.calls[0][1]
    assert 'ON DUPLICATE KEY UPDATE' in db.calls[0][1]
    assert db.calls[0][2] == {
        'user_id': '5', 'name': 'Okta', 'url': rmo.MOCK_OKTA_URL,
        'description': 'Mock Okta identity/MFA server (Task 9 fixture) for playbook interpreter testing.',
    }
    # 1: find id
    assert 'SELECT id FROM mcp_servers' in db.calls[1][1]
    # 2: delete
    assert 'DELETE FROM mcp_server_tools WHERE server_id = :server_id' == db.calls[2][1].strip()
    assert db.calls[2][2] == {'server_id': 10}
    # 3, 4: insert per tool
    assert 'INSERT INTO mcp_server_tools' in db.calls[3][1]
    assert db.calls[3][2]['tool_name'] == 'lookup_user'
    assert db.calls[3][2]['tool_description'] == 'Look up a user'
    assert json.loads(db.calls[3][2]['input_schema']) == {'type': 'object', 'properties': {'email': {'type': 'string'}}}

    assert db.calls[4][2]['tool_name'] == 'create_user'
    assert db.calls[4][2]['tool_description'] == ''   # PHP: $tool['description'] ?? ''
    # inputSchema present but empty {} -> passed through (not defaulted); PHP
    # round-trips an originally-empty JSON object to [] via json_decode(...,
    # true) ambiguity, then back to [] on re-encode.
    assert json.loads(db.calls[4][2]['input_schema']) == []

    out = capsys.readouterr().out
    assert "Fetched 2 tools from mock Okta server" in out
    assert f"Upserted mcp_servers row id=10 (user_id=5, url={rmo.MOCK_OKTA_URL})" in out
    assert "Inserted 2 rows into mcp_server_tools for server id=10" in out
    assert "Done." in out


def test_missing_input_schema_key_uses_default(monkeypatch):
    db = FakeDb(one=[{'id': 10}])
    _patch_db(monkeypatch, db)
    resp = {'result': {'tools': [{'name': 'no_schema_tool'}]}}
    client = _client(lambda r: httpx.Response(200, json=resp))
    rmo.main(['5'], http_client=client)
    assert json.loads(db.calls[3][2]['input_schema']) == {'type': 'object', 'properties': {}}


def test_upsert_find_returns_nothing_exits_1(monkeypatch, capsys):
    db = FakeDb(one=[None])  # find-after-upsert returns nothing
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    code = rmo.main(['5'], http_client=client)
    assert code == 1
    assert "ERROR: failed to upsert/find mcp_servers row for Okta" in capsys.readouterr().err


def test_db_closed_after_run(monkeypatch):
    db = FakeDb(one=[{'id': 10}])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_TOOLS_RESPONSE))
    rmo.main(['5'], http_client=client)
    assert db.closed is True


# ---------------------------------------------------------------------------
# run(): PHP's uncaught-PDOException -> exit 255 parity
# ---------------------------------------------------------------------------

def test_run_wrapper_exits_255_on_uncaught_db_connect_failure(monkeypatch, capsys):
    monkeypatch.setattr(rmo, 'load_config', lambda: _CONFIG)

    def _boom(cfg):
        raise RuntimeError('connection refused')

    monkeypatch.setattr(rmo, 'Db', type('D', (), {'connect': staticmethod(_boom)}))
    monkeypatch.setattr(sys, 'argv', ['register_mock_okta.py', '5'])

    with pytest.raises(SystemExit) as ei:
        rmo.run()
    assert ei.value.code == 255
    assert 'RuntimeError' in capsys.readouterr().err
