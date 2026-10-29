// Robot UI: the robot's connections, the organization Connect.
const assert = require('assert');
const PC = require('../playbook-collection.js');
const CN = require('../code-node.js');

(async () => {
    // organization button only when the schema offers it
    const tools = (methods) => [
        { name: 'connect_start', inputSchema: { type: 'object', properties: { method: methods ? { type: 'string', enum: methods } : { type: 'string' } } } },
        { name: 'connect_status' }, { name: 'whoami' },
    ];
    assert.ok(CN.offersOrganization(tools(['device', 'organization'])));
    assert.ok(!CN.offersOrganization(tools(['device'])));
    assert.ok(!CN.offersOrganization(tools(null)));
    assert.ok(!CN.offersOrganization([{ name: 'whoami' }]));
    assert.ok(!CN.offersOrganization(null));
    // ... and only in the robot's connections: never in a person's own Connect box.
    assert.ok(CN.showsOrganizationButton(tools(['device', 'organization']), true));
    assert.ok(!CN.showsOrganizationButton(tools(['device', 'organization']), false));
    assert.ok(!CN.showsOrganizationButton(tools(['device']), true));

    // connect with io uses the injected call and saveKey
    const calls = [];
    const saved = [];
    const io = {
        call: async (server, tool, args) => {
            calls.push([server.id, tool, args]);
            if (tool === 'connect_start') return { connect_id: 'c1', status: 'connected' };
            return { status: 'connected', account: 'org (3 mailboxes)', connection_key: 'K', credential_header: 'X-Conn' };
        },
        saveKey: async (server, header, key) => { saved.push([server.id, header, key]); return { success: true }; },
    };
    const res = await CN.connectOrganization(io, { id: 9, name: 'Outlook' });
    assert.deepStrictEqual(res, { ok: true, account: 'org (3 mailboxes)' });
    assert.deepStrictEqual(calls, [[9, 'connect_start', { method: 'organization' }], [9, 'connect_status', { connect_id: 'c1' }]]);
    assert.deepStrictEqual(saved, [[9, 'X-Conn', 'K']]);
    // A refused start, a missing key or a failed save: an error, nothing saved.
    saved.length = 0;
    assert.strictEqual((await CN.connectOrganization({ ...io, call: async () => ({ error: 'not_configured', message: 'no' }) }, { id: 9 })).error, 'not_configured');
    const noKey = { ...io, call: async (s, tool) => (tool === 'connect_start' ? { connect_id: 'c' } : { status: 'connected' }) };
    assert.ok((await CN.connectOrganization(noKey, { id: 9 })).error);
    assert.deepStrictEqual(saved, []);
    assert.strictEqual((await CN.connectOrganization({ ...io, saveKey: async () => ({ success: false, error: 'boom' }) }, { id: 9 })).message, 'boom');

    // A JSON-RPC answer read as the tool's JSON (shared by the user's proxy and the robot's call route).
    assert.deepStrictEqual(CN.toolJson({ result: { content: [{ type: 'text', text: '{"account":"a"}' }] } }), { account: 'a' });
    assert.deepStrictEqual(CN.toolJson({ result: { structuredContent: { status: 'pending' } } }), { status: 'pending' });
    assert.deepStrictEqual(CN.toolJson({ result: { isError: true, content: [{ text: '{"error":"not_connected","message":"m"}' }] } }), { error: 'not_connected', message: 'm' });
    assert.strictEqual(CN.toolJson(null, 'Outlook').error, 'network_error');
    assert.strictEqual(CN.toolJson({ error: { message: 'x' } }).message, 'x');

    const sent = [];
    let answer = { status: 200, body: { success: true, data: [] } };
    global.fetch = async (url, opts) => {
        sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
        return { status: answer.status, json: async () => answer.body };
    };
    const api = new PC.PlaybookApi('/api/v1', () => ({}));

    // The rest of the client: one method per robot route.
    await api.robotServers();
    await api.saveRobotServer({ name: 'Outlook', url: 'https://o/mcp', description: '' });
    await api.saveRobotServer({ id: 4, url: 'https://o2/mcp', enabled: false });
    await api.deleteRobotServer(4);
    await api.callRobotServer(4, 'whoami', {});
    await api.saveRobotKey(4, 'X-Conn', 'K');
    assert.deepStrictEqual(sent.map((s) => `${s.method} ${s.url}`), [
        'GET /api/v1/robot/mcp-servers',
        'POST /api/v1/robot/mcp-servers', 'POST /api/v1/robot/mcp-servers/4', 'DELETE /api/v1/robot/mcp-servers/4',
        'POST /api/v1/robot/mcp-servers/4/call', 'POST /api/v1/robot/mcp-servers/4/key',
    ]);
    assert.deepStrictEqual(sent[1].body, { name: 'Outlook', url: 'https://o/mcp', description: '' });
    assert.deepStrictEqual(sent[2].body, { url: 'https://o2/mcp', enabled: false });
    assert.deepStrictEqual(sent[4].body, { tool: 'whoami', arguments: {} });
    assert.deepStrictEqual(sent[5].body, { header: 'X-Conn', key: 'K' });

    console.log('robot-workflows: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
