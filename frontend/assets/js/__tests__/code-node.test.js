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
assert.deepStrictEqual(CN.validateConfig({ code: 'def run(i, c):\n    return i', exits: ['next'], mcp_tools: [], timeout_s: 30 }), []);
const errs = CN.validateConfig({ code: '', exits: ['Job', 'job', 'job'], mcp_tools: ['servicenow'], timeout_s: 0 });
assert.ok(errs.length >= 4, JSON.stringify(errs));

// templates
assert.deepStrictEqual(CN.TEMPLATES.poll_servicenow.exits, ['job', 'no_job', 'error']);
assert.deepStrictEqual(CN.TEMPLATES.poll_servicenow.mcp_tools, ['servicenow.poll_jobs']);
assert.ok(CN.TEMPLATES.passthrough.code.includes('return input'));

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
// an exit with no children is not reported
assert.deepStrictEqual(CN.remapExits(['job', 'spare'], ['job'], { output_1: { connections: [] } }).dropped, []);

// a loaded config with null / non-array exits or tools falls back to the defaults
assert.deepStrictEqual(CN.normalizeConfig({ exits: null, mcp_tools: 'x', name: 'P' }, { exits: ['next'], mcp_tools: [] }),
    { exits: ['next'], mcp_tools: [], name: 'P' });
assert.deepStrictEqual(CN.normalizeConfig({ exits: [], mcp_tools: ['a.b'] }, { exits: ['next'], mcp_tools: [] }),
    { exits: ['next'], mcp_tools: ['a.b'] });
console.log('code-node.test.js: OK');
