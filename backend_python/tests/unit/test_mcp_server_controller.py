"""MCPServerController unit tests — PHP-truth strings and byte-identical SQL.

PHP source: backend/src/Controllers/MCPServerController.php (15-721).
The `normalizeTransport` / `deriveServerType` cases are a straight port of the
PHP oracle backend/tests/Unit/McpServerTransportTest.php.
"""
import pymysql
import pytest
from starlette.datastructures import Headers

from app.controllers.mcp_server_controller import MCPServerController, _filter_validate_url
from app.support.http import Ctx

CONFIG = {'auth': {'jwt_secret': 'test-jwt-secret'}}

ALL_TABLES = ('mcp_servers', 'mcp_server_tools', 'user_mcp_settings')


class FakeDb:
    """Records every statement so the tests can assert SQL byte-for-byte.

    PackageResolver's own two queries (`users`, `packages`) are answered from
    `role`/`capabilities` so the queued `one`/`all_` values stay aligned with
    the controller's own reads.
    """

    def __init__(self, one=None, all_=None, rowcount=1, tables=ALL_TABLES,
                 role='admin', capabilities='{"mcp_servers":null}', lastrowid=42, insert_error=None):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.tables = set(tables)
        self.role = role
        self.capabilities = capabilities
        self.lastrowid = lastrowid
        self.insert_error = insert_error
        self.calls = []

    def _presence(self, sql):
        if sql.startswith('SHOW TABLES LIKE '):
            name = sql.split("'")[1]
            return [{'x': name}] if name in self.tables else []
        return None

    def _resolver(self, sql):
        if 'FROM users WHERE id' in sql:
            return {'role': self.role}
        if 'FROM packages WHERE role' in sql:
            return {'capabilities': self.capabilities, 'updated_at': None}
        return None

    def fetch_all(self, sql, params=None):
        p = self._presence(sql)
        if p is not None:
            return p
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        r = self._resolver(sql)
        if r is not None:
            return r
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        if self.insert_error is not None:
            raise self.insert_error
        return self.lastrowid


def ctx(body=None, user_id=3, query=None, method='POST'):
    return Ctx(method=method, uri='/', headers=Headers({}), query=query or {},
               body=body if body is not None else {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


def c(db=None, config=None):
    return MCPServerController(db if db is not None else FakeDb(), config if config is not None else CONFIG)


def sqls(db):
    return [s for s, _ in db.calls]


# ─── ported PHP oracle: McpServerTransportTest.php ─────────────────────────

def test_normalize_transport_defaults_to_http():
    assert MCPServerController.normalizeTransport(None) == 'http'
    assert MCPServerController.normalizeTransport('') == 'http'
    assert MCPServerController.normalizeTransport('  ') == 'http'


def test_normalize_transport_accepts_known_values():
    assert MCPServerController.normalizeTransport('http') == 'http'
    assert MCPServerController.normalizeTransport('sse') == 'sse'
    assert MCPServerController.normalizeTransport(' SSE ') == 'sse'


def test_normalize_transport_rejects_unknown():
    assert MCPServerController.normalizeTransport('stdio') is None
    assert MCPServerController.normalizeTransport(42) is None
    assert MCPServerController.normalizeTransport(['sse']) is None
    # is_string() also rejects bools and floats (PHP 38-45).
    assert MCPServerController.normalizeTransport(True) is None
    assert MCPServerController.normalizeTransport(1.5) is None


def test_derive_server_type():
    assert MCPServerController.deriveServerType(0) == 'mcp'
    assert MCPServerController.deriveServerType(1) == 'mcp_app'
    assert MCPServerController.deriveServerType(7) == 'mcp_app'


# ─── filter_var($url, FILTER_VALIDATE_URL) — probed against the live PHP 8 ──

@pytest.mark.parametrize('url,expected', [
    ('http://127.0.0.1:1/mcp', True),
    ('not a url', False),
    ('ftp://example.com/x', True),
    ('http://', False),
    ('http://exa mple.com', False),
    ('https://example.com', True),
    ('mailto:a@b.c', True),
    ('example.com', False),
    ('http://ex_ample.com/p', False),
    ('//example.com/x', False),
    ('http://example.com./', True),
    ('http://[::1]:8080/', True),
    ('javascript:alert(1)', False),
    ('http://exämple.com', False),
    ('http://ex~ample.com', False),
    ('http://exam-ple.com', True),
    ('http://-example.com', False),
    ('http://user:pass@example.com/', True),
    ('http://example.com:80/', True),
    ('http://EXAMPLE.com', True),
    ('HTTP://ex_ample.com', False),
    ('http:', False),
    ('file:/tmp/x', True),
    ('news:comp.lang', True),
    ('http://example.com?q=1', True),
    ('sse://x', True),
    ('http://127.0.0.1:1/mcp?a=b#c', True),
])
def test_filter_validate_url_matches_php(url, expected):
    assert _filter_validate_url(url) is expected


# ─── ensure*TableExists: presence checks only, never DDL (constraints.md §3) ─

def test_ensure_tables_exist_logs_missing_and_issues_no_ddl(monkeypatch):
    msgs = []
    monkeypatch.setattr('app.controllers.mcp_server_controller.error_log', msgs.append)
    db = FakeDb(tables=())
    c(db)
    assert msgs == ['[MCPServerController] mcp_servers missing — PHP creates it on demand',
                    '[MCPServerController] mcp_server_tools missing — PHP creates it on demand',
                    '[MCPServerController] user_mcp_settings missing — PHP creates it on demand']
    assert sqls(db) == []          # no CREATE TABLE, no ALTER


def test_ensure_tables_exist_is_silent_and_ddl_free_when_present(monkeypatch):
    msgs = []
    monkeypatch.setattr('app.controllers.mcp_server_controller.error_log', msgs.append)
    db = FakeDb()
    c(db)
    assert msgs == []
    assert sqls(db) == []


# ─── list() (PHP 63-113) ───────────────────────────────────────────────────

LIST_SQL_UID = """
            SELECT s.*,
                   COUNT(t.id) as tool_count,
                   SUM(CASE WHEN t.has_ui = 1 THEN 1 ELSE 0 END) as ui_tool_count
            FROM mcp_servers s
            LEFT JOIN mcp_server_tools t ON s.id = t.server_id
            WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = :uid)
            GROUP BY s.id
            ORDER BY s.name ASC
        """


def _server_row(**kw):
    row = {'id': 24, 'user_id': None, 'name': 'Metals News', 'url': 'http://localhost/metals/public/mcp',
           'description': None, 'headers': None, 'transport': 'http', 'enabled': 1, 'is_mock': 0,
           'tool_count': 2, 'ui_tool_count': '0'}
    row.update(kw)
    return row


def test_list_sql_and_shaping():
    db = FakeDb(all_=[[_server_row()], []])
    out = c(db).list(ctx(method='GET'))
    assert sqls(db)[0] == LIST_SQL_UID
    assert db.calls[0][1] == {':uid': '3'}
    s = out['servers'][0]
    assert (s['tool_count'], s['ui_tool_count'], s['enabled'], s['is_mock']) == (2, 0, 1, 0)
    assert s['transport'] == 'http'
    assert s['server_type'] == 'mcp'
    assert s['headers'] is None
    assert out['success'] is True and out['status_code'] == 200


def test_list_include_disabled_swaps_the_enabled_clause():
    db = FakeDb(all_=[[], []])
    c(db).list(ctx(method='GET', query={'include_disabled': '1'}))
    assert 'WHERE 1=1 AND (s.user_id IS NULL OR s.user_id = :uid)' in sqls(db)[0]


def test_list_without_user_id_drops_the_uid_clause_and_params():
    db = FakeDb(all_=[[], []])
    c(db).list(Ctx(method='GET', uri='/', headers=Headers({}), query={}, body={}, raw_body='',
                   params={}, user_id=None, authenticated=False, remote_addr=''))
    assert 'WHERE s.enabled = 1 AND (s.user_id IS NULL)' in sqls(db)[0]
    assert db.calls[0][1] is None


def test_list_hides_global_headers_but_decodes_private_ones():
    rows = [_server_row(id=1, user_id=None, name='glob', headers='{"Authorization":"secret"}'),
            _server_row(id=2, user_id='3', name='mine', headers='{"X-Key":"v"}', ui_tool_count='1')]
    db = FakeDb(all_=[rows, []])
    out = c(db).list(ctx(method='GET'))
    assert out['servers'][0]['headers'] is None
    assert out['servers'][1]['headers'] == {'X-Key': 'v'}
    assert out['servers'][1]['server_type'] == 'mcp_app'


def test_list_private_headers_falsy_json_becomes_null():
    """PHP `json_decode(...) ?: null` — `[]`/`{}`/invalid all collapse to null."""
    rows = [_server_row(id=2, user_id='3', name='mine', headers='{}'),
            _server_row(id=3, user_id='3', name='other', headers='nope')]
    db = FakeDb(all_=[rows, []])
    out = c(db).list(ctx(method='GET'))
    assert out['servers'][0]['headers'] is None
    assert out['servers'][1]['headers'] is None


def test_list_applies_the_package_allowlist_to_globals_only():
    rows = [_server_row(id=1, user_id=None, name='denied'),
            _server_row(id=2, user_id=None, name='ok'),
            _server_row(id=3, user_id='3', name='private')]
    db = FakeDb(all_=[rows, []], capabilities='{"mcp_servers":["ok"]}')
    out = c(db).list(ctx(method='GET'))
    assert [s['name'] for s in out['servers']] == ['ok', 'private']


def test_list_per_user_override_wins_over_the_allowlist():
    rows = [_server_row(id=1, user_id=None, name='ok'),
            _server_row(id=3, user_id='3', name='private')]
    db = FakeDb(all_=[rows, [{'server_id': 3, 'allowed': 0}]], capabilities='{"mcp_servers":["ok"]}')
    out = c(db).list(ctx(method='GET'))
    assert [s['name'] for s in out['servers']] == ['ok']
    assert db.calls[1][0] == 'SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?'
    assert db.calls[1][1] == [3]


def test_list_cascade_fails_open(monkeypatch):
    rows = [_server_row(id=1, user_id=None, name='ok')]
    db = FakeDb(all_=[rows])

    def boom(sql, params=None):
        raise RuntimeError('nope')

    controller = c(db)
    monkeypatch.setattr(db, 'fetch_all', boom)
    assert controller.applyPackageAllowlist(rows, '3') == rows


# ─── getTools() (PHP 198-255) ──────────────────────────────────────────────

GET_TOOLS_SQL = """
            SELECT * FROM mcp_server_tools WHERE server_id = ? ORDER BY tool_name ASC
        """


def test_get_tools_without_server_id_returns_empty_list():
    db = FakeDb()
    out = c(db).getTools(ctx(method='GET'))
    assert out == {'success': True, 'tools': [], 'status_code': 200}
    assert sqls(db) == []


def test_get_tools_unknown_server_is_404():
    db = FakeDb(one=[None])
    out = c(db).getTools(ctx(method='GET', query={'server_id': '99'}))
    assert out == {'success': False, 'error': 'Server not found', 'status_code': 404}
    assert db.calls[0][0] == ('SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND enabled = 1 '
                              'AND (user_id IS NULL OR user_id = ?)')
    assert db.calls[0][1] == ['99', '3']


def test_get_tools_denied_by_override_is_404():
    db = FakeDb(one=[{'id': 24, 'name': 'Metals News', 'user_id': None}, {'allowed': 0}])
    out = c(db).getTools(ctx(method='GET', query={'server_id': '24'}))
    assert out == {'success': False, 'error': 'Server not found', 'status_code': 404}
    assert db.calls[1][0] == 'SELECT allowed FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?'
    assert db.calls[1][1] == [3, 24]


def test_get_tools_decodes_input_schema():
    db = FakeDb(one=[{'id': 24, 'name': 'Metals News', 'user_id': None}, None],
                all_=[[{'id': 1, 'tool_name': 'x', 'input_schema': '{"type":"object"}'},
                       {'id': 2, 'tool_name': 'y', 'input_schema': None}]])
    out = c(db).getTools(ctx(method='GET', query={'server_id': '24'}))
    assert out['tools'][0]['input_schema'] == {'type': 'object'}
    assert out['tools'][1]['input_schema'] is None
    assert sqls(db)[-1] == GET_TOOLS_SQL
    assert db.calls[-1][1] == ['24']


# ─── getAllTools() (PHP 260-296) ───────────────────────────────────────────

ALL_TOOLS_SQL = (
    "SELECT t.*, s.name as server_name, s.url as server_url, s.user_id as server_user_id\n"
    "                FROM mcp_server_tools t\n"
    "                JOIN mcp_servers s ON t.server_id = s.id\n"
    "                WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = :uid)\n"
    "                ORDER BY s.name ASC, t.tool_name ASC")


def test_get_all_tools_sql_decode_and_cascade():
    rows = [{'server_id': 1, 'tool_name': 'a', 'input_schema': '{"a":1}', 'server_name': 'ok', 'server_user_id': None},
            {'server_id': 2, 'tool_name': 'b', 'input_schema': None, 'server_name': 'denied', 'server_user_id': None}]
    db = FakeDb(all_=[rows], one=[None, None], capabilities='{"mcp_servers":["ok"]}')
    out = c(db).getAllTools(ctx(method='GET'))
    assert sqls(db)[0] == ALL_TOOLS_SQL
    assert db.calls[0][1] == {':uid': '3'}
    assert [t['tool_name'] for t in out['tools']] == ['a']
    assert out['tools'][0]['input_schema'] == {'a': 1}


# ─── create() (PHP 301-366) ────────────────────────────────────────────────

CREATE_SQL = """
                INSERT INTO mcp_servers (user_id, name, url, description, headers, transport)
                VALUES (?, ?, ?, ?, ?, ?)
            """


def test_create_invalid_transport():
    out = c().create(ctx(body={'name': 'n', 'url': 'http://a.com', 'transport': 'stdio'}))
    assert out == {'success': False, 'error': 'Invalid transport (expected "http" or "sse")', 'status_code': 400}


def test_create_requires_name_and_url():
    err = {'success': False, 'error': 'Name and URL are required', 'status_code': 400}
    assert c().create(ctx(body={'url': 'http://a.com'})) == err
    assert c().create(ctx(body={'name': '  ', 'url': 'http://a.com'})) == err
    assert c().create(ctx(body={'name': 'n'})) == err


def test_create_invalid_url():
    out = c().create(ctx(body={'name': 'n', 'url': 'not a url'}))
    assert out == {'success': False, 'error': 'Invalid URL format', 'status_code': 400}


def test_create_inserts_and_returns_a_string_id():
    db = FakeDb(lastrowid=42)
    out = c(db).create(ctx(body={'name': ' n ', 'url': 'http://127.0.0.1:1/mcp', 'description': ' d ',
                                 'headers': {'A': 'b'}, 'transport': 'SSE'}))
    assert sqls(db)[0] == CREATE_SQL
    assert db.calls[0][1] == [3, 'n', 'http://127.0.0.1:1/mcp', 'd', '{"A":"b"}', 'sse']
    # PDO::lastInsertId() is a string, so json_encode quotes it.
    assert out == {'success': True, 'server_id': '42', 'message': 'Server added successfully', 'status_code': 200}


def test_create_empty_headers_object_stores_null():
    db = FakeDb()
    c(db).create(ctx(body={'name': 'n', 'url': 'http://a.com', 'headers': {}}))
    assert db.calls[0][1][4] is None


def test_create_duplicate_name_is_409():
    db = FakeDb(insert_error=pymysql.err.IntegrityError(1062, "Duplicate entry 'n' for key 'unique_server_name'"))
    out = c(db).create(ctx(body={'name': 'n', 'url': 'http://a.com'}))
    assert out == {'success': False, 'error': 'A server with this name already exists', 'status_code': 409}


def test_create_non_integrity_errors_propagate():
    db = FakeDb(insert_error=pymysql.err.OperationalError(1146, "Table 'mcp_servers' doesn't exist"))
    with pytest.raises(pymysql.err.OperationalError):
        c(db).create(ctx(body={'name': 'n', 'url': 'http://a.com'}))


# ─── update() (PHP 371-448) ────────────────────────────────────────────────

def test_update_requires_server_id():
    out = c().update(ctx(body={'name': 'n', 'url': 'http://a.com'}))
    assert out == {'success': False, 'error': 'Server ID required', 'status_code': 400}


def test_update_requires_name_and_url():
    out = c().update(ctx(body={'server_id': 5, 'name': '', 'url': 'http://a.com'}))
    assert out == {'success': False, 'error': 'Name and URL are required', 'status_code': 400}


def test_update_invalid_transport():
    out = c().update(ctx(body={'server_id': 5, 'name': 'n', 'url': 'http://a.com', 'transport': 'stdio'}))
    assert out == {'success': False, 'error': 'Invalid transport (expected "http" or "sse")', 'status_code': 400}


def test_update_omits_untouched_columns():
    db = FakeDb(rowcount=1)
    out = c(db).update(ctx(body={'server_id': 5, 'name': 'n', 'url': 'http://a.com', 'description': 'd'}))
    assert sqls(db)[0] == 'UPDATE mcp_servers SET name = ?, url = ?, description = ? WHERE id = ? AND user_id = ?'
    assert db.calls[0][1] == ['n', 'http://a.com', 'd', 5, 3]
    assert sqls(db)[1] == 'DELETE FROM mcp_server_tools WHERE server_id = ?'
    assert out == {'success': True, 'message': 'Server updated successfully', 'status_code': 200}


def test_update_sets_transport_and_headers_when_present():
    db = FakeDb(rowcount=1)
    c(db).update(ctx(body={'server_id': 5, 'name': 'n', 'url': 'http://a.com',
                           'transport': 'sse', 'headers': None}))
    assert sqls(db)[0] == ('UPDATE mcp_servers SET name = ?, url = ?, description = ?, transport = ?, headers = ? '
                           'WHERE id = ? AND user_id = ?')
    assert db.calls[0][1] == ['n', 'http://a.com', '', 'sse', None, 5, 3]


def test_update_not_found():
    db = FakeDb(rowcount=0)
    out = c(db).update(ctx(body={'server_id': 5, 'name': 'n', 'url': 'http://a.com'}))
    assert out == {'success': False, 'error': 'Server not found', 'status_code': 404}
    assert len(db.calls) == 1          # the cached-tool DELETE never runs


# ─── toggle() (PHP 453-479) ────────────────────────────────────────────────

TOGGLE_SQL = """
            UPDATE mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?
        """


def test_toggle_requires_server_id():
    out = c().toggle(ctx(body={'enabled': False}))
    assert out == {'success': False, 'error': 'Server ID required', 'status_code': 400}


def test_toggle_defaults_to_enabled():
    db = FakeDb()
    out = c(db).toggle(ctx(body={'server_id': 5}))
    assert sqls(db)[0] == TOGGLE_SQL
    assert db.calls[0][1] == [1, 5, 3]
    assert out == {'success': True, 'message': 'Server enabled', 'status_code': 200}


def test_toggle_disable_is_a_success_even_for_a_foreign_server():
    """PHP never checks rowCount here (453-479), so a non-owned id still 200s."""
    db = FakeDb(rowcount=0)
    out = c(db).toggle(ctx(body={'server_id': 24, 'enabled': False}))
    assert db.calls[0][1] == [0, 24, 3]
    assert out == {'success': True, 'message': 'Server disabled', 'status_code': 200}


# ─── delete() (PHP 484-515) ────────────────────────────────────────────────

DELETE_SQL = """
            DELETE FROM mcp_servers WHERE id = ? AND user_id = ?
        """


def test_delete_requires_server_id():
    out = c().delete(ctx(method='DELETE'))
    assert out == {'success': False, 'error': 'Server ID required', 'status_code': 400}


def test_delete_foreign_server_is_404():
    db = FakeDb(rowcount=0)
    out = c(db).delete(ctx(method='DELETE', query={'server_id': '24'}))
    assert sqls(db)[0] == DELETE_SQL
    assert db.calls[0][1] == ['24', 3]
    assert out == {'success': False, 'error': 'Server not found', 'status_code': 404}


def test_delete_success():
    db = FakeDb(rowcount=1)
    out = c(db).delete(ctx(method='DELETE', query={'server_id': '24'}))
    assert out == {'success': True, 'message': 'Server deleted successfully', 'status_code': 200}


# ─── isMasterEnabled / setMasterSetting (PHP 518-548) ──────────────────────

MASTER_SQL = """
            INSERT INTO user_mcp_settings (user_id, mcp_enabled) VALUES (:uid, :en)
            ON DUPLICATE KEY UPDATE mcp_enabled = VALUES(mcp_enabled), updated_at = CURRENT_TIMESTAMP
        """


def test_is_master_enabled_defaults_true_and_reads_the_row():
    db = FakeDb(one=[None])
    assert c(db).isMasterEnabled(3) is True
    assert db.calls[0] == ('SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ?', [3])
    assert c(FakeDb(one=[{'mcp_enabled': 0}])).isMasterEnabled(3) is False
    assert c(FakeDb(one=[{'mcp_enabled': 1}])).isMasterEnabled(3) is True


def test_is_master_enabled_fails_open_on_db_error(monkeypatch):
    db = FakeDb()
    controller = c(db)

    def boom(sql, params=None):
        raise pymysql.err.ProgrammingError(1146, "Table doesn't exist")

    monkeypatch.setattr(db, 'fetch_one', boom)
    assert controller.isMasterEnabled(3) is True


def test_set_master_setting_requires_auth():
    out = c().setMasterSetting(ctx(body={'mcp_enabled': True}, user_id=0))
    assert out == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_set_master_setting_requires_the_field():
    out = c().setMasterSetting(ctx(body={}))
    assert out == {'success': False, 'error': 'Field "mcp_enabled" is required (boolean).', 'status_code': 400}


def test_set_master_setting_upsert_sql():
    db = FakeDb()
    out = c(db).setMasterSetting(ctx(body={'mcp_enabled': False}))
    assert sqls(db)[0] == MASTER_SQL
    assert db.calls[0][1] == {':uid': 3, ':en': 0}
    assert out == {'success': True, 'mcp_enabled': False, 'status_code': 200}

    db = FakeDb()
    out = c(db).setMasterSetting(ctx(body={'mcp_enabled': 1}))
    assert db.calls[0][1] == {':uid': 3, ':en': 1}
    assert out['mcp_enabled'] is True


# ─── listMine() (PHP 564-623) ──────────────────────────────────────────────

LIST_MINE_SQL = (
    "SELECT s.id, s.name, s.url, s.user_id, s.enabled, s.is_mock, COUNT(t.id) AS tool_count\n"
    "                FROM mcp_servers s\n"
    "                LEFT JOIN mcp_server_tools t ON t.server_id = s.id\n"
    "                WHERE s.user_id IS NULL OR s.user_id = :uid\n"
    "                GROUP BY s.id\n"
    "                ORDER BY (s.user_id IS NULL) DESC, s.name ASC")


def test_list_mine_requires_auth():
    out = c().listMine(ctx(user_id=None, method='GET'))
    assert out == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_list_mine_shapes_rows_and_applies_overrides():
    rows = [{'id': 1, 'name': 'glob', 'url': 'u1', 'user_id': None, 'enabled': 1, 'is_mock': 0, 'tool_count': 3},
            {'id': 2, 'name': 'off', 'url': 'u2', 'user_id': None, 'enabled': 1, 'is_mock': 0, 'tool_count': 0},
            {'id': 3, 'name': 'mine', 'url': 'u3', 'user_id': '3', 'enabled': 0, 'is_mock': 1, 'tool_count': 1}]
    db = FakeDb(all_=[rows, [{'server_id': 2, 'allowed': 0}]], one=[{'mcp_enabled': 1}])
    out = c(db).listMine(ctx(method='GET'))
    assert sqls(db)[0] == LIST_MINE_SQL
    assert db.calls[0][1] == {':uid': '3'}
    assert db.calls[1] == ('SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?', [3])
    assert out['mcp_enabled'] is True
    assert out['servers'] == [
        {'id': 1, 'name': 'glob', 'url': 'u1', 'is_global': True, 'is_mock': False,
         'tool_count': 3, 'effective_on': True},
        {'id': 2, 'name': 'off', 'url': 'u2', 'is_global': True, 'is_mock': False,
         'tool_count': 0, 'effective_on': False},
        # private: `enabled` decides, the override is ignored (PHP 601-605)
        {'id': 3, 'name': 'mine', 'url': 'u3', 'is_global': False, 'is_mock': True,
         'tool_count': 1, 'effective_on': False},
    ]


def test_list_mine_drops_package_denied_globals():
    rows = [{'id': 1, 'name': 'ok', 'url': 'u1', 'user_id': None, 'enabled': 1, 'is_mock': 0, 'tool_count': 0},
            {'id': 2, 'name': 'denied', 'url': 'u2', 'user_id': None, 'enabled': 1, 'is_mock': 0, 'tool_count': 0},
            {'id': 3, 'name': 'mine', 'url': 'u3', 'user_id': '3', 'enabled': 1, 'is_mock': 0, 'tool_count': 0}]
    db = FakeDb(all_=[rows, []], one=[None], capabilities='{"mcp_servers":["ok"]}')
    out = c(db).listMine(ctx(method='GET'))
    assert [s['name'] for s in out['servers']] == ['ok', 'mine']


# ─── findVisibleServer / setMyOverride / clearMyOverride (PHP 626-674) ─────

FIND_SQL = 'SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?)'
OVERRIDE_SQL = """
            INSERT INTO user_mcp_overrides (user_id, server_id, allowed) VALUES (:uid, :sid, 0)
            ON DUPLICATE KEY UPDATE allowed = 0, updated_at = CURRENT_TIMESTAMP
        """


def test_find_visible_server_returns_none_for_a_foreign_row():
    db = FakeDb(one=[None])
    assert c(db).findVisibleServer(3, 99) is None
    assert db.calls[0] == (FIND_SQL, [99, 3])


def test_find_visible_server_honours_the_allowlist():
    db = FakeDb(one=[{'id': 1, 'name': 'denied', 'user_id': None}], capabilities='{"mcp_servers":["ok"]}')
    assert c(db).findVisibleServer(3, 1) is None
    db = FakeDb(one=[{'id': 1, 'name': 'mine', 'user_id': '3'}], capabilities='{"mcp_servers":["ok"]}')
    assert c(db).findVisibleServer(3, 1) == {'id': 1, 'name': 'mine', 'user_id': '3'}


def test_set_my_override_requires_auth():
    out = c().setMyOverride(ctx(body={'allowed': False}, user_id=0), 24)
    assert out == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_set_my_override_requires_the_field():
    out = c().setMyOverride(ctx(body={}), 24)
    assert out == {'success': False, 'error': 'Field "allowed" is required (boolean).', 'status_code': 400}


def test_set_my_override_is_deny_only():
    out = c().setMyOverride(ctx(body={'allowed': True}), 24)
    assert out == {'success': False,
                   'error': 'Only disabling is allowed here; DELETE the override to re-enable.',
                   'status_code': 400}


def test_set_my_override_unknown_server_is_404():
    db = FakeDb(one=[None])
    out = c(db).setMyOverride(ctx(body={'allowed': False}), 99)
    assert out == {'success': False, 'error': 'MCP server not available to you', 'status_code': 404}


def test_set_my_override_upsert_sql():
    db = FakeDb(one=[{'id': 24, 'name': 'Metals News', 'user_id': None}])
    out = c(db).setMyOverride(ctx(body={'allowed': False}), 24)
    assert sqls(db)[1] == OVERRIDE_SQL
    assert db.calls[1][1] == {':uid': 3, ':sid': 24}
    assert out == {'success': True, 'server_id': 24, 'allowed': False, 'status_code': 200}


def test_clear_my_override_requires_auth():
    out = c().clearMyOverride(ctx(user_id=0, method='DELETE'), 24)
    assert out == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_clear_my_override_reports_whether_a_row_went():
    db = FakeDb(rowcount=1)
    out = c(db).clearMyOverride(ctx(method='DELETE'), 24)
    assert db.calls[0] == ('DELETE FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?', [3, 24])
    assert out == {'success': True, 'server_id': 24, 'cleared': True, 'status_code': 200}

    db = FakeDb(rowcount=0)
    assert c(db).clearMyOverride(ctx(method='DELETE'), 24)['cleared'] is False


# ─── isServerEffective / serverAllowedForUser branches (PHP 120-193, 551-561) ─

def test_is_server_effective_override_wins():
    db = FakeDb(one=[{'allowed': 0}])
    assert c(db).isServerEffective(24, 'Metals News', False, 3) is False
    db = FakeDb(one=[{'allowed': 1}], capabilities='{"mcp_servers":[]}')
    assert c(db).isServerEffective(24, 'Metals News', False, 3) is True


def test_is_server_effective_private_always_passes():
    db = FakeDb(one=[None], capabilities='{"mcp_servers":[]}')
    assert c(db).isServerEffective(24, 'anything', True, 3) is True


def test_is_server_effective_allowlist_gate():
    db = FakeDb(one=[None], capabilities='{"mcp_servers":["ok"]}')
    assert c(db).isServerEffective(24, 'ok', False, 3) is True
    db = FakeDb(one=[None], capabilities='{"mcp_servers":["ok"]}')
    assert c(db).isServerEffective(24, 'nope', False, 3) is False
    db = FakeDb(one=[None], capabilities='{"mcp_servers":["ok"]}')
    assert c(db).isServerEffective(24, None, False, 3) is False


def test_is_server_effective_anonymous_skips_the_override_lookup():
    db = FakeDb(capabilities='{"mcp_servers":null}')
    assert c(db).isServerEffective(24, 'x', False, None) is True
    assert sqls(db) == []


def test_is_server_effective_fails_open(monkeypatch):
    db = FakeDb()
    controller = c(db)
    monkeypatch.setattr(db, 'fetch_one', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    assert controller.isServerEffective(24, 'x', False, 3) is True


def test_server_allowed_for_user_branches():
    controller = c()
    assert controller.serverAllowedForUser({'user_id': '3', 'name': 'mine'}, ['other']) is True
    assert controller.serverAllowedForUser({'user_id': None, 'name': 'glob'}, None) is True
    assert controller.serverAllowedForUser({'user_id': None, 'name': 'glob'}, ['glob']) is True
    assert controller.serverAllowedForUser({'user_id': None, 'name': 'glob'}, ['other']) is False
