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
    { // normaliseUrl
        assert.strictEqual(T.normaliseUrl('HTTPS://Api.X.test:443/mcp/'), T.normaliseUrl('https://api.x.test/mcp'));
        assert.strictEqual(T.normaliseUrl('http://a.test:80/x#frag'), 'http://a.test/x');
        assert.notStrictEqual(T.normaliseUrl('http://a.test:8080/x'), T.normaliseUrl('http://a.test/x'));
    }
    { // registryStatus
        const store = {};
        global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
        const meta = status => ({ 'io.modelcontextprotocol.registry/official': { status } });
        const answer = (u, status) => ({ servers: [{ server: { name: 'io.x/srv', version: '2.1', remotes: [{ type: 'streamable-http', url: u }] }, _meta: meta(status) }] });
        let n = 0;
        const fetchOk = a => async () => { n++; return a; };
        let r = await T.registryStatus('io.x/srv', 'https://Api.x.test:443/mcp/', fetchOk(answer('https://api.x.test/mcp', 'active')));
        assert.strictEqual(r.state, 'registered'); assert.strictEqual(r.name, 'io.x/srv'); assert.strictEqual(r.version, '2.1');
        assert(r.link.startsWith('https://registry.modelcontextprotocol.io/v0/servers?search='));
        n = 0;
        await T.registryStatus('io.x/srv', 'https://api.x.test/mcp', fetchOk({}));
        assert.strictEqual(n, 0, 'cached within 24h');
        r = await T.registryStatus('io.x/srv', 'https://api.x.test/mcp', fetchOk({}), Date.now() + 25 * 3600e3);
        assert.strictEqual(n, 1);
        r = await T.registryStatus('io.x/srv', 'https://other.test/mcp', fetchOk(answer('https://api.x.test/mcp', 'active')));
        assert.strictEqual(r.state, 'not-registered');
        r = await T.registryStatus('io.x/srv', 'https://dep.test/mcp', fetchOk(answer('https://dep.test/mcp', 'deprecated')));
        assert.strictEqual(r.state, 'deprecated');
        r = await T.registryStatus('io.x/srv', 'https://down.test/mcp', async () => { throw new Error('boom'); });
        assert.strictEqual(r.state, 'unreachable');
        n = 0;
        r = await T.registryStatus('', 'https://z.test/mcp', fetchOk({}));
        assert.strictEqual(r.state, 'not-registered'); assert.strictEqual(n, 0);
        delete global.localStorage;
        r = await T.registryStatus('io.x/srv', 'https://nols.test/mcp', fetchOk(answer('https://nols.test/mcp', 'active')));
        assert.strictEqual(r.state, 'registered');
    }
    { // reportText
        const f = fake(byMethod({ tools: {} }, { init: relay([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: [], serverInfo: { name: 'S', version: '1' } } }]) }));
        const rep = await run(f.send);
        rep.validation.push({ context: 'initialize', valid: false, errors: ['capabilities.tools must be an object'], warnings: ['missing title'] });
        rep.log.push({ at: 'now', step: 'x', direction: 'request', body: { headers: { Authorization: 'Bearer SECRET-TOKEN-123' } } });
        const text = T.reportText(rep, T.DEFAULT_LABELS);
        assert(!text.includes('SECRET-TOKEN-123'));
        const errs = rep.validation.flatMap(v => v.errors);
        assert(errs.length > 0); assert(text.includes('missing title'));
        errs.forEach(e => assert(text.includes(e), e));
        assert(text.includes('initialize'));
    }
    { // labels
        const keys = Object.keys(T.DEFAULT_LABELS);
        assert(keys.length > 10);
        keys.forEach(k => assert(typeof T.DEFAULT_LABELS[k] === 'string' && T.DEFAULT_LABELS[k].trim(), k));
    }
    console.log('mcp-protocol-test: ok');
}
main().catch(e => { console.error(e); process.exit(1); });
