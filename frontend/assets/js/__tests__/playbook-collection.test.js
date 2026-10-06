const assert = require('assert');
const PC = require('../playbook-collection.js');

assert.strictEqual(PC.keyFromTitle('Okta password reset'), 'okta-password-reset');
assert.strictEqual(PC.keyFromTitle('  Time off & leave!! '), 'time-off-leave');
assert.strictEqual(PC.keyFromTitle('###'), 'playbook');
assert.strictEqual(PC.keyFromTitle('abcd'.repeat(20)).length, 64);
assert.ok(PC.isValidKey('okta-reset'));
for (const bad of ['Okta', 'okta--reset', '-okta', 'okta_reset', '', 'a'.repeat(65)]) assert.ok(!PC.isValidKey(bad), bad);

const text = 'A note.\n\n## Title: Okta password reset\nTrigger: locked out\nInstructions:\n1. #Search Okta Users\nTools used: Okta; ServiceNow\nActions used: #Search Okta Users\n';
assert.strictEqual(PC.titleOf(text), 'Okta password reset');
assert.deepStrictEqual(PC.toolsUsedOf(text), ['Okta', 'ServiceNow']);
assert.strictEqual(PC.titleOf('no sections'), '');

PC.cache.put({ id: 7, pkey: 'okta-reset', title: 'Okta', text });
assert.strictEqual(PC.cache.get(7).pkey, 'okta-reset');
PC.cache.drop(7);
assert.strictEqual(PC.cache.get(7), null);
// A playbook node links by playbook_id: its data never carries the text.
PC.cache.put({ id: 7, pkey: 'okta-reset', title: 'Okta password reset', text });
const nd = PC.nodeData({ name: 'Okta', playbook_id: '7', playbook: 'stale copy', agent_id: '3', model: 'm' });
assert.deepStrictEqual(nd, { type: 'playbook', node_type: 'playbook', name: 'Okta', playbook_id: 7, agent_id: 3,
    agent_provider: '', model: 'm', mcp_servers: [], writes_enabled: true, disabled: false });
assert.strictEqual(PC.nodeData({ writes_enabled: false }).writes_enabled, false);
assert.strictEqual(PC.nodeData(null).name, 'Playbook');
assert.strictEqual(PC.nodeData(null).playbook_id, null);

// Summary and badges read the text from the cache; a missing id says so.
assert.deepStrictEqual(PC.nodeSummary(nd), { text: 'Okta password reset', missing: false });
assert.deepStrictEqual(PC.nodeSummary({ playbook_id: 99 }), { text: 'Playbook #99 not found', missing: true });
assert.deepStrictEqual(PC.nodeSummary({}), { text: 'No playbook pasted yet', missing: false });
assert.deepStrictEqual(PC.nodeServerNames(nd), ['Okta', 'ServiceNow']);
assert.deepStrictEqual(PC.nodeServerNames({ ...nd, mcp_servers: ['okta'] }), ['okta']);
assert.deepStrictEqual(PC.nodeServerNames({ playbook_id: 99 }), []);

// The run sends the reference, never the text.
assert.deepStrictEqual(PC.runNodeConfig({ ...nd, playbook: 'x', agent_provider: 'claude' }),
    { playbook_id: 7, agent_provider: 'claude', model: 'm', name: 'Okta', writes_enabled: true });

// Key checks for the form: invalid, taken by ANOTHER cached playbook, or fine.
assert.strictEqual(PC.keyProblem('Bad Key', null), 'keyInvalid');
assert.strictEqual(PC.keyProblem('okta-reset', null), 'keyTaken');
assert.strictEqual(PC.keyProblem('okta-reset', 7), null);
assert.strictEqual(PC.keyProblem('okta-reset', '7'), null);
assert.strictEqual(PC.keyProblem('fresh-key', null), null);
assert.strictEqual(PC.keyProblem('', null), null);
PC.cache.drop(7);
console.log('playbook-collection.test.js: OK');
