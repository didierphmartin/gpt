const assert = require('assert');
const CA = require('../code-node-assist.js');

const listed = [
    { name: 'Outlook', slug: 'outlook', tools: [
        { name: 'poll_new_mail', description: 'Next unseen email, or mail=null.', inputSchema: { type: 'object' } },
        { name: 'tmp_debug', description: '  ', inputSchema: { type: 'object' } },
        { name: 'nodesc', inputSchema: { type: 'object' } },
    ] },
    { name: 'Jira', slug: 'jira', tools: [], error: 'HTTP 502' },
];

// documented filter: blank and missing descriptions are skipped; failed servers are not usable
assert.strictEqual(CA.isDocumented({ description: 'x' }), true);
assert.strictEqual(CA.isDocumented({ description: ' ' }), false);
assert.strictEqual(CA.isDocumented({}), false);
const { usable, skipped } = CA.splitDocumented(listed);
assert.deepStrictEqual(usable.map((s) => [s.slug, s.tools.map((t) => t.name)]), [['outlook', ['poll_new_mail']]]);
assert.deepStrictEqual(skipped, ['outlook.tmp_debug', 'outlook.nodesc']);

// refuse before asking -- review focus 1
assert.strictEqual(CA.askBlocker(0, []), null);                       // no server ticked: plain Python is fine
assert.strictEqual(CA.askBlocker(2, usable), null);
assert.strictEqual(CA.askBlocker(1, CA.splitDocumented([{ name: 'X', slug: 'x', tools: [{ name: 'a' }] }]).usable), 'noTools');
assert.strictEqual(CA.askBlocker(1, CA.splitDocumented([{ name: 'X', slug: 'x', tools: [], error: 'down' }]).usable), 'noTools');

// the prompt carries the documented tools only, the exits' wiring, the code and the request
const msg = CA.buildUserMessage({ usable, exits: ['next'], wiring: { next: ['Triage'] }, sample: '',
    code: 'def run(input, call_tool):\n    return input\n', request: 'get the next new email' });
assert.ok(msg.includes('"poll_new_mail"') && !msg.includes('tmp_debug') && !msg.includes('nodesc'));
assert.ok(msg.includes('server "outlook"'));
assert.ok(msg.includes('next -> Triage'));
assert.ok(msg.includes('get the next new email'));
assert.ok(msg.includes('return input'));
assert.ok(/no server is checked/i.test(CA.buildUserMessage({ usable: [], exits: ['next'], wiring: {}, sample: '', code: '', request: 'x' })));
assert.ok(CA.SYSTEM_PROMPT.includes('"cannot"') && CA.SYSTEM_PROMPT.includes('def run(input, call_tool)'));

// parsing -- review focus 2
assert.deepStrictEqual(CA.parseAnswer('{"cannot": "no result shape"}'), { kind: 'cannot', reason: 'no result shape' });
const fenced = 'Here you go:\n```json\n{"code": "def run(input, call_tool):\\n    return 1\\n", "exits": ["next"], "explanation": "e"}\n```';
assert.deepStrictEqual(CA.parseAnswer(fenced), { kind: 'code', code: 'def run(input, call_tool):\n    return 1\n', exits: ['next'], explanation: 'e' });
assert.strictEqual(CA.parseAnswer('Sure! {"code": "x", "exits": ["a"]} done').kind, 'code');
assert.strictEqual(CA.parseAnswer('not json').kind, 'invalid');
assert.strictEqual(CA.parseAnswer('{"code": "x", "exits": "a"}').kind, 'invalid');
assert.strictEqual(CA.parseAnswer('{"code": "x", "exits": [1]}').kind, 'invalid');
assert.strictEqual(CA.parseAnswer('{"cannot": "  "}').kind, 'invalid');

// checks -- review focus 3
const good = { code: 'def run(input, call_tool):\n    r = call_tool("outlook", "poll_new_mail", {})\n    return {"route": "x", "output": r}\n', exits: ['x', 'error'] };
assert.deepStrictEqual(CA.checkAnswer(good, usable), []);
assert.ok(CA.checkAnswer({ ...good, exits: ['Bad-Exit'] }, usable).some((e) => e.includes('Bad-Exit')));
assert.ok(CA.checkAnswer({ ...good, code: 'x = 1' }, usable).some((e) => e.includes('run(input, call_tool)')));
assert.ok(CA.checkAnswer({ ...good, code: good.code.replace('poll_new_mail', 'tmp_debug') }, usable).some((e) => e.includes('tmp_debug')));
assert.ok(CA.checkAnswer({ ...good, code: good.code.replace('"outlook"', "'jira'") }, usable).some((e) => e.includes('jira')));

// fix round 1
assert.ok(!msg.includes('Style examples') && !msg.includes('poll_jobs'));
const withOut = CA.buildUserMessage({ usable: [{ name: 'S', slug: 's', tools: [{ name: 't', description: 'd', inputSchema: {}, outputSchema: { type: 'object', properties: { zz_field: {} } } }] }],
    exits: ['next'], wiring: {}, sample: '', code: '', request: 'r' });
assert.ok(withOut.includes('zz_field'));
assert.strictEqual(CA.parseAnswer('```JSON\n{"cannot": "c"}\n```').kind, 'cannot');
assert.strictEqual(CA.parseAnswer('```jsonc\n{"cannot": "c"}\n```').kind, 'cannot');
assert.strictEqual(CA.parseAnswer('```\n{"cannot": "c"}\n```').kind, 'cannot');
assert.strictEqual(CA.parseAnswer('```python\nx=1\n```\nthen\n```json\n{"cannot": "c"}\n```').kind, 'cannot');
assert.strictEqual(CA.parseAnswer('{"cannot": "why", "code": "x", "exits": ["a"]}').kind, 'cannot');
assert.ok(CA.checkAnswer({ ...good, exits: ['x'] }, usable).some((e) => e.includes('"error" exit')));
assert.deepStrictEqual(CA.checkAnswer({ code: 'def run(input, call_tool):\n    return input\n', exits: ['next'] }, []), []);

console.log('code-node-assist core: ok');
