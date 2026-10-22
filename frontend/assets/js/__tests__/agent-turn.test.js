const assert = require('assert');
const AgentTurn = require('../agent-turn.js');

// appendRound: every round of the turn is kept, in order, so a follow-up carries the whole turn —
// not only the last round (the model would forget earlier results, and the backend's "no
// run_skill_script yet" check would force the script again after every other tool).
const r1 = [{ call: { id: 't1', name: 'save_automation', input: { key: 'k' } }, toolResultPayload: { version: 15 } }];
const r2 = [{ call: { id: 't2', name: 'run_skill_script', input: { dir_name: 'd' } }, toolResultPayload: 'VALID' },
    { call: { id: 't3', name: 'save_workflow', input: {} }, toolResultPayload: { success: true } }];
let rounds = AgentTurn.appendRound([], r1, 'saving', '');
rounds = AgentTurn.appendRound(rounds, r2, 'running', '');
assert.deepStrictEqual(rounds.map(t => t.role), ['assistant', 'tool', 'assistant', 'tool', 'tool']);
assert.deepStrictEqual(rounds.map(t => t.tool_call_id || t.tool_calls.map(c => c.id).join()), ['t1', 't1', 't2,t3', 't2', 't3']);
assert.strictEqual(rounds[1].content, '{"version":15}');
assert.strictEqual(rounds[2].content, 'running');
// the input array is not modified
const before = [];
AgentTurn.appendRound(before, r1, '', '');
assert.deepStrictEqual(before, []);
// a missing prior list starts empty
assert.strictEqual(AgentTurn.appendRound(undefined, r1, '', '').length, 2);

console.log('agent-turn.test.js: all assertions passed');
