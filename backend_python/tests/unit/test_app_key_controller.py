from starlette.datastructures import Headers

from app.agent_team.controllers.app_key_controller import AppKeyController
from app.support.http import Ctx


class FakeDb:
    """Records queries; answers fetch_one/fetch_all from a canned queue."""
    def __init__(self, one=None, all_=None, rowcount=1, insert_id=5):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.rowcount = rowcount
        self.insert_id = insert_id
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        return self.insert_id


CONFIG = {'auth': {'app_key_secret': 'test-app-key-secret'}}


def ctx(body=None, query=None, user_id=3, auth_type='jwt', app_key_scopes=None, application_id=None):
    c = Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
            params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')
    c['auth_type'] = auth_type
    if app_key_scopes is not None:
        c['app_key_scopes'] = app_key_scopes
    if application_id is not None:
        c['application_id'] = application_id
    return c


def controller(db=None):
    return AppKeyController(db or FakeDb(), CONFIG)


ADMIN_ROW = {'role': 'admin'}
NON_ADMIN_ROW = {'role': 'user'}


# --- requireAdmin gate on every CRUD method --------------------------------

def test_create_app_key_scope_returns_403():
    db = FakeDb()
    r = controller(db).create(ctx(auth_type='app_key'))
    assert r == {'success': False, 'error': 'App keys cannot manage app keys', 'status_code': 403}
    assert not db.calls


def test_create_unauthenticated_returns_401():
    db = FakeDb()
    r = controller(db).create(ctx(user_id=None, auth_type='jwt'))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_create_user_id_zero_returns_401():
    db = FakeDb()
    r = controller(db).create(ctx(user_id=0, auth_type='jwt'))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_create_non_admin_returns_403():
    db = FakeDb(one=[NON_ADMIN_ROW])
    r = controller(db).create(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_create_no_user_row_returns_403():
    db = FakeDb(one=[None])
    r = controller(db).create(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_index_requires_admin():
    db = FakeDb(one=[NON_ADMIN_ROW])
    r = controller(db).index(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_destroy_requires_admin():
    db = FakeDb(one=[NON_ADMIN_ROW])
    r = controller(db).destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_list_user_workflows_requires_admin():
    db = FakeDb(one=[NON_ADMIN_ROW])
    r = controller(db).listUserWorkflows(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_list_user_agents_requires_admin():
    db = FakeDb(one=[NON_ADMIN_ROW])
    r = controller(db).listUserAgents(ctx())
    assert r == {'success': False, 'error': 'Admin access required', 'status_code': 403}


# --- create validation branches --------------------------------------------

def test_create_missing_user_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'application_id': 'app', 'name': 'k', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'user_id is required', 'status_code': 400}


def test_create_zero_user_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 0, 'application_id': 'app', 'name': 'k', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'user_id is required', 'status_code': 400}


def test_create_missing_application_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'name': 'k', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'application_id is required', 'status_code': 400}


def test_create_blank_application_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': '   ', 'name': 'k', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'application_id is required', 'status_code': 400}


def test_create_missing_name_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'name is required', 'status_code': 400}


def test_create_missing_scopes_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'name': 'k'}))
    assert r == {'success': False, 'error': 'scopes must be a non-empty array of strings', 'status_code': 400}


def test_create_empty_scopes_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'name': 'k', 'scopes': []}))
    assert r == {'success': False, 'error': 'scopes must be a non-empty array of strings', 'status_code': 400}


def test_create_non_array_scopes_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'name': 'k', 'scopes': 'x'}))
    assert r == {'success': False, 'error': 'scopes must be a non-empty array of strings', 'status_code': 400}


def test_create_blank_scope_string_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'name': 'k', 'scopes': ['ok', '  ']}))
    assert r == {'success': False, 'error': 'every scope must be a non-empty string', 'status_code': 400}


def test_create_non_string_scope_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).create(ctx(body={'user_id': 5, 'application_id': 'app', 'name': 'k', 'scopes': ['ok', 5]}))
    assert r == {'success': False, 'error': 'every scope must be a non-empty string', 'status_code': 400}


def test_create_user_id_does_not_exist_returns_400():
    db = FakeDb(one=[ADMIN_ROW, None])
    r = controller(db).create(ctx(body={'user_id': 999, 'application_id': 'app', 'name': 'k', 'scopes': ['a']}))
    assert r == {'success': False, 'error': 'user_id 999 does not exist', 'status_code': 400}


def test_create_success_returns_full_key_and_201():
    db = FakeDb(one=[ADMIN_ROW, {'id': 999}], insert_id=42)
    r = controller(db).create(
        ctx(body={'user_id': 999, 'application_id': 'app1', 'name': ' my key ', 'scopes': [' agents:run:1 ', 'x']}))
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['data']['id'] == 42
    assert r['data']['user_id'] == 999
    assert r['data']['application_id'] == 'app1'
    assert r['data']['name'] == 'my key'   # name is trimmed, mirrors PHP's trim()
    assert r['data']['scopes'] == ['agents:run:1', 'x']
    assert r['data']['full_key'].startswith('ak_')
    insert_call = next(p for s, p in db.calls if s.startswith('INSERT INTO app_keys'))
    assert insert_call[':scopes'] == '["agents:run:1","x"]'


def test_create_nbsp_padded_scope_survives_trim():
    # PHP trim() strips only its own byte charlist — NBSP (\xa0) is left alone,
    # unlike Python str.strip() which treats it as whitespace and would eat it.
    db = FakeDb(one=[ADMIN_ROW, {'id': 999}], insert_id=42)
    r = controller(db).create(
        ctx(body={'user_id': 999, 'application_id': 'app1', 'name': 'k',
                   'scopes': [' agents:run:1 ']}))
    assert r['success'] is True
    assert r['data']['scopes'] == [' agents:run:1 ']


def test_create_all_nbsp_scope_is_not_treated_as_empty():
    # mirrors PHP: trim("\xc2\xa0") !== '' — an all-NBSP scope is a non-empty
    # string to PHP's trim(), so it must pass validation, not be rejected.
    db = FakeDb(one=[ADMIN_ROW, {'id': 999}], insert_id=42)
    r = controller(db).create(
        ctx(body={'user_id': 999, 'application_id': 'app1', 'name': 'k', 'scopes': ['  ']}))
    assert r['success'] is True
    assert r['data']['scopes'] == ['  ']


# --- index shape -------------------------------------------------------------

def test_index_returns_repo_list_all():
    db = FakeDb(one=[ADMIN_ROW], all_=[[
        {'id': 1, 'user_id': 3, 'application_id': 'app', 'name': 'k', 'key_prefix': 'ak_abc', 'scopes': '["x"]',
         'created_at': '2026-01-01 00:00:00', 'last_used_at': None, 'revoked_at': None},
    ]])
    r = controller(db).index(ctx())
    assert r == {
        'success': True,
        'status_code': 200,
        'data': [{'id': 1, 'user_id': 3, 'application_id': 'app', 'name': 'k', 'key_prefix': 'ak_abc',
                  'scopes': ['x'], 'created_at': '2026-01-01 00:00:00', 'last_used_at': None, 'revoked_at': None}],
    }


def test_index_filters_by_application_id_and_user_id():
    db = FakeDb(one=[ADMIN_ROW], all_=[[]])
    controller(db).index(ctx(query={'application_id': 'app1', 'user_id': '9'}))
    sql, params = db.calls[-1]
    assert 'AND application_id = :application_id' in sql
    assert 'AND user_id = :user_id' in sql
    assert params == {':application_id': 'app1', ':user_id': 9}


def test_index_no_filters_when_query_empty():
    db = FakeDb(one=[ADMIN_ROW], all_=[[]])
    controller(db).index(ctx())
    sql, params = db.calls[-1]
    assert 'AND application_id' not in sql
    assert 'AND user_id' not in sql
    assert params == {}


# --- destroy not-found -------------------------------------------------------

def test_destroy_invalid_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).destroy(ctx(), 0)
    assert r == {'success': False, 'error': 'Invalid key id', 'status_code': 400}


def test_destroy_not_found_returns_404():
    db = FakeDb(one=[ADMIN_ROW, None])
    r = controller(db).destroy(ctx(), 123)
    assert r == {'success': False, 'error': 'App key not found', 'status_code': 404}


def test_destroy_success_revokes():
    db = FakeDb(
        one=[ADMIN_ROW, {'id': 5, 'user_id': 3, 'application_id': 'app', 'name': 'k', 'key_prefix': 'p',
                          'scopes': '[]', 'created_at': 'x', 'last_used_at': None, 'revoked_at': None}],
        rowcount=1,
    )
    r = controller(db).destroy(ctx(), 5)
    assert r == {'success': True, 'data': {'id': 5, 'revoked': True}, 'status_code': 200}


def test_destroy_already_revoked_reports_revoked_false():
    db = FakeDb(
        one=[ADMIN_ROW, {'id': 5, 'user_id': 3, 'application_id': 'app', 'name': 'k', 'key_prefix': 'p',
                          'scopes': '[]', 'created_at': 'x', 'last_used_at': None, 'revoked_at': 'x'}],
        rowcount=0,
    )
    r = controller(db).destroy(ctx(), 5)
    assert r == {'success': True, 'data': {'id': 5, 'revoked': False}, 'status_code': 200}


# --- listUserWorkflows / listUserAgents -------------------------------------

def test_list_user_workflows_missing_user_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).listUserWorkflows(ctx())
    assert r == {'success': False, 'error': 'user_id query parameter is required', 'status_code': 400}


def test_list_user_workflows_success():
    db = FakeDb(one=[ADMIN_ROW], all_=[[{'id': 1, 'name': 'wf-a'}, {'id': 2, 'name': 'wf-b'}]])
    r = controller(db).listUserWorkflows(ctx(query={'user_id': '9'}))
    assert r == {'success': True, 'status_code': 200,
                'data': [{'id': 1, 'name': 'wf-a'}, {'id': 2, 'name': 'wf-b'}]}
    sql, params = db.calls[-1]
    assert sql == 'SELECT id, name FROM agent_workflows WHERE user_id = ? ORDER BY name ASC'
    assert params == [9]


def test_list_user_agents_missing_user_id_returns_400():
    db = FakeDb(one=[ADMIN_ROW])
    r = controller(db).listUserAgents(ctx())
    assert r == {'success': False, 'error': 'user_id query parameter is required', 'status_code': 400}


def test_list_user_agents_success():
    db = FakeDb(one=[ADMIN_ROW], all_=[[{'id': 3, 'name': 'agent-a'}]])
    r = controller(db).listUserAgents(ctx(query={'user_id': '9'}))
    assert r == {'success': True, 'status_code': 200, 'data': [{'id': 3, 'name': 'agent-a'}]}
    sql, params = db.calls[-1]
    assert sql == 'SELECT id, name FROM agents WHERE user_id = ? ORDER BY name ASC'
    assert params == [9]


# --- whoami: jwt vs app-key auth types --------------------------------------

def test_whoami_jwt_auth_returns_401():
    db = FakeDb()
    r = controller(db).whoami(ctx(auth_type='jwt'))
    assert r == {'success': False, 'error': 'This endpoint requires app-key authentication', 'status_code': 401}
    assert not db.calls


def test_whoami_unauthenticated_returns_401():
    db = FakeDb()
    r = controller(db).whoami(ctx(user_id=None, auth_type=None))
    assert r == {'success': False, 'error': 'This endpoint requires app-key authentication', 'status_code': 401}


def test_whoami_app_key_resolves_workflow_and_agent_names():
    db = FakeDb(all_=[
        [{'id': 1, 'name': 'wf-a'}],
        [{'id': 2, 'name': 'agent-a'}],
    ])
    r = controller(db).whoami(ctx(
        auth_type='app_key', application_id='app1',
        app_key_scopes=['workflows:run:1', 'agents:run:2', 'other:scope'],
    ))
    assert r == {
        'success': True,
        'status_code': 200,
        'data': {
            'application_id': 'app1',
            'scopes': ['workflows:run:1', 'agents:run:2', 'other:scope'],
            'workflows': [{'id': 1, 'name': 'wf-a'}],
            'agents': [{'id': 2, 'name': 'agent-a'}],
        },
    }


def test_whoami_app_key_no_matching_scopes_returns_empty_lists():
    db = FakeDb()
    r = controller(db).whoami(ctx(auth_type='app_key', application_id='app1', app_key_scopes=['other:scope']))
    assert r['data']['workflows'] == []
    assert r['data']['agents'] == []
    assert not db.calls


# --- resolveNames SQL for both tables ---------------------------------------

def test_resolve_names_sql_for_agent_workflows_table():
    db = FakeDb(all_=[[{'id': 1, 'name': 'wf-a'}]])
    result = controller(db)._resolve_names('agent_workflows', [1])
    assert result == [{'id': 1, 'name': 'wf-a'}]
    sql, params = db.calls[-1]
    assert sql == 'SELECT id, name FROM agent_workflows WHERE id IN (?) ORDER BY name ASC'
    assert params == [1]


def test_resolve_names_sql_for_agents_table():
    db = FakeDb(all_=[[{'id': 2, 'name': 'agent-a'}]])
    result = controller(db)._resolve_names('agents', [2])
    assert result == [{'id': 2, 'name': 'agent-a'}]
    sql, params = db.calls[-1]
    assert sql == 'SELECT id, name FROM agents WHERE id IN (?) ORDER BY name ASC'
    assert params == [2]


def test_resolve_names_empty_ids_skips_query():
    db = FakeDb()
    assert controller(db)._resolve_names('agents', []) == []
    assert controller(db)._resolve_names('agents', [0, -1]) == []
    assert not db.calls


def test_resolve_names_dedupes_preserving_first_occurrence():
    db = FakeDb(all_=[[{'id': 1, 'name': 'a'}, {'id': 2, 'name': 'b'}]])
    controller(db)._resolve_names('agents', [1, 2, 1, -5, 0])
    sql, params = db.calls[-1]
    assert sql == 'SELECT id, name FROM agents WHERE id IN (?,?) ORDER BY name ASC'
    assert params == [1, 2]
