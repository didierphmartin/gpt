"""Unit tests for TeamController + WorkflowSchemaController (Phase 4, Task 4).

Port of backend/src/AgentTeam/Controllers/TeamController.php (373 lines) and
WorkflowSchemaController.php (221 lines). Every validation/ownership/not-found
string is copied verbatim from the PHP source and pinned here; index/show/agents
shapes are exercised through the real repositories against a FakeDb so the
key order matches the models' toArray()/toApiArray()/toArrayWithAgents().
"""
from __future__ import annotations

from starlette.datastructures import Headers

from app.agent_team.controllers.team_controller import TeamController
from app.agent_team.controllers.workflow_schema_controller import WorkflowSchemaController
from app.support.http import Ctx


class FakeDb:
    """Records every statement so tests can assert SQL/params. Queued return
    values are consumed in call order per method (mirrors the repository FakeDb
    used in tests/unit/test_agent_team_repositories.py)."""

    def __init__(self, one=None, all_=None, insert_id=1, rowcount=1):
        self.one_queue = list(one) if one else []
        self.all_queue = list(all_) if all_ else []
        self.insert_id = insert_id
        self.rowcount = rowcount
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one_queue.pop(0) if self.one_queue else None

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_queue.pop(0) if self.all_queue else []

    def fetch_column(self, sql, params=None):
        self.calls.append(('fetch_column', sql, params))
        return []

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append(('insert', sql, params))
        return self.insert_id


def ctx(body=None, query=None, params=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params=params or {}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


TEAM_ROW = {'id': 1, 'user_id': 3, 'workspace_id': None, 'name': 'Team A', 'description': 'd',
            'created_at': 'c', 'updated_at': 'u'}

AGENT_ROW = {
    'id': 5, 'user_id': 3, 'team_id': 1, 'category': None, 'name': 'Alice',
    'description': '', 'agent_type': 'standard', 'parent_agent_id': None,
    'can_delegate_to': '[]', 'display_order': 0, 'provider': 'claude', 'model': None,
    'instructions': '', 'tools': '[]', 'visibility': 'personal', 'enabled': 1,
    'settings': '[]', 'created_at': None, 'updated_at': None,
}

SCHEMA_ROW = {
    'id': 1, 'user_id': 3, 'name': 'out', 'description': 'd',
    'schema_json': '{"type":"object","properties":{}}', 'strict': 1,
    'created_at': 'c', 'updated_at': 'u',
}


def team_controller(db=None):
    return TeamController(db or FakeDb(), {})


def schema_controller(db=None):
    return WorkflowSchemaController(db or FakeDb(), {})


# ============================================================================
# TeamController
# ============================================================================

# --- index -------------------------------------------------------------------

def test_index_unauthenticated_returns_401():
    r = team_controller().index(ctx(user_id=0))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_index_shape_via_repository():
    db = FakeDb(all_=[[TEAM_ROW], [AGENT_ROW]])
    r = team_controller(db).index(ctx())
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['count'] == 1
    team_data = r['data'][0]
    assert list(team_data.keys()) == ['id', 'user_id', 'workspace_id', 'name', 'description',
                                       'created_at', 'updated_at', 'agents']
    assert team_data['name'] == 'Team A'
    agent_data = team_data['agents'][0]
    assert agent_data['id'] == 5
    assert agent_data['pipeline_position'] == 1
    assert agent_data['pipeline_label'] == 'Step 1'
    assert agent_data['is_pipeline_head'] is True
    assert agent_data['is_pipeline_tail'] is True
    assert agent_data['can_reorder'] is True


def test_index_empty_list():
    db = FakeDb(all_=[[]])
    r = team_controller(db).index(ctx())
    assert r == {'success': True, 'data': [], 'count': 0, 'status_code': 200}


# --- create --------------------------------------------------------------

def test_create_unauthenticated_returns_401():
    r = team_controller().create(ctx(user_id=0, body={'name': 'x'}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_create_missing_name_returns_400():
    r = team_controller().create(ctx(body={}))
    assert r == {'success': False, 'error': 'Team name is required', 'status_code': 400}


def test_create_blank_name_returns_400():
    r = team_controller().create(ctx(body={'name': ''}))
    assert r == {'success': False, 'error': 'Team name is required', 'status_code': 400}


def test_create_success_returns_201():
    db = FakeDb(one=[TEAM_ROW], insert_id=1)
    r = team_controller(db).create(ctx(body={'name': 'Team A', 'description': 'd'}))
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['message'] == 'Team created successfully'
    assert r['data'] == {'id': 1, 'user_id': 3, 'workspace_id': None, 'name': 'Team A',
                          'description': 'd', 'created_at': 'c', 'updated_at': 'u'}


def test_create_defaults_description_and_workspace_id():
    db = FakeDb(one=[TEAM_ROW], insert_id=1)
    team_controller(db).create(ctx(body={'name': 'Team A'}))
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2] == {'user_id': 3, 'workspace_id': None, 'name': 'Team A', 'description': ''}


# --- show ------------------------------------------------------------------

def test_show_unauthenticated_returns_401():
    r = team_controller().show(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_show_zero_id_returns_400():
    r = team_controller().show(ctx(), 0)
    assert r == {'success': False, 'error': 'Team ID is required', 'status_code': 400}


def test_show_access_denied_returns_404():
    db = FakeDb(one=[{**TEAM_ROW, 'user_id': 999}])
    r = team_controller(db).show(ctx(), 1)
    assert r == {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}


def test_show_shape_via_repository():
    db = FakeDb(one=[TEAM_ROW, TEAM_ROW], all_=[[AGENT_ROW]])
    r = team_controller(db).show(ctx(), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['data']['name'] == 'Team A'
    assert r['data']['agents'][0]['id'] == 5


# --- update ------------------------------------------------------------------

def test_update_unauthenticated_returns_401():
    r = team_controller().update(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_update_zero_id_returns_400():
    r = team_controller().update(ctx(), 0)
    assert r == {'success': False, 'error': 'Team ID is required', 'status_code': 400}


def test_update_access_denied_returns_404():
    db = FakeDb(one=[{**TEAM_ROW, 'user_id': 999}])
    r = team_controller(db).update(ctx(body={'name': 'New'}), 1)
    assert r == {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}


def test_update_success_returns_updated_fields():
    updated_row = {**TEAM_ROW, 'description': 'new-desc'}
    db = FakeDb(one=[TEAM_ROW, TEAM_ROW, updated_row])
    r = team_controller(db).update(ctx(body={'description': 'new-desc'}), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['message'] == 'Team updated successfully'
    assert r['data']['description'] == 'new-desc'


def test_update_null_fields_are_not_applied():
    # isset($body['name']) is false for an explicit JSON null -- the field must be left untouched.
    db = FakeDb(one=[TEAM_ROW, TEAM_ROW, TEAM_ROW])
    team_controller(db).update(ctx(body={'name': None}), 1)
    update_call = next(c for c in db.calls if c[0] == 'execute')
    assert update_call[2]['name'] == 'Team A'   # unchanged, not None


# --- destroy ------------------------------------------------------------------

def test_destroy_unauthenticated_returns_401():
    r = team_controller().destroy(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_destroy_zero_id_returns_400():
    r = team_controller().destroy(ctx(), 0)
    assert r == {'success': False, 'error': 'Team ID is required', 'status_code': 400}


def test_destroy_access_denied_returns_404():
    db = FakeDb(one=[{**TEAM_ROW, 'user_id': 999}])
    r = team_controller(db).destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}


def test_destroy_success():
    db = FakeDb(one=[TEAM_ROW])
    r = team_controller(db).destroy(ctx(), 1)
    assert r == {'success': True, 'message': 'Team deleted successfully', 'status_code': 200}
    assert ('execute', 'DELETE FROM agents WHERE team_id = ?', [1]) in db.calls
    assert ('execute', 'DELETE FROM agent_teams WHERE id = ?', [1]) in db.calls


# --- agents ------------------------------------------------------------------

def test_agents_unauthenticated_returns_401():
    r = team_controller().agents(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_agents_zero_id_returns_400():
    r = team_controller().agents(ctx(), 0)
    assert r == {'success': False, 'error': 'Team ID is required', 'status_code': 400}


def test_agents_access_denied_returns_404():
    db = FakeDb(one=[{**TEAM_ROW, 'user_id': 999}])
    r = team_controller(db).agents(ctx(), 1)
    assert r == {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}


def test_agents_shape_via_repository():
    manager_row = {**AGENT_ROW, 'id': 9, 'agent_type': 'manager'}
    db = FakeDb(one=[TEAM_ROW], all_=[[manager_row, AGENT_ROW]])
    r = team_controller(db).agents(ctx(), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['count'] == 2
    manager = r['data'][0]
    assert manager['id'] == 9
    assert manager['pipeline_position'] is None
    assert manager['pipeline_label'] == 'Manager'
    assert manager['can_reorder'] is False
    worker = r['data'][1]
    assert worker['id'] == 5
    assert worker['pipeline_position'] == 1
    assert worker['pipeline_label'] == 'Step 1'
    assert worker['can_reorder'] is True


# ============================================================================
# WorkflowSchemaController
# ============================================================================

# --- index -------------------------------------------------------------------

def test_schema_index_unauthenticated_returns_401():
    r = schema_controller().index(ctx(user_id=0))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_schema_index_shape_via_repository():
    db = FakeDb(all_=[[SCHEMA_ROW]])
    r = schema_controller(db).index(ctx())
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['count'] == 1
    data = r['data'][0]
    assert list(data.keys()) == ['id', 'name', 'description', 'schema_json', 'strict',
                                  'created_at', 'updated_at']
    assert data['schema_json'] == {'type': 'object', 'properties': {}}
    assert data['strict'] is True


# --- show ------------------------------------------------------------------

def test_schema_show_unauthenticated_returns_401():
    r = schema_controller().show(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_schema_show_not_found_returns_404():
    db = FakeDb(one=[None])
    r = schema_controller(db).show(ctx(), 999999999)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_show_wrong_owner_returns_404():
    db = FakeDb(one=[{**SCHEMA_ROW, 'user_id': 999}])
    r = schema_controller(db).show(ctx(), 1)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_show_success():
    db = FakeDb(one=[SCHEMA_ROW])
    r = schema_controller(db).show(ctx(), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['data']['name'] == 'out'


# --- create --------------------------------------------------------------

def test_schema_create_unauthenticated_returns_401():
    r = schema_controller().create(ctx(user_id=0, body={'name': 'x'}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_schema_create_invalid_schema_returns_400_validation_errors():
    r = schema_controller().create(ctx(body={'name': ''}))
    assert r['success'] is False
    assert r['error'] == 'Invalid schema'
    assert r['status_code'] == 400
    assert 'Schema name is required' in r['validation_errors']
    assert 'schema_json is required' in r['validation_errors']


def test_schema_create_bad_name_chars_error():
    body = {'name': 'bad name!', 'schema_json': {'type': 'object', 'properties': {}}}
    r = schema_controller().create(ctx(body=body))
    assert r['success'] is False
    assert 'Schema name must contain only letters, numbers, dashes and underscores' in r['validation_errors']


def test_schema_create_wrong_top_level_type_error():
    body = {'name': 'ok', 'schema_json': {'type': 'array', 'properties': {}}}
    r = schema_controller().create(ctx(body=body))
    assert 'Top-level schema type must be "object"' in r['validation_errors']


def test_schema_create_missing_properties_error():
    body = {'name': 'ok', 'schema_json': {'type': 'object'}}
    r = schema_controller().create(ctx(body=body))
    assert 'Schema must have a "properties" object' in r['validation_errors']


def test_schema_create_duplicate_name_returns_409():
    db = FakeDb(one=[SCHEMA_ROW])
    body = {'name': 'out', 'schema_json': {'type': 'object', 'properties': {}}}
    r = schema_controller(db).create(ctx(body=body))
    assert r == {'success': False, 'error': "A schema named 'out' already exists", 'status_code': 409}


def test_schema_create_success_returns_201():
    db = FakeDb(one=[None], insert_id=7)
    body = {'name': 'out', 'description': 'd', 'schema_json': {'type': 'object', 'properties': {}}, 'strict': False}
    r = schema_controller(db).create(ctx(body=body))
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['message'] == 'Schema created'
    assert r['data']['id'] == 7
    assert r['data']['strict'] is False


def test_schema_create_strict_defaults_true():
    db = FakeDb(one=[None], insert_id=7)
    body = {'name': 'out', 'schema_json': {'type': 'object', 'properties': {}}}
    r = schema_controller(db).create(ctx(body=body))
    assert r['data']['strict'] is True


# --- update ------------------------------------------------------------------

def test_schema_update_unauthenticated_returns_401():
    r = schema_controller().update(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_schema_update_not_found_returns_404():
    db = FakeDb(one=[None])
    r = schema_controller(db).update(ctx(body={'name': 'x'}), 999999999)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_update_wrong_owner_returns_404():
    db = FakeDb(one=[{**SCHEMA_ROW, 'user_id': 999}])
    r = schema_controller(db).update(ctx(body={'name': 'x'}), 1)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_update_invalid_returns_400():
    db = FakeDb(one=[SCHEMA_ROW])
    r = schema_controller(db).update(ctx(body={'name': ''}), 1)
    assert r['success'] is False
    assert r['error'] == 'Invalid schema'
    assert r['status_code'] == 400


def test_schema_update_rename_conflict_returns_409():
    other = {**SCHEMA_ROW, 'id': 2, 'name': 'other'}
    db = FakeDb(one=[SCHEMA_ROW, other])
    r = schema_controller(db).update(ctx(body={'name': 'other'}), 1)
    assert r == {'success': False, 'error': "A schema named 'other' already exists", 'status_code': 409}


def test_schema_update_rename_to_own_current_name_is_allowed():
    db = FakeDb(one=[SCHEMA_ROW, SCHEMA_ROW])
    r = schema_controller(db).update(ctx(body={'name': 'out'}), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['message'] == 'Schema updated'


def test_schema_update_success_partial_fields():
    db = FakeDb(one=[SCHEMA_ROW, None])
    r = schema_controller(db).update(ctx(body={'description': 'new-desc'}), 1)
    assert r['success'] is True
    assert r['data']['description'] == 'new-desc'
    assert r['data']['name'] == 'out'   # untouched


def test_schema_update_null_name_casts_to_empty_and_fails_validation():
    # array_key_exists is true for an explicit JSON null, unlike Team's isset check --
    # WorkflowSchemaController casts with (string), so null becomes ''.
    db = FakeDb(one=[SCHEMA_ROW])
    r = schema_controller(db).update(ctx(body={'name': None}), 1)
    assert r['success'] is False
    assert r['error'] == 'Invalid schema'
    assert 'Schema name is required' in r['validation_errors']


# --- destroy ------------------------------------------------------------------

def test_schema_destroy_unauthenticated_returns_401():
    r = schema_controller().destroy(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_schema_destroy_not_found_returns_404():
    db = FakeDb(one=[None])
    r = schema_controller(db).destroy(ctx(), 999999999)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_destroy_wrong_owner_returns_404():
    db = FakeDb(one=[{**SCHEMA_ROW, 'user_id': 999}])
    r = schema_controller(db).destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'Schema not found', 'status_code': 404}


def test_schema_destroy_success():
    db = FakeDb(one=[SCHEMA_ROW])
    r = schema_controller(db).destroy(ctx(), 1)
    assert r == {'success': True, 'message': 'Schema deleted', 'status_code': 200}
    assert ('execute', 'DELETE FROM workflow_schemas WHERE id = ? AND user_id = ?', [1, 3]) in db.calls
