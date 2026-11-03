const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../mcp-client.js', 'utf8') + '\n;this.MCPClient = MCPClient;';
const win = { APP_CONFIG: { API_BASE_URL: '/api' }, accountStore: { getActiveUser: () => ({ id: 1 }) } };
const ctx = { window: win, document: { addEventListener() {} }, console, setTimeout: () => 0, localStorage: { getItem: () => null }, fetch: null };
vm.createContext(ctx);
vm.runInContext(src, ctx);

(async () => {
    const answer = (status, body) => async () => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) });
    const make = (f) => { ctx.fetch = f; const c = new ctx.MCPClient(); c.getAuthToken = () => 't'; return c; };

    let calls = 0;
    let c = make(async () => { calls++; return answer(404, { error: 'not found' })(); });
    assert.strictEqual(JSON.stringify(await c.hostStatus()), '{"available":false}');
    await c.hostStatus();
    assert.strictEqual(calls, 1, '404 is cached');

    for (const st of [401, 500]) {
        calls = 0;
        c = make(async () => { calls++; return answer(st, { error: 'x' })(); });
        await assert.rejects(c.hostStatus(), (e) => e.status === st);
        await assert.rejects(c.hostStatus());
        assert.strictEqual(calls, 2, `${st} is not cached`);
    }
    c = make(async () => { throw new TypeError('network'); });
    await assert.rejects(c.hostStatus(), /network/);

    c = make(answer(200, { success: true, data: { available: true, gateway: 'g' } }));
    assert.strictEqual((await c.hostStatus()).gateway, 'g');
    console.log('hostStatus: ok');
})();
