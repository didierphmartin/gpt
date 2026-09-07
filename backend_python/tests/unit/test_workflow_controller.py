"""Unit tests for WorkflowController (Phase 4, Task 6) — data/CRUD/outputs/
node-document paths. Port of
backend/src/AgentTeam/Controllers/WorkflowController.php (1957 lines).

Every validation/ownership/not-found string is copied verbatim from the PHP
source and pinned here. Success shapes are exercised through the real
WorkflowRepository/WorkflowGraphRepository/WorkflowOutputStorage against a
FakeDb so key order matches the models' toArray()/toApiArray().
"""
from __future__ import annotations

import json

import pytest
from starlette.datastructures import Headers

from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.services.workflow_run_log import WorkflowRunLog
from app.support.http import Ctx


class FakeDb:
    """Records every statement so tests can assert SQL/params. Queued return
    values are consumed in call order per method (mirrors the FakeDb used in
    tests/unit/test_team_schema_controllers.py and
    tests/unit/test_agent_team_repositories.py)."""

    def __init__(self, one=None, all_=None, insert_id=1, insert_ids=None, rowcount=1):
        self.one_queue = list(one) if one else []
        self.all_queue = list(all_) if all_ else []
        self.insert_id = insert_id
        self.insert_queue = list(insert_ids) if insert_ids else []
        self.rowcount = rowcount
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

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
        if self.insert_queue:
            return self.insert_queue.pop(0)
        return self.insert_id

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


def ctx(body=None, query=None, params=None, user_id=3, files=None):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params=params or {}, user_id=user_id, authenticated=user_id is not None, remote_addr='',
               files=files or {})


WORKFLOW_ROW = {
    'id': 1, 'user_id': 3, 'workspace_id': None, 'name': 'WF A', 'description': 'd',
    'steps': '[]', 'triggers': '[]', 'variables': '[]', 'enabled': 1,
    'created_at': 'c', 'updated_at': 'u', 'output_storage_enabled': 0, 'output_folder': None,
}

NODE_ROW = {
    'id': 5, 'workflow_id': 1, 'node_type': 'agent', 'agent_id': None,
    'config': json.dumps({'documents': [{'id': 'doc_1', 'name': 'a.txt', 'storage': 'remote', 'path': 'p'}]}),
    'pos_x': 0, 'pos_y': 0, 'drawflow_node_id': '1',
}

NODE_ROW_EMPTY = {
    'id': 6, 'workflow_id': 1, 'node_type': 'agent', 'agent_id': None,
    'config': None, 'pos_x': 0, 'pos_y': 0, 'drawflow_node_id': '2',
}


def wc(db=None, config=None):
    return WorkflowController(db or FakeDb(), config or {})


# ============================================================================
# index
# ============================================================================

def test_index_unauthenticated_returns_401():
    r = wc().index(ctx(user_id=0))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_index_empty_list():
    db = FakeDb(all_=[[]])
    r = wc(db).index(ctx())
    assert r == {'success': True, 'data': [], 'count': 0, 'status_code': 200}


def test_index_shape_and_runtime_mode_batch():
    db = FakeDb(all_=[[WORKFLOW_ROW], []])  # workflows, then realtime ids (empty)
    r = wc(db).index(ctx())
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['count'] == 1
    assert r['data'][0]['name'] == 'WF A'
    assert r['data'][0]['runtime_mode'] == 'batch'


def test_index_runtime_mode_realtime_when_id_in_set():
    db = FakeDb(all_=[[WORKFLOW_ROW], [{'workflow_id': 1}]])
    r = wc(db).index(ctx())
    assert r['data'][0]['runtime_mode'] == 'realtime'


def test_index_db_error_returns_500():
    class BoomDb(FakeDb):
        def fetch_all(self, sql, params=None):
            raise RuntimeError('db down')
    r = wc(BoomDb()).index(ctx())
    assert r == {'success': False, 'error': 'db down', 'status_code': 500}


# ============================================================================
# create
# ============================================================================

def test_create_unauthenticated_returns_401():
    r = wc().create(ctx(user_id=0, body={'name': 'x'}))
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_create_missing_name_returns_400():
    r = wc().create(ctx(body={}))
    assert r == {'success': False, 'error': 'Workflow name is required', 'status_code': 400}


def test_create_blank_name_returns_400():
    r = wc().create(ctx(body={'name': ''}))
    assert r == {'success': False, 'error': 'Workflow name is required', 'status_code': 400}


def test_create_invalid_steps_returns_400_validation_errors():
    r = wc().create(ctx(body={'name': 'wf', 'steps': [{}]}))
    assert r['success'] is False
    assert r['error'] == 'Invalid workflow steps'
    assert r['status_code'] == 400
    assert any("missing 'id'" in e for e in r['validation_errors'])
    assert any("missing 'type'" in e for e in r['validation_errors'])


def test_create_steps_only_success_returns_201():
    db = FakeDb(one=[WORKFLOW_ROW], insert_id=1)
    steps = [{'id': 's1', 'type': 'transform'}]
    r = wc(db).create(ctx(body={'name': 'WF A', 'steps': steps}))
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['message'] == 'Workflow created successfully'
    assert r['data']['name'] == 'WF A'
    # steps went through the DB round trip untouched (empty in WORKFLOW_ROW's
    # stored JSON is fine here — the point is no graph reload happened)
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert json.loads(insert_call[2]['steps']) == steps


def test_create_no_steps_no_graph_defaults_empty_steps():
    db = FakeDb(one=[WORKFLOW_ROW], insert_id=1)
    wc(db).create(ctx(body={'name': 'WF A'}))
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2]['steps'] == '[]'


def test_create_with_graph_reloads_and_saves_graph():
    # 1st fetch_one: findById(new_id) right after INSERT (no graph yet).
    # 2nd fetch_one: findById(new_id, True) after saveGraph -- reload.
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW], insert_ids=[1, 42],
                all_=[[], []])  # getGraphForFrontend: nodes, edges
    body = {
        'name': 'WF A',
        'definition': {'nodes': [{'id': '1', 'type': 'start', 'config': {}}], 'edges': []},
    }
    r = wc(db).create(ctx(body=body))
    assert r['success'] is True
    assert r['status_code'] == 201
    assert db.began == 1
    assert db.committed == 1
    # second insert (node id=42) came from graphRepository.createNode
    insert_calls = [c for c in db.calls if c[0] == 'insert']
    assert len(insert_calls) == 2


def test_create_db_error_returns_500():
    class BoomDb(FakeDb):
        def insert(self, sql, params=None):
            raise RuntimeError('insert failed')
    r = wc(BoomDb()).create(ctx(body={'name': 'WF A'}))
    assert r == {'success': False, 'error': 'insert failed', 'status_code': 500}


# ============================================================================
# generatePython/Adk/Maf/Nooa, run, runByName, runStream, runPlaybookNode,
# toolResult -- Phase 5/6, not routed
# ============================================================================

@pytest.mark.parametrize('method,args', [
    ('generatePython', (ctx(), 1)),
    ('generateAdk', (ctx(), 1)),
    ('generateMaf', (ctx(), 1)),
    ('generateNooa', (ctx(), 1)),
    ('run', (ctx(), 1)),
    ('runByName', (ctx(),)),
    ('runStream', (ctx(), 1)),
    ('runPlaybookNode', (ctx(),)),
    ('toolResult', (ctx(),)),
])
def test_unrouted_methods_raise_not_implemented(method, args):
    with pytest.raises(NotImplementedError, match='Phase 5/6'):
        getattr(wc(), method)(*args)


# ============================================================================
# show
# ============================================================================

def test_show_unauthenticated_returns_401():
    r = wc().show(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_show_zero_id_returns_400():
    r = wc().show(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_show_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).show(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_show_success_includes_graph_by_default():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW], all_=[[], []])
    r = wc(db).show(ctx(), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['data']['name'] == 'WF A'
    assert r['data']['graph'] == {'nodes': [], 'edges': []}


def test_show_include_graph_false_omits_graph():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW])
    r = wc(db).show(ctx(query={'include_graph': 'false'}), 1)
    assert 'graph' not in r['data']


# ============================================================================
# update
# ============================================================================

def test_update_unauthenticated_returns_401():
    r = wc().update(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_update_zero_id_returns_400():
    r = wc().update(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_update_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).update(ctx(body={'name': 'x'}), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_update_invalid_steps_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW])
    r = wc(db).update(ctx(body={'steps': [{}]}), 1)
    assert r['success'] is False
    assert r['error'] == 'Invalid workflow steps'
    assert r['status_code'] == 400


def test_update_null_fields_are_not_applied():
    # isset($body['name']) is false for an explicit JSON null.
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, WORKFLOW_ROW])
    wc(db).update(ctx(body={'name': None}), 1)
    update_call = next(c for c in db.calls if c[0] == 'execute' and 'UPDATE agent_workflows' in c[1])
    assert update_call[2]['name'] == 'WF A'  # unchanged, not None


def test_update_output_folder_null_is_applied_via_array_key_exists():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, {**WORKFLOW_ROW, 'output_folder': None}])
    r = wc(db).update(ctx(body={'output_folder': None}), 1)
    update_call = next(c for c in db.calls if c[0] == 'execute' and 'UPDATE agent_workflows' in c[1])
    assert update_call[2]['output_folder'] is None
    assert r['success'] is True


def test_update_success_returns_updated_fields():
    updated_row = {**WORKFLOW_ROW, 'description': 'new-desc'}
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, updated_row])
    r = wc(db).update(ctx(body={'description': 'new-desc'}), 1)
    assert r['success'] is True
    assert r['status_code'] == 200
    assert r['message'] == 'Workflow updated successfully'
    assert r['data']['description'] == 'new-desc'


def test_update_not_found_after_ownership_check_returns_404():
    # isOwner() finds a row (so ownership passes) but a subsequent findById
    # (separate call) returns nothing -- PHP's own two-step check.
    db = FakeDb(one=[WORKFLOW_ROW, None])
    r = wc(db).update(ctx(body={'name': 'x'}), 1)
    assert r == {'success': False, 'error': 'Workflow not found', 'status_code': 404}


# ============================================================================
# destroy
# ============================================================================

def test_destroy_unauthenticated_returns_401():
    r = wc().destroy(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_destroy_zero_id_returns_400():
    r = wc().destroy(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_destroy_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).destroy(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_destroy_success():
    db = FakeDb(one=[WORKFLOW_ROW])
    r = wc(db).destroy(ctx(), 1)
    assert r == {'success': True, 'message': 'Workflow deleted successfully', 'status_code': 200}
    assert ('execute', 'DELETE FROM agent_workflows WHERE id = ?', [1]) in db.calls


# ============================================================================
# executions
# ============================================================================

def test_executions_unauthenticated_returns_401():
    r = wc().executions(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_executions_zero_id_returns_400():
    r = wc().executions(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_executions_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).executions(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_executions_default_limit_offset():
    db = FakeDb(one=[WORKFLOW_ROW], all_=[[{'id': 1}]])
    r = wc(db).executions(ctx(), 1)
    assert r == {'success': True, 'data': [{'id': 1}], 'count': 1, 'status_code': 200}
    call = next(c for c in db.calls if c[0] == 'fetch_all')
    assert call[2] == [1, 50, 0]


def test_executions_custom_limit_offset():
    db = FakeDb(one=[WORKFLOW_ROW], all_=[[]])
    wc(db).executions(ctx(query={'limit': '10', 'offset': '5'}), 1)
    call = next(c for c in db.calls if c[0] == 'fetch_all')
    assert call[2] == [1, 10, 5]


# ============================================================================
# runEvents
# ============================================================================

def test_run_events_unauthenticated_returns_200_error_body():
    # PHP's http_response_code(401) here is dead code (backend/index.php:149
    # derives the real status from $result['status_code'] ?? 200, and this
    # method's return arrays never carry that key) -- verified live against
    # the Apache-hosted PHP backend, 2026-09-07. Always 200 on the wire.
    r = wc().runEvents(ctx(user_id=0, params={'runId': 'a' * 32}), 'a' * 32)
    assert r == {'error': 'Authentication required'}


def test_run_events_invalid_run_id_returns_200_error_body():
    r = wc().runEvents(ctx(params={'runId': 'not-hex'}), 'not-hex')
    assert r == {'error': 'Invalid runId'}


def test_run_events_reads_params_dict_not_positional_arg():
    """The Python dispatcher (app/main.py) numeric-coerces an all-digit route
    param before positional binding -- a 32-zero run id would arrive as the
    int 0 positionally. runEvents must read request['params']['runId']
    (PHP 1167 does the same) so this still resolves to the real 32-char id
    rather than silently misreading a mangled id as a different one."""
    zeros = '0' * 32
    r = wc().runEvents(ctx(params={'runId': zeros}), 0)  # dispatcher would pass int 0 here
    # Not found (no log on disk for this id) rather than "Invalid runId" --
    # proves the handler used the params dict, not the positional int.
    assert r['error'] == 'Run not found'


def test_run_events_not_found_returns_200_error_body(tmp_path):
    run_id = 'b' * 32
    r = wc(config={'workflow_runs_dir': str(tmp_path)}).runEvents(ctx(params={'runId': run_id}), run_id)
    assert r == {'error': 'Run not found'}


def test_run_events_success_reads_log(tmp_path):
    run_id = 'c' * 32
    log = WorkflowRunLog(str(tmp_path))
    log.append(run_id, {'type': 'workflow_start'})
    log.append(run_id, {'type': 'node_complete', 'output': 'x'})

    r = wc(config={'workflow_runs_dir': str(tmp_path)}).runEvents(ctx(params={'runId': run_id}), run_id)
    assert 'status_code' not in r
    assert r['run_id'] == run_id
    assert len(r['events']) == 2
    assert r['events'][1]['output'] == 'x'


# ============================================================================
# toggle
# ============================================================================

def test_toggle_unauthenticated_returns_401():
    r = wc().toggle(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_toggle_zero_id_returns_400():
    r = wc().toggle(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_toggle_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).toggle(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_toggle_success_disabled_message():
    db = FakeDb(one=[WORKFLOW_ROW, {**WORKFLOW_ROW, 'enabled': 0}])
    r = wc(db).toggle(ctx(), 1)
    assert r['success'] is True
    assert r['message'] == 'Workflow disabled'
    assert r['data']['enabled'] is False


def test_toggle_success_enabled_message():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'enabled': 0}, WORKFLOW_ROW])
    r = wc(db).toggle(ctx(), 1)
    assert r['message'] == 'Workflow enabled'


# ============================================================================
# duplicate
# ============================================================================

def test_duplicate_unauthenticated_returns_401():
    r = wc().duplicate(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_duplicate_zero_id_returns_400():
    r = wc().duplicate(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_duplicate_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).duplicate(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_duplicate_not_found_returns_500():
    # canUserAccess passes (row found), then duplicate()'s own findById
    # returns nothing -- WorkflowRepository.duplicate returns None.
    db = FakeDb(one=[WORKFLOW_ROW, None])
    r = wc(db).duplicate(ctx(), 1)
    assert r == {'success': False, 'error': 'Failed to duplicate workflow', 'status_code': 500}


def test_duplicate_success_default_name():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, {**WORKFLOW_ROW, 'id': 2, 'name': 'WF A (Copy)'}], insert_id=2)
    r = wc(db).duplicate(ctx(), 1)
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['data']['name'] == 'WF A (Copy)'


def test_duplicate_success_custom_name():
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, {**WORKFLOW_ROW, 'id': 2, 'name': 'Renamed'}], insert_id=2)
    r = wc(db).duplicate(ctx(body={'name': 'Renamed'}), 1)
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2]['name'] == 'Renamed'


# ============================================================================
# listOutputs / getOutput
# ============================================================================

def test_list_outputs_unauthenticated_returns_401():
    r = wc().listOutputs(ctx(user_id=0), 1)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_list_outputs_zero_id_returns_400():
    r = wc().listOutputs(ctx(), 0)
    assert r == {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}


def test_list_outputs_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).listOutputs(ctx(), 1)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_list_outputs_storage_not_configured(tmp_path):
    # canUserAccess findById, then WorkflowOutputStorage.getWorkflow,
    # then getStorageConfig's users-row lookup returning no provider/folder.
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, {'storage_provider': None, 'storage_folder': None}])
    r = wc(db, config={'workflow_outputs_path': str(tmp_path)}).listOutputs(ctx(), 1)
    assert r['success'] is True
    assert r['files'] == []
    assert r['status_code'] == 200


def test_get_output_unauthenticated_returns_401():
    r = wc().getOutput(ctx(user_id=0), 1, 'f.json')
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_get_output_missing_filename_returns_400():
    r = wc().getOutput(ctx(), 1, '')
    assert r == {'success': False, 'error': 'Workflow ID and filename are required', 'status_code': 400}


def test_get_output_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).getOutput(ctx(), 1, 'f.json')
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_get_output_not_found_maps_to_404(tmp_path):
    db = FakeDb(one=[WORKFLOW_ROW, WORKFLOW_ROW, {'storage_provider': 'local', 'storage_folder': 'fld'}])
    r = wc(db, config={'workflow_outputs_path': str(tmp_path)}).getOutput(ctx(), 1, 'missing.json')
    assert r['success'] is False
    assert r['status_code'] == 404


# ============================================================================
# uploadNodeDocument
# ============================================================================

def test_upload_unauthenticated_returns_401():
    r = wc().uploadNodeDocument(ctx(user_id=0), 1, 5)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_upload_missing_ids_returns_400():
    r = wc().uploadNodeDocument(ctx(), 0, 5)
    assert r == {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}


def test_upload_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).uploadNodeDocument(ctx(), 1, 5)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_upload_node_not_found_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW], all_=[])
    db.one_queue.append(None)  # getNode lookup returns None (fetch_one call)
    r = wc(db).uploadNodeDocument(ctx(), 1, 999)
    assert r == {'success': False, 'error': 'Node not found', 'status_code': 404}


def test_upload_node_belongs_to_other_workflow_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW, {**NODE_ROW, 'workflow_id': 2}])
    r = wc(db).uploadNodeDocument(ctx(), 1, 5)
    assert r == {'success': False, 'error': 'Node not found', 'status_code': 404}


def test_upload_no_file_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    r = wc(db).uploadNodeDocument(ctx(files={}), 1, 5)
    assert r == {'success': False, 'error': 'No file uploaded', 'status_code': 400}


def test_upload_error_code_maps_to_message():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    files = {'file': {'error': 1, 'name': 'a.txt', 'size': 10, 'tmp_name': '/tmp/x'}}
    r = wc(db).uploadNodeDocument(ctx(files=files), 1, 5)
    assert r == {'success': False, 'error': 'File exceeds server upload limit', 'status_code': 400}


def test_upload_size_exceeds_limit_returns_400(tmp_path):
    p = tmp_path / 'big.txt'
    p.write_bytes(b'x' * 10)
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    files = {'file': {'error': 0, 'name': 'big.txt', 'size': 1024 * 1024 + 1, 'tmp_name': str(p)}}
    r = wc(db).uploadNodeDocument(ctx(files=files), 1, 5)
    assert r == {'success': False, 'error': 'File exceeds 1MB limit', 'status_code': 400}


def test_upload_disallowed_mime_returns_400(tmp_path):
    p = tmp_path / 'a.zip'
    p.write_bytes(b'PK\x03\x04' + b'\x00' * 20)
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    files = {'file': {'error': 0, 'name': 'a.zip', 'size': 24, 'tmp_name': str(p)}}
    r = wc(db).uploadNodeDocument(ctx(files=files), 1, 5)
    assert r['success'] is False
    assert 'File type not allowed' in r['error']
    assert r['status_code'] == 400


def test_upload_success_path_ends_in_503_adapter_unavailable(tmp_path):
    """universalFS is never available in this port -- every otherwise-valid
    upload ends at PHP's own 503 branch (module docstring)."""
    p = tmp_path / 'note.txt'
    p.write_bytes(b'hello world')
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW, {'storage_folder': 'user_3'}])
    files = {'file': {'error': 0, 'name': 'note.txt', 'size': 11, 'tmp_name': str(p)}}
    r = wc(db).uploadNodeDocument(ctx(files=files), 1, 5)
    assert r == {'success': False, 'error': 'Storage system (UniversalFS) not available', 'status_code': 503}


# ============================================================================
# saveDocumentMetadata
# ============================================================================

def test_save_metadata_unauthenticated_returns_401():
    r = wc().saveDocumentMetadata(ctx(user_id=0), 1, 5)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_save_metadata_missing_ids_returns_400():
    r = wc().saveDocumentMetadata(ctx(), 0, 5)
    assert r == {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}


def test_save_metadata_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).saveDocumentMetadata(ctx(body={'document': {'id': 'd1', 'name': 'n'}}), 1, 5)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_save_metadata_node_not_found_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW, None])
    r = wc(db).saveDocumentMetadata(ctx(body={'document': {'id': 'd1', 'name': 'n'}}), 1, 5)
    assert r == {'success': False, 'error': 'Node not found', 'status_code': 404}


def test_save_metadata_missing_document_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    r = wc(db).saveDocumentMetadata(ctx(body={}), 1, 5)
    assert r == {'success': False, 'error': 'Document metadata required (id, name)', 'status_code': 400}


def test_save_metadata_missing_name_returns_400():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    r = wc(db).saveDocumentMetadata(ctx(body={'document': {'id': 'd1'}}), 1, 5)
    assert r == {'success': False, 'error': 'Document metadata required (id, name)', 'status_code': 400}


def test_save_metadata_success():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW_EMPTY])
    doc = {'id': 'd1', 'name': 'note.txt', 'localUri': 'file:///x', 'size': 12}
    r = wc(db).saveDocumentMetadata(ctx(body={'document': doc}), 1, 6)
    assert r['success'] is True
    assert r['status_code'] == 201
    assert r['document']['id'] == 'd1'
    assert r['document']['storage'] == 'local'
    assert r['document']['mimeType'] == 'application/octet-stream'
    assert r['document']['size'] == 12
    update_call = next(c for c in db.calls if c[0] == 'execute' and 'UPDATE workflow_nodes' in c[1])
    assert json.loads(update_call[2]['config'])['documents'][0]['id'] == 'd1'


# ============================================================================
# listNodeDocuments
# ============================================================================

def test_list_documents_unauthenticated_returns_401():
    r = wc().listNodeDocuments(ctx(user_id=0), 1, 5)
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_list_documents_missing_ids_returns_400():
    r = wc().listNodeDocuments(ctx(), 0, 5)
    assert r == {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}


def test_list_documents_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).listNodeDocuments(ctx(), 1, 5)
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_list_documents_node_not_found_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW, None])
    r = wc(db).listNodeDocuments(ctx(), 1, 5)
    assert r == {'success': False, 'error': 'Node not found', 'status_code': 404}


def test_list_documents_success():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    r = wc(db).listNodeDocuments(ctx(), 1, 5)
    assert r['success'] is True
    assert r['count'] == 1
    assert r['documents'][0]['id'] == 'doc_1'


def test_list_documents_empty_config():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW_EMPTY])
    r = wc(db).listNodeDocuments(ctx(), 1, 6)
    assert r == {'success': True, 'documents': [], 'count': 0, 'status_code': 200}


# ============================================================================
# deleteNodeDocument
# ============================================================================

def test_delete_document_unauthenticated_returns_401():
    r = wc().deleteNodeDocument(ctx(user_id=0), 1, 5, 'doc_1')
    assert r == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_delete_document_missing_ids_returns_400():
    r = wc().deleteNodeDocument(ctx(), 0, 5, 'doc_1')
    assert r == {
        'success': False,
        'error': 'Workflow ID, Node ID, and Document ID are required',
        'status_code': 400,
    }


def test_delete_document_missing_doc_id_returns_400():
    r = wc().deleteNodeDocument(ctx(), 1, 5, '')
    assert r == {
        'success': False,
        'error': 'Workflow ID, Node ID, and Document ID are required',
        'status_code': 400,
    }


def test_delete_document_access_denied_returns_404():
    db = FakeDb(one=[{**WORKFLOW_ROW, 'user_id': 999}])
    r = wc(db).deleteNodeDocument(ctx(), 1, 5, 'doc_1')
    assert r == {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}


def test_delete_document_node_not_found_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW, None])
    r = wc(db).deleteNodeDocument(ctx(), 1, 5, 'doc_1')
    assert r == {'success': False, 'error': 'Node not found', 'status_code': 404}


def test_delete_document_not_found_returns_404():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW])
    r = wc(db).deleteNodeDocument(ctx(), 1, 5, 'doc_does_not_exist')
    assert r == {'success': False, 'error': 'Document not found', 'status_code': 404}


def test_delete_document_remote_storage_success_despite_no_adapter():
    db = FakeDb(one=[WORKFLOW_ROW, NODE_ROW, {'storage_folder': 'user_3'}])
    r = wc(db).deleteNodeDocument(ctx(), 1, 5, 'doc_1')
    assert r == {'success': True, 'message': 'Document deleted successfully', 'status_code': 200}
    update_call = next(c for c in db.calls if c[0] == 'execute' and 'UPDATE workflow_nodes' in c[1])
    assert json.loads(update_call[2]['config'])['documents'] == []


def test_delete_document_local_storage_skips_remote_delete():
    node = {**NODE_ROW, 'config': json.dumps({'documents': [{'id': 'doc_1', 'storage': 'local'}]})}
    db = FakeDb(one=[WORKFLOW_ROW, node])
    r = wc(db).deleteNodeDocument(ctx(), 1, 5, 'doc_1')
    assert r['success'] is True
    # No users-table lookup happened (no getUserStorageFolder call) for local storage.
    assert not any('storage_folder' in (c[1] or '') for c in db.calls if c[0] == 'fetch_one')


# ============================================================================
# Private helpers
# ============================================================================

def test_detect_mime_type_pdf_signature(tmp_path):
    p = tmp_path / 'x.bin'
    p.write_bytes(b'%PDF-1.4 rest')
    assert wc().detectMimeType(str(p), 'x.pdf') == 'application/pdf'


def test_detect_mime_type_falls_back_to_extension(tmp_path):
    p = tmp_path / 'x'
    p.write_bytes(b'')  # empty -> sniff returns 'application/x-empty', not octet-stream... use unreadable path instead
    assert wc().detectMimeType('/no/such/file', 'notes.md') == 'text/markdown'


def test_guess_mime_type_from_extension():
    assert wc().guessMimeTypeFromExtension('a.py') == 'text/x-python'
    assert wc().guessMimeTypeFromExtension('a.unknownext') == 'application/octet-stream'


def test_is_allowed_mime_type():
    assert wc().isAllowedMimeType('text/x-anything') is True
    assert wc().isAllowedMimeType('image/anything') is True
    assert wc().isAllowedMimeType('application/pdf') is True
    assert wc().isAllowedMimeType('application/zip') is False


def test_sanitize_filename_strips_path_and_unsafe_chars():
    assert wc().sanitizeFilename('/etc/passwd') == 'passwd'
    assert wc().sanitizeFilename('my file (1).txt') == 'my_file__1_.txt'


def test_sanitize_filename_truncates_long_names():
    long_name = ('a' * 150) + '.txt'
    out = wc().sanitizeFilename(long_name)
    assert len(out) <= 94
    assert out.endswith('.txt')


def test_get_upload_error_message_known_and_unknown():
    c = wc()
    assert c.getUploadErrorMessage(1) == 'File exceeds server upload limit'
    assert c.getUploadErrorMessage(4) == 'No file was uploaded'
    assert c.getUploadErrorMessage(999) == 'Unknown upload error'


def test_get_user_storage_folder_defaults_to_user_prefix():
    db = FakeDb(one=[{'storage_folder': None}])
    assert wc(db).getUserStorageFolder(7) == 'user_7'


def test_get_user_storage_folder_uses_row_value():
    db = FakeDb(one=[{'storage_folder': 'custom'}])
    assert wc(db).getUserStorageFolder(7) == 'custom'


def test_get_user_storage_provider_prefers_user_setting():
    db = FakeDb(one=[{'storage_provider': 'gdrive'}])
    assert wc(db).getUserStorageProvider(7) == 'gdrive'


def test_get_user_storage_provider_falls_back_to_config_then_local():
    db = FakeDb(one=[{'storage_provider': None}])
    assert wc(db, config={'storage': {'default_provider': 's3'}}).getUserStorageProvider(7) == 's3'
    db2 = FakeDb(one=[{'storage_provider': None}])
    assert wc(db2).getUserStorageProvider(7) == 'local'


def test_get_local_storage_path_default_and_override():
    c = wc()
    assert c.getLocalStoragePath('foo/bar').endswith('/gpt/storage/foo/bar')
    c2 = wc(config={'storage_path': '/custom'})
    assert c2.getLocalStoragePath('/foo/') == '/custom/foo'


def test_get_universal_fs_adapter_always_none():
    assert wc().getUniversalFSAdapter(3) is None
