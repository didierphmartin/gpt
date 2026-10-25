/**
 * Differential tests for WorkflowController — data/CRUD/outputs/node-document paths only — twin of
 * backend_python/tests/differential/test_workflows.py. Execution endpoints live in
 * workflow_run.test.ts.
 *
 * PHP live at http://localhost/gpt/backend, TS in-process. User 3.
 *
 * WRITES: test_workflow_create_show_update_toggle_duplicate_executions_outputs_documents_round_trip
 * (creates, updates, toggles, duplicates and deletes a `differential-tmp-wf` on each backend;
 * self-cleaning). The not-found case's PUT/DELETE/toggle/duplicate target id 999999999 and change
 * nothing, so it stays a read case as in Python.
 */
import { dtest, same, assert } from './harness';

dtest('test_workflows_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflows')));
});

dtest('test_workflows_unauthenticated_401_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflows', { auth: false })));
});

dtest('test_workflow_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflows/999999999')));
  same(...(await hx.both('PUT', '/api/v1/workflows/999999999', { json: { name: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/workflows/999999999')));
  same(...(await hx.both('GET', '/api/v1/workflows/999999999/executions')));
  same(...(await hx.both('POST', '/api/v1/workflows/999999999/toggle')));
  same(...(await hx.both('POST', '/api/v1/workflows/999999999/duplicate')));
  same(...(await hx.both('GET', '/api/v1/workflows/999999999/outputs')));
  same(...(await hx.both('GET', '/api/v1/workflows/999999999/outputs/f.json')));
  same(...(await hx.both('GET', '/api/v1/workflows/999999999/nodes/1/documents')));
  same(...(await hx.both('POST', '/api/v1/workflows/999999999/nodes/1/documents/metadata', { json: { document: { id: 'd', name: 'n' } } })));
  same(...(await hx.both('DELETE', '/api/v1/workflows/999999999/nodes/1/documents/doc_x')));
});

dtest('test_workflow_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflows', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflows', { json: { name: '' } })));
  same(...(await hx.both('POST', '/api/v1/workflows', { json: { name: 'x', steps: [{}] } })));
});

/**
 * 32-zero id: valid runId shape, no such run on either backend. An all-digit runId is exactly the
 * case a numeric-coerced positional route arg would corrupt.
 */
dtest('test_run_events_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflows/runs/' + '0'.repeat(32) + '/events')));
});

dtest('test_run_events_invalid_id_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflows/runs/not-hex-and-wrong-length/events')));
});

/**
 * PHP first, so PHP's on-demand state lands before TS touches the same rows. Delete by the id each
 * backend itself returned (both the original and its duplicate); assert GET /workflows equals the
 * pre-state on that SAME backend afterwards (self-cleaning mutation).
 */
dtest.write('test_workflow_create_show_update_toggle_duplicate_executions_outputs_documents_round_trip', async (hx) => {
  const h = hx.h;
  const steps = [{ id: 's1', type: 'transform' }];

  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/workflows', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/workflows', { json: { name: 'differential-tmp-wf', steps }, headers: h });
    assert.equal(created.status, 201, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    assert.equal(cj.message, 'Workflow created successfully');
    assert.equal(cj.data.name, 'differential-tmp-wf');
    assert.deepStrictEqual(cj.data.steps, steps);
    const wfId = cj.data.id;
    let dupId: unknown = null;

    try {
      const show = await c.get(`/api/v1/workflows/${wfId}`, { headers: h });
      assert.equal(show.status, 200, show.text);
      assert.equal(show.json().data.name, 'differential-tmp-wf');

      const updated = await c.put(`/api/v1/workflows/${wfId}`, { json: { description: 'diff-desc' }, headers: h });
      assert.equal(updated.status, 200, updated.text);
      const uj = updated.json();
      assert.equal(uj.success, true);
      assert.equal(uj.message, 'Workflow updated successfully');
      assert.equal(uj.data.description, 'diff-desc');
      assert.equal(uj.data.name, 'differential-tmp-wf'); // untouched

      const t1 = await c.post(`/api/v1/workflows/${wfId}/toggle`, { headers: h });
      assert.equal(t1.status, 200, t1.text);
      const t1j = t1.json();
      assert.equal(t1j.success, true);
      const t2 = await c.post(`/api/v1/workflows/${wfId}/toggle`, { headers: h });
      assert.equal(t2.status, 200, t2.text);
      const t2j = t2.json();
      assert.notDeepStrictEqual(t1j.data.enabled, t2j.data.enabled);
      assert.deepStrictEqual(new Set([t1j.message, t2j.message]), new Set(['Workflow enabled', 'Workflow disabled']));

      const dup = await c.post(`/api/v1/workflows/${wfId}/duplicate`, { headers: h });
      assert.equal(dup.status, 201, dup.text);
      const dupj = dup.json();
      assert.equal(dupj.success, true);
      assert.equal(dupj.message, 'Workflow duplicated successfully');
      assert.equal(dupj.data.name, 'differential-tmp-wf (Copy)');
      dupId = dupj.data.id;

      const execs = await c.get(`/api/v1/workflows/${wfId}/executions`, { headers: h });
      assert.equal(execs.status, 200, execs.text);
      assert.deepStrictEqual(execs.json(), { success: true, data: [], count: 0 });

      const outs = await c.get(`/api/v1/workflows/${wfId}/outputs`, { headers: h });
      assert.equal(outs.status, 200, outs.text);
      assert.equal(outs.json().success, true);

      // Node id 1 does not belong to this (steps-only, no graph) workflow — exercises the
      // not-found path deterministically (workflow_nodes id=1 does not exist at all).
      const docs = await c.get(`/api/v1/workflows/${wfId}/nodes/1/documents`, { headers: h });
      assert.equal(docs.status, 404, docs.text);
      assert.deepStrictEqual(docs.json(), { success: false, error: 'Node not found' });
    } finally {
      if (dupId !== null) {
        const d1 = await c.delete(`/api/v1/workflows/${dupId}`, { headers: h });
        assert.equal(d1.status, 200, d1.text);
        assert.deepStrictEqual(d1.json(), { success: true, message: 'Workflow deleted successfully' });
      }
      const d2 = await c.delete(`/api/v1/workflows/${wfId}`, { headers: h });
      assert.equal(d2.status, 200, d2.text);
      assert.deepStrictEqual(d2.json(), { success: true, message: 'Workflow deleted successfully' });
    }

    const after = (await c.get('/api/v1/workflows', { headers: h })).json();
    assert.deepStrictEqual(after, before);
  }
});
