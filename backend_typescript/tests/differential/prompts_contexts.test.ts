/**
 * PromptLibraryController + ContextController PHP-vs-TS differential — twin of
 * backend_python/tests/differential/test_prompts_contexts.py.
 *
 * WRITES: test_prompt_crud_round_trip_each_backend (creates/updates/deletes a folder + prompt on
 * each backend) and test_context_round_trip_each_backend (creates/updates/deletes a context on
 * each backend); both self-cleaning. The two 404 cases target id 999999999 / invalid bodies and
 * change nothing.
 */
import { dtest, same, assert } from './harness';

dtest('test_prompt_tree_and_404s', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/prompts')));
  same(...(await hx.both('GET', '/api/v1/prompts/999999999')));
  same(...(await hx.both('PUT', '/api/v1/prompts/999999999', { json: { name: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/prompts/999999999')));
  same(...(await hx.both('POST', '/api/v1/prompts', { json: { type: 'x', name: 'n' } })));
  same(...(await hx.both('POST', '/api/v1/prompts', { json: { type: 'prompt' } })));
  same(...(await hx.both('POST', '/api/v1/prompts', { json: { type: 'prompt', name: 'n', parent_id: 999999999 } })));
});

dtest.write('test_prompt_crud_round_trip_each_backend', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const r = await c.post('/api/v1/prompts', { json: { type: 'folder', name: 'diff-folder' }, headers: h });
    assert.ok(r.status === 200 && typeof r.json().data.id === 'string', `${c.label}: ${r.text}`);
    const fid = parseInt(r.json().data.id, 10);
    try {
      const r2 = await c.post('/api/v1/prompts', { json: { type: 'prompt', name: 'p', content: 'c/é', parent_id: fid }, headers: h });
      const pid = parseInt(r2.json().data.id, 10);
      const got = (await c.get(`/api/v1/prompts/${pid}`, { headers: h })).json().data;
      assert.ok(got.content === 'c/é' && got.parent_id === fid, `${c.label}: ${JSON.stringify(got)}`);
      assert.equal((await c.put(`/api/v1/prompts/${pid}`, { json: { content: 'c2' }, headers: h })).json().message, 'Prompt updated successfully');
      assert.equal((await c.put(`/api/v1/prompts/${pid}`, { json: {}, headers: h })).status, 400);
      const tree = (await c.get('/api/v1/prompts', { headers: h })).json().data;
      const folder = tree.find((n: any) => n.id === fid);
      assert.equal(folder.children[0].id, pid);
      assert.equal((await c.delete(`/api/v1/prompts/${pid}`, { headers: h })).json().message, 'Prompt deleted successfully');
    } finally {
      await c.delete(`/api/v1/prompts/${fid}`, { headers: h });
    }
  }
});

dtest('test_context_list_and_404s', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/contexts')));
  same(...(await hx.both('GET', '/api/v1/contexts/999999999')));
  same(...(await hx.both('PUT', '/api/v1/contexts/999999999', { json: { title: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/contexts/999999999')));
  same(...(await hx.both('POST', '/api/v1/contexts', { json: { messages: [] } })));
  same(...(await hx.both('PUT', '/api/v1/contexts/1', { json: { title: ' ' } })));
});

dtest.write('test_context_round_trip_each_backend', async (hx) => {
  const h = hx.h;
  const msgs = [{ role: 'user', content: 'hello/é' }, { role: 'assistant', content: 'hi', provider: 'claude' }];
  for (const c of [hx.php, hx.ts]) {
    const r = await c.post('/api/v1/contexts', { json: { messages: msgs, metadata: { m: 1 } }, headers: h });
    assert.ok(r.status === 200 && Number.isInteger(r.json().data.id), `${c.label}: ${r.text}`);
    const cid = r.json().data.id;
    try {
      const got = (await c.get(`/api/v1/contexts/${cid}`, { headers: h })).json().data;
      assert.ok(got.title === 'hello/é' && got.provider === 'claude' && got.message_count === 2, `${c.label}: ${JSON.stringify(got)}`);
      assert.deepStrictEqual(got.context_data, { messages: msgs, metadata: { m: 1 } });
      assert.equal((await c.put(`/api/v1/contexts/${cid}`, { json: { title: 'renamed' }, headers: h })).status, 200);
      // Live PHP does not set PDO::MYSQL_ATTR_FOUND_ROWS (index.php only passes ATTR_ERRMODE /
      // ATTR_DEFAULT_FETCH_MODE / ATTR_EMULATE_PREPARES), so MySQL reports 0 affected rows for a
      // no-op UPDATE and PHP returns 404. The TS port's mysql2 pool must match that (unflagged)
      // behaviour: mysql2 sets CLIENT_FOUND_ROWS by default unless the flag is turned off, so a
      // failure here on the TS side is the FOUND_ROWS divergence, not a test bug.
      assert.equal((await c.put(`/api/v1/contexts/${cid}`, { json: { title: 'renamed' }, headers: h })).status, 404, c.label);
      const up = await c.post('/api/v1/contexts', { json: { id: cid, messages: [...msgs, { role: 'user', content: 'x' }] }, headers: h });
      assert.equal(up.json().message, 'Context updated successfully');
    } finally {
      assert.equal((await c.delete(`/api/v1/contexts/${cid}`, { headers: h })).status, 200);
    }
  }
});
