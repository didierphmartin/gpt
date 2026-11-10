const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../mcp-host-install.js', 'utf8');

const make = (mcpClient) => {
    const ctx = { window: { mcpClient }, console, setTimeout: (f) => { f(); return 0; } };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return ctx.window.McpHostInstall;
};

(async () => {
    const H = make({});
    assert.strictEqual(H.registrationUrl('http://gw', 'srv', { runtime: 'php', entry: 'mcp.php' }), 'http://gw/srv/mcp.php');
    assert.strictEqual(H.registrationUrl('http://gw', 'srv', { runtime: 'python', entry: 'main.py' }), 'http://gw/srv/mcp');
    assert.strictEqual(H.registrationUrl('http://gw//', 'srv', { runtime: 'php', entry: 'mcp.php' }), 'http://gw/srv/mcp.php');

    assert.strictEqual(H.registrationUrl('http://gw', 'srv', { runtime: 'php', entry: 'sub dir/mcp.php' }), 'http://gw/srv/sub%20dir/mcp.php');
    assert.strictEqual(H.registrationUrl('http://gw', 'srv', { runtime: 'php' }), 'http://gw/srv/mcp');
    assert.strictEqual(H.registrationUrl('http://gw', 'srv', { runtime: 'php', entry: '' }), 'http://gw/srv/mcp');

    const fake = (state, log, installErr) => {
        const calls = { add: [], install: [] };
        return {
            calls,
            hostInstall: async (f, b) => { calls.install.push([f, b]); if (installErr) throw installErr; return { state: 'installing' }; },
            hostServers: async () => [{ folder: 'srv', state, log }],
            addServer: async (...a) => { calls.add.push(a); return { success: true }; },
        };
    };
    const args = { folder: 'srv', manifest: { name: 'Srv', description: 'd', runtime: 'php', entry: 'mcp.php' },
        filesB64: { 'mcp.php': 'AA==' }, env: { K: 'v' }, source: { repo: 'x' }, gateway: 'http://gw/' };

    let mc = fake('running');
    let r = await make(mc).installAndRegister(args);
    assert.strictEqual(r.state, 'running');
    assert.strictEqual(mc.calls.add.length, 1);
    assert.deepStrictEqual(mc.calls.add[0].slice(0, 3), ['Srv', 'http://gw/srv/mcp.php', 'd']);
    assert.strictEqual(mc.calls.add[0][4], 'http');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(mc.calls.install[0][1])),
        { name: 'Srv', files: { 'mcp.php': 'AA==' }, env: { K: 'v' }, source: { repo: 'x' } });

    mc = fake('crashed', ['boom']);
    r = await make(mc).installAndRegister(args);
    assert.strictEqual(r.state, 'crashed');
    assert.deepStrictEqual(Array.from(r.log), ['boom']);
    assert.strictEqual(mc.calls.add.length, 0);

    const err = Object.assign(new Error('conflict'), { status: 409 });
    mc = fake('running', [], err);
    await assert.rejects(make(mc).installAndRegister(args), /conflict/);
    assert.strictEqual(mc.calls.add.length, 0);

    for (const reply of [{ success: false, error: 'A server with this name already exists' }, undefined]) {
        mc = fake('running');
        mc.addServer = async () => reply;
        r = await make(mc).installAndRegister(args);
        assert.strictEqual(r.state, 'register-failed');
        assert.strictEqual(r.error, reply ? reply.error : undefined);
        assert.strictEqual(r.server, undefined);
    }
    console.log('mcp-host-install: ok');
})().catch((e) => { console.error(e); process.exit(1); });
