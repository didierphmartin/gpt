/**
 * Differential tests for WorkflowController's execution endpoints — `run`, `runByName`,
 * `runStream`, `runPlaybookNode`, `toolResult` — and AgentMCPController (`POST /api/v1/mcp/agents`).
 * Twin of backend_python/tests/differential/test_workflow_run.py.
 *
 * PHP live at http://localhost/gpt/backend, TS in-process. User 3.
 *
 * WORKFLOW_ID = 36 ("Battery News Report") — user 3's smallest PURELY SEQUENTIAL graph workflow:
 * start -> agent (mcp_battery_news_* tools) -> agent (no tools) -> output, 4 nodes, edges strictly
 * 1836->1837->1838->1839 (no fan-out). Picked over the 2-node "playbook N" workflows (a different
 * runner), over the tied-smallest 4-node "Pubmed research" (id 1, whose node 462 fans out — a
 * parallel-shaped graph) and over wf 15 ("Convert to Medium format": a browser-local document and a
 * bound_skill — both need the browser/Pyodide tool bridge a headless run cannot service).
 *
 * WRITES:
 *   - test_run_app_key_missing_scope_403_parity: creates an app key on each backend, soft-deletes
 *     it via the API and hard-deletes it by SQL.
 *   - test_workflow_run_live_parity: a live LLM run once per backend (costs LLM calls; writes an
 *     agent_workflow_executions row — deleted afterwards — plus whatever usage/trace rows the run
 *     logs, which are NOT cleaned up).
 * Everything else is validation / JSON-RPC reads with no LLM cost.
 */
import { dtest, DIFF_USER_ID, same, sameKeys, sameKeySet, assert } from './harness';
import { parseDataOnly, sameDataStream } from './sse';

const WORKFLOW_ID = 36;

// ============================================================================
// Validation parity — no LLM cost
// ============================================================================

dtest('test_run_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows/999999999/run', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflows/0/run', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflows/1/run', { json: {}, auth: false })));
});

/**
 * App-key scope gate. Creates a `differential-tmp-` app key for user 3 with a scope that does NOT
 * grant `workflows:run`/`workflows:run:{WORKFLOW_ID}`, calls `POST /workflows/{WORKFLOW_ID}/run`
 * with it via the `AppKey <key>` scheme (NOT `Bearer`, which would fail JWT decode and 401 before
 * the controller's own scope check runs), asserts the response, then hard-deletes the created row
 * by id (`DELETE /app-keys/{id}` is a soft delete, so the row is also purged via direct SQL). PHP
 * first. No LLM cost: the scope check 403s before canUserAccess/run ever fire.
 *
 * KNOWN TS divergence, pinned: the TS AuthMiddleware resolves only JWTs and per-user `uak_` keys —
 * scoped `ak_` app keys are deferred and resolve to no identity (AuthMiddleware.ts header comment;
 * WorkflowController.ts's app-key scope branch is inert), so TS answers the middleware's 401
 * instead of PHP's controller 403. When TS gains scoped app-key auth this pin fails — switch the
 * TS branch to the PHP body then.
 */
dtest.write('test_run_app_key_missing_scope_403_parity', async (hx) => {
  const h = hx.h;
  const body = {
    user_id: DIFF_USER_ID, application_id: 'differential', name: 'differential-tmp-scope-403',
    scopes: ['agents:run:1'], // deliberately no workflows:run scope
  };
  const createdIds: number[] = [];
  try {
    for (const c of [hx.php, hx.ts]) {
      const created = await c.post('/api/v1/app-keys', { json: body, headers: h });
      assert.equal(created.status, 201, created.text);
      const fullKey = created.json().data.full_key;
      const keyId = created.json().data.id;
      createdIds.push(keyId);

      const r = await c.post(`/api/v1/workflows/${WORKFLOW_ID}/run`, { json: {}, headers: { Authorization: `AppKey ${fullKey}` } });
      if (c === hx.php) {
        assert.equal(r.status, 403, r.text);
        // `status_code` is an internal routing key, stripped from the wire body.
        assert.deepStrictEqual(r.json(), {
          success: false,
          error: 'App key not authorized for this workflow (missing scope workflows:run)',
        });
      } else {
        assert.equal(r.status, 401, r.text);
        assert.deepStrictEqual(r.json(), { success: false, message: 'Invalid or expired credential' });
      }

      const deleted = await c.delete(`/api/v1/app-keys/${keyId}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
    }
  } finally {
    if (createdIds.length) {
      await hx.primaryDb.execute(`DELETE FROM app_keys WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds);
    }
  }
});

dtest('test_run_by_name_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows/run', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflows/run', { json: { workflow: '   ' } })));
  same(...(await hx.both('POST', '/api/v1/workflows/run', { json: { workflow: 'no-such-workflow-xyz' } })));
  same(...(await hx.both('POST', '/api/v1/workflows/run', { json: { workflow: 'x' }, auth: false })));
});

dtest('test_tool_result_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows/tool-result', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflows/tool-result', { json: { tool_call_id: 'not-32-hex' } })));
  same(...(await hx.both('POST', '/api/v1/workflows/tool-result', { json: { tool_call_id: 'a'.repeat(32), success: true }, auth: false })));
});

/**
 * SSE endpoint — bare `data:` frames (no `event:` line), terminated by the literal
 * `data: [DONE]\n\n` sentinel on every branch. Compared with sameDataStream (exact decoded payload
 * sequence) since these are deterministic, non-LLM error paths.
 *
 * Unauthenticated is deliberately NOT exercised here: the shared auth middleware rejects it before
 * the controller runs (plain JSON 401, no SSE headers), so runStream's own `if (!$userId)` SSE
 * branch (PHP 871-875) is dead code. Covered by the next case.
 */
dtest('test_run_stream_validation_parity', async (hx) => {
  for (const path of ['/api/v1/workflows/999999999/run-stream', '/api/v1/workflows/0/run-stream']) {
    const ra = await hx.php.post(path, { json: {}, headers: hx.h });
    assert.ok((ra.headers.get('content-type') ?? '').startsWith('text/event-stream'), ra.headers.get('content-type') ?? '');
    const rb = await hx.ts.post(path, { json: {}, headers: hx.h });
    assert.ok((rb.headers.get('content-type') ?? '').startsWith('text/event-stream'), rb.headers.get('content-type') ?? '');
    sameDataStream(ra.text, rb.text);
    const frames = parseDataOnly(ra.text);
    assert.equal(frames[frames.length - 1], '[DONE]');
  }
});

/** A plain JSON 401 from the shared middleware, not an SSE response. */
dtest('test_run_stream_unauthenticated_hits_middleware_not_controller', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows/1/run-stream', { json: {}, auth: false })));
});

/**
 * Unauthenticated hits the same shared auth middleware as runStream before PlaybookNodeRunner's
 * own SSE `event: error` branch (PHP 991-995) is ever reached — plain JSON 401, not SSE.
 */
dtest('test_playbook_node_run_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows/playbook-node/run', { json: {}, auth: false })));
});

// ============================================================================
// MCP JSON-RPC endpoint — no LLM cost
// ============================================================================

dtest('test_mcp_agents_invalid_request_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/mcp/agents', { json: { id: 1, method: 'ping' } })));
  same(...(await hx.both('POST', '/api/v1/mcp/agents', { json: { jsonrpc: '1.0', id: 1, method: 'ping' } })));
  same(...(await hx.both('POST', '/api/v1/mcp/agents', { json: { jsonrpc: '2.0', id: 7, method: 'no/such/method' } })));
});

dtest('test_mcp_agents_initialize_parity', async (hx) => {
  const [a, b] = await hx.both('POST', '/api/v1/mcp/agents', { json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
  assert.deepStrictEqual(b.json(), a.json());
});

/**
 * Full JSON equality: the empty-PHP-array `input_schema` fallback and the `list_available_agents`
 * literal must serialise as `[]`, not `{}` — then the whole response (builtin + MCP + delegation
 * tools) is identical between backends, no field normalised.
 */
dtest('test_mcp_agents_tools_list_parity', async (hx) => {
  const [a, b] = await hx.both('POST', '/api/v1/mcp/agents', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
  assert.deepStrictEqual(b.json(), a.json());
});

// ============================================================================
// Live run — costs LLM calls, runs exactly once per backend. WRITES.
// ============================================================================

dtest.write('test_workflow_run_live_parity', async (hx) => {
  const [a, b] = await hx.both('POST', `/api/v1/workflows/${WORKFLOW_ID}/run`, { json: {} });
  assert.ok(a.status === 200 && b.status === 200, `${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();
  try {
    sameKeys(ja, jb);
    assert.ok(ja.success === true && jb.success === true);
    assert.deepStrictEqual(ja.workflow, { id: WORKFLOW_ID, name: 'Battery News Report' });
    assert.deepStrictEqual(jb.workflow, ja.workflow);
    assert.deepStrictEqual(jb.nodes_executed, ja.nodes_executed);
    sameKeySet(ja.node_outputs, jb.node_outputs);
    sameKeySet(ja.storage, jb.storage);

    const rows: Record<string, any> = {};
    for (const [label, executionId] of [['php', ja.execution_id], ['ts', jb.execution_id]] as const) {
      const row = await hx.primaryDb.fetchOne(
        'SELECT id, workflow_id, user_id, status, error_message, input_variables FROM agent_workflow_executions WHERE id = ?',
        [executionId],
      );
      assert.ok(row !== null, `${label} execution row`);
      rows[label] = row;
    }
    for (const k of ['workflow_id', 'user_id', 'status', 'error_message']) {
      assert.deepStrictEqual(rows.ts[k], rows.php[k], k);
    }
    assert.equal(rows.php.status, 'completed');
    // input_variables: an empty dict (no `variables`/`inputs` in the body) serialises as the JSON
    // array "[]" on both backends (tracker row 121).
    assert.deepStrictEqual(rows.ts.input_variables, rows.php.input_variables);
  } finally {
    await hx.primaryDb.execute('DELETE FROM agent_workflow_executions WHERE id IN (?, ?)', [ja.execution_id, jb.execution_id]);
  }
});
