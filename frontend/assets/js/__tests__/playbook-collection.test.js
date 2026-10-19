const assert = require('assert');
const PC = require('../playbook-collection.js');

assert.strictEqual(PC.keyFromTitle('Okta password reset'), 'okta-password-reset');
assert.strictEqual(PC.keyFromTitle('  Time off & leave!! '), 'time-off-leave');
assert.strictEqual(PC.keyFromTitle('###'), 'playbook');
assert.strictEqual(PC.keyFromTitle('Réinitialisation'), 'reinitialisation');
assert.strictEqual(PC.keyFromTitle('Ça va'), 'ca-va');
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

// nodeData keeps playbook_source, playbook_input_field and exits; an old node (none of them) gains nothing.
const ex = PC.nodeData({ name: 'Robot', playbook_source: 'input', playbook_input_field: 'pb', exits: ['done', 'failed'] });
assert.strictEqual(ex.playbook_source, 'input');
assert.strictEqual(ex.playbook_input_field, 'pb');
assert.deepStrictEqual(ex.exits, ['done', 'failed']);
assert.strictEqual(PC.nodeData({ playbook_source: 'input' }).playbook_input_field, 'playbook');
assert.strictEqual(PC.nodeData({ playbook_source: 'bogus' }).playbook_source, undefined);
for (const k of ['playbook_source', 'playbook_input_field', 'exits']) assert.ok(!(k in nd), k);
assert.deepStrictEqual(PC.runNodeConfig(ex), { playbook_id: null, agent_provider: '', model: '', name: 'Robot', writes_enabled: true,
    playbook_source: 'input', playbook_input_field: 'pb', exits: ['done', 'failed'] });
assert.strictEqual(PC.nodeSummary(ex).missing, false);
assert.strictEqual(PC.nodeSummary(ex).text, 'From the job (pb)');

// Ruling 12: an unlinked node (saved before the collection) keeps, shows and runs its text.
const legacy = PC.nodeData({ name: 'Old', playbook: text, policy: { on_failure: 'stop' }, approvers: ['alice'] });
assert.strictEqual(legacy.playbook_id, null);
assert.strictEqual(legacy.playbook, text);
assert.deepStrictEqual(legacy.policy, { on_failure: 'stop' });
assert.deepStrictEqual(legacy.approvers, ['alice']);
assert.strictEqual(PC.nodeText(legacy), text);
assert.deepStrictEqual(PC.nodeSummary(legacy), { text: 'Okta password reset', missing: false });
assert.deepStrictEqual(PC.nodeServerNames(legacy), ['Okta', 'ServiceNow']);
assert.deepStrictEqual(PC.runNodeConfig(legacy),
    { playbook_id: null, playbook: text, agent_provider: '', model: '', name: 'Old', writes_enabled: true });
assert.strictEqual(PC.saveAction(legacy.playbook_id, PC.nodeText(legacy)), 'create');
// A linked node drops a stale text copy; a JSON-object node playbook reads as console text.
assert.ok(!('playbook' in nd));
const objNode = PC.nodeData({ playbook: { title: 'Obj', trigger: { description: 'asked' }, instructions: '1. do it', tools_used: ['Okta'], actions_used: ['#Do'] } });
assert.strictEqual(PC.nodeText(objNode), 'Title: Obj\nTrigger: asked\nInstructions:\n1. do it\nTools used: Okta\nActions used: #Do\n');
assert.strictEqual(PC.nodeSummary(objNode).text, 'Obj');
assert.deepStrictEqual(PC.runNodeConfig(objNode).playbook, objNode.playbook);

// Key checks for the form: invalid, taken by ANOTHER cached playbook, or fine.
assert.strictEqual(PC.keyProblem('Bad Key', null), 'keyInvalid');
assert.strictEqual(PC.keyProblem('okta-reset', null), 'keyTaken');
assert.strictEqual(PC.keyProblem('okta-reset', 7), null);
assert.strictEqual(PC.keyProblem('okta-reset', '7'), null);
assert.strictEqual(PC.keyProblem('fresh-key', null), null);
assert.strictEqual(PC.keyProblem('', null), null);
PC.cache.drop(7);
// writes_enabled follows the form: only an explicit false turns writes off.
assert.strictEqual(PC.nodeData({ writes_enabled: undefined }).writes_enabled, true);
assert.strictEqual(PC.nodeData({ writes_enabled: 0 }).writes_enabled, true);

// Save decisions: update a cached row, create when unlinked or the link is gone, skip when nothing typed.
PC.cache.put({ id: 8, pkey: 'eight', title: 'Eight', text });
assert.strictEqual(PC.saveAction(8, ''), 'update');
assert.strictEqual(PC.saveAction(null, text), 'create');
assert.strictEqual(PC.saveAction(null, '  '), 'skip');
assert.strictEqual(PC.saveAction(99, text), 'create');
assert.strictEqual(PC.saveAction(99, ''), 'skip');

// Publishing labels: only for a caller who can use the robot.
assert.strictEqual(PC.publishLabel({ published: 'published' }, true), 'Published');
assert.strictEqual(PC.publishLabel({ published: 'changed' }, true), 'Published (changed since)');
assert.strictEqual(PC.publishLabel({ published: null }, true), '');
assert.strictEqual(PC.publishLabel({}, true), '');
assert.strictEqual(PC.publishLabel({ published: 'published' }, false), '');
assert.strictEqual(PC.publishLabel({ published: 'changed' }, true, (k) => 'T:' + k), 'T:playbookLibrary.publishedChanged');

// The replace confirmation: first click publishes plainly; a `replaces` answer arms with the message;
// the second click (same key) confirms; any other answer disarms.
let st = PC.publishStep(null, { type: 'click', key: 'okta-reset' });
assert.strictEqual(st.confirmReplace, false);
const replaces = Object.assign(new Error('The robot already has "okta-reset"'), { kind: 'replaces', status: 409,
    data: { published_by: 'Ada Lovelace', published_at: '2026-10-05 14:03:00' } });
st = PC.publishStep(st, { type: 'error', error: replaces, key: 'okta-reset' });
assert.deepStrictEqual(st, { armed: true, key: 'okta-reset',
    message: 'Replaces okta-reset published by Ada Lovelace on 2026-10-05' });
st = PC.publishStep(st, { type: 'click', key: 'okta-reset' });
assert.strictEqual(st.confirmReplace, true);
assert.strictEqual(PC.publishStep({ armed: true, key: 'okta-reset', message: 'x' }, { type: 'click', key: 'other' }).confirmReplace, false);
st = PC.publishStep(st, { type: 'ok' });
assert.deepStrictEqual(st, { armed: false, key: null, message: '', published: true });
st = PC.publishStep({ armed: true, key: 'k', message: 'x' }, { type: 'error', error: new Error("Your role can't publish to the robot"), key: 'k' });
assert.deepStrictEqual(st, { armed: false, key: null, message: "Your role can't publish to the robot" });
st = PC.publishStep(null, { type: 'error', error: replaces, key: 'k' }, (k, p) => `${k}|${p.key}|${p.name}|${p.date}`);
assert.strictEqual(st.message, 'playbookLibrary.replacesConfirm|k|Ada Lovelace|2026-10-05');

// Unpublish arms on the first click of a target and fires on the second click of the SAME target.
let arm = PC.armClick(null, 'robot:5');
assert.deepStrictEqual(arm, { fire: false, armed: 'robot:5' });
assert.deepStrictEqual(PC.armClick(arm.armed, 'robot:6'), { fire: false, armed: 'robot:6' });
assert.deepStrictEqual(PC.armClick(arm.armed, 'robot:5'), { fire: true, armed: null });

(async () => {
    // A failed load is remembered: a linked id that is not cached is "unloaded", not "not found".
    await assert.rejects(PC.cache.load({ list: async () => { throw new Error('HTTP 500'); } }));
    assert.strictEqual(PC.cache.loadFailed(), true);
    assert.strictEqual(PC.saveAction(99, text), 'unloaded');
    assert.strictEqual(PC.saveAction(8, text), 'update'); // a failed load keeps the rows it had
    assert.deepStrictEqual(PC.nodeSummary({ playbook_id: 99 }), { text: 'Could not load playbooks', missing: true, loadFailed: true });
    await PC.cache.load({ list: async () => ({ data: [{ id: 5, pkey: 'five', title: 'Five', text }] }) });
    assert.strictEqual(PC.cache.loadFailed(), false);
    assert.deepStrictEqual(PC.nodeSummary({ playbook_id: 99 }), { text: 'Playbook #99 not found', missing: true });
    assert.strictEqual(PC.cache.get(8), null);
    console.log('playbook-collection.test.js: OK');
})().catch((e) => { console.error(e); process.exit(1); });
