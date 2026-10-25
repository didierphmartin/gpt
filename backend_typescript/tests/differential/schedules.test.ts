/**
 * Differential tests for ScheduledWorkflowController + SchedulerController — twin of
 * backend_python/tests/differential/test_schedules.py.
 *
 * PHP live at http://localhost/gpt/backend, TS in-process. User 3.
 *
 * WORKFLOW_ID = 18 ("test 4") -- user 3's shortest-named workflow, used only as the schedule's
 * `workflow_id` FK target; the workflow itself is never run.
 *
 * Every created schedule uses `scheduled_time` far in the future (2099-01-01) so `next_run` can
 * never satisfy `getDueSchedules()`'s `next_run <= NOW()` filter -- this suite must never trigger a
 * real scheduled workflow run. `/scheduler/run` itself is exercised ONLY with no/invalid token
 * (auth: false), so it always 401s before `executeScheduler()` is ever called.
 *
 * WRITES: only test_schedule_create_show_update_pause_resume_delete_round_trip (creates a
 * far-future schedule per backend and deletes it). The not-found PUT/DELETE/pause/resume on id
 * 999999999 touch no row.
 */
import { dtest, same, assert } from './harness';

const WORKFLOW_ID = 18;
const FAR_FUTURE = '2099-01-01 00:00:00';

// ─── read-only listing parity ───────────────────────────────────────────────

dtest('test_schedules_list_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/schedules')));
});

dtest('test_schedules_list_unauthenticated_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/schedules', { auth: false })));
});

dtest('test_schedules_stats_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/schedules/stats')));
});

dtest('test_schedules_by_workflow_parity', async (hx) => {
  same(...(await hx.both('GET', `/api/v1/workflows/${WORKFLOW_ID}/schedules`)));
});

dtest('test_schedule_not_found_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/schedules/999999999')));
  same(...(await hx.both('PUT', '/api/v1/schedules/999999999', { json: { input_prompt: 'x' } })));
  same(...(await hx.both('DELETE', '/api/v1/schedules/999999999')));
  same(...(await hx.both('POST', '/api/v1/schedules/999999999/pause')));
  same(...(await hx.both('POST', '/api/v1/schedules/999999999/resume')));
});

dtest('test_schedule_create_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/schedules', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/schedules', { json: { workflow_id: WORKFLOW_ID } })));
  same(...(await hx.both('POST', '/api/v1/schedules', { json: { workflow_id: 999999999, scheduled_time: FAR_FUTURE } })));
  same(...(await hx.both('POST', '/api/v1/schedules', {
    json: { workflow_id: WORKFLOW_ID, scheduled_time: FAR_FUTURE, repeat_type: 'yearly' },
  })));
});

// ─── round trip — WRITES ────────────────────────────────────────────────────
// create (far-future, can never become due) -> show -> update -> pause -> resume -> pause ->
// delete. PHP first, self-cleaning, lists equal pre-state afterwards on the SAME backend.

dtest.write('test_schedule_create_show_update_pause_resume_delete_round_trip', async (hx) => {
  const h = hx.h;
  for (const c of [hx.php, hx.ts]) {
    const before = (await c.get('/api/v1/schedules', { headers: h })).json();
    assert.equal(before.success, true);

    const created = await c.post('/api/v1/schedules', {
      json: { workflow_id: WORKFLOW_ID, scheduled_time: FAR_FUTURE, input_prompt: 'differential-tmp', repeat_type: 'none' },
      headers: h,
    });
    assert.equal(created.status, 201, created.text);
    const cj = created.json();
    assert.equal(cj.success, true);
    assert.equal(cj.message, 'Schedule created successfully');
    assert.equal(cj.data.workflow_id, WORKFLOW_ID);
    assert.equal(cj.data.status, 'pending');
    const scheduleId = cj.data.id;

    try {
      const show = await c.get(`/api/v1/schedules/${scheduleId}`, { headers: h });
      assert.equal(show.status, 200, show.text);
      assert.equal(show.json().data.input_prompt, 'differential-tmp');

      const updated = await c.put(`/api/v1/schedules/${scheduleId}`, { json: { input_prompt: 'differential-tmp-updated' }, headers: h });
      assert.equal(updated.status, 200, updated.text);
      const uj = updated.json();
      assert.equal(uj.success, true);
      assert.equal(uj.message, 'Schedule updated successfully');
      assert.equal(uj.data.input_prompt, 'differential-tmp-updated');

      const p1 = await c.post(`/api/v1/schedules/${scheduleId}/pause`, { headers: h });
      assert.equal(p1.status, 200, p1.text);
      assert.deepStrictEqual(p1.json(), { success: true, message: 'Schedule paused successfully' });
      assert.equal((await c.get(`/api/v1/schedules/${scheduleId}`, { headers: h })).json().data.status, 'paused');

      const r1 = await c.post(`/api/v1/schedules/${scheduleId}/resume`, { headers: h });
      assert.equal(r1.status, 200, r1.text);
      assert.deepStrictEqual(r1.json(), { success: true, message: 'Schedule resumed successfully' });
      assert.equal((await c.get(`/api/v1/schedules/${scheduleId}`, { headers: h })).json().data.status, 'pending');

      const p2 = await c.post(`/api/v1/schedules/${scheduleId}/pause`, { headers: h });
      assert.equal(p2.status, 200, p2.text);
      assert.equal((await c.get(`/api/v1/schedules/${scheduleId}`, { headers: h })).json().data.status, 'paused');

      // Already paused: resume() again should succeed a second time too.
      const r2 = await c.post(`/api/v1/schedules/${scheduleId}/resume`, { headers: h });
      assert.equal(r2.status, 200, r2.text);

      const byWf = await c.get(`/api/v1/workflows/${WORKFLOW_ID}/schedules`, { headers: h });
      assert.equal(byWf.status, 200, byWf.text);
      assert.ok(byWf.json().data.map((s: any) => s.id).includes(scheduleId));
    } finally {
      const d = await c.delete(`/api/v1/schedules/${scheduleId}`, { headers: h });
      assert.equal(d.status, 200, d.text);
      assert.deepStrictEqual(d.json(), { success: true, message: 'Schedule deleted successfully' });
    }

    const after = (await c.get('/api/v1/schedules', { headers: h })).json();
    assert.deepStrictEqual(after, before);
  }
});

// ─── scheduler: run() ONLY with no/invalid token, so it always 401s ─────────

dtest('test_scheduler_run_no_token_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/scheduler/run', { json: {}, auth: false })));
});

dtest('test_scheduler_run_invalid_token_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/scheduler/run', { json: { token: 'definitely-wrong-differential-token' }, auth: false })));
});

dtest('test_scheduler_status_parity', async (hx) => {
  const a = await hx.php.get('/api/v1/scheduler/status', { headers: hx.h });
  const b = await hx.ts.get('/api/v1/scheduler/status', { headers: hx.h });
  assert.ok(a.status === 200 && b.status === 200, `${a.text}\n${b.text}`);
  const ja = a.json();
  const jb = b.json();
  // Wall-clock field -- compared for shape, not value.
  delete ja.data?.server_time;
  delete jb.data?.server_time;
  assert.deepStrictEqual(jb, ja);
});

dtest('test_scheduler_status_unauthenticated_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/scheduler/status', { auth: false })));
});
