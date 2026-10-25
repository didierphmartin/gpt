/**
 * Differential tests for AgentController — twin of backend_python/tests/differential/test_agents.py.
 *
 * PHP live at DIFF_PHP_BASE, TS in-process. User 3.
 *
 * WRITES (dtest.write): test_agent_create_show_update_duplicate_delete_round_trip and
 * test_agent_categories_round_trip (create/update/delete tmp agents, self-cleaning). The
 * not-found PUT/DELETE/duplicate/move on id 999999999 and the reorder/rename validation cases
 * match no row and stay read cases, as in Python.
 */
import { dtest, same, assert } from './harness';

dtest('test_agents_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/agents')));
});

dtest('test_agents_tools_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/agents/tools')));
});

dtest('test_agents_categories_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/agents/categories')));
});

dtest('test_agent_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/agents/999999999')));
  same(...(await hx.both('PUT', '/api/v1/agents/999999999', { json: { name: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/agents/999999999')));
  same(...(await hx.both('POST', '/api/v1/agents/999999999/duplicate')));
  same(...(await hx.both('POST', '/api/v1/agents/999999999/move-up')));
  same(...(await hx.both('POST', '/api/v1/agents/999999999/move-down')));
  same(...(await hx.both('GET', '/api/v1/agents/999999999/executions')));
});

dtest('test_agent_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/agents', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/agents', { json: { name: '' } })));
  same(...(await hx.both('POST', '/api/v1/agents', { json: { name: 'x', agent_type: 'bogus' } })));
  same(...(await hx.both('POST', '/api/v1/agents', { json: { name: 'x', visibility: 'bogus' } })));
});

dtest('test_agent_categories_rename_validation_parity', async (hx) => {
  same(...(await hx.both('PUT', '/api/v1/agents/categories/rename', { json: {} })));
  same(...(await hx.both('PUT', '/api/v1/agents/categories/rename', { json: { old_name: 'a' } })));
  same(...(await hx.both('PUT', '/api/v1/agents/categories/rename', { json: { old_name: 'same', new_name: 'same' } })));
});

dtest('test_agent_categories_delete_validation_parity', async (hx) => {
  same(...(await hx.both('DELETE', '/api/v1/agents/categories', { json: {} })));
});

dtest('test_agent_reorder_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/agents/reorder', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/agents/reorder', { json: { team_id: 1 } })));
  same(...(await hx.both('POST', '/api/v1/agents/reorder', { json: { team_id: 1, agent_ids: [] } })));
  // An agent id owned by someone else / nonexistent -> 403 access-denied parity.
  same(...(await hx.both('POST', '/api/v1/agents/reorder', { json: { team_id: 1, agent_ids: [999999999] } })));
});

dtest('test_agents_unauthenticated_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/agents', { auth: false })));
  same(...(await hx.both('GET', '/api/v1/agents/tools', { auth: false })));
});

/**
 * PHP first, so PHP's on-demand state lands before TS touches the same rows. Delete by the id each
 * backend itself returned; assert GET /agents equals the pre-state on that SAME backend afterwards.
 */
dtest.write('test_agent_create_show_update_duplicate_delete_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/agents', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/agents', {
      json: { name: 'differential-tmp-agent', provider: 'claude', instructions: 'x' }, headers: h,
    });
    assert.equal(created.status, 200, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    assert.equal(cj.message, "Agent 'differential-tmp-agent' created successfully");
    assert.equal(cj.data.name, 'differential-tmp-agent');
    assert.equal(cj.data.provider, 'claude');
    assert.equal(cj.data.instructions, 'x');
    assert.equal(cj.data.agent_type, 'standard');
    assert.equal(cj.data.visibility, 'personal');
    const agentId = cj.data.id;
    let duplicateId: number | null = null;

    try {
      const show = await c.get(`/api/v1/agents/${agentId}`, { headers: h });
      assert.equal(show.status, 200, show.text);
      const sj = show.json();
      assert.equal(sj.success, true);
      assert.equal(sj.data.name, 'differential-tmp-agent');

      const updated = await c.put(`/api/v1/agents/${agentId}`, { json: { description: 'diff-desc' }, headers: h });
      assert.equal(updated.status, 200, updated.text);
      const uj = updated.json();
      assert.equal(uj.success, true);
      assert.equal(uj.message, "Agent 'differential-tmp-agent' updated successfully");
      assert.equal(uj.data.description, 'diff-desc');
      assert.equal(uj.data.name, 'differential-tmp-agent'); // untouched

      const executions = await c.get(`/api/v1/agents/${agentId}/executions`, { headers: h });
      assert.equal(executions.status, 200, executions.text);
      assert.deepStrictEqual(executions.json(), { success: true, data: [], meta: { count: 0, limit: 50, offset: 0 } });

      const dup = await c.post(`/api/v1/agents/${agentId}/duplicate`, { headers: h });
      assert.equal(dup.status, 200, dup.text);
      const dj = dup.json();
      assert.equal(dj.success, true);
      assert.equal(dj.message, 'Agent duplicated successfully');
      assert.equal(dj.data.name, 'differential-tmp-agent (Copy)');
      assert.equal(dj.data.description, 'diff-desc');
      duplicateId = dj.data.id;
    } finally {
      const deleted = await c.delete(`/api/v1/agents/${agentId}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
      assert.deepStrictEqual(deleted.json(), { success: true, message: "Agent 'differential-tmp-agent' deleted successfully" });
      if (duplicateId !== null) {
        const deletedDup = await c.delete(`/api/v1/agents/${duplicateId}`, { headers: h });
        assert.equal(deletedDup.status, 200, deletedDup.text);
        assert.deepStrictEqual(deletedDup.json(), { success: true, message: "Agent 'differential-tmp-agent (Copy)' deleted successfully" });
      }
    }

    assert.deepStrictEqual((await c.get('/api/v1/agents', { headers: h })).json(), before);
  }
});

/**
 * PHP first; create an agent under a temp category, rename it, then clear it (agents fall back to
 * Uncategorized), delete the agent, and assert GET /agents/categories equals the pre-state on that
 * SAME backend afterwards.
 */
dtest.write('test_agent_categories_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/agents/categories', { headers: h })).json();
    assert.equal(before.success, true);

    const a1 = await c.post('/api/v1/agents', { json: { name: 'differential-tmp-agent-cat', category: 'differential-tmp-cat' }, headers: h });
    assert.equal(a1.status, 200, a1.text);
    const agentId = a1.json().data.id;
    assert.equal(a1.json().data.category, 'differential-tmp-cat');

    try {
      const renamed = await c.put('/api/v1/agents/categories/rename', {
        json: { old_name: 'differential-tmp-cat', new_name: 'differential-tmp-cat-2' }, headers: h,
      });
      assert.equal(renamed.status, 200, renamed.text);
      assert.deepStrictEqual(renamed.json(), {
        success: true, data: { affected: 1, old_name: 'differential-tmp-cat', new_name: 'differential-tmp-cat-2' },
      });

      const cleared = await c.request('DELETE', '/api/v1/agents/categories', { json: { name: 'differential-tmp-cat-2' }, headers: h });
      assert.equal(cleared.status, 200, cleared.text);
      assert.deepStrictEqual(cleared.json(), { success: true, data: { affected: 1, name: 'differential-tmp-cat-2' } });

      const show = await c.get(`/api/v1/agents/${agentId}`, { headers: h });
      assert.equal(show.json().data.category, null);
    } finally {
      const deleted = await c.delete(`/api/v1/agents/${agentId}`, { headers: h });
      assert.equal(deleted.status, 200, deleted.text);
    }

    assert.deepStrictEqual((await c.get('/api/v1/agents/categories', { headers: h })).json(), before);
  }
});
