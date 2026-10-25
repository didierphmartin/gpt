import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installSchedulerDb, handlerFor, eventWorkerSchema, workflow, option, row, WATCH, fmt, SchedDb } from './support/schedulerDb';
import { installFakeDb } from './support/fakeDb';
import { ActiveWorkflowError, ActiveWorkflowService } from '../src/AgentTeam/ActiveWorkflowService';
import { ActiveWorkflowController } from '../src/Controllers/ActiveWorkflowController';
import { ScheduledWorkflowController } from '../src/Controllers/ScheduledWorkflowController';
import { EventWorker, RunSpawner, WatchTransport } from '../src/AgentTeam/EventWorker';
import { ProcRunSpawner } from '../src/AgentTeam/EventWorkerIO';
import { WatchCall } from '../src/AgentTeam/WatchCall';
import { LiveFeed, LiveStream } from '../src/AgentTeam/LiveFeed';
import { WorkflowRunLog } from '../src/AgentTeam/WorkflowRunLog';
import { WorkflowController } from '../src/Controllers/WorkflowController';

/**
 * Twins of backend/tests/Unit/EventWorker (ActiveWorkflowServiceTest, ActiveWorkflowControllerTest,
 * EventWorkerTest, WatchCallTest, ProcRunSpawnerTest), LiveFeedTest and LiveStreamTest, plus
 * POST /workflows/run and GET /workflows/{id}/live. SQLite in memory with NOW() from the test's clock.
 */

const ctx = (userId: number | null, params: Record<string, any> = {}, extra: Record<string, any> = {}): any =>
  ({ user_id: userId, params, query: {}, headers: {}, body: {}, ...extra });

// ---- ActiveWorkflowService ----

function activeSetup() {
  const clock = { now: '2026-10-14 09:00:00' };
  const d = installSchedulerDb(() => clock.now);
  eventWorkerSchema(d);
  option(d, 1, 3);
  return { d, clock, svc: () => new ActiveWorkflowService() };
}
async function refused(p: Promise<any>): Promise<ActiveWorkflowError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActiveWorkflowError) return e;
    throw e;
  }
  throw new Error('expected ActiveWorkflowError');
}

test('active: the mode is the newest live row; a paused row is no mode; an event row off its option is mode_gone', async () => {
  const { d, svc } = activeSetup();
  workflow(d, 64, 3, 1);
  assert.equal((await svc().mode(64)).mode, 'prompt');
  row(d, 64, 3, 'daily');
  assert.equal((await svc().mode(64)).mode, 'schedule');
  const id = row(d, 64, 3, 'event', 1);
  const m = await svc().mode(64);
  assert.deepEqual([m.mode, Number(m.schedule!.id), m.component_id], ['option', id, 1]);

  workflow(d, 65, 3, 1);
  row(d, 65, 3, 'event', 1, 'paused');
  assert.equal((await svc().mode(65)).mode, 'prompt');

  workflow(d, 62, 3, null); // Start on Enter Prompt, row left behind
  row(d, 62, 3, 'event', 1);
  assert.equal((await svc().mode(62)).mode, 'mode_gone');
  d.exec(`UPDATE workflow_nodes SET config = '{"type":"start","start_option":1}' WHERE node_type = 'start' AND workflow_id = 62`);
  d.exec('UPDATE code_components SET start_trigger = NULL');
  assert.equal((await svc().mode(62)).mode, 'mode_gone');
});

test('active: activate an option workflow; another replaces it; refusals', async () => {
  const { d, svc } = activeSetup();
  workflow(d, 64, 3, 1);
  assert.deepEqual(await refused(svc().activate(3, 64)).then((e) => [e.kind, e.status]), ['no_trigger', 422]);
  row(d, 64, 3, 'event', 1);
  const r = await svc().activate(3, 64);
  assert.equal(r.replaced, null);
  assert.deepEqual([Number(r.active!.workflow_id), r.active!.mode, Number(r.active!.trigger_component_id), r.active!.watch_state],
    [64, 'option', 1, 'starting']);
  assert.equal(r.active!.workflow_name, 'wf 64');
  workflow(d, 70, 3, null);
  row(d, 70, 3, 'daily');
  const r2 = await svc().activate(3, 70);
  assert.deepEqual(r2.replaced, { workflow_id: 64, workflow_name: 'wf 64' });
  assert.equal((await svc().get(3))!.mode, 'schedule');
  assert.equal((d.prepare('SELECT COUNT(*) AS c FROM active_workflows').get() as any).c, 1);

  workflow(d, 65, 3, 1, false); // no links
  row(d, 65, 3, 'event', 1);
  assert.equal((await refused(svc().activate(3, 65))).kind, 'no_links');
  assert.equal((await refused(svc().activate(4, 64))).kind, 'not_found', 'not the owner');
  assert.equal((await refused(svc().activate(3, 999))).kind, 'not_found');
});

test('active: deactivate only that workflow; the sweep deactivates on a mode or option change', async () => {
  const { d, svc } = activeSetup();
  workflow(d, 64, 3, 1);
  const r = row(d, 64, 3, 'event', 1);
  await svc().activate(3, 64);
  await svc().deactivate(3, 70);
  assert.notEqual(await svc().get(3), null);
  assert.deepEqual(await svc().sweep(), []);
  d.prepare('DELETE FROM scheduled_workflows WHERE id = ?').run(r); // switched to Enter Prompt
  assert.deepEqual(await svc().sweep(), [64]);
  assert.equal(await svc().get(3), null);

  option(d, 2, 3);
  row(d, 64, 3, 'event', 1);
  await svc().activate(3, 64);
  d.exec(`UPDATE workflow_nodes SET config = '{"type":"start","start_option":2}' WHERE workflow_id = 64 AND node_type = 'start'`);
  row(d, 64, 3, 'event', 2);
  assert.deepEqual(await svc().sweep(), [64]);
});

test('active: check reasons, state and ages', async () => {
  const { d, clock, svc } = activeSetup();
  workflow(d, 64, 3, 1);
  row(d, 64, 3, 'event', 1);
  await svc().activate(3, 64);
  const first = async () => (await svc().all())[0];
  assert.deepEqual(await svc().check(await first()).then((c) => [c.ok, c.reason]), [true, null]);
  assert.equal((await svc().get(3))!.checked_age_s, null);
  clock.now = '2026-10-14 09:00:40';
  await svc().setState(3, 'waiting', 'fallback');
  clock.now = '2026-10-14 09:01:00';
  const a = (await svc().get(3))!;
  assert.deepEqual([a.watch_state, a.watch_message, a.checked_age_s, a.activated_age_s], ['waiting', 'fallback', 20, 60]);
  d.exec('DELETE FROM workflow_edges');
  assert.equal((await svc().check(await first())).reason, 'no_links');
  d.exec('UPDATE agent_workflows SET enabled = 0');
  assert.equal((await svc().check(await first())).reason, 'disabled');
});

test('active: scheduleWorkflowIds skips rows that do not qualify; deleting the workflow cascades', async () => {
  const { d, svc } = activeSetup();
  workflow(d, 70, 3, null);
  row(d, 70, 3, 'daily');
  await svc().activate(3, 70);
  workflow(d, 71, 4, null);
  row(d, 71, 4, 'daily');
  await svc().activate(4, 71);
  assert.deepEqual(await svc().scheduleWorkflowIds(), [70, 71]);
  d.exec('UPDATE agent_workflows SET enabled = 0 WHERE id = 70');
  d.exec('DELETE FROM workflow_edges WHERE workflow_id = 71');
  assert.deepEqual(await svc().scheduleWorkflowIds(), []);
  d.exec('UPDATE agent_workflows SET enabled = 1 WHERE id = 70');
  assert.deepEqual(await svc().scheduleWorkflowIds(), [70]);
  d.exec('DELETE FROM agent_workflows WHERE id = 70');
  assert.equal(await svc().get(3), null);
});

// ---- ActiveWorkflowController + the schedule controller's sweep ----

test('controller: activate, show, deactivate; a refusal carries its kind; authentication is required', async () => {
  const { d } = activeSetup();
  workflow(d, 64, 3, 1);
  const c = new ActiveWorkflowController();
  const refusedR = await c.activate(ctx(3, { id: '64' }));
  assert.deepEqual([refusedR.success, refusedR.kind, refusedR.status_code], [false, 'no_trigger', 422]);
  row(d, 64, 3, 'event', 1);
  const r = await c.activate(ctx(3, { id: '64' }));
  assert.deepEqual([r.success, r.status_code, Number(r.data.active.workflow_id)], [true, 200, 64]);
  assert.equal(Number((await c.show(ctx(3))).data.workflow_id), 64);
  assert.equal((await c.deactivate(ctx(3, { id: '64' }))).status_code, 200);
  assert.equal((await c.show(ctx(3))).data, null);
  assert.deepEqual(await c.show(ctx(null)), { success: false, error: 'Authentication required', status_code: 401 });
});

test('controller: deleting the event row deactivates; a failing sweep does not fail the write', async () => {
  const { d } = activeSetup();
  workflow(d, 64, 3, 1);
  let r = row(d, 64, 3, 'event', 1);
  await new ActiveWorkflowService().activate(3, 64);
  const res = await new ScheduledWorkflowController().destroy(ctx(3, { id: String(r) }));
  assert.equal(res.success, true);
  assert.equal(await new ActiveWorkflowService().get(3), null);

  r = row(d, 64, 3, 'event', 1);
  d.exec('DROP TABLE active_workflows'); // not migrated yet
  const errors: any[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => { errors.push(a); };
  try {
    const res2 = await new ScheduledWorkflowController().destroy(ctx(3, { id: String(r) }));
    assert.equal(res2.success, true);
  } finally {
    console.error = orig;
  }
  assert.equal((d.prepare('SELECT COUNT(*) AS c FROM scheduled_workflows WHERE id = ?').get(r) as any).c, 0);
  assert.match(String(errors[0]?.[0]), /\[ActiveWorkflow\] sweep failed/);
});

// ---- EventWorker ----

class FakeTransport implements WatchTransport {
  open = new Map<number, string>();
  answers = new Map<number, [string | false, number, string]>();
  started = 0;
  start(key: number, _url: string, _headers: string[], body: string) { this.open.set(key, body); this.started++; }
  cancel(key: number) { this.open.delete(key); }
  done() {
    const out = new Map<number, [string | false, number, string]>();
    for (const [k, a] of this.answers) {
      if (this.open.has(k)) {
        out.set(k, a);
        this.open.delete(k);
      }
    }
    this.answers = new Map();
    return out;
  }
  answer(key: number, payload: any) {
    this.answers.set(key, [JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: payload } }), 200, '']);
  }
}

class FakeRuns implements RunSpawner {
  started: Array<[number, number]> = [];
  ended = new Map<number, number>();
  ticks = 0;
  start(key: number, scheduleId: number) { this.started.push([key, scheduleId]); }
  done() { const d = this.ended; this.ended = new Map(); return d; }
  scheduleTick() { this.ticks++; }
}

function workerSetup(opts: { log?: (l: string) => void; runs?: RunSpawner; serverFor?: (u: number, n: string) => any } = {}) {
  const t = { now: 1000.0 };
  const d = installSchedulerDb(() => fmt(new Date(Math.trunc(t.now) * 1000)));
  eventWorkerSchema(d);
  option(d, 1, 3);
  workflow(d, 64, 3, 1);
  const r = row(d, 64, 3, 'event', 1);
  d.exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (3, 'Outlook', 'http://fake/mcp', '{}')");
  const tr = new FakeTransport();
  const runs = new FakeRuns();
  const w = new EventWorker(new ActiveWorkflowService(), opts.serverFor ?? ((u, n) => WatchCall.server(u, n)), tr, opts.runs ?? runs,
    () => t.now, opts.log ?? null);
  const step = async (after = 0) => { t.now += after; await w.step(); };
  const state = (user = 3) => {
    const s = d.prepare('SELECT watch_state, watch_message FROM active_workflows WHERE user_id = ?').get(user) as any;
    return s ? [s.watch_state, s.watch_message] : [];
  };
  const active = (user = 3, wf = 64) => new ActiveWorkflowService().activate(user, wf);
  const user4 = () => {
    option(d, 2, 4);
    workflow(d, 80, 4, 2);
    row(d, 80, 4, 'event', 2);
    d.exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (4, 'Outlook', 'http://fake4/mcp', '{}')");
  };
  const running = async () => {
    await active();
    await step();
    tr.answer(3, { status: 'ready' });
    await step(1);
    assert.equal(w.slots()[3].state, 'running');
  };
  const editWatch = (folder: string) => {
    const watch = JSON.parse(JSON.stringify(WATCH));
    watch.args.args.folder = folder;
    d.prepare('UPDATE scheduled_workflows SET event_trigger = ? WHERE id = ?').run(JSON.stringify(watch), r);
  };
  return { t, d, r, tr, runs, w, step, state, active, user4, running, editWatch };
}

test('worker: nothing active, nothing open; an option workflow waits, runs on ready, waits again', async () => {
  const idle = workerSetup();
  await idle.step();
  assert.equal(idle.tr.open.size, 0);
  const s = workerSetup();
  await s.active();
  await s.step();
  assert.ok(s.tr.open.has(3));
  assert.equal(s.state()[0], 'waiting');
  s.tr.answer(3, { status: 'ready', via: 'event', events: 'on' });
  await s.step(1);
  assert.deepEqual(s.runs.started, [[3, s.r]]);
  assert.equal(s.state()[0], 'running');
  assert.ok(!s.tr.open.has(3), 'no wait during a run');
  s.runs.ended.set(3, 0);
  await s.step(1);
  assert.ok(s.tr.open.has(3), 'waiting again');
  assert.deepEqual(s.state(), ['waiting', null]);
});

test('worker: a timeout waits again; events off is the fallback', async () => {
  const s = workerSetup();
  await s.active();
  await s.step();
  s.tr.answer(3, { status: 'timeout', events: 'off' });
  await s.step(1);
  assert.equal(s.tr.started, 2);
  assert.deepEqual(s.state(), ['waiting', 'fallback']);
});

test('worker: an error backs off doubling to the cap; a good answer resets it', async () => {
  const s = workerSetup();
  await s.active();
  await s.step();
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    s.tr.answer(3, { error: 'reconnect_needed' });
    await s.step(1);
    delays.push(s.w.slots()[3].backoff);
    assert.deepEqual(s.state(), ['error', 'reconnect_needed']);
    await s.step(s.w.slots()[3].until - s.t.now - 0.5); // not yet
    assert.ok(!s.tr.open.has(3));
    await s.step(1); // due: wait again
    assert.ok(s.tr.open.has(3));
  }
  assert.deepEqual(delays, [30, 60, 120, 240, 300]);
  s.tr.answer(3, { status: 'timeout' });
  await s.step(1);
  assert.equal(s.w.slots()[3].backoff, 0);
});

test('worker: a failed run keeps the watch after a backoff; a timeout does not clear the failure', async () => {
  const s = workerSetup();
  await s.active();
  await s.step();
  s.tr.answer(3, { status: 'ready' });
  await s.step(1);
  s.runs.ended.set(3, 1);
  await s.step(1);
  assert.deepEqual(s.state(), ['error', 'run_failed']);
  assert.ok(!s.tr.open.has(3), 'no wait at once: no ready -> fail loop');
  await s.step(EventWorker.BACKOFF_MIN_S);
  assert.ok(s.tr.open.has(3));
  assert.deepEqual(s.state(), ['waiting', 'run_failed']);
  s.tr.answer(3, { status: 'timeout', events: 'off' });
  await s.step(1);
  assert.deepEqual(s.state(), ['waiting', 'run_failed']);
  assert.equal(s.w.slots()[3].backoff, 30);
});

test('worker: failed runs back off doubling and a success resets', async () => {
  const s = workerSetup();
  await s.active();
  await s.step();
  const delays: number[] = [];
  for (let i = 0; i < 2; i++) {
    s.tr.answer(3, { status: 'ready', via: 'event', events: 'on' });
    await s.step(1);
    assert.equal(s.w.slots()[3].state, 'running');
    s.runs.ended.set(3, 1);
    await s.step(1);
    delays.push(s.w.slots()[3].backoff);
    assert.deepEqual(s.state(), ['error', 'run_failed']);
    await s.step(s.w.slots()[3].until - s.t.now - 0.5);
    assert.ok(!s.tr.open.has(3));
    await s.step(1);
    assert.ok(s.tr.open.has(3));
  }
  assert.deepEqual(delays, [30, 60]);
  assert.equal(s.runs.started.length, 2);
  s.tr.answer(3, { status: 'ready' });
  await s.step(1);
  s.runs.ended.set(3, 0);
  await s.step(1);
  assert.equal(s.w.slots()[3].backoff, 0);
  assert.ok(s.tr.open.has(3));
  assert.deepEqual(s.state(), ['waiting', null]);
});

test('worker: a run that cannot start backs off and is logged', async () => {
  const lines: string[] = [];
  const s = workerSetup({
    log: (l) => lines.push(l),
    runs: { start() { throw new Error('proc_open failed'); }, done: () => new Map(), scheduleTick() {} },
  });
  await s.active();
  await s.step();
  s.tr.answer(3, { status: 'ready' });
  await s.step(1);
  assert.deepEqual(s.state(), ['error', 'run_failed']);
  assert.equal(s.w.slots()[3].backoff, 30);
  assert.deepEqual(lines, ['event worker: run start (user 3): Error: proc_open failed']);
});

test('worker: a ready after deactivation (or a disable) starts no run', async () => {
  let s = workerSetup();
  await s.active();
  await s.step();
  await new ActiveWorkflowService().deactivate(3, 64);
  s.tr.answers.set(3, [JSON.stringify({ result: { structuredContent: { status: 'ready' } } }), 200, '']);
  await s.step(EventWorker.RECONCILE_S);
  assert.deepEqual(s.runs.started, []);
  assert.equal(s.tr.open.size, 0);
  assert.deepEqual(s.w.slots(), {});

  s = workerSetup();
  await s.active();
  await s.step();
  await new ActiveWorkflowService().deactivate(3, 64);
  s.tr.answer(3, { status: 'ready' });
  await s.step(1);
  assert.deepEqual(s.runs.started, [], 'between deactivation and the next reconcile');
  assert.deepEqual(s.w.slots(), {});

  s = workerSetup();
  await s.active();
  await s.step();
  s.d.exec('UPDATE agent_workflows SET enabled = 0');
  s.tr.answer(3, { status: 'ready' });
  await s.step(1);
  assert.deepEqual(s.runs.started, []);
  assert.ok(!s.tr.open.has(3));
});

test('worker: deactivating during a run opens no new wait', async () => {
  const s = workerSetup();
  await s.running();
  await new ActiveWorkflowService().deactivate(3, 64);
  await s.step(EventWorker.RECONCILE_S);
  s.runs.ended.set(3, 0);
  await s.step(1);
  assert.equal(s.tr.open.size, 0);
  assert.deepEqual(s.w.slots(), {});
});

test('worker: no links is idle and resumes when fixed; a missing server backs off', async () => {
  let s = workerSetup();
  await s.active();
  const edges = s.d.prepare('SELECT * FROM workflow_edges').all() as any[];
  s.d.exec('DELETE FROM workflow_edges');
  await s.step();
  assert.equal(s.tr.open.size, 0);
  assert.deepEqual(s.state(), ['idle', 'no_links']);
  s.d.prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)').run(edges[0].workflow_id, edges[0].from_node_id, edges[0].to_node_id);
  await s.step(EventWorker.RECONCILE_S);
  assert.ok(s.tr.open.has(3));

  s = workerSetup();
  s.d.exec('DELETE FROM mcp_servers');
  await s.active();
  await s.step();
  assert.deepEqual(s.state(), ['error', 'server_missing']);
  assert.equal(s.w.slots()[3].backoff, 30);
});

test('worker: schedule mode is scheduled and ticks every minute; none or idle does not tick', async () => {
  let s = workerSetup();
  workflow(s.d, 70, 3, null);
  row(s.d, 70, 3, 'daily');
  await s.active(3, 70);
  await s.step();
  assert.equal(s.tr.open.size, 0);
  assert.deepEqual(s.state(), ['scheduled', '2026-10-15 09:00:00']);
  assert.equal(s.runs.ticks, 1);
  await s.step(30);
  assert.equal(s.runs.ticks, 1);
  await s.step(31);
  assert.equal(s.runs.ticks, 2);

  s = workerSetup();
  await s.active();
  await s.step();
  await s.step(EventWorker.SCHEDULE_TICK_S + 1);
  assert.equal(s.runs.ticks, 0, 'option mode only');

  s = workerSetup();
  workflow(s.d, 70, 3, null);
  row(s.d, 70, 3, 'daily');
  await s.active(3, 70);
  s.d.exec('UPDATE agent_workflows SET enabled = 0 WHERE id = 70');
  await s.step();
  assert.deepEqual(s.state(), ['idle', 'disabled']);
  await s.step(EventWorker.SCHEDULE_TICK_S + 1);
  assert.equal(s.runs.ticks, 0);
  s.d.exec('UPDATE agent_workflows SET enabled = 1 WHERE id = 70');
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.runs.ticks, 1, 'scheduled again: the tick resumes at once');
});

test('worker: an edited watch reopens the wait; one edited during a run is used after it', async () => {
  let s = workerSetup();
  await s.active();
  await s.step();
  assert.match(s.tr.open.get(3)!, /"Inbox"/);
  s.editWatch('Archive');
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.tr.started, 2);
  assert.match(s.tr.open.get(3)!, /"Archive"/);
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.tr.started, 2, 'unchanged since: the wait stays');

  s = workerSetup();
  await s.running();
  s.editWatch('Archive');
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.tr.open.size, 0);
  s.runs.ended.set(3, 0);
  await s.step(1);
  await s.step(1);
  assert.ok(s.tr.open.has(3));
  assert.match(s.tr.open.get(3)!, /"Archive"/);
  assert.equal(s.runs.started.length, 1);
});

test('worker: a swallowed error is logged once a minute; the heartbeat refreshes the checked time', async () => {
  const lines: string[] = [];
  let s = workerSetup({ log: (l) => lines.push(l) });
  await s.active();
  s.d.exec("CREATE TRIGGER no_update BEFORE UPDATE ON active_workflows BEGIN SELECT RAISE(ABORT, 'locked'); END");
  for (let i = 0; i < 6; i++) {
    await s.w.step();
    s.t.now += 10;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /state write \(user 3\)/);
  assert.match(lines[0], /locked/);
  s.t.now += 10;
  await s.w.step();
  assert.equal(lines.length, 2);

  s = workerSetup();
  await s.active();
  await s.step();
  const first = (s.d.prepare('SELECT watch_checked_at AS c FROM active_workflows').get() as any).c;
  await s.step(EventWorker.HEARTBEAT_S + 1);
  assert.notEqual((s.d.prepare('SELECT watch_checked_at AS c FROM active_workflows').get() as any).c, first);
});

test('worker: two users are independent; a throwing server lookup does not block the other', async () => {
  let s = workerSetup();
  s.user4();
  await s.active();
  await s.active(4, 80);
  await s.step();
  s.tr.answer(3, { error: 'reconnect_needed' });
  s.tr.answer(4, { status: 'ready' });
  await s.step(1);
  assert.equal(s.state(3)[0], 'error');
  assert.equal(s.state(4)[0], 'running');
  assert.equal(s.w.slots()[3].backoff, 30);
  assert.equal(s.w.slots()[4].backoff, 0);

  s = workerSetup({ serverFor: (u, n) => { if (u === 3) throw new Error('db gone'); return WatchCall.server(u, n); } });
  s.user4();
  await s.active();
  await s.active(4, 80);
  await s.w.step();
  assert.deepEqual(s.state(3), ['error', 'unreachable']);
  assert.equal(s.w.slots()[3].backoff, 30);
  assert.ok(s.tr.open.has(4));
  assert.ok(!s.tr.open.has(3));
});

test('worker: switching the active workflow cancels the old wait; during a run it waits for the end', async () => {
  let s = workerSetup();
  workflow(s.d, 66, 3, 1);
  const other = row(s.d, 66, 3, 'event', 1);
  await s.active();
  await s.step();
  await s.active(3, 66);
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.w.slots()[3].workflow_id, 66);
  assert.equal(s.w.slots()[3].schedule_id, other);
  assert.equal(s.tr.started, 2);

  s = workerSetup();
  workflow(s.d, 66, 3, 1);
  row(s.d, 66, 3, 'event', 1);
  await s.running();
  await s.active(3, 66);
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.tr.open.size, 0);
  assert.equal(s.w.slots()[3].workflow_id, 64);
  assert.equal(s.w.slots()[3].state, 'running');
  s.runs.ended.set(3, 0);
  await s.step(1);
  assert.equal(s.tr.open.size, 0, 're-evaluated first');
  await s.step(1);
  assert.ok(s.tr.open.has(3));
  assert.equal(s.w.slots()[3].workflow_id, 66);
  assert.equal(s.tr.started, 2);
  assert.equal(s.runs.started.length, 1);
});

test('worker: disabling during a run idles after it; re-enabling opens no wait until it ends', async () => {
  let s = workerSetup();
  await s.running();
  s.d.exec('UPDATE agent_workflows SET enabled = 0');
  await s.step(EventWorker.RECONCILE_S);
  s.runs.ended.set(3, 0);
  await s.step(1);
  await s.step(1);
  assert.equal(s.tr.open.size, 0);
  assert.equal(s.runs.started.length, 1);
  assert.deepEqual(s.state(), ['idle', 'disabled']);

  s = workerSetup();
  await s.running();
  s.d.exec('UPDATE agent_workflows SET enabled = 0');
  await s.step(EventWorker.RECONCILE_S);
  s.d.exec('UPDATE agent_workflows SET enabled = 1');
  await s.step(EventWorker.RECONCILE_S);
  assert.equal(s.tr.open.size, 0);
  assert.equal(s.w.slots()[3].state, 'running');
  s.runs.ended.set(3, 0);
  await s.step(1);
  await s.step(1);
  assert.ok(s.tr.open.has(3));
  assert.equal(s.runs.started.length, 1);
});

test('worker: a failed state write does not lose a run end; a long failed run still records run_failed', async () => {
  let s = workerSetup();
  await s.running();
  s.d.exec('CREATE TABLE flag (v INTEGER)');
  s.d.exec('INSERT INTO flag VALUES (1)');
  s.d.exec("CREATE TRIGGER no_update BEFORE UPDATE ON active_workflows WHEN (SELECT v FROM flag) = 1 BEGIN SELECT RAISE(ABORT, 'locked'); END");
  s.runs.ended.set(3, 0);
  await s.step(1);
  assert.equal(s.w.slots()[3].state, 'waiting', 'the run end was taken');
  assert.ok(s.tr.open.has(3));
  assert.equal(s.state()[0], 'running', 'the write failed');
  s.d.exec('UPDATE flag SET v = 0');
  await s.step(EventWorker.HEARTBEAT_S + 1);
  assert.equal(s.state()[0], 'waiting', 'the heartbeat caught up');

  s = workerSetup();
  await s.running();
  await s.step(EventWorker.RECONCILE_S);
  await s.step(EventWorker.RECONCILE_S);
  s.runs.ended.set(3, 1);
  await s.step(1);
  await s.step(1);
  assert.deepEqual(s.state(), ['error', 'run_failed']);
  await s.step(EventWorker.BACKOFF_MIN_S);
  assert.deepEqual(s.state(), ['waiting', 'run_failed']);
  assert.ok(s.tr.open.has(3));
});

test('worker: a row whose check throws does not stop the others', async () => {
  const s = workerSetup();
  s.user4();
  await s.active();
  await s.active(4, 80);
  const boomOn = Number((s.d.prepare("SELECT id FROM workflow_nodes WHERE workflow_id = 64 AND node_type = 'start'").get() as any).id);
  const inner = handlerFor(s.d);
  installFakeDb((sqlText, params) => {
    if (sqlText.includes('FROM workflow_edges') && params.length === 1 && params[0] === boomOn) throw new Error('db gone');
    return inner(sqlText, params);
  });
  await s.step();
  assert.ok(s.tr.open.has(4));
});

// ---- WatchCall ----

test('watch call: the server (own row wins, by slug), the request, the answers and errors', async () => {
  const d = installSchedulerDb(() => '2026-10-14 09:00:00');
  eventWorkerSchema(d);
  const srv = (user: number | null, name: string, url: string, headers: string | null, enabled = 1) =>
    d.prepare('INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (?, ?, ?, ?, ?)').run(user, name, url, headers, enabled);
  srv(null, 'Outlook', 'http://global/mcp', '{}');
  srv(3, 'Outlook', 'http://mine/mcp', '{"X-Outlook-Key":"k"}');
  srv(4, 'Outlook', 'http://theirs/mcp', '{}');
  assert.deepEqual(await WatchCall.server(3, 'Outlook'), { url: 'http://mine/mcp', headers: { 'X-Outlook-Key': 'k' } });
  assert.equal((await WatchCall.server(5, 'outlook'))!.url, 'http://global/mcp');
  d.exec('DELETE FROM mcp_servers');
  srv(3, 'Outlook', 'http://mine/mcp', '{}', 0);
  assert.equal(await WatchCall.server(3, 'Outlook'), null);
  assert.equal(await WatchCall.server(3, 'Google'), null);
  d.exec('DELETE FROM mcp_servers');
  srv(3, 'Outlook', 'http://mine/mcp', 'not json');
  assert.deepEqual((await WatchCall.server(3, 'Outlook'))!.headers, {});
  d.exec('UPDATE mcp_servers SET headers = NULL');
  assert.deepEqual((await WatchCall.server(3, 'Outlook'))!.headers, {});

  const [url, lines, body] = WatchCall.request({ url: 'http://h/mcp', headers: { 'X-Outlook-Key': 'k' } }, WATCH, 7);
  assert.equal(url, 'http://h/mcp');
  assert.ok(lines.includes('X-Outlook-Key: k'));
  assert.ok(lines.includes('Content-Type: application/json'));
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait_for_new', arguments: { args: { folder: 'Inbox' } } } });
  assert.match(WatchCall.request({ url: 'u', headers: {} }, { server: 's', tool: 't', args: [] }, 1)[2], /"arguments":\{\}/);

  const rpc = (payload: any, structured = true) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: structured
    ? { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] }
    : { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  assert.deepEqual(WatchCall.answer(rpc({ status: 'ready', via: 'event', events: 'on' }), 200, ''), { status: 'ready', via: 'event', events: 'on' });
  assert.deepEqual(WatchCall.answer(rpc({ status: 'timeout', events: 'off' }, false), 200, ''), { status: 'timeout', via: null, events: 'off' });
  assert.equal(WatchCall.answer('event: message\ndata: ' + rpc({ status: 'ready' }) + '\n\n', 200, '').status, 'ready');
  assert.deepEqual(WatchCall.answer(rpc({ error: 'reconnect_needed', message: 'x' }), 200, ''), { status: 'error', message: 'reconnect_needed' });
  assert.deepEqual(WatchCall.answer(false, 0, 'Connection refused'), { status: 'error', message: 'unreachable' });
  assert.deepEqual(WatchCall.answer('<html>', 502, ''), { status: 'error', message: 'http_502' });
  assert.deepEqual(WatchCall.answer('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}', 200, ''), { status: 'error', message: 'rpc_error' });
  assert.deepEqual(WatchCall.answer(rpc({ status: 'maybe' }), 200, ''), { status: 'error', message: 'bad_answer' });
  assert.deepEqual(WatchCall.answer('not json', 200, ''), { status: 'error', message: 'bad_answer' });
  assert.deepEqual(WatchCall.answer(rpc({ error: { code: 'servicenow_error', message: 'down' } }), 200, ''), { status: 'error', message: 'servicenow_error' });
});

// ---- ProcRunSpawner ----

const node = process.execPath;
const runCmd = (id: number): [string, string[]] => [node, ['-e', `const id=${id}; if (id === 9) setTimeout(() => {}, 30000); else process.exit(id === 7 ? 3 : 0);`]];
const tickOk: [string, string[]] = [node, ['-e', 'process.exit(0)']];
async function waitFor(s: ProcRunSpawner, seen: Map<number, number>, key: number, max = 5000): Promise<number | null> {
  const end = Date.now() + max;
  while (Date.now() < end) {
    for (const [k, v] of s.done()) seen.set(k, v);
    if (seen.has(key)) return seen.get(key)!;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('spawner: exit codes; a run past its limit is killed; a live run is not overwritten; a hung tick is killed', async () => {
  const cwd = os.tmpdir();
  let s = new ProcRunSpawner(runCmd, tickOk, cwd);
  const seen = new Map<number, number>();
  s.start(1, 5);
  s.start(2, 7);
  assert.equal(await waitFor(s, seen, 1), 0);
  assert.equal(await waitFor(s, seen, 2), 3);

  const lines: string[] = [];
  s = new ProcRunSpawner(runCmd, tickOk, cwd, 1, (l) => lines.push(l));
  s.start(1, 9); // sleeps
  assert.throws(() => s.start(1, 5), /still in flight/);
  assert.equal(lines.length, 1);
  const code = await waitFor(s, new Map(), 1, 5000);
  assert.notEqual(code, null);
  assert.notEqual(code, 0, 'killed at the limit');
  await s.stopAll(1);

  const tickLines: string[] = [];
  s = new ProcRunSpawner(runCmd, [node, ['-e', 'setTimeout(() => {}, 30000)']], cwd, 1, (l) => tickLines.push(l));
  s.scheduleTick();
  const end = Date.now() + 5000;
  while (tickLines.length === 0 && Date.now() < end) {
    s.done();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(tickLines.length, 1);
  assert.match(tickLines[0], /tick/);
  s.scheduleTick(); // a fresh tick may start now
  await s.stopAll(0);
});

// ---- LiveFeed / LiveStream ----

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
function feed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livefeed_'));
  const log = new WorkflowRunLog(dir);
  const append = (id: string, types: any[]) => {
    for (const t of types) {
      log.append(id, typeof t === 'object' ? t : ['node_start', 'node_complete'].includes(t)
        ? { type: t, node_id: 2598, node_type: 'agent', drawflow_id: '18' } : { type: t });
    }
  };
  const startRun = (id: string, types: any[]) => {
    log.markCurrent(64, id);
    append(id, types);
  };
  return { dir, log, append, startRun, next: (c: string | null) => LiveFeed.next(log, 64, c) };
}
const quiet = () => [
  { type: 'workflow_start', workflow_id: 64 },
  { type: 'node_start', node_id: 2597, node_type: 'start', drawflow_id: '17' },
  { type: 'node_complete', node_id: 2597, node_type: 'start', drawflow_id: '17' },
  { type: 'node_start', node_id: '1000002597', node_type: 'code', drawflow_id: null },
  { type: 'node_log', node_id: '1000002597', message: 'outlook.poll_new_mail ok=true (218 ms)' },
  { type: 'node_complete', node_id: '1000002597', node_type: 'code', drawflow_id: null },
];
const types = (r: { events: any[] }) => r.events.map((e) => e.type);

test('live feed: the pointer, first connects, following the cursor, new runs', () => {
  const f = feed();
  assert.equal(f.log.current(64), null);
  assert.deepEqual(f.next(null), { events: [], cursor: null });
  f.startRun(A, ['workflow_start', 'node_start', 'workflow_complete']);
  assert.deepEqual(f.next(null), { events: [], cursor: A + ':3' }, 'a first connect skips a finished run');
  f.startRun(B, ['workflow_start', 'node_start']);
  assert.equal(f.log.current(64), B);
  assert.equal(f.log.current(65), null);
  let r = f.next(null);
  assert.deepEqual(types(r), ['workflow_start', 'node_start']);
  assert.equal(r.cursor, B + ':2');
  f.log.append(B, { type: 'node_complete' });
  r = f.next(B + ':2');
  assert.deepEqual(types(r), ['node_complete']);
  assert.equal(r.cursor, B + ':3');
  assert.deepEqual(f.next(r.cursor).events, []);
  assert.deepEqual(types(f.next('nonsense')), ['workflow_start', 'node_start', 'node_complete'], 'a bad cursor is a first connect');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('live feed: a new run from the start; a failed run is finished; a deleted quiet run is skipped; a partial line waits', () => {
  let f = feed();
  f.startRun(A, ['workflow_start', 'workflow_complete']);
  f.startRun(B, ['workflow_start', 'node_start', 'workflow_complete']);
  const r = f.next(A + ':2');
  assert.deepEqual(types(r), ['workflow_start', 'node_start', 'workflow_complete']);
  assert.equal(r.cursor, B + ':3');

  f = feed();
  f.startRun(A, ['workflow_start', 'workflow_error']);
  assert.deepEqual(f.next(null).events, []);

  f = feed();
  f.startRun(A, ['workflow_start', 'workflow_complete']);
  f.log.markCurrent(64, B);
  assert.deepEqual(f.next(A + ':2'), { events: [], cursor: A + ':2' });

  f = feed();
  f.startRun(A, ['workflow_start', 'node_start']);
  fs.appendFileSync(f.log.pathFor(A), '{"type":"node_co');
  const p = f.next(null);
  assert.deepEqual(types(p), ['workflow_start', 'node_start']);
  assert.equal(p.cursor, A + ':2');
});

test('live feed: a quiet run is held back, then returned from its first line; the tail of the cursor run comes first', () => {
  let f = feed();
  f.startRun(A, ['workflow_start', 'node_start', 'workflow_complete']);
  f.startRun(B, quiet());
  assert.deepEqual(f.next(A + ':3'), { events: [], cursor: A + ':3' });
  assert.deepEqual(f.next(null), { events: [], cursor: null });
  f.append(B, ['node_start']);
  let r = f.next(A + ':3');
  assert.equal(r.events.length, 7);
  assert.equal(r.events[0].type, 'workflow_start');
  assert.equal(r.events[6].node_id, 2598);
  assert.equal(r.cursor, B + ':7');

  f = feed();
  f.startRun(A, ['workflow_start', 'node_start', 'workflow_complete']);
  f.startRun(B, quiet());
  f.append(B, [{ type: 'workflow_error', error: 'boom' }]);
  r = f.next(A + ':3');
  assert.equal(r.events.length, 7);
  assert.equal(r.events[6].type, 'workflow_error');

  f = feed();
  f.startRun(A, ['workflow_start', 'node_start']);
  f.append(A, [{ type: 'workflow_complete', output: 'the answer' }]);
  f.startRun(B, ['workflow_start', 'node_start']);
  r = f.next(A + ':2');
  assert.deepEqual(types(r), ['workflow_complete', 'workflow_start', 'node_start']);
  assert.equal(r.events[0].output, 'the answer');
  assert.equal(r.cursor, B + ':2');

  f = feed();
  f.startRun(A, ['workflow_start', 'node_start', 'workflow_complete']);
  f.startRun(B, quiet());
  r = f.next(A + ':2');
  assert.deepEqual(types(r), ['workflow_complete']);
  assert.equal(r.cursor, A + ':3');
});

async function drive(feeds: any[], cursor: string | null = null, max = 50.0, aborted: (() => boolean) | null = null) {
  let t = 0.0;
  const out: Array<[string, any, number]> = [];
  const calls: Array<string | null> = [];
  const final = await LiveStream.run(
    (c) => { calls.push(c); return feeds.shift() ?? { events: [], cursor: c }; },
    () => ({ workflow_id: 64, watch_state: 'waiting' }),
    (event, data) => { out.push([event, data, t]); },
    async (s) => { t += s; },
    () => t,
    aborted ?? (() => false),
    cursor,
    max,
  );
  return { out, final, calls };
}

test('live stream: events carry the cursor, state every 5 s, pings every 15 s, bye; an aborted client gets no bye', async () => {
  let r = await drive([{ events: [{ type: 'workflow_start' }, { type: 'node_start' }], cursor: 'c2' }], null, 2.0);
  assert.deepEqual(r.out.filter((o) => o[0] === 'run').map((o) => o[1]),
    [{ cursor: 'c2', event: { type: 'workflow_start' } }, { cursor: 'c2', event: { type: 'node_start' } }]);
  assert.deepEqual(r.out.at(-1)!.slice(0, 2), ['bye', { cursor: 'c2' }]);
  assert.equal(r.final, 'c2');
  assert.deepEqual(r.calls.slice(0, 2), [null, 'c2']);

  r = await drive([], 'c0', 31.0);
  assert.deepEqual(r.out.filter((o) => o[0] === 'state').map((o) => o[2]), [0, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(r.out.filter((o) => o[0] === 'ping').map((o) => o[2]), [15, 30]);
  assert.deepEqual(r.out[0][1], { active: { workflow_id: 64, watch_state: 'waiting' } });

  let n = 0;
  r = await drive([], 'c0', 50.0, () => ++n > 3);
  assert.ok(!r.out.map((o) => o[0]).includes('bye'));
  assert.ok((r.out.at(-1)?.[2] ?? 0) < 3.0);
});

// ---- POST /workflows/run and GET /workflows/{id}/live ----

test('runByName: authentication, a name, an unknown name, then run() on the found id', async () => {
  const d = installSchedulerDb(() => '2026-10-14 09:00:00');
  d.exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT)');
  d.exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (44, 3, 'Daily digest')");
  const c = new WorkflowController();
  let seen: any = null;
  (c as any).run = async (x: any) => { seen = x.params; return { success: true, ran: true }; };
  assert.deepEqual(await c.runByName(ctx(null)), { success: false, error: 'Authentication required', status_code: 401 });
  assert.deepEqual(await c.runByName(ctx(3, {}, { body: { workflow: '  ' } })), { success: false, error: 'A "workflow" name is required', status_code: 400 });
  assert.deepEqual(await c.runByName(ctx(3, {}, { body: { workflow: 'Nope' } })),
    { success: false, error: 'No workflow named "Nope" found for this account', status_code: 404 });
  assert.deepEqual(await c.runByName(ctx(4, {}, { body: { workflow: 'Daily digest' } })),
    { success: false, error: 'No workflow named "Daily digest" found for this account', status_code: 404 }, "another user's workflow");
  assert.deepEqual(await c.runByName(ctx(3, {}, { body: { workflow: ' Daily digest ' } })), { success: true, ran: true });
  assert.equal(seen.id, '44');
});

test('live: an SSE of run events, state and bye; access is checked', async () => {
  const d = installSchedulerDb(() => '2026-10-14 09:00:00');
  eventWorkerSchema(d);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live_'));
  const c = new WorkflowController();
  (c as any).workflowRepository = { canUserAccess: async (u: number, w: number) => u === 3 && w === 64 };
  let t = 0;
  c.liveClock = { now: () => t, sleep: async (s) => { t += s; }, maxSeconds: 1.0 };
  const orig = WorkflowRunLog.defaultDir;
  (WorkflowRunLog as any).defaultDir = () => runsDir;
  const log = new WorkflowRunLog(runsDir);
  log.markCurrent(64, A);
  log.append(A, { type: 'workflow_start' });
  log.append(A, { type: 'node_start', node_id: 5, node_type: 'agent' });
  const call = async (userId: number | null, id: string) => {
    const chunks: string[] = [];
    const res: any = {
      writableEnded: false, headers: {} as Record<string, string>,
      status() { return this; }, setHeader(k: string, v: string) { this.headers[k] = v; },
      write(s: string) { chunks.push(s); }, end() { this.writableEnded = true; },
    };
    const req: any = { method: 'GET', path: `/api/v1/workflows/${id}/live`, headers: {}, query: {}, body: {}, user_id: userId, params: { id }, socket: {}, on() {} };
    await c.live(req, res);
    return { res, frames: chunks.join('').split('\n\n').filter(Boolean) };
  };
  try {
    const ok = await call(3, '64');
    assert.equal(ok.res.headers['Content-Type'], 'text/event-stream');
    assert.ok(ok.res.writableEnded);
    const events = log.read(A) ?? [];
    assert.equal(ok.frames[0], `event: run\ndata: {"cursor":"${A}:2","event":${JSON.stringify(events[0])}}`);
    assert.equal(ok.frames[1], `event: run\ndata: {"cursor":"${A}:2","event":${JSON.stringify(events[1])}}`);
    assert.equal(ok.frames[2], 'event: state\ndata: {"active":null}');
    assert.equal(ok.frames.at(-1), `event: bye\ndata: {"cursor":"${A}:2"}`);
    assert.deepEqual((await call(4, '64')).frames, ['event: error\ndata: {"error":"Workflow not found or access denied"}']);
    assert.deepEqual((await call(null, '64')).frames, ['event: error\ndata: {"error":"Authentication required"}']);
  } finally {
    (WorkflowRunLog as any).defaultDir = orig;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
