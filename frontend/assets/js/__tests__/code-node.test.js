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
console.log('code-node.test.js: OK');
