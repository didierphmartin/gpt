"""Unit tests for scripts/register_mock_stack.py (Phase 8, Task 3).

Port of backend/scripts/register_mock_stack.php. No real DB, no real
network (httpx.MockTransport stands in for each mock server).
"""
from __future__ import annotations

import json
import sys

import httpx
import pytest

sys.path.insert(0, '.')

from scripts import register_mock_stack as rms  # noqa: E402

_CONFIG = {'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p', 'charset': 'utf8mb4'}}


def _tools_response(n=1):
    return {'result': {'tools': [{'name': f't{i}', 'description': f'd{i}'} for i in range(n)]}}


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


def _patch_db(monkeypatch, db):
    monkeypatch.setattr(rms, 'load_config', lambda: _CONFIG)
    monkeypatch.setattr(rms, 'Db', type('D', (), {'connect': staticmethod(lambda cfg: db)}))


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_servers_list_has_nine_entries_okta_first():
    assert len(rms.SERVERS) == 9
    assert rms.SERVERS[0]['name'] == 'Okta'
    assert [s['name'] for s in rms.SERVERS] == [
        'Okta', 'Google Workspace', 'Google Calendar', 'Slack', 'Kandji',
        'GitHub', 'Datadog', 'AWS', 'Workday',
    ]


def test_config_error_exits_1(monkeypatch, capsys):
    def _raise():
        raise rms.ConfigError('Missing required env vars: CTX_DB_HOST.')

    monkeypatch.setattr(rms, 'load_config', _raise)
    assert rms.main(['5']) == 1
    assert capsys.readouterr().err == 'Missing required env vars: CTX_DB_HOST.\n'


def test_missing_contexts_database_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(rms, 'load_config', lambda: {})
    code = rms.main(['5'])
    assert code == 1
    assert "no usable 'contexts_database' config" in capsys.readouterr().err


def test_explicit_user_id_prints_no_announce_line(monkeypatch, capsys):
    """PHP register_mock_stack.php has NO `else` branch announcing an
    explicitly-given user id (unlike register_mock_okta.php)."""
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_tools_response(1)))
    code = rms.main(['5'], http_client=client)
    assert code == 0
    out = capsys.readouterr().out
    assert 'Using user id' not in out
    assert 'defaulting' not in out


def test_no_user_id_defaults_and_announces(monkeypatch, capsys):
    db = FakeDb(one=[{'id': 3}] + [{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_tools_response(1)))
    code = rms.main([], http_client=client)
    assert code == 0
    assert "No user id given — defaulting to first user: 3" in capsys.readouterr().out


def test_no_user_id_no_users_exits_1(monkeypatch, capsys):
    db = FakeDb(one=[None])
    _patch_db(monkeypatch, db)
    code = rms.main([])
    assert code == 1
    assert "ERROR: no user_id and no users" in capsys.readouterr().err


def test_all_nine_servers_registered_on_success(monkeypatch, capsys):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_tools_response(2)))
    code = rms.main(['5'], http_client=client)
    assert code == 0
    out = capsys.readouterr().out
    for srv in rms.SERVERS:
        assert srv['name'] in out
    assert out.rstrip().endswith('Done.')
    # 9 servers x (upsert, find, delete, N inserts) = 9 x 4 = 36 (n=2 tools -> 2 inserts each)
    execute_calls = [c for c in db.calls if c[0] == 'execute']
    assert len(execute_calls) == 9 * (1 + 1 + 2)   # upsert + delete + 2 inserts, per server


def test_sprintf_line_format_padding(monkeypatch, capsys):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_tools_response(3)))
    rms.main(['5'], http_client=client)
    out = capsys.readouterr().out
    assert "Okta              server id=1 — 3 tools" in out
    assert "AWS               server id=8 — 3 tools" in out


def test_one_server_unreachable_is_skipped_others_continue(monkeypatch, capsys):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)

    def handler(request):
        if 'mockokta' in str(request.url):
            raise httpx.ConnectError('refused', request=request)
        return httpx.Response(200, json=_tools_response(1))

    client = _client(handler)
    code = rms.main(['5'], http_client=client)
    assert code == 0
    out = capsys.readouterr().out
    assert 'Google Workspace' in out
    assert 'Done.' in out


def test_server_with_no_tools_is_skipped(monkeypatch, capsys):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)

    def handler(request):
        if 'mockokta' in str(request.url):
            return httpx.Response(200, json={'result': {'tools': []}})
        return httpx.Response(200, json=_tools_response(1))

    client = _client(handler)
    code = rms.main(['5'], http_client=client)
    assert code == 0


def test_skip_message_format(monkeypatch, capsys):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)

    def handler(request):
        if 'mockokta' in str(request.url):
            raise httpx.ConnectError('refused', request=request)
        return httpx.Response(200, json=_tools_response(1))

    client = _client(handler)
    rms.main(['5'], http_client=client)
    err = capsys.readouterr().err
    assert 'SKIP Okta: unreachable (' in err


def test_input_schema_field_mapping(monkeypatch):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    resp = {'result': {'tools': [{'name': 'invite_user_to_org', 'description': 'invite'}]}}
    client = _client(lambda r: httpx.Response(200, json=resp))
    rms.main(['5'], http_client=client)

    insert_calls = [c for c in db.calls if c[0] == 'execute' and 'INSERT INTO mcp_server_tools' in c[1]]
    assert insert_calls[0][2]['tn'] == 'invite_user_to_org'
    assert insert_calls[0][2]['td'] == 'invite'
    assert json.loads(insert_calls[0][2]['sc']) == {'type': 'object', 'properties': {}}


def test_db_closed_after_run(monkeypatch):
    db = FakeDb(one=[{'id': i} for i in range(1, 10)])
    _patch_db(monkeypatch, db)
    client = _client(lambda r: httpx.Response(200, json=_tools_response(1)))
    rms.main(['5'], http_client=client)
    assert db.closed is True


# ---------------------------------------------------------------------------
# run(): PHP's uncaught-PDOException -> exit 255 parity
# ---------------------------------------------------------------------------

def test_run_wrapper_exits_255_on_uncaught_db_connect_failure(monkeypatch, capsys):
    monkeypatch.setattr(rms, 'load_config', lambda: _CONFIG)

    def _boom(cfg):
        raise RuntimeError('connection refused')

    monkeypatch.setattr(rms, 'Db', type('D', (), {'connect': staticmethod(_boom)}))
    monkeypatch.setattr(sys, 'argv', ['register_mock_stack.py', '5'])

    with pytest.raises(SystemExit) as ei:
        rms.run()
    assert ei.value.code == 255
    assert 'RuntimeError' in capsys.readouterr().err
