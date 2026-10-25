/**
 * Differential tests for TeamController + WorkflowSchemaController — twin of
 * backend_python/tests/differential/test_teams_schemas.py.
 *
 * PHP live at http://localhost/gpt/backend, TS in-process. User 3.
 *
 * WRITES: test_team_create_show_update_agents_delete_round_trip (creates/deletes a tmp team per
 * backend) and test_workflow_schema_create_show_update_delete_round_trip (attempts an INSERT that
 * currently 500s on the live schema; it would write if the table gained `strict`). The not-found
 * PUT/DELETE on id 999999999 touch no row.
 */
import { dtest, same, assert } from './harness';

dtest('test_teams_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/teams')));
});

dtest('test_workflow_schemas_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflow-schemas')));
});

dtest('test_teams_unauthenticated_401', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/teams', { auth: false })));
});

dtest('test_workflow_schemas_unauthenticated_401', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflow-schemas', { auth: false })));
});

dtest('test_team_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/teams/999999999')));
  same(...(await hx.both('PUT', '/api/v1/teams/999999999', { json: { name: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/teams/999999999')));
  same(...(await hx.both('GET', '/api/v1/teams/999999999/agents')));
});

dtest('test_workflow_schema_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/workflow-schemas/999999999')));
  same(...(await hx.both('PUT', '/api/v1/workflow-schemas/999999999', { json: { name: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/workflow-schemas/999999999')));
});

dtest('test_team_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/teams', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/teams', { json: { name: '' } })));
});

dtest('test_workflow_schema_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/workflow-schemas', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/workflow-schemas', { json: { name: 'bad name!' } })));
  same(...(await hx.both('POST', '/api/v1/workflow-schemas', {
    json: { name: 'ok-name', schema_json: { type: 'array', properties: {} } },
  })));
});

/**
 * PHP first, so PHP's on-demand state lands before TS touches the same rows. Delete by the id each
 * backend itself returned; assert GET /teams equals the pre-state on that SAME backend afterwards.
 */
dtest.write('test_team_create_show_update_agents_delete_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/teams', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/teams', { json: { name: 'differential-tmp-team' }, headers: h });
    assert.equal(created.status, 201, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    assert.equal(cj.message, 'Team created successfully');
    assert.equal(cj.data.name, 'differential-tmp-team');
    assert.equal(cj.data.description, '');
    const teamId = cj.data.id;

    try {
      const show = await c.get(`/api/v1/teams/${teamId}`, { headers: h });
      assert.equal(show.status, 200, show.text);
      const sj = show.json();
      assert.equal(sj.success, true);
      assert.equal(sj.data.name, 'differential-tmp-team');
      assert.deepStrictEqual(sj.data.agents, []);

      const updated = await c.put(`/api/v1/teams/${teamId}`, { json: { description: 'diff-desc' }, headers: h });
      assert.equal(updated.status, 200, updated.text);
      const uj = updated.json();
      assert.equal(uj.success, true);
      assert.equal(uj.message, 'Team updated successfully');
      assert.equal(uj.data.description, 'diff-desc');
      assert.equal(uj.data.name, 'differential-tmp-team'); // untouched

      const agents = await c.get(`/api/v1/teams/${teamId}/agents`, { headers: h });
      assert.equal(agents.status, 200, agents.text);
      assert.deepStrictEqual(agents.json(), { success: true, data: [], count: 0 });
    } finally {
      const deleted = await c.delete(`/api/v1/teams/${teamId}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepStrictEqual(deleted.json(), { success: true, message: 'Team deleted successfully' });
    }

    const after = (await c.get('/api/v1/teams', { headers: h })).json();
    assert.deepStrictEqual(after, before);
  }
});

/**
 * PHP first; assert GET /workflow-schemas equals the pre-state on that SAME backend afterwards.
 *
 * KNOWN LIVE-DB GAP (not a porting defect): the live `workflow_schemas` table has no `strict`
 * column (nor `updated_at`), while WorkflowSchemaRepository::create/update write `strict`
 * unconditionally. So POST /workflow-schemas 500s on PHP live today, and the TS port (same INSERT
 * column list; WorkflowSchemaController returns the mysql2 message, "Unknown column 'strict' ...")
 * 500s the same way. This asserts parity on that failure; if the live schema gains `strict`
 * (+ `updated_at`), extend it back to the full round trip.
 */
dtest.write('test_workflow_schema_create_show_update_delete_round_trip', async (hx) => {
  const h = hx.h;
  const schemaJson = { type: 'object', properties: { foo: { type: 'string' } } };
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/workflow-schemas', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/workflow-schemas', {
      json: { name: 'differential-tmp-schema', schema_json: schemaJson, strict: true }, headers: h,
    });
    assert.equal(created.status, 500, created.text);
    const cj = created.json();
    assert.equal(cj.success, false);
    assert.ok(String(cj.error).includes("'strict'"), cj.error);

    const after = (await c.get('/api/v1/workflow-schemas', { headers: h })).json();
    assert.deepStrictEqual(after, before); // the failed insert left no trace
  }
});
