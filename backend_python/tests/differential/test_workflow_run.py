"""Differential tests for WorkflowController's execution endpoints (Phase 5,
Task 6) -- `run`, `runByName`, `runStream`, `runPlaybookNode`, `toolResult`
-- and AgentMCPController (`POST /api/v1/mcp/agents`).

PHP live at http://localhost/gpt/backend, Python in-process. User 3.

WORKFLOW_ID = 36 ("Battery News Report") -- user 3's smallest PURELY
SEQUENTIAL graph workflow: start -> agent (mcp_battery_news_* tools) ->
agent (no tools) -> output, 4 nodes, edges strictly 1836->1837->1838->1839
(no fan-out). Picked over the 2-node "playbook N" workflows (playbook
node type, a different runner entirely) and over the tied-smallest
4-node "Pubmed research" (id 1, whose node 462 fans out to BOTH node 463
and the output node 464 -- a parallel-shaped graph, and
GraphWorkflowRunner's parallel-execution leaves are still Task 5b's
NotImplementedError stubs as of this writing) and wf 15 ("Convert to
Medium format", 3 nodes but its start node carries a browser-local
File-System-Access document and its agent node a bound_skill -- both
depend on the browser/Pyodide tool bridge that a headless differential
run has no way to service; see project_skill_workflows_need_browser).
All verified live against the CONTEXTS DB `workflow_nodes`/`workflow_edges`
tables, 2026-09-07.
"""
import pytest

from app.db import open_primary
from tests.differential.conftest import DIFF_USER_ID, same
from tests.differential.sse import parse_data_only, same_data_stream

pytestmark = pytest.mark.differential

WORKFLOW_ID = 36


# ============================================================================
# Validation parity -- no LLM cost
# ============================================================================

def test_run_validation_parity(both):
    same(*both('POST', '/api/v1/workflows/999999999/run', json={}))
    same(*both('POST', '/api/v1/workflows/0/run', json={}))
    same(*both('POST', '/api/v1/workflows/1/run', json={}, auth=False))


def test_run_app_key_missing_scope_403_parity(php, py, token, config):
    """App-key scope gate (constraints.md's Global Constraints, "Validation
    cases exact-compare (auth, missing id, app-key scope 403 text)"). Creates
    a `differential-tmp-` app key for user 3 with a scope that does NOT
    grant `workflows:run`/`workflows:run:{WORKFLOW_ID}` (same create/delete
    route pair test_app_keys.py's own round-trip test uses), calls
    `POST /workflows/{WORKFLOW_ID}/run` with it via the `AppKey <key>` auth
    scheme (AuthMiddleware.php:22 / auth.py's `_APPKEY` regex -- NOT
    `Bearer`, which would fail JWT decode and 401 before the controller's
    own scope check ever runs), asserts the exact 403 body, then hard-deletes
    the created row by id on the SAME backend that created it (PHP-first,
    self-cleaning -- `DELETE /app-keys/{id}` is a soft delete per
    test_app_keys.py's own round-trip test, so the row is also purged via
    direct SQL, same precedent). No LLM cost: the scope check 403s before
    canUserAccess/run ever fire."""
    h = {'Authorization': f'Bearer {token}'}
    body = {'user_id': DIFF_USER_ID, 'application_id': 'differential', 'name': 'differential-tmp-scope-403',
            'scopes': ['agents:run:1']}   # deliberately no workflows:run scope
    db = open_primary(config)
    created_ids = []
    try:
        for c in (php, py):   # PHP first, so PHP's on-demand state lands before Python touches the same rows
            created = c.post('/api/v1/app-keys', json=body, headers=h)
            assert created.status_code == 201, created.text
            full_key = created.json()['data']['full_key']
            key_id = created.json()['data']['id']
            created_ids.append(key_id)

            r = c.post(f'/api/v1/workflows/{WORKFLOW_ID}/run', json={},
                       headers={'Authorization': f'AppKey {full_key}'})
            assert r.status_code == 403, r.text
            # `status_code` is an internal routing key -- index.php's
            # generic dispatch (and main.py's render()) both strip it from
            # the wire body before echoing, so it's not expected here (only
            # the HTTP status line carries it, asserted above).
            assert r.json() == {
                'success': False,
                'error': 'App key not authorized for this workflow (missing scope workflows:run)',
            }

            deleted = c.delete(f'/api/v1/app-keys/{key_id}', headers=h)
            assert deleted.status_code == 200, deleted.text
    finally:
        if created_ids:
            placeholders = ','.join(['?'] * len(created_ids))
            db.execute(f'DELETE FROM app_keys WHERE id IN ({placeholders})', created_ids)
        db.close()


def test_run_by_name_validation_parity(both):
    same(*both('POST', '/api/v1/workflows/run', json={}))
    same(*both('POST', '/api/v1/workflows/run', json={'workflow': '   '}))
    same(*both('POST', '/api/v1/workflows/run', json={'workflow': 'no-such-workflow-xyz'}))
    same(*both('POST', '/api/v1/workflows/run', json={'workflow': 'x'}, auth=False))


def test_tool_result_validation_parity(both):
    same(*both('POST', '/api/v1/workflows/tool-result', json={}))
    same(*both('POST', '/api/v1/workflows/tool-result', json={'tool_call_id': 'not-32-hex'}))
    same(*both('POST', '/api/v1/workflows/tool-result', json={'tool_call_id': 'a' * 32, 'success': True},
               auth=False))


def test_run_stream_validation_parity(php, py, token):
    """SSE endpoint -- bare `data:` frames (no `event:` line), terminated by
    the literal `data: [DONE]\\n\\n` sentinel on every branch, PHP and
    Python alike. Compared with `same_data_stream` (exact decoded payload
    sequence) since these are deterministic, non-LLM error paths.

    Unauthenticated is deliberately NOT exercised here: the shared auth
    middleware rejects it before the controller runs (verified live --
    `{"success":false,"message":"Authorization token required"}`,
    `Content-Type: application/json`, no SSE headers at all), so runStream's
    own `if (!$userId)` SSE-error branch (PHP 871-875) is dead code on live
    PHP, same class of finding as `toolResult`'s dead `http_response_code()`
    calls (see workflow_controller.py's toolResult docstring). Middleware
    parity is covered elsewhere, not by this task."""
    h = {'Authorization': f'Bearer {token}'}
    for path in (
        '/api/v1/workflows/999999999/run-stream',
        '/api/v1/workflows/0/run-stream',
    ):
        with php.stream('POST', path, json={}, headers=h) as ra:
            a = ra.read().decode()
            assert ra.headers['content-type'].startswith('text/event-stream')
        with py.stream('POST', path, json={}, headers=h) as rb:
            b = b''.join(rb.iter_bytes()).decode()
            assert rb.headers['content-type'].startswith('text/event-stream')
        same_data_stream(a, b)
        assert parse_data_only(a)[-1] == '[DONE]'


def test_run_stream_unauthenticated_hits_middleware_not_controller(both):
    """See test_run_stream_validation_parity's docstring -- this is a plain
    JSON 401 from the shared middleware, not an SSE response."""
    same(*both('POST', '/api/v1/workflows/1/run-stream', json={}, auth=False))


def test_playbook_node_run_validation_parity(both):
    """Unauthenticated hits the same shared auth middleware as runStream
    (see above) before PlaybookNodeRunner's own SSE `event: error` branch
    (PHP 991-995) is ever reached -- plain JSON 401, not SSE."""
    same(*both('POST', '/api/v1/workflows/playbook-node/run', json={}, auth=False))


# ============================================================================
# MCP JSON-RPC endpoint -- no LLM cost
# ============================================================================

def test_mcp_agents_invalid_request_parity(both):
    same(*both('POST', '/api/v1/mcp/agents', json={'id': 1, 'method': 'ping'}))
    same(*both('POST', '/api/v1/mcp/agents', json={'jsonrpc': '1.0', 'id': 1, 'method': 'ping'}))
    same(*both('POST', '/api/v1/mcp/agents', json={'jsonrpc': '2.0', 'id': 7, 'method': 'no/such/method'}))


def test_mcp_agents_initialize_parity(both):
    a, b = both('POST', '/api/v1/mcp/agents',
                json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}})
    assert a.status_code == b.status_code == 200
    assert a.json() == b.json()


def test_mcp_agents_tools_list_parity(both):
    """Full JSON equality -- live-verified 2026-09-07 (fix round 1): once
    `_listTools`'s `input_schema` fallback and the `list_available_agents`
    literal are wrapped in `php_array()` (empty PHP array -> `[]`, not
    `{}`), the entire 24-tool response (builtin + MCP + delegation tools)
    is byte-for-byte identical between backends -- no field needed
    normalizing."""
    a, b = both('POST', '/api/v1/mcp/agents',
                json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}})
    assert a.status_code == b.status_code == 200
    ja, jb = a.json(), b.json()
    assert ja == jb


# ============================================================================
# Live run -- costs LLM calls, runs exactly once per backend.
# ============================================================================

def test_workflow_run_live_parity(both, config):
    a, b = both('POST', f'/api/v1/workflows/{WORKFLOW_ID}/run', json={})
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    ja, jb = a.json(), b.json()

    assert list(ja) == list(jb)
    assert ja['success'] is True and jb['success'] is True
    assert ja['workflow'] == jb['workflow'] == {'id': WORKFLOW_ID, 'name': 'Battery News Report'}
    assert ja['nodes_executed'] == jb['nodes_executed']
    assert set(ja['node_outputs']) == set(jb['node_outputs'])
    assert set(ja['storage']) == set(jb['storage'])

    db = open_primary(config)
    try:
        rows = {}
        for label, execution_id in (('php', ja['execution_id']), ('py', jb['execution_id'])):
            row = db.fetch_one(
                'SELECT id, workflow_id, user_id, status, error_message, input_variables '
                'FROM agent_workflow_executions WHERE id = ?', [execution_id])
            assert row is not None
            rows[label] = row

        for k in ('workflow_id', 'user_id', 'status', 'error_message'):
            assert rows['php'][k] == rows['py'][k], (k, rows['php'][k], rows['py'][k])
        assert rows['php']['status'] == 'completed'

        # input_variables: PHP's own empty-array/empty-object JSON ambiguity
        # (phpjson.php_array's docstring) -- GraphWorkflowRunner._createExecution
        # (graph_workflow_runner.py:1516-1522, ported from PHP 1658-1671) calls
        # `php_json_encode(inputVariables)` directly, without the `php_array()`
        # wrap, so an empty dict `{}` (this endpoint's own default when the
        # request body carries neither `variables` nor `inputs`, matching PHP's
        # `$body['variables'] ?? $body['inputs'] ?? []`) round-trips as the
        # JSON object `"{}"` on Python vs PHP's `"[]"` for its empty array.
        # Pre-existing in a file Task 5b owns concurrently (constraints.md:
        # "Touch no other files") -- normalized here rather than fixed, and
        # flagged in task-6-report.md.
        import json as _json
        va = _json.loads(rows['php']['input_variables'])
        vb = _json.loads(rows['py']['input_variables'])
        va = {} if va == [] else va
        vb = {} if vb == [] else vb
        assert va == vb
    finally:
        db.execute('DELETE FROM agent_workflow_executions WHERE id IN (?, ?)',
                   [ja['execution_id'], jb['execution_id']])
        db.close()
