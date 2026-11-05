const assert = require('assert');
const Validator = require('../mcp-protocol-validator.js');
const T = require('../mcp-protocol-test.js');

const URL = 'https://x.test/srv';
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const relay = (messages, o = {}) => Object.assign({ url: URL, status: 200, headers: {}, body: '', messages, duration_ms: 5, error: null }, o);
const initOk = (caps, sid = 's1', id = 1) => relay([rpc(id, { protocolVersion: '2025-11-25', capabilities: caps, serverInfo: { name: 'S', version: '1' } })],
    { headers: sid ? { 'mcp-session-id': sid } : {} });
function fake(answers) {
    const calls = [];
    const send = async (message, ctx) => {
        calls.push({ message, ctx });
        const a = answers(message, ctx, calls.length);
        return a;
    };
    return { send, calls };
}
const byMethod = (caps, extra = {}) => (m, ctx, n) => {
    switch (m.method) {
        case 'initialize': return extra.init || initOk(caps);
        case 'notifications/initialized': return relay([], { status: 202 });
        case 'tools/list': return relay([rpc(m.id, { tools: [] })]);
        case 'resources/list': return relay([rpc(m.id, { resources: [] })]);
        case 'prompts/list': return relay([rpc(m.id, { prompts: [] })]);
    }
};
const run = (send, o = {}) => T.runTest(send, Object.assign({ Validator, transport: 'http', url: URL + '/' }, o));
const ids = r => r.steps.map(s => s.id);
const st = (r, id) => r.steps.find(s => s.id === id);

async function main() {
    { // happy path
        const f = fake(byMethod({ tools: {}, resources: {}, prompts: {} }));
        const r = await run(f.send);
        assert.deepStrictEqual(ids(r), ['initialize', 'initialized', 'tools', 'resources', 'prompts']);
        assert(r.steps.every(s => s.status === 'ok'), JSON.stringify(r.steps));
        assert.strictEqual(f.calls[0].message.params.protocolVersion, '2025-11-25');
        f.calls.slice(1).forEach(c => assert.strictEqual(c.ctx.sessionId, 's1'));
        assert.strictEqual(r.server.negotiated, '2025-11-25');
        assert.strictEqual(r.server.name, 'S');
        assert.strictEqual(r.urlWarning, null);
        assert.strictEqual(f.calls.filter(c => c.message.method === 'notifications/initialized')[0].message.id, undefined);
        // log
        assert.strictEqual(r.log.length, f.calls.length * 2);
        r.log.forEach((e, i) => assert.strictEqual(e.direction, i % 2 ? 'response' : 'request'));
        assert(r.validation.length >= 4);
    }
    { // html at stored url -> sibling
        const f = fake((m, ctx, n) => {
            if (m.method === 'initialize' && !ctx.sibling) return relay([], { headers: { 'content-type': 'text/html' }, body: '<html>' });
            if (m.method === 'initialize') return initOk({ tools: {} }, 's1', m.id);
            return byMethod({ tools: {} })(m, ctx, n);
        });
        const r = await run(f.send);
        assert.strictEqual(st(r, 'initialize').status, 'warn');
        assert.strictEqual(st(r, 'initialize-mcp').status, 'ok');
        assert.strictEqual(f.calls[1].ctx.sibling, true);
        assert.strictEqual(r.urlWarning, `The server answers at ${URL}/mcp; the registered URL is ${URL}.`);
        assert.strictEqual(st(r, 'tools').status, 'ok');
    }
    { // capabilities tools only
        const f = fake(byMethod({ tools: {} }));
        const r = await run(f.send);
        assert.strictEqual(st(r, 'resources').status, 'skipped');
        assert.strictEqual(st(r, 'resources').note, 'not offered');
        assert.strictEqual(st(r, 'prompts').status, 'skipped');
        assert(!f.calls.some(c => /^(resources|prompts)\/list$/.test(c.message.method)));
    }
    { // rpc error
        const f = fake(() => relay([{ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } }]));
        const r = await run(f.send);
        assert.strictEqual(st(r, 'initialize').status, 'error');
        ['initialized', 'tools', 'resources', 'prompts'].forEach(id => {
            assert.strictEqual(st(r, id).status, 'skipped'); assert.strictEqual(st(r, id).note, 'skipped (initialize failed)');
        });
        assert.strictEqual(r.server, null);
    }
    { // transport error, and bare {error}
        for (const ans of [relay([], { error: 'timeout', status: 0 }), { error: 'timeout' }]) {
            const f = fake(() => ans);
            const r = await run(f.send);
            assert.strictEqual(st(r, 'initialize').status, 'error');
            assert.strictEqual(f.calls.length, 1);
            assert.strictEqual(st(r, 'tools').status, 'skipped');
        }
    }
    { // no session id
        const f = fake(byMethod({ tools: {} }, { init: initOk({ tools: {} }, null) }));
        await run(f.send);
        f.calls.slice(1).forEach(c => assert.strictEqual(c.ctx.sessionId, null));
    }
    { // sse
        const f = fake(() => relay([], { body: '<html>' }));
        const r = await run(f.send, { transport: 'sse' });
        assert.strictEqual(f.calls.length, 1);
        assert.strictEqual(r.transportNote, 'Transport SSE: tested the way SynergyAI reaches it (Streamable HTTP at the server\'s /mcp endpoint).');
    }
    console.log('mcp-protocol-test: ok');
}
main().catch(e => { console.error(e); process.exit(1); });
