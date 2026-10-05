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
console.log('playbook-collection.test.js: OK');
