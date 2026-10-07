const assert = require('assert');
const CN = require('../code-node.js');

// Drawflow-shaped nodes: outputs.output_k.connections[{node, output}], inputs.input_1.connections[{node, input}]
const nodes = {
    1: { data: { type: 'start' }, outputs: { output_1: { connections: [{ node: '2', output: 'input_1' }] } }, inputs: {} },
    2: { data: { type: 'code', name: 'Poll', exits: ['job', 'no_job'] },
         inputs: { input_1: { connections: [{ node: '1', input: 'output_1' }, { node: '9', input: 'output_1' }] } },
         outputs: { output_1: { connections: [{ node: '3', output: 'input_1' }, { node: '5', output: 'input_1' }] },
                    output_2: { connections: [{ node: '4', output: 'input_1' }] } } },
    3: { data: { type: 'playbook', name: 'Reset' }, inputs: {}, outputs: {} },
    4: { data: { type: 'output' }, inputs: {}, outputs: {} },
    5: { data: { type: 'output' }, inputs: {}, outputs: {} },
    9: { data: { type: 'agent', agent_name: 'Skipped' }, inputs: {}, outputs: {} },
};
const kindOf = (id) => ({ 1: 'start', 2: 'code', 3: 'playbook', 4: 'output', 5: 'output', 9: 'agent' })[id];

// ports <-> exits
assert.strictEqual(CN.exitForPort(['job', 'no_job'], 'output_2'), 'no_job');
assert.strictEqual(CN.exitForPort(['job'], 'output_2'), null);
assert.strictEqual(CN.portForExit(['job', 'no_job'], 'job'), 'output_1');
assert.deepStrictEqual(CN.targetsForExit('2', nodes, 'job', ['job', 'no_job']), ['3', '5']);
assert.deepStrictEqual(CN.targetsForExit('2', nodes, 'no_job', ['job', 'no_job']), ['4']);

// parents: start flagged, a skipped parent (empty output) left out -- review focus 2
assert.deepStrictEqual(CN.parentsFor('2', nodes, { 1: 'poll now', 9: '' }, kindOf),
    [{ name: 'start', text: 'poll now', start: true }]);
assert.deepStrictEqual(CN.parentsFor('2', nodes, { 1: 'p', 9: 'x' }, kindOf),
    [{ name: 'start', text: 'p', start: true }, { name: 'Skipped', text: 'x', start: false }]);

// edges keep their real port -- review focus 1
assert.deepStrictEqual(CN.edgesFrom('2', nodes[2]), [
    { to: '3', from_port: 'output_1', to_port: 'input_1' },
    { to: '5', from_port: 'output_1', to_port: 'input_1' },
    { to: '4', from_port: 'output_2', to_port: 'input_1' },
]);

// config validation
assert.deepStrictEqual(CN.validateConfig({ code: 'def run(i, c):\n    return i', exits: ['next'], mcp_servers: ['ServiceNow'], timeout_s: 30 }), []);
const errs = CN.validateConfig({ code: '', exits: ['Job', 'job', 'job'], mcp_servers: [''], timeout_s: 0 });
assert.ok(errs.length >= 4, JSON.stringify(errs));
assert.ok(CN.validateConfig({ code: 'def run(i, c):\n    return i', exits: ['next'], mcp_servers: 'x', timeout_s: 30 }).length === 1);

// the server slug call_tool uses: twin of CodeNodeEmit::slug
assert.strictEqual(CN.slug('ServiceNow'), 'servicenow');
assert.strictEqual(CN.slug('Service Now (prod)'), 'service_now_prod_');

// templates
// the default is generic: one exit, no server, code that explains the contract and passes input on
assert.strictEqual(CN.DEFAULT_TEMPLATE, 'blank');
assert.deepStrictEqual(CN.TEMPLATES.blank.exits, ['next']);
assert.deepStrictEqual(CN.TEMPLATES.blank.servers, []);
assert.ok(CN.TEMPLATES.blank.code.includes('def run(input, call_tool):'));
assert.ok(CN.TEMPLATES.blank.code.includes('return input'));
assert.ok(!/servicenow/i.test(CN.TEMPLATES.blank.code));
// ServiceNow polling stays as an example, naming the server it needs by slug
assert.deepStrictEqual(CN.TEMPLATES.poll_servicenow.exits, ['job', 'no_job', 'error']);
assert.deepStrictEqual(CN.TEMPLATES.poll_servicenow.servers, ['servicenow']);
assert.ok(!('mcp_tools' in CN.TEMPLATES.poll_servicenow));

// parent naming parity with compiled (LangGraphGenerator::displayName -> node_<id>)
const anon = { 7: { data: { type: 'code' }, inputs: { input_1: { connections: [{ node: '8', input: 'output_1' }] } }, outputs: {} },
               8: { data: { type: 'code' }, inputs: {}, outputs: {} } };
assert.deepStrictEqual(CN.parentsFor('7', anon, { 8: 'x' }, () => 'code'), [{ name: 'node_8', text: 'x', start: false }]);

// timeout / worker failure -> the error exit when the node has one (spec 3.4), else a failure
assert.deepStrictEqual(CN.failureResult(['job', 'error'], 'timed out after 30s'),
    { ok: true, route: 'error', output_text: JSON.stringify({ error: 'CodeNodeError: timed out after 30s' }), stdout: '', tool_calls: [] });
assert.deepStrictEqual(CN.failureResult(['job'], 'worker crashed'),
    { ok: false, error: 'CodeNodeError: worker crashed', stdout: '', tool_calls: [] });

// after a run: which children are skipped
const ok = CN.routeAfter('2', nodes, { ok: true, route: 'no_job', output_text: 'null' }, ['job', 'no_job']);
assert.deepStrictEqual(ok, { success: true, output: 'null', exit: 'no_job', chosen: ['4'], skip: ['3', '5'] });
const failed = CN.routeAfter('2', nodes, { ok: false, error: 'ToolError: boom' }, ['job', 'no_job']);
assert.deepStrictEqual(failed, { success: false, output: 'Error: ToolError: boom', exit: null, chosen: [], skip: ['3', '5', '4'] });
// an exit with no edge: every child is skipped, and that is not a failure
const unwired = CN.routeAfter('2', nodes, { ok: true, route: 'job', output_text: '1' }, ['next', 'no_job', 'job']);
assert.deepStrictEqual(unwired.chosen, []);
assert.deepStrictEqual(unwired.skip, ['3', '5', '4']);

// run success: an Output cut off by a code node's unwired exit is not a failure; its output stays ''
assert.strictEqual(CN.runSucceeded({ finalOutput: '', hadError: false, remaining: 0, outputEndedByRoute: true }), true);
assert.strictEqual(CN.runSucceeded({ finalOutput: '', hadError: false, remaining: 0, outputEndedByRoute: false }), false);
assert.strictEqual(CN.runSucceeded({ finalOutput: 'x', hadError: true, remaining: 0, outputEndedByRoute: false }), false);
assert.strictEqual(CN.runSucceeded({ finalOutput: '', hadError: true, remaining: 0, outputEndedByRoute: true }), false);
assert.strictEqual(CN.runSucceeded({ finalOutput: 'x', hadError: false, remaining: 1, outputEndedByRoute: false }), false);
assert.strictEqual(CN.runSucceeded({ finalOutput: 'x', hadError: false, remaining: 0, outputEndedByRoute: false }), true);

// exits change: edges follow exits BY NAME
const outs = { output_1: { connections: [{ node: '3', output: 'input_1' }] },          // job
               output_2: { connections: [{ node: '4', output: 'input_1' }, { node: '6', output: 'input_1' }] }, // no_job
               output_3: { connections: [{ node: '5', output: 'input_1' }] } };        // error
// middle exit removed: error keeps its child on its new port
assert.deepStrictEqual(CN.remapExits(['job', 'no_job', 'error'], ['job', 'error'], outs), {
    connections: [{ port: 'output_1', node: '3', input: 'input_1' }, { port: 'output_2', node: '5', input: 'input_1' }],
    dropped: [{ exit: 'no_job', count: 2 }] });
// reorder: children follow their exit
assert.deepStrictEqual(CN.remapExits(['job', 'no_job', 'error'], ['error', 'job', 'no_job'], outs).connections, [
    { port: 'output_2', node: '3', input: 'input_1' }, { port: 'output_3', node: '4', input: 'input_1' },
    { port: 'output_3', node: '6', input: 'input_1' }, { port: 'output_1', node: '5', input: 'input_1' }]);
// rename = removed + added: the renamed exit's children are dropped
assert.deepStrictEqual(CN.remapExits(['job', 'no_job', 'error'], ['job', 'idle', 'error'], outs).dropped, [{ exit: 'no_job', count: 2 }]);
// branching removed (one exit left, e.g. Exits cleared): every link moves onto the single connector
assert.deepStrictEqual(CN.remapExits(['job', 'no_job', 'error'], ['next'], outs), {
    connections: [{ port: 'output_1', node: '3', input: 'input_1' }, { port: 'output_1', node: '4', input: 'input_1' },
                  { port: 'output_1', node: '6', input: 'input_1' }, { port: 'output_1', node: '5', input: 'input_1' }],
    dropped: [] });
// ... a target reached from two exits is linked once
const twice = { output_1: { connections: [{ node: '9', output: 'input_1' }] }, output_2: { connections: [{ node: '9', output: 'input_1' }] } };
assert.deepStrictEqual(CN.remapExits(['job', 'no_job'], ['next'], twice).connections, [{ port: 'output_1', node: '9', input: 'input_1' }]);
// branching added (one exit before): its links land on exit 1, or follow its name if it is still there
const single = { output_1: { connections: [{ node: '7', output: 'input_1' }, { node: '8', output: 'input_1' }] } };
assert.deepStrictEqual(CN.remapExits(['next'], ['job', 'no_job', 'error'], single), {
    connections: [{ port: 'output_1', node: '7', input: 'input_1' }, { port: 'output_1', node: '8', input: 'input_1' }],
    dropped: [] });
assert.deepStrictEqual(CN.remapExits(['job'], ['no_job', 'job'], single).connections,
    [{ port: 'output_2', node: '7', input: 'input_1' }, { port: 'output_2', node: '8', input: 'input_1' }]);
// an exit with no children is not reported
assert.deepStrictEqual(CN.remapExits(['job', 'spare'], ['job'], { output_1: { connections: [] } }).dropped, []);

// a loaded config with null / non-array exits or tools falls back to the defaults
assert.deepStrictEqual(CN.normalizeConfig({ exits: null, mcp_servers: 'x', name: 'P' }, { exits: ['next'], mcp_servers: [] }),
    { exits: ['next'], mcp_servers: [], name: 'P' });
assert.deepStrictEqual(CN.normalizeConfig({ exits: [], mcp_servers: ['ServiceNow'] }, { exits: ['next'], mcp_servers: [] }),
    { exits: ['next'], mcp_servers: ['ServiceNow'] });

// run data in the agent nodes' shape, so the Input / Output / Logs tabs show a code node's run
const okRun = { ok: true, route: 'job', output_text: '{"task":"t1"}', stdout: 'hello\n',
    tool_calls: [{ server: 'servicenow', tool: 'poll_jobs', args: {}, ok: true, ms: 12 }] };
const rd = CN.runData(okRun, { parents: [{ name: 'start', text: 'poll', start: true }], user_prompt: 'poll', name: 'Poll', ts: 1000 });
assert.strictEqual(rd.input, 'poll');
assert.strictEqual(rd.output, '{"task":"t1"}');
assert.strictEqual(rd.success, true);
assert.strictEqual(rd.agentName, 'Poll');
assert.strictEqual(rd.code, okRun);
assert.deepStrictEqual(rd.activity.map((a) => [a.level, a.message]), [
    ['info', 'call_tool servicenow.poll_jobs {} → ok (12 ms)'],
    ['info', 'printed:\nhello'],
    ['info', 'exit: job'],
]);
const two = CN.runData(okRun, { parents: [{ name: 'A', text: 'x', start: false }, { name: 'B', text: 'y', start: false }], user_prompt: '', name: 'P', ts: 0 });
assert.strictEqual(two.input, '## A\nx\n\n## B\ny');
const bad = CN.runData({ ok: false, error: 'ToolError: MCP server okta is not checked on this node', stdout: '',
    tool_calls: [{ server: 'okta', tool: 'reset', args: { u: 1 }, ok: false, ms: 0 }] }, { parents: [], user_prompt: 'go', name: 'P', ts: 0 });
assert.strictEqual(bad.success, false);
assert.strictEqual(bad.input, 'go');
assert.strictEqual(bad.output, 'ToolError: MCP server okta is not checked on this node');
assert.deepStrictEqual(bad.activity.map((a) => a.level), ['error', 'error']);
// the error exit is a successful run of the node that took the error route
const errExit = CN.runData({ ok: true, route: 'error', output_text: '{"error":"x"}', stdout: '', tool_calls: [] }, { parents: [], user_prompt: '', name: 'P', ts: 0 });
assert.deepStrictEqual(errExit.activity.map((a) => [a.level, a.message]), [['warn', 'exit: error']]);
// exit tags: one per link leaving a code node, named by its port's exit (edge order)
assert.deepStrictEqual(CN.exitTags('2', nodes), [
    { to: '3', port: 'output_1', exit: 'job' },
    { to: '5', port: 'output_1', exit: 'job' },
    { to: '4', port: 'output_2', exit: 'no_job' },
]);
assert.deepStrictEqual(CN.exitTags('3', nodes), []);
// a port past the exits (exits shrank before the ports did) gets no tag
const stale = { 7: { data: { type: 'code', exits: ['go'] }, inputs: {},
    outputs: { output_1: { connections: [{ node: '8' }] }, output_2: { connections: [{ node: '9' }] } } } };
assert.deepStrictEqual(CN.exitTags('7', stale), [{ to: '8', port: 'output_1', exit: 'go' }]);
// the no-exit state (the single default exit "next") shows no exit anywhere: no tags, empty field, no card line
const plain = { 7: { data: { type: 'code', exits: ['next'] }, inputs: {}, outputs: { output_1: { connections: [{ node: '8' }] } } } };
assert.deepStrictEqual(CN.exitTags('7', plain), []);
assert.strictEqual(CN.exitsText(['next']), '');
assert.strictEqual(CN.exitsText(['job', 'no_job']), 'job, no_job');
assert.strictEqual(CN.exitsLabel(['next']), '');
assert.strictEqual(CN.exitsLabel(['job', 'no_job']), '1:job  2:no_job');
// the Exits field: empty means no branching, the single default exit
assert.deepStrictEqual(CN.parseExits(''), ['next']);
assert.deepStrictEqual(CN.parseExits('  ,  '), ['next']);
assert.deepStrictEqual(CN.parseExits('job, no_job ,error'), ['job', 'no_job', 'error']);
// Poll Outlook template (spec 2026-10-07 §5): three exits, the outlook server, attachments never fetched.
const po = CN.TEMPLATES.poll_outlook;
assert.deepStrictEqual(po.exits, ['new_mail', 'no_mail', 'error']);
assert.deepStrictEqual(po.servers, ['outlook']);
assert.ok(po.code.includes('poll_new_mail'));
assert.ok(!po.code.includes('get_attachment'), 'the template must never open attachments');
assert.strictEqual(CN.validateConfig({ code: po.code, exits: po.exits, mcp_servers: ['Outlook'], timeout_s: 30 }).length, 0);

const rewritten = CN.outlookArgs(po.code, { folder: 'Invoices', from: 'billing@acme.com', subject_contains: '', has_attachments: true });
assert.ok(rewritten.includes('"folder": "Invoices"'));
assert.ok(rewritten.includes('"from": "billing@acme.com"'));
assert.ok(rewritten.includes('"has_attachments": True'));
assert.ok(rewritten.includes('poll_new_mail'));
assert.strictEqual(CN.outlookArgs(rewritten, { folder: 'Inbox' }), po.code, 'rewriting back to the defaults restores the template');
assert.strictEqual(CN.outlookArgs('def run(input, call_tool):\n    return 1\n', { folder: 'X' }), null, 'hand-edited code without the dict is left alone');
// the form reads the filters back from the code (reopening the node), null when the dict is gone
assert.deepStrictEqual(CN.readOutlookArgs(rewritten), { folder: 'Invoices', from: 'billing@acme.com', subject_contains: '', has_attachments: true });
assert.deepStrictEqual(CN.readOutlookArgs(po.code), { folder: 'Inbox', from: '', subject_contains: '', has_attachments: false });
assert.deepStrictEqual(CN.readOutlookArgs(CN.outlookArgs(po.code, { from: 'a "q" \\ b' })).from, 'a "q" \\ b');
assert.strictEqual(CN.readOutlookArgs('def run(input, call_tool):\n    return 1\n'), null);
console.log('code-node.test.js: OK');
