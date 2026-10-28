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
const { usable, skipped, noSchema } = CA.splitDocumented(listed);
assert.deepStrictEqual(usable.map((s) => [s.slug, s.tools.map((t) => t.name)]), [['outlook', ['poll_new_mail']]]);
assert.deepStrictEqual(skipped, ['outlook.tmp_debug', 'outlook.nodesc']);
assert.deepStrictEqual(noSchema, ['outlook.poll_new_mail']);   // documented, no outputSchema
assert.deepStrictEqual(CA.splitDocumented([{ name: 'X', slug: 'x', tools: [
    { name: 'a', description: 'd', outputSchema: { type: 'object' } }, { name: 'b', description: 'd' }] }]).noSchema, ['x.b']);

// Tools tab: a schema as indented field lines
assert.strictEqual(CA.schemaType({ type: ['object', 'null'] }), 'object|null');
assert.strictEqual(CA.schemaType({ type: 'array', items: { type: 'string' } }), 'array of string');
assert.strictEqual(CA.schemaType({ enum: ['device'] }), '"device"');
assert.strictEqual(CA.schemaType({ anyOf: [{ type: 'object' }, { type: 'null' }] }), 'object|null');
assert.deepStrictEqual(CA.schemaLines({ type: 'object', required: ['mail'], properties: { mail: { type: ['object', 'null'], description: 'The email',
    properties: { subject: { type: 'string' }, attachments: { type: 'array', items: { type: 'object', properties: { size: { type: 'integer' } } } } } } } }), [
    { depth: 0, name: 'mail', type: 'object|null', required: true, description: 'The email' },
    { depth: 1, name: 'subject', type: 'string', required: false, description: '' },
    { depth: 1, name: 'attachments', type: 'array of object', required: false, description: '' },
    { depth: 2, name: 'size', type: 'integer', required: false, description: '' },
]);
assert.deepStrictEqual(CA.schemaLines(undefined), []);
assert.deepStrictEqual(CA.schemaLines({ type: 'object' }), []);

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
// ... and a request that needs anything beyond the input is refused, not guessed
assert.ok(/anything outside its input[^\n]*cannot/i.test(CA.buildUserMessage({ usable: [], exits: ['next'], wiring: {}, sample: '', code: '', request: 'x' })));
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

// exit merge -- review focus 4
let m = CA.mergeExits(['new_mail', 'no_mail', 'error'], ['next'], new Set(['next']));
assert.deepStrictEqual(m, { exits: ['new_mail', 'no_mail', 'error', 'next'], added: ['new_mail', 'no_mail', 'error'], kept: ['next'], errors: [] });
m = CA.mergeExits(['a', 'b'], ['next', 'b'], new Set());                 // unwired unused exit dropped
assert.deepStrictEqual([m.exits, m.added, m.kept], [['a', 'b'], ['a'], []]);
m = CA.mergeExits(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['x', 'y'], new Set(['x', 'y']));
assert.strictEqual(m.exits.length, 9);
assert.ok(m.errors.some((e) => e.includes('1 to 8')));

// line diff
assert.deepStrictEqual(CA.lineDiff('a\nb\nc', 'a\nx\nc'),
    [{ op: ' ', line: 'a' }, { op: '-', line: 'b' }, { op: '+', line: 'x' }, { op: ' ', line: 'c' }]);
assert.deepStrictEqual(CA.lineDiff('', 'a'), [{ op: '-', line: '' }, { op: '+', line: 'a' }]);
assert.deepStrictEqual(CA.lineDiff('a', 'a'), [{ op: ' ', line: 'a' }]);

// changing calls -- review focus 5
const sn = [{ name: 'ServiceNow', slug: 'servicenow', tools: [
    { name: 'create_ticket', annotations: { readOnlyHint: false } },
    { name: 'purge', annotations: { destructiveHint: true } },
    { name: 'list', annotations: { readOnlyHint: true } },
    { name: 'plain' },
] }];
const code = 'call_tool("servicenow", "create_ticket", {})\ncall_tool("servicenow", "create_ticket", {})\n'
    + 'call_tool("servicenow", "list")\ncall_tool("servicenow", "plain")\ncall_tool("servicenow", "purge")';
assert.deepStrictEqual(CA.changingCalls(code, sn),
    [{ server: 'ServiceNow', tool: 'create_ticket' }, { server: 'ServiceNow', tool: 'purge' }]);
assert.deepStrictEqual(CA.changingCalls('call_tool("servicenow", "plain")', sn), []);

// final fix wave -- the current code is not documentation; result handling is never dropped silently
assert.ok(CA.SYSTEM_PROMPT.includes('4. The current code is NOT documentation'));
assert.ok(CA.SYSTEM_PROMPT.includes('even if the current code already uses it'));
assert.ok(CA.SYSTEM_PROMPT.includes('6. Never remove or weaken the current code\'s handling of a tool result'));
assert.ok(CA.SYSTEM_PROMPT.includes('you\n   can neither keep it (rule 1) nor drop it: answer cannot'));
assert.ok(CA.SYSTEM_PROMPT.includes('call_tool raises only when the server marks the result as an error'));
assert.ok(CA.SYSTEM_PROMPT.includes('detect them as documented and route to error'));
assert.ok(!/outlook|servicenow|jira/i.test(CA.SYSTEM_PROMPT));                 // general for every server
assert.ok(msg.includes('## Current code (for names and style only; it is not documentation, see rules 4 and 6)'));

// Test confirmation: servers the code calls whose listing failed
const mixed = [{ name: 'Outlook', slug: 'outlook', tools: [], error: 'HTTP 502' },
    { name: 'Jira', slug: 'jira', tools: [{ name: 'get' }] }, { name: 'Idle', slug: 'idle', tools: [], error: 'down' }];
assert.deepStrictEqual(CA.unlistedCalls('call_tool("outlook", "a")\ncall_tool(\'outlook\', "b")\ncall_tool("jira", "get")', mixed), ['Outlook']);
assert.deepStrictEqual(CA.unlistedCalls('call_tool("jira", "get")', mixed), []);
assert.deepStrictEqual(CA.unlistedCalls('x = 1', mixed), []);

// the box: cannot keeps the listing lines; Accept refuses code edited since the proposal
(async () => {
    const stubs = {};
    const stub = (k) => stubs[k] || (stubs[k] = { value: k === 'model' ? '0' : '', innerHTML: '', textContent: '', handlers: [],
        addEventListener(ev, h) { if (ev === 'click') this.handlers.push(h); }, click() { return this.handlers[this.handlers.length - 1](); } });
    const el = { innerHTML: '', querySelector: (sel) => stub(/data-a="([^"]+)"/.exec(sel)[1]) };
    let code = 'def run(input, call_tool):\n    return input\n', applied = null, reply = '{"cannot": "no field"}';
    const deps = {
        t: (k, p) => k + (p ? JSON.stringify(p) : ''), tickedCount: () => 1,
        listServers: async () => [...listed],
        models: async () => [{ provider: 'p', model: 'm', label: 'p m' }],
        ask: async () => reply, checkPython: async () => null,
        getCode: () => code, getExits: () => ['next'], wiredExits: () => new Set(), wiring: () => ({}), getSample: () => '',
        apply: (a) => { applied = a; },
    };
    const box = CA.mountAssistBox(el, deps);
    stub('request').value = 'get the next email';
    await stub('ask').click();
    assert.ok(stubs.status.innerHTML.includes('workflow.codeAssist.listFailed'));
    assert.ok(stubs.status.innerHTML.includes('workflow.codeAssist.undocumented'));
    assert.ok(stubs.status.innerHTML.includes('workflow.codeAssist.cannot'));
    reply = JSON.stringify({ code: 'def run(input, call_tool):\n    return 1\n', exits: ['next'], explanation: 'e' });
    await stub('ask').click();
    assert.ok(stubs.proposal.innerHTML.includes('return 1'));
    code = 'def run(input, call_tool):\n    return 2\n';                        // edited after the proposal
    stub('accept').click();
    assert.strictEqual(applied, null);
    assert.ok(stubs.status.innerHTML.includes('workflow.codeAssist.codeChanged'));
    assert.ok(stubs.proposal.innerHTML.includes('return 2'));                  // diff now against the edited code
    stub('accept').click();
    assert.deepStrictEqual(applied, { code: 'def run(input, call_tool):\n    return 1\n', exits: ['next'] });
    assert.strictEqual(typeof box.refresh, 'function');
    console.log('code-node-assist core: ok');
})().catch((e) => { console.error(e); process.exit(1); });
