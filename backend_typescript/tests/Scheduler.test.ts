import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSchedulerDb, SCHEDULES_DDL, eventWorkerSchema, workflow, row, fmt, at, SchedDb } from './support/schedulerDb';
import { CronExpression } from '../src/AgentTeam/CronExpression';
import { ScheduledWorkflowService, ScheduleInputError } from '../src/AgentTeam/ScheduledWorkflowService';
import { ScheduleTick } from '../src/AgentTeam/ScheduleTick';

/**
 * Twins of backend/tests/Unit: CronExpressionTest, ScheduledWorkflowServiceCronTest,
 * ScheduledWorkflowServiceEventTest, ScheduledWorkflowServiceStartOptionTest, ScheduleTickTest and
 * EventWorker/ScheduleTickDrainTest. SQLite in memory, NOW() from the test's clock.
 */

const hm = (d: Date) => fmt(d).slice(0, 16);

// ---- CronExpression ----

test('cron: every two minutes, office hours, Sunday as 7, dom OR dow', () => {
  const c = new CronExpression('*/2 * * * *');
  assert.equal(hm(c.nextAfter(at('2026-10-07 10:42:30'))), '2026-10-07 10:44');
  assert.equal(hm(c.nextAfter(at('2026-10-07 10:43:00'))), '2026-10-07 10:44');
  const office = new CronExpression('*/5 8-18 * * 1-5');
  assert.equal(hm(office.nextAfter(at('2026-10-09 18:57'))), '2026-10-12 08:00'); // Friday -> Monday
  assert.equal(hm(office.nextAfter(at('2026-10-09 18:50'))), '2026-10-09 18:55');
  assert.equal(hm(new CronExpression('0 9 * * 7').nextAfter(at('2026-10-07 00:00'))), '2026-10-11 09:00');
  assert.equal(hm(new CronExpression('0 0 1 * 1').nextAfter(at('2026-10-07 00:00'))), '2026-10-12 00:00');
});

test('cron: lists, ranges and steps; invalid and never-firing expressions', () => {
  const c = new CronExpression('5,35 9-17/4 * * *');
  assert.equal(c.matches(at('2026-10-07 13:35')), true);
  assert.equal(c.matches(at('2026-10-07 11:35')), false);
  assert.equal(c.matches(at('2026-10-07 17:05')), true);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * * * *']) {
    assert.equal(CronExpression.isValid(bad), false, bad);
  }
  assert.equal(CronExpression.isValid('*/2 * * * *'), true);
  assert.equal(CronExpression.isValid('0 0 31 2 *'), false);
  assert.equal(CronExpression.isValid('0 0 29 2 *'), true); // leap day fires within 4 years
});

// ---- ScheduledWorkflowService: cron ----

function cronSetup(start = '2026-10-07 10:42:30') {
  const state = { clock: at(start) };
  const d = installSchedulerDb(() => fmt(state.clock));
  d.exec(SCHEDULES_DDL);
  d.exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  const svc = () => new ScheduledWorkflowService(() => state.clock);
  const plus = (min: number) => { state.clock = new Date(state.clock.getTime() + min * 60000); };
  return { d, state, svc, plus };
}
const ids = (rows: any[]) => rows.map((r) => Number(r.id));

test('service: a cron schedule computes next_run from now; a bad cron is refused', async () => {
  const { svc } = cronSetup();
  const s = await svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-07 10:00:00', repeat_type: 'cron', cron: '*/2 * * * *' });
  assert.equal(s.repeat_type, 'cron');
  assert.equal(s.cron, '*/2 * * * *');
  assert.equal(s.next_run, '2026-10-07 10:44:00');
  await assert.rejects(svc().create({ user_id: 3, workflow_id: 44, scheduled_time: 'x', repeat_type: 'cron', cron: '61 * * * *' }), ScheduleInputError);
});

test('service: a completed cron run schedules from now; a failed one stays recurring; hourly unchanged', async () => {
  const t = cronSetup();
  const s = await t.svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-07 10:00:00', repeat_type: 'cron', cron: '*/2 * * * *' });
  await t.svc().markFailed(s.id, 'boom');
  let r = await t.svc().findById(s.id);
  assert.equal(r.status, 'pending');
  assert.equal(r.next_run, '2026-10-07 10:44:00');
  t.state.clock = at('2026-10-07 11:30:10'); // the tick ran late
  await t.svc().markCompleted(s.id);
  r = await t.svc().findById(s.id);
  assert.equal(r.next_run, '2026-10-07 11:32:00');
  assert.equal(r.status, 'pending');
  assert.equal(r.running_since, null);
  const h = await t.svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-07 10:00:00', repeat_type: 'hourly', repeat_interval: 2 });
  await t.svc().markCompleted(h.id);
  assert.equal((await t.svc().findById(h.id)).next_run, '2026-10-07 12:00:00');
});

test('service: the claim is exclusive, a stale run is reclaimed, touchRunning keeps a long run', async () => {
  const t = cronSetup();
  const due = async () => {
    const s = await t.svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-07 10:00:00', repeat_type: 'cron', cron: '*/2 * * * *' });
    t.d.prepare("UPDATE scheduled_workflows SET next_run = '2026-10-07 10:42:00' WHERE id = ?").run(s.id);
    return Number(s.id);
  };
  const id = await due();
  assert.equal(await t.svc().claim(id), true);
  assert.equal(await t.svc().claim(id), false, 'a second tick must not claim a running schedule');
  t.plus(10);
  assert.deepEqual(await t.svc().getDueSchedules(), [], 'running within the window is not due');
  t.plus(51);
  assert.deepEqual(ids(await t.svc().getDueSchedules()), [id]);
  assert.equal(await t.svc().claim(id), true);

  t.state.clock = at('2026-10-07 10:42:30');
  const id2 = await due();
  t.d.prepare("UPDATE scheduled_workflows SET status = 'completed' WHERE id = ?").run(id);
  assert.equal(await t.svc().claim(id2), true);
  t.plus(50);
  await t.svc().touchRunning(id2);
  assert.equal((await t.svc().findById(id2)).running_since, '2026-10-07 11:32:30');
  t.plus(50);
  assert.deepEqual(await t.svc().getDueSchedules(), []);
  assert.equal(await t.svc().claim(id2), false);
});

test('service: touchRunning leaves a pending schedule; a null running_since is stale; the future is not claimed', async () => {
  const t = cronSetup();
  const s = await t.svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-07 10:00:00', repeat_type: 'cron', cron: '*/2 * * * *' });
  await t.svc().touchRunning(s.id);
  let r = await t.svc().findById(s.id);
  assert.equal(r.status, 'pending');
  assert.equal(r.running_since, null);
  t.d.prepare("UPDATE scheduled_workflows SET next_run = '2026-10-07 11:00:00' WHERE id = ?").run(s.id);
  assert.equal(await t.svc().claim(s.id), false, 'a pending schedule edited into the future');
  t.d.prepare("UPDATE scheduled_workflows SET status = 'running', running_since = NULL WHERE id = ?").run(s.id);
  assert.deepEqual(ids(await t.svc().getDueSchedules()), [Number(s.id)]);
  assert.equal(await t.svc().claim(s.id), true);
});

test('service: update to cron recomputes next_run; the default clock reads NOW(); the clock is read once per method', async () => {
  const t = cronSetup();
  const s = await t.svc().create({ user_id: 3, workflow_id: 44, scheduled_time: '2026-10-08 10:00:00' });
  const u = await t.svc().update(s.id, 3, { repeat_type: 'cron', cron: '*/15 * * * *', scheduled_time: '2026-10-08 10:00:00' });
  assert.equal(u.next_run, '2026-10-07 10:45:00');
  const viaDb = await new ScheduledWorkflowService().create({ user_id: 3, workflow_id: 44, repeat_type: 'cron', cron: '*/2 * * * *' });
  assert.equal(viaDb.next_run, '2026-10-07 10:44:00');
  let reads = 0;
  const counted = new ScheduledWorkflowService(() => { reads++; return t.state.clock; });
  await counted.getDueSchedules();
  assert.equal(reads, 1, 'getDueSchedules reads the clock once');
  reads = 0;
  await counted.claim(s.id);
  assert.equal(reads, 1, 'claim reads the clock once');
});

// ---- ScheduledWorkflowService: event + Start option ----

const TRIGGER = { server: 'Outlook', tool: 'wait_for_new', args: { args: { folder: 'Inbox' } } };

function eventSetup() {
  const t = cronSetup('2026-10-12 10:42:30');
  return { ...t, event: (trigger: any = TRIGGER, extra: Record<string, any> = {}) => t.svc().create({
    user_id: 3, workflow_id: 64, scheduled_time: '2026-10-12 10:00:00', repeat_type: 'event', event_trigger: trigger, ...extra,
  }) };
}

test('service: an event schedule stores its trigger, has no next_run and is never claimed', async () => {
  const t = eventSetup();
  const s = await t.event();
  assert.equal(s.repeat_type, 'event');
  assert.equal(s.next_run, null);
  assert.equal(s.cron, null);
  assert.equal(s.event_trigger, '{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Inbox"}}}');
  t.plus(60 * 24 * 365 * 10);
  assert.deepEqual(await t.svc().getDueSchedules(), []);
  assert.equal(await t.svc().claim(s.id), false);
  const n = await t.event('{"server": " Outlook ", "tool": "wait_for_new"}');
  assert.equal(n.event_trigger, '{"server":"Outlook","tool":"wait_for_new","args":{}}');
});

test('service: a bad trigger is refused', async () => {
  const t = eventSetup();
  for (const bad of [null, '{oops', { tool: 'w' }, { server: 'Outlook' }, { server: 'Outlook', tool: '  ' },
    { server: 'O', tool: 'w', args: [1, 2] }, { server: 'O', tool: 'w', args: 'x' }]) {
    await assert.rejects(t.event(bad), ScheduleInputError, JSON.stringify(bad));
  }
});

test('service: other schedules do not touch the event column', async () => {
  const t = eventSetup();
  t.d.exec('ALTER TABLE scheduled_workflows DROP COLUMN event_trigger');
  let s = await t.svc().create({ user_id: 3, workflow_id: 64, scheduled_time: '2026-10-12 11:00:00', repeat_type: 'daily' });
  assert.equal(s.next_run, '2026-10-12 11:00:00');
  s = await t.svc().create({ user_id: 3, workflow_id: 64, scheduled_time: '2026-10-12 11:00:00', repeat_type: 'cron', cron: '*/5 * * * *' });
  assert.equal(s.next_run, '2026-10-12 10:45:00');
  await t.svc().update(s.id, 3, { input_prompt: 'poll' });
  assert.equal((await t.svc().findById(s.id)).input_prompt, 'poll');
});

test('service: update changes the trigger; cron becomes event and back; event without a trigger is refused', async () => {
  const t = eventSetup();
  const s = await t.event();
  let u = await t.svc().update(s.id, 3, { repeat_type: 'event', event_trigger: { server: 'Outlook', tool: 'wait_for_new', args: { timeout_s: 60 } } });
  assert.equal(u.event_trigger, '{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}');
  assert.equal(u.next_run, null);
  u = await t.svc().update(s.id, 3, { input_prompt: 'go' });
  assert.equal(u.event_trigger, '{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}');

  const c = await t.svc().create({ user_id: 3, workflow_id: 64, scheduled_time: '2026-10-12 10:00:00', repeat_type: 'cron', cron: '*/2 * * * *' });
  assert.equal(c.next_run, '2026-10-12 10:44:00');
  u = await t.svc().update(c.id, 3, { repeat_type: 'event', event_trigger: TRIGGER, cron: null });
  assert.deepEqual([u.repeat_type, u.next_run, u.cron], ['event', null, null]);
  u = await t.svc().update(c.id, 3, { repeat_type: 'cron', cron: '*/2 * * * *' });
  assert.equal(u.event_trigger, null);
  assert.equal(u.next_run, '2026-10-12 10:44:00');
  await t.svc().update(c.id, 3, { repeat_type: 'event', event_trigger: TRIGGER });
  u = await t.svc().update(c.id, 3, { repeat_type: 'daily' }); // timed again: from its time
  assert.equal(u.event_trigger, null);
  assert.equal(u.next_run, '2026-10-12 10:00:00');

  const daily = await t.svc().create({ user_id: 3, workflow_id: 64, scheduled_time: '2026-10-12 10:00:00', repeat_type: 'daily' });
  await assert.rejects(t.svc().update(daily.id, 3, { repeat_type: 'event' }), ScheduleInputError);
  assert.equal(await t.svc().update(daily.id, 4, { input_prompt: 'x' }), null, 'not the owner');
});

test('service: an event schedule remembers the Start option it came from', async () => {
  const t = eventSetup();
  let s = await t.event(TRIGGER, { trigger_component_id: 7 });
  assert.equal(Number(s.trigger_component_id), 7);
  assert.equal((await t.event()).trigger_component_id, null);
  const none = await t.svc().create({ user_id: 3, workflow_id: 64, scheduled_time: '2026-10-14 10:00:00', repeat_type: 'none' });
  let u = await t.svc().update(none.id, 3, { repeat_type: 'event', event_trigger: TRIGGER, trigger_component_id: 7 });
  assert.equal(Number(u.trigger_component_id), 7);
  u = await t.svc().update(s.id, 3, { repeat_type: 'event', input_prompt: 'go' });
  assert.equal(Number(u.trigger_component_id), 7, 'an event save without a trigger keeps the component');
  u = await t.svc().update(s.id, 3, { repeat_type: 'event', event_trigger: { server: 'Outlook', tool: 'wait_for_new', args: [] } });
  assert.equal(u.trigger_component_id, null, 'a hand-made event save clears the component');
  s = await t.event(TRIGGER, { trigger_component_id: 7 });
  u = await t.svc().update(s.id, 3, { repeat_type: 'daily' });
  assert.equal(u.trigger_component_id, null);
  assert.equal(u.event_trigger, null);
});

// ---- ScheduleTick ----

function tickSetup() {
  const t = cronSetup();
  t.d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)
    VALUES (3, 44, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')`);
  const tick = async (results: any[]) => {
    let calls = 0;
    const r = await new ScheduleTick(t.svc(), async () => results[Math.min(calls++, results.length - 1)]).run();
    return { r, calls };
  };
  return { ...t, tick };
}

test('tick: a quiet run is not listed and does not drain; a work run drains until quiet; capped at twenty', async () => {
  let t = tickSetup();
  let { r, calls } = await t.tick([{ success: true, quiet: true, drain: false }]);
  assert.equal(calls, 1);
  assert.deepEqual(r.executed, []);
  assert.equal(r.quiet_count, 1);
  assert.equal((await t.svc().findById(1)).status, 'pending');

  t = tickSetup();
  const work = { success: true, quiet: false, drain: true, execution_id: 9 };
  ({ r, calls } = await t.tick([work, work, work, { success: true, quiet: true, drain: false }]));
  assert.equal(calls, 4);
  assert.equal(r.executed.length, 3);
  assert.deepEqual(r.executed[0], { schedule_id: 1, workflow_id: 44, workflow_name: null, execution_id: 9 });

  t = tickSetup();
  ({ calls } = await t.tick([{ success: true, quiet: false, drain: true }]));
  assert.equal(calls, ScheduleTick.MAX_RUNS_PER_TICK);
  t = tickSetup();
  ({ calls } = await t.tick([{ success: true, quiet: false, drain: false }]));
  assert.equal(calls, 1, 'no code node ran: no drain');
  t = tickSetup();
  ({ calls } = await t.tick([{ success: true, quiet: true, drain: true }]));
  assert.equal(calls, 1, 'a quiet run never drains');
});

test('tick: each drain run refreshes running_since', async () => {
  const t = tickSetup();
  const seen: string[] = [];
  let calls = 0;
  const svc = t.svc();
  await new ScheduleTick(svc, async () => {
    seen.push((await svc.findById(1)).running_since);
    t.plus(40);
    return ++calls < 3 ? { success: true, quiet: false, drain: true } : { success: true, quiet: true };
  }).run();
  assert.deepEqual(seen, ['2026-10-07 10:42:30', '2026-10-07 11:22:30', '2026-10-07 12:02:30']);
});

test('tick: a failure stops the drain and is recorded; an overlapping claim is skipped', async () => {
  let t = tickSetup();
  const { r, calls } = await t.tick([{ success: true, drain: true }, { success: false, error: 'reconnect_needed' }]);
  assert.equal(calls, 2);
  assert.equal(r.failed[0].error, 'reconnect_needed');
  assert.equal(r.failed[0].workflow_name, 'Unknown');
  const row1 = await t.svc().findById(1);
  assert.equal(row1.status, 'pending');
  assert.equal(row1.error_message, 'reconnect_needed');

  t = tickSetup();
  t.d.exec(`INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)
    VALUES (3, 45, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')`);
  let n = 0;
  const svc = t.svc();
  await new ScheduleTick(svc, async () => {
    n++;
    await svc.claim(2); // an overlapping tick takes row 2 while we run row 1
    return { success: true, quiet: true };
  }).run();
  assert.equal(n, 1);
  assert.equal((await svc.findById(2)).status, 'running');
});

// ---- ScheduledWorkflowController: the cron and event rules ----

test('schedule controller: repeat types, a bad cron and a bad trigger are 400; an update to event without one is 400', async () => {
  const { ScheduledWorkflowController } = require('../src/Controllers/ScheduledWorkflowController');
  const d = installSchedulerDb(() => '2026-10-14 09:00:00');
  eventWorkerSchema(d);
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  workflow(d, 64, 3, null);
  const c = new ScheduledWorkflowController();
  const create = (body: any) => c.create({ user_id: 3, body: { workflow_id: 64, scheduled_time: '2026-10-14 10:00:00', ...body }, params: {}, query: {}, headers: {} });
  assert.deepEqual(await create({ repeat_type: 'yearly' }), {
    success: false, error: 'Invalid repeat type. Must be one of: none, hourly, daily, weekly, monthly, cron, event', status_code: 400,
  });
  assert.deepEqual(await create({ repeat_type: 'cron', cron: '61 * * * *' }), { success: false, error: 'Invalid cron expression', status_code: 400 });
  assert.deepEqual(await create({ repeat_type: 'event' }), {
    success: false, error: 'An event schedule needs event_trigger: {"server", "tool", "args"}', status_code: 400,
  });
  const ok = await create({ repeat_type: 'cron', cron: '*/5 * * * *' });
  assert.equal(ok.status_code, 201, JSON.stringify(ok));
  assert.equal(ok.data.next_run, '2026-10-14 09:05:00');
  const upd = (body: any) => c.update({ user_id: 3, body, params: { id: String(ok.data.id) }, query: {}, headers: {} });
  assert.deepEqual(await upd({ cron: 'nope' }), { success: false, error: 'Invalid cron expression', status_code: 400 });
  assert.deepEqual(await upd({ repeat_type: 'event' }), {
    success: false, error: 'An event schedule needs event_trigger: {"server", "tool", "args"}', status_code: 400,
  });
  assert.equal((await upd({ repeat_type: 'daily' })).status_code, 200);
});

// ---- ScheduleTick.drain and the due filter (ScheduleTickDrainTest) ----

test('drain: stops on a quiet run, at twenty, and raises on a failed run', async () => {
  const answers = [{ success: true, drain: true, execution_id: 'a' }, { success: true, quiet: true }];
  assert.deepEqual(await ScheduleTick.drain(async () => answers.shift()!), { runs: 2, quiet_count: 1, execution_ids: ['a'] });
  assert.equal((await ScheduleTick.drain(async () => ({ success: true, drain: true }))).runs, 20);
  await assert.rejects(ScheduleTick.drain(async () => ({ success: false, error: 'boom' })), /^Error: boom$/);
});

test('due schedules can be restricted to workflows; an event row keeps no next run when completed', async () => {
  const d: SchedDb = installSchedulerDb(() => '2026-10-15 10:00:00');
  eventWorkerSchema(d);
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  const svc = new ScheduledWorkflowService(() => at('2026-10-15 10:00:00'));
  workflow(d, 70, 3, null);
  workflow(d, 71, 3, null);
  row(d, 70, 3, 'daily');
  row(d, 71, 3, 'daily');
  const wf = async (only: number[] | null) => (await svc.getDueSchedules(only)).map((r) => Number(r.workflow_id));
  assert.deepEqual(await wf(null), [70, 71]);
  assert.deepEqual(await wf([71]), [71]);
  assert.deepEqual(await wf([]), []);
  workflow(d, 64, 3, 1);
  const id = row(d, 64, 3, 'event', 1);
  await svc.markCompleted(id);
  const r = d.prepare('SELECT status, next_run, last_run FROM scheduled_workflows WHERE id = ?').get(id) as any;
  assert.deepEqual([r.status, r.next_run, r.last_run], ['pending', null, '2026-10-15 10:00:00']);
});
