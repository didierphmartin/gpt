const assert = require('assert');
global.CodeNode = require('../code-node.js');
const SO = require('../start-options.js');

// isStartDrop -- review focus 4: only a drop on a (non-ingestion) Start node, its Drawflow frame included
const card = (cls) => ({ classList: { contains: (c) => cls.includes(c) } });
const startCard = card(['workflow-node', 'start-node']);
const ingestCard = card(['workflow-node', 'start-node', 'ingestion-start']);
// A drop target: `ancestors` maps the selectors it closest()-matches; `frame` is the Drawflow node around it.
const el = (ancestors, frameCard = null) => ({
    closest: (sel) => (sel === '.drawflow-node' && frameCard ? { querySelector: () => frameCard } : ancestors[sel] || null),
});
assert.strictEqual(SO.isStartDrop(el({ '.workflow-node.start-node': startCard })), startCard);
assert.strictEqual(SO.isStartDrop(el({}, startCard)), startCard);            // on the frame, outside the card
assert.strictEqual(SO.isStartDrop(el({ '.workflow-node.start-node': ingestCard })), null);
assert.strictEqual(SO.isStartDrop(el({}, ingestCard)), null);
assert.strictEqual(SO.isStartDrop(el({}, null)), null);                      // an agent node, the bare canvas
assert.strictEqual(SO.isStartDrop(null), null);

// tools and exits
assert.deepStrictEqual(SO.sortWaitTools(['poll_new_mail', 'wait_for_new', 'move_mail', 'wait_x']),
    ['wait_for_new', 'wait_x', 'poll_new_mail', 'move_mail']);
assert.strictEqual(SO.guessWorkExit(['no_mail', 'new_mail', 'error']), 'new_mail');
assert.strictEqual(SO.guessWorkExit(['job', 'no_job']), 'job');

// defaultTrigger: label = name, first server, first wait tool, args from the template-shaped call (empties dropped)
const poll = CodeNode.TEMPLATES.poll_outlook;
const comp = { name: 'Outlook: get new email', mcp_servers: ['Outlook'], exits: poll.exits, code: poll.code };
assert.deepStrictEqual(SO.defaultTrigger(comp, ['poll_new_mail', 'wait_for_new']), {
    label: 'Outlook: get new email',
    watch: { server: 'Outlook', tool: 'wait_for_new', args: { args: { folder: 'Inbox' } } },
    work_exit: 'new_mail',
});
// hand-written code: no literal call found -> empty args
assert.deepStrictEqual(SO.defaultTrigger({ ...comp, code: 'def run(input, call_tool):\n    return 1' }, ['wait_for_new']).watch.args, {});
// no wait tool, no server
assert.deepStrictEqual(SO.defaultTrigger({ ...comp, mcp_servers: [] }, []).watch, { server: '', tool: '', args: {} });

// warning: the active form names the workflows and the exit whose links stay; the idle form keeps the last two lines
assert.deepStrictEqual(SO.warning('New email', [{ workflow_name: 'AA test' }, { workflow_name: 'email prototype' }], 'new_mail')
    .map((l) => l.key), ['workflow.startOptions.warnActive', 'workflow.startOptions.warnStops',
    'workflow.startOptions.warnPorts', 'workflow.startOptions.warnEverywhere', 'workflow.startOptions.warnLibrary']);
assert.strictEqual(SO.warning('New email', [{ workflow_name: 'AA test' }, { workflow_name: 'B' }], 'new_mail')[0].params.names, 'AA test, B');
assert.strictEqual(SO.warning('New email', [{ workflow_name: 'AA test' }], 'new_mail')[2].params.exit, 'new_mail');
assert.deepStrictEqual(SO.warning('New email', [], 'new_mail').map((l) => l.key),
    ['workflow.startOptions.warnEverywhere', 'workflow.startOptions.warnLibrary']);

// active: one row at a time, from the saved schedule row
assert.strictEqual(SO.active(null), 'prompt');
assert.strictEqual(SO.active({}), 'prompt');
assert.strictEqual(SO.active({ id: 4, repeat_type: 'cron' }), 'schedule');
assert.strictEqual(SO.active({ id: 4, repeat_type: 'event', trigger_component_id: '1' }), 1);

// startLinks -- spec §10
const PLAIN = { exits: ['next'], work: 'next' };
const MAIL = { exits: ['new_mail', 'no_mail', 'error'], work: 'new_mail' };
const conn = (node, output = 'input_1') => ({ node, output });
// plain -> option: Start's links land on the work exit's port, nothing is lost
assert.deepStrictEqual(SO.startLinks({ output_1: { connections: [conn('5'), conn('6', 'input_2')] } }, PLAIN, MAIL), {
    ports: 3, dropped: [],
    connections: [{ port: 'output_1', node: '5', input: 'input_1' }, { port: 'output_1', node: '6', input: 'input_2' }],
});
// work exit not first: the links go to its port
assert.deepStrictEqual(SO.startLinks({ output_1: { connections: [conn(5)] } }, PLAIN, { exits: ['none', 'job'], work: 'job' }).connections,
    [{ port: 'output_2', node: '5', input: 'input_1' }]);
// option -> plain: the work exit's links stay on the one port, the others are removed
const wired = { output_1: { connections: [conn('5')] }, output_2: { connections: [conn('6'), conn('7')] }, output_3: { connections: [] } };
assert.deepStrictEqual(SO.startLinks(wired, MAIL, PLAIN), {
    ports: 1, connections: [{ port: 'output_1', node: '5', input: 'input_1' }], dropped: [{ exit: 'no_mail', count: 2 }],
});
// option -> another option
assert.deepStrictEqual(SO.startLinks(wired, MAIL, { exits: ['none', 'job', 'error'], work: 'job' }), {
    ports: 3, connections: [{ port: 'output_2', node: '5', input: 'input_1' }], dropped: [{ exit: 'no_mail', count: 2 }],
});
// no links at all
assert.deepStrictEqual(SO.startLinks({}, MAIL, PLAIN), { ports: 1, connections: [], dropped: [] });

// i18n: every warning line's params fill the en strings with the {{x}} rule i18n.js uses -- no brace left
const en = require('../../i18n/en.json');
const lookup = (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
for (const { key, params } of SO.warning('New email', [{ workflow_name: 'AA test' }], 'new_mail')) {
    const raw = lookup(key);
    assert.strictEqual(typeof raw, 'string', key);
    const out = raw.replace(/\{\{(\w+)\}\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    assert.ok(!out.includes('{'), `${key}: ${out}`);
}

// startView (spec 2026-10-14 event-worker §5)
{
    const test = (name, fn) => { try { fn(); } catch (e) { e.message = `startView ${name}: ${e.message}`; throw e; } };
    const row = (o) => ({ workflow_id: 64, workflow_name: 'email prototype', mode: 'option', watch_state: 'waiting',
        watch_message: null, checked_age_s: 3, activated_age_s: 100, ...o });
    const v = (mode, active, wf = 64) => SO.startView(mode, active, wf);
    test('prompt mode keeps ▶ as the run door', () => assert.deepStrictEqual(v('prompt', row()), { button: 'run', hint: null }));
    test('not active', () => assert.deepStrictEqual(v(1, null), { button: 'activate', hint: { key: 'workflow.active.notActive', params: {} } }));
    test('another workflow active', () => assert.strictEqual(v(1, row({ workflow_id: 70 })).button, 'activate'));
    test('listening', () => assert.deepStrictEqual(v(1, row()), { button: 'deactivate', hint: { key: 'workflow.active.listening', params: {} } }));
    test('fallback', () => assert.strictEqual(v(1, row({ watch_message: 'fallback' })).hint.key, 'workflow.active.listeningFallback'));
    test('running', () => assert.strictEqual(v(1, row({ watch_state: 'running' })).hint.key, 'workflow.active.running'));
    test('scheduled', () => assert.deepStrictEqual(v('schedule', row({ mode: 'schedule', watch_state: 'scheduled', watch_message: '2026-10-15 09:00:00' })).hint,
        { key: 'workflow.active.scheduled', params: { next: '2026-10-15 09:00:00' } }));
    test('reconnect', () => assert.strictEqual(v(1, row({ watch_state: 'error', watch_message: 'reconnect_needed' })).hint.key, 'workflow.active.needsReconnect'));
    test('unreachable', () => assert.strictEqual(v(1, row({ watch_state: 'error', watch_message: 'http_502' })).hint.key, 'workflow.active.unreachable'));
    test('other error', () => assert.deepStrictEqual(v(1, row({ watch_state: 'error', watch_message: 'bad_answer' })).hint,
        { key: 'workflow.active.errorOther', params: { message: 'bad_answer' } }));
    test('a failed run, backing off', () => assert.deepStrictEqual(v(1, row({ watch_state: 'error', watch_message: 'run_failed' })).hint,
        { key: 'workflow.active.runFailed', params: {} }));
    test('a failed run, listening again', () => assert.deepStrictEqual(v(1, row({ watch_message: 'run_failed' })),
        { button: 'deactivate', hint: { key: 'workflow.active.lastRunFailed', params: {} } }));
    test('run failure keys exist in en/es/fr', () => {
        for (const lang of ['en', 'es', 'fr']) {
            const t = require(`../../i18n/${lang}.json`).workflow.active;
            for (const key of ['runFailed', 'lastRunFailed']) assert.strictEqual(typeof t[key], 'string', `${lang} ${key}`);
        }
    });
    test('a paused schedule is not offered Activate', () => {
        assert.strictEqual(SO.startMode({ id: 9, status: 'paused', repeat_type: 'daily' }), 'prompt');
        assert.strictEqual(SO.startMode({ id: 9, status: 'paused', repeat_type: 'event', trigger_component_id: 2 }), 'prompt');
        assert.deepStrictEqual(v(SO.startMode({ id: 9, status: 'paused' }), null), { button: 'run', hint: null });
        assert.strictEqual(SO.startMode({ id: 9, status: 'pending' }), 'schedule');
        assert.strictEqual(SO.startMode({ id: 9, status: 'pending', trigger_component_id: '2' }), 2);
        assert.strictEqual(SO.startMode(null), 'prompt');
        assert.strictEqual(v(SO.startMode({ id: 9, status: 'pending' }), null).button, 'activate');
    });
    test('idle reasons', () => {
        assert.strictEqual(v(1, row({ watch_state: 'idle', watch_message: 'no_links' })).hint.key, 'workflow.active.noLinks');
        assert.strictEqual(v(1, row({ watch_state: 'idle', watch_message: 'disabled' })).hint.key, 'workflow.active.disabled');
        assert.strictEqual(v(1, row({ watch_state: 'idle', watch_message: 'mode_gone' })).hint.key, 'workflow.active.modeGone');
    });
    test('stale heartbeat', () => {
        assert.strictEqual(v(1, row({ checked_age_s: 61 })).hint.key, 'workflow.active.serviceDown');
        assert.strictEqual(v(1, row({ checked_age_s: null, watch_state: 'starting', activated_age_s: 61 })).hint.key, 'workflow.active.serviceDown');
        assert.strictEqual(v(1, row({ checked_age_s: null, watch_state: 'starting', activated_age_s: 4 })).hint.key, 'workflow.active.starting');
    });
}

console.log('start-options.test.js: OK');

// Start's state dot: grey when not active, green when working, amber with a caveat, red when not listening.
assert.strictEqual(SO.stateTone('workflow.active.notActive'), 'off');
assert.strictEqual(SO.stateTone('workflow.active.listening'), 'ok');
assert.strictEqual(SO.stateTone('workflow.active.scheduled'), 'ok');
assert.strictEqual(SO.stateTone('workflow.active.starting'), 'warn');
assert.strictEqual(SO.stateTone('workflow.active.lastRunFailed'), 'warn');
assert.strictEqual(SO.stateTone('workflow.active.serviceDown'), 'err');
assert.strictEqual(SO.stateTone('workflow.active.unreachable'), 'err');
for (const view of [SO.startView('option', null, 7), SO.startView('option', { workflow_id: 7, checked_age_s: 3, watch_state: 'waiting' }, 7)]) {
    assert.ok(['off', 'ok', 'warn', 'err'].includes(SO.stateTone(view.hint.key)));
}
console.log('start-options stateTone: ok');

// The live overlay (spec 2026-10-15 live-overlay §4): one action per server run event.
const LA = (e) => SO.liveAction(e, '17');
assert.deepStrictEqual(LA({ type: 'workflow_start', run_id: 'x' }), { turn: 'open' });
assert.deepStrictEqual(LA({ type: 'node_start', node_id: 2598, drawflow_id: '18' }), { node: '18', state: 'active' });
assert.deepStrictEqual(LA({ type: 'node_complete', node_id: 2598, drawflow_id: '18', success: true }), { node: '18', state: 'completed' });
assert.deepStrictEqual(LA({ type: 'node_complete', node_id: 2601, drawflow_id: '21', success: false, error: 'boom' }),
    { node: '21', state: 'error', trace: 'boom' });
// The Start option's hidden code node is Start on the canvas; its output is the event.
assert.deepStrictEqual(LA({ type: 'node_start', node_id: '1000002597', drawflow_id: null }), { node: '17', state: 'active' });
assert.deepStrictEqual(LA({ type: 'node_complete', node_id: '1000002597', drawflow_id: null, success: true,
    output: 'From: a@b.com\nSubject: test 23\nReceived: 2026-10-15T14:19:12Z\n\nbody' }),
    { node: '17', state: 'completed', subject: 'From: a@b.com\nSubject: test 23\nReceived: 2026-10-15T14:19:12Z\n\nbody' });
assert.deepStrictEqual(LA({ type: 'node_log', message: 'jev did not classify' }), { trace: 'jev did not classify' });
assert.strictEqual(LA({ type: 'node_log' }), null);
assert.deepStrictEqual(LA({ type: 'workflow_complete', success: true, output: 'done' }), { answer: 'done' });
assert.deepStrictEqual(LA({ type: 'workflow_error', error: 'Unconfigured agent template' }), { error: 'Unconfigured agent template' });
assert.deepStrictEqual(LA({ type: 'workflow_complete', success: false }), { error: 'Run failed' });
assert.strictEqual(LA({ type: 'node_trace' }), null);
assert.strictEqual(LA(null), null);
assert.strictEqual(SO.eventSubject('x'.repeat(300)).length, 300);
assert.strictEqual(SO.eventSubject('x'.repeat(5000)).length, 4000);
assert.strictEqual(SO.eventSubject(''), '');
// A job (JSON object) is shown whole and indented, not cut mid-field; capped at 4000 characters.
const job = { task: 'a'.repeat(40), number: 'SCTASK0010004', answers: { message: 'Hello from serviceNow', synergyai_automation: 'hello-note@19' } };
assert.strictEqual(SO.eventSubject(JSON.stringify(job)), JSON.stringify(job, null, 2));
assert.strictEqual(SO.eventSubject(JSON.stringify({ big: 'x'.repeat(5000) })).length, 4000);
assert.strictEqual(SO.eventSubject('[1, 2]'), '[1, 2]');
// An email is shown whole, body included (trimmed).
assert.strictEqual(SO.eventSubject('\nFrom: ana@example.com\nSubject:\n\nbody text\n'), 'From: ana@example.com\nSubject:\n\nbody text');
console.log('start-options liveAction: ok');

// A dispatcher's node_complete carries its route (the chosen node's database id): the live view fades the other links.
assert.deepStrictEqual(SO.liveAction({ type: 'node_complete', node_id: 2598, drawflow_id: '18', success: true,
    route: { id: 2600, name: 'information', notes: '' } }, '17'), { node: '18', state: 'completed', route: '2600' });
assert.deepStrictEqual(SO.liveAction({ type: 'node_complete', node_id: 2598, drawflow_id: '18', success: true, route: null }, '17'),
    { node: '18', state: 'completed' });
console.log('start-options liveAction route: ok');

// compiled live source (spec 2026-10-15 §6)
assert.deepStrictEqual(SO.compiledLiveState({ compiled: { line: 'Listening for events', tone: 'ok', listening: true } }),
    { text: 'Listening for events', tone: 'ok', listening: true });
assert.deepStrictEqual(SO.compiledLiveState({}), { text: '', tone: 'off', listening: false });
assert.strictEqual(SO.liveSourceLabel('compiled', k => k), 'workflow.live.compiledTarget');
assert.strictEqual(SO.liveSourceLabel('server', k => k), 'workflow.live.target');
// a compiled run's trigger event maps like a server one (drawflow_id null, node_id >= 1e9)
assert.deepStrictEqual(SO.liveAction({ type: 'node_start', node_id: '1000000017', drawflow_id: null }, '5'), { node: '5', state: 'active' });
console.log('start-options compiled live: ok');

// argFields: the Start arguments an option's code reads (the ServiceNow get-new-job component), each once, defaults kept
{
    const fs = require('fs');
    const path = require('path');
    const src = path.resolve(__dirname, '../../../../../servicenow/components/get_new_job.py');
    if (fs.existsSync(src)) {
        assert.deepStrictEqual(SO.argFields(fs.readFileSync(src, 'utf8')), [
            { name: 'tag', default: '' }, { name: 'version', default: '' }, { name: 'hand_back_group', default: 'Service Desk' }]);
    }
    assert.deepStrictEqual(SO.argFields('x = ARGS["folder"]\ny = args.get(\'folder\')\nz = args.get("limit", "10")'),
        [{ name: 'folder', default: '' }, { name: 'limit', default: '10' }]);
    assert.deepStrictEqual(SO.argFields('globals().get("ARGS")\nkwargs.get("x")'), []);   // not an argument read
    assert.deepStrictEqual(SO.argFields(null), []);

    // startArgs: digits become an integer, an empty field is dropped, keys the code does not read stay
    const fields = [{ name: 'tag' }, { name: 'version' }, { name: 'hand_back_group' }];
    assert.deepStrictEqual(SO.startArgs({ tag: 'old', version: 1, hand_back_group: 'HR', extra: true }, fields,
        { tag: ' team-transfer ', version: '3', hand_back_group: '' }), { tag: 'team-transfer', version: 3, extra: true });
    assert.deepStrictEqual(SO.startArgs(null, fields, { tag: 'synergyai:okta-reset' }), { tag: 'synergyai:okta-reset' });
    assert.deepStrictEqual(SO.startArgs([], fields, {}), {});
    console.log('start-options argFields/startArgs: ok');
}
