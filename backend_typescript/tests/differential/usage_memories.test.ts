/**
 * UsageController + UserMemoryController PHP-vs-TS differential — twin of
 * backend_python/tests/differential/test_usage_memories.py.
 *
 * WRITES: test_user_memories_put_round_trip_leaves_content_unchanged (PUTs user 3's memory content
 * back unchanged on each backend — an UPDATE, possibly a memory-history event). Everything else is
 * read-only (the DELETE targets a non-existent event id).
 */
import { dtest, same, assert } from './harness';

dtest('test_usage_routes_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/usage')));
  same(...(await hx.both('GET', '/api/v1/usage/balance')));
  same(...(await hx.both('GET', '/api/v1/usage/transactions?limit=5')));
  same(...(await hx.both('GET', '/api/v1/usage/stats')));
});

dtest('test_user_memories_routes_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/user-memories')));
  same(...(await hx.both('GET', '/api/v1/user-memories/events?limit=5')));
});

dtest('test_usage_unauthenticated_401', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/usage', { auth: false })));
});

dtest('test_user_memories_unauthenticated_401', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/user-memories', { auth: false })));
});

dtest('test_user_memories_delete_event_not_found_parity', async (hx) => {
  same(...(await hx.both('DELETE', '/api/v1/user-memories/events/999999999')));
});

/** PUT the same content back must be a no-op: user 3's memory content is identical before and after, on both backends. */
dtest.write('test_user_memories_put_round_trip_leaves_content_unchanged', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/user-memories', { headers: h })).json();
    assert.equal(before.success, true, JSON.stringify(before));
    const memContent = before.data.memory.content;
    const userContent = before.data.user.content;

    const r = await c.put('/api/v1/user-memories', { json: { memory: memContent, user: userContent }, headers: h });
    assert.ok(r.status === 200 && r.json().success === true, r.text);

    const after = (await c.get('/api/v1/user-memories', { headers: h })).json();
    assert.equal(after.data.memory.content, memContent);
    assert.equal(after.data.user.content, userContent);
    assert.deepStrictEqual(after.data.memory.budget, before.data.memory.budget);
    assert.deepStrictEqual(after.data.user.budget, before.data.user.budget);
  }
});
