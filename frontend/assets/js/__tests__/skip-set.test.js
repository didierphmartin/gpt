/**
 * The browser runner's skip set after a node chooses an exit (code node, playbook, dispatcher), extracted from
 * workflow-editor.js -- the twin of DispatchRouting::skipSet on the server.
 *
 * Run: node frontend/assets/js/__tests__/skip-set.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.resolve(__dirname, '../workflow-editor.js'), 'utf8');
const END = '\n    }\n';
function extract(signature) {
    const start = file.indexOf(signature);
    if (start < 0) throw new Error('could not find: ' + signature.trim());
    return file.slice(start, file.indexOf(END, start) + END.length).trim();
}

// eslint-disable-next-line no-new-func
const Editor = new Function(`return class { ${extract('_wfSkipSet(unchosenIds, nodes')} ${extract('_wfUpstreamIds(nodeId, nodes)')} }`)();
const ed = new Editor();

// nodes in drawflow's shape: inputs.input_1.connections = [{node: parent}]
function graph(edges) {
    const nodes = {};
    for (const [from, to] of edges) {
        nodes[from] = nodes[from] || { inputs: {} };
        nodes[to] = nodes[to] || { inputs: {} };
        nodes[to].inputs.input_1 = nodes[to].inputs.input_1 || { connections: [] };
        nodes[to].inputs.input_1.connections.push({ node: from });
    }
    return nodes;
}
const sorted = (a) => [...a].sort();

// 1 Start → 2 Convert; Convert done → 3 Store, error → 4 Output; Store → 4 Output
const mail = graph([['1', '2'], ['2', '3'], ['2', '4'], ['3', '4']]);
// Convert took done: Output is still fed by Store, so nothing is skipped.
assert.deepStrictEqual(ed._wfSkipSet(['4'], mail, '2'), []);
// Convert took error: Store is skipped, Output stays (it is the error target).
assert.deepStrictEqual(ed._wfSkipSet(['3'], mail, '2'), ['3']);
// A target only the chooser feeds is skipped, and so is what only it feeds.
const branch = graph([['1', '2'], ['2', '3'], ['2', '5'], ['5', '6'], ['3', '4']]);
assert.deepStrictEqual(sorted(ed._wfSkipSet(['5'], branch, '2')), ['5', '6']);
// Without a chooser (older callers): the unchosen targets are skipped outright, as before.
assert.deepStrictEqual(sorted(ed._wfSkipSet(['4'], mail)), ['4']);

console.log('skip-set: all assertions passed');
